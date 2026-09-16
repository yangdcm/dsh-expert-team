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

import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
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
  check(!(await exists(presetDst)), '前置：preset 副本不存在（正是事故现场的状态）');

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

await rmFixture(root);
console.log('');
if (fail > 0) {
  console.log(`✗ 自举收口测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 自举收口测试通过（运行时注册不落地 / 版本戳重铺 / 不碰用户内容 / 卸载只删自己的）');
