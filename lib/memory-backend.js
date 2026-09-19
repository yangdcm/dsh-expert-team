/**
 * 记忆后端的**三选一**（`hindsight` / `midas` / `off`）：设置值 → 落地点 → **实际生效状态**的单一真源。
 *
 * ── 它为什么存在（先有事实，再谈设计）──────────────────────────────────────────
 * 用户原话：「记忆后端要能选 —— Hindsight / Midas / 都不用」。三种选择的落地方式**完全不同**，
 * 而且"选了"与"真生效"是两件事（本仓纪律：两种零必须分得开，这里同理）：
 *
 *   · `hindsight`（默认，= 本功能上线前的行为）：dsh profile 里挂着 Hindsight 插件行，记忆走它；
 *   · `off`：**真的**停掉 —— 唯一可靠的停法是往 dsh profile 的补丁文件
 *     （`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）写一行 `- id: hindsight` + `disabled: true`。
 *     事实来源（本机逐字读到的，不是推断）：该文件的注释写着它自己是
 *     「a top-level YAML array of load-overrides, disables, and inserts」，而现有内容就是
 *     `- id: ui-workflow-run` + `disabled: true` —— 这就是"禁用某一行"的官方写法；
 *     Hindsight 插件自己的 `cordis.patch.yml` 里 `- id: hindsight` 与包名
 *     `@vectorize-io/hindsight-coding-agents/dsh` 同样逐字可见 ⇒ **行 id 与包名都不是猜的**。
 *   · `midas`（**2026-09-19 一期：真的接线 + 五态就绪自检 + 首装引导**）：往 profile 补丁写一行
 *     `- insert:` 包裹的 `mcp-midas`（包 `@deepseek-ai/dsh-mcp-client`），并对"到底就绪没有"
 *     给一个**五态**结论（已接通 / 差一步 / 没装 / 装了起不来 / 探测不可用）。
 *     ⚠️ 三条都是**探到的事实**，不是推断（本机逐条实测 + 逐字读源码得到）：
 *       ① 包 `midas-memory-mcp`（Apache-2.0）的 bin 是 `midas-mcp` → `dist/bin/midas-mcp.js`，
 *          是个 `#!/usr/bin/env node` 启动器 ⇒ 我们**显式用 `node <绝对路径>` 启动**，
 *          不依赖 exec 位、也不靠裸名字在 PATH 里碰运气（`/Applications/ServBay/.../node/current/bin`
 *          是两跳软链，切 Node 版本后全局 bin 会**静默**离开 PATH）。
 *       ② **`MIDAS_MCP_DB` 没有默认值**：不设 ⇒ 它回落到 `InMemoryStore` ⇒ 记忆悄悄蒸发、
 *          磁盘上不落任何文件。所以这一行**必须**带上它，且目录要**先建好**
 *          （SQLite 要在里面写 `-wal`/`-shm`）。路径用本仓既有惯例：
 *          `$DSH_HOME/storages/midas/memory.sqlite3`（`DSH_HOME` 空 ⇒ `~/.dsh`）。
 *       ③ 它每次 spawn 都会往 stderr 打一行 `ExperimentalWarning: SQLite is an experimental feature`，
 *          而 MCP 客户端的 stdio 是 `['pipe','pipe','inherit']` ⇒ 这行会打到宿主 stderr。
 *          子进程 env 里给 `NODE_NO_WARNINGS=1` 即可消掉（实测有效；`NODE_OPTIONS=--no-warnings`
 *          也行，但那会影响孙进程）。
 *     上一轮那句「本轮未接通」在**未就绪的四种状态**下依然照说 —— 措辞从"本轮不做"改成
 *     "此刻没接通、缺的是哪一步"，因为**静默 no-op 仍是本仓最忌讳的形态**（用户以为换到了本地零 LLM
 *     的后端，实际还在按 token 计费）。
 *
 * ── 三条纪律（都有测试盯着）────────────────────────────────────────────────
 *   ① **最小、保真的编辑**：补丁文件是用户与**别的插件**也会写的共享文件 ⇒ 只动 `hindsight` 那一行，
 *      其余行、注释、空行**逐字保留**；看不懂的写法（流式 YAML、非 `true/false` 的 disabled…）
 *      一律**拒绝写**（`ok:false` + 原因），绝不猜着合并 —— 盲目合并 = 把用户原有的内容写没；
 *   ② **写入只能走受控入口**：`writeHostStateFileAtomic`（`lib/host-state-file.js`）。
 *      本模块**不**出现 `writeFile` / `appendFile` / `rename` 的调用（写绕过棘轮的基线是 0，
 *      且豁免面被同源锁死在两个文件里 —— 想加第三个文件必须同时改那条断言）；
 *   ③ **幂等**：同一目标状态跑两次，第二次必须 `changed:false` 且文本逐字不变
 *      （否则设置页每刷新/每保存一次就写一次盘）。
 *
 * ── 重启语义：两个"家"，不抄第二份 ──────────────────────────────────────────
 *   · Hindsight **配置文件**（`~/.hindsight/coding-agent.json`）里改 `serverMode`/`apiUrl` 需要重启，
 *     真源是 `lib/hindsight-config-write.js` 的 `HINDSIGHT_RESTART_KEYS` —— 本模块只**引用**它
 *     （放进回执的 `configRestartKeys`），**不**复制一份清单；只改 `apiToken` 免重启。
 *   · 本模块改的是 **dsh profile 补丁**：profile 在**加载时**读，所以只要这个文件变了就一定要重启
 *     `dsh web`。这不是"某个键"的语义，而是**加载时机**决定的 ⇒ 与上面那份清单是两件事，故不混用。
 */

import { access, mkdir, readFile } from 'node:fs/promises';
import { accessSync, constants as FS_CONSTANTS } from 'node:fs';
import { execFile as execFileCb, spawn as spawnCb } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { HINDSIGHT_RESTART_KEYS } from './hindsight-config-write.js';
import { getSetting } from './settings.js';
import { HOST_STATE_DIR_MODE, HOST_STATE_FILE_MODE, writeHostStateFileAtomic } from './host-state-file.js';

/** 三个后端的值域。**必须与 `lib/settings.js` 的 `memory.backend.values` 集合相等**（测试钉住）。 */
export const MEMORY_BACKENDS = Object.freeze(['hindsight', 'midas', 'off']);
/** 设置项的**限定路径**（`lib/settings.js` 是 spec 的真源，这里只是把它读出来用的那个键名）。 */
export const MEMORY_SETTING_PATH = 'memory.backend';
/** 默认后端（= 本功能上线前的行为：记忆走 Hindsight）。 */
export const DEFAULT_MEMORY_BACKEND = 'hindsight';
/** 补丁文件里那一行的 **id**（事实来源见文件头）。 */
export const HINDSIGHT_PLUGIN_ROW_ID = 'hindsight';
/** 那一行的包名（写进 notes 供人核对；本模块**不**用它来判身份 —— dsh 的 load-override 按 id 生效）。 */
export const HINDSIGHT_PLUGIN_ROW_NAME = '@vectorize-io/hindsight-coding-agents/dsh';
/** dsh home 的环境变量覆写（与 `HINDSIGHT_CONFIG` 同一惯例，测试再注入 `home`）。 */
export const DSH_HOME_ENV = 'DSH_HOME';
/** profile 名的环境变量覆写。 */
export const DSH_PROFILE_ENV = 'DSH_PROFILE';
/** 默认 profile。 */
export const DEFAULT_PROFILE = 'web';
/** 补丁文件权限（沿用宿主状态文件口径；补丁里可能带 token 之类的字段）。 */
export const MEMORY_PATCH_FILE_MODE = HOST_STATE_FILE_MODE;
/** 补丁目录权限（仅在该目录不存在、由我们创建时生效）。 */
export const MEMORY_PATCH_DIR_MODE = HOST_STATE_DIR_MODE;

// ── Midas 一期的**事实常量**（每一条都有出处，见文件头）────────────────────────
/** Midas 的 npm 包名。 */
export const MIDAS_PACKAGE = 'midas-memory-mcp';
/** 它声明的 bin 名（全局安装后落在 `<npm prefix -g>/bin/`）。 */
export const MIDAS_BIN_NAME = 'midas-mcp';
/** 显式覆写二进制路径的环境变量（**优先级最高**，给"装在奇怪位置"的用户一条路）。 */
export const MIDAS_BIN_ENV = 'MIDAS_MCP_BIN';
/** **没有默认值**的那个环境变量：不设 ⇒ Midas 用 InMemoryStore，记忆不落盘（实测）。 */
export const MIDAS_DB_ENV = 'MIDAS_MCP_DB';
/** 消掉 `ExperimentalWarning: SQLite is an experimental feature`（每次 spawn 都打，实测有效）。 */
export const MIDAS_NO_WARNINGS_ENV = 'NODE_NO_WARNINGS';
/** MCP 客户端插件（**必须装进 profile 且在 dependencies 里**，否则补丁里那一行静默不生效）。 */
export const MIDAS_MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
/** 我们写进 profile 补丁的那一行的 id（用 `mcp-` 前缀表明它是 MCP 挂载行）。 */
export const MIDAS_PATCH_ROW_ID = 'mcp-midas';
/** MCP 的 `serverName`：值域 `/^[A-Za-z0-9_-]{1,32}$/`（读 mcp-client 的 Config 得到）。 */
export const MIDAS_SERVER_NAME = 'midas';
/** 二进制相对包根的路径（bin 就是它；`dist/bin/midas-mcp.js` 是个 152 字节启动器）。 */
export const MIDAS_BIN_RELATIVE = 'dist/bin/midas-mcp.js';
/** DB 目录权限（SQLite 文件在里面，只给属主）。 */
export const MIDAS_DB_DIR_MODE = 0o700;
/** 启动探测的硬超时（有界：探测失败也不许拖住设置页）。 */
export const MIDAS_PROBE_TIMEOUT_MS = 8000;
/** stderr 摘要的截断长度（够看清原因，又不把整段警告刷进响应）。 */
export const MIDAS_STDERR_SUMMARY_MAX = 600;
/**
 * **五态**就绪模型（本仓"两种零必须分得开"的同一套纪律，只是这里分了五档）。
 * 前四档各自对应一个**不同的处置动作**，第五档刻意**不给结论**。
 */
export const MIDAS_STATUS_KINDS = Object.freeze([
  'midas-ready',
  'midas-needs-mcp-client',
  'midas-not-installed',
  'midas-start-failed',
  'unknown',
]);
/** 一期的安装命令（与 README / 客户端引导的**同一个字符串**，只此一处定义）。 */
export const MIDAS_INSTALL_COMMAND = `npm i -g ${MIDAS_PACKAGE}`;

/** 把任意异常压成一行短摘要（不抛）。 */
const errText = (e) => String((e && e.message) || e || '未知原因');
/** 错误信息里回显"出问题的那一行"时截断，避免把整份文件塞进响应。 */
const trimLine = (s) => { const t = String(s == null ? '' : s).trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t; };

/**
 * 解析 dsh home：`DSH_HOME`（去掉首尾空白；**空串按未设置算**）→ 否则 `<home>/.dsh`。
 *
 * 为什么单独成一个函数：本模块现在有**两个**路径要按同一个惯例解析（补丁文件、Midas 的 DB），
 * 两处各写一遍必然分叉（本仓头号返工源）。真源仍是宿主自己的 `DSH_HOME` 约定。
 * @param {object} [input]
 * @param {object} [input.env] - 环境变量（认 `DSH_HOME`）。
 * @param {string} [input.home] - 家目录（默认 `os.homedir()`，测试注入）。
 * @returns {string}
 */
function dshHomeDir({ env = process.env, home } = {}) {
  const base = (home && String(home)) || homedir();
  return String((env && env[DSH_HOME_ENV]) || '').trim() || join(base, '.dsh');
}

/**
 * 解析 patch 文件路径：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`。
 *
 * 两级覆写（与 `hindsightPaths()` 同一惯例）：环境变量优先，其次 `home`（测试注入），最后 `os.homedir()`。
 * @param {object} [input]
 * @param {object} [input.env] - 环境变量（默认 `process.env`；认 `DSH_HOME` / `DSH_PROFILE`）。
 * @param {string} [input.home] - 家目录（默认 `os.homedir()`）。
 * @returns {string}
 */
export function profilePatchPath({ env = process.env, home } = {}) {
  const profile = String((env && env[DSH_PROFILE_ENV]) || '').trim() || DEFAULT_PROFILE;
  return join(dshHomeDir({ env, home }), 'profiles', profile, 'cordis.patch.yml');
}

/**
 * 当前 profile 名（`DSH_PROFILE` 覆写，空串按默认）。
 *
 * 为什么导出：MCP 客户端的**安装命令里必须用它** —— 把包装进另一个 profile 等于没装
 * （补丁行与包都在同一个 profile 这一层生效）。字面写死 `web` 会在非 web profile 上给出一条错命令。
 * @param {object} [input]
 * @param {object} [input.env]
 * @returns {string}
 */
export function memoryProfileName({ env = process.env } = {}) {
  return String((env && env[DSH_PROFILE_ENV]) || '').trim() || DEFAULT_PROFILE;
}

/**
 * Midas 的 SQLite 文件路径：`$DSH_HOME/storages/midas/memory.sqlite3`（**用户批准的决定**）。
 *
 * 为什么必须由我们给出显式路径：`MIDAS_MCP_DB` **没有默认值** —— 不设 ⇒ Midas 回落到
 * `InMemoryStore`，记忆"写成功"但**悄悄蒸发**、磁盘上不留任何痕迹（实测）。这与本仓纪律
 * "两种零必须分得开"直接冲突：用户会以为记忆在，实际什么都没有。
 * 沿用 `cost-meter/ledger.json` 等同族路径的 `$DSH_HOME/storages/...` 惯例。
 * @param {object} [input]
 * @param {object} [input.env]
 * @param {string} [input.home]
 * @returns {string}
 */
export function midasDbPath({ env = process.env, home } = {}) {
  return join(dshHomeDir({ env, home }), 'storages', 'midas', 'memory.sqlite3');
}

/** 顶层数组项的行首（`- ` 或单独一个 `-`）。 */
const ROW_HEADER_RE = /^-(\s|$)/;
/** 严格认识的 `disabled` 写法（其余写法一律拒绝 —— 猜错一次就是"以为关了其实没关"）。 */
const DISABLED_RE = /^\s*disabled\s*:\s*(true|false)\s*$/;
/** `key: value` 形状的 id 行（值不允许带引号/空格 —— 带引号的写法人眼少见、我们也不猜）。 */
const ID_RE = /^id\s*:\s*(\S+)\s*$/;
/** 缩进里出现 `disabled:` 但写法不是 `true/false` ⇒ 拒绝（见 DISABLED_RE 的注释）。 */
const DISABLED_LOOSE_RE = /^\s*disabled\s*:/;

/**
 * 把补丁文件文本**只读地**解析成顶层 row 列表（不产生任何新文本、不做 IO）。
 *
 * 只认块式（block）写法：见文件头纪律① —— 流式 YAML（`- {id: x}`）出现即报错并拒绝写。
 * 关键细节：`disabled` 与 `id` **只在"这一行自己的键层级"上认**。补丁里合法的
 * `- insert:` 行内嵌着另一层 `- id: …` / `disabled: …`（缩进更深），把内层的键当成外层的
 * 会让"这一行"的身份/状态判错 —— 那正是"以为关了其实没关"的来源。
 *
 * @param {string} text
 * @returns {{rows: Array<object>, errors: string[]}}
 */
