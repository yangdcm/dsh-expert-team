// preset / skill 铺盘的**归属判定**与**原子铺设**（2026-09-16，用户批准 (a)+(b)）
//
// ── 它修的是什么（真问题，而代价只有一行 warn）────────────────────────────────
// 铺盘是 fire-and-forget：先 `copyDir(SRC, target)`，再写版本戳，最后登记清单。
// 若**中途被打断**（进程被杀 / 磁盘满），`$DSH_HOME/.agent-presets/expert-team` 会留下一个
// **没有戳的半成品**。而归属判定只看两条：① 有我们的版本戳；② 身份启发式
// （preset：`agent.cordis.yml` 含 `tool-subagent-pm`；skill：`SKILL.md` 的 `name` 是 `expert-team`）。
// ⇒ **致命分支**：打断发生在身份文件落地**之前**（例如只拷了 `preset.yml` 就被杀）时，两条判据
// 都不成立 ⇒ 此后每次 `apply()` 都把它当成「**用户的定制**」而**永不覆盖**，只打一行
//   `[expert-team] … 已存在且不是本插件所铺，未覆盖（用户的定制优先）`
// ——**看起来完全正常**。一次中断可能让插件预设再也铺不上，而唯一的信号是那行 warn。
//
// ── 四态判据（本模块的**唯一真源**，纯函数、可断言）──────────────────────────
//   `absent`             目标不存在                              ⇒ 铺（原子）
//   `ours`（含 stale）   带我们的戳，**或**身份可判为本插件产物    ⇒ fresh 直接返回；stale 原子重铺
//   `foreign-complete`   身份**明确不是**我们的，且期望入口文件**齐全** ⇒ **绝不覆盖**（用户的定制优先）
//   `partial-or-unknown` 其余一切（缺文件 / 身份判不出来）         ⇒ **绝不覆盖**，且**显眼报告**
//
// **两个方向都要守**（各有测试盯着，别只守一头）：
//   ① **任何不确定都不许归成 `ours`** —— 宁可多报一次"内容不完整/判不出来、请你决定"，
//      **绝不覆盖可能是真用户定制的东西**（`hasStamp !== true` 且 `identityMatch !== true` ⇒ 不是 ours）；
//   ② 反向也防：**"ours 但 stale"不许错判成 `partial-or-unknown`** —— 那会给用户一个无谓的告警，
//      而"**我们自己的残留**"与"**可能是用户的**"必须分得开。
//
// ── (a) 原子铺设：**不是"完全原子"**（这句必须原样保留，CHANGELOG 同口径）─────────
// 做法：同一父目录下建临时目录 → 把源**完整拷进临时目录**（含版本戳）→ `rm(target)` → `rename(tmp, target)`。
// **残余窗口**：`rm(target)` 与 `rename` 之间若被打断，target 会**不存在**（而不是半成品）——
// 这是**可接受**的（下次加载会重新铺），但**不许**把它说成"完全原子"。它消灭的是
// "**看起来像用户定制的半成品**"这一类，不是"任何时刻都存在一份完整副本"。
//
// ── 为什么文件级原语写在 `lib/host-state-file.js`（而不是本文件）───────────────
// 本仓有 `gate:bypass` 棘轮：`lib/` 与 `client.js` 里的 `writeFile` / `appendFile` / `rename`
// **一处都不许新增**（基线 0），除非它在**受控入口**里。而 `lib/host-state-file.js` 就是
// 「**宿主状态文件**（**工作区之外**）的单一受控入口」（已豁免）。`$DSH_HOME/.agent-presets/…`
// 正是这一类路径 ⇒ 目录级原子换名的原语落在那里，本模块只做**判定 / 状态 / 编排**，
// 不自己碰 `rename`。这样"受控入口"仍然只有两个，棘轮不必开口子。

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { layHostDirAtomic } from './host-state-file.js';

/** 临时目录前缀：**只**清理/识别这个前缀，别的什么都不碰。 */
export const LAY_TMP_PREFIX = '.expert-team-tmp-';

