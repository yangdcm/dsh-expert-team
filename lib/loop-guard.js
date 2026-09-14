// 振荡检测（C 线第 16 项的**收窄版**）：同工具重复调用已由宿主负责，这里只管"A→B→A→B 来回横跳"。
//
// 为什么只做这一种（取证在 `docs/Qoder对标/02-Experts编排与提示词.md` 与宿主自带包的 README）：
//   把"一直循环返工"拆成三种形态后逐一对照：
//     ① 同工具、同参数的**重复调用** ⇒ **宿主已覆盖**：`@deepseek-ai/dsh-repeat-tool-reminder`
//        在 dsh-base 里默认启用（thresholds `[3, 5, 8]`），按 agent 记链并注入提醒。
//        **不要重写它**（用户明确要求过"不要每次都是自己造轮子"）。
//     ② 同一 finding **跨轮未闭环** ⇒ 本包四支柱的 `FINDING_REOPENED`（读侧违规）已覆盖。
//     ③ **A→B→A→B 振荡** ⇒ **没人管**。宿主那份 README 写死了它的边界：
//        "Exact-match detection only — near-identical variants evade the chain"，
//        且没有任何交替检测；而 Qoder 平台内核里有一条专门的 `[ALTERNATING LOOP DETECTED]`。
//        这一条正是用户最初抱怨的形态（不是原地重复，而是在两个修法之间来回）。
//
// 与宿主那份的**关键差异（为什么这里用"阻断"而不是"只提醒"）**：
//   宿主那份是 advisory（`never blocks or delays a legitimate repeated call`）—— 因为**完全相同的
//   轮询/等待调用可能是合法的**。但**振荡从来不是合法行为**：在两个互斥方案之间来回本身就说明
//   至少有一个判断是错的，继续切只会烧预算。Qoder 对它的处理也是硬性的（`You MUST: 1) STOP
//   switching between approaches...`）。因此这里用 `block{feedback}` 把结果变成错误 + 模型可见理由。
//
// 安全纪律（2026-09-12 监听器签名事故之后立的规矩，本模块逐条遵守）：
//   ① 按宿主签名 `(exec, result, next)` 声明；② `next` 不是函数时降级为"不干涉"，绝不抛错；
//   ③ 自身逻辑全部包在 try/catch 里 —— **绝不允许**成为工具调用的故障源。

/** 参数预览的截断长度（只用于提醒文案，不参与判定）。 */
const DEFAULT_PREVIEW_CHARS = 200;

// 只对**会改文件内容**的工具记链（`write`/`edit`），并且额外要求四次调用指向**同一个文件**。
//
// 为什么必须这么窄（写完第一版才意识到的误报）：`编辑 a.js` → `编辑 b.js` → `编辑 a.js` → `编辑 b.js`
// 形式上也是 A→B→A→B，但那是**完全正常的干活**（两个文件交替改）。窄化后真正的判据是：
// **在同一个文件上，用两种不同内容来回覆盖 ≥2 个来回** —— 那才是 Qoder 那条
// `[ALTERNATING LOOP DETECTED]` 说的"在两个互斥方案之间来回"。
// 误报的代价不是"多一条提醒"：它会把守卫本身变成噪声（本包实测教训 —— 噪声门禁 = 没有门禁）。
import { WRITE_TOOLS, targetOf } from './interception.js';

/** 本工具的 `file_path`（非写入类工具返回 null ⇒ 不参与记链）。 */
export function trackedPath(exec) {
  if (!exec || !WRITE_TOOLS.has(String(exec.name || ''))) return null;
  return targetOf(exec);
}

/**
 * 归一化一次调用的身份：工具名 + 深度键序无关的参数 JSON。
 * 与宿主那份同思路（深键序排序），但**不追求完全一致** —— 我们只关心"两次调用是不是同一个意图"。
 * @param exec - 工具执行记录。
 * @returns 身份串（参数不可序列化时退回 `String(arguments)`）。
 */
export function callKey(exec) {
  const name = String((exec && exec.name) || '');
  let canon;
  try {
    canon = JSON.stringify(sortDeep(exec && exec.arguments));
  } catch {
    canon = String(exec && exec.arguments);
  }
  return `${name}\u0000${canon}`;
}

/** 深度键序排序（数组保持原序，只稳定化对象键序）。 */
export function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

/**
 * 从调用身份序列尾部判定是否在振荡。
 * 判据：最后 4 条形如 `a b a b`（且 `a !== b`）—— 即"回到刚才否掉的方案，又回到刚才那个"。
 * 只认**紧邻**的 4 条，不做模糊匹配：误报会把提醒变成噪声（本包实测过的教训，噪声门禁 = 没有门禁）。
 * @param history - 最近的调用身份（按时间先后）。
 * @returns 振荡对的稳定 key（`a|b`，字典序）；未振荡返回 null。
 */
