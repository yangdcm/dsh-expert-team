// 测试：模板拷贝完整性（防"Buffer 被当对象展开"的回归）
//
// 真实事故（第 7 轮迁移引入、第 12 轮由 schema 告警抓出）：
// 受控入口原写 `const isObject = typeof content === 'object'` —— 而 **Buffer / Uint8Array / Array
// 也是 object**。模板拷贝是 `ARTIFACT.must(dst, await readFile(url))`（不带编码 ⇒ Buffer），
// 于是被 `{...buffer}` 展开，把模板写成**字节表**：
//     { "0": 123, "1": 10, "2": 32, ... }      // 本应是 { "tasks": [] }
// 即此后新建的每个 run，其 TASKS.json / SPEC.md / PLAN.md 等模板全是坏的。
//
// 现有测试套件**没抓到**（盲区：未断言 run 目录里模板文件的初始形状）——本测试补上这个盲区。
//
// 断言：
//   ① 新建 run 后，每个 .json 模板都是**合法 JSON**，且不含数字键（字节表特征）
//   ② TASKS.json 的 tasks 是数组（内容真的是模板内容）
//   ③ 每个 .md 模板都不像字节表，且非空
//   ④ Buffer 内容写入应保持 utf8 文本（直接单测受控入口）
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M12。
// 运行：node template-copy.test.mjs

import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
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

console.log('# 模板拷贝完整性（Buffer 不得被当对象展开）\n');

// ── ④ 直接单测受控入口：Buffer 内容必须按 utf8 文本写入（不走 JSON 路径）──
const tmp = await mkdtemp(join(tmpdir(), 'dsh-et-tpl-'));
const w = createArtifactWriter({ fsPort: nodeFsPort() });
const bufPath = join(tmp, 'BUFFER.json');
const res = await w.write(bufPath, Buffer.from('{"tasks":[]}\n', 'utf8'));
check(res.ok === true, '写入 Buffer 成功', `ok=${res.ok}`);
const bufText = await readFile(bufPath, 'utf8');
check(bufText.includes('"tasks"') && !/"0"\s*:/.test(bufText), 'Buffer 按 utf8 文本写入，**未**被展开成字节表', JSON.stringify(bufText.slice(0, 40)));
check(res.revision === null, 'Buffer 走文本路径（不附加 revision —— 它不是结构化对象）', `revision=${res.revision}`);

// ── ①②③ 真实跑一次创建，检查 run 目录里的模板 ──
const root = await mkdtemp(join(tmpdir(), 'dsh-et-tpl2-'));
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
await registered.handler({
  rawInput: '模板完整性验证',
  attachments: [],
  agent: { session: { id: 'sess-tpl-1', header: { cwd } }, followup: () => {} },
});
const runs = (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
check(runs.length === 1, '已创建 1 个 run', runs.join(','));
const dir = join(cwd, 'team', runs[0]);
const entries = await readdir(dir);
const jsonFiles = entries.filter((f) => f.endsWith('.json'));
const mdFiles = entries.filter((f) => f.endsWith('.md'));
check(jsonFiles.length > 0 && mdFiles.length > 0, 'run 目录含 json 与 md 模板', `json=${jsonFiles.length} md=${mdFiles.length}`);

console.log('\n① JSON 模板必须是合法 JSON 且不含数字键（字节表）');
for (const f of jsonFiles) {
  const raw = await readFile(join(dir, f), 'utf8');
  let ok = true, why = '';
  try {
    const o = JSON.parse(raw);
    const keys = Object.keys(o || {});
    const numeric = keys.filter((k) => /^\d+$/.test(k));
    if (numeric.length) { ok = false; why = `含数字键 ${numeric.slice(0, 4).join(',')}… ⇒ 字节表`; }
  } catch (e) { ok = false; why = 'JSON 解析失败：' + e.message; }
  check(ok, `${f} 完整`, why);
}

console.log('\n② TASKS.json 的内容真的是模板内容');
const tasksRaw = await readFile(join(dir, 'TASKS.json'), 'utf8');
const tasksObj = JSON.parse(tasksRaw);
check(Array.isArray(tasksObj.tasks), 'TASKS.json 的 tasks 是数组', JSON.stringify(tasksObj.tasks));

console.log('\n③ Markdown 模板不得是字节表且非空');
for (const f of mdFiles) {
  const raw = await readFile(join(dir, f), 'utf8');
  const looksLikeBytes = /^\{\s*"0"\s*:/.test(raw.trim());
  check(!looksLikeBytes && raw.trim().length > 0, `${f} 为正常文本`, looksLikeBytes ? '形如字节表' : `${raw.length} 字符`);
}

console.log('');
if (fail > 0) {
  console.log(`✗ 模板完整性测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 模板完整性测试通过（Buffer 走文本路径，模板文件未被展开成字节表）');
