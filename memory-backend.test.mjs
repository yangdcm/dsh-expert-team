// 测试：**记忆后端三选一**（`lib/memory-backend.js` + 路由 + 客户端按钮）
//
// 需求原文（用户，逐字）：「记忆后端要能选 —— Hindsight / Midas / 都不用」。
//
// ── 为什么这个文件值得单独存在 ──────────────────────────────────────────────
// 这一项与前 19 个设置项**有一个本质区别**：它的落地点不在设置存储里，而在 dsh profile 的补丁文件
// （`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）—— 那是用户与**别的插件**都会写的共享文件，
// 我们只是往里面加/去一行 `- id: hindsight` + `disabled: true`。于是有三条**会真的伤到人**的失败模式：
//   ① **把用户原有内容写没**（盲目合并/整份重写）⇒ 别的插件从此静默失效；
//   ② **谎报状态**（"已保存"但其实没落地 / 选了 Hindsight 却被写成禁用）⇒ 用户以为记忆开着；
//   ③ **不幂等**（设置页每保存一次就写一次盘）⇒ 文件被无意义地反复改写。
// 本文件把这三条逐条钉住，并额外钉住"用户选了不使用"与"选了 Hindsight 但不通"**必须是两种说法**。
//
// ── 口径（本仓纪律）────────────────────────────────────────────────────────
//   · 断言的是**行为**（纯函数输入→输出、真实文件读回），不是实现细节；
//   · 第⑥节是**接线断言**（源码级正则）：纯函数写对了但 `command.js` 没人调用 = 功能没上线，
//     这一节就是防"函数写出来了但没人调用"这个已发生过的缺陷类；
//   · 读不到/跑不了的环境一律**显式跳过并打印原因**，绝不静默算通过。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M166**（`hindsight`/`off` 时不再把
// `- id: hindsight` 那一行恢复成**启用**态 ⇒ 用户切回 `hindsight` 后补丁仍保留禁用：界面说一个后端、
// 文件里编码的是另一个）与 **M172**（**已接线**的 `midas` 档不把 Hindsight 置为禁用 ⇒ 两个后端同时
// 活着、而界面只说了一个 —— 正是二期要修的那个缺陷）。
// 运行：node memory-backend.test.mjs

import { mkdtemp, mkdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MEMORY_BACKENDS, DEFAULT_MEMORY_BACKEND, MEMORY_SETTING_PATH,
  HINDSIGHT_PLUGIN_ROW_ID, HINDSIGHT_PLUGIN_ROW_NAME, DSH_HOME_ENV, DSH_PROFILE_ENV,
  profilePatchPath, planMemoryBackendPatch, readMemoryBackendState, applyMemoryBackend,
  // ── Midas 一期（2026-09-19）新增的出口 ──────────────────────────────────────────────
  MIDAS_PACKAGE, MIDAS_BIN_NAME, MIDAS_BIN_ENV, MIDAS_DB_ENV, MIDAS_NO_WARNINGS_ENV,
  MIDAS_MCP_CLIENT_PACKAGE, MIDAS_PATCH_ROW_ID, MIDAS_SERVER_NAME, MIDAS_STATUS_KINDS,
  MIDAS_INSTALL_COMMAND, midasDbPath, memoryProfileName, midasBinaryCandidates, midasInstallDir,
  midasPatchRowLines, findMidasInsertRow, discoverMidasBinary, probeMidasBinarySync,
  probeMidasStart, classifyMidasReadiness, midasOnboardingSteps, _resetMidasDiscoveryCache,
  // ── ⑪ 「off 之后那一行还在」：纯函数规划器 + 落地动作（2026-09-19）────────────────────
  planMidasRowRemoval, removeMidasRow,
} from './lib/memory-backend.js';
import { SETTINGS_SPEC, defaultSettings, validateValue } from './lib/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
let skipped = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
/** 显式跳过（打印原因）：环境跑不了的断言**不许**静默算通过。 */
const skip = (name, why) => { skipped += 1; console.log(`  ⊘ ${name} — 跳过：${why}`); };

const roots = [];
/** 造一个临时 home（补丁文件按 `home/.dsh/profiles/web/cordis.patch.yml` 布局）。 */
async function makeHome(patchText) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-backend-'));
  roots.push(root);
  const patchPath = join(root, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  if (patchText !== undefined && patchText !== null) {
    await mkdir(dirname(patchPath), { recursive: true });
    await writeFile(patchPath, patchText);
  }
  return { root, patchPath };
}

/** 与用户机器上**逐字相同**的初始内容（事实来源：`~/.dsh/profiles/web/cordis.patch.yml`）。 */
const REAL_PATCH = '# a top-level YAML array of load-overrides, disables, and inserts\n'
  + '- id: ui-workflow-run\n'
  + '  disabled: true\n';

/** 一个极简判定：文本里 hindsight 那一行是否处于禁用态（**与实现无关**，只看文本 —— 这样断言不会
 *  因为实现换了写法而假绿/假红）。它只认顶层 `- id: hindsight` 行下面那一层缩进的 disabled。 */
function hindsightDisabledIn(text) {
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^- id: hindsight\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^- /.test(lines[j])) break;
      if (/^\s*id:/.test(lines[j]) && !/^  /.test(lines[j])) break;
      if (/^\s*disabled:\s*true\s*$/.test(lines[j])) return true;
      if (/^\s*disabled:\s*false\s*$/.test(lines[j])) return false;
    }
  }
  return false;
}

// ── Midas 一期的夹具 ───────────────────────────────────────────────────────────────
// ⚠️ 为什么每个 Midas 用例都**注入发现结果**：状态机的判定必须与"这台机器上恰好装没装
// `midas-mcp`"**无关**。否则同一条断言在开发机上绿、在 CI 上红（或者反过来）—— 那不是测代码，
// 是测宿主。`readMemoryBackendState` / `applyMemoryBackend` 都收 `midas` 这个注入口，正是为此。
/** 「没装」：`probeOk:true` 表示**真的检查过了**（区别于"探测不可用"）。 */
const MIDAS_ABSENT = Object.freeze({
  found: false, path: null, realPath: null, via: null, probeOk: true,
  tried: ['npm-global: /fake/prefix/bin/midas-mcp', 'path: /usr/local/bin/midas-mcp'], notes: [],
});
/** 「装了」：绝对路径 + 包根（`dist/bin/...` 的形状决定 cwd 推导）。 */
const MIDAS_FOUND = Object.freeze({
  found: true, path: '/fake/midas-memory-mcp/dist/bin/midas-mcp.js',
  realPath: '/fake/midas-memory-mcp/dist/bin/midas-mcp.js', via: 'npm-global',
  probeOk: true, tried: [], notes: [],
});
/** 探测不可用：所有存在性检查都失败 ⇒ 调用方**不得**下"没装"的结论。 */
const MIDAS_BLIND = Object.freeze({ found: false, path: null, realPath: null, via: null, probeOk: false, tried: ['npm-global: /x（检查失败）'], notes: [] });

/** 一台"开机即退出"的假子进程（够 `probeMidasStart()` 用它走完失败分支，不真的 spawn 任何东西）。 */
function fakeSpawnExit(stderrText) {
  const handlers = { stdout: [], stderr: [], exit: [], close: [], error: [] };
  const child = {
    stdin: { write() {} },
    stdout: { on: (ev, fn) => handlers.stdout.push(fn) },
    stderr: { on: (ev, fn) => handlers.stderr.push(fn) },
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    kill() {},
  };
  setTimeout(() => {
    for (const fn of handlers.stderr) fn(Buffer.from(String(stderrText || '')));
    for (const fn of handlers.exit) fn(3, null);
    for (const fn of handlers.close) fn(3, null);
  }, 0);
  return child;
}

/** 补丁文本里**内层** `- insert:` 包裹的 mcp-midas 行（与实现无关的极简判定）。 */
const midasRowInText = (text) => /^- insert:\s*$/m.test(String(text)) && /^\s+- id: mcp-midas\s*$/m.test(String(text));
/** 顶层（缩进 0）的 `- id: mcp-midas` —— 那种写法被 dsh **静默跳过**，是"假接通"的形态。 */
const topLevelMidasRowInText = (text) => /^- id: mcp-midas\s*$/m.test(String(text));

console.log('# 记忆后端三选一（hindsight / midas / off）\n');

console.log('① 常量与 spec **不分叉**（值域/默认值/取值路径只有一个家）');
{
  check(MEMORY_BACKENDS.join(',') === 'hindsight,midas,off', '值域恰好三个且顺序固定', MEMORY_BACKENDS.join(','));
  check(Object.isFrozen(MEMORY_BACKENDS), '值域被冻结（防运行期被改）', '');
  const spec = SETTINGS_SPEC.memory && SETTINGS_SPEC.memory.items.backend;
  check(!!spec, '`lib/settings.js` 里有 `memory.backend` 设置项');
  if (spec) {
    check(spec.values.join(',') === MEMORY_BACKENDS.join(','), 'spec 的 values 与 MEMORY_BACKENDS **集合相等**（多一个少一个都红）', spec.values.join(','));
    check(spec.default === DEFAULT_MEMORY_BACKEND, '默认值 = 本功能上线前的行为（hindsight）', String(spec.default));
    check(MEMORY_SETTING_PATH === 'memory.backend', '取值路径与 spec 的 `group.key` 一致', MEMORY_SETTING_PATH);
    for (const v of MEMORY_BACKENDS) {
      check(validateValue(MEMORY_SETTING_PATH, v).ok, `spec 认这个值：${v}`);
      check(typeof (spec.labels || {})[v] === 'string' && spec.labels[v].trim().length > 0, `\`${v}\` 有非空中文标签（下拉里不裸露英文标识）`, (spec.labels || {})[v]);
    }
    check(defaultSettings().memory.backend === DEFAULT_MEMORY_BACKEND, 'defaultSettings() 带上这一组（UI 的分组直接来自 spec）', '');
  }
  check(HINDSIGHT_PLUGIN_ROW_ID === 'hindsight', 'Hindsight 插件行的 id（事实来源：插件自己的 cordis.patch.yml）', HINDSIGHT_PLUGIN_ROW_ID);
  check(HINDSIGHT_PLUGIN_ROW_NAME === '@vectorize-io/hindsight-coding-agents/dsh', '行里的包名（供人核对；dsh 的 load-override 按 id 生效）', '');
}

console.log('\n② profilePatchPath：两级覆写（环境变量优先，其次 home 注入）');
{
  check(profilePatchPath({ env: {}, home: '/tmp/h1' }) === join('/tmp/h1', '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    '默认：<home>/.dsh/profiles/web/cordis.patch.yml', profilePatchPath({ env: {}, home: '/tmp/h1' }));
  check(profilePatchPath({ env: { [DSH_HOME_ENV]: '/tmp/dsh2' }, home: '/tmp/h1' }) === join('/tmp/dsh2', 'profiles', 'web', 'cordis.patch.yml'),
    `${DSH_HOME_ENV} 覆写 dsh home（与 HINDSIGHT_CONFIG 同一惯例）`, profilePatchPath({ env: { [DSH_HOME_ENV]: '/tmp/dsh2' }, home: '/tmp/h1' }));
  check(profilePatchPath({ env: { [DSH_PROFILE_ENV]: 'work' }, home: '/tmp/h1' }) === join('/tmp/h1', '.dsh', 'profiles', 'work', 'cordis.patch.yml'),
    `${DSH_PROFILE_ENV} 覆写 profile 名`, profilePatchPath({ env: { [DSH_PROFILE_ENV]: 'work' }, home: '/tmp/h1' }));
}

console.log('\n③ planMemoryBackendPatch：三种后端 / 最小保真 / 幂等（纯函数，不碰文件系统）');
{
  // ① off：补丁里还没有 hindsight 行 ⇒ 追加一行，**其余内容逐字保留**
  const off = planMemoryBackendPatch(REAL_PATCH, 'off');
  check(off.ok && off.changed, 'off（首次）⇒ ok + changed');
  check(off.text.startsWith(REAL_PATCH), '原有内容**逐字**保留在开头（含注释行）', JSON.stringify(off.text.slice(0, 40)));
  check(hindsightDisabledIn(off.text), '结果里 hindsight 行确实是 `disabled: true`', JSON.stringify(off.text));
  check(!/\n\n- id: hindsight/.test(off.text), '追加时不额外塞空行（最小 diff）', '');

  // ② 幂等：同一目标跑第二次 ⇒ changed:false 且文本逐字不变
  const off2 = planMemoryBackendPatch(off.text, 'off');
  check(off2.ok && off2.changed === false && off2.text === off.text, 'off（第二次）⇒ changed:false 且文本**逐字**不变（幂等）', '');

  // ③ 回到 hindsight：删掉我们那一行 ⇒ 文件**逐字**回到原样（这是"不改无关内容"的最强证据）
  const back = planMemoryBackendPatch(off.text, 'hindsight');
  check(back.ok && back.changed && back.text === REAL_PATCH, 'hindsight ⇒ 删掉本插件追加的那一行，文件逐字回到原样', JSON.stringify(back.text));
  check(planMemoryBackendPatch(REAL_PATCH, 'hindsight').changed === false, 'hindsight（本来就没禁用）⇒ 无改动', '');

  // ④ 已有 `- id: hindsight` 行、但不是我们写的形态 ⇒ 只改那一个值，不整行删
  const foreign = '- id: hindsight\n  disabled: true\n  name: someone-elses-row\n- id: other\n  disabled: true\n';
  const f1 = planMemoryBackendPatch(foreign, 'hindsight');
  check(f1.ok && f1.changed && !hindsightDisabledIn(f1.text), '非规范形态的 disabled:true ⇒ 改成 false（恢复启用）', JSON.stringify(f1.text));
  check(/name: someone-elses-row/.test(f1.text), '同一行的其它键**原样保留**（不整行删 —— 我们不确知它是不是别人写的）', '');
  check(/- id: other\n  disabled: true/.test(f1.text), '别的行（other）一个字都没动', '');
  const f2 = planMemoryBackendPatch(foreign, 'off');
  check(f2.ok && f2.changed === false && f2.text === foreign, 'off（已经是禁用态）⇒ 无改动（幂等）', '');

  // ⑤ 行存在但没有 disabled 键 ⇒ 补上，而不是追加第二行
  const noKey = '- id: hindsight\n  name: x\n';
  const n1 = planMemoryBackendPatch(noKey, 'off');
  check(n1.ok && hindsightDisabledIn(n1.text) && (n1.text.match(/- id: hindsight/g) || []).length === 1,
    '行存在但没有 disabled 键 ⇒ 补一行 `disabled: true`（不制造第二个同名行）', JSON.stringify(n1.text));

  // ⑥ midas：**没接线**时只许把 Hindsight 那一行恢复成启用（绝不许把它留在禁用态）。
  // ⚠️ 这一格的期望在二期（三档都管两行的真二选一）**改写过**：旧写法（"midas ⇒ 清除禁用（本轮未接线）"）
  // 描述的是**一期"只做加法"**的语义。二期的规则是条件性的：`midas` **没接线**（没传 `opts.midas`
  // ⇒ 不会写 MCP 行）时**不许**把 Hindsight 关掉 —— 二进制没找到却顺手关了 Hindsight，用户就
  // **同时失去两个后端**，那是最坏的结果。所以这一格的动作是"恢复启用"而不是"保持禁用"。
  const m1 = planMemoryBackendPatch(off.text, 'midas');
  check(m1.ok && m1.changed && !hindsightDisabledIn(m1.text),
    'midas（**未接线**）⇒ 把 Hindsight 那一行恢复成启用（安全不变量：没有 Midas 可接时绝不许两个后端一起没有）', JSON.stringify(m1.text));
  check(m1.ok && m1.text === REAL_PATCH,
    'midas（未接线）⇒ 删掉的是**本模块自己的规范形态**那一行，文件逐字回到原样（不碰无关内容）', JSON.stringify(m1.text));
  check(m1.text !== null && !midasRowInText(m1.text),
    'midas（未接线）⇒ **不写** MCP 行（写一条指向不存在命令的行 = 假接通），所以这里不可能有 `- insert:` 包裹的 mcp-midas', '');
  // 安全不变量的**幂等面**：本来就"没有禁用"时，这一档一个字都不该动（否则设置页每保存一次就写一次盘）。
  const m1b = planMemoryBackendPatch(REAL_PATCH, 'midas');
  check(m1b.ok && m1b.changed === false && m1b.text === REAL_PATCH,
    'midas（未接线 + 本来就没禁用）⇒ 无改动（幂等，也不假报已保存）', '');

  // ⑥b midas **已接线**（传了 `opts.midas`）= 新语义下"两件一起写"的**健康格**：
  // Hindsight 那一行变 `disabled: true` ∧ `- insert:` 包裹的 mcp-midas 行**在**。
  // 与 ⑥ 合起来才盖住新契约的**条件性**：同一个 `midas` 目标、两种接线状态，结论必须**相反** ——
  // 只钉其中一边就会让另一边（"未接线却把 Hindsight 关了"这个最坏结果）偷偷溜过去。
  const wiredOpts = { midas: { binPath: '/fake/midas-memory-mcp/dist/bin/midas-mcp.js', installDir: '/fake/midas-memory-mcp', dbPath: '/u/.dsh/storages/midas/memory.sqlite3' } };
  const m2 = planMemoryBackendPatch(REAL_PATCH, 'midas', wiredOpts);
  check(m2.ok && m2.changed && hindsightDisabledIn(m2.text),
    'midas（**已接线**）⇒ Hindsight 那一行被写成 `disabled: true`（这一档是**真二选一**，不是加法）', JSON.stringify(m2.text));
  check(m2.text !== null && midasRowInText(m2.text),
    'midas（已接线）⇒ 同时插入 `- insert:` 包裹的 mcp-midas 行（"两件一起写"缺一不可）', '');
  check(m2.text !== null && m2.text.startsWith(REAL_PATCH) && !topLevelMidasRowInText(m2.text),
    'midas（已接线）⇒ 原有内容逐字保留在前，且**不产生**裸顶层行（那种写法 dsh 会静默跳过）', '');
  // 从"已经是禁用态"的补丁出发：已接线这一档**保留**禁用 —— 这正是上面那条"条件性"的判别点。
  const m3 = planMemoryBackendPatch(off.text, 'midas', wiredOpts);
  check(m3.ok && m3.changed && hindsightDisabledIn(m3.text) && midasRowInText(m3.text),
    'midas（已接线）+ 补丁本来已禁用 ⇒ 禁用**保留**、MCP 行插入（"未接线 ⇒ 恢复启用 / 已接线 ⇒ 保留禁用"的判别点）', JSON.stringify(m3.text));

  // ⑦ 嵌套 `insert:` 里的 disabled 属于**内层**，不许被当成顶层那一行的状态
  const nested = '- insert:\n    - id: hindsight\n      disabled: true\n';
  const n2 = planMemoryBackendPatch(nested, 'hindsight');
  check(n2.ok && n2.changed === false, '顶层 `- insert:` 行内层出现的 disabled 不被误判为顶层状态（不为它改写）', '');

  // ⑧ 空文件/空文本 = 空的顶层数组（合法）
  const empty = planMemoryBackendPatch('', 'off');
  check(empty.ok && empty.changed && hindsightDisabledIn(empty.text), '空文件 ⇒ 直接写出那一行（不抛）', JSON.stringify(empty.text));
  check(planMemoryBackendPatch(null, 'off').ok, '`null` 当空文件处理（不抛）', '');

  // ⑨ 非法值 ⇒ 拒绝（不回落默认：把"打错字"变成"悄悄选了另一个后端"是最坏的处理）
  for (const bad of ['', 'HINDSIGHT', 'none', null, 42, {}]) {
    const r = planMemoryBackendPatch(REAL_PATCH, bad);
    check(r.ok === false && r.text === null && r.errors.length > 0, `非法后端 ${JSON.stringify(bad)} ⇒ ok:false 且不产出文本`, r.errors[0] || '');
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// ③b **新排他契约**（二期：三档都是"两行都管"的真二选一）—— 这一节是本次语义变更的**主要证据**。
//
// 为什么值得单独立一节：变更前 `midas` 是**加法**（只插 MCP 行、Hindsight 照旧活着），于是补丁里
// 可以同时躺着两个后端，而设置页只说了一个 —— 那正是用户报的缺陷。新契约要求**每一档都把两行**
// 写到一个确定状态，所以判据必须**两维同时**钉：`- id: hindsight` 的启用位 **×** `- insert:` 包裹的
// mcp-midas 行在不在。只钉其中一维，另一半（"界面说一个、文件里两个"）就会悄悄回来。
//
// 四个格子（与 `planMemoryBackendPatch` 文档里的表逐字对应）：
//   · `hindsight`        ⇒ Hindsight 行**启用** ∧ MCP 行**移除**
//   · `midas` 已接线      ⇒ Hindsight 行**禁用** ∧ MCP 行**在**（新语义下的**健康形态**）
//   · `midas` 未接线      ⇒ Hindsight 行**启用**（安全不变量） ∧ MCP 行**不写**
//   · `off`              ⇒ Hindsight 行**禁用** ∧ MCP 行**移除**
// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n③b 新排他契约：三档都是"两行都管"的真二选一（两维同时钉）');
{
  const cOpts = { midas: { binPath: '/fake/midas-memory-mcp/dist/bin/midas-mcp.js', installDir: '/fake/midas-memory-mcp', dbPath: '/u/.dsh/storages/midas/memory.sqlite3' } };
  const HEAD = '# a top-level YAML array of load-overrides, disables, and inserts\n- id: ui-workflow-run\n  disabled: true\n';
  // 一份"两个后端都在"的起点：Hindsight 被禁用 + MCP 行在。三档各自要把它收敛到自己的目标态。
  const BOTH_LIVE = HEAD + '- id: hindsight\n  disabled: true\n- insert:\n    - id: mcp-midas\n      command: node\n';
  check(hindsightDisabledIn(BOTH_LIVE) && midasRowInText(BOTH_LIVE), '夹具前提成立：起点是"两行都在"（Hindsight 禁用 + MCP 行在）', '');

  // ① `hindsight` ⇒ **移除**那个 `- insert:` 包裹的 mcp-midas 行（真二选一的另一半）
  const t1 = planMemoryBackendPatch(BOTH_LIVE, 'hindsight');
  check(t1.ok && t1.changed && !hindsightDisabledIn(t1.text), '`hindsight` ⇒ Hindsight 行**启用**（不再是禁用态）', JSON.stringify(t1.text));
  check(t1.text !== null && !midasRowInText(t1.text) && !topLevelMidasRowInText(t1.text),
    '`hindsight` ⇒ **移除** `- insert:` 包裹的 mcp-midas 行（含顶层写法一起审 —— 留着就是"文件里还有第二个后端"）', JSON.stringify(t1.text));

  // ② `off` ⇒ 同样**移除**那一行（另一半与 `hindsight` 同形，只有 Hindsight 那一维不同）
  const t2 = planMemoryBackendPatch(BOTH_LIVE, 'off');
  check(t2.ok && t2.changed && hindsightDisabledIn(t2.text), '`off` ⇒ Hindsight 行**禁用**', JSON.stringify(t2.text));
  check(t2.text !== null && !midasRowInText(t2.text) && !topLevelMidasRowInText(t2.text),
    '`off` ⇒ **移除** `- insert:` 包裹的 mcp-midas 行（"关掉记忆"却留着 MCP 行 = 界面说关着、进程照样起来）', JSON.stringify(t2.text));

  // ③ `midas` **已接线** ⇒ 新语义的**健康形态**：Hindsight 禁用 ∧ MCP 行在
  const t3 = planMemoryBackendPatch(HEAD, 'midas', cOpts);
  check(t3.ok && t3.changed && hindsightDisabledIn(t3.text) && midasRowInText(t3.text),
    '`midas`（已接线）⇒ Hindsight 行 `disabled: true` **且** MCP 行在场（这是**健康**形态，不是矛盾）', JSON.stringify(t3.text));

  // ④ `midas` **未接线** ⇒ 安全不变量：Hindsight 行**保持启用**（绝不许两个后端一起没有）
  const t4 = planMemoryBackendPatch(BOTH_LIVE, 'midas');   // 未接线：起点两行都在
  check(t4.ok === false || !hindsightDisabledIn(t4.text || ''),
    '`midas`（**未接线**）⇒ 绝**不**把 Hindsight 留在禁用态（安全不变量：宁可保持 Hindsight 活着，也不许两个后端一起没有）',
    t4.ok ? JSON.stringify(t4.text) : `ok:false（拒绝写入也是可接受的保守结局）：${(t4.errors || [])[0] || ''}`);
  // 未接线 + 起点里**没有** MCP 行 ⇒ 这一档必须**恢复启用**且无副作用（最常见的那条路径）
  const t4b = planMemoryBackendPatch(planMemoryBackendPatch(HEAD, 'off').text, 'midas');
  check(t4b.ok && !hindsightDisabledIn(t4b.text) && !midasRowInText(t4b.text),
    '`midas`（未接线）+ 补丁里只有我们自己那一行 ⇒ Hindsight **恢复启用**、不写 MCP 行', JSON.stringify(t4b.text));

  // ⑤ 幂等：三档各跑两次 ⇒ 第二次 `changed:false` 且文本**逐字**不变（不许每保存一次就写一次盘）
  for (const [name, opts] of [['hindsight', undefined], ['off', undefined], ['midas（已接线）', cOpts]]) {
    const target = name === 'midas（已接线）' ? 'midas' : name;
    const once = planMemoryBackendPatch(HEAD, target, opts);
    const twice = planMemoryBackendPatch(once.text, target, opts);
    check(once.ok && twice.ok && twice.changed === false && twice.text === once.text,
      `幂等：\`${name}\` 跑第二次 ⇒ changed:false 且文本逐字不变`, `changed=${twice.changed}`);
  }

  // ⑥ 出口自检**两维都审**：`hindsight` / `off` 要求"没有 mcp-midas 行"，而**顶层**写法（缩进 0 的
  // load-override，dsh 会静默跳过）**也算**违反契约 ⇒ 必须 ok:false / 一个字节都不落盘。
  // ⚠️ 这条只对"这一档会真的改写文本"的夹具成立 —— `changed:false` 的早退**不经过**自检（见下面
  // ⑦ 那条 TODO 旁边记的审计缺口），所以夹具必须让 Hindsight 那一维**真的**需要改（这里是 `off`：
  // 起点没有禁用行 ⇒ 要追加 ⇒ changed:true ⇒ 自检运行）。
  const topLevelOnly = '- id: mcp-midas\n  name: x\n';
  const t6 = planMemoryBackendPatch(topLevelOnly, 'off');
  check(t6.ok === false && t6.text === null && t6.changed === false,
    '出口自检：`off` + 补丁里只剩**顶层** `- id: mcp-midas` ⇒ **拒绝写入**（顶层写法虽不生效，但"这一档要求没有 MCP 行"这句承诺必须是真的）',
    (t6.errors || [])[0] || '');
  check(/顶层/.test((t6.errors || []).join('')) && /拒绝写入/.test((t6.errors || []).join('')),
    '出口自检的理由**点名**是"顶层写法"那一维（不是一句笼统的失败 —— 否则用户无从下手）', (t6.errors || [])[0] || '');

  // ⑦ `effective`：由 `readMemoryBackendState` 算出的四格（与 `planMemoryBackendPatch` 的目标态对齐）
  const wiredHome = await makeHome(HEAD + '- id: hindsight\n  disabled: true\n- insert:\n    - id: mcp-midas\n      command: node\n');
  const unwiredHome = await makeHome(HEAD);
  const eWired = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: wiredHome.root, midas: MIDAS_FOUND, mcpClientInstalled: true });
  check(eWired.effective === 'midas' && eWired.notWired === false && eWired.statusKind === 'midas-ready',
    '`effective`：midas 已接线（二进制 + MCP 客户端 + 补丁行都在）⇒ 真的在走 midas', `effective=${eWired.effective} kind=${eWired.statusKind}`);
  const eUnwired = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: unwiredHome.root, midas: MIDAS_ABSENT, mcpClientInstalled: false });
  check(eUnwired.effective === 'hindsight' && eUnwired.notWired === true,
    '`effective`：midas 未接线 ⇒ 如实回 hindsight（"选了什么"≠"生效了什么"）', `effective=${eUnwired.effective}`);
  const eOff = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: wiredHome.root });
  check(eOff.effective === 'off' && eOff.hindsightDisabled === true,
    '`effective`：off + 补丁确实禁用 ⇒ off', `effective=${eOff.effective}`);
  const eHs = await readMemoryBackendState({ settings: { memory: { backend: 'hindsight' } }, env: {}, home: unwiredHome.root });
  check(eHs.effective === 'hindsight' && eHs.hindsightDisabled === false,
    '`effective`：hindsight + 补丁没有禁用 ⇒ hindsight', `effective=${eHs.effective}`);

  // ⑧ `consistent`：设置值 vs 补丁事实**是否已对齐**。
  //
  // ── 这一节的历史（必须留着，否则下一个人会把正确的判据"修"回去）────────────────────────
  // 语义变更落地时，这句判据**没跟上**，旧式子是
  //   `stored === 'off' ? hindsightDisabled === true : hindsightDisabled === false`
  // —— 它把"非 `off` 就要求 Hindsight 那一行没被禁用"当成通则（旧语义下对：那时只有 `off` 会去
  // 禁用它）。新语义下落地 `midas` 是**同时**写两件事（插 MCP 行 ∧ 把 Hindsight 行
  // `disabled: true`），于是**配置正确的已接线 Midas 恰恰 `hindsightDisabled === true`** ⇒
  // 健康态被旧式子判成"不一致"（实测：`statusKind='midas-ready'`、`display.level='ok'`、
  // `effective='midas'` 全是健康值，而 `consistent` 回 `false`）。
  // 那次**故意没有**写断言替缺陷背书（本仓纪律：绝不写与实现相反 / 给缺陷发绿卡的断言），
  // 只留了一条类型断言 + TODO。生产代码随后**已修**（判据按 `stored` 分档，见 `lib/memory-backend.js`
  // 里 `consistent` 那一段的摘要表）⇒ 下面把它按**正确行为**钉住：这正是"先报告、不背书、
  // 修好再补断言"这条纪律收尾的样子。
  check(eWired.effective === 'midas' && eWired.hindsightDisabled === true && eWired.consistent === true,
    '`consistent`：midas 已接线 + Hindsight 确实被禁用 ⇒ **true**（这一格是健康态，不许被判成不一致 —— 旧式子在这里回 false）',
    `consistent=${eWired.consistent}（期望 true）hd=${eWired.hindsightDisabled} eff=${eWired.effective}`);
  // 与 `conflict` 那一档对照：`hindsight` + 行被禁用 ⇒ 不一致（这条一直对，留着防"把判据改成恒真"）。
  const eConflictHome = await makeHome(HEAD + '- id: hindsight\n  disabled: true\n');
  const eConflict = await readMemoryBackendState({ settings: { memory: { backend: 'hindsight' } }, env: {}, home: eConflictHome.root });
  check(eConflict.statusKind === 'conflict' && eConflict.consistent === false,
    '`consistent`：hindsight + 补丁把那一行禁用了 ⇒ **false**（`conflict` 那一档，两者必须同时成立）',
    `consistent=${eConflict.consistent} kind=${eConflict.statusKind}`);
  // `off` 未落地 ⇒ 不一致（判据的**另一头**，与上面那条一起说明它不是恒真/恒假）。
  const eOffNotApplied = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: unwiredHome.root });
  check(eOffNotApplied.consistent === false && eOffNotApplied.statusKind === 'off-not-applied',
    '`consistent`：off + 补丁还没禁用 ⇒ **false**（与上面两条合起来钉住"取值随事实变"，不是常量）',
    `consistent=${eOffNotApplied.consistent} kind=${eOffNotApplied.statusKind}`);
  // ⑨ `midas` **未接线**的两格（F/G）—— 判据在这里**刻意不看** Hindsight 那一行。
  // 先说这段的历史，因为它差点变成一条"替未定决策背书"的断言：判据第一次修好时**注释**说 G 格该是
  // `true`（理由：未接线时问"该不该禁用"仍回答"该"，只是我们**不代用户动手**），而当时的**代码**
  // `(stored === 'off' || (stored === 'midas' && !notWired))` 把未接线归进 else 支 ⇒ 要求
  // `hindsightDisabled === false` ⇒ 实测回 `false`（**注释与代码互相矛盾**）。
  // 那一刻按纪律**没有**写任一边的断言 —— 写了就是替未定的产品决策发绿卡。生产代码随后把这个决策
  // **定下来了**：未接线 ⇒ 该 flag 恒 `true`（"Midas 没接上"这一件事实只有一个家 `notWired`，
  // `effective` 与 `consistent` 在它上面**结构对齐**）。所以下面按**已经定下来的行为**钉两格。
  const eUnwiredEnabledHome = unwiredHome;                                   // Hindsight 行**没**被禁用
  const eUnwiredEnabled = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: eUnwiredEnabledHome.root, midas: MIDAS_ABSENT, mcpClientInstalled: false });
  const eUnwiredDisabledHome = await makeHome(HEAD + '- id: hindsight\n  disabled: true\n');   // 行**被**禁用
  const eUnwiredDisabled = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: eUnwiredDisabledHome.root, midas: MIDAS_ABSENT, mcpClientInstalled: false });
  check(eUnwiredEnabled.notWired === true && eUnwiredEnabled.hindsightDisabled === false && eUnwiredEnabled.consistent === true,
    '`consistent`：midas **未接线** + Hindsight 行启用 ⇒ **true**（未接线这一格判据不看那一行：我们既不写 MCP 行、也不代用户关 Hindsight）',
    `consistent=${eUnwiredEnabled.consistent} hd=${eUnwiredEnabled.hindsightDisabled}`);
  check(eUnwiredDisabled.notWired === true && eUnwiredDisabled.hindsightDisabled === true && eUnwiredDisabled.consistent === true,
    '`consistent`：midas **未接线** + Hindsight 行被禁用 ⇒ **true**（两格同值 —— 这一档的判据**刻意不看**那一行，`notWired` 才是判据）',
    `consistent=${eUnwiredDisabled.consistent} hd=${eUnwiredDisabled.hindsightDisabled}`);
  // ⚠️ 这条是上面两格的**判别力来源**：若有人把判据改回"看那一行"，这两格会变成 `true`/`false`
  // 而本条恒真 —— 所以必须同时断言"两格同值"，光钉其中一格抓不住"判据又依赖上那一行了"。
  check(eUnwiredEnabled.consistent === eUnwiredDisabled.consistent,
    '反空转：未接线两格（行启用 / 行禁用）的 `consistent` **必须同值** —— 不同值就说明判据又偷偷依赖上 Hindsight 那一行了',
    `${eUnwiredEnabled.consistent} vs ${eUnwiredDisabled.consistent}`);
  // 另有意的**不对称**（不是 bug，写清楚免得后人"修"掉）：`consistent` 不再恒等于 `level === 'ok'` ——
  // F/G 两格都是 `warn`（Midas 确实没装、该告警）而本 flag 回 `true`。告警归 `level`，一致性归本 flag。
  check(eUnwiredEnabled.consistent === true && eUnwiredEnabled.display.level === 'warn',
    '有意的不对称：未接线这一格 `consistent:true` 而 `display.level:"warn"` —— 「设置与文件是否对齐」与「这件事健不健康」是两个问题，不许合并',
    `consistent=${eUnwiredEnabled.consistent} level=${eUnwiredEnabled.display.level}`);
}

