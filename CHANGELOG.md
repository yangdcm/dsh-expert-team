# 变更记录

本包遵循[语义化版本](https://semver.org/lang/zh-CN/)。dsh 宿主版本线的对应关系写在
`package.json` 的 `engines.dsh` 与 `dsh.compatibility` 里，插件市场按它判断"这个插件跟你的宿主兼不兼容"。

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
  - 出现在 **设置 → 插件 → 插件配置**，由宿主按我们给的 schema 渲染 —— schema 由
    `lib/settings.js` 的 `SETTINGS_SPEC` **生成**（字段/范围/默认值都是单一真源，不抄第二份）；
  - 随插件市场的**备份与恢复**一起走（市场只备份"profile 插件清单 + 设置"，自造 JSON 不在内）；
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
