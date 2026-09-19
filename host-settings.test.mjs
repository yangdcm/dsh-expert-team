// 测试：宿主设置命名空间接线（1.2.0）
//
// 为什么单独成测：这块接的是**宿主服务**，而仓库里跑测试时那个服务并不存在 ——
// 所以必须把三条路径都钉住，否则"注册成功"那条永远没人验证过：
//   ① schema 生成：只映射宿主表达得了的类型，`roles` 刻意不上（上了可能让宿主拒绝注册）；
//   ② 成功路径：用**注入的 schema 加载器**驱动真实的 register/watch/update 流程；
//   ③ 回退路径：宿主没服务、或 schemastery 解析不到 ⇒ 保持 settings.json，且**不抛**、要出声。
//
// 运行：node host-settings.test.mjs

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const hs = await import(join(here, 'lib', 'host-settings.js'));
const { _live } = await import(join(here, 'lib', 'command.js'));
const settingsMod = await import(join(here, 'lib', 'settings.js'));

/** 最小 schemastery 替身：记录被调用的方法，便于断言"范围/默认值都来自 spec"。 */
function zStub() {
  const calls = [];
  const make = (kind) => {
    const node = {
      kind, calls,
      min(v) { calls.push(['min', v]); return node; },
      max(v) { calls.push(['max', v]); return node; },
      default(v) { calls.push(['default', v]); return node; },
    };
    return node;
  };
  return {
    calls,
    boolean: () => make('boolean'),
    number: () => make('number'),
    const: (v) => {
      const node = { kind: 'const', value: v, desc: null };
      node.description = (text) => { node.desc = text; return node; };
      return node;
    },
    union: (of) => ({ kind: 'union', of }),
    object: (shape) => ({ kind: 'object', shape }),
  };
}

console.log('# 宿主设置命名空间接线\n');

console.log('① schema 由 SETTINGS_SPEC 生成（单一真源），并刻意不包含 roles');
{
  const z = zStub();
  const schema = hs.buildHostSchema(z);
  check(hs.HOST_SETTINGS_NAMESPACE === 'expert-team' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(hs.HOST_SETTINGS_NAMESPACE), '命名空间符合宿主文法', hs.HOST_SETTINGS_NAMESPACE);
  // 2026-09-17：原来是 `!!shape.identity && !!shape.roster && …` 的**子集**断言 + 文案写死"四个分组"——
  // 新增「记忆」组后那句话已经不实（文案与实际不符是本仓点名的缺陷类），而且子集断言**钉不住集合**：
  // 多出一组、或某一组整个掉出来，它都不会红。改成与 `SETTINGS_GROUPS` 的**集合相等**。
  const hostGroups = Object.keys(schema.shape).sort();
  const specGroups = [...settingsMod.SETTINGS_GROUPS].sort();
  check(schema.kind === 'object' && hostGroups.join(',') === specGroups.join(','),
    '宿主 schema 的分组集合 == `SETTINGS_GROUPS`（当前五组：身份 / 编制 / 显示 / 门禁 / 记忆 —— 集合相等，多一组少一组都红）',
    `host=${hostGroups.join(',')} ｜ spec=${settingsMod.SETTINGS_GROUPS.join(',')}`);
  check(!!(schema.shape.memory && schema.shape.memory.shape && schema.shape.memory.shape.backend),
    '新增的「记忆」组本身也上了官方面板（`memory.backend` 映射成 union）', Object.keys(schema.shape).join(', '));
  check(schema.shape.roster.shape.maxTasks.kind === 'number', 'int 映射为 number', schema.shape.roster.shape.maxTasks.kind);
  check(z.calls.some(([m, v]) => m === 'min' && v === 0) && z.calls.some(([m, v]) => m === 'max' && v === 5000), 'int 的 min/max 取自 spec（0..5000）', JSON.stringify(z.calls.filter(([m]) => m !== 'default').slice(0, 4)));
  check(z.calls.some(([m, v]) => m === 'default' && v === 200), '默认值取自 spec（maxTasks 默认 200）');
  check(schema.shape.identity.shape.profile.kind === 'union', 'enum 映射为 union(const…)', schema.shape.identity.shape.profile.kind);
  // 1.3.3：枚举成员带上中文描述（值本身仍是标识 —— 值域不变），让别的 UI 也能显示中文
  {
    const of = schema.shape.identity.shape.profile.of;
    check(of.map((c) => c.value).join(',') === 'developer,non-technical,mixed', '枚举**值域不变**（描述只是 meta，不改类型/取值）', of.map((c) => c.value).join(','));
    check(of.map((c) => c.desc).join('/') === '技术开发者/无技术经验/混合', '每个枚举成员挂上了中文描述', JSON.stringify(of.map((c) => c.desc)));
    const tg = schema.shape.gates.shape.tierGate.of;
    check(tg.map((c) => c.desc).join('/') === '软门（建议先生效）/硬门（不选不开工）', '第二个枚举项（档位门）同样带描述', JSON.stringify(tg.map((c) => c.desc)));
  }
  check(schema.shape.roster.shape.defaultRoles === undefined, 'roles **不上**官方面板（避免表达不当导致宿主拒绝注册）');
  const paths = hs.hostSchemaPaths();
  check(paths.length > 0 && !paths.includes('roster.defaultRoles') && paths.includes('display.pollMs'), `hostSchemaPaths 与 schema 一致（${paths.length} 个字段）`, '');
}

