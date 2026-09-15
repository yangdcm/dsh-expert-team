/**
 * Hindsight 记忆后端的**只读诊断**（1.3.18 一期；二期才做"三形态写入"）。
 *
 * ── 为什么需要它（一次真实故障的定性）────────────────────────────────────────
 * 用户的记忆一直没生效，报错却有两种完全不同的形态：
 *   · `POST …/v1/default/banks/…/knowledge-base/pages -> 500 {"detail":"could not resize shared
 *     memory segment … to 533794976 bytes: No space left on device"}` ⇒ **服务端 PostgreSQL 分配
 *     共享内存失败**（自托管最常见成因：容器 `/dev/shm` 只有 64 MB）；
 *   · `POST …/v1/default/banks/…/memories -> 403 <!doctype html><html>…网站防火墙…` ⇒ **服务端 WAF
 *     返回了 HTML 防火墙页**（不是 API 的 JSON 错误，**也不是 token 问题**）。
 * 两者都在服务端，但客户端只把一长串 JSON/HTML 原样抛给用户 ⇒ 用户无法判断该改哪里。
 *
 * ⇒ 本模块把"**看**"这件事做扎实：读配置、读诊断日志、按启发式**分类**并给**可操作 hint**、
 *   可选地探一次连通性。**它不写任何文件、不改 Hindsight 的任何行为**。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────
 *   · **一期只读**：不写配置、不写日志、不 POST（有源码级断言盯着）；
 *   · **token 值绝不回显**：只输出"是否已配置"这一布尔（连长度/前后缀都不给）——安全红线；
 *   · 读配置/日志/探测**任何失败都 fail-open**（`null` + `notes`），**绝不让路由 500**；
 *   · 分类是**启发式提示、不是断言**（hint 的措辞如实说明这一点）；
 *   · `inject_empty`（召回为空）**不是失败** —— 本仓纪律：两种零必须分得开（1.3.10 的老教训）。
 *
 * 事实来源（只读核实过）：Hindsight 0.6.1 的配置真源是
 * `process.env.HINDSIGHT_CONFIG || ~/.hindsight/coding-agent.json`（其 `dist/dsh.js:1301`），
 * 顶层键恰好三个：`serverMode`（`cloud`|`self-hosted`|`daemon`）· `apiUrl` · `apiToken`；
 * `cloud` 默认官方域名、`daemon` 强制 `http://127.0.0.1:9077`；`apiUrl` **不带 `/v1`**。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** 覆盖配置文件位置的**宿主环境变量**（Hindsight 自己也认它 —— 单一真源，不另立一套）。 */
export const HINDSIGHT_CONFIG_ENV = 'HINDSIGHT_CONFIG';
/** 合法 serverMode 值域。 */
export const HINDSIGHT_SERVER_MODES = Object.freeze(['cloud', 'self-hosted', 'daemon']);
/** `cloud` 形态的默认地址。 */
export const HINDSIGHT_CLOUD_URL = 'https://api.hindsight.vectorize.io';
/** `daemon`（本地部署）形态**被强制**的地址。 */
export const HINDSIGHT_DAEMON_URL = 'http://127.0.0.1:9077';
/** bank 命名前缀（Hindsight 约定：`<前缀>::<workspace>`）。 */
export const HINDSIGHT_BANK_PREFIX = 'coding-agent';
/** 连通性探测的超时（毫秒）；探测绝不阻塞面板。 */
export const PROBE_TIMEOUT_MS = 2000;
/** 诊断日志只处理**最后这么多行**（坏行/半行一律跳过）。 */
export const DIAG_TAIL_LINES = 200;
/** 失败摘要上限（字）。 */
export const FAILURE_SUMMARY_MAX = 200;

/**
 * 解析两个路径：配置文件与诊断日志。
 * @param {object} [input]
 * @param {object} [input.env] - 环境变量（默认 `process.env`）。
 * @param {string} [input.home] - 家目录（默认 `os.homedir()`；测试注入用）。
 * @returns {{configPath: string, diagPath: string}}
 */
export function hindsightPaths({ env = process.env, home } = {}) {
  const base = (home && String(home)) || homedir();
  const override = String((env && env[HINDSIGHT_CONFIG_ENV]) || '').trim();
  return {
    configPath: override || join(base, '.hindsight', 'coding-agent.json'),
    diagPath: join(base, '.hindsight', 'coding-agents-logs', 'diag.jsonl'),
  };
}

