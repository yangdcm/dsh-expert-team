// 测试：token 记账（P5 线）—— `lib/metrics/tokens.js`（纯计算）+
// `lib/metrics/token-usage.js`（归属编排）+ `lib/metrics/session-usage.js`（遥测读取）。
//
// 为什么这个测试必须存在（这条线的诱惑是"随便报个数就当看见了"）：
//   METRICS 的「token 成本与上下文峰值」是**用户可见产物**，而它的数来自三处易错的地方：
//     ① DSH 会话遥测的**嵌套形状**（`usage` 挂在 `data` 下；`user/message` 的文本在
//        `data.content` 而不是 `data.message.content` —— 读错这一层不会报错，只会让所有数字**静默变 0**）；
//     ② 会话 → run 的**归属**（会话头里既没有 runId 也没有 role，只能从提示词里读；
//        读不出来时**必须**判"未归属"而不是随手塞给最近的 run）；
//     ③ 三个桶（未缓存/缓存/输出）与成本占比的**加和关系**。
//   本文件把这三件事各自钉住，并特别断言"读不到 ⇒ 如实说读不到"，而不是"读不到 ⇒ 0"。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M107。
// 运行：node token-accounting.test.mjs

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const tokens = await import(join(here, 'lib', 'metrics', 'tokens.js'));
const tu = await import(join(here, 'lib', 'metrics', 'token-usage.js'));
const su = await import(join(here, 'lib', 'metrics', 'session-usage.js'));

// ── zstd 压缩能力（⑦ 段要用它生成"真实压缩的会话文件"）────────────────────────
// ⚠ 这里**必须动态探测**，不能写顶层 `import { zstdCompressSync } from 'node:zlib'`：
//   该导出是 Node ≥ 22.15 / 23.8 才有的，Node 20 上静态导入会在**模块加载阶段**就
//   SyntaxError("does not provide an export named 'zstdCompressSync'")，连下面的跳过逻辑
//   都执行不到（2026-09-14 CI Node 20 档即此因）。
// 顺序：Node 内置 → `zstd` CLI（与生产解压用的是同一个工具）。两者都没有才跳过 ⑦ 段。
let compressZstd = null;
try {
  const zlib = await import('node:zlib');
  if (typeof zlib.zstdCompressSync === 'function') compressZstd = (buf) => zlib.zstdCompressSync(buf);
} catch { /* 老 Node 没有内置 zstd：继续找 CLI */ }
const hasZstdCli = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
if (!compressZstd && hasZstdCli) {
  compressZstd = (buf) => execFileSync('zstd', ['-q', '-c'], { input: buf, maxBuffer: 64 * 1024 * 1024 });
}
console.log(`# token 记账（P5）\n\n  · zstd 压缩能力：${compressZstd ? `可用（${hasZstdCli ? 'CLI + ' : ''}Node 内置）` : '不可用（Node <22.15 且无 zstd CLI ⇒ 跳过 ⑦ 端到端段）'}\n`);

console.log('① 事件解析：`tokens:<scope>` 与 `role:<角色> … tokens …`');
{
  const a = tokens.parseTokenEvent('tokens:backend', 'steps=62 in=2621 cache=177955 out=1132 peak=528246');
  check(a && a.scope === 'backend' && a.ok, '取到 scope=backend', JSON.stringify(a && a.scope));
  check(a.values.steps === 62 && a.values.in === 2621 && a.values.cache === 177955 && a.values.out === 1132 && a.values.peak === 528246,
    '五个字段逐字解析', JSON.stringify(a.values));

  const k = tokens.parseTokenEvent('tokens:lead', 'steps=10 in=1k cache=2m out=3');
  check(k.values.in === 1000 && k.values.cache === 2e6, '`k`/`m` 后缀换算', JSON.stringify(k.values));

  check(tokens.parseTokenEvent('role:pm', 'verdict=pass') === null, '非 tokens 族 ⇒ null（不误吃 role 事件）');
  const bad = tokens.parseTokenEvent('tokens:qa', 'input=100 cache_read=200');
  check(bad && bad.ok === false && bad.unknownKeys.length === 2, '字段名写错 ⇒ ok:false 且记下未知键（**不静默**）', JSON.stringify(bad.unknownKeys));
  // 最容易放过的一种：一个字段名写错、其余都对。按"有合法字段就放行"会**静默丢掉**写错那个，
  // 所以契约是「有合法字段 **且** 无未知字段」才算 ok。
  const mixed = tokens.parseTokenEvent('tokens:qa', 'steps=62 in=2 typo_x=5');
  check(mixed && mixed.ok === false, '一个字段写错 + 其余合法 ⇒ **整行判坏**（否则写错的字段会静默少一块）', JSON.stringify({ ok: mixed && mixed.ok, unknown: mixed && mixed.unknownKeys }));
}

