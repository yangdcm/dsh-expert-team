// 路由层共享件（B 线第 9 项 · 报告 04 的 R2）。
//
// 为什么需要：`apply()` 里 9 条 HTTP 路由**各自**抄了一份样板 —— 9 份 `json()` 助手、9 份 405
// 判断、5 份 body 解析、9 份 `catch → 500`。任何跨路由策略（鉴权、限流、审计、统一错误码）
// 都要改 9 处；而 A 线要加的 `/settings` 路由又得再抄一份。
//
// 设计约束（**本模块是叶子**）：`shared.js` 不 import `command.js`，只依赖 node 内置 ——
// 这样它既能被 command.js 消费，将来也能被拆出去的子模块消费，不会形成环。
//
// 迁移策略：**一条一条搬**，先拿最独立的 `/artifact`（只读、无状态）试点；`/state`
// 最长最危险，放最后。搬一条就跑对应测试 + `gate:mutation`。

/**
 * 读请求体：dsh `webServer` 的 `req` 是**异步可迭代流**（没有 `.body`），
 * 而测试用的假 req 直接给 `.body` —— 两种都支持。
 * @param req - 请求对象。
 * @returns 原始字符串（读不到或超 1MB 截断时返回已读部分）。
 */
export async function readRequestBody(req) {
  try {
    if (req && req.body != null) return String(req.body);
    if (req && typeof req[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      let size = 0;
      for await (const raw of req) {
        const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        size += b.byteLength;
        if (size > 1024 * 1024) break;
        chunks.push(b);
      }
      return Buffer.concat(chunks).toString('utf8');
    }
  } catch { /* best-effort */ }
  return '';
}

/**
 * 发一个 JSON 响应（统一 content-type，避免每条路由各写一遍）。
 * @param res - 响应对象。
 * @param code - HTTP 状态码。
 * @param body - 可序列化对象。
 */
export function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 容错解析 JSON 请求体：非法 JSON 一律当 `{}`（与既有 9 条路由的写法一致 —— 参数缺失由
 * 各自的校验返回 400，而不是让解析错误变成 500）。
 * @param req - 请求对象。
 * @returns 解析后的对象（永远不是 null）。
 */
export async function readJsonBody(req) {
  let body = {};
  try { body = JSON.parse((await readRequestBody(req)) || '{}'); } catch { body = {}; }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

/**
 * 把一条路由包成统一的处理器：方法校验 → 解析 URL/body → 调用业务函数 → 统一 500 兜底。
 *
 * @param handler - `async ({ req, res, json, url, query, body }) => void`；**业务函数自己负责
 *   写响应**（各路由的状态码语义差异太大，包起来反而更难读）。
 * @param options.methods - 允许的方法（默认 `['GET']`）。不在名单里 ⇒ 返回 405 空体
 *   （与既有 9 条路由的行为逐字一致）。
 * @returns `(req, res) => Promise<void>`
 */
export function withRoute(handler, { methods = ['GET'] } = {}) {
  const allow = new Set(methods.map((m) => String(m).toUpperCase()));
  return async function route(req, res) {
    try {
      const method = String((req && req.method) || 'GET').toUpperCase();
      if (!allow.has(method)) { res.writeHead(405); res.end(); return; }
      const url = new URL((req && req.url) || '/', 'http://127.0.0.1');
      const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req);
      await handler({ req, res, json: (code, payload) => json(res, code, payload), url, query: url.searchParams, body });
    } catch (e) {
      // 统一兜底：与既有 9 条路由的 500 文案逐字一致（`String(e && e.message ? e.message : e)`）
      json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
}

// ── 本机来源守卫（安全加固 · 2026-09-14）────────────────────────────────────
//
// 为什么要有它：这 11 条路由由 dsh 的 webServer 暴露在本机 HTTP 端口上，此前**只校验
// HTTP 方法**。于是有三条真实可达的攻击路径：
//   ① **DNS rebinding**：恶意页面把自己的域名解析到 127.0.0.1，浏览器就把它当同源 ⇒
//      可读 `/state`、`/file`（工作区任意文本）、并写入 `/task`、`/plan`、`/settings`。
//   ② **跨站简单请求（CSRF）**：跨站 `fetch` 带 `text/plain`、或 `<form>` 提交，都不触发
//      CORS 预检 ⇒ 写操作照常执行（响应读不到，但**副作用已经发生**）。
//   ③ **非回环暴露**：宿主配置 `host: 0.0.0.0` 时，同网段任何机器都能打这些接口。
//
// 判定规则（每条都对应上面一条攻击路径）：
//   · `Host` 头存在且主机名不是回环 ⇒ 403。**这是挡 DNS rebinding 的那一条**：浏览器一定会带
//     Host，而攻击页带的 Host 是它自己的域名。
//   · `Origin` 头存在且不是回环来源 ⇒ **只在变更方法上** 403。GET 放行是有意的：浏览器不会把
//     没有 CORS 头的响应体交给跨站页面（我们从不发 `Access-Control-Allow-Origin`），所以跨站
//     GET 读不到任何东西；而放行它才能保住 `/team canvas --watch` 生成的本地 HTML 文件——
//     那个页面以 `file://` 打开，发请求时带的是 `Origin: null`。
//   · `req.socket.remoteAddress` 存在且不是回环 ⇒ 403（挡局域网）。
//   · 变更方法上 `content-type` 存在且不是 JSON ⇒ 415。浏览器的 form 与"简单请求"只能发
//     urlencoded / multipart / text-plain，JSON 必须走预检，而我们不回应预检。
//
// **三条规则都只在"头存在"时生效** —— 这是刻意的，不是宽松：
//   · 浏览器（也就是这三条攻击路径里唯一的攻击载体）**必然**带上 Host，POST 必然带 Origin；
//   · 本地非浏览器客户端本来就能自造任意头，任何头校验都拦不住它 —— 这类客户端需要的是
//     鉴权，而 dsh 插件没有鉴权模型（市场的同源检查也只是回环+同源）。这一点如实写进 README。
//   · 副作用：单元测试里的假 req 没有 headers/socket，因此不受影响（不必为测试开口子）。
//
// 事实来源：`dshmarket` 对 install/restart 这类端点就是这么做的（"只接受同源 POST"、
// "重启要求客户端直接来自环回地址、拒绝代理转发请求"）。

/** 回环主机名（Host 头 / Origin 里的主机名都按这个判）。 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `Host: 127.0.0.1:3080` → `127.0.0.1`；`[::1]:3080` → `[::1]`；解析不出返回 ''。 */
export function hostnameOf(hostHeader) {
  const raw = String(hostHeader == null ? '' : hostHeader).trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {                       // IPv6 字面量：[::1]:3080
    const end = raw.indexOf(']');
    return end === -1 ? raw : raw.slice(0, end + 1);
  }
  const colon = raw.lastIndexOf(':');
  return colon === -1 ? raw : raw.slice(0, colon);
}

/** Host 头是否是回环地址。 */
export function isLoopbackHost(hostHeader) {
  const h = hostnameOf(hostHeader);
  return h !== '' && LOOPBACK_HOSTNAMES.has(h);
}

/**
 * 来源（Origin）是否可信：`http://127.0.0.1:3080`、`http://localhost:3080`、`https://[::1]` 可信；
 * `null`（file:// 页面）与一切外站**不可信**。
 */
export function isLoopbackOrigin(origin) {
  const raw = String(origin == null ? '' : origin).trim();
  if (!raw || raw.toLowerCase() === 'null') return false;
  try {
    const u = new URL(raw);
    return LOOPBACK_HOSTNAMES.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** socket 地址是否是回环（`127.x.x.x`、`::1`、IPv4-mapped `::ffff:127.x.x.x`）。 */
export function isLoopbackAddress(addr) {
  const a = String(addr == null ? '' : addr).trim().toLowerCase();
  if (!a) return false;
  if (a === '::1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  return /^127\./.test(v4);
}

/**
 * 本机来源守卫：返回 `null` 表示放行，否则返回 `{ code, error }`（由调用方写响应）。
 *
 * @param req - 请求对象（`headers` / `socket.remoteAddress` 缺失时按"非浏览器客户端"处理）
 * @param options.methods - 该路由允许的方法；**变更方法**才做 Origin 与 content-type 校验
 */
export function guardLocalRequest(req, { methods = ['GET'] } = {}) {
  const headers = (req && req.headers) || null;
  const method = String((req && req.method) || 'GET').toUpperCase();
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  if (headers) {
    const host = headers.host ?? headers[':authority'];
    if (host != null && String(host).trim() !== '' && !isLoopbackHost(host)) {
      return { code: 403, error: 'forbidden: non-loopback Host' };
    }
    const origin = headers.origin;
    if (mutating && origin != null && String(origin).trim() !== '' && !isLoopbackOrigin(origin)) {
      return { code: 403, error: 'forbidden: cross-origin write' };
    }
    if (mutating) {
      const ct = headers['content-type'];
      if (ct != null && String(ct).trim() !== '' && !/^application\/json\b/i.test(String(ct).trim())) {
        return { code: 415, error: 'unsupported media type: expected application/json' };
      }
    }
  }

  const addr = req && req.socket ? req.socket.remoteAddress : null;
  if (addr != null && String(addr).trim() !== '' && !isLoopbackAddress(addr)) {
    return { code: 403, error: 'forbidden: non-loopback client' };
  }

  // 方法校验放在守卫里一起做：路由注册处只包一层就不会漏（见 routes-guard 棘轮测试）。
  const allow = new Set(methods.map((m) => String(m).toUpperCase()));
  if (!allow.has(method)) return { code: 405, error: '' };

  return null;
}

/**
 * 给任意处理器套上"只服务本机同源"的守卫。**注册每一路由时都要用它包一层** ——
 * `routes-shared.test.mjs` 有一条棘轮断言：`lib/command.js` 里不允许出现裸的 `handler:`。
 *
 * @param handler - `(req, res) => Promise<void> | void`
 * @param options.methods - 允许的方法（默认 `['GET']`）
 */
export function localOnly(handler, { methods = ['GET'] } = {}) {
  return async function guarded(req, res) {
    const denied = guardLocalRequest(req, { methods });
    if (denied) {
      if (denied.code === 405) { res.writeHead(405); res.end(); return; }
      json(res, denied.code, { ok: false, error: denied.error });
      return;
    }
    return handler(req, res);
  };
}
