// /state 性能与"假 id 不落盘"的回归护栏（2026-09-15，1.3.5）。
//
// 背景（实测数字，写在 CHANGELOG 1.3.5 里）：`GET /plugins/dsh-expert-team/state` 曾热态 7.1–9.8 s、
// 冷态 **283.6 s**，而面板绘制只要 52 ms。根因之一：端点对**每个**子会话 await
// `childSessionTiming`，它会对"活存储里查不到"的子代理退回 `sessionQuery.readSession(id)`
// —— 那是全量读该子会话日志（本机 21 条 = 23.6 MiB zstd / ~31,000 事件）。
// 请求还压在事件循环上，把整个 dsh web 拖慢（轻量端点 /settings 涨到 20.7 s / 42.5 s）。
//
// 本文件钉住三件事，缺一条都会让上面那类退化**静默复活**：
//   ① 热路径只查表（subHeaderIndex）——**零次** readSession；
//   ② 客户端 single-flight + 退避（未回不发下一个、单发越慢下次越晚）；
//   ③ 假 sessionId 不落盘（sessionExists 守卫）。
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
const { USAGE } = await import(join(here, 'lib', 'command-parse.js'));
const { subHeaderIndex, sessionExists, resolveRosterDefaults, parseTeamCommand } = _live;

const cmdSrc = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
const clientSrc = readFileSync(join(here, 'client.js'), 'utf8');

console.log('① subHeaderIndex：热路径只查表，**永不**读日志');
{
  // spy：任何一次 readSession 都会被记下
  let reads = 0;
  const mkCtx = (liveHeader) => ({
    get: (n) => {
      if (n === 'sessionQuery') return { readSession: async () => { reads += 1; return { session: { createdAt: 1 } }; } };
      if (n === 'sessions') return { get: () => (liveHeader ? { header: liveHeader } : undefined) };
      return null;
    },
  });

  // 源①：listSessions 分支已经带出的 durable header 字段（不额外读任何日志）
  const fromRow = subHeaderIndex(mkCtx(null), [{ id: 'c-row', createdAt: 1700000000000, parentId: 'p-row', depth: 2 }], null);
  check(fromRow.get('c-row').createdAt === 1700000000000 && fromRow.get('c-row').parentId === 'p-row' && fromRow.get('c-row').depth === 2,
    '行上已有 header 字段 ⇒ 直接采用', JSON.stringify(fromRow.get('c-row')));

  // 源②：活存储（子代理还在跑）
  const fromLive = subHeaderIndex(mkCtx({ createdAt: 1700000001111, parentSession: 'p-live', delegationDepth: 1 }), [{ id: 'c-live' }], null);
  check(fromLive.get('c-live').createdAt === 1700000001111 && fromLive.get('c-live').parentId === 'p-live' && fromLive.get('c-live').depth === 1,
    '活存储 header 可用 ⇒ 采用（不读日志）', JSON.stringify(fromLive.get('c-live')));

  // 源③：workflow 事件流的 startedAt（父会话日志已按 TTL 缓存）
  const wf = new Map([['c-wf', { startedAt: 1700000002222 }]]);
  const fromWf = subHeaderIndex(mkCtx(null), [{ id: 'c-wf' }], wf);
  check(fromWf.get('c-wf').createdAt === 1700000002222, 'workflow 事件流兜底 ⇒ 采用 startedAt', String(fromWf.get('c-wf').createdAt));

  // 三源都没有 ⇒ 保持 0/''/0（UI 如实降级「无时间记录」），**不许**退回读日志
  const none = subHeaderIndex(mkCtx(null), [{ id: 'c-none' }], null);
  check(none.get('c-none').createdAt === 0 && none.get('c-none').parentId === '' && none.get('c-none').depth === 0,
    '三源都拿不到 ⇒ 0/\'\'/0（如实降级，不臆造）', JSON.stringify(none.get('c-none')));

  check(reads === 0, '**全程零次 readSession**（这就是 283.6 s 的根因，必须钉死）', 'reads=' + reads);

  // 源码级：/state 的两个 timing 调用点都不得再出现 childSessionTiming
  const hotCalls = cmdSrc.split('await childSessionTiming(ctx, s.id)').length - 1;
  check(hotCalls === 0, 'lib/command.js 里不再有 `await childSessionTiming(ctx, s.id)`（热路径调用点）', '命中 ' + hotCalls + ' 次');
  // 3 处 = 1 处定义 + 2 处调用点（定义 `function subHeaderIndex(ctx, subs, wfLabels) {` 也命中这个串）
  check((cmdSrc.split('subHeaderIndex(ctx, subs, wfLabels)').length - 1) === 3, '两个 timing 调用点都改用 subHeaderIndex（另 1 处是定义）', '命中 ' + (cmdSrc.split('subHeaderIndex(ctx, subs, wfLabels)').length - 1) + ' 次');
}

