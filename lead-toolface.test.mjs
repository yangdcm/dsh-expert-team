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
// ── 2026-09-20 追加（⑩⑪⑫）：真实用户投诉 —— lead 没有 shell ⇒ 把 `grep`/`md5`/`stat` 交给
//    **用户**去终端里跑，而本包的用户大多不会跑 shell。修法是**给 lead 一个只读 shell 白名单**。
//    这一段的失败同样**不报错**，而且比前面两种更贵：
//      ③ **shell 被 deny 成死代码**：白名单挂在 `tools/pre-execute` 上，而 lead 的 `bash` 若仍在
//         `deny` 名单里，模型**根本看不见**这个工具 ⇒ 守卫永不触发，"修好了"与"没修"一模一样。
//         ⇒ ⑪ 断言"门禁可用时 `bash` **不进** deny"。
//      ④ **判定写好了但没人调用**：`artifactReadDecision` 就是这样躺了很久（真实事故：lead 把一次
//         **边界拒绝**读成"文件不存在"，连出两个错误结论）。纯函数单测**抓不到这一种** ⇒
//         ⑪ 是**接线断言**（盯住源码里真有调用），先例 `client-css-integrity.test.mjs` 断言的是内容而非形状。
//      ⑤ **误伤角色子代理**：门禁挂在插件级瀑布上，判据写宽一点就会把 qa 的 bash 一起拦掉（团队瘫痪）；
//         ⑫ 逐条验"回调契约不成立就降级"+"非 lead 一律放行"+"内部异常时 shell fail-closed、其它工具放行"。
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


console.log('\n⑨ lead 工具面收窄的开关：config > env > 设置 > 默认(on)，关掉时出声一次');
{
  const { _live } = await import(join(here, 'lib', 'command.js'));
  const ENV = _live.LEAD_TOOLFACE_ENV;
  const saved = process.env[ENV];
  try {
    // 默认：没人表态 ⇒ on（设计意图）
    delete process.env[ENV];
    check(_live.resolveLeadToolFace({}, { leadToolFace: undefined }) === 'on', '默认 on（设计意图：执行类工具不在 lead 手上）', _live.effectiveLeadToolFace());

    // 设置控制台改 off ⇒ 生效（这是用户日常最可能用的那条路：官方面板/浮层）
    check(_live.resolveLeadToolFace({}, { leadToolFace: 'off' }) === 'off', '设置里改 off ⇒ 生效', _live.effectiveLeadToolFace());

    // env 压过设置
    process.env[ENV] = 'on';
    check(_live.resolveLeadToolFace({}, { leadToolFace: 'off' }) === 'on', 'env 压过设置（优先级正确）', _live.effectiveLeadToolFace());

    // config 压过 env（部署方显式配置最高）
    process.env[ENV] = 'off';
    check(_live.resolveLeadToolFace({ leadToolFace: 'on' }, { leadToolFace: 'off' }) === 'on', 'config 压过 env 与设置', _live.effectiveLeadToolFace());

    // 非法值一律回默认，不猜不报错
    process.env[ENV] = '也许吧';
    check(_live.resolveLeadToolFace({}, { leadToolFace: '涡轮' }) === 'on', '非法值（env 与设置都写错）⇒ 回默认 on，不猜', _live.effectiveLeadToolFace());
  } finally {
    if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
    _live.resolveLeadToolFace({}, { leadToolFace: 'on' });   // 复位，别影响后续断言
  }

  // 接线：处理器真的尊重它，且关掉时**出声一次**（否则"我明明关了"与"开关没生效"看起来一样）
  const cmd = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  check(/if \(LEAD_TOOLFACE === 'off'\)/.test(cmd), '处理器真的检查了开关', '');
  check(/LEAD_TOOLFACE_OFF_LOGGED/.test(cmd), '关闭状态只播报一次（不刷屏）', '');
  check(/resolveLeadToolFace\(config, currentSettings\(\)\.gates\)/.test(cmd), 'apply() 里按 config > env > 设置 解析', '');
  check(/resolveLeadToolFace\(PLUGIN_CONFIG, s\.gates\)/.test(cmd), '重算路径也解析（设置页改完即时生效）', '');

  // 设置项本身：进 spec ⇒ 官方面板里也能改（enum 是宿主 schema 表达得了的类型）
  const { flatSpec, defaultSettings } = await import(join(here, 'lib', 'settings.js'));
  const item = flatSpec()['gates.leadToolFace'];
  check(!!item && item.type === 'enum' && item.default === 'on' && item.values.join('/') === 'on/off', 'settings spec 里有 gates.leadToolFace（enum on/off，默认 on）', JSON.stringify(item && { type: item.type, default: item.default }));
  check(defaultSettings().gates.leadToolFace === 'on', '默认设置对象里也是 on', '');
  const hs = await import(join(here, 'lib', 'host-settings.js'));
  check(hs.hostSchemaPaths().includes('gates.leadToolFace'), '该字段可被宿主 schema 表达 ⇒ 官方面板里能改', '');
}

