// 测试：把「LLM 自建 run」纳入门禁（B2 · N-8）
//
// 缺陷：`scaffoldRun` 建的 run 有固定字段集（`runId/phase/status/mode/deliverable` + `ROSTER.json`），
// 但**实测真实工作区里多数 run 是 lead 直接 `write` 出来的**，而本 run 的三处字段漂移
// **全部出在这条路径**上。不把这条路径纳入门禁，schema 校验只能覆盖"正规建出来的 run"。
//
// 修法：`scaffoldFingerprint(state, roster)` 用脚手架指纹判定，接进 `/team check` 与面板红条。
// **误报是这里最大的风险**（会把所有历史 run 都标红，用户随即对红条整体降权），
// 所以本测试的核心是「真实 run 零误报」而不是「能查出自建的」。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M33。
// 运行：node scaffold-fingerprint.test.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { scaffoldFingerprint, SCAFFOLD_REQUIRED } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const SCAFFOLD = { runId: 'r1', phase: 'design', status: 'running', mode: 'one-shot', deliverable: 'code+artifacts' };
const ROSTER_OK = { roles: ['pm'], members: {} };
const okOpts = { hasRoster: true };

console.log('# 脚手架指纹（LLM 自建 run 纳入门禁）\n');

console.log('① 正规脚手架产物 → 不算自建');
{
  const v = scaffoldFingerprint(SCAFFOLD, ROSTER_OK, okOpts);
  check(v.selfBuilt === false, '字段齐全 → selfBuilt=false', JSON.stringify(v.missing));
  check(v.missing.length === 0, 'missing 为空', JSON.stringify(v.missing));
}

console.log('② 缺任一脚手架字段 → 判为自建，且如实点名缺什么');
{
  for (const k of SCAFFOLD_REQUIRED) {
    const st = { ...SCAFFOLD };
    delete st[k];
    const v = scaffoldFingerprint(st, ROSTER_OK, okOpts);
    check(v.selfBuilt === true, `缺 ${k} → selfBuilt=true`, JSON.stringify(v.missing));
    check(v.missing.includes(k), `missing 点名 ${k}`, JSON.stringify(v.missing));
  }
  // 空串/null 也算缺（脚手架不会写空值）
  const v2 = scaffoldFingerprint({ ...SCAFFOLD, phase: '' }, ROSTER_OK, okOpts);
  check(v2.selfBuilt === true && v2.missing.includes('phase'), 'phase 为空串 → 也算缺', JSON.stringify(v2.missing));
  const v3 = scaffoldFingerprint({ ...SCAFFOLD, mode: null }, ROSTER_OK, okOpts);
  check(v3.selfBuilt === true && v3.missing.includes('mode'), 'mode 为 null → 也算缺', JSON.stringify(v3.missing));
}

console.log('\n③ 缺 ROSTER.json / STATE 不可解析');
{
  const v = scaffoldFingerprint(SCAFFOLD, null, { hasRoster: false });
  check(v.selfBuilt === true && v.missing.some((m) => /ROSTER/.test(m)), '缺 ROSTER → 自建', JSON.stringify(v.missing));
  const v2 = scaffoldFingerprint(null, null, {});
  check(v2.selfBuilt === true, 'STATE 缺失 → 自建');
  check(v2.missing.some((m) => /STATE/.test(m)), '点名 STATE.json', JSON.stringify(v2.missing));
  const v3 = scaffoldFingerprint([], ROSTER_OK, okOpts);
  check(v3.selfBuilt === true, 'STATE 是数组（形状不对）→ 自建');
}

console.log('\n④ 【关键】真实 run 必须**零误报**（否则红条变噪音、用户整体降权）');
{
  // 扫描本机真实存在的 run 目录；找不到就跳过（不把"环境没有"当失败）
  const roots = [
    '/Users/yangbingtao/Documents/dsh/team',
    '/Users/yangbingtao/Documents/php/jiu/team',
    '/Users/yangbingtao/Documents/php/school/team',
    '/Users/yangbingtao/Documents/php/mch/team',
  ];
  let seen = 0, falsePos = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let names = [];
    try { names = readdirSync(root) } catch { continue }
    for (const n of names) {
      const d = join(root, n);
      const sp = join(d, 'STATE.json');
      if (!existsSync(sp)) continue; // 无 STATE 的由 B1 归为 broken，不属本测试
      let st = null, ro = null;
      try { st = JSON.parse(readFileSync(sp, 'utf8')) } catch { continue }
      try { ro = JSON.parse(readFileSync(join(d, 'ROSTER.json'), 'utf8')) } catch { ro = null }
      seen += 1;
      const v = scaffoldFingerprint(st, ro, { hasRoster: !!(ro && Array.isArray(ro.roles) && ro.members) });
      if (v.selfBuilt) { falsePos += 1; console.log(`      ✗ 误报：${n.slice(0, 40)} → 缺 ${v.missing.join('、')}`) }
    }
  }
  check(seen > 0, `扫描到真实 run（${seen} 个）`);
  check(falsePos === 0, `真实 run 零误报（${falsePos}/${seen}）`);
}

console.log('\n⑤ 接线检查：/team check 与面板都接了这个指纹');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  const checkAt = src.indexOf('const fp = scaffoldFingerprint(state, rosterForPrint');
  check(checkAt > 0, '/team check 里调用');
  const block = checkAt > 0 ? src.slice(checkAt, checkAt + 700) : '';
  check(/violations\.push\(/.test(block), '结果进 violations（计入 ❌ 列表）');
  check(/建议用 \/team <task> 建 run，或补齐上述字段/.test(block), '给出可执行建议（否则用户不知道怎么修）');
  check(/scaffoldFingerprint\(rawState, rawRoster/.test(src), '面板红条也调用');
  check(/SCAFFOLD_REQUIRED = \['runId', 'phase', 'status', 'mode', 'deliverable'\]/.test(src), '指纹字段集明确可审计');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 脚手架指纹测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 脚手架指纹测试通过（自建 run 可查出；真实 run 零误报）');
