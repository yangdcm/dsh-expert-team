// token 记账（P5 线）：把「一次 run 烧掉多少 token、上下文涨到多大」变成**可读的数**。
//
// 为什么需要它（本能力的由来，逐条可核）：
//   对 10 个真实 expert-team 顶层会话 + 57 个角色子代理会话做全量遥测审计的结果是：
//     · 输出 tokens 只占总量的 **0.24%**（所以「让模型少说点」不是杠杆）；
//     · **99.2%** 的输入是缓存读，而每步 prompt 中位数 **426K**、单会话峰值 ~800K；
//     · lead 层累计 prompt **3.29B**，是角色层（639M）的 **5.1 倍** —— 贵的不是"人多"，
//       而是"编排者自己干活"（某 run 的 lead 在主上下文里调了 3,244 次工具、只派工 11 次）。
//   而技能里只有**时间/返工**维度的定额（首产物 10 分钟、收尾 ≤ 实现期 50%），
//   **没有任何 token/上下文维度的定额**，METRICS 也从不渲染 token ⇒ 这件事在整个体系里隐形，
//   没人看得见也就没人踩刹车。本模块就是那道「让它可见」的接线。
//
// 数据来源有两条（**两条都留着**，不是二选一）：
//   ① **权威（自动）**：DSH 会话遥测 —— `~/.dsh/sessions/<workspace-slug>/<sid>/session.v3.jsonl.zstd`
//      里每条 `assistant/message` 都带 `usage`。按 **run 的时间窗**把 lead 会话（delegationDepth 0）
//      与角色子代理会话（delegationDepth 1）归属到 run，不需要任何人写日志。
//   ② **兜底（可选）**：`RUN.log.md` 里的 `tokens:<scope>` 事件（格式见 LOGGING.md）。
//      会话文件被清理、或跑在别的机器上时用它。
//
// ⚠️ 两条来源的**权威性不同**，所以本模块**不合并、不相加**：遥测在则用遥测，遥测不在才回落到日志事件，
//    并在文案里注明来源。把"实测"与"自报"混成一个数，正是本仓在撤销率上吃过亏的那种失真。
//
// 零依赖、纯计算（IO 在 `session-usage.js`）⇒ 解析与汇总可纯单测。

/**
 * 事件族名。`tokens:lead` / `tokens:backend` → 族 `tokens`，scope `lead`/`backend`。
 * 与 `role:` / `phase:` / `scan:` 同一套「冒号前是族」的约定（`log-parse.eventFamily`）。
 */
export const TOKEN_EVENT_FAMILY = 'tokens';

/**
 * `tokens:<scope> — <键值对>` 里允许的字段。
 *
 * 字段名**故意写全**（`in` / `cache` / `out` / `steps` / `peak`）而不是 `i/o/c`：
 * 一行日志要能被人读懂，缩写省下的字节远不如"读错字段"的代价。
 * `in` = **未缓存输入**、`cache` = **缓存命中输入**、`out` = 输出、`peak` = 单步 prompt 峰值。
 */
export const TOKEN_FIELDS = ['in', 'cache', 'out', 'steps', 'peak', 'first'];

/**
 * 成本折算权重的**默认值**（相对权重，不是价格）。
 *
 * 为什么不写死绝对价格：供应商价格会变（2026-09-10 Flash 系列刚降过一轮），写死会过期；
 * 而"钱花在哪一类 token 上"这个**结构**不随降价改变。所以这里用相对权重：
 *   未缓存输入 = 1（基准）· 缓存输入 = 1/50 · 输出 = 2。
 * 该比例来自 DeepSeek 各代公开定价的**共同结构**（缓存命中输入约为未命中输入的 1/50~1/10，
 * 输出约为未命中输入的 2 倍）；真实换算成钱时按当期价格替换 `weights` 即可。
 */
export const DEFAULT_TOKEN_WEIGHTS = { in: 1, cache: 1 / 50, out: 2 };

