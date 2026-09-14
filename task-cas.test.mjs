// 测试：TASKS.json 的**任务级 CAS**（O2 · 消除"两个写者互相覆盖且无人知晓"）
//
// 缺陷：`must()` 支持 `opts.expectedRevision`，但全仓**没有任何 TASKS.json 调用点传它** ⇒
// 现状只是 read-modify-write：浮层改状态 / lead 直写盘 / settle / migrate / plan approve
// 各自读到 rev N、各自写、**后写覆盖先写且无人知晓**（评审原话："静默丢更新"）。
//
// ⚠️ 关键设计：CAS 重试必须**重放 mutate 函数**（对新鲜内容重新施加改动），
// 而不是把手里那份过期数组再写一遍 —— 后者会把别人的改动碾掉，**比不做 CAS 更糟**。
// 所以 `mutateTasks` 里刻意 `maxAttempts:1`（**关掉载体自身的重试**，因为它会重写同一份
// payload），由这层在陈旧时**重读→重新施加→再写**。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M48。
// 运行：node task-cas.test.mjs

import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { mutateTasks } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'task-cas-'));
// ⚠️ CAS 栅栏靠文件里的 `revision` 字段（`readRevision` 读的是**内容**里的 revision，
// 没有它就是 null ⇒ 栅栏不挂）。种子必须带 revision 才是真实形状（否则本测试在无栅栏下跑）。
const seed = () => writeFileSync(join(dir, 'TASKS.json'), JSON.stringify({ revision: 1, tasks: [{ id: 'T-0', status: 'pending' }] }, null, 2) + '\n');
const readTasks = () => JSON.parse(readFileSync(join(dir, 'TASKS.json'), 'utf8')).tasks;

console.log('# 任务级 CAS（mutateTasks）\n');

console.log('① 串行：常规写入正常（revision 自增）');
{
  seed();
  const r1 = await mutateTasks(dir, (j) => ({ next: { ...j, tasks: [...j.tasks, { id: 'T-A', status: 'pending' }] }, result: 'a' }));
  check(r1.ok && readTasks().some((t) => t.id === 'T-A'), '写进去了', JSON.stringify(r1.attempts));
  const rev1 = readTasks && JSON.parse(readFileSync(join(dir, 'TASKS.json'), 'utf8')).revision;
  const r2 = await mutateTasks(dir, (j) => ({ next: { ...j, tasks: [...j.tasks, { id: 'T-B', status: 'pending' }] }, result: 'b' }));
  const rev2 = JSON.parse(readFileSync(join(dir, 'TASKS.json'), 'utf8')).revision;
  check(r2.ok && rev2 > rev1, 'revision 自增', `${rev1} → ${rev2}`);
}

