// 测试：自举安装的收口（2026-09-14）
//
// 为什么单独成测：skill/preset 的"安装"以前是**两个静默的坑** ——
//   ① 目标存在就直接 return、**不覆盖** ⇒ 插件升级后运行时永远停在旧副本（改了 skill 却在真实
//      会话里不生效，且没有任何报错）；
//   ② 市场卸载只删 node_modules ⇒ `$DSH_HOME` 下的副本变成孤儿（一个孤儿 skill + 一个选中就报错的 preset）。
// 现在：skill 走**运行时注册**（不写盘），preset 走**版本戳 + 登记清单 + `/team uninstall` 精确回收**。
// 这个测试就是钉住这四件事：注册形状对、升级会重铺、身份不符的东西不动、卸载只删自己的。
//
// 全部操作在**临时 DSH_HOME** 上完成，不触碰真实 ~/.dsh。
// 运行：node bootstrap.test.mjs

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmFixture } from './test-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/**
 * **有界轮询**等一个条件成立。
 *
 * 为什么不能固定 sleep：preset 的铺盘是 `apply()` 里的 fire-and-forget，**没有可以 await 的完成信号**，
 * 所以测试只能"猜一个时长"。旧实现猜 100 ms 并只检查**文件在不在** —— 而"文件在"不等于"整轮铺盘做完了"：
 * 机器 I/O 一忙，`uninstall` 就会与**仍在飞的拷贝**相撞（删掉目录后那次拷贝又把目录建回来），
 * 于是下一轮 `apply()` 把它当成"用户的定制"而**不覆盖** ⇒ 偶发红。
 * 2026-09-16 实测：`test:all` 里连续 2 次红（红的是「再次加载 ⇒ preset 又铺回来了」），单跑却绿。
 * 现在改成等**真正的完成信号**（见下面的 `presetRecorded`），并把实际等待时长报出来。
 */
