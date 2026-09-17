#!/usr/bin/env node
// 锚点 / 证据校验器（批 0-1）
//
// 为什么存在：本仓库的交付物大量使用"代码级证据"引用，但行号会随并发写入分钟级失效
// （实测同一 run 内 client.js 变了 9 次、command.js 变了 4 次）。因此纪律是
// **锚点是主证据、行号只是阅读辅助**。本脚本把这条纪律变成**可失败的门禁**：
//
//   - 认两种引用形态：
//       新式：`<路径> · <锚点> [@ <行号>]`     ← 推荐
//       旧式：`<路径>:<行号>` 或 `<路径> @ <行号>`  ← 历史工件大量存在
//   - 硬失败（MISSING）：引用的**文件不存在/不可读**，或**锚点里有在目标文件里根本找不到的
//     token**（= 锚点含编造成分）
//   - 硬失败（棘轮）：**未校验（弱证据）**超过基线 ⇒ 新增弱证据即失败（数字只降不升）
//   - 软告警（DRIFT）  ：锚点命中但**行号偏离 > 容差**（并发写入所致，不算错）
//   - 软告警（LONEFILE）：裸行号引用（无锚点）—— 记数，供逐步收敛
//   - 显式豁免：**文档模板/示例不是证据**，下列两类不计入锚点引用（既不判命中也不判 MISSING）：
//       ① **路径侧**含尖括号占位符的 span（`team/<runId>/TASKS.json · <锚点>`、`<相对路径> · <锚点>`）
//       ② ``` 围栏代码块内的内容（作者用它示范"错误写法"这类反例，或贴命令输出）
//     两类豁免量都会渲染进汇总区（R22/FIND-6：豁免量必须可见，不得静默跳过）。
//
// 锚点匹配纪律（B-08D 统一规则 —— 除"逐字命中"外一切都进未校验桶，绝不称命中）：
//   - **命中只认逐字**：整条锚点必须逐字出现在目标文件里。点号形态（`a.b.c`）另认两种
//     等价写法：各段同一行内有序出现，或（`.json` 目标）各段以 `"seg"` 形式在同一 ≤50 行
//     窗口内有序出现。**没有**"各段在文件里各自出现过就算命中"的兜底（FIND-9）。
//   - **切分只按结构分隔符**（括号/斜杠/竖线/顿号/逗号）+ 空白，**且片段只能降级、不能挽救**：
//     主候选（整条锚点）没逐字命中时，片段永远不能把它抬成"命中"。
//   - **长度 < 8 或关键字（`function`/`const`/`insert:`…）的片段**：既不判命中，也不作
//     "完整性"依据；它们出现只说明**这条引用是弱证据**，一律落**未校验桶**（FIND-10）。
//   - **未校验（弱证据）**的判据是"完整性"：锚点非逐字命中时，只要它的每个**代码 token**
//     （按点号/分隔符/空白/冒号/@ 切分，含编号如 `B-01`、`15-16`）都在目标文件里出现过，
//     就落未校验桶；**只要有一个 token 在文件里根本不存在 ⇒ MISSING**（含编造成分）。
//     这样"偶然出现的小词"再也不能给编造锚点兜底，而"全部 token 都真、只是没逐字"的
//     历史写法不会变成假阳性洪峰。
//   - **锚点侧**的尖括号占位符不再静默豁免（SG-7）⇒ 落未校验桶，**可见**、受棘轮约束。
//
// 弱证据棘轮（B-08D / FIND-11；B-08E 分级；G2 加第四键）：
//   基线文件 `regression.fixtures/evidence-fragment-baseline.json` 四个 key，各自只降不升：
//   - `fragmentOnly`（未校验/弱证据，**非 references 面**）= **债务** ⇒ 超基线 **exit 1**（fail-closed）；
//   - `fragmentOnlyReferences`（**references 面**的弱证据，G2 新增）= 同一套纪律，但**独立成桶** ——
//     两个面不许合并，否则一个面的债会掩盖另一个面（references 此前根本不在扫描面里）；
//   - `exemptPlaceholder`（路径侧占位符豁免）/ `exemptFenced`（围栏豁免）= **合法的文档形态**
//     （按引用纪律教格式的模板行、作者显式声明的示例）⇒ 只做「可见 + 对比 + 告警」，**不作为失败**
//     （本仓教训：大量假阳性会让门禁被整体忽略）。
//   缺失的 key 按 0 处理：两类弱证据仍 fail-closed，豁免类只告警。
//   基线路径可用 `DSH_EVIDENCE_FRAGMENT_BASELINE` 覆写（FIND-14②）。
//
// G2 扫描面与警示通道（2026-09-17 冻结）：
//   · **默认扫描面** = `<workspace>/team/**` ∪ `<pkg>/skills/expert-team/references/**`（后者此前
//     **完全不在**校验面里 ⇒ 那些文档的锚点失效时门禁一个字都不说）；
//   · `--json` 的 `scope.{team,references}` 是**可机判**的覆盖记账：`covered:false` 时 `reason` **必填**
//     （沉默不允许 —— "没提"与"覆盖了且没问题"在输出上会完全同形）；
//   · `ignoredUnattributedWarnings` = `driftWarnings + loneLineRefs + emptyAnchors + leanAnchors
//     + exemptPlaceholder + exemptFenced`（**不含** `fragmentOnly`：它有独立 enforced 棘轮，
//     不得被并进"忽略"通道）；`N>0` 时汇总区**必然**出现「已忽略 N 条未归因警示（不计入退出码）」一行。
//   · `DRIFT` / `LONEFILE` / 空锚点 / 示意锚点 / 豁免量**不得**改成失败（并发写入导致的行号偏移
//     **不算错**；大量假阳性会让门禁被**整体忽略** —— 那比"有噪声"糟得多）⇒ 只做显式计数 + 声明。
//
// 用法：
//   node scripts/check-evidence.mjs                    # 校验 team/ 与 skills/expert-team/references/
//   node scripts/check-evidence.mjs <dir|file> [...]   # 校验指定路径（只扫传参 ⇒ 默认面不生效）
//   node scripts/check-evidence.mjs --json             # 机器可读输出
//   node scripts/check-evidence.mjs --quiet            # 只输出汇总与 MISSING
//
// 退出码：0 = 无 MISSING 且 enforced 棘轮未超基线；1 = 有 MISSING 或 enforced 棘轮超基线；2 = 用法/环境错误

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包根：独立仓布局下它同时就是仓根；monorepo 布局下是 `<repo>/packages/dsh-expert-team`。 */
const PKG_ROOT = resolve(HERE, '..');

/**
 * 工作区根：**装着 `team/` 的那个目录**。
 *
 * 这里刻意不再写死「包根的上两级」。那套算法只在原始 monorepo 布局里成立；仓库改成独立仓
 * （包根 = 仓根）之后，它会把工作区算到仓库外面去 —— 于是门禁要么扫不到东西，要么去扫
 * 旁边一个无关目录。解析顺序：
 *   ① `EXPERT_TEAM_WORKSPACE`（显式指定，CI 或特殊布局用）
 *   ② 包根本身（独立仓 / 直接在项目里跑）
 *   ③ 包根的上两级（monorepo：`<repo>/packages/<pkg>`）
 * 三处都没有 `team/` 时回退到包根，此时只是「没有工件可校验」，**不是失败**。
 */
function resolveWorkspaceRoot() {
  if (process.env.EXPERT_TEAM_WORKSPACE) return resolve(process.env.EXPERT_TEAM_WORKSPACE);
  for (const candidate of [PKG_ROOT, resolve(PKG_ROOT, '..', '..')]) {
    if (existsSync(join(candidate, 'team'))) return candidate;
  }
  return PKG_ROOT;
}
const WORKSPACE_ROOT = resolveWorkspaceRoot();

