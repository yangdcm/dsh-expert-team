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