console.log('\n④ 拒绝看不懂的形态（宁可不写，也不猜着合并）');
{
  const cases = [
    ['顶层不是数组（`id: x` 顶格）', 'id: hindsight\ndisabled: true\n'],
    ['流式 YAML（`- {id: x}`）', '- {id: hindsight, disabled: true}\n'],
    ['缩进内容没有归属的顶层项', '  id: hindsight\n'],
    ['disabled 写法不认识（`disabled: yes` —— YAML 1.1 的另一种真值）', '- id: hindsight\n  disabled: yes\n'],
  ];
  for (const [name, text] of cases) {
    const r = planMemoryBackendPatch(text, 'off');
    check(r.ok === false && r.text === null, `拒绝：${name}`, (r.errors[0] || '').slice(0, 60));
  }
}

console.log('\n⑤ readMemoryBackendState：设置值 vs **实际生效状态**（两者必须分得开，且绝不抛）');
{
  // ① 设置 off + 文件确实禁用 ⇒ 一致
  const a = await makeHome(REAL_PATCH);
  const s1 = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: a.root });
  check(s1.ok && s1.hindsightDisabled === false && s1.effective === 'hindsight', '读到真实文件：此刻 Hindsight 并没有被禁用（effective=hindsight）', `effective=${s1.effective}`);
  check(s1.statusKind === 'off-not-applied' && s1.consistent === false, '设置=off 但文件没禁用 ⇒ 如实报「off-not-applied / 不一致」（不假报已关闭）', s1.statusKind);
  check(/不使用/.test(s1.display.zh) && /还没有/.test(s1.display.zh), '文案点明"你选了不使用、但补丁还没落地"', s1.display.zh.slice(0, 40));
  check(/\bopen\b|Off|off/.test(s1.display.en) || /does NOT/.test(s1.display.en), '英文文案同样如实（跟语言一起给）', s1.display.en.slice(0, 40));

  // ② 落地之后再读 ⇒ 一致
  const b = await makeHome(REAL_PATCH);
  await applyMemoryBackend({ backend: 'off', env: {}, home: b.root });
  const s2 = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: b.root });
  check(s2.hindsightDisabled === true && s2.effective === 'off' && s2.consistent === true && s2.statusKind === 'off',
    '写入后回读：确实禁用了、设置与实际一致、statusKind=off', s2.statusKind);

  // ③ 设置 hindsight 但文件被（别人）禁用了 ⇒ 必须报冲突，而不是"已启用"
  const c = await makeHome('- id: hindsight\n  disabled: true\n');
  const s3 = await readMemoryBackendState({ settings: { memory: { backend: 'hindsight' } }, env: {}, home: c.root });
  check(s3.statusKind === 'conflict' && s3.display.level === 'bad', '设置=hindsight + 文件禁用 ⇒ 报「conflict」（以文件为准，绝不假报已启用）', s3.statusKind);

  // ④ midas ⇒ 五态之一（**不许**说成生效）。发现结果**注入**（见夹具注释：判定不许与宿主装没装有关）。
  const s4 = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: a.root, midas: MIDAS_ABSENT, mcpClientInstalled: false });
  check(s4.notWired === true && s4.statusKind === 'midas-not-installed', 'midas + 二进制缺失 ⇒ midas-not-installed + notWired:true（不静默 no-op）', s4.statusKind);
  check(/未接通/.test(s4.display.zh) && /Hindsight/.test(s4.display.zh) && /token/.test(s4.display.zh),
    '文案说明"未接通、实际仍走 Hindsight、仍按 token 计费"（一句实话都不能少）', s4.display.zh.slice(0, 40));
  // 新增（覆盖缺口）：Midas **没就绪**时，`effective` 必须如实回 `hindsight` —— 那几档文案自己就
  // 写着"记忆此刻仍走 Hindsight"，`effective` 与它必须说同一件事（`stored` 才是"选了什么"）。
  check(s4.effective === 'hindsight',
    'midas 未就绪（二进制缺失）⇒ effective=hindsight（"选了什么"≠"生效了什么"）', `effective=${s4.effective}`);

  // ④b `stored=midas` **且 Hindsight 那一行被禁用**：`effective` 仍必须是 `hindsight` —— 用户根本不在
  // Hindsight 上，所以"那一行被禁用"这件事不改变"此刻真正在走哪个后端"；Midas 未接通 ⇒ 记忆走的仍是
  // Hindsight。（旧实现在这一格回 `'off'`，而同一个对象里的文案写着"仍走 Hindsight" ⇒ 自相矛盾。）
  //
  // ⚠️ 二期语义变更后，这一格的**性质**变了，注释必须跟着改（旧注释把它叫"镜像格 / 自相矛盾的那种
  // 组合"，那在一期是对的，在二期是**错的**）：现在 `{Hindsight 行被禁用} × {mcp-midas 行在}` 恰恰是
  // `stored=midas` **已接线**时的**健康形态**（`planMemoryBackendPatch` 的 `midas` 档就是"两件一起写"）。
  // 所以"Hindsight 行被禁用"不再是异常组合 —— 它只是**另一维**的事实（`hindsightDisabled` 回答），
  // 与 `effective`（此刻真的在走谁）是两层语义。这里保留的**缺陷**是它当年真正抓的那一条：
  // **`effective` 不许回 `off`** —— 用户选的是 Midas，而 Midas 未接通 ⇒ 走的是 Hindsight，
  // 说"关着"就是假话。这条纪律与新语义**不冲突**，且比以往更要紧。
  // ⚠️ `s4` 用的 `a.root` 是 REAL_PATCH（**没有**禁用 Hindsight 行）⇒ 覆盖不到这一格，这也是它
  // 一直没被发现的原因；这里必须另造一份"hindsight 行 disabled: true"的补丁夹具。
  const s4bHome = await makeHome('- id: ui-workflow-run\n  disabled: true\n- id: hindsight\n  disabled: true\n');
  const s4b = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: s4bHome.root, midas: MIDAS_ABSENT, mcpClientInstalled: false });
  check(s4b.hindsightDisabled === true && s4b.statusKind === 'midas-not-installed' && s4b.notWired === true,
    '前提成立：stored=midas + 二进制缺失 + **Hindsight 行确实被禁用** ⇒ midas-not-installed / notWired:true',
    `hindsightDisabled=${s4b.hindsightDisabled} statusKind=${s4b.statusKind}`);
  check(s4b.effective === 'hindsight',
    'midas 未就绪 **且 Hindsight 行被禁用** ⇒ effective 仍是 hindsight（**绝不是 off**：用户不在 Hindsight 上，那一行禁不禁用改变不了此刻走的是谁）',
    `effective=${s4b.effective}`);
  check(s4b.effective === 'hindsight' && /仍走 Hindsight/.test(s4b.display.zh),
    '同一对象内**不自相矛盾**：effective=hindsight 与 display 的"记忆仍走 Hindsight"必须是同一句话（有一边漂移就红）',
    `effective=${s4b.effective} display=${s4b.display.zh.slice(0, 34)}`);

  // ④c 第 8 格：**盲探**（`probeOk:false` —— 探测本身不可用 ⇒ 五态走 `unknown`）+ Hindsight 行被禁用。
  // 为什么要单独立一条：它与 ④b 走**同一条**新分支（`notWired === true` ⇒ `hindsight`），但
  // **触发条件不同** —— ④b 是"确定没装"（`probeOk:true` + `found:false`），这一格是"**不知道**装没装"。
  // 而"两种零必须分得开"正是本轮反复出问题的地方（`probeOk:false` 不许被读成"没装"），
  // "探测不可用"这一档最容易在后续重构里被漏掉、或被 else 分支顺手判成 `off`。把这条纪律钉住：
  // **「无法判断就绪」≠「记忆已关」** ⇒ `effective` 绝不回 `off`。
  // 一致性判据与 ④b 同形：这一格的文案**也**写着"⇒ 这里不给结论。**记忆仍走 Hindsight**（仍按 token
  // 计费）"—— 所以 `effective === 'hindsight'` 正是同一句话，两边必须一起成立（有一边漂移就红）。
  const s4c = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: s4bHome.root, midas: MIDAS_BLIND, mcpClientInstalled: false });
  // 注：这一格 `midasSetup` **不为 null**（用户选了 midas 就有引导，与就绪与否无关）—— 它带
  // `ready === false`，即"引导给到位、结论不下"。别把它写成 null（那是**没选** midas 才有的形状）。
  check(s4c.hindsightDisabled === true && s4c.statusKind === 'unknown' && s4c.notWired === true
    && s4c.midasSetup && s4c.midasSetup.ready === false,
    '第 8 格前提成立：stored=midas + **盲探**（探测不可用）+ Hindsight 行被禁用 ⇒ unknown / notWired:true（不给结论，但引导照给）',
    `hindsightDisabled=${s4c.hindsightDisabled} statusKind=${s4c.statusKind} midasSetup.ready=${s4c.midasSetup && s4c.midasSetup.ready}`);
  check(s4c.effective === 'hindsight',
    'midas 盲探（探测不可用）+ Hindsight 行被禁用 ⇒ effective 仍是 hindsight —— 「无法判断就绪」**不等于**「记忆已关」（绝不回 off）',
    `effective=${s4c.effective} statusKind=${s4c.statusKind}`);
  check(s4c.effective === 'hindsight' && /仍走 Hindsight/.test(s4c.display.zh) && !/已关闭/.test(s4c.display.zh),
    '第 8 格同一对象内**不自相矛盾**：effective=hindsight 与 display 的"记忆仍走 Hindsight"是同一句话，且**不许**出现"已关闭"（三边任一处漂移就红）',
    `effective=${s4c.effective} display=${s4c.display.zh.slice(0, 34)}`);

  // ⑤ "选了 Hindsight 但不通" 与 "选了不使用" **必须是两种说法**（这就是本模块存在的理由之一）
  const s5 = await readMemoryBackendState({ settings: { memory: { backend: 'hindsight' } }, env: {}, home: a.root, hindsight: { exists: false, failing: false } });
  check(s5.statusKind === 'on-unconfigured', 'hindsight + 找不到配置文件 ⇒ on-unconfigured', s5.statusKind);
  const s6 = await readMemoryBackendState({ settings: { memory: { backend: 'hindsight' } }, env: {}, home: a.root, hindsight: { exists: true, failing: true } });
  check(s6.statusKind === 'on-failing' && s6.display.level === 'bad', 'hindsight + 有未恢复的失败 ⇒ on-failing（这是故障，不是"你没开"）', s6.statusKind);
  check(s1.statusKind !== s6.statusKind && s1.display.zh !== s6.display.zh, '「不使用」与「Hindsight 不通」的 kind 与文案都不同（不许渲染成同一件事）', `${s1.statusKind} vs ${s6.statusKind}`);
  const s7 = await readMemoryBackendState({ settings: { memory: { backend: 'hindsight' } }, env: {}, home: a.root, hindsight: { exists: true, failing: false } });
  check(s7.statusKind === 'on' && s7.display.level === 'ok', 'hindsight + 诊断正常 ⇒ on（ok）', s7.statusKind);

  // ⑥ 读不到文件 ⇒ fail-open（不抛、也不把"读不到"说成"没禁用"）
  const missing = await readMemoryBackendState({ settings: {}, env: {}, home: join(a.root, 'no-such-home') });
  check(missing.ok === true && missing.patchReadable === false && missing.patchExists === false, '补丁文件缺失 ⇒ 不抛，patchReadable:false');
  check(missing.notes.some((n) => /读不到/.test(n) && /两件事/.test(n)), '并且如实说明"读不到 ≠ 没有禁用"', '');
  check(missing.stored === DEFAULT_MEMORY_BACKEND, '设置缺失 ⇒ 取 spec 默认（不抛）', missing.stored);

  // ⑦ 磁盘上被手改坏的设置值 ⇒ 按默认处理并说明
  const s8 = await readMemoryBackendState({ settings: { memory: { backend: 'nope' } }, env: {}, home: a.root });
  check(s8.stored === DEFAULT_MEMORY_BACKEND && s8.notes.some((n) => /非法/.test(n)), '设置值非法 ⇒ 按默认 + 如实说明', s8.stored);

  // ⑧ 状态对象里绝不带文件内容/机密
  const secretHome = await makeHome('- id: other\n  apiToken: sk-SUPER-SECRET-TOKEN\n');
  const s9 = await readMemoryBackendState({ settings: {}, env: {}, home: secretHome.root });
  check(!JSON.stringify(s9).includes('SUPER-SECRET'), '状态对象不回显文件内容（机密不外泄）', '');
}

console.log('\n⑥ applyMemoryBackend：真写盘（受控入口）/ 幂等 / 回执不含机密 / 重启语义');
{
  const a = await makeHome(REAL_PATCH);
  const r1 = await applyMemoryBackend({ backend: 'off', env: {}, home: a.root });
  check(r1.ok && r1.changed && r1.saved, 'off ⇒ 真的写了（saved:true）', JSON.stringify({ changed: r1.changed, saved: r1.saved }));
  check(r1.needsRestart === true && /重启/.test(r1.restartReason), '改动 ⇒ needsRestart:true + 原因（profile 在加载时读）', r1.restartReason);
  const onDisk = await readFile(a.patchPath, 'utf8');
  check(hindsightDisabledIn(onDisk), '盘上的文件确实禁用了 Hindsight', '');
  check(onDisk.startsWith(REAL_PATCH), '盘上文件仍逐字保留原有内容', '');
  check(!JSON.stringify(r1).includes('SUPER-SECRET'), '回执不含机密', '');

  const r2 = await applyMemoryBackend({ backend: 'off', env: {}, home: a.root });
  check(r2.ok && r2.changed === false && r2.saved === false && r2.needsRestart === false,
    '第二次 off ⇒ changed:false / saved:false / needsRestart:false（不假报保存、也不假称要重启）', JSON.stringify({ changed: r2.changed, saved: r2.saved, needsRestart: r2.needsRestart }));
  check((await readFile(a.patchPath, 'utf8')) === onDisk, '第二次调用没有改写文件（幂等）', '');

  const r3 = await applyMemoryBackend({ backend: 'hindsight', env: {}, home: a.root });
  check(r3.ok && r3.saved && (await readFile(a.patchPath, 'utf8')) === REAL_PATCH, 'hindsight ⇒ 恢复原样（逐字）', '');

  // midas 但**二进制没找到** ⇒ 那一行不写（写一条指向不存在命令的行 = 假接通），且如实说"未接通"。
  // 发现结果注入（宿主上装没装 midas 不许影响这条断言）。
  const r4 = await applyMemoryBackend({ backend: 'midas', env: {}, home: a.root, midas: MIDAS_ABSENT });
  check(r4.ok && r4.notWired === true && r4.saved === false, 'midas（二进制缺失）⇒ 不改补丁 + notWired:true', JSON.stringify({ saved: r4.saved, notWired: r4.notWired }));
  check((r4.notes || []).some((n) => /未接通/.test(n) && /Hindsight/.test(n)), 'midas 的 notes 明说"未接通、实际仍走 Hindsight"', '');
  check((r4.notes || []).some((n) => /mcp-midas/.test(n) && /没有.*插入|没找到/.test(n)), 'midas 的 notes 写明"那一行没有插入 + 为什么"（不让人以为已经换过去了）', '');
  check((await readFile(a.patchPath, 'utf8')) === REAL_PATCH, 'midas（二进制缺失）⇒ 盘上补丁一个字节都没动', '');

  const r5 = await applyMemoryBackend({ backend: 'nope', env: {}, home: a.root });
  check(r5.ok === false && r5.status === 400 && /hindsight \/ midas \/ off/.test(r5.errors.join('')), '非法值 ⇒ 400 且**未写盘**', r5.errors[0]);

  // 拒绝形态的文件：**一个字节都不落盘**
  const bad = await makeHome('id: x\ndisabled: true\n');
  const r6 = await applyMemoryBackend({ backend: 'off', env: {}, home: bad.root });
  check(r6.ok === false && r6.status === 400, '形态不认识的文件 ⇒ 400 拒绝写', String(r6.status));
  check((await readFile(bad.patchPath, 'utf8')) === 'id: x\ndisabled: true\n', '被拒绝时原文件一个字节都没动', '');

  // 无机密泄漏：补丁里夹着一个看起来像 token 的字段 ⇒ 它必须**既被保留、又不进回执**
  const secret = await makeHome('- id: other\n  apiToken: sk-SUPER-SECRET-TOKEN\n');
  const r7 = await applyMemoryBackend({ backend: 'off', env: {}, home: secret.root });
  check(r7.ok && r7.saved, '夹着未知字段的补丁也能正常追加', '');
  const after = await readFile(secret.patchPath, 'utf8');
  check(after.includes('sk-SUPER-SECRET-TOKEN'), '未知字段（含可能的机密）**原样保留**在文件里', '');
  check(!JSON.stringify(r7).includes('SUPER-SECRET'), '回执里**没有**那个机密（按构造不含文件内容）', '');
  check(!JSON.stringify(r7).includes('- id: other'), '回执里也没有回显文件正文', '');

  // 「上次没改但这次改了」与「这次没改」的区分靠 changed，不靠猜测
  const r8 = await applyMemoryBackend({ backend: 'hindsight', env: {}, home: secret.root });
  check(r8.ok && r8.saved && r8.needsRestart, '真的有改动时才 needsRestart:true', JSON.stringify({ changed: r8.changed, needsRestart: r8.needsRestart }));
}

