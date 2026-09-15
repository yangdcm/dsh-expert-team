// 测试：B 线第 8 项 · `lib/command-parse.js`（`/team` 的整个 CLI 面）
//
// 搬出的东西：`USAGE`（用法文本）、`PROFILE_DEFS` + `resolveProfile`（命名编制模板）、
// `parseTeamCommand`（把一行输入解析成 `{kind, …}`）。`DEFAULT_ROLES` 同时搬进 `vocab.js`
//（`PROFILE_DEFS.delivery` 要用它，而 `command.js` 又要 import 本模块 —— 留下就是**循环 import**）。
//
// 本测试除了常规的"搬走/接上/兼容"，还钉一条**这一段挖出来的真问题**：
//   ④ **USAGE 与解析器必须双向一致** —— 实现了但没文档（用户不知道有这功能）、
//      文档了但没实现（用户照着敲、静默无效）都是缺陷。
//      旧断言 `src.match(/const USAGE = \[[\s\S]*?\n\];/)` **从来没匹配到 USAGE 真正的收尾**
//      （它是以 ` ].join('\n');` 结束的），在 5101 行的 command.js 里惰性一路匹到后面某处的
//      `\n];`，于是抓到一大坨**恰好含所有 flag** 的文本 —— 断言"通过"了，但校验的不是 USAGE。
//      搬到 181 行的小文件后那个"后面的 `];`"没了，**假绿当场暴露**。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M124**。
// 运行：node command-parse-module.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# B 线第 8 项 · command-parse.js\n');

const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
const cpSrc = await readFile(join(here, 'lib', 'command-parse.js'), 'utf8');
const vocabSrc = await readFile(join(here, 'lib', 'vocab.js'), 'utf8');
const { _live } = await import(join(here, 'lib', 'command.js'));
const CP = await import(join(here, 'lib', 'command-parse.js'));
const VB = await import(join(here, 'lib', 'vocab.js'));

const MOVED = ['USAGE', 'PROFILE_DEFS', 'resolveProfile', 'parseTeamCommand'];

