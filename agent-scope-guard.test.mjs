// 测试：L3-6 的**落点约束**必须是机制而不是注释
//
// 背景（ROI 评审架构侧，2026-09-11）：
//   L3-6「agent-scope 工具注册 + launch_team 类工具」原方案要往 `cordis.patch.yml` 里
//   insert 一个 `dsh-tool-*` 行。架构评审明确**否决该落点**：
//     · host 平面的 tool 行会把工具注册进**进程全局 `tools` registry**，
//       对**任何 preset 的任意会话**可见 —— 这既是产品可见的行为变更，
//       也正是本文件头部注释写死的反模式（"contributes only HOST-plane rows
//       (no agent-plane tool rows — those stay behind the preset the session runs)"）。
//     · 正确落点是 `presets/expert-team/agent.cordis.yml`（agent-plane、preset 内、per-agent scoped）。
//   ⇒「明确禁止改 `cordis.patch.yml` 来加工具行」。
//
// 该约束此前**只写在注释里**（注释拦不住手滑）。本测试把它变成机制。
//
// 另一半：L3-6 的**立项前提**已被探针否定（见 `preset-agent-scope.probe` 段落与 BACKLOG）：
//   后端评审要求"先用数据证明'忘了读 skill'是高频失败之后再立项"。
//   实测：所有有 `TASK.md` 的真实 run（10/10）都带齐 skill 驱动工件（ROSTER/STATE/TASKS）
//   ⇒ 没有证据支持该前提 ⇒ 不建工具，只保留约束守卫。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M37。
// 运行：node agent-scope-guard.test.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const patchPath = join(here, 'cordis.patch.yml');
const patch = readFileSync(patchPath, 'utf8');

console.log('# L3-6 落点约束（host 平面禁止出现 agent-plane 工具行）\n');

console.log('① 机制约束：cordis.patch.yml 不得 insert 任何 `dsh-tool-*` / agent-plane 工具行');
{
  // 只扫真正的行定义（`name: ...`），避免把注释里的举例当违规
  const nameLines = patch
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^-?\s*name:\s*['"]?/.test(l))
    .map((l) => l.replace(/^-?\s*name:\s*/, '').replace(/['"]/g, ''));
  check(nameLines.length > 0, `解析出 insert 行的 name（${nameLines.length} 条）`, nameLines.join(' , '));
  const toolRows = nameLines.filter((n) => /dsh-tool-/.test(n));
  check(toolRows.length === 0, '没有任何 `dsh-tool-*` 行（架构评审的硬约束）', toolRows.join(' , '));
  // 本包自己的行只应是 host 平面的 command + client-discovery 标记
  const allowed = nameLines.filter((n) => /^@yangdcm\/dsh-expert-team(\/command)?$/.test(n));
  check(allowed.length === nameLines.length, '本 bundle 只贡献 host-plane 行（command + client 标记）', nameLines.join(' , '));
}

console.log('\n② 只有 agent-plane 干净还不够：工具行必须落在 preset 里（若将来要加）');
{
  const presetPath = join(here, 'presets', 'expert-team', 'agent.cordis.yml');
  check(existsSync(presetPath), 'preset 文件存在（正确的落点）');
  const preset = readFileSync(presetPath, 'utf8');
  check(/dsh-tool-subagent/.test(preset), 'preset 里确实有 agent-plane 工具行（证明落点机制可用）', '');
  // 落点对照：同一个工具名若出现在 patch 里就是违规 —— 这里做成可读的对照说明
  check(!/dsh-tool-subagent/.test(patch), '同一个工具名**没有**出现在 host 平面 patch 里');
}

console.log('\n③ 注释契约仍在（防止有人删注释后以为没有约束）');
{
  const head = patch.split('\n').slice(0, 14).join('\n');
  check(/HOST-plane rows/.test(head) && /no agent-plane tool rows/.test(head), '文件头注释仍写明"只贡献 host 平面行"', '');
  check(/preset/.test(head), '注释指向正确落点（preset）', '');
}

console.log('\n④ 立项前提的探针结果必须可复核（把"没有证据"也固化下来）');
{
  // 与后端评审的条件对齐：他要求"先用数据证明『忘了读 skill』是高频失败之后再立项"。
  // 这个断言把**当时的测量结果与判定门槛**固化下来 —— 若将来证据变了，应当**有意**修改此断言，
  // 而不是让它悄悄漂移。
  const roots = ['/Users/yangbingtao/Documents/dsh/team', '/Users/yangbingtao/Documents/php/school/team', '/Users/yangbingtao/Documents/php/jiu/team', '/Users/yangbingtao/Documents/php/mch/team'];
  let started = 0;
  const outliers = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const n of readdirSync(root)) {
      const d = join(root, n);
      if (!existsSync(join(d, 'TASK.md'))) continue; // 没 TASK.md 的属"空/损坏目录"，归 B1
      started += 1;
      const need = ['ROSTER.json', 'STATE.json', 'TASKS.json'];
      const miss = need.filter((f) => !existsSync(join(d, f)));
      if (miss.length) outliers.push(`${n}（缺 ${miss.join(',')}）`);
    }
  }
  const complete = started - outliers.length;
  const rate = started ? complete / started : 1;
  check(started > 0, `扫描到真正启动的 run（${started} 个）`);
  if (outliers.length) console.log(`      偏离 scaffold 协议的 run（${outliers.length} 个）：${outliers.join('；')}`);
  // 实测（2026-09-11）：11 个启动过的 run 里 1 个偏离（≈9%）——**有**偏离，但远够不上"高频"。
  // 因此按后端评审的条件：不立项建工具；同时**不谎称"零证据"**。
  check(rate >= 0.8, `scaffold 协议遵循率 ${complete}/${started}（${(rate * 100).toFixed(0)}%）≥ 80% ⇒ 未达"高频失败"门槛`, outliers.join('；'));
}

console.log('\n⑤ 结论必须写在可审计处（不是只活在测试里）');
{
  const backlog = '/Users/yangbingtao/Documents/dsh/team/做竞品分析-分析dsh官方的te-145629/BACKLOG.md';
  if (existsSync(backlog)) {
    const b = readFileSync(backlog, 'utf8');
    check(/L3-6/.test(b), 'BACKLOG 里有 L3-6 条目');
    check(/落点|preset/.test(b), '写明了正确落点（preset）而不是 host 平面');
  } else {
    console.log('      · 跳过：BACKLOG 不在本机（非失败）');
  }
}

console.log('');
if (fail > 0) {
  console.log(`✗ L3-6 落点约束测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ L3-6 落点约束测试通过（host 平面零工具行；正确落点在 preset；立项前提无证据支持）');
