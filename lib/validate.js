// 校验器与上限（B 线第 8 项「拆 command.js」的第一步：**纯函数、零 IO**）。
//
// 为什么先切这一刀：`/team check` 的七类违规、DAG 三色环检测、容量/轮次上限、schema 只读校验，
// 全部是**纯函数**（给定输入必有确定输出、不碰盘）—— 它们既是门禁的核心，也是最容易单测的部分。
// 切出来之后：① 这些判定可以脱离 5000 行的编排器单独验证；② `lib/interception.js` 注入的
// `validateTaskGraph` 与写侧门禁继续用**同一份**实现（本仓吃过"两套各写一套、迟早不同步"的亏）。
//
// 依赖：`./vocab.js`（词表唯一真源）与 `./artifact-writer.js`（schema guards）。
// 边界：**这里不放编排逻辑**（不读盘、不写盘、不认识 `/team` 命令）—— 只放"给一份数据判对错"。

import { ALLOWED_KINDS, ALLOWED_KINDS_ZH, KIND_ZH, PHASES, kindZh, statusZh, verdictZh, phaseZh } from './vocab.js';
// 日志解析**只此一份**（B 线第 8 项）：validate.js 曾为阶段记账临时抄过一份 `parseLogLineLite`，
// 现已删除并改用真源 —— 两份解析器迟早分叉，而「哪边对」没人说得清。
import { parseLogLine } from './log-parse.js';
import { DEFAULT_SCHEMA_GUARDS } from './artifact-writer.js';

// ── O-3 容量上限（fail-loud，禁止静默截断）────────────────────────────────
//
// 竞品分析 P0 的最后一项。原判断（`GAP-ANALYSIS.md` §5.1 D-5）：本包有 `quota`（runs/maxRuns/deadline）
// 却**没有任何成员/任务数量上限** ⇒ "无上限即无护栏"：一次编排脚本抽风可以派出 200 个成员、
// 生成 5000 条任务，而系统**不会说一个字**。官方有 `TEAM_MEMBER_LIMIT` / `TEAM_TASK_LIMIT` 且**显式报错**。
//
// 设计要点（对齐官方、并遵守本仓的"诚实"取向）：
//   · **fail loud，不静默截断** —— 超限时返回**显式错误码**（`TEAM_MEMBER_LIMIT` / `TEAM_TASK_LIMIT`），
//     而不是"悄悄丢掉多余的"。
//   · **只写拦截 + 读可见**：写入路径（plan 路由 / 任务路由）在**落盘前**拒；
//     `/team check` 对**存量**超限 run **只报告不阻断**（与 L1-4′ 同口径：先落盘再告警，旧 run 不消失）。
//   · **上限可在 config 覆写**：`apply(ctx, config)` 的 `config.limits`，并支持环境变量兜底
//     （`DSH_EXPERT_TEAM_MAX_MEMBERS` / `DSH_EXPERT_TEAM_MAX_TASKS`）。
export const DEFAULT_LIMITS = { maxMembers: 32, maxTasks: 200 };

export const LIMITS = { ...DEFAULT_LIMITS };

export const LIMIT_ENV = { maxMembers: 'DSH_EXPERT_TEAM_MAX_MEMBERS', maxTasks: 'DSH_EXPERT_TEAM_MAX_TASKS' };

/**
 * 上限值解析（**容量上限与轮次上限共用**，唯一口径 —— 两份各写一套迟早不同步，
 * 而且会让"同一条纪律"在两边悄悄分叉）。
 * 只接受 number / 非空 string；`min` 是**下界**：容量用 `0`（"显式禁止任何成员/任务"是合法上限），
 * 轮次用 `1`（"零轮评审"没有意义）。合法值**向下取整**后返回；非法值一律 `null`，由调用方回默认。
 *
 * ⚠️ 只接受 number / 非空 string。**不能用 `Number(v)` 一把收**：`Number(null) === 0`、
 * `Number('') === 0`、`Number([]) === 0` —— JSON 里 `"maxMembers": null` 是极自然的"未设置"写法，
 * 若被判成 0 就会**拒绝每一个计划**（fail-closed 的静默灾难）。这里显式排除。
 */
export function pickLimitValue(v, min) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : null;
}

/**
 * 解析并落地容量上限，优先级 **config > env > base > 内置默认**。
 *
 * `base`（可选）是**设置控制台**存下来的值（F 线）：设置是"用户偏好"，不该压过部署方的
 * `config` 或环境变量（那两者是显式运维动作）—— 所以它排在它们之后、内置默认之前。
 * 语义刻意简单可预测：某一档**给了合法值**就用它；**没给或给了非法值**（负数/NaN/非数字）
 * → **回到下一优先级**（而不是"保留上一次"，那会让 `resolveLimits(null)` 残留上一次的值，
 * 既难测也难解释）。每次都完整重算两个键 ⇒ 同进程内重复调用幂等。
 */
export function resolveLimits(config, base) {
  const fromCfg = (config && typeof config === 'object' && config.limits) || {};
  const env = (typeof process !== 'undefined' && process.env) || {};
  const fromBase = (base && typeof base === 'object') ? base : {};
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    // `min = 0`：容量侧 `0` 是**合法上限**（显式禁止任何成员/任务）
    const cfgV = pickLimitValue(fromCfg[k], 0);
    const envV = pickLimitValue(env[LIMIT_ENV[k]], 0);
    const baseV = pickLimitValue(fromBase[k], 0);
    LIMITS[k] = cfgV !== null ? cfgV : (envV !== null ? envV : (baseV !== null ? baseV : DEFAULT_LIMITS[k]));
  }
  return { ...LIMITS };
}

/**
 * 容量检查（纯函数）。返回 `[{code, message, actual, limit}]`，空数组 = 合规。
 * `code` 用官方同名；`roles` 可为 undefined（只管任务）。
 */
export function capacityViolations(input, limits) {
  const lim = { ...LIMITS, ...(limits || {}) };
  const out = [];
  const roles = Array.isArray(input && input.roles) ? input.roles : null;
  const tasks = Array.isArray(input && input.tasks) ? input.tasks : null;
  if (roles && roles.length > lim.maxMembers) {
    out.push({ code: 'TEAM_MEMBER_LIMIT', actual: roles.length, limit: lim.maxMembers, message: `成员数 ${roles.length} 超过上限 ${lim.maxMembers}（TEAM_MEMBER_LIMIT）—— 未落盘；请减少角色或调高上限（config.limits.maxMembers / DSH_EXPERT_TEAM_MAX_MEMBERS）` });
  }
  if (tasks && tasks.length > lim.maxTasks) {
    out.push({ code: 'TEAM_TASK_LIMIT', actual: tasks.length, limit: lim.maxTasks, message: `任务数 ${tasks.length} 超过上限 ${lim.maxTasks}（TEAM_TASK_LIMIT）—— 未落盘；请拆分 run 或调高上限（config.limits.maxTasks / DSH_EXPERT_TEAM_MAX_TASKS）` });
  }
  return out;
}