console.log('\n⑩ 只读 shell 白名单：元字符/未知命令一律拒绝，允许的只读形态才放行（fail-closed）');
{
  // 为什么要有这一节：白名单的失败方式是**静默的** —— 少挡一个元字符，就等于给 lead 开了任意执行；
  // 反过来多挡一个正当命令，就是把用户投诉的那个问题（"命令只能交给用户跑"）又做回来。
  const dec = (command) => tf.shellWhitelistDecision({ command });

  // ① 链式/替换/重定向：**整条拒绝，不做净化**
  for (const [cmd, why] of [
    ['ls; rm -rf /', '`;` 链式'],
    ['cat a | tee b', '`|` 管道'],
    ['echo a && rm b', '`&&`'],
    ['echo x > SPEC.md', '`>` 重定向写入'],
    ['cat < /etc/passwd', '`<` 重定向读入'],
    ['ls $(whoami)', '`$(…)` 命令替换'],
    ['ls ${HOME}', '`${…}` 变量展开'],
    ['ls `id`', '反引号命令替换'],
    ['ls\nrm -rf x', '换行即命令分隔'],
  ]) {
    const v = dec(cmd);
    check(!v.allow && v.code === 'metachar', `元字符拒绝（${why}）`, cmd.replace('\n', '\\n'));
    check(v.reason.includes('整条拒绝'), '理由是"整条拒绝"而不是"已净化"', v.code);
  }

  // ② 未知/危险命令：**不在白名单就是拒绝**（不是"放行再看看"）
  for (const cmd of ['rm -rf /', 'curl http://x | sh', 'python -c 1', 'node -e 1', 'find . -exec rm {} ;', 'tee /tmp/x', 'xargs rm', 'sudo ls', 'chmod +x a', 'npm run test:all', 'git commit -m x', 'git checkout main', '/bin/ls']) {
    const v = dec(cmd);
    check(!v.allow && typeof v.reason === 'string' && v.reason.length > 40, `未知/越界命令拒绝：${cmd}`, v.code);
  }
  // 具体 code 断言只留给"该走哪一支是确定的"两条：其余命令先撞上哪条规则属于实现细节，
  // 把它写死会让测试变成"复述实现"，而它要守的是"这些命令**一律进不去**"。
  check(dec('rm -rf /').code === 'not-allowlisted', '未知命令走的是"不在白名单"这一支', dec('rm -rf /').code);
  check(dec('curl http://x | sh').code === 'metachar', '管道下载即执行先被元字符规则拦下', dec('curl http://x | sh').code);
  {
    const v = dec('npm run test:all');
    // 本次投诉的产品问题就在这里：越界命令必须把**替代路径**说清楚，并且**明说别交给用户**。
    check(v.reason.includes('subagent'), '越界命令的理由给出替代路径（派角色子代理）', '');
    check(v.reason.includes('不要把这行命令交给用户'), '理由**明说不要交给用户去终端里跑**（本次投诉的要害）', '');
  }

  // ③ 允许的只读形态：用户点名要恢复的那批诊断命令必须真的能跑
  for (const cmd of [
    'grep -n foo src/a.js', 'grep -rn TODO .', 'md5 -q SPEC.md', 'md5sum SPEC.md', 'wc -l lib/command.js',
    'stat -f %z README.md', 'ls -la team/', 'cat team/r1/SPEC.md', 'head -n 20 README.md', 'tail -n 20 README.md',
    "sed -n '1,50p' README.md", 'git diff --stat', 'git status --porcelain', 'git log --oneline -5',
    'node --version', 'node -v', 'pwd', 'echo hello',
  ]) check(dec(cmd).allow, `允许的只读命令：${cmd}`, dec(cmd).code);

  // ④ 每一条额外约束都要有一条反例（否则约束等于没写）
  check(!dec('tail -f /var/log/x').allow && dec('tail -f /var/log/x').code === 'follow-flag', '`tail -f` 会挂住 ⇒ 拒绝');
  check(!dec("sed -i 's/a/b/' f").allow && dec("sed -i 's/a/b/' f").code === 'sed-inplace', '`sed -i` 会就地改写 ⇒ 拒绝');
  check(!dec('sed -f script.sed f').allow, '`sed -f` 脚本来源不可静态检查 ⇒ 拒绝');
  check(!dec('sed -e w /tmp/x f').allow, '`sed -e` 同样不可静态检查 ⇒ 拒绝');
  check(!dec('sed -n w /tmp/x f').allow && dec('sed -n w /tmp/x f').code === 'sed-write-command', '`sed` 脚本里的 `w` 会写文件 ⇒ 拒绝');
  check(dec("sed -n 's/world/earth/p' f").code === 'sed-write-command', '`sed` 脚本含 `w`/`W`/`e` 一律拒绝（静态区分命令字母不可靠）');
  check(!dec('git diff --output=/tmp/x').allow && dec('git diff --output=/tmp/x').code === 'git-unsafe-arg', '`git --output` 会写文件 ⇒ 拒绝');
  check(!dec('git -c core.pager=cat log').allow, '`git -c` 能注入配置/外部程序 ⇒ 拒绝');
  check(!dec('cat').allow && dec('cat').code === 'missing-operand', '不给文件路径会读 stdin（可能挂住）⇒ 拒绝');
  check(!dec('node').allow, '裸 `node` 读 stdin ⇒ 拒绝');
  check(!dec('').allow && dec('').code === 'empty', '空命令 ⇒ 拒绝');
  check(!dec(undefined).allow && dec(undefined).code === 'unparsable', '拿不到命令原文 ⇒ fail-closed 拒绝');

  // ⑤ 大小写不宽松：`MD5` 不是 `md5`（白名单是逐字的，不做"看起来像"的匹配）
  check(!dec('MD5 -q f').allow, '大小写不同 ⇒ 当作未知命令拒绝（不做模糊匹配）');
}

