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
// 变异验证：见 `regression.fixtures/mutations.json` 的 M34。
// 运行：node preset-lint.test.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
console.log('✔ 预设 lint 测试通过（近失键名被拦、未知键只提示、真实预设零误报）');
