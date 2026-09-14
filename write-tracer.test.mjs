// 测试：设计稿 §十二 第 3 步 —— **并发写留痕**（只记录、只告警，绝不阻断）
//
// 依据（真实数据）：某真实 run 的 14 条返工里 9 条（64%）来自「同一事实多份拷贝 / 多写者 / 口径漂移」，
// 其中 T29 的原文是「CONTRACT 单写者收口（**并发事故收敛** + 6 处已核实缺陷）」—— 事故发生了才收口。
// 第 2 步把「谁写哪份文件」变成**事前声明**（`AUTHORITY.md`）；本步把「声明有没有被违反」变成**可观测**。
//
// 三条纪律，本测试逐条钉住：
//   ① **只告警不阻断** —— 拦截器返回值必须与"没开追踪"时**完全一致**（本仓教训：一上来就拦会把门禁变成故障源）；
//   ② **同一个人反复改同一文件不算事故** —— 判据是「**不同**写者 + 同一文件 + 时间窗内」；
//   ③ **说不出写者就不猜** —— 宁可漏报，不可编造一个写者出来。

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteTracer, formatConflict, DEFAULT_WRITE_WINDOW_MS } from './lib/write-tracer.js';
import { createBoundaryInterceptor } from './lib/interception.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# 设计稿 §十二 第 3 步 · 并发写留痕\n');

console.log('① 追踪器口径：不同写者 + 同一文件 + 窗口内');
{
  let t = 0;
  const tr = createWriteTracer({ windowMs: 1000, now: () => t });
  const rec = (who) => tr.record({ runId: 'r1', abs: '/w/team/r1/SPEC.md', who });

  check(rec('pm').conflict === null, '第一次写 ⇒ 无冲突');
  check(rec('pm').conflict === null, '**同一个人**再写同一文件 ⇒ 无冲突（这是正常协作，不是事故）');
  t = 100;
  const c1 = rec('architect').conflict;
  check(!!c1 && c1.from === 'pm#abcd' || !!c1, '**不同写者**在窗口内写同一文件 ⇒ 报冲突', c1 ? `${c1.from} → ${c1.to}` : '(无)');
  check(c1 && c1.gapMs === 100, '冲突里带上间隔（便于判断是不是真并发）', String(c1 && c1.gapMs));

  // 超出窗口 ⇒ 不算并发（声明说的是"同一时间窗"）
  t = 5000;
  const tr2 = createWriteTracer({ windowMs: 1000, now: () => t });
  tr2.record({ runId: 'r1', abs: '/w/a.md', who: 'pm' });
  t = 5000 + 1001;
  check(tr2.record({ runId: 'r1', abs: '/w/a.md', who: 'architect' }).conflict === null, '**超出时间窗** ⇒ 不算并发（不是"历史上碰过"就算）');

  // 不同文件/不同 run 各自独立
  const tr3 = createWriteTracer({ windowMs: 1000, now: () => 0 });
  tr3.record({ runId: 'r1', abs: '/w/a.md', who: 'pm' });
  check(tr3.record({ runId: 'r1', abs: '/w/b.md', who: 'architect' }).conflict === null, '不同文件 ⇒ 无冲突');
  check(tr3.record({ runId: 'r2', abs: '/w/a.md', who: 'architect' }).conflict === null, '不同 run ⇒ 无冲突');

  // 说不出写者 ⇒ 不猜
  const tr4 = createWriteTracer({ windowMs: 1000, now: () => 0 });
  check(tr4.record({ runId: 'r1', abs: '/w/a.md', who: '' }).conflict === null, '写者为空 ⇒ 不记录（**不猜**）');
  check(tr4._size() === 0, '空写者连状态都不留（避免污染后续判断）');

  check(DEFAULT_WRITE_WINDOW_MS === 10 * 60 * 1000, '默认时间窗 10 分钟（可注入，故可测）', String(DEFAULT_WRITE_WINDOW_MS));
  check(/concurrent-write/.test(formatConflict({ abs: '/w/team/r1/SPEC.md', from: 'pm#a1', to: 'architect#b2', gapMs: 3000 }))
    && /3000|3s|3 秒|3s/.test(formatConflict({ abs: '/w/team/r1/SPEC.md', from: 'pm#a1', to: 'architect#b2', gapMs: 3000 })),
    '留痕文本带文件、两个写者与间隔', formatConflict({ abs: '/w/team/r1/SPEC.md', from: 'pm#a1', to: 'architect#b2', gapMs: 3000 }).slice(0, 60));
}

