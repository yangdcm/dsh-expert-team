#!/usr/bin/env node
// 工件单源化的**分叉检测**（设计稿 §十二 第 2 步）：读 `AUTHORITY.md`，对**每一行声明的事实**，
// 扫本 run 的权威文件，报出"同一个事实在两个及以上权威文件里**各有定义**"的情况。
//
// 为什么需要它：规则 34 已经要求"见一个扫全部"，但人工逐个事实名去扫**不会发生**（实测那个真实 run
// 里 64% 的返工来自"同一事实多份拷贝"，而扫描器当时也没被用起来 —— 见 `scan:limitation`）。
// 本脚本把"逐条事实 × 全部权威文件"这件事变成**一条命令**。
//
// 复用：`scanSingleSource`（同一目录，规则 34 用的就是它）—— 不另写一套扫描。
//
// ⚠️ 表格式的**完整校验**在 host 侧（`lib/validate.js` 的 `authorityViolations`，含列数/文件存在/
// 写者唯一/核心工件纳入治理）。本脚本只做**极简的第 1、2 列提取**（两个发行位置不同：`skills/` 随技能
// 装到 `~/.dsh/skills`，`lib/` 在 profile 的 node_modules 里，跨发行互 import 不可靠）。
// 表格格式由模板 + host 侧校验钉住，这里刻意不重复实现校验逻辑。
//
// ⚠️ **反空转（G1 / BL-4，2026-09-17）**：只看"有没有分叉"会**空转绿** —— 一次真实 run 的 19 条事实里，
// 18 条权威列写的是 `SPEC.md`，而真源在**代码**里（`AUTHORITY.md` 的协议把机读真源写在第 4 列），
// 于是 run 目录里一条定义式都扫不到；而脚本照样报"分叉 0 条 / 退出码 0"，读起来和"真的干净"
// **完全同形**。所以加一条**全体**判据（**相对**，不是阈值）：
//
//     matchedFacts === 0 && defsElsewhereTotal === 0   ⇒   EXIT=3（FACTS_UNMATCHED）
//
// **为什么必须是 AND 而不是只判 `matchedFacts === 0`**：权威文件里写错了名字、但事实在别处确有定义，
// 那是**真实分叉**，必须走 `1`；只判 matchedFacts 会把它吞进"空转码"⇒ **信号混码**（既有变异体
// M129「造分叉」依赖 `EXIT=1`）。
// **不得**实现成"每条事实都必须命中"：`authority.test.mjs:100-101` 构造的正是
// `defsInAuthority === 0 ∧ defsElsewhere === 0` 的「只有引用没有定义」事实，并断言**不误报** ——
// 逐条判会当场打破它，也会把「某条事实确实无关（仅被引用/未落笔）」判成失败（SPEC 边界⑦）。
// 判据是**全体**：任何一条命中即整体不触发。
//
// 退出码：0 = 无分叉且 ≥1 条事实在其权威文件内命中定义式；1 = 发现分叉（既有语义不变，
//         **优先级高于 3**）；2 = 用法/输入错误（既有语义不变）；3 = FACTS_UNMATCHED。
// 优先级：`2`（用法错）最高；`1` 次之；`3` 只出现在**本来会返回 0** 的位置。
//
// ⚠️ **覆盖率只做可见、不做阈值**：人类可读**每轮无条件**打印
// 「声明 N 条 · 命中 M 条 · 未咬合 U 条 · 指向代码 C 条（覆盖率可见，不计入退出码）」；
// `--json` 给出 `scannedFacts` / `matchedFacts` / `unmatchedFacts` / `codePointerFacts` /
// `defsElsewhereTotal` / `unmatchedError`。
// `unmatchedFacts > 0` **绝不**判红：那会误伤"权威合法指向代码"的 run，且等于引入魔法阈值。
// 覆盖率自曝的意义：**绿也自带"命中 1/19"的自我暴露**，不得据此宣称单源化已通过。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanSingleSource } from './scan-single-source.mjs';

/** 极简提取：`| 事实 | 唯一权威文件 | … |` 的**前两列**（跳过表头/分隔/空行/示例行）。
 *  ⚠️ **本次唯一改动 = 表头识别**（Batch 3 · D3 的连带面，2026-09-17 裁决）：模板表头已从「事实类别」
 *  改成「事实」（旧表头诱导人把**类别标签**写进第 1 列），而这里原本只跳过 `/^事实类别$/` ⇒ 新表头会被
 *  当成一条**幻影事实** `{fact:'事实', file:''}`（实测）⇒ `scannedFacts`/`codePointerFacts` 各多 1，
 *  且 `事实` 是极常见子串 ⇒ 只要 run 里别的文件有一行"定义式形状且含 `事实`"就**假分叉 EXIT=1**。
 *  修法与 `lib/validate.js` 的 `parseAuthorityRows` **同一条规则**（两个解析器不得对表头判定不一致）：
 *  用**列标签**（第 2 列 `唯一权威文件` + 第 3 列 `唯一写者`）判表头 —— 不用第 1 列的措辞判，
 *  否则**事实名恰为「事实」/「事实类别」的真实数据行会被静默吞掉**（那是削弱判据）。
 *  **保持不变**：事实名的提取语义（`cells[0]` **整格**、不切分 / 不剥 `**` / 不裁括号）、
 *  第 4 列**不**参与提取（`AUTHORITY.md` 的协议把机读真源写在第 4 列，但那是**文档约定**，
 *  不是本脚本的输入；把它读进来等于让脚本改判"权威是谁"）。 */
