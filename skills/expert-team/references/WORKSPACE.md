# 共享工作区工件 schema

运行目录 `<run-dir>/` 是团队的单一事实来源。工件与 JSON 结构如下，团队只通过它们交接。

## 文件清单

| 文件 | 维护者 | 内容 |
|---|---|---|
| `TASK.md` | /team 命令建（宿主执行）；lead 口述 + 指派的有 `write` 成员落盘（§2） | 目标、模式、交付口径、状态、交付结论 |
| `ROSTER.json` | /team 命令建/更新（宿主执行；lead 无 `write`，§2） | 角色编制、成员映射 |
| `STATE.json` | **运行时**（唯一写者） | 当前 phase / status / members |
| `任务看板.md` | lead 口述 + 指派的有 `write` 成员落盘（每个阶段结束一次） | 任务计划 + 状态表 + 当前阶段（可视化进度；工件以 `path` 可核验，交付时由 lead 用 `dsh_im_return_file` 发给用户） |
| `SPEC.md` | **pm 自己落盘** | Ultra Spec：功能目标、验收标准、业务规则、边界 Case、安全边界（三级权限）、测试计划 |
| `PLAN.md` | **architect 自己落盘**（pm 骨架 + architect 设计段） | 里程碑、接口契约（I/O JSON Schema）、数据流、风险 |
| `RESEARCH.md` | **researcher 自己落盘** | 代码定位、依赖、环境、存量约束 |
| `TASKS.json` | pm 初稿 → architect 细化 → lead 用 `/team task` 回写状态 | 唯一实现事实来源（含 dependsOn 依赖） |
| `REVIEW-SPEC.md` | **reviewer 自己落盘**（spec-review 阶段，可选） | 对 Spec 的交叉审查结论 |
| `REVIEW.md` | **reviewer 自己落盘** | 代码审查：问题清单、严重级、结论 |
| `TEST.md` | **qa/测试补位角色自己落盘** | 测试命令、结果、覆盖、结论 |
| `SUMMARY.md` | lead 口述 + 指派的有 `write` 成员落盘（deliver 阶段） | **交付总结**：各任务结论/改动/commit/评审测试结论 |
| `RUN.log.md` | /team 命令建；事件由产出该事件的角色落盘（lead 口述、指派有 `write` 的成员执行） | 运行轨迹（阶段/角色/决策/卡点，见 LOGGING.md） |
| `RETRO.md` | lead 口述 + 指派的有 `write` 成员落盘（deliver 阶段） | 本次复盘：快/慢/卡点/可复用经验 |

> run 工件一律由**产出它的角色自己 `write` 到 `<run-dir>/`**；角色只回 `path` + 摘要 + `verdict`；**lead 没有 `write`**，只读工件做门控与裁决（唯一权威表述见 `SKILL.md` §2）——工件因此是产出角色本轮的产出文件，以 `path` 可核验；交付时由 lead 用 `dsh_im_return_file` 发给用户（「聊天框可点击产出文件行」的机制未独立证实，不作为承诺）。

> `team/LEARNINGS.md` 位于 `<cwd>/team/`（跨 run 累积，不在单个 run 目录内）：lead 在 run 开始前**只读**；deliver 时由 lead 口述、指派的有 `write` 成员追加。

## TASKS.json

`TASKS.json` 是 implement 阶段（以及质量门禁）的唯一事实来源。每条任务带 **kind + 合同 + 状态机 + 审查轮次**，让「审查通过」成为**机器可判定**的事实，而不是靠 prompt 说“看起来没问题”。

```json
{
  "tasks": [
    {
      "id": "be-1",
      "kind": "implementation",          // requirements | research | design | implementation | verification | review | repair | integration | work | quality
      "owner": "backend",
      "title": "实现支付接口",
      "objective": "一句话目标",
      "spec": "按 PLAN.md 契约 §3.1 实现 POST /pay",
      "acceptance": ["SPEC.md 验收项 A1", "A2"],   // 字符串或数组，逐条可测
      "inScope": ["src/**", "tests/**"],           // 实现/修复任务的合法改动范围（完成时审计）
      "verify": ["pnpm test", "npm run build"],    // 完成前必须通过的验证命令
      "changedPaths": [],                          // 完成时由实现者回报，用于越界审计
      "contract": {},                              // 可选：结构化契约（接口 I/O JSON Schema），实现端只读
      "dependsOn": [],
      "attempt": 0,                                // 单调：每次重试/转派 +1
      "attemptId": null,                           // 每次 attempt 的唯一 id；迟到写入（旧 attemptId）必须被拒绝
      "round": 1,                                  // 审查轮次（review/requirements 用）
      "verdict": null,                             // pass | needs_revision | reject（review/requirements）
      "findings": [],                              // [{severity:"low|medium|high|blocker", title, detail}]
      "status": "pending"                          // pending|claimed|in_progress|completed|failed|cancelled|rework
    }
  ]
}
```

