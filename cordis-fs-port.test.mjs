// 测试：`cordisFsPort(ctx.fs)` —— **真实宿主路径**首次实跑（C2）
//
// 背景：`lib/artifact-writer.js` 提供两个 fsPort：
//   · `nodeFsPort()`  —— 回退实现（纯 Node 真实读写）
//   · `cordisFsPort(ctxFs)` —— 走宿主 `ctx.fs` 的**文件级 CAS**（`FsWriteIntent`）
// 此前**全部测试都只走 nodeFsPort**，而 `apply()` 里若发现宿主提供 `ctx.fs` 就会**切换**到
// cordisFsPort ⇒ 生产路径长期处于"设计可行、行为待验"状态（WORKLOG 已如实标注多轮）。
//
// 官方契约（`@deepseek-ai/dsh-fs` / `@deepseek-ai/dsh-fs-sandbox`）：
//   resolve(path, opts?) → 版本化 target（`opts.cwd` 只影响**相对路径解析**）
//   readText(target) / stat(target) → {version}
//   writeText(target, content, intent | undefined, signal?, sandboxPolicy?)
//     ⚠️ **第 5 参 `sandboxPolicy` 才是本次调用的写入授权凭据**：宿主的围栏判定是
//     `sandboxPolicy ?? ctx.sandboxPolicy.resolve()`，缺席即回落**部署根**（Issue #1 的全部机制）。
//   intent = {kind:'createIfAbsent'} | {kind:'replaceIfVersion', version}
//   失配时 provider 报 **FS_STALE_VERSION**；越界时 provider 报 **FS_SANDBOX_DENIED**
//
// 本测试用一个**按该契约实现的内存宿主 fs**（含版本栅栏与陈旧报错）驱动真实 cordisFsPort，
// 覆盖：路径解析、首次创建、版本栅栏、陈旧重试、范围硬排除、schema 告警、归因与 revision、
// 以及 ⑧ 的**沙箱授权透传**（Issue #1：跨目录写入被 FS_SANDBOX_DENIED 拒）。
// ⑨–⑫ 补上第 5 参**背后那条链路**的守卫（gate 评审发现的真实盲区：`pathIsUnder` /
// `sessionOwningTarget` / `candidateSessions` / `policyResolverForTargets` / `hostHonoredCwdOf`
// 在 90 个测试文件里 0 命中）—— 即「凭据是怎么算出来的」，而不只是「凭据有没有被转发」。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M32（CAS 陈旧不重试）、
// M173（第 5 参授权凭据被丢掉 ⇒ Issue #1 原样复现）与
// M174（`pathIsUnder` 退回**未归一化的原始串**比较 ⇒ `..` 洞复发，⑨ 抓住）。
// 运行：node cordis-fs-port.test.mjs

import { resolve as pathResolve, sep as pathSep } from 'node:path';
import { cordisFsPort, createArtifactWriter, DEFAULT_SCHEMA_GUARDS } from './lib/artifact-writer.js';
// ⑨–⑫ 要直调的函数经 `_live` 导出（与 `task-cas` / `member-registry` 等测试同一取用方式）：
// `pathIsUnder` / `sessionOwningTarget` / `policyResolverForTargets` / `candidateSessions` / `hostHonoredCwdOf`。
// ✅ **更新（曾经的前提已作废）**：`_live` 现在**已经**导出 `candidateSessions` 与 `hostHonoredCwdOf`
//    （`lib/command.js:6580`，实测 `typeof === 'function'`）⇒ 它们从"只能行为级间接验证"升级为
//    **直接断言**（⑩ 的数组级/去重/过滤/容错用例，⑫ 的取值口径用例）。下面两条**其余**限制仍然成立，
//    如实登记、不假装覆盖：
//   ① `CURRENT_SESSION` 是 `lib/command.js` 的**模块级**变量，只在本模块 `apply()` 的 `/team`
//      处理路径里被赋值（`command.js:6422`），`_live` **没有**、也不该有写入口 ⇒ 本文件不 `apply`，
//      它在这里恒为 `null`。故凡涉及"当前会话"的用例一律走**真实路径**
//      （`ctx.get('sessions').list()` 返回会话），而不是去伪造那份模块级状态。
//   ② 因此 `candidateSessions` 里 `sessions.get(id)` 那支**兜底分支不可达**（它的触发条件是
//      `CURRENT_SESSION`/`WRITER_IDENTITY` 至少给出一个 id，而两者都恒为 `null`）——
//      ⑩ 里有一条**不可达性断言**（`sessions.get` 调用次数 = 0）如实登记这件事，而不是伪造它。
import { _live } from './lib/command.js';

const { pathIsUnder, sessionOwningTarget, policyResolverForTargets, candidateSessions, hostHonoredCwdOf } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/**
 * 按 `@deepseek-ai/dsh-fs` 契约实现的内存宿主 fs（故意**不**做任何宽容处理）。
 * 关键：`replaceIfVersion` 的 version 与磁盘不符 ⇒ 抛 `code: 'FS_STALE_VERSION'`。
 *
 * ⚠️ Issue #1 的教训（本 mock 的 arity 就是根因的一部分）：`writeText` 早先只声明 3 个参数，
 * 于是**一个不接第 5 参的 mock 在结构上不可能发现「第 5 参没传」**——所谓「宿主 CAS 路径已被
 * 实测验证」因此是**假阳性**（只验证了版本栅栏，从未验证沙箱授权）。现在与宿主同 arity，
 * 并把收到的 `sandboxPolicy` 与 `resolve` 的 `cwd` 选项记进 `stats` 供断言。
 */
