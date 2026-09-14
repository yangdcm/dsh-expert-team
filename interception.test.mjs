// 测试：B2-1 写侧边界拦截器（`lib/interception.js`）—— 台账契约 + 规格边界
//
// 为什么需要它（E 类假绿的防守）：这两条规则原先只活在 `SKILL.md` / `ROLES.md` 的**散文**里，
// 代码里零强制（`grep "边界与禁止项" lib/ scripts/ client.js` = 0 命中）。散文规则的失败是
// **静默的** —— 模型没照做，没有任何信号。本测试钉住"违规必须变成可见的 block"。
//
// 判定边界（有意为之，防止把合法中间态判死）：
//   · TASKS.json 只拦**永不合法**的 DAG 不变量：id 重复 / 循环依赖 / 自依赖 / 缺 id；
//     `missing-dependency` **不拦**（可能是"下一条 edit 就补上"的中间态）——与
//     `lib/command.js:68` 的 L1-4′ 仲裁（schema 告警只上报不阻断）保持同一口径。
//   · SPEC.md 只在该 run 已进入 spec-review 及之后才要求边界已填；clarify/design 期间放行。
//   · 读不回文件（宿主虚拟路径）⇒ **降级放行 + 留痕**，绝不让门禁自身变成故障源。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M91**（让台账硬规则恒不触发）。
// 运行：node interception.test.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBoundaryInterceptor,
  runScopedTarget,
  specBoundaryState,
  targetOf,
  tasksArrayOf,
} from './lib/interception.js';

const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const CWD = '/tmp/ws';
const ROOT = join(CWD, 'team');