console.log('\n② 【核心】陈旧重试必须**对新鲜内容重新施加**改动（而不是把旧数组写回去）');
{
  seed();
  // 确定性复现「读与写之间被别人插队」：B 的 mutate 里**同步**把一份竞争性改动写进磁盘
  // （把磁盘 revision 顶到 2）。这模拟的不是时序，而是**数据本身**：B 读时磁盘是 rev1，
  // B 写时磁盘已是 rev2 ⇒ 必然 stale ⇒ CAS 重试 ⇒ 对**新鲜**内容重新施加。
  // （时序版在这台机器上被事件循环的宏/微任务顺序搅乱，不可靠；数据版是确定性的。）
  let bumped = false;
  const r = await mutateTasks(dir, (j) => {
    if (!bumped) {
      bumped = true;
      writeFileSync(join(dir, 'TASKS.json'), JSON.stringify({ revision: 2, tasks: [...j.tasks, { id: 'A', status: 'pending' }] }, null, 2) + '\n');
    }
    return { next: { ...j, tasks: [...j.tasks, { id: 'B', status: 'pending' }] }, result: 'b' };
  });
  check(r.ok === true, '陈旧后重试成功（不抛错、不丢 B）', JSON.stringify({ ok: r.ok, code: r.code }));
  const ids = readTasks().map((t) => t.id);
  check(ids.includes('A') && ids.includes('B'), '竞争写者的 A 与本写的 B **都在**（没互相碾掉）', ids.join(','));
  check(r.attempts >= 2, '确实重试过（重新读、重新施加）', String(r.attempts));
  const rev = JSON.parse(readFileSync(join(dir, 'TASKS.json'), 'utf8')).revision;
  check(Number.isInteger(rev) && rev >= 3, 'revision 连续自增到 3（两个写者的落盘都被记账）', String(rev));
}
console.log('\n③ 陈旧不可恢复：如实报错 TASKS_CAS_CONFLICT，不静默覆盖');
{
  seed();
  // 制造**持续的**并发写：每次 mutate 都顺手把磁盘上的版本顶掉（不经过 writer 的版本记账）
  const marker = { current: 0 };
  const r = await mutateTasks(dir, (j) => {
    marker.current += 1;
    writeFileSync(join(dir, 'TASKS.json'), JSON.stringify({ revision: 999 + marker.current, tasks: j.tasks }, null, 2) + '\n');
    return { next: { ...j, tasks: [...j.tasks, { id: 'X' }] }, result: null };
  });
  check(r.ok === false && r.code === 'TASKS_CAS_CONFLICT', '持续冲突 → 显式 TASKS_CAS_CONFLICT', r.code);
  check(!readTasks().some((t) => t.id === 'X'), '**不会把改动硬塞进去**（不静默丢对方的写）');
  check(r.attempts === 3, '重试次数有上限（默认 3）', String(r.attempts));
  check(/并发改动/.test(r.error), '错误信息说明原因（"有人在同时改"）', r.error.slice(0, 50));
}

console.log('\n④ 边界：缺文件 / 非 JSON / mutate 说"不写"');
{
  const empty = mkdtempSync(join(tmpdir(), 'task-cas-e-'));
  const r1 = await mutateTasks(empty, (j) => ({ next: { ...j, tasks: [] }, result: null }));
  check(r1.ok === false && r1.code === 'NO_TASKS', '缺 TASKS.json → NO_TASKS（不臆造文件）', r1.code);
  writeFileSync(join(empty, 'TASKS.json'), 'not json{');
  const r2 = await mutateTasks(empty, (j) => ({ next: j, result: null }));
  check(r2.ok === false && r2.code === 'BAD_JSON', '非合法 JSON → BAD_JSON', r2.code);
  seed();
  const r3 = await mutateTasks(dir, (j) => ({ next: null, result: 'skip' }));
  check(r3.ok && r3.noop === true && r3.result === 'skip', 'mutate 返回 next:null → 不写盘（幂等）', JSON.stringify({ ok: r3.ok, noop: r3.noop }));
}

console.log('\n⑤ 接线检查：全仓 TASKS.json 写路径**只剩** mutateTasks 一个入口');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const direct = (codeLines.match(/ARTIFACT\.must\(join\((?:dir|t\.dir), 'TASKS\.json'\)/g) || []).length;
  check(direct === 0, `不再有绕过 mutateTasks 的 TASKS.json 直写（当前 ${direct} 处）`, String(direct));
  const calls = (codeLines.match(/mutateTasks\(/g) || []).length - 1; // 减去定义行
  check(calls >= 4, `mutateTasks 被至少 4 个写路径复用（status / migrate / settle / approve），实际 ${calls}`, String(calls));
  check(/expectedRevision: snap\.revision/.test(codeLines) && /maxAttempts: 1/.test(codeLines), 'CAS 栅栏（expectedRevision）+ 关闭载体重试（maxAttempts:1）');
  check(/code: 'TASKS_CAS_CONFLICT'/.test(codeLines), '冲突给显式错误码');
}

try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }

console.log('');
if (fail > 0) {
  console.log(`✗ 任务 CAS 测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 任务 CAS 测试通过（并发双写者都活、冲突显式报错、不静默覆盖、唯一入口）');
