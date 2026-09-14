// Full regression harness for @yangdcm/dsh-expert-team's /team host (dsh plugin).
// Covers: create, status (progress), index, migrate, profile, canvas --watch,
// and the 5 web routes (state / artifact / decide) via a fake webServer ctx.
// Run: node regression.test.mjs   (workspace-only; touches no ~/.dsh state).
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const { apply, name, inject, _live } = await import(join(here, 'lib/command.js'));

// ── 1) export shape ──
assert.equal(name, 'expert-team-command');
assert.ok(inject.includes('commands'));
assert.equal(typeof _live.pushActivity, 'function', 'activity feed test hook exported');

// ── 1a) live-feed summaries must read as ACTIONS, not as argument dumps ──
// Regression for the activity capsule showing a raw compound shell line, with
// its quotes double-escaped to literal `&quot;` on screen.
assert.equal(
  _live.summarizeTool({ name: 'bash', arguments: { command: 'cat ~/.dsh/profiles/web/cordis.yml; echo "=== profiles dir ===";' } }),
  '已查看 ~/.dsh/profiles/web/cordis.yml（+1 条）',
  'compound shell line → primary action + how many more parts ran',
);
assert.equal(
  _live.summarizeTool({ name: 'bash', arguments: { command: 'cd /Users/x && pnpm run test:all > /tmp/x.log 2>&1; echo "exit=$?"; grep -n PASSED /tmp/x.log | head' } }),
  '已运行 pnpm run test:all（+4 条）',
  'noise (cd) skipped for the action; remaining parts counted',
);
assert.equal(_live.summarizeTool({ name: 'bash', arguments: { command: 'rg -n "kind" lib/command.js | head -20' } }), '已检索 kind（+1 条）', 'pipe counted as another part');
assert.equal(_live.summarizeTool({ name: 'bash', arguments: { command: 'sed -n "1,60p" ~/.dsh/settings.yaml' } }), '已改写文本 ~/.dsh/settings.yaml', 'sed reports the FILE, not the expression');
assert.equal(_live.summarizeTool({ name: 'bash', arguments: { command: 'ls -la' } }), '已列出目录', 'bare flags are not echoed');
assert.equal(_live.summarizeTool({ name: 'bash', arguments: { command: 'node -e "console.log(1)"' } }), '已运行 Node（内联脚本）', 'inline script named, body not dumped');
assert.equal(_live.summarizeTool({ name: 'bash', arguments: { command: 'bash -c "rg -n kind lib/"' } }), '已检索 kind', 'wrapper shell describes the inner command');
assert.equal(_live.summarizeTool({ name: 'bash', arguments: { command: 'set -e; cd /tmp; true' } }), '已运行命令（+2 条）', 'pure glue says so instead of naming glue');
assert.equal(_live.summarizeTool({ name: 'bash', arguments: { command: 'echo &quot;hi&quot; &amp; bye' } }), '已输出 hi & bye', 'entities decoded once');
assert.match(_live.summarizeTool({ name: 'subagent', arguments: { name: 'backend', title: '实现 Runner' } }), /^已派 实现 Runner$/, 'subagent shows the task, not the role id');
assert.equal(_live.summarizeTool({ name: 'job_output', arguments: { job_id: 'job-42' } }), '已收消息 job-42', 'job id summarised');
assert.match(_live.summarizeTool({ name: 'read', arguments: { file_path: '/a/'.repeat(60) + 'PIPELINE.md' } }), /….*\.md$/, 'long paths keep a readable tail (extension survives)');
assert.doesNotMatch(_live.summarizeTool({ name: 'bash', arguments: { command: 'echo "<&>"' } }), /&quot;|&amp;|&lt;/, 'no entity survives a summary');

// ── 1a3) tool labels are Chinese — never `已` glued to an English tool id ──
// Bug: `structured_output` (the in-process subagent driver's result tool) had no
// label, so the feed showed the half-Chinese `已structured_o` (the English id
// clipped to 12 chars). Every label must now be Chinese, including families
// (`subagent_*`, `mcp_connector_*`, `browser_*`, …) and unknown future tools.
assert.equal(_live.summarizeTool({ name: 'structured_output', arguments: {} }), '已提交结构化结果', 'structured_output has a real Chinese label');
const labelledTools = [
  'structured_output', 'interrupt_agent', 'dsh_im_return_file',
  'subagent_pm', 'subagent_architect', 'subagent_backend', 'subagent_frontend', 'subagent_researcher', 'subagent_reviewer', 'subagent_qa', 'subagent_ui', 'subagent_sec', 'subagent_dba', 'subagent_devops', 'subagent_docs', 'subagent_fork',
  'mcp_connector_status', 'mcp_connector_catalog', 'mcp_connector_tools_list', 'mcp_connector_health_check', 'mcp_connector_configure', 'mcp_connector_policy',
  'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_eval', 'browser_type', 'browser_wait',
  'hindsight_reflect', 'hindsight_sync_status', 'hindsight_diagnose', 'hindsight_ingest_document',
  'job_output', 'job_list', 'job_kill',
  'read', 'edit', 'write', 'grep', 'glob', 'web_search', 'web_fetch', 'read_image', 'skill', 'workflow', 'ralph', 'send_message', 'list_agents', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode', 'todo_write', 'ask_user_question',
  'some_future_tool', 'mcp_connector_brand_new', 'browser_brand_new',
];
for (const t of labelledTools) {
  const line = _live.summarizeTool({ name: t, arguments: { file_path: 'src/a.ts' } });
  assert.doesNotMatch(line, /已[A-Za-z]/, `tool "${t}" must not render half Chinese/English (got: ${line})`);
}
assert.equal(_live.summarizeTool({ name: 'some_future_tool', arguments: {} }), '已执行操作', 'an unknown tool falls back to Chinese, never to its id');
assert.equal(_live.summarizeTool({ name: 'mcp_connector_brand_new', arguments: {} }), '已操作连接器', 'unlisted family member still Chinese');

