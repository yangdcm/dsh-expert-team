// 流程档位（E 线之后的 G 线）· **档位词表的唯一真源**。
//
// 为什么要档位：拿一个真实 run 做的定量体检显示，**一个小项目也跑满了八阶段十二角色**
// （58 任务 / 74 次派工 / 9h54m）。问题不是"环节太多"，而是**没有选择** —— 无论项目大小
// 都是同一套流程。「流程太繁琐」的真正含义是"没有档位"。
//
// 三条设计红线（写死在代码里，不靠文档自觉）：
//   ① **档位只裁"角色与独立环节"，不裁验收面**：所有档位都必须有 `clarify`（含边界十问）
//      与交付前的真实校验 —— 这两条是本仓数据支持的资产，砍掉它们省下的不是时间而是质量。
//   ② **档位不改变验收标准**：`acceptanceCap` 限制的是**验收项条数**（小项目本来就没那么多），
//      不是"通过率"；通过率红线永远是 100%。
//   ③ **建议 ≠ 选择**（用户拍板 #5）：`suggestTier` 只出建议，每次新建 team 仍然要让用户
//      看到并确认一次；本模块**不**保存"上次的选择"，也不做默认沿用。

/** 规范档位 id（机器可读处一律用这三个值）。 */
export const TIERS = ['quick', 'standard', 'strict'];

/** 默认档位：没有任何信号时的兜底（也是 `suggestTier` 的兜底）。 */
export const DEFAULT_TIER = 'standard';

/** 中文标签（面向用户；`normalizeTier` 也认这几个词）。 */
export const TIER_LABELS_ZH = { quick: '快速档', standard: '标准档', strict: '严格档' };

/**
 * 各档的裁剪表（**唯一真源**：SKILL.md 的裁剪表、`/team status` 的输出、浮层徽标都从这里来）。
 *
 * 字段含义：
 *   - `phases`      —— 该档要走的阶段（其余阶段跳过；`clarify` 与 `deliver` 任何档位都在）。
 *   - `roleCap`     —— 角色数上限。
 *   - `defaultRoles`—— 该档的默认班底（用户可用 `--roles` 覆盖）。
 *   - `acceptanceCap` —— 验收项条数上限（`null` = 不设上限）。
 *   - `dispatchCap` —— 子代理派工次数上限（`null` = 不设）。
 *   - `independentReview` —— 是否有**独立**审查角色（false = 由 lead 自检 + qa 测试）。
 *   - `closing`     —— 交付前收尾强度。
 *   - `when`        —— 适用场景（写给人看，也是 `/team status` 的一行）。
 */
export const TIER_SPEC = {
  quick: {
    label: '快速档',
    when: '单页工具 / 单模块 / 原型 / 一次性脚本',
    phases: ['clarify', 'implement', 'test', 'deliver'],
    roleCap: 3,
    defaultRoles: ['pm', 'backend', 'qa'],
    acceptanceCap: 10,
    dispatchCap: 15,
    independentReview: false,
    closing: '回归 + 证据',
  },
  standard: {
    label: '标准档',
    when: '常规功能开发、中等重构',
    phases: ['clarify', 'research', 'design', 'spec-review', 'implement', 'review', 'test', 'deliver'],
    roleCap: 6,
    defaultRoles: ['pm', 'architect', 'backend', 'frontend', 'reviewer', 'qa'],
    acceptanceCap: 30,
    dispatchCap: 40,
    independentReview: true,
    closing: '回归 + 证据 + 冲突检查',
  },
  strict: {
    label: '严格档',
    when: '安全 / 支付 / 权限 / 数据迁移 / 跨模块重构',
    phases: ['clarify', 'research', 'design', 'spec-review', 'implement', 'review', 'test', 'deliver'],
    roleCap: 12,
    defaultRoles: ['pm', 'architect', 'researcher', 'ui', 'backend', 'frontend', 'dba', 'sec', 'reviewer', 'qa', 'devops', 'docs'],
    acceptanceCap: null,
    dispatchCap: null,
    independentReview: true,
    closing: '全量 + 真机 + 反向对照',
  },
};

