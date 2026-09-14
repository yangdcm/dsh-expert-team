// 测试：F 线 **设置控制台**（`lib/settings.js` + `GET/POST /settings` + 接进上限/档位门）
//
// 需求原文（另一个会话，逐字）：「插件需要一个控制台设置页面…把常用的参数可视化配置加上」。
// 这是那个计划的**第 1/2 项**（纯 host 侧）：spec 真源 + 路由 + 接进既有解析。
//
// 三条钉死的东西：
//   ① **全有或全无**：任何一项非法 ⇒ 整体拒绝**且不写盘** —— 半套生效的设置比报错更难排查；
//   ② **优先级不许乱**：`config > env > 设置 > 内置默认`（设置是"用户偏好"，不该压过部署方的显式配置）；
//   ③ **坏设置不许让插件挂掉**：磁盘上手改坏的值 ⇒ 按默认处理并**如实上报 repairs**。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M118**。
// 运行：node settings.test.mjs

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_SPEC, SETTINGS_GROUPS, defaultSettings, flatSpec, getSetting, validateValue, mergeSettings, normalizeSettings, settingsSchema } from './lib/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# F 线 · 设置控制台\n');

console.log('① spec 与默认值（UI 表单结构也由它生成 ⇒ 新增设置项只改一处）');
{
  const d = defaultSettings();
  check(SETTINGS_GROUPS.join(',') === 'identity,roster,display,gates', '四组：身份 / 编制 / 显示 / 门禁', SETTINGS_GROUPS.join(','));
  check(Object.keys(flatSpec()).length === 18, '共 18 个设置项（4+5+4+5；原 4+5+4+7 里的两条台账/规格边界开关已删除 —— 它们的行为本就无条件强制，做成开关是安全回退）', String(Object.keys(flatSpec()).length));
  check(d.roster.maxTasks === 200 && d.gates.tierGate === 'soft' && d.identity.profile === 'developer', '默认值符合既有行为（maxTasks=200 / 档位门 soft / 身份 developer）');
  const schema = settingsSchema();
  check(schema.length === 4 && schema.every((g) => g.label && g.hint && g.items.length), 'schema 每组都有中文标签与说明', schema.map((g) => `${g.group}:${g.items.length}`).join(' '));
  check(schema.flatMap((g) => g.items).every((i) => i.path.includes('.') && i.label && typeof i.default !== 'undefined'), '每个设置项都有 path/label/default（UI 直接渲染）');
  check(getSetting(d, 'roster.maxTasks') === 200 && getSetting(d, 'nope.nope') === undefined, 'getSetting 取默认、未知项 undefined');

  // 1.3.2：枚举项的**中文标签**（规格层单一真源）。标签只影响可读性 ⇒ **值域/类型/默认值不许变**，
  // 但必须"每个值都有标签"，否则下拉里会露出英文标识（这正是本次要修的）。
  const enums = schema.flatMap((g) => g.items).filter((i) => i.type === 'enum');
  check(enums.length === 5, '恰好 5 个枚举项（新增枚举项时这条会提醒你同时补标签断言面）', String(enums.length));
  for (const it of enums) {
    const vals = (it.values || []).slice().sort();
    const keys = Object.keys(it.labels || {}).sort();
    check(keys.join(',') === vals.join(','), `\`${it.path}\` 的 labels 与 values **集合相等**（多一个少一个都红）`, `values=${vals.join('/')} labels=${keys.join('/')}`);
    check(vals.every((v) => typeof (it.labels || {})[v] === 'string' && it.labels[v].trim().length > 0), `\`${it.path}\` 每个值都有非空中文标签`, JSON.stringify(it.labels));
  }
}

console.log('\n② 单值校验：类型 / 值域 / 两个经典陷阱');
{
  check(validateValue('roster.maxTasks', 10).ok && validateValue('roster.maxTasks', '10').value === 10, 'int 接受 number 与数字串');
  check(!validateValue('roster.maxTasks', -1).ok && !validateValue('roster.maxTasks', 1.5).ok && !validateValue('roster.maxTasks', 'abc').ok, 'int 拒绝负数/小数/非数字');
  check(!validateValue('roster.maxTasks', null).ok && !validateValue('roster.maxTasks', '').ok, '**`null` / `""` 被拒绝**（不能当成 0 —— 那会把"未设置"变成"禁止一切"）');
  check(validateValue('gates.tierGate', 'hard').ok && !validateValue('gates.tierGate', '涡轮档').ok, 'enum 只认值域内的值');
  check(validateValue('identity.offerDecideForMe', true).ok && !validateValue('identity.offerDecideForMe', 'true').ok, 'bool 只认真布尔（字符串 `"true"` 拒绝，避免"看着像开了其实没开"）');
  check(validateValue('roster.defaultRoles', null).ok && validateValue('roster.defaultRoles', ['pm', 'qa']).value.join(',') === 'pm,qa', 'roles 接受 null（= 按档位默认）或非空数组');
  check(!validateValue('roster.defaultRoles', []).ok && !validateValue('roster.defaultRoles', ['']).ok, 'roles 拒绝空数组与空串元素');
  check(!validateValue('roster.nonexistent', 1).ok, '未知项被拒绝（打错字不许"保存成功"）');
}

