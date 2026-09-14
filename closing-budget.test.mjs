// 测试：E 线 **E2 · 收尾预算**（冻结后追加的阶段 ≤ 实现期 × 50%）
//
// 为什么需要（同一个真实 run 的实测，见 `docs/专家团-开发计划.md`）：
// 那次 run **实现期 3h23m、冻结后的收尾 3h35m** —— 收尾比实现还长（106%）。成因不是"活多"：
// 「P3/风格项不阻塞交付」当时只是 SKILL 里的一句话，**没有定额**，于是没人知道该在第几小时停手。
//
// 更要命的是**这个 3h35m 原本是度量盲区**：那个 run 的 `RUN.log.md` 里一条
// `phase:review` / `phase:test` 事件都没有 ⇒ 聚合器连"收尾有多长"都算不出来。
// 所以本测试的头号断言**不是那个比率，而是"缺记账必须可见"** —— 隐形比超标更难修。
//
// 本测试钉住：
//   ① `runTimeline` 的三段口径（含跨午夜；缺 review/test 时**不猜**，返回 null 而不是 0）；
//   ② 三种缺失形态可区分（分不开 / 未登记 / 真的没超标）；
//   ③ 端到端：真实 `/team learn` 把「超预算的那个 run」**点名**出来。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M108**。
// 运行：node closing-budget.test.mjs

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTimeline, summarizeClosingBudget } from './lib/metrics/timing.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# E 线 E2 · 收尾预算（实现期 vs 冻结后收尾）\n');

// ── ① 三段口径（用**真实 run 的时间戳**，不是编的数字）──────────────────────
console.log('① runTimeline：三段口径（真实 run 时间戳：22:21:03 起 / 00:32:30 进实现 / 03:55:30 冻结 / 07:30:00 交付）');
const real = runTimeline({
  started: '22:21:03',
  phases: [
    { phase: 'research', time: '22:21:27' },
    { phase: 'clarify', time: '22:54:30' },
    { phase: 'design', time: '00:09:00' },
    { phase: 'spec-review', time: '00:14:00' },
    { phase: 'implement', time: '00:32:30' },
    { phase: 'review', time: '03:55:30' },
    { phase: 'deliver', time: '07:30:00' },
  ],
});
check(real.preCodeMinutes === 131, '首行代码前 = 131 分钟（跨午夜，与实测 2h11m 一致）', String(real.preCodeMinutes));
// ⚠️ 这条同时是**口径契约**（2026-09-13 写死）：实现期 = **首产物 → 冻结**，不含 pre-code。
// 同一个真实 run 实测：把 pre-code 算进去会把 51% 读成 48%、跨过 50% 红线 ⇒ **结论翻转**。
// 谁要改这个分段定义，这条断言（203 / 131 两个数）会先红。
check(real.preCodeMinutes + real.implementMinutes === 334, '**实现期 203 不含 pre-code 131**（334 是含 pre-code 的错解）', `${real.preCodeMinutes}+${real.implementMinutes}`);
check(real.implementMinutes === 203, '实现期 = 首产物→冻结 = 203 分钟（实测 3h23m）', String(real.implementMinutes));
check(real.closingMinutes === 215, '冻结后收尾 = 215 分钟（实测 3h35m）—— 收尾比实现还长', String(real.closingMinutes));

const noReview = runTimeline({
  started: '08:00:00',
  phases: [{ phase: 'implement', time: '08:30:00' }, { phase: 'deliver', time: '09:30:00' }],
});
check(noReview.firstImplement === '08:30:00', '缺 review/test 时仍能认出 implement（不然连"缺哪一段"都说不出）');
check(noReview.implementMinutes === null && noReview.closingMinutes === null, '缺 review/test ⇒ 两段都是 **null**（不猜、不退化成 implement→deliver 的 60 分钟）', `${noReview.implementMinutes}/${noReview.closingMinutes}`);

const testAsFreeze = runTimeline({ started: '09:00:00', phases: [{ phase: 'implement', time: '09:10:00' }, { phase: 'test', time: '09:40:00' }, { phase: 'deliver', time: '09:50:00' }] });
check(testAsFreeze.implementMinutes === 30 && testAsFreeze.closingMinutes === 10, '没有 review 时用 test 作冻结观测点（30 / 10）', `${testAsFreeze.implementMinutes}/${testAsFreeze.closingMinutes}`);