function parseRows(text) {
  const raw = String(text == null ? '' : text);
  const lines = raw.split('\n');
  const rows = [];
  const errors = [];
  if (raw.trim() === '') return { rows, errors };      // 空文件 = 空的顶层数组（合法）
  // `[]`：YAML 里"空数组"的**显式**写法，含义与空文件**相同**（零个顶层覆盖项）。但下面那条
  // "带 `[`/`{` 的顶层行 = 流式 YAML ⇒ 拒绝"的规则会把 `[` 当成流式语法而报错 —— 对 `[]` 那是**误判**
  // （里面没有任何内容可以让我们猜错）。⚠️ 只放行**恰好** `[]` 这一种形状：带任何内容的 `[…]` 照旧拒绝。
  // 为什么这里必须放行：`planMidasRowRemoval()` 在"删完一条顶层项都不剩"时写的正是这个值，
  // 而它出口的自检要能读懂自己写出来的东西（否则那条守卫会把正确结果判成"形态不认识"）。
  if (raw.trim() === '[]') return { rows, errors };

  /** 收尾一行 row：算出它自己的键层级（缩进最小的那些行）。 */
  const seal = (row) => {
    let keyIndent = null;
    for (let i = row.start; i <= row.end; i += 1) {
      const l = lines[i];
      const t = l.trim();
      if (t === '' || l.startsWith('#')) continue;
      const indent = l.match(/^\s*/)[0].length;
      if (i === row.start) continue;                   // 表头行自带 `- `，它以 '-' 开头（缩进 0）
      if (keyIndent === null || indent < keyIndent) keyIndent = indent;
    }
    row.keyIndent = keyIndent === null ? null : keyIndent;
    // 表头行上直接写 `- id: x`（本机真实文件的写法）
    const rest = row.header.replace(/^-\s?/, '');
    const headId = ID_RE.exec(rest);
    if (headId) row.id = headId[1];
    for (let i = row.start + 1; i <= row.end; i += 1) {
      const l = lines[i];
      const t = l.trim();
      if (t === '' || l.startsWith('#')) continue;
      const indent = l.match(/^\s*/)[0].length;
      if (row.keyIndent !== null && indent !== row.keyIndent) continue;   // 更深的缩进 = 内层，不认
      const m = DISABLED_RE.exec(l);
      if (m) { row.disabled = m[1] === 'true'; row.disabledLine = i; continue; }
      // `-` 单独一行时，id 写在 body 里（`-` + 换行 + `  id: x`）
      if (!row.id && ID_RE.test(t)) row.id = ID_RE.exec(t)[1];
      if (DISABLED_LOOSE_RE.test(l) && !m) row.disabledLoose.push(i);
    }
  };

  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indented = /^\s/.test(line);
    const blank = line.trim() === '';
    const comment = /^\s*#/.test(line);
    if (blank || comment) {
      // 顶格的注释/空行是**行与行之间**的分隔 ⇒ 不属于任何 row（因此永远不会被我们改写，逐字保留）；
      // 缩进的注释/空行属于当前 row，跟着它一起保留。
      if (!indented) { if (cur) { seal(cur); rows.push(cur); cur = null; } }
      else if (cur) cur.end = i;
      continue;
    }
    if (!indented) {
      if (!ROW_HEADER_RE.test(line)) {
        errors.push(`第 ${i + 1} 行不是顶层数组项（本文件应当是 \`- …\` 的顶层 YAML 数组）：${trimLine(line)}`);
        if (cur) { seal(cur); rows.push(cur); cur = null; }
        continue;
      }
      if (cur) { seal(cur); rows.push(cur); }
      if (/[{[]/.test(line.replace(/^-\s?/, ''))) {
        errors.push(`第 ${i + 1} 行用了流式（flow）YAML —— 本模块只认块式写法，拒绝猜测：${trimLine(line)}`);
      }
      cur = { start: i, end: i, header: line, id: null, disabled: null, disabledLine: -1, disabledLoose: [], keyIndent: null };
      continue;
    }
    if (!cur) {
      errors.push(`第 ${i + 1} 行是缩进内容，但它上面没有 \`- …\` 开头的顶层项：${trimLine(line)}`);
      continue;
    }
    cur.end = i;
  }
  if (cur) { seal(cur); rows.push(cur); }

  for (const row of rows) {
    for (const i of row.disabledLoose) {
      errors.push(`第 ${i + 1} 行的 \`disabled\` 写法本模块不认识（只认 \`disabled: true\` / \`disabled: false\`）⇒ 拒绝写入：${trimLine(lines[i])}`);
    }
    if (/[{[]/.test(row.header.replace(/^-\s?/, ''))) { /* 已在上面记过错误 */ }
  }
  return { rows, errors };
}

/** 从解析出来的 row 列表里找 Hindsight 那一行。 */
const findHindsightRow = (rows) => rows.find((r) => r.id === HINDSIGHT_PLUGIN_ROW_ID) || null;

// ── Midas：二进制**分层发现**（顺序即优先级，每一层都写进 `tried`）─────────────────────
//
// 为什么非要"分层 + 绝对路径"：本机 `/Applications/ServBay/package/node/current/bin` 是**两跳软链**
// 到 `24.14.0/bin` ⇒ 靠 PATH 找裸名字今天能work纯属运气；用户切一次 Node 版本，全局 bin 就**静默**
// 离开 PATH。所以结论必须是**绝对路径**，并且由我们显式 `node <abs-path>` 启动
// （包里那个 bin 是 `#!/usr/bin/env node` 启动器，但"有没有 exec 位"不该成为能不能跑的前提）。
//
// 顺序（由强到弱，与需求逐条对应）：
//   ① `MIDAS_MCP_BIN` —— 用户显式覆写，最高优先级；
//   ② `npm prefix -g` + `/bin/midas-mcp` —— ⚠️ **`npm bin -g` 在 npm 11 已被删除**
//      （实测 `Unknown command: "bin"`），所以只能由 `prefix` 推；
//   ③ 显式候选：`$DSH_HOME/midas/node_modules/...`、`<workspace>/.midas-runtime/node_modules/...`、
//      `/opt/homebrew/bin/midas-mcp`、`/usr/local/bin/midas-mcp`；
//   ④ PATH 逐目录扫 `midas-mcp`；
//   ⑤ `createRequire(import.meta.url).resolve('midas-memory-mcp/dist/bin/midas-mcp.js')` **最后**
//      —— Node 只从本插件目录**向上**找，**永远找不到全局安装**，所以它排最后只当兜底。
/** 裸名字候选的固定位置（③）：与"npm 全局"分开列，便于用户一眼看懂我们找过哪。 */
const MIDAS_FIXED_BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];

/**
 * **候选清单**（纯函数、不碰文件系统、不 spawn 任何进程）：按发现顺序返回 `{via, path}`。
 *
 * @param {object} [input]
 * @param {object} [input.env] - 环境变量（认 `MIDAS_MCP_BIN` / `PATH` / `DSH_HOME`）。
 * @param {string} [input.home] - 家目录（测试注入）。
 * @param {string} [input.workspace] - 工作区根（用来找 `.midas-runtime`；空则跳过这一层）。
 * @param {string} [input.globalPrefix] - `npm prefix -g` 的结果（由异步层传进来 ⇒ 本函数保持纯）。
 * @returns {Array<{via: string, path: string}>}
 */
export function midasBinaryCandidates({ env = process.env, home, workspace, globalPrefix } = {}) {
  const out = [];
  const push = (via, path) => {
    const p = String(path == null ? '' : path).trim();
    if (!p) return;
    if (out.some((c) => c.path === p)) return;      // 同一条路径只报**最先**（最专）的那一层
    out.push({ via, path: p });
  };
  const override = String((env && env[MIDAS_BIN_ENV]) || '').trim();
  if (override) push(`env:${MIDAS_BIN_ENV}`, override);
  const prefix = String(globalPrefix == null ? '' : globalPrefix).trim();
  if (prefix) push('npm-global', join(prefix, 'bin', MIDAS_BIN_NAME));
  const dshHome = dshHomeDir({ env, home });
  push('dsh-home', join(dshHome, 'midas', 'node_modules', MIDAS_PACKAGE, MIDAS_BIN_RELATIVE));
  const ws = String(workspace == null ? '' : workspace).trim();
  if (ws) push('workspace', join(ws, '.midas-runtime', 'node_modules', MIDAS_PACKAGE, MIDAS_BIN_RELATIVE));
  for (const dir of MIDAS_FIXED_BIN_PATHS) push(`fixed:${dir}`, join(dir, MIDAS_BIN_NAME));
  for (const dir of String((env && env.PATH) || '').split(delimiter)) {
    const d = dir.trim();
    if (d) push('path', join(d, MIDAS_BIN_NAME));
  }
  return out;
}

/** 包安装目录：`<pkg>/dist/bin/midas-mcp.js` ⇒ `<pkg>`；认不出这个形状就退回它的父目录。 */
export function midasInstallDir(binPath) {
  const p = String(binPath == null ? '' : binPath);
  const m = /^(.*)[\\/]dist[\\/]bin[\\/][^\\/]+\.js$/.exec(p);
  return m ? m[1] : dirname(p);
}

/** 同步存在性判定：`true` / `false`（**确定不存在**）/ `null`（检查本身失败 ⇒ 不能据此下"没装"的结论）。 */
function midasPathVerdictSync(p) {
  try { accessSync(p, FS_CONSTANTS.F_OK); return true; }
  catch (e) {
    const code = String((e && e.code) || '');
    // ENOENT / ENOTDIR = "确实没有"；EACCES 等 = "探测失败"，两者**不能混为一谈**。
    return (code === 'ENOENT' || code === 'ENOTDIR') ? false : null;
  }
}

/**
 * **同步、不 spawn 任何子进程**的轻量发现（给加载期那条"推荐插件"自检用）。
 *
 * 为什么另有一个同步入口：加载期自检（`detectOptionalPlugins`）跑在 `apply()` 之后的**有界延迟重探**里，
 * 而"探测必须在有界延迟 + 事件驱动里做、不许在 apply 当刻"是这条线踩过的坑。更关键的是：
 * 在加载期 path 上 spawn 一个 `npm prefix -g`（几百毫秒、还可能没有 npm）**会卡住事件循环**。
 * 所以这里刻意只用**不 spawn 的层**（①③④，含 `MIDAS_MCP_BIN`），跳过"npm 全局"与 `require` 两层 ——
 * 候选清单仍出自上面那**同一个** `midasBinaryCandidates()`（不复制第二份路径表），
 * 少的两层由设置页那条**完整**发现（`discoverMidasBinary`）补上，并如实标注。
 * @param {object} [input]
 * @param {object} [input.env]
 * @param {string} [input.home]
 * @param {string} [input.workspace]
 * @param {object} [input.io] - 注入 `{isFileSync}`（测试用；默认走真实的 `accessSync`）。
 * @returns {{found: boolean, path: string|null, via: string|null, tried: string[], probeOk: boolean, layer: string}}
 */
export function probeMidasBinarySync({ env = process.env, home, workspace, io } = {}) {
  const cands = midasBinaryCandidates({ env, home, workspace });
  const verdictOf = (io && io.isFileSync) || midasPathVerdictSync;
  const tried = [];
  let examined = 0;
  for (const c of cands) {
    let v;
    try { const raw = verdictOf(c.path); v = raw === true ? true : (raw === false ? false : null); } catch { v = null; }
    if (v === null) { tried.push(`${c.via}: ${c.path}（检查失败）`); continue; }
    examined += 1;
    if (v) return { found: true, path: c.path, via: c.via, tried, probeOk: true, layer: 'sync' };
    tried.push(`${c.via}: ${c.path}`);
  }
  return { found: false, path: null, via: null, tried, probeOk: examined > 0, layer: 'sync' };
}

/** `npm prefix -g` 的结果缓存（模块级：它极少变，而每次设置页 GET 都 spawn 一次 npm 是不可接受的）。 */
let NPM_PREFIX_CACHE = null;
/** 测试用：清掉 npm prefix 缓存（免得用例之间互相污染）。 */
export function _resetMidasDiscoveryCache() { NPM_PREFIX_CACHE = null; }

/**
 * `npm prefix -g` ⇒ 全局安装前缀（失败返回 `''`，**不抛**）。
 * ⚠️ 不能用 `npm bin -g`：npm 11 起该命令已删除（实测 `Unknown command: "bin"`）。
 * @returns {Promise<string>}
 */
async function npmGlobalPrefix() {
  if (NPM_PREFIX_CACHE !== null) return NPM_PREFIX_CACHE;
  try {
    const execFile = promisify(execFileCb);
    const { stdout } = await execFile('npm', ['prefix', '-g'], { timeout: 5000, encoding: 'utf8' });
    NPM_PREFIX_CACHE = String(stdout || '').trim();
  } catch {
    NPM_PREFIX_CACHE = '';          // npm 不在 PATH / 超时 / 非零退出 ⇒ 这一层不可用（其余层照常）
  }
  return NPM_PREFIX_CACHE;
}

/** `import.meta.url` → 本插件目录下的解析器：只为"最后一层兜底"服务（见下面的注释）。 */
const MIDAS_REQUIRE = createRequire(import.meta.url);

/**
 * 完整的分层发现（**异步**：第②层要跑 `npm prefix -g`）。**绝不抛**。
 *
 * 返回 `{found, path, realPath, via, tried, probeOk, notes}`：
 *   · `via` 命中哪一层（诚实：永远告诉用户"凭什么认为它在"）；
 *   · `tried` 逐条记下找过哪里、哪一层为什么没用（**不许静默失败**）；
 *   · `probeOk:false` 表示所有存在性检查**都失败**了 ⇒ 调用方**不得**据此下"没装"的结论（应为 unknown）。
 * @param {object} [input]
 * @param {object} [input.env]
 * @param {string} [input.home]
 * @param {string} [input.workspace]
 * @param {object} [input.io] - 注入 `{isFile, realpath, resolvePackage}`（测试用；默认走真实 fs/require）。
 * @param {function} [input.getGlobalPrefix] - 注入 `npm prefix -g`（测试用；默认真的去跑 npm）。
 * @returns {Promise<object>}
 */
export async function discoverMidasBinary({ env = process.env, home, workspace, io, getGlobalPrefix } = {}) {
  const tried = [];
  const notes = [];
  const isFile = (io && io.isFile) || (async (p) => {
    try { await access(p, FS_CONSTANTS.F_OK); return true; }
    catch (e) { const code = String((e && e.code) || ''); if (code === 'ENOENT' || code === 'ENOTDIR') return false; throw e; }
  });
  const realpath = (io && io.realpath) || null;

  let globalPrefix = '';
  try {
    globalPrefix = String(await (getGlobalPrefix ? getGlobalPrefix() : npmGlobalPrefix()) || '').trim();
  } catch (e) {
    notes.push(`取不到 \`npm prefix -g\` ⇒ 跳过"全局 bin"这一层（其余层照常）：${errText(e)}`);
  }

  const cands = midasBinaryCandidates({ env, home, workspace, globalPrefix });
  let examined = 0;
  const accept = async (hit, via) => {
    let realPath = hit;
    if (realpath) { try { realPath = String(await realpath(hit)) || hit; } catch { realPath = hit; } }
    return { found: true, path: hit, realPath, via, tried, probeOk: true, notes };
  };
  for (const c of cands) {
    let verdict;
    try { verdict = (await isFile(c.path)) ? 'yes' : 'no'; }
    catch (e) { verdict = 'err'; notes.push(`检查 ${c.path} 时出错（这一层不算命中，也不算"没装"）：${errText(e)}`); }
    if (verdict === 'err') { tried.push(`${c.via}: ${c.path}（检查失败）`); continue; }
    examined += 1;
    if (verdict === 'yes') return accept(c.path, c.via);
    tried.push(`${c.via}: ${c.path}`);
  }

  // ⑤ 最后一层：只有本插件**自己**的依赖树里有这个包时才可能命中（Node 只向上找）。
  let resolved = null;
  const resolvePackage = (io && io.resolvePackage) || (() => MIDAS_REQUIRE.resolve(`${MIDAS_PACKAGE}/${MIDAS_BIN_RELATIVE}`));
  try { resolved = String(resolvePackage() || '').trim() || null; }
  catch (e) {
    notes.push(`\`require.resolve('${MIDAS_PACKAGE}/${MIDAS_BIN_RELATIVE}')\` 解析不到（Node 只从本插件目录向上找 ⇒ **找不到全局安装**，这是预期的）：${errText(e)}`);
  }
  if (resolved) {
    let ok = false;
    try { ok = !!(await isFile(resolved)); examined += 1; } catch { ok = false; }
    if (ok) return accept(resolved, 'require');
    tried.push(`require: ${resolved}`);
  }

  return { found: false, path: null, realPath: null, via: null, tried, probeOk: examined > 0, notes };
}

/** 把发现结果压成一句**人话**（给界面用：不要让人去看 JSON）。 */
function midasLookedAt(bin) {
  const list = (bin && Array.isArray(bin.tried) ? bin.tried : []);
  const head = list.slice(0, 8).join('；');
  const more = list.length > 8 ? `；…（共 ${list.length} 处）` : '';
  return head + more;
}

// ── Midas 的补丁行（**必须**裹在 `- insert:` 里）──────────────────────────────────
//
// 事实来源（逐字读宿主源码 `@deepseek-ai/dsh-app-boot` 的 `applyEntryPatches`）：
//   · `if (insert) { if (id) {...} else data.push(...insert); ... }` ⇒ **不带 id 的 `- insert:`
//     把内层条目追加到顶层**（这就是"插入一行插件"的写法）；
//   · 其余分支 `if (!id) { warn('patch: id is required for non-insert patches'); continue; }`
//     且 `entryMap.get(id)` 找不到目标就 **warn + skip** ⇒ 一条**裸** `- id: mcp-midas` 行是
//     "覆盖一个不存在的条目"，会被**静默跳过**（这正是需求里点名的坑）。
//   · 内层条目形状 `{id, name, config}`：`config` 就是交给插件 Config schema 的那个对象
//     （loader 里 `this.options.config`）。
// 于是：`command: 'node'` + `args: [<绝对路径>]`（见文件头①），`env` 里**必须**带 `MIDAS_MCP_DB`
// 与 `NODE_NO_WARNINGS`，`cwd` 显式给 Midas 自己的安装目录（默认 `''` 会继承**宿主**的 cwd）。
/** YAML 单引号标量（内部的 `'` 按 YAML 规则写成两个）。为什么不用双引号：路径里可能出现 `\`，单引号里它是字面量。 */
function yamlQuote(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;
}

/**
 * 生成 mcp-midas 那一行的**行数组**（纯函数；调用方负责缩进拼接与落盘）。
 * @param {object} input
 * @param {string} input.binPath - 二进制的**绝对**路径。
 * @param {string} input.installDir - Midas 的安装目录（写成显式 `cwd`）。
 * @param {string} input.dbPath - SQLite 文件路径（写进 `MIDAS_MCP_DB`，**没有默认值**）。
 * @param {string} [input.serverName]
 * @returns {string[]}
 */
export function midasPatchRowLines({ binPath, installDir, dbPath, serverName = MIDAS_SERVER_NAME } = {}) {
  return [
    '- insert:',
    `    - id: ${MIDAS_PATCH_ROW_ID}`,
    `      name: ${yamlQuote(MIDAS_MCP_CLIENT_PACKAGE)}`,
    '      config:',
    "        transport: 'stdio'",
    `        serverName: ${yamlQuote(serverName)}`,
    "        command: 'node'",
    '        args:',
    `          - ${yamlQuote(binPath)}`,
    `        cwd: ${yamlQuote(installDir)}`,
    '        env:',
    `          ${MIDAS_DB_ENV}: ${yamlQuote(dbPath)}`,
    `          ${MIDAS_NO_WARNINGS_ENV}: '1'`,
  ];
}

/** 缩进整块：把规范块（行首 4 空格）平移到目标缩进（`- insert:` 之下的内层行）。 */
/** 把规范内层块（基准缩进 4）重排到目标缩进：先剥掉那 4 格、再加回目标格数（**不能**用"加/减空格数"，那会读错方向）。 */
const reindent = (lines, indent) => lines.map((l) => `${' '.repeat(indent)}${l.slice(4)}`);

/**
 * 在文本里找**内层**的 `mcp-midas` 行（顶层写法不算 —— 那条会被 dsh 静默跳过，见上）。
 *
 * 为什么不用 `parseRows()`：它只枚举**顶层**数组项，而我们要找的这行在 `- insert:` 的**内层**。
 * 这里只做一件可复核的事：找到 `^\s+- id: mcp-midas$`，再把该行后面"比它缩进更深"的**内容行**
 * 一并算作它的块。
 *
 * ⚠️ 块尾**不吞末尾空行**（只吞夹在内容行之间的空行）：`{start,end}` 要能**逐字**代表这一行本身 ——
 * 否则"幂等比对"会把 `\n` 也算成差异 ⇒ 每次保存都写一次盘（本仓幂等纪律，2026-09-19 实测踩到）。
 * @param {string} text
 * @returns {{start: number, end: number, indent: number, lines: string[]}|null}
 */
export function findMidasInsertRow(text) {
  const lines = String(text == null ? '' : text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s+)- id:\s*mcp-midas\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.trim() === '') continue;                                  // 空行先跳过（可能是块内分隔，也可能是块后空行）
      const ind = l.match(/^\s*/)[0].length;
      if (ind <= indent) break;                                        // 回到同级/更外层 ⇒ 这一块结束
      end = j;                                                         // 只有**更深缩进的内容行**才延伸块尾
    }
    return { start: i, end, indent, lines: lines.slice(i, end + 1) };
  }
  return null;
}