export function oscillationPair(history) {
  const h = Array.isArray(history) ? history : [];
  if (h.length < 4) return null;
  const [x1, x2, x3, x4] = h.slice(-4);
  if (x1 === x2) return null;
  if (x1 !== x3 || x2 !== x4) return null;
  return [x1, x2].sort().join('\u0001');
}

/**
 * 创建一个 `tools/post-execute` 振荡守卫。
 *
 * @param deps - 注入依赖：
 *   `onEvent(type, payload)`（可观测：让"守卫被行使"看得见）、
 *   `enabled`（默认 true）、`historySize`（默认 8）、`previewChars`（默认 200）、
 *   `makeFeedback(text)`（把文案包成宿主认的 `ContentBlock[]`；默认 `[{type:'text',text}]`）。
 * @returns `(exec, result, next) => Promise<PostToolDecision>`
 */
export function createLoopGuard(deps = {}) {
  const {
    onEvent = () => {},
    enabled = true,
    historySize = 8,
    previewChars = DEFAULT_PREVIEW_CHARS,
    makeFeedback = (text) => [{ type: 'text', text }],
  } = deps;

  /** 每个 agent 一条链（用 agent 对象本身做键 ⇒ 不泄漏、不串号）。 */
  const chains = new WeakMap();

  function stateFor(agent) {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return null;
    let st = chains.get(agent);
    if (!st) { st = { history: [], fired: new Set() }; chains.set(agent, st); }
    return st;
  }

  return async function loopGuard(exec, result, next) {
    // ① 签名纪律：不是瀑布就降级为不干涉（写错签名曾让整个会话的工具链瘫痪）
    if (typeof next !== 'function') return { kind: 'accept' };
    const downstream = await next();
    try {
      if (!enabled) return downstream;
      // ② 工具本身已失败 ⇒ 不插嘴（沿用边界拦截器的同一条纪律：不拿无关理由掩盖真错因）
      if (result && (result.isError === true || result.error)) return downstream;
      // ③ 只对**会改文件内容**的工具记链（写/编辑）；读类工具交替调用是正常干活
      const path = trackedPath(exec);
      if (!path) return downstream;
      // ④ 只对**agent 发起的**调用记链；直接调用的宿主工具不参与（无法归因到某个子代理）
      const agent = exec && exec.agent;
      const st = stateFor(agent);
      if (!st) return downstream;

      const key = callKey(exec);
      st.history.push({ key, path });
      if (st.history.length > historySize) st.history.splice(0, st.history.length - historySize);

      const pair = oscillationPair(st.history.map((e) => e.key));
      if (!pair) return downstream;
      // ⑤ **必须同一个文件**：`编辑 a.js`/`编辑 b.js` 交替是正常干活，不是振荡
      if (new Set(st.history.slice(-4).map((e) => e.path)).size !== 1) return downstream;
      // ⑥ 同一对**每个 agent 会话只提醒一次**：重复提醒会把守卫变成噪声（宿主那份的已知痛点）
      if (st.fired.has(pair)) return downstream;
      st.fired.add(pair);

      const name = String((exec && exec.name) || '');
      const preview = String(exec && exec.arguments ? JSON.stringify(exec.arguments) : '').slice(0, previewChars);
      const text = [
        `⚠️ 检测到**振荡**：你在两个互斥的做法之间来回切换（最近四次调用形如 A→B→A→B，工具「${name}」）。`,
        '来回切本身说明其中至少一次判断是错的。请按顺序做：',
        '1) **停止切换**：从两者中选一个最可能正确的，明确写出为什么选它；',
        '2) 若两者都不成立，**退一步找共同根因**，而不是在两者之间继续换；',
        '3) 若确实无法推进，**停下来给结论**：已试过什么、各自失败在哪、还剩什么没试。',
        `（最近一次调用的参数预览：${preview || '（无）'}）`,
      ].join('\n');

      onEvent('loop-guard-oscillation', { tool: name, pair });
      const feedback = makeFeedback(text);
      // ④ 折叠下游结论：下游已 block 就保留它的理由再追加我们的；否则自己 block
      if (downstream && downstream.kind === 'block') {
        return { kind: 'block', feedback: [...(downstream.feedback || []), ...feedback] };
      }
      return { kind: 'block', feedback };
    } catch (e) {
      onEvent('loop-guard-error', { error: String((e && e.message) || e) });
      return downstream;
    }
  };
}
