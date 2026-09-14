// 测试：角色三源合并（修掉「22 个活子代理未匹配到角色」）
//
// 用户实测报障（截图）：面板底部列出「另有 22 个活子代理未匹配到角色（prompt 无角色标识）」。
//
// 根因（两半）：
//   ① host 侧 `roleOfSub` 依赖 `label` / 括号角色 id / 首条 prompt —— 而 **workflow 派生的子代理
//      descriptor label 为空**，子会话日志又常经 seam 读不到 ⇒ 解析不出角色；
//   ② 客户端只按 `members[role].id` 建索引判定"未匹配"，对这批子代理必然落空，且文案把原因
//      断言成「prompt 无角色标识」（其实是未知）。
//
// 修法：新增**第三源** —— 对话流 workflow 卡上每个成员是有 label 的（`publishWfPhases` 收了
// `m.label`），据 `childId → label → 角色` 补解析；并把文案改准。
//
// 本测试沿用本仓范式：从 `client.js` 抽源码 + `new Function` 执行。
// 变异验证：见 `regression.fixtures/mutations.json` 的 M14。
// 运行：node role-merge.test.mjs

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

// ── 抽取：var WF_ROLE_WORDS … function resolveAgentRoles(…){…} ──
const s0 = src.indexOf('var WF_ROLE_WORDS');
const start = s0 >= 0 ? s0 : src.indexOf('function roleFromText(');
const ri = src.indexOf('function resolveAgentRoles(');
if (start < 0 || ri < 0) {
  console.error('✗ 未能从 client.js 抽取 roleFromText / resolveAgentRoles');
  process.exit(1);
}
let i = src.indexOf('{', ri), depth = 0, rend = -1;
for (let j = i; j < src.length; j += 1) {
  if (src[j] === '{') depth += 1;
  else if (src[j] === '}') { depth -= 1; if (depth === 0) { rend = j + 1; break; } }
}
const mod = new Function(`${src.slice(start, rend)}\n return { roleFromText: roleFromText, resolveAgentRoles: resolveAgentRoles };`)();
const { roleFromText, resolveAgentRoles } = mod;

console.log('# 角色三源合并（roleFromText / resolveAgentRoles）\n');

console.log('① roleFromText：括号角色 id 最权威');
check(roleFromText('你是「专家团」的产品分析员（product-analyst，动态补位角色）') === 'product-analyst', '括号里的 id 优先');
check(roleFromText('【架构】接口契约评审') === 'architect', '关键词命中「架构」');
check(roleFromText('[调研] 官方 agent-team 全貌') === 'researcher', '关键词命中「调研」');
check(roleFromText('产品分析：收益成本评级') === 'product-analyst', '动态角色先于 pm（「产品分析」不被「产品经理」抢）');
check(roleFromText('') === '', '空文本 → 空');
check(roleFromText('完全无关的一段话') === '', '无关键词 → 空（不臆造）');

console.log('\n② 三源优先级：members 权威 → agents[].role → workflow 卡 label');
{
  const roles = ['researcher', 'backend'];
  const members = { researcher: { id: 'sub-M', active: true } };
  const agentsLive = [{ id: 'sub-M', role: 'backend' }, { id: 'sub-A', role: 'backend' }];
  const r = resolveAgentRoles(members, roles, agentsLive, null);
  check(r.byRole.researcher === 'sub-M', 'members 权威优先（不被 agents[].role 抢）');
  check(r.byRole.backend === 'sub-A', 'members 没有时用 agents[].role');
}

console.log('\n③ 【本次新增】workflow 卡 label 兜底 —— 修掉那 22 个"无角色"');
{
  const roles = ['researcher', 'architect'];
  const agentsLive = [{ id: 'sub-W1' }, { id: 'sub-W2' }];   // host 解析不出角色 ⇒ role 为空
  const wfPhases = { phases: [
    { key: 'research', members: [{ childId: 'sub-W1', label: '[调研] 官方 agent-team 全貌', status: 'done' }] },
    { key: 'design', members: [{ childId: 'sub-W2', label: '【架构】差异对照矩阵', status: 'done' }] },
  ] };
  const r = resolveAgentRoles({}, roles, agentsLive, wfPhases);
  check(r.byRole.researcher === 'sub-W1', '从 workflow 卡 label 解析出 researcher', String(r.byRole.researcher));
  check(r.byRole.architect === 'sub-W2', '从 workflow 卡 label 解析出 architect', String(r.byRole.architect));
  check(r.unmatched.length === 0, '两个子代理都不再落进「未匹配」', JSON.stringify(r.unmatched.map((x) => x.id)));
  check(r.dispatched === 2, 'dispatched 计到 2（旧实现只数 members ⇒ 恒 0）', String(r.dispatched));
}

