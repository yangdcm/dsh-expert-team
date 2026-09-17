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

  // ── M163 的能红断言：新模板表头**不得**被 `authorityFacts` 当成一条「幻影事实」 ────────────
  // 实测过的事故形态：表头改成「事实」后，`authorityFacts` 只跳过 `/^事实类别$/` ⇒ 产生
  // `{fact:'事实', file:''}` ⇒ `scannedFacts`/`codePointerFacts` 各多 1，且 `事实` 是**极常见子串**
  // ⇒ 只要 run 里别的文件有一行"定义式形状且含 `事实`"就**假分叉 EXIT=1**。
  // 判据与 `lib/validate.js` 的 `parseAuthorityRows` **同一条规则**（用列标签判表头）。
  const NEW_HEAD = '| 事实 | 唯一权威文件 | 唯一写者 | 其他文件的允许形态 |\n|---|---|---|---|';
  check(authorityFacts(NEW_HEAD).length === 0, '**新模板表头不产生任何事实**（M163 的能红断言：表头不是声明）', JSON.stringify(authorityFacts(NEW_HEAD)));
  // 反向对照：真实数据行**仍须**被提取（证明只是"不把表头当数据"，没有放宽/收紧数据行判据）
  check(
    authorityFacts(`${NEW_HEAD}\n${row('变现体系', 'SPEC.md', 'pm')}`).length === 1,
    '反向对照：新表头之下的**真实数据行仍被提取**（1 条，没被一起吞掉）',
    JSON.stringify(authorityFacts(`${NEW_HEAD}\n${row('变现体系', 'SPEC.md', 'pm')}`)),
  );
  // 反向对照 2：事实名**恰好叫「事实」**的数据行不被吞掉（这正是"用列标签判表头"而非"用第 1 列措辞判"的理由）
  check(
    authorityFacts(`${HEAD}\n${row('事实', 'SPEC.md', 'pm')}`).length === 1,
    '事实名恰好为「事实」的数据行**仍被提取**（列标签判表头的守卫）',
    JSON.stringify(authorityFacts(`${HEAD}\n${row('事实', 'SPEC.md', 'pm')}`)),
  );

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

