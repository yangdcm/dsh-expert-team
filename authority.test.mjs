// 测试：设计稿 §十二 第 2 步 —— **工件单源化**
//   · host 侧：`AUTHORITY.md` 权威表校验（列数/文件真实/写者唯一/类别唯一/核心工件纳入治理/示例未替换）
//   · skill 侧：`scan-authority.mjs` 分叉检测（对每行声明的事实扫全部权威文件）
//
// 依据（真实数据）：某真实 run 的 14 条返工里 **9 条（64%）** 命中「同一事实多份拷贝 / 多写者 / 口径漂移」，
// 其中 T29 的原文是「CONTRACT 单写者收口（**并发事故收敛** + 6 处已核实缺陷）」——**事故发生了才去收口**。
//
// 两处刻意的设计取舍，本测试都钉住：
//   ① **只在 `AUTHORITY.md` 存在时校验** —— 老 run 没有这个文件，一律报「缺声明」＝满屏假阳性
//      （本仓教训：假阳性会让门禁被整体忽略）。"删掉文件以逃避校验"是**已知缺口**，不假装它不存在。
//   ② **原样交模板必须被判出来**（示例行未替换）—— 否则"把模板原封不动交上去"就能混过校验。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M128 / M129**。
// 运行：node authority.test.mjs

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAuthorityRows, authorityFileName, authorityViolations, AUTHORITY_CORE_FILES, SINGLE_SOURCE_WORDS, isSingleSourceRework, singleSourceShare } from './lib/validate.js';
import { authorityFacts, divergenceFor } from './skills/expert-team/scripts/scan-authority.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# 设计稿 §十二 第 2 步 · 工件单源化\n');

const HEAD = '| 事实类别 | 唯一权威文件 | 唯一写者 | 其他文件的允许形态 |\n|---|---|---|---|';
const row = (c, f, w, a = '只许引用') => `| ${c} | ${f} | ${w} | ${a} |`;

console.log('① 解析：表头/分隔行/空行不算数据行；不完整的行列进 malformed');
{
  const t = [HEAD, row('术语', 'SPEC.md §术语表', 'pm'), '|  |  |  |  |', '| 只填了一条 |', '|---|', '', '正文不算行'].join('\n');
  const { rows, malformed } = parseAuthorityRows(t);
  check(rows.length === 1 && rows[0].category === '术语' && rows[0].writer === 'pm', '表头/分隔/空行都被跳过，只剩 1 条真声明', `${rows.length} 条`);
  check(rows[0].line === 3, '行号是原文行号（便于定位）', String(rows[0].line));
  check(malformed.length === 1 && malformed[0].line === 5, '列数不足的行进 malformed（`|---|` 这种分隔行不算；行号是原文行号）', JSON.stringify(malformed));
  check(authorityFileName('SPEC.md §术语表') === 'SPEC.md' && authorityFileName('`CONTRACT.md`') === 'CONTRACT.md', '从单元格里取出文件名（容忍小节/反引号）');
  check(authorityFileName('见上面的表') === '', '读不出文件名 ⇒ 空串（由调用方报违规）');
}

