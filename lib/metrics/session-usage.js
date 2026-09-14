// token 记账的 **IO 层**：从 DSH 会话遥测里读真实用量，按 run 的时间窗归属。
//
// 为什么放在单独文件：`lib/metrics/tokens.js` 是纯计算（可纯单测），这里全是"读盘 + 解压"，
// 而**读盘是要失败的**（会话目录可能是别的机器、可能被清理、可能没有 zstd）——
// 失败必须能被如实报告（"读不到" ≠ "消耗低"），不能让渲染层去猜。
//
// 格式（2026-09 实测，`~/.dsh/sessions/--Users-…--/<sid>/session.v3.jsonl.zstd`）：
//   首行 `{"type":"session", "createdAt":<ms>, "delegationDepth":0|1, "cwd":…, "agentPreset":…}`
//   其后每行一个事件；`{"type":"assistant/message","data":{"usage":{inputTokens,cacheReadTokens,outputTokens,reasoningTokens,totalTokens}}}`
//   注意：**usage 挂在 `data` 下**，不是顶层 —— 读错这一层会让所有数静默变成 0（本模块首轮就踩过）。
//
// 两条性能纪律（都来自实测体量：单个大会话解压后 ~10MB，一个工作区有几十个会话）：
//   ① **头与用量分两趟读**：列会话只读首行（起 `zstd -dc`，拿到第一行即杀进程）；
//      只有**落在某 run 时间窗内**的会话才做全量解压。
//   ② 两趟都按 `(路径, mtime, size)` 缓存 —— `/team learn` 会被反复调用。
//
// 压缩：优先 `zstd -dc`（本机已有），不可用时退回 Node 内置 `zlib.zstdDecompressSync`
//（Node ≥ 23.8 / 22.15）。两者都没有 ⇒ 如实报 `unsupported`，不猜。

import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/** DSH 会话根目录（`<DSH_HOME>/sessions`）。 */
export function sessionsRoot(dshHome) {
  const home = dshHome || process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
  return join(home, 'sessions');
}

/**
 * 工作区路径 → DSH 会话目录名（slug）。
 *
 * 实测编码规则（来自既有会话目录）：
 *   `/home/dev/code/my-app` → `--home-dev-code-my-app--`
 *   `/home/dev/code/packages/api` → `--home-dev-code-packages-api--`
 *   `/home/dev/code/我的项目` → `/home-dev-code-~6211~7684~9879~76EE--`
 * 即：分隔符与 `_` → `-`；非 ASCII 码点 → `~` + 大写十六进制；外层再包 `--` … `--`。
 *
 * ⚠️ 这是**逆向出来**的规则，不是从宿主源码读到的 ⇒ 找不到目录时调用方必须**列出候选目录并报告**，
 * 不能默默返回空（"读不到"与"没消耗"必须可区分）。
 */
