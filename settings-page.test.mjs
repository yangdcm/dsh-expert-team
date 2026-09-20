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
  // 2026-09-20 真机截图报障：设置页「记忆后端」那行显示成 `三种选择**互斥**（…` —— `**` 被当字面量
  // 渲染出来了。根因是这里只做了 `esc(r.hint)`（只转义 HTML），**没有**剥 markdown；而面板没有
  // markdown 渲染器，`lib/settings.js` 的 `memory.backend` hint（804 字、9 对 `**`、16 个反引号）
  // 就这么原样糊到用户脸上（`title` 的原生气泡里也一样）。
  //
  // ⚠️ 旧断言 `esc(r.hint)` 为什么**不算数**：它是在原地做子串匹配，压根没测"剥没剥"——
  // 改动前它通过；就算有人把 `plainText` 这层拿掉，只要那行还写着 `esc(r.hint)` 它**照样通过**。
  // 一条改动前后都恒真的断言 = **空洞断言**（给了绿灯，却没在保护任何东西）。
  // 现在直接钉住完整形态 `esc(plainText(r.hint))`：少了 `plainText` 这一层就红。
  check(/esc\(r\.label\)/.test(src) && /esc\(plainText\(r\.hint\)\)/.test(src),
    '标签过 `esc()`、说明**先剥 markdown 再转义**（`esc(plainText(r.hint))`）—— 否则服务端 hint 里的 `**` / 反引号会原样显示给用户');
  // 反向钉：**不许**再出现"只 esc 不 strip"的那处老写法。少了这条，将来有人把某一行改回去
  // （只要恰好保留另一处正确的 `esc(plainText(r.hint))`）上面那条仍然绿 —— 这是同一类空洞断言的补丁。
  check(!/esc\(r\.hint\)/.test(src), '没有任何一处把 hint 只 `esc()` 而不剥 markdown（老写法已绝迹）');
  // 回归闸（防**任何** hint 泄漏 markdown，不只「记忆后端」这一条）：
  //   ① `title` 属性也必须走 `plainText` —— 原生气泡同样是用户可见的文本；
  //   ② spec 里每个 hint 经 `plainText` 后都不该再残留 `**` / 反引号（当前 19 条里 18 条本就干净，
  //      唯一带标记的 `memory.backend` 就是这次报障的那条）。
  // 这条不依赖具体行号/措辞，spec 新增带 markdown 的 hint 时会**自动**被它逮到。
  check(/title: plainText\(r\.hint\)/.test(src), '`title` 气泡也过 `plainText()`（原生 tooltip 同样是用户可见文本）');

  // 2026-09-20 补：**组说明是另一条渲染路径**。上面几条全部只盯 `r.hint`（行说明），而
  // `exp-settings-group` 那一行渲染的是 `g.hint`（**组**说明）—— 它此前只做了 `esc(g.hint)`，
  // 压根没走 `plainText`。当时 5 条组 hint 恰好都是干净散文（13/9/5/20/32 字）⇒ **潜伏**缺陷：
  // 只要哪个作者往组 hint 里写一次 `**`，它就会像「记忆后端」那次一样原样糊到用户脸上，
  // 而上面所有断言**全绿**（它们根本查不到这条路径）。
  // 所以这里做两件事：① 钉住正确形态 `esc(plainText(g.hint))`；② 反向钉住老写法已绝迹。
  check(/esc\(plainText\(g\.hint\)\)/.test(src),
    '组说明**先剥 markdown 再转义**（`esc(plainText(g.hint))`）—— 与行说明同一套纪律，组标题那一行也是一条独立渲染路径');
  check(!/esc\(g\.hint\)/.test(src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')),
    '组说明那条老写法（只 `esc` 不剥标记）在**生产代码**里已绝迹（判前先剔行首 `//`：注释里提到那处老写法是有意为之，不该被自己的注释判红）');
  // 反向钉的补强：`esc(plainText(g.hint))` 里**含有** `esc(` 但**不含** `esc(g.hint)`，所以上一条能真的逮到
  // 回退；但同时确认这条路径**仍在**（别为了过上面那条把整段组渲染删掉 —— 那样组说明会整个消失）。
  check(/className: 'exp-settings-group'/.test(src) && /esc\(g\.label\)/.test(src),
    '组标题那一行**仍在渲染**（组标签照旧显示 —— 防"删掉整段来消掉告警"）');

  {
    const marks = settingsSchema()
      .flatMap((g) => g.items.map((it) => ({ path: it.path, hint: it.hint })))
      .filter((r) => r.hint && (/\*\*/.test(r.hint) || /`/.test(r.hint)));
    // 2026-09-20 收紧：**允许名单已清空**。此前这里放行 `memory.backend` 一条（它是全 spec 唯一
    // 带标记的 hint，靠渲染层 `plainText` 兜住）；那条 hint 已按用户要求（「文字太多了 简化一点」）
    // 从 804 字 / 9 对 `**` / 16 个反引号改写成 158 字纯散文 ⇒ 现在**一条都不该带标记**。
    // 渲染层的 `plainText` 作为**防御性收口**保留（下面几条仍钉着它），但**数据本身**必须是干净的：
    // 拿掉允许名单后，这条从"防新增"升级成"零容忍" —— 任何人再写 markdown 进 hint 都会立刻红。
    check(marks.length === 0,
      'spec 里**没有**任何带 markdown 的 hint（允许名单已清空：`memory.backend` 已改写成纯散文；渲染层 plainText 只是防御性收口，数据本身必须干净）',
      marks.length ? `带标记：${marks.map((m) => m.path).join(', ')}` : '（0 条）');
    // 组 hint 一并纳入同一条不变量（它们是另一条渲染路径，此前不在扫描面内）。
    const groupMarks = settingsSchema().filter((g) => g.hint && (/\*\*/.test(g.hint) || /`/.test(g.hint)));
    check(groupMarks.length === 0,
      'spec 里**没有**任何带 markdown 的**组**说明（与行说明同一条不变量，组说明是独立渲染路径）',
      groupMarks.length ? `带标记：${groupMarks.map((g) => g.group).join(', ')}` : '（0 条）');
  }
  // 说明**篇幅**闸（2026-09-20 · 用户原话「文字太多了 简化一点」）：旧 `memory.backend` hint 804 字，
  // 是次长一条（221 字）的 3.6 倍，在设置页里占掉半屏。这里钉一个**上限**，让"又写一篇论文"当场变红 ——
  // 与 markdown 那条是同一个诉求的两面（长说明多半就是靠标记/操作细节堆出来的）。
  {
    const allHints = settingsSchema().flatMap((g) => g.items.map((it) => ({ path: it.path, len: (it.hint || '').length })))
      .filter((r) => r.len > 0).sort((a, b) => b.len - a.len);
    const LIMIT = 300;
    const over = allHints.filter((r) => r.len > LIMIT);
    check(over.length === 0,
      `每条 hint 都不超过 ${LIMIT} 字（设置页一行说明的合理上限；操作细节归状态块/引导，不往 hint 里堆）`,
      over.length ? `超限：${over.map((r) => `${r.path}:${r.len}`).join(', ')}` : `最长 ${allHints[0] ? allHints[0].path + ':' + allHints[0].len : '—'} 字`);
  }
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
