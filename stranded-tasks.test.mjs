// 测试：冷启动最小版 —— 搁浅任务「可发现 + 可清算」（L3-2′）
//
// 缺陷：进程重启 / 会话关闭后，原本在跑的成员已经不在了，而 `TASKS.json` 里仍是
// `claimed` / `in_progress`。这些任务**不会自己动**，也**没有任何信号** ——
// `resumeRun` 只做三件事（查 quota / 写日志 / followup 一句），**根本不核对在飞任务**。
// 与 `N-5 搁浅 run` 同源，只是粒度落在 task 上。
//
// 修法（刻意做成**最小版**）：
//   · 可发现：`strandedTasks()` 纯函数；接进 `/team status` 与 `/team check`
//   · 可清算：`/team settle [<run>]` → 状态回 `pending`、`attempt+1`、写 `strandedAt/From` + note、RUN.log 留痕
// 刻意**不自动清算**：自动改 TASKS.json 会在"成员其实还在跑"时误伤（面板与 CLI 的活跃视图未必一致）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M35 / M36。
// 运行：node stranded-tasks.test.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { strandedTasks, settleStranded, IN_FLIGHT_STATUSES, parseTeamCommand } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const T = (id, status, owner, extra) => ({ id, status, owner, attempt: 1, ...(extra || {}) });

console.log('# 搁浅任务：可发现 + 可清算（L3-2′）\n');

console.log('① 可发现：只有「在飞 且 owner 无存活成员」才算搁浅');
{
  const tasks = [
    T('T-01', 'in_progress', 'backend'),   // backend 活着 → 不算
    T('T-02', 'claimed', 'qa'),            // qa 死了 → 搁浅
    T('T-03', 'completed', 'pm'),          // 终态 → 不算
    T('T-04', 'pending', 'architect'),     // 未开工 → 不算
    T('T-05', 'in_progress', 'reviewer'),  // 死了 → 搁浅
    { id: 'T-06', status: 'claimed', attempt: 1 }, // 无 owner → 搁浅
  ];
  const s1 = strandedTasks(tasks, ['backend']);
  check(s1.map((s) => s.id).join(',') === 'T-02,T-05,T-06', '只挑出 3 个搁浅', s1.map((s) => s.id).join(','));
  check(s1[0].because.includes('qa'), '原因点名 owner', s1[0].because);
  check(s1[2].because.includes('没有 owner'), '无 owner 的原因不同', s1[2].because);
  // 冷启动瞬间：活跃集合为空 ⇒ 所有在飞都搁浅（这就是事实，不是误报）
  const s2 = strandedTasks(tasks, []);
  check(s2.map((s) => s.id).join(',') === 'T-01,T-02,T-05,T-06', '冷启动（无活跃）→ 全部在飞都搁浅', s2.map((s) => s.id).join(','));
  check(s2.length >= s1.length, '活跃越少、搁浅越多（单调）');
  check(IN_FLIGHT_STATUSES.join(',') === 'claimed,in_progress', '在飞状态集明确可审计', IN_FLIGHT_STATUSES.join(','));
}

console.log('\n② 可清算：回 pending + attempt+1 + 留痕，且**不动别人**');
{
  const tasks = [T('T-01', 'in_progress', 'backend'), T('T-02', 'claimed', 'qa'), T('T-03', 'completed', 'pm')];
  const s = strandedTasks(tasks, ['backend']);
  const r = settleStranded(tasks, s, { at: '2026-09-11T00:00:00.000Z', reason: '测试清算' });
  check(r.settled.length === 1 && r.settled[0].id === 'T-02', '只清算 T-02', JSON.stringify(r.settled));
  const t2 = r.tasks.find((t) => t.id === 'T-02');
  check(t2.status === 'pending', '状态回 pending（不是 failed：它没失败，只是没人做）', t2.status);
  check(t2.attempt === 2, 'attempt+1（与 SKILL 的 attempt 语义一致）', String(t2.attempt));
  check(t2.strandedFrom === 'claimed' && t2.strandedAt === '2026-09-11T00:00:00.000Z', '保留 strandedFrom/strandedAt（不静默抹历史）', JSON.stringify({ f: t2.strandedFrom, a: t2.strandedAt }));
  check(/测试清算/.test(t2.note || ''), '原因写进 note', t2.note);
  check(r.tasks.find((t) => t.id === 'T-01').status === 'in_progress', '有存活成员的任务不受影响');
  check(tasks.find((t) => t.id === 'T-02').status === 'claimed', '**入参未被改写**（纯函数）');
  // 原 note 保留并追加
  const withNote = [T('T-09', 'in_progress', 'x', { note: '原有备注' })];
  const r2 = settleStranded(withNote, strandedTasks(withNote, []), { reason: 'r' });
  check(/原有备注/.test(r2.tasks[0].note) && /r/.test(r2.tasks[0].note), '原有 note 保留并追加', r2.tasks[0].note);
}

console.log('\n③ 无误报路径：没有搁浅时 settled 为空（调用方据此**不写盘**）');
{
  const tasks = [T('T-01', 'in_progress', 'backend'), T('T-02', 'completed', 'pm')];
  const r = settleStranded(tasks, strandedTasks(tasks, ['backend']), {});
  check(r.settled.length === 0, '全部有人做 → 0 条清算', String(r.settled.length));
  check(JSON.stringify(r.tasks) === JSON.stringify(tasks), '数据原样返回（可安全跳过写盘）');
  check(settleStranded([], [], {}).settled.length === 0, '空输入 → 0 条');
  check(settleStranded(tasks, [{ id: '不存在' }], {}).settled.length === 0, '不存在的 id → 0 条（不臆造）');
}