// ── P3 收敛硬门禁：maxReviewRounds / maxTestRounds 从**文档口号**变成**代码强制** ──────────
// 事故证据（真实，非假设）：`php/school` 的一个 run —— 68 任务 / **32 条 repair** / maxRound=8，
// 评审每轮都在**新增** finding，永不收敛。根因之一：`maxReviewRounds` / `maxTestRounds` 在
// `lib/command.js` 里**零命中**（只活在 SKILL/PIPELINE/EFFICIENCY/WORKSPACE 文档里当规则喊）
// ⇒ 循环没有硬停止点，只能靠人喊停。
//
// 设计要点（**逐字对齐**上面容量上限的风格，两套上限是同一套纪律）：
//   · **fail loud，不静默截断** —— 写侧命中即返回显式错误码（`REWORK_LOOP_LIMIT`）并**不写盘**；
//   · **只写拦截 + 读可见** —— `/team check` 对**存量**超轮次 run **只报告不阻断**（旧 run 不因新规消失）；
//   · **上限可在 config 覆写** —— `config.limits.maxReviewRounds` / `maxTestRounds`，env 兜底；
//   · **到顶的正确动作是升级用户**（写 `STATE.pendingDecision`），**不是再派一轮修复** —— V2 把
//     "同一 finding 连续两轮未闭环"直接判为**规格歧义**，因为那说明规格没写清楚，再修也修不完。
export const DEFAULT_ROUND_LIMITS = { maxReviewRounds: 3, maxTestRounds: 3 };

export const ROUND_LIMITS = { ...DEFAULT_ROUND_LIMITS };

export const ROUND_LIMIT_ENV = {
  maxReviewRounds: 'DSH_EXPERT_TEAM_MAX_REVIEW_ROUNDS',
  maxTestRounds: 'DSH_EXPERT_TEAM_MAX_TEST_ROUNDS',
};

/**
 * 解析并落地**轮次**上限，优先级 **config > env > 默认**（与 `resolveLimits` 同语义：每次都完整
 * 重算两个键 ⇒ 无粘性、幂等）。
 * 非法值（负数 / 0 / NaN / 非数字 / 空串 / null）一律**忽略并回到默认** —— 这里的 `0` **不**是合法上限
 *（"零轮评审/零轮测试"没有任何意义），而 `Number(null) === 0` 这类强制转换陷阱会把"未设置"变成"禁止"。
 */
export function resolveRoundLimits(config, base) {
  const fromCfg = (config && typeof config === 'object' && config.limits) || {};
  const env = (typeof process !== 'undefined' && process.env) || {};
  const fromBase = (base && typeof base === 'object') ? base : {};
  for (const k of Object.keys(DEFAULT_ROUND_LIMITS)) {
    // `min = 1`：轮次下限是 1 轮 —— `0` / 负数 / 取整后为 0 的小数（如 `0.5`）一律非法 → 回默认
    const cfgV = pickLimitValue(fromCfg[k], 1);
    const envV = pickLimitValue(env[ROUND_LIMIT_ENV[k]], 1);
    const baseV = pickLimitValue(fromBase[k], 1);
    ROUND_LIMITS[k] = cfgV !== null ? cfgV : (envV !== null ? envV : (baseV !== null ? baseV : DEFAULT_ROUND_LIMITS[k]));
  }
  return { ...ROUND_LIMITS };
}

/**
 * 质量任务 kind → 用哪一档轮次上限（**唯一口径**：读侧违规 / 写侧拦截 / METRICS 都走这里，
 * 不得各写一套 —— 三份各写一套的映射迟早不同步）。`review` 与 `requirements`（spec-review）
 * 吃 review 档；`verification` 与 `quality`（自检）吃 test 档。
 */
export const ROUND_LIMIT_OF_KIND = {
  review: 'maxReviewRounds',
  requirements: 'maxReviewRounds',
  verification: 'maxTestRounds',
  quality: 'maxTestRounds',
};

/** 任务轮次（**唯一口径**）：缺失/非法一律视为第 1 轮 —— "没写轮次"不是"第 0 轮"，更不是"超限"。 */
export const roundOf = (t) => { const r = Number(t && t.round); return Number.isFinite(r) && r > 0 ? r : 1; };

/** 质量类任务判定（轮次门禁只管这些 kind）。 */
export const isQualityTask = (t) => !!(t && ROUND_LIMIT_OF_KIND[String((t && t.kind) || '')]);

// ── G3（BL-3）：契约依赖「停滞」从**无人可判**变成**可机判** ─────────────────────────────
//
// 事故形状（真实）：契约类任务（`CONTRACT.md` 那种「先冻结契约再实现」的上游）迟迟不落终态
// （`pending`/`claimed`/`in_progress`），而它的下游已经「**其余依赖全部就绪、只差它一个**」——
// 于是整条 DAG 卡在一个点上，**没有任何地方会报**：`/team check` 只会说「依赖 [X] 未完成，
// 不应进入 Y」，读到的是"下游乱动了"，而不是"上游卡住了"。本族把它变成一条**读侧违规**
// （`CONTRACT_DEP_STALLED`），并要求 **lead 裁决：继续等 / 覆写 / 换人** ——
// 报违规**不自动解锁、不自动覆写**（自动"解锁"等于把并发写事故请回来）。
//
// 设计要点（**逐字对齐 `ROUND_LIMITS` 族**：本仓已有"同一套上限纪律"的既定形状，不发明第二套）：
//   · 上限只写在**常量与 env**（SPEC R7）；优先级 **config > env > 默认**；
//     非法值（`0` / 负数 / `NaN` / 空串 / `null`）一律**忽略回默认**（`pickLimitValue` 的既有语义）。
//   · **读侧只报告不阻断**：存量 run 不因新规消失（与 `roundLimitViolations` 同口径）。
//   · **数据源纪律（宁可少报，不得误报）**：`checkTasks(tasks, phase, state)` 是**纯函数**、
//     看不出时钟 ⇒ **不许凭空算时间**（任务对象没有 `claimedAt`/`updatedAt` 这类字段）。
//     attempt 维永远可用；时间维**只在调用方显式传 `clock.startedAt[<id>]`**（由 `/team check`
//     从 `RUN.log` 派生之类）时才可能触发，取不到就只走 attempt。
//   · **沿用的已知限制（§B2.9 第 4 条裁定）**：阈值只在 `apply(ctx, config)` 解析一次，
//     **没有 per-run 覆写**（与 `ROUND_LIMITS` 一致）。本批**不**改 `lib/command.js` 的
//     import/call（会破坏冻结的 inScope）⇒ **env 是 P0 路径且无需接线**（本 resolver 主体就是读 env）；
//     `config.limits` 的**运行时**接线要加须**先报 lead**。
export const DEFAULT_CONTRACT_STALL_LIMITS = { maxPendingAttempts: 3, maxPendingMs: 1800000 };

export const CONTRACT_STALL_LIMITS = { ...DEFAULT_CONTRACT_STALL_LIMITS };

export const CONTRACT_STALL_LIMIT_ENV = {
  maxPendingAttempts: 'DSH_EXPERT_TEAM_CONTRACT_STALL_ATTEMPTS',
  maxPendingMs: 'DSH_EXPERT_TEAM_CONTRACT_STALL_MS',
};

/**
 * 解析并落地**契约停滞**阈值，优先级 **config > env > 默认**（与 `resolveRoundLimits` 同语义：
 * 每次都完整重算两个键 ⇒ 无粘性、幂等）。
 * `min = 1`：`0` / 负数 / `NaN` / 非数字 / 空串 / `null` 一律**非法 → 回默认** ——
 * "等 0 次就算停滞"没有意义，而 `Number(null) === 0` 这类强制转换陷阱会把"未设置"变成"立刻报违规"。
 */
