// 有界化回归护栏（2026-09-15，1.3.17）。
//
// 真机基线（用户实测）：重会话（30+ 子代理）`?section=people,feed` 单发 **5.4–9.2 s**，分段
// `subs` **2.9–3.7 s**、`roles` **2.4–5.5 s** —— 两段**都没有上限**，而且请求压在事件循环上。
// 本文件钉住"**有界**"这件事本身（不是"更快"），防止无上限的重活静默复活：
//   ① `subs` 枚举：节流窗口内**零枚举**；期限到点立即**停**；两种情形都如实进 `SUB_HEADER_STATS.cut`
//      （调用方据此进 `degraded`：`subs:throttled` / `subs:deadline` —— 缺块 ≠ 空数据）；
//   ② `roles` 读取：实时路径 `maxReads=0` ⇒ **零读**，未知角色如实留空（`rolesPending` 表达"待解析"）；
//      期限到点 ⇒ `ROLE_READ_STATS.cut='deadline'`；**"待解析"与"解析不出来"必须分得开**；
//   ③ 收敛：`deferred` 单调下降至 0（旧实现每请求从零重算 ⇒ 实测 16→40 **上涨**）；
//   ④ 负载字段是 `rolesPending`（单一真源），且客户端**真的渲染它**（字段不是没人读的摆设）。
//   ⑤（2026-09-16）`warming`：重读挪到后台后，**请求路径立刻返回**；过期先给上一份**完整**快照；
//      读失败**不覆盖**好快照；后台批单飞且队列空时不踢（否则 warming 会常亮成噪声）。
//   ⑦（1.3.23）**后台批必须真的干活**：期限从批**开跑**起算（1.3.22 是 kick 时算 ⇒ 1000 ms 延迟
//      吃掉 600 ms 期限 ⇒ 按构造零读、队列永不前进）；「零进展」必须可见（degraded）且**恢复后自灭**。
//   ⑥（1.3.22）**上限 ≠ 故障**：`degraded` 从此只承载真故障（软期限截断 / 读失败），
//      按设计的能力上限（`MAX_ROLE_SUBS` / `MAX_FEED_AGENTS`）改走 `scopeCaps` 且数字一个不少。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const { _live } = await import(join(here, 'lib', 'command.js'));

console.log('① subs 枚举：节流窗口内零枚举 / 期限到点即停（都如实标记）');
{
  const { listSubagentStatusBySession, _resetSubHeaderMemo, _resetListSessionsCache, _resetSubRowsMemo, SUB_HEADER_STATS } = _live;
  const mkCtx = (onEnum) => ({
    get: (n) => (n === 'sessionQuery'
      ? { listSessions: async () => { onEnum(); return [{ header: { id: 'ended-A', createdAt: 5 } }]; } }
      : (n === 'subagents' ? { listChildren: async () => [] } : null)),
  });

  // (a) 节流：本轮禁止枚举 ⇒ 一次 listSessions 都不发，且 cut='throttled'
  _resetSubHeaderMemo(); _resetListSessionsCache(); _resetSubRowsMemo();
  let enumA = 0;
  await listSubagentStatusBySession(mkCtx(() => { enumA += 1; }), 'root', ['ended-A'], { allowEnum: false });
  check(enumA === 0 && SUB_HEADER_STATS.cut === 'throttled',
    '节流窗口内**零枚举**（省掉 475-artifact 全库扫描），并如实标记 throttled',
    'enumCalls=' + enumA + ' cut=' + SUB_HEADER_STATS.cut);

  // (b) 期限：允许枚举但期限已过 ⇒ **连枚举都不启动**（第四轮改），并如实标 deadline。
  //     ⚠️ 旧实现在这里会先发起那次 2.7 s 的全库枚举、读回全部结果、在第一行上才发现超期
  //     —— 那正是"装饰性期限"。改后的判据是"一次都不发"。
  _resetSubHeaderMemo(); _resetListSessionsCache(); _resetSubRowsMemo();
  let enumB = 0;
  await listSubagentStatusBySession(mkCtx(() => { enumB += 1; }), 'root', ['ended-A'], { allowEnum: true, enumDeadlineAt: 0 });
  check(enumB === 0 && SUB_HEADER_STATS.cut === 'deadline',
    '期限已过 ⇒ **一次枚举都不发**（不再"发起了才发现超期"），并如实标 deadline',
    'enumCalls=' + enumB + ' cut=' + SUB_HEADER_STATS.cut);

  // (c) 默认（不传 opts）仍保持原行为：允许枚举、无期限
  _resetSubHeaderMemo(); _resetListSessionsCache(); _resetSubRowsMemo();
  let enumC = 0;
  const rowsC = await listSubagentStatusBySession(mkCtx(() => { enumC += 1; }), 'root', ['ended-A']);
  check(enumC === 1 && SUB_HEADER_STATS.cut === '' && rowsC.some((r) => r.id === 'ended-A' && r.createdAt === 5),
    '不传 opts ⇒ 保持原行为（允许枚举、无期限、header 带全）', 'enumCalls=' + enumC);

  // (d) **本轮核心**：`subagents.listChildren()` 慢过期限 ⇒ 响应**不等它**。
  //     真机证据：`?section=people,feed` 2,686/2,724/2,697 ms、其中 `profile.subs` 占满，
  //     全部来自这一句内部无条件的全库枚举（475 条 artifact）。
  _resetSubHeaderMemo(); _resetListSessionsCache(); _resetSubRowsMemo();
  let warmStarts = 0;
  const hangCtx = {
    get: (n) => {
      if (n === 'sessions') return { list: () => [] };
      if (n === 'subagents') return {
        listChildren: () => { warmStarts += 1; return new Promise((r) => { const t = setTimeout(() => r([{ id: 'slow-1', createdAt: 9 }]), 3000); if (t.unref) t.unref(); }); },
      };
      if (n === 'sessionQuery') return { listSessions: async () => { throw new Error('不该走到枚举'); } };
      return null;
    },
  };
  const tD = Date.now();
  const rowsD = await listSubagentStatusBySession(hangCtx, 'root-hang', ['slow-1'], { allowEnum: true, enumDeadlineAt: Date.now() + 120 });
  const msD = Date.now() - tD;
  check(msD < 1000 && SUB_HEADER_STATS.cut === 'deadline' && warmStarts === 1,
    '预热慢过期限 ⇒ 到点即返回（cut=deadline），**不等**那次全库枚举（旧实现在这里要等满 3 s）',
    `ms=${msD} cut=${SUB_HEADER_STATS.cut} warms=${warmStarts}`);
  check(rowsD.length === 0 && SUB_HEADER_STATS.warmTimeouts === 1,
    '这一轮如实**没有**那行（不臆造时间戳），并记 `warmTimeouts`',
    `rows=${rowsD.length} warmTimeouts=${SUB_HEADER_STATS.warmTimeouts}`);

  // (e) 预热落进备忘后：第二次请求**一次都不再调 listChildren**（成本从每请求变成每次刷新）
  _resetSubHeaderMemo(); _resetListSessionsCache(); _resetSubRowsMemo();
  let calls = 0;
  const warmFastCtx = {
    get: (n) => {
      if (n === 'sessions') return { list: () => [] };
      if (n === 'subagents') return { listChildren: async () => { calls += 1; return [{ id: 'w-1', createdAt: 11, activity: 'inactive' }]; } };
      return null;
    },
  };
  const first = await listSubagentStatusBySession(warmFastCtx, 'root-warm', ['w-1'], { allowEnum: true, enumDeadlineAt: Date.now() + 800 });
  const second = await listSubagentStatusBySession(warmFastCtx, 'root-warm', ['w-1'], { allowEnum: true, enumDeadlineAt: Date.now() + 800 });
  check(calls === 1 && first.some((r) => r.id === 'w-1' && r.createdAt === 11) && second.some((r) => r.id === 'w-1' && r.createdAt === 11),
    '预热一次、之后每轮只读备忘（`listChildren` 调用数不随请求数增长）',
    `calls=${calls} rowsHits=${SUB_HEADER_STATS.rowsHits}`);
}

