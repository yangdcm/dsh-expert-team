/**
 * Hindsight 记忆后端配置的**写路径**（1.3.21 二期）。
 *
 * ── 为什么单独一个模块（而不是塞进 `hindsight-config.js`）────────────────────────
 * 一期那个模块的**卖点就是"它不会写任何东西"** —— 它的注释、它的测试（源码级断言"模块内没有
 * 任何写入 API"）都在说这句话。把写入塞进去，那句保证就作废了，而"诊断时可以放心调用"正是它
 * 存在的理由。所以：**读的归读，写的归写**，一条 import 边从写指向读（读模块仍是叶子，不成环）。
 *
 * ── 这条写路径要守的四条规矩（都有测试盯着）──────────────────────────────────
 *   ① **只改用户明确提交的键**：读-改-写合并，**保留文件里所有未知/未来键**（Hindsight 升级后
 *      多出来的键、别人手写的注释性字段，都不许因为"我不认识"就被写没）；
 *   ② **原子写**：委派给 `lib/host-state-file.js`（同目录临时文件 → `fsync` → `rename`；文件 0600、
 *      目录 0700；校验不过**一个字节都不落盘**）—— 本模块自己**不直写**（那正是写绕过棘轮要数的东西）；
 *   ③ **token 永不回显**：响应体/错误信息里出现 token 明文一律算缺陷 —— 回执里的安全字段**只从
 *      `parseConfigText()` 来**（它按构造只产出 `serverMode` / `apiUrl` / `apiTokenConfigured` 三个键）；
 *   ④ **空输入 ≠ 删除**：空串/纯空白 = **保持原值不变**；清除必须是**显式**动作（`clear: ["apiToken"]`）。
 *
 * ── 两条如实说明的语义（不是悄悄做的事）──────────────────────────────────────
 *   · `daemon` 形态下 `apiUrl` 被 Hindsight **强制**为 `http://127.0.0.1:9077`：
 *     若同一个请求里把 `apiUrl` 写成别的值，**拒绝写入并说明原因与两条出路**（不悄悄改写、也不
 *     悄悄接受一个永远不会生效的值）；若是文件里**本来就有**一个别的值（比如从 self-hosted 切过来），
 *     我们不擅自删它，而是在 notes 里写明"它不会生效、要去掉请用 clear"。
 *   · 尾部斜杠会被去掉（并写明）；`apiUrl` 带 `/v1` 会被**拒绝**并说明"Hindsight 自己会拼 `/v1`"。
 *
 * 事实来源：Hindsight 0.6.1 的配置真源是 `process.env.HINDSIGHT_CONFIG || ~/.hindsight/coding-agent.json`；
 * 顶层键恰为 `serverMode`（`cloud`|`self-hosted`|`daemon`）· `apiUrl`（**不带 `/v1`**）· `apiToken`；
 * `apiToken` 在 401 时会被重读（**免重启**），`serverMode`/`apiUrl` 需要**重启 `dsh web`**。
 */

import { readFile } from 'node:fs/promises';
import {
  HINDSIGHT_DAEMON_URL, HINDSIGHT_SERVER_MODES, effectiveApiUrl, hindsightPaths, parseConfigText,
} from './hindsight-config.js';
import { HOST_STATE_DIR_MODE, HOST_STATE_FILE_MODE, writeHostStateFileAtomic } from './host-state-file.js';

/** 本写路径认识并可写的键（其余键一律原样保留）。 */
export const HINDSIGHT_WRITABLE_KEYS = Object.freeze(['serverMode', 'apiUrl', 'apiToken']);
/** 允许**显式清除**的键（清除只有这一条路：提交空串不算删除）。 */
export const HINDSIGHT_CLEARABLE_KEYS = Object.freeze(['apiToken', 'apiUrl']);
/** 改了这些键**需要重启 `dsh web`**；只改 `apiToken` 不需要（401 时重读）。 */
export const HINDSIGHT_RESTART_KEYS = Object.freeze(['serverMode', 'apiUrl']);
/** 配置文件权限（含 token ⇒ 只给属主读）。**单一真源**在 `lib/host-state-file.js`（见下）。 */
export const HINDSIGHT_CONFIG_FILE_MODE = HOST_STATE_FILE_MODE;
/** 配置目录权限（不存在时才创建）。 */
export const HINDSIGHT_CONFIG_DIR_MODE = HOST_STATE_DIR_MODE;

