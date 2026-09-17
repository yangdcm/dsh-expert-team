# 运行日志与自我优化（LOGGING）

团队运行期间必须持续记录，供后续迭代升级与自我优化。日志是**结构化、可 grep、可累加**的。

## 三个产物

| 文件 | 谁写 | 何时 | 用途 |
|---|---|---|---|
| `<run-dir>/RUN.log.md` | 产出该事件的角色落盘；lead 口述内容、指派有 `write` 的成员执行 | 每完成一个阶段/角色/决策/卡点 | 单次运行的可回放轨迹 |
| `<run-dir>/RETRO.md` | lead 口述 + 指派的有 `write` 成员落盘 | deliver 阶段 | 本次复盘：快/慢/卡点/经验 |
| `<cwd>/team/LEARNINGS.md` | lead 口述 + 指派的有 `write` 成员追加 | deliver 阶段（**run 开始前先读**） | 跨运行累积的可复用经验 |

## 事件约定（RUN.log.md 每行一条）

统一格式：`- [HH:MM:SS] <type> — <详情>`。`<type>` 固定用下列词，便于 grep/统计：

| type | 触发时机 | 详情示例 |
|---|---|---|
| `run:started` / `run:resumed` | 命令自动写 | 目标/模式/交付/编制 |
| `phase:<阶段名>`（**推荐**）；`phase:started` / `phase:completed` 仍兼容 | 每次阶段流转 | `phase:design — design (architect)` |
| `role:invoked` | 启动某角色（workflow agent / 可继续成员） | `role=backend tool=subagent_backend id=<id>` |
| `role:result` | 某角色返回 | `verdict=pass/rework/fail`、`blockers=`、`issues=` |
| `first-runnable` | **首个最小可运行骨架落盘**（E1：run 开始 ≤10 分钟内，见 SKILL §7.32） | 冒烟命令 + 原始输出摘要 |
| `ask:clarify` | clarify 向用户提问（**clarify 阶段每抛一个问题追加一行**，不要合并成一行） | 问题摘要 |
| `answer` | 用户回答 | 答案摘要 |
| `decision` | lead 做裁决/合并冲突 | 结论 + 理由 |
| `scan:single-source` | **发现一处「同一事实多份拷贝」后当轮做完全仓总扫**（E3，见 SKILL §7.34） | `事实名 + 命中 N 处` |
| `tokens:<scope>` | **可选**：记一次会话的 token 用量（P5 线；通常**不必写**——METRICS 直接读 DSH 会话遥测，见下） | `steps=62 in=2621 cache=177955 out=1132 peak=528246` |
| `artifact` | 工件被写/改 | `SPEC.md written` |
| `error` | 任何失败/卡点 | 角色 + 原因 |
| `run:completed` | deliver 完成 | verdict + 交付清单 |

要求：**每个阶段开始与结束、每个角色调用与返回，至少各记一行**；卡点/返工/裁决必须记（这是自我优化的核心素材）。
补充（聚合器兼容性，2026-09-08 日志分析后定稿）：
- **事件写成 `error:<子类>`（如 `error:workflow`/`error:external-write`）、`decision:<来源>`（如 `decision:user`）、`role:<角色>`（如 `role:pm`）；聚合器按「事件族」（冒号前那段）统计，子类保留用于定位根因**——METRICS 会渲染成 ``- `error:external-write` × 9 — <首条详情样例>``，所以子类要稳定、可归类，不要每次换词。
- **阶段行统一写 `phase:<阶段名>`**（如 `phase:implement — 并行派工 …`、`phase:design — design (architect)`）。`phase:started` / `phase:completed` 这两种旧写法**只对 ASCII 阶段名兼容**：聚合器从详情里取**第一个 ASCII 词**再校验词表（`design (architect)` ⇒ `design`）。⚠️ **中文阶段名（如 `方案确认`）必须直接写 `phase:方案确认`** —— 兼容形式解析不出中文词，该行会被**整行跳过**（宁可不计，也不记成伪阶段）。阶段名必须落在流水线词表内（`clarify` / `research` / `design` / `spec-review` / `方案确认` / `implement` / `review` / `test` / `deliver`）；**解析不出、或不在词表内就整行跳过** —— 绝不会记成 `started`/`completed`/`backend` 这种伪阶段、把「阶段覆盖」这一节污染掉。（已登记 backlog：把兼容形式改为「先对词表做包含匹配、再退回 ASCII 词」，让中文阶段名在旧写法下也能计入。）
- **`phase:review` / `phase:test` 是"冻结观测点"，漏写会让收尾时长整个隐形（E2）**：METRICS 的「收尾预算」节用**首个 `review`/`test` 阶段事件**把「实现期」与「冻结后收尾」切开（实现期 3h23m vs 收尾 3h35m 就是这样量出来的）。实测某真实 run **一条 review/test 事件都没写** ⇒ 那 3h35m 在指标上完全不存在。聚合器**不猜**：缺了就是「分不开」，单列成 ⚠️ 项 —— 也不要事后补写假事件。
- **判决只认 `verdict=<token>`，合法 token 词表固定为：`pass` / `needs_revision` / `rework` / `fail` / `conditionally-pass`（等价写法 `conditional`、`conditionally` 也记 pass）**。三条硬规则：① **允许 markdown / 全角包裹**（`` verdict=`needs_revision` ``、`verdict=「needs_revision」`、`**verdict=needs_revision**` 都会被剥掉包裹后识别）；② **无法识别的 token 一律不计判决**（`verdict=foo`、`verdict=pass_unverified` 既不记 pass 也不记 rework，且**绝不回落**到从中文散文里猜判决 —— 那正是把 `needs_revision` 误判成 `pass` 的老 bug）；③ **只认 `verdict=`，`verdict:` 不算**。判决请按 token 写，别把结论只写在散文里。
- **时间戳必须是实际时刻 `HH:MM:SS`，禁止 `[now]`**——`[now]` 会让聚合器丢事件（历史 run 全用 `[now]`，决策/阶段统计全部漏掉）。**E1 的「首个可运行产物耗时」直接依赖这条**：它 = `first-runnable` 的时间戳 − `run:started` 的时间戳，写成 `[now]` 就**算不出**（聚合器按「登记了但算不出」单列，不会退化成 0——退化成 0 会把"没测到"读成"很快"）。
- **质量任务用 `kind: verification` 或 `kind: quality`，归属 `qa`/`reviewer`**，不要挂给实现者（历史 run 把 Q1 安全自检挂了 backend，被判归属违规）。写状态用 `/team task <id> <状态>` 一条命令回写。
- **RETRO.md deliver 必填**（结果/时间与卡点/做得好的/做得慢的/可复用经验），由 lead 口述、指派的有 `write` 成员落盘——`/team check` 在 deliver/complete 时会检测模板占位并提示；复盘是自我学习的输入。