/** 解析一行 `tokens:<scope>` 事件。非该族 ⇒ `null`；该族但**没有可用的合法字段** ⇒ `{scope, ok:false}`。 */
export function parseTokenEvent(type, detail) {
  const t = String(type ?? '');
  if (!t.startsWith(`${TOKEN_EVENT_FAMILY}:`)) return null;
  const scope = (t.slice(TOKEN_EVENT_FAMILY.length + 1).split(/[\s(]/)[0] || '').trim();
  const s = String(detail ?? '');
  const vals = {};
  const seen = new Set();
  // 只认 `键=数字`（允许千位下划线与 `k`/`m` 后缀，便于人写 `peak=426k`）。
  // 不认的键一律记进 `unknownKeys`，**并且把整行判为不可用**（见下面的 `ok`）。
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([0-9][0-9_,.]*[kKmM]?)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = m[1].toLowerCase();
    seen.add(key);
    if (!TOKEN_FIELDS.includes(key)) continue;
    let raw = m[2].replace(/[_,]/g, '');
    let mult = 1;
    const suf = raw.slice(-1).toLowerCase();
    if (suf === 'k') { mult = 1e3; raw = raw.slice(0, -1); }
    else if (suf === 'm') { mult = 1e6; raw = raw.slice(0, -1); }
    const n = Number(raw) * mult;
    if (Number.isFinite(n) && n >= 0) vals[key] = n;
  }
  const unknownKeys = [...seen].filter((k) => !TOKEN_FIELDS.includes(k));
  // ⚠️ `ok` 的判据是「**有合法字段 且 没有未知字段**」，不是"有合法字段就行"。
  // 为什么这么严：`steps=62 in=2 typo_x=5` 这种"一个字段名写错、其余都对"的行，
  // 若按"有合法字段"放行，那个写错的字段会**静默消失**（数字少一块，而没人知道）——
  // 正是本包反复出现的那类"静默失败"。宁可整行判坏、让它出现在报告里被修掉。
  const ok = Object.keys(vals).length > 0 && unknownKeys.length === 0;
  return { scope: scope || 'unknown', ok, values: vals, unknownKeys };
}

/**
 * 汇总一个 run 的 token 记账。
 *
 * @param rows - `[{scope, source, first, in, cache, out, steps, peak}]`
 *   `scope`: `'lead'` 或角色名；`source`: `'telemetry'`（会话遥测，权威）或 `'log'`（日志事件）。
 * @param opts - `{weights}` 覆盖成本权重（默认 `DEFAULT_TOKEN_WEIGHTS`）。
 * @returns 结构化汇总（见下方字段），**不含任何 IO 与文案**。
 *
 * 设计要点（三条，都是为了不骗人）：
 *   ① **两个来源分开计**（`bySource`）—— 实测与自报相加会得到一个谁也不是的数；
 *   ② **缺项与零分开**：`missingSteps`（没记 steps ⇒ 算不出重放倍数）与 `steps:0` 不是一回事；
 *   ③ **成本是相对占比**，并且**在文案里写明基准** —— 绝不冒充"花了多少钱"。
 */
