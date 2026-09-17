// 阶段计时（E 线 **E1/E2 共用的唯一一份时钟算术**）。
//
// 为什么单独成模块：E1（首个可运行产物耗时）与 E2（阶段时长分解 / 收尾定额）都要把
// `RUN.log.md` 行首的 `[HH:MM:SS]` 相减 —— 而**样本是跨午夜的**（
// 22:21:03 起、次日 08:15:30 收尾）。裸减会得到 **负数**：`00:32:30 - 22:21:03`
// = -78273 秒。跨午夜回绕是这类算术最容易写错、也最容易被复制到第二处的地方，而本仓的
// **头号返工源正是「一个事实多份拷贝」**（一次真实 run 里出现 6 例，占返工 14/29）。
// 所以：**只此一份**，另一处一律 import；两份实现在这里等于故意埋返工。
//
// 本模块**零 IO、零依赖**、全部纯函数 ⇒ 可以纯单测（不需要造 run 夹具）。

/** 一天的秒数（跨午夜回绕用）。 */
const SECONDS_PER_DAY = 86400;

/**
 * `HH:MM:SS` → 当日秒数（0..86399）。不可解析（含 `[now]` 这类历史写法、空值、越界值）返回 `null`。
 * @param hhmmss - 形如 `22:21:03` 的字符串。
 */
export function clockSeconds(hhmmss) {
  const m = String(hhmmss ?? '').match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3]);
  if (h > 23 || mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
}

/**
 * 从 `from` 到 `to` 的分钟数（四舍五入到整数分钟）。
 * **负值按跨午夜处理（+24h）** —— 真实 run 跨午夜是常态，不处理会把 2h11m 算成 −22h。
 * 任一时刻不可解析（如历史 run 的 `[now]`）返回 `null` —— 调用方必须把 `null` 当
 * 「算不出」而不是 0（把算不出当 0 会系统性美化指标）。
 */
export function clockDeltaMinutes(from, to) {
  const a = clockSeconds(from);
  const b = clockSeconds(to);
  if (a === null || b === null) return null;
  let d = b - a;
  if (d < 0) d += SECONDS_PER_DAY;
  return Math.round(d / 60);
}

/**
 * 中位数：偶数个时取**偏小**的那个（整数分钟，不做平均 —— 平均出来的 23.5 分钟既不是
 * 任何一次真实观测，又会被读成精确值）。
 * @param nums - 数字数组（调用方保证非空）。
 */
