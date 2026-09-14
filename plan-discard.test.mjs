// 行为测试：planDiscarded 的**代码强制**（批 0-3）
//
// 为什么需要它：SKILL 规则 19 承诺「丢弃后禁止自动重建同目标团队，除非用户明确再次要求」，
// 但实测代码里 `planDiscarded` **只有置位与清位，createRun 从不读它** ⇒ 用户的「🗑 丢弃」
// 是纯软约束，lead 可以立刻重建同目标团队；而且 `/plan` 保存草稿时还会**主动清除**该标记，
// 让「丢弃」被任何一次草稿写入复活。
//
// 本测试端到端驱动真实的 /team 命令与 /plan/discard 路由（fake ctx + 隔离 DSH_HOME），断言：
//   ① 丢弃后同目标 → 被拒绝（且不创建 run 目录）
//   ② 标点差异视为同目标（goalKey 归一化生效）
//   ③ 显式 --allow-rebuild → 放行，并在新 run 的 RUN.log 留痕
//   ④ 不同目标 → 放行
//   ⑤ /plan 保存草稿不再静默清除 planDiscarded（除非显式 allowRebuild）
//
// 变异验证：实现前必须红，实现后必须绿。
// 运行：node plan-discard.test.mjs   （仅工作区临时目录，不触碰真实 ~/.dsh）

import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 隔离环境：先把 DSH_HOME 指向临时目录，再加载模块 ──
const root = await mkdtemp(join(tmpdir(), 'dsh-et-discard-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply } = await import(join(here, 'lib', 'command.js'));

let registered = null;
const handlers = {};
const fakeCtx = {
  commands: { register: (d) => { registered = d; } },
  on: () => {},
  get: (k) => {
    if (k === 'subagents') return { listChildren: async () => [] };
    if (k === 'agents') return { list: () => [] };
    return undefined;
  },
  inject: (deps, f) => {
    if (String(deps) === 'webServer') {
      f({ effect: (fn) => fn(), webServer: { register: (c) => { handlers[c.path] = c.handler; return () => {}; } } });
    }
  },
};
apply(fakeCtx);
check(!!registered, 'commands.register 被调用（/team 已注册）');
check(typeof handlers['/plugins/dsh-expert-team/plan/discard'] === 'function', '/plan/discard 路由已注册');
check(typeof handlers['/plugins/dsh-expert-team/plan'] === 'function', '/plan 路由已注册');

let lastFollowup = '';
// 约定（与 regression.test.mjs 一致）：dsh 命令框架传给 handler 的 rawInput **只是参数部分**，
// 不含 `/team` 前缀。本助手统一剥离，让调用点可以写成 `/team ...` 更好读。
// ⚠️ 若不剥离：task 会带上 "/team"，slugify 后 runId 变成 "team-xxx"（假象），
// 且开头的 `--flag` 循环永不执行 —— 本测试第一版正是踩了这个坑。
const cmd = (rawInput) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-discard-1', header: { cwd } }, followup: (m) => { lastFollowup = m; } },
});

// 注意：`readRequestBody` 用 `String(req.body)` 解析，所以 body **必须是 JSON 字符串**；
// 传对象会变成 "[object Object]" 导致解析失败（这是本测试第一版的真实踩坑）。
const route = (path, opts = {}) => new Promise((resolve) => {
  const raw = opts.body == null ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  const req = { method: opts.method || 'POST', url: path, body: raw };
  const res = { writeHead() {}, end: (b) => resolve(b ? JSON.parse(b) : null) };
  handlers[path](req, res);
});

