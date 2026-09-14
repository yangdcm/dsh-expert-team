// 测试：METRICS 的「未闭环」单独记账（C 线 · 减返工第二步）
//
// 为什么需要：返工率只统计"返工"，**不统计"没交付完"**。一次真实会话被用户中途叫停后，
// 账面上写着 9 completed / 4 failed / 2 cancelled / 1 pending，而"最后两处收紧只有实现者自证、
// 没有独立复验"这件事**在任何指标里都看不见** —— 只看到"返工率不高"。
// 对标的 Qoder 九样本里也有完全同形的现象：某会话结束时仍有 3 项被审查标为「必修」的缺陷未闭环，
// 完全不计入返工率（`docs/Qoder对标/08-九样本返工相关性.md` §3.4）。
//
// 本测试断言 METRICS 有三项独立账目，且**不改动返工率分子**：
//   ① 未终态任务（pending / claimed / in_progress / rework / blocked）
//   ② 已取消任务
//   ③ 有修复但**无独立复验**（该 repair 之后没有任何已完成的质量任务覆盖到它的轮次）
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M98**。
// 运行：node closure-ledger.test.mjs

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

const root = await mkdtemp(join(tmpdir(), 'dsh-et-closure-'));
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
  agent: { session: { id: 'sess-closure-1', header: { cwd } }, followup: () => {} },
});
const runsIn = async () => (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const readMetrics = () => readFile(join(cwd, 'team', 'METRICS.md'), 'utf8');
/** 只取「未闭环」那一节（避免与别节的数字互相串扰）。 */
const closureSection = (m) => {
  const seg = m.split('## 未闭环（不计入返工率，但必须可见）')[1] || '';
  return seg.split('\n## ')[0];
};

console.log('# METRICS「未闭环」单独记账\n');

// ── ① 一个"跑完但没收口"的 run：非终态 + 取消 + 无独立复验的修复 ──
await cmd('未闭环目标');
const run = (await runsIn())[0];
await writeFile(join(cwd, 'team', run, 'TASKS.json'), JSON.stringify({
  tasks: [
    { id: 'B-01', owner: 'backend', kind: 'work', status: 'completed', round: 1, verdict: 'pass', dependsOn: [] },
    // 修复（round 3）之后再没有已完成的质量任务 ⇒ 无独立复验
    { id: 'B-08D', owner: 'backend', kind: 'repair', status: 'completed', round: 3, verdict: 'pass', dependsOn: ['B-01'] },
    // 被用户叫停的验证轮（round 3 取消）
    { id: 'B-11', owner: 'reviewer', kind: 'requirements', status: 'cancelled', round: 3, dependsOn: ['B-08D'] },
    { id: 'B-12', owner: 'qa', kind: 'verification', status: 'cancelled', round: 3, dependsOn: ['B-08D'] },
    // 非终态
    { id: 'B-06', owner: 'lead', kind: 'work', status: 'in_progress', round: 1, dependsOn: ['B-11'] },
  ],
}, null, 2));
await cmd('learn');
let m = await readMetrics();
let sec = closureSection(m);

console.log('① 小节必须存在且有独立标题');
check(m.includes('## 未闭环（不计入返工率，但必须可见）'), 'METRICS 有「未闭环」小节');
check(sec.includes('不进返工率分子'), '小节自述"不进返工率分子"（口径不混淆）');

console.log('\n② 三项账目各自列出');
check(/未终态任务（pending \/ claimed \/ in_progress \/ rework \/ blocked）：\*\*1\*\*/.test(sec), '未终态任务 = 1（B-06）', (sec.match(/- 未终态任务[^\n]*/) || [''])[0]);
check(/已取消任务：\*\*2\*\*/.test(sec), '已取消任务 = 2（B-11 / B-12）', (sec.match(/- 已取消任务[^\n]*/) || [''])[0]);
check(/有修复但\*\*无独立复验\*\*（[^）]*）：\*\*1\*\*/.test(sec), '无独立复验的修复 = 1（B-08D）', (sec.match(/- 有修复但[^\n]*/) || [''])[0]);
check(/B-08D/.test(sec), '列出具体任务 id（可追溯，不是只有数字）');

console.log('\n②′ 取消必须可解释（主动砍范围 vs 中途烂尾是两件事）');
{
  // 该 run 的 STATE.json 里**没有**范围决策 ⇒ 必须显式提示"未记录原因"
  check(/未记录取消原因/.test(sec), '无范围决策记录时，显式标 ⚠️ 未记录取消原因');
  // 补上范围决策后 ⇒ 必须把原因打出来（实测例子：竞品分析 run 的 7 个取消任务写着「本轮不写业务代码」）
  const stPath = join(cwd, 'team', run, 'STATE.json');
  const st = JSON.parse(await readFile(stPath, 'utf8'));
  st.scopeDecision = { at: '2026-09-12T00:00:00.000Z', deliverableShape: '只做分析与方案，本轮不写业务代码' };
  await writeFile(stPath, JSON.stringify(st, null, 2));
  await cmd('learn');
  sec = closureSection(await readMetrics());
  check(/按记录的范围决策取消/.test(sec) && /本轮不写业务代码/.test(sec), '有范围决策记录时，把原因原文打出来', (sec.match(/按记录的范围决策取消[^\n]*/) || [''])[0].trim().slice(0, 80));
  check(!/未记录取消原因/.test(sec), '有记录后不再报"未记录原因"');
}

console.log('\n③ 有独立复验的修复**不得**被误报');
{
  await cmd('已复验目标');
  const runs2 = await runsIn();
  const run2 = runs2.find((x) => x !== run);
  await writeFile(join(cwd, 'team', run2, 'TASKS.json'), JSON.stringify({
    tasks: [
      { id: 'B-08A', owner: 'backend', kind: 'repair', status: 'completed', round: 2, verdict: 'pass', dependsOn: [] },
      // 同一轮（round 2）已完成的质量任务 ⇒ 覆盖到它 ⇒ 不算未复验
      { id: 'B-09', owner: 'reviewer', kind: 'requirements', status: 'completed', round: 2, verdict: 'pass', dependsOn: ['B-08A'] },
    ],
  }, null, 2));
  await cmd('learn');
  m = await readMetrics();
  sec = closureSection(m);
  check(!/已复验目标[^\n]*B-08A/.test(sec), '有同轮已完成质量任务覆盖的修复 ⇒ 不进「无独立复验」', sec.match(/- 有修复但[^\n]*/) ? (sec.match(/- 有修复但[^\n]*/) || [''])[0].slice(0, 90) : '（该账目为空）');
}

console.log('\n④ 未闭环不得改变返工率分子（两件事分开读）');
{
  const rateLine = (m.match(/返工\/失败率：[^\n]*/) || [''])[0];
  check(/返工\/失败率：/.test(rateLine), '返工率行仍在', rateLine);
  check(/分母是「有日志的 run」/.test(rateLine), '返工率分母口径未变');
}

if (fail) { console.error(`\n✗ closure-ledger：${fail} 项失败`); process.exit(1); }
console.log('\n✓ closure-ledger：全部通过');