const repeated = runTimeline({ started: '10:00:00', phases: [{ phase: 'implement', time: '10:10:00' }, { phase: 'implement', time: '10:50:00' }, { phase: 'review', time: '11:00:00' }, { phase: 'deliver', time: '11:10:00' }] });
check(repeated.implementMinutes === 50 && repeated.closingMinutes === 10, '同一阶段重复出现取**首次**（实现 50 不是 10，收尾 10）', `${repeated.implementMinutes}/${repeated.closingMinutes}`);

const nowOnly = runTimeline({ started: 'now', phases: [{ phase: 'implement', time: '[now]' }, { phase: 'review', time: '[now]' }] });
check(nowOnly.implementMinutes === null && nowOnly.closingMinutes === null, '`[now]` / `[now]` 这类不可解析时间戳 ⇒ null（不参与算术，也不污染整条链）');

// ── ② 三种形态的文案 ────────────────────────────────────────────────────────
console.log('\n② 三种形态必须可区分（"分不开" / "未登记" / "真的没超标"）');
const none = summarizeClosingBudget({ rows: [], missingClosing: 0, noPhases: 2, runsWithLogs: 2 });
check(none.includes('暂无收尾预算可算'), '零可算 → 占位句（不静默省略）');
check(none.includes('缺的是 `phase:review`/`phase:test` 记账，不是"没有收尾"'), '占位句点明缺的是什么（否则读者会以为项目没收尾阶段）');
check(none.includes('「未登记」2 个 run'), '未登记数单独渲染');

const split = summarizeClosingBudget({ rows: [], missingClosing: 3, noPhases: 0, runsWithLogs: 3 });
// 2026-09-13 重钉：措辞改为"有**起点**（首产物 / `phase:implement`）"—— 因为实现期起点现在
// **首产物优先**（真实 run 有 review/test 却没写 phase:implement，旧口径算不出来）。断言本身没放宽。
check(split.includes('3 个 run **有起点（首产物 / `phase:implement`）却没有 `review`/`test` 阶段事件**'), '「分不开」有独立警示（这正是真实 run 的形态）');
check(split.includes('3h35m 收尾就是这样在指标上完全隐形的'), '警示里带上实测证据（不是泛泛而谈）');

const okRows = summarizeClosingBudget({ rows: [{ run: 'a', implementMinutes: 100, closingMinutes: 20 }], missingClosing: 0, noPhases: 0, runsWithLogs: 1 });
check(okRows.includes('可算 1 / 有日志 1 个 run · 超预算 0 个'), '分子分母一起渲染', (okRows.match(/收尾预算[^\n]*/) || [''])[0]);
check(okRows.includes('全部 ≤ 50%'), '真没超标时如实说"全部 ≤ 50%"（不与"没数据"混）');

const over = summarizeClosingBudget({ rows: [{ run: 'x', implementMinutes: 203, closingMinutes: 215 }, { run: 'y', implementMinutes: 10, closingMinutes: 4 }], missingClosing: 0, noPhases: 0, runsWithLogs: 2 });
check(over.includes('超预算：x（实现 203 分钟 / 收尾 215 分钟 = 106%）'), '超预算的 run **点名** + 给出百分比（按超标倍数降序）', (over.match(/超预算：[^\n]*/) || [''])[0]);
check(!over.includes('y（'), '没超标的 run 不进超预算名单');
const zeroImpl = summarizeClosingBudget({ rows: [{ run: 'z', implementMinutes: 0, closingMinutes: 30 }], runsWithLogs: 1 });
check(zeroImpl.includes('超预算 0 个') && zeroImpl.includes('实现期为 0'), '实现期为 0 时**不**成比例（避免除零得出 Infinity 百分比）');

