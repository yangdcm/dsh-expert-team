// 测试：用户实证的「子代理卡死」与「中断后盲目继续」两个 bug 的修复（2026-09-11）
//
// Bug A（实证截图）：lead 对同一 agent 连续 3 次 steer，agent 每轮都**整文件重写** 800+ 行 /
//   40-50KB 的 SPEC.md → 上下文堆 3 份 → 输出预算耗尽 → 26 分钟零写入 = 用户看到的"卡死"。
//   根因是**编排方式**（反复重写大工件），不是模型故障。修复 = SKILL 规则 26（窄补丁模式纪律）。
//
// Bug B（实证）：断网/重启/异常中断后，用户发「继续」时 lead **盲目续跑**，从不核对在飞任务 ——
//   在飞任务的成员早已随进程死掉，不清算就派工会双写/覆盖。修复 = resumeRun 先做检测
//   （把"在飞/搁浅/是否先 settle"写进 followup）+ SKILL 规则 27。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M50 / M51。
// 运行：node card-stall.test.mjs

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
const skill = readFileSync(join(here, 'skills', 'expert-team', 'SKILL.md'), 'utf8');
const cmd = readFileSync(join(here, 'lib', 'command.js'), 'utf8');

console.log('# 子代理卡死 / 中断后盲目继续 修复验证\n');

console.log('① Bug A：SKILL 必须有「窄补丁模式」纪律（整文件重写 = 卡死前兆）');
{
  check(/26\. \*\*反复整文件重写大工件/.test(skill), 'SKILL 有规则 26', '');
  check(/只 `edit` 定点补丁、禁止 `write` 整文件/.test(skill), '明令 edit 定点补丁、禁止整文件重写', '');
  check(/连续 2 轮整文件重写同一文件.*视为高风险/.test(skill), '定义触发条件（连续 2 轮整文件重写）', '');
  check(/interrupt_agent`?\s*中断/.test(skill), '处置含 interrupt_agent', '');
  check(/换新 agent 做窄补丁/.test(skill), '处置含"换新 agent 做窄补丁"', '');
  check(/一次收齐输入再派工/.test(skill), '预防：一次收齐输入', '');
}

console.log('\n② Bug B：SKILL 必须有「中断后先检测」纪律');
{
  check(/27\. \*\*中断\/断网\/重启后用户说「继续」/.test(skill), 'SKILL 有规则 27', '');
  check(/先检测在飞与搁浅任务/.test(skill), '明确"先检测再决定"', '');
  check(/team settle/.test(skill), '指引用 /team settle 清算', '');
}

console.log('\n③ Bug B：resumeRun 必须**真的**做检测（不是只有 SKILL 提示）');
{
  check(/const inFlight = arrNow\.filter/.test(cmd), 'resumeRun 统计在飞任务', '');
  check(/const stranded = strandedTasks\(arrNow/.test(cmd), 'resumeRun 调 strandedTasks', '');
  check(/先清算再派工/.test(cmd), 'followup 里给"先清算再派工"指令', '');
  check(/中断后先检测，不要直接续跑/.test(cmd), 'followup 里写明"先检测"', '');
  check(/\/team settle \$\{run\}/.test(cmd), 'followup 里给可执行的 settle 命令（带 runId）', '');
  // 用户可见的返回文本也要带检测结果
  check(/疑似搁浅 \$\{stranded\.length\} 个/.test(cmd), '返回文本如实报告搁浅计数', '');
}

console.log('\n④ 回归：resumeRun 的原有契约不变（配额 / 恢复日志 / followup）');
{
  check(/run:resumed — 阶段=/.test(cmd), '仍写 run:resumed 日志', '');
  check(/达到配额限制/.test(cmd), '配额检查仍在', '');
  check(/加载 expert-team skill/.test(cmd), 'followup 仍要求加载 skill', '');
  check(/【专家团恢复】/.test(cmd), 'followup 前缀仍是【专家团恢复】', '');
  const p = parseTeamCommand('resume 做竞品分析-分析dsh官方的te-145629');
  check(p && p.kind === 'resume', '命令解析未受影响', JSON.stringify(p && p.kind));
}

console.log('');
if (fail > 0) {
  console.log(`✗ 卡死/中断修复测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 卡死/中断修复测试通过（SKILL 规则 26/27 在；resumeRun 真的做检测；原有契约未破）');
