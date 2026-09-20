// lead 工具面（A 线 · token 成本治理）· **纯函数，零宿主依赖**。
//
// ── 为什么要收 lead 的工具面 ────────────────────────────────────────────────
// 对真实会话做全量遥测审计的结论（一次性脚本，未随包发布）：
//   · lead 累积上下文的 **89%~98% 是工具结果**，其中 `read` + `bash` + `edit` 约占 **93%**；
//     真实用户需求只占 2%~11%。
//   · 上下文首次越过 10 万 tokens 只发生在全程 **第 1%~2% 的步**，而**越线之后**的步数
//     贡献了 **97%** 的总 prompt 成本 —— 贵在"带着大上下文反复走"，不在"上下文变大"。
//   · 最贵的 run 里 **lead 占该 run prompt 总量的 84%**（另一个 92%），而它 3,244 次工具调用里
//     `subagent` 派工只有 11 次。
// ⇒ 杠杆不是"少说话"（输出 tokens 占总量的比例见 `./metrics/tokens.js`——唯一权威），而是**让执行类工具默认不在 lead 手上**。
//
// ── 机制（已由宿主源码闭环证明，不是推断）────────────────────────────────
// 给 **lead 自己的 agent scope** 施加 `agent.ctx.tools.restrict({deny})` 即可。安全性依据：
//   `dsh-subagent.applyChildComposition` → `agentPresets.composeFrom(childCtx, parent.ctx)`
//     → `standingMountFor(parentCtx)` = `scopeParentOf(parentAgentKey)`（= preset 常驻作用域）
//     → `bindScopeParent(childKey, standingKey)` → `dsh-scope: scopeParents.set(childKey, standingKey)`
//   `dsh-scope.scopeChainOf()` 沿 `scopeParents` 向上走 ⇒ `scopeChainOf(child) = [child, standing, …]`。
//   **lead 的 agent 作用域不在子级的祖先链上** ⇒ 收 lead 不会波及角色子代理。
//   （旁证：本 preset 的 `toolFilter: deny: [bash]`（pm/architect）走的正是同一行代码。）
//
// ── 只读 shell 白名单（2026-09-20 · 真实用户投诉的修复）──────────────────────
// 事故（用户原话的意图）：lead 一个 shell 都没有 ⇒ 它把 `grep` / `md5` / `stat` 这类**诊断/校验**
//   命令写成一段文字交给**用户**，让用户自己去终端里跑。可本包的用户大多不会跑 shell ——
//   这等于把"agent 自己能做的事"变成"用户的工作"，也违背本包的基本契约（agent 自己执行、把结果回给用户）。
// 修法（用户选定的方案）：**给 lead 一个只读 shell 白名单**，三条要点：
//   ① **allow-list，不是 deny-list**：deny-list 对 shell 是**必然**被绕过的（`;` `|` `&&` `$(...)`
//      反引号 `>` `tee` `sed -i` `xargs` `find -exec` `python -c` `node -e` …），每漏一个都是静默失效；
//      这里反过来 —— 只承认一小撮逐条核过的只读形态，其余（含"没见过的新命令"）一律 fail-closed。
//   ② **含元字符整条拒绝，不做净化**：静态判断"引号里的元字符算不算数据"极易出错，而"只看第一个词"
//      是不可靠的（`grep x f; rm -rf y` 的第一个词完全合法）⇒ 把元字符当红线，命中即整条拒绝。
//   ③ **拒绝必须可读、可行动**：理由里写清"为什么拒绝 + 该怎么做"（派角色子代理 / 向用户请求授权），
//      并**明说不要把命令交给用户去终端里跑** —— 那正是本次要修的产品问题。
//   代价（如实记，别把它说成"没放宽"）：白名单只约束**命令种类与链式能力**，不约束文件路径 ——
//      `grep -n x src/a.js` 这类跨目录诊断**正是**要恢复的能力；被它取代的旧口径（`read` 工具只许读
//      `team/`）仍然生效，所以两条边界的口径不同，这是有意的取舍：诊断按命令种类收窄，整读按路径收窄。
//
// ── 本模块只做"算出该 deny 什么 / 该不该放行"，不碰宿主 ────────────────────
// 施加动作在接线处（agent setup 阶段，照宿主自己的时序），本模块保持纯函数（或"纯函数 + 注入 IO"）
// 以便单测：`createLeadToolFaceGate` 的 IO（cwd / extraRoots / 观测 / 谁是 lead）全部由调用方注入。
//
// ── 两条本仓纪律，写死在返回值形状里 ──────────────────────────────────────
//   ① **两种零必须可区分**：`deny: []` 可能是"真的没什么可收"，也可能是"我根本不知道宿主有哪些工具"。
//      两者**不能长得一样** ⇒ 用 `status` 区分（`ready` / `nothing-to-deny` / `no-known-names`）。
//   ② **不静默**：本该存在的名字缺席（核心工具、本平台 shell）必须进 `unexpectedAbsent` 并出声；
//      只有"另一个平台的 shell"缺席是预期的，不当作异常。

import path from 'node:path';

