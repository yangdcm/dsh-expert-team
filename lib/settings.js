// 设置控制台的真源（F 线第 1 项）：`SETTINGS_SPEC` = 默认值 + 类型 + 值域 + 分组。
//
// 为什么单独成模块：设置同时被**三个消费者**读 —— ① 宿主路由（`GET/POST /settings`）；
// ② 编排器（把 `roster.maxTasks` 等接进既有的上限解析）；③ 浮层（照 spec 渲染表单）。
// 三者各写一份"默认值/合法值"必然分叉（本仓为此专门有 `vocab-consistency.test.mjs`）。
// 所以：**spec 只此一份**，UI 的表单结构也由它生成（新增一个设置项 = 只改这里）。
//
// 设计约束：
//   · **零 IO、零依赖**（纯常量 + 纯函数）⇒ 可单测，也能被将来的 client 构建复用；
//   · **未知键一律拒绝**（不静默吞）—— 打错字却"保存成功"是最糟糕的体验；
//   · **非法值一律拒绝并说明原因**，**不**回落默认（回落会让 UI 显示的值与实际生效的值不一致）；
//   · 每个项都带 `label` 与 `hint`（中文）—— 设置页要给人看，不给模型看。

/**
 * 设置项的类型：`bool` / `int` / `enum` / `roles`（字符串数组）。
 * `int` 带 `min`/`max`，`enum` 带 `values`，`roles` 只接受非空字符串数组。
 */
export const SETTINGS_GROUPS = ['identity', 'roster', 'display', 'gates'];

export const SETTINGS_SPEC = {
  identity: {
    label: '身份',
    hint: '团队怎么跟你说话、问你什么',
    items: {
      profile: { type: 'enum', values: ['developer', 'non-technical', 'mixed'], default: 'developer', label: '你的身份', hint: '技术开发者 / 无技术经验 / 混合。影响提问口径与是否代你决策', labels: { developer: '技术开发者', 'non-technical': '无技术经验', mixed: '混合' } },
      askBudget: { type: 'int', min: 0, max: 20, default: 5, label: '一次澄清最多问几个问题', hint: '0 = 不主动问，按保守默认处理并写明' },
      offerDecideForMe: { type: 'bool', default: false, label: '帮我把技术决策定下来', hint: '开启后由 pm 代决并逐条留痕（产品级/范围级决策仍必须你确认）' },
      keepPlanGate: { type: 'bool', default: true, label: '保留「方案确认门」', hint: '关掉即起草完方案直接开工 —— 不推荐，方案错了后面全错' },
    },
  },
  roster: {
    label: '编制',
    hint: '默认班底与容量上限',
    items: {
      defaultRoles: { type: 'roles', default: null, label: '默认班底', hint: '留空 = 按档位默认；填了就固定用这套' },
      deliverable: { type: 'enum', values: ['code+artifacts', 'artifacts-only'], default: 'code+artifacts', label: '交付口径', hint: 'artifacts-only = 只出工件，不改代码', labels: { 'code+artifacts': '出代码 + 工件', 'artifacts-only': '只出工件，不改代码' } },
      persist: { type: 'bool', default: false, label: '默认持久化活团队', hint: '开 = 成员可反复指挥；关 = 一次性自动组队' },
      maxMembers: { type: 'int', min: 0, max: 500, default: 32, label: '成员数上限', hint: '超过即拒绝落盘并显式报错' },
      maxTasks: { type: 'int', min: 0, max: 5000, default: 200, label: '任务数上限', hint: '同上' },
    },
  },
  display: {
    label: '显示',
    hint: '面板与浮层',
    items: {
      pollMs: { type: 'int', min: 1000, max: 60000, default: 3000, label: '面板轮询间隔（毫秒）', hint: '越小越实时、越费资源' },
      capsuleMs: { type: 'int', min: 0, max: 60000, default: 4000, label: '胶囊提示停留（毫秒）', hint: '0 = 不自动消失' },
      panelWidth: { type: 'int', min: 280, max: 900, default: 420, label: '浮层宽度（像素）', hint: '' },
      defaultTab: { type: 'enum', values: ['team', 'tasks', 'board', 'info'], default: 'team', label: '默认页签', hint: '面板页签的中文简称：人=团队、事=任务、盘=看板、料=资料', labels: { team: '人（团队）', tasks: '事（任务）', board: '盘（看板）', info: '料（资料）' } },
    },
  },
  gates: {
    label: '门禁',
    hint: '写侧门禁与档位选择门（关掉即退回只告警）',
    items: {
      loopGuard: { type: 'bool', default: true, label: '振荡检测（A→B→A→B）', hint: '宿主那份只管同工具重复，这份管来回振荡' },
      tierGate: { type: 'enum', values: ['soft', 'hard'], default: 'soft', label: '档位选择门', hint: 'soft = 建议先生效；hard = 不选不开工', labels: { soft: '软门（建议先生效）', hard: '硬门（不选不开工）' } },
      leadToolFace: { type: 'enum', values: ['on', 'off'], default: 'on', label: '收窄 lead 工具面', hint: 'on = 执行类工具（bash/write/edit/grep/glob）从 lead 手上拿走，交给角色子代理（省 token）；off = lead 保留全部工具', labels: { on: '开（从 lead 拿走执行工具）', off: '关（lead 保留全部工具）' } },
      maxReviewRounds: { type: 'int', min: 1, max: 20, default: 3, label: '评审轮次上限', hint: '到顶的正确动作是升级用户，不是再来一轮' },
      maxTestRounds: { type: 'int', min: 1, max: 20, default: 3, label: '测试轮次上限', hint: '同上' },
    },
  },
};

