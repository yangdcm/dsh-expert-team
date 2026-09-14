// 测试：C 线第 17 项 **派工即回写**（`lib/dispatch-ledger.js`）
//
// 背景：对照 Qoder，派工成功后由**服务端**自动置 `in_progress` + `owner`；我们这边全靠
// `SKILL.md §7.10` 的散文规则 + 模型自觉。而规则没被执行的后果是**用户看得见的**：
// `/team check` 与浮层红条会把"依赖已就绪却仍 pending"判为「状态冻结」违规。
//
// 本测试钉住两类事：
//   ① **纯函数口径**：只认已存在的任务 id（`T2` 不命中 `T24`）、只翻 `pending → in_progress`、
//      终态不动、别人正在做的不覆盖、`owner` 只在缺失时写、原数组不被改（纯）。
//   ② **监听器的安全边界**：派工失败不记账 / 没有标签不记账 / 定位不到 run 不记账 /
//      非派工工具不记账 / IO 抛错也必须放行（**监听器绝不允许成为工具调用的故障源**）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M112**。
// 运行：node dispatch-ledger.test.mjs

import { isDispatchTool, isWorkflowTool, labelsInWorkflowScript, taskIdsInLabel, planAutoClaim, createDispatchLedger } from './lib/dispatch-ledger.js';

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# C 线第 17 项 · 派工即回写\n');

console.log('① 只认派工工具（别的工具调用一律不碰台账）');
check(isDispatchTool('subagent_backend') && isDispatchTool('subagent') && isDispatchTool('subagent_qa'), '角色工具与通用 subagent 都算派工');
check(!isDispatchTool('subagentX') && !isDispatchTool('write') && !isDispatchTool('bash') && !isDispatchTool(''), '`subagentX` / write / bash / 空 都**不**算派工工具');
check(isWorkflowTool('workflow') && !isWorkflowTool('subagent_backend') && !isWorkflowTool('workflowX'), '`workflow` 单独识别（扇出多腿，走脚本解析而不是 `arguments.label`）');

console.log('\n② 从派工标签取任务 id：**只认已存在的 id + 词边界**');
check(taskIdsInLabel('【后端工程师】实现 T24', ['T24', 'T2']).join(',') === 'T24', '`T2` **不**命中 `T24`（词边界，不是子串）', taskIdsInLabel('【后端工程师】实现 T24', ['T24', 'T2']).join(','));
check(taskIdsInLabel('【后端工程师】实现 B4/B1', ['B1', 'B4', 'B10']).join(',') === 'B1,B4', '批量标签 `B4/B1` 命中两个（且不命中 `B10`）', taskIdsInLabel('【后端工程师】实现 B4/B1', ['B1', 'B4', 'B10']).join(','));
check(taskIdsInLabel('【测试员】补 repair-3 的复验', ['repair-3', 'repair-30']).join(',') === 'repair-3', '带连字符的 id（`repair-3` 不命中 `repair-30`）');
check(taskIdsInLabel('【审查官】复审', ['T1']).length === 0 && taskIdsInLabel('', ['T1']).length === 0, '标签里没有 id ⇒ 空数组（不猜）');
check(taskIdsInLabel('【后端工程师】实现 T99', ['T1']).length === 0, '**编造的 id**（不在台账里）⇒ 空数组（天然保守，不产生副作用）');
check(taskIdsInLabel('【后端工程师】实现 T1', ['T1', 'T1']).join(',') === 'T1', '重复已知 id 只出一次');

