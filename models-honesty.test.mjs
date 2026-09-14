// 能力面忠实度测试：/team models 不得展示不存在的成本优势（批 0-5）
//
// 背景（PM 的第五驱动力「承诺-能力一致性」，带一票否决权）：
// 旧文案恒称「轻角色跑快模型、重角色跑顶配，整体成本约为全员顶配的 1/2~1/5」，
// 而 `MODEL_DEFAULT` 的 heavy/light **同为 `deepseek-flash`** ⇒ 单模型期**根本没有成本差**，
// 产品却在向用户展示一个不存在的优势。同时 `MODEL_TIERS` 把 backend/frontend/qa 归 light，
// 而 preset 给这三个角色 `reasoningEffort: high` —— 二者不一致且**尚未拍板谁是权威**。
//
// 本测试断言文案**由真实配置推导**（不是又一句永远为真的宣传语）：
//   ① 两档同值时，不得出现「1/2~1/5」这类成本优势宣称；
//   ② 必须如实说明"两档同值 ⇒ 无成本差"；
//   ③ 必须如实列出 tier 与 effort 的不一致角色；
//   ④ effort 必须真的从 preset 读到（数量 > 0）。
//
// 变异验证：
//   · 变异体 A：把 MODEL_DEFAULT.heavy 改成另一个模型 → ①② 的断言应随之变化（证明测试读真实值，不是恒真）
//   · 变异体 B：恢复旧的误导文案 → ① 应失败
//
// 运行：node models-honesty.test.mjs

import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'dsh-et-models-'));
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

// rawInput 只是参数部分（不含 /team）—— 本仓既有约定
const cmd = (rawInput) => registered.handler({
  rawInput,
  attachments: [],
  agent: { session: { id: 'sess-models-1', header: { cwd } }, followup: () => {} },
});

await cmd('做一个测试页');
const out = (await cmd('models')).text || '';
console.log('# /team models 能力面忠实度\n');
console.log(out.split('\n').map((l) => '    ' + l).join('\n'));
console.log('');

// 从真实常量读取"两档是否同值"，据此决定期望值（测试不硬编码结论）
const src = await readFile(join(here, 'lib', 'command.js'), 'utf8');
const mHeavy = src.match(/const MODEL_DEFAULT = \{ heavy: '([^']+)'/);
const mLight = src.match(/const MODEL_DEFAULT = \{[^}]*light: '([^']+)'/);
const sameTier = !!mHeavy && !!mLight && mHeavy[1] === mLight[1];
console.log(`  （实际常量：heavy=${mHeavy && mHeavy[1]} / light=${mLight && mLight[1]} ⇒ ${sameTier ? '同值' : '不同'}）\n`);

console.log('① 不得宣称不存在的成本优势');
check(!/1\/2~1\/5/.test(out), '输出不含旧的「1/2~1/5」成本优势宣称');
check(!/全员顶配/.test(out), '输出不含「全员顶配」这类比较基准（两档同值时无意义）');

console.log('\n② 如实说明两档的实际关系');
if (sameTier) {
  check(/没有成本差|没有实际成本差/.test(out), '同值时明确说明「没有成本差」');
  check(/同为\s*\S+/.test(out), '同值时点出两档实际是同一个模型');
} else {
  check(/实际有成本差/.test(out), '不同值时说明「实际有成本差」');
}

console.log('\n③ 如实列出 tier 与 effort 的不一致');
const mism = (out.match(/tier 与 effort 不一致（([^）]+)）/) || [])[1] || '';
check(/backend\/frontend\/qa/.test(mism), '列出不一致角色 backend/frontend/qa', mism || '(未列出)');
check(/尚未拍板/.test(out), '说明该冲突尚未拍板（不代为决定）');

console.log('\n④ effort 必须真的从 preset 读到');
const n = Number((out.match(/已从 preset 读到 (\d+) 个角色/) || [])[1] || 0);
check(n > 0, '从 preset 读到了逐角色 effort', `读到 ${n} 个角色`);
check(!/未能读取 preset/.test(out), '未出现「未能读取 preset」的降级表述');

console.log('');
if (fail > 0) {
  console.log(`✗ 能力面忠实度测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 能力面忠实度测试通过（文案由真实配置推导，冲突如实暴露）');
