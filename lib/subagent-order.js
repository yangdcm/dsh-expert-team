// 子代理列表「最新在上」—— 宿主 GUI 的**展示顺序**覆盖（batch: subagent-list-order）
//
// ── 它改的到底是哪一层（这决定"会不会骗人"）────────────────────────────────────
// 顺序在服务端是**写明的契约**：`@deepseek-ai/dsh-subagent` 的 `compareCorpusRecords`
// 按 `header.createdAt` **升序**（`list-children.d.ts` 写着 "ordered by createdAt, then id"）。
// **我们不动它。** 同机 `listChildren` / `listDescendants` / 模型侧 `list_agents` 全部照旧。
//
// 我们改的是**送到浏览器的那一份 catalog**：浏览器拿目录走 remote 方法
// `subagents/list`（descriptor：`service:'subagents'`、`method:'list'`、
// `implementation:'remoteExportList'`），而网关**按名字取方法**——
// `const implementation = descriptor.implementation ?? descriptor.method;`
// `const method = Reflect.get(receiver, implementation);`
// （`@deepseek-ai/dsh-api-gateway/lib/types/index.js`）。所以：**在服务实例上定义同名自有属性**
// 即可接管这一次调用，且 `validateBinding` 校验的是**服务身份**（`typertRemote` 的
// `service/serviceKey/namespace`），**不会**触发 `gateway/binding-invalid`。
//
// ── 为什么自有属性能被网关读到（在真实 cordis 4.0.2 上实测过，不是推断）──────────
// `ctx.get('subagents')` 可能返回**每次新建的 traceable 代理**（服务实例带
// `Symbol.for('cordis.tracker')` 时）。实测结论（两种形态都验过）：
//   · 代理**没有 `defineProperty` 陷阱** ⇒ `Object.defineProperty(proxy, …)` 按默认语义
//     落到**裸实例**上（`Object.getOwnPropertyDescriptor(original, 'remoteExportList')` 可见）；
//   · 代理的 `get` 陷阱对**自有 value 属性**直接取 `desc.value`（而不是原型的那个方法），
//     所以网关 `Reflect.get(receiver, 'remoteExportList')` 拿到的是**我们的实现**；
//   · `delete proxy.m` 之后**原型方法自动恢复**。
// ⚠️ 由此得到一条容易写错的判据：**不能用 `fn === 我们的函数`** 判断是否还生效——代理会把
// 函数包成 shadow method（`identityIsPatched === false` 但调用结果正确）。要判定"还在生效"，
// 必须读**自有描述符**：`Object.getOwnPropertyDescriptor(target, METHOD)?.value === wrapper`。
//
// ── 为什么包装函数**不能依赖 `this`**（spike 实测；踩了就白做）──────────────────
// 网关的调用形状是 `Reflect.apply(method, receiver, args)`，而 `receiver` **不是**服务裸实例：
// cordis 的 traceable 代理 + apply trap 会把 `thisArg` 换掉（实测 receiver 形如
// `other:SubagentRuntime`）。所以本模块**捕获裸实例 target**，包装函数**始终以那个 target**
// 作为 `this` 去调原方法，**不转发调用方传来的 `this`** —— 否则原方法可能在错误的 `this` 上执行。
// 同理**不能缓存代理**（`ctx.get(...)` 每次可能返回新代理），锚点只能是 `symbols.original`。
// 这与上面那条"判活只能读自有描述符、不能比函数身份"是同一个根因：
// **代理会改写身份与 `this`，唯一稳定的是裸实例上的自有属性。**

// ── 失败方向（必须"静默退化 + 如实上报"，绝不连累加载）─────────────────────────
// 宿主改名 / 换成别的服务 / 形状变化 ⇒ 我们**不装**，把状态如实标成
// `effective:false` 并给出 `reason`，GUI 退回宿主默认顺序，**插件照常加载**。
// 本仓纪律：界面不许在没生效时让人以为生效。

/** 目标服务名（`ctx.get(...)` 用的键）。 */
export const SUBAGENT_ORDER_SERVICE = 'subagents';
/** 要遮蔽的方法名（网关 `descriptor.implementation`）。 */
export const SUBAGENT_ORDER_METHOD = 'remoteExportList';
/** 单一真源里的设置路径（`lib/settings.js` 的 `SETTINGS_SPEC`）。 */
export const SUBAGENT_ORDER_SETTING = 'display.subagentListNewestFirst';
/** 我们装在自有属性上的标记：用于识别"这是我们装的"，避免误删别人的遮蔽。 */
export const SUBAGENT_ORDER_MARK = '__expertTeamSubagentOrder';
/** cordis 的全局注册符号：traceable 代理上的裸实例（不 import cordis，保住零依赖）。 */
const ORIGINAL = Symbol.for('cordis.original');

