// 测试：E 线 **E3 · 单源化扫描**（`skills/expert-team/scripts/scan-single-source.mjs`）
//
// 为什么需要（同一个真实 run 的实测，见 `docs/专家团-开发计划.md`）：那批返工里
// **14/29 是「一个事实多份拷贝」**，而且形态是"每次都要等下一轮评审才发现下一个实例"——
// run 自己的复盘点名了这一点：「应该在做完第一个实例时就立刻总扫」。E3 把那次总扫机械化。
//
// 本测试钉住：
//   ① 定义点 / 引用点都被找齐（不会漏文件、不会把引用当定义）；
//   ② **分叉检测**真的会报（两份定义写法不同 ⇒ 报，并列出两种写法）；
//   ③ 跳过规则生效（`node_modules` 与二进制不参与，否则噪声会淹没结论）；
//   ④ **口径边界必须写在报告里**（"语义重复但改名扫不出来" 那句不得删——删了读者会以为扫过就安全了）；
//   ⑤ CLI 退出码三态（命中 0 / 未命中 1 / 用法错 2），且 **`--root <dir> <事实名>` 的参数顺序**
//      不会把目录名当成事实名（写这个脚本时真实踩到过：那会让"有副本"永远显示成"未命中"）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M109**。
// 运行：node scan-single-source.test.mjs

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanSingleSource, renderReport, definitionKind, definitionRhs, escapeRegExp, isCjkFact, factMatcher } from './skills/expert-team/scripts/scan-single-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'skills', 'expert-team', 'scripts', 'scan-single-source.mjs');
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# E 线 E3 · 单源化扫描\n');

// ── 夹具：一份"分叉的白名单" + 若干必须被跳过的干扰项 ───────────────────────
const root = await mkdtemp(join(tmpdir(), 'dsh-et-scan-'));
await mkdir(join(root, 'sub'), { recursive: true });
await mkdir(join(root, 'node_modules'), { recursive: true });
await writeFile(join(root, 'a.js'), [
  "const WARNING_CODES = ['E1', 'E2'];",
  'export function has(code) {',
  '  return WARNING_CODES.includes(code);',
  '}',
].join('\n'));
await writeFile(join(root, 'sub', 'b.js'), [
  "const WARNING_CODES = ['E1', 'E2', 'E3']; // 第二份拷贝，且已经分叉",
].join('\n'));
await writeFile(join(root, 'doc.md'), [
  '# 说明',
  '',
  '告警白名单 WARNING_CODES 由服务端权威给出。',
].join('\n'));
await writeFile(join(root, 'node_modules', 'skip.js'), "const WARNING_CODES = ['不应被扫到'];\n");
// 依赖目录：实测在真实项目上串行扫 `.venv` 要 30 秒级，且带回来的全是"工具的复制品"而非事实的出处。
await mkdir(join(root, '.venv', 'lib', 'site-packages'), { recursive: true });
await writeFile(join(root, '.venv', 'lib', 'site-packages', 'dep.py'), "WARNING_CODES = ['依赖里的副本']\n");
await writeFile(join(root, 'bin.dat'), 'WARNING_CODES\n');
await writeFile(join(root, 'fake.md'), 'WARNING_CODES\u0000二进制伪装\n');

console.log('① 定义点 / 引用点都被找齐');
const r = await scanSingleSource({ root, fact: 'WARNING_CODES' });
const files = [...r.definitions, ...r.references].map((x) => x.file);
check(r.definitions.length === 2, '定义点 2 处（a.js 与 sub/b.js）', r.definitions.map((d) => `${d.file}:${d.line}`).join(' / '));
check(files.includes(join('sub', 'b.js')), '子目录里的定义也被找到（递归不是摆设）');
check(r.references.length >= 2, '引用点 ≥2（a.js 的 includes 调用 + doc.md 的正文提及）', String(r.references.length));
check(files.includes('doc.md'), '文档里的提及也算引用（副本经常藏在文档里）');
check(r.definitions.every((d) => d.kind === 'decl'), '两处定义都被判为 `decl`（`const X = …`）', r.definitions.map((d) => d.kind).join('/'));

