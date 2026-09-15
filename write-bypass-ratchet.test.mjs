// 测试：`gate:bypass`（写入绕过棘轮）必须 **fail-closed**
//
// 报障与根因（2026-09-12 独立审计确认，本轮修）：
//   旧代码 `const base = baseline && typeof baseline.total === 'number' ? baseline.total : total;`
//   —— 基线文件**缺失/损坏**时 `base = total` ⇒ `delta = 0` ⇒ **exit 0**。
//   后果：**删掉 `regression.fixtures/write-bypass-baseline.json` 就能悄悄关掉整道棘轮** ——
//   而这恰恰是本门禁唯一要防的动作（"允许存量、禁止新增"）。
//   对照：`check-evidence.mjs` 的弱证据棘轮是**按 0 fail-closed** 的（它自己注释里也写了
//   "不给'删掉基线就关棘轮'的口子"）。两处口径必须一致。
//
// 本测试在**临时目录**里造一个最小包（`scripts/` + `lib/` + `client.js`），用
// `DSH_WRITE_BYPASS_BASELINE` 覆写基线路径（沿用 `DSH_EVIDENCE_FRAGMENT_BASELINE` 的惯例），
// 从而在**不动仓库里真实基线文件**的前提下验证三种情形。
//
// ── 第二轮修（2026-09-15）：这道门禁"一直是红的却没人知道" ─────────────────────
//   上面那些情形全都在**临时目录**里验脚本逻辑，而**真实仓库**从未被比过一次：
//   `.github/workflows/ci.yml` 故意不跑 `npm run gate`（那里有它自己的原因），于是
//   `regression.fixtures/write-bypass-baseline.json` 的 `total: 0` 与真实值（当时 4 处直写：
//   `lib/command.js` 的 runs-index 2 处 + 新写模块 2 处）已经不一致了很久，**没有任何一处会红**。
//   所以本轮加两节（都在真实仓库上断言，因此 CI 的 `npm run test:all` 就会强制它）：
//     ⑥ 真实仓库必须 `total <= 基线`（`baselinePresent` 必须为真；失败时带 perFile 分布）；
//     ⑦ **同源锁**：`EXEMPT` 成员集合必须恰好等于预期清单 ⇒ 豁免不可能静默扩张。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M92**（把 fail-closed 改回 `base = total`）。
// 运行：node write-bypass-ratchet.test.mjs

