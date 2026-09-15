// 测试：G 线 **档位徽标**（client 浮层 + `/state` 下发）
//
// 为什么需要：档位在 host 侧写进了三份工件、`/team status` 也显示了，但**浮层一直看不到**
// （v1 明确边界）。这一条把它接上，同时钉住两个最容易出的错：
//   ① **两侧标签表分叉**：client 是 `__ModuleLoader__` 工厂、不能 import host 的
//      `lib/tier.js`，于是又是一份"搬不动的副本" —— 与 `ROLE_LABELS_ZH` 同一处境，
//      必须有测试逐字比对（本仓真实的角色词表就是这么分叉过的）。
//   ② **认不出的档位被当真值画出来**：`涡轮档` / `undefined` / `1` 直接渲染比"不显示"更糟。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M116**。
// 运行：node tier-badge.test.mjs

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_LABELS_ZH, TIERS } from './lib/tier.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# G 线 · 档位徽标\n');

// ── 把 client.js 当 __ModuleLoader__ 模块加载（与 regression.test.mjs 同一套桩）──
const clientSrc = await readFile(join(here, 'client.js'), 'utf8');
let clientModule = null;
const reactStub = { useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), createElement: () => null, Fragment: null };
new Function('window', 'console', 'require', clientSrc)({ __ModuleLoader__: { load: (m) => { clientModule = m; } } }, { log: () => {} }, (id) => (id === 'react' ? reactStub : {}));
const client = clientModule.factory((id) => (id === 'react' ? reactStub : {}));
const { tierBadge, TIER_LABELS_ZH: clientLabels } = client._live;

console.log('① tierBadge：认得的档位给徽标，认不出的一律空串');
check(tierBadge('quick') === '🎚快速档', 'quick → 🎚快速档', tierBadge('quick'));
check(tierBadge('standard') === '🎚标准档' && tierBadge('strict') === '🎚严格档', 'standard / strict 各自正确');
check(tierBadge('QUICK') === '🎚快速档', '大小写不敏感（与 host 侧 normalizeTier 同语义）');
check(tierBadge('  strict  ') === '🎚严格档', '首尾空白被容忍');
check(tierBadge('涡轮档') === '' && tierBadge('') === '' && tierBadge(null) === '' && tierBadge(undefined) === '' && tierBadge(1) === '', '**认不出的档位一律空串**（不把脏数据当事实画出来）', JSON.stringify([tierBadge('涡轮档'), tierBadge(null), tierBadge(1)]));

console.log('\n② 两侧档位标签必须**逐字一致**（client 那份搬不动 ⇒ 靠测试守）');
{
  const hostKeys = Object.keys(TIER_LABELS_ZH).sort();
  const clientKeys = Object.keys(clientLabels).sort();
  check(JSON.stringify(hostKeys) === JSON.stringify(clientKeys), '键集合一致', `host=${hostKeys.join(',')} client=${clientKeys.join(',')}`);
  const diff = hostKeys.filter((k) => clientLabels[k] !== TIER_LABELS_ZH[k]);
  check(diff.length === 0, '同一档位两侧中文标签逐字相同', diff.length ? `不一致：${diff.map((k) => `${k}: ${TIER_LABELS_ZH[k]} vs ${clientLabels[k]}`).join('；')}` : `${hostKeys.length} 个`);
  check(TIERS.every((t) => t in clientLabels), 'host 的每一档 client 都认识（`tierBadge` 不会对合法档位返回空）');
}

console.log('\n③ 徽标真的接进了浮层头部（"写出来了没人调用"是本仓已登记的病）');
{
  check(/tierBadge\(data\.tier\)/.test(clientSrc), '浮层头部渲染读的是 `data.tier`');
  check(/esc\(tierBadge\(data\.tier\)\)/.test(clientSrc), '徽标经过 `esc()`（与其它文案同一套转义纪律）');
  check(/exports\._live = \{ esc: esc, tierBadge: tierBadge/.test(clientSrc), '`tierBadge` 挂进 `_live`（可被测试直接断言）');
}

console.log('\n④ `/state` 必须把档位下发到浮层');
{
  const root = await mkdtemp(join(tmpdir(), 'dsh-et-badge-'));
  process.env.DSH_HOME = join(root, 'fake-dsh');
  const cwd = join(root, 'proj');
  await mkdir(cwd, { recursive: true });
  const { apply, _live } = await import(join(here, 'lib', 'command.js'));
  let registered = null;
  apply({ commands: { register: (d) => { registered = d; } }, on: () => {}, get: () => undefined, inject: () => {} });
  const cmd = (rawInput) => registered.handler({ rawInput: String(rawInput).replace(/^\/team\s+/, ''), attachments: [], agent: { session: { id: 'sess-badge', header: { cwd } }, followup: () => {} } });
  await cmd('--tier 快速档 做一个单页小工具');
  const { readdir } = await import('node:fs/promises');
  const run = (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)[0];
  const snap = await _live.snapshotRun(cwd, run);
  check(snap && snap.tier === 'quick', '`snapshotRun` 暴露 `tier`（`/state` 就是它的消费者）', JSON.stringify(snap && snap.tier));

  // 旧 run（没有 tier 字段）必须**如实 null**，不能编一个默认档
  const legacy = join(cwd, 'team', 'legacy-1');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'STATE.json'), JSON.stringify({ runId: 'legacy-1', phase: 'deliver', status: 'complete', mode: 'one-shot', deliverable: 'code+artifacts', members: [] }, null, 2));
  await writeFile(join(legacy, 'ROSTER.json'), JSON.stringify({ runId: 'legacy-1', roles: ['pm'], members: {} }, null, 2));
  const snap2 = await _live.snapshotRun(cwd, 'legacy-1');
  check(snap2 && snap2.tier === null, '旧 run（无 tier 字段）⇒ `null`，不是编造的默认档', JSON.stringify(snap2 && snap2.tier));

  const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
  // 1.3.10：响应从对象字面量改成 Object.assign（为了附 rolesDeferred / profile），
  // 但**要求不变**：整个 `sel` 必须摊平下发，tier 才不需要另写一行。
  check(/json\(200, Object\.assign\(\s*\{[^}]*\.\.\.|json\(200, Object\.assign\(/.test(cmdSrc) && /,\s*sel,\s*\n/.test(cmdSrc),
    '`/state` 把 `sel` 摊平下发（tier 随之外泄到浮层，无需另写一行）');
}

if (fail) { console.error(`\n✗ tier-badge：${fail} 项失败`); process.exit(1); }
console.log('\n✓ tier-badge：全部通过（徽标口径 / 两侧标签不分叉 / 真的接进浮层 / /state 下发）');