console.log('\n② host 侧校验：六类违规 + 一条「不误报」');
{
  const ok = [HEAD, row('术语与中英口径', 'SPEC.md §术语表', 'pm')].join('\n');
  check(authorityViolations({ authorityText: ok, presentFiles: ['SPEC.md'], knownRoles: ['pm'] }).length === 0, '规范表 ⇒ 零违规（不误报）');
  check(authorityViolations({ authorityText: '', presentFiles: ['SPEC.md'], knownRoles: ['pm'] }).length === 0,
    '**没有 AUTHORITY.md ⇒ 不判**（老 run 不该被满屏报"缺声明"）');
  const emptyTable = authorityViolations({ authorityText: HEAD, presentFiles: ['SPEC.md'], knownRoles: ['pm'] });
  // 空表会同时触发两条：① 没有任何声明；② SPEec 存在却没被纳入治理 —— 两条都对，别把期望写成 1。
  check(emptyTable.some((v) => /一条有效声明都没有/.test(v)) && emptyTable.some((v) => /没有出现在权威表/.test(v)),
    '空表（只有表头）⇒ 同时报「零声明」与「核心工件未治理」', String(emptyTable.length));

  const example = authorityViolations({ authorityText: [HEAD, row('（示例·写你的第一条）术语', 'SPEC.md', 'pm')].join('\n'), presentFiles: ['SPEC.md'], knownRoles: ['pm'] });
  check(example.length === 1 && /模板里的示例行/.test(example[0]), '**原样交模板 ⇒ 被判出"示例行未替换"**（否则照抄就能混过）');

  const v1 = authorityViolations({ authorityText: [HEAD, row('术语', 'NOPE.md', 'pm')].join('\n'), presentFiles: ['SPEC.md'], knownRoles: ['pm'] });
  check(v1.some((v) => /没有这个文件/.test(v)), '声明了不存在的权威文件 ⇒ 违规', v1[0]);

  const v2 = authorityViolations({ authorityText: [HEAD, row('术语', 'SPEC.md', '隔壁老王')].join('\n'), presentFiles: ['SPEC.md'], knownRoles: ['pm', 'architect'] });
  check(v2.some((v) => /不是编制里的角色/.test(v)), '写者不是编制角色 ⇒ 违规', v2[0]);

  const v3 = authorityViolations({
    authorityText: [HEAD, row('拒绝码', 'CONTRACT.md §4.4', 'architect'), row('拒绝码补充', 'CONTRACT.md §4.5', 'pm')].join('\n'),
    presentFiles: ['CONTRACT.md'], knownRoles: ['pm', 'architect'] });
  check(v3.some((v) => /2 个写者/.test(v)), '**同一权威文件两个写者 ⇒ 违规**（这正是并发事故的形状）', v3[0]);

  const v4 = authorityViolations({
    authorityText: [HEAD, row('术语', 'SPEC.md', 'pm'), row('术语', 'CONTRACT.md', 'pm')].join('\n'),
    presentFiles: ['SPEC.md', 'CONTRACT.md'], knownRoles: ['pm'] });
  check(v4.some((v) => /指向了 \*\*2 个不同的权威文件\*\*/.test(v)), '同一事实类别指向两个权威 ⇒ 违规（权威必须唯一）');

  const v5 = authorityViolations({ authorityText: [HEAD, row('术语', 'SPEC.md', 'pm')].join('\n'), presentFiles: ['SPEC.md', 'PRD.md'], knownRoles: ['pm'] });
  check(v5.some((v) => /PRD\.md.*没有出现在权威表/.test(v)), '存在的核心工件没被纳入治理 ⇒ 违规', v5[0]);
  check(AUTHORITY_CORE_FILES.includes('CONTRACT.md') && AUTHORITY_CORE_FILES.includes('PRD.md'), '核心工件清单含 CONTRACT / PRD', AUTHORITY_CORE_FILES.join(','));
  const v6 = authorityViolations({ authorityText: [HEAD, '| 只填了一列 |'].join('\n'), presentFiles: ['SPEC.md'], knownRoles: ['pm'] });
  check(v6.some((v) => /列数\/内容不完整/.test(v)), '列数不完整 ⇒ 违规', v6[0]);
}

console.log('\n③ skill 侧：从表里提取事实 + 分叉判定');
{
  const t = [HEAD, row('变现体系', 'SPEC.md', 'pm'), row('（示例·写你的第一条）术语', 'SPEC.md', 'pm'), row('拒绝码', 'CONTRACT.md §4.4', 'architect')].join('\n');
  const facts = authorityFacts(t);
  check(facts.length === 2, '提取 2 条真声明（**跳过示例行**）', facts.map((f) => f.fact).join(','));
  check(facts[0].fact === '变现体系' && facts[0].file === 'SPEC.md' && facts[1].file === 'CONTRACT.md', '第 1、2 列都取到（文件从 `§` 前面取）', JSON.stringify(facts));

  // 端到端：同一事实在两个权威文件里各有定义 ⇒ 分叉
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auth-'));
  await writeFile(join(dir, 'AUTHORITY.md'), t);
  await writeFile(join(dir, 'SPEC.md'), '# SPEC\n\n## 变现体系\n\n定义在这。\n\n拒绝码见 CONTRACT。\n');
  await writeFile(join(dir, 'CONTRACT.md'), '# CONTRACT\n\n## 变现体系\n\n又定义了一遍（分叉）。\n\n## 拒绝码\n\n词表。\n');
  // 语义：权威文件本来就该定义它 ⇒ 违规是"**权威之外**还有定义"（第一版我搞反了，被这条断言抓住）
  const d1 = await divergenceFor({ runDir: dir, fact: '变现体系', authorityFile: 'SPEC.md' });
  check(d1.divergent === true && d1.defsInAuthority.length === 1 && d1.defsElsewhere.length === 1,
    '**权威(SPEC)之外还有人定义(CONTRACT) ⇒ 判分叉**，且两侧分开报', `权威内 ${d1.defsInAuthority.length} / 权威外 ${d1.defsElsewhere.length}`);
  const d2 = await divergenceFor({ runDir: dir, fact: '只有引用没有定义的事实', authorityFile: 'SPEC.md' });
  check(d2.divergent === false && d2.defsElsewhere.length === 0, '只在别处被提到、没有定义 ⇒ 不算分叉（不误报）');
  const d3 = await divergenceFor({ runDir: dir, fact: '拒绝码', authorityFile: 'CONTRACT.md' });
  check(d3.divergent === false && d3.defsInAuthority.length === 1, '只在**自己的**权威文件里定义 ⇒ 不算分叉（不误报）');
}

