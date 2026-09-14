// 测试：存量工件的 schema 违规必须能被 `/team check` 查出来（C4）
//
// 缺陷：`DEFAULT_SCHEMA_GUARDS` 只在**写入那一刻**经 `schema-warn` 事件上报
// （`console.warn` + 活动流）。`/team check` 只读文件、**从不校验 schema** ⇒
// 一份**存量**违规工件（旧 run、或被别的写入路径改脏的文件）永远查不出来。
// 而「画布/面板上少了东西，却没有任何信号说明少了什么」正是本插件最危险的失败模式
// （实证：`STATE.json` 的 `coverage` 曾被写成角色名字符串数组，消费端兜底后**渲染成空行**）。
//
// 修法：复用**同一份** `DEFAULT_SCHEMA_GUARDS` 做只读校验，接进 `/team check` 与面板红条；
// 口径与写入侧一致：**只告警、不阻断**。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M29。
// 运行：node schema-check.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { schemaViolations } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# 存量 schema 校验（/team check 也要查）\n');

console.log('① 实测过的真实脏数据形态：coverage 是角色名字符串数组');
{
  const dirty = { phase: 'deliver', status: 'complete', coverage: ['pm', 'architect', 'researcher'], members: [] };
  const v = schemaViolations(dirty, { tasks: [] });
  check(v.length >= 1, '被查出来（原先只有写入那一刻才知道）', JSON.stringify(v));
  check(v.some((s) => /coverage/.test(s)), '指名 coverage', v[0]);
  check(v.every((s) => /^\[schema (STATE|TASKS)\.json\]/.test(s)), '每条都带来源文件名前缀（用户能定位）', v[0]);
}

console.log('\n② 各类违规都能查出来');
{
  check(schemaViolations({ members: 'not-an-array' }, null).some((s) => /members/.test(s)), 'members 非数组');
  check(schemaViolations({ phase: 42 }, null).some((s) => /phase/.test(s)), 'phase 非字符串');
  check(schemaViolations({ status: [] }, null).some((s) => /status/.test(s)), 'status 非字符串');
  check(schemaViolations({ planDiscarded: 'yes' }, null).some((s) => /planDiscarded/.test(s)), 'planDiscarded 非对象');
  check(schemaViolations(null, { tasks: 'nope' }).some((s) => /tasks 应为数组/.test(s)), 'TASKS.tasks 非数组');
  check(schemaViolations(null, { tasks: [{ title: 'no id' }, {}] }).some((s) => /非空字符串 id/.test(s)), 'task 缺 id');
}

console.log('\n③ 干净数据不得误报（否则红条会变噪音，用户会整体降权）');
{
  const clean = { phase: 'design', status: 'running', coverage: [{ constraint: 'a', tasks: ['T-01'] }], members: ['a1a1a1a1-1111-4111-8111-111111111111:pm'] };
  check(schemaViolations(clean, { tasks: [{ id: 'T-01', title: 'x' }] }).length === 0, '合规工件 → 0 条告警', JSON.stringify(schemaViolations(clean, { tasks: [{ id: 'T-01' }] })));
  // STATE 的字段是"缺席即合规"（老 run 没有某些字段）；TASKS 不是 —— `tasks` 缺席本身就是违规
  check(schemaViolations({}, undefined).length === 0, 'STATE 空对象 + 无 TASKS → 0 条（字段缺席不算违规）');
  check(schemaViolations({}, {}).length === 1, 'TASKS 空对象 → 1 条（缺 tasks 数组，这是真违规）', JSON.stringify(schemaViolations({}, {})));
  check(schemaViolations({ phase: 'design' }, { tasks: [] }).length === 0, '常见最小合规形态 → 0 条');
  check(schemaViolations(undefined, undefined).length === 0, 'undefined → 0 条');
}

console.log('\n④ 健壮性：畸形输入不得抛错（在面板轮询路径上）');
{
  for (const [a, b] of [[null, null], ['str', 'str'], [42, 42], [[], []], [{}, 'not-obj'], ['x', {}]]) {
    let ok = true, msg = '';
    try { ok = Array.isArray(schemaViolations(a, b)) } catch (e) { ok = false; msg = String(e && e.message) }
    check(ok, `schemaViolations(${JSON.stringify(a)}, ${JSON.stringify(b)}) → 数组`, msg);
  }
}

console.log('\n⑤ 接线检查：/team check 与面板都必须调用它');
{
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  const checkAt = src.indexOf('const schemaWarns = schemaViolations(state, tasks);');
  check(checkAt > 0, '/team check 里调用', checkAt > 0 ? 'ok' : '未找到');
  check(/violations = violations\.concat\(schemaWarns\)/.test(src), '结果并入 violations（计入 ❌ 列表）');
  const panelAt = src.indexOf('schemaViolations(rawState, { tasks: taskList(sel.tasks) })');
  check(panelAt > 0, '面板红条也调用');
  check(/rawState = await readJsonSafe\(join\(sel\.workspace/.test(src), '校验的是磁盘上的 STATE.json（不是合并视图 sel —— 同名不同物会假阳性）');
  // 口径一致：只告警不阻断 —— 不得因 schema 违规而 return 错误 / 跳过 run
  const checkBlock = checkAt >= 0 ? src.slice(checkAt, checkAt + 600) : '';
  check(!/return\s*\{\s*kind:\s*'error'/.test(checkBlock), '不得因 schema 违规直接报错中断（只告警）');
  // 复用同一份 guard，不得另写一套。
  // 2026-09-13（B 线第 8 项第一步）：`schemaViolations` 已搬进 `lib/validate.js` ⇒ 这条断言
  // 随之改指**它现在住的地方**，并额外钉住"command.js 里没有第二份实现"（照旧从严，不放宽）。
  const validateSrc = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'lib/validate.js'), 'utf8');
  check(/DEFAULT_SCHEMA_GUARDS\[name\]/.test(validateSrc), '复用写入侧同一份 DEFAULT_SCHEMA_GUARDS（在 validate.js 里）');
  check(/import \{ DEFAULT_SCHEMA_GUARDS \} from '\.\/artifact-writer\.js'/.test(validateSrc), 'guard 是从 artifact-writer.js **import** 的（不是又抄了一份表）');
  check(!/DEFAULT_SCHEMA_GUARDS\[name\]/.test(src), 'command.js 里没有第二份 schema 校验实现');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 存量 schema 校验测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 存量 schema 校验测试通过（脏数据可查、干净数据不误报、口径为只告警）');