/** 候选：lead 默认不该持有的**执行/探索**类全局工具名（真实名字取自宿主各 tool 包）。 */
export const LEAD_DENY_CANDIDATES = Object.freeze(['bash', 'pwsh', 'write', 'edit', 'grep', 'glob']);

/**
 * 候选里**每个平台都应当存在**的那些。
 * 它们缺席是异常（插件组合变了 / 没装全），必须出声 —— 与"另一个平台的 shell 缺席"区分开。
 */
export const CORE_DENY_TOOLS = Object.freeze(['write', 'edit', 'grep', 'glob']);

/** shell 工具是**平台二选一**的（preset 里 `disabled:` 按平台切）；同时写两个就会让 `restrict()` 抛错。 */
export const SHELL_TOOL_BY_PLATFORM = Object.freeze({ win32: 'pwsh', posix: 'bash' });

/**
 * **含这些字符的命令一律整条拒绝**（不做净化、不尝试理解引号语义）。
 *
 * 每一类都对应一条真实的绕过路径：
 *   `;` `|` `&`   —— 链式执行（`ls; rm -rf x`、`cat f | tee out`、`a && b`）
 *   `>` `<`       —— 重定向写入 / 读取（`echo x > SPEC.md` 正是 R1 门禁覆盖不到的绕过）
 *   `` ` `` `$`  —— 命令替换与变量展开（`$(…)`、`${…}`、`$IFS`）；连裸 `$` 一起拒，
 *                   因为"哪些 `$` 形态无害"要逐条论证，而漏一条就是任意执行。
 *   `\n` `\r` `\0` —— 换行即命令分隔（`ls\nrm -rf x`），且换行能让"只看第一个词"的检查彻底失效。
 *
 * **不拒的字符（有意）**：`\` 只能转义、**不能凭空造出**元字符；`*` `?` `[` 是只读通配；
 *   `'` `"` 只是引号（引号里的元字符照样被上面拒掉）；`~` 是家目录展开。拒它们只会误伤正当诊断。
 */
export const SHELL_METACHARS = Object.freeze([';', '|', '&', '>', '<', '`', '$', '\n', '\r', '\0']);

/** `>= minOperands` 个**非选项参数**才算数（不给文件路径的命令会退化成读 stdin，把会话挂住）。 */
const ANY_ARGS = Object.freeze({ minOperands: 0 });

/**
 * lead 可以**自己**在会话里跑的只读命令（真源；不在表里的一律拒绝）。
 *
 * 取值口径：只承认"逐条核过、没有写入口/执行入口"的形态。刻意保守的地方都写了理由：
 *   · `grep` 要 ≥2 个非选项参数（pattern + 文件）—— `grep x` 是读 stdin，没意义又可能挂住；
 *   · `tail` 禁 `-f`/`-F`/`--follow` —— 它会一直挂着直到超时（只读诊断不该阻塞会话）；
 *   · `sed` 只许只读形态（见 `shellWhitelistDecision` 的注释：`w`/`W` 写文件、`e` 执行命令）；
 *   · `git` 只许 `diff`/`status`/`log` 且禁掉能注入配置/写文件/调外部程序的开关；
 *   · `node` 只许 `--version`/`-v`（`-e`/`-p`/脚本路径都是任意代码执行）；
 *   · `find` **故意不在表里**（`-exec`/`-delete` 是写与执行入口），需要它就换 `ls`/`grep -r`。
 */
export const LEAD_SHELL_ALLOWLIST = Object.freeze({
  pwd: ANY_ARGS,
  echo: ANY_ARGS,
  ls: ANY_ARGS,
  cat: Object.freeze({ minOperands: 1 }),
  head: Object.freeze({ minOperands: 1 }),
  tail: Object.freeze({ minOperands: 1, forbidFollow: true }),
  wc: Object.freeze({ minOperands: 1 }),
  stat: Object.freeze({ minOperands: 1 }),
  md5: Object.freeze({ minOperands: 1 }),
  md5sum: Object.freeze({ minOperands: 1 }),
  grep: Object.freeze({ minOperands: 2 }),
  sed: Object.freeze({ minOperands: 1, readOnlyScript: true }),
  git: Object.freeze({ subcommands: Object.freeze(['diff', 'status', 'log']) }),
  node: Object.freeze({ exactArgs: Object.freeze(['--version', '-v']) }),
});

/** 白名单的一句人读摘要（进模型可见的拒绝理由，让模型知道"还能做什么"）。 */
export const LEAD_SHELL_ALLOWLIST_HINT = 'grep · md5/md5sum · wc · stat · ls · cat · head · tail · sed（只读、无 -i）· git diff/status/log · node --version · pwd · echo';

/** `git` 里能注入配置 / 写文件 / 调外部程序的开关（只读子命令下也必须挡掉）。 */
const GIT_FORBIDDEN_ARGS = Object.freeze([
  /^-c/, /^-C/, /^--output(=|$)/, /^--ext-diff$/, /^--textconv$/,
  /^--exec-path(=|$)/, /^--config-env(=|$)/, /^--upload-pack(=|$)/,
]);