export function resolveContractStallLimits(config, base) {
  const fromCfg = (config && typeof config === 'object' && config.limits) || {};
  const env = (typeof process !== 'undefined' && process.env) || {};
  const fromBase = (base && typeof base === 'object') ? base : {};
  for (const k of Object.keys(DEFAULT_CONTRACT_STALL_LIMITS)) {
    const cfgV = pickLimitValue(fromCfg[k], 1);
    const envV = pickLimitValue(env[CONTRACT_STALL_LIMIT_ENV[k]], 1);
    const baseV = pickLimitValue(fromBase[k], 1);
    CONTRACT_STALL_LIMITS[k] = cfgV !== null ? cfgV : (envV !== null ? envV : (baseV !== null ? baseV : DEFAULT_CONTRACT_STALL_LIMITS[k]));
  }
  return { ...CONTRACT_STALL_LIMITS };
}

/**
 * 终态状态集合（**唯一口径**）。只有这四个是终态；`pending` / `claimed` / `in_progress` 都算"未终态"。
 * 它同时就是「**依赖已就绪**（不阻塞下游）」的集合 —— 状态冻结门与 G3 共用这一份，不各写一套。
 */
export const TERMINAL_STATUSES = ['completed', 'done', 'failed', 'cancelled'];

/** 是否终态（缺失/非法一律**不是**终态 —— "没写状态"不是"已完成"）。 */
export const isTerminalStatus = (s) => TERMINAL_STATUSES.includes(String(s || ''));

