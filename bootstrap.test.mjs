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

  const out = await _live.uninstallInstalled();
  check(out && out.kind === 'success', '返回 success 结果');
  check(!(await exists(presetDst)), '带戳的 preset 副本被回收');
  check(!(await exists(skillDst)), '带戳的 skill 副本被回收');
  check(!(await exists(manifestPath)), '清单本身也被清掉');
  check(/已回收/.test(out.text), '输出里报告了回收项', out.text.split('\n')[2] || '');

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

console.log('\n⑦ 命令面：/team uninstall 可解析');
{
  const c = parseTeamCommand('uninstall');
  check(c.kind === 'uninstall', '/team uninstall → kind=uninstall', JSON.stringify(c));
  check(parseTeamCommand('卸载').kind === 'uninstall', '中文「卸载」也可用');
  check(/\/team uninstall/.test((await import(join(here, 'lib', 'command-parse.js'))).USAGE), 'USAGE 里有它');
}

await rmFixture(root);
console.log('');
if (fail > 0) {
  console.log(`✗ 自举收口测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 自举收口测试通过（运行时注册不落地 / 版本戳重铺 / 不碰用户内容 / 卸载只删自己的）');