console.log('\n② 日志事件：族识别、两种写法、坏行计数');
{
  const log = [
    '- [10:00:01] run:started — 目标',
    '- [10:10:00] tokens:backend — steps=62 in=2621 cache=177955 out=1132 peak=528246',
    '- [10:11:00] tokens:qa — steps=20 in=100 cache=200 out=300',
    '- [10:12:00] role:reviewer — tokens steps=5 in=50 cache=60 out=70',
    '- [10:13:00] tokens:docs — steps=1 typo_x=5',
    '- [10:14:00] role:pm — verdict=pass',
  ].join('\n');
  const { events, broken } = tu.parseTokenLogEvents(log);
  check(events.length === 3, '3 条合法 token 事件被取到（含 `role:… tokens …` 写法）', `实得 ${events.length}`);
  check(events.every((e) => e.source === 'log'), '来源标为 log（与遥测分开计）');
  check(events.find((e) => e.scope === 'reviewer')?.steps === 5, '`role:reviewer — tokens …` 的 scope 取角色名', JSON.stringify(events.map((e) => e.scope)));
  check(broken === 1, '写坏字段名的那行计入 broken（可见）', `broken=${broken}`);
  check(tu.parseTokenLogEvents('').events.length === 0, '空日志 ⇒ 0 事件（不抛）');
}

console.log('\n③ 角色标签与 STATE.members 绑定');
{
  check(tu.roleFromBracketLabel('【测试工程师】T-04：独立验证') === 'qa', '【测试工程师】→ qa', tu.roleFromBracketLabel('【测试工程师】T-04'));
  check(tu.roleFromBracketLabel('【后端工程师】实现 B4') === 'backend', '【后端工程师】→ backend');
  check(tu.roleFromBracketLabel('【产品经理】澄清需求') === 'pm', '【产品经理】→ pm');
  check(tu.roleFromBracketLabel('没有标签的普通文本') === '', '无标签 ⇒ 空串（**不猜**）');
  const map = tu.membersBySession({ members: ['6cae8790-7760-4c92-937d-60eae6f980ba:backend', 'pm:Mia'] });
  check(map.get('6cae8790-7760-4c92-937d-60eae6f980ba') === 'backend', 'sid:role 进 map');
  check(!map.has('pm'), '无 sessionId 的 legacy `role:name` 不进 map（无法归属就不硬塞）');
}

console.log('\n④ 汇总：三个桶、成本占比、缺项与零必须可区分');
{
  const rows = [
    { scope: 'lead', source: 'telemetry', in: 1000, cache: 100000, out: 500, steps: 10, peak: 60000, first: 20000 },
    { scope: 'backend', source: 'telemetry', in: 500, cache: 50000, out: 250, steps: 5, peak: 30000, first: 18000 },
    { scope: 'backend', source: 'telemetry', in: 100, cache: 10000, out: 50, steps: 1, peak: 20000, first: 15000 },
  ];
  const s = tokens.summarizeTokenUsage(rows);
  check(s.totals.in === 1600 && s.totals.cache === 160000 && s.totals.out === 800, '三桶合计', JSON.stringify({ in: s.totals.in, cache: s.totals.cache, out: s.totals.out }));
  check(s.totals.steps === 16 && s.totals.peak === 60000 && s.totals.first === 20000, '步数相加、峰值取最大、首步取最大', JSON.stringify({ steps: s.totals.steps, peak: s.totals.peak, first: s.totals.first }));
  check(s.byScope.length === 2, '同一 scope 的多个会话**合并**（不是重复列两行）', JSON.stringify(s.byScope.map((x) => x.scope)));
  const be = s.byScope.find((x) => x.scope === 'backend');
  check(be.sessions === 2 && be.in === 600 && be.peak === 30000, '合并后带 sessions 计数、峰值取组内最大', JSON.stringify({ sessions: be.sessions, in: be.in, peak: be.peak }));
  const shareSum = s.costShare.in + s.costShare.cache + s.costShare.out;
  check(Math.abs(shareSum - 100) <= 1, '成本占比三桶相加 ≈100%', `${s.costShare.in}+${s.costShare.cache}+${s.costShare.out}=${shareSum}`);
  check(s.byScope[0].scope === 'lead', '按 prompt 总量降序（谁贵谁在前）', s.byScope.map((x) => x.scope).join(','));

  const miss = tokens.summarizeTokenUsage([{ scope: 'x', in: 10, cache: 0, out: 0 }]);
  check(miss.missingSteps === 1 && miss.avgPromptPerStep === null, '缺 steps ⇒ 每步均 prompt 为 **null**（算不出 ≠ 0）', String(miss.avgPromptPerStep));
  check(tokens.summarizeTokenUsage([]).totals.in === 0, '空输入 ⇒ 全 0（不抛）');
}