// ── 1a2) the client half must not double-escape text (React escapes it) ──
const clientSrcRaw = await readFile(new URL('./client.js', import.meta.url), 'utf8');
let clientModuleRaw = null;
const reactStubRaw = { useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), createElement: () => null, Fragment: null };
new Function('window', 'console', 'require', clientSrcRaw)(
  { __ModuleLoader__: { load: (m) => { clientModuleRaw = m; } } },
  { log: () => {} },
  (id) => (id === 'react' ? reactStubRaw : {}),
);
assert.ok(clientModuleRaw && typeof clientModuleRaw.factory === 'function', 'client module registers through __ModuleLoader__');
const clientExportsRaw = clientModuleRaw.factory((id) => (id === 'react' ? reactStubRaw : {}));
assert.equal(typeof clientExportsRaw.apply, 'function', 'client apply() exported');
assert.equal(clientExportsRaw._live.esc('a"b<c>&d\'e'), 'a"b<c>&d\'e', 'client esc() is identity: React escapes text children itself');
assert.doesNotMatch(clientSrcRaw.match(/function esc\(s\) \{[^}]*\}/)[0], /&quot;/, 'the escaping table is gone (its output rendered as literal entities)');
// The panel's kind labels must cover the host's vocabulary, or the Chinese UI
// leaks a raw English id (requirements / integration / quality were missing).
const mapKeys = (src, decl) => {
  const m = src.match(new RegExp('(?:const|var) ' + decl + ' *= *\\{([^}]*)\\}'));
  assert.ok(m, decl + ' found');
  return m[1].match(/[A-Za-z_][A-Za-z0-9_]*\s*:/g).map((s) => s.replace(/\s*:$/, ''));
};
// ⚠️ B 线 11b（2026-09-13）：host 侧的 `KIND_ZH` 已搬进 `lib/vocab.js`（唯一真源）。
// 断言的对象没变（两侧 kind 词表必须互相覆盖），变的是 host 那一份**住在哪**。
const hostKindKeys = mapKeys(await readFile(new URL('./lib/vocab.js', import.meta.url), 'utf8'), 'KIND_ZH');
const clientKindKeys = mapKeys(clientSrcRaw, 'KIND_ZH');
for (const k of hostKindKeys) assert.ok(clientKindKeys.includes(k), `client KIND_ZH covers host kind "${k}"`);
for (const k of ['requirements', 'integration', 'quality']) assert.ok(clientKindKeys.includes(k), `client labels kind "${k}" in Chinese`);

assert.equal(_live.roleOfSub({ label: 'PM重审业务逻辑' }), 'pm', 'label keyword fallback maps to pm');
assert.equal(_live.roleOfSub({ label: '调研AI审核现状' }), 'researcher', '自由 label「调研…现状」→ researcher');
assert.equal(_live.roleOfSub({ label: '澄清+起草 Ultra Spec' }), 'pm', '自由 label「澄清+起草 Ultra Spec」→ pm');
assert.equal(_live.roleOfSub({ label: '[backend] Runner 差异化退避' }), 'backend', '[role] prefixed label maps exactly');
const rm = _live.mapRoleToSub([{ id: 'a1', label: 'PM重审业务逻辑', activity: 'running' }, { id: 'b1', label: '[backend] Runner 退避' }]);
assert.equal(rm.get('pm').id, 'a1', 'role→sub map (pm)');
assert.equal(rm.get('backend').id, 'b1', 'role→sub map (backend)');
// multi-run isolation: STATE.members precise ids win over label guessing
const pm2 = _live.membersFromState(['f2ea92c6-b6e2-4658-9b32-4b67d82f4454:researcher', 'f448d026-f03f-4ad6-974d-e318254b9818:pm', 'pm:Mia', 'architect:Owen']);
assert.equal(pm2.byRole.get('researcher'), 'f2ea92c6-b6e2-4658-9b32-4b67d82f4454', 'STATE.members agentId:role parsed');
assert.equal(pm2.byRole.get('pm'), 'f448d026-f03f-4ad6-974d-e318254b9818', 'second agentId:role parsed');
assert.equal(pm2.names.get('pm'), 'Mia', 'legacy role:name parsed separately');
const pm3 = _live.membersFromState(['f2ea92c6-b6e2-4658-9b32-4b67d82f4454:researcher:done', '24838365-6197-48f7-85d5-a64e6b5b1be5:architect:done', 'c2d46716-05eb-49cb-b5c0-c40671132ace:frontend-F4:done', '026ca9c3-fe2d-4661-b53d-58d54ba5475e:reviewer-R1:done']);
assert.equal(pm3.byRole.get('researcher'), 'f2ea92c6-b6e2-4658-9b32-4b67d82f4454', 'THREE-field agentId:role:done parsed');
assert.equal(pm3.byRole.get('architect'), '24838365-6197-48f7-85d5-a64e6b5b1be5', 'three-field architect');
assert.equal(pm3.byRole.get('frontend'), 'c2d46716-05eb-49cb-b5c0-c40671132ace', 'suffixed role frontend-F4 normalized to frontend');
assert.equal(pm3.byRole.get('reviewer'), '026ca9c3-fe2d-4661-b53d-58d54ba5475e', 'suffixed role reviewer-R1 normalized to reviewer');
const bm = _live.buildRoleSubMap([{ id: 'f2ea92c6-b6e2-4658-9b32-4b67d82f4454', label: '调研AI审核现状', activity: 'running' }, { id: 'other', label: '[frontend] 页面' }], ['f2ea92c6-b6e2-4658-9b32-4b67d82f4454:researcher']);
assert.equal(bm.get('researcher').id, 'f2ea92c6-b6e2-4658-9b32-4b67d82f4454', 'precise STATE binding wins');
assert.equal(bm.has('frontend'), false, 'other run’s agent does NOT leak into this run (no label fallback when STATE.members present)');
assert.deepEqual(_live.parseLogLine('- [now] decision — 用户拍板'), { time: 'now', type: 'decision', detail: '用户拍板' }, 'tolerant [now] timestamps keep events');
assert.equal(_live.parseLogLine('- [21:00:00] phase:implement — 并行派工').type, 'phase:implement', 'phase:xxx events parsed');
assert.equal(_live.summarizeTool({ name: 'read', arguments: { file_path: 'src/a.ts' } }), '已查看 src/a.ts');
assert.match(_live.summarizeTool({ name: 'grep', arguments: { pattern: 'def rush' } }), /已检索 def rush/);
const abuf = new Map();
for (let i = 0; i < 35; i++) _live.pushActivity(abuf, 'a1', { ts: i, line: 'x', preview: '' });
assert.equal(abuf.get('a1').length, 30, 'activity buffer capped at 30');