console.log('\n③b `BL-12` / `BL-13` 端到端：台账行的逐字引用不得造分叉；引用语境不得算定义');
{
  // 三个夹具共用一个形状：`AUTHORITY.md` 声明 1 条 `变现体系` → `SPEC.md`，且 `SPEC.md` 里**确有**
  // 一处权威内定义（`## 变现体系`）；差别只在**非权威文件 `OTHER.md` 里那一行怎么写**。
  // 判据是 `divergent`（= 权威文件之外还有没有"定义"）⇒ 由 `definitionKind()` 的 D1/D2 决定。
  const mkFixture = async (otherLine) => {
    const d = await mkdtemp(join(tmpdir(), 'dsh-auth-bl13-'));
    await writeFile(join(d, 'AUTHORITY.md'), [HEAD, row('变现体系', 'SPEC.md', 'pm')].join('\n'));
    await writeFile(join(d, 'SPEC.md'), '# SPEC\n\n## 变现体系\n\n定义在这。\n');
    await writeFile(join(d, 'OTHER.md'), `# 别的文件\n\n${otherLine}\n`);
    return divergenceFor({ runDir: d, fact: '变现体系', authorityFile: 'SPEC.md' });
  };

  // 夹具 C（断言 #4）：3 列台账行的**逐字引用** ⇒ 由 **D1 的列数判据**排除（FM-2 方向）
  const c = await mkFixture('| 变现体系 | 说明 | 台账行 |');
  check(c.divergent === false && c.defsInAuthority.length >= 1,
    '**3 列台账行的逐字引用**（非权威文件）⇒ 不得报分叉（`BL-13` 负对照 · 由 D1 负责）',
    `权威内 ${c.defsInAuthority.length} / 权威外 ${c.defsElsewhere.length}`);

  // 断言 #5：散文里提到（无定义式）⇒ 本来就不算定义（回退保护，不是新增覆盖）
  const p = await mkFixture('正文提到 变现体系 但这里没有定义式。');
  check(p.divergent === false && p.defsElsewhere.length === 0,
    '散文里提到事实名（无定义式）⇒ 不算分叉（回退保护）');

  // 夹具 E（断言 #7）：**块引用**里的 `zh-quoted` 定义行 ⇒ **只有 D2 能挡**。
  // 为什么这条是 D2 的真·独立证据：`zh-quoted` 的正则 `[「『]<事实名>[」』]\s*[:：]` **不锚行首**
  // ⇒ `>` 开头的行照样命中，D1 的列数判据对它**没有任何作用** ⇒ 唯一能挡下它的是 D2 规则②（行首 `>`）。
  const e = await mkFixture('> 「变现体系」：指三大域');
  check(e.divergent === false && e.defsElsewhere.length === 0,
    '**块引用里的 `zh-quoted` 定义行 ⇒ 引用语境，不得造分叉**（`BL-13` 独立负对照 · **D2 专属**）',
    `权威外 ${e.defsElsewhere.length}`);

  // 反向对照（同一夹具形状、只把引用标记去掉）：没有 `>` 的同一行**仍是定义** ⇒ 证明上面的 `false`
  // 不是"这一行本来就不算定义"造成的空断言（**没有对照的"不报"等于没测**）。
  const pos = await mkFixture('「变现体系」：指三大域');
  check(pos.divergent === true && pos.defsElsewhere.length === 1,
    '反向对照：**去掉行首 `>`** 的同一行 ⇒ 仍判分叉（证明上一条的 `false` 真的是 D2 挡下的）',
    `权威外 ${pos.defsElsewhere.length}`);
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
  // R8「文本锁死旧值 ⇒ 同步断言且**保持其可红性**」：Batch 3 把模板表头从「事实类别」改成「事实」
  // （D3 的根因就是旧表头诱导人把**类别标签**写进第 1 列）⇒ 这条文本断言同批跟进。
  // 仍然要求：① 有表头；② 含「示例」二字（示例行会被 `authorityViolations` 单独判出来）。
  check(/示例/.test(tpl) && /\| 事实 \| 唯一权威文件 \| 唯一写者 \|/.test(tpl), '模板带表头（新表头「事实」）与示例行（且示例行会被校验判出来）');
  check(!/\| 事实类别 \| 唯一权威文件 \|/.test(tpl), '模板**不再**用旧表头「事实类别」（否则第 1 列继续被诱导写成类别标签）');
  const { _live } = await import(join(here, 'lib', 'command.js'));
  check(typeof _live.authorityViolations === 'function', '`_live` 暴露 `authorityViolations`（可测）');

  // ── M162 的能红断言：**模板的新表头必须被 host 侧认作「表头」** ─────────────────────
  // 报文 = 模板自己的表头行 + 分隔行 + 一行合法数据，期望**零违规**。
  // 为什么这条必须有：新表头「事实」不再是旧的 `/^事实类别$/` ⇒ 若 host 侧的表头判定不改，
  // 表头行会被当成数据行（category=`事实` / file=`唯一权威文件` / writer=`唯一写者`）⇒ **两条假违规**；
  // 而模板表头会被**每个新 run 原样保留** ⇒ 那是恒定假阳性（本仓已登记：假阳性洪峰会让人整体忽略门禁）。
  // M162 把跳过条件退回「只认旧表头」⇒ 本条必红（**不是**恒真化、也不是只断言"不抛错"）。
  const tplViol = authorityViolations({
    authorityText: ['| 事实 | 唯一权威文件 | 唯一写者 | 其他文件的允许形态 |', '|---|---|---|---|', row('变现体系', 'SPEC.md', 'pm')].join('\n'),
    presentFiles: ['SPEC.md'],
    knownRoles: ['pm'],
  });
  check(tplViol.length === 0, '**模板新表头（「事实」）必须被 host 侧认作表头 ⇒ 零违规**（M162 的能红断言）', JSON.stringify(tplViol));
  // 反向对照：**旧表头仍须被认作表头**（向后兼容 —— 存量 run 的 AUTHORITY.md 不因本批多出违规）。
  const oldHdrViol = authorityViolations({
    authorityText: [HEAD, row('变现体系', 'SPEC.md', 'pm')].join('\n'),
    presentFiles: ['SPEC.md'],
    knownRoles: ['pm'],
  });
  check(oldHdrViol.length === 0, '反向对照：**旧表头「事实类别」仍被认作表头**（存量 run 不因本批多出违规）', JSON.stringify(oldHdrViol));
  // 反向对照 2：**真实数据行不得被表头判据吞掉** —— 事实名恰好叫「事实」时，它仍是一条数据行。
  // （这正是"不要用第 1 列措辞判表头"的理由：`/^(?:事实类别|事实)$/` 会把这一行静默吞掉。）
  const factNamedViol = authorityViolations({
    authorityText: [HEAD, row('事实', 'SPEC.md', 'pm')].join('\n'),
    presentFiles: ['SPEC.md'],
    knownRoles: ['pm'],
  });
  check(factNamedViol.length === 0, '事实名恰好为「事实」的数据行**不被吞掉**（列标签判表头的守卫：吞掉就等于少校验一行）', JSON.stringify(factNamedViol));
  const parsedFactNamed = parseAuthorityRows([HEAD, row('事实', 'SPEC.md', 'pm')].join('\n'));
  check(parsedFactNamed.rows.length === 1 && parsedFactNamed.rows[0].category === '事实', '且它确实被解析成**一条数据行**（category=`事实`）', JSON.stringify(parsedFactNamed.rows.map((r) => r.category)));
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


console.log('\n⑦ G1 反空转（BL-4）：全体 0/0 ⇒ fail-closed（独立退出码 3）+ 覆盖率无条件可见');
{
  // 为什么是**全体**判据而不是"每条都必须命中"：本文件 ③ 里那条「只在别处被提到、没有定义 ⇒ 不算分叉
  // （**不误报**）」构造的正是 `defsInAuthority === 0 ∧ defsElsewhere === 0` 的事实 —— 任何"逐条
  // fail-closed"都会当场打破它。所以 guard 只在**全体**都没咬合上时触发（`matchedFacts === 0`）。
  const script = join(here, 'skills', 'expert-team', 'scripts', 'scan-authority.mjs');
  const HEAD7 = '| 事实类别 | 唯一权威文件 | 唯一写者 | 其他文件的允许形态 |\n|---|---|---|---|';
  const row7 = (c, f) => `| ${c} | ${f} | pm | 只许引用 |`;

  // ① 0 命中夹具：两条事实的权威文件都在，但里面**一处定义式都没有**
  const zero = await mkdtemp(join(tmpdir(), 'dsh-auth-zero-'));
  await writeFile(join(zero, 'AUTHORITY.md'), [HEAD7, row7('变现体系', 'SPEC.md'), row7('拒绝码真源', 'CONTRACT.md')].join('\n'));
  await writeFile(join(zero, 'SPEC.md'), '# SPEC\n\n## 别的章节\n\n变现体系见代码。\n');
  await writeFile(join(zero, 'CONTRACT.md'), '# CONTRACT\n\n## 别的章节\n\n见代码。\n');
  const r0 = spawnSync('node', [script, zero], { encoding: 'utf8' });
  check(r0.status === 3, '**全体 0/0 ⇒ 退出码 3**（fail-closed；既不是 0 也不是 1/2）', `status=${r0.status}`);
  check(/事实名与定义语法不咬合/.test(r0.stdout), '人类可读输出报「事实名与定义语法不咬合」', (r0.stdout.match(/- ⚠️ \*\*事实名[^\n]*/) || [''])[0].slice(0, 60));
  // 覆盖率**人类可读行逐字**（冻结契约 `coverageVisibility.humanReadableLine`，且**无条件**打印）
  check(
    /- 声明 2 条 · 命中 0 条 · 未咬合 2 条 · 指向代码 0 条（覆盖率可见，不计入退出码）/.test(r0.stdout),
    '覆盖率行**逐字**符合冻结契约的 `humanReadableLine`',
    (r0.stdout.match(/- 声明 \d+ 条[^\n]*/) || [''])[0],
  );

  // ② --json：新键 + **覆盖率六个计数**（绿也要自带"命中 M/N"的自我暴露）
  const j0 = JSON.parse(spawnSync('node', [script, zero, '--json'], { encoding: 'utf8' }).stdout);
  check(j0.matchedFacts === 0 && typeof j0.unmatchedError === 'string', '`--json` 有 `matchedFacts` 与 `unmatchedError`', `matchedFacts=${j0.matchedFacts}`);
  check(
    j0.scannedFacts === 2 && j0.unmatchedFacts === 2 && j0.codePointerFacts === 0 && j0.defsElsewhereTotal === 0
      && j0.matchedFacts + j0.unmatchedFacts === j0.scannedFacts,
    '`--json` 覆盖率键自洽（scanned = matched + unmatched；且 guard 的两个条件都是 0）',
    JSON.stringify({ scannedFacts: j0.scannedFacts, matchedFacts: j0.matchedFacts, unmatchedFacts: j0.unmatchedFacts, codePointerFacts: j0.codePointerFacts, defsElsewhereTotal: j0.defsElsewhereTotal }),
  );
  check(
    Object.keys(j0).sort().join(',') === 'codePointerFacts,defsElsewhereTotal,files,matchedFacts,rows,runDir,scannedFacts,unmatchedError,unmatchedFacts',
    '`--json` 顶层键集合 = 冻结契约的 `reportJson.required`（没有多余的派生键）',
    Object.keys(j0).sort().join(','),
  );
  check(
    Object.keys(j0.rows[0]).sort().join(',') === 'authorityFile,defsElsewhere,defsInAuthority,divergent,fact',
    '`rows[]` 的元素键集合 = 冻结契约（`additionalProperties:false`，不得多塞覆盖率用的临时字段）',
    Object.keys(j0.rows[0]).sort().join(','),
  );

  // ③ 正对照：**1 条**事实在权威文件内命中定义式 ⇒ guard **不得**触发；
  //    另一条事实确实无关（权威文件里 0 处定义）也**不得**被判失败 —— 判据是**全体**，不是阈值。
  const one = await mkdtemp(join(tmpdir(), 'dsh-auth-one-'));
  await writeFile(join(one, 'AUTHORITY.md'), [HEAD7, row7('变现体系', 'SPEC.md'), row7('完全无关的事实', 'CONTRACT.md')].join('\n'));
  await writeFile(join(one, 'SPEC.md'), '# SPEC\n\n## 变现体系\n\n定义在这。\n');
  await writeFile(join(one, 'CONTRACT.md'), '# CONTRACT\n\n## 别的章节\n\n无关的事实见代码。\n');
  const r1 = spawnSync('node', [script, one], { encoding: 'utf8' });
  check(r1.status === 0, '**≥1 条命中 ⇒ 退出码 0**（不误伤"某条事实确实无关"）', `status=${r1.status}`);
  const j1 = JSON.parse(spawnSync('node', [script, one, '--json'], { encoding: 'utf8' }).stdout);
  check(j1.matchedFacts === 1 && j1.unmatchedFacts === 1 && j1.unmatchedError === null, '正对照：matched=1 / unmatched=1 / unmatchedError=null', JSON.stringify({ m: j1.matchedFacts, u: j1.unmatchedFacts }));
  check(!/事实名与定义语法不咬合/.test(r1.stdout), '正对照里**不得**出现「不咬合」告警');
  check(/声明 2 条 · 命中 1 条 · 未咬合 1 条/.test(r1.stdout), '覆盖率自曝：绿也打印「命中 1 条 · 未咬合 1 条」', (r1.stdout.match(/- 声明 \d+ 条[^\n]*/) || [''])[0].slice(0, 50));

  // ④ 第 2 列声明的权威文件**在 run 目录里不存在** ⇒ 计入 `codePointerFacts`（**不判红，只可见**）
  const cp = await mkdtemp(join(tmpdir(), 'dsh-auth-cp-'));
  await writeFile(join(cp, 'AUTHORITY.md'), [HEAD7, row7('退出码语义', 'NOT-IN-RUNDIR.md')].join('\n'));
  await writeFile(join(cp, 'SPEC.md'), '# SPEC\n\n## 别的章节\n\n见代码。\n');
  const jcp = JSON.parse(spawnSync('node', [script, cp, '--json'], { encoding: 'utf8' }).stdout);
  check(jcp.codePointerFacts === 1, '`codePointerFacts` 数出「权威文件指向 run 目录之外」的事实（0 命中因此**有正当解释**）', `codePointerFacts=${jcp.codePointerFacts}`);
  check(spawnSync('node', [script, cp], { encoding: 'utf8' }).status === 3, '它仍走退出码 3（`unmatchedFacts > 0` 本身**不**判红，只是可见）', '');
}

console.log('\n⑧ G3（BL-3）：契约依赖停滞 —— 能红 / 不误报三分支 / 可配置 / 非法值回默认');
{
  // 冻结口径（`PLAN.md` 的 G3 契约）：
  //   · 契约任务判据 = `kind === 'design' && owner === 'architect'`（**库里没有 `contract` kind**：
  //     全仓 `'contract'` 0 命中，那是任务对象的**字段**名）；
  //   · `wirePoint` = `checkTasks` 的 `state !== undefined` 分支内、`roundLimitViolations` **之后**；
  //   · 无 clock ⇒ **只走 attempt 维**；`clock.startedAt[<id>]` 是唯一可判起算时刻的来源。
  const V = await import(join(here, 'lib', 'validate.js'));
  const CT = (extra) => ({ id: 'T2', kind: 'design', owner: 'architect', status: 'pending', attempt: 1, dependsOn: [], ...extra });
  const DOWN = (extra) => ({ id: 'T3', kind: 'implementation', owner: 'backend', status: 'pending', attempt: 1, dependsOn: ['T2'], ...extra });
  const stallsOf = (tasks) => V.checkTasks(tasks, 'implement', {}).filter((s) => /CONTRACT_DEP_STALLED/.test(s));

  // ① 能红：契约任务未终态 + attempt ≥ 上限 + 有「其余依赖已就绪」的下游
  const hit = stallsOf([CT({ attempt: 3 }), DOWN()]);
  check(hit.length === 1, '停滞夹具 ⇒ 报 `CONTRACT_DEP_STALLED`', `${hit.length} 条`);
  check(['继续等', '覆写', '换人'].every((k) => (hit[0] || '').includes(k)), '文案含「继续等 / 覆写 / 换人」**三选项**（缺一即失败）', '');
  check(/请 lead 裁决/.test(hit[0] || ''), '文案点明「请 lead 裁决」');
  check(stallsOf([CT({ attempt: 1 }), DOWN()]).length === 0, 'attempt=1 < 默认上限 ⇒ **不报**（证明阈值真生效，不是恒报）');

  // ② 不误报三分支（冻结契约 `errors` 逐条钉住）
  check(stallsOf([CT({ status: 'completed', attempt: 9 }), DOWN()]).length === 0, '① 上游已 `completed` ⇒ 不报');
  check(stallsOf([CT({ attempt: 3 }), DOWN({ dependsOn: ['T2', 'T9'] }), { id: 'T9', kind: 'implementation', owner: 'backend', status: 'in_progress' }]).length === 0, '② 下游**其余依赖未就绪** ⇒ 不报');
  check(stallsOf([CT({ attempt: 3 }), DOWN({ status: 'completed' })]).length === 0, '③ 上游为唯一依赖、但下游已 `completed` ⇒ 不报（没有东西在等）');
  const unknownDep = V.checkTasks([CT({ attempt: 3 }), DOWN({ dependsOn: ['T2', 'T9'] })], 'implement', {});
  check(unknownDep.filter((s) => /CONTRACT_DEP_STALLED/.test(s)).length === 0, '④ `dependsOn` 指向不存在的 id ⇒ **不得**判成停滞');
  check(unknownDep.some((s) => /图结构/.test(s) && /T9/.test(s)), '④ 既有 `missing-dependency` **仍在**（没被新检查吞掉）');
  check(stallsOf([CT({ kind: 'implementation', owner: 'backend', attempt: 3 }), DOWN()]).length === 0, '⑤ 上游**不是契约任务**（kind/owner 不符）⇒ 不在判定域内，不报');
  check(V.isContractTask({ kind: 'design', owner: 'architect' }) === true && V.isContractTask({ kind: 'design', owner: 'backend' }) === false && V.isContractTask({ kind: 'implementation', owner: 'architect' }) === false, '`isContractTask` = `kind === design && owner === architect`（**不是**"带 contract 字段"：本 run 8/8 条都带该字段 ⇒ 恒真、不区分）', '');

  // ③ 时间维：**只在**给出 `clock.startedAt[<id>]` 时才可能触发（宁可少报，不得误报）
  const past = { startedAt: { T2: Date.now() - 4 * 3600 * 1000 } };
  const byClock = V.contractStallViolations([CT({ attempt: 1 }), DOWN()], undefined, past);
  check(byClock.length === 1 && byClock[0].actual > 0, '有 `clock.startedAt` 且超 `maxPendingMs` ⇒ 时间维命中', byClock.length ? `actual=${byClock[0].actual}` : '(none)');
  check(V.contractStallViolations([CT({ attempt: 1 }), DOWN()]).length === 0, '**无 clock ⇒ 只走 attempt 维**（attempt=1 不报）');
  check(V.contractStallViolations([CT({ attempt: 1 }), DOWN()], undefined, { startedAt: { T2: 'abc' } }).length === 0, '`startedAt` 非有限数 ⇒ 该维**不判**（不臆造时间）');
  check(Object.keys(byClock[0]).sort().join(',') === 'actual,code,id,limit,message', '`contractStallViolations` 的输出键 = 冻结契约（无 `clockAvailable` 之类多余键）', Object.keys(byClock[0]).sort().join(','));

  // ④ 可配置：env **更早**报；非法值（0 / -1 / abc / 空串）一律**忽略回默认**
  const KEYS = Object.keys(V.DEFAULT_CONTRACT_STALL_LIMITS);
  check(KEYS.sort().join(',') === 'maxPendingAttempts,maxPendingMs', '常量族键名 = 冻结契约', KEYS.join(','));
  check(V.DEFAULT_CONTRACT_STALL_LIMITS.maxPendingAttempts === 3 && V.DEFAULT_CONTRACT_STALL_LIMITS.maxPendingMs === 1800000, '默认值 = 冻结契约（3 / 1800000）', JSON.stringify(V.DEFAULT_CONTRACT_STALL_LIMITS));
  const ENV = V.CONTRACT_STALL_LIMIT_ENV;
  check(ENV.maxPendingAttempts === 'DSH_EXPERT_TEAM_CONTRACT_STALL_ATTEMPTS' && ENV.maxPendingMs === 'DSH_EXPERT_TEAM_CONTRACT_STALL_MS', 'env 名 = 冻结契约', JSON.stringify(ENV));
  const saved = process.env[ENV.maxPendingAttempts];
  try {
    process.env[ENV.maxPendingAttempts] = '1';
    const early = stallsOf([CT({ attempt: 1 }), DOWN()]);
    check(early.length === 1, '`DSH_EXPERT_TEAM_CONTRACT_STALL_ATTEMPTS=1` ⇒ attempt=1 **更早**报（证明可配置）', `${early.length} 条`);
    check(V.resolveContractStallLimits().maxPendingAttempts === 1, '`resolveContractStallLimits()` 读到 env', String(V.resolveContractStallLimits().maxPendingAttempts));
    for (const bad of ['0', '-1', 'abc', '']) {
      process.env[ENV.maxPendingAttempts] = bad;
      check(V.resolveContractStallLimits().maxPendingAttempts === 3, `非法 env ${JSON.stringify(bad)} ⇒ 忽略回默认 3（pickLimitValue 语义：非法即忽略）`, String(V.resolveContractStallLimits().maxPendingAttempts));
    }
    check(V.resolveContractStallLimits({ limits: { maxPendingAttempts: 5 } }).maxPendingAttempts === 5, '优先级 **config > env**', '');
    check(V.resolveContractStallLimits({ limits: { maxPendingAttempts: 0 } }).maxPendingAttempts === 3, 'config 里的非法值也回默认（`0` 不是合法上限）', '');
  } finally {
    if (saved === undefined) delete process.env[ENV.maxPendingAttempts];
    else process.env[ENV.maxPendingAttempts] = saved;
  }
  // ⑤ 读侧只报告不阻断：`checkTasks` 的返回类型仍是 `string[]`
  check(Array.isArray(stallsOf([CT({ attempt: 3 }), DOWN()])) && typeof stallsOf([CT({ attempt: 3 }), DOWN()])[0] === 'string', '追加进 `checkTasks` 的是**字符串**（既有 `string[]` 契约不变，读侧只报告）', '');
}


if (fail) { console.error(`\n✗ authority：${fail} 项失败`); process.exit(1); }
console.log('\n✓ authority：全部通过（六类违规 / 不误报 / 分叉检测 / 退出码四态 / G1 反空转 / 覆盖率可见 / G3 契约停滞 / 接线）');