console.log('\n③ planAutoClaim：只翻 pending，绝不动终态与别人的活');
{
  const tasks = [
    { id: 'T1', owner: 'backend', status: 'pending' },
    { id: 'T2', status: 'pending' },
    { id: 'T3', owner: 'backend', status: 'completed' },
    { id: 'T4', owner: 'frontend', status: 'in_progress' },
    { id: 'T5', owner: 'backend', status: 'in_progress' },
    { id: 'T6', owner: 'frontend', status: 'pending' },
  ];
  const snapshot = JSON.stringify(tasks);
  const p = planAutoClaim({ tasks, ids: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'], role: 'backend', now: '2026-09-13T00:00:00.000Z' });
  check(JSON.stringify(tasks) === snapshot, '纯函数：原数组**一字未改**');
  check(p.next.find((t) => t.id === 'T1').status === 'in_progress', 'pending → in_progress');
  check(p.next.find((t) => t.id === 'T1').owner === 'backend', '已有 owner 与派工角色一致 ⇒ 保持');
  check(p.next.find((t) => t.id === 'T1').claimedAt === '2026-09-13T00:00:00.000Z', '写入 claimedAt（谁都能查"什么时候开始的"）');
  check(p.next.find((t) => t.id === 'T2').owner === 'backend', '本来没有 owner ⇒ 写入本次派工角色');
  check(p.next.find((t) => t.id === 'T3').status === 'completed', '终态（completed）**不动**');
  check(p.next.find((t) => t.id === 'T4').owner === 'frontend' && p.conflicts.some((c) => c.id === 'T4'), '别人正在做（frontend）⇒ **不覆盖**，只记一条冲突', JSON.stringify(p.conflicts));
  check(p.next.find((t) => t.id === 'T5').status === 'in_progress' && !p.conflicts.some((c) => c.id === 'T5'), '同角色再派一次（backend 已在做）⇒ 既不算冲突也不重复认领');
  check(p.next.find((t) => t.id === 'T6').status === 'in_progress' && p.next.find((t) => t.id === 'T6').owner === 'frontend', '已有**不同** owner 的 pending ⇒ 状态照翻，但 owner 保持原值（代码不改归属）');
  check(p.claimed.map((c) => c.id).join(',') === 'T1,T2,T6', 'claimed 只含真正被翻的', p.claimed.map((c) => c.id).join(','));
  check(p.skipped.join(',') === 'T3', 'skipped 记下"命中了但是终态"的', p.skipped.join(','));
  const p2 = planAutoClaim({ tasks: p.next, ids: ['T1', 'T2', 'T6'], role: 'backend', now: 'later' });
  check(p2.claimed.length === 0, '**幂等**：再跑一次不产生新的认领（否则每次派工都会重写一遍文件）');
  const p3 = planAutoClaim({ tasks: [{ id: 'X', status: 'pending' }], ids: ['X'], role: '', now: 't' });
  check(p3.next[0].status === 'in_progress' && !('owner' in p3.next[0]), '认不出角色（role 为空）⇒ 只翻状态，**不编造 owner**');
}

console.log('\n④ 监听器：写盘条件与"绝不影响工具调用"');
{
  const events = [];
  const writes = [];
  const mk = (over = {}) => createDispatchLedger({
    roleOfLabel: (l) => (/【后端工程师】/.test(l) ? 'backend' : ''),
    runFor: async () => ({ cwd: '/tmp/ws', runId: 'run-1' }),
    readTasks: async () => ({ tasks: [{ id: 'T24', status: 'pending' }, { id: 'T2', status: 'pending' }], rounds: { review: 1 } }),
    writeTasks: async (t, doc) => { writes.push({ runId: t.runId, doc }); },
    now: () => 'NOW',
    onEvent: (type, payload) => events.push({ type, payload }),
    ...over,
  });
  const call = async (fn, exec, result) => {
    let nextCalls = 0;
    const downstream = { kind: 'accept', tag: 'downstream' };
    const out = await fn(exec, result, async () => { nextCalls += 1; return downstream; });
    return { out, nextCalls, downstream };
  };

  const good = await call(mk(), { name: 'subagent_backend', arguments: { label: '【后端工程师】实现 T24' } }, { ok: true });
  check(writes.length === 1, '派工成功 + 标签有 id ⇒ 写盘一次', String(writes.length));
  check(good.out === good.downstream && good.nextCalls === 1, '**放行**：把下游决策原样返回（不改变工具结果）');
  check(writes[0].doc.tasks.find((t) => t.id === 'T24').status === 'in_progress', '被认领的任务已置 in_progress');
  check(writes[0].doc.tasks.find((t) => t.id === 'T24').owner === 'backend', 'owner 来自标签里的角色（host 那份中文标签表）');
  check(writes[0].doc.tasks.find((t) => t.id === 'T2').status === 'pending', '标签里没提到的任务**一个都没碰**');
  check(writes[0].doc.rounds && writes[0].doc.rounds.review === 1, 'TASKS.json 的其它键（rounds）原样保留');
  check(events.some((e) => e.type === 'dispatch-ledger-claimed'), '认领有可观测事件（"门禁被行使"看得见）');

  const cases = [
    ['派工**失败**（isError）⇒ 不记账（没派出去就不该显示"在做"）', () => call(mk(), { name: 'subagent_backend', arguments: { label: '【后端工程师】实现 T24' } }, { isError: true })],
    ['没有 label ⇒ 不记账', () => call(mk(), { name: 'subagent_backend', arguments: {} }, { ok: true })],
    ['定位不到 run ⇒ 不记账（绝不猜工作区里最新那个）', () => call(mk({ runFor: async () => null }), { name: 'subagent_backend', arguments: { label: '【后端工程师】实现 T24' } }, { ok: true })],
    ['非派工工具（write）⇒ 不记账', () => call(mk(), { name: 'write', arguments: { label: '【后端工程师】实现 T24' } }, { ok: true })],
    ['标签里全是台账里没有的 id ⇒ 不记账', () => call(mk(), { name: 'subagent_backend', arguments: { label: '【后端工程师】实现 T99' } }, { ok: true })],
    ['任务已是 in_progress（同角色）⇒ 无变化 ⇒ **不写盘**', () => call(mk({ readTasks: async () => ({ tasks: [{ id: 'T24', status: 'in_progress', owner: 'backend' }] }) }), { name: 'subagent_backend', arguments: { label: '【后端工程师】实现 T24' } }, { ok: true })],
    ['读台账抛错 ⇒ 吞掉并放行（监听器绝不是故障源）', () => call(mk({ readTasks: async () => { throw new Error('boom'); } }), { name: 'subagent_backend', arguments: { label: '【后端工程师】实现 T24' } }, { ok: true })],
    ['写台账抛错 ⇒ 同样放行', () => call(mk({ writeTasks: async () => { throw new Error('disk full'); } }), { name: 'subagent_backend', arguments: { label: '【后端工程师】实现 T24' } }, { ok: true })],
  ];
  const before = writes.length;
  for (const [name, run] of cases) {
    const r = await run();
    check(r.out === r.downstream && r.nextCalls === 1, name);
  }
  check(writes.length === before, '上面 8 种情况**一次盘都没写**', `${writes.length - before} 次`);
  check(events.filter((e) => e.type === 'dispatch-ledger-error').length >= 2, 'IO 抛错留下了 error 事件（降级可见，不静默）');

  // 宿主签名兜底：`next` 不是函数时必须降级为"不干涉"，而不是抛错
  const noNext = await mk()({ name: 'subagent_backend', arguments: { label: '【后端工程师】实现 T24' } }, {}, undefined);
  check(noNext && noNext.kind === 'accept', '`next` 不是函数 ⇒ 返回 accept（2026-09-12 那次"全工具瘫痪"的兜底）');
}

console.log('\n⑤ `workflow` 扇出（one-shot 的**默认**派工路径）—— 2026-09-13 真实 run 实测它一次都没被记账');
{
  const script = [
    "const a = await agent('x', { label: '【研究员】研究现有项目全貌 T03' })",
    "// label: '注释里的示例 T99'",
    '/* label: \'块注释里的 T98\' */',
    "const b = await agent(`y`, { label: `【后端工程师】实现 T24/B1 的接口` })",
  ].join('\n');
  const labels = labelsInWorkflowScript(script);
  check(labels.length === 2, '从脚本正文抽出 2 条真 label（注释里的不算）', labels.map((l) => l.slice(0, 14)).join(' | '));
  check(labels.every((l) => !/T98|T99/.test(l)), '行注释与块注释里的 label 都被剥掉');
  check(labelsInWorkflowScript('').length === 0 && labelsInWorkflowScript(null).length === 0, '空/缺脚本 ⇒ 空数组（不猜）');

  // 逐腿归属：一腿研究员、一腿后端 ⇒ 各自认领，**不能**全记成第一个角色
  const writes = [];
  const events = [];
  const mk = (over = {}) => createDispatchLedger({
    roleOfLabel: (l) => (/研究员/.test(l) ? 'researcher' : (/后端工程师/.test(l) ? 'backend' : '')),
    runFor: async () => ({ cwd: '/w', runId: 'r' }),
    readTasks: async () => ({ tasks: [{ id: 'T03', status: 'pending' }, { id: 'T24', status: 'pending' }, { id: 'B1', status: 'pending' }] }),
    writeTasks: async (t, doc) => { writes.push(doc); },
    now: () => 'NOW',
    onEvent: (type, payload) => events.push({ type, payload }),
    ...over,
  });
  const call = async (fn, exec, result) => {
    let nextCalls = 0;
    const downstream = { kind: 'accept', tag: 'downstream' };
    const out = await fn(exec, result, async () => { nextCalls += 1; return downstream; });
    return { out, nextCalls, downstream };
  };
  const good = await call(mk(), { name: 'workflow', arguments: { script } }, { ok: true });
  check(writes.length === 1 && good.out === good.downstream, 'workflow 成功 ⇒ 写盘一次并**放行**', String(writes.length));
  const t = writes[0].tasks;
  check(t.find((x) => x.id === 'T03').owner === 'researcher', '腿 1（研究员）的任务归 researcher', t.find((x) => x.id === 'T03').owner);
  check(t.find((x) => x.id === 'T24').owner === 'backend' && t.find((x) => x.id === 'B1').owner === 'backend', '腿 2（后端）的两个任务归 backend（**不是**全批都用第一个角色）', `${t.find((x) => x.id === 'T24').owner}/${t.find((x) => x.id === 'B1').owner}`);
  check(t.every((x) => x.status === 'in_progress'), '三条都被认领');
  check(events.some((e) => e.type === 'dispatch-ledger-claimed' && e.payload.tool === 'workflow'), '事件里如实标出是 workflow 派工');

  const before = writes.length;
  const cases = [
    ['workflow **失败** ⇒ 不记账', () => call(mk(), { name: 'workflow', arguments: { script } }, { isError: true })],
    ['脚本里没有 label ⇒ 不记账', () => call(mk(), { name: 'workflow', arguments: { script: "await agent('x', { phase: 'research' })" } }, { ok: true })],
    ['脚本里的 id 都不在台账 ⇒ 不记账', () => call(mk(), { name: 'workflow', arguments: { script: "await agent('x', { label: '【研究员】干 T77' })" } }, { ok: true })],
    ['定位不到 run ⇒ 不记账', () => call(mk({ runFor: async () => null }), { name: 'workflow', arguments: { script } }, { ok: true })],
  ];
  for (const [name, run] of cases) {
    const r = await run();
    check(r.out === r.downstream && r.nextCalls === 1, name);
  }
  check(writes.length === before, '上面 4 种情况**一次盘都没写**', `${writes.length - before} 次`);
}

if (fail) { console.error(`\n✗ dispatch-ledger：${fail} 项失败`); process.exit(1); }
console.log('\n✓ dispatch-ledger：全部通过（口径 / 安全边界 / 放行 / 幂等）');
