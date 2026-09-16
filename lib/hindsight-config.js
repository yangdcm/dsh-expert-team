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

/** 事件名里的"成功"后缀 —— 只有它才算**一次调用成功**（`session_start` 之类只是"发生了"）。 */
const OK_SUFFIX = '_ok';
/** 事件名里的"失败"后缀（本模块不用它判失败 —— 见 {@link scanDiag} 的失败定义）。 */
const FAILED_SUFFIX = '_failed';

/**
 * 诊断事件 → **具体操作**（`retain` / `pages` / `inject` / `reflect` / `session_start` …）。
 *
 * 只做**字面归并**：`retain_ok` 与 `retain_failed` 同属 `retain`；`inject_empty` 归 `inject`。
 * **不做语义推断**（本仓纪律：分类是观察，不是结论 —— 谁把猜测写成事实谁就骗人）。
 * @param {unknown} event
 * @returns {string}
 */
export function diagEventOperation(event) {
  const ev = String(event == null ? '' : event);
  if (ev.endsWith(OK_SUFFIX)) return ev.slice(0, -OK_SUFFIX.length) || 'unknown';
  if (ev.endsWith(FAILED_SUFFIX)) return ev.slice(0, -FAILED_SUFFIX.length) || 'unknown';
  if (ev === 'inject_empty') return 'inject';           // "召回为空"属于读路径这件事，但**不是**成功
  return ev || 'unknown';
}

/**
 * 操作 → 粗粒度类别（`write` 写入 / `read` 读取 / `reflect` 反思 / `lifecycle` 生命周期 / `unknown`）。
 *
 * ⚠️ `pages_*` 归 **write** 而不是"生命周期"：它走的是 `POST …/knowledge-base/pages`，
 * 与 `retain`（写 memories）同属**写入服务端数据**的两个不同端点（那次 WAF 403 就发生在 `/pages` 上）。
 * 把它们混为一类会让"写入是否恢复"这句话失真，所以**按端点分开归并**。
 * @param {unknown} op
 * @returns {string}
 */
export function diagOperationKind(op) {
  const s = String(op == null ? '' : op);
  if (s.startsWith('retain') || s.startsWith('pages')) return 'write';
  if (s.startsWith('inject')) return 'read';
  if (s.startsWith('reflect')) return 'reflect';
  if (s.startsWith('session')) return 'lifecycle';
  return 'unknown';
}

/** 五类承载位（`sinceFailure.byKind` 的固定键，保证"每类都有数"而不是缺键）。 */
export const DIAG_KINDS = Object.freeze(['write', 'read', 'reflect', 'lifecycle', 'unknown']);

/** 一条"之后"的记录的分类：`ok`（`_ok` 结尾）/ `neutral`（无 error 但也没说成功）/ `failed` / `empty`。 */
export function diagRecordState(event, hasError) {
  const ev = String(event == null ? '' : event);
  if (hasError) return 'failed';
  if (ev === 'inject_empty') return 'empty';
  if (ev.endsWith(OK_SUFFIX)) return 'ok';
  return 'neutral';
}

