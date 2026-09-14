// 测试：返工的**性质分解**（C 线第 15 项）
//
// 为什么需要：返工率把"环境/平台故障"与"团队过程问题"混在同一个分子里，
// 于是"过程改好了没有"看不出来（本仓实测最高频的环境类是 `error:external-write ×9` —— 另一个进程改了同一文件）。
// 但**把它们剔除出分子**又会让数字与历史不可比 —— 所以本包的做法是：
//   **不改那个率，只做性质分解**（四桶合计 = 有日志的 run 数）。
//
// 本测试钉住两条：
//   ① 四桶判定正确（仅环境 / 仅过程 / 两者都有 / 无证据）；未列出的错误族**必须算过程类**（宁可算过程，不放过）。
//   ② **分解不得改动返工率本身**（环境类 run 仍然计入分子 —— 否则就是把"美化指标"写进代码）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M101**。
// 运行：node rework-nature.test.mjs

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-et-nature-'));
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
const cmd = (rawInput) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-nature-1', header: { cwd } }, followup: () => {} },
});
const runsIn = async () => (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const readMetrics = () => readFile(join(cwd, 'team', 'METRICS.md'), 'utf8');
const natureLine = (m) => (m.match(/- 返工性质分解[^\n]*/) || [''])[0];
const rateLine = (m) => (m.match(/返工\/失败率：[^\n]*/) || [''])[0];

/** 造一个 run：tasks 决定过程类，logLines 决定环境类。 */
async function makeRun(goal, { tasks = [], logLines = [] } = {}) {
  await cmd(goal);
  const names = await runsIn();
  const name = names.find((x) => x.includes(goal.slice(0, 6))) || names[names.length - 1];
  await writeFile(join(cwd, 'team', name, 'TASKS.json'), JSON.stringify({ tasks }, null, 2));
  if (logLines.length) {
    await writeFile(join(cwd, 'team', name, 'RUN.log.md'), logLines.join('\n') + '\n');
  }
  return name;
}

console.log('# 返工性质分解\n');

// ① 仅环境类：RUN.log 只有 error:external-write，没有任何过程类证据
await makeRun('仅环境目标', { tasks: [{ id: 'T-1', owner: 'backend', kind: 'work', status: 'completed', round: 1, verdict: 'pass' }], logLines: ['- [10:00:00] run:started — 开始', '- [10:01:00] error:external-write — 另一进程改了同一文件'] });
// ② 仅过程类：有 repair 任务，日志无 error
await makeRun('仅过程目标', { tasks: [{ id: 'T-1', owner: 'backend', kind: 'work', status: 'completed', round: 1, verdict: 'pass' }, { id: 'repair-1', owner: 'backend', kind: 'repair', status: 'completed', round: 2, verdict: 'pass', dependsOn: ['T-1'] }] });
// ③ 两者都有：既有环境 error，也有 repair
await makeRun('两者都有目标', { tasks: [{ id: 'repair-2', owner: 'backend', kind: 'repair', status: 'completed', round: 2, verdict: 'pass' }], logLines: ['- [10:00:00] error:external-write — 并发写入'] });
// ④ 无返工证据：干净 run（连 RUN.log 都没有 ⇒ sawLog=false ⇒ 不进四桶分母）
await makeRun('无证据目标', { tasks: [{ id: 'T-9', owner: 'backend', kind: 'work', status: 'completed', round: 1, verdict: 'pass' }] });

await cmd('learn');
let m = await readMetrics();
let line = natureLine(m);
console.log('① 四桶判定');
check(/仅环境\/平台 \*\*1\*\*/.test(line), '仅环境/平台 = 1（error:external-write）', line.slice(0, 120));
check(/仅过程（质量环\/角色\/台账） \*\*1\*\*/.test(line), '仅过程 = 1（repair 任务）');
check(/两者都有 \*\*1\*\*/.test(line), '两者都有 = 1');
check(/无返工证据 \d+ 个/.test(line), '无返工证据桶存在');

console.log('\n② 未列出的错误族必须算**过程类**（宁可算过程，不放过）');
{
  await makeRun('未知错误族目标', { tasks: [{ id: 'T-1', owner: 'backend', kind: 'work', status: 'completed', round: 1, verdict: 'pass' }], logLines: ['- [10:00:00] error:some-brand-new-family — 未知族'] });
  await cmd('learn');
  m = await readMetrics();
  line = natureLine(m);
  check(/仅过程（质量环\/角色\/台账） \*\*2\*\*/.test(line), '未知错误族 → 计入过程类（不是环境类）', line.slice(0, 120));
  check(!/仅环境\/平台 \*\*2\*\*/.test(line), '未知族**不得**被算成环境类');
}

console.log('\n③ 分解**不得**改动返工率本身（否则就是把"美化指标"写进代码）');
{
  // 环境类那三个 run 仍然计入分子：1 仅环境 + 1 仅过程 + 1 两者 + 1 未知族 = 4 个有返工的 run
  const rate = rateLine(m);
  const num = Number((rate.match(/=\s*(\d+)\/(\d+)/) || [])[1]);
  check(num >= 4, '返工率分子包含环境类 run（未被剔除）', rate);
}

console.log('\n④ 口径自述必须写明"不改那个率"与"用户新需求无法自动识别"');
check(/不改上面那个率/.test(m), '自述"不改上面那个率"');
check(/用户新需求导致的重做.*无法自动识别/s.test(m) || /无法自动识别/.test(m), '自述"用户新需求重做无法自动识别"（诚实边界）');
check(/未列出的错误族一律算过程类/.test(m), '自述"未列出的族一律算过程类"');

if (fail) { console.error(`\n✗ rework-nature：${fail} 项失败`); process.exit(1); }
console.log('\n✓ rework-nature：全部通过');