export function summarizeTokenUsage(rows, opts = {}) {
  const weights = { ...DEFAULT_TOKEN_WEIGHTS, ...(opts && opts.weights ? opts.weights : {}) };
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const zero = { in: 0, cache: 0, out: 0, steps: 0 };
  const acc = { ...zero, peak: 0, first: 0 };
  const bySource = new Map();   // source -> {in,cache,out,steps,runs}
  let missingSteps = 0;
  let missingPeak = 0;

  // 逐个会话先收集，**再按 scope 合并**：同一个角色在一次 run 里可能有多个会话
  //（重派、复验、并行腿），逐条列出会得到 `lead 976,506,715 · lead 49,453,574 · lead 12,040,639`
  // 这种"同一个名字重复出现"的清单 —— 读者看不出这是三个会话还是三个不同角色。
  // 合并后带 `sessions` 计数，并按 `in+cache` 降序（谁贵谁在前）。
  const scopeAgg = new Map();   // scope -> 合并项
  for (const r of list) {
    const src = String(r.source ?? 'log');
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
    const inTok = num(r.in);
    const cacheTok = num(r.cache);
    const outTok = num(r.out);
    const steps = num(r.steps);
    const peak = num(r.peak);
    const first = num(r.first);
    acc.in += inTok; acc.cache += cacheTok; acc.out += outTok; acc.steps += steps;
    if (peak > acc.peak) acc.peak = peak;
    if (first > acc.first) acc.first = first;
    if (!(steps > 0)) missingSteps += 1;
    if (!(peak > 0)) missingPeak += 1;
    const b = bySource.get(src) ?? { in: 0, cache: 0, out: 0, steps: 0, rows: 0 };
    b.in += inTok; b.cache += cacheTok; b.out += outTok; b.steps += steps; b.rows += 1;
    bySource.set(src, b);
    // `roleKnown` 必须**穿透**到 byScope：渲染时要如实标明"这个 scope 是会话 id，不是角色名"。
    // 不知道角色却把它显示成一个角色名，会让读者以为"某个角色烧了 1400 万 token"（而事实是"某个会话"）。
    const key = String(r.scope ?? 'unknown');
    const known = r.roleKnown === undefined ? true : !!r.roleKnown;
    const cur = scopeAgg.get(key);
    if (cur) {
      cur.in += inTok; cur.cache += cacheTok; cur.out += outTok; cur.steps += steps; cur.sessions += 1;
      if (peak > cur.peak) cur.peak = peak;
      if (first > cur.first) cur.first = first;
      // 只要其中任一条认不出角色，就整体标为"角色不可靠"（宁可保守）。
      cur.roleKnown = cur.roleKnown && known;
    } else {
      scopeAgg.set(key, { scope: key, source: src, roleKnown: known, in: inTok, cache: cacheTok, out: outTok, steps, peak, first, sessions: 1 });
    }
  }
  const byScope = [...scopeAgg.values()];

  const cost = {
    in: acc.in * weights.in,
    cache: acc.cache * weights.cache,
    out: acc.out * weights.out,
  };
  const costTotal = cost.in + cost.cache + cost.out;
  const promptTotal = acc.in + acc.cache;
  const grand = promptTotal + acc.out;

  return {
    rows: list.length,
    byScope: byScope.sort((a, b) => (b.in + b.cache) - (a.in + a.cache) || String(a.scope).localeCompare(String(b.scope))),
    bySource: [...bySource.entries()].map(([source, v]) => ({ source, ...v })).sort((a, b) => String(a.source).localeCompare(String(b.source))),
    totals: { ...acc, prompt: promptTotal, grand },
    cost: { ...cost, total: costTotal },
    // 成本占比（百分点，四舍五入到整数）—— 三个桶**必然**相加为 100（costTotal>0 时）。
    costShare: costTotal > 0 ? {
      in: Math.round((cost.in / costTotal) * 100),
      cache: Math.round((cost.cache / costTotal) * 100),
      out: Math.round((cost.out / costTotal) * 100),
    } : { in: 0, cache: 0, out: 0 },
    // 输出 tokens 占**总量**的比例（这就是"少说点没用"的那个数）。
    outputTokenShare: grand > 0 ? (acc.out / grand) * 100 : 0,
    // 「重放放大」= 累计 prompt /（未缓存输入 + 缓存输入）… 分母缺失时返回 null（**不猜 0**）。
    replayAmplification: promptTotal > 0 && acc.steps > 0 ? acc.steps : null,
    missingSteps,
    missingPeak,
    // 每步平均 prompt（= 重放的成本基数）。steps 缺失 ⇒ null，"算不出"≠"很小"。
    avgPromptPerStep: acc.steps > 0 ? Math.round(promptTotal / acc.steps) : null,
    weights,
  };
}

