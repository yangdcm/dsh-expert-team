// 测试：G 线 **档位选择门（soft / hard）**
//
// 背景（拍板 #5 的两种可能实现）：用户要求"档位**每次新建 team 时选择**"。我实现成
// **soft**（默认）：按项目规模与目标给出建议、建议先生效、浮层同时给三选一 —— 理由是
// E1 硬规则要求 run 开始 10 分钟内就有可运行骨架，卡在"等用户选"会让用户不在场时更慢。
// **hard**：不选不开工（建 run 但不派工，选完即投递），复用 `--confirm` 的同一套机制。
//
// 这个开关最容易犯的错有两个，本测试逐条钉住：
//   ① hard 门**说"等待"却没真的不派工**（话说得漂亮，活照跑）⇒ 断言 followup 次数为 0；
//   ② hard 门**选完之后不投递**（点了没反应 —— 这正是 `--confirm` 踩过的坑）⇒ 断言选完 followup=1；
//   ③ soft 门**误带 heldForTier** ⇒ 用户改档会**二次开工**（同一个任务派两遍）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M115**。
// 运行：node tier-gate.test.mjs

import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# G 线 · 档位门（soft / hard）\n');

const { apply, _live } = await import(join(here, 'lib', 'command.js'));
const { resolveTierGate, TIER_GATE_ENV } = _live;

console.log('① resolveTierGate：config > env > 默认（soft），非法值一律回默认');
{
  const saved = process.env[TIER_GATE_ENV];
  try {
    delete process.env[TIER_GATE_ENV];
    check(resolveTierGate({}) === 'soft', '什么都不给 ⇒ soft（默认，"建议先生效"）');
    check(resolveTierGate({ tierGate: 'hard' }) === 'hard', 'config 指定 hard');
    check(resolveTierGate({ tierGate: 'HARD' }) === 'hard', '大小写不敏感');
    check(resolveTierGate({ tierGate: '涡轮档' }) === 'soft', '**非法值回默认而不是报错**（拼错就把流程卡死比放行更糟）');
    process.env[TIER_GATE_ENV] = 'hard';
    check(resolveTierGate({}) === 'hard', 'env 兜底生效');
    check(resolveTierGate({ tierGate: 'soft' }) === 'soft', 'config 优先于 env');
    process.env[TIER_GATE_ENV] = '乱写';
    check(resolveTierGate({}) === 'soft', 'env 非法值同样回默认');
  } finally {
    if (saved === undefined) delete process.env[TIER_GATE_ENV]; else process.env[TIER_GATE_ENV] = saved;
    resolveTierGate({}); // 复位成 soft，避免污染后面的用例
  }
}

