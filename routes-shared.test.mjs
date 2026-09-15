// 测试：路由共享件 `lib/routes/shared.js`（B 线第 9 项 · 报告 04 的 R2）
//
// 为什么需要：`apply()` 里 9 条路由各自抄了一份样板（9 份 `json()`、9 份 405、5 份 body 解析、
// 9 份 `catch → 500`）。抽共享件本身不难，**难的是"抽的时候没改变行为"** —— 所以本测试
// 逐条钉住共享件的契约，并且**同时**验证第一条试点路由 `/artifact` 的四种返回**逐字不变**。
//
// 契约（与既有 9 条路由的行为逐字对齐）：
//   · 方法不在名单 ⇒ **405 空体**（不带 JSON）
//   · JSON content-type 固定为 `application/json; charset=utf-8`
//   · 非法 JSON 体 ⇒ 按 `{}` 处理（参数缺失由业务函数返回 400，而不是解析错误变成 500）
//   · 业务函数抛错 ⇒ 500 `{ok:false,error:<message>}`（文案与旧写法逐字一致）
//   · GET/HEAD 不读 body
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M105**。
// 运行：node routes-shared.test.mjs

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, readJsonBody, readRequestBody, withRoute, localOnly, guardLocalRequest, hostnameOf, isLoopbackHost, isLoopbackOrigin, isLoopbackAddress } from './lib/routes/shared.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 假 req/res：`readRequestBody` 直接认 `req.body`。 */
function fakeReq({ method = 'GET', url = '/', body } = {}) {
  return { method, url, body: body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body)) };
}
function fakeRes() {
  const res = { _code: null, _headers: null, _text: '' };
  res.writeHead = (code, headers) => { res._code = code; res._headers = headers || null; };
  res.end = (s) => { if (s) res._text += String(s); };
  const tryJson = () => { try { return JSON.parse(res._text); } catch { return null; } };
  res.json = tryJson;
  return res;
}

console.log('# 路由共享件\n');

console.log('① 基础件');
{
  const res = fakeRes();
  json(res, 201, { ok: true });
  check(res._code === 201, 'json 用传入的状态码', `code=${res._code}`);
  check(res._headers && res._headers['content-type'] === 'application/json; charset=utf-8', 'json 固定 content-type', JSON.stringify(res._headers));
  check(res.json() && res.json().ok === true, 'json 序列化对象');
  check((await readRequestBody(fakeReq({ body: { a: 1 } }))) === '{"a":1}', 'readRequestBody 认 req.body');
  check((await readRequestBody({})) === '', 'readRequestBody 读不到 ⇒ 空串（不抛）');
  check(JSON.stringify(await readJsonBody(fakeReq({ body: '{bad json' }))) === '{}', '非法 JSON ⇒ {}（不抛）');
  check(JSON.stringify(await readJsonBody(fakeReq({ body: '[1,2]' }))) === '{}', '数组体 ⇒ {}（路由只收对象）');
  check(JSON.stringify(await readJsonBody(fakeReq({ body: { x: 1 } }))) === '{"x":1}', '合法对象体原样返回');
}

