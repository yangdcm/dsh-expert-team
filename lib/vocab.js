// 词表真源（B 线第 11b 项）：**面向用户的中文标签 / 角色关键词表 / 阶段词表 / 已知角色集合，只此一份。**
//
// 为什么要收拢：这些"同一个事实"在收拢前散着好几份 —— `KIND_ZH`、`ALLOWED_KINDS`、
// 以及**手写字符串** `ALLOWED_KINDS_ZH` 描述的是同一件事（合法任务类型），改一处漏两处是必然。
// 而本仓**头号返工源正是「一个事实多份拷贝」**（一次真实 run 里同类缺陷 6 例、占那批返工 14/29）。
// 收拢之后，「合法类型的中文清单」由 `KIND_ZH` **推导**出来，而不是再抄一遍。
//
// 边界（必须如实说，否则会被读成"词表已经全单源了"）：
//   **client.js 那一份搬不过来** —— 它是 `__ModuleLoader__` 工厂、不能 import 本模块。
//   host ↔ client 的等价性由 `vocab-consistency.test.mjs` 逐词盯着（关键词表缺一个词就红，
//   这正是当年真实分叉过的地方）。
//
// 本模块零 IO、零依赖、纯常量 + 纯函数 ⇒ 可被单独 import 与单测。

/**
 * 标签归一：去空白（含全角空格）+ 小写。
 * ⚠️ **与 `client.js` 里的同名实现必须语义一致**（`vocab-consistency.test.mjs` 会逐例比对，
 * 因为 `'UI 设计师'` 与 `'ui设计师'` 在两侧都必须等价）。
 */
export function roleLabelKey(s) {
  return String(s || '').replace(/[\s\u3000]+/g, '').toLowerCase();
}

/** 阶段 id 的完整词表（顺序即流水线顺序；`方案确认` 是中文阶段名，必须原样保留）。 */
export const PHASES = ['clarify', 'research', 'design', 'spec-review', '方案确认', 'implement', 'review', 'test', 'deliver'];

// ── 面向用户的展示词表（只用于文案；协议值、日志、命令参数一律保留英文 id）──────────
export const PHASE_ZH = { clarify: '澄清', research: '调研', design: '设计', 'spec-review': '规格评审', '方案确认': '方案确认', implement: '实现', review: '审查', test: '测试', deliver: '交付' };
export const STATUS_ZH = { pending: '待开始', claimed: '已领取', in_progress: '进行中', done: '已完成', completed: '已完成', rework: '待返工', blocked: '受阻', failed: '失败', cancelled: '已取消', running: '进行中', complete: '已完成', idle: '空闲', paused: '已暂停', draft: '草稿' };
export const KIND_ZH = { requirements: '需求', research: '调研', design: '设计', implementation: '编码实现', verification: '验证测试', review: '代码审查', repair: '返工修复', integration: '集成', work: '任务', quality: '质量自检' };
export const VERDICT_ZH = { pass: '通过', approved: '已通过', needs_revision: '需修订', reject: '驳回', rejected: '驳回', fail: '未通过', failed: '未通过', pending: '待判定', none: '未判定' };
export const ROLE_ZH = { pm: '产品', architect: '架构', researcher: '调研', ui: '界面设计', backend: '后端', frontend: '前端', dba: '数据', sec: '安全审计', reviewer: '评审', qa: '测试', devops: '运维', docs: '文档' };
export const MODE_ZH = { 'one-shot': '一次性', persist: '常驻' };
export const ACTIVITY_ZH = { running: '运行中', idle: '空闲', ready: '就绪', inactive: '未启动', done: '已完成', failed: '失败', '': '未启动' };
export const DELIVER_ZH = { 'code+artifacts': '代码+工件', 'artifacts-only': '仅工件' };

// ── 合法任务类型：**由 `KIND_ZH` 推导，不再手抄第二遍** ─────────────────────────
//
// 收拢前这里有三份描述同一件事的东西：`KIND_ZH`（中文标签）、`ALLOWED_KINDS`（英文枚举）、
// 手写字符串 `ALLOWED_KINDS_ZH`（诊断用中文清单）。三者必须一致，却没有任何东西保证一致 ——
// 实测就是"加了一个 kind，诊断文案里没有它"，而诊断文案恰恰是排查时被信任的那份。
/** 合法 `kind` 的闭集（客户端早已渲染这两套词表，此处不再拒绝真实存在的健康 run）。 */
export const ALLOWED_KINDS = new Set(Object.keys(KIND_ZH));
/** 诊断用的合法 kind 中文清单 —— **推导自 `KIND_ZH`**，不可能再与它分叉。 */
export const ALLOWED_KINDS_ZH = Object.values(KIND_ZH).join('/');

// ── 角色解析：关键词表（模糊匹配，"先命中先赢"）+ 精确中文标签表 ────────────────────
/**
 * 角色关键词表。**顺序敏感**：动态角色在前（它们的关键词与固定角色重叠，
 * 如「产品分析」vs「产品经理」）；`qa` 的 `重测`/`test` 也不能少 —— workflow 的验收腿
 * 标签形如「[重测] test-2 …」，不含「测试」二字，少了它们每一条验收腿都会变成"无角色"
 *（2026-09-11 实测）。
 */
