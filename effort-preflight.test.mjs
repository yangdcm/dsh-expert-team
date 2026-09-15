// 会话模型 reasoningEffort 预检的回归护栏（2026-09-15，1.3.16 D 项）。
//
// 背景（一次真实故障的定性）：用户报 `model "deepseek-flash" does not support reasoning effort "low"`。
// 根因**不在插件、也不在宿主**，而是用户 ~/.dsh/settings.yaml 里会话默认路由（`agent-default-model`）
// 的模型条目**漏写 reasoningEfforts** ⇒ 宿主能力表里该模型只剩 `off` ⇒ **任何**显式 effort 都被拒
// （`dsh-llm` 的 resolveCallWithInfo：reasoning === undefined 时，只要传了 reasoningEffort 就抛）。
// 而本 preset 里 **8 个角色声明 high、4 个声明 low** ⇒ 该路由下 **12 个角色全会失败**；
// "只有 low 报错"是假象（先派谁先报谁）。宿主在任何网络 I/O 之前就拒 ⇒ **插件只能提前告警**。
//
// 本文件钉四件事：① 从**真实 preset** 提取声明（真源，不是抄一份常量）；② 三种能力表形态的判定；
// ③ 告警**只打一次**且**可操作**；④ 读不到/抛错一律**静默 fail-open**（绝不误报、绝不影响加载）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const { declaredEffortsFromPresetSource, effortPreflightPlan, createEffortPreflight, EFFORT_DOMAIN } =
  await import(join(here, 'lib', 'effort-preflight.js'));

console.log('\n① 从**真实 preset** 提取声明（真源；写死常量会与实际分档漂移）');
const presetSrc = readFileSync(join(here, 'presets', 'expert-team', 'agent.cordis.yml'), 'utf8');
const { efforts, counts } = declaredEffortsFromPresetSource(presetSrc);
check(counts.high === 8 && counts.low === 4, 'preset 真实分档 = 8 个 high / 4 个 low（2026-09-15 实测）', JSON.stringify(counts));
check(efforts.includes('low') && efforts.includes('high'), '声明集合含 low 与 high', JSON.stringify(efforts));
check(EFFORT_DOMAIN.join('/') === 'off/low/high/max', '合法值域 = off/low/high/max（与宿主 dsh-llm 一致）', EFFORT_DOMAIN.join('/'));

console.log('\n② 判定矩阵（纯函数）');
const meta = readFileSync(join(here, 'presets', 'expert-team', 'agent.cordis.yml'), 'utf8');
const sel = { provider: 'liang', model: 'deepseek-flash' };
{
  const onlyOff = effortPreflightPlan({ selection: sel, required: efforts, info: { reasoning: { efforts: [{ id: 'off' }], defaultEffort: 'off' } } });
  check(onlyOff.status === 'missing-efforts' && onlyOff.warn === true && onlyOff.missing.sort().join(',') === 'high,low',
    '能力表只有 off ⇒ 告警，且 missing 精确列出 high/low', JSON.stringify(onlyOff.missing));

  const noReasoning = effortPreflightPlan({ selection: sel, required: efforts, info: {} });
  check(noReasoning.status === 'no-reasoning-support' && noReasoning.warn === true,
    'reasoning 缺失（宿主语义=不支持任何 effort）⇒ 告警', noReasoning.status);

  const covered = effortPreflightPlan({ selection: sel, required: efforts, info: { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }], defaultEffort: 'off' } } });
  check(covered.status === 'ok' && covered.warn === false, '能力表覆盖 low+high ⇒ **一声不吭**（正常环境不许误报）', covered.status);

  const noRoute = effortPreflightPlan({ selection: null, required: efforts, info: covered });
  check(noRoute.status === 'no-route' && noRoute.warn === false, '拿不到默认路由 ⇒ 静默（不假装知道）', noRoute.status);

  const unknown = effortPreflightPlan({ selection: sel, required: efforts, infoError: new Error('boom') });
  check(unknown.status === 'unknown' && unknown.warn === false, '读能力表抛错 ⇒ 静默 fail-open（绝不因此影响加载）', unknown.status);

  const noRequire = effortPreflightPlan({ selection: sel, required: [], info: covered });
  check(noRequire.status === 'no-preset-efforts' && noRequire.warn === false, 'preset 没声明 effort ⇒ 无事可做、静默', noRequire.status);
  check(meta.includes('reasoningEffort:'), '（供核对）preset 源里确实有 reasoningEffort 行', '');
}

