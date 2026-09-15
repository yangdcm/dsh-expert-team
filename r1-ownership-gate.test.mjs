// 测试：**R1 工件归属硬门禁**（`tools/pre-execute`，写盘之前拦）
//
// 背景（一句话）：R1 = run 工件一律由**产出它的角色自己** `write`；lead 没有 `write`。
// 本测试盯的是"这条协议**真的执行**了"，而不只是写在 SKILL.md 里 —— 因此分两层：
//   ① **判定矩阵**（纯函数 + 假 exec/假 deps）：该拦的拦、该放的放，且**放行的每一种理由都要有据**；
//   ② **接线与单源**（源码级）：门禁真的挂在 `tools/pre-execute` 上、真的复用 `roleOfAgent`
//      （不自己再写一份角色解析）、且**所有权表只有一份**（`lib/artifact-ownership.js`）。
//
// 为什么放行条件要写成测试：门禁最容易的失败方式不是"拦错"，而是**在最需要它的时候静默失效**
// （角色认不出、存在性查不到、自身抛错 —— 任一处处理成"拦"就会打死正常流程，处理成"悄悄放行"
// 则等于没门禁）。所以每一条 fail-open 都必须**显式**写下来并有断言守着。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OWNERSHIP_MOD = join(here, 'lib', 'artifact-ownership.js');

const {
  ARTIFACT_OWNERS, KNOWN_ROLES, ownersOf, ownerViolation, normalizeOwnerRole, createOwnershipGate,
} = await import(OWNERSHIP_MOD);

/** 造一个只关心"判定"的最小 env（deps 全可注入 ⇒ 零宿主依赖）。 */
function gateWith(opts = {}) {
  return createOwnershipGate({
    cwdFor: () => '/w',
    teamRootFor: () => '/w/team',
    statusFor: async () => opts.status || 'running',
    roleFor: async () => opts.role,
    existsFor: async () => opts.exists,
    onEvent: opts.onEvent || (() => {}),
  });
}
const ALLOW = { kind: 'allow' };
const writeExec = (p) => ({ name: 'write', arguments: { file_path: p } });
const accept = async () => ALLOW;

test('① 所有权表：单一负责人 / 多负责人 / 运行时专属 / 不在表里=不限制', async (t) => {
  assert.deepEqual([...ownersOf('SPEC.md')], ['pm'], 'SPEC.md 的负责人是 pm（SKILL.md「产出」列）');
  assert.deepEqual([...ownersOf('REVIEW.md')], ['reviewer']);
  assert.deepEqual([...ownersOf('TEST.md')], ['qa']);
  // PLAN.md 在真源里是三段协作（pm 骨架 → architect 设计段 → dba 数据段）⇒ 取宽松
  assert.deepEqual([...ownersOf('PLAN.md')].sort(), ['architect', 'dba', 'pm'],
    'PLAN.md 必须列全部三个真源负责人（取宽松口径，宁可漏拦不可误伤）');
  // 运行时专属：空数组 = 角色一律不得覆写
  assert.deepEqual([...ownersOf('STATE.json')], [], 'STATE.json 唯一写者是运行时 ⇒ owners 为空数组');
  assert.deepEqual([...ownersOf('ROSTER.json')], [], 'ROSTER.json 由 /team 命令（宿主）维护');
  // 不列入 = 不限制（lead 口述 + 指派成员落盘的那几份）
  for (const f of ['TASK.md', '任务看板.md', 'SUMMARY.md', 'RUN.log.md', 'RETRO.md']) {
    assert.equal(ownersOf(f), null, `${f} 在真源里是"指派成员落盘"⇒ 必须不限制（ownersOf 返回 null）`);
  }
  assert.equal(ownersOf('随便什么.md'), null, '表里没有的文件名 ⇒ 不限制');
  t.diagnostic(`表内工件 ${Object.keys(ARTIFACT_OWNERS).length} 项；已知角色 ${KNOWN_ROLES.length} 个`);
});

test('② 角色归一：带后缀归到基名；认不出的角色归一成空串（fail-open 的前提）', async () => {
  assert.equal(normalizeOwnerRole('frontend-F4'), 'frontend', 'frontend-F4 应归一到 frontend');
  assert.equal(normalizeOwnerRole('reviewer-R2'), 'reviewer');
  assert.equal(normalizeOwnerRole('qa'), 'qa', '标准角色原样返回');
  assert.equal(normalizeOwnerRole('竞品调研'), '', '动态补位/认不出的角色 ⇒ 空串（调用方据此放行，不臆造权限）');
  assert.equal(normalizeOwnerRole(''), '');
  assert.equal(normalizeOwnerRole(undefined), '');
  // backend/frontend **不拥有任何工件**，但它们是**认得出来的角色** —— 必须能被识别并拦下
  // （反例：若把"已知角色"从所有权表反推，它们会被当成"认不出"而放行 ⇒ 冒烟测试抓过这个 bug）
  assert.equal(normalizeOwnerRole('backend'), 'backend', 'backend 虽无工件，仍必须认得出来');
});