// ── 端到端：一次 hard apply + 一次 soft apply（模块级开关在 apply 时解析）──────────
const root = await mkdtemp(join(tmpdir(), 'dsh-et-tiergate-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const mkSession = (cwd, sid) => ({ session: { id: sid, header: { cwd } }, followup: () => {} });

async function harness({ cwd, sid, config }) {
  const followups = [];
  let registered = null;
  let decideHandler = null;
  const agent = { session: { id: sid, header: { cwd } }, followup: (m) => followups.push(m) };
  // ⚠️ 宿主契约是 **`apply(ctx, config)`**（两个参数）：配置放第二个参数，混进 ctx 里
  // `resolveTierGate` 读不到 —— 这正是第一次跑这个测试时的假绿来源（hard 门静默不生效）。
  apply({
    commands: { register: (d) => { registered = d; } },
    on: () => {},
    get: (k) => (k === 'agents' ? { get: (id) => (id === sid ? agent : null) } : undefined),
    inject: (deps, f) => {
      if (String(deps) !== 'webServer') return;
      f({ effect: (fn) => { fn(); }, webServer: { register: (c) => { if (String(c.path).endsWith('/decide')) decideHandler = c.handler; return () => {}; } } });
    },
  }, config);
  const cmd = (rawInput) => registered.handler({ rawInput: String(rawInput).replace(/^\/team\s+/, ''), attachments: [], agent: mkSession(cwd, sid) });
  const dirs = async () => {
    try { return (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  };
  const newRun = async (input) => {
    const before = new Set(await dirs());
    const res = await cmd(input);
    return { res, run: (await dirs()).find((x) => !before.has(x)) || null };
  };
  const decide = async (body) => {
    const out = { code: 0, text: '' };
    await decideHandler({ method: 'POST', url: '/plugins/dsh-expert-team/decide', body: JSON.stringify(body) }, { writeHead: (c) => { out.code = c; }, end: (b) => { out.text = String(b || ''); } });
    return { code: out.code, json: (() => { try { return JSON.parse(out.text); } catch { return null; } })() };
  };
  const readJson = async (run, f) => JSON.parse(await readFile(join(cwd, 'team', run, f), 'utf8'));
  return { cmd, newRun, decide, readJson, followups, sid };
}

console.log('\n② hard 门：**不选不开工**，选完**真的开工**');
{
  const cwd = join(root, 'hard');
  await mkdir(cwd, { recursive: true });
  const h = await harness({ cwd, sid: 'sess-hard', config: { tierGate: 'hard' } });
  const { res, run } = await h.newRun('做一个小挂件');
  check(!!run, '建出了 run（hard 门也要先建 run，不然用户没有可选的载体）', String(run));
  check(String(res.text).includes('等待你选档位'), '回执明说"等待你选档位"');
  check(String(res.text).includes('未自动派工'), '回执明说"未自动派工"（不说清楚用户会以为卡了）');
  check(h.followups.length === 0, '**真的没派工**（followup 0 次）—— 不是嘴上说等待、活照跑', String(h.followups.length));
  const st = await h.readJson(run, 'STATE.json');
  check(st.heldForTier === true, 'STATE 记下 `heldForTier`（/decide 靠它决定要不要投递）');
  check(st.pendingDecision && st.pendingDecision.kind === 'tier-select', '待决是 tier-select');
  check((await h.readJson(run, 'ROSTER.json')).tier, '档位已经写进工件（即使还没开工）');

  const d = await h.decide({ sessionId: 'sess-hard', workspace: cwd, run, choice: '快速档' });
  check(d.code === 200 && d.json.tier === 'quick', '选「快速档」⇒ 200 且写入 quick', JSON.stringify(d.json));
  check(h.followups.length === 1, '**选完立刻投递派工消息**（点了必须有反应）', String(h.followups.length));
  const st2 = await h.readJson(run, 'STATE.json');
  check(!st2.heldForTier, '`heldForTier` 被消费（不会因为再改一次档而二次开工）');
  check(!st2.pendingDecision, '待决被清空');
  const log = await readFile(join(cwd, 'team', run, 'RUN.log.md'), 'utf8');
  check(log.includes('tier:dispatched'), 'RUN.log 留痕 `tier:dispatched`');
}

console.log('\n③ soft 门（默认）：建议先生效，**不拦派工**、也不留 heldForTier');
{
  const cwd = join(root, 'soft');
  await mkdir(cwd, { recursive: true });
  const s = await harness({ cwd, sid: 'sess-soft', config: {} });
  const { res, run } = await s.newRun('再做一个单页小工具');
  check(!!run, '建出 run', String(run));
  check(String(res.text).includes('三选一'), '回执给出三选一（每次新建都要选）');
  const st = await s.readJson(run, 'STATE.json');
  check(!st.heldForTier, '**不留 `heldForTier`**（否则用户改档会二次开工）');
  check(st.pendingDecision && st.pendingDecision.kind === 'tier-select', '仍然立起选择点（拍板 #5：每次新建都要选一次）');
  const d = await s.decide({ sessionId: 'sess-soft', workspace: cwd, run, choice: '严格档' });
  check(d.code === 200 && d.json.tier === 'strict', 'soft 门下改档照常生效', JSON.stringify(d.json));
  check(!d.json.dispatched, 'soft 门**不投递**（活早就开始了，再投一次就是重复派工）', JSON.stringify(d.json));
}

console.log('\n④ 硬门与 `--confirm` 同时出现：confirm 优先（状态槽只有一个）');
{
  const cwd = join(root, 'both');
  await mkdir(cwd, { recursive: true });
  const b = await harness({ cwd, sid: 'sess-both', config: { tierGate: 'hard' } });
  const { res, run } = await b.newRun('--confirm 大需求');
  check(!!run && String(res.text).includes('等待确认'), '--confirm 的"等待确认"生效', String(res.text).slice(0, 40));
  const st = await b.readJson(run, 'STATE.json');
  check(st.pendingDecision && st.pendingDecision.kind === 'confirm-before-execute', '待决归 confirm（两个门不会互相覆盖成半吊子）');
  check(!st.heldForTier, '不在 hard 档位门上挂 heldForTier（否则两个门抢同一个状态槽）');
}

if (fail) { console.error(`\n✗ tier-gate：${fail} 项失败`); process.exit(1); }
console.log('\n✓ tier-gate：全部通过（解析优先级 / hard 不选不开工 / 选完必开工 / soft 不拦 / 与 --confirm 不打架）');
