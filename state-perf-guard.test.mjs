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

console.log('\n② 客户端：single-flight + 自适应退避');
{
  check(/if \(inFlightRef\.current\) return/.test(clientSrc), 'load() 有 in-flight 守卫（未回不发下一个）', '');
  check(/inFlightRef\.current = true/.test(clientSrc) && /inFlightRef\.current = false/.test(clientSrc), '在飞标记有置位也有清理（成功/失败都要清）', '');
  check(/\.then\(done, done\)/.test(clientSrc), '无论成功或失败都会清在飞标记（否则一次失败就永久停摆）', '');
  check(/lastMsRef\.current = Math\.max\(0, now - t0\)/.test(clientSrc), '记录本次 /state 耗时（退避依据）', '');
  check(/var backoff = Math\.max\(base, Math\.min\(30000, Math\.round\(\(lastMsRef\.current \|\| 0\) \* 2\)\)\)/.test(clientSrc),
    '退避公式：clamp(max(基础间隔, 上次耗时×2), 基础间隔, 30000)', '');
  check(/setInterval\(load, backoff\)/.test(clientSrc), '轮询真的用退避后的间隔（不是裸基础间隔）', '');
  check(!/setInterval\(load, busy \? Math\.max\(300, Math\.round\(dispCfg\.pollMs \* 0\.4\)\) : dispCfg\.pollMs\)/.test(clientSrc),
    '旧的"裸间隔"写法已不存在（防止有人把它改回去）', '');
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

console.log('');
if (fail > 0) {
  console.log(`✗ /state 性能护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ /state 性能护栏通过（热路径零日志读 / 客户端单飞+退避 / 假 id 不落盘 / 反向参数三态）');
