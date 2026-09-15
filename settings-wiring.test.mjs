// 测试：1.3.4「把那 7 项设置真的接上」—— display 4 项 + roster 3 项。
//
// 为什么这个文件必须存在（而不是靠 `settings-consumers.test.mjs`）：棘轮只回答"**有没有**消费者"，
// 回答不了"接得**对不对**"。本文件钉的是语义：
//   · roster：**flag > 设置 > 常量**（`/team` 没给参数时用设置；给了参数一律压过设置），
//     且档位收窄的**基线**要跟着设置走（否则"设了默认班底"会让 `--tier` 静默失效）；
//   · display：轮询间隔/胶囊停留/面板宽度/默认页签**取设置值**，改设置当场生效（不必重启）；
//   · loopGuard 的 getter 语义：同一钩子实例下改设置 ⇒ 行为**翻转**且**无需重建**（今天成立但零护栏，
//     而"看起来即时、其实不即时"正是本版要消灭的那一类）。
//
// 口径（本仓纪律）：能行为级就行为级 —— roster 三项**真跑 `createRun`**（它不依赖 ctx，可离线驱动），
// 画布轮询**真看生成的脚本**；只有浏览器 bundle（`client.js`）里的 display 四项用**源码级**断言，
// 因为本包没有 DOM 环境（不引入 jsdom 这类依赖：零依赖是本包的红线）。
//
// 运行：node settings-wiring.test.mjs

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// 独立 DSH_HOME：settings.json 是"这台机器上这个插件的偏好"，测试**绝不**碰真实 ~/.dsh
const root = await mkdtemp(join(tmpdir(), 'et-wiring-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const WS = join(root, 'ws');
await mkdir(WS, { recursive: true });

const { _live } = await import('./lib/command.js');
const { createLoopGuard } = await import('./lib/loop-guard.js');
const { INERT_SETTINGS, flatSpec } = await import('./lib/settings.js');

const settingsFile = _live.settingsPath();
/** 写一份设置并刷新进程内缓存（等价于 `POST /settings` 成功后的那一步）。 */
async function setSettings(obj) {
  await mkdir(dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify(obj || {}, null, 2));
  _live.loadSettingsSync();
}

const INVOCATION = { rawInput: '', agent: { session: { id: 's-wiring' }, followup() {} } };
/** 真跑一次建 run（`createRun` 不读 ctx ⇒ 传 `{}` 即可离线驱动）。 */
async function createWith(rawInput, settings) {
  await setSettings(settings);
  const mode = _live.parseTeamCommand(rawInput);
  const invocation = { rawInput, agent: INVOCATION.agent };
  // createRun 返回的是**命令结果**（`{kind,text}`），runId 在文本里 —— 从它解析出 run 目录
  const res = await _live.createRun({}, invocation, WS, mode);
  const m = /已组队 run "([^"]+)"/.exec(String(res && res.text ? res.text : ''));
  if (!m) throw new Error('createRun 未返回 runId：' + JSON.stringify(res).slice(0, 300));
  const runDir = join(WS, 'team', m[1]);
  const state = JSON.parse(await readFile(join(runDir, 'STATE.json'), 'utf8'));
  const roster = JSON.parse(await readFile(join(runDir, 'ROSTER.json'), 'utf8'));
  const log = await readFile(join(runDir, 'RUN.log.md'), 'utf8');
  return { mode, res, runId: m[1], runDir, state, roster, log };
}

console.log('# 1.3.4 设置接线（display 4 + roster 3）\n');