// ── 「暂未生效」的项：**单一真源**（2026-09-15，1.3.2 诚实性收口）────────────────────
//
// 为什么需要这张表：审核（两轮独立只读核验 + 全库 grep）发现 20 个设置项里有 10 项的**设置值
// 没有任何消费者** —— 用户在设置页勾了、改了，什么都不会发生。其中 3 项已在本版处理
// （`gates.boundaryTasks`/`gates.boundarySpec` 的行为本就**无条件强制**，故直接删除 spec；
// `gates.loopGuard` 是"接错了源"，已接线）。剩下 7 项**本版只标注、不接线**（留 1.3.3）。
//
// 为什么不干脆删掉这 7 项：它们描述的是**真要实现的能力**（浮层宽度、默认页签、默认班底…），
// 不是误加的开关。但"存在即承诺"——把 hint 写成承诺、行为却是空的，与删掉那两条装饰开关的理由
// 完全一样（不能双重标准）。所以：**如实标注"暂未生效"**，直到真的接上。
//
// 用法（两处消费，同一个真源）：
//   ① `decorateHint()` 把标记追加到 hint（设置页表单可见）；
//   ② `settings-consumers.test.mjs` 用它做白名单，语义是**集合相等**：
//      新增死开关 ⇒ 红；接线后忘了删这一行 ⇒ 也红（逼着清单只减不增）。
//   键 = 限定路径；值 = 一句"为什么现在没用"（写**实测来源**，不写猜测）。
export const INERT_SETTINGS = {
  'display.pollMs': '现值硬编码在浮层（client.js:1317 的 1200/3000）',
  'display.capsuleMs': '现值硬编码在浮层（client.js:2336 的 4000）',
  'display.panelWidth': '现值来自 localStorage 的 `et-width`（client.js:309），与设置无关',
  'display.defaultTab': '现值硬编码为 team（client.js:1198）',
  'roster.deliverable': '现由 `/team --no-code` 派生（mode.noCode），设置值不参与',
  'roster.persist': '现仅由 `/team --persist` 置位（mode.persist），设置值不参与',
  'roster.defaultRoles': '现用常量 DEFAULT_ROLES 或 `--roles`，设置值不参与',
};

/** 「暂未生效」标记文本（只此一份，`decorateHint` 是唯一加工点）。 */
export function inertMark(path) {
  const why = INERT_SETTINGS[String(path)];
  return why ? `（暂未生效：待 1.3.3 接线 —— ${why}）` : '';
}

/**
 * 给 hint 追加「暂未生效」标记。**必须是唯一加工点**：设置页 schema（`settingsSchema()`）与
 * 扁平视图（`flatSpec()`，宿主 schema 侧的取值口）都经它，两处结果必然一致 ——
 * 只标注其中一处等于造了第二个真源。
 *
 * **幂等**：hint 末尾已有该标记就不再追加（防止二次生成/重复加工把文案叠成一串）。
 * @param path - 限定路径（`display.pollMs`）
 * @param hint - 原 hint（可为空串/undefined）
 * @returns 加工后的 hint
 */
