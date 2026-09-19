# 专家团 · dsh-expert-team

[English](README.en.md) | 中文

[![npm](https://img.shields.io/npm/v/@yangdcm/dsh-expert-team)](https://www.npmjs.com/package/@yangdcm/dsh-expert-team)
[![license](https://img.shields.io/npm/l/@yangdcm/dsh-expert-team)](https://github.com/yangdcm/dsh-expert-team/blob/main/LICENSE)
[![CI](https://github.com/yangdcm/dsh-expert-team/actions/workflows/ci.yml/badge.svg)](https://github.com/yangdcm/dsh-expert-team/actions/workflows/ci.yml)

![dsh 专家团插件横幅：12 角色多智能体团队 · 9 阶段门控流水线 · 零运行时依赖](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/hero.svg)

> **一句话组队交付**：`/team 做一个带登录的支付模块` —— 给**中小团队与个人接单者**一支完整技术部：
> 自动组建 12 角色专家团（产品 / 架构 / 调研 / UI / 前后端 / 数据 / 安全 / 评审 / 测试 / 运维 / 文档），
> 走 澄清 → 调研 → 设计 → 规格评审 → 方案确认 → 实现 → 审查 → 测试 → 交付 的门控流水线；
> 实现者直接改你工作区的代码，**全过程留痕成可复核的工件**。

装在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的 dsh 插件：**零运行时依赖、无构建步骤、无安装钩子**。

| 12 角色 | 9 阶段 | 90 个测试文件 | 0 运行时依赖 | 0 构建步骤 |
|---|---|---|---|---|
| 各带人设 / `toolFilter` / `maxDepth: 1` | 含 1 道硬门 + 1 道确认门 | CI 每次 push 跑全套测试 | `dependencies: {}` | 无 bundler、无 `prepare` 钩子 |

> 零运行时依赖。推荐同时装 **Hindsight**（跨项目记忆）—— 见[依赖与推荐插件](#依赖与推荐插件--dependencies-and-recommended-plugins)。

## 上手：三步搞定

```sh
dsh plugin --profile web add @yangdcm/dsh-expert-team   # 1) 装
# 2) 重启一次 dsh web —— 插件加载时会自动把「专家团模式」预设铺好
```

3) 开新会话、切到 **「专家团模式」**，然后 `/team 做一个带登录的支付模块`。

看结果：输入框上方的**常驻状态条**（谁在跑）→ 点开**团队浮层**（阶段 / 成员 / 工件），
或 `/team canvas` 开全屏画布；落盘产物在 `<你的工作区>/team/<run-id>/`。
完整命令见[快速上手](#快速上手--quick-start)。

## 为谁而做

**给中小团队与个人接单者的一支「完整技术部」** —— 不用招人、不用攒团队：一句话拉起产品、架构、调研、
UI/UX、前后端、数据、安全、评审、测试、运维、文档这 12 个岗位，按 9 阶段门控流程交付，
实现者直接改你的代码库，全程留痕成可复核的工件。
![为谁而做：给中小团队与个人接单者的一支完整技术部 —— 产品经理/架构师/技术调研/UI/UX/后端/前端/数据/安全审计/代码评审/测试/运维/技术文档 12 个岗位编织进 9 阶段门控流水线](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/who-is-it-for.svg)

<sub>图 1：**为谁而做**。三类对象（中小公司内部工具与产品迭代 · 个人接单 / 外包交付 · 独立开发者做完整项目）共用同一套做法：把 12 个技术部岗位编织进一条 9 阶段门控流水线。注意底部那条橙色带 —— **你（lead）与 12 个岗位不在同一层**：你把关产品级与范围级决策，其余由团队推进。</sub>

| 技术部岗位 | 角色 | 在这个流程里做什么 |
|---|---|---|
| 产品经理 | `pm` | 澄清需求、写 `SPEC.md`，把边界与禁止项**前置** |
| 架构师 | `architect` | 方案与模块划分、依赖 DAG、`AUTHORITY.md` 单源 |
| 技术调研 | `researcher` | 取舍与出处，给结论不给流水账 |
| UI/UX | `ui` | 界面结构与交互 |
| 后端 / 前端 | `backend` / `frontend` | **只有实现者动代码**，各改自己那份文件 |
| 数据 | `dba` | schema / 迁移 / 查询 |
| 安全审计 | `sec` | 越权、注入、密钥与依赖风险 |
| 代码评审 | `reviewer` | 独立评审，**不能自批自过** |
| 测试 | `qa` | 覆盖缺口、边界用例、验收判据 |
| 运维 | `devops` | 构建、发布、环境与配置 |
| 技术文档 | `docs` | README / 手册 / 变更记录 |
| **你** | lead | 只拍板产品级与范围级决策，其余由团队推进 |

**典型场景**：中小公司内部工具与产品迭代 · 个人接单 / 外包交付 · 独立开发者做完整项目 ·
任何"需要有人独立验证"的长任务。

<sub>**适用性说明**：团队负责推进与验证，**产品级与范围级决策仍由你拍板** —— 边界清楚，才好放心把活交出去。</sub>

![专家团 9 阶段门控流水线：澄清→调研→设计→规格评审（硬门）→方案确认→实现（依赖 DAG 并行）→审查→测试→交付](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/pipeline.svg)

<sub>图 2：9 阶段门控流水线。「规格评审」是**硬门** —— SPEC.md 的「边界与禁止项」没填就不放行（`lib/interception.js`）；「方案确认」是默认开启的**确认门**（`identity.keepPlanGate`，可在设置里关掉）；「实现」阶段按依赖 DAG **并行扇出**，多个实现者同时开工、各自只改自己那份文件。</sub>

---
## 速览 / At a glance

| 项目 | 值 |
|---|---|
| 包名 | `@yangdcm/dsh-expert-team`（npm 公开包） |
| 仓库 | <https://github.com/yangdcm/dsh-expert-team> |
| 宿主 | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ≥ **0.1.5-rc.1**（`web` profile） |
| 运行时依赖 | **无**（`dependencies: {}`；`lib/` 只 import 同目录文件与 Node 内建） |
| Node.js | ≥ 20 |
| License | MIT |
| 安装（一行） | `dsh plugin --profile web add @yangdcm/dsh-expert-team` |
| 上手（一行） | 会话切到「专家团模式」→ `/team 做一个带登录的支付模块` |
| 过程产物 | `<你的工作区>/team/<run-id>/`（`SPEC.md` · `PLAN.md` · `TASKS.json` · `REVIEW.md` · `TEST.md` · `SUMMARY.md` …） |
| 本机数据 | `$DSH_HOME/expert-team/`（`settings.json` · `LEARNINGS.md` · `session-runs.json`） |

> dsh 插件 · DeepSeek Harness 多智能体（multi-agent）编排器：角色化 subagent 团队 · 依赖 DAG 并行 · 阶段门控 · 质量门禁 · 工件留痕。
>
> 给 LLM / 检索用的索引：[`llms.txt`](https://github.com/yangdcm/dsh-expert-team/blob/main/llms.txt)


## 30 秒看懂

```text
$ /team 做一个带登录的支付模块
  │
  ├─ 澄清       pm           问清边界与验收口径        → SPEC.md（含「边界与禁止项」）
  ├─ 调研       researcher   证据与选型                → RESEARCH.md
  ├─ 设计       architect    模块拆分与依赖 DAG        → PLAN.md
  ├─ 规格评审   reviewer     ▣ 硬门：边界没填不放行     ← 不过不进下一步
  ├─ 方案确认   你           ▣ 确认门（默认开，可关）
  ├─ 实现       backend …    按依赖 DAG 并行扇出        → 直接改你工作区的代码
  ├─ 审查       sec·reviewer 独立评审（换模型交叉验证） → REVIEW.md
  ├─ 测试       qa           复现、覆盖、回归           → TEST.md
  └─ 交付       docs         收尾结论               → SUMMARY.md

  全程留痕：TASKS.json · ROSTER.json · STATE.json · AUTHORITY.md · RUN.log.md
  聚合快照：`METRICS.md` 在 **`team/` 根**（`/team learn` 产出；不是 run 目录模板）
  落盘位置：<你的工作区>/team/<run-id>/
```

<sub>上表是「阶段 → 谁在做 → 落哪个工件」的对应关系（阶段名出自 `lib/vocab.js` 的唯一真源，工件名取自包内模板与代码）。想连它**正在做什么**一起看，用 `dsh web` 里的浮层，或 `/team canvas` 打开全屏画布。</sub>

## 为什么不是「一个 agent 硬做」

单个 agent 干大活有三个固定失败模式：**上下文漂移**（长任务越做越偏）、**自己批自己**（没人独立验证）、
**返工不收敛**（同一个问题来回改）。专家团用四件事对付它们：

| 机制 | 做法 |
|---|---|
| **角色分工** | 12 个角色各带独立人设、工具边界（`toolFilter`）、委派深度（`maxDepth: 1`）；产品/架构只读写计划工件，审查/安全只读，实现者才动代码 |
| **阶段门控** | 9 个阶段，每次交接走「结构化返回值 + 工件文件」双通道 —— 状态不靠聊天记录传递 |
| **质量门禁** | 状态机一致性由**插件代码强制**（不是提示词请求）：任务未完成不能标 completed、质量问题必须由 qa/reviewer 裁决、覆盖率缺口与超轮次返工 —— 违规**实时**显示在浮层并计入 `/team status`；**写侧归属门禁**：非负责人覆写他人工件**当场拒绝**（创建放行；绕过面见[适用性与边界](#适用性与边界)） |
| **收敛与记账** | 每 run 记 token/耗时/首产物时间/收尾预算；`/team learn` 跨 run 蒸馏经验，并在下次开工前回注 |

## 看一眼它在干什么

![专家团全屏画布：阶段条与进度、角色化 subagent 团队编制（谁在跑、用哪个模型）](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/canvas.png)

<sub>图 3：**全屏画布**。看阶段条与进度、团队编制（谁在跑、用哪个模型）、以及 `人 / 事 / 料 / 盘` 四个视角 —— 比浮层更完整的一层视图。</sub>

![专家团任务依赖图：任务按依赖 DAG 并行，含 repair 与 review 的返工闭环](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/canvas-tasks.png)

<sub>图 4：**任务依赖图** —— 11 个任务按依赖 DAG 并行推进；7 个完成、4 个失败。失败会触发 `repair` 与**独立复验**（`repair-1 → review-2 → repair-2 → review-3`），直到通过或被如实判为需修订 —— 这就是「返工不收敛」的硬门禁在真实运行里的样子。</sub>

![专家团质量门禁违规实时横幅：规格边界未填即被插件代码拦下](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/panel-gate.png)

<sub>图 5：**门禁违规**。看顶部那条横幅 —— 违规项与拒绝理由（例如"SPEC.md 的边界章节已进入 `implement` 但仍无任何一行填写"）由 `lib/interception.js` 挂在宿主 `tools/post-execute` 上当场判出后推出，不是提示词提醒。</sub>

![专家团浮层：角色成员列表、各自使用的模型、任务详情与工件预览](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/panel-live.png)

<sub>图 6：**角色编制**。看成员列表 —— 谁在跑、用哪个模型、当前在做什么；展开任一成员可看它的任务与产物。模型可按角色分别配置，异构模型用于交叉验证。</sub>

![专家团阶段推进视图：当前阶段、已过阶段与该阶段的工件正文](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/panel-flow.png)

<sub>图 7：**阶段与工件**。看阶段条与预览区 —— 当前阶段、已过阶段、以及该阶段真正写下的工件正文（工件是唯一真源，浮层只是它的视图）。</sub>

![DeepSeek Harness 官方设置页里的「专家团」分节：全部设置项、中文标签、改动即时生效](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/settings.png)

<sub>图 8：**设置**。看官方 `设置 →「专家团」` 这一页 —— 全部设置项、中文标签、**改动即保存并即时生效**（上限/轮次/档位门/振荡检测在进程内重算）；值存在宿主命名空间 `expert-team`，随插件市场的备份/恢复一起走。**唯一例外**是「记忆 → 记忆后端」：它要改 dsh profile 的补丁文件（`cordis.patch.yml`），需重启 `dsh web` 才生效 —— 那一行会自己把重启要求写在界面上。</sub>

**输入框正上方还有一条常驻状态条**（client 槽 `conversation.input.dock`，id `expert-team-subagents`，order 200）—— 有子代理在跑时是琥珀色横幅「N 个子代理运行中」+ 最多 3 个角色名 + 一个跳动圆点，点击它直接打开团队面板；没有在跑时只剩一行暗灰字「无子代理在运行」，会话或状态尚未就绪时则完全不渲染（判据与页头徽章同一条：`/state` 的 `agents[].activity === 'running'`）。

## 为什么值得装

- **一句话组队，交付到你的代码库。** `/team <一句话目标>` 拉起 12 角色团队走完九阶段门控，
  **实现者直接改你工作区的代码**；最终交付是 `SPEC / PLAN / TASKS / REVIEW / TEST / SUMMARY` 这类**可复核的文件**，
  不是一段聊天记录。
- **质量门禁是代码，不是提示词。** 未完成的任务不能标 `completed`；质量问题必须由 `qa` / `reviewer` 裁决；
  SPEC 的「边界与禁止项」**没填就不许进实现**（硬门）；覆盖率缺口与超轮次返工当场判出，并实时显示在浮层与 `/team status`
  —— 真实拦截的样子见[图 5](#看一眼它在干什么)。
- **过程看得见。** live 浮层（阶段 / 成员与逐角色模型 / 工件预览 / 人工决策按钮）＋ 全屏画布（`人 / 事 / 料 / 盘` 四视角）
  ＋ 任务依赖图与返工闭环；输入框上方还有一条常驻状态条，随时告诉你谁在跑。
- **装得干净、跑得省心。** 零运行时依赖（`dependencies: {}`）、无构建步骤、无 `prepare` / `postinstall` 钩子；
  skill 走**运行时注册**不落盘，预设带**版本戳**、升级整目录重铺（不会静默停在旧版本）。
- **会积累。** 常驻团队模式可反复指挥、跨会话恢复；`/team learn` 把跨 run 经验蒸馏后**下次开工前回注**；
  配合 Hindsight 还能跨项目召回（[推荐，非必需](#依赖与推荐插件--dependencies-and-recommended-plugins)）。

## 实测数字（带来源与条件）

| 指标 | 实测 | 条件 |
|---|---|---|
| `?section=summary` 响应 | 中位 **3.5–5.8 ms** | 真机（1.3.20 起）；95 个子代理 / 13 条 `STATE.members` / 104 个任务 |
| `?section=people,feed` 响应 | **4–13 ms**（1.3.19 为 ~280 ms/次，约 **70×**） | 同上；提速**没有靠丢成员**（`agents`/`stateMembers` 数量不变） |
| 历史最差（1.3.5 已修） | 热态 7.1–9.8 s、冷态 **283.6 s** | 1.3.5 之前：`/state` 逐条全量读 75 个子会话日志，并堵住 `dsh web` 事件循环 |
| 测试 | **90 个测试文件** | `npm run test:all`，零依赖、无需 `install`（CI 跑的就是它） |

以上都是**真机实测**；机器负载会影响绝对值，**不同负载下的数字不可直接比**。`state-perf-guard.test.mjs` 守着性能不许回退。

## 安装 / Installation

**要求**

- `dsh web`（本包在 **0.1.5-rc.1** 上开发与验证；更早版本未经测试）
- Node.js ≥ 20
- 会话使用 **「专家团模式」** preset 时，12 个角色工具（`subagent_pm` / `subagent_architect` / …）才可用；
  否则自动退回通用 `subagent`（角色人设写进 prompt），功能不丢、只是少了配置层的边界保证

**方式一：命令行（推荐）**

```sh
dsh plugin --profile web add @yangdcm/dsh-expert-team
# 然后重启 dsh web，使新 bundle 进入组合
```

**方式二：插件市场**（收录**已提交**、待上游合并；合并后即可在市场里搜到，未合并前请用方式一）

若已被收录：`dsh web` → **设置 → 插件市场** → 搜索「专家团」→ 一键安装 → 刷新页面。

**方式三：从源码（开发/未发布时）**

```sh
cd ~/.dsh/profiles/web
# package.json：dependencies 加 "@yangdcm/dsh-expert-team": "file:<本包绝对路径>"
# package.json：dsh.profile.bundles 加 "@yangdcm/dsh-expert-team"
pnpm install && dsh web
```

> **skill 不落地**：插件加载时就把 `expert-team` skill 作为**运行时条目**注册进宿主的 skill 注册表
> （相对资源用 `resourceBase` 指回包内目录），所以 `$DSH_HOME/skills/` 下不会出现副本 ——
> 卸载即干净。宿主没有 skill 注册表时才会回退为复制到 `$DSH_HOME/skills/`。
>
> **「专家团模式」preset 会复制**到 `$DSH_HOME/.agent-presets/`（宿主没有"运行时加扫描根"的 API），
> 但带版本戳：升级后整目录重铺，不会静默停在旧版本。**插件加载时就会把它铺到位** ——
> 所以 `/team uninstall` 回收之后，重启 `dsh web` 即会自愈重铺，不需要手工救。
>
> **设置在哪改**：**设置 →「专家团」** —— 官方设置菜单里的一整页（`settings.section` 槽，
> `id: expert-team`、`order: 50`），与其它插件的设置同一入口、同一套面板 chrome。数据层是宿主命名空间
> `expert-team`（宿主持有、随插件市场的**备份与恢复**一起走；改值后上限/轮次/档位门在进程内**即时重算**，
> 不必重启）。浮层里原来的「设」页签已移除 —— 同一份表单只在一处渲染。
> **诚实边界**：`默认班底`（角色 id 数组）刻意不上宿主 schema（类型表达不可靠），由该页里的对应控件与
> `$DSH_HOME/expert-team/settings.json` 负责；宿主没有 settings 服务时，全部设置退回该文件。
>
> **A 线开关**：设置里的「门禁 → 收窄 lead 工具面」（`gates.leadToolFace`，默认 `on`）决定
> 是否把执行类工具（`bash/write/edit/grep/glob`）从 lead 手上拿走、交给角色子代理。
> 也可用 `config.leadToolFace` 或环境变量 `DSH_EXPERT_TEAM_LEAD_TOOLFACE=off` 关闭。

### 装上之后怎么用

1. 装完**重启一次 `dsh web`**：插件加载时会把「专家团模式」预设自动铺到 `$DSH_HOME/.agent-presets/expert-team`
   （带版本戳，升级会整目录重铺）—— **不需要手工创建预设**。重启后预设选择器里就有「专家团模式」，
   12 个角色化专家 subagent 工具也全部就位（可在 `设置 → 插件 → 插件列表 → 会话插件` 看到它们）。
2. 会话切到「专家团模式」，再 `/team <一句话目标>`。
3. 改设置走 **设置 →「专家团」**（值存在宿主命名空间 `expert-team`，随插件市场的备份/恢复一起走）。

**排障**：预设丢了、或被同名预设占住 —— **重启一次 `dsh web` 即自愈**（插件加载会重铺），也可跑一次 `/team <任务>`。
细节见下面「排障」一节，其中包含那条最容易踩的坑：**不要**用 `expert-team` 这个 id 去「创建 preset」。

## 依赖与推荐插件 / Dependencies and recommended plugins

**必需**：无。本插件**零运行时依赖**（`package.json` 无 `dependencies` 字段；`lib/` 只 import 同目录文件与 Node 内建，
`client.js` 只 `require('react')`，由宿主提供），只要求宿主 `DeepSeek Harness ≥ 0.1.5-rc.1`（web profile）。
下面这些**不装也能跑完整个团队流程**，装上是为了让「跨项目记忆」「本地零 LLM 记忆」「费用显示」这类事真正兑现。

### 推荐：Hindsight 长期记忆（跨项目 / 跨会话）

```sh
dsh plugin --profile web add @vectorize-io/hindsight-coding-agents
```

- **为什么**：专家团的 skill 会在 clarify 前用 `hindsight_search_knowledge_pages` 召回其它项目落库的知识、
  在 deliver 时用 `hindsight_ingest_document` 把本次经验落库（标题「专家团经验 · <runId>」/「项目知识 · <cwd 名>」）。
- **不装会怎样**：**不报错、团队照常交付** —— 只是这些工具不存在、模型调不到，跨项目记忆这一环不生效。
  团队**自身**的跨 run 学习走本地文件（`$DSH_HOME/expert-team/LEARNINGS.md`、`<工作区>/team/LEARNINGS.md`），**与 Hindsight 无关**。
- **注意**：Hindsight 的记忆配置在 dsh 之外（服务地址/令牌/库命名），装完还要配它自己。

### 可选：Midas 本地记忆（零 LLM 成本）

```sh
npm i -g midas-memory-mcp
dsh plugin --profile web add @deepseek-ai/dsh-mcp-client
```

- **为什么**：Midas 是**本机**的零 LLM 记忆服务（MCP stdio，写本地 SQLite）—— 写入与召回都**不花 token**。
  在 `设置 →「专家团」→「记忆后端（Hindsight）· 诊断与配置」` 里把「写哪个后端」选成 `Midas` 之后，
  插件会把 `mcp-midas` 那一行写进 dsh profile 的补丁文件（显式带 `MIDAS_MCP_DB` 与 `cwd`、用**绝对路径**
  启动），记忆就从 Hindsight 换到本地。
- **不装会怎样**：**不报错**。默认后端是 `Hindsight`，什么都不改的人完全不受影响；只有当你**主动选了** `Midas`
  却还没装好时，设置页会当场给出**五态结论**（已接通 / 差一步 / 没装 / 装了起不来 / 探测不可用），
  并列出"缺哪一步 + 该敲哪条命令"——**不会**假装已经换过去了（记忆此刻仍走 Hindsight、仍按 token 计费）。
- **注意**：Midas **不做整会话摘要**（这是它的设计取舍，不是缺陷）—— 它只存/取你**显式写入**的事实与知识页；
  需要"总结整段对话"的场景仍应使用 Hindsight。另外：它依赖 Node 内建的 `node:sqlite`（需要较新的 Node）；
  记忆文件落在 `$DSH_HOME/storages/midas/memory.sqlite3`，目录由插件在切换时创建；装完必须**重启 `dsh web`**
  （profile 补丁是**加载 profile 时**读的）才真正生效。

### 可选：会话费用显示

```sh
dsh plugin --profile web add dsh-cost-meter
```

浮层「在用模型」那一行尾部写着「会话费用见 `dsh-cost-meter`」。**不装只是少了费用视图**，不影响任何团队功能。

### 只在你要用「插件市场」安装 / 备份恢复时

```sh
dsh plugin --profile web add dshmarket
```

`dshmarket` **不随宿主 dsh 发布**；README 的「方式二：插件市场」需要先装它。

> 另外，活动流里的工具名有**中文兜底**：`browser_*` → `已操作浏览器`、`mcp_connector_*` → `已操作连接器`、
> `dsh_im_*` → `已发文件`，认不出的显示「已执行操作」（见 `lib/command.js` 的 `TOOL_LABEL` / `TOOL_LABEL_FAMILIES`）。
> 装了 `dsh-browser` / `dsh-mcp-connector` / `@xmanrui/dsh-im` 之后，活动流里出现的就是它们真实的工具名与参数：
> **纯显示，装了更清楚，不装不影响团队功能。**

## 快速上手 / Quick start

| 命令 | 作用 |
|---|---|
| `/team <一句话目标>` | 一句话组队（一次性，自动组队并交付） |
| `/team --persist <任务>` | 持久化活团队：成员可反复指挥、跨会话恢复 |
| `/team --one-shot <任务>` | 反向覆盖：即使默认设了持久化，这次也只跑一次 |
| `/team --no-code <任务>` | 只产出计划/评审/测试工件，不改代码 |
| `/team --code <任务>` | 反向覆盖：即使默认"只出工件"，这次也动代码 |
| `/team --confirm <任务>` | 先建 run、不自动派工，浮层点「执行」才开工 |
| `/team --tier <档位> <任务>` | 指定流程档位（快速档 / 标准档 / 严格档） |
| `/team status` | 所有 run 的阶段、成员、模型计划、实时违规 |
| `/team models [<run>]` | 每个角色的成本 / 模型计划 |
| `/team canvas [<run>]` | 生成可视化团队画布（HTML）；`--watch` 实时刷新 |
| `/team learn` | 聚合日志 → `METRICS.md` + 蒸馏经验到 `LEARNINGS.md` |
| `/team wait [<run>]` | 查看在飞任务进展（不阻塞） |
| `/team resume <run-id>` | 跨会话恢复 |
| `/team uninstall` | 回收本插件铺到 `$DSH_HOME` 的副本（skill 走运行时注册，本就不落地） |

完整命令（`/team codeindex` 代码索引、`/team limit` 配额、`/team settle` 冷启动清算……）见 `/team help`。

**产物落在哪**

- `<你的工作区>/team/<run-id>/` —— `SPEC / PLAN / TASKS / ROSTER / STATE / REVIEW / TEST / SUMMARY / RUN.log.md` 等工件
- `$DSH_HOME/expert-team/` —— 本机偏好与跨项目经验：`settings.json`、`session-runs.json`、`LEARNINGS.md`

## 常见问题 / FAQ

**它到底是什么？** 一个装在本机 `dsh` 上的插件：`/team <一句话目标>` 会拉起一支 12 角色的 subagent 团队（产品 / 架构 / 调研 / UI / 前后端 / 数据 / 安全 / 评审 / 测试 / 运维 / 文档），按 9 阶段门控流程在你的工作区里交付，并把过程写成可复核的工件。

**和"直接让一个 agent 硬做"有什么区别？** 针对三个固定失败模式：**上下文漂移**（阶段与工件双通道交接）、**自己批自己**（评审/测试是独立角色，`qa`/`reviewer` 裁决才算过）、**返工不收敛**（超轮次与未闭环被硬门禁拦下并如实报错）。详见[为什么不是「一个 agent 硬做」](#为什么不是一个-agent-硬做)。

**必须再装别的插件吗？** **不必**。本插件零运行时依赖；Hindsight（跨项目记忆）是**推荐**、Midas（本地零 LLM 记忆）与 `dsh-cost-meter`（费用视图）是**可选**，不装也能跑完整个流程 —— 见[依赖与推荐插件](#依赖与推荐插件--dependencies-and-recommended-plugins)。

**支持哪些 dsh 版本？** `engines.dsh: >=0.1.5-rc.1`（开发与验证基线 0.1.5-rc.1）；更早版本未经测试。Node.js ≥ 20。

**数据放在哪？** 工件在你的工作区 `<workspace>/team/<run-id>/`；本机偏好与跨项目经验在 `$DSH_HOME/expert-team/`（`settings.json` / `LEARNINGS.md` / `session-runs.json`）。

**怎么卸载？** `/team uninstall` 回收它铺到 `$DSH_HOME` 的副本（skill 走运行时注册、本就不落地），再从命令行或插件市场移除插件。**注意**：`$DSH_HOME/expert-team/` 下的 `LEARNINGS.md` 等是**你的数据**，卸载不会删。

**会自己联网吗？** 不会主动联网：它只调用宿主提供的工具（文件、shell、子代理）；能不能联网取决于你给会话的工具面。

**支持哪些模型？** 由宿主决定；本插件支持**按角色分别配置模型**（浮层里能看到每个成员用哪个模型），异构模型可用于交叉验证。

**不切「专家团模式」preset 也能用吗？** 能。`/team` 是 host 平面命令，任何预设下都能跑；此时退回通用 `subagent`（角色人设写进 prompt），少的是配置层的边界保证（`toolFilter` / `maxDepth: 1`）。

**浮层/画布打开很慢？** 见[排障](#排障)。1.3.5 起 `/state` 不再逐条全量读子会话日志；升级到 ≥ 1.3.5 后重启 `dsh web` 即可（1.3.13 起首屏走 `?section=summary`，1.3.17 起重活也**有界**）。

**角色子代理起不来、报 `does not support reasoning effort`？** 这是**会话路由的模型没声明** `reasoningEfforts` 造成的，**不是本插件的问题** —— 宿主在**任何网络 I/O 之前**就把"请求的 effort"与"该模型公布的 efforts"比对，不匹配即拒。修法：在 `~/.dsh/settings.yaml` 的 `agent-default-model` 条目里给该模型补 `reasoningEfforts`（`off/low/high/max`），或把会话切到官方路由。**注意**：本 preset 里 **8 个角色声明 `high`、4 个声明 `low`** ⇒ 漏声明时**任何**带 effort 的角色都会被拒（"只有 low 失败"是假象：先派谁先报谁）。插件加载时会**预检并告警一行**（只告警、不阻断）。

**记忆没生效：报 `could not resize shared memory` 或返回一张 HTML 防火墙页？** 这两类错误都发生在**记忆后端（Hindsight）的服务端**，**不是本插件**，也不要把它们混成一件事：

- `… -> 500 {"detail":"could not resize shared memory segment … No space left on device"}` ⇒ 服务端 **PostgreSQL 分配共享内存失败**：自托管最常见成因是容器 `/dev/shm` 只有 64 MB（用 `--shm-size=1g` 重启容器），也可能是磁盘/inode 满（`df -h`）或并行度太高；
- `… -> 403 <!doctype html>…网站防火墙…` ⇒ **应用层返回了 403 的 HTML 页面**（该页自称「网站防火墙」）。这是**观察到的现象，不是根因**：能返回 HTML 403 的环节可能是反向代理 / 面板安全插件 / CDN / 临时拦截等，插件无法判定是哪一种，**也不给你未经证实的整改动作**。面板会告诉你这条失败**之后是否已有成功**：已恢复 ⇒ 只是历史记录；仍在持续 ⇒ 再去服务端逐层确认。

**怎么看**：`设置 →「专家团」→「记忆后端（Hindsight）· 诊断与配置」` 会显示配置文件路径、部署形态（`cloud`/`self-hosted`/`daemon`）、服务地址、**token 是否已配置（值不显示）**、以及**最近一条失败的分类与处理建议**，并可按需**探测一次连通性**（**连通 ≠ 鉴权成功**：401/403 也算"可达"）。页面顶部还有**记忆后端三选一**：`Hindsight`（自托管，按 token 计费）/ `Midas`（本地 SQLite、零 LLM 调用，写入/召回不花 token；**不做整会话摘要**）/ `不使用`（真的关掉：插件往 dsh profile 的补丁文件写一行 `- id: hindsight` + `disabled: true`）。选了 `Midas` 时同一块会给出**五态就绪结论**（已接通 / 差一步 / 没装 / 装了起不来 / 探测不可用）与**首装引导**（说清缺哪一步，并给出可复制的命令）—— 没装好时**如实说未接通**，绝不假装已经换过去了。它同时显示**实际生效状态**：补丁文件到底有没有禁用 Hindsight、设置与实际是否一致 —— 「你选了不使用」与「你选了 Hindsight 但连不上」在界面上是**两种不同的说法**（后者是故障，处置动作正好相反）。

重启语义：改 `serverMode`/`apiUrl` 需重启 `dsh web`；只改 `apiToken` 免重启（401 时会重读）；**改记忆后端选择**（真的动了 profile 补丁时）同样**必须重启**才生效 —— 那一条会自己把重启要求显示出来。配置区可改形态 / 地址 / token（token 输入框是 password，**不预填、不回显**，清除要再点一次确认）。

## 术语 / Glossary

**角色（12）**

| 中文 | English | 代码标识 |
|---|---|---|
| 产品 | Product | `pm` |
| 架构 | Architect | `architect` |
| 调研 | Researcher | `researcher` |
| 界面设计 | UI/UX | `ui` |
| 后端 | Backend | `backend` |
| 前端 | Frontend | `frontend` |
| 数据 | DBA | `dba` |
| 安全审计 | Security | `sec` |
| 评审 | Reviewer | `reviewer` |
| 测试 | QA | `qa` |
| 运维 | DevOps | `devops` |
| 文档 | Docs | `docs` |

**阶段（9）**：`clarify` 澄清 → `research` 调研 → `design` 设计 → `spec-review` 规格评审（**硬门**）→ `方案确认` 方案确认（**确认门**，默认开、可关）→ `implement` 实现 → `review` 审查 → `test` 测试 → `deliver` 交付。（id 与中文名的唯一真源是 `lib/vocab.js`。）

**主要工件**：`SPEC.md`（规格与边界）· `RESEARCH.md`（调研）· `PLAN.md`（方案）· `TASKS.json`（任务台账）· `ROSTER.json`（编制）· `STATE.json`（状态）· `AUTHORITY.md`（写入权限单源）· `REVIEW.md`（评审）· `TEST.md`（测试）· `SUMMARY.md`（交付总结）· `METRICS.md`（成本与耗时：**`team/` 根的聚合快照**，`/team learn` 产出）· `RUN.log.md`（运行日志）


**谁写**：每个工件由**产出它的角色**自己 `write` 进 `<run-dir>/`；lead **只读工件做门控与裁决**（它没有 `write` 工具）。`STATE.json` 与 `RUN.log.md` 由**运行时**维护。

## 插件结构

```
cordis.patch.yml       唯一的组合贡献：一个 host 面的 /team 命令行
lib/command.js         /team 命令：解析 + 建工作区 + 装 skill + 触发团队 + 全部浮层路由
lib/validate.js        状态机/质量门禁/容量上限的纯函数校验器
lib/interception.js    把「台账契约」「规格边界」搬到宿主 tools/post-execute 瀑布上（硬门在代码里）
lib/tier.js            流程档位词表的唯一真源
lib/vocab.js           阶段/角色/档位词表的唯一真源（host 与 client 两侧都从这里派生）
lib/metrics/           token 记账、首产物耗时、收尾预算、METRICS 渲染
lib/routes/            路由层共享件（统一 405/500/JSON 处理、本机来源守卫）
client.js              客户端浮层（模块加载器 bundle，仅 require('react')）
skills/expert-team/    编排「大脑」：SKILL.md + references/ + assets/templates/
presets/expert-team/   「专家团模式」preset：12 个角色 subagent 工具实例
```

编排协议几乎全在 skill 里而非代码里 —— 这样团队协议可以随 skill 更新，不必改包。

### 内部机制与保障范围（给贡献者与好奇者）

- **两条规则被搬到宿主 `tools/post-execute` 瀑布上**（`lib/interception.js`）：「台账契约」——重复 id / 环 / 自依赖当场顶回（`HARD_GRAPH_CODES`）；「规格边界」——SPEC 未填不许进实现（`SPEC_COMPLETE_PHASES`）。**规格沉默等于允许，那正是头号返工源。**
- **写侧归属门禁**挂在 `tools/pre-execute`（`lib/artifact-ownership.js`）：创建放行、覆写他人工件当场拒绝；**持 `bash` 的角色仍可能绕过**（已列进[适用性与边界](#适用性与边界)）。
- **90 个测试文件 + 172 条变异目录**：`npm run test:all` 零依赖、无需 `install`（CI 跑的就是它）。变异目录在 CI 里校验的是**形状**（id 唯一、每个变异体的 `find` 串在目标文件里恰好命中一次、条数与常量一致）；**变异体本身需手动注入**，**CI 目前不执行变异体** ⇒ 它是"防呆 + 防漂移"，**不是**"自动证明测试能抓错"。
- **多组棘轮（ratchet）**：`vocab-consistency`（术语与角色标签单一真源）、`scan-single-source`（同一事实不许有两个家）、`write-bypass-ratchet`（写侧不许绕过拦截）、`settings-consumers`（每个设置项都必须有消费者，白名单集合相等 ⇒ 只减不增）、`state-perf-guard`（子会话计时**零次**读日志，性能回归即红）。
- **两种零要分得清**："我不知道有什么"与"确实没有"不长成同一个样子 —— 工具面收窄失败时区分 `no-known-names` / `nothing-to-deny`；`/state` 取不到时间戳时给 `hasTimestamp: false`，而不是用 `0` 冒充。
- **失败必须出声**：写侧越界、工件分叉、超轮次返工一律**显式报错**，不做静默截断 —— 静默失败是本仓最贵的 bug 类型。

## 开发

```sh
npm run test:all        # 90 个测试文件，零依赖、无需 install（CI 跑的就是它）
npm run rename <新包名>  # fork 后改名：全树扫描并同步所有包名写法（预演会列出命中文件与写法）
npm run check:name      # 检查占位包名残留
```

`npm run gate`（`gate:preset` / `gate:sync` / `gate:evidence` / `gate:bypass` / `gate:mutation`）
是**开发机专用**门禁：`gate:sync` 比对本机 `$DSH_HOME` 下的自举副本，`gate:preset` 借用本机
dsh 安装里插件自带的 Config schema（dsh 路径自动探测，可用 `DSH_INSTALL` 覆盖），因此**不在 CI 里跑**。

## 排障

**设置菜单里找不到「专家团」那一页？** 确认版本 ≥ 1.3.0（`dsh plugin --profile web add @yangdcm/dsh-expert-team`
升级，或 `npm view @yangdcm/dsh-expert-team version` 看线上版本），然后**重启 `dsh web`** —— 1.3.0 之前没有这一页。

**「专家团模式」显示成裸 id（`expert-team`）、会话里没有 12 个角色工具？** 说明
`$DSH_HOME/.agent-presets/expert-team/` 里不是我们那份（被删过，或被一份同名预设占了）。按优先级修：

1. 跑一次 `/team <任意小任务>` —— 插件会用包内资产重铺一份带版本戳的（最省事；1.3.0 起插件加载时也会自动铺）；
2. 或从包内覆盖：`cp -f <包路径>/presets/expert-team/{agent.cordis.yml,preset.yml} ~/.dsh/.agent-presets/expert-team/`；
3. **不要**用同一个 id 在「设置 → Agent 预设」里「创建 preset」——那只会得到你选的**源**的组合（例如标准模式），
   不是我们这份。

改完**重启 `dsh web`**（预设名册在启动时固化，刷新页面不够），再开**新会话**（预设只在会话创建时固定）。

**浮层打开很慢 / 整个 `dsh web` 发卡？** 1.3.5 之前 `/state` 会逐条全量读子会话日志（实测热态 7–10 s、
冷态 283 s），并堵住事件循环。升级到 ≥ 1.3.5 后重启 `dsh web` 即可。

## 自定义预设 / Custom presets（想改专家团默认行为时）

- **创建**：`设置 → Agent 预设 → 用「创造模式」创作自定义预设`（其机制是"复制一份既有预设"，产出落在 `$DSH_HOME/.agent-presets/<id>/`）。
- **要定制专家团，请以「专家团模式」为源、换一个你自己的 id**（例如 `my-team`）：复制出来的目录天然带上 12 个角色工具与它的 skill 目录，
  你的改动只写在 `my-team/` 里。**永远不要改 `expert-team/` 里的文件** —— 那份是插件所有的，加载/升级会整目录重铺覆盖。
- 新建的预设**可能要重启 `dsh web` 后**才出现在选择器里（宿主名册在启动时读取）。

## 适用性与边界

- **本机来源守卫已就位，但不是鉴权**：全部浮层路由统一校验 Host（挡 DNS rebinding）、
  写方法的 Origin（挡跨站写入）、客户端地址（挡局域网），写方法还要求 `application/json`
  （挡 form / text-plain 这类不触发预检的"简单请求"）；`/file` 改走宿主 `ctx.fs` 策略，
  读被策略拒绝时如实报 403 而**不退回裸读**。
  **残余风险如实说明**：本地非浏览器进程本来就能自造任意请求头，而 dsh 插件没有鉴权模型 ——
  所以别把 `dsh web` 暴露到不可信网络（宿主配置 `host: 0.0.0.0` 时，守卫只挡住"没有回环地址"的客户端）。
- **浮层需要 `web` profile**：浮层与路由依赖 `webServer`；其它 profile 或无浮层场景下，`/team` 命令与工件协议**照常可用**（少的只是可视化那一层）。
- **写侧门禁的残余绕过面**：工件归属门禁守在 `write` / `edit` 通道上（创建放行、覆写他人工件当场拒绝）；
  **持 `bash` 的角色仍可能绕过它** —— 这是该机制的已知边界，见 `lib/artifact-ownership.js`。
- **preset 漂移**：随包的「专家团模式」是官方 `standard` preset 的拷贝 + 角色工具，
  宿主若调整内置 preset 结构，需要同步更新。升级插件时会按版本戳整目录重铺；
  `/team uninstall` 可回收它（用户自己写的同名 preset 不会被碰）。
- **会有意调用 `git status --porcelain`（只读）** 用于工件新鲜度判断。
- **本插件会改宿主 GUI 的一处展示顺序（默认开，可关）**：装上之后，**子代理列表**（会话头部那棵
  lineage 树）按「**最新在上**」显示。它**只改展示顺序**：插件遮蔽宿主把目录送到浏览器的那一个 remote 方法
  （`subagents/list` → `remoteExportList`）并反转数组；服务端 `listChildren` 的**写明契约**
  （`ordered by createdAt, then id`）**原样不动**，模型侧 `list_agents`、本插件自己的 `/state`、
  `listDescendants` 的 pre-order **都不受影响**。设置项 `display.subagentListNewestFirst` 可关掉；
  宿主结构不匹配时**自动退回宿主默认顺序**，并在设置页**如实显示「未生效」**（装了没生效绝不会假装生效）。
- **未接线项不装作可用**：设置页的项要么真的生效，要么被标为「暂未生效」（由 `INERT_SETTINGS` 单一真源驱动），
  并由 `settings-consumers.test.mjs` 盯着 —— 目前该表为空。

## 兼容性

- `engines.dsh: >=0.1.5-rc.1`，声明在 `package.json` 的 `dsh.compatibility`（`dshReleases` 逐版本标注）；
  插件市场按它判断"这个插件跟你的宿主兼不兼容"。
- Node.js ≥ 20。
- profile：`web`（见上「适用性与边界」）。

## 现在就试

- **装**：`dsh plugin --profile web add @yangdcm/dsh-expert-team`，然后重启一次 `dsh web`
- **跑**：新会话切「专家团模式」→ `/team 做一个带登录的支付模块`
- **反馈 / Star**：<https://github.com/yangdcm/dsh-expert-team>（issue 和 Star 都欢迎）
- **直接聊**：见下「作者与联系」—— 有问题、想反馈、或者想聊聊你打算怎么用它，都可以

## 作者与联系

有问题、想反馈，或者想聊聊你打算怎么用它，扫码加我微信：

<img src="https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/author-wechat.jpg" alt="作者微信二维码" width="220">

微信号：`ppppue` —— **二维码可能过期，微信号不变**，所以急事直接搜这个号；仓库里开 issue 也一样能找到我。

## License

MIT © yangdcm