/** 文本里是否有**顶层**（缩进 0）的 `- id: mcp-midas` —— 那种写法是覆盖、不会生效，得如实告知。 */
const hasTopLevelMidasRow = (text) => /^- id:\s*mcp-midas\s*$/m.test(String(text == null ? '' : text));

/**
 * **纯函数**：算出"这次要不要写、写成什么"（不碰文件系统 —— 读写在 `applyMemoryBackend`）。
 *
 * ── 语义（2026-09-19 二期：**三档都是"两行都管"的真二选一**）────────────────────────
 * 设置值是用户**声明**的唯一意图，而记忆后端**只有两个**（Hindsight 插件行 × Midas 的 MCP 挂载行）
 * ⇒ 三档各自把**两行**都写到一个确定的状态，不留"两个后端同时活着、界面却说只开了一个"的中间态：
 *
 *   | 设置        | `- id: hindsight` 行        | `- insert:` 包裹的 `mcp-midas` 行     |
 *   |-------------|-----------------------------|---------------------------------------|
 *   | `hindsight` | **启用**（删规范行 / 置 false） | **移除**                              |
 *   | `midas`     | **禁用**（**仅当 Midas 真的接上了**） | 插入/替换（二进制找得到时）           |
 *   | `midas`（二进制没找到） | **启用**（一个都不许关） | **不写**（写了就是"假接通"）        |
 *   | `off`       | **禁用**                    | **移除**                              |
 *
 * ⚠️ `midas` 那一格的**条件性**是本函数最要紧的一条（旧注释里那句"为什么 midas 也这样"只对**未接通**
 * 那一半成立，二期把它收紧成条件）：二进制没找到时我们**不写** MCP 行（写一条指向不存在命令的行 =
 * 假接通），那时若顺手把 Hindsight 关掉，用户就**同时失去两个后端** —— 那仍是最坏的结果。所以
 * "禁用 Hindsight" 的前提是"Midas 真的接上了（有 `opts.midas` = 那一行马上要被写进去）"。
 *
 * 编辑策略（**保守优先**，每一处都有注释说明为什么这么选）：
 *   · Hindsight 那一行：`off` / `midas`（已接线）⇒ 改成/补成 `disabled: true`；`hindsight` /
 *     `midas`（未接线）⇒ 若是**我们自己的规范形态**（逐字等于 `- id: hindsight` + `  disabled: true`）
 *     就**整行删掉**（文件回到"没有 override"的状态），否则只把 `disabled: true` 改成 `false`
 *     —— 那一行可能夹着别的键、可能是别的插件写的，整行删除比改一个值冒险得多。
 *   · MCP 行：`midas`（已接线）⇒ 插入/替换 `- insert:` 包裹的那一行（命令 / args / env / cwd 全部
 *     **显式**，见 `midasPatchRowLines`）；其余各档（含 `midas` 未接线）⇒ **移除**，且一律**复用**
 *     `planMidasRowRemoval()`（兄弟普查 / 块形自检 / 出口自检都住在那里，只有**一个家**）。
 *
 * 出口处还有一道**自检**（这是本函数最值钱的一步）：把生成的新文本**只读地回读一遍**，
 * 确认它真的编码了请求的状态（Hindsight 那一行的启用位 **和** MCP 行在不在**两件一起**）；
 * 不一致就 `ok:false`、**一个字节都不落盘** —— "用户选了 hindsight 却被写成禁用"是这条路径上
 * 最坏的结果，宁可不写。
 *
 * @param {string|null} existingText - 现有补丁文件文本（`null`/空 ⇒ 视为"文件还不存在"= 空数组）。
 * @param {string} backend - `hindsight` / `midas` / `off`。
 * @param {object} [opts]
 * @param {object} [opts.midas] - `midas` 专用：`{binPath, installDir, dbPath, serverName}`（三个路径值**都要非空**）。
 * @returns {{ok: boolean, changed: boolean, text: string|null, errors: string[], notes: string[], backend: string}}
 *   `ok:true` 时 `text` 是**目标内容**（`changed:false` 时 = 原文本，调用方不应写盘）；
 *   `ok:false` 时 `text` 恒为 `null`（拒绝写入）。
 */
export function planMemoryBackendPatch(existingText, backend, opts = {}) {
  const target = String(backend == null ? '' : backend);
  const notes = [];
  const refuse = (errors) => ({ ok: false, changed: false, text: null, errors, notes, backend: target });
  if (!MEMORY_BACKENDS.includes(target)) {
    return refuse([`后端只能是 ${MEMORY_BACKENDS.join(' / ')}（收到 ${JSON.stringify(backend)}）`]);
  }
  /** 只有 `midas` 用得上：这回要写进补丁的 MCP 行所需的**绝对**路径 / 安装目录 / DB（调用方从发现结果算出来）。 */
  const midas = target === 'midas' && opts && opts.midas ? opts.midas : null;
  const binPath = midas ? String(midas.binPath || '').trim() : '';
  const installDir = midas ? String(midas.installDir || '').trim() : '';
  const dbPath = midas ? String(midas.dbPath || '').trim() : '';
  if (midas && (!binPath || !installDir || !dbPath)) {
    // 三条缺一条就不能写：缺 binPath 会变成"启动一个不存在的命令"，缺 dbPath 会让记忆**悄悄蒸发**
    // （`MIDAS_MCP_DB` 没有默认值，不设 ⇒ InMemoryStore）。宁可不写，也绝不写一条看着能用、实际丢数据的行。
    return refuse(['Midas 那一行需要三个**确定**的值（二进制绝对路径 / 安装目录 / DB 路径），缺一不可 ⇒ 拒绝写入。']);
  }

  const original = existingText == null ? '' : String(existingText);
  const parsed = parseRows(original);
  if (parsed.errors.length) {
    return refuse([
      '补丁文件不是预期的形态（顶层 `- …` 数组）⇒ **拒绝写入**：此刻任何"合并"都可能把你原有的内容写没。请先手工修正该文件。',
      ...parsed.errors,
    ]);
  }
  const lines = original.split('\n');
  const hit = findHindsightRow(parsed.rows);

  // ── 两条目标各自的"两行该长什么样"（本函数的**唯一**判据来源）────────────────────────────
  // 为什么先算成常量而不是散在分支里：出口自检要**独立地**回答"生成的新文本编码了哪个状态"，
  // 若两边各推一遍，就是同一件事两个家 —— 下一次改一处必然分叉（本仓头号返工源）。
  // `off` 与"已接线的 `midas`"在**补丁层**完全同形（Hindsight 一律禁用），所以这里只按**补丁**
  // 分叉，不按设置值分叉；"哪一个设置值"只影响 MCP 行那一维。
  const wantHindsightDisabled = target === 'off' || (target === 'midas' && !!midas);
  // MCP 行这一维有**三**种状态，不是两种 —— 把它压成布尔就会把"故意不动"误判成"必须不在"：
  //   · `'present'` —— `midas` 已接线：那一行必须**在**（且被 `- insert:` 包着）；
  //   · `'absent'`  —— `hindsight` / `off`：那一行必须**不在**（真二选一的另一半）；
  //   · `'untouched'` —— `midas` **未接线**：本轮对它**无话可说**（不写、也不删），所以出口自检
  //     对它**不作任何断言**。⚠️ 这一格是**故意**的，不是漏审：没有二进制时不写那一行（写了 =
  //     假接通），而"顺手删掉已有的那一行"也不该做 —— 一次动作只改它声明要改的那一处
  //     （与 `planMidasRowRemoval()` 不顺手删顶层行同一条纪律）。要清掉它另有那个专门的动作。
  // `wantMidasRow` = "这一轮要把那一行**写进去**"（`midas` 变量本身已含 `target === 'midas'`）。
  const wantMidasRow = !!midas;
  const midasRowTarget = wantMidasRow ? 'present' : ((target === 'midas') ? 'untouched' : 'absent');

  /**
   * 出口：自检 + 组装返回值。
   *
   * ⚠️ `changed:false` 的**早退**（第一行）刻意**跳过**自检：没有任何改动 ⇒ 也就不可能把不想要的状态
   * 写进盘。⚠️ 但它**不是**"自检可以省"的借口：能带着 `changed:false` 走到这里的只有**未接线的
   * `midas`**（`hindsight` / `off` 两档要么改启用位、要么删 MCP 行 ⇒ 一定 `changed:true`），
   * 而那一档的 MCP 行目标正是 `'untouched'`（对它不作断言）⇒ 跳过自检与"这一档要的形态"一致。
   * 将来若给某一档加上"文本没变但契约另有要求"的情形，这里必须一起改。
   */
  const finish = (nextText, changed) => {
    if (!changed) return { ok: true, changed: false, text: original, errors: [], notes, backend: target };
    const verify = parseRows(nextText);
    if (verify.errors.length) {
      return refuse(['自检失败：生成的新文本不是预期的形态 ⇒ 拒绝写入。', ...verify.errors]);
    }
    const row = findHindsightRow(verify.rows);
    const disabled = !!(row && row.disabled === true);
    if (disabled !== wantHindsightDisabled) {
      return refuse([`自检失败：生成的新文本里 Hindsight 是${disabled ? '**禁用**' : '**启用**'}的，与后端 \`${target}\` 本轮要求的"${wantHindsightDisabled ? '禁用' : '启用'}"不符 ⇒ 拒绝写入。`]);
    }
    // ── 第二维：MCP 行在不在（**两件一起审**；`'untouched'` 那一格除外）─────────────────────
    // 只审 Hindsight 那一行的启用位是不够的：三档的契约里"另一个后端那一行在不在"是**另一半**，
    // 少了这一半就又回到"界面说一个、文件里两个"的原始缺陷。
    const rowPresent = !!findMidasInsertRow(nextText);
    if (midasRowTarget === 'present' && !rowPresent) {
      // 这条路径上最险的一步：`- insert:` 少了或写坏了 ⇒ dsh 只会 warn + skip，界面上一切正常、
      // 记忆却仍走 Hindsight（"假接通"）。所以出口必须回读确认那一行**在**且被 insert 包着。
      return refuse(['自检失败：生成的新文本里没有 `- insert:` 包裹的 mcp-midas 行（裸的 `- id:` 行是"覆盖一个不存在的条目"⇒ dsh 会静默跳过）⇒ 拒绝写入。']);
    }
    if (midasRowTarget === 'absent') {
      // `hindsight` / `off`：契约就是"生效的那一行必须不在"。
      // **顶层**写法一并算进来：它虽是 load-override（dsh warn + skip）而**不生效**，但"这一档要求
      // 把 MCP 行移除"这句承诺必须是真的 —— 留着它 = 文件里躺着一个"看着像 Midas"的行，而界面说
      // 后端只有另一个。所以要求"连顶层那一行也不在"，并在拒绝时点名是哪一种。
      const topLevel = hasTopLevelMidasRow(nextText);
      if (rowPresent || topLevel) {
        return refuse([
          `自检失败：后端 \`${target}\` 要求补丁里**没有** \`${MIDAS_PATCH_ROW_ID}\` 行，但生成的新文本里${rowPresent ? '仍有 `- insert:` 包裹的那一行（它**会生效**）' : '仍有**顶层**的 `- id: mcp-midas` 行（缩进 0 的 load-override 写法，dsh 会静默跳过）'} ⇒ 拒绝写入（写入等于同时留下两个记忆后端）。`,
        ]);
      }
    }
    // `'untouched'`：**不作断言**（那一行在不在都不是本轮的契约）—— 见上面 `midasRowTarget` 的注释。
    return { ok: true, changed: true, text: nextText, errors: [], notes, backend: target };
  };

  /** Hindsight 那一行 → `disabled: true`（已经禁用 ⇒ 逐字不动，`changed:false`）。 */
  const editHindsightToDisabled = () => {
    if (!hit) {
      // 追加位置选在**最后一行内容之后**（而不是简单 push）：这样文件末尾原有的空行/注释位置
      // 不会被我们"搬家"，新行也不会粘在旧内容后面。目标是"最小 diff"。
      const out = lines.slice();
      let insertAt = out.length;
      while (insertAt > 0 && out[insertAt - 1] === '') insertAt -= 1;
      out.splice(insertAt, 0, `- id: ${HINDSIGHT_PLUGIN_ROW_ID}`, '  disabled: true');
      notes.push(`补丁文件里没有 \`${HINDSIGHT_PLUGIN_ROW_ID}\` 行 ⇒ 追加 \`- id: ${HINDSIGHT_PLUGIN_ROW_ID}\` + \`disabled: true\`（原有内容逐字保留）。`);
      return { text: out.join('\n'), changed: true };
    }
    if (hit.disabled === true) {
      notes.push('补丁文件里已经有 `- id: hindsight` + `disabled: true` ⇒ 这一行不需要改动，未写盘（不假报成功）。');
      return { text: original, changed: false };
    }
    const out = lines.slice();
    if (hit.disabledLine >= 0) {
      out[hit.disabledLine] = out[hit.disabledLine].replace(/(\bdisabled\s*:\s*)false(\s*)$/, '$1true$2');
      notes.push('把已有的 `disabled: false` 改成 `disabled: true`（这一行的其它内容原样保留）。');
    } else {
      const indent = ' '.repeat(hit.keyIndent == null ? 2 : hit.keyIndent);
      out.splice(hit.start + 1, 0, `${indent}disabled: true`);
      notes.push('给已有的 `hindsight` 行补上 `disabled: true`（其余行逐字保留）。');
    }
    return { text: out.join('\n'), changed: true };
  };

  /** Hindsight 那一行 → 启用（是**我们自己的规范形态**就整行删；否则只把那个值改成 false）。 */
  const editHindsightToEnabled = () => {
    if (!hit || hit.disabled !== true) {
      notes.push(target === 'midas'
        ? 'Hindsight 行本来就**没有**被禁用 ⇒ 这一行不需要改动。'
        : '补丁文件里没有把 `hindsight` 行禁用 ⇒ 不需要改动（默认就是启用）。');
      return { text: original, changed: false };
    }
    const rowLines = lines.slice(hit.start, hit.end + 1);
    const canonical = [`- id: ${HINDSIGHT_PLUGIN_ROW_ID}`, '  disabled: true'];
    const out = lines.slice();
    if (rowLines.join('\n') === canonical.join('\n')) {
      out.splice(hit.start, rowLines.length);
      notes.push('删掉本插件此前追加的那一行（与本模块的规范形态逐字相同）—— 文件回到"没有 override"的状态。');
    } else {
      out[hit.disabledLine] = out[hit.disabledLine].replace(/(\bdisabled\s*:\s*)true(\s*)$/, '$1false$2');
      notes.push('把 `disabled: true` 改成 `disabled: false`（这一行还夹着别的键/可能是别的插件写的 ⇒ 只改这一个值，不整行删）。');
    }
    return { text: out.join('\n'), changed: true };
  };

  /**
   * MCP 行 → **移除**。**一律复用 `planMidasRowRemoval()`**（兄弟普查 / 块形自检 / 出口自检的唯一一个家）。
   *
   * 为什么取它的 `.text` 而不是在这里内联一份等价逻辑：那个函数有一条**不对称**的形态自检 ——
   * 规范 `- insert:` 的顶格表头删掉之后，`parseRows()` 会把**内层**那行 `    - id: mcp-midas`
   * 当成新的顶层项（缩进内容）⇒ 它报"流式 YAML / 缩进没有归属"⇒ 那个函数 `ok:false`。
   * 本函数**跟着一起拒绝**：**悄悄跳过一条被请求的删除**正是"界面说关掉了、文件里还活着"这个
   * 原始缺陷本身。代价（如实写明）：这种补丁里 `midas` 档会连"插入 MCP 行"一起被拒 —— 那次写入
   * **命中不到**最终目标（MCP 行不会在），宁可整件事不写，也不做半件事。
   */
  const removeMidasRowOrRefuse = (text) => {
    const removal = planMidasRowRemoval(text);
    if (!removal.ok) {
      return {
        refused: refuse([
          `后端 \`${target}\` 要求把 \`${MIDAS_PATCH_ROW_ID}\` 那一行从补丁里**移除**，但移除被拒绝 ⇒ 整个计划一并拒绝（**绝不**静默跳过一条被请求的移除：那正是"界面说关掉了、文件里还活着"这个原始缺陷）。`,
          ...removal.errors,
        ]),
      };
    }
    for (const n of removal.notes) notes.push(n);
    return { text: removal.text, changed: removal.changed };
  };

  // ── 目标 1：Hindsight 那一行（三档共用同一对编辑函数，不复制第二份）────────────────────────
  const hs = wantHindsightDisabled ? editHindsightToDisabled() : editHindsightToEnabled();
  const curText = hs.text;
  const curChanged = hs.changed;

  if (target === 'midas' && !midas) {
    // ⚠️ **未接线**：不写 MCP 行（写一条指向不存在命令的行 = 假接通），也**不关** Hindsight ——
    // 二进制没找到时若顺手把 Hindsight 关掉，用户就**同时失去两个后端**（那是最坏的结果）。
    // 这里刻意**不去移除**任何已存在的 mcp-midas 行：本轮对它无话可说，"一次动作只改它声明要改的
    // 那一处"（与 `planMidasRowRemoval()` 不顺手删顶层行是同一条纪律）；要清掉它另有那一个动作。
    notes.push(`⚠️ 这一档**只**动了 Hindsight 那一行：没有可用的 Midas 二进制 ⇒ 不插入 \`${MIDAS_PATCH_ROW_ID}\` 行（写一条指向不存在命令的行 = 假接通），也因此**不关** Hindsight（两个后端一起没有才是最坏的结果）。补丁里若还留着 \`${MIDAS_PATCH_ROW_ID}\` 行，要清掉请用「移除 mcp-midas 那一行」那个动作。`);
    return finish(curText, curChanged);
  }

  if (!wantMidasRow) {
    // `hindsight` / `off`：**移除** MCP 行（真二选一的另一半）。
    const rm = removeMidasRowOrRefuse(curText);
    if (rm.refused) return rm.refused;
    return finish(rm.text, curChanged || rm.changed);
  }

  // ── 目标 2：`midas` 且**已接线** ⇒ 插入/替换 `- insert:` 包裹的 mcp-midas 行 ─────────────────
  const rowBlock = midasPatchRowLines({ binPath, installDir, dbPath, serverName: midas.serverName || MIDAS_SERVER_NAME });
  // 比对与替换都以**内层块**为单位（`- insert:` 那一行是外面那个顶层项的表头，不属于这一行）。
  const innerBlock = rowBlock.slice(1);
  const existingRow = findMidasInsertRow(curText);
  const baseLines = curText.split('\n');
  if (existingRow) {
    // 幂等：已经是我们**逐字**的规范块（**按它自己的缩进**比对）⇒ 不动盘。
    // ⚠️ 必须先 reindent 再比：只跟基准缩进（4 格）比的话，一个缩进 2 格的合法块会被判"不一样"，
    //    于是每次保存都"改"成同样的文本 ⇒ 每次都写盘（幂等纪律，2026-09-19 实测踩到）。
    const reindented = reindent(innerBlock, existingRow.indent);
    if (existingRow.lines.join('\n') === reindented.join('\n')) {
      notes.push('补丁文件里已经有**逐字相同**的 `- insert:` + `mcp-midas` 行 ⇒ 这一行不需要改动，未写盘（幂等）。');
      return finish(curText, curChanged);
    }
    // 行 id 是本模块的 ⇒ 可以整块替换；但**沿用它原来的缩进**（它是某个 insert 块的兄弟项，
    // 缩进是那个块的约定，我们无权改动兄弟行）。为什么整块替换而不是逐个 key 改：这一行完全由本模块生成。
    const out = baseLines.slice();
    out.splice(existingRow.start, existingRow.lines.length, ...reindented);
    notes.push('把已有的 `mcp-midas` 行替换成当前二进制/DB 路径（这一行的 id 是本模块的 ⇒ 整块替换；块内缩进沿用原样）。');
    return finish(out.join('\n'), true);
  }
  // 追加位置与 Hindsight 那一行同一口径：**最后一行内容之后**（末尾原有空行/注释不搬家，最小 diff）。
  const out = baseLines.slice();
  let insertAt = out.length;
  while (insertAt > 0 && out[insertAt - 1] === '') insertAt -= 1;
  out.splice(insertAt, 0, ...rowBlock);
  notes.push(`补丁文件里没有 \`${MIDAS_PATCH_ROW_ID}\` 行 ⇒ 追加 \`- insert:\` 包裹的 \`mcp-midas\`（command=node + 绝对路径 args + ${MIDAS_DB_ENV} + ${MIDAS_NO_WARNINGS_ENV}，其余内容逐字保留）。`);
  if (hasTopLevelMidasRow(curText)) {
    // 顶层写法是"覆盖一个不存在的条目" ⇒ dsh 会 warn + skip。留着它无害但会刷一行警告，如实说明。
    // ⚠️ 出口自检**不会**因此拒绝这一档：这一档要的是"**生效**的那一行在"，而顶层那行本就不生效
    //    （它归 `planMidasRowRemoval()` 管，那里同样刻意不删它）。这句差异是**故意**的，不是漏审。
    notes.push(`⚠️ 补丁里已有一行**顶层** \`- id: ${MIDAS_PATCH_ROW_ID}\`：顶层写法是覆盖一个不存在的条目 ⇒ dsh 只会打一行 warn 并跳过（不生效）。本次插入的是规范的 \`- insert:\` 写法；那一行可以手工删掉。`);
  }
  return finish(out.join('\n'), true);
}

