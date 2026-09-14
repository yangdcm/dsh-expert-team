// 测试：`cordisFsPort(ctx.fs)` —— **真实宿主路径**首次实跑（C2）
//
// 背景：`lib/artifact-writer.js` 提供两个 fsPort：
//   · `nodeFsPort()`  —— 回退实现（纯 Node 真实读写）
//   · `cordisFsPort(ctxFs)` —— 走宿主 `ctx.fs` 的**文件级 CAS**（`FsWriteIntent`）
// 此前**全部测试都只走 nodeFsPort**，而 `apply()` 里若发现宿主提供 `ctx.fs` 就会**切换**到
// cordisFsPort ⇒ 生产路径长期处于"设计可行、行为待验"状态（WORKLOG 已如实标注多轮）。
//
// 官方契约（`@deepseek-ai/dsh-fs`）：
//   resolve(path) → 版本化 target
//   readText(target) / stat(target) → {version}
//   writeText(target, content, intent | undefined)
//   intent = {kind:'createIfAbsent'} | {kind:'replaceIfVersion', version}
//   失配时 provider 报 **FS_STALE_VERSION**
//
// 本测试用一个**按该契约实现的内存宿主 fs**（含版本栅栏与陈旧报错）驱动真实 cordisFsPort，
// 覆盖：路径解析、首次创建、版本栅栏、陈旧重试、范围硬排除、schema 告警、归因与 revision。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M32。
// 运行：node cordis-fs-port.test.mjs

import { cordisFsPort, createArtifactWriter, DEFAULT_SCHEMA_GUARDS } from './lib/artifact-writer.js';

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/**
 * 按 `@deepseek-ai/dsh-fs` 契约实现的内存宿主 fs（故意**不**做任何宽容处理）。
 * 关键：`replaceIfVersion` 的 version 与磁盘不符 ⇒ 抛 `code: 'FS_STALE_VERSION'`。
 */
function makeHostFs() {
  const files = new Map(); // target -> {text, version}
  let versionSeq = 0;
  const stats = { resolve: 0, readText: 0, stat: 0, writeText: 0, staleRejects: 0 };
  return {
    files, stats,
    // 宿主把相对/绝对路径解析成"版本化 target"（真实实现会做 sandbox 归一化）
    async resolve(p) { stats.resolve += 1; return 'host://' + String(p).replace(/^host:\/\//, '') },
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
    async writeText(target, content, intent) {
      stats.writeText += 1;
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

const events = [];
const mkWriter = (hostFs) => createArtifactWriter({
  fsPort: cordisFsPort(hostFs),
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

console.log('');
if (fail > 0) {
  console.log(`✗ cordisFsPort 测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ cordisFsPort 测试通过（宿主 CAS 路径实跑：版本栅栏 / 陈旧重试 / 范围拒绝 / schema 告警）');