console.log('\n④ 健壮性：畸形输入不得抛错（在 /team status 轮询路径上）');
{
  for (const [a, b] of [[null, null], [undefined, undefined], ['x', 'y'], [[], {}], [[null, 1, 'a'], []], [[{ id: 'T' }], null]]) {
    let ok = true, msg = '';
    try { const r = strandedTasks(a, b); ok = Array.isArray(r) } catch (e) { ok = false; msg = String(e && e.message) }
    check(ok, `strandedTasks(${JSON.stringify(a)}, ${JSON.stringify(b)}) → 数组`, msg);
  }
  for (const [a, b] of [[null, null], [undefined, undefined], ['x', 'y'], [[{ id: 'a' }], null]]) {
    let ok = true, msg = '';
    try { const r = settleStranded(a, b, {}); ok = !!(r && Array.isArray(r.tasks) && Array.isArray(r.settled)) } catch (e) { ok = false; msg = String(e && e.message) }
    check(ok, `settleStranded(${JSON.stringify(a)}) → {tasks,settled}`, msg);
  }
  check(strandedTasks([T('T-1', 'in_progress', '')], []).length === 1, 'owner 为空串 → 按"没有 owner"处理');
}

console.log('\n⑤ 命令解析：/team settle 必须有独立分支（否则会去建 run）');
{
  check(parseTeamCommand('settle').kind === 'settle', '`/team settle` → settle');
  check(parseTeamCommand('settle my-run').kind === 'settle' && parseTeamCommand('settle my-run').run === 'my-run', '`/team settle my-run` 带 run');
  check(parseTeamCommand('settle').kind !== 'create', '**不得落到 create**（与 /team help 同一类坑）');
}

console.log('\n⑥ 接线检查：可发现（status/check）与可清算（dispatch/USAGE）都接上了');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  // 2026-09-13（B 线第 8 项 · command-parse.js）：`USAGE` 已随整个 CLI 面搬出 `command.js`。
  // 接线类断言仍读 command.js；**只有** USAGE 那条改读它现在住的地方（重钉，不是放宽）。
  const cliSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib/command-parse.js'), 'utf8');
  check(/strandedTotal/.test(src) && /搁浅任务\$\{strCount\}/.test(src), '/team status 显示搁浅任务数');
  check(/搁浅任务 \$\{strandedHere\.length\} 个/.test(src) && /team settle \$\{runId\}/.test(src), '/team check 给出**可执行**的清算命令（带 runId）');
  check(/case 'settle': return settleRuns\(cwd, c\.run, ctx\)/.test(src), 'dispatch 已接 settle');
  check(/async function settleRuns/.test(src), 'settleRuns 实现存在');
  check(/\/team settle \[<run>\]/.test(cliSrc), 'USAGE 里可发现该命令');
  // 清算的写入走 `mutateTasks`（读-改-写带版本栅栏）；再断言 mutateTasks 内部走的是受控写入。
  check(/const sr = await mutateTasks\(dir, \(json\) =>/.test(src), '清算走 mutateTasks（带 CAS 的读-改-写入口）');
  check(/await ARTIFACT\.must\(target, next, \{ expectedRevision: snap\.revision/.test(src), 'mutateTasks 内部用受控写入 + 版本栅栏');
  check(/lead:settle — /.test(src), '清算写 RUN.log 留痕（可审计）');
}

console.log('\n⑦ 真实 run 无误报：已完成的 run 不该被报成"有搁浅任务"');
{
  const roots = (process.env.EXPERT_TEAM_RUN_ROOTS || join(process.cwd(), 'team')).split(':').filter(Boolean);
  let seen = 0, noisyCompleted = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const n of readdirSync(root)) {
      const p = join(root, n, 'TASKS.json');
      if (!existsSync(p)) continue;
      let arr = null;
      try { arr = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
      arr = Array.isArray(arr) ? arr : (arr && Array.isArray(arr.tasks) ? arr.tasks : []);
      if (!arr.length) continue;
      seen += 1;
      const inFlight = arr.filter((t) => IN_FLIGHT_STATUSES.includes(t.status));
      const s = strandedTasks(arr, []);
      // 已交付/完成的 run 里若还有在飞任务，那本身就是真问题；这里只统计"完成态 run 误报"
      const st = existsSync(join(root, n, 'STATE.json')) ? JSON.parse(readFileSync(join(root, n, 'STATE.json'), 'utf8')) : null;
      const done = st && (st.status === 'complete' || st.status === 'completed');
      if (done && inFlight.length === 0 && s.length) noisyCompleted += 1;
    }
  }
  if (seen === 0) {
    console.log('      · 跳过：未发现带任务表的真实 run（把 EXPERT_TEAM_RUN_ROOTS 指向你的 run 目录即可启用本探针）');
  } else {
    check(noisyCompleted === 0, `已完成的 run 零误报（${noisyCompleted}）`);
  }
}

console.log('');
if (fail > 0) {
  console.log(`✗ 搁浅任务测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 搁浅任务测试通过（可发现、可清算、不动别人、有存活成员时零误报）');
