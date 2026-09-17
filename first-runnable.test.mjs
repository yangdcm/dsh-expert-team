// 测试：E 线 **E1 · 首产物**（`first-runnable` 事件 → METRICS「首产物」节）
//
// 为什么需要（数据来源是一次真实 run 的定量体检，见 `docs/专家团-开发计划.md`）：
// 那次 run 从 `run:started` 到进 implement 花了 **2 小时 11 分**，期间**零可运行产物** ——
// 用户在接近 10 小时的等待里没有任何"能跑起来看看"的时刻。E1 把这件事变成**可机判的指标**：
// `first-runnable` 的时间戳 − `run:started` 的时间戳，渲染进 METRICS。
//
// 本测试钉住三件事：
//   ① **时钟算术**（`lib/metrics/timing.js`）—— 样本跨午夜（22:21:03 起、次日 08:15:30 收尾），
//      裸减会得到 **负数**；非法时间戳必须返回 `null` 而**不是 0**（当 0 = 把"没测到"读成"很快"）。
//   ② **三种零必须可区分**：`没登记` / `登记了但算不出` / `全部 ≤ 阈值` —— 合成一句就再也分不开
//      （本仓在撤销率上正是吃过这个亏，SG-4）。
//   ③ **端到端接线**：事件真的被 `aggregate` 读出来、算出来、渲染进 `METRICS.md`。
//      "函数写出来了但没人调用"是本仓已登记的病（D7），所以必须走一遍真实 `/team learn`。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M107**。
// 运行：node first-runnable.test.mjs

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clockSeconds, clockDeltaMinutes, medianLower, summarizeFirstRunnable } from './lib/metrics/timing.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# E 线 E1 · 首产物（first-runnable → METRICS）\n');

// ── ① 时钟算术：唯一一份（E2 复用），跨午夜与"算不出"都必须对 ──────────────────
console.log('① 时钟算术（`lib/metrics/timing.js`，E1/E2 共用）');
check(clockSeconds('22:21:03') === 80463, 'clockSeconds 基本解析', String(clockSeconds('22:21:03')));
check(clockDeltaMinutes('22:21:03', '00:32:30') === 131, '**跨午夜**：22:21:03 → 00:32:30 = 131 分钟（裸减会得 −1309）', String(clockDeltaMinutes('22:21:03', '00:32:30')));
check(clockDeltaMinutes('23:50:00', '00:10:00') === 20, '跨午夜：23:50:00 → 00:10:00 = 20 分钟');
check(clockDeltaMinutes('10:00:00', '10:08:00') === 8, '同日：8 分钟');
check(clockDeltaMinutes('10:00:00', '10:00:00') === 0, '同日同时刻 = 0 分钟（真的 0，与"算不出"的 null 不同）');
check(
  clockSeconds('now') === null && clockSeconds('25:00:00') === null && clockSeconds('12:60:00') === null && clockSeconds('') === null && clockSeconds(null) === null,
  '非法/越界时间戳一律 null（不猜、不截断）',
  [clockSeconds('now'), clockSeconds('25:00:00'), clockSeconds('12:60:00')].join('/'),
);
check(clockDeltaMinutes('now', '10:00:00') === null && clockDeltaMinutes('10:00:00', 'now') === null, '任一端算不出 ⇒ null（**不是 0**）');
check(medianLower([42, 5, 8]) === 8, '中位（奇数个取中）', String(medianLower([42, 5, 8])));
check(medianLower([5, 42]) === 5, '中位（偶数个取偏小，不平出 23.5 这种没人观测过的数）', String(medianLower([5, 42])));

// ── ② 三种形态的文案必须互不混淆 ────────────────────────────────────────────
console.log('\n② 三种零必须可区分（"没登记" / "登记了但算不出" / "很快"）');
const none = summarizeFirstRunnable({ samples: [], runsWithLogs: 2, unparsable: 0 });
check(none.includes('暂无 first-runnable 登记'), '零登记 → 占位句（不静默省略）');
check(none.includes('这不等于"首产物很快"'), '零登记时**显式否掉**"很快"的读法');
check(!none.includes('有登记 0'), '零登记时不会印出"有登记 0 … 最快 0 分钟"这种把没测到说成 0 的句式');
const bad = summarizeFirstRunnable({ samples: [], runsWithLogs: 2, unparsable: 2 });
check(bad.includes('2 个 run 写了') && bad.includes('算不出耗时'), '登记了但算不出 → 单独一行警示（不退化成 0、也不混进"未登记"一句话里）');
const mixed = summarizeFirstRunnable({ samples: [{ run: 'a', minutes: 8 }], runsWithLogs: 3, unparsable: 1 });
check(mixed.includes('有登记 1 / 有日志 3 个 run'), '分子分母一起渲染（不藏覆盖率）', (mixed.match(/有登记[^\n]*/) || [''])[0]);
check(mixed.includes('「未登记」1 个 run'), '未登记数 = 分母 − 算得出 − 算不出（1 = 3 − 1 − 1）');
const over = summarizeFirstRunnable({ samples: [{ run: 'x', minutes: 11 }, { run: 'y', minutes: 131 }], runsWithLogs: 2 });
check(over.includes('超阈值（> 10 分钟）：y（131 分钟）、x（11 分钟）'), '超阈值按**降序**点名（先看最慢的那个）', (over.match(/超阈值[^\n]*/) || [''])[0]);