/** 千分位（渲染用；不引入 Intl 依赖以免测试环境差异）。 */
export function groupThousands(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  const neg = v < 0;
  const s = String(Math.round(Math.abs(v)));
  const out = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${out}` : out;
}

/**
 * 渲染 METRICS.md 的「token 成本与上下文峰值」小节（纯文案，可单测）。
 *
 * 三种状态**必须可区分**（本包在撤销率上吃过亏的那条纪律，逐字沿用）：
 *   ① 有数据          → 逐 run 明细 + 汇总 + 口径说明；
 *   ② 事件写坏了      → 单列「N 行 tokens 事件没有一个解析出合法字段」（写错字段名会静默消失）；
 *   ③ 一条都没有      → 如实写「无 token 记账」，并**说明这不等于消耗低**。
 */
export function renderTokenSection({ runs = [], broken = 0, unattributed = 0, weights = DEFAULT_TOKEN_WEIGHTS } = {}) {
  const head = `> 口径：未缓存输入 / 缓存输入 / 输出 / 步数 / 首步 prompt（每会话固定开销）/ 峰值 prompt。` +
    `成本按**相对权重**折算（未缓存输入 1 · 缓存输入 ${weights.cache} · 输出 ${weights.out}），**不是价格** —— ` +
    `换当期价格只需替换权重；要的是"钱花在哪一类 token 上"这个结构。`;
  if (!runs.length) {
    const lines = [
      '- **无 token 记账**：没有任何 run 有可用的 token 数据（会话遥测读不到，且日志里没有 `tokens:<scope>` 事件）。',
      '  · ⚠️ 这一行**不代表消耗低** —— 它只说明"没测到"。本包实测过的真实 run 里，单条 lead 会话累计 prompt 达 **9.7 亿**、',
      '    每步 prompt 中位数 **426K**；**没有数就没有刹车**，这正是本小节存在的原因。',
      '  · 数据来源：DSH 会话遥测（`~/.dsh/sessions/<workspace-slug>/...`）或 `RUN.log.md` 的 `tokens:<scope>` 事件（见 LOGGING.md）。',
    ];
    if (broken > 0) lines.push(`- ⚠️ 另有 ${broken} 行 \`tokens:*\` 事件**没有一个解析出合法字段**（字段名写错会静默消失，合法字段：in / cache / out / steps / peak / first）。`);
    return lines.join('\n');
  }

  const out = [head, ''];
  const total = runs.reduce((a, r) => ({
    in: a.in + r.totals.in, cache: a.cache + r.totals.cache, out: a.out + r.totals.out,
    steps: a.steps + r.totals.steps, prompt: a.prompt + r.totals.prompt,
  }), { in: 0, cache: 0, out: 0, steps: 0, prompt: 0 });
  const costOf = (r) => r.totals.in * weights.in + r.totals.cache * weights.cache + r.totals.out * weights.out;
  const totalCost = total.in * weights.in + total.cache * weights.cache + total.out * weights.out;
  const grand = total.prompt + total.out;

  out.push(`- 有 token 记账的 run：**${runs.length}** 个`);
  const byLog = runs.filter((r) => r.source === 'log').length;
  if (byLog > 0) out.push(`- 其中 **${byLog}** 个来自日志事件（\`tokens:<scope>\`），其余来自 DSH 会话遥测（**两种来源不混算**）`);
  // 归属口径必须**随行渲染**：表里每一行都可能是"标记命中"与"就近推定"的混合，
  // 而这两档的可靠度差一个量级。只给数字不给依据，等于让读者把推定当实测用。
  const marked = runs.reduce((a, r) => a + (r.byScope || []).length, 0) > 0
    ? runs.map((r) => /marker×(\d+)/.exec(r.windowBasis || '')).filter(Boolean).reduce((a, m) => a + Number(m[1]), 0)
    : 0;
  const guessed = runs.map((r) => /nearest×(\d+)/.exec(r.windowBasis || '')).filter(Boolean).reduce((a, m) => a + Number(m[1]), 0);
  if (marked || guessed || unattributed) {
    out.push(`- 会话归属：**标记命中 ${groupThousands(marked)} 个**（提示词里带 run 目录路径，强证据）· 就近推定 ${groupThousands(guessed)} 个（弱证据）· 未归属 ${groupThousands(unattributed)} 个（**不猜**，故未计入任何 run）`);
  }
  out.push(`- 合计：未缓存输入 ${groupThousands(total.in)} · 缓存输入 ${groupThousands(total.cache)} · 输出 ${groupThousands(total.out)} · LLM 步数 ${groupThousands(total.steps)}`);
  if (grand > 0) out.push(`- 输出 tokens 只占总量的 **${(total.out / grand * 100).toFixed(2)}%**（⇒「让模型少说点 / 降 effort」不是杠杆，**prompt 体积 × 步数**才是）`);
  if (totalCost > 0) {
    out.push(`- 成本占比：未缓存输入 **${Math.round((total.in * weights.in) / totalCost * 100)}%** · 缓存输入 **${Math.round((total.cache * weights.cache) / totalCost * 100)}%** · 输出 **${Math.round((total.out * weights.out) / totalCost * 100)}%**`);
  }
  out.push('');
  out.push('| run | 来源 | 归属依据 | 步数 | 未缓存输入 | 缓存输入 | 输出 | 首步 prompt | 峰值 prompt | 每步均 prompt | lead 占比 |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of [...runs].sort((a, b) => costOf(b) - costOf(a))) {
    const lead = r.byScope.filter((s) => s.scope === 'lead').reduce((a, s) => a + s.in + s.cache, 0);
    const leadShare = r.totals.prompt > 0 ? `${Math.round((lead / r.totals.prompt) * 100)}%` : '—';
    out.push(`| ${r.name} | ${r.source} | ${r.windowBasis || '—'} | ${groupThousands(r.totals.steps)} | ${groupThousands(r.totals.in)} | ${groupThousands(r.totals.cache)} | ${groupThousands(r.totals.out)} | ${r.totals.first ? groupThousands(r.totals.first) : '—'} | ${r.totals.peak ? groupThousands(r.totals.peak) : '—'} | ${r.avgPromptPerStep === null ? '—' : groupThousands(r.avgPromptPerStep)} | ${leadShare} |`);
  }
  // 逐 run 的角色明细只在**有多个 scope**时展开，否则这一节会长到没人读（规则：可见 ≠ 倾倒）。
  // 每个 run 最多列 **8** 个 scope：真实 run 的 scope 数可达 36（长 run + 多个重派会话），
  // 全列出来会把这一节变成一堵墙 —— 那时读者会跳过整节，**可见性反而归零**。
  // 截断必须**说出来**（`另有 N 个`），否则会被读成"只有这 8 个"。
  const SCOPE_SHOWN = 8;
  const multi = runs.filter((r) => r.byScope.length > 1);
  if (multi.length) {
    out.push('');
    out.push('**按 scope 明细（每 run 取最贵的 8 个）**（prompt 总输入 = 未缓存 + 缓存；`×N` = 该 scope 有 N 个会话；`session-xxxx` = 角色认不出的会话，**不是**角色名）：');
    for (const r of multi) {
      const shown = r.byScope.slice(0, SCOPE_SHOWN);
      const parts = shown.map((s) => `${s.scope}${s.sessions > 1 ? `×${s.sessions}` : ''} ${groupThousands(s.in + s.cache)}${s.roleKnown ? '' : '（角色未识别）'}`);
      const rest = r.byScope.length - shown.length;
      const restSum = r.byScope.slice(SCOPE_SHOWN).reduce((a, s) => a + s.in + s.cache, 0);
      out.push(`- ${r.name}：${parts.join(' · ')}${rest > 0 ? ` · 另有 ${rest} 个 scope 合计 ${groupThousands(restSum)}` : ''}`);
    }
  }
  const noSteps = runs.filter((r) => r.missingSteps > 0).length;
  const noPeak = runs.filter((r) => r.missingPeak > 0).length;
  if (noSteps > 0 || noPeak > 0 || broken > 0) {
    out.push('');
    if (noSteps > 0) out.push(`- ⚠️ ${noSteps} 个 run 缺 \`steps\` ⇒ **算不出**每步均 prompt 与重放倍数（"算不出" ≠ "很小"）。`);
    if (noPeak > 0) out.push(`- ⚠️ ${noPeak} 个 run 缺 \`peak\` ⇒ 上下文峰值未登记。`);
    if (broken > 0) out.push(`- ⚠️ ${broken} 行 \`tokens:*\` 事件**没有一个解析出合法字段**（字段名写错会静默消失：in / cache / out / steps / peak / first）。`);
  }
  return out.join('\n');
}