### 状态机（自动调度）

`pending → claimed → in_progress → completed | failed | cancelled`；`rework` 是 review 返工的过渡态（重跑后回 `in_progress`）。

- 依赖门控：只有上游 `completed` 才解锁下游；`failed` / `cancelled` **永不解锁**下游。
- `attempt` + `attemptId`：派工/转派时递增 attempt、设新 attemptId；成员回报时带当前 attemptId，**旧 attemptId 的迟到写入一律拒绝**，转派先使旧 attempt 失效。
- 空闲自动领题：persist 模式下，成员进入 idle（`list_agents` 显示 idle）后自动领取下一个 `pending` 且依赖已满足的任务；一个成员一次最多持有 1 个未完成任务。
- 冷启动恢复：run 恢复时，对残留的 `claimed / in_progress`（且本进程未观察过的新 attempt）自动重试一次。

### 质量门禁（直到共识）

“直到共识”的**机器定义**：下列全部满足才算通过，缺一不可：

```
所有必需门禁 pass
+ 所有 acceptance 通过
+ 无 blocker / high finding
+ 最新 attempt 已被独立 reviewer 审查（reviewer 不得审自己刚写的实现/修复）
+ 声明的 verify 命令已通过
+ changedPaths 落在 inScope 内（完成时越界审计）
```

- **review / requirements 任务**：只有 `verdict=pass` 才允许 `completed`；`needs_revision` / `reject` 必须 `failed` 且带 ≥1 条 finding，**不解锁下游**。
- **自动修复链**：某实现被 review 判非 pass 后，lead 自动新建 `repair-N`（依赖指向**被审查的实现任务**，**绝不依赖**那个 failed 的 review 任务）+ 下一轮独立的 `review-N+1`（针对最新 attempt，禁止用 `reassign` 重跑旧 review）。`round` 递增，直到 pass 或达到 `maxReviewRounds`；到顶后**升级到 lead/用户**，停止自动互审，不无限循环。
- **coverage matrix**：design 阶段，lead 把用户每个显式约束映射到 ≥1 条任务（用户说 5 件事，任务图至少能对上 5 件），在 `PLAN.md` 或看板里锁定。
- **完成时审计**：implementation/repair 回报 `changedPaths`；lead 对照 `inScope`，越界的改动不得标 `completed`（第一版是完成时审计，不是运行中写拦截）。
- **reviewer 守界**：reviewer 只读，不给修复任务标 `pass`；先审实现的最新 attempt，再下 verdict。

`kind=work` 兼容旧任务：无质量门禁的普通工作仍可用自由文本 `title` + `status` 完成。

## ROSTER.json

```json
{
  "runId": "<run-id>",
  "roles": ["pm", "architect", "researcher", "ui", "backend", "frontend", "dba", "sec", "reviewer", "qa", "devops", "docs"],
  "members": { "backend": "<subagentId 或空>", "frontend": "<subagentId 或空>" },
  "createdAt": "<iso>"
}
```

persist 模式下，`members` 记录每个角色的可继续子 agent id，供 resume 时 `send_message` 找回。

## STATE.json

```json
{
  "runId": "<run-id>",
  "phase": "clarify | design | implement | review | test | deliver",
  "status": "running | complete | failed",
  "mode": "one-shot | persist",
  "deliverable": "code+artifacts | artifacts-only",
  "coverage": [ { "constraint": "<用户约束>", "tasks": ["be-1", "fe-2"] } ],
  "members": ["<agentSessionId>:backend", "<agentSessionId>:frontend"],   // 形状 = <agentId>:<role>（真源：lib/command.js 的 roleOfAgent / membersFromState）
  "updatedAt": "<iso>"
}
```

`coverage`：design 阶段由 lead 把用户每个显式约束映射到 ≥1 条任务（见「质量门禁」），客户端浮层的「覆盖率」区展示。

## 交接约定

1. 每个角色的**结构化返回值**与它写的工件内容必须一致（结构化值是给编排脚本/下一阶段的机器可读摘要；工件是持久化事实）。
2. 下游角色读工件，不读上游的完整对话；跨角色接口一律以 `PLAN.md` 契约为准。
3. `STATE.json` 的**唯一写者是运行时**（本 run 实测 `revision=1`、`members` 被运行时增补）；角色与 lead **只读**，任何角色改完自己的工件后都不回写 `STATE.json.phase`。
