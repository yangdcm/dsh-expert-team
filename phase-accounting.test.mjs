// 测试：E2 的**记账前提** —— 「阶段事件漏记」必须可机判
//
// 为什么需要（**两次真实 run 的实测**）：SKILL §7.33 ① 要求"每个阶段流转都必须写 `phase:<阶段名>`，
// 尤其不能漏 review/test"，但 2026-09-13 那个真实 run **clarify 都走完了、一条 phase 事件都没有**，
// 于是 METRICS 的「收尾预算」只能显示"分不开"。**机制在、采纳度不在，而漏记本身没有任何地方会报** ——
// 本仓的判据是"写了没人执行、又没人发现，等于没有这条规则"，所以这一条把它变成 `/team check` 的违规。
//
// 判定刻意收窄（只报无歧义的两类），本测试同时钉住**不许误报**：
//   R1 冻结点缺失：已到 review/test/deliver、且**记过别的阶段**、但既无 review 也无 test；
//   R2 零记账：有角色事件、却一条 `phase:*` 都没有（此时**只报这一条**，R1 与它是同一根因）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M121**。
// 运行：node phase-accounting.test.mjs

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loggedPhases, phaseAccountingViolations } from './lib/validate.js';
import { PHASES } from './lib/vocab.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# E2 记账前提 · 阶段事件缺失可机判\n');

console.log('① `loggedPhases`：认规范写法、认兼容写法、不认词表外的伪阶段');
{
  const lines = [
    '- [22:21:03] run:started — 目标=x',
    '- [22:30:00] phase:research — research (researcher)',
    '- [23:00:00] phase:started — design (architect)',
    '- [23:10:00] phase:completed — 方案确认 (pm)',
    '- [23:20:00] phase:backend — 伪阶段（不在词表）',
    '- [23:30:00] role:pm — 进度',
    '- [23:40:00] phase:implement — 并行派工',
  ].join('\n');
  const seen = loggedPhases(lines);
  check(seen.has('research') && seen.has('design') && seen.has('implement'), '规范写法与兼容写法都被认出', [...seen].join(','));
  // 已知限制（LOGGING.md 已登记）：兼容写法「phase:completed — 方案确认 (pm)」取的是详情里第一个
  // ASCII 词 ⇒ 拿到 pm，不在词表内 ⇒ 整行跳过。**两套实现都这样**（断言 ② 逐行比对确认），
  // 所以这里钉住的是「限制被如实保留」，而不是假装它被认出来了。
  check(!seen.has('方案确认'), '兼容写法下的中文阶段名**解析不出**（已知限制，两套实现一致）', [...seen].join(','));
  check(loggedPhases('- [10:00:00] phase:方案确认 — 方案确认门').has('方案确认'), '规范写法 `phase:方案确认` 能被认出（绕开限制的正确写法）');
  check(!seen.has('backend') && !seen.has('started') && !seen.has('completed'), '词表外的伪阶段一律不计（`backend`/`started`/`completed` 都不在集合里）');
  check(loggedPhases('').size === 0 && loggedPhases(null).size === 0, '空/缺日志 ⇒ 空集合');
}

console.log('\n② 与聚合器**同一口径**（防两套解析悄悄分叉）');
{
  // 聚合器在 command.js 里用 `parseLogLine` + `PHASES` 判阶段。这里对同一批行做**逐行比对**：
  // 只要有哪一天一边改了规则、另一边没改，这条断言就会红。
  const { _live } = await import(join(here, 'lib', 'command.js'));
  const samples = [
    '- [10:00:00] phase:clarify — 澄清',
    '- [10:01:00] phase:started — design (architect)',
    '- [10:02:00] phase:completed — implement',
    '- [10:03:00] phase:made-up — x',
    '- [10:04:00] phase:方案确认 — 方案确认门',
    '- [10:05:00] role:pm — 不是阶段',
  ];
  const mine = loggedPhases(samples.join('\n'));
  const theirs = new Set();
  for (const line of samples) {
    const ev = _live.parseLogLine(line);
    if (!ev) continue;
    const idx = ev.type.indexOf(':');
    if (idx < 0 || ev.type.slice(0, idx) !== 'phase') continue;
    const head = ev.type.slice(idx + 1).split(':')[0];
    let name = head;
    if (!head || head === 'started' || head === 'completed') {
      const dm = String(ev.detail || '').match(/([A-Za-z][A-Za-z0-9_-]*)/);
      if (!dm) continue;
      name = dm[1];
    }
    if (PHASES.includes(name)) theirs.add(name);
  }
  check([...mine].sort().join(',') === [...theirs].sort().join(','), '两套实现逐行给出同一个阶段集合', `mine=${[...mine].join(',')} | aggregator=${[...theirs].join(',')}`);
}