console.log('① roster：命令行没给参数 ⇒ 用设置');
{
  const a = await createWith('把登录改成手机号', { roster: { persist: true, deliverable: 'artifacts-only', defaultRoles: ['pm', 'qa'] } });
  check(a.state.mode === 'persist', '设置 `roster.persist=true` ⇒ STATE.mode=persist', a.state.mode);
  check(a.state.deliverable === 'artifacts-only', '设置 `roster.deliverable=artifacts-only` ⇒ STATE.deliverable 跟着走', a.state.deliverable);
  check(JSON.stringify(a.roster.roles) === '["pm","qa"]', '设置 `roster.defaultRoles` ⇒ ROSTER.roles 用它（不再只认常量）', JSON.stringify(a.roster.roles));
  // 启动行必须与 STATE 同源（否则"日志说一套、状态是另一套"）
  const started = (a.log.match(/run:started[^\n]*/) || [''])[0];
  check(/模式=persist/.test(started) && /交付=artifacts-only/.test(started) && /编制=pm,qa/.test(started),
    'RUN.log 的 run:started 与 STATE 同源（设置生效在留痕里也看得见）', started.slice(0, 90));
}

console.log('\n② roster：命令行给了参数 ⇒ 一律压过设置（flag > 设置 > 常量）');
{
  const b = await createWith('--no-code --roles=backend,qa 把登录改成手机号', { roster: { persist: true, deliverable: 'code+artifacts', defaultRoles: ['pm'] } });
  check(b.state.deliverable === 'artifacts-only', '`--no-code` 压过设置（设置是 code+artifacts 也照旧只出工件）', b.state.deliverable);
  check(JSON.stringify(b.roster.roles) === '["backend","qa"]', '`--roles` 压过设置（不点名的才用设置）', JSON.stringify(b.roster.roles));
  check(b.state.mode === 'persist', '没给 `--persist` ⇒ 仍取设置里的 persist=true', b.state.mode);

  const c = await createWith('--persist 把登录改成手机号', { roster: { persist: false } });
  check(c.state.mode === 'persist', '`--persist` 压过设置（设置 false 也照旧持久化）', c.state.mode);
}

console.log('\n③ roster：设置没改时，行为与接线前**完全一致**（默认不打扰）');
{
  const d = await createWith('把登录改成手机号', {});
  check(d.state.mode === 'one-shot', '默认 ⇒ one-shot', d.state.mode);
  check(d.state.deliverable === 'code+artifacts', '默认 ⇒ code+artifacts', d.state.deliverable);
  check(JSON.stringify(d.roster.roles) === JSON.stringify(_live.DEFAULT_ROLES), '默认 ⇒ 常量 DEFAULT_ROLES', `${d.roster.roles.length} 个角色`);
}

console.log('\n④ roster：档位收窄的**基线**跟着设置走（否则设了默认班底会让 --tier 静默失效）');
{
  const wide = ['pm', 'backend', 'qa', 'ui', 'reviewer'];
  const e = await createWith('--tier quick 把登录改成手机号', { roster: { defaultRoles: wide } });
  check(JSON.stringify(e.roster.roles) === '["pm","backend","qa"]',
    '设置了一套宽班底 + `--tier quick` ⇒ 仍被收窄到该档班底（不是原样保留宽班底）', JSON.stringify(e.roster.roles));
  check(e.mode.rolesNarrowedBy === 'quick', '并且如实记录"被档位收窄"', String(e.mode.rolesNarrowedBy));

  const f = await createWith('--tier quick --roles=ui,reviewer 把登录改成手机号', { roster: { defaultRoles: wide } });
  check(JSON.stringify(f.roster.roles) === '["ui","reviewer"]', '用户点名的班底 ⇒ 档位收窄**不**动它（点过名就是点过名）', JSON.stringify(f.roster.roles));
}

console.log('\n⑤ display.pollMs：画布 live 轮询间隔真的来自设置');
{
  await setSettings({ display: { pollMs: 5000 } });
  check(_live.canvasPollMs() === 5000, 'canvasPollMs() 读设置', String(_live.canvasPollMs()));
  const html = _live.watchScript('run-x', '/tmp/ws', _live.canvasPollMs());
  check(html.includes('setInterval(poll, 5000)'), '生成的 live 脚本用 5000ms（此前写死 3000）', '');
  check(!html.includes('setInterval(poll, 3000)'), '脚本里不再有写死的 3000', '');
  await setSettings({ display: { pollMs: 999999 } });
  check(_live.canvasPollMs() === 3000, '越界值 ⇒ 回默认 3000（不把 999999 塞进定时器）', String(_live.canvasPollMs()));
  await setSettings({ display: { pollMs: 0 } });
  check(_live.canvasPollMs() === 3000, '低于下限 ⇒ 回默认 3000', String(_live.canvasPollMs()));
  await setSettings({});
}