/**
 * Midas 的**首装引导步骤**（命令**由服务端给**）。
 *
 * 为什么必须在服务端组装：`client.js` 是手写 bundle、**不能 `import lib/`**（本仓既有事实：
 * 中文标签就是因此随响应一起发过去的）。把命令硬编在客户端 = 同一件事两个家，profile 名一变就分叉。
 * 三条顺序固定（装本体 → 装 MCP 客户端 → 回来选 + 重启），每一条都带一条**可复制**的命令。
 *
 * ⚠️ 刻意**不写任何版本号**（本仓有过一次"界面承诺了一个版本、实际不匹配"的事故），
 * 需要 Node 较新这件事只用文字说清（Midas 依赖 Node 内建的 `node:sqlite`）。
 * @param {object} [input]
 * @param {string} [input.profile] - 当前 profile（`DSH_PROFILE`，默认 `web`）。
 * @returns {Array<{zh: string, en: string, command: string}>}
 */
export function midasOnboardingSteps({ profile = DEFAULT_PROFILE } = {}) {
  const p = String(profile || '').trim() || DEFAULT_PROFILE;
  return [
    {
      zh: '装 Midas 本体（npm 全局安装；它是本地进程，需要较新的 Node —— 它用的是 Node 内建的 `node:sqlite`）：',
      en: 'Install Midas itself (npm global; it runs locally and needs a recent Node — it uses the built-in `node:sqlite`):',
      command: MIDAS_INSTALL_COMMAND,
    },
    {
      zh: `把 dsh 的 MCP 客户端装进**当前 profile（${p}）**：profile 里没有这个包时，补丁文件里那一行会被 dsh 静默跳过（看着像装好了，实际没接上）：`,
      en: `Add dsh's MCP client to the CURRENT profile (${p}): without that package in the profile, dsh silently skips the patch row (it looks installed but is not connected):`,
      command: `dsh plugin --profile ${p} add ${MIDAS_MCP_CLIENT_PACKAGE}`,
    },
    {
      zh: '回到本页把「写哪个后端」选成 Midas，然后**重启 `dsh web`**（profile 补丁只在加载 profile 时读一次 —— 先停掉当前进程再启动）：',
      en: 'Come back here, set "Which backend" to Midas, then RESTART `dsh web` (the profile patch is read once, at profile load — stop the running process first):',
      command: 'dsh web',
    },
  ];
}

/**
 * **纯函数**：算出"把补丁里那一行 `mcp-midas` 拿掉之后文本应该长什么样"（不碰文件系统）。
 *
 * ── 它为什么必须存在（先有事实，再谈设计）──────────────────────────────────────
 * 真实缺陷（2026-09-19 逐字复现）：用户在设置页选「不使用」，本模块只往补丁里写了
 * `- id: hindsight` + `disabled: true`，**一个字都没碰**那个 `- insert:` 包裹的 `mcp-midas` 行。
 * 后果：Midas 的 MCP 服务**照样启动**、17 个 `mcp__midas__*` 工具**照样注册**，而界面上那句
 * 「已关闭…不会有任何记忆调用」是**假话**。诚实 = 把那一行摊开说，并给一个**一键清掉**的动作。
 *
 * ── 编辑策略（与 `planMemoryBackendPatch` 同一套保守纪律）───────────────────────
 *   · 形态不认识（`parseRows` 报错）⇒ `ok:false` / `text:null`：**绝不猜着合并**；
 *   · 本来就没有那一行 ⇒ `changed:false` + 原文本逐字返回（幂等，不写盘、不假报成功）；
 *   · **顶层**写法（`- id: mcp-midas` 缩进 0）：**不删**。它是**另一种 row**（dsh 的 load-override
 *     ⇒ 覆盖一个不存在的条目，只会 warn + skip），`findMidasInsertRow()` 按设计**看不见**它
 *     （它只认内层那条 —— 那才是真的会生效的那条）。这里只**如实说明**它可以手工删掉，
 *     不做"顺手多删一行"的动作：一次动作只改它声明要改的那一处。
 *   · 删块用 `splice(start, end - start + 1)`：块**恰好**是 `findMidasInsertRow()` 认出来的那些行，
 *     其余行（含注释、空行、兄弟项）逐字保留。
 *
 * ── 那个 `- insert:` 表头什么时候能一起删（**必须做兄弟普查**）────────────────────
 * `insert` 是**数组**（`insert?: EntryOptions[]`）⇒ 一个 `- insert:` 底下合法地可以挂**多条**子项，
 * 它们按顺序应用。所以只有在"这条子项是**独苗**"时，把表头一起删掉才是干净的；
 * 一旦还有兄弟，删掉表头 = 把**别人的**条目一起删了（那是不可接受的数据丢失）。
 * 判据（⚠️ 两处都**不是**"看相邻行" —— 相邻行判定在真实文件上各错过一次）：
 *   ① 所属表头：从 `r.start` **往回跳过空行/注释**，第一条缩进**严格更浅**的行才是容器；
 *      它算表头 iff 逐字匹配 `- insert:`。表头与子项之间夹空行/注释是**合法** YAML
 *      （`- insert:` / `# mcp client` / `    - id: mcp-midas`），按相邻行判定会得出"没有表头"。
 *   ② 独苗与否：在**容器的范围**内数（容器止于下一条缩进 <= 表头缩进的行），从块尾往后扫 ——
 *      不能扫到容器外面，否则容器隔壁的顶层 `- ` 行会被误当成兄弟（"独苗"永远判不出来）。
 *
 * ⚠️ **`indent - 2` 是错的**（本机真实文件实测）：那个 `- insert:` 在**缩进 0**、子项在**缩进 4**
 * （差 4 格）。任何"用 child 缩进反推表头缩进"的写法在这份真实文件上都会算错 ⇒ 一律**用行本身**判定。
 *
 * ⚠️ **块被"更深缩进"吞进来的情形一律 `refuse()`**：`findMidasInsertRow()` 的块尾会把**更深缩进的
 * `- ` 行**也算作这一块，可那是**另一条序列项**（别人的条目）。此刻块尾与普查都不可信（普查从块尾
 * 之后开始，看不见被吞进来的同缩进兄弟）⇒ 删表头会顺手删掉它，还会附一句"唯一子项"的假说明。
 * 细节见函数体内那段注释（含"为什么这种形态只可能是畸形输入"）。
 *
 * ⚠️ 表头与子项之间的空行/注释（"间隔行"）**跟着表头一起删**，不留：表头没了以后它们会变成**无主的
 * 孤儿注释**，被读成下一条顶层项的注释 —— 比留一个空容器更容易误导人。它们逐字属于这一处
 * （在本块正上方、且在本块表头之下），删它们不越界。
 *
 * @param {string|null} existingText - 现有补丁文件文本（`null`/空 ⇒ 视为空文件 = 空数组）。
 * @returns {{ok: boolean, changed: boolean, text: string|null, errors: string[], notes: string[]}}
 *   `ok:true` 时 `text` 是目标内容（`changed:false` 时 = 原文本，调用方不应写盘）；
 *   `ok:false` 时 `text` 恒为 `null`（拒绝写入）。
 */
