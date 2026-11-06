// 测试：振荡守卫（C 线第 16 项的收窄版，"A→B→A→B"）
//
// 边界（本测试的核心价值就是把边界钉死）：
//   · **只管振荡**，不管"同工具重复调用"—— 后者由宿主 `@deepseek-ai/dsh-repeat-tool-reminder`
//     在 dsh-base 里默认覆盖（thresholds [3,5,8]）；重写它就是造轮子。
//   · **只对会改内容的工具（write/edit）记链，且四次必须指向同一个文件**。
//     反例（第一版会误报、被本测试抓住）：`编辑 a.js` / `编辑 b.js` 交替是**正常干活**；
//     `read a.js` / `read b.js` 交替同理。误报会把守卫变成噪声，而噪声门禁 = 没有门禁。
//   · **只认紧邻的 a b a b**，不做模糊匹配。
//   · **签名纪律**：宿主签名是 `(exec, result, next)`；`next` 不是函数时降级为"不干涉"，任何参数个数都不许抛错。
//     （2026-09-12 事故：签名写错一位 ⇒ 宿主每一次工具调用都被打红，整个会话工具链瘫痪。）
//   · 工具自身失败时不插嘴（不拿无关理由掩盖真错因）；同一对每 agent 只提醒一次。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M102**。
// 运行：node loop-guard.test.mjs

import { callKey, createLoopGuard, oscillationPair, sortDeep, trackedPath } from './lib/loop-guard.js';
import { DEFAULT_BUDGET_THRESHOLDS, budgetNotice, budgetNoticeMessage, createLeadBudget } from './lib/lead-budget.js';

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const AGENT = { session: { id: 'a1' } };
const exec = (name, args = {}, agent = AGENT) => ({ name, arguments: args, agent });
const accept = async () => ({ kind: 'accept' });
/** 振荡样例：**同一个文件**上用两种不同内容来回覆盖（真正的"两方案互斥"）。 */
const flipA = (file = 'src/app.js', agent = AGENT) => exec('edit', { file_path: file, old_string: 'a', new_string: 'PLAN_A' }, agent);
const flipB = (file = 'src/app.js', agent = AGENT) => exec('edit', { file_path: file, old_string: 'a', new_string: 'PLAN_B' }, agent);

console.log('① 纯函数：身份归一化与振荡判定');
check(callKey(exec('edit', { a: 1, b: 2 })) === callKey(exec('edit', { b: 2, a: 1 })), '对象键序不同 ⇒ 同一身份（深键序排序）');
check(callKey(exec('edit', { a: 1 })) !== callKey(exec('write', { a: 1 })), '工具名不同 ⇒ 不同身份');
check(JSON.stringify(sortDeep({ b: [2, { y: 1, x: 0 }], a: 1 })) === JSON.stringify({ a: 1, b: [2, { x: 0, y: 1 }] }), 'sortDeep 递归且数组保序');

const K1 = 'k1', K2 = 'k2', K3 = 'k3';
check(oscillationPair([K1, K1, K1]) === null, '三条相同 ⇒ 不是振荡（那是宿主那份的活）');
check(oscillationPair([K1, K2, K1, K2]) !== null, 'a b a b ⇒ 判定振荡');
check(oscillationPair([K3, K2, K1, K2, K1, K2]) !== null, '只看尾部四条 ⇒ 仍判定振荡');
check(oscillationPair([K1, K2, K2, K2]) === null, 'a b b b ⇒ 不是振荡');
check(oscillationPair([K1, K2, K3, K1, K2]) === null, 'a b c a b ⇒ 不是振荡（非紧邻交替）');
check(oscillationPair([K1, K1, K1, K1]) === null, 'a a a a ⇒ 不是振荡');
check(oscillationPair([]) === null && oscillationPair([K1, K2]) === null, '序列太短 ⇒ 不判');
check(oscillationPair([K1, K2, K1, K2]) === oscillationPair([K2, K1, K2, K1]), '同一对的两个方向 ⇒ 同一个 pair key');