async function waitFor(fn, { everyMs = 25, maxMs = 8000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return { ok: true, ms: Date.now() - t0 };
    if (Date.now() - t0 >= maxMs) return { ok: false, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// **完成信号**：`recordInstalled(preset, …)` 发生在「整目录拷贝 + 版本戳」**之后** ⇒
// 清单里出现 preset 才等于"这一轮铺盘真的做完了"（只等文件会出现"还没铺完就以为铺完了"）。
const presetRecorded = async () => {
  try { return !!JSON.parse(await readFile(manifestPath, "utf8")).preset; } catch { return false; }
};

// ── 隔离环境：先把 DSH_HOME 指向临时目录，再加载模块 ──
const root = await mkdtemp(join(tmpdir(), 'dsh-et-boot-'));
process.env.DSH_HOME = join(root, 'dsh');
const home = process.env.DSH_HOME;
const skillDst = join(home, 'skills', 'expert-team');
const presetDst = join(home, '.agent-presets', 'expert-team');
const manifestPath = join(home, 'expert-team', 'installed.json');

const { _live, apply } = await import(join(here, 'lib', 'command.js'));
const { parseTeamCommand } = await import(join(here, 'lib', 'command-parse.js'));

console.log('# 自举安装收口（运行时注册 / 版本戳 / 卸载回收）\n');

console.log('① 从包内 SKILL.md 解析出的注册对象形状正确');
{
  const reg = _live.buildSkillRegistration();
  check(reg && reg.name === 'expert-team', 'name = expert-team', String(reg && reg.name));
  check(reg.source === 'runtime', "source = 'runtime'（宿主据此把它算作运行时条目）", String(reg.source));
  check(typeof reg.description === 'string' && reg.description.length > 40, 'description 非空且足够长', String(reg.description || '').slice(0, 30) + '…');
  check(typeof reg.whenToUse === 'string' && reg.whenToUse.length > 10, 'whenToUse 从 frontmatter 带出来', String(reg.whenToUse || '').slice(0, 30) + '…');
  check(reg.content.length > 2000 && !/^---/.test(reg.content), '正文已去掉 frontmatter', `${reg.content.length} 字符`);
  check(reg.resourceBase && reg.resourceBase.kind === 'directory' && /skills[\\/]expert-team$/.test(reg.resourceBase.path), 'resourceBase 指向包内 skill 目录（相对资源可解析）', String(reg.resourceBase && reg.resourceBase.path));
  const md = await readFile(join(reg.resourceBase.path, 'references', 'PIPELINE.md'), 'utf8');
  check(md.length > 100, 'resourceBase 下的 references/ 真的存在（引用能被读到）');
}

console.log('\n② 无 skill 注册表时：回退到复制，并写版本戳 + 登记清单');
{
  const target = await _live.ensureSkillInstalled();
  check(target === skillDst, '返回复制目标路径', String(target));
  check(await exists(join(skillDst, 'SKILL.md')), 'SKILL.md 已铺到 $DSH_HOME/skills');
  check((await readFile(join(skillDst, _live.INSTALL_STAMP), 'utf8')).trim() === _live.PLUGIN_VERSION, `版本戳 = ${_live.PLUGIN_VERSION}`, '');
  const rec = JSON.parse(await readFile(manifestPath, 'utf8'));
  check(rec.skill && rec.skill.path === skillDst, '清单里登记了 skill 副本（卸载据此回收）', JSON.stringify(rec.skill));
}

console.log('\n③ 版本戳过期 ⇒ 整目录重铺（旧实现"存在即 return"，升级后永远刷不掉）');
{
  const marker = join(skillDst, 'references', 'STALE-PROBE.md');
  await writeFile(marker, 'should be gone after refresh\n');
  await writeFile(join(skillDst, _live.INSTALL_STAMP), '0.0.1-old\n');   // 假装是旧版本铺的
  await _live.ensureSkillInstalled();
  check(!(await exists(marker)), '重铺后旧版本留下的多余文件被清掉（不是逐个覆盖）');
  check((await readFile(join(skillDst, _live.INSTALL_STAMP), 'utf8')).trim() === _live.PLUGIN_VERSION, '版本戳已更新到当前版本');
}

console.log('\n④ 同名但非本插件产物 ⇒ 不覆盖、不删（用户的定制优先）');
{
  // 造一个无版本戳、且内容不像本插件产物的同名 preset
  await rm(presetDst, { recursive: true, force: true });
  await mkdir(presetDst, { recursive: true });
  await writeFile(join(presetDst, 'agent.cordis.yml'), '# 用户自己写的 preset\n[]\n');
  await _live.ensurePresetInstalled();
  const kept = await readFile(join(presetDst, 'agent.cordis.yml'), 'utf8');
  check(/用户自己写的 preset/.test(kept), '身份不符 ⇒ 原样保留（没被我们的副本覆盖）');
  check(!(await exists(join(presetDst, _live.INSTALL_STAMP))), '也没有给它盖上我们的版本戳');
}

console.log('\n⑤ 卸载：只回收"本插件的副本"，别的都留着');
{
  // 铺一份真的 preset 副本（先清掉上面那份用户内容）
  await rm(presetDst, { recursive: true, force: true });
  await _live.ensurePresetInstalled();
  check(await exists(join(presetDst, 'agent.cordis.yml')), 'preset 副本已铺好');
  const rec = JSON.parse(await readFile(manifestPath, 'utf8'));
  check(rec.preset && rec.preset.path === presetDst, '清单登记了 preset', JSON.stringify(rec.preset && rec.preset.version));

  const stateDir = join(home, 'expert-team');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'LEARNINGS.md'), '# 跨项目经验\n\n- 一条真实经验（属于用户数据）\n');
  check(await exists(join(stateDir, 'LEARNINGS.md')), '前置：状态文件已存在（LEARNINGS.md）');

  const out = await _live.uninstallInstalled();
  check(out && out.kind === 'success', '返回 success 结果');
  check(!(await exists(presetDst)), '带戳的 preset 副本被回收');
  check(!(await exists(skillDst)), '带戳的 skill 副本被回收');
  check(!(await exists(manifestPath)), '清单本身也被清掉');
  check(/已回收/.test(out.text), '输出里报告了回收项', out.text.split('\n')[2] || '');
  // 契约：状态文件是**用户数据**（跨项目经验 / 会话→run 记忆），不是安装副本 ⇒ 必须保留，且要说明
  check(await exists(join(stateDir, 'LEARNINGS.md')), '状态文件被保留（LEARNINGS.md 仍在）');
  check(/保留/.test(out.text), '输出里写明"状态文件保留"（契约可见，不靠猜）');

  // 幂等：再跑一次不该报错
  const again = await _live.uninstallInstalled();
  check(again.kind === 'success' && /没有需要回收的副本/.test(again.text), '再跑一次幂等（没有可回收的）');
}

console.log('\n⑥ 宿主提供 skill 注册表时：走运行时注册，一个 skill 文件都不写');
{
  let captured = null;
  const ctx = {
    commands: { register: () => {} },
    on: () => {},
    effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
    inject: () => {},
    get: (k) => (k === 'skills' ? { register: (skill) => { captured = skill; return () => {}; } } : undefined),
  };
  apply(ctx, {});
  check(captured && captured.name === 'expert-team', 'apply() 把 skill 注册进了 ctx.skills', String(captured && captured.name));
  check(_live.runtimeSkillRegistered() === true, '内部标记已置位（后续不再复制）');
  check(!(await exists(skillDst)), '没有任何 skill 文件被写到 $DSH_HOME（这就是"卸载即干净"）');

  const target = await _live.ensureSkillInstalled();
  check(target && /skills[\\/]expert-team$/.test(target) && !target.startsWith(home), '此后 ensureSkillInstalled 直接指向包内目录', String(target));
  check(!(await exists(skillDst)), '仍然没有复制（运行时注册已覆盖它）');
}

console.log('\n⑦ 历史遗留：1.2.0 之前的副本**没有登记过**，卸载仍要能回收它们');
{
  // 造一个"旧版本铺的 skill 副本"：无版本戳、无清单条目，但身份是我们的（SKILL.md 的 name 对得上）
  await rm(skillDst, { recursive: true, force: true });
  await rm(manifestPath, { force: true });
  await mkdir(skillDst, { recursive: true });
  await writeFile(join(skillDst, 'SKILL.md'), '---\nname: expert-team\ndescription: 旧副本\n---\n\n旧正文\n');
  check(!(await exists(manifestPath)), '前置：清单不存在（模拟 1.1.x 时代）');
  const out = await _live.uninstallInstalled();
  check(!(await exists(skillDst)), '无清单也能回收历史 skill 副本（按身份判定：SKILL.md 的 name = expert-team）', out.text.split('\n')[2] || '');

  // 反例：用户自己写的同名 skill（name 不是 expert-team）**不能**被删
  await mkdir(skillDst, { recursive: true });
  await writeFile(join(skillDst, 'SKILL.md'), '---\nname: my-own-skill\ndescription: 用户自己写的\n---\n\n我的正文\n');
  const out2 = await _live.uninstallInstalled();
  check(await exists(skillDst), '身份不符 ⇒ 保留（用户自己写的同名 skill 不会被删）', '');
  check(/保留/.test(out2.text), '并在输出里如实列出"保留"项');
  await rm(skillDst, { recursive: true, force: true });
}

console.log('\n⑧ 命令面：/team uninstall 可解析');
{
  const c = parseTeamCommand('uninstall');
  check(c.kind === 'uninstall', '/team uninstall → kind=uninstall', JSON.stringify(c));
  check(parseTeamCommand('卸载').kind === 'uninstall', '中文「卸载」也可用');
  check(/\/team uninstall/.test((await import(join(here, 'lib', 'command-parse.js'))).USAGE), 'USAGE 里有它');
}

console.log('\n⑨ 插件加载时就把 preset 铺到位（2026-09-15 事故：uninstall 后 preset 消失 ⇒ 会话丢角色工具）');
{
  /** 与 ⑥ 段同形的假 ctx。 */
  const fakeCtx = () => ({
    commands: { register: () => {} },
    on: () => {},
    effect: (fn) => { try { fn(); } catch { /* 忽略 */ } },
    inject: () => {},
    get: (k) => (k === 'skills' ? { register: () => () => {} } : undefined),
  });

  // 前置：模拟"/team uninstall 之后、且还没跑过 /team <任务>"的状态
  await rm(presetDst, { recursive: true, force: true });
  // ⚠️ **清单也要一起清**（2026-09-16 CI 实测）：完成信号取的是"清单里有 preset"，
  // 而 ⑤ 已经登记过一条 ⇒ 不清清单时"清单里有 preset"**立刻为真**，测试会在**这一轮铺盘还
  // 没做完**时就往下走。旧实现会先 mkdir 目标目录、于是往往侥幸读到文件；换成原子换名后目标
  // 目录只在最后一步出现 ⇒ 竞态暴露（CI 上直接 ENOENT）。同一类错误：**完成信号必须是"这一轮
  // 的"，不能是上一轮留下的台账**。
  await rm(manifestPath, { force: true });
  check(!(await exists(presetDst)), '前置：preset 副本不存在（正是事故现场的状态）');
  check(!(await exists(manifestPath)), '前置：清单也不存在（否则"完成信号"是上一轮的台账 ⇒ 竞态/假绿）');

  // ⑨.1 加载即铺 —— 本事故的核心修复：不再等 createRun
  apply(fakeCtx(), {});
  const laid1 = await waitFor(presetRecorded);
  check(laid1.ok, 'apply() 之后铺盘**真的做完**（清单已登记 preset，不只是"文件出现了"）', 'waited=' + laid1.ms + 'ms');
  check(await exists(join(presetDst, 'agent.cordis.yml')), 'apply() 之后 preset 已在位（**加载即铺**，不再等首次 /team）');
  check((await readFile(join(presetDst, _live.INSTALL_STAMP), 'utf8')).trim() === _live.PLUGIN_VERSION, '且带上当前版本戳', _live.PLUGIN_VERSION);
  check(!(await exists(skillDst)), 'skill 仍不落地（运行时注册优先，加载时那次调用立即返回）');

  // ⑨.2 事故回归：uninstall → 再加载 ⇒ preset 又回来
  await _live.uninstallInstalled();
  check(!(await exists(presetDst)), 'uninstall 之后副本被清掉');
  apply(fakeCtx(), {});
  const laid2 = await waitFor(presetRecorded);
  check(laid2.ok, '再次加载 ⇒ preset 又铺回来了（**本事故的回归测试**）', 'waited=' + laid2.ms + 'ms');
  check(await exists(join(presetDst, 'agent.cordis.yml')), '且文件确实落盘', '');

  // ⑨.3 铺不上不许抛（只读盘/权限问题不能把插件挂不上）
  const savedHome = process.env.DSH_HOME;
  let threw = null;
  try {
    process.env.DSH_HOME = '/dev/null/nope';
    try { apply(fakeCtx(), {}); } catch (e) { threw = String((e && e.message) || e); }
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    process.env.DSH_HOME = savedHome;
  }
  check(threw === null, '$DSH_HOME 不可写时 apply() 不抛（铺不上不影响插件加载）', threw || '（预期会出现一条一次性的 warn）');
}


// ── ⑩ 铺设的**归属判定**与**原子换名**（2026-09-16 · 用户批准 (a)+(b)）──────────
//
// 为什么单独一节：铺盘被打断会留下**无戳的半成品**，而旧归属判定只有"是不是我们的"两态 ⇒
// 那种半成品被当成「用户的定制」而**永不覆盖**，只打一行 warn（看起来完全正常）。
// 本节钉四件事：四态判定（含两个方向）、原子换名不留半成品、preset 与 skill **两条路径**都如此、
// 以及"显式重铺"必须**如实记录替换了什么**。
//
// ⚠️ 旧代码上这些断言必须是**断言失败**、不能是 TypeError 崩溃（本仓吃过"崩溃不算体面地红"的亏）：
// 所以先动态 import 再**断言导出存在**，缺失时后续断言各自判假，而不是直接炸。
console.log('\n⑩ 铺设：四态判定 / 原子换名 / 两条路径都不留半成品');
{
  let PL = null;
  try { PL = await import(join(here, 'lib', 'preset-lay.js')); } catch { PL = null; }
  check(PL && typeof PL.classifyLayTarget === 'function', 'lib/preset-lay.js 导出 classifyLayTarget（旧代码上：断言失败，不是崩溃）');
  const CL = (PL && PL.classifyLayTarget) || (() => ({ state: undefined, action: undefined, stale: undefined, complete: undefined, missing: [] }));
  const base = { currentVersion: '1.3.25', expectedEntryFiles: ['agent.cordis.yml', 'preset.yml'], presentEntryFiles: ['agent.cordis.yml', 'preset.yml'] };

  // ⑩.1 四态
  check(CL({ ...base, exists: false }).state === 'absent', '目标不存在 ⇒ absent');
  check(CL({ ...base, exists: true, hasStamp: true, stampVersion: '1.3.25', identityMatch: true }).action === 'skip-fresh', '带戳+版本当前+齐全 ⇒ 不重铺');
  check(CL({ ...base, exists: true, hasStamp: true, stampVersion: '1.3.24', identityMatch: true }).state === 'ours', '带戳但版本旧 ⇒ ours（要重铺）');
  check(CL({ ...base, exists: true, hasStamp: false, identityMatch: true }).state === 'ours', '无戳但身份是本插件 ⇒ ours（1.2.0 之前的历史副本）');
  check(CL({ ...base, exists: true, hasStamp: false, identityMatch: false }).state === 'foreign-complete', '身份不符 + 入口齐全 ⇒ foreign-complete');
  check(CL({ ...base, exists: true, hasStamp: false, identityMatch: false, presentEntryFiles: ['preset.yml'] }).state === 'partial-or-unknown', '身份不符 + 缺入口 ⇒ partial-or-unknown');

  // ⑩.2 **两个方向**（派工方追加要求 1）：缺一头都会出人命 —— 要么覆盖用户的定制，要么给用户无谓告警
  const unknown = CL({ ...base, exists: true, hasStamp: null, identityMatch: null });
  // 反空转：要求它是**已知四态之一且不是 ours** —— 否则旧代码上  会**假绿**。
  check(!!PL && Array.isArray(PL.LAY_STATES) && PL.LAY_STATES.indexOf(unknown.state) !== -1 && unknown.state !== 'ours', '方向①：**不确定**（戳读不到 + 身份判不出来）⇒ 是已知四态之一且不是 ours（绝不动可能是用户的东西）', String(unknown.state));
  check(unknown.state === 'partial-or-unknown', '方向①：不确定 ⇒ 落在 partial-or-unknown（显眼报告、不覆盖）', String(unknown.state));
  const oursStale = CL({ ...base, exists: true, hasStamp: true, stampVersion: '1.0.0', identityMatch: true });
  check(oursStale.state === 'ours' && oursStale.stale === true, '方向②：ours-stale ⇒ 不是 partial-or-unknown（别给用户无谓告警）', String(oursStale.state));
  check(CL({ ...base, exists: true, hasStamp: true, stampVersion: '1.3.25', identityMatch: true, presentEntryFiles: [] }).state === 'ours', '方向②：带戳但不完整 ⇒ 仍是 ours（我们自己的残留）');
  check(CL({ ...base, exists: true, hasStamp: false, identityMatch: false, expectedEntryFiles: [] }).state === 'partial-or-unknown', '反空转：期望清单读不到 ⇒ 判不出来 ⇒ 不许当 foreign-complete');

  // ⑩.2b 给界面的一句话**不许含 markdown 标记** —— 它会**原样渲染**（设置页没有 markdown 渲染器）。
  // 这条是 2026-09-16 的真实教训：Hindsight 面板刚修过"把 markdown 当纯文本显示"，
  // 本节新写的文案差点又犯一次（`**原子换名**` 的星号会被用户看见）——所以在这里钉住。
  if (typeof PL?.describeLayOutcome !== 'function') {
    check(false, 'lib/preset-lay.js 导出 describeLayOutcome（旧代码上：断言失败）');
  } else {
    const hasMd = (s) => /\*\*|\x60|\]\(|^#{1,6}\s/.test(String(s == null ? '' : s));
    const samples = [
      PL.describeLayOutcome({ state: 'ours', action: 'lay', version: '1.3.25' }),
      PL.describeLayOutcome({ state: 'foreign-complete' }),
      PL.describeLayOutcome({ state: 'partial-or-unknown', missing: ['agent.cordis.yml'] }),
      PL.describeLayOutcome(null),
    ];
    check(samples.every((s) => s && !hasMd(s.zh) && !hasMd(s.en)), '给界面的一句话不含 markdown 标记（会被原样渲染）', JSON.stringify(samples.map((s) => s.zh)));
    check(samples.every((s) => s && ['ok', 'warn', 'bad'].indexOf(s.level) !== -1), '每句话都带一个明确级别（ok/warn/bad）供界面着色', JSON.stringify(samples.map((s) => s.level)));
  }

  // ⑩.3 原子换名：中途失败**不留半成品**（直接打在原语上，确定性最高）
  if (typeof PL?.layDirAtomic !== 'function') {
    check(false, 'lib/preset-lay.js 导出 layDirAtomic（旧代码上：断言失败）');
  } else {
    const atomicRoot = join(root, 'atomic');
    const aSrc = join(atomicRoot, 'src');
    await mkdir(aSrc, { recursive: true });
    await writeFile(join(aSrc, 'agent.cordis.yml'), 'src\n');
    const aDst = join(atomicRoot, 'out', 'expert-team');
    await mkdir(aDst, { recursive: true });
    await writeFile(join(aDst, 'agent.cordis.yml'), 'ORIGINAL\n');
    let threw = null;
    try {
      await PL.layDirAtomic(aSrc, aDst, { copyInto: async (tmp) => { await writeFile(join(tmp, 'half'), 'x'); throw new Error('boom-mid-copy'); } });
    } catch (e) { threw = String((e && e.message) || e); }
    check(/boom-mid-copy/.test(String(threw)), '拷贝中途失败 ⇒ 原样上抛（不吞）', String(threw));
    check((await readFile(join(aDst, 'agent.cordis.yml'), 'utf8')) === 'ORIGINAL\n', '失败后**原目标逐字节未变**（没有半成品覆盖上去）');
    const outLeft = await readdir(join(atomicRoot, 'out'));
    check(outLeft.filter((n) => n.startsWith(PL.LAY_TMP_PREFIX)).length === 0, '失败后**没有**我们前缀的临时残留', JSON.stringify(outLeft));
  }

  // ⑩.4 preset 路径：foreign-complete / partial / 显式重铺 / ours-stale
  if (typeof _live.layInstalledAsset !== 'function' || typeof _live.layFactsFor !== 'function') {
    check(false, '_live 导出 layInstalledAsset / layFactsFor（旧代码上：断言失败）');
  } else {
    const src = _live.PRESET_DIR;
    const srcNames = await readdir(src);
    const statusOf = () => (typeof _live.presetLayStatus === 'function' ? _live.presetLayStatus() : null);

    // (i) 身份明确不是我们的、且入口齐全 ⇒ **绝不覆盖**
    await rm(presetDst, { recursive: true, force: true });
    await mkdir(presetDst, { recursive: true });
    for (const n of srcNames) await writeFile(join(presetDst, n), '# 用户自己写的\n');
    await _live.layInstalledAsset('preset', src, presetDst);
    check((await readFile(join(presetDst, 'agent.cordis.yml'), 'utf8')) === '# 用户自己写的\n', '(i) foreign-complete ⇒ 原样保留（用户的定制优先）');
    const stUser = statusOf();
    check(stUser && stUser.preset && stUser.preset.state === 'foreign-complete', '(i) 状态如实记为 foreign-complete（不是静默 warn）', JSON.stringify(stUser && stUser.preset && stUser.preset.state));
    check(stUser && stUser.display && stUser.display.preset && stUser.display.preset.level === 'warn', '(i) 给界面的一句话是"让位给用户的定制"（可显示）', JSON.stringify(stUser && stUser.display && stUser.display.preset));

    // (ii) 只有部分入口 ⇒ **不覆盖 + 显眼报告**（这正是"被打断留下的半成品"那种形态）
    await rm(presetDst, { recursive: true, force: true });
    await mkdir(presetDst, { recursive: true });
    await writeFile(join(presetDst, 'preset.yml'), '# 半成品：只拷到这一个文件就被打断了\n');
    await _live.layInstalledAsset('preset', src, presetDst);
    check((await readFile(join(presetDst, 'preset.yml'), 'utf8')) === '# 半成品：只拷到这一个文件就被打断了\n', '(ii) partial-or-unknown ⇒ 不覆盖');
    const stPart = statusOf();
    check(stPart && stPart.preset && stPart.preset.state === 'partial-or-unknown', '(ii) 状态如实记为 partial-or-unknown', JSON.stringify(stPart && stPart.preset && stPart.preset.state));
    check(stPart && stPart.preset && stPart.preset.missing.length > 0, '(ii) 并列出**缺哪些入口文件**（可操作）', JSON.stringify(stPart && stPart.preset && stPart.preset.missing));
    check(stPart && stPart.display && stPart.display.preset && stPart.display.preset.level === 'bad', '(ii) 给界面的一句话是"未覆盖：内容不完整"（显眼，不是一行 warn）', JSON.stringify(stPart && stPart.display && stPart.display.preset));

    // (iii) **用户显式**重铺 ⇒ 照铺，且**如实记录替换了什么**
    const relayed = typeof _live.relayInstalledAssets === 'function' ? await _live.relayInstalledAssets('preset') : { ok: false, results: [] };
    check(relayed && relayed.ok === true, '(iii) 显式重铺成功', JSON.stringify(relayed && relayed.ok));
    check(await exists(join(presetDst, _live.INSTALL_STAMP)), '(iii) 重铺后带上了我们的版本戳');
    check((await readFile(join(presetDst, _live.INSTALL_STAMP), 'utf8')).trim() === _live.PLUGIN_VERSION, '(iii) 版本戳 = 当前版本', _live.PLUGIN_VERSION);
    const stAfter = statusOf();
    check(stAfter && stAfter.preset && stAfter.preset.state === 'ours', '(iii) 状态转为 ours', JSON.stringify(stAfter && stAfter.preset && stAfter.preset.state));
    check(stAfter && stAfter.preset && typeof stAfter.preset.replaced === 'string' && /partial-or-unknown/.test(stAfter.preset.replaced), '(iii) **如实记录被替换的是什么**（不静默覆盖）', JSON.stringify(stAfter && stAfter.preset && stAfter.preset.replaced));

    // (iv) ours-stale（版本戳过期）⇒ 原子重铺，旧版本多余文件被清掉
    await writeFile(join(presetDst, 'OLD-ONLY.md'), 'gone after relayout\n');
    await writeFile(join(presetDst, _live.INSTALL_STAMP), '0.0.1-old\n');
    await _live.layInstalledAsset('preset', src, presetDst);
    check(!(await exists(join(presetDst, 'OLD-ONLY.md'))), '(iv) ours-stale ⇒ 整目录重铺（旧版多余文件被清掉）');
    check((await readFile(join(presetDst, _live.INSTALL_STAMP), 'utf8')).trim() === _live.PLUGIN_VERSION, '(iv) 版本戳已更新');
  }

  // ⑩.5 skill 路径：同一条 fire-and-forget 路径 ⇒ **必须各自有测试**（派工方追加要求 3）
  if (typeof _live.layInstalledAsset === 'function' && typeof _live.SKILL_DIR === 'string') {
    const skillSrc = _live.SKILL_DIR;
    const statusOf = () => (typeof _live.presetLayStatus === 'function' ? _live.presetLayStatus() : null);
    // (i) 身份明确不是我们的（SKILL.md 的 name 不是 expert-team）+ 入口齐全 ⇒ 不覆盖
    await rm(skillDst, { recursive: true, force: true });
    await mkdir(skillDst, { recursive: true });
    for (const n of await readdir(skillSrc)) {
      const st0 = await stat(join(skillSrc, n));
      if (st0.isDirectory()) await mkdir(join(skillDst, n), { recursive: true });
      else await writeFile(join(skillDst, n), n === 'SKILL.md' ? '---\nname: my-own-skill\n---\n用户自己的\n' : 'x\n');
    }
    await _live.layInstalledAsset('skill', skillSrc, skillDst);
    check(/my-own-skill/.test(await readFile(join(skillDst, 'SKILL.md'), 'utf8')), 'skill (i) 身份不符 + 齐全 ⇒ 原样保留（用户自己写的同名 skill 不被覆盖）');
    check(statusOf()?.skill?.state === 'foreign-complete', 'skill (i) 状态如实记为 foreign-complete', JSON.stringify(statusOf()?.skill?.state));
    // (ii) 半成品（只拷到 SKILL.md 就被打断）⇒ 不覆盖 + 显眼报告
    await rm(skillDst, { recursive: true, force: true });
    await mkdir(skillDst, { recursive: true });
    await writeFile(join(skillDst, 'SKILL.md'), '---\nname: my-own-skill\n---\nZZHALF-MARKER\n');
    await _live.layInstalledAsset('skill', skillSrc, skillDst);
    check(/ZZHALF-MARKER/.test(await readFile(join(skillDst, 'SKILL.md'), 'utf8')), 'skill (ii) partial-or-unknown ⇒ 不覆盖');
    check(statusOf()?.skill?.state === 'partial-or-unknown', 'skill (ii) 状态如实记为 partial-or-unknown', JSON.stringify(statusOf()?.skill?.state));
    // (iii) 显式重铺 ⇒ 照铺并记录
    const r2 = await _live.relayInstalledAssets('skill');
    check(r2 && r2.ok === true, 'skill (iii) 显式重铺成功（或走运行时注册而跳过）', JSON.stringify(r2 && r2.results));
    if (!(r2 && r2.results && r2.results[0] && r2.results[0].skipped)) {
      check((await readFile(join(skillDst, _live.INSTALL_STAMP), 'utf8')).trim() === _live.PLUGIN_VERSION, 'skill (iii) 重铺后带上了当前版本戳');
      check(statusOf()?.skill?.state === 'ours', 'skill (iii) 状态转为 ours', JSON.stringify(statusOf()?.skill?.state));
    }
    // (iii-b) skill 的**强制铺设**路径也要单独走一遍：运行时注册会让 relayInstalledAssets('skill')
    // 直接跳过（这是**正确行为**，但也意味着"从半成品恢复到我们的副本"这条路没被覆盖）——
    // 所以这里直接调 force 版，证明 skill 路径同样能"从 partial-or-unknown 恢复到 ours 并记录替换了什么"。
    const forced = await _live.layInstalledAsset('skill', skillSrc, skillDst, { force: true, forceEvenFresh: true, replacedBy: 'test-force' });
    check(forced === skillDst, 'skill (iii-b) 强制铺设返回目标路径', String(forced));
    check((await readFile(join(skillDst, _live.INSTALL_STAMP), 'utf8')).trim() === _live.PLUGIN_VERSION, 'skill (iii-b) 强制铺设后带上了当前版本戳');
    check(/ZZHALF-MARKER/.test(await readFile(join(skillDst, 'SKILL.md'), 'utf8')) === false, 'skill (iii-b) 半成品内容被整目录替换（不是逐个覆盖）');
    check(statusOf()?.skill?.state === 'ours', 'skill (iii-b) 状态转为 ours', JSON.stringify(statusOf()?.skill?.state));
    check(typeof statusOf()?.skill?.replaced === 'string' && /partial-or-unknown/.test(statusOf().skill.replaced), 'skill (iii-b) 同样**如实记录被替换的是什么**', JSON.stringify(statusOf()?.skill?.replaced));

    // (iv) 运行时注册优先时，ensureSkillInstalled 仍直接指向包内目录（行为不能被这次改动破坏）
    const t2 = await _live.ensureSkillInstalled();
    check(t2 === _live.SKILL_DIR, 'skill (iv) 运行时注册生效时 ensureSkillInstalled 直接返回包内目录（一个文件都不写）', String(t2));
  } else {
    check(false, '_live 导出 layInstalledAsset / SKILL_DIR（旧代码上：断言失败）');
  }
  // ⑩.6 **两处缺陷的回归护栏**（2026-09-16 用户报告 → 当天修）：
  //  ① 铺盘失败却显示「已铺设」：旧判据只看 state+action（失败路径也带 action:'lay'），
  //     从不看 reason/结果 ⇒ 一次失败被渲染成 ok 级「已铺设」；首次铺设失败同样如此。
  //  ② skill 走运行时注册是**正常**情形，却因那条分支从不写 STATUS 而常亮「铺设状态未知」。
  // 两条都要求红→绿（在旧码上先红），所以断言同时钉住"反面"。
  if (typeof PL?.describeLayOutcome !== 'function' || typeof _live.presetLayStatus !== 'function') {
    check(false, 'lib/preset-lay.js 导出 describeLayOutcome / _live 导出 presetLayStatus（旧代码上：断言失败）');
  } else {
    const D = PL.describeLayOutcome;
    const noMd = (x) => !/\*\*|\x60|\]\(/.test(String(x == null ? '' : x));

    // ① 失败 ⇒ 绝不许出现「已铺设」
    const f1 = D({ state: 'ours', action: 'lay', outcome: 'failed', reason: 'lay-failed:disk full', pluginVersion: '1.3.26', at: Date.now() });
    check(f1.level === 'bad', '① outcome=failed ⇒ bad 级', f1.level + ' | ' + f1.zh);
    check(!/已铺设/.test(f1.zh), '① 失败文案里**不许出现「已铺设」**', f1.zh);
    check(/disk full/.test(f1.zh), '① 失败文案必须带上原因', f1.zh);
    // 旧记录（没有 outcome，只有 lay-failed:）也必须判失败 —— **这条在旧实现上是「ok｜已铺设」**
    const f2 = D({ state: 'absent', action: 'lay', reason: 'lay-failed:boom', pluginVersion: '1.3.26', at: Date.now() });
    check(f2.level === 'bad' && !/已铺设/.test(f2.zh), '① 只有 lay-failed: 前缀的旧记录 ⇒ 仍判失败（**首次铺设失败**那条路径）', f2.level + ' | ' + f2.zh);
    const f3 = D({ state: 'ours', action: 'lay', outcome: 'succeeded', pluginVersion: '1.3.26', at: Date.now() });
    check(f3.level === 'ok' && /成功/.test(f3.zh), '① 正常成功 ⇒ 仍是 ok（**别把灯一律点红**）', f3.level + ' | ' + f3.zh);
    check(/截至 |记录时刻未知/.test(f3.zh), '① 文案必须交代「截至某时刻」（记录是快照，不是实时）', f3.zh);

    // ② 运行时注册（正常）⇒ ok；**判不出来**仍必须是「未知」
    const rtRec = typeof _live.skillRuntimeRegisteredRecord === 'function'
      ? _live.skillRuntimeRegisteredRecord(_live.SKILL_DIR, _live.PLUGIN_VERSION)
      : null;
    check(rtRec !== null, '② _live 导出 skillRuntimeRegisteredRecord（旧代码上：断言失败，不是崩溃）');
    const rt = rtRec ? D(rtRec) : { level: '(none)', zh: '(none)', en: '(none)' };
    check(rtRec !== null && rt.level === 'ok' && !/未知/.test(rt.zh), '② 由运行时注册提供 ⇒ ok 级、且不再说「未知」', rt.level + ' | ' + rt.zh);
    _live._resetPresetLay();
    const withFlag = _live.presetLayStatus({ runtimeSkillRegistered: true, skillTarget: _live.SKILL_DIR, pluginVersion: _live.PLUGIN_VERSION });
    check(withFlag.display.skill.level === 'ok' && !/未知/.test(withFlag.display.skill.zh), '② 即使 STATUS 没记上，只要「运行时已注册」是已知事实 ⇒ 界面也不该显示「未知」（纵深防御）', withFlag.display.skill.level + ' | ' + withFlag.display.skill.zh);
    const noFlag = _live.presetLayStatus();
    check(noFlag.display.skill.level === 'warn' && /未知/.test(noFlag.display.skill.zh), '② **拿不到事实时仍如实说「未知」**（不许为了消灯把未知说成正常）', noFlag.display.skill.level + ' | ' + noFlag.display.skill.zh);
    const noRec = D(null);
    check(noRec.level === 'warn' && /未知/.test(noRec.zh), '② 没有任何记录 ⇒ warn + 未知', noRec.level + ' | ' + noRec.zh);
    _live._resetPresetLay();

    // ③ 字段名歧义：不再有 `version`（它曾被误读成"盘上戳的版本"）
    PL.recordLayOutcome('preset', { state: 'ours', action: 'lay', outcome: 'succeeded', pluginVersion: _live.PLUGIN_VERSION });
    const rec3 = _live.presetLayStatus().preset;
    check(rec3 && rec3.pluginVersion === _live.PLUGIN_VERSION, '③ 记录里是 pluginVersion（含义 = 本条记录针对的插件版本）', JSON.stringify(rec3 && rec3.pluginVersion));
    check(rec3 && !('version' in rec3), '③ 旧的 version 字段已移除（不许留着让读者误解）', JSON.stringify(Object.keys(rec3 || {})));
    _live._resetPresetLay();

    // ④ 新文案同样不许含 markdown 标记（本仓被这个坑咬过两次）
    check([f1, f2, f3, rt, noRec].every((r) => noMd(r.zh) && noMd(r.en)), '④ 两处新文案都不含 markdown 标记（设置页没有渲染器）', JSON.stringify([f1, f2, f3, rt, noRec].map((r) => r.zh)));

    // ⑤ **接线断言（源码级，不是运行期行为）**：运行时注册那条分支必须写状态 ——
    //    它盯的是"将来有人把那行 recordLayOutcome 删掉 ⇒ 缺陷 ② 复发"。
    const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
    const rtBranch = /if \(RUNTIME_SKILL_REGISTERED\) \{[\s\S]{0,400}?recordLayOutcome\('skill', skillRuntimeRegisteredRecord\(/.test(cmdSrc);
    check(rtBranch, '⑤ [接线断言] ensureSkillInstalled 的运行时分支**必须**调 recordLayOutcome（否则「状态未知」常亮会复发）');
  }
}

await rmFixture(root);
console.log('');
if (fail > 0) {
  console.log(`✗ 自举收口测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 自举收口测试通过（运行时注册不落地 / 版本戳重铺 / 不碰用户内容 / 卸载只删自己的）');