console.log('\n③ 合并：全有或全无（非法补丁整体拒绝）');
{
  const d = defaultSettings();
  const ok = mergeSettings(d, { roster: { maxTasks: 10 }, 'identity.profile': 'non-technical' });
  check(ok.ok && ok.value.roster.maxTasks === 10 && ok.value.identity.profile === 'non-technical', '嵌套与扁平补丁都支持');
  const bad = mergeSettings(d, { roster: { maxTasks: 10, maxMembers: -3 } });
  check(!bad.ok && bad.errors.length === 1, '**一项非法 ⇒ 整体拒绝**（合法的 maxTasks 也不生效）', bad.errors[0]);
  check(bad.value.roster.maxTasks === 200, '被拒绝时返回的是**原值**（调用方据此不写盘）');
  check(!mergeSettings(d, { roster: { nope: 1 } }).ok, '未知键 ⇒ 拒绝');
  check(!mergeSettings(d, { nosuchgroup: { a: 1 } }).ok, '未知分组 ⇒ 拒绝');
  check(!mergeSettings(d, 'not-an-object').ok, '补丁不是对象 ⇒ 拒绝');
  const multi = mergeSettings(d, { roster: { maxTasks: 'x' }, gates: { tierGate: 'y' } });
  check(multi.errors.length === 2, '多个错误一次全报（不让人试一次改一个）', String(multi.errors.length));
}

console.log('\n④ 坏磁盘值 ⇒ 按默认处理并如实上报（不许让插件挂掉）');
{
  const { settings, repaired } = normalizeSettings({ roster: { maxTasks: -5 }, gates: { tierGate: '涡轮档' }, identity: { profile: 'developer' } });
  check(settings.roster.maxTasks === 200 && settings.gates.tierGate === 'soft', '越界/非法值回默认');
  check(settings.identity.profile === 'developer', '合法值原样保留');
  check(repaired.length === 2 && repaired.every((r) => r.path && 'from' in r && 'to' in r), 'repairs 逐条记下「哪一项、从什么、改成什么」', JSON.stringify(repaired.map((r) => r.path)));
  check(normalizeSettings(null).settings.roster.maxTasks === 200, '文件内容为 null ⇒ 全默认（不抛）');
  check(normalizeSettings({ 未知组: 1 }).repaired.length === 0, '未知分组被忽略（不报错也不采纳）');
}

