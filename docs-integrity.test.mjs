// 测试：**文档与 CI 的"活数字"必须与仓库实况一致**（防止再次出现"文档说 A、实况是 B"）
//
// ── 两件真实事故 ─────────────────────────────────────────────────────────────
// ① **CHANGELOG 版本节顺序**：`## 1.3.17` 与 `## 1.3.16` 两节被**追加到了文件末尾**（挂在 `## 1.1.0`
//    之后），于是"最新在上"的读法被破坏，**且已随 1.3.18 发到 npm**。此前没有任何测试守过它。
// ② **测试文件数漂移**：CI 的 step 名写死"（75 个测试文件…）"、README 写死"84 个"，
//    而实际是 88（本文件加入后 89）。同一个事实散落在多处、各自过期 —— 本仓纪律是"**一个事实一个家**"，
//    这类数字要么别写，要么**由测试盯着**。
//
// ── 这里钉住的不变量 ─────────────────────────────────────────────────────────
//   A. `CHANGELOG.md` 首个 `## x.y.z` == `package.json` 的 version（新节必须写在最上面）
//   B. 所有版本节**严格降序**（语义化版本比较，不是字符串比较）
//   C. 版本节**无重复**
//   D. **反空转**：解析到的版本节数 ≥ 15（正则失配 ⇒ 零标题 ⇒ 全部通过，那是假绿）
//   E. **活文档里的"NN 个测试文件"必须等于真实文件数**（`README.md` / `README.en.md` /
//      `.github/workflows/ci.yml` / `llms.txt`）—— **不扫 `CHANGELOG.md`**：那是历史记录，写的就是当时的值，不该被改。
//   F. **反空转**：活文档里必须真的找到至少一处这样的数字（否则改名/改写就会静默关掉这条检查）
//   H. **`llms.txt` 的可引用事实**（它是 AI 搜索/引用的入口，错一个数字就是一个会被复述的错答案）：
//      包名 == `package.json` name、宿主下限 == `engines.dsh`、角色数与角色 id 清单 == `lib/vocab.js`
//      的 `DEFAULT_ROLES`、阶段数 == `PHASES`。**每个提取都带反空转**（提取不到就红，不许静默通过）。
//   I. **可发布产物的文件权限**：`package.json` 的 `files` 覆盖到的每个普通文件都必须对**组/其他**可读
//      （`(mode & 0o044) === 0o044`）。**真实事故**：npm 上 1.3.24 的 tarball 里 60 个文件有 **45 个是 0600**
//      —— 以 root 安装、以别的用户运行时那批文件读不了，而"装上就能用"是本包最大的卖点之一。
//      `git` 只跟踪可执行位 ⇒ 权限漂移**不会**让 `git status` 变脏，也就没有任何现有检查会看见它。
//
//   为什么 `llms.txt` 必须一起扫：它曾经写"84 个测试文件 / 138 条变异"，而实况是 89 / 140 ——
//   正是 E/G 那类漂移，只是发生在一个**最容易被外部 AI 直接引用**的文件上。
//
// 它怎么抓"又把新节追加到末尾"：新节写在末尾 ⇒ A 立刻红；顺序整体乱掉 ⇒ B 红；同一版写两遍 ⇒ C 红。
//
// 运行：node docs-integrity.test.mjs

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLES, PHASES } from './lib/vocab.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# 文档与 CI 的活数字（版本节顺序 / 测试文件数）\n');

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const version = pkg.version;

