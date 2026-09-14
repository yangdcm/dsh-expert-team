# 变更记录

本包遵循[语义化版本](https://semver.org/lang/zh-CN/)。dsh 宿主版本线的对应关系写在
`package.json` 的 `engines.dsh` 与 `dsh.compatibility` 里，插件市场按它判断"这个插件跟你的宿主兼不兼容"。

## 1.3.1

**只改文案与文档，不动任何功能逻辑。**

### 设置页那句"需重启"改成与事实一致

- 页面顶部原文是「改动即保存（`编制` / `门禁` 两类需重启 `dsh web` 后生效）」——这在 1.1.x 成立，
  **1.2.0 起不再成立**：设置写入后两条路径都会在进程内重算派生值（容量上限 `resolveLimits`、
  轮次上限 `resolveRoundLimits`、档位门 `resolveTierGate`、A 线开关 `resolveLeadToolFace`，见
  `reapplySettingsDerived()`）：
  - **宿主路径**（宿主有 settings 服务时，也就是官方面板/浮层实际在用的那条）：
    `scope.watch()` → `onResolved` → 重算；保存回执原文即"已在进程内重算，**无需重启**"；
  - **文件回退路径**（宿主不可用、写 `settings.json`）：路由里同样显式调用了重算；
    但该路径的保存回执仍按既有契约返回 `needsRestart: true`（被 `settings.test.mjs` 钉住），
    因此文案**不能一概而论**。
- 新文案如实覆盖两种形态：「改动即保存。宿主设置可用时（默认）上限与档位门在进程内即时重算，
  无需重启；若保存提示"重启后生效"，按提示操作。」（英文版同步）
- 没有测试断言过这句话，故无需改任何断言。

### README 新增「装上之后怎么用」

- 写实"装完**重启一次** `dsh web` 即自动就位"：插件加载时把「专家团模式」预设铺到
  `$DSH_HOME/.agent-presets/expert-team`（带版本戳、升级整目录重铺），**不需要手工创建预设**。
- 实测依据（2026-09-15）：删掉该目录模拟全新安装 → 仅重启一次 ⇒ 目录被**自动新建**
  （APFS birth time 落在该次启动内，比插件落盘晚 621 秒 ⇒ 排除"安装时铺"）、版本戳 = 插件版本、
  与包内逐字节一致；选择器里随即出现「专家团模式」，`会话插件` 页 12/12 角色行齐全。

### README 新增「自定义预设」

- 创建入口与机制（`设置 → Agent 预设 → 用「创造模式」创作自定义预设`，本质是"复制一份既有预设"）。
- 陷阱写清：**不要**用 `expert-team` 这个 id 去「创建 preset」——那只会得到所选**源**的组合
  （通常是标准模式），既不是我们的预设，还会占住该 id 让自动重铺失效；要给专家团做定制，
  请以「专家团模式」为源、**另用一个自己的 id**，改动只写在自己的目录里（`expert-team/` 归插件所有，
  加载/升级会整目录重铺）。
## 1.3.0

**设置页搬进官方「设置」菜单 + 预设在插件加载时就位 + 门禁两处修复**

### 设置页进官方设置菜单（`settings.section`）

- `client.js` 新增 `SettingsSection` 组件并通过 `ctx.slots.inject('settings.section', …)` 注册
  （`id: expert-team`、`order: 50`、label 走语言 thunk）⇒ 设置出现在 **设置 →「专家团」**，
  与其它插件的设置同一入口、同一套面板 chrome。
- **浮层第 5 个「设」页签已移除**：同一份表单不再两处渲染。
- 样式改由 `ensureCss()` 在 `apply()` 里注入 —— 官方设置菜单**可以在没有会话时打开**，
  而原实现只在 HeaderButton 渲染路径注入 CSS ⇒ 那种情况下面板是一堆裸控件。
- 读设置失败改为**显式报错 + 重试按钮**（旧写法把 404 静默变成 null ⇒ 永久停在"正在读取设置…"）。
- 数据层不变：宿主命名空间 `expert-team`（随插件市场的备份/恢复走；改值后上限/轮次/档位门即时重算）。
- **诚实边界**：`默认班底`（角色 id 数组）刻意不上宿主 schema（类型表达不可靠），
  继续由该页里的对应控件与 `$DSH_HOME/expert-team/settings.json` 负责。

### 预设在插件加载时就位（修一次真实事故）

- `apply()` 里 `void ensurePresetInstalled()` / `void ensureSkillInstalled()`：
  **插件装着 ⇒ 它的 preset 就该在位**（失败只 warn，绝不影响插件加载）。
- 事故：`/team uninstall` 按设计回收了 `$DSH_HOME/.agent-presets/expert-team`，而铺设此前只发生在
  `/team <任务>` 时 ⇒ **使用该预设的会话当场丢掉 12 个角色工具**（`subagent_pm`…），
  选择器里那条也退化成裸 id（只剩标准模式的描述）。现在加载即铺；对带我们版本戳的目录还会
  **整目录重铺** ⇒ 该状态可自愈；对"无戳且内容不像我们"的同名目录仍**不覆盖**（尊重用户内容）但会出声告警。
- `/team uninstall` 输出补契约说明：插件仍装着时，下次加载会重新铺一份；真正的卸载是在插件市场移除插件。

### 门禁修复（`scripts/check-sync.mjs`）

- **普通模式崩溃**：`ABSENT_OPTIONAL`（可选映射目标不存在）此前落进读 `onlySrc/onlyDst/differ` 的分支
  ⇒ `TypeError`；而 skill 是第一个映射，于是整份报告**一行都打不出来**。现在四种状态各有显式出口。
- `preset` 映射改为**可选**（全新安装、刚 uninstall 都属正常缺席；**存在时照旧逐文件比对**，
  仍能抓"改了源码没同步"）。
- `.expert-team-version`（归属标记、不是包内资产）计入忽略项 —— 否则 1.3.0 起每个用户带戳后
  `gate:sync` 会假红。

## 1.2.3

**给 lead 工具面收窄加开关**（因为 1.2.2 让一个从未生效的行为突然生效了）

- 背景：A 线"把执行类工具从 lead 手上拿走"此前因取错作用域**从未真正生效**，1.2.2 修好后它会
  立刻改变日常形态 —— expert-team 会话的 lead 不再持有 `bash/write/edit/grep/glob`。
  这是设计意图，但**没有开关的行为变更不该只留一个"忍着或回退版本"的选项**。
- 新增开关 `gates.leadToolFace`（`on`/`off`，默认 `on`）：优先级与档位门一致
  **`config.leadToolFace` > `DSH_EXPERT_TEAM_LEAD_TOOLFACE` > 设置（官方面板/浮层） > 默认 on**；
  非法值一律回默认 on（不猜、不报错 —— 与档位门同一条纪律）。
- 关掉时**出声一次**（`[expert-team] lead 工具面收窄已关闭…`）：否则"我明明关了"与
  "开关没生效"看起来一模一样。
## 1.2.2

**修掉"lead 工具面收窄静默失效"**（拿真机启动日志换来的）

- 症状：每次创建 agent 都刷一行 `lead 工具面**未**收窄（nothing-to-deny）… 宿主里这些名字一个都不存在`，
  而实际上模型可见的 `bash/write/edit/grep/glob` **存在** —— 结论不成立，收窄也没发生。
- 根因：宿主 `tools.view(scope)` **不传 scope = 全局视图**；0.1.5 起模型可见工具由 preset 注册在
  **agent 平面**，于是全局视图"非空但缺这几个名字"，纯函数据实报 `nothing-to-deny`。
  宿主自己的 `restrict()` 用的就是 `scopeOf(this.ctx)`，我们却用了不传 scope 的 `view()`。
- 修法：新增 `agentScopedToolNames()`（动态 import `@deepseek-ai/dsh-scope` 取 `scopeOf(agent.ctx)`，
  再 `view(scope)`）；取不到 scope 时返回 `knownNames: undefined` ⇒ 如实报 **no-known-names**
  （"我不知道有什么"），绝不再退化成"宿主里没有这些工具"这种不成立的结论。
- 告警去重：同一 status 每进程只喊一次（十行同样的 warn 会把"响亮"变成噪声，
  而噪声的代价是所有告警一起被降权）。两种零仍然分得清。
## 1.2.1

**卸载回收覆盖历史副本**（1.2.0 的补丁）

- `/team uninstall` 此前只遍历登记清单，而 **1.2.0 之前铺下的 skill/preset 没有登记过**
  （那时还没有清单）—— 从 1.1.x 升上来的用户跑它只会得到"没有需要回收的副本"，
  而 `$DSH_HOME/skills/expert-team` 里的旧副本仍在（`gate:sync` 会一直报漂移）。
  现在除清单外还会看两个众所周知的自举落点，判据仍是"有戳或身份对得上"，
  用户自己写的同名内容照样不动。
## 1.2.0

**安全加固（本机来源守卫）+ 自举安装收口 + 设置接进宿主命名空间**

### 设置接进宿主命名空间

- 插件加载时把设置注册为宿主命名空间 `expert-team`（`ctx.inject(['settings'], …)` 作为优雅降级边界）：
  - **数据层已就位**：设置由宿主服务持有，随插件市场的备份/恢复走；schema 由
    `lib/settings.js` 的 `SETTINGS_SPEC` **生成**（字段/范围/默认值单一真源，不抄第二份）。
    ⚠️ **更正（2026-09-14 实机核验）**：本节先前写的"出现在 设置 → 插件 → 插件配置"当时**并不成立** ——
    那张页面渲染的是「宿主服务的命名空间 ∩ 已注册卡片」的交集，我们只交付了数据层。
    → **已于 1.3.0 解决**：设置页走 `settings.section` 槽，作为 **设置 →「专家团」** 一整页出现
    （不是 dshmarket 那种"插件配置"卡片），见 1.3.0 段。
  - 改动**即时生效**：`scope.watch()` → 用同一份 `config` 重算容量上限/轮次上限/档位门，不必重启。
- `base` 用**当前生效设置**填充 ⇒ 面板一打开看到的就是真正在用的值，**不需要任何一次性迁移**；
  优先级不变：`schema 默认 < 我们传的 base < 官方面板用户层`。
- **诚实边界**：`roster.defaultRoles`（角色 id 数组或 null）**不上**官方面板 —— 它在 schemastery 里的
  表达方式跨版本没把握，一旦 schema 建错宿主会拒绝注册、面板里什么都看不到。该字段继续由浮层设置
  页签与 `$DSH_HOME/expert-team/settings.json` 负责；写入时**每个字段只进一个存储**
  （可表达的进宿主、表达不了的进文件），不制造"一个字段两个家"。
- 宿主没有 settings 服务、或 `@deepseek-ai/schemastery` 解析不到（例如在仓库里跑测试）⇒ 完全回退到
  `settings.json`，行为与 1.1.x 一致；失败原因会被记下并出声，不静默。
- `POST /settings` 响应新增 `settingsSource: 'host' | 'file'`，便于排查"这次改到底写哪儿了"。

### 自举安装收口

- **skill 改为运行时注册**（`ctx.skills.register`）：默认**一个文件都不再写到 `$DSH_HOME/skills`**，
  相对资源用 `resourceBase` 指回包内目录。宿主没有 skill 注册表时才回退到复制（行为与 1.1.x 相同）。
  宿主优先级是 项目条目 > 运行时条目 > 用户根，因此运行时注册还能压过历史遗留的旧副本。
- **preset 仍走复制**（宿主 `dsh-agent-presets` 没有"运行时加扫描根"的 API，roots 只来自配置），
  但现在：① 带**版本戳** `.expert-team-version`，升级后**整目录重铺**（旧实现"存在即 return"，
  于是插件升级后运行时永远停在旧副本，且没有任何报错）；② 登记到
  `$DSH_HOME/expert-team/installed.json`；③ 只在目标**确属本插件产物**时才覆盖
  （用户自己写的同名 preset 不认、不动）。
- 新增 **`/team uninstall`**：回收本插件铺到 `$DSH_HOME` 的副本（skill/preset 与清单本身），
  **只删带我们戳或身份可判定为本插件产物的目录**，用户内容一律保留并如实列出；幂等。
  它不碰工作区里的 `team/` 运行目录，也不碰插件包本身（那由插件市场卸载）。
- `scripts/check-sync.mjs`：skill 那一份副本改为**可选目标** —— 1.2.0 起它默认不存在，
  再按硬性目标比对就会在正常安装上误报漂移。

### 安全加固

**安全加固：浮层路由的本机来源守卫 + `/file` 走宿主策略**

- 11 条浮层路由（`/state` `/artifact` `/codeidx` `/file` `/decide` `/plan` `/plan/approve`
  `/plan/discard` `/task` `/metrics/refresh` `/settings`）此前只校验 HTTP 方法，现在在**唯一的注册入口**
  `registerLocal` 上统一套 `localOnly` 守卫：
  - `Host` 非回环 ⇒ 403 —— 挡 **DNS rebinding**（攻击页把自己的域名解析到 127.0.0.1 后即为同源）
  - **写方法**的 `Origin` 非回环 ⇒ 403 —— 挡跨站写入；GET 刻意放行，因为浏览器不会把无 CORS 头的
    响应体交给跨站页面，而放行它能保住 `/team canvas --watch` 生成的 `file://` 页面（`Origin: null`）
  - `socket.remoteAddress` 非回环 ⇒ 403 —— 挡局域网（宿主配 `host: 0.0.0.0` 时）
  - **写方法** `content-type` 非 `application/json` ⇒ 415 —— 挡 form / text-plain 这类不触发预检的简单请求
  - 三条规则都**只在相应头部存在时生效**：浏览器必然带 Host、POST 必然带 Origin，而本地非浏览器
    客户端本就能自造头部（插件没有鉴权模型，这一点写在 README 的已知限制里）
- `/file`：有宿主 `ctx.fs` 时改走宿主策略（`resolve` + `readText`），**策略拒绝时如实报 403，
  不再退回裸 `readFile`**；响应新增 `source: 'host-fs' | 'node-fs'` 便于排查
- 新增棘轮：`routes-shared.test.mjs` 断言 `lib/command.js` 里真正调用宿主 `register` 的地方只有
  `registerLocal` 内部那一处、11 条路由全部声明 `methods` —— 新加路由不可能忘记加固

## 1.1.1

**兼容性声明 + 可移植性修复**（不含功能变更）

- 新增 `engines.dsh: ">=0.1.5-rc.1"`、`dsh.compatibility`（含 `dshReleases` 与 `profiles: ["web"]`）
  与 `@deepseek-ai/dsh-*` 的 `peerDependencies`：市场卡片与插件市场据此显示宿主要求，
  不再一律显示"未知"。目前**实测通过**的宿主版本是 `0.1.5-rc.1`。
- 修复"只在作者机器上能过"的测试（这类问题会让任何 clone 下来跑 `npm run test:all` 的人全红）：
  - `flow.test.mjs` 原来读作者工作区里的真实 run 目录 → 夹具已入库 `regression.fixtures/waves.sample.json`
  - `log-parse-module.test.mjs` 原来读 `/tmp` 里的手工备份 → 基准已入库
    `regression.fixtures/live-keys-before-logparse.json`
  - `check-evidence.mjs` / `preview-dag.mjs` 不再假设"工作区根 = 包根往上两级"
  - `preset-lint.test.mjs` 在没有 dsh 的机器上跳过（而不是把它当成 15 项失败）
  - `token-accounting.test.mjs` 不再顶层静态导入 `zstdCompressSync`（Node 20 没有该导出）
- CI：Node 20 / 22 / 24 三档跑 `npm run test:all` 与包名残留检查；失败时把输出尾部贴成注解
  （job 日志下载需要仓库 admin 权限，注解无需鉴权）。

## 1.1.0

首次公开发布。

- 12 角色专家团（产品/架构/调研/界面设计/后端/前端/数据/安全审计/评审/测试/运维/文档）+
  9 阶段门控流水线（澄清 → 调研 → 设计 → 规格评审 → 方案确认 → 实现 → 审查 → 测试 → 交付）
- 共享工作区工件协议（`team/<run-id>/` 下的 SPEC / PLAN / TASKS / ROSTER / STATE / REVIEW / TEST / SUMMARY）
- 质量门禁由插件代码强制（状态机一致性、任务完成度、覆盖率、返工轮次），违规实时显示在浮层与 `/team status`
- live 团队浮层：阶段推进、成员与模型、任务 DAG、工件预览、人工决策按钮
- `/team` 命令面：一次性组队 / 持久化活团队 / 仅工件 / 先确认后开工 / 流程档位 / 画布 / 代码索引 /
  自学习 / 配额 / 冷启动清算
- 零运行时依赖、无构建步骤、无安装钩子