console.log('\n② 补丁裁剪：表达的进宿主、表达不了的留给文件（不制造"一个字段两个家"）');
{
  const nested = { roster: { maxTasks: 300, defaultRoles: ['pm', 'qa'] }, display: { pollMs: 5000 } };
  const flat = { 'gates.tierGate': 'hard', 'roster.defaultRoles': null };
  const e1 = hs.pickHostExpressible(nested);
  check(e1.roster && e1.roster.maxTasks === 300 && e1.roster.defaultRoles === undefined, '嵌套补丁：只留可表达字段', JSON.stringify(e1));
  check(e1.display && e1.display.pollMs === 5000, '嵌套补丁：多分组都保留');
  const f1 = hs.pickFileOnly(nested);
  check(f1.roster && Array.isArray(f1.roster.defaultRoles) && f1.roster.maxTasks === undefined, '文件侧只留 roles', JSON.stringify(f1));
  const e2 = hs.pickHostExpressible(flat);
  check(e2.gates && e2.gates.tierGate === 'hard' && (!e2.roster || e2.roster.defaultRoles === undefined), '扁平补丁同样支持（与 mergeSettings 同口径）', JSON.stringify(e2));
  const base = hs.hostBase(settingsMod.defaultSettings());
  check(base.roster.maxTasks === 200 && base.roster.defaultRoles === undefined, 'hostBase 从当前设置取值且丢掉 null 的 roles', JSON.stringify(base.roster));
}

console.log('\n③ 成功路径：register/watch 真的被驱动（用注入的 schema 加载器）');
{
  const z = zStub();
  const registered = [];
  let watched = null;
  const stored = { identity: { profile: 'non-technical' } };   // 假装官方面板里已经改过
  const scope = {
    get: () => stored,
    watch: (cb) => { watched = cb; return () => {}; },
    update: async (patch) => { registered.push(patch); Object.assign(stored, patch); },
  };
  const ctx = {
    inject: (deps, cb) => { if (String(deps) === 'settings') cb({ settings: { register: (ns, schema, opts) => { registered.push({ ns, schema, opts }); return scope; } }, effect: (fn) => fn() }); },
  };
  let resolved = null;
  const installed = hs.installHostSettings(ctx, { base: settingsMod.defaultSettings(), onResolved: (v) => { resolved = v; }, loadSchema: async () => ({ default: z }) });
  check(installed === true, 'installHostSettings 挂上了 inject 边界', String(installed));
  await new Promise((r) => setTimeout(r, 20));   // 等动态 import 的微任务链
  const reg = registered.find((x) => x && x.ns);
  check(!!reg && reg.ns === 'expert-team', 'register 用我们的命名空间', String(reg && reg.ns));
  check(!!reg.opts && reg.opts.base && reg.opts.base.roster && reg.opts.base.roster.maxTasks === 200, 'base = 当前生效设置（面板打开即看到真值）', JSON.stringify(reg.opts.base.roster));
  check(resolved && resolved.identity.profile === 'non-technical', 'onResolved 收到了宿主解析值', JSON.stringify(resolved));
  check(typeof watched === 'function', 'watch 已订阅（官方面板改动 → 重算）');
  check(hs.hostScope() === scope && hs.hostValues() === stored, 'hostScope/hostValues 已就绪');

  const w = await hs.updateHostSettings({ roster: { maxTasks: 777, defaultRoles: ['pm'] }, display: { pollMs: 1234 } });
  check(w.ok === true && w.written === 2, 'updateHostSettings 只写可表达的两个字段', JSON.stringify(w));
  const written = registered.filter((x) => !x.ns).pop();
  check(!!written && written.roster.maxTasks === 777 && written.roster.defaultRoles === undefined && written.display.pollMs === 1234, '写进宿主的内容里没有 roles', JSON.stringify(written));
  const nothing = await hs.updateHostSettings({ roster: { defaultRoles: ['pm'] } });
  check(nothing.ok === false && nothing.reason === 'nothing-expressible', '全是表达不了的字段 ⇒ 明确回报 nothing-expressible（调用方据此退回文件）', JSON.stringify(nothing));
}

