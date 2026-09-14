// 测试：全景图分层（用户给出参考图，要求「Lead→成员的多层卡片 + 曲线连线」那种全景图）
//
// 用户报障形态：任务人员流转视图退化成一条竖直列表，顶部写着
//   「⚠ 无创建时间记录，无法分批（已按角色分组展示）」
//
// 根因：分层的**唯一**依据是 `createdAt`，而 **workflow 派生的子代理没有会话 header**，
// host 只能拿到 0。实测本会话 30 个子代理**全部**为 0 ⇒ `buildWaves` 判为无法分批。
//
// 修法：`enrichPeopleTiming(people, wfChildren)` 用**父会话事件流**的真实墙钟时间补齐——
// `tool-workflow/agent-start` 实测同一次扇出内 Δ≤1ms、扇出之间 ~25s，正好是 WAVE_GAP_MS
// (1500ms) 要的切分粒度。**拿不到就保持 0**，绝不按数组下标合成时间戳（那是把"不知道"
// 伪装成"知道"）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M19 / M20。
// 运行：node panorama.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = await readFile(join(here, 'client.js'), 'utf8');

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 抽取 buildWaves + enrichPeopleTiming（沿用本仓「抽源码 + new Function」范式）──
function sliceFn(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) { console.error(`✗ 未能从 client.js 抽取 ${name}`); process.exit(1); }
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
  }
  console.error(`✗ ${name} 花括号不平衡`); process.exit(1);
}
const wv = src.indexOf('var WAVE_GAP_MS');
const mv = src.indexOf('var MAX_WAVES');
const start = wv >= 0 ? wv : mv;
if (start < 0) { console.error('✗ 找不到 WAVE_GAP_MS'); process.exit(1); }
const code = [
  src.slice(start, src.indexOf('\n', mv >= 0 ? mv : start)),
  sliceFn('buildWaves'),
  sliceFn('enrichPeopleTiming'),
].join('\n');
const mod = new Function(`${code}\n return { buildWaves: buildWaves, enrichPeopleTiming: enrichPeopleTiming, WAVE_GAP_MS: WAVE_GAP_MS };`)();
const { buildWaves, enrichPeopleTiming, WAVE_GAP_MS } = mod;

console.log('# 全景图分层（enrichPeopleTiming → buildWaves）\n');

console.log('① 三源：header 优先，其次事件流，都没有就保持 0（不臆造）');
{
  const people = [
    { id: 'a', role: 'pm', createdAt: 5000 },                    // header
    { id: 'b', role: 'qa', createdAt: 0 },                       // → event
    { id: 'c', role: 'docs', createdAt: undefined },             // → event
    { id: 'd', role: 'sec', createdAt: 0 },                      // → none
  ];
  const wf = { b: { startedAt: 7000, runId: 'r1', seq: 1, settled: true, outcome: 'completed' }, c: { startedAt: 9000, runId: 'r1', seq: 2, settled: false } };
  const r = enrichPeopleTiming(people, wf);
  const by = Object.fromEntries(r.people.map((p) => [p.id, p]));
  check(by.a.createdAt === 5000 && by.a.timeSource === 'header', 'header 最权威');
  check(by.b.createdAt === 7000 && by.b.timeSource === 'event', '缺 createdAt → 用事件流真实时间戳', String(by.b.createdAt));
  check(by.c.createdAt === 9000 && by.c.timeSource === 'event', 'undefined 也走事件流');
  check(by.d.createdAt === 0 && by.d.timeSource === 'none', '两源都没有 → 保持 0（不合成假时间戳）');
  check(r.used.header === 1 && r.used.event === 2 && r.used.none === 1, '使用来源计数正确', JSON.stringify(r.used));
}

console.log('\n② workflow 归属与**逐子代理结算态**透传（画布据此画中断红点）');
{
  const wf = { b: { startedAt: 7000, runId: 'r1', seq: 3, settled: false, phase: '复审', label: '[复审] x' } };
  const r = enrichPeopleTiming([{ id: 'b', createdAt: 0 }], wf);
  const p = r.people[0];
  check(p.runId === 'r1' && p.settled === false, 'runId 与 settled=false 被透传（未结算）');
  check(p.wfPhase === '复审' && p.wfLabel === '[复审] x', 'phase / label 透传（供 tooltip 与角色兜底）');
  const r2 = enrichPeopleTiming([{ id: 'z', createdAt: 0 }], null);
  check(r2.people[0].runId === undefined && r2.people[0].settled === undefined, '非 workflow 成员不凭空挂 runId/settled');
}

