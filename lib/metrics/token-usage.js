// token 记账的**编排层**：把「run 目录 / 日志 / 会话遥测」三处的原始输入，算成 `renderTokenSection` 能吃的数据。
//
// 分工（本包对"一个事实多份拷贝"的既定纪律，逐条沿用）：
//   · `tokens.js`          —— 纯计算与文案（可纯单测，零 IO）
//   · `session-usage.js`   —— 会话遥测的读取（zstd 解压、按 mtime 缓存）
//   · **本文件**            —— 把两者接起来：run 时间窗、角色归属、两种来源的取舍
//   · `command.js`         —— 只调 `collectTokenUsage()` 并把结果交给渲染器
//
// ⚠️ **会话归属靠时间窗，不靠任何持久标记**。为什么：会话文件里没有 runId，而 run 目录里没有
//    sessionId（`STATE.members` 只记**角色**成员，不记 lead 自己）。所以归属规则必须是可解释的：
//   「会话创建时刻落在哪个 run 的窗口内 ⇒ 属于那个 run」，窗口 = 本 run 起点 → 下一个 run 起点。
//   落在所有窗口之外的会话**不猜**，计数后如实报告（`unattributed`）。

import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLogLine, eventFamily, truncateCodepoints } from '../log-parse.js';
import { parseTokenEvent, TOKEN_EVENT_FAMILY, summarizeTokenUsage } from './tokens.js';
import { listWorkspaceSessions, readSessionUsage, lastListError } from './session-usage.js';

/** 从 `【中文角色】…` 里精确取角色标签（与 host/client 的 `ROLE_LABELS_ZH` 同一套中文标签）。 */
const ZH_ROLE_LABELS = [
  ['产品经理', 'pm'], ['架构师', 'architect'], ['调研员', 'researcher'], ['研究员', 'researcher'],
  ['界面设计师', 'ui'], ['设计师', 'ui'], ['后端工程师', 'backend'], ['后端', 'backend'],
  ['前端工程师', 'frontend'], ['前端', 'frontend'], ['数据库工程师', 'dba'], ['安全工程师', 'sec'],
  ['代码审查员', 'reviewer'], ['审查员', 'reviewer'], ['测试工程师', 'qa'], ['测试', 'qa'],
  ['运维工程师', 'devops'], ['运维', 'devops'], ['文档工程师', 'docs'], ['文档', 'docs'],
  ['竞品分析师', 'competitive-analyst'], ['产品分析师', 'product-analyst'], ['编排者', 'lead'], ['领队', 'lead'],
];

/**
 * 从一段文本里取**中文角色标签**（`【测试工程师】T-04：…` → `qa`）。
 * 取不到返回 `''`（**不猜**）：兜底会退化成把任意任务名当角色。
 */
export function roleFromBracketLabel(text) {
  const m = String(text ?? '').match(/【([^】]{1,12})】/);
  if (!m) return '';
  const label = m[1].trim();
  for (const [zh, id] of ZH_ROLE_LABELS) if (label === zh) return id;
  // 近似匹配：标签里含角色词（`前端工程师-A` 这类带后缀的写法）
  for (const [zh, id] of ZH_ROLE_LABELS) if (label.includes(zh)) return id;
  return '';
}

/**
 * 解析 `RUN.log.md` 全部行里的 token 事件。
 *
 * 两种写法都收（都是**已经落地过的**记法）：
 *   · `tokens:backend — steps=62 in=2621 cache=177955 out=1132 peak=528246`
 *   · `role:backend tokens steps=62 in=… cache=… out=…`（把用量挂在既有的 `role:` 行上）
 * 后者用 `eventFamily === 'role'` + detail 里出现 `tokens` 判定。
 *
 * @returns `{events: [{scope, source:'log', ...values}], broken: number}`
 *   `broken` = 是 token 事件、但**一个合法字段都没解析出来**的行数（写错字段名会静默消失，必须可见）。
 */