// ── ③ 端到端：事件 → aggregate → METRICS.md ─────────────────────────────────
console.log('\n③ 端到端接线（真实 `/team learn`）');
const root = await mkdtemp(join(tmpdir(), 'dsh-et-closing-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply } = await import(join(here, 'lib', 'command.js'));
let registered = null;
apply({ commands: { register: (d) => { registered = d; } }, on: () => {}, get: () => undefined, inject: () => {} });
const cmdIn = (rawInput, c = cwd) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-closing-budget', header: { cwd: c } }, followup: () => {} },
});
const dirsIn = async (c) => {
  try {
    return (await readdir(join(c, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
};
const newRun = async (goal, c) => {
  const before = new Set(await dirsIn(c));
  await cmdIn(goal, c);
  return (await dirsIn(c)).find((x) => !before.has(x));
};
const writeLog = (run, lines) => writeFile(join(cwd, 'team', run, 'RUN.log.md'), ['# 运行日志（RUN.log）', '', ...lines, ''].join('\n'));

const rs = await newRun('收尾超预算的 run', cwd);
const ro = await newRun('收尾在预算内的 run', cwd);
const rm = await newRun('缺 review 记账的 run', cwd);
const rn = await newRun('没有阶段事件的 run', cwd);
check(!!(rs && ro && rm && rn), '四个夹具 run 都建好了', [rs, ro, rm, rn].join(' / '));
// ① 真实 run 的时间戳：实现 203 分钟 / 收尾 215 分钟 ⇒ 106%，超预算
await writeLog(rs, [
  '- [22:21:03] run:started — 目标=s',
  '- [00:32:30] phase:implement — 实现（DAG 并行）',
  '- [03:55:30] phase:review — 代码冻结，进入审查',
  '- [07:30:00] phase:deliver — 交付',
]);
// ② 实现 10 分钟 / 收尾 5 分钟 ⇒ 恰好 50%，不超
await writeLog(ro, [
  '- [09:00:00] run:started — 目标=o',
  '- [09:10:00] phase:implement — 实现',
  '- [09:20:00] phase:review — 审查',
  '- [09:25:00] phase:deliver — 交付',
]);
// ③ 有 implement、没有 review/test ⇒ 分不开
await writeLog(rm, [
  '- [08:00:00] run:started — 目标=m',
  '- [08:30:00] phase:implement — 实现',
  '- [09:30:00] phase:deliver — 交付',
]);
// ④ 一条阶段事件都没有 ⇒ 未登记
await writeLog(rn, ['- [07:00:00] run:started — 目标=n', '- [07:05:00] decision:lead — 只有决策，没有阶段']);
await cmdIn('learn');
const m = await readFile(join(cwd, 'team', 'METRICS.md'), 'utf8');

check(m.includes('## 收尾预算（实现期 = 首产物→冻结 · 收尾 = 冻结→交付）'), 'METRICS 出现「收尾预算」小节');
check(m.includes('可算 2 / 有日志 4 个 run · 超预算 1 个'), '可算数与分母都渲染', (m.match(/- 收尾预算[^\n]*/) || ['(未出现)'])[0]);
check(m.includes(`超预算：${rs}（实现 203 分钟 / 收尾 215 分钟 = 106%）`), '超预算的 run 被**点名**，并给出实测的 106%', (m.match(/超预算：[^\n]*/) || ['(未出现)'])[0]);
check(!new RegExp(`超预算：[^\\n]*${ro}`).test(m), '恰好 50% 的 run **不算**超预算（边界不误报）');
check(m.includes('⚠️ 1 个 run **有起点（首产物 / `phase:implement`）却没有 `review`/`test` 阶段事件**'), '「分不开」的那个 run 被单列（这正是真实 run 的形态）');
check(m.includes('「未登记」1 个 run'), '未登记数 = 1');
check(!/\bundefined\b/.test(m) && !/\bNaN\b/.test(m), '渲染结果里没有 undefined / NaN');

// ④ 反向：连一个能算的 run 都没有时渲染占位句
console.log('\n④ 反向：零可算时渲染占位句（不静默省略）');
const cwd2 = join(root, 'proj2');
await mkdir(cwd2, { recursive: true });
const rx = await newRun('纯文档项目', cwd2);
check(!!rx, '第二个工作区建好 run', String(rx));
await writeFile(join(cwd2, 'team', rx, 'RUN.log.md'), ['# 运行日志（RUN.log）', '', '- [08:00:00] run:started — 目标=docs', '- [08:20:00] phase:deliver — 交付', ''].join('\n'));
await cmdIn('learn', cwd2);
const m2 = await readFile(join(cwd2, 'team', 'METRICS.md'), 'utf8');
check(m2.includes('（暂无收尾预算可算'), '零可算 → 占位句', (m2.match(/- （暂无收尾预算可算[^\n]*/) || ['(未出现)'])[0]);
check(m2.includes('缺的是 `phase:review`/`phase:test` 记账'), '占位句点明缺的是记账，不是"没有收尾"');

console.log('\n⑦ 2026-09-13 真实数据修正：实现期起点 = **首产物优先**，且四类缺失各说各话');
{
  // (a) 首产物优先于 phase:implement
  const withBoth = runTimeline({ started: '22:10:00', firstRunnable: '22:11:00',
    phases: [{ phase: 'implement', time: '22:30:00' }, { phase: 'review', time: '23:00:00' }, { phase: 'deliver', time: '23:30:00' }] });
  check(withBoth.implementSource === 'first-runnable' && withBoth.firstImplement === '22:11:00',
    '两个都有 ⇒ 用**首产物**（口径写死为「首产物→冻结」）', withBoth.implementSource);
  check(withBoth.implementMinutes === 49, '实现期从首产物算起 = 49 分钟（22:11→23:00）', String(withBoth.implementMinutes));

  // (b) 真实 run 的形态：有 review/test、**没有 phase:implement** ⇒ 仍然算得出来（旧实现算不出来）
  const noImplement = runTimeline({ started: '22:10:00', firstRunnable: '22:11:54',
    phases: [{ phase: 'review', time: '23:52:00' }, { phase: 'deliver', time: '00:43:00' }] });
  check(noImplement.implementMinutes === 100 && noImplement.closingMinutes === 51,
    '**有首产物、无 phase:implement** ⇒ 仍然算得出（100 / 51，与真实 run 手算一致）', `${noImplement.implementMinutes}/${noImplement.closingMinutes}`);
  check(noImplement.implementSource === 'first-runnable', '来源如实标出');

  // (c) 都没有 ⇒ 起点缺失
  const noStart = runTimeline({ started: '10:00:00', phases: [{ phase: 'review', time: '11:00:00' }] });
  check(noStart.firstImplement === null && noStart.implementSource === null, '既无首产物也无 phase:implement ⇒ 起点为 null');

  // (d) 旧 run 只有 phase:implement ⇒ 向后兼容，且来源可见
  const legacy = runTimeline({ started: '10:00:00', phases: [{ phase: 'implement', time: '10:30:00' }, { phase: 'review', time: '11:00:00' }, { phase: 'deliver', time: '11:20:00' }] });
  check(legacy.implementSource === 'phase:implement' && legacy.implementMinutes === 30, '老 run 回落 `phase:implement`（兼容），来源标为 phase:implement', legacy.implementSource);

  // (e) 四类缺失不混为一谈
  const s1 = summarizeClosingBudget({ rows: [], missingClosing: 2, missingStart: 3, noPhases: 0, runsWithLogs: 5 });
  check(s1.includes('2 个 run **有起点') && s1.includes('3 个 run **既无 `first-runnable` 也无 `phase:implement`**'),
    '「缺冻结点」与「缺起点」分成两条警示（**不许混成一类**）');
  check(s1.includes('这跟"没有收尾"是两回事'), '缺起点那条点明它不是"没有收尾"');
  const s2 = summarizeClosingBudget({ rows: [], missingClosing: 0, missingStart: 0, noPhases: 4, runsWithLogs: 4 });
  check(!s2.includes('缺起点') && s2.includes('「未登记」4 个 run = 一条阶段事件都没写'), '真·零阶段事件才进「未登记」');
}

if (fail) { console.error(`\n✗ closing-budget：${fail} 项失败`); process.exit(1); }
console.log('\n✓ closing-budget：全部通过（三段口径 / 三种缺失可区分 / 端到端点名）');
