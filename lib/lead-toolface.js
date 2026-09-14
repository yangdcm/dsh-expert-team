// lead 工具面（A 线 · token 成本治理）· **纯函数，零宿主依赖**。
//
// ── 为什么要收 lead 的工具面 ────────────────────────────────────────────────
// 对真实会话做全量遥测审计的结论（一次性脚本，未随包发布）：
//   · lead 累积上下文的 **89%~98% 是工具结果**，其中 `read` + `bash` + `edit` 约占 **93%**；
//     真实用户需求只占 2%~11%。
//   · 上下文首次越过 10 万 tokens 只发生在全程 **第 1%~2% 的步**，而**越线之后**的步数
//     贡献了 **97%** 的总 prompt 成本 —— 贵在"带着大上下文反复走"，不在"上下文变大"。
//   · 最贵的 run 里 **lead 占该 run prompt 总量的 84%**（另一个 92%），而它 3,244 次工具调用里
//     `subagent` 派工只有 11 次。
// ⇒ 杠杆不是"少说话"（输出 tokens 只占总量的 0.34%），而是**让执行类工具默认不在 lead 手上**。
//
// ── 机制（已由宿主源码闭环证明，不是推断）────────────────────────────────
// 给 **lead 自己的 agent scope** 施加 `agent.ctx.tools.restrict({deny})` 即可。安全性依据：
//   `dsh-subagent.applyChildComposition` → `agentPresets.composeFrom(childCtx, parent.ctx)`
//     → `standingMountFor(parentCtx)` = `scopeParentOf(parentAgentKey)`（= preset 常驻作用域）
//     → `bindScopeParent(childKey, standingKey)` → `dsh-scope: scopeParents.set(childKey, standingKey)`
//   `dsh-scope.scopeChainOf()` 沿 `scopeParents` 向上走 ⇒ `scopeChainOf(child) = [child, standing, …]`。
//   **lead 的 agent 作用域不在子级的祖先链上** ⇒ 收 lead 不会波及角色子代理。
//   （旁证：本 preset 的 `toolFilter: deny: [bash]`（pm/architect）走的正是同一行代码。）
//
// ── 本模块只做"算出该 deny 什么"，不碰宿主 ────────────────────────────────
// 施加动作在接线处（agent setup 阶段，照宿主自己的时序），本模块保持纯函数以便单测。
//
// ── 两条本仓纪律，写死在返回值形状里 ──────────────────────────────────────
//   ① **两种零必须可区分**：`deny: []` 可能是"真的没什么可收"，也可能是"我根本不知道宿主有哪些工具"。
//      两者**不能长得一样** ⇒ 用 `status` 区分（`ready` / `nothing-to-deny` / `no-known-names`）。
//   ② **不静默**：本该存在的名字缺席（核心工具、本平台 shell）必须进 `unexpectedAbsent` 并出声；
//      只有"另一个平台的 shell"缺席是预期的，不当作异常。

import path from 'node:path';

/** 候选：lead 默认不该持有的**执行/探索**类全局工具名（真实名字取自宿主各 tool 包）。 */
export const LEAD_DENY_CANDIDATES = Object.freeze(['bash', 'pwsh', 'write', 'edit', 'grep', 'glob']);

/**
 * 候选里**每个平台都应当存在**的那些。
 * 它们缺席是异常（插件组合变了 / 没装全），必须出声 —— 与"另一个平台的 shell 缺席"区分开。
 */
export const CORE_DENY_TOOLS = Object.freeze(['write', 'edit', 'grep', 'glob']);

/** shell 工具是**平台二选一**的（preset 里 `disabled:` 按平台切）；同时写两个就会让 `restrict()` 抛错。 */
export const SHELL_TOOL_BY_PLATFORM = Object.freeze({ win32: 'pwsh', posix: 'bash' });

/**
 * lead **保留**但受路径约束的只读工具：只允许读工件目录内的东西。
 * 为什么不是直接 deny：lead 必须能读 SPEC/PLAN/REVIEW 才能做阶段门控与裁决；
 * 要挡的是"整读大源码"这种**探索性**读取（那属于角色子代理的活）。
 */
export const LEAD_GUARDED_READ_TOOLS = Object.freeze(['read', 'read_image']);

/** 工件目录名（相对工作区根）。lead 读这个子树以内的路径一律放行。 */
export const ARTIFACT_SUBDIR = 'team';

/** 归一平台标识：只关心"是不是 Windows"。 */
export function normalizePlatform(platform) {
  const p = String(platform ?? '').toLowerCase();
  return p === 'win32' || p === 'windows' ? 'win32' : 'posix';
}

/**
 * 算出 lead 该 deny 哪些工具。
 *
 * @param {object} input
 * @param {string} [input.platform] - `process.platform`
 * @param {Iterable<string>} [input.knownNames] - 宿主 `tools.view(scope).restrictableNames`
 * @returns {{deny: string[], absent: string[], unexpectedAbsent: string[], expectedShell: string,
 *            expectedShellPresent: boolean, effective: boolean, status: string, notes: string[]}}
 */
