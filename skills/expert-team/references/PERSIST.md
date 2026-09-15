# persist 模式：持久化活成员协议

`TASK.md.mode == persist` 时使用本协议（不用 `workflow`）。目标：把每个角色变成**可反复指挥、可跨会话恢复**的活成员。

## 1. 启动成员

为每个固定/补位角色启动一个**可继续**子 agent：

- **优先用角色工具**（会话运行在「专家团模式」preset 时可用）：`subagent_pm` / `subagent_architect` / `subagent_researcher` / `subagent_ui` / `subagent_backend` / `subagent_frontend` / `subagent_dba` / `subagent_sec` / `subagent_reviewer` / `subagent_qa` / `subagent_devops` / `subagent_docs`。它们的 persona、toolFilter、maxDepth 已由配置保证——`prompt` 里只需给「本阶段任务 + 要读写/更新的工件」，`description` 用角色名。
- **退回通用 `subagent`**（未运行 expert-team preset 时）：`prompt` 用 `ROLES.md` 里该角色的完整模板（含通用前缀，并把 `{{run-dir}}` 替换为真实路径、`{{role}}` 替换为角色名），`description` 用角色名。
- `run_in_background` 默认 true。返回 `{ subagentId }` 后：`ROSTER.json` 的写入按 §2 由产出角色执行（lead 只读），`STATE.members` 由运行时回写。

## 2. 指挥成员

- 派活：`send_message(subagent_id, "<本阶段指令>")` —— 指令指向 `<run-dir>/` 的具体工件与要产出/更新的文件。
- 看状态：`list_agents()` 看成员 running/idle/ready。
- 打断：`interrupt_agent(agent_id)` 停当前轮（幂等）。
- 收结论：成员结算时会推「settlement notice」带最终结论；也可用其 transcript（按 subagent id 读）取详细输出。
- **冷恢复**：`list_agents` 里 `ready`（仅存于存储）的成员，用 `send_message` 冷恢复后继续；`interrupted`/停驻的 attempt 通过定向 message 续（不重铸）。

### 2.5 成员直发消息与交接（定向分发，lead 仲裁）

- **定向分发**：`send_message` 永远指向**具体成员 id**（`ROSTER.json.members[role]`），不要广撒。每条消息只含该成员需要的那一段工件契约/范围，避免上下文稀释。
- **角色↔角色交接**：若后端实现中发现契约问题需要前端知道，**由你（lead）定向转发**——把后端 report 里的「需前端确认项」用 `send_message` 传给前端成员；成员之间不直接互发（保持 lead 仲裁线）。
- **mailbox 语义（可选）**：成员 report 里可带 `needs:[{role, note}]` 字段，你据此逐条定向派发给对应成员（相当于把成员的「待办留言」变成一条条直发消息）。你记录每次转发的 `role:from→to` 到 `RUN.log`，形成可审计的交接链。
- **不要**：让 `send_message` 当正式下一轮审查/评审（邮件无门禁）；跨角色契约裁定必须过 lead。

## 3. 阶段推进（persist 版流水线）

仍按 clarify→design→implement→review→test→deliver 推进，只是每一步由你向对应成员 `send_message` 派活。**run 工件一律由产出它的角色自己 `write` 到 `<run-dir>/`；角色只回 path + 摘要 + verdict，你（lead）只读工件做门控与裁决**（唯一权威表述见 `SKILL.md` §2）：

1. 给 `pm` 成员派 clarify，等其 report path + 摘要 + verdict → SPEC.md / PLAN.md 骨架 / TASKS.json 由它自己 `write`，你只读做门控。
2. 给 `architect` 成员派 design，等其 report path + 摘要 + verdict → PLAN.md 设计段 / TASKS.json 细化由它自己 `write`，你只读做门控。
3. 给 `backend`/`frontend` 成员**同时**派 implement（并行），等其 report 各任务 status + path → 各自把自己任务在 TASKS.json 里的 status 由自己 `write` 更新，你只读做门控核对。
4. 给 `reviewer` 成员派 review，等其 report path + 摘要 + verdict → REVIEW.md 由它自己 `write`，你只读做门控；需返工时只给受影响实现成员派 rework。
5. 给 `qa` 派 test，等其 report path + 摘要 + verdict → TEST.md 由它自己 `write`，你只读做门控。
6. 你亲自 deliver：汇总 + 最终校验 + 由你裁决交付结论；`RETRO.md` 的内容由你口述、由指派的有 `write` 成员落盘，`STATE.json` 只由运行时写（见 `SKILL.md` §2 唯一权威表述）。

## 4. 跨会话恢复

- 成员是可继续子 agent，会话持久化后仍可恢复；`/team resume <run>` 会再次把你唤起，并让你读 `team/<run>/` 与 `STATE.json`。
- resume 时：读 `STATE.json.phase` 与 `ROSTER.json.members`；若成员 `ready`（仅存于存储），用 `send_message` 冷恢复它并从当前阶段继续；不要从头重跑。
- 每次阶段推进**读** `STATE.json`（写入由运行时负责），保证中断后能续。

## 5. 收尾

- deliver 完成后，`STATE.json.status = complete`；成员可保留（活团队）供继续指挥，也可不再理会（结算后自然停稳）。
- 要彻底解散，可不再给成员派活；其会话仍是持久记录。

## 6. 常驻团队模式（对齐 Qoder 的自动触发）

persist 模式下，**本会话此后每条新消息都当作对本团队的输入**，不要当新对话。由 lead 判断分派：
- **需求/新目标 → 先派 `researcher` 调研**（对齐「一有需求就触发调研员」），再进 clarify/design；
- **修改/迭代意见 → 交给对应实现成员**（backend/frontend/补位）；
- **评审/测试要求 → reviewer / qa**；
- **简单提问/状态 → 直接回复**，或 `list_agents` 看成员的 running/idle/ready、用 `STATE.json` 摘要当前阶段与进度。
- 成员可定向 `send_message`；跨角色契约裁定仍由 lead 仲裁。
