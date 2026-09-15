// R1 绕过检测（`bash`/`pwsh` 重定向写 run 工件）的回归护栏（2026-09-15，1.3.16）。
//
// 背景：R1 硬门禁（`lib/artifact-ownership.js`）只覆盖 `write`/`edit`；preset 里 backend/frontend/
// researcher/qa/dba/devops **持 bash**，理论上可 `cat > SPEC.md` 绕过。**静默绕过**违背本仓纪律，
// 但静态判断 bash 写目标不可靠（重定向/变量/子命令）⇒ 折中：**只留痕，不阻断**。
//
// 本文件钉四件事：① 真写向 run 工件的形态**必须命中**；② 常见"不该命中"的形态**不许误报**；
// ③ 观测器**绝不改动工具结果、绝不抛错**；④ 模块里**不允许**出现任何阻断返回（源码级禁令）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const { extractWriteTargets, detectArtifactRedirect, createArtifactRedirectWatcher, SHELL_WRITE_TOOLS } =
  await import(join(here, 'lib', 'artifact-redirect-watch.js'));
const { ARTIFACT_TEMPLATES } = await import(join(here, 'lib', 'command.js'));
const { ARTIFACT_OWNERS } = await import(join(here, 'lib', 'artifact-ownership.js'));

const known = new Set([...ARTIFACT_TEMPLATES, ...Object.keys(ARTIFACT_OWNERS)]);
const ws = '/tmp/et-watch-ws';
const teamRoot = join(ws, 'team');
const runDir = join(teamRoot, 'demo-run');

console.log('\n① 命中：**明显**写向 <run-dir>/<已知工件> 的形态');
{
  const hits = [
    ['cat > SPEC.md', runDir, 'SPEC.md'],
    ['echo x >> TASKS.json', runDir, 'TASKS.json'],
    ['tee PLAN.md', runDir, 'PLAN.md'],
    ['tee -a REVIEW.md', runDir, 'REVIEW.md'],
    ['printf hi > REVIEW.md', runDir, 'REVIEW.md'],
    [`cat > "${runDir}/SUMMARY.md"`, ws, 'SUMMARY.md'],
    ['echo y 2> TASKS.json', runDir, 'TASKS.json'],
  ];
  for (const [cmd, cwd, want] of hits) {
    const r = detectArtifactRedirect(cmd, { cwd, teamRoot, knownArtifacts: known });
    check(r && r.base === want, `命中：${JSON.stringify(cmd)}`, r ? `${r.base} @ ${r.runId}` : 'null（漏报）');
  }
  check(SHELL_WRITE_TOOLS.has('bash') && SHELL_WRITE_TOOLS.has('pwsh'), '覆盖 bash 与 pwsh 两种 shell 工具', [...SHELL_WRITE_TOOLS].join('/'));
}

console.log('\n② 不命中：工作区代码 / 临时文件 / 变量 / 更深路径 / 非工件名');
{
  const misses = [
    ['cat > src/a.ts', ws, '工作区代码文件'],
    ['> /tmp/x', ws, '/tmp 下的临时文件'],
    ['echo hi', ws, '没有写目标'],
    ['cat > SPEC.md', ws, '工作区根下的 SPEC.md（不在 run 目录）'],
    ['cat >> notes.md', runDir, 'run 目录里但不是已知工件'],
    ['cat > $OUT/SPEC.md', runDir, '含变量（宁可漏报）'],
    ['cat > /dev/null', runDir, '/dev/null'],
    ['git status', runDir, '只读命令'],
    ['cat > sub/SPEC.md', runDir, '更深路径（沿用"恰好两段"口径）'],
  ];
  for (const [cmd, cwd, why] of misses) {
    const r = detectArtifactRedirect(cmd, { cwd, teamRoot, knownArtifacts: known });
    check(!r, `不误报：${JSON.stringify(cmd)}（${why}）`, r ? '误报 → ' + r.abs : 'null');
  }
  check(extractWriteTargets('cat > $OUT/SPEC.md').length === 0, '含变量的目标根本不进候选（保守口径写在函数里）', JSON.stringify(extractWriteTargets('cat > $OUT/SPEC.md')));
  check(Array.isArray(known) === false && known.size > 13, '已知工件集合 = 模板 ∪ 归属表（两处真源合并，不另造第三份）', 'size=' + known.size);
}