/** 参与铺盘的两类资产。 */
export const LAY_KINDS = Object.freeze(['preset', 'skill']);

/** 四态（判据见文件头）。 */
export const LAY_STATES = Object.freeze(['absent', 'ours', 'foreign-complete', 'partial-or-unknown']);

/** 由四态推出的动作。 */
export const LAY_ACTIONS = Object.freeze(['lay', 'skip-fresh', 'skip-user', 'skip-incomplete']);

/**
 * **显式结果**（2026-09-16 新增，修「铺盘失败却显示已铺设」）。
 *
 * 为什么要它：旧判据只看 `state` 与 `action`，而 `action:'lay'` **既表示"要铺"也表示
 * "铺过"**，失败路径（`lib/command.js` 的 catch）展开 `...plan` 后也带着 `action:'lay'`
 * ⇒ **一次失败被渲染成 ok 级「已铺设」**。结论必须由**写入点给出的结果**承载，
 * 不许由"动作"反推 —— 那正是本仓"界面说得比事实满"那一类缺陷。
 */
export const LAY_OUTCOMES = Object.freeze(['planned', 'succeeded', 'failed', 'skipped']);

/**
 * 非我铺设但**由宿主运行时注册**提供（skill 的默认路径：`RUNTIME_SKILL_REGISTERED`）。
 * 这是**正常**情形，不是"判不出来"，所以它有专属话术、不该常亮 warn。
 */
export const LAY_REASON_RUNTIME_REGISTERED = 'runtime-registered';

/** 铺设失败时 `reason` 的前缀（写入点见 `lib/command.js`）。 */
export const LAY_REASON_FAILED_PREFIX = 'lay-failed:';

/**
 * 归属判定（**纯函数**，唯一真源）。
 *
 * @param {{
 *   exists?: boolean,
 *   hasStamp?: boolean|null,          // null = 读不到/不确定（**不许**当成 ours）
 *   stampVersion?: string|null,
 *   currentVersion?: string,
 *   identityMatch?: boolean|null,     // null = 判不出来（**不许**当成 ours）
 *   expectedEntryFiles?: string[],    // 期望的入口文件（相对路径）
 *   presentEntryFiles?: string[],     // 目标里实际存在的
 * }} facts
 * @returns {{state: string, action: string, stale: boolean, complete: boolean|null, reason: string, missing: string[]}}
 */
export function classifyLayTarget(facts = {}) {
  const exists = facts.exists;
  const hasStamp = facts.hasStamp;
  const identityMatch = facts.identityMatch;
  const currentVersion = facts.currentVersion;
  const expected = Array.isArray(facts.expectedEntryFiles) ? facts.expectedEntryFiles.filter(Boolean) : [];
  const present = new Set(Array.isArray(facts.presentEntryFiles) ? facts.presentEntryFiles.filter(Boolean) : []);
  const missing = expected.filter((n) => !present.has(n));
  // 期望清单为空 ⇒ **判不出来**（complete = null），此时不许把它当"齐全"从而归成 foreign-complete。
  const complete = expected.length === 0 ? null : missing.length === 0;

  if (exists !== true) {
    return { state: 'absent', action: 'lay', stale: false, complete, reason: 'target-absent', missing };
  }
  // ① 带我们的戳 ⇒ **一定是我们的**（不管完整不完整）。这是"我们自己的残留"与"可能是用户的"的分界。
  if (hasStamp === true) {
    const versionChanged = String(stampVersionOr(facts)) !== String(currentVersion == null ? '' : currentVersion);
    const stale = versionChanged || complete !== true;
    return {
      state: 'ours',
      action: stale ? 'lay' : 'skip-fresh',
      stale,
      complete,
      reason: versionChanged ? 'stamp-version-differs' : (complete === true ? 'fresh' : 'stamp-but-incomplete'),
      missing,
    };
  }
  // ② 无戳但**身份明确是**本插件产物（1.2.0 之前的副本没有戳）⇒ 仍是 ours，需要重铺。
  if (identityMatch === true) {
    return { state: 'ours', action: 'lay', stale: true, complete, reason: 'identity-match-without-stamp', missing };
  }
  // ③ 身份**明确不是**我们的，且入口文件**齐全** ⇒ 这就是用户的定制：绝不覆盖。
  if (identityMatch === false && complete === true) {
    return { state: 'foreign-complete', action: 'skip-user', stale: false, complete: true, reason: 'not-ours-and-complete', missing: [] };
  }
  // ④ 其余一切（缺文件 / 身份判不出来 / 读不到）⇒ 不确定 ⇒ **不许归 ours**，也不许当"用户的定制"一笔带过。
  return {
    state: 'partial-or-unknown',
    action: 'skip-incomplete',
    stale: false,
    complete,
    reason: complete === false ? 'entries-missing' : 'identity-unknown',
    missing,
  };
}