/** 任务尝试次数（**唯一口径**）：缺失/非法一律视为 **0** —— "没写 attempt"不是"试过很多次"（宁可少报）。 */
export const attemptOf = (t) => { const n = Number(t && t.attempt); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

/** finding 标题归一（分组键）：trim + 空白归一 + 截 60 字符。 */
export const normTitle = (x) => String(x).trim().replace(/\s+/g, ' ').slice(0, 60);

/** 单个 finding 元素的可读标题：`title || detail || String(f)`。 */
export const findingText = (f) => (f && typeof f === 'object') ? String(f.title || f.detail || f) : String(f);

/**
 * 读侧违规（**纯函数**）。返回 `[{code,id,actual,limit,message}]`，空数组 = 合规。
 *
 * V1 `REWORK_LOOP_UNESCALATED`：质量类任务已进入第 N 轮（N > 上限）却仍无 `pendingDecision`
 *   ⇒ 返工循环**没人升级给用户** —— 事故里正是这样一轮接一轮地派修复，直到人喊停。
 * V2 `FINDING_REOPENED`：同一 finding（归一标题）出现在**相邻两轮**、且这两轮对应的质量任务
 *   裁决**都不是 `pass`** ⇒ 这不是"还没修完"，而是**规格没写清楚**（每轮都在新增/翻旧账），
 *   正确动作是升级用户裁定，**不是再派一轮修复**。
 *
 * ⚠️ `state` 看不见时调用方**不应调用**本函数（无法判断 pendingDecision，报了就是误报）；
 * `checkTasks` 因此把它放在 `state !== undefined` 分支里。
 */
export function roundLimitViolations(tasks, state, limits) {
  // `limits` 与容量上限共用调用点（SPEC §1.3 传的是 `LIMITS`）⇒ 先铺 ROUND_LIMITS 再让显式值覆盖：
  // 传进来的对象里**没有**轮次键时，轮次口径仍取自 `ROUND_LIMITS`（否则传 LIMITS 会把上限读成 undefined）。
  const lim = { ...ROUND_LIMITS, ...(limits || {}) };
  const arr = Array.isArray(tasks) ? tasks : [];
  const out = [];
  const hasPending = !!(state && state.pendingDecision);
  // ── V1：超过上限却仍未升级用户 ──
  if (!hasPending) {
    for (const t of arr) {
      if (!isQualityTask(t)) continue;
      const kind = String((t && t.kind) || '');
      const n = roundOf(t);
      const m = lim[ROUND_LIMIT_OF_KIND[kind]];
      if (!Number.isFinite(m) || n <= m) continue; // `>` 而非 `>=`：恰好等于上限仍算收敛中
      const id = String((t && t.id) || '');
      out.push({
        code: 'REWORK_LOOP_UNESCALATED', id, actual: n, limit: m,
        message: `[${id}] 已进入第 ${n} 轮（上限 ${m}，${kind}）仍无 pendingDecision ⇒ 返工循环未升级给用户`,
      });
    }
  }
  // ── V2：同一 finding 连续两轮未闭环（规格歧义的信号）──
  // 分组键 = 归一标题；组内记 `round → { kind, allPass }`（allPass = 该轮**含此 finding 的**
  // 质量任务**全部** pass —— 只要有一条没 pass，该轮就算「未闭环」）。
  //
  // ⚠️ **判定域与口径（SG-5 裁决，写死为 AND）**：判定域 = **含该 finding 的任务**（不是"该轮的全部
  // 质量任务"）；该轮**任一**此类任务非 `pass` ⇒ 该轮算「未闭环」（即"该轮全部此类任务都 pass"才闭合）。
  // 选最窄读法的理由：报得最少、误报最低 —— 只有当同一个 finding 真的跨相邻两轮都没被解决时才升级，
  // 不会因为同轮里另一条毫不相干的 finding 没通过就把这一条也判成"规格歧义"。
  // 反过来说：同轮里"一个 pass + 一个 needs_revision"且都带同一 finding ⇒ 该轮**未闭环**（用例 ⑤-6 钉死）。
  const groups = new Map();
  for (const t of arr) {
    if (!isQualityTask(t)) continue;
    const kind = String((t && t.kind) || '');
    const r = roundOf(t);
    const pass = String((t && t.verdict) || '') === 'pass';
    for (const f of (Array.isArray(t && t.findings) ? t.findings : [])) {
      const key = normTitle(findingText(f));
      // 空/无意义标题**不成组**（不臆造）：`''`、字面量 `undefined`/`null`，以及**无 title/detail 的
      // 对象 finding** —— `String({severity:'high'})` 恒为 `[object Object]`，拿它当分组键会把两条毫不
      // 相干的 finding 归成一组、**误报**"规格歧义"（宁可漏报，不可错指；这类 finding 本就没有可比的标题）。
      if (!key || key === 'undefined' || key === 'null' || key === '[object Object]') continue;
      if (!groups.has(key)) groups.set(key, new Map());
      const g = groups.get(key);
      const at = g.get(r) || { allPass: true, kind };
      at.allPass = at.allPass && pass;
      at.kind = kind;
      g.set(r, at);
    }
  }
  for (const [title, g] of groups) {
    const rs = [...g.keys()].sort((a, b) => a - b);
    for (let i = 0; i + 1 < rs.length; i += 1) {
      const r = rs[i], r1 = rs[i + 1];
      if (r1 !== r + 1) continue;                 // 只认**相邻两轮**（1→3 这种跨轮不算连续）
      const a = g.get(r), b = g.get(r1);
      if (a.allPass || b.allPass) continue;       // 任一轮已 pass ⇒ 该 finding 已闭环，不报
      const kind = b.kind || a.kind;
      out.push({
        // `id` 用 finding 标题（这条违规的**主体是 finding**，不是某个任务）
        code: 'FINDING_REOPENED', id: title, actual: r1, limit: lim[ROUND_LIMIT_OF_KIND[kind]],
        message: `[${title}] 连续第 ${r}/${r1} 轮仍未闭环 ⇒ 判为规格歧义，应升级用户裁定而非再派修复`,
      });
    }
  }
  return out;
}

/**
 * R25（SG-3）：V2 的**无输入告警** —— **提示级，不是违规**（绝不进 `violations`，普通 run 不得被它判红）。
 *
 * 为什么需要：V2（`FINDING_REOPENED`）代码正确、可达，但**14 个真实 run 全部命中 0** —— 事故 run 有
 * 16 个质量任务 / 73 条 finding，却是 **73 个互不相同的标题**（0 条跨相邻轮重复）。于是「门禁失明」与
 * 「已收敛」在输出上**完全同形**：用户看到"没有 FINDING_REOPENED"，无从判断是"真收敛"还是"V2 没数据可吃"。
 * 这与 D7（函数写了没人调）、C5（指标没有写路径）同族：**代码写了但没人喂数据**，必须至少让"没数据"显形。
 *
 * 触发（两条同时成立）：
 *   ① 该 run 有 **≥2 个** `verdict !== 'pass'` 的质量任务（说明真的返工过 —— 没返工就不存在"该报没报"）；
 *   ② 全部质量任务的 findings 归一标题里，**没有任何一条出现在 ≥2 个不同轮次**（V2 的输入是"标题跨轮稳定"）。
 * 返 null = 不提示（含"没返工过"与"V2 有输入"两种正常情况）。
 * @returns {string|null} 提示行（不含前缀符号）
 */
export function findingReopenInputMissing(tasks) {
  const arr = Array.isArray(tasks) ? tasks : [];
  const quality = arr.filter((t) => isQualityTask(t));
  const nonPass = quality.filter((t) => String((t && t.verdict) || '') !== 'pass');
  if (nonPass.length < 2) return null; // 没返工过 ⇒ 不存在"该吃却吃不到输入"
  const roundsOfTitle = new Map();    // 归一标题 -> 出现过的轮次集合
  let findings = 0;
  for (const t of quality) {
    const r = roundOf(t);
    for (const f of (Array.isArray(t && t.findings) ? t.findings : [])) {
      findings += 1;
      const key = normTitle(findingText(f));
      if (!key || key === 'undefined' || key === 'null' || key === '[object Object]') continue; // 与 V2 同口径
      if (!roundsOfTitle.has(key)) roundsOfTitle.set(key, new Set());
      roundsOfTitle.get(key).add(r);
    }
  }
  const hasStableTitle = [...roundsOfTitle.values()].some((s) => s.size >= 2);
  if (hasStableTitle) return null; // V2 有输入 ⇒ 它没命中就是真的没命中
  return `FINDING_REOPENED_INPUT_MISSING — 本 run 有 ${nonPass.length} 个非 pass 质量任务、${findings} 条 finding，但没有任何 finding 标题跨轮重复 ⇒ V2（同一 finding 连续两轮未闭环）无输入可判。若确已收敛请忽略；否则说明 finding 编号未跨轮沿用（见 SKILL 的「finding 编号跨轮稳定」）`;
}

/**
 * **契约任务**判定（G3 的判定域，**唯一口径**）。
 *
 * 为什么要单列一个谓词：词表里**没有** `contract` 这个 kind（`lib/vocab.js` 共 10 个 kind：
 * requirements/research/design/implementation/verification/review/repair/integration/work/quality）。
 * 一个 run 里"契约冻结任务"的实际**可观测形态**是 **`kind === 'design' && owner === 'architect'`**
 * （Batch 1 的 B1-02 与 Batch 2 的 T2 都是这条）。所以 G3 判"契约依赖"时就认这个形态，
 * **不臆造一个不存在的 kind**；将来真引入了 `contract` kind，这个谓词里已经留好了扩展点。
 *
 * ⚠️ **`contract` 字段不能当判据**（实测）：本 run **8/8** 条任务都带 `contract{input,output,errors}`
 * 字段（Batch 1 是 11/11）⇒ 拿"有没有 contract 字段"当条件恒为真、**完全不区分**。
 * 因此这里刻意**不用**它 —— 一个恒真的条件不是判据，只是让人以为"判过了"。
 */
export function isContractTask(t) {
  const kind = String((t && t.kind) || '');
  const owner = String((t && t.owner) || '');
  if (kind === 'design' && owner === 'architect') return true;
  return kind === 'contract'; // 扩展点：词表将来引入 `contract` kind 时自动生效（当前词表无此 kind）
}

/**
 * G3（BL-3）读侧违规：**契约依赖停滞**（纯函数）。
 *
 * 判据（四条**同时**成立才报 —— 宁可少报，不得误报）：
 *   ① 上游是**契约任务**（`isContractTask`：`kind:'design' ∧ owner:'architect'`）；
 *   ② 它**未终态**（`pending`/`claimed`/`in_progress`，或状态缺失）；
 *   ③ 它被**至少一个「其余依赖已就绪」的下游**依赖 —— 该下游 ⓐ 自身**未终态**（真的还在等）、
 *      ⓑ `dependsOn` 含本上游、ⓒ 除了本上游之外的**每个**依赖都已终态（缺依赖不算就绪）；
 *   ④ `attempt ≥ maxPendingAttempts`，或（**只在能给出可判起算时刻时**）`now − 起算时刻 ≥ maxPendingMs`。
 *
 * 刻意**不报**的四类（每一类都是假阳性来源）：
 *   · `missing-dependency`（`dependsOn` 指向不存在的 id）—— 那是既有图结构违规的事，**不是停滞**；
 *   · 上游未终态、但**没有一个**"其余依赖已就绪"的下游（下游自己也被别的依赖挡着，或已终态
 *     —— 例如"上游为唯一依赖、下游已 completed"；已终态的下游**没有东西在等**）⇒ 没有任何东西卡在这一点上；
 *   · 上游不是契约任务 ⇒ 本违规（`CONTRACT_DEP_STALLED`）的判定域之外，不由它承担；
 *   · 没到阈值 ⇒ "还在等"本来就是正常状态。
 *
 * @param tasks - 任务数组（`TASKS.json` 的 `tasks`）。
 * @param limits - `{maxPendingAttempts, maxPendingMs}`（可选；缺省取模块级 `CONTRACT_STALL_LIMITS`）。
 * @param clock - `{ startedAt?: { <taskId>: epochMs } }`（可选）。**只有调用方能从 `RUN.log` 之类
 *   派生出起算时刻时才传**；`checkTasks` 是纯函数、看不出时钟，因此**不传**（clock 缺省 ⇒ 只走 attempt 维）。
 *   `now` 取 `Date.now()` —— 因此时间维**只在真的给了 `startedAt[id]` 时才可能触发**（宁可少报，不得误报）。
 * @returns `[{code,id,actual,limit,message}]`，空数组 = 没发现停滞。
 */
export function contractStallViolations(tasks, limits, clock) {
  const lim = { ...CONTRACT_STALL_LIMITS, ...(limits || {}) };
  const arr = Array.isArray(tasks) ? tasks : [];
  const stalled = [];
  const byId = new Map();
  for (const t of arr) {
    const id = String((t && t.id) || '').trim();
    if (id && !byId.has(id)) byId.set(id, t);
  }
  // 时间维的**输入**：只有调用方显式给出 `clock.startedAt[<id>]` 才可能判 —— **没有就不判**。
  const startedAtOf = (clock && typeof clock === 'object' && clock.startedAt && typeof clock.startedAt === 'object')
    ? clock.startedAt
    : null;
  const now = Date.now();
  for (const t of arr) {
    const id = String((t && t.id) || '').trim();
    if (!id) continue;
    if (!isContractTask(t)) continue;              // ① 判定域 = 契约任务
    if (isTerminalStatus(t && t.status)) continue; // ② 已终态 ⇒ 不叫停滞
    const blocked = arr.filter((d) => {
      if (!d || d === t) return false;
      if (isTerminalStatus(d.status)) return false; // ③ⓐ 下游已终态 ⇒ 没有东西在等（"下游已 completed ⇒ 不报"）
      const deps = Array.isArray(d.dependsOn) ? d.dependsOn.map((x) => String(x).trim()) : [];
      if (!deps.includes(id)) return false;         // ③ⓑ 必须真的依赖本上游
      // ③ⓒ「其余依赖已就绪」= 除本上游外每个依赖都终态；**缺依赖（指向不存在的 id）不算就绪**
      // （这正是 `missing-dependency` 不得被判成停滞的实现口径，也与状态冻结门共用同一份终态口径）。
      return deps.every((x) => x === id || isTerminalStatus((byId.get(x) || {}).status));
    });
    if (blocked.length === 0) continue;             // ③ 没有"其余依赖已就绪"的下游 ⇒ 不算停滞（不报）
    const attempt = attemptOf(t);
    const byAttempt = attempt >= lim.maxPendingAttempts;
    let pendingMs = null;
    const startedAt = startedAtOf ? Number(startedAtOf[id]) : NaN;
    if (Number.isFinite(startedAt)) pendingMs = now - startedAt;
    const byClock = pendingMs !== null && pendingMs >= lim.maxPendingMs;
    if (!byAttempt && !byClock) continue;           // ④ 两个判据都没到 ⇒ 还没停滞（继续等是正常的）
    const waiters = blocked.map((d) => String(d.id)).slice(0, 3).join(', ');
    stalled.push({
      code: 'CONTRACT_DEP_STALLED',
      id,
      actual: byAttempt ? attempt : pendingMs,
      limit: byAttempt ? lim.maxPendingAttempts : lim.maxPendingMs,
      message: `[${id}] 契约依赖停滞（CONTRACT_DEP_STALLED）：契约任务仍未终态（${String((t && t.status) || 'pending')}），` +
        `却有 **${blocked.length}** 个下游在等它、且至少一个「其余依赖已就绪」只差它一个（如 ${waiters}）—— ` +
        (byAttempt
          ? `attempt ${attempt} ≥ 上限 ${lim.maxPendingAttempts}`
          : `已停滞 ${Math.round(pendingMs / 1000)}s ≥ 上限 ${Math.round(lim.maxPendingMs / 1000)}s`) +
        '。报违规**不自动解锁、不自动覆写**；请 lead 裁决：**继续等 / 覆写 / 换人**' +
        `（阈值可覆写：config.limits.maxPendingAttempts · ${CONTRACT_STALL_LIMIT_ENV.maxPendingAttempts} / ` +
        `${CONTRACT_STALL_LIMIT_ENV.maxPendingMs}）`,
    });
  }
  return stalled;
}

// ── /team check [<run>]: host-side state-machine + quality-gate validator ──
// Lets the lead/you verify TASKS.json is consistent WITHOUT trusting prompt-following.
// `research` / `design` are first-class kinds because the pipeline's own stages and
// roles use that vocabulary (client.js already renders both labels) — the closed
// enum previously rejected real, healthy runs. `quality` is the leader's self-check kind.
// `ALLOWED_KINDS` / `ALLOWED_KINDS_ZH` 已搬到 `lib/vocab.js`（B 线 11b），且**中文清单由
// `KIND_ZH` 推导**——此前「合法 kind」这一个事实在这里有**三份**（英文 Set、手写中文字符串、
// `KIND_ZH` 的键），加一个 kind 就得记得改三处。
/**
 * Non-blocking taxonomy warnings for an unknown `kind`.
 *
 * An unknown kind is a vocabulary mismatch, not a quality failure: the task is
 * still tracked and its status still flows. Failing the whole gate on it froze
 * healthy runs (T-01…T-06 of 做竞品分析-分析dsh官方的te-145629), so it warns —
 * and says what the task loses (its kind-specific gates cannot apply).
 * @param tasks - task list.
 * @returns warning lines; empty when every kind is known.
 */
export function checkKindWarnings(tasks) {
  const warnings = [];
  for (const t of tasks) if (t.kind && !ALLOWED_KINDS.has(t.kind)) warnings.push(`[${t.id}] 任务类型「${t.kind}」不在词表内（不阻断门禁，但该任务的 kind 专属门禁不生效，等同「${KIND_ZH.work}」）——允许：${ALLOWED_KINDS_ZH}`);
  return warnings;
}

/**
 * 全图任务依赖校验（批 2-2 · L2-2）。
 *
 * 检测三类**结构性**错误 —— 这三类过去都被静默吞掉，代价各不相同：
 *   · `missing-dependency`：dependsOn 指向不存在的 id。
 *       —— 计划路由曾用 `.filter(d2 => ids.has(d2))` **直接删掉**（用户以为依赖生效，其实没有）；
 *       —— `checkTasks` 曾 `if (!dep) continue` **静默放行**（门禁出现盲区）。
 *   · `duplicate-id`：重复 id 会让 `byId` 相互覆盖、依赖指向歧义。
 *   · `cycle`：环路会让 implement 阶段整体死锁（环内任务永远 ready=false），
 *       而 `/team check` 此前**不报任何违规** —— 表现为面板「待开始」永久不动。
 *
 * 纯函数（不碰 IO），便于单测与变异验证。
 * @returns `{ok, errors:[{code, detail}]}`
 */
export function validateTaskGraph(tasks) {
  const errors = [];
  const arr = Array.isArray(tasks) ? tasks : [];
  const idCount = new Map();
  for (const t of arr) {
    const id = String((t && t.id) || '').trim();
    if (!id) { errors.push({ code: 'missing-id', detail: '存在没有 id 的任务' }); continue; }
    idCount.set(id, (idCount.get(id) || 0) + 1);
  }
  for (const [id, n] of idCount) {
    if (n > 1) errors.push({ code: 'duplicate-id', detail: `任务 id 重复 ${n} 次：${id}` });
  }
  const idSet = new Set(idCount.keys());
  const adj = new Map();
  for (const t of arr) {
    const id = String((t && t.id) || '').trim();
    if (!id || !idSet.has(id)) continue;
    const deps = (Array.isArray(t.dependsOn) ? t.dependsOn : []).map((d) => String(d).trim()).filter(Boolean);
    for (const d of deps) {
      if (d === id) errors.push({ code: 'self-dependency', detail: `[${id}] 依赖自身` });
      else if (!idSet.has(d)) errors.push({ code: 'missing-dependency', detail: `[${id}] 依赖不存在的任务 [${d}]` });
    }
    if (!adj.has(id)) adj.set(id, []);
    for (const d of deps) {
      if (d !== id && idSet.has(d) && !adj.get(id).includes(d)) adj.get(id).push(d);
    }
  }
  // 三色 DFS 检环（沿 dependsOn 边走）
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...idSet].map((id) => [id, WHITE]));
  const stack = [];
  const reported = new Set();
  const visit = (id) => {
    color.set(id, GRAY); stack.push(id);
    for (const d of (adj.get(id) || [])) {
      const c = color.get(d);
      if (c === GRAY) {
        const at = stack.indexOf(d);
        const cyc = (at >= 0 ? stack.slice(at) : [d]).concat(d);
        const key = [...new Set(cyc)].sort().join('|'); // 同一环只报一次
        if (!reported.has(key)) {
          reported.add(key);
          errors.push({ code: 'cycle', detail: `检测到循环依赖：${cyc.join(' → ')}` });
        }
      } else if (c === WHITE) {
        visit(d);
      }
    }
    stack.pop(); color.set(id, BLACK);
  };
  for (const id of idSet) if (color.get(id) === WHITE) visit(id);
  return { ok: errors.length === 0, errors };
}

