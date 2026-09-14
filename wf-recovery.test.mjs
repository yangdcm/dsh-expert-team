// 测试：workflow 扇出的两条恢复路径 —— 派工 label → 角色；run 完整性 → 「为什么中断」
//
// 用户实测报障（连续两条）：
//   ① 面板底部「另有 22 个活子代理未能解析出角色」；
//   ② 「顺序检查一下任务为什么会中断 能不能优化」。
//
// 根因（同一条链）：
//   workflow 派生的子代理在**活子代理注册表里 descriptor label 为空**，唯一带角色的地方是
//   父会话事件流里的 `tool-workflow/agent-start { childId, label, phase }`。
//   客户端只兜底过「对话流 workflow 卡」的 label —— 而**卡片只在 workflow 工具调用拿到结果时
//   才存在**；回合被用户新消息打断时该调用没有结果 ⇒ 没有卡片 ⇒ 这批子代理**永远解析不出角色**。
//   同一批 run 也因此永远停在「进行中」（没有 `run-end`），这正是「任务中断」的真身。
//
// 修法：host 直接读**本会话事件流**（durable，与卡片无关）：
//   · `workflowChildLabels` → childId → {label, phase} → 关键词 → 角色；
//   · `workflowRuns`        → 没有 `run-end` 且没有成员在跑 ⇒ `interrupted`（诚实归因）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M16。
// 运行：node wf-recovery.test.mjs

import { _live } from './lib/command.js';

