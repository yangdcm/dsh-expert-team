// 一次性自动组队（one-shot）编排范本 —— 供编排者按需改写。
//
// 这是 `workflow` 工具的 script 体（纯 JS，无 `export const meta`）。
// 编排者用它把每个角色作为一个 agent(prompt, {label, phase, schema}) 扇出。
// 使用前把下列占位符替换为真实值：
//   {{run-dir}}   → 运行目录绝对路径（/team 命令返回的 runDir）
//   {{task}}      → 用户目标
// 角色 prompt 直接取自 ROLES.md 的模板（含通用前缀）。
//
// ★ 反截断约定（历史教训：workflow 聚合返回会被截断，曾丢 backend/frontend/reviewer/qa
//   与 architect 尾部）：**大工件由角色自己用 write 落盘到 {{run-dir}}/ 下**，返回值只给
//   路径 + 摘要/verdict/tasks 等小字段。规划/评审/测试工件不是业务代码，角色可写；
//   业务代码仍只在工作区改。workflow 返回后 lead 据此——若角色成功写了文件，lead 无需
//   重复落盘（聊天框可点击性权衡：见下方「落盘说明」）。

phase("clarify");

const spec = await agent(
  `【产品经理】运行目录：{{run-dir}}。\n` +
  `读 {{run-dir}}/TASK.md 与 SPEC.md（若存在）。\n` +
  `1) 找出会阻塞开发/验收的歧义，用 ask_user_question 向用户确认（不要猜）；小决策标为「假设」。\n` +
  `2) 产出 SPEC.md 的完整内容（Ultra Spec：功能目标/验收标准/业务规则/边界Case/安全边界三级权限/测试计划）。\n` +
  `3) 产出 PLAN.md 骨架内容（设计段留空给 architect）。\n` +
  `4) 产出 TASKS.json 任务数组（id/owner/title/spec/acceptance/dependsOn/status=pending）。\n` +
  `★ 用 write 把 SPEC.md 完整内容写到 {{run-dir}}/SPEC.md、PLAN 骨架写到 {{run-dir}}/PLAN.md；\n` +
  `   TASKS.json 数组因体量小可只放进返回值（由产出角色自己 write 到 run-dir；见 SKILL.md §2），也可一并 write。\n` +
  `返回值只回：specPath、planPath、tasks（小）、openQuestions（小）。不要在返回值里塞 SPEC/PLAN 全文。\n` +
  `目标：{{task}}`,
  { label: "pm", phase: "clarify", schema: { type: "object", properties: { specPath: { type: "string" }, planPath: { type: "string" }, tasks: { type: "array", items: { type: "object" } }, openQuestions: { type: "array", items: { type: "string" } } }, required: ["specPath", "tasks"] } }
);

phase("design");

const design = await agent(
  `【架构师】运行目录：{{run-dir}}。\n` +
  `读 {{run-dir}}/SPEC.md 与 PLAN.md。\n` +
  `1) 产出 PLAN.md「设计」段完整内容：模块边界、接口契约（I/O 用 JSON Schema **精确到字段名/类型/枚举逐字**）、数据流、选型与风险。\n` +
  `2) 产出细化后的 TASKS.json 任务数组（每条给 owner/acceptance/dependsOn）。\n` +
  `★ 用 write 把「设计段完整内容」追加/写入 {{run-dir}}/PLAN.md；返回值只回 planPath、tasks、risks（小），不要回设计全文。\n` +
  `需求澄清：${JSON.stringify(spec.openQuestions)}`,
  { label: "architect", phase: "design", schema: { type: "object", properties: { planPath: { type: "string" }, tasks: { type: "array", items: { type: "object" } }, risks: { type: "array", items: { type: "string" } } }, required: ["planPath", "tasks"] } }
);

phase("implement");

