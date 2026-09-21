// 工件写入的**单一受控入口**（批 2-1 · L2-3 · 2-2 的共同载体）
//
// 为什么需要它（来自 ROI-REVIEW 的架构仲裁）：
//   · 宿主**早就有**文件级 CAS：`@deepseek-ai/dsh-fs` 的
//     `FsWriteIntent = {kind:'createIfAbsent'} | {kind:'replaceIfVersion', version}` 与
//     `writeText(target, content, expected?)`，provider 在版本失配时报 `FS_STALE_VERSION`；
//     `dsh-fs-observation-policy` 已挂在 `dsh-base`。
//   · 而我方 `lib/command.js` 用 `node:fs/promises` **直写 30+ 处**，**绕过了这把现成的栅栏**。
//   · ⇒ 所以「跨会话写仲裁」不是宿主级大工程，而是**我方写入路径的改造**。
//
// 本模块把改造所需的四件事收进一个入口，避免各写点各写一套：
//   ① 版本栅栏（expected version → replaceIfVersion；失配走重试而非静默覆盖）
//   ② **陈旧重试**（重读 → 重新基线 → 重试一次 → 仍失败才上抛）
//      —— 缺这条时，加栅栏的净效果只是"把静默丢更新换成用户可见的失败"，属降级。
//   ③ **范围硬排除**（L2-3）：默认禁写区一律拒绝，且**不是告警而是拒绝**
//   ④ revision 记账：写入即自增，读到回退/跳变即 loud（拦不住 lead 用 write 工具直写，
//      但能把"被别人改过"这件事变成可见事实）
//
// 设计约束：**不 import 任何宿主包**，只依赖注入的 `fsPort`，因此既能在宿主里跑（注入 `ctx.fs`），
// 也能在纯 Node 测试里跑（注入本文件提供的 `nodeFsPort()`）。
//
// ⚠️ 一个真实陷阱（架构师实测）：`fs/write-intent` 是**工具层**（`dsh-tool-fs`）dispatch 的，
//    **不是** `ctx.fs` 服务 dispatch 的。所以直连 `ctx.fs.writeText` 时**必须自己传 `expected`**，
//    不能指望 intent 监听器替你算。

import { readFile as nodeReadFile, writeFile as nodeWriteFile, stat as nodeStat, unlink as nodeUnlink } from 'node:fs/promises';

/** 默认禁写区（L2-3）：密钥/凭据/版本库元数据/宿主配置 —— 命中即拒绝，不给"仅告警"的余地。 */
export const DEFAULT_EXCLUSIONS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?(\/|$)/i,
];

/** 判断路径是否命中禁写区；返回命中的规则（无则 null）。 */
export function scopeViolation(target, exclusions = DEFAULT_EXCLUSIONS) {
  const p = String(target || '');
  for (const re of exclusions) if (re.test(p)) return String(re);
  return null;
}

/** 从文本里取出 revision（JSON 对象且含数字 revision 时）；取不到返回 null。 */
export function readRevision(text) {
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object' && Number.isSafeInteger(o.revision)) return o.revision;
  } catch { /* 非 JSON */ }
  return null;
}

/**
 * 纯 Node 的 fsPort（测试与"宿主不可用时的回退"用）。
 * 它**自己实现**版本栅栏语义，以复现宿主 `replaceIfVersion` 的行为：
 * `statVersion` 给出版本指纹，`writeText` 在 `intent.kind==='replaceIfVersion'` 且版本不符时抛 `FS_STALE_VERSION`。
 */
export function nodeFsPort() {
  const versionOf = async (p) => {
    try {
      const st = await nodeStat(p);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null; // 不存在
    }
  };
  return {
    kind: 'node:fs',
    async readText(p) {
      try { return await nodeReadFile(p, 'utf8'); } catch { return null; }
    },
    async statVersion(p) { return versionOf(p); },
    async writeText(p, content, intent) {
      if (intent && intent.kind === 'replaceIfVersion') {
        const cur = await versionOf(p);
        if (cur !== intent.version) {
          const err = new Error(`FS_STALE_VERSION: ${p}`);
          err.code = 'FS_STALE_VERSION';
          throw err;
        }
      }
      await nodeWriteFile(p, content);
    },
  };
}

