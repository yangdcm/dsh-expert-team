// 测试：全图 DAG 校验（批 2-2 · L2-2）
//
// 背景（三处静默吞掉，代价各不相同）：
//   · 计划路由曾 `.filter(d => ids.has(d))` **直接删掉**未知依赖 ⇒ 用户以为依赖生效，实则没有；
//   · `checkTasks` 曾 `if (!dep) continue` **静默放行** ⇒ 门禁出现盲区；
//   · **全仓无环检测** ⇒ 环状 DAG 让 implement 整体死锁（环内任务永远 ready=false），
//     而 `/team check` 不报任何违规，表现为面板「待开始」永久不动。
//
// 本测试走**真实路径**（fake ctx + 真实 /team check 与 /plan 路由），断言：
//   ① `/team check` 报出环路         ② 报出未知依赖        ③ 报出重复 id
//   ④ `/plan` 保存含环路的草稿 → **400 拒绝**（不再静默删依赖）
//   ⑤ 合法 DAG → 不报图结构错误（不误报）
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M8（关掉图结构上报 → 本测试必须红）。
//
// 运行：node dag.test.mjs

import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-et-dag-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply } = await import(join(here, 'lib', 'command.js'));
let registered = null;
const handlers = {};
apply({
  commands: { register: (d) => { registered = d; } },
  on: () => {},
  get: () => undefined,
  inject: (deps, f) => {
    if (String(deps) === 'webServer') f({ effect: (fn) => fn(), webServer: { register: (c) => { handlers[c.path] = c.handler; return () => {}; } } });
  },
});

const cmd = (rawInput) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-dag-1', header: { cwd } }, followup: () => {} },
});
const route = (path, body) => new Promise((resolve) => {
  const req = { method: 'POST', url: path, body: body == null ? null : JSON.stringify(body) };
  const res = { writeHead() {}, end: (b) => resolve(b ? JSON.parse(b) : null) };
  handlers[path](req, res);
});
const runsIn = async () => (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const writeTasks = async (run, tasks) => {
  await writeFile(join(cwd, 'team', run, 'TASKS.json'), JSON.stringify({ tasks }, null, 2) + '\n');
};

await cmd('DAG 校验验证');
const run = (await runsIn())[0];
check(!!run, '已建立 run 目录', String(run));

/** 跑一次 /team check（返回文本）。 */
async function runCheck() {
  const r = await cmd('check');
  return String((r && (r.text || r.message)) || '');
}
/** 把 check 输出当作字符串（有些实现走 text 字段）。 */
const flatten = (r) => JSON.stringify(r || {});

console.log('\n① 环路必须被报出（过去完全不报）');
await writeTasks(run, [
  { id: 'A', title: 'a', status: 'pending', dependsOn: ['B'] },
  { id: 'B', title: 'b', status: 'pending', dependsOn: ['A'] },
]);
let out = flatten(await cmd('check'));
check(/循环依赖/.test(out), '报告「循环依赖」', (out.match(/循环依赖[^"]*/) || ['(未找到)'])[0].slice(0, 70));
check(/A/.test(out) && /B/.test(out), '报出环上的任务 id');

console.log('\n② 未知依赖必须被报出（过去被静默删/放行）');
await writeTasks(run, [
  { id: 'A', title: 'a', status: 'pending', dependsOn: ['NOPE'] },
]);
out = flatten(await cmd('check'));
check(/依赖不存在的任务/.test(out), '报告「依赖不存在的任务」', (out.match(/依赖不存在的任务[^"]*/) || ['(未找到)'])[0].slice(0, 70));

console.log('\n③ 重复 id 必须被报出');
await writeTasks(run, [
  { id: 'A', title: 'a', status: 'pending', dependsOn: [] },
  { id: 'A', title: 'a2', status: 'pending', dependsOn: [] },
]);
out = flatten(await cmd('check'));
check(/id 重复/.test(out), '报告「id 重复」', (out.match(/id 重复[^"]*/) || ['(未找到)'])[0].slice(0, 70));

console.log('\n④ /plan 保存含环路的草稿 → 必须 400 拒绝（不再静默删依赖）');
const bad = await route('/plugins/dsh-expert-team/plan', {
  workspace: cwd, run,
  draft: { roles: ['pm'], tasks: [{ id: 'T-01', owner: 'pm', title: 'x', dependsOn: ['T-02'] }, { id: 'T-02', owner: 'pm', title: 'y', dependsOn: ['T-01'] }] },
});
check(bad && bad.ok === false, '/plan 拒绝非法依赖图', `ok=${bad && bad.ok}`);
check(/依赖图不合法/.test(String(bad && bad.error)), '拒绝原因说明是依赖图不合法', String(bad && bad.error));
check(Array.isArray(bad && bad.detail) && bad.detail.length > 0, '给出具体错误明细', JSON.stringify((bad && bad.detail) || []).slice(0, 80));
// 关键：不能像旧行为那样"删掉依赖然后放行"
const stAfter = JSON.parse(await readFile(join(cwd, 'team', run, 'STATE.json'), 'utf8'));
check(!stAfter.draft || !stAfter.draft.tasks, '被拒绝时**没有**落盘草稿（不是删依赖后放行）');

console.log('\n⑤ 合法 DAG 不得误报');
const okPlan = await route('/plugins/dsh-expert-team/plan', {
  workspace: cwd, run,
  draft: { roles: ['pm'], tasks: [{ id: 'T-01', owner: 'pm', title: 'x', dependsOn: [] }, { id: 'T-02', owner: 'pm', title: 'y', dependsOn: ['T-01'] }] },
});
check(okPlan && okPlan.ok === true, '合法 DAG 保存成功', `ok=${okPlan && okPlan.ok}`);
const st2 = JSON.parse(await readFile(join(cwd, 'team', run, 'STATE.json'), 'utf8'));
check(!!(st2.draft && st2.draft.tasks && st2.draft.tasks.length === 2), '草稿已落盘');
check(!(st2.draft && 'graphErrors' in st2.draft), 'graphErrors 校验副产物**未**被持久化进草稿');
await writeTasks(run, [
  { id: 'A', title: 'a', status: 'pending', dependsOn: [] },
  { id: 'B', title: 'b', status: 'pending', dependsOn: ['A'] },
]);
out = flatten(await cmd('check'));
check(!/循环依赖|依赖不存在的任务|id 重复/.test(out), '合法图不报图结构错误', out.slice(0, 60));

console.log('');
if (fail > 0) {
  console.log(`✗ DAG 校验测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ DAG 校验测试通过（环路/未知依赖/重复 id 均被报出或被拒绝，合法图不误报）');