/**
 * 把用户输入（英文 id / 中文标签 / 带"档"字的写法）归一成规范档位 id。
 * 认不出来返回 `null`（**不猜、不静默退回默认** —— 静默退回会让用户以为自己的选择生效了）。
 */
export function normalizeTier(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (TIERS.includes(s)) return s;
  for (const t of TIERS) {
    const zh = TIER_LABELS_ZH[t];
    if (s === zh.toLowerCase() || s === zh.replace('档', '').toLowerCase()) return t;
  }
  return null;
}

/** 档位的人读一行：`快速档（quick）· 角色 ≤3 · 验收项 ≤10 · 无独立审查`。 */
export function tierSummaryLine(tier) {
  const t = normalizeTier(tier) || DEFAULT_TIER;
  const s = TIER_SPEC[t];
  const acc = s.acceptanceCap === null ? '验收项不限' : `验收项 ≤${s.acceptanceCap}`;
  return `${TIER_LABELS_ZH[t]}（${t}）· 角色 ≤${s.roleCap} · ${acc} · ${s.independentReview ? '有独立审查' : '无独立审查（lead 自检 + qa 测试）'}`;
}

/** 高风险词：命中即意味着"用小档跑会出事"（安全/钱/权限/数据/并发）。 */
const RISKY_RE = /支付|付款|结算|退款|权限|鉴权|认证|登录|token|密钥|加密|隐私|审计|迁移|schema|数据库|建表|并发|死锁|事务|安全|注入|越权|删除|清库|上线|发布|跨模块|重构/i;

/**
 * 按项目规模 + 目标关键词**建议**档位（不是替你选）。
 *
 * 判定顺序（先安全后规模，任一"高风险"信号都优先）：
 *   ① 高风险词 ≥2 处，或高风险 × 大体量 ⇒ `strict`
 *   ② 高风险 ≥1 处 ⇒ `standard`（绝不 `quick`）
 *   ③ 无明显风险 + 小体量（文件 ≤80 且代码 ≤400KB）⇒ `quick`
 *   ④ 其余 ⇒ `standard`
 *
 * ⚠️ 规模用 **文件数 + 代码字节数**（都只要 `stat`，不读文件内容）—— 不用"行数"是因为
 * 数行要读每个文件的全文，在建 run 的关键路径上不值得（本仓已在别处实测过串行读盘的代价）。
 * 阈值按经验换算：400KB 源码 ≈ 1 万行量级。
 *
 * @param args.goal - 目标文本（可为空）。
 * @param args.fileCount - 代码文件数（缺省 = 规模未知）。
 * @param args.totalBytes - 代码总字节数（缺省 = 规模未知）。
 * @param args.capped - 文件枚举是否被上限截断（截断 ⇒ 一定是大项目）。
 * @returns `{ tier, reasons, signals }` —— `reasons` 是**给人看的依据**（建议必须可解释，否则用户无从判断要不要改）。
 */
