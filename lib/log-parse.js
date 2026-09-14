// 运行日志解析（B 线第 8 项 · `log-parse.js`）：把 `RUN.log.md` 的一行变成结构化事件。
//
// 为什么单独成模块：**同一个解析器被至少四个消费者用** —— METRICS 聚合、`/team check` 的阶段记账、
// 命令侧的状态行、以及测试里的 `_live`。它以前住在 5000 行的编排器里，而 2026-09-13 我为"阶段记账"
// 检查**临时抄了一份简化版**（`validate.js` 的 `parseLogLineLite`）—— 那正是本仓头号返工源
// 「一个事实多份拷贝」的形态（两份解析器迟早分叉，而"哪边对"没人说得清）。搬出来之后**只此一份**。
//
// 口径（与 LOGGING.md 逐字对应，**不要在这里"顺手改好一点"**）：
//   · 时间戳宽容：`HH:MM:SS` 是规范写法，但 `[now]` 这类历史写法**仍然计入事件**（否则当年那些
//     run 的决策/阶段会被静默丢掉）；
//   · 判决**只认 `verdict=<token>`**；`verdict=` 一旦出现就**绝不回落**到从中文散文里猜
//     （历史 bug：`verdict=needs_revision；…通过 10…` 曾被散文正则提升成 pass）；
//   · 角色名归一（`pm(repair)` → `pm`）与"从 `【中文标签】` 精确表取角色"分开：前者模糊、后者精确。
//
// 零 IO、零依赖（只用 vocab.js 的词表）⇒ 可单测。

import { ROLE_LABELS_ZH, SUB_ROLE_WORDS } from './vocab.js';

/**
 * **从日志散文里**找角色名用的表（含 `lead`）。
 * ⚠️ 它与 `vocab.js` 的 `KNOWN_ROLES` / 固定 12 角色**不是**同一件事：那份是"编制里有哪些角色"，
 * 这份是"一行日志文本里出现了哪个角色词"（所以多一个 `lead`）。搬迁时**原样保留**，不合并——
 * 合并会改变 `normalizeRoleName` 的行为（例如把 `competitive-analyst` 归一成 `competitive`）。
 * 这是一处**已知的重复**，记在这里以免下次有人"顺手统一"。
 */
const ROLE_NAMES = ['pm', 'architect', 'researcher', 'backend', 'frontend', 'ui', 'dba', 'sec', 'devops', 'docs', 'reviewer', 'qa', 'lead'];
export { ROLE_NAMES };

// Parse STATE.members — the authorative per-run roster bindings written by the
// lead at dispatch time. TWO formats observed in real runs:
//   ["<agentSessionId>:<role>", ...]  ← precise (multi-run isolation!)
//   ["pm:Mia", ...]                   ← role:name (legacy, no agent id)
// Returns { byRole: Map<role, agentId>, names: Map<role, name> }.
export function roleNorm(r) {
  const rr = String(r || '').trim().toLowerCase();
  const bare = rr.split('-')[0];
  if (['pm', 'architect', 'researcher', 'backend', 'frontend', 'reviewer', 'qa', 'ui', 'dba', 'sec', 'devops', 'docs'].includes(bare)) return bare;
  for (const [role, words] of SUB_ROLE_WORDS) {
    if (words.some((w) => rr.includes(w))) return role;
  }
  return rr;
}

// ── learn: aggregate RUN.log.md events into metrics + distilled learnings ──

export function parseLogLine(line) {
  // Tolerant timestamp: `HH:MM:SS` (canonical) or ANY marker (real logs use
  // `[now]`); unknown markers still count the EVENT so aggregations do not
  // silently drop decisions/phases written by the lead.
  const m = line.match(/^- \[([^\]]+)\] (\S+) — (.*)$/);
  return m ? { time: m[1], type: m[2], detail: m[3] } : null;
}

/** `error:external-write` → 'error'；`role:pm` → 'role'；`phase:clarify` → 'phase'；无冒号则原样。 */
export function eventFamily(type) {
  const s = String(type ?? '');
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(0, i);
}

/**
 * R10：按**码点**截断，不按 UTF-16 码元。
 * 旧 `.slice(0, 120)` 会把代理对（emoji）切成半个，落盘后变成 `U+FFFD` 乱码
 * （T-04 实测：`'x'.repeat(119) + '🙂'` ⇒ 样例末尾出现 `U+FFFD`）。长度上限语义不变。
 */
export function truncateCodepoints(s, max) {
  const str = String(s ?? '');
  const n = Number(max) > 0 ? Math.floor(Number(max)) : 120;
  const cps = [...str];
  return cps.length <= n ? str : cps.slice(0, n).join('');
}

/** 事件子类计数：`{count, sample}`，sample = 首条 detail 去换行截 120 码点。 */
export function tallyEvent(map, type, detail) {
  const cur = map.get(type) ?? { count: 0, sample: '' };
  cur.count += 1;
  if (!cur.sample) cur.sample = truncateCodepoints(String(detail ?? '').replace(/[\r\n]+/g, ' ').trim(), 120);
  map.set(type, cur);
}

/** 渲染 `- \`<子类>\` × <n> — <样例>`（按次数降序）。 */
export function eventTallyLines(map, emptyText) {
  if (!map.size) return `- ${emptyText}`;
  return [...map.entries()].sort((a, b) => b[1].count - a[1].count)
    .map(([k, v]) => `- \`${k}\` × ${v.count}${v.sample ? ` — ${v.sample}` : ''}`).join('\n');
}

/**
 * R11：角色名归一 —— 取到**第一个 `(`、`:` 或空白**之前为止。
 * `role:pm(repair)` → `pm`（旧实现 `split(':')[0]` 会造出 `pm(repair)` 这个幽灵桶，
 * 真实 php/school run 里有 15 条这种行，带 verdict= 时就渲染成幽灵角色行）；
 * `role:frontend-F4` 这类**合法后缀**保留（`-` 不是分隔符）。
 */