// ── fake ctx that captures BOTH the /team command handler AND web routes ──
let registered = null;
const handlers = {};
const fakeSubs = [{ id: 'sub-a1', label: '调研AI审核现状', activity: 'running', mode: 'continuable', model: 'deepseek-chat' }, { id: 'sub-b1', label: '[backend] Runner 退避', activity: 'idle', mode: 'continuable' }];
// R13：`/state` 的**显示**路径现在也走 run 作用域过滤（`filterRunScopedSubs`），所以要让
// `members.backend.active === true` 这类断言继续成立，正确做法是**把 fixture 造成能正确归属**
// （wfLabels 带本 run 的 `runId`），而不是放宽断言。`wfEvents` 先留空、等 runId 定了再填
// （section 9 首次调 /state 之前）—— `workflowEventIndex` 有 3s 缓存，填晚了会读到空的那份。
const wfEvents = [];
const eventListeners = {};
const fakeCtx = {
  commands: { register: (d) => { registered = d; } },
  on: (ev, fn) => { (eventListeners[ev] = eventListeners[ev] || []).push(fn); },
  get: (k) => {
    if (k === 'subagents') return { listChildren: async () => fakeSubs };
    if (k === 'agents') return { list: () => [{ session: { header: { id: 'sub-x-1234567890abcdef' } }, status: 'running', options: { model: 'deepseek-pro-x' } }] };
    // 只给本 run 的归属会话（`cmd()` 用的 sess-reg-1）返回 workflow 扇出事件；
    // 其它 sid 返回空 —— 这正是真实场景：会话级 label 里混着别的 run 的孩子。
    if (k === 'sessionQuery') return { readSession: async (id) => ({ events: String(id) === 'sess-reg-1' ? wfEvents : [] }) };
    return undefined;
  },
  inject: (deps, f) => {
    if (String(deps) === 'webServer') f({ effect: (fn) => fn(), webServer: { register: (c) => { handlers[c.path] = c.handler; return () => {}; } } });
  },
};
apply(fakeCtx);
assert.ok(registered, 'team command registered');
assert.equal(registered.name, 'team');
assert.equal(typeof registered.handler, 'function');

// route helper
function route(path, opts = {}) {
  return new Promise((resolve) => {
    const req = { method: opts.method || 'GET', url: opts.url || path, body: opts.body || null };
    const res = { writeHead() {}, end: (b) => resolve(JSON.parse(b)) };
    handlers[path](req, res);
  });
}
let lastFollowup = '';
function cmd(rawInput, cwd) {
  return registered.handler({ rawInput, attachments: [], agent: { session: { id: 'sess-reg-1', header: { cwd } }, followup: (m) => { lastFollowup = m; } } });
}