/**
 * 扫 `diag.jsonl` 文本：取**最后一条失败**，并统计**它之后**各类事件各有多少条。
 *
 * ── 失败的定义 ─────────────────────────────────────────────────────────────
 * **失败 = 带非空 `error` 字符串的记录**（就这一条，不再对事件名做例外）。
 * 依据：宿主插件里 `inject_empty` 的**全部**发射点都不带 `error`
 * （`dist/dsh.js:18150`、`dist/kilo.js:30551`、`dist/opencode2.js:30542` 等，形如 `diag(h, "inject_empty", {session})`）
 * ⇒ "召回到空"天然不是失败。反过来，**若哪天它带着 error 出现，那它就是失败**，
 * 绝不能被当成"一次良性的空召回"吞掉（那正是"两种零混成一个"）。
 *
 * ── "之后"的计数为什么必须按类分开（2026-09-16 纠错）────────────────────────
 * 旧实现只有一个 `successes`，把**除 `inject_empty` 之外的一切无 error 记录**都算成功 ——
 * 于是 `inject_ok`（读路径）、`session_start`（生命周期）、`reflect_deferred_new_bank`（**被推迟**，
 * 根本没干活）全都被算成"成功"。真机事故：那次失败是 **`retain_failed`（写 memories）**，
 * 而 `lastSuccessEvent` 却是 **`inject_ok`（读路径）**，响应却显示「已恢复」——
 * **结论碰巧是对的（其后确有 `retain_ok`），但证据撑不起结论**：读者无法从响应判断**写入**是否恢复。
 * 现在：
 *   · `byKind` / `byOperation` 给出**分类计数**（`ok` 与 `neutral` 分列 —— "被推迟"不许算成功）；
 *   · `sameKind` 给出**与那次失败同一个操作**的成功证据；
 *   · `recovered` **只按同类证据判定**，并在 `recoveredBasis` 里说明依据。
 *
 * ── 其余规则 ───────────────────────────────────────────────────────────────
 *   · 坏行/半行/非 JSON 行一律跳过（日志是追加写的，末行可能是半行），但**单独计数**：
 *     "一行都解析不出来"与"没有失败"必须分得开 —— 否则"读不懂"会被说成"没问题"；
 *   · 只看**最后 `DIAG_TAIL_LINES` 行**（所以窗口外的"之后成功"不计入，这是**范围限制，不是 bug**）。
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
  const hasError = (rec) => typeof rec.error === 'string' && rec.error.trim() !== '';
  let last = null;
  let parsedRecords = 0;
  let failureCount = 0;
  let unparsable = 0;
  for (let i = from; i < lines.length; i += 1) {
    const rec = parse(i);
    if (!rec) { if (lines[i].trim() !== '') unparsable += 1; continue; }
    parsedRecords += 1;
    if (hasError(rec)) {
      last = { index: i, ts: rec.ts == null ? null : String(rec.ts), event: rec.event == null ? null : String(rec.event), raw: rec.error };
      failureCount += 1;
    }
  }

  const emptyByKind = () => {
    const o = {};
    for (const k of DIAG_KINDS) o[k] = { ok: 0, neutral: 0, lastOkAt: null, lastOkMs: null, lastOkEvent: null };
    return o;
  };
  const since = {
    lastFailureOp: last ? diagEventOperation(last.event) : null,
    lastFailureKind: last ? diagOperationKind(diagEventOperation(last.event)) : null,
    recovered: null,
    recoveredBasis: last ? 'no-same-op-ok' : 'no-failure',
    sameKind: { op: null, kind: null, count: 0, lastAt: null, lastMs: null, lastEvent: null },
    byKind: emptyByKind(),
    byOperation: {},
    emptyRecalls: 0,
    lastAnyOkAt: null,
    lastAnyOkMs: null,
    lastAnyOkEvent: null,
  };
  if (last) {
    since.sameKind.op = since.lastFailureOp;
    since.sameKind.kind = since.lastFailureKind;
    for (let i = last.index + 1; i < lines.length; i += 1) {
      const rec = parse(i);
      if (!rec || hasError(rec)) continue;               // 之后若又失败，那条失败就是"最后一条失败"
      const ev = rec.event == null ? '' : String(rec.event);
      if (ev === 'inject_empty') { since.emptyRecalls += 1; continue; }
      const op = diagEventOperation(ev);
      const kind = diagOperationKind(op);
      const st = diagRecordState(ev, false);               // 'ok' | 'neutral'（'empty' 已在上面分流）
      if (!since.byOperation[op]) since.byOperation[op] = { ok: 0, neutral: 0, kind };
      since.byOperation[op][st] += 1;
      const bucket = since.byKind[kind] || since.byKind.unknown;
      bucket[st] += 1;
      if (st !== 'ok') continue;                          // 只有 `_ok` 才算"一次调用成功"
      bucket.lastOkAt = rec.ts == null ? null : String(rec.ts);
      bucket.lastOkMs = Number.isFinite(Number(rec.ms)) ? Number(rec.ms) : null;
      bucket.lastOkEvent = ev;
      since.lastAnyOkAt = bucket.lastOkAt;
      since.lastAnyOkMs = bucket.lastOkMs;
      since.lastAnyOkEvent = ev;
      if (op === since.lastFailureOp) {                   // ← 同类证据：**同一个操作**
        since.sameKind.count += 1;
        since.sameKind.lastAt = bucket.lastOkAt;
        since.sameKind.lastMs = bucket.lastOkMs;
        since.sameKind.lastEvent = ev;
      }
    }
    since.recovered = since.sameKind.count > 0;
    since.recoveredBasis = since.recovered ? 'same-op-ok' : 'no-same-op-ok';
  }

  let lastFailure = null;
  if (last) {
    const { classification, hint } = classifyFailure(last.raw);
    lastFailure = {
      at: last.ts,
      event: last.event,
      op: since.lastFailureOp,
      kind: since.lastFailureKind,
      summary: summarizeError(last.raw),
      classification,
      hint,
      sinceFailure: since,
    };
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
