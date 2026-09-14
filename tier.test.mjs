// 测试：G 线 **档位**（`lib/tier.js` + `/team --tier` + 浮层选择写回 + `/team status`）
//
// 为什么需要（拿一个真实 run 做的定量体检，见 `docs/专家团-开发计划.md`）：**一个小项目也跑满了
// 八阶段十二角色**（58 任务 / 74 次派工 / 9h54m）。问题不是"环节太多"，是**没有选择** ——
// 无论项目大小都是同一套流程。档位就是把"选择"做出来。
//
// 三条设计红线（本测试逐条钉住）：
//   ① 档位只裁"角色与独立环节"，**不裁验收面**：`quick` 仍必须有 `clarify` 与 `deliver`。
//   ② **建议 ≠ 选择**（用户拍板 #5）：每次新建 team 都要出现一次选择点；`suggestTier` 只出建议。
//   ③ 认不出的档位取值**拒绝**，不静默退回默认（沉默 ≠ 允许）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M110**。
// 运行：node tier.test.mjs

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, TIER_SPEC, TIER_LABELS_ZH, normalizeTier, suggestTier, tierSummaryLine, tierDetailLines, tierChoices, narrowedRoles } from './lib/tier.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# G 线 · 流程档位\n');

// ── ① 词表与裁剪表的不变量 ──────────────────────────────────────────────────
console.log('① 词表与裁剪表的不变量（红线写进代码，不靠文档自觉）');
check(TIERS.length === 3 && TIERS.join(',') === 'quick,standard,strict', '三档且顺序固定（浮层候选项依赖它）', TIERS.join(','));
check(TIERS.every((t) => TIER_SPEC[t] && TIER_LABELS_ZH[t]), '每档都有裁剪表与中文标签');
check(new Set(TIERS.map((t) => TIER_LABELS_ZH[t])).size === 3, '中文标签互不重复', TIERS.map((t) => TIER_LABELS_ZH[t]).join('/'));
check(TIERS.every((t) => TIER_SPEC[t].phases.includes('clarify') && TIER_SPEC[t].phases.includes('deliver')), '**红线①**：任何档位都有 clarify 与 deliver（档位不裁验收面）', TIERS.map((t) => TIER_SPEC[t].phases.join('>')).join(' | '));
check(TIER_SPEC.quick.independentReview === false && TIER_SPEC.standard.independentReview === true && TIER_SPEC.strict.independentReview === true, '独立审查：快速档没有，标准/严格有');
check(TIER_SPEC.quick.roleCap < TIER_SPEC.standard.roleCap && TIER_SPEC.standard.roleCap <= TIER_SPEC.strict.roleCap, '角色上限逐档不降', `${TIER_SPEC.quick.roleCap}/${TIER_SPEC.standard.roleCap}/${TIER_SPEC.strict.roleCap}`);
check(TIER_SPEC.quick.acceptanceCap < TIER_SPEC.standard.acceptanceCap && TIER_SPEC.strict.acceptanceCap === null, '验收项上限：快速 < 标准 < 严格（严格不设上限）');
check(TIERS.every((t) => TIER_SPEC[t].defaultRoles.length <= TIER_SPEC[t].roleCap), '每档的默认班底不超过该档角色上限', TIERS.map((t) => `${t}:${TIER_SPEC[t].defaultRoles.length}/${TIER_SPEC[t].roleCap}`).join(' '));
check(tierChoices().length === 3 && tierChoices()[0].tier === 'quick', '浮层候选项 = 三档（快速在前）');

console.log('\n② 档位归一（认不出来就返回 null，**不静默退回默认**）');
check(normalizeTier('quick') === 'quick' && normalizeTier('STRICT') === 'strict', '英文 id（大小写不敏感）');
check(normalizeTier('快速档') === 'quick' && normalizeTier('标准档') === 'standard' && normalizeTier('严格档') === 'strict', '中文标签');
check(normalizeTier('快速') === 'quick' && normalizeTier('标准') === 'standard', '去掉「档」字也认');
check(normalizeTier('快速档位') === null && normalizeTier('乱写') === null && normalizeTier('') === null && normalizeTier(null) === null, '认不出/空值一律 null（**不是**默认档）');
check(tierSummaryLine('quick').includes('快速档') && tierSummaryLine('quick').includes('≤3'), '一行摘要含标签与角色上限', tierSummaryLine('quick'));
check(tierDetailLines('strict').some((l) => l.includes('派工上限：不设')), '严格档如实写"派工上限不设"');