export function planMidasRowRemoval(existingText) {
  const notes = [];
  const refuse = (errors) => ({ ok: false, changed: false, text: null, errors, notes });
  const original = existingText == null ? '' : String(existingText);

  const parsed = parseRows(original);
  if (parsed.errors.length) {
    // 同 `planMemoryBackendPatch`：看不懂的形态一律不写 —— 此刻任何"合并"都可能把用户原有的内容写没。
    return refuse([
      '补丁文件不是预期的形态（顶层 `- …` 数组）⇒ **拒绝写入**：此刻任何删改都可能把你原有的内容写没。请先手工修正该文件。',
      ...parsed.errors,
    ]);
  }

  const hit = findMidasInsertRow(original);
  if (!hit) {
    if (hasTopLevelMidasRow(original)) {
      // 不删的理由写在这里（不是"忘了"）：那是**另一种 row** —— 顶层 `- id:` 是 load-override，
      // 对 MCP 挂载不生效，`findMidasInsertRow()` 有意忽略它。删掉它不会改变任何行为，
      // 却会让文件与用户手工写下的内容不一致 ⇒ 只如实指出，交给用户自己删。
      notes.push(`补丁里只有**顶层**的 \`- id: ${MIDAS_PATCH_ROW_ID}\`（缩进 0）：那是 dsh 的 load-override 写法，对 MCP 挂载**不生效**（dsh 只会打一行 warn 并跳过）⇒ 本动作**不动它**（它不在生效路径上，删不删都不改变行为）。想清理可以手工删掉这一行。`);
    } else {
      notes.push('补丁文件里本来就没有 `mcp-midas` 那一行 ⇒ 没有改动，未写盘（不假报成功）。');
    }
    return { ok: true, changed: false, text: original, errors: [], notes };
  }

  const lines = original.split('\n');
  const out = lines.slice();
  out.splice(hit.start, hit.end - hit.start + 1);

  // ── 块形自检（**必须在删任何东西之前**）：块尾是被"更深缩进"吞进来的吗？──────────────────
  // `findMidasInsertRow()` 的块界规则是"其后每一行只要缩进更深就算这一块"。规范写法里那些更深的行
  // 都是**映射键**（`name:` / `config:` / `env:`…），`args:` 之下还会有**标量**序列项
  // （`        - '/path/midas-mcp'`）—— 那些都是这一条自己的内容，**正常**，不在这里的关心范围内。
  //
  // 危险的是**更深缩进、且以 `- <key>:` 开头的行**：那是**另一条序列项**（一条**映射**子项，
  // 比如 `    - id: other`），也就是**别人的条目**，却被算进了这一块。
  //
  // 为什么这种形态只可能是畸形输入（不是"少见但合法"）：`insert` 是数组，子项之间必须**同缩进**
  // 才并列；子项内部允许更深，但更深处的 `- ` 只能是 `args:` 这类键的**值**（标量，或至少是
  // "键之下的序列"），而一条 `- key: value` 形式的**映射项**出现在子项内部、缩进又比子项深，
  // 在合法 YAML 里没有位置 —— 实测 `js-yaml` 与 `yaml` v2 都拒收，DSH 自己的 `parsePatchList`
  // 在启动时就抛 `bad indentation of a sequence entry`。本模块的写入端（`midasPatchRowLines`）
  // 也只产出规范块（`args` 下是标量序列，`indent - 2` 落在键之下）。
  //
  // 但"不可达"不是"可以乱删"：此刻**块尾不可信** ⇒ 兄弟普查（只往后扫）会从块尾之后开始，
  // 于是**看不见**被吞进来的那条同缩进条目 ⇒ `siblingCount` 算成 0 ⇒ 删掉 `- insert:` 表头
  // = 把 `- id: other` **一起删掉**，还会附上一句"唯一子项"的**假**说明，并报 `ok:true, changed:true`。
  //
  // 选择 **(b) 拒绝写入**，而不是 (a) 保留表头：破坏性动作不许建立在**无法核实的前提**上，这正是
  // 本模块一贯的纪律（见 `planMemoryBackendPatch` 的拒绝路径，以及 585-587、610-612 的"宁可不写"）。
  // 而且这里连"只删块内行"都做不到诚实：`hit.end` 本身已经把 `- id: other` 圈进来了，删"这一块"
  // 跟删表头一样会伤到别人。唯一安全的动作是**什么都不做**，并把位置如实指出来。
  const swallowedSiblingIdx = [];
  for (let k = hit.start + 1; k <= hit.end; k += 1) {
    // 只认 `- <key>:` 形状（映射子项 = 别的一条条目）。`- 'scalar'` / `- 123` 这种是 args 的值，
    // 属于这一条自己的内容，放行（否则真实那份 cordis.patch.yml 会被误拒 —— 实测踩到过）。
    if (/^\s*-\s+[^\s#][^:]*:(\s|$)/.test(lines[k])) swallowedSiblingIdx.push(k + 1);   // 1-based 行号，给人看的
  }
  if (swallowedSiblingIdx.length) {
    return refuse([
      `补丁文件里 \`- insert:\` 那一条子项的**块内**出现了更深缩进的 \`- \` 序列项（第 ${swallowedSiblingIdx.join(' / ')} 行）：那是一整条**映射子项**（别人的条目），不是这一条的映射键。`,
      '这种缩进在 YAML 里不成立（`insert` 的兄弟子项必须同缩进）⇒ 兄弟普查无法确认 `mcp-midas` 是不是独苗。',
      '**拒绝写入**：删表头会连带删掉别人的条目，而删块本身同样会把那几行圈进去 —— 两条路都会丢数据，所以宁可什么都不做。请先手工修正该文件的缩进。',
    ]);
  }

  // ── 认定所属表头：**结构**上回溯，不靠相邻行 ────────────────────────────────────────
  // 为什么不能用 `lines[hit.start - 1]`：表头与子项之间**合法的**可以夹着空行/注释
  // （`- insert:` / `# mcp client` / `    - id: mcp-midas`）。按相邻行判定会得出"没有表头"，
  // 于是留下一个**没有子项的空容器**，还会说一句"上面没有 `- insert:` 表头"的**假话**（表头就在那儿）。
  // 结构判据：从 `hit.start` 往回跳过空行/注释，第一条缩进**严格更浅**的行就是这个块的容器。
  let headerIdx = -1;
  const gapIdx = [];                       // 表头与子项之间被跳过的空行/注释（要跟着表头一起删）
  for (let j = hit.start - 1; j >= 0; j -= 1) {
    const l = lines[j];
    if (l.trim() === '' || /^\s*#/.test(l)) { gapIdx.push(j); continue; }   // 空行/注释先跳过
    const ind = l.match(/^\s*/)[0].length;
    if (ind < hit.indent) headerIdx = j;   // 更浅 = 外层容器（不管是不是 `- insert:`）
    break;                                 // 第一条非空非注释行就定了：它才是容器，再往上都是别人的
  }
  const wrapperIsHeader = headerIdx >= 0 && /^\s*-\s*insert\s*:\s*(#.*)?$/.test(lines[headerIdx]);
  const headerIndent = headerIdx >= 0 ? lines[headerIdx].match(/^\s*/)[0].length : -1;
  let siblingCount = 0;
  if (wrapperIsHeader) {
    // 普查范围 = **容器的范围**，而不是"从块尾一路往文件尾扫"：容器止于第一条缩进 <= 表头缩进的行。
    // 表头不挨着子项时这一点是**必须**的 —— 否则会把容器**外面**的同缩进 `- ` 行（`- id: hindsight`
    // 那种顶层项）当成兄弟，于是"独苗"被误判成"有兄弟"，表头就永远删不掉、留下来当垃圾。
    for (let j = hit.end + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.trim() === '' || /^\s*#/.test(l)) continue;              // 空行/注释不结束容器
      const ind = l.match(/^\s*/)[0].length;
      if (ind <= headerIndent) break;                                // 回到容器外层 ⇒ 容器结束
      if (ind < hit.indent) break;                                   // 半路出现别的东西 ⇒ 不再猜，按"有兄弟"保守处理
      if (ind > hit.indent) continue;                                // 更深 = 内层，不算兄弟
      if (/^\s*-\s/.test(l)) { siblingCount += 1; break; }           // 同缩进的 `- ` = 兄弟项
    }
  }

  if (!wrapperIsHeader) {
    // 容器比子项浅，但它不是 `- insert:`（或不比子项浅）⇒ 这条 `- id:` 行不在它自己的 `insert` 里
    // ⇒ 只删它自己，绝不猜。措辞只陈述**已核实**的事：真正的容器长什么样（或压根没有容器）。
    const found = headerIdx >= 0
      ? `上面那条更外层的行不是 \`- insert:\` 表头（第 ${headerIdx + 1} 行：${trimLine(lines[headerIdx])}）`
      : '上面找不到任何更外层的容器行';
    notes.push(`${found} ⇒ 只删这一块本身，其余行逐字保留。`);
  } else if (siblingCount === 0) {
    // 删表头时**必须**把夹在中间的空行/注释一起删掉：留着就是**孤儿注释** —— 它本来是"这一个 insert 的
    // 子项"的说明，表头没了以后它会飘在那里、被人当成下一条顶层项的注释（比留个空容器更坏）。
    // 这些"间隔行"是本函数的直接对象（就在这块正上方、且在本块的表头之下），删它们不越界
    // —— 与 `findMidasInsertRow` 的"块尾不吞末尾空行"同一纪律：只动逐字属于这一处的行。
    for (const g of gapIdx) out.splice(g, 1);
    out.splice(headerIdx, 1);
    notes.push(`这一块是那个 \`- insert:\` 底下的**唯一**子项 ⇒ 连表头一起删掉（文件回到"没有这一条"的状态）。${gapIdx.length ? `表头与该子项之间夹着的 ${gapIdx.length} 行空行/注释也一并删掉（否则会留下无主的孤儿注释）。` : ''}`);
  } else {
    // 表头留下 ⇒ 它变成"有 `insert:` 但子项少了一条"。`insert` 是数组，剩下的兄弟项**继续按顺序应用**，
    // 所以这不是"坏掉的 YAML"，只是少了一条 —— 把这件事如实说出来（别让用户以为文件坏了）。
    notes.push('同一个 `- insert:` 底下还有**别的子项** ⇒ 只删 `mcp-midas` 这一块，表头与兄弟项**逐字保留**（`insert` 是数组，剩下的条目照旧按顺序生效）。');
  }

  let nextText = out.join('\n');

  // ── 出口自检（与 `planMemoryBackendPatch` 的 `finish()` 同一纪律）────────────────────
  // 第一道：DSH 启动时**顶层数组不能空、也不能只剩注释**（那种文件会让宿主直接抛）。真机上补丁里
  // 还有别的行，但这条守卫必须存在 —— 它是"删完之后文件还合法吗"的唯一保证。
  const hasTopLevelEntry = out.some((l) => /^-\s/.test(l));
  if (!hasTopLevelEntry) {
    // 只写 `[]` 两个字符（**不带**换行）：`parseRows('[]')` 走的是"空文件 = 空的顶层数组"那条早退
    // ⇒ 零个顶层项、零个错误，自检过得去。**不能**依赖"文件为空串" —— 真正会让 dsh 启动时抛的
    // 恰恰是空串与"只剩注释"，所以这里给的是那个**显式**的空数组。带 `\n` 则会让每次保存都算一次差异
    //（本仓幂等纪律：2026-09-19 在 `findMidasInsertRow` 上刚踩过同一个坑）。
    nextText = '[]';
    notes.push('删完之后顶层**一条 `- …` 都不剩**了 ⇒ 写成 `[]`（空数组是合法的补丁；文件为空、或只剩注释会让 dsh 启动时直接抛）。');
  }
  const verify = parseRows(nextText);
  if (verify.errors.length) {
    return refuse(['自检失败：删除后的文本不是预期的形态 ⇒ 拒绝写入。', ...verify.errors]);
  }
  if (findMidasInsertRow(nextText)) {
    return refuse(['自检失败：删除后仍然能读到 `- insert:` 包裹的 `mcp-midas` 行 ⇒ 拒绝写入（不假报已删除）。']);
  }
  // 这里原来还有第三道守卫（"删完为空串或只剩注释 ⇒ 拒绝"）。它**不可达**，已删除：上面那道
  // `hasTopLevelEntry` 守卫是它的**真前提** —— 只剩空行/注释就不可能含有 `/^-\s/` 的顶层项，
  // 于是 `nextText` 已被改写成 `'[]'`，`nextText !== '[]'` 恒为假，整个条件永远不成立。
  // 留着它只会制造"这里有第二道防线"的错觉（写测试去覆盖它必然是死代码）。
  // 真正的保证仍在那道守卫里：唯一能产出"空或只剩注释"的路径都被它拦下并改写成了 `'[]'`。
  if (nextText === original) {
    // 结构上不可能走到（`splice` 至少删了一行），但"没变却说 changed:true"正是本仓最忌讳的假报。
    notes.push('删除后的文本与原文**逐字相同** ⇒ 按没有改动处理（幂等）。');
    return { ok: true, changed: false, text: original, errors: [], notes };
  }
  return { ok: true, changed: true, text: nextText, errors: [], notes };
}

/** stderr 摘要：压空白 + 截断（失败时这一行往往就是全部线索）。 */
function summarizeStderr(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > MIDAS_STDERR_SUMMARY_MAX ? t.slice(0, MIDAS_STDERR_SUMMARY_MAX) + '…' : t;
}

/**
 * **探测一次启动**：真的 spawn 一个 Midas 进程，并完成一次 MCP `initialize` 握手。
 *
 * 为什么需要它（而不是"文件在就算能跑"）：需求里那一档「装了但起不来」是**真实存在**的状态
 * （缺 `node:sqlite`、原生模块不匹配、`dist/` 没装全…），只查文件在不在**永远看不出来**。
 * 为什么必须**由用户点**才跑、且有界超时：它就是"启动一个子进程"—— 与 Hindsight 那条连通性探测
 * 同一口径（进页面不自动发请求），且探测失败也**不许**拖住设置页。子进程 env 只给必要的几个变量
 * （不继承整份宿主 env：探测不需要机密，也不该把它们递给子进程）。
 * @param {object} [input]
 * @param {string} input.binPath - 二进制的绝对路径（由发现层给出）。
 * @param {string} [input.installDir] - 显式 cwd（与真实那一行保持一致，默认继承宿主 cwd 会不一样）。
 * @param {string} [input.dbPath] - 写进 `MIDAS_MCP_DB`（不设 ⇒ 它会用 InMemoryStore）。
 * @param {object} [input.env] - 只读 `PATH` / `HOME`。
 * @param {number} [input.timeoutMs]
 * @param {function} [input.spawnImpl] - 测试注入。
 * @returns {Promise<{ok: boolean, error: string, stderr: string, ms: number}>} **绝不抛**。
 */
export async function probeMidasStart({ binPath, installDir, dbPath, env = process.env, timeoutMs = MIDAS_PROBE_TIMEOUT_MS, spawnImpl } = {}) {
  const startedAt = Date.now();
  const bin = String(binPath || '').trim();
  if (!bin) return { ok: false, error: '没有可启动的 Midas 二进制路径（先让它可被发现）', stderr: '', ms: 0 };
  const spawn = spawnImpl || spawnCb;
  const childEnv = {
    PATH: String((env && env.PATH) || ''),
    HOME: String((env && env.HOME) || homedir()),
    [MIDAS_DB_ENV]: String(dbPath || ''),
    [MIDAS_NO_WARNINGS_ENV]: '1',      // 消掉每次 spawn 都打的 ExperimentalWarning（见文件头③）
  };
  let child;
  try {
    // ⚠️ 显式 `node <绝对路径>`：不靠 exec 位、不靠裸名字在 PATH 里碰运气（见文件头①）。
    child = spawn('node', [bin], { cwd: installDir ? String(installDir) : undefined, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, error: `无法启动 \`node\`：${errText(e)}`, stderr: '', ms: Date.now() - startedAt };
  }

  let stderr = '';
  let stdout = '';
  let settled = false;
  return await new Promise((resolve) => {
    let grace = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch { /* 已触发 */ }
      try { clearTimeout(grace); } catch { /* 没安排过 */ }
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      resolve({ ok, error: String(error || ''), stderr: summarizeStderr(stderr), ms: Date.now() - startedAt });
    };
    const timer = setTimeout(() => done(false, `启动探测超时（${timeoutMs}ms 内没有完成 MCP initialize 握手）`), Math.max(200, Number(timeoutMs) || MIDAS_PROBE_TIMEOUT_MS));
    if (timer && typeof timer.unref === 'function') timer.unref();
    child.on('error', (e) => done(false, `启动失败：${errText(e)}`));
    child.stderr.on('data', (b) => { if (stderr.length < 8000) stderr += String(b); });
    child.stdout.on('data', (b) => {
      stdout += String(b);
      let nl = stdout.indexOf('\n');
      while (nl >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        nl = stdout.indexOf('\n');
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }      // 非 JSON 行（日志）忽略
        if (!msg || msg.id !== 1) continue;
        if (msg.result) { done(true, ''); return; }
        if (msg.error) { done(false, `握手失败：${(msg.error && msg.error.message) || JSON.stringify(msg.error)}`); return; }
      }
    });
    // ⚠️ `exit` 早于 stdio 关闭 ⇒ 立刻结算会**丢掉最后一段 stderr**（而那段往往正是失败原因）。
    // 所以：`exit` 只记一句、再给 150ms 收集窗口；`close`（stdio 都关了）才是"确实结束了"。
    // 窗口存在的原因：万一有孙进程占着管道，`close` 可能迟迟不来 —— 那时按 exit 信息结算，不空等。
    let exitInfo = '';
    child.on('exit', (code, signal) => {
      exitInfo = `进程提前退出（code=${code}${signal ? `，signal=${signal}` : ''}）`;
      grace = setTimeout(() => done(false, exitInfo), 150);
      if (grace && typeof grace.unref === 'function') grace.unref();
    });
    child.on('close', () => done(false, exitInfo || '进程提前关闭（stdio 已结束）'));
    try {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-expert-team-memory-backend', version: 'probe' } },
      }) + '\n');
    } catch (e) { done(false, `握手请求写不进去：${errText(e)}`); }
  });
}

/**
 * **五态**就绪判定（纯函数：不做任何 IO；事实由调用方探好后传进来）。
 *
 * 顺序即优先级，每一档对应一个**不同的处置动作**：
 *   ① 发现层"探测本身不可用"（`probeOk:false`）⇒ `unknown`（**不给结论**：这不是"没装"）；
 *   ② 二进制没找到 ⇒ `midas-not-installed`（动作 = 装它）；
 *   ③ 用户点过探测、且**起不来** ⇒ `midas-start-failed`（动作 = 去看 stderr）；
 *   ④ MCP 客户端没装 ⇒ `midas-needs-mcp-client`（动作 = 装客户端）；探测不可用 ⇒ `unknown`；
 *   ⑤ 三件事都齐 ⇒ `midas-ready`。
 * 另有一处**已知的不完整**：二进制与客户端都齐、但补丁里没有那一行（上次保存失败/被别的工具改回）
 * ⇒ 也归 `unknown`（**绝不说已接通**）：此刻记忆确实还在 Hindsight，但"就绪"这个词不成立。
 * @param {object} [input]
 * @param {object} [input.bin] - 发现结果 `{found, via, probeOk, tried}`。
 * @param {boolean|null} [input.mcpClientInstalled]
 * @param {boolean} [input.patchRowPresent]
 * @param {boolean} [input.patchReadable]
 * @param {object|null} [input.start] - 启动探测结果（`null` = 本轮**没探**，因此不下"起不来"的结论）。
 * @param {string} [input.lookedAt] - 找过哪里的摘要（给人看）。
 * @returns {{kind: string, level: string, zh: string, en: string}}
 */
export function classifyMidasReadiness({ bin, mcpClientInstalled, patchRowPresent, patchReadable, start, lookedAt } = {}) {
  const b = bin || {};
  const where = String(lookedAt || '').trim();
  const suffixZh = where ? `（已试过：${where}）` : '';
  const suffixEn = where ? ` (tried: ${where})` : '';
  if (b.probeOk !== true) {
    return {
      kind: 'unknown', level: 'warn',
      zh: '无法判断 Midas 是否就绪：**探测本身不可用**（检查候选位置时全部失败）⇒ 这里不给结论。记忆仍走 Hindsight（仍按 token 计费）。',
      en: 'Cannot tell whether Midas is ready: the probe itself is unavailable (every candidate check failed) — so no conclusion here. Memory still goes through Hindsight (and still costs tokens).',
    };
  }
  if (b.found !== true) {
    return {
      kind: 'midas-not-installed', level: 'warn',
      zh: `Midas **未接通**：没找到 \`${MIDAS_BIN_NAME}\`${suffixZh} ⇒ 记忆仍走 Hindsight（仍按 token 计费）。按下面三步装好它即可。`,
      en: `Midas is NOT connected: \`${MIDAS_BIN_NAME}\` was not found${suffixEn} — memory still goes through Hindsight (and still costs tokens). The three steps below install it.`,
    };
  }
  if (start && start.ok === false) {
    const why = String(start.error || '原因未记录').trim();
    const err = String(start.stderr || '').trim();
    return {
      kind: 'midas-start-failed', level: 'bad',
      zh: `Midas **未接通**：二进制找到了（${b.via || '来源未记录'}），但**探测启动失败** ⇒ 记忆仍走 Hindsight。原因：${why}${err ? `；stderr 摘要：${err}` : ''}`,
      en: `Midas is NOT connected: the binary was found (${b.via || 'source not recorded'}), but the startup probe FAILED — memory still goes through Hindsight. Reason: ${why}${err ? `; stderr: ${err}` : ''}`,
    };
  }
  if (mcpClientInstalled !== true) {
    if (mcpClientInstalled === false) {
      return {
        kind: 'midas-needs-mcp-client', level: 'warn',
        zh: `Midas **未接通**：二进制找到了（${b.via || '来源未记录'}），但 dsh 的 MCP 客户端 \`${MIDAS_MCP_CLIENT_PACKAGE}\` **没装进 profile** ⇒ 补丁里那一行不会生效（dsh 会静默跳过它）⇒ 记忆仍走 Hindsight（仍按 token 计费）。`,
        en: `Midas is NOT connected: the binary exists (${b.via || 'source not recorded'}), but dsh's MCP client is NOT installed in the profile — the patch row does nothing (dsh skips it silently) — memory still goes through Hindsight.`,
      };
    }
    return {
      kind: 'unknown', level: 'warn',
      zh: '无法判断 Midas 是否就绪：二进制找到了，但**读不到已装插件清单**（loader 服务此刻拿不到）⇒「装了」与「没装 MCP 客户端」分不开，这里不假装知道。记忆仍走 Hindsight（仍按 token 计费）。',
      en: 'Cannot tell whether Midas is ready: the binary exists, but the installed-plugin list is unavailable right now, so "installed" cannot be told from "not installed" — no conclusion here. Memory still goes through Hindsight.',
    };
  }
  if (patchRowPresent !== true) {
    return {
      kind: 'unknown', level: 'warn',
      zh: patchReadable === false
        ? '无法判断 Midas 是否就绪：**读不到 profile 补丁文件**（缺失或无权限）⇒ 无法确认 `mcp-midas` 那一行在不在（这与"不在"是两件事）。记忆仍走 Hindsight（仍按 token 计费）。'
        : `就差落地：二进制与 MCP 客户端都在，但 profile 补丁里**没有** \`${MIDAS_PATCH_ROW_ID}\` 那一行（可能上次保存失败，或被别的工具改回去了）⇒ 现在还不能说已接通。回本页再选一次 Midas 让它落地即可。`,
      en: patchReadable === false
        ? 'Cannot tell whether Midas is ready: the profile patch file cannot be read (missing or denied), so we cannot confirm whether the row is there (that is NOT the same as "it is not there"). Memory still goes through Hindsight.'
        : `One step short: the binary and the MCP client are both present, but the profile patch has NO \`${MIDAS_PATCH_ROW_ID}\` row (a previous save may have failed, or another tool reverted it) — this is not "ready" yet. Pick Midas here once more to land it.`,
    };
  }
  return {
    kind: 'midas-ready', level: 'ok',
    zh: `已接通：Midas（${b.via || '来源未记录'}）+ dsh 的 MCP 客户端 + profile 补丁里 \`- insert:\` 包裹的 \`${MIDAS_PATCH_ROW_ID}\` 行都齐 ⇒ 重启 dsh web 后记忆走本地 SQLite（写入/召回不花 token）。`,
    en: `Ready: Midas (${b.via || 'source not recorded'}) + dsh's MCP client + the insert-wrapped \`${MIDAS_PATCH_ROW_ID}\` row are all in place — after a dsh web restart memory goes through the local SQLite store (no token cost for writes/recalls).`,
  };
}

/**
 * 组装客户端要的那一份 **Midas 就绪 + 首装引导** 数据（**服务端是唯一真源**）。
 * 客户端是手写 bundle、不能 `import lib/` ⇒ 命令、步骤、路径都必须随响应过去（同 `labels` 的先例）。
 * @returns {object}
 */
function buildMidasSetup({ env, home, bin, mcpClientInstalled, patchRowPresent, patchReadable, start, kind }) {
  const b = bin || {};
  const profile = memoryProfileName({ env });
  // `home` 要一起传下去：DB 路径与补丁路径必须用**同一份**解析（否则设置页显示的落点与实际写入的不是一处）。
  const dbPath = midasDbPath({ env, home });
  const installDir = b.found === true ? midasInstallDir(b.realPath || b.path) : null;
  return {
    statusKind: kind,
    ready: kind === 'midas-ready',
    profile,
    patchRowId: MIDAS_PATCH_ROW_ID,
    serverName: MIDAS_SERVER_NAME,
    patchRowPresent: patchRowPresent === true,
    patchReadable: patchReadable !== false,
    installCommand: MIDAS_INSTALL_COMMAND,
    mcpClientPackage: MIDAS_MCP_CLIENT_PACKAGE,
    // 三态：true / false / **null**（探测不可用 ⇒ 不许渲染成"没装"）
    mcpClientInstalled: mcpClientInstalled === true ? true : (mcpClientInstalled === false ? false : null),
    binary: {
      found: b.found === true,
      path: b.path || null,
      installDir,
      via: b.via || null,
      probeOk: b.probeOk === true,
      tried: Array.isArray(b.tried) ? b.tried.slice() : [],
    },
    dbPath,
    dbDir: dirname(dbPath),
    dbEnv: MIDAS_DB_ENV,
    start: start ? { ok: start.ok === true, error: String(start.error || ''), stderr: String(start.stderr || ''), ms: Number(start.ms) || 0 } : null,
    lookedAt: midasLookedAt(b),
    // 一句话"为什么值得装" + 一句"代价"（需求 D：如实说清、不吹）。
    why: {
      zh: 'Midas 是本机零 LLM 记忆服务：写入与召回想本地 SQLite，不花 token。',
      en: 'Midas is a local zero-LLM memory service: writes and recalls hit a local SQLite file and cost no tokens.',
    },
    tradeoff: {
      zh: '代价（说在前面）：它**不做整会话摘要** —— 只存/取你显式写入的事实与知识页。需要"总结整段对话"的场景，Hindsight 那一路更合适。',
      en: 'The tradeoff, up front: it does NOT summarize whole conversations — it stores and recalls the facts and knowledge pages you explicitly write. For "summarize this conversation", Hindsight is the better fit.',
    },
    steps: midasOnboardingSteps({ profile }),
  };
}