console.log('\n③ 观测器：**不改结果、不阻断、不抛错**');
{
  const seen = [];
  const w = createArtifactRedirectWatcher({
    knownArtifacts: known,
    cwdFor: () => runDir,
    teamRootFor: () => teamRoot,
    onEvent: (t, p) => seen.push(`${t}:${p.base}`),
    warn: (l) => seen.push('WARN'),
  });
  const original = { kind: 'accept', items: [{ type: 'text', text: 'ORIGINAL' }] };
  const out1 = await w({ name: 'bash', arguments: { command: 'cat > SPEC.md' } }, {}, async () => original);
  check(out1 === original, '命中时**原样返回**下游结果（字节级同一对象）', '');
  const out2 = await w({ name: 'bash', arguments: { command: 'echo hi' } }, {}, async () => original);
  check(out2 === original, '未命中时同样原样返回', '');
  check(seen.some((s) => s.startsWith('WARN')) && seen.some((s) => s.startsWith('artifact-redirect-bypass:SPEC.md')),
    '命中时既打印一行、也发 onEvent（两条留痕都在）', JSON.stringify(seen));
  // write/edit 通道**不归它管**（那是硬门禁的活）
  const out3 = await w({ name: 'write', arguments: { file_path: join(runDir, 'SPEC.md') } }, {}, async () => original);
  check(out3 === original && seen.filter((s) => s.startsWith('WARN')).length === 1, 'write/edit 不经过它（避免与 R1 硬门禁重复报警）', '');
  // next 不是函数 ⇒ 降级为不干涉（2026-09-12 全工具瘫痪事故的教训）
  const out4 = await w({ name: 'bash', arguments: { command: 'cat > SPEC.md' } }, {}, undefined);
  check(out4 && out4.kind === 'accept', 'next 非函数 ⇒ 返回 {kind:"accept"} 而不是抛错（沿用既有纪律）', JSON.stringify(out4));
  // 内部分支抛错也不能冒泡
  const w2 = createArtifactRedirectWatcher({ knownArtifacts: known, cwdFor: () => { throw new Error('boom'); }, teamRootFor: () => teamRoot });
  const out5 = await w2({ name: 'bash', arguments: { command: 'cat > SPEC.md' } }, {}, async () => original).catch((e) => 'THREW:' + e.message);
  check(out5 === original, '探测自身抛错时**吞掉并原样返回**（绝不让工具调用变红）', String(out5 === original));
}

console.log('\n④ 源码级禁令：模块里不许有任何阻断返回');
{
  const src = readFileSync(join(here, 'lib', 'artifact-redirect-watch.js'), 'utf8');
  check(!/kind:\s*'block'/.test(src), '模块内**没有** block 返回（"只报不拦"写进代码，不只是注释）', '');
  check(!/kind:\s*'deny'/.test(src), '模块内**没有** deny 返回', '');
  const cmdSrc = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  check(/ctx\.on\('tools\/post-execute', redirectWatch\)/.test(cmdSrc), '已在 apply() 里注册到 tools/post-execute（挨着其它观测器）', '');
  check(/new Set\(\[\.\.\.ARTIFACT_TEMPLATES, \.\.\.Object\.keys\(ARTIFACT_OWNERS\)\]\)/.test(cmdSrc),
    '已知工件集合来自**两处既有真源**的并集（没有再抄一份清单）', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ R1 绕过检测护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ R1 绕过检测通过（命中/不误报/不改结果/不阻断，且"只报不拦"有源码级禁令）');