console.log('\n③ 关键断言：事件流时间戳让**参考图的分层**真正成立');
{
  // 实测形状：run1 的 3 个成员在 1ms 内一起起（并行扇出）；run2 在 ~25s 后
  const T0 = 1789052427587, T1 = T0 + 51000;
  const wf = {
    m1: { startedAt: T0 + 10069, runId: 'r1', seq: 1, settled: true },
    m2: { startedAt: T0 + 10070, runId: 'r1', seq: 2, settled: true },
    m3: { startedAt: T0 + 10070, runId: 'r1', seq: 3, settled: true },
    m4: { startedAt: T1, runId: 'r2', seq: 1, settled: false },
    m5: { startedAt: T1 + 1, runId: 'r2', seq: 2, settled: false },
  };
  const people = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({ id, role: 'qa', createdAt: 0 }));
  // 修复前：全部 createdAt=0 ⇒ 0 波（视图顶部那句「无创建时间记录，无法分批」）
  const before = buildWaves(people, WAVE_GAP_MS);
  check(before.waves.length === 0 && before.untimed.length === 5, '修复前：5 人全部 untimed ⇒ 无法分层（复现报障）', `waves=${before.waves.length}`);

  const timed = enrichPeopleTiming(people, wf);
  const after = buildWaves(timed.people, WAVE_GAP_MS);
  check(after.waves.length === 2, '修复后：分成 2 波（同一次扇出 1 波，25s 后另 1 波）', `waves=${after.waves.length}`);
  check(after.waves[0] && after.waves[0].members.length === 3, '第 1 波 = run1 的 3 个并行成员', String(after.waves[0] && after.waves[0].members.length));
  check(after.waves[1] && after.waves[1].members.length === 2, '第 2 波 = run2 的 2 个成员', String(after.waves[1] && after.waves[1].members.length));
  check(after.untimed.length === 0, '不再有 untimed（全景图不再是"一条链"）');
}

console.log('\n④ 健壮性：畸形输入不得抛错（该函数在面板渲染路径上）');
{
  const bad = [[null, null], [[], {}], [[{ id: 'a' }], 'not-an-object'], [[{ id: 'a' }], []], [undefined, undefined]];
  for (const [p, w] of bad) {
    let ok = true, msg = '';
    try { const r = enrichPeopleTiming(p, w); ok = !!(r && Array.isArray(r.people) && r.used) } catch (e) { ok = false; msg = String(e && e.message) }
    check(ok, `畸形输入 ${JSON.stringify(p)} / ${JSON.stringify(w)} → 安全降级`, msg);
  }
  check(enrichPeopleTiming([{ id: 'a', createdAt: -5 }], null).people[0].createdAt === 0, '负数时间戳视为无效 → 0');
}

console.log('\n⑤ 不破坏既有约定：原始 people 对象不被就地改写（纯函数）');
{
  const people = [{ id: 'a', createdAt: 0, role: 'pm' }];
  const r = enrichPeopleTiming(people, { a: { startedAt: 123, runId: 'r' } });
  check(people[0].createdAt === 0, '入参对象未被修改');
  check(r.people[0] !== people[0], '返回的是新对象');
  check(r.people[0].role === 'pm', '其余字段被完整带过来');
}

console.log('\n⑥ 画布宽度与「宽视图」开关（死按钮回归 —— 与 nativeWfOn 那次同一类坑）');
{
  // 实测：全屏画布下卡片被挤成一小撮、右侧大片空白。根因是 NODE_W 拿"侧栏宽度偏好 pw（默认 360）"
  // 当画布宽度算；而 `wideV`（宽视图按钮）当时**根本没接进宽度计算**，点了没有任何效果。
  const from = src.indexOf('var baseW = flowW');
  const to = src.indexOf('var levels = [', from);
  const block = (from >= 0 && to > from) ? src.slice(from, to) : '';
  check(!!block, '找到宽度计算块（baseW → NODE_W）');
  check(/wideV/.test(block), '「宽视图」(wideV) 必须真的参与宽度计算（否则是死按钮）', (block.match(/var maxNodeW = [^\n]*/) || [''])[0]);
  check(/flowW/.test(block), '宽度优先用**实测容器宽度** flowW，而不是侧栏偏好 pw', (block.match(/var baseW = [^\n]*/) || [''])[0].slice(0, 110));
  check(/viewMode/.test(block), '全屏画布(viewMode)有独立回退，不退回 360');
  // 实测容器宽度必须真的被测量（有 measure + resize 监听）
  check(/function measure\(\)/.test(src) && /addEventListener\('resize', measure\)/.test(src), '有实测容器宽度 + resize 重测');
  // 按钮必须与状态双向绑定（render 里读到 wideV，点击写 setWide）
  check(/wideV \? t\('窄视图'/.test(src) && /setWide\(!wideV\)/.test(src), '按钮文案与点击都绑定 wideV');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 全景图分层测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 全景图分层测试通过（事件流时间戳补全 createdAt；两源都无则如实保持未分层）');
