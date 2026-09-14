// 测试：F 线第 3 项 **设置页签**（client 侧）+ 与 host spec 的**不分叉**保证
//
// 需求原文：「插件需要一个控制台设置页面…把常用的参数可视化配置加上」。
// 实现选择（如实记下）：**没有**依赖宿主是否提供 `settings.section` 槽（本机 layout 包里查不到该槽），
// 而是把设置做成专家团浮层的**第 5 个页签**（人 / 事 / 料 / 盘 / 设）—— 自包含、不新增宿主面。
//
// 本测试钉住：
//   ① 表单**由 host 的 schema 生成**（客户端不另写一份默认值/值域）；
//   ② **spec 里出现的每一种类型，界面都认识** —— 这条是防"加了设置项但界面没跟上"的漂移闸；
//   ③ 页签真的接进了浮层（注册了但不在 tab 列表里 = 看不见，这是本仓 D7 的老毛病）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M119**。
// 运行：node settings-page.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsSchema } from './lib/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# F 线 · 设置页签（client）\n');

const src = await readFile(join(here, 'client.js'), 'utf8');
let mod = null;
const reactStub = { useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), createElement: () => null, Fragment: null };
new Function('window', 'console', 'require', src)({ __ModuleLoader__: { load: (m) => { mod = m; } } }, { log: () => {} }, (id) => (id === 'react' ? reactStub : {}));
const ex = mod.factory((id) => (id === 'react' ? reactStub : {}));
const { settingsFormModel } = ex._live;

console.log('① 表单由 host 的 schema 生成（不另写一份默认值/值域）');
{
  const schema = settingsSchema();
  const defaults = { identity: { profile: 'developer', askBudget: 5 }, roster: { maxTasks: 200, defaultRoles: null } };
  const model = settingsFormModel(schema, defaults);
  check(model.length === schema.length && model.length === 4, '四个分组都渲染', `${model.length} 组`);
  check(model.every((g) => g.rows.length > 0), '每组都有行', model.map((g) => `${g.group}:${g.rows.length}`).join(' '));
  const all = model.flatMap((g) => g.rows);
  check(all.length === Object.keys(settingsSchema().flatMap((g) => g.items)).length, '行数 = spec 项数（不重不漏）', String(all.length));
  check(all.every((r) => r.label), '每行都带中文标签（UI 直接显示 spec 的 label）');
  const prof = all.find((r) => r.path === 'identity.profile');
  check(prof.type === 'enum' && prof.values.join(',') === 'developer,non-technical,mixed', 'enum 的候选值来自 spec', JSON.stringify(prof.values));
  check(prof.value === 'developer', '控件初值取当前设置');
  const budget = all.find((r) => r.path === 'identity.askBudget');
  check(budget.value === 5 && budget.min === 0 && budget.max === 20, 'int 带上下界（输入框直接约束）');
  check(all.find((r) => r.path === 'roster.defaultRoles').value === '', '`roles` 的 null 渲染成空输入（= 按档位默认）');
  const withRoles = settingsFormModel(schema, { roster: { defaultRoles: ['pm', 'qa'] } });
  check(withRoles.flatMap((g) => g.rows).find((r) => r.path === 'roster.defaultRoles').value === 'pm, qa', '`roles` 数组渲染成逗号串');
  check(settingsFormModel([], {}).length === 0 && settingsFormModel(null, null).length === 0, '空/坏 schema 不炸（返回空表单）');
}

console.log('\n② spec 的每一种类型界面都认识（防"加了设置项、界面没跟上"）');
{
  const all = settingsFormModel(settingsSchema(), {}).flatMap((g) => g.rows);
  const unknown = all.filter((r) => !r.known);
  check(unknown.length === 0, 'spec 里没有界面不认识的类型', unknown.length ? `不认识：${unknown.map((r) => `${r.path}:${r.type}`).join(', ')}` : `${all.length} 项全认识`);
  const types = [...new Set(all.map((r) => r.type))].sort();
  check(types.join(',') === 'bool,enum,int,roles', '类型集合就是这四种', types.join(','));
  const probe = settingsFormModel([{ group: 'x', label: 'X', items: [{ path: 'x.y', key: 'y', type: 'weird', label: '怪' }] }], {});
  check(probe[0].rows[0].known === false, '真出现未知类型时**如实标出**（不静默渲染成空控件）');
}

console.log('\n③ 页签真的接进了浮层（注册了但不在 tab 列表里 = 看不见）');
{
  check(/TAB_ZH = \{ team: '人', tasks: '事', info: '料', board: '盘', settings: '设' \}/.test(src), 'tab 标签表含 `settings: \'设\'`（5 个页签）');
  check(/\['team', 'tasks', 'info', 'board', 'settings'\]\.map/.test(src), 'tab 列表含 settings（否则那个页签永远不会被渲染）');
  check(/tab === 'settings' \? h\(SettingsTab, null\)/.test(src), '渲染分发里有 `SettingsTab`');
  check(/function SettingsTab\(\)/.test(src), '`SettingsTab` 组件已定义');
  check(/fetch\('\/plugins\/dsh-expert-team\/settings'\)/.test(src), 'GET 读设置');
  check(/method: 'POST'/.test(src) && /JSON\.stringify\(patch\)/.test(src), 'POST 写设置（自动保存）');
  check(/setErr\(\(\(res\.d && res\.d\.errors\) \|\| \['保存失败'\]\)\.join/.test(src), '400 的 errors 照实显示（不吞）');
  check(/needsRestart \? '已保存 —— \*\*重启 dsh web 后生效\*\*' : '已保存'/.test(src), '如实区分"要不要重启"（不假装即时生效）');
  check(/esc\(r\.label\)/.test(src) && /esc\(r\.hint\)/.test(src), '标签与说明过 `esc()`（与其它文案同一套转义纪律）');
  check(!/settings\.section/.test(src), '未依赖宿主 `settings.section` 槽（本机 layout 无该槽 ⇒ 用浮层第 5 页签自包含实现）');
}

if (fail) { console.error(`\n✗ settings-page：${fail} 项失败`); process.exit(1); }
console.log('\n✓ settings-page：全部通过（schema 驱动 / 类型全覆盖 / 真接进浮层）');