console.log('\n③ 播报：一行、可操作、只打一次');
{
  const warns = [];
  const pf = createEffortPreflight({
    readPresetSource: async () => presetSrc,
    readSelection: () => sel,
    readModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }], defaultEffort: 'off' } }),
    warn: (line) => warns.push(line),
    onEvent: () => {},
  });
  const r1 = await pf({ get: () => null }, { isLast: true });
  const r2 = await pf({ get: () => null }, { isLast: true });
  check(r1.warn === true && warns.length === 1, '同一进程**只播报一次**（第二次直接返回已处理）', 'warns=' + warns.length);
  check(r2.status === 'already-done', '第二次调用走 already-done 分支（不再打扰）', r2.status);
  const line = warns[0] || '';
  check(line.includes('agent-default-model') && line.includes('reasoningEfforts') && line.includes('off/low/high/max'),
    '提示**可操作**：点明要改哪个命名空间、哪个字段、合法值域', line.slice(0, 110) + '…');
  check(line.includes('8 个用 high') || line.includes('4 个用 low'), '提示带上 preset 的真实分档（用户能对上号）', '');
  check((line.match(/\n/g) || []).length === 0, '提示是**一行**（不刷屏）', '');
}

console.log('\n④ fail-open：读不到就静默（绝不误报、绝不影响加载）');
{
  const warns = [];
  const mk = (over) => createEffortPreflight(Object.assign({
    readPresetSource: async () => presetSrc,
    readSelection: () => sel,
    readModelInfo: async () => { throw new Error('llm 不可用'); },
    warn: (l) => warns.push(l),
  }, over));
  await mk({}) ({ get: () => null }, { isLast: true });
  check(warns.length === 0, 'llm 抛错 ⇒ 静默', 'warns=' + warns.length);
  await mk({ readSelection: () => null })({ get: () => null }, { isLast: true });
  check(warns.length === 0, '拿不到路由 ⇒ 静默', 'warns=' + warns.length);
  await mk({ readPresetSource: async () => { throw new Error('preset 读不到') } })({ get: () => null }, { isLast: true });
  check(warns.length === 0, 'preset 读不到 ⇒ 静默（不因探测把插件搞挂）', 'warns=' + warns.length);
  const covered = await mk({ readModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } }) })({ get: () => null }, { isLast: true });
  check(covered.status === 'ok' && warns.length === 0, '正常环境（覆盖 low/high）⇒ **零告警**', covered.status);
}

console.log('\n⑤ 接线：apply() 里挂了预检，且只告警不阻断');
{
  const cmdSrc = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  check(/scheduleEffortPreflight\(ctx\);/.test(cmdSrc), 'apply() 里真的调了 `scheduleEffortPreflight(ctx)`', '');
  check(/ctx\.inject\(\[svc\], \(\) => \{ void EFFORT_PREFLIGHT/.test(cmdSrc), '服务晚挂 ⇒ 事件驱动重探（llm/agentDefaultModel 任一出现即重探）', '');
  check(/agentDefaultModel.*currentSelection|currentSelection\(\)/.test(cmdSrc), '走宿主公开读法 `agentDefaultModel.currentSelection()`（不自己解析 YAML）', '');
  check(/llm.*resolveModelInfo|resolveModelInfo\(provider, model\)/.test(cmdSrc), '走宿主公开读法 `llm.resolveModelInfo()`（不猜能力表）', '');
  const pfSrc = readFileSync(join(here, 'lib', 'effort-preflight.js'), 'utf8');
  check(!/kind:\s*'deny'/.test(pfSrc) && !/kind:\s*'block'/.test(pfSrc), '预检模块里**没有**任何阻断返回（"只告警"写进代码）', '');
  check(/不阻断|只告警/.test(pfSrc), '模块头写明"只告警、不阻断、不改 preset 分档"的纪律', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ effort 预检护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ effort 预检通过（真源分档 / 判定矩阵 / 只报一次且可操作 / fail-open 静默 / 只告警不阻断）');