export function parseTokenLogEvents(log) {
  const events = [];
  let broken = 0;
  for (const line of String(log ?? '').split('\n')) {
    const ev = parseLogLine(line);
    if (!ev) continue;
    const fam = eventFamily(ev.type);
    let hit = null;
    if (fam === TOKEN_EVENT_FAMILY) {
      hit = parseTokenEvent(ev.type, ev.detail);
    } else if (fam === 'role' && /(^|\s)tokens(\s|$|=)/.test(String(ev.detail ?? ''))) {
      // `role:<角色> … tokens …`：scope 取角色名（与 `role:` 同一套写法）
      const scope = ev.type.slice('role:'.length).split(/[(\s]/)[0] || 'unknown';
      const parsed = parseTokenEvent(`${TOKEN_EVENT_FAMILY}:${scope}`, ev.detail);
      hit = parsed ? { ...parsed, scope } : null;
    }
    if (!hit) continue;
    if (!hit.ok) { broken += 1; continue; }
    events.push({ scope: hit.scope, source: 'log', ...hit.values, line: truncateCodepoints(ev.detail, 80) });
  }
  return { events, broken };
}

/** `STATE.members` → `Map<sessionId, role>`（两种历史写法都认：`sid:role` 与 `role:name`）。 */
export function membersBySession(state) {
  const map = new Map();
  const arr = Array.isArray(state && state.members) ? state.members : [];
  for (const raw of arr) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const m = s.match(/^([0-9a-fA-F-]{8,}):([^:]+)$/);
    if (m) { map.set(m[1], m[2].trim()); continue; }
    const legacy = s.match(/^([^:]+):/);   // `pm:Mia` —— 没有 sessionId，无法归属（有意不进 map）
    void legacy;
  }
  return map;
}

/** 目录名的尾巴 `…-235644` → `{h:23,m:56,s:44}`（`/team` 建 run 时的时间戳；取不到返回 null）。 */
export function clockFromDirName(name) {
  const m = String(name ?? '').match(/-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]); const sec = Number(m[3]);
  if (h > 23 || mi > 59 || sec > 59) return null;
  return { h, m: mi, s: sec };
}

/**
 * 求一个 run 的**时间窗** `{start, end, basis}`。
 *
 * 起点优先级：`STATE.startedAt` → `RUN.log.md` 首条 `run:started` 的 `HH:MM:SS` → 目录名尾 6 位时间戳。
 * 只有 `HH:MM:SS` 时，**日期取 run 目录的 mtime**（同一天内建目录，与真实情况一致）。
 * 终点：下一个 run 的起点（调用方传入）；没有下一个 ⇒ `mtime + 6h`（足够覆盖一次长 run 的尾巴）。
 * 三种都取不到 ⇒ `{start: null}`，该 run **不做遥测归属**（但日志事件仍可用）。
 */
export function runWindow({ state, log, dirName, dirMtimeMs, nextStart = null }) {
  let clock = null; let basis = '';
  if (state && typeof state.startedAt === 'string' && state.startedAt) {
    const t = Date.parse(state.startedAt);
    if (Number.isFinite(t)) return { start: t, end: nextStart ?? (dirMtimeMs + 6 * 3600 * 1000), basis: 'STATE.startedAt' };
  }
  for (const line of String(log ?? '').split('\n')) {
    const ev = parseLogLine(line);
    if (!ev) continue;
    if (eventFamily(ev.type) === 'run' && String(ev.type).endsWith('started')) {
      const m = String(ev.time).match(/^(\d{2}):(\d{2}):(\d{2})$/);
      if (m) { clock = { h: +m[1], m: +m[2], s: +m[3] }; basis = 'run:started'; break; }
    }
  }
  if (!clock) {
    const c = clockFromDirName(dirName);
    if (c) { clock = c; basis = 'dir-name'; }
  }
  if (!clock) return { start: null, end: null, basis: 'none' };
  const d = new Date(dirMtimeMs);
  d.setHours(clock.h, clock.m, clock.s, 0);
  let start = d.getTime();
  // 目录 mtime 的日期可能比 run 实际开始晚一天（跨零点建/改）⇒ 若起点晚于 mtime，往前退一天。
  if (start > dirMtimeMs) start -= 24 * 3600 * 1000;
  return { start, end: nextStart ?? (dirMtimeMs + 6 * 3600 * 1000), basis };
}

/**
 * token 记账的总入口（`aggregate()` 调用）。
 *
 * @param root - `<cwd>/team`。
 * @param names - run 目录名（已按名称排序，含时间戳）。
 * @param readRun - `(name) => Promise<{state, log, dir}>`（复用采集层的 `readRunInputs` + 目录 stat，避免重复读盘）。
 * @param opts - `{cwd, dshHome, workspace, now}`。
 * @returns `{runs: [{name, source, byScope, totals, avgPromptPerStep, ...}], broken, unattributed, skipped, notes}`
 *   —— **遥测可用时不叠加日志事件**（两个来源权威性不同，相加会得到一个谁也不是的数）。
 */
