// 测试：设置页（client 侧）+ 与 host spec 的**不分叉**保证
//
// 需求原文：「插件需要一个控制台设置页面…把常用的参数可视化配置加上」。
// 实现历史（如实记下，含一次**被实测推翻的判断**）：
//   · 第一版把设置做成专家团浮层的**第 5 个页签**（人/事/料/盘/设），当时的理由是
//     「本机 layout 包里查不到 `settings.section` 槽」。**这个理由是错的** —— 该槽由
//     `@deepseek-ai/dsh-client-ui-settings-general` 声明（不是 layout），安装目录里逐字可见，
//     `agent-preset` / `settings-models` / `settings-plugins` 都在用它。
//   · 第二版（现行）把设置页注册进**官方设置菜单**的 `settings.section` 槽，并**删掉「设」页签**：
//     单一入口、与其它插件同一套面板 chrome。
//
// 本测试钉住：
//   ① 表单**由 host 的 schema 生成**（客户端不另写一份默认值/值域）；
//   ② **spec 里出现的每一种类型，界面都认识** —— 这条是防"加了设置项但界面没跟上"的漂移闸；
//   ③ 设置页真的接进了**官方设置菜单**（注册了但没人渲染 = 看不见，这是本仓 D7 的老毛病），
//      且浮层里**不再**留「设」页签（两处渲染同一份表单必然分叉）；
//   ④ **读失败必须显式报错**：旧实现 `r.ok ? r.json() : null` 把非 200 静默丢成 null，
//      于是永远停在「（正在读取设置…）」—— 实测运行中的 dsh web 若早于本功能，GET /settings
//      返回 404，用户看到的就是无限加载（2026-09-14 用户报障原话）。
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
  check(model.length === schema.length && model.length === 5, '五个分组都渲染（含 2026-09-17 新增的「记忆」组）', `${model.length} 组`);
  check(model.every((g) => g.rows.length > 0), '每组都有行', model.map((g) => `${g.group}:${g.rows.length}`).join(' '));
  const all = model.flatMap((g) => g.rows);
  check(all.length === Object.keys(settingsSchema().flatMap((g) => g.items)).length, '行数 = spec 项数（不重不漏）', String(all.length));
  // `memory.backend` 是**schema 驱动**的直接证据：它没在客户端手写过任何控件，靠 spec 就出现了，
  // 且三个候选值的中文标签随 GET /settings 的 schema 一起到达（客户端不能 import lib/）。
  const mb = all.find((r) => r.path === 'memory.backend');
  check(!!mb && mb.type === 'enum' && mb.values.join(',') === 'hindsight,midas,off', '「记忆后端」由 spec 自动生成（不在客户端另写一份控件/值域）', mb ? `${mb.type}:${mb.values.join(',')}` : '（找不到 memory.backend）');
  check(!!mb && !!mb.labels && mb.labels.off && mb.labels.midas, '三个值都带中文标签（下拉里不裸露英文标识）', mb ? JSON.stringify(mb.labels) : '');
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