console.log('\n④ 回退路径：宿主没有 settings 服务 / schemastery 解析不到 ⇒ 保持 settings.json，且不抛');
{
  // 换一个干净进程态：这里直接验证"服务缺失"与"加载失败"两种输入的返回值语义
  const noInject = hs.installHostSettings({}, { base: settingsMod.defaultSettings() });
  check(noInject === false, 'ctx 没有 inject ⇒ 返回 false（调用方无需回退逻辑，文件路径照旧）', String(noInject));
  const noService = hs.installHostSettings({ inject: (deps, cb) => { cb({}); } }, { base: settingsMod.defaultSettings(), loadSchema: async () => ({ default: zStub() }) });
  check(noService === true, 'inject 边界挂上但回调里没有 settings 服务 ⇒ 静默不动（与 dshmarket 的降级写法一致）', String(noService));
  // 加载器失败：应记下原因、出声，且不影响调用方
  const failing = hs.installHostSettings({ inject: (deps, cb) => cb({ settings: { register: () => ({ get: () => null, watch: () => {} }) } }) }, { base: settingsMod.defaultSettings(), loadSchema: async () => { throw new Error('模拟：解析不到 schemastery'); } });
  check(failing === true, '加载器失败也不抛（返回 true，注册未完成）', String(failing));
  await new Promise((r) => setTimeout(r, 10));
  check(/schemastery/.test(hs.hostSettingsNote()), '失败原因被如实记下（供 /team status 与诊断显示）', hs.hostSettingsNote());
}

