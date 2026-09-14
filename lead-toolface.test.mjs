// 测试：lead 工具面（A 线 · token 成本治理）—— `lib/lead-toolface.js`（纯函数）。
//
// 为什么这个测试必须存在（这条线的诱惑是"工具面收窄了，看起来就省了"）：
//   A 线把 lead 的**默认工具面**收掉执行类工具。它的两处失败都**不会当场报错**：
//     ① **名字写错 / 平台不对**：`tools.restrict()` 对"该部署不存在的工具名"是**抛错**（不是降级）。
//        本 preset 的 shell 工具按平台二选一（`bash` / `pwsh`）—— 名单里同时写两个，
//        在 macOS 上就会因为 `pwsh` 不存在而崩。所以"必须与宿主真实清单求交"要有断言。
//     ② **两种零混为一谈**：`deny: []` 可能是"确实没什么可收"，也可能是"我根本没拿到宿主的工具清单"。
//        后者被当成前者 = 报告说"已收窄"而实际一行没动 —— 正是本包最讨厌的静默失败。
//   另外断言**不误收编排管线**（subagent_* / workflow / ralph / job_* / todo / ask / read）：
//   收掉它们不会省钱，只会让 lead 干不了活（那是把"成本问题"换成"能力故障"）。
//
// 运行：node lead-toolface.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const tf = await import(join(here, 'lib', 'lead-toolface.js'));

// 宿主真实的全局工具名（读宿主各 tool 包得到，**故意写死**：候选名单若与它脱节，这里就会红）。
// 来源：dsh-tool-fs → read/read_image/write/edit；dsh-tool-fs-search → glob/grep；
//       dsh-tool-bash → bash；dsh-tool-pwsh → pwsh（与 bash 平台互斥）；dsh-tool-jobs → job_*。
const HOST_POSIX = ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'job_list', 'job_output', 'job_kill', 'todo_write', 'ask_user_question', 'subagent', 'subagent_pm', 'workflow', 'ralph', 'skill'];
const HOST_WIN32 = HOST_POSIX.filter((n) => n !== 'bash').concat('pwsh');
// 编排管线：**任何情况下都不该出现在 deny 名单里**。
const ORCHESTRATION = ['subagent', 'subagent_pm', 'subagent_backend', 'subagent_qa', 'subagent_acceptance', 'workflow', 'ralph', 'job_list', 'job_output', 'job_kill', 'todo_write', 'ask_user_question', 'read', 'read_image', 'skill'];

console.log('\n① 平台求交：只收本平台的 shell（同时写两个会抛错）');
{
  const posix = tf.planLeadToolFace({ platform: 'darwin', knownNames: HOST_POSIX });
  check(posix.deny.includes('bash'), 'posix 收 `bash`');
  check(!posix.deny.includes('pwsh'), 'posix **不**收 `pwsh`（它在本平台不存在，收了就抛错）', posix.deny.join(','));
  check(posix.expectedShell === 'bash' && posix.expectedShellPresent, '本平台 shell 判定为 bash 且在');
  check(posix.status === 'ready' && posix.effective, '状态 ready 且 effective（真的收到了东西）');
  check(posix.unexpectedAbsent.length === 0, '另一个平台的 shell 缺席**不算异常**', JSON.stringify(posix.unexpectedAbsent));
  check(posix.notes.length === 0, '一切正常时不出声（不制造噪声）', JSON.stringify(posix.notes));

  const win = tf.planLeadToolFace({ platform: 'win32', knownNames: HOST_WIN32 });
  check(win.deny.includes('pwsh') && !win.deny.includes('bash'), 'win32 反向：收 `pwsh` 不收 `bash`', win.deny.join(','));
  check(tf.normalizePlatform('win32') === 'win32' && tf.normalizePlatform('linux') === 'posix' && tf.normalizePlatform(undefined) === 'posix', '平台归一（未知平台按 posix 处理）');
}

console.log('\n② 本该存在的名字缺席 ⇒ 必须出声（不是"已经收掉了"）');
{
  const missingCore = HOST_POSIX.filter((n) => n !== 'edit');
  const r = tf.planLeadToolFace({ platform: 'darwin', knownNames: missingCore });
  check(r.unexpectedAbsent.includes('edit'), '核心工具 `edit` 缺席 ⇒ 进 unexpectedAbsent', JSON.stringify(r.unexpectedAbsent));
  check(!r.deny.includes('edit'), '缺席的名字**不**进 deny（否则求交没做事，会抛错）');
  check(r.notes.some((n) => n.includes('edit')), '缺席会被写进 notes（可见）', JSON.stringify(r.notes));

  const noShell = HOST_POSIX.filter((n) => n !== 'bash');
  const r2 = tf.planLeadToolFace({ platform: 'darwin', knownNames: noShell });
  check(r2.expectedShellPresent === false, '本平台 shell 缺席 ⇒ expectedShellPresent=false');
  check(r2.notes.some((n) => n.includes('bash')), '并出声说明"执行面收窄的前提不成立"', JSON.stringify(r2.notes));
}

