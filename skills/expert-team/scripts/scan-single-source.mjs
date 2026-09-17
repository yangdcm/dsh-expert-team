#!/usr/bin/env node
// 单源化扫描（E 线 E3 · SKILL §7.34「见一个，扫全部」）
//
// 为什么需要：本仓**头号返工源就是「一个事实多份拷贝」**——一次真实 run 里同类缺陷出现 6 次
// （白名单 10→11→12→13 漂移、`severity` 三张表、单位口径、`registry↔errors` 文案…），
// 占那批返工 14/29；而它的形态是**每次都要等下一轮评审才发现下一个实例**，没人做总扫。
// run 自己的复盘点名了这一点：「应该在做完第一个实例时就立刻总扫」。
//
// 这个脚本就是那次总扫的**机械化**：给一个"事实名"，把它在全仓的**每一处**出处定位出来，
// 并在有多个定义时**比对它们的写法是否已经分叉**。
//
// ⚠️ 口径边界（必须如实说，否则读者会以为"扫过就安全了"）：
//   ① 这是**文本级**定位：只认同名 token 与同名定义。**语义重复但改了名**的副本（最贵的形态，
//      例如 `WARNING_CODES` vs `ALERT_CODES`）**扫不出来**——那要靠人读、靠评审。
//   ② 不做跨语言/跨编码归一（如 Python 列表 vs JS 数组的**语义**等价），只比字面写法。
//   ③ 跳过 node_modules / .git / dist / build / coverage / .refactor-snapshots 与二进制/超大文件。
//   ④ 定义之间只有**写法**不同才报分叉；写法相同但意图不同，扫不出来。
//
// 用法：
//   node scan-single-source.mjs <事实名> [--root <目录>] [--json] [--max-files N]
// 退出码：
//   0 = 命中（定义或引用 ≥ 1）    1 = **未命中**（扫了但一处都没有）    2 = 用法错误
//   把"未命中"单列成非 0 是有意的：`0` 与"没扫"必须能区分（本仓两种零的老坑）。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

/** 不进入的目录（与"是不是源码"无关，纯粹是不该扫）。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.refactor-snapshots', '.dsh', '.next', 'vendor', '__pycache__',
  // 依赖/缓存目录：实测扫一个真实项目时，**32 秒里有 31 秒花在 `.venv` 上**（它还会带来一堆
  // "不是我写的副本"噪声）。这些目录一律不进 —— 它们不是"事实的出处"，只是工具的复制品。
  '.venv', 'venv', 'env', 'site-packages', '.cache', '.tox', '.mypy_cache', '.pytest_cache',
  '.idea', '.vscode', 'target', 'Pods', 'bower_components', '.terraform', '.gradle', '.nuxt', '.output',
]);
/** 只扫这些扩展名的文本文件（其余一律按二进制跳过，避免把 token 匹配到图片里）。 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonc', '.md', '.markdown',
  '.yml', '.yaml', '.txt', '.css', '.scss', '.html', '.htm', '.vue', '.svelte',
  '.py', '.php', '.rb', '.go', '.rs', '.java', '.kt', '.sh', '.bash', '.zsh',
  '.sql', '.toml', '.ini', '.cfg', '.env', '.xml', '.gradle', '.properties',
]);
/** 单文件上限：超过就跳过（并在结果里如实计入 skippedLarge）。 */
const MAX_BYTES = 2 * 1024 * 1024;

/** 正则元字符转义（事实名可能带 `[]`、`.` 等）。 */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af';
const CJK_RE = new RegExp(`[${CJK_CLASS}]`);
const WORD_CHAR = /[A-Za-z0-9_]/;

/** 事实名里是否含中日韩字符 ⇒ 决定用哪套"定义语法"与哪种边界。 */
export function isCjkFact(fact) {
  return CJK_RE.test(String(fact || ''));
}

/**
 * 构造匹配器。**这是"中文事实名命中 0"的根因所在**：
 *
 * `\b` 的词边界依赖 `\w`（= `[A-Za-z0-9_]`），而**汉字是非单词字符** ⇒ `\b变现体系\b`
 * 左右两侧永远不构成 `\w`/非`\w` 的转换，**永远匹配不到**。真实 run 的实测后果就是
 * 「`变现体系` 命中 0，而 SPEC.md 里实际有 8 处」（该 run 自己登记了 `scan:limitation`）。
 *
 * **两种事实名，两套边界**（这是有意的取舍，不是偷懒）：
 *   · ASCII 事实名（`REQUIRED_SECTIONS`、`maxItems`）⇒ 仍用 `\b…\b`：代码里词边界成立且精确，
 *     既有测试逐条钉着，不动。
 *   · **含汉字的事实名 ⇒ 按子串匹配，不加边界**。中文没有词边界，要区分
 *     `变现体系的设计`（是同一个词）与 `变现体系化`（是更长的词）**需要分词**，本脚本不做。
 *     取舍方向是**宁可多算、不可零命中**：这个脚本的用途是"把候选摊开给人看"，
 *     漏掉（零命中）会让"单源化"检查**假绿**，而多算只是多几行待人工确认。
 *     ⚠️ 因此**中文结果会包含"更长的词内部"的命中** —— 报告里如实标注，不假装是精确 token 计数。
 */