/**
 * 该形态**实际**会用的地址（与 Hindsight 的语义一致：`daemon` 强制本地、`cloud` 有默认域名）。
 * @param {object} cfg - `{ serverMode, apiUrl }`。
 * @returns {string|null}
 */
export function effectiveApiUrl(cfg = {}) {
  const mode = cfg && typeof cfg.serverMode === 'string' ? cfg.serverMode : '';
  const url = cfg && typeof cfg.apiUrl === 'string' ? cfg.apiUrl.trim() : '';
  if (mode === 'daemon') return HINDSIGHT_DAEMON_URL;      // 被强制，忽略 apiUrl
  if (url) return url.replace(/\/+$/, '');                 // 去掉尾部斜杠（我们只读，不改配置）
  if (mode === 'cloud') return HINDSIGHT_CLOUD_URL;
  return null;
}

/**
 * 当前工作区对应的 bank 名（Hindsight 约定 `coding-agent::<workspace>`）。
 * 推不出工作区名 ⇒ `null`（不硬编一个假的）。
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function bankForWorkspace(cwd) {
  const s = String(cwd || '').trim();
  if (!s) return null;
  const name = basename(s.replace(/[/\\]+$/, ''));
  if (!name) return null;
  return `${HINDSIGHT_BANK_PREFIX}::${name}`;
}

/**
 * 把服务端错误压成**一行可读摘要**：剥 HTML、压平空白、截断。
 *
 * 为什么必须剥 HTML：真实日志里 `error` 字段含多行 `<!doctype html><html>…网站防火墙…`，
 * 原样塞进 UI 会把面板撑爆（而且那是**防火墙页**，不是 API 错误体）。
 * @param {string} raw
 * @param {number} [max]
 * @returns {string}
 */
export function summarizeError(raw, max = FAILURE_SUMMARY_MAX) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  s = s.replace(/\s+/g, ' ').trim();
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : FAILURE_SUMMARY_MAX;
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

/**
 * 把服务端错误**启发式分类**并给可操作 hint。
 *
 * 顺序**有意如此**（每一对都可能同时命中，先判更具体的）：
 *   ① `403` + HTML ⇒ 应用层返回了 HTML 错误页；② 共享内存/磁盘；③ 其它 5xx；
 *   ④ 401/403（无 HTML）⇒ 鉴权；⑤ 连接类 ⇒ 不可达；⑥ 其余 unknown。
 *
 * ⚠️ 2026-09-16 纠错（这条分类名与话术**超出过证据**，真机把用户和派工方都误导了）：
 *   · 旧分类名 `waf-blocked` 把**猜测固化成了事实** —— `403 + HTML` **推不出**"WAF 拦的"。
 *     能返回 HTML 403 的环节可能是反向代理 / 面板安全插件 / CDN / 临时拦截，本页无法判定。
 *     现在名字只描述**观察到的现象**（`http-403-html`），不描述**结论**。
 *   · 旧 hint 还给了"检查 WAF 是否拦了 /v1/ 的 POST，或把 IP/UA 加白名单"这种**听起来权威、
 *     前提却没被验证**的整改指令。删掉 —— 对未确定的根因给动作，比不给动作更坏。
 * @param {string} text
 * @returns {{classification: string, hint: string}}
 */
