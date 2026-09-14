// 测试：run 采集层 `lib/metrics/collect.js`（B 线 10b 第二刀）
//
// 采集层要钉住的只有两件事，但都很值钱：
//   ① **什么算一个 run** —— `team/` 里还躺着 METRICS.md / LEARNINGS.md / REPOWIKI.md /
//      CODEINDEX.json 这些**文件**，以及可能的空目录。旧实现把它们也算进「总 run 数」，
//      用户看到「总 run 数：8」而真实只有 2（D4 实测）。所以标记文件判定 + skipped 计数必须钉死。
//   ② **缺件不抛** —— 一个 run 可能只有 TASK.md（没有 TASKS.json / ROSTER.json），
//      采集层必须返回"空值"而不是抛错（抛了整次 `/team learn` 就没了）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M107**。
// 运行：node metrics-collect.test.mjs

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRunNames, readRunInputs, RUN_MARKER_FILES } from './lib/metrics/collect.js';

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-et-collect-'));
const team = join(root, 'team');
await mkdir(team, { recursive: true });

console.log('# run 采集层\n');

console.log('① 枚举：什么算 run');
{
  // 三个真 run（各用不同标记文件）+ 两个非 run 目录 + 三个文件
  await mkdir(join(team, 'r-state'), { recursive: true });
  await writeFile(join(team, 'r-state', 'STATE.json'), '{}');
  await mkdir(join(team, 'r-taskmd'), { recursive: true });
  await writeFile(join(team, 'r-taskmd', 'TASK.md'), '# 任务');
  await mkdir(join(team, 'r-log'), { recursive: true });
  await writeFile(join(team, 'r-log', 'RUN.log.md'), '- [00:00:00] run:started — x');
  await mkdir(join(team, 'empty-dir'), { recursive: true });
  await mkdir(join(team, 'junk-dir'), { recursive: true });
  await writeFile(join(team, 'junk-dir', 'notes.txt'), 'x');
  await writeFile(join(team, 'METRICS.md'), '# 指标');
  await writeFile(join(team, 'LEARNINGS.md'), '# 经验');
  await writeFile(join(team, 'CODEINDEX.json'), '{}');

  const r = await listRunNames(team);
  check(r.ok === true, 'ok=true', '');
  check(JSON.stringify(r.names) === JSON.stringify(['r-log', 'r-state', 'r-taskmd']), '只收含标记文件的目录，且已排序', JSON.stringify(r.names));
  check(r.skipped === 5, 'skipped 数对（2 个非 run 目录 + 3 个文件）', `skipped=${r.skipped}`);
  check(JSON.stringify(RUN_MARKER_FILES) === JSON.stringify(['STATE.json', 'TASK.md', 'RUN.log.md']), '标记文件集合不变（改它等于改"什么算 run"）', RUN_MARKER_FILES.join(','));
}

console.log('\n② 缺件不抛：返回空值而不是报错');
{
  const full = await readRunInputs(team, 'r-state');
  check(full.state && typeof full.state === 'object', '有 STATE.json ⇒ 解析成对象', JSON.stringify(full.state));
  check(full.log === '', '没有 RUN.log.md ⇒ 空串（不是 null）', JSON.stringify(full.log));
  check(full.tasksDoc === null, '没有 TASKS.json ⇒ null', String(full.tasksDoc));
  check(full.rosterDoc === null, '没有 ROSTER.json ⇒ null', String(full.rosterDoc));
  check(full.dir === join(team, 'r-state'), 'dir 是拼好的绝对路径', full.dir);

  const onlyLog = await readRunInputs(team, 'r-log');
  check(onlyLog.log.startsWith('- [00:00:00]'), '只有 RUN.log.md 也能读出来', JSON.stringify(onlyLog.log.slice(0, 20)));
}

console.log('\n③ 坏 JSON 不抛（半写坏的文件不能拖垮整次聚合）');
{
  await mkdir(join(team, 'r-broken'), { recursive: true });
  await writeFile(join(team, 'r-broken', 'STATE.json'), '{"phase":');
  await writeFile(join(team, 'r-broken', 'TASKS.json'), 'not json at all');
  await writeFile(join(team, 'r-broken', 'ROSTER.json'), '[1,2,3]');
  const b = await readRunInputs(team, 'r-broken');
  check(b.state === null, '坏 STATE.json ⇒ null（不抛）', String(b.state));
  check(b.tasksDoc === null, '坏 TASKS.json ⇒ null（不抛）', String(b.tasksDoc));
  check(JSON.stringify(b.rosterDoc) === '[1,2,3]', '合法 JSON 数组照原样返回（采集层不做形状判定）', JSON.stringify(b.rosterDoc));
}

console.log('\n④ 边界：root 不存在 ⇒ ok:false（调用方按"零 run"处理，而不是崩）');
{
  const missing = await listRunNames(join(root, 'nope'));
  check(missing.ok === false && missing.names.length === 0 && missing.skipped === 0, 'root 读不了 ⇒ {ok:false, names:[], skipped:0}', JSON.stringify(missing));
}

console.log('\n⑤ 结构：aggregate 不再自己 readdir/readFile 做采集');
{
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./lib/command.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function aggregate(cwd)');
  // 取整个 aggregate 主体（到渲染调用为止），并**剥掉行注释** —— 否则注释里提到的旧写法
  // （如 D4 那段解释里写着 `readdir(root)`）会把结构断言误判成失败。
  const seg = src.slice(at, src.indexOf('const metrics = renderMetrics({', at))
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check(/listRunNames\(root\)/.test(seg), 'aggregate 用 listRunNames', '');
  check(/readRunInputs\(root, n\)/.test(seg), 'aggregate 用 readRunInputs', '');
  check(!/await readdir\(/.test(seg), 'aggregate 不再自己 readdir（已剥注释后判定）', '');
  check(!/await readFile\(join\(dir, 'STATE\.json'\)/.test(seg), 'aggregate 不再自己 readFile 读 STATE', '');
  check(!/const RUN_MARKER_FILES =/.test(src), 'command.js 不再自带 RUN_MARKER_FILES（已搬进采集层）', '');
}

if (fail) { console.error(`\n✗ metrics-collect：${fail} 项失败`); process.exit(1); }
console.log('\n✓ metrics-collect：全部通过');
