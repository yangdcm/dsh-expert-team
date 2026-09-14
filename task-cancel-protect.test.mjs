// 测试：依赖保护（O12 · 取消有下游依赖的任务会被拒）
//
// 缺口：/team task <id> cancelled 可以**无条件**取消任何任务 —— 哪怕它正在被做、
// 哪怕有下游任务依赖它。取消后下游任务的 dependsOn 就断了（图校验会报 missing-dependency，
// 但那是**事后**的 —— 取消动作本身没有任何保护）。
//
// 修法：`applyTaskStatus` 在标 cancelled 前**先检查下游**：
//   · 有下游依赖它 → **拒写**，并如实说"谁依赖它"（不静默断链）；
//   · 没有下游 → 正常取消。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M58。
// 运行：node task-cancel-protect.test.mjs

import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { applyTaskStatus } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# 依赖保护（取消有下游的任务会被拒）\n');

function mkRun(tasks) {
  const dir = mkdtempSync(join(tmpdir(), 'dep-protect-'));
  writeFileSync(join(dir, 'TASKS.json'), JSON.stringify({ revision: 1, tasks }, null, 2) + '\n');
  writeFileSync(join(dir, 'RUN.log.md'), '');
  return dir;
}
const readTasks = (dir) => JSON.parse(readFileSync(join(dir, 'TASKS.json'), 'utf8')).tasks;

console.log('① 取消有下游依赖的任务 → 被拒，任务保持原状');
{
  const dir = mkRun([
    { id: 'be-1', status: 'in_progress', owner: 'backend', dependsOn: [] },
    { id: 'fe-1', status: 'pending', owner: 'frontend', dependsOn: ['be-1'] },
  ]);
  const r = await applyTaskStatus(dir, 'be-1', 'cancelled', '');
  check(r.ok === false, '取消被拒', JSON.stringify(r && r.ok));
  check(/依赖它/.test(r.text), '提示里点名谁依赖它', r.text.slice(0, 80));
  check(/fe-1/.test(r.text), '点名具体下游任务', '');
  check(readTasks(dir).find((t) => t.id === 'be-1').status === 'in_progress', 'TASKS 未被改（不写盘）', '');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n② 取消没有下游的任务 → 正常执行');
{
  const dir = mkRun([
    { id: 'be-1', status: 'in_progress', owner: 'backend', dependsOn: [] },
    { id: 'doc-1', status: 'pending', owner: 'docs', dependsOn: [] },
  ]);
  const r = await applyTaskStatus(dir, 'doc-1', 'cancelled', '');
  check(r.ok === true, '取消成功', JSON.stringify(r && r.ok));
  check(readTasks(dir).find((t) => t.id === 'doc-1').status === 'cancelled', '状态已写', '');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n③ 取消已完成/未开始的任务 → 不拦（取消 pending/done 不危险）');
{
  const dir = mkRun([
    { id: 'be-1', status: 'completed', owner: 'backend', dependsOn: [] },
    { id: 'fe-1', status: 'pending', owner: 'frontend', dependsOn: ['be-1'] },
  ]);
  const r = await applyTaskStatus(dir, 'be-1', 'cancelled', '');
  check(r.ok === true, '已完成任务的取消不拦（它已经不是依赖问题的来源）', JSON.stringify(r && r.ok));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n④ 部分匹配 id 也受保护（`be-1` 和 `be-1-rework`）');
{
  const dir = mkRun([
    { id: 'be-1', status: 'in_progress', owner: 'backend', dependsOn: [] },
    { id: 'be-1-rework', status: 'pending', owner: 'backend', dependsOn: [] },
    { id: 'fe-1', status: 'pending', owner: 'frontend', dependsOn: ['be-1'] },
  ]);
  // 取消 be-1 → fe-1 依赖它 → 应被拒
  const r = await applyTaskStatus(dir, 'be-1', 'cancelled', '');
  check(r.ok === false, '取消 be-1 被拒（fe-1 依赖它）', '');
  // 取消 be-1-rework → 没人依赖它 → 应成功
  const r2 = await applyTaskStatus(dir, 'be-1-rework', 'cancelled', '');
  check(r2.ok === true, '取消 be-1-rework 成功（没人依赖它）', '');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n⑤ 其它状态变更不受影响（不拦）');
{
  const dir = mkRun([
    { id: 'be-1', status: 'pending', owner: 'backend', dependsOn: [] },
    { id: 'fe-1', status: 'pending', owner: 'frontend', dependsOn: ['be-1'] },
  ]);
  // 标 in_progress → 不拦
  const r = await applyTaskStatus(dir, 'be-1', 'in_progress', '');
  check(r.ok === true, '标 in_progress 不拦', '');
  // 标 completed → 不拦
  const r2 = await applyTaskStatus(dir, 'be-1', 'completed', '');
  check(r2.ok === true, '标 completed 不拦', '');
  // failed 不拦（失败是事实，不该被"保护"拦住）
  const dir2 = mkRun([
    { id: 'be-1', status: 'in_progress', owner: 'backend', dependsOn: [] },
    { id: 'fe-1', status: 'pending', owner: 'frontend', dependsOn: ['be-1'] },
  ]);
  const r3 = await applyTaskStatus(dir2, 'be-1', 'failed', '');
  check(r3.ok === true, '标 failed 不拦（失败是事实）', '');
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
}

console.log('\n⑥ 健壮性：缺 TASKS.json / 非 JSON / 任务不存在');
{
  const dir = mkdtempSync(join(tmpdir(), 'dep-protect-e-'));
  const r = await applyTaskStatus(dir, 'x', 'cancelled', '');
  check(r.ok === false, '缺文件 → 不抛', JSON.stringify(r && r.ok));
  rmSync(dir, { recursive: true, force: true });
  const dir2 = mkRun([{ id: 'a', status: 'pending', owner: 'x' }]);
  const r2 = await applyTaskStatus(dir2, 'nonexistent', 'cancelled', '');
  check(r2.ok === false && /未找到/.test(r2.text), '任务不存在 → 如实报错', r2.text.slice(0, 40));
  rmSync(dir2, { recursive: true, force: true });
}

console.log('\n⑦ 接线检查：保护逻辑在 applyTaskStatus 里（**唯一**的状态变更入口）');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'command.js'), 'utf8');
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check(/if \(status === 'cancelled'/.test(codeLines), '只对 cancelled 加保护（其它状态不拦）', '');
  check(/dependents\.length/.test(codeLines), '检查下游依赖', '');
  check(/先取消\/改依赖/.test(codeLines), '提示用户怎么解（先取消下游或改依赖）', '');
  // 不拦 failed / 其它状态
  check(!/if \(status === 'failed'\)[\s\S]{0,200}dependents/.test(codeLines), 'failed 不加保护（失败是事实，不该被拦）', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 依赖保护测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 依赖保护测试通过（取消有下游的被拒、无下游的正常、其它状态不拦、部分匹配受保护）');