### token 记账（P5 线 · 通常**不必写**）

`/team learn` 生成的 METRICS 里有「token 成本与上下文峰值」一节，它的数**自动**来自 DSH 会话遥测
（`~/.dsh/sessions/<workspace-slug>/<session>/session.v3.jsonl.zstd` 里每条 `assistant/message` 的 `usage`），
归属靠「派工提示词里带的 **run 目录路径**」——**所以 lead 不需要为此额外记任何日志**。

只有在**会话文件读不到**时（换机器跑、会话被清理）才需要手工补，写法：

```
- [HH:MM:SS] tokens:lead — steps=2279 in=6575499 cache=967380736 out=1646348 peak=799958
- [HH:MM:SS] tokens:backend — steps=62 in=2621 cache=177955 out=1132 peak=528246
```

字段含义与**硬规则**：
- 五个字段：`steps` 步数 · `in` **未缓存输入** · `cache` **缓存输入** · `out` 输出 · `peak` 单步 prompt 峰值（可选 `first` = 会话首步 prompt）。允许 `k`/`m` 后缀（`peak=426k`）。
- `tokens:<角色>` 的 `<角色>` 用**规范英文 id**（`lead` / `pm` / `backend` / `qa` …），与 `role:` 事件同一套。
- **字段名写错会让整行作废并计入报告的 ⚠️ 坏行数**（不再静默丢掉那一个字段）——近似拼法（`input=` / `cache_read=` / `total=`）都不认，请照上表写。
- 也可以把用量挂在既有的 `role:` 行上：`- [HH:MM:SS] role:backend — tokens steps=62 in=2621 cache=177955 out=1132`。
- **日志事件与遥测不混算**：某 run 有遥测就用遥测，没有才用日志事件，报告里会标明来源。
- 为什么值得记：**prompt 体积 × 步数**才是成本主因（输出 tokens 占比、缓存读占比等数值的**唯一权威都是 `lib/metrics/tokens.js`**，本文件不再另写数值——一条 lead 会话累计 prompt 可达 **9.7 亿**、每步 prompt 中位数 **426K**）。有数才谈得上收缩。

## 自我优化闭环

1. **run 开始前**：lead 读 `<cwd>/team/LEARNINGS.md`（若存在），把相关经验融入本次编排（例如「上次前端接口契约不清导致返工，这次 design 阶段先把契约写到签名级」）。
2. **run 过程中**：按上面事件约定持续记 RUN.log.md。
3. **deliver**：写 RETRO.md（快/慢/卡点），并把「可复用经验」沉淀——两者均由 lead 口述、指派的有 `write` 成员落盘/追加（lead 自己不做 `write`）。经验**分两层**，写到不同文件（避免项目私有知识污染跨项目复用）：
   - **团队/流程级**（跨项目可复用的编排教训，如「大工件别塞 workflow 聚合返回」「并行前先冻结契约」）→ 由被指派的有 `write` 成员追加到**全局** `~/.dsh/expert-team/LEARNINGS.md`。
   - **项目级**（本项目专属坑/环境/约定，如「本项目签名是 HMAC 非 RSA」「该模块测试环境要看 X」）→ 由被指派的有 `write` 成员追加到 `<cwd>/team/LEARNINGS.md`。
4. **落 Hindsight（跨项目召回）**：deliver 时用 `hindsight_ingest_document` 把本次「可复用经验」（RETRO 要点 + 蒸馏的 LEARNINGS，标题 `专家团经验 · <runId>`）保存一次，供其它会话召回；不要倒大段原始输出。

LEARNINGS 每层都分两类沉淀（这是自我优化的核心）：
   - **Team Skill**：`- [日期] <任务类型> → 最优派工顺序/角色是 <...>`（哪类任务用哪种派工顺序最顺、哪些角色可省）。
   - **Expert Skill**：`- [日期] <角色/模块>：<历史坑/环境怎么起/注意事项>`（某模块测试环境怎么起、某接口有哪些坑）。

## 原则

- 只记**事实与结论**，不记大段原始输出（原始输出已在各角色 transcript/工件里）。
- 日志是追加式，不要重写历史；时间戳用本地 `HH:MM:SS`。
- **`role:result` 尽量写成 `role=<角色> verdict=<pass|rework|fail>`**（如 `role=backend verdict=rework`），让 `/team learn` 统计角色成败；即便不写该字段，聚合器也会尽力从文字推断（如「返工」「不一致」→ rework）。
- 卡点与返工**必须如实记**——掩盖问题会破坏自我优化的数据基础。