export function classifyFailure(text) {
  const s = String(text == null ? '' : text);
  const hasHtml = /<!doctype html|<html|<head>|网站防火墙/i.test(s);
  if (/\b403\b/.test(s) && hasHtml) {
    return {
      classification: 'http-403-html',
      hint: '应用层返回了 403 的 HTML 页面（该页自称「网站防火墙」）。这是「观察到的现象」，不是根因：'
        + '能返回 HTML 403 的环节可能是反向代理 / 面板安全插件 / CDN / 临时拦截等等，本页无法判定是哪一种。'
        + '请先看这条失败「之后是否已有成功」（上面的已恢复 / 历史标记）——若已恢复，它只是历史记录；'
        + '若仍在持续发生，再去服务端逐层确认。本页不给未经证实的整改动作。',
    };
  }
  if (/could not resize shared memory|no space left on device|out of shared memory/i.test(s)) {
    return {
      classification: 'server-shm-or-disk',
      hint: '服务端 PostgreSQL 分配共享内存失败 —— 自托管最常见成因是容器 /dev/shm 只有 64 MB：用 --shm-size=1g（compose 里 shm_size: 1g）重启容器；也可能是磁盘/inode 满（df -h）或并行度太高（max_parallel_workers_per_gather）。',
    };
  }
  if (/\b5\d\d\b/.test(s)) {
    return { classification: 'server-5xx', hint: '服务端 5xx —— 稍后重试；持续失败请查服务端日志（本条是启发式提示，具体原因以服务端日志为准）。' };
  }
  if (/\b40[13]\b/.test(s)) {
    return { classification: 'auth', hint: '鉴权失败（401/403）——检查配置里的 apiToken 是否正确/过期（token 值不会被本页显示）。' };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up|network/i.test(s)) {
    return { classification: 'unreachable', hint: '连不上 apiUrl —— 本地/自托管部署是否已启动？地址、端口与网络是否可达？' };
  }
  return { classification: 'unknown', hint: '未能归类 —— 请按下面的摘要原文自行判断（本分类只做启发式匹配，不是断言）。' };
}

/**
 * 扫 `diag.jsonl` 文本：取**最后一条失败**，并统计**它之后发生过多少次成功**。
 *
 * 规则（照实说清，避免"两种零混成一个"）：
 *   · 失败 = 带**非空 `error` 字符串**的记录；`event === 'inject_empty'`（召回为空）**不算失败** ——
 *     "召回为空"与"调用失败"是两件不同的事；
 *   · 成功 = **非失败**记录（含 `inject_empty`：召回为空但**调用本身是通的**）。
 *     ⚠️ 它证明的是"服务在响应"，**不**证明"写入一定成功" —— 所以只用来判断"那条失败是否仍然当前"；
 *   · 坏行/半行/非 JSON 行一律跳过（日志是被追加写的，最后一行可能是半行），但**单独计数**：
 *     "一行都解析不出来"与"没有失败"必须分得开 —— 否则"读不懂"会被说成"没问题"；
 *   · 只看**最后 `DIAG_TAIL_LINES` 行**。
 *
 * ⚠️ 2026-09-16 纠错（真机事故）：旧实现取"尾部最后一条带 error 的记录"就完事，
 * **从不与它之后的成功作比较** ⇒ 把两小时前的那条历史失败以**现在时**呈现，还挂红色告警框
 * 与整改指令。**历史失败 ≠ 当前故障**：现在必须给出 `sinceFailure` 作为判定依据。
 *
 * @param {string} diagText
 * @returns {{lastFailure: object|null, parsedRecords: number, failureCount: number, unparsable: number, sinceFailure: object}}
 */
export function scanDiag(diagText) {
  const lines = String(diagText == null ? '' : diagText).split(/\r?\n/);
  const from = Math.max(0, lines.length - DIAG_TAIL_LINES);
  const parse = (i) => {
    const raw = lines[i].trim();
    if (!raw || raw.charAt(0) !== '{') return null;      // 空行/半行
    try {
      const rec = JSON.parse(raw);
      return (rec && typeof rec === 'object' && !Array.isArray(rec)) ? rec : null;
    } catch { return null; }
  };
  const isFailRec = (rec) => typeof rec.error === 'string' && rec.error.trim() !== '' && String(rec.event == null ? '' : rec.event) !== 'inject_empty';
  let last = null;
  let parsedRecords = 0;
  let failureCount = 0;
  let unparsable = 0;
  for (let i = from; i < lines.length; i += 1) {
    const rec = parse(i);
    if (!rec) { if (lines[i].trim() !== '') unparsable += 1; continue; }
    parsedRecords += 1;
    if (isFailRec(rec)) {
      last = { index: i, ts: rec.ts == null ? null : String(rec.ts), event: rec.event == null ? null : String(rec.event), raw: rec.error };
      failureCount += 1;
    }
  }
  // ⚠️ 真正的"成功"与"召回为空"必须分开计数：`retain_ok` 证明**写入路径**恢复了；
  // `inject_empty` 只证明**读路径**有人在响应 —— 拿它当"已恢复"就是把话说满。
  const since = { successes: 0, lastSuccessAt: null, lastSuccessMs: null, lastSuccessEvent: null, emptyRecalls: 0 };
  if (last) {
    for (let i = last.index + 1; i < lines.length; i += 1) {
      const rec = parse(i);
      if (!rec || isFailRec(rec)) continue;
      const ev = rec.event == null ? '' : String(rec.event);
      if (ev === 'inject_empty') { since.emptyRecalls += 1; continue; }
      since.successes += 1;
      since.lastSuccessAt = rec.ts == null ? null : String(rec.ts);
      since.lastSuccessMs = Number.isFinite(Number(rec.ms)) ? Number(rec.ms) : null;
      since.lastSuccessEvent = rec.event == null ? null : String(rec.event);
    }
  }
  let lastFailure = null;
  if (last) {
    const { classification, hint } = classifyFailure(last.raw);
    lastFailure = { at: last.ts, event: last.event, summary: summarizeError(last.raw), classification, hint, sinceFailure: since };
  }
  return { lastFailure, parsedRecords, failureCount, unparsable, sinceFailure: since };
}

