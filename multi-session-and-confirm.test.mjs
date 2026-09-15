// 测试：多会话归属标记（优化①）+ 大需求执行前询问（优化②）
//
// 优化①（多会话冲突）：run 归属三源已有（STATE.ownerSession / session-runs via='create'），
//   但**建 run 时不检测别的会话的活跃 run**，面板也**不显示归属** ——
//   两个会话同时指挥同一个工作区时，用户完全无感。修法：
//     · listRunsInWorkspace 暴露 ownerSession/ownerResolved（面板据此打标）
//     · createRun 提示同工作区别的会话的活跃 run（**提示不阻断**：并行是合法用法）
//     · 面板：run 下拉标 👥；看别人的 run 时顶部给归属横幅
//
// 优化②（大需求执行前询问）：`--confirm` 建 run 但**不自动派工**，立 pendingDecision，
//   面板三选项「执行 / 查看方案 / 补充意见」；点「执行」必须**真的开工**
//   （走 ctx.agents.get(sessionId).followup，与 /team 派工同一入口），
//   点「查看方案」只打开 md 预览、**不清待决**（否则等于没确认就开工）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M52 / M53 / M54。
// 运行：node multi-session-and-confirm.test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { parseTeamCommand } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const here = dirname(fileURLToPath(import.meta.url));
const cmd = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
// 2026-09-13（B 线第 8 项 · command-parse.js）：`USAGE` 已随整个 CLI 面搬出 `command.js`。
// 这条断言的意图是「命令在用法文本里**可发现**」⇒ 重钉到它现在住的地方，**不是**放宽。
const cmdParse = readFileSync(join(here, 'lib', 'command-parse.js'), 'utf8');
const cli = readFileSync(join(here, 'client.js'), 'utf8');

console.log('# 多会话归属 + 大需求确认\n');