const implementers = await parallel([
  () => agent(
    `【后端工程师】运行目录：{{run-dir}}。\n` +
    `只实现 TASKS.json 里 owner=backend 的任务，以 PLAN.md 契约为准（读 {{run-dir}}/PLAN.md 的设计段）。\n` +
    `直接改代码；每完成一个任务，在返回值里给出 status/改动文件/一行说明（**TASKS.json 的写者口径**：实现者只**回报** status，落地由 `/team task` 路由或派工账本写盘；真源 `lib/artifact-ownership.js` 的 `ARTIFACT_OWNERS`；**lead 无 `write`**）。\n` +
    `「此能力是否被真正调用并回流到前端」属你的自检项，未接线必须上报（不要等评审/QA 才暴露）。契约/枚举分歧写进 blockers。`,
    { label: "backend", phase: "implement", schema: { type: "object", properties: { tasks: { type: "array", items: { type: "object" } }, blockers: { type: "array", items: { type: "string" } } }, required: ["tasks"] } }
  ),
  () => agent(
    `【前端工程师】运行目录：{{run-dir}}。\n` +
    `只实现 TASKS.json 里 owner=frontend 的任务，以 PLAN.md 契约为准（读 {{run-dir}}/PLAN.md 的设计段）。\n` +
    `直接改代码；每完成一个任务，在返回值里给出 status/改动文件/一行说明（**TASKS.json 的写者口径**：实现者只**回报** status，落地由 `/team task` 路由或派工账本写盘；真源 `lib/artifact-ownership.js` 的 `ARTIFACT_OWNERS`；**lead 无 `write`**）。\n` +
    `「此能力是否被真正调用并回流」属你的自检项，未接线必须上报。契约/枚举分歧写进 blockers。`,
    { label: "frontend", phase: "implement", schema: { type: "object", properties: { tasks: { type: "array", items: { type: "object" } }, blockers: { type: "array", items: { type: "string" } } }, required: ["tasks"] } }
  ),
]);

phase("review");

const review = await agent(
  `【审查官】运行目录：{{run-dir}}。\n` +
  `对照 SPEC.md 验收标准与 PLAN.md 契约只读评审改动（用 read/grep 对抗性核真实性与交叉一致）。\n` +
  `产出 REVIEW.md 的完整内容（问题/严重级 P0-P2/位置+证据+最小改法/结论 pass|rework）。\n` +
  `★ 用 write 把 REVIEW.md 完整内容写到 {{run-dir}}/REVIEW.md；返回值只回 reviewPath、verdict（小），不要回 REVIEW 全文。\n` +
  `实现结果（taskId→status/changedFiles 小摘要）：${JSON.stringify((implementers || []).map((x) => (x && x.tasks) || []))}`,
  { label: "reviewer", phase: "review", schema: { type: "object", properties: { reviewPath: { type: "string" }, verdict: { type: "string", enum: ["pass", "rework"] } }, required: ["reviewPath", "verdict"] } }
);

phase("test");

const test = await agent(
  `【测试员】运行目录：{{run-dir}}。\n` +
  `跑构建/测试/lint（用 bash），并对关键路径做运行时 smoke（lint+静态+build 通过 ≠ 运行时通过）。\n` +
  `产出 TEST.md 的完整内容（命令/结果/覆盖/结论 pass|fail；运行时/外部依赖项如实标注「未实跑」）。\n` +
  `★ 用 write 把 TEST.md 完整内容写到 {{run-dir}}/TEST.md；返回值只回 testPath、verdict（小）。\n` +
  `评审结论：${JSON.stringify(review.verdict)}`,
  { label: "qa-test", phase: "test", schema: { type: "object", properties: { testPath: { type: "string" }, verdict: { type: "string", enum: ["pass", "fail"] } }, required: ["testPath", "verdict"] } }
);

phase("deliver");

// workflow 返回后，工件由产出角色自己落盘（见 SKILL.md §2）；此处只回路径 + 小字段：
//   如需聊天框可点击预览，lead 用 read 读回 {{run-dir}}/SPEC.md 等（read 在 lead 工具面内，
//   write 不在 ⇒ lead 不落盘）。TASKS.json 取 design.tasks（同样由产出角色 write 落盘）。
return {
  runDir: "{{run-dir}}",
  spec: { specPath: spec.specPath, planPath: spec.planPath, tasks: spec.tasks, openQuestions: spec.openQuestions },
  design: { planPath: design.planPath, tasks: design.tasks, risks: design.risks },
  implement: implementers,
  review: { reviewPath: review.reviewPath, verdict: review.verdict },
  test: { testPath: test.testPath, verdict: test.verdict },
};