/**
 * lead **保留**但受路径约束的只读工具：只允许读工件目录内的东西。
 * 为什么不是直接 deny：lead 必须能读 SPEC/PLAN/REVIEW 才能做阶段门控与裁决；
 * 要挡的是"整读大源码"这种**探索性**读取（那属于角色子代理的活）。
 */
export const LEAD_GUARDED_READ_TOOLS = Object.freeze(['read', 'read_image']);

/** 工件目录名（相对工作区根）。lead 读这个子树以内的路径一律放行。 */
export const ARTIFACT_SUBDIR = 'team';

/** 归一平台标识：只关心"是不是 Windows"。 */
export function normalizePlatform(platform) {
  const p = String(platform ?? '').toLowerCase();
  return p === 'win32' || p === 'windows' ? 'win32' : 'posix';
}

/**
 * 算出 lead 该 deny 哪些工具、以及哪个 shell 交给**只读白名单守卫**。
 *
 * `shellGuardAvailable` 的语义（fail-closed，别把它做松）：
 *   · `true`  —— 调用方确认已挂上 `tools/pre-execute` 守卫 ⇒ 本平台 shell **不进 deny**（否则模型根本看不见
 *                它、白名单就成了永远不触发的死代码），改由 `guardedShell` 让接线处挂守卫；
 *   · `false` —— 明确没有守卫 ⇒ 退回把 shell 一起 deny 并出声（宁可没有 shell，也不能给一个无约束的 shell）；
 *   · 不传    —— 与 `false` 同样处理（拿不准 ⇒ 拒绝），但**不出声**：这是本模块的历史默认口径
 *                （老调用方/老测试没有"守卫"这个概念），出声只会制造噪声。
 *
 * @param {object} input
 * @param {string} [input.platform] - `process.platform`
 * @param {Iterable<string>} [input.knownNames] - 宿主 `tools.view(scope).restrictableNames`
 * @param {boolean} [input.shellGuardAvailable] - 守卫是否**确认**可用（只有字面 `true` 算确认）
 * @returns {{deny: string[], absent: string[], unexpectedAbsent: string[], expectedShell: string,
 *            expectedShellPresent: boolean, guardedShell: string|null, effective: boolean,
 *            status: string, notes: string[]}}
 */
