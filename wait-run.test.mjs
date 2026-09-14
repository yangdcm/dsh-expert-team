// 测试：/team wait —— 可观测的等待（O7 · 把"禁 sleep"从禁令变成工具）
//
// 背景：SKILL 规则 13 是禁令（"禁止 sleep 等活"），但**没有给 lead 一个可用的等待工具**。
// 结果 lead 要么用 `bash sleep`（盲等），要么不等你动不了。本功能把禁令变成工具：
//   · 有在飞任务 ⇒ 如实报告"还有谁在做、做到哪了"（不瞎等）；
//   · 没有活的 ⇒ 如实说"可以动了"；
//   · 有在飞但**长时间无进展** ⇒ 报 noProgress 并建议干预。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M59。
// 运行：node wait-run.test.mjs

import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { waitRun, parseTeamCommand } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# /team wait（可观测的等待）\n');

function mkRun(tasks, updatedAt) {
  const ws = mkdtempSync(join(tmpdir(), 'wait-ws-'));
  mkdirSync(join(ws, 'team'), { recursive: true });
  const runId = 'test-run';
  const dir = join(ws, 'team', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'TASKS.json'), JSON.stringify({ revision: 1, tasks }, null, 2) + '\n');
  writeFileSync(join(dir, 'STATE.json'), JSON.stringify({ phase: 'implement', status: 'running', updatedAt: updatedAt || new Date().toISOString() }));
  return { ws, runId };
}

console.log('① 没有在飞任务 → 立即报告"可以动了"');
{
  const { ws, runId } = mkRun([
    { id: 'a', status: 'completed', owner: 'pm' },
    { id: 'b', status: 'done', owner: 'backend' },
  ]);
  const r = await waitRun(ws, runId);
  check(r.kind === 'success' && /没有在飞任务/.test(r.text), '没有在飞 → 立即返回"可以动了"', r.text.slice(0, 60));
  check(r.text.includes('可以继续了'), '明确说"可以继续"', '');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n② 有在飞任务 → 如实报告谁在做、做到哪了');
{
  const { ws, runId } = mkRun([
    { id: 'a', status: 'completed', owner: 'pm' },
    { id: 'b', status: 'in_progress', owner: 'backend' },
    { id: 'c', status: 'claimed', owner: 'qa' },
  ]);
  const r = await waitRun(ws, runId);
  check(r.kind === 'success', '返回成功', '');
  check(r.text.includes('2 个任务在飞'), '报告在飞数量', r.text.slice(0, 50));
  check(r.text.includes('b') && r.text.includes('c'), '点名具体任务', '');
  check(r.text.includes('backend') || r.text.includes('qa'), '点名谁在负责', '');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n③ 长时间无进展 → 报 noProgress 并建议干预');
{
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 分钟前
  const { ws, runId } = mkRun([
    { id: 'a', status: 'in_progress', owner: 'backend' },
  ], old);
  const r = await waitRun(ws, runId);
  check(r.text.includes('无进展'), '报无进展', '');
  check(r.text.includes('建议'), '给出建议', '');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n④ 有进展 → 不刷 noProgress');
{
  const { ws, runId } = mkRun([
    { id: 'a', status: 'in_progress', owner: 'backend' },
  ], new Date().toISOString());
  const r = await waitRun(ws, runId);
  check(!r.text.includes('无进展'), '有进展不报 noProgress', '');
  check(!r.text.includes('建议'), '不给干预建议', '');
  rmSync(ws, { recursive: true, force: true });
}

console.log('\n⑤ 命令解析 + 分发');
{
  check(parseTeamCommand('wait').kind === 'wait', '/team wait → wait', '');
  check(parseTeamCommand('wait my-run').kind === 'wait' && parseTeamCommand('wait my-run').run === 'my-run', '带 runId', '');
  check(parseTeamCommand('wait').kind !== 'create', '**不得落到 create**（与 /team help 同一类坑）', '');
}

console.log('\n⑥ 健壮性');
{
  const empty = mkdtempSync(join(tmpdir(), 'wait-e-'));
  const r = await waitRun(empty, 'nonexistent');
  check(r.kind === 'error' && /缺 TASKS\.json/.test(r.text), '缺任务表 → 如实报错', r.text.slice(0, 40));
  rmSync(empty, { recursive: true, force: true });
}

console.log('\n⑦ 接线检查');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'command.js'), 'utf8');
  // 2026-09-13（B 线第 8 项 · command-parse.js）：`USAGE` 已随整个 CLI 面搬出 `command.js`。
  // 接线类断言仍读 command.js；**只有** USAGE 那条改读它现在住的地方（重钉，不是放宽）。
  const cliSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'command-parse.js'), 'utf8');
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check(/case 'wait': return waitRun/.test(codeLines), 'dispatch 已接 wait', '');
  check(/\/team wait \[<run>\]/.test(cliSrc), 'USAGE 里可发现', '');
  check(/IN_FLIGHT_STATUSES\.includes/.test(codeLines), '用统一的在飞状态集', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ /team wait 测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ /team wait 测试通过（有活报进展、没活立即返回、无进展提示干预）');
