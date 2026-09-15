# 变更记录

本包遵循[语义化版本](https://semver.org/lang/zh-CN/)。dsh 宿主版本线的对应关系写在
`package.json` 的 `engines.dsh` 与 `dsh.compatibility` 里，插件市场按它判断"这个插件跟你的宿主兼不兼容"。

## 1.3.15

**R1 从"协议约定"升级为 `write`/`edit` 通道的硬门禁**（写盘之前拦）+ 三处文档口径改准。

- **门禁语义：创建放行、覆写才拦。** 判据只需一次存在性查询、**不读内容**，因此可以挂在宿主
  `tools/pre-execute`（**写盘之前**，`{kind:"deny"}` 会短路在 dispatch 之前 ⇒ 真拦得住），
  与既有的 `post-execute` 内容级校验（台账/规格边界）分工并存、互不冲突。
  为什么必须"创建放行"：`SKILL.md` §3 要求**首个成员**一次性把 13 份骨架落到 `team/<run-id>/`，
  其中大多数**不属于它** —— 天真的"角色 ≠ 负责人就拦"会**直接打死建 run**。
- **唯一机读真源**：`lib/artifact-ownership.js` 的 `ARTIFACT_OWNERS`（"哪份工件归谁"只有这一份）。
  表格从两张真源推导（`SKILL.md` 的角色/产出表 + `WORKSPACE.md` 的文件/维护者表），
  口径是**宁可漏拦、不可误伤**：真源有歧义/多负责人就取宽松（`PLAN.md` = pm/architect/dba），
  `STATE.json`/`ROSTER.json` **显式为空数组**（运行时专属 ⇒ 角色一律不得覆写），
  "lead 口述 + 指派成员落盘"的那几份（`TASK.md`/`任务看板.md`/`SUMMARY.md`/`RUN.log.md`/`RETRO.md`）**不限制**。
- **fail-open 的每一种理由都有断言守着**：角色认不出、存在性查不到、目标不在 run 目录、非 `write`/`edit`、
  终态 run、门禁自身抛错 —— 一律放行，且**降级必留痕**（`ownership-gate-degraded`）。
  真实事故教训（`post-execute` 签名写错曾让**全工具瘫痪**）在这里被写成断言：门禁**绝不允许**成为工具故障源。
- ⚠️ **诚实边界**：只覆盖 `write`/`edit` 通道。preset 里持有 `bash` 的角色（backend/frontend/researcher/
  qa/dba/devops）理论上可用重定向绕过；**首版刻意不对 bash 参数做启发式检查**（易误伤）。
  对外表述应为"normal 通道有门"，不是"不可能违反"。
- **测试**：新增 `r1-ownership-gate.test.mjs`（判定矩阵 + 接线断言 + "所有权表只有一份"的单源棘轮）；
  `artifact-ownership.test.mjs` 扩到 8 条，新增 **F/G 双向一致性**（表→真源防发明拼错；真源→表防漏项）；
  变异目录 **+M138**（表失效 ⇒ 门禁静默失效 ⇒ 三处断言必红）。
- **文档改准**：
  ① `WORKSPACE.md` 的 `STATE.json.members` 示例原写作 `"backend:<subagentId>"`（**与代码相反**）
  ⇒ 改为 `<agentSessionId>:backend` 并标注真源（`ROSTER.json.members` 的对象形状是另一回事，未动）；
  ② `SKILL.md` 的 R1 段补"机读真源"与上述诚实边界；
  ③ **更正两版 README 里一处不成立的强声明** —— 原文写"`mutation-catalog` 要求每个变异体都至少被一个测试杀掉"，
  而 CI 实际只校验目录**形状**（id 唯一 / `find` 恰好命中一次 / 目标测试存在 / 条数一致），**变异体需手动注入**；
  同时把两处数字改准（测试文件 **84**、变异 **138**，中英与 `llms.txt` 一致）。

## 1.3.14

**性能收尾：同一时刻至多一条重活 + profile 补账**（性能修复 #4）

- **真相换了一次**：上一版（1.3.13）把首屏从 3.4 s 打到 9–16 ms ✓，但真机连续采样发现
  **重分节单次 4 805 ms、每 ≥6 s 一次**，而且**重活在飞时 summary 被拖到 772 ms**。
  本轮先补账、再按数据改。
- **profile 补账（`DSH_EXPERT_TEAM_STATE_PROFILE=1`）**：原先只有 `runs+select / subs / wfLabels / roles / tail`
  五个点，其中 `tail` 把"从角色解析之后到回响应"的**全部**工作都吞进一段（真机上那段约 2 s 无账）。
  现按执行顺序补齐：`people-enrich`（过滤/映射/登记/workflow 元数据/enrich）、`agents`（agents 映射 + 实时投影）、
  `assemble`（违规/schema 校验/告警）、`artifacts`（`RUN.log` 尾 + git）、`tail`（持久化 + 序列化）
  ⇒ **账目逐段对齐，不再有"无账的 2 秒"**。
- **`feed` 也依赖 subs**：原先只有 `want('people')` 才算 subs，于是单独请求 `section=feed` 会**静默返回空 feed**
  —— 典型的"两种零分不清"。现在 `needSubs = want('people') || want('feed')`，该花的一次枚举照花。
- **新增两道上限（都带如实降级）**：
  - `DSH_EXPERT_TEAM_ARTIFACTS_DEADLINE_MS`（默认 2 500 ms）：artifacts 段要读 `RUN.log` 尾、还要跑 `git`，
    是**全链最不可控**的一段。超期限就跳过，并如实记 `artifacts:deadline`（读完日志再超就记 `files:deadline`），
    跳过时**不写**那些键 —— 缺块 ≠ 空数据。
  - `DSH_EXPERT_TEAM_MAX_FEED_AGENTS`（默认 60）：feed 按子代理条数封顶，被挡住的条数记 `feed:<n>`。
- **客户端：重分节改为"只拉当前可见子标签那一块"**（此前无条件每 ≥6 s 拉 `people,feed,artifacts`）：
  - `team`（人）→ `people,feed`；`tasks`（事）→ `people,feed`；`info`（料）→ `artifacts`；
    **`board`（盘）→ 不拉任何重分节**（它只渲染 `runs[]`，而 runs 在 `summary` 里就有）；
  - 「事」点开任务详情（需要 `files`/`logTail`）时才**一次性**补拉 `artifacts`，不常驻；
  - 映射收敛成**只有两个 canonical 重分节 URL**（`people,feed` / `artifacts`）⇒ `stateHub` 的同 URL 在飞合并
    能把面板、画布、徽章压成**同一条**。
- **徽章不再与「料」标签并发两条重活**：徽章原先一直自己订阅 `people,feed`（2.5 s 一拍 ⇒ 重活常驻）。现在
  面板/画布开着时由它们**发布**同一份 payload（`publishToLive`，发布时**合并**：缺块 ≠ 空数据），
  徽章只在**无人发布**时才自己轮询，且节奏放宽到 **10 s**（子代理出现时另有 `liveTick()` 主动催一次）。
- **真机数字的解释（诚实标注口径）**：`4 805 ms ≈ 2 × 2 400 ms` —— 当时画布同时订阅了 `people,feed` 与
  `people,feed,artifacts` 两条**不同 URL** 的重活，服务端在同一事件循环上串行处理 ⇒ 各自看着慢一倍，
  并把 `summary` 拖到 772 ms。本轮把重活收敛成"同一时刻至多一条"，这类并发在结构上不再可能。
- 本机可复现的旁证（真实 run、进程内计时）：`snapshotRun` **1.3 ms**、`runLogTail` **0.3 ms**、
  `liveFiles`（git）**0.3 ms 冷 / 0.0 ms 命中缓存** ⇒ artifacts 段**不是**那 2 s 的来源，
  与"并发才是主因"的判断一致。
- 端到端复测仍归用户（本机装不进运行中的宿主）：预期**同一时刻只有一条重活**、
  `summary` 在重活在飞时仍为**十毫秒级**（此前 772 ms）、停留在某标签时后台不再出现不相干分节。
## 1.3.13

**渐进式状态：`/state` 支持 `?section=`，首屏与会话体量解耦**（性能修复 #3）

- 背景（真机实测，`DSH_EXPERT_TEAM_STATE_PROFILE=1` 分步）：完整负载里 `subs` **1 327–1 388 ms**、
  `roles` **638–869 ms**、`runs+select` 15–21 ms、`tail` 3 ms；重会话（20+ 子代理、仍在活跃写日志）
  总耗时 **2.1–6.2 s**，成本随「子代理数 × 日志体量」线性增长。
- 新增 `?section=summary|people|feed|artifacts`（逗号可多选；**缺省或 **ALL** = 完整负载、字段语义不变**
  ⇒ 老客户端/脚本/既有测试不受影响）：
  - `summary`（首屏用）：阶段/进度/计数/违规/告警 —— 真机 `snapshotRun` 中位 **0.3 ms**；
  - `people`：子会话清单/角色/成员时间线（最贵的那两块就在这里）；
  - `feed`：每 agent 最近事件；`artifacts`：`RUN.log` 尾 + 工作区改动文件。
- **上限 + 如实降级**：角色解析硬上限 `DSH_EXPERT_TEAM_MAX_ROLE_SUBS`（默认 60；超出部分如实进
  `degraded: "roles:<n>"`）；people 软期限 `DSH_EXPERT_TEAM_PEOPLE_DEADLINE_MS`（默认 2500 ms；超时跳过
  workflow 元数据并记 `wf:deadline`）。响应新增 `sections`/`degraded`/`degradedReason`（缺块 ≠ 空数据）。
- **副作用修正**：`summary` 路径不再触发「派工即登记」写 `STATE.json`（原先每轮询都可能因空 `subById`
  算出"清空成员"而覆写工件）⇒ **摘要轮询是纯读**。
- 客户端：**一快一慢双订阅**（`summary` 按 `pollMs`；`people,feed,artifacts` ≥ 6 s）＋
  `mergeStatePayload` **合并**（摘要那一拍不再抹掉已知成员）；`stateHub` 改为**按 URL 各自计时**
  （`stateHubBaseOf/DueAt`，tick 只发已到期的 URL）—— 旧实现"全局取最小 base、每 tick 拉全部 URL"
  正是"慢端点被快钟拖着跑"的根源。
- 口径对齐（同批）：`templates` 常量与两个 e2e 的"run 必需文件"清单**语义不同、关系确定**，
  由 `artifact-ownership.test.mjs` 的 **E 断言**钉死（常量 ≡ 模板目录；e2e 清单 ≡ 常量 ∪ `RUN.log.md`）；
  README/README.en/llms 写实 `METRICS.md` 的来源与位置（**`team/` 根的聚合快照**，`/team learn` 产出），
  并补一句 **R1 工件归属**（工件由产出它的角色自己写；lead 只读门控）。
- 验证：`npm run test:all` EXIT=0（**82 个测试文件**；新增 `state-sections.test.mjs`）；
  变异目录随源码文本**同提交**更新（`M70` 的 `find` 串）。

## 1.3.12

**面向"可被 AI 检索与引用"的文档与元数据补齐**（纯文档/元数据，代码与 1.3.11 完全相同）。

- README（中英各自对等）新增：
  - **速览 / At a glance** 事实表：包名 · npm · 仓库 · 宿主版本 · 运行时依赖 · Node · License · 一行安装 · 一行上手 · 过程产物路径 · 本机数据路径；
  - 一句**同义词行**（dsh 插件 · DeepSeek Harness 多智能体 · agent team · orchestration · 角色化 subagent · DAG 并行 · 阶段门控 · 质量门禁 · 工件留痕）—— 自然成句，不堆砌关键词；
  - **常见问题 / FAQ**：用自然语言问句覆盖「是什么 / 与"一个 agent 硬做"的区别 / 是否必须装别的插件 / 支持哪些 dsh 版本 / 数据放在哪 / 怎么卸载 / 会不会联网 / 支持哪些模型 / 不切 preset 能否用 / 打开很慢怎么办」；
  - **术语 / Glossary**：12 角色 ↔ 代码 id、9 阶段 ↔ id（以 `lib/vocab.js` 为唯一真源）、主要工件清单；
  - 主要小节标题改为**双语**（安装 / 依赖与推荐插件 / 快速上手 / 自定义预设 / 常见问题 / 术语）。
- **图片 alt 文本**全部换成带关键词的描述性文案（此前偏短 —— alt 是可机读文本，不该白丢）。
- 「快速上手」的命令块改为 **14 行速查表**（命令 + 一句话用途），措辞以 `lib/command-parse.js` 的 `USAGE` 为真源。
- 新增仓库根 [`llms.txt`](https://github.com/yangdcm/dsh-expert-team/blob/main/llms.txt)：按 [llmstxt.org](https://llmstxt.org) 约定给 LLM 用的索引 —— 事实块（可逐条核对）+ 文档链接（只列仓库里真实存在的文件）+ 诚实边界；README 顶部加一行指路。
- `package.json` `keywords` 补 4 个：`role-based` / `spec-driven` / `dag` / `agentic-workflow`（`description` 未动）。
- GitHub 仓库 topics 补齐：`ai-agents` / `agent-orchestration` / `multi-agent-systems` / `llm` / `cordis` / `code-generation` / `workflow-automation`。

> 两条**没有做**的（有意）：不写隐藏关键词/meta 标签（GitHub 会剥掉，且属取巧）；不写夸大话术 —— 本节所有事实都能在仓库或实测里核到。

## 1.3.11

**`/state` 的 `subs` / `roles` 两段收口 —— 这次不靠预测，靠 1.3.10 留下的分步计时开关实测定位。**
父会话在真机上带 `DSH_EXPERT_TEAM_STATE_PROFILE=1` 复测，拿到确切归属（同一台机器、同一 session、
连续两次请求）：

```
totalMs 2222 / 2047
profile.runs+select   21 / 15  ms   ✓ 便宜
profile.subs        1327 / 1388 ms  ✗ 主犯
profile.wfLabels       0 / 0   ms   ✓
profile.roles        869 / 638 ms  ✗ 次犯
profile.tail           3 / 3   ms   ✓
rolesBudget: {per:4, left:0, deferred: 16 → 40}   ← deferred 在**涨**
```

### ① `subs` 段：按 session id 备忘（并纠正两处"看起来像缓存、其实没用"的设置）

- **根因**：1.3.10 的"只在真缺人时才查"**没真正省下钱** —— 已结束/历史子会话本来就不在活注册表里，
  `missingIds` 每请求都非空 ⇒ 每请求都退化成对 **475 个 artifact 逐个读 header** 的枚举；
  而当时设的 **2 s TTL 恰好等于真实请求间隔**（轮询 + 退避），**必然过期** ⇒ 等于没有缓存。
- **改法**：新增 `SUB_HEADER_MEMO`（按 session id 永久记住 `createdAt/parentId/depth`）——
  这条分支上的 id 恰恰是"活注册表里查不到"的那些，其 header 不可变，记住它们不会让用户看到旧状态；
  枚举本身的主失效键改为 **`(sessions 根目录, mtimeMs, size)`**（`sessionsRootStamp()`，实测 0.56 ms），
  TTL 只作兜底并放宽到 **60 s**。
- **口径不变**：**活代理一律实时读，绝不进任何缓存**（有断言守着：活代理不写入备忘）。
- **折算前后**（单位成本取自上面的真机 profile：一次枚举 ≈ 1500–2400 ms，本机取 1800 ms）：
  **旧：每请求 ≈ 1800 ms；新：第 1 次 1800 ms，第 2 次起 0.02–0.09 ms** ⇒ 热态 `subs` ≈ **0 ms**。

### ② `roles` 段：限次摊平改成**跨请求推进的队列**

- **根因**：1.3.10 每请求都把候选集**从零重算**，预算永远喂给队首同几条，而新派的子代理不断出现在队尾
  ⇒ **进度不前进、`deferred` 只增不减**（实测 16 → 40）。"限次摊平"退化成"永远摊不完"。
- **改法**：模块级 `ROLE_PENDING` 队列 —— 每请求按"当前 subs 里仍未缓存"的顺序**重建队列**
  （已缓存的自动掉队、既有顺序保留、新人追加队尾），再从队首消费 ≤ 4 条；角色结果**永久缓存**
  （对已结束会话不可变）。`resetRoleReadBudget()` 只复位**本请求额度**，**不丢队列进度**。
- **两种零仍然分得开**：`deferred` = **还没解析**（队列长度，单调不增）；`unresolved` = **解析不出来**
  （读过但日志里没有角色）—— 新增这个数，正是为了不让两者混成一个。
- **实测（21 个子会话，每次 4 条预算）**：`deferred` **17 → 13 → 9 → 5 → 1 → 0**；
  6 个 tick 后**零次日志读**。折算：**旧 860 ms/请求且永不收敛 → 收敛后 ≈ 0 ms**。

### ③ 推荐插件自检的**假警报**（用户贴的启动日志直接坐实）

- **现象**：日志说 `@vectorize-io/hindsight-coding-agents` 与 `dsh-cost-meter`"已安装但当前不可用 ⇒
  `dsh plugin … add`"，**紧跟着 `dsh-cost-meter` 自己就加载成功了** ⇒ 判定是错的、建议是误导的。
- **根因（两条）**：① 我们的 `apply()` 跑在其它插件之前，那一刻 `ctx.get('costMeter')`/工具表里当然还没有它们；
  ② 对 `installed-not-ready` 也拼了安装命令，等于叫用户装一个**已经装好**的东西。
- **宿主没有 app 级 ready 事件**（已核源码）：`dsh-app-boot` 的 `boot()` 顺序是
  `mountRootInclude → await ctx.get('loader').await() → assertEntriesActivated → return`，
  期间不 emit 任何"就绪"事件；而 `loader.await()` 我们**不能用** —— 那棵树包含我们自己的挂载任务，
  在 init 里 await 它会**自等死锁**。
- **改法**：`scheduleOptionalPluginCheck()` —— **有界延迟重探**（250/1000/3000 ms，最后一次才下结论）
  ＋ **`ctx.inject([服务])` 事件驱动**（服务一出现立刻重探；服务始终不出现则回调不触发，零副作用）；
  外加 **`/team help` 懒重探**（刚装上/刚修好配置不必为了这行提示再重启）。
- **文案分档**：`missing` ⇒ 给安装命令；`installed-not-ready` ⇒ 只说"已安装但当前未就绪（可能未配置或被关闭）"，
  **不再给安装命令**；`unknown` ⇒ 不出现（四态与"两种零可区分"的语义不变）。

### 验证与口径

- `npm run test:all` **EXIT=0**（**80** 个测试文件；`state-perf-guard` 扩到 37 条断言：备忘只枚举一次、
  活代理不入备忘、目录戳失效、队列跨请求推进、deferred 单调不增、额度复位不丢进度、
  `installed-not-ready` 不含安装命令、服务晚挂不再误报、就绪后重探与懒重探的接线）。
- **诚实边界**：上面"折算前后"的数字是**用父会话真机实测的单位成本 × 新代码的调用次数**折算的
  （本机宿主仍跑 1.3.10，我无法把新代码装进运行中的进程）。**端到端 `totalMs` 请装完 1.3.11 后带
  `DSH_EXPERT_TEAM_STATE_PROFILE=1` 复测**：预期 `subs`/`roles` 两段都接近 0，
  `totalMs` 由 `runs+select`（~20 ms）+ `tail`（~3 ms）主导。

## 1.3.10

**四项一次收口：推荐插件自检 · 画布轮询也走 single-flight · 底盘缓存 · 角色解析限次。**
这一版全部由**真机实测**驱动，改动都带可复现的判据（下面每条都写明"改前 → 目标"）。

### ① 启动时自检推荐插件（缺了说一句，装了不吭声）

- 事实前提（只读调查）：本插件**零硬依赖** —— `package.json` 连 `dependencies` 字段都没有，
  全库没有一条外部 import；点名到的外部插件只有 `@vectorize-io/hindsight-coding-agents`（工具名
  `hindsight_*`）与 `dsh-cost-meter`，**缺了都不会报错**，只是少了对应体验。
- `detectOptionalPlugins(ctx)`（**纯读、无副作用**）三条探测路径：
  ① `ctx.get('loader').entries()` 的 `options.name` = **装没装**；
  ② `ctx.get('costMeter')`（服务名是**驼峰**）= 费用插件是否可用；
  ③ `ctx.get('tools').get('hindsight_ingest_document')` = **此刻能不能用** —— Hindsight 在
  "装了但未配置/被 opt-out"时**根本不注册工具**，所以这一条天然把「没装」与「装了没配」分开。
- 状态四态：`ready` / `missing` / `installed-not-ready` / `unknown`（loader 探测不可用 + 服务也
  拿不到时**不假装知道**，且不进提示）。
- 加载时**最多一行**（进程内去重），都齐则**完全不打扰**；`/team help` 里加一行说明。

### ② 客户端的**所有** /state 轮询统一走一个 hub（上一版只护住了面板）

- 实测问题：面板一套 `load()`（1.3.5 已加守卫），而 `HeaderButton` 徽章与画布另走 `liveStore` 的
  `setInterval(liveTick, 2500)` —— **画布一开就有 2–3 个轮询并发压同一个重端点**：10 秒 **7 发**、
  **6 次重叠**，单发被拖到 **5,891 / 8,347 ms**（并发叠加服务端约 2 s 的同步 CPU）。
- 现在只有 `stateHub` 一个时钟、一份在飞表：**同 URL 同刻只跑一次**（后来者复用在飞 promise）、
  全局单一时钟、统一退避 `clamp(max(基础间隔, 最慢一次×2), 基础间隔, 30000)`，
  团队有人跑时基础间隔按 40% 加速（面板原有意图，现在对徽章/画布同样生效）。
- 结构性护栏：`client.js` 里**不再存在**任何裸的 `fetch('/plugins/dsh-expert-team/state…')`
  （唯一调用点在 `stateHubFetch` 内），也**只剩一个** `setInterval(stateHubTick, …)`。

### ③ 底盘：`listSessions` 只在真缺人时查 + 并发合并 + 短 TTL

- 实测残留：`/state` 热态仍是 **2,887 / 2,603 ms**（诊断点名的"固定底盘 1500–2400 ms"）。
- 两处都遵循"**先证明需要，再花这笔钱**"：① 旧实现只要 `knownIds` 非空就无条件
  `listSessions()`（宿主侧 = 枚举全部 artifact、逐个读 header，本机 475 个、~1.5–2.4 s），
  现在先算"活注册表里查不到的人"，一个不缺就整段跳过；② 真的要查时**并发合并 + 2 s TTL**。
- **缓存纪律（写死在注释里）**：只服务"已结束/已释放子代理"这一支（其 header 不再变化）；
  **活代理一律走 listChildren/agents 实时读，绝不经过缓存**；失败不毒化缓存。
- 另加**分步计时**（`DSH_EXPERT_TEAM_STATE_PROFILE=1` 才收集，默认响应体不变）：
  `profile: {runs+select, subs, wfLabels, roles, tail, rolesBudget}` —— 让"哪一步还贵"下一次**可测**
  而不是靠猜。

### ④ 角色解析：**限次摊平**（不是流式，且不假装流式）

- 诊断建议"真流式：读到首条 `user/message` 即停"。**做不到**：宿主公开 API
  （`readSession/listEvents/filterEvents/readEvent`）**没有**投影/限量/流式参数
  （`projectionMode` 只在内部 corpus.read），要"只读首帧"只能碰持久化层的非契约内部方法。
- 改为**有界**：每次 `/state` 最多读 **4** 条子会话日志（角色结果**永久缓存** ⇒ 几个 tick 内收敛），
  其余留到下一 tick，并把"本轮被推迟"的条数作为 `rolesDeferred` **如实**交给调用方 ——
  「还没解析」与「解析不出来」两件事**分得清**（两种零可区分），**不臆造角色**。

> 本版**未**改文档/图片（`README*.md`、`docs/images/*` 是前几版刚定稿的）；未改 `files` 字段。

## 1.3.9

**新增第二张真实画布截图：`事` 视图（任务依赖图）**（纯文档/资产：`lib/`、`client.js` 零改动）。

- 素材：真实 `dsh web` 全屏画布的 **`事 11`** 子标签 —— 11 个任务按依赖 DAG 并行推进，图例显示「已完成 7 / 失败 4」；
  任务卡带 `T-01…T-05`、`repair-1/2`、`review-2/3`、`test-3` 与「任务·角色·判定」，节点右侧是轮次标记（`r3-a1` / `r2-a1`）。
  它同时展示 **DAG 并行** 与 **失败的返工闭环**（`repair-1 → review-2 → repair-2 → review-3`）。
- 裁切：`sips -c 570 1005 --cropOffset 85 275`，去掉左侧工作区 / 会话侧栏与底部合成器 + 费用页脚，产物 **1005×570**（120 KB）。
- 核验（不靠肉眼）：用 Node `zlib` **直接解 PNG 字节**（不经过 `sips` 探针）抽样 7 个点，
  裁图 `(x,y)` 与源图 `(x+275, y+85)` **逐像素相同** ⇒ 偏移精确、无像素改动。
- README(中英)：作为**图 3**（`Figure 3`）放在全屏画布（人）之后、三张窄浮层截图之前；其后图号顺延为图 4–7。

## 1.3.8

**定位前置 + 真实画布截图**（纯文档/资产版本 —— `lib/`、`client.js` 零改动）。

### README：新增「为谁而做」

放在**最显眼的位置**（顶部一句话组队交付 + 关键指标行之后、图 1 之前）：明确"**给中小团队与个人接单者的一支
「完整技术部」**"，并用一张「技术部岗位 → 角色 id → 在这个流程里做什么」的对照表把 12 个角色映射到真实岗位
（产品经理 `pm` / 架构师 `architect` / 调研 `researcher` / UI·UX `ui` / 后端 `backend` / 前端 `frontend` /
数据 `dba` / 安全 `sec` / 评审 `reviewer` / 测试 `qa` / 运维 `devops` / 文档 `docs`），
外加"**你**（lead）只拍板产品级与范围级决策"与典型场景。节尾一句**简短诚实边界**：它不是人类团队。
中英两版**信息对等**，口径克制（未使用"替代团队""比人强"这类说法）。

### hero.svg：新增定位 tagline

标题下方**独占一带**（新的 B2）写成「给中小团队与个人接单者的一支「完整技术部」」；
横幅高度 `260 → 300`，分带表扩成 6 带（B1 标题 / B2 tagline / B3 副标题 / B4 命令框·指标 / B5 进度条 / B6 页脚），
注释与重叠自检脚本的 BANDS 同步更新 ⇒ 加完这一行仍是 **0 部分相交、0 跨带**（21 元素 / 210 对比较）。

### 新增真实截图 `docs/images/canvas.png`（全屏画布）

- 素材：真实 `dsh web` 里掀开「🧑‍🔬 专家团」全屏画布后的截图（源 1280×800）。展示阶段条与进度、
  团队编制（谁在跑、用哪个模型）、`人 / 事 / 料 / 盘` 四个视角。
- 裁切：用 macOS 自带 `sips` 去掉**私人信息** —— 左侧工作区/会话侧栏（x < 275）与底部合成器 + 费用页脚
  （含余额/token 账，y > 545）：`sips -c 545 1005 --cropOffset 0 275`，产物 **1005×545**。
- 核验（不靠肉眼）：① 用 1×1 BMP 探针抽样 11 个点，裁图 `(x,y)` 与源图 `(x+275,y)` 逐字节相同；
  ② 再用 Node `zlib` **直接解 PNG 字节**确认裁图 `(0,0)` == 源图 `(275,0)`（`27,27,28`）⇒ 偏移精确、无像素改动。
- 在 README 中作为**图 2**（`Figure 2`）放在「看一眼它在干什么」**首位**（比三张窄浮层截图更有冲击力），
  其后四张图号顺延为图 3–6；中英同步。

### README：新增「依赖与推荐插件」

在「安装」之后新增一节，把"依赖"讲清楚：**必需：无** —— `package.json` **无 `dependencies` 字段**，
`lib/` 只 import 同目录文件与 Node 内建，`client.js` 只 `require('react')`（宿主提供），
只要求宿主 dsh ≥ 0.1.5-rc.1。Hindsight（跨项目记忆）、`dsh-cost-meter`（费用视图）、
`dshmarket`（市场安装 / 备份恢复）一律写成**推荐或可选 + 缺了会怎样**：
**不报错、团队照常交付**；并点明团队自身的跨 run 学习走本地 `LEARNINGS.md`，**与 Hindsight 无关**。
另说明活动流工具名的**中文兜底**（`TOOL_LABEL` / `TOOL_LABEL_FAMILIES`：`browser_*` → 已操作浏览器 等）。
顶部关键指标行附近加一行指针指向该节。中英对等。

## 1.3.7

**修掉 1.3.6 两张手绘矢量图的文字重叠，并让 npm 页面也能显示 README 图片。**

纯文档/资产版本 —— `lib/`、`client.js` **零改动**，无依赖变化，`files` 字段未动。

### 两张 SVG：改为**分带布局**（band layout）

上一版的问题不是"画得不好"，而是**两条信息共用了同一 y 带**：

- `hero.svg`：指标行与副标题同带 ⇒ 大数字 `12` **压在副标题尾部**；副标题/页脚在深底上对比度偏低。
- `pipeline.svg`：「硬门」徽标与图例行同带 ⇒ 徽标**压住图例第三项**「同一阶段内并行扇出」，
  「确认门」徽标也飘在图例那一行而不是它注记的方框上方。

改法：每张图先把垂直空间切成**互不重叠的带**，每个元素**只能落在自己的带内**，带范围写进文件注释便于后续修改。

- `hero.svg` 带表：B1 标题 `[44,84]` · B2 副标题 `[88,114]` · B3 命令框（左 x≤600）/ 指标（右 x≥636）`[118,178]`
  · B4 进度条 `[190,210]` · B5 页脚 `[218,246]`。指标整体下移，数字与图注留 7px 净空；
  副标题 `#94a3b8 → #c7d2fe`、页脚 `→ #a5b4fc`（深底对比度）。
- `pipeline.svg` 带表：B1 标题 `[30,60]` · B2 副标题 `[62,82]` · B3 图例 `[86,104]` · **B4 门徽标 `[110,136]`（独占一带）**
  · B5 阶段行 `[140,212]` · B6 并行扇出 `[212,330]` · B7 角色 chip `[334,382]` · B8 工件脚注 `[400,440]`。
  两个徽标各自落在**它注记的方框正上方**（硬门 → 规格评审 `x 428..532`；确认门 → 方案确认 `x 548..652`，
  徽标 x 区间被断言**包含于**对应方框）；阶段行下移 24px，全图高度 `430 → 460`；阶段间箭头的线段改为在箭头**起点**处结束，
  不再与箭头包围盒相交。

信息量未减：9 阶段、硬门/确认门的区分（规格评审=硬门；方案确认=确认门，默认开启、可在设置里关）、
DAG 并行扇出、角色 chip、工件脚注全部保留。

### 类级防复发：**真重叠自检**（这一环上一轮缺失）

上一轮只做了"矩形不越界"的几何自检，**抓不到"文字压文字"**。本次补上一次性自检脚本（`/tmp`，不提交）：

- 对每个 `<text>`/`<rect>`/`<path>` **估算包围盒**（CJK/全角按 `1.0em`、拉丁/数字按 `0.6em`，高 `1.2×font-size`，
  上 `0.9` / 下 `0.3` 于基线；`path` 按 `M/H/V/L/l/v` 逐段追踪绝对坐标）；
- **两两检测"部分相交"**（完全包含＝父子/背景关系，允许并单独列出）；
- **校验元素不跨带**（强制分带布局）；另做 x 越界与"徽标在对应方框正上方"的语义断言。

有效性验证：脚本先对 **1.3.6 的两张图**运行，**复现了报告里的两处重叠**（坐标级：副标题 `64,95.4→682.8,112.2` × `12` `636,94.8→669.6,128.4`；
`rect@446,88` × 图例第三项 `420,96.1→519,109.3`）；修复后两张图 **0 部分相交、0 跨带**（hero 190 对、pipeline 3403 对比较）。

### npm 页面上的 README 图片

`files` 未含 `docs/` ⇒ README 里的**相对**路径在 npm 页面渲染不到。改为**绝对地址**
`https://raw.githubusercontent.com/yangdcm/dsh-expert-team/main/docs/images/<file>`（中英各 6 处），
`LICENSE` 链接同样改为绝对地址。这样 GitHub、npm、以及将来插件市场的抽图都能用，且**不必**动 `files`（不增大产物）。

## 1.3.6

**文档与素材：README 重写成"能一眼看懂它在干什么"的结构，并补上手绘矢量图。**

纯文档/资产版本 —— `lib/`、`client.js` **零改动**，无依赖变化，`files` 字段未动。

### README（中英一致）

- 新骨架：一句话组队交付 → **一行关键指标** → 流水线图 → **30 秒看懂**（阶段 → 谁在做 → 落哪个工件，
  工件名全部取自包内模板与代码）→ 为什么不是"一个 agent 硬做" → **看一眼它在干什么**（图 2–5，逐图编号图注）
  → 它为什么可靠 → 安装/上手/插件结构/开发/排障/自定义预设/**诚实边界**/兼容性/许可。
- 新增"它为什么可靠"一节，把工程纪律写成可核对的卖点：状态机由**插件代码**强制（`lib/interception.js` 挂
  `tools/post-execute`）、零依赖零构建零安装钩子、**80 个测试文件**、**136 条变异目录**、多组棘轮
  （`vocab-consistency` / `scan-single-source` / `write-bypass-ratchet` / `settings-consumers` / `state-perf-guard`）、
  "两种零要分得清"、失败必须出声。
- 关键数字都标注了出处（`lib/vocab.js`、`presets/expert-team/agent.cordis.yml`、`package.json`），不写没有出处的指标；
  性能修复的端到端数字明确标注**待实机复测**。

### 新增素材

- `docs/images/pipeline.svg` —— 手绘矢量：9 阶段流水线、**硬门**（规格评审）与**确认门**（方案确认，默认开、可关）
  的区分、实现阶段的依赖 DAG 并行扇出、每阶段下挂角色 chip。
- `docs/images/hero.svg` —— 横幅（深色底、项目名、一句话、三个数字）。
- `docs/images/settings.png` —— 官方 `设置 →「专家团」` 分节截图（18 项、中文标签、改动即保存并即时生效）。
- 两张 SVG 均为**纯矢量**：无脚本、无 `<style>`、无外部引用（属性直挂，避免被托管方消毒器剥掉样式）。

### 已知取舍

- `files` 未包含 `docs/`，因此 **npm 页面上的 README 图片可能不显示**（GitHub 上正常）。若要两处都显示，
  需要把 `docs/images` 加进 `files`（改变产物契约）或改用绝对图片地址 —— 本轮**有意未改**，留待决定。

## 1.3.5

**性能：修掉 `/state` 的 30 秒级阻塞（它会把整个 `dsh web` 一起拖慢）**，另带两件早已排定的小事。

### 症状与根因（都是实测值，不是估算）

- `GET /plugins/dsh-expert-team/state` 实测 **热态 7.1–9.8 s、冷态 283.6 s**，而面板**绘制只要 52 ms**。
- **根因 D（最大头）**：端点对**每个**子会话 `await childSessionTiming`，而它对"活存储里查不到"的子代理
  退回 `sessionQuery.readSession(id)` —— 那是**全量读该子会话日志**。本机实测：单条最大日志
  **23.4 MiB（70,008 个 zstd frame）→ 解压 0.44 s / 45.4 MiB / 94,820 个事件**；21 条 >1MB 的会话日志
  仅"解压 + 过管道"就要 **1.11 s**（纯磁盘下限；host 还要逐行 `JSON.parse` + `structuredClone` + replay）。
- **根因 B**：`WF_EVENT_TTL_MS` 原来是 **3000 ms —— 恰好等于默认轮询间隔 3000 ms** ⇒ **每个 tick 必失效**，
  父会话日志（多 MB）被一遍遍全量重读。
- **根因 H3**：客户端**没有 single-flight** —— 实测 8 秒内发出 5 个 `/state`、其中 **4 个重叠**（上一个没回就发下一个）。
- **后果（这才最要紧）**：这些同步 CPU（≈2.3 s/请求）压在事件循环上，把**整个 web** 拖慢 ——
  轻量端点 `/settings` 实测被拖到 **20.7 s / 42.5 s**（关掉面板后仍在排队，因为积压已经形成）。

### 修复

- **热点 D**：新增 `subHeaderIndex()` —— 子会话时间**只查表、永不读日志**。三个来源都便宜：
  ① `listSubagentStatusBySession` 的 `listSessions()` 分支本来就顺带带出了 `createdAt/parentId/depth`；
  ② 活存储 `ctx.sessions.get(id).header`；③ workflow 事件流的 `startedAt`（父会话日志已按 TTL 缓存）。
  `/state` 的两个计时调用点全部改用它。三源都拿不到仍**如实降级** `0/''/0`（UI 显示「无时间记录」），**不臆造**。
- **热点 B**：`WF_EVENT_TTL_MS` 3000 → **30000**（TTL 只是兜底；代价是"run 在会话中途结束"最多晚 30 秒反映到面板）。
- **客户端**：`load()` 加 **single-flight**（未回绝不发下一个）+ **自适应退避**
  `clamp(max(基础间隔, 上次耗时×2), 基础间隔, 30000)`；`display.pollMs` 仍是基础节奏（设置说了算）。
- **写侧守卫**：`/state` 只在**该 session 真实存在**时才 `rememberSessionRun` 落盘 —— 诊断时一个**假 id**
  曾被写进 `$DSH_HOME/expert-team/session-runs.json`（污染用户数据）。

预计效果：热态从 7.1–9.8 s 降到 **0.15–0.4 s** 量级（以实机复测为准）。

### 另两件小事

- 设置页页头那句「标着「暂未生效」的项尚未接线…」改为**条件渲染**：`INERT_SETTINGS` 现在是空的，
  无条件渲染会让用户去找一个不存在的标注。判据直接取 hint 里的标记（与后端**同一真源**）。
- 新增反向参数 **`--one-shot`** / **`--code`**：1.3.4 把设置接成"无 flag 时的默认"之后出现不对称 ——
  设置成 `persist=true` / `artifacts-only` 后，单条命令**没法反悔**。解析改为**三态**
  （`true` 显式要 / `false` 显式不要 / `null` 未表态听设置），优先级仍是 **flag > 设置 > 常量**。
  （曾加过一个 `--no-persist` 别名，被本仓「实现了就必须有文档」的双向一致性断言挡下 ⇒ 去掉别名，一概念一名。）

### 护栏（进 `test:all`）

新增 `state-perf-guard.test.mjs`：热路径**零次 `readSession`**（spy 计数）、源码里不再有
`await childSessionTiming(ctx, s.id)`、客户端 single-flight 与退避公式、假 id 不落盘、三态反向参数与优先级。

### 1.3.6 待办（诊断列出、本版**有意不做**，避免扩大范围）

懒加载分节（`?section=people`）、`roleFromChildLog` 流式首帧、`listPersisted` 475 个文件的 header 缓存、
`maxSubs` / deadline 截断。
## 1.3.4

**把 1.3.2 留下的 7 个"有持久化、无消费者"的设置真的接上**（display 4 + roster 3），并清掉当时的假承诺。

- **display 四项**（此前只有存储层、零消费者；根因是客户端**全仓只有一处 `/settings` 拉取**、且只在设置表单里）：
  - `pollMs`：浮层/面板轮询与画布 `--watch` 轮询都读它（此前分别写死 3000/1200 与 3000）；
  - `capsuleMs`：**真正实现**"胶囊 N 毫秒后自动消失"。此前只入队、**永不自动出队** —— 旧代码里的
    `4000` 是**同文本去重窗口**、被误当成停留时长，所以这个功能**压根不存在**；`0 = 不自动消失` 保留；
  - `panelWidth`：设置值 = **默认宽度**；拖动结束**防抖写回设置**（单一真源，localStorage 只作首帧缓存），
    并把三处互不一致的默认/值域对齐（设置 280..900/420、拖动 clamp 640→900、CSS 与画布回退 360→420）；
  - `defaultTab`：面板初始页签取设置（用户点过就以点击为准）。
  - 新增**客户端设置桥** `useDisplaySettings()`/`EXPERT_DISPLAY`：挂载时拉一次，**保存成功即当场生效**
    （不必重启/刷新）；失败静默回默认值，不影响面板工作。
- **roster 三项**：命令行**没给**对应参数时用设置兜底，优先级 **flag > 设置 > 常量**：
  - `deliverable`（`artifacts-only` ⇒ `noCode`）、`persist`、`defaultRoles`；
  - **档位收窄的基线也跟着设置走**（否则"设了默认班底"会让 `--tier` 静默失效）；
  - 落点是 `createRun` 的**唯一一处**（覆盖 `/team`、浮层决策、`/decide` 等所有建 run 入口），
    判定抽成纯函数 `resolveRosterDefaults()` 便于单测；`--profile` 点过名的仍优先于设置。
- **清掉假承诺**：`INERT_SETTINGS` 现为**空对象**（7 项全部接线，机制保留作棘轮落点）；
  标记文案改为**版本中立**（`（暂未生效：尚未接线 —— …）`），并**移除用户可见文案里的行号**
  （行号会腐烂、且对用户无意义 —— 证据一律写进代码注释）。
- **新增护栏** `settings-wiring.test.mjs`（进 `npm run test:all`）：roster 三项**行为级**（真跑 `createRun`，
  断言 `STATE.json`/`ROSTER.json`/`RUN.log` 三处一致 + flag 优先级 + 档位收窄基线）、画布轮询**行为级**
  （生成的 live 脚本里就是设置值；越界回默认）、`gates.loopGuard` 的 **getter 语义**（同一钩子实例下改设置
  ⇒ 行为**双向即时翻转**、**无需重建钩子**），display 四项为**源码级**断言（本包无 DOM、不引依赖）。
- **更正 1.3.2 的描述**：1.3.2 曾写"待 1.3.3 接线"，而 1.3.3 实际发的是宿主 schema 的枚举中文描述，
  接线在本版完成 —— 因此标记文案改为**不承诺版本号**。

## 1.3.3

**宿主 schema 的枚举成员带上中文描述**（1.3.2 记录为"跳过"的那条，实测后补上）。

- 1.3.2 记的是"无法核实 schemastery 的可靠写法 ⇒ 跳过"；随后查到其类型定义里
  `description(text)` 的注释就写着 **"for documentation or form UIs"**，且用真 schemastery 实测：
  `z.const('developer').description('技术开发者')` 能把标签写进成员的 `meta.description`，
  schema 照常建成、**值域/类型/默认值完全不变** ⇒ 于是补上（`buildHostSchema` 里按
  "方法确实存在才调用" 的既定纪律挂描述）。
- 本版**无功能改动之外的任何行为变化**；对设置页无影响（那一侧用 1.3.2 的 `labels`）。

## 1.3.2

**诚实性收口：把"点了没反应"的设置项要么接线、要么如实标注。**
起因是一次审核（两轮独立只读核验 + 全库 grep）：20 个设置项里 **10 项的设置值没有任何消费者** ——
用户在设置页勾了、改了，什么都不会发生。本版处理其中 3 项，并把剩下 7 项**如实标注** +
登记在**单一真源** `INERT_SETTINGS` 里（界面上直接可见）。

### 接线：`gates.loopGuard`（唯一"变成真的"的开关）

- 事实：行为在（`lib/loop-guard.js`）、模块能力也在（`loop-guard.test.mjs` 已证明 `{enabled:false}` 完全放行），
  但**设置值从未被读** —— 真正决定开关的是 `config.loopGuard.enabled`，而默认 bundle 的
  `cordis.patch.yml` 两条 insert 行都没有 config 字段 ⇒ 设置页那个复选框是空转的。
- 接法照 `resolveTierGate` / `resolveLeadToolFace` 同一套：**config > env（`DSH_EXPERT_TEAM_LOOP_GUARD`）> 设置 > 默认(on)**，
  两个汇合点（`apply()` 与 `reapplySettingsDerived()`）各解析一次，非法值一律回默认（不猜不报错）。
- **即时生效**：`createLoopGuard` 在**构造时**就把 `enabled` 解构成常量，因此 `lib/loop-guard.js`
  现在也接受**函数/getter**，插件传 `enabled: () => LOOP_GUARD_ENABLED` ⇒ 改设置**当场生效**，
  不必重建钩子（重建会丢掉每 agent 的振荡链）。
- 关掉时**出声一次**（照 1.2.3 为 `leadToolFace` 立的纪律："否则『我明明关了』与『开关没生效』看起来一模一样"）。

### 删除两条**装饰性**门禁开关

- `gates.boundaryTasks` / `gates.boundarySpec`：两条行为**本就无条件强制**
  （`lib/interception.js` 的 `HARD_GRAPH_CODES` 与 `SPEC_COMPLETE_PHASES`；装配处 `createBoundaryInterceptor`
  的 deps 根本没有开关参数），README 也把"门禁由插件代码强制、不是提示词请求"当卖点 ⇒
  做成可关开关是**安全回退**，故**删除 spec**（共 18 项：4+5+4+5）。只把 hint 改成"预留"更糟：
  UI 上留一个点了没反应的复选框本身就是一句承诺。
- 容错：设置文件里残留这两个键时**不崩、也不产生噪声 repair**（有断言守着）。

### 回执与界面不再说谎

- `POST /settings` 的 `needsRestart` **恒为 false**：逐项查明上限/轮次/档位门/振荡开关都由
  `reapplySettingsDerived()` 当场重算、`identity.*` 每次建 run 经 `compilePolicy(currentSettings())` 现读、
  `SETTINGS_CACHE` 就地刷新 ⇒ **没有任何一项需要重启**。此前按"补丁顶层键 ∈ {roster,gates}"置 true
  并回一句"重启后生效"，是假话（同一个补丁刚在上一行被重算过）。
- 客户端那句死分支（`needsRestart ? '已保存 —— 重启后生效' : '已保存'`）一并删除；设置页头部改为
  "改动即保存并即时生效"，并加一句指向逐项的「暂未生效」标记。
- 相关测试与注释同步改准（`settings.test.mjs` 的项数与 `needsRestart` 断言、`settings-page.test.mjs`
  的死分支断言、路由处的"诚实边界"注释）。

### 未接线的 7 项：如实标注 + 单一真源

- `lib/settings.js` 新增 `INERT_SETTINGS`（键 = 限定路径，值 = "为什么现在没用"，写**实测来源**）：
  `display.pollMs` / `display.capsuleMs` / `display.panelWidth` / `display.defaultTab` /
  `roster.deliverable` / `roster.persist` / `roster.defaultRoles`。
- `decorateHint()` 是**唯一加工点**：设置页 schema（`settingsSchema()`）与扁平视图（`flatSpec()`，
  宿主 schema 侧的取值口）都经它 ⇒ 两处结果必然一致；标记**幂等**（不重复追加）。
- 这些项的 hint 现在带「（暂未生效：待 1.3.3 接线 —— …）」。**1.3.3 接线后从该表删一行，标注自动消失。**
- 设计已验证：删掉 `INERT_SETTINGS` 的某一行 ⇒ 该项界面标注**自动消失**，同时新测试转红
  （"无消费者又没登记"）；恢复后两者复原、文件逐字节一致。

### 新增 ratchet 测试 `settings-consumers.test.mjs`

- 每个设置项要么在生产代码里被读、要么在 `INERT_SETTINGS` 里；语义是**集合相等**（不是包含）：
  新增死开关 ⇒ 红；接线后忘了删白名单 ⇒ 也红（白名单**只减不增**）。
- 判真口径处理了本仓的"同名不同物"：`mode.deliverable` / `mode.persist` / `TIER_SPEC[].defaultRoles`
  都不是设置消费者 ⇒ 歧义叶子必须**限定路径**命中；**注释行不算消费者**；`lib/settings.js`
  **不能整文件排除**（`compilePolicy` 在里面，否则 `identity.askBudget`/`offerDecideForMe` 会被误判）。
- 该测试写出来就当场纠正了一次误判（上条），并确认 7 项白名单与实测完全一致。

### 设置页枚举下拉改为中文标签（**值仍是英文标识**）

- 症结：`settingsFormModel()` 把 `it.values` 原样交给渲染器 ⇒ 下拉里显示的是 `developer` /
  `code+artifacts` / `team` / `soft` / `on` 这些**标识**。
- 修法：中文标签做成**规格层单一真源** —— `lib/settings.js` 的每个 enum 项新增
  `labels: { '<值>': '<中文>' }`，**值域 / 类型 / 默认值 / 持久化格式 / 宿主 schema 一律不变**；
  `settingsSchema()` 把 `labels` **显式透传**（该响应按字段白名单构造，漏一个字段就会静默消失），
  `client.js` 的 `<option>` 文本用 `labels[值] || 值`（**缺标签退回裸值，绝不留空白**）。
- 为什么必须走响应体：`client.js` 是手写 bundle（`__ModuleLoader__` 工厂）**不能 import `lib/`**
  ⇒ 标签只能随 `GET /plugins/dsh-expert-team/settings` 的 schema 到达设置页。
- 防回归：`settings.test.mjs` 断言每个 enum 项的 `Object.keys(labels)` 与 `values` **集合相等**
  （新增枚举值忘配中文会红）；`settings-page.test.mjs` 断言模型带出 `labels` 且渲染取用 `labels[值] || 值`。
- **宿主的 schemastery schema 不带标签**：本仓的 `@deepseek-ai/schemastery` 里无法核实"给枚举成员挂描述"
  的可靠写法，而 schema 建错会让官方设置注册失败（本仓既有纪律："表达不可靠就退回文件层"）⇒ **明确跳过**，不硬做。

### 仍未接线（计划 1.3.3）

`display.*` 4 项与 `roster.deliverable` / `roster.persist` / `roster.defaultRoles` 3 项 ——
**本版只标注、不接线**（不碰它们的行为），接线后从 `INERT_SETTINGS` 删行即可。

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
> ⚠️ **更正（1.3.2 补记）**：本节曾写"该路径的保存回执仍按既有契约返回 `needsRestart: true`"，
> 读起来像"回执已与事实一致"——**实际那次只改了设置页顶部那一句文案**
> （`git show --stat bad5468` = 仅 `client.js` 一个文件），`lib/command.js` 的保存回执**一字未动**，
> 当时仍在说"`编制` / `门禁` 两类设置在插件加载时解析 ⇒ **重启 dsh web 后生效**"（假话）。
> 1.3.2 才真正修掉：`needsRestart` 恒 false、回执如实、客户端死分支删除。

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

## 1.3.16

**三件收尾：`/state` 重活的最大一段（`subs`）、冷启动、以及 R1 的"bash 绕过"坦白。**

### A. `subs` 2,398 ms —— 根因不是缓存不够，而是"永远查不完"

- **真机 profile 定位**：重活 `?section=people,feed` 单发 3,295 ms = `subs` **2,398** + `roles` 874 + 其余 ~2。
- **根因（真 bug）**：`STATE.members → membersFromState().byRole` 这个 Map **同时**存了
  `role→agentId` 与 `agentId→role` 两种键，而调用点直接取 `.values()` ⇒ **一半是角色名**
  （`backend` / `reviewer`）。角色名永远不可能是 session header 的 id ⇒ `missingIds` **永久非空**
  ⇒ **每个请求都重新枚举 475 个 artifact**，`SUB_HEADER_MEMO`（1.3.11 加的按 id 备忘）因此形同虚设。
- **修法**：新增 `memberAgentIds()`（只取真 id）并在调用点使用；`isAgentIdLike()` **按角色名精确排除**
  （等于角色 id，或首段是角色 id 的 `frontend-F4`/`reviewer-R1` 这类带后缀标签），**不按长度猜**
  —— 长度阈值会误伤短 id（`ended-x`/`live-1`），那才是真丢数据。函数内**再兜一道过滤**，
  防止未来调用方又把角色名传进来。顺带修掉 `buildRoleSubMap` 把 id 当角色的同一处根因。
- **效果**（进程内、可复现）：同一份数据第二次请求 `listSessions` **调用 0 次**（原为每次 1 次）。

### B. 冷启动 1,313 ms → 打**逐 run 戳缓存**（含落盘）

- **真机 profile 定位**：重启后第一次 `?section=summary` = 1,313 ms，其中 `runs+select` **876 ms**
  （每个 run 都要读 `STATE.json` + `TASKS.json` 再算 health/violations/owner）；随后 267 ms → 17 ms。
- **修法**：按**每个 run 自己**的 `STATE.json`/`TASKS.json` 的 `(mtimeMs, size)` 作失效键缓存"列表行"，
  索引**落盘**到 `$DSH_HOME/expert-team/runs-index.json`（可用 `DSH_EXPERT_TEAM_RUNS_INDEX` 覆盖位置）
  ⇒ **重启后第一次**也只是 stat 校验 + 命中，不必从零算。
- **为什么不能只戳 run 目录**：改文件**不会**改父目录 mtime（只有增删条目会）⇒ 那样会读到旧阶段/旧计数。
  戳到文件本身才是"看到的就是真的"。
- **实测**（进程内、`/tmp` 索引）：第一次算 5 个 run 并落盘 2,558 B；**模拟重启后第一次 1 ms、命中 5、零重算**；
  只改一个 run 的 `STATE.json` ⇒ **恰好重算那 1 个**；新增 run ⇒ **立即可见**。
- **顺带修**：`team/` 根下的**普通文件**（`CODEINDEX.json` / `LEARNINGS.md`…）过去被当作 run 读
  `STATE.json` ⇒ 面板 run 下拉里出现一串假的 "broken run"（画布上真能看到）。现在**只列目录**。

### C. R1 的 `bash` 绕过：**只报不拦**（刻意不阻断）

- R1 硬门禁只覆盖 `write`/`edit`；持 `bash` 的 backend/frontend/researcher/qa/dba/devops 理论上可
  `cat > SPEC.md` 绕过。**静默绕过**违背本仓纪律，但静态判断 bash 写目标不可靠（重定向/变量/子命令）
  ⇒ 新增 `lib/artifact-redirect-watch.js`：挂在 `tools/post-execute`，**只在**"命令里明显写向
  `<team 根>/<runId>/<已知工件>`"时**留痕一行 + onEvent**。
- **绝不**阻断、**绝不**改结果、**绝不**抛错（沿用"监听器不得成为故障源"的纪律，有源码级禁令断言）；
  含变量/`/dev/null`/工作区代码/更深路径一律**不命中**（宁可漏报，不可误伤）。
- 已知工件名来自**两处既有真源的并集**（`ARTIFACT_TEMPLATES` ∪ `ARTIFACT_OWNERS`）—— 同时把模板清单
  提升为模块级单一真源 `ARTIFACT_TEMPLATES`，`authority` / `artifact-ownership` 两组断言改为**读这份真源**
  （原先按源码字面量解析，重构后会"失去判据对象"—— 那比断言失败更危险，它看起来像通过）。
- **验收样例**：7 个命中形态（`cat > SPEC.md`、`>>`、`tee`、`tee -a`、带引号绝对路径、`2>`）
  + 9 个不命中形态（工作区代码、`/tmp`、无写目标、工作区根的 `SPEC.md`、非工件名、含变量、
  `/dev/null`、只读命令、更深路径）全部符合预期（`artifact-redirect-watch.test.mjs`）。

### 其它

- 新增变异体 `M139-artifact-redirect-watch-blind`（候选提取恒空 ⇒ 观测器变睁眼瞎），
  catalog 139 条；**已实测**注入后该测试 **10 条断言失败**、还原后逐字节恢复。
- 测试文件 **85 个**；`npm run test:all` EXIT=0。