/**
 * 取出"裸实例"（可能是代理）。
 * @param {unknown} service
 * @returns {unknown}
 */
export function targetOf(service) {
  if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return service;
  const original = Reflect.get(service, ORIGINAL);
  return original === undefined ? service : original;
}

/**
 * 反转一份 catalog 的 `entries`（**不修改入参**）。
 *
 * 形状不符（没有 `entries` 数组）⇒ `changed:false`，调用方必须**原样返回**，
 * 不许猜结构、不许吞掉。
 *
 * @param {unknown} catalog
 * @returns {{catalog: unknown, changed: boolean}}
 */
export function reverseCatalogEntries(catalog) {
  if (catalog === null || typeof catalog !== 'object') return { catalog: catalog, changed: false };
  const entries = catalog.entries;
  if (!Array.isArray(entries)) return { catalog: catalog, changed: false };
  return { catalog: { ...catalog, entries: entries.slice().reverse() }, changed: true };
}

/**
 * 造一个包装函数：调用原方法，然后反转返回的 catalog。
 *
 * ⚠️ **不依赖 `this`**：`receiver` 是调用方捕获的**裸实例 target**，原方法**始终以它**作为
 * `this` 调用。网关是 `Reflect.apply(method, receiver, args)`，而那个 `receiver` 可能是
 * traceable 代理（apply trap 会换掉 `thisArg`）⇒ 转发调用方的 `this` 是错的。
 *
 * @param {Function} original 宿主上的 `remoteExportList`
 * @param {unknown} receiver 捕获到的裸实例（{@link targetOf} 的结果）
 * @returns {Function}
 */
export function createSubagentOrderWrapper(original, receiver) {
  const wrapper = async function expertTeamSubagentOrderWrapper(...args) {
    const catalog = await Reflect.apply(original, receiver, args);
    const out = reverseCatalogEntries(catalog);
    return out.changed ? out.catalog : catalog;
  };
  Object.defineProperty(wrapper, SUBAGENT_ORDER_MARK, { value: true, enumerable: false });
  return wrapper;
}

/**
 * 在服务实例上装遮蔽（幂等）。
 * @param {unknown} service
 * @returns {{ok: boolean, reason: string, wrapper?: Function, original?: Function}}
 */
export function installSubagentOrderOn(service) {
  if (service === null || (typeof service !== 'object' && typeof service !== 'function')) {
    return { ok: false, reason: 'service-missing' };
  }
  const existing = Object.getOwnPropertyDescriptor(service, SUBAGENT_ORDER_METHOD);
  if (existing && existing.value && existing.value[SUBAGENT_ORDER_MARK] === true) {
    return { ok: true, reason: 'already-installed', wrapper: existing.value };
  }
  if (existing && !existing.value) {
    // 访问器属性：说明宿主换了形态，我们**不动它**。
    return { ok: false, reason: 'host-method-is-accessor' };
  }
  const original = Reflect.get(service, SUBAGENT_ORDER_METHOD);
  if (typeof original !== 'function') return { ok: false, reason: 'host-method-missing' };
  // `receiver` 必须是**裸实例**：本函数可能收到代理（测试或其它调用方），而包装函数
  // 不能依赖调用方传来的 `this`（见文件头"为什么包装函数不能依赖 this"）。
  const receiver = targetOf(service) ?? service;
  const wrapper = createSubagentOrderWrapper(original, receiver);
  try {
    Object.defineProperty(service, SUBAGENT_ORDER_METHOD, {
      value: wrapper, writable: true, configurable: true, enumerable: false,
    });
  } catch (e) {
    return { ok: false, reason: 'define-failed:' + String((e && e.message) || e) };
  }
  // 复核：读**自有描述符**（不能用 `fn === wrapper`，代理会包 shadow method —— 见文件头注释）。
  const after = Object.getOwnPropertyDescriptor(service, SUBAGENT_ORDER_METHOD);
  if (!after || after.value !== wrapper) return { ok: false, reason: 'verify-failed', wrapper };
  return { ok: true, reason: existing ? 'installed-over-existing' : 'installed', wrapper, original };
}

/**
 * 卸掉遮蔽（只卸**我们自己装的**）。
 * @param {unknown} service
 * @param {Function} [wrapper]
 * @returns {{ok: boolean, reason: string}}
 */
export function uninstallSubagentOrderFrom(service, wrapper) {
  if (service === null || (typeof service !== 'object' && typeof service !== 'function')) {
    return { ok: false, reason: 'service-missing' };
  }
  const own = Object.getOwnPropertyDescriptor(service, SUBAGENT_ORDER_METHOD);
  if (!own) return { ok: true, reason: 'nothing-installed' };
  const ours = wrapper !== undefined
    ? own.value === wrapper
    : !!(own.value && own.value[SUBAGENT_ORDER_MARK] === true);
  if (!ours) return { ok: false, reason: 'not-ours' };
  try {
    delete service[SUBAGENT_ORDER_METHOD];
  } catch (e) {
    return { ok: false, reason: 'delete-failed:' + String((e && e.message) || e) };
  }
  if (Object.getOwnPropertyDescriptor(service, SUBAGENT_ORDER_METHOD)) {
    return { ok: false, reason: 'delete-failed' };
  }
  return { ok: true, reason: 'removed' };
}

