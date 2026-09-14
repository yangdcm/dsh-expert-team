// 测试：写入点 schema 告警（批 2-4 · L1-4′）
//
// 要修的**已被实证的静默伤害**：本 run 自己的 `STATE.coverage` 曾被写成
// **角色名字符串数组**（`["pm","architect",…]`），消费端用
// `Array.isArray(state.coverage) ? state.coverage : []` 兜底 ⇒ 渲染成一串空行，
// **生产端违约 + 消费端静默吞**，没有任何人被告知。
//
// 评审的硬要求：**告警、不硬拒** —— `listRuns` 对不合规 STATE.json 是 catch 后静默跳过，
// 若写入侧硬拒，旧 run 会从 `/team status` 与浮层**静默消失**（比容忍脏数据更糟）。
//
// 本测试断言：
//   ① 不合规内容 → 有 schema 告警
//   ② **但文件照样被写入**（不阻断），且内容可读回（旧 run 不会消失）
//   ③ 合规内容 → 无告警（不误报）
//   ④ TASKS.json 的 tasks 非数组 → 告警
//   ⑤ 告警经事件上报（可审计），且 write() 返回值里带 schemaWarnings
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M11。
// 运行：node schema-warn.test.mjs

import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactWriter, nodeFsPort } from './lib/artifact-writer.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-et-schema-'));
// 真实调用点都由 scaffoldRun 先建 run 目录；受控入口不负责 mkdir -p（与旧 writeFile 行为一致）
await mkdir(join(root, 'team', 'r1'), { recursive: true });
const events = [];
const writer = createArtifactWriter({ fsPort: nodeFsPort(), onEvent: (e) => events.push(e) });
const statePath = join(root, 'team', 'r1', 'STATE.json');
const tasksPath = join(root, 'team', 'r1', 'TASKS.json');

console.log('# 写入点 schema 告警（告警不阻断）\n');

console.log('① 不合规 coverage（字符串数组 —— 真实发生过的 bug）→ 必须告警');
const bad = await writer.write(statePath, {
  runId: 'r1', phase: 'clarify', status: 'running',
  coverage: ['pm', 'architect', 'researcher'],   // ← 形状违约：应为 [{constraint,tasks}]
  members: [],
});
check(bad.ok === true, '写入仍然成功（**不硬拒**）', `ok=${bad.ok}`);
check(Array.isArray(bad.schemaWarnings) && bad.schemaWarnings.length > 0, '返回了 schemaWarnings', JSON.stringify(bad.schemaWarnings));
check(/coverage/.test(JSON.stringify(bad.schemaWarnings)), '告警点名 coverage');
check(events.some((e) => e.type === 'schema-warn' && /coverage/.test(e.message || '')), '经 schema-warn 事件上报（可审计）');

console.log('\n② 关键：告警**不得**阻断写入 —— 旧 run 不能因此消失');
const onDisk = JSON.parse(await readFile(statePath, 'utf8'));
check(Array.isArray(onDisk.coverage) && onDisk.coverage[0] === 'pm', '文件**确实被写入**且内容可读回（旧 run 不会从 /team status 消失）');
check(Number.isInteger(onDisk.revision), '仍带 revision（受控入口的其它能力未受影响）', `revision=${onDisk.revision}`);

console.log('\n③ 合规内容 → 不误报');
events.length = 0;
const good = await writer.write(statePath, {
  runId: 'r1', phase: 'clarify', status: 'running',
  coverage: [{ constraint: '无后端', tasks: ['T-01'] }],
  members: ['sub-1:pm:running'],
});
check(good.ok === true && good.schemaWarnings.length === 0, '合规 STATE 无告警', JSON.stringify(good.schemaWarnings));
check(!events.some((e) => e.type === 'schema-warn'), '未产生 schema-warn 事件');

console.log('\n④ TASKS.json：tasks 非数组 → 告警');
const t1 = await writer.write(tasksPath, { tasks: { 'T-01': {} } });
check(t1.schemaWarnings.length > 0, 'tasks 非数组 → 告警', JSON.stringify(t1.schemaWarnings));
const t2 = await writer.write(tasksPath, { tasks: [{ id: 'T-01' }, { title: '没有 id' }] });
check(t2.schemaWarnings.some((m) => /id/.test(m)), 'tasks 元素缺 id → 告警', JSON.stringify(t2.schemaWarnings));
const t3 = await writer.write(tasksPath, { tasks: [{ id: 'T-01' }, { id: 'T-02' }] });
check(t3.schemaWarnings.length === 0, '合规 TASKS 无告警');

console.log('\n⑤ 未登记的工件不做校验（避免误报）');
const other = await writer.write(join(root, 'team', 'r1', 'OTHER.json'), { anything: ['x'] });
check(other.schemaWarnings.length === 0, '未知工件名 → 不校验、不告警');

console.log('');
if (fail > 0) {
  console.log(`✗ schema 告警测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ schema 告警测试通过（违约即告警、绝不阻断、合规不误报、可审计）');