// 注意：`readdir` 需过滤**目录** —— teamRoot 下还有 METRICS.md 这类文件（autoAggregate 写的）
const runsIn = async () => {
  try {
    const es = await readdir(join(cwd, 'team'), { withFileTypes: true });
    return es.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
};

console.log('\n① 建立第一个 run 并丢弃它的计划');
const GOAL = '做一个登录页';
const r1 = await cmd(`/team ${GOAL}`);
check(r1 && r1.kind === 'success', '第一个 /team 创建成功', r1 ? r1.kind : '(无返回)');
const runs1 = await runsIn();
check(runs1.length === 1, '已创建 1 个 run 目录', runs1.join(','));
const run1 = runs1[0];
const st1 = JSON.parse(await readFile(join(cwd, 'team', run1, 'STATE.json'), 'utf8'));
check(!!st1.goalKey, 'STATE.json 记录了 goalKey（批 0-3 新增）', `goalKey=${st1.goalKey}`);

const d = await route('/plugins/dsh-expert-team/plan/discard', { body: { workspace: cwd, run: run1, reason: '用户改主意了' } });
check(d && d.ok === true, '/plan/discard 成功');
const st1b = JSON.parse(await readFile(join(cwd, 'team', run1, 'STATE.json'), 'utf8'));
check(!!st1b.planDiscarded, 'planDiscarded 已置位');
check(!!(st1b.planDiscarded && st1b.planDiscarded.goalKey), 'planDiscarded 记录了 goalKey（批 0-3 新增）',
  st1b.planDiscarded ? `goalKey=${st1b.planDiscarded.goalKey}` : '');

console.log('\n② 同目标重建必须被拒绝（本项的核心断言）');
const r2 = await cmd(`/team ${GOAL}`);
check(r2 && r2.kind === 'error', '同目标 → 返回 error（被拒绝）', r2 ? r2.kind : '(无返回)');
check(!!(r2 && /拒绝|丢弃/.test(r2.text || '')), '拒绝文案说明了原因', r2 ? String(r2.text).slice(0, 60) : '');
const runs2 = await runsIn();
check(runs2.length === 1, '被拒绝时**没有**创建新 run 目录', `当前 ${runs2.length} 个`);

console.log('\n③ 标点差异应视为同一目标（goalKey 归一化）');
const r3 = await cmd(`/team ${GOAL}。`);
check(r3 && r3.kind === 'error', '「做一个登录页。」仍被拒绝（归一化生效）', r3 ? r3.kind : '(无返回)');

console.log('\n④ 不同目标必须放行');
const r4 = await cmd('/team 做一个注册页');
check(r4 && r4.kind === 'success', '不同目标 → 放行', r4 ? r4.kind : '(无返回)');

console.log('\n⑤ 显式 --allow-rebuild 必须放行并留痕');
// 用"调用前后差集"定位新 run —— 按名字排序取 newest 会选错（④ 的「注册页」在字典序上更靠后）
const before5 = await runsIn();
const r5 = await cmd(`/team --allow-rebuild ${GOAL}`);
check(r5 && r5.kind === 'success', '--allow-rebuild → 放行', r5 ? r5.kind : '(无返回)');
const created5 = (await runsIn()).filter((x) => !before5.includes(x));
check(created5.length === 1, '确实新建了 1 个 run 目录', created5.join(','));
const newest = created5[0];
if (newest) {
  const log = await readFile(join(cwd, 'team', newest, 'RUN.log.md'), 'utf8');
  check(/plan:unlock/.test(log), 'RUN.log 记录了 plan:unlock 留痕');
}

console.log('\n⑥ /plan 保存草稿不得静默清除 planDiscarded');
// 先造一个仍带 planDiscarded 的 run（用第二个 run：r4 的）
const run4 = (await runsIn()).find((x) => !runs1.includes(x) && x !== newest);
if (run4) {
  await route('/plugins/dsh-expert-team/plan/discard', { body: { workspace: cwd, run: run4, reason: '测试' } });
  // 不带 allowRebuild 保存草稿
  const p1 = await route('/plugins/dsh-expert-team/plan', {
    body: { workspace: cwd, run: run4, draft: { roles: ['pm'], tasks: [{ id: 't1', owner: 'pm', title: 'x' }] } },
  });
  check(p1 && p1.ok === true, '/plan 保存草稿成功');
  const s4 = JSON.parse(await readFile(join(cwd, 'team', run4, 'STATE.json'), 'utf8'));
  check(!!s4.planDiscarded, '保存草稿后 planDiscarded **仍在**（不再被静默清除）');
  // 带 allowRebuild 保存草稿 → 应被清除
  const p2 = await route('/plugins/dsh-expert-team/plan', {
    body: { workspace: cwd, run: run4, allowRebuild: true, draft: { roles: ['pm'], tasks: [{ id: 't1', owner: 'pm', title: 'x' }] } },
  });
  check(p2 && p2.ok === true, '带 allowRebuild 保存草稿成功');
  const s4b = JSON.parse(await readFile(join(cwd, 'team', run4, 'STATE.json'), 'utf8'));
  check(!s4b.planDiscarded, '显式 allowRebuild 后 planDiscarded 被解除');
} else {
  check(false, '未能定位用于 ⑥ 的 run');
}

console.log('');
if (fail > 0) {
  console.log(`✗ planDiscarded 强制测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ planDiscarded 代码强制测试通过（同目标重建被拦、显式解锁放行且留痕）');