test('③ 判定矩阵：创建放行 / 覆写才拦 / 认不出放行 / 终态放行 / 只管 write·edit', async () => {
  const deny = (inp) => ownerViolation(inp);
  // 该拦的
  assert.ok(deny({ role: 'backend', base: 'SPEC.md', exists: true }), 'backend 覆写 SPEC.md ⇒ 拦');
  assert.ok(deny({ role: 'qa', base: 'REVIEW.md', exists: true }), 'qa 覆写 REVIEW.md ⇒ 拦');
  assert.ok(deny({ role: 'backend', base: 'STATE.json', exists: true }), '角色覆写运行时专属 STATE.json ⇒ 拦');
  assert.ok(deny({ role: 'pm', base: 'STATE.json', exists: true }), '连 pm 也不能写 STATE.json（运行时唯一写者）');
  // 该放的（每条都是"不能误伤"的真实场景）
  assert.equal(deny({ role: 'pm', base: 'SPEC.md', exists: true }), null, '负责人覆写自己的工件 ⇒ 放行');
  assert.equal(deny({ role: 'dba', base: 'PLAN.md', exists: true }), null, 'dba 是 PLAN.md 负责人之一');
  assert.equal(deny({ role: 'backend', base: 'SPEC.md', exists: false }), null,
    '**创建放行** —— SKILL.md §3 要求首个成员一次性落 13 份骨架，拦创建会直接打死建 run');
  assert.equal(deny({ role: '', base: 'SPEC.md', exists: true }), null, '角色认不出 ⇒ 放行（fail-open）');
  assert.equal(deny({ role: 'backend', base: 'SUMMARY.md', exists: true }), null, '未列入表的工件 ⇒ 不限制');
  assert.equal(deny({ role: 'backend', base: '子目录/x.md', exists: true }), null, '表里没有的名字 ⇒ 不限制');
});

test('④ 门禁决策：deny / allow 的完整路径（含下游优先与自身异常兜底）', async () => {
  const P = '/w/team/r1/SPEC.md';
  assert.equal((await gateWith({ role: 'backend', exists: true })(writeExec(P), accept)).kind, 'deny',
    '非负责人覆写已存在工件 ⇒ deny（宿主在 dispatch 前短路 ⇒ 写盘不会发生）');
  const denied = await gateWith({ role: 'backend', exists: true })(writeExec(P), accept);
  assert.match(denied.reason, /R1 工件归属/, 'deny 的理由必须点名 R1（模型据此改正，而不是困惑）');
  assert.match(denied.reason, /SPEC\.md/, '理由里要点名是哪个文件');
  assert.equal((await gateWith({ role: 'pm', exists: true })(writeExec(P), accept)).kind, 'allow', '负责人 ⇒ allow');
  assert.equal((await gateWith({ role: 'backend', exists: false })(writeExec(P), accept)).kind, 'allow', '创建 ⇒ allow');
  assert.equal((await gateWith({ role: 'backend', exists: true, status: 'complete' })(writeExec(P), accept)).kind, 'allow',
    '终态 run ⇒ allow（与 post-execute 拦截器同一条纪律：冻结的历史工件不在写侧拦）');

  // 作用域：只认 write/edit 的 <teamRoot>/<runId>/<文件名> 恰好两段
  assert.equal((await gateWith({ role: 'backend', exists: true })({ name: 'bash', arguments: { command: 'cat > SPEC.md' } }, accept)).kind, 'allow',
    'bash ⇒ 放行（**诚实边界**：门禁只覆盖 write/edit 通道，见文件头）');
  assert.equal((await gateWith({ role: 'backend', exists: true })(writeExec('/w/team/r1/sub/SPEC.md'), accept)).kind, 'allow',
    '更深路径（run 目录的子目录）⇒ 放行（与 post-execute 的 2 段判据一致，避免误伤同名文件）');
  assert.equal((await gateWith({ role: 'backend', exists: true })(writeExec('/w/src/a.js'), accept)).kind, 'allow',
    'run 目录之外（正常代码改动）⇒ 放行');
  assert.equal((await gateWith({ role: 'backend', exists: true })({ name: 'read', arguments: { file_path: P } }, accept)).kind, 'allow',
    '非写工具 ⇒ 放行');

  // 降级：存在性查不到 ⇒ 放行 **且留痕**（不能把"查不到"当成"不存在"）
  const events = [];
  const degraded = await createOwnershipGate({
    cwdFor: () => '/w', teamRootFor: () => '/w/team', statusFor: async () => 'running',
    roleFor: async () => 'backend', existsFor: async () => undefined, onEvent: (t) => events.push(t),
  })(writeExec(P), accept);
  assert.equal(degraded.kind, 'allow', '存在性查不到 ⇒ 放行');
  assert.ok(events.includes('ownership-gate-degraded'), '降级必须留痕（否则"没报错"会被误读成"检查过了"）');

  // 角色认不出 ⇒ 放行 + 留痕
  const ev2 = [];
  const unknown = await createOwnershipGate({
    cwdFor: () => '/w', teamRootFor: () => '/w/team', statusFor: async () => 'running',
    roleFor: async () => '某个临时角色', existsFor: async () => true, onEvent: (t) => ev2.push(t),
  })(writeExec(P), accept);
  assert.equal(unknown.kind, 'allow', '认不出的角色 ⇒ 放行');
  assert.ok(ev2.includes('ownership-gate-degraded'), '认不出角色也要留痕');

  // 下游已 deny ⇒ 不覆盖它的理由（宿主 waterfall 的"最严格优先"）
  const d = await gateWith({ role: 'backend', exists: true })(writeExec(P), async () => ({ kind: 'deny', reason: '下游理由' }));
  assert.equal(d.kind, 'deny');
  assert.equal(d.reason, '下游理由', '下游已经拦了 ⇒ 不得用自己的理由覆盖');

  // 门禁自身抛错 ⇒ 放行（真实事故教训：post-execute 签名写错曾让**全工具瘫痪**）
  const boom = await createOwnershipGate({ cwdFor: () => { throw new Error('boom'); } })(writeExec(P), accept);
  assert.equal(boom.kind, 'allow', '门禁抛错必须降级为放行 —— 绝不允许成为工具调用的故障源');
  // next 缺失/非函数（签名被改坏）⇒ **不得抛错**；规则该生效仍生效
  //（"next 没了"不该让门禁失效 —— 那正是"最需要它时静默失效"，但绝不允许抛错把工具打红）
  let noNext;
  try { noNext = await gateWith({ role: 'backend', exists: true })(writeExec(P), undefined); }
  catch (e) { assert.fail('next 非函数时不得抛错：' + String(e && e.message)); }
  assert.ok(noNext && (noNext.kind === 'allow' || noNext.kind === 'deny'),
    'next 缺失时仍须返回合法决策（allow/deny）');
  assert.equal(noNext.kind, 'deny', 'next 缺失不影响规则判定（此例仍应 deny）');
});

