// 边界拦截器（B2-1 · O-C 形态）：把「台账契约」与「规格边界」两条**散文规则**搬到
// 宿主的 `tools/post-execute` 瀑布上，让违规**当场顶回**（模型可见反馈），而不是等
// `/team check` 事后报红、或等用户走查才发现。
//
// 为什么是"落地后纠偏"而不是"写前拒绝"（设计见 docs/Qoder对标/07-B2-1真拦截设计稿.md §二）：
//   本插件**不注册任何模型可调用的工具**；协议已单源化为 **R1（角色写自己的 run 工件）**，
//   且 lead 的工具面本就**没有** `write`（`lib/lead-toolface.js` @ 34 行把 `write` 列入
//   `LEAD_DENY_CANDIDATES`）⇒ 本拦截器对角色写 run 工件是**放行**的：`runScopedTarget`
//   只判 `TASKS.json`/`SPEC.md`，其余工件 `kind:'other'` 不拦（见本文件 @ 59-73 与 @ 191 行）。
//   因此这里只做"落地后 block + 反馈"：写仍然发生（不破坏任何现存写法），
//   但工具结果变成 isError，且逐条告诉模型哪条不合法。
//
// 与既有仲裁的关系（`lib/command.js:68` 的 L1-4′：「schema 告警**只上报、不阻断**」）：
//   本模块**不推翻**该仲裁 —— schema 形状告警仍然只上报。这里只拦**两个永不合法**的
//   DAG 不变量（id 重复、循环依赖，含自依赖），它们在任何"边写边补"的中间态下都不成立；
//   `missing-dependency` 可能是"我下一条 edit 就补上"的合法中间态，故**不拦**，降为告警。
//
// 本模块零 `command.js` 依赖：校验器（`validateTaskGraph`）由调用方注入，
// 既避免循环 import，也让它可以被单测直接实例化（也顺手为 B2-2 的模块拆分留好边界）。

import { resolve, sep } from 'node:path';

/** 会产生文件内容变更的工具名（`@deepseek-ai/dsh-tool-fs` 的 write / edit，参数名都是 `file_path`）。 */
export const WRITE_TOOLS = new Set(['write', 'edit']);

/** 边界章节标题（与 `skills/expert-team/assets/templates/SPEC.md` 的标题逐字一致）。 */
export const SPEC_BOUNDARY_HEADING = '边界与禁止项';

/** SPEC 必须已经写完边界的阶段 —— 即 spec-review 及其之后。clarify/research/design 期间只告警。 */
export const SPEC_COMPLETE_PHASES = new Set(['spec-review', 'implement', 'review', 'test', 'deliver', '方案确认']);

/**
 * **已终止的 run 状态** —— 处于这些状态的 run，本拦截器一律放行。
 *
 * 理由是"拦了只有坏处"：写已经落盘（`post-execute` 的 `block` 不回滚），改的又是冻结的历史工件，
 * 于是拦截唯一的效果是**让编辑者以为没改成**。已终止 run 的工件正确性由 `/team check` 按需报告。
 */
export const TERMINAL_RUN_STATUSES = new Set(['complete', 'completed', 'done', 'failed', 'cancelled', 'canceled', 'discarded']);

/**
 * 取本次工具调用的目标文件路径（只认 write/edit 的 `file_path`）。
 * @param exec - 工具执行记录（`{ name, arguments }`）。
 * @returns 去掉首尾空白的路径字符串；不是文件写入类调用则返回 null。
 */
