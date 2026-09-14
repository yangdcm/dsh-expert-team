// 元测试：证据/锚点门禁**必须能失败**（批 1 · N-7 的 M4 基线）
//
// 为什么需要它：一个不会失败的门禁等于没有门禁。本 run 的头号交付就是让"引用可机器判定"，
// 而该门禁第一版曾有 130 条假阳性——若它永远通过，团队会重新回到"行号漂移无人发现"的状态。
//
// 断言：
//   ① 只含**真实锚点**的文档 → exit 0（不误报）
//   ② 含**编造锚点**的文档 → exit 1（抓得住），且指出是哪条
//   ③ 引用**不存在的文件** → exit 1
//
// 注意：引用写成 `lib/command.js · <anchor>`（包内相对路径），这样无论本包被复制到哪里，
// check-evidence 都能通过 PKG_ROOT 解析到目标文件 —— 变异运行器（scripts/mutate.mjs）
// 会把整包复制到临时目录，路径必须与位置无关。
//
// 运行：node evidence-gate.test.mjs

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 跑 check-evidence 并返回 {code, out}（0/1/2 都要能拿到，故不 reject）。extraArgs 用于 `--json` 等；env 用于基线覆写。 */
async function gate(targetDir, extraArgs = [], env = {}) {
  try {
    const { stdout } = await run('node', [join(here, 'scripts', 'check-evidence.mjs'), targetDir, ...extraArgs], {
      cwd: here,
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-et-evidence-'));
// 真实存在的锚点（本包内的稳定标识符）
const REAL_ANCHOR = 'function goalKeyOf';
// 一定不存在的锚点
const FAKE_ANCHOR = 'totallyMadeUpAnchorXYZ_9f3a';

console.log('# 证据门禁元测试（门禁必须能失败）\n');

console.log('① 只含真实锚点 → 应当通过');
const okDir = join(root, 'ok');
await mkdir(okDir, { recursive: true });
await writeFile(join(okDir, 'ok.md'), `# 正常文档\n\n引用：\`lib/command.js · ${REAL_ANCHOR} @ 1\`\n`);
const r1 = await gate(okDir);
check(r1.code === 0, '真实锚点 → exit 0（不误报）', `exit=${r1.code}`);
check(/命中 1/.test(r1.out), '统计到 1 条锚点命中', (r1.out.match(/锚点引用[^\n]*/) || [''])[0]);

console.log('\n② 含编造锚点 → 必须失败并指出');
const fakeDir = join(root, 'fake');
await mkdir(fakeDir, { recursive: true });
await writeFile(join(fakeDir, 'fake.md'), `# 含编造引用的文档\n\n引用：\`lib/command.js · ${FAKE_ANCHOR} @ 1\`\n`);
const r2 = await gate(fakeDir);
check(r2.code === 1, '编造锚点 → exit 1（抓得住）', `exit=${r2.code}`);
check(r2.out.includes(FAKE_ANCHOR), '报出是哪个锚点未命中');
check(/MISSING/.test(r2.out), '归类为 MISSING（事实性缺陷）');

console.log('\n③ 引用不存在的文件 → 必须失败');
const badDir = join(root, 'badfile');
await mkdir(badDir, { recursive: true });
await writeFile(join(badDir, 'badfile.md'), '# 引用不存在的文件\n\n引用：`lib/definitely-not-here.js · somethingReal @ 1`\n');
const r3 = await gate(badDir);
check(r3.code === 1, '文件不存在 → exit 1', `exit=${r3.code}`);
check(/源文件不存在/.test(r3.out), '报出「源文件不存在」');

console.log('\n④ 正常与编造混排 → 仍必须失败（不得被"多数正常"淹没）');
const mixDir = join(root, 'mix');
await mkdir(mixDir, { recursive: true });
await writeFile(join(mixDir, 'mix.md'), [
  '# 混排文档',
  `- 真：\`lib/command.js · ${REAL_ANCHOR} @ 1\``,
  `- 假：\`lib/command.js · ${FAKE_ANCHOR} @ 2\``,
  `- 真：\`lib/command.js · function modelPlanFor @ 1\``,
  '',
].join('\n'));
const r4 = await gate(mixDir);
check(r4.code === 1, '混排 → exit 1', `exit=${r4.code}`);
check(/锚点引用[^\n]*命中 2，未命中 1/.test(r4.out), '同时报出命中 2 / 未命中 1', (r4.out.match(/锚点引用[^\n]*/) || [''])[0]);

// ---- B-07：误报修复的元测试（占位符模板 / 围栏反例不得计入引用，但真引用仍必须被抓）----
// 背景（本会话实证）：`team/<runId>/TASKS.json · <锚点>` 这类**模板句**、以及文档里为了
// 说明"不要这样写"而示范的**反例**，曾被当成真引用去解析 ⇒ 门禁连红 4 次。
// 下列用例同时守住两侧：豁免生效（不误报）＋ 不得修成"永远通过"（真编造锚点仍 MISSING）。

console.log('\n⑤ 占位符模板（team/<runId>/… · <锚点>）→ 不得计入引用（B-07 误报①）');
const tplDir = join(root, 'placeholder');
await mkdir(tplDir, { recursive: true });
await writeFile(join(tplDir, 'template.md'), [
  '# 引用写法模板（示例，不是证据）',
  '',
  '- 写法：`team/<runId>/TASKS.json · <锚点> @ <行号>`',
  '- 写法：`lib/command.js · <anchorNameXYZ> @ <行号>`',
  '- 写法：`<相对路径> · <锚点（函数名/字段名/唯一字符串）> @ <行号>`',
  '',
].join('\n'));
const r5 = await gate(tplDir);
check(r5.code === 0, '占位符模板 → exit 0（不误报）', `exit=${r5.code}`);
// B-08D/SG-7 后口径：**路径侧**占位符（第 1、3 行）仍豁免；**锚点侧**占位符（第 2 行）不再
// 从分母里消失，而是落「未校验（弱证据）」桶 —— 所以总数由 0 变 1，分母仍然不虚高（模板不计）。
check(
  /锚点引用（可逐字校验）：1 条 —— 命中 0，未命中 0/.test(r5.out),
  '路径侧占位符不计入分母；锚点侧占位符计入分母但不判命中（SG-7）',
  (r5.out.match(/锚点引用[^\n]*/) || [''])[0],
);
check(
  /- 豁免（不计入校验）：占位符 2 条/.test(r5.out),
  '两条路径侧模板被判豁免（豁免量可见）',
  (r5.out.match(/- 豁免[^\n]*/) || [''])[0],
);
check(
  /- 未校验（弱证据，受棘轮约束）：1 条/.test(r5.out),
  '锚点侧占位符落未校验桶（可见、受棘轮约束）',
  (r5.out.match(/- 仅片段命中[^\n]*/) || [''])[0],
);
check(
  !/✗ MISSING（/.test(r5.out),
  '不产生 MISSING 条目（末行的"无 MISSING"字样不算）',
  (r5.out.match(/✗ MISSING[^\n]*/) || [''])[0],
);

console.log('\n⑥ 围栏代码块内的示例/反例 → 不得计入引用（B-07 误报②，方案 b）');
const fenceDir = join(root, 'fenced');
await mkdir(fenceDir, { recursive: true });
await writeFile(join(fenceDir, 'fenced.md'), [
  '# 反面告例：下面演示**错误写法**，禁止照抄（围栏内是示例，不是证据）',
  '',
  '```md',
  '- ❌ `lib/command.js · ' + FAKE_ANCHOR + ' @ 1`',
  '- ❌ `lib/definitely-not-here.js · anythingReal @ 1`',
  '```',
  '',
  '正确写法（围栏外的真引用）：`lib/command.js · ' + REAL_ANCHOR + ' @ 1`',
  '',
].join('\n'));
const r6 = await gate(fenceDir);
check(r6.code === 0, '围栏内的假引用 → exit 0（显式豁免）', `exit=${r6.code}`);
check(
  /锚点引用（可逐字校验）：1 条[^\n]*命中 1/.test(r6.out),
  '豁免只覆盖围栏内：围栏外的真引用仍被抓到并计入',
  (r6.out.match(/锚点引用[^\n]*/) || [''])[0],
);

console.log('\n⑦ 豁免不得变成"永远通过"：围栏外的真编造锚点仍必须 MISSING');
const blindDir = join(root, 'notblind');
await mkdir(blindDir, { recursive: true });
const FAKE_ANCHOR_2 = 'anotherMadeUpAnchorQZ_7c1b';
await writeFile(join(blindDir, 'mixed.md'), [
  '# 模板 + 反例块 + 真引用 + 真编造（混排）',
  '',
  '- 模板（占位符）：`team/<runId>/TASKS.json · <anchorNameXYZ> @ 1`',
  '',
  '```md',
  '- 反例（围栏内）：`lib/command.js · ' + FAKE_ANCHOR + ' @ 1`',
  '```',
  '',
  '- 真：`lib/command.js · ' + REAL_ANCHOR + ' @ 1`',
  '- 假：`lib/command.js · ' + FAKE_ANCHOR_2 + ' @ 2`',
  '',
].join('\n'));
const r7 = await gate(blindDir);
check(r7.code === 1, '围栏外的真编造锚点 → exit 1（豁免没有把门禁修瞎）', `exit=${r7.code}`);
check(r7.out.includes(FAKE_ANCHOR_2), '报出围栏外那条编造锚点');
check(
  /锚点引用（可逐字校验）：2 条[^\n]*命中 1，未命中 1/.test(r7.out),
  '统计口径：真引用 2 条（命中 1 / 未命中 1），模板与围栏反例均不计入',
  (r7.out.match(/锚点引用[^\n]*/) || [''])[0],
);

console.log('\n⑧ 裸文件名被后缀匹配到 SPEC 模板 → 仍 MISSING，但原因里点明"匹配到了模板"');
const bareDir = join(root, 'bare');
await mkdir(bareDir, { recursive: true });
await writeFile(join(bareDir, 'bare.md'), `# 裸文件名引用\n\n引用：\`TASKS.json · ${FAKE_ANCHOR} @ 1\`\n`);
const r8 = await gate(bareDir);
check(r8.code === 1, '裸文件名指向 run 目录 JSON → 仍 MISSING（写法确实不规范）', `exit=${r8.code}`);
check(/按裸文件名匹配到 SPEC 模板/.test(r8.out), '原因里给出"按裸文件名匹配到 SPEC 模板"提示');
check(/assets[\\/]templates[\\/]/.test(r8.out), '提示带上被匹配到的模板路径（可诊断）');

console.log('\n⑨ 未闭合围栏 → 不豁免（fail-closed：漏写 ``` 不得把余下真引用一次吞掉）');
const openFenceDir = join(root, 'unclosed-fence');
await mkdir(openFenceDir, { recursive: true });
await writeFile(join(openFenceDir, 'unclosed.md'), [
  '# 漏写闭合围栏的文档（反例本身不该发生）',
  '',
  '```md',
  '- 假：`lib/command.js · ' + FAKE_ANCHOR + ' @ 1`',
  '',
].join('\n'));
const r9 = await gate(openFenceDir);
check(r9.code === 1, '未闭合围栏内的引用仍被校验 → exit 1（不静默失明）', `exit=${r9.code}`);
check(r9.out.includes(FAKE_ANCHOR), '报出该编造锚点（门禁没有"永远通过"的盲区）');

// ---- B-08A：假阴性洞（QA 判为高危）+ 豁免/弱证据可见性 ----
// 背景：旧代码把锚点按「结构性分隔符 **+ 空白**」切分，且"任一片段命中即算命中"，
// 于是 `function QANonexistentProbe` 靠切出的 `function` 就绿了 —— 门禁的绿不构成"锚点真实"。
// 下面同时守住两侧：编造锚点必须 MISSING；历史"整条搜不到、片段在"的写法降级为
// 可见且受棘轮约束的弱证据（不判命中，也不判 MISSING）。

/** 落一个单文档目录并跑门禁（每个用例独立目录，避免互相污染）。 */
async function gateDoc(name, content) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), content);
  return gate(dir);
}

console.log('\n⑩ QA 那 4 条编造锚点 → 必须**逐条** MISSING（本任务核心验收）');
const QA_PROBES = [
  ['lib/command.js', 'function QANonexistentProbe'],
  ['lib/command.js', 'function QANonexistentProbe()'],
  ['lib/command.js', 'const qaNonexistentConst = 42'],
  ['cordis.patch.yml', 'insert:（expert-team-command @ 15-16）'],
];
for (const [i, [probePath, probeAnchor]] of QA_PROBES.entries()) {
  const r = await gateDoc(`qa-probe-${i + 1}`, `# QA 探针 ${i + 1}\n\n引用：\`${probePath} · ${probeAnchor}\`\n`);
  check(r.code === 1, `⑩-${i + 1} 「${probeAnchor}」→ exit 1（不得判命中）`, (r.out.match(/锚点引用[^\n]*/) || [''])[0]);
  check(/✗ MISSING（1）/.test(r.out), `⑩-${i + 1} 归入 MISSING（且仅此 1 条）`);
  check(!/- 仅片段命中[^\n]*：1 条/.test(r.out), `⑩-${i + 1} 不得被降级成弱证据`);
}

console.log('\n⑪ 收紧后真锚点仍命中（含**多词**真锚点）→ 不得误伤');
const realMulti = await gateDoc(
  'real-multiword',
  [
    '# 真锚点',
    '',
    `- 单词锚点：\`lib/command.js · ${REAL_ANCHOR} @ 1\``,
    // 多词锚点必须**整条**在目标文件里逐字存在。2026-09-13（B 线第 8 项第一步）：
    // `ROUND_LIMIT_OF_KIND` 已搬进 `lib/validate.js` ⇒ 本锚点随之改指新位置 ——
    // 这正是门禁该有的行为：搬代码位置就会让老锚点失效，而**失效必须可见**。
    '- 多词锚点（源码里逐字存在）：`lib/validate.js · export const ROUND_LIMIT_OF_KIND = {`',
    '',
  ].join('\n'),
);
check(realMulti.code === 0, '真锚点（含多词）→ exit 0', `exit=${realMulti.code}`);
check(
  /锚点引用[^\n]*命中 2，未命中 0/.test(realMulti.out),
  '两条都判命中（多词锚点整条逐字命中）',
  (realMulti.out.match(/锚点引用[^\n]*/) || [''])[0],
);
check(/- 未校验（弱证据，受棘轮约束）：0 条/.test(realMulti.out), '真锚点不会被降级成弱证据');

console.log('\n⑫ 「仅片段命中」→ 计入 fragmentOnly（既非命中、也非 MISSING），且汇总行可见');
const weakDoc = await gateDoc('fragment-only', '# 弱证据\n\n引用：`lib/command.js · function goalKeyOf（探针注解）`\n');
check(weakDoc.code === 0, '弱证据 → exit 0（不算失败，但也不判命中）', `exit=${weakDoc.code}`);
check(
  /锚点引用[^\n]*命中 0，未命中 0/.test(weakDoc.out),
  '既不判命中、也不判 MISSING',
  (weakDoc.out.match(/锚点引用[^\n]*/) || [''])[0],
);
check(
  /- 未校验（弱证据，受棘轮约束）：1 条/.test(weakDoc.out),
  '汇总行出现「- 未校验（弱证据，受棘轮约束）：1 条」（B-08E 改准标签）',
);
check(
  /弱证据明细：node scripts\/check-evidence\.mjs --json/.test(weakDoc.out),
  '未破线时不逐条刷屏（52 条会淹没真缺陷），但给出取明细的路子',
);
// 未破线时不逐条刷屏（52 条会淹没真缺陷），但 --json 必须给出明细与三个新字段（只增不删）
const weakJson = JSON.parse((await gate(join(root, 'fragment-only'), ['--json'])).out);
check(weakJson.summary.fragmentOnly === 1, '--json summary.fragmentOnly = 1');
check(typeof weakJson.summary.exemptPlaceholder === 'number', '--json summary.exemptPlaceholder 存在');
check(typeof weakJson.summary.exemptFenced === 'number', '--json summary.exemptFenced 存在');
check(
  /仅片段命中（弱证据）：片段/.test(weakJson.fragmentOnlyRefs[0]?.reason || ''),
  '--json fragmentOnlyRefs 给出弱证据明细',
  (weakJson.fragmentOnlyRefs[0]?.reason || '').slice(0, 60),
);

console.log('\n⑬ 棘轮：弱证据 = 基线 ⇒ exit 0；> 基线 ⇒ exit 1（新增弱证据即失败）');
const baselineJson = JSON.parse(
  await readFile(join(here, 'regression.fixtures', 'evidence-fragment-baseline.json'), 'utf8'),
);
const BASELINE = baselineJson.fragmentOnly;
/** 生成 n 条"整条搜不到、片段在"的弱证据（每条恰好 1 条 fragmentOnly）。 */
const weakLines = (n) =>
  Array.from({ length: n }, (_, i) => `- 弱 ${i}：\`lib/command.js · function goalKeyOf（探针${i}）\``).join('\n');
const atBaseline = await gateDoc('ratchet-equal', `# 等于基线（${BASELINE}）\n\n${weakLines(BASELINE)}\n`);
check(
  atBaseline.code === 0,
  `弱证据 = 基线（${BASELINE}）→ exit 0（棘轮保持）`,
  (atBaseline.out.match(/- 仅片段命中[^\n]*/) || [''])[0],
);
const overBaseline = await gateDoc('ratchet-over', `# 超过基线（${BASELINE + 1}）\n\n${weakLines(BASELINE + 1)}\n`);
check(
  overBaseline.code === 1,
  `弱证据 = 基线+1（${BASELINE + 1}）→ exit 1（新增弱证据必须失败）`,
  (overBaseline.out.match(/- 仅片段命中[^\n]*/) || [''])[0],
);
check(/弱证据增长（棘轮）/.test(overBaseline.out), '失败原因点明是"弱证据增长（棘轮）"');
check(/未命中 0/.test(overBaseline.out), '注意：这条失败**不是** MISSING 造成的');

console.log('\n⑭ 豁免量可见（R22/FIND-6）：占位符 1 条 + 围栏 1 条，且都不进分母');
const exemptDoc = await gateDoc(
  'exempt-count',
  [
    '# 豁免计数',
    '',
    '- 模板（占位符）：`team/<runId>/TASKS.json · <锚点> @ <行号>`',
    '',
    '```md',
    `- 反例（围栏内）：\`lib/command.js · ${FAKE_ANCHOR} @ 1\``,
    '```',
    '',
  ].join('\n'),
);
check(exemptDoc.code === 0, '两类豁免都在 → exit 0', `exit=${exemptDoc.code}`);
check(
  /- 豁免（不计入校验）：占位符 1 条 · 围栏块 1 条/.test(exemptDoc.out),
  '汇总行逐字为「- 豁免（不计入校验）：占位符 1 条 · 围栏块 1 条」',
  (exemptDoc.out.match(/- 豁免[^\n]*/) || [''])[0],
);
check(
  /锚点引用（可逐字校验）：0 条/.test(exemptDoc.out),
  '被豁免的两条都不进「锚点引用」分母',
  (exemptDoc.out.match(/锚点引用[^\n]*/) || [''])[0],
);

console.log('\n⑮ 通用片段不得当证据：`function` / `const` / `insert:` 单独作锚点 → 不判命中');
const genericDoc = await gateDoc(
  'generic-anchors',
  ['# 通用锚点', '', '- `lib/command.js · function @ 1`', '- `lib/command.js · const @ 1`', '- `cordis.patch.yml · insert: @ 11`', ''].join(
    '\n',
  ),
);
check(
  /锚点引用[^\n]*命中 0，未命中 0/.test(genericDoc.out),
  '三个通用锚点全部不判命中（也不判 MISSING：整条确实在源码里）',
  (genericDoc.out.match(/锚点引用[^\n]*/) || [''])[0],
);
check(/- 未校验（弱证据，受棘轮约束）：3 条/.test(genericDoc.out), '三条都归入弱证据（可见、受棘轮约束）');
const genericJson = JSON.parse((await gate(join(root, 'generic-anchors'), ['--json'])).out);
check(
  genericJson.fragmentOnlyRefs.every((f) => /锚点过于通用（弱证据）/.test(f.reason)),
  '明细点明"锚点过于通用"（三条都不得当成命中依据）',
  (genericJson.fragmentOnlyRefs[0]?.reason || '').slice(0, 50),
);

// ---- B-08D：统一规则（命中只认逐字）· 三条绕过路径 + 三键棘轮 + env 覆写 ----

console.log('\n⑯ FIND-9：「命中只认逐字」—— 点号形态不得靠"各段在文件里各自出现过"判命中');
const dottedDoc = await gateDoc(
  'verbatim-only',
  [
    '# 点号形态',
    '',
    '- 编造点号锚点（各段确实都出现过，但整条不是源码里的串）：`lib/command.js · state.members.round`',
    '- 真·JSON 嵌套键路径（package.json @7-9，三段带引号且同窗口有序）：`package.json · dsh.bundle.patch`',
    '',
  ].join('\n'),
);
check(dottedDoc.code === 0, '两者都不判 MISSING（编造点号锚点落未校验桶）', `exit=${dottedDoc.code}`);
check(
  /锚点引用[^\n]*命中 1，未命中 0/.test(dottedDoc.out),
  '`dsh.bundle.patch` 仍命中；`state.members.round` **不得**判命中',
  (dottedDoc.out.match(/锚点引用[^\n]*/) || [''])[0],
);
check(
  /- 未校验（弱证据，受棘轮约束）：1 条/.test(dottedDoc.out),
  '`state.members.round` 落未校验桶（可见、受棘轮约束）',
  (dottedDoc.out.match(/- 仅片段命中[^\n]*/) || [''])[0],
);
const dottedJson = JSON.parse((await gate(join(root, 'verbatim-only'), ['--json'])).out);
check(
  /state\.members\.round/.test(dottedJson.fragmentOnlyRefs[0]?.raw || ''),
  '未校验明细里就是那条点号锚点',
  (dottedJson.fragmentOnlyRefs[0]?.reason || '').slice(0, 60),
);

console.log('\n⑰ FIND-10：编造 token 一律 MISSING（"真 token 陪同"也不能兜底）；全真 token ⇒ 未校验');
const tokenDoc = await gateDoc(
  'token-completeness',
  [
    '# token 完整性',
    '',
    '- 全真 token、只是没逐字 ⇒ 未校验：`lib/command.js · function goalKeyOf（探针注解）`',
    '- 编造 token（旁边是真实的 `goalKeyOf`）⇒ 必须 MISSING：`lib/command.js · function goalKeyOf QANonexistentTail`',
    '',
  ].join('\n'),
);
check(tokenDoc.code === 1, '含编造 token 的引用 → exit 1', `exit=${tokenDoc.code}`);
check(tokenDoc.out.includes('QANonexistentTail'), '报出那条编造 token 的引用');
check(
  /锚点引用[^\n]*命中 0，未命中 1/.test(tokenDoc.out),
  '同文档里"全真 token"那条不判 MISSING（未命中只有 1 条）',
  (tokenDoc.out.match(/锚点引用[^\n]*/) || [''])[0],
);
check(/- 未校验（弱证据，受棘轮约束）：1 条/.test(tokenDoc.out), '"全真 token"那条落未校验桶');

console.log('\n⑱ SG-7：锚点侧尖括号 → **可见的**未校验桶（不得静默从分母消失）；路径侧仍豁免');
const sgDoc = await gateDoc(
  'anchor-placeholder',
  [
    '# 尖括号归属',
    '',
    '- 锚点侧占位符：`lib/command.js · <QANonexistentAnchor>`',
    '- 路径侧占位符（真模板）：`<lib/command.js> · <锚点>`',
    '',
  ].join('\n'),
);
check(sgDoc.code === 0, '锚点侧占位符不再静默豁免，但也不判 MISSING', `exit=${sgDoc.code}`);
check(
  /锚点引用（可逐字校验）：1 条/.test(sgDoc.out),
  '锚点侧占位符**计入分母**（total ≥1，SG-7 的核心）',
  (sgDoc.out.match(/锚点引用[^\n]*/) || [''])[0],
);
check(
  /- 未校验（弱证据，受棘轮约束）：1 条/.test(sgDoc.out),
  '该条被判"未校验"（可见、受棘轮约束）',
  (sgDoc.out.match(/- 仅片段命中[^\n]*/) || [''])[0],
);
check(/- 豁免（不计入校验）：占位符 1 条/.test(sgDoc.out), '路径侧占位符仍豁免（且计数可见）');
const sgJson = JSON.parse((await gate(join(root, 'anchor-placeholder'), ['--json'])).out);
check(
  /QANonexistentAnchor/.test(sgJson.fragmentOnlyRefs[0]?.raw || ''),
  '该条出现在 --json 的 fragmentOnlyRefs 里（没有静默跳过）',
);

console.log('\n⑲ FIND-11（B-08E 分级）：豁免类超基线 ⇒ **告警不失败**（exit 0）；fragmentOnly 超基线 ⇒ **仍 exit 1**');
const base2 = JSON.parse(await readFile(join(here, 'regression.fixtures', 'evidence-fragment-baseline.json'), 'utf8'));
const tplLine = (i) => `- 模板 ${i}：\`team/<runId>/TASKS.json · <锚点${i}> @ <行号>\``;
const exemptAt = await gateDoc(
  'exempt-at-baseline',
  `# 豁免量 = 基线（${base2.exemptPlaceholder}）\n\n${Array.from({ length: base2.exemptPlaceholder }, (_, i) => tplLine(i)).join('\n')}\n`,
);
check(
  exemptAt.code === 0,
  `占位符豁免 = 基线（${base2.exemptPlaceholder}）→ exit 0`,
  (exemptAt.out.match(/- 豁免[^\n]*/) || [''])[0],
);
check(!/⚠ 豁免量增长/.test(exemptAt.out), '等于基线时不打告警（无漂移）');
const exemptOver = await gateDoc(
  'exempt-over-baseline',
  `# 豁免量 = 基线+1\n\n${Array.from({ length: base2.exemptPlaceholder + 1 }, (_, i) => tplLine(i)).join('\n')}\n`,
);
// 裁决一①：豁免量超基线**不是失败**（豁免 = 合法文档形态），但必须显式告警并给出对比
check(
  exemptOver.code === 0,
  `占位符豁免 = 基线+1（${base2.exemptPlaceholder + 1}）→ exit 0（豁免是合法形态，不作为失败）`,
  `exit=${exemptOver.code}`,
);
check(
  /  ⚠ 豁免量增长：占位符 \d+ 条 > 基线 \d+ 条 · 围栏块 \d+ 条 \/ 基线 \d+ 条（豁免是合法的文档形态，不作为失败；仅提示漂移）/.test(
    exemptOver.out,
  ),
  '汇总区出现逐字告警行（两个 key 都给出 now/基线 对比）',
  (exemptOver.out.match(/⚠ 豁免量增长[^\n]*/) || [''])[0],
);
// 围栏块豁免同样只告警：造 base+1 条围栏内引用
const fencedDoc = Array.from(
  { length: base2.exemptFenced + 1 },
  (_, i) => `# 文档 ${i}\n\n\`\`\`md\n- 反例：\`lib/command.js · totallyMadeUpAnchorXYZ_9f3a @ ${i}\`\n\`\`\`\n`,
).join('\n');
const fencedOver = await gateDoc('fenced-over-baseline', fencedDoc);
check(fencedOver.code === 0, `围栏块豁免 = 基线+1（${base2.exemptFenced + 1}）→ exit 0`, `exit=${fencedOver.code}`);
check(/围栏块 \d+ 条 > 基线 \d+ 条/.test(fencedOver.out), '告警行点名围栏块超基线');
// 裁决一②（核心，不得削弱）：fragmentOnly 超基线仍然硬失败
const weakLines2 = (n) =>
  Array.from({ length: n }, (_, i) => `- 弱 ${i}：\`lib/command.js · function goalKeyOf（探针${i}）\``).join('\n');
const weakOver = await gateDoc('weak-over-baseline', `# 弱证据 = 基线+1\n\n${weakLines2(base2.fragmentOnly + 1)}\n`);
check(
  weakOver.code === 1,
  `fragmentOnly = 基线+1（${base2.fragmentOnly + 1}）→ **仍 exit 1**（债务必须硬失败）`,
  (weakOver.out.match(/- 未校验[^\n]*/) || [''])[0],
);
check(/✗ 弱证据增长（棘轮）/.test(weakOver.out), '失败原因点明"弱证据增长（棘轮）"');
check(/未命中 0/.test(weakOver.out), '这条失败不是 MISSING 造成的（纯棘轮）');

console.log('\n⑳ FIND-14②：基线路径支持 env 覆写（把"缺失 ⇒ fail-closed"变成自动化用例）');
const envDocDir = join(root, 'env-baseline');
await mkdir(envDocDir, { recursive: true });
await writeFile(join(envDocDir, 'env-baseline.md'), '# 一条弱证据\n\n- `lib/command.js · function goalKeyOf（探针注解）`\n');
const MISSING_BASELINE = join(root, 'definitely-missing-baseline.json');
const r20 = await gate(envDocDir, [], { DSH_EVIDENCE_FRAGMENT_BASELINE: MISSING_BASELINE });
check(r20.code === 1, 'env 指向不存在的基线 ⇒ exit 1（弱证据 fail-closed，按 0）', `exit=${r20.code}`);
check(/棘轮基线文件缺失或不可解析/.test(r20.out), '输出里明确报"基线缺失 ⇒ 按 0 处理"');
check(/\/ 基线 0 条/.test(r20.out), '汇总区把基线值渲染为 0（FIND-14①：基线值每轮可见）');

console.log('\n㉑ FIND-11③：基线缺失时两类 key 的不同处置（我的取舍，用例钉死）');
// 取舍：`fragmentOnly` 缺失 ⇒ 按 0 且**仍 fail-closed**（债务不能靠"删基线"关掉）；
//       豁免类缺失 ⇒ 按 0 但**只告警不失败**（它们是合法文档形态，不能因为基线没了就判红）。
const envTplDir = join(root, 'env-baseline-exempt');
await mkdir(envTplDir, { recursive: true });
await writeFile(join(envTplDir, 'env-baseline-exempt.md'), `# 一条模板行\n\n${tplLine(1)}\n`);
const r21 = await gate(envTplDir, [], { DSH_EVIDENCE_FRAGMENT_BASELINE: MISSING_BASELINE });
check(r21.code === 0, '基线缺失 + 只有豁免类超出（0）⇒ exit 0（豁免只告警）', `exit=${r21.code}`);
check(
  /⚠ 豁免量增长：占位符 1 条 > 基线 0 条/.test(r21.out),
  '豁免类超"缺失基线（0）"时给出告警行',
  (r21.out.match(/⚠ 豁免量增长[^\n]*/) || [''])[0],
);
check(/弱证据仍 fail-closed，豁免类只告警/.test(r21.out), '缺失提示里写明这条取舍');

console.log('');
if (fail > 0) {
  console.log(`✗ 证据门禁元测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 证据门禁元测试通过（能抓编造锚点与不存在的文件，且不误报真引用）');
