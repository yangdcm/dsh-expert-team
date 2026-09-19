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
 * 编辑策略（**保守优先**，每一处都有注释说明为什么这么选）：
 *   · `off`：补丁里已有 `hindsight` 行 ⇒ 把它的 `disabled` 改成/补成 `true`；没有这一行 ⇒ 文件末尾追一行。
 *   · `hindsight` / `midas`：若那一行是**我们自己的规范形态**（逐字等于 `- id: hindsight` + `  disabled: true`）
 *     ⇒ **整行删掉**（文件回到"没有 override"的状态）；否则只把 `disabled: true` 改成 `false`
 *     —— 那一行可能夹着别的键、可能是别的插件写的，整行删除比改一个值冒险得多。
 *   · `midas` **并且**给了 `opts.midas`（发现到了二进制）时再多做一件事：插入/替换 `- insert:` 包裹的
 *     `mcp-midas` 行（命令 / args / env / cwd 全部**显式**，见 `midasPatchRowLines`）。
 *     没给 `opts.midas`（没找到二进制）⇒ **不写**那一行：写一条指向不存在命令的行 = 假接通。
 *
 * 出口处还有一道**自检**（这是本函数最值钱的一步）：把生成的新文本**只读地回读一遍**，
 * 确认它真的编码了请求的状态；不一致就 `ok:false`、**一个字节都不落盘**
 * —— "用户选了 hindsight 却被写成禁用"是这条路径上最坏的结果，宁可不写。
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

  /** 出口：自检 + 组装返回值。 */
  const finish = (nextText, changed) => {
    if (!changed) return { ok: true, changed: false, text: original, errors: [], notes, backend: target };
    const verify = parseRows(nextText);
    if (verify.errors.length) {
      return refuse(['自检失败：生成的新文本不是预期的形态 ⇒ 拒绝写入。', ...verify.errors]);
    }
    const row = findHindsightRow(verify.rows);
    const disabled = !!(row && row.disabled === true);
    if (disabled !== (target === 'off')) {
      return refuse([`自检失败：生成的新文本里 Hindsight 是${disabled ? '**禁用**' : '**启用**'}的，与请求的后端 \`${target}\` 不符 ⇒ 拒绝写入。`]);
    }
    if (midas && !findMidasInsertRow(nextText)) {
      // 这条路径上最险的一步：`- insert:` 少了或写坏了 ⇒ dsh 只会 warn + skip，界面上一切正常、
      // 记忆却仍走 Hindsight（"假接通"）。所以出口必须回读确认那一行**在**且被 insert 包着。
      return refuse(['自检失败：生成的新文本里没有 `- insert:` 包裹的 mcp-midas 行（裸的 `- id:` 行是"覆盖一个不存在的条目"⇒ dsh 会静默跳过）⇒ 拒绝写入。']);
    }
    return { ok: true, changed: true, text: nextText, errors: [], notes, backend: target };
  };

  if (target === 'off') {
    if (!hit) {
      // 追加位置选在**最后一行内容之后**（而不是简单 push）：这样文件末尾原有的空行/注释位置
      // 不会被我们"搬家"，新行也不会粘在旧内容后面。目标是"最小 diff"。
      const out = lines.slice();
      let insertAt = out.length;
      while (insertAt > 0 && out[insertAt - 1] === '') insertAt -= 1;
      out.splice(insertAt, 0, `- id: ${HINDSIGHT_PLUGIN_ROW_ID}`, '  disabled: true');
      notes.push(`补丁文件里没有 \`${HINDSIGHT_PLUGIN_ROW_ID}\` 行 ⇒ 追加 \`- id: ${HINDSIGHT_PLUGIN_ROW_ID}\` + \`disabled: true\`（原有内容逐字保留）。`);
      return finish(out.join('\n'), true);
    }
    if (hit.disabled === true) {
      notes.push('补丁文件里已经有 `- id: hindsight` + `disabled: true` ⇒ 没有改动，未写盘（不假报成功）。');
      return finish(original, false);
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
    return finish(out.join('\n'), true);
  }

  // `hindsight` / `midas`：都要求那一行**不是** disabled:true。
  // 为什么 midas 也这样：二进制没找到时我们**不写** MCP 行（写一条指向不存在命令的行 = 假接通），
  // 那时若顺手把 Hindsight 关掉，用户就**同时失去两个后端** —— 那是最坏的结果。
  let baseText = original;
  let baseChanged = false;
  if (!hit || hit.disabled !== true) {
    notes.push(target === 'midas'
      ? 'Hindsight 行本来就**没有**被禁用 ⇒ 这一行不需要改动（记忆当前仍走 Hindsight）。'
      : '补丁文件里没有把 `hindsight` 行禁用 ⇒ 不需要改动（默认就是启用）。');
  } else {
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
    baseText = out.join('\n');
    baseChanged = true;
  }

  if (!midas) return finish(baseText, baseChanged);

  // ── midas：在"清掉 Hindsight 禁用"之后，再插入/替换 `- insert:` 包裹的 mcp-midas 行 ──────────
  const rowBlock = midasPatchRowLines({ binPath, installDir, dbPath, serverName: midas.serverName || MIDAS_SERVER_NAME });
  // 比对与替换都以**内层块**为单位（`- insert:` 那一行是外面那个顶层项的表头，不属于这一行）。
  const innerBlock = rowBlock.slice(1);
  const existingRow = findMidasInsertRow(baseText);
  const baseLines = baseText.split('\n');
  if (existingRow) {
    // 幂等：已经是我们**逐字**的规范块（**按它自己的缩进**比对）⇒ 不动盘。
    // ⚠️ 必须先 reindent 再比：只跟基准缩进（4 格）比的话，一个缩进 2 格的合法块会被判"不一样"，
    //    于是每次保存都"改"成同样的文本 ⇒ 每次都写盘（幂等纪律，2026-09-19 实测踩到）。
    const reindented = reindent(innerBlock, existingRow.indent);
    if (existingRow.lines.join('\n') === reindented.join('\n')) {
      notes.push('补丁文件里已经有**逐字相同**的 `- insert:` + `mcp-midas` 行 ⇒ 没有改动，未写盘（幂等）。');
      return finish(baseChanged ? baseText : original, baseChanged);
    }
    // 行 id 是本模块的 ⇒ 可以整块替换；但**沿用它原来的缩进**（它是某个 insert 块的兄弟项，
    // 缩进是那个块的约定，我们无权改动兄弟行）。为什么整块替换而不是逐个 key 改：这一行完全由本模块生成。
    const out = baseLines.slice();
    out.splice(existingRow.start, existingRow.lines.length, ...reindented);
    notes.push('把已有的 `mcp-midas` 行替换成当前二进制/DB 路径（这一行的 id 是本模块的 ⇒ 整块替换；块内缩进沿用原样）。');
    return finish(out.join('\n'), true);
  }
  // 追加位置与 `off` 分支同一口径：**最后一行内容之后**（末尾原有空行/注释不搬家，最小 diff）。
  const out = baseLines.slice();
  let insertAt = out.length;
  while (insertAt > 0 && out[insertAt - 1] === '') insertAt -= 1;
  out.splice(insertAt, 0, ...rowBlock);
  notes.push(`补丁文件里没有 \`${MIDAS_PATCH_ROW_ID}\` 行 ⇒ 追加 \`- insert:\` 包裹的 \`mcp-midas\`（command=node + 绝对路径 args + ${MIDAS_DB_ENV} + ${MIDAS_NO_WARNINGS_ENV}，其余内容逐字保留）。`);
  if (hasTopLevelMidasRow(baseText)) {
    // 顶层写法是"覆盖一个不存在的条目" ⇒ dsh 会 warn + skip。留着它无害但会刷一行警告，如实说明。
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
  }

  const effective = hindsightDisabled ? 'off' : 'hindsight';
  const consistent = stored === 'off' ? hindsightDisabled === true : hindsightDisabled === false;
  /** 补丁里有没有**内层**（`- insert:` 之下）的 `mcp-midas` 行 —— 顶层写法不算（那条会被 dsh 静默跳过）。 */
  const patchRowPresent = findMidasInsertRow(patchText) !== null;

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

  // ── 结论只描述**观察到的现象**，不描述猜测（本仓 2026-09-16 的老教训）────────────────
  let kind = 'on';
  let level = 'ok';
  let zh = '';
  let en = '';
  if (stored === 'off' && hindsightDisabled) {
    kind = 'off'; level = 'ok';
    zh = '已关闭：profile 补丁里 `hindsight` 行是 `disabled: true` ⇒ 重启 dsh web 后不会有任何记忆调用。';
    en = 'Off: the profile patch disables the `hindsight` row, so after a dsh web restart no memory calls happen.';
  } else if (stored === 'off' && !hindsightDisabled) {
    kind = 'off-not-applied'; level = 'warn';
    zh = '设置是「不使用」，但补丁文件**还没有**禁用 `hindsight` 行（改动没落地，或被别的工具改回去了）⇒ 现在重启也关不掉记忆。用上面的选择器再保存一次即可对齐。';
    en = 'You chose "off" but the patch file does NOT yet disable the `hindsight` row — restarting now would not turn memory off.';
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
  if (!plan.ok) return { ...base, errors: plan.errors, notes: plan.notes };

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
  const midasRowInPlace = !!(midasPlan && findMidasInsertRow(plan.text || ''));
  const notWired = target === 'midas' && !midasRowInPlace;

  return {
    ok: true, status: 200, path: patchPath, backend: target,
    patchExisted, changed: plan.changed, saved, needsRestart,
    restartReason: needsRestart
      ? 'profile 补丁（cordis.patch.yml）在**加载 profile 时**读取 ⇒ 改动要重启 `dsh web` 才生效。'
      : '本次没有改动 profile 补丁 ⇒ 无需重启。',
    notWired,
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