console.log('\n③ 建议规则（安全优先于规模：高风险**永不**进快速档）');
check(suggestTier({ goal: '做一个单页计算器', fileCount: 20, totalBytes: 60_000 }).tier === 'quick', '小项目 + 无风险 ⇒ 快速档');
check(suggestTier({ goal: '接入支付回调', fileCount: 20, totalBytes: 60_000 }).tier === 'standard', '命中 1 个高风险词 ⇒ 至少标准档（哪怕项目很小）', suggestTier({ goal: '接入支付回调', fileCount: 20, totalBytes: 60_000 }).reasons[0]);
check(suggestTier({ goal: '权限系统与数据库迁移', fileCount: 900, totalBytes: 9_000_000 }).tier === 'strict', '高风险 ≥2 ⇒ 严格档');
check(suggestTier({ goal: '支付对账', fileCount: 900, totalBytes: 9_000_000 }).tier === 'strict', '高风险 × 大体量 ⇒ 严格档');
check(suggestTier({ goal: '随便做点啥' }).tier === 'standard', '**规模未知不按小项目处理** ⇒ 标准档（误判成小项目会让安全活跑快档）', suggestTier({ goal: '随便做点啥' }).reasons[0]);
check(suggestTier({ goal: '重构订单模块', fileCount: 900, totalBytes: 9_000_000 }).tier === 'strict', '「重构」也是高风险词 ⇒ 严格档');
{
  const s = suggestTier({ goal: '独立小工具', fileCount: 12, totalBytes: 30_000 });
  check(s.reasons.length > 0 && s.signals.fileCount === 12, '建议必须**可解释**（带依据与信号，用户才知道要不要改）', s.reasons[0]);
  const capped = suggestTier({ goal: '独立小工具', fileCount: 5000, totalBytes: null, capped: true });
  check(capped.tier === 'standard' && capped.signals.heavy === true, '枚举被截断（capped）⇒ 算大体量，不当小项目', `tier=${capped.tier}`);
}

// ── ④ SKILL.md 的裁剪表不得与代码分叉（"一个事实多份拷贝"的老坑）───────────────
console.log('\n④ SKILL.md 的档位表与代码**不得分叉**');
{
  const skill = await readFile(join(here, 'skills', 'expert-team', 'SKILL.md'), 'utf8');
  for (const t of TIERS) {
    check(skill.includes(TIER_LABELS_ZH[t]), `SKILL.md 提到「${TIER_LABELS_ZH[t]}」`);
  }
  // 逐行钉住三个上限数字：档位表与 `TIER_SPEC` 一旦分叉，用户看到的与执行的就不是一回事。
  check(new RegExp(`快速档[^\\n]*≤\\s*${TIER_SPEC.quick.roleCap}`).test(skill), `SKILL.md 的快速档一行写了角色上限 ${TIER_SPEC.quick.roleCap}`);
  check(new RegExp(`标准档[^\\n]*≤\\s*${TIER_SPEC.standard.roleCap}`).test(skill), `SKILL.md 的标准档一行写了角色上限 ${TIER_SPEC.standard.roleCap}`);
  check(new RegExp(`严格档[^\\n]*≤\\s*${TIER_SPEC.strict.roleCap}`).test(skill), `SKILL.md 的严格档一行写了角色上限 ${TIER_SPEC.strict.roleCap}`);
  check(new RegExp(`快速档[^\\n]*≤${TIER_SPEC.quick.acceptanceCap}`).test(skill), `SKILL.md 的快速档写了验收项上限 ${TIER_SPEC.quick.acceptanceCap}`);
  check(new RegExp(`标准档[^\\n]*≤${TIER_SPEC.standard.acceptanceCap}`).test(skill), `SKILL.md 的标准档写了验收项上限 ${TIER_SPEC.standard.acceptanceCap}`);
  check(skill.includes('每次新建') || skill.includes('每次新建 team'), 'SKILL.md 写明"每次新建 team 都要选一次"（拍板 #5）');
  check(skill.includes('不裁验收面') || skill.includes('不裁验收'), 'SKILL.md 写明档位**不裁验收面**（红线①）');
}

