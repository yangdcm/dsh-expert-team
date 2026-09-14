# 阶段流水线与门控

顺序固定，每阶段有门控。门控未过不得进入下一阶段；返工只回退到受影响的角色，不整队重来。

| 阶段 | 执行者 | 输入 | 产出 | 门控（进入下一阶段的条件） |
|---|---|---|---|---|
| clarify | pm | TASK.md | SPEC.md（Ultra Spec）、PLAN.md 骨架、TASKS.json 初稿 | SPEC 验收标准逐条可测；安全边界三级权限写清；歧义已问或标为假设 |
| research | researcher | SPEC、PLAN | RESEARCH.md（代码定位/依赖/环境/存量约束） | 相关文件与调用链、环境结论、存量约束已写清（纯新项目可跳过） |
| design | architect(+dba 数据契约) | SPEC、RESEARCH、PLAN | PLAN.md「设计」段（接口 I/O 用 JSON Schema + 数据契约）、TASKS.json 细化 | **契约冻结到签名级**：字段/类型/错误语义/DML 明确且作为实现端只读基准；每任务有 owner+acceptance+dependsOn |
| **spec-review** | reviewer + sec(+性能补位) | SPEC、PLAN | REVIEW-SPEC.md（对 Spec 的交叉审查） | Spec 缺陷已修；验证者反向推导剔除幻觉误报 |
| **方案确认** | lead | SPEC、PLAN、TASKS | 中文「执行方案」汇总 + `ask_user_question` | 用户已确认「执行」；未确认不改代码、不进 implement |
| implement | backend/frontend(+ui/dba 按需)，**按 DAG 并行** | PLAN 契约、TASKS.json、UI.md | 工作区代码改动、TASKS.json 状态更新 | 每任务 `verify` 命令通过 + `changedPaths` 落在 `inScope` 内 + acceptance 证据齐；无未解决 blocker/choices |
| review | reviewer | SPEC、PLAN、代码 diff、最新 attempt | REVIEW.md + TASKS.json verdict | `verdict=pass` 才 `completed`；`needs_revision/reject` 必须 `failed` 且带 ≥1 finding；lead 自动开 `repair-N` + `review-N+1` |
| test | qa(+ui验证补位) | 代码 + 验收标准 | TEST.md（含证据） | **TDD 自愈闭环**：qa 先自动生成用例→运行；失败项自动新建 `repair-N`（kind=`verification`，依赖指向对应实现）→ 实现角色修复 → 重跑，直到通过或 `maxTestRounds`（默认 3），到顶升级用户；测试失败不得当通过 |
| deliver | lead | 全部工件 + 代码 | TASK.md 交付结论、STATE.json=complete、RETRO.md、LEARNINGS 追加 | 最终校验通过 + 无未关 blocker；到 `maxReviewRounds` 仍非 pass 的项已升级 |

## 门控判定原则

- **clarify**：任何会让开发/验收产生歧义的点，pm 必须 `ask_user_question`；拿不准就不进入 design。
- **research**：涉及存量代码的任务先调研；调研员只读 + 只读环境检查，产出 RESEARCH.md，让 architect/实现者不盲写。
- **design**：接口/DML 契约必须精确到 JSON Schema（字段/类型/错误语义）并**冻结为签名级基准**，实现端只读它——否则并行 backend/frontend 会产生字段/状态机交叉分歧（历史教训：曾一次返工 15 项）。涉及量表/迁移/报表的任务同时派 `dba` 出数据契约（PLAN.md 数据段），与接口契约双向核对后再冻结。
- **spec-review（Spec 交叉审查）**：写代码前对 Spec 做多视角并行审查——架构师视角查模块边界/接口，reviewer 视角查正确性，`sec` 视角查权限/注入/敏感数据，性能补位视角查风险；再用「验证者反向推导」剔除幻觉误报。Spec 是最大杠杆，这里多花一点省后面几倍返工。
- **方案确认（用户拍板，必须）**：spec-review 通过后，lead 用**中文**汇总成一份「执行方案」（范围/关键决策/任务清单/风险），`ask_user_question` 让用户选「执行」或「修改方案」。**未确认不得 implement**；用户要求修改 → 回 pm/architect 改 `SPEC/PLAN/TASKS` 再确认。这是防止「没确认就开工」的关键门控。
- **implement**：按 `TASKS.json` 的 `dependsOn` 排成 **DAG 顺序**派工（不是无脑并行）——无依赖的并行，有依赖的按序。共享工件（TASKS.json）由各实现者「只改自己的条目」更新，避免互踩；跨模块接口冲突由 lead 裁决。
- **大工件安全返回**：不要把超大交付物（整份 schema、长设计文）塞进 one-shot workflow 的聚合返回——会被截断、丢失后段角色。改用子角色 `send_message` 单发，或拆成多个小 workflow；关键字段先确认非截断（历史教训：曾整段丢失 backend/frontend/reviewer/qa 与 architect 尾部）。
- **契约只读并行**：implement 开始时，实现者先读冻结的 PLAN.md 契约；跨角色要改契约（字段/状态机）必须先提给 lead 仲裁，不得各自临时改——否则并行出分歧（历史教训）。
- **模糊选择拍板**：实现中遇到「算法用哪个 / 兼容是降级还是报错」这类模糊选择，lead 抛候选项 `ask_user_question` 让用户拍板，不让 AI 闷头猜。
- **review→rework**：reviewer 只读审代码（正确性/安全/性能/架构一致性），盯逻辑错误、别纠结样式；只把受影响任务标 `rework` 并重跑对应实现角色。
- **test**：必须真实执行（bash），结果+证据写进 TEST.md，不凭推断；有 UI 的任务加 ui验证补位做端到端。
- **deliver**：lead 亲自做最后一次构建/测试校验，写交付结论 + RETRO.md，把可复用经验追加进 LEARNINGS.md。