export function factMatcher(fact) {
  const f = String(fact || '');
  if (!f) return /(?!)/; // 空串永不命中（别让它变成"命中一切"）
  // ⚠️ **不要加 `g` 标志**：调用方是 `word.test(line)` 逐行判定，而带 `g` 的正则 `.test()` 会推进
  // `lastIndex` ⇒ **隔一行漏一行**（2026-09-13 我自己刚踩过：改成 `g` 之后 `变现体系化的做法` 那条
  // 断言就假红了，本质是这个有状态陷阱）。需要计数的地方请另用 `new RegExp(f, 'g')`。
  if (isCjkFact(f)) return new RegExp(escapeRegExp(f)); // 中文：子串（见上方取舍说明）
  return new RegExp(`\\b${escapeRegExp(f)}\\b`);
}

// ── 冻结段 A：表格单元格解析与"定义格"判据（模块级，放在 definitionKind() 之前）────────
// 行首的 | 与行尾的 | 各产生一个空片段 ⇒ 去空后才能得到真实单元格数。
/** 去掉被 |/｜ 切出的空片段（行首行尾各一个），返回真实单元格文本数组。 */
function tableCells(line) {
  return String(line).split(/[|｜]/).map((s) => s.trim()).filter((s) => s !== '');
}
// 显式列举，**新增状态词 = 改契约**（须回 T3）：不是模式，是有意固定的短词表。
const TABLE_STATUS_WORDS = new Set(['待定', '进行中', '已完成', '未开始', '见上', '同上', '—', '-', 'N/A']);
/** 第 2 格是否是「指针 / 状态」形态（指针与状态不是定义正文）。 */
function isDefinitionCell(cell) {
  const s = String(cell || '').trim();
  if (s === '') return false;
  if (/^\S*\.(?:md|markdown|mjs|cjs|js|ts|tsx|json|ya?ml|txt|svg)$/.test(s)) return false;
  if (TABLE_STATUS_WORDS.has(s)) return false;
  return true;
}

/**
 * D2（`BL-13`）**引用语境的判别式**（模块级；在 `definitionKind()` 里由 `isRefContext(line, fact)` 调用）。
 *
 * 为什么需要它：`BL-13` 的观测形态**不是**围栏块、也不是"行内代码 span"本身 —— 实测反例里被判成
 * 假定义的是**普通 markdown 表格行**（`| 变现体系 | 说明 | 台账行 |`）。它之所以像定义，是因为
 * **逐字引用 = 逐字复制了「定义式形状」**，而扫描器只看单行文本、看不到"这一行是在讲解/转述"。
 * ⇒ 表格行那一类由 **D1 的列数判据**负责；**D2 只负责 D1 盖不住的那一类：标记级的引用语境**。
 *
 * **判据只有"标记级"两条，一条散文关键词启发式都没有**（有意为之）：
 *   ① 行内代码 span 包住事实名：`` `…事实名…` ``；
 *   ② 块引用标记行（行首 `>`）—— PR/评审里"转述别人的表格/定义"的典型形态。
 *
 * ⚠️ **删掉的两条候选规则，各自有可证伪的理由**（本仓判据：**没有失败信号的规则视为未定义**）：
 *   · 「列表项里出现 `引用/证据/见 /参见` ⇒ 判为引用」——**散文关键词启发式**：不可枚举、不可证伪，
 *     而且它会把**合法定义** `- 变现体系：参见三大域` 漏判成引用（**方向与目标相反**：掩盖真分叉）。
 *     这条删除由断言 #9 守着。
 *   · 「表格单元格内代码 span（`| \`事实名\` | … |`）」—— **零可达性**：事实名一旦被反引号包住，
 *     `zh-table` 外层正则 `^\s*[|｜]\s*\*{0,2}<事实名>\*{0,2}\s*[|｜]`（要求 `|` 后紧跟事实名）
 *     **必然不匹配** ⇒ 无论有没有这条规则，该行都落到 `null`：**判定结果完全相同** ⇒ 它是一条
 *     不产生任何效果、也无法被证伪的规则。删掉它**不改变任何行为**（已用 `| \`变现体系\` | 说明 |`
 *     在删前/删后各实测一次，两次都是 `null`）。
 * ⚠️ **如实注明规则 ② 的作用域**：`> | … |` **匹配不上** `zh-table` 的 `^\s*[|｜]`（`\s*` 不跨 `>`）
 * ⇒ 规则 ② 实际只对 **`zh-quoted`** 形态生效（如 `> 「变现体系」：指三大域`）；它**不覆盖任何
 * `zh-table` 形态**，本实现不假装它覆盖。
 * ⚠️ **围栏块（``` / ~~~）内的行本批不做**（需跨行状态 ⇒ 动签名面）⇒ 显式登记为 `BL-23`，不是静默放过。
 */