console.log('\n② 客户端：**所有** /state 拉取经统一 hub（single-flight + 退避 + 单时钟）');
{
  // 2026-09-15 性能修复 #2：面板/徽章/画布曾各有一套轮询（画布一开 ⇒ 10 秒 7 发、6 次重叠、
  // 单发被拖到 5.9/8.3 s）。现在只有一个 hub，下面每条都钉住那个结构。
  const bare = clientSrc.split("fetch('/plugins/dsh-expert-team/state").length - 1;
  check(bare === 0, '不再有任何裸的 /state fetch（全部经 stateHubFetch）', '命中 ' + bare + ' 次');
  check(/function stateHubFetch\(url, onData\)/.test(clientSrc) && /if \(p\) \{ p\.then/.test(clientSrc),
    'stateHubFetch 有 in-flight 合并（同 URL 同刻只跑一次，后来者复用在飞结果）', '');
  check((clientSrc.split('delete stateHub.inflight[url]').length - 1) === 2,
    '在飞标记在**成功与失败**两条路径都清理（否则一次失败就永久停摆）', '');
  check(/stateHub\.lastMs\[url\] = Math\.max\(0, stateHubNow\(\) - t0\)/.test(clientSrc), '记录每次 /state 耗时（退避依据）', '');
  // ⚠️ 2026-09-15 性能修复 #3 之后公式变了（**更强**：按 URL 各自计时 + 一快一慢双订阅）。
  // 旧断言钉的是"全局取最小 base、每 tick 拉全部 URL"的形状，那正是"慢端点被快钟拖着跑"的根源。
  check(/var next = Math\.max\(wait, Math\.min\(30000, Math\.round\(slowest \* 2\)\)\)/.test(clientSrc),
    '退避公式：max(最早到期等待, clamp(最慢一次×2, …, 30000))', '');
  check(/function stateHubDueAt\(u\) \{ return \(stateHub\.lastAt\[u\] \|\| 0\) \+ stateHubBaseOf\(u\) \}/.test(clientSrc),
    '按 **URL 各自**计时（stateHubBaseOf/DueAt）—— 一快一慢互不拖拽', '');
  check(/if \(stateHubDueAt\(u\) <= now && !stateHub\.inflight\[u\]\) stateHubFetch/.test(clientSrc),
    'tick 只发**已到期**的 URL（不再每 tick 把所有 URL 拉一遍）', '');
  check(/stateHub\.lastAt\[url\] = t0/.test(clientSrc), '失败也记发出时刻（否则失败会变热循环重试）', '');
  check((clientSrc.split('setInterval(stateHubTick').length - 1) === 1,
    '全局**只有一个** state 时钟（不再每个组件一个 setInterval）', '');
  // 首屏便宜、重块晚一拍：两条订阅都要在，且 summary 必须是最快的那条。
  check(/stateHubSubscribe\(stateUrl\('summary'\), dispCfg\.pollMs, onState\)/.test(clientSrc),
    '首屏订阅 `section=summary`（按 pollMs 快拉）', '');
  check(/stateHubSubscribe\(stateUrl\('people,feed,artifacts'\), Math\.max\(dispCfg\.pollMs, 6000\), onState\)/.test(clientSrc),
    '重块 `people,feed,artifacts` 低频拉（≥6 s）', '');
  check(/function mergeStatePayload\(prev, d\)/.test(clientSrc) && /return mergeStatePayload\(prev, d\)/.test(clientSrc),
    '分节负载**合并**而非替换（摘要那一拍不得把已知成员抹掉）', '');
  check(/stateHubSubscribe\(liveUrl\(sid\), LIVE_BASE_MS, liveDeliver\)/.test(clientSrc), '徽章/画布经 hub 订阅（不再自带 setInterval）', '');
  check(!/setInterval\(load, backoff\)/.test(clientSrc), '旧的组件内 setInterval(load, backoff) 已不存在（防改回去）', '');
  check(/function onState\(d\) \{/.test(clientSrc), '面板把"数据到达后的副作用"收敛成一个 onState(d)', '');
}

console.log('\n③ 假 sessionId 不落盘（sessionExists 守卫）');
{
  const noSess = { get: () => null };
  const withSess = { get: (n) => (n === 'sessions' ? { get: (id) => (id === 'real-1' ? { header: { id } } : undefined) } : null) };
  check(sessionExists(noSess, 'fake-1') === false, '查不到的 id ⇒ false（当只读）', '');
  check(sessionExists(withSess, 'real-1') === true, '真实存在的 id ⇒ true', '');
  check(sessionExists(withSess, '') === false, '空 id ⇒ false', '');
  check(/if \(sel && sessionExists\(ctx, sid\)\) rememberSessionRun\(sid, wsParam, runParam, 'view'\)/.test(cmdSrc),
    '唯一那处外部 sid 的 rememberSessionRun 已被 sessionExists 守卫', '');
}

console.log('\n④ 反向参数 --one-shot / --code（三态：true 要 / false 显式不要 / null 未表态）');
{
  check(parseTeamCommand('--one-shot 做事').persist === false, '--one-shot ⇒ persist 显式为 false', String(parseTeamCommand('--one-shot 做事').persist));
  check(parseTeamCommand('--code 做事').noCode === false, '--code ⇒ noCode 显式为 false', String(parseTeamCommand('--code 做事').noCode));
  check(parseTeamCommand('做事').persist === null && parseTeamCommand('做事').noCode === null, '未给 flag ⇒ null（听设置，不再与"显式否"混为一谈）', '');
  check(parseTeamCommand('--persist --one-shot 做事').persist === false, '同一命令里后写的 flag 生效（last-wins）', '');
  // USAGE 是 join('\n') 之后的**字符串**（不是数组）⇒ 用 includes
  check(USAGE.includes('--one-shot') && USAGE.includes('--code'), 'USAGE 里教了这两条（--one-shot / --code）', '');

  // 行为级：设置与 flag 的优先级（flag > 设置 > 常量）
  const rs = { 'roster.persist': true, 'roster.deliverable': 'artifacts-only', 'roster.defaultRoles': null };
  check(resolveRosterDefaults({ persist: false, noCode: false }, rs, ['pm']).persist === false, '设置 persist=true 时，--one-shot 仍能压过它',
    String(resolveRosterDefaults({ persist: false, noCode: false }, rs, ['pm']).persist));
  check(resolveRosterDefaults({ persist: false, noCode: false }, rs, ['pm']).noCode === false, '设置 artifacts-only 时，--code 仍能压过它',
    String(resolveRosterDefaults({ persist: false, noCode: false }, rs, ['pm']).noCode));
  check(resolveRosterDefaults({ persist: null, noCode: null }, rs, ['pm']).persist === true, '未表态时仍听设置（true）', '');
  check(resolveRosterDefaults({ persist: null, noCode: null }, rs, ['pm']).noCode === true, '未表态时仍听设置（artifacts-only）', '');
  check(resolveRosterDefaults({ persist: null, noCode: null }, { 'roster.persist': false, 'roster.deliverable': 'code+artifacts' }, ['pm']).persist === false,
    '设置未开 ⇒ 默认仍是一次性（未被三态改坏）', '');
}

console.log('\n⑤ 设置页页头那句「暂未生效」只在真有这种项时出现');
{
  check(/var hasInertMark = model\.some/.test(clientSrc), '客户端按 schema 里的 hint 标记计算 hasInertMark（与后端单一真源一致）', '');
  check(/esc\(hasInertMark\s*\n?\s*\? t\(/.test(clientSrc), '页头文案按 hasInertMark 条件渲染（表空 ⇒ 不再说"标着暂未生效的项"）', '');
}

console.log('\n④ 底盘：listSessions 只在**真缺人**时查，且并发/短 TTL 复用');
{
  const { cachedListSessions, _resetListSessionsCache, listSubagentStatusBySession, LIST_SESSIONS_TTL_MS } = _live;

  // (a) 缺人才查：人都还在活注册表里 ⇒ **一次 listSessions 都不发**
  _resetListSessionsCache();
  let listCalls = 0;
  const allLive = {
    get: (n) => {
      // 真实 sid ⇒ rootSessionId 认它是根会话 ⇒ listChildren 才会被调用（空 sid 时那一支整段跳过）
      if (n === 'sessions') return { get: (id) => ({ header: { id, origin: 'user' } }) };
      if (n === 'subagents') return { listChildren: async () => [{ id: 'k1', activity: 'running' }, { id: 'k2' }] };
      if (n === 'sessionQuery') return { listSessions: async () => { listCalls += 1; return [] } };
      return null;
    },
  };
  const rowsLive = await listSubagentStatusBySession(allLive, 'root-1', ['k1', 'k2']);
  check(rowsLive.length === 2 && listCalls === 0, '活注册表里人都在 ⇒ 整段跳过 listSessions（省掉 475-artifact 枚举）', 'listCalls=' + listCalls);

  // (b) 真缺人才查
  _resetListSessionsCache();
  let listCalls2 = 0;
  const oneMissing = {
    get: (n) => {
      if (n === 'sessions') return { get: (id) => ({ header: { id, origin: 'user' } }) };
      if (n === 'subagents') return { listChildren: async () => [{ id: 'k1' }] };
      if (n === 'sessionQuery') return { listSessions: async () => { listCalls2 += 1; return [{ header: { id: 'k9', createdAt: 42 } }] } };
      return null;
    },
  };
  const rowsMissing = await listSubagentStatusBySession(oneMissing, 'root-1', ['k1', 'k9']);
  check(listCalls2 === 1 && rowsMissing.some((r) => r.id === 'k9' && r.createdAt === 42),
    '缺的人（k9）才去 durable 列表里找，并把 header 字段带出来', 'listCalls=' + listCalls2);

  // (c) TTL 内复用
  _resetListSessionsCache();
  let c3 = 0;
  const q = { listSessions: async () => { c3 += 1; return [{ header: { id: 'a' } }] } };
  await cachedListSessions(q); await cachedListSessions(q);
  check(c3 === 1, 'TTL(' + LIST_SESSIONS_TTL_MS + 'ms) 内复用同一份枚举', 'calls=' + c3);

  // (d) 并发合并
  _resetListSessionsCache();
  let c4 = 0;
  const slow = { listSessions: () => { c4 += 1; return new Promise((r) => setTimeout(() => r([{ header: { id: 'b' } }]), 30)) } };
  const [x, y, z] = await Promise.all([cachedListSessions(slow), cachedListSessions(slow), cachedListSessions(slow)]);
  check(c4 === 1 && x === y && y === z, '同刻并发只跑一次枚举（in-flight 合并）—— 在飞重叠不再把同一份枚举重算 N 遍', 'calls=' + c4);

  // (e) 失败不毒化
  _resetListSessionsCache();
  let c5 = 0;
  const flaky = { listSessions: async () => { c5 += 1; if (c5 === 1) throw new Error('boom'); return ['ok'] } };
  let threw = false;
  try { await cachedListSessions(flaky) } catch { threw = true }
  const after = await cachedListSessions(flaky);
  check(threw && c5 === 2 && Array.isArray(after), '失败后清空在飞标记 ⇒ 下一次能重试（缓存不被毒化）', 'calls=' + c5);

  // 源码级：缓存注释必须写明"活代理不缓存"这条纪律
  check(/活代理.*实时读.*(绝不经过|不缓存)/.test(readFileSync(join(here, 'lib', 'command.js'), 'utf8')),
    '缓存纪律写死在注释里（活代理不缓存、只缓存已结束的 durable 列表）', '');

  // (f) 按 session id 备忘：**第二个请求起零枚举**（这才是把 subs 段打下去的手段）
  const { SUB_HEADER_MEMO, SUB_HEADER_STATS, _resetSubHeaderMemo } = _live;
  _resetListSessionsCache(); _resetSubHeaderMemo();
  let c6 = 0;
  const mkCtx6 = () => ({
    get: (n) => {
      if (n === 'sessions') return { get: (id) => ({ header: { id, origin: 'user' } }) };
      if (n === 'subagents') return { listChildren: async () => [{ id: 'live-1' }] };
      if (n === 'sessionQuery') return { listSessions: async () => { c6 += 1; return [{ header: { id: 'ended-1', createdAt: 7, parentSession: 'p', delegationDepth: 1 } }] } };
      return null;
    },
  });
  await listSubagentStatusBySession(mkCtx6(), 'root-1', ['live-1', 'ended-1']);
  const second = await listSubagentStatusBySession(mkCtx6(), 'root-1', ['live-1', 'ended-1']);
  check(c6 === 1, '已结束子会话的 header **只枚举一次**（第二个请求查备忘，零枚举）', 'listSessions calls=' + c6);
  check(second.some((r) => r.id === 'ended-1' && r.createdAt === 7 && r.parentId === 'p' && r.depth === 1) && SUB_HEADER_STATS.memoHits >= 1,
    '备忘命中时 header 字段仍然带全（createdAt/parentId/depth）', 'memoHits=' + SUB_HEADER_STATS.memoHits);
  check(!SUB_HEADER_MEMO.has('live-1'), '**活代理永不写入备忘**（它走实时路径，缓存里不该出现它）', 'memo size=' + SUB_HEADER_MEMO.size);

  // (g) 目录戳失效：戳变了必须立刻重算（不能靠 TTL 假装新鲜）
  _resetListSessionsCache();
  let c7 = 0;
  const q7 = { listSessions: async () => { c7 += 1; return [] } };
  await cachedListSessions(q7, 'stamp-A'); await cachedListSessions(q7, 'stamp-A');
  check(c7 === 1, '同一目录戳 ⇒ 复用（不重复枚举）', 'calls=' + c7);
  await cachedListSessions(q7, 'stamp-B');
  check(c7 === 2, '目录戳变了（新增/删除会话）⇒ **立刻重算**，不等 60 s TTL', 'calls=' + c7);
  check(LIST_SESSIONS_TTL_MS >= 60000, 'TTL 只作兜底（≥60 s）：主失效键是目录戳，不是 TTL', 'TTL=' + LIST_SESSIONS_TTL_MS);
}

console.log('\n⑤ 子会话日志读取：**跨请求推进**的待解析队列（限次 + 永久缓存 ⇒ 必然收敛）');
{
  const { resolveSubRoles, resetRoleReadBudget, roleReadBudgetSnapshot, ROLE_READ_BUDGET_PER_REQUEST, _resetRolePending } = _live;
  const uniq = String(Date.now());
  let reads = 0;
  const mkCtx = (withRole) => ({
    get: (n) => (n === 'sessionQuery'
      ? {
        readSession: async () => {
          reads += 1;
          return { events: withRole
            ? [{ type: 'user/message', data: { message: { content: [{ text: '你是「专家团」的产品经理（pm，…）' }] } } }]
            : [{ type: 'system', data: {} }] };
        },
      }
      : null),
  });
  const mkSubs = (n, tag) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ id: 'q-' + (tag || uniq) + '-' + i, label: '' });
    return out;
  };
  const N = ROLE_READ_BUDGET_PER_REQUEST;

  // (a) 首个请求：只读 N 条，其余如实计入 deferred
  _resetRolePending();
  resetRoleReadBudget();
  await resolveSubRoles(mkCtx(true), mkSubs(N + 2), new Map());
  check(reads === N, '每请求最多读 N 条子会话日志（reads=' + reads + '，预算 ' + N + '）', '');
  check(roleReadBudgetSnapshot().deferred === 2, '超预算的条目**如实**计为"还没解析"（deferred）', 'deferred=' + roleReadBudgetSnapshot().deferred);
  check(!_live.ROLE_READ_LOG_CACHE.has('q-' + uniq + '-' + (N + 1)),
    '被推迟的条目**不写缓存** ⇒ 下一轮会继续（不是永久放弃）', '');

  // (b) 第二个请求：**从上次停下的地方继续**（旧实现在这里会把前 N 条重读一遍 ⇒ 永不收敛）
  resetRoleReadBudget();
  const s2 = mkSubs(N + 2);
  await resolveSubRoles(mkCtx(true), s2, new Map());
  check(reads === N + 2, '第二个请求**只补读剩下的 2 条**（游标前移，不重读前 N 条）', 'reads=' + reads);
  check(roleReadBudgetSnapshot().deferred === 0, 'deferred 收敛到 0（不再像 16 → 40 那样上涨）', 'deferred=' + roleReadBudgetSnapshot().deferred);
  check(s2.every((x) => !!x.role), '收敛后每个子代理都拿到了角色', '');

  // (c) 第三个请求：队列空 + 结果永久缓存 ⇒ **零日志读**
  resetRoleReadBudget();
  await resolveSubRoles(mkCtx(true), mkSubs(N + 2), new Map());
  check(reads === N + 2, '收敛后再请求 ⇒ **零次日志读**（角色对已结束会话不可变 ⇒ 永久缓存）', 'reads=' + reads);

  // (d) 两种零必须分得开：解析不出来（unresolved）≠ 还没解析（deferred）
  _resetRolePending();
  resetRoleReadBudget();
  const tag2 = uniq + 'x';
  const s3 = [{ id: 'q-' + tag2 + '-0', label: '' }, { id: 'q-' + tag2 + '-1', label: '' }];
  await resolveSubRoles(mkCtx(false), s3, new Map());
  const snap3 = roleReadBudgetSnapshot();
  check(snap3.deferred === 0 && snap3.unresolved >= 2,
    '读不出角色的计入 **unresolved（解析不出来）**，不混进 deferred（还没解析）——两种零分得开',
    JSON.stringify({ deferred: snap3.deferred, unresolved: snap3.unresolved }));
  check(s3.every((x) => !x.role), '读不出就**留空**（不臆造角色）', '');

  // (e) 额度复位**不丢队列进度**（进度跨请求保留，这是收敛的前提）
  _resetRolePending();
  resetRoleReadBudget();
  const tag3 = uniq + 'e';
  await resolveSubRoles(mkCtx(true), mkSubs(N + 3, tag3), new Map());
  const before = roleReadBudgetSnapshot().deferred;
  resetRoleReadBudget();
  check(before === 3 && roleReadBudgetSnapshot().deferred === 3,
    'resetRoleReadBudget() 只复位"本请求额度"，**不丢队列进度**', 'deferred=' + roleReadBudgetSnapshot().deferred);

  // 源码级：队列实现存在且 resolveSubRoles 走它（防止有人改回"每请求从零重算"）
  check(/function syncRolePending\(/.test(cmdSrc) && /syncRolePending\(subs\)/.test(cmdSrc),
    '待解析队列按当前 subs 重建（保留既有顺序、新人追加队尾）', '');
  check(/let ROLE_PENDING = \[\]/.test(cmdSrc), '队列是**模块级**（跨请求保留），不是每请求新建', '');
}

console.log('\n⑥ 推荐插件自检（缺了说一句、装了不吭声、区分"没装"与"装了没配"）');
{
  const { detectOptionalPlugins, hintOptionalPluginsOnce, _resetOptionalHintOnce } = _live;
  const loaderOf = (names) => ({ get: (n) => (n === 'loader' ? { entries: function* () { for (const nm of names) yield { options: { name: nm } } } } : undefined) });
  const ctxOf = (names, opts) => {
    const base = loaderOf(names);
    const o = opts || {};
    return {
      get: (n) => {
        if (n === 'loader') return base.get('loader');
        if (n === 'costMeter') return o.costMeter ? {} : undefined;
        if (n === 'tools') return o.tools === null ? null : { get: (t) => (o.tools && o.tools.indexOf(t) >= 0 ? { name: t } : undefined) };
        return undefined;
      },
    };
  };
  const st = (r, id) => (r.items.find((i) => i.id === id) || {}).status;

  const nothing = detectOptionalPlugins(ctxOf([]));
  check(st(nothing, 'hindsight') === 'missing' && st(nothing, 'cost-meter') === 'missing', 'loader 说都没有 ⇒ missing', JSON.stringify(nothing.items.map((i) => i.id + '=' + i.status)));
  check(nothing.needsAttention.length === 2 && /dsh plugin --profile web add/.test(nothing.hint) && nothing.hint.split('\n').length === 1,
    '缺了给**一行**提示且带安装命令（不吓人：明说"不影响使用"）', nothing.hint.slice(0, 60) + '…');

  const installedNotConfigured = detectOptionalPlugins(ctxOf(['@vectorize-io/hindsight-coding-agents/dsh'], { tools: [] }));
  check(st(installedNotConfigured, 'hindsight') === 'installed-not-ready',
    '包装了但工具没注册 ⇒ installed-not-ready（**装了没配**，与"没装"分开）', JSON.stringify(installedNotConfigured.items.map((i) => i.id + '=' + i.status)));

  const ready = detectOptionalPlugins(ctxOf(['dsh-cost-meter', '@vectorize-io/hindsight-coding-agents'], { costMeter: true, tools: ['hindsight_ingest_document'] }));
  check(st(ready, 'hindsight') === 'ready' && st(ready, 'cost-meter') === 'ready' && ready.hint === '',
    '都齐 ⇒ 全部 ready 且 **hint 为空**（装了完全不打扰）', JSON.stringify(ready.items.map((i) => i.id + '=' + i.status)));

  const blind = detectOptionalPlugins({ get: () => undefined });
  check(st(blind, 'hindsight') === 'unknown' && st(blind, 'cost-meter') === 'unknown' && blind.hint === '',
    'loader 探测不可用 + 服务也拿不到 ⇒ unknown（**不假装知道**，也不进提示）', JSON.stringify(blind.items.map((i) => i.id + '=' + i.status)));

  // 一行纪律：同一次加载最多一条，且装了的时候一条都不打
  _resetOptionalHintOnce();
  const logs = [];
  const orig = console.log;
  console.log = (m) => { logs.push(String(m)) };
  try {
    hintOptionalPluginsOnce(ctxOf([]));
    hintOptionalPluginsOnce(ctxOf([]));
    hintOptionalPluginsOnce(ctxOf(['dsh-cost-meter', '@vectorize-io/hindsight-coding-agents'], { costMeter: true, tools: ['hindsight_ingest_document'] }));
  } finally { console.log = orig }
  check(logs.length === 1, '同一次加载**最多一行**（重复调用不再刷屏）', 'logs=' + logs.length);

  // 分档文案（2026-09-15 真实假警报）：装了但此刻拿不到 **不许**再给安装命令
  const onlyNotReady = detectOptionalPlugins(ctxOf(['dsh-cost-meter', '@vectorize-io/hindsight-coding-agents'], { costMeter: true, tools: [] }));
  check(st(onlyNotReady, 'cost-meter') === 'ready' && st(onlyNotReady, 'hindsight') === 'installed-not-ready',
    '构造"只有 installed-not-ready"的场景（费用已就绪、Hindsight 装了没配）', JSON.stringify(onlyNotReady.items.map((i) => i.id + '=' + i.status)));
  check(onlyNotReady.hint !== '' && !/dsh plugin/.test(onlyNotReady.hint) && /已安装但当前未就绪/.test(onlyNotReady.hint),
    'installed-not-ready 的提示**不含安装命令**（那等于叫用户装一个已经装好的东西）', onlyNotReady.hint.slice(0, 78) + '…');
  const hseg = (installedNotConfigured.hint.split('；').find((p) => p.indexOf('hindsight') >= 0) || '');
  check(hseg !== '' && !/dsh plugin/.test(hseg), '混合提示里**逐项**分档：该给命令的给、不该给的不给', hseg.slice(0, 56) + '…');
  check(/dsh plugin --profile web add/.test(nothing.hint), 'missing 的提示**含**安装命令（该装就告诉他怎么装）', '');
  check(installedNotConfigured.hint.split('\n').length === 1, '分档之后仍然只有一行', '');

  // 探测时机：加载当刻**不能**下结论（那时别人的服务还没挂上 ⇒ 假警报）
  {
    const { scheduleOptionalPluginCheck } = _live;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const lateLoader = { entries: function* () { yield { options: { name: 'dsh-cost-meter' } }; yield { options: { name: '@vectorize-io/hindsight-coding-agents' } } } };

    // (i) 服务晚一步挂上 ⇒ 重探发现都齐 ⇒ 一声不吭（这正是用户那次假警报的场景）
    let phase = 0;
    let late = {
      get: (n) => {
        if (n === 'loader') return lateLoader;
        if (n === 'costMeter') return phase >= 1 ? {} : undefined;
        if (n === 'tools') return { get: (t) => (phase >= 1 && t === 'hindsight_ingest_document' ? { name: t } : undefined) };
        return undefined;
      },
    };
    const logs1 = [];
    const orig1 = console.log;
    console.log = (m) => { logs1.push(String(m)) };
    try {
      _resetOptionalHintOnce();
      setTimeout(() => { phase = 1 }, 3);
      scheduleOptionalPluginCheck(late, [0, 20]);
      await sleep(60);
    } finally { console.log = orig1 }
    check(logs1.length === 0, '服务晚一步挂上 ⇒ **不再误报**（就绪后重探发现都齐 ⇒ 一声不吭）', 'logs=' + logs1.length);

    // (ii) 真缺 ⇒ 用尽重试后**恰好一行**
    const logs2 = [];
    const orig2 = console.log;
    console.log = (m) => { logs2.push(String(m)) };
    try {
      _resetOptionalHintOnce();
      scheduleOptionalPluginCheck(ctxOf([]), [0, 10]);
      await sleep(50);
    } finally { console.log = orig2 }
    check(logs2.length === 1 && /推荐插件未就绪/.test(logs2[0]), '真缺 ⇒ 重试到最后一轮才打**一行**（不抢跑、不刷屏）', 'logs=' + logs2.length);
  }

  check(/scheduleOptionalPluginCheck\(ctx\)/.test(cmdSrc), 'apply() 里挂的是**就绪后重探**（不是加载当刻下结论）', '');
  check(!/^\s*hintOptionalPluginsOnce\(ctx\);/m.test(cmdSrc), 'apply() 里**不再**在加载当刻直接下结论（那会假警报）', '');
  check(/case 'help': recheckOptionalPlugins\(ctx\)/.test(cmdSrc), '/team help 时懒重探（刚装上/刚修好配置不必再重启）', '');
  check(/ctx\.inject\(\[svc\]/.test(cmdSrc), '服务一出现就事件驱动重探（cordis 正确姿势：服务不出现则回调不触发）', '');
  check(USAGE.includes('推荐插件'), '/team help 里列出推荐插件一行', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ /state 性能护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ /state 性能护栏通过（热路径零日志读 / 客户端单飞+退避 / 假 id 不落盘 / 反向参数三态）');
