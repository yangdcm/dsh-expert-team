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
    const: (v) => ({ kind: 'const', value: v }),
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
  check(schema.kind === 'object' && !!schema.shape.identity && !!schema.shape.roster && !!schema.shape.display && !!schema.shape.gates, '四个分组都在 schema 里', Object.keys(schema.shape).join(', '));
  check(schema.shape.roster.shape.maxTasks.kind === 'number', 'int 映射为 number', schema.shape.roster.shape.maxTasks.kind);
  check(z.calls.some(([m, v]) => m === 'min' && v === 0) && z.calls.some(([m, v]) => m === 'max' && v === 5000), 'int 的 min/max 取自 spec（0..5000）', JSON.stringify(z.calls.filter(([m]) => m !== 'default').slice(0, 4)));
  check(z.calls.some(([m, v]) => m === 'default' && v === 200), '默认值取自 spec（maxTasks 默认 200）');
  check(schema.shape.identity.shape.profile.kind === 'union', 'enum 映射为 union(const…)', schema.shape.identity.shape.profile.kind);
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

console.log('');
if (fail > 0) {
  console.log(`✗ 宿主设置接线测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 宿主设置接线测试通过（schema 单源 / 表达边界清晰 / 成功路径被驱动 / 回退不抛且出声）');
