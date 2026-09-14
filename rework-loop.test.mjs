// 测试：返工收敛硬门禁（P3 · SPEC.md §1.1–§1.5 的机判契约）
//
// 为什么需要它：`maxReviewRounds` / `maxTestRounds` 曾只活在 SKILL/PIPELINE/EFFICIENCY/WORKSPACE 文档里
//（`packages/dsh-expert-team/lib/command.js` 里**零命中**）⇒ 返工循环没有硬停止点，只能靠人喊停。
// 真实事故（非假设）：`php/school` 的一个 run —— 68 任务 / 32 条 repair / maxRound=8，评审每轮都在
// **新增** finding，永不收敛。B-01 把口号变成了代码（读侧 V1/V2 + 写侧 REWORK_LOOP_LIMIT + METRICS 撤销率），
// 本文件把那套门禁**逐条钉死**：每条断言都必须能因实现退化而变红 —— 由
// `packages/dsh-expert-team/regression.fixtures/mutations.json` 的 M76/M77/M78 反向证明（三者都指向本文件）。
//
// 契约更正（SPEC.md §5）在本文件里的落点：
//   · C2：`POST /plan` 因 normalizeDraft 钉死 `round: 1` 而**造不出**超限任务 ⇒ 写侧用例走
//         「预置 `STATE.draft` + `POST /plan/approve`」（证明**接线**）+ 直调 `_live.reworkLoopWriteGuard`
//         （证明**逻辑**），**两条都有**。
//   · C3：`reverted` 在「任务级 `revertedFindings`」与「元素级标记」同时存在时按 **per-task max** 计
//         ⇒ 用例断言"不双计"。
//   · C4：V2 依赖 finding 标题**跨轮稳定** ⇒ 用例用同一标题，并逐条给反例（单轮 / 后一轮 pass /
//         跨轮 1→3 / 标题不同）；每个反例都在**同一份输出**里带一个必报的对照标题，保证"不报"不是空断言。
//   · C5：METRICS 撤销率的口径、以及「无标记时如实渲染『暂无撤销登记』」都被断言。
//
// 运行：node rework-loop.test.mjs

import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
const firstLine = (text, re) => (String(text).match(re) || ['(未找到)'])[0];