const { roleOfSub, mapRoleToSub, resolveSubRoles, childSessionTiming, SUB_HEADER_CACHE, workflowEventIndex, workflowChildLabels, workflowRuns, WF_EVENT_CACHE } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 事件流假件：与实测 session.v3.jsonl 的 tool-workflow/* 形状逐字一致 ──
const EV = (type, data) => ({ type, data });

// 一次**正常完成**的扇出（有 run-end）
const RUN_OK = 'run-ok';
// 一次**被打断**的扇出：4 个成员起了，只有 2 个结算，且**没有 run-end**
//（实测 runId 0e7744c3：turn 1 step 31 用户发「继续」打断，技能调用无结果）
const RUN_CUT = 'run-cut';
// 一次**报错**的扇出
const RUN_ERR = 'run-err';

const EVENTS = [
  EV('tool-workflow/run-start', { runId: RUN_OK, name: 'expert-team-competitive-analysis' }),
  EV('tool-workflow/agent-start', { runId: RUN_OK, seq: 1, label: '[调研] 官方 agent-team 全貌', phase: '调研', childId: 'c-research' }),
  EV('tool-workflow/agent-start', { runId: RUN_OK, seq: 2, label: '[重测] test-2 引用命中率重测', phase: '重测', childId: 'c-retest' }),
  EV('tool-workflow/agent-end', { runId: RUN_OK, seq: 1, outcome: 'completed' }),
  EV('tool-workflow/agent-end', { runId: RUN_OK, seq: 2, outcome: 'completed' }),
  EV('tool-workflow/run-end', { runId: RUN_OK, stopReason: 'completed' }),

  EV('tool-workflow/run-start', { runId: RUN_CUT, name: 'expert-team-competitive-repair' }),
  EV('tool-workflow/agent-start', { runId: RUN_CUT, seq: 1, label: '[返工] 架构侧重锚定与遗漏补齐', phase: '返工', childId: 'c-arch' }),
  EV('tool-workflow/agent-start', { runId: RUN_CUT, seq: 2, label: '[复审] review-2 逐条核验返工', phase: '复审', childId: 'c-review' }),
  EV('tool-workflow/agent-start', { runId: RUN_CUT, seq: 3, label: '[重测] test-2 引用命中率重测', phase: '重测', childId: 'c-retest2' }),
  EV('tool-workflow/agent-start', { runId: RUN_CUT, seq: 4, label: '[终局重测] test-3 双口径引用核验', phase: '重测', childId: 'c-retest3' }),
  EV('tool-workflow/agent-end', { runId: RUN_CUT, seq: 1, outcome: 'completed' }),
  EV('tool-workflow/agent-end', { runId: RUN_CUT, seq: 2, outcome: 'completed' }),
  // ← 没有 run-end：编排工具调用从未返回

  EV('tool-workflow/run-start', { runId: RUN_ERR, name: 'expert-team-competitive-analysis' }),
  EV('tool-workflow/run-end', { runId: RUN_ERR, stopReason: 'error' }),
  // 噪声：非 workflow 事件必须被忽略
  EV('tool/result', { runId: RUN_CUT, text: 'not a workflow event' }),
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'tool-workflow/agent-start' }] } } },
];

const ctx = {
  get(name) {
    if (name !== 'sessionQuery') return null;
    return { readSession: async () => ({ events: EVENTS }) };
  },
};

console.log('# workflow 扇出恢复（label→角色 / run→中断归因）\n');

console.log('① workflowChildLabels：从父会话事件流拿到每个 childId 的派工 label');
{
  WF_EVENT_CACHE.clear();
  const labels = await workflowChildLabels(ctx, 's1');
  check(labels.size === 6, '6 个子代理各有 label（含被打断 run 的 4 个）', 'size=' + labels.size);
  check(labels.get('c-retest2') && labels.get('c-retest2').label === '[重测] test-2 引用命中率重测', '被打断 run 的成员同样有 label');
  check(labels.get('c-retest2').runId === RUN_CUT, 'label 带 runId 归属');
  // 只吃 tool-workflow/*：噪声事件里的 runId 不得混进来
  check([...labels.values()].every((v) => v.runId === RUN_OK || v.runId === RUN_CUT), '忽略非 tool-workflow/* 事件');
}

console.log('\n② roleOfSub：注册表 label 为空时，用事件流派工 label 补解析角色');
{
  // 实测形状：活子代理注册表里 workflow 子代理只有 uuid，没有 label
  const bare = { id: 'c-retest2', label: '', name: '', mode: 'one-shot', activity: 'idle' };
  WF_EVENT_CACHE.clear();
  const labels = await workflowChildLabels(ctx, 's1');
  check(roleOfSub(bare) === '', '没有第三源时解析不出（基线：这就是那 22 个的来源）');
  check(roleOfSub(bare, labels) === 'qa', '有事件流 label 时解析出 qa（[重测] test-2 …）', roleOfSub(bare, labels));
  const arch = { id: 'c-arch', label: '' };
  const review = { id: 'c-review', label: '' };
  const retest3 = { id: 'c-retest3', label: '' };
  check(roleOfSub(arch, labels) === 'architect', '[返工] 架构… → architect');
  check(roleOfSub(review, labels) === 'reviewer', '[复审] review-2… → reviewer（review 先于 qa 命中）');
  check(roleOfSub(retest3, labels) === 'qa', '[终局重测] test-3… → qa');
  check(roleOfSub({ id: 'c-unknown', label: '' }, labels) === '', '事件流里没有的 childId → 仍如实为空（不臆造）');
  // 注册表自带 label 仍然是第一优先，不得被事件流覆盖
  check(roleOfSub({ id: 'c-arch', label: '[前端] uni-app 走查' }, labels) === 'frontend', '自带 label 优先于事件流 label');
  // mapRoleToSub 也要透传
  const m = mapRoleToSub([bare, arch], labels);
  check(m.get('qa') === bare && m.get('architect') === arch, 'mapRoleToSub 透传第三源');
}

console.log('\n②′ resolveSubRoles：事件流能解析出的必须**写回 sub.role**（回归：曾只跳过不赋值）');
{
  // 真实翻车现场（2026-09-11 重启后实测）：30 个子代理只有 5 个有角色，而那 5 个正是
  // wfLabels **解析不出**的（被下一段子会话日志兜底填上）；能解析的 25 个全空。
  // 根因：guard 写成 `if (roleOfSub(s, wfLabels)) continue` —— 只判"已知"不写回。
  WF_EVENT_CACHE.clear();
  const labels = await workflowChildLabels(ctx, 's1');
  // 事件流里没有的 id：只能靠子会话日志，这里让读日志抛错以模拟"读不到"
  const ctxNoLog = { get: () => null };
  const subs = [
    { id: 'c-research', label: '' },   // wfLabels 能解析 → researcher
    { id: 'c-retest2', label: '' },    // wfLabels 能解析 → qa
    { id: 'c-arch', label: '' },       // wfLabels 能解析 → architect
    { id: 'c-unknown', label: '' },    // 两边都解析不出 → 空
  ];
  await resolveSubRoles(ctxNoLog, subs, labels);
  check(subs[0].role === 'researcher', 'wfLabels 命中的写回了 sub.role（researcher）', String(subs[0].role));
  check(subs[1].role === 'qa', 'wfLabels 命中的写回了 sub.role（qa）', String(subs[1].role));
  check(subs[2].role === 'architect', 'wfLabels 命中的写回了 sub.role（architect）', String(subs[2].role));
  check(!subs[3].role, '两边都解析不出 → 不臆造');
  check(subs.filter((s) => s.role).length === 3, '3/4 有角色（而不是反过来的 1/4）', subs.filter((s) => s.role).length + '/4');
  // 写回后，下游只读 s.role 的路径（不传 wfLabels）也必须看得到
  check(roleOfSub(subs[0]) === 'researcher', '写回后 roleOfSub(s) 不传第三源也能拿到角色');
  const mapped = mapRoleToSub(subs);
  check(mapped.get('researcher') === subs[0] && mapped.get('qa') === subs[1], 'mapRoleToSub(subs) 不传第三源也能建出映射');
  // 已有 role 不得被覆盖
  const preset = [{ id: 'c-arch', label: '', role: 'ui' }];
  await resolveSubRoles(ctxNoLog, preset, labels);
  check(preset[0].role === 'ui', '已有 role 不被事件流覆盖（显式解析最权威）');
}

console.log('\n③ workflowRuns：没有 run-end ⇒ interrupted（「任务为什么会中断」的诚实答案）');
{
  WF_EVENT_CACHE.clear();
  const runs = await workflowRuns(ctx, 's1', []);
  const byName = new Map(runs.map((r) => [r.runId, r]));
  const ok = byName.get(RUN_OK), cut = byName.get(RUN_CUT), err = byName.get(RUN_ERR);
  check(ok.status === 'completed', '有 run-end stopReason=completed → completed');
  check(ok.unsettled === 0, '正常 run 未结算数为 0');
  check(err.status === 'failed', 'stopReason=error → failed');
  check(cut.status === 'interrupted', '无 run-end 且无成员在跑 → interrupted', cut.status);
  check(cut.started === 4 && cut.settled === 2 && cut.unsettled === 2, '派工 4 / 已结算 2 / 未结算 2');
  check(cut.name === 'expert-team-competitive-repair', 'run 名字可用于面板显示');
}

console.log('\n④ 仍在跑 ≠ 中断：有成员 activity=running 时判 running（避免误报）');
{
  WF_EVENT_CACHE.clear();
  const runs = await workflowRuns(ctx, 's1', [{ id: 'c-arch', activity: 'running' }]);
  const cut = runs.find((r) => r.runId === RUN_CUT);
  check(cut.status === 'running', '有成员在跑 → running（不误报为已中断）', cut.status);
}

console.log('\n⑤ 缓存：TTL 内不重复读会话；换 sessionId 不串味');
{
  WF_EVENT_CACHE.clear();
  let reads = 0;
  const counting = { get: () => ({ readSession: async () => { reads += 1; return { events: EVENTS } } }) };
  await workflowEventIndex(counting, 's1');
  await workflowEventIndex(counting, 's1');
  check(reads === 1, '同一 sessionId 3s 内只读一次（面板轮询不炸大日志）', 'reads=' + reads);
  await workflowEventIndex(counting, 's2');
  check(reads === 2, '换 sessionId 重新读（不串味）');
  const hit = WF_EVENT_CACHE.get('s1');
  check(hit && typeof hit.at === 'number', '缓存带时间戳（TTL 用）');
}

console.log('\n⑥ 健壮性：无 sessionQuery / 读失败 / 空 sid 都不得抛错');
{
  WF_EVENT_CACHE.clear();
  check((await workflowChildLabels(null, 's')).size === 0, 'ctx=null → 空 Map');
  check((await workflowChildLabels({ get: () => null }, 's')).size === 0, '无 sessionQuery → 空 Map');
  check((await workflowRuns({ get: () => ({ readSession: async () => { throw new Error('boom') } }) }, 's', [])).length === 0, '读失败 → 空数组（不抛）');
  check((await workflowChildLabels(ctx, '')).size === 0, '空 sessionId → 空 Map');
  const weird = { get: () => ({ readSession: async () => ({ events: [null, 42, { type: 'tool-workflow/agent-start' }, { type: 'tool-workflow/agent-start', data: { runId: 'r' } }] }) }) };
  const r = await workflowRuns(weird, 'weird', []);
  // 三行被丢弃（null / 非对象 / 无 runId），只剩 1 个 run：它记了 1 次派工但没有 childId，
  // 也永远不会结算（没有 run-end）⇒ 如实判为已中断。
  check(Array.isArray(r) && r.length === 1 && r[0].started === 1 && r[0].unsettled === 1, '畸形事件不炸，且计数如实', JSON.stringify(r));
  check(r[0].status === 'interrupted', '无 childId 的残缺 run 也判为已中断，而不是消失');
  const notArray = { get: () => ({ readSession: async () => ({ events: 'not-an-array' }) }) };
  check((await workflowRuns(notArray, 'na', [])).length === 0, 'events 不是数组 → 空数组（不抛）');
}

console.log('\n⑦ childSessionTiming：已结束的子代理必须还能拿到 createdAt（「无创建时间记录」的根因）');
{
  // 实测 2026-09-11（php/jiu 新建的 team）：会话日志第一行明明写着
  // {"type":"session","createdAt":1789103277739,"parentSession":"session-30625072-…","delegationDepth":1}
  // 但面板显示 createdAt=0 —— 因为**已结束的子会话会被从活存储里清掉**，
  // 而 host 只查了 ctx.sessions.get()。
  const real = { id: 'c1', createdAt: 1789103277739, parentSession: 'session-30625072-1f81-4f6f-bfe5-5bff6c37a469', delegationDepth: 1 };

  // ① 活存储命中（子代理还在跑）
  SUB_HEADER_CACHE.clear();
  const live = await childSessionTiming({ get: (n) => (n === 'sessions' ? { get: () => ({ header: real }) } : null) }, 'c1');
  check(live.createdAt === real.createdAt && live.parentId === real.parentSession && live.depth === 1, '① 活存储命中');

  // ② 活存储没有（已结束被清掉）→ 必须回落到 durable 投影
  SUB_HEADER_CACHE.clear();
  const dur = await childSessionTiming({
    get: (n) => (n === 'sessions' ? { get: () => undefined } : (n === 'sessionQuery' ? { readSession: async () => ({ session: real }) } : null)),
  }, 'c1');
  check(dur.createdAt === real.createdAt, '② 活存储拿不到 → 回落 sessionQuery 拿到真实 createdAt', String(dur.createdAt));
  check(dur.parentId === real.parentSession && dur.depth === 1, '② parentSession/delegationDepth 一并取到');

  // 两源都没有 → 保持 0，不臆造
  SUB_HEADER_CACHE.clear();
  const none = await childSessionTiming({ get: () => null }, 'cx');
  check(none.createdAt === 0 && none.parentId === '' && none.depth === 0, '两源都无 → 0/空（不臆造时间）');
  check((await childSessionTiming(null, 'cz')).createdAt === 0, 'ctx=null → 不抛');

  // 缓存：同一 id 只读一次日志
  let reads = 0;
  const counting = { get: (n) => (n === 'sessionQuery' ? { readSession: async () => { reads += 1; return { session: real } } } : null) };
  SUB_HEADER_CACHE.clear();
  await childSessionTiming(counting, 'c9');
  await childSessionTiming(counting, 'c9');
  check(reads === 1, '逐 id 缓存（面板轮询不重复读日志）', 'reads=' + reads);
}

console.log('');
if (fail > 0) {
  console.log(`✗ workflow 恢复测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ workflow 恢复测试通过（事件流 label 补解析角色；无 run-end 如实判为已中断）');
