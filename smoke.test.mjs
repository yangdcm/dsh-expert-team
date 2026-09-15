// Smoke test for @yangdcm/dsh-expert-team's /team command plugin (in-workspace, no ~/.dsh touched).
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { rmFixture } from './test-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { apply, name, inject } = await import(join(here, 'lib/command.js'));

// 1) export shape
assert.equal(name, 'expert-team-command');
assert.ok(inject.includes('commands'));

// 2) registers a `team` command
let registered = null;
apply({ commands: { register: (d) => { registered = d; } } });
assert.ok(registered, 'command registered');
assert.equal(registered.name, 'team');
assert.equal(typeof registered.handler, 'function');

// 3) functional create + scaffold + followup, all under a workspace temp dir
const root = await mkdtemp(join(tmpdir(), 'dsh-expert-team-smoke-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
const { mkdir } = await import('node:fs/promises');
await mkdir(cwd, { recursive: true });

let followup = null;
const invocation = {
  rawInput: '--persist --roles pm,architect,backend,qa 做一个登录页',
  attachments: [],
  agent: { session: { header: { cwd } }, followup: (m) => { followup = m; } },
};
const res = await registered.handler(invocation);
assert.equal(res.kind, 'success', 'create succeeds: ' + JSON.stringify(res));
console.log('create result:\n' + res.text);

// followup enqueued a model-visible user message
assert.ok(followup, 'followup enqueued');
assert.equal(followup.role, 'user');
assert.match(followup.content[0].text, /专家团/);
assert.ok(followup.id);

// scaffold present
const team = join(cwd, 'team');
const runs = await readdir(team);
assert.equal(runs.length, 1, 'one run scaffolded');
const runDir = join(team, runs[0]);
// run 目录**必需文件**清单 = 运行时 templates 常量（13 项，含 AUTHORITY.md）＋ 由日志器创建的 RUN.log.md。
// ⚠️ 与 templates 常量**不是同一个集合**（那边不含 RUN.log.md）—— 两者关系由 artifact-ownership.test.mjs 的「工件清单一致」断言钉住。
for (const f of ['TASK.md', 'ROSTER.json', 'STATE.json', '任务看板.md', 'SPEC.md', 'PLAN.md', 'RESEARCH.md', 'TASKS.json', 'REVIEW.md', 'TEST.md', 'SUMMARY.md', 'RETRO.md', 'AUTHORITY.md', 'RUN.log.md']) {
  await readFile(join(runDir, f), 'utf8').catch(() => assert.fail('missing ' + f));
}
// run log seeded with a run:started line
const runLog = await readFile(join(runDir, 'RUN.log.md'), 'utf8');
assert.match(runLog, /run:started/, 'run log seeded with run:started');
const roster = JSON.parse(await readFile(join(runDir, 'ROSTER.json'), 'utf8'));
assert.deepEqual(roster.roles, ['pm', 'architect', 'backend', 'qa']);
const state = JSON.parse(await readFile(join(runDir, 'STATE.json'), 'utf8'));
assert.equal(state.phase, 'clarify');
assert.equal(state.mode, 'persist');

// skill installed to (fake) DSH_HOME/skills/expert-team
await readFile(join(process.env.DSH_HOME, 'skills', 'expert-team', 'SKILL.md'), 'utf8');

// status lists the run
const statusInv = { ...invocation, rawInput: 'status' };
const status = await registered.handler(statusInv);
assert.equal(status.kind, 'success');
assert.match(status.text, /澄清/, 'status line shows the Chinese phase label');
assert.match(status.text, /\[常驻\]/, 'status line shows the Chinese mode label');

// ── learn: aggregate RUN.log → METRICS + distilled LEARNINGS (with dedup) ──
const { writeFile, appendFile } = await import('node:fs/promises');
await appendFile(join(runDir, 'RUN.log.md'), [
  '- [23:59:00] phase:started — design (architect)',
  '- [23:59:00] role:result — role=backend verdict=rework blockers=契约未冻结',
  '- [23:59:00] role:result — architect 完成(designMarkdown+tasks[16])',
  '- [23:59:00] role:result — backend 完成但契约不一致（返工）',
  '- [23:59:00] role:result — reviewer verdict=conditionally-pass（P0 全关）',
  '- [23:59:00] role:result — role=qa verdict=pass',
  '- [23:59:00] error — 并行角色契约未冻结导致返工',
  '- [23:59:00] ask — 交付口径（code+artifacts?）',
  '- [23:59:00] decision — 统一以 PLAN.md 为权威契约',
  '',
].join('\n'));
// mark complete so aggregation sees a finished run
await writeFile(join(runDir, 'STATE.json'), JSON.stringify({ ...state, phase: 'deliver', status: 'complete' }, null, 2) + '\n');

const learnInv = { ...invocation, rawInput: 'learn' };
const learn = await registered.handler(learnInv);
assert.equal(learn.kind, 'success');
const metrics = await readFile(join(cwd, 'team', 'METRICS.md'), 'utf8');
assert.match(metrics, /团队指标/, 'METRICS.md written');
const learnings = await readFile(join(cwd, 'team', 'LEARNINGS.md'), 'utf8');
assert.match(learnings, /Team Skill|Expert Skill|高频卡点/, 'LEARNINGS distilled');
assert.match(metrics, /backend/, 'prose role:result parsed (backend rework counted)');
assert.match(metrics, /architect/, 'prose role:result parsed (architect detected)');

// re-running learn must NOT duplicate the distilled block
await registered.handler(learnInv);
const learnings2 = await readFile(join(cwd, 'team', 'LEARNINGS.md'), 'utf8');
assert.equal(learnings2.split('自动蒸馏（/team learn）').length - 1, 1, 'distilled block appended once, not duplicated');

// a NEW run's launch message must inject the accumulated LEARNINGS summary
followup = null;
await registered.handler({ ...invocation, rawInput: '--roles pm,architect,qa 第二个任务' });
assert.match(followup.content[0].text, /既往经验/, 'launch message injects LEARNINGS summary');

// ── canvas: renders a self-contained HTML team canvas for a run ──
const canvas = await registered.handler({ ...invocation, rawInput: 'canvas' });
assert.equal(canvas.kind, 'success', 'canvas succeeds: ' + JSON.stringify(canvas));
assert.match(canvas.text, /画布\.html/, 'canvas reports the html path');
const canvases = (await readdir(join(cwd, 'team'))).filter((n) => n.endsWith('.html') === false);
let foundHtml = null;
for (const runName of canvases) {
  try { await readFile(join(cwd, 'team', runName, '画布.html'), 'utf8').then((h) => { foundHtml = h; }); } catch {}
}
assert.ok(foundHtml, '画布.html rendered for a run');
assert.match(foundHtml, /专家团画布/, 'canvas html contains the title');
assert.match(foundHtml, /任务看板/, 'canvas html has the task board');

console.log('\nSMOKE TEST PASSED ✔  (temp root: ' + root + ')');
await rmFixture(root);