/**
 * 读**实际生效状态**：设置值是多少、补丁文件到底有没有禁用 Hindsight、两者是否一致。
 *
 * 为什么必须单独有这个函数：设置项的值只回答"用户想选什么"，而**用户真正关心的是"现在到底走哪个后端"**。
 * 两者会分叉（设置改了没点应用 / 补丁被别的工具改回去），而"我选了不使用"与
 * "我选了 Hindsight 但它不通"**绝不能渲染成同一个灰掉的东西** —— 前者是用户的选择，后者是故障。
 *
 * **绝不抛**（读不到文件 ⇒ `patchReadable:false` + note）：这条函数挂在设置页的 GET 上，抛了就是 500。
 *
 * @param {object} [input]
 * @param {object} [input.settings] - 当前设置（缺项按 spec 默认；由调用方从 `lib/settings.js` 取）。
 * @param {object} [input.env] - 环境变量。
 * @param {string} [input.home] - 家目录（测试注入）。
 * @param {string} [input.workspace] - 工作区根（Midas 那一层候选 `<workspace>/.midas-runtime/...` 要用）。
 * @param {object} [input.io] - IO 注入（默认 `node:fs` 只读那一半）；
 *   `io.midas = {isFile, realpath, resolvePackage, spawn}` / `io.getGlobalPrefix` 可注入发现与探测。
 * @param {object} [input.hindsight] - **可选**的 Hindsight 诊断摘要
 *   （`{exists, failing}`，由调用方从 `buildHindsightReport()` 取），用于把
 *   "启用了但不通"与"启用了"分开 —— 本模块不自己去探测（探测是只读诊断模块的职责）。
 * @param {object} [input.midas] - **可选**的发现结果（测试注入 ⇒ 用例可以完全不碰真实文件系统/npm）。
 * @param {boolean|null} [input.mcpClientInstalled] - `@deepseek-ai/dsh-mcp-client` 装没装进 profile。
 *   调用方用 **loader 条目名**探测（`lib/command.js` 的 `loaderEntryNames`；那条线踩过"apply 当刻服务表
 *   是空的"这个坑 ⇒ 只在**请求时**探，且允许 `null` = 探测不可用）。
 * @param {boolean} [input.midasProbe] - `true` 时对 Midas **真的启动一次**做握手（用户显式要求才传）。
 * @returns {Promise<object>} 状态对象（**绝不含任何机密**：它只读补丁文件，且从不回显文件内容）。
 *   `stored` = 用户**选**的后端（纯设置值）；`effective` = 此刻**真的在走**的后端 ——
 *   `'hindsight'` / `'off'` / `'midas'` 三值，与 `statusKind` 说的是同一件事（`midas` 只在
 *   `statusKind === 'midas-ready'` 时出现，其余四态如实回 `hindsight`，因为那几态的文案
 *   自己就写着"记忆仍走 Hindsight"）。**只认 `stored` 分叉**：`stored === 'midas'` 时
 *   `effective` 只会是 `'midas'`（就绪）或 `'hindsight'`（未就绪），**不会是 `'off'`** ——
 *   "Hindsight 那一行有没有被禁用"是 `hindsightDisabled` / `display` / `notes` 回答的问题，
 *   与"此刻走哪个后端"是两层语义（`effective` 只回答后者）。
 */