// ── setup a workspace with a run ──
const root = await mkdtemp(join(tmpdir(), 'dsh-et-reg-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const create = await cmd('--persist --roles pm,architect,backend,frontend,reviewer,qa 做一个登录页', cwd);
assert.equal(create.kind, 'success', 'create: ' + JSON.stringify(create));
assert.match(lastFollowup.content[0].text, /项目知识库：缺失/, 'create without knowledge base prompts /team index');
assert.ok(lastFollowup.content[0].text.length < 900, 'launch message stays compact (anti-bloat): ' + lastFollowup.content[0].text.length + ' chars');
const team = join(cwd, 'team');
async function isRunDir(n) { try { await readFile(join(team, n, 'STATE.json'), 'utf8'); return true; } catch { return false; } }
const allRuns = (await readdir(team)).filter((n) => n !== 'METRICS.md' && n !== 'LEARNINGS.md');
const runIds = [];
for (const n of allRuns) { if (await isRunDir(n)) runIds.push(n); }
assert.equal(runIds.length, 1, 'one run scaffolded');
const runId = runIds[0];
const runDir = join(team, runId);

// ── 2) scaffold present (all templates) ──
for (const f of ['TASK.md', 'ROSTER.json', 'STATE.json', '任务看板.md', 'SPEC.md', 'PLAN.md', 'RESEARCH.md', 'TASKS.json', 'REVIEW.md', 'TEST.md', 'SUMMARY.md', 'RETRO.md', 'RUN.log.md']) {
  await readFile(join(runDir, f), 'utf8').catch(() => assert.fail('missing template ' + f));
}
assert.match(await readFile(join(runDir, 'RUN.log.md'), 'utf8'), /run:started/);

// ── 3) STATE has coverage[] (new schema) ──
const st0 = JSON.parse(await readFile(join(runDir, 'STATE.json'), 'utf8'));
assert.ok(Array.isArray(st0.coverage), 'STATE.coverage array');

// ── 4) /team --profile resolves roles + deliverable ──
const prof = await cmd('--profile review 评审 commit', cwd);
assert.equal(prof.kind, 'success');
const profRun = (await readdir(team)).find((n) => n !== runId && n !== 'METRICS.md' && n !== 'LEARNINGS.md');
const profTask = await readFile(join(team, profRun, 'TASK.md'), 'utf8');
assert.match(profTask, /profile：review/, 'profile stamped');
const profRoster = JSON.parse(await readFile(join(team, profRun, 'ROSTER.json'), 'utf8'));
assert.ok(profRoster.roles.includes('reviewer') && !profRoster.roles.includes('backend'), 'review profile roster');
assert.match(profTask, /artifacts-only/, 'review profile deliverable');

// ── 5) /team status shows progress ──
await writeFile(join(runDir, 'TASKS.json'), JSON.stringify({ tasks: [
  { id: 'f1', owner: 'frontend', title: '页面', status: 'done' },
  { id: 'b1', owner: 'backend', title: '接口', status: 'pending' },
  { id: 'b2', owner: 'backend', title: '接口2', status: 'failed' },
] }));
const status = await cmd('status', cwd);
assert.equal(status.kind, 'success');
assert.match(status.text, /1\/3 完成/, 'status progress done/total');
assert.match(status.text, /失败1/, 'status shows failures');

// ── 6) /team index -> REPOWIKI.md (project knowledge base, Repowiki) ──
await writeFile(join(cwd, 'README.md'), '# MyProj\n\nA thing.\n');
await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'myproj', scripts: { test: 'jest' } }));
await mkdir(join(cwd, 'docs'), { recursive: true });
await writeFile(join(cwd, 'docs', 'ARCHITECTURE.md'), '# Architecture\n\nmodules\n');
await mkdir(join(cwd, 'src', 'lib'), { recursive: true });
await writeFile(join(cwd, 'src', 'lib', 'a.ts'), 'export const a = 1;\n');
await mkdir(join(cwd, 'team'), { recursive: true });
await writeFile(join(cwd, 'team', 'LEARNINGS.md'), '- 坑：jest 需要 setupEnv\n');
const idx = await cmd('index', cwd);
assert.equal(idx.kind, 'success', idx.text);
const repo = await readFile(join(cwd, 'team', 'REPOWIKI.md'), 'utf8');
assert.match(repo, /MyProj/, 'REPOWIKI has README');
assert.match(repo, /## package\.json/, 'REPOWIKI has dependency manifest');
assert.match(repo, /## docs\/ARCHITECTURE\.md/, 'REPOWIKI has docs');
assert.match(repo, /## 项目经验（team\/LEARNINGS\.md/, 'REPOWIKI has project learnings');
assert.match(repo, /## 目录树（两层，跳过构建\/依赖目录）/, 'REPOWIKI has two-level dir tree');
assert.match(repo, /src\/\n  lib\//, 'REPOWIKI tree shows src/lib');
assert.match(idx.text, /项目知识库/, 'index reply names the knowledge base');
// create-time injection: launch message must mention the Repowiki knowledge base
const create2 = await cmd('--name kb-check 并再组一次', cwd);
assert.equal(create2.kind, 'success');
assert.match(lastFollowup.content[0].text, /项目知识库：已就绪/, 'launch message points at existing knowledge base');
assert.match(lastFollowup.content[0].text, /【首步】/, 'first-step dispatch line retained (compact)');

// ── 6c) /team devcontainer: language detect + dry-run + --write ──
const dc = await cmd('devcontainer', cwd);
assert.equal(dc.kind, 'success', dc.text);
assert.match(dc.text, /javascript-node:20/, 'devcontainer detects Node from package.json');
const dcW = await cmd('devcontainer --write', cwd);
assert.equal(dcW.kind, 'success', dcW.text);
const dcJson = JSON.parse(await readFile(join(cwd, '.devcontainer', 'devcontainer.json'), 'utf8'));
assert.equal(dcJson.image, 'mcr.microsoft.com/devcontainers/javascript-node:20', '--write places devcontainer.json at project root');
let dcSnap = null;
for (const n of await readdir(team)) {
  try { if ((await readFile(join(team, n, 'DEVCONTAINER.json'), 'utf8')).includes('javascript-node:20')) dcSnap = n; } catch { /* no snapshot in this run */ }
}
assert.ok(dcSnap, 'dry-run snapshotted DEVCONTAINER.json in a run dir (newest)');

// ── 6d) /team codeindex + /team search (Qoder-style code index) ──
await mkdir(join(cwd, 'src', 'api'), { recursive: true });
await writeFile(join(cwd, 'src', 'api', 'token.ts'), 'export function generateToken(userId: string) { return userId + ":" + crypto.randomUUID(); }\nexport class TokenService { issue() { return generateToken("u"); } }\n');
const ci = await cmd('codeindex', cwd);
assert.equal(ci.kind, 'success', ci.text);
assert.match(ci.text, /CODEINDEX\.json/, 'codeindex writes CODEINDEX.json');
const ciJson = JSON.parse(await readFile(join(cwd, 'team', 'CODEINDEX.json'), 'utf8'));
assert.ok(ciJson.files.length >= 2, 'index covers src files');
const sh = await cmd('search token', cwd);
assert.equal(sh.kind, 'success', sh.text);
assert.match(sh.text, /token\.ts:\d+\s+\[fn\] generateToken|token\.ts:\d+\s+\[class\] TokenService/, 'search hits symbol with file:line');
const ciRoute = await route('/plugins/dsh-expert-team/codeidx', { url: '/plugins/dsh-expert-team/codeidx?workspace=' + encodeURIComponent(cwd) + '&q=token' });
assert.equal(ciRoute.ok, true, 'codeidx route ok');
assert.ok(ciRoute.hits.length >= 1 && ciRoute.hits[0].file.includes('token.ts'), 'codeidx route returns ranked hits');

// ── 6e) self-optimization: tolerant log parsing feeds METRICS/LEARNINGS ──
await writeFile(join(runDir, 'RUN.log.md'), '- [21:00:00] phase:implement — 并行派工 backend(Ivy)+frontend(Alex)\n- [now] decision — 用户拍板执行\n');
const lrn = await cmd('learn', cwd);
assert.equal(lrn.kind, 'success', lrn.text);
const metrics = await readFile(join(cwd, 'team', 'METRICS.md'), 'utf8');
assert.match(metrics, /`implement`: 1 次/, 'phase:xxx form counted in METRICS');
assert.match(metrics, /用户拍板执行/, '[now] decision NOT dropped from METRICS');
assert.match(metrics, /有日志的 run：\d/, 'metrics overview present');

// ── 6b) /team check reports state-machine/quality-gate violations ──
await writeFile(join(runDir, 'TASKS.json'), JSON.stringify({ tasks: [
  { id: 'rv-1', kind: 'review', owner: 'reviewer', status: 'completed', verdict: 'reject', dependsOn: ['f1'] },
  { id: 'b1', kind: 'implementation', owner: 'backend', status: 'in_progress', dependsOn: ['rv-1'] },
] }));
// f1 (frontend, in_progress) is a dependency of rv-1; rv-1 completed w/o pass; b1 in_progress depends on completed-reject rv-1
const chk = await cmd('check ' + runId, cwd);
assert.equal(chk.kind, 'success');
assert.match(chk.text, /裁决为「驳回」.*须通过|裁决为「驳回」/, 'check flags review completed w/o pass (Chinese wording)');
assert.match(chk.text, /❌/, 'check reports violations');

// ── 6b-2) phase freeze gate: implement + READY-but-pending = violation ──
await writeFile(join(runDir, 'STATE.json'), JSON.stringify({ runId, phase: 'implement', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts', members: [], coverage: [], updatedAt: new Date().toISOString() }));
await writeFile(join(runDir, 'TASKS.json'), JSON.stringify({ tasks: [
  { id: 'b1', kind: 'implementation', owner: 'backend', status: 'pending', dependsOn: [], verify: [], changedPaths: [] },
  { id: 'b2', kind: 'implementation', owner: 'backend', status: 'pending', dependsOn: ['b1'], verify: [], changedPaths: [] },
] }));
const chkF = await cmd('check ' + runId, cwd);
assert.match(chkF.text, /\[b1\].*冻结/, 'implement + ready pending = freeze violation (no status write-back)');
assert.match(chkF.text, /待开始/, 'violation wording is Chinese');
assert.doesNotMatch(chkF.text, /\[b2\].*冻结/, 'downstream pending behind an open dep is legitimately blocked');

// ── 7) /team migrate upgrades an OLD-schema run ──
const oldDir = join(cwd, 'team', 'oldrun');
await mkdir(oldDir, { recursive: true });
await writeFile(join(oldDir, 'STATE.json'), JSON.stringify({ runId: 'oldrun', phase: 'implement', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts', members: [], updatedAt: new Date().toISOString() }));
await writeFile(join(oldDir, 'TASKS.json'), JSON.stringify({ tasks: [{ id: 'be-1', owner: 'backend', title: 'x', status: 'in-progress', dependsOn: [] }, { id: 'rv-1', owner: 'reviewer', title: 'y', status: 'pending', dependsOn: ['be-1'] }] }));
const mig = await cmd('migrate oldrun', cwd);
assert.equal(mig.kind, 'success', mig.text);
const migTasks = JSON.parse(await readFile(join(oldDir, 'TASKS.json'), 'utf8')).tasks;
assert.equal(migTasks[0].kind, 'implementation'); assert.equal(migTasks[0].status, 'in_progress'); assert.equal(migTasks[1].kind, 'review');
assert.equal(migTasks[0].attempt, 0); assert.equal(migTasks[0].round, 1); assert.ok(Array.isArray(migTasks[0].findings));
const migState = JSON.parse(await readFile(join(oldDir, 'STATE.json'), 'utf8'));
assert.ok(Array.isArray(migState.coverage), 'migrate adds coverage');

// ── 8) /team canvas --watch embeds live polling + state route ──
await writeFile(join(runDir, 'TASKS.json'), JSON.stringify({ tasks: [{ id: 'f1', owner: 'frontend', status: 'in_progress' }] }));
const canvas = await cmd('canvas --watch ' + runId, cwd);
assert.equal(canvas.kind, 'success');
const html = await readFile(join(runDir, '画布.html'), 'utf8');
assert.match(html, /id="board"/); assert.match(html, /dsh-expert-team\/state/, 'polls state route'); assert.match(html, /setInterval\(poll, 3000\)/);
assert.match(html, /阶段：(澄清|调研|设计|规格评审|方案确认|实现|审查|测试|交付)\s*\/\s*状态：(进行中|已完成|失败|已取消)/, 'canvas meta uses the Chinese phase/status labels');
assert.match(html, /<li class="cur">(澄清|调研|设计|规格评审|方案确认|实现|审查|测试|交付)<\/li>/, 'canvas stepper uses the Chinese phase name');
assert.match(html, /负责人：前端/, 'canvas task cards use the Chinese owner label');
assert.match(html, /var M=\{phase:/, 'live canvas script embeds the Chinese label maps');
assert.doesNotMatch(html, /<li class="cur">clarify<\/li>/, 'no raw English phase id in the stepper');

// ── 9) web route: state (with pendingDecision), artifact, decide ──
// D8（SPEC §2.2）：logTail / files 的断言必须是**内容**断言。旧断言只查
// `typeof === 'string'` / `Array.isArray`，而 runLogTail / liveFiles 当时全仓无定义
// （ReferenceError 被 try/catch 吞成 '' 与 []）⇒ 死代码下**恒过**，面板恒空无人发现。
// ⚠️ fixture 必须写在本 section **首次**调用 /state 之前：liveFiles 有模块级 5s TTL
// 缓存（key = workspace + runId），先调一次会把空结果缓存住，内容断言就会假失败。
await writeFile(join(runDir, 'RUN.log.md'), [
  '- [21:00:00] phase:implement — 并行派工 backend(Ivy)+frontend(Alex)',
  '- [21:00:01] decision:user — SELF-LEARN-LOG-MARKER 用户拍板执行',
  '',
  '<!-- 编排者：按 references/LOGGING.md 追加事件 -->',
  '',
].join('\n'));
await writeFile(join(runDir, 'TASKS.json'), JSON.stringify({ tasks: [{ id: 'f1', owner: 'frontend', status: 'in_progress', changedPaths: ['packages/dsh-expert-team/lib/command.js'] }] }));
// R13：显示路径也走 run 作用域过滤 ⇒ 这里把两个活子代理**如实归属到本 run**：
//   ① STATE.json 补上 `ownerSession: 'sess-reg-1'`（真实 run 由派工路径写入；旧 fixture 漏了它，
//      于是 peopleSid 退化成"发起请求的会话" sess-r9，归属证据自然对不上 ⇒ 全被拒）；
//   ② wfEvents 带本 run 的 `runId`（下面 push）。
// 断言一条都没放宽：`s.members.backend.active/id` 仍要求 true / 'sub-b1'，只是证据从
// "宽松显示"换成了"归属成立"。必须在首次 /state 之前填（workflowEventIndex 缓存 3s）。
await writeFile(join(runDir, 'STATE.json'), JSON.stringify({ runId, phase: 'spec-review', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts', coverage: [{ constraint: 'c1', tasks: ['f1'] }], members: [], ownerSession: 'sess-reg-1', updatedAt: new Date().toISOString(), pendingDecision: { title: '方案确认', prompt: '确认执行？', options: [{ id: 'go', label: '执行' }, { id: 'rev', label: '修改' }] } }));
wfEvents.push(
  { type: 'tool-workflow/agent-start', time: Date.now(), data: { childId: 'sub-b1', label: '[backend] Runner 退避', phase: 'implement', runId, seq: 1 } },
  { type: 'tool-workflow/agent-start', time: Date.now(), data: { childId: 'sub-a1', label: '调研AI审核现状', phase: 'research', runId, seq: 2 } },
);
// R6：**显式**传 `&workspace=` + `&run=`，不靠路由自动选 run（自动选靠 `STATE.updatedAt`
// 最新者 —— 本工作区里同时存在 `oldrun` 等多个 run，自动选就是个假失败面）。
const s = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) + '&sessionId=sess-r9&workspace=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) });
assert.equal(s.ok, true); assert.equal(s.pendingDecision.options.length, 2); assert.equal(s.coverage.length, 1); assert.ok(s.runs.length >= 1);
assert.equal(s.runId, runId, 'R6：显式 workspace+run 生效（不是自动选出来的那个）');
// 内容断言（取代旧的 `typeof === 'string'` / `Array.isArray` 弱断言）：
assert.equal(typeof s.logTail, 'string', 'state carries RUN.log tail (live feed)');
assert.match(s.logTail, /SELF-LEARN-LOG-MARKER/, 'logTail 真的读到了 RUN.log.md 的内容（不是死代码返回的空串）');
assert.ok(s.logTail.length > 0, 'logTail 非空');
assert.doesNotMatch(s.logTail, /<!--/, 'logTail 去掉了尾部 HTML 注释行');
assert.ok(Array.isArray(s.files), 'state carries live changed files');
assert.ok(s.files.includes('packages/dsh-expert-team/lib/command.js'), 'files 含在办（in_progress）任务的 changedPaths：' + JSON.stringify(s.files));
assert.equal(typeof s.feed, 'object', 'state carries per-agent activity feed');
// End-to-end: a tool result for a live subagent must reach /state as a READABLE
// line — this is the exact string the activity capsule renders (the bug showed
// the raw compound command, with its quotes escaped to literal `&quot;`).
assert.ok(eventListeners['tools/result'] && eventListeners['tools/result'].length, 'host observes tools/result for the live feed');
eventListeners['tools/result'].forEach((fn) => fn({
  name: 'bash',
  arguments: { command: 'cat ~/.dsh/profiles/web/cordis.yml; echo "=== profiles dir ===";' },
  agent: { session: { header: { id: 'sub-b1' } } },
}, { content: [{ type: 'text', text: 'login: ...' }] }));
const sFeed = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) + '&sessionId=sess-r9&workspace=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) });
assert.ok(sFeed.feed['sub-b1'] && sFeed.feed['sub-b1'].length, 'feed entry keyed by the live subagent id');
assert.equal(sFeed.feed['sub-b1'].slice(-1)[0].line, '已查看 ~/.dsh/profiles/web/cordis.yml（+1 条）', 'capsule line = readable action summary');
assert.doesNotMatch(sFeed.feed['sub-b1'].slice(-1)[0].line, /&quot;|&amp;/, 'capsule line carries no escaped entity');
assert.equal(s.members.backend.active, true, "live subagent recognized via ctx.get(subagents) (cordis service resolution)");
assert.equal(s.members.backend.activity, 'idle', 'activity surfaced (running/idle)');
assert.equal(s.members.backend.id, 'sub-b1', 'precise agent id surfaced');
const art = await route('/plugins/dsh-expert-team/artifact', { url: '/plugins/dsh-expert-team/artifact?cwd=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) + '&name=TASK' });
assert.equal(art.ok, true); assert.match(art.text, /目标/);
const dec = await route('/plugins/dsh-expert-team/decide', { method: 'POST', body: JSON.stringify({ workspace: cwd, run: runId, choice: '执行' }) });
assert.equal(dec.ok, true);
const s2 = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) + '&workspace=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) }); // R6：显式选 run
assert.equal(s2.pendingDecision, null, 'decide clears pendingDecision');
assert.equal(s2.runId, runId, 'R6：显式 workspace+run 生效');

// cross-workspace explicit selection (workspace path contains '/') — the
// overlay run selector relies on this; used to be rejected as 'bad params'.
const sx = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?workspace=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) });
assert.equal(sx.ok, true, 'explicit workspace+run selection accepts slash workspace paths');
assert.equal(sx.runId, runId, 'selected run matches');

// ── 10) /team task quick write-back + overlay task route ──
const tk = await cmd('task f1 in_progress --run ' + runId, cwd);
assert.equal(tk.kind, 'success', tk.text);
assert.equal(JSON.parse(await readFile(join(runDir, 'TASKS.json'), 'utf8')).tasks.find((x) => x.id === 'f1').status, 'in_progress', 'task subcommand writes status');
const taskRoute = await route('/plugins/dsh-expert-team/task', { method: 'POST', body: JSON.stringify({ workspace: cwd, run: runId, id: 'f1', status: 'completed', note: '测试' }) });
assert.equal(taskRoute.ok, true, 'overlay task route ok');
assert.equal(JSON.parse(await readFile(join(runDir, 'TASKS.json'), 'utf8')).tasks.find((x) => x.id === 'f1').status, 'completed', 'overlay task route writes status');

// ── 10b) REAL dsh req shape: body arrives as an ASYNC ITERABLE stream ──
const sp = JSON.stringify({ workspace: cwd, run: runId, id: 'f1', status: 'in_progress', note: '流式' });
const resStream = await new Promise((resolve) => {
  const resObj = { writeHead() {}, end: (b) => resolve(JSON.parse(b)) };
  handlers['/plugins/dsh-expert-team/task']({ method: 'POST', [Symbol.asyncIterator]: async function* () { yield Buffer.from(sp, 'utf8'); } }, resObj);
});
assert.equal(resStream.ok, true, 'async-iterable (stream) request body works — real dsh webServer shape');
assert.equal(JSON.parse(await readFile(join(runDir, 'TASKS.json'), 'utf8')).tasks.find((x) => x.id === 'f1').status, 'in_progress', 'stream body write persisted');

// ── 10c) no cross-workspace fallback: a workspace WITHOUT a run → empty state ──
const cwd2 = join(root, 'no-team-ws');
await mkdir(cwd2, { recursive: true });
const sNone = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd2) });
assert.equal(sNone.ok, false, 'workspace without a run → empty state, no cross-workspace run served');
assert.match(sNone.error, /当前工作区还没有专家团/, 'message guides user to /team + selector');
assert.ok(Array.isArray(sNone.runs) && sNone.runs.length >= 1, 'other workspaces runs still listed for the selector');

// ── 10d) session→run memory: auto-select anchors to THIS session's run ──
const memFile = JSON.parse(await readFile(join(process.env.DSH_HOME, 'expert-team', 'session-runs.json'), 'utf8'));
assert.ok(memFile['sess-reg-1'] && memFile['sess-reg-1'].runId, 'session→run memory persisted');
const sMem = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?sessionId=sess-reg-1&cwd=' + encodeURIComponent(cwd) });
assert.equal(sMem.ok, true, 'session memory auto-select works');
assert.equal(sMem.runId, memFile['sess-reg-1'].runId, 'the session\u2019s last-viewed run wins auto-select (memory > workspace-newest)');

// ── 10e) cross-session enrich: run's registered agent (via agents registry) ──
await writeFile(join(runDir, 'STATE.json'), JSON.stringify({ runId, phase: 'implement', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts', members: ['sub-x-1234567890abcdef:qa:done'], coverage: [], updatedAt: new Date().toISOString() }));
const sX = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) + '&workspace=' + encodeURIComponent(cwd) });
assert.equal(sX.ok, true, 'cross-session state ok');
assert.equal(sX.members.qa.active, true, 'registered agent id resolved via live agents registry (cross-session view)');
assert.equal(sX.members.qa.activity, 'running', 'registry status surfaced');
assert.match(sX.members.qa.model, /deepseek-pro/, 'registry model surfaced');

// ── 11) ownership gate: verification→qa / review→reviewer / quality→qa|reviewer ──
await writeFile(join(runDir, 'TASKS.json'), JSON.stringify({ tasks: [{ id: 'q1', kind: 'verification', owner: 'backend', status: 'pending', dependsOn: [] }, { id: 'rv9', kind: 'review', owner: 'qa', status: 'pending', dependsOn: [] }, { id: 'q2', kind: 'quality', owner: 'backend', status: 'completed', verdict: 'pass', dependsOn: [] }] }));
const chkO = await cmd('check ' + runId, cwd);
assert.match(chkO.text, /\[q1\].*应为 qa/, 'verification must be owned by qa');
assert.match(chkO.text, /\[rv9\].*应为 reviewer/, 'review must be owned by reviewer');
assert.match(chkO.text, /\[q2\].*质量任务\(质量自检\).*应为 qa\/reviewer/, 'quality kind is ALLOWED but not owned by implementers');
assert.doesNotMatch(chkO.text, /kind「quality」非法/, 'quality is a legal kind (real runs use it)');

// ── 11b) taxonomy: research/design are legal kinds; an unknown kind warns, never blocks ──
// Regression for run 做竞品分析-分析dsh官方的te-145629, whose six healthy tasks
// (T-01…T-06, all completed with verdict pass) were failed by the closed enum.
await writeFile(join(runDir, 'TASKS.json'), JSON.stringify({
  tasks: [
    { id: 'r1', kind: 'research', owner: 'researcher', status: 'completed', verdict: 'pass', dependsOn: [] },
    { id: 'd1', kind: 'design', owner: 'architect', status: 'completed', verdict: 'pass', dependsOn: [] },
    { id: 'x1', kind: 'made-up-kind', owner: 'backend', status: 'in_progress', dependsOn: [] },
  ],
}));
const chkK = await cmd('check ' + runId, cwd);
assert.equal(chkK.kind, 'success', chkK.text);
assert.doesNotMatch(chkK.text, /「research」非法|「design」非法/, 'research/design are legal kinds (the pipeline\'s own stage vocabulary)');
assert.match(chkK.text, /⚠ \[x1\].*不在词表内/, 'an unknown kind is reported as a warning');
assert.doesNotMatch(chkK.text, /❌ \[x1\]/, 'an unknown kind must NOT block the quality gate');
assert.match(chkK.text, /允许：需求\/调研\/设计\//, 'the warning names the legal kinds');
// /state must carry the same taxonomy warnings to the overlay.
const sK = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) + '&workspace=' + encodeURIComponent(cwd) });
assert.equal(sK.warnings.length, 1, 'state exposes kind warnings');
assert.match(sK.warnings[0], /made-up-kind/, 'state warning names the offending kind');
assert.deepEqual(sK.violations, [], 'kind taxonomy never counts as a violation');
// Restore the task list the later plan/approve stage expects (q2 must survive approve).
await writeFile(join(runDir, 'TASKS.json'), JSON.stringify({ tasks: [{ id: 'q1', kind: 'verification', owner: 'backend', status: 'pending', dependsOn: [] }, { id: 'rv9', kind: 'review', owner: 'qa', status: 'pending', dependsOn: [] }, { id: 'q2', kind: 'quality', owner: 'backend', status: 'completed', verdict: 'pass', dependsOn: [] }] }));

// ── 12) /team board + /team learn --deep + file preview route ──
const bd = await cmd('board', cwd);
assert.equal(bd.kind, 'success');
assert.match(bd.text, /项目看板/, 'board headline');
assert.match(bd.text, new RegExp(runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'board lists run rows');
const dl = await cmd('learn --deep', cwd);
assert.equal(dl.kind, 'success', dl.text);
assert.match(await readFile(join(cwd, 'team', 'DEEP-LEARN.md'), 'utf8'), /深度蒸馏/, 'deep learn writes DEEP-LEARN.md');
const fv = await route('/plugins/dsh-expert-team/file', { url: '/plugins/dsh-expert-team/file?workspace=' + encodeURIComponent(cwd) + '&path=' + encodeURIComponent('src/api/token.ts') });
assert.equal(fv.ok, true, 'file preview route ok');
assert.match(fv.text, /generateToken/, 'file preview returns file content');
const fvBad = await route('/plugins/dsh-expert-team/file', { url: '/plugins/dsh-expert-team/file?workspace=' + encodeURIComponent(cwd) + '&path=' + encodeURIComponent('../etc/passwd') });
assert.equal(fvBad.ok, false, 'file preview blocks traversal');

// ── 13) auto-launched (LLM-built, no /team) run is fully host-compatible ──
const autoDir = join(cwd, 'team', '2026-09-09-自建-run-01');
await mkdir(autoDir, { recursive: true });
await writeFile(join(autoDir, 'TASK.md'), '# 任务\n\n> 目标：自动拉起测试\n\n- 模式：one-shot\n- 交付：code+artifacts\n- 固定角色：pm, architect, researcher, backend, frontend, reviewer, qa\n');
await writeFile(join(autoDir, 'ROSTER.json'), JSON.stringify({ runId: '2026-09-09-自建-run-01', roles: ['pm', 'architect', 'researcher', 'backend', 'frontend', 'reviewer', 'qa'], members: {}, agents: { pm: { name: 'Mia', color: '#5b8def', initial: 'M' }, architect: { name: 'Owen', color: '#22b07d', initial: 'O' }, researcher: { name: 'Zoe', color: '#e0913c', initial: 'Z' }, backend: { name: 'Ivy', color: '#d05a9c', initial: 'I' }, frontend: { name: 'Alex', color: '#7a5ef0', initial: 'A' }, reviewer: { name: 'Sam', color: '#c04f4f', initial: 'S' }, qa: { name: 'Tina', color: '#3aa6b9', initial: 'T' } }, createdAt: new Date().toISOString() }));
await writeFile(join(autoDir, 'STATE.json'), JSON.stringify({ runId: '2026-09-09-自建-run-01', phase: 'clarify', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts', coverage: [], members: [], updatedAt: new Date().toISOString() }));
await writeFile(join(autoDir, 'TASKS.json'), JSON.stringify({ tasks: [] }));
const autoCheck = await cmd('check 2026-09-09-自建-run-01', cwd);
assert.match(autoCheck.text, /无违规/, 'LLM-built scaffold passes host gate');
const autoState = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?cwd=' + encodeURIComponent(cwd) });
assert.equal(autoState.ok, true, 'overlay lists LLM-built run');
assert.ok(autoState.runs.some((r) => r.runId === '2026-09-09-自建-run-01'), 'LLM-built run visible to overlay');

// ── 14) A3/A4: /team detail + /team limit quota enforcement ──
const dtl = await cmd('detail ' + runId, cwd);
assert.equal(dtl.kind, 'success', dtl.text);
assert.match(dtl.text, /运行详情/, 'detail headline');
assert.match(dtl.text, /时间线/, 'detail timeline');
const lim = await cmd('limit ' + runId + ' --max-runs 1', cwd);
assert.equal(lim.kind, 'success', lim.text);
assert.match(lim.text, /配额/, 'limit set');
// resume once → run count 1
const r1 = await cmd('resume ' + runId, cwd);
assert.equal(r1.kind, 'success', r1.text);
const stLim = JSON.parse(await readFile(join(runDir, 'STATE.json'), 'utf8'));
assert.equal(stLim.quota.runs, 1, 'resume counts a run');
// second resume → quota exceeded
const r2 = await cmd('resume ' + runId, cwd);
assert.equal(r2.kind, 'error', 'quota rejects second resume');
assert.match(r2.text, /配额限制/, 'quota message');
const limC = await cmd('limit ' + runId + ' --clear', cwd);
assert.equal(limC.kind, 'success', 'clear quota');
const r3 = await cmd('resume ' + runId, cwd);
assert.equal(r3.kind, 'success', 'resume works after clear');

// ── 12) F1 计划门（AgentTeams 借鉴）：暂存草稿 → 可编辑 → Approve & Run / Discard ──
const planStage = await route('/plugins/dsh-expert-team/plan', { method: 'POST', body: JSON.stringify({
  workspace: cwd, run: runId,
  draft: {
    roles: ['pm', 'frontend', 'qa'],
    tasks: [
      { id: 'P-01', owner: 'pm', title: '澄清需求' },
      { id: 'P-02', owner: 'frontend', title: '实现页面', dependsOn: ['P-01'] },
      { id: 'P-03', owner: 'qa', title: '验收', dependsOn: ['P-01'] },
      { id: 'P-04', owner: 'nonexistent-role', title: '非法 owner 应回落到首个角色' },
    ],
  },
}) });
assert.equal(planStage.ok, true, 'plan stage ok');
const stDraft = JSON.parse(await readFile(join(runDir, 'STATE.json'), 'utf8'));
assert.equal(stDraft.draft.tasks.length, 4, 'draft persisted with 4 tasks');
assert.equal(stDraft.draft.roles.length, 3, 'draft persisted with 3 roles');
assert.deepEqual(stDraft.draft.tasks[2].dependsOn, ['P-01'], 'valid dependency preserved');
// 批 2-2（L2-2）：未知依赖**不再被静默删除** —— 必须拒绝该草稿。
// 旧断言（dependsOn 被删成 []）编码的是 bug 行为，已按新契约改写。
const planBadDep = await route('/plugins/dsh-expert-team/plan', { method: 'POST', body: JSON.stringify({ workspace: cwd, run: runId, draft: { roles: ['pm'], tasks: [{ id: 'X-1', owner: 'pm', title: 'x', dependsOn: ['NOPE'] }] } }) });
assert.equal(planBadDep.ok, false, 'unknown dependency id is REJECTED (not silently pruned)');
assert.ok(Array.isArray(planBadDep.detail) && planBadDep.detail.some((d) => /NOPE/.test(d)), 'rejection names the offending dependency');
assert.equal(stDraft.draft.tasks[3].owner, 'pm', 'illegal owner falls back to first role');
assert.equal(stDraft.draft.tasks[0].status, 'pending', 'draft tasks normalized to pending');
const sPlan = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?workspace=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) });
assert.equal(sPlan.planStatus, 'staged', 'state exposes staged plan');
assert.equal(sPlan.draft.roles.length, 3, 'state exposes draft roles');

const planApprove = await route('/plugins/dsh-expert-team/plan/approve', { method: 'POST', body: JSON.stringify({ workspace: cwd, run: runId }) });
assert.equal(planApprove.ok, true, 'plan approve ok');
const tasksAfter = JSON.parse(await readFile(join(runDir, 'TASKS.json'), 'utf8'));
const idsAfter = (tasksAfter.tasks || []).map((t) => t.id);
for (const id of ['P-01', 'P-02', 'P-03', 'P-04']) assert.ok(idsAfter.includes(id), 'draft task ' + id + ' landed into TASKS.json');
assert.ok(idsAfter.includes('q2'), 'settled pre-existing task (q2, completed) preserved on approve');
const stApproved = JSON.parse(await readFile(join(runDir, 'STATE.json'), 'utf8'));
assert.equal(stApproved.draft, undefined, 'draft cleared after approve');
assert.ok(stApproved.planApprovedAt, 'planApprovedAt stamped');

// 再次暂存 → Discard：置「禁止自动重建」标记 + 清草稿
await route('/plugins/dsh-expert-team/plan', { method: 'POST', body: JSON.stringify({ workspace: cwd, run: runId, draft: { roles: ['pm'], tasks: [{ id: 'P-09', owner: 'pm', title: 'x' }] } }) });
const planDiscard = await route('/plugins/dsh-expert-team/plan/discard', { method: 'POST', body: JSON.stringify({ workspace: cwd, run: runId, reason: '测试丢弃' }) });
assert.equal(planDiscard.ok, true, 'plan discard ok');
const stDisc = JSON.parse(await readFile(join(runDir, 'STATE.json'), 'utf8'));
assert.ok(stDisc.planDiscarded && stDisc.planDiscarded.at, 'discard marker written (禁止自动重建)');
assert.equal(stDisc.draft, undefined, 'draft removed on discard');
const sDisc = await route('/plugins/dsh-expert-team/state', { url: '/plugins/dsh-expert-team/state?workspace=' + encodeURIComponent(cwd) + '&run=' + encodeURIComponent(runId) });
assert.equal(sDisc.planStatus, 'discarded', 'state reports discarded');
const planEmpty = await route('/plugins/dsh-expert-team/plan', { method: 'POST', body: JSON.stringify({ workspace: cwd, run: runId, draft: { roles: ['pm'], tasks: [] } }) });
assert.equal(planEmpty.ok, false, 'empty draft rejected');
console.log('plan gate ✅ 草稿暂存/校验 → Approve & Run 落 TASKS.json → Discard 置禁止重建标记');

// ── 13) B 层/对话流文案全中文：阶段、状态、类型、裁决一律汉字显示 ──
const clientSrc = await readFile(join(here, 'client.js'), 'utf8');
for (const k of ['STATUS_ZH', 'KIND_ZH', 'VERDICT_ZH', 'statusLabel', 'kindLabel', 'verdictLabel']) assert.ok(clientSrc.includes(k), 'client has label helper ' + k);
assert.match(clientSrc, /'阶段 → ' \+ phaseLabel\(String\(d\.phase\)\)/, 'capsule stage event shows the Chinese phase label');
assert.doesNotMatch(clientSrc, /'阶段 → ' \+ String\(d\.phase\)/, 'capsule no longer prints the raw phase id');
assert.match(clientSrc, /esc\(phaseLabel\(data\.phase\)\) \+ ' \/ ' \+ esc\(statusLabel\(data\.status\)\)/, 'panel meta line is Chinese');
const skillSrc = await readFile(join(here, 'skills/expert-team/SKILL.md'), 'utf8');
assert.match(skillSrc, /阶段 → 设计 完成/, 'skill broadcast template uses the Chinese phase name');
assert.match(skillSrc, /阶段名一律写中文汉字/, 'skill pins the all-Chinese broadcast rule');
console.log('i18n ✅ B 层胶囊/浮层 + 画布 + /team status·check + 播报模板：阶段/状态/类型/裁决全中文');

console.log('\nREGRESSION PASSED ✔  (team run ' + runId + ', ' + Object.keys(handlers).length + ' routes, root ' + root + ')');
