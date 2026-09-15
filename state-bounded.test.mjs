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
  const { listSubagentStatusBySession, _resetSubHeaderMemo, _resetListSessionsCache, SUB_HEADER_STATS } = _live;
  const mkCtx = (onEnum) => ({
    get: (n) => (n === 'sessionQuery'
      ? { listSessions: async () => { onEnum(); return [{ header: { id: 'ended-A', createdAt: 5 } }]; } }
      : (n === 'subagents' ? { listChildren: async () => [] } : null)),
  });

  // (a) 节流：本轮禁止枚举 ⇒ 一次 listSessions 都不发，且 cut='throttled'
  _resetSubHeaderMemo(); _resetListSessionsCache();
  let enumA = 0;
  await listSubagentStatusBySession(mkCtx(() => { enumA += 1; }), 'root', ['ended-A'], { allowEnum: false });
  check(enumA === 0 && SUB_HEADER_STATS.cut === 'throttled',
    '节流窗口内**零枚举**（省掉 475-artifact 全库扫描），并如实标记 throttled',
    'enumCalls=' + enumA + ' cut=' + SUB_HEADER_STATS.cut);

  // (b) 期限：允许枚举但期限已过 ⇒ 枚举发生后**立即停**，cut='deadline'
  _resetSubHeaderMemo(); _resetListSessionsCache();
  let enumB = 0;
  await listSubagentStatusBySession(mkCtx(() => { enumB += 1; }), 'root', ['ended-A'], { allowEnum: true, enumDeadlineAt: 0 });
  check(enumB === 1 && SUB_HEADER_STATS.cut === 'deadline',
    '期限到点立即停并如实标记 deadline（不静默、也不把残缺当完整）',
    'enumCalls=' + enumB + ' cut=' + SUB_HEADER_STATS.cut);

  // (c) 默认（不传 opts）仍保持原行为：允许枚举、无期限
  _resetSubHeaderMemo(); _resetListSessionsCache();
  let enumC = 0;
  const rowsC = await listSubagentStatusBySession(mkCtx(() => { enumC += 1; }), 'root', ['ended-A']);
  check(enumC === 1 && SUB_HEADER_STATS.cut === '' && rowsC.some((r) => r.id === 'ended-A' && r.createdAt === 5),
    '不传 opts ⇒ 保持原行为（允许枚举、无期限、header 带全）', 'enumCalls=' + enumC);
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
  check(/subs:deadline/.test(cmdSrc) && /roles:deadline/.test(cmdSrc),
    'degraded 只承载**真截断**（subs:deadline / roles:deadline）', '');
  // 噪声纪律：节流窗口内每轮都会命中 ⇒ 绝不能每轮都进 degraded（否则降级标记长期挂着，
  // 真告警被一起降权）。节流的事实由 subsPending / rolesPending 表达。
  check(!/degraded\.push\('subs:throttled'\)/.test(cmdSrc), '节流**不进** degraded（面板不许长期挂降级标记）', '');
  check(/rolesPending: budget\.deferred, subsPending/.test(cmdSrc), '成员细节不可得由负载里的 `subsPending` 诚实表达（缩写形式也要认）', '');
  check(/unresolved/.test(cmdSrc) && /deferred: ROLE_PENDING\.length/.test(cmdSrc),
    '"还没解析"（deferred/pending）与"解析不出来"（unresolved）仍是两个数', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 有界化护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 有界化护栏通过（subs 节流/期限 · roles 零读/期限/收敛 · 字段单一真源且被渲染）');
