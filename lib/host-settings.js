// 宿主设置命名空间接线（1.2.0）
//
// ── 为什么要有它（三条具体收益，不是"架构更漂亮"）────────────────────────────
//   ① 设置出现在 **设置 → 插件 → 插件配置**：由宿主按我们给的 schema 渲染，插件不必自己画表单；
//   ② 随插件市场的**备份与恢复**一起走 —— 市场只备份"profile 插件清单 + 设置"，自造的
//      `settings.json` 不在它的备份范围里；
//   ③ 值改变能**立刻生效**：`scope.watch()` 一到，重算上限/轮次/档位门，不必重启。
//
// ── 为什么用**动态 import**，而不是像 dshmarket 那样静态 import schemastery ──────────
//   dshmarket 那样写是对的：它的包只会在 profile 里被加载，`@deepseek-ai/schemastery`
//   在 profile 的上一级 node_modules 里解析得到。但**本仓的 76 个测试文件都从仓库路径**
//   import `lib/command.js` —— 仓库不在任何 profile 里，静态 import 会直接
//   ERR_MODULE_NOT_FOUND，把整套测试带崩（这正是"零依赖、CI 免 install"的代价）。
//   动态 import 失败 ⇒ 优雅回退到 settings.json，行为与 1.1.x 一致；成功 ⇒ 上一个微任务后注册完成。
//
// ── 优先级（未变）：config > env > **设置** > 内置默认 ──────────────────────────
//   宿主可用时，"设置"这一档 = 宿主命名空间的解析值，其构成为
//   `schema 默认 < 我们传入的 base < 用户在官方面板的覆盖`；base 用**当前生效设置**填充，
//   所以面板一打开看到的就是真正在用的值（不需要任何一次性迁移）。
//   宿主不可用（或 schemastery 解析不到）时，"设置"这一档 = `$DSH_HOME/expert-team/settings.json`。

import { SETTINGS_GROUPS, SETTINGS_SPEC, flatSpec } from './settings.js';

/** 注册到宿主的命名空间（宿主对命名空间有文法要求：小写字母/数字/短横线）。 */
export const HOST_SETTINGS_NAMESPACE = 'expert-team';

/**
 * 能上官方面板的类型。
 *
 * `roles` 刻意**不上**：它的取值是"角色 id 数组或 null"，在 schemastery 里要表达成
 * `union([const(null), array(string)])`，跨版本行为没把握；一旦 schema 建错，宿主会拒绝注册
 * 甚至让整条插件挂不上。这个字段继续由浮层的设置页签 + settings.json 负责，
 * 官方页面只显示其余三类（bool / int / enum）。少一个开关，好过"注册失败、面板里什么都不出现"。
 */
const HOST_SCHEMA_TYPES = new Set(['bool', 'int', 'enum']);

/** 宿主 schema 覆盖的扁平路径（`identity.profile` 这种）。 */
export function hostSchemaPaths() {
  return Object.entries(flatSpec())
    .filter(([, item]) => HOST_SCHEMA_TYPES.has(item.type))
    .map(([path]) => path);
}

/**
 * 由我们的 `SETTINGS_SPEC` 生成嵌套的 schemastery schema。
 *
 * 单一真源：字段、取值范围、默认值全部来自 `lib/settings.js` 的 spec —— 不在这里抄第二份。
 * 代价是必须**容忍 schemastery 的 API 差异**：只有确实存在的方法才调用（`.min/.max/.default`）。
 *
 * @param z - schemastery 的默认导出（由调用方动态 import 得到）。
 */
export function buildHostSchema(z) {
  const shape = {};
  for (const group of SETTINGS_GROUPS) {
    const inner = {};
    for (const [key, item] of Object.entries(SETTINGS_SPEC[group].items)) {
      if (!HOST_SCHEMA_TYPES.has(item.type)) continue;
      let field;
      if (item.type === 'bool') field = z.boolean();
      else if (item.type === 'int') {
        field = z.number();
        if (item.min != null && typeof field.min === 'function') field = field.min(item.min);
        if (item.max != null && typeof field.max === 'function') field = field.max(item.max);
      } else {
        // 枚举：值域仍是 `union([const(v)…])`（**类型/值域不动**）；若规格层给了中文标签，
        // 就在成员上挂 `.description(label)`。可行性已实测：真 schemastery 下 schema 照常建成，
        // 标签进了成员的 `meta.description`（该方法的类型注释写明"for documentation or form UIs"）。
        // 方法不存在时**跳过**（本模块既定纪律：只有确实存在的方法才调用 —— 这里对应宿主/版本差异）。
        field = z.union(item.values.map((v) => {
          const c = z.const(v);
          const label = item.labels && item.labels[v];
          return label && typeof c.description === 'function' ? c.description(label) : c;
        }));
      }
      if (typeof field.default === 'function') field = field.default(item.default);
      inner[key] = field;
    }
    if (Object.keys(inner).length) shape[group] = z.object(inner);
  }
  return z.object(shape);
}

/** 从"当前生效设置"里挑出宿主能表达的那些（用作 `register(..., { base })`）。 */
export function hostBase(settings) {
  const out = {};
  for (const path of hostSchemaPaths()) {
    const [group, key] = path.split('.');
    const value = settings && settings[group] ? settings[group][key] : undefined;
    if (value === undefined || value === null) continue;
    out[group] = out[group] || {};
    out[group][key] = value;
  }
  return out;
}

/**
 * 把补丁裁成"宿主能表达"的嵌套对象。
 * 补丁同时支持嵌套（`{roster:{maxTasks:10}}`）与扁平（`{'roster.maxTasks':10}`），与
 * `mergeSettings` 同口径 —— 否则同一份补丁在两处会有两种解释。
 */