console.log('\n③ 两种零必须可区分（本包纪律）');
{
  const none = tf.planLeadToolFace({ platform: 'darwin' });
  const empty = tf.planLeadToolFace({ platform: 'darwin', knownNames: [] });
  const nothing = tf.planLeadToolFace({ platform: 'darwin', knownNames: ['read', 'todo_write'] });
  check(none.status === 'no-known-names', '拿不到清单 ⇒ status=no-known-names（**不是**"没什么可收"）', none.status);
  check(empty.status === 'no-known-names', '空数组同样按"不知道"处理（空清单 ≠ 没有工具）', empty.status);
  check(nothing.status === 'nothing-to-deny', '清单里一个候选都没有 ⇒ status=nothing-to-deny', nothing.status);
  check(none.status !== nothing.status, '**两种零状态不同**（不会被读成同一件事）');
  check(none.effective === false && nothing.effective === false, '两种零都不假装 effective');
  check(none.notes.length > 0 && nothing.notes.length > 0, '两种零都留下说明文字（不沉默）');
  check(none.absent.length === tf.LEAD_DENY_CANDIDATES.length, '第一种零：候选全部计为 absent（如实说"我不知道"）');
}

console.log('\n④ 不误收编排管线（收掉它们不省钱，只会让 lead 干不了活）');
{
  const r = tf.planLeadToolFace({ platform: 'darwin', knownNames: HOST_POSIX });
  const clash = r.deny.filter((n) => ORCHESTRATION.includes(n));
  check(clash.length === 0, 'deny 名单与编排管线**不相交**', JSON.stringify(clash));
  check(!r.deny.includes('read') && !r.deny.includes('read_image'), '`read`/`read_image` 不进 deny（它们走路径守卫，见 ⑤）');
  check(tf.LEAD_GUARDED_READ_TOOLS.includes('read'), '受守卫的只读工具清单里有 `read`');
  const dup = tf.LEAD_DENY_CANDIDATES.filter((n, i) => tf.LEAD_DENY_CANDIDATES.indexOf(n) !== i);
  check(dup.length === 0, '候选名单无重复', JSON.stringify(dup));
  const unknownCand = tf.LEAD_DENY_CANDIDATES.filter((n) => !HOST_POSIX.includes(n) && !HOST_WIN32.includes(n));
  check(unknownCand.length === 0, '候选名字**逐个都真实存在**于宿主工具名里（防止打错字）', JSON.stringify(unknownCand));
}

console.log('\n⑤ 只读守卫：工件目录内放行、外拒绝、判不出就放行（fail-open）');
{
  const cwd = '/w';
  check(tf.artifactReadDecision({ filePath: 'team/SPEC.md', cwd }).allow, '`team/SPEC.md` 放行');
  check(tf.artifactReadDecision({ filePath: '/w/team/r1/PLAN.md', cwd }).allow, '工件子目录里的绝对路径放行');
  check(tf.artifactReadDecision({ filePath: 'team', cwd }).allow, '工件目录本身放行');
  check(!tf.artifactReadDecision({ filePath: 'src/index.js', cwd }).allow, '工件目录外的源码 ⇒ 拒绝', JSON.stringify(tf.artifactReadDecision({ filePath: 'src/index.js', cwd })));
  check(!tf.artifactReadDecision({ filePath: '../outside/secret.txt', cwd }).allow, '`..` 逃逸 ⇒ 拒绝（resolve 之后判定）');
  // 前缀陷阱：/w/teamx 不是 /w/team 的子路径
  check(!tf.artifactReadDecision({ filePath: '/w/teamx/note.md', cwd }).allow, '前缀陷阱：`/w/teamx` 不被当成 `/w/team` 内部');
  check(tf.artifactReadDecision({ filePath: 'team/../team/a.md', cwd }).allow, '规范化后仍在工件内 ⇒ 放行');
  check(tf.artifactReadDecision({ filePath: 'x', cwd: undefined }).allow && tf.artifactReadDecision({}).reason === 'undecidable', '输入不全 ⇒ 放行并标注 undecidable（fail-open，不卡死合法动作）');
  check(tf.artifactReadDecision({ filePath: 'notes.md', cwd, extraRoots: ['/w/notes.md'] }).allow, 'extraRoots 可额外放行');
  check(tf.artifactReadDecision({ filePath: 'team/a.md', cwd }).reason === 'artifact' && tf.artifactReadDecision({ filePath: 'src/a.js', cwd }).reason === 'outside-artifacts', 'reason 区分两种判定（可审计）');
}