export async function collectTokenUsage(root, names, readRun, opts = {}) {
  const list = Array.isArray(names) ? names : [];
  const notes = [];
  const sessionsInfo = await listWorkspaceSessions(opts.workspace, { dshHome: opts.dshHome });
  const usageSessions = sessionsInfo.ok ? sessionsInfo.sessions.filter((s) => s.createdAt > 0) : [];
  if (!sessionsInfo.ok) {
    notes.push(lastListError() || '会话遥测目录不可用');
    if (sessionsInfo.candidates && sessionsInfo.candidates.length) {
      notes.push(`sessions 根下现有 ${sessionsInfo.candidates.length} 个工作区目录（本工作区 slug 不在其中：${sessionsInfo.slug}）`);
    }
  }

  // ── 第一趟：读每个 run 的输入（state / log / 目录 mtime）──
  // 注意：**这里算出的日志时间戳不用于归属**（理由见第二趟的长注释：`run:started` 可能是
  // 几天后补记的）。`runWindow` 只作为**参考信息**保留在报告里（`logWindowBasis`），
  // 让读者知道"日志里那个起点是怎么推出来的"。
  const inputs = [];
  for (const name of list) {
    let read = { state: null, log: '', dir: join(root, name) };
    try { read = { ...read, ...(await readRun(name)) }; } catch { /* 缺件按空 */ }
    let dirMtimeMs = opts.now ?? Date.now();
    try { dirMtimeMs = (await stat(join(root, name))).mtimeMs; } catch { /* 用 now */ }
    inputs.push({ name, state: read.state, log: read.log ?? '', dirMtimeMs });
  }
  const logWindows = inputs.map((it) => runWindow({ state: it.state, log: it.log, dirName: it.name, dirMtimeMs: it.dirMtimeMs, nextStart: null }));

  // ── 第二趟：**标记优先**地把会话归属到 run（时间**锚在会话证据上**）────────────────
  //
  // 为什么不用 `RUN.log.md` 的 `run:started` 当窗口起点（首轮实测踩过，代价很大）：
  // 那个时间戳是**当天那次写入**记的 —— 一个 run 被 `/team resume` 或事后补记时，
  // `run:started` 会被写成**几天后**的时刻。实测「做竞品分析」的 run 起点因此落到
  // 09-12T14:56，而它的会话创建于 **09-10T14:55**（差两天）⇒ 36 个明明带标记的会话
  // 被"更晚的 run"抢走、真正的归属反而靠最弱的"就近"档，数字全错。
  //
  // 所以归属**只用会话自己的证据**（这是读出来的事实，不是推断）：
  //   ① 派工提示词里带 runId / run 目录名 ⇒ 标记命中（强证据）；
  //   ② 一个 run 的**锚点** = 命中它标记的**最早会话**的创建时刻（而不是日志时间戳）；
  //   ③ 命中多个标记的会话（任务里引用了别的 run 的工件，实测存在）用锚点消歧：
  //      取「不晚于该会话」里锚点最晚的那个 run；
  //   ④ 没命中任何标记的会话（老 run 的子会话、lead 会话本身）落到**不晚于它、锚点最晚**的 run。
  //
  // 结果里每条 run 都带 `anchorMs`（锚点）与各档计数，报告里如实写明依据强度。
  // 标记要**带路径形态**才算命中，不能只匹配裸 runId。
  // 为什么（实测踩过）：runId 会被截断/口号化成很短的名字（`设计一个极简的番茄钟…不`），
  // 而任何"讨论到这个目标"的会话提示词里都会出现这串字 ⇒ 裸匹配会把**无关会话**当成它的成员，
  // 进而把它的锚点算早、让它吞掉后面一整段无标记会话（实测那个空 run 因此吃进 15 个会话、
  // 凭空变成最贵的 run）。派工词里引用 run 目录是**路径形态**（`team/<runId>/`），据此匹配。
  const markers = inputs.map((it, i) => {
    const id = it.state && it.state.runId ? String(it.state.runId) : '';
    const name = String(it.name || '');
    return { key: id || name, name, pathForm: `team/${id || name}` , index: i };
  });
  const markerHit = (blob, m) => {
    const key = String(m.key || '');
    if (!key) return false;
    // `team/<key>` 命中即算（派工词里写的是 run 目录路径；带不带结尾斜杠都收）
    if (blob.includes(m.pathForm)) return true;
    // 裸 key 只在**足够长**时才当证据（短名极易误配 —— 见上面的实测）
    return key.length >= 16 && blob.includes(key);
  };

  // 先把所有会话的用量读出来（同一份缓存，后面不再重复解压）
  const hydrated = [];
  for (const s of usageSessions) {
    const u = await readSessionUsage(s.file);
    if (!u || !(u.steps > 0)) continue;      // 读不到 / 没跑过一步的空壳会话不计
    const blob = (u.promptSample || []).join('\n');
    const hitRuns = [];
    for (let i = 0; i < markers.length; i += 1) {
      if (markerHit(blob, markers[i])) hitRuns.push(i);
    }
    hydrated.push({ s, u, hitRuns });
  }

  // ① 锚点：每个 run 的「最早命中自身标记的会话」创建时刻
  const anchorMs = inputs.map(() => null);
  for (const h of hydrated) {
    for (const i of h.hitRuns) {
      if (anchorMs[i] === null || h.s.createdAt < anchorMs[i]) anchorMs[i] = h.s.createdAt;
    }
  }

  // ② 每个 run 的**参考区间**上界 = min(下一个更晚的锚点, 本锚点 + 12h)。
  //
  // 两道约束各自的理由（都是实测出来的）：
  //   · **下一个锚点**：最老的 run 若没有上界，会吞掉它之后所有无标记会话
  //     （实测：09-07 那个 `番茄钟` run 吃进 15 个 09-11 的会话、凭空变成最贵的 run）。
  //   · **+12h 时长上限**：只有"下一个锚点"还不够 —— 两个 run 之间可能空出一整天，
  //     期间的无标记会话（别的机器、被中断的 run 留下的孤儿）会被硬塞进前一个 run。
  //     12h 的依据：本包观测到的最长 run ≈ 10h，留一点余量；**宁可判"未归属"也不硬塞**。
  const RUN_SPAN_CAP_MS = 12 * 3600 * 1000;
  const refEndMs = inputs.map((_, i) => {
    let best = null;
    for (let j = 0; j < anchorMs.length; j += 1) {
      const a = anchorMs[j];
      // 只把**严格更晚**的锚点当上界；`anchorMs[i] === null` 时（本 run 没有锚点）
      // 取全局最早的锚点当上界（那种 run 本来就分不到"就近"档的会话）。
      if (a === null) continue;
      if (anchorMs[i] !== null && a <= anchorMs[i]) continue;
      if (best === null || a < best) best = a;
    }
    const cap = anchorMs[i] === null ? null : anchorMs[i] + RUN_SPAN_CAP_MS;
    if (best === null) return cap;                    // 最晚的锚点 ⇒ 只受时长上限约束
    if (cap === null) return best;
    return Math.min(best, cap);
  });

  const perRunSessions = inputs.map(() => []);
  const attrTally = { marker: 0, nearest: 0, none: 0, outOfRange: 0 };
  for (const { s, u, hitRuns } of hydrated) {
    let hit = -1;
    let basis = 'marker';
    if (hitRuns.length === 1) {
      hit = hitRuns[0];
    } else if (hitRuns.length > 1) {
      // ③ 消歧：取「锚点不晚于该会话」里最晚的那个（会话必然创建于其 run 开始之后）
      for (const i of hitRuns) {
        const a = anchorMs[i];
        if (a !== null && s.createdAt >= a && (hit < 0 || a > anchorMs[hit])) hit = i;
      }
      if (hit < 0) {
        // 锚点全都晚于该会话（如它正是某 run 的最早会话，而同时引用了更早 run 的工件）：
        // 取标记更长（更具体）的那个，并如实降级为"就近"档。
        for (const i of hitRuns) if (hit < 0 || String(markers[i].key).length > String(markers[hit].key).length) hit = i;
        basis = 'nearest';
      }
    } else {
      // ④ 无标记：落到「锚点不晚于它、锚点最晚」的 run，且必须**落在该 run 的参考区间内**
      for (let i = 0; i < anchorMs.length; i += 1) {
        const a = anchorMs[i];
        if (a === null) continue;
        if (s.createdAt < a) continue;
        const upper = refEndMs[i];
        if (upper !== null && s.createdAt >= upper) continue;
        if (hit < 0 || a > anchorMs[hit]) hit = i;
      }
      if (hit >= 0) basis = 'nearest';
      else { attrTally.outOfRange += 1; attrTally.none += 1; continue; }
    }
    if (hit < 0) { attrTally.none += 1; continue; }
    attrTally[basis] += 1;
    perRunSessions[hit].push({ ...s, usage: u, basis });
  }

  // ── 第三趟：算每个 run 的 rows（遥测优先；遥测空才回落日志事件）──
  const runs = [];
  let brokenTotal = 0;
  for (let i = 0; i < inputs.length; i += 1) {
    const it = inputs[i];
    const parsed = parseTokenLogEvents(it.log);
    brokenTotal += parsed.broken;
    const rows = [];
    const bySession = membersBySession(it.state);
    for (const s of perRunSessions[i]) {
      const u = s.usage;
      // 角色归属三档：① 提示词里的**中文角色标签**（精确表，扫前几条）→ ② `STATE.members` 的
      // sessionId→role 绑定 → ③ 退化成会话 id 前缀（**标注出来**，不假装知道它是谁）。
      let label = '';
      for (const t of (u.promptSample || [])) { label = roleFromBracketLabel(t); if (label) break; }
      const bound = bySession.get(s.id) || '';
      const role = label || bound || (s.depth === 0 ? 'lead' : '');
      rows.push({
        scope: role || `session-${String(s.id).slice(0, 8)}`,
        roleKnown: !!(label || bound || s.depth === 0),
        source: 'telemetry',
        in: u.in, cache: u.cache, out: u.out, steps: u.steps, peak: u.peak, first: u.first,
      });
    }
    let source = 'telemetry';
    if (!rows.length && parsed.events.length) {
      source = 'log';
      for (const e of parsed.events) rows.push({ ...e, source: 'log' });
    } else if (!rows.length) {
      continue;                                          // 两者都没有 ⇒ 该 run 不进报告（"无记账"由空节统一说明）
    }
    const summary = summarizeTokenUsage(rows, opts.weights ? { weights: opts.weights } : {});
    // 归属依据按**这个 run 实际用到的档次**汇总（强 → 弱排序）。`marker` = 提示词里带 runId
    // （强证据）；`nearest` = 无标记、落到"锚点不晚于它且锚点最晚"的 run（弱证据，如实标出）。
    const basisCount = new Map();
    for (const s of perRunSessions[i]) basisCount.set(s.basis, (basisCount.get(s.basis) ?? 0) + 1);
    const order = ['marker', 'nearest'];
    const basisText = source === 'log'
      ? '日志事件'
      : (order.filter((b) => basisCount.has(b)).map((b) => `${b}×${basisCount.get(b)}`).join(' / ') || '—');
    runs.push({
      name: it.name, source, windowBasis: basisText,
      anchorMs: anchorMs[i], logWindowBasis: logWindows[i].basis,
      ...summary,
    });
  }

  const unknownRoles = runs.reduce((a, r) => a + r.byScope.filter((s) => s.roleKnown === false).length, 0);
  if (attrTally.marker > 0) notes.push(`${attrTally.marker} 个会话按提示词里的 **runId 标记**归属（依据最强）`);
  if (attrTally.nearest > 0) notes.push(`${attrTally.nearest} 个会话无 run 标记，落到**参考区间内锚点最晚**的 run（依据较弱，如实标出）`);
  const outOfAll = attrTally.none - attrTally.outOfRange;
  if (outOfAll > 0) notes.push(`${outOfAll} 个会话早于所有 run 锚点 ⇒ 未归属（**不猜**）`);
  if (attrTally.outOfRange > 0) notes.push(`${attrTally.outOfRange} 个会话晚于所有 run 的参考区间（不落在任何相邻锚点之间）⇒ 未归属（**不猜**）`);
  if (unknownRoles > 0) notes.push(`${unknownRoles} 个会话的角色认不出（提示词无中文角色标签、STATE.members 也无绑定）⇒ 以会话 id 显示`);
  return { runs, broken: brokenTotal, unattributed: attrTally.none, attrTally, notes };
}

/** 会话目录里的目录名清单（诊断用：`/team tokens` 报告"读不到哪个目录"时要列出来）。 */
export async function sessionSlugCandidates(dshHome) {
  const root = join(dshHome || process.env.DSH_HOME || join(process.env.HOME || '', '.dsh'), 'sessions');
  try { return (await readdir(root)).filter((d) => d.startsWith('--')); } catch { return []; }
}