export function normalizeRoleName(raw) {
  const m = String(raw ?? '').trim().match(/^[^(:\s]+/);
  return m ? m[0] : '';
}

/**
 * R2（repair-1 最重要的正确性修复）：`verdict=` 一旦出现，判决**完全由 token 决定**。
 *
 * T-04 用真实 php/school run 实测到的失真：3 条 `role:reviewer … verdict=needs_revision`
 * 里 2 条被记成 pass、1 条被整条丢弃。根因是 `extractVerdict` 把 token 与整条 detail 拼成
 * haystack 再跑 prose 正则 —— detail 里的「通过」把 `needs_revision` 提升成了 `pass`。
 *
 * R18（repair-2）：解析前**先剥掉包裹字符**再整词匹配。真实 `php/school` RUN.log **第 163 行**
 * 写的是 ```verdict=`needs_revision` ```（反引号 + markdown 粗体包裹），旧正则要求 token 紧跟
 * `=` ⇒ 解析失败，而该分支**无 prose 兜底** ⇒ 判决被静默丢弃；若它是唯一返工证据 ⇒
 * `返工/失败率：0%`（返工率虚低）。剥完仍按整词规则匹配，**剥不出合法 token 仍不计判决**。
 *
 * 映射逐字、大小写不敏感、**整词**匹配（`verdict=pass` / `verdict=pass,` / `verdict=pass）`
 * 都算 pass；`verdict=pass_unverified` **不得**判 pass）。
 * R19：词表补 `conditionally-pass` / `conditional` / `conditionally` → `pass`（该 token 在本仓
 * 真实日志与 `smoke.test.mjs` 里存在；R2 之后它从"记 pass"退化成"不计判决"，属净减少，必须补回）。
 * @returns {'pass'|'rework'|'fail'|''|null} `null` = detail 里没有 `verdict=`（调用点自行决定
 *          是否走 prose）；`''` = 有 `verdict=` 但 token 无法识别 ⇒ **不计判决，绝不回落 prose**。
 */
export const VERDICT_TOKEN_WRAPPERS = '`*_"\'「」『』“”‘’()（）【】[]<>《》 \t';

// 用 Map 而非普通对象：`constructor` / `toString` 这类继承键不会漏成一个"判决"。
export const VERDICT_TOKENS = new Map([
  ['pass', 'pass'],
  ['conditionally-pass', 'pass'], ['conditional', 'pass'], ['conditionally', 'pass'],
  ['needs_revision', 'rework'], ['rework', 'rework'],
  ['fail', 'fail'],
]);

export function verdictFromToken(detail) {
  const s = String(detail ?? '');
  const at = s.search(/verdict=/i);
  if (at < 0) return null;                       // 没有 `verdict=`（注意：`verdict:` 不算）
  let rest = s.slice(at + 'verdict='.length);
  // R18：剥掉前导包裹字符（markdown 粗体 `**`、反引号、全角/半角引号括号、前后空白）
  while (rest.length > 0 && VERDICT_TOKEN_WRAPPERS.includes(rest[0])) rest = rest.slice(1);
  const m = rest.match(/^([A-Za-z_][A-Za-z0-9_-]*)/);
  if (!m) return '';                             // 剥不出合法 token ⇒ 不计判决（不回落 prose）
  return VERDICT_TOKENS.get(m[1].toLowerCase()) ?? '';   // 词表外（含 `constructor` 这类）⇒ 不计判决
}

export function extractRole(detail) {
  let v = (detail.match(/role=(\S+)/) ?? [])[1] ?? '';
  if (v) return v.replace(/[,)]/g, '');
  const hit = ROLE_NAMES.find((r) => new RegExp(`(^|[^a-z])${r}([^a-z]|$)`).test(detail));
  return hit ?? 'unknown';
}

export function extractVerdict(detail) {
  let v = (detail.match(/verdict=(\S+)/) ?? [])[1] ?? '';
  v = v.split('(')[0];
  const hay = v + ' ' + detail;
  if (/fail|失败|报错/.test(hay)) return 'fail';
  if (/rework|返工|重跑|不一致|缺陷/.test(hay)) return 'rework';
  if (/pass|通过|可行|成功|conditionally/.test(hay)) return 'pass';
  return '';
}

/**
 * 「环境/平台类」错误族（C 线第 15 项：返工口径三分账）。
 *
 * 判据只有一条：**换个环境、或没有并发，就不会发生**。这类返工不是团队过程的问题，
 * 混进同一个分子里会让"过程改好了没有"看不出来；反过来，把它们**剔除**出分子又会
 * 让数字与历史不可比 —— 所以本包的做法是**不改上面那个率，只做性质分解**。
 *
 * 未列出的族**一律算"过程类"**（宁可算过程，不放过）：把未知当环境类会系统性地美化指标。
 */
export const ENV_ERROR_FAMILIES = new Set([
  'error:external-write',   // 另一个进程/会话改了同一文件（本仓实测最高频：×9）
  'error:stale-runtime',    // 运行时副本落后于源树
  'error:platform',         // 平台/调度故障
  'error:dispatch',         // 派工失败
  'error:timeout',          // 超时
]);

/**
 * 把一个 RUN.log 的 `error:<子类>` 事件归类。
 * @param type - 事件类型（如 `error:external-write`）。
 * @returns `'env'` = 环境/平台类；`'process'` = 过程类（含全部未列出的族）。
 */
export function classifyErrorFamily(type) {
  return ENV_ERROR_FAMILIES.has(String(type || '')) ? 'env' : 'process';
}