console.log('\n④ 仍解析不出时**如实**留在 unmatched（不臆造）');
{
  const r = resolveAgentRoles({}, ['researcher'], [{ id: 'sub-X' }], { phases: [{ members: [{ childId: 'sub-X', label: '无关键词的标题' }] }] });
  check(r.unmatched.length === 1 && r.unmatched[0].id === 'sub-X', '无角色线索 → 仍列进 unmatched');
  check(Object.keys(r.byRole).length === 0, '不为它编造角色');
}

console.log('\n⑤ 同一 childId 只被一个角色认领（不重复计数）');
{
  const agentsLive = [{ id: 'sub-Y' }];
  const wfPhases = { phases: [{ members: [{ childId: 'sub-Y', label: '[调研] x' }] }] };
  const r = resolveAgentRoles({}, ['researcher', 'qa'], agentsLive, wfPhases);
  check(r.byRole.researcher === 'sub-Y' && r.byRole.qa === undefined, '只被首个匹配角色认领');
  check(r.dispatched === 1, 'dispatched = 1');
}

console.log('\n⑥ 健壮性：畸形 data 形状**不得抛错**（该函数在面板渲染路径上，抛错=浮层白屏）');
const bad = [
  ['全 null', [null, null, null, null]],
  ['全 undefined', [undefined, undefined, undefined, undefined]],
  ['members 是数组', [[], ['pm'], [{ id: 'x' }], { phases: 'nope' }]],
  ['phases 是字符串', [{}, ['pm'], [{ id: 'a', role: 'pm' }], { phases: '不是数组' }]],
  ['phases.members 是字符串', [{}, ['pm'], [{ id: 'a' }], { phases: [{ members: 'x' }] }]],
  ['members[role] 是字符串', [{ pm: 'str' }, ['pm'], [{ id: 'a', role: 'pm' }], null]],
  ['roles 是字符串', [{}, 'pm', [{ id: 'a', role: 'pm' }], null]],
];
for (const [name, args] of bad) {
  let ok = true, msg = '';
  try { const r = resolveAgentRoles.apply(null, args); ok = !!(r && Array.isArray(r.unmatched)) } catch (e) { ok = false; msg = String(e && e.message) }
  check(ok, name + ' → 安全降级', msg);
}
check(roleFromText(null) === '' && roleFromText(123) === '', 'roleFromText 对非字符串安全');

console.log('\n⑦ 未匹配 ≠ 解析不出：同角色的重复派工必须与"真没角色"分开统计');
{
  // 实测本会话：30 个活子代理 / 14 个角色 —— 一个角色只展示 1 个成员，
  // 所以"未匹配"里绝大多数是**已知角色的重复 leg**。把整批说成"未能解析出角色"是错的。
  const roles = ['researcher', 'reviewer'];
  const agents = [
    { id: 'r1', role: 'researcher' }, // 被角色认领
    { id: 'r2', role: 'researcher' }, // 重复 leg（角色已知）
    { id: 'r3', role: 'reviewer' },   // 被角色认领
    { id: 'r4', role: 'qa' },         // 角色已知，但名册里没有 qa
    { id: 'x1', role: '' },           // 真的解析不出
    { id: 'x2' },                     // 真的解析不出
  ];
  const r = resolveAgentRoles({}, roles, agents, null);
  check(r.unmatched.length === 4, '未匹配 4 个', String(r.unmatched.length));
  check(r.roleless.length === 2, '其中"真没角色"只有 2 个（x1/x2）', String(r.roleless.length));
  check(r.roleless.every((a) => !a.role), 'roleless 里不得混入有角色的');
  check(r.extraByRole.researcher === 1 && r.extraByRole.qa === 1, '重复 leg 按角色计数：researcher×1 / qa×1', JSON.stringify(r.extraByRole));
  check(!('reviewer' in r.extraByRole), '已被认领的角色不进重复计数');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 角色合并测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 角色合并测试通过（members→agents.role→workflow label 三源；解析不出仍如实列出）');
