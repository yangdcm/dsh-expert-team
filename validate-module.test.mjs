// 测试：B 线第 8 项**第一步** —— `lib/validate.js`（校验器与上限簇）
//
// 为什么先切这一刀：`/team check` 的七类违规、DAG 三色环检测、容量/轮次上限、schema 只读校验
// 全是**纯函数**（给定输入必有确定输出、不碰盘），既是门禁的核心，也是最容易单测的部分。
// 切出来之后，`lib/interception.js` 注入的 `validateTaskGraph` 与写侧门禁继续用**同一份**实现。
//
// 本测试钉住三件事（**搬家最容易出的三类错**）：
//   ① **搬走了没接上**：`command.js` 必须真的从 `validate.js` import，且不再有第二份定义；
//   ② **兼容层破了**：`_live` 仍要暴露既有名字（测试与 `interception` 的注入都靠它，不该因搬家改一行）；
//   ③ **行为变了**：几个关键判定（重复 id / 自依赖 / 环 / 容量边界 / 轮次口径）在搬家后**逐条不变**。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M117**。
// 运行：node validate-module.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# B 线第 8 项 · validate.js 提取\n');

const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
const valSrc = await readFile(join(here, 'lib', 'validate.js'), 'utf8');
const vocabSrc = await readFile(join(here, 'lib', 'vocab.js'), 'utf8');
const { apply, _live } = await import(join(here, 'lib', 'command.js'));
const V = await import(join(here, 'lib', 'validate.js'));
const VB = await import(join(here, 'lib', 'vocab.js'));

const MOVED = ['DEFAULT_LIMITS', 'LIMITS', 'LIMIT_ENV', 'pickLimitValue', 'resolveLimits', 'capacityViolations',
  'DEFAULT_ROUND_LIMITS', 'ROUND_LIMITS', 'ROUND_LIMIT_ENV', 'resolveRoundLimits', 'ROUND_LIMIT_OF_KIND',
  'roundOf', 'isQualityTask', 'normTitle', 'findingText', 'roundLimitViolations', 'findingReopenInputMissing',
  'checkKindWarnings', 'validateTaskGraph', 'schemaViolations', 'checkTasks'];
const HELPERS = ['phaseZh', 'statusZh', 'kindZh', 'verdictZh', 'roleZh', 'modeZh', 'activityZh', 'deliverZh'];

