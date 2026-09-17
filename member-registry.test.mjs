// 测试：派工即登记 —— `STATE.members` 回写（修「协议要求但代码零写路径」）
//
// 缺陷：`SKILL.md §7.16①` 明写派工登记 `<agentId>:<role>`「交由运行时回写 `STATE.members`」
// （`STATE.json` 的唯一写者是运行时、lead 只读核对），并说"浮层据此**精确归属**成员到本 run，多个专家团并行绝不串号"。
// 但代码里**没有任何写路径** —— 只有 `scaffoldRun` 初始化 `members: []`。
// 实测后果：所有 run 的 `stateMembers` 恒空 ⇒ `buildRoleSubMap` 的"精确路径"永不生效 ⇒
// 成员归属只能靠 label / 事件流 / 会话映射去**猜**（这正是"跨会话串味""未解析出角色"的土壤）。
//
// 修法：host 本来就算出了 `subById`（role→sub，id 是真的），直接落盘登记。
// 关键约束：**只在变化时写**（面板 3s 轮询，否则会持续改写工件）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M27。
// 运行：node member-registry.test.mjs

import { _live } from './lib/command.js';
import { rmFixture } from './test-helpers.mjs';

const { deriveMemberEntries, membersFromState, rememberSessionRun, sessionRunFor, runOwnerSession, sessionOwnsWorkspace, SESSION_RUNS } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const M = (pairs) => new Map(pairs.map(([role, id]) => [role, { id }]));

console.log('# 派工即登记（STATE.members 回写）\n');

console.log('① 首次登记：空了 registry 也能建起来');
{
  const r = deriveMemberEntries(M([['pm', 'a1a1a1a1-1111-4111-8111-111111111111'], ['researcher', 'b2b2b2b2-2222-4222-8222-222222222222']]), []);
  check(r.changed === true, 'changed=true（需要写盘）');
  check(r.entries.length === 2, '登记 2 条', JSON.stringify(r.entries));
  check(r.entries.includes('a1a1a1a1-1111-4111-8111-111111111111:pm') && r.entries.includes('b2b2b2b2-2222-4222-8222-222222222222:researcher'), '形状为 `<agentId>:<role>`');
  // 必须是 membersFromState 认得的形状 —— 否则"登记了但读不回来"
  const parsed = membersFromState(r.entries);
  check(parsed.byRole.get('pm') === 'a1a1a1a1-1111-4111-8111-111111111111' && parsed.byRole.get('researcher') === 'b2b2b2b2-2222-4222-8222-222222222222', 'membersFromState 能读回（闭环）');
}

console.log('\n② 幂等：同一份 subById 再跑一次不得产生变化（否则 3s 轮询持续写盘）');
{
  const first = deriveMemberEntries(M([['pm', 'a1a1a1a1-1111-4111-8111-111111111111']]), []);
  const again = deriveMemberEntries(M([['pm', 'a1a1a1a1-1111-4111-8111-111111111111']]), first.entries);
  check(again.changed === false, 'content 相同 → changed=false（不写盘）', JSON.stringify(again.entries));
  check(JSON.stringify(again.entries) === JSON.stringify(first.entries), 'entries 不变');
}

console.log('\n③ 同角色重派工：用新 id 覆盖该角色，**不动别人**');
{
  const before = ['a1a1a1a1-1111-4111-8111-111111111111:pm', 'b2b2b2b2-2222-4222-8222-222222222222:researcher', 'c3c3c3c3-3333-4333-8333-333333333333:reviewer-R1'];
  const r = deriveMemberEntries(M([['pm', 'z9z9z9z9-9999-4999-8999-999999999999'], ['researcher', 'b2b2b2b2-2222-4222-8222-222222222222']]), before);
  check(r.changed === true, 'changed=true（pm 换人了）');
  check(r.entries.includes('z9z9z9z9-9999-4999-8999-999999999999:pm'), 'pm 指向新 id', JSON.stringify(r.entries));
  check(!r.entries.includes('a1a1a1a1-1111-4111-8111-111111111111:pm'), '旧 pm 行被替换（不累积）');
  check(r.entries.includes('b2b2b2b2-2222-4222-8222-222222222222:researcher'), 'researcher 原样保留');
  check(r.entries.includes('c3c3c3c3-3333-4333-8333-333333333333:reviewer-R1'), '带后缀的 reviewer 行原样保留（不被抹掉）');
  check(r.entries.length === 3, '条数不膨胀', String(r.entries.length));
}

console.log('\n④ 角色带后缀也能识别为同一角色（frontend-F4 不该被当成新角色）');
{
  const before = ['a1a1a1a1-1111-4111-8111-111111111111:frontend-F4'];
  const r = deriveMemberEntries(M([['frontend', 'a1a1a1a1-1111-4111-8111-111111111111']]), before);
  check(r.changed === false, '同一 id + 同角色（虽有后缀）→ 无变化', JSON.stringify(r.entries));
  const r2 = deriveMemberEntries(M([['frontend', 'b2b2b2b2-2222-4222-8222-222222222222']]), before);
  check(r2.entries.length === 1 && r2.entries[0] === 'b2b2b2b2-2222-4222-8222-222222222222:frontend', '换 id 时按角色覆盖，不新增行', JSON.stringify(r2.entries));
}

console.log('\n⑤ 只增不改：registry 里 host 不认识的旧行不得被删除');
{
  const before = ['lead:lead', 'd4d4d4d4-4444-4444-8444-444444444444:unknown-role', 'a1a1a1a1-1111-4111-8111-111111111111:pm'];
  const r = deriveMemberEntries(M([['researcher', 'b2b2b2b2-2222-4222-8222-222222222222']]), before);
  check(r.entries.includes('lead:lead'), 'lead 行保留');
  check(r.entries.includes('d4d4d4d4-4444-4444-8444-444444444444:unknown-role'), '未知角色行保留（不越权清理别人的数据）');
  check(r.entries.includes('a1a1a1a1-1111-4111-8111-111111111111:pm'), '已有 pm 行保留');
  check(r.entries.includes('b2b2b2b2-2222-4222-8222-222222222222:researcher'), '新增 researcher 行');
  check(r.entries.length === 4, '4 条', String(r.entries.length));
}

