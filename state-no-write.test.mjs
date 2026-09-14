// 测试：`GET /state` **不得写 run 工件**（B 线小切片 · 读接口去副作用）
//
// 为什么需要：浮层每 **3 秒**轮询 `GET /state`，而该 handler 里原先有一段
// 「≤1/5 分钟触发一次 `autoAggregate`」的节流逻辑 ⇒ **读接口会周期性改写
// `team/METRICS.md` 与 `team/LEARNINGS.md`**。而 `LEARNINGS.md` 同时是 lead 在 run 里写的
// ⇒ 一处**真实的并发写面**（本仓最高频的环境类卡点正是 `error:external-write ×9`）。
// 一个 GET 写盘本身也不该存在：它破坏幂等，缓存/监控/轮询方都不能再假设"只是看看"。
//
// 本轮只摘掉**聚合**这一处；handler 里仍有另外两处写（`persistSessionRuns()` 写插件自身状态、
// 「派工即登记」写本 run 的 `STATE.json`），**本测试不覆盖它们**，也不假装 GET 已经"完全无副作用"
// —— 那一层属于「第二个写者」的设计问题（计划文档第 17 项）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M104**。
// 运行：node state-no-write.test.mjs

import { mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-et-nowrite-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply } = await import(join(here, 'lib', 'command.js'));
let registered = null;
let stateHandler = null;
let refreshHandler = null;
apply({
  commands: { register: (d) => { registered = d; } },
  on: () => {},
  get: () => undefined,
  inject: (deps, f) => {
    if (String(deps) !== 'webServer') return;
    f({
      effect: (fn) => { fn(); },
      webServer: {
        register: (c) => {
          if (String(c.path).endsWith('/state')) stateHandler = c.handler;
          if (String(c.path).endsWith('/metrics/refresh')) refreshHandler = c.handler;
          return () => {};
        },
      },
    });
  },
});
const cmd = (rawInput) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-nowrite-1', header: { cwd } }, followup: () => {} },
});

/** 造一个假 req/res，跑一次路由，返回 `{code, body}`。 */
async function call(handler, { method = 'GET', url = '/', body } = {}) {
  // 桩与 `regression.test.mjs` 同款：`readRequestBody` 直接认 `req.body`
  const req = { method, url, body: body === undefined ? null : JSON.stringify(body) };
  let text = '';
  const res = { writeHead: (code) => { res._code = code; }, end: (s) => { if (s) text += String(s); } };
  await handler(req, res);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 可能无 body */ }
  return { code: res._code, body: parsed, raw: text };
}

console.log('# GET /state 不得写 run 工件\n');

// ① 建一个 run（`/team <task>` 本身会聚合一次 —— 那是**显式**写入，允许）
await cmd('去副作用目标');
const runs = (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
const run = runs[0];
check(!!run, '已建立 run', String(run));

const metricsPath = join(cwd, 'team', 'METRICS.md');
const learningsPath = join(cwd, 'team', 'LEARNINGS.md');
const exists = async (p) => stat(p).then((s) => s.mtimeMs).catch(() => null);

// ② 先让聚合发生一次（显式 `/team learn`），拿到基线
await cmd('learn');
const baseMetrics = await exists(metricsPath);
const baseLearn = await exists(learningsPath);
check(baseMetrics !== null, '显式 `/team learn` 仍会写 METRICS.md（聚合没被删掉）', '');
// ⚠️ LEARNINGS.md 只在**有可蒸馏经验**时才写（`aggregate` 就地替换当日蒸馏块）；
// 单 run 的极简夹具下它可能压根不产生 ⇒ **不能**断言它一定存在。这里只记录基线，
// 后面的核心断言是"轮询后它的 mtime 没有变化"（null → null 也算没变）。
check(true, 'LEARNINGS.md 基线（可能不存在，取决于是否有可蒸馏经验）', String(baseLearn));

// ③ 反复轮询 GET /state —— 不得改动这两个文件
//    （用 6 次调用把「≤1/5 分钟」这类节流窗口也压过去：节流是时间窗，不是次数窗，
//      所以这里同时把 lastAggAt 的存在与否也一起否掉）
const before = { m: baseMetrics, l: baseLearn };
for (let i = 0; i < 6; i += 1) {
  const r = await call(stateHandler, { method: 'GET', url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(run) });
  if (r.code !== 200) { check(false, 'GET /state 返回 200', `第 ${i + 1} 次 code=${r.code}`); break; }
}
// 给"未被 await 的写"留出落地时间：原实现是 `autoAggregate(...)` 不 await 的
// fire-and-forget，若不加这段等待，变异体（把写放回去）可能因竞态而被漏判。
await new Promise((r) => setTimeout(r, 150));
const afterM = await exists(metricsPath);
const afterL = await exists(learningsPath);
check(afterM === before.m, 'GET /state 未改动 METRICS.md', `mtime ${before.m} → ${afterM}`);
check(afterL === before.l, 'GET /state 未改动 LEARNINGS.md', `mtime ${before.l} → ${afterL}`);

console.log('\n② 显式刷新入口仍在（POST，不是 GET）');
{
  check(!!refreshHandler, '已注册 POST /plugins/dsh-expert-team/metrics/refresh', '');
  if (refreshHandler) {
    const bad = await call(refreshHandler, { method: 'GET', url: '/plugins/dsh-expert-team/metrics/refresh' });
    check(bad.code === 405, '用 GET 调刷新入口 ⇒ 405（不允许读接口写盘）', `code=${bad.code}`);
    const ok = await call(refreshHandler, { method: 'POST', body: { workspace: cwd } });
    check(ok.code === 200 && ok.body && ok.body.ok === true, 'POST 调刷新入口 ⇒ 200 且 ok=true', `code=${ok.code}`);
    const refreshed = await exists(metricsPath);
    check(refreshed !== null, '刷新后 METRICS.md 仍在（聚合可用）', '');
  }
}

console.log('\n③ 诚实边界：本测试**不**声称 GET 已完全无副作用');
{
  const src = await readFile(join(here, 'lib', 'command.js'), 'utf8');
  check(/persistSessionRuns\(\);\s*\n\s*json\(200, \{ ok: true, runs, workspaces/.test(src)
    || /persistSessionRuns\(\);/.test(src), '代码里保留了 persistSessionRuns —— 它仍写插件自身状态（未在本轮改动）', '');
  check(/本 handler 仍有另外两处写/.test(src), '代码注释如实标注"仍有另外两处写"（不假装已无副作用）', '');
}

if (fail) { console.error(`\n✗ state-no-write：${fail} 项失败`); process.exit(1); }
console.log('\n✓ state-no-write：全部通过');