console.log('① 搬走了没接上？（定义只许在 validate.js，command.js 必须 import）');
{
  const leftovers = MOVED.filter((n) => new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function|const|let)\\s+${n}\\b`, 'm').test(cmdSrc));
  check(leftovers.length === 0, 'command.js 里没有这 21 个符号的第二份定义', leftovers.length ? `残留：${leftovers.join(', ')}` : `21 个都只在 validate.js`);
  check(/from '\.\/validate\.js'/.test(cmdSrc), 'command.js 确实从 `./validate.js` import');
  const exported = MOVED.filter((n) => !(n in V));
  check(exported.length === 0, 'validate.js 把这些名字都导出了', exported.length ? `缺：${exported.join(', ')}` : `${MOVED.length} 个`);
  check(!/from '\.\/command\.js'/.test(valSrc), 'validate.js **不反向依赖** command.js（否则就是循环 import）');
}

console.log('\n② 兼容层：`_live` 的名字与行为不得因搬家而变');
{
  const expected = ['DEFAULT_LIMITS', 'LIMITS', 'resolveLimits', 'capacityViolations', 'DEFAULT_ROUND_LIMITS',
    'ROUND_LIMITS', 'ROUND_LIMIT_ENV', 'resolveRoundLimits', 'ROUND_LIMIT_OF_KIND', 'roundOf', 'isQualityTask',
    'normTitle', 'roundLimitViolations', 'schemaViolations'];
  const missing = expected.filter((n) => !(n in _live));
  check(missing.length === 0, '`_live` 仍暴露既有的这 14 个名字（测试与注入不必改一行）', missing.length ? `缺：${missing.join(', ')}` : `${expected.length} 个`);
  check(_live.LIMITS === V.LIMITS, '`_live.LIMITS` 与 validate.js 的 **是同一个对象**（`resolveLimits` 就地改写才可见）');
  check(_live.ROUND_LIMITS === V.ROUND_LIMITS, '`_live.ROUND_LIMITS` 同理');
}

console.log('\n③ 行为逐条不变（搬家不能顺手改口径）');
{
  const g = (tasks) => V.validateTaskGraph(tasks);
  check(g([{ id: 'A' }, { id: 'A' }]).errors.some((e) => e.code === 'duplicate-id'), '重复 id 仍被抓');
  check(g([{}]).errors.some((e) => e.code === 'missing-id'), '缺 id 仍被抓（夹具必须是**真的没有 id** 的任务）');
  check(g([{ id: 'A', dependsOn: ['A'] }]).errors.some((e) => e.code === 'self-dependency'), '自依赖仍被抓');
  check(g([{ id: 'A', dependsOn: ['NOPE'] }]).errors.some((e) => e.code === 'missing-dependency'), '悬空依赖仍被抓');
  const cyc = g([{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }]);
  check(cyc.errors.filter((e) => e.code === 'cycle').length === 1, '环只报一次（同一环不重复）');
  check(g([{ id: 'A' }, { id: 'B', dependsOn: ['A'] }]).ok === true, '合法图 ⇒ ok');

  check(V.checkTasks([{ id: 'A', dependsOn: ['A'] }], 'implement', undefined).some((s) => s.startsWith('[图结构]')), 'checkTasks 仍把图结构错误并入违规');
  check(V.roundOf({ round: 0 }) === 1 && V.roundOf({ round: 3 }) === 3 && V.roundOf({}) === 1, 'roundOf 口径不变（缺失/非法 ⇒ 1）');
  check(V.isQualityTask({ kind: 'review' }) === true && V.isQualityTask({ kind: 'work' }) === false, 'isQualityTask 口径不变');
  check(V.normTitle('  a   b  ') === 'a b', 'normTitle 仍做空白归一', V.normTitle('  a   b  '));
  check(V.pickLimitValue(null, 0) === null && V.pickLimitValue('', 0) === null && V.pickLimitValue('5', 0) === 5, 'pickLimitValue 的 `null/""` 陷阱仍被排除（不能把"未设置"当 0）');
  check(V.capacityViolations({ roles: new Array(40).fill('x'), tasks: [] }).some((v) => v.code === 'TEAM_MEMBER_LIMIT'), '容量上限仍会报 TEAM_MEMBER_LIMIT');
  check(V.checkKindWarnings([{ id: 'T1', kind: 'nope' }]).length === 1, '未知 kind ⇒ 一条告警（不阻断）');
  check(V.schemaViolations(null, null).length === 0, 'schemaViolations 对空输入返回空数组（不抛）');
}

console.log('\n④ 显示助手搬到 vocab.js（validate.js 只能从词表真源取）');
{
  const left = HELPERS.filter((n) => new RegExp(`^const\\s+${n}\\s*=`, 'm').test(cmdSrc));
  check(left.length === 0, 'command.js 里不再定义这 8 个显示助手', left.length ? `残留：${left.join(', ')}` : '');
  const missing = HELPERS.filter((n) => typeof VB[n] !== 'function');
  check(missing.length === 0, 'vocab.js 导出全部 8 个助手', missing.length ? `缺：${missing.join(', ')}` : '');
  check(VB.kindZh('work') === '任务' && VB.phaseZh('design') === '设计' && VB.verdictZh('pass') === '通过', '助手行为不变', `${VB.kindZh('work')}/${VB.phaseZh('design')}/${VB.verdictZh('pass')}`);
  check(/from '\.\/vocab\.js'/.test(valSrc), 'validate.js 从 vocab.js 取词表与助手（不自己抄一份）');
}

console.log('\n⑤ 写侧门禁仍与读侧共用**同一份**实现');
{
  // interception 的 validateTaskGraph 由 command.js 注入 —— 必须是同一个函数引用。
  let injected = null;
  apply({
    commands: { register: () => {} },
    on: (evt, fn) => { if (evt === 'tools/post-execute' && fn && fn.name === 'boundaryInterceptor') injected = fn; },
    get: () => undefined,
    inject: () => {},
  });
  check(typeof injected === 'function', '写侧拦截器已装配');
  check(/validateTaskGraph,/.test(cmdSrc), 'command.js 把 `validateTaskGraph` 注入拦截器（同一份实现，不是第二份）');
}

if (fail) { console.error(`\n✗ validate-module：${fail} 项失败`); process.exit(1); }
console.log('\n✓ validate-module：全部通过（搬走/接上/兼容/行为不变/两侧同源）');