export function workspaceSlug(cwd) {
  const s = String(cwd ?? '');
  // 前导分隔符**原样留着**（它自己就是 slug 开头那两个短横线里的一个），其余分隔符与 `_` → `-`，
  // 最后补 `--` 收口。首轮实现把前导 `/` 也换成了 `-` 再补 `--` ⇒ 得到 `---Users-…`（多一个横杠，
  // 于是**永远找不到会话目录**，而且失败是静默的 —— 正是本模块注释里警告的那类"读不到"）。
  const head = /^[/\\]/.test(s) ? s[0] : '';
  let body = '';
  for (const ch of s.slice(head ? 1 : 0)) {
    const cp = ch.codePointAt(0);
    if (cp > 127) body += `~${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    else if (ch === '/' || ch === '\\' || ch === '_') body += '-';
    else body += ch;
  }
  return `${head}${body}--`;
}

let _zstd = null;
/** `zstd -dc` 是否可用（只探测一次，结果缓存）。 */
export async function hasZstd() {
  if (_zstd !== null) return _zstd;
  _zstd = await new Promise((resolve) => {
    try {
      const p = spawn('zstd', ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch { resolve(false); }
  });
  return _zstd;
}

/** 只读首行（`type: session` 的头）：拿到第一行即杀掉解压进程，不做全量解压。 */
async function readSessionHeader(file) {
  if (!(await hasZstd())) {
    try {
      const { zstdDecompressSync } = await import('node:zlib');
      const text = zstdDecompressSync(await readFile(file)).toString('utf8');
      const nl = text.indexOf('\n');
      return JSON.parse(nl < 0 ? text : text.slice(0, nl));
    } catch { return null; }
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { p.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve(v);
    };
    const p = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    p.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) { try { finish(JSON.parse(buf.slice(0, nl))); } catch { finish(null); } }
    });
    p.on('error', () => finish(null));
    p.on('close', () => finish(null));
  });
}

/** 全量解压 → 事件数组（坏行跳过：半写状态是常态）。 */
async function readSessionEvents(file) {
  let text;
  if (!(await hasZstd())) {
    const { zstdDecompressSync } = await import('node:zlib');
    text = zstdDecompressSync(await readFile(file)).toString('utf8');
  } else {
    text = await new Promise((resolve, reject) => {
      const p = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('error', reject);
      p.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }
  // ⚠️ 不要用 `readline` 去"流式"切行：文本本来就已经整份在内存里，而
  // `createInterface({ input: Readable.from([text]) })` 把整份文本当成**一个 chunk**，
  // 遍历时会抛 `readline was closed` —— 而外层 `catch { return null }` 会把它变成
  // 「读不到」，也就是**所有会话的用量静默变成 0**（本模块实测踩过这个坑：
  // 表现是 46 个会话角色认不出 + 大量数据缺失，而没有任何报错）。
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 取一条消息的文本。
 *
 * ⚠️ **两种形状都存在**（实测，同一份日志里）：
 *   · `system/message` / `assistant/message`：`data.message.content[]`
 *   · `user/message`：**`data.content[]`**（没有 `message` 包装层）
 * 首轮只认前者 ⇒ 用户提示词一条都读不到，于是"角色标签"与"runId 标记"双双失效
 * （表现正是 28 个会话角色认不出、45 个会话无归属）。所以两种都收。
 */
function messageText(data) {
  if (!data || typeof data !== 'object') return '';
  const content = (data.message && data.message.content) || data.content || [];
  let s = '';
  for (const x of content) if (x && x.type === 'text') s += String(x.text || '');
  return s;
}

/** 单会话的用量汇总（与会话文件一一对应）。 */
function summarizeEvents(events) {
  let inTok = 0; let cacheTok = 0; let outTok = 0; let reasonTok = 0; let steps = 0;
  let peak = 0; let first = 0; let sysChars = 0; let userChars = 0;
  // 前几条 user 消息的文本：**角色标签**（`【测试工程师】…`）与 **runId 标记**都在里面。
  // 为什么要采它：会话头**没有** role，也没有 runId —— 归属只能从提示词里读；
  // 而 `STATE.members` 只记部分成员（实测一个 run 的 14 个会话里只有 4 个在 members 里）。
  // 取**前 4 条**而不是第 1 条：真实子会话的第 1 条用户消息可能是"运行环境说明"，
  // 角色标签在后面那条任务提示词里（实测就是这么排的）。
  const promptSample = [];
  for (const o of events) {
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'system/message') {
      sysChars += messageText(o.data).length;
    } else if (o.type === 'user/message') {
      const txt = messageText(o.data);
      userChars += txt.length;
      if (promptSample.length < 4 && txt) promptSample.push(txt.slice(0, 4000));
    } else if (o.type === 'assistant/message' && o.data && o.data.usage) {
      const u = o.data.usage;
      const prompt = (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0);
      steps += 1;
      inTok += Number(u.inputTokens) || 0;
      cacheTok += Number(u.cacheReadTokens) || 0;
      outTok += Number(u.outputTokens) || 0;
      reasonTok += Number(u.reasoningTokens) || 0;
      if (prompt > peak) peak = prompt;
      if (!first) first = prompt;   // 「首个带 usage 的 assistant 消息」= 每会话固定开销
    }
  }
  return { in: inTok, cache: cacheTok, out: outTok, reasoning: reasonTok, steps, peak, first, sysChars, userChars, promptSample };
}

const HEADER_CACHE = new Map();    // file -> {mtimeMs, size, entry}
const USAGE_CACHE = new Map();     // file -> {mtimeMs, size, summary}
const DIR_CACHE = new Map();       // cwd -> {dir, reason}
let _lastListError = '';

/** 会话文件名（两种都在用：新会话 `session.v3.jsonl.zstd`，更早的 `session.jsonl.zstd`）。 */
const SESSION_FILES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd'];

/** 找到目录里第一个会话文件（两种命名都认）。 */
function firstSessionFile(sessionDir) {
  for (const f of SESSION_FILES) {
    const p = join(sessionDir, f);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 解析一个工作区的会话目录。
 *
 * **不再靠猜 path→slug 的编码**：首轮按逆向出的规则拼 slug，两次都拼错（前导分隔符与
 * 非 ASCII 的处理都与我猜的不同），而拼错的后果是**静默找不到目录** —— 正是本模块注释里
 * 反复警告的那类失败。改成**内容验证**：候选目录里读一个会话头，比对头里的 `cwd`
 * （会话头自带 `cwd`，这是**权威**，不是推出来的）。slug 只作为**快路径提示**，命中不了就扫。
 *
 * 代价：冷启动最多扫一遍 sessions 根（本机 9 个目录 × 1 次头部读取 ≈ 几十毫秒），结果按 cwd 缓存。
 *
 * @returns `{ok, dir, reason, candidates}`
 */
export async function resolveWorkspaceDir(cwd, opts = {}) {
  const root = sessionsRoot(opts.dshHome);
  const key = String(cwd ?? '');
  const cached = DIR_CACHE.get(key);
  if (cached && (cached.ok ? existsSync(cached.dir) : true)) return cached;

  let candidates = [];
  try { candidates = (await readdir(root)).filter((d) => d.startsWith('--')); } catch {
    const r = { ok: false, dir: '', reason: 'sessions-root-unreadable', candidates: [] };
    _lastListError = `会话根目录读不了：${root}`;
    return r;
  }

  // 快路径：slug 猜中且头里的 cwd 一致才认（**必须验证**，否则会把别人的 run 算进来）。
  const guess = join(root, workspaceSlug(cwd));
  const order = [guess, ...candidates.map((d) => join(root, d)).filter((d) => d !== guess)];
  for (const dir of order) {
    if (!existsSync(dir)) continue;
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      const file = firstSessionFile(join(dir, name));
      if (!file) continue;
      const header = await readSessionHeader(file);
      if (!header || header.type !== 'session') continue;
      if (String(header.cwd || '') === String(cwd)) {
        const r = { ok: true, dir, reason: '', candidates };
        DIR_CACHE.set(key, r);
        return r;
      }
      break;   // 该目录的第一个会话头已经能判定归属，不必再读同目录其它会话
    }
  }
  const r = { ok: false, dir: '', reason: 'no-session-for-workspace', candidates };
  DIR_CACHE.set(key, r);
  _lastListError = `sessions 根下没有属于本工作区（${cwd}）的会话目录；已扫 ${candidates.length} 个候选目录`;
  return r;
}

/**
 * 列出一个工作区下的会话（**只读头**，不解压正文）。
 *
 * @param cwd - 工作区绝对路径。
 * @param opts - `{dshHome}`。
 * @returns `{ok, slug, dir, sessions:[{id, file, createdAt, depth, preset, mtimeMs, size}], candidates, reason}`
 *   `ok:false` 时 `candidates` 是 sessions 根下**实际存在的 slug**（供报告指出"找不到哪个目录"）。
 */
export async function listWorkspaceSessions(cwd, opts = {}) {
  const slug = workspaceSlug(cwd);
  const resolved = await resolveWorkspaceDir(cwd, opts);
  if (!resolved.ok) {
    return { ok: false, slug, dir: resolved.dir, sessions: [], candidates: resolved.candidates, reason: resolved.reason };
  }
  const dir = resolved.dir;
  let names = [];
  try { names = await readdir(dir); } catch {
    _lastListError = `会话目录读不了：${dir}`;
    return { ok: false, slug, dir, sessions: [], candidates: resolved.candidates, reason: 'unreadable' };
  }
  const sessions = [];
  for (const name of names) {
    const file = firstSessionFile(join(dir, name));
    if (!file) continue;
    let st;
    try { st = await stat(file); } catch { continue; }
    const cached = HEADER_CACHE.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      sessions.push(cached.entry);
      continue;
    }
    const header = await readSessionHeader(file);
    if (!header || header.type !== 'session') continue;
    const entry = {
      id: String(header.id || name),
      file,
      createdAt: Number(header.createdAt) || 0,
      depth: Number(header.delegationDepth) || 0,
      preset: String(header.agentPreset || ''),
      cwd: String(header.cwd || ''),
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    HEADER_CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry });
    sessions.push(entry);
  }
  sessions.sort((a, b) => a.createdAt - b.createdAt);
  _lastListError = '';
  return { ok: true, slug, dir, sessions, candidates: [], reason: '' };
}

/** 上一次 `listWorkspaceSessions` 的失败原因（供报告引用；成功时为空串）。 */
export function lastListError() { return _lastListError; }

/**
 * 读一个会话的**用量汇总**（会全量解压；结果按 mtime/size 缓存）。
 * @returns 用量对象，或 `null`（解压/读取失败 —— 调用方按"读不到"处理，**不得**当成 0）。
 */
export async function readSessionUsage(file) {
  try {
    const st = await stat(file);
    const cached = USAGE_CACHE.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.summary;
    const events = await readSessionEvents(file);
    const summary = summarizeEvents(events);
    USAGE_CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
    return summary;
  } catch { return null; }
}

/** 清缓存（测试用；也便于命令侧强制重读）。 */
export function clearSessionCache() { HEADER_CACHE.clear(); USAGE_CACHE.clear(); DIR_CACHE.clear(); _lastListError = ''; }