// ── 路由与接线：需要真实 apply（读 $DSH_HOME/expert-team/settings.json）────────────────
console.log('\n⑤ 路由：GET 读 / POST 写（非法补丁**不写盘**）');
const root = await mkdtemp(join(tmpdir(), 'dsh-et-settings-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const { apply, _live } = await import(join(here, 'lib', 'command.js'));
const settingsFile = _live.settingsPath();
let settingsHandler = null;
apply({
  commands: { register: () => {} },
  on: () => {},
  get: () => undefined,
  inject: (deps, f) => {
    if (String(deps) !== 'webServer') return;
    f({ effect: (fn) => { fn(); }, webServer: { register: (c) => { if (String(c.path).endsWith('/settings')) settingsHandler = c.handler; return () => {}; } } });
  },
});
check(typeof settingsHandler === 'function', '`/settings` 路由已注册（走 withRoute 共享件）');
const call = async (method, body) => {
  const out = { code: 0, text: '' };
  await settingsHandler({ method, url: '/plugins/dsh-expert-team/settings', body: body ? JSON.stringify(body) : undefined }, { writeHead: (c) => { out.code = c; }, end: (b) => { out.text = String(b || ''); } });
  return { code: out.code, json: (() => { try { return JSON.parse(out.text); } catch { return null; } })() };
};
{
  const g = await call('GET');
  check(g.code === 200 && g.json.ok && g.json.settings.roster.maxTasks === 200, 'GET 返回当前设置', JSON.stringify(g.code));
  check(Array.isArray(g.json.schema) && g.json.schema.length === 4, 'GET 同时返回 schema（UI 不必自己写死表单）');
  check(g.json.path === settingsFile, 'GET 如实告知设置文件路径（可审计）');

  const p = await call('POST', { roster: { maxTasks: 12 } });
  check(p.code === 200 && p.json.ok && p.json.settings.roster.maxTasks === 12, 'POST 合法补丁 ⇒ 200');
  check(p.json.needsRestart === false, '改动 `编制` ⇒ **不需要重启**（上限/轮次/档位门/振荡开关都由 reapplySettingsDerived() 当场重算；此前那句"要重启"是假话）');
  const onDisk = JSON.parse(await readFile(settingsFile, 'utf8'));
  check(onDisk.roster.maxTasks === 12, '**真的落盘**了', String(onDisk.roster.maxTasks));

  const bad = await call('POST', { roster: { maxTasks: -1 } });
  check(bad.code === 400 && Array.isArray(bad.json.errors) && bad.json.errors.length === 1, 'POST 非法补丁 ⇒ 400 + 原因', JSON.stringify(bad.json && bad.json.errors));
  const after = JSON.parse(await readFile(settingsFile, 'utf8'));
  check(after.roster.maxTasks === 12, '**被拒绝时磁盘未变**（半套生效是最难排查的状态）');

  const disp = await call('POST', { display: { pollMs: 5000 } });
  check(disp.code === 200 && disp.json.needsRestart === false, '改动 `显示` ⇒ 不需要重启（⚠️ 但 `display.*` 目前**只有存储层、没有消费者**，已在 hint 上如实标注「暂未生效」，待 1.3.3 接线）');

  const put = await call('PUT');
  check(put.code === 405, '方法不在名单 ⇒ 405（与既有 9 条路由逐字一致）', String(put.code));
}

console.log('\n⑥ 接线：设置真的影响既有解析（且优先级不许乱）');
{
  // 直接改盘上的设置，再 apply 一次 —— 复现"重启后生效"的真实路径
  await writeFile(settingsFile, JSON.stringify({ roster: { maxTasks: 7 }, gates: { tierGate: 'hard', maxReviewRounds: 5 } }, null, 2));
  const savedEnv = { maxTasks: process.env.DSH_EXPERT_TEAM_MAX_TASKS, tierGate: process.env.DSH_EXPERT_TEAM_TIER_GATE };
  delete process.env.DSH_EXPERT_TEAM_MAX_TASKS;
  delete process.env.DSH_EXPERT_TEAM_TIER_GATE;
  apply({ commands: { register: () => {} }, on: () => {}, get: () => undefined, inject: () => {} });
  check(_live.LIMITS.maxTasks === 7, '`roster.maxTasks` 进了容量上限', String(_live.LIMITS.maxTasks));
  check(_live.ROUND_LIMITS.maxReviewRounds === 5, '`gates.maxReviewRounds` 进了轮次上限', String(_live.ROUND_LIMITS.maxReviewRounds));
  check(_live.effectiveTierGate() === 'hard', '`gates.tierGate` 进了档位门', _live.effectiveTierGate());

  // env 赢过设置
  process.env.DSH_EXPERT_TEAM_MAX_TASKS = '9';
  process.env.DSH_EXPERT_TEAM_TIER_GATE = 'soft';
  apply({ commands: { register: () => {} }, on: () => {}, get: () => undefined, inject: () => {} });
  check(_live.LIMITS.maxTasks === 9, 'env 赢过设置（maxTasks=9）', String(_live.LIMITS.maxTasks));
  check(_live.effectiveTierGate() === 'soft', 'env 赢过设置（档位门回 soft）', _live.effectiveTierGate());

  // config 赢过 env 与设置
  apply({ commands: { register: () => {} }, on: () => {}, get: () => undefined, inject: () => {} }, { limits: { maxTasks: 11 }, tierGate: 'hard' });
  check(_live.LIMITS.maxTasks === 11, 'config 赢过 env 与设置（maxTasks=11）', String(_live.LIMITS.maxTasks));
  check(_live.effectiveTierGate() === 'hard', 'config 赢过 env（档位门 hard）', _live.effectiveTierGate());

  // 1.3.2：**振荡检测开关**此前只读 `config.loopGuard.enabled` ⇒ 设置页那个复选框是空转的。
  // 接线后按同一套优先级：config > env > 设置 > 默认(on)。
  {
    const savedLoop = { env: process.env.DSH_EXPERT_TEAM_LOOP_GUARD };
    delete process.env.DSH_EXPERT_TEAM_LOOP_GUARD;
    await writeFile(settingsFile, JSON.stringify({ gates: { loopGuard: false } }, null, 2));
    apply({ commands: { register: () => {} }, on: () => {}, get: () => undefined, inject: () => {} });
    check(_live.effectiveLoopGuard() === false, '设置里关掉 `gates.loopGuard` ⇒ 真的关掉（此前设置值从不被读）', String(_live.effectiveLoopGuard()));
    check(_live.resolveLoopGuard({}, { loopGuard: true }) === true, '设置里打开 ⇒ 真的打开', String(_live.effectiveLoopGuard()));

    process.env.DSH_EXPERT_TEAM_LOOP_GUARD = 'true';
    check(_live.resolveLoopGuard({}, { loopGuard: false }) === true, 'env 赢过设置（`=true` ⇒ on）', String(_live.effectiveLoopGuard()));
    process.env.DSH_EXPERT_TEAM_LOOP_GUARD = 'off';
    apply({ commands: { register: () => {} }, on: () => {}, get: () => undefined, inject: () => {} });
    check(_live.effectiveLoopGuard() === false, "env 的 `off` 也认（布尔开关容错 `false`/`0`/`off`）", String(_live.effectiveLoopGuard()));

    check(_live.resolveLoopGuard({ loopGuard: { enabled: true } }, { loopGuard: false }) === true, 'config 赢过 env 与设置', String(_live.effectiveLoopGuard()));
    delete process.env.DSH_EXPERT_TEAM_LOOP_GUARD;   // 先清 env（它按设计压过设置值），再验"非法值回默认"
    check(_live.resolveLoopGuard({}, { loopGuard: '也许吧' }) === true, '非法值一律回默认 on（不猜不报错）', String(_live.effectiveLoopGuard()));

    if (savedLoop.env === undefined) delete process.env.DSH_EXPERT_TEAM_LOOP_GUARD; else process.env.DSH_EXPERT_TEAM_LOOP_GUARD = savedLoop.env;
    _live.resolveLoopGuard({}, { loopGuard: true });
  }

  // 复位：清掉 env 与盘上的设置，别污染同一进程里的后续断言
  if (savedEnv.maxTasks === undefined) delete process.env.DSH_EXPERT_TEAM_MAX_TASKS; else process.env.DSH_EXPERT_TEAM_MAX_TASKS = savedEnv.maxTasks;
  if (savedEnv.tierGate === undefined) delete process.env.DSH_EXPERT_TIER_GATE; else process.env.DSH_EXPERT_TIER_GATE = savedEnv.tierGate;
  await writeFile(settingsFile, JSON.stringify(defaultSettings(), null, 2));
  apply({ commands: { register: () => {} }, on: () => {}, get: () => undefined, inject: () => {} });
  check(_live.LIMITS.maxTasks === 200 && _live.effectiveTierGate() === 'soft', '复位成功（后续用例不受污染）');
}

console.log('\n⑦ 坏设置文件不许让插件挂掉');
{
  await writeFile(settingsFile, '{ 这不是 JSON');
  const r = _live.loadSettingsSync();
  check(r.settings.roster.maxTasks === 200, '坏 JSON ⇒ 全默认（不抛）', JSON.stringify(r.repaired));
  await writeFile(settingsFile, JSON.stringify({ roster: { maxTasks: 999999 } }, null, 2));
  const r2 = _live.loadSettingsSync();
  check(r2.settings.roster.maxTasks === 200 && r2.repaired.length === 1, '越界值 ⇒ 回默认 + repairs 上报（用户能在设置页看到被改回了什么）', JSON.stringify(r2.repaired));

  // 1.3.2：删掉的两条装饰开关（`gates.boundaryTasks` / `gates.boundarySpec`）可能**残留在老用户的
  // settings.json 里**。加载器只遍历 spec ⇒ 未知键应被**静默忽略**：不崩、**不产生噪声 repair**
  // （把"我们删了一项"报成"你的值非法"是两种零分不清的典型）。
  await writeFile(settingsFile, JSON.stringify({
    gates: { boundaryTasks: false, boundarySpec: false, tierGate: 'hard' },
    roster: { maxTasks: 50 },
    display: { pollMs: 5000 },
  }, null, 2));
  const r3 = _live.loadSettingsSync();
  check(r3.repaired.length === 0, '残留的已删除键 ⇒ **不产生噪声 repair**（未知键静默忽略）', JSON.stringify(r3.repaired));
  check(r3.settings.gates.tierGate === 'hard' && r3.settings.roster.maxTasks === 50 && r3.settings.display.pollMs === 5000,
    '同文件里的**合法**设置照常生效（不是"遇到未知键就整份丢弃"）',
    JSON.stringify({ tierGate: r3.settings.gates.tierGate, maxTasks: r3.settings.roster.maxTasks, pollMs: r3.settings.display.pollMs }));
  check(r3.settings.gates.boundaryTasks === undefined && r3.settings.gates.boundarySpec === undefined,
    '被删除的键不会出现在生效设置里（没有半死不活的字段）', JSON.stringify(Object.keys(r3.settings.gates)));
}

if (fail) { console.error(`\n✗ settings：${fail} 项失败`); process.exit(1); }
console.log('\n✓ settings：全部通过（spec / 校验 / 全有或全无 / 路由 / 接线优先级 / 坏文件降级）');