/**
 * 把宿主的 `ctx.fs` 适配成 fsPort。
 * 注意 `expected` 必须由调用方给出（见文件头陷阱说明）。
 *
 * `resolvePolicy(targetPath)`（可选）：解析**本次调用**的沙箱授权凭据（`{mode, workspaceRoot, sessionId?}`）。
 * 入参是**本次要写的目标路径**（artifact-writer 交给 `writeText` 的那个 `target`）——
 * 授权必须由**被写目录**决定，不能由"环境里最后见过的会话"决定：同一进程里多个写入点会写
 * **不属于当前会话**的工作区（`GET /state` 浮层写用户正在看的那个 run、`/decide`·`/plan` 写
 * `body.workspace`、`dispatchLedger` 写执行者会话的 cwd），按环境会话授权会把它们判成越界
 * （Issue #1 修复引入的新失败方向，独立评审发现）。解析器**可以忽略这个入参**（旧签名仍然工作）。
 * 它为什么必须存在、且必须一路透传（Issue #1，根因与证据见
 * `docs/专家团-Issue1-跨目录写入根因与修复方案.md` 第三章）：
 *   · 宿主 `@deepseek-ai/dsh-fs-sandbox` 的签名是
 *     `writeText(target, content, expected?, signal?, sandboxPolicy?)` —— **第 5 参才是授权凭据**。
 *     它进 `checkedTarget` 做 `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`，
 *     围栏判定只用这一个值：`workspace-write` 下目标必须落在 `writableRoots(policy)`
 *     （= `{policy.workspaceRoot, '/tmp', os.tmpdir()}`）之内，否则抛 `FS_SANDBOX_DENIED`。
 *   · 本适配层早先**只传 3 个参数**：宿主于是走 `resolve()` 的**无会话**分支 ⇒
 *     `workspaceRoot = config.workspaceRoot ?? process.cwd()`；而 `dsh-base` 的 `cordis.patch.yml`
 *     把 `workspaceRoot` 显式钉成 `process.cwd()`，即**启动 DSH 的目录**。
 *   · 后果：会话项目目录与启动目录不同时，写 `<项目目录>/team/<runId>/...` 被判越界，
 *     第一个模板即失败（现象：目录建好了——`mkdir` 走裸 `node:fs`、不过沙箱——却一个工件也写不进去）。
 *   · 宿主官方写入链路 `dsh-tool-fs` 正是**两个都传**：`resolve(path, {cwd: policy.workspaceRoot})`
 *     **加** `writeText(..., signal, policy)`。本适配层对齐它，缺一不可。
 *   · **只给 `resolve` 传 cwd 修不好本缺陷**：那个 cwd 只影响相对路径解析，`checkedTarget` 会在
 *     忽略它的前提下重新 canonicalize 并按授权参数判定归属（见方案 6.4）。
 *
 * 缺省 `null` = 不解析（旧调用方行为不变）。解析器返回 `undefined`/`null` = 本次没有授权凭据 ⇒
 * 回落宿主部署根，与修复前**完全一致**（"拿不到会话"不被放大成新的写入失败）。
 *
 * `onEvent`（可选）：与 `createArtifactWriter({onEvent})` **同一个通道**（调用方传同一个
 * `writerEvents`）。本适配层只用它上报 `{type:'policy-resolve-error', target, error}` ——
 * 解析器抛错**仍然降级**（不阻断这次写入），但"降级"不再无声：授权解析失败会把围栏静默地
 * 从「会话项目目录」退回「宿主部署根」，正是最难被发现的一类回归（独立评审判定）。
 */
