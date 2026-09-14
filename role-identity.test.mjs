// 测试：角色身份必须写在 prompt 的**最前面**、用**中文标签**、且**不重复身份**
// （否则用户在 dsh 子代理列表里既看不出是谁，也看不到任务）
//
// 用户两轮报障（截图）：
//   ① 2026-09-11 早：模板把角色写在句子中段 ⇒ 预览被截成 `（r` / `（arch` / `【rese` 碎片
//      （原话「没有显示具体角色」）。修法：标签前置到第 0 位。
//   ② 2026-09-11 晚：前置成 `【pm】你是「专家团」中的产品经理（pm，可继续 · 当前…` 之后，
//      【】里已经有身份、后面又强调一遍，且带英文 role id ⇒ 预览预算（≈28 显示宽度）被身份占满，
//      任务本身看不见（原话「【】里面已经有身份了 后面就不用强调身份了 另外用中文 不要使用英文」）。
//      修法：prompt 与派工 label 统一 `【<中文角色>】<中文任务>`。
//
// 中文标签由**精确表**解析（host `ROLE_LABELS_ZH` / client `roleFromText`）：`【产品经理】` ≡ `pm`。
// 为什么必须精确表而不是只靠关键词：关键词"按表序先命中先赢"，`【产品经理】产品分析员协作`
// 会被猜成 `product-analyst`、`【审查官】测试用例复核` 会被猜成 `qa`。
//
// 变异验证：M24（标签写回句中）/ M25（解析器不认中文标签）/ M42（精确表缺项 ⇒ 退回关键词误判）
// 运行：node role-identity.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const here = dirname(fileURLToPath(import.meta.url));
const { roleOfSub } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 规范中文标签 ↔ 角色 id（与 ROLES.md 对照表、两份解析器的表必须一致） */
const ZH = [
  ['产品经理', 'pm'], ['架构师', 'architect'], ['研究员', 'researcher'], ['UI 设计师', 'ui'],
  ['后端工程师', 'backend'], ['前端工程师', 'frontend'], ['数据工程师', 'dba'], ['安全审计员', 'sec'],
  ['审查官', 'reviewer'], ['测试员', 'qa'], ['运维', 'devops'], ['文档工程师', 'docs'],
  ['竞品分析师', 'competitive-analyst'], ['产品分析员', 'product-analyst'],
];

// 与 dsh 预览一致的显示宽度估算：CJK 记 2，其余记 1
const BUDGET = 28;
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFF60\u3000-\u303F]/.test(ch) ? 2 : 1;
  return w;
}
/** dsh 列表副标题 = 子会话首条消息按显示宽度截断后的前缀 */
function preview(prompt, budget) {
  let w = 0, out = '';
  for (const ch of String(prompt)) {
    const c = displayWidth(ch);
    if (w + c > (budget || BUDGET)) break;
    w += c; out += ch;
  }
  return out;
}

console.log('# 角色身份：中文标签前置 + 不重复身份 + 截断预览可见\n');

console.log('① 14 个规范中文标签都能解析（【】/[]/（）三种括号形态）');
{
  for (const [zh, role] of ZH) {
    const a = roleOfSub({ id: 'x'.repeat(36), label: `【${zh}】某任务` });
    const b = roleOfSub({ id: 'x'.repeat(36), label: `[${zh}] 某任务` });
    const c = roleOfSub({ id: 'x'.repeat(36), label: `（${zh}，可继续）` });
    check(a === role && b === role && c === role, `【${zh}】→ ${role}`, `${a}/${b}/${c}`);
  }
}

console.log('\n② 显式中文标签必须**胜过关键词猜测**（这才是精确表的存在意义）');
{
  check(roleOfSub({ id: 'x', label: '【产品经理】产品分析员协作' }) === 'pm', '【产品经理】 胜关键词「产品分析」→product-analyst', String(roleOfSub({ id: 'x', label: '【产品经理】产品分析员协作' })));
  check(roleOfSub({ id: 'x', label: '【审查官】测试用例复核' }) === 'reviewer', '【审查官】 胜关键词「测试」→qa', String(roleOfSub({ id: 'x', label: '【审查官】测试用例复核' })));
  check(roleOfSub({ id: 'x', label: '【研究员】竞品调研' }) === 'researcher', '【研究员】 胜关键词「竞品」→competitive-analyst', String(roleOfSub({ id: 'x', label: '【研究员】竞品调研' })));
}