console.log('\n② 分叉检测（本脚本存在的理由）');
check(r.divergent === true, '两份定义写法不同 ⇒ 报分叉');
check(r.variants.length === 2, '列出 2 种写法（两种右值）', JSON.stringify(r.variants).slice(0, 120));
const rep = renderReport(r);
check(rep.includes('⚠️ **定义不一致（疑似分叉）'), '报告里出现分叉告警');
check(rep.includes('写法 A') && rep.includes('写法 B'), '两种写法各自列出（含出处文件:行号）');
check(rep.includes("['E1', 'E2', 'E3']") || rep.includes("['E1','E2','E3']"), '分叉的那份原文被贴出来（不是只说"不一致"）');

console.log('\n③ 跳过规则（噪声不淹结论）');
check(!files.some((f) => f.includes('node_modules')), '`node_modules` 下的副本不被计入', files.filter((f) => f.includes('node_modules')).join('/') || '（无）');
check(!files.some((f) => f.endsWith('bin.dat')), '非文本扩展名被跳过');
check(!files.some((f) => f.endsWith('fake.md')), '伪装成 .md 的二进制（含 NUL）被跳过');
check(!files.some((f) => f.includes('.venv') || f.includes('site-packages')), '依赖目录（`.venv`/`site-packages`）不被计入 —— 实测它们占掉 30 秒级耗时', files.filter((f) => f.includes('.venv') || f.includes('site-packages')).join('/') || '（无）');
check(rep.includes('语义重复但改了名') && rep.includes('扫不出来'), '**口径边界写在报告里**（"改名副本扫不出来"这句不得删）');
check(rep.includes('命中 0 处时**退出码 1**'), '退出码语义写在报告里');

console.log('\n④ 反向：定义写法一致时**不**报分叉（不制造假警报）');
const root2 = await mkdtemp(join(tmpdir(), 'dsh-et-scan2-'));
await writeFile(join(root2, 'x.js'), "const CODES = ['A'];\n");
await writeFile(join(root2, 'y.js'), "const CODES = ['A'];\n");
const r2 = await scanSingleSource({ root: root2, fact: 'CODES' });
check(r2.definitions.length === 2 && r2.divergent === false, '两处定义写法相同 ⇒ 不报分叉', `defs=${r2.definitions.length} divergent=${r2.divergent}`);
const r3 = await scanSingleSource({ root: root2, fact: 'CODES', maxFiles: 1 });
check(r3.truncated === true && renderReport(r3).includes('已达文件数上限'), '文件数到上限时**如实标注被截断**（不假装扫完了）');
const r4 = await scanSingleSource({ root: root2, fact: 'CODES', maxMs: 0 });
check(r4.truncated === true && r4.truncatedReason === 'time' && renderReport(r4).includes('超出时间预算'), '超出时间预算时也如实标注（慢盘上宁可说"没扫全"，也不卡住回合）', `truncated=${r4.truncated} reason=${r4.truncatedReason}`);
const r5 = await scanSingleSource({ root, fact: 'WARNING_CODES' });
const r5files = r5.definitions.map((d) => d.file);
check(r5files.join(',') === [...r5files].sort().join(','), '输出顺序稳定（并发读盘后按 文件→行号 排序，否则每次报告都不一样）', r5files.join(','));

console.log('\n⑤ 小工具（正则转义 / 定义识别）');
check(escapeRegExp('a.b[c]') === 'a\\.b\\[c\\]', '正则元字符被转义', escapeRegExp('a.b[c]'));
check(definitionKind('  WARNING_CODES = ["a"]', 'WARNING_CODES') === 'assign', 'Python 风格的顶层赋值被认作定义');
check(definitionKind('  "WARNING_CODES": ["a"],', 'WARNING_CODES') === 'key', 'JSON 键被认作定义');
check(definitionKind('  return WARNING_CODES.includes(code);', 'WARNING_CODES') === null, '纯引用**不**被误判成定义');
check(definitionRhs("const X = ['a', 'b']; // 注释") === "['a', 'b'];", '右值剥离注释与多余空白', definitionRhs("const X = ['a', 'b']; // 注释"));