function makeHostFs() {
  const files = new Map(); // target -> {text, version}
  let versionSeq = 0;
  const stats = {
    resolve: 0, readText: 0, stat: 0, writeText: 0, staleRejects: 0,
    // ⑧ 新增：`undefined` 也要**记下来** ——「没传」本身就是要断言的事实（不能被"没记录"掩盖）
    lastSandboxPolicy: undefined,
    lastSandboxSignal: undefined,
    policies: [],
    lastResolveOpts: undefined,
    resolveOpts: [],
  };
  return {
    files, stats,
    // 宿主把相对/绝对路径解析成"版本化 target"（真实实现会做 sandbox 归一化）。
    // 第 2 参 `opts`（`{cwd}`）与宿主同形状：它**只**影响相对路径解析，**不构成**写入授权。
    async resolve(p, opts) {
      stats.resolve += 1;
      stats.lastResolveOpts = opts;
      stats.resolveOpts.push(opts);
      return 'host://' + String(p).replace(/^host:\/\//, '');
    },
    async readText(target) {
      stats.readText += 1;
      const f = files.get(target);
      if (!f) throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
      return f.text;
    },
    async stat(target) {
      stats.stat += 1;
      const f = files.get(target);
      if (!f) return null; // 不存在 → 让 writer 走 createIfAbsent
      return { version: f.version };
    },
    // 宿主真实签名：`writeText(target, content, expected?, signal?, sandboxPolicy?)`
    async writeText(target, content, intent, signal, sandboxPolicy) {
      stats.writeText += 1;
      stats.lastSandboxSignal = signal;
      stats.lastSandboxPolicy = sandboxPolicy;
      stats.policies.push(sandboxPolicy);
      const cur = files.get(target);
      if (intent && intent.kind === 'replaceIfVersion') {
        if (!cur || String(cur.version) !== String(intent.version)) {
          stats.staleRejects += 1;
          throw Object.assign(new Error(`FS_STALE_VERSION: ${target} expected ${intent.version} actual ${cur ? cur.version : '∅'}`), { code: 'FS_STALE_VERSION' });
        }
      } else if (intent && intent.kind === 'createIfAbsent' && cur) {
        throw Object.assign(new Error(`EEXIST: ${target}`), { code: 'EEXIST' });
      }
      versionSeq += 1;
      files.set(target, { text: String(content), version: String(versionSeq) });
    },
  };
}

/**
 * ⑧ 用的**带围栏的宿主 mock**：复刻 `@deepseek-ai/dsh-fs-sandbox` 的判定口径。
 *   · 授权参数缺席 ⇒ 回落**部署根**（`fallbackRoot`，即宿主的 `process.cwd()`）；
 *   · 目标不在授权根之下 ⇒ 抛 `{code:'FS_SANDBOX_DENIED'}`，文案逐字取自宿主；
 *   · 授权参数在场且目标在其 `workspaceRoot` 之下 ⇒ 正常落盘。
 * 刻意只做**词法**归属判断（纯字符串、不碰真实路径与平台 API）⇒ macOS/Linux/Windows 同结果。
 */
function makeGuardedHostFs(fallbackRoot) {
  const host = makeHostFs();
  const orig = host.writeText.bind(host);
  host.stats.sandboxDenials = 0;
  host.writeText = async (target, content, intent, signal, sandboxPolicy) => {
    const policy = sandboxPolicy || { mode: 'workspace-write', workspaceRoot: fallbackRoot };
    const p = String(target).replace(/^host:\/\//, '');
    const root = String(policy.workspaceRoot || fallbackRoot).replace(/\/$/, '');
    const under = p === root || p.startsWith(root + '/');
    if (!under) {
      host.stats.sandboxDenials += 1;
      throw Object.assign(new Error(`cannot write "${p}": file access denied under workspace-write mode`), { code: 'FS_SANDBOX_DENIED' });
    }
    return orig(target, content, intent, signal, sandboxPolicy);
  };
  return host;
}

const events = [];
const mkWriter = (hostFs, resolvePolicy = null) => createArtifactWriter({
  fsPort: cordisFsPort(hostFs, resolvePolicy),
  onEvent: (e) => events.push(e),
  identity: () => ({ sessionId: 'sess-C2', runId: 'run-C2', role: 'lead' }),
});

console.log('# cordisFsPort（宿主 ctx.fs 路径）首次实跑\n');

console.log('① 路径解析与首次创建：走的是宿主 fs，不是 node:fs');
{
  const host = makeHostFs();
  const w = mkWriter(host);
  const r = await w.must('/proj/team/r1/STATE.json', { phase: 'clarify', status: 'running', members: [], coverage: [] });
  check(r && r.ok !== false, '写入成功');
  check(host.stats.resolve > 0, '调用了 ctxFs.resolve（路径解析确实经过宿主）', 'resolve=' + host.stats.resolve);
  check(host.stats.writeText > 0, '调用了 ctxFs.writeText');
  check(host.files.has('host:///proj/team/r1/STATE.json'), '宿主侧文件已生成（key = 解析后的 target）');
  const saved = JSON.parse(host.files.get('host:///proj/team/r1/STATE.json').text);
  check(saved.revision === 1, '首次写入 revision=1', String(saved.revision));
  check(saved._provenance && /sess-C2/.test(saved._provenance.writer), '归因载体写入（含 sessionId）', JSON.stringify(saved._provenance));
  check(saved.phase === 'clarify', '业务字段未被破坏');
}

console.log('\n② 版本栅栏：磁盘版本变了必须被宿主拦下并**重试一次**');
{
  const host = makeHostFs();
  const w = mkWriter(host);
  await w.must('/p/STATE.json', { n: 1 });
  const v1 = JSON.parse(host.files.get('host:///p/STATE.json').text).revision;
  // ⚠️ 关键语义（第一次实跑才确认）：writer **每次尝试都重新 stat** 拿版本，所以
  //     "提前把版本改掉"**不会**触发陈旧 —— CAS 拦的是 **stat 与 write 之间的窗口**
  //     （TOCTOU），即"并发写者恰好落在这两步中间"。这才是它该拦的东西。
  //     这里就让宿主在**第一次 writeText 的那一瞬间**顶掉版本，模拟并发落窗。
  const orig = host.writeText.bind(host);
  let bumped = false;
  host.writeText = async (t, c, intent) => {
    if (!bumped) { bumped = true; host.files.set(t, { text: host.files.get(t).text, version: 'concurrent-999' }); }
    return orig(t, c, intent);
  };
  events.length = 0;
  const r = await w.must('/p/STATE.json', { n: 2 });
  check(r && r.ok !== false, '陈旧重试后写入成功', JSON.stringify(r && { ok: r.ok, attempts: r.attempts }));
  check(r.attempts >= 2, '确实重试过（attempts>=2）', String(r.attempts));
  check(events.some((e) => e.type === 'version-stale'), '上报 version-stale 事件');
  check(events.some((e) => e.type === 'write-retried'), '上报 write-retried 事件');
  const after = JSON.parse(host.files.get('host:///p/STATE.json').text);
  check(after.revision === v1 + 1, 'revision 只自增 1（陈旧那次没写成，重试才落盘）', `${v1} → ${after.revision}`);
  check(after.n === 2, '重试后写入的是新内容');
}

console.log('\n③ 陈旧不可恢复时：如实失败（must 抛错），且不静默覆盖');
{
  const host = makeHostFs();
  const w = mkWriter(host);
  await w.must('/q/STATE.json', { n: 1 });
  // 每次 writeText 前都把版本顶掉 ⇒ 两次尝试都撞栅栏
  const orig = host.writeText.bind(host);
  host.writeText = async (t, c, intent) => {
    const f = host.files.get(t);
    if (f) host.files.set(t, { text: f.text, version: 'v' + Math.random() });
    return orig(t, c, intent);
  };
  events.length = 0;
  let err = null;
  try { await w.must('/q/STATE.json', { n: 2 }); } catch (e) { err = e; }
  check(!!err, '`must()` 在不可恢复失败时**抛错**（不静默返回）', err ? 'threw' : 'no throw');
  check(err && (err.code === 'FS_STALE_VERSION' || /FS_STALE_VERSION/.test(String(err.message))), '错误带 FS_STALE_VERSION', String(err && err.message).slice(0, 70));
  check(host.files.get('host:///q/STATE.json').text.includes('"n": 1'), '**旧内容未被覆盖**（不静默丢数据）');
  check(events.filter((e) => e.type === 'version-stale').length >= 2, '两次尝试都上报了 version-stale', String(events.filter((e) => e.type === 'version-stale').length));
  // 非 must 的 write() 则如实返回 ok:false（不抛），供调用方按需处理
  const w2 = mkWriter(host);
  const r2 = await w2.write('/q/STATE.json', { n: 3 });
  check(r2.ok === false && r2.code === 'FS_STALE_VERSION', '`write()` 返回 ok:false + code（不抛）', JSON.stringify(r2 && r2.code));
}

console.log('\n④ 范围硬排除：在进入任何宿主 IO 之前就被拦下');
{
  const host = makeHostFs();
  const w = mkWriter(host);
  const before = host.stats.writeText;
  let err = null; try { await w.must('/proj/.env', { secret: 'x' }) } catch (e) { err = e }
  check(err && err.code === 'SCOPE_DENIED', '禁写区被拒（must 抛 SCOPE_DENIED）', JSON.stringify(err && err.code));
  check(host.stats.writeText === before, '**没有触达宿主 fs**（先拦后 IO）', `writeText ${before}→${host.stats.writeText}`);
  check(host.files.size === 0, '宿主侧没有落任何文件');
}

console.log('\n⑤ schema 告警在宿主路径上同样生效（只告警、写完再报）');
{
  const host = makeHostFs();
  const w = mkWriter(host);
  events.length = 0;
  const r = await w.must('/proj/team/r2/STATE.json', { coverage: ['pm', 'architect'], members: [] });
  check(host.files.has('host:///proj/team/r2/STATE.json'), '**先落盘**（可见性优先）');
  check(Array.isArray(r.schemaWarnings) && r.schemaWarnings.length >= 1, '返回值带 schemaWarnings', JSON.stringify(r.schemaWarnings));
  check(events.some((e) => e.type === 'schema-warn'), '上报 schema-warn 事件');
}

console.log('\n⑥ 非对象（字符串）内容：不得被 JSON 化，也不该走 revision 路径');
{
  const host = makeHostFs();
  const w = mkWriter(host);
  await w.must('/proj/team/r3/RUN.log.md', '# log\nline1\n');
  const t = host.files.get('host:///proj/team/r3/RUN.log.md').text;
  check(t === '# log\nline1\n', '原样写入（未被 JSON 化）', JSON.stringify(t.slice(0, 20)));
}

console.log('\n⑦ 默认 guard 与宿主路径共用同一份（口径一致）');
{
  check(typeof DEFAULT_SCHEMA_GUARDS['STATE.json'] === 'function', 'DEFAULT_SCHEMA_GUARDS 含 STATE.json guard');
  const host = makeHostFs();
  const w = mkWriter(host);
  const r = await w.must('/proj/team/r4/TASKS.json', { tasks: [{ title: 'no id' }] });
  check(r.schemaWarnings.some((s) => /非空字符串 id|id/.test(s)), 'TASKS guard 在宿主路径上同样触发', JSON.stringify(r.schemaWarnings));
}

console.log('\n⑧ 沙箱授权凭据（第 5 参）透传 —— Issue #1 回归：跨目录写入被 FS_SANDBOX_DENIED 拒');
// 事故复述（回归锚点）：会话项目目录 ≠ DSH 启动目录时，`/team` 建得出 `team/<RUN_ID>/`
// 却写不进任何工件（`mkdir` 走裸 `node:fs`、不过沙箱；写入走 `ctx.fs`、过沙箱）。
// 根因：宿主签名 `writeText(target, content, expected?, signal?, sandboxPolicy?)` 的**第 5 参**
// 才是一次调用的授权凭据，而本适配层只传了 3 个 ⇒ 宿主回落配置里的 `workspaceRoot = process.cwd()`。
// 下面每一块都对应「删掉那次转发即红」—— 即方案 §7.2 测试计划的第 1/2/3/4/5 项。
{
  const host = makeHostFs();
  check(host.writeText.length >= 5, 'mock 的 writeText 与宿主同 arity（≥5 参）—— 3 参的 mock 在结构上不可能发现「第 5 参没传」（Issue #1 的测试盲点本身）', `length=${host.writeText.length}`);
  check(host.resolve.length >= 2, 'mock 的 resolve 接受第 2 参 `{cwd}`（与宿主同形状）', `length=${host.resolve.length}`);
}

console.log('  ⑧a 有授权 ⇒ 第 5 参收到**同一个**凭据对象，且相对路径按授权根解析');
{
  const host = makeHostFs();
  const POLICY = { mode: 'workspace-write', workspaceRoot: '/proj' };
  const w = mkWriter(host, async () => POLICY);
  await w.must('/proj/team/r5/STATE.json', { n: 1 });
  check(host.stats.lastSandboxPolicy === POLICY, '第 5 参是**同一个**授权对象（不是 undefined、不是重建的副本）', JSON.stringify(host.stats.lastSandboxPolicy));
  check(host.stats.lastSandboxPolicy && host.stats.lastSandboxPolicy.workspaceRoot === '/proj', '授权对象带 workspaceRoot（宿主围栏判定只用这一个值）', JSON.stringify(host.stats.lastSandboxPolicy));
  check(host.stats.resolveOpts.some((o) => o && o.cwd === '/proj'), '写路径上 `resolve` 收到 `{cwd: policy.workspaceRoot}`（与宿主官方 `dsh-tool-fs` 同形状）', JSON.stringify(host.stats.resolveOpts));
  check(host.stats.lastSandboxSignal === undefined, '第 4 参 `signal` 显式为 undefined（本层无 exec ⇒ 工件写入不可中断：设计如此，见方案 §9-7）', String(host.stats.lastSandboxSignal));
  check(host.files.has('host:///proj/team/r5/STATE.json'), '文件确实落到宿主侧');
  // 相对路径：`cwd` 的意义就在这里（绝对路径不受影响，但两处都要给才与宿主官方链路一致）
  const host2 = makeHostFs();
  const w2 = mkWriter(host2, async () => POLICY);
  await w2.must('team/r6/STATE.json', { n: 1 });
  check(host2.stats.lastResolveOpts && host2.stats.lastResolveOpts.cwd === '/proj', '相对路径写入时 `resolve` 同样收到 `{cwd: /proj}`（授权根决定相对路径落点）', JSON.stringify(host2.stats.lastResolveOpts));
  check(host2.stats.lastSandboxPolicy === POLICY, '相对路径写入时第 5 参同样透传', JSON.stringify(host2.stats.lastSandboxPolicy));
}

console.log('  ⑧b 无授权 ⇒ 行为与修复前**完全一致**（第 5 参 undefined、`resolve` 不带 cwd）');
{
  // 形态 1：`resolvePolicy = null`（旧调用方：构造时就没给解析器）
  const host = makeHostFs();
  const w = mkWriter(host);
  await w.must('/proj/team/r6b/STATE.json', { n: 1 });
  check(host.stats.lastSandboxPolicy === undefined, 'resolvePolicy=null ⇒ 第 5 参是 undefined（不伪造授权）', String(host.stats.lastSandboxPolicy));
  check(host.stats.resolveOpts.every((o) => o === undefined), '`resolve` 全程没收到 cwd 选项（回落宿主部署根，不越权指定落点）', JSON.stringify(host.stats.resolveOpts));
  check(host.files.has('host:///proj/team/r6b/STATE.json'), '写入照旧成功（「没有授权」不被放大成新的失败）');
  // 形态 2：解析器在场、但本次确实解析不到会话（返回 undefined）—— 同一口径
  const host2 = makeHostFs();
  const w2 = mkWriter(host2, async () => undefined);
  await w2.must('/proj/team/r6c/STATE.json', { n: 1 });
  check(host2.stats.lastSandboxPolicy === undefined, '解析器返回 undefined ⇒ 第 5 参 undefined（「拿不到会话」= 无授权，不是报错）', String(host2.stats.lastSandboxPolicy));
  check(host2.stats.resolveOpts.every((o) => o === undefined), '解析器返回 undefined ⇒ `resolve` 也不带 cwd', JSON.stringify(host2.stats.resolveOpts));
}

console.log('  ⑧c 解析器抛错 ⇒ **降级**，写入仍然成功（不许把「解析失败」放大成「写入失败」）');
{
  const host = makeHostFs();
  const w = mkWriter(host, async () => { throw new Error('sessions 服务不可用'); });
  events.length = 0;
  let err = null;
  try { await w.must('/proj/team/r7/STATE.json', { n: 1 }); } catch (e) { err = e; }
  check(!err, '解析器抛错 ⇒ 写入**仍然成功**（降级方向是「更接近修复前」，不是「更容易失败」）', err ? String(err.message) : 'ok');
  check(host.stats.lastSandboxPolicy === undefined, '抛错按「无授权」处理（第 5 参 undefined）', String(host.stats.lastSandboxPolicy));
  check(host.stats.resolveOpts.every((o) => o === undefined), '抛错后 `resolve` 也不带 cwd', JSON.stringify(host.stats.resolveOpts));
  check(host.files.has('host:///proj/team/r7/STATE.json'), '内容已落盘（不是静默丢弃）');
}

console.log('  ⑧d 端到端围栏仿真：同一路径「无授权 ⇒ 失败 / 有授权 ⇒ 成功」—— 这条测试本该拦下 Issue #1');
{
  const LAUNCH = '/launch-dir'; // = process.cwd()（DSH 启动目录，宿主配置钉死的 workspaceRoot）
  const PROJECT = '/proj';      // = 会话项目目录（不在启动目录之下 ⇒ Issue #1 的触发条件）
  const TARGET = '/proj/team/r8/STATE.json';
  // ── 修复前的形状：无授权凭据 ⇒ 宿主按部署根判定 ⇒ 越界
  const hostNo = makeGuardedHostFs(LAUNCH);
  const wNo = mkWriter(hostNo);
  events.length = 0;
  let denied = null;
  try { await wNo.must(TARGET, { n: 1 }); } catch (e) { denied = e; }
  check(!!denied, '【回归】无授权凭据 + 目标在项目目录（≠ 启动目录）⇒ 写入**失败**（Issue #1 原样复现）', denied ? String(denied.code) : '居然成功了');
  check(denied && denied.code === 'FS_SANDBOX_DENIED', '失败码是 FS_SANDBOX_DENIED（宿主围栏，不是插件自己的范围拒绝）', String(denied && denied.code));
  check(denied && String(denied.message).includes(`cannot write "${TARGET}": file access denied under workspace-write mode`), '报错文案**逐字**来自宿主（不改写、不吞错）', String(denied && denied.message));
  check(hostNo.stats.sandboxDenials >= 1, '围栏确实被触发（反空转：不是别的原因失败的）', String(hostNo.stats.sandboxDenials));
  check(hostNo.files.size === 0, '宿主侧 0 个文件 —— 正是报告人看到的「目录建好了，文件一个也没写进去」', `files=${hostNo.files.size}`);
  // ── 修复后的形状：同一个 mock、同一个路径，只补上授权凭据
  const hostYes = makeGuardedHostFs(LAUNCH);
  const wYes = mkWriter(hostYes, async () => ({ mode: 'workspace-write', workspaceRoot: PROJECT }));
  let err2 = null;
  try { await wYes.must(TARGET, { n: 1 }); } catch (e) { err2 = e; }
  check(!err2, '【修复后】同一路径 + 授权凭据 `{workspaceRoot:/proj}` ⇒ 写入**成功**', err2 ? String(err2.message) : 'ok');
  check(hostYes.files.has('host://' + TARGET), '宿主侧文件已落盘（围栏按会话项目目录判定）', `files=${hostYes.files.size}`);
  check(hostYes.stats.sandboxDenials === 0, '围栏一次都没拦（授权根 = 目标所在的项目目录）', String(hostYes.stats.sandboxDenials));
  // ── ★假阳性守卫★：修的是「授权错位」，**不是**「把围栏放宽」
  let outside = null;
  try { await wYes.must('/elsewhere/team/r8/STATE.json', { n: 1 }); } catch (e) { outside = e; }
  check(outside && outside.code === 'FS_SANDBOX_DENIED', '★假阳性守卫★ 授权根**之外**仍然被拒（没有把围栏改成恒通过）', String(outside && outside.code));
}

console.log('  ⑧e `must()` 如实上抛宿主拒绝：code 与文案都不失真，且不做无谓重试/占位写入');
{
  const host = makeGuardedHostFs('/launch-dir');
  const w = mkWriter(host);
  events.length = 0;
  let err = null;
  try { await w.must('/proj/team/r9/STATE.json', { n: 1 }); } catch (e) { err = e; }
  check(err && err.code === 'FS_SANDBOX_DENIED', '`must()` 抛出错误的 `.code` 原样是 FS_SANDBOX_DENIED', String(err && err.code));
  check(err && /cannot write "\/proj\/team\/r9\/STATE\.json": file access denied under workspace-write mode/.test(String(err.message)), '错误 message 含宿主原文（含目标路径与 workspace-write 字样）', String(err && err.message));
  check(events.some((e) => e.type === 'write-error' && /file access denied/.test(String(e.error))), '上报 write-error 事件（失败可见，不静默）', JSON.stringify(events.filter((e) => e.type === 'write-error').map((e) => e.error)));
  // 围栏在 mock 里于 `writeText` 处就抛错 ⇒ 走不到落盘计数，故用 `sandboxDenials` 数尝试次数
  check(host.stats.sandboxDenials === 1, '只尝试一次（非「陈旧」类错误不重试 —— 不做无谓的重复拒绝）', `sandboxDenials=${host.stats.sandboxDenials}`);
  check(host.files.size === 0, '宿主侧没有半成品文件（拒绝即什么都没写）', `files=${host.files.size}`);
  // 非 must 的 write() 不抛，但**如实返回** code（调用方不会被「看起来成功」骗到）
  const host2 = makeGuardedHostFs('/launch-dir');
  const w2 = mkWriter(host2);
  const r = await w2.write('/proj/team/r10/STATE.json', { n: 1 });
  check(r.ok === false && r.code === 'FS_SANDBOX_DENIED', '`write()` 返回 ok:false + code=FS_SANDBOX_DENIED（不抛、也不静默成功）', JSON.stringify(r && { ok: r.ok, code: r.code }));
  check(host2.files.size === 0, '`write()` 失败时同样不留半成品', `files=${host2.files.size}`);
}

console.log('  ⑧f `policy-resolve-error` 必须**真的发出**：同步抛与**拒绝的 promise** 两条路径都要上报');
// 为什么这条只能**直调解析器**：`mkWriter()` 给 `cordisFsPort` 只传了 `fsPort`（第 2 参），
// 适配层的第 3 参（`onEvent`）在测试里是空的 —— 而异常正是在**解析器内部**被吞掉的
// （`sp.resolve` 抛错 ⇒ 解析器自己 catch 后返回 `undefined`），适配层那层 catch 永远看不见它。
// 生产里 `apply()` 传的是同一个 `writerEvents`（`command.js:302`），故这里用同形状的收集器直调
// `_live.policyResolverForTargets` —— 这就是「降级不再静默」这句承诺的唯一可断言形态。
{
  const OWNER = { id: 'sess-owner', header: { id: 'sess-owner', cwd: '/proj' } };
  const ctx = { get: (k) => (k === 'sessions' ? { list: () => [OWNER] } : null) };
  const TARGET = '/proj/team/r11/STATE.json';
  // ① 同步抛 —— 宿主 `sandboxPolicy.resolve()` 就是同步方法，这是**主**路径
  {
    const sp = { resolve: () => { throw new Error('sessions 服务不可用'); } };
    const seen = [];
    const resolvePolicy = policyResolverForTargets(ctx, sp, (e) => seen.push(e));
    let threw = null; let out;
    try { out = await resolvePolicy(TARGET); } catch (e) { threw = e; }
    check(!threw, '同步抛 ⇒ 解析器**不 rethrow**（降级不阻断写入）', threw ? String(threw.message) : 'ok');
    check(out === undefined, '同步抛 ⇒ 返回 undefined（= 不传授权凭据 = 修复前行为）', String(out));
    const errs = seen.filter((e) => e.type === 'policy-resolve-error');
    check(errs.length === 1, '同步抛 ⇒ **恰好 1 条** policy-resolve-error（不多报也不漏报）', `count=${errs.length}`);
    check(errs[0] && errs[0].target === TARGET, '事件带**本次目标路径**（没有它就无法归因到哪一笔写入）', JSON.stringify(errs[0] && errs[0].target));
    check(errs[0] && errs[0].error === 'sessions 服务不可用', '事件带 error 文案（`String(e.message)`）', JSON.stringify(errs[0] && errs[0].error));
  }
  // ② 拒绝的 promise —— `return await` 守卫：少写 `await` 时被拒的 thenable 会**穿透本层 try/catch**
  //    直到适配层（而同步抛仍被吞掉）⇒「谁来观测」随调用形态而变；这条用例正对着那次独立评审
  //    判定的最严重缺陷（"降级不再静默"成了空头承诺）。
  {
    const sp = { resolve: async () => { throw new Error('沙箱策略服务超时'); } };
    const seen = [];
    const resolvePolicy = policyResolverForTargets(ctx, sp, (e) => seen.push(e));
    let threw = null; let out;
    try { out = await resolvePolicy(TARGET); } catch (e) { threw = e; }
    check(!threw, '★ `return await` 守卫 ★ 被拒的 promise 也被本层接住（少了 `await` 这里就会抛出）', threw ? String(threw.message) : 'ok');
    check(out === undefined, '被拒的 promise ⇒ 同样返回 undefined', String(out));
    const errs = seen.filter((e) => e.type === 'policy-resolve-error');
    check(errs.length === 1, '被拒的 promise ⇒ 同样**恰好 1 条** policy-resolve-error（两种形态落进同一个 catch）', `count=${errs.length}`);
    check(errs[0] && errs[0].error === '沙箱策略服务超时', '事件文案取自 rejection 的 message', JSON.stringify(errs[0] && errs[0].error));
  }
  // ③ 观测通道自己坏了不得放大成写入失败
  {
    const sp = { resolve: () => { throw new Error('宿主策略不可用'); } };
    const resolvePolicy = policyResolverForTargets(ctx, sp, () => { throw new Error('观测通道炸了'); });
    let threw = null; let out;
    try { out = await resolvePolicy(TARGET); } catch (e) { threw = e; }
    check(!threw, 'onEvent 自身抛错 ⇒ 仍不 rethrow（「观测不该影响写入」）', threw ? String(threw.message) : 'ok');
    check(out === undefined, 'onEvent 自身抛错 ⇒ 仍返回 undefined', String(out));
  }
}

console.log('\n⑨ `pathIsUnder`：归属判定的**唯一判据**（只比 `path.resolve` 归一化后的形态）');
// 为什么这一节非有不可：⑧ 守的是「凭据有没有被转发」，本节守的是「凭据是怎么算出来的」。
// 这里的每一条都对应一个**真实放行方向**的缺陷（不是"漏判退回无授权"那种安全方向）：
// `..` 洞曾让 `/proj/../etc/passwd` 判给 `/proj` 的会话 ⇒ 围栏根被设成 `/proj` ⇒ 越界写入被**放行**。
// 路径全用 `pathResolve`/`pathSep` 现算（POSIX 与 Windows 的形态各自成立），不写死平台字面量。
{
  const ROOT = pathResolve('/proj'); // POSIX: /proj；Windows: <drive>:\proj —— 用例两侧同源
  // ★ 这条用例**必须传未归一化的原始串**（`/proj/../etc/passwd` 的形态）：先 `pathResolve` 再喂进去，
  //   就等于替被测函数把 `..` 处理掉了 —— 那样 M174（退回原始串比较）照样全绿、变异体抓不住。
  const RAW_TRAVERSAL = ROOT + pathSep + '..' + pathSep + 'etc' + pathSep + 'passwd';
  const TRAPPED = pathResolve(ROOT, '..', 'etc', 'passwd'); // 归一化后 = /etc/passwd（**不在** /proj 之下）
  check(pathIsUnder(ROOT, RAW_TRAVERSAL) === false, '★ `..` 穿越（**原始未归一化**形态）必须为 false ★（曾经的洞：原始串 `startsWith(ROOT + sep)` 先命中 ⇒ 目标判给并不拥有它的会话 ⇒ 越界写入被放行）', `root=${ROOT} target=${RAW_TRAVERSAL}`);
  check(pathIsUnder(ROOT, TRAPPED) === false, '同一目标的**归一化**形态（`path.resolve` 之后）同样为 false —— 两种形态都不许放行', `target=${TRAPPED}`);
  check(pathIsUnder(ROOT, ROOT) === true, 'target === root ⇒ true（会话自己的根）', `${ROOT}`);
  check(pathIsUnder(ROOT, pathResolve(ROOT, 'a', 'b')) === true, 'root 之下的深层目标 ⇒ true', pathResolve(ROOT, 'a', 'b'));
  check(pathIsUnder(ROOT + pathSep, pathResolve(ROOT, 'a')) === true, '根带尾分隔符（`/proj/`）⇒ true（先 strip 尾分隔符再比）', `root=${ROOT + pathSep}`);
  const TRAP = pathResolve(ROOT, '..', 'project', 'x'); // 归一化后 = /project/x
  check(pathIsUnder(ROOT, TRAP) === false, '★前缀陷阱★ `/proj` **不**包含 `/project/x`（比的是 `root + path.sep`，不是裸前缀）', `root=${ROOT} target=${TRAP}`);
  check(pathIsUnder(pathSep, pathResolve(pathSep, 'etc', 'passwd')) === false, '文件系统根 `/` 一律不算（"谁都归它管"比不授权更危险）', `root=${pathSep}`);
  check(pathIsUnder('', '/x') === false, '空根 ⇒ false', "root=''");
  check(pathIsUnder('C:', 'C:/x') === false, 'Windows 盘根 `C:` ⇒ false（归一化只可能让它更像路径 ⇒ 归一化前后各判一次）', "root='C:'");
  // 非字符串 / null / undefined：一律"不归属"，且**绝不抛**
  const odd = [
    ['null root', () => pathIsUnder(null, '/x')],
    ['undefined root', () => pathIsUnder(undefined, undefined)],
    ['number root', () => pathIsUnder(42, '/x')],
    ['object root', () => pathIsUnder({}, [])],
    ['null target', () => pathIsUnder(ROOT, null)],
    ['array target', () => pathIsUnder(ROOT, [])],
  ];
  let oddThrew = null;
  const oddOut = [];
  for (const [name, fn] of odd) {
    try { oddOut.push([name, fn()]); } catch (e) { oddThrew = `${name}: ${e.message}`; }
  }
  check(!oddThrew, '非字符串 / null / undefined 输入一律**不抛**（全程 try/catch）', oddThrew || `${odd.length} 组`);
  check(oddOut.length === odd.length && oddOut.every(([, v]) => v === false), '上述每一组都返回 false（"认不出来" = 不归属，绝不是放行）', JSON.stringify(oddOut));
}

console.log('\n⑩ `sessionOwningTarget` / `candidateSessions`：归属会话 = **最长前缀**，且只认宿主会采纳的 cwd');
console.log('  ✅ 覆盖缺口已关闭：`_live` 现已导出 `candidateSessions`（`lib/command.js:6580`）⇒ 本节对它做**直接**断言'
  + '（返回数组 / 去重 / 非对象过滤 / 退化 ctx 不抛）；`hostHonoredCwdOf` 的直接断言在 ⑫。');
console.log('  ⚠ 仍**未被**本测试覆盖（如实登记，不假装覆盖）：本文件不 `apply()`，而 `CURRENT_SESSION` / `WRITER_IDENTITY`'
  + ' 是模块级变量、`_live` 无写入口 ⇒ 二者恒为 `null` ⇒ `candidateSessions` 的 `sessions.get(id)` 兜底支不可达'
  + '（本节末尾有该支的**不可达性断言**）。');
// 为什么"当前会话"那支仍然只能走**真实路径**：要伪造它得有 setter（`_live` 没有、也不该有），
// 伪造出来的东西验证的是伪造品而不是被测代码。`ctx.get('sessions').list()` 才是生产里覆盖面最大的
// 候选来源，也是本文件唯一能真实驱动的那一支。
{
  const mkCtx = (list, opts = {}) => ({
    get: (k) => {
      if (k !== 'sessions') return null;
      if (opts.getThrows) throw new Error('sessions 服务不可用');
      if (opts.nullSessions) return null;
      return { list: opts.listThrows ? () => { throw new Error('list 炸了'); } : () => list };
    },
  });
  const mkSess = (id, cwd) => ({ id, header: { id, cwd } });

  // ── 最长前缀（最具体的工作区） ──
  const SHALLOW = mkSess('sess-shallow', '/proj');
  const DEEP = mkSess('sess-deep', '/proj/nested');
  const ctxAB = mkCtx([SHALLOW, DEEP]);
  check(sessionOwningTarget(ctxAB, '/proj/nested/team/r1/STATE.json') === DEEP, '两个候选都覆盖目标 ⇒ 选**最长前缀**（cwd 更具体的那一个）', 'picked=sess-deep');
  check(sessionOwningTarget(ctxAB, '/proj/team/r1/STATE.json') === SHALLOW, '目标只在浅会话之下 ⇒ 选浅会话', 'picked=sess-shallow');
  check(sessionOwningTarget(mkCtx([DEEP, SHALLOW]), '/proj/nested/team/r1/STATE.json') === DEEP, '候选**顺序无关**（不靠"最后一个赢"）', 'picked=sess-deep');
  check(sessionOwningTarget(ctxAB, '/elsewhere/team/r1/STATE.json') === null, '目标不在任何会话 cwd 之下 ⇒ null（= 不传凭据 = 修复前行为，不新增失败方向）', 'null');
  check(sessionOwningTarget(ctxAB, '') === null, '空目标 ⇒ null（不拿假目标去猜归属）', 'null');

  // ── 只认 `hostHonoredCwdOf`（= `session.header.cwd`） ──
  const ONLY_META = { id: 'sess-fb-meta', header: { id: 'sess-fb-meta', meta: { cwd: '/fb-meta' } } };
  const ONLY_TOP = { id: 'sess-fb-top', cwd: '/fb-top' };
  check(sessionOwningTarget(mkCtx([ONLY_META]), '/fb-meta/team/r1/STATE.json') === null, '★只有 `header.meta.cwd`（回落级）⇒ **不当选** ⇒ null —— 宿主 `sandboxPolicy.resolve()` 只读 `header.cwd`，用回落级 cwd 当选等于交出一份**会被忽略**的凭据（围栏静默退回部署根，Issue #1 后续缺陷原样复现）', 'null');
  check(sessionOwningTarget(mkCtx([ONLY_TOP]), '/fb-top/team/r1/STATE.json') === null, '★只有顶层 `session.cwd`（回落级）⇒ 同样不当选 ⇒ null', 'null');
  const HONORED = mkSess('sess-honored', '/proj');
  const FAKE_DEEPER = { id: 'sess-fake-deeper', cwd: '/proj/only-top' }; // 前缀更长，但只有回落级 cwd
  check(
    sessionOwningTarget(mkCtx([HONORED, FAKE_DEEPER]), '/proj/only-top/team/r1/STATE.json') === HONORED,
    '★负向断言★ 回落级 cwd 的会话**即便前缀更长也不当选**（若按 `sessionCwdOf` 的 4 级回落判定它会赢 ⇒ 交出的凭据被宿主忽略 ⇒ 写入被拒且无任何信号）',
    'picked=sess-honored（不是 sess-fake-deeper）',
  );

  // ══ `candidateSessions`（**直调**）：候选收集 / 去重 / 过滤 / 绝不抛 ══
  // ✅ 曾经的 spec-gap 已关闭：`_live` 现已导出它 ⇒ 以下都是**直接**断言，不再靠"谁当选"去反推。
  // 为什么直调不可省：行为级只看得出"谁当选了"，看不出**形态** —— 返回值是不是数组、
  // 非对象有没有被过滤、无身份候选会不会被误合并、`list()` 退化时会不会抛。这些恰是"候选收集"
  // 这一层的契约，也正是 `sessionOwningTarget` 恒空 / 恒错的根因所在。
  const S_A = mkSess('sess-A', '/proj/a');
  const S_B = mkSess('sess-B', '/proj/b');
  {
    const out = candidateSessions(mkCtx([S_A, S_B]));
    check(Array.isArray(out), '★形态★ 正常 ctx ⇒ 返回**数组**（`Array.isArray`；不是 Set / 迭代器 / undefined）', Object.prototype.toString.call(out));
    check(out.length === 2 && out[0] === S_A && out[1] === S_B, '`list()` 返回 2 个会话 ⇒ 恰好这 2 个、且是**同一对象**（不拷贝、不包装）、顺序保持', JSON.stringify(out.map((s) => s && s.id)));
  }
  {
    // 去重键 = `header.id`（认不出来时回退顶层 `id`）
    const dupA = mkSess('sess-dup-direct', '/proj');        // 同 id 的**第一个**
    const dupB = mkSess('sess-dup-direct', '/proj/nested'); // 同 id 的**第二个**（cwd 更长）
    const out = candidateSessions(mkCtx([dupA, dupB]));
    check(out.length === 1 && out[0] === dupA, '★去重★ 两个候选 id 相同 ⇒ 只保留**第一个**（第二个被丢弃，不是"后者覆盖前者"）', `len=${out.length} kept=${out[0] && out[0].header.cwd}`);
  }
  {
    const h1 = { id: 'top-x', header: { id: 'same-h', cwd: '/h1' } }; // 顶层 id 不同、header.id 相同
    const h2 = { id: 'top-y', header: { id: 'same-h', cwd: '/h2' } };
    const out = candidateSessions(mkCtx([h1, h2]));
    check(out.length === 1 && out[0] === h1, '去重键**优先取 `header.id`**（顶层 `id` 不同、`header.id` 相同 ⇒ 仍判为同一个，只留第一个）', `len=${out.length}`);
  }
  {
    const n1 = { id: 'sess-top-id', header: { cwd: '/n1' } }; // 没有 `header.id`，靠顶层 id 认身份
    const n2 = { id: 'sess-top-id', header: { cwd: '/n2' } };
    const out = candidateSessions(mkCtx([n1, n2]));
    check(out.length === 1 && out[0] === n1, '★去重键回退★ 没有 `header.id` ⇒ 用顶层 `id` 去重（同样只留第一个）', `len=${out.length}`);
  }
  {
    // ★反向边界★：两个候选**都没有任何 id** ⇒ 不做去重（没有身份就没有可比对的键）
    const anon1 = { header: { cwd: '/anon' } };
    const anon2 = { header: { cwd: '/anon' } };
    const out = candidateSessions(mkCtx([anon1, anon2]));
    check(out.length === 2 && out[0] === anon1 && out[1] === anon2, '★反向边界★ 两个候选都无 id ⇒ **不合并**（把空 id 当成同一个键会**丢掉真候选** ⇒ 归属判 null ⇒ 写入凭空退回 Issue #1 的失败方向）', `len=${out.length}`);
  }
  {
    const out = candidateSessions(mkCtx([null, 42, 'x', S_A]));
    check(out.length === 1 && out[0] === S_A, '★过滤★ 非对象候选（`null` / 数字 / 字符串）被丢弃，真会话原样保留', JSON.stringify(out.map((s) => s && s.id)));
  }
  {
    // 分层边界：`{}` 是对象 ⇒ 本层**不**过滤它；"认不出 cwd"由下一层 `hostHonoredCwdOf`（⑫）判 undefined 拦下
    const out = candidateSessions(mkCtx([{}, S_A]));
    check(out.length === 2 && out[0] && out[1] === S_A, '对象但无 `header.cwd` 的候选**留在数组里**（过滤职责在下一层 `hostHonoredCwdOf`，不在本层 —— 两层的分工是一条可断言的契约）', `len=${out.length}`);
  }
  {
    // ── 退化 ctx：一律**返回数组**（可能为空）且**绝不抛**（机会式获取） ──
    const degen = [
      ['`ctx = null`', null],
      ['`ctx = undefined`', undefined],
      ['`ctx` 没有 `get`', {}],
      ['`ctx.get` 不是函数', { get: 5 }],
      ['`ctx.get` 抛错', { get: () => { throw new Error('sessions 服务不可用'); } }],
      ['`ctx.get("sessions")` 返回 null', { get: () => null }],
      ['`sessions` 对象没有 `list`', { get: () => ({}) }],
      ['`list` 不是函数', { get: () => ({ list: 42 }) }],
      ['`list()` 抛错', { get: () => ({ list: () => { throw new Error('list 炸了'); } }) }],
      ['`list()` 返回 null', { get: () => ({ list: () => null }) }],
      ['`list()` 返回非可迭代', { get: () => ({ list: () => 42 }) }],
    ];
    let threw = null;
    const outs = [];
    for (const [name, ctx] of degen) {
      try { const o = candidateSessions(ctx); outs.push([name, Array.isArray(o), o.length]); }
      catch (e) { threw = `${name}: ${e.message}`; }
    }
    check(!threw, `${degen.length} 种退化 ctx 一律**不抛**（机会式获取：拿不到活存储就只剩其它候选）`, threw || `ok（${degen.length} 组）`);
    check(outs.length === degen.length && outs.every(([, isArr, len]) => isArr && len === 0), '上述每一种退化 ctx 都返回**空数组**（数组形态而非 null/undefined —— 唯一调用方的 `for...of` 不会因此炸）', JSON.stringify(outs));
  }
  {
    // ── `sessions.get(id)` 兜底支：**不可达**（如实登记；不伪造模块级状态） ──
    // 触发条件：`sid` 非空（`CURRENT_SESSION` 的 id / `header.id`，再退回 `WRITER_IDENTITY.sessionId`）
    // **且** `sessions.get` 是函数。`_live` 未导出 `CURRENT_SESSION` / `WRITER_IDENTITY`（本次实测确认），
    // 本文件又不 `apply()` ⇒ 两者恒为 `null` ⇒ `sid === ''` ⇒ 该支**永不进入**，本文件无法执行它。
    // 不给它加 setter、也不去伪造那两个模块级变量（那样验证的是伪造品，不是被测代码）——
    // 故这里**不写该支的通过断言**，改断言它的**不可达性**本身：
    let getCalls = 0;
    const ctxWithGet = { get: () => ({ list: () => [S_A], get: () => { getCalls += 1; return S_B; } }) };
    const out = candidateSessions(ctxWithGet);
    check(out.length === 1 && out[0] === S_A, '`sessions.get(id)` 兜底支**不可达**：候选只来自 `list()`（没有把 `get` 查到的会话补进来）', JSON.stringify(out.map((s) => s && s.id)));
    check(getCalls === 0, '同上：`sessions.get` **一次都没被调用**（没有当前会话 id ⇒ 兜底支的触发条件不存在）—— 该支因此未被本文件覆盖，原因是模块级状态无写入口', `getCalls=${getCalls}`);
  }

  // ── 以下是**行为级（集成）复核**：候选收集确实在喂 `sessionOwningTarget`（与上面的直调互补） ──
  // 去重可观测的原理：`sessionOwningTarget` 只认**严格更长**的前缀（`len > bestLen`）⇒
  // "同 id 的第二个对象"若**没被丢掉**，它就会以更长的 cwd 赢；被丢掉则第一个（更短的）赢。
  const dupShallow = mkSess('sess-dup', '/proj');         // 同 id 的**第一个**（前缀更短）
  const dupDeep = mkSess('sess-dup', '/proj/nested');     // 同 id 的**第二个**（前缀更长）
  check(
    sessionOwningTarget(mkCtx([dupShallow, dupDeep]), '/proj/nested/team/r1/STATE.json') === dupShallow,
    '★去重（行为级）★ 同 id 的第二个对象被丢弃 —— 它明明覆盖目标且前缀更长，若候选里还在就一定会赢',
    'picked=sess-dup(浅)——若返回深的那一个即"没去重"',
  );
  const noHeaderIdShallow = { id: 'sess-no-header-id', header: { cwd: '/proj' } };       // 无 `header.id`，靠顶层 id 认身份
  const noHeaderIdDeep = { id: 'sess-no-header-id', header: { cwd: '/proj/nested' } };
  check(
    sessionOwningTarget(mkCtx([noHeaderIdShallow, noHeaderIdDeep]), '/proj/nested/team/r1/STATE.json') === noHeaderIdShallow,
    '★去重键回退★ 没有 `header.id` 时用顶层 `id` 去重（同上，第二个更长的不许赢）',
    'picked=浅（靠 header.id ?? id 认身份）',
  );
  check(sessionOwningTarget(mkCtx([null, 'not-a-session', 0, SHALLOW]), '/proj/team/r1/STATE.json') === SHALLOW, '非对象候选（null / 字符串 / 数字）被过滤掉，不影响真会话当选', 'picked=sess-shallow');
  let candThrew = null;
  const candOut = [];
  try {
    candOut.push(sessionOwningTarget(mkCtx([], { getThrows: true }), '/proj/x/STATE.json'));
    candOut.push(sessionOwningTarget(mkCtx([], { nullSessions: true }), '/proj/x/STATE.json'));
    candOut.push(sessionOwningTarget(mkCtx([], { listThrows: true }), '/proj/x/STATE.json'));
    candOut.push(sessionOwningTarget(null, '/proj/x/STATE.json'));
    candOut.push(sessionOwningTarget({}, '/proj/x/STATE.json'));
  } catch (e) { candThrew = e; }
  check(!candThrew, '`ctx.get` 抛错 / 返回 null、`list()` 抛错、`ctx` 为 null 或没有 `get` ⇒ 候选收集**不抛**（机会式获取）', candThrew ? String(candThrew.message) : 'ok');
  check(candOut.length === 5 && candOut.every((v) => v === null), '上述每一种退化 ctx 下"没有候选" ⇒ 归属为 null（= 不授权 = 修复前行为）', JSON.stringify(candOut));
  check(sessionOwningTarget(mkCtx([SHALLOW, DEEP]), '/proj/team/r1/STATE.json') === SHALLOW, '反空转：正常 ctx 下候选确实被收集到（`list()` 这一支真的在喂数据，不是恒空）', 'picked=sess-shallow');
}

console.log('\n⑪ `policyResolverForTargets`：授权对象按**归属会话**解析（传会话**对象**，不传 id）');
// 事件上报的两个形态（同步抛 / 拒绝的 promise）已在 ⑧f 断言（评审要求把那条补进 ⑧），此处不重复，
// 只守**返回值契约**：拿到什么凭据、拿不到时返回什么、观测通道缺席时是否仍不抛。
{
  const OWNER = { id: 'sess-owner', header: { id: 'sess-owner', cwd: '/proj' } };
  const ctx = { get: (k) => (k === 'sessions' ? { list: () => [OWNER] } : null) };
  const TARGET = '/proj/team/r12/STATE.json';
  // ① 归属会话在场 ⇒ 收到**会话对象**，且 workspaceRoot == 该会话的 header.cwd
  {
    const calls = [];
    const sp = { resolve: (arg) => { calls.push(arg); return { mode: 'workspace-write', workspaceRoot: arg && arg.session && arg.session.header && arg.session.header.cwd }; } };
    const resolvePolicy = policyResolverForTargets(ctx, sp, null);
    const policy = await resolvePolicy(TARGET);
    check(calls.length === 1, '`sp.resolve` 恰好被调用一次（每个目标解析一次）', `calls=${calls.length}`);
    check(calls[0] && calls[0].session === OWNER, '★ `sp.resolve` 收到的是**会话对象本身**（不是 id 字符串）—— 宿主读的是 `session?.header.cwd` 与 `session.id`，传 id 无效', calls[0] && typeof calls[0].session);
    check(policy && policy.workspaceRoot === OWNER.header.cwd, '解析出的 `workspaceRoot` == **归属会话**的 `header.cwd`（凭据与目标同源）', JSON.stringify(policy && policy.workspaceRoot));
  }
  // ② 无归属会话 ⇒ undefined，且**根本不调用** `sp.resolve`（不拿假会话去要授权）
  {
    const calls = [];
    const sp = { resolve: (arg) => { calls.push(arg); return { mode: 'workspace-write', workspaceRoot: '/whatever' }; } };
    const resolvePolicy = policyResolverForTargets(ctx, sp, null);
    const out = await resolvePolicy('/elsewhere/team/r12/STATE.json');
    check(out === undefined, '目标不在任何会话之下 ⇒ undefined（= 不传第 5 参 = 修复前行为）', String(out));
    check(calls.length === 0, '无归属时 `sp.resolve` **一次都没被调用**（不伪造授权）', `calls=${calls.length}`);
  }
  // ③ 候选收集本身退化（`ctx.get` 抛错）⇒ 同口径：undefined、不抛
  {
    const sp = { resolve: () => ({ workspaceRoot: '/x' }) };
    const resolvePolicy = policyResolverForTargets({ get: () => { throw new Error('sessions 服务不可用'); } }, sp, null);
    let threw = null; let out;
    try { out = await resolvePolicy(TARGET); } catch (e) { threw = e; }
    check(!threw && out === undefined, '`ctx.get` 抛错 ⇒ 仍返回 undefined 且不抛（候选缺失只降级、不放大）', threw ? String(threw.message) : String(out));
  }
  // ④ `onEvent` 缺席（省略 / 显式 null）⇒ 仍返回 undefined，且不得抛
  {
    const sp = { resolve: () => { throw new Error('宿主策略不可用'); } };
    const omitted = policyResolverForTargets(ctx, sp);           // 第 3 参省略
    const explicitNull = policyResolverForTargets(ctx, sp, null); // 第 3 参显式 null
    let threw = null; const outs = [];
    try { outs.push(await omitted(TARGET)); outs.push(await explicitNull(TARGET)); } catch (e) { threw = e; }
    check(!threw, '`onEvent` 省略 / 为 null ⇒ 抛错路径**不 rethrow**（观测通道是可选依赖，不是必需依赖）', threw ? String(threw.message) : 'ok');
    check(outs.length === 2 && outs.every((v) => v === undefined), '`onEvent` 缺席时同样返回 undefined', outs.map(String).join(' | '));
  }
  // ⑤ `sp` 本身缺失/形状不对 ⇒ 不抛（调用方只在 `typeof sp.resolve === 'function'` 时才构造它，这里是纵深防御）
  {
    let threw = null; let out;
    try { out = await policyResolverForTargets(ctx, null, null)(TARGET); } catch (e) { threw = e; }
    check(!threw, '`sp` 为 null ⇒ 不抛（纵深防御）', threw ? String(threw.message) : 'ok');
    check(out === undefined, '`sp` 为 null ⇒ 返回 undefined', String(out));
  }
}

console.log('\n⑫ `hostHonoredCwdOf`：**宿主实际会读**的那个 cwd —— 只认 `session.header.cwd`，且必须是非空字符串');
// 为什么非有不可：`sessionOwningTarget` 拿它的返回值决定"谁当选"，`policyResolverForTargets` 最终把
// `workspaceRoot` 交给宿主 `sandboxPolicy.resolve()`（只读 `session?.header.cwd`）。两处口径一旦分叉，
// 就会出现"凭据看起来有授权、宿主却**静默**回落部署根 ⇒ 写入被拒且无任何信号"（Issue #1 后续缺陷的机制）。
// ⑩ 只能经由当选结果**间接**看它（"回落级 cwd 的会话不当选"那两条）；`_live` 现已导出它 ⇒ 本节对它
// **直接**断言，每条负向用例都对应一个"这算不算凭据"的方向。
{
  // 统一 try/catch：既断言取值，也断言**绝不抛**（一条意外的抛错不该把后面所有断言连带吞掉）
  const hh = (s) => { try { return { v: hostHonoredCwdOf(s) }; } catch (e) { return { err: String((e && e.message) || e) }; } };
  const CASES = [
    // [用例名, 输入, 期望]
    ['`{header:{cwd:"/proj"}}` ⇒ 原样返回', { header: { cwd: '/proj' } }, '/proj'],
    ['`header.cwd` 与 `header.meta.cwd` 同时在 ⇒ 取 `header.cwd`（宿主读的那一个，不是回落级）', { id: 's', header: { id: 's', meta: { cwd: '/ignored' }, cwd: '/proj' } }, '/proj'],
    ['尾分隔符**原样保留**（归一化/去尾分隔符是 `pathIsUnder` 的职责；这里顺手归一化等于造出第二份口径）', { header: { cwd: '/proj/' } }, '/proj/'],
    ['★只有 `header.meta.cwd`（`sessionCwdOf` 的第 1 级回落，宿主**不读**）⇒ undefined', { header: { meta: { cwd: '/proj' } } }, undefined],
    ['★只有顶层 `cwd`（回落级）⇒ undefined', { cwd: '/proj' }, undefined],
    ['★顶层 `meta.cwd` + 顶层 `cwd` 都在、但没有 `header.cwd` ⇒ undefined', { meta: { cwd: '/proj' }, cwd: '/proj' }, undefined],
    ['★`header` 在、但里面只有 `meta.cwd` ⇒ undefined', { id: 's', header: { id: 's', meta: { cwd: '/proj' } } }, undefined],
    ['`null` ⇒ undefined', null, undefined],
    ['`undefined` ⇒ undefined', undefined, undefined],
    ['`{}` ⇒ undefined', {}, undefined],
    ['`{header:null}` ⇒ undefined', { header: null }, undefined],
    ['`{header:{}}` ⇒ undefined', { header: {} }, undefined],
    ['`{header:42}`（header 不是对象）⇒ undefined', { header: 42 }, undefined],
    ['非字符串 `header.cwd`（数字 42）⇒ undefined', { header: { cwd: 42 } }, undefined],
    ['空字符串 `header.cwd` ⇒ undefined（空串是"没给"，不是"根目录"）', { header: { cwd: '' } }, undefined],
    ['`String` **包装对象**（`new String("/proj")`）⇒ undefined（`typeof` 严格判原始字符串，不认包装对象）', { header: { cwd: new String('/proj') } }, undefined],
    ['数组 `header.cwd` ⇒ undefined', { header: { cwd: ['/proj'] } }, undefined],
    ['布尔 `header.cwd`（false）⇒ undefined', { header: { cwd: false } }, undefined],
  ];
  for (const [name, input, expected] of CASES) {
    const r = hh(input);
    check(!r.err && r.v === expected, name, r.err ? `threw: ${r.err}` : `→ ${JSON.stringify(r.v)}（期望 ${JSON.stringify(expected)}）`);
  }
  // ── ⚠ spec-gap（规格未覆盖，如实登记；不当作规格要求、也不算缺陷） ──
  // 边界表只写了"非字符串 ⇒ undefined"与"空串 ⇒ undefined"，**没有**规定"纯空白串"。
  // 实测：`'   '` 是 truthy 的字符串 ⇒ 被**原样返回**（本函数不 trim，也不校验像不像路径）。
  // 影响面已实测（下一条），故只登记、不升级：唯一调用方 `sessionOwningTarget` 会把它交给 `pathIsUnder`，
  // 而 `path.resolve('   ')` = `<进程 cwd>/   ` ⇒ 除非目标真落在"名字是空格的目录"之下，否则判 false
  // ⇒ 该会话**永远不当选** ⇒ 现状下不会交出一份"宿主会忽略"的凭据。
  {
    const WS = { id: 'sess-ws', header: { id: 'sess-ws', cwd: '   ' } };
    const r = hh(WS);
    check(!r.err && r.v === '   ', '⚠ spec-gap 登记（**非**规格要求）：纯空白 `header.cwd` 被**原样返回**（未 trim、未做形状校验）—— 规格只覆盖"非字符串"与"空串"两种', JSON.stringify(r.v));
    const wsCtx = { get: (k) => (k === 'sessions' ? { list: () => [WS] } : null) };
    check(sessionOwningTarget(wsCtx, '/proj/team/r1/STATE.json') === null, '⚠ 同一 gap 的影响面（已实测）：该会话**永远不当选**（`pathIsUnder` 判 false）⇒ 现状下不会产生"凭据被宿主忽略"的静默失败', 'null');
  }
}

console.log('');
if (fail > 0) {
  console.log(`✗ cordisFsPort 测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ cordisFsPort 测试通过（宿主 CAS 路径实跑：版本栅栏 / 陈旧重试 / 范围拒绝 / schema 告警 / 沙箱授权第 5 参透传 / 逐目标授权链直调：pathIsUnder·sessionOwningTarget·candidateSessions·policyResolverForTargets·hostHonoredCwdOf）');
