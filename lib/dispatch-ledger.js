// 派工即回写（C 线第 17 项）：**派工成功后由代码把任务置为 `in_progress` + `owner`**，
// 而不是靠模型记得改。
//
// 为什么需要：对照 Qoder —— 它派工成功后由**服务端**自动置 `in_progress` + `owner`；
// 我们这边 `SKILL.md §7.10` 要求 lead「每次派工和每次结算都必须立即回写 TASKS.json」，
// 但那是**散文规则 + 模型自觉**。实测代价：`/team check` 与浮层红条把「依赖已就绪却仍
// pending」判为「状态冻结」违规 —— 也就是说，**规则没被执行的后果由用户看见**（红条），
// 而执行它的动作全靠模型记得。本模块把"派工 → in_progress + owner"这一半交给代码。
//
// 落点选择（很重要）：**挂在宿主 `tools/post-execute` 上，不是在读接口里顺手写**。
// 理由：本仓刚把 `GET /state` 的写副作用摘掉（B 线 10a）—— 读接口每 3 秒轮询，
// 在里面写盘 = 周期性改写用户工件 + 与 lead 的写并发。**派工是一次真实事件，就该由事件驱动。**
//
// 安全边界（宁可少记，不可错记；错了比不记更贵）：
//   ① **只认 `subagent*` 工具的调用**，且**只解析 `label`**（不解析 prompt —— 提示词里
//      「依赖 T01 已完成」这类提及会把别人正在做的任务也标成 in_progress）。
//   ② 标签里的任务 id 必须**逐字命中 TASKS.json 里已存在的 id**（按词边界，`T2` 不命中 `T24`）。
//   ③ **只翻 `pending → in_progress`**：终态（completed/failed/cancelled…）一律不动；
//      已 `in_progress` 且是**别人**在做 ⇒ 不覆盖，只记一条冲突事件（归属不许被代码改掉）。
//   ④ `owner` 只在任务**没有 owner** 时写入；已有 owner 与本次派工角色不一致时保留原 owner。
//   ⑤ 派工**失败**（工具结果 isError）⇒ 不记账（没派出去就不该显示"在做"）。
//   ⑥ 任何异常都**吞掉并放行**：本监听器绝不允许成为工具调用的故障源（与 B2-1 同一条纪律）。

/** 派工类工具名（角色工具 `subagent_backend` / 通用 `subagent`）。 */
export const DISPATCH_TOOL_RE = /^subagent(\b|_|$)/;

/** `workflow` 扇出工具名（**one-shot 模式的默认派工路径**，SKILL §5）。 */
export const WORKFLOW_TOOL = 'workflow';

/** 是否是派工工具调用（角色工具 / 通用 subagent）。 */
export function isDispatchTool(name) {
  return DISPATCH_TOOL_RE.test(String(name || ''));
}

/** 是否是 `workflow` 扇出（一次调用派多腿，每腿的 `label` 自带任务 id）。 */
export function isWorkflowTool(name) {
  return String(name || '') === WORKFLOW_TOOL;
}

/**
 * 从 `workflow` **脚本正文**里抽出所有 leg 的 `label`。
 *
 * 为什么是这里：one-shot 模式（`/team` 的**默认**模式）不调 `subagent_*`，而是把整支团队写成
 * 一段脚本一次扇出 —— 只看 `subagent*` 的话，这个功能在默认路径上**一次都不会生效**
 *（2026-09-13 真实 run 实测：29 个任务、`mode=one-shot`、带自动认领记号的 **0** 个）。
 *
 * ⚠️ 只认 `label`，**不认 prompt**（与 subagent 那条同一纪律：提示词里"依赖 T01 已完成"这类提及
 * 会把别人正在做的任务也标成在做）。SKILL §7.22 ④ 本来就要求 leg 的 `label` 用
 * `【<中文角色>】<中文任务>` 且带任务 id —— 这条从"建议"变成了**代码依赖**。
 *
 * @param script - `workflow` 的 `script` 参数（JS 源码文本）。
 * @returns label 字符串数组（按出现顺序）。
 */
