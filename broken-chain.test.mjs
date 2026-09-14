// 测试：断链即违规（批 2-5 · L1-5′）
//
// 问题：质量类任务（review/verification/requirements/quality）判 `failed` 或 `needs_revision` 后，
// 若**既没有后继 repair 任务、也没有 `pendingDecision`**，修复链就断在那里，而 `/team check`
// 过去**不报任何违规** —— 表现为"评审判不过、却没人被派去修、也没人被告知要拍板"。
//
// 关键：判"已接续"必须**忠于 SKILL 约定** —— `repair-N` 依赖的是**被审实现**，
// **不依赖**那个 failed review（failed 是终态，不该 gate 住修复）。因此按 **round** 判定：
//   · repair 任务显式依赖失败任务（严格形式），或
//   · repair 任务的 round > 失败任务的 round（repair-N 响应第 N 轮评审 —— 主约定），或
//   · 存在更高 round 的质量类后续任务（独立 review-N+1）。
// 本测试第 ② 条正是 e2e 里那条合法链路（rv-1 failed ← repair-1 依赖 be-1 ← rv-2），
// 用来防"规则过严把合法链路误报为断链"。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M10。
// 运行：node broken-chain.test.mjs

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-et-chain-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply } = await import(join(here, 'lib', 'command.js'));
let registered = null;
apply({
  commands: { register: (d) => { registered = d; } },
  on: () => {},
  get: () => undefined,
  inject: () => {},
});
const cmd = (rawInput) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-chain-1', header: { cwd } }, followup: () => {} },
});
const runsIn = async () => (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();

await cmd('链路门禁验证');
const run = (await runsIn())[0];
const dir = join(cwd, 'team', run);
const setTasks = (tasks) => writeFile(join(dir, 'TASKS.json'), JSON.stringify({ tasks }, null, 2) + '\n');
const setState = async (patch) => {
  const st = JSON.parse(await readFile(join(dir, 'STATE.json'), 'utf8'));
  await writeFile(join(dir, 'STATE.json'), JSON.stringify({ ...st, ...patch }, null, 2) + '\n');
};
const checkText = async () => JSON.stringify(await cmd('check'));

console.log('# 断链即违规（L1-5′）\n');

console.log('① 质量任务 failed 且无任何接续 → 必须报违规');
await setState({ pendingDecision: null });
await setTasks([
  { id: 'be-1', kind: 'implementation', owner: 'backend', title: '实现', status: 'completed', round: 1, verify: ['npm test'], dependsOn: [] },
  { id: 'rv-1', kind: 'review', owner: 'reviewer', title: '评审', status: 'failed', verdict: 'reject', round: 1, dependsOn: ['be-1'] },
]);
let out = await checkText();
check(/既无后继 repair 任务/.test(out), '报出「断链」', (out.match(/断链[^"]*/) || ['(未找到)'])[0].slice(0, 80));
check(/rv-1/.test(out), '指出是哪个任务断了');

console.log('\n② 合法链路：repair 依赖"被审实现"（非 failed review）+ 更高 round → 不得误报');
await setTasks([
  { id: 'be-1', kind: 'implementation', owner: 'backend', title: '实现', status: 'completed', round: 1, verify: ['npm test'], dependsOn: [] },
  { id: 'rv-1', kind: 'review', owner: 'reviewer', title: '评审', status: 'failed', verdict: 'reject', round: 1, dependsOn: ['be-1'] },
  { id: 'repair-1', kind: 'repair', owner: 'backend', title: '修复', status: 'in_progress', round: 2, dependsOn: ['be-1'], inScope: ['src/**'], verify: ['npm test'] },
  { id: 'rv-2', kind: 'review', owner: 'reviewer', title: '复审', status: 'pending', round: 2, dependsOn: ['repair-1'] },
]);
out = await checkText();
check(!/既无后继 repair 任务/.test(out), '合法链路**不**报断链（SKILL 约定：repair-N 依赖被审实现）', (out.match(/断链[^"]*/) || ['(无)'])[0].slice(0, 60));

console.log('\n③ 已升级给用户拍板（pendingDecision）→ 不算断链');
await setState({ pendingDecision: { title: '审查到上限', prompt: '继续审还是停止？', options: [{ id: 'go', label: '继续' }, { id: 'stop', label: '停止' }] } });
out = await checkText();
check(!/既无后继 repair 任务/.test(out), '有 pendingDecision 时不报断链（已升级，不是断链）');
await setState({ pendingDecision: null });

console.log('\n④ needs_revision 同样触发（不只是 failed）');
await setTasks([
  { id: 'be-1', kind: 'implementation', owner: 'backend', title: '实现', status: 'completed', round: 1, verify: ['npm test'], dependsOn: [] },
  { id: 'rv-1', kind: 'review', owner: 'reviewer', title: '评审', status: 'completed', verdict: 'needs_revision', round: 1, dependsOn: ['be-1'] },
]);
out = await checkText();
check(/既无后继 repair 任务/.test(out), 'verdict=needs_revision 且无接续 → 报断链');

console.log('\n⑤ 实现类任务 failed 不触发该规则（只针对质量类）');
await setTasks([
  { id: 'be-1', kind: 'implementation', owner: 'backend', title: '实现', status: 'failed', round: 1, verify: ['npm test'], dependsOn: [] },
]);
out = await checkText();
check(!/既无后继 repair 任务/.test(out), '实现任务 failed 不报断链（该规则只管质量类）');

console.log('');
if (fail > 0) {
  console.log(`✗ 断链规则测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 断链规则测试通过（无接续即违规、合法链路不误报、pendingDecision 可豁免）');