console.log('\n③ R1/R2：报无歧义的，**不报**不该报的');
{
  const withRoles = '- [10:00:00] role:pm — 进度\n- [10:01:00] role:result — role=pm verdict=pass';
  check(phaseAccountingViolations(withRoles, 'deliver').length === 1, '**零记账 + 已到 deliver ⇒ 只报 1 条**（R1/R2 是同一根因，不重复报）', String(phaseAccountingViolations(withRoles, 'deliver').length));
  check(/零阶段记账/.test(phaseAccountingViolations(withRoles, 'deliver')[0]), '报的是更根本的那条（零记账）');
  // R2 **与阶段无关**：日志里已经有角色活动（活干过了）却零阶段记账 ⇒ 报；R1 才是只在 review/test/deliver 起效的那条。
  const atClarify = phaseAccountingViolations(withRoles, 'clarify');
  check(atClarify.length === 1 && /零阶段记账/.test(atClarify[0]), 'clarify 阶段：有角色活动却零记账 ⇒ 报 R2（与阶段无关）', String(atClarify.length));
  check(phaseAccountingViolations('- [10:00:00] run:started — 目标=x', 'clarify').length === 0, '只有 run:started ⇒ 不报（**刚起步不算漏记**，避免把门禁变噪声）');

  const partial = withRoles + '\n- [10:02:00] phase:clarify — 澄清\n- [10:03:00] phase:implement — 实现';
  const v1 = phaseAccountingViolations(partial, 'deliver');
  check(v1.length === 1 && /收尾预算/.test(v1[0]), '记过别的阶段、到 deliver 却无 review/test ⇒ 报 R1（收尾预算算不出来）', v1[0] ? v1[0].slice(0, 28) : '');
  check(phaseAccountingViolations(partial, 'implement').length === 0, '同一份日志在 implement 阶段不报（还没冻结）');
  const okLog = partial + '\n- [10:04:00] phase:review — 审查';
  check(phaseAccountingViolations(okLog, 'deliver').length === 0, '记了 `phase:review` ⇒ 不再报（不会误伤规范记账的 run）');
  const okTest = partial + '\n- [10:04:00] phase:test — 测试';
  check(phaseAccountingViolations(okTest, 'test').length === 0, '只有 `phase:test` 也够（E2 的口径就是"review **或** test"）');
  check(phaseAccountingViolations('', 'deliver').length === 0, '空日志 ⇒ 不判（`checkRun` 里"没有 RUN.log 文件"更不该报成"没记账"）');
}

console.log('\n④ 端到端：`/team check` 真的把它报出来');
{
  const root = await mkdtemp(join(tmpdir(), 'dsh-et-phase-'));
  process.env.DSH_HOME = join(root, 'fake-dsh');
  const cwd = join(root, 'proj');
  const run = 'r-phase';
  const dir = join(cwd, 'team', run);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'TASKS.json'), JSON.stringify({ rounds: { review: 0, test: 0, repair: 0 }, tasks: [{ id: 'T1', owner: 'backend', kind: 'workflow', status: 'completed', round: 1, verdict: 'pass', dependsOn: [], verify: ['true'] }] }, null, 2));
  await writeFile(join(dir, 'STATE.json'), JSON.stringify({ runId: run, phase: 'deliver', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts', members: [] }, null, 2));
  await writeFile(join(dir, 'ROSTER.json'), JSON.stringify({ runId: run, roles: ['backend'], members: {}, agents: {}, models: {} }, null, 2));
  await writeFile(join(dir, 'RUN.log.md'), [
    '# 运行日志（RUN.log）', '',
    '- [10:00:00] run:started — 目标=x',
    '- [10:01:00] role:pm — 进度',
    '- [10:02:00] phase:clarify — 澄清',
    '- [10:03:00] phase:implement — 实现',
    '',
  ].join('\n'));
  const { apply } = await import(join(here, 'lib', 'command.js'));
  let registered = null;
  apply({ commands: { register: (d) => { registered = d; } }, on: () => {}, get: () => undefined, inject: () => {} });
  const res = await registered.handler({ rawInput: `check ${run}`, attachments: [], agent: { session: { id: 's1', header: { cwd } }, followup: () => {} } });
  const text = String(res.text || '');
  check(/阶段记账/.test(text), '`/team check` 的输出里有「[阶段记账]」违规', (text.match(/\[阶段记账\][^\n]{0,60}/) || ['(未出现)'])[0]);
  check(/收尾预算/.test(text), '理由点明"收尾预算算不出来"（不是含糊的"日志不规范"）');
}

if (fail) { console.error(`\n✗ phase-accounting：${fail} 项失败`); process.exit(1); }
console.log('\n✓ phase-accounting：全部通过（口径一致 / 只报无歧义的 / 端到端可见）');
