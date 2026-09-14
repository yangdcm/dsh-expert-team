// 契约测试：待拍板横幅（composer）→ POST /decide（批 0-2）
//
// 为什么需要它：`/decide` 是**方案确认门的唯一交互入口**。实测发现它恒 400：
//   · 横幅 `choose()` 发 `{sessionId, runId, id}`，而路由要 `{sessionId|workspace, run, choice}`；
//   · 且 `run` 的来源 `interact.runId` 在 `pendingDecision` 里**根本不存在**（恒 ''）。
//   ⇒ 用户点「执行」静默失败、`pendingDecision` 永不清除、门禁永远停在方案确认；
//   ⇒ 而回归测试只覆盖了**正确字段**那条路径（DecisionCard → decide()），所以测试全绿。
//
// 本测试是**双向契约断言**（架构师要求）：
//   ① 从 `lib/command.js` 的 /decide 路由**解析**必需字段（不硬编码，路由改了测试会跟着发现）
//   ② 从 `client.js` **抽取并真实执行** `syncPending` + `choose`，捕获真实发布的
//      pendingInteraction 与真实的 fetch payload
//   ③ 断言 payload 满足路由要求
//
// 变异验证：修复前必须红，修复后必须绿。（这是 QA「旧代码上失败、新代码上通过」的硬要求。）
//
// 运行：node plan-decide.test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(here, 'client.js'), 'utf8');
const hostSrc = readFileSync(join(here, 'lib', 'command.js'), 'utf8');

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 从源码里抽出 `function NAME(...) {...}` 的完整文本（按大括号配对，容忍嵌套）。 */
function extractFunction(src, name, label) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未能从 ${label} 抽到 function ${name}`);
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error(`function ${name} 没有函数体`);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    const c = src[j];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`function ${name} 大括号不配对`);
}

console.log('# /decide 契约测试（批 0-2）\n');

// ── ① 从路由解析必需字段 ────────────────────────────────────────────────
console.log('① 路由契约（从 lib/command.js 解析）');
const routeIdx = hostSrc.indexOf("path: '/plugins/dsh-expert-team/decide'");
check(routeIdx >= 0, '找到 /decide 路由');
const routeSlice = hostSrc.slice(routeIdx, routeIdx + 1200);
// 形如： if (!cwd || !run || !choice || /[\\/]/.test(run)) { json(400, ...) }
// 注意：条件里含 `)`（/[\\/]/.test(run)），所以不能用 [^)]* —— 用懒惰 .+? 匹配到第一个 ") { json(400"
const guard = routeSlice.match(/if \((.+?)\)\s*\{\s*json\(400/);
check(!!guard, '找到 400 参数校验分支', guard ? guard[1].trim() : '(未找到)');
const requiredFields = guard ? [...guard[1].matchAll(/!([A-Za-z_$][\w$]*)/g)].map((m) => m[1]) : [];
check(requiredFields.includes('run'), '路由必需 run', requiredFields.join(','));
check(requiredFields.includes('choice'), '路由必需 choice', requiredFields.join(','));
// cwd 可由 workspace 或 sessionId 推出
check(/body\.workspace/.test(routeSlice) && /cwdFromSession/.test(routeSlice), 'cwd 可由 workspace 或 sessionId 推出');
console.log('');

// ── ② 真实执行 syncPending：捕获发布的 pendingInteraction ────────────────
console.log('② 发布侧（真实执行 client.js 的 syncPending）');
const syncSrc = extractFunction(clientSrc, 'syncPending', 'client.js');
let published = null;
const makeSync = new Function(
  'publishPending',
  `var pendingPub = null;\n${syncSrc}\nreturn syncPending;`,
);
const syncPending = makeSync((payload) => {
  published = payload;
  return { unsub() {} };
});

// 模拟状态响应里真实存在的数据（d.runId / d.workspace 由 /state 返回）
const decision = { title: '执行方案？', prompt: '请确认', options: [{ id: 'go', label: '执行' }] };
const RUN = 'run-abc';
const WS = '/tmp/ws';
try {
  // 修复后签名：syncPending(dec, sessionId, runId, workspace)
  syncPending(decision, 'sess-1', RUN, WS);
} catch (e) {
  check(false, 'syncPending 可执行', String(e && e.message));
}
check(!!published, '已发布 pendingInteraction');
check(published && published.type === 'et-decision', 'type=et-decision');
check(published && published.sessionId === 'sess-1', '发布了 sessionId');
check(!!(published && published.runId), '发布了 runId（choose 需要它做 run 来源）',
  published ? `runId=${JSON.stringify(published.runId)}` : '');
check(!!(published && published.workspace), '发布了 workspace（或可由 sessionId 推 cwd）',
  published ? `workspace=${JSON.stringify(published.workspace)}` : '');
console.log('');

// ── ③ 真实执行 choose：捕获真实 fetch payload ────────────────────────────
console.log('③ 调用侧（真实执行 client.js 的 choose）');
const chooseSrc = extractFunction(clientSrc, 'choose', 'client.js');
let captured = null;
const fetchStub = (url, init) => {
  captured = { url, init, body: JSON.parse(init.body) };
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
};
const makeChoose = new Function('p', 'interact', 'fetch', 'exports', `${chooseSrc}\nreturn choose;`);
const p = published || {};
const interact = p.decision || decision;
const choose = makeChoose(p, interact, fetchStub, { _resolvePending: () => {} });
choose('go');

check(!!captured, 'choose 发出了请求');
check(captured && captured.url === '/plugins/dsh-expert-team/decide', '请求打到 /decide', captured ? captured.url : '');
const body = (captured && captured.body) || {};
console.log(`      payload = ${JSON.stringify(body)}`);
check(!!body.run || (body.run === '' && !!body.workspace), 'payload 含 run（非空，或用 workspace 兜底）', `run=${JSON.stringify(body.run)}`);
check(body.choice !== undefined && String(body.choice).trim() !== '', 'payload 含非空 choice', `choice=${JSON.stringify(body.choice)}`);
check(!!(body.workspace || body.sessionId), 'payload 含 workspace 或 sessionId（供路由推 cwd）');
// 关键：不能把旧字段名发过去（runId/id 是 400 的根因）
check(!('runId' in body), '不再发错误的 runId 字段');
check(!('id' in body), '不再发错误的 id 字段');
console.log('');

// ── ④ 与路由逐字段对齐 ──────────────────────────────────────────────────
// 注意：`cwd` 是路由内部的**派生变量**（由 workspace 或 sessionId 推出），不是 payload 字段，
// 故不纳入"payload 必须提供"的集合——它由上面 ①/③ 的 cwd 来源断言单独覆盖。
const payloadFields = requiredFields.filter((f) => f !== 'cwd');
console.log(`④ 契约对齐（payload ⊇ 路由必需字段：${payloadFields.join(',')}）`);
for (const f of payloadFields) {
  const v = body[f];
  check(v !== undefined && String(v).trim() !== '', `路由必需字段 ${f} 已在 payload 中提供`, `值=${JSON.stringify(v)}`);
}
console.log('');

if (fail > 0) {
  console.log(`✗ /decide 契约测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ /decide 契约测试通过（横幅拍板链路字段对齐）');