export function suggestTier({ goal = '', fileCount = null, totalBytes = null, capped = false } = {}) {
  const safeGoal = String(goal || '');
  const riskyHits = safeGoal.match(new RegExp(RISKY_RE.source, 'gi')) || [];
  const uniqRisky = [...new Set(riskyHits.map((x) => x.toLowerCase()))];
  // 规模未知（null/非数字）时**不当作小**：误判成"小项目"会让安全敏感的活儿跑快速档。
  const sizeKnown = Number.isFinite(fileCount) && Number.isFinite(totalBytes);
  const heavy = capped || (Number.isFinite(fileCount) && fileCount > 500) || (Number.isFinite(totalBytes) && totalBytes > 5_000_000);
  const tiny = sizeKnown && !capped && fileCount <= 80 && totalBytes <= 400_000;
  const signals = { risky: uniqRisky, fileCount, totalBytes, sizeKnown, capped, heavy, tiny };
  const reasons = [];

  if (uniqRisky.length >= 2 || (uniqRisky.length >= 1 && heavy)) {
    reasons.push(`高风险词命中 ${uniqRisky.length} 处（${uniqRisky.slice(0, 4).join('、')}）${heavy ? ' + 大体量' : ''} ⇒ 一律按严格档，不省评审与安全角色`);
    return { tier: 'strict', reasons, signals };
  }
  if (uniqRisky.length === 1) {
    reasons.push(`高风险词命中「${uniqRisky[0]}」⇒ 至少标准档（快速档不跑独立审查，这里不能省）`);
    return { tier: 'standard', reasons, signals };
  }
  if (tiny) {
    reasons.push(`无明显高风险，且体量小（${fileCount} 个代码文件 / ${Math.round(totalBytes / 1024)}KB ≤ 80 / 400KB）⇒ 快速档：裁掉独立调研/设计/审查角色，保留 clarify 与交付前真实校验`);
    return { tier: 'quick', reasons, signals };
  }
  reasons.push(sizeKnown
    ? `无明显高风险，体量中等或偏大（${fileCount} 个代码文件 / ${Math.round(totalBytes / 1024)}KB）⇒ 标准档`
    : '规模未知（未统计到代码文件）⇒ **不按小项目处理**，取标准档');
  return { tier: 'standard', reasons, signals };
}

/**
 * 档位切换时**该不该按档改写班底**（纯函数 ⇒ 可单测）。
 *
 * 规则（一条，别加例外）：**只有当前班底仍是"未定制的基线班底"时才自动改写**。
 * 用户自己点过名的角色（`--roles`，或在面板里改过编制）**一律不动** ——
 * 档位是"流程强度"的档，**不是"替我删人"的档**；把人删掉比多跑几个角色贵得多。
 *
 * 何时调用：**派工开始前**（建 run 时显式 `--tier`、浮层选择档位的那一刻）。
 * **不**在 run 进行中改编制（那时成员已经领了活，改编制只会造成"谁负责这块"的真空）。
 *
 * @param tier - 目标档位。
 * @param currentRoles - 当前班底。
 * @param baselineRoles - "未定制"的基线班底（本包即 `DEFAULT_ROLES`）。
 * @returns 改写后的角色数组；**不该动时返回 `null`**（调用方据此决定要不要写盘与留痕）。
 */
export function narrowedRoles(tier, currentRoles, baselineRoles) {
  const t = normalizeTier(tier);
  if (!t) return null;
  const cur = (Array.isArray(currentRoles) ? currentRoles : []).join(',');
  const base = (Array.isArray(baselineRoles) ? baselineRoles : []).join(',');
  if (!cur || cur !== base) return null; // 用户定制过（或没有班底）⇒ 不动
  const next = TIER_SPEC[t].defaultRoles;
  if (next.join(',') === cur) return null; // 已经一致 ⇒ 无需改写
  return [...next];
}

/** `/team status` 用的多行说明（含适用场景与裁剪结果）。 */
export function tierDetailLines(tier) {
  const t = normalizeTier(tier) || DEFAULT_TIER;
  const s = TIER_SPEC[t];
  return [
    `- 档位：${tierSummaryLine(t)}`,
    `  · 适用：${s.when}`,
    `  · 阶段：${s.phases.join(' → ')}`,
    `  · 默认班底：${s.defaultRoles.join(', ')}（可用 \`--roles\` 覆盖，但**不得超过角色上限 ${s.roleCap}**）`,
    `  · 收尾强度：${s.closing}`,
    `  · 派工上限：${s.dispatchCap === null ? '不设' : `≤${s.dispatchCap}`}`,
  ];
}

/** 档位三选一的候选项（浮层卡片用；顺序固定为 quick → standard → strict）。 */
export function tierChoices() {
  return TIERS.map((t) => ({ tier: t, label: TIER_LABELS_ZH[t], when: TIER_SPEC[t].when }));
}