console.log('\n② withRoute：方法校验 / 500 兜底 / 上下文 / body 时机');
{
  const guarded = withRoute(async ({ json: J }) => { J(200, { ok: true }); }, { methods: ['POST'] });
  const r405 = fakeRes();
  await guarded(fakeReq({ method: 'GET', url: '/x' }), r405);
  check(r405._code === 405 && r405._text === '', '方法不在名单 ⇒ 405 且**空体**（与旧写法一致）', `code=${r405._code} text=${JSON.stringify(r405._text)}`);

  const boom = withRoute(async () => { throw new Error('boom-msg'); });
  const r500 = fakeRes();
  await boom(fakeReq({ method: 'GET' }), r500);
  check(r500._code === 500 && r500.json() && r500.json().error === 'boom-msg', '业务函数抛错 ⇒ 500 {ok:false,error}（文案取 message）', JSON.stringify(r500.json()));

  const throwStr = withRoute(async () => { throw 'plain-string'; });
  const rStr = fakeRes();
  await throwStr(fakeReq({ method: 'GET' }), rStr);
  check(rStr._code === 500 && rStr.json().error === 'plain-string', '抛非 Error ⇒ 也被兜住（String(...)）', JSON.stringify(rStr.json()));

  let seen = null;
  const ctxRoute = withRoute(async (c) => { seen = { q: c.query.get('a'), b: c.body, hasJson: typeof c.json === 'function' }; c.json(200, { ok: 1 }); }, { methods: ['POST'] });
  await ctxRoute(fakeReq({ method: 'POST', url: '/p?a=7', body: { z: 9 } }), fakeRes());
  check(seen && seen.q === '7', 'query 从 URL 解析', JSON.stringify(seen));
  check(seen && seen.b.z === 9, 'POST 的 body 被解析', JSON.stringify(seen && seen.b));

  let bodyOnGet = 'unset';
  const getRoute = withRoute(async (c) => { bodyOnGet = c.body; c.json(200, { ok: 1 }); }, { methods: ['GET'] });
  await getRoute(fakeReq({ method: 'GET', body: { ignored: true } }), fakeRes());
  check(bodyOnGet && Object.keys(bodyOnGet).length === 0, 'GET 不读 body（不消费流）', JSON.stringify(bodyOnGet));
}

console.log('\n③ 试点路由 `/artifact` 的返回逐字不变');
{
  const root = await mkdtemp(join(tmpdir(), 'dsh-et-routes-'));
  process.env.DSH_HOME = join(root, 'fake-dsh');
  const cwd = join(root, 'proj');
  await mkdir(cwd, { recursive: true });

  // 造一个最小的 run 目录 + 一个工件（`SPEC` 在 ARTIFACT_NAMES 里）
  await mkdir(join(cwd, 'team', 'r1'), { recursive: true });
  await writeFile(join(cwd, 'team', 'r1', 'TASKS.json'), JSON.stringify({ tasks: [] }));
  await writeFile(join(cwd, 'team', 'r1', 'SPEC.md'), '# SPEC 正文\n');

  const { apply } = await import(join(here, 'lib', 'command.js'));
  let registered = null;
  const handlers = {};
  apply({
    commands: { register: (d) => { registered = d; } },
    on: () => {},
    get: () => undefined,
    inject: (deps, f) => {
      if (String(deps) === 'webServer') f({ effect: (fn) => fn(), webServer: { register: (c) => { handlers[c.path] = c.handler; return () => {}; } } });
    },
  });
  const call = async (path, opts = {}) => {
    const res = fakeRes();
    await handlers[path](fakeReq({ url: opts.url || path, method: opts.method || 'GET', body: opts.body }), res);
    return res;
  };

  const ok = await call('/plugins/dsh-expert-team/artifact', { url: `/plugins/dsh-expert-team/artifact?workspace=${encodeURIComponent(cwd)}&run=r1&name=SPEC` });
  check(ok._code === 200 && ok.json() && ok.json().text === '# SPEC 正文\n', '命中 ⇒ 200 + 正文', `code=${ok._code}`);
  check(ok._headers && ok._headers['content-type'] === 'application/json; charset=utf-8', '命中 ⇒ content-type 不变');

  const bad = await call('/plugins/dsh-expert-team/artifact', { url: '/plugins/dsh-expert-team/artifact?workspace=x' });
  check(bad._code === 400 && bad.json() && bad.json().error === 'bad params', '缺参 ⇒ 400 bad params', `code=${bad._code}`);

  const traversal = await call('/plugins/dsh-expert-team/artifact', { url: `/plugins/dsh-expert-team/artifact?workspace=${encodeURIComponent(cwd)}&run=r1&name=${encodeURIComponent('../secret')}` });
  check(traversal._code === 400, '路径穿越仍被拒（400）', `code=${traversal._code}`);

  const missing = await call('/plugins/dsh-expert-team/artifact', { url: `/plugins/dsh-expert-team/artifact?workspace=${encodeURIComponent(cwd)}&run=r1&name=RETRO` });
  check(missing._code === 404 && missing.json() && missing.json().error === 'artifact not found', '工件不存在 ⇒ 404', `code=${missing._code}`);

  const wrongMethod = await call('/plugins/dsh-expert-team/artifact', { method: 'POST', url: '/plugins/dsh-expert-team/artifact' });
  check(wrongMethod._code === 405 && wrongMethod._text === '', 'POST ⇒ 405 空体', `code=${wrongMethod._code} text=${JSON.stringify(wrongMethod._text)}`);

  const notName = await call('/plugins/dsh-expert-team/artifact', { url: `/plugins/dsh-expert-team/artifact?workspace=${encodeURIComponent(cwd)}&run=r1&name=NOT_AN_ARTIFACT` });
  check(notName._code === 400, '名字不在 ARTIFACT_NAMES ⇒ 400（白名单未破）', `code=${notName._code}`);
}