const root = await mkdtemp(join(tmpdir(), 'dsh-et-loop-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply, _live } = await import(join(here, 'lib', 'command.js'));
let registered = null;
const routes = {};
apply({
  commands: { register: (d) => { registered = d; } },
  on: () => {},
  get: () => undefined,
  // 写侧用例必须走**真实注册表**（接线是验收项）；`inject` 的 deps 是 `['webServer']`（数组），
  // `String(deps)` 归一后比对（与 metrics.test.mjs 同款桩：`effect` 立即执行，否则路由根本不注册）。
  inject: (deps, f) => {
    if (String(deps) !== 'webServer') return;
    f({ effect: (fn) => { fn(); }, webServer: { register: (c) => { routes[String(c.path)] = c.handler; return () => {}; } } });
  },
});
const cmdIn = (rawInput, c = cwd) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-loop-1', header: { cwd: c } }, followup: () => {} },
});
const runsIn = async (c = cwd) => (await readdir(join(c, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const readText = (p) => readFile(p, 'utf8');
const readJson = async (p) => JSON.parse(await readText(p));

/** 建一个**独立工作区**的 run（METRICS 是跨 run 聚合的，混在一个工作区里计数会互相干扰）。 */
async function newWorkspaceRun(name, goal) {
  const c = join(root, name);
  await mkdir(c, { recursive: true });
  await cmdIn(goal, c);
  const dirs = await runsIn(c);
  if (dirs.length !== 1) throw new Error(`工作区 ${name} 期望恰好 1 个 run，实际 ${dirs.length}`);
  const run = dirs[0];
  return { c, run, dir: join(c, 'team', run) };
}

// ── 任务/状态夹具：字段与真实 TASKS.json 同形（避免触发**无关**违规，让断言只盯轮次门禁）──
const IMPL = (id, round = 1) => ({
  id, kind: 'implementation', owner: 'backend', title: id, spec: '', acceptance: [], inScope: [],
  verify: ['npm test'], dependsOn: [], attempt: 0, attemptId: null, round, verdict: 'pass', findings: [], status: 'completed',
});
const Q = (id, kind, round, verdict, findings = [], extra = {}) => ({
  id, kind, owner: (kind === 'review' || kind === 'requirements') ? 'reviewer' : 'qa',
  title: id, spec: '', acceptance: [], inScope: [], verify: [], dependsOn: [],
  attempt: 0, attemptId: null, round, verdict, findings,
  status: verdict === 'pass' ? 'completed' : 'failed', ...extra,
});
const putTasks = (dir, tasks) => writeFile(join(dir, 'TASKS.json'), JSON.stringify({ rounds: { review: 0, test: 0, repair: 0 }, tasks }, null, 2) + '\n');
const patchState = async (dir, patch) => {
  const st = await readJson(join(dir, 'STATE.json'));
  await writeFile(join(dir, 'STATE.json'), JSON.stringify({ ...st, ...patch }, null, 2) + '\n');
};
const checkText = async (run, c = cwd) => JSON.stringify(await cmdIn(`check ${run}`, c));
// 逐**行**判定用（`checkText` 是 JSON 字符串：换行是 `\n` 转义 ⇒ 跨行正则会把 ❌ 行和后面的 ⚠ 行连起来误判）
const checkLines = async (run, c = cwd) => String((await cmdIn(`check ${run}`, c)).text || '').split('\n');
const post = async (path, body) => {
  const h = routes[path];
  if (!h) throw new Error(`路由未注册：${path}（已注册：${Object.keys(routes).join(', ')}）`);
  let code = 0, out = '';
  await h({ method: 'POST', body: JSON.stringify(body) }, { writeHead: (c) => { code = c; }, end: (s) => { out = s; } });
  return { code, body: JSON.parse(out || '{}') };
};

console.log('# 返工收敛硬门禁（P3）\n');

// 主工作区：读侧 V1/V2 共用**同一个** run（同一份 TASKS.json，逐组改写）
const main = await newWorkspaceRun('proj', '返工收敛门禁验证');
const dir = main.dir, run = main.run;

// ══════════════════════════════════════════════════════════════════════════
console.log('① V1 命中：质量任务超上限且无 pendingDecision ⇒ 必须报「返工循环未升级」');
await putTasks(dir, [IMPL('be-1'), Q('rv-4', 'review', 4, 'reject')]);
await patchState(dir, { pendingDecision: null });
const out1 = await checkText(run);
check(out1.includes('返工循环未升级'), '① 报出「返工循环未升级」', firstLine(out1, /\[rv-4\][^"]*/));
check(/\[rv-4\] 已进入第 4 轮（上限 3，review）仍无 pendingDecision/.test(out1), '① 文案逐字含 id / 轮次 / 上限 / kind', '');
const tasksTextAt1 = await readText(join(dir, 'TASKS.json'));

console.log('\n② V1 不误报：同一任务集 + pendingDecision 有值 ⇒ 不报');
await patchState(dir, { pendingDecision: { title: '审查到上限', options: ['继续', '停止'] } });
const out2 = await checkText(run);
check(!out2.includes('返工循环未升级'), '② 有 pendingDecision ⇒ 不报该违规', '');
check(!/\[rv-4\] 已进入第/.test(out2), '② 具体到该任务也不报（不是只改文案）', '');
check((await readText(join(dir, 'TASKS.json'))) === tasksTextAt1, '② 与① 的任务表逐字同一份 ⇒ 唯一变量是 pendingDecision（不报才有意义）', '');

console.log('\n③ V1 边界：round === 上限(3) 不报，而同一份输出里 round:4 必须仍被报');
await putTasks(dir, [IMPL('be-1'), Q('rv-3', 'review', 3, 'reject'), Q('qa-4', 'verification', 4, null)]);
await patchState(dir, { pendingDecision: null });
const out3 = await checkText(run);
check(!/\[rv-3\] 已进入第/.test(out3), '③ round === 3 不报（`>` 而非 `>=`）', '');
check(/\[qa-4\] 已进入第 4 轮（上限 3，verification）/.test(out3), '③ 同输出的 round:4 verification 仍被报 ⇒ 上面的"不报"不是空断言', firstLine(out3, /\[qa-4\][^"]*/));
check(/\[rv-3\] 已进入第 4 轮/.test(out3) === false, '③ 不得把边界值 +1 后冒充超限', '');

console.log('\n④ V2 命中：同一 finding 标题出现在**相邻两轮**、且两轮均非 pass ⇒ 判规格歧义');
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ severity: 'high', title: '未校验 token' }]),
  Q('rv-2', 'review', 2, 'reject', [{ severity: 'high', title: '未校验 token' }]),
  Q('rv-4', 'review', 4, 'reject'), // 只作"门禁活着"的对照，不带 findings（不干扰 V2 分组）
]);
await patchState(dir, { pendingDecision: null });
const out4 = await checkText(run);
check(out4.includes('连续第 1/2 轮仍未闭环'), '④ 报出「连续第 1/2 轮仍未闭环」', firstLine(out4, /\[未校验 token\][^"]*/));
check(out4.includes('判为规格歧义，应升级用户裁定而非再派修复'), '④ 文案含动作指引（升级用户裁定 ≠ 再派修复）', '');
check(/\[rv-4\] 已进入第 4 轮/.test(out4), '④ 同一份输出含 V1 ⇒ 读侧门禁确实在跑（V2 命中不是巧合）', '');

console.log('\n⑤ V2 不误报：单轮 / 后一轮 pass / 跨轮 1→3 / 标题不同 —— 每组都带**同输出的必报对照**');
// ⑤-1 只在单轮出现（对照 PAIR-CONTROL 跨 1/2 轮，必须报）
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'ONLY-SINGLE-TITLE' }, { title: 'PAIR-CONTROL' }]),
  Q('rv-2', 'review', 2, 'reject', [{ title: 'PAIR-CONTROL' }]),
  Q('rv-4', 'review', 4, 'reject'),
]);
await patchState(dir, { pendingDecision: null });
let out5 = await checkText(run);
check(out5.includes('连续第 1/2 轮仍未闭环') && !/\[ONLY-SINGLE-TITLE\]/.test(out5), '⑤-1 单轮出现 ⇒ 不报', firstLine(out5, /\[PAIR-CONTROL\][^"]*/));
// ⑤-2 后一轮 pass ⇒ 已闭环，不报（对照任务必须在**非 pass** 的 round 2 任务上，否则它自己也会被"已闭环"吞掉）
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'PASS-LATER' }, { title: 'PAIR-CONTROL' }]),
  Q('rv-2', 'review', 2, 'pass', [{ title: 'PASS-LATER' }]),
  Q('rv-2b', 'review', 2, 'needs_revision', [{ title: 'PAIR-CONTROL' }]),
  Q('rv-4', 'review', 4, 'reject'),
]);
out5 = await checkText(run);
check(out5.includes('连续第 1/2 轮仍未闭环') && !/\[PASS-LATER\]/.test(out5), '⑤-2 后一轮已 pass ⇒ 不报', '');
// ⑤-3 跨轮 1→3 不算"连续"
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'CROSS-13' }, { title: 'PAIR-CONTROL' }]),
  Q('rv-2', 'review', 2, 'reject', [{ title: 'PAIR-CONTROL' }]),
  Q('rv-3', 'review', 3, 'reject', [{ title: 'CROSS-13' }]),
  Q('rv-4', 'review', 4, 'reject'),
]);
out5 = await checkText(run);
check(out5.includes('连续第 1/2 轮仍未闭环') && !/\[CROSS-13\]/.test(out5), '⑤-3 跨轮 1→3 ⇒ 不报（只认相邻两轮）', '');
// ⑤-4 标题不同 ⇒ 不是"同一个 finding"
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'DIFF-A' }, { title: 'PAIR-CONTROL' }]),
  Q('rv-2', 'review', 2, 'reject', [{ title: 'DIFF-B' }, { title: 'PAIR-CONTROL' }]),
  Q('rv-4', 'review', 4, 'reject'),
]);
out5 = await checkText(run);
check(out5.includes('连续第 1/2 轮仍未闭环') && !/\[DIFF-A\]/.test(out5) && !/\[DIFF-B\]/.test(out5), '⑤-4 标题不同 ⇒ 不报（C4：标题必须跨轮稳定）', '');
// ⑤-5 归一化仍算同一标题（trim + 空白折叠）—— 防"因为多一个空格就漏报"
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: '  未校验   token  ' }]),
  Q('rv-2', 'review', 2, 'reject', [{ detail: '未校验 token' }]),
  Q('rv-4', 'review', 4, 'reject'),
]);
out5 = await checkText(run);
check(out5.includes('连续第 1/2 轮仍未闭环'), '⑤-5 首尾空格/多空格归一后仍是同一 finding ⇒ 必须报', firstLine(out5, /\[未校验[^"]*/));
// ⑤-6 口径钉子（R21 · SG-5）：**同一轮**里两个质量任务带**同一 finding**，一个 pass、一个 needs_revision
// ⇒ 该轮算**未闭环**（AND 口径：该轮**全部**此类任务都 pass 才算闭合；任一非 pass ⇒ 未闭环）
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'AND-SAME' }]),
  Q('rv-2', 'review', 2, 'pass', [{ title: 'AND-SAME' }]),
  Q('rv-2b', 'review', 2, 'needs_revision', [{ title: 'AND-SAME' }]),
  Q('rv-4', 'review', 4, 'reject'),
]);
out5 = await checkText(run);
check(out5.includes('连续第 1/2 轮仍未闭环'), '⑤-6 同轮混合裁决 ⇒ 该轮算未闭环（AND 口径）', firstLine(out5, /\[AND-SAME\][^"]*/));
// ⑤-7 判定域钉子（R21 · SG-5）：判定域 = **含该 finding 的任务**，不是"该轮的全部质量任务" ——
// 该 finding 只在第 2 轮的 **pass** 任务上，而同轮另有一个非 pass 任务带的是**别的** finding
// ⇒ 这一条**不得**被判未闭环（若把判定域放宽成"该轮任一任务非 pass"，这里就会误报）。
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'DOMAIN-PASS-ONLY' }, { title: 'PAIR-CONTROL' }]),
  Q('rv-2', 'review', 2, 'pass', [{ title: 'DOMAIN-PASS-ONLY' }]),
  Q('rv-2b', 'review', 2, 'needs_revision', [{ title: 'DIFFERENT-FINDING' }, { title: 'PAIR-CONTROL' }]),
  Q('rv-4', 'review', 4, 'reject'),
]);
out5 = await checkText(run);
check(out5.includes('连续第 1/2 轮仍未闭环') && !/\[DOMAIN-PASS-ONLY\]/.test(out5), '⑤-7 判定域 = 含该 finding 的任务（同轮另一条 finding 非 pass 不算）', firstLine(out5, /\[PAIR-CONTROL\][^"]*/));
check(!/\[DIFFERENT-FINDING\]/.test(out5), '⑤-7 对照：只出现在单轮的 finding 不报', '');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n⑥ 写侧拦截：新增超限质量任务**落盘前**拒（REWORK_LOOP_LIMIT），磁盘逐字未变');
const w = await newWorkspaceRun('write-proj', '写侧拦截验证');
await putTasks(w.dir, [IMPL('be-1')]);
// C2：`POST /plan` 造不出 round>1（normalizeDraft 钉死 1）⇒ 预置 STATE.draft 再批准（走真实路由）
await patchState(w.dir, {
  pendingDecision: null,
  draft: { updatedAt: new Date().toISOString(), tasks: [Q('rv-4', 'review', 4, 'reject')] },
});
const before = await readText(join(w.dir, 'TASKS.json'));
const res1 = await post('/plugins/dsh-expert-team/plan/approve', { workspace: w.c, run: w.run });
check(res1.code === 400 && res1.body.error === 'REWORK_LOOP_LIMIT', '⑥ 路由级：新增 round:4 ⇒ HTTP 400 + 错误码 REWORK_LOOP_LIMIT', `HTTP ${res1.code} · error=${res1.body.error}`);
const after = await readText(join(w.dir, 'TASKS.json'));
check(before === after, '⑥ 磁盘 TASKS.json **逐字未变**（fail loud、不静默截断）', `${before.length} → ${after.length} 字符`);
check(/任务 \[rv-4\] 第 4 轮超过上限 3（REWORK_LOOP_LIMIT）—— 未落盘；请先写 STATE.pendingDecision 升级用户/.test(JSON.stringify(res1.body.detail || [])), '⑥ 错误消息逐字含「未落盘」+ 升级指引（不是静默截断、也不只是"失败"）', firstLine(JSON.stringify(res1.body.detail || []), /任务 \[rv-4\][^"]*/));
// 立起 pendingDecision ⇒ 同一写入成功（"到顶的正确动作是升级，不是禁止"）
await patchState(w.dir, { pendingDecision: { title: '审查到上限', options: ['继续', '停止'] } });
const res2 = await post('/plugins/dsh-expert-team/plan/approve', { workspace: w.c, run: w.run });
const text2 = await readText(join(w.dir, 'TASKS.json'));
check(res2.code === 200 && res2.body.ok === true, '⑥ 立起 pendingDecision 后同一写入成功', `HTTP ${res2.code}`);
check(text2.includes('"rv-4"'), '⑥ 放行后 rv-4 真的落盘（对照：拒绝时它不在盘上）', '');
check(!before.includes('"rv-4"'), '⑥ 反证：被拒那一刻盘上确实没有 rv-4', '');

// ⑥-b R23（FIND-7）：**无 id** 的质量任务不再被放行 —— 手写 `STATE.draft`（`/plan/approve` 吃的正是
// 可被文件工具手写的草稿）塞一个没有 id 的 round:4 任务，过去能穿过写侧闸门（`if (!id …) continue`）。
const noId = (round) => ({ kind: 'review', owner: 'reviewer', title: '无 id 的评审任务', round, verdict: null, findings: [], status: 'pending', dependsOn: [] });
await putTasks(w.dir, [IMPL('be-1')]);
await patchState(w.dir, { pendingDecision: null, draft: { updatedAt: new Date().toISOString(), tasks: [noId(4)] } });
const beforeNoId = await readText(join(w.dir, 'TASKS.json'));
const resNoId = await post('/plugins/dsh-expert-team/plan/approve', { workspace: w.c, run: w.run });
check(resNoId.code === 400 && resNoId.body.error === 'REWORK_LOOP_LIMIT', '⑥-b 路由级：**无 id** 的 round:4 质量任务 ⇒ 400 + REWORK_LOOP_LIMIT', `HTTP ${resNoId.code} · error=${resNoId.body.error}`);
check(/任务 \[\(no-id\)\] 第 4 轮超过上限 3（REWORK_LOOP_LIMIT）/.test(JSON.stringify(resNoId.body.detail || [])), '⑥-b 报错里以 `(no-id)` 指代该任务（逐字）', firstLine(JSON.stringify(resNoId.body.detail || []), /任务 \[\(no-id\)\][^"]*/));
check((await readText(join(w.dir, 'TASKS.json'))) === beforeNoId, '⑥-b 磁盘 TASKS.json 逐字未变', '');
// 对照：同一"无 id"任务但 round:1 ⇒ 不超限 ⇒ 放行（证明拦的是"超限"，不是"无 id"本身）
await patchState(w.dir, { draft: { updatedAt: new Date().toISOString(), tasks: [noId(1)] } });
const resNoId1 = await post('/plugins/dsh-expert-team/plan/approve', { workspace: w.c, run: w.run });
check(resNoId1.code === 200 && resNoId1.body.ok === true, '⑥-b 对照：同一无 id 任务 round:1 ⇒ 放行（拦的是超限而非"无 id"）', `HTTP ${resNoId1.code}`);

// 纯函数级（C2 第二条）：逻辑本身的边界
const { reworkLoopWriteGuard } = _live;
const g1 = reworkLoopWriteGuard({ tasks: [Q('rv-4', 'review', 4, 'reject')], existingTasks: [] }, null);
check(!!g1 && g1.code === 'REWORK_LOOP_LIMIT' && g1.id === 'rv-4' && g1.actual === 4 && g1.limit === 3, '⑥ 纯函数级：返回 {code,id,actual,limit}', JSON.stringify(g1 && { code: g1.code, id: g1.id, actual: g1.actual, limit: g1.limit }));
check(!!g1 && /未落盘；请先写 STATE.pendingDecision/.test(g1.message), '⑥ 纯函数级：消息含升级指引', '');
check(reworkLoopWriteGuard({ tasks: [Q('rv-3', 'review', 3, 'reject')], existingTasks: [] }, null) === null, '⑥ 纯函数级：round === 上限 ⇒ 不拦（边界安全）', '');
check(reworkLoopWriteGuard({ tasks: [Q('rv-4', 'review', 4, 'reject')], existingTasks: [Q('rv-4', 'review', 4, 'reject')] }, null) === null, '⑥ 纯函数级：**原地更新**（id 已在磁盘）不拦', '');
check(reworkLoopWriteGuard({ tasks: [Q('rv-4', 'review', 4, 'reject')], existingTasks: [] }, { pendingDecision: { title: 'x' } }) === null, '⑥ 纯函数级：有 pendingDecision ⇒ 不拦', '');
check(reworkLoopWriteGuard({ tasks: [IMPL('be-9', 9)], existingTasks: [] }, null) === null, '⑥ 纯函数级：非质量类任务超轮次不拦（只管质量任务）', '');
check(reworkLoopWriteGuard({ tasks: [Q('qa-4', 'verification', 4, null)], existingTasks: [] }, null) !== null, '⑥ 纯函数级：verification 走 test 档，同样被拦', '');
// ⑥-c R23 纯函数级：无 id 一律按"新增"处理（无法与磁盘比对 ⇒ 不得放行）
const gNoId = reworkLoopWriteGuard({ tasks: [noId(4)], existingTasks: [] }, null);
check(!!gNoId && gNoId.code === 'REWORK_LOOP_LIMIT' && gNoId.id === '(no-id)', '⑥-c 纯函数级：无 id 的超限质量任务被拦，id 记为 `(no-id)`', JSON.stringify(gNoId && { code: gNoId.code, id: gNoId.id, actual: gNoId.actual, limit: gNoId.limit }));
check(!!gNoId && gNoId.message.includes('任务 [(no-id)] 第 4 轮超过上限 3（REWORK_LOOP_LIMIT）'), '⑥-c message 逐字含 `任务 [(no-id)] 第 4 轮超过上限 3（REWORK_LOOP_LIMIT）`', '');
check(reworkLoopWriteGuard({ tasks: [noId(3)], existingTasks: [] }, null) === null, '⑥-c 纯函数级：无 id 但 round === 上限 ⇒ 不拦（边界安全）', '');
check(reworkLoopWriteGuard({ tasks: [noId(4)], existingTasks: [Q('rv-9', 'review', 4, 'reject')] }, null) !== null, '⑥-c 纯函数级：磁盘有别的 id 也救不了它（无 id ⇒ 无法证明是更新）', '');
check(reworkLoopWriteGuard({ tasks: [{ ...noId(4), id: 'rv-9' }], existingTasks: [Q('rv-9', 'review', 4, 'reject')] }, null) === null, '⑥-c 对照：**有 id 且在盘上** ⇒ 原地更新不拦（无 id 与有 id 的差别就在这）', '');
// 接线（源级）：守卫定义 + 两个写入校验点，三处都在
const src = await readText(join(here, 'lib', 'command.js'));
const codeOnly = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check((codeOnly.match(/reworkLoopWriteGuard\(/g) || []).length >= 3, '⑥ 接线：守卫定义 + /plan 草案 + /plan/approve 三处调用', String((codeOnly.match(/reworkLoopWriteGuard\(/g) || []).length));

// ══════════════════════════════════════════════════════════════════════════
console.log('\n⑦ 配置：env 覆盖、非法值忽略（回默认）、以及容量侧 0 仍合法');
const cfg = await newWorkspaceRun('cfg-proj', '轮次上限配置验证');
await putTasks(cfg.dir, [IMPL('be-1'), Q('rv-4', 'review', 4, 'reject')]);
await patchState(cfg.dir, { pendingDecision: null });
check((await checkText(cfg.run, cfg.c)).includes('返工循环未升级'), '⑦ 默认 maxReviewRounds=3 ⇒ round:4 命中', '');
process.env.DSH_EXPERT_TEAM_MAX_REVIEW_ROUNDS = '5';
_live.resolveRoundLimits(undefined);
check(_live.ROUND_LIMITS.maxReviewRounds === 5, '⑦ env=5 被解析', String(_live.ROUND_LIMITS.maxReviewRounds));
check(!(await checkText(cfg.run, cfg.c)).includes('返工循环未升级'), '⑦ env=5 ⇒ 同一 run 的 round:4 不再命中（读侧真的吃这份配置）', '');
delete process.env.DSH_EXPERT_TEAM_MAX_REVIEW_ROUNDS;
_live.resolveRoundLimits(undefined);
check((await checkText(cfg.run, cfg.c)).includes('返工循环未升级'), '⑦ 撤掉 env ⇒ 回到默认 3、又命中（**无粘性**，不残留上一次的值）', '');
for (const bad of ['abc', -1, 0, null, '']) {
  const v = _live.resolveRoundLimits({ limits: { maxReviewRounds: bad } }).maxReviewRounds;
  check(v === 3, `⑦ 非法 maxReviewRounds=${JSON.stringify(bad)} 被忽略 ⇒ 默认 3`, String(v));
}
check(_live.resolveRoundLimits({ limits: { maxReviewRounds: 0.5 } }).maxReviewRounds === 3, '⑦ 0.5 取整后为 0 ⇒ 判非法回默认 3（不放回"上限 0 = 人人超限"的陷阱）', '');
check(_live.resolveRoundLimits({ limits: { maxReviewRounds: 7 } }).maxReviewRounds === 7, '⑦ 合法值 7 生效', '');
check(_live.resolveRoundLimits({ limits: { maxTestRounds: 2 } }).maxTestRounds === 2, '⑦ maxTestRounds 独立于 review 档', '');
check(_live.resolveRoundLimits({ limits: { maxReviewRounds: '6' } }).maxReviewRounds === 6, '⑦ 数字字符串按合法值收（与容量侧同语义）', '');
check(_live.resolveLimits({ limits: { maxTasks: 0 } }).maxTasks === 0, '⑦ 对照：**容量侧** maxTasks=0 仍合法（0 合法 vs 轮次侧 0 非法，两条口径不许被"统一"掉）', '');
// 2026-09-13（F 线设置控制台）：调用点多了"设置值作为最低优先级来源"这一参数 ⇒ 断言**重钉**（不放宽）。
check(/resolveRoundLimits\(config, roundLimitsBaseFromSettings\(\)\);/.test(codeOnly), '⑦ 接线：apply(ctx, config) 里解析轮次上限（含设置来源）', '');
_live.resolveRoundLimits(undefined); // 复位（后续用例不吃这份配置）
_live.resolveLimits(null);
check(_live.ROUND_LIMITS.maxReviewRounds === 3 && _live.ROUND_LIMITS.maxTestRounds === 3, '⑦ 复位：ROUND_LIMITS 回到默认', JSON.stringify(_live.ROUND_LIMITS));

// ══════════════════════════════════════════════════════════════════════════
console.log('\n⑧ METRICS「评审效率（轮次 / 撤销率）」：只认显式撤销标记，无标记时如实说明');
const meta = await newWorkspaceRun('meta-proj', '撤销率验证');
const F = (n) => new Array(n).fill(0).map((_, i) => ({ title: 'f' + (i + 1) }));
const metricsOf = async () => { await cmdIn('learn', meta.c); return readText(join(meta.c, 'team', 'METRICS.md')); };
// ⑧-1 任务级 revertedFindings: 2 + 5 条 findings
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', F(5), { revertedFindings: 2 })]);
let m = await metricsOf();
check(m.includes('## 评审效率（轮次 / 撤销率）'), '⑧ 节标题逐字存在', firstLine(m, /## 评审效率[^\n]*/));
check(m.includes('- 撤销幻觉：2 / 5（撤销率 40% · 覆盖 1/1 个质量任务）'), '⑧ revertedFindings:2 + 5 条 findings ⇒ `2 / 5（撤销率 40%）` + 覆盖率', firstLine(m, /- 撤销幻觉：[^\n]*/));
check(/- 评审轮次：review 1 轮 · test 0 轮/.test(m), '⑧ 轮次行逐字（review/test 取质量任务最大 round）', firstLine(m, /- 评审轮次：[^\n]*/));
// ⑧-2 无任何撤销标记 ⇒ 如实渲染「暂无撤销登记」，**不得沉默**
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', F(5))]);
m = await metricsOf();
check(m.includes('- （暂无撤销登记：质量任务 findings 未标记 reverted）'), '⑧ 无标记 ⇒ 渲染「暂无撤销登记：质量任务 findings 未标记 reverted」（不得静默省略）', firstLine(m, /- （暂无撤销[^\n]*/));
check(!/- 撤销幻觉：/.test(m), '⑧ 无标记时不得凭空报一行 0 / 5 冒充"已统计"', '');
// ⑧-3 元素级标记：reverted === true / severity === 'reverted'
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', [{ title: 'f1', reverted: true }, { title: 'f2', severity: 'reverted' }, { title: 'f3' }])]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：2 / 3（撤销率 67% · 覆盖 1/1 个质量任务）'), '⑧ 元素级 reverted===true / severity===\'reverted\' ⇒ 2 / 3（67%）', firstLine(m, /- 撤销幻觉：[^\n]*/));
// ⑧-4 两者同时存在 ⇒ per-task max，不双计（C3）
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', [{ title: 'f1', reverted: true }, { title: 'f2', severity: 'reverted' }, { title: 'f3' }, { title: 'f4' }, { title: 'f5' }], { revertedFindings: 2 })]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：2 / 5（撤销率 40% · 覆盖 1/1 个质量任务）'), '⑧ 任务级 2 + 元素级 2 同时存在 ⇒ 仍 `2 / 5`（per-task max，不双计）', firstLine(m, /- 撤销幻觉：[^\n]*/));
check(!/- 撤销幻觉：4 \/ 5/.test(m), '⑧ 反证：不得双计成 `4 / 5（80%）`', '');
// ⑧-5 不得从自然语言猜"撤销"二字
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', [{ title: '撤销了 3 条幻觉（散文，非标记）' }, { title: 'x' }])]);
m = await metricsOf();
check(m.includes('- （暂无撤销登记：质量任务 findings 未标记 reverted）'), '⑧ 散文里的「撤销」二字**不得**被当成撤销标记（禁止模糊匹配）', firstLine(m, /- （暂无撤销[^\n]*/));
// ⑧-6 非质量任务的 findings 不计入分母
await putTasks(meta.dir, [IMPL('be-1'), Q('rv-1', 'review', 1, 'pass', F(4), { revertedFindings: 1 })]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：1 / 4（撤销率 25% · 覆盖 1/1 个质量任务）'), '⑧ 分母只算质量任务（实现任务的 findings 不掺进来）', firstLine(m, /- 撤销幻觉：[^\n]*/));
// ⑧-7 R20（C11）：分母改用任务级 `retracted`（审查者**自报疑似总数**，含事后被撤销的）——
// 用 findings.length（= 成立的问题数）当分母会得到完全不同的数。契约用例逐字：12/10/findings 8 ⇒ 10/12（83%）。
await putTasks(meta.dir, [Q('rv-1', 'requirements', 1, 'needs_revision', F(8), { retracted: 12, revertedFindings: 10 })]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：10 / 12（撤销率 83% · 覆盖 1/1 个质量任务）'), '⑧-7 retracted:12 + revertedFindings:10 + findings 8 ⇒ `10 / 12（撤销率 83%）`（C11）', firstLine(m, /- 撤销幻觉：[^\n]*/));
check(!/- 撤销幻觉：10 \/ 8/.test(m), '⑧-7 反证：**不得**退回 findings 口径得到 `10 / 8`', '');
// ⑧-8 无 `retracted` 字段、**但有撤销证据** ⇒ 退回 findings.length（SPEC.md §2.1 用例 8 冻结的行为，不回归）
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', F(4), { revertedFindings: 3 })]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：3 / 4（撤销率 75% · 覆盖 1/1 个质量任务）'), '⑧-8 无 retracted 但有撤销证据 ⇒ 退回 findings.length 口径（不回归）', firstLine(m, /- 撤销幻觉：[^\n]*/));
// ⑧-9 `retracted` 为 0 / 负数 / 非数字 / null ⇒ 视为**缺失**并退回（不得当成"自报 0 条"把分母清零）
for (const bad of [0, -1, 'abc', null]) {
  await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', F(5), { retracted: bad, revertedFindings: 2 })]);
  m = await metricsOf();
  check(m.includes('- 撤销幻觉：2 / 5（撤销率 40% · 覆盖 1/1 个质量任务）'), `⑧-9 retracted=${JSON.stringify(bad)} ⇒ 视为缺失、退回 findings 口径`, firstLine(m, /- 撤销幻觉：[^\n]*/));
}
// ⑧-10 多任务并存 ⇒ 分母/分子各自相加
await putTasks(meta.dir, [
  Q('rv-1', 'requirements', 1, 'needs_revision', F(8), { retracted: 12, revertedFindings: 10 }),
  Q('qa-1', 'verification', 1, 'needs_revision', F(9), { retracted: 8, revertedFindings: 2 }),
]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：12 / 20（撤销率 60% · 覆盖 2/2 个质量任务）'), '⑧-10 两个任务 ⇒ Σ分子/Σ分母（10+2 / 12+8 = 12/20 = 60%）· 覆盖 2/2', firstLine(m, /- 撤销幻觉：[^\n]*/));
// ⑧-11 SG-4：两种"零"必须**可区分** —— ① 自报了 N 条但 0 条标记（提示级）② 压根没人登记（暂无撤销登记）
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', F(3), { retracted: 73 })]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：0 / 73（撤销率 0% · 覆盖 1/1 个质量任务）（自报 73 条但 0 条标记撤销 —— 若确有撤销请补 revertedFindings）'), '⑧-11a 自报 73 条但 0 条标记 ⇒ 同一行 + 覆盖率 + 逐字提示（"没人登记"显形）', firstLine(m, /- 撤销幻觉：[^\n]*/));
const renderReportedZero = firstLine(m, /- 撤销幻觉：[^\n]*/);
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', [])]);
m = await metricsOf();
check(m.includes('- （暂无撤销登记：质量任务 findings 未标记 reverted）'), '⑧-11b 压根没人登记（无 retracted、无 findings）⇒ 仍渲染「暂无撤销登记」', firstLine(m, /- （暂无撤销[^\n]*/));
const renderNothingReported = firstLine(m, /- （暂无撤销登记[^\n]*/);
check(/- 撤销幻觉：0 \/ 73/.test(renderReportedZero) && /暂无撤销登记/.test(renderNothingReported) && renderReportedZero !== renderNothingReported, '⑧-11c 两种"零"渲染**不同形**（没人登记 vs 自报但 0 标记 —— SG-4 的全部要点）', `${renderReportedZero.slice(0, 20)}… ≠ ${renderNothingReported.slice(0, 20)}…`);
// ⑧-12 B-08C：run 级分母**不得混合口径** —— A（有 `retracted`）贡献 12/10；B（只有 7 条 findings、
// **无任何撤销标记、无 retracted** = QA 任务的常态）走分支 3 ⇒ 分子分母都不贡献 ⇒ 不是 10/19。
await putTasks(meta.dir, [
  Q('rv-1', 'requirements', 1, 'needs_revision', F(8), { retracted: 12, revertedFindings: 10 }),
  Q('qa-1', 'verification', 1, 'needs_revision', F(7)),
]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：10 / 12（撤销率 83% · 覆盖 1/2 个质量任务）'), '⑧-12 A(retracted 12/10) + B(7 findings、无标记) ⇒ `10 / 12（83%）· 覆盖 1/2`（不混合口径）', firstLine(m, /- 撤销幻觉：[^\n]*/));
check(!/10 \/ 19/.test(m) && !/53%/.test(m), '⑧-12 反证：混合分母的 `10 / 19` 与 `53%` **不得**出现', '');
// ⑧-13 分支 2：无 `retracted`，但 5 条 findings 里 2 条带元素级标记 ⇒ 分母就是 findings.length（同一总体）
await putTasks(meta.dir, [
  Q('rv-1', 'review', 1, 'pass', [{ title: 'f1', reverted: true }, { title: 'f2', severity: 'reverted' }, { title: 'f3' }, { title: 'f4' }, { title: 'f5' }]),
]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：2 / 5（撤销率 40% · 覆盖 1/1 个质量任务）'), '⑧-13 分支 2（元素级标记、无 retracted）⇒ `2 / 5（40%）`', firstLine(m, /- 撤销幻觉：[^\n]*/));
// ⑧-14 分支 1 + 分支 2 并存 ⇒ 分母相加、覆盖率相加
await putTasks(meta.dir, [
  Q('rv-1', 'requirements', 1, 'needs_revision', F(8), { retracted: 12, revertedFindings: 10 }),
  Q('rv-2', 'review', 2, 'needs_revision', [{ title: 'g1', reverted: true }, { title: 'g2', severity: 'reverted' }, { title: 'g3' }, { title: 'g4' }, { title: 'g5' }]),
]);
m = await metricsOf();
check(m.includes('- 撤销幻觉：12 / 17（撤销率 71% · 覆盖 2/2 个质量任务）'), '⑧-14 分支 1 + 分支 2 并存 ⇒ 分子 10+2、分母 12+5=17（12/17=71%）· 覆盖 2/2', firstLine(m, /- 撤销幻觉：[^\n]*/));
// ⑧-15 全部任务都无数据 ⇒ 占位句，**不得**渲染 `0 / 0`
await putTasks(meta.dir, [Q('rv-1', 'review', 1, 'pass', F(5)), Q('qa-1', 'verification', 1, 'pass', F(3))]);
m = await metricsOf();
check(m.includes('- （暂无撤销登记：质量任务 findings 未标记 reverted）'), '⑧-15 全部任务无数据（5+3 条 findings 但无任何标记）⇒ 占位句（QA 的 findings 不再冒充自报数）', firstLine(m, /- （暂无撤销[^\n]*/));
check(!/0 \/ 0/.test(m), '⑧-15 反证：**不得**渲染 `0 / 0`', '');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n⑨ R25（SG-3）：V2 的「无输入告警」—— 提示级、不进 violations，两种"没有 FINDING_REOPENED"必须可区分');
// ⑨-1 返工过（2 个非 pass 质量任务）但标题全不同 ⇒ V2 无输入 ⇒ 必须提示
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'A-ONE' }]),
  Q('rv-2', 'review', 2, 'reject', [{ title: 'B-TWO' }]),
]);
await patchState(dir, { pendingDecision: null });
let out9 = await checkText(run);
let lines9 = await checkLines(run);
check(lines9.some((l) => /⚠ FINDING_REOPENED_INPUT_MISSING/.test(l)), '⑨-1 返工过但标题无跨轮重复 ⇒ 出提示（⚠ 警告位，不是 ❌）', firstLine(out9, /FINDING_REOPENED_INPUT_MISSING[^"]*/));
check(out9.includes('本 run 有 2 个非 pass 质量任务、2 条 finding，但没有任何 finding 标题跨轮重复'), '⑨-1 提示含逐字的 N（非 pass 质量任务数）与 M（finding 条数）', '');
check(!lines9.some((l) => /❌/.test(l) && /FINDING_REOPENED_INPUT_MISSING/.test(l)), '⑨-1 该提示**不得**出现在违规位（普通 run 不许被判红）', `⚠ 行 ${lines9.filter((l) => /FINDING_REOPENED_INPUT_MISSING/.test(l)).length} 条 · ❌ 行 0 条`);
// ⑨-2 V2 有输入（标题跨轮重复）⇒ 不提示（此时它若没命中就是真的没命中）
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'STABLE-TITLE' }]),
  Q('rv-2', 'review', 2, 'reject', [{ title: 'STABLE-TITLE' }]),
]);
out9 = await checkText(run);
check(out9.includes('连续第 1/2 轮仍未闭环') && !out9.includes('FINDING_REOPENED_INPUT_MISSING'), '⑨-2 标题跨轮重复 ⇒ 不提示（且 V2 确实命中）', '');
// ⑨-3 没返工过（全部 pass）⇒ 不提示（"没有 FINDING_REOPENED"在这里是真的收敛）
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'pass', [{ title: 'P1' }]),
  Q('rv-2', 'review', 2, 'pass', [{ title: 'P2' }]),
]);
out9 = await checkText(run);
check(!out9.includes('FINDING_REOPENED_INPUT_MISSING'), '⑨-3 全部 pass（没返工过）⇒ 不提示', '');
// ⑨-4 只有 1 个非 pass 质量任务 ⇒ 不提示（阈值是 ≥2："返工过"是触发前提）
await putTasks(dir, [IMPL('be-1'), Q('rv-4', 'review', 4, 'reject')]);
out9 = await checkText(run);
check(!out9.includes('FINDING_REOPENED_INPUT_MISSING'), '⑨-4 只有 1 个非 pass 质量任务 ⇒ 不提示（不滥报）', '');
// ⑨-5 提示与 V1 共存：超限（读侧违规）与"无输入"（提示）是两条不同通道
await putTasks(dir, [
  IMPL('be-1'),
  Q('rv-1', 'review', 1, 'needs_revision', [{ title: 'X-ONE' }]),
  Q('rv-4', 'review', 4, 'reject'),
]);
out9 = await checkText(run);
lines9 = await checkLines(run);
check(lines9.some((l) => /❌/.test(l) && /返工循环未升级/.test(l)) && lines9.some((l) => /⚠/.test(l) && /FINDING_REOPENED_INPUT_MISSING/.test(l)), '⑨-5 同一份输出里 V1 在 ❌、R25 在 ⚠（两条通道不混）', '');

console.log('');
if (fail > 0) {
  console.log(`✗ 返工收敛门禁测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 返工收敛门禁测试通过（V1/V2 读侧 · REWORK_LOOP_LIMIT 写侧 · 轮次上限配置 · METRICS 撤销率）');