/** `stampVersion` 取值（单独抽出来，便于判据被断言）。 */
function stampVersionOr(facts) {
  const v = facts && facts.stampVersion;
  return v == null ? '' : String(v);
}

/**
 * 目标目录里"实际存在哪些入口文件"（判定 completeness 用）。
 * 只读；读不到目录 ⇒ 空数组（调用方据此得到 complete=false，落在"不确定"桶里，方向安全）。
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listEntryNames(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * (a) 原子铺设：**不是"完全原子"**（残余窗口见文件头）。
 *
 * @param {string} srcDir 源目录（包内）
 * @param {string} targetDir 目标目录（`$DSH_HOME/...`，工作区之外）
 * @param {{copyInto: (tmpDir: string) => Promise<void>, dirMode?: number}} options
 *   `copyInto` 由调用方提供（它走 `ARTIFACT.must` 这个受控写入口）——本模块不自己写文件。
 * @returns {Promise<{ok: boolean, reason?: string, target?: string, tmp?: string, replacedState?: string}>}
 */
export async function layDirAtomic(srcDir, targetDir, options = {}) {
  return layHostDirAtomic(srcDir, targetDir, { ...options, tmpPrefix: LAY_TMP_PREFIX });
}

/**
 * 清理**我们自己前缀**的残留临时目录（例如上一次被打断留下的）。
 * **只删这个前缀**：别的名字一律不碰，并如实报告删了什么。
 *
 * @param {string} parentDir
 * @returns {Promise<{ok: boolean, removed: string[], kept: number, reason?: string}>}
 */