/** 把任意异常压成一行短摘要（不抛）。 */
const errText = (e) => String((e && e.message) || e || '未知原因');

/**
 * 解析并校验 `apiUrl`。
 *
 * 三条判据：必须能解析、必须是 `http(s)`、**不能带 `/v1`**（Hindsight 自己会拼 `/v1/...`）。
 * 尾部斜杠会被去掉（调用方负责如实说明这件事）。
 * @param {string} s
 * @returns {{ok: true, value: string, stripped: boolean}|{ok: false, error: string}}
 */
export function parseHindsightApiUrl(s) {
  const raw = String(s == null ? '' : s).trim();
  let u = null;
  // ⚠️ 错误信息**不回显提交的原值**：用户完全可能把 token 粘错到这一栏，而"哪个字段装的是机密"
  // 是个靠不住的判据 —— 回执只能**按结构**保证不含机密（见文件头"token 永不回显"）。
  try { u = new URL(raw); } catch { return { ok: false, error: 'apiUrl 不是合法 URL（提交的原值不在回执里回显）：请填到根，例如 https://example.com。' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // 协议名由 URL 解析器给出（`ftp:` 这类），不来自用户原文 ⇒ 回显它安全，且是最有用的线索。
    return { ok: false, error: `apiUrl 只支持 http/https，收到协议「${u.protocol}」。` };
  }
  if (/\/v1(\/|$)/.test(u.pathname)) {
    return {
      ok: false,
      error: 'apiUrl 不要带 /v1：Hindsight 会自己在地址后面拼 /v1/...；请只填到根（例如 https://example.com）。',
    };
  }
  const stripped = /\/+$/.test(raw);
  return { ok: true, value: stripped ? raw.replace(/\/+$/, '') : raw, stripped };
}

/**
 * **纯函数**：算出"这次提交要不要写、写成什么"（不碰文件系统 —— 文件读写在 `saveHindsightConfig`）。
 *
 * @param {string|null} existingText - 现有配置文本（`null`/空 ⇒ 视为"文件还不存在"= `{}`）。
 * @param {object} [body] - 提交体：`{ serverMode?, apiUrl?, apiToken?, clear?: string[] }`。
 * @returns {{
 *   ok: boolean, saved: boolean, errors: string[], notes: string[],
 *   changed: string[], removed: string[], needsRestart: boolean, forcedApiUrl: boolean,
 *   text: string|null, safe: {serverMode: string|null, apiUrl: string|null, apiTokenConfigured: boolean}|null,
 * }}
 *   `text` 是**要落盘的内容**（含 token，绝不外传）；`safe` 是**可安全回显的三键**（按构造不含 token 值）。
 */
export function planHindsightConfigWrite(existingText, body = {}) {
  const errors = [];
  const notes = [];
  const refuse = (message) => ({
    ok: false, saved: false, errors: [message], notes, changed: [], removed: [],
    needsRestart: false, forcedApiUrl: false, text: null, safe: null,
  });

  // ── 现有文件：缺失 ⇒ `{}`；**存在但不是合法 JSON 对象 ⇒ 拒绝覆盖** ─────────────
  // 为什么宁可不写：此刻我们对文件里的东西一无所知，任何"合并"都等于"把你原有的内容写没"。
  const rawExisting = existingText == null ? '' : String(existingText);
  let existing = {};
  if (rawExisting.trim() !== '') {
    let parsed = null;
    try { parsed = JSON.parse(rawExisting); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return refuse('现有配置文件存在，但不是合法 JSON 对象 ⇒ 拒绝写入（盲目合并会把你原有的内容整段写没）。请先手工修正该文件。');
    }
    existing = parsed;
  }

  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  // ── 收集要写的键：**空串/纯空白 ⇒ 保持原值不变**（清除只能走 clear）─────────────
  const set = {};
  for (const key of HINDSIGHT_WRITABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const v = src[key];
    if (v == null) { notes.push(`${key} 提交为 null ⇒ **保持原值不变**（不写盘、不删除）。`); continue; }
    if (typeof v !== 'string') { errors.push(`${key} 必须是字符串。`); continue; }
    const s = v.trim();
    if (s === '') {
      notes.push(`${key} 提交为空 ⇒ **保持原值不变**（空串不等于删除：要清除请用 \`clear\` 显式动作）。`);
      continue;
    }
    set[key] = s;
  }

  // ── 逐键校验（校验不过 ⇒ 一个字节都不落盘）──────────────────────────────────
  if ('serverMode' in set && !HINDSIGHT_SERVER_MODES.includes(set.serverMode)) {
    // 同样不回显原值（可能被误粘成 token）：允许列表本身就是最可操作的线索。
    errors.push(`serverMode 只能是 ${HINDSIGHT_SERVER_MODES.join(' / ')}（提交的原值不在回执里回显）。`);
  }
  if ('apiUrl' in set) {
    const parsed = parseHindsightApiUrl(set.apiUrl);
    if (!parsed.ok) errors.push(parsed.error);
    else {
      if (parsed.stripped) notes.push(`apiUrl 已去掉尾部斜杠 ⇒ \`${parsed.value}\`。`);
      set.apiUrl = parsed.value;
    }
  }

  // ── `clear`：**显式**清除动作 ───────────────────────────────────────────────
  const removed = [];
  if (Object.prototype.hasOwnProperty.call(src, 'clear') && src.clear != null) {
    if (!Array.isArray(src.clear)) {
      errors.push('clear 必须是数组，例如 clear: ["apiToken"]。');
    } else {
      for (const k of src.clear) {
        const key = String(k);
        if (!HINDSIGHT_CLEARABLE_KEYS.includes(key)) {
          errors.push(`clear 只支持 ${HINDSIGHT_CLEARABLE_KEYS.join(' / ')}（提交的原值不在回执里回显）。`);
          continue;
        }
        if (key in set) { errors.push(`同一个键不能既提交新值又清除：「${key}」。`); continue; }
        removed.push(key);
      }
    }
  }

  // ── 合并（**保留一切未知键**）────────────────────────────────────────────────
  const next = { ...existing };
  for (const key of HINDSIGHT_WRITABLE_KEYS) if (key in set) next[key] = set[key];
  for (const key of removed) delete next[key];

  // ── daemon 形态的"强制地址"：不悄悄改写，也不悄悄接受一个不会生效的值 ──────────
  let forcedApiUrl = false;
  if (next.serverMode === 'daemon') {
    if ('apiUrl' in set && set.apiUrl !== HINDSIGHT_DAEMON_URL) {
      errors.push(`serverMode=daemon 时 Hindsight **强制** apiUrl = ${HINDSIGHT_DAEMON_URL}（不是我们改写，而是它本来就忽略别的值）⇒ 拒绝写入「${set.apiUrl}」。两条出路：① 同一请求里写 \`clear: ["apiUrl"]\`；② 确实要用这个地址就把 serverMode 改成 self-hosted。`);
    } else if (typeof next.apiUrl === 'string' && next.apiUrl !== '' && next.apiUrl !== HINDSIGHT_DAEMON_URL) {
      forcedApiUrl = true;
      notes.push(`daemon 形态下 apiUrl 被 Hindsight **强制**为 ${HINDSIGHT_DAEMON_URL} —— 文件里现存的「${next.apiUrl}」不会生效（要去掉它，用 \`clear: ["apiUrl"]\` 显式清除）。`);
    }
  }

  // ── 差异（连带删除的键一起算）──────────────────────────────────────────────
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(next[k])) changed.push(k);
  }
  changed.sort();

  if (errors.length) {
    return { ok: false, saved: false, errors, notes, changed: [], removed: [], needsRestart: false, forcedApiUrl, text: null, safe: null };
  }

  if (changed.length === 0) {
    notes.push('提交的内容与现有配置完全一致 ⇒ 没有改动，未写盘（不假报成功）。');
    return { ok: true, saved: false, errors: [], notes, changed: [], removed: [], needsRestart: false, forcedApiUrl, text: null, safe: parseConfigText(JSON.stringify(next)) };
  }

  const restartKeys = changed.filter((k) => HINDSIGHT_RESTART_KEYS.includes(k));
  const needsRestart = restartKeys.length > 0;
  notes.push(needsRestart
    ? `改动了 ${restartKeys.join(' / ')} ⇒ 需要重启 dsh web 才生效（Hindsight 在启动时读这两个键）。`
    : '只改动了 apiToken ⇒ 无需重启（Hindsight 收到 401 时会重新读配置）。');

  const text = JSON.stringify(next, null, 2) + '\n';
  return {
    ok: true, saved: true, errors: [], notes, changed, removed, needsRestart, forcedApiUrl,
    text,
    // ⚠️ 安全红线：对外的一切字段都只从 parseConfigText() 来（它按构造只产出三个键，token 只折算成布尔）。
    safe: parseConfigText(text),
  };
}