console.log('\n② roles：实时路径零读（未知角色如实"待解析"）、期限到点即停');
const roleCtx = (onRead) => ({
  get: (n) => (n === 'sessionQuery' ? {
    readSession: async (id) => {
      onRead(id);
      return { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '你是「专家团」的后端工程师（backend，动态补位角色）' }] } }] };
    },
  } : null),
});
{
  const { resolveSubRoles, resetRoleReadBudget, _resetRolePending, roleReadBudgetSnapshot, ROLE_READ_STATS } = _live;
  let reads = 0;
  const ctx = roleCtx(() => { reads += 1; });
  const subs = [{ id: 'bounded-x1', role: '', label: '' }];
  _resetRolePending(); resetRoleReadBudget();
  await resolveSubRoles(ctx, subs, {}, { maxReads: 0 });
  check(reads === 0 && subs[0].role === '' && roleReadBudgetSnapshot().deferred === 1,
    'maxReads=0 ⇒ **零次日志读**，未知角色如实留空（由 rolesPending 表达"待解析"）',
    'reads=' + reads + ' deferred=' + roleReadBudgetSnapshot().deferred);

  resetRoleReadBudget();
  await resolveSubRoles(ctx, subs, {}, { maxReads: 4, deadlineAt: 0 });
  check(reads === 0 && ROLE_READ_STATS.cut === 'deadline',
    '期限到点 ⇒ cut=deadline（如实上报；不读、也不假装解析过）', 'reads=' + reads + ' cut=' + ROLE_READ_STATS.cut);

  // 收敛：每轮只读 1 条 ⇒ deferred 单调下降到 0，角色全部解析出来
  _resetRolePending(); resetRoleReadBudget();
  const subs3 = [{ id: 'bounded-c1', role: '', label: '' }, { id: 'bounded-c2', role: '', label: '' }, { id: 'bounded-c3', role: '', label: '' }];
  const seen = [];
  for (let round = 0; round < 4; round++) {
    resetRoleReadBudget();
    await resolveSubRoles(ctx, subs3, {}, { maxReads: 1 });
    seen.push(roleReadBudgetSnapshot().deferred);
  }
  check(JSON.stringify(seen) === JSON.stringify([2, 1, 0, 0]),
    'pending **单调下降**至 0（旧实现实测 16→40 上涨：每请求从零重算，预算永远喂队首）', seen.join('→'));
  check(subs3.every((x) => x.role === 'backend'),
    '解析结果写回且永久缓存（已结束会话的角色不可变）', subs3.map((x) => x.role).join(','));

  // 低频后台：读过一次后进入节流窗口
  const { roleReadAllowance, _resetBoundedState } = _live;
  _resetBoundedState();
  const first = roleReadAllowance(Date.now());
  resetRoleReadBudget();
  await resolveSubRoles(ctx, [{ id: 'bounded-d1', role: '', label: '' }], {}, { maxReads: 1 });
  const second = roleReadAllowance(Date.now());
  check(first >= 1 && second === 0,
    '低频后台语义：窗口到点才允许读；读过一次后**立刻再问应为 0**（两次之间 ≥ N 秒）',
    'first=' + first + ' second=' + second);
}