export function decorateHint(path, hint) {
  const mark = inertMark(path);
  const h = hint === undefined || hint === null ? '' : String(hint);
  if (!mark || h.includes(mark)) return h;
  return h ? `${h} ${mark}` : mark;
}

/** 全部设置项的扁平视图：`{ 'identity.profile': {…spec, group, key} }`（hint 已含「暂未生效」标记）。 */
export function flatSpec() {
  const out = {};
  for (const g of SETTINGS_GROUPS) {
    for (const [k, item] of Object.entries(SETTINGS_SPEC[g].items)) {
      const path = `${g}.${k}`;
      out[path] = { ...item, hint: decorateHint(path, item.hint), group: g, key: k };
    }
  }
  return out;
}

/** 默认设置（每次新建对象，防调用方改到 spec）。 */
export function defaultSettings() {
  const out = {};
  for (const g of SETTINGS_GROUPS) {
    out[g] = {};
    for (const [k, item] of Object.entries(SETTINGS_SPEC[g].items)) out[g][k] = item.default;
  }
  return out;
}

/** 取一个设置项的值（含默认），`path` 形如 `roster.maxTasks`。 */
export function getSetting(settings, path) {
  const spec = flatSpec()[String(path)];
  if (!spec) return undefined;
  const v = settings && settings[spec.group] ? settings[spec.group][spec.key] : undefined;
  return v === undefined ? spec.default : v;
}

/** 单个值的校验：返回 `{ ok, value, error }`。**不回落默认** —— 非法就是非法，由调用方决定怎么办。 */
export function validateValue(path, raw) {
  const spec = flatSpec()[String(path)];
  if (!spec) return { ok: false, value: null, error: `未知设置项：${path}` };
  switch (spec.type) {
    case 'bool':
      if (typeof raw !== 'boolean') return { ok: false, value: null, error: `${path} 必须是 true/false（收到 ${JSON.stringify(raw)}）` };
      return { ok: true, value: raw, error: '' };
    case 'int': {
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, value: null, error: `${path} 必须是整数（收到 ${JSON.stringify(raw)}）` };
      if (n < spec.min || n > spec.max) return { ok: false, value: null, error: `${path} 必须在 ${spec.min}..${spec.max}（收到 ${n}）` };
      return { ok: true, value: n, error: '' };
    }
    case 'enum':
      if (!spec.values.includes(raw)) return { ok: false, value: null, error: `${path} 只能是 ${spec.values.join(' / ')}（收到 ${JSON.stringify(raw)}）` };
      return { ok: true, value: raw, error: '' };
    case 'roles':
      if (raw === null) return { ok: true, value: null, error: '' };
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((r) => typeof r === 'string' && r.trim())) {
        return { ok: false, value: null, error: `${path} 必须是非空字符串数组，或 null（留空 = 按档位默认）` };
      }
      return { ok: true, value: raw.map((r) => r.trim()), error: '' };
    default:
      return { ok: false, value: null, error: `${path} 的类型 ${spec.type} 不认识（spec 写错了）` };
  }
}

/**
 * 把一份**补丁**（可以是 `{ roster: { maxTasks: 10 } }`，也可以是扁平的 `{ 'roster.maxTasks': 10 }`）
 * 合并进当前设置。
 *
 * **全有或全无**：任何一项非法 ⇒ 整体拒绝并返回全部错误 —— 半套生效的设置比报错更难排查。
 * 未知键同样报错（打错字却"保存成功"是最糟的体验）。
 *
 * @returns `{ ok, value, errors }`（`ok:false` 时 `value` 是原样返回的 `current`，调用方**不要**写盘）。
 */