// ── ③ 端到端：事件 → aggregate → METRICS.md ─────────────────────────────────
console.log('\n③ 端到端接线（真实 `/team learn`，不是直接调 renderMetrics）');
const root = await mkdtemp(join(tmpdir(), 'dsh-et-firstrunnable-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply } = await import(join(here, 'lib', 'command.js'));
let registered = null;
apply({
  commands: { register: (d) => { registered = d; } },
  on: () => {},
  get: () => undefined,
  inject: () => {},
});
const cmdIn = (rawInput, c = cwd) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-first-runnable', header: { cwd: c } }, followup: () => {} },
});
const dirsIn = async (c) => {
  try {
    return (await readdir(join(c, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
};
/** 新开一个 run 并返回其 runId（前后差集，不靠时间戳猜）。 */
const newRun = async (goal, c) => {
  const before = new Set(await dirsIn(c));
  await cmdIn(goal, c);
  return (await dirsIn(c)).find((x) => !before.has(x));
};
const writeLog = (run, lines) => writeFile(join(cwd, 'team', run, 'RUN.log.md'), ['# 运行日志（RUN.log）', '', ...lines, ''].join('\n'));

const ra = await newRun('跨午夜的 run', cwd);
const rb = await newRun('八分钟的 run', cwd);
const rc = await newRun('没登记的 run', cwd);
const rd = await newRun('时间戳不可解析的 run', cwd);
check(!!(ra && rb && rc && rd), '四个夹具 run 都建好了', [ra, rb, rc, rd].join(' / '));
await writeLog(ra, ['- [22:21:03] run:started — 目标=x', '- [00:32:30] first-runnable — `bash scripts/run.sh` → OK']);
await writeLog(rb, ['- [10:00:00] run:started — 目标=y', '- [10:08:00] first-runnable — `bash scripts/run.sh` → OK']);
await writeLog(rc, ['- [09:00:00] run:started — 目标=z', '- [09:30:00] phase:design — design (architect)']);
await writeLog(rd, ['- [now] run:started — 目标=w', '- [now] first-runnable — 骨架已跑']);
await cmdIn('learn');
const m = await readFile(join(cwd, 'team', 'METRICS.md'), 'utf8');

check(m.includes('## 首产物（首个可运行产物耗时）'), 'METRICS 出现「首产物」小节');
check(m.includes('有登记 2 / 有日志 4 个 run'), '有登记的 run 数与分母都渲染', (m.match(/- 首个可运行产物耗时[^\n]*/) || ['(未出现)'])[0]);
check(m.includes('中位 8 分钟 · 最快 8 分钟 · 最慢 131 分钟'), '跨午夜那个 run 被算成 131 分钟（不是负数、不是 0）');
check(m.includes(`超阈值（> 10 分钟）：${ra}（131 分钟）`), '超阈值的 run **点名**到具体 run', (m.match(/超阈值[^\n]*/) || ['(未出现)'])[0]);
check(/⚠️ 1 个 run 写了 `first-runnable` 但\*\*算不出耗时\*\*/.test(m), '`[now]` 那个 run 被单列为"算不出"（不等于 0，也不混进未登记）');
check(m.includes('「未登记」1 个 run'), '未登记数 = 4 − 2 − 1 = 1');
check(!/第一个可运行产物耗时[^\n]*runsWithLogs/.test(m) && !/\bundefined\b/.test(m) && !/\bNaN\b/.test(m), '渲染结果里没有 undefined / NaN');

// ④ 反向：一个 run 都没登记时渲染占位句（不静默省略、也不谎报"0 分钟"）
console.log('\n④ 反向：零登记时渲染占位句（不是一个好看的 0）');
const cwd2 = join(root, 'proj2');
await mkdir(cwd2, { recursive: true });
const re = await newRun('纯文档项目', cwd2);
await writeFile(join(cwd2, 'team', re, 'RUN.log.md'), ['# 运行日志（RUN.log）', '', '- [08:00:00] run:started — 目标=docs-only', '- [08:20:00] phase:deliver — 纯文档交付', ''].join('\n'));
await cmdIn('learn', cwd2);
const m2 = await readFile(join(cwd2, 'team', 'METRICS.md'), 'utf8');
check(m2.includes('（暂无 first-runnable 登记'), '零登记 → 占位句', (m2.match(/- （暂无 first-runnable[^\n]*/) || ['(未出现)'])[0]);
check(m2.includes('这不等于"首产物很快"'), '占位句里明确否掉"很快"的读法');

if (fail) { console.error(`\n✗ first-runnable：${fail} 项失败`); process.exit(1); }
console.log('\n✓ first-runnable：全部通过（时钟算术 / 三种零可区分 / 端到端接线）');