console.log('\n③ 负载与呈现：rolesPending 单一真源 + 客户端真的渲染 + degraded 取值可区分');
{
  const cmdSrc = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  const clientSrc = readFileSync(join(here, 'client.js'), 'utf8');
  check(/rolesPending: budget\.deferred/.test(cmdSrc), '负载里字段名是 `rolesPending`（"还没解析"）', '');
  check(!/rolesDeferred:/.test(cmdSrc), '旧名 `rolesDeferred:` 已不再作为字段出现（单一真源，不留两个名字）', '');
  check(clientSrc.includes('rolesPending'), '客户端**真的渲染**"待解析"（字段不是没人读的摆设）', '');
  // 2026-09-16 性能收口后 `degraded` 的取值空间**收窄**了（这是加强，不是放松）：
  //   · `subs:deadline` 仍在（子代理行枚举的期限截断，仍在请求路径上）；
  //   · `roles:deadline` **移出** degraded —— 请求路径现在一条日志都不读，读日志挪到后台单飞批；
  //     "后台批被期限截断"这件事由 `rolesPending`（跨轮推进会下降）与 profile 的 rolesWarm 表达，
  //     而不是把"我还没解析完"当告警每轮刷（那会把真告警一起降权）。
  check(/subs:deadline/.test(cmdSrc) && !/degraded\.push\('roles:deadline'\)/.test(cmdSrc),
    'degraded 只承载**请求路径上**的真截断（subs:deadline）；roles 读日志已离开请求路径', '');
  // 反向护栏：请求路径不许再出现那两种"全量读"，它们正是"窗口重开 1–3 s"的来源。
  check(/await resolveSubRoles\(ctx, subs, wfLabels, \{ maxReads: 0 \}\)/.test(cmdSrc),
    '请求路径的角色解析是 `maxReads: 0`（零日志读）', '');
  check(!/await workflowChildLabels\(ctx, peopleSid\)/.test(cmdSrc),
    '请求路径不再 await `workflowChildLabels`（全量父会话日志读已挪到后台预热）', '');
  check(/await workflowEventIndexForRequest\(ctx, peopleSid\)/.test(cmdSrc),
    '改为 `workflowEventIndexForRequest`：有快照一次不等、没快照只按**有界**期限等一小会儿', '');
  // warming 与 degraded **两个承载位**，语义不许混
  check(/warming\.length \? \{ warming: warming\.slice\(\) \}/.test(cmdSrc) && /degraded\.length \? \{ degraded: true/.test(cmdSrc),
    '`warming`（后台刷新中）与 `degraded`（真截断）分开承载', '');
  check(/wfIdx\.state === 'missing'\) warming\.push\('wf'\)/.test(cmdSrc),
    'wf 的 warming 判据是"**根本没有快照**"（missing），不是"备忘过期" —— 否则标记常亮成噪声', '');
  check(/wfIndex: \{ state: wfIdx\.state, ageMs: wfIdx\.ageMs/.test(cmdSrc),
    '快照新鲜度（state/ageMs）随负载下发：stale = 上一份完整快照，不假装是最新', '');
  check(/clientSrc \(client\.js\) \? 1 : 1/.test('clientSrc (client.js) ? 1 : 1') && /exp-warming/.test(clientSrc),
    '客户端**真的渲染** warming（`.exp-warming` 标签存在，不是没人读的字段）', '');
  check(/warmingSeg/.test(clientSrc) && /wfWarming/.test(clientSrc),
    '客户端把 warming 落到具体分段文案（且流转视图据此改口，不再编"无创建时间记录"）', '');
  // 噪声纪律：节流窗口内每轮都会命中 ⇒ 绝不能每轮都进 degraded（否则降级标记长期挂着，
  // 真告警被一起降权）。节流的事实由 subsPending / rolesPending 表达。
  check(!/degraded\.push\('subs:throttled'\)/.test(cmdSrc), '节流**不进** degraded（面板不许长期挂降级标记）', '');
  check(/rolesPending: budget\.deferred, subsPending/.test(cmdSrc), '成员细节不可得由负载里的 `subsPending` 诚实表达（缩写形式也要认）', '');
  check(/unresolved/.test(cmdSrc) && /deferred: ROLE_PENDING\.length/.test(cmdSrc),
    '"还没解析"（deferred/pending）与"解析不出来"（unresolved）仍是两个数', '');
}

console.log('\n④ profile 的键空间：分步耗时与附带账本不许同名互相覆盖');
{
  const { assembleStateProfile } = _live;
  // 真实事故：`mark('subs')` 写 steps.subs = 毫秒，而附带账本里的 subs 计数器**也叫 subs**，
  // 合成时后者盖掉前者 ⇒ 那一步的耗时在 profile 里根本看不见（上一轮只能靠"各步之和与总耗时之差"反推）。
  const merged = assembleStateProfile({ subs: 7, tail: 1 }, {
    rolesBudget: { deferred: 0 },
    subsCounters: { enumCalls: 0, cut: '' },
  });
  check(merged.subs === 7, '`profile.subs` 仍是**该步耗时**（数值），没被计数器覆盖', 'subs=' + JSON.stringify(merged.subs));
  check(merged.subsCounters && merged.subsCounters.enumCalls === 0 && merged.subsCounters.cut === '',
    '计数器在 `profile.subsCounters` 里**同时可见**（两本账都读得到）', 'subsCounters=' + JSON.stringify(merged.subsCounters));
  check(merged.rolesBudget && merged.rolesBudget.deferred === 0 && merged.tail === 1,
    '其它附带账本与步耗时都不受影响', 'keys=' + Object.keys(merged).join(','));

  // 撞名**绝不静默**：步耗时优先保留（测量值丢了就没法复现），并把撞名如实记进响应。
  const collided = assembleStateProfile({ subs: 7 }, { subs: { enumCalls: 0 } });
  check(collided.subs === 7 && JSON.stringify(collided.profileKeyCollisions) === JSON.stringify(['subs']),
    '再撞名时不静默覆盖：保住步耗时并把撞名记进 `profileKeyCollisions`',
    'subs=' + JSON.stringify(collided.subs) + ' collisions=' + JSON.stringify(collided.profileKeyCollisions));

  // 接线本身也要被钉住：路由必须**经由**该函数合成，且不再有"直接 Object.assign 覆盖"的老写法。
  const cmdSrc = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  check(/profile: assembleStateProfile\(prof\.steps, \{/.test(cmdSrc),
    '路由确实经由 `assembleStateProfile` 合成 profile（函数不是导出来当摆设）', '');
  check(!/profile: Object\.assign\(\{\}, prof\.steps/.test(cmdSrc),
    '旧的"直接 Object.assign 覆盖"写法已消失（它正是撞名覆盖的来源）', '');
  check(/subsCounters: \{/.test(cmdSrc) && !/subs: \{\n\s+cut: SUB_HEADER_STATS/.test(cmdSrc),
    '计数器键名是 `subsCounters`，不再占用 `subs`', '');
}

console.log('\n⑤ warming 语义：重读挪到后台 + 过期先给完整旧快照 + 读失败不覆盖好快照');
{
  const { workflowEventIndexCached, warmWorkflowEventIndex, _resetWfEventMemo, WF_EVENT_STATS, WF_EVENT_CACHE,
    warmSubRoles, _resetRoleWarm, isRoleWarmRunning, resolveSubRoles, roleReadBudgetSnapshot, _resetBoundedState,
    wfWarmDelayMs, rolesWarmDelayMs } = _live;
  // ⚠️ 2026-09-16 同机 A/B 的教训：把全量读"挪到后台"**还不够** —— 它是 CPU 密集型、跑在同一个
  // 事件循环上，如果 kick 之后立刻开跑，就会抢在触发它的那一发请求收尾之前占住循环
  // （实测 `wfLabels` 步 0 ms、`assemble` 步 441 ms：时间没消失，只是换了地方计入）。
  // 所以后台批必须**延迟**开跑；这条断言就是那次教训的棘轮。
  delete process.env.DSH_EXPERT_TEAM_WF_WARM_DELAY_MS;
  delete process.env.DSH_EXPERT_TEAM_ROLES_WARM_DELAY_MS;
  check(wfWarmDelayMs() > 0, 'workflow 后台预热默认**延迟**开跑（不抢触发它的那一发的收尾）', wfWarmDelayMs() + 'ms');
  check(rolesWarmDelayMs() > 0, '角色后台批同样延迟开跑', rolesWarmDelayMs() + 'ms');
  process.env.DSH_EXPERT_TEAM_WF_WARM_DELAY_MS = '10';
  process.env.DSH_EXPERT_TEAM_ROLES_WARM_DELAY_MS = '10';
  let reads = 0;
  let mode = 'ok';
  const events = [{ type: 'tool-workflow/agent-start', time: 1000, data: { runId: 'R1', childId: 'c1', label: '[pm]', seq: 1 } }];
  const ctx = {
    get: (k) => (k === 'sessionQuery' ? {
      readSession: async () => {
        reads += 1;
        if (mode === 'throw') throw new Error('read boom');
        return { events };
      },
    } : null),
  };
  _resetWfEventMemo();
  // ① 没有快照：请求路径**立刻**返回，不等那次全量父会话日志读
  const t0 = Date.now();
  const first = workflowEventIndexCached(ctx, 'sess-warm');
  const firstMs = Date.now() - t0;
  check(firstMs < 50, '没有快照时请求路径**立刻返回**（不等全量父会话日志读）', firstMs + 'ms');
  check(first.state === 'missing' && first.refreshing === true,
    '如实标 missing + refreshing（上层据此标 warming）', JSON.stringify({ state: first.state, refreshing: first.refreshing }));
  check(reads === 0, '同步阶段**一次读都没发**（我们没 await 那个后台批）', 'reads=' + reads);
  // ② 后台读完 ⇒ 下次命中完整快照，**不许**标 warming
  await warmWorkflowEventIndex(ctx, 'sess-warm');
  const fresh = workflowEventIndexCached(ctx, 'sess-warm');
  check(fresh.state === 'fresh' && fresh.refreshing === false && fresh.labels.size === 1,
    '后台读完后 = fresh、数据完整（数据其实完整时**不许**标 warming）',
    JSON.stringify({ state: fresh.state, labels: fresh.labels.size }));
  // ③ 过期（人为把 at 改老，不真等 30 s）⇒ 先给**上一份完整快照**，同时踢后台刷新
  WF_EVENT_CACHE.get('sess-warm').at = Date.now() - 60000;
  const stale = workflowEventIndexCached(ctx, 'sess-warm');
  check(stale.state === 'stale' && stale.labels.size === 1 && stale.refreshing === true,
    '过期 ⇒ 立刻给上一份**完整**快照（不是空值）+ 踢后台刷新',
    JSON.stringify({ state: stale.state, labels: stale.labels.size, refreshing: stale.refreshing }));
  check(WF_EVENT_STATS.memoStale >= 1, '过期命中记进 `memoStale`（可测，不靠注释承诺）', 'memoStale=' + WF_EVENT_STATS.memoStale);
  // ④ 读失败 ⇒ **不许**用空结果覆盖好快照（两种零分得开）
  await warmWorkflowEventIndex(ctx, 'sess-warm');
  const errBefore = WF_EVENT_STATS.readErrors;
  mode = 'throw';
  WF_EVENT_CACHE.get('sess-warm').at = Date.now() - 60000;
  await warmWorkflowEventIndex(ctx, 'sess-warm');
  check(WF_EVENT_STATS.readErrors > errBefore, '读失败被如实计数（`readErrors`）', 'readErrors=' + WF_EVENT_STATS.readErrors);
  check(WF_EVENT_CACHE.get('sess-warm').labels.size === 1,
    '读失败**没有**把已有的 1 条 label 抹成空', 'labels=' + WF_EVENT_CACHE.get('sess-warm').labels.size);
  mode = 'ok';
  // ⑤ roles：请求路径零读，读日志全部交给后台单飞批
  _resetRoleWarm();
  _resetBoundedState();
  const subsR = [{ id: 'warm-r1', role: '', label: '' }];
  await resolveSubRoles(ctx, subsR, {}, { maxReads: 0 });
  check(subsR[0].role === '' && roleReadBudgetSnapshot().deferred === 1,
    '请求路径 `maxReads: 0`：零日志读，缺的如实"待解析"', 'deferred=' + roleReadBudgetSnapshot().deferred);
  const readsBefore = reads;
  const p1 = warmSubRoles(ctx, subsR, {}, { maxReads: 1, deadlineMs: 1000 });
  check(!!p1 && isRoleWarmRunning() === true, '后台批已踢出（单飞标记在位）', '');
  const p2 = warmSubRoles(ctx, subsR, {}, { maxReads: 1, deadlineMs: 1000 });
  check(p2 === null, '同刻再踢 ⇒ null（**单飞**：绝不并发全量读日志 —— 那是 283.6 s 冷态的老根因）', '');
  await p1;
  check(isRoleWarmRunning() === false && reads > readsBefore,
    '后台批读完后单飞标记复位、确实读了日志', 'readDelta=' + (reads - readsBefore));
  check(warmSubRoles(ctx, subsR, {}, { maxReads: 1, deadlineMs: 1000 }) === null,
    '队列空时返回 null（没有可做的活 ⇒ 上层不标 warming，标记才不会是常亮噪声）', '');
  check(roleReadBudgetSnapshot().deferred === 0, '后台批把队列读空（deferred 单调下降至 0）', '');
}

console.log('\n⑥ 上限与真故障必须分开承载（1.3.22）：`scopeCaps` ≠ `degraded`');
{
  const cmdSrc2 = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  const clientSrc2 = readFileSync(join(here, 'client.js'), 'utf8');
  const { classifyStateShortfall } = _live;
  check(typeof classifyStateShortfall === 'function', '纯函数 `classifyStateShortfall` 可单测（判据单一真源）', '');

  // ① 只发生"按设计的上限" ⇒ scopeCaps 数字正确、**degraded 不许被设置**
  const capOnly = classifyStateShortfall({ caps: [{ key: 'roles', total: 95, limit: 60 }, { key: 'feed', total: 95, limit: 60 }] });
  check(capOnly.degraded.length === 0,
    '① 只有上限 ⇒ `degraded` **不**被设置（真机 95 agent/上限 60 时不再常亮）', JSON.stringify(capOnly.degraded));
  check(capOnly.scopeCaps.roles && capOnly.scopeCaps.roles.over === 35 && capOnly.scopeCaps.roles.limit === 60 && capOnly.scopeCaps.roles.total === 95,
    '① 上限数字一个不少（over/limit/total 三样都在，不是只报一个 35）', JSON.stringify(capOnly.scopeCaps));
  check(capOnly.scopeCaps.feed && capOnly.scopeCaps.feed.over === 35, '① feed 的上限同样如实上报', JSON.stringify(capOnly.scopeCaps.feed));

  // ② 软期限截断（真故障）⇒ degraded 仍被设置，且**不许**被塞进 scopeCaps
  const cutOnly = classifyStateShortfall({ cuts: ['subs:deadline'] });
  check(cutOnly.degraded.join(',') === 'subs:deadline' && Object.keys(cutOnly.scopeCaps).length === 0,
    '② 软期限截断 ⇒ `degraded` 仍被设置，且**没有**混进 scopeCaps（不许把真故障当上限灭灯）',
    JSON.stringify({ degraded: cutOnly.degraded, scopeCaps: cutOnly.scopeCaps }));

  // ③ 读失败（真故障）⇒ degraded 仍被设置
  const errOnly = classifyStateShortfall({ readErrors: ['wf:read-error'] });
  check(errOnly.degraded.join(',') === 'wf:read-error' && Object.keys(errOnly.scopeCaps).length === 0,
    '③ 读失败 ⇒ `degraded` 仍被设置（旧实现把它混进 warming = 把故障伪装成"刷新中"）',
    JSON.stringify({ degraded: errOnly.degraded, scopeCaps: errOnly.scopeCaps }));

  // ④ 上限与真截断同时发生 ⇒ 两个承载位都如实出现（不许二选一）
  const both = classifyStateShortfall({ cuts: ['wf:deadline'], readErrors: ['wf:read-error'], caps: [{ key: 'roles', total: 95, limit: 60 }] });
  check(both.degraded.join(',') === 'wf:deadline,wf:read-error' && both.scopeCaps.roles.over === 35,
    '④ 上限与真截断同时发生 ⇒ 两者都如实出现（degraded 有故障、scopeCaps 有上限）',
    JSON.stringify({ degraded: both.degraded, scopeCaps: both.scopeCaps }));

  // ⑤ 没越限就不许无中生有（否则"上限"会变成一个假的常亮标记）
  const noCap = classifyStateShortfall({ caps: [{ key: 'roles', total: 60, limit: 60 }, { key: 'feed', total: 59, limit: 60 }] });
  check(Object.keys(noCap.scopeCaps).length === 0, '⑤ 恰好等于/低于上限 ⇒ `scopeCaps` 为空（不无中生有）', JSON.stringify(noCap.scopeCaps));

  // 服务端接线：上限**不再**进 degraded，且事实全部经纯函数收敛
  check(!/degraded\.push\('roles:'/.test(cmdSrc2) && !/degraded\.push\('feed:'/.test(cmdSrc2),
    '服务端：`roles:N` / `feed:N` 已**移出** degraded（不再每轮常亮）', '');
  check(/capFacts\.push\(\{ key: 'roles', total: subs\.length, limit: MAX_ROLE_SUBS \}\)/.test(cmdSrc2)
    && /capFacts\.push\(\{ key: 'feed', total: subs\.length, limit: MAX_FEED_AGENTS \}\)/.test(cmdSrc2),
    '服务端：上限以**事实**形式收集（数字来自实际条数与真实上限常量，不是手写的字符串）', '');
  check(/const marks = classifyStateShortfall\(\{ cuts: cutFacts, caps: capFacts \}\)/.test(cmdSrc2),
    '服务端：两个承载位由同一个纯函数下判据（单一真源，可单测）', '');
  check(/Object\.keys\(scopeCaps\)\.length \? \{ scopeCaps \} : null/.test(cmdSrc2),
    '服务端：`scopeCaps` 真的随负载下发（不是只算不发）', '');
  check(/WF_EVENT_STATS\.readErrors > wfErrBefore\) cutFacts\.push\('wf:read-error'\)/.test(cmdSrc2),
    '服务端：读失败按**本次请求的增量**判定并进 degraded（IO 错 ≠ "还没有快照"）', '');

  // 客户端：上限必须**显式渲染**（不报警 ≠ 隐藏），且三个标记样式互不相同
  check(/exp-scope/.test(clientSrc2) && /capKeys\.length \? h\('span', \{ className: 'exp-scope'/.test(clientSrc2),
    '客户端：`scopeCaps` 落到 `.exp-scope` 徽章（字段不是没人读的摆设）', '');
  check(/exp-warming\{[^}]*dashed/.test(clientSrc2) && /exp-scope\{[^}]*solid/.test(clientSrc2),
    '客户端：warming（虚线）与 scope（实线）样式区分开 —— 上限不伪装成告警，也不被静默吞掉', '');
  check(/capOver \+ ' 条按上限只列名'/.test(clientSrc2),
    '客户端：徽章文案带**条数**（"另有 N 条按上限只列名"），不是一句含糊的"部分数据"', '');
  // 防"标记粘住"：标记只在非空时下发，合并若"缺键即保留"就会永久粘住（常亮噪声）
  check(/if \(secs\.indexOf\('people'\) >= 0\) \{[\s\S]{0,160}?if \(!d\.warming\) delete out\.warming[\s\S]{0,160}?if \(!d\.scopeCaps\) delete out\.scopeCaps/.test(clientSrc2),
    '客户端：重分节重算过的标记在**缺席时被清掉**（否则"更新中"一旦出现就永远消不掉）', '');
}


console.log('\n⑦ 后台角色批必须**真的干活**（1.3.23）：期限从"开跑"起算 + 零进展必须可见且自灭');
{
  const cmdSrc3 = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  const {
    warmSubRoles, _resetRoleWarm, isRoleWarmRunning, resolveSubRoles, roleReadBudgetSnapshot,
    _resetBoundedState, _resetRolePending, resetRoleReadBudget, ROLE_READ_LOG_CACHE,
    ROLE_WARM_STATS, roleWarmHasWork, classifyStateShortfall,
  } = _live;

  const mkCtx = (onRead) => ({
    get: (k) => (k === 'sessionQuery' ? {
      readSession: async () => {
        if (onRead) onRead();
        return { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: '你是「专家团」的后端工程师（backend，动态补位角色）' }] } }] };
      },
    } : null),
  });
  /** 干净起点：清缓存/队列/节流窗口/额度，返回给定的 subs。 */
  const fresh = (ids) => {
    ROLE_READ_LOG_CACHE.clear(); _resetRolePending(); _resetBoundedState(); resetRoleReadBudget();
    return (ids || ['warm-t1']).map((id) => ({ id, role: '', label: '' }));
  };

  // ── ① 回归本体（1.3.22 的真回归：按构造**零读**）──────────────────────────────
  // 旧实现：调用方在 **kick 那一刻**算好绝对期限（Date.now() + ROLES_READ_DEADLINE_MS = 600 ms），
  // 而这一批要延迟 rolesWarmDelayMs()（默认 1000 ms）才开跑 ⇒ 1000 > 600 恒成立 ⇒
  // resolveSubRoles 的 while 在**第一次读之前**就 cut='deadline' break ⇒ 一条都不读。
  // 这里把两个数字都调小、但保持**同一个大小关系**（延迟 150 ms > 期限 60 ms），并**故意保留旧调用
  // 形状**（多传一个 kick 时算好的绝对 deadlineAt，新实现只认 deadlineMs）—— 这条断言就是那次
  // 回归的棘轮：只要有人再把期限挪回 kick 时计算，它立刻变红。
  process.env.DSH_EXPERT_TEAM_ROLES_WARM_DELAY_MS = '150';
  let readsA = 0;
  const subsA = fresh(['warm-a1']);
  await resolveSubRoles(mkCtx(), subsA, {}, { maxReads: 0 });
  const pA = warmSubRoles(mkCtx(() => { readsA += 1; }), subsA, {}, {
    maxReads: 1,
    deadlineMs: 60,                 // 新：**时长**，从批开跑那一刻起算
    deadlineAt: Date.now() + 60,    // 旧形状残留：kick 时算好的绝对时刻（延迟一过即过期）
  });
  check(!!pA, '① 批被踢出（队列里确实有未缓存的活）', '');
  await pA;
  check(readsA === 1 && ROLE_WARM_STATS.lastReads === 1,
    '① 延迟(150 ms) > 期限(60 ms) 时仍**必须读完这一条**（期限从开跑起算）—— 1.3.22 在这里恒为 0 读',
    'reads=' + readsA + ' lastReads=' + ROLE_WARM_STATS.lastReads);
  check(roleReadBudgetSnapshot().deferred === 0, '① 队列真的前进了（deferred → 0）', 'deferred=' + roleReadBudgetSnapshot().deferred);
  check(ROLE_WARM_STATS.noProgress === false, '① 有进展 ⇒ 零进展标记不点亮', 'noProgress=' + ROLE_WARM_STATS.noProgress);

  // ── ② "注定做不了活"的路径不许踢批（否则上层会挂一个永远不动的 warming）────────
  process.env.DSH_EXPERT_TEAM_ROLES_WARM_DELAY_MS = '10';
  const subsB = fresh(['warm-b1']);
  check(warmSubRoles(mkCtx(), subsB, {}, { maxReads: 0, deadlineMs: 1000 }) === null,
    '② maxReads: 0（没额度）⇒ null，不标 warming', '');
  check(warmSubRoles(mkCtx(), subsB, {}, { maxReads: 1, deadlineMs: 1000 }) === null,
    '② 队列空 ⇒ null（没有可做的活；否则"更新中"会常亮成噪声）', '');
  check(typeof roleWarmHasWork === 'function' && roleWarmHasWork() === false,
    '② 谓词 roleWarmHasWork() 可单测：无未缓存 id ⇒ false（队列非空 ≠ 有活）', '');
  const subsB2 = fresh(['warm-b2']);
  await resolveSubRoles(mkCtx(), subsB2, {}, { maxReads: 1 });
  check(typeof roleWarmHasWork === 'function' && warmSubRoles(mkCtx(), subsB2, {}, { maxReads: 1, deadlineMs: 1000 }) === null && roleWarmHasWork() === false,
    '② 队列里全是**已缓存** id ⇒ 同样 null（诚实说明：这条经公开 API 不易端到端构造，'
      + 'syncRolePending 今天就会让已缓存的掉队；这里测的是谓词与新加的早退分支本身）', '');

  // ── ③ 零进展 = 真故障：必须可见（degraded），且**恢复后自灭**────────────────────
  const subsC = fresh(['warm-c1']);
  await resolveSubRoles(mkCtx(), subsC, {}, { maxReads: 0 });
  let readsC = 0;
  await warmSubRoles(mkCtx(() => { readsC += 1; }), subsC, {}, { maxReads: 1, deadlineMs: -1 }); // 期限已过期
  check(readsC === 0 && ROLE_WARM_STATS.lastReads === 0 && ROLE_WARM_STATS.noProgress === true,
    '③ 有活、有期限，却一条都没读成 ⇒ noProgress 点亮（既不是"按设计上限"，也不是"刷新在飞"）',
    'reads=' + readsC + ' noProgress=' + ROLE_WARM_STATS.noProgress);
  const dC = classifyStateShortfall({ cuts: ['roles:no-progress'] });
  check(dC.degraded.join(',') === 'roles:no-progress' && Object.keys(dC.scopeCaps).length === 0,
    '③ 零进展走 degraded，且**没有**混进 scopeCaps（两件事不许互相冒充）',
    JSON.stringify({ degraded: dC.degraded, scopeCaps: dC.scopeCaps }));
  const pC = warmSubRoles(mkCtx(() => { readsC += 1; }), subsC, {}, { maxReads: 1, deadlineMs: 1000 });
  check(!!pC, '③ 队列还在 ⇒ 还能再补一批（进度可以追回来）', '');
  await pC;
  check(readsC === 1 && ROLE_WARM_STATS.noProgress === false,
    '③ 恢复后**自己灭掉**（不然又是一盏常亮灯）',
    'reads=' + readsC + ' noProgress=' + ROLE_WARM_STATS.noProgress);

  // ── ④ 排进队列后、批开跑前被别处读掉 ⇒ 零读但**不是故障**（不许误报）─────────────
  process.env.DSH_EXPERT_TEAM_ROLES_WARM_DELAY_MS = '120';
  const subsD = fresh(['warm-d1']);
  await resolveSubRoles(mkCtx(), subsD, {}, { maxReads: 0 });
  const pD = warmSubRoles(mkCtx(), subsD, {}, { maxReads: 1, deadlineMs: 1000 });
  check(!!pD, '④ 批已踢出（此刻确实有活）', '');
  resetRoleReadBudget();
  await resolveSubRoles(mkCtx(), subsD, {}, { maxReads: 1 });   // 抢在批开跑前把它读掉
  await pD;
  check(ROLE_WARM_STATS.lastReads === 0 && ROLE_WARM_STATS.noProgress === false,
    '④ 开跑时队列已被读空 ⇒ 这一批自己读 0 条，但**不是故障**（不许误报零进展）',
    'lastReads=' + ROLE_WARM_STATS.lastReads + ' noProgress=' + ROLE_WARM_STATS.noProgress);

  // ── ⑤ 上限（scopeCaps）与故障（degraded）同时出现也必须各归各位 ────────────────
  const mixed = classifyStateShortfall({ cuts: ['roles:no-progress'], caps: [{ key: 'roles', total: 95, limit: 60 }] });
  check(mixed.degraded.join(',') === 'roles:no-progress' && mixed.scopeCaps.roles.over === 35,
    '⑤ 上限与零进展同时发生 ⇒ 各归各位（degraded 有故障、scopeCaps 有上限）',
    JSON.stringify({ degraded: mixed.degraded, scopeCaps: mixed.scopeCaps }));

  // ── ⑥ 接线棘轮（源码级）：防止"期限又挪回 kick 时算"或"零进展不再上报"────────────
  check(/warmSubRoles\(ctx, subs\.slice\(0, MAX_ROLE_SUBS\), wfLabels, \{ maxReads: rolesAllowance, deadlineMs: ROLES_READ_DEADLINE_MS \}\)/.test(cmdSrc3),
    '⑥ 生产接线传的是**时长** deadlineMs（绝对期限在批开跑时才计算）', '');
  check(!/deadlineAt: Date\.now\(\) \+ ROLES_READ_DEADLINE_MS/.test(cmdSrc3),
    '⑥ 旧的"kick 时算好绝对期限"形状已消失 —— 它就是零读回归的来源', '');
  check(/ROLE_WARM_STATS\.noProgress && roleWarmHasWork\(\)\) cutFacts\.push\('roles:no-progress'\)/.test(cmdSrc3),
    '⑥ 零进展经 cutFacts 进 degraded，且"队列已无未缓存 id"时不再报（自灭的一半）', '');
  check(/if \(stats\.reads > 0 \|\| stats\.queued === 0\) \{ ROLE_WARM_STATS\.noProgress = false; \}/.test(cmdSrc3),
    '⑥ 恢复即清零：读到东西 / 队列读空都算恢复（自灭的另一半）', '');
  check(/ROLE_READS_LEFT = Math\.max\(ROLE_READS_LEFT, maxReads\);\n\s+resolveSubRoles\(ctx, subs, wfLabels, \{ maxReads, deadlineAt: Date\.now\(\) \+ deadlineMs, stats \}\)/.test(cmdSrc3),
    '⑥ 额度与期限都在**开跑那一刻**才定（中间插入的请求把它复位成 0 也不会让本批空转）', '');
  // 只在 `warmSubRoles` 体内判"不认绝对时刻"：`resolveSubRoles` 自己仍收绝对 `deadlineAt`，
  // 那是**批开跑时**算出来的，正是我们要的形状 —— 一刀切成全局禁词会把正确用法也判红。
  const warmFn = (cmdSrc3.match(/function warmSubRoles\([\s\S]*?\n}\n/) || [''])[0];
  check(warmFn.length > 0 && !/opts\.deadlineAt/.test(warmFn) && /Number\.isFinite\(opts\.deadlineMs\)/.test(warmFn),
    '⑥ warmSubRoles 体内只认**时长** deadlineMs、不再认绝对 deadlineAt（让"延迟"与"期限"再也没法互相打架）',
    'fnLen=' + warmFn.length);
  delete process.env.DSH_EXPERT_TEAM_ROLES_WARM_DELAY_MS;
}

console.log('');
if (fail > 0) {
  console.log(`✗ 有界化护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 有界化护栏通过（subs 节流/期限 · roles 零读/期限/收敛 · 字段单一真源且被渲染 · 上限与真故障分开承载 · 后台批真的干活且零进展可见自灭）');
