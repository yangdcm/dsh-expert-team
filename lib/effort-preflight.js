/**
 * 会话模型的 **reasoningEffort 预检**（2026-09-15，**只告警，绝不阻断**）。
 *
 * ── 为什么需要它（一次真实故障的定性）────────────────────────────────────────
 * 用户报 `model "deepseek-flash" does not support reasoning effort "low"`。定性结论：
 *   · **不是本插件的错，也不是宿主缺 low**；
 *   · 是用户 `~/.dsh/settings.yaml` 里会话默认路由（命名空间 `agent-default-model`）的
 *     `deepseek-flash` 条目**漏写 `reasoningEfforts`** ⇒ 宿主能力表里该模型**只剩 `off`**
 *     ⇒ **任何显式 effort 都被拒**（`dsh-llm` 的 `resolveCallWithInfo`：
 *     `reasoning === undefined` 时，只要传了 `reasoningEffort` 就抛 `UNSUPPORTED_REASONING_EFFORT`）。
 *   · 而本 preset 里 **4 个角色声明 `low`、8 个声明 `high`** ⇒ 在这个路由下 **12 个角色全会失败**。
 *     "只有 low 报错"是假象：**先派谁先报谁**。
 *   · 宿主在**任何网络 I/O 之前**就抛（`dsh-tool-subagent` 的 preflight → `llm.resolveCallConfig`）。
 *
 * ⇒ 插件**无法**在派工前改变宿主行为（派工由宿主 `tool-subagent` + LLM 运行时执行），
 *   能做的是**提前告警**：在会话路由能力表与 preset 声明对不上时，打**一行**可操作的提示。
 *   这也是本仓唯一诚实的做法 —— 静默失败最贵。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────
 *   · **只告警，不阻断、不改 preset 的 effort 分档**（那是设计意图）；
 *   · 任何异常/读不到 ⇒ **静默跳过**（fail-open），绝不让插件加载失败、绝不刷屏；
 *   · 一次加载**最多一行**（进程内去重），服务晚挂则**就绪后重探**（同 `scheduleOptionalPluginCheck`）。
 */

/** 宿主合法 effort 值域（`dsh-llm` 的 `LlmReasoningEffortId`）。 */
export const EFFORT_DOMAIN = Object.freeze(['off', 'low', 'high', 'max']);

/**
 * 从 preset 源文件里提取**声明了哪些 effort、各有几个角色**（纯函数，按行正则，不引 YAML 解析器）。
 * 只认 `reasoningEffort: <值>` 这种行；顺序按出现次数降序、值去重。
 * @returns {{efforts:string[], counts:Record<string,number>}}
 */
