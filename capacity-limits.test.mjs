// 测试：容量上限 fail-loud（O-3 · 竞品分析 P0 的最后一项）
//
// 原判断（`GAP-ANALYSIS.md` §5.1 D-5）：本包有 `quota`（runs/maxRuns/deadline）却**没有任何
// 成员/任务数量上限** ⇒ "无上限即无护栏"：一次编排脚本抽风可以派出 200 个成员、生成 5000 条任务，
// 而系统**不会说一个字**。官方有 `TEAM_MEMBER_LIMIT` / `TEAM_TASK_LIMIT` 且**显式报错**。
//
// 本仓的取向（与前几轮一致）：
//   · **fail loud，不静默截断** —— 超限返回显式错误码，而不是"悄悄丢掉多余的"；
//   · **写拦截 + 读可见**：plan/approve 落盘前拒；`/team check` 对**存量**超限只报告不阻断
//     （与 L1-4′ 同口径：旧 run 不得因新规而从视图里消失）；
//   · **上限可在 config 覆写**（`apply(ctx, config)` 的 `config.limits`），env 兜底。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M46 / M47。
// 运行：node capacity-limits.test.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { DEFAULT_LIMITS, LIMITS, resolveLimits, capacityViolations } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const many = (n) => new Array(n).fill(0).map((_, i) => ({ id: 'T-' + i }));

console.log('# 容量上限 fail-loud（O-3）\n');

console.log('① 默认上限存在且是有限正数（"有上限"本身是这项的一半）');
{
  check(Number.isFinite(DEFAULT_LIMITS.maxMembers) && DEFAULT_LIMITS.maxMembers > 0, 'maxMembers 是有限正数', String(DEFAULT_LIMITS.maxMembers));
  check(Number.isFinite(DEFAULT_LIMITS.maxTasks) && DEFAULT_LIMITS.maxTasks > 0, 'maxTasks 是有限正数', String(DEFAULT_LIMITS.maxTasks));
  const r = resolveLimits(null);
  check(r.maxMembers === DEFAULT_LIMITS.maxMembers && r.maxTasks === DEFAULT_LIMITS.maxTasks, '无 config / 无 env → 用默认', JSON.stringify(r));
}

console.log('\n② 优先级 config > env > 默认，且**无粘性**（幂等）');
{
  process.env.DSH_EXPERT_TEAM_MAX_TASKS = '7';
  check(resolveLimits(null).maxTasks === 7, 'env 生效', String(resolveLimits(null).maxTasks));
  check(resolveLimits({ limits: { maxTasks: 3 } }).maxTasks === 3, 'config 覆盖 env', String(resolveLimits({ limits: { maxTasks: 3 } }).maxTasks));
  delete process.env.DSH_EXPERT_TEAM_MAX_TASKS;
  const back = resolveLimits(null);
  check(back.maxTasks === DEFAULT_LIMITS.maxTasks, '移除 config/env 后回到默认（不会残留上一次的值）', String(back.maxTasks));
  check(LIMITS.maxTasks === DEFAULT_LIMITS.maxTasks, '模块级 LIMITS 同步复位');
}

console.log('\n③ 非法上限值 → 回到默认（而不是变成 NaN 让检查形同失效）');
{
  for (const bad of [-1, 'abc', null, undefined, NaN, {}, [], '', true, false]) {
    const r = resolveLimits({ limits: { maxMembers: bad, maxTasks: bad } });
    check(r.maxMembers === DEFAULT_LIMITS.maxMembers && r.maxTasks === DEFAULT_LIMITS.maxTasks, `maxMembers=${JSON.stringify(bad)} → 默认`, JSON.stringify(r));
  }
  check(resolveLimits({ limits: { maxTasks: 0 } }).maxTasks === 0, '0 是合法上限（显式禁止任何任务）', '0');
  check(resolveLimits({ limits: { maxTasks: 3.9 } }).maxTasks === 3, '小数向下取整', '3');
}

console.log('\n④ 超限判定：**只超一个才算**，边界必须安全（== 上限不报）');
{
  const lim = { maxMembers: 5, maxTasks: 10 };
  check(capacityViolations({ roles: many(5).map((_, i) => 'r' + i), tasks: many(10) }, lim).length === 0, '恰好等于上限 → 合规（边界安全）', '');
  const over1 = capacityViolations({ roles: many(6).map((_, i) => 'r' + i), tasks: many(10) }, lim);
  check(over1.length === 1 && over1[0].code === 'TEAM_MEMBER_LIMIT', '超 1 个成员 → TEAM_MEMBER_LIMIT', JSON.stringify(over1.map((c) => c.code)));
  check(over1[0].actual === 6 && over1[0].limit === 5, '报出实际值与上限（用户能照单决策）', JSON.stringify({ a: over1[0].actual, l: over1[0].limit }));
  const over2 = capacityViolations({ roles: many(6).map((_, i) => 'r' + i), tasks: many(11) }, lim);
  check(over2.length === 2, '同时超两项 → 两条', JSON.stringify(over2.map((c) => c.code)));
  check(/未落盘/.test(over2[0].message) && /调高上限/.test(over2[0].message), '消息说明"未落盘"并给出解法', over2[0].message.slice(0, 50));
}