console.log('\n⑦ 接线断言（源码级）：路由存在 / GET+POST / 真的被调用 / 受控入口 / 未接通话术随包发布');
{
  const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
  const modSrc = await readFile(join(here, 'lib', 'memory-backend.js'), 'utf8');
  const cliSrc = await readFile(join(here, 'client.js'), 'utf8');
  const setSrc = await readFile(join(here, 'lib', 'settings.js'), 'utf8');

  check(/\/plugins\/dsh-expert-team\/memory-backend/.test(cmdSrc), '`lib/command.js` 里有这条路由（函数写对了但没人挂 = 功能没上线）', '');
  const routeAt = cmdSrc.indexOf("path: '/plugins/dsh-expert-team/memory-backend'");
  const routeBlock = routeAt < 0 ? '' : cmdSrc.slice(routeAt, routeAt + 400);
  check(routeAt >= 0 && /methods: \['GET', 'POST'\]/.test(routeBlock), '路由声明了 GET + POST（守卫据此校验）', '');
  check(/const out = await applyMemoryBackend\(\{ backend/.test(cmdSrc), 'POST 分支**真的调用** applyMemoryBackend（不是只 import）', '');
  check(/readMemoryBackendState\(\{ settings: currentSettings\(\)/.test(cmdSrc), 'GET 分支用**当前设置**读实际状态（这就是 `memory.backend` 的真实消费者）', '');
  check(/persistSettingsPatch\(\{ 'memory\.backend': out\.backend \}\)/.test(cmdSrc), '选中的值经**同一份**设置写入实现落盘（宿主 + 文件两处存储，不另抄一遍）', '');
  check(/MEMORY_BACKENDS/.test(cmdSrc), '路由把值域的真源（`MEMORY_BACKENDS`）带出来，不在路由里另写一份', '');

  // 受控写入口：模块**只** import `writeHostStateFileAtomic`，且不出现任何直写调用
  const withoutComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const modCode = withoutComments(modSrc);
  check(/import\s*\{[^}]*writeHostStateFileAtomic[^}]*\}\s*from\s*'\.\/host-state-file\.js'/.test(modCode), '补丁写入委派给唯一的受控入口 `writeHostStateFileAtomic`', '');
  check(!/\bwriteFile\s*\(/.test(modCode) && !/\bappendFile\s*\(/.test(modCode) && !/\brename\s*\(/.test(modCode),
    '模块里**没有**任何直写调用（写绕过棘轮：豁免面只有两个文件，这里是第三个就红）', '');
  check(!/\bwriteFile\s*\(/.test(withoutComments(cliSrc)), 'client.js 里也没有直写调用', '');

  check(/未接通/.test(withoutComments(modSrc)) && /未接通/.test(withoutComments(setSrc)),
    '「本轮未接通」这句实话**随包发布**（在 lib 的生产代码里，不只是测试里）', '');
  check(/memory-backend/.test(cliSrc), '客户端用的是这条专用路由（不是拿 /settings 去糊）', '');
  check(/memory-backend/.test(cliSrc) && /needsRestart/.test(cliSrc), '客户端会读回执里的 needsRestart（重启要求由那条路由给）', '');
  check(/'memory\.backend'/.test(withoutComments(cliSrc)) || /'memory\.backend'/.test(cliSrc), '客户端认得 `memory.backend` 这个键（改它要走专用路由 + 显示重启要求）', '');
  check(/重启 dsh web|restart dsh web/.test(cliSrc), '客户端界面上能出现"需重启 dsh web"的提示（不藏着重启要求）', '');

  const settingsRouteAt = cmdSrc.indexOf("path: '/plugins/dsh-expert-team/settings'");
  const tail = settingsRouteAt < 0 ? '' : cmdSrc.slice(settingsRouteAt, settingsRouteAt + 4200);
  check(/memory\.backend/.test(tail) && /只存值/.test(tail), '`/settings` 路由里点明 `memory.backend` 只存值、要去专用路由（不留一句笼统的"无需重启"）', '');

  // ── ⑦b 三选一**界面本身**的接线（2026-09-17 补：独立的只读核验发现这块 UI 零断言覆盖）──────
  // 为什么必须查源码结构而不是"函数存在"：`MemoryBackendBlock` 是本轮最要紧的一块 UI，
  // "定义了但没人渲染"、"渲染在诊断块之外"、"两个分支只渲染了一个"都是**看不出来**的缺陷
  // （纯函数测试全绿、`node --check` 全绿）。所以这里查三件事：**被渲染** / **在 HindsightBlock 内
  // 且两个分支都是"组标题 → 三选一 → 诊断"这个顺序** / **候选值来自服务端而不是客户端硬编一份值域**。
  {
    check(/h\(MemoryBackendBlock[,)]/.test(cliSrc), '三选一组件**真的被渲染**（不是只定义了函数）', '');
    const hsStart = cliSrc.indexOf('function HindsightBlock(props) {');
    const hsEnd = hsStart < 0 ? -1 : cliSrc.indexOf('\n    function ', hsStart + 1);
    const hsBody = (hsStart < 0 || hsEnd < 0) ? '' : cliSrc.slice(hsStart, hsEnd);
    check(hsBody.length > 0, '能切出 `HindsightBlock` 的函数体（反空转：切不出来就必须红，不许静默通过）', `len=${hsBody.length}`);
    const sites = [];
    for (let at = hsBody.indexOf('h(MemoryBackendBlock, '); at >= 0; at = hsBody.indexOf('h(MemoryBackendBlock, ', at + 1)) sites.push(at);
    check(sites.length === 2, '两个分支各渲染一次（`!d` 的加载分支 + 主分支 —— 诊断读不到时**仍然**能选后端）', `命中 ${sites.length} 次`);
    if (sites.length === 2) {
      const heading = '记忆后端（Hindsight）· 诊断与配置';
      const head = hsBody.slice(0, sites[0]);              // …→ 加载分支的组标题 → 第一次渲染
      const mid = hsBody.slice(sites[0], sites[1]);        // 加载分支的收尾 + 主分支的组标题 → 第二次渲染
      const tailBlock = hsBody.slice(sites[1]);            // 第二次渲染 → 之后
      check(head.includes(heading), '加载分支：组标题 → 三选一（摆在最前面）', '');
      check(mid.includes(heading), '主分支：组标题在三选一**之前**', '');
      check(mid.includes('正在读取记忆后端配置'), '加载分支：三选一 → 说明文案（顺序正确）', '');
      check(/h\(MemoryBackendBlock, [^\n]*\),\s*\n\s*rows,/.test(tailBlock),
        '主分支：三选一 → 诊断 rows（**顺序**断言，不是只查"两样都在文件里"）', '');
    } else {
      check(false, '两个分支的渲染顺序断言（因为上面没命中 2 处渲染，这一节无法成立）', '');
    }
    // 候选值/标签/初值都来自服务端 ⇒ 客户端值域不可能与 `MEMORY_BACKENDS` 分叉。
    check(/st\.backends && st\.backends\.length\) \? st\.backends/.test(cliSrc), '候选值首选服务端给的 `st.backends`（不在客户端硬编一份值域）', '');
    check(/var cur = String\(st\.stored/.test(cliSrc), '控件初值取服务端回报的 `stored`（不是客户端自己猜的）', '');
    check(/\(labels\[v\] \|\| v\)/.test(cliSrc), '选项文本用服务端的中文标签，缺标签退回裸值（不留空白）', '');
    const mValues = /var values = [^\n]*\[([^\]]*)\]/.exec(cliSrc);
    const fbVals = mValues
      ? mValues[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '').replace(/^"|"$/g, '')).filter(Boolean)
      : [];
    check(fbVals.join(',') === MEMORY_BACKENDS.join(','),
      '客户端那份**兜底**值域与 `MEMORY_BACKENDS` 集合相等（服务端没给值域时的降级路径也不许分叉）', fbVals.join(','));
  }
}

// ── ⑦c 三选一的**版式**与**重启提示**（2026-09-17 真机两处 UI 缺陷的护栏）──────────────────
// ⚠️ 同一张截图里的**第三处** —— 「实际状态」行的**文字色**被当成告警**框**渲染 —— 不在这一节，
//    而在下面的 ⑦d（它的失败形态与这两处不同：不是"位置/宽度不对"，而是"一个类名担了两种用途"）。
// 为什么必须有这一节：这两处都是**纯样式/纯排版**的缺陷 —— 组件在、`h()` 在、`node --check` 绿、
// 上面的接线断言全绿（M167 只保证"主分支里还渲染着三选一"），而用户看到的是"下拉被拉到 620px"
// 与"重启提示在最下面、看不到"。真机截图给的两条事实：
//   ① 下拉被共享的 `flex:1` 拉满整行，标签列 104px 与下方键列 152px 不对齐；
//   ② 重启要求只印在最底下那行绿色回执里 ⇒ 改完一屏之内看不到。
// 这里钉住的是**结构与样式表**（"片段还在文件里"抓不住这两类缺陷），并刻意查两条"假阴性守卫"：
// 告警框必须有条件渲染、且每次改动前先清空 —— 否则会变成一块永远挂着的常驻告示（另一种不诚实）。
console.log('\n⑦c 三选一的版式与重启提示（源码级 + 样式表级）');
{
  const cliSrc = await readFile(join(here, 'client.js'), 'utf8');
  const mbStart = cliSrc.indexOf('function MemoryBackendBlock(props) {');
  const mbEnd = mbStart < 0 ? -1 : cliSrc.indexOf('\n    function ', mbStart + 1);
  const mbBody = (mbStart < 0 || mbEnd < 0) ? '' : cliSrc.slice(mbStart, mbEnd);
  check(mbBody.length > 0, '能切出 `MemoryBackendBlock` 的函数体（反空转：切不出来必须红，不许静默通过）', `len=${mbBody.length}`);

  // ① 重启提示的**形态**：复用本块既有的琥珀色重条 + 加粗标题 + `role=status`（读屏/自动化可见）
  check(/className: 'exp-hs-warn exp-hs-restart', role: 'status'/.test(mbBody),
    '重启提示渲染成 `.exp-hs-warn.exp-hs-restart` 且带 `role: status`（复用既有告警视觉，不新造一套）', '');
  check(/h\('div', \{ className: 'exp-hs-restart-h' \}/.test(mbBody),
    '告警框有加粗标题那一行（第一眼读到的是"要不要重启"，而不是一段解释性长句）', '');
  // 标题文案必须**只有一处**来源：渲染处只取分段，不许把整句在渲染处再抄一遍。
  // ⚠️ 注意范围：这句话在 client.js 里**不止一处** —— 另外两处是**别的代码路径**在说同一件事实
  // （设置页 head 里那句长说明、Hindsight 配置表单改 serverMode/apiUrl 后的回执，见 `submit()`），
  // 两者各自成立、不是本次要防的重复。所以这里只查**这条回执链**（分段函数 + 三选一的渲染处）。
  const mpStart = cliSrc.indexOf('function memoryBackendParts(d) {');
  const mpEnd = mpStart < 0 ? -1 : cliSrc.indexOf('\n    function ', mpStart + 1);
  const mpBody = (mpStart < 0 || mpEnd < 0) ? '' : cliSrc.slice(mpStart, mpEnd);
  check(mpBody.length > 0, '能切出 `memoryBackendParts` 的函数体（反空转：切不出来必须红）', `len=${mpBody.length}`);
  const headInPath = ((mpBody + mbBody).match(/需重启 dsh web 才生效/g) || []).length;
  check(headInPath === 1, '「需重启 dsh web 才生效」在**这条回执链**里只有一处（渲染处不重复这句）', `命中 ${headInPath}`);
  check(/function memoryBackendMsg\(d\) \{\s*\n?\s*var p = memoryBackendParts\(d\)/.test(cliSrc),
    '`memoryBackendMsg` 由分段函数拼出（对外输出与拆分前逐字相同，不是第二份实现）', '');
  check(/esc\('⚠ ' \+ receipt\.restartHead\)/.test(mbBody),
    '标题直接取分段回执的 `restartHead`（渲染处不另写一句同义的话）', '');

  // ② 必须是**有条件**的：判据是"这一轮真的改了 profile 补丁"的回执，且每次改动前先清空
  check(/var restartNotice = \(receipt && receipt\.restart\)[\s\S]{0,24}\? h\(/.test(mbBody),
    '告警框**有条件**渲染（判据 `receipt && receipt.restart`）—— 不是一块无条件常驻的告示', '');
  const setReceipts = (mbBody.match(/setReceipt\(/g) || []).length;
  check(setReceipts === 2, '`setReceipt(` 恰好两处：开新一轮清空 + POST 成功后写入分段回执', `命中 ${setReceipts}`);
  check(/setBusy\(true\); setErr\(''\); setMsg\(''\); setReceipt\(null\)/.test(mbBody),
    '每次 `apply()` 开头先清掉旧回执 ⇒ 这一次没有重启要求时**不会**留着上一次的告警（假阳性守卫）', '');
  const iErrGuard = mbBody.indexOf("if (!res.ok || !res.d || !res.d.ok)");
  const iSetReceipt = mbBody.indexOf('setReceipt(memoryBackendParts(res.d))');
  check(iErrGuard >= 0 && iSetReceipt > iErrGuard,
    '写回执在**成功分支**里（失败早退之后）⇒ 失败时不会误报"需重启"（假阴性守卫）', `guard=${iErrGuard} set=${iSetReceipt}`);
  check(/if \(!err && receipt && receipt\.restart\) bottomMsg = receipt\.receipt/.test(mbBody),
    '告警框在场时底部回执只说"已保存/未接通"那半句（同一句话不印两遍，避免读成两件事）', '');

  // ③ 位置：紧跟选择器之后、诊断行（`.exp-hs-kv`）之前 —— 这就是"用户可能看不到"的修复本体。
  // ⚠️ 只比字符偏移是不够的（**实测过的漏洞**：把 `restartNotice,` 挪进同一个 `.exp-hs-row`、
  //    贴着控件右边，偏移仍然满足"选择器之后、诊断行之前" ⇒ 全绿，可那已经不是「正下方」了）。
  //    所以这里再钉**嵌套层级**：告警框必须是返回树里与 `.exp-hs-row` **平级的兄弟节点** ——
  //    行收尾之后、缩进与该行开头一致、后面紧跟第一个诊断行。
  const iSel = mbBody.indexOf("className: 'exp-hs-select exp-hs-select-narrow'");
  const iNotice = mbBody.indexOf('restartNotice,');
  const iKV = mbBody.indexOf("className: 'exp-hs-kv'");
  check(iSel >= 0 && iNotice > iSel && iKV > iNotice,
    '告警框在**字节序**上排在选择器之后、诊断行之前', `sel=${iSel} notice=${iNotice} 首个kv=${iKV}`);
  const rowOpen = /\n( *)(h\('div', \{ className: 'exp-hs-row' \},)/.exec(mbBody);
  const rowIndent = rowOpen ? rowOpen[1] : null;
  const asSibling = rowIndent === null
    ? false
    : mbBody.includes(`\n${rowIndent}restartNotice,\n${rowIndent}h('div', { className: 'exp-hs-kv' },`);
  check(!!rowOpen && asSibling,
    '告警框是**返回树里与选择器那一行平级的兄弟节点**（行收尾之后、缩进与诊断行一致）—— 「塞进那一行、贴在控件旁边」会红',
    rowIndent === null ? '切不出 `.exp-hs-row` 的缩进' : `行缩进=${rowIndent.length} 空格 / 平级=${asSibling}`);
  const noticeSites = (mbBody.match(/restartNotice,/g) || []).length;
  check(noticeSites === 1, '告警框只有一个渲染位点（不存在"顶部一份、底部又一份"）', `命中 ${noticeSites}`);

  // ④ 版式：两处都挂在**元素自己的类**上，不靠祖先关系（`HindsightBlock` 的配置表单是兄弟节点，
  //    用的是同一个共享类 —— 靠 `.x .y` 那种写法，一旦表单被搬进来，三个标签会**静默**变宽）
  //    计数不是洁癖：`/…/.test()` 只看"有没有"，复制出**第二个**三选一下拉会全绿地溜过去。
  const mbLabelUse = (cliSrc.match(/exp-hs-label-mb/g) || []).length;
  check(mbLabelUse === 2, '`exp-hs-label-mb` 恰好 2 处（1 条 CSS + 1 个 JSX 挂点）', `命中 ${mbLabelUse}`);
  const narrowUse = (cliSrc.match(/exp-hs-select-narrow/g) || []).length;
  check(narrowUse === 2, '`exp-hs-select-narrow` 恰好 2 处（1 条 CSS + 1 个 JSX 挂点）—— 复制出第二个下拉会红', `命中 ${narrowUse}`);
  const cfgLabels = (cliSrc.match(/className: 'exp-hs-label'/g) || []).length;
  check(cfgLabels === 3, '配置表单那三行（部署形态/服务地址/访问令牌）仍是**裸** `.exp-hs-label` ⇒ 宽度 104px 不变', `命中 ${cfgLabels}`);
  const wideJudges = (cliSrc.match(/String\(r\.hint \|\| ''\)\.length > 120/g) || []).length;
  check(wideJudges === 1 && /' exp-settings-row-wide'/.test(cliSrc),
    '长说明行（>120 字）换行独占一行的判据存在且只有一个（阈值 120）', `命中 ${wideJudges}`);

  // ⑤ 样式表级：求出**同一份** CSS 常量（与 `client-css-integrity` 同法）。
  // ⚠️ 这里必须钉**声明本身**（逐字子串），不是只钉选择器文本：只查 `.exp-hs-restart-h{` 的话，
  //    把 `font-weight:700` 删掉（加粗标题没了 ⇒「第一眼读到」这个修复的全部意义没了）会全绿。
  //    下面 6 条是这次修复真正依赖的声明，与 432/434 两条共享规则同一口径。
  const cssStart = cliSrc.indexOf('var CSS =');
  const cssEnd = cliSrc.indexOf('// ── session store', cssStart);
  let css = '';
  try { css = (cssStart < 0 || cssEnd < 0) ? '' : new Function(`${cliSrc.slice(cssStart, cssEnd).trimEnd()}\nreturn CSS;`)(); } catch { css = ''; }
  check(css.length > 1000, '能求出样式表（反空转：求值失败必须红）', `len=${css.length}`);
  const RULES = [
    ['.exp-hs-warn.exp-hs-restart{margin:10px 0 2px;font-size:12px}', '告警框与上下文的间距、比正文大一档的字号'],
    ['.exp-hs-restart-h{font-weight:700;margin-bottom:2px}', '加粗标题 ——「第一眼读到要不要重启」就靠这一条'],
    ['.exp-hs-label.exp-hs-label-mb{flex:0 0 152px;max-width:152px}', '标签列与下方键列对齐到 152px'],
    ['.exp-hs-select.exp-hs-select-narrow{flex:0 1 320px;max-width:340px}', '三选一不再被拉到整行宽'],
    ['.exp-settings-row-wide{flex-wrap:wrap}', '长说明那一行允许换行'],
    ['.exp-settings-row-wide .exp-settings-note{flex:1 1 100%;margin-top:2px}', '长说明独占一行（不再被控件列挤成文字柱）'],
    ['.exp-settings-ctl select{max-width:340px}', 'enum 控件列的全局上限（说明那列才有人读）'],
  ];
  for (const [rule, why] of RULES) {
    check(css.includes(rule), `样式表里**逐字**有这条规则：${rule.slice(0, rule.indexOf('{'))}（${why}）`,
      css.includes(rule) ? '' : '规则缺失或声明被改过');
  }
  check(!/\.exp-hs-mb[\s.{]/.test(css), '样式表里没有 `.exp-hs-mb` 这类**祖先依赖**的选择器（版式不靠 JSX 结构碰巧成立）', '');
  check(css.includes('.exp-hs-label{flex:0 0 104px;max-width:104px;font-size:12px}'),
    '共享的 `.exp-hs-label` 基础规则**逐字未动**（配置表单三行仍是 104px）', '');
  check(css.includes('.exp-hs-input,.exp-hs-select{flex:1;min-width:0;'),
    '共享的 `.exp-hs-input,.exp-hs-select` 基础规则**逐字未动**（配置表单的控件仍占满整行）', '');
}

// ── ⑦d 「实际状态」那一行的**文字色**与**告警框**必须是两个类（2026-09-17 用户真机截图）──────
// 为什么单开一节：这是 ⑦c 那种**存在性**断言**结构上抓不住**的缺陷类 —— 组件的接线、位置、类名的
// 存在性全绿（`exp-hs-warn` 这个字符串确实既在 JSX 里、也在样式表里），而用户看到的是「实际状态」行里
// 一个**缺边的琥珀色破框 + 文字在框里折行**。根因是**一个类名担了两种用途**：`.exp-hs-warn` 是一个
// **框**（margin/padding/1px 边/3px 左重条/圆角/渐变背景），却被挂进值列里的内联 <span> 冒充"文字色"。
// （三档状态里**只有 warn 这一档**会这样：`.exp-hs-ok`/`.exp-hs-bad` 本来就只有 color+font-weight。）
// 所以这里钉的是**形态**，三条：
//   ① 状态文字那一档必须是**文本级**类（只有 color+font-weight，**没有任何盒子声明**）；
//   ② `.exp-hs-warn`（框）只允许挂在**块级 <div>** 上 —— 内联 <span> 上再出现一次就是缺陷原样复现；
//   ③ 值列的 `word-break:break-all` 只留给真正需要它的那一列（profile 补丁的长路径），状态那列退回正常断词。
console.log('\n⑦d 「实际状态」的文字色 vs 告警框（两个类不许混用）');
{
  const cliSrc = await readFile(join(here, 'client.js'), 'utf8');
  const mbStart = cliSrc.indexOf('function MemoryBackendBlock(props) {');
  const mbEnd = mbStart < 0 ? -1 : cliSrc.indexOf('\n    function ', mbStart + 1);
  const mbBody = (mbStart < 0 || mbEnd < 0) ? '' : cliSrc.slice(mbStart, mbEnd);
  check(mbBody.length > 0, '能切出 `MemoryBackendBlock` 的函数体（反空转：切不出来必须红）', `len=${mbBody.length}`);

  // 注释里也会提到这两个类名，所以"计数"一律在**去掉注释**的源码上做。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const codeOnly = stripComments(cliSrc);
  // ⚠️ 2026-09-19 新增：`jsOnly` = **把样式表那一段整段挖掉**之后的 JS/JSX 源码。
  //    为什么要它：本节的「计数」守卫防的是**挂点复制**（同一个类被挂到第二个值列），而样式表里的
  //    规则条数会随正当的深色覆写（⑦e）增加 —— 两者必须分开数，否则"加了深色覆写"会误判成"多了一个挂点"。
  const jsCssStart = cliSrc.indexOf('var CSS =');
  const jsCssEnd = cliSrc.indexOf('// ── session store', jsCssStart);
  const jsOnly = (jsCssStart < 0 || jsCssEnd < 0)
    ? ''
    : stripComments(cliSrc.slice(0, jsCssStart) + cliSrc.slice(jsCssEnd));

  // ① 三档状态文字的取值：ok / bad / **warn-text**（不是 warn —— 后者是框，不是文字色）
  check(/var cls = disp\.level === 'ok' \? 'exp-hs-ok' : \(disp\.level === 'bad' \? 'exp-hs-bad' : 'exp-hs-warn-text'\)/.test(mbBody),
    '状态文字取的三档**都是文本级**类（warn 档用 `exp-hs-warn-text`，绝不用告警框的 `.exp-hs-warn`）', '');
  check(/h\('span', \{ className: 'exp-hs-k' \}, esc\(t\('实际状态', 'Actual state'\)\)\)/.test(mbBody),
    '「实际状态」行仍是 key/value 两列（键列 152px 由 `.exp-hs-k` 给，与标签列对齐）', '');
  check(/h\('span', \{ className: 'exp-hs-v exp-hs-v-status' \}, h\('span', \{ className: cls \}/.test(mbBody),
    '「实际状态」的值列挂上专用类 `exp-hs-v-status`，里面那层就是上面的文本级状态类（值列里不再有任何盒子类）', '');

  // ② `.exp-hs-warn`（框）挂点扫描：每个 className 里带**裸** `exp-hs-warn` 的挂点，标签必须都是 <div>。
  //    ⚠️ 为什么不用 `cliSrc.includes(...)`：字符串一直都在，那种断言对这个缺陷**恒绿**。
  //    为什么数"恰好 2 处"：本文件里它只有两个正当用途（重启提示 / 诊断块的当前故障），
  //    再多一处要么是重复渲染、要么就是又把它当文字色用了。
  const warnSites = [];
  for (let at = codeOnly.indexOf("className: '"); at >= 0; at = codeOnly.indexOf("className: '", at + 1)) {
    const cls = codeOnly.slice(at + 12).split("'")[0];
    if (!/exp-hs-warn(?!-text)/.test(cls)) continue;
    const lineStart = codeOnly.lastIndexOf('\n', at) + 1;
    const tag = (/h\('([a-z]+)'/.exec(codeOnly.slice(lineStart, at)) || [])[1] || '(找不到标签)';
    warnSites.push(`${tag}.${cls}`);
  }
  check(warnSites.length === 2 && warnSites.every((s) => s.indexOf('div.') === 0),
    '告警**框** `.exp-hs-warn` 恰好 2 处、且**都挂在块级 <div>** 上（重启提示 / 诊断块的当前故障）—— 内联 <span> 上出现它就是本次截图那个"缺边的破框"',
    `命中 ${warnSites.length} 处：${warnSites.join(' | ')}`);

  // ③ 样式表级：文本类逐字在、且**不含任何盒子声明**；框类逐字未动；断词规则按列区分。
  const cssStart = cliSrc.indexOf('var CSS =');
  const cssEnd = cliSrc.indexOf('// ── session store', cssStart);
  let css = '';
  try { css = (cssStart < 0 || cssEnd < 0) ? '' : new Function(`${cliSrc.slice(cssStart, cssEnd).trimEnd()}\nreturn CSS;`)(); } catch { css = ''; }
  check(css.length > 1000, '能求出样式表（反空转：求值失败必须红）', `len=${css.length}`);
  const ruleBody = (sel) => {
    const m = new RegExp(`\\${sel}\\{([^}]*)\\}`).exec(css);
    return m ? m[1] : null;
  };
  check(css.includes('.exp-hs-warn-text{color:#8a6100;font-weight:700}'),
    '样式表里**逐字**有 `.exp-hs-warn-text`（琥珀色墨水，色值取本文件既有的 `.exp-hs-tag`）—— 只查"类名在不在"抓不住"盒子声明又被加回来"，所以钉声明本身', '');
  const textBody = ruleBody('.exp-hs-warn-text');
  check(typeof textBody === 'string' && !/border|background|padding|margin/.test(textBody),
    '状态**文字**类里**没有任何盒子声明**（border / background / padding / margin）—— 它只回答"什么颜色、多重"，盒子的活归 `.exp-hs-warn`',
    `body=${textBody}`);
  for (const [sel, want] of [['.exp-hs-ok', 'color:#1a7f5a;font-weight:700'], ['.exp-hs-bad', 'color:#b3291e;font-weight:700']]) {
    const body = ruleBody(sel);
    check(body === want, `${sel} 仍是纯文字色、逐字未动（这次一并核过：另外两档从未被当盒子用过）`, `body=${body}`);
  }
  check(css.includes('.exp-hs-warn{margin:8px 0;padding:8px 10px;border:1px solid #f0c36d;border-left:3px solid #e0a83c;border-radius:8px;background:linear-gradient(180deg,rgba(224,168,60,.12),transparent);font-size:11.5px;line-height:1.6}'),
    '告警**框**规则 `.exp-hs-warn` **逐字未动**（重启提示与诊断块那两处真·告警框仍靠它）', '');
  check(css.includes('.exp-hs-v{flex:1;min-width:0;font-size:12px;line-height:1.5;word-break:break-all}'),
    '共享的值列规则 `.exp-hs-v` **逐字未动** ——「profile 补丁」那行的长路径仍靠 `break-all` 不撑破列', '');
  check(css.includes('.exp-hs-v.exp-hs-v-status{word-break:normal;overflow-wrap:break-word}'),
    '只有状态那一列退回正常断词（`word-break:normal` + `overflow-wrap:break-word` 兜底超长不可断 token）—— 中英混排的句子不再从词中间劈开', '');
  const vRules = css.match(/\.exp-hs-v\s*\{[^}]*\}/g) || [];
  check(vRules.length === 1 && /word-break:break-all/.test(vRules[0]),
    '`word-break:normal` **没有**全局作用到共享的 `.exp-hs-v` 上（本仓 4 处值列共用它，只有状态这一列换了专用类）', vRules.join(' | '));

  // ④ 计数：两个新类各恰好 2 处（1 条 CSS + 1 个 JSX 挂点）—— 复制出第二处会红（本仓 ⑦c 的同一套反复制口径）。
  // ⚠️ 2026-09-19 修订口径（**放宽的是「数什么」，不是守卫强度**）：本轮给记忆后端状态墨水加了
  //    `body[data-ds-dark-theme]` 深色覆写（见 ⑦e）⇒ 样式表里 `exp-hs-warn-text` 从 1 条规则变 2 条
  //    （浅色基规则 + 深色覆写）。原来那句「全文恰好 2 处」会把**正当的**深色覆写判红。但守卫的本意
  //    （「这个类只许有 1 个 JSX 挂点，复制到第二个值列就红」）必须保住，所以把「2 处」**拆成两半**分别钉死：
  //      · JS/JSX 侧（样式表整段挖掉）恰好 1 个挂点 —— 复制挂点立刻红，且不再被样式表变动误伤；
  //      · 样式表侧恰好 2 条规则（浅色基 + 深色覆写）—— **删掉深色覆写也会红**（原来那口径反而抓不到）。
  //    净效果：比原来更紧（多了一条"深色覆写不许被删"），且不会误报。
  const textUse = (jsOnly.match(/exp-hs-warn-text/g) || []).length;
  check(textUse === 1, '`exp-hs-warn-text` 在 JS/JSX 侧恰好 1 个挂点（老口径「1 CSS + 1 JSX = 2 处」按 ⑦e 拆成两半）', `命中 ${textUse}`);
  const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const textCssRules = (cssNoComment.match(/exp-hs-warn-text/g) || []).length;
  check(textCssRules === 2, '`exp-hs-warn-text` 在样式表里恰好 2 条规则（浅色基规则 + `body[data-ds-dark-theme]` 深色覆写）—— 删掉深色覆写本条红', `命中 ${textCssRules}`);
  const statusUse = (jsOnly.match(/exp-hs-v-status/g) || []).length;
  check(statusUse === 1, '`exp-hs-v-status` 在 JS/JSX 侧恰好 1 个挂点 —— 复制到别的值列会红', `命中 ${statusUse}`);
  const statusCssRules = (cssNoComment.match(/exp-hs-v-status/g) || []).length;
  check(statusCssRules === 1, '`exp-hs-v-status` 在样式表里恰好 1 条规则（本轮没给它加深色覆写，也不许有人顺手复制）', `命中 ${statusCssRules}`);
}

// ── ⑦e 深色主题：宿主走的是 `body[data-ds-dark-theme]`，**不是** `prefers-color-scheme`（2026-09-19）──
// 为什么单开一节：宿主 `packages/client/ui-theme/src/boot-theme.ts` 的深色来自**三选一偏好**
//   `light | dark | system`，落成 `document.body.toggleAttribute('data-ds-dark-theme', dark)` ——
//   只有 `system` 那一档才去读 OS 的 `matchMedia('(prefers-color-scheme: dark)')`。本插件此前**只**认
//   OS 媒体查询 ⇒「宿主里选 Dark、操作系统仍是浅色」的用户拿到宿主的深色底，却一条插件深色样式都没有：
//   而 `.exp-hs-warn-text` 自 2026-09-17 起**直接贴在面板底上**（不再有浅色底衬的 callout 盒），
//   琥珀墨水 `#8a6100` 在深色底上实测 ~3.2:1 ⇒ 低于 WCAG AA 正文 4.5:1。这就是本节存在的理由。
// 断言口径**八条**（少一条，**局部修复**或**假绿**就能全绿）：
//   ① 覆盖面是一个 **8 条的集合**，逐条钉「选择器 + 声明」——只补 warn-text 那一条（最容易"够了"的做法）必须红；
//   ② 判据真的**与 OS 无关**：把这 4 个历史 `@media (prefers-color-scheme:dark){…}` 块（花括号配平）整段剥掉，
//      这 8 条覆写**仍然在** —— 否则有人把它们写进媒体查询里，字符串照样命中，OS 浅色用户照样没样式；
//   ③ 浅色基规则**逐字未动**（`#8a6100`）—— 修好深色不等于可以顺手改浅色；
//   ④ 那 4 个历史媒体块**仍然是 4 个** —— 防"删掉旧块冒充修好"（完整迁移要连带重写 dag-status 的
//      `stripDark()` 配平口径与两条浅/深取值不同的 NEGATIVE，那是另一轮的事）。
//   ── ⑤⑥⑦⑧ 是**独立核验用可复现反例证明过的四个盲区**，2026-09-19 补（代号 H3 / H4 / H5 / H5-b＝⑦ 判据自身）
//   ⑤ **任意** `@media`/`@supports` 里的一条规则，字符串断言照样命中、`node --check` 照样绿、本文件照样
//      **exit 0** —— 可在浏览器里那条规则**永远不生效**。② 只剥 `prefers-color-scheme`，`@media print{}` /
//      `@media (min-width:99999px){}` 都不在它的射程内 ⇒ 这是一条**假绿路径**。所以这里另用**通用**花括号
//      配平剥块器（凡 `@media`/`@supports` 一律剥掉其内容）再跑一遍同一批 `ruleIn`，并要求 8 条**全在顶层级联**；
//      另加反空转（剥完必须真的变短），否则"剥块器是个 no-op"也能让本条通过。
//   ⑥ 原口径只有 `.exp-hs-warn-text` 一条**浅≠深**的 NEGATIVE，其余 7 条只被 `DARK_INK` 字面量瞄着 ⇒
//      保证的只是"等于我钉的那个常量"，**不是**"不等于浅色值"：把某条深色值写成它自己的浅色值（例如把
//      `.exp-hs-ok` 的 `#4ed17e` 改成 `#1a7f5a`），只要顺手把 `DARK_INK` 一起改就**全绿**，而色差其实没了。
//      所以这里对 **8 条逐条**从样式表里**真解析**浅色基规则的 `color`，断言 8 对全部浅 ≠ 深；
//      浅色值**抽不到就红**（本仓反假绿纪律：抽不到 ≠ 跳过）。深色覆写不是浅色基准 —— 取基准前先剥掉深色前缀规则。
//   ⑦ 字符串断言只看"这条规则在不在"，**不看它后面还有没有同级或更高特异度的规则把它盖回去**：独立核验证明，
//      追加一条 `body[data-ds-dark-theme] .exp-hs-hist .exp-hs-tag{color:#8a6100}`（选择器比 `.exp-hs-tag` 的覆写更长
//      ⇒ 特异度更高、且源码更靠后）就能把它重新画回浅色琥珀，而本文件 **exit 0**。所以 ⑦ 扫全部
//      `body[data-ds-dark-theme] …{…color:…}` 规则，要求**只允许**这 8 条（多一条即红），并逐条要求深色规则在
//      **源码顺序上晚于**它的浅色基规则（同一深色前缀内特异度相同，晚者胜 —— 早者会被无声盖掉）。
//   ⑧ ⑦ 的**判据本身**也被独立核验用可复现反例证明过（H5 → N-1 → N-2 三轮，每轮补的都是"上一轮判据看不见的
//      那一类"）：⑦ 只枚举"带 `body[data-ds-dark-theme]` 前缀"的规则 ⇒ **不带前缀、但真的能赢**的规则完全不可见。
//      反例：`html body .exp-hs-kv span.exp-hs-ok{color:#1a7f5a}` = **(0,2,3)** > 覆写 **(0,2,1)**
//      （类列打平、**类型列** 3 > 1）⇒ 浏览器把深底上的 `.exp-hs-ok` 画回浅绿，而本文件当时 **exit 0**。
//      于是 ⑧ 改问"**有没有任何一条规则能赢过这条覆写**"：逐条算覆写的特异度三元组、扫全部声明 `color`
//      （或 `all:` / `-webkit-text-fill-color`）、且**可能命中同一元素**的规则，任何一条在特异度/源码顺序/
//      `!important` 上赢 ⇒ 红。之后又补了两处"候选口径太窄"：
//        **N-1** 候选只认"类名 token" ⇒ `*{color:#1a7f5a!important}`（无 token）**从不被审视**，`!important`
//          也退化成"仅在已匹配候选之间当裁决者"；现在「主题无类/属性约束」与「带 `!important` 的
//          color/all/fill 声明」**本身就是进候选的理由**。
//        **N-2** 不认 CSS 转义 ⇒ `html body .exp\-hs\-kv span.exp\-hs\-ok{…}`（同一个类、同样是 (0,2,3)）
//          既匹配不上 token、特异度也把 `\` 之后当类型选择器；现在两处都先 `cssUnescape`。
//      ⑨ 再补一件 ⑧ 结构上**做不到**的事：行内 `style={{color:…}}` 连样式表都不在，只能按元素单独扫（N-3）。
//      还有一条**证据纪律**的自我更正写在下面长注释里：本节的注入 B 当年被当成"证明了 `!important` 判据"，
//      其实它靠特异度就已经被抓 —— 没有隔离机制的注入等于没证。
/**
 * 花括号配平地解析 CSS，摊平成 `{ selector, body, top, pos }`。
 * 为什么要在测试里放一个解析器（本仓少见）：⑦e 的 ⑤⑥⑦ 三条要问的问题 —— "这条规则在不在**顶层级联**"、
 * "某条规则的 `color` 到底是什么"、"谁在源码顺序上更靠后" —— `String.includes` 一个都答不了，而**恰好是**
 * 这三个问题上的盲区被独立核验用可复现反例证明过（假绿）。这里刻意只做最小实现：
 *   · 注释整段跳过、字符串（`content:"…"`）跳过（否则里面的花括号会打乱配平）；
 *   · `@media`/`@supports` 等 at 块**剥壳**：里面的选择器规则照收，但 `top` 标成 false（不是顶层级联）；
 *   · 花括号不配平 ⇒ 抛错（调用方判红，不静默算过）。
 */
function parseCssRules(text) {
  const stack = [{ head: null, children: [] }];
  let buf = '';
  let i = 0;
  let pos = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (c === '"' || c === "'") { const q = c; let j = i + 1; while (j < text.length && text[j] !== q) { if (text[j] === '\\') j += 1; j += 1; } buf += text.slice(i, j + 1); i = j + 1; continue; }
    if (c === '{') { stack.push({ head: buf.trim(), children: [] }); buf = ''; i += 1; continue; }
    if (c === '}') {
      const frame = stack.pop();
      if (!frame || !stack.length) throw new Error('CSS 花括号不配平（多余的 }）');
      const parent = stack[stack.length - 1];
      if (/^@/.test(frame.head)) parent.children.push(...frame.children); // at 块剥壳：内层规则上提，但 top 已按 parent 判定
      else parent.children.push({ selector: frame.head, body: buf.trim(), top: parent.head === null, pos: pos++ });
      buf = ''; i += 1; continue;
    }
    buf += c; i += 1;
  }
  if (stack.length !== 1) throw new Error('CSS 花括号不配平（缺 }）');
  return stack[0].children;
}

console.log('\n⑦e 深色主题覆写：body[data-ds-dark-theme]（宿主三选一偏好，与 OS 无关）');
{
  const cliSrc = await readFile(join(here, 'client.js'), 'utf8');
  const cssStart = cliSrc.indexOf('var CSS =');
  const cssEnd = cliSrc.indexOf('// ── session store', cssStart);
  let css = '';
  try { css = (cssStart < 0 || cssEnd < 0) ? '' : new Function(`${cliSrc.slice(cssStart, cssEnd).trimEnd()}\nreturn CSS;`)(); } catch { css = ''; }
  check(css.length > 1000, '能求出样式表（反空转：求值失败必须红）', `len=${css.length}`);

  // 覆盖集合：记忆后端那一块的**全部**状态墨水（文字色）。少一条 = 局部修复。
  const DARK_INK = [
    ['.exp-hs-warn-text', 'color:#f7ad31', '本轮被暴露的那条：三选一「实际状态」的琥珀色文字'],
    ['.exp-hs-tag', 'color:#f7ad31', '诊断块里的分类标签（同一档琥珀墨水）'],
    ['.exp-hs-ok', 'color:#4ed17e', '「已启用 / 已找到 / 可达」的绿色文字'],
    ['.exp-hs-hist .exp-hs-tag-ok', 'color:#4ed17e', '「历史 · 已恢复」标签的绿色文字'],
    ['.exp-hs-msg', 'color:#4ed17e', '块底回执的成功那一档'],
    ['.exp-hs-bad', 'color:#ff7b7b', '失败 / 未配置那一档'],
    ['.exp-hs-msg.bad', 'color:#ff7b7b', '块底回执的失败那一档'],
    ['.exp-hs-btn.danger', 'color:#ff7b7b', '「清除令牌」这类危险按钮的文字色'],
    // 第 9 条（2026-09-19）：这个类是**新加**的，给"选了 off、但补丁里那个 `- insert:` 包裹的
    // `mcp-midas` 行还在"那条诚实话用。它与 `.exp-hs-warn-text` 的浅色基值逐字相同（`#8a6100`）
    // ⇒ 深色下同样会掉到 3.29:1 ⇒ **必须**在这个集合里，否则"只给浅色不给深色"能整条溜过去。
    ['.exp-hs-offwarn', 'color:#f7ad31', '「off 但 mcp-midas 行还在」那条警告的琥珀色文字'],
  ];
  const ruleIn = (s, sel, decl) => s.includes(`body[data-ds-dark-theme] ${sel}{${decl}}`);
  // 覆盖集合本身也钉住条数：不许靠「把查不动的那条从集合里删掉」把测试改绿（本仓的棘轮口径）。
  check(DARK_INK.length === 9, '覆盖集合本身被钉成 9 条（少查一条也得显式改这个数字 ⇒ 改绿不是静默的；2026-09-19 由 8 改 9：新增 `.exp-hs-offwarn`）', `len=${DARK_INK.length}`);
  const missingDark = DARK_INK.filter(([sel, decl]) => !ruleIn(css, sel, decl));
  check(missingDark.length === 0,
    `深色覆写**成组**覆盖记忆后端全部 ${DARK_INK.length} 条状态墨水（只补 warn-text 一条 = 局部修复，本条必须红）`,
    missingDark.length ? `缺 ${missingDark.length} 条：${missingDark.map(([s]) => s).join(' / ')}` : `覆盖 ${DARK_INK.length}/${DARK_INK.length}`);

  // ② 与 OS 无关：花括号配平剥掉历史媒体块后，这 8 条必须仍在（写作口径沿用 dag-status 的 stripDark）。
  const stripDarkMedia = (s) => {
    const re = /@media\s*\(prefers-color-scheme\s*:\s*dark\)\s*\{/g;
    let out = s, m;
    while ((m = re.exec(out))) {
      let i = m.index + m[0].length - 1, depth = 0;
      for (; i < out.length; i += 1) {
        if (out[i] === '{') depth += 1;
        else if (out[i] === '}') { depth -= 1; if (depth === 0) break; }
      }
      out = out.slice(0, m.index) + out.slice(i + 1);
      re.lastIndex = m.index;
    }
    return out;
  };
  const noMedia = stripDarkMedia(css);
  const lostAfterStrip = DARK_INK.filter(([sel, decl]) => !ruleIn(noMedia, sel, decl));
  const writtenIntoMedia = lostAfterStrip.filter(([sel, decl]) => ruleIn(css, sel, decl));
  check(noMedia.length < css.length && lostAfterStrip.length === 0,
    '9 条覆写都**不在**历史 `@media (prefers-color-scheme:dark)` 块内（剥掉媒体块后仍在 ⇒ 判据真的与 OS 无关）',
    lostAfterStrip.length
      ? `剥后丢失 ${lostAfterStrip.length} 条（其中 ${writtenIntoMedia.length} 条确实被写进了媒体块，${lostAfterStrip.length - writtenIntoMedia.length} 条本来就没有）：${lostAfterStrip.map(([s]) => s).join(' / ')}`
      : `剥后 len=${noMedia.length} < ${css.length}`);

  // ③ 浅色路径逐字未动，且浅/深取值真的不同（反空转）。
  check(css.includes('.exp-hs-warn-text{color:#8a6100;font-weight:700}'),
    '基规则 `.exp-hs-warn-text{color:#8a6100;font-weight:700}` 仍**逐字**在（浅色路径一个字没动）', '');
  for (const [sel, light] of [['.exp-hs-ok', 'color:#1a7f5a;font-weight:700'], ['.exp-hs-bad', 'color:#b3291e;font-weight:700']]) {
    check(css.includes(`${sel}{${light}}`), `${sel} 的浅色基规则仍逐字在（${light}）`, '');
  }
  check(css.includes('.exp-hs-warn-text{color:#8a6100;font-weight:700}') && ruleIn(css, '.exp-hs-warn-text', 'color:#f7ad31'),
    'NEGATIVE：`.exp-hs-warn-text` 浅/深取值确实不同（#8a6100 vs #f7ad31）—— 两边写同一个色等于没修', '');

  // ④ 历史机制仍在原处：4 个媒体块一个都没被删。
  const darkMedia = (css.match(/@media\s*\(prefers-color-scheme\s*:\s*dark\)/g) || []).length;
  check(darkMedia === 4,
    '4 个历史 `@media (prefers-color-scheme:dark)` 块**仍然是 4 个**（不许用「删掉旧块」冒充修好；完整迁移是另一轮）',
    `count=${darkMedia}`);

  // ── ⑤（H3）顶层级联：通用剥块器把**任意** `@media`/`@supports` 的内容剥掉，8 条必须仍在 ──────────
  // 为什么不能用上面的 `stripDarkMedia`：它只按 `prefers-color-scheme:dark` 的**字面量**匹配。把一条覆写
  // 包进 `@media print{…}`，那个子串一字不少、`ruleIn` 照样命中、本文件照样 exit 0 —— 而屏幕上那条规则
  // 永远不生效（独立核验给的可复现反例）。所以这里改成**与媒体条件无关**的剥法：凡是 `@media`/`@supports`
  // 开头的 at 块，一律连它的整块花括号一起剥掉，再问"这 8 条还在不在"。
  const stripAtBlocks = (s) => {
    let out = s;
    for (;;) {
      const m = /@(?:media|supports)[^{]*\{/.exec(out);
      if (!m) return out;
      let i = m.index + m[0].length - 1, depth = 0;
      for (; i < out.length; i += 1) {
        if (out[i] === '{') depth += 1;
        else if (out[i] === '}') { depth -= 1; if (depth === 0) break; }
      }
      if (depth !== 0) return out; // 花括号不配平：原样返回 ⇒ 下面"剥完必须变短"的反空转会红
      out = out.slice(0, m.index) + out.slice(i + 1);
    }
  };
  const noAtBlocks = stripAtBlocks(css);
  const lostAfterAtStrip = DARK_INK.filter(([sel, decl]) => !ruleIn(noAtBlocks, sel, decl));
  check(noAtBlocks.length < css.length,
    '通用剥块器（`@media`/`@supports` 一律剥）**真的剥掉了东西**（反空转：剥块器成了 no-op 时本条必须红，否则下一条会因为"什么都没剥"而空转通过）',
    `剥后 len=${noAtBlocks.length} vs 原 ${css.length}（缩短 ${css.length - noAtBlocks.length} 字节）`);
  check(lostAfterAtStrip.length === 0,
    '9 条覆写都在**顶层级联**里：把**任意** `@media`/`@supports`（不只是 `prefers-color-scheme`）的内容整块剥掉后这 9 条**仍然在** ⇒「写进 `@media print{}` / `@media (min-width:99999px){}` 让深色修复静默失效」这条假绿路径被封死',
    lostAfterAtStrip.length
      ? `剥后丢失 ${lostAfterAtStrip.length} 条（这些规则被写进了某个 @media/@supports 块：字符串看得见、浏览器里不生效）：${lostAfterAtStrip.map(([s]) => s).join(' / ')}`
      : `剥后 len=${noAtBlocks.length} < ${css.length}，9 条全在顶层`);

  // ── ⑥（H4）与 ⑦（H5）共用同一个花括号配平解析器 ────────────────────────────────────────────
  // 为什么自己解析而不是继续用正则：下面两条要问"某条规则的 `color` 是什么"与"谁在源码顺序上更靠后"，
  // 光靠 `includes` 答不了。这里只做一件最简单、可验证的事：把规则摊平成
  // `{ selector, body, top, pos }` —— `top` = 这条规则**不在**任何 `@media`/`@supports` 块里（顺带把
  // `@keyframes` 之类的内层帧也标成非顶层，它们本来就不是选择器规则），`pos` = 源码顺序。
  let parsedRules = null;
  try { parsedRules = parseCssRules(css); } catch { parsedRules = null; }
  check(Array.isArray(parsedRules) && parsedRules.length > 100,
    '样式表能被花括号配平地解析成规则表（反空转：解析失败 ⇒ ⑥⑦ 两条都不许"因为没规则可查"而静默通过）',
    parsedRules ? `规则数=${parsedRules.length}` : '解析失败');

  if (parsedRules) {
    /** 规则体里**最后一条** `color` 的值（同一体内后写覆盖先写；要求 `color:` 前是 `;`、`{` 或行首，免得误吃 `border-color:`）。 */
    const colorValueOf = (body) => {
      const hits = [...String(body).matchAll(/(?:^|[;{])\s*color\s*:\s*([^;}]+)/g)];
      return hits.length ? hits[hits.length - 1][1].trim() : null;
    };
    /** 选择器列表里每个分支的**主体**（最后一段复合选择器：`body[data-ds-dark-theme] .exp-hs-hist .exp-hs-tag` → `.exp-hs-hist .exp-hs-tag`）。 */
    const subjectOf = (selectorText) => String(selectorText).split(',').map((s) => {
      const parts = s.trim().split(/\s+/);
      return parts[parts.length - 1];
    }).filter(Boolean);
    const hasColor = (r) => colorValueOf(r.body) !== null;

    // ⑥ 浅色基规则必须**真的从样式表里解析出来**（抽不到就红），再断言浅 ≠ 深。
    // 取基准的手法（对 8 条**一视同仁**，不写死任何浅色值）：先剥掉所有 `body[data-ds-dark-theme]` 影子副本，
    // 再取该选择器在源码顺序上**最后一条**声明 color 的规则 —— 它就是浏览器在浅色下真正生效的那条。
    // （特殊两处由此自动落对：`.exp-hs-hist .exp-hs-tag-ok` 的浅色基准是它自己那条 `#1a7f5a`；
    //   `.exp-hs-btn.danger` / `.exp-hs-msg` / `.exp-hs-msg.bad` 各取各自那条，不靠祖先/裸类的 `inherit` 猜。）
    const lightPairs = DARK_INK.map(([sel, decl]) => {
      const cut = sel.lastIndexOf(' ');
      const targetText = cut < 0 ? sel : sel.slice(cut + 1);
      const cands = parsedRules.filter((r) => r.top && hasColor(r)
        && !r.selector.split(',').some((s) => s.trim().startsWith('body[data-ds-dark-theme]')) // 深色覆写不是浅色基准
        && subjectOf(r.selector).includes(targetText));
      const base = cands[cands.length - 1];
      return { sel, decl, base, light: base ? colorValueOf(base.body) : null };
    });
    const noBase = lightPairs.filter((p) => !p.base || !p.light);
    check(noBase.length === 0,
      '9 条覆写的**浅色基规则全部解析到了**（抽不到就红 —— 本仓反假绿纪律：抽不到不是"跳过"，是"判据失效"）',
      noBase.length
        ? `抽不到 ${noBase.length} 条：${noBase.map((p) => p.sel).join(' / ')}`
        : `9 条浅色基准：${lightPairs.map((p) => `${p.sel}=${p.light}`).join(' / ')}`);
    const notDiff = lightPairs.filter((p) => p.light && p.light === p.decl.slice('color:'.length));
    check(notDiff.length === 0,
      'NEGATIVE ×9：逐条断言**浅色值 ≠ 深色值**（不只是"等于 `DARK_INK` 里钉的那个常量"—— 把深色值写成浅色值、顺手把常量也改掉，本条也必须红）',
      notDiff.length
        ? `浅=深 ${notDiff.length} 条（等于没修）：${notDiff.map((p) => `${p.sel}（两边都是 ${p.light}）`).join(' / ')}`
        : lightPairs.map((p) => `${p.sel}: ${p.light} ≠ ${p.decl.slice('color:'.length)}`).join('；'));

    // ⑦ 「不多不少」：8 条覆写必须逐条作为**整条规则**存在（选择器 + 规则体与 DARK_INK 逐字一致），
    // 且 `body[data-ds-dark-theme] …{…color:…}` 这一类规则里**只允许**这 8 条。多一条 = 有人加了一条
    // 深色规则（很可能特异度更高、更靠后，把某条覆写盖回浅色）。
    const expected = DARK_INK.map(([sel, decl]) => ({ selector: `body[data-ds-dark-theme] ${sel}`, decl }));
    const darkRules = parsedRules.filter((r) => /^body\[data-ds-dark-theme\]/.test(r.selector) && r.top && hasColor(r));
    const unexpected = darkRules.filter((r) => !expected.some((e) => e.selector === r.selector && r.body === e.decl));
    check(unexpected.length === 0,
      '除了这 9 条，样式表里**没有别的** `body[data-ds-dark-theme] …{…color:…}` 规则（整条规则逐字比对，不只看子串 —— 多一条更高特异度/更靠后的深色规则就红）',
      unexpected.length
        ? `多出 ${unexpected.length} 条：${unexpected.map((r) => `${r.selector}{${r.body}}`).join(' / ')}`
        : `恰好 ${darkRules.length} 条，逐字与 DARK_INK 一一对应`);
    // 反空转：上一条自己**真的比过 8 条**（否则"一条都没匹配到"会让它空转通过）。
    check(darkRules.length === expected.length,
      '反空转：上面那条「不多不少」确实比过 9 条深色规则（命中数不为 9 ⇒ 红，避免空转通过）', `命中 ${darkRules.length}`);
    // 顺序：同一 `body[data-ds-dark-theme]` 前缀下特异度相同 ⇒ 源码**晚**者胜；深色规则若排在自己的浅色基
    // 规则之前，就会被浅色规则原样盖掉（字符串全在、屏幕上是浅色）。所以逐条要求 浅.pos < 深.pos。
    const outOfOrder = lightPairs.map((p) => {
      const lightPos = parsedRules.indexOf(p.base);
      const darkPos = parsedRules.findIndex((r) => r.selector === `body[data-ds-dark-theme] ${p.sel}`);
      return { p, lightPos, darkPos };
    }).filter((x) => x.lightPos < 0 || x.darkPos < 0 || x.lightPos > x.darkPos);
    check(outOfOrder.length === 0,
      '9 条覆写在**源码顺序上都晚于**自己的浅色基规则（同特异度前缀内晚者胜 ⇒ 有人把它挪到基规则之前会被浅色原样盖掉，本条必须红）',
      outOfOrder.length
        ? `顺序倒置 ${outOfOrder.length} 条：${outOfOrder.map((x) => `${x.p.sel}（浅 ${x.lightPos} / 深 ${x.darkPos}）`).join(' / ')}`
        : lightPairs.map((p) => `${p.sel}: 浅 ${parsedRules.indexOf(p.base)} < 深 ${parsedRules.findIndex((r) => r.selector === `body[data-ds-dark-theme] ${p.sel}`)}`).join('；'));

    // ⑦ 的反例（独立核验给的那两条）长这样：
    //   body[data-ds-dark-theme] .exp-hs-hist .exp-hs-tag{color:#8a6100}   ← 把 `.exp-hs-tag` 的覆写按回浅色琥珀
    //   body[data-ds-dark-theme] .exp-hs-kv span.exp-hs-ok{color:#1a7f5a}   ← 把 `.exp-hs-ok` 的覆写按回浅色绿
    // 上面「不多不少」一条就抓住它们（它们是 DARK_INK 之外的深色 color 规则）。
    // 为什么不在这里做**完整特异度模拟**：本文件要回答的是"这 8 条覆写会不会被**后来者**盖掉"，而能盖掉它们的
    // 后来者必须 (a) 匹配同一个元素、(b) 特异度 ≥ 覆写、(c) 源码更靠后。覆写的特异度里含 `body[data-ds-dark-theme]`
    // （1 个类型选择器 + 1 个属性选择器 + N 个类），**浅色规则一条都到不了这个量级** ⇒ 会构成威胁的只有**另一条**
    // 深色规则。于是"这类规则只许有这 8 条 + 深色晚于浅色"就是把危险面**完整**枚举了，比写一套特异度计算器
    // 更简单也更难写错（后者要处理 `:not()` / `:is()`、伪元素、选择器列表取最大等一堆细节，任何一处写松都会
    // 变成一个**看起来在守**的断言）。真正的完整特异度模拟是浏览器（或 jsdom + getComputedStyle）的活。
    //
    // ⚠️⚠️ 上面**这一段推理是错的**（原文刻意保留，不静默删掉 —— 错的正是"可以不写特异度计算器"这个前提）：
    // 第二次独立核验把**不带任何深色前缀**的那条反例喂进真实样式表，本文件 **exit 0**、`npm run test:all`
    // **exit 0（90 文件 0 失败）**，而 Chromium 的 `getComputedStyle` 明确给出 `rgb(26,127,90)`（浅绿）
    // —— 正是 ⑦e 存在的唯一理由（深底上的 WCAG AA 文字对比度）静默失效。为什么它会赢：
    // 特异度是三元组 **(id, 类/属性/伪类, 类型/伪元素)**、**逐列**比较：
    //     body[data-ds-dark-theme] .exp-hs-ok      = (0,2,1)   ← 1 个属性选择器 + 1 个类 + 1 个类型(body)
    //     html body .exp-hs-kv span.exp-hs-ok      = (0,2,3)   ← 2 个类 + **3 个类型选择器**
    // 类列打平（2 = 2），**类型列 3 > 1** ⇒ 严格更高。也就是「1 个属性选择器」只在第二列记 1 分，
    // **多出来的类型选择器在第三列直接把它压过去** —— "浅色规则一条都到不了这个量级"是**假的**，
    // 只要在目标类前面多堆 `html body …  span` 这类类型选择器就够。于是危险面根本不是"另一条深色规则"，
    // 而是**任何一条能命中同一元素、且赢得级联的规则**；⑦ 只能抓"冒充深色规则的攻击"，抓不住"真的在遮蔽"。
    // （顺带解释这个盲区为什么一直没被 ⑦ 的注释发现：注释里那条反例写成了**带前缀**的
    //  `body[data-ds-dark-theme] .exp-hs-kv span.exp-hs-ok{…}`，那条确实是 DARK_INK 之外的深色规则、⑦ 抓得住；
    //  把同一个前缀去掉，攻击从"被抓"变成"全绿" —— 盲区就藏在这一个前缀里。）
    //
    // ⑧（H5）**真·遮蔽检查**：不再问"这条规则带不带深色前缀"，而问「**有没有任何一条规则能赢过这条覆写**」。
    //   1) 每条覆写的特异度**算出来**（不写死、不查表）：`body[data-ds-dark-theme] .exp-hs-tag` → (0,2,1)、
    //      `body[data-ds-dark-theme] .exp-hs-hist .exp-hs-tag-ok` → (0,3,1)；
    //   2) 扫 `parseCssRules()` 出来的**全部**规则（含 `@media` 块内的 —— 那 4 个历史深色媒体块在 OS 深色下
    //      照样生效，所以**不按 `top` 过滤**），只要它声明了 `color`（或影响文字实际着色的 `all:` /
    //      `-webkit-text-fill-color`），且选择器**可能**命中与覆写相同的元素；
    //   3) 判谁赢：特异度**严格更高** ⇒ 赢；特异度**相等**且源码更靠后（`pos`）⇒ 赢；候选带 `!important`
    //      而覆写没带 ⇒ **不论特异度都赢**。任何一条"赢" ⇒ 红。
    //
    // 匹配启发式（刻意简单，且**宁可误报不可假绿**）：候选的某个**选择器分支**满足下面**三条通道之一**
    // 就算"**可能**命中同一元素"：
    //   ① **类名 token**（`.exp-hs-ok` → `exp-hs-ok`）：整词边界 `(?<![\w-])…(?![\w-])`，不是子串
    //      —— 免得 `.exp-hs-tag` 把 `.exp-hs-tag-ok` 也认成命中（后者是更专的那条，二者是设计好的父子关系）；
    //      转义先还原（`.exp\-hs\-ok` 是**同一个类**，见下面的 N-2）；token 出现在**属性值**里也算
    //      （`[class~=exp-hs-ok]` 确实命中这些元素）；
    //   ② **主题（最右复合选择器）没有任何类/属性/id/伪类约束**（`*` / `html body *` / 裸类型链）：
    //      这类规则"可能命中这些元素"，而且它们**永远不可能靠特异度赢**（第二列是 0，8 条覆写都 ≥2
    //      —— 逐列比较，第二列一票否决，这里曾被一次独立核验的中间结论判成假绿、后来它自己撤回，
    //      我们和 Chromium 都复核过：`html body div div div div span.exp-hs-ok` 在浏览器里**画不出**浅绿）
    //      ⇒ 它们**只能**靠 `!important` / `all:` / `-webkit-text-fill-color` 赢。所以这一步不是可有可无的
    //      保守：没有它，下面那三条判据对这类选择器**永远不可达**，而 `!important` 也会退化成"仅在已匹配的
    //      候选之间当裁决者"—— 那正是 N-1（`*{color:#1a7f5a!important}`，24 个字符、浏览器实测把深底上的
    //      `.exp-hs-ok` 画回浅绿、而本文件当时 exit 0）能整条溜过去的原因；
    //   ③ `[class…=v]` **属性选择器上的类匹配**：**六个操作符全都判**（`=` 精确 / `~=` 空白分隔词 /
    //      `|=` 等于 v 或以 `v-` 开头 / `^=` 前缀 / `$=` **后缀** / `*=` 子串，`i` 标志按大小写不敏感比）。
    //      Chromium 实测：给它配两个类把特异度顶上去（`html body .a.b [class$=ok]`）深底上的 `.exp-hs-ok`
    //      **真的**被画回 rgb(26,127,90)；`[class*=exp-hs]`（前缀）也一样 ⇒ 不是空想。
    //      ⚠️ 这一条**最初只做了前缀**（为封 `[class*=exp-hs]` 而加），后缀方向因此整类漏掉 —— 直到 F1
    //      （第五轮独立核验 + Chromium 实测 `[class$=ok]` / `[class*=-ok]` / `[class$="ok"]` / `[class$=tag]` /
    //      `[class$=msg]` / `[class$=OK i]` 全部画成浅绿，而当时本文件 exit 0）。教训与 N-1 同一条：
    //      **"按值判"而不"按操作符判"**，就等于把同一类攻击的另一个方向留在门外。
    // `.exp-op-btn.bad` / `.exp-settings-msg.bad`（都因为 token `bad`），它们特异度只有 (0,2,0) ⇒ 判
    // "赢不了"、不误报；真有一天它们被写成更高特异度，这里会红 —— 那是**可接受**的方向（人看到红断言里
    // 写着"可能命中"再去确认；反过来说，放过一条**确实在遮蔽**的规则是不可接受的）。
    //
    // ⚠️ 证据纪律的一处**自我更正**（N-1 的教训，必须写在这里而不是藏起来）：本节的注入 B
    // （`html body .exp-hs-kv span.exp-hs-ok{color:#1a7f5a!important}`）当年被当成"证明了 `!important` 这条
    // 判据"，**其实它没有**：那条选择器本来就带 token ⇒ 它靠**特异度 (0,2,3) > (0,2,1)** 就已经被抓，
    // `!important` 只是被顺带打印出来的理由。**一个没有隔离它所要证明的机制的注入，等于没证**
    // —— 正是这条线索上反复栽的那个坑。所以现在补了两条**隔离型**注入：
    //   · `.exp-hs-ok{color:#1a7f5a!important}`（(0,1,0) **低于**覆写 ⇒ 只能靠 `!important` 赢）；
    //   · `*{color:#1a7f5a!important}`（连 token 都没有 ⇒ 只能靠 ②+③ 的路子进候选再靠 `!important` 赢）。
    //
    // 真实表上四处**必须不误判**的口径，逐个对号：
    //   · `.exp-hs-v code{…}` / `.exp-settings-*` 这类**提到邻近类但不给目标上色**的规则 —— 第一步就被
    //     "声明了 color/all/fill 吗"（`colorValueOf()` 要求 `color:` 前是 `;`/`{`，`border-color` 不算）挡掉；
    //   · `.exp-hs-msg.bad`（浅 (0,2,0) / 深 (0,3,1)）是 `.exp-hs-msg`（浅 (0,1,0) / 深 (0,2,1)）的**子集**：
    //     两档各归各的覆写管，子集规则特异度**更低** ⇒ 判"赢不了"，设计原样保留；
    //   · `.exp-hs-hist .exp-hs-tag`（(0,2,0)）与 `.exp-hs-hist .exp-hs-tag-ok`（(0,2,0)）同理，且
    //     `.exp-hs-tag-ok` 里**不含**整词 token `exp-hs-tag` ⇒ 也不会被 `.exp-hs-tag` 那条覆写顺手扫进来；
    //   · **这 8 条覆写彼此之间**不许被当成互相遮蔽：`.exp-hs-hist .exp-hs-tag-ok` 的深色覆写 (0,3,1)
    //     确实"赢过" `.exp-hs-tag` 的深色覆写 (0,2,1)、`.exp-hs-msg.bad` 的 (0,3,1) 也赢过 `.exp-hs-msg` 的
    //     (0,2,1) —— 但那是**设计**（`class="exp-hs-tag exp-hs-tag-ok"` 的那个元素该是绿的）。所以把
    //     `selector+body` 与 `expected` **逐字相同**的规则从候选里剔掉。这不是放水：⑦ 的「不多不少」已经
    //     钉死"深色 color 规则只许是这 8 条、且逐字一致" ⇒ 能剔掉的只有这 8 条本体，剔不掉第 9 条。
    //
    // 诚实边界（⑧ **不**覆盖的东西，别把它当成浏览器）：
    //   · **靠元素上"别的类"命中的规则不在射程内**：候选靠 ①②③ 三条通道判定，所以
    //     `.target-extra{color:…}`（元素上确实有、但 8 条覆写的选择器里没提到的一个类）不会被判红
    //     —— 除非它带 `!important`（带 `!important` 的 color/all/fill 一律进候选，见下面循环里那一段）。
    //     要真正回答"它到底能不能命中"，只能拿真实 DOM 做可达性 —— 那是浏览器的活。
    //   · **选择器语义**：只看"token / 主题无约束"，不解析 `:not()` / `:is()` / `:has()` / `@scope` 的组合语义
    //     （`:is/:not` 只按"伪类 1 分 + 内层取最大"保守算**特异度**），也不看行内 `style=`、
    //     `@layer` 层叠层、`var()` 实际求值。
    //   · **下面三类在 Chromium 里实测过，是"逃过但无害"**（不是风险，别把它们当成待修的洞）：
    //     `html body .exp-hs-v > *{color:…}`、**不加**类垫脚的 `[class*=exp-hs]{color:…}`、
    //     `:root`/`html`/`body` 上的 `color:…!important`（后者只影响**继承**，而覆写是元素**自身**的声明
    //     ⇒ 继承不参与竞争，实测深色不变）。
    //   · **下面两条在 Chromium 里实测过、是"真的"能把深底画回浅绿**，都已收口：
    //     加类垫脚的 `[class*=exp-hs]`（形如 `html body .a.b [class*=exp-hs]`，已并入通道 ③）、
    //     行内 `style={{color:…}}`（连样式表都不在，⑧ 看不见 ⇒ 由下面的 ⑨ 按元素单独守）。
    //   · **特异度计算器**的建模边界写在 `specificityOf()` 自己的注释里（伪元素、函数式伪类、
    //     `:nth-child(An+B of S)`、转义还原等），并有用 5 个已知向量做体检的反空转断言。
    //   · `-webkit-text-fill-color` 与 `all:` 是按**保守方向**建模的（`fill-color` 非 currentColor 就判"赢"，
    //     因为它是**另一个属性**、覆写的 `color` 管不到它；`all:` 则按它自己那条规则的级联权重判），
    //     不是逐条模拟属性语义。
    // 这一整块的完整答案仍然是浏览器（或 jsdom + `getComputedStyle`）：⑧⑨ 只是把"最容易发生、且已被
    // 证明发生过"的那几类从"不可见"变成"判红"。
    /** 特异度三元组比较：`>0` 表示 a 比 b 更专。**逐列**比较，别只比类数（H5 的全部教训就在第三列）。 */
    const cmpSpec = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
    /**
     * 算特异度三元组 `[id, 类/属性/伪类, 类型/伪元素]`。选择器列表取**最大**分支（调用方实际是逐分支判，
     * 这里取最大只是为了打印/体检时有个确定值）。建模边界（写清楚，免得被当成完整实现）：
     *   · `.x` / `#x` / `[attr…]` / 普通伪类 `:hover` / `::before` —— 按规范记分；
     *   · 函数式伪类：`:where()` 记 0（规范如此）；其余（`:is()` `:not()` `:has()` `:nth-child(An+B of S)`…）
     *     一律记「伪类本身 1 分 + 内层各分支取**最大**」—— 对 `:is/:not/:nth-child(of)` 正是规范口径，
     *     对其余函数式伪类则是**多算**（保守方向：多算 ⇒ 更容易判"赢" ⇒ 更容易红，不会假绿）；
     *   · `*`、组合符、`,` 不记分；`::part()/::slotted()` 按伪元素记 1 分（不建模其内层）；
     *   · **标识符里的转义先还原**（N-2）：`html body .exp\-hs\-kv span.exp\-hs\-ok{color:#1a7f5a}` 在浏览器里
     *     就是 (0,2,3)、真的能把深底画回浅绿（Chromium 实测）；不还原的话，`\` 后面的 `hs`/`ok` 会被当成新的
     *     **类型选择器**数进去 ⇒ 三元组错、候选也匹配不上 token（转义是 N-2 这一条假绿的两半）。
     */
    const specificityOf = (rawSel) => {
      const calc = (text) => {
        let ids = 0, cls = 0, typ = 0, i = 0;
        while (i < text.length) {
          const c = text[i];
          if (c === '"' || c === "'") { let j = i + 1; while (j < text.length && text[j] !== c) j += 1; i = j + 2; continue; }
          if (c === '[') { // 属性选择器：第二列记 1 分（`body[data-ds-dark-theme]` 的 1 分就是从这来的），整体跳过
            let j = i + 1, q = null;
            for (; j < text.length; j += 1) {
              const d = text[j];
              if (q) { if (d === q) q = null; continue; }
              if (d === '"' || d === "'") { q = d; continue; }
              if (d === ']') break;
            }
            cls += 1; i = j + 1; continue;
          }
          if (c === '#') { ids += 1; i += 1; while (i < text.length && /[\w-]/.test(text[i])) i += 1; continue; }
          if (c === '.') { cls += 1; i += 1; while (i < text.length && /[\w-]/.test(text[i])) i += 1; continue; }
          if (c === ':') {
            const isElement = text[i + 1] === ':';
            i += isElement ? 2 : 1;
            const st = i;
            while (i < text.length && /[\w-]/.test(text[i])) i += 1;
            const name = text.slice(st, i).toLowerCase();
            if (text[i] === '(') { // 函数式伪类：取配平的整段内层
              let depth = 0, j = i;
              for (; j < text.length; j += 1) { if (text[j] === '(') depth += 1; else if (text[j] === ')') { depth -= 1; if (!depth) break; } }
              const inner = text.slice(i + 1, j);
              i = j + 1;
              if (isElement) { typ += 1; continue; }
              if (name === 'where') continue;
              let innerMax = [0, 0, 0];
              for (const part of inner.split(',')) { const sp = calc(part); if (cmpSpec(sp, innerMax) > 0) innerMax = sp; }
              cls += 1; ids += innerMax[0]; cls += innerMax[1]; typ += innerMax[2];
              continue;
            }
            if (isElement) { typ += 1; continue; }
            cls += 1; continue;
          }
          if (c === '*') { i += 1; continue; }
          if (/[A-Za-z_]/.test(c)) { typ += 1; i += 1; while (i < text.length && /[\w-]/.test(text[i])) i += 1; continue; }
          i += 1; // 组合符 / 空白 / `,` / `|`
        }
        return [ids, cls, typ];
      };
      return String(rawSel).split(',').map((part) => calc(cssUnescape(part))).reduce((a, b) => (cmpSpec(b, a) > 0 ? b : a), [0, 0, 0]);
    };
    /**
     * CSS 标识符转义还原（N-2）：`.exp\-hs\-ok` 与 `.exp-hs-ok` 在浏览器里是**同一个类**。
     * 为什么非有它不可（独立核验在 Chromium 里证明过这条假绿）：不还原的话 ① 候选匹配不上 token
     * （`\-` 把类名切断）⇒ 规则根本进不了候选；② 特异度里 `\` 之后的 `hs`/`ok` 被当成**类型选择器** ⇒
     * 三元组也是错的。**两处**都必须先还原再算。`\31 23` 这类十六进制写法也还原（`\31` → `1`）。
     */
    const cssUnescape = (s) => String(s).replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_, g) => (
      /^[0-9a-fA-F]/.test(g) ? String.fromCodePoint(parseInt(g.trim(), 16)) : g));
    /** 选择器里的**类名 token**（`.exp-hs-ok` → `exp-hs-ok`）：只认类选择器；属性选择器里的 `data-*` 不算。转义先还原。 */
    const classTokensOf = (sel) => [...cssUnescape(sel).matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]);
    /**
     * 候选分支里是否出现覆写选择器的某个**类名 token**，且是**整词**（`(?<![\w-])…(?![\w-])`）——
     * `.exp-hs-tag` 因此**不**匹配 `.exp-hs-tag-ok`（后者是更专的兄弟规则）。不限于类选择器：
     * token 出现在**属性值**里也算（`[class~=exp-hs-ok]` 真的能命中这些元素）。传进来的分支应已 `cssUnescape` 过。
     */
    const mentionsToken = (branch, tokens) => tokens.some((t) => new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(branch));
    /** `[class…=v]` 里那些 `v`（`~=` `^=` `*=` `$=` `|=` 与裸 `=` 都收）：`[class*=exp-hs]` 这种**前缀**写法也能命中。 */
    /**
     * 解析 `[class OP value]` 里的**操作符 / 值 / 大小写标志**。CSS 的匹配操作符一共就这六个：
     * `=`（精确）`~=`（空白分隔词，等价于"精确等于某一段"）`|=`（等于 `v` 或以 `v-` 开头）
     * `^=`（前缀）`$=`（后缀）`*=`（子串）。值可带双引号或单引号，操作符与值之间允许空白，
     * 末尾允许 `i` / `s` 标志。
     * ⚠️ **必须连操作符一起解析**（F1，2026-09-19 第五轮独立核验 + Chromium 实测）：只按"值是不是 token 的
     * **前缀**"判会漏掉**后缀**方向 —— `html body .a.b [class$=ok]{color:#1a7f5a}` 在浏览器里真的把深底上的
     * `.exp-hs-ok` 画回 rgb(26,127,90)，而当时 ⑧ **exit 0**（`ok` 既不是任何 token 的精确值、也不是它的前缀）。
     * 同一批实测还包含 `[class$=-ok]`、`[class*=-ok]`、`[class$="ok"]`、`[class$=tag]`、`[class$=msg]`、
     * `[class$=OK i]`（大小写标志）—— 全部画成浅绿。所以这里按操作符分别判，**六种一律保守收进候选**。
     */
    const classAttrMatchers = (branch) => [...branch.matchAll(/\[\s*class\s*([~^|*$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*(?:([is])\s*)?\]/gi)]
      .map((m) => ({ op: m[1], value: m[2] ?? m[3] ?? m[4] ?? '', flag: (m[5] || '').toLowerCase() }));
    /**
     * 该属性选择器**是否可能**命中某个 token（按上面六个操作符各自的判据；`i` 标志按大小写不敏感比）。
     * 边界（诚实写明）：判据比的是"**token 对 value**"，不是"真实 class 属性串对 value" ⇒ 对 `=`/`~=`/`|=`
     * 是**过报**（元素上可能还有别的类），方向安全。空值与 `^=`/`*=`/`$=` 组合按规范其实**匹配不到任何东西**
     * （Selectors 4），这里仍收进候选 ⇒ 只是过报，不会假绿。
     */
    const classAttrCouldMatch = (branch, tokens) => classAttrMatchers(branch).some(({ op, value: raw, flag }) => {
      const v = flag === 'i' ? raw.toLowerCase() : raw;
      return tokens.some((tk) => {
        const t = flag === 'i' ? tk.toLowerCase() : tk;
        if (op === '=' || op === '~=') return t === v;
        if (op === '^=') return t.startsWith(v);
        if (op === '*=') return t.includes(v);
        if (op === '$=') return t.endsWith(v);
        if (op === '|=') return t === v || t.startsWith(`${v}-`);
        return false; // 到不了（正则只认这六个操作符）
      });
    });
    /**
     * 分支的**主题**（最右复合选择器）是不是"没有任何类/属性/id/伪类约束"（`*` / `html body div` 这类）。
     * 这类规则只能靠 `!important` / `all:` / `-webkit-text-fill-color` 赢（第二列是 0 < 覆写的 ≥2），
     * 但**必须**进候选 —— 否则那三条判据对它们永远不可达（N-1 的教训）。
     * 例外（已实测）：`:root` / `html` / `body` 上的 `color:…!important` **改不到**这些元素
     * （important 在祖先上只影响**继承**，而覆写是元素**自身**的声明 ⇒ 继承不参与竞争，Chromium 实测深色不变）
     * ⇒ 把它们排掉，免得变成永久误报。
     */
    const bareSubject = (branch) => {
      const subj = (subjectOf(branch)[0] || '').trim();
      if (!subj || /[.#\[:]/.test(subj)) return false;
      if (/^(?:html|body)$/i.test(subj)) return false;
      return /^(?:\*|[a-z][\w-]*)$/i.test(subj);
    };
    /** 候选的**三条通道**（任一命中即算"可能命中同一元素"）：返回命中的理由，未命中返回空串。 */
    const couldMatchReason = (branch, tokens) => {
      if (mentionsToken(branch, tokens)) return 'token';
      if (classAttrCouldMatch(branch, tokens)) return '类属性选择器命中（= / ~= / |= / ^= / $= / *= 六种操作符都判，i 标志按大小写不敏感）';
      if (bareSubject(branch)) return '主题无类/属性约束（只能靠 !important / all: / fill-color 赢）';
      return '';
    };
    /** 规则体里最后一条 `color` 是否带 `!important`（覆写都没带 ⇒ 候选带了就**不论特异度**都赢）。 */
    const colorIsImportant = (body) => /(?:^|[;{])\s*color\s*:\s*[^;}]*!\s*important/.test(body);
    /** 规则体里最后一条某属性（`all:` 是含 color 的简写；`-webkit-text-fill-color` 决定文字实际着色）。 */
    const lastDeclOf = (body, prop) => {
      const hits = [...String(body).matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;}]+)`, 'g'))];
      return hits.length ? hits[hits.length - 1][1].trim() : null;
    };

    // ⑧ 的反空转（判据自身的体检）：特异度计算器在 6 个**已知答案**的向量上必须给出正确三元组 ——
    // 尤其第三列那条反例本身（(0,2,3) > (0,2,1)）、第 5 个**转义**向量（N-2：`\` 必须还原、
    // 不能把 `\` 之后的 `hs`/`ok` 当类型选择器数进去）、以及 `*` = (0,0,0)。
    // 计算器一旦退化（把属性选择器算成类型选择器、不认转义、或只用类数比较），下面的候选扫描就会变成
    // "看着在守"的空转。
    const specVectors = [
      ['body[data-ds-dark-theme] .exp-hs-ok', [0, 2, 1]],
      ['html body .exp-hs-kv span.exp-hs-ok', [0, 2, 3]],
      ['body[data-ds-dark-theme] .exp-hs-hist .exp-hs-tag-ok', [0, 3, 1]],
      ['.exp-hs-msg.bad', [0, 2, 0]],
      ['html body .exp\\-hs\\-kv span.exp\\-hs\\-ok', [0, 2, 3]],
      ['*', [0, 0, 0]],
    ];
    const badVectors = specVectors.filter(([s, want]) => cmpSpec(specificityOf(s), want) !== 0);
    check(badVectors.length === 0,
      '⑧ 反空转：特异度计算器在 6 个已知向量上给出正确的三元组（含 H5 的反例本身：属性选择器 (0,2,1) **输给** 三个类型选择器 (0,2,3)；以及 N-2 的转义写法必须还原成同一个类、`*` = (0,0,0)）',
      badVectors.length
        ? `算错 ${badVectors.length} 个：${badVectors.map(([s, w]) => `${s} 期望 ${w.join(',')} 实得 ${specificityOf(s).join(',')}`).join(' / ')}`
        : specVectors.map(([s]) => `${s}=(${specificityOf(s).join(',')})`).join('；'));

    const lockedDarkKeys = new Set(expected.map((e) => `${e.selector}{${e.decl}}`)); // 8 条本体（⑦ 已逐字锁死）
    const shadowThreats = [];
    let shadowExamined = 0; // 反空转用：真的被判过「可能命中同一元素」的候选分支数
    let ovLocated = 0;
    for (const [sel, decl] of DARK_INK) {
      const ovSel = `body[data-ds-dark-theme] ${sel}`;
      const ovRule = parsedRules.find((r) => r.selector === ovSel && r.body === decl);
      if (!ovRule) continue; // 覆写本体都找不到：⑦ 的「不多不少」会红，这里不重复报
      ovLocated += 1;
      const ovSpec = specificityOf(ovSel);
      const tokens = classTokensOf(ovSel);
      for (const r of parsedRules) {
        if (lockedDarkKeys.has(`${r.selector}{${r.body}}`)) continue; // 这 8 条彼此是设计好的细化关系，不是遮蔽
        const cVal = colorValueOf(r.body);
        const allReset = lastDeclOf(r.body, 'all');
        const fill = lastDeclOf(r.body, '-webkit-text-fill-color');
        if (cVal === null && allReset === null && fill === null) continue; // 不给文字上色的规则（如 `.exp-hs-v code`）直接出局
        // 带 `!important` 的 color/all/fill 声明**本身就是进候选的理由**（N-1 的教训：`!important` 以前只是
        // "已匹配候选之间的裁决者"，于是 `*{color:#1a7f5a!important}` 这种**连 token 都没有**的规则从不被审视：
        // 实测 exit 0，而 Chromium 里深底上的 `.exp-hs-ok` 被画回 rgb(26,127,90)）。理由：`!important` 赢了就是
        // 赢了，而**可达性只有浏览器答得了** ⇒ 一律当"可能命中"。代价（诚实写明）：本表今天有 **0 条**
        // `color:…!important` / `all:` / `-webkit-text-fill-color` 规则 ⇒ 不会误报；将来真加了一条**正当**的
        // `!important` 配色，本检查会红 —— 那正是要人来看一眼的地方（去掉 `!important`，或显式证明它匹配不到这 8 类元素）。
        const impDecl = colorIsImportant(r.body) || /(?:^|[;{])\s*(?:all|-webkit-text-fill-color)\s*:\s*[^;}]*!\s*important/.test(r.body);
        for (const branchRaw of String(r.selector).split(',')) {
          const branch = cssUnescape(branchRaw); // 转义先还原，再匹配 token、再算特异度（N-2 的两半）
          const matchReason = couldMatchReason(branch, tokens) || (impDecl ? '带 !important 的 color/all/fill 声明' : '');
          if (!matchReason) continue;
          shadowExamined += 1;
          const spec = specificityOf(branch);
          const ord = cmpSpec(spec, ovSpec);
          const imp = colorIsImportant(r.body) || /(?:^|[;{])\s*all\s*:\s*[^;}]*!\s*important/.test(r.body);
          const later = r.pos > ovRule.pos;
          const why = [];
          // `-webkit-text-fill-color` 与 `color` 是**两个属性**：只要候选设了它（非 currentColor），覆写那条 `color`
          // 就管不到文字实际着色 ⇒ 与特异度无关，直接判"赢"（保守方向）。
          if (fill !== null && fill.replace(/\s/g, '').toLowerCase() !== 'currentcolor') why.push(`-webkit-text-fill-color:${fill}（与 color 是两个属性，它一出现就决定文字实际着色）`);
          // `all:` 是含 color 的简写 ⇒ 按它自己这条规则的级联权重判（不是无条件赢）。
          if (allReset !== null && (imp || ord > 0 || (ord === 0 && later))) why.push(`all:${allReset}`);
          if (cVal !== null) {
            if (imp) why.push(`color:${cVal} 带 !important 而覆写没带 ⇒ 不论特异度都赢`);
            else if (ord > 0) why.push(`特异度 (${spec.join(',')}) > 覆写 (${ovSpec.join(',')})`);
            else if (ord === 0 && later) why.push(`同特异度 (${spec.join(',')}) 且源码更靠后（pos ${r.pos} > ${ovRule.pos}）`);
          }
          if (why.length) shadowThreats.push(`覆写 ${ovSel} ← ${branch}{${r.body}}［${why.join('；')}｜进候选理由：${matchReason}${r.top ? '' : '；⚠️这条还在 @media/@supports 块里（块内规则看条件是否成立）'}］`);
        }
      }
    }
    // 反空转 ×2：8 条覆写本体都定位到（否则算不出源码位置、顺序判据空转）；候选扫描真的扫过 ≥12 个分支
    // （真实表实测 16；扫到 0 条也会"绿" ⇒ 那是空转）。低于阈值要**显式**改这个数字，改绿不是静默的。
    check(ovLocated === DARK_INK.length && shadowExamined >= 12,
      '⑧ 反空转：9 条覆写的**规则本体**都定位到了（拿不到本体就算不出它的源码位置 ⇒ 顺序判据会空转），且候选扫描真的扫过 ≥12 个"可能命中同一元素且声明 color/all/fill"的分支（扫到 0 条也会绿，那是空转）',
      `定位 ${ovLocated}/${DARK_INK.length}；扫到候选分支 ${shadowExamined} 个`);
    check(shadowThreats.length === 0,
      '⑧（H5）9 条深色覆写**逐条**都没有被任何规则赢过 —— 判据不再看"带不带 `body[data-ds-dark-theme]` 前缀"，而是对每条覆写扫**全部**声明 `color`（或 `all:` / `-webkit-text-fill-color`）、且选择器**可能**命中同一元素的规则，要求没有一条在「特异度更高 / 同特异度但源码更靠后 / 带 !important」上赢过它（`html body .exp-hs-kv span.exp-hs-ok{color:#1a7f5a}` 这类**无前缀**规则 = (0,2,3) > (0,2,1)，正是旧口径看不见的那一类）',
      shadowThreats.length
        ? `被赢过 ${shadowThreats.length} 处：${shadowThreats.join(' / ')}`
        : `扫过 ${shadowExamined} 条候选分支（启发式可能命中），无一条能赢过它对应的覆写`);

    // ⑨（N-3）**行内样式闸**：⑧ 分析的是样式表，而 `style={{color:…}}` 连样式表都不在 —— 行内声明直接赢过
    // 任何**非 important** 的样式表声明。Chromium 实测：给挂着 `.exp-hs-ok` 的那个 <span> 加
    // `style.color='#1a7f5a'` ⇒ 深色底上画出 rgb(26,127,90)（正是 ⑦e 要防的那个回归）。
    // 但 client.js 的 JS/JSX 侧**本来就有 30 处行内 color**（DAG 状态元数据、面板小字…）⇒ 不能一刀切禁掉行内色，
    // 只能**按元素**判：谁挂着这 8 个墨水类里的类名，谁的 props 里就不许带行内色。做法（纯文本、可复算）：
    //   · 扫 JS/JSX 侧每一处 `className:`；往上取最近的 `{`（= 该元素的 props 对象）并配平出它的范围；
    //   · 判这个 props 是不是"目标元素"：props 文本里有目标类名字面量，**或** `className: X` 里的 `X` 是标识符、
    //     且它最近一次 `var X = …` 赋值里含目标类名字面量（本文件两处间接挂点 `var cls = …` 正是这样）；
    //   · 是目标 ⇒ props 里有 `style` 时：值是对象字面量且含 `color` / `-webkit-text-fill-color` / `all` ⇒ 红；
    //     值不是对象字面量（判不了）⇒ **也红**（本仓纪律：抽不到不是"跳过"，是"判据失效"）。
    // 边界（诚实写明）：只覆盖"挂在元素**自己**身上"的行内样式。经 `setAttribute('style',…)` / `Object.assign`、
    // 祖先上的行内色（只影响**继承**，覆写是元素自身声明 ⇒ 不参与竞争）、以及 `className` 由别的表达式算出
    // （既不是字面量、也不是 `var X = <含字面量>`）三条路**不覆盖**。
    const stripJsComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const cssAt = cliSrc.indexOf('var CSS =');
    const cssStop = cliSrc.indexOf('// ── session store', cssAt);
    const jsSide = (cssAt < 0 || cssStop < 0) ? '' : stripJsComments(cliSrc.slice(0, cssAt) + cliSrc.slice(cssStop));
    check(jsSide.length > 10000,
      '⑨ 反空转：能切出 JS/JSX 侧源码（切不出来必须红 —— 否则下面"按元素扫行内样式"会变成空转）',
      `len=${jsSide.length}`);
    /** 从 `t[i]`（必须是 open）出发，返回与之配平的 close 下标；跳过 '…' / "…" / 模板串。找不到返回 -1。 */
    const matchPair = (t, i, open, close) => {
      let depth = 0;
      for (let j = i; j < t.length; j += 1) {
        const c = t[j];
        if (c === "'" || c === '"' || c === '`') { let k = j + 1; while (k < t.length && t[k] !== c) { if (t[k] === '\\') k += 1; k += 1; } j = k; continue; }
        if (c === open) depth += 1;
        else if (c === close) { depth -= 1; if (depth === 0) return j; }
      }
      return -1;
    };
    // 目标**元素**类名：8 条覆写的主题（最右复合选择器）里的类名，只要 `exp-hs-` 前缀
    // （`bad` / `danger` 是同一元素上的附加类，不是独立挂点 —— 它们由含 token 的那条挂点一起覆盖）。
    const inkClasses = [...new Set(DARK_INK.flatMap(([sel]) => classTokensOf(subjectOf(sel)[0] || sel)).filter((t) => /^exp-hs-/.test(t)))];
    const inlineThreats = [];
    let inkMounts = 0; // 反空转：真的认出了几个"挂着这 8 类之一"的渲染位点
    for (let at = jsSide.indexOf('className:'); at >= 0; at = jsSide.indexOf('className:', at + 1)) {
      // props 对象 = 从 `className:` **往前**找那个**还没闭合**的 `{`：用深度记账跳过已经闭合的内层对象
      // （典型：写在 className 前面的 `style: { … }`）。⚠️ 不能用"最近的 `{`"——那会认成 style 对象本身，
      // 于是 `{ style: { color: … }, className: 'x' }` 这种**行内样式写在前面**的写法直接漏掉（本文件试过，漏了一次注入）。
      // 也不用"全文一次性配平"：那个做法会被 client.js 里的**正则字面量**（引号在 `/…/` 里）骗到，扫到一半就断。
      let propsOpen = -1, depthBack = 0;
      for (let j = at - 1; j >= 0 && at - j < 4000; j -= 1) {
        const c = jsSide[j];
        if (c === '}') depthBack += 1;
        else if (c === '{') { if (depthBack === 0) { propsOpen = j; break; } depthBack -= 1; }
      }
      if (propsOpen < 0) continue; // 认不出 props 对象 ⇒ 不静默编一个：反空转（位点数）会把口径失效暴露出来
      const propsClose = matchPair(jsSide, propsOpen, '{', '}');
      if (propsClose < 0) continue;
      const propsText = jsSide.slice(propsOpen, propsClose + 1);
      const valFrom = at - propsOpen + 'className:'.length;
      // `className:` 的值：到 props 对象里第一个**顶层** `,`（或对象结尾）
      let vEnd = propsText.length - 1;
      for (let j = valFrom, depth = 0; j < propsText.length; j += 1) {
        const c = propsText[j];
        if (c === "'" || c === '"' || c === '`') { let k = j + 1; while (k < propsText.length && propsText[k] !== c) { if (propsText[k] === '\\') k += 1; k += 1; } j = k; continue; }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') { if (depth === 0) { vEnd = j; break; } depth -= 1; }
        else if (c === ',' && depth === 0) { vEnd = j; break; }
      }
      const valText = propsText.slice(valFrom, vEnd).trim();
      let isInk = inkClasses.some((t) => mentionsToken(propsText, [t]));
      if (!isInk && /^[A-Za-z_$][\w$]*$/.test(valText)) { // 间接挂点：`var cls = …含目标类字面量…`
        const assignAt = jsSide.lastIndexOf(`var ${valText} =`, at);
        if (assignAt >= 0) {
          const nl = jsSide.indexOf('\n', assignAt);
          const assignLine = jsSide.slice(assignAt, nl < 0 ? jsSide.length : nl);
          isInk = inkClasses.some((t) => mentionsToken(assignLine, [t]));
        }
      }
      if (!isInk) continue;
      inkMounts += 1;
      const styleM = /(?:^|[,{\s])style\s*:/.exec(propsText);
      if (!styleM) continue; // 这个元素没有行内样式 ⇒ 行内色不可能来自它
      let vStart = styleM.index + styleM[0].length;
      while (vStart < propsText.length && /\s/.test(propsText[vStart])) vStart += 1;
      let styleVal = null;
      if (propsText[vStart] === '{') {
        const e = matchPair(propsText, vStart, '{', '}');
        styleVal = e < 0 ? null : propsText.slice(vStart, e + 1);
      } else {
        styleVal = propsText.slice(vStart, vEnd < propsText.length - 1 ? vEnd : propsText.length);
      }
      const hasInk = styleVal !== null && /(?:^|[,{\s])(?:color|-webkit-text-fill-color|all)\s*:/.test(styleVal);
      if (hasInk) inlineThreats.push(`${valText}：style ${styleVal.slice(0, 90)}`);
      else if (propsText[vStart] !== '{') inlineThreats.push(`${valText}：style 不是对象字面量，判不了 ⇒ 宁可误报：${String(styleVal).slice(0, 60)}`);
    }
    check(inkMounts >= 12,
      '⑨ 反空转：真的认出了 ≥12 个"挂着这 9 个墨水类之一"的渲染位点（本轮实测 21；并发改动后一度到 24 —— 阈值 12 留足余量；认不出就说明扫描口径失效，下面那条会空转）',
      `认出 ${inkMounts} 个位点`);
    check(inlineThreats.length === 0,
      '⑨（N-3）这 9 个墨水类**挂在哪个元素上，那个元素就不带行内 color**（行内声明直接赢过任何非 important 的样式表声明 ⇒ ⑧ 看不见它；client.js 里另有 30 处行内 color 用在**别的**组件上，所以这里按元素判、不一刀切）',
      inlineThreats.length ? `${inlineThreats.length} 处行内色：${inlineThreats.join(' / ')}` : `扫过 ${inkMounts} 个目标渲染位点，props 里都没有行内 color`);
  }
}


// ── ⑩ Midas 一期（2026-09-19）：分层发现 / `- insert:` 补丁行 / 五态就绪 / 首装引导 ────────────
// 为什么单开一大节：这一期把 `midas` 从"只存值"变成"真的写补丁行 + 五态自检 + 首装引导"，而它
// **跨了四个层次**（路径发现 / YAML 补丁行 / 状态机 / 两端接线），每一层都有各自的失败模式：
//   · 发现层：找不到就静默 → 用户以为换过去了（假接通）；
//   · 补丁层：`- insert:` 少了 → dsh 只打一行 warn 就跳过（**界面全绿、记忆不动**）；
//   · 状态层：把"探测不可用"说成"没装"（两种零混成一件事）；
//   · 接线层：客户端硬编一份命令 → 与 profile 名分叉（同一件事两个家）。
// 下面把这四条逐条钉住。所有 Midas 判定一律**注入发现结果** —— 宿主上装没装 midas 不许影响断言。
console.log('\n⑩ Midas 一期：分层发现 / - insert: 补丁行 / 五态就绪 / 首装引导（命令由服务端下发）');
{
  // ① 常量与事实不分叉
  check(MIDAS_PACKAGE === 'midas-memory-mcp' && MIDAS_BIN_NAME === 'midas-mcp',
    '包名/ bin 名（事实来源：包自己的 package.json 与 bin 声明）', `${MIDAS_PACKAGE} / ${MIDAS_BIN_NAME}`);
  check(MIDAS_DB_ENV === 'MIDAS_MCP_DB' && MIDAS_NO_WARNINGS_ENV === 'NODE_NO_WARNINGS',
    '两个关键 env 名（DB **没有默认值**；NODE_NO_WARNINGS 消掉每次 spawn 的实验性警告）', `${MIDAS_DB_ENV} / ${MIDAS_NO_WARNINGS_ENV}`);
  check(MIDAS_MCP_CLIENT_PACKAGE === '@deepseek-ai/dsh-mcp-client' && MIDAS_PATCH_ROW_ID === 'mcp-midas' && MIDAS_SERVER_NAME === 'midas',
    'MCP 客户端包名 / 补丁行 id / serverName（serverName 必须匹配 loader 的 `/^[A-Za-z0-9_-]{1,32}$/`）', '');
  check(MIDAS_STATUS_KINDS.join(',') === 'midas-ready,midas-needs-mcp-client,midas-not-installed,midas-start-failed,unknown' && Object.isFrozen(MIDAS_STATUS_KINDS),
    '五态值域固定且被冻结（与需求表逐条对应；多一个少一个都红）', MIDAS_STATUS_KINDS.join(','));
  check(MIDAS_INSTALL_COMMAND === 'npm i -g midas-memory-mcp', '安装命令只有一个家（README / llms.txt / 引导步骤都引它这一个事实）', MIDAS_INSTALL_COMMAND);

  // ② DB 路径与 profile 名（两级覆写，与本模块既有惯例同源）
  check(midasDbPath({ env: {}, home: '/tmp/h1' }) === join('/tmp/h1', '.dsh', 'storages', 'midas', 'memory.sqlite3'),
    'DB 路径默认：<home>/.dsh/storages/midas/memory.sqlite3（用户批准的决定）', midasDbPath({ env: {}, home: '/tmp/h1' }));
  check(midasDbPath({ env: { [DSH_HOME_ENV]: '/tmp/dsh2' }, home: '/tmp/h1' }) === join('/tmp/dsh2', 'storages', 'midas', 'memory.sqlite3'),
    `${DSH_HOME_ENV} 覆写 dsh home（与补丁路径**同一份**解析，不各写一遍）`, '');
  check(midasDbPath({ env: { [DSH_HOME_ENV]: '   ' }, home: '/tmp/h1' }) === join('/tmp/h1', '.dsh', 'storages', 'midas', 'memory.sqlite3'),
    'DSH_HOME 是空白串 ⇒ 按未设置算（与 profilePatchPath 同一口径）', '');
  check(memoryProfileName({ env: {} }) === 'web' && memoryProfileName({ env: { [DSH_PROFILE_ENV]: 'work' } }) === 'work',
    'profile 名真源（安装命令必须用它，否则会把包装进另一个 profile）', '');
  check(midasInstallDir('/x/midas-memory-mcp/dist/bin/midas-mcp.js') === '/x/midas-memory-mcp'
    && midasInstallDir('/usr/local/bin/midas-mcp') === '/usr/local/bin',
    'cwd 推导：`<pkg>/dist/bin/*.js` ⇒ `<pkg>`；认不出这个形状就退回父目录', '');

  // ③ 候选清单的**层与顺序**（顺序即优先级）
  const cands = midasBinaryCandidates({
    env: { [MIDAS_BIN_ENV]: '/env/bin/midas-mcp', PATH: '/p1:/p2', [DSH_HOME_ENV]: '/dh' },
    home: '/h', workspace: '/ws', globalPrefix: '/gp',
  });
  const vias = cands.map((c) => c.via);
  check(cands[0].via === `env:${MIDAS_BIN_ENV}` && cands[0].path === '/env/bin/midas-mcp',
    '第①层：`MIDAS_MCP_BIN`（用户显式覆写）——最高优先级', vias.join(' > '));
  check(cands[1].via === 'npm-global' && cands[1].path === join('/gp', 'bin', 'midas-mcp'),
    '第②层：由 `npm prefix -g` 推出 `<prefix>/bin/midas-mcp`（⚠️ 不能再用 npm 11 已删除的 `npm bin -g`）', cands[1] && cands[1].path);
  check(vias.indexOf('dsh-home') === 2 && vias.indexOf('workspace') === 3,
    '第③层：显式候选（$DSH_HOME/midas、<工作区>/.midas-runtime）排在 PATH 之前', vias.slice(2, 4).join(' > '));
  check(vias.includes('fixed:/opt/homebrew/bin') && vias.includes('fixed:/usr/local/bin'),
    '第③层还含两个固定位置（/opt/homebrew/bin、/usr/local/bin）', '');
  check(cands.filter((c) => c.via === 'path').length === 2 && vias.indexOf('path') === vias.lastIndexOf('path') - 1,
    '第④层：逐个 PATH 目录扫裸名字（本例 /p1、/p2 两条，且都排在显式候选之后）', JSON.stringify(cands.filter((c) => c.via === 'path')));
  check(!vias.some((v) => /require/.test(v)),
    '`require.resolve` **不在**候选清单里（它只作最后一层兜底：Node 只从本插件目录向上找 ⇒ 找不到全局安装）', '');
  check(midasBinaryCandidates({ env: {}, home: '/h' }).length >= 2,
    'env 里没有 PATH 也不抛（退回剩下那些显式候选）', String(midasBinaryCandidates({ env: {}, home: '/h' }).length));

  // ④ 分层发现：注入 io（不碰真实文件系统、不跑 npm、不 require）
  const d1 = await discoverMidasBinary({
    env: { [MIDAS_BIN_ENV]: '/fake/midas-mcp' }, home: '/h',
    io: { isFile: async (p) => p === '/fake/midas-mcp' }, getGlobalPrefix: async () => '',
  });
  check(d1.found === true && d1.path === '/fake/midas-mcp' && d1.via === `env:${MIDAS_BIN_ENV}` && d1.probeOk === true,
    '第一层命中即停，并**如实报 via**（凭什么认为它在）', `${d1.via} / ${d1.path}`);
  const d2 = await discoverMidasBinary({
    env: {}, home: '/h', io: { isFile: async () => false, resolvePackage: () => null }, getGlobalPrefix: async () => '/gp',
  });
  check(d2.found === false && d2.probeOk === true && d2.tried.some((t) => t.indexOf('npm-global: /gp/bin/midas-mcp') === 0) && d2.tried.length > 2,
    '全都没找到 ⇒ found:false + `probeOk:true`（**可以**下"没装"的结论）+ tried 逐条列出找过哪里', `tried=${d2.tried.length} 条`);
  const d3 = await discoverMidasBinary({
    env: {}, home: '/h', io: { isFile: async () => { throw new Error('EACCES'); }, resolvePackage: () => null }, getGlobalPrefix: async () => null,
  });
  check(d3.found === false && d3.probeOk === false,
    '**所有**存在性检查都失败 ⇒ `probeOk:false`（调用方不得据此说"没装" ⇒ 归 unknown）', `probeOk=${d3.probeOk}`);
  const d4 = await discoverMidasBinary({
    env: {}, home: '/h', io: { isFile: async () => false, resolvePackage: () => '/req/midas-memory-mcp/dist/bin/midas-mcp.js' }, getGlobalPrefix: async () => '',
  });
  check(d4.found === false && d4.tried.some((t) => /^require: /.test(t)),
    'require 层排在**最后**：前面都没命中才会试它，且它的失败也进 `tried`（不静默）', d4.tried.slice(-1)[0]);
  const d5 = await discoverMidasBinary({
    env: {}, home: '/h',
    io: { isFile: async (p) => p === '/req/midas-memory-mcp/dist/bin/midas-mcp.js', resolvePackage: () => '/req/midas-memory-mcp/dist/bin/midas-mcp.js' },
    getGlobalPrefix: async () => '',
  });
  check(d5.found === true && d5.via === 'require', 'require 层命中时 `via=require`（诚实标出来源，便于排查）', d5.via);
  const d6 = await discoverMidasBinary({
    env: { [MIDAS_BIN_ENV]: '/link/midas-mcp' }, home: '/h',
    io: { isFile: async () => true, realpath: async () => '/real/midas-memory-mcp/dist/bin/midas-mcp.js' }, getGlobalPrefix: async () => '',
  });
  check(d6.path === '/link/midas-mcp' && d6.realPath === '/real/midas-memory-mcp/dist/bin/midas-mcp.js'
    && midasInstallDir(d6.realPath) === '/real/midas-memory-mcp',
    '软链场景：`path` 是找到的那条（诚实）、`realPath` 用来推 cwd（否则 cwd 会落在 bin 目录或软链目录上）', '');

  // ⑤ 同步轻量探针（加载期那条推荐插件自检用；**不 spawn 任何进程**）
  const syncHit = probeMidasBinarySync({ env: { [MIDAS_BIN_ENV]: '/fake/midas-mcp' }, home: '/h', io: { isFileSync: (p) => p === '/fake/midas-mcp' } });
  check(syncHit.found === true && syncHit.via === `env:${MIDAS_BIN_ENV}` && syncHit.probeOk === true && syncHit.layer === 'sync',
    '同步探针命中：同样报 via/probeOk（与异步发现同一套语义）', `${syncHit.via}`);
  const syncMiss = probeMidasBinarySync({ env: {}, home: '/h', workspace: '/ws', io: { isFileSync: () => false } });
  check(syncMiss.found === false && syncMiss.probeOk === true,
    '同步探针确定不存在 ⇒ `probeOk:true`（这一档才允许说"没装"）', `tried=${syncMiss.tried.length} 条`);
  const syncBlind = probeMidasBinarySync({ env: {}, home: '/h', io: { isFileSync: () => { throw new Error('EACCES'); } } });
  check(syncBlind.found === false && syncBlind.probeOk === false, '同步探针全失败 ⇒ `probeOk:false`（不假装知道）', '');

  // ⑥ 补丁行：形状逐字 / `- insert:` 包裹 / 幂等 / 拒绝不完整输入 / 不制造裸顶层行
  const rowLines = midasPatchRowLines({
    binPath: '/fake/midas-memory-mcp/dist/bin/midas-mcp.js', installDir: '/fake/midas-memory-mcp', dbPath: '/u/.dsh/storages/midas/memory.sqlite3',
  });
  check(JSON.stringify(rowLines) === JSON.stringify([
    '- insert:',
    `    - id: ${MIDAS_PATCH_ROW_ID}`,
    `      name: '${MIDAS_MCP_CLIENT_PACKAGE}'`,
    '      config:',
    "        transport: 'stdio'",
    `        serverName: '${MIDAS_SERVER_NAME}'`,
    "        command: 'node'",
    '        args:',
    "          - '/fake/midas-memory-mcp/dist/bin/midas-mcp.js'",
    "        cwd: '/fake/midas-memory-mcp'",
    '        env:',
    `          ${MIDAS_DB_ENV}: '/u/.dsh/storages/midas/memory.sqlite3'`,
    `          ${MIDAS_NO_WARNINGS_ENV}: '1'`,
  ]), '补丁行**逐字**钉住：`- insert:` 包裹 + command=node + 绝对路径 args + 显式 cwd + MIDAS_MCP_DB + NODE_NO_WARNINGS（值是**字符串** \'1\'，不是数字 —— loader 的 `env` 是 `dict(String)`）', JSON.stringify(rowLines.slice(0, 3)));
  const midasOpts = { midas: { binPath: '/fake/midas-memory-mcp/dist/bin/midas-mcp.js', installDir: '/fake/midas-memory-mcp', dbPath: '/u/.dsh/storages/midas/memory.sqlite3' } };
  const p1 = planMemoryBackendPatch(REAL_PATCH, 'midas', midasOpts);
  check(p1.ok && p1.changed && p1.text.startsWith(REAL_PATCH) && midasRowInText(p1.text) && !topLevelMidasRowInText(p1.text),
    'midas + 发现到二进制 ⇒ 追加**规范的 insert 行**，其余内容逐字保留，且**不产生**裸顶层行', '');
  const p2 = planMemoryBackendPatch(p1.text, 'midas', midasOpts);
  check(p2.ok && p2.changed === false && p2.text === p1.text, '再跑一次 ⇒ changed:false 且文本逐字不变（幂等：不许每保存一次就写一次盘）', '');
  const p3 = planMemoryBackendPatch(p1.text, 'midas', { midas: { ...midasOpts.midas, binPath: '/other/midas-memory-mcp/dist/bin/midas-mcp.js' } });
  check(p3.ok && p3.changed && /\/other\/midas-memory-mcp/.test(p3.text) && (p3.text.match(/- id: mcp-midas/g) || []).length === 1,
    '路径变了 ⇒ **整块替换**那一行（行 id 是本模块的），绝不会冒出第二个同名行', '');
  const p4 = planMemoryBackendPatch(REAL_PATCH, 'midas', { midas: { binPath: '', installDir: '', dbPath: '' } });
  check(p4.ok === false && p4.text === null && /缺一不可/.test(p4.errors.join('')),
    '三要素缺任一 ⇒ **拒绝写入**（写一条缺 DB 的行等于让记忆悄悄蒸发；写一条缺路径的行等于假接通）', p4.errors[0]);
  // ⚠️ 这一格**改写过**（二期）：旧夹具是 `- id: hidden` + `disabled: true`，而 `hidden` **不是**
  // `hindsight` ⇒ 它从来没有走到"Hindsight 那一行"的分支上，"顺手清掉禁用"那句断言于是**恒真**（空转：
  // 那两条 check 在旧夹具上无论实现怎么改都绿）。新语义下 `midas` **已接线**这一档的动作恰好相反
  // ——**置为禁用**（真二选一）—— 所以夹具必须是真的 `- id: hindsight` 行，断言的是"禁用被**设置**了、
  // 且 MCP 行在场"。反面（未接线 ⇒ 恢复启用）由 ⑥ 那一组守着；两条合起来才是完整契约。
  const p5 = planMemoryBackendPatch('- id: hindsight\n  disabled: false\n  name: someone-elses-row\n', 'midas', midasOpts);
  check(p5.ok && p5.changed && hindsightDisabledIn(p5.text),
    'midas（已接线）⇒ 把**真的** `hindsight` 行置为禁用（配了真夹具 ⇒ 不再是恒真的空转断言）', JSON.stringify(p5.text));
  check(p5.text !== null && midasRowInText(p5.text) && /name: someone-elses-row/.test(p5.text),
    'midas（已接线）⇒ MCP 行在场，且那一行**别的键原样保留**（只改 disabled 这一个值，不整行删）', '');
  const topOnly = '- id: mcp-midas\n  name: x\n- id: other\n  disabled: false\n';
  const p6 = planMemoryBackendPatch(topOnly, 'midas', midasOpts);
  check(p6.ok && midasRowInText(p6.text) && (p6.notes || []).some((n) => /顶层/.test(n)),
    '补丁里只有**顶层** `- id: mcp-midas`（那种写法被 dsh 静默跳过）⇒ 插入规范的 insert 行 + 如实说明那一行不生效', '');
  check(planMemoryBackendPatch(topOnly, 'midas', midasOpts).ok === false || findMidasInsertRow(topOnly) === null,
    '`findMidasInsertRow()` **不把顶层写法当成"那一行在"**（否则状态会说已接通，而 dsh 会跳过它）', '');
  // 缩进：已有的 insert 块在 2 空格缩进（合法 YAML），我们沿用它、且**不碰兄弟行**
  const reindentFixture = '- insert:\n  - id: mcp-midas\n    name: old\n  - id: sibling\n    name: s\n';
  const p7 = planMemoryBackendPatch(reindentFixture, 'midas', midasOpts);
  check(p7.ok && p7.changed && /^  - id: sibling\n    name: s$/m.test(p7.text) && /^  - id: mcp-midas$/m.test(p7.text),
    '替换已有行时**沿用它在块内的缩进**，兄弟行一个字都不动（缩进是那个 insert 块的约定）', '');
  const p8 = planMemoryBackendPatch(p7.text, 'midas', midasOpts);
  check(p8.changed === false && p8.text === p7.text, '缩进不同也一样幂等（第二次 changed:false）', '');

  // ⑦ 五态就绪：纯函数逐态 + 端到端（apply → read）
  const base = { mcpClientInstalled: true, patchRowPresent: true, patchReadable: true, start: null, lookedAt: '/x' };
  const cases = [
    [{ ...base, bin: MIDAS_ABSENT }, 'midas-not-installed'],
    [{ ...base, bin: MIDAS_FOUND, mcpClientInstalled: false }, 'midas-needs-mcp-client'],
    [{ ...base, bin: MIDAS_FOUND }, 'midas-ready'],
    [{ ...base, bin: MIDAS_FOUND, start: { ok: false, error: '进程提前退出（code=3）', stderr: 'Cannot find module node:sqlite' } }, 'midas-start-failed'],
    [{ ...base, bin: MIDAS_BLIND }, 'unknown'],
    [{ ...base, bin: MIDAS_FOUND, mcpClientInstalled: null }, 'unknown'],
    [{ ...base, bin: MIDAS_FOUND, patchRowPresent: false }, 'unknown'],
  ];
  for (const [input, want] of cases) {
    const got = classifyMidasReadiness(input);
    check(got.kind === want && MIDAS_STATUS_KINDS.includes(got.kind),
      `五态：${want}（输入 ${JSON.stringify({ found: input.bin.found, probeOk: input.bin.probeOk, client: input.mcpClientInstalled, row: input.patchRowPresent, start: !!(input.start && input.start.ok === false) })}）`,
      got.kind);
  }
  const unknownDisp = classifyMidasReadiness({ ...base, bin: MIDAS_BLIND });
  check(!/已接通/.test(unknownDisp.zh) && /不给结论|不假装知道/.test(unknownDisp.zh),
    'unknown 那一档**不给结论**（既不说"已接通"，也不把探测故障说成"没装"）', unknownDisp.zh.slice(0, 30));
  const failedDisp = classifyMidasReadiness({ ...base, bin: MIDAS_FOUND, start: { ok: false, error: '进程提前退出（code=3）', stderr: 'Cannot find module node:sqlite' } });
  check(failedDisp.level === 'bad' && /node:sqlite/.test(failedDisp.zh),
    'start-failed 那一档带上**stderr 摘要**（"装了但起不来"必须给出线索，否则用户只能猜）', failedDisp.zh.slice(-40));

  // 端到端：apply 真的写行 + 建 DB 目录 → read 得出 midas-ready
  const e2e = await makeHome(REAL_PATCH);
  const e2eEnv = {};
  const applied = await applyMemoryBackend({ backend: 'midas', env: e2eEnv, home: e2e.root, midas: MIDAS_FOUND });
  const onDisk = await readFile(e2e.patchPath, 'utf8');
  check(applied.ok && applied.saved && applied.notWired === false && applied.midas && applied.midas.binaryFound === true,
    'apply（二进制已发现）⇒ 真写盘 + `notWired:false`（**不再**一律说"未接通"）', `saved=${applied.saved} notWired=${applied.notWired}`);
  check(midasRowInText(onDisk) && onDisk.startsWith(REAL_PATCH), '盘上的补丁含 `- insert:` 包裹的 mcp-midas 行，且原有内容逐字保留', '');
  check(/MIDAS_MCP_DB: '/.test(onDisk) && /NODE_NO_WARNINGS: '1'/.test(onDisk) && /command: 'node'/.test(onDisk),
    '盘上的行**确实**带 MIDAS_MCP_DB / NODE_NO_WARNINGS / command=node（不是只在纯函数里对）', '');
  const dbDir = dirname(midasDbPath({ env: e2eEnv, home: e2e.root }));
  let dbDirIsDir = false;
  try { dbDirIsDir = (await stat(dbDir)).isDirectory(); } catch { dbDirIsDir = false; }
  check(applied.midas.dbDirReady === true && dbDirIsDir,
    'DB **目录**在切换时就建好（SQLite 要在里面写 -wal/-shm；Midas 起不来时不会报错，而是回落内存存储）', dbDir);
  check(!/memory\.sqlite3$/.test('') && !(await readFile(e2e.patchPath, 'utf8')).includes('sqlite3-wal'),
    '绝不把 `.sqlite` 文件本身交给原子字符串写入口（那会把数据库写坏）—— 补丁里只有路径', '');
  check(/^\s{10}- '\//m.test(onDisk),
    '盘上 `args:` 里那条是**绝对路径**（以 `/` 开头）—— 裸名字会随 Node 版本切换而静默离开 PATH（本机 `node/current` 就是两跳软链）', '');
  check(!/^\s{10}- '\s*midas-mcp/m.test(onDisk) && !/args: \[\]/.test(onDisk),
    '绝不出现"裸名字 + 空 args"那种写法（那等于把"能不能启动"交给 PATH 碰运气）', '');
  const reApply = await applyMemoryBackend({ backend: 'midas', env: e2eEnv, home: e2e.root, midas: MIDAS_FOUND });
  check(reApply.changed === false && reApply.saved === false && reApply.notWired === false,
    '再选一次 ⇒ 无改动、未写盘，但仍如实报 `notWired:false`（那一行已经在盘上 ⇒ 它是接通的）', JSON.stringify({ changed: reApply.changed, notWired: reApply.notWired }));
  const ready = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: e2eEnv, home: e2e.root, midas: MIDAS_FOUND, mcpClientInstalled: true });
  check(ready.statusKind === 'midas-ready' && ready.notWired === false && ready.display.level === 'ok' && ready.midasSetup.ready === true,
    'apply 之后回读 ⇒ `midas-ready` / notWired:false（"写进去了"与"读出来是就绪"两端对齐）', ready.statusKind);
  // 新增（**这条就是那个 latent bug 的看门人**）：五态里确实就绪时，`effective` 才允许是 `midas`。
  // 只判 `notWired === false` 不够 —— 旧实现在这里会回 `hindsight`（根本没读 `stored`/`notWired`）。
  check(ready.effective === 'midas',
    'midas 就绪（二进制 + MCP 客户端 + 补丁行都在）⇒ effective=midas（"现在到底走哪个后端"必须真的回答 midas）',
    `effective=${ready.effective} statusKind=${ready.statusKind} notWired=${ready.notWired}`);
  const oneStep = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: e2eEnv, home: e2e.root, midas: MIDAS_FOUND, mcpClientInstalled: false });
  check(oneStep.statusKind === 'midas-needs-mcp-client' && oneStep.notWired === true && /MCP 客户端/.test(oneStep.display.zh),
    '二进制在、客户端没装 ⇒ `midas-needs-mcp-client` + notWired:true + 文案点明缺的是哪一件', oneStep.statusKind);
  const started = await readMemoryBackendState({
    settings: { memory: { backend: 'midas' } }, env: e2eEnv, home: e2e.root, midas: MIDAS_FOUND, mcpClientInstalled: true, midasProbe: true,
    io: { spawn: () => fakeSpawnExit('Cannot find module node:sqlite') },
  });
  check(started.statusKind === 'midas-start-failed' && started.midasSetup.start && started.midasSetup.start.ok === false
    && /node:sqlite/.test(started.midasSetup.start.stderr),
    '「装了但起不来」：只有**用户点过探测**才会走到这一态，且带截断的 stderr 摘要（探测本身不许拖住设置页：有硬超时）', started.midasSetup.start && started.midasSetup.start.stderr);
  const notProbed = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: e2eEnv, home: e2e.root, midas: MIDAS_FOUND, mcpClientInstalled: true });
  check(notProbed.midasSetup.start === null && notProbed.statusKind === 'midas-ready',
    '**没点探测**时 `start:null`：不许凭"文件在"就宣布"起不来"，也不额外 spawn 任何进程（进页面不发探测请求）', '');
  const secretPatch = await makeHome('- id: other\n  apiToken: sk-SUPER-SECRET-TOKEN\n');
  const secretRead = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: secretPatch.root, midas: MIDAS_FOUND, mcpClientInstalled: true });
  check(!JSON.stringify(secretRead).includes('SUPER-SECRET'), 'Midas 状态对象同样不含文件内容（机密不外泄）', '');

  // 真·启动探测（用 /tmp 里现造的假 MCP 服务，验证握手成功/失败两条路）
  const probeDir = await mkdtemp(join(tmpdir(), 'dsh-midas-probe-'));
  roots.push(probeDir);
  const goodServer = join(probeDir, 'ok.mjs');
  await writeFile(goodServer, 'process.stdin.setEncoding("utf8");let b="";process.stdin.on("data",(d)=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;let m;try{m=JSON.parse(l)}catch{continue}if(m.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"fake",version:"0"}}})+"\\n")}});\n');
  const badServer = join(probeDir, 'bad.mjs');
  await writeFile(badServer, 'process.stderr.write("Cannot find module node:sqlite\\n"); process.exit(3);\n');
  const probeOkResult = await probeMidasStart({ binPath: goodServer, env: { PATH: process.env.PATH }, timeoutMs: 6000 });
  check(probeOkResult.ok === true && probeOkResult.ms < 6000, '启动探测：真的 spawn 一次并完成 MCP initialize 握手 ⇒ ok:true', JSON.stringify({ ok: probeOkResult.ok, ms: probeOkResult.ms }));
  const probeBadResult = await probeMidasStart({ binPath: badServer, env: { PATH: process.env.PATH }, timeoutMs: 6000 });
  check(probeBadResult.ok === false && /node:sqlite/.test(probeBadResult.stderr) && probeBadResult.stderr.length <= 601,
    '启动探测：进程起不来 ⇒ ok:false + **截断的** stderr 摘要（摘要有上限，不把整段警告刷进响应）', JSON.stringify({ err: probeBadResult.error, stderrLen: probeBadResult.stderr.length }));
  const probeNoBin = await probeMidasStart({ binPath: '' });
  check(probeNoBin.ok === false && /没有可启动/.test(probeNoBin.error), '启动探测：没有路径时直接如实说（不 spawn、不抛）', probeNoBin.error);

  // ⑧ 首装引导：命令**由服务端给**，且不承诺任何版本号
  const steps = midasOnboardingSteps({ profile: 'web' });
  check(steps.length === 3 && steps.every((s) => s.command && s.zh && s.en),
    '三步引导（装本体 / 装 MCP 客户端 / 回来选 + 重启），每步都有中英文与一条可复制命令', `${steps.length} 步`);
  check(JSON.stringify(steps.map((s) => s.command)) === JSON.stringify([MIDAS_INSTALL_COMMAND, `dsh plugin --profile web add ${MIDAS_MCP_CLIENT_PACKAGE}`, 'dsh web']),
    '三条命令逐字固定（含 profile 名 = 当前 profile，不是硬写的别的名字）', JSON.stringify(steps.map((s) => s.command)));
  check(midasOnboardingSteps({ profile: 'work' })[1].command === `dsh plugin --profile work add ${MIDAS_MCP_CLIENT_PACKAGE}`,
    'profile 名来自服务端解析（DSH_PROFILE）⇒ 非 web profile 上不会给出一条装错地方的命令', '');
  check(steps.every((s) => !/\d+\.\d+\.\d+/.test(s.zh + s.en)), '引导文案里**没有版本号**（本仓有过一次"界面承诺了版本、实际不匹配"的事故）', '');
  const setupFixture = { ...base, bin: MIDAS_FOUND, mcpClientInstalled: false, patchRowPresent: false };
  const readSetup = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: { [DSH_PROFILE_ENV]: 'web' }, home: e2e.root, midas: MIDAS_FOUND, mcpClientInstalled: false });
  check(readSetup.midasSetup && readSetup.midasSetup.steps.length === 3 && readSetup.midasSetup.ready === false
    && /不做整会话摘要/.test(readSetup.midasSetup.tradeoff.zh) && /零 LLM|不花 token/.test(readSetup.midasSetup.why.zh),
    '状态响应里带着 `midasSetup`：三步命令 + `why` + **代价**（不做整会话摘要 —— 如实说清、不吹）', setupFixture && '');
  check(readSetup.midasSetup.dbPath === midasDbPath({ env: {}, home: e2e.root }) && readSetup.midasSetup.dbEnv === MIDAS_DB_ENV,
    '`midasSetup` 也带上 DB 路径与 env 名（界面能把"记忆落在哪"说清楚）', readSetup.midasSetup.dbPath);
  const hindsightSetup = await readMemoryBackendState({ settings: { memory: { backend: 'hindsight' } }, env: {}, home: e2e.root, midas: MIDAS_FOUND, mcpClientInstalled: true });
  check(hindsightSetup.midasSetup === null,
    '没选 midas 时 `midasSetup:null`（不给无关的人弹引导；也让状态读路径不去 spawn npm）', String(hindsightSetup.midasSetup));

  // ⑨ 接线（源码级）：路由把 midasSetup 带出来 + 客户端**不硬编命令**、按服务端步骤渲染
  {
    const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
    const cliSrc = await readFile(join(here, 'client.js'), 'utf8');
    check(/midasSetup/.test(cmdSrc) && /mcpClientInstalled/.test(cmdSrc),
      '路由把 `midasSetup` 带出去，并用 loader 条目名回答"客户端装没装"', '');
    check(/query\.get\('probe'\)/.test(cmdSrc) && /midasProbe: wantProbe/.test(cmdSrc),
      '`?probe=1` 透传成 `midasProbe`（探测必须由用户点：进页面不 spawn 任何进程）', '');
    check(/id: 'midas'/.test(cmdSrc) && /MIDAS_INSTALL_COMMAND/.test(cmdSrc) && /probeMidasBinarySync/.test(cmdSrc),
      '`OPTIONAL_PLUGINS` 里加了 midas 一项（id / 安装命令都引单一真源，不另写一份字面量）', '');
    check(/backend !== 'midas'/.test(cmdSrc) && /installed: null, usable: null/.test(cmdSrc),
      '推荐插件自检里的 midas **只在用户真的选了 midas 时才探**（没选 ⇒ unknown ⇒ 不提示，不制造噪声）', '');
    check(/h\(MemoryBackendBlock[,)]/.test(cliSrc) && /st\.midasSetup/.test(cliSrc) && /midasSetup\.steps/.test(cliSrc),
      '客户端从**服务端**取 `midasSetup` 与 `steps`（不是自己编一份）', '');
    check(!cliSrc.includes(MIDAS_INSTALL_COMMAND) && !/dsh plugin --profile/.test(cliSrc) && !cliSrc.includes(MIDAS_MCP_CLIENT_PACKAGE),
      '客户端**一个命令都没硬编**（`npm i -g …` / `dsh plugin --profile …` / 包名都不在 client.js 里）—— 硬编就与 profile 名分叉', '');
    check(/className: 'exp-hs-midas-guide'/.test(cliSrc) && /className: 'exp-hs-midas-steps'/.test(cliSrc),
      '引导渲染成**块级** section（`.exp-hs-midas-guide`），不是内联 span（内联挂盒子类就是那个"破框"缺陷）', '');
    check(/className: 'exp-hs-copy'/.test(cliSrc) && /navigator\.clipboard\.writeText/.test(cliSrc),
      '每步命令都带 `.exp-hs-copy` 复制按钮（复用「复制路径」的既有先例：`try/catch` 包住 clipboard）', '');
    check(/if \(!st\) return null/.test(cliSrc), '读不到状态时 `return null`（不渲染、也不假报）', '');
  }

  // ⑩ 推荐插件自检的 midas 分档（真调 `detectOptionalPlugins`：纪律是"missing ⇒ 给命令 / installed-not-ready ⇒ 不给命令"）
  {
    const { _live } = await import(join(here, 'lib', 'command.js'));
    const cfgHome = await mkdtemp(join(tmpdir(), 'dsh-midas-optional-'));
    roots.push(cfgHome);
    await mkdir(join(cfgHome, 'expert-team'), { recursive: true });
    await writeFile(join(cfgHome, 'expert-team', 'settings.json'), JSON.stringify({ memory: { backend: 'midas' } }));
    const oldHome = process.env[DSH_HOME_ENV];
    const oldBin = process.env[MIDAS_BIN_ENV];
    const ctxOf = (names) => ({ get: (n) => (n === 'loader' ? { entries: function* () { for (const nm of names) yield { options: { name: nm } }; } } : undefined) });
    const stOf = (r) => (r.items.find((i) => i.id === 'midas') || {}).status;
    try {
      process.env[DSH_HOME_ENV] = cfgHome;
      _live.loadSettingsSync();
      // ⚠️ 这两档**不碰宿主的 PATH**（`{ env }` 注入）：`MIDAS_MCP_BIN` 是发现的**第一层**，
      // 探针命中它就不再往下看 ⇒ 用例判定的完全是"注入的这份 env 说了什么"，与这台机器上
      // 恰好装没装 `midas-mcp`（用户现在真的装了）无关。走 `process.env` 那条老路时，
      // 裸名字候选会扫 PATH 里的 `midas-mcp` ⇒ 断言在开发机与干净 CI 上结果不同（测宿主 = 假红）。
      delete process.env[MIDAS_BIN_ENV];
      // 反空转守卫：这两个夹具路径**必须**是"一个不存在、一个存在"，否则下面那条"注入真的生效"
      // 的比对会因为两边都是 false 而空转通过（本仓对"没咬合上也算绿"的纪律）。
      const absentBin = join(cfgHome, 'no-such-dir', 'midas-mcp');
      const presentBin = fileURLToPath(import.meta.url);   // 一个**真实存在**的文件 ⇒ 同步探针会命中
      check(absentBin !== presentBin
        && (await stat(absentBin).then(() => false).catch(() => true)) === true
        && (await stat(presentBin).then(() => true).catch(() => false)) === true,
        '反空转：「没装」夹具确实不存在、「装了」夹具确实存在（否则下面两档的比对会空转通过）', absentBin);
      const envAbsent = { [MIDAS_BIN_ENV]: absentBin };
      const envPresent = { [MIDAS_BIN_ENV]: presentBin };
      const missing = _live.detectOptionalPlugins(ctxOf([]), { env: envAbsent });
      // 诊断一起打出来：万一这条红了，要能一眼看出"注入没生效"（两档同值）还是"判定错了"（档位对不上）。
      const hostMissing = _live.detectOptionalPlugins(ctxOf([]));
      const notReady = _live.detectOptionalPlugins(ctxOf([]), { env: envPresent });
      check(stOf(missing) !== stOf(notReady),
        '**注入的 env 真的被读到了**（同一台机器上，注入"没有那份二进制"与"有那份二进制"两档必须给出不同结论 —— '
        + '注入没接线时两者都会退化成宿主的结论 ⇒ 本条红）',
        `注入没装=${stOf(missing)} / 宿主=${stOf(hostMissing)} / 注入装了=${stOf(notReady)}`);
      check(stOf(missing) === 'missing' && missing.hint.indexOf(MIDAS_INSTALL_COMMAND) >= 0,
        '选了 midas 且没装 ⇒ missing，提示里**含**安装命令（该装就告诉他怎么装）', stOf(missing));
      // 提示是**一行里逐项分档**的（`；` 分隔）⇒ 要按**这一项那一段**判"没有命令"，
      // 否则同一条提示里别项缺装的命令会让本断言假红（这不是放水：判的就是 midas 这一段）。
      const midasSeg = String(notReady.hint).split('；').find((p) => p.indexOf('midas-memory-mcp') >= 0) || '';
      check(stOf(notReady) === 'installed-not-ready' && midasSeg !== '' && !/dsh plugin|npm i -g/.test(midasSeg),
        '二进制在、MCP 客户端没装 ⇒ installed-not-ready，**midas 那一段**里不含任何安装命令（"已装但没就绪"不该被叫去重装）',
        midasSeg.slice(0, 60));
      const ready = _live.detectOptionalPlugins(ctxOf([MIDAS_MCP_CLIENT_PACKAGE]), { env: envPresent });
      check(stOf(ready) === 'ready', '二进制 + MCP 客户端都在 ⇒ ready', stOf(ready));
      await writeFile(join(cfgHome, 'expert-team', 'settings.json'), JSON.stringify({ memory: { backend: 'hindsight' } }));
      _live.loadSettingsSync();
      const notChosen = _live.detectOptionalPlugins(ctxOf([]), { env: envPresent });
      check(stOf(notChosen) === 'unknown' && notChosen.hint.indexOf('midas-memory-mcp') < 0,
        '没选 midas（默认 Hindsight）⇒ unknown：**不提示**（不制造噪声 —— 噪声会降权所有告警）', stOf(notChosen));
    } finally {
      if (oldHome === undefined) delete process.env[DSH_HOME_ENV]; else process.env[DSH_HOME_ENV] = oldHome;
      if (oldBin === undefined) delete process.env[MIDAS_BIN_ENV]; else process.env[MIDAS_BIN_ENV] = oldBin;
      try { _live.loadSettingsSync(); } catch { /* 恢复缓存失败不影响判定 */ }
    }
  }
}

// ── ⑪ 「选了 off，但补丁里 `mcp-midas` 那一行还在」—— 一键移除 + 诚实披露（2026-09-19）──────
// 为什么单开一大节：这是本轮修掉的**真实缺陷**，而它的失败形态**四层同时成立**才叫修好，缺一层
// 都会退回原样或引入新的伤害：
//   · 纯函数层：`planMidasRowRemoval()` 必须**删得对**（独苗连表头删、有兄弟留表头、形态不认识就拒写）
//     —— 这是唯一会真的改用户补丁文件的地方，写错一次就是数据丢失；
//   · 状态层：`readMemoryBackendState()` 必须**如实说**（`off` 不再是"一件事"，而是
//     「Hindsight 停没停」×「那个 MCP 行还在不在」两件）—— 旧实现把那行的事实折进 `stored==='midas'`
//     分支里 ⇒ 选 `off` 时界面写着"不会有任何记忆调用"，而 MCP 服务照样起、17 个工具照样注册（**假话**）；
//   · 路由层：动作必须真的挂在**既有**路由上（新开一条路由会撞 `routes-shared.test.mjs` 的 15 条棘轮）；
//   · 客户端层：只在服务端说"能安全删"时才给按钮，且**防御性读法**（旧服务端没有这个字段 ⇒ 一个字不渲染）。
// 下面四块按这个顺序钉。**所有新断言都必须能在实现回退时变红** —— 配套的判别变异是 **M171**。
console.log('\n⑪ off 之后补丁里那个 mcp-midas 行还在（一键移除 + 诚实披露）');
{
  // 与实现无关的极简判定：这段文本里还有没有 `- insert:` 表头 / 顶层 `- ` 项。
  const hasInsertHeader = (t) => /^- insert:\s*$/m.test(String(t));
  const hasTopLevelEntry = (t) => /^-\s/m.test(String(t));

  // ── A. `planMidasRowRemoval()`（纯函数）—— 全部会真的改用户文件的判定都在这里 ──────────────
  {
    // 真实形状的一块（逐字取自 `midasPatchRowLines()` 的输出 —— 那才是本机补丁文件里真实的样子）。
    // ⚠️ 用例 ⑤ 的"假阳性守卫"要求这块**必须是真实的**：`args:` 底下有一条**标量**序列项
    // （`          - '/some/bin/midas-mcp'`），它缩进比子项深、又以 `- ` 开头 —— 任何"更深的 `- `
    // 就是别人的条目"的粗糙判据都会把这份**完全合法**的文件误拒（实测踩到过）。
    const REAL_BLOCK = ['- insert:',
      `    - id: ${MIDAS_PATCH_ROW_ID}`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      "        transport: 'stdio'",
      "        serverName: 'midas'",
      "        command: 'node'",
      '        args:',
      "          - '/some/bin/midas-mcp'",
      "        cwd: '/some/install'",
      '        env:',
      `          ${MIDAS_DB_ENV}: '/some/memory.sqlite3'`,
    ].join('\n') + '\n';
    const SCALAR_ARG_LINE = "          - '/some/bin/midas-mcp'";
    check(REAL_BLOCK.includes(SCALAR_ARG_LINE) && /^\s*-\s+'/.test(SCALAR_ARG_LINE),
      '夹具前提：真实块里确实有一条**标量**序列项（`args:` 的取值）—— 用例⑤ 的假阳性守卫靠它成立',
      SCALAR_ARG_LINE.trim());

    // ① 独苗：`- insert:` 底下只有 `mcp-midas` 一条 ⇒ 连表头一起删掉
    const only = `- id: ui-workflow-run\n  disabled: true\n${REAL_BLOCK}`;
    const r1 = planMidasRowRemoval(only);
    check(r1.ok === true && r1.changed === true && r1.text !== null
      && !r1.text.includes(MIDAS_PATCH_ROW_ID) && !hasInsertHeader(r1.text),
      '独苗：`- insert:` 底下只有 mcp-midas ⇒ ok:true / changed:true，产物里**没有** mcp-midas、**表头也没了**（留下一个没有子项的空容器只会误导人）',
      JSON.stringify(r1.text));
    check(r1.text === '- id: ui-workflow-run\n  disabled: true\n',
      '独苗：其余行**逐字保留**（删除动作只在它声明要改的那一处落笔）', JSON.stringify(r1.text));

    // ② 同级兄弟在**后面** ⇒ 只删这一条，表头留下、兄弟逐字不动
    const sibAfter = ['- insert:',
      `    - id: ${MIDAS_PATCH_ROW_ID}`,
      "      name: 'a'",
      '    - id: other-insert',
      "      name: 'b'",
    ].join('\n') + '\n';
    const r2 = planMidasRowRemoval(sibAfter);
    check(r2.ok === true && r2.changed === true && !r2.text.includes(MIDAS_PATCH_ROW_ID),
      '兄弟在**后面**：只删 mcp-midas 这一块（ok:true / changed:true，产物里没有它）', JSON.stringify(r2.text));
    check(hasInsertHeader(r2.text) && r2.text.includes("    - id: other-insert\n      name: 'b'"),
      '兄弟在**后面**：`- insert:` 表头**保留**、兄弟项**逐字不动**（`insert` 是数组，删表头 = 把别人的条目一起删了）',
      JSON.stringify(r2.text));

    // ③ 同级兄弟在**前面** ⇒ 同上（两种相对顺序都要核 —— 只测一种会让"只看相邻行"的写法蒙混过关）
    const sibBefore = ['- insert:',
      '    - id: other-insert',
      "      name: 'b'",
      `    - id: ${MIDAS_PATCH_ROW_ID}`,
      "      name: 'a'",
    ].join('\n') + '\n';
    const r3 = planMidasRowRemoval(sibBefore);
    check(r3.ok === true && r3.changed === true && !r3.text.includes(MIDAS_PATCH_ROW_ID),
      '兄弟在**前面**：同样只删 mcp-midas 这一块（ok:true / changed:true）', JSON.stringify(r3.text));
    check(hasInsertHeader(r3.text) && r3.text.includes("    - id: other-insert\n      name: 'b'"),
      '兄弟在**前面**：表头保留、兄弟项逐字不动（与用例②同一条纪律，两个方向都不许丢数据）', JSON.stringify(r3.text));

    // ④ 畸形形态（更深缩进的 `- <key>:`）⇒ **拒绝写入**。
    // ⚠️ 这是**健壮性护栏**，不是活跃路径：`- insert:` 在缩进 0、子项在缩进 4，子项内部再出现一条
    // 缩进更深的 `- id: x` 映射项在合法 YAML 里没有位置 —— `js-yaml` / `yaml` v2 都拒收，
    // **DSH 自己在启动时就会抛** `bad indentation of a sequence entry`。也就是说这种文件根本进不了
    // "运行中的 dsh"。那为什么还要测：因为规划器此刻**块尾不可信**（`findMidasInsertRow()` 会把
    // 更深缩进的行算进这一块），兄弟普查看不见被吞进来的同缩进条目 ⇒ 若不拒绝，删表头就会把
    // `- id: other` **一起删掉**并报 changed:true。删别人的数据是最坏的结果，所以这里宁可什么都不做。
    const malformed = '- insert:\n  - id: mcp-midas\n    - id: other\n';
    const r4 = planMidasRowRemoval(malformed);
    check(r4.ok === false && r4.text === null && r4.changed === false,
      '畸形形态（块内更深缩进的 `- id: …`）⇒ **拒绝写入**（ok:false / text 恒为 null / changed:false：一个字节都不落盘）',
      JSON.stringify({ ok: r4.ok, text: r4.text, changed: r4.changed }));
    check(r4.errors.length > 0 && r4.errors.join(' ').includes('拒绝写入'),
      '畸形形态：拒绝是**有理由**的（错误里明说"拒绝写入"，不是静默返回 null）', r4.errors[0] || '');
    check(r4.text === null || !String(r4.text).includes('- id: other'),
      '畸形形态：邻项 `- id: other` **没有被销毁**（被吞进来的条目必须原样活着 —— 这正是"宁可拒写"要保住的东西）',
      JSON.stringify(r4.text));

    // ⑤ ★关键假阳性守卫★：真实块里那条 `args:` 下的**标量**序列项**不得**被判成"别人的条目"。
    // 名字起清楚：这一条要是红了，说明真的那份 cordis.patch.yml 会被**误拒**（功能整个不可用）。
    const fullPatch = `# a top-level YAML array of load-overrides, disables, and inserts\n- id: ui-workflow-run\n  disabled: true\n${REAL_BLOCK}`;
    const r5 = planMidasRowRemoval(fullPatch);
    check(r5.ok === true,
      '★假阳性守卫★：`args:` 下的**标量**序列项（`- \'/some/bin/midas-mcp\'`）**不得**被当成"别人的条目" ⇒ ok:true（这一条红了 = 真实补丁文件会被误拒，功能整个不可用）',
      JSON.stringify({ ok: r5.ok, errors: r5.errors.slice(0, 1) }));
    check(r5.changed === true && r5.text === '# a top-level YAML array of load-overrides, disables, and inserts\n- id: ui-workflow-run\n  disabled: true\n',
      '★假阳性守卫★：同一份真实补丁删完之后，注释与既有顶层项**逐字保留**（不是"为了过关而拒绝"）',
      JSON.stringify(r5.text));

    // ⑥ 本来就没有那一行 ⇒ 幂等不动，文本逐字返回（**不假报成功**）
    const noRow = '- id: ui-workflow-run\n  disabled: true\n';
    const r6 = planMidasRowRemoval(noRow);
    check(r6.ok === true && r6.changed === false && r6.text === noRow,
      '没有 mcp-midas 行 ⇒ ok:true / changed:false，文本**逐字**返回原样（没改动就不写盘、也不假报成功）',
      JSON.stringify({ changed: r6.changed, same: r6.text === noRow }));

    // ⑦ 幂等：连调两次，第二次必须 changed:false 且文本与第一次产物逐字相同
    const r7a = planMidasRowRemoval(fullPatch);
    const r7b = planMidasRowRemoval(r7a.text);
    check(r7b.changed === false && r7b.text === r7a.text,
      '幂等：对同一份输入连调两次，第二次 changed:false 且文本与第一次产物**逐字相同**（否则设置页每点一次就写一次盘）',
      JSON.stringify({ changed: r7b.changed, same: r7b.text === r7a.text }));

    // ⑧ 流式 YAML ⇒ 拒绝（本模块只认块式；`parseRows` 只扫**顶层**项，所以这一条必须用
    // **顶层**的流式行来触发 —— 见下面那条"嵌套流式行"的说明，别把两者混成一条）。
    const flow = '- id: ok-row\n- {id: mcp-midas}\n';
    const r8 = planMidasRowRemoval(flow);
    check(r8.ok === false && r8.text === null,
      '流式 YAML（顶层 `- {id: …}`）⇒ ok:false / text:null（形态不认识就不猜着合并，一个字节不落盘）',
      JSON.stringify({ ok: r8.ok, text: r8.text }));
    // ⚠️ **实测口径**（与 `parseRows` 的实际射程对齐，不写想当然的那条）：流式判定发生在
    // `parseRows` 扫描**顶层数组项**时，所以**嵌套**在 `- insert:` 底下的流式行 `- {id: mcp-midas}`
    // **不报错**；而 `findMidasInsertRow()` 只认 `^\s+- id: mcp-midas$` 这种**块式**写法 ⇒ 它
    // 看不见这一行 ⇒ 走"本来就没有那一行"的早退（`ok:true, changed:false`，**文本逐字返回**）。
    // 这不是缺陷（那一行本来就不会被 dsh 认成 MCP 挂载行），但**必须如实钉住**：它正是"看不见 =
    // 不动手"的正当形态，而不是"被悄悄删掉了"。
    const nestedFlow = '- insert:\n  - {id: mcp-midas}\n';
    const r8b = planMidasRowRemoval(nestedFlow);
    check(r8b.ok === true && r8b.changed === false && r8b.text === nestedFlow,
      '嵌套流式行（`- insert:` 底下的 `- {id: mcp-midas}`）：`findMidasInsertRow()` 只认块式 ⇒ 看不见它 ⇒ 走"本来就没有"的早退（ok:true / changed:false / 文本**逐字**返回原样）—— 看不见就不动手，绝不猜着删',
      JSON.stringify({ ok: r8b.ok, changed: r8b.changed, same: r8b.text === nestedFlow }));

    // ⑨ 补丁里**只有**那条 midas insert ⇒ 产物恰好是 `'[]'`。
    // 为什么必须钉这一个字面量：**空文件、或只剩注释**会让 DSH 启动时直接抛（顶层数组为空）；
    // `[]` 才是"零个覆盖项"的合法写法。写成空串就等着宿主开机失败。
    const onlyMidas = `- insert:\n    - id: ${MIDAS_PATCH_ROW_ID}\n      name: 'a'\n`;
    const r9 = planMidasRowRemoval(onlyMidas);
    check(r9.ok === true && r9.changed === true && r9.text === '[]',
      '补丁里只有那条 midas insert ⇒ 产物**恰好**是 `[]`（合法空数组；空文件/只剩注释会让 dsh 启动时抛）',
      JSON.stringify(r9.text));

    // ⑩ 表头与子项之间夹着注释/空行（模板里就有）⇒ 不许误判成"没有表头"，也不许留下无主的空容器
    const gap = `- insert:\n  # mcp client\n    - id: ${MIDAS_PATCH_ROW_ID}\n      name: 'a'\n`;
    const r10 = planMidasRowRemoval(gap);
    check(r10.ok === true && r10.changed === true && !r10.text.includes(MIDAS_PATCH_ROW_ID),
      '表头与子项之间夹着注释/空行 ⇒ ok:true，且没有把"表头就在那儿"误判成"没有表头"（判据是**结构回溯**，不是看相邻行）',
      JSON.stringify(r10.text));
    check(!hasInsertHeader(r10.text) && !hasTopLevelEntry(r10.text) && r10.text === '[]',
      '间隔行形态：**不留**没有子项的 `- insert:` 空容器（夹在中间的空行/注释跟着表头一起删 —— 留着会变成无主的孤儿注释）',
      JSON.stringify(r10.text));
  }

  // ── B. `readMemoryBackendState()` —— **诚实契约**（这一节直接对应原缺陷）────────────────────
  {
    const MIDAS_ROW_BLOCK = ['- insert:',
      `    - id: ${MIDAS_PATCH_ROW_ID}`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        args:',
      "          - '/some/bin/midas-mcp'",
    ].join('\n') + '\n';
    const OFF_DONE = '- id: ui-workflow-run\n  disabled: true\n- id: hindsight\n  disabled: true\n';

    // ⑪ `stored:'off'` + hindsight 确实禁用 + **那一行还在** ⇒ 必须是那个新结论，而不是"已关闭"
    const liveHome = await makeHome(OFF_DONE + MIDAS_ROW_BLOCK);
    const s11 = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: liveHome.root });
    check(s11.statusKind === 'off-midas-row-live',
      'stored=off + hindsight 已禁用 + mcp-midas 行还在 ⇒ statusKind=**off-midas-row-live**（旧实现回 `off`，界面于是说"不会有任何记忆调用"——假话）',
      s11.statusKind);
    check(s11.midasRowPresent === true && s11.midasRowRemovable === true,
      '同一格：midasRowPresent:true + midasRowRemovable:true（"那一行还在"与"能一键删掉"都是**独立事实**，一起带出去）',
      JSON.stringify({ present: s11.midasRowPresent, removable: s11.midasRowRemovable }));
    check(s11.midasRowId === MIDAS_PATCH_ROW_ID && s11.midasServerName === MIDAS_SERVER_NAME,
      '行 id / 服务名由服务端给（客户端是手写 bundle、不能 `import lib/` ⇒ 少给一个字段它就会就地硬编一份）',
      `${s11.midasRowId} / ${s11.midasServerName}`);

    // ⑫ `stored:'off'` + hindsight 禁用 + **没有**那一行 ⇒ 必须回**旧**的 `off` 与**逐字**旧文案
    const cleanHome = await makeHome(OFF_DONE);
    const s12 = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: cleanHome.root });
    check(s12.statusKind === 'off' && s12.midasRowPresent === false,
      'stored=off + hindsight 已禁用 + **没有** mcp-midas 行 ⇒ 仍是**旧**的 `off`（新分支不许把干净的那一格也染成告警）',
      `statusKind=${s12.statusKind} present=${s12.midasRowPresent}`);
    check(s12.display.zh === '已关闭：profile 补丁里 `hindsight` 行是 `disabled: true` ⇒ 重启 dsh web 后不会有任何记忆调用。',
      '同一格：**逐字**保留旧文案（这一格不涉及 mcp-midas，那句话在它里面是真的；有别的断言钉着它，这里再钉一次防漂移）',
      s12.display.zh);

    // ⑬ `midasRowPresent` 必须**与 `stored` 无关** —— 这正是原缺陷的根：旧实现把它折进
    // `stored === 'midas'` 那一支里 ⇒ 选 hindsight / off 时**根本看不到**那一行。
    const hHome = await makeHome(`- id: hindsight\n  disabled: false\n${MIDAS_ROW_BLOCK}`);
    const s13h = await readMemoryBackendState({ settings: { memory: { backend: 'hindsight' } }, env: {}, home: hHome.root, hindsight: { exists: true, failing: false } });
    check(s13h.midasRowPresent === true,
      'stored=**hindsight** 时 midasRowPresent 仍是 true（与选了什么无关 —— 它是补丁文件的事实；旧实现只在 `stored===\'midas\'` 分支里算它）',
      JSON.stringify({ stored: s13h.stored, present: s13h.midasRowPresent }));
    const mHome = await makeHome(`- id: hindsight\n  disabled: false\n${MIDAS_ROW_BLOCK}`);
    const s13m = await readMemoryBackendState({ settings: { memory: { backend: 'midas' } }, env: {}, home: mHome.root, midas: MIDAS_ABSENT, mcpClientInstalled: false });
    check(s13m.midasRowPresent === true && s13m.midasRowRemovable === true,
      'stored=**midas** 时 midasRowPresent 也是 true（三个档位都要看得到这一行 —— 这就是"无条件暴露"的地基）',
      JSON.stringify({ stored: s13m.stored, present: s13m.midasRowPresent, removable: s13m.midasRowRemovable }));

    // ⑭ 新分支的文案必须**真的说出后果**（子串断言：将来有人把这句披露删掉/改软，本条立刻红）
    check(/照样启动/.test(s11.display.zh) && /照样注册/.test(s11.display.zh),
      '新分支的中文文案点明后果：MCP 服务**照样启动**、工具**照样注册**（只说"off 但有残留"等于没说清为什么这重要）',
      s11.display.zh.slice(0, 46));
    check(/STILL/.test(s11.display.en) && /still starts/.test(s11.display.en) && /still registered/.test(s11.display.en),
      '新分支的**英文**文案同样点明"服务器照旧启动、工具照旧注册"（有一边漂移就红 —— 两档文案必须说同一件事）',
      s11.display.en.slice(0, 46));
  }

  // ── B2. **两种零必须分得开**：`midasRowKnown` 的教义锁（2026-09-19 独立复核发现的缺陷 a）────
  // 缺陷 a 逐字：旧实现把「**磁盘上确实没有**那一行」与「**根本读不到补丁**，所以无从判定」都压进
  // `midasRowPresent:false` 这**一个**布尔里 ⇒ 界面/别的会话读到 `false`，就把"我不知道"当成
  // "它不在"（本仓 2026-09-19 立下的纪律：**两种零必须分得开**）。
  // 修法是加一个**伴随字段** `midasRowKnown = patchReadable`（`false` = 无从判定），并让
  // `midasRowPresent` 在 `patchReadable === false` 时**结构上被强制**为 `false`（不假报"看见了"）。
  // 下面这一组断言就是那道修法的锁：**四格里必须给出两种不同的读数**，只钉一格等于没钉 ——
  // 一个把 `midasRowKnown` 直接写成 `true`（或恒等于 `midasRowPresent`）的实现，会在第③④格变红。
  {
    /** 一块**真实形状**的 `- insert:` 包裹的 mcp-midas（逐字取自 `midasPatchRowLines()` 的输出）。 */
    const MB_ROW_BLOCK = ['- insert:',
      `    - id: ${MIDAS_PATCH_ROW_ID}`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      "        transport: 'stdio'",
      "        serverName: 'midas'",
      "        command: 'node'",
      '        args:',
      "          - '/some/bin/midas-mcp'",
      "        cwd: '/some/install'",
      '        env:',
      `          ${MIDAS_DB_ENV}: '/some/memory.sqlite3'`,
    ].join('\n') + '\n';
    const MB_OFF_DONE = '- id: hindsight\n  disabled: true\n';

    // ① 读得到的补丁 ∧ 那一行在 ⇒ known:true ∧ present:true ∧ removable:true
    const kHome = await makeHome(MB_OFF_DONE + MB_ROW_BLOCK);
    const kOn = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: kHome.root });
    check(kOn.patchReadable === true && kOn.midasRowKnown === true
      && kOn.midasRowPresent === true && kOn.midasRowRemovable === true,
      '①补丁读得到 + `- insert:` 包裹的 mcp-midas 行在 ⇒ patchReadable:true ∧ midasRowKnown:true ∧ midasRowPresent:true ∧ midasRowRemovable:true（三条独立事实一起带出去）',
      JSON.stringify({ read: kOn.patchReadable, known: kOn.midasRowKnown, present: kOn.midasRowPresent, removable: kOn.midasRowRemovable }));

    // ⑤ **类型钉**：`midasRowPresent` 必须**始终**是布尔。`client.js` 读的是
    // `st.midasRowPresent === true`（严格相等）—— 一旦有人"为了表达不知道"把它改成 `null`，
    // 那个判据**照样**是 false（看起来没事），可任何 `JSON.stringify` / 真值判断的别的消费者会当场变脸。
    // 所以"不知道"这件事**只能**住在 `midasRowKnown` 里，不许动 `midasRowPresent` 的类型。
    check(typeof kOn.midasRowPresent === 'boolean' && typeof kOn.midasRowRemovable === 'boolean' && typeof kOn.midasRowKnown === 'boolean',
      '**类型钉**：`midasRowPresent` 恒为 boolean（绝不 `null`/`undefined`）—— 它护着 `client.js` 的 `st.midasRowPresent === true`；"不知道"只许住在 `midasRowKnown` 里',
      `typeof present=${typeof kOn.midasRowPresent}`);

    // ② 读得到的补丁 ∧ 没有那一行 ⇒ known:true ∧ present:false（**知道**，结论是"不在"）
    const kCleanHome = await makeHome(MB_OFF_DONE);
    const kClean = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: kCleanHome.root });
    check(kClean.patchReadable === true && kClean.midasRowKnown === true && kClean.midasRowPresent === false,
      '②补丁读得到 + **没有**那一行 ⇒ midasRowKnown:true ∧ midasRowPresent:false（"知道，且结论是不在"——这与下一格的"不知道"**不是**同一个读数）',
      JSON.stringify({ known: kClean.midasRowKnown, present: kClean.midasRowPresent }));

    // ③④ **关键格**：读不到补丁 ⇒ 两个零必须分得开。
    // 两种造法都试，因为它们的可信度取决于平台：①`chmod 000`（本轮实测本机 `readFile` 确实 EACCES
    // ⇒ 真的走到了"读不到"那一支）②`makeHome(undefined)`（连通配目录都不建 ⇒ 补丁文件不存在 ⇒
    // 同样走到"读不到"那一支，与权限无关）。**先实测** `patchReadable === false` 真的成立，
    // 再往下断言 —— 否则这一整块会在一个"权限拦不住 root"的环境里**空转通过**（本仓最忌讳的假绿）。
    const chmodHome = await makeHome(MB_OFF_DONE + MB_ROW_BLOCK);
    let chmodReadable = true;
    try {
      await chmod(chmodHome.patchPath, 0o000);
      try { await readFile(chmodHome.patchPath, 'utf8'); } catch { chmodReadable = false; }
      const byChmod = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: chmodHome.root });
      // ⚠️ 先报告**用的是哪一种机制**：`chmod` 在本平台的实测结论（见详情里的读数）。
      check(byChmod.patchReadable === false,
        '③夹具前提（chmod 000）：本平台上真的读不到那份补丁 ⇒ patchReadable:false（否则下面那条会在"权限拦不住"的环境里空转通过）',
        `chmod 后直接 readFile ${chmodReadable ? '**仍读得到**' : '抛了'} / patchReadable=${byChmod.patchReadable}`);
      check(byChmod.patchReadable === false && byChmod.midasRowPresent === false && byChmod.midasRowKnown === false && byChmod.midasRowRemovable === false,
        '③**读不到补丁**（chmod 000）⇒ patchReadable:false ∧ midasRowPresent:false ∧ **midasRowKnown:false** ∧ midasRowRemovable:false —— 本仓纪律「**两种零必须分得开**」：这里的两个 false 说的是"**无从判定**"，与第②格那个"**确实没有**"必须是**两个**读数；把 known 恒写成 true ⇒ 本条立刻红',
        JSON.stringify({ read: byChmod.patchReadable, known: byChmod.midasRowKnown, present: byChmod.midasRowPresent, removable: byChmod.midasRowRemovable }));
    } finally {
      // ⚠️ 必须恢复权限：000 的文件留在临时目录里会让 `rm -rf` 删不掉（`roots` 的清理在文件末尾统一做）。
      await chmod(chmodHome.patchPath, 0o600).catch(() => { /* 恢复失败不该让判定变色 */ });
    }

    // ④ 同一条纪律的**第二种**造法（与权限无关，恒可靠）：连 `.dsh/profiles/web/` 都不建 ⇒ 补丁文件不存在。
    // 为什么两种都要：`chmod` 那一格在"以 root 跑"的环境里会读得到（那时它自己就红、或前提不成立），
    // 而 `EACCES`/`ENOENT` 在这条代码路径上是**同一支**（`try { readText } catch { patchReadable = false }`）
    // ⇒ 两者的期望读数必须**逐字相同**。只钉一种，就等于把这条纪律押在平台的权限语义上。
    const noneHome = await makeHome(undefined);
    const byMissing = await readMemoryBackendState({ settings: { memory: { backend: 'off' } }, env: {}, home: noneHome.root });
    check(byMissing.patchReadable === false && byMissing.midasRowPresent === false && byMissing.midasRowKnown === false && byMissing.midasRowRemovable === false,
      '④**补丁文件不存在**（`makeHome(undefined)`）⇒ 与第③格**逐字相同**的四读数（读不到就是读不到，机制是 EACCES 还是 ENOENT 不改变结论）',
      JSON.stringify({ read: byMissing.patchReadable, known: byMissing.midasRowKnown, present: byMissing.midasRowPresent, removable: byMissing.midasRowRemovable }));

    // ④b 这两格**必须真的不是同一个读数**：把"读不到"与"确实没有"并排比一次。若实现回退成
    // "两者都对 `midasRowPresent` 写 false 而不给 known"，单纯的 present 比对**不会**红 ——
    // 它红在 `known` 那一维：`false`（不知道）vs `true`（知道且不在）。这一条的意义是把那句纪律
    // **显式写成一次比对**，而不是散在四条断言里靠人脑记。
    check(byMissing.midasRowKnown === false && kClean.midasRowKnown === true
      && byMissing.midasRowPresent === kClean.midasRowPresent,
      '④b**两个零的正式读法**：「读不到」（known:false）与「确实没有」（known:true）在 `midasRowPresent` 上同为 false，**只能**靠 `midasRowKnown` 分开 —— 这一条就是那句纪律的可执行版本',
      `读不到 known=${byMissing.midasRowKnown} / 确实没有 known=${kClean.midasRowKnown}`);

    // ③b 读不到补丁时**必须有一句人话**说明"这不是'那一行不在'"（本仓纪律：失败必须出声）。
    // 只给一个布尔而不解释，用户看到的就是"它说没这一行，可我明明写过"。
    check(byMissing.notes.some((n) => /无从判断/.test(n) && /midasRowKnown/.test(n)),
      '③b 读不到补丁时 notes 里**明说**"也无从判断那一行在不在"且点名 `midasRowKnown`（只给一个布尔不解释 = 让用户自己猜为什么"我写过的那行不见了"）',
      (byMissing.notes.find((n) => /midasRowKnown/.test(n)) || '').slice(0, 40));
  }

  // ── B3. 拒绝路径的 notes **不许**带着成功的剧情（2026-09-19 独立复核发现的缺陷 b）──────────
  // 缺陷 b 逐字：`planMidasRowRemoval()` 的 notes 是**边删边写**的 —— 「这一块是那个 `- insert:` 底下的
  // **唯一**子项 ⇒ 连表头一起删掉」那句是在 `out.splice(...)` **之后**才 push 的。而 `refuse()` 的**每一条**
  // 路径都在那些 splice 之后 ⇒ `ok:false` 的失败回执里躺着"删掉了"的剧情（本仓最忌讳的假报：
  // 只读 notes 的调用方会把失败当成功）。同一条 latent bug 也修在 `applyMemoryBackend` 上。
  // 修法：拒绝支**整段丢弃** `plan.notes`，换成拒绝说明（理由逐条来自 `plan.errors`，一个字不丢）。
  {
    // ⚠️ **夹具陷阱**（前一位 agent 实测踩到并记录）：一块**缺 `config:`/`args:`** 的 mcp-midas
    // 是**太短**的 —— `findMidasInsertRow()` 不会把后面那些行算进这一块，规划器于是走"**没有** `- insert:`
    // 表头"那一支（`wrapperIsHeader === false`），**根本不会**说出「唯一子项」⇒ 断言"notes 里没有唯一子项"
    // **恒真**（假通过）。所以这里必须用与真实 `cordis.patch.yml` 同形状的**完整块**。
    const REFUSE_BLOCK = ['- insert:',
      `    - id: ${MIDAS_PATCH_ROW_ID}`,
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      "        transport: 'stdio'",
      "        serverName: 'midas'",
      "        command: 'node'",
      '        args:',
      "          - '/some/bin/midas-mcp'",
      "        cwd: '/some/install'",
      '        env:',
      `          ${MIDAS_DB_ENV}: '/some/memory.sqlite3'`,
    ].join('\n') + '\n';
    // 畸形形态 = 在**块内**塞一条缩进更深的 `- id: other`（映射子项 = 别人的条目）。
    // 这正是那个"块尾被吞、兄弟普查看不见"的形态 ⇒ 规划器必须**拒绝写入**（而不是删掉别人的数据）。
    const MALFORMED_DEEP = '- insert:\n'
      + REFUSE_BLOCK.split('\n').slice(1).map((l) => (l === '      config:' ? '        - id: other' : l)).join('\n');
    check(REFUSE_BLOCK.includes('      config:') && MALFORMED_DEEP.includes('        - id: other'),
      '夹具前提：畸形那块是**完整块**（id/name/config/transport/serverName/command/args/cwd/env 都在）—— 太短的块会让下面的"没有唯一子项"空转通过',
      '');

    const rHome = await makeHome(MALFORMED_DEEP);
    const refused = await removeMidasRow({ env: {}, home: rHome.root });
    check(refused.ok === false && refused.status === 400,
      '⑥畸形补丁（块内更深缩进的 `- id: other`）⇒ `removeMidasRow()` 回 ok:false / status:400（一个字节都不落盘）',
      JSON.stringify({ ok: refused.ok, status: refused.status }));
    // ⚠️ **不许**用裸 `/删/` 去断言"没有成功剧情"：拒绝那句话本身就含「删除」二字
    // （「已丢弃规划过程中产生的"将要删除"说明」）⇒ 裸 /删/ **恒真**，等于什么都没钉。
    // 要钉的是那句**具体**的成功叙事 `唯一子项`（只有真的走到"删表头"那一支才会产生）。
    const refusedNotes = refused.notes.join('\n');
    check(!refusedNotes.includes('唯一子项'),
      '⑥拒绝支的 notes **不含** `唯一子项`（那句"连表头一起删掉"是 `out.splice()` 之后才 push 的进度句 —— 动作没发生，剧情就不许留在回执里）',
      refusedNotes.includes('唯一子项') ? refusedNotes.slice(0, 60) : `notes 长度 ${refusedNotes.length}`);
    check(refused.errors.join(' ').includes('拒绝写入') && refusedNotes.includes('拒绝写入'),
      '⑥但理由**一个字都不丢**：`errors` 里明说"拒绝写入"，且同一批理由被并进 notes（notes 是回执唯一的人话位，空着等于用户只看到一个 400）',
      (refused.errors.find((x) => /拒绝写入/.test(x)) || '').slice(0, 32));
    // 反空转守卫：这一格必须**真的**走到了那条分支。若夹具没触发（比如块被认成"没有表头"），
    // 上面两条会**双双恒真**。所以显式要求拒绝理由里出现"更深缩进"那句 —— 它只有在
    // `swallowedSiblingIdx.length > 0` 时才可能产生。这一条红了 = 上面的断言在空转。
    check(refused.errors.some((x) => /更深缩进/.test(x)),
      '⑥反空转：拒绝理由里确实出现「更深缩进」那一句 ⇒ 夹具**真的**触发了块形自检（否则上面两条恒真、等于没测）',
      String(refused.errors[0] || '').slice(0, 40));

    // ⑦ `applyMemoryBackend` 的拒绝支同一纪律。
    // ⚠️ **诚实的射程说明**（本轮实测结论，别把它当成比实际更强的保证）：`planMemoryBackendPatch()`
    // 的 `refuse()` 只有**两处**会在 `out.splice(...)` 之后被调用 —— ①`parsed.errors`（**函数入口**，
    // 此刻 `notes` 必然是空的）②`finish()` 的三道出口自检。而本轮**穷举搜索**（重复 hindsight 行 /
    // 嵌套 `disabled` / 流式 YAML / 块内吞并 `- id:` / midas 三个值缺失）**没能构造出**任何一条
    // "`ok:false` 且 `plan.notes` 非空"的输入。所以：这条缺陷（b 的 `applyMemoryBackend` 那一半）在
    // 本模块**当前**可达输入空间里是**潜伏的**（修得对，但触发不了）。测试**不许**假装它被覆盖了 ——
    // 下面那条"空转守卫"就是把这件事**如实钉住**：一旦哪天有人加了一条"先 push 进度句、再拒绝"的
    // 路径，这条会变红，提醒把这个夹具换成能真正走到那条路径的形态。
    const aHome = await makeHome('- id: ok-row\n- {id: hindsight}\n' + REFUSE_BLOCK);
    const aRefused = await applyMemoryBackend({ backend: 'off', env: {}, home: aHome.root });
    check(aRefused.ok === false && aRefused.status === 400,
      '⑦`applyMemoryBackend` 在畸形补丁上同样是 ok:false / status:400（拒绝语义与 `removeMidasRow()` 逐条对齐 —— 这一条同时说明 ① 类拒绝的两个实体**都**不带 `plan.notes`）',
      JSON.stringify({ ok: aRefused.ok, status: aRefused.status }));
    const aNotes = aRefused.notes.join('\n');
    check(!/追加|改成|插入/.test(aNotes),
      '⑦拒绝支的 notes **不含**成功叙事（`追加` / `改成` / `插入`）—— 在 ① 类拒绝上这条是**结构上**成立的（notes 压根没来得及 push），钉的是"将来别把 `plan.notes` 接回来"',
      `/追加|改成|插入/ 命中：${(aNotes.match(/追加|改成|插入/g) || []).join(' / ') || '无'}`);
    check(aRefused.errors.length > 0 && aRefused.errors.join(' ').includes('拒绝写入'),
      '⑦但 `errors` 里理由照旧（"拒绝写入"明说，逐条带行号）—— 丢弃的是**剧情**，不是**理由**',
      String(aRefused.errors[0] || '').slice(0, 32));
    check(/什么都没写|什么都没删/.test(aNotes),
      '⑦**空转守卫 + 射程声明**：拒绝支的 notes 是那段"什么都没写/什么都没删"的拒绝说明（**不是空的**）—— '
      + '它不是"plan.notes 被正确丢弃"的证据（那个夹具的 plan.notes 本来就是空的），只是钉住"拒绝时永远有人话"。'
      + '这条**故意**写得会在"有人往拒绝路径上先 push 进度句"时变红：那时它仍然绿，但⑦上面那条会开始**真的**咬合 —— 届时请把本夹具换成能走到那条路径的形态',
      aNotes.slice(0, 26));

    // ⑦b 拒绝支**不许**回传 `plan.notes`（源码级 —— 补上 ⑦ 那一段"没有可达夹具"留下的缺口）。
    // 理由：`plan.notes` 是**边改边写**的进度句。只要拒绝支碰了它，就是"把没发生的动作写成发生了"。
    // 这条不依赖"能不能构造出触发它的夹具"：它直接钉住**接线**（与本节其它源码级断言同一口径）。
    // 为什么值得单开一条：可构造性是可变的（今天不可达 ≠ 明天不可达），而错误的接线一旦接回去，
    // 下一次任何新拒绝路径都会立刻开始撒谎。这条让"接回去"这个动作**当场**变红。
    const mbSrc = await readFile(join(here, 'lib', 'memory-backend.js'), 'utf8');
    check(/return \{ \.\.\.base, errors: plan\.errors, notes: \[refusal\] \};/.test(mbSrc)
      && !/return \{ \.\.\.base, errors: plan\.errors, notes: plan\.notes \};/.test(mbSrc),
      '⑦b**源码级**：`applyMemoryBackend` 的拒绝支逐字回 `notes: [refusal]`（**绝不** `notes: plan.notes`）—— '
      + '这条不靠夹具，直接把"把进度句接回失败回执"这个动作钉死',
      '');
    check(/errors: plan\.errors,\s*\n\s*notes: \[refusal\],/.test(mbSrc),
      '⑦b `removeMidasRow` 的拒绝支同样是 `notes: [refusal]`（与 `applyMemoryBackend` 同一口径 —— 两处不许分叉）',
      '');
  }

  // ── C. 路由 / 分派（源码级：其它路由断言也是源码级）────────────────────────────────────────
  {
    const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
    check(/'remove-midas-row'/.test(cmdSrc) && /body\.action|body && body\.action/.test(cmdSrc),
      '`{action:\'remove-midas-row\'}` 在 `lib/command.js` 里真的接了线（纯函数写对了但没人调用 = 功能没上线）', '');
    check(/action && action !== 'remove-midas-row'/.test(cmdSrc) && /allowed: \['remove-midas-row'\]/.test(cmdSrc),
      '未知 action 被**拒绝**（400 + `allowed` 清单），不静默回落到"存设置值" —— 静默 no-op 会让写错 action 的客户端以为删掉了', '');
    check(/json\(400, \{ ok: false, error: 'unsupported action'/.test(cmdSrc),
      '未知 action 走的是 **400**（不是 200 的"我当你什么都没说"）', '');
    check(/const backend = String\(\(body && body\.backend\) \|\| ''\)\.trim\(\)/.test(cmdSrc)
      && /applyMemoryBackend\(\{ backend/.test(cmdSrc),
      '`{backend}` 那条路径**逐字未动**（新动作不许把既有入口挤掉）', '');
    // 路由条数棘轮：本动作刻意**复用**既有路由 ⇒ 计数必须仍是 15。
    // （`routes-shared.test.mjs` 也钉这一条；这里再钉一次是为了让"顺手新开一条路由"在**本节**就红。）
    const routeSites = (cmdSrc.match(/registerLocal\(\{/g) || []).length;
    const routeMethods = (cmdSrc.match(/^            methods: \[/gm) || []).length;
    check(routeSites === 15 && routeMethods === 15,
      '路由条数仍是**恰好 15**（`registerLocal(` 与 `methods: [` 各 15）—— 本动作挂在**既有**路由上，一条都没多',
      `registerLocal=${routeSites} / methods=${routeMethods}`);
  }

  // ── D. 客户端接线（源码级 + 样式表级）─────────────────────────────────────────────────────
  {
    const cliSrc = await readFile(join(here, 'client.js'), 'utf8');
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const codeOnly = stripComments(cliSrc);
    const cssStart = cliSrc.indexOf('var CSS =');
    const cssEnd = cliSrc.indexOf('// ── session store', cssStart);
    let css = '';
    try { css = (cssStart < 0 || cssEnd < 0) ? '' : new Function(`${cliSrc.slice(cssStart, cssEnd).trimEnd()}\nreturn CSS;`)(); } catch { css = ''; }
    const jsOnly = (cssStart < 0 || cssEnd < 0) ? '' : stripComments(cliSrc.slice(0, cssStart) + cliSrc.slice(cssEnd));

    // ⑲ `.exp-hs-offwarn`：样式表里**有规则**（带点）∧ JSX 侧作为 className **挂载**（不带点）。
    // 两个方向都要查：只查"类名在文件里"抓不住"样式定义了但没人挂"或"挂了但没样式"。
    check(css.includes('.exp-hs-offwarn{margin-top:6px;color:#8a6100;font-weight:700}'),
      '样式表里**逐字**有 `.exp-hs-offwarn` 规则（琥珀色墨水；色值取本文件既有的 `.exp-hs-tag`，不新造色）', '');
    check(/className: 'exp-hs-offwarn'/.test(jsOnly),
      '`.exp-hs-offwarn` 作为 className **真的被挂载**（不带点 —— 带点的写法不匹配任何元素，是"定义了但没人用"的另一种形态）', '');
    check((jsOnly.match(/exp-hs-offwarn/g) || []).length === 1,
      '`.exp-hs-offwarn` 在 JS/JSX 侧**恰好 1 个**挂点（复制到第二处就红 —— 与本仓 ⑦d 的同一套反复制口径）',
      `命中 ${(jsOnly.match(/exp-hs-offwarn/g) || []).length}`);

    // ⑳ 按钮只在服务端明确说"能安全删"时才给（`midasRowPresent` 为真但删不动 ⇒ 只留警告、不给按钮）
    const mbStart = cliSrc.indexOf('function MemoryBackendBlock(props) {');
    const mbEnd = mbStart < 0 ? -1 : cliSrc.indexOf('\n    function ', mbStart + 1);
    const mbBody = (mbStart < 0 || mbEnd < 0) ? '' : cliSrc.slice(mbStart, mbEnd);
    check(/var midasRowAction = \(midasRowLive && st\.midasRowRemovable === true\)/.test(mbBody),
      '移除按钮的渲染条件是 `midasRowLive && st.midasRowRemovable === true` —— 给一个点了必然失败的按钮比不给更糟', '');
    check(/this\.removeMidasRow\(\)|removeMidasRow\(\)/.test(mbBody) && /setArmRemove/.test(mbBody),
      '按钮走"先武装、再确认"的两次点击（`setArmRemove`）—— 删用户补丁文件内容的动作与「清除令牌」同级，沿用同一套确认习惯', '');

    // ㉑ 防御性读法：旧服务端没有这个字段（`undefined`）⇒ 一个字都不许渲染。
    // 所以只认 `=== true`；**绝不用** `!st.midasRowPresent` 之类的反写（那会把 `undefined` 当成"行不在"，
    // 等于替旧服务端编一个它没给的结论）。
    check(codeOnly.includes('st.midasRowPresent === true'),
      '警告的判据写成 `st.midasRowPresent === true`（旧服务端下它是 `undefined` ⇒ 不渲染、不误报也不假报）', '');
    check(!/!\s*(st\.)?midasRow(Present|Live|Removable)\b/.test(codeOnly),
      '源码里**没有**任何 `!midasRow…` 形式的真值反写（把 `undefined` 当成"行不在"就是替旧服务端编结论）', '');

    // ㉒ 移除动作**不碰** `setReceipt(`（那条回执链是给"改后端选择"的，计数被钉在恰好 2）。
    // 计数在**去掉注释**的 `MemoryBackendBlock` 函数体上做 —— 注释里提到这个函数名不算一处调用。
    const setReceipts = (stripComments(mbBody).match(/setReceipt\(/g) || []).length;
    check(setReceipts === 2,
      '`setReceipt(` 在 `MemoryBackendBlock` 里仍**恰好 2 处**（新增的移除动作走 `setMsg`/`setErr` —— 混进回执链会让顶部重启告警框说着上一轮的话）',
      `命中 ${setReceipts}`);
  }
}

console.log('');
for (const r of roots) { try { await rm(r, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ } }
if (skipped) console.log(`（跳过 ${skipped} 项 —— 见上面的原因；跳过不算通过）`);
if (fail > 0) {
  console.error(`✗ 记忆后端三选一：${fail} 项失败`);
  process.exit(1);
}
console.log('✓ 记忆后端三选一：全部通过（纯函数 / 真实文件 / 状态分叉 / 接线 / 受控写入口）');