## 回退规则

- spec-review 发现 Spec 有误 → 回 clarify/design（pm/architect 改 Spec）。
- implement 发现契约有误 → 不回退全队，写 blocker 交 lead 转 architect，只重定契约后重跑受影响实现者。
- review 非 pass → 不重跑旧 review：lead 自动建 `repair-N`（依赖指向被审的实现任务，不依赖 failed 的 review）+ 新 `review-N+1`（针对最新 attempt），直到 pass 或 `maxReviewRounds`，到顶升级到用户。

## 质量门禁与自动调度（机器可判定）

“直到共识”不是“几个角色都说没问题”，而是下列**全部**满足（详见 `WORKSPACE.md`）：

```
所有必需门禁 pass + 所有 acceptance 通过 + 无 blocker/high finding
+ 最新 attempt 已被独立 reviewer 审查 + 声明的 verify 命令通过 + changedPaths 在 inScope 内
```

- **任务 kind 与合同**：`requirements / research / design / implementation / verification / review / repair / integration / work / quality`（**阶段即 kind**：research 阶段给 researcher 的调研任务写 `kind=research`，design 阶段给 architect 的设计任务写 `kind=design`；不要自造词表外的 kind——写了不阻断门禁，但会告警且该任务没有 kind 专属门禁）。实现/修复任务必须带 `objective/acceptance/inScope/verify`，才能建；没有合同的实现任务不要创建。
- **状态机**：`pending → claimed → in_progress → completed | failed | cancelled`；`rework` 为 review 返工过渡态。依赖只认上游 `completed`，`failed/cancelled` 永不解锁下游。
- **attempt/attemptId**：每次派工/转派递增 attempt、设新 attemptId；成员回报带当前 attemptId，旧 attemptId 的迟到写入一律拒绝；转派先使旧 attempt 失效。
- **空闲自动领题**：persist 模式下，成员 idle 后自动领下一个依赖已满足的 `pending` 任务；一成员一次最多 1 个未完成任务；冷启动对残留开放 attempt 自动重试一次。
- **自动修复链**：review 非 pass → `repair-N` + `review-N+1`（独立、针对最新 attempt），`round` 递增至 `maxReviewRounds`，到顶升级到用户，不无限互审。
  - **轮次上限是代码强制，不是口号**（2026-09-11 起）：`maxReviewRounds` / `maxTestRounds` 落在 `lib/command.js` 的 `ROUND_LIMITS`（默认 3/3；`config.limits` 或 env `DSH_EXPERT_TEAM_MAX_REVIEW_ROUNDS` / `DSH_EXPERT_TEAM_MAX_TEST_ROUNDS` 可改）。四道机判：① 读侧 `/team check` 报 **`REWORK_LOOP_UNESCALATED`**（超过上限且无 `pendingDecision`）；② 读侧报 **`FINDING_REOPENED`**（同一 finding 连续两轮未闭环 ⇒ 判为**规格歧义**，应升级裁定而非再派修复）；③ 写侧**新建**超限质量任务且无 `pendingDecision` ⇒ **落盘前拒绝** `REWORK_LOOP_LIMIT`（fail loud，不静默截断）；④ METRICS 出「评审效率（轮次/撤销率）」。
  - **到顶的正确动作是「升级用户」，不是「再来一轮」**——想继续必须先把 `pendingDecision` 立起来（用户点「继续」后再临时调高上限）。
  - ⚠️ **诚实边界（不要高估写侧拦截）**：写侧 `REWORK_LOOP_LIMIT` 只挡**经插件路由**的写入，且实际可达的只有 **`/plan/approve`** 一处（`/plan` 因 `normalizeDraft` 钉死 `round:1` 而不可达；面板的任务路由只按 id 改既有任务、无新增面，故不需要守卫）。**lead 用 `write`/`edit` 直接改 `TASKS.json` 会完全绕过它**（那是文件工具，不经过插件）——而"lead 自己回写 TASKS.json"恰恰是本 skill 要求的常规动作。⇒ **真正的强制点是读侧**：`checkTasks` 在**每次 `/state` 轮询**与 `/team check` 都会重算违规并推到浮层红条，绕不过去。另：`POST /plan` 因 `normalizeDraft` 把 `round` 钉死为 1，**本来就造不出**超限任务（该路由不可达属预期，不是漏洞）。
  - 收敛口径：只有 **P1/P2 + 可机判项**阻塞 `pass`；**P3/文字项不阻塞**（进 backlog）；`verify` 未实跑不得计 pass。
- **coverage matrix**：design 阶段把用户每个显式约束映射到 ≥1 条任务并在 PLAN/看板锁定。
- **reviewer 守界**：只读；不给修复任务标 pass；不审自己刚写的实现/修复。
- **完成时越界审计**：实现者回报 `changedPaths`，lead 对照 `inScope`，越界不得标 `completed`。
