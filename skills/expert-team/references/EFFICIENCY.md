# 效率规则

「专家团」的高效来自结构，而不是堆算力。编排者必须遵守。

## 1. 并行扇出

- implement 阶段的后端/前端/补位角色**并行**启动，不串行等待。
- 无依赖的任务用 `workflow` 的 `parallel()`，或 persist 模式下同时 `subagent run_in_background` 多个成员。
- 有依赖的阶段（clarify→design、review 依赖 implement）保持串行门控。

## 2. 阶段门控防上下文漂移

- 每个角色**只读上一阶段产物 + 直接输入**，禁止重读整条对话历史。
- 交接走结构化值 + 工件文件，二者一致。
- 好处：子 agent 上下文小、请求前缀稳定、KV cache 复用高。

## 3. 结构化交接

- 每个角色带 JSON `schema` 返回，下游据此解析，不回读原始文本。
- schema 只声明需要下传的字段（详见各角色模板），不要塞大文本。

## 4. 角色守界（toolFilter 纪律）

| 角色 | 能 | 不能 |
|---|---|---|
| pm / architect | 读、写自己工件、ask_user_question | 改代码、跑实现命令 |
| backend / frontend | 写/编辑代码、bash 自检、读契约 | 改 SPEC/PLAN 契约、评审他人 |
| qa | 读、跑测试/构建、写 REVIEW/TEST | 改业务代码 |

守界既是质量保证，也是效率：防止角色做超范围的事、产生返工与上下文浪费。

## 5. 限深

- 委派深度 ≤ 2（团队不递归组建子团队）。**`maxDepth` 是子代理深度的绝对上限**（`childDepth = parentDepth + 1 ≤ maxDepth`）：角色工具写 `1`（lead 第 0 层 → 角色第 1 层，且角色不能再派）；**写 `0` 会让所有角色工具报 `subagent depth 1 exceeds maxDepth 0`**。通用 `subagent` 保持平台默认 `3`，但协议上不递归组建子团队。
- 需要更大规模时，先问用户。

## 6. 稳定前缀

- 角色 prompt 固定（来自 ROLES.md 模板），工件路径固定。
- 避免把易变文本重复注入；状态变化写进 `STATE.json` 而非每条消息都带全量状态。

## 7. 不空转

- 阶段产物一次到位：pm 一次性把验收标准定清，architect 一次性把契约定清。
- review 返工只重跑受影响角色，不整队重来。
- deliver 只做一次最终校验 + 汇总。

## 8. 后台优先

- 能后台就后台：persist 模式用可继续子 agent，编排者不阻塞等待；成员结算通知会带回结论。
- one-shot 批量交付才用会阻塞的 `workflow`（用户明确「做完再回来」）。

## 9. 自动调度（状态机 + 依赖门控）

- **状态机**：任务 `pending → claimed → in_progress → completed | failed | cancelled`，`rework` 为 review 返工过渡态。终态（`completed/failed/cancelled`）只读。
- **派工与结算即时回写 `TASKS.json`**（头号纪律，日志分析实证）：派工→任务 `claimed/in_progress`；成员完成→`status=completed` + `changedPaths` + `verify`。只更新看板/聊天 ≠ 更新状态；阶段进入 implement 后「依赖已就绪却仍 pending」= 状态冻结违规（host 门禁 + 浮层红条）。
- **契约冻结再并行（签名级）**：implement 前 architect 先产出签名级契约（字段/接口/DDL/状态机含豁免与边界），backend/frontend 只读它实现——并行角色在边界上的分歧必须在契约里前置冻结（历史 run：DDL 15 项分歧、MASK_KEYS 子串误伤导致返工）。
- **大工件不走 workflow 聚合返回**：超大内容（schema 全文/设计长文）塞进聚合返回值会被截断并丢失后段角色；用子角色 `send_message` 单发、拆分小 workflow，或只回位置引用由 lead 读盘。
- **依赖只认 completed**：派工前用 `unsatisfiedDependencies()` 校验；上游仍 `pending/claimed/in_progress` 的任务一律不派；`failed/cancelled` 永不解锁下游。
- **一个成员一次一个未完成任务**：别让同一个成员同时持有两个在办任务。
- **空闲自动领题**：persist 模式下，成员 idle（`list_agents` 为空闲 / 收到结算）后自动领下一个依赖已满足的 `pending` 任务，别等到 lead 显式点名。
- **attempt/attemptId**：每次派工/转派 `attempt+1`、设新 `attemptId`；成员回报必须带当前 `attemptId`，**旧 attemptId 的迟到写入一律拒绝**；转派/接管先使旧 attempt 失效并等待旧成员安静。
- **冷启动恢复**：run 恢复时对残留开放 attempt 自动重试一次；别把停驻 attempt 当可无限重派的 `pending`。

## 10. 不要自己审自己 / 不无限互审

- reviewer 不审自己刚写的实现/修复；修复者不把 review 标 pass；没有用户要求，不让 Captain 自己批准自己的实现。
- review 非 pass 只重跑受影响实现 + 新建独立 review，不整队重来。
- 达到 `maxReviewRounds` 后升级到用户，不无休止地“再来一轮”。**这条现在是代码强制**（`ROUND_LIMITS` + 违规码 `REWORK_LOOP_UNESCALATED` / `FINDING_REOPENED` + 写侧拒绝 `REWORK_LOOP_LIMIT`，见 PIPELINE.md「自动修复链」）；同一 finding 连续两轮未闭环 ⇒ 判**规格歧义**，升级用户裁定，不再派修复。
- **返工预算意识**：一次 run 的返工轮数是**成本指标**。实证事故：某 run 68 任务 / 32 条 repair / maxRound=8，评审每轮都在**新增** finding（每轮还撤销约 8 条幻觉）——**验收面无界 + 噪声制造返工** 是循环的两个真实来源，解法是「边界前置到 SPEC」（见 pm 的「边界与禁止项」）与「撤销前置到派工前」（见 reviewer 职责 5），而不是加班修更多轮。

## 11. 安全与守界（工具纪律 + 越界审计）

> 说明：dsh 0.1.2-rc.1 无 PreToolUse/PostToolUse 这类插件级拦截 hook（仅 `fs/observed`/`tools/result` 事后事件）；成员的真正工具边界由 **expert-team preset 的 toolFilter** 保证，越界由**完成时 `changedPaths` 审计**兜底。本协议在编排层再加固。

- **工具守界**：非实现角色（pm/architect/researcher/ui/reviewer/sec/docs）在 preset toolFilter 里不得有写业务代码/改文件工具，只读；qa/devops 只跑测试/构建/部署命令，dba 只做只读查询。越权工具已从 preset 移除；若遇通用 subagent 回退，写进 prompt 的 ROLES.md 守界条款同样适用。
- **实现者只动 `inScope`**：每条实现/修复任务的 `inScope` 写清合法改动范围；实现者不得改 `outOfScope` 文件；完成时回报 `changedPaths`，lead 对照 `inScope` 审计，越界不得 `completed`。
- **高危命令**：成员（尤其实现者）禁止执行 `rm -rf`、`sudo`、`chmod 777`、`git push --force` 等破坏性/生产命令；这些只由 lead 在**沙箱/受控终端**里跑（dsh sandbox 已启用时），且需用户确认。
- **审计**：lead 把关键工具/文件变更链路记入 `RUN.log`（`tool:bash <cmd>`、`fs:write <path>`）——§2 口径：lead 无 `write`，内容由 lead 口述、指派的有 `write` 角色落盘——形成可追溯审计；`/team learn` 会聚合高频错误/越界。
