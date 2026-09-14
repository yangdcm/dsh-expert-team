// 测试：METRICS 渲染（B 线 10b 第一刀 · `lib/metrics/render.js`）
//
// 这是"把闭包局部变量改成数据对象"这类提取的**安全网**。原来 18 个值（E 线 E1 之后 19 个，新增 `firstRunnableLines`）都是 `aggregate` 的局部变量，
// 写错名字会当场 `ReferenceError`；现在它们是 `stats` 的字段，**写错名字静默变 `undefined`**
// 并直接印进用户看的报告 —— 所以必须有机器检查补上这层安全：
//   ① 渲染结果里不得出现 `undefined` / `NaN`（缺字段、拼错字段、算成 NaN 都会被抓住）；
//   ② 渲染模块**解构出的字段名**与**调用点传入的键**必须集合相等（源码级比对，少传/多传都红）。
// 另外钉住版面结构（小节标题、逐字的那两句口径说明），因为 METRICS 是**用户可见产物**。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M106**。
// 运行：node metrics-render.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMetrics } from './lib/metrics/render.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 一份"字段齐全"的样例（值本身不重要，重要的是每个字段都被渲染进去）。 */
const FULL = {
  iso: '2026-09-13T00:00:00.000Z',
  runCount: 3,
  skipped: 2,
  completed: 1,
  runsWithLogs: 2,
  reworkRate: 50,
  reworkRuns: 1,
  sourceLines: 'tasks:repair×1',
  reworkNatureLines: '- 返工性质分解（分母同上，**不改上面那个率**）：仅环境/平台 **0** 个 · 仅过程（质量环/角色/台账） **1** 个 · 两者都有 **1** 个 · 无返工证据 0 个',
  phaseLines: '- `implement`: 2 次',
  firstRunnableLines: '- 首个可运行产物耗时：有登记 1 / 有日志 2 个 run · 中位 8 分钟 · 最快 8 分钟 · 最慢 8 分钟（阈值 10 分钟）',
  closingBudgetLines: '- 收尾预算（代码冻结后的阶段 ≤ 实现期 × 50%）：可算 1 / 有日志 2 个 run · 超预算 0 个',
  roleLines: '- backend: pass 2 / rework 1 / fail 0',
  closureLines: '- 未终态任务（pending / claimed / in_progress / rework / blocked）：无',
  errLines: '- `error:external-write` × 1 — 样例',
  askLines: '- （无用户提问）',
  decLines: '- `decision:lead` × 1 — 样例',
  scanLines: '- `scan:single-source` × 2 — 样例',
  maxReviewRound: 3,
  maxTestRound: 3,
  revertLine: '- 撤销幻觉：2 / 5（撤销率 40% · 覆盖 1/1 个质量任务）',
};

console.log('# METRICS 渲染（纯函数）\n');

const out = renderMetrics(FULL);

console.log('① 版面结构（用户可见产物，逐条钉住）');
// 2026-09-13：`## 收尾预算` 的标题**故意带上口径边界**（实现期 = 首产物→冻结 · 收尾 = 冻结→交付）——
// 同一个真实 run 实测：把 pre-code 算进实现期会把 51% 读成 48%，跨过 50% 红线、结论翻转。
for (const h of ['# 团队指标（METRICS）', '## 总览', '## 阶段覆盖', '## 首产物（首个可运行产物耗时）', '## 收尾预算（实现期 = 首产物→冻结 · 收尾 = 冻结→交付）', '## 角色结果（pass=交付 / rework=返工件 / fail=失败）', '## 未闭环（不计入返工率，但必须可见）', '## 高频卡点（error / 返工，去重）', '## 用户高频提问（ask，去重）', '## 决策记录（decision，去重）', '## 单源化总扫（见一个，扫全部）', '## 评审效率（轮次 / 撤销率）']) {
  check(out.includes(h), `有标题：${h}`);
}

