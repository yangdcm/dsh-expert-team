// 测试：常驻规则（"改完就提交"这类用户立的规矩）不随对话压缩消失
//
// 用户实证（2026-09-11）："改完代码没问题就提交并推送"这条规则说过一次，
// 过了一段时间就不再执行了 —— 因为它只活在**对话历史**里，对话被压缩/换 run 后
// 规则跟着没了。
//
// 修法（与"读磁盘不靠记性"取向一致）：
//   · 落点 `<cwd>/team/STANDING-RULES.md`（工作区级、跨 run、跨会话、在磁盘上）；
//   · launchMessage 自动注入"常驻规则"块（每次开工都带上）；
//   · `/team rule <内容>` 立规 / `/team rules` 查看；
//   · SKILL 规则 28 立"先读再动"。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M55 / M56。
// 运行：node standing-rules.test.mjs

import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { readStandingRules, appendStandingRule, rulesRun, parseTeamCommand } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const here = dirname(fileURLToPath(import.meta.url));
const cmd = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
const skill = readFileSync(join(here, 'skills', 'expert-team', 'SKILL.md'), 'utf8');

console.log('# 常驻规则（不随对话压缩消失）\n');

const dir = mkdtempSync(join(tmpdir(), 'rules-'));
mkdirSync(join(dir, 'team'), { recursive: true });

console.log('① 落盘 + 读取（完整链路）');
{
  const r1 = await appendStandingRule(dir, '改完代码没问题就提交并推送');
  check(r1.ok && r1.added, '第一条写入成功', JSON.stringify(r1));
  const r2 = await appendStandingRule(dir, '改完代码没问题就提交并推送');
  check(r2.ok && r2.added === false, '同一条不重复写入（幂等）', JSON.stringify(r2));
  const read = await readStandingRules(dir);
  check(read.includes('改完代码没问题就提交并推送'), '读得回来', read.slice(0, 60));
  check(read.includes('常驻规则'), '摘要块有标题', '');
}

console.log('\n② 多条 + 截断 + 去注释');
{
  await appendStandingRule(dir, '改完就提交');
  await appendStandingRule(dir, '中断后先查搁浅任务再派工');
  const read = await readStandingRules(dir);
  check(read.split('\n').filter((l) => l.startsWith('- ')).length === 3, '三条都在', '');
}

console.log('\n③ 空目录 / 缺文件 不报错（读取是 best-effort）');
{
  const empty = mkdtempSync(join(tmpdir(), 'rules-e-'));
  const r = await readStandingRules(empty);
  check(r === '', '没文件 → 空串（不报错）', '');
  const r2 = await rulesRun(empty, 'list', '');
  check(r2.kind === 'success' && /还没有常驻规则/.test(r2.text), 'list 如实说"没有"', r2.text.slice(0, 40));
}

console.log('\n④ /team rule 命令解析');
{
  const p1 = parseTeamCommand('rule 改完就提交');
  check(p1.kind === 'rules' && p1.action === 'add' && p1.rule === '改完就提交', 'rule 加规则', JSON.stringify(p1));
  const p2 = parseTeamCommand('rules');
  check(p2.kind === 'rules' && p2.action === 'list', 'rules 列出', JSON.stringify(p2));
  const p3 = parseTeamCommand('rules 列出所有');
  check(p3.kind === 'rules' && p3.action === 'add' && p3.rule === '列出所有', 'rules <内容> 也是 add（命令行不分 list/add 两个子命令）', JSON.stringify(p3));
  const p4 = parseTeamCommand('rule');
  check(p4.kind === 'rules' && p4.action === 'list', 'rule 无参数 → list', JSON.stringify(p4));
}

console.log('\n⑤ launchMessage 必须**带上**常驻规则（这是"每次开工都记得"的机制）');
{
  check(/const rules = await readStandingRules\(cwd\)/.test(cmd), 'launchMessage 读规则', '');
  check(/rules \|\| ''/.test(cmd), '规则注入消息行', '');
  check(/【常驻规则/.test(cmd), '消息里有"常驻规则"块', '');
}

console.log('\n⑥ SKILL 必须立"先读再动"的规则');
{
  check(/28\. \*\*常驻规则必须落盘/.test(skill), 'SKILL 有规则 28', '');
  check(/STANDING-RULES\.md/.test(skill), 'SKILL 写明落点文件名', '');
  check(/压缩对话.*后.*消失/.test(skill), 'SKILL 说明为什么要落盘（压缩后会消失）', '');
}

console.log('\n⑦ 命令分发：rules 路由到 rulesRun（不落进 create）');
{
  check(/case 'rules': return rulesRun/.test(cmd), 'dispatch 已接 rules', '');
  check(parseTeamCommand('rules').kind === 'rules', '/team rules → rules', '');
  check(parseTeamCommand('rules').kind !== 'create', '**不得落到 create**（与 /team help 同一类坑）', '');
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
try { rmSync(join(tmpdir(), 'rules-e-'), { recursive: true, force: true }); } catch { /* noop */ }

console.log('');
if (fail > 0) {
  console.log(`✗ 常驻规则测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 常驻规则测试通过（落盘+读取、幂等、命令、launchMessage 注入、SKILL 规则、分发）');
