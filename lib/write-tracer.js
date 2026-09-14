// 并发写留痕（设计稿 §十二 第 3 步）：**只记录、只告警，绝不阻断**。
//
// 依据（真实数据）：某真实 run 的 14 条返工里 **9 条（64%）**命中「同一事实多份拷贝 / 多写者 / 口径漂移」，
// 其中 T29 的原文是「CONTRACT 单写者收口（**并发事故收敛** + 6 处已核实缺陷）」—— 事故已经发生才收口。
// 第 2 步（`AUTHORITY.md`）把"谁写哪份文件"变成了**事前声明**；本模块把"声明有没有被违反"变成**可观测**的。
//
// 三个刻意的设计取舍：
//   ① **不阻断**。本仓的教训是"一上来就拦"会把门禁变成故障源（B2-1 的写侧门禁也踩过）。
//      这里先只留痕，等真实数据告诉我们"多频繁、多严重"，再决定要不要收紧。
//   ② **判据是"不同写者 + 同一文件 + 时间窗内"** —— 同一个人反复改同一文件是**正常**的，
//      只有**不同写者**才可能是事故（并发改同一份权威文件）。
//   ③ **身份用字符串，由调用方给**（角色或会话 id）。本模块不认识宿主、不做 IO —— 这样它可以被纯单测，
//      也避免在**写路径**上塞进重活。

/** 默认时间窗：10 分钟。取值理由：一次"派工 → 写文件 → 回报"通常远小于它，而**两个角色的写入**落在这个窗口内才像并发。 */
export const DEFAULT_WRITE_WINDOW_MS = 10 * 60 * 1000;

/**
 * 写者追踪器。
 * @param args.windowMs - 时间窗（毫秒）。
 * @param args.now - 时钟（可注入 ⇒ 可测）。
 * @returns `{ record, conflicts, windowMs, _size, _reset }`
 */
export function createWriteTracer({ windowMs = DEFAULT_WRITE_WINDOW_MS, now = () => Date.now() } = {}) {
  /** `${runId}::${abs}` → { who, at }（**最后一次**写入；只留最后一次即可判并发） */
  const last = new Map();
  /** 冲突历史（可审计；只保留最近 200 条，避免长跑进程里无界增长） */
  const conflicts = [];

  function record({ runId, abs, who, at = now() }) {
    const w = String(who || '');
    const key = `${String(runId || '')}::${String(abs || '')}`;
    if (!w) return { conflict: null };           // 说不出写者 ⇒ **不猜**（宁可不报）
    const prev = last.get(key);
    last.set(key, { who: w, at });
    if (!prev || !prev.who || prev.who === w) return { conflict: null };
    const gapMs = Math.max(0, at - prev.at);
    if (gapMs > windowMs) return { conflict: null }; // 超出窗口 ⇒ 不算并发
    const conflict = { runId, abs, from: prev.who, to: w, gapMs };
    conflicts.push(conflict);
    if (conflicts.length > 200) conflicts.shift();
    return { conflict };
  }

  return {
    record,
    conflicts: () => conflicts.slice(),
    windowMs,
    _size: () => last.size,
    _reset: () => { last.clear(); conflicts.length = 0; },
  };
}

/** 渲染成一行留痕文本（事件用；调用方决定写到哪）。 */
export function formatConflict(c) {
  const secs = Math.round((c.gapMs || 0) / 1000);
  return `concurrent-write — \`${String(c.abs).split('/').slice(-2).join('/')}\` 在 ${secs}s 内被**两个写者**先后写入：${c.from} → ${c.to}（同一份文件两个写者＝并发改同一份权威文件的形状，见 SKILL 规则 35 ④）`;
}