/**
 * **原子写**：委派给 `lib/host-state-file.js`（宿主状态文件的**单一受控入口**）。
 *
 * 为什么不再在这里自己写一遍：`writeFile` + `rename` 这类"临时文件 + 换名"的写法一旦散落多处，
 * 就正是写绕过棘轮（`scripts/check-write-bypass.mjs`）要防的东西 —— 本模块因此把自己的直写**归零**，
 * 只留一条委派边。原子性 / 权限 / 失败清理的语义与证据见那个模块的文件头。
 *
 * @param {string} path - 目标配置文件路径。
 * @param {string} text - 完整内容。
 * @returns {Promise<{ok: true, mode: number, tmpCleaned: boolean, dirCreated: boolean}>}
 */
export async function writeHindsightConfigAtomic(path, text) {
  const r = await writeHostStateFileAtomic(path, text, {
    mode: HINDSIGHT_CONFIG_FILE_MODE,
    dirMode: HINDSIGHT_CONFIG_DIR_MODE,
  });
  return { ok: true, mode: r.mode, tmpCleaned: true, dirCreated: r.dirCreated };
}

/**
 * 落地一次配置写入：读现有文件 → 校验并合并（纯函数）→ 原子写。
 *
 * **失败语义**：校验不过 ⇒ `{ok:false, status:400}`（**未写盘**）；IO 失败 ⇒ `{ok:false, status:500}`
 * （原文件未动 —— 临时文件 + rename 保证这一点）；没有改动 ⇒ `{ok:true, saved:false}`。
 * @param {object} [input]
 * @param {object} [input.body] - 提交体（`{serverMode?, apiUrl?, apiToken?, clear?}`）。
 * @param {object} [input.env] - 环境变量（默认 `process.env`，认 `HINDSIGHT_CONFIG`）。
 * @param {string} [input.home] - 家目录（测试注入用）。
 * @param {object} [input.io] - IO 注入（默认 node fs 只读那一半；测试用临时目录时无需注入）。
 * @returns {Promise<object>} 回执（**绝不含 token 值**）。
 */