// ── A–D：CHANGELOG 的版本节 ─────────────────────────────────────────────────
console.log('① CHANGELOG 版本节顺序（最新在上）');
const text = readFileSync(join(here, 'CHANGELOG.md'), 'utf8');
const titles = text.split('\n')
  .filter((l) => /^## \d+\.\d+\.\d+$/.test(l))
  .map((l) => l.slice(3).trim());

check(titles.length >= 15, '解析到的版本节数 ≥ 15（反空转：正则失配不许静默通过）', `实际 ${titles.length} 节`);
check(titles[0] === version, '首个版本节 == package.json 的 version（新节必须写在最上面）', `首节 ${titles[0]} / 包版本 ${version}`);

const parse = (v) => v.split('.').map(Number);
let firstBad = null;
for (let i = 1; i < titles.length; i++) {
  const a = parse(titles[i - 1]);
  const b = parse(titles[i]);
  const cmp = (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  if (cmp <= 0) { firstBad = `${titles[i - 1]} → ${titles[i]}`; break; }
}
check(firstBad === null, '版本节严格降序（最新在上，语义化版本比较）', firstBad ? `首个乱序处：${firstBad}` : `${titles.length} 节`);

const dupes = [...new Set(titles.filter((t, i) => titles.indexOf(t) !== i))];
check(dupes.length === 0, '没有重复的版本节', dupes.length ? `重复：${dupes.join(', ')}` : '');

// ── E–F：活文档里的测试文件数必须等于实数 ───────────────────────────────────
console.log('\n② 活文档里的"测试文件数"（单一真源 = scripts["test:files"]）');
const list = String(pkg.scripts?.['test:files'] || '');
const realCount = [...list.matchAll(/node\s+(\S+\.test\.mjs)/g)].length;
check(realCount >= 15, 'test:files 解析出的文件数 ≥ 15（反空转）', `实际 ${realCount} 个`);

// 只扫"活文档"：CHANGELOG 是历史记录，写的是当时的值，**故意不扫**
const LIVING = ['README.md', 'README.en.md', '.github/workflows/ci.yml', 'llms.txt'];
const PATTERNS = [/(\d+)\s*个测试文件/g, /(\d+)\s+test files?/gi];
let foundAny = 0;
for (const rel of LIVING) {
  let t = '';
  try { t = readFileSync(join(here, rel), 'utf8'); } catch { continue; }
  for (const re of PATTERNS) {
    for (const m of t.matchAll(re)) {
      foundAny += 1;
      const n = Number(m[1]);
      const line = t.slice(0, m.index).split('\n').length;
      check(n === realCount, `${rel}:${line} 写的「${n} 个测试文件」== 实数 ${realCount}`, n === realCount ? '' : `过期数字：应改为 ${realCount}（或干脆别写数字）`);
    }
  }
}
check(foundAny >= 1, '活文档里确实存在这样的数字（反空转：改写不该静默关掉这条检查）', `命中 ${foundAny} 处`);

// ── G：变异目录条数（同一类漂移：README 曾写 138，实际已 140） ────────────────
console.log('\n③ 活文档里的"变异目录条数"（单一真源 = regression.fixtures/mutations.json）');
const mutRaw = JSON.parse(readFileSync(join(here, 'regression.fixtures/mutations.json'), 'utf8'));
const realMutations = Array.isArray(mutRaw) ? mutRaw.length : (mutRaw.mutations || []).length;
const expMatch = /EXPECTED_CATALOG_SIZE\s*=\s*(\d+)/.exec(readFileSync(join(here, 'mutation-catalog.test.mjs'), 'utf8'));
check(expMatch !== null, 'mutation-catalog.test.mjs 里能读到 EXPECTED_CATALOG_SIZE（反空转）');
if (expMatch) {
  check(Number(expMatch[1]) === realMutations, 'EXPECTED_CATALOG_SIZE == mutations.json 实际条数', `${expMatch[1]} vs ${realMutations}`);
}
const MUT_PATTERNS = [/(\d+)\s*条变异/g, /(\d+)-entry mutation catalog/gi];
let mutFound = 0;
for (const rel of LIVING) {
  let t = '';
  try { t = readFileSync(join(here, rel), 'utf8'); } catch { continue; }
  for (const re of MUT_PATTERNS) {
    for (const m of t.matchAll(re)) {
      mutFound += 1;
      const n = Number(m[1]);
      const line = t.slice(0, m.index).split('\n').length;
      check(n === realMutations, `${rel}:${line} 写的「${n} 条变异」== 实数 ${realMutations}`, n === realMutations ? '' : `过期数字：应改为 ${realMutations}`);
    }
  }
}
check(mutFound >= 1, '活文档里确实存在变异目录条数（反空转）', `命中 ${mutFound} 处`);

// ── H：llms.txt 的"可引用事实"（AI 搜索/引用入口） ───────────────────────────
// llms.txt 的读者是外部 AI：它写错一个数字，就会被反复复述成"事实"。测试文件数/变异条数
// 已由 E/G 覆盖（llms.txt 进了 LIVING）；这里再把**包名 / 宿主下限 / 角色数与角色 id 清单 /
// 阶段数**钉到各自的唯一真源上。每项都带反空转 —— 提取不到就红，不许静默通过。
console.log('\n④ llms.txt 的可引用事实（包名 / 宿主下限 / 角色 / 阶段）');
let llms = '';
try { llms = readFileSync(join(here, 'llms.txt'), 'utf8'); } catch { /* 下面会红 */ }
check(llms.trim().length > 0, 'llms.txt 存在且非空（反空转）', llms ? `${llms.length} 字符` : '读不到');

/** 提取 + 反空转：提取不到记一项红并返回 null（调用方跳过后续比较，避免 TypeError）。 */
const grab = (re, what) => {
  const m = re.exec(llms);
  check(m !== null, `llms.txt 里能读到${what}（反空转）`);
  return m;
};

const mName = grab(/包名：`([^`]+)`/, '包名');
if (mName) check(mName[1] === pkg.name, 'llms.txt 包名 == package.json 的 name', `${mName[1]} vs ${pkg.name}`);

const mHost = grab(/Harness\s*≥\s*\*\*([^*]+)\*\*/, '宿主版本下限');
if (mHost) {
  const declared = String(pkg.engines?.dsh || pkg.dsh?.dsh || '').replace(/^[>=^~\s]+/, '');
  check(declared.length > 0, 'package.json 里能读到 engines.dsh（反空转）', declared || '读不到');
  check(mHost[1].trim() === declared, 'llms.txt 宿主下限 == engines.dsh', `${mHost[1].trim()} vs ${declared}`);
}

// 角色：既是"个数"也是"清单"。llms.txt 逐 id 列了 12 个角色，与 DEFAULT_ROLES 必须互为子集
// （少一个 = 漏写；多一个 = 幻觉出一个不存在的角色 id）。
const mRoles = grab(/角色（(\d+)）：(.+)/, '角色数与角色清单');
if (mRoles) {
  check(Number(mRoles[1]) === DEFAULT_ROLES.length, 'llms.txt 角色数 == lib/vocab.js DEFAULT_ROLES.length', `${mRoles[1]} vs ${DEFAULT_ROLES.length}`);
  const listed = [...mRoles[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  check(listed.length === DEFAULT_ROLES.length, 'llms.txt 实际列出的角色 id 个数 == DEFAULT_ROLES.length', `${listed.length} vs ${DEFAULT_ROLES.length}`);
  const missing = DEFAULT_ROLES.filter((r) => listed.indexOf(r) === -1);
  const extra = listed.filter((r) => DEFAULT_ROLES.indexOf(r) === -1);
  check(missing.length === 0 && extra.length === 0, 'llms.txt 角色 id 清单与 DEFAULT_ROLES 完全一致',
    missing.length || extra.length ? `缺：${missing.join(',') || '无'}；多：${extra.join(',') || '无'}` : `${listed.length} 个`);
}

const mPhases = grab(/阶段（(\d+)）/, '阶段数');
if (mPhases) check(Number(mPhases[1]) === PHASES.length, 'llms.txt 阶段数 == lib/vocab.js PHASES.length', `${mPhases[1]} vs ${PHASES.length}`);

// ── I：可发布产物的文件权限（0600 ⇒ 别人装上读不了） ─────────────────────────
// 真实事故（2026-09-16 核查 npm 上 1.3.24 的 tarball 时发现）：60 个文件里 **45 个是 0600**
// （`client.js` / `LICENSE` / `lib/index.js` / `lib/artifact-writer.js` / `skills/**` 全部模板 /
// `presets/expert-team/preset.yml` …），另 15 个是 0644 —— 因为工作区里这些文件本来就被写成了 0600，
// npm 只是把工作区权限原样带进 tarball。
// **危害**：以 root 安装、以**别的用户**运行时那批文件**读不了**，插件当场起不来 ——
// 而"装上就能用"正是本包最大的卖点之一。**没有人在看权限，所以它能一路发到 npm 上。**
// 这里钉住：`package.json` 的 `files` 覆盖到的**每个普通文件**都必须对**组/其他**可读
// （`(mode & 0o044) === 0o044`，即 0644/0664/0755… 都行，0600/0640 不行）。
// 只看 `files` 覆盖的集合（那才是会被发布的），不看仓库里其它文件（如测试、脚本本就可以更严）。
console.log('\n⑤ 可发布产物的文件权限（`files` 覆盖到的文件必须对组/其他可读）');
{
  const entries = [...(Array.isArray(pkg.files) ? pkg.files : []), 'package.json', 'README.md'];
  const bad = [];
  let scanned = 0;
  const collect = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) collect(join(p, name));
      return;
    }
    scanned += 1;
    if ((st.mode & 0o044) !== 0o044) bad.push(`${p} 0${(st.mode & 0o777).toString(8)}`);
  };
  for (const e of entries) {
    if (!existsSync(join(here, e))) continue;
    collect(join(here, e));
  }
  check(scanned >= 20, '扫到的待发布文件数 ≥ 20（反空转：`files` 解析失败不许静默通过）', `实际 ${scanned} 个`);
  check(bad.length === 0, '待发布文件全部对组/其他可读（0600 会让别的用户装上读不了）',
    bad.length ? `${bad.length} 个不可读：${bad.slice(0, 12).join('、')}${bad.length > 12 ? ' …' : ''}` : `${scanned} 个均 OK`);
}

if (fail) {
  console.log('\n提示：CHANGELOG 约定是**最新在上**（新节插在第一个 `## x.y.z` 之前）；');
  console.log('      活文档（含 llms.txt）里的测试文件数/变异条数/包名/宿主下限/角色/阶段请与仓库实况一致（或干脆别写数字）。');
  console.log('      待发布文件的权限：`files` 覆盖到的文件必须对组/其他可读（0600 会让别的用户装上读不了）。');
  console.error(`\n✗ docs-integrity：${fail} 项失败`);
  process.exit(1);
}
console.log('\n✓ docs-integrity：全部通过（CHANGELOG 首节=包版本 / 严格降序 / 无重复 / 活文档数字与实数一致 / llms.txt 可引用事实一致 / 待发布文件权限对组与其他可读 / 反空转）');