console.log('\n⑥ 健壮性：畸形输入不得抛错（该函数在面板轮询路径上）');
{
  const bad = [
    [null, []], [undefined, undefined], [[], null],
    [M([['', 'aaa']]), []], [M([['pm', '']]), []], [M([['pm', null]]), []],
    ['not-a-map', ['x:y']], [M([['pm', 'a1a1a1a1-1111-4111-8111-111111111111']]), 'not-an-array'],
    [M([['pm', 'a1a1a1a1-1111-4111-8111-111111111111']]), [null, undefined, 42, '']],
  ];
  for (const [subs, ex] of bad) {
    let ok = true, msg = '';
    try { const r = deriveMemberEntries(subs, ex); ok = !!(r && Array.isArray(r.entries) && typeof r.changed === 'boolean') } catch (e) { ok = false; msg = String(e && e.message) }
    check(ok, `畸形输入 ${JSON.stringify(String(subs).slice(0, 18))} → 安全降级`, msg);
  }
  const r = deriveMemberEntries(M([['pm', 'a1a1a1a1-1111-4111-8111-111111111111']]), [null, 'bad-line-ok', 42, '']);
  check(r.entries.every((s) => typeof s === 'string' && s), '脏数组被清洗成非空字符串行', JSON.stringify(r.entries));
}