console.log('\n② 每个字段都真的被渲染进去（防"传了但没用"）');
const FIELD_PROBES = [
  ['iso', FULL.iso],
  ['runCount', '总 run 数：3'],
  ['skipped', '未计入）：2 个'],
  ['completed', '已完成：1'],
  ['runsWithLogs', '有日志的 run：2'],
  ['reworkRate', '返工/失败率：50%'],
  ['reworkRuns', '= 1/2'],
  ['sourceLines', FULL.sourceLines],
  ['reworkNatureLines', '返工性质分解'],
  ['phaseLines', FULL.phaseLines],
  ['firstRunnableLines', FULL.firstRunnableLines],
  ['closingBudgetLines', FULL.closingBudgetLines],
  ['roleLines', FULL.roleLines],
  ['closureLines', '未终态任务'],
  ['errLines', FULL.errLines],
  ['askLines', FULL.askLines],
  ['decLines', FULL.decLines],
  ['scanLines', FULL.scanLines],
  ['maxReviewRound', 'review 3 轮'],
  ['maxTestRound', 'test 3 轮'],
  ['revertLine', FULL.revertLine],
];
for (const [name, needle] of FIELD_PROBES) {
  check(out.includes(needle), `字段被渲染：${name}`, out.includes(needle) ? '' : `找不到 ${JSON.stringify(needle).slice(0, 40)}`);
}

console.log('\n③ 不得出现 undefined / NaN（闭包局部变量 → 对象之后的新风险）');
check(!/\bundefined\b/.test(out), '渲染结果里没有 undefined', (out.match(/.{0,30}undefined.{0,30}/) || [''])[0]);
check(!/\bNaN\b/.test(out), '渲染结果里没有 NaN', (out.match(/.{0,30}NaN.{0,30}/) || [''])[0]);

console.log('\n④ 逐字口径说明必须在（它们是"可审计"的载体，删了等于口径失明）');
check(out.includes('分母是「有日志的 run」而非全部 run'), '返工率的分母口径逐字在');
check(out.includes('旧实现只统计 RUN.log 的 role:result 与 error 事件') && out.includes('恒 0'), '为什么改口径的说明逐字在');
check(out.includes('不得静默省略') === false, '（说明文字本身不进产物 —— 只保留面向用户的文案）');
check(out.includes('（暂无撤销登记') === false, '本样例行不为空 ⇒ 不该出现占位句');

console.log('\n⑤ 契约：渲染模块解构的字段 == 调用点传入的键（源码级集合比对）');
{
  const renderSrc = await readFile(join(here, 'lib', 'metrics', 'render.js'), 'utf8');
  const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');

  const dst = renderSrc.match(/const\s*\{([\s\S]*?)\}\s*=\s*stats;/);
  check(!!dst, 'render.js 里有 `const {…} = stats;` 解构');
  const fields = (dst ? dst[1] : '').split(',').map((x) => x.trim()).filter(Boolean).sort();

  const at = cmdSrc.indexOf('renderMetrics({');
  check(at >= 0, 'command.js 里有 renderMetrics({…}) 调用');
  let depth = 0; let endIdx = -1;
  for (let i = cmdSrc.indexOf('{', at); i < cmdSrc.length; i += 1) {
    if (cmdSrc[i] === '{') depth += 1;
    else if (cmdSrc[i] === '}') { depth -= 1; if (depth === 0) { endIdx = i; break; } }
  }
  const callBody = cmdSrc.slice(cmdSrc.indexOf('{', at) + 1, endIdx);
  const passed = callBody.split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => l.split(':')[0].trim())
    .filter(Boolean)
    .sort();

  const missing = fields.filter((f) => !passed.includes(f));
  const extra = passed.filter((f) => !fields.includes(f));
  check(missing.length === 0, '渲染要的字段，调用点都传了', missing.length ? `缺：${missing.join(', ')}` : `${fields.length} 个字段`);
  check(extra.length === 0, '调用点没有多传没用的键', extra.length ? `多：${extra.join(', ')}` : '无多余');
}

console.log('\n⑥ 空值边界：占位句与"零"必须区分（SG-4 的教训）');
{
  const zero = renderMetrics({ ...FULL, revertLine: '- （暂无撤销登记：质量任务 findings 未标记 reverted）' });
  check(zero.includes('（暂无撤销登记'), '撤销登记为空时渲染占位句（不静默省略）');
  const noPhase = renderMetrics({ ...FULL, phaseLines: '- （日志里暂无 phase 事件）' });
  check(noPhase.includes('（日志里暂无 phase 事件）'), '无阶段事件时渲染占位句');
}

if (fail) { console.error(`\n✗ metrics-render：${fail} 项失败`); process.exit(1); }
console.log('\n✓ metrics-render：全部通过');
