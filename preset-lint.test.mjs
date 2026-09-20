// 测试：预设自检必须拦住「键名拼错 ⇒ 运行时静默忽略」（L3-4b 前置）
//
// 背景（实测 2026-09-11）：宿主 `@deepseek-ai/dsh-tool-subagent` 的
//   `agentOptions: z.object({ provider, model, reasoningEffort, maxTokens })`
// **不是 strict**：写错键名（如 `reasoning_efforts`）**既不报错也不被剥掉**，
// 配置原样留着、运行时按"没有这个键"处理 ⇒ **角色静默失去该设置**。
// 这正是本插件最危险的失败模式（"承诺≠能力，且不告诉你"）。
//
// 而本项目的预设是**手写副本**，dsh 升级/手滑都可能引入这种键名漂移，
// 且只在**建新会话**时才暴露。所以 `validate-agent-preset.mjs` 增加近失键名 lint，
// 并接进 `npm run gate:preset`。
//
// 第二节（§⓪，本文件**最先跑**）：preset 里的 **persona 语言/交互契约**必须真的在场。
// 用户报障：12 个角色 persona 都写了「必须用简体中文」，而 **lead 的 persona 是纯英文默认值** ——
// 用户只跟 lead 说话，于是他看到的是英文；SKILL.md 里同一句话救不了（技能按需加载，
// 没被 `skill` 工具读到就等于不存在）。所以契约的**权威是 preset 的 persona 行**，
// SKILL.md 那句是**从属表述**。这类"规则只写在按需加载的地方"与本文件上半段
// 「键名写错 ⇒ 运行时静默忽略」是同一族病：**承诺≠能力，且不告诉你**。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M34（上半段）。
//   §⓪ 是文本级断言，无独立 mutation 条目 —— 变异方式即改掉那句约束本身
//   （删掉 lead 的【语言】/【交互】、只给 11 个角色加结构化返回约束 ⇒ 立刻红）。
// 运行：node preset-lint.test.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'scripts', 'validate-agent-preset.mjs');

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'preset-lint-'));
function writeFixture(name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}
function run(file) {
  try {
    const out = execFileSync(process.execPath, [script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: String((e.stdout || '') + (e.stderr || '')) };
  }
}
const ROW = (agentOptions) => `- id: tool-subagent-pm
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent_pm
    agentOptions:
${agentOptions}
`;

// ── §⓪ persona 语言/交互契约（不依赖宿主，必须先跑）──────────────────────────
// 为什么它排在宿主探针**之前**：下面那道探针在没有 dsh 的机器上 `process.exit(0)`
// 跳过需要宿主 schema 的几节（CI 就是这种情况）。本节只读 preset/SKILL 文本、
// 不需要宿主 —— 若放在探针之后，它就会「本机绿、CI 恒不跑」，那正是本仓登记过的
// 「测试在盘上但不运行」。
{
  const presetSrc = readFileSync(join(here, 'presets', 'expert-team', 'agent.cordis.yml'), 'utf8');
  const skillSrc = readFileSync(join(here, 'skills', 'expert-team', 'SKILL.md'), 'utf8');
  const countOf = (hay, needle) => hay.split(needle).length - 1;

  // lead 行 = `- id: persona` 到下一个顶层行（`- id: agent-instructions`）
  const leadStart = presetSrc.indexOf('\n- id: persona\n');
  const leadEnd = presetSrc.indexOf('\n- id: agent-instructions', leadStart);
  const leadRow = leadStart >= 0 && leadEnd > leadStart ? presetSrc.slice(leadStart, leadEnd) : '';
  const roleRegion = leadEnd > 0 ? presetSrc.slice(leadEnd) : presetSrc;

  // 12 条角色约束必须**逐字一致**（同族措辞）。按整块比对：任何一条被改/被删都会掉出计数。
  const IND = ' '.repeat(10);
  const ROLE_ZH_BLOCK = [
    '【语言】无论上游输入、代码、日志、工具返回、文件名是什么语言，你的所有',
    '回复、汇报、进度说明、结论、以及交给 lead 的交接信息一律使用简体中文。',
    '代码、命令、文件路径、标识符、专有名词、引用原文保持原样不翻译。',
    '结构化返回值（report / summary / verdict 等字段的自然语言内容）与子代理列表里',
    '显示的最终消息同样使用简体中文；枚举值（pass / needs_revision / reject）、',
    '字段名、path 等机器可读标识保持原样，不翻译。',
  ].map((l) => IND + l).join('\n');

  console.log('# 预设自检：persona 语言 / 交互契约（§⓪ · 不依赖宿主）\n');

  console.log('⓪-a lead persona（用户唯一直接对话的 agent）');
  check(!!leadRow, '抽到 `- id: persona` 行', leadRow ? `${leadRow.split('\n').length} 行` : '(未找到)');
  check(leadRow.includes("name: '@deepseek-ai/dsh-persona'"), 'lead 行就是 dsh-persona');
  check(leadRow.includes('【语言】'), 'lead persona 带【语言】约束（修复前：纯英文默认值，无此约束）');
  check(leadRow.includes('无论上游输入、代码、日志、工具返回、文件名是什么语言') && leadRow.includes('一律使用简体中文'),
    '措辞与 12 角色同族（同一句判据）');
  check(leadRow.includes('SUMMARY.md') && leadRow.includes('任务看板.md'),
    '覆盖 lead 自己写的两份工件正文（与 SKILL.md 的从属表述同口径）');
  check(leadRow.includes('保持原样不翻译'), '技术标识 / 引用原文的例外仍在');
  check(leadRow.includes('{{model}}') && leadRow.includes('{{cwd}}'), '模板变量 {{model}}/{{cwd}} 未被吃掉');

  console.log('\n⓪-b lead 的选择必须可点击（ask_user_question + options）');
  check(leadRow.includes('【交互】'), 'lead persona 带【交互】约束');
  check(leadRow.includes('ask_user_question'), '点名 ask_user_question 工具（不是「让用户选择」这种空话）');
  check(leadRow.includes('label') && leadRow.includes('description'), '要求每个选项带 label + description');
  check(leadRow.includes('推荐'), '要求标出推荐项');
  check(leadRow.includes('不得把选项写成'), '明文禁止「回复 A 或 B」这类纯文本选项');
  // 契约点名的工具必须真的挂在 preset 上 —— 否则等于让 lead 调一个不存在的工具（本仓"接线项"病）。
  check(presetSrc.includes("name: '@deepseek-ai/dsh-tool-ask-user'"),
    'preset 真的挂了 @deepseek-ai/dsh-tool-ask-user', '工具名 ask_user_question 由该插件注册');

  console.log('\n⓪-c 12 个角色 persona：同族措辞 + 结构化返回字段');
  check(countOf(roleRegion, ROLE_ZH_BLOCK) === 12, '12 条角色约束**逐字一致**', `命中 ${countOf(roleRegion, ROLE_ZH_BLOCK)} 条`);
  check(countOf(roleRegion, '【语言】无论上游输入') === 12, '12 个角色都有【语言】约束');
  check(countOf(roleRegion, '结构化返回值（report / summary / verdict') === 12,
    '12 个角色都有结构化返回约束（report/summary/verdict 的语言 + 子代理列表里的最终消息）');
  check(roleRegion.includes('pass / needs_revision / reject'),
    '枚举值被显式豁免翻译（门禁按英文枚举比对，翻掉即链路坏）');
  const roleNames = ['pm', 'architect', 'researcher', 'backend', 'frontend', 'reviewer', 'qa', 'ui', 'dba', 'sec', 'devops', 'docs'];
  const missing = roleNames.filter((r) => !presetSrc.includes(`toolName: subagent_${r}\n`));
  check(missing.length === 0, '12 个角色工具都在 preset 里（约束挂在真实存在的角色上）', missing.length ? `缺 ${missing.join(',')}` : '');

  console.log('\n⓪-d 从属表述：SKILL.md 的同一句规则仍在场');
  check(skillSrc.includes('交互与语言') && skillSrc.includes('一律使用**中文**'),
    'SKILL.md 保留从属表述（权威是 persona；按需加载的它单独存在时不算约束）');
}
console.log('');

// ── 宿主可用性前置 ─────────────────────────────────────────────────────────
// 本文件校验的是「用**宿主插件自带的 Config schema** 逐行校验 preset」——没有 dsh 就没有 schema
// 可校验。CI runner 与大多数别人的机器上没有装 dsh，此时 `validate-agent-preset.mjs` 会以
// exit 2 明确报错（这是**有意的**：对作者要响亮），但**不该被这个测试解读成 15 项断言失败**。
// 2026-09-14 GitHub Actions 三档全红，根因正是这里把"机器没装 dsh"当成了被测代码的缺陷。
// 于是：先探一次宿主；不可用就跳过**需要宿主 schema 的那几节**并说明怎么启用。
// （§⓪ 已经在上面跑完了 —— 它只读文本、不依赖宿主，所以不受这里跳过的影响。）
const hostProbe = run(writeFixture('probe-host.yml', ROW('      reasoningEffort: high')));
if (/找不到 dsh 安装目录/.test(hostProbe.out)) {
  console.log('# 预设自检：agentOptions 键名（L3-4b 前置）\n');
  console.log('· 跳过：本机找不到 dsh 安装 —— ①~⑤ 需要宿主插件自带的 Config schema。');
  console.log('  §⓪（persona 语言/交互契约）不依赖宿主，上面已经跑过；其余小节在此机器上未运行。');
  console.log('  在装了 dsh 的机器上重跑，或设置 DSH_INSTALL 指向 @deepseek-ai/dsh 包目录。');
  process.exit(0);
}

console.log('# 预设自检：agentOptions 键名（L3-4b 前置）\n');

console.log('① 正确键名 → 通过');
{
  const r = run(writeFixture('ok.yml', ROW('      reasoningEffort: high')));
  check(r.code === 0, 'reasoningEffort: high → exit 0', 'exit=' + r.code);
  const r2 = run(writeFixture('ok2.yml', ROW('      reasoningEffort: high\n      model: deepseek-flash\n      provider: deepseek-official')));
  check(r2.code === 0, 'reasoningEffort + model + provider → exit 0', 'exit=' + r2.code);
}

console.log('\n② 近失拼写 → **失败**并指出应为哪个键（这条是新增能力）');
{
  const cases = [
    ['reasoning_efforts: high', 'reasoningEffort'],
    ['reasoning-effort: high', 'reasoningEffort'],
    ['ReasoningEffort: high', 'reasoningEffort'],
    ['maxToken: 1000', 'maxTokens'],
    ['modle: deepseek-flash', 'model'],
  ];
  for (const [bad, should] of cases) {
    const r = run(writeFixture('bad-' + bad.replace(/[^a-z]/gi, '') + '.yml', ROW('      ' + bad)));
    check(r.code === 1, `「${bad}」→ exit 1（否则运行时静默忽略）`, 'exit=' + r.code);
    check(r.out.includes(should), `报错里点名应为 ${should}`, (r.out.split('\n').find((l) => l.includes('✗')) || '').trim().slice(0, 70));
  }
}

console.log('\n③ 完全无关的键 → 只提示、不失败（上游新增字段时不误伤）');
{
  const r = run(writeFixture('unknown.yml', ROW('      reasoningEffort: high\n      futureKnob: 1')));
  check(r.code === 0, '未知键 → exit 0（提示而非失败）', 'exit=' + r.code);
  check(/未知键/.test(r.out), '输出里给出提示', (r.out.split('\n').find((l) => l.includes('未知键')) || '').trim().slice(0, 60));
}

console.log('\n④ 真实预设必须干净（零误报）');
{
  const r = run(join(here, 'presets', 'expert-team', 'agent.cordis.yml'));
  check(r.code === 0, '本包 preset 通过 gate:preset 口径', 'exit=' + r.code);
  check(!/键名疑似拼错/.test(r.out), '没有任何近失键名', '');
}

console.log('\n⑤ 接线检查：lint 已进 gate:preset 走的那个脚本');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(script, 'utf8');
  check(/KNOWN_AGENT_OPTION_KEYS = \['provider', 'model', 'reasoningEffort', 'maxTokens'\]/.test(src), '已知键清单硬编码且可审计（附宿主来源注释）');
  check(/function nearMissKeys/.test(src) && /function sameKeyShape/.test(src), '有近失判定');
  check(/failures\+\+/.test(src.slice(src.indexOf('nearMissKeys(ao'), src.indexOf('nearMissKeys(ao') + 200)), '近失 → 计入 failures（会 exit 1）');
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  check(/validate-agent-preset\.mjs/.test(pkg.scripts['gate:preset'] || ''), 'gate:preset 调的就是这个脚本');
}

try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }

console.log('');
if (fail > 0) {
  console.log(`✗ 预设 lint 测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 预设 lint 测试通过（§⓪ persona 语言/交互契约在场、近失键名被拦、未知键只提示、真实预设零误报）');