console.log('\n③ 向后兼容：英文 id 括号写法仍认；自由散文里的括号仍不得误判');
{
  check(roleOfSub({ id: 'x', label: '【researcher】你是…' }) === 'researcher', '【researcher】（历史写法）');
  check(roleOfSub({ id: 'x', label: '（researcher，可继续）' }) === 'researcher', '（researcher，…）（历史写法）');
  check(roleOfSub({ id: 'x', label: '（non-experimental）不是角色' }) === '', '自由散文括号不得误判');
  check(roleOfSub({ id: 'x', label: '（url）字段' }) === '', '（url）不得误判');
}

console.log('\n④ 模板 ROLES.md：前缀是【中文标签】且不再重复身份');
{
  const md = await readFile(join(here, 'skills/expert-team/references/ROLES.md'), 'utf8');
  check(/^【\{\{role-zh\}\}】/m.test(md), '通用前缀以 【{{role-zh}}】 开头（行首）');
  check(!/^【\{\{role-zh\}\}】你是「专家团」中的角色/m.test(md), '不再重复身份句「你是「专家团」中的角色」');
  const rows = ZH.filter(([zh]) => new RegExp(`\\| \`?[a-z-]+\`? \\| ${zh.replace(/ /g, ' ')} \\|`).test(md) || md.includes(`| ${zh} |`));
  check(rows.length === ZH.length, '对照表列出全部 14 个标签', `${rows.length}/${ZH.length}`);
  // 角色段落开场句不得再写「你是<身份>。」
  const openers = [...md.matchAll(/^你是[^\n]{0,20}。/gm)].map((m) => m[0]);
  check(openers.length === 0, '各角色段落开场句已去掉重复身份（`你是…。`）', openers.join(' / '));
}

console.log('\n⑤ 模板 workflow.team.js：每个 leg 以【中文标签】开头');
{
  const js = await readFile(join(here, 'skills/expert-team/references/workflow.team.js'), 'utf8');
  const opens = [...js.matchAll(/`([^`\n]{0,40})/g)].map((x) => x[1]).filter((s) => /你是|【/.test(s));
  const zhs = ZH.map(([zh]) => zh);
  const tagged = opens.filter((s) => /^【[^】]{2,8}】/.test(s) && zhs.includes(s.slice(1, s.indexOf('】'))));
  check(opens.length >= 6, '找到全部 leg prompt 开头', String(opens.length));
  check(tagged.length === opens.length, '每个 leg 开头都是【中文标签】', `${tagged.length}/${opens.length}`);
  check(!/【[a-z][a-z0-9-]*】/.test(js), 'leg 里不再出现英文 【role】 标签');
}

console.log('\n⑥ 关键断言：28 显示宽度预览里标签完整可见，且还能露出任务');
{
  for (const [zh] of ZH) {
    const prompt = `【${zh}】目标：起草开店 PRD 与验收标准`;
    const p = preview(prompt);
    check(p.startsWith(`【${zh}】`), `【${zh}】 完整可见`, p);
    check(displayWidth(`【${zh}】`) <= BUDGET, `【${zh}】 不超预算（${displayWidth(`【${zh}】`)}/${BUDGET}）`);
  }
  const p1 = preview('【产品经理】目标：起草开店 PRD 与验收标准');
  check(p1.includes('目标'), '标签之后还能看到任务开头', p1);
  // 反例：报障② 的写法，身份把预算占满、任务看不见（证明这个测试不是空的）
  const p2 = preview('【pm】你是「专家团」中的产品经理（pm，可继续 · 当前未运行）');
  check(!p2.includes('目标') && p2.indexOf('【pm】') === 0, '报障② 写法：任务被身份挤掉（复现）', p2);
}

console.log('\n⑦ 端到端：用「截断后的预览」也必须能认出角色');
{
  for (const [zh, role] of ZH) {
    const p = preview(`【${zh}】目标：起草开店 PRD 与验收标准`);
    check(roleOfSub({ id: 'x', label: p }) === role, `预览「${p}」→ ${role}`, String(roleOfSub({ id: 'x', label: p })));
  }
}

console.log('');
if (fail > 0) {
  console.log(`✗ 角色身份测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 角色身份测试通过（中文标签前置、不重复身份、截断预览仍看得见、三种括号写法都能解析）');