console.log('① 归属信息必须贯通到面板（host 侧）');
{
  check(/ownerSession: String\(st0\.ownerSession \|\| ''\), ownerResolved: !!st0\.ownerSession/.test(cmd), 'listRunsInWorkspace 暴露 ownerSession/ownerResolved', '');
  check(/stateOwnerSession: String\(state\.ownerSession \|\| ''\)/.test(cmd), 'snapshotRun 已暴露 stateOwnerSession（面板横幅的数据源）', '');
  check(/同工作区有 \*\*\$\{others\.length\} 个别的会话的活跃 run\*\*/.test(cmd), 'createRun 检测并提示他会话活跃 run', '');
  check(/r\.ownerSession && r\.ownerSession !== ownerSid/.test(cmd), '判定条件：归属已知且 ≠ 本会话', '');
  // **不能阻断**：并行两个 run 是合法用法
  check(!/others\.length\)\s*\{\s*return \{ kind: 'error'/.test(cmd), '是**提示**而非阻断（并行 run 合法）', '');
}

console.log('\n② 归属标记必须在面板可见（client 侧）');
{
  check(/ownerTag = \(r\.ownerSession && r\.ownerSession !== sessionId\)/.test(cli), 'run 下拉按归属打标（👥）', '');
  check(/ownerBanner/.test(cli), '看别人的 run 时有归属横幅', '');
  // 1.3.23：文案改成**纯文本强调**（「」）—— 原来这里钉的是带 `**` 的版本，而面板没有 markdown 渲染器，
  // 星号会被字面显示出来（真机实测到过）。测试跟着改成钉纯文本，并**反向**断言星号不再出现。
  check(/这个 run 由「另一个会话」创建并拥有/.test(cli), '横幅文案说明来源与建议动作（纯文本强调，不带 markdown 标记）', '');
  check(!/这个 run 由\*\*另一个会话\*\*/.test(cli), '横幅文案不再使用会被字面显示的 `**` 标记', '');
  check(/data\.stateOwnerSession !== sessionId/.test(cli), '判定用 stateOwnerSession（不是 request 的 session）', '');
}

console.log('\n③ --confirm：建 run 但**不自动派工**');
{
  const c = parseTeamCommand('--confirm 把登录改成手机号');
  check(c.kind === 'create' && c.confirm === true && c.task === '把登录改成手机号', '--confirm 解析正确（flags-first）', JSON.stringify({ k: c.kind, c: c.confirm, t: c.task }));
  const c2 = parseTeamCommand('--persist --confirm x');
  check(c2.persist === true && c2.confirm === true, '与其它 flag 共存', JSON.stringify({ p: c2.persist, c: c2.confirm }));
  const c3 = parseTeamCommand('修复登录问题');
  check(c3.confirm === false, '**默认不 --confirm**（不破坏既有行为）', String(c3.confirm));
  check(/if \(mode\.confirm\) \{/.test(cmd), 'createRun 有 confirm 分支', '');
  check(/kind: 'confirm-before-execute'/.test(cmd), '立 pendingDecision（kind=confirm-before-execute）', '');
  check(/\*\*未自动派工\*\*/.test(cmd), '返回文本明确"未自动派工"', '');
  // confirm 分支必须在 launchMessage 之前 return
  const confAt = cmd.indexOf('if (mode.confirm) {');
  const launchAt = cmd.indexOf('const msg = await launchMessage(mode.task, cwd, runDir, mode);');
  check(confAt > 0 && launchAt > confAt, 'confirm 分支在自动派工之前（不落进 launchMessage）', `${confAt} < ${launchAt}`);
}

console.log('\n④ 点「执行」必须**真的开工**（否则是"点了没反应"）');
{
  check(/ctx\.get\('agents'\)/.test(cmd), '用宿主 ctx.get(\'agents\') 取 agent（与 goal 驱动同一 accessor）', '');
  check(/agents\.get\(sid\)/.test(cmd), '按 sessionId 取 agent', '');
  check(/agent\.followup\(await launchMessage/.test(cmd), '点「执行」投递派工消息（与 /team 派工同一入口）', '');
  // 2026-09-13（G 线档位）：响应体多了「选了档位就回 tier / rolesNarrowed」两项，断言**同步重钉到
  // 新的逐字文本**（不是放宽 —— 仍然是整条源码比对；这条断言正是靠"逐字"才在两次改动里都立刻报出来）。
  check(/dispatched = true/.test(cmd) && /json\(200, \{ ok: true, choice, run, dispatched, \.\.\.\(tierApplied \? \{ tier: tierApplied \} : \{\}\), \.\.\.\(rolesNarrowedNote \? \{ rolesNarrowed: true \} : \{\}\) \}\)/.test(cmd), '返回值带 dispatched（前端可判断是否真的开工）+ 档位选择时带 tier / rolesNarrowed', '');
  check(/plan:confirm-failed/.test(cmd), '取不到 agent 时**如实记录**（会话已结束）而不是静默', '');
}

console.log('\n⑤ 点「查看方案」只预览、**不清待决**（否则没确认就开工）');
{
  check(/查看方案\|view plan/.test(cli), 'DecisionComposer 识别「查看方案」', '');
  check(/openArtifact\('SPEC\.md'/.test(cli), '打开 SPEC.md 预览', '');
  const at = cli.indexOf('if (/查看方案|view plan/i.test(String(id))) {');
  const ret = at >= 0 ? cli.indexOf('return', at) : -1;
  const seg = (at >= 0 && ret > 0) ? cli.slice(at, ret + 6) : '';
  check(seg !== '' && /openArtifact\('SPEC\.md'/.test(seg) && !/fetch\(/.test(seg), '该分支只开预览并 return（**不发** fetch /decide）', seg.replace(/\s+/g, ' ').slice(0, 88));
}

console.log('\n⑥ 回归：既有决策链路未被破坏');
{
  check(/decision:\$\{choice\} — 用户在浮层拍板/.test(cmd), '/decide 仍记 RUN.log', '');
  check(/DECISIONS\.md/.test(cmd), '仍写 DECISIONS.md', '');
  check(/delete state\.pendingDecision/.test(cmd), '仍清 pendingDecision', '');
  check(/if \(wasConfirm && choice === '执行'\)/.test(cmd), '**只有** confirm-before-execute 的「执行」才派工（其它决策不受影响）', '');
  check(/\/team --confirm <task>/.test(cmdParse), 'USAGE 里可发现 --confirm', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 多会话/确认 测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 多会话/确认 测试通过（归属可见、提示不阻断、--confirm 不自动派工、执行真的开工、查看不清待决）');
