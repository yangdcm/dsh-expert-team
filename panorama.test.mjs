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

// ═══════════════════════════════════════════════════════════════════════════════
// ⑦ 新画布（专家团）分层 / 列 / 边 —— canvasLayers / canvasColumns / canvasEdges
//    canvasBlockedBy / canvasLayerTitle / roleAvatarColor / roleAvatarSvg
//
// 症状（"能红"的那一面）：服务端**没有** `layer`/层次字段，`dependsOn` 是 string[]，
//   `usingLiveTasks` 时任务来自 tasksLive 投影、**完全没有 dependsOn**。于是分层只能在前端算，
//   而分层一旦写错（最短路径 / 把环塞进某层 / 同层边照画 / 无依赖时编造多层 / 就地改写 status）
//   全是**静默错**：画面照样出来，只是顺序和因果骗人。本节每条断言都钉在一个"会写错的具体点"上。
//
// 变异对应（逐条见交付报告）：最短路径 → ② 红；环上任务按 level 塞进 layers → 成环断言红；
//   canvasBlockedBy 的 `!== 'completed'` 写成 `=== 'completed'` → ④ 红（红/绿互换）；
//   同层边不判同层直接进 edges → ⑤ 红；无 dependsOn 仍编造多层 → ⑥ 红。
console.log('\n⑦ 新画布：分层按**最长路径**，环/未知依赖如实分区，同层边不画只计数，无依赖只给单列');
{
  // ── 沙箱：只抽**已落盘的 `function name(...)` 声明**（本仓范式；没有声明就如实报失败）──
  let missingFn = '';
  function sliceFnC(name) {
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) { missingFn = missingFn || name; return ''; }
    let i = src.indexOf('{', at), depth = 0;
    for (let j = i; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
    }
    missingFn = missingFn || `${name}(花括号不平衡)`;
    return '';
  }
  // 外层函数 + 它们真正用到的同文件 helper/常量（都按名抽取 ⇒ 测的是真实源码）
  const NEED = ['etcHslHex', 'arrOf', 'canvasLayers', 'canvasBlockedBy', 'canvasLayerTitle', 'canvasColumns',
    'canvasEdges', 'canvasFormation', 'roleAvatarColor', 'roleAvatarSvg'];
  const parts = NEED.map(sliceFnC).filter(Boolean);
  const etcShapeAt = src.indexOf('var ETC_ROLE_SHAPE =');
  const etcHueAt = src.indexOf('var ETC_ROLE_HUES =');
  const etcConsts = (etcShapeAt >= 0 && etcHueAt >= 0)
    ? src.slice(etcShapeAt, src.indexOf('\n', etcHueAt)) : '';
  let canvas = null, why = '';
  let S = null, P = null;   // stub 与 Proxy 要跨出 try（⑩ 的渲染沙箱复用同一套）
  if (missingFn) why = `client.js 里缺 function ${missingFn}`;
  else {
    try {
      S = {
        h: (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat(Infinity).filter((x) => x != null && x !== false) }),
        t: (zh) => zh, langNow: 'zh',
        esc: (s) => String(s == null ? '' : s),
        own: (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k),
        // 纯显示层 helper 用 stub（渲染断言只钉"胶囊文案 / 队长长"，不依赖角色译名）：
        roleLabel: (r) => r,
        clipText: (v, maxUnits) => { const x = String(v == null ? '' : v); return x.length > maxUnits ? x.slice(0, Math.max(0, maxUnits - 1)) + '…' : x; },
        kindLabel: (k) => k,
      };
      // 只读代理：源码里用到、而这里没显式列出的**小 helper** 兜底 undefined，
      // 免得一个显示层 helper 改名把整节变成 ReferenceError（那是"测不出来"，不是"发现问题"）。
      // 注意：必须先给**真全局**（Array/Number/String/Math…）兜底 —— 一律返回 undefined
      // 会把全局内建一起挡掉，于是每条断言都以 TypeError 变红（harness 坏了，不是实现坏了）。
      P = new Proxy(S, {
        has: () => true,
        get: (t, k) => (k === Symbol.unscopables ? undefined
          : (k in t ? t[k] : (typeof globalThis[k] !== 'undefined' ? globalThis[k] : undefined))),
      });
      canvas = new Function('S', 'with (S) {\n' + etcConsts + '\n' + parts.join('\n')
        + '\nreturn { canvasLayers: canvasLayers, canvasBlockedBy: canvasBlockedBy, canvasLayerTitle: canvasLayerTitle, canvasColumns: canvasColumns, canvasEdges: canvasEdges, canvasFormation: canvasFormation, roleAvatarColor: roleAvatarColor, roleAvatarSvg: roleAvatarSvg };\n}')(P);
    } catch (e) { why = `沙箱求值失败：${e && e.message}`; }
  }
  check(!!canvas, '能按名抽取并求值新画布函数（canvasLayers 等）', why || NEED.length + ' 个');
  if (!canvas) {
    console.log(`\n✗ 全景图分层测试失败：${fail} 项（新画布函数未落盘 ⇒ 本节全部无法运行）`);
    process.exit(1);
  }
  const { canvasLayers, canvasBlockedBy, canvasLayerTitle, canvasColumns, canvasEdges, canvasFormation, roleAvatarColor, roleAvatarSvg } = canvas;
  /** 每条断言都套 try/catch：函数对畸形输入抛错要算"红"，不能把测试进程带崩。 */
  const safeCheck = (name, fn) => {
    try { const r = fn(); check(r.ok, name, r.detail); }
    catch (e) { check(false, name, `抛错：${e && e.message}`); }
  };
  const flat = (r) => (r.layers || []).reduce((a, L) => a.concat(L || []), []);
  const lvlOf = (r, id) => (r.level || {})[id];
  const inLayers = (r, id) => flat(r).some((t) => t && String(t.id) === id);

  console.log('  ── ①分层：链 ⇒ 3 层；②菱形 ⇒ D 在 maxLayer（**最长路径**，不是最短） ──');
  safeCheck('链 A→B→C：3 层，level 0/1/2，maxLayer=2', () => {
    const A = { id: 'A', status: 'completed', dependsOn: [] };
    const B = { id: 'B', status: 'pending', dependsOn: ['A'] };
    const C = { id: 'C', status: 'pending', dependsOn: ['B'] };
    const r = canvasLayers([A, B, C]);
    return {
      ok: r.layers.length === 3 && r.maxLayer === 2
        && lvlOf(r, 'A') === 0 && lvlOf(r, 'B') === 1 && lvlOf(r, 'C') === 2
        && r.hasDeps === true,
      detail: `layers=${r.layers.length} maxLayer=${r.maxLayer} level=${JSON.stringify(r.level)}`,
    };
  });
  safeCheck('菱形 D→{B,C}→A：D 在 maxLayer（最长路径；最短路径会把它排到第 2 层）', () => {
    const A = { id: 'A', status: 'completed', dependsOn: [] };
    const B = { id: 'B', status: 'done', dependsOn: ['A'] };
    const C = { id: 'C', status: 'in_progress', dependsOn: ['A'] };
    const D = { id: 'D', status: 'pending', dependsOn: ['B', 'C'] };
    const E = { id: 'E', status: 'pending', dependsOn: [] };
    const r = canvasLayers([A, B, C, D, E]);
    return {
      ok: lvlOf(r, 'D') === 2 && r.maxLayer === 2 && lvlOf(r, 'B') === 1 && lvlOf(r, 'C') === 1 && lvlOf(r, 'E') === 0
        && (r.layers[r.maxLayer] || []).some((t) => String(t.id) === 'D'),
      detail: `D=${lvlOf(r, 'D')} maxLayer=${r.maxLayer} level=${JSON.stringify(r.level)}`,
    };
  });

  console.log('  ── 成环：函数必须**返回**，且不许把环上任务塞进任何一层 ──');
  safeCheck('A↔B：cycles 含 A、B；三层断言：flat(layers) 里既无 A 也无 B（NEGATIVE：不许塞进某层）', () => {
    const A = { id: 'A', status: 'pending', dependsOn: ['B'] };
    const B = { id: 'B', status: 'pending', dependsOn: ['A'] };
    const r = canvasLayers([A, B]);
    const cy = (r.cycles || []).map(String).slice().sort().join(',');
    return {
      ok: cy === 'A,B' && flat(r).length === 0 && !inLayers(r, 'A') && !inLayers(r, 'B'),
      detail: `cycles=[${cy}] flat(layers)=${flat(r).length} inLayers(A)=${inLayers(r, 'A')} inLayers(B)=${inLayers(r, 'B')}`,
    };
  });
  safeCheck('canvasEdges：环成员之间的边**只计数不画**（cycles=2、edges=0，函数必须返回）', () => {
    const A = { id: 'A', status: 'pending', dependsOn: ['B'] };
    const B = { id: 'B', status: 'pending', dependsOn: ['A'] };
    const e = canvasEdges([A, B]);
    return { ok: e.cycles === 2 && e.edges.length === 0, detail: `cycles=${e.cycles} edges=${JSON.stringify(e.edges)}` };
  });

  console.log('  ── 未知依赖：记下来，但该任务**仍被分层**（不崩、不消失）──');
  safeCheck("dependsOn:['nope']：unknownDeps 含 {from:'X',to:'nope'}，且 X 仍在某一层里", () => {
    const r = canvasLayers([{ id: 'X', status: 'pending', dependsOn: ['nope'] }]);
    const u = (r.unknownDeps || []).find((d) => d && String(d.from) === 'X' && String(d.to) === 'nope');
    return {
      ok: !!u && inLayers(r, 'X') && lvlOf(r, 'X') === 0,
      detail: `unknownDeps=${JSON.stringify(r.unknownDeps)} inLayers(X)=${inLayers(r, 'X')} level(X)=${lvlOf(r, 'X')}`,
    };
  });
  safeCheck('独立计数：未知依赖 ≤ edges、cycles=0、skippedSameLayer=0（不许静默丢也不许乱算）', () => {
    const a1 = { id: 'A1', status: 'pending', dependsOn: ['B1'] };
    const b1 = { id: 'B1', status: 'pending', dependsOn: ['A1'] };
    const x = { id: 'X', status: 'pending', dependsOn: ['nope'] };
    const e = canvasEdges([a1, b1, x]);
    return { ok: e.cycles === 2 && e.unknownDeps === 1 && e.edges.length <= e.unknownDeps, detail: `cycles=${e.cycles} unknownDeps=${e.unknownDeps} edges=${JSON.stringify(e.edges)}` };
  });

  console.log('  ── ④派生受阻：completed/done 不挡，其余挡；且**不改写原 task.status** ──');
  safeCheck('canvasBlockedBy：A completed ⇒ 空；A in_progress ⇒ 含 A', () => {
    const t = { id: 'T', status: 'pending', dependsOn: ['A'] };
    const byDone = canvasBlockedBy(t, { A: { id: 'A', status: 'completed' }, T: t });
    const byRun = canvasBlockedBy(t, { A: { id: 'A', status: 'in_progress' }, T: t });
    return { ok: byDone.length === 0 && byRun.includes('A'), detail: `completed→[${byDone}] in_progress→[${byRun}]` };
  });
  safeCheck('NEGATIVE canvasBlockedBy 是纯函数：不改写原 task（JSON.stringify 前后比对）', () => {
    const t = { id: 'T', status: 'pending', dependsOn: ['A', 'B'] };
    const before = JSON.stringify(t);
    const byId = { A: { id: 'A', status: 'completed' }, B: { id: 'B', status: 'in_progress' }, T: { id: 'T', status: 'pending', dependsOn: ['A', 'B'] } };
    const r = canvasBlockedBy(t, byId);
    return {
      ok: JSON.stringify(t) === before && r.includes('B') && !r.includes('A'),
      detail: `before=${before} after=${JSON.stringify(t)} blocked=[${r}]`,
    };
  });

  console.log('  ── ⑤同层边：进 skippedSameLayer（不画但计数）──');
  // 关于"同层互赖"：`skippedSameLayer` 的判据是 `lt <= lf`（或 level 未定义），而**自洽的 DAG 里
  // 下游层次必然严格大于上游** ⇒ 我穷举 4 节点全部 531441 个依赖图 + 随机 20 万个 5 节点图，
  // `skippedSameLayer` 全为空（详见交付报告）。所以这条只能钉**可证伪的邻接不变量**：
  //   ① 被跳过的边绝不进 edges；② edges ∪ skipped == 真实存在且两端都非环的依赖边（逐条比对）。
  // 若有人把"同层判定"删掉（同层边照画 / 反向边照画），②立刻不成立 ⇒ 红。
  safeCheck('同层边不画：skipped 与 edges 不重叠，且 edges 恰为"两端都非环"的依赖边（逐条比对）', () => {
    const A = { id: 'A', status: 'done', dependsOn: [] };
    const B = { id: 'B', status: 'pending', dependsOn: ['A'] };
    const E = { id: 'E', status: 'pending', dependsOn: ['A', 'B'] };   // 与 B 同层（1）
    const F = { id: 'F', status: 'pending', dependsOn: ['A', 'B', 'E'] }; // 2 层
    const CY1 = { id: 'CY1', status: 'pending', dependsOn: ['CY2'] };
    const CY2 = { id: 'CY2', status: 'pending', dependsOn: ['CY1'] };
    const CY3 = { id: 'CY3', status: 'pending', dependsOn: ['CY2'] };
    const tasks = [A, B, E, F, CY1, CY2, CY3];
    const L = canvasLayers(tasks);
    const e = canvasEdges(tasks);
    const onCycle = new Set((L.cycles || []).map(String));
    const byId = new Set(tasks.map((t) => t.id));
    const want = [];
    for (const t of tasks) {
      for (const d of (t.dependsOn || [])) {
        if (!byId.has(d) || d === t.id) continue;        // 未知依赖 / 自环不算边
        if (onCycle.has(d) || onCycle.has(t.id)) continue; // 指向环 / 环成员出发：不画
        if (L.skippedSameLayer.some((x) => x.from === d && x.to === t.id)) continue;
        want.push(`${d}->${t.id}`);
      }
    }
    const got = (e.edges || []).map((x) => `${x.from}->${x.to}`).sort();
    const sk = (L.skippedSameLayer || []).map((x) => `${x.from}->${x.to}`);
    const overlap = sk.filter((x) => got.includes(x));
    return {
      ok: JSON.stringify(got) === JSON.stringify(want.sort()) && overlap.length === 0
        && e.skippedSameLayer === sk.length
        && (L.cycles || []).map(String).sort().join(',') === 'CY1,CY2',
      detail: `level=${JSON.stringify(L.level)} cycles=[${(L.cycles || []).join(',')}] skipped=${JSON.stringify(sk)} edges=${JSON.stringify(got)} want=${JSON.stringify(want.sort())}`,
    };
  });

  console.log('  ── ⑥tasksLive 降级：完全没有 dependsOn ⇒ 单列（key=unknown，不分层）──');
  safeCheck('无 dependsOn：hasDeps/depsKnown=false + 单列 key=unknown + flat(layers).length===1', () => {
    const tasks = [
      { id: 'L1', status: 'done', owner: 'backend', title: 'x' },
      { id: 'L2', status: 'in_progress', owner: 'qa', title: 'y' },
      { id: 'L3', status: 'pending', owner: 'docs', title: 'z' },
    ];
    const r = canvasLayers(tasks);
    const cols = canvasColumns(tasks);
    const c0 = cols[0] || {};
    // 「依赖未知」标记：kind==='unknown' **或** key==='unknown'（两者等价，规范都接受）
    const markedUnknown = c0.kind === 'unknown' || c0.key === 'unknown';
    return {
      ok: r.hasDeps === false && r.maxLayer === 0 && r.layers.length === 1
        && cols.length === 1 && markedUnknown && c0.total === 3 && c0.done === 1,
      detail: `hasDeps=${r.hasDeps} layers=${r.layers.length} maxLayer=${r.maxLayer} cols=${cols.length} key=${c0.key} kind=${c0.kind} ${c0.done}/${c0.total}`,
    };
  });

  console.log('  ── ⑦列标题与计数 ──');
  safeCheck('canvasLayerTitle(0,2) 含「无依赖」；(2,2) 含「收尾」；(1,2) 含「第」', () => {
    const t0 = String(canvasLayerTitle(0, 2)), t1 = String(canvasLayerTitle(1, 2)), t2 = String(canvasLayerTitle(2, 2));
    return {
      ok: t0.includes('无依赖') && t2.includes('收尾') && t1.includes('第'),
      detail: `(0,2)=${t0} (1,2)=${t1} (2,2)=${t2}`,
    };
  });
  safeCheck('NEGATIVE canvasLayerTitle：0 层不写成「第 1 层/第 0 层」；maxLayer=0 时没有「收尾」', () => {
    const t0 = String(canvasLayerTitle(0, 2));
    const one = String(canvasLayerTitle(0, 0));
    return { ok: !/第\s*[01]\s*层/.test(t0) && !one.includes('收尾') && !/第\s*0\s*层/.test(one), detail: `(0,2)=${t0} (0,0)=${one}` };
  });
  safeCheck('canvasColumns：层列 kind=layer 且 done/total 正确；成环组 kind=cycle 且 done/total 正确', () => {
    const A = { id: 'A', status: 'done', dependsOn: [] };
    const B = { id: 'B', status: 'in_progress', dependsOn: ['A'] };
    const C = { id: 'C', status: 'pending', dependsOn: ['B'] };
    const D = { id: 'D', status: 'in_progress', dependsOn: ['C'] };
    const c1 = { id: 'CY1', status: 'pending', dependsOn: ['CY2'] };
    const c2 = { id: 'CY2', status: 'done', dependsOn: ['CY1'] };
    const cols = canvasColumns([A, B, C, D, c1, c2]);
    const layerCols = cols.filter((c) => c.kind === 'layer');
    const L0 = layerCols.find((c) => (c.tasks || []).some((t) => String(t.id) === 'A'));
    const cyCol = cols.find((c) => c.kind === 'cycle');
    const cyIds = cyCol ? (cyCol.tasks || []).map((t) => String(t.id)).sort().join(',') : '';
    const L2 = layerCols.find((c) => (c.tasks || []).some((t) => String(t.id) === 'D'));
    return {
      ok: layerCols.length === 4 && !!L0 && L0.done === 1 && L0.total === 1 && L0.blocked === 0
        && !!L2 && L2.done === 0 && L2.total === 1
        && cyIds === 'CY1,CY2' && cyCol.total === 2 && cyCol.done === 1
        && cols.every((c) => c.total === (c.tasks || []).length),
      detail: `layerCols=${layerCols.length} L2(done0/1)=${L2 ? `${L2.done}/${L2.total}` : '缺'} L0=${L0 ? `${L0.done}/${L0.total} blk=${L0.blocked}` : '缺'} cycle=${cyIds} ${cyCol ? `${cyCol.done}/${cyCol.total}` : '缺'}`,
    };
  });

  console.log('  ── ⑧角色徽章：真实色优先 / 同 role 恒同色 / 未知 role 不冒充已知 role ──');
  safeCheck("roleAvatarColor('backend','#123456')='#123456'（真实色优先）；fallback 为 null 时两次调用恒等", () => {
    const real = roleAvatarColor('backend', '#123456');
    const a = roleAvatarColor('backend', null);
    const b = roleAvatarColor('backend', null);
    const c = roleAvatarColor('backend', undefined);
    const isHex = (x) => typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x);
    return {
      ok: real === '#123456' && a === b && a === c && isHex(a) && !/^#[0-9a-fA-F]{3}$/.test(a),
      detail: `real=${real} null=${a}/${b} undefined=${c}`,
    };
  });
  safeCheck('NEGATIVE 未知 role：hash 稳定且与已知 role 不撞（不冒充已知角色色）', () => {
    const x1 = roleAvatarColor('nobody-at-all', null);
    const x2 = roleAvatarColor('nobody-at-all', null);
    const y = roleAvatarColor('another-unknown-role', null);
    const backend = roleAvatarColor('backend', null);
    return {
      ok: x1 === x2 && x1 !== backend && /^#[0-9a-fA-F]{6}$/.test(x1) && /^#[0-9a-fA-F]{6}$/.test(y),
      detail: `x=${x1}/${x2} y=${y} backend=${backend}`,
    };
  });
  const svgTexts = (n, out = []) => {
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
    if (n && n.kids) n.kids.forEach((k) => svgTexts(k, out));
    return out;
  };
  safeCheck("roleAvatarSvg：backend / 未知 role 都产出 svg 节点，带首字母与 title，且描边色=roleAvatarColor", () => {
    const s1 = roleAvatarSvg('backend', { size: 36, name: 'Sam', initial: 'S' });
    const s2 = roleAvatarSvg('xyz', { size: 36, initial: 'N' });
    const f1 = JSON.stringify(s1), f2 = JSON.stringify(s2);
    const col = roleAvatarColor('backend', null);
    return {
      ok: !!s1 && s1.tag === 'svg' && !!s2 && s2.tag === 'svg'
        && f1.includes('36') && f2.includes('36')
        && svgTexts(s1).includes('Sam') && svgTexts(s2).includes('N')
        && svgTexts(s2).includes('xyz') && f1.includes(col),
      detail: `tags=${s1 && s1.tag}/${s2 && s2.tag} texts1=${JSON.stringify(svgTexts(s1))} texts2=${JSON.stringify(svgTexts(s2))} color=${col}`,
    };
  });
  safeCheck("NEGATIVE roleAvatarSvg：已知 role 不吃 initial（靠图形区分）；未知 role 的 initial 被 slice 成 1 字符", () => {
    const s0 = roleAvatarSvg('backend');
    const sKnown = roleAvatarSvg('backend', { initial: 'bob' });
    const sUnknown = roleAvatarSvg('xyz', { initial: 'bob' });
    const t0 = svgTexts(s0);
    return {
      ok: !!s0 && s0.tag === 'svg' && !!sKnown && sKnown.tag === 'svg' && !!sUnknown && sUnknown.tag === 'svg'
        // 已知 12 角色用几何图形区分，不吃 initial（否则文字会盖住图形）
        && !svgTexts(sKnown).includes('B') && !svgTexts(sKnown).includes('BOB')
        // 未知角色才用首字母，且只取 1 个字符
        && svgTexts(sUnknown).includes('B') && !svgTexts(sUnknown).includes('BOB')
        // title 回落 role id 是**有意**的诚实兜底（画面上唯一出现 role 名的地方）
        && t0.includes('backend'),
      detail: `noOpts=${JSON.stringify(t0)} known(bob)=${JSON.stringify(svgTexts(sKnown))} unknown(bob)=${JSON.stringify(svgTexts(sUnknown))}`,
    };
  });

  console.log('  ── ⑨编队六态：待命(standby) vs 未启动(idle) —— 真实负载里 activity 是**空串** ──');
  // 报障（2026-09-16，用真实 /state 负载实测）：`members[role].activity` 是**空串**，而 backend
  // 名下 T1–T4 **四个任务都已 completed**。旧判据只看 activity ⇒ 把"已经干完 4 个活"的成员画成
  // 「未启动」——这是**假话**（不是"没有信息"，是与已知事实相反）。修法：`|| done > 0` 也算待命。
  const SIX_STATES = ['in_progress', 'claimed', 'running', 'standby', 'unresolved', 'idle'];
  const roleState = (members, agents, tasks, data) => {
    const f = canvasFormation(members, agents, tasks, data);
    return { f, by: Object.fromEntries(f.members.map((x) => [x.role, x])) };
  };
  safeCheck('正向：名下任务全 completed、无 in_progress/claimed、activity 空串 ⇒ standby「待命」（不得 idle「未启动」）', () => {
    const tasks = [{ id: 'T1', status: 'completed', owner: 'backend' }, { id: 'T2', status: 'done', owner: 'backend' }];
    const { by } = roleState({ backend: { name: 'Sam', color: '#8a7a3c', initial: 'S', activity: '', active: false, id: '' } }, [], tasks, {});
    const m = by.backend;
    return {
      ok: !!m && m.state.key === 'standby' && String(m.state.text).includes('待命') && m.state.warn === false && m.done === 2,
      detail: `key=${m && m.state.key} text=${m && m.state.text} warn=${m && m.state.warn} done=${m && m.done}`,
    };
  });
  safeCheck('NEGATIVE：名下**一个任务都没有**、activity 空串 ⇒ 必须是 idle「未启动」（防"一律待命"放宽）', () => {
    const { by } = roleState({ qa: { name: 'Tina', activity: '', active: false } }, [], [], {});
    const m = by.qa;
    return {
      ok: !!m && m.state.key === 'idle' && String(m.state.text).includes('未启动') && m.done === 0,
      detail: `key=${m && m.state.key} text=${m && m.state.text} done=${m && m.done}`,
    };
  });
  safeCheck('六态取值域：7 种输入各归其位，且产出的 key 全落在 6 个之内（unresolved 优先于 idle）', () => {
    const members = {
      run: { name: 'R', activity: 'running', active: true },
      sb: { name: 'S', activity: 'idle', active: true },
      unr: { name: 'U', activity: '', active: false },
      ex: { name: 'X', activity: '', active: true },
      cl: { name: 'C', activity: '', active: true },
      fin: { name: 'F', activity: '', active: false },
      none: { name: 'N', activity: '', active: true },   // membersUnresolved 下 active:true 不受影响 ⇒ idle
      weird: { name: 'W', activity: 'flying', active: true },
    };
    const tasks = [
      { id: 'X1', status: 'in_progress', owner: 'ex' },
      { id: 'X2', status: 'claimed', owner: 'cl' },
      { id: 'X3', status: 'completed', owner: 'fin' },
    ];
    const { f, by } = roleState(members, [], tasks, { membersUnresolved: true });
    const keys = f.members.map((x) => x.state.key);
    const bad = keys.filter((k) => SIX_STATES.indexOf(k) < 0);
    return {
      ok: by.run.state.key === 'running' && by.sb.state.key === 'standby'
        && by.unr.state.key === 'unresolved' && by.unr.state.warn === true
        && by.ex.state.key === 'in_progress' && String(by.ex.state.text).includes('X1')
        && by.cl.state.key === 'claimed' && String(by.cl.state.text).includes('X2')
        && by.fin.state.key === 'standby'
        // membersUnresolved && active!==true ⇒ unresolved；active:true 的成员不受该标记影响 ⇒ idle
        && by.none.state.key === 'idle' && by.none.state.warn === false
        // activity 取值在**已验证集合**（running/idle/ready/inactive/''）之外 ⇒ 不许当成"待命"，落未启动
        && by.weird.state.key === 'idle'
        && bad.length === 0,
      detail: `keys=${JSON.stringify(Object.fromEntries(f.members.map((x) => [x.role, x.state.key])))} 越界=${JSON.stringify(bad)}`,
    };
  });

  console.log('  ── ⑩队长：胶囊文案是 ASCII `team-lead`，渲染后**不得**出现「队长长」 ──');
  // 队长名字胶囊曾经写中文「队长」，紧挨着 `.etc-badges` 里的「长」徽章 ⇒ 视觉上读成「队长长」
  // （同一个意思说两遍）。改成渲染 `F.lead.label`（'team-lead'）后，徽章「长」仍然保留来源语义。
  safeCheck("canvasFormation().lead.label === 'team-lead'（ASCII，契约字段形状）", () => {
    const f = canvasFormation({}, [], [], {});
    const badges = (f.lead && f.lead.badges) || [];
    const texts = badges.map((b) => b.text);
    return {
      ok: f.lead.label === 'team-lead' && badges.length === 2
        && texts.includes('长') && texts.includes('本会话')
        && typeof f.lead.note === 'string',
      detail: `label=${f.lead.label} badges=${JSON.stringify(texts)}`,
    };
  });
  // 真渲染：用桩 hook 跑 canvasView（`useEffect` 不执行 ⇒ 依赖 DOM 测量的箭头自然是 0 条）
  let viewMod = null, viewWhy = '';
  try {
    const VIEW = ['phaseLabel', 'statusLabel', 'stLabel', 'stBadgeCls', 'canvasBarCls',
      'canvasMemberNode', 'canvasCardNode', 'canvasColNode', 'useCanvasEdges', 'canvasView'];
    const vparts = VIEW.map(sliceFnC).filter(Boolean);
    if (missingFn) viewWhy = `缺 function ${missingFn}`;
    else {
      const varSlice = (name) => {
        const at = src.indexOf(`var ${name} = `);
        if (at < 0) return '';
        let i = src.indexOf('=', at) + 1, d = 0;
        for (; i < src.length; i += 1) {
          const c = src[i];
          if (c === '{' || c === '[') d += 1;
          else if (c === '}' || c === ']') { d -= 1; if (d === 0) return src.slice(at, i + 1); }
          else if (c === '\n' && d === 0) return src.slice(at, i);
        }
        return src.slice(at, i);
      };
      // 同一套 stub，另加**桩 hook**（真 React 在 Node 里跑不了；`useEffect` 不执行 ⇒ 不量 DOM）
      S.useState = (v) => [v, () => {}];
      S.useEffect = () => {};
      S.useRef = (v) => ({ current: v === undefined ? null : v });
      S.useMemo = (fn) => fn();
      const consts = ['ETC_ROLE_SHAPE', 'ETC_ROLE_HUES', 'PHASE_ZH', 'STATUS_ZH'].map(varSlice).filter(Boolean).join('\n');
      viewMod = new Function('S', 'with (S) {\n' + consts + '\n' + parts.join('\n') + '\n' + vparts.join('\n')
        + '\nreturn { canvasView: canvasView, canvasFormation: canvasFormation };\n}')(P);
    }
  } catch (e) { viewWhy = `渲染沙箱求值失败：${e && e.message}`; }
  check(!!viewMod, 'canvasView 可抽取并求值（桩 hook）', viewWhy || `${9} 个依赖 + 桩 hook`);
  if (viewMod) {
    safeCheck("渲染后纯文本：名字胶囊 = 'team-lead'，全树不含「队长长」", () => {
      const tasks = [{ id: 'T1', title: '起点', status: 'completed', owner: 'backend', dependsOn: [] }];
      const members = { backend: { name: 'Sam', color: '#8a7a3c', initial: 'S', activity: '', active: false, id: '' } };
      const el = viewMod.canvasView({ tasks, members, agents: [], data: { phase: 'deliver', status: 'complete' }, selectedId: null, onPick: null });
      const collect = (n, pred, out = []) => {
        if (!n || typeof n !== 'object') return out;
        if (pred(n)) out.push(n);
        (n.kids || []).forEach((k) => collect(k, pred, out));
        return out;
      };
      const allTexts = (n, out = []) => {
        if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
        if (n && n.kids) n.kids.forEach((k) => allTexts(k, out));
        return out;
      };
      const names = collect(el, (n) => n.props && n.props.className === 'etc-name');
      const capsule = names.length ? allTexts(names[0]).join('') : '';
      const joined = allTexts(el).join('');
      // `.etc-name` 有两处：队长胶囊 + 每个成员的名字胶囊 ⇒ 不能断言"只有 1 个"
      const nameTexts = names.map((n) => allTexts(n).join(''));
      return {
        ok: nameTexts.includes('team-lead') && nameTexts.indexOf('队长') < 0
          && capsule === 'team-lead' && !joined.includes('队长长') && joined.includes('team-lead'),
        detail: `全部 .etc-name=${JSON.stringify(nameTexts)} 队长胶囊=${JSON.stringify(capsule)} 含队长长=${joined.includes('队长长')}`,
      };
    });
  } else {
    check(false, "渲染后纯文本：名字胶囊 = 'team-lead'，全树不含「队长长」", `无法渲染：${viewWhy}`);
  }
}

console.log('');
if (fail > 0) {
  console.log(`✗ 全景图分层测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 全景图分层测试通过（事件流时间戳补全 createdAt；两源都无则如实保持未分层）');
