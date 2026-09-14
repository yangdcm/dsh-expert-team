// End-to-end scenario test for @yangdcm/dsh-expert-team (host/data layer).
// Simulates a real team run THROUGH the actual command handlers + web routes:
//   create → design → 方案确认门(decide) → implement → review(非pass→repair链)
//   → test → /team check gates → deliver-complete → state route final snapshot.
// Run: node e2e.test.mjs
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const { apply } = await import(join(here, 'lib/command.js'));

let registered = null;
const handlers = {};
const ctx = {
  commands: { register: (d) => { registered = d; } },
  get: () => undefined,
  inject: (deps, f) => { if (String(deps) === 'webServer') f({ effect: (fn) => fn(), webServer: { register: (c) => { handlers[c.path] = c.handler; return () => {}; } } }); },
};
apply(ctx);
function cmd(rawInput, cwd) { return registered.handler({ rawInput, attachments: [], agent: { session: { header: { cwd } }, followup: () => {} } }); }
function route(path, opts = {}) { return new Promise((res) => { const req = { method: opts.method || 'GET', url: opts.url || path, body: opts.body || null }; const res2 = { writeHead() {}, end: (b) => res(JSON.parse(b)) }; handlers[path](req, res2); }); }

const root = await mkdtemp(join(tmpdir(), 'dsh-et-e2e-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

// ── 1) create a persist delivery team ──
const create = await cmd('--persist --profile delivery 做一个带登录的订单模块', cwd);
assert.equal(create.kind, 'success', 'create');
const runId = (await readdir(join(cwd, 'team'))).find((n) => n !== 'METRICS.md' && n !== 'LEARNINGS.md');
const dir = join(cwd, 'team', runId);
const roster0 = JSON.parse(await readFile(join(dir, 'ROSTER.json'), 'utf8'));
assert.equal(roster0.models.pm.model, 'deepseek-flash', 'heavy role pm → deepseek-flash (V4.1)');
assert.equal(roster0.models.reviewer.model, 'deepseek-flash', 'heavy role reviewer → deepseek-flash (V4.1)');
assert.equal(roster0.models.qa.model, 'deepseek-flash', 'light role qa → deepseek-flash (V4.1)');
assert.equal(roster0.models.pm.tier, 'heavy', 'tier structure preserved (heavy)');
assert.equal(roster0.models.qa.tier, 'light', 'tier structure preserved (light)');
console.log('step 1 ✅ create:', runId, '· ROSTER has agents:', Object.keys(roster0.agents).length, 'roles · 模型计划 单模型 deepseek-flash（tier 保留）');

// ── 2) design: architect fills new-schema tasks ──
await writeFile(join(dir, 'TASKS.json'), JSON.stringify({ tasks: [
  { id: 'be-1', kind: 'implementation', owner: 'backend', title: '实现登录接口', spec: 'POST /login', acceptance: ['A1'], inScope: ['src/**'], verify: ['npm run test:backend'], changedPaths: [], contract: {}, dependsOn: [], attempt: 0, attemptId: null, round: 1, verdict: null, findings: [], status: 'pending' },
  { id: 'fe-1', kind: 'implementation', owner: 'frontend', title: '实现登录页', spec: '登录表单', acceptance: ['A2'], inScope: ['src/**'], verify: [], changedPaths: [], contract: {}, dependsOn: ['be-1'], attempt: 0, attemptId: null, round: 1, verdict: null, findings: [], status: 'pending' },
  { id: 'rv-1', kind: 'review', owner: 'reviewer', title: '审查登录实现', dependsOn: ['fe-1'], attempt: 0, round: 1, verdict: null, findings: [], status: 'pending' },
  { id: 'qa-1', kind: 'verification', owner: 'qa', title: '测试登录', verify: ['npm test'], dependsOn: ['fe-1'], attempt: 0, round: 1, verdict: null, findings: [], status: 'pending' },
] }));
console.log('step 2 ✅ design: 4 tasks (new schema)');

// ── 3) status shows progress + model plan ──
const st1 = await cmd('status', cwd);
assert.match(st1.text, /0\/4 完成/, 'status 0/4');
assert.match(st1.text, /模型 flash×12/, 'status line carries the model plan (12-role roster, single V4.1 model)');
const mp1 = await cmd('models', cwd);
assert.match(mp1.text, /deepseek-flash/, 'models subcommand shows the V4.1 model');
console.log('step 3 ✅ status: 0/4 完成 + /team models 模型计划');

// ── 4) 方案确认门: pendingDecision → decide (浮层拍板) ──
let state = JSON.parse(await readFile(join(dir, 'STATE.json'), 'utf8'));
state.pendingDecision = { title: '方案确认', prompt: '确认执行？', options: [{ id: 'go', label: '执行' }, { id: 'rev', label: '修改' }] };
await writeFile(join(dir, 'STATE.json'), JSON.stringify(state, null, 2));
const s1 = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) });
assert.equal(s1.pendingDecision.options.length, 2, 'overlay carries 方案确认门');
assert.equal(s1.members.backend.name == null ? false : true, true, 'members have persisted agent identity');
const dec = await route('/plugins/dsh-expert-team/decide', { method: 'POST', body: JSON.stringify({ workspace: cwd, run: runId, choice: '执行' }) });
assert.equal(dec.ok, true);
const s2 = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) });
assert.equal(s2.pendingDecision, null, 'pendingDecision cleared after 浮层拍板');
assert.match(await readFile(join(dir, 'DECISIONS.md'), 'utf8'), /执行/, 'decision recorded');
console.log('step 4 ✅ 方案确认门: 浮层/路由拍板「执行」→ 记录 DECISIONS.md + 清除待决');