export function authorityFacts(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!/^\s*\|.*\|\s*$/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^事实类别$/.test(cells[0]) || (cells[1] === '唯一权威文件' && cells[2] === '唯一写者')) continue;
    if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) continue;
    if (!cells[0] || /示例/.test(cells[0])) continue; // 模板示例行不算声明
    const file = (cells[1].match(/[^\s`"'§|]+\.(?:md|json|ya?ml|txt)/i) || [''])[0];
    out.push({ fact: cells[0], file });
  }
  return out;
}

/**
 * 对一条事实判断"是否分叉"。
 *
 * ⚠️ **语义别搞反**（我第一版就搞反了，被测试当场抓住）：权威文件**本来就该定义**这个事实 ——
 * 所以在"声明的权威文件集合内部"找分叉，**永远找不出违规**（自证清白）。
 * 正确的判据是：**权威文件之外**还有谁在**定义**它。
 *
 * @returns `{ fact, authorityFile, defsInAuthority, defsElsewhere, divergent }`
 *   · `defsInAuthority` —— 权威文件里的定义点（正常，通常 1 处，多着说明权威文件自己内部也散了）
 *   · `defsElsewhere`   —— **其他文件**里的定义点（这就是分叉；引用不算）
 */
export async function divergenceFor({ runDir, fact, authorityFile, maxMs = 20000 }) {
  const r = await scanSingleSource({ root: runDir, fact, maxMs });
  // ⚠️ **必须排除 `AUTHORITY.md` 自己**：那张表天然会逐行写下每个事实名（`| 变现体系 | SPEC.md | …`），
  // 而散文定义语法里的「表格行」规则会把这种行认成"定义"⇒ 每一条声明都会被误报成"权威之外还有人定义"。
  // 本文件是**关于事实的元数据**，不是事实的定义。（2026-09-13 被退出码断言当场抓到。）
  const METADATA_FILES = new Set(['AUTHORITY.md']);
  const defs = r.definitions.filter((d) => !METADATA_FILES.has(d.file));
  const defsInAuthority = defs.filter((d) => d.file === authorityFile);
  const defsElsewhere = defs.filter((d) => d.file !== authorityFile);
  return { fact, authorityFile, defsInAuthority, defsElsewhere, divergent: defsElsewhere.length > 0 };
}

export function render(report) {
  const { runDir, rows, unmatchedError } = report;
  // 派生值优先取调用方算好的；缺了就**就地重算**（渲染层不该依赖调用方把派生值塞全）。
  const matchedFacts = Number.isFinite(report.matchedFacts)
    ? report.matchedFacts
    : rows.filter((r) => r.defsInAuthority.length > 0).length;
  const scannedFacts = Number.isFinite(report.scannedFacts) ? report.scannedFacts : rows.length;
  const unmatchedFacts = Number.isFinite(report.unmatchedFacts) ? report.unmatchedFacts : scannedFacts - matchedFacts;
  const codePointerFacts = Number.isFinite(report.codePointerFacts) ? report.codePointerFacts : 0;
  const defsElsewhereTotal = Number.isFinite(report.defsElsewhereTotal)
    ? report.defsElsewhereTotal
    : rows.reduce((n, r) => n + r.defsElsewhere.length, 0);
  const out = [];
  const bad = rows.filter((r) => r.divergent);
  out.push(`# 单源化分叉检测：${runDir}`);
  out.push('');
  out.push(`- 声明的事实 **${rows.length}** 条`);
  out.push(`- **分叉 ${bad.length} 条**${bad.length ? ' ⚠️ 权威文件之外还有人在定义同一事实 —— 这就是「迟早不一致」的形状' : '（无）'}`);
  // **覆盖率可见性**（冻结契约的 `coverageVisibility.humanReadableLine`，**逐字**且**无条件**打印）：
  // 让"绿"自带"命中 1/19"的自我暴露，而不是靠纪律提醒。
  out.push(`- 声明 ${scannedFacts} 条 · 命中 ${matchedFacts} 条 · 未咬合 ${unmatchedFacts} 条 · 指向代码 ${codePointerFacts} 条（覆盖率可见，不计入退出码）`);
  if (unmatchedError) {
    out.push(`- ⚠️ **事实名与定义语法不咬合**（FACTS_UNMATCHED，退出码 3）—— 声明的事实在其权威文件内**一处定义式都没命中**，且**权威之外也没有**任何定义（\`defsElsewhereTotal === ${defsElsewhereTotal}\`）⇒ 这次「无分叉」是**空转绿**（扫描器什么都没咬合上），不是真的干净。`);
  } else if (unmatchedFacts > 0) {
    out.push(`- ⚠️ 未咬合 ${unmatchedFacts} 条 ⇒ 本次「无分叉」的实际覆盖率只有 ${matchedFacts}/${scannedFacts}，**不得据此宣称单源化已通过**（退出码仍为 0：≥1 条命中即整体不触发；权威合法指向代码/目录外不是缺陷）`);
  }
  out.push('');
  for (const r of rows) {
    const mark = r.divergent ? '✗' : '✓';
    out.push(`${mark} **${r.fact}** — 权威 \`${r.authorityFile || '(未指定)'}\` 里定义 ${r.defsInAuthority.length} 处 · **权威之外定义 ${r.defsElsewhere.length} 处**`);
    if (r.divergent) {
      out.push('    ⚠️ 权威之外的定义点（应改成引用）：');
      for (const d of r.defsElsewhere) out.push(`      - \`${d.file}\`:${d.line} — ${String(d.text).slice(0, 100)}`);
    } else if (r.defsInAuthority.length === 0) {
      out.push('    （注：权威文件里也没有"定义式"写法 —— 可能只是被引用，或该事实还没真正落笔）');
    }
  }
  return out.join('\n');
}

async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const rest = args.filter((a) => !a.startsWith('--'));
  const runDir = rest[0];
  if (!runDir) {
    console.error('用法：node scan-authority.mjs <runDir> [--json]');
    process.exit(2);
  }
  let text;
  try {
    text = await readFile(join(runDir, 'AUTHORITY.md'), 'utf8');
  } catch {
    console.error(`✗ 读不到 ${join(runDir, 'AUTHORITY.md')}（本 run 没有权威表 ⇒ 先按模板写一份）`);
    process.exit(2);
  }
  const facts = authorityFacts(text);
  if (!facts.length) {
    console.error('✗ AUTHORITY.md 里没有有效声明（表是空的或只有表头/示例行）');
    process.exit(2);
  }
  const rows = [];
  for (const f of facts) rows.push(await divergenceFor({ runDir, fact: f.fact, authorityFile: f.file }));
  // ── G1（BL-4）反空转：**全体**判据（见文件头）─────────────────────────────────────
  // `matchedFacts` = 「至少在其权威文件内命中 1 处定义式」的事实数。判据是**全体**：
  // 只要有**一条**事实咬合上（`> 0`），guard 就**不得**触发 —— "某条事实确实无关"不是失败。
  const scannedFacts = rows.length;
  const matchedFacts = rows.filter((r) => r.defsInAuthority.length > 0).length;
  const defsElsewhereTotal = rows.reduce((n, r) => n + r.defsElsewhere.length, 0);
  const unmatchedFacts = scannedFacts - matchedFacts;
  // 覆盖率可见性：**第 2 列声明的权威文件在 run 目录里不存在/不可扫**的条数 ——
  // 它们的 0 命中**有正当解释**（权威指向代码/目录外），不由"语法不咬合"解释。
  const codePointerFacts = facts.filter((f) => !f.file || !existsSync(join(runDir, f.file))).length;
  let guardTripped = false;
  let unmatchedError = null;
  if (matchedFacts === 0 && defsElsewhereTotal === 0) {
    guardTripped = true;
    unmatchedError = `FACTS_UNMATCHED — 声明的 ${scannedFacts} 条事实在各自权威文件内**均未命中任何定义式**，且**权威之外也没有**任何定义（defsElsewhereTotal === 0）⇒ **事实名与定义语法不咬合**：本次「无分叉」是空转绿（扫描器一处都没咬合上），不是真的干净。` +
      '常见成因：① 权威列写的是 run 级指针，而真正的机读真源在**代码**里（见 AUTHORITY.md 的「代码类事实的写法」）' +
      '⇒ 该事实在 run 目录里本来就扫不到定义，需人工核；② 事实名是**复合类别标签**，而权威文件里是**分节标题**' +
      '（如「功能目标、验收标准、…」vs `## 功能目标` / `## 验收标准`）⇒ 完整串必然 0 命中；③ 事实名与权威文件里的写法不一致。' +
      '请先人工逐条核实，**不要**把这条当成"代码坏了"。';
  }
  const report = {
    runDir,
    files: [...new Set(facts.map((f) => f.file).filter(Boolean))],
    rows,
    scannedFacts,
    matchedFacts,
    unmatchedFacts,
    codePointerFacts,
    defsElsewhereTotal,
    unmatchedError,
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  // 退出码优先级（冻结契约 `guard.priority`）：`1`（分叉）先于 `3`（guard）；
  // `3` 只出现在**本来会返回 0** 的位置，因此既有 `0`/`1`/`2` 语义逐字未变。
  process.exit(rows.some((r) => r.divergent) ? 1 : (guardTripped ? 3 : 0));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((e) => { console.error('✗', (e && e.message) || e); process.exit(2); });
}
