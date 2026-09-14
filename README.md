# 专家团 · dsh-expert-team

[English](README.en.md) | 中文

[![npm](https://img.shields.io/npm/v/@yangdcm/dsh-expert-team)](https://www.npmjs.com/package/@yangdcm/dsh-expert-team)
[![license](https://img.shields.io/npm/l/@yangdcm/dsh-expert-team)](LICENSE)
[![CI](https://github.com/yangdcm/dsh-expert-team/actions/workflows/ci.yml/badge.svg)](https://github.com/yangdcm/dsh-expert-team/actions/workflows/ci.yml)

> **一句话组队交付**：`/team 做一个带登录的支付模块` —— 自动组建 12 角色专家团，走
> 澄清 → 调研 → 设计 → 规格评审 → 方案确认 → 实现 → 审查 → 测试 → 交付 的门控流水线，
> 实现者直接改你工作区的代码，全程留痕成可复核的工件。

装在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的 dsh 插件，
**零运行时依赖、无构建步骤、无安装钩子**。

![质量门禁违规实时可见](docs/images/panel-gate.png)
![成员模型与任务详情](docs/images/panel-live.png)
![阶段推进与工件预览](docs/images/panel-flow.png)

<sub>截图即真实浮层：门禁违规横幅、角色编制（谁在跑、用哪个模型）、任务详情与工件预览。</sub>

---

## 它解决什么

单个 agent 干大活有三个固定失败模式：**上下文漂移**（长任务越做越偏）、**自己批自己**
（没人独立验证）、**返工不收敛**（同一个问题来回改）。专家团用四件事对付它们：

| 机制 | 做法 |
|---|---|
| **角色分工** | 12 个角色各带独立人设、工具边界（`toolFilter`）、委派深度（`maxDepth: 1`）；产品/架构只读写计划工件，审查/安全只读，实现者才动代码 |
| **阶段门控** | 9 个阶段，每次交接走「结构化返回值 + 工件文件」双通道，不靠聊天记录传状态 |
| **质量门禁** | 状态机一致性由**插件代码强制**（不是提示词请求）：任务未完成不能标 completed、质量问题必须由 qa/reviewer 裁决、覆盖率缺口、超轮次返工——违规**实时**显示在浮层并计入 `/team status` |
| **收敛与记账** | 每 run 记 token/耗时/首产物时间/收尾预算；`/team learn` 跨 run 蒸馏经验并在下次开工前回注 |

## 角色与阶段

**12 角色**：产品(pm) · 架构(architect) · 调研(researcher) · 界面设计(ui) · 后端(backend) ·
前端(frontend) · 数据(dba) · 安全审计(sec) · 评审(reviewer) · 测试(qa) · 运维(devops) · 文档(docs)。
按任务复杂度裁剪：小活只起需要的角色。

**9 阶段**：`澄清 → 调研 → 设计 → 规格评审 → 方案确认 → 实现 → 审查 → 测试 → 交付`
（`/team --tier 快速档|标准档|严格档` 控制流程档位）。

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
```

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
> **「专家团模式」preset 仍会复制**到 `$DSH_HOME/.agent-presets/`（宿主没有"运行时加扫描根"的
> API），但带版本戳：升级后整目录重铺，不会静默停在旧版本。用 `/team uninstall` 可回收本插件
> 铺下的副本（只删带我们版本戳的目录，用户自己写的同名内容一律保留）。
>
> **插件加载时就把 preset 铺到位**：`/team uninstall` 回收之后，重启 `dsh web` 即会**自愈重铺**（不需要手工救）。
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

## 快速上手

```
/team 做一个带登录的支付模块          # 一句话组队（一次性，自动组队并交付）
/team --persist 重构订单模块            # 持久化活团队：成员可反复指挥、跨会话恢复
/team --no-code 评审现有 API 设计       # 只产出计划/评审/测试工件，不改代码
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
lib/tier.js            流程档位词表的唯一真源
lib/metrics/           token 记账、首产物耗时、收尾预算、METRICS 渲染
lib/routes/            路由层共享件（统一 405/500/JSON 处理）
client.js              客户端浮层（模块加载器 bundle，仅 require('react')）
skills/expert-team/    编排「大脑」：SKILL.md + references/ + 工件模板
presets/expert-team/   「专家团模式」preset：12 个角色 subagent 工具实例
```

编排协议几乎全在 skill 里而非代码里 —— 这样团队协议可以随 skill 更新，不必改包。

## 开发

```sh
npm run test:all        # 75 个测试文件，零依赖、无需 install（CI 跑的就是它）
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

## 已知限制

- **本机来源守卫已就位，但不是鉴权**：11 条浮层路由现在统一校验 Host（挡 DNS rebinding）、
  写方法的 Origin（挡跨站写入）、客户端地址（挡局域网），写方法还要求 `application/json`
  （挡 form / text-plain 这类不触发预检的"简单请求"）；`/file` 改走宿主 `ctx.fs` 策略，
  读被策略拒绝时如实报 403 而**不退回裸读**。
  **残余风险如实说明**：本地非浏览器进程本来就能自造任意请求头，而 dsh 插件没有鉴权模型 ——
  所以别把 `dsh web` 暴露到不可信网络（宿主配置 `host: 0.0.0.0` 时，守卫只挡住"没有回环地址"的客户端）。
- **仅 web profile**：浮层与路由依赖 `webServer`；无浮层时命令与工件仍然可用。
- **preset 漂移**：随包的「专家团模式」是官方 `standard` preset 的拷贝 + 角色工具，
  宿主若调整内置 preset 结构，需要同步更新。升级插件时会按版本戳整目录重铺；
  `/team uninstall` 可回收它（用户自己写的同名 preset 不会被碰）。
- 会调用 `git status --porcelain`（只读）用于工件新鲜度判断。

## License

MIT © yangdcm
