// 测试：任务绑定推断 + DAG 卡片「具体干了什么」（用户报障修复）
//
// 两处用户实测报障（截图）：
//   ① 面板里**每一个人都显示「未绑定任务」** —— 绑定只按 `task.agentId` 精确匹配，
//      而**真实 TASKS.json 不记录 agentId** ⇒ 恒不命中。
//   ② DAG 卡片只显示 `T-01 / 调研 · 调研员 · 通过` —— **任务标题只藏在 SVG <title> tooltip 里**，
//      卡片上看不到"具体干了什么"（对照图三：卡片直接显示任务内容）。
//
// 做法：把绑定推断抽成模块内**纯函数 `bindTaskFor`**（便于单测），DAG 卡片新增标题可见行。
// 本测试沿用本仓既有范式（`flow.test.mjs`）：从 `client.js` 抽取函数源码再 `new Function` 执行。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M13。
// 运行：node task-binding.test.mjs

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

// ── 抽取 bindTaskFor（纯函数）──
const start = src.indexOf('function bindTaskFor(');
if (start < 0) {
  console.error('✗ 未能从 client.js 抽取 bindTaskFor');
  process.exit(1);
}
let i = src.indexOf('{', start), depth = 0, end = -1;
for (let j = i; j < src.length; j += 1) {
  if (src[j] === '{') depth += 1;
  else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
}
const bindTaskFor = new Function(`${src.slice(start, end)}\n return bindTaskFor;`)();

console.log('# 任务绑定推断（bindTaskFor · 纯函数）\n');

const T = (id, owner, status, extra) => ({ id, owner, status, ...(extra || {}) });

console.log('① 权威绑定优先：agentId 精确命中时不走推断');
{
  const tasks = [
    T('T-01', 'researcher', 'completed'),
    T('T-09', 'researcher', 'completed', { agentId: 'sub-A' }),
  ];
  const inf = {};
  const got = bindTaskFor({ id: 'sub-A', role: 'researcher', activity: 'inactive' }, tasks, inf);
  check(got && got.id === 'T-09', 'agentId 命中优先', got && got.id);
  check(!inf['T-09'], '权威绑定**不**登记为推断');
}

console.log('\n② 无 agentId 时按「角色 + 状态亲和」推断（修掉"全员未绑定"）');
{
  const tasks = [T('T-01', 'researcher', 'completed'), T('T-02', 'backend', 'completed')];
  const inf = {};
  const got = bindTaskFor({ id: 'sub-B', role: 'researcher', activity: 'inactive' }, tasks, inf);
  check(got && got.id === 'T-01', '已结束成员 → 选同角色 completed', got && got.id);
  check(inf['T-01'] === 1, '登记为**推断**（UI 将显示 ~ 前缀）');
}

console.log('\n③ 在跑成员优先选 in_progress/claimed（状态亲和）');
{
  const tasks = [
    T('T-01', 'backend', 'completed'),
    T('T-05', 'backend', 'in_progress'),
  ];
  const inf = {};
  const got = bindTaskFor({ id: 'sub-C', role: 'backend', activity: 'running' }, tasks, inf);
  check(got && got.id === 'T-05', '在跑 → 选 in_progress（而非 completed）', got && got.id);
}

console.log('\n④ 同亲和度时取 round 更大（最近一轮）');
{
  const tasks = [
    T('repair-1', 'backend', 'completed', { round: 1 }),
    T('repair-2', 'backend', 'completed', { round: 2 }),
  ];
  const inf = {};
  const got = bindTaskFor({ id: 'sub-D', role: 'backend', activity: 'inactive' }, tasks, inf);
  check(got && got.id === 'repair-2', '取 round 更大的一轮', got && got.id);
}

console.log('\n⑤ 无候选/无角色时返回 null（此时才显示「未绑定任务」）');
{
  const tasks = [T('T-01', 'researcher', 'completed')];
  check(bindTaskFor({ id: 'x', role: '', activity: 'running' }, tasks, {}) === null, '无角色 → null');
  check(bindTaskFor({ id: 'y', role: 'frontend', activity: 'running' }, tasks, {}) === null, '无同角色任务 → null');
  check(bindTaskFor({ id: 'z', role: 'researcher', activity: 'inactive' }, [], {}) === null, '空任务表 → null');
}

console.log('\n⑥ DAG 卡片必须把「任务标题」放进**可见行**（不再只藏 tooltip）');
{
  // 断言渲染源码里存在把 title 写进 <text> 的行，而不是只写进 <title>。
  // 2026-09-11 起卡片多了一条**底部状态带**（图标 + 中文状态，见 dag-status.test.mjs），
  // 三行文字上移为 y=15/31/45、状态带占底部 15px —— 因此这里断言"语义"而不是钉死坐标。
  const hasTitleVar = /var title = String\(t\.title \|\| t\.spec/.test(src);
  const hasTitleText = /h\('text',[^)]*clipText\(title, \d+\)/.test(src);
  check(hasTitleVar && hasTitleText, '任务标题写进可见 <text> 行（clipText 截断）', hasTitleText ? '' : '未找到 clipText(title, N) 行');
  const hasMetaVar = /var metaLine = kindLabel\(t\.kind/.test(src);
  const hasMetaText = /h\('text',[^)]*clipText\(metaLine, \d+\)/.test(src);
  check(hasMetaVar && hasMetaText, 'kind·owner·verdict 作为辅助行渲染', hasMetaText ? '' : '未找到 clipText(metaLine, N) 行');
  check(/className: 'exp-node-status'/.test(src), '底部状态带把中文状态写在卡上（明显的状态展示）');
  check(/NODE_H = 64/.test(src), '节点高度已放大以容纳三行 + 状态带', (src.match(/NODE_H = \d+/) || [''])[0]);
  check(typeof src.match(/function clipText/) === 'object', '存在 SVG 文本截断助手 clipText');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 绑定/卡片测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 绑定/卡片测试通过（无 agentId 也能绑定且标注为推断；标题进入可见行）');