test('⑤ 接线（源码级）：门禁挂在 pre-execute；复用 roleOfAgent；所有权表只有一份', async (t) => {
  const cmd = await readFile(join(here, 'lib', 'command.js'), 'utf8');
  assert.match(cmd, /ctx\.on\('tools\/pre-execute', ownershipGate\)/,
    'command.js 必须把门禁注册到 `tools/pre-execute`（**写盘之前**才拦得住；post 只能事后顶回）');
  assert.match(cmd, /createOwnershipGate\(\{/, 'command.js 必须真的构造门禁（只 import 不接线 = 没门禁）');
  assert.match(cmd, /roleFor: \(exec, runId\) => roleOfAgent\(ctx, exec, runId\)/,
    '门禁的角色解析必须复用 `roleOfAgent`（与并发写留痕同一份）');
  assert.match(cmd, /async function roleOfAgent\(/, '`roleOfAgent` 必须存在（共享解析的落点）');
  assert.match(cmd, /async function pathExistsFor\(/, '`pathExistsFor` 必须存在（三态存在性判据）');
  // 2026-09-15：该 import 现在**一并**引入 ARTIFACT_OWNERS（R1 绕过检测要"已知工件名"集合）。
  // 断言因此从"精确整行"放宽为"仍从 artifact-ownership.js 具名导入 createOwnershipGate" ——
  // 要求不减：仍是同一真源、仍必须具名导入（不许改从别处来）。
  assert.match(cmd, /import \{[^}]*\bcreateOwnershipGate\b[^}]*\} from '\.\/artifact-ownership\.js'/,
    '必须从 artifact-ownership.js 导入门禁（单一真源）');
  // whoFor 也必须走共享解析（两处各写一份 ⇒ 口径迟早漂移）
  assert.match(cmd, /const role = await roleOfAgent\(ctx, exec, target\.runId\)/,
    'whoFor（并发写留痕）也必须复用 roleOfAgent');

  // **单一真源**：所有权表只允许出现在 lib/artifact-ownership.js
  for (const f of ['lib/command.js', 'lib/interception.js', 'client.js']) {
    const src = f === 'lib/command.js' ? cmd : await readFile(join(here, f), 'utf8');
    assert.ok(!src.includes('REVIEW-SPEC.md'), `${f} 里出现了所有权表的内容 ⇒ 有人复制了第二份真源（真源只在 lib/artifact-ownership.js）`);
  }
  t.diagnostic('接线断言 6 条 + 单源断言 3 条');
});