export function planLeadToolFace({ platform, knownNames, shellGuardAvailable } = {}) {
  const expectedShell = SHELL_TOOL_BY_PLATFORM[normalizePlatform(platform)];
  const otherShell = expectedShell === 'bash' ? 'pwsh' : 'bash';
  const shellGuarded = shellGuardAvailable === true;

  // ── 两种零之一：**不知道宿主有哪些工具** ──────────────────────────────────
  // 这一支绝不能返回"看起来像成功"的结果。`knownNames` 缺失时若返回 `deny: []` 而不加区分，
  // 调用方会以为"工具面已收窄、只是没什么可收"—— 那是本包最讨厌的静默失败。
  //
  // **空数组也算"不知道"**（不是"没什么可收"）：真实部署里 `restrictableNames` 不可能是空的
  // （至少 shell 与 fs 工具都在），所以空清单只可能是"查不到 / 查错了作用域"。
  // 而且 `no-known-names`（"我不知道有什么"）在两种情况下都**真实**，
  // `nothing-to-deny`（"宿主里这些名字都没有"）只在一种情况下真实 —— 拿不准时说那句一定真的。
  const known = knownNames === undefined || knownNames === null ? new Set() : new Set(knownNames);
  if (known.size === 0) {
    return {
      deny: [], absent: [...LEAD_DENY_CANDIDATES], unexpectedAbsent: [],
      expectedShell, expectedShellPresent: false, guardedShell: null, effective: false,
      status: 'no-known-names',
      notes: ['拿不到有效的宿主工具名清单（knownNames 缺失或为空）⇒ **没有**收窄工具面。这不是"没什么可收"，是"我不知道有什么"。'],
    };
  }

  const deny = [];
  const absent = [];
  const unexpectedAbsent = [];
  const notes = [];

  for (const name of LEAD_DENY_CANDIDATES) {
    if (!known.has(name)) {
      absent.push(name);
      // 另一个平台的 shell 缺席是**预期**的（preset 按平台 disabled）—— 不算异常。
      if (name !== otherShell) unexpectedAbsent.push(name);
      continue;
    }
    // 本平台的 shell 是**唯一**一个"不 deny、改交给只读白名单守卫"的候选（见文件头 2026-09-20 段）。
    // 它必须留在**可见**的工具面里：被 deny 的工具模型根本调不到，守卫就成了永远不触发的死代码
    //（本包已经吃过一次"函数写出来了但没人调用"的亏 —— `artifactReadDecision` 就是那样躺了很久）。
    if (name === expectedShell && shellGuarded) continue;
    deny.push(name);
  }

  const expectedShellPresent = known.has(expectedShell);
  const guardedShell = expectedShellPresent && shellGuarded ? expectedShell : null;
  if (!expectedShellPresent) {
    notes.push(`本平台（${normalizePlatform(platform)}）的 shell 工具 \`${expectedShell}\` **不在**宿主工具清单里 —— 执行面收窄的前提不成立，请先确认 shell 插件已挂载。`);
  } else if (!shellGuarded && shellGuardAvailable === false) {
    notes.push(`宿主没有可用的 \`tools/pre-execute\` 守卫 ⇒ 退回把本平台 shell（\`${expectedShell}\`）一起 deny（**fail-closed**：宁可 lead 没有 shell，也不能让它拿到一个**无约束**的 shell）。`);
  }
  if (unexpectedAbsent.length > 0) {
    notes.push(`本该存在的工具缺席：${unexpectedAbsent.map((n) => `\`${n}\``).join(' · ')} —— 插件组合可能变了或没装全（缺席不是"已经收掉了"）。`);
  }

  // ── 两种零之二：**确实没什么可收** ───────────────────────────────────────
  // 注意：**被守卫的 shell 也算"收窄了"** —— 若只看 `deny`，一个"只收到了 shell"的部署会被报成
  // "本次没有收窄任何工具"，而那是一句**不成立**的话。
  if (deny.length === 0 && guardedShell === null) {
    return {
      deny, absent, unexpectedAbsent, expectedShell, expectedShellPresent, guardedShell,
      effective: false, status: 'nothing-to-deny',
      notes: [...notes, 'deny 名单为空 ⇒ **本次没有收窄任何工具**（宿主里这些名字一个都不存在）。'],
    };
  }

  return { deny, absent, unexpectedAbsent, expectedShell, expectedShellPresent, guardedShell, effective: true, status: 'ready', notes };
}

/**
 * lead 的只读工具**是否放行**（`lead` 只读工件）。
 *
 * 口径（刻意 fail-open）：判不出来就**放行** —— 与本包既有拦截器的口径一致
 * （"降级要留痕，但不能把动作变红"）：宁可放过一次探索性读取，也不要因为路径判据写窄
 * 而把 lead 的合法门控动作卡死。
 *
 * @param {object} input
 * @param {string} [input.filePath] - 模型要读的路径
 * @param {string} [input.cwd] - 工作区根
 * @param {string[]} [input.extraRoots] - 额外放行的绝对路径前缀
 * @returns {{allow: boolean, reason: 'artifact'|'outside-artifacts'|'undecidable'}}
 */
export function artifactReadDecision({ filePath, cwd, extraRoots } = {}) {
  if (typeof filePath !== 'string' || filePath === '' || typeof cwd !== 'string' || cwd === '') {
    return { allow: true, reason: 'undecidable' };
  }
  const root = path.resolve(cwd);
  const target = path.resolve(root, filePath);
  const roots = [path.join(root, ARTIFACT_SUBDIR)];
  if (Array.isArray(extraRoots)) for (const r of extraRoots) if (typeof r === 'string' && r !== '') roots.push(path.resolve(r));

  for (const r of roots) {
    // 加分隔符再比前缀：否则 `/w/teamx` 会被 `/w/team` 误判为"在里面"。
    if (target === r || target.startsWith(r + path.sep)) return { allow: true, reason: 'artifact' };
  }
  return { allow: false, reason: 'outside-artifacts' };
}

/**
 * 把"读路径超界"翻译成**模型看得懂、能照着做**的理由（Part 2 的核心）。
 *
 * ── 为什么必须给出**可行动**的理由，而不是一句"拒绝访问"（真实事故）─────────────
 * 2026-09-20：`artifactReadDecision` 判定出的 `reason: 'outside-artifacts'` **从来没有回给模型**
 * （函数写出来了但没人调用，见本文件"只读 shell 白名单"段提到的同一类病），于是 lead 把一次
 * **边界拒绝**读成了"**文件不存在**"，并据此连出了两个错误结论、白做两轮返工。
 * 所以这里的判据不是"有没有拒绝"，而是"拒绝**说了什么**"：
 *   ① 明说这是**边界拒绝**、**不是**"文件不存在"（把误读的那条路堵死）；
 *   ② 明说**下一步怎么做**（派角色子代理 / 向用户请求授权）—— 拒绝而不给替代路径 = 把活卡死。
 *
 * @param {object} input
 * @param {string} [input.filePath] - 模型要读的路径（原样回显，便于模型对上号）
 * @param {string} [input.cwd] - 工作区根（用于把边界画成人能读的绝对路径）
 * @returns {string} 模型可见的拒绝理由（多行，中文）
 */
export function artifactReadDenialReason({ filePath, cwd } = {}) {
  const shown = typeof filePath === 'string' && filePath !== '' ? filePath : '(未给出路径)';
  const boundary = typeof cwd === 'string' && cwd !== ''
    ? path.join(path.resolve(cwd), ARTIFACT_SUBDIR)
    : `工作区根下的 \`${ARTIFACT_SUBDIR}/\``;
  return [
    `read 被 lead 工件边界拒绝：\`${shown}\` 不在 \`${boundary}\` 子树内。`,
    '  · 这是**边界拒绝**，**不是**"文件不存在"、也不是 fs/权限错误 —— 别据此断言文件缺失。',
    '  · 要读代码/配置/其它仓库文件：把这条读取**派给角色子代理**（backend / frontend / researcher / reviewer / qa / dba / devops），由它读并把「path + 摘要」回给你。',
    '  · 确实是 lead 必须亲自读的（例如用户点名要你看的那份文件）：**向用户请求授权**，或请用户把内容贴进对话。',
    '  · 只读诊断（grep / md5 / stat / wc / git diff…）不在本边界内：那类命令可以直接用只读 shell 白名单跑。',
  ].join('\n');
}