export function medianLower(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * E1「首个可运行产物」小节的正文（纯函数 ⇒ 版面与"两种零"的区分可单测）。
 *
 * ⚠️ **必须区分的两种零**（本仓在撤销率上吃过这个亏）：`0 个 run 登记` 与
 * `登记了但算不出` 是两件事，都不能被读成「首产物很快」。所以三种形态各有各的文案。
 *
 * @param args.samples - `[{ run, minutes }]`，只含**算得出**的那些 run。
 * @param args.runsWithLogs - 有日志的 run 总数（分母）。
 * @param args.unparsable - 写了 `first-runnable` 但**算不出**耗时（缺 `run:started` / 时间戳非 `HH:MM:SS`）的 run 数。
 * @param args.thresholdMinutes - 阈值（默认 10 分钟）。
 * @returns 小节正文（不含小节标题）。
 */
export function summarizeFirstRunnable({ samples, runsWithLogs, unparsable = 0, thresholdMinutes = 10 }) {
  const bad = unparsable > 0
    ? [`  · ⚠️ ${unparsable} 个 run 写了 \`first-runnable\` 但**算不出耗时**（缺 \`run:started\`，或时间戳不是 \`HH:MM:SS\`）⇒ 按**未登记**处理，不计入上面的分位数`]
    : [];
  const missing = runsWithLogs - samples.length - unparsable;
  const missNote = (n) => `  · 「未登记」${n} 个 run = 该 run 没有可运行产物 **或** lead 没写 \`first-runnable\` 事件 —— 日志**无法区分**这两种情况`;

  if (!samples.length) {
    return [
      `- （暂无 first-runnable 登记：有日志的 run 共 ${runsWithLogs} 个，但没有一个算得出「首个可运行产物耗时」—— **这不等于"首产物很快"**）`,
      ...bad,
      ...(missing > 0 ? [missNote(missing)] : []),
    ].join('\n');
  }

  const mins = samples.map((s) => s.minutes);
  const over = samples.filter((s) => s.minutes > thresholdMinutes).sort((a, b) => b.minutes - a.minutes);
  return [
    `- 首个可运行产物耗时：有登记 ${samples.length} / 有日志 ${runsWithLogs} 个 run · 中位 ${medianLower(mins)} 分钟 · 最快 ${Math.min(...mins)} 分钟 · 最慢 ${Math.max(...mins)} 分钟（阈值 ${thresholdMinutes} 分钟）`,
    ...bad,
    ...(over.length
      ? [`  · 超阈值（> ${thresholdMinutes} 分钟）：${over.map((s) => `${s.run}（${s.minutes} 分钟）`).join('、')}`]
      : [`  · 全部 ≤ ${thresholdMinutes} 分钟`]),
    ...(missing > 0 ? [missNote(missing)] : []),
  ].join('\n');
}

// ── E 线 E2：收尾预算（冻结后追加的阶段 ≤ 实现期 × 50%）─────────────────────────
//
// 实测依据（同一个真实 run，见 `docs/专家团-开发计划.md`）：实现期 3h23m，**代码冻结之后的
// 收尾 3h35m** —— 收尾比实现还长（1.06 倍），而它的成因不是"活多"，是「P3 不阻塞交付」这条
// 规则当时**只写在 SKILL 里、没有定额**，于是没人知道该在第几小时停手。
//
// ⚠️ 更糟的一点：那个 run 的 `RUN.log.md` 里**一条 `phase:review` / `phase:test` 事件都没有**
// ⇒ 光靠日志，聚合器连"收尾有多长"都算不出来。所以本节的**头号产出不是那个比率，而是
// 「缺记账」这件事必须可见** —— 隐形比超标更难修。

/**
 * 从**按日志顺序**的阶段事件里算出「开工 / 实现 / 收尾」三段时长。
 *
 * 口径（**近似，必须显式说明**）：把**首个 `review` 或 `test` 阶段事件**当作"代码冻结"的
 * 观测点 —— 冻结本身没有独立事件，而 review/test 按流水线必然发生在 freeze 之后。
 * 缺 review/test 时**不猜**：`implementMinutes` / `closingMinutes` 一律返回 `null`。
 *
 * @param args.started - `run:started` 的时间戳（可 `null`）。
 * @param args.phases - `[{ phase, time }]`，按日志出现顺序；同一阶段可重复出现。
 * @returns `{ preCodeMinutes, implementMinutes, closingMinutes, firstImplement, firstClosing, deliver }`
 *   —— 任一环节算不出就是 `null`（**不是 0**：把算不出当 0 会让缺失看起来像"很快"）。
 */
export function runTimeline({ started, phases, firstRunnable = null }) {
  const first = {};
  for (const p of (Array.isArray(phases) ? phases : [])) {
    // 只认**时间戳可解析**的那一条：`[now]` 这类历史写法不能参与算术，否则整条链变 null。
    if (first[p.phase] === undefined && clockSeconds(p.time) !== null) first[p.phase] = p.time;
  }
  // 实现期**起点**：`first-runnable` **优先**，回退 `phase:implement`。
  //
  // 2026-09-13 真实数据修正：原先只认 `phase:implement`，而 SKILL §7.33 ⓿ 与 METRICS 标题写的口径是
  // 「实现期 = **首产物** → 冻结」。实测那个跑完的 run **有 `phase:review`/`phase:test` 却从没写
  // `phase:implement`** ⇒ 口径与代码不一致，整段收尾预算算不出来，还被误报成「一条阶段事件都没写」。
  // 现在以首产物为准；老 run 没有 `first-runnable` 时仍回落 `phase:implement`（向后兼容，且**来源可见**）。
  const implement = firstRunnable ?? first.implement ?? null;
  const implementSource = firstRunnable ? 'first-runnable' : (first.implement ? 'phase:implement' : null);
  // 冻结观测点：review 优先，其次 test（两者都没有 ⇒ null，绝不退化成 deliver）。
  const closingStart = first.review ?? first.test ?? null;
  const deliver = first.deliver ?? null;
  return {
    firstImplement: implement,
    implementSource,
    firstClosing: closingStart,
    deliver,
    preCodeMinutes: clockDeltaMinutes(started, implement),
    implementMinutes: clockDeltaMinutes(implement, closingStart),
    closingMinutes: clockDeltaMinutes(closingStart, deliver),
  };
}

/**
 * E2「收尾预算」小节的正文（纯函数 ⇒ 版面与三种缺失形态可单测）。
 *
 * @param args.rows - `[{ run, implementMinutes, closingMinutes }]`，只含**两段都算得出**的 run。
 * @param args.missingClosing - 有 `implement` 但**没有** `review`/`test` 阶段事件的 run 数。
 * @param args.noPhases - 有日志但**连 `implement` 都没有**的 run 数（阶段记账整体缺失）。
 * @param args.runsWithLogs - 有日志的 run 总数（分母）。
 * @param args.ratio - 预算比例（默认 0.5，即收尾 ≤ 实现期的一半）。
 * @returns 小节正文（不含小节标题）。
 */
export function summarizeClosingBudget({ rows, missingClosing = 0, missingStart = 0, noPhases = 0, runsWithLogs, ratio = 0.5 }) {
  const pct = Math.round(ratio * 100);
  const notes = [];
  if (missingClosing > 0) {
    notes.push(`  · ⚠️ ${missingClosing} 个 run **有起点（首产物 / \`phase:implement\`）却没有 \`review\`/\`test\` 阶段事件** ⇒ 实现期与收尾期**分不开**（本仓实测：某真实 run 的 3h35m 收尾就是这样在指标上完全隐形的。聚合器**不猜**，宁可显示"分不开"）`);
  }
  if (missingStart > 0) {
    notes.push(`  · ⚠️ ${missingStart} 个 run **既无 \`first-runnable\` 也无 \`phase:implement\`** ⇒ **实现期起点缺失**（这跟"没有收尾"是两回事；SKILL §7.33 ⓿ 要求开工时就登记首产物）`);
  }
  if (noPhases > 0) {
    notes.push(`  · 「未登记」${noPhases} 个 run = 一条阶段事件都没写 —— **不等于"收尾很短"**`);
  }

  if (!rows.length) {
    return [
      `- （暂无收尾预算可算：有日志的 run 共 ${runsWithLogs} 个，但没有一个同时算得出「实现期」与「收尾期」—— 缺的是 \`phase:review\`/\`phase:test\` 记账，不是"没有收尾"）`,
      ...notes,
    ].join('\n');
  }

  const withRatio = rows.map((r) => ({ ...r, p: r.implementMinutes > 0 ? r.closingMinutes / r.implementMinutes : null }));
  const over = withRatio
    .filter((r) => r.implementMinutes > 0 && r.closingMinutes > r.implementMinutes * ratio)
    .sort((a, b) => b.p - a.p);
  return [
    // 口径写在这里、也写在 render 的小节标题里：**实现期 = 首产物 → 首个 review/test**，
    // **收尾 = 首个 review/test → 交付**。澄清/调研/设计那一段（`preCodeMinutes`）**不进实现期** ——
    // 2026-09-13 真实 run 实测：把 pre-code 算进去会把 51% 读成 48%，**跨过 50% 红线、结论翻转**。
    `- 收尾预算（实现期 = 首产物→冻结，收尾 = 冻结→交付；收尾 ≤ 实现期 × ${pct}%）：可算 ${rows.length} / 有日志 ${runsWithLogs} 个 run · 超预算 ${over.length} 个`,
    ...notes,
    ...(over.length
      ? [`  · 超预算：${over.map((r) => `${r.run}（实现 ${r.implementMinutes} 分钟 / 收尾 ${r.closingMinutes} 分钟 = ${Math.round(r.p * 100)}%）`).join('、')}`]
      : [`  · 全部 ≤ ${pct}%（或实现期为 0，无法成比例，不计入超预算）`]),
    '  · 「冻结」的观测点是**首个 `review`/`test` 阶段事件**（冻结本身没有独立事件，这是近似口径）。',
  ].join('\n');
}