console.log('\n④ 退出码三态（0 无分叉 / 1 有分叉 / 2 用法或输入错）');
{
  const script = join(here, 'skills', 'expert-team', 'scripts', 'scan-authority.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auth2-'));
  await writeFile(join(dir, 'AUTHORITY.md'), [HEAD, row('变现体系', 'SPEC.md', 'pm')].join('\n'));
  await writeFile(join(dir, 'SPEC.md'), '# SPEC\n\n## 变现体系\n\n定义。\n');
  const noDiv = spawnSync('node', [script, dir], { encoding: 'utf8' });
  check(noDiv.status === 0, '无分叉 ⇒ 退出码 0', `status=${noDiv.status}`);
  await writeFile(join(dir, 'CONTRACT.md'), '# CONTRACT\n\n## 变现体系\n\n又一遍。\n');
  const div = spawnSync('node', [script, dir], { encoding: 'utf8' });
  check(div.status === 1, '有分叉 ⇒ 退出码 1（可被 CI/门禁直接判）', `status=${div.status}`);
  check(/分叉 1 条/.test(div.stdout), '报告里写明分叉条数', (div.stdout.match(/分叉 \d+ 条/) || [''])[0]);
  const usage = spawnSync('node', [script], { encoding: 'utf8' });
  check(usage.status === 2, '缺参数 ⇒ 退出码 2', `status=${usage.status}`);
  const noAuth = spawnSync('node', [script, await mkdtemp(join(tmpdir(), 'dsh-empty-'))], { encoding: 'utf8' });
  check(noAuth.status === 2 && /读不到/.test(noAuth.stderr), '没有 AUTHORITY.md ⇒ 退出码 2 且说明原因', `status=${noAuth.status}`);
}

console.log('\n⑤ 接线：模板随 run 下发 + `/team check` 真会报');
{
  const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
  const tpl = await readFile(join(here, 'skills', 'expert-team', 'assets', 'templates', 'AUTHORITY.md'), 'utf8');
  // 2026-09-15：模板清单提升为**模块级单一真源** `ARTIFACT_TEMPLATES`（建 run 与 R1 绕过检测共用），
  // 因此这里改为**读那份真源**（继续按源码字面量解析会在重构后误报 —— 这次就是）。
  const { ARTIFACT_TEMPLATES } = await import(join(here, 'lib', 'command.js'));
  check(Array.isArray(ARTIFACT_TEMPLATES) && ARTIFACT_TEMPLATES.includes('AUTHORITY.md'), '`AUTHORITY.md` 在 run 模板清单里（每个新 run 都有）', JSON.stringify(ARTIFACT_TEMPLATES));
  check(/const templates = ARTIFACT_TEMPLATES;/.test(cmdSrc), '建 run 的复制逻辑用的是那份真源（不是另抄一份清单）', '');
  check(/authorityViolations\(\{ authorityText: authText/.test(cmdSrc), '`/team check` 调用权威表校验');
  check(/只在 `AUTHORITY\.md` 存在时/.test(cmdSrc), '注释里写明了"只在存在时校验"这个取舍');
  check(/示例/.test(tpl) && /\| 事实类别 \| 唯一权威文件 \| 唯一写者 \|/.test(tpl), '模板带表头与示例行（且示例行会被校验判出来）');
  const { _live } = await import(join(here, 'lib', 'command.js'));
  check(typeof _live.authorityViolations === 'function', '`_live` 暴露 `authorityViolations`（可测）');
}

console.log('\n⑥ 验收指标：返工里「单源化类」占比（§十二 的验收尺子）');
{
  check(SINGLE_SOURCE_WORDS.includes('单源化') && SINGLE_SOURCE_WORDS.includes('单写者'), '关键词表与 SKILL 规则 34/35 的用语一致', SINGLE_SOURCE_WORDS.join('/'));
  const tasks = [
    { id: 'T1', kind: 'repair', title: 'CONTRACT 单写者收口（并发事故收敛）' },
    { id: 'T2', kind: 'repair', title: '门禁补 N5（开关数量）' },
    { id: 'T3', kind: 'repair', title: '口径逐值一致收口' },
    { id: 'T4', kind: 'work', title: '单源化相关的实现任务' },
  ];
  const r = singleSourceShare(tasks);
  check(r.repairs === 3 && r.singleSource === 2, '**只数 `kind=repair`**（`work` 里的词不算）', JSON.stringify(r));
  check(Math.abs(r.share - 2 / 3) < 1e-9, '占比 = 2/3', String(r.share));
  check(singleSourceShare([{ kind: 'work' }]).share === null, '**没有返工 ⇒ `null`，不是 0**（0% 会被误读成"很干净"）');
  check(singleSourceShare([]).share === null && singleSourceShare(null).repairs === 0, '空/非法输入不抛');
  check(isSingleSourceRework({ title: 'x', summary: '含漂移' }) === true && isSingleSourceRework({ title: '普通修复' }) === false, '标题/摘要都参与判定');
}


if (fail) { console.error(`\n✗ authority：${fail} 项失败`); process.exit(1); }
console.log('\n✓ authority：全部通过（六类违规 / 不误报 / 分叉检测 / 退出码三态 / 接线）');
