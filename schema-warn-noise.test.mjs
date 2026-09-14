// 测试：schema 告警的两个真实后续问题（2026-09-11 用户实机触发）
//
// 触发现场：作者重启 dsh web 后，控制台立刻出现
//   [expert-team] 工件 schema 告警：…/STATE.json —— coverage 的元素应为对象 {constraint, tasks}；
//   检测到非对象元素（下游会静默兜底并渲染空行）
// 这是**设计中的行为**在起作用（写入点 guard 把存量违约喊出来）。但它暴露了两个真问题：
//
//   ① **告警会刷屏**：C3 的「派工登记」回写会在**每次成员变化**时改写同一份 STATE.json，
//      而存量脏字段（coverage）每次都会被重新检查 ⇒ 同一条告警反复打印。
//      而"噪音会让用户对告警整体降权"正是本项目反复记录的失败模式。
//      ⇒ 按「文件 + 告警内容」**去重**（不影响"第一次一定喊"，也不隐藏不同内容的告警）。
//
//   ② **`/team migrate` 修不好它**：migrate 里判的是 `if (!Array.isArray(state.coverage))`，
//      而 `["pm","architect",…]` **本身就是数组** ⇒ 直接放行。用户在 `/team check` 看到
//      「先 /team migrate」的提示，**跑了也没用**（migrate 的判据比 guard 弱）。
//      ⇒ 改为按**元素形状**归一（不臆造 `{constraint:…}`：角色名不是约束；原值留档到 coverageLegacy）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M38 / M39。
// 运行：node schema-warn-noise.test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { pushActivityEvent, SCHEMA_WARN_SEEN, normalizeCoverage } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 捕获 console.warn 调用（测完还原）。 */
function captureWarn(fn) {
  const calls = [];
  const orig = console.warn;
  console.warn = (...a) => { calls.push(a.join(' ')) };
  try { fn() } finally { console.warn = orig }
  return calls;
}

console.log('# schema 告警的噪音与可修复性（实机触发的两个后续问题）\n');

console.log('① 去重：同一条告警只喊一次（C3 回写会反复触发同一份存量脏数据）');
{
  SCHEMA_WARN_SEEN.clear();
  const e = { type: 'schema-warn', target: '/p/STATE.json', message: 'coverage 的元素应为对象' };
  const calls = captureWarn(() => { for (let i = 0; i < 5; i += 1) pushActivityEvent(e) });
  check(calls.length === 1, '连续 5 次同一告警 → 只打印 1 次', `实际 ${calls.length} 次`);
  check(/schema 告警/.test(calls[0] || ''), '第一次确实喊了（去重不等于静默）', (calls[0] || '').slice(0, 40));
}

console.log('\n② 去重不得掩盖**不同**的告警');
{
  SCHEMA_WARN_SEEN.clear();
  const calls = captureWarn(() => {
    pushActivityEvent({ type: 'schema-warn', target: '/p/STATE.json', message: 'A' });
    pushActivityEvent({ type: 'schema-warn', target: '/p/STATE.json', message: 'B' }); // 同文件不同内容
    pushActivityEvent({ type: 'schema-warn', target: '/p/TASKS.json', message: 'A' }); // 同内容不同文件
    pushActivityEvent({ type: 'schema-warn', target: '/p/STATE.json', message: 'A' }); // 重复
  });
  check(calls.length === 3, '4 次里 3 条不同 → 打印 3 次', `实际 ${calls.length} 次`);
}

console.log('\n③ 非 schema-warn 事件不受去重影响（scope-denied / version-stale 等仍逐条上报）');
{
  SCHEMA_WARN_SEEN.clear();
  const calls = captureWarn(() => {
    for (let i = 0; i < 3; i += 1) pushActivityEvent({ type: 'version-stale', target: '/p/STATE.json', attempt: i + 1, error: 'FS_STALE_VERSION' });
  });
  check(calls.length === 3, 'version-stale 每次尝试都报（重试诊断需要）', `实际 ${calls.length} 次`);
  const none = captureWarn(() => pushActivityEvent(null));
  check(none.length === 0, '空事件不报');
}