export async function readMemoryBackendState({ settings, env = process.env, home, workspace, io, hindsight, midas, mcpClientInstalled, midasProbe } = {}) {
  const patchPath = profilePatchPath({ env, home });
  const readText = (io && io.readText) || ((p) => readFile(p, 'utf8'));

  const rawStored = getSetting(settings, MEMORY_SETTING_PATH);
  const stored = MEMORY_BACKENDS.includes(rawStored) ? rawStored : DEFAULT_MEMORY_BACKEND;

  const notes = [];
  if (rawStored !== undefined && !MEMORY_BACKENDS.includes(rawStored)) {
    // 磁盘上被手改坏的值：`normalizeSettings()` 会按默认处理并上报 repaired，这里再如实说明一次 ——
    // 免得用户把"我选的值被吃掉了"当成插件 bug（"界面显示 A、生效是 B"正是最难排查的状态）。
    notes.push(`设置里的 \`${MEMORY_SETTING_PATH}\` 值非法（${JSON.stringify(rawStored)}）⇒ 按默认 \`${DEFAULT_MEMORY_BACKEND}\` 处理（设置页的"已修正"提示里有同一件事）。`);
  }

  let patchText = '';
  let patchExists = false;
  let patchReadable = true;
  const patchParseErrors = [];
  let hindsightDisabled = false;
  try {
    patchText = await readText(patchPath);
    patchExists = true;
    const parsed = parseRows(patchText);
    if (parsed.errors.length) {
      patchParseErrors.push(...parsed.errors);
      notes.push('补丁文件读到了，但形态不是本模块认识的样子 ⇒ 无法判断它有没有禁用 Hindsight（这与"没有禁用"是两件事）。');
    } else {
      const row = findHindsightRow(parsed.rows);
      hindsightDisabled = !!(row && row.disabled === true);
    }
  } catch (e) {
    patchReadable = false;
    notes.push(`读不到 profile 补丁文件（缺失或无权限）⇒ 无法判断 Hindsight 行有没有被禁用（这与"没有禁用"是两件事）：${errText(e)}`);
    // 两种零：上面那条说的是 Hindsight 行，这条把**同一个坑**在 `mcp-midas` 那一行上明说一次 ——
    // `midasRowKnown:false` 才是这条事实的正式载体，`midasRowPresent:false` 在这里只表示"不知道"。
    notes.push(`读不到 profile 补丁文件 ⇒ **也无从判断**那个 \`- insert:\` 包裹的 \`${MIDAS_PATCH_ROW_ID}\` 行在不在（这与"确实没有这一行"是两件事）⇒ \`midasRowKnown:false\`；此刻 \`midasRowPresent:false\` 只表示"不知道"，**不**表示"那一行不在"；\`midasRowRemovable\` 也如实为 false（读不到文件就无从下手）。`);
  }

  // ⚠️ `consistent` **不在这里**算了 —— 判据要用 `notWired`，而 `notWired` 要等 `midasDisplay`
  //    出来才有值（那一段在下面）。声明挪到 `effective` 旁边，两个都依赖 `notWired` 的 flag 住一起。
  // ── 两种零必须分得开（本仓 2026-09-19 立下的纪律）──────────────────────────────────────
  // `patchReadable === false` ⇒ `patchText` 是**空串**（读文件抛了），而"空串里没有那一行"与
  // "磁盘上那一行真的不在"是**两件事**。旧实现让两者都落到 `midasRowPresent:false`，
  // 于是消费者（设置页 / `client.js:2544` / 别的会话）读到 `false` 会把**"读不到，所以不知道"**
  // 当成**"确实没有那一行"** —— 这正是在 `hindsightDisabled`（见上面那条 note：这与"没有禁用"
  // 是两件事）与 `midasTopLevelRowPresent` 上已经各自处置过一次的那个坑，只漏了 `midasRowPresent`。
  // 所以：`midasRowKnown` 是**知道 / 不知道**那一维（读不到 ⇒ `false` = 无从判定），
  // `midasRowPresent` 保持既有布尔类型（`client.js` 读的是 `=== true`，改成 `null` 就是破坏性变更），
  // 但它**只在真正观察过文本时才可能为 `true`**（读不到 ⇒ 恒 `false`，绝不假报"看见了"）。
  /** 补丁里有没有**内层**（`- insert:` 之下）的 `mcp-midas` 行 —— 顶层写法不算（那条会被 dsh 静默跳过）。 */
  const patchRowPresent = findMidasInsertRow(patchText) !== null;
  // ── 那个 `mcp-midas` 行**与选没选 midas 无关**：它是补丁文件的事实 ────────────────────────
  // 真实缺陷（2026-09-19）：用户选 `off` 时旧实现把 `patchRowPresent` 只折进 `stored === 'midas'`
  // 那一支的 `midasSetup()` 里 ⇒ `off` 这一格**根本看不到**那一行还在。于是 MCP 服务照样启动、
  // 17 个 `mcp__midas__*` 工具照样注册，而界面写着「不会有任何记忆调用」—— 那句是假话。
  // 结论：这个事实必须**无条件**暴露（三个后端档位都要看得到），它是"如实呈现"的地基。
  /** 「那一行在不在」这件事**我们知道吗**：`false` = 补丁读不到 ⇒ 它只是**无从判定**（不是"不在"）。 */
  const midasRowKnown = patchReadable;
  const midasRowPresent = patchReadable === false ? false : patchRowPresent;   // 读不到 ⇒ 不假报"看见了"
  const topLevelMidasRowPresent = hasTopLevelMidasRow(patchText);
  // `removable` 刻意**问规划器本人**（dry-run），而不是在这里重写一遍判据：
  // "能不能删"的条件（形态不认识 / 是不是独苗 / 删完文件还合不合法）全都住在 `planMidasRowRemoval()`
  // 里，这里再推一遍就是**同一件事两个家** —— 下次改一处必然分叉（本仓头号返工源）。
  // ⚠️ `patchReadable === false` 时也照样算：它只是"我们手上这份文本（空串）能不能规划"，
  //    与"磁盘上那份能不能"是两件事 —— 所以对外的 `midasRowRemovable` 还要求 `patchReadable`。
  const midasRemovalPlan = midasRowPresent ? planMidasRowRemoval(patchText) : null;
  const midasRowRemovable = midasRowPresent && patchReadable && !!(midasRemovalPlan && midasRemovalPlan.ok && midasRemovalPlan.changed);

  // ── Midas 就绪（五态）：**只在用户真的选了 `midas`** 时才探 ──────────────────────────
  // 为什么按需探：发现层要跑一次 `npm prefix -g`（只跑一次，之后有模块级缓存），而绝大多数用户用的是
  // 默认的 Hindsight ⇒ 没选就不 spawn 任何进程、也不给任何结论（`midasSetup:null`）。
  let midasSetup = null;
  let midasDisplay = null;
  if (stored === 'midas') {
    let bin = midas || null;
    if (!bin) {
      try { bin = await discoverMidasBinary({ env, home, workspace, io: io && io.midas, getGlobalPrefix: io && io.getGlobalPrefix }); }
      catch (e) {
        // 发现过程抛错 ≠ "没装"：按 `probeOk:false` 走 unknown 分支（不许把探测故障说成"没装"）。
        bin = { found: false, path: null, realPath: null, via: null, tried: [], probeOk: false, notes: [`发现过程出错：${errText(e)}`] };
      }
    }
    const dbPath = midasDbPath({ env, home });
    let start = null;
    if (midasProbe && bin && bin.found) {
      // 只有用户显式要求才真的启动一次（与 Hindsight 的连通性探测同一口径：进页面不发任何探测请求）。
      try {
        start = await probeMidasStart({
          binPath: bin.path,
          installDir: midasInstallDir(bin.realPath || bin.path),
          dbPath,
          env,
          spawnImpl: io && io.spawn,
        });
      } catch (e) {
        start = { ok: false, error: `探测本身失败：${errText(e)}`, stderr: '', ms: 0 };
      }
    }
    midasDisplay = classifyMidasReadiness({ bin, mcpClientInstalled, patchRowPresent, patchReadable, start, lookedAt: midasLookedAt(bin) });
    midasSetup = buildMidasSetup({ env, home, bin, mcpClientInstalled, patchRowPresent, patchReadable, start, kind: midasDisplay.kind });
    for (const n of (bin && bin.notes) || []) notes.push(n);
    if (midasDisplay.kind !== 'midas-ready') {
      notes.push('Midas 的 DB 路径（`MIDAS_MCP_DB` **没有默认值**：不设 ⇒ 它回落到 InMemoryStore，记忆不落盘、悄悄蒸发）：' + dbPath);
    }
  }
  const notWired = stored === 'midas' && (!midasDisplay || midasDisplay.kind !== 'midas-ready');

  // 实际生效的后端 —— 判据与**新语义**（三档都管两行）逐条对齐，四个格子各有出处：
  //
  //   · `stored === 'midas'` **且已接线**（`notWired === false`）⇒ `'midas'`。这一格在二期之后
  //     **才**真的成立：落地时我们**同时**写了两件（插入 `mcp-midas` 行 ∧ 把 Hindsight 那一行
  //     `disabled: true`）⇒ Hindsight 的上下文注入已经停了，真正在走的就是 Midas。
  //     （一期这里回 `'hindsight'` 的理由是"Midas 未就绪时真正在走的永远是 Hindsight"——
  //      那条理由说的是**未就绪**那一半，二期把它收紧成条件，就绪这一半不再被它误伤。）
  //   · `stored === 'midas'` **且未接线**（`notWired === true`）⇒ `'hindsight'`。这一格是**安全不变量**
  //     的另一面：没有二进制时我们既不写 MCP 行、也**不关** Hindsight（否则用户同时失去两个后端）
  //     ⇒ Hindsight 那一行**确实还活着**，回 `'hindsight'` 是事实，不是近似。那几档文案自己就写着
  //     "记忆仍走 Hindsight"，两边说同一件事。
  //   · `stored === 'hindsight'` ⇒ **以补丁文件为准**：行启用 ⇒ `'hindsight'`；行**被**禁用 ⇒ `'off'`
  //     —— 这正是 `conflict` 那一档（文件赢了，重启后记忆是关着的）。这条"文件赢"的教义**保留**，
  //     且与新语义不矛盾：新语义承诺"选 hindsight 就把那一行启用"，而**承诺**不等于**事实**——
  //     设置改了没点应用、补丁被别的工具改回去，都会让两者分叉。落地后再读就是 `'hindsight'`
  //     （`effective` 与 `notWired`/`midas-ready` 两端对齐，e2e 有断言钉着）。
  //   · `stored === 'off'` ⇒ 禁用 ⇒ `'off'`；没禁用 ⇒ 文件里那一行还活着 ⇒ `'hindsight'`（如实说）。
  //
  // 位置有讲究：这一行**必须在 `midasDisplay` / `notWired` 之后**（两者都是先声明后赋值的
  // `let`/`const`，放到前面就是 TDZ 报错，不是"顺序问题"而是直接抛）。
  //
  // 判据刻意用 `notWired` 而不是重新推一遍 `midasDisplay.kind === 'midas-ready'`：两个 flag
  // 都由同一处赋值 ⇒ 结构上**不可能漂移**（重新推一遍就等于同一件事写两份，下次改一处就会分叉）。
  const effective = (stored === 'midas')
    ? (notWired ? 'hindsight' : 'midas')
    : (hindsightDisabled ? 'off' : 'hindsight');

  // ── `consistent`：**补丁里 Hindsight 那一行，和 `stored` 对那一行的要求，是否是同一件事** ───────
  //
  // 这个 flag 只回答**一个问题**：补丁的 Hindsight 行与 `stored` 为它规定的期望值是否吻合？
  // 它**不**回答"此刻在走哪个后端"（那是 `effective`），也**不**回答"这个后端是不是用户要的"
  // （那是 `statusKind` / `display.level`）。三者各问各的，混在一句里就会互相打脸。
  //
  // 期望值一格一格列清楚（`stored` × `notWired` ⇒ 对 Hindsight 行的要求）：
  //   · `hindsight`              ⇒ 该**启用** ⇒ 期望 `hindsightDisabled === false`
  //     （行被禁用 = `conflict` 那一档：文件赢了，重启后记忆是关着的 ⇒ 不一致）
  //   · `midas` **已接线**       ⇒ 该**禁用** ⇒ 期望 `hindsightDisabled === true`
  //     （落地 midas 是**同时**写两件事：插 `mcp-midas` 行 ∧ 把 Hindsight 行 `disabled: true`）
  //   · `off`                    ⇒ 该**禁用** ⇒ 期望 `hindsightDisabled === true`
  //     （没禁用 = `off-not-applied` ⇒ 不一致）
  //   · `midas` **未接线**       ⇒ **根本不是一致性问题** ⇒ 恒 `true`（见下）
  //
  // 「`midas` 未接线」为什么不是一致性问题（这是**产品决策**，不是实现细节）：
  //   没有找到 Midas 二进制时，我们**既不写 MCP 行、也不禁用 Hindsight**（安全不变量：否则用户
  //   同时失去两个后端）。也就是说**根本不存在**一个"文件侧的期望值"可供本 flag 比对 —— 这个状态
  //   已经被 `statusKind` / `notWired` / `level:'warn'` 完整且大声地报出去了（"选了 Midas 但没装"）。
  //   在这里再判一次"不一致"，就是在**产品自己认可的正确中间态**上拉一次**假警报**：用户会看到
  //   "设置与文件不一致"却无从下手，因为那个"不一致"正是我们**故意**不写文件造成的。
  //   ⇒ 这一格**恒回 `true`**（判给 `statusKind`，本 flag 不插嘴）。
  //   ⚠️ 这一格**与那一行此刻是否被禁用无关**：F 格（未接线 + 行启用）和 G 格（未接线 + 行禁用，
  //      多半是手工编辑或被别的工具写进去的）**都**回 `true`。两个后端都没在工作这件事，
  //      由 `level:'warn'` 去说，而不是由本 flag 去说。
  //
  // 旧式子（本次修复前）是：`stored === 'off' ? hindsightDisabled === true : hindsightDisabled === false`。
  // 它把"非 `off` 就要求 Hindsight 那一行**没被禁用**"当成通则 —— 这在**旧语义**下是对的（那时只有
  // `off` 会去禁用它，`midas` 只插自己那一行、压根不动 Hindsight）。但**新语义（三档都管两行）把这个
  // 前提推翻了**：落地 `midas` 是**同时**写两件事（插 `mcp-midas` 行 ∧ 把 Hindsight 行 `disabled: true`），
  // 因为不关掉 Hindsight 的上下文注入，真正在走的就还是它。于是**配置正确的已接线 Midas** 恰恰
  // `hindsightDisabled === true` ⇒ 健康态被旧式子判成"不一致"（实测：`statusKind='midas-ready'`、
  // `display.level='ok'`、`effective='midas'` 全是健康值，而 `consistent` 回 `false`）。
  //
  // 摘要表（**实测** 7 格，A–G；`notWired` 现在是一列，因为它决定 F/G 两格的走向）：
  //   | 格 | stored              | hindsightDisabled | notWired | 旧式子 | 本式子 |
  //   | A  | midas 已接线        | true              | false    | false  | true   |
  //   | B  | hindsight           | false             | false    | true   | true   |
  //   | C  | hindsight（冲突）   | true              | false    | false  | false  |
  //   | D  | off                 | true              | false    | true   | true   |
  //   | E  | off 未落地          | false             | false    | false  | false  |
  //   | F  | midas 未接线        | false             | true     | true   | true   |
  //   | G  | midas 未接线+行禁用 | true              | true     | false  | true   |
  //   ⇒ 7 格实测：A=true, B=true, C=false, D=true, E=false, F=true, **G=true**。
  //   ⚠️ `consistent === true` **不再**恒等于 `level === 'ok'`：F/G 两格都是 `warn`（Midas 没装，
  //      确实要告警）而本 flag 回 `true` —— 这正是上面那条决策的样子，**不是** bug。告警归 `level`，
  //      一致性归本 flag，两者回答不同的问题。
  //
  // ⚠️ 判据**刻意复用 `notWired`**，不在这里重推一遍 `midasDisplay.kind === 'midas-ready'`：
  //    `effective` 也是按 `notWired` 分叉的，两个 flag 必须由**同一处**赋值 ⇒ 结构上不可能漂移。
  //    重推一遍就是"同一件事两个家"（本仓头号返工源）：下次改就绪判据只会改一处、另一处静默分叉 ——
  //    而**这个缺陷本身就是那么来的**（旧的 `consistent` 就是没跟上语义变更的那一份）。
  //    复用之后，"Midas 没接上"这一件事实只有一个家（`notWired`），`effective` 与 `consistent`
  //    在该事实上的判断**结构对齐**：同一处赋值 ⇒ 不可能一个当它是"在走 Hindsight"、另一个当它是
  //    "文件不一致"。
  // ⚠️ 位置同理：这一行**必须在 `notWired` 之后**（`notWired` 是 `const`，放到前面是 TDZ 报错，
  //    不是"顺序不好"而是直接抛），所以它跟着 `effective` 一起住在 `notWired` 下游。
  const consistent = (stored === 'midas' && notWired)
    ? true
    : (stored === 'off' || stored === 'midas')
      ? hindsightDisabled === true
      : hindsightDisabled === false;

  // ── 结论只描述**观察到的现象**，不描述猜测（本仓 2026-09-16 的老教训）────────────────
  // ⚠️ `off` 这一格为什么必须**先分叉**（2026-09-19 的真实缺陷）：旧实现只有一句
  // 「已关闭…不会有任何记忆调用」，而那时补丁里那个 `- insert:` 包裹的 `mcp-midas` 行**原封不动** ——
  // Midas 的 MCP 服务照样启动、`mcp__midas__*` 工具照样注册。那句话**是假的**。
  // `off` 现在已经不是"一件事"，而是两件：Hindsight 停没停（`hindsightDisabled`）
  // × 那个 MCP 行还在不在（`midasRowPresent`）。两件都如实说，才配得上"诚实的界面"。
  // ⚠️ **没有** mcp-midas 行时的那句文本**逐字保留**（它在那个格子里是真的，且有测试钉着）。
  //
  // ── 同一个物理状态，在 `midas` 下是健康、在 `off` 下是告警（**这个不对称是故意的**）──────────
  // `{Hindsight 行被禁用} × {mcp-midas 行在}` 这一格正是**新语义下 `midas` 档的目标形态**：
  // 落到 `midas` 时 `midasDisplay.kind === 'midas-ready'` 就报"已接通"（ok）。可**同一个物理状态**
  // 也可以被手工编辑出来（补丁里两行都在，而设置值是 `off`）—— 那时它是**没写成的关闭动作的残留**，
  // 必须报 warn 并给一个能收敛的动作。为什么不合并成一档：**设置值才是用户的声明意图**。
  // `effective` / `statusKind` 回答的是"此刻真的在走哪个后端"，而健康与否问的是"这个后端
  // **是用户要的那个**吗"。两者一致时才叫健康；不一致时界面必须说出这个差异。
  let kind = 'on';
  let level = 'ok';
  let zh = '';
  let en = '';
  if (stored === 'off' && hindsightDisabled && midasRowPresent) {
    // 这一句里**四处**都不能少：① Hindsight 确实关了（那是真的）；② 但 MCP 行还在 ⇒ 服务会起来、
    // 工具会注册；③ **没有任何东西自动调它们**（不夸大成"还在用的后端"，也不缩回"完全没接"）；
    // ④ 库落在哪 —— 而 `MIDAS_MCP_DB` **没有默认值**，说清楚才不至于让人以为"既然没用它、库是空的"。
    // ⚠️ 措辞按**残留 / 怎么收敛**写，不按"正常结局"写：新语义下正常的 `off` 落地会把那一行**删掉**
    // （`planMemoryBackendPatch` 的 `off` 档复用 `planMidasRowRemoval()`），所以走到这一格只可能是
    // **手改出来的**或**别处写进去的**。说得像正常结局，用户就不会去点那个一键清掉。
    kind = 'off-midas-row-live'; level = 'warn';
    zh = '设置是「不使用」，Hindsight **确实**已关闭（补丁里 `hindsight` 行是 `disabled: true`）—— '
      + `但补丁里那个 \`- insert:\` 包裹的 \`${MIDAS_PATCH_ROW_ID}\` 行**还在**：这不是本页选「不使用」写出来的`
      + '（那一步会**连它一起删掉**），多半是手工编辑或被别的工具写进去的 ⇒ 重启 dsh web 后 '
      + 'Midas 的 MCP 服务**照样启动**、它的工具**照样注册** —— 所以这**不是**"记忆完全没接"。'
      + '区别在于：**没有任何东西会自动调用**它们 —— 本插件不再自动读写记忆，'
      + '只有你自己（或别的会话）显式调那些工具时才会动到库。'
      + `那个库就是 \`${MIDAS_DB_ENV}\` 指到的文件（它**没有默认值**：这一行没设它时，`
      + 'Midas 会落到内存存储、什么都不会落盘）。'
      + '收敛办法（两条都行）：再选一次「不使用」并保存（那一步现在会**真的**删掉那一行），'
      + '或用下面的「移除 mcp-midas 那一行」；两者之后都要重启 dsh web。';
    en = 'You chose "off" and Hindsight IS off (the patch sets `disabled: true` on the `hindsight` row) — '
      + `BUT the \`- insert:\`-wrapped \`${MIDAS_PATCH_ROW_ID}\` row is STILL in the patch. Saving "off" on this page does NOT produce this `
      + '(that step removes the row too) — it was most likely hand-edited or written by another tool. So after a dsh web restart '
      + 'the Midas MCP server still starts and its tools are still registered. This is NOT "no memory wiring at all". '
      + 'The difference: nothing calls them automatically — this plugin no longer reads or writes memory on its own; '
      + 'only an explicit tool call (by you or another session) touches the store. That store is whatever '
      + `\`${MIDAS_DB_ENV}\` points at (it has NO default: without it Midas falls back to an in-memory store and nothing is persisted). `
      + 'To converge, either pick "off" once more (that save now really removes the row) or use "Remove the mcp-midas row" below, then restart dsh web.';
  } else if (stored === 'off' && hindsightDisabled) {
    kind = 'off'; level = 'ok';
    zh = '已关闭：profile 补丁里 `hindsight` 行是 `disabled: true` ⇒ 重启 dsh web 后不会有任何记忆调用。';
    en = 'Off: the profile patch disables the `hindsight` row, so after a dsh web restart no memory calls happen.';
  } else if (stored === 'off' && !hindsightDisabled) {
    kind = 'off-not-applied'; level = 'warn';
    zh = '设置是「不使用」，但补丁文件**还没有**禁用 `hindsight` 行（改动没落地，或被别的工具改回去了）⇒ 现在重启也关不掉记忆。用上面的选择器再保存一次即可对齐（那一步会**同时**把 `hindsight` 行禁用、并移除 `mcp-midas` 那一行）。'
      // 这一格里"还没关掉 Hindsight"与"那里还躺着一行 mcp-midas"是**两个**都得说的事实：
      // 只报前者会让用户以为"把 Hindsight 关掉就干净了"，而那一行是**另一个**后端的东西。
      + (midasRowPresent
        ? ` ⚠️ 另外：补丁里那个 \`- insert:\` 包裹的 \`${MIDAS_PATCH_ROW_ID}\` 行也在 ⇒ 就算 Hindsight 关好了，`
          + 'Midas 的 MCP 服务仍会随 dsh web 启动、它的工具仍会注册（没有任何东西自动调它们）。'
          + '两件事都要处置：再保存一次让 Hindsight 落地**并**清掉那一行，'
          + '或先用下面的「移除 mcp-midas 那一行」单独清掉它。'
        : '');
    en = 'You chose "off" but the patch file does NOT yet disable the `hindsight` row — restarting now would not turn memory off. Saving once more lands it (that save also removes the `mcp-midas` row).'
      + (midasRowPresent
        ? ` Separately: the \`- insert:\`-wrapped \`${MIDAS_PATCH_ROW_ID}\` row is present too — even once Hindsight is off, `
          + 'the Midas MCP server still starts with dsh web and its tools stay registered (nothing calls them automatically). '
          + 'Both need handling: save once more to land Hindsight (which also clears that row), or use "Remove the mcp-midas row" below to clear it on its own.'
        : '');
  } else if (stored === 'hindsight' && hindsightDisabled) {
    kind = 'conflict'; level = 'bad';
    zh = '设置是「Hindsight」，但补丁文件把 `hindsight` 行**禁用**了 —— 两者冲突，**以补丁文件为准**（重启后记忆是关着的）。';
    en = 'You chose Hindsight, but the patch file disables the `hindsight` row — the file wins, so memory stays off after a restart.';
  } else if (stored === 'midas') {
    // 五态里**每一态**的文案都自带"记忆此刻仍走 Hindsight、仍按 token 计费"这句实话（已接通那态除外）
    // —— 静默 no-op 是本仓最忌讳的形态：用户以为换到了本地零 LLM 的后端，实际还在按 token 计费。
    kind = midasDisplay.kind; level = midasDisplay.level; zh = midasDisplay.zh; en = midasDisplay.en;
  } else if (hindsight && hindsight.exists === false) {
    kind = 'on-unconfigured'; level = 'warn';
    zh = '设置是「Hindsight」且补丁没有禁用它，但**找不到 Hindsight 配置文件** ⇒ 它多半连不上（见下方诊断）。这与「你选了不使用」是两件事。';
    en = 'Hindsight is selected and not disabled, but no config file was found — most likely unreachable (see diagnostics below). This is NOT the same as choosing "off".';
  } else if (hindsight && hindsight.failing === true) {
    kind = 'on-failing'; level = 'bad';
    zh = '设置是「Hindsight」且补丁没有禁用它，但诊断显示**有未恢复的失败** ⇒ 记忆可能没生效（这不是"你没开"，而是"开了但不通"）。';
    en = 'Hindsight is selected and not disabled, but diagnostics show an unrecovered failure — memory may not work. Not "off", but "on and failing".';
  } else {
    kind = 'on'; level = 'ok';
    zh = 'Hindsight 已启用（profile 补丁没有禁用这一行），记忆走它。';
    en = 'Hindsight is on (the profile patch does not disable it).';
  }

  return {
    ok: true,
    settingPath: MEMORY_SETTING_PATH,
    backends: MEMORY_BACKENDS,
    defaultBackend: DEFAULT_MEMORY_BACKEND,
    stored,
    intent: stored,
    effective,
    hindsightDisabled,
    consistent,
    notWired,
    patchPath,
    patchExists,
    patchReadable,
    patchParseErrors,
    rowId: HINDSIGHT_PLUGIN_ROW_ID,
    rowName: HINDSIGHT_PLUGIN_ROW_NAME,
    statusKind: kind,
    display: { level, zh, en },
    // ── 那个 `mcp-midas` 行的事实（**与 `stored` 无关**，三个档位都带出去）──────────────────
    // 四个字段都是**原始事实 / 已经算好的结论**，客户端照渲染即可：客户端是手写 bundle、
    // **不能 `import lib/`**（同 `labels`/`midasSetup` 的先例）⇒ 它手上没有 `findMidasInsertRow()`，
    // 也没有 `MIDAS_PATCH_ROW_ID` 这些常量。少给一个字段，客户端就会就地硬编一份 —— 那正是
    // "同一件事两个家"（本仓头号返工源）。
    midasRowPresent,
    // 两种零的**正式载体**：`midasRowKnown:false` = 补丁读不到 ⇒ "那一行在不在"**无从判定**。
    // 为什么单给一个字段而不是直接把 `midasRowPresent` 改成 `null`：后者是**破坏性变更** ——
    // `client.js:2544` 读的是 `st.midasRowPresent === true`（真值判据），且老服务端下它是 `undefined`
    // ⇒ 客户端那段本来就按"不知道就不渲染"写的；把类型换掉会让已发布的客户端与服务端对不上版本。
    // 消费口径：`known === false` ⇒ **什么都别断言**（不警告、不给按钮）；`known === true` 时才轮到
    // `present` / `removable` 说话。这与 `hindsightDisabled` / `midasTopLevelRowPresent` 的纪律是同一条。
    midasRowKnown,
    // `removable` 的判据 = "有这一行" ∧ "补丁读得到" ∧ "规划器 dry-run 说能删（含出口自检）"。
    // 三者缺一都不能承诺"能一键清掉"：读不到文件就无从下手；形态不认识 / 删完文件会非法时，
    // 规划器自己就会拒绝 —— 界面据此把按钮禁掉，而不是让用户点了才发现失败。
    midasRowRemovable,
    // 行 id 与服务名（给客户端渲染诚实文案用；真源仍是本模块的常量）。
    midasRowId: MIDAS_PATCH_ROW_ID,
    midasServerName: MIDAS_SERVER_NAME,
    // **顶层**写法（缩进 0）的那一行：它是另一种 row（load-override ⇒ dsh warn + skip，**不生效**），
    // 单独一个字段 —— 与 `midasRowPresent` 混在一起会让界面把"不生效的那条"说成"接上了"。
    // `planMidasRowRemoval()` **不删**它（理由写在那条分支的注释里），所以这是个"只读事实"。
    midasTopLevelRowPresent: topLevelMidasRowPresent,
    // Midas 的**就绪 + 首装引导**（只在用户真的选了 `midas` 时非 null）：客户端要的每一步命令、
    // DB 路径、找过哪里、五态结论都在这里 —— 客户端是手写 bundle、不能 `import lib/`（同 `labels` 的先例）。
    midasSetup,
    // 重启语义：这是**加载时机**决定的（profile 加载时读补丁），与本模块改没改无关 —— 如实说明。
    restartReason: 'profile 补丁（cordis.patch.yml）在**加载 profile 时**读取 ⇒ 改动要重启 `dsh web` 才生效。',
    configRestartKeys: HINDSIGHT_RESTART_KEYS,
    notes,
  };
}

/**
 * 落地一次后端切换：读现有补丁 → 纯函数规划 → 受控入口原子写。
 *
 * 失败语义：取值非法 / 文件形态不认识 ⇒ `{ok:false, status:400}`（**未写盘**）；
 * IO 失败 ⇒ `{ok:false, status:500}`（原文件未动 —— 临时文件 + rename 保证这一点）；
 * 没有改动 ⇒ `{ok:true, changed:false, saved:false, needsRestart:false}`（**不假报已保存**）。
 *
 * `midas` 这一支还多做两件事（都在同一份"最小、保真"纪律之下）：
 *   ① **先建 DB 目录**（SQLite 要在里面写 `-wal`/`-shm`；目录不在 ⇒ Midas 静默回落到 InMemoryStore，
 *      记忆等于蒸发）。`mkdir` 不算写绕过（棘轮只数 `writeFile`/`appendFile`/`rename`，
 *      `lib/command.js` 本来就有多处 `mkdir`）；**绝不**把 `.sqlite` 文件本身递给
 *      `writeHostStateFileAtomic` —— 原子替换字符串会把数据库写坏；
 *   ② 用**发现到的绝对路径**生成 `- insert:` 行（发现不到时**不写**那一行，并如实说明"未接通"）。
 *
 * ⚠️ **二期（2026-09-19）的行为变更**：三档现在都是"两行都管"的真二选一（见 `planMemoryBackendPatch`
 * 的表格）。对用户的可见差异有两条，且都在回执里**当次**说出来：
 *   · 选 `midas` **且真的接上了** ⇒ 补丁里 `hindsight` 那一行被 `disabled: true`。Hindsight 的上下文
 *     注入与它的工具因此**停用**（回执里有一句专门的"行为变更"note）。以前这一档只做加法 ⇒ 重启后
 *     两个后端同时活着，而设置页只说了一个。
 *   · 选 `hindsight` / `off` ⇒ `mcp-midas` 那一行被**移除**（`off` 的那个原始缺陷因此不会再有）。
 * 回执新增 `hindsightDisabled`（这一次写完之后补丁里 Hindsight 是不是禁用态；形态不认识 ⇒ `null`）。
 *
 * @param {object} [input]
 * @param {string} [input.backend] - `hindsight` / `midas` / `off`。
 * @param {object} [input.env] - 环境变量。
 * @param {string} [input.home] - 家目录（测试注入）。
 * @param {string} [input.workspace] - 工作区根（发现层的一层候选要用）。
 * @param {object} [input.io] - IO 注入（默认 `node:fs` 只读那一半；写永远走受控入口）。
 * @param {object} [input.midas] - **可选**的发现结果（测试注入 ⇒ 用例不碰真实文件系统/npm/require）。
 * @returns {Promise<object>} 回执（**绝不含机密**：不含任何文件内容，只有路径/计数/文案）。
 */