/** 复刻 `validateTaskGraph` 的判定（测试里用最小实现注入，避免把 command.js 整个拉进来）。 */
function fakeValidateTaskGraph(tasks) {
  const errors = [];
  const ids = tasks.map((t) => String(t.id || '').trim());
  if (ids.some((i) => !i)) errors.push({ code: 'missing-id', detail: '存在没有 id 的任务' });
  const seen = new Map();
  for (const i of ids) if (i) seen.set(i, (seen.get(i) || 0) + 1);
  for (const [i, n] of seen) if (n > 1) errors.push({ code: 'duplicate-id', detail: `任务 id 重复 ${n} 次：${i}` });
  const idSet = new Set(seen.keys());
  for (const t of tasks) {
    const id = String(t.id || '').trim();
    for (const d of (Array.isArray(t.dependsOn) ? t.dependsOn : [])) {
      const dep = String(d).trim();
      if (dep === id) errors.push({ code: 'self-dependency', detail: `[${id}] 依赖自身` });
      else if (!idSet.has(dep)) errors.push({ code: 'missing-dependency', detail: `[${id}] 依赖不存在的任务 [${dep}]` });
    }
  }
  // 极简环检测：A→B→A
  for (const t of tasks) {
    const id = String(t.id || '').trim();
    for (const d of (Array.isArray(t.dependsOn) ? t.dependsOn : [])) {
      const back = tasks.find((x) => String(x.id).trim() === String(d).trim());
      if (back && (Array.isArray(back.dependsOn) ? back.dependsOn : []).map(String).includes(id)) {
        const key = [id, String(d)].sort().join('|');
        if (!errors.some((e) => e.code === 'cycle' && e.detail.includes(key.split('|')[0]))) {
          errors.push({ code: 'cycle', detail: `检测到循环依赖：${id} → ${d} → ${id}` });
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 造一个拦截器：files 是「绝对路径 → 内容」的映射（模拟落盘后的磁盘状态）。 */
function makeInterceptor({ files = {}, phase = 'implement', status = 'running', events = [], statusFor } = {}) {
  const accept = async () => ({ kind: 'accept' });
  const raw = createBoundaryInterceptor({
    readText: async (abs) => (abs in files ? files[abs] : null),
    validateTaskGraph: fakeValidateTaskGraph,
    cwdFor: () => CWD,
    teamRootFor: (cwd) => join(cwd, 'team'),
    phaseFor: async () => phase,
    // 默认给一个"非终态"的 run —— 与真实情况一致，也让"缺省语义不变"这条断言有意义。
    statusFor: statusFor || (async () => status),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  // 宿主签名是 (exec, result, next)：测试必须用**同一形状**调用，否则测试会跟着实现一起把签名写错
  // （2026-09-12 真实事故：测试与实现同错 ⇒ 48 套全绿，而真实会话里每次工具调用都失败）。
  const it = (exec, next) => raw(exec, {}, next);
  return { it, accept, raw };
}

const writeExec = (app) => ({ name: 'write', arguments: { file_path: app } });

const TASKS = (tasks) => JSON.stringify({ rounds: { review: 0, test: 0, repair: 0 }, tasks }, null, 2);
const SPEC_HEADING_ONLY = [
  '# SPEC', '', '## 边界与禁止项（强制 · 沉默 ≠ 允许）', '',
  '| 边界族 | 规则（禁止什么） | 期望拒绝 | 验收方式 |', '|---|---|---|---|',
  '| 自反关系 | 不能回复自己 | | |', '| 越权 | 不能改他人资源 | | |', '',
].join('\n');
const SPEC_FILLED = SPEC_HEADING_ONLY.replace('| 自反关系 | 不能回复自己 | | |', '| 自反关系 | 不能回复自己 | 400 SELF_REPLY | 评论自己回复自己应被拒 |');
const SPEC_NO_HEADING = ['# SPEC', '', '## 目标', '做一个评论功能', ''].join('\n');
// 2026-09-12 实测反例：标题里**提到**这个章节名（"故意不写……章节"），旧实现用 includes() 会判成"有章节"
const SPEC_MENTION_ONLY = ['# SPEC（探针：故意不写「边界与禁止项」章节）', '', '## 目标', 'x', ''].join('\n');

// ── 1. 纯函数 ──
console.log('① targetOf / runScopedTarget');
check(targetOf(writeExec('a/b/TASKS.json')) === 'a/b/TASKS.json', 'write 的 file_path 被取出');
check(targetOf({ name: 'edit', arguments: { file_path: 'x' } }) === 'x', 'edit 的 file_path 被取出');
check(targetOf({ name: 'read', arguments: { file_path: 'x' } }) === null, 'read 不是写入类 ⇒ 不拦');
check(targetOf({ name: 'write', arguments: {} }) === null, '缺 file_path ⇒ 不拦');
check(targetOf(null) === null, 'exec 为空 ⇒ 不拦');

check(runScopedTarget(join(ROOT, 'r1', 'TASKS.json'), ROOT)?.kind === 'tasks', 'run 根下的 TASKS.json 命中');
check(runScopedTarget(join(ROOT, 'r1', 'SPEC.md'), ROOT)?.kind === 'spec', 'run 根下的 SPEC.md 命中');
check(runScopedTarget(join(ROOT, 'r1', 'sub', 'TASKS.json'), ROOT) === null, '更深一层不拦（只认 run 根的直接子文件）');
// 2026-09-13 重钉（设计稿 §十二 第 3 步）：其它工件从「看不见」改为「看得见、**但不拦**」——
// 并发写留痕要观察**所有** run 工件（实测那次事故发生在 `CONTRACT.md`，不是受门禁保护的这两份）。
// 断言没有放宽：仍然是不拦，只是它现在会被识别成 `other`，而 `violationsFor` 对非 tasks/spec 一律返回空。
check(runScopedTarget(join(ROOT, 'r1', 'ROSTER.json'), ROOT)?.kind === 'other', '其它工件被识别为 `other`（看得见）');
check(runScopedTarget(join(ROOT, 'r1', 'CONTRACT.md'), ROOT)?.kind === 'other', '`CONTRACT.md` 也看得见（T29 那次事故就发生在它上面）');
check(runScopedTarget(join(ROOT, 'r1', 'sub', 'TASKS.json'), ROOT) === null, '更深一层仍然不看（只认 run 根的直接子文件）');
check(runScopedTarget(join(CWD, 'src', 'TASKS.json'), ROOT) === null, 'team/ 之外不拦');
check(runScopedTarget(join(ROOT, 'TASKS.json'), ROOT) === null, 'team/ 直接下的 TASKS.json（无 run 层）不拦');

console.log('② specBoundaryState');
check(specBoundaryState(SPEC_NO_HEADING).heading === false, '没有边界章节 ⇒ heading=false');
check(specBoundaryState(SPEC_HEADING_ONLY).heading === true, '有边界章节 ⇒ heading=true');
check(specBoundaryState(SPEC_HEADING_ONLY).filled === false, '模板原样（期望拒绝列全空）⇒ filled=false');
check(specBoundaryState(SPEC_HEADING_ONLY).totalRows === 2, '识别出 2 行数据行', `totalRows=${specBoundaryState(SPEC_HEADING_ONLY).totalRows}`);
check(specBoundaryState(SPEC_FILLED).filled === true, '有一行填了期望拒绝 ⇒ filled=true');
check(specBoundaryState(SPEC_FILLED).filledRows === 1, 'filledRows=1');
// 提及 ≠ 定义：判定必须锚在**结构位置**（标题以章节名开头），不能锚在"出现过"
check(specBoundaryState(SPEC_MENTION_ONLY).heading === false, '标题里**提到**「边界与禁止项」不算定义（提及 ≠ 定义）');
check(specBoundaryState('## 边界与禁止项说明\n').heading === false, '`边界与禁止项说明` 这种近似标题不算（必须紧跟括号/冒号或结束）');
check(specBoundaryState('## 边界与禁止项（强制 · 沉默 ≠ 允许）\n').heading === true, '模板形态的章节标题（带括号后缀）仍算定义');
check(specBoundaryState('### 边界与禁止项：\n').heading === true, '带冒号后缀也算定义');

// ── 2. 签名契约（错一位 = 全工具瘫痪）──
console.log('②′ 监听器签名契约');
{
  const raw = createBoundaryInterceptor({ readText: async () => null, validateTaskGraph: fakeValidateTaskGraph, cwdFor: () => CWD });
  check(raw.length === 3, '声明为 (exec, result, next) 三个参数 —— 与宿主 tools/post-execute 一致', `length=${raw.length}`);
  const r = await raw(writeExec('src/x.js'), {}); // 故意不传 next
  check(r && r.kind === 'accept', 'next 不是函数时降级为 accept（绝不把工具调用打红）');

  // 参数个数无论怎么变，都**不许抛错**：这是 2026-09-12 全工具瘫痪事故的直接防线。
  // 三种"宿主改了签名"的可能形态各试一遍（少传 / 多传 / next 位是对象）。
  const shapes = [
    ['只传 exec', [writeExec('team/r1/TASKS.json')]],
    ['exec + 非函数 next', [writeExec('team/r1/TASKS.json'), {}]],
    ['exec + result + 非函数 next', [writeExec('team/r1/TASKS.json'), {}, 'not-a-function']],
    ['多传第 4 个参数', [writeExec('team/r1/TASKS.json'), {}, async () => ({ kind: 'accept' }), 'extra']],
  ];
  let threw = null;
  for (const [name, args] of shapes) {
    try {
      const out = await raw(...args);
      if (!out || typeof out.kind !== 'string') threw = `${name}: 返回形状不对 ${JSON.stringify(out)}`;
    } catch (e) { threw = `${name}: 抛错 ${e && e.message}`; }
  }
  check(threw === null, '任何参数个数形态都不抛错（不然会把宿主的所有工具调用打红）', threw || `${shapes.length} 种形态`);
}

// ── 3. 拦截器 ──
console.log('③ 非目标路径 / 无 cwd ⇒ 原样放行');
{
  const { it, accept } = makeInterceptor();
  const r1 = await it(writeExec('src/app.js'), accept);
  check(r1.kind === 'accept', '普通源码路径不干涉');
  const r2 = await it({ name: 'read', arguments: { file_path: join(ROOT, 'r1', 'TASKS.json') } }, accept);
  check(r2.kind === 'accept', 'read 不干涉');
  const noCwd = createBoundaryInterceptor({
    readText: async () => 'x', validateTaskGraph: fakeValidateTaskGraph, cwdFor: () => null,
  });
  const r3 = await noCwd(writeExec(join(ROOT, 'r1', 'TASKS.json')), {}, accept);
  check(r3.kind === 'accept', '取不到 cwd ⇒ 放行（不猜）');
}

console.log('④ TASKS.json：只拦永不合法的 DAG 不变量');
{
  const p = join(ROOT, 'r1', 'TASKS.json');
  const dup = makeInterceptor({ files: { [p]: TASKS([{ id: 'T-1', status: 'pending' }, { id: 'T-1', status: 'pending' }]) } });
  const rDup = await dup.it(writeExec(p), dup.accept);
  check(rDup.kind === 'block', 'id 重复 ⇒ block');
  check(JSON.stringify(rDup.feedback).includes('任务 id 重复'), 'feedback 指出重复的 id');

  const cyc = makeInterceptor({ files: { [p]: TASKS([{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }]) } });
  const rCyc = await cyc.it(writeExec(p), cyc.accept);
  check(rCyc.kind === 'block', '循环依赖 ⇒ block');

  const self = makeInterceptor({ files: { [p]: TASKS([{ id: 'A', dependsOn: ['A'] }]) } });
  check((await self.it(writeExec(p), self.accept)).kind === 'block', '自依赖 ⇒ block');

  const dangling = makeInterceptor({ files: { [p]: TASKS([{ id: 'A', dependsOn: ['NOPE'] }]) } });
  check((await dangling.it(writeExec(p), dangling.accept)).kind === 'accept', '悬空依赖 ⇒ **不拦**（合法中间态，与 L1-4′ 同口径）');

  const badJson = makeInterceptor({ files: { [p]: '{ not json' } });
  const rBad = await badJson.it(writeExec(p), badJson.accept);
  check(rBad.kind === 'block', '非法 JSON ⇒ block');

  const okTasks = makeInterceptor({ files: { [p]: TASKS([{ id: 'A', status: 'completed' }, { id: 'B', dependsOn: ['A'], status: 'pending' }]) } });
  check((await okTasks.it(writeExec(p), okTasks.accept)).kind === 'accept', '合规台账 ⇒ accept');
}

console.log('⑤ SPEC.md：按阶段要求边界已填');
{
  const p = join(ROOT, 'r1', 'SPEC.md');
  const noHead = makeInterceptor({ files: { [p]: SPEC_NO_HEADING }, phase: 'clarify' });
  const rNo = await noHead.it(writeExec(p), noHead.accept);
  check(rNo.kind === 'block', '缺边界章节 ⇒ block（任何阶段）');
  check(JSON.stringify(rNo.feedback).includes('边界与禁止项'), 'feedback 指明缺的章节名');

  const blankClarify = makeInterceptor({ files: { [p]: SPEC_HEADING_ONLY }, phase: 'clarify' });
  check((await blankClarify.it(writeExec(p), blankClarify.accept)).kind === 'accept', 'clarify 阶段边界空着 ⇒ 放行（先建骨架后填）');

  const blankImpl = makeInterceptor({ files: { [p]: SPEC_HEADING_ONLY }, phase: 'implement' });
  const rImpl = await blankImpl.it(writeExec(p), blankImpl.accept);
  check(rImpl.kind === 'block', 'implement 阶段边界仍空 ⇒ block（头号返工源）');
  check(JSON.stringify(rImpl.feedback).includes('期望拒绝'), 'feedback 说明"没有拒绝码的边界视为未定义"');

  const filled = makeInterceptor({ files: { [p]: SPEC_FILLED }, phase: 'implement' });
  check((await filled.it(writeExec(p), filled.accept)).kind === 'accept', '边界已填 ⇒ accept');
}

console.log('⑤b 已交付/已终止的 run：**放行**（2026-09-13 实测撞到的误报）');
{
  // 实测场景：B 线 11b 搬词表后重锚一份**历史 run**（phase=deliver status=complete）的 SPEC.md
  // 引用，拦截器当场报「缺边界章节」。而 post-execute 的 block **不回滚写入** ⇒ 唯一效果是
  // 让编辑者以为没改成。已终止 run 的工件由 `/team check` 按需报告，不在这里拦。
  const p = join(ROOT, 'r1', 'SPEC.md');
  const events = [];
  const delivered = makeInterceptor({ files: { [p]: SPEC_NO_HEADING }, phase: 'deliver', status: 'complete', events });
  const r = await delivered.it(writeExec(p), delivered.accept);
  check(r.kind === 'accept', '已交付 run（status=complete）改 SPEC ⇒ **放行**', r.kind);
  check(events.some((e) => e.type === 'boundary-gate-skipped-terminal' && e.payload.status === 'complete'), '放行要留痕（否则"没报错"会被读成"检查过了"）');

  for (const st of ['completed', 'done', 'failed', 'cancelled', 'discarded']) {
    const one = makeInterceptor({ files: { [p]: SPEC_NO_HEADING }, phase: 'deliver', status: st });
    check((await one.it(writeExec(p), one.accept)).kind === 'accept', `终态 ${st} 同样放行`);
  }

  // **回归保护**：非终态必须照旧拦 —— 否则这一改就等于把门禁整个关掉。
  const live = makeInterceptor({ files: { [p]: SPEC_NO_HEADING }, phase: 'deliver', status: 'running' });
  check((await live.it(writeExec(p), live.accept)).kind === 'block', '非终态（running）⇒ **照旧 block**（不能顺手把门禁关掉）');
  const tasksPath = join(ROOT, 'r1', 'TASKS.json');
  const live2 = makeInterceptor({ files: { [tasksPath]: TASKS([{ id: 'A', dependsOn: ['A'] }]) }, phase: 'implement', status: 'running' });
  check((await live2.it(writeExec(tasksPath), live2.accept)).kind === 'block', '非终态下的 DAG 不变量照旧 block');

  // 读不出状态 ⇒ 按"非终态"处理（fail-closed，与缺省实现一致）
  const noStatus = createBoundaryInterceptor({
    readText: async (abs) => (abs in { [p]: SPEC_NO_HEADING } ? SPEC_NO_HEADING : null),
    validateTaskGraph: fakeValidateTaskGraph, cwdFor: () => CWD, teamRootFor: (cwd) => join(cwd, 'team'), phaseFor: async () => 'deliver',
    statusFor: async () => { throw new Error('state unreadable'); },
  });
  check((await noStatus(writeExec(p), {}, async () => ({ kind: 'accept' }))).kind === 'accept', 'statusFor 抛错 ⇒ 拦截器自身不把工具调用变红');
  const emptyStatus = makeInterceptor({ files: { [p]: SPEC_NO_HEADING }, phase: 'deliver', status: '' });
  check((await emptyStatus.it(writeExec(p), emptyStatus.accept)).kind === 'block', '状态为空（读不到）⇒ 按非终态处理，照旧拦（fail-closed）');
}

console.log('⑥ 降级与健壮性');
{
  const p = join(ROOT, 'r1', 'TASKS.json');
  const events = [];
  const degraded = makeInterceptor({ files: {}, events });
  const r = await degraded.it(writeExec(p), degraded.accept);
  check(r.kind === 'accept', '读不回文件 ⇒ 放行');
  check(events.some((e) => e.type === 'boundary-gate-degraded'), '降级要留痕（否则"没报错"会被读成"检查过了"）');

  const broken = createBoundaryInterceptor({ readText: () => { throw new Error('boom'); }, validateTaskGraph: fakeValidateTaskGraph, cwdFor: () => CWD });
  check((await broken(writeExec(p), {}, async () => ({ kind: 'accept' }))).kind === 'accept', '拦截器自身抛错 ⇒ 不能把工具调用变红');

  // 工具本身失败时不许插嘴：文件没变成"我以为的样子"，拿旧内容校验只会给出误导理由并掩盖真错因。
  // 实测场景（2026-09-12）：未先 read 就覆盖写被 fs 观察策略拒绝，本拦截器却报成「任务 id 重复」。
  {
    const ev3 = [];
    const dirty = makeInterceptor({ files: { [p]: TASKS([{ id: 'A' }, { id: 'A' }]) }, events: ev3 });
    const rErr = await dirty.raw(writeExec(p), { isError: true }, async () => ({ kind: 'accept' }));
    check(rErr.kind === 'accept', '工具已失败（result.isError）⇒ 不插嘴（不掩盖真错因）');
    check(!ev3.some((e) => e.type === 'boundary-gate-blocked'), '工具已失败时也不记 blocked 留痕（避免误导审计）');
    const rErr2 = await dirty.raw(writeExec(p), { error: { message: 'boom' } }, async () => ({ kind: 'accept' }));
    check(rErr2.kind === 'accept', '工具返回 error 对象时同样不插嘴');
    const rOk = await dirty.raw(writeExec(p), {}, async () => ({ kind: 'accept' }));
    check(rOk.kind === 'block', '对照：工具成功时该拦的仍然要拦（不是把整条规则关掉）');
  }

  const p2 = join(ROOT, 'r1', 'TASKS.json');
  const ev2 = [];
  const blk = makeInterceptor({ files: { [p2]: TASKS([{ id: 'A' }, { id: 'A' }]) }, events: ev2 });
  await blk.it(writeExec(p2), blk.accept);
  check(ev2.some((e) => e.type === 'boundary-gate-blocked'), '阻断要留痕（让"门禁被行使"看得见）');

  // 下游已 block：两份 feedback 都在（最严格合并，顺序无关）
  const merged = await blk.it(writeExec(p2), async () => ({ kind: 'block', feedback: [{ type: 'text', text: '下游理由' }] }));
  const txt = JSON.stringify(merged.feedback);
  check(merged.kind === 'block' && txt.includes('下游理由') && txt.includes('任务 id 重复'), '下游 block + 我方 block ⇒ 两份理由都保留');
}

console.log('⑦ tasksArrayOf');
check(tasksArrayOf({ tasks: [] })?.length === 0, '接受 {tasks:[…]}');
check(tasksArrayOf([])?.length === 0, '接受裸数组');
check(tasksArrayOf({ nope: 1 }) === null, '其它形状 ⇒ null');

if (fail) { console.error(`\n✗ interception：${fail} 项失败`); process.exit(1); }
console.log('\n✓ interception：全部通过');