console.log('\n⑥ 认得出 lead、且**绝不误伤角色子代理**（安全闸门）');
{
  const r = tf.shouldNarrowLeadToolFace({ presetId: 'expert-team', isRoot: true });
  check(r.apply && r.reason === 'lead', '专家团 + 根 agent ⇒ 施加', JSON.stringify(r));

  // 这一条是安全闸门：子代理与 lead 的 composedPreset **是同一个值**，
  // 只靠 presetId 会把角色的 bash 一起收掉。
  const sub = tf.shouldNarrowLeadToolFace({ presetId: 'expert-team', isRoot: false });
  check(!sub.apply && sub.reason === 'is-subagent', '**子代理绝不施加**（同一 preset 也必须放行）', JSON.stringify(sub));

  for (const other of ['standard', 'minimal', undefined, null, 'EXPERT-TEAM', 'expert-team ']) {
    const v = tf.shouldNarrowLeadToolFace({ presetId: other, isRoot: true });
    check(!v.apply, `非专家团（${JSON.stringify(other)}）⇒ 不施加`, v.reason);
  }
  check(!tf.shouldNarrowLeadToolFace({}).apply, '缺参数 ⇒ 不施加（不猜）');
  check(!tf.shouldNarrowLeadToolFace({ presetId: 'expert-team', isRoot: 'true' }).apply,
    'isRoot 只认真正的 true（字符串 "true" 不算 —— 不把真值判断做松）');
  check(tf.LEAD_PRESET_ID === 'expert-team', 'preset id 是实测值 expert-team', tf.LEAD_PRESET_ID);
}