console.log('\n③ 设置页真的接进了官方设置菜单（注册了但没人渲染 = 看不见）');
{
  check(/ctx\.slots\.inject\('settings\.section'/.test(src), '注册进官方 `settings.section` 槽（宿主 ui-settings-general 声明）');
  check(/name: 'settings\.section',[\s\S]{0,120}?id: 'expert-team'/.test(src), '分节 id 稳定（`expert-team`）');
  check(/order: 50/.test(src) && /label: function \(\) \{ return t\('专家团', 'Expert team'\) \}/.test(src), '带上 nav 位置与随语言变化的标签');
  check(/function SettingsSection\(\)/.test(src), '`SettingsSection` 组件已定义');
  check(/wrap\(SettingsSection\)/.test(src), '分节用 `wrap()` 挂载（渲染出错不会炸掉整个设置面板）');
  check(!/TAB_ZH = \{[^}]*settings/.test(src), '浮层「设」页签已移除（不再两处渲染同一份表单）');
  check(!/\['team', 'tasks', 'info', 'board', 'settings'\]/.test(src) && !/tab === 'settings'/.test(src), '浮层 tab 列表与渲染分发里都没有 settings');
  check(/ensureCss\(\)/.test(src) && /exports\.apply = function \(ctx\) \{[\s\S]{0,4000}?ensureCss\(\)/.test(src), 'CSS 在 apply() 里注入（首屏/无会话时打开设置面板也有样式）');
  check(/fetch\('\/plugins\/dsh-expert-team\/settings'\)/.test(src), 'GET 读设置');
  check(/method: 'POST'/.test(src) && /JSON\.stringify\(patch\)/.test(src), 'POST 写设置（自动保存）');
  check(/setErr\(\(\(res\.d && res\.d\.errors\) \|\| \['保存失败'\]\)\.join/.test(src), '400 的 errors 照实显示（不吞）');
  check(/setMsg\('已保存'\)/.test(src) && !/needsRestart \?/.test(src), '回执只说「已保存」且**不留死分支**（除「记忆 → 记忆后端」这一项外，逐项查明没有任何设置需要重启；那一项走专用路由）');
  // 2026-09-17：`memory.backend` 是**唯一需要重启**的设置 ⇒ 它不能挤在这条"已保存"路径上：
  // 客户端必须把它改路由到 `/memory-backend`，并把那条路由给的重启要求显示出来。
  check(/saveMemoryBackend\(mb\)/.test(src) && /'memory\.backend'/.test(src), '`memory.backend` 从通用保存路径**分流**到专用路由（不虚报"已保存、即时生效"）');
  check(/function memoryBackendMsg\(d\)/.test(src) && /需重启 dsh web 才生效/.test(src), '重启要求有**单一实现**的文案并被渲染（不藏在注释里）');
  // 2026-09-19 一期：`midas` **真的接通了** ⇒ 客户端那句"本轮未接通"（说的是"这个功能本轮没做"）已经过时，
  // 换成五态结论的文案 + 首装引导。两条一起钉：**未接通要如实说**，且**引导的步骤来自服务端**。
  check(/Midas 未接通/.test(src) && !/本轮未接通/.test(src),
    '`midas` 的「未接通」仍如实显示，但不再说"本轮未接通"（那已经是假话 —— 它真的接线了，只是缺步骤）');
  check(/st\.midasSetup/.test(src) && /midasSetup\.steps/.test(src) && /exp-hs-midas-guide/.test(src),
    '选 `midas` 且未就绪时渲染**块级**首装引导，步骤取自服务端的 `midasSetup.steps`（客户端不硬编命令）');
  check(/这与「你选了不使用」不是一回事/.test(src), '"选了不使用"与"选了 Hindsight 但不通"在界面上**分开说**（不许渲染成同一件事）');
  // 1.3.2：枚举中文标签 —— 规格层给了 labels，模型要透出来、渲染要取用，且**缺标签时退回裸值**
  // （不能渲染成空白：那会让"标签漏配"看起来像"这个选项本来就没有名字"）。
  check(/labels: it\.labels \|\| null/.test(src), '表单模型透出 \`labels\`（标签随 GET /settings 的 schema 到达客户端）');
  check(/r\.labels && r\.labels\[v\]\) \|\| v/.test(src), '<option> 文本取 \`labels[值] || 值\`（缺标签退回裸值，绝不留空白）');
  check(/esc\(r\.label\)/.test(src) && /esc\(r\.hint\)/.test(src), '标签与说明过 `esc()`（与其它文案同一套转义纪律）');
}

console.log('\n④ 读失败必须显式报错（不许停在「正在读取设置…」）');
{
  check(/if \(!res\.ok \|\| !res\.d \|\| !res\.d\.ok\)/.test(src), '非 200 / 非 ok 响应**进了错误分支**（旧实现是 `r.ok ? r.json() : null` 静默丢弃）');
  check(/setLoadErr\(t\('读取设置失败：HTTP '/.test(src), '带上真实 HTTP 状态码（404 = 路由未注册，可直接判因）');
  check(/setLoadErr\(t\('读取设置失败：', 'Reading settings failed: '\)/.test(src), '网络错误也照实上报');
  check(/'（正在读取设置…）'/.test(src) && /if \(loading\) return/.test(src), '「正在读取设置…」只出现在 loading 状态（不是"读不到时的兜底文案"）');
  check(/setRetry\(retry \+ 1\)/.test(src) && /exp-settings-retry/.test(src), '给出「重试」按钮（重启 dsh web 后不必刷新整页）');
}

if (fail) { console.error(`\n✗ settings-page：${fail} 项失败`); process.exit(1); }
console.log('\n✓ settings-page：全部通过（schema 驱动 / 类型全覆盖 / 接进官方设置菜单 / 读失败显式报错）');
