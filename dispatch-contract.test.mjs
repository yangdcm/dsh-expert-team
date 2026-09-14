// 测试：派工 prompt 的「四字段契约」必须在规范层存在且**两处不漂移**
//
// 为什么是文本断言（而不是行为断言）：这四条是**提示词级**约束——它们的作用点是"编排者构造派工 prompt
// 的那一刻"，代码里没有可断言的执行点。本包对同类"规则必须真的写进 SKILL"的需求已有先例
// （`card-stall.test.mjs` 断言 SKILL 规则 26/27 在场），这里沿用同一手法，并额外做**两处一致性**：
// 规范正文（`SKILL.md` 规则 30）与模板（`references/ROLES.md`）必须同时包含四条的关键措辞 ——
// 只改一处就会出现"主协议说了、模板没给"的脱节（本包实测过这类漂移：规则只活在文档里 = 等于没有）。
//
// 依据（为什么是这四条）：Qoder 9 个真实会话 / 536 次派工 / 82 次返工的量化，
// 其中「协议往返」（成员只出方案不落地）占全部返工 **24.4%**，是并列第一大来源；
// 而 20 次假绿里 **16 次**来自真机/真实运行环境 —— 都在 `docs/Qoder对标/08-九样本返工相关性.md`。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M97**。
// 运行：node dispatch-contract.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skill = await readFile(join(here, 'skills', 'expert-team', 'SKILL.md'), 'utf8');
const roles = await readFile(join(here, 'skills', 'expert-team', 'references', 'ROLES.md'), 'utf8');

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('① SKILL.md 有规则 30（四字段契约）');
check(/^30\. \*\*每次派工必须带「四字段契约」/m.test(skill), '规则 30 在场且编号连续');

console.log('② ROLES.md 有对应模板块');
check(/## 派工 prompt 的四个必填字段/.test(roles), '模板小节在场');

console.log('③ 四条关键措辞在**两处都**必须出现（防漂移）');
const CONTRACT = [
  ['① 不要等待确认／不要只给方案', /不要等待确认|不要再问、不要只给方案/],
  ['② 交付物含构建·运行的**原始输出**', /原始输出/],
  ['③ 禁改清单', /禁改清单/],
  ['④ 代理指标必须标注「仅本地可观测」', /仅本地可观测/],
];
for (const [label, re] of CONTRACT) {
  check(re.test(skill), `${label} —— SKILL.md 有`);
  check(re.test(roles), `${label} —— ROLES.md 有`);
}
// 模板层必须给出**可直接抄进 prompt 的原话**（这正是"模板"的意义）。
// 第一版只断言了宽松的近义替换（`不要等待确认|不要再问、不要只给方案`），于是把模板正文那句删掉、
// 只留标题里的近义说法，断言仍然过 ⇒ 变异 M97 判为「未抓住」。**关键指令要按原话钉住**，
// 否则防的是不存在的漂移。
check(
  /不要等待确认，直接改文件并交付代码\/工件/.test(roles),
  '① 模板给出可直接抄进 prompt 的原话（不要等待确认，直接改文件并交付代码/工件）',
);

console.log('④ 依据必须可追溯（写清数字与出处），不能是一句空口号');
check(/24\.4%/.test(skill) || /24\.4%/.test(roles), '引用「协议往返占 24.4%」的量化依据');
check(/仅本地可观测/.test(roles) && /16 次|16次/.test(roles), 'ROLES.md 给出「16/20 次假绿来自真机」的依据');

console.log('⑤ 不把"禁改清单"夸大成已验证的防冲突手段');
check(/无相关|预防性/.test(roles) && /预防性/.test(skill), '两处都注明它只是预防性（9 样本里冲突仅 1 次且与该指标无相关）');

console.log('⑥ 审查 finding 必须先由编排者复核（规则 31）');
check(/^31\. \*\*审查\/测试的 finding 必须/m.test(skill), 'SKILL 有规则 31', '');
check(/编排者的复核义务/.test(roles), 'ROLES.md 有「编排者的复核义务」小节');
check(/未经.{0,8}复核的 finding.{0,8}不得直接派成修复任务/.test(skill), 'SKILL 写明"未经复核不得直接派修复"');
check(/未经你本人复核的 finding，不得直接派成修复任务/.test(roles), '模板同样写明（两处防漂移）');
check(/已由 lead 复核/.test(roles), '模板要求派工里带「已由 lead 复核」+ 行号 + 原文片段（不是原样转发）');
check(/无方差/.test(skill) && /无方差/.test(roles), '给出"行号引用率 0%→89% 无方差"这一关键依据（防后人又把它写成形式要求）');
check(/撤销率/.test(roles), '核对不成立的 finding 要当场撤销并计入撤销率');

if (fail) { console.error(`\n✗ dispatch-contract：${fail} 项失败`); process.exit(1); }
console.log('\n✓ dispatch-contract：全部通过');