export function mergeSettings(current, patch) {
  const base = normalizeSettings(current).settings;
  const errors = [];
  const next = normalizeSettings(base).settings;
  const assign = (path, raw) => {
    const r = validateValue(path, raw);
    if (!r.ok) { errors.push(r.error); return; }
    const spec = flatSpec()[path];
    next[spec.group][spec.key] = r.value;
  };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, value: base, errors: ['补丁必须是对象'] };
  }
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes('.')) { assign(k, v); continue; }
    if (!SETTINGS_SPEC[k]) { errors.push(`未知设置分组：${k}`); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${k} 必须是对象`); continue; }
    for (const [k2, v2] of Object.entries(v)) {
      if (!SETTINGS_SPEC[k].items[k2]) { errors.push(`未知设置项：${k}.${k2}`); continue; }
      assign(`${k}.${k2}`, v2);
    }
  }
  if (errors.length) return { ok: false, value: base, errors };
  return { ok: true, value: next, errors: [] };
}

/**
 * 规范化一份可能来自磁盘的设置：**只认 spec 里有的键**，缺失的补默认；
 * 磁盘上的非法值（手改坏了）**按默认处理并如实返回**（不抛 —— 一份坏设置不该让插件挂掉）。
 * @returns `{ settings, repaired: [{path, from, to}] }`
 */
export function normalizeSettings(raw) {
  const out = defaultSettings();
  const repaired = [];
  if (!raw || typeof raw !== 'object') return { settings: out, repaired };
  for (const g of SETTINGS_GROUPS) {
    const src = raw[g];
    if (!src || typeof src !== 'object') continue;
    for (const [k, spec] of Object.entries(SETTINGS_SPEC[g].items)) {
      if (!(k in src)) continue;
      const r = validateValue(`${g}.${k}`, src[k]);
      if (r.ok) out[g][k] = r.value;
      else repaired.push({ path: `${g}.${k}`, from: src[k], to: spec.default, error: r.error });
    }
  }
  return { settings: out, repaired };
}

/** 给设置页用的渲染元数据（分组 + 每项的类型/值域/中文标签）—— UI 由它生成，不另写一份表单结构。 */
export function settingsSchema() {
  return SETTINGS_GROUPS.map((g) => ({
    group: g,
    label: SETTINGS_SPEC[g].label,
    hint: SETTINGS_SPEC[g].hint,
    items: Object.entries(SETTINGS_SPEC[g].items).map(([k, item]) => ({
      path: `${g}.${k}`, key: k, type: item.type, values: item.values ?? null,
      min: item.min ?? null, max: item.max ?? null, default: item.default,
      label: item.label, hint: decorateHint(`${g}.${k}`, item.hint),
      // 枚举的中文标签必须**显式**透传：这里是按字段白名单构造的，漏一个字段它就会静默消失
      // （客户端是手写 bundle、不能 import lib/ ⇒ 标签只能随这个响应体到达设置页）。
      labels: item.labels || null,
    })),
  }));
}

// ── 身份策略（F 线第 4 项）：把「你的身份」编译成**可审计的一页 POLICY.md** + 启动消息里的口径块 ──
//
// 需求原文：「目前对话框询问的问题有时候偏技术性或产品性，如果懂技术的就很好明白，如果不懂技术
// 的人就可能不会选……很多问题可以另外加一个身份专门帮用户做决策」。
//
// 三层落地（合并清单里定的），本模块负责前两层（**不依赖重新同步、对新 run 立即生效**）：
//   ① 启动消息里的【用户画像与提问口径】块（lead 第一眼就看到）；
//   ② run 目录的 `POLICY.md`（可审计、子代理可读、用户可点开）。
//   第三层（SKILL/ROLES 规则）由技能文本承载。
//
// ⚠️ `keepPlanGate=false` 是**用户显式授权**：此时 POLICY.md 会写明"本 run 已获准跳过方案确认门"。
// 它是**有意的例外**，不是默认行为 —— 默认 true 时 SKILL §3 的门禁一字不改。

/** 三种身份各自的提问/决策口径（面向人写，直接进 POLICY.md）。 */
export const POLICY_PROFILES = {
  developer: {
    label: '技术开发者',
    ask: '可以直接使用技术术语（接口 / 契约 / 幂等 / 迁移 / DDL…），但仍要给出**选项 + 影响**，不要只抛一个开放问题。',
    decide: '**不代你决策**：技术选择给出 2–3 个选项与权衡，由你拍板。',
  },
  'non-technical': {
    label: '无技术经验',
    ask: '**禁止术语**。每个问题必须写成三段：① 一句话人话版（这在做什么、影响什么）；② 每个选项会导致什么可感知的差别；③ **我建议选哪个、为什么**。',
    decide: '**技术决策由 pm 代你拍板并逐条留痕**（框架 / 库 / 字段格式 / 目录结构 / 命名这类）。**产品级与范围级决策必须问你**（要做什么、不要做什么、给谁用、验收标准）。',
  },
  mixed: {
    label: '混合',
    ask: '两段式：先一句话人话版，再给技术细节；技术性追问可以直接用术语。',
    decide: '技术决策给出**建议默认值**并说明可覆盖；你没回应时按建议走，并逐条留痕。',
  },
};

/** POLICY.md 里的口径块标记（launchMessage 靠它抽取，避免把整篇文档塞进启动消息）。 */
export const POLICY_BLOCK_START = '<!-- POLICY-BLOCK:START -->';
export const POLICY_BLOCK_END = '<!-- POLICY-BLOCK:END -->';

/**
 * 把设置编译成身份策略。
 * @param settings - `currentSettings()` 的形状（缺项按默认）。
 * @returns `{ profile, label, ask, decide, askBudget, offerDecideForMe, keepPlanGate, md, block }`
 */
export function compilePolicy(settings) {
  const s = normalizeSettings(settings).settings;
  const id = s.identity;
  const prof = POLICY_PROFILES[id.profile] || POLICY_PROFILES.developer;
  const decide = id.offerDecideForMe && id.profile === 'developer'
    ? `${prof.decide}\n- ⚠️ 你已在设置里勾选「帮我把技术决策定下来」：技术选择可直接采用最稳妥方案，但**必须逐条留痕**（选了什么 / 为什么不选另外两个）。`
    : prof.decide;
  const block = [
    POLICY_BLOCK_START,
    `【用户画像与提问口径】身份＝**${prof.label}**（profile=${id.profile}）`,
    `- 怎么问：${prof.ask}`,
    `- 一次澄清最多问 **${id.askBudget}** 个问题（0 = 先按保守默认处理并写明，不要空等）。`,
    `- 谁决策：${decide}`,
    `- 方案确认门：${id.keepPlanGate
      ? '**保留**（spec-review 后、implement 前必须让用户确认；SKILL §3 原样执行）。'
      : '⚠️ **用户已显式关闭**（settings.identity.keepPlanGate=false）⇒ 本 run **已获准**在 spec-review 通过后直接进入 implement；但**产品级/范围级变更仍必须问**，且跳过一事要写进 `SUMMARY.md` 与 `RUN.log.md`。'}`,
    POLICY_BLOCK_END,
  ].join('\n');
  const md = [
    '# 身份策略（POLICY）',
    '',
    '> 由设置控制台编译而来，**随 run 冻结**（改设置只影响之后新建的 run）。',
    `> 生成于：${new Date().toISOString()} ｜ profile=${id.profile}`,
    '',
    block,
    '',
    '## 三层落地',
    '',
    '1. **启动消息**里带上面这个口径块（lead 第一眼就看到）；',
    '2. 本文件（可审计、子代理可读）；',
    '3. 技能规则（`SKILL.md` §1.2 / `references/ROLES.md` 的提问与决策口径）。',
    '',
    '## 口径明细',
    '',
    `- 提问：${prof.ask}`,
    `- 提问预算：一次澄清最多 ${id.askBudget} 个问题。`,
    `- 决策：${decide}`,
    `- 方案确认门：${id.keepPlanGate ? '保留' : '用户显式关闭（见上）'}。`,
    '',
    '## 留痕要求',
    '',
    '- 每一次"代你决策"都要在 `DECISIONS.md` 留一行：选了什么 / 备选是什么 / 为什么不选。',
    '- 用术语解释事情时，必须同时给一句人话版（这条对三种身份都成立）。',
    '',
  ].join('\n');
  return { profile: id.profile, label: prof.label, ask: prof.ask, decide, askBudget: id.askBudget,
    offerDecideForMe: id.offerDecideForMe, keepPlanGate: id.keepPlanGate, md, block };
}

/** 从 POLICY.md 全文里抽出启动消息要用的口径块；没有标记返回 `''`（旧 run 不受影响）。 */
export function policyBlockFrom(mdText) {
  const t = String(mdText || '');
  const a = t.indexOf(POLICY_BLOCK_START);
  const b = t.indexOf(POLICY_BLOCK_END);
  if (a < 0 || b < 0 || b <= a) return '';
  return t.slice(a, b + POLICY_BLOCK_END.length);
}