const DRIFT_TOLERANCE = 5; // 行号容差：±5 行内视为"命中且未漂移"

/**
 * 弱证据/豁免量棘轮基线（B-08D / FIND-11）：三个 key 各自只降不升，照
 * regression.fixtures/write-bypass-baseline.json 的惯例。
 * 路径可用 `DSH_EVIDENCE_FRAGMENT_BASELINE` 覆写（FIND-14②：好让"基线缺失 ⇒ fail-closed"
 * 进自动化用例，而不是只靠手工实测）。
 */
const BASELINE_FILE =
  process.env.DSH_EVIDENCE_FRAGMENT_BASELINE ||
  join(PKG_ROOT, 'regression.fixtures', 'evidence-fragment-baseline.json');

/** 读基线：缺失/损坏/缺 key ⇒ 该 key 按 0（fail-closed）。 */
function loadBaseline() {
  // `fragmentOnlyReferences` = G2 新增的**第四个** key（references 面的弱证据，独立桶）。
  // 老基线文件里没有它 ⇒ 按 **0** 处理（fail-closed：references 面新增弱证据必须当场可见/可拦）。
  const out = { present: false, fragmentOnly: 0, exemptPlaceholder: 0, exemptFenced: 0, fragmentOnlyReferences: 0 };
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  } catch {
    return out;
  }
  out.present = true;
  for (const key of ['fragmentOnly', 'exemptPlaceholder', 'exemptFenced', 'fragmentOnlyReferences']) {
    if (typeof parsed?.[key] === 'number') out[key] = parsed[key];
  }
  return out;
}

/**
 * 计算 ``` 围栏代码块覆盖的字符区间（含围栏行本身）。
 *
 * 为什么需要：文档里必须**示范错误写法**（"不要写裸文件名加锚点"）和贴模板/命令输出，
 * 这些内容天然是反例或示例。围栏块是作者**显式**声明的"这里不是证据"，
 * 语义比行内标记清晰，也不会误伤正文里的真引用 ⇒ 块内 span 一律不计为引用。
 *
 * **未闭合的围栏不做豁免（fail-closed）**：否则一个漏写的 ``` 会把它之后的全部真引用
 * 一次吞掉 ⇒ 门禁静默失明 —— 本仓明确列过"永远通过"是最危险的失效模式，
 * 所以这里宁可让作者看到几条 MISSING（补上闭合围栏即可），也不静默放行。
 */