/**
 * 只读 shell 白名单判定（**纯函数**：入参只有命令原文，出参只有判定 + 理由）。
 *
 * 判定顺序（每一步都 fail-closed，拿不准就拒绝）：
 *   ① 拿不到命令原文（不是字符串 / 空）            ⇒ 拒绝；
 *   ② 含 `SHELL_METACHARS` 里任一字符              ⇒ 拒绝（**不做净化**，理由见该常量的注释）；
 *   ③ 第一个词不在 `LEAD_SHELL_ALLOWLIST`          ⇒ 拒绝（未知命令一律拒绝，不是"放行再看"）；
 *   ④ 该命令自己的额外约束（`minOperands` / `forbidFollow` / 只读 `sed` 脚本 / `git` 只读子命令 / `node` 只认版本号）。
 *
 * `sed` 为什么单独收窄：`sed` 脚本里 `w`/`W` 会**写文件**、`e` 会**执行命令**（GNU），而
 *   "静态区分脚本里的命令字母与普通字母"不可靠（`s/world/earth/` 里也有 `w`）⇒ 只接受
 *   最保守的形态：**没有 `-i` / `-f` / `-e` / `--expression` / `--in-place`，且脚本里不含 `w` `W` `e`**。
 *   常见的只读用法（`sed -n '1,50p' file`）不受影响。
 *
 * @param {object} input
 * @param {string} [input.command] - 模型要跑的 shell 命令原文
 * @returns {{allow: boolean, code: string, reason: string}} `reason` 仅在拒绝时给出（模型可见）
 */