/**
 * C4：把**写入点的 schema 告警**接进 `/team check`（只读校验，复用同一份 guard）。
 *
 * 原先 guard 只在**写入那一刻**经 `schema-warn` 事件上报（`console.warn` + 活动流）⇒
 * 一份**存量**违规工件（旧 run、或被别的写入路径改脏的文件）`/team check` 永远查不出来 ——
 * 「少了东西却没有任何信号」正是这个插件最危险的失败模式。
 * 这里用**同一份** `DEFAULT_SCHEMA_GUARDS` 对磁盘上的对象做只读校验，口径与写入侧一致：
 * **只告警、不阻断**（写侧也不硬拒，见 L1-4′ 仲裁）。
 */
export function schemaViolations(stateObj, tasksObj) {
  const out = [];
  const run = (name, obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const guard = DEFAULT_SCHEMA_GUARDS[name];
    if (typeof guard !== 'function') return;
    for (const m of guard(obj) || []) out.push(`[schema ${name}] ${m}`);
  };
  try { run('STATE.json', stateObj); } catch { /* best-effort */ }
  try { run('TASKS.json', tasksObj); } catch { /* best-effort */ }
  return out;
}

export function checkTasks(tasks, phase, state) {
  const byId = {}; tasks.forEach((t) => { byId[t.id] = t });
  const violations = [];
  // 批 2-2（L2-2）：先把**图结构**错误报出来 —— 过去 missing/duplicate/cycle 全被静默吞掉
  for (const e of validateTaskGraph(tasks).errors) violations.push(`[图结构] ${e.detail}`);

  // 批 2-5（L1-5′）断链即违规：质量类任务（review/verification/requirements/quality）判 failed 或
  // needs_revision 后，**必须**同时留下"接续"——要么有后继 repair 任务，要么已升级为用户决策
  // （pendingDecision）。过去两者都没有时，修复链就断在那里而 /team check 不报任何违规：
  // 表现为评审判不过、却没人被派去修、也没人被告知要拍板。
  // 仅在能看见 state 的调用点启用（否则无法判断 pendingDecision，会产生误报）。
  if (state !== undefined) {
    const QUALITY_KINDS = new Set(['requirements', 'verification', 'review', 'quality']);
    const hasPending = !!(state && state.pendingDecision);
    if (!hasPending) {
      for (const t of tasks) {
        const kind = String((t && t.kind) || '');
        const st2 = String((t && t.status) || '');
        const vd = String((t && t.verdict) || '');
        const bad = st2 === 'failed' || vd === 'needs_revision' || vd === 'fail';
        if (!QUALITY_KINDS.has(kind) || !bad) continue;
        const id = String((t && t.id) || '');
        // 「接续」的判定必须**忠于 SKILL 约定**：`repair-N` 是**依赖指向被审实现**、而**不依赖**
        // 那个 failed review（failed 是终态，不该 gate 住修复）。所以不能用 `dependsOn(failedId)`
        // 当唯一判据 —— e2e 场景 rv-1(failed) ← repair-1(依赖 be-1) ← rv-2 就是这么连的，只认依赖方向会误报。
        // 三种形式任一成立即视为已接续：
        //   ① repair 任务显式依赖该失败任务（严格形式，保留支持）
        //   ② repair 任务的 round **大于**失败任务的 round（repair-N 响应第 N 轮评审 —— SKILL 约定）
        //   ③ 存在更高 round 的质量类后续任务（独立 review-N+1 / 重新验证）
        // 轮次口径**唯一来源**是模块级的 `roundOf`（SPEC §1.2：不得各写一套 —— 这里原有第二份实现）
        const failedRound = roundOf(t);
        const successor = tasks.some((x) => {
          const xid = String((x && x.id) || '');
          if (!xid || xid === id) return false;
          const isRepair = String((x && x.kind) || '') === 'repair' || /^repair[-_]/i.test(xid);
          const deps = Array.isArray(x && x.dependsOn) ? x.dependsOn.map(String) : [];
          if (isRepair && deps.includes(id)) return true;
          if (isRepair && roundOf(x) > failedRound) return true;
          if (QUALITY_KINDS.has(String((x && x.kind) || '')) && roundOf(x) > failedRound) return true;
          return false;
        });
        if (!successor) {
          violations.push(`[${id}] ${KIND_ZH[kind] || kind}任务已判「${vd || st2}」但**既无后继 repair 任务、也无 pendingDecision**（断链：修复链没接上、也没升级给用户拍板）`);
        }
      }
    }
  }
  // P3 收敛硬门禁（SPEC §1.3）：返工循环的**读侧**违规，接在既有断链检查之后 —— 同点同口径，
  // 也**同样只在能看见 state 时**启用（看不见 pendingDecision 就判不了"是否已升级用户"，报了就误报）。
  // 只报告不阻断（存量 run 不因新规消失）；本函数返回值仍是 `string[]`（既有契约不变）。
  if (state !== undefined) {
    violations.push(...roundLimitViolations(tasks, state, LIMITS).map((v) => v.message));
    // G3（BL-3）契约依赖停滞：冻结契约的 `judgement.wirePoint` = **本分支内、`roundLimitViolations`
    // **之后**，`violations.push(...map(v => v.message))`，与既有 `[图结构]`/断链/轮次**同点同口径**。
    // ⚠️ 阈值在这里**现算**（`resolveContractStallLimits()` ⇒ env > 默认）：这样**光设环境变量**就生效，
    // 不必依赖调用方先调一次 resolver —— 一个"写好了没人调"的 resolver 正是本仓登记过的 D7。
    // `config.limits` 的运行时接线**本批不做**（须改 `lib/command.js`，先报 lead）。
    // **只报告不阻断**：不自动解锁、不自动覆写；存量 run 不因新规消失。
    const stalled = contractStallViolations(tasks, resolveContractStallLimits());
    violations.push(...stalled.map((v) => v.message));
  }
  // Phase freeze gate: once implementation has started, a task that is READY
  // (all dependencies terminal) but still `pending` means the lead dispatched
  // and never wrote the status back — the FLOAT panel would show 待开始 forever.
  const frozenPhase = ['implement', 'review', 'test', 'deliver'].includes(phase || '');
  for (const t of tasks) {
    const st = t.status || 'pending';
    // ownership gate (log-driven): verification → qa, review → reviewer,
    // quality (leader's own kind for 安全自检/评审) → qa|reviewer, never implementers.
    if ((t.kind === 'verification' || t.kind === 'quality') && t.owner && !['qa', 'reviewer'].includes(t.owner)) violations.push(`[${t.id}] 质量任务(${kindZh(t.kind)})归属 ${t.owner}（应为 qa/reviewer）`);
    if (t.kind === 'review' && t.owner && t.owner !== 'reviewer') violations.push(`[${t.id}] 评审任务归属 ${t.owner}（应为 reviewer）`);
    if (st === 'completed' || st === 'done') {
      if ((t.kind === 'review' || t.kind === 'requirements') && t.verdict !== 'pass') violations.push(`[${t.id}] ${kindZh(t.kind)}任务为${statusZh(st)}但裁决为「${verdictZh(t.verdict)}」（须通过）`);
      if ((t.kind === 'implementation' || t.kind === 'repair') && (!Array.isArray(t.verify) || t.verify.length === 0)) violations.push(`[${t.id}] 状态为${statusZh(st)}但缺少 verify 命令`);
      if (Array.isArray(t.changedPaths) && Array.isArray(t.inScope) && t.inScope.length) {
        const bad = t.changedPaths.filter((p) => !t.inScope.some((s) => { const r = s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'); try { return new RegExp('^' + r + '$').test(p) || new RegExp('^' + r).test(p); } catch { return false; } }));
        if (bad.length) violations.push(`[${t.id}] 越界改动：${bad.join(', ')}（inScope: ${t.inScope.join(', ')}）`);
      }
    }
    if (frozenPhase) {
      const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
      // 「依赖已就绪」= 依赖是终态（或用词口径见 `TERMINAL_STATUSES`）—— 与 G3 的
      // `contractStallViolations` 共用**同一份**判据，不各写一套（这份数组此前在这里是**第二份**拷贝）。
      const ready = deps.every((d) => { const dep = byId[d]; return !dep || isTerminalStatus(dep.status) });
      if (st === 'pending' && ready) violations.push(`[${t.id}] 已进入${phaseZh(phase)}阶段但仍为待开始（依赖已就绪、状态未回写=状态冻结）`);
      if (st === 'in_progress' && phase === 'deliver') violations.push(`[${t.id}] 交付阶段仍有任务在进行中`);
    }
    // dependency gate: only upstream completed unlocks; failed/cancelled never unlock
    const depList = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    for (const d of depList) {
      const dep = byId[d];
      if (!dep) continue;
      if (['failed', 'cancelled'].includes(dep.status) && ['in_progress', 'claimed', 'completed', 'done'].includes(st)) violations.push(`[${t.id}] 依赖 [${d}] 已${statusZh(dep.status)}，但它仍为${statusZh(st)}（失败不解锁下游）`);
      if (!['completed', 'done'].includes(dep.status) && ['in_progress', 'claimed', 'completed'].includes(st)) violations.push(`[${t.id}] 依赖 [${d}] 为${statusZh(dep.status)}（未完成），不应进入${statusZh(st)}`);
    }
  }
  return violations;
}

// ── E2 的**记账前提**：阶段事件缺失必须可机判（2026-09-13 由真实数据点名）────────────────
//
// 背景（两次真实 run 的实测）：SKILL §7.33 ① 要求"每个阶段流转都必须写 `phase:<阶段名>`，尤其
// 不能漏 review/test"，但实测里 **clarify 走完了却一条 phase 事件都没有**，于是 METRICS 的
// 「收尾预算」只能显示"分不开" —— 机制在、**采纳度不在**，而漏记这件事**没有任何地方会报**。
// 本仓的判据很直白：**写了没人执行、又没人发现，等于没有这条规则。**
//
// 判定刻意收得很窄（只报无歧义的两类，避免把门禁变成噪声）：
//   R1（硬）：STATE.phase 已是 `review`/`test`/`deliver`，而日志里**既无** `phase:review`
//            也**无** `phase:test` ⇒ 冻结观测点缺失，E2 的收尾预算算不出来。
//   R2（硬）：日志里有角色事件（`role:*`）却**一条 `phase:*` 都没有** ⇒ 整条流水线零阶段记账。
//
// 解析口径**故意与聚合器同形**（`phase:<阶段名>`；兼容 `phase:started/completed — design …`
// 取详情里第一个 ASCII 词；不在 `PHASES` 词表内一律不计）。`phase-accounting.test.mjs` 里有一条
// **两套实现一致性**断言盯着它，防止哪天悄悄分叉。

/**
 * 从 RUN.log 文本里取出**已记账的阶段集合**（按流水线词表过滤）。
 * @param logText - RUN.log.md 全文。
 * @returns `Set<string>`（可能为空 —— 那就是"零记账"）。
 */
export function loggedPhases(logText) {
  const out = new Set();
  for (const line of String(logText || '').split('\n')) {
    const ev = parseLogLine(line);
    if (!ev) continue;
    const idx = ev.type.indexOf(':');
    if (idx < 0 || ev.type.slice(0, idx) !== 'phase') continue;
    const head = ev.type.slice(idx + 1).split(':')[0];
    let name = head;
    if (!head || head === 'started' || head === 'completed') {
      const dm = String(ev.detail || '').match(/([A-Za-z][A-Za-z0-9_-]*)/);
      if (!dm) continue;
      name = dm[1];
    }
    if (PHASES.includes(name)) out.add(name);
  }
  return out;
}

/**
 * 阶段记账违规（**纯函数**：给日志全文与当前阶段，判"该记的记了没有"）。
 * @param logText - RUN.log.md 全文。
 * @param phase - STATE.phase。
 * @returns `string[]`（空数组 = 没问题或还不到判的时候）。
 */
export function phaseAccountingViolations(logText, phase) {
  const text = String(logText || '');
  if (!text.trim()) return [];
  const seen = loggedPhases(text);
  const out = [];
  const cur = String(phase || '');
  const frozen = ['review', 'test', 'deliver'].includes(cur);
  // 零记账时**只报 R2**（更根本的那条）：R1 与 R2 那时是同一个根因，两条一起报只是噪声。
  if (frozen && seen.size > 0 && !seen.has('review') && !seen.has('test')) {
    out.push(`[阶段记账] 已进入「${phaseZh(cur)}」却**没有** \`phase:review\` / \`phase:test\` 事件 ⇒ 代码冻结的观测点缺失，METRICS 的「收尾预算」只能显示"分不开"（SKILL §7.33 ①）。请补记实际时刻，**不要**事后编一条。`);
  }
  const hasRole = /\n\s*-\s*\[[^\]]+\]\s+role:/.test(text) || /^\s*-\s*\[[^\]]+\]\s+role:/.test(text);
  if (hasRole && seen.size === 0) {
    out.push('[阶段记账] 日志里已有角色事件，却**一条 `phase:*` 都没有** ⇒ 整条流水线零阶段记账（阶段覆盖与收尾预算都会失真）。SKILL §7.33 ①：每次阶段流转都要追加一行。');
  }
  return out;
}

// ── 工件单源化：`AUTHORITY.md` 的权威表校验（设计稿 §十二 第 2 步）─────────────────────
//
// 依据（真实数据）：某真实 run 的 14 条返工里 **9 条（64%）**命中「同一事实多份拷贝 / 多写者 /
// 口径漂移」，其中一条原文是「CONTRACT 单写者收口（**并发事故收敛** + 6 处已核实缺陷）」——
// **事故发生了才去收口**。本校验的目的是把它提到**事前**：先声明唯一权威与唯一写者，再写。
//
// ⚠️ 只在 `AUTHORITY.md` **存在时**校验（老 run 没有这个文件，一律报"缺声明"会制造满屏假阳性，
// 而本仓的教训是**大量假阳性会让门禁被整体忽略**）。因此"删掉文件以逃避校验"是**已知缺口**，
// 如实记在这里，而不是假装它不存在。

/** 核心工件：只要它在 run 里存在，就必须出现在权威表的某一行（否则它没被纳入单源化治理）。 */
export const AUTHORITY_CORE_FILES = ['SPEC.md', 'CONTRACT.md', 'PRD.md', 'RULES-CORE.md'];

/**
 * 解析 `AUTHORITY.md` 的权威表。
 * @returns `{ rows: [{ line, category, file, writer, allowed }], malformed: [{ line, text }] }`
 */
export function parseAuthorityRows(text) {
  const rows = [];
  const malformed = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!/^\s*\|.*\|\s*$/.test(raw)) continue;
    const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    // 表头与分隔行（先判，否则 `|---|` 这种单列行会被当成"列数不足"误报）
    // ⚠️ **表头用「列标签」判，不用第 1 列的措辞判**（2026-09-17 Batch 3 裁决）：模板表头已从
    // 「事实类别」改成「事实」（D3 的根因就是旧表头诱导人把**类别标签**写进第 1 列）。若只把跳过条件
    // 放宽成 `/^(?:事实类别|事实)$/`，一条**真实数据行**（事实名恰为 `事实`/`事实类别`）会被静默吞掉
    // ⇒ 那是**削弱数据行判据**。改用稳定的**列标签**（第 2 列 `唯一权威文件` + 第 3 列 `唯一写者`）
    // 判表头：任何真实数据行都不可能在这两格写这两个词 ⇒ **只放宽"哪一行算表头"，判据强度不变**；
    // 同时**保留**旧的 `/^事实类别$/` 以向后兼容既有表（`authority.test.mjs` 的 `HEAD` 仍是旧表头）。
    if (/^事实类别$/.test(cells[0]) || (cells[1] === '唯一权威文件' && cells[2] === '唯一写者')) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    // 模板里留的空行（整行都空）不算数据行，也不算错
    if (cells.every((c) => c === '')) continue;
    if (cells.length !== 4 || cells.some((c) => c === '')) {
      malformed.push({ line: i + 1, text: raw.trim() });
      continue;
    }
    rows.push({ line: i + 1, category: cells[0], file: cells[1], writer: cells[2], allowed: cells[3] });
  }
  return { rows, malformed };
}

