# 变更记录

本包遵循[语义化版本](https://semver.org/lang/zh-CN/)。dsh 宿主版本线的对应关系写在
`package.json` 的 `engines.dsh` 与 `dsh.compatibility` 里，插件市场按它判断"这个插件跟你的宿主兼不兼容"。

## 1.3.23

**主题：修 1.3.22 引入的一个**真回归** —— 后台角色批**一条日志都没读**（按构造必然），
并把"注释在撒谎"当作与代码撒谎同一类问题，做了一次系统清扫。**

### 先公开承认：1.3.22 让"角色解析"整体停摆

- **症状**：`?section=people,feed` 的 `rolesPending` **永远不下降**（真机基线：恒为 95，8 次请求 / 约 60 s
  一动不动；同机 harness 里 13 条子会话、14 轮请求、35 s，**也是恒为 13、角色日志读 0 次**）。
- **根因（按构造必然，不是竞态）**：`warmSubRoles` 拿到的是调用方在 **kick 那一刻**算好的**绝对**期限
  （`Date.now() + ROLES_READ_DEADLINE_MS`，默认 **600 ms**），而这一批要延迟 `rolesWarmDelayMs()`
  （默认 **1000 ms**）才开跑 ⇒ **1000 > 600 恒成立** ⇒ `resolveSubRoles` 的 `while` 第一件事就是
  `if (Date.now() > deadlineAt) { cut='deadline'; break; }` ⇒ **在第一次读之前就退出**，队列永不前进。
- **它为什么是隐性的（本轮真正的教训）**：`ROLE_READ_STATS.cut` 只在循环里写、每轮开头清，
  **从不进 `cutFacts`** ⇒ 不变成 `degraded`；而调用方照旧 `warming.push('roles')` ⇒ 用户只看到
  "约 30 s 闪一下「更新中」+ 一个不动的「待解析」计数"，**看起来和正常等待一模一样**。
  一次完整的功能损失，没有任何一个字段说它不对。**没有账本，故障就只能是隐性的。**
- 相对 1.3.21 是**净功能损失**（1.3.21 的请求路径受期限约束，至少能解析一部分）。

### 改法

- **期限从"批真正开跑"那一刻起算**：调用方改传**时长** `deadlineMs`，绝对期限在 `setTimeout` 回调里算；
  额度（`ROLE_READS_LEFT`）也挪到同一刻垫 —— 否则中间插入的请求会把它复位成 0，本批就"有期限却零读"
  （同一个坑换个入口）。`warmSubRoles` **只认时长**，绝对 `deadlineAt` 一并作废（不让"延迟"与"期限"
  再互相打架）。
- **"注定做不了活"的路径一律不踢批、不挂 `warming`**：队列空、无未缓存 id（新增谓词 `roleWarmHasWork()`）、
  额度为 0、已有批在跑 —— 逐一早退。
- **零进展变成可见事实，且恢复后自灭**：新增 `ROLE_WARM_STATS.noProgress`（＋`lastReads` / `lastQueued`）。
  它是**真故障**（有活、有期限、却一条都没读成）⇒ 经单一判据 `classifyStateShortfall` 送进 `degraded`
  （`roles:no-progress`）；**恢复即清零**（这一批真读到东西、或队列被读空都算恢复），
  且队列里已无未缓存 id 时不再上报 —— 不许再造一盏常亮灯。
- **分批账本无竞态**：这一批读了几条、结束时队列还剩多少，由调用方传入的对象承载（`resolveSubRoles`
  的 `stats`），不写模块级字段 —— 并发请求会互相覆盖。

### 注释与代码一致性清扫（"注释撒谎"与代码撒谎是同一类问题，只是更隐蔽）

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `lib/command.js` 有界化总纲 | "纪律不变：截断一律进 `degraded`" | 拆成两句：**真截断**（软期限/读失败）→ `degraded`；**按设计的能力上限** → `scopeCaps` |
| `lib/command.js` 角色解析段 | "被上限挡住的条数**如实进 `degraded`**" | 上限进 `scopeCaps`（1.3.22 起），并说明为什么（否则大团队降级标记常亮） |
| `lib/command.js` `MAX_ROLE_SUBS` 定义处 | "超限只解析前 N 条并如实标注"（含糊） | 明确"超出上限如实进 `scopeCaps`（**不是故障**）" |
| `lib/command.js` `MAX_FEED_AGENTS` 定义处 | "超出的条数**如实进 degraded**" | 改 `scopeCaps`；并点明"只有软期限截断才算真故障" |
| `lib/command.js` feed 收集处 | "被截断的条数如实进 degraded" | 改 `scopeCaps`（不是 degraded） |

### 面板文案不再泄漏 markdown（真机实测）

真机设置页把 `**HTML 防火墙页**` 的星号、`` `serverMode` `` 的反引号**字面显示**出来 —— 这些字符串
以 `esc()` 原样进 DOM，面板**没有** markdown 渲染器。本轮**不是只补那两处**，而是对三个会原样渲染的
文件做了系统清扫（`client.js` / `lib/hindsight-config.js` / `lib/hindsight-config-write.js`，
共 **17 处**），统一改写为**纯文本**（强调用「」），**信息一个字都没删**；并新增一条 lint 棘轮
（带反空转 + 用当初那两处泄漏自证"不是空壳断言"）防止复发。
`multi-session-and-confirm.test.mjs` 里那条**钉住带 `**` 文案**的断言也跟着改成钉纯文本，并反向断言星号不再出现。

### 实测（同机 A/B：旧 `5fd9593` vs 本版；同一语料 + 同一 run 副本；宿主真实读路径）

| 观测 | 旧 1.3.22 | 本版 |
| --- | --- | --- |
| 14 轮请求的 `rolesPending` 轨迹 | **13 → 13 → … → 13（14 轮全不动）** | 13 → 13 → 11 → 9 → 7 → 5 → 3 → 1 → **0** |
| 角色日志读总次数（35 s 内） | **0** | **13**（= 子会话数，全部解析完） |
| `ROLE_WARM_STATS.errors` | 0 | 0 |
| 稳态耗时 | 8–14 ms | 8–14 ms |
| 窗口重开（wf 30 s 到期） | 15 ms | 12 ms |
| `degraded` | 空 | 空（无假告警） |

⚠️ 诚实边界：上表的绝对值来自**过程内 harness**（stub 的 `readSession` 走宿主真实读路径：
`readStoredLog` 真解码 + `Session.create` 真重放 + `snapshotSessionEvent` 真克隆），
**不是**浏览器链路；且该 harness 的子会话是 13 条（真机是 95 条），所以"真机绝对时延"仍未测。

## 1.3.22

**主题：`/state`「窗口重开那一发」从秒级压回稳态，纠正我上一轮读错的两个事实，
以及把「按设计的能力上限」从 `degraded` 里拆出来（常亮的告警等于没有告警）。**

### 诊断（先把矛盾钉死再动手）

- **`wfLabels` 贵在哪**：`workflowChildLabels(ctx, peopleSid)` → `workflowEventIndex` → `sessionQuery.readSession(父会话)`
  ＝ **全量读一遍父会话日志**（本机那个带 workflow 扇出的会话：7.7 MB zstd / 4343 事件 / 走宿主的
  `readStoredLog` + `Session.create` 重放校验）。`WF_EVENT_TTL_MS = 30000` 只是"多久允许重读一次"，
  **不是期限** —— TTL 到点的那一发请求得把这次读**付满**（同机 `profile.wfLabels` 335–2683 ms）。
- **`roles:35` / `feed:35` 里的 `35` 不是毫秒，是条数**（`subs.length - MAX_ROLE_SUBS` /
  `subs.length - MAX_FEED_AGENTS`）。我上一轮把它读成"35 ms 预算"，并据此提了"抬预算"的方案 ——
  那个结论是错的，**抬预算根本不是杠杆**（见下一条）。已纠正。
- **`roles` 那 179–2023 ms 的来源**：`resolveSubRoles` 的期限检查在**每次读之前**，所以它只能拦住
  "**下一次**读"，拦不住"**正在进行**的那一次读" —— 单条子会话日志的全量读就有这么长。
- **客户端不会走"不传 `section`"的全量路径**：`heavySectionsForTab('board')` 返回 `''`，而订阅处是
  `heavy ? stateHubSubscribe(stateUrl(heavy), …) : noop`；`stateUrl` 的其它调用点（summary / artifacts /
  徽章 `liveUrl`）一律带 `section`。⇒ 冷实例上"不传 section 30 s 未返回"那条路是**遗留路径**，
  不是活的 bug（本轮**没有**动它，理由见末尾"未做"）。

### 改法

- **请求路径零日志读**（两处"不受任何预算管辖的重读"一起摘掉）：
  · `wfLabels` 改走 `workflowEventIndexForRequest` —— 有快照（不管新不新）**一次都不等**；没有快照才踢后台并
    **有界**等一小会儿（`DSH_EXPERT_TEAM_WF_FIRST_DEADLINE_MS`，默认 800 ms，保住首屏"派工即可见"）。
  · `roles` 的日志读整体挪到后台单飞批 `warmSubRoles`（请求路径只走便宜来源 + 缓存，`maxReads: 0`）。
- **后台批必须延迟开跑**（本轮最有价值的一条教训）：把读"挪到后台"**还不够** —— 它是 **CPU 密集型**、跑在
  **同一个事件循环**上。第一版实现（kick 之后立刻 `Promise.resolve().then(...)`）实测总体 444 ms：
  `wfLabels` 步 0 ms，但 `assemble` 步 **441 ms** —— 时间没消失，只是换了地方计入（后台读抢在请求收尾的
  文件 I/O 间隙里把循环占住）。现在后台批统一**延迟 1000 ms** 再开跑（`DSH_EXPERT_TEAM_WF_WARM_DELAY_MS` /
  `DSH_EXPERT_TEAM_ROLES_WARM_DELAY_MS`），那一刻当前请求早已响应完毕，重读落在两次轮询的间隙里；
  冷启动那一次例外（调用方本来就在等它，走 `immediate`）。
- **`warming` 与 `degraded` 是两个承载位**（本仓纪律：两种零分得开）：
  · `degraded` ＝ 本轮**真的少算了东西**（硬上限 / 软期限截断）⇒ 报警；
  · `warming` ＝ 本轮把这次重读挪到了后台 ⇒ 数据来自上一份**完整**快照或暂时缺席，**不是失败**。
  · 判据是"**真的有刷新在飞 / 这一段根本没有数据**"，不是"备忘过期" —— 否则 30 s TTL 配 6 s 轮询会让它常亮成噪声。
  · **数据其实完整时不许标 warming**：`stale`（有旧快照、正在后台刷新）不标 warming，改成随负载下发
    `wfIndex: {state, ageMs, refreshing}` 把"这是 N 秒前的快照"**明示**出来（客户端在分批依据里按秒显示）。
- **读失败不再覆盖好快照**：`workflowEventIndex` 以前把 `readSession` 抛错当成"这个会话没有 workflow 事件"
  缓存 30 s（假零）。现在区分 `readerAvailable` / `readOk`：读失败时**保住旧快照、不刷新 `at`**，下一个 tick 再试，
  并如实计数 `readErrors`；从未有过快照时才给空值，且由 `state='missing'` 让上层标 warming。
- **写盘守门：读可以拿不完整数据，写不行**。"派工即登记"的**退路**分支（本 run 还没登记过成员）依赖
  `wfLabels` 判定"哪些子代理属于本 run"（R12/R17 那条串号事故链）；wf 索引不是 `fresh` 时**跳过本次登记**、
  下一轮再登，并如实记 `warming: members:write-skipped`。**精确路径**（`STATE.members` 已有角色映射）不吃
  `wfLabels`，照常落盘、不受影响。
- **硬上限继续收口后台批**：交给后台的是 `subs.slice(0, MAX_ROLE_SUBS)`（`resolveSubRoles` 内部会按传入列表
  重建队列）—— 否则超出上限的人迟早也会被解析，而 `degraded` 里的 `roles:N` 就成了一句假话。
- **客户端显式渲染 warming**（不许静默用旧数据假装正常）：表头加 `.exp-warming`「更新中」标签（title 逐段说明
  是哪一块在刷）；流转视图在 wf warming 时把话**改成**"工作流元数据正在后台读取…（**不是**"没有记录"）"，
  不再用空数据得出"无创建时间记录，无法分批"这个**编出来的结论**；`stale` 时在分批依据里显示快照年龄。
- **测试**（`state-bounded.test.mjs` 新增第 ⑤ 节 + 更新接线断言，**不新增测试文件**）：请求路径零日志读、
  单飞（同刻再踢返回 `null`）、队列空时不踢（否则 warming 常亮）、过期先给完整旧快照、读失败不覆盖好快照、
  后台批延迟开跑（这条是上面那个 441 ms 教训的棘轮）；`client.js` 的 warming 渲染与"流转视图改口"也有断言。

### 同机 A/B（旧 `13834ca` vs 本提交；同一语料 + 同一 run 副本；`DSH_EXPERT_TEAM_STATE_PROFILE=1`）

| 场景 | 旧 `13834ca` | 本提交 |
|---|---|---|
| 冷启动第一发 | 589 ms（`wfLabels` 528 + `roles` 51，**2 次**日志读） | 498 ms（`wfLabels` 489 ＝ 有界首等，**1 次**日志读）＋如实标 `warming: roles` |
| 稳态 | 2–9 ms | 2–3 ms |
| **窗口重开**（wf TTL 30 s 与 roles 窗口 30 s 同时到期） | **381 ms**（`wfLabels` 335 + `roles` 43，**2 次**读） | **13 ms**（请求路径 **0 次**读；`wfIndex=stale` + `warming: roles`） |
| 全窗口重开（含 subs 120 s 窗口） | 49 ms | 7 ms |
| 整段会话的日志读总次数 | 5 | **1**（只有冷启动那一次） |

测量方式：同机、同一份**真实** session 日志与同一个 run 副本，桩里的 `readSession` **走宿主的真实读路径**
（`dsh-session-persistence-jsonl` 的 `readStoredLog` 真解码多帧 zstd + `dsh-session` 的 `Session.create`
真重放校验 + `snapshotSessionEvent` 真逐事件克隆），不是"假装慢一点"。

### 上限与真故障分开承载（本轮第二件事，1.3.22 的另一半）

- **问题**：真机 95 个 agent、`MAX_ROLE_SUBS=60` ⇒ `degradedReason="roles:35,feed:35"` **每一轮都出现**。
  可那 35 是**按设计的能力上限**（我们主动规定"只对前 60 条做最贵的日志解析"），**不是故障**。
  后果是那盏降级标记**长期常亮** ⇒ 真正的"期限截断"与"读失败"被它一起降权 ——
  **常亮的告警等于没有告警**（本仓在 `subs:throttled` / `warming` 上已经吃过两次同样的亏）。
- **改法**：新增纯函数 `classifyStateShortfall({cuts, readErrors, caps})` 作为**唯一判据**，把"缺了什么"分成
  两个承载位：`degraded`（真故障：软期限截断、读失败）与 `scopeCaps`（按设计的上限）。
  上限以**事实**收集（`capFacts.push({key:'roles', total: subs.length, limit: MAX_ROLE_SUBS})`），
  数字来自实际条数与真实上限常量，不是手写的字符串；**恰好等于/低于上限时什么都不报**（不无中生有）。
- **"不报警" ≠ "隐藏"**：`scopeCaps` 的数字**一个不少**地照发（`{over, limit, total}` 三样都在，
  而不是只报一个 `35`），客户端表头新增 `.exp-scope` 徽章「另有 N 条按上限只列名」（实线中性样式，
  与 `.exp-warming` 的虚线金黄、degraded 的告警色三者区分）—— 上限既不伪装成告警，也不被静默吞掉。
- **读失败不再被伪装成"刷新中"**：`wf` 索引读失败（IO 错）与"还没有快照"原本都落到 `warming`
  ⇒ 一次**真实读失败**会被显示成"后台刷新中"。现在按**本次请求的增量** `WF_EVENT_STATS.readErrors`
  判定，读失败进 `degraded`（`wf:read-error`），`warming` 只留给"确实在后台刷新/这一段暂时没有数据"。
- **顺手修掉一处"标记粘住"**：`warming` / `scopeCaps` 只在非空时下发，而客户端 `mergeStatePayload`
  的规则是"缺键 = 保留旧值" ⇒ 一旦出现过就**永久粘住**（"更新中"徽章再也消不掉）。现在当这一发
  **重算过**这两个标记（`sections` 含 `people` 的连续重负载）时，缺席即"现在真的没有"，显式清掉。
- **测试**（`state-bounded.test.mjs` 新增第 ⑥ 节、`state-sections.test.mjs` 的 ③ 节改判据，
  **不新增测试文件**，仍是 89 个）：① 只有上限 ⇒ `degraded` 不设置且 `scopeCaps` 三样数字正确；
  ② 软期限截断 ⇒ `degraded` 仍设置且**没有**混进 `scopeCaps`；③ 读失败 ⇒ `degraded` 仍设置；
  ④ 上限与真截断同时发生 ⇒ 两者都如实出现；⑤ 未越限 ⇒ `scopeCaps` 为空；外加服务端接线与
  客户端渲染（`.exp-scope`、样式区分、条数文案、标记不粘住）的棘轮。

### 不传 `section` 的全量路径：本轮补测（结论：**不动**）

上一版只从客户端代码推出"这条路径不可达"，没有实测数字。本轮在**临时实例**（临时 DSH_HOME + 真 `sessions`
软链 + 真实 run 目录**副本**，端口 3121–3127，`DSH_EXPERT_TEAM_STATE_PROFILE=1`）上补测，跑的就是本提交：

| 场景 | 实测 |
|---|---|
| **冷启动第一发**（5 次独立冷启动，每次新进程 + 状态重置） | **1.636 / 1.659 / 1.667 / 1.669 / 1.752 s**（中位 1.667、最大 1.752），全部 200、~229 KB、**无超时** |
| 同实例第 2 发 | 0.93–1.25 s（`subs` 已节流；`wfLabels` 1018–1154 ms） |
| 同实例第 3 发起 | **5.6–18 ms** |
| **窗口重开**（wf TTL 30 s 过期那一发） | **11.1 ms**（`wfIndex=stale`、`wfLabels=0` ⇒ 返回旧快照 + 后台刷新，**不等**） |
| **窗口重开**（subs 节流窗 120 s 过期那一发） | **25.0 ms**（`subsCut=warming` ⇒ 不阻塞枚举） |
| 参照 `?section=summary` 冷启动 | **15.9 ms**（完全不碰 subs/wf） |
| 参照 `?section=people,feed` 冷启动 | **1.636 s** ⇒ 这笔代价挂在 `people` 那一步，不是"全量路径"独有 |

- **冷启动 = 两次 800 ms 期限之和**（`subs` 813–836 ms + `wfLabels` 800–801 ms）。冷响应如实：
  `degraded=true (subs:deadline)`、`warming=["wf"]`、`agents=0`、`subsPending=13`；**第 3 发起 `agents=95`、
  `subsPending=0`** —— 1.3.21 那个"空结果被当成基线"的缺陷在**真负载**上确认修好了。
- **结论：不需要动它**（≤2 s，且只在冷启动前两发付费；旧的"窗口重开 1–3 s"已消失，旧版"30 s 未返回"
  也没能复现 —— 见诚实边界）。
- **一处必须记下的偏差：这些"期限"是软界。** 实测 `WF_EVENT_FIRST_DEADLINE_MS=800`（`lib/command.js:3899`）
  过冲到 **最多 +354 ms**（800→1154 ms），原因是源码注释 `:3901–3907` 自己写明的：后台预热是
  **CPU 密集型（zstd 解码 + `Session` 重放 + 逐事件克隆）且跑在同一个事件循环上**，`setTimeout` 只能等
  CPU 让出才触发。⇒ 设计上限 1.6 s、实测上限 1.75 s。**本轮没有为它改动**（要削只能削首屏那两次 800 ms
  期限，或把预热分片让出事件循环，收益都小于风险）。

### 诚实边界

- **真机（浏览器里的那条链路）没验**：用户机器上装的是**已发布的 1.3.21**（不含本提交），我不会为了验收去重启
  用户的 `dsh web`。上表全部来自同机**进程内** A/B 与**临时实例**。
- 上表的绝对值是**下界**：真机 1.3.20 窗口重开实测 **1.196 s**，而 harness 里旧代码那一发只有 381 ms
  （活的 host `sessionQuery.readSession` 还额外做语料/活源解析与 `structuredClone`）。**真机"改前"以 1.196 s 为准。**
- **没有复测旧代码**：那条"不传 section 冷实例 30 s 超时"是**更早版本**的实测，本轮**未复现它**
  ⇒ "30 s → 1.67 s"这个对比**没有验证**，只能确认**现版本**是 1.67 s。
- `?section=artifacts` 单独冷启动、以及"boot 期别的插件（cost-meter 扫 705 份会话日志）造成的启动噪声"
  都没有量化（5 次冷启动彼此相差 ≤116 ms，噪声看起来不大，但不能证明为零）。
- **`degraded` 的条目跨分段产生**（people 的 `subs:`/`wf:` 与 artifacts 的 `artifacts:`/`files:`），
  而一次重分节只覆盖一个分段 ⇒ 客户端**没有**把 `degraded` 也做"缺席即清空"：一刀清掉会把另一分段的
  **真**告警抹成"一切正常"（那比粘住更糟）。这条**未修**，如实记录。
- 变异目录未新增条目（加一条要同步 `EXPECTED_CATALOG_SIZE` 140→141 并牵动 README/llms.txt 的数字棘轮）。

## 1.3.21

**这一版有三件事：Hindsight 配置页从"只能看"变成"能改"；写入绕过棘轮从"一直红着没人知道"修到真绿；
以及 `/state` 三处"看起来正常其实在骗人"的地方。**

- **新写路由**：`POST /plugins/dsh-expert-team/hindsight-config`（与诊断 GET **同一路径**、同一命名空间，
  同样走 `registerLocal` 的本机来源守卫 ⇒ 跨站写 403、非 JSON content-type 415、非回环 Host 403）。
  它**不走**宿主的设置命名空间：那份 JSON 是 Hindsight 自己的真源（还认 `HINDSIGHT_CONFIG` 与默认路径），
  插件替它另存一份就是"同一个字段两个家"。
- **只改你提交的键**：读-改-写合并，**文件里所有未知/未来键逐字节保留**（升级后多出来的键、别人手写的
  字段，都不许因为"我不认识"被写没）；现有文件存在但不是合法 JSON 对象 ⇒ **拒绝写入**（盲目合并等于
  把你原有的内容整段写没）。
- **原子写 + 权限**：同目录临时文件 → `fsync` → `chmod 0600` → `rename`（同目录 rename 才原子；
  目录不存在则按 `0700` 创建，目录项也 fsync）。**校验不过 ⇒ 一个字节都不落盘**。
- **校验**：`serverMode` 只认 `cloud`/`self-hosted`/`daemon`；`apiUrl` 必须能解析为 `http(s)` 且
  **不能带 `/v1`**（Hindsight 自己会拼 `/v1/...`）；尾部斜杠会去掉，并且**写进 notes**（不是悄悄改）。
- **daemon 的强制地址如实说**：`serverMode=daemon` 时把 `apiUrl` 写成别的值 ⇒ **拒绝**并给出两条出路
  （同一请求里 `clear:["apiUrl"]`，或改用 `self-hosted`）；若文件里**本来就有**一个别的值 ⇒ 允许、不擅自删，
  但在 notes 与诊断报告里都写明"它不会生效、要清掉请显式清除"。
- **空串 ≠ 删除**：空/空白输入 = **保持原值不变**；清除必须是**显式**动作 `clear: ["apiToken"]`
  （白名单只允许清 `apiToken` / `apiUrl`）。
- **token 永不回显**：写模块对外的一切字段**只从 `parseConfigText()` 来**（它按构造只产出三个键，token
  只折算成布尔）；前端是 password 输入框、保存后立刻清空、从不预填。**错误信息同样不回显"用户提交的
  原值"** —— "哪个字段装的是 token"是个靠不住的判据（粘错栏就会漏），所以这条保证做成**结构性的**：
  回执里根本没有提交原文（唯一保留的派生值是 URL 解析器给出的协议名）。测试用"把哨兵 token 误粘进
  `serverMode` / `apiUrl` / `clear`"反向验证。
- **重启提示按事实说**：改了 `serverMode`/`apiUrl` ⇒「需重启 `dsh web`」；只改 `apiToken` ⇒
  「无需重启（401 时会重读）」；**没有任何改动 ⇒ `saved:false` 并显示"未写盘"**（不假报成功）。
- **模块边界**：写路径独立成 `lib/hindsight-config-write.js` —— 诊断模块**继续**保证"它不会写任何东西"
  （源码级断言仍在），写模块只从它 import（叶子纪律，不成环）。
- **测试**（`hindsight-config.test.mjs` 由六节扩到九节，**不新增测试文件**）：纯函数层钉"保留未知键 /
  校验拒绝 / 空串不改值 / 显式清除 / daemon 强制地址"；路由层在**临时目录 + `HINDSIGHT_CONFIG`** 上真落盘，
  实测文件 `0600`、目录 `0700`、被拒绝时盘上逐字节不变、回执与诊断响应全文不含 token 明文、
  跨站写 403 / 415 / 非回环 Host 403。全程不碰真实 `~/.hindsight`。
- **写入绕过棘轮：从"一直是红的却没人知道"修到**真绿且被 CI 强制****（同一轮里的第二件事）。
  - **两个事实叠在一起才让门禁失效**：`regression.fixtures/write-bypass-baseline.json` 写的是 `total: 0`，
    而真实值是 **4**（`lib/command.js` 的 runs-index 2 处 + 本模块 2 处）；同时 `.github/workflows/ci.yml`
    **故意不跑** `npm run gate`，`write-bypass-ratchet.test.mjs` 又只在**临时目录**里验脚本逻辑 ——
    真实仓库**从来没有任何一处会被比对**。于是从 2026-09-11 起，这道门禁在本仓一直是红的。
  - **分类先钉死**：runs-index 写的是 `runsIndexPath()` = `$DSH_HOME/expert-team/runs-index.json`
    —— **工作区之外**的**宿主状态文件**，不是工作区工件 ⇒ 不该走 `lib/artifact-writer.js`
    （那会套上工件归属门禁与工作区范围硬排除）。
  - **新增 `lib/host-state-file.js`**：宿主状态文件的**单一受控入口**（同目录临时文件 → `fsync` →
    `chmod` → `rename` → 目录项 fsync；默认 `0600`／目录 `0700`；失败清临时文件；唯一临时名）。
    `lib/command.js` 的 runs-index 与 `lib/hindsight-config-write.js` 都改成走它 ⇒ 两者的直写**归零**，
    `gate:bypass` 报 `0 / 基线 0 / 差值 0`（**没有去抬高基线**，脚本本身也拒绝抬高）。
  - **为什么这类写入不能用宿主现成的栅栏**（实测证据，不是猜测）：`dsh-base` 的 `cordis.patch.yml`
    挂的 fs 后端是 `@deepseek-ai/dsh-fs-sandbox`（不是 `fs-local`），`sandbox-policy` 默认
    `workspace-write` + `workspaceRoot = process.cwd()`，而该后端 README 与源码
    （`lib/index.js` 的 `FS_SANDBOX_DENIED`）写死"越出工作区即拒" ⇒ `ctx.fs` **够不到** `$DSH_HOME/...`。
    宿主的 `@deepseek-ai/dsh-atomic-write` 在插件目录下 `import` 解析不到（`ERR_MODULE_NOT_FOUND`），
    而本包承诺 `dependencies: {}` ⇒ 不能借它，只能把同样的语义在本模块里实现一份。证据写在模块文件头。
  - **让棘轮真的会被执行**：`write-bypass-ratchet.test.mjs` 增两节（**不新增测试文件**，仍 89）——
    ⑥ 在**真实仓库**（用仓库自己的基线文件）断言 `delta <= 0` 且 `baselinePresent === true`，失败信息带
    perFile 分布；⑦ **同源锁**：从脚本源码解析 `EXEMPT`，断言它**恰好**等于
    `['lib/artifact-writer.js', 'lib/host-state-file.js']`，并断言两个受控入口文件真实存在。
    这两节跑在 `npm run test:all` 里 ⇒ CI 从此强制它。
  - **如实记一处行为变化**：runs-index 文件权限由 umask 默认（`0644`）变为**显式 `0600`**（路径、内容、
    失败语义、并发语义都没动；它会话状态里带工作区路径，收紧属主可读与该文件的性质一致）。
    红→绿证据（临时造一处直写 ⇒ ⑥ 报 `delta=1｜分布：lib/vocab.js:1` ⇒ 逐字节还原 sha256 一致）
    与 ⑦ 的反向验证（往 `EXEMPT` 里塞第三个文件 ⇒ 当场红）都已实测。

**`/state` 的三处"看起来正常其实在骗人"**（真机 1.3.20 验收挖出来的 A/B/C 三项，同一轮里的第三件事）。

- **A · 幽灵 agent id（`subsPending` 恒 ≥1 的第二个根因，1.3.19 就有）**：真机 13 条 `STATE.members`
  被 `memberAgentIds` 解析成 **14** 个 id，多出来的是**角色名 `product-analyst`** —— `membersFromState`
  把 `role→id` 与 `id→role` 塞进了**同一个 Map 的键空间**，而 `isAgentIdLike` 当时只排除 `DEFAULT_ROLES`
  的 12 个**固定**角色（`product-analyst` 不在里面，它的首段 `product` 也不在）⇒ 角色名当 id 放行 ⇒
  `missingIds` **永久非空** ⇒ 每个节流窗口（120 s）打开都触发一次**全库 rescue 枚举**。两条一起上：
  ① **键空间按构造分离**（`membersFromState` 现在返回 `byRole` 只装角色、`byId` 只装 id，"用 id 反查角色"
  归 `byId`）；② 判据的角色词表改成 `KNOWN_ROLES ∪ ROLE_LABELS_ZH.values()`（同一真源 `lib/vocab.js`，
  不再抄 `DEFAULT_ROLES` 这个子集 —— `debugger` 就是这么漏过去的）。
- **B · 空结果被当成基线（1.3.20 引入的行为差）**：重启后宿主第一轮 `listChildren` 返回**空集**
  （它自己的索引还没热），旧实现无条件把它当基线缓存 `SUBS_ENUM_MIN_INTERVAL_MS`(120 s) ⇒ 真机面板
  **22:34 空、22:40 才自愈**。现在：`knownIds` 非空却拿到 0 行 ⇒ 记 `provisional`，按 `retryMs`
  （2 s 起、每次翻倍、上限 120 s；`DSH_EXPERT_TEAM_SUBS_RETRY_MS` 可覆盖，测试用它）退避重试，
  且这一轮**像"首次基线"一样在请求内等一小会儿**（仍受 800 ms 期限约束）⇒ 下一轮就自愈；
  `knownIds` 本来为空 ⇒ 空集是**合法基线**，不重试风暴；空结果**不冲掉**已有的非空行（旧实现会把
  95 行直接覆盖成 0 行）。如实上报：`cut='warming'`（**不进 degraded**，"细节不可得"由 `subsPending`
  表达），真被期限截断时仍优先 `deadline`。
- **C · 非法段名静默回落成 summary**：`?section=roles` 这类打错的探测以前返回一份**看起来完全正常**的
  summary 载荷 —— 我本人据此把 summary 的耗时当成了"roles 段的耗时"写进验收结论（"两种零分不开"的
  又一例）。现在纯函数如实列 `invalid` + `valid`，**路由在任何 await 之前 400** 并回执合法清单；
  缺省 / `all` 的兼容性不变。
- **同机 A/B 实测**（临时 DSH_HOME + 真 `sessions` 软链 + 同一个 run：`php/liangge` 的
  `有一个系统需要重构-141003`，`DSH_EXPERT_TEAM_STATE_PROFILE=1`）：

  | 指标 | 旧（1999c66） | 新 |
  |---|---|---|
  | `subsPending`（稳态） | **1**（幽灵 id） | **0** |
  | `profile.subsCounters.enumCalls`（冷启动 / 窗口重开） | **1 / 2** | **0 / 0** |
  | 冷启动 `agents` | 0 → 95 | 0 → 95 |
  | `subs` 步耗时（当时只能由 profile 各步与总耗时之差反推，见下） | ~193 ms（窗口重开那发） | ~4 ms |

  同一轮也确认**没有把 1.3.20 的提速弄回去**：`?section=summary` 5.4–7.3 ms（中位 ~5.8 ms）、
  `?section=people,feed` 稳态 8.1–12.6 ms，`agents=95` / `stateMembers=13` 不变。
  **诚实边界**：窗口重开那一发的**总耗时**新旧都是 ~3 s 量级，因为它在**冷实例**上由 `wfLabels`
  （~0.8–2.7 s）与 `roles` 突发读主导 —— 那不是这两处修复的目标；修复消掉的是 `enumCalls` 那一项
  （旧代码最多为此付满 800 ms 期限）。

- **`profile` 键空间：分步耗时与附带账本不再同名互相覆盖**（可观测性瑕疵，1.3.20 就在）：
  `mark('subs')` 写 `profile.subs` = **该步耗时**（数值），而 subs 段的计数器对象**也叫 `subs`**，
  合成时后者盖掉前者 ⇒ 那一步的耗时在 profile 里**根本看不见**（上面表里那一行就是这么被迫用
  "各步之和与总耗时之差"反推的 —— 用算术补测量，而不是读测量）。现在计数器改名 **`profile.subsCounters`**，
  **两者同时可见且命名无歧义**；合成统一走 `assembleStateProfile()`，它**结构性地**不许撞名：
  真撞了就保留步耗时（测量值丢了就没法复现）并把撞名如实记进 `profileKeyCollisions`，**绝不静默覆盖**。
  只在 `DSH_EXPERT_TEAM_STATE_PROFILE=1` 时可见，默认响应体不变。
- **`state-perf-guard` 的"索引落盘"断言：硬等改成轮询 + `saveErrors === 0`**（CI 假红修复）：
  旧断言是"防抖 1 500 ms vs 硬等 1 700 ms"，只剩 200 ms 余量；runs-index 改走原子入口后多了一次
  `fsync`，CI 一忙就把这点余量吃掉 ⇒ 报"没落盘"。但真因**不是写失败**（`saveErrors: 0`），而是
  **还没写完** —— 现在轮询（每 25 ms、上限 6 s）并在失败信息里带实际等待时长，同时补一条
  `saveErrors === 0` 把"写失败"与"还没写完"分开（这两种零必须分得开）。
- **文档数字归位**：README / README.en 里那句"修复后的端到端数字**待实机复测**"换成**真机实测值**
  （`summary` 中位 3.5–5.8 ms、`people,feed` 稳态 4–13 ms，1.3.19 约 280 ms/次 ⇒ 约 70×），
  `llms.txt` 的"84 个测试文件 / 138 条变异"归位为 **89 / 140**，并把 `llms.txt` 的可引用事实
  （包名 / 宿主下限 / 角色数及逐 id 清单 / 阶段数）纳入 `docs-integrity` 棘轮。

## 1.3.20

**`subs` 段：把那 800 ms 的期限变成真的**（`?section=people,feed` 真机 2,680–2,724 ms ⇒ 有界）。

- **根因（可复核）**：`listSubagentStatusBySession` 里那句 `await runtime.listChildren(root)`
  **不受任何节流管辖**；而宿主实现（`@deepseek-ai/dsh-subagent` 的 `list-children.js` →
  `prepareListing`）**无条件**先做一次 `sessionQuery.listSessions()` —— 全库枚举（本机 475 条
  artifact，每条 `lstat + stat + 读首行`）。真机 profile 实测：`people,feed` 2,686 / 2,724 / 2,697 ms，
  其中 `profile.subs` 2,680 / 2,717 / 2,686 ms（≈100%）；而 `SUBS_ENUM_DEADLINE_MS` 只在
  "**被 await 的那段返回之后**"才被检查 ⇒ 期限是**装饰性**的。
- **改法**：热路径只读**内存**（活子会话 `sessions.list()` + 上一次预热留下的行 `SUB_ROWS_MEMO`）；
  `listChildren` 挪到**后台预热**（同一 root 同刻只跑一个，结果落备忘，顺带把 header 灌进永久备忘）。
  只有"从没有过基线"的那一轮会按期限等一小会儿（机器快/库小时 ⇒ 首个响应就是完整的）；
  等不到 ⇒ 如实 `cut='deadline'`（真截断 ⇒ 进 `degraded`），后台继续跑，下一轮（≤一个轮询间隔）就有基线。
  备忘过期只触发**后台刷新**、从不等 ⇒ `cut='warming'`（**不是失败**：成员不丢，细节由 `subsPending` 表达）。
- **期限现在真的会咬人**：`listChildren` 慢过期限时，响应 **121 ms** 就返回（测试里用一个"挂 3 s 的桩"
  钉死；旧实现必须等满那 3 s）。rescue 枚举也改成**先看预算再起手**：期限已过 ⇒ **一次都不发**
  （旧实现会先发起 2.7 s 的全库枚举、读回全部结果，然后在第一行上才发现超期）。
- **节流间隔 30 s → 120 s**：这个窗口现在同时管"预热刷新"与"rescue 枚举"。活代理状态仍然**实时**读
  （`sessions` / `agents` 注册表赢），且备忘行**不再被就地改写**（否则"此刻的状态"会被写进快照，
  某个 id 结束后就顶着陈旧值）。
- **可观测**：profile 负载新增 `subs` 汇总（`cut` / `rowsHits` / `rowsMisses` / `liveRows` / `warms` /
  `warmErrors` / `warmTimeouts` / `warmMs` / `memoHits` / `memoWrites` / `enumCalls`）——
  "热路径到底还去不去做那次全库枚举"从此是**数字**，不是注释里的承诺。
- **棘轮**：`state-bounded.test.mjs` 新增三条（挂起桩 ⇒ 到点即返回、预热一次后续请求零调用、
  期限已过零枚举），并把旧断言"期限到点**立即停**"改成更强的"**一次都不发**"。

## 1.3.19

**文档与 CI 工具的三件收口**（纯文档/工作流，**不改任何产品代码**）。

- **更正：本文件里 `## 1.3.17` 与 `## 1.3.16` 曾被追加到文件末尾**（挂在 `## 1.1.0` 之后），
  违反"最新在上"的约定，**且已随 1.3.18 发到 npm**。本版把两节**原样归位**到
  `1.3.18` 与 `1.3.15` 之间 —— 已用脚本证明**搬前/搬后 25 个版本节内容逐字节一致**（只动位置）。
  自本版起有断言防回归（见下一条）。
- **新增 `docs-integrity.test.mjs`**（进 `test:all`），钉住四类"文档与实况脱节"：
  ① 本文件首个版本节 == `package.json` 的 version；② 版本节**严格降序**（语义化版本比较，不是字符串比较）；
  ③ 无重复版本节；④ **活文档里的「NN 个测试文件」/「NN 条变异」必须等于实数** ——
  单一真源分别是 `scripts["test:files"]` 与 `regression.fixtures/mutations.json`；
  **不扫本文件**（那是历史记录，写的就是当时的值）。四条都带**反空转**断言
  （解析不到 ⇒ 判红，不允许"零标题/零数字"静默通过）。
  它上线即抓到 **7 处过期数字**：`README.md`/`README.en.md` 各写"84 个测试文件"（实际 89）、
  各写"138 条变异"（实际 140）、CI step 名写"75 个测试文件"。
- **CI step 名不再写死数字**：`全套测试（75 个测试文件，零依赖）` → `全套测试（零依赖、无需 install）`
  —— 治本：数字不再会漂。
- **新增零依赖 runner `scripts/run-tests.mjs`**：测试清单仍是**单一真源**
  `scripts["test:files"]`（同一串 `node X.test.mjs && …`），`test:all` 改为 `node scripts/run-tests.mjs`。
  它**逐文件跑、每个文件的输出实时透传**（CI 日志形态不变），结束时**汇总一次**：文件数、总耗时、
  失败清单，以及**每个失败文件的最后 30 行**。语义等价（任一文件失败 ⇒ 退出非 0），
  但**不再"一红遮八十"**：旧 `&&` 链在第一个失败处就停 —— 2026-09-15 排查真机 CI 红时
  "31 秒就失败却看不到任何失败细节"正是它。另有**反空转**：清单为空 / 清单里的文件不存在 ⇒ 直接判失败
  （不允许出现"零测试报绿"）。
- 验证：`npm run test:all` **EXIT=0**（**89 个测试文件**）；`rename-package --check` 绿；
  实测演示：把一处断言反转（令**第 2 个**文件失败）⇒ runner **仍跑完其余文件**、汇总报出该文件最后 30 行、
  退出码非 0；还原后全绿。

## 1.3.18

**记忆后端（Hindsight）的只读诊断面板**（一期：只"看"，**不改它的任何行为**）。

- 背景：用户的两类记忆故障都发生在**服务端**，客户端此前只把原始 JSON/HTML 抛出来 ——
  `… -> 500 {"detail":"could not resize shared memory segment … No space left on device"}`
  （服务端 PostgreSQL 分配共享内存失败；自托管最常见成因是容器 `/dev/shm` 只有 64 MB）
  与 `… -> 403 <!doctype html>…网站防火墙…`（**WAF 返回 HTML 防火墙页**，**不是 token 问题**）。
  两者此前只能看到一坨原文 ⇒ 用户不知道该改哪里。
- 新路由 `GET /plugins/dsh-expert-team/hindsight-config`（走 `registerLocal` 的同源守卫；**只读**）：
  读配置真源 `HINDSIGHT_CONFIG || ~/.hindsight/coding-agent.json`（只输出 `serverMode` / `apiUrl` /
  **token 是否已配置**）、读诊断日志尾部（`diag.jsonl`）、**启发式分类 + 可操作 hint**；
  **只有 `?probe=1` 才**探一次连通性，且**任何 HTTP 响应（含 401/403）都算「可达」** ⇒ "连通 ≠ 鉴权"。
- **错误分类**（两类真实故障各自成类、不混成一个）：`waf-blocked`（403 + HTML 防火墙页 ⇒ 查 WAF/白名单，
  **不是 token**）· `server-shm-or-disk`（PG 共享内存/磁盘 ⇒ `--shm-size=1g`、`df -h`、并行度）·
  `server-5xx` · `auth`（401/403 且无 HTML）· `unreachable` · `unknown`。
  **分类是启发式提示、不是断言**（hint 的措辞如实说明）。
- 设置页新增「记忆后端（Hindsight）· 只读诊断」块：配置路径（可复制）· 形态 · 地址 ·
  **token 是否已配置（值不显示）** · 本工作区 bank（`coding-agent::<workspace>`）· 最近一条失败
  （分类 + 处理建议）· 可选的一次连通性探测；并写明**重启语义**（改 `serverMode`/`apiUrl` 需重启
  `dsh web`，只改 `apiToken` 免重启）。
- **两条硬纪律（有测试盯着）**：① **只读** —— 模块内没有任何写入 API、路由**只暴露 GET**、界面无写入控件；
  ② **token 值绝不回显** —— 只给布尔，连长度/前后缀都不给（测试用哨兵串断言**响应全文不含它**）。
  另外：**不带 `?probe=1` 时一次网络请求都不发**（进设置页不会去打服务端）。
- `inject_empty`（召回为空）**不算失败** —— 与本仓"两种零必须分得开"的纪律一致（`deferred`/`unresolved` 同理）。
- **诚实边界**：本版只做"看"，**不写任何文件、不改 Hindsight 的行为**（配置仍由它自己读）；
  三种形态的**写入**（读-改-写合并 / 0600 原子写 / 明确重启提示）在**二期**。
- 顺带修 README FAQ 两处**被串行**的条目（"浮层/画布很慢"答案的尾巴被误粘到"reasoning effort"那条后面，中英各一处）。

## 1.3.17

**重活有界化 + 「为谁而做」前置与其主视觉。**

### 性能：把两段最贵的活变成"有界"（不是"更快"）

真机基线（30+ 子代理的重会话，用户实测）：`?section=people,feed` 单发 **5.4–9.2 s**，分段
`subs` **2.9–3.7 s**、`roles` **2.4–5.5 s** —— 两段都**没有上限**，请求还压在事件循环上
（`summary` 与重活并发时从 16 ms 涨到 **772 ms**）。

- **`subs`**：枚举整棵 sessions 树是最贵的一步 ⇒ 两次之间至少 N 秒
  （`DSH_EXPERT_TEAM_SUBS_ENUM_MIN_INTERVAL_MS`，默认 30 s），窗口内**零枚举**；另给枚举期限
  （`DSH_EXPERT_TEAM_SUBS_DEADLINE_MS`，默认 800 ms），到点即停。被挡住的 id **不丢成员**：
  它只是没有 header，按既有口径如实显示"细节不可得"（不假装 0）。
- **`roles`**：读 MB 级子会话日志很贵且**不紧急** ⇒ 实时路径**默认零读**，未知角色如实显示为
  **待解析**（新字段 `rolesPending`，替代旧名 `rolesDeferred`；客户端**真的渲染**它），解析交给
  低频后台（每轮 ≤`DSH_EXPERT_TEAM_ROLES_PER_BURST`（默认 1）条、两次间隔
  ≥`DSH_EXPERT_TEAM_ROLES_MIN_INTERVAL_MS`（默认 30 s）），期限
  `DSH_EXPERT_TEAM_ROLES_DEADLINE_MS`（默认 600 ms）。已解析结果永久缓存 ⇒ `rolesPending`
  **单调下降收敛到 0**（旧实现每请求从零重算 ⇒ 实测 16→40 **上涨**）。
- **噪声纪律**（新）：**节流不是失败**，绝不每轮进 `degraded` —— 节流窗口内每次轮询都会命中，
  否则面板会长期挂一个降级标记，把真告警一起降权。节流的事实由 `subsPending` / `rolesPending`
  诚实表达；`degraded` 只承载**真截断**（`subs:deadline` / `roles:deadline`）。"缺块 ≠ 空数据"不变。
- 护栏：新增 `state-bounded.test.mjs`（13 条）钉死"零枚举 / 期限即停 / 零读 / 收敛 / 字段单一真源
  且被渲染 / 节流不进 degraded"。
- 顺带修两处**源码级断言与文本强耦合**（加五行代码就假红，属"断言失去判据对象"那一类）：
  `run-ownership` 的固定 2600 字符窗口改为**语义锚点切片**；`state-sections` 的正则改为只表达
  意图（不再绑死参数表）。**断言本身一字未改**。
- **诚实边界**：端到端墙钟需实机复测（本机装不进运行中的宿主）；本版给的是"机制级证据 +
  单位成本账"。默认值都可用上面的环境变量覆盖 —— 想更激进就调小间隔。

### 文档：「为谁而做」前置 + 主视觉（图 1）

- 「为谁而做 / Who it is for」提到 hero + 指标行之后、`速览` 之前（中英同序）；
- 新增 `docs/images/who-is-it-for.svg`（中）与 `.en.svg`（英，同布局同生成器）：顶带主张
  「一句话 → 一支完整技术部」、左带三类对象、主带 **12 个岗位卡 4×3**、
  「**你 · lead**」橙色胶囊**独占一带**、底带诚实边界；纯矢量、系统字体栈、配色克制；
- **保留**「岗位 → 角色 → 做什么」对照表（图下方）：**图给冲击力、表给检索**（表格是机读文本，
  比 SVG 里的字更可靠）；图号顺延为 图 1…图 8（中英一致、无重复）；图用绝对地址 + 关键词 alt；
- 自检：包围盒估算 → 两两相交 → 带约束 → 越界 → **文字溢出父容器**；首轮抓到英文 chip 超框
  16.8px 并修掉，最终两语言 无相交/无跨带/无越界/无溢出 + `xmllint` 良构；渲染由父会话浏览器核对。

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

### D. 会话模型 effort 预检（**只告警，不阻断**）—— 一次真实故障的定性

- **故障现象**：`model "deepseek-flash" does not support reasoning effort "low"`。**不是插件的错，
  也不是宿主缺 `low`** —— 是用户 `~/.dsh/settings.yaml` 里会话默认路由（命名空间 `agent-default-model`）
  的模型条目**漏写 `reasoningEfforts`** ⇒ 宿主能力表里该模型只剩 `off` ⇒ **任何**显式 effort 都被拒
  （`dsh-llm` 的 `resolveCallWithInfo`：`reasoning === undefined` 时只要传了 `reasoningEffort` 就抛
  `UNSUPPORTED_REASONING_EFFORT`）。而本 preset **8 个角色声明 `high`、4 个声明 `low`** ⇒ 该路由下
  **12 个角色全会失败**；"只有 low 报错"是假象（先派谁先报谁）。宿主在**任何网络 I/O 之前**就拒。
- **插件能做什么 / 不能做什么（如实写）**：派工由宿主 `tool-subagent` + LLM 运行时执行，插件**无法**
  在派工前改变宿主行为；能做的是**提前一行告警** + 给出修法。因此本项**只告警、不阻断、不改 preset 的
  effort 分档**（那是设计意图）。
- **实现**：新增 `lib/effort-preflight.js`（纯函数判定 + 有界重探接线）：读 preset 声明的 effort（真源，
  按行正则，不引 YAML 解析器）→ 读宿主公开入口 `agentDefaultModel.currentSelection()` 与
  `llm.resolveModelInfo(provider, model)` → 覆盖不全就**打一行**（含"改哪个命名空间/字段/值域"）。
  **读不到/抛错一律静默**（fail-open）；一次加载最多一行；服务晚挂则 `ctx.inject` 事件驱动重探。
- **`scripts/validate-agent-preset.mjs`** 补**值域**校验（`reasoningEffort ∈ off/low/high/max`）+ 结尾指路
  （脚本**不读用户机器**，只校验 preset 侧）。
- **文档**：README 中英 FAQ 各补一条（自然语言问句，便于检索）+ `llms.txt` 一行故障排查指针。
- **测试**：`effort-preflight.test.mjs`（真源分档 8/4 / 判定矩阵 / 只报一次且可操作 / fail-open 静默 / 只告警不阻断）；
  变异体 `M140-effort-preflight-blind`（缺档也不报 ⇒ 预检变睁眼瞎）**已实测**能杀死测试（5 条断言失败）。
### 其它

- 新增变异体 `M139-artifact-redirect-watch-blind`（候选提取恒空 ⇒ 观测器变睁眼瞎），
  catalog 139 条；**已实测**注入后该测试 **10 条断言失败**、还原后逐字节恢复。
- 测试文件 **85 个**；`npm run test:all` EXIT=0。

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