export function shellWhitelistDecision({ command } = {}) {
  const deny = (code, reason) => ({ allow: false, code, reason });
  const ok = (code) => ({ allow: true, code, reason: '' });

  if (typeof command !== 'string') {
    return deny('unparsable', 'lead 只读 shell：拿不到命令原文（command 不是字符串）⇒ **fail-closed 拒绝**。请重新给出一个字符串命令，或把这条命令派给角色子代理。');
  }
  const cmd = command.trim();
  if (cmd === '') {
    return deny('empty', 'lead 只读 shell：命令为空 ⇒ 拒绝。允许的只读命令：' + LEAD_SHELL_ALLOWLIST_HINT + '。');
  }

  const meta = SHELL_METACHARS.find((ch) => cmd.includes(ch));
  if (meta !== undefined) {
    const shown = meta === '\n' ? '\\n' : (meta === '\r' ? '\\r' : (meta === '\0' ? '\\0' : meta));
    return deny('metachar',
      `lead 只读 shell：命令里含 shell 元字符 \`${shown}\` ⇒ **整条拒绝**（不做净化）。`
      + '这类字符能链式执行（`;` `|` `&&`）、替换（`$(…)` / 反引号）、重定向写入（`>` `<`）——'
      + '"只看第一个词"在这种输入上是不可靠的。请一次只跑一条只读命令（' + LEAD_SHELL_ALLOWLIST_HINT + '）；'
      + '需要管道/重定向/脚本的活，用 subagent 派给角色子代理（它持有完整 bash）。');
  }

  const tokens = cmd.split(/\s+/).filter(Boolean);
  const name = tokens[0];
  const spec = Object.prototype.hasOwnProperty.call(LEAD_SHELL_ALLOWLIST, name) ? LEAD_SHELL_ALLOWLIST[name] : null;
  if (spec === null) {
    return deny('not-allowlisted',
      `lead 只读 shell：\`${name}\` **不在白名单里**（未知/不可判 ⇒ fail-closed 拒绝）。`
      + '允许的只读命令：' + LEAD_SHELL_ALLOWLIST_HINT + '。'
      + '写操作与任意执行（安装/构建/测试/跑脚本、以及任何"我没想到"的命令）不属于 lead ——'
      + '请用 subagent 派给对应角色（qa 跑测试、backend/frontend 改代码、devops 跑构建/部署），'
      + '它在**同一个会话里**执行并把结果回给你。**不要把这行命令交给用户去终端里跑** ——'
      + '用户不会跑 shell，这正是本机制要修的问题。');
  }

  const args = tokens.slice(1);
  const operands = args.filter((a) => !a.startsWith('-'));

  if (Array.isArray(spec.exactArgs)) {
    // 每个参数都必须是**列出的那一小撮**之一，且至少给一个（`node` 单独跑会读 stdin ⇒ 挂住）
    if (!(args.length > 0 && args.every((a) => spec.exactArgs.includes(a)))) {
      return deny('args-not-exact',
        `lead 只读 shell：\`${name}\` 只允许 ${spec.exactArgs.map((a) => `\`${a}\``).join(' / ')} ——`
        + '`-e`/`-p`/脚本路径都是**任意代码执行**，不属只读诊断。要跑 node 脚本请派给角色子代理。');
    }
    return ok('node-version');
  }

  if (Array.isArray(spec.subcommands)) {
    const sub = args[0];
    if (!spec.subcommands.includes(sub)) {
      return deny('subcommand',
        `lead 只读 shell：\`${name}\` 只允许只读子命令 ${spec.subcommands.map((s) => `\`${name} ${s}\``).join(' / ')}`
        + `（收到的是 \`${sub === undefined ? '(缺子命令)' : sub}\`）。写仓库、切分支、提交都不属于 lead —— 派给角色子代理。`);
    }
    const bad = args.find((a) => GIT_FORBIDDEN_ARGS.some((re) => re.test(a)));
    if (bad !== undefined) {
      return deny('git-unsafe-arg',
        `lead 只读 shell：\`git ${sub}\` 不接受 \`${bad}\` —— \`-c\`/\`-C\`/\`--exec-path\`/\`--config-env\` 能注入配置或调外部程序，`
        + '`--output` 会**写文件**，`--ext-diff`/`--textconv` 会调外部 diff 驱动。请去掉它，或把这条命令派给角色子代理。');
    }
    return ok('git-readonly');
  }

  if (spec.forbidFollow === true) {
    const follow = args.find((a) => a === '--follow' || a === '--follow=name' || /^-[A-Za-z]*[fF]/.test(a));
    if (follow !== undefined) {
      return deny('follow-flag',
        `lead 只读 shell：\`${name} ${follow}\` 会**一直挂着**直到超时（\`-f\`/\`-F\`/\`--follow\` 是跟读日志），`
        + '只读诊断不该阻塞会话。要跟日志请派给 devops 子代理，或改用不带 `-f` 的 `tail`。');
    }
  }

  if (spec.readOnlyScript === true) {
    const bad = args.find((a) => /^-i/.test(a) || a === '--in-place' || a.startsWith('--in-place=')
      || a === '-e' || a.startsWith('--expression') || a === '-f' || a.startsWith('--file'));
    if (bad !== undefined) {
      return deny('sed-inplace',
        `lead 只读 shell：\`sed ${bad}\` 不是只读用法 —— \`-i\`/\`--in-place\` 就地改写文件，\`-e\`/\`--expression\`/`
        + '`-f`/`--file` 让脚本来源不可静态检查。请改用 `sed -n \'<范围>p\' <文件>`。');
    }
    // 脚本 = 第一个非选项参数（`-e`/`-f` 已在上一步拒掉，所以脚本只可能在这一处）。
    const script = operands[0];
    if (typeof script === 'string' && /[wWe]/.test(script)) {
      return deny('sed-write-command',
        'lead 只读 shell：`sed` 脚本里含 `w` / `W` / `e` ⇒ 拒绝 —— `w`/`W` **写文件**、`e` **执行命令**（GNU），'
        + '而"区分脚本里的命令字母与普通字母"不可靠（`s/world/earth/` 里也有 `w`）。'
        + '只读取行请用 `sed -n \'1,50p\' <文件>`，或改用 `grep` / `head` / `tail`。');
    }
  }

  const minOperands = typeof spec.minOperands === 'number' ? spec.minOperands : 0;
  if (operands.length < minOperands) {
    return deny('missing-operand',
      `lead 只读 shell：\`${name}\` 至少需要 ${minOperands} 个文件/模式参数（收到 ${operands.length} 个）——`
      + '不给路径的命令会退化成"读 stdin"，在本会话里既没意义又可能把调用挂住。请补上文件路径。');
  }

  return ok('allowlisted');
}

/** 本 preset 的 id（**实测值**：34 个真实会话头的 `agentPreset` 都是这个串，另 6 个是 `standard`）。 */
export const LEAD_PRESET_ID = 'expert-team';

/**
 * 该不该对**这个** agent 收窄工具面。
 *
 * 判据两条，缺一不可：
 *   ① **preset 必须是专家团**。读法 `agentPresets.composedPreset(agent.ctx)` —— 宿主写明它
 *      "read from the live scope chain rather than from the session"，因此对**还没写会话头**的
 *      agent 也答得出来。非专家团返回 `false`（**静默返回**，不是失败：绝大多数 agent 都无关）。
 *   ② **必须是根 agent（lead），不能是角色子代理**。这一条是安全闸门，不是优化：
 *      角色子代理是用 `composeFrom` 从**同一个 preset** 组合出来的 ⇒ 它们的
 *      `composedPreset` **同样是 `expert-team`**。若不查 ②，A2 会把角色的 bash 一起收掉 ——
 *      正好是要避免的事故。判据用 `agents.roots()`（宿主文档："created **without an owning
 *      agent context**"），它按运行时归属判定，不受会话血缘影响。
 *
 * @param {object} input
 * @param {string|undefined} [input.presetId] - `agentPresets.composedPreset(agent.ctx)`
 * @param {boolean} [input.isRoot] - `agents.roots().includes(agent)`
 * @returns {{apply: boolean, reason: 'lead'|'not-expert-team'|'is-subagent'}}
 */
export function shouldNarrowLeadToolFace({ presetId, isRoot } = {}) {
  if (presetId !== LEAD_PRESET_ID) return { apply: false, reason: 'not-expert-team' };
  if (isRoot !== true) return { apply: false, reason: 'is-subagent' };
  return { apply: true, reason: 'lead' };
}