console.log('\n⑪ 接线（防复发）：production 真的调了 `artifactReadDecision`/白名单，且 shell 没被 deny 成死代码');
{
  const cmd = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  const tfSrc = readFileSync(join(here, 'lib', 'lead-toolface.js'), 'utf8');

  // ── 这一节是**接线断言**，不是纯函数单测 ────────────────────────────────────
  // 真实事故（2026-09-20 定位）：`artifactReadDecision` 判定写好了、单测也有（见 ⑤），
  // 但**没有任何生产代码调用它** ⇒ 边界从未生效，lead 把一次"边界拒绝"读成了"文件不存在"，
  // 连出两个错误结论。纯函数单测**永远抓不到**这种"写好了没接线"，只有盯住源码文本才抓得到
  //（先例：`client-css-integrity.test.mjs` 断言的是内容，不是形状）。
  check(/artifactReadDecision\(\{ filePath, cwd, extraRoots \}\)/.test(tfSrc),
    '门禁里**真的调用**了 `artifactReadDecision`（不是"只写在单测里"）');
  check(/shellWhitelistDecision\(\{ command: raw \}\)/.test(tfSrc),
    '门禁里**真的调用**了 `shellWhitelistDecision`');
  check(/artifactReadDenialReason\(\{ filePath, cwd \}\)/.test(tfSrc),
    '读边界拒绝走的是**可读理由**（不是通用错误）');
  check(/return \{ kind: 'deny', reason: verdict\.reason \}/.test(tfSrc),
    '白名单判定为拒绝时，理由**原样**回给模型（不是吞掉）');

  check(/import \{[^}]*createLeadToolFaceGate[^}]*\} from '\.\/lead-toolface\.js'/.test(cmd),
    'command.js 真的导入了门禁工厂');
  check(/ctx\.on\('tools\/pre-execute', leadGate\)/.test(cmd),
    '门禁真的挂在 `tools/pre-execute`（**跑之前**拦；post-execute 改结果时命令已经跑过了）');
  check(/LEAD_GATE_READY = true/.test(cmd) && /shellGuardAvailable: LEAD_GATE_READY/.test(cmd),
    '门禁挂上后置位，并把这个事实传给 planner（没挂上 ⇒ shell 回 deny）');
  check(/LEAD_AGENTS\.add\(agent\)/.test(cmd),
    '`agent/created` 里登记 lead（少了它，身份判据恒假 ⇒ 白名单**静默失效**）');
  check(/isLead: \(agent\) => LEAD_AGENTS\.has\(agent\)/.test(cmd),
    '身份判据是对象身份（`WeakSet`），不是字符串比对 —— 角色子代理不会被误伤');
  check(/extraRoots: leadReadExtraRoots\(\)/.test(cmd),
    '读边界额外放行专家团自己的技能/模板目录（否则 lead 读不了自己的说明书）');

  // ── shell **不能**留在 deny 名单里：deny 掉的工具模型根本看不见，白名单会变成死代码 ──
  const withGate = tf.planLeadToolFace({ platform: 'darwin', knownNames: HOST_POSIX, shellGuardAvailable: true });
  check(!withGate.deny.includes('bash'), '门禁可用时 `bash` **不进 deny**（进了 deny ⇒ 模型看不见它 ⇒ 白名单是死代码）', JSON.stringify(withGate.deny));
  check(withGate.guardedShell === 'bash' && withGate.effective === true, '而是经 `guardedShell` 交给白名单门禁', JSON.stringify(withGate.guardedShell));
  check(withGate.deny.includes('write') && withGate.deny.includes('edit'), '`write`/`edit` **仍然**被 deny（本次不许放开）', JSON.stringify(withGate.deny));
  check(!withGate.deny.includes('read') && !withGate.deny.includes('read_image'), '`read`/`read_image` 仍在手上（它们走路径边界，见 ⑤/⑫）', '');
  const winGate = tf.planLeadToolFace({ platform: 'win32', knownNames: HOST_WIN32, shellGuardAvailable: true });
  check(winGate.guardedShell === 'pwsh' && !winGate.deny.includes('pwsh'), 'win32 反向：受守卫的是 `pwsh`', JSON.stringify(winGate.deny));

  // ── fail-closed：没有门禁 ⇒ shell 回到 deny，并出声说明 ──
  const noGate = tf.planLeadToolFace({ platform: 'darwin', knownNames: HOST_POSIX, shellGuardAvailable: false });
  check(noGate.deny.includes('bash') && noGate.guardedShell === null,
    '门禁不可用 ⇒ shell 回到 deny（fail-closed：宁可没有 shell，也不能给无约束的 shell）', JSON.stringify(noGate.deny));
  check(noGate.notes.some((n) => n.includes('fail-closed')), '退回 deny 时**出声**说明原因', JSON.stringify(noGate.notes));
  const unstated = tf.planLeadToolFace({ platform: 'darwin', knownNames: HOST_POSIX });
  check(unstated.deny.includes('bash') && unstated.notes.length === 0,
    '调用方没表态（undefined）⇒ 同样按 deny 处理，但**不制造噪声**（历史默认口径）', JSON.stringify(unstated.notes));
  // 只收到 shell（其余候选都不在宿主里）也不能报成"没有收窄"
  const onlyShell = tf.planLeadToolFace({ platform: 'darwin', knownNames: ['bash', 'read'], shellGuardAvailable: true });
  check(onlyShell.effective === true && onlyShell.status === 'ready',
    '只有 shell 被守卫时也算"收窄了"（否则会报出一句不成立的"本次没有收窄任何工具"）', onlyShell.status);
}