export function cordisFsPort(ctxFs, resolvePolicy = null, onEvent = null) {
  return {
    kind: 'ctx.fs',
    // 读路径**不**按写入围栏判定（`fs-sandbox` 只对 mutation 做 checkedTarget），故这条链路不变。
    async readText(p) {
      const t = await ctxFs.resolve(p);
      try { return await ctxFs.readText(t); } catch { return null; }
    },
    async statVersion(p) {
      try {
        const t = await ctxFs.resolve(p);
        const st = await ctxFs.stat(t);
        return st && st.version != null ? String(st.version) : null;
      } catch {
        return null;
      }
    },
    async writeText(p, content, intent) {
      // 授权按「本次调用」解析，且**按本次要写的目标路径**解析（`p` 就是下面要写的那条路径）：
      // 授权必须由被写目录决定 —— 同一进程会写不属于当前会话的工作区（见 `resolvePolicy` 处的说明）。
      // 解析器抛错 ⇒ 退化为"无授权"（今天的部署根行为），而不是让一次本可成功的写入失败
      // —— 降级方向必须是"更接近修复前"，不是"更容易失败"；但降级本身**不静默**（见下方事件）。
      let policy;
      if (resolvePolicy) {
        try {
          policy = await resolvePolicy(p);
        } catch (e) {
          policy = undefined;
          if (typeof onEvent === 'function') {
            try { onEvent({ type: 'policy-resolve-error', target: p, error: String((e && e.message) || e) }); } catch { /* 观测不该影响写入 */ }
          }
        }
      }
      // 相对路径按授权根解析（绝对路径不受影响）；这与宿主官方 write.ts 同形状。
      const t = await ctxFs.resolve(p, policy && policy.workspaceRoot ? { cwd: policy.workspaceRoot } : undefined);
      // 第 4 参 `signal`：工件写入路径这一层没有 `exec`（见方案 §9 未决问题 7），显式传 `undefined`；
      // 第 5 参 `sandboxPolicy` 是授权凭据，**必须**透传（Issue #1 的全部机制就在这一个参数上）。
      return ctxFs.writeText(t, content, intent, undefined, policy || undefined);
    },
  };
}

/**
 * 内建 schema 告警（批 2-4 · L1-4′）。
 *
 * **只告警、不硬拒** —— 刻意如此：`listRuns` 对不合规的 STATE.json 是 catch 后静默跳过，
 * 若写入侧硬拒，旧 run 会从 `/team status` 与浮层里**静默消失**，比"容忍脏数据"更糟。
 *
 * 它要修的是一类**已被实证的静默伤害**：本 run 自己的 `STATE.coverage` 曾被写成
 * **角色名字符串数组**（`["pm","architect",…]`），而消费端用
 * `Array.isArray(state.coverage) ? state.coverage : []` 兜底 ⇒ 渲染成一串空行，
 * **生产端违约 + 消费端静默吞**，没有任何人被告知。
 *
 * 每个 guard 返回 `warnings: string[]`（空数组 = 合规），由 write() 经 `schema-warn` 事件上报。
 */
export const DEFAULT_SCHEMA_GUARDS = {
  'STATE.json': (v) => {
    const w = [];
    if (v.coverage !== undefined) {
      if (!Array.isArray(v.coverage)) w.push('coverage 应为数组（schema: [{constraint, tasks}]）');
      else if (v.coverage.some((c) => c === null || typeof c !== 'object' || Array.isArray(c))) {
        w.push('coverage 的元素应为对象 {constraint, tasks}；检测到非对象元素（下游会静默兜底并渲染空行）');
      }
    }
    if (v.members !== undefined && !Array.isArray(v.members)) w.push('members 应为数组');
    if (v.phase !== undefined && typeof v.phase !== 'string') w.push('phase 应为字符串');
    if (v.status !== undefined && typeof v.status !== 'string') w.push('status 应为字符串');
    if (v.planDiscarded !== undefined && (v.planDiscarded === null || typeof v.planDiscarded !== 'object')) {
      w.push('planDiscarded 应为对象 {at, reason, goalKey}');
    }
    return w;
  },
  'TASKS.json': (v) => {
    const w = [];
    if (!Array.isArray(v.tasks)) w.push('tasks 应为数组');
    else if (v.tasks.some((t) => t === null || typeof t !== 'object' || Array.isArray(t) || typeof t.id !== 'string' || !t.id)) {
      w.push('tasks 的元素应为对象且带非空字符串 id');
    }
    return w;
  },
};