export function pickHostExpressible(patch) {
  const flat = {};
  const put = (path, value) => {
    const item = flatSpec()[path];
    if (!item || !HOST_SCHEMA_TYPES.has(item.type)) return;
    flat[path] = value;
  };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes('.')) { put(k, v); continue; }
      if (!SETTINGS_SPEC[k] || !v || typeof v !== 'object' || Array.isArray(v)) continue;
      for (const [k2, v2] of Object.entries(v)) put(`${k}.${k2}`, v2);
    }
  }
  const out = {};
  for (const [path, value] of Object.entries(flat)) {
    const [group, key] = path.split('.');
    out[group] = out[group] || {};
    out[group][key] = value;
  }
  return out;
}

/** 补丁里**宿主表达不了**的那部分（继续由 settings.json 负责）。 */
export function pickFileOnly(patch) {
  const expressible = pickHostExpressible(patch);
  const out = {};
  const put = (path, value) => {
    const item = flatSpec()[path];
    if (!item || HOST_SCHEMA_TYPES.has(item.type)) return;
    const [group, key] = path.split('.');
    out[group] = out[group] || {};
    out[group][key] = value;
  };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (k.includes('.')) { put(k, v); continue; }
      if (!SETTINGS_SPEC[k] || !v || typeof v !== 'object' || Array.isArray(v)) continue;
      for (const [k2, v2] of Object.entries(v)) put(`${k}.${k2}`, v2);
    }
  }
  void expressible;
  return out;
}

// ── 运行时状态（进程内单例；插件卸载时清空）──────────────────────────────────

/** 已注册的宿主作用域；null = 宿主没有 settings 服务（或还没注册完）。 */
let HOST_SCOPE = null;
/** 最近一次从宿主读到的解析值。 */
let HOST_VALUES = null;
/** 注册失败的原因（供 `/team status` 与诊断如实显示）。 */
let HOST_NOTE = '';

/**
 * 把设置注册进宿主命名空间。**同步返回**，注册本身在下一次微任务完成（动态 import）。
 *
 * @param ctx - 插件上下文（用 `ctx.inject(['settings'], …)` 作为优雅降级边界：宿主没有该服务时回调不执行）
 * @param options.base - 当前生效设置（决定面板初始值）
 * @param options.onResolved - 拿到（或更新）宿主解析值时的回调；用于重算上限/档位
 * @param options.loadSchema - **仅供测试**注入 schema 加载器（默认动态 import schemastery）。
 *   仓库里解析不到 schemastery，没有这个接缝就只能测到"回退"那一半，成功路径永远没被测过。
 * @returns 是否成功挂上了 inject（不代表注册已完成）
 */
export function installHostSettings(ctx, { base, onResolved, loadSchema } = {}) {
  if (!ctx || typeof ctx.inject !== 'function') return false;
  const load = typeof loadSchema === 'function' ? loadSchema : () => import('@deepseek-ai/schemastery');
  try {
    ctx.inject(['settings'], (scoped) => {
      const service = scoped && scoped.settings;
      if (!service || typeof service.register !== 'function') return;
      load().then((mod) => {
        const z = (mod && mod.default) ? mod.default : mod;
        const scope = service.register(HOST_SETTINGS_NAMESPACE, buildHostSchema(z), { base: hostBase(base) });
        HOST_SCOPE = scope;
        const push = () => {
          try {
            HOST_VALUES = typeof scope.get === 'function' ? scope.get() : null;
            if (onResolved) onResolved(HOST_VALUES);
          } catch (e) {
            HOST_NOTE = '读取宿主设置失败：' + String(e && e.message ? e.message : e);
          }
        };
        try { if (typeof scope.watch === 'function') scope.watch(() => push()); } catch { /* watch 缺失不该影响注册 */ }
        push();
        if (typeof scoped.effect === 'function') {
          scoped.effect(() => () => { HOST_SCOPE = null; HOST_VALUES = null; });
        }
        console.log(`[expert-team] 设置已注册到宿主命名空间「${HOST_SETTINGS_NAMESPACE}」（官方面板可改，且随市场备份/恢复）`);
      }).catch((e) => {
        HOST_NOTE = 'schemastery 不可解析，保持 settings.json：' + String(e && e.message ? e.message : e);
        console.warn('[expert-team] ' + HOST_NOTE);
      });
    });
    return true;
  } catch (e) {
    HOST_NOTE = 'inject(settings) 失败：' + String(e && e.message ? e.message : e);
    console.warn('[expert-team] ' + HOST_NOTE);
    return false;
  }
}

/** 宿主作用域是否已就绪。 */
export function hostScope() { return HOST_SCOPE; }
/** 最近一次宿主解析值（null = 未就绪）。 */
export function hostValues() { return HOST_VALUES; }
/** 诊断文案（为什么没用上宿主设置）。 */
export function hostSettingsNote() { return HOST_NOTE; }

/**
 * 把补丁写进宿主命名空间（只写它表达得了的那部分）。
 * @returns `{ ok: true, written: 命中字段数 }`，或 `{ ok: false, reason }`
 */
export async function updateHostSettings(patch) {
  if (!HOST_SCOPE || typeof HOST_SCOPE.update !== 'function') return { ok: false, reason: 'no-host-scope' };
  const expressible = pickHostExpressible(patch);
  const groups = Object.keys(expressible);
  const count = groups.reduce((n, g) => n + Object.keys(expressible[g]).length, 0);
  if (count === 0) return { ok: false, reason: 'nothing-expressible' };
  try {
    await HOST_SCOPE.update(expressible);
    return { ok: true, written: count };
  } catch (e) {
    return { ok: false, reason: 'update-failed', error: String(e && e.message ? e.message : e) };
  }
}