console.log('\n⑥ loopGuard：同一钩子实例下改设置 ⇒ 行为翻转，**无需重建钩子**');
{
  const AGENT = { session: { id: 'g1' } };
  const exec = (newStr, file) => ({ name: 'edit', arguments: { file_path: file || 'src/app.js', old_string: 'a', new_string: newStr }, agent: AGENT });
  const accept = async () => ({ kind: 'accept' });
  let enabled = true;
  // 形状与 `lib/command.js` 的接线一致：`enabled` 传**函数**（构造时会被固化成常量的反例见 loop-guard.js 注释）
  const hook = createLoopGuard({ enabled: () => enabled });
  const kinds = [];
  for (const [i, tag] of [['PLAN_A'], ['PLAN_B'], ['PLAN_A'], ['PLAN_B']].entries()) kinds.push((await hook(exec(tag[0]), {}, accept)).kind);
  check(kinds.slice(0, 3).every((k) => k === 'accept') && kinds[3] === 'block', '开关为开时 A→B→A→B ⇒ 阻断', kinds.join(','));

  enabled = false; // 只翻设置，**不**重建钩子
  const kinds2 = [];
  for (const tag of ['PLAN_A', 'PLAN_B', 'PLAN_A', 'PLAN_B']) kinds2.push((await hook(exec(tag), {}, accept)).kind);
  check(kinds2.every((k) => k === 'accept'), '关掉设置后 ⇒ 同一实例立刻全部放行（这就是"无需重建"的证明）', kinds2.join(','));

  enabled = true; // 再打开
  // ⚠️ 换一个文件：守卫对**同一对、同一 agent**只提醒一次（这是它的既有纪律，见 loop-guard.js 头注），
  //    所以"再打开是否即时"必须用一条**新的**振荡链来验证，否则测的是"去重"而不是"开关"。
  const kinds3 = [];
  for (const tag of ['PLAN_A', 'PLAN_B', 'PLAN_A', 'PLAN_B']) kinds3.push((await hook(exec(tag, 'src/other.js'), {}, accept)).kind);
  check(kinds3.some((k) => k === 'block'), '再打开 ⇒ 立刻恢复拦截（换新文件避开"同一对只提醒一次"的去重）', kinds3.join(','));

  const { readFileSync } = await import('node:fs');
  const cmd = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  check(/enabled: \(\) => LOOP_GUARD_ENABLED/.test(cmd), '接线处传的是 getter（不是快照布尔 —— 快照会让"即时生效"变成假话）', '');
}