/**
 * 兼容入口：只要"最后一条失败"（现在**带上** `sinceFailure`，供调用方判断它是不是历史）。
 * @param {string} diagText
 * @returns {{at: string|null, event: string|null, summary: string, classification: string, hint: string, sinceFailure: object}|null}
 */
export function pickLastFailure(diagText) {
  return scanDiag(diagText).lastFailure;
}

/**
 * 解析配置文件文本 ⇒ **只输出可安全公开的字段**（token 只折算成布尔）。
 * @param {string} text
 * @returns {{serverMode: string|null, apiUrl: string|null, apiTokenConfigured: boolean}|null} 非法 JSON ⇒ null
 */
export function parseConfigText(text) {
  let obj = null;
  try { obj = JSON.parse(String(text == null ? '' : text)); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const modeRaw = typeof obj.serverMode === 'string' ? obj.serverMode.trim() : '';
  const url = typeof obj.apiUrl === 'string' ? obj.apiUrl.trim() : '';
  return {
    serverMode: HINDSIGHT_SERVER_MODES.includes(modeRaw) ? modeRaw : (modeRaw || null),
    apiUrl: url || null,
    // ⚠️ 安全红线：这里**只能**产出布尔。绝不输出 token 的值、长度、前后缀。
    apiTokenConfigured: typeof obj.apiToken === 'string' && obj.apiToken.trim() !== '',
  };
}

/** 默认 IO（可注入；测试不碰真实文件系统）。 */
export const defaultIo = {
  readText: (p) => readFile(p, 'utf8'),
};

/**
 * 探一次连通性：`GET {apiUrl}/v1/default/banks`，超时 `timeoutMs`。
 *
 * **语义（必须如实对外说明）**：任何 HTTP 响应（含 401/403/404）都算 `reachable: true` ——
 * "连通"不等于"鉴权成功"；连接错误/超时才算 false。**不带 token**（只验连通）。
 * @returns {Promise<{reachable: boolean, probeMs: number, httpStatus?: number, error?: string}>}
 */
export async function probeApiUrl(apiUrl, { fetchImpl, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { reachable: false, probeMs: 0, error: 'no-fetch-impl' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch { /* ignore */ } }, Math.max(1, timeoutMs)) : null;
  try {
    const res = await doFetch(String(apiUrl).replace(/\/+$/, '') + '/v1/default/banks', {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: ctl ? ctl.signal : undefined,
    });
    return { reachable: true, probeMs: Date.now() - t0, httpStatus: (res && res.status) || 0 };
  } catch (e) {
    return { reachable: false, probeMs: Date.now() - t0, error: String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 组装诊断报告（路由直接回它）。
 *
 * fail-open 贯穿：读配置失败 ⇒ `exists:false` + note；读日志失败 ⇒ `lastFailure:null` + note；
 * 探测失败 ⇒ `reachable:false` + note。**任何分支都不抛**（抛了会让这条路由 500）。
 * @param {object} [input]
 * @param {object} [input.env] - 环境变量。
 * @param {string} [input.home] - 家目录（测试注入）。
 * @param {string} [input.cwd] - 当前工作区（用于推导 bank 名）。
 * @param {boolean} [input.probe] - 是否探测连通性（**默认 false ⇒ 不发任何网络请求**）。
 * @param {object} [input.io] - IO 注入（默认 node fs）。
 * @param {Function} [input.fetchImpl] - fetch 注入（测试用）。
 * @param {number} [input.timeoutMs] - 探测超时。
 * @returns {Promise<object>} 报告对象（**绝不含 token 值**）。
 */
export async function buildHindsightReport({
  env = process.env, home, cwd, probe = false, io = defaultIo, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const notes = [];
  const { configPath, diagPath } = hindsightPaths({ env, home });

  let exists = false;
  let cfg = null;
  try {
    const text = await io.readText(configPath);
    exists = true;
    cfg = parseConfigText(text);
    if (!cfg) notes.push('配置文件存在但不是合法 JSON 对象 ⇒ 无法解析（Hindsight 会按默认值或自行报错）。');
  } catch {
    notes.push('未找到 Hindsight 配置文件（可能未配置，或它正使用默认值）。');
  }

  let lastFailure = null;
  // ⚠️ 三种情况必须分得开（本仓纪律"两种零分得开"）：
  //   ① **读不到**日志（缺失/无权限）⇒ "无法判断"；
  //   ② 读到了但**一条都解析不出来**（全坏行/半写）⇒ 同样是"无法判断"，**不许**说成"没有失败"；
  //   ③ 解析到 N 条记录且其中 0 条失败 ⇒ 这才叫"没有失败"。
  try {
    const scanned = scanDiag(await io.readText(diagPath));
    lastFailure = scanned.lastFailure;
    if (!lastFailure) {
      if (scanned.parsedRecords === 0) {
        notes.push(`诊断日志存在，但尾部 ${DIAG_TAIL_LINES} 行里没有一条可解析的记录（坏行/半写）⇒ 无法判断有没有失败（这与"没有失败"是两件事）。`);
      } else {
        notes.push(`诊断日志尾部解析到 ${scanned.parsedRecords} 条记录，其中没有失败（"召回为空"这类不算失败）。`);
      }
    }
  } catch {
    notes.push('读不到 Hindsight 诊断日志（文件缺失或无权限）⇒ 无法判断有没有失败（这与"没有失败"是两件事）。');
  }

  const apiUrlEffective = effectiveApiUrl(cfg || {});
  // daemon 形态下 `apiUrl` 是**被强制**的：文件里若还留着一个别的值，它不会生效。如实说出来 ——
  // 否则用户在界面上看着一个"配了但没用"的地址会发懵（读取端只解释，**不改文件**）。
  if (cfg && cfg.serverMode === 'daemon' && cfg.apiUrl && cfg.apiUrl !== HINDSIGHT_DAEMON_URL) {
    notes.push(`daemon 形态下 apiUrl 被 Hindsight **强制**为 ${HINDSIGHT_DAEMON_URL} ⇒ 文件里存的「${cfg.apiUrl}」不会生效（要清掉这个值，用配置区的「清除地址」）。`);
  }
  let reachable = null;
  let probeMs = null;
  if (probe) {
    if (!apiUrlEffective) {
      notes.push('没有可探测的 apiUrl（配置缺失且不是 cloud 形态）⇒ 跳过连通性探测。');
    } else {
      const r = await probeApiUrl(apiUrlEffective, { fetchImpl, timeoutMs });
      reachable = r.reachable;
      probeMs = r.probeMs;
      if (!r.reachable) notes.push(`连通性探测失败：${summarizeError(r.error || '未知原因', 120)}`);
    }
    notes.push('探测只验证「连通性」（不带 token）⇒ 401/403 也算「可达」；鉴权是否有效请看「最近失败」或手动调用。');
  }

  return {
    ok: true,
    path: configPath,
    diagPath,
    exists,
    serverMode: cfg ? cfg.serverMode : null,
    apiUrl: cfg ? cfg.apiUrl : null,
    apiUrlEffective,
    apiTokenConfigured: cfg ? cfg.apiTokenConfigured : false,
    bankForWorkspace: bankForWorkspace(cwd),
    reachable,
    probeMs,
    lastFailure,
    notes,
  };
}
