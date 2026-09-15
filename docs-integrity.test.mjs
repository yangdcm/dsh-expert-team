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
//      `.github/workflows/ci.yml`）—— **不扫 `CHANGELOG.md`**：那是历史记录，写的就是当时的值，不该被改。
//   F. **反空转**：`README.md` 里必须真的找到至少一处这样的数字（否则改名/改写就会静默关掉这条检查）
//
// 它怎么抓"又把新节追加到末尾"：新节写在末尾 ⇒ A 立刻红；顺序整体乱掉 ⇒ B 红；同一版写两遍 ⇒ C 红。
//
// 运行：node docs-integrity.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const LIVING = ['README.md', 'README.en.md', '.github/workflows/ci.yml'];
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
check(foundAny >= 1, 'README.md 里确实存在这样的数字（反空转：改写不该静默关掉这条检查）', `命中 ${foundAny} 处`);

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
check(mutFound >= 1, 'README 里确实存在变异目录条数（反空转）', `命中 ${mutFound} 处`);

if (fail) {
  console.log('\n提示：CHANGELOG 约定是**最新在上**（新节插在第一个 `## x.y.z` 之前）；');
  console.log('      活文档里的测试文件数/变异条数请与仓库实况一致（或干脆别写数字）。');
  console.error(`\n✗ docs-integrity：${fail} 项失败`);
  process.exit(1);
}
console.log('\n✓ docs-integrity：全部通过（CHANGELOG 首节=包版本 / 严格降序 / 无重复 / 活文档数字与实数一致 / 反空转）');