console.log('① 搬走了没接上？（定义只许在 command-parse.js，command.js 必须 import）');
{
  const left = MOVED.filter((n) => new RegExp(`^(?:export\\s+)?(?:function|const|let)\\s+${n}\\b`, 'm').test(cmdSrc));
  check(left.length === 0, 'command.js 里没有这 4 个符号的第二份定义', left.length ? `残留：${left.join(', ')}` : `${MOVED.length} 个都只在 command-parse.js`);
  check(/from '\.\/command-parse\.js'/.test(cmdSrc), 'command.js 确实从 `./command-parse.js` import');
  check(MOVED.every((n) => n in CP), 'command-parse.js 把它们都导出了');
  check(!/from '\.\/command\.js'/.test(cpSrc), 'command-parse.js **不反向依赖** command.js（否则循环 import）');
  check(!/readFile|writeFile|fetch\(|ctx\./.test(cpSrc), '本模块**零 IO、不认识 ctx**（只解析、不执行）');
}

console.log('\n② `DEFAULT_ROLES` 只此一份（搬去 vocab.js 是为了断环，不是顺手挪个位置）');
{
  check(/export const DEFAULT_ROLES = \[/.test(vocabSrc), 'vocab.js 里有唯一定义');
  check(!/^const DEFAULT_ROLES = \[/m.test(cmdSrc), 'command.js 里不再有定义（只 import）');
  check(/import \{ DEFAULT_ROLES \} from '\.\/vocab\.js'/.test(cpSrc), 'command-parse.js 从 vocab.js 取（不自己再抄一份 12 角色）');
  check(_live.DEFAULT_ROLES === VB.DEFAULT_ROLES, '`_live.DEFAULT_ROLES` 与 vocab.js 里**是同一个数组**');
  check(CP.PROFILE_DEFS.delivery.roles === VB.DEFAULT_ROLES, '`PROFILE_DEFS.delivery.roles` **就是**那份默认班底（同一引用，不会各改各的）');
}

console.log('\n③ 兼容层：`_live` 的名字与行为不得因搬家而变');
{
  check(_live.parseTeamCommand === CP.parseTeamCommand, '`_live.parseTeamCommand` 与模块里**是同一个函数**（不是又包一层）');
  const p = _live.parseTeamCommand('--confirm 把登录改成手机号');
  check(p.kind === 'create' && p.task === '把登录改成手机号' && p.confirm === true, '经 `_live` 调用行为不变', JSON.stringify(p).slice(0, 60));
  check(_live.parseTeamCommand('').kind === 'help' && _live.parseTeamCommand('help').kind === 'help', '空串与 `help` 都走 help（历史坑：曾落到 create）');
}

console.log('\n④ 行为契约（解析口径不许在搬迁中被"顺手改好一点"）');
{
  const c = CP.parseTeamCommand;
  check(c('status').kind === 'status' && c('check').kind === 'check', 'status / check');
  check(c('settle my-run').kind === 'settle' && c('settle my-run').run === 'my-run', 'settle 带 runId');
  check(c('wait').kind === 'wait' && c('wait').kind !== 'create', 'wait 不落到 create');
  check(c('rules').kind === 'rules' && c('rules').action === 'list', '`/team rules` ⇒ kind=rules / action=list');
  const rl = c('rule 改完就提交');
  check(rl.kind === 'rules' && rl.action === 'add' && rl.rule === '改完就提交', '`/team rule <文本>` ⇒ **同一个 kind**、action=add（不是另一个 kind）', JSON.stringify(rl));
  check(c('tier 严格档').kind === 'tier', 'tier 子命令（G 线）');
  check(c('--persist x').persist === true && c('x').persist === null, '--persist（未给 flag ⇒ null = 未表态，听设置）');
  check(c('--no-code x').noCode === true, '--no-code');
  check(c('--allow-rebuild x').allowRebuild === true, '--allow-rebuild');
  check(c('--roles pm,qa x').roles.join(',') === 'pm,qa', '--roles 逗号列表');
  check(c('--name my-run x').runName === 'my-run', '--name ⇒ 字段名是 `runName`（不是 `name`）', JSON.stringify(c('--name my-run x')).slice(0, 70));
  check(c('--profile design x').profile === 'design', '--profile');
  // ⑤ 的枚举是**源码文本**级的：它能抓「文档写了但代码里没有」，抓不到「代码里有但永远返回 false」。
  // 所以对每个带值的 flag 都补一条**行为**断言（下面这条 `--deep` 就是 M124 的靶子）。
  check(c('learn --deep').kind === 'learn' && c('learn --deep').deep === true, '`/team learn --deep` ⇒ deep=true（不是只有文档、解析恒 false）');
  check(c('learn').deep === false, '`/team learn` ⇒ deep=false');
  check(c('--tier 快速档 x').tierRaw === '快速档' || /快速/.test(JSON.stringify(c('--tier 快速档 x'))), '--tier 带档位', JSON.stringify(c('--tier 快速档 x')).slice(0, 60));
  check(CP.resolveProfile('design', { deliverable: 'code+artifacts' }).deliverable === 'artifacts-only', '`resolveProfile(design)` ⇒ 只出工件');
  check(CP.resolveProfile('review', { deliverable: 'code+artifacts' }).roles.includes('qa'), '`resolveProfile(review)` 带 qa');
  check(CP.resolveProfile('不存在的模板', { deliverable: 'code+artifacts', roles: ['pm'] }).roles.join(',') === 'pm', '**认不出的 profile ⇒ 原样回落**（不猜、不报错）');
  check(Object.keys(CP.PROFILE_DEFS).join(',') === 'delivery,review,design,refactor,research', '五个命名模板', Object.keys(CP.PROFILE_DEFS).join(','));
}

console.log('\n⑤ **USAGE ⟺ 解析器 双向一致**（这一段挖出假绿后新加的硬约束）');
{
  // 真实收尾：` ].join('\n');`（不是顶格 `];`）—— 旧正则就是栽在这里。
  const usage = (cpSrc.match(/(?:export )?const USAGE = \[[\s\S]*?\n\s*\]\.join\('\\n'\);/) || [''])[0];
  check(!!usage, '按**真实收尾**抓到 USAGE 常量（旧正则抓不到）', `${usage.length} 字符`);
  const docFlags = new Set([...usage.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
  // ⚠️ 不能用「找 `flag === '--x'`」这种写法去枚举实现：本模块**有两种**解析习惯
  //（`flag === '--persist'` 与 `/(^|\s)--watch(\s|$)/.test(input)`），按前者枚举会漏掉后者。
  // 我第一版就这么写了 ⇒ `implFlags` 为空 ⇒「实现了就必须有文档」**空集合恒真**（又一个假绿，
  // 而且是在「专门抓假绿」的测试里）。改成：把 USAGE 数组从源码里剔掉，剩下就是实现部分，
  // 在其中枚举 flag token —— 与写法无关。
  const implPart = cpSrc.replace(usage, '');
  const implFlags = new Set([...implPart.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
  check(implFlags.size >= 10, '枚举到的实现侧 flag 数量合理（**不是空集** ⇒ 下面那条断言不空转）', `${implFlags.size} 个：${[...implFlags].join(' ')}`);
  const undocumented = [...implFlags].filter((f) => !docFlags.has(f));
  const unimplemented = [...docFlags].filter((f) => !implFlags.has(f));
  check(undocumented.length === 0, '**实现了就必须有文档**（否则用户不知道有这功能）', undocumented.length ? `缺文档：${undocumented.join(', ')}` : `${implFlags.size} 个 flag 全有文档`);
  check(unimplemented.length === 0, '**有文档就必须实现**（否则用户照着敲、静默无效）', unimplemented.length ? `只有文档：${unimplemented.join(', ')}` : '');
  check(docFlags.size >= 7, 'USAGE 里至少覆盖这些 flag', [...docFlags].join(' '));
  check(/\/team help/.test(usage), 'USAGE 提到 `/team help` 本身（否则用户不知道有它）');
  check(/\/team --tier/.test(usage), 'USAGE 提到 `--tier`（G 线的档位入口必须可发现）');
  check(CP.USAGE.split('\n').length > 25, '`USAGE` 导出的是完整用法文本', `${CP.USAGE.split('\n').length} 行`);
}

if (fail) { console.error(`\n✗ command-parse-module：${fail} 项失败`); process.exit(1); }
console.log('\n✓ command-parse-module：全部通过（搬走/接上/断环/兼容/口径/文档双向一致）');
