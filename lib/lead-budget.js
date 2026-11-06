// lead 步数预算（成本治理·2026-11）—— **只提醒，不阻断**。
//
// 为什么需要它（实测数据，不是假设）：
//   `team/METRICS.md` 的 token 一节显示，5 个 run 共 5,861 步；其中单 run 最高 3,475 步；
//   两个 run 的 **lead 占比 84% / 92%**。输出 token 只占总量 0.34% ⇒ 费用 = 步数 × 每步上下文，
//   而不是"模型话多"。lead 每多绕一步，就要重放一次完整上下文（V4.1 Flash 的 1M 窗口下，
//   峰值 prompt 实测 807K）——**循环次数就是费用**。
//
// 为什么是"提醒"而不是"阻断"：
//   ① 宿主 `tools/post-execute` 的 block 会把工具结果变成失败，而这里的判据（调用次数）**不是
//      一个可证明的违规** —— 大 run 本来就需要很多步。硬拦只会制造"任务做到一半被卡死"。
//   ② 宿主的 `dsh-repeat-tool-reminder` 也采用同一套哲学：**advisory**（`never blocks or delays`）。
//      我们复用它的**非阻断通道** `additionalContexts`（模型可见的 `form:'notice'` 用户消息），
//      而不是自己发明第二种注入方式。
//   ③ 真正的"停手"仍然由用户拍板：到顶的正确动作是写 SUMMARY/backlog 并升级，而不是插件替用户停。
//
// 计数口径（必须可解释，不猜）：
//   · 只数**lead 自己的工具调用**：`delegationDepth === 0`。角色子代理的步数由各自任务决定，
//     混在一起就分不清"谁在烧钱"。
//   · 只数**归属于某个 run 的会话**（`sessionRunFor(sid)` 有记录）—— 没跑专家团的普通会话
//     不该收到团队预算提醒。
//   · 每个 run 只记一次阈值（`fired` 集合）—— 同一阈值重复提醒 = 噪声，而噪声的代价是
//     所有提醒一起被降权（本仓既有教训）。
//
// 阈值：200 / 600 / 1200。为什么是这三个：200 次足够走完 clarify→design→implement→review 的
// 正常路径；600 次已经明显偏多（大 run 的 lead 通常 < 400）；1200 次基本可以确定"在扩大范围"。
// 文案逐级升级（建议→收敛→收尾），但**都不要求停**。

/** 默认阈值（升序）。改这里等于改产品口径 —— 有测试钉住。 */
export const DEFAULT_BUDGET_THRESHOLDS = Object.freeze([200, 600, 1200]);

/** 上限：同一进程里最多保留多少个 run 的计数（防止长时间运行的 host 无限增长）。 */
export const MAX_TRACKED_RUNS = 256;

/**
 * 本 run 的 lead 调用数落在哪个阈值上。
 *
 * @param {number} count - 当前调用数（1-based）。
 * @param {number[]} [thresholds] - 升序阈值表。
 * @returns {number} 命中的阈值下标；没命中返回 -1。
 */
export function hitThreshold(count, thresholds = DEFAULT_BUDGET_THRESHOLDS) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return -1;
  return thresholds.indexOf(n);
}

/**
 * 生成**模型可见**的提醒文案（纯函数，便于单测；不含时间/路径等易变内容）。
 *
 * @param {number} count - 当前调用数。
 * @param {number[]} [thresholds] - 升序阈值表。
 * @returns {{level:number, summary:string, text:string}|null} 未命中返回 null。
 */
export function budgetNotice(count, thresholds = DEFAULT_BUDGET_THRESHOLDS) {
  const level = hitThreshold(count, thresholds);
  if (level < 0) return null;
  const n = Number(count);
  const last = thresholds.length - 1;
  if (level === 0) {
    return {
      level,
      summary: `lead 工具调用 ${n} 次`,
      text: `⏱ 预算提醒：本 run 的 lead 已调用工具 ${n} 次。`
        + '省钱的做法是**把「读/改/跑」派给对应角色**（lead 只做编排、门控与裁决）；'
        + '读工件用 `read` 的 offset/limit 或 `/state?section=` 只取需要的片段，不要重复全量读；'
        + '已经通过的验证不要重复跑。',
    };
  }
  if (level < last) {
    return {
      level,
      summary: `lead 工具调用 ${n} 次（偏多）`,
      text: `⚠ 预算提醒：lead 工具调用已达 ${n} 次（偏多）。请先**收敛范围**：`
        + '非阻塞项（P3/风格/文档润色）记进 SUMMARY 的 backlog，只保留 P1/P2；'
        + '把剩余实现/验证派工出去，不要自己接着读完整仓库。',
    };
  }
  return {
    level,
    summary: `lead 工具调用 ${n} 次（超预算）`,
    text: `🚨 预算提醒：lead 工具调用已达 ${n} 次（超出建议预算）。`
      + '请**立即收尾**：写 REVIEW/TEST/SUMMARY，把剩余项转 backlog 并如实标注「未在本轮闭环」；'
      + '是否继续由用户决定（把选择抛给用户，而不是继续扩大范围）。',
  };
}