export function planLeadToolFace({ platform, knownNames } = {}) {
  const expectedShell = SHELL_TOOL_BY_PLATFORM[normalizePlatform(platform)];
  const otherShell = expectedShell === 'bash' ? 'pwsh' : 'bash';

  // ── 两种零之一：**不知道宿主有哪些工具** ──────────────────────────────────
  // 这一支绝不能返回"看起来像成功"的结果。`knownNames` 缺失时若返回 `deny: []` 而不加区分，
  // 调用方会以为"工具面已收窄、只是没什么可收"—— 那是本包最讨厌的静默失败。
  //
  // **空数组也算"不知道"**（不是"没什么可收"）：真实部署里 `restrictableNames` 不可能是空的
  // （至少 shell 与 fs 工具都在），所以空清单只可能是"查不到 / 查错了作用域"。
  // 而且 `no-known-names`（"我不知道有什么"）在两种情况下都**真实**，
  // `nothing-to-deny`（"宿主里这些名字都没有"）只在一种情况下真实 —— 拿不准时说那句一定真的。
  const known = knownNames === undefined || knownNames === null ? new Set() : new Set(knownNames);
  if (known.size === 0) {
    return {
      deny: [], absent: [...LEAD_DENY_CANDIDATES], unexpectedAbsent: [],
      expectedShell, expectedShellPresent: false, effective: false,
      status: 'no-known-names',
      notes: ['拿不到有效的宿主工具名清单（knownNames 缺失或为空）⇒ **没有**收窄工具面。这不是"没什么可收"，是"我不知道有什么"。'],
    };
  }

  const deny = [];
  const absent = [];
  const unexpectedAbsent = [];
  const notes = [];

  for (const name of LEAD_DENY_CANDIDATES) {
    if (known.has(name)) { deny.push(name); continue; }
    absent.push(name);
    // 另一个平台的 shell 缺席是**预期**的（preset 按平台 disabled）—— 不算异常。
    if (name === otherShell) continue;
    unexpectedAbsent.push(name);
  }

  const expectedShellPresent = known.has(expectedShell);
  if (!expectedShellPresent) {
    notes.push(`本平台（${normalizePlatform(platform)}）的 shell 工具 \`${expectedShell}\` **不在**宿主工具清单里 —— 执行面收窄的前提不成立，请先确认 shell 插件已挂载。`);
  }
  if (unexpectedAbsent.length > 0) {
    notes.push(`本该存在的工具缺席：${unexpectedAbsent.map((n) => `\`${n}\``).join(' · ')} —— 插件组合可能变了或没装全（缺席不是"已经收掉了"）。`);
  }

  // ── 两种零之二：**确实没什么可收** ───────────────────────────────────────
  if (deny.length === 0) {
    return {
      deny, absent, unexpectedAbsent, expectedShell, expectedShellPresent,
      effective: false, status: 'nothing-to-deny',
      notes: [...notes, 'deny 名单为空 ⇒ **本次没有收窄任何工具**（宿主里这些名字一个都不存在）。'],
    };
  }

  return { deny, absent, unexpectedAbsent, expectedShell, expectedShellPresent, effective: true, status: 'ready', notes };
}

/**
 * lead 的只读工具**是否放行**（`lead` 只读工件）。
 *
 * 口径（刻意 fail-open）：判不出来就**放行** —— 与本包既有拦截器的口径一致
 * （"降级要留痕，但不能把动作变红"）：宁可放过一次探索性读取，也不要因为路径判据写窄
 * 而把 lead 的合法门控动作卡死。
 *
 * @param {object} input
 * @param {string} [input.filePath] - 模型要读的路径
 * @param {string} [input.cwd] - 工作区根
 * @param {string[]} [input.extraRoots] - 额外放行的绝对路径前缀
 * @returns {{allow: boolean, reason: 'artifact'|'outside-artifacts'|'undecidable'}}
 */
export function artifactReadDecision({ filePath, cwd, extraRoots } = {}) {
  if (typeof filePath !== 'string' || filePath === '' || typeof cwd !== 'string' || cwd === '') {
    return { allow: true, reason: 'undecidable' };
  }
  const root = path.resolve(cwd);
  const target = path.resolve(root, filePath);
  const roots = [path.join(root, ARTIFACT_SUBDIR)];
  if (Array.isArray(extraRoots)) for (const r of extraRoots) if (typeof r === 'string' && r !== '') roots.push(path.resolve(r));

  for (const r of roots) {
    // 加分隔符再比前缀：否则 `/w/teamx` 会被 `/w/team` 误判为"在里面"。
    if (target === r || target.startsWith(r + path.sep)) return { allow: true, reason: 'artifact' };
  }
  return { allow: false, reason: 'outside-artifacts' };
}

/** 本 preset 的 id（**实测值**：34 个真实会话头的 `agentPreset` 都是这个串，另 6 个是 `standard`）。 */
export const LEAD_PRESET_ID = 'expert-team';

/**
 * 该不该对**这个** agent 收窄工具面。
 *
 * 判据两条，缺一不可：
 *   ① **preset 必须是专家团**。读法 `agentPresets.composedPreset(agent.ctx)` —— 宿主写明它
 *      "read from the live scope chain rather than from the session"，因此对**还没写会话头**的
 *      agent 也答得出来。非专家团返回 `false`（**静默返回**，不是失败：绝大多数 agent 都无关）。
 *   ② **必须是根 agent（lead），不能是角色子代理**。这一条是安全闸门，不是优化：
 *      角色子代理是用 `composeFrom` 从**同一个 preset** 组合出来的 ⇒ 它们的
 *      `composedPreset` **同样是 `expert-team`**。若不查 ②，A2 会把角色的 bash 一起收掉 ——
 *      正好是要避免的事故。判据用 `agents.roots()`（宿主文档："created **without an owning
 *      agent context**"），它按运行时归属判定，不受会话血缘影响。
 *
 * @param {object} input
 * @param {string|undefined} [input.presetId] - `agentPresets.composedPreset(agent.ctx)`
 * @param {boolean} [input.isRoot] - `agents.roots().includes(agent)`
 * @returns {{apply: boolean, reason: 'lead'|'not-expert-team'|'is-subagent'}}
 */
export function shouldNarrowLeadToolFace({ presetId, isRoot } = {}) {
  if (presetId !== LEAD_PRESET_ID) return { apply: false, reason: 'not-expert-team' };
  if (isRoot !== true) return { apply: false, reason: 'is-subagent' };
  return { apply: true, reason: 'lead' };
}

/**
 * 取**agent 作用域**下的"可限制工具名清单"。
 *
 * ── 为什么必须带 scope（这一条是拿真机日志换来的）────────────────────────────
 * 宿主 `tools.view(scope)` 的文档写得很直白：**不传 scope = 全局视图**。而 0.1.5 起模型可见的
 * `bash/write/edit/grep/glob` 由 **preset 注册在 agent 平面**，不再是全局工具 ——
 * 于是 `view()`（全局）会返回一个**非空但缺这几个名字**的集合，`planLeadToolFace` 据此报
 * `nothing-to-deny`，收窄**静默失效**，而日志还在说"宿主里这些名字一个都不存在"（不属实）。
 * 宿主自己的 `restrict()` 用的就是 `scopeOf(this.ctx)` —— 本函数照抄同一条取 scope 的路。
 *
 * scope 是 `@deepseek-ai/dsh-scope` 里的**模块私有 Symbol**（`Symbol("dsh.scope")`，不是
 * `Symbol.for`），因此只能经该包的 `scopeOf()` 取得 ⇒ **动态 import**：仓库里解析不到该包时
 * 返回 `knownNames: undefined`，由调用方如实报 `no-known-names`（"我不知道有什么"），
 * 绝不退化成"宿主里没有这些工具"那种**不成立**的结论。
 *
 * @param {object} input
 * @param {object} [input.agentCtx] - `agent.ctx`（scope 就挂在它上面）
 * @param {object} [input.tools] - 工具服务（默认取 `agentCtx.tools`）
 * @param {Function} [input.loadScope] - **仅供测试**注入 `@deepseek-ai/dsh-scope` 的加载器
 * @returns {Promise<{knownNames: Set<string>|undefined, reason: string}>}
 */
export async function agentScopedToolNames({ agentCtx, tools, loadScope } = {}) {
  const loader = typeof loadScope === 'function' ? loadScope : () => import('@deepseek-ai/dsh-scope');
  let scopeOf;
  try {
    const mod = await loader();
    scopeOf = mod && mod.scopeOf;
  } catch (e) {
    return { knownNames: undefined, reason: 'scope-module-unavailable:' + String((e && e.message) || e) };
  }
  if (typeof scopeOf !== 'function') return { knownNames: undefined, reason: 'scope-of-missing' };
  const service = tools || (agentCtx && agentCtx.tools);
  if (!service || typeof service.view !== 'function') return { knownNames: undefined, reason: 'tools-service-unavailable' };
  let scope;
  try { scope = scopeOf(agentCtx); } catch { return { knownNames: undefined, reason: 'scope-undetectable' }; }
  if (scope === undefined) return { knownNames: undefined, reason: 'not-a-scoped-ctx' };
  try {
    const view = service.view(scope);
    const names = view && view.restrictableNames;
    const size = names && typeof names.size === 'number' ? names.size : 0;
    return { knownNames: names, reason: size > 0 ? 'ok' : 'empty-scoped-view' };
  } catch (e) {
    return { knownNames: undefined, reason: 'view-failed:' + String((e && e.message) || e) };
  }
}