export function labelsInWorkflowScript(script) {
  const out = [];
  // 先剥注释：脚本里写 `// label: '示例'` 或块注释里的示例不该被当成真派工。
  // （顺序上先块注释后行注释；`//` 出现在字符串里的情况极少，且剥错了只会**少记**不会错记。）
  const text = String(script || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const re = /label\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[2]);
  return out;
}

/** 正则元字符转义（任务 id 来自文件，不假设它一定干净）。 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从**派工标签**里找出本 run 真实存在的任务 id（按词边界，避免 `T2` 命中 `T24`）。
 *
 * 只认"已存在的 id"这一条，让本函数天然保守：编造/写错的 id 一律不产生副作用。
 *
 * @param label - 派工标签（形如 `【后端工程师】实现 B4/B1`）。
 * @param knownIds - 该 run `TASKS.json` 里全部任务 id。
 * @returns 命中的 id 数组（按已知 id 的顺序，去重）。
 */
export function taskIdsInLabel(label, knownIds) {
  const text = String(label || '');
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(knownIds) ? knownIds : []) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    if (new RegExp(`(^|[^\\w-])${escapeRegExp(id)}($|[^\\w-])`).test(text)) { out.push(id); seen.add(id); }
  }
  return out;
}

/** 终态：任何自动记账都不许碰这些状态。 */
const TERMINAL = new Set(['completed', 'done', 'failed', 'cancelled']);

/**
 * 算出「这次派工该把哪些任务置为 in_progress」——**纯函数**，不改入参。
 *
 * @param args.tasks - `TASKS.json` 的 `tasks` 数组。
 * @param args.ids - 本次派工标签里命中的 id（来自 `taskIdsInLabel`）。
 * @param args.role - 本次派工的角色 id（空串表示认不出 ⇒ 不写 owner）。
 * @param args.now - 时间戳（ISO 串）。
 * @returns `{ next, claimed, conflicts, skipped }`
 *   - `claimed`：真正被翻成 `in_progress` 的 `{id, owner}`；
 *   - `conflicts`：**别人正在做**、因此**没有**被覆盖的 `{id, owner}`（调用方应留痕）；
 *   - `skipped`：命中了但状态是终态（不动的）id。
 */
export function planAutoClaim({ tasks, ids, role = '', now = '' }) {
  const arr = Array.isArray(tasks) ? tasks : [];
  const claimed = [];
  const conflicts = [];
  const skipped = [];
  const next = arr.map((t) => ({ ...(t && typeof t === 'object' ? t : {}) }));
  for (const id of Array.isArray(ids) ? ids : []) {
    const sid = String(id || '');
    const i = next.findIndex((t) => String(t.id || '') === sid);
    if (i < 0) continue;
    const t = next[i];
    const status = String(t.status || '');
    if (TERMINAL.has(status)) { skipped.push(sid); continue; }
    if (status === 'in_progress' || status === 'claimed') {
      // 已经有人在做了。**同一个角色再派一次不算冲突**（可能是补一轮），换角色才算。
      const owner = String(t.owner || '');
      if (owner && role && owner !== role) conflicts.push({ id: sid, owner });
      continue;
    }
    // pending（或空状态）⇒ 认领。owner 只在缺失时写入，绝不改掉已有归属。
    const ownerBefore = String(t.owner || '');
    t.status = 'in_progress';
    if (!ownerBefore && role) t.owner = role;
    if (now) t.claimedAt = now;
    claimed.push({ id: sid, owner: String(t.owner || '') });
  }
  return { next, claimed, conflicts, skipped };
}

/**
 * 创建一个 `tools/post-execute` 监听器：派工成功后自动把任务置为 `in_progress` + `owner`。
 *
 * @param deps - 注入依赖（IO 全部由调用方给，便于单测）：
 *   `roleOfLabel(label) => string`（中文标签 → 角色 id，复用 host 的 `ROLE_LABELS_ZH`，不另造一份）、
 *   `runFor(exec) => Promise<{cwd, runId}|null>`（**定位不到就返回 null，绝不猜**）、
 *   `readTasks({cwd, runId}) => Promise<doc|null>`、
 *   `writeTasks({cwd, runId}, doc) => Promise<void>`（走受控写入口 `ARTIFACT.must`）、
 *   `now() => string`、`onEvent(type, payload)`。
 * @returns `(exec, result, next) => Promise<PostToolDecision>`
 */