function isRefContext(line, fact) {
  const s = String(line);
  const t = s.trim();
  // ① 行内代码 span 包住事实名：`...事实名...`
  const span = new RegExp('`[^`]*' + escapeRegExp(fact) + '[^`]*`');
  if (span.test(s)) return true;
  // ② 块引用标记行（行首 >）：PR/评审里"转述别人的表格/定义"的典型形态
  if (/^\s*>/.test(t)) return true;
  return false;
}

/** 提取一行里"看起来是定义"的那种写法；不是定义返回 null。 */
export function definitionKind(line, fact) {
  const f = escapeRegExp(fact);
  // 中文事实名走**散文物**的定义语法（标题 / 加粗定义 / 表格行 / 引用定义 / 列表项）。
  // 代码式声明（`const X =` 等）对中文散文不适用；这也让 ASCII 与 CJK 两套语义**各自独立**，
  // 不去动 ASCII 那边已被既有测试钉住的行为。
  if (isCjkFact(fact)) {
    if (new RegExp(`^\\s*#{1,6}\\s*.*${f}`).test(line)) return 'zh-heading';
    if (new RegExp(`^\\s*\\*\\*${f}\\*\\*\\s*[:：]`).test(line)) return 'zh-bold';
    // ── D2（`BL-13`）：**引用语境优先**。判定顺序（冻结）：标题 → 加粗 → **本行** → 表格 → 引号 → 列表。
    // 为什么放在这里：标题/加粗**本身就是最强的定义信号**，不该因"行内出现反引号"被翻成引用；
    // 而表格/引号/列表这三支才是台账行与逐字引用的高发形态。
    if (isRefContext(line, fact)) return null;
    if (new RegExp(`^\\s*[|｜]\\s*\\*{0,2}${f}\\*{0,2}\\s*[|｜]`).test(line)) {
      // D1（`BL-12`）：恰好 2 个单元格，且第 2 格是「定义正文」而非指针/状态。
      // ⚠️ 上面那个「行首是 |/｜ 且第 1 格就是事实名」的正则**必须作为 AND 保留** ——
      //    调用方（`scanSingleSource()` 的 `word.test(line)`）只保证"这一行里出现过事实名"，
      //    不保证它在第 1 格；丢掉它会让 `| 值A | 变现体系 |` 变成定义 = **新增假阳性**。
      const cells = tableCells(line);
      if (cells.length === 2 && isDefinitionCell(cells[1])) return 'zh-table';
    }
    if (new RegExp(`[「『]${f}[」』]\\s*[:：]`).test(line)) return 'zh-quoted';
    if (new RegExp(`^\\s*(?:[-*+]|\\d+[.、])\\s*\\*{0,2}${f}\\*{0,2}\\s*[:：]`).test(line)) return 'zh-list';
    return null;
  }
  // `export const X = …` / `function X(` / `class X` / `def X` / `async function X`
  if (new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var|function|class|def|struct|enum|type|interface)\\s+${f}\\b`).test(line)) return 'decl';
  // 顶层赋值 / Python 常量：`X = …`、`X: …`、`X := …`
  if (new RegExp(`^\\s*${f}\\s*[:=]`).test(line)) return 'assign';
  // JSON / YAML 键：`"X": …`、`X: …`
  if (new RegExp(`^\\s*["']?${f}["']?\\s*:`).test(line)) return 'key';
  return null;
}

/** 取出定义的右值（`=` 或 `:` 之后的部分），用于比对"同一个事实的两种写法"。 */
export function definitionRhs(line) {
  const i = line.search(/[:=]/);
  if (i < 0) return '';
  return line.slice(i + 1).replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim();
}

async function walk(dir, out, state) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= state.maxFiles) return;
    // 目录遍历也吃时间预算：慢盘/巨大仓库上，宁可如实报"被截断"也不要卡住编排者。
    // 用 `>=`：`--max-ms 0` 必须**立刻**算超预算（用 `>` 时同毫秒内 elapsed=0 不算超，预算形同虚设）。
    if (Date.now() - state.startedAt >= state.maxMs) { state.timedOut = true; return; }
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await walk(p, out, state);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!TEXT_EXT.has(extname(ent.name).toLowerCase())) { state.skippedExt += 1; continue; }
    let sz = 0;
    try { sz = (await stat(p)).size; } catch { continue; }
    if (sz > MAX_BYTES) { state.skippedLarge += 1; continue; }
    out.push(p);
  }
}