console.log('\n⑤ 渲染：三种状态必须可区分（有数据 / 写坏了 / 一条都没有）');
{
  const empty = tokens.renderTokenSection({ runs: [] });
  check(/无 token 记账/.test(empty), '空态：写明「无 token 记账」');
  check(/不代表消耗低/.test(empty), '空态：明确「不代表消耗低」（防误读）', '');

  const broken = tokens.renderTokenSection({ runs: [], broken: 3 });
  check(/3 行/.test(broken) && /字段名写错/.test(broken), '写坏态：单列坏行数并点明字段名写错会静默消失');

  const s = tokens.summarizeTokenUsage([
    { scope: 'lead', source: 'telemetry', in: 1000, cache: 200000, out: 500, steps: 20, peak: 90000, first: 20000 },
    { scope: 'qa', source: 'telemetry', in: 100, cache: 20000, out: 60, steps: 3, peak: 30000, first: 19000 },
  ]);
  const html = tokens.renderTokenSection({ runs: [{ name: 'r1', source: 'telemetry', windowBasis: 'marker×2', ...s }], unattributed: 4 });
  check(/## |^>/.test(html), '有数据态：含口径说明');
  check(!/undefined|NaN/.test(html), '渲染结果**不得出现** undefined / NaN（字段写错的兜网）');
  check(/\*\*标记命中 2 个\*\*/.test(html), '归属口径随行渲染（强/弱/未归属三档都写）', (html.match(/会话归属：[^\n]*/) || [''])[0]);
  check(/未归属 4 个/.test(html), '未归属数可见（不埋在备注里）');
  check(/lead/.test(html) && /qa/.test(html), 'scope 明细含 lead 与角色');
  check(/输出 tokens 只占总量的/.test(html), '点明输出占比（"少说点没用"的那个数）');
  const noSteps = tokens.renderTokenSection({ runs: [{ name: 'r2', source: 'log', windowBasis: '日志事件', ...tokens.summarizeTokenUsage([{ scope: 'x', in: 5, cache: 0, out: 0 }]) }] });
  check(/缺 `steps`/.test(noSteps), '缺 steps 时如实标注「算不出」（不显示 0）');
}

console.log('\n⑥ 时间：run 窗口推断（日志优先、目录名兜底、都没有就 null）');
{
  const d = new Date('2026-09-11T23:00:00');   // 目录 mtime
  const w1 = tu.runWindow({ state: { startedAt: '2026-09-10T15:00:00.000Z' }, log: '', dirName: 'x-235644', dirMtimeMs: d.getTime() });
  check(w1.basis === 'STATE.startedAt' && w1.start === Date.parse('2026-09-10T15:00:00.000Z'), 'STATE.startedAt 优先');
  const w2 = tu.runWindow({ state: null, log: '- [13:45:01] run:started — 目标', dirName: 'x', dirMtimeMs: d.getTime() });
  check(w2.basis === 'run:started' && new Date(w2.start).getHours() === 13, '无 state ⇒ 用 run:started 的时刻 + 目录 mtime 的日期', new Date(w2.start).toISOString());
  const w3 = tu.runWindow({ state: null, log: '', dirName: '项目-235644', dirMtimeMs: d.getTime() });
  check(w3.basis === 'dir-name' && new Date(w3.start).getHours() === 23, '再兜底 ⇒ 目录名尾 6 位', new Date(w3.start).toISOString());
  const w4 = tu.runWindow({ state: null, log: '', dirName: '没有时间戳', dirMtimeMs: d.getTime() });
  check(w4.basis === 'none' && w4.start === null, '三种都取不到 ⇒ null（**不猜**）');
  check(tu.clockFromDirName('a-235644')?.h === 23 && tu.clockFromDirName('a-996644') === null, '非法时刻（99 时）⇒ null');
}

console.log('\n⑦ 端到端归属：合成一个「假 DSH_HOME + 真会话文件」，断言标记命中与角色归属');
if (!compressZstd) {
  // 环境缺失不当失败：本段证明的是"真压缩的遥测文件能被读对"，没有压缩器就没有证据可言。
  console.log('  · 跳过：本机既无 Node 内置 zstd（Node < 22.15）也无 zstd CLI，无法生成压缩会话文件。');
} else {
  const root = await mkdtemp(join(tmpdir(), 'dsh-et-token-'));
  const dshHome = join(root, 'dsh');
  const cwd = join(root, 'proj');
  const teamDir = join(cwd, 'team');
  const runId = '演示-run-101010';
  const runDir = join(teamDir, runId);
  await mkdir(runDir, { recursive: true });

  // 会话遥测：slug 目录名按**内容验证**解析（所以这里用真实 slug 形式）
  const slug = su.workspaceSlug(cwd);
  const sessDir = join(dshHome, 'sessions', slug, 'sess-child-1');
  await mkdir(sessDir, { recursive: true });
  const createdAt = Date.parse('2026-09-11T10:00:30.000Z');
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'sess-child-1', createdAt, cwd, delegationDepth: 1, agentPreset: 'expert-team' }),
    JSON.stringify({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `【后端工程师】实现 B1\nrun 目录：${runDir}` }] } }),
    JSON.stringify({ type: 'assistant/message', data: { message: { role: 'assistant', content: [] }, usage: { inputTokens: 2000, cacheReadTokens: 300000, outputTokens: 800, reasoningTokens: 100, totalTokens: 302800 } } }),
    JSON.stringify({ type: 'assistant/message', data: { message: { role: 'assistant', content: [] }, usage: { inputTokens: 500, cacheReadTokens: 320000, outputTokens: 400, reasoningTokens: 50, totalTokens: 320900 } } }),
  ].join('\n') + '\n';
  await writeFile(join(sessDir, 'session.v3.jsonl.zstd'), compressZstd(Buffer.from(lines)));

  await writeFile(join(runDir, 'STATE.json'), JSON.stringify({ runId, phase: 'implement', status: 'running', members: ['sess-child-1:backend'] }, null, 2));
  await writeFile(join(runDir, 'RUN.log.md'), `- [10:00:00] run:started — 目标\n- [10:05:00] tokens:lead — steps=3 in=100 cache=20000 out=50 peak=21000\n`);
  await writeFile(join(runDir, 'TASK.md'), '# 任务\n');

  const inputs = { state: JSON.parse(await readFile(join(runDir, 'STATE.json'), 'utf8')), log: await readFile(join(runDir, 'RUN.log.md'), 'utf8') };
  su.clearSessionCache();
  const res = await tu.collectTokenUsage(teamDir, [runId], async () => inputs, { workspace: cwd, dshHome });
  const r = res.runs[0];
  check(!!r, '该 run 出现在报告里', `runs=${res.runs.length}`);
  check(r?.source === 'telemetry', '遥测优先（有遥测就不叠加日志事件）', String(r?.source));
  check(r?.windowBasis === 'marker×1', '归属依据 = 标记命中（提示词里带 run 目录路径）', String(r?.windowBasis));
  check(r?.totals.in === 2500 && r?.totals.cache === 620000 && r?.totals.out === 1200, '两轮 usage 逐项相加（**usage 在 data 下、user 文本在 data.content**）', JSON.stringify({ in: r?.totals.in, cache: r?.totals.cache, out: r?.totals.out }));
  check(r?.totals.steps === 2, '步数 = 2', String(r?.totals.steps));
  check(r?.totals.first === 302000 && r?.totals.peak === 320500, '首步 prompt 与峰值各自正确（首步 ≠ 峰值）', JSON.stringify({ first: r?.totals.first, peak: r?.totals.peak }));
  check(r?.byScope?.[0]?.scope === 'backend', '角色取名自提示词的【后端工程师】（STATE.members 只是兜底）', String(r?.byScope?.[0]?.scope));
  check(res.broken === 0 && res.unattributed === 0, '读得好时不留坏行/未归属', JSON.stringify({ broken: res.broken, unattributed: res.unattributed }));

  // 会话目录不存在 ⇒ 必须**如实降级**，并且回落到日志事件（而不是报 0）
  su.clearSessionCache();
  const res2 = await tu.collectTokenUsage(teamDir, [runId], async () => inputs, { workspace: join(root, '没有这个工作区'), dshHome });
  const r2 = res2.runs[0];
  check(r2?.source === 'log', '遥测读不到 ⇒ 回落日志事件并**标注来源**', String(r2?.source));
  check(r2?.totals.in === 100 && r2?.totals.steps === 3, '回落后的数是日志里那条 tokens:lead', JSON.stringify({ in: r2?.totals.in, steps: r2?.totals.steps }));
  check(res2.notes.length > 0, '读不到时 notes 非空（原因会被写进报告，不是静默 0）', res2.notes[0] || '');

  // 缺件：既无遥测也无日志 ⇒ 该 run **不进报告**（由空节统一说明"没测到"）
  su.clearSessionCache();
  const res3 = await tu.collectTokenUsage(teamDir, [runId], async () => ({ state: inputs.state, log: '' }), { workspace: join(root, '也没有'), dshHome });
  check(res3.runs.length === 0, '两者都没有 ⇒ 不产出数字（而不是产出 0）', `runs=${res3.runs.length}`);

  await rm(root, { recursive: true, force: true });
}

console.log('');
if (fail > 0) {
  console.log(`✗ token 记账测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ token 记账测试通过（形状/归属/加和/三种空态/端到端回落，均按"读不到就说读不到"的口径）');