console.log('\n⑦ display 四项：client.js 真的消费设置（源码级 —— 本包无 DOM，不引依赖）');
{
  const { readFileSync } = await import('node:fs');
  const c = readFileSync(join(here, 'client.js'), 'utf8');
  check(/var EXPERT_DISPLAY = \{ pollMs: 3000, capsuleMs: 4000, panelWidth: 420, defaultTab: 'team' \}/.test(c), '有共享的 display 设置桥（EXPERT_DISPLAY + 默认值与 spec 一致）', '');
  check(/function fetchSettingsPayload\(\)/.test(c) && /function applyDisplaySettings\(settings\)/.test(c), '共享取数/应用函数存在（不再是"每个组件各拉一次"）', '');
  check(/return \{ ok: r\.ok, status: r\.status, d: d \}/.test(c), '设置页 GET 复用同一条路（返回值形状不变）', '');
  // 1.3.5：间隔多了一层**退避**（单发越慢、下次越晚），但基础节奏仍必须来自 display.pollMs，
  // 忙碌加速到 40% 的意图也不变 ⇒ 断言改成「基础间隔的来源 + 退避层」两件事，意图不弱化。
  check(/var base = busy \? Math\.max\(300, Math\.round\(dispCfg\.pollMs \* 0\.4\)\) : dispCfg\.pollMs/.test(c),
    'pollMs：基础轮询间隔取设置（忙碌时按同一意图加速到 40%）', '');
  check(/var backoff = Math\.max\(base, Math\.min\(30000, Math\.round\(\(lastMsRef\.current \|\| 0\) \* 2\)\)\)/.test(c),
    'pollMs：再叠自适应退避（clamp(max(基础, 上次耗时×2), 基础, 30000)）——重活端点不该 1.2s 一发', '');
  check(/load\(\); pollRef\.current = setInterval\(load, dispCfg\.pollMs\)/.test(c), 'pollMs：首轮间隔也取设置', '');
  check(/\}, \[sessionId, selRunV, isOpen, viewMode, dispCfg\.pollMs\]\)/.test(c), 'pollMs：间隔变化会重排定时器（改设置当场生效）', '');
  check(/var ttl = EXPERT_DISPLAY\.capsuleMs[\s\S]{0,200}setTimeout\(function \(\) \{ var i = activityQ\.indexOf\(entry\)/.test(c),
    'capsuleMs：胶囊按设置**自动出队**（该功能此前压根不存在）', '');
  check(/Date\.now\(\) - \(last\.ts \|\| 0\) < 4000/.test(c) && /activityQ\.length > 8/.test(c),
    'capsuleMs：原去重窗口与 8 条截断语义**保持不变**（不把两件事混为一谈）', '');
  check(/panelWidthUserSet = true; saveLS\('et-width', panelWidth\); notify\(\); persistDisplayWidth\(panelWidth\)/.test(c), 'panelWidth：拖动结束把宽度写回设置', '');
  check(/body: JSON\.stringify\(\{ 'display\.panelWidth': w \}\)/.test(c) && /clearTimeout\(widthSaveTimer\)/.test(c),
    'panelWidth：写回是**防抖**的（不是每次 mousemove 都 POST）', '');
  check(/function clampW\(w\) \{ return Math\.max\(280, Math\.min\(900, w\)\) \}/.test(c), 'panelWidth：拖动值域与设置对齐 280..900（此前 640）', '');
  check(/typeof panelWidthLS === 'number' \? panelWidthLS : EXPERT_DISPLAY\.panelWidth/.test(c), 'panelWidth：默认宽度来自设置（localStorage 只作首帧缓存）', '');
  check(/var tab = tabS\[0\] \|\| dispCfg\.defaultTab/.test(c), 'defaultTab：初始页签取设置', '');
  check(/applyDisplaySettings\(res\.d\.settings\)/.test(c), '保存成功后立刻应用（改设置当场生效，不必刷新/重启）', '');
  check(/width:420px;max-width:100vw/.test(c) && /typeof pw === 'number' \? pw : 420/.test(c),
    'CSS 与画布回退宽度都对齐到设置的默认值 420（此前 360）', '');
  check(/function useDisplaySettings\(\)/.test(c) && /useEffect\(function \(\) \{ loadDisplaySettings\(\) \}, \[\]\)/.test(c),
    '取设置是挂载时拉一次（幂等），不在渲染期发请求', '');
}

console.log('\n⑧ 本版目标状态：没有"未接线"的设置项了');
{
  check(Object.keys(INERT_SETTINGS).length === 0, 'INERT_SETTINGS 为空（7 项全部接线）', `登记 ${Object.keys(INERT_SETTINGS).length} 项`);
  const withMark = Object.keys(flatSpec()).filter((p) => (flatSpec()[p].hint || '').includes('暂未生效'));
  check(withMark.length === 0, '设置页没有任何"暂未生效"标注（hint 不再有假承诺）', withMark.join(','));
  check(!/待 1\.3\.\d 接线/.test(JSON.stringify(flatSpec())), '用户可见文案里不再承诺版本号', '');
}

await rm(root, { recursive: true, force: true });
console.log('');
if (fail > 0) {
  console.log(`✗ 设置接线测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 设置接线测试通过（roster 三项行为级 / 画布轮询取设置 / loopGuard getter 无需重建 / display 四项已消费）');