console.log('\n⑦ 接线检查：状态路由真的会回写（且只在变化时）');
{
  const { readFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  const at = src.indexOf('派工即登记（C3）');
  // 语义边界（2026-09-16）：旧写法 `at + 900` 会因登记块前新增注释而假红（本轮实测踩到）。
  const endAt = at >= 0 ? src.indexOf('best-effort：登记失败不影响读取', at) : -1;
  const block = (at >= 0 && endAt > at) ? src.slice(at, endAt) : '';
  check(!!block, '找到回写块');
  check(/deriveMemberEntries\(subById, sel\.stateMembers\)/.test(block), '用 subById 推导成员');
  check(/if \(derived\.changed\)/.test(block), '**只在变化时**写盘（防轮询刷写）');
  check(/ARTIFACT\.must\(stPath, st\)/.test(block), '走受控写入（版本栅栏 + 归因载体）');
  check(/st\.members = derived\.entries/.test(block), '写进 STATE.members');
}

// ══════════════════════════════════════════════════════════════════════════
// R12（F-1 · P0 跨 run 成员串号）—— repair-1 追加
//
// 实测事故：新 run 创建后 50 秒内，`/state` 的「派工即登记」把**上一个 run** 的 8 条成员
// 逐字写进了本 run 的 STATE.json（revision 2），而本 run 当时还没派工。
// 根因：`wfLabels = workflowChildLabels(ctx, peopleSid)` 是**会话级**的，同一会话里前一个
// run 的扇出全在里面；`buildRoleSubMap` 的精确路径因 `members=[]` 落空后回退到 label 匹配，
// 而 `workflowChildMeta` 明明返回了 `runId`，却从不用它过滤。
// ══════════════════════════════════════════════════════════════════════════
const { filterRunScopedSubs } = _live;

console.log('\n⑧ R12+R17 纯函数：两道过滤 + **过滤发生在角色映射之前**（收候选列表、按创建时间升序返回）');
{
  const ids = (r) => (r.list || []).map((s) => s.id);
  const subs = [{ id: 'agent-a-pm' }, { id: 'agent-b-backend' }, { id: 'agent-no-label' }, { id: 'agent-old-run' }];
  const wfLabels = new Map([
    ['agent-a-pm', { label: '[pm] A 的 pm', runId: 'runA', startedAt: 500 }],
    ['agent-b-backend', { label: '[backend] B 的 backend', runId: 'runB', startedAt: 300 }],
    ['agent-old-run', { label: '[reviewer] 上一个 run 的 reviewer', runId: 'run-older', startedAt: 100 }],
    // agent-no-label 故意没有 wfLabel（persist 模式角色工具派出的成员）
  ]);
  const r = filterRunScopedSubs(subs, {
    wfLabels, runId: 'runB', ownerSession: 'sess-shared', runCreatedAt: 1000,
    timingOf: new Map([['agent-no-label', { parentId: 'sess-shared', createdAt: 2000 }]]),
  });
  check(Array.isArray(r.list), 'R17：收/发**候选列表**（不是 role→sub 映射）⇒ 角色归一只能发生在过滤之后');
  check(!ids(r).includes('agent-a-pm'), '第①道：wfLabel.runId=runA ≠ runB ⇒ 不采纳（这就是串号的那条路径）');
  check(ids(r).includes('agent-b-backend'), '第①道：runId 逐字相等 ⇒ 采纳本 run 的成员');
  check(!ids(r).includes('agent-old-run'), '上一个 run 的候选被拒');
  check(ids(r).includes('agent-no-label'), '第②道：无 label 但父会话相符 + createdAt≥run 创建 ⇒ 采纳');
  check(r.rejected === 2, 'rejected 计数 = 2（pm、reviewer）', String(r.rejected));
  check(JSON.stringify(ids(r)) === JSON.stringify(['agent-b-backend', 'agent-no-label']), 'R17：按创建时间升序返回（300 < 2000）⇒ 下游 first-wins 即"创建更早者赢"', JSON.stringify(ids(r)));

  // R17 / QA 的 F1l：**同角色**冲突且外 run 的腿排在前面 —— 本 run 的腿必须仍然胜出
  const f1l = filterRunScopedSubs([{ id: 'X1' }, { id: 'X2' }, { id: 'D1' }], {
    wfLabels: new Map([
      ['X1', { label: '[pm] 旧 run 的 pm', runId: 'OLD', startedAt: 1 }],
      ['X2', { label: '[backend] 旧 run 的 backend', runId: 'OLD', startedAt: 2 }],
      ['D1', { label: '[pm] 本 run 的 pm', runId: 'D', startedAt: 3 }],
    ]),
    runId: 'D', ownerSession: 'sess', runCreatedAt: 1, timingOf: new Map(),
  });
  check(JSON.stringify(ids(f1l)) === JSON.stringify(['D1']), 'F1l：本 run 的腿**排在最后**也必须被采纳（旧顺序下它根本进不了映射）', JSON.stringify(ids(f1l)));
  check(f1l.rejected === 2, 'F1l：两条外 run 的腿仍被拒（不串号）', String(f1l.rejected));

  // 同角色多个**本 run** 候选 ⇒ 创建更早者排前（下游 first-wins 取它）
  const two = filterRunScopedSubs([{ id: 'LATER' }, { id: 'EARLIER' }], {
    wfLabels: new Map([['LATER', { runId: 'D', startedAt: 900 }], ['EARLIER', { runId: 'D', startedAt: 100 }]]),
    runId: 'D', ownerSession: 's', runCreatedAt: 1,
  });
  check(two.list[0].id === 'EARLIER', '同角色多个本 run 候选 ⇒ 创建更早者在前', JSON.stringify(ids(two)));
  const noTime = filterRunScopedSubs([{ id: 'UNKNOWN' }, { id: 'KNOWN' }], {
    wfLabels: new Map([['KNOWN', { runId: 'D', startedAt: 500 }], ['UNKNOWN', { runId: 'D' }]]),
    runId: 'D', ownerSession: 's', runCreatedAt: 1,
  });
  check(noTime.list[0].id === 'KNOWN', '创建时间不可考的候选排最后（不得抢在有据可查的候选前面）', JSON.stringify(ids(noTime)));

  const r2 = filterRunScopedSubs([{ id: 'x1' }], { wfLabels: new Map([['x1', { label: '[pm]', runId: '' }]]), runId: 'runB', ownerSession: 's', runCreatedAt: 1, timingOf: new Map() });
  check(r2.list.length === 0 && r2.rejected === 1, 'wfLabel 的 runId **缺失** ⇒ 不采纳（宁缺勿串）');
  const r3 = filterRunScopedSubs([{ id: 'x2' }], { wfLabels: new Map(), runId: 'runB', ownerSession: 'sess-B', runCreatedAt: 1000, timingOf: new Map([['x2', { parentId: 'sess-OTHER', createdAt: 5000 }]]) });
  check(r3.list.length === 0, '第②道：父会话不是本 run 归属会话 ⇒ 不采纳');
  const r4 = filterRunScopedSubs([{ id: 'x3' }], { wfLabels: new Map(), runId: 'runB', ownerSession: 'sess-B', runCreatedAt: 5000, timingOf: new Map([['x3', { parentId: 'sess-B', createdAt: 1000 }]]) });
  check(r4.list.length === 0, '第②道：createdAt 早于本 run 创建 ⇒ 不采纳');
  const r5 = filterRunScopedSubs([{ id: 'x4' }], { wfLabels: new Map(), runId: 'runB', ownerSession: 'sess-B', runCreatedAt: 0, timingOf: new Map([['x4', { parentId: 'sess-B', createdAt: 9999 }]]) });
  check(r5.list.length === 0, 'run 创建时刻取不到（0）⇒ 一律不采纳');
  const r6 = filterRunScopedSubs([{ id: 'x5' }], { wfLabels: new Map([['x5', { runId: 'runB' }]]), runId: '', ownerSession: 's', runCreatedAt: 1 });
  check(r6.list.length === 0, '本 run 的 runId 缺失 ⇒ 不采纳（不得放行一切）');
  const r7 = filterRunScopedSubs(null, null);
  check(!!r7 && Array.isArray(r7.list) && r7.list.length === 0 && r7.rejected === 0, '畸形输入安全降级（面板轮询路径上不得抛）');
  const r8 = filterRunScopedSubs([{ id: '' }, null, { noId: 1 }], { wfLabels: new Map(), runId: 'D', ownerSession: 's', runCreatedAt: 1 });
  check(r8.list.length === 0 && r8.rejected === 0, '无 id 的候选被跳过（不计入 rejected，也不进映射）');

  // ── ⑧b 真实 host 形状的对照（2026-09-17 修「one-shot run 成员归域」）──
  // 真实 host 的 `tool-workflow/run-start.runId` 是 `randomUUID()`，**恒不等于** `team/<slug>` 目录名
  // （实测会话 session-89fd2b7b：10/10 run-start 都是 UUID）；run 目录只出现在 workflow `tool/call`
  // 的脚本里。上面的夹具把 `wfLabel.runId` **直接写成了目录名** —— 那正是本缺陷长期全绿的原因。
  // 两条例对照把真实形状钉死：`runId` 对不上时，`runDir` 必须能独立把本 run 的腿认回来。
  const HOST_UUID = '9d9aaec8-1151-4587-be13-84eb58970354';
  const hostPos = filterRunScopedSubs([{ id: 'HP1' }], {
    wfLabels: new Map([['HP1', { label: '[pm] 本 run 的 pm', runId: HOST_UUID, runDir: 'runE', startedAt: 700 }]]),
    runId: 'runE', ownerSession: 's', runCreatedAt: 1, timingOf: new Map(),
  });
  check(JSON.stringify(ids(hostPos)) === JSON.stringify(['HP1']), '真实形状·正对照：runId 是 UUID（≠ 本 run 目录名）但 runDir=本 run ⇒ 必须被采纳', JSON.stringify(ids(hostPos)));
  const hostNeg = filterRunScopedSubs([{ id: 'HN1' }, { id: 'HN2' }], {
    wfLabels: new Map([
      ['HN1', { label: '[pm] 别的 run 的 pm', runId: HOST_UUID, runDir: 'run-older', startedAt: 800 }],
      ['HN2', { label: '[qa] 没有 runDir 的 qa', runId: HOST_UUID, startedAt: 900 }],
    ]),
    runId: 'runE', ownerSession: 's', runCreatedAt: 1, timingOf: new Map(),
  });
  check(hostNeg.list.length === 0 && hostNeg.rejected === 2, '真实形状·负对照：runId 是 UUID 且 runDir 属别的 run / 缺失 ⇒ 仍必须被拒（rejected 计数增加）', `rejected=${hostNeg.rejected}`);
}

console.log('\n⑨ R12 接线：/state 只把**本 run** 的成员写进 STATE.json（真实路由复现）');
{
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { apply } = await import('./lib/command.js');

  const root = await mkdtemp(join(tmpdir(), 'dsh-et-members-'));
  process.env.DSH_HOME = join(root, 'fake-dsh');
  const ws = join(root, 'proj');
  const iso = new Date().toISOString();
  const mkRun = async (runId, members) => {
    const d = join(ws, 'team', runId);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'ROSTER.json'), JSON.stringify({ runId, roles: ['pm', 'backend', 'qa'], members: {}, createdAt: iso }));
    await writeFile(join(d, 'STATE.json'), JSON.stringify({ runId, phase: 'implement', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts', coverage: [], members, ownerSession: 'sess-shared', updatedAt: iso }));
    await writeFile(join(d, 'TASK.md'), '> 目标：跨 run 串号复现\n');
    await writeFile(join(d, 'RUN.log.md'), '- [10:00:00] run:started — 目标=跨 run 串号复现\n');
    await writeFile(join(d, 'TASKS.json'), JSON.stringify({ tasks: [] }));
    return d;
  };
  // 候选（**顺序即真实事故顺序**：外 run 的腿在前、本 run 的腿在后）：
  //   agent-a-pm(runA) / agent-b-backend(runB) / agent-x-nolabel(无 wfLabel)
  //   X1(pm, runOLD) / X2(backend, runOLD) —— 旧 run 的腿，**排在本 run 的 D1 前面**
  //   D1(pm, runE) —— QA 的 F1l 场景：本 run 自己的腿排在最后
  const subs = [
    { id: 'agent-a-pm', label: '[pm] A 的 pm', activity: 'running', mode: 'continuable' },
    { id: 'agent-b-backend', label: '[backend] B 的 backend', activity: 'running', mode: 'continuable' },
    { id: 'agent-x-nolabel', label: '[qa] 没有 workflow label 的 qa', activity: 'running', mode: 'continuable' },
    { id: 'X1', label: '[pm] 旧 run 的 pm', activity: 'running', mode: 'continuable' },
    { id: 'X2', label: '[backend] 旧 run 的 backend', activity: 'running', mode: 'continuable' },
    { id: 'D1', label: '[pm] 本 run(E) 的 pm', activity: 'running', mode: 'continuable' },
  ];
  const wfEvents = [
    { type: 'tool-workflow/agent-start', time: Date.now(), data: { childId: 'agent-a-pm', label: '[pm] A 的 pm', runId: 'runA', seq: 1 } },
    { type: 'tool-workflow/agent-start', time: Date.now(), data: { childId: 'agent-b-backend', label: '[backend] B 的 backend', runId: 'runB', seq: 2 } },
    { type: 'tool-workflow/agent-start', time: 1, data: { childId: 'X1', label: '[pm] 旧 run 的 pm', runId: 'runOLD', seq: 3 } },
    { type: 'tool-workflow/agent-start', time: 2, data: { childId: 'X2', label: '[backend] 旧 run 的 backend', runId: 'runOLD', seq: 4 } },
    { type: 'tool-workflow/agent-start', time: 3, data: { childId: 'D1', label: '[pm] 本 run(E) 的 pm', runId: 'runE', seq: 5 } },
  ];
  let stateHandler = null;
  apply({
    commands: { register: () => {} },
    on: () => {},
    get: (k) => {
      if (k === 'subagents') return { listChildren: async () => subs };
      if (k === 'sessionQuery') return { readSession: async () => ({ events: wfEvents }) };
      if (k === 'sessions') return { get: () => undefined }; // 拿不到 header ⇒ 第②道无证据可采纳
      return undefined;
    },
    inject: (deps, f) => {
      if (String(deps) !== 'webServer') return;
      f({ effect: (fn) => { fn(); }, webServer: { register: (c) => { if (String(c.path).endsWith('/state')) stateHandler = c.handler; return () => {}; } } });
    },
  });
  // ⚠️ 必须带 `cwd=`：本组用例是**手工造 run 目录**（没跑过 /team 命令），所以
  // `registeredWorkspaces()` 是空的 —— 不给 cwd 的话路由会在「no workspace registered」处
  // 提前返回 ok:false，那几条断言就会**假过**（members 当然"没变"，因为根本没走到写盘）。
  const callState = (runId) => new Promise((resolve) => {
    stateHandler({ method: 'GET', url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(ws) + '&sessionId=sess-shared&workspace=' + encodeURIComponent(ws) + '&run=' + encodeURIComponent(runId) }, { writeHead() {}, end: (b) => resolve(JSON.parse(b)) });
  });

  // ① 两个 run 同一会话：请求 B ⇒ 只登记 B 自己的成员
  await mkRun('runA', []);
  const dirB = await mkRun('runB', []);
  const stB = await callState('runB');
  const stateB = JSON.parse(await readFile(join(dirB, 'STATE.json'), 'utf8'));
  check(stB.ok === true, '/state(runB) 成功');
  check(stateB.members.some((x) => String(x).includes('agent-b-backend')), '① 含 B 自己的成员', JSON.stringify(stateB.members));
  check(!stateB.members.some((x) => String(x).includes('agent-a-pm')), '① **不含** A 的任何 agentId（串号已修）', JSON.stringify(stateB.members));
  check(!JSON.stringify(stateB.members).includes('agent-x-nolabel'), '② 无 wfLabel 且无父会话/创建时间证据 ⇒ 不采纳');
  check(stB.membersUnresolved === true, '有候选被拒 ⇒ 响应带 membersUnresolved=true（如实告知，不假装解析成功）');

  // ④ 真实场景回归：members=[] + 全部候选属别的 run ⇒ STATE.json 逐字不变
  const dirC = await mkRun('runC', []);
  const beforeC = await readFile(join(dirC, 'STATE.json'), 'utf8');
  const stC = await callState('runC');
  const afterC = await readFile(join(dirC, 'STATE.json'), 'utf8');
  check(afterC === beforeC, '④ 全部候选属别的 run ⇒ STATE.json **逐字不变**（根本没写盘）');
  check(stC.membersUnresolved === true, '④ membersUnresolved=true');
  const stateC = JSON.parse(afterC);
  check(Array.isArray(stateC.members) && stateC.members.length === 0, '④ members 仍为空（空 members 远好过串号）', JSON.stringify(stateC.members));

  // ③ 已登记的 run（精确路径）再请求 ⇒ 既有成员不丢、行为不变
  const dirD = await mkRun('runD', ['agent-b-backend:backend']);
  const beforeD = await readFile(join(dirD, 'STATE.json'), 'utf8');
  const stD = await callState('runD');
  const afterD = await readFile(join(dirD, 'STATE.json'), 'utf8');
  const stateD = JSON.parse(afterD);
  check(stateD.members.includes('agent-b-backend:backend'), '③ 已登记成员不丢（二次轮询不回退）', JSON.stringify(stateD.members));
  check(!stateD.members.some((x) => String(x).includes('agent-a-pm')), '③ 精确路径也不会被塞进别的 run 的成员');
  check(afterD === beforeD, '③ 精确路径无变化 ⇒ 不写盘（3s 轮询不刷工件）');
  check(stD.membersUnresolved !== true, '③ 精确路径不报 membersUnresolved');

  // ── R17（QA 的 SG-B / F1l）：**先过滤、后角色映射** —— 外 run 的同角色腿排在前面时，
  // 本 run 自己的腿必须仍然胜出。旧顺序「先 mapRoleToSub（同角色先到先占）再过滤（只删不补）」
  // 会让 D1 根本进不了映射 ⇒ members=[]、pm.active=false（而真实事故的 subs 顺序正是如此）。
  console.log('\n⑨c R17 先过滤后映射：本 run 的腿排在最后也必须被采纳（F1l 场景）');
  const dirE = await mkRun('runE', []);
  const stE = await callState('runE');
  const stateE = JSON.parse(await readFile(join(dirE, 'STATE.json'), 'utf8'));
  check(stateE.members.some((x) => String(x) === 'D1:pm'), 'F1l：本 run 的 pm 腿（D1，排在 X1/X2 之后）被登记', JSON.stringify(stateE.members));
  check(!stateE.members.some((x) => String(x).startsWith('X1') || String(x).startsWith('X2')), 'F1l：外 run 的两条腿仍被拒（不串号）', JSON.stringify(stateE.members));
  const actE = stE.members || {};
  check(!!actE.pm && actE.pm.active === true && actE.pm.id === 'D1', 'F1l：面板显示 pm.active=true 且 id=D1（不再是"长期未启动"）', JSON.stringify(actE.pm && { id: actE.pm.id, active: actE.pm.active }));
  check(!(actE.backend && actE.backend.active), 'F1l：backend 无本 run 候选 ⇒ 显示未启动（X2 属外 run）', JSON.stringify(actE.backend && { id: actE.backend.id, active: actE.backend.active }));

  // ── R13（lead 裁决 notes②）：**显示**路径也必须走同一份 run 作用域过滤 ──
  // 只严写盘的话，数据污染修好了但**用户看到的串号现象一点没变**（面板照样把别的 run 的
  // 8 个活人显示成本 run 成员），而 membersUnresolved 当前 client.js 并不渲染。
  console.log('\n⑨b R13 显示路径：归属不上的活人不得显示成本 run 的成员');
  const actB = stB.members || {};
  check(!!actB.backend && actB.backend.active === true && actB.backend.id === 'agent-b-backend', '② 归属成立（wfLabels 带本 run runId）⇒ **落盘之前**就显示 active（"派工即可见"体验保住）', JSON.stringify(actB.backend && { id: actB.backend.id, active: actB.backend.active }));
  check(!(actB.pm && actB.pm.active), '② 别的 run 的 pm（wfLabels.runId=runA）**不显示**为本 run 成员', JSON.stringify(actB.pm && { id: actB.pm.id, active: actB.pm.active }));
  check(!(actB.qa && actB.qa.active), '③ 无归属证据的候选显示为未启动（active:false）');
  const actC = stC.members || {};
  check(Object.keys(actC).length > 0, '① 前置：roster 角色确实被渲染出来了（否则下一条断言是空转）', String(Object.keys(actC).length));
  check(Object.values(actC).every((m) => !m || !m.active), '① 新 run + members 为空 + 候选全属别的 run ⇒ **没有任何角色 active**', JSON.stringify(Object.fromEntries(Object.entries(actC).map(([k, v]) => [k, !!(v && v.active)]))));
  check(stC.membersUnresolved === true, '① 同时保留 membersUnresolved=true');
  const actD = stD.members || {};
  check(!!actD.backend && actD.backend.active === true && actD.backend.id === 'agent-b-backend', '③ 已登记成员照常显示 active（精确路径不进过滤 ⇒ 不丢）', JSON.stringify(actD.backend && { id: actD.backend.id, active: actD.backend.active }));

  // ── ⑨d 真实 host 形状的端到端对照（2026-09-17 修「one-shot run 成员归域」）──
  // 与 ⑨ 的差别只有一处，但正是本缺陷的关键：这里的事件流是**真实 host 形状** ——
  //   · `tool-workflow/run-start.runId` 是 `randomUUID()`（≠ `team/<slug>` 目录名）；
  //   · run 目录只出现在**它之前**的 workflow `tool/call`（`data.arguments` 是 JSON 字符串，
  //     `script` 里逐字写着 `const RUN = ROOT + '/team/<slug>'`）。
  // ⑨ 的夹具把 `wfLabel.runId` 直接写成目录名 —— 那正是本缺陷长期全绿的原因（伪造了真实形状）。
  console.log('\n⑨d 真实 host 形状：runId 是 UUID、run 目录只在 tool/call 脚本里 ⇒ 本 run 的腿仍须归回来');
  {
    const { workflowEventIndex } = _live;
    const ws2 = join(root, 'proj-host');
    const sid2 = 'sess-host-shape-89fd2b7b';
    const UUID1 = '9d9aaec8-1151-4587-be13-84eb58970354';
    const UUID2 = 'fab10968-05cf-46c7-a170-dd0b473e191f';
    const RUN1 = '做竞品分析-分析dsh官方的te-145629';       // 非 ASCII slug（真实会话 session-89fd2b7b 里的那个）
    const MISSING = '不存在的run-000000';                   // 噪声：脚本里出现，但不是 team/ 下的目录
    const mkRun2 = async (name, members) => {
      const d = join(ws2, 'team', name);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'ROSTER.json'), JSON.stringify({ runId: name, roles: ['pm', 'qa'], members: {}, createdAt: iso }));
      await writeFile(join(d, 'STATE.json'), JSON.stringify({ runId: name, phase: 'implement', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts', coverage: [], members, ownerSession: sid2, updatedAt: iso }));
      await writeFile(join(d, 'TASK.md'), '> 目标：真实 host 形状归域\n');
      await writeFile(join(d, 'RUN.log.md'), '- [10:00:00] run:started — 目标=真实 host 形状归域\n');
      await writeFile(join(d, 'TASKS.json'), JSON.stringify({ tasks: [] }));
      return d;
    };
    const d1 = await mkRun2(RUN1, []);
    const dOther = await mkRun2('other-run-999999', []);
    const hostSubs = [
      { id: 'H-pm', label: '[pm] 本 run 的 pm', activity: 'running', mode: 'continuable' },
      { id: 'H-nodir', label: '[qa] 抽不出目录的 qa', activity: 'running', mode: 'continuable' },
    ];
    const wfEvents2 = [
      { type: 'tool/call', time: 1, data: { name: 'workflow', arguments: JSON.stringify({ script: `const ROOT = '/x';\nconst RUN = ROOT + '/team/${RUN1}';\n` }) } },
      { type: 'tool-workflow/run-start', time: 2, data: { runId: UUID1, name: 'expert-team-competitive-analysis' } },
      { type: 'tool-workflow/agent-start', time: 3, data: { childId: 'H-pm', label: '[pm] 本 run 的 pm', runId: UUID1, seq: 1 } },
      // 噪声反例：脚本里出现一个**核不上**的 `/team/<slug>` ⇒ 该 run 的 runDir 必须保持 ''（继续拒，不放松）
      { type: 'tool/call', time: 4, data: { name: 'workflow', arguments: JSON.stringify({ script: `// 参考 ROOT + '/team/${MISSING}'\n` }) } },
      { type: 'tool-workflow/run-start', time: 5, data: { runId: UUID2, name: 'expert-team-roi-review' } },
      { type: 'tool-workflow/agent-start', time: 6, data: { childId: 'H-nodir', label: '[qa] 抽不出目录的 qa', runId: UUID2, seq: 2 } },
    ];
    // `sessions.get(sid2)` 给 cwd（抽取 run 目录要拿 workspace）；子代理**只**经 `list()` 暴露成
    // live 行 —— 子会话 header 一律不给，第②道就只能靠 wfLabels 的 `startedAt`（3/6 ms）作证，
    // 而它们远早于 run 创建时刻 ⇒ 负对照不会被第②道意外放行。
    const get2 = (k) => {
      if (k === 'subagents') return { listChildren: async () => hostSubs };
      if (k === 'sessionQuery') return { readSession: async () => ({ events: wfEvents2 }) };
      if (k === 'sessions') {
        return {
          get: (id) => (String(id) === sid2 ? { header: { id: sid2, meta: { cwd: ws2 } } } : undefined),
          list: () => hostSubs.map((s) => ({ header: { id: s.id, parentSession: sid2, origin: 'subagent', delegationDepth: 1, createdAt: 1 } })),
        };
      }
      return undefined;
    };
    // ① 抽取本身：label 上必须**同时**有 UUID（runId）与目录名（runDir）
    const idx2 = await workflowEventIndex({ get: get2 }, sid2, { force: true });
    const lab1 = idx2.labels.get('H-pm') || {};
    check(lab1.runId === UUID1 && lab1.runDir === RUN1, '抽取：tool/call 脚本里的 /team/<slug> 被核到并记进 label.runDir（runId 仍是 UUID）', JSON.stringify({ runId: lab1.runId, runDir: lab1.runDir }));
    const lab2 = idx2.labels.get('H-nodir') || {};
    check(lab2.runId === UUID2 && lab2.runDir === '', '噪声过滤：抽出的 slug 不是 team/ 下的目录 ⇒ runDir 保持 ""（继续拒，不放松 R12 串号防线）', JSON.stringify({ runId: lab2.runId, runDir: lab2.runDir }));

    // ② 真实路由：正对照（本 run）必须登记；负对照（别的 run）必须逐字不动 STATE.json
    let stateHandler2 = null;
    apply({
      commands: { register: () => {} },
      on: () => {},
      get: get2,
      inject: (deps, f) => {
        if (String(deps) !== 'webServer') return;
        f({ effect: (fn) => { fn(); }, webServer: { register: (c) => { if (String(c.path).endsWith('/state')) stateHandler2 = c.handler; return () => {}; } } });
      },
    });
    const callState2 = (runId) => new Promise((resolve) => {
      stateHandler2({ method: 'GET', url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(ws2) + '&sessionId=' + encodeURIComponent(sid2) + '&workspace=' + encodeURIComponent(ws2) + '&run=' + encodeURIComponent(runId) }, { writeHead() {}, end: (b) => resolve(JSON.parse(b)) });
    });
    const st1 = await callState2(RUN1);
    const state1 = JSON.parse(await readFile(join(d1, 'STATE.json'), 'utf8'));
    check(st1.ok === true, '⑨d 前置：/state 成功（否则下面的断言是空转）');
    check(state1.members.some((x) => String(x) === 'H-pm:pm'), '正对照：runId=UUID + runDir=本 run ⇒ 本 run 的腿被登记（one-shot 成员归域已修）', JSON.stringify(state1.members));
    check(!state1.members.some((x) => String(x).includes('H-nodir')), '正对照：抽不出目录的那条腿不得混进本 run', JSON.stringify(state1.members));
    const beforeOther = await readFile(join(dOther, 'STATE.json'), 'utf8');
    const stOther = await callState2('other-run-999999');
    const afterOther = await readFile(join(dOther, 'STATE.json'), 'utf8');
    check(afterOther === beforeOther, '负对照：runId 是 UUID 且 runDir 属别的 run（或缺失）⇒ 全部被拒、STATE.json **逐字不变**');
    check(stOther.membersUnresolved === true, '负对照：有候选被拒 ⇒ membersUnresolved=true（rejected 计数 > 0，如实告知）');
    const actOther = stOther.members || {};
    check(Object.values(actOther).every((m) => !m || !m.active), '负对照：显示路径也不得把别的 run 的活人标成本 run 成员', JSON.stringify(Object.fromEntries(Object.entries(actOther).map(([k, v]) => [k, !!(v && v.active)]))));
  }

  // 拆除 fixture：容忍"插件异步写在飞"造成的瞬时 ENOTEMPTY（见 test-helpers.mjs 的说明）
  await rmFixture(root);
}

console.log('\n⑩ R12+R13+R17 接线检查：过滤真的接在**角色映射、写盘、显示**之前（不是只写了个没人调的函数）');
{
  const { readFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  const at = src.indexOf('R12 + R13 + R17（F-1 · P0 跨 run 成员串号）');
  const block = at >= 0 ? src.slice(at, at + 3000) : '';
  check(!!block, '找到 R12+R13+R17 过滤块');
  check(/filterRunScopedSubs\(subs, \{/.test(block), 'R17：过滤的输入是**候选 subs 列表**（不是已做角色映射的 Map）');
  check(!/filterRunScopedSubs\(roleSubAll/.test(src), 'R17：不再有"先映射后过滤"的旧调用');
  check(/runId: sel\.runId/.test(block), '过滤用**本 run** 的 runId');
  check(/ownerSession: sel\.stateOwnerSession \|\| owner\.sid/.test(block), '归属会话优先 STATE.ownerSession，缺失则传**解析出来的归属** owner.sid（解析失败即空 ⇒ 第②道如实拒，不拿请求会话冒充）');
  check(!/ownerSession: sel\.stateOwnerSession \|\| peopleSid/.test(block), '不得把 peopleSid（owner.sid || sid，会退成请求会话）当作归属传入');
  check(/runCreatedAt: await runCreatedAtMs\(/.test(block), '带本 run 创建时刻（第②道过滤的证据）');
  check(/sel\.membersUnresolved = true/.test(block), '被拒时置 membersUnresolved');
  check(/subById = mapRoleToSub\(scoped\.list, wfLabels\)/.test(block), 'R17：角色归一映射吃的是**过滤后**的列表');
  check(block.indexOf('filterRunScopedSubs(') < block.indexOf('mapRoleToSub(scoped.list'), 'R17：过滤发生在角色映射**之前**');
  check(block.indexOf('filterRunScopedSubs(') < block.indexOf('派工即登记（C3）'), '过滤发生在**写盘之前**');
  check(/buildRoleSubMap\(subs, sel\.stateMembers, wfLabels\)/.test(block), '精确路径（已登记成员）仍走 buildRoleSubMap ⇒ 不过滤、不丢');
  // R13：显示路径也吃过滤结果（R12 那版传的是未过滤的 map ⇒ 面板照样串号）
  check(/enrichMembers\(sel\.runId, sel\.roles, sel\.members, subById/.test(src), 'R13：enrichMembers 吃**过滤后**的 subById');
  check(!/enrichMembers\(sel\.runId, sel\.roles, sel\.members, roleSubAll/.test(src), 'R13：显示路径不再吃未过滤的 map');
}

console.log('\n⑪ session→run 归属：create 不被"查看"改写 / 跨工作区不写 / 无 create 不给归属');
{
  // 三处缺陷（2026-09-17 复现）：
  //   · rememberSessionRun 在 `prev.via==='create'` 时只保 via、却覆盖 workspace/runId
  //     ⇒ 那条记录对**另一个 run** 自称 create ⇒ runOwnerSession 把它当**可信**归属；
  //   · runOwnerSession 的"最早一条"兜底 ⇒ 纯 `view` 记录也能产出归属（假归属被标可信）；
  //   · /state 的写入点不校验会话真实 cwd ⇒ 在 dsh 会话里选别的工作区的 run 也写进归属表。
  // 用**独立** sid/runId，不碰本文件其它夹具的 id。
  const wsOwnA = '/w/ownership-A';
  const wsOwnB = '/w/ownership-B';
  const runOwnX = 'own-run-X';
  const runOwnY = 'own-run-Y';
  const runOwnZ = 'own-run-Z';
  SESSION_RUNS.clear();

  // 正对照：create 是可靠归属
  rememberSessionRun('own-sX', wsOwnA, runOwnX, 'create');
  const oOwnX = runOwnerSession(runOwnX);
  check(oOwnX.sid === 'own-sX' && oOwnX.ownerResolved === true, '正对照：create 记录 → 归属成立且 ownerResolved=true', JSON.stringify(oOwnX));

  // 负对照 A：已有 create 归属不得被"查看"改写（旧实现的假归属来源）
  rememberSessionRun('own-sX', wsOwnB, runOwnY, 'view');
  const oOwnX2 = runOwnerSession(runOwnX);
  check(oOwnX2.sid === 'own-sX' && oOwnX2.ownerResolved === true, '负对照 A：别的工作区的 view 之后，run-X 的归属**仍是** own-sX（没被改写）', JSON.stringify(oOwnX2));
  const oOwnY = runOwnerSession(runOwnY);
  check(oOwnY.sid !== 'own-sX', '负对照 A：run-Y **不得**被判给 own-sX（旧实现会产出 {sid:own-sX,ownerResolved:true} 假归属）', JSON.stringify(oOwnY));

  // 负对照 B：跨工作区不写（会话记录仍属原工作区）
  rememberSessionRun('own-sX', wsOwnA, runOwnX, 'create');
  rememberSessionRun('own-sX', wsOwnB, runOwnZ, 'view');
  check(sessionRunFor('own-sX').workspace === wsOwnA, '负对照 B：跨工作区的 view 不改写 workspace（仍是 wsOwnA）', String(sessionRunFor('own-sX').workspace));

  // 负对照 C：只有 view、没有 create ⇒ 如实"未解析"，不拿最早一条兜底
  SESSION_RUNS.clear();
  rememberSessionRun('own-sB1', wsOwnA, runOwnZ, 'view');
  rememberSessionRun('own-sB2', wsOwnA, runOwnZ, 'view');
  const oOwnZ = runOwnerSession(runOwnZ);
  check(oOwnZ.sid === '' && oOwnZ.ownerResolved === false, '负对照 C：两条 view（无 create）→ {sid:"", ownerResolved:false}（去掉"最早一条"兜底）', JSON.stringify(oOwnZ));

  // ── 判别用例（2026-09-17 补）：既有负对照 A/B 都是"两条守卫**同时**命中"，
  //    分不出是哪条在起作用（单独删守卫① 或 守卫② ⇒ 全套 89 文件仍全绿）。
  //    D1 只让**守卫①**成为唯一拦截者（同工作区 ⇒ 守卫② 放行）；D2 只让**守卫②**成为唯一拦截者
  //    （prev 是 `view` ⇒ 守卫① 不适用）。
  // D1（判别守卫①：`prev.via==='create' && via!=='create' && …`）：同工作区，view 不得改写 create
  SESSION_RUNS.clear();
  rememberSessionRun('own-d1', wsOwnA, 'run-D1x', 'create');
  rememberSessionRun('own-d1', wsOwnA, 'run-D1y', 'view');
  const rD1 = sessionRunFor('own-d1');
  check(rD1.runId === 'run-D1x' && rD1.via === 'create', 'D1（判别守卫①）：同工作区的 view 不得把 create 的 runId/via 改写掉', JSON.stringify(rD1));
  check(runOwnerSession('run-D1y').sid === '', 'D1：被拦下的 view 不构成归属（run-D1y 无 create ⇒ sid 仍为空）', JSON.stringify(runOwnerSession('run-D1y')));

  // D2（判别守卫②：`prev.workspace !== ws` 早退）：prev=view（非 create）+ 跨工作区
  SESSION_RUNS.clear();
  rememberSessionRun('own-d2', wsOwnA, 'run-D2', 'view');
  rememberSessionRun('own-d2', wsOwnB, 'run-D2', 'view');
  check(sessionRunFor('own-d2').workspace === wsOwnA, 'D2（判别守卫②）：prev=view（非 create）+ 跨工作区 ⇒ 记录仍属 wsA（跨工作区不写；守卫①不适用）', String(sessionRunFor('own-d2').workspace));

  // 守卫③：`sessionOwnsWorkspace` **直调**（它此前不在 `_live` 里 ⇒ 改成恒 false 也全绿）。
  //   构造 ctx 用**真实宿主形状**：cwd 住在 `session.header.cwd`（宿主 `Session` 只暴露 `id` getter）。
  //   ⚠️ 不照抄本文件 :379 那处 `{ header: { id, meta: { cwd } } }` —— 那是宿主从不产出的形状。
  const ctxOwn = {
    get: (k) => (k === 'sessions' ? {
      get: (id) => ({
        'own-cwd-ok': { header: { id: 'own-cwd-ok', cwd: wsOwnA } },
        'own-cwd-other': { header: { id: 'own-cwd-other', cwd: wsOwnB } },
        'own-cwd-none': { header: { id: 'own-cwd-none' } },
      })[String(id)] } : undefined),
  };
  check(sessionOwnsWorkspace(ctxOwn, 'own-cwd-ok', wsOwnA) === true, '守卫③ 正对照：会话 cwd === ws ⇒ true（守卫真的能生效，不是纸面守卫）');
  check(sessionOwnsWorkspace(ctxOwn, 'own-cwd-other', wsOwnA) === false, '守卫③ 负 1：cwd ≠ ws ⇒ false');
  check(sessionOwnsWorkspace(ctxOwn, 'own-cwd-none', wsOwnA) === false, '守卫③ 负 2：会话取不到 cwd ⇒ false（宁可少写一条）');
  check(sessionOwnsWorkspace(ctxOwn, 'own-nope', wsOwnA) === false, '守卫③ 负 3：不存在的 sid ⇒ false（不写假 id）');

  SESSION_RUNS.clear();
}

console.log('');
if (fail > 0) {
  console.log(`✗ 派工登记测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 派工登记测试通过（role→真实 agentId 落盘；幂等；只增不改；脏数据安全）');
console.log('✔ R12 通过（跨 run 成员不再串号：wfLabel.runId 收窄 + 父会话/创建时间双证；已登记成员不丢；宁可空 members）');
console.log('✔ R13 通过（**显示**路径同吃过滤结果：归属不上的活人显示为未启动 + membersUnresolved；归属成立的落盘前即可见；已登记的不丢）');
console.log('✔ R17 通过（**先过滤、后角色映射**：外 run 同角色腿排在前面时，本 run 的腿照样被采纳；同角色多候选取创建更早者；外 run 腿仍被拒）');