console.log('\n② trackedPath：只认会改内容的工具');
check(trackedPath(exec('edit', { file_path: 'a.js' })) === 'a.js', 'edit 参与记链');
check(trackedPath(exec('write', { file_path: 'a.js' })) === 'a.js', 'write 参与记链');
check(trackedPath(exec('read', { file_path: 'a.js' })) === null, 'read 不参与（读两个文件交替是正常干活）');
check(trackedPath(exec('bash', { command: 'ls' })) === null, 'bash 不参与');

console.log('\n③ 签名契约（错一位 = 全工具瘫痪）');
{
  const g = createLoopGuard({});
  check(g.length === 3, '声明为 (exec, result, next) 三个参数', `length=${g.length}`);
  const shapes = [
    ['只传 exec', [flipA()]],
    ['exec + 非函数 next', [flipA(), {}]],
    ['exec + result + 非函数 next', [flipA(), {}, 'nope']],
    ['多传第 4 个', [flipA(), {}, accept, 'extra']],
  ];
  let threw = null;
  for (const [label, args] of shapes) {
    try { const out = await g(...args); if (!out || typeof out.kind !== 'string') threw = `${label}: 返回形状不对`; }
    catch (e) { threw = `${label}: 抛错 ${e && e.message}`; }
  }
  check(threw === null, '任何参数个数形态都不抛错', threw || `${shapes.length} 种形态`);
}

console.log('\n④ 同一文件上两方案来回 ⇒ 阻断 + 收口指令');
{
  const g = createLoopGuard({});
  const r1 = await g(flipA(), {}, accept);
  const r2 = await g(flipB(), {}, accept);
  const r3 = await g(flipA(), {}, accept);
  check(r1.kind === 'accept' && r2.kind === 'accept' && r3.kind === 'accept', 'A→B→A 还不到判定点（不早报）');
  const r4 = await g(flipB(), {}, accept); // 现在是 A B A B
  check(r4.kind === 'block', '第四条（A B A B）⇒ 阻断');
  const txt = JSON.stringify(r4.feedback);
  check(/振荡/.test(txt) && /停止切换/.test(txt), '反馈说明"检测到振荡"并给出"停止切换"的指令');
  check(/共同根因/.test(txt) && /停下来给结论/.test(txt), '反馈给出"退一步找根因"与"给结论"两条出路（对齐 Qoder 的硬停文案）');
}

console.log('\n⑤ 误报防线：正常干活一律放行');
{
  // ⚠️ 本组就是第一版的误报现场：不同文件交替、读类交替
  const g = createLoopGuard({});
  const k = [];
  for (const e of [flipA('src/a.js'), flipB('src/b.js'), flipA('src/a.js'), flipB('src/b.js')]) {
    k.push((await g(e, {}, accept)).kind);
  }
  check(k.every((x) => x === 'accept'), '两个不同文件交替编辑 ⇒ **全部放行**（正常干活）');

  const g2 = createLoopGuard({});
  const reads = [exec('read', { file_path: 'a.js' }), exec('read', { file_path: 'b.js' })];
  const k2 = [];
  for (const e of [reads[0], reads[1], reads[0], reads[1]]) k2.push((await g2(e, {}, accept)).kind);
  check(k2.every((x) => x === 'accept'), '两个文件交替读 ⇒ 全部放行');

  const g3 = createLoopGuard({});
  const same = exec('edit', { file_path: 'src/x.js', old_string: 'a', new_string: 'b' });
  const k3 = [];
  for (let i = 0; i < 4; i += 1) k3.push((await g3(same, {}, accept)).kind);
  check(k3.every((x) => x === 'accept'), '同工具同参数重复 4 次 ⇒ 全部放行（不抢宿主那份的职责）');

  const g4 = createLoopGuard({});
  const C = exec('edit', { file_path: 'src/c.js', old_string: 'a', new_string: 'C' });
  const k4 = [];
  for (const e of [flipA(), flipB(), C, flipA(), flipB()]) k4.push((await g4(e, {}, accept)).kind);
  check(k4.every((x) => x === 'accept'), 'A→B→C→A→B 不判振荡（非紧邻交替）');

  const g5 = createLoopGuard({ enabled: false });
  const k5 = [];
  for (const e of [flipA(), flipB(), flipA(), flipB()]) k5.push((await g5(e, {}, accept)).kind);
  check(k5.every((x) => x === 'accept'), 'enabled:false ⇒ 完全放行（可配置）');
}