console.log('\n⑦ 接线是真的接上了（读 command.js 源码钉住，防止"判定写好了但没接"）');
{
  const cmd = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  check(/import \{[^}]*planLeadToolFace[^}]*\} from '\.\/lead-toolface\.js'/.test(cmd),
    'command.js 真的导入了 `planLeadToolFace`（从本模块）');
  check(/import \{[^}]*shouldNarrowLeadToolFace[^}]*\} from '\.\/lead-toolface\.js'/.test(cmd),
    'command.js 真的导入了 `shouldNarrowLeadToolFace`');
  check(/ctx\.on\('agent\/created'/.test(cmd), "真的挂在 `agent/created`（创建时刻）上，不是别的时刻");
  check(/shouldNarrowLeadToolFace\(\{ presetId, isRoot \}\)/.test(cmd), '真的调了识别判定');
  check(/roots\?\.\(\)\.includes\(agent\)/.test(cmd), '**安全闸门在场**：真的查了 roots()（少了它就会收掉角色的 bash）');
  check(/composedPreset\?\.\(agent\.ctx\)/.test(cmd), 'preset 取自 `composedPreset(agent.ctx)`（服务路径，不 import 宿主包）');
  check(/agent\.ctx\.tools\.restrict\(\{ deny: plan\.deny \}\)/.test(cmd),
    '施加在 **agent.ctx**（lead 自己的作用域）上，形状与宿主 :554 一致');
  check(/restrictableNames/.test(readFileSync(join(here, 'lib', 'lead-toolface.js'), 'utf8')), '清单取自 `tools.view(scope).restrictableNames`（取 scope 的逻辑在 lead-toolface.js 里）');
  // ── 真机日志换来的那一条：必须取 **agent 作用域** 的清单 ────────────────────
  // 反例（0.1.5 上真出过）：`ctx.get('tools').view()` 不传 scope = 全局视图，而模型可见工具由
  // preset 注册在 agent 平面 ⇒ 全局视图非空但缺 bash/write/edit，收窄**静默失效**，
  // 日志还给出"宿主里这些工具一个都不存在"这种**不成立**的结论。
  check(/await agentScopedToolNames\(\{ agentCtx: agent\.ctx \}\)/.test(cmd), '清单取自 agent 作用域（`agentScopedToolNames({ agentCtx: agent.ctx })`）');
  check(!/ctx\.get\('tools'\)\?\.view\?\.\(\)\?\.restrictableNames/.test(cmd), '不再用"不传 scope 的全局视图"取清单（那正是静默失效的原因）');
  check(/warnLeadToolFaceOnce\(plan\.status/.test(cmd), '未收窄时走"同一状态只喊一次"的去重出口');
  // 降级口径：两处 try/catch —— 施加失败与装配失败都不能影响会话
  // 注意：不能按第一个 `});` 切 —— `tf.planLeadToolFace({ ... });` 里也含 `});`。
  // 取一段足够长的窗口即可（接线块 ~2.5KB）。
  const wiring = cmd.slice(cmd.indexOf("ctx.on('agent/created'"));
  const block = wiring.slice(0, 3000);
  check(/catch \(e\)/.test(wiring.slice(0, 3200)), '施加被 try/catch 包住（失败退化为"维持原工具面"，不影响会话）');
  check(/未\*\*收窄/.test(block) || /plan\.status/.test(block), '未生效时**出声**（两种零不静默）');
}

console.log('\n⑧ `agentScopedToolNames`：作用域清单怎么取，以及取不到时怎么说话');
{
  const { agentScopedToolNames } = tf;
  const rich = new Set(['bash', 'write', 'edit', 'grep', 'glob', 'read']);
  const agentCtx = { tools: { view: (scope) => (scope === 'S1' ? { restrictableNames: rich } : { restrictableNames: new Set(['run_code']) }) } };

  // ① 成功：scope 传对了 ⇒ 拿到真正的清单
  const ok = await agentScopedToolNames({ agentCtx, loadScope: async () => ({ scopeOf: () => 'S1' }) });
  check(ok.reason === 'ok' && ok.knownNames === rich, 'scope 取对 ⇒ 拿到 agent 平面的清单', ok.reason);
  const planOk = tf.planLeadToolFace({ platform: 'darwin', knownNames: ok.knownNames });
  check(planOk.effective === true && planOk.deny.includes('bash') && planOk.deny.includes('write'), '据此收窄真的生效（bash/write 进 deny）', JSON.stringify(planOk.deny));

  // ② 方向性证明：全局视图为空、作用域视图有 ⇒ 只有走作用域才对
  const globalEmpty = { tools: { view: () => ({ restrictableNames: new Set(['run_code']) }) } };
  const viaGlobal = tf.planLeadToolFace({ platform: 'darwin', knownNames: globalEmpty.tools.view().restrictableNames });
  check(viaGlobal.effective === false, '反例：全局视图（非空但缺那几个名字）⇒ 收窄不生效（这正是真机上发生的事）', viaGlobal.status);

  // ③ 取不到 scope：必须报"不知道"，**不能**说成"宿主里没有这些工具"
  const noModule = await agentScopedToolNames({ agentCtx, loadScope: async () => { throw new Error('解析不到 @deepseek-ai/dsh-scope'); } });
  check(noModule.knownNames === undefined && /scope-module-unavailable/.test(noModule.reason), '模块解析不到 ⇒ knownNames=undefined 并给出原因', noModule.reason);
  const planUnknown = tf.planLeadToolFace({ platform: 'darwin', knownNames: noModule.knownNames });
  check(planUnknown.status === 'no-known-names', '于是如实报 no-known-names（而不是 nothing-to-deny）', planUnknown.status);

  const notScoped = await agentScopedToolNames({ agentCtx, loadScope: async () => ({ scopeOf: () => undefined }) });
  check(notScoped.knownNames === undefined && notScoped.reason === 'not-a-scoped-ctx', '不是作用域 ctx ⇒ not-a-scoped-ctx', notScoped.reason);

  const viewThrows = await agentScopedToolNames({ agentCtx: { tools: { view: () => { throw new Error('boom'); } } }, loadScope: async () => ({ scopeOf: () => 'S1' }) });
  check(viewThrows.knownNames === undefined && /view-failed/.test(viewThrows.reason), 'view 抛错 ⇒ 如实记原因、不抛给调用方', viewThrows.reason);

  const emptyScoped = await agentScopedToolNames({ agentCtx: { tools: { view: () => ({ restrictableNames: new Set() }) } }, loadScope: async () => ({ scopeOf: () => 'S1' }) });
  check(emptyScoped.reason === 'empty-scoped-view', '作用域视图为空 ⇒ 标记 empty-scoped-view（供排查，而不是当成"没什么可收"）', emptyScoped.reason);
}

console.log('');
if (fail > 0) {
  console.log(`✗ lead 工具面测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ lead 工具面测试通过（平台求交 / 两种零可区分 / 不误收编排 / 只读守卫 fail-open / 不误伤子代理）');