console.log('\n⑤ 接线：插件真的把设置注册出去，并且读设置时以宿主值为准');
{
  const src = await (await import('node:fs/promises')).readFile(join(here, 'lib', 'command.js'), 'utf8');
  check(/installHostSettings\(ctx, \{/.test(src), 'apply() 里调了 installHostSettings', '');
  check(/onResolved: \(\) => reapplySettingsDerived\(\)/.test(src), '宿主值变化 ⇒ 重算上限/档位门（不重启即生效）', '');
  check(/function reapplySettingsDerived\(\)/.test(src) && /resolveLimits\(PLUGIN_CONFIG/.test(src), '重算沿用 PLUGIN_CONFIG（不丢 config 覆写）', '');
  check(/const host = hostValues\(\);\s*\n\s*if \(!host\) return file;/.test(src), 'currentSettings 以宿主值为准、缺失时回退文件', '');
  check(/const viaHost = await updateHostSettings\(patch\)/.test(src), 'POST /settings 优先写宿主', '');
  check(/pickFileOnly\(merged\.value\)/.test(src), '宿主可用时，文件只收"表达不了"的字段（不制造两份真源）', '');
  const exposed = ['installHostSettings', 'hostValues', 'hostScope', 'updateHostSettings', 'pickFileOnly', 'buildHostSchema', 'hostBase', 'reapplySettingsDerived'];
  check(exposed.every((k) => _live[k] !== undefined), '_live 暴露了测试所需的接线口', exposed.filter((k) => _live[k] === undefined).join(',') || '');
}

console.log('\n⑥ 子代理列表「最新在上」：设置项 + 自有属性遮蔽 + **未生效必须如实上报**');
{
  const ao = await import(join(here, 'lib', 'subagent-order.js'));

  // ── 设置项：单一真源里必须有它，且 hint 必须**披露**（只改展示顺序 / 契约不变 / 未生效会说）──
  const item = (((settingsMod.SETTINGS_SPEC || {}).display || {}).items || {}).subagentListNewestFirst;
  check(!!item, 'SETTINGS_SPEC.display.items 里有 subagentListNewestFirst（单一真源，不另抄默认值）', item ? '' : '缺');
  check(!!item && item.type === 'bool' && item.default === true, '类型 bool、默认开（"装了就见效"）', item ? `type=${item.type} default=${item.default}` : '');
  check(!!item && /展示顺序/.test(item.hint) && /listChildren/.test(item.hint) && /未生效|退回/.test(item.hint),
    'hint 披露了"只改展示顺序 + 服务端契约不变 + 结构不匹配会退回并如实显示"', item ? '' : '缺');

  // ── 纯函数：反转但不改入参；形状不符 ⇒ 原样返回 ──
  const cat = { entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], parentAvailable: true };
  const rev = ao.reverseCatalogEntries(cat);
  check(rev.changed && rev.catalog.entries.map((e) => e.id).join('') === 'cba', '反转 entries', rev.catalog.entries.map((e) => e.id).join(''));
  check(cat.entries.map((e) => e.id).join('') === 'abc', '**不修改入参**（宿主可能复用同一份目录）', cat.entries.map((e) => e.id).join(''));
  check(rev.catalog.parentAvailable === true, '其余字段原样保留', '');
  const bad = ao.reverseCatalogEntries({ nope: 1 });
  check(bad.changed === false && bad.catalog.nope === 1, '形状不符 ⇒ changed:false 且原样返回（不猜结构）', '');

  // ── 包装：**不依赖 `this`**、反转、非 catalog 原样返回 ──
  const seenThis = [];
  const original = async function (x) { seenThis.push(this); return { entries: [1, 2], x }; };
  const target = { tag: 'svc' };
  // 关键：用**外来的 this** 调我们的包装（网关正是 `Reflect.apply(method, receiver, args)`，
  // 而 receiver 不是裸实例、apply trap 会换 thisArg）⇒ 原方法仍必须以**捕获的 target** 被调用。
  const foreignThis = { tag: 'receiver-proxy' };
  const wrapped = ao.createSubagentOrderWrapper(original, target);
  const out = await Reflect.apply(wrapped, foreignThis, ['arg']);
  check(out.entries.join('') === '21' && out.x === 'arg', '包装后反转、且保留其它字段', JSON.stringify(out));
  check(seenThis[0] === target, '**不依赖 `this`**：原方法始终以捕获到的 target 被调用（外面的 this 被忽略）', String(seenThis[0] && seenThis[0].tag));
  check(seenThis[0] !== foreignThis, '外来的 this **没有**被转发给原方法（否则宿主方法可能在错误的 this 上执行）', '');
  check(await Reflect.apply(ao.createSubagentOrderWrapper(async () => 42, target), foreignThis, []) === 42, '原方法返回非 catalog ⇒ 原样返回（不硬凑）', '');

  // ── 遮蔽：装 / 幂等 / 只卸自己装的 / 卸净后原型恢复 ──
  const proto = { remoteExportList: async () => ({ entries: ['old1', 'old2'] }) };
  const svc = Object.create(proto);   // 方法在**原型**上，与实际服务同形态
  const first = ao.installSubagentOrderOn(svc);
  check(first.ok && first.reason === 'installed', '装入自有属性', first.reason);
  const own = Object.getOwnPropertyDescriptor(svc, 'remoteExportList');
  check(!!own && own.value === first.wrapper, '判活只能读**自有描述符**（`fn === wrapper` 会被代理的 shadow method 骗过）', '');
  const got = await Reflect.apply(Reflect.get(svc, 'remoteExportList'), svc, []);
  check(got.entries.join(',') === 'old2,old1', '读取方拿到的是**反转后**的结果', JSON.stringify(got.entries));
  const second = ao.installSubagentOrderOn(svc);
  check(second.ok && second.reason === 'already-installed' && second.wrapper === first.wrapper, '幂等：重复装不会双层包装', second.reason);

  const foreign = Object.create(proto);
  Object.defineProperty(foreign, 'remoteExportList', { value: async () => 'foreign', configurable: true, writable: true });
  const refused = ao.uninstallSubagentOrderFrom(foreign);
  check(refused.ok === false && refused.reason === 'not-ours', '不是我们装的 ⇒ 拒绝卸载（不动别人的遮蔽）', refused.reason);
  check(typeof foreign.remoteExportList === 'function' && (await foreign.remoteExportList()) === 'foreign', '拒绝后对方的实现原样保留', '');
  const removed = ao.uninstallSubagentOrderFrom(svc, first.wrapper);
  check(removed.ok && removed.reason === 'removed', '卸载成功', removed.reason);
  check(Object.getOwnPropertyDescriptor(svc, 'remoteExportList') === undefined, '自有属性被**真正删掉**（不留痕迹）', '');
  check((await Reflect.apply(Reflect.get(svc, 'remoteExportList'), svc, [])).entries.join(',') === 'old1,old2', '删掉后原型方法自动恢复（宿主默认顺序）', '');

  // ── 状态机：开/关/服务缺失/宿主方法缺失 —— 每一种都要**如实** ──
  ao._resetSubagentOrder();
  const fakeCtx = (service) => ({ get: (n) => (n === ao.SUBAGENT_ORDER_SERVICE ? service : undefined) });
  const okSvc = Object.create(proto);
  const st1 = ao.applySubagentOrder(fakeCtx(okSvc), true);
  check(st1.enabled && st1.installed && st1.effective, '开且装成功 ⇒ effective:true', JSON.stringify(st1));
  const st2 = ao.applySubagentOrder(fakeCtx(okSvc), false);
  check(st2.enabled === false && st2.effective === false && st2.reason === 'disabled', '关掉 ⇒ 卸载 + 如实标 disabled', JSON.stringify(st2));
  check(Object.getOwnPropertyDescriptor(okSvc, 'remoteExportList') === undefined, '关掉后自有属性被删掉', '');
  const st3 = ao.applySubagentOrder(fakeCtx(undefined), true);
  check(st3.effective === false && st3.reason === 'service-missing', '拿不到服务 ⇒ 不装 + 如实标 service-missing', JSON.stringify(st3));
  const st4 = ao.applySubagentOrder(fakeCtx({}), true);
  check(st4.effective === false && st4.reason === 'host-method-missing', '宿主方法不存在 ⇒ 不装 + 如实标 host-method-missing', JSON.stringify(st4));
  const st5 = ao.applySubagentOrder(fakeCtx(okSvc), true);
  check(st5.effective === true, '恢复开启后能重新装上', JSON.stringify(st5));
  const d = ao.disposeSubagentOrder();
  check(d.ok === true && Object.getOwnPropertyDescriptor(okSvc, 'remoteExportList') === undefined, 'dispose 删掉自有属性（不留痕）', JSON.stringify(d));
  check(ao.subagentOrderStatus().effective === false, 'dispose 后状态如实变回"未生效"', JSON.stringify(ao.subagentOrderStatus()));
  ao._resetSubagentOrder();

  // ── traceable 代理（cordis 的真实形态）：把机制依赖的两条假设钉住 ──
  // 依据真实源码（cordis 4.0.2 `createTraceable`）：get 对**自有 value 属性**直接给值、
  // 对**原型函数**包成 shadow method；**没有 defineProperty 陷阱** ⇒ 定义落到裸实例。
  const mkTraceable = (t) => new Proxy(t, {
    get(tg, prop) {
      if (prop === Symbol.for('cordis.original')) return tg;
      const desc = Object.getOwnPropertyDescriptor(tg, prop);
      // 真实语义（cordis 4.0.2）：自有 value 属性直接取值，否则按原型读；
      // 之后**任何函数**（无论自有还是原型）都会被包成 shadow method。
      const v = (desc && 'value' in desc) ? desc.value : Reflect.get(tg, prop);
      if (typeof v === 'function') return (...a) => Reflect.apply(v, tg, a);
      return v;
    },
  });
  const psvc = Object.create(proto);
  const r = ao.installSubagentOrderOn(mkTraceable(psvc));
  check(r.ok === true, '隔着 traceable 代理也能装入', r.reason);
  check(Object.getOwnPropertyDescriptor(psvc, 'remoteExportList') !== undefined, '自有属性落在**裸实例**上（代理无 defineProperty 陷阱）', '');
  const fetched = Reflect.get(mkTraceable(psvc), 'remoteExportList');
  check(fetched !== r.wrapper, '代理读到的**不是**我们的函数本体（被包成 shadow method）——所以判活必须读自有描述符', '');
  const pout = await Reflect.apply(fetched, mkTraceable(psvc), []);
  check(pout.entries.join(',') === 'old2,old1', '即便隔着代理，调用结果仍是我们包装后的（反转）', JSON.stringify(pout.entries));
  ao.uninstallSubagentOrderFrom(psvc, r.wrapper);
  check(Object.getOwnPropertyDescriptor(psvc, 'remoteExportList') === undefined, '代理场景下也能干净卸掉', '');

  // 代理场景下**再验一次"不依赖 this"**：用外来 receiver 调，原方法仍必须以裸实例为 this。
  const seenP = [];
  const proto2 = { remoteExportList: async function () { seenP.push(this); return { entries: ['a', 'b'] }; } };
  const psvc2 = Object.create(proto2);
  const r2 = ao.installSubagentOrderOn(mkTraceable(psvc2));
  const fetched2 = Reflect.get(mkTraceable(psvc2), 'remoteExportList');
  const out2 = await Reflect.apply(fetched2, { tag: 'other-receiver' }, []);
  check(seenP[0] === psvc2, '代理场景下原方法仍以**裸实例**为 this（不转发外来的 this）', String(seenP[0] && seenP[0].tag));
  check(out2.entries.join('') === 'ba', '代理场景下仍然反转', JSON.stringify(out2.entries));
  ao.uninstallSubagentOrderFrom(psvc2, r2.wrapper);

  // ── ⑧ 防漂移（**源码级接线断言，不是行为断言**）：宿主的排序契约仍是 createdAt 升序 ──
  // 我们**只做 reverse**、不按时间排（线上条目里根本没有 createdAt）⇒ 宿主若把契约改成降序，
  // 我们的"最新在上"会**静默变成"最旧在上"**。本断言在装了宿主的机器上才跑；
  // CI 上没有宿主 ⇒ **明确跳过并打印原因**（不假装通过，也不制造假红）。
  {
    const roots = [process.env.DSH_INSTALL, '/Applications/ServBay/package/node/24/24.14.0/lib/node_modules/@deepseek-ai/dsh'].filter(Boolean);
    let found = null;
    for (const root of roots) {
      const p = join(root, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'types', 'list-children.js');
      try { await (await import('node:fs/promises')).access(p); found = p; break; } catch { /* 换下一个候选路径 */ }
    }
    if (!found) {
      console.log('  · 跳过「宿主排序契约」断言：本机找不到宿主安装（CI 上必然如此）—— **明确跳过，不当作通过**');
    } else {
      const src = await (await import('node:fs/promises')).readFile(found, 'utf8');
      check(/a\.header\.createdAt\s*-\s*b\.header\.createdAt/.test(src),
        '【接线断言】宿主仍按 createdAt **升序**比较 —— 我们只做 reverse，它若反向就会失效', found);
    }
  }

  // ── 接线：command.js 真的装了、且设置一变就重算；状态有只读路由 ──
  const cmdSrc = await (await import('node:fs/promises')).readFile(join(here, 'lib', 'command.js'), 'utf8');
  check(/ctx\.inject\(\[SUBAGENT_ORDER_SERVICE\]/.test(cmdSrc), 'command.js 用 inject 等服务就绪后再装（不赌加载顺序）', '');
  check(/syncSubagentOrder\(sctx\)/.test(cmdSrc), 'inject 回调里同步装载状态', '');
  check(/syncSubagentOrder\(\);\n    return true;/.test(cmdSrc), 'reapplySettingsDerived 里也同步 ⇒ 改设置立刻生效/立刻退回', '');
  check(/disposeSubagentOrder\(\)/.test(cmdSrc), 'dispose 时卸载（删自有属性）', '');
  check(/\/plugins\/dsh-expert-team\/subagent-order/.test(cmdSrc), '有只读状态路由（客户端据此显示"已生效/未生效"）', '');
  check(/未生效：宿主结构不匹配，已退回宿主默认顺序/.test(cmdSrc), '路由话术如实写出"未生效"的成因', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 宿主设置接线测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 宿主设置接线测试通过（schema 单源 / 表达边界清晰 / 成功路径被驱动 / 回退不抛且出声）');