console.log('\n⑫ 门禁本体：回调契约 / 只管 lead / fail-closed 降级（三条纪律逐条验）');
{
  const LEAD = { id: 'lead-agent' };
  const ROLE = { id: 'qa-agent' };
  const allow = async () => ({ kind: 'allow' });
  const gate = tf.createLeadToolFaceGate({ isLead: (a) => a === LEAD, cwdFor: () => '/w' });

  // ① 宿主签名是 `(exec, next)`；回调契约不成立 ⇒ **不干涉**（绝不抛错）。
  //    2026-09-12 的真实事故：监听器签名写错 ⇒ 宿主把**每一次**工具调用都归一化成失败（全工具瘫痪）。
  let threw = false;
  let degraded;
  try { degraded = await gate({ name: 'bash', arguments: { command: 'rm -rf /' } }, undefined); } catch { threw = true; }
  check(!threw && degraded && degraded.kind === 'allow', '`next` 不是函数 ⇒ 降级为不干涉且不抛错', JSON.stringify(degraded));

  // ② 只管 lead：角色子代理必须保留**完整** shell（qa 跑测试、backend 跑构建全靠它）
  check((await gate({ name: 'bash', agent: ROLE, arguments: { command: 'npm run test:all' } }, allow)).kind === 'allow',
    '**角色子代理的越界命令一律放行**（本门禁只管 lead，误伤角色 = 团队瘫痪）');
  check((await gate({ name: 'read', agent: ROLE, arguments: { file_path: 'src/a.js' } }, allow)).kind === 'allow',
    '角色子代理读源码也放行（读边界同样只对 lead 生效）');
  check((await gate({ name: 'bash', arguments: { command: 'rm -rf /' } }, allow)).kind === 'allow',
    '没有 agent（非模型调用）⇒ 放行（不是 lead 就不是本门禁的事）');

  // ③ lead：白名单内放行、越界拒绝，且理由可读可行动
  check((await gate({ name: 'bash', agent: LEAD, arguments: { command: 'md5 -q team/r1/SPEC.md' } }, allow)).kind === 'allow',
    'lead 的只读命令放行');
  const deniedShell = await gate({ name: 'bash', agent: LEAD, arguments: { command: 'npm run test:all' } }, allow);
  check(deniedShell.kind === 'deny' && typeof deniedShell.reason === 'string' && deniedShell.reason.length > 60,
    'lead 的越界命令被拒，理由非空且足够长（不是一句"拒绝"）', deniedShell.reason && deniedShell.reason.slice(0, 40));
  check(/不要把这行命令交给用户/.test(deniedShell.reason), '拒绝理由里**明说别把命令交给用户**（本次投诉的要害）');
  check(/subagent/.test(deniedShell.reason), '拒绝理由给出替代路径（subagent 派给角色）');

  // ④ 读路径：工件内放行、边界外拒绝，理由是"边界拒绝，不是文件不存在"
  check((await gate({ name: 'read', agent: LEAD, arguments: { file_path: 'team/r1/SPEC.md' } }, allow)).kind === 'allow',
    'lead 读 run 工件放行');
  const deniedRead = await gate({ name: 'read', agent: LEAD, arguments: { file_path: 'src/index.js' } }, allow);
  check(deniedRead.kind === 'deny', 'lead 读工件外 ⇒ 拒绝', JSON.stringify(deniedRead).slice(0, 80));
  check(/工件边界/.test(deniedRead.reason) && /不是\*\*"文件不存在"/.test(deniedRead.reason),
    '理由**明说这是边界拒绝、不是"文件不存在"**（真实事故的误读就在这里）');
  check(/派给角色子代理/.test(deniedRead.reason) && /请求授权/.test(deniedRead.reason),
    '理由给出两条替代路径（派角色子代理 / 向用户请求授权）');
  check((await gate({ name: 'read', agent: LEAD, arguments: { file_path: 'teamx/a.md' } }, allow)).kind === 'deny',
    '前缀陷阱：`teamx/` 不被当成 `team/` 内部（拒绝）');

  // ⑤ 不越权插手：非 shell/非只读工具一律放行；下游更严格的判定优先
  check((await gate({ name: 'write', agent: LEAD, arguments: { file_path: '/etc/hosts' } }, allow)).kind === 'allow',
    '`write` 不归本门禁管（它由工具面 deny 拦住）—— 绝不误伤无关工具');
  const downstream = await gate({ name: 'bash', agent: LEAD, arguments: { command: 'md5 -q a' } }, async () => ({ kind: 'deny', reason: '下游更严格' }));
  check(downstream.kind === 'deny' && downstream.reason === '下游更严格', '下游（更严格）的判定优先，本门禁不覆盖它');
  const askDown = await gate({ name: 'bash', agent: LEAD, arguments: { command: 'md5 -q a' } }, async () => ({ kind: 'ask' }));
  check(askDown.kind === 'ask', '下游 `ask` 同样不被覆盖（尊重"最严格优先"）');
  // 下游没给出合格 decision（undefined / null / {}）时，本门禁必须**补齐** `{kind:'allow'}` 再往下传：
  // 宿主 `prepareExecution` 拿到瀑布结果后直接读 `gate.kind` ⇒ 原样传 undefined 会让它抛 TypeError、
  // 把整次工具调用判成失败（2026-09-12 那次"全工具瘫痪"就是这个形状）。
  for (const [label, ret] of [['undefined', undefined], ['null', null], ['{}', {}]]) {
    const out = await gate({ name: 'bash', agent: LEAD, arguments: { command: 'md5 -q a' } }, async () => ret);
    check(out && out.kind === 'allow', `下游返回 ${label} ⇒ 本门禁补齐 {kind:'allow'}（绝不把 undefined 传给宿主）`, JSON.stringify(out));
  }

  // ⑥ 内部异常：**shell fail-closed / 其它工具放行**，且绝不抛给宿主
  const boom = (name) => { const e = { name, agent: LEAD }; Object.defineProperty(e, 'arguments', { get() { throw new Error('boom'); } }); return e; };
  const events = [];
  const g2 = tf.createLeadToolFaceGate({ isLead: (a) => a === LEAD, cwdFor: () => '/w', onEvent: (t, p) => events.push([t, p]) });
  const shellBoom = await g2(boom('bash'), allow);
  check(shellBoom.kind === 'deny' && /fail-closed/.test(shellBoom.reason),
    '门禁内部异常 ⇒ shell **fail-closed 拒绝**（绝不放行无约束 shell）且不抛错', shellBoom.reason && shellBoom.reason.slice(0, 30));
  check((await g2(boom('read'), allow)).kind === 'allow', '内部异常对**非 shell** 工具降级为放行（绝不把无关工具变红）');
  // ⑦ 拒绝与降级都必须**留痕**（不静默）：本仓铁律是"失败要出声"，门禁尤其如此 ——
  //    一个不发声的拒绝，在用户眼里和"模型自己不用工具"长得一模一样。
  await g2({ name: 'bash', agent: LEAD, arguments: { command: 'npm run test:all' } }, allow);
  await g2({ name: 'read', agent: LEAD, arguments: { file_path: 'src/a.js' } }, allow);
  const shellDenied = events.find(([t]) => t === 'lead-shell-denied');
  const readDenied = events.find(([t]) => t === 'lead-read-denied');
  const gateError = events.find(([t]) => t === 'lead-toolface-gate-error');
  check(!!shellDenied && shellDenied[1].code === 'not-allowlisted', 'shell 拒绝会留痕（`lead-shell-denied` 带 code）', JSON.stringify(shellDenied && shellDenied[1]));
  check(!!readDenied && readDenied[1].reason === 'outside-artifacts', '读边界拒绝会留痕（带 `reason: outside-artifacts`）', JSON.stringify(readDenied && readDenied[1]));
  check(!!gateError && gateError[1].stage === 'decide', '门禁内部异常会留痕（`lead-toolface-gate-error`，不静默降级）', JSON.stringify(gateError && gateError[1]));
}

console.log('');
if (fail > 0) {
  console.log(`✗ lead 工具面测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ lead 工具面测试通过（平台求交 / 两种零可区分 / 不误收编排 / 只读守卫 fail-open / 不误伤子代理 / 只读 shell 白名单 / 接线没断）');
