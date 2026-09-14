// METRICS.md 的**纯渲染**（B 线 10b 的第一刀）。
//
// 为什么先切这一段：`aggregate()` 一个函数压了六件事（枚举 / 读取 / 解析 / 计算 / **渲染** / 写盘），
// 其中**渲染**是 C 线一直在动的地方（未闭环、返工性质分解、撤销率都往这里加节）—— 而它只需要
// 一个数据对象、零 IO ⇒ 切出去之后 METRICS 的格式可以**纯函数单测**，不用造 run 夹具。
//
// ⚠️ **提取的代价（必须由测试补偿）**：原来是闭包里的局部变量，写错名字会 `ReferenceError` 当场炸；
// 现在改成 `stats` 对象的字段，**写错名字静默变 `undefined`**、直接印进用户看的报告里。
// 所以配套的 `metrics-render.test.mjs` 有两道机器检查：
//   ① 渲染结果里**不得出现 `undefined` / `NaN`**；
//   ② 本模块解构出的每个字段名，调用点**必须**都传（源码级集合比对）。
// 这两条是这次提取的安全网，不是可选项。

/**
 * 渲染 `team/METRICS.md` 全文。
 * @param stats - 见下（字段名即契约；缺一个就会被上面的测试拦住）。
 * @returns markdown 全文（不含尾换行，与旧实现一致）。
 */
export function renderMetrics(stats) {
  const {
    iso, runCount, skipped, completed, runsWithLogs, reworkRate, reworkRuns,
    sourceLines, reworkNatureLines, phaseLines, firstRunnableLines, closingBudgetLines, roleLines, closureLines,
    errLines, askLines, decLines, scanLines, maxReviewRound, maxTestRound, revertLine, tokenLines,
  } = stats;
  return [
    '# 团队指标（METRICS）',
    '',
    `> 由 \`/team learn\` 自动聚合，最后更新：${iso}`,
    '',
    '## 总览',
    '',
    `- 总 run 数：${runCount}`,
    `- 非 run 条目（文件 / 无 STATE.json·TASK.md·RUN.log.md 的目录，未计入）：${skipped} 个`,
    `- 已完成：${completed}`,
    `- 有日志的 run：${runsWithLogs}`,
    `- 返工/失败率：${reworkRate}%（= ${reworkRuns}/${runsWithLogs}，分母是「有日志的 run」而非全部 run）`,
    `- 返工判定口径（多源，可审计）：${sourceLines}`,
    '  · 旧实现只统计 RUN.log 的 role:result 与 error 事件，而 LOGGING 约定从不写 role:result ⇒ 恒 0；',
    '    现改由 TASKS.json 的 repair 任务 / round>1 / verdict / rounds 与日志共同判定。',
    reworkNatureLines,
    '',
    '## 阶段覆盖',
    '',
    phaseLines,
    '',
    // E 线 E1（SKILL §7.32）：首产物必须**紧挨着阶段覆盖**渲染 —— 二者是同一个问题的两面
    //（"阶段都覆盖了"不等于"用户早就拿到能跑的东西"）。文案由 `timing.js` 生成（纯函数可单测）。
    '## 首产物（首个可运行产物耗时）',
    '',
    firstRunnableLines,
    '',
    // E 线 E2（SKILL §7.33）：收尾预算。与首产物同属"时间去哪了"这一族，放在阶段覆盖之后，
    // 让读者连着读：阶段都覆盖了 → 多久拿到能跑的东西 → 实现与收尾各花了多久。
    '## 收尾预算（实现期 = 首产物→冻结 · 收尾 = 冻结→交付）',
    '',
    closingBudgetLines,
    '',
    '## 角色结果（pass=交付 / rework=返工件 / fail=失败）',
    '',
    roleLines,
    '',
    '## 未闭环（不计入返工率，但必须可见）',
    '',
    closureLines,
    '',
    '## 高频卡点（error / 返工，去重）',
    '',
    errLines,
    '',
    '## 用户高频提问（ask，去重）',
    '',
    askLines,
    '',
    '## 决策记录（decision，去重）',
    '',
    decLines,
    '',
    // E 线 E3（SKILL §7.34）：单源化总扫。这条义务**没有代码能强制**（它要求 lead 在发现
    // 第一个副本时当轮做全仓总扫），所以唯一的抓手是"让它可见"——没人登记本身就是一种可见状态。
    '## 单源化总扫（见一个，扫全部）',
    '',
    scanLines,
    '',
    // P4（SPEC §1.5）：评审效率 —— 轮次到顶与"撤销幻觉"必须**可见**，否则噪声治理无从度量。
    // 无撤销登记时**整行如实说明**（`- （暂无撤销登记：…）`），**不得静默省略** ——
    // 沉默会被读成"没有撤销"，而事实可能只是"没人登记"。
    '## 评审效率（轮次 / 撤销率）',
    '',
    `- 评审轮次：review ${maxReviewRound} 轮 · test ${maxTestRound} 轮`,
    revertLine,
    '',
    // P5 线：token 成本与上下文峰值。放在**最后**是刻意的：它回答的是"这套流程总共花了多少资源"，
    // 属于"总量"视角，前面各节回答的是"质量与进度"。空态**必须如实写"没测到"**，
    // 否则会被读成"消耗很低"（本包在撤销率/首产物上反复吃过这个亏）。
    '## token 成本与上下文峰值',
    '',
    tokenLines,
    '',
  ].join('\n');
}