/**
 * 扫 `<root>` 下所有文本文件，定位 `<fact>` 的定义点与引用点。
 *
 * @param args.root - 扫描根目录（绝对路径）。
 * @param args.fact - 事实名（如 `WARNING_CODES`）。
 * @param args.maxFiles - 文件数上限（默认 20000；到顶即停，并在结果里记 truncated）。
 * @returns `{ fact, root, definitions, references, scannedFiles, skippedExt, skippedLarge, truncated, divergent, variants }`
 */
export async function scanSingleSource({ root, fact, maxFiles = 20000, maxMs = 20000, concurrency = 16 }) {
  const startedAt = Date.now();
  const files = [];
  const state = { maxFiles, skippedExt: 0, skippedLarge: 0, startedAt, maxMs, timedOut: false };
  await walk(root, files, state);
  const word = factMatcher(fact); // ASCII 用 `\b`、中文用汉字边界（见 `factMatcher` 的说明）
  const hits = [];
  const scanOne = async (abs) => {
    let text;
    try { text = await readFile(abs, 'utf8'); } catch { return; }
    // 含 NUL 的一律按二进制跳过（扩展名可能是 .md 的伪装二进制）。
    if (text.includes('\u0000')) return;
    const rel = relative(root, abs);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!word.test(line)) continue;
      hits.push({ file: rel, line: i + 1, text: line.trim() });
    }
  };
  // **有界并发**：实测在真实项目上串行读盘慢到 30 秒级（每次 fs 调用都有固定开销），
  // 而 16 路并发把同样的工作压到 1 秒级；同时仍然尊重 `maxMs` 时间预算 —— 慢盘上宁可
  // 如实报"被截断"，也不要让一条命令把编排者的回合挂死。
  let cursor = 0;
  // 同样用 `>=`（见 walk 里的注释：`--max-ms 0` 必须立刻算超预算）。
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, files.length || 1)) }, async () => {
    while (cursor < files.length) {
      if (Date.now() - startedAt >= maxMs) { state.timedOut = true; return; }
      const i = cursor;
      cursor += 1;
      await scanOne(files[i]);
    }
  });
  await Promise.all(workers);
  // 稳定输出：并发读盘会让命中顺序随机 ⇒ 统一按「文件 → 行号」排序（否则每次跑的报告都不一样）。
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const definitions = [];
  const references = [];
  for (const h of hits) {
    const kind = definitionKind(h.text, fact);
    if (kind) definitions.push({ ...h, kind });
    else references.push(h);
  }
  // 分叉检测：多个定义之间**写法**是否已经不一致（同一事实的两种右值）。
  const variants = [...new Set(definitions.map((d) => definitionRhs(d.text)).filter(Boolean))];
  return {
    fact,
    root,
    definitions,
    references,
    scannedFiles: files.length,
    skippedExt: state.skippedExt,
    skippedLarge: state.skippedLarge,
    truncated: files.length >= maxFiles || state.timedOut,
    truncatedReason: state.timedOut ? 'time' : (files.length >= maxFiles ? 'files' : ''),
    elapsedMs: Date.now() - startedAt,
    divergent: variants.length > 1,
    variants,
  };
}