// ── ⑤ 端到端：`/team --tier` / 建议 + 选择点 / 浮层写回 / status ──────────────
console.log('\n⑤ 端到端（真实命令 + 真实 decide 路由）');
const root = await mkdtemp(join(tmpdir(), 'dsh-et-tier-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cwd = join(root, 'proj');
await mkdir(cwd, { recursive: true });

const { apply, _live } = await import(join(here, 'lib', 'command.js'));
// "未定制的基线班底"必须与代码**同一份**（写死在测试里就又是一次「一个事实多份拷贝」）。
const DEFAULT_ROLES_FOR_TEST = _live.DEFAULT_ROLES;
let registered = null;
let decideHandler = null;
apply({
  commands: { register: (d) => { registered = d; } },
  on: () => {},
  get: () => undefined,
  inject: (deps, f) => {
    if (String(deps) !== 'webServer') return;
    f({
      effect: (fn) => { fn(); },
      webServer: { register: (c) => { if (String(c.path).endsWith('/decide')) decideHandler = c.handler; return () => {}; } },
    });
  },
});
const cmd = (rawInput) => registered.handler({
  rawInput: String(rawInput).replace(/^\/team\s+/, ''),
  attachments: [],
  agent: { session: { id: 'sess-tier', header: { cwd } }, followup: () => {} },
});
const dirsIn = async () => {
  try {
    return (await readdir(join(cwd, 'team'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; } // 第一个 run 建好之前还没有 team/ 目录 —— 快照阶段必须容错
};
const newRun = async (input) => {
  const before = new Set(await dirsIn());
  const res = await cmd(input);
  const run = (await dirsIn()).find((x) => !before.has(x)) || null;
  return { res, run };
};
const readJson = async (run, f) => JSON.parse(await readFile(join(cwd, 'team', run, f), 'utf8'));
const readText = (run, f) => readFile(join(cwd, 'team', run, f), 'utf8');

// ⑤-1 显式 --tier
const a = await newRun('--tier 快速档 做一个单页小工具');
check(!!a.run, '显式 --tier 建出了 run', String(a.run));
check((await readJson(a.run, 'STATE.json')).tier === 'quick', 'STATE.json 记下 quick');
check((await readJson(a.run, 'ROSTER.json')).tier === 'quick', 'ROSTER.json 记下 quick');
check((await readText(a.run, 'TASK.md')).includes('快速档（quick）'), 'TASK.md 写明档位');
check((await readText(a.run, 'RUN.log.md')).includes('档位=快速档（quick）'), 'RUN.log 的 run:started 带档位');
check(!(await readJson(a.run, 'STATE.json')).pendingDecision, '显式指定 ⇒ **不再**问一次（用户已经选过）');
check(String(a.res.text).includes('快速档'), '回执里告诉用户当前档位');

// ⑤-2 非法档位 → 拒绝，且**不建 run**
const before5 = await dirsIn();
const bad = await cmd('--tier 涡轮档 做点什么');
check(bad.kind === 'error' && String(bad.text).includes('无法识别'), '非法档位 ⇒ 直接拒绝（不静默退回默认）', bad.kind);
check(String(bad.text).includes('快速档') && String(bad.text).includes('严格档'), '拒绝文案列出全部合法值');
check((await dirsIn()).length === before5.length, '被拒绝时**没有**建出半个 run');

// ⑤-3 不给 --tier ⇒ 建议 + 每次都出现选择点
const b = await newRun('做一个小挂件');
const stB = await readJson(b.run, 'STATE.json');
// 这个临时工作区里几乎只有 `team/` 的工件、没有代码文件 ⇒ 探测结果是"体量极小"，建议 quick。
// （"规模**未知**"走标准档那条规则另在 ③ 里单测 —— 两条规则不要混成一条。）
check(TIERS.includes(stB.tier), '没给 --tier ⇒ 取建议档位（本夹具项目无代码文件 ⇒ 快速档）', stB.tier);
check(stB.tier === 'quick', '空项目/无代码文件 ⇒ 建议快速档（这不是"规模未知"，是"确实很小"）', stB.tier);
check(stB.pendingDecision && stB.pendingDecision.kind === 'tier-select', '立起 `tier-select` 待决（拍板 #5：每次新建都要选一次）', stB.pendingDecision && stB.pendingDecision.kind);
check((stB.pendingDecision.options || []).length === 3, '浮层候选项 = 三档', JSON.stringify(stB.pendingDecision.options));
check(String(stB.pendingDecision.prompt).includes('建议依据'), '待决里带上**建议依据**（不能只丢一个档位名）');

// ⑤-4 decide 路由写回
const callDecide = async (body) => {
  const out = { code: 0, text: '' };
  const res = { writeHead: (c) => { out.code = c; }, end: (b) => { out.text = String(b || ''); } };
  await decideHandler({ method: 'POST', url: '/plugins/dsh-expert-team/decide', body: JSON.stringify(body) }, res);
  return { code: out.code, json: (() => { try { return JSON.parse(out.text); } catch { return null; } })() };
};
const r1 = await callDecide({ sessionId: 'sess-tier', workspace: cwd, run: b.run, choice: '严格档' });
check(r1.code === 200 && r1.json && r1.json.tier === 'strict', '浮层选「严格档」⇒ 200 且回执带 tier', JSON.stringify(r1.json));
check((await readJson(b.run, 'STATE.json')).tier === 'strict', 'STATE.json 的 tier 被写回 strict');
check((await readJson(b.run, 'ROSTER.json')).tier === 'strict', 'ROSTER.json 的 tier 同步');
check(!(await readJson(b.run, 'STATE.json')).pendingDecision, '选择被消费（待决清空）');
check((await readText(b.run, 'RUN.log.md')).includes('tier:selected'), 'RUN.log 留痕 `tier:selected`');

// ⑤-5 非法取值必须 400 **且保留待决**（不能悄悄吞掉用户的选择）
const c = await newRun('再做一个小挂件');
const beforeBad = await readJson(c.run, 'STATE.json');
check(!!(beforeBad.pendingDecision), '新 run 又立了一次待决（每次都问，不记上次）');
const r2 = await callDecide({ sessionId: 'sess-tier', workspace: cwd, run: c.run, choice: '涡轮档' });
check(r2.code === 400, '认不出的档位 ⇒ 400', String(r2.code));
check(!!(await readJson(c.run, 'STATE.json')).pendingDecision, '400 时**保留待决**（用户下次还能选）');

// ⑤-6 /team status 必须看得到档位
const status = await cmd('status');
check(String(status.text).includes('🎚'), '/team status 里能看到档位标记');
check(String(status.text).includes('快速档'), 'status 里列出各 run 的档位', (String(status.text).match(/🎚[^\s·]*/g) || []).join(' / '));

// ── ⑥ 档位**真正省派工**的地方：按档定班底（只动"未定制的基线班底"）────────────────
console.log('\n⑥ 按档定班底（narrowedRoles：用户点过名的角色一个都不删）');
check(narrowedRoles('quick', DEFAULT_ROLES_FOR_TEST, DEFAULT_ROLES_FOR_TEST).join(',') === TIER_SPEC.quick.defaultRoles.join(','), '未定制的基线班底 ⇒ 按档收窄到快速档班底');
check(narrowedRoles('quick', ['pm', 'backend', 'frontend'], DEFAULT_ROLES_FOR_TEST) === null, '用户定制过（≠ 基线）⇒ **返回 null**，一个都不删');
check(narrowedRoles('quick', TIER_SPEC.quick.defaultRoles, DEFAULT_ROLES_FOR_TEST) === null, '已经是该档班底 ⇒ 无需改写（避免无谓写盘与留痕）');
check(narrowedRoles('乱写', DEFAULT_ROLES_FOR_TEST, DEFAULT_ROLES_FOR_TEST) === null, '档位认不出 ⇒ 不动班底');
{
  const a2 = await newRun('--tier 快速档 再来一个单页小工具');
  const rA = await readJson(a2.run, 'ROSTER.json');
  check(rA.roles.join(',') === TIER_SPEC.quick.defaultRoles.join(','), '显式 `--tier 快速档` ⇒ ROSTER.roles 收窄到快速档班底', rA.roles.join(','));
  check(Object.keys(rA.agents || {}).length === TIER_SPEC.quick.defaultRoles.length, '随班底同步生成 agents（不留下已删角色的成员条目）', String(Object.keys(rA.agents || {}).length));
  check(String(a2.res.text).includes('已按档**定班底**'), '回执如实说明"按档定了班底"（不然用户会以为人少了是丢了）');
  const a3 = await newRun('--tier 快速档 --roles pm,backend,frontend,qa,dba 保留我的编制');
  const rA3 = await readJson(a3.run, 'ROSTER.json');
  check(rA3.roles.join(',') === 'pm,backend,frontend,qa,dba', '显式 `--tier` + `--roles` ⇒ **尊重用户的编制**，不收窄', rA3.roles.join(','));
}

console.log('\n⑦ 浮层选档也会按档定班底（派工开始前的那一刻）');
{
  const d = await newRun('浮层选档的小挂件');
  const rD0 = await readJson(d.run, 'ROSTER.json');
  check(rD0.roles.length > TIER_SPEC.quick.defaultRoles.length, '前置：建 run 时班底是基线班底（没收窄）', String(rD0.roles.length));
  const rd = await callDecide({ sessionId: 'sess-tier', workspace: cwd, run: d.run, choice: '快速档' });
  check(rd.code === 200 && rd.json.rolesNarrowed === true, '选「快速档」⇒ 回执标记已收窄', JSON.stringify(rd.json));
  const rD1 = await readJson(d.run, 'ROSTER.json');
  check(rD1.roles.join(',') === TIER_SPEC.quick.defaultRoles.join(','), 'ROSTER.roles 被收窄到快速档班底', rD1.roles.join(','));
  check((await readText(d.run, 'RUN.log.md')).includes('已按档定班底'), 'RUN.log 留痕"已按档定班底"');
  // 定制过的班底不得被动
  const e = await newRun('--roles pm,backend,frontend,qa,reviewer,dba 定制班底的小挂件');
  const rd2 = await callDecide({ sessionId: 'sess-tier', workspace: cwd, run: e.run, choice: '快速档' });
  check(rd2.code === 200 && !rd2.json.rolesNarrowed, '定制过班底 ⇒ 选档**不收窄**', JSON.stringify(rd2.json));
  check((await readJson(e.run, 'ROSTER.json')).roles.join(',') === 'pm,backend,frontend,qa,reviewer,dba', '定制班底原样保留');
}

console.log('\n⑧ `/team tier <档位>`：只许升档（代码强制 SKILL §1.1 的红线）');
{
  const f = await newRun('--tier 快速档 升档测试');
  const up = await cmd(`tier 标准档 --run ${f.run}`);
  check(up.kind === 'success' && String(up.text).includes('已升档'), '快速档 → 标准档：允许', up.kind);
  check((await readJson(f.run, 'STATE.json')).tier === 'standard', 'STATE.json 已更新');
  check((await readJson(f.run, 'ROSTER.json')).tier === 'standard', 'ROSTER.json 已更新');
  check((await readText(f.run, 'RUN.log.md')).includes('tier:changed'), 'RUN.log 留痕 `tier:changed`');
  const rolesAfterUp = (await readJson(f.run, 'ROSTER.json')).roles.join(',');
  check(rolesAfterUp === TIER_SPEC.quick.defaultRoles.join(','), '升档**不改编制**（成员可能已领活）', rolesAfterUp);
  const down = await cmd(`tier 快速档 --run ${f.run}`);
  check(down.kind === 'error' && String(down.text).includes('不允许降档'), '标准档 → 快速档：**拒绝**', down.kind);
  check((await readJson(f.run, 'STATE.json')).tier === 'standard', '被拒绝时档位不变（不是"先改了再报错"）');
  const same = await cmd(`tier 标准档 --run ${f.run}`);
  check(same.kind === 'success' && String(same.text).includes('无需改动'), '同档重设 ⇒ 幂等（不写无谓的留痕）');
  const bad = await cmd(`tier 涡轮档 --run ${f.run}`);
  check(bad.kind === 'error' && String(bad.text).includes('无法识别'), '认不出的档位 ⇒ 拒绝并列出合法值');
  // 不带 `--run`：落到**本会话自己的 run**（与 `/team models` / `/team check` 同一套会话归属），
  // 而不是"工作区里最新的那个" —— 多会话并行时后者会误伤别人的 run。
  const noRun = await cmd('tier 严格档');
  check(noRun.kind === 'success' && String(noRun.text).includes(f.run), '不带 --run ⇒ 落在本会话自己的 run（不猜工作区最新）', `${noRun.kind} / ${(String(noRun.text).match(/run：\S+/) || [''])[0]}`);
  check((await readJson(f.run, 'STATE.json')).tier === 'strict', '确实升到了严格档');
}

if (fail) { console.error(`\n✗ tier：${fail} 项失败`); process.exit(1); }
console.log('\n✓ tier：全部通过（词表不变量 / 归一 / 建议规则 / SKILL 不分叉 / 端到端写回）');