console.log('\n⑥ 不越界：失败不插嘴 / 每对只报一次 / agent 隔离 / 自身抛错不红');
{
  const g = createLoopGuard({});
  await g(flipA(), {}, accept); await g(flipB(), {}, accept); await g(flipA(), {}, accept);
  const rErr = await g(flipB(), { isError: true }, accept);
  check(rErr.kind === 'accept', '工具已失败 ⇒ 不插嘴（不掩盖真错因）');

  const r4 = await g(flipB(), {}, accept);
  check(r4.kind === 'block', '恢复成功后仍然会判');
  const r5 = await g(flipA(), {}, accept);
  const r6 = await g(flipB(), {}, accept);
  check(r5.kind === 'accept' && r6.kind === 'accept', '同一对不再重复提醒（避免变成噪声）');

  const g2 = createLoopGuard({});
  const other = { session: { id: 'a2' } };
  const k = [];
  for (const e of [flipA('src/app.js', other), flipB('src/app.js', other), flipA('src/app.js', other), flipB('src/app.js', other)]) {
    k.push((await g2(e, {}, accept)).kind);
  }
  check(k[3] === 'block', '另一个 agent 自己的链独立判定');

  const boom = createLoopGuard({ onEvent: () => {}, makeFeedback: () => { throw new Error('boom'); } });
  await boom(flipA(), {}, accept); await boom(flipB(), {}, accept); await boom(flipA(), {}, accept);
  const rBoom = await boom(flipB(), {}, accept);
  check(rBoom.kind === 'accept', '守卫自身抛错 ⇒ 不能把工具调用变红');

  const g3 = createLoopGuard({});
  const noAgent = (e) => ({ name: e.name, arguments: e.arguments });
  const kk = [];
  for (const e of [noAgent(flipA()), noAgent(flipB()), noAgent(flipA()), noAgent(flipB())]) {
    kk.push((await g3(e, {}, accept)).kind);
  }
  check(kk.every((x) => x === 'accept'), '没有 agent 的调用不记链（无法归因）');
}

// ── lead 步数预算（成本治理 · 2026-11）：循环次数就是费用 ─────────────────────────
{
  console.log('\n# lead 步数预算（提醒式，不阻断）');
  check(JSON.stringify(DEFAULT_BUDGET_THRESHOLDS) === '[200,600,1200]',
    '阈值 = 200 / 600 / 1200（升序、可审计）', JSON.stringify(DEFAULT_BUDGET_THRESHOLDS));
  check(budgetNotice(199) === null, '未到阈值 ⇒ 不提醒');
  const n1 = budgetNotice(200);
  check(n1 && n1.level === 0 && /派给对应角色/.test(n1.text), '到 200 ⇒ 一级提醒（把读/改/跑派出去）', n1 && n1.summary);
  const n2 = budgetNotice(600);
  check(n2 && n2.level === 1 && /收敛范围/.test(n2.text), '到 600 ⇒ 二级提醒（先收敛范围）', n2 && n2.summary);
  const n3 = budgetNotice(1200);
  check(n3 && n3.level === 2 && /立即收尾/.test(n3.text), '到 1200 ⇒ 三级提醒（立即收尾、交给用户）', n3 && n3.summary);
  // 与宿主的提醒同族：必须是 form:'notice' 的 user 消息，而不是普通用户发言。
  const msg = budgetNoticeMessage(n1, 'id-1');
  check(msg.role === 'user' && msg.source && msg.source.form === 'notice' && msg.source.kind === 'expert-team-budget',
    '提醒消息走宿主的 `form:notice` 通道（不是"假装用户说话"）', JSON.stringify(msg.source));
  check(Array.isArray(msg.content) && msg.content[0].type === 'text' && msg.content[0].text === n1.text, '消息正文 = 提醒文案');
}

