// 波次聚类单测（SPEC §2.3 / §6-B1）：直接从 client.js 抽取 buildWaves 源码执行，
// 用真实 run 导出的夹具 regression.fixtures/waves.sample.json 断言 7 波 / 3,1,2,2,2,2,2 / 共 13 人。
//
// ⚠ 夹具**必须随仓提交**：这里原来读的是 `join(here, '..', '..', 'team', <run>/WAVES.sample.json)`，
// 也就是「包根往上两级的工作区里、作者本机那个真实 run」。该路径只在原始 monorepo 布局 + 作者机器上
// 存在；独立仓 / CI / 别人的机器上必然 ENOENT，而它是**硬抛错**，会打断整条 test:all
// （2026-09-14 CI 三档全红即此因）。夹具入库后，这个测试才真正自洽、可移植。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'client.js'), 'utf8');
const m = src.match(/var WAVE_GAP_MS = 1500[\s\S]*?\n    \}\n/);
if (!m) { console.error('✗ 未能从 client.js 抽取 buildWaves'); process.exit(1); }
const buildWaves = new Function(m[0] + '\n return buildWaves;')();

const fixturePath = join(here, 'regression.fixtures', 'waves.sample.json');
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));
// 夹具的 agents[] 就是该 run 的全部子代理（14 个）；notPartOfThisRun 里的 id 是别轮会话的前缀，不在 agents 内。
const people = fx.agents;
const r = buildWaves(people, fx._expected.waveGapMs);

let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' ≠ ' + JSON.stringify(want)}`);
}
check('波数', r.waves.length, fx._expected.waves);
check('每波人数', r.waves.map((w) => w.members.length), fx._expected.membersPerWave);
// 注意：夹具 _expected.total=13 与 membersPerWave 自身之和（3+1+2*5=14）矛盾，按可核验的
// membersPerWave 与其和断言（14），并把该不一致显式记下来（已告知 PM/留档）。
check('每波人数之和', r.waves.reduce((a, w) => a + w.members.length, 0), fx._expected.membersPerWave.reduce((a, b) => a + b, 0));
// 不因夹具笔误判失败：只报告（工件不改写，差异留档在 §94）
{
  const sum = fx._expected.membersPerWave.reduce((a, b) => a + b, 0);
  const mismatch = sum !== fx._expected.total;
  console.log(`  ${mismatch ? '⚠' : '✓'} 夹具 _expected.total=${fx._expected.total}，membersPerWave 之和=${sum}${mismatch ? '（夹具笔误：应为 14，见 §94）' : ''}`);
  check('子代理总数 == agents[] 长度', people.length, sum);
}
check('基准时间', r.base, fx._expected.startAt);
check('无时间戳人数', r.untimed.length, 0);
// 波内不得出现父子同波（派生≠并列）
let sameWaveParentChild = 0;
for (const w of r.waves) {
  const ids = new Set(w.members.map((p) => String(p.id)));
  for (const p of w.members) if (p.parentId && ids.has(String(p.parentId))) sameWaveParentChild++;
}
check('波内父子同波数', sameWaveParentChild, 0);
// 时间单调
const starts = r.waves.map((w) => w.startAt);
check('波起点单调递增', starts.every((v, i) => i === 0 || v > starts[i - 1]), true);
// 无时间戳 → 全部进 untimed，不伪造波次
const noTime = buildWaves(people.map((p) => ({ ...p, createdAt: 0 })));
check('无时间戳时不产生波', noTime.waves.length, 0);
check('无时间戳时全部进 untimed', noTime.untimed.length, people.length);
// 单波提示
const one = buildWaves(people.map((p) => ({ ...p, createdAt: 1789052788891, parentId: '' })));
check('同时刻 → 单波', one.waves.length, 1);
// ── SPEC §6 A4/A5 的数据层断言（渲染层断言需人工，这里锁住喂给渲染的波次结构）──
check('A4 不同波次带数 = 7（≠ leader 下一排）', r.waves.length, 7);
{
  const w1 = new Set(r.waves[0].members.map((p) => String(p.id)));
  const leak = r.waves[1].members.filter((p) => w1.has(String(p.id)));
  check('A5 第 2 波成员不出现在第 1 波', leak.length, 0);
  const deltas = r.waves.map((w) => Math.round((w.startAt - r.base) / 1000));
  check('A3 T+Δ 单调递增', deltas.every((v, i) => i === 0 || v > deltas[i - 1]), true);
  console.log('    T+Δ 序列:', JSON.stringify(deltas));
}
console.log(fail ? `\nFLOW WAVES: ${fail} 项失败` : '\nFLOW WAVES PASSED ✔');
process.exit(fail ? 1 : 0);