/** 人读的报告（`--json` 时不走这里）。 */
export function renderReport(r) {
  const cjkNote = isCjkFact(r && r.fact) ? '（含汉字 ⇒ 按**子串**计数：可能包含更长词内部的命中，中文无词边界；宁可多算不可零命中）' : '';
  const out = [];
  out.push(`# 单源化扫描：${r.fact}`);
  out.push('');
  out.push(`- 命中：定义 **${r.definitions.length}** 处 / 引用 **${r.references.length}** 处 · 扫描 ${r.scannedFiles} 个文本文件${cjkNote}`);
  out.push(`- 跳过的非文本文件 ${r.skippedExt} 个 · 超大文件 ${r.skippedLarge} 个 · 耗时 ${r.elapsedMs} ms${r.truncated ? ` · ⚠️ **结果被截断（${r.truncatedReason === 'time' ? '超出时间预算' : '已达文件数上限'}）—— 不要把它当成"扫全了"**` : ''}`);
  out.push('');
  out.push(`## 定义点（${r.definitions.length}）`);
  out.push(r.definitions.length
    ? r.definitions.map((d) => `- \`${d.file}\`:${d.line} — ${d.text}`).join('\n')
    : '- （无：这个事实名没有任何"定义式"的写法 —— 也可能它只是一个普通变量/字符串）');
  if (r.divergent) {
    out.push('');
    out.push(`⚠️ **定义不一致（疑似分叉）：${r.definitions.length} 处定义里有 ${r.variants.length} 种写法** —— 这正是"一个事实多份拷贝"的形态，**必须当类修**：`);
    r.variants.forEach((v, i) => {
      const at = r.definitions.filter((d) => definitionRhs(d.text) === v).map((d) => `${d.file}:${d.line}`);
      out.push(`  ▸ 写法 ${String.fromCharCode(65 + i)}（${at.length} 处：${at.join('、')}）：${v.length > 160 ? v.slice(0, 160) + ' …' : v}`);
    });
  }
  out.push('');
  out.push(`## 引用点（${r.references.length}）`);
  out.push(r.references.length
    ? r.references.map((d) => `- \`${d.file}\`:${d.line} — ${d.text.length > 160 ? d.text.slice(0, 160) + ' …' : d.text}`).join('\n')
    : '- （无引用：定义了却没人用 —— 那是另一类病，见"函数写出来了但没人调用"）');
  out.push('');
  out.push('## 口径与边界（必须如实说）');
  out.push('- 只做**文本级**定位：同名 token + 同名定义。**语义重复但改了名**的副本（最贵的形态，如 `WARNING_CODES` vs `ALERT_CODES`）**扫不出来**。');
  out.push('- 定义间只有**写法**不同才报分叉；写法相同、意图不同的两份，扫不出来。');
  out.push('- 跳过 `node_modules`/`.git`/`dist`/`build`/`coverage` 等目录，以及二进制与超大文件（上面已计数）。');
  out.push('- 命中 0 处时**退出码 1** —— "未命中"与"没扫"必须能区分。');
  return out.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main(argv) {
  const args = argv.slice(2);
  // ⚠️ 不能用 `args.find((a) => !a.startsWith('--'))` —— 那会把 `--root` 的**取值**当成事实名
  // （`--root /tmp/x` ⇒ 事实名变成 `/tmp/x`），于是扫描永远"未命中"，而用户以为没有副本。
  const OPT_WITH_VALUE = new Set(['--root', '--max-files', '--max-ms']);
  let fact = null;
  for (let i = 0; i < args.length; i += 1) {
    if (OPT_WITH_VALUE.has(args[i])) { i += 1; continue; }
    if (args[i].startsWith('--')) continue;
    if (fact === null) fact = args[i];
  }
  const asJson = args.includes('--json');
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? args[rootIdx + 1] : process.cwd();
  const maxIdx = args.indexOf('--max-files');
  const maxFiles = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 20000;
  const msIdx = args.indexOf('--max-ms');
  const maxMs = msIdx >= 0 ? Number(args[msIdx + 1]) : 20000;
  if (!fact) {
    console.error('用法：node scan-single-source.mjs <事实名> [--root <目录>] [--json] [--max-files N] [--max-ms N]');
    return 2;
  }
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    console.error('--max-files 必须是正整数');
    return 2;
  }
  if (!Number.isFinite(maxMs) || maxMs < 0) {
    console.error('--max-ms 必须是非负整数');
    return 2;
  }
  const r = await scanSingleSource({ root, fact, maxFiles, maxMs });
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else console.log(renderReport(r));
  const hit = r.definitions.length + r.references.length;
  if (!hit) {
    if (!asJson) console.log(`\n✗ 未命中：全仓没有任何一处 \`${fact}\`（退出码 1）—— 先确认事实名的拼写，别把"没找到"当成"没有副本"。`);
    return 1;
  }
  return 0;
}

// 只有作为 CLI 直接运行时才跑 main（被 import 时不跑）。
if (process.argv[1] && process.argv[1].endsWith('scan-single-source.mjs')) {
  main(process.argv).then((code) => process.exit(code));
}