/**
 * 每-run 计数器（内存态；不落盘 —— 它是**过程提醒**，不是交付工件）。
 *
 * @param {{thresholds?: number[], onEvent?: Function, maxRuns?: number}} [opts]
 * @returns {{observe: Function, countOf: Function, reset: Function, _runs: Map}}
 */
export function createLeadBudget(opts = {}) {
  const thresholds = Array.isArray(opts.thresholds) && opts.thresholds.length
    ? [...opts.thresholds].sort((a, b) => a - b)
    : [...DEFAULT_BUDGET_THRESHOLDS];
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const maxRuns = Number.isInteger(opts.maxRuns) && opts.maxRuns > 0 ? opts.maxRuns : MAX_TRACKED_RUNS;
  /** runId → { n, fired:Set<number> }（Map 的插入顺序 = 首次出现顺序，用于有界淘汰）。 */
  const runs = new Map();

  function entryFor(runId) {
    let e = runs.get(runId);
    if (!e) {
      if (runs.size >= maxRuns) {
        const oldest = runs.keys().next().value;
        if (oldest !== undefined) runs.delete(oldest);
      }
      e = { n: 0, fired: new Set() };
      runs.set(runId, e);
    }
    return e;
  }

  return {
    /**
     * 记录一次工具调用；命中阈值时返回提醒（同一阈值只返回一次）。
     *
     * @param {object} exec - 宿主 `tools/post-execute` 的 exec（读 `agent.session.header.delegationDepth`）。
     * @param {string} [runId] - 该会话所属的 run；没有归属 ⇒ **不计数**（普通会话不打扰）。
     * @returns {{runId:string, count:number, level:number, summary:string, text:string}|null}
     */
    observe(exec, runId) {
      try {
        if (!runId) return null;
        const depth = Number(exec && exec.agent && exec.agent.session && exec.agent.session.header
          ? exec.agent.session.header.delegationDepth
          : 0);
        // 只数 lead：角色子代理（depth ≥ 1）的花费由各自任务决定，混进来会误判。
        if (Number.isFinite(depth) && depth > 0) return null;
        const e = entryFor(String(runId));
        e.n += 1;
        const note = budgetNotice(e.n, thresholds);
        if (!note) return null;
        if (e.fired.has(note.level)) return null;
        e.fired.add(note.level);
        onEvent({ type: 'budget:lead-calls', runId: String(runId), count: e.n, level: note.level });
        return { runId: String(runId), count: e.n, ...note };
      } catch {
        // 预算提醒绝不允许成为工具调用的故障源（与 loop-guard 同一条纪律）。
        return null;
      }
    },
    countOf(runId) { return (runs.get(String(runId)) || {}).n || 0; },
    reset(runId) { runs.delete(String(runId)); },
    _runs: runs,
  };
}

/**
 * 构造宿主认可的**非阻断**提醒消息（`additionalContexts` 通道）。
 *
 * 形状与宿主 `dsh-repeat-tool-reminder` 完全同族：`{role:'user', content:[{type:'text'}], source:{kind, form:'notice', summary}}`。
 * `source.form:'notice'` 表示"这是提示，不是用户发言"——不要改成普通 user 消息，否则 UI 会把它当用户说的话。
 *
 * @param {{text:string, summary:string}} note - 预算提醒。
 * @param {string} id - 消息 id（调用方给 `randomUUID()`）。
 * @returns {object} 可直接塞进 `additionalContexts` 的消息对象。
 */
export function budgetNoticeMessage(note, id) {
  return {
    id: String(id),
    role: 'user',
    content: [{ type: 'text', text: String(note.text) }],
    source: { kind: 'expert-team-budget', form: 'notice', summary: String(note.summary) },
  };
}