console.log('\n⑥ CLI：退出码三态 + 参数顺序（写脚本时真实踩过的坑）');
const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
const hit = run('WARNING_CODES', '--root', root);
check(hit.status === 0, '命中 ⇒ 退出码 0', `status=${hit.status}`);
const miss = run('THIS_FACT_DOES_NOT_EXIST_ANYWHERE', '--root', root);
check(miss.status === 1, '未命中 ⇒ 退出码 1（与"没扫"区分）', `status=${miss.status}`);
check(miss.stdout.includes('未命中'), '未命中时 stdout 明说"未命中"');
const bad = run();
check(bad.status === 2, '缺事实名 ⇒ 退出码 2（用法错）', `status=${bad.status}`);
// ⚠️ 这条是回归测试：`--root` 在前时，目录名**不能**被当成事实名
const ordered = run('--root', root, 'WARNING_CODES');
check(ordered.status === 0, '`--root <dir> <事实名>` 顺序下仍命中（目录名没被当成事实名）', `status=${ordered.status}`);
const json = run('--root', root, '--json', 'WARNING_CODES');
check(json.status === 0 && JSON.parse(json.stdout).definitions.length === 2, '`--json` 输出可被机器解析', `status=${json.status}`);

console.log('\n⑨ 中文事实名（2026-09-13 修：`\\b` 对汉字不成立 ⇒ 曾"命中 0 而实际有 8 处"）');
{
  // (a) 根因：`\b` 依赖 `\w`，汉字不是 `\w` ⇒ 旧实现永远匹配不到
  check(isCjkFact('变现体系') === true && isCjkFact('REQUIRED_SECTIONS') === false, '识别"含汉字"的事实名');

  // (b) 中文按子串匹配（**已知取舍**：宁可多算不可零命中）
  const cjk = factMatcher('变现体系');
  check(cjk.test('本章讲变现体系的设计'), '**能命中**中文事实名（旧实现这里必然 false —— 这就是那个真实 run 的 `scan:limitation`）');
  check(cjk.test('变现体系化的做法') === true, '明知会多算"更长词内部"的命中（中文无词边界，故如实取舍：宁可多算不可零命中）');

  // (c) ASCII 的整词语义**不许**被顺手改掉
  const ascii = factMatcher('X');
  check(ascii.test('const X = 1') && !ascii.test('XX') && !ascii.test('xX'), 'ASCII 仍是 `\\b…\\b` 整词（`XX`/`xX` 不命中）');
  check(factMatcher('').test('任何东西') === false, '空事实名永不命中（不许变成"命中一切"）');
  // 有状态正则陷阱：带 `g` 的 `.test()` 会推进 lastIndex ⇒ 调用方逐行判定时**隔一行漏一行**。
  // 2026-09-13 我自己刚踩过（给中文匹配加了 `g`，断言当场假红）。钉死：同一匹配器可重复 test。
  const rep1 = factMatcher('变现体系');
  check(rep1.test('变现体系 A') && rep1.test('变现体系 B') && rep1.test('变现体系 C'), '同一个匹配器可**重复** test（不许带 `g` 标志）');
  check(rep1.flags.includes('g') === false, '`factMatcher` 不返回全局正则', `flags=${rep1.flags}`);

  // (d) 散文式定义语法（中文事实名走这一套；代码式声明对散文不适用）
  check(definitionKind('## 变现体系', '变现体系') === 'zh-heading', '标题算定义');
  check(definitionKind('**变现体系**：三域闭环', '变现体系') === 'zh-bold', '加粗定义算定义');
  check(definitionKind('| 变现体系 | 说明 |', '变现体系') === 'zh-table', '表格行算定义');
  check(definitionKind('「变现体系」：指三大域', '变现体系') === 'zh-quoted', '引用式定义算定义');
  check(definitionKind('- 变现体系：说明', '变现体系') === 'zh-list', '列表项算定义');
  check(definitionKind('参见变现体系的说明', '变现体系') === null, '**普通引用不算定义**（否则分叉检测会满屏假阳性）');
  check(definitionKind('export const X = 1', 'X') === 'decl' && definitionKind('X = 1', 'X') === 'assign', 'ASCII 的代码式定义语法不受影响');

  // (d′) D1（`BL-12`：台账/清单类表格行被算成「定义」⇒ 假命中压掉 EXIT=3）+ 第二道闸（指针行）
  //      + D2（`BL-13`：引用语境 ⇒ 只算引用）。**每条都是"只收紧"**：既有 `:142-148` 逐字未改。
  check(definitionKind('| 变现体系 | 值A | 说明A |', '变现体系') === null, '**3 列台账行不算定义**（BL-12 负对照：`| 事实名 | 值A | 说明A |` ⇒ 不是定义）');
  check(definitionKind('| 变现体系 | 说明 |', '变现体系') === 'zh-table', '**2 列定义行仍算定义**（BL-12 正对照，与上面那条同形对照）');
  check(definitionKind('| 变现体系 | SPEC.md |', '变现体系') === null, '**2 列指针行不算定义**（D1 第二道闸：指针不是定义正文）');
  check(definitionKind('| 变现体系 | 待定 |', '变现体系') === null, '2 列 + 状态词（`待定`）⇒ 不算定义（`TABLE_STATUS_WORDS` 第二道闸）');
  check(definitionKind('| 值A | 变现体系 |', '变现体系') === null, '**事实名不在第 1 格 ⇒ 不算定义**（原有正则作为 AND 保留的守卫：丢了它这里会变成假阳性）');
  check(definitionKind('| 变现体系 | 进行中 | 备注 |', '变现体系') === null, '3 列且第 2 格是状态词 ⇒ 不算定义（列数判据优先）');
  // D2：引用语境（**行内代码 span**）。⚠️ 这条夹具刻意用 `zh-quoted` 形态：不带 D2 时它**会**命中
  // `zh-quoted`（该正则不锚行首）⇒ 是定义；带 D2 ⇒ `null` ⇒ **能红**（M161 抓的就是它）。
  check(definitionKind('`「变现体系」：指三大域`', '变现体系') === null, '**行内代码 span 包住事实名 ⇒ 引用语境**（D2 规则①，能红夹具）');
  check(definitionKind('| `变现体系` | 说明 |', '变现体系') === null, '表格单元格内的代码 span ⇒ 引用语境（D2 规则①的另一形态）');
  check(definitionKind('## 变现体系', '变现体系') === 'zh-heading', '**标题优先于 D2**：`zh-heading` 在引用语境判定之前（冻结顺序）');
  // ⚠️ 这条是"已删除的散文关键词规则"的**回退守卫**：若有人把「含 参见/引用/证据/见 ⇒ 判为引用」加回来，
  //    它会把合法定义 `- 变现体系：参见三大域` 漏判成引用（**掩盖真分叉**）⇒ 本条必红。
  check(definitionKind('- 变现体系：参见三大域', '变现体系') === 'zh-list', '合法 `zh-list` 定义**不得**被散文关键词规则误判成引用（旧候选规则已删的守卫）');

  // (e) 端到端：复现那个 run 的真实场景（SPEC 里 8 处 `变现体系`，旧实现报 0）
  const root = await mkdtemp(join(tmpdir(), 'dsh-scan-zh-'));
  await writeFile(join(root, 'SPEC.md'), [
    '# 规格', '', '## 变现体系', '',
    '**变现体系**：三大域闭环。', '',
    '| 变现体系 | 说明 |', '|---|---|', '| 内容域 | x |', '',
    '- 变现体系：含二手交易', '', '正文里多次提到变现体系的设计与变现体系的指标。', '再提一次变现体系。',
    '变现体系的边界：不碰支付。', '变现体系与内容域的关系。',
  ].join('\n'));
  await writeFile(join(root, 'PRD.md'), '# PRD\n\n变现体系一句话带过。\n');
  const r = await scanSingleSource({ root, fact: '变现体系' });
  const occurrences = r.definitions.length + r.references.length;
  // 注意：命中是**按行**计的（同一行出现两次算一行）—— 别把它当成出现次数。
  check(occurrences >= 8, '端到端：8 行以上能扫到（旧实现是 0 —— 这正是那个真实 run 的 `scan:limitation`）', `命中 ${occurrences} 行（定义 ${r.definitions.length} / 引用 ${r.references.length}）`);
  check(r.definitions.length >= 4, '并且认出多处在"定义"（标题/加粗/表格/列表）', `定义 ${r.definitions.length} 处`);
  const rep = renderReport(r);
  check(/含汉字.*子串/.test(rep), '报告里**如实标注**中文按子串计数（不假装是精确 token 计数）');
}


if (fail) { console.error(`\n✗ scan-single-source：${fail} 项失败`); process.exit(1); }
console.log('\n✓ scan-single-source：全部通过（找齐 / 报分叉 / 跳噪声 / 边界可见 / 退出码三态）');
