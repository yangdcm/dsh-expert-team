# 专家团 · dsh-expert-team

[English](README.en.md) | 中文

[![npm](https://img.shields.io/npm/v/@yangdcm/dsh-expert-team)](https://www.npmjs.com/package/@yangdcm/dsh-expert-team)
[![license](https://img.shields.io/npm/l/@yangdcm/dsh-expert-team)](https://github.com/yangdcm/dsh-expert-team/blob/main/LICENSE)
[![CI](https://github.com/yangdcm/dsh-expert-team/actions/workflows/ci.yml/badge.svg)](https://github.com/yangdcm/dsh-expert-team/actions/workflows/ci.yml)

![专家团：一句话组队交付](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/hero.svg)

> **一句话组队交付**：`/team 做一个带登录的支付模块` —— 自动组建 12 角色专家团，走
> 澄清 → 调研 → 设计 → 规格评审 → 方案确认 → 实现 → 审查 → 测试 → 交付 的门控流水线，
> 实现者直接改你工作区的代码，全程留痕成可复核的工件。

装在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的 dsh 插件：**零运行时依赖、无构建步骤、无安装钩子**。

| 12 角色 | 9 阶段 | 80 个测试文件 | 0 运行时依赖 | 0 构建步骤 |
|---|---|---|---|---|
| 各带人设 / `toolFilter` / `maxDepth: 1` | 含 1 道硬门 + 1 道确认门 | 含 136 条变异目录与多组棘轮 | `dependencies: {}` | 无 bundler、无 `prepare` 钩子 |

![9 阶段门控流水线](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/pipeline.svg)

<sub>图 1：9 阶段门控流水线。「规格评审」是**硬门** —— SPEC.md 的「边界与禁止项」没填就不放行（`lib/interception.js`）；「方案确认」是默认开启的**确认门**（`identity.keepPlanGate`，可在设置里关掉）；「实现」阶段按依赖 DAG **并行扇出**，多个实现者同时开工、各自只改自己那份文件。</sub>

---

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
  └─ 交付       docs         收尾结论与成本             → SUMMARY.md · METRICS.md

  全程留痕：TASKS.json · ROSTER.json · STATE.json · AUTHORITY.md · RUN.log.md
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
| **质量门禁** | 状态机一致性由**插件代码强制**（不是提示词请求）：任务未完成不能标 completed、质量问题必须由 qa/reviewer 裁决、覆盖率缺口、超轮次返工 —— 违规**实时**显示在浮层并计入 `/team status` |
| **收敛与记账** | 每 run 记 token/耗时/首产物时间/收尾预算；`/team learn` 跨 run 蒸馏经验，并在下次开工前回注 |

## 看一眼它在干什么

![质量门禁违规实时可见](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/panel-gate.png)

<sub>图 2：**门禁违规**。看顶部那条横幅 —— 违规项与拒绝理由（例如"SPEC.md 的边界章节已进入 `implement` 但仍无任何一行填写"）由 `lib/interception.js` 挂在宿主 `tools/post-execute` 上当场判出后推出，不是提示词提醒。</sub>

![成员模型与任务详情](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/panel-live.png)

<sub>图 3：**角色编制**。看成员列表 —— 谁在跑、用哪个模型、当前在做什么；展开任一成员可看它的任务与产物。模型可按角色分别配置，异构模型用于交叉验证。</sub>

![阶段推进与工件预览](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/panel-flow.png)

<sub>图 4：**阶段与工件**。看阶段条与预览区 —— 当前阶段、已过阶段、以及该阶段真正写下的工件正文（工件是唯一真源，浮层只是它的视图）。</sub>

![官方设置页里的专家团分节](https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/settings.png)

<sub>图 5：**设置**。看官方 `设置 →「专家团」` 这一页 —— 18 个设置项、中文标签、**改动即保存并即时生效**（上限/轮次/档位门/振荡检测在进程内重算）；值存在宿主命名空间 `expert-team`，随插件市场的备份/恢复一起走。</sub>

## 它为什么可靠

- **状态机由插件代码强制，不由提示词请求。** `lib/interception.js` 把「台账契约」与「规格边界」两条规则搬到宿主的
  `tools/post-execute` 瀑布上：重复 id / 环 / 自依赖当场顶回（`HARD_GRAPH_CODES`），SPEC 边界未填不许进实现
  （`SPEC_COMPLETE_PHASES`）。**规格沉默等于允许，那正是头号返工源。**
- **零运行时依赖、零 devDependencies、无构建步骤、无 `prepare`/`postinstall` 钩子。** 装完就是能跑的那份代码，
  没有"安装时执行未知脚本"这一层。
- **80 个测试文件 + 136 条变异目录。** `npm run test:all` 无需 `install` 即可跑（CI 跑的就是它）；
  `mutation-catalog` 要求每个变异体都至少被一个测试杀掉 —— 测试不是"跑绿了"，而是"能抓到错"。
- **多组棘轮（ratchet）测试**，把"已经想清楚的规矩"钉住，防止悄悄退化：
  `vocab-consistency`（术语与角色标签单一真源）、`scan-single-source`（同一事实不许有两个家）、
  `write-bypass-ratchet`（写侧不许绕过拦截）、`settings-consumers`（**每个设置项都必须有消费者**，白名单集合相等 ⇒ 只减不增）、
  `state-perf-guard`（子会话计时**零次**读日志，性能回归即红）。
- **两种零要分得清。** "我不知道有什么"与"确实没有"不长成同一个样子：工具面收窄失败时区分
  `no-known-names` / `nothing-to-deny`；`/state` 取不到时间戳时给 `hasTimestamp: false`，而不是用 `0` 冒充。
- **失败必须出声。** 写侧越界、工件分叉、超轮次返工一律**显式报错**，不做静默截断 —— 静默失败是本仓最贵的 bug 类型。
- **性能有实测、也有护栏。** 曾经 `/state` 会逐条全量读子会话日志：实测热态 7.1–9.8 s、冷态 283.6 s（75 个子会话），
  还会堵住整个 `dsh web` 的事件循环。1.3.5 改成只查表（实测 0.0026 ms/次、零次 `readSession`），
  **修复后的端到端数字待实机复测**；`state-perf-guard.test.mjs` 守着它不许回退。

## 安装

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

**方式二：插件市场**（收录尚未提交 ⇒ 目前可能搜不到）

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

## 快速上手

```
/team 做一个带登录的支付模块          # 一句话组队（一次性，自动组队并交付）
/team --persist 重构订单模块            # 持久化活团队：成员可反复指挥、跨会话恢复
/team --one-shot 跑一个小活             # 反向覆盖：即使默认设了持久化，这次也只跑一次
/team --no-code 评审现有 API 设计       # 只产出计划/评审/测试工件，不改代码
/team --code 直接改                     # 反向覆盖：即使默认设了"只出工件"，这次也动代码
/team --confirm 大改版需求              # 先建 run、不自动派工，浮层点「执行」才开工
/team uninstall                         # 回收本插件铺到 $DSH_HOME 的副本（skill 默认走运行时注册，本就不落地）
/team status                            # 所有 run 的阶段、成员、模型计划、实时违规
/team resume <run-id>                   # 跨会话恢复
```

完整命令（`/team canvas` 可视化画布、`/team codeindex` 代码索引、`/team learn` 自学习、
`/team limit` 配额、`/team settle` 冷启动清算……）见 `/team help`。

**产物落在哪**

- `<你的工作区>/team/<run-id>/` —— `SPEC / PLAN / TASKS / ROSTER / STATE / REVIEW / TEST / SUMMARY / RUN.log.md` 等工件
- `$DSH_HOME/expert-team/` —— 本机偏好与跨项目经验：`settings.json`、`session-runs.json`、`LEARNINGS.md`

## 插件结构

```
cordis.patch.yml       唯一的组合贡献：一个 host 面的 /team 命令行
lib/command.js         /team 命令：解析 + 建工作区 + 装 skill + 触发团队 + 11 条浮层路由
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

## 开发

```sh
npm run test:all        # 80 个测试文件，零依赖、无需 install（CI 跑的就是它）
npm run rename <新包名>  # fork 后改名：自动同步 13 个文件里 4 种包名写法
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

## 自定义预设（想改专家团默认行为时）

- **创建**：`设置 → Agent 预设 → 用「创造模式」创作自定义预设`（其机制是"复制一份既有预设"，产出落在 `$DSH_HOME/.agent-presets/<id>/`）。
- **要定制专家团，请以「专家团模式」为源、换一个你自己的 id**（例如 `my-team`）：复制出来的目录天然带上 12 个角色工具与它的 skill 目录，
  你的改动只写在 `my-team/` 里。**永远不要改 `expert-team/` 里的文件** —— 那份是插件所有的，加载/升级会整目录重铺覆盖。
- 新建的预设**可能要重启 `dsh web` 后**才出现在选择器里（宿主名册在启动时读取）。

## 诚实边界

- **本机来源守卫已就位，但不是鉴权**：11 条浮层路由统一校验 Host（挡 DNS rebinding）、
  写方法的 Origin（挡跨站写入）、客户端地址（挡局域网），写方法还要求 `application/json`
  （挡 form / text-plain 这类不触发预检的"简单请求"）；`/file` 改走宿主 `ctx.fs` 策略，
  读被策略拒绝时如实报 403 而**不退回裸读**。
  **残余风险如实说明**：本地非浏览器进程本来就能自造任意请求头，而 dsh 插件没有鉴权模型 ——
  所以别把 `dsh web` 暴露到不可信网络（宿主配置 `host: 0.0.0.0` 时，守卫只挡住"没有回环地址"的客户端）。
- **仅 web profile**：浮层与路由依赖 `webServer`；无浮层时命令与工件仍然可用。
- **preset 漂移**：随包的「专家团模式」是官方 `standard` preset 的拷贝 + 角色工具，
  宿主若调整内置 preset 结构，需要同步更新。升级插件时会按版本戳整目录重铺；
  `/team uninstall` 可回收它（用户自己写的同名 preset 不会被碰）。
- **会有意调用 `git status --porcelain`（只读）** 用于工件新鲜度判断。
- **未接线项不装作可用**：设置页的项要么真的生效，要么被标为「暂未生效」（由 `INERT_SETTINGS` 单一真源驱动），
  并由 `settings-consumers.test.mjs` 盯着 —— 目前该表为空。

## 兼容性

- `engines.dsh: >=0.1.5-rc.1`，声明在 `package.json` 的 `dsh.compatibility`（`dshReleases` 逐版本标注）；
  插件市场按它判断"这个插件跟你的宿主兼不兼容"。
- Node.js ≥ 20。
- profile：`web`（见上「诚实边界」）。

## License

MIT © yangdcm