export function declaredEffortsFromPresetSource(src) {
  const counts = Object.create(null);
  const re = /^\s*(?:-\s*)?reasoningEffort:\s*['"]?([A-Za-z]+)['"]?\s*$/gm;
  let m;
  while ((m = re.exec(String(src || ''))) !== null) {
    const v = String(m[1]).toLowerCase();
    if (!v) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  const efforts = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return { efforts, counts };
}

/**
 * 判定"当前会话模型能不能承接 preset 声明的 effort"（纯函数，便于单测）。
 * @param {object} input
 * @param {{provider:string,model:string}|null} input.selection - `agentDefaultModel.currentSelection()`
 * @param {string[]} input.required - preset 声明的 effort 值
 * @param {object|null} input.info - `llm.resolveModelInfo(provider, model)` 的结果
 * @param {Error|null} [input.infoError] - 读模型信息时抛的错（有值 ⇒ 我们不假装知道）
 * @returns {{status:string, warn:boolean, message:string, available:string[], missing:string[]}}
 */
export function effortPreflightPlan({ selection, required, info, infoError } = {}) {
  const req = Array.isArray(required) ? required.filter(Boolean) : [];
  const sel = selection && selection.provider && selection.model ? selection : null;
  if (!sel) return { status: 'no-route', warn: false, message: '', available: [], missing: req };
  if (!req.length) return { status: 'no-preset-efforts', warn: false, message: '', available: [], missing: [] };
  const where = `${sel.provider}/${sel.model}`;
  if (infoError || !info) {
    // 读不到能力表 ⇒ **不假装知道**（也不打扰）：模型可能还没注册/适配器未就绪。
    return { status: 'unknown', warn: false, message: '', available: [], missing: [] };
  }
  const reasoning = info.reasoning;
  const available = Array.isArray(reasoning && reasoning.efforts) ? reasoning.efforts.map((e) => String(e && e.id)).filter(Boolean) : [];
  const set = new Set(available);
  const missing = req.filter((r) => !set.has(String(r).toLowerCase()));
  if (!reasoning) {
    // 宿主语义：reasoning === undefined ⇒ **任何** reasoningEffort 都会被拒。
    return {
      status: 'no-reasoning-support',
      warn: true,
      available,
      missing: req,
      message: `[expert-team] 当前会话模型 ${where} 未声明任何 reasoningEfforts（宿主视为"不支持 reasoning effort"）⇒ preset 里带 effort 的角色派工会被拒（UNSUPPORTED_REASONING_EFFORT）。修法：在 ~/.dsh/settings.yaml 的 agent-default-model 条目给该模型补 reasoningEfforts（${EFFORT_DOMAIN.join('/')}），或把会话切到官方路由。`,
    };
  }
  if (missing.length) {
    return {
      status: 'missing-efforts',
      warn: true,
      available,
      missing,
      message: `[expert-team] 当前会话模型 ${where} 只声明了 reasoningEfforts=[${available.join(',') || '（空）'}]，而 preset 里声明的 [${missing.join(',')}] 不在其中 ⇒ 这些角色的派工会被宿主拒绝（UNSUPPORTED_REASONING_EFFORT；宿主在任何网络 I/O 之前就拒）。修法：在 ~/.dsh/settings.yaml 的 agent-default-model 条目补 reasoningEfforts（${EFFORT_DOMAIN.join('/')}），或把会话切到官方路由。`,
    };
  }
  return { status: 'ok', warn: false, message: '', available, missing: [] };
}

/** 默认的有界重探节奏（服务晚挂时用；与 `OPTIONAL_PROBE_DELAYS_MS` 同一套纪律）。 */
export const EFFORT_PROBE_DELAYS_MS = Object.freeze([250, 1000, 3000]);

/**
 * 接线：读 preset 声明 → 读当前路由与模型能力 → 下单（不阻断）→ 结论在**最后一轮**才播报。
 * deps 全部注入，便于用假 ctx 单测。
 * @param {object} deps
 * @param {() => Promise<string>} [deps.readPresetSource] - 读 preset 源文本（读不到 ⇒ 静默跳过）
 * @param {(ctx:object)=>{provider:string,model:string}|null} [deps.readSelection]
 * @param {(provider:string, model:string)=>Promise<object>} [deps.readModelInfo]
 * @param {(line:string)=>void} [deps.warn] - 播报出口（默认 console.warn）
 * @param {(type:string,payload:object)=>void} [deps.onEvent]
 */
export function createEffortPreflight(deps = {}) {
  const { readPresetSource, readSelection, readModelInfo, onEvent } = deps;
  const say = typeof deps.warn === 'function' ? deps.warn : (line) => console.warn(line);
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  let done = false;
  return async function runEffortPreflight(ctx, { isLast = true } = {}) {
    if (done) return { status: 'already-done', warn: false };
    try {
      const src = await readPresetSource();
      const { efforts: required, counts } = declaredEffortsFromPresetSource(src);
      const selection = readSelection(ctx);
      if (!selection) { if (isLast) done = true; return { status: 'no-route', warn: false }; }
      let info = null, infoError = null;
      try { info = await readModelInfo(selection.provider, selection.model); } catch (e) { infoError = e; }
      const plan = effortPreflightPlan({ selection, required, info, infoError });
      if (isLast) done = true;
      if (plan.warn) {
        const detail = Object.keys(counts).length ? `（preset 里 ${Object.entries(counts).map(([k, v]) => `${v} 个用 ${k}`).join('、')}）` : '';
        try { say(detail ? plan.message.replace('。修法：', `${detail}。修法：`) : plan.message); } catch { /* 打印失败也不能影响加载 */ }
        emit('effort-preflight-warn', { status: plan.status, provider: selection.provider, model: selection.model, available: plan.available, missing: plan.missing });
      }
      return plan;
    } catch (e) {
      // 探测自身出错 ⇒ 静默（fail-open），但留一条事件供排查
      try { emit('effort-preflight-error', { error: String((e && e.message) || e) }); } catch { /* ignore */ }
      if (isLast) done = true;
      return { status: 'error', warn: false };
    }
  };
}
/** 仅供测试：复位"只播报一次"的开关（由 command.js 包一层，见 `_resetEffortPreflight`）。 */
export function _resetEffortPreflightState() { /* 开关在 createEffortPreflight 的闭包里，测试用新实例即可 */ }
