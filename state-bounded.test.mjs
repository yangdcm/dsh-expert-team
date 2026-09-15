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
  const p1 = warmSubRoles(ctx, subsR, {}, { maxReads: 1, deadlineAt: Date.now() + 1000 });
  check(!!p1 && isRoleWarmRunning() === true, '后台批已踢出（单飞标记在位）', '');
  const p2 = warmSubRoles(ctx, subsR, {}, { maxReads: 1, deadlineAt: Date.now() + 1000 });
  check(p2 === null, '同刻再踢 ⇒ null（**单飞**：绝不并发全量读日志 —— 那是 283.6 s 冷态的老根因）', '');
  await p1;
  check(isRoleWarmRunning() === false && reads > readsBefore,
    '后台批读完后单飞标记复位、确实读了日志', 'readDelta=' + (reads - readsBefore));
  check(warmSubRoles(ctx, subsR, {}, { maxReads: 1, deadlineAt: Date.now() + 1000 }) === null,
    '队列空时返回 null（没有可做的活 ⇒ 上层不标 warming，标记才不会是常亮噪声）', '');
  check(roleReadBudgetSnapshot().deferred === 0, '后台批把队列读空（deferred 单调下降至 0）', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 有界化护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 有界化护栏通过（subs 节流/期限 · roles 零读/期限/收敛 · 字段单一真源且被渲染）');