console.log('\n⑤ 只给一半输入也照常工作：roles 或 tasks 缺省时只管另一半');
{
  const lim = { maxMembers: 5, maxTasks: 10 };
  check(capacityViolations({ tasks: many(11) }, lim).length === 1, '只给 tasks → 只判任务', '');
  check(capacityViolations({ roles: many(6).map((_, i) => 'r' + i) }, lim).length === 1, '只给 roles → 只判成员', '');
  check(capacityViolations({}, lim).length === 0, '都没有 → 不报（不臆造）', '');
  for (const bad of [null, undefined, 'x', 42, [], { roles: 'x', tasks: 'y' }]) {
    let ok = true, msg = '';
    try { ok = Array.isArray(capacityViolations(bad, lim)) } catch (e) { ok = false; msg = String(e && e.message) }
    check(ok, `畸形输入 ${JSON.stringify(bad)} → 数组（在渲染/写入路径上不得抛）`, msg);
  }
}

console.log('\n⑥ 接线检查：写拦截（plan + approve）与读可见（check）都接上了');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const hits = (codeLines.match(/capacityViolations\(/g) || []).length;
  check(hits >= 3, `capacityViolations 至少 3 处调用（plan / approve / check），实际 ${hits}`, String(hits));
  // 写拦截：必须**在落盘之前** return
  const planAt = codeLines.indexOf('const capErr = capacityViolations({ roles: draft.roles, tasks: draft.tasks });');
  check(planAt > 0, 'plan 路由调用', '');
  const planBlock = planAt > 0 ? codeLines.slice(planAt, planAt + 300) : '';
  check(/json\(400/.test(planBlock) && /return;/.test(planBlock), 'plan 超限 → 400 并 return（不落盘）', '');
  const approveAt = codeLines.indexOf('const capErr = capacityViolations({ roles: draft.roles, tasks: mergedTasks });');
  check(approveAt > 0, 'approve 路由调用（按**合并后**的任务表判，防"存量+新草稿"绕过）', '');
  // apply 必须读 config（"可在 config 覆写"是验收项）。
  // 2026-09-13（F 线设置控制台）：调用点多了"设置值作为最低优先级来源"这一参数 ⇒ 断言**重钉到新的
  // 完整文本**（不是放宽），并顺带钉住"设置确实被喂进去了"（否则设置页改了却不生效，没人发现）。
  check(/export function apply\(ctx, config\)/.test(codeLines) && /resolveLimits\(config, limitsBaseFromSettings\(\)\)/.test(codeLines), 'apply(ctx, config) 里解析上限（并把设置控制台的值作为最低优先级来源）', '');
  // 读侧只报告不阻断
  check(/const capHere = capacityViolations\(/.test(codeLines), '/team check 读侧可见（存量 run）', '');
}

console.log('\n⑦ 真实 run 不得被误报（默认值必须容得下实际规模）');
{
  const roots = (process.env.EXPERT_TEAM_RUN_ROOTS || join(process.cwd(), 'team')).split(':').filter(Boolean);
  let seen = 0, flagged = 0;
  resolveLimits(null);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const n of readdirSync(root)) {
      const d = join(root, n);
      let tasks = null, roles = null;
      try { const t = JSON.parse(readFileSync(join(d, 'TASKS.json'), 'utf8')); tasks = Array.isArray(t) ? t : (t.tasks || []) } catch { continue }
      try { roles = JSON.parse(readFileSync(join(d, 'ROSTER.json'), 'utf8')).roles } catch { /* optional */ }
      seen += 1;
      const v = capacityViolations({ roles, tasks });
      if (v.length) { flagged += 1; console.log(`      ✗ 误报：${n} ${JSON.stringify(v.map((c) => c.code))}`) }
    }
  }
  if (seen === 0) {
    console.log('      · 跳过：未发现可扫描的真实 run（把 EXPERT_TEAM_RUN_ROOTS 指向你的 run 目录即可启用本探针）');
  } else {
    check(flagged === 0, `真实 run 零误报（${flagged}/${seen}）—— 默认值容得下实际规模`);
  }
}

console.log('');
if (fail > 0) {
  console.log(`✗ 容量上限测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 容量上限测试通过（有上限、可覆写、超限显式报错、边界安全、真实 run 零误报）');