export function targetOf(exec) {
  if (!exec || typeof exec !== 'object') return null;
  if (!WRITE_TOOLS.has(String(exec.name || ''))) return null;
  const args = exec.arguments;
  const p = args && typeof args === 'object' ? args.file_path : null;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

/**
 * 判断目标是否正好落在 `<teamRoot>/<runId>/` 的**直接子文件**上。
 * 只认正好 2 段（runId + 文件名）—— 更深的路径（如 run 目录里的子目录）一律不管，
 * 避免误伤 run 内其它同名工件。
 * @param absPath - 已解析的绝对路径。
 * @param teamRootAbs - `<cwd>/team` 的绝对路径。
 * @returns `{ runId, kind: 'tasks'|'spec', abs }`；不匹配返回 null。
 */
export function runScopedTarget(absPath, teamRootAbs) {
  if (typeof absPath !== 'string' || typeof teamRootAbs !== 'string') return null;
  const abs = resolve(absPath);
  const root = resolve(teamRootAbs);
  if (!abs.startsWith(root + sep)) return null;
  const parts = abs.slice(root.length + sep.length).split(sep).filter(Boolean);
  if (parts.length !== 2) return null;
  const [runId, base] = parts;
  if (base === 'TASKS.json') return { runId, kind: 'tasks', abs };
  if (base === 'SPEC.md') return { runId, kind: 'spec', abs };
  // 其余 run 内文件：**看得见，但不拦**（`violationsFor` 对非 tasks/spec 一律返回空）。
  // 为什么现在要「看见」它们（2026-09-13，设计稿 §十二 第 3 步）：并发写留痕需要观察**所有** run 工件 ——
  // 而实测那次并发事故发生在 `CONTRACT.md` 上（T29「CONTRACT 单写者收口」），恰恰不是这两份受门禁保护的文件。
  // ⚠️ 这是**只读扩展**：对 tasks/spec 的判定与拦截行为**逐字未变**。
  return { runId, kind: 'other', abs };
}

/**
 * 读 SPEC 的「边界与禁止项」章节状态。
 *
 * **"填了没有"的判据是列内容、不是行非空**：模板（`assets/templates/SPEC.md:36-47`）已经
 * 预置 10 行边界族表格，`期望拒绝` 与 `验收方式` 两列**故意留空**。所以"章节非空"这种判据
 * 会被模板本身满足 —— 必须要求**至少一行**的 `期望拒绝` 列非空，才算真的定义了边界。
 * @param text - SPEC.md 全文。
 * @returns `{ heading, filled, totalRows, filledRows }`
 */
export function specBoundaryState(text) {
  const lines = String(text ?? '').split('\n');
  // **"提及"不等于"定义"**：章节标题必须**以**「边界与禁止项」开头，后面只允许紧跟括号/冒号/结束。
  // 反例（2026-09-12 实测）：`# SPEC（探针：故意不写「边界与禁止项」章节）` 这种**标题里提到**它的
  // 写法，用 `includes()` 会被判成"有章节"——于是"缺失"永远不会被发现。这与本包证据门禁那条
  // 「片段命中 ≠ 锚点命中」是同一类错误：判定必须锚在**结构位置**上，不能锚在"出现过"。
  const HEAD_RE = /^(#{1,6})\s+(.+?)\s*$/;
  const sectionIndexOf = (raw) => {
    const m = raw.match(HEAD_RE);
    if (!m) return -1;
    const title = m[2].trim();
    if (!title.startsWith(SPEC_BOUNDARY_HEADING)) return -1;
    const rest = title.slice(SPEC_BOUNDARY_HEADING.length);
    return rest === '' || /^[（(：:]/.test(rest) ? m[1].length : -1;
  };
  let hIdx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lv = sectionIndexOf(lines[i]);
    if (lv > 0) { hIdx = i; level = lv; break; }
  }
  if (hIdx < 0) return { heading: false, filled: false, totalRows: 0, filledRows: 0 };
  let end = lines.length;
  for (let i = hIdx + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  let totalRows = 0;
  let filledRows = 0;
  for (const raw of lines.slice(hIdx + 1, end)) {
    const row = raw.trim();
    if (!row.startsWith('|')) continue;
    const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    // 跳过表头与分隔行：分隔行只由 - / : / 空格组成
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    if (cells[0] === '边界族' || cells[0] === '规则') continue;
    if (cells.length < 3) continue;
    totalRows += 1;
    if (cells[2]) filledRows += 1;
  }
  return { heading: true, filled: filledRows > 0, totalRows, filledRows };
}

/** 永不合法、任何中间态都不成立的 DAG 不变量（见文件头注释的取舍说明）。 */
export const HARD_GRAPH_CODES = new Set(['missing-id', 'duplicate-id', 'self-dependency', 'cycle']);

/**
 * 从 TASKS.json 文本里取任务数组（`{tasks:[…]}` 或裸数组都接受）。
 * @returns 数组；形状不对返回 null。
 */
export function tasksArrayOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object' && Array.isArray(doc.tasks)) return doc.tasks;
  return null;
}

/**
 * 创建一个 `tools/post-execute` 监听器。
 *
 * 决策合并遵循宿主的"最严格优先"：先 `await next()` 让下游有机会阻断，再把自己的
 * 阻断折上去（下游已 block 则保留其 feedback 并追加我们的），保证监听器顺序不影响最终结论。
 *
 * @param deps - 注入依赖：
 *   `readText(abs) => Promise<string|null>`（读落盘后内容；读不到返回 null ⇒ **降级放行**）、
 *   `validateTaskGraph(tasks) => { ok, errors:[{code,detail}] }`（复用读侧同一份实现）、
 *   `teamRootFor(exec) => string|null`、`phaseFor(runId) => Promise<string>`、
 *   `onEvent(type, payload)`（可观测：让"门禁被行使"看得见）。
 * @returns `(exec, next) => Promise<PostToolDecision>`
 */
export function createBoundaryInterceptor(deps) {
  const {
    readText,
    validateTaskGraph,
    cwdFor,
    teamRootFor = (cwd) => (cwd ? resolve(cwd, 'team') : null),
    phaseFor = async () => '',
    // 已交付/已终止的 run 要放行（理由见监听器里的长注释）。缺省返回空串 ⇒ **语义与从前完全一致**。
    statusFor = async () => '',
    // 并发写留痕（设计稿 §十二 第 3 步）：`whoFor` 给出写者身份、`writeTracer` 判「同窗口内不同写者写同一文件」。
    // 两个都缺省 ⇒ **语义与从前完全一致**（不传就不追踪）。
    whoFor = async () => '',
    writeTracer = null,
    onEvent = () => {},
  } = deps || {};

  /** 收集本次写入违反的硬规则（空数组 = 合规）。 */
  async function violationsFor(target, cwd) {
    const text = await readText(target.abs);
    if (typeof text !== 'string') {
      // 读不回来（宿主虚拟路径 / 权限）⇒ 不阻断，但要留痕：门禁自身降级必须可见，
      // 否则"没报错"会被误读成"检查过了"。这是 E 类假绿的典型形态。
      onEvent('boundary-gate-degraded', { runId: target.runId, kind: target.kind, abs: target.abs });
      return [];
    }
    if (target.kind === 'tasks') {
      let doc;
      try { doc = JSON.parse(text); } catch (e) {
        return [`TASKS.json 不是合法 JSON：${String((e && e.message) || e).slice(0, 120)}`];
      }
      const arr = tasksArrayOf(doc);
      if (arr === null) return ['TASKS.json 结构必须是 {"tasks":[…]} 或裸数组'];
      const g = validateTaskGraph(arr) || { errors: [] };
      return (g.errors || []).filter((e) => HARD_GRAPH_CODES.has(String(e && e.code))).map((e) => String(e.detail || e.code));
    }
    // 只有 spec 才走下面这套；其余 kind（`other`）**一律不判** ——
    // 否则会给普通文件报「缺边界章节」这类假违规。
    if (target.kind !== 'spec') return [];
    // kind === 'spec'
    const st = specBoundaryState(text);
    if (!st.heading) {
      return [`SPEC.md 缺「${SPEC_BOUNDARY_HEADING}」章节（模板见 skills/expert-team/assets/templates/SPEC.md:24）——规格沉默等于允许，这正是头号返工源`];
    }
    const phase = String((await phaseFor(target.runId, cwd)) || '');
    if (SPEC_COMPLETE_PHASES.has(phase) && !st.filled) {
      return [`SPEC.md 的「${SPEC_BOUNDARY_HEADING}」章节已进入阶段「${phase}」但仍无任何一行填写「期望拒绝」——没有拒绝码的边界视为未定义（已填 ${st.filledRows}/${st.totalRows} 行）`];
    }
    return [];
  }

  return async function boundaryInterceptor(exec, result, next) {
    // ⚠️ 宿主 `tools/post-execute` 的监听器签名是 **(exec, result, next)**。2026-09-12 真实事故：
    // 这里曾写成 `(exec, next)` ⇒ `next` 实际拿到的是 result ⇒ `next is not a function` 抛出
    // ⇒ 宿主把**每一次工具调用**都归一化成失败（全工具瘫痪）。两道防线：
    //   ① 按正确签名声明；② 即使 next 不是函数，也降级为"不干涉"而不是抛错。
    // 本监听器**绝不允许**成为工具调用的故障源。
    if (typeof next !== 'function') return { kind: 'accept' };
    const downstream = await next();
    // **工具本身已经失败时不要插嘴**：这时文件并没有变成"我以为的样子"（例如被 fs 观察策略
    // 拒绝的覆盖写、磁盘满、权限错），拿磁盘上的**旧内容**去校验只会给出**误导性**理由并把
    // 真错因盖掉。实测（2026-09-12）：一次"未先 read 就覆盖"的失败写，被本拦截器报成
    // 「任务 id 重复」，而真实原因是观察策略拒绝 —— 这种"用一个错误替换另一个错误"正是
    // 本项目最忌讳的失败模式。失败就让它原样呈现。
    if (result && (result.isError === true || result.error)) return downstream;
    let msgs = [];
    try {
      const raw = targetOf(exec);
      if (!raw) return downstream;
      const cwd = cwdFor(exec);
      if (!cwd) return downstream;
      const root = teamRootFor(cwd);
      if (!root) return downstream;
      // `file_path` 由宿主按会话 cwd 解析（可能是相对路径）⇒ 这里用同一基准解析。
      const scoped = runScopedTarget(resolve(cwd, raw), root);
      if (!scoped) return downstream;
      // ── 已完成/已终止的 run：**放行**（2026-09-13 实测撞到的误报）──────────────────
      // 实测场景：改一份**历史 run**（`phase=deliver status=complete`）的 `SPEC.md` 引用
      // （B 线 11b 搬词表后重锚行号），拦截器当场把工具结果改成「✗ SPEC.md 缺边界章节」。
      // 两个理由让这个拦截**只有坏处**：
      //   ① 已交付 run 的 SPEC 是**冻结的历史工件**，改它属于"更正引用"，不是"规格漂移"；
      //   ② `post-execute` 的 `block` **不回滚写入**（已验证）⇒ 它唯一的效果是让编辑者
      //      以为没改成（我差点据此重做一遍）。
      // 缺省语义**不变**（`statusFor` 不传或读不到 ⇒ 按"非终态"处理，门禁照旧 fail-closed）。
      const status = String((await statusFor(scoped.runId, cwd)) || '');
      if (TERMINAL_RUN_STATUSES.has(status)) {
        onEvent('boundary-gate-skipped-terminal', { runId: scoped.runId, kind: scoped.kind, status });
        return downstream;
      }
      // 设计稿 §十二 第 3 步：**并发写留痕** —— 只记录、只告警，**绝不阻断**
      // （本仓教训：一上来就拦会把门禁变成故障源；先观测真实频率，再决定要不要收紧）。
      // 放在"终态 run 已放行"之后：改历史 run 的工件属于更正引用，不该算并发事故。
      if (writeTracer) {
        try {
          const who = String((await whoFor(exec, scoped)) || '');
          const tr = writeTracer.record({ runId: scoped.runId, abs: scoped.abs, who });
          if (tr && tr.conflict) onEvent('concurrent-write', tr.conflict);
        } catch { /* 追踪失败绝不影响工具调用本身 */ }
      }
      msgs = await violationsFor(scoped, cwd);
      if (msgs.length > 0) onEvent('boundary-gate-blocked', { runId: scoped.runId, kind: scoped.kind, count: msgs.length });
    } catch (e) {
      // 拦截器自身绝不能让工具调用变红（宿主约定：监听器抛错会被收敛为失败结果）。
      onEvent('boundary-gate-error', { error: String((e && e.message) || e) });
      return downstream;
    }
    if (msgs.length === 0) return downstream;
    const feedback = msgs.map((m) => `✗ ${m}`).join('\n');
    if (downstream && downstream.kind === 'block') {
      return { kind: 'block', feedback: [...(downstream.feedback || []), { type: 'text', text: feedback }] };
    }
    return { kind: 'block', feedback: [{ type: 'text', text: feedback }] };
  };
}