/**
 * 取**agent 作用域**下的"可限制工具名清单"。
 *
 * ── 为什么必须带 scope（这一条是拿真机日志换来的）────────────────────────────
 * 宿主 `tools.view(scope)` 的文档写得很直白：**不传 scope = 全局视图**。而 0.1.5 起模型可见的
 * `bash/write/edit/grep/glob` 由 **preset 注册在 agent 平面**，不再是全局工具 ——
 * 于是 `view()`（全局）会返回一个**非空但缺这几个名字**的集合，`planLeadToolFace` 据此报
 * `nothing-to-deny`，收窄**静默失效**，而日志还在说"宿主里这些名字一个都不存在"（不属实）。
 * 宿主自己的 `restrict()` 用的就是 `scopeOf(this.ctx)` —— 本函数照抄同一条取 scope 的路。
 *
 * scope 是 `@deepseek-ai/dsh-scope` 里的**模块私有 Symbol**（`Symbol("dsh.scope")`，不是
 * `Symbol.for`），因此只能经该包的 `scopeOf()` 取得 ⇒ **动态 import**：仓库里解析不到该包时
 * 返回 `knownNames: undefined`，由调用方如实报 `no-known-names`（"我不知道有什么"），
 * 绝不退化成"宿主里没有这些工具"那种**不成立**的结论。
 *
 * @param {object} input
 * @param {object} [input.agentCtx] - `agent.ctx`（scope 就挂在它上面）
 * @param {object} [input.tools] - 工具服务（默认取 `agentCtx.tools`）
 * @param {Function} [input.loadScope] - **仅供测试**注入 `@deepseek-ai/dsh-scope` 的加载器
 * @returns {Promise<{knownNames: Set<string>|undefined, reason: string}>}
 */
export async function agentScopedToolNames({ agentCtx, tools, loadScope } = {}) {
  const loader = typeof loadScope === 'function' ? loadScope : () => import('@deepseek-ai/dsh-scope');
  let scopeOf;
  try {
    const mod = await loader();
    scopeOf = mod && mod.scopeOf;
  } catch (e) {
    return { knownNames: undefined, reason: 'scope-module-unavailable:' + String((e && e.message) || e) };
  }
  if (typeof scopeOf !== 'function') return { knownNames: undefined, reason: 'scope-of-missing' };
  const service = tools || (agentCtx && agentCtx.tools);
  if (!service || typeof service.view !== 'function') return { knownNames: undefined, reason: 'tools-service-unavailable' };
  let scope;
  try { scope = scopeOf(agentCtx); } catch { return { knownNames: undefined, reason: 'scope-undetectable' }; }
  if (scope === undefined) return { knownNames: undefined, reason: 'not-a-scoped-ctx' };
  try {
    const view = service.view(scope);
    const names = view && view.restrictableNames;
    const size = names && typeof names.size === 'number' ? names.size : 0;
    return { knownNames: names, reason: size > 0 ? 'ok' : 'empty-scoped-view' };
  } catch (e) {
    return { knownNames: undefined, reason: 'view-failed:' + String((e && e.message) || e) };
  }
}

/**
 * 创建 lead 工具面的 `tools/pre-execute` 守卫：**只读 shell 白名单 + 读路径边界**。
 *
 * ── 为什么挂在 `tools/pre-execute`（照 `lib/artifact-ownership.js` 的先例）──────────
 * 它是**跑之前**的瀑布：能真正拦下命令（`post-execute` 只能改结果，命令已经跑过了）。
 * 监听器签名是 **(exec, next)**（瀑布的末参是内层 `next`）。
 *
 * ── 三条硬纪律（本仓拿真实事故换来的，逐条对齐 `interception.js:208-212`）──────────
 *   ① **签名按宿主声明写**：`(exec, next)`。2026-09-12 的事故是 `post-execute` 监听器写成
 *      `(exec, next)`（应为 `(exec, result, next)`）⇒ 宿主把**每一次工具调用**都归一化成失败（全工具瘫痪）。
 *      这里同样把"`next` 不是函数"当成"回调契约不成立" ⇒ 降级为**不干涉**（`allow`），绝不抛错。
 *   ② **自身逻辑全包在 try/catch 里**，绝不让它成为工具故障源（监听器抛错会被宿主收敛成执行失败）。
 *   ③ **本门禁只管 lead 的调用**：`isLead(exec.agent)` 必须为真，否则一律返回下游判定。
 *      判据由调用方注入（`WeakSet` 查表），**不是**每调用一次去问 preset —— 少一步 I/O 就少一类失败。
 *
 * ── 降级方向：**这里与 `artifact-ownership.js` 刻意相反**（必须写清楚，否则会被"统一口径"改坏）──
 *   · 那里 fail-open（判不出归属就放行）：它守的是**协作纪律**，误拦会把正常落盘打死；
 *   · 这里对 **shell 工具 fail-closed**（拿不准 ⇒ 拒绝）：它守的是**授权边界**，判不出就放行 =
 *     给 lead 一个**无约束 shell**（本包的头号病灶："静默失效"）。拒绝也**不是抛错** ——
 *     只是把这**一次** shell 调用判为失败，并把可行动的理由交回模型（派角色子代理 / 请求授权）。
 *   · 读路径（`read`/`read_image`）沿用 `artifactReadDecision` 既有的 fail-open 口径（`undecidable` ⇒ 放行）：
 *     它是**范围/token 边界**，不是授权边界，卡死 lead 的门控动作同样是事故。
 *
 * @param {object} deps - 注入依赖（全部可选，缺省即最保守行为）：
 *   `isLead(agent) => boolean`（谁是 lead；返回非 `true` 一律不干涉）、
 *   `cwdFor(exec) => string|undefined`（会话工作区根；取不到 ⇒ 读判定退化为 undecidable ⇒ 放行）、
 *   `extraRoots: string[]`（额外放行的**读**路径前缀，例如专家团自己的技能/模板目录）、
 *   `onEvent(type, payload)`（可观测：拒绝/降级/异常都要看得见）
 * @returns `(exec, next) => Promise<{kind:'allow'|'deny', reason?:string}>`
 */