console.log('\n④ 【关键】migrate 必须按**元素形状**归一，而不是只判 Array.isArray');
{
  // 实测的脏数据形状
  const dirty = ['pm', 'architect', 'researcher'];
  const r = normalizeCoverage(dirty);
  check(r.changed === true, '真实脏数据（角色名字符串数组）**必须被判为需要修**（旧判据会放行）', 'changed=' + r.changed);
  check(Array.isArray(r.coverage) && r.coverage.length === 0, 'coverage 置空', JSON.stringify(r.coverage));
  check(JSON.stringify(r.coverageLegacy) === JSON.stringify(dirty), '原值留档到 coverageLegacy（可审计，不静默丢）', JSON.stringify(r.coverageLegacy));
  check(/角色名不是「约束」/.test(r.note), '说明为什么不臆造映射', r.note.slice(0, 60));
}

console.log('\n⑤ 归一的其他输入形态');
{
  const ok = [{ constraint: 'a', tasks: ['T-01'] }];
  const r1 = normalizeCoverage(ok);
  check(r1.changed === false && r1.coverage === ok, '**合规数据不得被改动**（否则会把好数据洗掉）', r1.note);

  const mixed = [{ constraint: 'a', tasks: [] }, 'pm', null, []];
  const r2 = normalizeCoverage(mixed);
  check(r2.changed === true && r2.coverage.length === 0, '混合形态 → 需要修', JSON.stringify(r2.coverage));
  check(/3 条/.test(r2.note), '点名坏元素条数', r2.note.slice(0, 50));

  const r3 = normalizeCoverage(undefined);
  check(r3.changed === true && r3.coverage.length === 0 && r3.coverageLegacy === undefined, '缺失字段 → 补 []，不留无意义的 legacy');
  check(/补为 \[\]/.test(r3.note), 'note 说明是"补"而非"清"', r3.note);

  const r4 = normalizeCoverage('not-an-array');
  check(r4.changed === true && r4.coverageLegacy === 'not-an-array', '非数组 → 同样留档原值');
  check(normalizeCoverage([]).changed === false, '空数组合规 → 不改');
}

console.log('\n⑥ 接线检查：migrate 真的用了它，且去重表已接进事件推送');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  // 只扫**代码行**：注释里引用了旧判据（作为"为什么改"的说明），不能用全文匹配否则自我误报
  const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check(/const covFix = normalizeCoverage\(state\.coverage\)/.test(codeLines), 'migrate 调用 normalizeCoverage');
  check(!/if \(!Array\.isArray\(state\.coverage\)\) state\.coverage = \[\]/.test(codeLines), '旧的「只判 Array.isArray」判据已从**代码**移除（注释里的引用不算）');
  // 消费端也不再有"静默兜底"：snapshotRun 必须过滤形状而非原样透传
  check(!/coverage: Array\.isArray\(state\.coverage\) \? state\.coverage : \[\]/.test(codeLines), 'snapshotRun 的静默兜底已移除（否则脏数组会被渲染成空行）');
  check(/coverageSafe/.test(codeLines) && /coverageRaw: state\.coverage/.test(codeLines), '改为"过滤形状 + 原始值另存"（渲染不空白，信息不丢）');
  check(/state\.coverageLegacy = covFix\.coverageLegacy/.test(src), '原值留档写进 STATE.json');
  check(/const SCHEMA_WARN_SEEN = new Set\(\)/.test(src), '去重表进程级');
  check(/if \(SCHEMA_WARN_SEEN\.has\(sig\)\) return/.test(src), 'schema-warn 分支里做了去重');
  // 去重只应作用于 schema-warn 分支：确认 return 在其它分支之前/之外不被误用
  const warnAt = src.indexOf("if (e.type === 'schema-warn') {");
  const block = src.slice(warnAt, warnAt + 500);
  check(/return;/.test(block), '去重命中后 return（不落后续分支）', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ schema 告警噪音测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ schema 告警噪音测试通过（去重但不同内容不掩盖；migrate 按元素形状可真正修好脏数据）');
