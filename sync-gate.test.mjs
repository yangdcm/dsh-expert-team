// 元测试：三副本一致性门禁**必须能失败**（批 1 · N-7 的 M5 基线）
//
// 为什么需要它：`ensureSkillInstalled`/`ensurePresetInstalled` 发现目标存在就 return、**不覆盖** ⇒
// 「改了源码 ≠ 改了运行时」，且毫无报错。若该门禁不退出非零，这类"假完成"会静默发生
// （本 run 已实测到 3 处真实漂移：skill 的 PIPELINE.md/WORKSPACE.md、运行副本 package.json）。
//
// 全部操作都在**工作区内的临时 fixture** 上完成（把 DSH_HOME 指过去），不触碰真实 ~/.dsh。
//
// 断言：
//   ① fixture 与源一致 → exit 0
//   ② 注入漂移 → exit 1，且指出是哪个文件
//   ③ --fix → exit 0，且内容真的被修复
//
// 运行：node sync-gate.test.mjs

import { mkdtemp, mkdir, writeFile, readFile, cp, appendFile, rm } from 'node:fs/promises';
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

/** 跑 check-sync 并返回 {code, out}。 */
async function gate(dshHome, extra = []) {
  try {
    const { stdout } = await run('node', [join(here, 'scripts', 'check-sync.mjs'), ...extra], {
      cwd: here,
      env: { ...process.env, DSH_HOME: dshHome },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// ── fixture：把源资产铺到三个目标，模拟"已安装且一致" ──
const root = await mkdtemp(join(tmpdir(), 'dsh-et-sync-'));
const home = join(root, 'dsh');
const skillDst = join(home, 'skills', 'expert-team');
const presetDst = join(home, '.agent-presets', 'expert-team');
const runtimeDst = join(home, 'profiles', 'web', 'node_modules', '@yangdcm', 'dsh-expert-team');
await mkdir(join(home, 'skills'), { recursive: true });
await mkdir(join(home, '.agent-presets'), { recursive: true });
await mkdir(join(home, 'profiles', 'web', 'node_modules', '@yangdcm'), { recursive: true });
await cp(join(here, 'skills', 'expert-team'), skillDst, { recursive: true });
await cp(join(here, 'presets', 'expert-team'), presetDst, { recursive: true });
await mkdir(runtimeDst, { recursive: true });
for (const x of ['lib', 'client.js', 'cordis.patch.yml', 'skills', 'presets', 'package.json', 'README.md']) {
  try { await cp(join(here, x), join(runtimeDst, x), { recursive: true }); } catch { /* 可缺 */ }
}

console.log('# 三副本一致性门禁元测试（门禁必须能失败）\n');

console.log('① 三副本一致 → 应当通过');
const r1 = await gate(home);
check(r1.code === 0, '一致 → exit 0', `exit=${r1.code}`);
check(/三副本一致/.test(r1.out), '明确报告「三副本一致」');

console.log('\n② 注入漂移 → 必须失败并指出文件');
const driftFile = join(skillDst, 'references', 'PIPELINE.md');
await appendFile(driftFile, '\n<!-- DRIFT_PROBE_SHOULD_BE_CAUGHT -->\n');
const pkgDrift = join(runtimeDst, 'package.json');
const origPkg = await readFile(pkgDrift, 'utf8');
await writeFile(pkgDrift, origPkg.replace(/"version":\s*"[^"]+"/, '"version": "9.9.9-mutant"'));
const r2 = await gate(home);
check(r2.code === 1, '有漂移 → exit 1', `exit=${r2.code}`);
check(/references\/PIPELINE\.md|references\\PIPELINE\.md/.test(r2.out), '指出 skill 侧的 PIPELINE.md 漂移');
check(/package\.json/.test(r2.out), '指出运行副本的 package.json 漂移');
check(/改了源码但运行时未同步/.test(r2.out), '给出可理解的结论文案');

console.log('\n③ --fix → 必须修复并转绿');
const r3 = await gate(home, ['--fix']);
check(r3.code === 0, '--fix → exit 0', `exit=${r3.code}`);
check(/三副本一致/.test(r3.out), '修复后报告一致');
const fixed = await readFile(driftFile, 'utf8');
check(!/DRIFT_PROBE_SHOULD_BE_CAUGHT/.test(fixed), '漂移内容已被源覆盖（真的修好了）');
const r4 = await gate(home);
check(r4.code === 0, '复扫仍为绿', `exit=${r4.code}`);

// ── ④⑤⑥ 可选映射的缺席分支（2026-09-14 补）────────────────────────────────
// 为什么必须有这几条：skill 于 1.2.0 起改走"运行时注册、不落地"，我把它的映射标成 optional 并新增了
// `ABSENT_OPTIONAL` 状态 —— **但打印分支只特判了 MISSING_TARGET**，于是那个新状态落到底去读
// `sameCount/onlySrc/...`（该状态下不存在这些字段）⇒ TypeError，**整个报告一行都打不出来**
// （skill 是第一个映射，所以看起来像输出被吞）。
// 而上面 ①②③ 的夹具三份副本齐全，**永远走不到新分支** ⇒ 这就是"新分支没有测试"的典型漏网。
// 下面把三个状态都走一遍：可选缺席 ⇒ 仍绿（且不许崩）；可选存在但不一致 ⇒ 照旧红。
console.log('\n④ 可选映射缺席（skill）→ 正常状态：exit 0、有说明、且**不许**崩');
await rm(skillDst, { recursive: true, force: true });
const r5 = await gate(home);
check(r5.code === 0, 'skill 目录缺失 → exit 0（可选映射不算漂移）', `exit=${r5.code}`);
check(!/TypeError/.test(r5.out), '没有 TypeError（ABSENT_OPTIONAL 有自己的打印分支）');
check(/\[skill\]/.test(r5.out), '打印了 skill 那一行说明', '');
check(/三副本一致/.test(r5.out), '结论仍是"一致"');

console.log('\n⑤ 两个可选映射同时缺席（skill + preset）→ 仍 exit 0、两行说明都在');
await rm(presetDst, { recursive: true, force: true });
const r6 = await gate(home);
check(r6.code === 0, '两个可选目标都缺失 → exit 0', `exit=${r6.code}`);
check(!/TypeError/.test(r6.out), '仍然没有 TypeError');
check(/\[skill\]/.test(r6.out) && /\[preset\]/.test(r6.out), 'skill 与 preset 都有说明行');
check(/\[runtime\]/.test(r6.out), '非可选的 runtime 行也照常打印（没有被 continue 跳过）');

console.log('\n⑥ 反向：可选目标**存在但内容漂移** → 必须 exit 1 并指出文件（证明 optional 没关掉漂移检测）');
await cp(join(here, 'presets', 'expert-team'), presetDst, { recursive: true });
const presetDrift = join(presetDst, 'preset.yml');
await appendFile(presetDrift, '\n# DRIFT_PROBE_IN_OPTIONAL_TARGET\n');
const r7 = await gate(home);
check(r7.code === 1, '可选目标存在且漂移 → exit 1', `exit=${r7.code}`);
check(/preset\.yml/.test(r7.out), '指出具体是哪个文件漂移', '');
const presetLine = r7.out.split('\n').filter((l) => l.includes('[preset]')).join('');
check(/\[preset\]/.test(r7.out) && !/目标不存在/.test(presetLine), 'preset 那行报的是漂移，不是"目标不存在"');

console.log('');
if (fail > 0) {
  console.log(`✗ 同步门禁元测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 同步门禁元测试通过（能抓漂移、能修复、可选缺席不误报且不崩、可选存在仍抓漂移）');
