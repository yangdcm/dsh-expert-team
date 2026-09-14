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
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M92**（把 fail-closed 改回 `base = total`）。
// 运行：node write-bypass-ratchet.test.mjs

import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
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

if (fail) { console.error(`\n✗ write-bypass-ratchet：${fail} 项失败`); process.exit(1); }
console.log('\n✓ write-bypass-ratchet：全部通过');
