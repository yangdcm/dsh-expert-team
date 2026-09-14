// 测试：writeScopes 事前重叠告警（O9）
//
// 背景：现在只有**完成时**按 changedPaths vs inScope 做"越界"审计 —— 那是**事后**才发现
// "两个人改了同一个文件"。本功能在**派工前**做预防：两个任务的 inScope glob 若有重叠，
// 提前在 /team check 里报出来，让用户在派工前调整。
//
// 设计口径（刻意保守）：
//   · 只比较 glob 的**字面前缀**（去掉 `*` 之后的部分）；
//   · 两个字面前缀互为前缀 ⇒ "可能重叠"；
//   · 报告为 **warning**（不阻断）：重叠有时是有意的，我们只如实报出来让人判断。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M57。
// 运行：node scope-overlap.test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { scopeOverlapWarnings } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const T = (id, inScope) => ({ id, inScope });

console.log('# writeScopes 事前重叠告警（O9）\n');

console.log('① 无重叠 → 0 条');
{
  check(scopeOverlapWarnings([T('a', ['src/a/**']), T('b', ['src/b/**'])]).length === 0, '不同目录 → 0 条', '');
  check(scopeOverlapWarnings([]).length === 0, '空任务列表 → 0 条', '');
  check(scopeOverlapWarnings(null).length === 0, 'null → 0 条（不抛）', '');
}

console.log('\n② 有重叠 → 报告且不重复');
{
  const r = scopeOverlapWarnings([T('a', ['src/api/**']), T('b', ['src/api/handlers/*'])]);
  check(r.length === 1, '前缀包含 → 1 条', JSON.stringify(r));
  check(r[0].a === 'a' && r[0].b === 'b', '报告哪两个任务', JSON.stringify({ a: r[0].a, b: r[0].b }));
  check(/inScope 前缀重叠/.test(r[0].reason), '报告里说明原因', r[0].reason.slice(0, 50));

  // 多 scope 重叠 → 同一对只报一次
  const r2 = scopeOverlapWarnings([T('a', ['src/api/**', 'src/lib/**']), T('b', ['src/api/x.js', 'src/lib/y.js'])]);
  check(r2.length === 1, '多 scope 重叠 → 同一对只报一次', String(r2.length));

  // 三任务两两重叠 → 3 条
  const r3 = scopeOverlapWarnings([T('a', ['src/**']), T('b', ['src/x/**']), T('c', ['src/x/y/**'])]);
  check(r3.length === 3, '三任务两两重叠 → 3 条', String(r3.length));
}

console.log('\n③ 缺 inScope 的任务不参与比较（不臆造）');
{
  check(scopeOverlapWarnings([T('a', ['src/**']), T('b', [])]).length === 0, '空 inScope → 不比', '');
  check(scopeOverlapWarnings([T('a', ['src/**']), T('b', null)]).length === 0, 'null inScope → 不比', '');
  check(scopeOverlapWarnings([{ id: 'a', inScope: ['src/**'] }]).length === 0, '只有一个任务 → 不比', '');
}

console.log('\n④ 接线检查：/team check 与 plan/approve 都报了重叠');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'command.js'), 'utf8');
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check(/for \(const w of scopeOverlapWarnings\(arr\)\) warnings\.push/.test(codeLines), '/team check 把重叠写进 warnings（**不是** violations —— 是提示，不阻断）', '');
  check(/scopeOverlapWarnings\(mergedTasks\)/.test(codeLines), 'plan/approve 把重叠写进 RUN.log', '');
  check(/plan:scope-overlap/.test(codeLines), 'RUN.log 有可审计的标记', '');
  // 重叠是 warning 不是 violation：确认它不会挡住 plan 的批准
  check(!/violations\.push\(.*scopeOverlapWarnings/.test(codeLines), '重叠**不进** violations（不阻断批准）', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 写域重叠测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 写域重叠测试通过（事前预防、只报不阻断、不重复、缺 inScope 不臆造）');