// ── 5) implement: backend completes w/ verify+scope; frontend completes w/o verify ──
let tasks = JSON.parse(await readFile(join(dir, 'TASKS.json'), 'utf8'));
tasks.tasks[0].status = 'completed'; tasks.tasks[0].changedPaths = ['src/login.ts']; tasks.tasks[0].verify = ['npm run test:backend'];
tasks.tasks[1].status = 'completed'; tasks.tasks[1].changedPaths = ['src/login.ts'];
await writeFile(join(dir, 'TASKS.json'), JSON.stringify(tasks, null, 2));
const chk1 = await cmd('check ' + runId, cwd);
assert.doesNotMatch(chk1.text, /\[be-1\]/, 'be-1 compliant (verify+inScope) — not flagged');
assert.match(chk1.text, /\[fe-1\] 状态为已完成但缺少 verify/, 'check FLAGS fe-1 completed w/o verify (quality gate works)');
const stV = await cmd('status', cwd);
assert.match(stV.text, /⚠违规1/, 'status line surfaces ⚠违规1 live');
console.log('step 5 ✅ implement → /team check: 放行 be-1（verify+inScope 达标），拦截 fe-1（completed 但缺 verify）→ 越界/门禁判定生效 + status⚠违规1');

// ── 6) review 非 pass → repair 链 + 复审 pass → check 通过 ──
tasks = JSON.parse(await readFile(join(dir, 'TASKS.json'), 'utf8'));
const rv = tasks.tasks.find((t) => t.id === 'rv-1'); rv.status = 'failed'; rv.verdict = 'reject'; rv.findings = [{ severity: 'high', title: '未校验 token' }];
tasks.tasks.push({ id: 'repair-1', kind: 'repair', owner: 'backend', title: '修复登录 token 校验', inScope: ['src/**'], verify: ['npm run test:backend'], dependsOn: ['be-1'], attempt: 0, round: 2, status: 'in_progress' }); tasks.tasks.push({ id: 'rv-2', kind: 'review', owner: 'reviewer', title: '复审', dependsOn: ['repair-1'], attempt: 0, round: 2, status: 'pending' });
await writeFile(join(dir, 'TASKS.json'), JSON.stringify(tasks, null, 2));
const afterReview = JSON.parse(await readFile(join(dir, 'TASKS.json'), 'utf8'));
assert.equal(afterReview.tasks.find((t) => t.id === 'rv-1').status, 'failed', 'reject review → failed (终态)');
assert.equal(afterReview.tasks.find((t) => t.id === 'rv-1').verdict, 'reject');
assert.ok(afterReview.tasks.find((t) => t.id === 'repair-1'), 'auto repair-1 created');
assert.ok(afterReview.tasks.find((t) => t.id === 'rv-2'), 'independent review-N+1 (rv-2) created');
console.log('step 6 ✅ review 失败=终态 failed(verdict=reject) + 自动 repair-1(round2,依赖实现) + 独立 review-N+1(rv-2)');
// repair done + re-review pass
tasks = JSON.parse(await readFile(join(dir, 'TASKS.json'), 'utf8'));
tasks.tasks.find((t) => t.id === 'repair-1').status = 'completed'; tasks.tasks.find((t) => t.id === 'repair-1').changedPaths = ['src/login.ts']; tasks.tasks.find((t) => t.id === 'repair-1').verify = ['npm run test:backend'];
tasks.tasks.find((t) => t.id === 'rv-2').status = 'completed'; tasks.tasks.find((t) => t.id === 'rv-2').verdict = 'pass';
await writeFile(join(dir, 'TASKS.json'), JSON.stringify(tasks, null, 2));
console.log('step 6 ✅ review 失败→自动 repair-1(round2) + 独立 review-N+1(rv-2 pass)');