export function createDispatchLedger(deps) {
  const {
    roleOfLabel = () => '',
    runFor = async () => null,
    readTasks = async () => null,
    writeTasks = async () => {},
    now = () => new Date().toISOString(),
    onEvent = () => {},
  } = deps || {};

  return async function dispatchLedger(exec, result, next) {
    // 宿主签名是 `(exec, result, next)`；next 不是函数时降级为"不干涉"而不是抛错。
    if (typeof next !== 'function') return { kind: 'accept' };
    const downstream = await next();
    try {
      const name = String((exec && exec.name) || '');
      const isSub = isDispatchTool(name);
      const isWf = isWorkflowTool(name);
      if (!isSub && !isWf) return downstream;
      if (result && (result.isError === true || result.error)) {
        onEvent('dispatch-ledger-skipped', { reason: 'dispatch-failed', tool: name });
        return downstream;
      }
      // 两种派工形态，同一套下游：
      //   · `subagent_*`：一次一腿，标签在 `arguments.label`；
      //   · `workflow`：一次多腿，标签在**脚本正文**里（每腿一条 `label:`）。
      const labels = isWf
        ? labelsInWorkflowScript(exec && exec.arguments && exec.arguments.script)
        : [String((exec && exec.arguments && exec.arguments.label) || '')];
      const usable = labels.filter((l) => String(l || '').trim());
      if (!usable.length) {
        onEvent('dispatch-ledger-skipped', { reason: isWf ? 'no-label-in-script' : 'no-label', tool: name });
        return downstream;
      }
      const target = await runFor(exec);
      if (!target || !target.cwd || !target.runId) {
        onEvent('dispatch-ledger-skipped', { reason: 'no-run', tool: name, labels: usable.length });
        return downstream;
      }
      const doc = await readTasks(target);
      const tasks = doc && Array.isArray(doc.tasks) ? doc.tasks : null;
      if (!tasks) {
        onEvent('dispatch-ledger-skipped', { reason: 'no-tasks', runId: target.runId });
        return downstream;
      }
      // 多腿时**逐腿**取 id 与角色，并按角色分组各自认领 —— 一个 workflow 里
      // 腿 1 可能是 `【研究员】… T03`、腿 2 是 `【后端工程师】… T24/B1`，
      // 用"第一个角色"给整批定 owner 会把 T24 记成研究员（归属错记比不记更贵）。
      const known = tasks.map((t) => t && t.id);
      const byRole = new Map(); // role -> ids[]
      for (const l of usable) {
        const gids = taskIdsInLabel(l, known);
        if (!gids.length) continue;
        const r = String(roleOfLabel(l) || '');
        if (!byRole.has(r)) byRole.set(r, []);
        for (const id of gids) if (!byRole.get(r).includes(id)) byRole.get(r).push(id);
      }
      if (!byRole.size) {
        onEvent('dispatch-ledger-skipped', { reason: 'no-task-id-in-labels', runId: target.runId, labels: usable.length });
        return downstream;
      }
      let cur = tasks;
      const claimed = [];
      const conflicts = [];
      for (const [r, gids] of byRole) {
        const p = planAutoClaim({ tasks: cur, ids: gids, role: r, now: now() });
        cur = p.next;
        claimed.push(...p.claimed.map((c) => ({ ...c, role: r })));
        conflicts.push(...p.conflicts);
      }
      for (const c of conflicts) onEvent('dispatch-ledger-conflict', { runId: target.runId, ...c });
      if (!claimed.length) return downstream; // 无事发生 ⇒ **不写盘**（避免无谓改写与并发）
      doc.tasks = cur;
      await writeTasks(target, doc);
      onEvent('dispatch-ledger-claimed', { runId: target.runId, tool: name, claimed, conflicts: conflicts.length, labels: usable.length });
    } catch (e) {
      // 记账失败**绝不能**影响工具调用本身（B2-1 的同一条纪律：监听器不许成为故障源）。
      onEvent('dispatch-ledger-error', { error: String((e && e.message) || e).slice(0, 160) });
    }
    return downstream;
  };
}