/** 从「唯一权威文件」单元格里取出文件名（允许 `SPEC.md §术语表` 这种带小节的写法）。 */
export function authorityFileName(cell) {
  const s = String(cell || '').trim();
  const m = s.match(/^[`"']?([^\s`"'§｜|]+\.(?:md|json|ya?ml|txt))[`"']?/i);
  return m ? m[1] : '';
}

/**
 * 权威表违规（**纯函数**：给文本 + run 里实际存在的文件 + 合法角色，判"声明有没有问题"）。
 * @param args.authorityText - `AUTHORITY.md` 全文（空/缺 ⇒ 返回 `[]`，见上方说明）。
 * @param args.presentFiles - run 目录里真实存在的文件名列表。
 * @param args.knownRoles - 编制里合法的角色 id 列表。
 * @returns `string[]`（每条以 `[单源化]` 开头）
 */
export function authorityViolations({ authorityText, presentFiles = [], knownRoles = [] } = {}) {
  const text = String(authorityText || '');
  if (!text.trim()) return [];
  const out = [];
  const { rows, malformed } = parseAuthorityRows(text);
  for (const m of malformed) {
    out.push(`[单源化] AUTHORITY.md 第 ${m.line} 行**列数/内容不完整**（必须 4 列且都非空）：\`${m.text.slice(0, 80)}\``);
  }
  if (!rows.length) {
    out.push('[单源化] AUTHORITY.md 里**一条有效声明都没有**（表是空的或只有表头）⇒ 单源化没有任何约定，等于没做');
  }
  const present = new Set((presentFiles || []).map((f) => String(f).trim()));
  const known = new Set((knownRoles || []).map((r) => String(r).trim().toLowerCase()));
  const byFile = new Map();   // file -> Set(writer)
  const byCategory = new Map(); // category -> Set(file)
  for (const r of rows) {
    // ⓪ 模板没改（示例行留着）—— 不判出来，"把模板原样交上去"就能混过校验
    if (/示例/.test(r.category)) {
      out.push(`[单源化] AUTHORITY.md 第 ${r.line} 行**还是模板里的示例行**（未替换成本 run 的真实事实）`);
    }
    const fname = authorityFileName(r.file);
    if (!fname) {
      out.push(`[单源化] AUTHORITY.md 第 ${r.line} 行的「唯一权威文件」里**读不出文件名**：\`${r.file.slice(0, 60)}\``);
    } else if (!present.has(fname)) {
      out.push(`[单源化] AUTHORITY.md 第 ${r.line} 行声明权威文件 \`${fname}\`，但**本 run 里没有这个文件**（声明指向了不存在的权威）`);
    } else {
      if (!byFile.has(fname)) byFile.set(fname, new Set());
      byFile.get(fname).add(r.writer);
    }
    if (known.size && !known.has(String(r.writer).toLowerCase())) {
      out.push(`[单源化] AUTHORITY.md 第 ${r.line} 行的写者 \`${r.writer}\` **不是编制里的角色**（编制：${[...known].slice(0, 8).join('/')}…）`);
    }
    if (!byCategory.has(r.category)) byCategory.set(r.category, new Set());
    if (fname) byCategory.get(r.category).add(fname);
  }
  // 同一权威文件两个写者 ⇒ 正是"并发写同一份文件"事故的形状
  for (const [f, writers] of byFile) {
    if (writers.size > 1) {
      out.push(`[单源化] \`${f}\` 声明了 **${writers.size} 个写者**（${[...writers].join(' / ')}）⇒ 单写者不成立，` +
        '而"两个角色并发写同一份文件"正是本仓实测过的返工事故形态（T29「并发事故收敛」）');
    }
  }
  // 同一事实类别指向两个不同权威 ⇒ 自相矛盾
  for (const [cat, fs] of byCategory) {
    if (fs.size > 1) {
      out.push(`[单源化] 事实类别「${cat.slice(0, 40)}」指向了 **${fs.size} 个不同的权威文件**（${[...fs].join(' / ')}）⇒ 权威必须唯一`);
    }
  }
  // 核心工件必须被纳入治理
  const declared = new Set([...byFile.keys()]);
  for (const core of AUTHORITY_CORE_FILES) {
    if (present.has(core) && !declared.has(core)) {
      out.push(`[单源化] 本 run 存在 \`${core}\`，但它**没有出现在权威表的任何一行**里 ⇒ 没被纳入单源化治理，迟早与别处分叉`);
    }
  }
  return out;
}

// ── 返工成因：**单源化类占比**（设计稿 §十二 的验收指标）──────────────────────────────
//
// 为什么单列这一格：真实数据里 14 条 repair 有 **9 条（64%）** 的标题命中「单源化 / 唯一权威 /
// 单写者 / 同源漂移 / 口径」这类词，而它们**散落在普通 repair 计数里**，看不出"返工的主因是什么"。
// §十二 的验收标准就是这一格：**下一个真实 run 从 64% 降到 ≤30%**。
//
// ⚠️ 口径如实说明：这是**标题关键词**判定，是**下界近似**（写得含蓄的返工不会被算进来）——
// 宁可少算不可多算，避免把这条指标做成"想降就能降"。要更准得靠人工在 RETRO 里归类。

/** 单源化类返工的关键词（与 SKILL 规则 34/35 的用语一致）。 */
export const SINGLE_SOURCE_WORDS = ['单源化', '唯一权威', '单写者', '同源', '漂移', '口径', '逐值一致', '唯一化'];

/** 这条返工是不是"单源化类"（按标题/摘要判定）。 */
export function isSingleSourceRework(task) {
  const s = `${(task && task.title) || ''} ${(task && task.detail) || ''} ${(task && task.summary) || ''}`;
  return SINGLE_SOURCE_WORDS.some((w) => s.includes(w));
}

/**
 * 统计返工里"单源化类"的占比。
 * @param tasks - 任务数组（只数 `kind === 'repair'`）。
 * @returns `{ repairs, singleSource, share }`（`share` 为 0..1；无返工时为 `null` —— **不编造 0%**）
 */
export function singleSourceShare(tasks) {
  const reps = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.kind === 'repair');
  const ss = reps.filter(isSingleSourceRework).length;
  return { repairs: reps.length, singleSource: ss, share: reps.length ? ss / reps.length : null };
}