/** 最近一次安装结果（给设置页**如实**展示：装了没生效必须说出来）。 */
const STATUS = {
  enabled: false, installed: false, effective: false, reason: 'idle', checkedAt: 0,
};

/** @returns {{enabled: boolean, installed: boolean, effective: boolean, reason: string, checkedAt: number}} */
export function subagentOrderStatus() {
  return { ...STATUS };
}

/** 测试用：清空状态与已安装记录。 */
export function _resetSubagentOrder() {
  INSTALLED = null;
  STATUS.enabled = false;
  STATUS.installed = false;
  STATUS.effective = false;
  STATUS.reason = 'idle';
  STATUS.checkedAt = 0;
}

/** 当前已安装的 {@link {service: unknown, wrapper: Function}}（未装为 null）。 */
let INSTALLED = null;

/**
 * 解析宿主服务。
 * @param {any} ctx
 * @returns {unknown}
 */
function resolveService(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const svc = ctx.get(SUBAGENT_ORDER_SERVICE);
      if (svc !== undefined && svc !== null) return svc;
    }
    if (ctx && ctx[SUBAGENT_ORDER_SERVICE] !== undefined) return ctx[SUBAGENT_ORDER_SERVICE];
  } catch {
    /* 服务未就绪/不可解析 ⇒ 返回 undefined，由调用方如实记 reason */
  }
  return undefined;
}

/**
 * 按设置值同步装载状态：开 ⇒ 装（幂等）；关 ⇒ 卸。**任何异常都不外抛**，
 * 只把结果如实记进 `STATUS`。
 *
 * @param {any} ctx
 * @param {boolean} enabled
 * @returns {{enabled: boolean, installed: boolean, effective: boolean, reason: string, checkedAt: number}}
 */
export function applySubagentOrder(ctx, enabled) {
  STATUS.enabled = !!enabled;
  STATUS.checkedAt = Date.now();
  const service = resolveService(ctx);
  // 服务实例可能是**每次新建的代理** ⇒ 身份比较必须落在裸实例上。
  const target = targetOf(service);

  if (!STATUS.enabled) {
    if (INSTALLED) {
      uninstallSubagentOrderFrom(INSTALLED.service, INSTALLED.wrapper);
      INSTALLED = null;
    }
    STATUS.installed = false;
    STATUS.effective = false;
    STATUS.reason = 'disabled';
    return subagentOrderStatus();
  }
  if (target === undefined || target === null) {
    STATUS.installed = false;
    STATUS.effective = false;
    STATUS.reason = 'service-missing';
    return subagentOrderStatus();
  }
  if (INSTALLED && targetOf(INSTALLED.service) === target) {
    // 同一实例：确认我们的自有属性还在（宿主可能换过实现）。
    const own = Object.getOwnPropertyDescriptor(target, SUBAGENT_ORDER_METHOD);
    if (own && own.value === INSTALLED.wrapper) {
      STATUS.installed = true;
      STATUS.effective = true;
      STATUS.reason = 'installed';
      return subagentOrderStatus();
    }
    INSTALLED = null;   // 我们的遮蔽不见了 ⇒ 重新装
  } else if (INSTALLED) {
    uninstallSubagentOrderFrom(INSTALLED.service, INSTALLED.wrapper);   // 服务换了实例
    INSTALLED = null;
  }

  const result = installSubagentOrderOn(target);
  if (result.ok && result.wrapper) {
    INSTALLED = { service: target, wrapper: result.wrapper };
    STATUS.installed = true;
    STATUS.effective = true;
    STATUS.reason = result.reason;
  } else {
    STATUS.installed = false;
    STATUS.effective = false;
    STATUS.reason = result.reason;
  }
  return subagentOrderStatus();
}

/**
 * 卸载（插件 dispose / 关掉开关时用）。幂等、不外抛。
 * @returns {{ok: boolean, reason: string}}
 */
export function disposeSubagentOrder() {
  if (!INSTALLED) {
    STATUS.installed = false;
    STATUS.effective = false;
    if (STATUS.reason !== 'disabled') STATUS.reason = 'disposed';
    return { ok: true, reason: 'nothing-installed' };
  }
  const r = uninstallSubagentOrderFrom(INSTALLED.service, INSTALLED.wrapper);
  INSTALLED = null;
  STATUS.installed = false;
  STATUS.effective = false;
  STATUS.reason = 'disposed';
  return r;
}