export async function saveHindsightConfig({ body, env = process.env, home, io } = {}) {
  const { configPath } = hindsightPaths({ env, home });
  const readText = (io && io.readText) || ((p) => readFile(p, 'utf8'));

  let existingText = null;
  try {
    existingText = await readText(configPath);
  } catch (e) {
    const code = String((e && e.code) || '');
    if (code !== 'ENOENT') {
      return { ok: false, status: 500, path: configPath, notes: [], errors: [`读取现有配置失败（未写盘）：${errText(e)}`] };
    }
  }

  const plan = planHindsightConfigWrite(existingText, body);
  if (!plan.ok) return { ok: false, status: 400, path: configPath, notes: plan.notes, errors: plan.errors };

  const base = {
    ok: true,
    path: configPath,
    changed: plan.changed,
    removed: plan.removed,
    needsRestart: plan.needsRestart,
    forcedApiUrl: plan.forcedApiUrl,
    notes: plan.notes,
    // 安全字段只从这里来：parseConfigText() 的产物按构造只有三个键，token 只折算成布尔。
    serverMode: plan.safe ? plan.safe.serverMode : null,
    apiUrl: plan.safe ? plan.safe.apiUrl : null,
    apiTokenConfigured: plan.safe ? plan.safe.apiTokenConfigured : false,
    apiUrlEffective: effectiveApiUrl(plan.safe || {}),
  };

  if (!plan.saved) return { ...base, saved: false };

  try {
    await writeHindsightConfigAtomic(configPath, plan.text);
  } catch (e) {
    return { ok: false, status: 500, path: configPath, notes: plan.notes, errors: [`写入失败（原文件未动）：${errText(e)}`] };
  }
  return { ...base, saved: true };
}