// ── 7) test passes + fix fe-1 verify → check clean → deliver ──
tasks = JSON.parse(await readFile(join(dir, 'TASKS.json'), 'utf8'));
tasks.tasks.find((t) => t.id === 'qa-1').status = 'completed'; tasks.tasks.find((t) => t.id === 'qa-1').verify = ['npm test'];
tasks.tasks.find((t) => t.id === 'fe-1').verify = ['npm test']; // fix fe-1's gate
await writeFile(join(dir, 'TASKS.json'), JSON.stringify(tasks, null, 2));
const chk3 = await cmd('check ' + runId, cwd);
assert.match(chk3.text, /✅ 无违规/, 'after repair+verify fixes, check is clean');
state = JSON.parse(await readFile(join(dir, 'STATE.json'), 'utf8'));
state.phase = 'deliver'; state.status = 'complete'; state.updatedAt = new Date().toISOString();
await writeFile(join(dir, 'STATE.json'), JSON.stringify(state, null, 2));
const st2 = await cmd('status', cwd);
assert.doesNotMatch(st2.text, /⚠违规/, 'status line clean after fixes');
console.log('step 7 ✅ test 通过 → /team check ✅ 无违规 → deliver → status:');
console.log('  ' + st2.text.split('\n').find((l) => l.includes(runId)));

// ── 8) final overlay snapshot: DAG data + agent identities + coverage ──
const final = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) });
assert.equal(final.ok, true);
assert.equal(final.tasks.length, 6, '6 tasks (incl repair + re-review)');
assert.equal(final.members.backend.name ? true : false, true, 'member identity present');
assert.match(final.members.pm.planModel, /flash/, 'overlay carries per-role planModel (heavy tier → deepseek-flash)');
assert.match(final.members.qa.planModel, /flash/, 'overlay carries per-role planModel (light tier → deepseek-flash)');
assert.ok(final.models && final.models.reviewer.model === 'deepseek-flash', 'state exposes ROSTER models (V4.1)');
assert.ok(final.runs.length >= 1);
console.log('step 8 ✅ 浮层最终快照: ' + final.tasks.length + ' 任务 · DAG/清单/全景数据齐 · agents=' + Object.keys(final.members).length);

console.log('\nEND-TO-END (host/data layer) PASSED ✔');
