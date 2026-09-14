// 测试：METRICS 返工口径必须反映真实证据（批 2-6 · N-2）
//
// 背景（纯信任问题）：`/team learn` 生成的 METRICS.md 曾报「返工/失败率：0%」
// 与「角色结果：日志里暂无角色结果」，而同一时刻 RETRO.md 记着 review/test/repair 各 3 轮。
// 根因：`aggregate` 的返工判定**只看** RUN.log 的 `role:result` 事件与 `error` 事件，
// 而 LOGGING 约定**从不写** role:result ⇒ 恒 0、角色结果恒空。
// 用户同时看到两个互相矛盾的数字后，会把**所有**面板信号一起降权（含真违规红条）。
//
// 本测试造出**真实存在的返工证据**（repair 任务 / round>1 / needs_revision / failed 任务），
// 断言 METRICS：
//   ① 返工率**不再**是 0%
//   ② 明确声明口径来源（可审计），且点出命中的证据类型
//   ③ 角色结果由任务结果反推（不再恒空）
//   ④ 无返工证据的 run → 返工率 0%（不误报）
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M9。
// 运行：node metrics.test.mjs

import { mkdtemp, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-et-metrics-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply, _live } = await import(join(here, 'lib', 'command.js'));
let registered = null;
// T-02（SPEC §2.1 用例 6）：/state 路由也要能被测到 —— 注入一个假的 webServer 把
// handler 抓出来。既有的 `inject: () => {}` 什么都不注册，接线类缺陷（runLogTail /
// liveFiles 是死代码）在本文件里就永远测不到。
let stateHandler = null;
apply({
  commands: { register: (d) => { registered = d; } },
  on: () => {},
  get: () => undefined,
  inject: (deps, f) => {
    if (String(deps) !== 'webServer') return;
    // `effect` 必须**立即执行**回调，否则路由根本不会 register（regression.test.mjs 同款桩）。
    f({
      effect: (fn) => { fn(); },
      webServer: { register: (c) => { if (String(c.path).endsWith('/state')) stateHandler = c.handler; return () => {}; } },
    });
  },
});
const cmd = (rawInput) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-metrics-1', header: { cwd } }, followup: () => {} },
});
const runsIn = async () => (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const readMetrics = () => readFile(join(cwd, 'team', 'METRICS.md'), 'utf8');

console.log('# METRICS 返工口径（N-2）\n');

// ① 造一个**干净**的 run（无返工证据）
await cmd('干净目标');
const clean = (await runsIn())[0];
await writeFile(join(cwd, 'team', clean, 'TASKS.json'), JSON.stringify({
  tasks: [{ id: 'T-01', owner: 'backend', kind: 'work', status: 'completed', round: 1, verdict: 'pass', dependsOn: [] }],
}, null, 2));
await cmd('learn');
let m = await readMetrics();
check(/返工\/失败率：0%/.test(m), '无返工证据 → 0%（不误报）', (m.match(/返工\/失败率：[^\n]*/) || [''])[0]);

// ② 造第二个 run，带**真实返工证据**
await cmd('带返工的目标');
const runs2 = await runsIn();
const dirty = runs2.find((x) => x !== clean);
check(!!dirty, '已建立第二个 run', String(dirty));
await writeFile(join(cwd, 'team', dirty, 'TASKS.json'), JSON.stringify({
  tasks: [
    { id: 'T-01', owner: 'backend', kind: 'work', status: 'completed', round: 1, verdict: 'pass', dependsOn: [] },
    { id: 'repair-1', owner: 'backend', kind: 'repair', status: 'completed', round: 2, verdict: 'pass', dependsOn: ['T-01'] },
    { id: 'T-02', owner: 'reviewer', kind: 'requirements', status: 'failed', round: 1, verdict: 'needs_revision', dependsOn: [] },
  ],
}, null, 2));
await cmd('learn');
m = await readMetrics();

console.log('\n① 返工率必须反映真实证据');
check(!/返工\/失败率：0%/.test(m), '返工率**不再**是 0%', (m.match(/返工\/失败率：[^\n]*/) || [''])[0]);

console.log('\n② 口径必须可审计（声明命中了哪些证据来源）');
check(/返工判定口径/.test(m), '输出包含「返工判定口径」行');
check(/tasks:repair/.test(m), '声明命中 `tasks:repair`', (m.match(/返工判定口径[^\n]*/) || [''])[0]);
check(/tasks:round>1|round>1/.test(m), '声明命中 `tasks:round>1`');
check(/tasks:verdict\|status/.test(m), '声明命中 `tasks:verdict|status`');
check(/role:result/.test(m), '说明旧口径为何恒 0（role:result 无人写入）');

console.log('\n③ 角色结果由任务结果反推（不再恒空）');
check(!/日志里暂无角色结果/.test(m), '角色结果栏非空');
check(/backend/.test(m), '列出 backend（其 repair 任务被计为返工）');
check(/reviewer/.test(m), '列出 reviewer（其 failed 任务被计为失败）');

console.log('\n④ 返工率是"有日志 run 中命中返工证据的比例"，不是把证据条数当比例');
const rate = Number((m.match(/返工\/失败率：(\d+)%/) || [])[1]);
check(rate === 50, '2 个 run 中 1 个有返工证据 → 50%', `实际 ${rate}%`);

// ══════════════════════════════════════════════════════════════════════════
// 以下为 T-02 追加用例（SPEC §2.1 六组 + §5 契约更正 C1）。
// 只**追加**：上面 ①-④ 的既有断言与其正则形态（`返工/失败率：NN%`）一字未改。
// ══════════════════════════════════════════════════════════════════════════
const teamDir = join(cwd, 'team');
const readLearnings = (c = cwd) => readFile(join(c, 'team', 'LEARNINGS.md'), 'utf8');
const cmdIn = (rawInput, c = cwd) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-metrics-2', header: { cwd: c } }, followup: () => {} },
});
const dirsIn = async (c = cwd) => {
  // 新工作区在第一个 run 建好之前还没有 team/ 目录 —— 快照阶段必须容错，不能抛。
  try {
    return (await readdir(join(c, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
};
/** 新开一个 run 并返回其 runId（用前后差集，不靠时间戳排序猜）。 */
const newRun = async (goal, c = cwd) => {
  const before = new Set(await dirsIn(c));
  await cmdIn(goal, c);
  return (await dirsIn(c)).find((x) => !before.has(x));
};
const runCount = (text) => Number((text.match(/- 总 run 数：(\d+)/) || [])[1]);

// ── ⑤ D1/D2/D3：事件族归一 —— `error:<子类>` / `decision:<来源>` / `role:<角色>` 必须被统计 ──
console.log('\n⑤ 事件族归一（D1/D2/D3）：error:<子类> / decision:<来源> / role:<角色> 被统计');
const famRun = await newRun('事件族目标');
await writeFile(join(teamDir, famRun, 'RUN.log.md'), [
  '# 运行日志（RUN.log）',
  '',
  '- [10:00:00] run:started — 目标=事件族',
  '- [10:00:00] error:workflow — 扇出失败：schema 未定义',
  '- [10:00:01] error:external-write — command.js 2490→2570 行',
  '- [10:00:02] decision:user — 交付=分析报告+升级路线图',
  '- [10:00:03] role:pm — PLAN.md R2 完成',
  '',
].join('\n'));
await writeFile(join(teamDir, famRun, 'TASKS.json'), JSON.stringify({ tasks: [] }, null, 2));
await cmdIn('learn');
m = await readMetrics();
check(/`error:workflow` × 1/.test(m), 'METRICS 出现 `error:workflow` 且带 × 1', (m.match(/- `error:workflow`[^\n]*/) || ['(未出现)'])[0]);
check(/`error:external-write` × 1/.test(m), 'METRICS 出现 `error:external-write`', (m.match(/- `error:external-write`[^\n]*/) || ['(未出现)'])[0]);
check(/`decision:user` × 1/.test(m), 'METRICS 出现 `decision:user`', (m.match(/- `decision:user`[^\n]*/) || ['(未出现)'])[0]);
check(/扇出失败：schema 未定义/.test(m), '子类行带首条 detail 样例');
check(!/无 error 事件/.test(m), '不再报「无 error 事件」（D1）');
check(!/无决策记录/.test(m), '不再报「无决策记录」（D2）');

// ── ⑥ D4：总 run 数只认真 run 目录（文件不得被当成 run） ──
console.log('\n⑥ 总 run 数只认真 run 目录（D4）');
const runsBefore = runCount(m);
check(runsBefore === 3, '当前真 run 数 = 3（干净 / 带返工 / 事件族）', `实际 ${runsBefore}`);
await writeFile(join(teamDir, 'REPOWIKI.md'), '# 仓库维基（REPOWIKI）\n\n- 这不是 run\n');
await writeFile(join(teamDir, 'LEARNINGS.md'), await readLearnings());
await writeFile(join(teamDir, 'CODEINDEX.json'), '{}\n');
await cmdIn('learn');
m = await readMetrics();
check(runCount(m) === runsBefore, '写入 REPOWIKI.md / LEARNINGS.md / CODEINDEX.json 后总 run 数不增加', `${runsBefore} → ${runCount(m)}`);
check(/- 非 run 条目/.test(m), '总览显式说明被跳过的非 run 条目（分母可审计）', (m.match(/- 非 run 条目[^\n]*/) || ['(未出现)'])[0]);

// ── ⑦ D5：`completed && round>1` 必须同时 +1 pass 与 +1 rework（双计口径） ──
console.log('\n⑦ 角色双计口径（D5）：completed + round>1 → pass 与 rework 同时 +1');
const dcRun = await newRun('双计目标');
await writeFile(join(teamDir, dcRun, 'TASKS.json'), JSON.stringify({
  tasks: [{ id: 'T-01', owner: 'dba', kind: 'work', status: 'completed', round: 2, verdict: 'pass', dependsOn: [] }],
}, null, 2));
await cmdIn('learn');
m = await readMetrics();
const dbaRow = m.match(/^- dba: pass (\d+) \/ rework (\d+) \/ fail (\d+)$/m) || [];
check(dbaRow.length === 4, 'dba 行存在且可解析', dbaRow[0] || '(未找到 dba 行)');
check(Number(dbaRow[1]) > 0 && Number(dbaRow[2]) > 0, '同一行 pass>0 且 rework>0（不是二选一）', dbaRow[0]);
const failRow = m.match(/^- reviewer: pass (\d+) \/ rework (\d+) \/ fail (\d+)$/m) || [];
check(failRow.length === 4 && Number(failRow[3]) > 0 && Number(failRow[2]) === 0, 'failed 只计 fail，不重复计 rework', failRow[0]);

// ── ⑧ D5 噪声：无集中度时不得点名角色 ──
console.log('\n⑧ 蒸馏阈值（D5）：每角色各 1 件返工、无集中度 → 不得点名');
const noiseRun = await newRun('噪声目标');
await writeFile(join(teamDir, noiseRun, 'TASKS.json'), JSON.stringify({
  tasks: [
    { id: 'n1', owner: 'ui', kind: 'repair', status: 'completed', round: 1, verdict: 'pass', dependsOn: [] },
    { id: 'n2', owner: 'sec', kind: 'repair', status: 'completed', round: 1, verdict: 'pass', dependsOn: [] },
    { id: 'n3', owner: 'devops', kind: 'repair', status: 'completed', round: 1, verdict: 'pass', dependsOn: [] },
  ],
}, null, 2));
await cmdIn('learn');
const l2 = await readLearnings();
check(!/返工\/失败最多/.test(l2), 'LEARNINGS 不出现「返工/失败最多」（噪声已消灭）', (l2.match(/\[Expert Skill\][^\n]*/) || ['(无 Expert Skill 行)'])[0]);
check(/分散，无单一责任角色/.test(l2), 'LEARNINGS 出现「分散，无单一责任角色」', (l2.match(/\[Team Skill\] \d+ 个角色[^\n]*/) || ['(未出现)'])[0]);

// ── ⑨ D6：同日蒸馏块幂等（替换，不追加） ──
console.log('\n⑨ 同日蒸馏块幂等（D6）：内容变化后连续 learn 仍只留 1 个当日块');
await cmdIn('learn');
const l3a = await readLearnings();
// 关键：让蒸馏内容**真的发生变化**（新增一条 error 事件）。否则「总是追加」的退化实现
// 会因为块内容与磁盘上完全相同而被 `existing.includes(block)` 挡住 ⇒ 变异体抓不住（假绿）。
await appendFile(join(teamDir, famRun, 'RUN.log.md'), '- [10:09:00] error:workflow — 又一次扇出失败（内容变化）\n');
await cmdIn('learn');
await cmdIn('learn');
const l3 = await readLearnings();
check(l3 !== l3a, '蒸馏内容确实变了（本组不是空转）');
const today = new Date().toISOString().slice(0, 10);
const dayHeads = (l3.match(new RegExp(`^## ${today} 自动蒸馏（/team learn）$`, 'gm')) || []).length;
check(dayHeads === 1, `## ${today} 自动蒸馏（/team learn）恰好出现 1 次`, `实际 ${dayHeads} 次`);
check((l3.match(/自动蒸馏（\/team learn）/g) || []).length === 1, '全文只有 1 个自动蒸馏块（没有跨次堆叠）');
check(/error:workflow ×2/.test(l3), '当日块被**替换**成最新内容（计数 1→2，而不是并存两块）', (l3.match(/\[Team Skill\] 高频卡点[^\n]*/) || [''])[0]);

// ── ⑩ C1：只有 ask + decision、无 error 的 run 不得被计为返工（返工率不虚高） ──
console.log('\n⑩ 契约更正 C1：提问/拍板不计入返工证据（只有 error 计入）');
const cwd2 = join(root, 'proj-c1');
await mkdir(cwd2, { recursive: true });
const c1Run = await newRun('只有提问与拍板的目标', cwd2);
await writeFile(join(cwd2, 'team', c1Run, 'RUN.log.md'), [
  '# 运行日志（RUN.log）',
  '',
  '- [10:00:00] run:started — 目标=只有提问与拍板',
  '- [10:00:01] ask:clarify — 交付口径是 code+artifacts 吗？',
  '- [10:00:02] decision:user — 交付=分析报告+升级路线图',
  '',
].join('\n'));
await writeFile(join(cwd2, 'team', c1Run, 'TASKS.json'), JSON.stringify({
  tasks: [{ id: 'T-01', owner: 'pm', kind: 'work', status: 'completed', round: 1, verdict: 'pass', dependsOn: [] }],
}, null, 2));
await cmdIn('learn', cwd2);
const m2 = await readFile(join(cwd2, 'team', 'METRICS.md'), 'utf8');
check(/- 有日志的 run：1/.test(m2), '该 run 确有可解析日志（否则 0% 是空分母的假通过）', (m2.match(/- 有日志的 run：[^\n]*/) || [''])[0]);
check(/返工\/失败率：0%/.test(m2), '只有 ask+decision、无 error ⇒ 返工/失败率 0%', (m2.match(/返工\/失败率：[^\n]*/) || [''])[0]);
check(/`ask:clarify` × 1/.test(m2), 'ask 仍被收集并渲染（决策/提问两节照常）');
check(/`decision:user` × 1/.test(m2), 'decision 仍被收集并渲染');
check(!/log:error/.test(m2), '返工口径里不出现 log:error 来源', (m2.match(/返工判定口径[^\n]*/) || [''])[0]);
// 反向对照：同一工作区再加一个**只有 error** 的 run ⇒ 必须变成 50%（证明 error 仍计入）
const errRun = await newRun('只有卡点的目标', cwd2);
await writeFile(join(cwd2, 'team', errRun, 'RUN.log.md'), [
  '# 运行日志（RUN.log）',
  '',
  '- [10:00:00] run:started — 目标=只有卡点',
  '- [10:00:01] error:workflow — 扇出失败：schema 未定义',
  '',
].join('\n'));
await writeFile(join(cwd2, 'team', errRun, 'TASKS.json'), JSON.stringify({ tasks: [] }, null, 2));
await cmdIn('learn', cwd2);
const m3 = await readFile(join(cwd2, 'team', 'METRICS.md'), 'utf8');
check(/返工\/失败率：50%/.test(m3), '对照：加入只有 error 的 run ⇒ 50%（error 仍算证据）', (m3.match(/返工\/失败率：[^\n]*/) || [''])[0]);
check(/log:error/.test(m3), '此时口径里出现 log:error 来源', (m3.match(/返工判定口径[^\n]*/) || [''])[0]);

// ── ⑪ D7 接线：/state 的 logTail 与 files 必须是**内容**，不是空壳 ──
console.log('\n⑪ 接线（D7）：/state 的 logTail 含标记串、files 含在办任务的 changedPaths');
check(typeof stateHandler === 'function', '/state 路由已注册（inject 生效）');
const wireRun = await newRun('接线目标', cwd2);
const wireDir = join(cwd2, 'team', wireRun);
// ⚠️ fixture 必须在**首次**调用 /state 之前写好：liveFiles 有模块级 5s TTL 缓存，
// 先调一次会把空结果缓存住，后面的内容断言就会假失败。
await writeFile(join(wireDir, 'RUN.log.md'), [
  '# 运行日志（RUN.log）',
  '',
  '- [11:00:00] SELF-LEARN-LOG-MARKER — 接线标记串',
  '',
  '<!-- 编排者：按 references/LOGGING.md 追加事件 -->',
  '',
].join('\n'));
await writeFile(join(wireDir, 'TASKS.json'), JSON.stringify({
  tasks: [
    { id: 'T-01', owner: 'backend', kind: 'work', status: 'in_progress', round: 1, verdict: null, dependsOn: [], changedPaths: ['packages/dsh-expert-team/lib/command.js'] },
    { id: 'T-02', owner: 'qa', kind: 'test', status: 'completed', round: 1, verdict: 'pass', dependsOn: ['T-01'], changedPaths: ['should-not-appear.js'] },
  ],
}, null, 2));
const callState = (u) => new Promise((resolve, reject) => {
  stateHandler({ method: 'GET', url: u }, { writeHead() {}, end: (b) => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } } });
});
const st = await callState('/plugins/dsh-expert-team/state?workspace=' + encodeURIComponent(cwd2) + '&run=' + encodeURIComponent(wireRun));
check(typeof st.logTail === 'string' && st.logTail.includes('SELF-LEARN-LOG-MARKER'), 'logTail 非空且含写入的标记串（不再是死代码）', JSON.stringify(st.logTail));
check(!/<!--/.test(String(st.logTail)), 'logTail 去掉尾部 HTML 注释行');
check(Array.isArray(st.files) && st.files.includes('packages/dsh-expert-team/lib/command.js'), 'files 含 in_progress 任务的 changedPaths', JSON.stringify(st.files));
check(!st.files.includes('should-not-appear.js'), 'files 只取在办任务（completed 的不算）');

// ══════════════════════════════════════════════════════════════════════════
// repair-1 追加用例（REPAIR-1.md v2 · R1–R11）。
// 每组用**独立工作区**：METRICS 是跨 run 聚合的，混在一个工作区里计数会互相干扰。
// ══════════════════════════════════════════════════════════════════════════
const mkWs = async (name) => { const c = join(root, name); await mkdir(c, { recursive: true }); return c; };
const writeLog = (ws, runId, lines) => writeFile(join(ws, 'team', runId, 'RUN.log.md'), ['# 运行日志（RUN.log）', '', ...lines, ''].join('\n'));
const writeTasks = (ws, runId, tasks) => writeFile(join(ws, 'team', runId, 'TASKS.json'), JSON.stringify({ tasks }, null, 2));
const readM = (ws) => readFile(join(ws, 'team', 'METRICS.md'), 'utf8');
/** 取角色行的四个捕获组：[整行, pass, rework, fail, 行尾标注] */
const row = (text, role) => text.match(new RegExp(`^- ${role}: pass (\\d+) / rework (\\d+) / fail (\\d+)(.*)$`, 'm')) || [];

// ── ⑫ R2：`verdict=` 一旦出现**只认 token**（禁止回落 prose）+ R5：来源名 `log:role` ──
console.log('\n⑫ R2 verdict token 优先（T-04 SG-1 最小复现）+ R5 来源名 log:role');
const wsR2 = await mkWs('proj-r2');
// A：verdict=pass，但 detail 里带「返工」字样 ⇒ 必须判 pass，且不得把本 run 记成返工
const r2a = await newRun('R2 甲', wsR2);
await writeLog(wsR2, r2a, ['- [10:00:00] run:started — 目标=R2 甲', '- [10:00:01] role:reviewer — verdict=pass（返工 3 处已修）']);
await writeTasks(wsR2, r2a, []);
await cmdIn('learn', wsR2);
let mr = await readM(wsR2);
let rw = row(mr, 'reviewer');
check(rw.length >= 4 && Number(rw[1]) === 1 && Number(rw[2]) === 0, 'verdict=pass（detail 含「返工」）⇒ 判 pass、**不**判 rework', rw[0] || '(无 reviewer 行)');
check(/（仅日志）/.test(rw[4] || ''), '无任务的角色行末尾标注（仅日志）', rw[0]);
check(/返工\/失败率：0%/.test(mr), 'pass 判决不置 runRework ⇒ 0%', (mr.match(/返工\/失败率：[^\n]*/) || [''])[0]);
check(/（无返工证据）/.test(mr), '口径为「（无返工证据）」');
// B：SG-1 最小复现 + 不得整条丢弃 + 无法识别的 token 不计判决
const r2b = await newRun('R2 乙', wsR2);
await writeLog(wsR2, r2b, [
  '- [10:00:00] run:started — 目标=R2 乙',
  '- [10:00:01] role:reviewer — 评审：**verdict=needs_revision**；11 项严格通过 10，不通过 2',
  '- [10:00:02] role:rew — verdict=needs_revision',
  '- [10:00:03] role:x — verdict=foo',
]);
await writeTasks(wsR2, r2b, []);
await cmdIn('learn', wsR2);
mr = await readM(wsR2);
rw = row(mr, 'reviewer');
check(rw.length >= 4 && Number(rw[2]) === 1, 'SG-1：verdict=needs_revision + detail 含「通过」⇒ rework（不被 prose 提升成 pass）', rw[0]);
check(Number(rw[1]) === 1, 'pass 未被虚增（仍只有 A 的那 1 次）', rw[0]);
const rew = row(mr, 'rew');
check(rew.length >= 4 && Number(rew[2]) === 1, 'role:rew verdict=needs_revision（无「通过」字样）⇒ rework 1，未被丢弃', rew[0] || '(无 rew 行)');
check(!/^- x: pass/m.test(mr), 'verdict=foo（无法识别）⇒ 不计判决、不记 pass');
check(/log:role/.test(mr), 'R5：role:<角色> 的判决记来源名 log:role', (mr.match(/返工判定口径[^\n]*/) || [''])[0]);
check(!/log:error\|role:result/.test(mr), 'R5：日志里没有 role:result 事件 ⇒ 不得冒充该来源');

// ── ⑬ R1：role tick 必须**真渲染**（空 TASKS.json 时不得报「暂无角色结果」）──
console.log('\n⑬ R1 role tick 真渲染（仅日志参与行）');
const wsR1 = await mkWs('proj-r1');
const r1r = await newRun('R1 甲', wsR1);
await writeLog(wsR1, r1r, [
  '- [10:00:00] run:started — 目标=R1',
  '- [10:00:01] role:pm — PLAN.md R1 完成',
  '- [10:00:02] role:pm — PLAN.md R2 完成',
  '- [10:00:03] role:pm — PLAN.md R3 完成',
  '- [10:00:04] role:pm — PLAN.md R4 完成',
  '- [10:00:05] role:researcher — 存量代码定位完成',
  '- [10:00:06] role:researcher — 依赖梳理完成',
]);
await writeTasks(wsR1, r1r, []);
await cmdIn('learn', wsR1);
const m1 = await readM(wsR1);
check(!/日志里暂无角色结果/.test(m1), '有 role tick 时**不得**打印「日志里暂无角色结果」');
check(/仅日志参与/.test(m1), '渲染「仅日志参与」行', (m1.match(/- （仅日志参与[^\n]*/) || ['(未出现)'])[0]);
check(/pm×4/.test(m1) && /researcher×2/.test(m1), '逐字形态：`- （仅日志参与：pm×4、researcher×2）`', (m1.match(/- （仅日志参与[^\n]*/) || [''])[0]);
check(m1.indexOf('pm×4') < m1.indexOf('researcher×2'), '按 tick 降序、`、` 分隔');

// ── ⑭ R9：跨源去重 —— TASKS.json 是唯一权威 ──
console.log('\n⑭ R9 跨源去重（同一次返工不得被任务与日志各计一次）');
const wsR9 = await mkWs('proj-r9');
const r9r = await newRun('R9 甲', wsR9);
await writeLog(wsR9, r9r, ['- [10:00:00] run:started — 目标=R9', '- [10:00:01] role:reviewer — verdict=needs_revision（同一次返工）']);
await writeTasks(wsR9, r9r, [{ id: 'repair-1', owner: 'reviewer', kind: 'repair', status: 'completed', round: 2, verdict: 'pass', dependsOn: [] }]);
await cmdIn('learn', wsR9);
const m9 = await readM(wsR9);
const rv9 = row(m9, 'reviewer');
check(rv9.length >= 4 && Number(rv9[2]) === 1, 'rework = 1（**不翻倍**成 2）', rv9[0] || '(无 reviewer 行)');
check(Number(rv9[1]) === 1, 'pass = 1（任务派生的那一次）', rv9[0]);
check(!/（仅日志）/.test(rv9[4] || ''), '有任务的角色行**不**标（仅日志）', rv9[0]);

// ── ⑮ R7：阶段名归一（不产生 started/completed 伪阶段）──
console.log('\n⑮ R7 阶段名归一');
const wsR7 = await mkWs('proj-r7');
const r7r = await newRun('R7 甲', wsR7);
await writeLog(wsR7, r7r, [
  '- [10:00:00] run:started — 目标=R7',
  '- [10:00:01] phase:started — design (architect)',
  '- [10:00:02] phase:implement — 并行派工 backend+frontend',
  '- [10:00:03] phase:completed — implement 完成',
  '- [10:00:04] phase:research:started — 调研存量代码',
]);
await writeTasks(wsR7, r7r, []);
await cmdIn('learn', wsR7);
const m7 = await readM(wsR7);
const phaseSec = m7.slice(m7.indexOf('## 阶段覆盖'), m7.indexOf('## 角色结果'));
check(/`design`: 1 次/.test(phaseSec), 'phase:started — design (architect) ⇒ 记 design', phaseSec.trim().replace(/\n/g, ' | '));
check(/`implement`: 2 次/.test(phaseSec), 'phase:implement + phase:completed — implement ⇒ 合计 2 次');
check(/`research`: 1 次/.test(phaseSec), 'phase:research:started ⇒ 记 research');
check(!/`started`/.test(phaseSec) && !/`completed`/.test(phaseSec), '不产生 started / completed 伪阶段');

// ── ⑯ R8：同日块**始终**替换（本次无新经验也不留旧块）──
console.log('\n⑯ R8 同日块始终替换（无新经验时清掉旧噪声）');
const wsR8 = await mkWs('proj-r8');
const r8r = await newRun('R8 甲', wsR8);
await writeLog(wsR8, r8r, ['- [10:00:00] run:started — 目标=R8', '- [10:00:01] error:workflow — 扇出失败：schema 未定义']);
await writeTasks(wsR8, r8r, []);
await cmdIn('learn', wsR8);
const l8a = await readLearnings(wsR8);
check(/高频卡点/.test(l8a), '前置：第一次 learn 写下了高频卡点');
await writeLog(wsR8, r8r, ['- [10:00:00] run:started — 目标=R8']); // 去掉 error ⇒ 本次蒸馏为空
await cmdIn('learn', wsR8);
const l8b = await readLearnings(wsR8);
check(/本日无新增经验/.test(l8b), '本次无新经验 ⇒ 替换为「（本日无新增经验）」', (l8b.match(/- （本日无新增经验）/) || ['(未出现)'])[0]);
check(!/高频卡点/.test(l8b), '旧块被清掉（不会被下次 clarify 当「既往经验」注入）');
check((l8b.match(/自动蒸馏（\/team learn）/g) || []).length === 1, '仍只有 1 个当日块（没有整文件重写）');

// ── ⑰ R10：样例按**码点**截断（消除 U+FFFD）──
console.log('\n⑰ R10 样例按码点截断');
const wsR10 = await mkWs('proj-r10');
const r10r = await newRun('R10 甲', wsR10);
await writeLog(wsR10, r10r, [
  '- [10:00:00] run:started — 目标=R10',
  '- [10:00:01] error:emoji-edge — ' + 'x'.repeat(119) + '🙂',
  '- [10:00:02] error:emoji-over — ' + 'x'.repeat(130) + '🙂',
]);
await writeTasks(wsR10, r10r, []);
await cmdIn('learn', wsR10);
const m10 = await readM(wsR10);
check(!m10.includes('\uFFFD'), 'METRICS 全文不含 U+FFFD（代理对未被切断）');
check(/🙂/.test(m10), '恰在 120 码点边界的 emoji 完整保留');
const overSample = (m10.match(/- `error:emoji-over` × 1 — ([^\n]*)/) || [])[1] || '';
check([...overSample].length <= 120 && !overSample.includes('\uFFFD'), '超长样例按码点截到 ≤120 且无乱码', `实际 ${[...overSample].length} 码点`);

// ── ⑱ R11：角色名归一（role:pm(repair) 不得成为幽灵桶）──
console.log('\n⑱ R11 角色名归一');
const wsR11 = await mkWs('proj-r11');
const r11r = await newRun('R11 甲', wsR11);
await writeLog(wsR11, r11r, [
  '- [10:00:00] run:started — 目标=R11',
  '- [10:00:01] role:pm(repair) — verdict=rework 修复派工',
  '- [10:00:02] role:pm — verdict=rework 又一次修复',
  '- [10:00:03] role:frontend-F4 — 前端第 4 号在跑',
]);
await writeTasks(wsR11, r11r, []);
await cmdIn('learn', wsR11);
const m11 = await readM(wsR11);
check(!/pm\(repair\)/.test(m11), 'METRICS 里不存在 `pm(repair)` 幽灵桶');
const pm11 = row(m11, 'pm');
check(pm11.length >= 4 && Number(pm11[2]) === 2, 'role:pm(repair) 与 role:pm 归一到同一桶 ⇒ rework 2', pm11[0] || '(无 pm 行)');
check(/frontend-F4×1/.test(m11), '合法后缀 frontend-F4 保留（没被归一掉）', (m11.match(/- （仅日志参与[^\n]*/) || [''])[0]);

// ── ⑲ R3：/team detail 的「首个失败点」按事件族判定 ──
console.log('\n⑲ R3 /team detail 首个失败点按事件族');
const wsR3 = await mkWs('proj-r3');
const r3r = await newRun('R3 甲', wsR3);
await writeLog(wsR3, r3r, ['- [10:00:00] run:started — 目标=R3', '- [10:00:01] error:external-write — command.js 2490→2570 行越界写入']);
await writeTasks(wsR3, r3r, []);
const d3 = await cmdIn('detail ' + r3r, wsR3);
check(d3.kind === 'success', '/team detail 返回成功', String(d3.kind));
check(!/（无 error 事件）/.test(d3.text), 'detail 不再报「（无 error 事件）」');
check(/首个失败点：\[10:00:01\] command\.js 2490→2570 行越界写入/.test(d3.text), '首个失败点取自 error:<子类> 事件', (d3.text.match(/- 首个失败点：[^\n]*/) || [''])[0]);

// ── ⑳ R4：runLogTail 截断与**中间**注释 ──
console.log('\n⑳ R4 runLogTail 截断 / 中间注释 / 异常路径');
const { runLogTail } = _live;
const wsR4 = await mkWs('proj-r4');
const r4r = await newRun('R4 甲', wsR4);
const r4dir = join(wsR4, 'team', r4r);
const long = [];
for (let i = 1; i <= 60; i += 1) long.push(`- [10:${String(i % 60).padStart(2, '0')}:00] role:qa — 第 ${i} 行 ` + 'y'.repeat(80));
long.push('- [11:00:00] role:qa — LAST-LINE-MARKER', '', '<!-- 尾部编排者说明 -->', '');
await writeFile(join(r4dir, 'RUN.log.md'), long.join('\n'));
const t1 = await runLogTail(r4dir);
check(t1.length <= 4000, '>4000 字的日志 ⇒ 返回 ≤4000 字', `${t1.length} 字`);
check(t1.split('\n').length <= 40, '>40 行的日志 ⇒ 返回 ≤40 行', `${t1.split('\n').length} 行`);
check(t1.includes('LAST-LINE-MARKER'), '含最后一行（最新在尾，从尾部截断）');
check(!t1.includes('<!--'), '不含 HTML 注释');
await writeFile(join(r4dir, 'RUN.log.md'), [
  '- [10:00:00] role:pm — 第一条',
  '<!-- 中间夹一段编排者注释 -->',
  '- [10:00:01] role:backend — MID-COMMENT-CASE',
  '',
].join('\n'));
const t2 = await runLogTail(r4dir);
check(!t2.includes('<!--'), '注释在**中间**时也被剥掉');
check(t2.includes('MID-COMMENT-CASE'), '注释之后的尾部事件仍在');
check(await runLogTail(join(wsR4, 'team', '不存在的-run')) === '', '目录不存在 ⇒ 返回 \'\'（不抛）');

// ══════════════════════════════════════════════════════════════════════════
// repair-2 追加用例（见 team/自我学习优化-度量聚合与断链修复-233308/REPAIR-2.md 的 R14/R15/R16/R18/R19）。
// 同样每组独立工作区，避免跨 run 聚合互相污染。
// ══════════════════════════════════════════════════════════════════════════

// ── ㉑ R14：阶段名必须落在既有 PHASES 白名单内（不得产生任意英文词的伪阶段）──
console.log('\n㉑ R14 阶段名白名单（PHASES 之外的词一律不记）');
const wsR14 = await mkWs('proj-r14');
const r14 = await newRun('R14 甲', wsR14);
await writeLog(wsR14, r14, [
  '- [10:00:00] run:started — 目标=R14',
  '- [10:00:01] phase:started — 由 backend 开始实现',
  '- [10:00:02] phase:started — design (architect)',
  '- [10:00:03] phase:implement — 并行派工 backend+frontend',
  '- [10:00:04] phase:made-up-phase — 自造阶段名',
]);
await writeTasks(wsR14, r14, []);
await cmdIn('learn', wsR14);
const m14 = await readM(wsR14);
const ph14 = m14.slice(m14.indexOf('## 阶段覆盖'), m14.indexOf('## 角色结果'));
check(!/`backend`/.test(ph14), 'R14：`phase:started — 由 backend 开始实现` **不得**记成伪阶段 backend', ph14.trim().replace(/\n/g, ' | '));
check(!/`started`/.test(ph14), 'R14：也不得记成 started');
check(/`design`: 1 次/.test(ph14), 'R14：`phase:started — design (architect)` 仍记 design');
check(/`implement`: 1 次/.test(ph14), 'R14：`phase:implement` 照常记');
check(!/`made-up-phase`/.test(ph14), 'R14：词表外的自造阶段名被跳过');

// ── ㉒ R15：taskRoles 必须按 run 局部（A run 有任务不得吞掉 B run 的日志判决与 ticks）──
// ⚠️ 本组**依赖 run 的处理顺序**：`aggregate` 是 `names.sort()` 后顺序扫描的，只有「有任务的 A」
// 排在「只有日志的 B」**之前**，全局 taskRoles 的缺陷才会显形（否则 B 先跑、集合还是空的，
// 变异体 M72 就抓不住 —— 第一次写这组时正是用 `R15 甲`/`R15 乙` 命名，乙(U+4E59) 排在甲(U+7532)
// 前面，导致 M72 假绿）。故用 ASCII 前缀 A/B 定序，并在下面**显式断言这个前置条件**。
console.log('\n㉒ R15 taskRoles 按 run 局部（不得工作区全局）');
const wsR15 = await mkWs('proj-r15');
const r15a = await newRun('R15-A-you-renwu', wsR15);
await writeLog(wsR15, r15a, ['- [10:00:00] run:started — 目标=R15-A 有任务']);
await writeTasks(wsR15, r15a, [
  { id: 'T-01', owner: 'backend', kind: 'work', status: 'completed', round: 1, verdict: 'pass', dependsOn: [] },
  { id: 'T-02', owner: 'frontend', kind: 'work', status: 'pending', round: 1, verdict: null, dependsOn: [] },
]);
const r15b = await newRun('R15-B-zhi-you-rizhi', wsR15);
check(r15a < r15b, '前置：有任务的 A run 必须排在只有日志的 B run 之前（aggregate 按 names.sort() 扫描；顺序反了本组就测不到 R15）', `${r15a} vs ${r15b}`);
await writeLog(wsR15, r15b, [
  '- [10:00:00] run:started — 目标=R15-B 只有日志',
  '- [10:00:01] role:backend — verdict=rework 契约不一致',
  '- [10:00:02] role:frontend — 在跑（本条无判决，只有 tick）',
]);
await writeTasks(wsR15, r15b, []);
await cmdIn('learn', wsR15);
const m15 = await readM(wsR15);
const be15 = row(m15, 'backend');
check(be15.length >= 4 && Number(be15[1]) === 1 && Number(be15[2]) === 1, 'A 有 backend 任务，B 的 `role:backend — verdict=rework` **仍被计入** ⇒ pass 1 / rework 1', be15[0] || '(无 backend 行)');
check(!/（仅日志）/.test(be15[4] || ''), 'backend 有任务级权威行 ⇒ 不标（仅日志）', be15[0]);
check(/仅日志参与：frontend×1/.test(m15), 'B 的 frontend tick 仍进「仅日志参与」（frontend 只在 A 有 pending 任务、在 B 无任务）', (m15.match(/- （仅日志参与[^\n]*/) || ['(未出现)'])[0]);

// ── ㉓ R16：log:error 独立登记，与 log:role 可并存 ──
console.log('\n㉓ R16 log:error 独立登记（与 log:role 并存，口径可审计）');
const wsR16 = await mkWs('proj-r16');
const r16 = await newRun('R16 甲', wsR16);
await writeLog(wsR16, r16, [
  '- [10:00:00] run:started — 目标=R16',
  '- [10:00:01] error:workflow — 扇出失败：schema 未定义',
  '- [10:00:02] role:beta — verdict=rework 契约不一致',
]);
await writeTasks(wsR16, r16, []);
await cmdIn('learn', wsR16);
const m16 = await readM(wsR16);
const src16 = (m16.match(/返工判定口径[^\n]*/) || [''])[0];
check(/log:error×1/.test(src16), 'R16：口径行含 `log:error`（真实 php/school run 有 7 条 error 却曾完全不出现）', src16);
check(/log:role×1/.test(src16), 'R16：与 `log:role` **并存**（不再互斥）', src16);
check(/返工\/失败率：100%/.test(m16), 'R16 不改分子口径：error 仍算返工证据（C1 裁定）⇒ 100%', (m16.match(/返工\/失败率：[^\n]*/) || [''])[0]);

// ── ㉔ R18：verdict token 的包裹字符必须剥掉（真实 php/school RUN.log 第 163 行的写法）──
console.log('\n㉔ R18 剥掉 token 包裹字符（反引号/全角引号/markdown 粗体）');
const wsR18 = await mkWs('proj-r18');
const r18 = await newRun('R18 甲', wsR18);
await writeLog(wsR18, r18, [
  '- [10:00:00] run:started — 目标=R18',
  '- [10:00:01] role:reviewer — **verdict=`needs_revision`**；11 项评审重点严格通过 10',
  '- [10:00:02] role:qa — verdict=「needs_revision」',
  '- [10:00:03] role:pm — verdict=`pass`',
]);
await writeTasks(wsR18, r18, []);
await cmdIn('learn', wsR18);
const m18 = await readM(wsR18);
const rv18 = row(m18, 'reviewer');
check(rv18.length >= 4 && Number(rv18[2]) === 1 && Number(rv18[1]) === 0, 'R18①：反引号+粗体包裹的 needs_revision ⇒ rework（真实第 163 行写法，不得被静默丢弃）', rv18[0] || '(无 reviewer 行)');
const qa18 = row(m18, 'qa');
check(qa18.length >= 4 && Number(qa18[2]) === 1, 'R18②：全角「」包裹 ⇒ rework', qa18[0] || '(无 qa 行)');
const pm18 = row(m18, 'pm');
check(pm18.length >= 4 && Number(pm18[1]) === 1, 'R18③：`verdict=`pass`` ⇒ pass', pm18[0] || '(无 pm 行)');
check(!/返工\/失败率：0%/.test(m18), 'R18④：被包裹的负向判决是唯一返工证据时，返工率**不得**虚低为 0%', (m18.match(/返工\/失败率：[^\n]*/) || [''])[0]);
check(!/（无返工证据）/.test(m18), 'R18④：口径行也不得是「（无返工证据）」', (m18.match(/返工判定口径[^\n]*/) || [''])[0]);

// ── ㉕ R19：token 词表补 conditionally-pass / conditional / conditionally → pass ──
console.log('\n㉕ R19 token 词表补全（conditionally-pass 等 → pass）');
const wsR19 = await mkWs('proj-r19');
const r19 = await newRun('R19 甲', wsR19);
await writeLog(wsR19, r19, [
  '- [10:00:00] run:started — 目标=R19',
  '- [10:00:01] role:result — role=reviewer verdict=conditionally-pass（P0 全关）',
  '- [10:00:02] role:qa — verdict=conditional',
  '- [10:00:03] role:pm — verdict=conditionally',
]);
await writeTasks(wsR19, r19, []);
await cmdIn('learn', wsR19);
const m19 = await readM(wsR19);
const rv19 = row(m19, 'reviewer');
check(rv19.length >= 4 && Number(rv19[1]) === 1 && Number(rv19[2]) === 0, 'R19：`role:result — verdict=conditionally-pass` ⇒ 记 **pass**（不是"不计判决"）', rv19[0] || '(无 reviewer 行)');
const qa19 = row(m19, 'qa');
check(qa19.length >= 4 && Number(qa19[1]) === 1, 'R19：conditional ⇒ pass', qa19[0] || '(无 qa 行)');
const pm19 = row(m19, 'pm');
check(pm19.length >= 4 && Number(pm19[1]) === 1, 'R19：conditionally ⇒ pass', pm19[0] || '(无 pm 行)');
check(/返工\/失败率：0%/.test(m19), 'R19：全是 pass ⇒ 返工率 0%（conditionally-pass 不得被当成返工）', (m19.match(/返工\/失败率：[^\n]*/) || [''])[0]);

console.log('');
if (fail > 0) {
  console.log(`✗ METRICS 口径测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ METRICS 口径测试通过（返工率反映真实证据、口径可审计、角色结果非空、干净 run 不误报）');
console.log('✔ 追加用例通过（事件族归一 / 真 run 计数 / 双计口径 / 蒸馏阈值 / 同日幂等 / C1 提问不虚高 / 面板接线）');
console.log('✔ repair-1 用例通过（R1 tick 渲染 / R2 token 优先 / R3 detail 同族 / R4 logTail / R5 log:role / R7 阶段归一 / R8 始终替换 / R9 跨源去重 / R10 码点 / R11 角色名归一）');
console.log('✔ repair-2 用例通过（R14 阶段白名单 / R15 taskRoles 按 run / R16 log:error 独立 / R18 剥包裹字符 / R19 token 词表补全）');