export function createLeadToolFaceGate({ isLead, cwdFor, extraRoots, onEvent } = {}) {
  const shellTools = new Set(Object.values(SHELL_TOOL_BY_PLATFORM));
  const readTools = new Set(LEAD_GUARDED_READ_TOOLS);
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const trace = (type, payload) => { try { emit(type, payload); } catch { /* 观测失败绝不影响工具调用 */ } };
  const allow = { kind: 'allow' };

  return async function leadToolFaceGate(exec, next) {
    // ① 回调契约：`next` 不是函数 ⇒ 不干涉（绝不抛错 —— 见上面纪律①②）
    if (typeof next !== 'function') return { ...allow };
    let downstream;
    try {
      downstream = await next();
    } catch (e) {
      trace('lead-toolface-gate-error', { stage: 'downstream', message: String((e && e.message) || e) });
      return { ...allow };
    }
    // ② 下游（更严格的判定）已经 deny/ask ⇒ 不插嘴；也只认 allow 才继续判。
    //    ⚠ 下游**没给出合格的 decision**（undefined / 不是对象 / 没有 kind）时，本门禁负责**补齐**
    //    `{kind:'allow'}` 再往下传：宿主 `prepareExecution` 拿到瀑布结果后**直接读 `gate.kind`**，
    //    原样返回 undefined 会让它抛 TypeError ⇒ 整次工具调用被判成失败 ——
    //    这正是 2026-09-12 那次"全工具瘫痪"的形状（监听器让别的工具的调用变红）。绝不留这种可能。
    const pass = downstream && typeof downstream === 'object' && downstream.kind ? downstream : { ...allow };
    if (pass.kind !== 'allow') return pass;

    const name = String((exec && exec.name) || '');
    let mine = false;
    try { mine = typeof isLead === 'function' && isLead(exec && exec.agent) === true; } catch { mine = false; }
    // ③ 不是 lead 的调用（角色子代理 / 其它会话 / 其它 preset）⇒ **一律不干涉**。
    //    这一条是安全闸门：角色子代理必须保留完整 shell（qa 跑测试、backend 跑构建全靠它）。
    if (!mine) return pass;

    try {
      if (shellTools.has(name)) {
        const args = (exec && exec.arguments) || {};
        // 参数名与 `artifact-redirect-watch.js` 同一口径（bash/pwsh 都叫 `command`；老版本可能是 `cmd`/`script`）
        const raw = args.command !== undefined ? args.command : (args.cmd !== undefined ? args.cmd : args.script);
        const verdict = shellWhitelistDecision({ command: raw });
        if (verdict.allow) return pass;
        trace('lead-shell-denied', { tool: name, code: verdict.code });
        return { kind: 'deny', reason: verdict.reason };
      }
      if (readTools.has(name)) {
        const args = (exec && exec.arguments) || {};
        const filePath = typeof args.file_path === 'string' ? args.file_path : '';
        const cwd = typeof cwdFor === 'function' ? cwdFor(exec) : undefined;
        const verdict = artifactReadDecision({ filePath, cwd, extraRoots });
        if (verdict.allow) return pass;
        trace('lead-read-denied', { tool: name, reason: verdict.reason, filePath });
        return { kind: 'deny', reason: artifactReadDenialReason({ filePath, cwd }) };
      }
      return pass;
    } catch (e) {
      trace('lead-toolface-gate-error', { stage: 'decide', tool: name, message: String((e && e.message) || e) });
      // ④ 判不出来时的降级方向（见上面"降级方向"段）：shell 守授权边界 ⇒ fail-closed；
      //    其余工具不归本门禁管 ⇒ 放行（绝不把无关工具变红）。
      return shellTools.has(name)
        ? { kind: 'deny', reason: 'lead 只读 shell：白名单门禁内部异常 ⇒ **fail-closed 拒绝这一次调用**（绝不静默放行一个无约束的 shell）。请把这条命令派给角色子代理，或改用白名单内的只读命令：' + LEAD_SHELL_ALLOWLIST_HINT + '。' }
        : { ...allow };
    }
  };
}