export async function applyMemoryBackend({ backend, env = process.env, home, workspace, io, midas } = {}) {
  const target = String(backend == null ? '' : backend);
  const patchPath = profilePatchPath({ env, home });
  const base = {
    ok: false, status: 400, path: patchPath, backend: target, changed: false, saved: false,
    patchExisted: false, needsRestart: false, notWired: target === 'midas',
    configRestartKeys: HINDSIGHT_RESTART_KEYS, notes: [], errors: [],
  };
  if (!MEMORY_BACKENDS.includes(target)) {
    return { ...base, errors: [`后端只能是 ${MEMORY_BACKENDS.join(' / ')}（收到 ${JSON.stringify(backend)}）`] };
  }

  const readText = (io && io.readText) || ((p) => readFile(p, 'utf8'));
  let existingText = '';
  let patchExisted = false;
  try {
    existingText = await readText(patchPath);
    patchExisted = true;
  } catch (e) {
    if (String((e && e.code) || '') !== 'ENOENT') {
      return { ...base, status: 500, errors: [`读取 profile 补丁失败（**未写盘**）：${errText(e)}`] };
    }
  }

  // ── midas：先发现二进制 + 建好 DB 目录，再把结果交给（纯函数的）补丁规划 ─────────────────
  let midasPlan = null;
  let bin = null;
  let dbPath = '';
  if (target === 'midas') {
    bin = midas || null;
    if (!bin) {
      try { bin = await discoverMidasBinary({ env, home, workspace, io: io && io.midas, getGlobalPrefix: io && io.getGlobalPrefix }); }
      catch (e) { bin = { found: false, path: null, realPath: null, via: null, tried: [], probeOk: false, notes: [`发现过程出错：${errText(e)}`] }; }
    }
    dbPath = midasDbPath({ env, home });
    if (bin && bin.found) {
      midasPlan = { binPath: bin.path, installDir: midasInstallDir(bin.realPath || bin.path), dbPath, serverName: MIDAS_SERVER_NAME };
    }
  }

  const plan = planMemoryBackendPatch(existingText, target, midasPlan ? { midas: midasPlan } : {});
  if (!plan.ok) {
    // 与 `removeMidasRow()` 的拒绝支同一纪律（那里的注释写透了为什么）：`plan.notes` 是**边改边写**
    // 的进度句 —— `refuse()` 的**每一条**路径都在 `out.splice(...)` / `out.push(...)` 之后
    // （形态拒绝在 `parseRows` 之后、`finish()` 的两道自检更是在"已经把新文本拼好了"之后）。
    // 那些改动一个字节都没落盘，回执里却留着"追加了一行 / 把它改成了…"的叙述 = **假报成功**。
    // 换成拒绝说明：理由逐条来自 `plan.errors`（同时原样带在 `errors` 里），一个字都不丢。
    const refusal = `**什么都没写、原文件一个字节都没动**（${plan.errors.length ? '规划阶段被拒绝' : '请求被拒绝'}）⇒ 已丢弃规划过程中产生的"将要修改"说明，因为它们描述的动作**没有发生**。拒绝理由（逐条见 \`errors\`）：${plan.errors.map((x) => String(x)).join(' ')}`;
    return { ...base, errors: plan.errors, notes: [refusal] };
  }

  const notes = plan.notes.slice();
  for (const n of (bin && bin.notes) || []) notes.push(n);
  let dbDirReady = false;
  let dbDirError = '';
  if (target === 'midas') {
    if (!midasPlan) {
      // 写一条指向不存在命令的行 = **假接通**（界面上像好了、实际启动失败）。宁可不写，把缺什么说清楚。
      notes.push(`**Midas 未接通**：没找到 \`${MIDAS_BIN_NAME}\` 二进制（已按 5 层顺序找过：${midasLookedAt(bin) || '无候选'}）⇒ \`${MIDAS_PATCH_ROW_ID}\` 那一行**没有**插入 profile 补丁，实际记忆仍走 Hindsight。先按安装步骤把它装上（或设 \`${MIDAS_BIN_ENV}\` 指向你那份）。`);
    } else {
      // 目录必须先存在：SQLite 要在旁边写 `-wal` / `-shm`（`MIDAS_MCP_DB` 没有默认值，路径必须可用）。
      try {
        await mkdir(dirname(dbPath), { recursive: true, mode: MIDAS_DB_DIR_MODE });
        dbDirReady = true;
        notes.push(`已确保 Midas 的 DB 目录存在：${dirname(dbPath)}（SQLite 要在里面写 \`-wal\`/\`-shm\`）。`);
      } catch (e) {
        dbDirError = errText(e);
        notes.push(`⚠️ 建 DB 目录失败（${dbDirError}）：\`${dirname(dbPath)}\`。目录不可用时 Midas **不会报错**，而是回落到内存存储 ⇒ 记忆会悄悄蒸发。请先修好这个目录的权限。`);
      }
      notes.push(`\`${MIDAS_PATCH_ROW_ID}\` 行写入的 DB 路径：${dbPath}（\`${MIDAS_DB_ENV}\` **没有默认值**，不设就等于记忆不落盘）。`);
      // ── 行为变更的**当次披露**（本仓房规：文件头那句「"选了"与"真生效"是两件事」）────────────
      // 二期之前，选 `midas` 是**加法**（只插一行，Hindsight 照旧活着、照旧注入上下文、照旧计费）。
      // 现在它是**真二选一**：Hindsight 那一行会被 `disabled: true` 置为禁用 —— 也就是说，
      // **用户会丢东西**（整会话摘要那一路停了）。这种事必须在回执里**当次**说清，不能只写在
      // 文档里：用户是看着这一次的回执决定要不要重启的。
      notes.push('**行为变更（这一次和以前不一样）**：选 `midas` 现在会把 Hindsight **一起关掉** —— 补丁里 `hindsight` 那一行被写成 `disabled: true`。'
        + `原因：三选一在补丁里**只有两行**可管（\`hindsight\` 插件行 × \`${MIDAS_PATCH_ROW_ID}\` 那一行），`
        + '以前只做加法 ⇒ 重启后两个后端会**同时活着**（Hindsight 照旧注入上下文、照旧按 token 计费），而设置页只说了一个。')
      ;
      notes.push('具体后果：重启 `dsh web` 之后，Hindsight 的上下文注入与它的 MCP 工具**都不再运行**；'
        + '记忆改走本机 Midas 的 SQLite（写入/召回不花 token）。代价是 Midas **不做整会话摘要** —— '
        + '需要"总结这一段对话"的场景会没有东西可总结。想回到 Hindsight：把这一项选回「Hindsight」并重启即可。');
    }
  }

  let saved = false;
  if (plan.changed) {
    try {
      await writeHostStateFileAtomic(patchPath, plan.text, { mode: MEMORY_PATCH_FILE_MODE, dirMode: MEMORY_PATCH_DIR_MODE });
      saved = true;
    } catch (e) {
      return { ...base, status: 500, patchExisted, changed: plan.changed, errors: [`写入 profile 补丁失败（原文件未动）：${errText(e)}`], notes };
    }
  }
  const needsRestart = saved;      // 只有**真的**改了补丁才需要重启；没改动时如实说"本次无需重启"
  if (!saved) notes.push('本次没有改动 ⇒ 不需要为这次操作重启（不假报已保存）。');
  else notes.push('profile 补丁已改 ⇒ **需要重启 `dsh web`** 才生效（它在加载 profile 时读取）。');

  // `notWired` = "请求的后端此刻并没有真的上线"：midas 只有"补丁里确实有那一行"才算接上
  // （`changed:false` 也可能是**本来就写好了** ⇒ 用回读文本判定，不用 `saved` 猜）。
  // ⚠️ 判据**只**看那一行在不在，不看 Hindsight 那一行的启用位：二期的 `midas` 落地是"两件一起写"，
  // 而"接没接上"问的就是 MCP 那一行 —— 两件事分开报（Hindsight 的启用位在下面的 `hindsightDisabled`
  // 与设置页的 `state` 里），合在一起就又变成"一个字段说两件事"。
  const midasRowInPlace = !!(midasPlan && findMidasInsertRow(plan.text || ''));
  const notWired = target === 'midas' && !midasRowInPlace;
  // 二期新增：这一次落地后**补丁里 Hindsight 到底是不是禁用态**（回读已写入的目标文本判定）。
  // 它是"两件一起写"里另一件的**可断言出口** —— 客户端/测试不必自己解析补丁去猜。
  // 形态不认识 ⇒ `null`（照旧"不下结论"，与状态层同一纪律）。
  const hindsightRowVerified = (() => {
    const verify = parseRows(plan.text || '');
    if (verify.errors.length) return null;
    const row = findHindsightRow(verify.rows);
    return !!(row && row.disabled === true);
  })();

  return {
    ok: true, status: 200, path: patchPath, backend: target,
    patchExisted, changed: plan.changed, saved, needsRestart,
    restartReason: needsRestart
      ? 'profile 补丁（cordis.patch.yml）在**加载 profile 时**读取 ⇒ 改动要重启 `dsh web` 才生效。'
      : '本次没有改动 profile 补丁 ⇒ 无需重启。',
    notWired,
    // 这一次写完之后，补丁里 `hindsight` 那一行是不是 `disabled: true`（三档的**另一半**契约）。
    hindsightDisabled: hindsightRowVerified,
    // midas 的落地细节（**只有路径/布尔**，没有文件内容）：客户端与测试据此核对"到底写了什么"。
    midas: target === 'midas' ? {
      binaryFound: !!(bin && bin.found),
      via: (bin && bin.via) || null,
      binPath: (bin && bin.path) || null,
      installDir: midasPlan ? midasPlan.installDir : null,
      dbPath: dbPath || null,
      dbDirReady,
      dbDirError,
      patchRowId: MIDAS_PATCH_ROW_ID,
      rowPresent: midasRowInPlace,
    } : null,
    // 只读引用：Hindsight 配置文件里改这两个键**同样**需要重启（改 token 不用）——
    // 真源在 `lib/hindsight-config-write.js`，本模块不抄第二份清单。
    configRestartKeys: HINDSIGHT_RESTART_KEYS,
    notes, errors: [],
  };
}

/**
 * 落地一次「把 `mcp-midas` 那一行从 profile 补丁里拿掉」的动作。
 *
 * ── 它治的是哪一个真实缺陷（2026-09-19 复现，逐字）──────────────────────────────
 * 用户选「不使用」时，本模块只写了 `- id: hindsight` + `disabled: true`，**完全没碰**那个
 * `- insert:` 包裹的 `mcp-midas` 行 ⇒ Midas 的 MCP 服务照样随 `dsh web` 启动、17 个
 * `mcp__midas__*` 工具照样注册，而界面写着「不会有任何记忆调用」。这个动作就是那个"一键清掉"。
 * ⚠️ 它**不**改任何设置值（`memory.backend` 仍由 `applyMemoryBackend` + `/settings` 管）：
 * 一次动作只改它声明要改的那一处，"顺手把设置也改了"会让用户看不懂刚才到底发生了什么。
 *
 * ── 结构与 `applyMemoryBackend` 逐条对齐（同一套失败语义，读的人不必学第二遍）──────────
 *   · 读补丁：`ENOENT` 当作"文件还不存在"（空数组）继续；其它 IO 错误 ⇒ `{ok:false, status:500}`；
 *   · 规划：交给**纯函数** `planMidasRowRemoval()`（形态不认识 ⇒ `ok:false, status:400`，一个字节不落盘）；
 *   · 写盘：**只**走 `writeHostStateFileAtomic()`（写绕过棘轮基线 0，本模块不出现 `writeFile`/`rename`）；
 *   · 没有改动 ⇒ `changed:false, saved:false, needsRestart:false`（**不假报已保存**，也不假报需要重启）。
 *
 * ⚠️ `restartReason` **恒非 null**（与 `applyMemoryBackend` 不同）：那个函数在"没改动"时回"无需重启"，
 * 因为它的调用方总在问"这次改没改"。这一个动作是**删除**，两种结局都有话要说 ——
 * 改了 ⇒ 补丁变了，必须重启 `dsh web`；没改 ⇒ 那一行本来就不在，**也不**需要重启。
 * 用户点的是"清掉它"，回一句"无需重启"而不说为什么，就是本仓最忌讳的那种沉默。
 *
 * @param {object} [input]
 * @param {object} [input.env] - 环境变量。
 * @param {string} [input.home] - 家目录（测试注入）。
 * @param {string} [input.workspace] - 工作区根（与其它入口同一签名；本动作不需要它，保留是为了调用点一致）。
 * @param {object} [input.io] - IO 注入（默认 `node:fs` 只读那一半；写永远走受控入口）。
 * @returns {Promise<object>} 回执（字段逐一见下；**绝不含机密**：不含任何文件内容，只有路径/计数/文案）。
 *   `ok` / `status` / `path` / `changed` / `saved` / `patchExisted` / `needsRestart` / `restartReason` /
 *   `rowId` / `rowPresent` / `rowRemovable` / `topLevelRowPresent` / `configRestartKeys` / `notes` / `errors`。
 */
export async function removeMidasRow({ env = process.env, home, workspace, io } = {}) {
  const patchPath = profilePatchPath({ env, home });
  const base = {
    ok: false, status: 400, path: patchPath, changed: false, saved: false,
    patchExisted: false, needsRestart: false, restartReason: null,
    rowId: MIDAS_PATCH_ROW_ID, rowPresent: false, rowRemovable: false, topLevelRowPresent: false,
    configRestartKeys: HINDSIGHT_RESTART_KEYS, notes: [], errors: [],
  };

  const readText = (io && io.readText) || ((p) => readFile(p, 'utf8'));
  let existingText = '';
  let patchExisted = false;
  try {
    existingText = await readText(patchPath);
    patchExisted = true;
  } catch (e) {
    // 与 `applyMemoryBackend` 同一口径：只有 `ENOENT` 才是"还没有这个文件"（⇒ 空数组 ⇒ 规划器
    // 会说"本来就没有那一行"）。权限/IO 故障照旧 500，**不写盘**。
    if (String((e && e.code) || '') !== 'ENOENT') {
      return { ...base, status: 500, errors: [`读取 profile 补丁失败（**未写盘**）：${errText(e)}`] };
    }
  }

  const plan = planMidasRowRemoval(existingText);
  if (!plan.ok) {
    // 形态不认识 ⇒ 400 且**一个字节都不落盘**（`plan.text` 恒为 null）。
    //
    // ⚠️ 这一支**绝不回传 `plan.notes`**（2026-09-19 真实缺陷）：`planMidasRowRemoval()` 的 notes 是
    // **边删边写**的 —— 「这一块是那个 `- insert:` 底下的**唯一**子项 ⇒ 连表头一起删掉」那句是在
    // `out.splice(...)` **之后**才 push 的。拒绝路径上那些 splice 一个都没落地，可回执里却躺着一句
    // "删掉了"的叙述 ⇒ 一个 `ok:false / status:400` 的失败回执里写着成功的剧情（本仓最忌讳的假报，
    // 而且比少说更坏：只读 `notes` 的调用方会把失败当成成功）。
    //
    // 选的是"(b) 换成拒绝说明"而不是"(a) 干脆不带 notes"：notes 这一栏是回执的**唯一人话位**
    // （客户端与设置页把它整段渲染），空着等于用户只看到一个 400、看不到**为什么**拒。
    // 拒绝的**理由一个字都不丢** —— 它住在 `plan.errors` 里（逐条带行号），这里把理由并进 notes，
    // 同时 `errors` 原样带上（一个给程序看、一个给人看，不是两份真源）。
    // 整段丢掉 `plan.notes` 是安全的：`ok:false` 只可能从 `refuse()` 出，而 `refuse()` 之前的所有
    // push 点都是"正在删什么"的进度句（见函数内的 push 清单）⇒ 不存在"必须保留的诊断句"。
    const refusal = `**什么都没删、一个字节都没写盘**（补丁形态不是本模块认识的样子）⇒ 已丢弃规划过程中产生的"将要删除"说明，因为它们描述的动作**没有发生**。拒绝理由（逐条见 \`errors\`）：${plan.errors.map((x) => String(x)).join(' ')}`;
    return {
      ...base,
      patchExisted,
      topLevelRowPresent: hasTopLevelMidasRow(existingText),
      errors: plan.errors,
      notes: [refusal],
    };
  }

  const notes = plan.notes.slice();
  // 这两个字段回答的是"**动之前**它是什么样"（`plan` 之后文件还没变），所以用 `existingText` 判定 ——
  // 用 `plan.text` 判会把"刚刚删掉了"读成"本来就没有"，两个事实混成一个。
  const rowPresent = findMidasInsertRow(existingText) !== null;
  const topLevelRowPresent = hasTopLevelMidasRow(existingText);

  let saved = false;
  if (plan.changed) {
    try {
      await writeHostStateFileAtomic(patchPath, plan.text, { mode: MEMORY_PATCH_FILE_MODE, dirMode: MEMORY_PATCH_DIR_MODE });
      saved = true;
    } catch (e) {
      return { ...base, status: 500, patchExisted, rowPresent, rowRemovable: true, topLevelRowPresent, errors: [`写入 profile 补丁失败（原文件未动）：${errText(e)}`], notes };
    }
  }
  const needsRestart = saved;      // 只有**真的**改了补丁才需要重启；没改动时如实说"这次不用重启"
  if (!saved) notes.push('本次没有改动 ⇒ 不需要为这次操作重启（不假报已保存）。');
  else notes.push('profile 补丁已改 ⇒ **需要重启 `dsh web`** 才生效（它在加载 profile 时读取）。');

  return {
    ok: true, status: 200, path: patchPath,
    patchExisted, changed: plan.changed, saved, needsRestart,
    restartReason: needsRestart
      ? 'profile 补丁（cordis.patch.yml）在**加载 profile 时**读取 ⇒ 改动要重启 `dsh web` 才生效。'
      : '本次没有改动 profile 补丁 ⇒ 无需重启。',
    rowId: MIDAS_PATCH_ROW_ID,
    // 删**之前**在不在（`changed:false` 也可能是"本来就没有" ⇒ 与 `saved` 是两件事，别合并）。
    rowPresent,
    // 删之前的 dry-run 结论（`rowPresent && plan.ok && plan.changed`）—— 客户端不必自己推。
    rowRemovable: rowPresent && plan.ok && plan.changed,
    // 顶层写法（缩进 0）：**不生效**（load-override ⇒ dsh warn + skip），本动作**不删**它 ⇒ 如实带出去。
    topLevelRowPresent,
    // 只读引用：Hindsight 配置文件里改这两个键**同样**需要重启（改 token 不用）——
    // 真源在 `lib/hindsight-config-write.js`，本模块不抄第二份清单。
    configRestartKeys: HINDSIGHT_RESTART_KEYS,
    notes, errors: [],
  };
}
