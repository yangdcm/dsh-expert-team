// 测试：F 线第 4 项 **身份策略**（设置 → POLICY.md + 启动消息口径块）
//
// 需求原文：「目前对话框询问的问题有时候偏技术性或产品性，如果懂技术的就很好明白，如果不懂技术的人
// 就可能不会选……很多问题可以另外加一个身份专门帮用户做决策」。
//
// 三层落地里的前两层由本包代码负责（**不依赖重新同步、对新 run 立即生效**）：
//   ① 启动消息里的【用户画像与提问口径】块；② run 目录的 `POLICY.md`（可审计、子代理可读）。
//
// 本测试钉住：
//   ① 三种身份的**口径确实不同**（不是同一个模板换个标题）；
//   ② `keepPlanGate=false` 是**用户显式授权**，必须在 POLICY.md 与启动消息里写明（有意的例外，不是默认）；
//   ③ 端到端：建 run 会落 `POLICY.md`、启动消息**开头**就是口径块、RUN.log 留痕 —— 且旧 run（无此文件）不受影响。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M120**。
// 运行：node policy.test.mjs

import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePolicy, policyBlockFrom, POLICY_BLOCK_START, POLICY_BLOCK_END, POLICY_PROFILES, defaultSettings } from './lib/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# F 线 · 身份策略\n');

console.log('① 三种身份的口径**确实不同**（不是同一模板换标题）');
{
  const dev = compilePolicy(defaultSettings());
  const nt = compilePolicy({ identity: { profile: 'non-technical', askBudget: 3 } });
  const mx = compilePolicy({ identity: { profile: 'mixed' } });
  check(dev.profile === 'developer' && nt.profile === 'non-technical' && mx.profile === 'mixed', '三种 profile 各自解析');
  check(dev.label === '技术开发者' && nt.label === '无技术经验' && mx.label === '混合', '中文标签来自真源', `${dev.label}/${nt.label}/${mx.label}`);
  check(/禁止术语/.test(nt.ask) && /人话版/.test(nt.ask), '**无技术经验**：禁止术语 + 必须给一句话人话版', nt.ask.slice(0, 40));
  check(/代你拍板/.test(nt.decide) && /必须问你/.test(nt.decide), '**无技术经验**：技术决策代拍、产品/范围决策必须问', nt.decide.slice(0, 36));
  check(/不代你决策/.test(dev.decide), '**技术开发者**：不代决（只给选项与权衡）');
  check(/两段式/.test(mx.ask), '**混合**：两段式（人话 + 技术细节）');
  check(nt.askBudget === 3 && /最多问 \*\*3\*\* 个问题/.test(nt.block), '提问预算进了口径块', String(nt.askBudget));
  const fallback = compilePolicy({ identity: { profile: '乱写' } });
  check(fallback.profile === 'developer', '认不出的 profile ⇒ 回默认身份（不抛、不静默无策略）');
}

console.log('\n② 勾选「帮我决策」与关闭「方案确认门」都要**留痕可审计**');
{
  const withDecide = compilePolicy({ identity: { profile: 'developer', offerDecideForMe: true } });
  check(/已在设置里勾选/.test(withDecide.decide) && /逐条留痕/.test(withDecide.decide), '勾选代决 ⇒ 明确要求逐条留痕', '');
  const noGate = compilePolicy({ identity: { keepPlanGate: false } });
  check(noGate.keepPlanGate === false, '设置被读进来');
  check(/已显式关闭/.test(noGate.md) && /已获准/.test(noGate.block), '**关闭方案确认门 = 用户显式授权**，POLICY.md 与口径块都写明', '');
  check(/产品级\/范围级变更仍必须问/.test(noGate.block), '关闭门**不等于**可以不问产品级决策（边界写死在策略里）');
  check(/SUMMARY\.md/.test(noGate.block) && /RUN\.log\.md/.test(noGate.block), '跳过一事要求写进 SUMMARY/RUN.log（否则事后无从审计）');
  const gateOn = compilePolicy(defaultSettings());
  check(/保留/.test(gateOn.block), '默认（true）⇒ 明确写"保留"，SKILL 门禁一字不改');
  check(/生成于：/.test(gateOn.md) && /profile=developer/.test(gateOn.md), 'POLICY.md 带生成时间与 profile（可追溯）');
}

console.log('\n③ 口径块抽取（启动消息只注入块，不塞整篇文档）');
{
  const p = compilePolicy(defaultSettings());
  const block = policyBlockFrom(p.md);
  check(block.startsWith(POLICY_BLOCK_START) && block.endsWith(POLICY_BLOCK_END), '抽出的是带标记的块');
  check(block.length < p.md.length, '块比整篇短（启动消息不被文档塞满）', `${block.length} < ${p.md.length}`);
  check(policyBlockFrom('# 没有标记的文档\n') === '' && policyBlockFrom('') === '' && policyBlockFrom(null) === '', '无标记/空 ⇒ 空串（旧 run 行为与从前一致）');
  check(Object.keys(POLICY_PROFILES).length === 3, '三种身份定义在真源里', Object.keys(POLICY_PROFILES).join(','));
}

console.log('\n④ 端到端：建 run 冻结 POLICY.md + 启动消息开头就是口径块');
const root = await mkdtemp(join(tmpdir(), 'dsh-et-policy-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
await mkdir(join(process.env.DSH_HOME, 'expert-team'), { recursive: true });
await (await import('node:fs/promises')).writeFile(join(process.env.DSH_HOME, 'expert-team', 'settings.json'),
  JSON.stringify({ identity: { profile: 'non-technical', askBudget: 2 } }, null, 2));
const { apply, _live } = await import(join(here, 'lib', 'command.js'));
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });
let registered = null;
const followups = [];
apply({ commands: { register: (d) => { registered = d; } }, on: () => {}, get: () => undefined, inject: () => {} });
const res = await registered.handler({ rawInput: '做个小工具', attachments: [], agent: { session: { id: 's1', header: { cwd } }, followup: (m) => followups.push(m) } });
const run = (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)[0];
const md = await readFile(join(cwd, 'team', run, 'POLICY.md'), 'utf8');
check(/POLICY-BLOCK:START/.test(md) && /无技术经验/.test(md), 'run 目录落了 `POLICY.md` 且带口径块', String(run));
const log = await readFile(join(cwd, 'team', run, 'RUN.log.md'), 'utf8');
check(/policy:frozen/.test(log), 'RUN.log 留痕 `policy:frozen`');
check(/方案确认门保留/.test(log), '留痕里写明方案确认门的状态');
const msg = (followups[0] && followups[0].content && followups[0].content[0] && followups[0].content[0].text) || '';
check(msg.startsWith(POLICY_BLOCK_START), '启动消息**开头**就是口径块');
check(/身份＝\*\*无技术经验\*\*/.test(msg), '消息里带身份标签', (msg.match(/身份＝\*\*(.+?)\*\*/) || [])[1]);
check(/最多问 \*\*2\*\* 个问题/.test(msg), '提问预算进了启动消息');
check(/【专家团任务】目标：做个小工具/.test(msg), '原来的任务头仍在（没被策略块挤掉）');
check(/身份策略已冻结/.test(String(res.text)), '建 run 回执如实告知策略已冻结', String(res.text).slice(0, 30));

if (fail) { console.error(`\n✗ policy：${fail} 项失败`); process.exit(1); }
console.log('\n✓ policy：全部通过（三种口径 / 授权留痕 / 块抽取 / 端到端冻结）');
