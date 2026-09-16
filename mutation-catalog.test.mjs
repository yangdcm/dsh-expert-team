// 测试：变异目录（`regression.fixtures/mutations.json`）的**预检自检**
//
// 为什么需要：变异门禁的价值完全依赖"每个变异体的 `find` 串恰好命中一次"。可它自己
// 没有任何自检 —— 历史已经吃过两次亏：
//   ① `error:mutation`：B-01 新增的 `pick` 与既有 `resolveLimits` 的 `pick` **逐字重复**
//      ⇒ `M47` 的 find 串命中 2 次、变异跑不起来（这个失败**只有在跑完 91 个变异体之后**
//      才会暴露，而且报出来的是"某条变异没被抓住"，指向错误的排查方向）。
//   ② `error:lead`：catalog 条数被写错（"85/85" vs 实际 84）—— 条数没有断言，谁也发现不了。
// 这两类都是"台账/契约错误"（D 类）的纯机器可判形态，成本几乎为零。
//
// 判定：
//   · 硬失败：id 重复 / id 形状不合法 / `find` 为空 / `find === replace` / `find` 在目标文件里
//     命中次数 ≠ 1 / 目标文件不存在 / 目标测试文件不存在 / catalog 条数与 `EXPECTED_CATALOG_SIZE` 不符。
//   · **不失败但打印**：id 号段在数组里非升序（纯顺序问题，不影响运行；`M86–M89` 排在
//     `M82–M85` 之前就是这种情况）。按本仓"warn 可见、不滥报"的口径，先只暴露不阻断。
//
// 运行：node mutation-catalog.test.mjs

import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * catalog 的期望条数。**新增/删除变异体时必须同时改这里** —— 这是有意的：
 * 条数变动应当是一次经过确认的动作，而不是悄悄发生（历史吃过一次数字错的亏）。
 */
const EXPECTED_CATALOG_SIZE = 152;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const raw = await readFile(join(here, 'regression.fixtures', 'mutations.json'), 'utf8');
let catalog;
try { catalog = JSON.parse(raw); } catch (e) {
  console.error(`✗ mutations.json 不是合法 JSON：${e.message}`);
  process.exit(1);
}
const list = Array.isArray(catalog.mutations) ? catalog.mutations : null;
check(Array.isArray(list), 'catalog.mutations 是数组');
if (!Array.isArray(list)) { console.error('\n✗ mutation-catalog：无法继续'); process.exit(1); }

// ── 1. 条数（防悄悄增删） ──
check(
  list.length === EXPECTED_CATALOG_SIZE,
  `条数与 EXPECTED_CATALOG_SIZE 一致（${EXPECTED_CATALOG_SIZE}）`,
  list.length === EXPECTED_CATALOG_SIZE ? `actual=${list.length}` : `actual=${list.length} —— 若确为有意增删，请同步改本文件顶部的 EXPECTED_CATALOG_SIZE`,
);

// ── 2. id：唯一 + 形状 ──
const ids = list.map((m) => String(m && m.id || ''));
const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
check(dupIds.length === 0, 'id 全唯一', dupIds.length ? `重复：${dupIds.join(', ')}` : `${ids.length} 个`);
const badShape = ids.filter((id) => !/^M\d+-[a-z0-9][a-z0-9-]*$/.test(id));
check(badShape.length === 0, 'id 形状为 `M<数字>-<kebab>`', badShape.length ? `不合法：${badShape.slice(0, 5).join(', ')}` : '');

// ── 3. 每个变异体必须有 id/title/why/test/edits ──
const incomplete = list.filter((m) => !m || !m.id || !m.title || !m.why || !m.test || !Array.isArray(m.edits) || m.edits.length === 0);
check(incomplete.length === 0, '每条都有 id/title/why/test/edits', incomplete.length ? `缺字段：${incomplete.map((m) => m && m.id).slice(0, 5).join(', ')}` : '');

// ── 4. 目标测试文件存在 ──
const missingTests = [];
for (const m of list) {
  const t = String((m && m.test) || '');
  if (!t) continue;
  try { await access(join(here, t)); } catch { missingTests.push(`${m.id} → ${t}`); }
}
check(missingTests.length === 0, '每条的目标测试文件存在', missingTests.length ? missingTests.slice(0, 5).join('; ') : '');

// ── 5. 每个 edit 的 find 串在目标文件里**恰好命中一次**（这条最值钱：把"跑到一半才炸"变成"提交前就红"） ──
const fileCache = new Map();
const readTarget = async (rel) => {
  if (fileCache.has(rel)) return fileCache.get(rel);
  let content = null;
  try { content = await readFile(join(here, rel), 'utf8'); } catch { content = null; }
  fileCache.set(rel, content);
  return content;
};
const problems = [];
for (const m of list) {
  for (const [i, e] of (m.edits || []).entries()) {
    const rel = String((e && e.file) || '');
    const find = e && e.find;
    const replace = e && e.replace;
    if (!rel || typeof find !== 'string' || typeof replace !== 'string') {
      problems.push(`${m.id}#${i} 缺少 file/find/replace`); continue;
    }
    if (find.length === 0) { problems.push(`${m.id}#${i} find 为空`); continue; }
    if (find === replace) { problems.push(`${m.id}#${i} find 与 replace 相同（变异无效）`); continue; }
    const content = await readTarget(rel);
    if (content === null) { problems.push(`${m.id}#${i} 目标文件不存在：${rel}`); continue; }
    const hits = content.split(find).length - 1;
    if (hits !== 1) problems.push(`${m.id}#${i} find 在 ${rel} 命中 ${hits} 次（必须恰好 1 次）`);
  }
}
check(
  problems.length === 0,
  '每个 find 串在目标文件里恰好命中 1 次',
  problems.length ? `\n      ${problems.slice(0, 8).join('\n      ')}` : `${list.reduce((n, m) => n + (m.edits || []).length, 0)} 处编辑`,
);

// ── 6. 号段顺序：只警告不失败 ──
const nums = ids.map((id) => {
  const m = id.match(/^M(\d+)/);
  return m ? Number(m[1]) : NaN;
}).filter((n) => Number.isFinite(n));
const outOfOrder = [];
for (let i = 1; i < nums.length; i += 1) if (nums[i] < nums[i - 1]) outOfOrder.push(`M${nums[i]} 排在 M${nums[i - 1]} 之后`);
if (outOfOrder.length > 0) {
  console.log(`  ⚠ 号段非升序（不影响运行，仅影响可读性与人工核对）：${outOfOrder.join('；')}`);
} else {
  console.log('  ✓ 号段在数组里升序');
}

if (fail) { console.error(`\n✗ mutation-catalog：${fail} 项失败`); process.exit(1); }
console.log('\n✓ mutation-catalog：全部通过');