console.log('\n④ 结构：试点路由确实不再自带 json/405/500 样板');
{
  const src = await readFile(join(here, 'lib', 'command.js'), 'utf8');
  const at = src.indexOf("path: '/plugins/dsh-expert-team/artifact'");
  const seg = src.slice(at, src.indexOf("path: '/plugins/dsh-expert-team/codeidx'"));
  check(/withRoute\(async/.test(seg), '/artifact 走 withRoute', '');
  check(!/req\.method !== 'GET'/.test(seg), '/artifact 不再手写 405 判断', '');
  check(!/catch \(e\) \{\s*json\(500/.test(seg), '/artifact 不再手写 500 兜底', '');
  const rbCount = (src.match(/^async function readRequestBody/m) || []).length;
  check(rbCount === 0, 'command.js 不再自带 readRequestBody（已搬进共享件）', `命中 ${rbCount}`);
}

console.log('\n⑤ 本机来源守卫：三条攻击路径各有一条规则挡，合法同源请求放行');
{
  /** 合法浏览器请求的形状：Host 回环 + Origin 同源 + POST 带 JSON。 */
  const browser = (over = {}) => ({
    method: 'POST',
    url: '/plugins/dsh-expert-team/task',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    body: '{}',
    ...over,
  });

  // ── 基础件 ──
  check(hostnameOf('127.0.0.1:3080') === '127.0.0.1' && hostnameOf('[::1]:3080') === '[::1]' && hostnameOf('localhost') === 'localhost', 'hostnameOf 处理端口与 IPv6 字面量');
  check(isLoopbackHost('localhost:1') && isLoopbackHost('127.0.0.1') && !isLoopbackHost('evil.example') && !isLoopbackHost(''), 'isLoopbackHost 只认回环');
  check(isLoopbackOrigin('http://127.0.0.1:3080') && isLoopbackOrigin('https://[::1]') && !isLoopbackOrigin('null') && !isLoopbackOrigin('http://evil.example'), 'isLoopbackOrigin 拒绝 null 与外站');
  check(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('::1') && isLoopbackAddress('::ffff:127.0.0.1') && !isLoopbackAddress('192.168.1.9') && !isLoopbackAddress(''), 'isLoopbackAddress 认 IPv4/IPv6/mapped');

  // ── 放行面 ──
  check(guardLocalRequest(browser(), { methods: ['POST'] }) === null, '合法同源 POST 放行');
  check(guardLocalRequest(browser({ headers: { host: 'localhost:3080' } }), { methods: ['POST'] }) === null, 'localhost 也是回环（放行）');
  check(guardLocalRequest(browser({ headers: { host: '[::1]:3080' } }), { methods: ['POST'] }) === null, 'IPv6 回环放行');
  check(guardLocalRequest(browser({ method: 'GET', headers: { host: '127.0.0.1:3080', origin: 'null' } }), { methods: ['GET'] }) === null, 'GET 带 Origin: null（/team canvas --watch 的 file:// 页面）仍放行 —— 浏览器不会把无 CORS 头的响应交给它');
  check(guardLocalRequest({ method: 'GET', url: '/' }, { methods: ['GET'] }) === null, '无 headers/socket 的本地客户端放行（这三条规则只对浏览器有意义）');

  // ── 三条攻击路径 ──
  const rebind = guardLocalRequest(browser({ headers: { host: 'evil.example:3080', origin: 'http://evil.example:3080', 'content-type': 'application/json' } }), { methods: ['POST'] });
  check(rebind && rebind.code === 403 && /Host/.test(rebind.error), '① DNS rebinding（Host 非回环）⇒ 403', JSON.stringify(rebind));

  const csrf = guardLocalRequest(browser({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example', 'content-type': 'application/json' } }), { methods: ['POST'] });
  check(csrf && csrf.code === 403 && /cross-origin/.test(csrf.error), '② 跨站写（写方法 Origin 非回环）⇒ 403', JSON.stringify(csrf));

  const lan = guardLocalRequest(browser({ socket: { remoteAddress: '192.168.1.9' } }), { methods: ['POST'] });
  check(lan && lan.code === 403 && /non-loopback client/.test(lan.error), '③ 局域网客户端 ⇒ 403（host: 0.0.0.0 时挡住同网段）', JSON.stringify(lan));

  const form = guardLocalRequest(browser({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/x-www-form-urlencoded' } }), { methods: ['POST'] });
  check(form && form.code === 415, '④ 简单请求（form/urlencoded，不触发预检）⇒ 415', JSON.stringify(form));

  check(guardLocalRequest({ method: 'POST', url: '/' }, { methods: ['GET'] }).code === 405, '方法不在名单 ⇒ 405（守卫一并承担，注册处不必再写）');

  // ── localOnly 真的把判定写成了响应 ──
  const res403 = fakeRes();
  let ran = false;
  await localOnly(async () => { ran = true; }, { methods: ['POST'] })(browser({ headers: { host: 'evil.example' } }), res403);
  check(res403._code === 403 && res403.json() && res403.json().ok === false && ran === false, 'localOnly 拒绝时写 403 JSON 且不调用业务处理器', `code=${res403._code}`);
  const resOk = fakeRes();
  await localOnly(async () => { ran = true; }, { methods: ['POST'] })(browser(), resOk);
  check(ran === true && resOk._code === null, 'localOnly 放行时确实调用业务处理器', '');
}

console.log('\n⑥ 棘轮：每条路由都经过守卫（新加路由不许裸注册）');
{
  const src = await readFile(join(here, 'lib', 'command.js'), 'utf8');
  const bare = (src.match(/wctx\.webServer\.register\(\{/g) || []).length;
  check(bare === 1, '真正调宿主 register 的地方只有 registerLocal 内部那一处', `命中 ${bare}`);
  const sites = (src.match(/registerLocal\(\{/g) || []).length;
  check(sites === 12, '12 条路由全部走 registerLocal（新增路由必须也走它）', `命中 ${sites}`);
  const methods = (src.match(/^            methods: \[/gm) || []).length;
  check(methods === 12, '每条注册都声明了 methods（守卫据此决定校验哪些方法）', `命中 ${methods}`);
  check(/handler: localOnly\(rest\.handler, \{ methods \}\)/.test(src), 'registerLocal 确实套了 localOnly', '');
  for (const [p, m] of [['state', "['GET']"], ['decide', "['POST']"], ['settings', "['GET', 'POST']"]]) {
    const at = src.indexOf(`path: '/plugins/dsh-expert-team/${p}',`);
    check(at !== -1 && src.slice(at, at + 200).includes(`methods: ${m},`), `/${p} 的 methods = ${m}`, '');
  }
}

if (fail) { console.error(`\n✗ routes-shared：${fail} 项失败`); process.exit(1); }
console.log('\n✓ routes-shared：全部通过');
