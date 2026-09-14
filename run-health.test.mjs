// 测试：搁浅 / 损坏的 run 必须**可发现**（B1 · N-5）
//
// 缺陷：`listRuns` 与 `listRunsInWorkspace` 对缺 `STATE.json`（或 STATE 不可解析）的目录是
// `catch { /* skip malformed */ }` / `if (st0)` —— **静默跳过**。
// 实测 `team/` 下 4 个目录里 **2 个没有 STATE.json**、1 个停在 `clarify/running` 很久，
// 而 `/team status` 与面板 run 下拉里**一个都看不到**，也没有"停滞"这个概念。
// 「东西少了却没有任何信号」正是本插件最危险的失败模式（与 schema 告警同源）。
//
// 修法：① 纯函数 `runHealth()` 给出显式判定；② 两个 listRuns 都**如实列出** broken 行；
// ③ `/team status` 显示损坏/搁浅并给出"需要处理"汇总。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M30 / M31。
// 运行：node run-health.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { runHealth, RUN_STALL_MS } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const NOW = 1_700_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const H = 60 * 60 * 1000;

console.log('# 搁浅 / 损坏 run 的可发现性（B1）\n');

console.log('① broken：STATE 缺失或不可解析 —— 最需要用户知道的一类');
{
  check(runHealth(null, { now: NOW }).health === 'broken', 'null → broken');
  check(runHealth(undefined, { now: NOW }).health === 'broken', 'undefined → broken');
  check(runHealth([], { now: NOW }).health === 'broken', '数组（不是对象）→ broken');
  check(runHealth('str', { now: NOW }).health === 'broken', '字符串 → broken');
  check(/STATE\.json/.test(runHealth(null, { now: NOW }).reason), '原因里点名 STATE.json', runHealth(null, { now: NOW }).reason);
}

console.log('\n② stalled：仍在 running，但超过阈值无更新');
{
  check(runHealth({ status: 'running', updatedAt: iso(NOW - 31 * 60 * 1000) }, { now: NOW }).health === 'stalled', '31 分钟 → stalled');
  check(runHealth({ status: 'running', updatedAt: iso(NOW - 29 * 60 * 1000) }, { now: NOW }).health === 'ok', '29 分钟 → ok（阈值内）');
  const s = runHealth({ status: 'running', updatedAt: iso(NOW - 3 * H) }, { now: NOW });
  check(/3 小时|180 分钟/.test(s.reason) || /分钟无更新/.test(s.reason), '原因里给出无更新时长', s.reason);
  check(RUN_STALL_MS === 30 * 60 * 1000, '默认阈值 30 分钟', String(RUN_STALL_MS));
  check(runHealth({ status: 'running', updatedAt: iso(NOW - H) }, { now: NOW, stallMs: 2 * H }).health === 'ok', '阈值可传参覆盖', '');
}

console.log('\n③ 不得把"已知终态/正常运行"误报成搁浅（否则告警变噪音）');
{
  check(runHealth({ status: 'complete', updatedAt: iso(NOW - 99 * H) }, { now: NOW }).health === 'done', 'complete（再老也是完成）');
  check(runHealth({ status: 'completed', updatedAt: iso(NOW - 99 * H) }, { now: NOW }).health === 'done', 'completed');
  check(runHealth({ status: 'failed', updatedAt: iso(NOW - 99 * H) }, { now: NOW }).health === 'ok', 'failed = 已知终态，不算搁浅');
  check(runHealth({ status: 'cancelled', updatedAt: iso(NOW - 99 * H) }, { now: NOW }).health === 'ok', 'cancelled 同理');
  check(runHealth({ status: 'running', updatedAt: iso(NOW - 60 * 1000) }, { now: NOW }).health === 'ok', '刚更新的 running → ok');
  check(runHealth({ status: 'running' }, { now: NOW }).health === 'ok', '**没有 updatedAt 时不臆断搁浅**（不假报）');
}

console.log('\n④ discarded：用户显式丢弃不是故障，优先级最高');
{
  const r = runHealth({ status: 'running', updatedAt: iso(NOW - 99 * H), planDiscarded: { at: 'x', reason: 'y' } }, { now: NOW });
  check(r.health === 'discarded', 'planDiscarded → discarded（而不是 stalled）', r.health);
  check(!/搁浅/.test(r.reason), '原因不写成搁浅', r.reason);
}

console.log('\n⑤ 健壮性：畸形输入不得抛错（在面板轮询路径上）');
{
  for (const st of [0, false, '', [], {}, { updatedAt: 'not-a-date' }, { status: 42 }, { status: 'running', updatedAt: 12345 }]) {
    let ok = true, msg = '';
    try { const r = runHealth(st, { now: NOW }); ok = !!(r && typeof r.health === 'string') } catch (e) { ok = false; msg = String(e && e.message) }
    check(ok, `runHealth(${JSON.stringify(st)}) → 有 health`, msg);
  }
  check(runHealth({ status: 'running', updatedAt: 'garbage' }, { now: NOW }).health === 'ok', '坏时间戳 → 不臆断搁浅', '');
}

console.log('\n⑥ 接线检查：两个 listRuns 都不得再静默跳过，/team status 必须显示');
{
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  check(!/catch \{ \/\* skip malformed \*\/ \}/.test(src), '`catch { /* skip malformed */ }` 已移除（否则又静默吞掉）');
  // 精确定位两个函数体再断言 —— 不能用全局 `health: 'broken'` 计数：
  // `runHealth()` 自己的返回值里也有这个字面量，会把计数凑够而让变异体逃逸（本轮实测踩到）。
  const bodyOf = (startMark, endMark) => {
    const a = src.indexOf(startMark);
    const b = a >= 0 ? src.indexOf(endMark, a) : -1;
    return (a >= 0 && b > a) ? src.slice(a, b) : '';
  };
  const listRunsBody = bodyOf('async function listRuns(cwd) {', 'async function renderStatus(');
  const wsRunsBody = bodyOf('async function listRunsInWorkspace(ws) {', '// Snapshot one run');
  check(!!listRunsBody && !!wsRunsBody, '定位到两个 listRuns 函数体');
  check(/health: 'broken'/.test(listRunsBody), 'listRuns 的 catch 分支产出 broken 行（不再静默跳过）');
  check(/health: 'broken'/.test(wsRunsBody), 'listRunsInWorkspace 也产出 broken 行（面板下拉同样可见）');
  check(/runHealth\(state\)/.test(listRunsBody) && /runHealth\(st0\)/.test(wsRunsBody), '两处都接了 runHealth');
  check(/r\.health === 'broken'/.test(src), '/team status 对 broken 有专门分支');
  check(/⚠ 需要处理/.test(src), '/team status 给出"需要处理"汇总（否则用户仍不知道怎么用这个信号）');
}

console.log('');
if (fail > 0) {
  console.log(`✗ run 健康度测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ run 健康度测试通过（损坏/搁浅可发现、不误报、丢弃不算故障）');