import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 在 dir 里跑门禁脚本，返回 `{code, out}`（不抛）。 */
async function runGate(dir, baselinePath, extraArgs = []) {
  try {
    const { stdout, stderr } = await run('node', [join(dir, 'scripts', 'check-write-bypass.mjs'), ...extraArgs], {
      cwd: dir,
      env: { ...process.env, DSH_WRITE_BYPASS_BASELINE: baselinePath },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

/**
 * 在**真实仓库**里跑门禁脚本（`cwd = here`，且**清掉** `DSH_WRITE_BYPASS_BASELINE` 覆写，
 * 确保用的是 `regression.fixtures/write-bypass-baseline.json`）。返回 `{code, out}`（不抛）。
 */
async function runRealRepoGate(extraArgs = []) {
  const env = { ...process.env };
  delete env.DSH_WRITE_BYPASS_BASELINE;
  try {
    const { stdout, stderr } = await run('node', [join(here, 'scripts', 'check-write-bypass.mjs'), ...extraArgs], {
      cwd: here, env, maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const tmp = await mkdtemp(join(tmpdir(), 'bypass-ratchet-'));
const baselinePath = join(tmp, 'baseline.json');

try {
  // ── 造最小包：lib/ 里放 2 处直写（1 处在受控入口里、应被豁免；1 处是"绕过"）──
  await mkdir(join(tmp, 'scripts'), { recursive: true });
  await mkdir(join(tmp, 'lib'), { recursive: true });
  await copyFile(join(here, 'scripts', 'check-write-bypass.mjs'), join(tmp, 'scripts', 'check-write-bypass.mjs'));
  await writeFile(join(tmp, 'client.js'), '// empty\n');
  await writeFile(join(tmp, 'lib', 'artifact-writer.js'), 'export const x = 1;\n'); // 受控入口：豁免
  await writeFile(
    join(tmp, 'lib', 'rogue.js'),
    "import { writeFile } from 'node:fs/promises';\nexport const go = (p, s) => writeFile(p, s);\n",
  );

  // ── 1. 基线缺失 ⇒ fail-closed（total=1 > 0）──
  {
    const r = await runGate(tmp, join(tmp, 'does-not-exist.json'));
    check(r.code === 1, '基线缺失 ⇒ exit 1（fail-closed，不再静默放行）', `code=${r.code}`);
    check(/fail-closed/.test(r.out), '输出里明确写了 fail-closed 与原因');
    check(/--update/.test(r.out), '输出里给出恢复办法（--update）');
  }

  // ── 2. 基线损坏（不是合法 JSON）⇒ 同样 fail-closed ──
  {
    const broken = join(tmp, 'broken.json');
    await writeFile(broken, '{ not json');
    const r = await runGate(tmp, broken);
    check(r.code === 1, '基线损坏 ⇒ exit 1', `code=${r.code}`);
  }

  // ── 3. total 恰好等于基线 ⇒ 通过 ──
  {
    await writeFile(baselinePath, JSON.stringify({ total: 1, perFile: { 'lib/rogue.js': 1 } }));
    const r = await runGate(tmp, baselinePath);
    check(r.code === 0, 'total == 基线 ⇒ exit 0（棘轮保持）', `code=${r.code}`);
    check(/棘轮保持/.test(r.out), '输出报告"棘轮保持"');
  }

  // ── 4. total 高于基线 ⇒ 失败（这才是门禁的正常工作路径）──
  {
    const lower = join(tmp, 'lower.json');
    await writeFile(lower, JSON.stringify({ total: 0 }));
    const r = await runGate(tmp, lower);
    check(r.code === 1, 'total > 基线 ⇒ exit 1（新增绕过）', `code=${r.code}`);
    check(/新增了 1 处直写绕过/.test(r.out), '输出指出新增了几处');
  }

  // ── 5. --json 暴露 baselinePresent，便于机器判定"基线在不在" ──
  {
    const r = await runGate(tmp, join(tmp, 'does-not-exist.json'), ['--json']);
    let parsed = null;
    try { parsed = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* 见下断言 */ }
    check(parsed !== null, '--json 输出可解析');
    check(parsed && parsed.baselinePresent === false, '--json 里 baselinePresent=false');
    check(parsed && parsed.baseline === 0, '--json 里 baseline=0（按 fail-closed 口径）');
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

// ── 6. **真实仓库**必须满足 total <= 基线（这一节就是把门禁接进 CI 的那根线）────────
// 为什么必须有：上面 1–5 全在临时目录里验脚本逻辑，`.github/workflows/ci.yml` 又**故意不跑**
// `npm run gate`。两者叠加的后果已经发生过一次：真实值 4、基线 0，**没有任何一处会红**。
// 这里跑的是仓库自己的基线文件（不带覆写），所以 `npm run test:all` 一跑就是真话。
console.log('\n⑥ 真实仓库：直写总数必须 <= 基线（基线缺失/损坏同样算失败）');
{
  const r = await runRealRepoGate(['--json']);
  let parsed = null;
  try { parsed = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* 见下断言 */ }
  check(r.code === 0, '真实仓库 gate:bypass exit 0（未超过基线）', `code=${r.code}`);
  check(parsed !== null, '真实仓库 --json 输出可解析');
  if (parsed) {
    const dist = Object.entries(parsed.perFile || {}).map(([f, n]) => `${f}:${n}`).join(' / ') || '（无直写）';
    const tally = `total=${parsed.total} 基线=${parsed.baseline} delta=${parsed.delta}｜分布：${dist}`;
    check(parsed.baselinePresent === true,
      '真实仓库基线文件存在且可解析（baselinePresent=true —— 否则 fail-closed 会把一切都判红）',
      `baselineFile=${parsed.baselineFile}`);
    check(parsed.delta <= 0, '真实仓库 delta <= 0（新增直写必须走受控入口，或先迁移再下调基线）', tally);
    check(Number.isInteger(parsed.total), '真实仓库 total 是整数', tally);
  }
}

// ── 7. 同源锁：`EXEMPT` 只能是我们知道的这几个 ───────────────────────────────
// 门禁的豁免面就是"哪些文件可以直写"。它一旦能被子系统悄悄扩大，整道棘轮就变成摆设
// （把新写的直写文件往 EXEMPT 里一塞，门禁永远绿）。所以预期清单在这里**再写一遍**：
// 谁要改豁免面，就必须同时改这条断言 —— 让它成为一次**有人签字**的改动。
console.log('\n⑦ 同源锁：EXEMPT 成员集合恰好等于预期清单（豁免不许静默扩张）');
{
  const src = await readFile(join(here, 'scripts', 'check-write-bypass.mjs'), 'utf8');
  // 先剥注释再解析：那段注释里就写着为什么只允许这两个（避免正文被当成清单成员）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const m = /const EXEMPT = new Set\(\[([\s\S]*?)\]\)/.exec(code);
  check(m !== null, '能从脚本源码里解析出 EXEMPT（反空转：解析不到就必须红，不许静默通过）');
  const actual = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : [];
  const expected = ['lib/artifact-writer.js', 'lib/host-state-file.js'];
  check(actual.join(' | ') === expected.join(' | '),
    'EXEMPT == 预期清单（两个受控入口：工作区工件 / 宿主状态文件）',
    `实际：${actual.join(' | ') || '（空）'}`);
  // 受控入口必须真的存在（写一个不存在的文件名 = 豁免了一个没人用的名字，门禁却照样绿）。
  for (const rel of expected) {
    let exists = true;
    try { await readFile(join(here, rel), 'utf8'); } catch { exists = false; }
    check(exists, `受控入口确实存在：${rel}`);
  }
}

if (fail) { console.error(`\n✗ write-bypass-ratchet：${fail} 项失败`); process.exit(1); }
console.log('\n✓ write-bypass-ratchet：全部通过');