/**
 * 创建受控写入器。
 * @param fsPort       注入口（`nodeFsPort()` 或 `cordisFsPort(ctx.fs)`）
 * @param exclusions   禁写区规则（默认 DEFAULT_EXCLUSIONS）
 * @param onEvent      可选事件回调（用于把重试/拒绝/schema 告警写进 RUN.log）
 * @param schemaGuards 按**文件名**匹配的 schema 告警器（默认 DEFAULT_SCHEMA_GUARDS）；只告警不阻断
 * @param identity     写入者身份（`() => ({sessionId, runId, role})` 或对象）；用于**归因**（批 2-3 · L1-3′）
 */
export function createArtifactWriter({ fsPort, exclusions = DEFAULT_EXCLUSIONS, onEvent = () => {}, schemaGuards = DEFAULT_SCHEMA_GUARDS, identity = null } = {}) {
  if (!fsPort) throw new Error('createArtifactWriter 需要 fsPort');

  /**
   * 归因（批 2-3 · L1-3′）：直接闭合 ROI 评审里的
   * **R-3「漂移不可归因：只能证明文件被改写，不能证明写入进程身份」**。
   *
   * 做法：
   *   · 对象工件写入时附带 `_provenance = { writer, at }`（writer 来自 identity）；
   *   · 每次写入前读回磁盘上的 `revision` 与 `_provenance.writer`：
   *       - **revision 比本进程上次写的更小** ⇒ `revision-regression`（有人把文件回退了）
   *       - **writer 与本进程身份不同** ⇒ `writer-changed`（别的写者动过）
   *   · 两者都**只上报、不阻断**（与 schema 告警同一取向：宁可响亮，不要静默，但不要因此让 run 失败）。
   *
   * 注意：本进程内记忆（`lastWritten`）只覆盖**本进程**写过的目标；跨进程回退无法可靠判定
   * ——所以 writer 变化才是跨进程归因的主要信号。
   */
  const lastWritten = new Map(); // target -> 本进程最后写入的 revision

  // ── C1：跨进程互斥（advisory lock）─────────────────────────────────────
  // 为什么需要：本进程内的 `revision`/`lastWritten` 只覆盖**本进程**；实测场景是**另一个 dsh
  // 会话持续改写同一个工件**（两个进程各自有自己的 ARTIFACT 实例，互不感知）。
  // 版本栅栏能拦住"别人已写完"，但拦不住"别人**正在**写" ⇒ 两个进程可以同时读到 rev N、
  // 各自写、后写覆盖先写。这把**写入点**用一个 `<target>.etv-lock` 文件序列化：
  //   · 拿不到锁 ⇒ 等待并重试（默认最多 ~5s），**不**静默覆盖；
  //   · 锁文件超过 staleMs（默认 30s）视为"写者已死"⇒ 接管（进程崩溃不会永久死锁）；
  //   · 超时仍拿不到 ⇒ 抛 `WRITE_LOCK_TIMEOUT`，让调用方知道"有别的写者在写"。
  // 只锁**写入**，不锁读 —— 读不加锁，CAS 在写侧兜底（重试时重新基线）。
  const WRITE_LOCK_STALE_MS = 30000;
  const WRITE_LOCK_TIMEOUT_MS = 5000;
  async function acquireWriteLock(target, { timeoutMs = WRITE_LOCK_TIMEOUT_MS, staleMs = WRITE_LOCK_STALE_MS } = {}) {
    const lockPath = `${target}.etv-lock`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await nodeWriteFile(lockPath, `${process.pid} ${Date.now()}`, { flag: 'wx' });
        return { release: async () => { try { await nodeUnlink(lockPath); } catch { /* 已被别人接管 */ } } };
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
        try {
          const st = await nodeStat(lockPath);
          if (Date.now() - st.mtimeMs > staleMs) { try { await nodeUnlink(lockPath); } catch { /* best-effort */ } continue; }
        } catch { continue; } // 读完就没了，重试
        if (Date.now() > deadline) {
          const err = new Error(`WRITE_LOCK_TIMEOUT: ${target}（超过 ${timeoutMs}ms 拿不到写锁 ⇒ 有别的写者正在写）`);
          err.code = 'WRITE_LOCK_TIMEOUT';
          throw err;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
    }
  }
  const identityOf = () => {
    try {
      const id = typeof identity === 'function' ? identity() : identity;
      return id && typeof id === 'object' ? id : null;
    } catch {
      return null;
    }
  };
  const identityKey = () => {
    const id = identityOf();
    if (!id) return null;
    return [id.sessionId || '', id.runId || '', id.role || ''].join('|');
  };

  /**
   * 写入一个工件。
   * @param target            目标路径
   * @param content           字符串（原样写）或对象（会被 JSON 序列化，并自动维护 revision）
   * @param expectedRevision  调用方认为的当前 revision；不符则走"重读→重基线→重试一次"
   * @param maxAttempts       含首次的总尝试次数（默认 2 = 首次 + 重试一次）
   * @returns {ok, revision, attempts, error?, code?, violation?, schemaWarnings?, provenance?}
   */
  async function write(target, content, { expectedRevision = null, maxAttempts = 2 } = {}) {
    // ① 范围硬排除：先拦，不进入任何 IO
    const violation = scopeViolation(target, exclusions);
    if (violation) {
      onEvent({ type: 'scope-denied', target, rule: violation });
      return { ok: false, code: 'SCOPE_DENIED', violation, error: `拒绝写入禁写区（命中规则 ${violation}）：${target}` };
    }

    // C1：写入前持**跨进程锁**。CAS 能拦住"别人已写完"，拦不住"别人**正在**写"；
    // 这里把写入序列化，让两个进程不会在同一窗口里同时 read-modify-write。
    // 锁是 advisory 的：死锁由 staleMs 兜底（进程崩了别人也能接管），不会永久卡死。
    // ⚠️ 只有真实的**本地文件系统**才锁：cordisFsPort 的 `resolve` 会把目标解析成
    // `host://` 前缀（宿主虚拟路径），而锁用 nodeWriteFile 写的是**真实磁盘文件** —
    // 在 cordis 路径上锁路径根本不存在，会让写入直接 ENOENT（此时锁由宿主版本栅栏兜底）。
    const useLock = fsPort && fsPort.kind === 'node:fs';
    if (!useLock) return writeOnce(target, content, { expectedRevision, maxAttempts });
    const lock = await acquireWriteLock(target).catch((e) => {
      // 拿不到锁（包括超时）不应让整个进程抛错 —— 把它变成写失败的**返回**，
      // 与 write() 的其余失败形态（{ok:false, code}）一致，让调用方能正常处理。
      return { lockError: e };
    });
    if (lock.lockError) {
      const code = lock.lockError && lock.lockError.code === 'WRITE_LOCK_TIMEOUT' ? 'WRITE_LOCK_TIMEOUT' : 'LOCK_FAILED';
      return { ok: false, code, error: String((lock.lockError && lock.lockError.message) || lock.lockError) };
    }
    try {
      return await writeOnce(target, content, { expectedRevision, maxAttempts });
    } finally {
      await lock.release();
    }
  }

  async function writeOnce(target, content, { expectedRevision = null, maxAttempts = 2 } = {}) {
    // ⚠️ 只有**纯对象**才走"JSON 序列化 + revision + 归因"路径。
    // 曾经的写法是 `typeof content === 'object'` —— 但 **Buffer / Uint8Array / Array 也是 object**，
    // 于是模板拷贝（`readFile(url)` 不带编码返回 Buffer）会被 `{...buffer}` 展开成
    // `{"0":123,"1":10,…}` 的字节表，**把模板文件写坏**（第 7 轮迁移时引入，第 12 轮由 schema 告警抓出）。
    const isBufferLike = (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) || content instanceof Uint8Array;
    const isObject = content !== null && typeof content === 'object' && !Array.isArray(content) && !isBufferLike;
    let attempts = 0;
    let lastErr = null;

    for (let i = 0; i < Math.max(1, maxAttempts); i += 1) {
      attempts += 1;
      try {
        // ② 读当前状态：版本指纹 + revision
        const version = await fsPort.statVersion(target);
        const currentText = await fsPort.readText(target);
        const currentRev = readRevision(currentText);

        // ③ revision 前置条件：只在**调用方显式声明**时才校验（避免首次创建时误报）
        if (expectedRevision !== null && currentRev !== null && currentRev !== expectedRevision) {
          onEvent({ type: 'revision-stale', target, expected: expectedRevision, actual: currentRev, attempt: attempts });
          lastErr = Object.assign(new Error(`REVISION_STALE: ${target} 期望 ${expectedRevision} 实际 ${currentRev}`), { code: 'REVISION_STALE' });
          continue; // 重读重试（下一轮会拿到新的 currentRev）
        }

        // ④ 组装内容：对象则自增 revision，并附带**归因**（批 2-3 · L1-3′）
        let payload;
        let nextRev = null;
        let provenance = null;
        if (isObject) {
          nextRev = (currentRev === null ? 1 : currentRev + 1);
          const me = identityKey();
          // 归因检测（只上报、不阻断）：
          //  · revision 回退：磁盘 revision 比本进程上次写的更小 ⇒ 有人把文件回退了
          //  · writer 变化：磁盘上的 writer 与本进程身份不同 ⇒ 别的写者动过
          const prevWritten = lastWritten.get(target);
          if (prevWritten !== undefined && currentRev !== null && currentRev < prevWritten) {
            onEvent({ type: 'revision-regression', target, lastWritten: prevWritten, onDisk: currentRev });
          }
          let onDiskWriter = null;
          if (currentText) {
            try { onDiskWriter = (JSON.parse(currentText) || {})._provenance?.writer ?? null; } catch { onDiskWriter = null; }
          }
          if (me && onDiskWriter && onDiskWriter !== me) {
            onEvent({ type: 'writer-changed', target, onDiskWriter, me });
          }
          provenance = (me || onDiskWriter) ? { writer: me || onDiskWriter, at: new Date().toISOString() } : null;
          const base = provenance ? { ...content, _provenance: provenance, revision: nextRev } : { ...content, revision: nextRev };
          payload = JSON.stringify(base, null, 2) + '\n';
        } else {
          payload = String(content);
        }

        // ⑤ 版本栅栏写入
        const intent = version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version };
        await fsPort.writeText(target, payload, intent);
        if (attempts > 1) onEvent({ type: 'write-retried', target, attempts });
        // ⑤′ schema 告警（批 2-4 · L1-4′）：**写完才报、绝不阻断** —— 保证旧 run 不会因不合规而消失
        const guard = isObject ? schemaGuards[String(target).split('/').pop()] : null;
        let schemaWarnings = [];
        if (typeof guard === 'function') {
          try {
            schemaWarnings = guard(content) || [];
          } catch { schemaWarnings = []; }
          for (const msg of schemaWarnings) onEvent({ type: 'schema-warn', target, message: msg });
        }
        // 记住本进程写过的 revision —— 供后续写入检测"回退"（批 2-3 归因）
        if (isObject && nextRev !== null) lastWritten.set(target, nextRev);
        return { ok: true, revision: nextRev, attempts, schemaWarnings, provenance };
      } catch (e) {
        lastErr = e;
        const stale = e && (e.code === 'FS_STALE_VERSION' || /FS_STALE_VERSION/.test(String(e.message || '')));
        onEvent({ type: stale ? 'version-stale' : 'write-error', target, attempt: attempts, error: String(e && e.message) });
        if (!stale) break; // 非"陈旧"类错误：重试无意义，直接上抛
      }
    }

    return {
      ok: false,
      code: (lastErr && lastErr.code) || 'WRITE_FAILED',
      error: String(lastErr && lastErr.message ? lastErr.message : lastErr),
      attempts,
    };
  }

  /** 读取并返回 {text, revision}；文件不存在返回 {text:null, revision:null}。 */
  async function read(target) {
    const text = await fsPort.readText(target);
    return { text, revision: readRevision(text) };
  }

  /**
   * 同 `write`，但**失败即抛**。
   * 迁移既有写入点时用它：原 `writeFile` 失败会抛，若换成不检查返回值的 `write`，
   * 就会把"写失败"静默成"写成功"。迁移必须保持 loud。
   */
  async function must(target, content, opts = {}) {
    const r = await write(target, content, opts);
    if (!r.ok) {
      const err = new Error(`工件写入失败[${r.code}] ${target}：${r.error}`);
      err.code = r.code;
      err.violation = r.violation;
      throw err;
    }
    return r;
  }

  return { write, must, read, fsPort, exclusions, schemaGuards };
}