function fencedRanges(text) {
  const ranges = [];
  const re = /^[^\S\n]*```[^\n]*$/gm;
  let open = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (open === null) open = m.index;
    else {
      ranges.push([open, m.index + m[0].length]);
      open = null;
    }
  }
  return ranges; // open !== null ⇒ 未闭合，整块**不**豁免
}

/**
 * 从一段文本里抽出全部反引号 code span 的内容。
 * 只认单反引号，跳过含换行的片段，并给 ``` 围栏块内的内容打 `fenced` 标记
 * （调用方据此豁免并**计数**——豁免量必须可见，见 R22/FIND-6）。
 */
function extractSpans(text) {
  const spans = [];
  const fenced = fencedRanges(text);
  const inFence = (i) => fenced.some(([a, b]) => i >= a && i < b);
  const re = /(?<!`)`([^`\n]+)`(?!`)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    spans.push({ raw: m[1], index: m.index, fenced: inFence(m.index) });
  }
  return spans;
}

/** 候选源文件后缀（避免把普通文本误判为文件引用）。 */
const FILE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|md|sh|py|css|html)$/i;

/**
 * 引用里常见的前缀噪音——它们是"基线代号/叙述词/省略号前缀"，不是路径的一部分。
 * 例：`B-FROZEN lib/command.js`、`我方 packages/…`、`.../agent-team/src/roster.ts`
 */
const PATH_PREFIX_NOISE = /^(?:B-FROZEN|B-SOURCE|B-FROZEN\/B-SOURCE|我方|官方|第三方|截断|见)\s+/;
const ELLIPSIS_PREFIX = /^\.\.\.\//;

/**
 * 索引（惰性构建）。分两级，因为**裸文件名在全工作区不唯一**：
 * `SKILL.md` 在工作区里有 19 个同名文件（deepseek-harness 下大量 skill 快照），
 * 唯一性判定必然失败。因此先做**包内**优先，再做工作区后缀匹配。
 */
let _pkgFileIndex = null;
function pkgFileIndex() {
  if (_pkgFileIndex !== null) return _pkgFileIndex;
  const byBase = new Map();
  const all = [];
  const walk = (dir, depth) => {
    if (depth > 9) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (FILE_EXT.test(e.name)) {
        if (!byBase.has(e.name)) byBase.set(e.name, []);
        byBase.get(e.name).push(p);
        all.push(relative(PKG_ROOT, p));
      }
    }
  };
  walk(PKG_ROOT, 0);
  _pkgFileIndex = { byBase, all };
  return _pkgFileIndex;
}

let _wsFileIndex = null;
function wsFileIndex() {
  if (_wsFileIndex !== null) return _wsFileIndex;
  const all = [];
  const walk = (dir, depth) => {
    if (depth > 9) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'browser-screenshots') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (FILE_EXT.test(e.name)) all.push(relative(WORKSPACE_ROOT, p));
    }
  };
  walk(WORKSPACE_ROOT, 0);
  _wsFileIndex = all;
  return _wsFileIndex;
}

/** 试图把一段 code span 的第一段路径解析为"工作区内的真实文件"。 */
function resolveSourceFile(candidate) {
  let cleaned = candidate.replace(/^\.\//, '').trim();
  cleaned = cleaned.replace(PATH_PREFIX_NOISE, '');
  // `.../agent-team/src/roster.ts` → 去掉省略号前缀，交给后缀匹配定位
  cleaned = cleaned.replace(ELLIPSIS_PREFIX, '');
  if (!FILE_EXT.test(cleaned)) return null;
  if (cleaned.includes('*')) return null;
  // 含空格的多半是"叙述性片段"而非路径；取其中像路径的最后一个 token
  if (cleaned.includes(' ')) {
    const tail = cleaned.split(/\s+/).filter((t) => FILE_EXT.test(t)).pop();
    if (!tail) return null;
    cleaned = tail;
  }
  for (const base of [WORKSPACE_ROOT, PKG_ROOT]) {
    const abs = isAbsolute(cleaned) ? cleaned : join(base, cleaned);
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return { abs, rel: relative(WORKSPACE_ROOT, abs), exact: true };
    } catch {
      /* 不可读则继续 */
    }
  }
  // ② 裸文件名 → **包内唯一优先**（全工作区同名文件太多，不能作为唯一性依据），再退工作区唯一
  if (!cleaned.includes('/')) {
    const inPkg = pkgFileIndex().byBase.get(cleaned) ?? [];
    if (inPkg.length === 1) return { abs: inPkg[0], rel: relative(WORKSPACE_ROOT, inPkg[0]), exact: false };
  }
  const suffix = '/' + cleaned;
  // ③ 包内相对后缀唯一（`lib/command.js`、`subagent/src/index.ts` 这类省略前缀的写法）
  const inPkgAll = pkgFileIndex().all.filter((r) => r.endsWith(suffix));
  if (inPkgAll.length === 1) {
    const abs = join(PKG_ROOT, inPkgAll[0]);
    return { abs, rel: relative(WORKSPACE_ROOT, abs), exact: false };
  }
  // ④ 工作区后缀唯一（跨包引用）
  const inWs = wsFileIndex().filter((r) => r.endsWith(suffix));
  if (inWs.length === 1) return { abs: join(WORKSPACE_ROOT, inWs[0]), rel: inWs[0], exact: false };
  return null;
}

/**
 * 左侧是否"看起来像源文件路径"。
 * 必须先做这一层判定，否则 `W1 · N 人`、`待返工 · 第 N 轮` 这类正常文案
 * 会被误判成引用（假阳性会把门禁变成噪音）。
 */
function looksLikeSourcePath(pathPart) {
  const p = pathPart.trim();
  if (p.length === 0 || p.length > 200) return false;
  if (p.startsWith('<')) return false; // 模板占位符（`<路径>`、`<相对路径>`），不是真实引用
  if (p.includes('…')) return false; // 单字符省略号同属占位
  // 允许 `.../` 前缀（表示"前缀未知，按后缀匹配"），但不允许路径中段含省略
  const stripped = p.replace(/^\.\.\.\//, '');
  if (stripped.includes('..')) return false;
  return FILE_EXT.test(stripped.replace(/^`|`$/g, ''));
}

/**
 * 从行号尾部文本里抽出起点行号。
 * 必须容忍三种真实写法（来自六份角色工件）：
 *   "@ 292"                    → 292
 *   "@ 11-24"                  → 11（区间）
 *   "@ 272-285（pm 角色块，…）" → 11 之外的解释文字，只取数字部分
 */
function leadingLineNumber(tail) {
  const m = tail.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * 判断锚点的证据强度。**只有 `meaningful` 进入硬门禁**——门禁必须只报真缺陷，
 * 否则会因为噪音太多而被忽略（本 run 的实测教训：一个 130 条假阳性的门禁等于没有门禁）。
 *
 *   - meaningful ：声称是**代码串**（ASCII 标识符/字段名/唯一片段），必须能在源码里搜到
 *   - empty      ：只有行号没有锚点（`lib/command.js · @ 1120-1158`、`· @ 137 / @ 89`）
 *   - descriptive：中文叙述式锚点（`12 个角色块`、`pm 角色块`），源码里不存在对应串
 *   - lean       ：含省略号（`… coverage: [], …`），不可能逐字命中
 */
function classifyAnchor(anchor) {
  const a = anchor.trim();
  // 只有行号/标点：把 @ / 空白 / 连字符 / 数字全部剥掉后什么都不剩
  if (a.length === 0 || /^[@\s\-–~/,、0-9]*$/.test(a)) return 'empty';
  if (a.includes('…') || a.includes('...')) return 'lean';
  // 无任何 ASCII 标识符字符（字母/下划线/点/冒号/括号）→ 纯中文叙述，无法逐字校验
  if (!/[A-Za-z_$]/.test(a)) return 'descriptive';
  return 'meaningful';
}

/**
 * 锚点候选的**结构分隔符** —— 括号/斜杠/竖线/顿号/逗号。
 *
 * ⚠ **不含空白**（B-08A）：空白是锚点内容的一部分。
 * 旧写法把空白也当分隔符，于是 `function QANonexistentProbe` 被切成
 * `function` + `QANonexistentProbe`，而 `function` 在源码里到处都是 ⇒
 * 编造的多词锚点被判"命中"（QA 实测 4/4 全绿 = 4/4 漏判）。
 * 门禁的绿必须等于"锚点真实"，所以这里只按结构分隔符切。
 */
const ANCHOR_SEP = /[（）()｜|/、,，;；]+/;

/** 片段的**最小可信长度**：更短的串在源码里几乎必然出现，**不能作为命中依据**。 */
const MIN_FRAGMENT_LEN = 8;

/**
 * 语法关键字 / 常见前缀。它们出现**连弱证据都不算**：
 * 一个锚点如果本身只是 `function`、`const`、`insert:` 这类词，它证明不了任何东西 ——
 * 这类引用等于"没写锚点"，直接 MISSING（B-08A 要求 3）。
 */
const KEYWORD_CANDIDATES = new Set([
  'function', 'const', 'let', 'var', 'if', 'else', 'return', 'async', 'await', 'class', 'export',
  'import', 'from', 'default', 'new', 'for', 'while', 'switch', 'case', 'try', 'catch', 'throw',
  'typeof', 'instanceof', 'yield', 'static', 'extends', 'delete', 'void', 'this', 'true', 'false',
  'null', 'undefined', 'insert', 'key', 'id', 'type', 'name', 'value', 'data', 'item', 'items',
  'object', 'array', 'string', 'number', 'boolean', 'config', 'options', 'result', 'error',
]);

/** 关键字/常见前缀 ⇒ 永远不作数（既不判命中，也不判弱证据）。 */
function isKeywordCandidate(candidate) {
  const v = candidate.trim().replace(/[:=]+$/, '').trim(); // `insert:` → `insert`
  return KEYWORD_CANDIDATES.has(v.toLowerCase());
}

/** 过短的候选 ⇒ 可以证明"这是个弱引用"，但**不足以支撑"命中"**（要求 3）。 */
function isShortCandidate(candidate) {
  return candidate.trim().length < MIN_FRAGMENT_LEN;
}

/** 该候选能否作为**命中依据**：够长、且不是关键字。 */
function isHitBasis(candidate) {
  return !isShortCandidate(candidate) && !isKeywordCandidate(candidate);
}

/** 候选清洗：去掉 markdown 装饰（`**`、`-`）与连接词（`的/与/和/及/或`）。 */
function cleanCandidate(s) {
  return s
    .trim()
    .replace(/^[#*\-\s]+|[#*\s]+$/g, '')
    .replace(/^(的|与|和|及|或)$/, '');
}

/**
 * 结构分隔符切分出的候选（主证据 + 结构片段）。**顺序即优先级**：
 * `out[0]` 是整条锚点（永远最长），它是**唯一的主证据**；
 * 其余片段只能证明"这是弱证据"（见 main 里的 fragmentOnly），**不能挽救成命中**。
 */
function anchorCandidates(anchor) {
  const out = [];
  const push = (s) => {
    const v = cleanCandidate(s);
    if (v.length >= 3 && !out.includes(v)) out.push(v);
  };
  push(anchor); // 主候选 = 整条锚点（最长）
  for (const piece of anchor.split(ANCHOR_SEP)) push(piece);
  return out.length > 0 ? out : [anchor];
}

// P4 清理（2026-09-13）：此处原有 `weakCandidates(anchor)`（"结构切分 + 空白切分"的弱证据候选池）。
// 它是 SG-7 修复后遗留的**死代码** —— 本文件里真正的弱证据桶由 `main` 的 `fragmentOnly` 就地构造，
// 全仓对该函数**只有定义、没有调用**（`grep -rn weakCandidates` 只命中本行）。
// 它承载的历史教训仍在：**空白切分只能用于"是不是弱证据"，绝不能用于判命中**（QA 实测：
// 旧代码把空白当分隔符 ⇒ `function QANonexistentProbe` 靠切出的 `function` 就判命中，4/4 漏判）。
// 这条边界现在由 `anchorCandidates`（只按 `ANCHOR_SEP` 切分）＋ 变异 M80 一起守着。

/**
 * 尖括号占位符（`team/<runId>/TASKS.json`、`<锚点>`、`<相对路径>`、`<行号>`）。
 *
 * **只作用于路径部分**（B-08D / SG-7）：文档模板句 `team/<runId>/TASKS.json · <锚点>`
 * 的左半边是占位路径，必须豁免（本 run 曾因此连红 4 次）。
 * 但**锚点部分的 `<…>` 不再静默豁免** —— 静默豁免会让整条引用从分母里消失
 * （SG-7 根因：旧代码在路径/锚点切分**之前**对整条 span 判占位符并 `return null`）。
 * 锚点侧含占位符 ⇒ 进「未校验（弱证据）」桶，**可见**且受棘轮约束。
 * 只认成对的 `<…>`（中间无空白），以免误伤锚点里 `=>` 这类真实代码串。
 */
const PLACEHOLDER_RE = /<[^<>\s]+>/;

/**
 * 是否"路径侧占位符"的真模板写法（`team/<runId>/TASKS.json · <锚点>`、`<lib/command.js> · <锚点>`）。
 * 只用于豁免与**豁免量计数**（R22/FIND-6）；锚点侧的尖括号走弱证据桶。
 */
function pathPlaceholderRef(span) {
  const sep = span.indexOf(' · ');
  if (sep <= 0) return false;
  return PLACEHOLDER_RE.test(span.slice(0, sep));
}

/**
 * 括号配平计数（ASCII + 全角圆括号 / 方括号 / 花括号）。
 * 用途见 parseAnchorForm：判断那个 ` @ ` 到底是行号分隔符，还是**锚点内部的文本**。
 */
function bracketBalance(s) {
  const open = (s.match(/[（(【\[{]/g) || []).length;
  const close = (s.match(/[）)】\]}]/g) || []).length;
  return open === close;
}

/**
 * 切出行号槽（reading aid）—— 返回 `{ anchor, line }`，切不出来返回 null。
 *
 * 要认的真实写法（来自六份角色工件，全都要过）：
 *   ` @ 292`、` @ 11-24`                          canonical
 *   ` @ :292`、` @ ~274`                          行号带 `:` / `~` 前缀
 *   `）@ 104-111`                                 行号紧贴右括号（**不认它，行号就会留在锚点里被当成"内容"**）
 *   `@ 272-285（pm 角色块，12 块共 @ 266-483）`    行号后跟一个括号注解
 * 判据：`@` 之前必须是空白或右括号（否则 `@` 属锚点内部文本，如邮箱式写法）。
 * ⚠ `insert:（expert-team-command @ 15-16）` 这类**括号内**的 `@ 数字`**不切**（右边不是"到结尾的
 * 空白/注解"）⇒ 它留在锚点里，成为"锚点含编造成分"的证据 ⇒ MISSING。
 */
function splitLineSlot(rest) {
  const re = /@\s*[:~]?\s*(\d+(?:\s*-\s*\d+)?)\s*(?:（[^（）]*）|\([^()]*\))?\s*$/;
  const m = rest.match(re);
  if (!m) return null;
  const at = rest.length - m[0].length + m[0].indexOf('@');
  const prev = at > 0 ? rest[at - 1] : '';
  if (prev !== '' && !/[\s）)】\]]/.test(prev)) return null;
  return { anchor: rest.slice(0, at).trim(), line: leadingLineNumber(m[1]) };
}

/** 新式：`<路径> · <锚点> [@ <行号>]` */
function parseAnchorForm(span) {
  const sep = span.indexOf(' · ');
  if (sep < 0) return null;
  const pathPart = span.slice(0, sep).trim();
  // 路径侧占位符 ⇒ 真模板/示例写法，不是证据（豁免 + 计数）
  if (PLACEHOLDER_RE.test(pathPart)) return null;
  if (!looksLikeSourcePath(pathPart)) return null;
  const rest = span.slice(sep + 3).trim();
  const slot = splitLineSlot(rest);
  let anchor = slot ? slot.anchor : rest;
  let line = slot ? slot.line : null;
  // 若 `@` 其实在锚点**内部**（`insert:（expert-team-command @ 15-16）`）：
  // 判据：按它切出来的锚点括号**不闭合**，而整段（含 ` @ 行号`）是闭合的 ⇒
  // 那个 `@` 不是行号分隔符，切了只会得到"作者没写过、也永远搜不到"的串 ⇒ 不切。
  if (line !== null && !bracketBalance(anchor) && bracketBalance(rest)) {
    anchor = rest;
    line = null;
  }
  // 空锚点（`path · @ 12`）不算"无引用"——它是"只有行号、待补锚点"，要单独统计
  if (!anchor && line === null) return null;
  return {
    pathPart,
    anchor,
    anchors: anchor ? anchorCandidates(anchor) : [],
    kind: classifyAnchor(anchor),
    line,
    // 锚点侧占位符：不豁免、不判命中，落「未校验（弱证据）」桶（SG-7）
    anchorPlaceholder: PLACEHOLDER_RE.test(anchor),
  };
}

/** 旧式：`<路径>:<行号>` 或 `<路径> @ <行号>`（可能带行号区间 12-18）。 */
function parseLineForm(span) {
  let m = span.match(/^([^\s:]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|md|sh|py)):(\d+)(?:-(\d+))?\b/);
  if (m) return { pathPart: m[1], line: Number(m[2]) };
  m = span.match(/^([^\s@]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|md|sh|py))\s*@\s*(\d+)(?:-(\d+))?/);
  if (m) return { pathPart: m[1], line: Number(m[2]) };
  return null;
}

/**
 * 该 span "本来会被当成引用"吗？
 *
 * 只用于**豁免计数**（R22/FIND-6）：`npm run gate` 这种贴在围栏里的命令
 * 本来就不会被校验，把它算进"豁免量"会让数字虚高、失去审计意义。
 * 所以两类豁免都只统计**引用形态**的 span（新式 `路径 · 锚点` / 旧式 `路径:行号`）。
 */
function isReferenceShaped(span) {
  const sep = span.indexOf(' · ');
  if (sep > 0 && looksLikeSourcePath(span.slice(0, sep))) return true;
  return parseLineForm(span) !== null;
}

const _targetTextCache = new Map();

/** 读取目标文件文本（带缓存：同一文件会被多个候选反复查询）。不可读返回 null。 */
function targetText(abs) {
  if (_targetTextCache.has(abs)) return _targetTextCache.get(abs);
  let t = null;
  try {
    t = readFileSync(abs, 'utf8');
  } catch {
    t = null;
  }
  _targetTextCache.set(abs, t);
  return t;
}

/**
 * 锚点的**代码 token**：按点号 / 结构分隔符 / 空白 / 冒号 / `@` 切分，只保留**含字母或数字**且
 * 长度 ≥3 的片段。纯中文叙述词（`过滤`、`路由`）与纯标点不是"代码声称"，排除；
 * 但编号片段（`15-16`、`B-01`）**算** —— 它们同样是锚点对源码的具体声称
 * （`insert:（expert-team-command @ 15-16）` 里的 `15-16` 就是编造成分）。
 */
function asciiTokens(anchor) {
  const out = [];
  const push = (s) => {
    const v = cleanCandidate(s);
    if (v.length < 3) return;
    // 必须是**纯 ASCII 词**：中文叙述词（`过滤`、`路由`）与"中文+数字"混写（`探针0`）都不是代码声称；
    // 而编号片段（`15-16`、`B-01`）是纯 ASCII ⇒ 算（它们同样是对源码的具体声称）。
    if (!/^[!-~]+$/.test(v)) return;
    if (!/[A-Za-z0-9_$]/.test(v)) return;
    if (!out.includes(v)) out.push(v);
  };
  for (const piece of anchor.split(/[.（()）｜|/、,，;；:：@\s]+/)) push(piece);
  return out;
}

/**
 * 「未校验（弱证据）」的判定（B-08D 统一规则的落点 · FIND-10）。
 *
 * 判据是**完整性**而不是"某个候选有多长"：
 *   - 锚点非逐字命中时，只要它的**每个 ASCII 非关键字 token 都在目标文件里出现过**，
 *     就落未校验桶（作者是把真实 token 拼在一起，只是整条没逐字）。
 *   - 只要有**一个** token 在文件里根本不存在 ⇒ 锚点含**编造成分** ⇒ 返回 null（调用方判 MISSING）。
 *
 * 为什么这样定：把"够具体"当成"某个片段 ≥8"会漏掉两类真实引用（`/decide handler`、
 * `B-01/B-02/B-03` 这类全部 token 都在、但都很短的复合锚点），把它们判红就是**新的假阳性洪峰**；
 * 而"偶然出现的某个小词就能给编造锚点兜底"才是 FIND-10 真正要堵的洞 —— 现在**任何**一个
 * 编造 token 都会直接 MISSING，无论旁边有多少真 token 陪着。
 * 长度门槛仍然生效：<8 或关键字的 token **永远不能**支撑"命中"（见 isHitBasis），
 * 关键字 token 连"完整性"都不参与。
 *
 * 返回：用于明细的引用片段（优先 ≥8 的）；null = 含编造成分；'' = 目标不可读。
 */
function findWeakEvidence(abs, anchor) {
  const tokens = asciiTokens(anchor).filter((t) => !isKeywordCandidate(t));
  if (tokens.length === 0) return null;
  const text = targetText(abs);
  if (text === null) return '';
  if (tokens.some((t) => !text.includes(t))) return null; // 有 token 根本不存在 ⇒ 编造
  return tokens.filter((t) => isHitBasis(t)).sort((a, b) => b.length - a.length)[0] ?? tokens[0];
}

/**
 * 在目标文件里查锚点；返回命中行号数组（空 = 未命中）。
 *
 * **「命中」只认逐字**（B-08D 统一规则）。三处"口音"归一化与一处结构化等价写法：
 *  1. 空白折叠：锚点 `…resume <run-id>     # 跨会话恢复` 与源码里单空格写法视为同一串
 *  2. 去尾标点：标识符后常带调用括号/引号
 *  3. 点号形态（`a.b.c`，即 JSON 嵌套键路径 / JS 属性路径）允许两种**等价于逐字**的写法：
 *       ① 各段在**同一行**内有序出现
 *       ② 目标是 `.json` 时，各段以 `"seg"` 形式在**同一个 ≤50 行窗口**内有序出现
 *          （合法用例：package.json 的 `dsh.bundle.patch` 三段在 @7-9）
 *     ⚠ 这里**没有**「各段在文件里各自出现过就算命中」的兜底 —— 那正是 review-2 的
 *     FIND-9（`state.members.round` 因三个词各自在文件里出现就被判命中）。
 *     这种"弱有序出现"只作为**未校验桶**的依据（见 segmentsOrderedPresent）。
 */
function findAnchorLines(abs, anchor) {
  const text = targetText(abs);
  if (text === null) return null; // 读不了 → 交由调用方判为 MISSING
  const lines = text.split('\n');
  const collapse = (s) => s.replace(/\s+/g, ' ').trim();
  const hits = [];
  const add = (n) => {
    if (n >= 1 && !hits.includes(n)) hits.push(n);
  };
  const needles = new Set();
  const pushNeedle = (s) => {
    const v = collapse(s);
    if (v.length >= 2) needles.add(v);
  };
  pushNeedle(anchor);
  // 去尾标点：标识符后常带调用括号/引号（`checkTasks(`、`foo;`、`x"`）——
  // 但**只剥 1 个字符**（B-08D 收紧）：旧写法用 `+` 无上限地剥，等于留了一条绕过路径
  // （`function goalKeyOf("""""` 会被剥成 `function goalKeyOf` 而"命中"）。实测本仓
  // "剥 1 个"与"剥任意个"结论完全一致（120/60/1/59/45/2），故收紧是零代价。
  pushNeedle(anchor.replace(/[(){}[\]"'`,;]$/g, ''));
  for (const needle of needles) {
    lines.forEach((line, i) => {
      if (collapse(line).includes(needle)) add(i + 1);
    });
  }
  // 点号形态：两种"等价于逐字"的写法（同行有序 / JSON 带引号键的 ≤50 行窗口）
  const dotted = anchor.trim();
  if (DOTTED_FORM.test(dotted)) {
    const segs = dotted.split('.');
    lines.forEach((line, i) => {
      if (segmentsInOrder(collapse(line), segs)) add(i + 1);
    });
    if (/\.json$/i.test(abs)) for (const n of jsonKeyWindows(lines, segs)) add(n);
  }
  return hits.sort((a, b) => a - b);
}

/** 点号形态（`a.b.c`）：JSON 嵌套键路径 / JS 属性路径的写法。 */
const DOTTED_FORM = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/;

/** JSON 嵌套键路径允许的窗口（行）。 */
const JSON_KEY_WINDOW_LINES = 50;

/** 各段是否在同一行内**有序**出现（`state.members.round` 要求 state→members→round）。 */
function segmentsInOrder(line, segs) {
  let k = 0;
  for (const s of segs) {
    const at = line.indexOf(s, k);
    if (at < 0) return false;
    k = at + s.length;
  }
  return true;
}

/** JSON 嵌套键：各段以**带引号的键**形式在同一个 ≤50 行窗口内有序出现（返回窗口起始行号）。 */
function jsonKeyWindows(lines, segs) {
  const quoted = segs.map((s) => `"${s}"`);
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    let k = 0;
    let j = i;
    for (; j < lines.length && j - i < JSON_KEY_WINDOW_LINES && k < quoted.length; j++) {
      if (lines[j].includes(quoted[k])) k++;
    }
    if (k === quoted.length) {
      starts.push(i + 1);
      i = j - 1;
    }
  }
  return starts;
}

/**
 * 点号形态的**弱**证据：各段在文件里按序出现（不要求同一行、不要求窗口）。
 * 只用于「未校验（弱证据）」桶 —— 它**永远不能**判命中（FIND-9）。
 */
function segmentsOrderedPresent(text, anchor) {
  const dotted = anchor.trim();
  if (!DOTTED_FORM.test(dotted)) return false;
  let k = 0;
  for (const s of dotted.split('.')) {
    const at = text.indexOf(s, k);
    if (at < 0) return false;
    k = at + s.length;
  }
  return true;
}

/**
 * 裸文件名被"后缀匹配"到 SPEC 模板目录时的可诊断提示。
 *
 * 为什么需要：`TASKS.json` 这类裸文件名会被解析到
 * `skills/expert-team/assets/templates/TASKS.json`（模板），于是"引用 run 目录里的 JSON"
 * 必然锚点未命中。这类写法**确实不规范**（该报 MISSING），但报错必须让人一眼看出
 * "它被解析到模板上了"，而不是以为模板内容真的对不上。
 * 注意：提示文本**不带反引号**，且目标路径用 `team/<runId>/` 占位符写法 ——
 * 这样它即便被复制进 markdown，也不会再构成一个可解析引用。
 */
function templateHint(target) {
  return /assets[\\/]templates[\\/]/.test(target.abs)
    ? '（按裸文件名匹配到 SPEC 模板；若要引用 run 目录请写全路径 team/<runId>/...）'
    : '';
}

/** 递归收集 .md 文件（跳过 node_modules / .git）。 */
function collectMarkdown(targets) {
  const out = [];
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (/(^|\/)(node_modules|\.git)$/.test(p)) return;
      for (const entry of readdirSync(p)) walk(join(p, entry));
    } else if (/\.md$/i.test(p)) {
      out.push(p);
    }
  };
  for (const t of targets) walk(t);
  return out.sort();
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const targets = argv.filter((a) => !a.startsWith('--'));

  // ── G2（BL-6 / BL-9）：默认扫描面 = `team/` **+** 随包分发的技能参考文档 ────────────────
  // 为什么要加 `references/`：那里的锚点同样是**证据性引用**（改了代码、文档里的锚点就失效），
  // 而它们不在 `team/` 下 ⇒ 此前门禁对它们**完全失明**（一个字都不说）。
  // ⚠️ **不得**把 `references` 加进任何豁免/忽略名单来消音（SPEC 边界⑧「消音即判失败」）——
  // 覆盖与否只有两种合法形态：`covered:true`，或 `covered:false` **且带 reason**（沉默不允许，R2）。
  const TEAM_DIR = join(WORKSPACE_ROOT, 'team');
  const REFERENCES_DIR = join(PKG_ROOT, 'skills', 'expert-team', 'references');
  const explicit = targets.length > 0;
  const roots = explicit ? targets.map((t) => resolve(process.cwd(), t)) : [TEAM_DIR, REFERENCES_DIR];
  // **显式**路径不存在 ⇒ 用法/环境错误（exit 2，既有语义）。**默认**扫描面里某个目录不存在**不是**
  // 用法错 —— 那是一条「没覆盖」的**事实**，交给 `scope.<name>.reason` 说出来，而不是让门禁崩掉。
  for (const r of (explicit ? roots : [])) {
    if (!existsSync(r)) {
      console.error(`✗ 路径不存在：${r}`);
      process.exit(2);
    }
  }

  const files = collectMarkdown(roots);
  if (files.length === 0) {
    console.error('✗ 未找到任何 .md 文件');
    process.exit(2);
  }

  // ── 扫描面记账（G2 · BL-9）：**沉默不允许** ────────────────────────────────────────
  // 冻结契约的 `scope` 形状（**逐字**）：
  //   `team {covered, docs}`（additionalProperties:false ⇒ **不带 reason**）
  //   `references {covered, docs, reason}`（`reason` **必填**：`covered=false` 时是非空字符串，
  //   `covered=true` 时为 **null**）。⇒ "没覆盖"永远是一条**可机判的事实**，而不是"没提"
  //   （"没提"与"覆盖了且没问题"在输出上完全同形）。
  const within = (p, dir) => { const a = resolve(p); const b = resolve(dir); return a === b || a.startsWith(b + sep); };
  const scopeOf = (dir) => {
    const covered = roots.some((r) => within(r, dir));
    return { covered, docs: covered ? files.filter((f) => within(f, dir)).length : 0 };
  };
  const uncoveredReason = (dir) => (explicit
    ? `本次是**显式**指定扫描面（${roots.map((r) => relative(WORKSPACE_ROOT, r)).join(' / ')}），其中不含 ${dir}`
    : `目录不存在或不可读：${dir}`);
  const scopeTeam = scopeOf(TEAM_DIR);
  const scopeRefs = scopeOf(REFERENCES_DIR);
  const scope = {
    team: scopeTeam,
    references: { ...scopeRefs, reason: scopeRefs.covered ? null : uncoveredReason(REFERENCES_DIR) },
  };

  const missing = [];
  const drift = [];
  const lone = [];
  const emptyAnchor = [];
  const leanAnchor = [];
  // 弱证据：整条锚点搜不到、但存在"够具体"的片段。
  // ⚠️ **这一行/这个名字是变异体锚点**：`M87` 的 `find` 串里**逐字含** `fragmentOnly.push({`，
  // 所以四个投递点**必须保持原样**（不许改名、不许换成路由函数）—— 分面在**循环之后**做。
  const fragmentOnly = [];
  let anchorsChecked = 0;
  let anchorsFound = 0;
  let lineRefsChecked = 0;
  let exemptPlaceholder = 0; // 豁免计数（R22/FIND-6）：占位符模板
  let exemptFenced = 0; // 豁免计数：围栏块内的示例/反例

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const relDoc = relative(WORKSPACE_ROOT, file);
    for (const span of extractSpans(text)) {
      // 显式豁免：只统计**引用形态**的 span（`npm run gate` 这类命令本就不会被校验）
      if (span.fenced) {
        if (isReferenceShaped(span.raw)) exemptFenced += 1;
        continue;
      }
      if (pathPlaceholderRef(span.raw)) exemptPlaceholder += 1; // 路径侧占位符 = 真模板写法
      const anchorForm = parseAnchorForm(span.raw);
      if (anchorForm) {
        const target = resolveSourceFile(anchorForm.pathPart);
        if (!target) {
          missing.push({ doc: relDoc, raw: span.raw, reason: `源文件不存在：${anchorForm.pathPart}` });
          continue;
        }
        if (anchorForm.kind === 'empty') {
          emptyAnchor.push({ doc: relDoc, raw: span.raw, reason: `只有行号、无锚点：${target.rel}` });
          continue;
        }
        if (anchorForm.kind === 'lean' || anchorForm.kind === 'descriptive') {
          leanAnchor.push({
            doc: relDoc,
            raw: span.raw,
            reason: `${anchorForm.kind === 'lean' ? '示意性引用（含省略号）' : '中文叙述式锚点'}，无法逐字校验：${target.rel}`,
          });
          continue;
        }
        anchorsChecked += 1;
        // **主证据 = 整条锚点**：只有它能判"命中"，且命中只认逐字（B-08D 统一规则）。
        const [primary] = anchorForm.anchors;
        const primaryHits = findAnchorLines(target.abs, primary);
        if (primaryHits === null) {
          missing.push({ doc: relDoc, raw: span.raw, reason: `源文件不可读：${target.rel}${templateHint(target)}` });
          continue;
        }
        // ⓪ 锚点侧尖括号占位符（SG-7）：不豁免、不判命中 ⇒ **可见的**未校验桶
        if (anchorForm.anchorPlaceholder) {
          fragmentOnly.push({
            doc: relDoc,
            raw: span.raw,
            reason: `未校验（弱证据）：锚点含尖括号占位符「${anchorForm.anchor}」，不可能逐字命中 @ ${target.rel}`,
          });
          continue;
        }
        // ① 逐字命中（含点号形态的两种等价写法）
        if (primaryHits.length > 0 && isHitBasis(primary)) {
          anchorsFound += 1;
          anchorForm.matched = primary;
          if (anchorForm.line !== null) {
            const near = primaryHits.some((h) => Math.abs(h - anchorForm.line) <= DRIFT_TOLERANCE);
            if (!near) {
              drift.push({
                doc: relDoc,
                raw: span.raw,
                reason: `行号漂移：锚点「${primary}」实际在 ${primaryHits.slice(0, 3).join('/')}，文中 ${anchorForm.line}`,
              });
            }
          }
          continue;
        }
        // ② 整条锚点**确实逐字在源码里**，只是"过短/是关键字" ⇒ 未校验：
        //    它没撒谎，不足以作证据，但也不该判 MISSING。
        if (primaryHits.length > 0) {
          fragmentOnly.push({
            doc: relDoc,
            raw: span.raw,
            reason: `锚点过于通用（弱证据）：「${anchorForm.anchor}」整条在源码里，但只是关键字/过短串，不足以判命中（未校验桶）@ ${target.rel}`,
          });
          continue;
        }
        // ③ 点号形态：各段只是"按序各自出现过"（可能跨几百行）⇒ 未校验，**永远不是命中**
        //    （FIND-9：`state.members.round` 曾因这条兜底被判命中）
        const targetBody = targetText(target.abs);
        if (targetBody !== null && segmentsOrderedPresent(targetBody, anchorForm.anchor)) {
          fragmentOnly.push({
            doc: relDoc,
            raw: span.raw,
            reason: `未校验（弱证据）：点号锚点「${anchorForm.anchor}」各段在 ${target.rel} 里按序出现过，但非逐字/非同一窗口`,
          });
          continue;
        }
        // ④ 存在一个**够具体**的片段（≥8 字符且非关键字）⇒ 未校验
        //    （FIND-10：过短/关键字的片段不作数；但这类引用仍落在未校验桶里，不判 MISSING）
        const weak = findWeakEvidence(target.abs, anchorForm.anchor);
        if (weak !== null) {
          if (weak === '') {
            missing.push({ doc: relDoc, raw: span.raw, reason: `源文件不可读：${target.rel}${templateHint(target)}` });
            continue;
          }
          fragmentOnly.push({
            doc: relDoc,
            raw: span.raw,
            reason: `仅片段命中（弱证据）：片段「${weak}」在 ${target.rel}，整条锚点「${anchorForm.anchor}」逐字搜不到（未校验桶，受棘轮约束）`,
          });
          continue;
        }
        missing.push({
          doc: relDoc,
          raw: span.raw,
          reason: `锚点未命中：${anchorForm.anchor} @ ${target.rel}${templateHint(target)}`,
        });
        continue;
      }

      const lineForm = parseLineForm(span.raw);
      if (lineForm) {
        const target = resolveSourceFile(lineForm.pathPart);
        if (!target) {
          // 只统计：旧式裸行号大量存在，且部分指向外部仓库路径，不作硬失败
          lone.push({ doc: relDoc, raw: span.raw });
          continue;
        }
        lineRefsChecked += 1;
        const hits = findAnchorLines(target.abs, span.raw.slice(span.raw.lastIndexOf(':') + 1));
        void hits;
        continue;
      }
    }
  }

  // ── 弱证据**分面**（G2 冻结口径）：`fragmentOnly` 收的是"全部扫到的弱证据"，这里按**文档位置**
  // 把它切成两个**独立桶**（在循环之后切，是为了让四个投递点保持原样 —— M87 的 find 串含它们）：
  //   · `fragmentOnlyLocal`      —— 非 references 面（team/** 与**显式传参**的面）⇒ 沿用既有基线 59
  //   · `fragmentOnlyReferences` —— references 面 ⇒ 新基线 key，独立计数、独立棘轮
  // 两桶**不许合并**：references 此前根本不在扫描面里，把它的首个计数并进 59 会让既有基线失真，
  // 而且"一个面的债掩盖另一个面"正是本批要修的形态。
  const isRefsDoc = (entry) => within(join(WORKSPACE_ROOT, String(entry.doc)), REFERENCES_DIR);
  const fragmentOnlyLocal = fragmentOnly.filter((f) => !isRefsDoc(f));
  const fragmentOnlyReferences = fragmentOnly.filter(isRefsDoc);

  // 弱证据/豁免量棘轮（照 gate:bypass 的惯例 + B-08D/FIND-11 的三键）：数字只降不升。
  // 基线文件缺失或某个 key 缺失 ⇒ **该 key 按 0 处理**（fail-closed：宁可报红，
  // 也不给"删掉基线就关棘轮"的口子）。基线路径可用 env 覆写（便于自动化验证该行为）。
  const baseline = loadBaseline();

  const summary = {
    docs: files.length,
    anchorsChecked,
    anchorsFound,
    anchorsMissing: missing.length,
    emptyAnchors: emptyAnchor.length,
    leanAnchors: leanAnchor.length,
    lineRefsChecked,
    driftWarnings: drift.length,
    loneLineRefs: lone.length,
    workspaceRoot: WORKSPACE_ROOT,
    // 只增不删（B-08A / B-08D）：既有键的**口径与数值都不许改** ⇒ 只数**非 references 面**那一桶
    fragmentOnly: fragmentOnlyLocal.length,
    fragmentOnlyBaseline: baseline.fragmentOnly,
    // G2 新增：references 面的弱证据**独立桶**（与 team 面的 `fragmentOnly` 不合并 —— 一个面的债
    // 不许掩盖另一个面；references 此前根本不在扫描面里，并进 59 会让既有基线失真）。
    fragmentOnlyReferences: fragmentOnlyReferences.length,
    fragmentOnlyReferencesBaseline: baseline.fragmentOnlyReferences,
    exemptPlaceholder,
    exemptPlaceholderBaseline: baseline.exemptPlaceholder,
    exemptFenced,
    exemptFencedBaseline: baseline.exemptFenced,
  };

  // 棘轮（B-08D 三键 → B-08E 分级 → G2 第四键）：
  //   - `fragmentOnly` = **债务**（看着像真引用、却无法逐字核验）⇒ 超基线**硬失败**（enforced）
  //   - `fragmentOnlyReferences` = **同一套纪律**，但只算 references 面的那份债（新 key，独立桶）
  //   - `exemptPlaceholder` / `exemptFenced` = **合法的文档形态**（按引用纪律教格式的模板行、
  //     作者显式声明的围栏示例）⇒ 只做"可见 + 对比 + 告警"，**不作为失败**
  //     （本仓教训：大量假阳性会让门禁被整体忽略）
  // ⚠️ 新行**追加在两行豁免之后**：既有变异体 M88/M89 的 `find` 串逐字指向 `exemptPlaceholder`
  // 与 `exemptFenced` 那**连续两行**，这里既不动它们、也不制造该串的第二处出现（否则命中 ≠ 1 直接 throw）。
  const ratchets = [
    { key: 'fragmentOnly', label: '仅片段命中（弱证据）', now: fragmentOnlyLocal.length, enforced: true },
    { key: 'exemptPlaceholder', label: '占位符豁免', now: exemptPlaceholder, enforced: false },
    { key: 'exemptFenced', label: '围栏块豁免', now: exemptFenced, enforced: false },
    { key: 'fragmentOnlyReferences', label: 'references 面弱证据（独立桶）', now: fragmentOnlyReferences.length, enforced: true },
  ].map((r) => ({ ...r, base: baseline[r.key], broken: r.now > baseline[r.key] }));
  const broken = ratchets.filter((r) => r.broken && r.enforced); // 只有 enforced 的 key 触发失败
  const drifted = ratchets.filter((r) => r.broken && !r.enforced); // 豁免类：只告警
  const ratchetBroken = broken.length > 0;

  // ── G2（BL-9）「已忽略 N 条未归因警示」：**不得沉默** ────────────────────────────────
  // 口径（冻结契约 `json.ignoredUnattributedWarnings`，**唯一真源就在这一行**）：
  //   N = driftWarnings + loneLineRefs + emptyAnchors + leanAnchors + exemptPlaceholder + exemptFenced
  // 即把**六项原值**相加 —— 它们每一个都**不进退出码**（DRIFT/LONEFILE/空锚点/示意锚点/两类豁免，
  // 全是"非失败类警示"），此前**各自有计数、却没有一处汇总**，于是"门禁全绿"与"门禁忽略了 200 条
  // 警示"在输出上很难一眼分开。
  // 刻意**不含** `fragmentOnly`（无论哪个面）：它是 **enforced** 键（超基线直接 `exit 1`），
  // 每轮都渲染「now / 基线」⇒ 它**有归属**，不是"被忽略"。把 enforced 的量并进来，
  // 会让这个数字既说不清又虚高（本仓教训：没人看得懂的指标等于没有指标）。
  // 这些量**不**改成失败是有意为之（SPEC 边界⑧ / 本仓裁定）：并发写入导致的行号偏移**不算错**，
  // 而大量假阳性会让门禁被**整体忽略** —— 那比"有噪声"糟得多。所以走"显式列出 + 计数"这条通道。
  const ignoredUnattributedWarnings = drift.length + lone.length + emptyAnchor.length + leanAnchor.length + exemptPlaceholder + exemptFenced;
  // 两个键同时进 `summary`（PLAN 契约：「summary 既有键全部保留 + 上述新键」）与顶层（PLAN 契约
  // 把 `scope` / `ignoredUnattributedWarnings` 列为 `summary` 的**兄弟**键）—— 两种读法都兼容。
  // ⚠️ 它们是**同一份值**的投影（真源只有上面这两个变量），不是两份口径。
  summary.ignoredUnattributedWarnings = ignoredUnattributedWarnings;
  summary.scope = scope;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          summary,
          scope,
          ignoredUnattributedWarnings,
          missing,
          // 既有键：口径不变（非 references 面那一桶）；G2 新增 references 面的独立明细
          fragmentOnlyRefs: fragmentOnlyLocal,
          fragmentOnlyReferencesRefs: fragmentOnlyReferences,
          ratchet: {
            baselineFile: BASELINE_FILE,
            present: baseline.present,
            rows: ratchets,
            broken: ratchetBroken,
            drifted: drifted.map((r) => r.key),
          },
          emptyAnchor,
          leanAnchor,
          drift,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('# 证据/锚点校验');
    console.log(`工作区根：${WORKSPACE_ROOT}`);
    console.log(`扫描工件：${summary.docs} 份`);
    // G2（BL-9）：扫描面**每轮**渲染 —— 「没覆盖」必须是一条可读的**事实**，不能是"没提"。
    const scopeNote = (name, s) => (s.covered ? `${name} ${s.docs} 份（已覆盖）` : `${name} 未覆盖（${s.reason}）`);
    console.log(`扫描面：${scopeNote('team/', scope.team)} · ${scopeNote('references/', scope.references)}`);
    console.log('');
    console.log(`锚点引用（可逐字校验）：${anchorsChecked} 条 —— 命中 ${anchorsFound}，未命中 ${missing.length}`);
    // R22/FIND-6：豁免量与弱证据量都必须**始终**渲染，不得静默省略；
    // FIND-14①：基线值也**每轮**打印（"偷偷抬基线"必须可见）
    console.log(`- 未校验（弱证据，受棘轮约束）：${fragmentOnlyLocal.length} 条 / 基线 ${baseline.fragmentOnly} 条`);
    // G2 新增：references 面的弱证据是**独立桶** ⇒ 必须**单独**渲染，否则它会被 team 面的数字掩盖
    console.log(`- references 面弱证据（独立桶，受棘轮约束）：${fragmentOnlyReferences.length} 条 / 基线 ${baseline.fragmentOnlyReferences} 条`);
    console.log(
      `- 豁免（不计入校验）：占位符 ${exemptPlaceholder} 条 · 围栏块 ${exemptFenced} 条（棘轮基线 ${baseline.exemptPlaceholder} / ${baseline.exemptFenced} 条）`,
    );
    if (!baseline.present) {
      console.log(
        `  ⚠ 棘轮基线文件缺失或不可解析（${BASELINE_FILE}）⇒ 四个 key 均按 0 处理：两类弱证据仍 fail-closed，豁免类只告警`,
      );
    }
    if (drifted.length > 0) {
      // 逐字形态（B-08E 裁决一）；超基线的那个用 `> 基线`，未超的用 `now / 基线`
      const fmt = (label, key) => {
        const r = ratchets.find((x) => x.key === key);
        return `${label} ${r.now} 条${r.broken ? ' >' : ' /'} 基线 ${r.base} 条`;
      };
      console.log(
        `  ⚠ 豁免量增长：${fmt('占位符', 'exemptPlaceholder')} · ${fmt('围栏块', 'exemptFenced')}（豁免是合法的文档形态，不作为失败；仅提示漂移）`,
      );
    }
    for (const r of ratchets.filter((x) => !x.broken && x.now < x.base)) {
      console.log(`  ℹ ${r.label} ${r.now} 条 < 基线 ${r.base} 条：可手动下调该基线（本脚本**不自动**下调）`);
    }
    // 弱证据未破线时不逐条刷屏（几十条会淹没真缺陷），但必须给出取明细的路子
    if (!quiet && !ratchetBroken && (fragmentOnlyLocal.length > 0 || fragmentOnlyReferences.length > 0)) {
      console.log(
        '  ℹ 弱证据明细：node scripts/check-evidence.mjs --json（fragmentOnlyRefs）；新增弱证据会让本门禁失败',
      );
    }
    console.log(`只有行号、无锚点（待补锚点）：${emptyAnchor.length} 条`);
    console.log(`示意性引用（含省略号，不可逐字校验）：${leanAnchor.length} 条`);
    console.log(`旧式裸行号引用（待逐步收敛）：${lone.length} 条`);
    console.log(`行号漂移告警（±${DRIFT_TOLERANCE} 行外，非错误）：${drift.length} 条`);
    // ── G2（BL-9）汇总区**必然**打印的一行：把"被忽略的量"汇成一个数 ──────────────────
    // 为什么必须有这一行：下面每一项**各自**都有计数，但**没有一处**告诉你"这些加起来有多少条
    // 是既没进退出码、也没被任何门禁咬住的"。缺了它，"门禁全绿"与"门禁忽略了 200 条警示"
    // 在输出上就很难一眼分开 —— 而"看不见"正是本批要修的那类缺陷。
    // **N>0 时必须出现**；这里选择**无条件**打印（N=0 也打），这样"通道存在"本身也是可见的。
    // 冻结契约要求这一行明说「不计入退出码」；文案里的 N 与 `--json` 的 `ignoredUnattributedWarnings`
    // 是**同一个变量**（不是两次计算），所以两者永远同值。
    console.log(
      `已忽略 ${ignoredUnattributedWarnings} 条未归因警示（不计入退出码）（DRIFT ${drift.length} · 裸行号 ${lone.length} · 空锚点 ${emptyAnchor.length} · 示意锚点 ${leanAnchor.length} · 占位符豁免 ${exemptPlaceholder} · 围栏豁免 ${exemptFenced}）` +
      '—— 它们**不进退出码**（并发行号偏移不算错；大量假阳性会让门禁被整体忽略），但**必须可见**，不得静默丢弃',
    );
    if (missing.length > 0) {
      console.log('');
      console.log(
        `✗ MISSING（${missing.length}）—— 证据性缺陷：文件不存在/不可读，或锚点含在目标文件里找不到的 token：`,
      );
      const shown = quiet ? missing.slice(0, 20) : missing;
      for (const m of shown) console.log(`  - [${m.doc}] ${m.raw}\n      ${m.reason}`);
      if (quiet && missing.length > 20) console.log(`  … 另有 ${missing.length - 20} 条（--quiet 截断）`);
    }
    if (ratchetBroken) {
      console.log('');
      console.log(
        `✗ 弱证据增长（棘轮）：${broken.map((r) => `${r.label} ${r.now} > 基线 ${r.base}`).join('；')} —— 新增引用必须**整条锚点**逐字命中（片段不算证据）：`,
      );
      const shownFrag = [...fragmentOnlyLocal, ...fragmentOnlyReferences];
      const shown = shownFrag.slice(0, quiet ? 20 : 30);
      for (const f of shown) console.log(`  - [${f.doc}] ${f.raw}\n      ${f.reason}`);
      if (shownFrag.length > shown.length) console.log(`  … 另有 ${shownFrag.length - shown.length} 条`);
    }
    if (!quiet && drift.length > 0) {
      console.log('');
      console.log(`⚠ DRIFT（${drift.length}）—— 锚点命中但行号漂移，由并发写入导致，不计为失败：`);
      for (const d of drift.slice(0, 20)) console.log(`  - [${d.doc}] ${d.raw}\n      ${d.reason}`);
      if (drift.length > 20) console.log(`  … 另有 ${drift.length - 20} 条`);
    }
    if (!quiet && (emptyAnchor.length > 0 || leanAnchor.length > 0)) {
      console.log('');
      console.log('ℹ 待收敛项（非失败）：');
      for (const e of [...emptyAnchor, ...leanAnchor].slice(0, 15)) console.log(`  - [${e.doc}] ${e.raw}`);
      const total = emptyAnchor.length + leanAnchor.length;
      if (total > 15) console.log(`  … 另有 ${total - 15} 条`);
    }
    console.log('');
    const failed = missing.length > 0 || ratchetBroken;
    console.log(
      failed
        ? `✗ 证据校验失败：${missing.length} 条 MISSING${
            ratchetBroken ? `；弱证据棘轮超基线（${broken.map((r) => r.label).join('、')}）` : ''
          }`
        : '✔ 证据校验通过（无 MISSING）',
    );
  }

  process.exit(missing.length === 0 && !ratchetBroken ? 0 : 1);
}

main();
