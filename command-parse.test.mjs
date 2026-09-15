// 测试：`/team` 子命令解析 —— 修「`/team help` 建出一个空 run」
//
// 实测缺陷（读代码确认）：`parseTeamCommand` 只在**空输入**时返回 `{kind:'help'}`，
// 没有 `help` 分支 ⇒ `/team help` 穿过所有子命令判断、落到最后的 `create` 分支，
// 把字面量 `help` 当成任务文本，**建出 runId 形如 `help-HHMMSS` 的空 run**。
// 危害：用户一按就中；建出来的 run 会进 `team/` 目录、进 run 选择器、进 METRICS，
// 而且因为任务文本是 "help"，它连目标都说不清。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M26。
// 运行：node command-parse.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { parseTeamCommand } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# /team 子命令解析（help 必须独立分支）\n');

console.log('① `/team help` 及其等价写法 → help（绝不 create）');
{
  for (const inp of ['help', 'HELP', 'Help', '?', '-h', '--help', '帮助', '  help  ']) {
    const r = parseTeamCommand(inp);
    check(r.kind === 'help', `「${inp}」→ help`, r.kind);
  }
  // 关键：不能把 help 当任务文本建 run
  const r = parseTeamCommand('help');
  check(r.kind !== 'create', '`/team help` 不得落到 create（否则建出 help-HHMMSS 空 run）', r.kind);
  check(r.task === undefined, '`/team help` 不得携带 task 文本', JSON.stringify(r.task));
}

console.log('\n② 空输入仍然 → help（原有行为不得回退）');
{
  check(parseTeamCommand('').kind === 'help', '空串 → help');
  check(parseTeamCommand('   ').kind === 'help', '纯空白 → help');
  check(parseTeamCommand(null).kind === 'help', 'null → help');
  check(parseTeamCommand(undefined).kind === 'help', 'undefined → help');
}

console.log('\n③ 修法不得过宽：以 help 开头的**真实任务**仍须 create');
{
  const t1 = 'helpful 把登录页的错误提示改清楚';
  const r1 = parseTeamCommand(t1);
  check(r1.kind === 'create', '「helpful …」仍是 create（精确匹配，不是前缀匹配）', r1.kind);
  check(r1.task === t1, '任务文本原样保留', JSON.stringify(r1.task));
  const r2 = parseTeamCommand('helper 模块抽公共逻辑');
  check(r2.kind === 'create', '「helper …」仍是 create', r2.kind);
  const r3 = parseTeamCommand('帮我把 help 文档补一下');
  check(r3.kind === 'create', '任务里含 help 的普通句子仍是 create', r3.kind);
}

console.log('\n④ 既有子命令不得被新分支挤掉');
{
  const cases = [
    ['status', 'status'],
    ['members', 'members'],
    ['models', 'models'],
    ['learn', 'learn'],
    ['learn --deep', 'learn'],
    ['board', 'board'],
    ['detail', 'detail'],
    ['canvas', 'canvas'],
    ['clear', 'clear'],
    ['index', 'index'],
  ];
  for (const [inp, want] of cases) {
    const r = parseTeamCommand(inp);
    check(r.kind === want, `「/team ${inp}」→ ${want}`, r.kind);
  }
  check(parseTeamCommand('models --run').kind === 'models', '带参数的 models', parseTeamCommand('models').kind);
  check(parseTeamCommand('task').kind === 'error', '`task` 无参 → error（给用法）', parseTeamCommand('task').kind);
  check(parseTeamCommand('task T-1 done').kind === 'task', '`task T-1 done` → task');
}

console.log('\n⑤ 普通任务 → create，且参数解析仍然正确');
{
  const r = parseTeamCommand('--persist --no-code --name pomo 做一个番茄钟');
  check(r.kind === 'create', '→ create', r.kind);
  check(r.persist === true, '--persist 生效');
  check(r.noCode === true, '--no-code 生效');
  check(r.runName === 'pomo', '--name 取值正确', String(r.runName));
  check(/番茄钟/.test(r.task || ''), '任务文本保留', String(r.task));
  // ⚠️ 契约：**flags 必须写在任务文本之前**（解析器用 `while tokens[i].startsWith('--')` 前缀消费）。
  // USAGE 里正是这么教的（`/team --persist <task>`）。这里把契约钉住：改成"flags 可放任意位置"
  // 必须是有意为之的改动，而不是靠巧合。
  const r2 = parseTeamCommand('做一个番茄钟 --persist');
  check(r2.kind === 'create', 'flags 写在后面仍是 create', r2.kind);
  check(r2.persist === null, 'flags 写在任务之后不生效（被当成任务文本，未表态 ⇒ null）—— 契约，不是 bug', String(r2.persist));
  check(/--persist/.test(r2.task || ''), '后置 flag 原样进任务文本', String(r2.task));
}

console.log('\n⑥ USAGE 必须覆盖所有已实现的 flag（防"实现了但没文档"）');
{
// 2026-09-13（B 线第 8 项 · command-parse.js）：`USAGE` 已随整个 CLI 面搬出 `command.js`。
// 这条断言的意图是「命令在用法文本里**可发现**」⇒ 重钉到它现在住的地方，**不是**放宽。
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'lib/command-parse.js'), 'utf8');
  // ⚠️ 2026-09-13 修：旧正则 `/const USAGE = \[[\s\S]*?\n\];/` **从来没匹配到 USAGE 真正的收尾**
  // （USAGE 是以 ` ].join('\\n');` 结束的，不是顶格 `];`）。在 5101 行的 command.js 里它惰性一路
  // 匹配到**后面某处**的 `\n];`，于是抓到一大坨恰好包含所有 flag 的文本 —— 断言"通过"了，但校验的
  // 并不是 USAGE 本身。搬到 181 行的 command-parse.js 后没有那个"后面的 `];`"，假绿当场暴露。
  // 现在按真实收尾匹配，并且容忍 `export `：这条断言第一次真正在查 USAGE。
  const usage = (src.match(/(?:export )?const USAGE = \[[\s\S]*?\n\s*\]\.join\('\\n'\);/) || [''])[0];
  check(!!usage, '找到 USAGE 常量');
  for (const f of ['--persist', '--no-code', '--roles', '--profile', '--name', '--allow-rebuild']) {
    check(usage.includes(f), `USAGE 提到 ${f}`);
  }
  check(/\/team help/.test(usage), 'USAGE 提到 /team help 本身（否则用户不知道有它）');
}

console.log('');
if (fail > 0) {
  console.log(`✗ /team 解析测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ /team 解析测试通过（help 独立分支；helpful 等真实任务不受影响）');