{
  const events = [];
  const budget = createLeadBudget({ onEvent: (e) => events.push(e) });
  const lead = (n) => ({ agent: { session: { id: 'lead-1', header: { delegationDepth: 0 } } }, name: 'read', arguments: { file_path: 'x' } });
  const role = () => ({ agent: { session: { id: 'role-1', header: { delegationDepth: 1 } } }, name: 'bash', arguments: { command: 'x' } });

  check(budget.observe(lead(), 'run-A') === null, '第 1 次调用不提醒');
  check(budget.observe(role(), 'run-A') === null && budget.countOf('run-A') === 1,
    '角色子代理（depth≥1）不计数（否则分不清谁在烧钱）', String(budget.countOf('run-A')));
  check(budget.observe(lead(), '') === null && budget.countOf('run-A') === 1, '没有 run 归属的会话不计数（普通会话不打扰）');

  // 推到阈值：只在该次返回一次，重复同一阈值不再返回。
  let hit = null;
  for (let i = 0; i < 199; i += 1) { const x = budget.observe(lead(), 'run-A'); if (x) hit = x; }
  check(hit && hit.count === 200 && hit.level === 0, '第 200 次返回一级提醒', JSON.stringify(hit && { count: hit.count, level: hit.level }));
  check(budget.observe(lead(), 'run-A') === null, '同一阈值只提醒一次（噪声 = 没有门禁）');
  check(events.length === 1 && events[0].type === 'budget:lead-calls' && events[0].runId === 'run-A',
    '命中阈值会发 `budget:lead-calls` 事件（浮层可见）', JSON.stringify(events));

  check(budget.countOf('run-B') === 0, '不同 run 各自计数');
  budget.reset('run-A');
  check(budget.countOf('run-A') === 0, 'reset 清空该 run（/team clear 之类可调）');

  // 有界：杀进程级别的长跑也不会让 Map 无限增长。
  const small = createLeadBudget({ maxRuns: 2 });
  small.observe(lead(), 'r1'); small.observe(lead(), 'r2'); small.observe(lead(), 'r3');
  check(small._runs.size === 2 && !small._runs.has('r1'), 'run 计数表有界（淘汰最老的）', String(small._runs.size));

  // 守卫自身绝不能让工具调用变红：坏 exec 一律吞掉。
  const boom = createLeadBudget({ onEvent: () => { throw new Error('boom'); } });
  let threw = false;
  try { boom.observe(null, 'r'); boom.observe({ get agent() { throw new Error('x'); } }, 'r'); } catch { threw = true; }
  check(!threw, '坏输入/事件回调抛错 ⇒ 吞掉而不是让工具变红');
}

{
  // 接线锚点：光有纯函数、没人调用 = 功能没上线（本仓既有纪律）。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./lib/command.js', import.meta.url), 'utf8');
  check(src.includes("from './lead-budget.js'"), 'command.js 引入了 lead-budget');
  check(/ctx\.on\('tools\/post-execute'[\s\S]{0,400}leadBudget\.observe\(/.test(src), '在 post-execute 上真的调用了 observe');
  check(/additionalContexts: \[budgetNoticeMessage\(/.test(src), '命中后把提醒塞进 additionalContexts（模型可见、非阻断）');
  check(src.includes('sessionRunFor(sid)'), '只对**有 run 归属**的会话计数');
}

if (fail) { console.error(`\n✗ loop-guard：${fail} 项失败`); process.exit(1); }
console.log('\n✓ loop-guard：全部通过');