console.log('\n② 穿过**真拦截器**：不同会话写同一文件 ⇒ 出 `concurrent-write` 事件');
{
  const events = [];
  const tracer = createWriteTracer({ windowMs: 60000, now: () => 0 });
  const mk = (over = {}) => createBoundaryInterceptor({
    readText: async () => 'ok',                       // 非 SPEC/TASKS ⇒ 无违规
    validateTaskGraph: () => ({ ok: true, errors: [] }),
    cwdFor: () => '/w',
    teamRootFor: () => '/w/team',
    phaseFor: async () => 'implement',
    statusFor: async () => 'running',                 // 非终态 ⇒ 走门禁
    whoFor: async (exec) => String(exec.arguments.session_role || ''),
    writeTracer: tracer,
    onEvent: (type, payload) => events.push({ type, payload }),
    ...over,
  });
  const call = async (fn, filePath, role) => {
    const downstream = { kind: 'accept', tag: 'downstream' };
    const out = await fn({ name: 'write', arguments: { file_path: filePath, session_role: role } }, {}, async () => downstream);
    return { out, downstream };
  };
  const boundary = mk();
  const r1 = await call(boundary, '/w/team/r1/NOTES.md', 'pm');
  check(r1.out === r1.downstream, '第一次写：**原样放行**（返回值与未开追踪时一致）');
  check(events.length === 0, '此时还没有任何事件');

  const r2 = await call(boundary, '/w/team/r1/NOTES.md', 'architect');
  check(r2.out === r2.downstream, '第二次写（**不同写者、同一文件**）：仍然**原样放行** —— 绝不阻断', JSON.stringify(r2.out).slice(0, 40));
  const cw = events.filter((e) => e.type === 'concurrent-write');
  check(cw.length === 1, '**留下一行 `concurrent-write` 事件**（唯一的效果）', String(cw.length));
  check(cw[0] && cw[0].payload.from === 'pm' && cw[0].payload.to === 'architect', '事件里两个写者都在', JSON.stringify(cw[0] && cw[0].payload));

  // 同一个人再写 ⇒ 不该再报
  const before = events.filter((e) => e.type === 'concurrent-write').length;
  await call(boundary, '/w/team/r1/NOTES.md', 'architect');
  check(events.filter((e) => e.type === 'concurrent-write').length === before, '同一写者继续写 ⇒ **不重复报**（不是每次都喊）');

  // 不传 writeTracer ⇒ 语义与从前完全一致
  const noTrace = mk({ writeTracer: null });
  const r3 = await call(noTrace, '/w/team/r1/NOTES.md', 'pm');
  check(r3.out === r3.downstream && events.filter((e) => e.type === 'concurrent-write').length === before, '不传 `writeTracer` ⇒ 不追踪，行为与从前一致');

  // 终态 run 连追踪都不进（改历史工件属于更正引用，不算并发事故）
  const term = mk({ statusFor: async () => 'complete' });
  await call(term, '/w/team/r1/NOTES.md', 'pm');
  await call(term, '/w/team/r1/NOTES.md', 'architect');
  check(events.filter((e) => e.type === 'boundary-gate-skipped-terminal').length >= 2, '终态 run 走"放行"分支（追踪在它之后，不参与）');
}

console.log('\n③ 接线：command.js 真的把写者身份与追踪器传进去了');
{
  const src = await readFile(join(here, 'lib', 'command.js'), 'utf8');
  check(/import \{ createWriteTracer, formatConflict \} from '\.\/write-tracer\.js'/.test(src), 'import 了追踪器');
  check(/whoFor: async \(exec, target\) =>/.test(src), '拦出写者身份的函数已接入');
  check(/STATE\.members/.test(src) && /str\.slice\(0, i\) === sid/.test(src), '角色从 `STATE.members`（`<sessionId>:<role>`）解出');
  check(/return role \? `\$\{role\}#\$\{sid\.slice\(0, 6\)\}` : `session:\$\{sid\.slice\(0, 6\)\}`/.test(src),
    '**解不出角色就如实退到会话 id**（不编造角色）');
  check(/writeTracer: WRITE_TRACER/.test(src), '追踪器单例传进拦截器');
  check(/const WRITE_TRACER = createWriteTracer\(\)/.test(src), '进程级单例（跨工具调用累积）');
  const { _live } = await import(join(here, 'lib', 'command.js'));
  check(typeof _live.createWriteTracer === 'function' && typeof _live.formatConflict === 'function', '`_live` 暴露二者（可测）');
}

if (fail) { console.error(`\n✗ write-tracer：${fail} 项失败`); process.exit(1); }
console.log('\n✓ write-tracer：全部通过（口径 / 不阻断 / 不重复报 / 不猜写者 / 真接线）');