export async function cleanStaleLayDirs(parentDir) {
  let names = [];
  try {
    names = await readdir(parentDir);
  } catch {
    return { ok: false, removed: [], kept: 0, reason: 'parent-missing' };
  }
  const removed = [];
  let kept = 0;
  for (const name of names) {
    if (!name.startsWith(LAY_TMP_PREFIX)) { kept += 1; continue; }
    const full = join(parentDir, name);
    try {
      await stat(full);
      await rm(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // 删不掉就留着（下次再试）——**不**因为清理失败而影响铺设本身。
    }
  }
  return { ok: true, removed, kept };
}

// ── 状态（给设置页 / 只读路由如实展示）────────────────────────────────────────
//
// 本仓纪律：**没铺上就必须说没铺上**。`foreign-complete` / `partial-or-unknown` 这两种
// "我们没覆盖"的情形必须能被用户看到，而不是埋在一行 warn 里。

/** @type {{preset: object|null, skill: object|null, at: number}} */
const STATUS = { preset: null, skill: null, at: 0 };

/**
 * 记下一次铺设/判定结果（**只记事实**，不做结论）。
 *
 * @param {'preset'|'skill'} kind
 * @param {{state?: string, action?: string, outcome?: string, reason?: string, target?: string,
 *          pluginVersion?: string, missing?: string[], replaced?: string|null, at?: number}} patch
 */
export function recordLayOutcome(kind, patch = {}) {
  if (LAY_KINDS.indexOf(kind) === -1) return;
  STATUS[kind] = {
    kind,
    state: patch.state || 'unknown',
    action: patch.action || 'unknown',
    // 结果由**写入点**给出；给不出来就如实记 unknown，**绝不用 action 反推**。
    outcome: LAY_OUTCOMES.indexOf(patch.outcome) === -1 ? 'unknown' : patch.outcome,
    reason: patch.reason || '',
    target: patch.target || '',
    // ⚠️ 名字是 pluginVersion：它指"**本条记录针对的插件版本**"，**不是**盘上戳的版本
    // （跳过用户定制/半成品时写入点记空串 —— 那种情形下"版本"根本不适用）。
    pluginVersion: patch.pluginVersion || '',
    missing: Array.isArray(patch.missing) ? patch.missing.slice() : [],
    replaced: patch.replaced == null ? null : String(patch.replaced),
    at: Number.isFinite(patch.at) ? patch.at : Date.now(),
  };
  STATUS.at = Date.now();
}

/**
 * 「由宿主运行时注册提供」的 skill 记录（**正常情形**，无需铺盘）。
 *
 * 单列成函数是为了让这条路径**可被单独断言**：旧实现里 `ensureSkillInstalled()` 在这条
 * 分支上直接 return、**从不写 STATUS** ⇒ `STATUS.skill` 恒为 null ⇒ 界面永远显示
 * 「铺设状态未知」（一盏不会自己灭的 warn 灯）。知识本来就在代码里（relay 那条路会
 * push `skipped:'runtime-registered'`），只是没记进状态。
 *
 * @param {string} target
 * @param {string} pluginVersion
 * @returns {{state: string, action: string, outcome: string, reason: string, target: string, pluginVersion: string}}
 */
export function skillRuntimeRegisteredRecord(target, pluginVersion) {
  return {
    state: 'absent',                       // 我们确实没往盘上写
    action: 'skip-fresh',                  // 也不是"要铺"
    outcome: 'skipped',
    reason: LAY_REASON_RUNTIME_REGISTERED,
    target: String(target || ''),
    pluginVersion: String(pluginVersion || ''),
    missing: [],
    replaced: null,
  };
}

/** 只读快照（设置页与路由共用；**不含**任何用户路径以外的东西）。 */
export function presetLayStatus(opts = {}) {
  const one = (rec) => (rec ? { ...rec, missing: Array.isArray(rec.missing) ? rec.missing.slice() : [] } : null);
  // 兜底：skill 走"运行时注册"时**确实不需要铺盘**。若那条路径没能记进 STATUS（例如
  // 未来某次重构漏了写入点），只要调用方告诉我们它已注册，界面就不该显示"状态未知"——
  // 那是**已知的正常**，不是"判不出来"。反之：拿不到这个事实时仍如实说"未知"。
  const skillRec = STATUS.skill
    || (opts.runtimeSkillRegistered === true
      ? { ...skillRuntimeRegisteredRecord(opts.skillTarget || '', opts.pluginVersion || ''), kind: 'skill', at: Date.now() }
      : null);
  return {
    ok: true,
    prefix: LAY_TMP_PREFIX,
    at: STATUS.at,
    preset: one(STATUS.preset),
    skill: one(skillRec),
    // 给界面的一句话结论**由服务端算出**（单一真源）：客户端只负责显示，
    // 不许在客户端再写一份判据 —— 那就是一个事实两个家。
    display: {
      preset: describeLayOutcome(STATUS.preset),
      skill: describeLayOutcome(skillRec),
    },
  };
}

/** 测试用：清空状态。 */
export function _resetPresetLay() {
  STATUS.preset = null;
  STATUS.skill = null;
  STATUS.at = 0;
}

/**
 * 把记录时刻渲染成人话里的"截至时刻"。
 * **拿不到就说拿不到** —— 不许省略成看起来像"刚刚"的样子（这些字段是快照、不是实时）。
 *
 * @param {unknown} at
 * @returns {string}
 */
function sinceText(at) {
  if (!Number.isFinite(at)) return '记录时刻未知';
  try { return `截至 ${new Date(at).toISOString()}`; } catch { return '记录时刻未知'; }
}

/**
 * 给用户看的**一句话结论**（中英），由状态推出 —— 单一真源，客户端只负责显示。
 *
 * ⚠️ 两条硬纪律（都有测试与变异条目盯着）：
 * ① **失败绝不许说成已铺设**：`outcome==='failed'`（或 `reason` 以 `lay-failed:` 开头，
 *    兼容旧记录）⇒ 只能是 `bad` 级、且文案里**不许出现「已铺设」**，必须带上失败原因。
 *    旧实现只看 `state`+`action`，而失败路径也带 `action:'lay'` ⇒ 把失败渲染成 ok。
 * ② **不确定绝不许说成正常**：没有记录 / 判不出来 ⇒ 仍是 `unknown`（warn），
 *    **只有**"由宿主运行时注册提供"这种**已知的正常**才给 `ok`。
 *
 * @param {{state?: string, action?: string, outcome?: string, reason?: string,
 *          pluginVersion?: string, missing?: string[], at?: number}|null} rec
 * @returns {{level: 'ok'|'warn'|'bad', zh: string, en: string}}
 */
export function describeLayOutcome(rec) {
  const state = rec && rec.state;
  const outcome = (rec && rec.outcome) || '';
  const reason = String((rec && rec.reason) || '');
  const pv = (rec && rec.pluginVersion) || '';
  const when = sinceText(rec && rec.at);

  // ① 失败优先判 —— 不依赖 state/action，也不依赖 outcome 一定存在。
  if (outcome === 'failed' || reason.indexOf(LAY_REASON_FAILED_PREFIX) === 0) {
    const why = reason.indexOf(LAY_REASON_FAILED_PREFIX) === 0
      ? reason.slice(LAY_REASON_FAILED_PREFIX.length)
      : (reason || '原因未记录');
    return {
      level: 'bad',
      zh: `上次铺设：失败 —— ${why}（${when}）`,
      en: `last lay: FAILED — ${why} (${when})`,
    };
  }

  // ② 已知的正常：由宿主运行时注册提供，本来就不需要铺盘。
  if (reason === LAY_REASON_RUNTIME_REGISTERED) {
    return {
      level: 'ok',
      zh: '由宿主运行时注册提供（无需铺盘，不是异常）',
      en: 'provided by the host runtime registry (no files needed; not an anomaly)',
    };
  }

  if (state === 'ours' || state === 'absent') {
    const laid = outcome === 'succeeded' || (rec && rec.action === 'lay');
    const inner = [pv ? `插件版本 ${pv}` : '', when].filter(Boolean).join('，');
    const innerEn = [pv ? `plugin ${pv}` : '', when].filter(Boolean).join(', ');
    return {
      level: 'ok',
      zh: (laid ? '上次铺设：成功' : '上次铺设：无需铺盘') + `（${inner}）`,
      en: (laid ? 'last lay: OK' : 'last lay: nothing to do') + ` (${innerEn})`,
    };
  }
  if (state === 'foreign-complete') {
    return {
      level: 'warn',
      zh: `未覆盖：这个目录是你自己的定制（插件预设让位）（${when}）`,
      en: `not overwritten: this directory is your own customization (the plugin preset stands down) (${when})`,
    };
  }
  if (state === 'partial-or-unknown') {
    const n = rec && Array.isArray(rec.missing) ? rec.missing.length : 0;
    const why = n > 0 ? `缺 ${n} 个入口文件` : '无法判定归属';
    return {
      level: 'bad',
      zh: `未覆盖：目录存在但${why}（${when}；可能是上次铺设被打断，可在下方显式重新铺设）`,
      en: `not overwritten: the directory exists but ${n > 0 ? `${n} entry file(s) are missing` : 'ownership cannot be determined'} (${when}; a previous lay may have been interrupted, you can explicitly re-lay below)`,
    };
  }
  return {
    level: 'warn',
    zh: `铺设状态未知（${when}；没有任何记录，或判据认不出来）`,
    en: `lay state unknown (${when}; no record, or unrecognised state)`,
  };
}