export const SUB_ROLE_WORDS = [
  ['competitive-analyst', ['competitive', '竞品', '对标']],
  ['product-analyst', ['product-analyst', '产品分析', '收益成本', '差距分析']],
  ['pm', ['pm', '产品经理', '澄清', '起草', 'ultra spec', '需求', '规格']],
  ['architect', ['architect', '架构', 'chief', '接口契约']],
  ['researcher', ['research', '调研', '研究员', 'researcher', 'investigate', '现状']],
  ['backend', ['backend', '后端']],
  ['dba', ['dba', '数据', 'sql', 'ddl', '迁移', 'database', '表结构']],
  ['frontend', ['frontend', '前端', 'uni-app', 'uniapp']],
  ['ui', ['ui', '视觉', '界面', '走查', '设计', 'designer', 'design']],
  ['reviewer', ['review', '评审', '审查']],
  ['qa', ['qa', '测试', '重测', 'test', '验证']],
  ['sec', ['sec', '安全', '越权', '注入', '渗透', 'security']],
  ['devops', ['devops', '部署', '构建', 'cicd', '环境', '运维', '发布']],
  ['docs', ['docs', '文档', 'readme', '手册']],
];

/** 本插件认识的角色 id：固定班底 + 关键词表里出现过的动态角色。 */
export const KNOWN_ROLES = new Set([...SUB_ROLE_WORDS.map(([r]) => r), 'pm', 'architect', 'researcher', 'ui', 'backend', 'frontend', 'dba', 'sec', 'reviewer', 'qa', 'devops', 'docs']);

/**
 * 规范中文角色标签 → 角色 id（2026-09-11 起 prompt 与派工 label 用中文标签，见 ROLES.md）。
 *
 * 为什么需要**精确表**而不是只靠关键词：关键词是"按表序先命中先赢"的模糊匹配，而
 * `【…】` 里的标签是**显式声明**，必须确定命中（历史事故：`【pm】产品分析员协作` 被猜成
 * `product-analyst`、`【reviewer】测试用例复核` 被猜成 `qa`）。标签取值与浮层显示名一致
 * （client.js 的 `ROLE_TOOL` 名字），避免同一角色两套叫法。
 */
export const ROLE_LABELS_ZH = new Map(Object.entries({
  '产品经理': 'pm',
  '架构师': 'architect',
  '研究员': 'researcher',
  'UI 设计师': 'ui',
  '后端工程师': 'backend',
  '前端工程师': 'frontend',
  '数据工程师': 'dba',
  '安全审计员': 'sec',
  '审查官': 'reviewer',
  '测试员': 'qa',
  '运维': 'devops',
  '文档工程师': 'docs',
  '竞品分析师': 'competitive-analyst',
  '产品分析员': 'product-analyst',
  'UI 验证专家': 'ui-verifier',
  '故障诊断工程师': 'debugger',
}).map(([label, role]) => [roleLabelKey(label), role]));

// ── 取值助手（"取不到时显示什么"的展示策略；**不是**词表本身）────────────────────
// 放在词表真源旁边：它们是词表的**唯一合法消费者**，散到别处就会出现第二份"取不到显示什么"。

// 这里只留取值助手：它们表达的是"取不到时显示什么"的展示策略，不是词表本身。
export const phaseZh = (v) => (v == null || v === '') ? '—' : (PHASE_ZH[v] || String(v));
export const statusZh = (v) => (v == null || v === '') ? '—' : (STATUS_ZH[v] || String(v));
export const kindZh = (v) => (v == null || v === '') ? '任务' : (KIND_ZH[v] || String(v));
export const verdictZh = (v) => (v == null || v === '') ? '未判定' : (VERDICT_ZH[v] || String(v));
export const roleZh = (v) => (v == null || v === '') ? '—' : (ROLE_ZH[v] || String(v));
export const modeZh = (v) => (v == null || v === '') ? '' : (MODE_ZH[v] || String(v));
export const activityZh = (v) => (v == null) ? '—' : (ACTIVITY_ZH[String(v)] || String(v));
export const deliverZh = (v) => (v == null || v === '') ? '' : (DELIVER_ZH[v] || String(v));

/**
 * **默认班底**（`/team <task>` 不指定 profile 时的编制）。
 * 2026-09-13（B 线第 8 项 · command-parse）从 `command.js` 搬来这里：`command-parse.js` 的
 * `PROFILE_DEFS.delivery` 要引用它，而 `command.js` 又要 import `command-parse.js` ——
 * 留在 command.js 就成了**循环 import**。放在词表真源里，两边都从这儿取。
 * ⚠️ 与 `KNOWN_ROLES` 不是一回事：那份是"认识哪些角色"（含动态补位的），这份是"默认派哪些"。
 */
export const DEFAULT_ROLES = ['pm', 'architect', 'researcher', 'ui', 'backend', 'frontend', 'dba', 'sec', 'reviewer', 'qa', 'devops', 'docs'];
