// @yangdcm/dsh-expert-team — /team command plugin.
//
// Human-facing entry for the「专家团」product. It is a host-plane command row
// (added by cordis.patch.yml), so it runs for every session's command surface
// and does not depend on the agent preset's tool roster.
//
// The command parses the user's request, scaffolds the shared-workspace run
// under <cwd>/team/<run>/, makes sure the `expert-team` skill is discoverable
// in $DSH_HOME/skills, and then enqueues ONE model-visible user message that
// tells the orchestrating agent to load that skill and run the team. The skill
// owns the actual orchestration protocol (roles, phases, artifacts, efficiency
// rules); this file only owns the durable surface (parse + scaffold + launch +
// status/resume/clear).

import { randomUUID } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactWriter, nodeFsPort, cordisFsPort, DEFAULT_SCHEMA_GUARDS } from './artifact-writer.js';
import { writeHostStateFileAtomic } from './host-state-file.js';
// 铺盘的**归属判定**（四态，纯函数）+ **原子换名**编排 + 状态：单一真源在 `lib/preset-lay.js`。
// 目录级换名的原语在 `lib/host-state-file.js`（受控入口）—— 理由见 `lib/preset-lay.js` 文件头。
import {
  classifyLayTarget, layDirAtomic, cleanStaleLayDirs, listEntryNames,
  presetLayStatus, recordLayOutcome, describeLayOutcome, _resetPresetLay,
  skillRuntimeRegisteredRecord,
  LAY_TMP_PREFIX, LAY_STATES, LAY_ACTIONS, LAY_KINDS, LAY_OUTCOMES,
} from './preset-lay.js';
import { createBoundaryInterceptor } from './interception.js';
import { createOwnershipGate, ARTIFACT_OWNERS } from './artifact-ownership.js';

/**
 * **run 模板文件清单**（单一真源）。
 * 谁在用：① 建 run 时按它复制 `skills/expert-team/assets/templates/`；② R1 绕过检测
 * （`bash` 里重定向写 run 工件 ⇒ 只留痕）需要"已知工件名"集合。**不要再复制一份** ——
 * 本仓为"同一事实多份定义"专门有 `vocab-consistency` / `artifact-ownership` 断言。
 */
export const ARTIFACT_TEMPLATES = Object.freeze(['TASK.md', 'ROSTER.json', 'STATE.json', '任务看板.md', 'SPEC.md', 'PLAN.md', 'RESEARCH.md', 'TASKS.json', 'REVIEW.md', 'TEST.md', 'SUMMARY.md', 'RETRO.md', 'AUTHORITY.md']);
// 设计稿 §十二 第 3 步：并发写留痕（只记录、只告警，绝不阻断）。
import { createWriteTracer, formatConflict } from './write-tracer.js';
import { createEffortPreflight, effortPreflightPlan, declaredEffortsFromPresetSource, EFFORT_PROBE_DELAYS_MS } from './effort-preflight.js';
import { createArtifactRedirectWatcher } from './artifact-redirect-watch.js';
// 1.3.18 一期：Hindsight 记忆后端的**只读诊断**（配置/日志/连通性；不写任何文件、不回显 token）。
import { buildHindsightReport } from './hindsight-config.js';
// 1.3.21 二期：Hindsight 配置的**写路径**（读-改-写合并保未知键 / 0600 原子写 / token 不回显 / 显式清除）。
import { saveHindsightConfig } from './hindsight-config-write.js';
import { createLoopGuard } from './loop-guard.js';
// C 线第 17 项：派工即回写（派工成功后由**代码**把任务置 in_progress + owner，不靠模型记得改）。
import { createDispatchLedger } from './dispatch-ledger.js';
import { readRequestBody, withRoute, localOnly } from './routes/shared.js';
import { renderMetrics } from './metrics/render.js';
// E 线 E1/E2：首产物耗时（`first-runnable` − `run:started`）与收尾预算（实现期 vs 冻结后收尾）。
// 时钟算术**只此一份** —— 两处各写一遍等于故意埋一次「一个事实多份拷贝」（本仓头号返工源）。
import { clockDeltaMinutes, summarizeFirstRunnable, runTimeline, summarizeClosingBudget } from './metrics/timing.js';
import { listRunNames, readRunInputs } from './metrics/collect.js';
// P5 线（token 记账）：把「一次 run 烧掉多少 token、上下文涨到多大」变成 METRICS 里可读的数。
// 为什么要有它：审计 10 个真实顶层会话 + 57 个角色会话后发现，输出 tokens 占比极低（**占比口径与数值的唯一权威是 `./metrics/tokens.js`**）、
// 99.2% 的输入是缓存读、每步 prompt 中位数 426K、lead 层累计 prompt 是角色层的 5.1 倍 ——
// 而**技能里没有任何 token/上下文维度的定额**，METRICS 也从不渲染 token ⇒ 这件事完全隐形。
import { collectTokenUsage } from './metrics/token-usage.js';
import { renderTokenSection } from './metrics/tokens.js';
// A 线（token 成本治理 · 第 2 步）：**收窄 lead 自己的工具面**。判定全在
// `lib/lead-toolface.js`（纯函数、零宿主依赖、可单测）；这里只负责在 agent **创建时刻**接线。
import { planLeadToolFace, shouldNarrowLeadToolFace, agentScopedToolNames } from './lead-toolface.js';
// G 线（档位）：档位词表/裁剪表/suggestTier 的**唯一真源**。SKILL 的裁剪表、`/team status`
// 的输出、浮层候选项全部从这里来 —— 两处各写一份就是又一次「一个事实多份拷贝」。
import { normalizeTier, suggestTier, tierSummaryLine, tierDetailLines, tierChoices, TIER_SPEC, TIER_LABELS_ZH, DEFAULT_TIER, narrowedRoles } from './tier.js';
// B 线 11b：中文标签 / 角色关键词表 / 阶段词表 / 已知角色集合的**唯一真源**。
// 收拢前 `KIND_ZH`+`ALLOWED_KINDS`+手写的 `ALLOWED_KINDS_ZH` 是同一件事的三份拷贝。
import {
  roleLabelKey, PHASES, PHASE_ZH, STATUS_ZH, KIND_ZH, VERDICT_ZH, ROLE_ZH, MODE_ZH, ACTIVITY_ZH, DELIVER_ZH,
  ALLOWED_KINDS, ALLOWED_KINDS_ZH, SUB_ROLE_WORDS, KNOWN_ROLES, ROLE_LABELS_ZH,
  phaseZh, statusZh, kindZh, verdictZh, roleZh, modeZh, activityZh, deliverZh,
  DEFAULT_ROLES,
} from './vocab.js';
// B 线第 8 项第一步：上限与校验器簇搬进 `lib/validate.js`（纯函数、零 IO）。
import {
  DEFAULT_LIMITS, LIMITS, LIMIT_ENV, pickLimitValue, resolveLimits, capacityViolations,
  DEFAULT_ROUND_LIMITS, ROUND_LIMITS, ROUND_LIMIT_ENV, resolveRoundLimits, ROUND_LIMIT_OF_KIND,
  roundOf, isQualityTask, normTitle, findingText, roundLimitViolations, findingReopenInputMissing,
  checkKindWarnings, validateTaskGraph, schemaViolations, checkTasks,
  phaseAccountingViolations, loggedPhases, authorityViolations, singleSourceShare,
} from './validate.js';
// B 线第 8 项 · 日志解析搬进 `lib/log-parse.js`（消掉我为阶段记账临时抄的那份简化解析器）。
import {
  roleNorm, parseLogLine, eventFamily, truncateCodepoints, tallyEvent, eventTallyLines, normalizeRoleName,
  VERDICT_TOKEN_WRAPPERS, VERDICT_TOKENS, verdictFromToken, extractRole, extractVerdict,
  ENV_ERROR_FAMILIES, classifyErrorFamily,
} from './log-parse.js';
// B 线第 8 项 · `/team` 的 CLI 面搬进 `lib/command-parse.js`（只解析、不执行）。
import { USAGE, resolveProfile, parseTeamCommand } from './command-parse.js';
// F 线：设置控制台的 spec / 校验 / 合并（纯函数模块，UI 表单结构也由它生成）。
import { SETTINGS_GROUPS, SETTINGS_SPEC, defaultSettings, normalizeSettings, mergeSettings, settingsSchema, compilePolicy, policyBlockFrom } from './settings.js';
// 宿主设置命名空间接线（1.2.0）：设置进官方面板 + 随市场备份恢复 + 改动即时生效。
// 模块内部用**动态 import** 取 schemastery，因此本仓在没有 profile 的环境里照样能跑测试。
import { installHostSettings, hostValues, hostScope, hostSettingsNote, updateHostSettings, pickFileOnly, pickHostExpressible, HOST_SETTINGS_NAMESPACE, buildHostSchema, hostBase, hostSchemaPaths } from './host-settings.js';
// 子代理列表「最新在上」（展示顺序覆盖）：只遮蔽宿主送到浏览器的那一个 remote 方法
// （`subagents/list` → `remoteExportList`），**不动服务端 `listChildren` 的升序契约**。
// 宿主结构不匹配 ⇒ 不装 + 如实上报（`effective:false`），GUI 退回默认顺序、插件照常加载。
import { applySubagentOrder, disposeSubagentOrder, subagentOrderStatus, SUBAGENT_ORDER_SERVICE } from './subagent-order.js';

/**
 * 工件写入的受控入口（批 2-1）。
 *
 * 默认走 `nodeFsPort()`（同语义的版本栅栏/陈旧重试/范围硬排除/revision）；
 * `apply(ctx)` 里若发现宿主提供 `ctx.fs`，则**优先换成真实宿主栅栏**（`cordisFsPort`）。
 *
 * 注意：这里**故意不把 'fs' 加进 `export const inject`** —— 一旦 inject 了宿主没有的服务，
 * 整条 `/team` 命令会挂不上（架构师在 invariants 那项上实测过同类风险）。用机会式 `ctx.get('fs')`
 * + 回退，既拿到宿主栅栏，又不会因为环境差异导致命令消失。
 */
// 批 2-3（L1-3′）归因：模块级写入者身份（由命令处理器按会话更新）。
// 目的：让工件的 _provenance.writer 记录**是哪个会话/角色写的** —— 直接回应 R-3「漂移不可归因」。
let WRITER_IDENTITY = null;
const writerEvents = (e) => { try { pushActivityEvent(e); } catch { /* 观测不该影响写入 */ } };
let ARTIFACT = createArtifactWriter({ fsPort: nodeFsPort(), onEvent: writerEvents, identity: () => WRITER_IDENTITY });
/**
 * 已被接管的宿主 `ctx.fs`（若宿主提供）。**只在读路径（`/file`）里用**。
 *
 * 为什么单独留一个引用：工件写入从批 2-1 起就走宿主策略了，但浮层的文件预览一直在用裸
 * `readFile` —— 同一台机器上两套读规则，等于绕开宿主的 fs 策略（观察策略/沙箱）。
 */
let ADOPTED_HOST_FS = null;

/** 让宿主 `ctx.fs` 接管写入（若可用）；返回是否接管成功。 */
function adoptHostFs(ctx) {
  try {
    const hostFs = ctx && typeof ctx.get === 'function' ? ctx.get('fs') : null;
    if (hostFs && typeof hostFs.writeText === 'function' && typeof hostFs.resolve === 'function') {
      ARTIFACT = createArtifactWriter({ fsPort: cordisFsPort(hostFs), onEvent: writerEvents, identity: () => WRITER_IDENTITY });
      ADOPTED_HOST_FS = hostFs;
      return true;
    }
  } catch { /* 宿主 fs 不可用则保持回退实现 */ }
  return false;
}

/**
 * schema 告警**去重**（进程内）——同一个「文件 + 同一条告警」只喊一次。
 *
 * 为什么需要：写入点的告警是"每次写入都报"的口径，而**同一份脏数据会被反复写入**：
 * 典型是 `coverage` 这类**存量**违约 —— 文件内容一旦带上脏字段，之后每次改写
 * （含 C3 的派工登记回写：每来一个新成员就写一次 STATE.json）都会重新触发同一条告警。
 * 结果是控制台被同一条消息刷屏，而**噪音会让用户对告警整体降权**（本插件反复记录的失败模式）。
 * 去重只影响**重复次数**，不影响"第一次一定喊"—— 也**不隐藏**任何不同内容的告警。
 * 进程级（重启后重新喊一次，符合"冷启动应重新可见"的预期）。
 */
const SCHEMA_WARN_SEEN = new Set();

/** 写入事件的轻量落盘（可观测性；失败不影响写入）。 */
function pushActivityEvent(e) {
  if (!e || !e.type) return;
  if (e.type === 'schema-warn') {
    // 批 2-4（L1-4′）：schema 告警**只上报、不阻断** —— 让「生产端违约」不再是静默的
    const sig = `${e.target || ''}\u0000${e.message || ''}`;
    if (SCHEMA_WARN_SEEN.has(sig)) return; // 同一条已喊过：不再刷屏（去重不改口径）
    SCHEMA_WARN_SEEN.add(sig);
    console.warn(`[expert-team] 工件 schema 告警：${e.target || ''} —— ${e.message || ''}`);
    return;
  }
  if (e.type === 'revision-regression' || e.type === 'writer-changed') {
    // 批 2-3（L1-3′）归因：直接回应 R-3「漂移不可归因：只能证明文件被改写，不能证明写入进程身份」。
    // 只上报、不阻断 —— 响亮地告诉"这份工件被动过/被回退过"，而不是静默接受。
    const detail = e.type === 'revision-regression'
      ? `revision 回退：本进程上次写到 ${e.lastWritten}，磁盘上却是 ${e.onDisk}`
      : `写入者变化：磁盘 writer=${e.onDiskWriter}，本进程=${e.me}`;
    console.warn(`[expert-team] 工件归因告警（${e.type}）：${e.target || ''} —— ${detail}`);
    return;
  }
  if (e.type === 'scope-denied' || e.type === 'version-stale' || e.type === 'revision-stale') {
    console.warn(`[expert-team] 工件写入事件 ${e.type}：${e.target || ''} ${e.reason || e.error || ''}`);
  }
}

const execFile = promisify(execFileCb);

export const name = 'expert-team-command';
export const inject = ['commands'];

// ── live per-agent activity feed (Qoder-style right panel) ─────────────────
// `tools/result` (host post-event) gives exec.name / exec.arguments /
// exec.agent + result.content|isError — enough to render「已查看 x.py /
// 已检索 def … / 已运行 …」per subagent, exactly like Qoder's agent cards.
const ACTIVITY = new Map(); // agent(session) id → [{ts, line, preview}]
const ACTIVITY_MAX = 30;
function pushActivity(buf, key, entry) {
  const arr = buf.get(key) || [];
  arr.push(entry);
  if (arr.length > ACTIVITY_MAX) arr.splice(0, arr.length - ACTIVITY_MAX);
  buf.set(key, arr);
}
// Every label is Chinese, because the feed line is user-facing Chinese copy.
// A tool with no label here used to render as `已` + its English id (truncated:
// `已structured_o`), i.e. half Chinese half English — see TOOL_LABEL_FAMILIES and
// the Chinese-only fallback below.
const TOOL_LABEL = {
  read: '已查看', 'read-text': '已查看', 'read-img': '已查看图片', read_image: '已查看图片',
  write: '已写入', edit: '已编辑', bash: '已运行', grep: '已检索', 'fs-search': '已检索',
  search: '已检索', web_search: '已搜索', web_fetch: '已读取网页', glob: '已匹配文件',
  list_agents: '已查成员', send_message: '已发消息', job_output: '已收消息', job_list: '已查任务',
  job_kill: '已终止任务',
  skill: '已加载', subagent: '已派', subagent_fork: '已派', workflow: '已编排', ralph: '已跑 Ralph',
  todo_write: '已更新清单', ask_user_question: '已提问', hindsight_ingest_document: '已记知识',
  hindsight_search_knowledge_pages: '已查知识', hindsight_list_knowledge_pages: '已列知识', hindsight_read_knowledge_page: '已读知识',
  hindsight_reflect: '已深度回想', hindsight_sync_status: '已查记忆同步', hindsight_diagnose: '已诊断记忆',
  create_goal: '已建目标', update_goal: '已改目标', get_goal: '已读目标', exit_plan_mode: '已提交方案',
  // The in-process subagent driver's result tool: the child submits its final
  // structured result and ends its run.
  structured_output: '已提交结构化结果',
  interrupt_agent: '已中断子代理',
  dsh_im_return_file: '已发文件',
};
/** Tool families whose label is decided by prefix (keeps future members Chinese). */
const TOOL_LABEL_FAMILIES = [
  [/^subagent/, '已派'],
  [/^mcp_connector_/, '已操作连接器'],
  [/^browser_/, '已操作浏览器'],
  [/^hindsight_/, '已查知识'],
  [/^job_/, '已查任务'],
  [/^dsh_im_/, '已发文件'],
];
/** Final fallback: Chinese, never glued to an English tool id. */
const TOOL_LABEL_FALLBACK = '已执行操作';
function toolArg(exec) {
  try {
    const a = exec.arguments;
    if (!a || typeof a !== 'object') return '';
    for (const k of ['file_path', 'path', 'pattern', 'command', 'queries', 'query', 'url', 'name', 'title']) {
      const v = a[k];
      if (v != null) return String(Array.isArray(v) ? v[0] : v);
    }
    return '';
  } catch { return ''; }
}
// ── tool-call summaries for the live feed ───────────────────────────────────
// The overlay prints one line per tool call, so a summary must read as an
// ACTION, not as a dump of the raw argument. A compound shell line such as
// `cat ~/.dsh/profiles/web/cordis.yml; echo "=== profiles dir ===";` used to
// surface verbatim (and, once escaped for markup upstream, as literal
// `&quot;`) — a long, meaningless line in the capsule. The fix is twofold:
// decode any entity that reaches a summary, and summarise a shell line as
// "primary action (+N more parts)" instead of echoing it.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' };
/** Decode HTML entities that reached a summary through an escaping layer. */
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}
/** Middle-truncate, so the tail (usually the file name) survives. */
function clip(s, max = 52) {
  const str = String(s == null ? '' : s);
  return str.length <= max ? str : str.slice(0, Math.max(0, max - 9)) + '…' + str.slice(-8);
}
/** Split a shell line into its commands (honours quotes; `|` counts as a part). */
function splitShell(cmd) {
  const seps = ['&&', '||', ';', '|', '\n'];
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { cur += ch + (cmd[i + 1] || ''); i += 1; continue; }
      if (ch === quote) quote = '';
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '\\') { cur += ch + (cmd[i + 1] || ''); i += 1; continue; }
    const sep = seps.find((s) => cmd.startsWith(s, i));
    if (sep) { out.push(cur); cur = ''; i += sep.length - 1; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
/** Split one command into words, dropping quoting that only served the shell. */
function shellWords(segment) {
  const words = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { cur += segment[i + 1] || ''; i += 1; continue; }
      if (ch === quote) { quote = ''; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') { cur += segment[i + 1] || ''; i += 1; continue; }
    if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}
const SHELL_VERB = {
  cat: '已查看', bat: '已查看', head: '已查看', tail: '已查看', less: '已查看', more: '已查看', nl: '已查看',
  grep: '已检索', rg: '已检索', ag: '已检索', ack: '已检索',
  ls: '已列出', tree: '已列出', find: '已列出', fd: '已列出', wc: '已统计',
  sed: '已改写文本', awk: '已处理文本', jq: '已解析 JSON', tr: '已处理文本',
  mkdir: '已建目录', touch: '已建文件', cp: '已复制', mv: '已移动', rm: '已删除', rmdir: '已删目录',
  chmod: '已改权限', ln: '已建链接', tar: '已打包', unzip: '已解压', zip: '已压缩',
  curl: '已请求', wget: '已下载', nc: '已连接',
  node: '已运行 Node', python: '已运行 Python', python3: '已运行 Python', deno: '已运行 Deno',
  pytest: '已跑测试', vitest: '已跑测试', jest: '已跑测试', tsc: '已类型检查', eslint: '已静态检查',
  npm: '已运行 npm', pnpm: '已运行 pnpm', yarn: '已运行 yarn', npx: '已运行 npx', bun: '已运行 bun', make: '已运行 make',
  git: '已执行 git', docker: '已执行 docker', kubectl: '已执行 kubectl', cargo: '已执行 cargo', go: '已执行 go',
  shasum: '已校验', sha256sum: '已校验', md5sum: '已校验', diff: '已比对', sort: '已排序', uniq: '已去重',
  which: '已查路径', pwd: '已读路径', date: '已读时间', echo: '已输出', printf: '已输出', tee: '已写入',
  sleep: '已等待', kill: '已终止进程', ps: '已查进程', env: '已查环境变量', export: '已设变量',
  df: '已查磁盘', du: '已查占用', stat: '已查文件信息', file: '已查文件类型', basename: '已取文件名', dirname: '已取目录名',
};
/** Commands whose first positional word is the action (the subcommand). */
const SUBCOMMAND_BINS = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'docker', 'kubectl', 'cargo', 'go', 'pip', 'pip3', 'make']);
/** `cd`/`set`-style glue that carries no user-visible action of its own. */
const SHELL_NOISE = /^(cd|pushd|popd|set|unset|source|true|:)\b/;
/** Bins where `-e`/`-c` means "run this inline snippet", not a mere flag. */
const INTERPRETER_BINS = new Set(['node', 'deno', 'python', 'python3', 'ruby', 'perl', 'php']);
const EVAL_FLAGS = new Set(['-e', '--eval', '-c', '-p', '--print']);
/** Shell wrappers: `bash -c "<real command>"` should describe the inner command. */
const WRAPPER_BINS = new Set(['sh', 'bash', 'zsh', 'fish']);
/** Verbs whose payload is the FILE, not the leading expression (sed/awk script). */
const FILE_LAST_BINS = new Set(['sed', 'awk']);
/** Describe one command as "verb + the one argument that identifies it". */
function describeShellCommand(segment, depth = 0) {
  const words = shellWords(segment);
  if (!words.length) return '已运行命令';
  const bin = words[0].split('/').pop();
  const verb = SHELL_VERB[bin] || `已执行 ${clip(bin, 20)}`;
  const rest = words.slice(1);
  const positional = rest.filter((w) => !w.startsWith('-'));
  const flags = rest.filter((w) => w.startsWith('-'));
  if (INTERPRETER_BINS.has(bin) && rest.some((w) => EVAL_FLAGS.has(w))) return `${verb}（内联脚本）`;
  if (WRAPPER_BINS.has(bin)) {
    const at = rest.findIndex((w, i) => EVAL_FLAGS.has(w) && !String(rest[i - 1] || '').startsWith('-'));
    if (at >= 0 && rest[at + 1] && depth < 2) return describeShellCommand(rest[at + 1], depth + 1);
    return positional.length ? `${verb} ${clip(positional[0])}` : verb;
  }
  if (SUBCOMMAND_BINS.has(bin)) {
    const sub = positional[0];
    if (!sub) return flags.length ? `${verb} ${flags[0]}` : verb;
    const script = ['run', 'exec', 'dlx'].includes(sub) && positional[1] ? ` ${clip(positional[1], 28)}` : '';
    const file = !script && bin === 'git' && positional[1] ? ` ${clip(positional[1], 24)}` : '';
    return `${verb} ${sub}${script}${file}`;
  }
  if (bin === 'echo' || bin === 'printf') return positional.length ? `${verb} ${clip(positional.join(' '), 40)}` : verb;
  // `sed -n "1,60p" file` acts on the file; its leading expression is not the subject.
  const subject = FILE_LAST_BINS.has(bin) ? positional[positional.length - 1] : positional[0];
  // A bare `ls -la` means "list the current directory" — name that, do not echo the flags.
  if (!subject) return bin === 'ls' ? '已列出目录' : verb;
  return `${verb} ${clip(subject)}`;
}
/** Final tidy: one line, no sticky separators, bounded length. */
function cleanSummary(s) {
  return clip(String(s).replace(/\s+/g, ' ').replace(/[;|]+$/, '').trim(), 64);
}
/** Summarise a whole shell line: primary action + how many more parts ran. */
function shellSummary(rawCommand) {
  const cmd = decodeEntities(String(rawCommand == null ? '' : rawCommand)).replace(/\s+/g, ' ').trim();
  if (!cmd) return '已运行命令';
  const segs = splitShell(cmd);
  const meaningful = segs.filter((s) => !SHELL_NOISE.test(s));
  const extra = Math.max(0, segs.length - 1);
  // A line of pure glue (`set -e; cd x; true`) has no action to name — say so
  // honestly instead of describing whatever glue happened to come first.
  if (!meaningful.length) return cleanSummary(extra ? `已运行命令（+${extra} 条）` : '已运行命令');
  const body = describeShellCommand(meaningful[0]);
  return cleanSummary(extra ? `${body}（+${extra} 条）` : body);
}
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'run', 'terminal', 'run_command']);
/** Tools whose most informative argument is not the first key {@link toolArg} finds. */
const PREFERRED_ARG = {
  subagent: ['label', 'title', 'description', 'name'],
  subagent_fork: ['label', 'title', 'description'],
  workflow: ['name', 'description'],
  job_output: ['job_id'], job_kill: ['job_id'], job_list: [],
  send_message: ['agent_id'],
  bash: ['command'], shell: ['command'],
  skill: ['name'], todo_write: [],
};
function preferredArg(exec, keys) {
  const a = exec?.arguments;
  if (!a || typeof a !== 'object' || !keys.length) return '';
  for (const k of keys) if (a[k] != null) return String(Array.isArray(a[k]) ? a[k][0] : a[k]);
  return '';
}
/** Resolve a tool's Chinese label: exact name → family prefix → Chinese generic. */
function toolLabel(name) {
  if (TOOL_LABEL[name]) return TOOL_LABEL[name];
  const family = TOOL_LABEL_FAMILIES.find(([re]) => re.test(name));
  return family ? family[1] : TOOL_LABEL_FALLBACK;
}
function summarizeTool(exec) {
  const name = exec?.name || '';
  const label = toolLabel(name);
  if (SHELL_TOOLS.has(name)) {
    const cmd = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments.command : '';
    return shellSummary(cmd || toolArg(exec));
  }
  const preferred = PREFERRED_ARG[name] ? preferredArg(exec, PREFERRED_ARG[name]) : '';
  const arg = clip(decodeEntities(preferred || toolArg(exec)).replace(/\s+/g, ' ').trim());
  return arg ? `${label} ${arg}` : label;
}


// ── cost/model auto-select (P2) ─────────────────────────────────────────────
// Two-tier model plan. DeepSeek-V4.1-Flash (official model id `deepseek-flash`,
// released 2026-09-10) is natively multimodal and outperforms V4-Pro on
// quality, cost, speed and total time — V4-Pro is being retired (from
// 2026-09-14 Beijing time all `deepseek-v4-pro` requests are routed to V4.1
// Flash). Both tiers therefore point at `deepseek-flash` today; the tier split
// is kept so a future V4.1-Pro can be assigned to `heavy` in one line without
// touching the roster. Legacy ids: `deepseek-v4-flash`,
// `deepseek-v4-flash-vision-exp` are retired and temporarily routed to V4.1
// Flash for compatibility.
// Tool `agentOptions` in the preset set the model WITHOUT a provider, so
// children inherit the session's provider route — and dsh-model-failover still
// degrades them live when the primary route is down.
const MODEL_TIERS = { heavy: ['pm', 'architect', 'reviewer', 'dba', 'sec'], light: ['researcher', 'backend', 'frontend', 'qa', 'ui', 'devops', 'docs'] };
const MODEL_DEFAULT = { heavy: 'deepseek-flash', light: 'deepseek-flash' };
function tierOf(role) {
  if (MODEL_TIERS.heavy.includes(role)) return 'heavy';
  if (MODEL_TIERS.light.includes(role)) return 'light';
  return null;
}
function modelPlanFor(roles) {
  const plan = {};
  for (const r of roles) {
    const t = tierOf(r);
    plan[r] = t ? { tier: t, model: MODEL_DEFAULT[t] } : null;
  }
  return plan;
}

/**
 * 批 0-5（承诺-能力一致性）：读 preset 里**实际配置**的逐角色 reasoningEffort。
 * 目的不是展示，而是让 /team models 能如实回答「计划的能力面」与「实际生效的能力面」差在哪 ——
 * 而不是再写一句永远为真的宣传语。读不到就返回空表（调用方据此降级表述）。
 */
async function presetEffortMap() {
  try {
    const yml = await readFile(new URL('agent.cordis.yml', PRESET_SRC), 'utf8');
    const out = {};
    const re = /-\s*id:\s*tool-subagent-([a-z][a-z-]*)\b([\s\S]*?)(?=\n\s*-\s*id:\s*tool-subagent-|$)/g;
    let m;
    while ((m = re.exec(yml)) !== null) {
      const eff = m[2].match(/reasoningEffort:\s*([A-Za-z]+)/);
      if (eff) out[m[1]] = eff[1].toLowerCase();
    }
    return out;
  } catch {
    return {};
  }
}
// Compact status suffix: `模型 flash×12` (skipped when none set).
function summarizeModels(plan) {
  const by = {};
  for (const v of Object.values(plan || {})) {
    if (v && v.model) by[v.model] = (by[v.model] || 0) + 1;
  }
  const parts = Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m.replace(/^deepseek-/, '')}×${n}`);
  return parts.length ? ` · 模型 ${parts.join(' / ')}` : ' · 模型（继承会话模型）';
}

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// Single source of truth: the skill + its assets ship inside the bundle and are
// copied verbatim into the user skill root on demand.
const SKILL_SRC = new URL('../skills/expert-team/', import.meta.url);
/**
 * 包内 skill 目录的**规范化绝对路径**（去掉 URL→路径留下的尾部分隔符）。
 * 尾斜杠看着无害，但它会被原样塞进 `resourceBase.path` 传给宿主，也可能让按字符串比较路径的
 * 消费方（以及我们自己的测试）判不等 —— 归一化一次，比在每个使用点各修一遍可靠。
 */
const SKILL_DIR = fileURLToPath(SKILL_SRC).replace(/[\\/]+$/, '');
const TEMPLATES_SRC = new URL('../skills/expert-team/assets/templates/', import.meta.url);
// The `expert-team` agent preset (role subagent tool instances) ships alongside
// the skill and is copied into the user preset root so the roster can discover it.
const PRESET_SRC = new URL('../presets/expert-team/', import.meta.url);

function slugify(s, max = 16) {
  let out = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (out.length > max) {
    out = out.slice(0, max);
    // Cut at the last '-' so we never split a word mid-way (e.g. "只看前后端代码" → "只看前后端", not "只看前后端代").
    const cut = out.lastIndexOf('-');
    if (cut > max * 0.5) out = out.slice(0, cut);
  }
  return out || 'run';
}

// Short, readable, unique run id: <short-title>-<HHMMSS>. Never the full task
// text (a long slug is unreadable and `/team resume` needs a short handle).
function runIdFrom(task, runName) {
  if (runName) return slugify(runName, 24);
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, ''); // HHMMSS
  return `${slugify(task, 16)}-${stamp}`;
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

// ── 设置控制台（F 线）：读写 `$DSH_HOME/expert-team/settings.json` ─────────────────────
// 为什么放在 `$DSH_HOME/expert-team/` 而不是工作区：设置是**这台机器上这个插件的偏好**，
// 不属于任何一个项目（`session-runs.json` 已经在用同一个目录，不另造一处）。
// 写入必须走受控入口 `ARTIFACT.must`（本包有 `gate:bypass` 棘轮盯着"绕过受控写入口的直写"）。
function settingsPath() {
  return join(dshHome(), 'expert-team', 'settings.json');
}

/** 进程内缓存：`apply()` 在插件加载时读一次；`POST /settings` 成功后即时刷新。 */
let SETTINGS_CACHE = null;

/**
 * 读设置（**同步**，供 `apply()` 在插件加载时用）。
 * 文件不存在 / 不是合法 JSON / 值越界，一律**降级为默认并如实返回 repairs** —— 一份坏设置
 * 绝不能让插件挂不上（"加好工作区没反应"这种失败模式本仓已经吃过一次）。
 */
function loadSettingsSync() {
  let raw = null;
  try {
    const text = readFileSync(settingsPath(), 'utf8');
    raw = JSON.parse(text);
  } catch { raw = null; }
  const { settings, repaired } = normalizeSettings(raw);
  SETTINGS_CACHE = { settings, repaired, at: new Date().toISOString() };
  return SETTINGS_CACHE;
}

/**
 * 取当前设置（读失败也返回默认，不抛）。
 *
 * **"设置"这一档的唯一读取口**：宿主命名空间可用时，以它的解析值为准
 * （构成为 `schema 默认 < 我们传入的 base < 官方面板用户层`），再用文件补上宿主表达不了的字段
 * （如 `roster.defaultRoles` —— 见 host-settings.js 里为什么它不上官方面板）。
 * 宿主不可用时，与 1.1.x 完全一致：直接读 `settings.json`。
 */
function currentSettings() {
  const file = (SETTINGS_CACHE || loadSettingsSync()).settings;
  const host = hostValues();
  if (!host) return file;
  const merged = mergeSettings(file, host);
  if (merged.ok) return merged.value;
  // 宿主给了我们认不出的键（schema 漂移）⇒ 如实出声一次，然后按文件值走，绝不静默改语义
  if (!HOST_SETTINGS_WARNED) {
    HOST_SETTINGS_WARNED = true;
    console.warn('[expert-team] 宿主设置里有本插件认不出的键，已退回 settings.json：' + merged.errors.slice(0, 3).join('；'));
  }
  return file;
}
let HOST_SETTINGS_WARNED = false;

/** 设置 → 容量上限的**基础值**（优先级最低的一档：config > env > 设置 > 内置默认）。 */
function limitsBaseFromSettings(s = currentSettings()) {
  return { maxMembers: s.roster.maxMembers, maxTasks: s.roster.maxTasks };
}

/** 设置 → 轮次上限的基础值。 */
function roundLimitsBaseFromSettings(s = currentSettings()) {
  return { maxReviewRounds: s.gates.maxReviewRounds, maxTestRounds: s.gates.maxTestRounds };
}

/** 插件加载时传给 `apply(ctx, config)` 的 config（重算时要沿用，不能丢覆写）。 */
let PLUGIN_CONFIG = {};

/**
 * 用**当前设置**重算四处派生值：容量上限、轮次上限、档位门、振荡检测开关。
 *
 * 为什么需要它：这几处在 1.1.x 里只在 `apply()` 时算一次，于是"设置改了要重启才生效"。
 * 现在官方面板/浮层改设置都会走到这里 ⇒ 不重启即生效。用 `PLUGIN_CONFIG` 而不是空对象，
 * 是为了让 `config` 覆写（优先级最高的一档）在重算后依然压得住设置值。
 */
function reapplySettingsDerived() {
  try {
    const s = currentSettings();
    resolveLimits(PLUGIN_CONFIG, limitsBaseFromSettings(s));
    resolveRoundLimits(PLUGIN_CONFIG, roundLimitsBaseFromSettings(s));
    resolveTierGate(PLUGIN_CONFIG, s.gates);
    resolveLeadToolFace(PLUGIN_CONFIG, s.gates);
    resolveLoopGuard(PLUGIN_CONFIG, s.gates);
    syncSubagentOrder();
    return true;
  } catch (e) {
    console.warn('[expert-team] 重算设置派生值失败（保持上一次生效值）：' + String(e && e.message ? e.message : e));
    return false;
  }
}

/**
 * 子代理列表顺序的装载上下文（`ctx.inject(['subagents'])` 拿到的那个作用域）。
 * 为什么记在模块级：`reapplySettingsDerived()` 是**无参**的（设置 watch 与 config 覆写都会调它），
 * 而装载/卸载需要 ctx 才能解析服务 —— 与 `PLUGIN_CONFIG` 同一套做法。
 */
let SUBAGENT_ORDER_CTX = null;

/**
 * 按当前生效设置同步"子代理列表最新在上"的装载状态。
 *
 * 单一真源是 `SETTINGS_SPEC.display.subagentListNewestFirst`；这里**不抄第二份默认值**，
 * 只在读不到时按 `false !== 值` 判定（缺省即开）。任何失败都只写进状态、不抛 ——
 * 一个展示顺序的开关**绝不允许**连累插件加载。
 *
 * @param {any} [ctx] 装载上下文；缺省用最近一次 `inject` 拿到的
 * @returns {{enabled: boolean, installed: boolean, effective: boolean, reason: string, checkedAt: number}}
 */
function syncSubagentOrder(ctx) {
  const scope = ctx ?? SUBAGENT_ORDER_CTX;
  if (!scope) return subagentOrderStatus();
  try {
    const s = currentSettings() || {};
    const enabled = ((s.display || {}).subagentListNewestFirst) !== false;
    return applySubagentOrder(scope, enabled);
  } catch (e) {
    console.warn('[expert-team] 子代理列表顺序装载失败（退回宿主默认顺序）：' + String(e && e.message ? e.message : e));
    return subagentOrderStatus();
  }
}

function teamRoot(cwd) {
  return join(cwd, 'team');
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Append one timestamped line to the run's operational log (RUN.log.md).
// The orchestrator maintains the rest of this file per references/LOGGING.md.
async function appendLog(runDir, line) {
  const p = join(runDir, 'RUN.log.md');
  const entry = `- [${ts()}] ${line}\n`;
  try {
    await mkdir(runDir, { recursive: true });
    let existing = '';
    try { existing = await readFile(p, 'utf8'); } catch { existing = '# 运行日志（RUN.log）\n\n'; }
    await ARTIFACT.must(p, existing + entry);
  } catch { /* best-effort logging */ }
}


// ── durable user message (inline; no @deepseek-ai/* import needed) ─────────

function userMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    id: randomUUID(),
  };
}

// Read the accumulated cross-run learnings (LEARNINGS.md) and return a compact
// excerpt to inject into a NEW run's launch message. This is the "read prior
// experience BEFORE the run" half of the self-optimization loop; making it part
// of the launch message makes it reliable instead of relying on the model
// remembering to open the file on its own.
// Merges TWO tiers: the GLOBAL team/process-level lessons (~/.dsh/expert-team/
// LEARNINGS.md, cross-project) and the project-level ones (<cwd>/team/LEARNINGS).
// COMPACT: each bullet is truncated to its first ~140 chars and only a few are
// kept — the full text stays in the files for the lead to read when relevant.
function compactBullet(b, max = 140) {
  const t = b.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trim().replace(/([。；，、,;])[^。；]*$/, '$1') + '…';
}
async function readLearningsSummary(cwd, maxItems = 3) {
  const paths = [
    join(dshHome(), 'expert-team', 'LEARNINGS.md'), // global (cross-project)
    join(teamRoot(cwd), 'LEARNINGS.md'),            // project-level
  ];
  let bullets = [];
  for (const lp of paths) {
    let txt = '';
    try { txt = await readFile(lp, 'utf8'); } catch { continue; }
    const found = txt
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('#'))
      .filter((l) => /^[-*]\s+/.test(l));
    bullets = bullets.concat(found);
  }
  bullets = bullets.slice(-maxItems).map((b) => '- ' + compactBullet(b));
  if (!bullets.length) return '';
  return ['', '【既往经验（仅要点；完整版见 team/LEARNINGS.md，相关时才读）】', ...bullets, ''].join('\n');
}

/**
 * 常驻规则（用户立的"规矩"，如"改完没问题就提交并推送"）。
 *
 * 为什么需要独立的文件（而不是复用 LEARNINGS.md）：
 *   · LEARNINGS.md 是**团队自动蒸馏**的经验（lead 自己写的、关于怎么协作）；
 *   · 常驻规则是**用户直接下的指令**（关于"必须做什么"），权威性不同，且
 *     **每条消息都要带**（压缩对话后规则不能跟着消失）。
 * 落点：`<cwd>/team/STANDING-RULES.md`（工作区级、跨 run、跨会话、在磁盘上）。
 * 读取是**紧凑摘要**：只取非注释的非空行，每条截断，避免把长文件灌进每条消息。
 */
async function readStandingRules(cwd, maxItems = 12) {
  const p = join(teamRoot(cwd), 'STANDING-RULES.md');
  let txt = '';
  try { txt = await readFile(p, 'utf8'); } catch { return ''; }
  const lines = txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('>'));
  if (!lines.length) return '';
  const items = lines.slice(-maxItems).map((l) => '- ' + (l.length > 90 ? l.slice(0, 90).trim() + '…' : l));
  return ['', '【常驻规则（用户立的规矩，**每次都要遵守**；完整版见 team/STANDING-RULES.md）】', ...items, ''].join('\n');
}

/** 追加一条常驻规则（去重；幂等 —— 同一规则只写一次）。 */
async function appendStandingRule(cwd, rule) {
  const p = join(teamRoot(cwd), 'STANDING-RULES.md');
  const line = String(rule || '').trim();
  if (!line) return { ok: false, reason: '空规则' };
  let existing = '';
  try { existing = await readFile(p, 'utf8'); } catch { existing = '# 常驻规则（STANDING RULES）\n\n> 用户立的"规矩"。lead 在每次开工/恢复/压缩后续跑前都要先读本文件。\n\n'; }
  if (existing.includes(line)) return { ok: true, added: false, reason: '已存在' };
  await ARTIFACT.must(p, existing.endsWith('\n\n') || existing.endsWith('\n') ? existing + line + '\n' : existing + '\n' + line + '\n');
  return { ok: true, added: true };
}

async function launchMessage(task, cwd, runDir, mode) {
  const learnings = await readLearningsSummary(cwd);
  const rules = await readStandingRules(cwd);
  const profilesNote = mode.profile ? `Profile「${mode.profile}」：${mode.profileNote || ''}` : '';
  const repowikiPath = join(teamRoot(cwd), 'REPOWIKI.md');
  let repowikiNote = '';
  try {
    await readFile(repowikiPath, 'utf8');
    repowikiNote = '项目知识库：已就绪（clarify 前先读；/team index 维护）。';
  } catch {
    repowikiNote = '项目知识库：缺失——clarify 前先 `/team index` 生成再读。';
  }
  // F 线第 4 项：身份策略（POLICY.md 里的口径块）—— **每个 run 一份、随 run 冻结**。
  // 放在启动消息最前面：lead 第一眼就要知道自己该用什么口径问、谁能拍板。
  let policyNote = '';
  try {
    policyNote = policyBlockFrom(await readFile(join(runDir, 'POLICY.md'), 'utf8'));
  } catch { policyNote = ''; } // 旧 run 没有 POLICY.md ⇒ 不注入，行为与从前一致
  const lines = [
    policyNote,
    '【专家团任务】目标：' + task,
    '运行目录：' + runDir,
    '模式：' + (mode.persist ? '持久化活团队（成员可反复指挥、跨会话恢复）' : '一次性自动组队'),
    ...(mode.persist ? ['常驻模式：此后每条新消息都是团队输入（需求→先派 researcher；修改→对应实现者；评审/测试→reviewer/qa；简单提问→直接回）。'] : []),
    '交付：' + (mode.deliverable ? (mode.deliverable === 'artifacts-only' ? '仅工件（计划/评审/测试，不改代码）' : '代码 + 工件') : (mode.noCode ? '仅工件（计划/评审/测试，不改代码）' : '代码 + 工件')),
    '固定角色：' + (mode.roles && mode.roles.length ? mode.roles.join(', ') : DEFAULT_ROLES.join(', ')) + '（缺位角色按需动态补位）',
    profilesNote,
    repowikiNote,
    '【首步】本条消息内：派 researcher（读 REPOWIKI + 现状调研），需产品澄清再并行派 pm（Ultra Spec）；禁止挂零。',
    '要求：先加载 expert-team skill，严格按协议执行（全部流程规则在 skill 里，本消息不再重复）。',
    rules || '',
    learnings || '',
  ].filter((l) => l !== '');
  return userMessage(lines.join('\n'));
}

// ── skill install (idempotent) ─────────────────────────────────────────────

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isDirectory()) await copyDir(from, to);
    else await ARTIFACT.must(to, await readFile(from));
  }
}

// ── 自举安装的收口（2026-09-14）─────────────────────────────────────────────
//
// 背景：skill 与「专家团模式」preset 一直靠"首次 /team 时复制到 $DSH_HOME"就位。两个真问题：
//   ① **静默过期**：旧实现是"目标存在就直接 return"，于是插件升级后运行时永远停在旧副本
//      （改了 skill 却在真实会话里不生效，且没有任何报错 —— 本仓最隐蔽的一类假完成）；
//   ② **卸载残留**：插件市场卸载只删 node_modules，$DSH_HOME 下那份副本会留下：
//      一个孤儿 skill，以及一个"选中就报错"的 preset。
// 现在：skill 改为**运行时注册**（一个文件都不写，见 registerRuntimeSkill）；preset 因为宿主
// 没有"运行时加扫描根"的 API（`dsh-agent-presets` 的 roots 只来自配置），仍走复制，但加
// **版本戳**（升级即整目录重铺）并**登记到清单**，由 `/team uninstall` 精确回收 ——
// 且只回收带我们戳（或身份可判定为本插件产物）的目录，绝不删用户自己写的同名内容。

/** 本插件版本，用作副本的版本戳（从包内 package.json 读，避免 ESM import JSON 的兼容问题）。 */
const PLUGIN_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0');
  } catch { return '0.0.0'; }
})();
/** 版本戳文件名：目录里出现它，就说明这个目录是**本插件铺的**。 */
const INSTALL_STAMP = '.expert-team-version';
/** 已铺副本的登记表（供 `/team uninstall` 精确回收）。 */
function installedManifestPath() { return join(dshHome(), 'expert-team', 'installed.json'); }

/** 解析 SKILL.md 的 YAML frontmatter（只支持本文件实际使用的单行标量）。 */
function parseSkillMarkdown(text) {
  const src = String(text ?? '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    if (v) meta[kv[1]] = v;
  }
  return { meta, body: src.slice(m[0].length) };
}

/** 组装"运行时 skill"注册对象；读不到就返回 null（调用方回退到复制）。 */
function buildSkillRegistration() {
  const { meta, body } = parseSkillMarkdown(readFileSync(new URL('SKILL.md', SKILL_SRC), 'utf8'));
  if (!meta.name || !body.trim()) return null;
  const reg = {
    name: meta.name,
    description: meta.description || '',
    content: body,
    source: 'runtime',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    metadata: { plugin: '@yangdcm/dsh-expert-team', version: PLUGIN_VERSION },
  };
  if (meta.whenToUse) reg.whenToUse = meta.whenToUse;
  return reg;
}

/** 运行时 skill 是否注册成功（成功 ⇒ 不再往 $DSH_HOME 写任何 skill 文件）。 */
let RUNTIME_SKILL_REGISTERED = false;

/**
 * 把 skill 作为**运行时条目**注册进宿主的 skill 注册表。
 * 宿主优先级为 项目条目 > 运行时条目 > 用户根 ⇒ 运行时注册还能压过 `$DSH_HOME/skills` 里的历史副本。
 */
function registerRuntimeSkill(ctx) {
  try {
    const skills = ctx && typeof ctx.get === 'function' ? ctx.get('skills') : null;
    if (!skills || typeof skills.register !== 'function') return false;
    const reg = buildSkillRegistration();
    if (!reg) return false;
    const dispose = skills.register(reg);
    RUNTIME_SKILL_REGISTERED = true;
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
    console.log('[expert-team] skill 已作为运行时条目注册（不再写入 $DSH_HOME/skills）');
    return true;
  } catch (e) {
    console.warn('[expert-team] 运行时注册 skill 失败，回退到自举复制：' + String(e && e.message ? e.message : e));
    return false;
  }
}

async function pathExists(p) { try { await stat(p); return true; } catch { return false; } }
async function readTextSafe(p) { try { return await readFile(p, 'utf8'); } catch { return null; } }

/** 记下"这个目录是本插件铺的"（卸载据此精确回收）。 */
async function recordInstalled(kind, dir) {
  const p = installedManifestPath();
  try {
    let cur = {};
    try { cur = JSON.parse(await readFile(p, 'utf8')) || {}; } catch { cur = {}; }
    cur[kind] = { path: dir, version: PLUGIN_VERSION, at: new Date().toISOString() };
    await mkdir(dirname(p), { recursive: true });
    await ARTIFACT.must(p, JSON.stringify(cur, null, 2) + '\n');
  } catch (e) {
    // 登记失败不该让安装本身失败，但**绝不能静默** —— 清单缺失会让 `/team uninstall` 回收不到
    // 这次铺的副本（那正是"卸载残留"这个坑本身）。如实告警并给出路径。
    console.warn(`[expert-team] 未能登记已铺副本（${kind}: ${dir}）→ /team uninstall 可能回收不到它：${String(e && e.message ? e.message : e)}`);
  }
}
async function readInstalled() {
  try { return JSON.parse(await readFile(installedManifestPath(), 'utf8')) || {}; } catch { return {}; }
}

/**
 * 这个目录是否可以安全地当成"本插件的副本"来覆盖/删除。
 * 判据两条，任一成立即可：① 带我们的版本戳；② 身份可判定为本插件产物
 * （1.2.0 之前铺的副本没有戳 —— 不认它们，升级时就永远刷不掉旧 skill）。
 */
async function isOwnedCopy(dir, kind) {
  if ((await readTextSafe(join(dir, INSTALL_STAMP))) !== null) return true;
  if (kind === 'skill') {
    const md = await readTextSafe(join(dir, 'SKILL.md'));
    if (md === null) return false;
    return parseSkillMarkdown(md).meta.name === 'expert-team';
  }
  const yml = await readTextSafe(join(dir, 'agent.cordis.yml'));
  return yml !== null && /tool-subagent-pm/.test(yml);
}

/**
 * `/team uninstall`：回收本插件铺到 `$DSH_HOME` 的副本（skill / preset）。
 * 安全规则：**只回收"本插件的副本"** —— 用户自己写的同名 preset/skill 不带我们的戳、
 * 身份也对不上，绝不会被删。工作区里的 `team/` 运行目录与插件包本身都不动。
 */
async function uninstallInstalled() {
  const rec = await readInstalled();
  const removed = [];
  const skipped = [];
  const seen = new Set();
  /**
   * 回收一个候选目录（幂等；只删"本插件的副本"）。
   * 为什么要 `seen`：清单里的路径与下面两个**历史默认路径**可能重合，重复 rm 会把
   * "已回收"报两遍，也会让第二次那条 `pathExists` 失败被误记成"保留"。
   */
  const reclaim = async (kind, dir) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    if (!(await pathExists(dir))) return;
    if (await isOwnedCopy(dir, kind)) {
      try { await rm(dir, { recursive: true, force: true }); removed.push(`${kind}：${dir}`); }
      catch (e) { skipped.push(`${kind}：${dir}（删除失败：${String(e && e.message ? e.message : e)}）`); }
    } else {
      skipped.push(`${kind}：${dir}（不是本插件的副本 ⇒ 保留）`);
    }
  };

  for (const [kind, info] of Object.entries(rec)) await reclaim(kind, info && info.path);

  // 1.2.0 之前的副本**没有登记过**（那时还没有清单）—— 而它们恰恰是这个命令最该处理的历史遗留。
  // 所以除了清单，还要看两个众所周知的自举落点；判据仍是 `isOwnedCopy`（无戳时按身份判定），
  // 用户自己写的同名 skill/preset 依旧不会被删。
  await reclaim('skill', join(dshHome(), 'skills', 'expert-team'));
  await reclaim('preset', join(dshHome(), '.agent-presets', 'expert-team'));

  try { await rm(installedManifestPath(), { force: true }); } catch { /* 清单删不掉就留着 */ }
  const lines = ['# /team uninstall', ''];
  lines.push(removed.length ? '已回收：' : '没有需要回收的副本。');
  for (const r of removed) lines.push('- ' + r);
  if (skipped.length) { lines.push('', '保留（未删除）：'); for (const s of skipped) lines.push('- ' + s); }
  lines.push(
    '',
    '说明：skill 现在默认走**运行时注册**，本来就不写盘；这里回收的是历史版本留下的副本，',
    '或宿主没有 skill 注册表时的回退副本。',
    '本命令不碰工作区里的 `team/` 运行目录，也不碰插件包本身（那由插件市场卸载）。',
    // 契约要写清：`$DSH_HOME/expert-team/` 下既有"安装副本"（installed.json，会被删），
    // 也有**用户数据**（跨项目经验与会话→run 记忆）。后者不是安装产物，卸载命令无权处置。
    '状态文件（`$DSH_HOME/expert-team/` 下的 `LEARNINGS.md`、`session-runs.json`、`workspaces.json`）**保留**',
    '—— 它们是跨项目经验与会话→run 记忆，属于你的数据，不是安装副本。',
    // 2026-09-15 事故后补的契约：本命令只清"当前那份副本"，插件只要还装着，下次加载就会重新铺。
    '注意：只要插件**仍安装着**，下次加载会重新铺一份「专家团模式」preset（带版本戳）——',
    '本命令清的是当前副本，真正的卸载是在插件市场里移除插件本身。',
  );
  return { kind: 'success', text: lines.join('\n') };
}

/**
 * 后台铺一份运行时资产（preset / skill 回退副本），**失败绝不影响插件加载**。
 *
 * 为什么用 fire-and-forget：`apply()` 是同步契约，绝不能为了铺盘把插件挂载拖住或拖挂。
 * 为什么只警告一次：铺失败通常意味着 `$DSH_HOME` 不可写（只读盘/权限），每次加载都刷同样的 warn
 * 会把"响亮"变成噪声，而噪声的代价是所有告警一起被降权。
 */
const INSTALL_FAILURE_WARNED = new Set();
// ── 推荐插件自检（2026-09-15 · 用户要求）───────────────────────────────────────
// 事实（只读调查结论，别再重证）：本插件**零硬依赖** —— package.json 连 `dependencies`
// 字段都没有，全库没有一条外部 import；下面这些插件**缺了都不会报错**，只是会让某些体验打折。
// 所以这里只做一件事：**装了就一声不吭，缺了说一句怎么办**（不吓人、不重复、不影响加载）。
//
// 三条探测路径（都有宿主源码依据）：
//   ① loader 条目（`ctx.get('loader').entries()` → `options.name`）= **装没装**（最通用）；
//   ② 服务探测（`ctx.get('costMeter')`）= 费用插件是否可用（服务名是**驼峰** costMeter）；
//   ③ 工具探测（`ctx.get('tools').get('hindsight_ingest_document')`）= **此刻能不能用**：
//      Hindsight 在"装了但未配置/被 opt-out"时**根本不注册工具**（其 registerTools 开头
//      模板不可用即 return）⇒ 这一条天然把「没装」与「装了没配」分开 —— 两种零可区分。
// 全部 best-effort：任何异常都当"不知道"，**绝不**因此影响插件加载。
const OPTIONAL_PLUGINS = [
  {
    id: 'hindsight',
    pkg: '@vectorize-io/hindsight-coding-agents',
    match: (name) => name === '@vectorize-io/hindsight-coding-agents' || name.indexOf('@vectorize-io/hindsight-coding-agents/') === 0,
    what: '跨项目/跨会话长期记忆（clarify 前召回、deliver 时落库）',
    install: 'dsh plugin --profile web add @vectorize-io/hindsight-coding-agents',
  },
  {
    id: 'cost-meter',
    pkg: 'dsh-cost-meter',
    match: (name) => name === 'dsh-cost-meter' || name.indexOf('dsh-cost-meter/') === 0,
    what: '会话费用 / token 账（浮层「在用模型」那一行指向它）',
    install: 'dsh plugin --profile web add dsh-cost-meter',
  },
];
/** 装了哪些插件（loader 条目名）。返回 null = 探测不可用（**不是**"没装"）。 */
function loaderEntryNames(ctx) {
  try {
    const loader = ctx && typeof ctx.get === 'function' ? ctx.get('loader') : null;
    if (!loader || typeof loader.entries !== 'function') return null;
    const out = [];
    for (const entry of loader.entries() || []) {
      const n = entry && entry.options && entry.options.name;
      if (n) out.push(String(n));
    }
    return out;
  } catch { return null; }
}
/** 工具面探测：Hindsight 的工具在"未配置/被关"时压根不注册 ⇒ 天然区分没装与装了没配。 */
function hindsightToolReady(ctx) {
  try {
    const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null;
    if (!tools || typeof tools.get !== 'function') return null;
    return !!tools.get('hindsight_ingest_document');
  } catch { return null; }
}
function costMeterReady(ctx) {
  try { return !!(ctx && typeof ctx.get === 'function' && ctx.get('costMeter')); } catch { return null; }
}
/**
 * 自检推荐插件。**纯读、无副作用**。
 * @returns {{items:Array, needsAttention:Array, hint:string}}
 *   status: 'ready'（装了且可用）/ 'installed-not-ready'（装了但当下不可用）/ 'missing'（没装）
 *           / 'unknown'（探测不可用 ⇒ 不下结论）
 */
function detectOptionalPlugins(ctx) {
  const names = loaderEntryNames(ctx);
  const items = OPTIONAL_PLUGINS.map((spec) => {
    const installed = names ? names.some(spec.match) : null; // null = 探测不可用
    const usable = spec.id === 'hindsight' ? hindsightToolReady(ctx) : (spec.id === 'cost-meter' ? costMeterReady(ctx) : null);
    let status;
    // 只有**确定**的结论才给确定的状态：
    //   · 工具/服务可用 ⇒ ready（最强的肯定证据）；
    //   · loader 明确列出"没有" ⇒ missing（确定没装）；
    //   · loader 列出有、但工具/服务不可用 ⇒ installed-not-ready（装了没配 —— 第二种零）；
    //   · 其余（loader 探测不可用 **且** 服务也拿不到）⇒ **unknown**：这时"没装"与"装了没配"
    //     分不开，就**不假装知道**。unknown 不进提示、不阻断任何功能。
    if (usable === true) status = 'ready';
    else if (installed === false) status = 'missing';
    else if (installed === true && usable === false) status = 'installed-not-ready';
    else status = 'unknown';
    return { id: spec.id, pkg: spec.pkg, what: spec.what, install: spec.install, installed, usable, status };
  });
  const needsAttention = items.filter((i) => i.status === 'missing' || i.status === 'installed-not-ready');
  let hint = '';
  if (needsAttention.length) {
    // 分档文案（2026-09-15 真实踩到）：对 `installed-not-ready` **不能**再给安装命令 ——
    // 那等于叫用户装一个已经装好的东西（用户机器上 dsh-cost-meter 明明紧接着自己加载成功了，
    // 我们却提示他去 `dsh plugin add dsh-cost-meter` ⇒ 假警报 + 误导）。
    //   · missing（确认没装）⇒ 给安装命令；
    //   · installed-not-ready（装了但此刻拿不到）⇒ 只说事实与可能原因，**不给命令**；
    //   · unknown ⇒ 不进 needsAttention，不出现。
    const parts = needsAttention.map((i) => {
      const head = `${i.pkg}（${i.what}）`;
      return i.status === 'missing'
        ? `${head}：未安装 ⇒ ${i.install}`
        : `${head}：已安装但当前未就绪（可能未配置或被关闭；若刚装上，稍后或重启后再看）`;
    });
    hint = `[expert-team] 推荐插件未就绪（不影响使用，只是少了对应体验）：${parts.join('；')}`;
  }
  return { items, needsAttention, hint };
}
let OPTIONAL_HINT_DONE = false;
/**
 * 提示一次（**装了/都齐则完全不吭声**；进程内最多一行）。
 * 语义保持：只在"真的有需要关注的东西"时打印，且只打印一次。
 */
function hintOptionalPluginsOnce(ctx) {
  if (OPTIONAL_HINT_DONE) return '';
  try {
    const r = detectOptionalPlugins(ctx);
    if (!r.hint) return '';
    OPTIONAL_HINT_DONE = true;
    console.log(r.hint);
    return r.hint;
  } catch { return ''; }
}
/** 懒重探（`/team help` 等"真正用到"的时刻调用）：结果更新，但同一次进程里仍最多打印一行。 */
function recheckOptionalPlugins(ctx) {
  try { return detectOptionalPlugins(ctx); } catch { return { items: [], needsAttention: [], hint: '' }; }
}
// ── 探测时机（2026-09-15 第二轮修复）─────────────────────────────────────────────
// **问题（用户贴的启动日志直接坐实）**：我们的 `apply()` 跑在其它插件之前，
// 那一刻 `ctx.get('costMeter')` / 工具表里当然还没有它们 ⇒ 已装且可用的插件被误判成
// `installed-not-ready`，日志里紧跟着 `dsh-cost-meter` 自己就加载成功了 ⇒ **假警报**。
//
// **宿主没有 app 级 ready 事件**（已核源码）：`dsh-app-boot` 的 `boot()` 顺序是
// `await mountRootInclude(...)` → `await ctx.get('loader')?.await()` → `assertEntriesActivated` → return，
// 期间**不 emit** 任何"就绪"事件（只 emit `loader/config-update`）。
// 而 `loader.await()` 我们也**不能**用：那棵树包含我们自己的挂载任务 ⇒ 在 init 里 await 它会自等死锁。
// ⇒ 采用两条**不会有死锁**的机制：
//   ① 有界延迟重探（下面的 delays）：每次重探都拿最新事实，直到"无待关注项"或重试用尽；
//   ② `ctx.inject([服务])` 事件驱动（服务/工具一旦出现立刻重探）—— 这是 cordis 的正确姿势，
//      服务始终不出现时回调**只是不触发**，不会报错、也不阻塞。
// 结果：**已装且可用的插件不再被误报**；刚装上的插件也不必为了这行提示再重启一次（懒重探兜底）。
const OPTIONAL_PROBE_DELAYS_MS = [250, 1000, 3000];
let OPTIONAL_PROBE_TIMERS = [];
function scheduleOptionalPluginCheck(ctx, delays) {
  const plan = Array.isArray(delays) ? delays : OPTIONAL_PROBE_DELAYS_MS;
  const timers = [];
  const run = (isLast) => {
    if (OPTIONAL_HINT_DONE) return;
    let r;
    try { r = detectOptionalPlugins(ctx); } catch { return; }
    if (!r.needsAttention.length) { OPTIONAL_HINT_DONE = true; return; } // 都就绪 ⇒ 一声不吭（且不再打扰）
    if (isLast) { OPTIONAL_HINT_DONE = true; console.log(r.hint); }
  };
  plan.forEach((ms, i) => {
    const t = setTimeout(() => run(i === plan.length - 1), ms);
    if (t && typeof t.unref === 'function') t.unref();
    timers.push(t);
  });
  OPTIONAL_PROBE_TIMERS = timers;
  // 事件驱动兜底：服务一出现就重探（不出现则永不触发，零副作用）。
  for (const svc of ['costMeter', 'tools']) {
    try { if (ctx && typeof ctx.inject === 'function') ctx.inject([svc], () => run(true)); } catch { /* best-effort */ }
  }
  return timers;
}
// ── 会话模型 effort 预检（2026-09-15，D 项）────────────────────────────────────
// 只告警、不阻断：宿主在**任何网络 I/O 之前**就会因"模型未声明 reasoningEfforts"拒绝带 effort 的
// 角色派工（`dsh-llm` 的 resolveCallWithInfo）。插件改不了宿主行为，只能**提前说清** + 给出修法。
// 纪律：读不到 ⇒ 静默；一次加载最多一行；服务晚挂则就绪后重探（同 OPTIONAL_* 那套）。
let EFFORT_PREFLIGHT = null;
let EFFORT_TIMERS = [];
function scheduleEffortPreflight(ctx, delays) {
  const plan = Array.isArray(delays) ? delays : EFFORT_PROBE_DELAYS_MS;
  // 实例**按 ctx 创建**（不搞模块级 ctx 全局）：读模型能力的入口在闭包里直接捕获 ctx。
  EFFORT_PREFLIGHT = createEffortPreflight({
    readPresetSource: async () => readFile(new URL('../presets/expert-team/agent.cordis.yml', import.meta.url), 'utf8'),
    readSelection: (c) => {
      const svc = c && typeof c.get === 'function' ? c.get('agentDefaultModel') : null;
      const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null;
      return sel && sel.provider && sel.model ? { provider: String(sel.provider), model: String(sel.model) } : null;
    },
    readModelInfo: async (provider, model) => {
      const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null;
      if (!llm || typeof llm.resolveModelInfo !== 'function') throw new Error('llm.resolveModelInfo 不可用');
      return llm.resolveModelInfo(provider, model);
    },
    onEvent: (type, payload) => {
      try { console.warn('[expert-team] ' + type, JSON.stringify(payload)); } catch { /* 观测失败不影响加载 */ }
    },
  });
  plan.forEach((ms, i) => {
    const t = setTimeout(() => { void EFFORT_PREFLIGHT(ctx, { isLast: i === plan.length - 1 }); }, ms);
    if (t && typeof t.unref === 'function') t.unref();
    EFFORT_TIMERS.push(t);
  });
  // 事件驱动兜底：llm / agentDefaultModel 任一晚挂，服务一出现就立刻重探（不出现则永不触发）。
  for (const svc of ['llm', 'agentDefaultModel']) {
    try { if (ctx && typeof ctx.inject === 'function') ctx.inject([svc], () => { void EFFORT_PREFLIGHT(ctx, { isLast: true }); }); } catch { /* best-effort */ }
  }
  return EFFORT_TIMERS;
}
function _resetEffortPreflight() {
  for (const t of EFFORT_TIMERS) { try { clearTimeout(t); } catch { /* ignore */ } }
  EFFORT_TIMERS = [];
}
function _resetOptionalHintOnce() {
  OPTIONAL_HINT_DONE = false;
  for (const t of OPTIONAL_PROBE_TIMERS) { try { clearTimeout(t); } catch { /* ignore */ } }
  OPTIONAL_PROBE_TIMERS = [];
}

function warnInstallFailureOnce(kind) {
  if (INSTALL_FAILURE_WARNED.has(kind)) return;
  INSTALL_FAILURE_WARNED.add(kind);
  console.warn(`[expert-team] 未能铺下 ${kind} 副本（插件其余功能不受影响）：$DSH_HOME 可能不可写`);
}
function installInBackground(kind, run) {
  try {
    Promise.resolve(run())
      .then((target) => { if (!target) warnInstallFailureOnce(kind); })
      .catch(() => warnInstallFailureOnce(kind));
  } catch {
    warnInstallFailureOnce(kind);
  }
}

// ── 铺盘：归属判定 + 原子换名（2026-09-16 · 用户批准 (a)+(b)）──────────────────
//
// 旧实现的两个坑（详见 `lib/preset-lay.js` 文件头）：
//   ① **半成品被当成"用户的定制"**：铺盘中途被打断（进程被杀/磁盘满）会留下**无戳的半成品**；
//      若打断发生在身份文件落地之前，归属判定的两条判据都不成立 ⇒ 此后**永不覆盖**，
//      只打一行 warn ⇒ 插件预设再也铺不上，而唯一的信号看起来完全正常。
//   ② 判定只有"是不是我们的"两态，缺"存在、但**判不出来**"这一态 ⇒ 不确定的输入被静默当成了用户的。
// 现在：四态判定（`classifyLayTarget`，纯函数、单一真源）+ **原子换名**（同父目录临时目录 → rm → rename；
// **不是"完全原子"**，残余窗口见 `lib/host-state-file.js` 的函数头），且 `foreign-complete` /
// `partial-or-unknown` 这两种"我们没覆盖"的情形**必须能被用户看到**（状态进只读路由 + 设置页）。

/** 读版本戳：区分「确实没有」（ENOENT ⇒ false）与「读不到」（⇒ **null = 不确定**，不许当成 ours）。 */
async function readStampFact(file) {
  try {
    return { hasStamp: true, stampText: await readFile(file, 'utf8') };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { hasStamp: false, stampText: null };
    return { hasStamp: null, stampText: null };
  }
}
/** 读身份文件：ENOENT ⇒ 确实没有（`read:false`）；其它读取错误 ⇒ **不确定**（`read:null`）。 */
async function readIdentityFact(file) {
  try { return { read: true, text: await readFile(file, 'utf8') }; }
  catch (e) { return { read: (e && e.code === 'ENOENT') ? false : null, text: null }; }
}
/** 源目录里的入口文件名（排除版本戳）——「齐全/不齐」的期望清单由**源目录**现算，不写死。 */
async function sourceEntryNames(srcDir) {
  try { return (await readdir(srcDir)).filter((n) => n !== INSTALL_STAMP); } catch { return []; }
}
/**
 * 收集归属判定所需的**事实**（判据本身在 `lib/preset-lay.js`；这里只观测，不下结论）。
 * @param {'preset'|'skill'} kind
 */
async function layFactsFor(kind, srcDir, target) {
  const expectedEntryFiles = await sourceEntryNames(srcDir);
  if (!(await pathExists(target))) return { exists: false, expectedEntryFiles };
  const stamp = await readStampFact(join(target, INSTALL_STAMP));
  const facts = {
    exists: true,
    hasStamp: stamp.hasStamp,
    stampVersion: stamp.stampText == null ? null : String(stamp.stampText).trim(),
    currentVersion: PLUGIN_VERSION,
    identityMatch: null,
    expectedEntryFiles,
    presentEntryFiles: await listEntryNames(target),
  };
  if (kind === 'skill') {
    const md = await readIdentityFact(join(target, 'SKILL.md'));
    facts.identityMatch = md.read === true ? parseSkillMarkdown(md.text).meta.name === 'expert-team' : (md.read === false ? false : null);
  } else {
    const yml = await readIdentityFact(join(target, 'agent.cordis.yml'));
    facts.identityMatch = yml.read === true ? /tool-subagent-pm/.test(yml.text) : (yml.read === false ? false : null);
  }
  return facts;
}

/** 每种「跳过」只响亮一次（每次都刷会把"响亮"变噪声 —— 但**状态与设置页每次都如实更新**）。 */
const LAY_SKIP_WARNED = new Set();
function reportLaySkip(kind, target, plan) {
  const key = kind + ':' + plan.state;
  if (LAY_SKIP_WARNED.has(key)) return;
  LAY_SKIP_WARNED.add(key);
  if (plan.state === 'foreign-complete') {
    console.warn(`[expert-team] ${target} 已存在且是**你自己的定制**（不是本插件所铺）⇒ 未覆盖。可在设置页「专家团 → 预设铺设」里显式重新铺设。`);
  } else {
    console.warn(`[expert-team] ${target} 已存在但内容**不完整/归属判不出来**（${plan.reason}${plan.missing && plan.missing.length ? '；缺 ' + plan.missing.join('、') : ''}）⇒ 未覆盖。可能是上次铺设被打断；可在设置页显式重新铺设。`);
  }
}

/**
 * 原子铺一个资产（preset / skill 副本）。归属判定不过 ⇒ **不铺**，并把事实记进状态。
 * @param {'preset'|'skill'} kind
 * @param {string} srcDir
 * @param {string} target
 * @param {{force?: boolean, forceEvenFresh?: boolean, replacedBy?: string}} [opts]
 *   `force` = 用户**显式**要求重铺（此时即使目标是用户的定制也照铺，但**必须记录替换了什么**）
 * @returns {Promise<string|null>} 目标路径（跳过也算"在位"）；铺失败返回 null
 */
async function layInstalledAsset(kind, srcDir, target, opts = {}) {
  const force = opts.force === true;
  const facts = await layFactsFor(kind, srcDir, target);
  const plan = classifyLayTarget(facts);
  let replacedNote = null;
  if (force) {
    replacedNote = [
      plan.state,
      String((facts.presentEntryFiles || []).length) + ' 项',
      facts.hasStamp === true ? '带我们的戳' : (facts.hasStamp === false ? '无戳' : '戳读不到'),
      facts.identityMatch === true ? '身份是本插件' : (facts.identityMatch === false ? '身份不符' : '身份判不出来'),
      opts.replacedBy ? '由' + opts.replacedBy + '触发' : '',
    ].filter(Boolean).join(' · ');
    if (plan.action === 'skip-fresh' && opts.forceEvenFresh !== true) {
      recordLayOutcome(kind, { ...plan, target, pluginVersion: PLUGIN_VERSION, outcome: 'skipped' });
      return target;
    }
  } else if (plan.action === 'skip-fresh') {
    recordLayOutcome(kind, { ...plan, target, pluginVersion: PLUGIN_VERSION, outcome: 'skipped' });
    return target;
  } else if (plan.action === 'skip-user' || plan.action === 'skip-incomplete') {
    recordLayOutcome(kind, { ...plan, target, pluginVersion: '', outcome: 'skipped' });
    reportLaySkip(kind, target, plan);
    return target;   // 在位（是别人的/不完整的），调用方不该当成失败
  }

  try {
    // 先清掉我们自己前缀的残留临时目录（上次被打断留下的），再原子铺。
    await cleanStaleLayDirs(dirname(target));
    await layDirAtomic(srcDir, target, {
      copyInto: async (tmpDir) => {
        await copyDir(srcDir, tmpDir);
        await ARTIFACT.must(join(tmpDir, INSTALL_STAMP), PLUGIN_VERSION + '\n');
      },
    });
    await recordInstalled(kind, target);
    recordLayOutcome(kind, {
      ...plan,
      state: 'ours',
      action: 'lay',
      outcome: 'succeeded',
      reason: force ? 'explicit-relay' : plan.reason,
      target,
      pluginVersion: PLUGIN_VERSION,
      replaced: replacedNote,
    });
    return target;
  } catch (e) {
    recordLayOutcome(kind, {
      ...plan,
      action: 'lay',
      outcome: 'failed',
      reason: 'lay-failed:' + String((e && e.message) || e),
      target,
      pluginVersion: PLUGIN_VERSION,
    });
    return null;
  }
}

async function ensureSkillInstalled() {
  // 运行时注册成功 ⇒ 一个文件都不写（默认路径；也是"卸载即干净"的前提）
  if (RUNTIME_SKILL_REGISTERED) {
    // ⚠️ 必须**记进 STATUS**：否则 STATUS.skill 恒为 null ⇒ 设置页永远显示
    // 「铺设状态未知」（一盏不会自己灭的 warn 灯）。这是**已知的正常**，不是判不出来。
    recordLayOutcome('skill', skillRuntimeRegisteredRecord(SKILL_DIR, PLUGIN_VERSION));
    return SKILL_DIR;
  }
  return layInstalledAsset('skill', SKILL_DIR, join(dshHome(), 'skills', 'expert-team'));
}

async function ensurePresetInstalled() {
  return layInstalledAsset('preset', fileURLToPath(PRESET_SRC), join(dshHome(), '.agent-presets', 'expert-team'));
}

/**
 * **用户显式**要求重新铺设（设置页「重新铺设」按钮或 `POST /preset-lay {action:'relay'}`）。
 * 与自动路径的唯一区别：**即使**目标是"用户的定制"或"判不出来的半成品"也照铺 —— 因为这是用户的明确指令；
 * 但**绝不静默**：替换了什么会记进状态并原样回给调用方。
 *
 * @param {'preset'|'skill'|'both'} kind
 * @returns {Promise<{ok: boolean, kind: string, results: object[], status: object}>}
 */
async function relayInstalledAssets(kind = 'both') {
  const want = kind === 'both' ? ['preset', 'skill'] : [kind];
  const results = [];
  for (const k of want) {
    if (k === 'skill' && RUNTIME_SKILL_REGISTERED) {
      results.push({ kind: k, ok: true, skipped: 'runtime-registered', path: SKILL_DIR });
      continue;
    }
    const srcDir = k === 'preset' ? fileURLToPath(PRESET_SRC) : SKILL_DIR;
    const target = k === 'preset' ? join(dshHome(), '.agent-presets', 'expert-team') : join(dshHome(), 'skills', 'expert-team');
    const before = presetLayStatus()[k];
    const out = await layInstalledAsset(k, srcDir, target, { force: true, forceEvenFresh: true, replacedBy: 'explicit-relay' });
    results.push({ kind: k, ok: out !== null, path: out || target, before: before || null, after: presetLayStatus()[k] });
  }
  return { ok: results.every((r) => r.ok), kind, results, status: presetLayStatus() };
}

// ── scaffold ───────────────────────────────────────────────────────────────

async function scaffoldRun(cwd, mode) {
  const base = runIdFrom(mode.task, mode.runName);
  let runId = base;
  let n = 2;
  let runDir = join(teamRoot(cwd), runId);
  // Avoid clobbering an existing run (rare now that a timestamp is appended).
  while (true) {
    try {
      await readFile(join(runDir, 'STATE.json'));
      runId = `${base}-${n++}`;
      runDir = join(teamRoot(cwd), runId);
    } catch {
      break;
    }
  }
  await mkdir(runDir, { recursive: true });

  // Copy the canonical templates (single source of truth).
  // `AUTHORITY.md`（单源化权威表）随 run 一起发：**空着也有意义** —— 它带着「该怎么写」的说明与校验规则
  // （设计稿 §十二：真实 run 的 64% 返工来自「同一事实多份拷贝 / 多写者」，本表把它提到事前）。
  // ⚠️ 本常量 = **从 `templates/` 复制出来的文件**（13 项）。它与"run 目录必需文件清单"（两个 e2e
  // 测试里的 14 项）**不是同一个集合**：那边多一个 `RUN.log.md`（由 run log 写入器创建）、这边就是
  // 模板全集。两者关系由 `artifact-ownership.test.mjs` 的「工件清单一致」断言钉住，避免下次又被
  // 当成同一件事去"对齐"（2026-09-15 阶段 C 的口径核查）。
  const templates = ARTIFACT_TEMPLATES;
  for (const t of templates) {
    try {
      await ARTIFACT.must(join(runDir, t), await readFile(new URL(t, TEMPLATES_SRC)));
    } catch {
      // Template missing: leave a minimal placeholder so the run dir is still valid.
      await ARTIFACT.must(join(runDir, t), `# ${t}\n`);
    }
  }

  // Stamp the concrete invocation into TASK.md and ROSTER.json.
  const task = [
    '# 任务',
    '',
    `> 目标：${mode.task}`,
    '',
    `- 模式：${mode.persist ? 'persist' : 'one-shot'}`,
    `- 交付：${mode.deliverable ? (mode.deliverable === 'artifacts-only' ? 'artifacts-only' : 'code+artifacts') : (mode.noCode ? 'artifacts-only' : 'code+artifacts')}`,
    `- 固定角色：${(mode.roles && mode.roles.length ? mode.roles : DEFAULT_ROLES).join(', ')}`,
    // G 线（档位）：档位必须**落在工件里**——它是裁剪依据，也是事后复盘"这次该不该跑这么重"的凭据。
    `- 档位：${tierSummaryLine(mode.tier)}`,
    (mode.profile ? `- profile：${mode.profile}（${mode.profileNote || ''}）` : ''),
    `- runId：${runId}`,
    `- 创建于：${new Date().toISOString()}`,
    '',
    '## 完成标准',
    '',
    '（clarify 结束时由 lead 口述客观验收条件，指派的有 `write` 成员落盘；deliver 按它验收）',
    '',
    '## 禁止操作',
    '',
    '（clarify 时由 lead 确认并填写越界禁区：不改什么、不发布、不删什么）',
    '',
    '## 状态',
    '',
    '待编排者按 expert-team skill 推进。',
    '',
  ].join('\n');
  await ARTIFACT.must(join(runDir, 'TASK.md'), task);

  const rosterRoles = (mode.roles && mode.roles.length ? mode.roles : DEFAULT_ROLES);
  const roster = { runId, roles: rosterRoles, members: {}, createdAt: new Date().toISOString(), tier: normalizeTier(mode.tier) || DEFAULT_TIER };
  // Persist stable + UNIQUE agent identities at run creation: names pick from
  // the pool by role INDEX (offset by run seed) so two roles never share a name
  // (no "James" twice), and the same role keeps its name across resume/reload.
  roster.agents = {};
  const seed = hashStr(runId);
  rosterRoles.forEach((role, idx) => {
    const nm = AGENT_NAMES[(seed + idx) % AGENT_NAMES.length];
    roster.agents[role] = { name: nm, color: AGENT_COLORS[(seed + idx * 3) % AGENT_COLORS.length], initial: agentInitial(nm) };
  });
  // cost/model auto-select: heavy roles → top model, light roles → fast model
  // (provider inherits the session route; dsh-model-failover degrades live).
  roster.models = modelPlanFor(rosterRoles);
  await ARTIFACT.must(join(runDir, 'ROSTER.json'), JSON.stringify(roster, null, 2) + '\n');

  // 批 0-3：记录目标与目标指纹 —— planDiscarded 的「同目标」判定依赖它
  const state = { runId, phase: 'clarify', status: 'running', mode: mode.persist ? 'persist' : 'one-shot', deliverable: mode.noCode ? 'artifacts-only' : 'code+artifacts', coverage: [], members: [], goal: mode.task, goalKey: goalKeyOf(mode.task), tier: normalizeTier(mode.tier) || DEFAULT_TIER, updatedAt: new Date().toISOString() };
  await ARTIFACT.must(join(runDir, 'STATE.json'), state);

  // Operational run log: seed with a machine-greppable `run:started` line. The
  // orchestrator appends the rest (phase/role/decision/error events) per the
  // LOGGING.md convention, and writes RETRO.md + appends team/LEARNINGS.md.
  const roles = (mode.roles && mode.roles.length ? mode.roles : DEFAULT_ROLES).join(',');
  const startLine = `run:started — 目标="${mode.task}" | 模式=${mode.persist ? 'persist' : 'one-shot'} | 交付=${mode.noCode ? 'artifacts-only' : 'code+artifacts'} | 档位=${TIER_LABELS_ZH[normalizeTier(mode.tier) || DEFAULT_TIER]}（${normalizeTier(mode.tier) || DEFAULT_TIER}） | 编制=${roles}`;
  await ARTIFACT.must(join(runDir, 'RUN.log.md'), [
    '# 运行日志（RUN.log）',
    '',
    `- [${ts()}] ${startLine}`,
    '',
    '<!-- 编排者：每完成一个阶段/角色/决策/卡点，按 references/LOGGING.md 的事件约定追加一行；deliver 时写 RETRO.md，并把可复用经验追加到 team/LEARNINGS.md -->',
    '',
  ].join('\n'));

  return { runId, runDir };
}

// ── status / members ───────────────────────────────────────────────────────

/**
 * B1：run 健康度 —— 让「搁浅 / 损坏的 run」**可发现**（纯函数，便于单测）。
 *
 * 缺陷：`listRuns` / `listRunsInWorkspace` 对缺 `STATE.json` 的目录是
 * `catch { /* skip malformed *\/ }` **静默跳过**。实测 `team/` 下 4 个目录里
 * **2 个没有 STATE.json**、1 个停在 `clarify/running` 很久 —— 用户在 `/team status`
 * 与面板 run 下拉里**一个都看不到**，也没有"停滞"这个概念。
 *
 * 口径：
 *   broken    —— STATE 缺失/不可解析（连阶段都不知道）；**最需要用户知道的一类**
 *   stalled   —— 状态仍是 running，但 `updatedAt` 距今超过 stallMs（默认 30 分钟）
 *   discarded —— 用户显式丢弃过（`planDiscarded`）；不是故障，别当告警
 *   done      —— complete / completed
 *   ok        —— 其余（正在跑或正常收尾）
 * `now` 与 `stallMs` 显式传入，测试不依赖真实时钟。
 */
const RUN_STALL_MS = 30 * 60 * 1000;
function runHealth(state, opts) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const stallMs = typeof o.stallMs === 'number' ? o.stallMs : RUN_STALL_MS;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { health: 'broken', reason: '缺 STATE.json（或不可解析）', ageMs: 0 };
  }
  const st = String(state.status || '');
  const at = Date.parse(state.updatedAt || '');
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : 0;
  if (state.planDiscarded) return { health: 'discarded', reason: '计划被用户丢弃', ageMs };
  if (st === 'complete' || st === 'completed') return { health: 'done', reason: '', ageMs };
  // 只有"仍在 running"才谈搁浅：failed/cancelled 是**已知终态**，不算搁浅
  if (st === 'running' && ageMs > stallMs) {
    return { health: 'stalled', reason: `状态仍是 running，但已 ${Math.round(ageMs / 60000)} 分钟无更新`, ageMs };
  }
  return { health: 'ok', reason: '', ageMs };
}

/**
 * B2（N-8）：识别「LLM 自建 run」—— 绕过 `/team` 脚手架、由 lead 直接 `write` 出来的 run。
 *
 * 为什么需要：实测真实工作区里**多数 run 不是 `scaffoldRun` 建的**（lead 直接写文件），
 * 而本 run 的三处字段漂移**全部出在这条路径**上。不把这条路径纳入门禁，
 * 前面的 schema 校验就只能覆盖"正规建出来的 run"，等于漏掉大部头。
 *
 * 判定用**脚手架指纹**（`scaffoldRun` 恒定写入的字段 + ROSTER.json）：
 *   `STATE.json` ⊇ {runId, phase, status, mode, deliverable}，且 `ROSTER.json` 存在。
 * 实测 7 个真实 run（dsh ×2 / school ×6 / jiu ×1）**全部命中全部字段** ⇒ 该指纹零误报；
 * 一旦缺项，几乎必然是手写产物（或被改坏）。
 *
 * 返回 `{selfBuilt, missing}`；`missing` 逐条说明缺什么，**用户能照单补**。
 */
const SCAFFOLD_REQUIRED = ['runId', 'phase', 'status', 'mode', 'deliverable'];
function scaffoldFingerprint(state, roster, opts) {
  const o = opts || {};
  const hasRoster = o.hasRoster === undefined ? !!(roster && typeof roster === 'object') : !!o.hasRoster;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { selfBuilt: true, missing: ['STATE.json（缺失或不可解析）'] };
  }
  const missing = SCAFFOLD_REQUIRED.filter((k) => state[k] === undefined || state[k] === null || state[k] === '');
  if (!hasRoster) missing.push('ROSTER.json（缺文件或缺 roles/members）');
  return { selfBuilt: missing.length > 0, missing };
}

async function listRuns(cwd) {
  const root = teamRoot(cwd);
  let names = [];
  try { names = await readdir(root); } catch { return []; }
  const runs = [];
  for (const n of names.sort()) {
    const d = join(root, n);
    try {
      const stateRaw = await readFile(join(d, 'STATE.json'), 'utf8');
      const state = JSON.parse(stateRaw);
      const taskRaw = await readFile(join(d, 'TASK.md'), 'utf8');
      const firstLine = taskRaw.split('\n').map((l) => l.replace(/^#\s*/, '').trim()).find((l) => l && l !== '任务' && !l.startsWith('>')) ?? '';
      const h = runHealth(state);
      runs.push({ runId: n, phase: state.phase, status: state.status, mode: state.mode, task: firstLine.slice(0, 120), members: state.members ?? [], updatedAt: state.updatedAt, health: h.health, healthReason: h.reason, ageMs: h.ageMs });
    } catch (e) {
      // B1：**不再静默跳过**。缺 STATE.json / STATE 不可解析的目录过去被 `catch { /* skip *\/ }`
      // 直接吞掉 ⇒ 实测 `team/` 下有 2 个这样的目录在 `/team status` 里**完全看不到**，
      // 而「东西少了却没有任何信号」正是本插件最危险的失败模式。
      // 现在如实列出并标明原因（尽力读 TASK.md 拿标题；读不到也不影响"可见"）。
      let title = '';
      try {
        const taskRaw = await readFile(join(d, 'TASK.md'), 'utf8');
        title = (taskRaw.split('\n').map((l) => l.replace(/^#\s*/, '').trim()).find((l) => l && l !== '任务' && !l.startsWith('>')) ?? '').slice(0, 120);
      } catch { /* 连 TASK.md 都没有 */ }
      runs.push({ runId: n, phase: '', status: '', mode: '', task: title, members: [], updatedAt: '', health: 'broken', healthReason: String((e && e.message) || 'STATE.json 不可读').slice(0, 80), ageMs: 0 });
    }
  }
  return runs;
}

async function renderStatus(cwd) {
  await autoAggregate(cwd); // keep METRICS + distilled LEARNINGS fresh on status
  const runs = await listRuns(cwd);
  if (!runs.length) return { kind: 'success', text: '还没有专家团 run。用 /team <task> 组队。' };
  const lines = [];
  let strandedTotal = 0; // L3-2′：跨 run 汇总的搁浅任务数
  for (const r of runs) {
    const tasks = await readJsonSafe(join(teamRoot(cwd), r.runId, 'TASKS.json'));
    const roster = await readJsonSafe(join(teamRoot(cwd), r.runId, 'ROSTER.json'));
    const arr = taskList(tasks);
    const total = arr.length;
    const done = arr.filter((t) => ['completed', 'done'].includes(t.status)).length;
    const failed = arr.filter((t) => ['failed', 'cancelled'].includes(t.status)).length;
    const prog = total ? `${done}/${total} 完成` : '无任务';
    const failNote = failed ? ` · 失败${failed}` : '';
    const violNote = checkTasks(arr, r.phase).length ? ` · ⚠违规${checkTasks(arr, r.phase).length}` : '';
    const modelNote = summarizeModels(roster?.models || modelPlanFor(roster?.roles || []));
    // G 线（档位）：档位必须在 `/team status` 里看得见 —— 它是"这次该不该跑这么重"的唯一凭据。
    // 编制超过该档角色上限时**如实标出来**（不自动改编制：那是用户的决定，不是代码的）。
    // B1：损坏 / 搁浅必须**显式可见**，而不是被静默跳过
    if (r.health === 'broken') {
      lines.push(`- ${r.runId}  ⛔ 损坏：${r.healthReason}  ${r.task || ''}`);
      continue;
    }
    const healthNote = r.health === 'stalled' ? `  ⚠ 搁浅：${r.healthReason}`
      : r.health === 'discarded' ? '  ⏹ 计划已丢弃' : '';
    // L3-2′ 可发现：在飞但没人做的任务（冷启动后必然出现）也要在这里可见
    const inFlight = arr.filter((t) => IN_FLIGHT_STATUSES.includes(t.status)).length;
    const strCount = strandedTasks(arr, new Set()).length;
    const strandNote = strCount ? ` · ⚠搁浅任务${strCount}` : '';
    // G 线（档位）：档位必须在 `/team status` 里看得见 —— 它是"这次该不该跑这么重"的唯一凭据。
    // 编制超过该档上限时如实标出（**不**自动改编制：那是用户的决定，不是代码的）。
    const tierId = normalizeTier(roster?.tier);
    const roleN = (roster?.roles || []).length;
    const tierNote = tierId
      ? ` · 🎚${TIER_LABELS_ZH[tierId]}${roleN > TIER_SPEC[tierId].roleCap ? `（⚠ 编制 ${roleN} 超该档上限 ${TIER_SPEC[tierId].roleCap}）` : ''}`
      : ' · 🎚档位未登记（旧 run）';
    lines.push(`- ${r.runId}  [${modeZh(r.mode)}] ${phaseZh(r.phase)}/${statusZh(r.status)}  ${prog}${failNote}${violNote}${modelNote}${tierNote}${healthNote}${strandNote}  ${r.task}${r.members.length ? `  (成员: ${r.members.length})` : ''}`);
    if (strCount) strandedTotal += strCount;
  }
  const broken = runs.filter((r) => r.health === 'broken').length;
  const stalled = runs.filter((r) => r.health === 'stalled').length;
  const tail = (broken || stalled || strandedTotal)
    ? `\n\n⚠ 需要处理：${[broken ? `${broken} 个损坏` : '', stalled ? `${stalled} 个搁浅 run` : '', strandedTotal ? `${strandedTotal} 个搁浅任务` : ''].filter(Boolean).join(' · ')}`
      + '\n（损坏 = 缺 STATE.json 或不可解析；搁浅 run = 状态仍是 running 但超 30 分钟无更新；'
      + '搁浅任务 = 状态仍是 claimed/in_progress 但已无存活成员。）'
      + '\n搁浅任务可清算：`/team settle <run>`（清回 pending + attempt+1 + RUN.log 留痕），然后让 lead 重新派工。'
      + '\n损坏 run 可人工确认后删除该目录，或补一份 STATE.json 让它重新可见。'
    : '';
  return { kind: 'success', text: '专家团 runs：\n' + lines.join('\n') + tail };
}

/**
 * G 线：`/team tier <档位>` —— 运行中**升档**（SKILL §1.1「不允许降档」的代码强制）。
 *
 * 为什么在代码里拦降档：SKILL 写"跑不顺就降级等于用档位掩盖问题"，但那只是一句话；
 * 真正的失败模式是 lead 遇到评审卡壳时把档位调低让门禁变松。**能改的只有"更严"这个方向。**
 *
 * 注意：本命令**不改编制**（成员可能已经领了活）。按档定班底只发生在**派工开始前**
 *（建 run 显式 `--tier`，或浮层选择档位那一刻，见 `narrowedRoles`）。
 */
async function setTier(cwd, run, tierRaw) {
  const t = normalizeTier(tierRaw);
  if (!t) {
    return {
      kind: 'error',
      text: [
        `⛔ 档位取值无法识别：「${tierRaw || ''}」`,
        `- 合法值：${tierChoices().map((c) => `${c.label}（${c.tier}）`).join(' / ')}`,
        '- 用法：`/team tier <档位> [--run <run>]`',
      ].join('\n'),
    };
  }
  if (!run) return { kind: 'error', text: 'Usage: /team tier <档位> [--run <run>]（--run 缺省时用本会话自己的 run）' };
  const dir = join(teamRoot(cwd), run);
  const state = await readJsonSafe(join(dir, 'STATE.json'));
  if (!state) return { kind: 'error', text: `⛔ 找不到 run「${run}」（或它的 STATE.json 不可解析）` };
  const from = normalizeTier(state.tier) || DEFAULT_TIER;
  const rank = { quick: 0, standard: 1, strict: 2 };
  if (rank[t] < rank[from]) {
    return {
      kind: 'error',
      text: [
        `⛔ 不允许降档：${TIER_LABELS_ZH[from]} → ${TIER_LABELS_ZH[t]}`,
        '- 依据：SKILL §1.1「run 进行中允许升档，不允许降档」—— 跑不顺就调低档位，等于用档位掩盖问题，而不是解决问题。',
        '- 如果确实要更轻的流程，正确动作是：把剩余非阻塞项转 `SUMMARY.md` 的 backlog 并按 §7.33 的收尾预算停手。',
      ].join('\n'),
    };
  }
  if (rank[t] === rank[from]) {
    return { kind: 'success', text: `当前已是${tierSummaryLine(t)}，无需改动。` };
  }
  const tsStr = new Date().toISOString();
  state.tier = t;
  state.updatedAt = tsStr;
  await ARTIFACT.must(join(dir, 'STATE.json'), state);
  try {
    const rosterPath = join(dir, 'ROSTER.json');
    const roster = await readJsonSafe(rosterPath);
    if (roster) { roster.tier = t; await ARTIFACT.must(rosterPath, JSON.stringify(roster, null, 2) + '\n'); }
  } catch { /* best-effort：ROSTER 写不进去不影响 STATE 已记档位 */ }
  await appendLog(dir, `tier:changed — ${from} → ${t}（${TIER_LABELS_ZH[t]}）· 角色上限 ≤${TIER_SPEC[t].roleCap} · 验收项 ${TIER_SPEC[t].acceptanceCap === null ? '不限' : `≤${TIER_SPEC[t].acceptanceCap}`}（${tsStr}）`);
  return {
    kind: 'success',
    text: [
      `🎚 档位已升档：${TIER_LABELS_ZH[from]} → **${tierSummaryLine(t)}**`,
      `- run：${run}`,
      '- 编制**不变**（成员可能已领活）；按档定班底只发生在派工开始前。',
      '- 已写进 `STATE.json` 与 `ROSTER.json`，并在 `RUN.log.md` 留痕 `tier:changed`。',
      '- 注意：档位仍**不裁验收面** —— clarify 与交付前真实校验照做。',
    ].join('\n'),
  };
}

async function renderMembers(cwd) {
  const runs = await listRuns(cwd);
  if (!runs.length) return { kind: 'success', text: '还没有专家团 run。' };
  const out = [];
  for (const r of runs) {
    const rosterPath = join(teamRoot(cwd), r.runId, 'ROSTER.json');
    try {
      const roster = JSON.parse(await readFile(rosterPath, 'utf8'));
      out.push(`${r.runId}: ${(roster.roles ?? []).join(', ')}`);
    } catch {
      out.push(`${r.runId}: (roster 缺失)`);
    }
  }
  return { kind: 'success', text: '编制：\n' + out.join('\n') };
}

// `/team models [<run>]`: show the per-role cost/model plan (heavy=top,
// light=fast; provider inherits the session route + failover survives).
async function renderModels(cwd, runArg) {
  const root = teamRoot(cwd);
  const dir = await pickRunDir(root, runArg);
  if (!dir) return { kind: 'success', text: '还没有专家团 run。用 /team <task> 组队。' };
  const runId = basename(dir);
  const roster = await readJsonSafe(join(dir, 'ROSTER.json'));
  const roles = roster?.roles ?? [];
  if (!roles.length) return { kind: 'error', text: `run "${runId}" 缺少 ROSTER.json。` };
  const plan = roster.models || modelPlanFor(roles);
  const lines = roles.map((r) => {
    const v = plan[r];
    const tier = v ? v.tier : 'inherit';
    const model = v && v.model ? v.model : '（继承会话模型）';
    return `- ${String(r).padEnd(10)} ${String(tier).padEnd(6)} → ${model}`;
  });

  // 批 0-5（承诺-能力一致性）：这段文案必须**从真实配置推导**，不能是永远为真的宣传语。
  // 旧文案恒称「成本约为全员顶配的 1/2~1/5」，而 MODEL_DEFAULT 的 heavy/light **同值**（单模型期）
  // ⇒ 产品在展示一个不存在的成本优势。现在按实际值分支，并显式暴露 tier 与 effort 的不一致。
  const tiersDiffer = MODEL_DEFAULT.heavy !== MODEL_DEFAULT.light;
  const efforts = await presetEffortMap();
  const effortRoles = Object.keys(efforts);
  const mismatched = roles.filter((r) => {
    const t = tierOf(r);
    const e = efforts[r];
    if (!t || !e) return false;
    return (t === 'light' && e === 'high') || (t === 'heavy' && e === 'low');
  });
  const honesty = [
    '· 生效能力面（实际 vs 计划）：',
    tiersDiffer
      ? `  - 模型档位：轻/重两档**不同**（${MODEL_DEFAULT.light} / ${MODEL_DEFAULT.heavy}）→ 实际有成本差。`
      : `  - 模型档位：轻/重两档**同为 ${MODEL_DEFAULT.heavy}** → **实际没有成本差**；tier 仅为结构保留，待出现第二个可用模型才会产生降本。`,
    effortRoles.length
      ? `  - 逐角色 reasoning effort：已从 preset 读到 ${effortRoles.length} 个角色的配置（未列出的角色无该项）。`
      : '  - 逐角色 reasoning effort：**未能读取 preset**（路径不可达）→ 该项能力面未知，如实标注。',
    mismatched.length
      ? `  - ⚠️ tier 与 effort 不一致（${mismatched.join('/')}）：tier=light 但 preset effort=high（或反之）。二者谁是权威**尚未拍板**，此处只如实列出、不代为决定。`
      : '  - tier 与 effort 一致（无冲突）。',
  ];
  return {
    kind: 'success',
    text: [
      `模型计划 ${runId}：`,
      ...lines,
      '',
      ...honesty,
      '· provider 未指定 → 继承会话模型路由；dsh-model-failover 熔断时自动降级。',
      '· 要改：preset 里对应角色工具的 agentOptions.model，或 ROSTER.json 的 models。',
    ].join('\n'),
  };
}

// ── /team index: build a project-level knowledge base (Qoder-Repowiki style) ──
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.cache', 'venv', '.venv', 'vendor', '.obsidian', 'tmp', '.tmp']);

async function dirTreeAt(base, depth, maxItems) {
  const out = [];
  try {
    const items = (await readdir(base, { withFileTypes: true })).filter((x) => x.isDirectory() && !x.name.startsWith('.') && !SKIP_DIRS.has(x.name)).slice(0, maxItems);
    for (const x of items) {
      out.push(x.name + '/');
      if (depth > 1) {
        let sub = [];
        try {
          sub = (await readdir(join(base, x.name), { withFileTypes: true })).filter((y) => y.isDirectory() && !y.name.startsWith('.') && !SKIP_DIRS.has(y.name)).slice(0, 12).map((y) => '  ' + y.name + '/');
        } catch { /* unreadable subdir */ }
        out.push(...sub);
      }
    }
  } catch { /* unreadable base */ }
  return out;
}

async function indexProject(cwd) {
  const readTxt = async (p) => { try { return (await readFile(p, 'utf8')).slice(0, 4000); } catch { return ''; } };
  const sections = [];
  for (const f of ['README.md', 'README.zh.md', 'README']) { const t = await readTxt(join(cwd, f)); if (t) { sections.push(`## README/${f}\n${t}`); break; } }
  for (const f of ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'requirements.txt', 'pubspec.yaml', 'composer.json']) { const t = await readTxt(join(cwd, f)); if (t) sections.push(`## ${f}\n${t}`); }
  let docs = [];
  try { docs = (await readdir(join(cwd, 'docs'))).filter((n) => n.endsWith('.md')).slice(0, 12); } catch {}
  for (const d of docs) { const t = await readTxt(join(cwd, 'docs', d)); if (t) sections.push(`## docs/${d}\n${t}`); }
  // project-level distilled learnings (self-optimization loop: /team learn)
  const learningsRaw = await readTxt(join(teamRoot(cwd), 'LEARNINGS.md'));
  if (learningsRaw) sections.push(`## 项目经验（team/LEARNINGS.md，历次 run 总结）\n${learningsRaw}`);
  const tree = await dirTreeAt(cwd, 2, 40);
  sections.push(`## 目录树（两层，跳过构建/依赖目录）\n${tree.length ? tree.join('\n') : '—'}`);
  const md = ['# REPOWIKI（项目知识库）', '', '> 由 `/team index` 自动生成，供专家团各角色读取，提供项目上下文。', '', ...sections].join('\n\n');
  const root = teamRoot(cwd);
  await mkdir(root, { recursive: true });
  const p = join(root, 'REPOWIKI.md');
  await ARTIFACT.must(p, md);
  return { path: p, bytes: md.length, docs: docs.length, tree: tree.length };
}

async function renderIndex(cwd) {
  const res = await indexProject(cwd);
  return {
    kind: 'success',
    text: [
      `已生成项目知识库：${res.path}`,
      `- 大小：${res.bytes} 字节 · docs/*.md ${res.docs} 个 · 目录树 ${res.tree} 项`,
      `- 收录：README / 依赖清单 / docs/*.md / 项目经验（team/LEARNINGS.md）/ 两层目录树`,
      `- 用途：专家团 clarify/research 前读取该文件获取项目上下文；deliver 时用 hindsight_ingest_document 落库跨项目复用（标题「项目知识 · <cwd 名>」）。`,
      `- 跨项目注入：新项目 clarify 前先搜 Hindsight「项目知识 ·」+ 技术栈关键词，可复用要点并入 REPOWIKI 或 RESEARCH.md。`,
      `- 刷新：项目变更后重跑 /team index。`,
    ].join('\n'),
  };
}

// ── session→run memory: which team run THIS session created/last viewed ────
// Auto-select uses it so a fresh session opens its OWN run instead of the
// workspace's newest-by-updatedAt (an old run touched by another session can
// be "newer" and would hijack the panel).
const SESSION_RUNS = new Map(); // sid → { workspace, runId, at, via }
let sessionRunsDirty = false;
function sessionRunsPath() { return join(dshHome(), 'expert-team', 'session-runs.json'); }
/**
 * Remember that a session relates to a run. `via` distinguishes the two very
 * different relationships — conflating them caused a real bug:
 *   · 'create' —— 这个会话**创建/持有**该 run（归属，可用于列人员）
 *   · 'view'   —— 用户只是从下拉里**看了一眼**别人的 run（不构成归属）
 * 旧数据没有 `via`；`runOwnerSession()` **只认 `create`** —— 没有 create 的旧记录
 * 一律返回"未解析"（空 sid），不再把"最早那条"当归属兜底（那会产出假归属）。
 */
/**
 * 该 session id 是否**真实存在**（写侧守卫，2026-09-15）。
 *
 * 为什么需要：/state 允许带任意 `sessionId` 查询，而旧实现在"显式指定 run+workspace"时
 * **无条件** rememberSessionRun(sid, …) 落盘 —— 性能诊断时用一个**假 id** 就被写进了
 * `$DSH_HOME/expert-team/session-runs.json`（污染用户数据）。
 * 只查活存储（便宜、不读日志）；查不到 ⇒ 当只读、**不写盘**。
 * 代价：已结束的会话"查看某 run"不再被记住（面板退回"按当前工作区自动选 run"）——
 * 这是**有意**的取舍：宁可不记，也不写假 id。
 */
function sessionExists(ctx, sid) {
  const id = String(sid || '');
  if (!id) return false;
  try { return Boolean(ctx?.get?.('sessions')?.get?.(id)); } catch { return false; }
}
/**
 * 会话的 cwd 是否就是该工作区 —— 归属表只记"自己的" run。
 * 取不到 cwd ⇒ **false**（宁可少写一条，也不要把别的 run 记成自己的）。
 *
 * ⚠️ 与任务书给的逐字版本有一处**必要**差异（按任务书「以实读为准」条款）：
 * `ctx?.get?.('sessions')?.get?.(sid)?.cwd` 在本仓宿主形状上取不到值 —— 宿主 `Session`
 * 只暴露 `id` getter，cwd 住在 `session.header`（`header.cwd` / `header.meta.cwd`，见宿主
 * `dsh-session/lib/index.js` 的 `validateSessionHeader` 与 `Session.header` 注释），本仓夹具
 * 也一律写 `agent.session.header.cwd`。故改用本仓既有唯一权威取法 `cwdFromSession(ctx, sid)`
 * —— 它的 ctx 访问路径（`ctx.get('sessions').get(id)`）与 `sessionExists` **完全同一套**，
 * 不新增第二份取法。若按逐字版本写，本函数**恒 false** ⇒ 静默变成"什么都不写"的假守卫
 * （正是本任务要修的失效模式：守卫在纸面上存在、在运行时从不生效）。
 */
function sessionOwnsWorkspace(ctx, sid, ws) {
  const want = String(ws || '');
  if (!sid || !want) return false;
  try {
    const cwd = String(cwdFromSession(ctx, sid) || '');
    return cwd !== '' && cwd === want;
  } catch { return false; }
}
function rememberSessionRun(sid, ws, runId, via) {
  if (!sid || !ws || !runId) return;
  const prev = SESSION_RUNS.get(sid);
  // ① 已有归属不得被"查看"改写：**只拦 view 改写 create**，放行真正的 create 改归属
  //    （同一会话建第二个 run 是正常业务流；拦了会让 `/team tier`、`/team task` 这类
  //    不带 `--run` 的子命令退回"工作区最新的 run"）。
  //    旧实现只保 `via` 却覆盖 `workspace`/`runId` ⇒ 那条记录会对**另一个 run** 自称
  //    `create`，`runOwnerSession` 便把它当可信归属（已复现的假归属）。
  if (prev && prev.via === 'create' && via !== 'create' && (prev.runId !== runId || prev.workspace !== ws)) return;
  // ② 跨工作区不写：一条会话记录只属于一个工作区（面板选别的工作区的 run 是合法操作，
  //    但**不该改写归属**）。会话真实 cwd 的校验在调用点（见改动 2）。
  if (prev && prev.workspace && prev.workspace !== ws) return;
  // 已经记过归属的会话，不要被一次"查看"降级成 view
  const next = (prev && prev.via === 'create' && via !== 'create') ? 'create' : (via || 'view');
  SESSION_RUNS.set(sid, { workspace: ws, runId, at: Date.now(), via: next });
  sessionRunsDirty = true;
}
function sessionRunFor(sid) {
  if (!sid) return null;
  return SESSION_RUNS.get(sid) || null;
}
/**
 * Which session OWNS a run — i.e. whose subagents are the run's people.
 *
 * 为什么需要：面板在**会话 A 里选看会话 B 的 run** 时，「run 元信息 + 任务」来自 B，
 * 而「人」原来取自请求里的 sessionId（= A）⇒ 两个 run 的人被混在一起（实测：在 dsh 会话
 * 里看 php/jiu 的 run，拿到的是 dsh 会话的 30 个子代理，而 jiu 只有 6 个）。
 *
 * 解析口径：只认 `via==='create'` 的会话（那才是"这个会话建的这个 run"）。
 * **没有**任何"最早一条"兜底 —— 兜底能用一条纯 `view` 记录造出**假归属**（已复现的
 * 实测事故），故无 create ⇒ 返回"未解析"，由调用方如实提示（见 `ownerResolved`）。
 */
function runOwnerSession(runId) {
  if (!runId) return { sid: '', ownerResolved: false };
  const rows = [];
  for (const [sid, v] of SESSION_RUNS) {
    if (v && v.runId === runId) rows.push({ sid, at: Number(v.at) || 0, via: v.via || '', ws: String(v.workspace || '') });
  }
  if (!rows.length) return { sid: '', ownerResolved: false };
  // 只认 `create`：那才是"这个会话建的这个 run"。**去掉"最早一条"兜底** ——
  // 实测它能用一条纯 `view` 记录造出假归属（发帖-…022930 被归到 dsh 的一个会话）。
  // 无 create ⇒ 如实返回"未解析"，由调用方如实提示（空归属远好过错归属）。
  const created = rows.filter((r) => r.via === 'create').sort((a, b) => a.at - b.at);
  if (!created.length) return { sid: '', ownerResolved: false };
  // 同一 runId **理论上可跨工作区重名**，但**本函数只收 runId、无法比对 workspace** ⇒
  // 这里只是取**最早的 create 记录**（`sort(at)` 后的第一条），**没有**按 workspace 择一；
  // 若两个工作区对同一 runId 各有 create，可能选中属于**另一个工作区**的那条。
  // 调用点若需更强归属，需另传 workspace 再比对（见 backlog）。
  return { sid: created[0].sid, ownerResolved: true };
}
async function loadSessionRuns() {
  try {
    const raw = await readFile(sessionRunsPath(), 'utf8');
    const o = JSON.parse(raw);
    for (const [k, v] of Object.entries(o || {})) SESSION_RUNS.set(k, v);
  } catch { /* first run */ }
}
async function persistSessionRuns() {
  if (!sessionRunsDirty) return;
  sessionRunsDirty = false;
  try {
    await mkdir(join(dshHome(), 'expert-team'), { recursive: true });
    await ARTIFACT.must(sessionRunsPath(), JSON.stringify(Object.fromEntries(SESSION_RUNS)));
  } catch { /* best-effort */ }
}

/**
 * 派工即登记：把「角色 → 真实子代理 id」合并进 `STATE.members`。
 *
 * 为什么需要：`SKILL.md §7.16①` 要求派工即登记 `<agentId>:<role>` 到 `STATE.members`，**由运行时回写**、
 * lead 只读核对（`STATE.json` 的唯一写者是运行时）
 * （"浮层据此**精确归属**成员到本 run，多个专家团并行绝不串号"），但**代码里没有任何写路径**
 * —— 只有 `scaffoldRun` 初始化 `members: []`。实测后果：所有 run 的 `stateMembers` 恒空，
 * `buildRoleSubMap` 的"精确路径"永远不生效，成员归属只能靠 label/事件流/会话映射去猜。
 *
 * 这里由 host 自动登记：它本来就已经算出 `subById`（role→sub，id 是真的），落盘即可。
 * **协议要求的事不再依赖 LLM 记得做**，这也让归属问题有了根治（而非继续推断）。
 *
 * 形状 `"<agentId>:<role>"`（`membersFromState` 接受该形状；role 可带后缀如 `frontend-F4`）。
 * **只增不改、按角色去重**：同一角色派了新 id ⇒ 用新 id 覆盖该角色的旧行（面板应指向当前那个），
 * 其他角色的行原样保留（含 lead 手写的 `:state` 后缀）。
 * 返回 `{entries, changed}`；`changed === false` 时调用方**不要写盘** —— 否则 3s 轮询会持续改写工件。
 */
function deriveMemberEntries(subById, existing) {
  const cur = (Array.isArray(existing) ? existing : []).map((x) => String(x || '')).filter(Boolean);
  const out = cur.slice();
  let changed = false;
  const pairs = (subById instanceof Map) ? [...subById.entries()] : [];
  // 同一角色的**最新** id 赢（Map 里后写的覆盖前面的）
  const want = new Map();
  for (const [role, sub] of pairs) {
    const r = roleNorm(role);
    const id = String((sub && sub.id) || '');
    if (!r || !id) continue;
    want.set(r, id);
  }
  for (const [role, id] of want) {
    const idx = out.findIndex((s) => {
      const parts = s.split(':');
      if (parts.length < 2) return false;
      return roleNorm(parts.slice(1).join(':').split(':')[0]) === role;
    });
    if (idx < 0) { out.push(`${id}:${role}`); changed = true; continue; }
    const parts = out[idx].split(':');
    if (parts[0].trim() === id) continue; // 已登记且同 id ⇒ 不动（保留原有后缀）
    out[idx] = `${id}:${role}`;           // 同角色换 id ⇒ 覆盖
    changed = true;
  }
  return { entries: out, changed };
}
/**
 * "这串东西像不像 session id"的判据 —— **按角色名精确排除**，不按长度猜。
 *
 * 为什么不用长度：可读性好的测试/宿主可能用短 id（`ended-x`、`live-1`），长度阈值会**误伤它们**
 * ⇒ 把真 id 过滤掉，那才是真丢数据。而"角色名"是可以精确判定的：
 *   · 等于某个角色 id（`backend`）⇒ 排除；
 *   · 首个 `-` 段就是角色 id（`frontend-F4` / `reviewer-R1`，角色名带轮次后缀）⇒ 排除。
 * 真实 session id 是 UUID（首段 8 位十六进制）或任意非角色名 ⇒ 保留。
 * 只用于"过滤出真 id"，**不**用于判定归属（归属看 `STATE.members` 与 `artifact-ownership`）。
 *
 * ⚠️ **2026-09-15 真机事故（`subsPending` 永久多 1 的第二个根因）**：这里以前只取
 * `DEFAULT_ROLES`（12 个**固定**角色），而本插件还认识**动态补位角色**
 * （`product-analyst` / `competitive-analyst` / `ui-verifier` / `debugger`）。真机上一个 run 的
 * `STATE.members` 里就有 `…:product-analyst` ⇒ 角色名 `product-analyst` 既不在那个 12 元集合里、
 * 它的首段 `product` 也不在 ⇒ **被当成 agent id 放行**，混进 id 清单后永远查不到，
 * 于是每个节流窗口打开都触发一次全库 rescue 枚举（实测 0.68–0.76 s 尖峰）。
 * 教训：「本插件认识哪些角色」是**一个事实**，只有一个家 —— `lib/vocab.js` 的 `KNOWN_ROLES`；
 * 在这里再抄一份**子集**就是把那个家劈成两半。
 */
const ROLE_NAME_SET = new Set(
  [...KNOWN_ROLES].concat([...ROLE_LABELS_ZH.values()]).map((r) => String(r).toLowerCase()),
);
export function isAgentIdLike(v) {
  const s = String(v || '').trim();
  if (!s || /\s/.test(s)) return false;
  const lower = s.toLowerCase();
  if (ROLE_NAME_SET.has(lower)) return false;
  const head = lower.split('-')[0];
  if (head && ROLE_NAME_SET.has(head)) return false;
  return true;
}

/**
 * `STATE.members` → **只含 agent id** 的清单。
 *
 * 为什么必须单独有它（2026-09-15 性能修复 #5，真机 profile 定位）：以前 id 是从
 * `membersFromState().byRole` 这个 Map 的**键**里捞的，而那个 Map 把
 * `role→agentId` 与 `agentId→role` **塞进了同一个键空间** ⇒ 取键会**混进角色名**
 * （`backend` / `reviewer` / `product-analyst` …）。而角色名永远不可能是某个会话 header 的 id
 * ⇒ `missingIds` **永久非空** ⇒ `/state` 每次都认为"还有人查不到" ⇒ **每个请求都重新枚举
 * 475 个 artifact**（真机 subs 段实测 2.4 s），`SUB_HEADER_MEMO` 因此形同虚设。
 *
 * 2026-09-15 二次修复（真机 `subsPending` 恒 ≥1 + 每 120 s 一次 0.68–0.76 s 尖峰）：根因不再是
 * "捞错了地方"，而是**那个 Map 本身就把两个命名空间混在一起**（见 `membersFromState`）。
 * 现在键空间已按构造分离（`byId` 只装 id、`byRole` 只装角色），这里的 `isAgentIdLike` 退居
 * **第二道**兜底（防未来又有人把角色名写进 `members` 的 id 槽，例如 `backend:pm`）。
 * ⇒ 需要 id 的地方一律走这里，**不要**再对 `byRole` 取键或取值。
 */
export function memberAgentIds(members) {
  const { byId } = membersFromState(members);
  const out = [];
  for (const k of byId.keys()) if (isAgentIdLike(k)) out.push(k);
  return out;
}
/**
 * 解析 `STATE.members` 的两种形状：
 *   · `"<agentId>:<role>[:state]"` ⇒ 精确绑定（id 与角色绑定的**真源**）
 *   · `"<role>:<name>"`           ⇒ 遗留形状（没有 id，只有名字）
 *
 * **返回分开的两个 Map，而不是以前那个双键 Map** —— 这就是 2026-09-15 真机事故的修法本身：
 *   旧实现把 `role→id` 与 `id→role` 都塞进 `byRole` 一个 Map ⇒ **键空间被混**。消费方拿到
 *   `byRole.keys()` 时分不清手里是角色还是 id，只能靠 `isAgentIdLike` 去猜；而"猜"必然有漏
 *   —— 真机上动态角色 `product-analyst` 就漏过去了，变成一个**查不到的幽灵 id**，
 *   让热路径每 120 s 重付一次全库 rescue 枚举（实测 0.68 s / 0.76 s 两次尖峰）。
 *   现在 **按构造就不可能混**：`byRole` 的键只可能是角色，`byId` 的键只可能是 id。
 *   （旧 `byRole` 顺带承担的"用 id 反查角色"现在归 `byId`。）
 *
 * @returns `{byRole: Map<role, agentId>, byId: Map<agentId, role>, names: Map<role, name>}`
 */
function membersFromState(members) {
  const byRole = new Map(), byId = new Map(), names = new Map();
  for (const item of Array.isArray(members) ? members : []) {
    const s = String(item || '');
    const parts = s.split(':');
    if (parts.length < 2) continue;
    const a = parts[0].trim(), b = parts.slice(1).join(':').trim(); // b = role[:done]
    if (!a || !b || a === 'm' || a === 'id' || a === 'name') continue;
    if (/^[\w-]{16,}$/.test(a) || /-/.test(a)) {
      // agentId:role[:state] — role may carry suffixes (frontend-F4, reviewer-R1)
      const role = roleNorm(b.split(':')[0]);
      if (!byRole.has(role)) byRole.set(role, a); // first dispatch wins for display
      byId.set(a, role);                          // 反向查角色：**只在 id 键空间里**
    } else {
      names.set(a, b.split(':')[0]);
    }
  }
  return { byRole, byId, names };
}
// Build the role→subagent map the overlay uses: STATE.members precise ids win
// (each run registers its OWN agents → parallel runs never cross-match);
// fallback = label keyword mapping (legacy runs), informed by the workflow
// delegation labels recovered from the parent session log (wfLabels).
function buildRoleSubMap(subs, stateMembers, wfLabels) {
  const precise = membersFromState(stateMembers);
  if (precise.byRole.size) {
    const m = new Map();
    for (const [role, id] of precise.byRole) {
      // `byRole` 现在是**单纯的角色→id** 映射（键空间分离后不再混 id）。
      // 这道 `isAgentIdLike` 只是兜底：万一有人把角色名写进了 id 槽（形如 `backend:pm`），
      // 那条映射归一后的 role 就是角色名本身，跳过它比把它当成一条"角色=角色名"的映射安全。
      if (isAgentIdLike(role)) continue;
      const hit = subs.find((s) => String(s.id || '') === id);
      if (hit) m.set(role, hit);
    }
    return m;
  }
  return mapRoleToSub(subs, wfLabels);
}

/**
 * R12（F-1 · P0 跨 run 成员串号）+ R17（先过滤、后映射）：
 * 只允许**能证明属于本 run** 的候选进入角色映射与 `STATE.members`。
 *
 * 实测事故：新 run 创建后 50 秒内，`/state` 的「派工即登记」把**上一个 run** 的 8 条成员
 * 逐字写进了本 run 的 `STATE.json`（revision 2），而本 run 当时还没派工。链路：
 * `buildRoleSubMap` 的精确路径因 `members=[]` 落空 ⇒ 回退 `mapRoleToSub(subs, wfLabels)`，
 * 而 `wfLabels = workflowChildLabels(ctx, peopleSid)` 是**会话级**的（同一会话里前一个 run 的
 * 扇出全在里面）；`workflowChildMeta` 明明返回了 `runId`，却只按 label 认角色、从不用 runId 过滤。
 *
 * R17（QA 的 SG-B/F1l）：**过滤必须发生在角色映射之前**。旧顺序是「先 `mapRoleToSub` 再过滤」，
 * 而 `mapRoleToSub` 是同角色**先到先占**（`if (!m.has(role))`）、过滤又**只删不补** ⇒ 当会话索引里
 * **外 run 的同角色腿排在前面**时，本 run 自己的腿根本没进映射，永远注册不上（实测 `members=[]`、
 * `pm.active=false`）—— 而那正是真实事故的 subs 顺序（旧 run 的 8 条腿在前）。
 * 本函数因此收/发**候选列表**（不做角色归一），并按创建时间升序返回 ⇒ 调用方随后做
 * `mapRoleToSub` 时，「先到先占」就等价于「同角色取**创建更早**者」（与 `membersFromState`
 * 的 first-dispatch-wins 一致）。
 *
 * 两道过滤，**一道都过不了 ⇒ 一律不采纳**（空 members 远好过串号）：
 *   ① 有 wfLabel 的候选：仅当**归域命中**才采纳 —— `wfLabels[id].runId === runId`（宿主 UUID，与团队 runId 不同命名空间，实际恒不相等）**或** `wfLabels[id].runDir === runId`（workflow 脚本里抽出的 `team/<slug>`）；两者都取不到/不等 ⇒ 拒。
 *   ② 无 wfLabel 的候选（persist 模式角色工具派出的成员）：`parentSession === 本 run 归属会话`
 *      **且** `createdAt >= 本 run 创建时刻`（任一取不到就拒）。
 * 已登记 run（`STATE.members` 非空 ⇒ 走精确路径）不进这里，二次轮询不会丢成员。
 *
 * @param {Array<{id?: string}>} subs 候选子代理（**未做角色映射**）
 * @param {{wfLabels?: Map, runId?: string, ownerSession?: string, runCreatedAt?: number, timingOf?: Map|Object}} opts
 * @returns {{list: Array, rejected: number, rejectedIds: string[]}} list 按创建时间升序
 */
function filterRunScopedSubs(subs, opts = {}) {
  const picked = [];
  const rejectedIds = [];
  const o = opts && typeof opts === 'object' ? opts : {};
  const wfLabels = (o.wfLabels instanceof Map) ? o.wfLabels : new Map();
  const runId = String(o.runId ?? '');
  const ownerSession = String(o.ownerSession ?? '');
  const runCreatedAt = Number(o.runCreatedAt) || 0;
  let timing = new Map();
  if (o.timingOf instanceof Map) timing = o.timingOf;
  else if (o.timingOf && typeof o.timingOf === 'object') timing = new Map(Object.entries(o.timingOf));
  const reject = (id) => { if (id) rejectedIds.push(id); };
  for (const sub of (Array.isArray(subs) ? subs : [])) {
    const id = String((sub && sub.id) || '');
    if (!id) continue;
    const wf = wfLabels.get(id);
    if (wf) {
      // ① 会话级 label 必须收窄到本 run：`runId`（宿主 UUID，恒不等于目录名）**或** `runDir`（workflow 脚本里的 `team/<slug>`）。
      //    取不到 runDir ⇒ 行为与从前逐字一致（拒），故外 run 仍被拒、不放松 R12 的串号防线。
      const sameRun = String(wf.runId || '') === runId || (String(wf.runDir || '') !== '' && String(wf.runDir) === runId);
      if (runId && sameRun) picked.push({ sub, at: Number(wf.startedAt) > 0 ? Number(wf.startedAt) : Number.MAX_SAFE_INTEGER });
      else reject(id);
      continue;
    }
    // ② 无 label：父会话 + 创建时间双证（缺一即拒）
    const t = timing.get(id) || {};
    const parentId = String(t.parentId || t.parentSession || '');
    const createdAt = Number(t.createdAt) || 0;
    if (ownerSession && parentId && parentId === ownerSession && runCreatedAt > 0 && createdAt >= runCreatedAt) picked.push({ sub, at: createdAt });
    else reject(id);
  }
  // 创建时间升序（时间不可考的排最后，不得抢在有据可查的候选前面）；sort 稳定 ⇒ 同刻保持原顺序。
  picked.sort((a, b) => a.at - b.at);
  return { list: picked.map((x) => x.sub), rejected: rejectedIds.length, rejectedIds };
}

/**
 * 本 run 的创建时刻（ms epoch），供 R12 第 ② 道过滤用。
 * 优先 `team/<runId>/ROSTER.json · createdAt`（脚手架写入、之后不再变），退 `team/<runId>/STATE.json` 的文件时间。
 * **取不到就返回 0** —— 调用方据此拒绝采纳（宁可空 members，不可串号）。
 */
async function runCreatedAtMs(runDir) {
  try {
    const roster = await readJsonSafe(join(String(runDir ?? ''), 'ROSTER.json'));
    const t = Date.parse(String((roster && roster.createdAt) || ''));
    if (Number.isFinite(t) && t > 0) return t;
  } catch { /* fallthrough */ }
  try {
    const st = await stat(join(String(runDir ?? ''), 'STATE.json'));
    const ms = Number(st.birthtimeMs) || Number(st.mtimeMs) || 0;
    if (ms > 0) return ms;
  } catch { /* fallthrough */ }
  return 0;
}






// ── G 线：档位**选择门**的软硬开关 ─────────────────────────────────────────────
//
// `soft`（默认）：建 run 时按项目规模与目标**建议**一个档位并先生效，浮层同时给三选一。
//   选它的理由是本轮刚立的 E1 硬规则：run 开始 **10 分钟内必须产出可运行骨架**——
//   卡在"等用户选档位"会让用户不在场时**更慢**，与他"先服务我自己"的诉求相反。
// `hard`：**不选不开工** —— 建 run 但不派工，等用户在浮层点完三选一才投递派工消息
//   （与 `--confirm` 同一套机制：`pendingDecision` + `/decide` 投递）。
//
// 配置优先级 **config > env > 默认**（与两套 limits 同语义，每次 `apply` 重算 ⇒ 无粘性）。
const DEFAULT_TIER_GATE = 'soft';
const TIER_GATE_VALUES = ['soft', 'hard'];
const TIER_GATE_ENV = 'DSH_EXPERT_TEAM_TIER_GATE';
let TIER_GATE = DEFAULT_TIER_GATE;

// ── lead 工具面收窄的开关（2026-09-14 加）──────────────────────────────────────
// 为什么需要它：A 线的"把执行类工具从 lead 手上拿走"此前因一个 bug **从未真正生效**
// （清单取错作用域，见 lib/lead-toolface.js）。修好之后它会立刻改变日常使用形态 ——
// lead（含正在跟你对话的那个）不再持有 bash/write/edit/grep/glob，执行全部落到角色子代理。
// 这是设计意图，但**没有开关的行为变更不该只留给用户一个"忍着或回退版本"**。
// 优先级与档位门完全一致：**config > env > 设置控制台 > 内置默认（on）**。
const DEFAULT_LEAD_TOOLFACE = 'on';
const LEAD_TOOLFACE_VALUES = ['on', 'off'];
const LEAD_TOOLFACE_ENV = 'DSH_EXPERT_TEAM_LEAD_TOOLFACE';
let LEAD_TOOLFACE = DEFAULT_LEAD_TOOLFACE;

/** 解析 lead 工具面收窄开关（非法值一律回默认 on —— 与档位门同理，不猜不报错）。 */
function resolveLeadToolFace(config, base) {
  const cfgRaw = String((config && typeof config === 'object' && config.leadToolFace) || '').trim().toLowerCase();
  const envRaw = String(((typeof process !== 'undefined' && process.env) || {})[LEAD_TOOLFACE_ENV] || '').trim().toLowerCase();
  const baseRaw = String((base && typeof base === 'object' ? base.leadToolFace : base) || '').trim().toLowerCase();
  LEAD_TOOLFACE = LEAD_TOOLFACE_VALUES.includes(cfgRaw) ? cfgRaw
    : (LEAD_TOOLFACE_VALUES.includes(envRaw) ? envRaw
      : (LEAD_TOOLFACE_VALUES.includes(baseRaw) ? baseRaw : DEFAULT_LEAD_TOOLFACE));
  return LEAD_TOOLFACE;
}

// ── 振荡检测（C 线收窄版）的开关：**把接错的源接回来**（2026-09-15，1.3.2）─────────
// 事实（两轮独立只读核验，含全库 grep 与应用内实测）：行为在、模块能力也在
// （`loop-guard.test.mjs` 已证明 `{enabled:false}` 完全放行），但**设置值从未被读** ——
// 真正决定开关的是 `config.loopGuard.enabled`，而默认 bundle 的 `cordis.patch.yml` 两条 insert
// 行都没有 config 字段 ⇒ 用户在设置页勾那个"振荡检测"复选框**没有任何效果**。
// 这里按 tierGate/leadToolFace 同一套优先级把它接上：**config > env > 设置 > 默认(on)**。
//
// ⚠️ 两个"不许造假"的细节：
//   ① 解析结果是**每次工具调用现读**的（`createLoopGuard({ enabled: () => LOOP_GUARD_ENABLED })`）。
//      本模块在构造时就把 enabled 解构成常量，若这里只传布尔值，改设置要等下次加载才生效 ——
//      那又是一个"看起来即时、其实不即时"的假象，正是本版要消灭的那一类。
//   ② 关掉时**出声一次**（照 `LEAD_TOOLFACE_OFF_LOGGED` 的纪律）：否则"我明明关了"与
//      "开关没生效"看起来一模一样。
const DEFAULT_LOOP_GUARD = true;
const LOOP_GUARD_ENV = 'DSH_EXPERT_TEAM_LOOP_GUARD';
let LOOP_GUARD_ENABLED = DEFAULT_LOOP_GUARD;
let LOOP_GUARD_OFF_LOGGED = false;

/** 布尔开关的容错解析：只认 `false`/`0`/`off` 与 `true`/`1`/`on`，其余（含未表态）返回 undefined。 */
function parseBoolSwitch(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (s === 'false' || s === '0' || s === 'off') return false;
  if (s === 'true' || s === '1' || s === 'on') return true;
  return undefined;
}

/** 解析振荡检测开关（非法值一律回默认 on —— 与档位门同理，不猜不报错）。 */
function resolveLoopGuard(config, base) {
  const cfg = parseBoolSwitch(config && typeof config === 'object' && config.loopGuard ? config.loopGuard.enabled : undefined);
  const env = parseBoolSwitch(((typeof process !== 'undefined' && process.env) || {})[LOOP_GUARD_ENV]);
  const b = parseBoolSwitch(base && typeof base === 'object' ? base.loopGuard : base);
  LOOP_GUARD_ENABLED = cfg !== undefined ? cfg : (env !== undefined ? env : (b !== undefined ? b : DEFAULT_LOOP_GUARD));
  if (!LOOP_GUARD_ENABLED && !LOOP_GUARD_OFF_LOGGED) {
    LOOP_GUARD_OFF_LOGGED = true;
    console.log(`[expert-team] 振荡检测已关闭（${LOOP_GUARD_ENV}=false 或设置 gates.loopGuard=false）⇒ 不再拦截 A→B→A→B 来回切换`);
  }
  return LOOP_GUARD_ENABLED;
}

// ── roster 三项：命令行**未显式给出**时用设置兜底（1.3.4 接线）──────────────────────────
//
// 为什么放在"建 run 的入口"而不是解析器里：`parseTeamCommand` 是**纯解析**（拿不到设置，也不该拿 ——
// 它是被测得很细的纯函数）。把"flag 没给 ⇒ 取设置"放在 `createRun` 的**唯一落点**，才能同时覆盖
// `/team`、浮层决策、`/decide` 等所有建 run 的入口，而不是每个入口各接一遍（那就有了第二个真源）。
//
// ⚠️ 键写成**限定路径**（`roster.persist` 等）不是装饰：`settings-consumers.test.mjs` 对**歧义叶子**
// （`persist`/`deliverable`/`defaultRoles` 在本仓另有同名的不同概念，如 `mode.persist`、`--deliverable`）
// **只认限定路径**命中的消费者 —— 写成 `r.persist` 会被判成"没有消费者"，而那正是本仓最想避免的假绿。
/** 读设置的 roster 三项（键 = spec 的限定路径；值已按 spec 归一）。 */
export function rosterSettings() {
  const r = (currentSettings() || {}).roster || {};
  return {
    'roster.defaultRoles': Array.isArray(r.defaultRoles) && r.defaultRoles.length ? r.defaultRoles.slice() : null,
    'roster.deliverable': r.deliverable === 'artifacts-only' ? 'artifacts-only' : 'code+artifacts',
    'roster.persist': r.persist === true,
  };
}

/**
 * 把设置落到一次建 run 的 `mode` 上：**flag > 设置 > 常量**。
 * 纯函数（设置与常量都由参数传入）⇒ 可单测；`createRun` 只负责调用它。
 *
 * @param mode - `parseTeamCommand` 的产物（`persist`/`noCode`/`roles` 都是"flag 给了才为真/非空"）
 * @param rosterSet - `rosterSettings()` 的产物（可为 undefined）
 * @param fallbackRoles - 常量兜底班底（默认 `DEFAULT_ROLES`）
 * @returns `{ persist, noCode, roles, rolesBase, rolesFromSettings }`
 *   - `rolesBase`：**档位收窄的基线**（设置了 `defaultRoles` 就用它，否则用常量）；
 *   - `rolesFromSettings`：告知调用方"这个班底来自设置、不是用户点名" ⇒ 档位收窄仍应生效。
 */
export function resolveRosterDefaults(mode, rosterSet, fallbackRoles) {
  const m = mode && typeof mode === 'object' ? mode : {};
  const base = Array.isArray(fallbackRoles) && fallbackRoles.length ? fallbackRoles.slice() : DEFAULT_ROLES.slice();
  const settingsRoles = rosterSet && Array.isArray(rosterSet['roster.defaultRoles']) && rosterSet['roster.defaultRoles'].length
    ? rosterSet['roster.defaultRoles'].slice() : null;
  const explicitRoles = Array.isArray(m.roles) && m.roles.length ? m.roles.slice() : null;
  return {
    // 三态（1.3.5）：true = 显式要；false = **显式不要**（--one-shot / --code 压过设置）；
    // null/undefined = 未表态 ⇒ 听设置（见 command-parse.js 的三态注释）。
    persist: m.persist === true ? true : (m.persist === false ? false : Boolean(rosterSet && rosterSet['roster.persist'] === true)),
    noCode: m.noCode === true ? true : (m.noCode === false ? false : Boolean(rosterSet && rosterSet['roster.deliverable'] === 'artifacts-only')),
    roles: explicitRoles || settingsRoles,
    rolesBase: settingsRoles || base,
    rolesFromSettings: !explicitRoles && Boolean(settingsRoles),
  };
}

/** 画布 live 模式的轮询间隔（毫秒）：来自设置 `display.pollMs`（1.3.4 接线），越界回默认 3000。 */
function canvasPollMs() {
  const n = Number(((currentSettings() || {}).display || {}).pollMs);
  return Number.isFinite(n) && n >= 1000 && n <= 60000 ? Math.round(n) : 3000;
}

/**
 * 解析档位门是软还是硬。**非法值一律回默认（soft）**，不猜也不报错 ——
 * 一个拼错的开关值把流程卡死（hard）比静默放行更糟，而"卡死"正是最贵的失败模式。
 */
function resolveTierGate(config, base) {
  const cfgRaw = String((config && typeof config === 'object' && config.tierGate) || '').trim().toLowerCase();
  const envRaw = String(((typeof process !== 'undefined' && process.env) || {})[TIER_GATE_ENV] || '').trim().toLowerCase();
  // 优先级 **config > env > 设置控制台（base）> 内置默认** —— 与两套 limits 同一条纪律：
  // 用户在控制台里的偏好不该压过部署方的显式配置。
  const baseRaw = String((base && typeof base === 'object' ? base.tierGate : base) || '').trim().toLowerCase();
  TIER_GATE = TIER_GATE_VALUES.includes(cfgRaw) ? cfgRaw
    : (TIER_GATE_VALUES.includes(envRaw) ? envRaw
      : (TIER_GATE_VALUES.includes(baseRaw) ? baseRaw : DEFAULT_TIER_GATE));
  return TIER_GATE;
}




/**
 * 写侧拦截（fail loud，**禁止**静默截断）：
 * **新增**的质量类任务轮次超过上限、且没有 `pendingDecision` ⇒ 返回
 * `{code:'REWORK_LOOP_LIMIT', id, actual, limit, message}`；合规返回 `null`。
 * 调用方（`/plugins/dsh-expert-team/plan` 与 `/plan/approve`）命中即返回错误响应、**不写盘** ——
 * 与 `capacityViolations` **同一校验点、同一风格**。
 *
 * `input.tasks` = 待写入的任务表（与 `capacityViolations` 同形）；
 * `input.existingTasks` = **磁盘现有** TASKS.json 的任务快照（判定"新增"的依据）。
 * 缺省视为**空表**（候选全按"新增"判）：**看不见磁盘就无法证明它是更新**，而放行一个第 N+1 轮
 * 正是本门禁要拦的事；两个调用点都显式传入。
 * **原地更新**（id 已存在）不拦 —— 那不是"又开一轮"，是同一轮的结果回写。
 */
function reworkLoopWriteGuard(input, state, limits) {
  if (state && state.pendingDecision) return null; // 已升级用户 ⇒ 允许继续（这正是"到顶的正确动作"）
  const lim = { ...ROUND_LIMITS, ...(limits || {}) };
  const tasks = Array.isArray(input && input.tasks) ? input.tasks : [];
  const existing = Array.isArray(input && input.existingTasks) ? input.existingTasks
    : (Array.isArray(input && input.existing) ? input.existing : []);
  const onDisk = new Set(existing.map((t) => String((t && t.id) || '')).filter(Boolean));
  for (const t of tasks) {
    if (!isQualityTask(t)) continue;
    const kind = String((t && t.kind) || '');
    const rawId = String((t && t.id) || '');
    // R23（FIND-7）：**无 id 的质量任务一律按"新增"处理** —— 它没法和磁盘比对，而放行它等于给
    // 手写的 `STATE.draft`（`/plan/approve` 吃的正是可被文件工具手写的草稿）留一条绕过写侧闸门的路。
    // 有 id 且在盘上 ⇒ 原地更新（同一轮的结果回写），不拦。
    if (rawId && onDisk.has(rawId)) continue;
    const n = roundOf(t);
    const m = lim[ROUND_LIMIT_OF_KIND[kind]];
    if (!Number.isFinite(m) || n <= m) continue;
    const id = rawId || '(no-id)';
    return {
      code: 'REWORK_LOOP_LIMIT', id, actual: n, limit: m,
      message: `任务 [${id}] 第 ${n} 轮超过上限 ${m}（REWORK_LOOP_LIMIT）—— 未落盘；请先写 STATE.pendingDecision 升级用户（或调高 config.limits.maxReviewRounds/maxTestRounds）`,
    };
  }
  return null;
}

// ── /team task / 浮层任务操控 shared state mutation ────────────────────────
const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'done', 'completed', 'failed', 'cancelled', 'rework', 'blocked'];
/** "在飞"状态：任务已被领取/在做，但还没到终态。 */
const IN_FLIGHT_STATUSES = ['claimed', 'in_progress'];

/**
 * L3-2′（最小版 · 可发现）：找出**搁浅任务** —— 冷启动后永远不会有人来做的在飞任务。
 *
 * 为什么需要：进程重启 / 会话关闭后，原本在跑的成员已经不在了，而 `TASKS.json` 里
 * 仍是 `claimed` / `in_progress`。这些任务**不会自己动**，也**没有任何信号**：
 * `resumeRun` 只做三件事（查 quota / 写日志 / followup 一句），**根本不核对在飞任务**。
 * 后果与 `N-5 搁浅 run` 同源 —— 只是粒度从 run 落到 task。
 *
 * 判定（**不臆造**，纯函数）：
 *   stranded = 状态 ∈ {claimed, in_progress} 且其 `owner` 角色**当前没有任何活着的子代理**
 * `liveRoles` 为空集是**合法输入**（冷启动瞬间就是空的）——此时所有在飞任务都算搁浅，
 * 这正是事实。调用方若拿不到活跃信息，应当**不调用**本函数，而不是传一个假的非空集。
 */
function strandedTasks(tasks, liveRoles, opts) {
  const o = opts || {};
  const live = liveRoles instanceof Set ? liveRoles : new Set(Array.isArray(liveRoles) ? liveRoles : []);
  const out = [];
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (!t || typeof t !== 'object') continue;
    if (!IN_FLIGHT_STATUSES.includes(t.status)) continue;
    const owner = roleNorm(t.owner);
    if (owner && live.has(owner)) continue; // 还有人在做 → 不算搁浅
    out.push({
      id: String(t.id || ''),
      owner,
      status: String(t.status || ''),
      attempt: Number.isFinite(t.attempt) ? t.attempt : null,
      round: Number.isFinite(t.round) ? t.round : null,
      // 有 owner 但没人活着 = 成员没了；无 owner = 任务根本没派给人
      because: owner ? `owner ${owner} 当前无存活子代理` : '任务没有 owner',
    });
  }
  return out;
}

/**
 * L3-2′（可清算）：把搁浅任务**清回可再派**的状态（纯函数，不改入参）。
 *
 * 清算口径刻意保守：
 *   · 状态回 `pending`（不是 failed —— 它没失败，只是没人做；也不是 blocked —— 没有外部阻塞）
 *   · `attempt + 1`（这是一次新的尝试，与 SKILL 的 attempt 语义一致）
 *   · 追加 `strandedAt` / `strandedFrom`，并把原因写进 `note` —— **留痕，不静默抹掉历史**
 * 返回 `{tasks, settled}`；`settled` 为空时调用方**不要写盘**。
 */
function settleStranded(tasks, stranded, opts) {
  const o = opts || {};
  const at = String(o.at || new Date().toISOString());
  const reason = String(o.reason || '冷启动搁浅清算');
  const ids = new Set((Array.isArray(stranded) ? stranded : []).map((s) => String((s && s.id) || s || '')).filter(Boolean));
  const settled = [];
  const out = (Array.isArray(tasks) ? tasks : []).map((t) => {
    if (!t || typeof t !== 'object') return t;
    if (!ids.has(String(t.id || ''))) return t;
    const prev = String(t.status || '');
    settled.push({ id: String(t.id || ''), from: prev, to: 'pending' });
    const note = String(t.note || '');
    return {
      ...t,
      status: 'pending',
      attempt: (Number.isFinite(t.attempt) ? t.attempt : 0) + 1,
      strandedAt: at,
      strandedFrom: prev,
      note: (note ? note + ' | ' : '') + `${reason}（原状态 ${prev}，已清回 pending 待重派）`,
    };
  });
  return { tasks: out, settled };
}


/**
 * O2 任务 CAS：`TASKS.json` 的**唯一**读-改-写入口（带 CAS 循环）。
 *
 * 为什么需要：载体 `must()` 本来就支持 `opts.expectedRevision`，但全仓**没有任何 TASKS.json
 * 调用点传它** ⇒ 现状只是 read-modify-write：两个写者（浮层改状态 / lead 直接写盘 /
 * `/team settle` / `migrate` / plan approve）各自读到 rev N、各自写，
 * **后写覆盖先写且无人知晓** —— 评审原话就是"静默丢更新"。
 *
 * ⚠️ 关键设计：CAS 重试必须**重放 `mutate` 函数**（对**新鲜**内容重新施加改动），
 * 而不是把手里那份过期数组再写一遍 —— 后者会把别人的改动碾掉，**比不做 CAS 更糟**。
 * 所以：
 *   ① 读文本 + 取 revision；② 施加 mutate；③ 带 `expectedRevision` 写，且 **maxAttempts:1**
 *   （**关掉载体自身的重试**：它的重试语义是"重写同一份 payload"，对本场景是错的）；
 *   ④ 撞 stale → **重读 → 重新施加 → 再写**（有限次）；⑤ 仍失败 ⇒ 抛 `TASKS_CAS_CONFLICT`。
 *
 * `mutate(json)` 返回 `{ next, result }`：`next` 是要落盘的对象（null 表示无需写入）。
 * 返回 `{ ok, result, attempts, code?, error? }`。
 */
async function mutateTasks(dir, mutate, opts) {
  const o = opts || {};
  const maxAttempts = Number.isFinite(o.maxAttempts) && o.maxAttempts > 0 ? o.maxAttempts : 3;
  const target = join(dir, 'TASKS.json');
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snap = await ARTIFACT.read(target);
    if (snap.text === null) return { ok: false, code: 'NO_TASKS', error: '缺少 TASKS.json' };
    let json = null;
    try { json = JSON.parse(snap.text) } catch { return { ok: false, code: 'BAD_JSON', error: 'TASKS.json 不是合法 JSON' } }
    const { next, result } = mutate(json) || {};
    if (next === null || next === undefined) return { ok: true, result, attempts: attempt, noop: true };
    try {
      // maxAttempts:1 → 陈旧时把错误抛给我们，由这里**重放 mutate**（而不是载体重写旧 payload）
      await ARTIFACT.must(target, next, { expectedRevision: snap.revision, maxAttempts: 1 });
      return { ok: true, result, attempts: attempt };
    } catch (e) {
      lastErr = e;
      const stale = e && (e.code === 'REVISION_STALE' || e.code === 'FS_STALE_VERSION');
      if (!stale) return { ok: false, code: (e && e.code) || 'WRITE_FAILED', error: String((e && e.message) || e) };
      // 陈旧 ⇒ 说明有人在我们读之后写了：重读、**重新施加**、再试
    }
  }
  return {
    ok: false,
    code: 'TASKS_CAS_CONFLICT',
    attempts: maxAttempts,
    error: `TASKS.json 连续 ${maxAttempts} 次写入都因并发改动而失败（有人在同时改这份任务表）：${String((lastErr && lastErr.message) || lastErr).slice(0, 120)}`,
  };
}

async function applyTaskStatus(dir, id, status, note) {
  // O2：走 CAS 入口（读-改-写带版本栅栏；陈旧时**重放**这次改动，而不是把旧表写回去）
  let found = null;
  // O12 · 依赖保护：**取消**一个任务前先检查有没有下游任务依赖它（取消会断链）。
  // 只拦 cancelled（这是最危险的终止态）；failed 不拦（失败是事实，不该被"保护"拦住）。
  const r = await mutateTasks(dir, (json) => {
    const arr = taskList(json);
    const hit = arr.find((t) => t.id === id) || arr.find((t) => String(t.id).startsWith(id));
    if (!hit) return { next: null, result: { missing: arr.slice(0, 24).map((t) => t.id) } };
    // 依赖保护（O12）：取消时检查下游。
    // 只拦 **in_progress/claimed**（正在做的任务被取消 = 断链）；
    // **已完成/已失败**的不拦（取消一个已完成的任务是历史修正，不是断链）。
    if (status === 'cancelled' && (hit.status === 'in_progress' || hit.status === 'claimed')) {
      const dependents = arr.filter((t) => Array.isArray(t.dependsOn) && t.dependsOn.some((d) => d === hit.id || String(d).startsWith(String(hit.id))));
      if (dependents.length) {
        return { next: null, result: { blockedBy: dependents.map((t) => t.id), hitId: hit.id } };
      }
    }
    found = hit;
    hit.status = status;
    return { next: { ...json, tasks: arr }, result: { id: hit.id } };
  });
  if (!r.ok) return { ok: false, text: `任务状态写入失败[${r.code}]：${r.error}` };
  if (r.result && r.result.blockedBy) return { ok: false, text: `不能取消 ${r.result.hitId}：${r.result.blockedBy.join('、')} 依赖它（先取消/改依赖）` };
  if (!r.result || r.result.missing) return { ok: false, text: `未找到任务 "${id}"（现有: ${(r.result && r.result.missing || []).join(', ')}…）` };
  await appendLog(dir, `lead:task — ${r.result.id} → ${status}${note ? `（${note}）` : ''}`);
  return { ok: true, text: `${r.result.id} → ${statusZh(status)}${note ? `（${note}）` : ''}` };
}

async function renderTaskUpdate(cwd, runArg, id, status, note) {
  if (!id || !TASK_STATUSES.includes(status)) return { kind: 'error', text: 'Usage: /team task <id> <状态> [--run <run>] [--note <原因>]（状态: ' + TASK_STATUSES.join('|') + '）' };
  const root = teamRoot(cwd);
  const dir = await pickRunDir(root, runArg);
  if (!dir) return { kind: 'error', text: '还没有 run。用 /team <task> 组队。' };
  const res = await applyTaskStatus(dir, id, status, note);
  return res.ok ? { kind: 'success', text: `已回写任务状态：${res.text}\n（/team check 会即时复核；冻结门禁依赖它）` } : { kind: 'error', text: res.text };
}

// ── /team codeindex + /team search: Qoder-style code index ─────────────────
// Builds a per-workspace symbol/word index (team/CODEINDEX.json) so keyword
// lookups are INSTANT instead of grepping the whole repo each time. Search
// scores: file-path hit (100) > symbol hit (60) > top-words hit (20).
const CODEIDX_SKIP = new Set([...SKIP_DIRS, 'team', '.devcontainer', 'browser-screenshots', '.dsh', 'docs']);
const CODEIDX_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'go', 'php', 'java', 'kt', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'sh']);
const CODEIDX_MAX_FILES = 6000;
const CODEIDX_MAX_LINES = 4000;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'import', 'export', 'function', 'async', 'await', 'return', 'const', 'let', 'var', 'class', 'new', 'null', 'true', 'false', 'undefined', 'interface', 'type', 'enum', 'struct', 'impl', 'fn', 'pub', 'use', 'super', 'self', 'static', 'void', 'int', 'string', 'number', 'boolean', 'any', 'unknown', 'never', 'if', 'else', 'while', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'throw', 'public', 'private', 'protected', 'get', 'set', 'of', 'in', 'is', 'as', 'to', 'on', 'at', 'by', 'be', 'not', 'no', 'yes', 'all', 'one', 'two', 'have', 'has', 'was', 'were', 'will', 'would', 'can', 'could', 'should' ]);
const SYM_PATTERNS = {
  js: [[/(?:export\s+|declare\s+|async\s+)*function\s+([A-Za-z_$][\w$]*)/g, 'fn'], [/(?:export\s+|declare\s+)*class\s+([A-Za-z_$][\w$]*)/g, 'class'], [/(?:export\s+|declare\s+)*const\s+([A-Za-z_$][\w$]*)\s*=/g, 'const'], [/(?:export\s+|declare\s+)*interface\s+([A-Za-z_$][\w$]*)/g, 'interface'], [/(?:export\s+|declare\s+)*type\s+([A-Za-z_$][\w$]*)\s*=/g, 'type']],
  ts: [[/(?:export\s+|declare\s+|async\s+)*function\s+([A-Za-z_$][\w$]*)/g, 'fn'], [/(?:export\s+|declare\s+)*class\s+([A-Za-z_$][\w$]*)/g, 'class'], [/(?:export\s+|declare\s+)*const\s+([A-Za-z_$][\w$]*)\s*=/g, 'const'], [/(?:export\s+|declare\s+)*interface\s+([A-Za-z_$][\w$]*)/g, 'interface'], [/(?:export\s+|declare\s+)*type\s+([A-Za-z_$][\w$]*)\s*=/g, 'type']],
  py: [[/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, 'fn'], [/^\s*class\s+([A-Za-z_]\w*)/gm, 'class']],
  go: [[/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?([A-Za-z_]\w*)/gm, 'fn'], [/^type\s+([A-Za-z_]\w*)/gm, 'type']],
  php: [[/function\s+([A-Za-z_]\w*)/g, 'fn'], [/(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/g, 'class'], [/interface\s+([A-Za-z_]\w*)/g, 'interface']],
  java: [[/(?:public|private|protected|static|final|abstract|synchronized|native)\s+(?:[\w<>[\],?.\s]+?\s+)?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?/g, 'fn'], [/\bclass\s+([A-Za-z_]\w*)/g, 'class'], [/\binterface\s+([A-Za-z_]\w*)/g, 'interface']],
  rs: [[/fn\s+([A-Za-z_]\w*)/g, 'fn'], [/\bstruct\s+([A-Za-z_]\w*)/g, 'struct'], [/\benum\s+([A-Za-z_]\w*)/g, 'enum'], [/\bimpl\s+([A-Za-z_]\w*)/g, 'impl'], [/\btrait\s+([A-Za-z_]\w*)/g, 'trait']],
  c: [[/^\s*(?:static\s+|inline\s+|const\s+|unsigned\s+|long\s+|short\s+)*[\w\s*]+?\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?/gm, 'fn'], [/\bstruct\s+([A-Za-z_]\w*)/g, 'struct'], [/\bclass\s+([A-Za-z_]\w*)/g, 'class']],
  cs: [[/^\s*(?:public|private|protected|internal|static|virtual|override|async)\s+[\w<>\[\]?,\s]+?\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?/gm, 'fn'], [/\bclass\s+([A-Za-z_]\w*)/g, 'class']],
  rb: [[/^\s*def\s+([A-Za-z_]\w*[!?]?)/gm, 'fn'], [/^\s*class\s+([A-Za-z_]\w*)/gm, 'class'], [/^\s*module\s+([A-Za-z_]\w*)/gm, 'module']],
  sh: [[/^\s*function\s+([A-Za-z_]\w*)/gm, 'fn'], [/^\s*([A-Za-z_]\w*)\s*\(\)\s*\{?/gm, 'fn']],
};

function codeidxFileExt(file) {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return '';
  return file.slice(dot + 1).toLowerCase();
}

async function walkCodeFiles(cwd) {
  const out = [];
  const stack = [cwd];
  while (stack.length && out.length < CODEIDX_MAX_FILES) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= CODEIDX_MAX_FILES) break;
      const full = join(dir, e.name);
      const rel = full.slice(cwd.length + 1);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || CODEIDX_SKIP.has(e.name)) continue;
        stack.push(full);
      } else if (CODEIDX_EXT.has(codeidxFileExt(e.name))) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

/**
 * G 线（档位）：建 run 前的**廉价规模探测** —— 只 `stat`，**不读文件内容**。
 *
 * 为什么不数"行数"：数行要读每个文件全文，而这是**建 run 的关键路径**（用户点了 `/team`
 * 在等）。本仓已在别处实测过"串行读盘 30 秒级"的代价，不值得为一个建议档位付这个钱。
 *
 * 边界（如实）：文件数超过 `PROBE_MAX_STAT` 时**不再逐个 stat**，直接按"大项目"处理
 * （`capped: true`）—— 大项目反正不会进快速档，继续统计只是浪费。
 *
 * @returns `{ fileCount, totalBytes, capped }`；探测失败返回全 `null`（⇒ `suggestTier` 取标准档，不猜小）。
 */
const PROBE_MAX_STAT = 800;

async function probeProjectSize(cwd) {
  try {
    const files = await walkCodeFiles(cwd);
    if (files.length > PROBE_MAX_STAT) return { fileCount: files.length, totalBytes: null, capped: true };
    let totalBytes = 0;
    for (const rel of files) {
      try { totalBytes += (await stat(join(cwd, rel))).size; } catch { /* 竞态删除：忽略 */ }
    }
    return { fileCount: files.length, totalBytes, capped: files.length >= CODEIDX_MAX_FILES };
  } catch {
    return { fileCount: null, totalBytes: null, capped: false };
  }
}

function symbolsFrom(lang, text) {
  const out = [];
  const pats = SYM_PATTERNS[lang] || SYM_PATTERNS.js;
  const lines = text.split('\n');
  const maxLines = Math.min(lines.length, CODEIDX_MAX_LINES);
  for (let i = 0; i < maxLines; i++) {
    const line = lines[i];
    if (!line || line.length > 300) continue;
    for (const [re, kind] of pats) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m && m[1]) { out.push({ kind, name: m[1], line: i + 1 }); break; }
    }
  }
  return out;
}

function topWordsFrom(text) {
  const freq = new Map();
  const re = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
  let m;
  while ((m = re.exec(text)) && freq.size < 4000) {
    const w = m[0].toLowerCase();
    if (w.length < 4 || STOP_WORDS.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map((x) => x[0]);
}

let lastIdxCheckAt = 0;
// Light staleness probe: walk file paths, compare mtime/size against the index
// (NOT re-reading contents). Throttled 60s; rebuilds when anything changed or
// the index is older than IDX_STALE_MS — so /team search is always fresh.
const IDX_STALE_MS = 120 * 60 * 1000;
async function idxStale(cwd, idx) {
  if (Date.now() - lastIdxCheckAt < 60000) return false;
  lastIdxCheckAt = Date.now();
  if (!idx || !Array.isArray(idx.files) || !idx.builtAt) return true;
  if (Date.now() - Date.parse(idx.builtAt) > IDX_STALE_MS) return true;
  try {
    const cur = await walkCodeFiles(cwd);
    if (cur.length !== idx.files.length) return true;
    const byF = new Map(idx.files.map((f) => [f.f, f]));
    for (const rel of cur) {
      const f = byF.get(rel);
      if (!f) return true;
      const st = await stat(join(cwd, rel));
      if (Math.abs((f.mtime || 0) - st.mtimeMs) > 1 || (f.size || 0) !== st.size) return true;
    }
    return false;
  } catch { return true; }
}

async function buildCodeIndex(cwd) {
  const started = Date.now();
  let old = null;
  try { old = JSON.parse(await readFile(join(teamRoot(cwd), 'CODEINDEX.json'), 'utf8')); } catch { /* first build */ }
  const oldByF = new Map((old?.files || []).map((f) => [f.f, f]));
  const files = await walkCodeFiles(cwd);
  const out = { version: 2, builtAt: new Date().toISOString(), files: [], words: {} };
  let reused = 0, fresh = 0;
  for (const rel of files) {
    const full = join(cwd, rel);
    let mtime = 0, size = 0;
    try { const st = await stat(full); mtime = st.mtimeMs; size = st.size; } catch { continue; }
    const prev = oldByF.get(rel);
    if (prev && (prev.mtime || 0) === mtime && (prev.size || 0) === size && Array.isArray(prev.syms)) {
      // unchanged file → reuse parsed symbols + top words (incremental build)
      const w = old?.words?.[rel];
      out.files.push({ f: rel, mtime, size, syms: prev.syms });
      if (w) out.words[rel] = w;
      reused++;
      continue;
    }
    let text = '';
    try { text = await readFile(full, 'utf8'); } catch { continue; }
    const ext = codeidxFileExt(rel);
    const lang = SYM_PATTERNS[ext] ? ext : (['mjs', 'cjs', 'jsx', 'vue', 'svelte'].includes(ext) ? 'js' : '');
    out.files.push({ f: rel, mtime, size, syms: lang ? symbolsFrom(lang, text) : [] });
    if (lang) out.words[rel] = topWordsFrom(text);
    fresh++;
  }
  const root = teamRoot(cwd);
  await mkdir(root, { recursive: true });
  const p = join(root, 'CODEINDEX.json');
  await ARTIFACT.must(p, JSON.stringify(out));
  const nSym = out.files.reduce((n, f) => n + f.syms.length, 0);
  return { path: p, files: out.files.length, syms: nSym, words: Object.keys(out.words).length, ms: Date.now() - started, reused, fresh };
}

async function searchCodeIndex(cwd, kw, limit = 24) {
  const p = join(teamRoot(cwd), 'CODEINDEX.json');
  let idx = null;
  try { idx = JSON.parse(await readFile(p, 'utf8')); } catch { /* missing → build below */ }
  const built = idx == null;
  if (!built) {
    // freshness: rebuild (incrementally) when files changed / index too old
    try { if (await idxStale(cwd, idx)) await buildCodeIndex(cwd); } catch { /* keep old index */ }
    try { idx = JSON.parse(await readFile(p, 'utf8')); } catch { idx = null; }
  }
  if (!idx) {
    await buildCodeIndex(cwd);
    await new Promise((r) => setTimeout(r, 0)); // let the write settle
    try { idx = JSON.parse(await readFile(p, 'utf8')); } catch { return { hits: [], built, source: 'none' }; }
  }
  const q = String(kw || '').toLowerCase().trim();
  const qs = q.split(/\s+/).filter(Boolean);
  if (!qs.length) return { hits: [], built, source: idx.builtAt };
  const hits = [];
  const wordHit = new Set();
  for (const f of idx.files) {
    let score = 0;
    const prows = [];
    const fl = f.f.toLowerCase();
    for (const q1 of qs) {
      if (fl.includes(q1)) score += 100;
      for (const s of f.syms) {
        if (s.name.toLowerCase().includes(q1)) { score += 60; prows.push(s); }
      }
    }
    const words = idx.words[f.f] || [];
    for (const q1 of qs) { if (words.includes(q1)) { score += 20; } }
    if (score > 0) {
      const lineSym = prows[0];
      hits.push({ file: f.f, line: lineSym ? lineSym.line : 1, kind: lineSym ? lineSym.kind : 'match', name: lineSym ? lineSym.name : q, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), built, source: idx.builtAt };
}

async function renderCodeIndex(cwd) {
  const res = await buildCodeIndex(cwd);
  return {
    kind: 'success',
    text: [
      `已构建代码索引：${res.path}`,
      `- 文件 ${res.files} 个 · 符号 ${res.syms} 个 · 词频 ${res.words} 个 · 用时 ${res.ms}ms${res.reused ? `（增量复用 ${res.reused} 个未变文件）` : ''}`,
      `- 用法：\`/team search <关键词>\` 秒级命中（路径 100 > 符号 60 > 高频词 20）；浮层「代码索引」搜索框同源；索引超 2h 或文件变更会自动增量重建。`,
      `- 刷新：项目变更后重跑 /team codeindex。`,
    ].join('\n'),
  };
}

async function renderSearch(cwd, kw) {
  if (!kw) return { kind: 'error', text: 'Usage: /team search <关键词>' };
  const { hits, built, source } = await searchCodeIndex(cwd, kw);
  if (!hits.length) return { kind: 'success', text: `代码索引：未命中「${kw}」${built ? '（已临时构建索引）' : `（索引时间 ${source || '?'}）`}\n提示：确认关键词拼写，或先用 /team codeindex 构建后再搜。` };
  const lines = hits.map((h) => `- ${h.file}:${h.line}  [${h.kind}] ${h.name}  (score ${h.score})`);
  return {
    kind: 'success',
    text: [
      `代码索引：${kw} 命中 ${hits.length} 条${built ? '（索引缺失，已临时构建）' : ''}`,
      ...lines,
    ].join('\n'),
  };
}

// ── /team devcontainer: reproducible verification env (Qoder-style safety) ──
// Detect the project language from manifests and emit a minimal
// .devcontainer/devcontainer.json so test/build verify steps can run inside a
// reproducible container. Dry-run prints + snapshots into the run dir;
// `--write` also places the real config at the project root.
const DEVCONTAINER_IMAGES = [
  { match: ['package.json'], image: 'mcr.microsoft.com/devcontainers/javascript-node:20', lang: 'Node', post: 'npm install' },
  { match: ['pyproject.toml', 'requirements.txt'], image: 'mcr.microsoft.com/devcontainers/python:3.12', lang: 'Python', post: true },
  { match: ['go.mod'], image: 'mcr.microsoft.com/devcontainers/go:1.22', lang: 'Go', post: true },
  { match: ['Cargo.toml'], image: 'mcr.microsoft.com/devcontainers/rust:1', lang: 'Rust', post: true },
  { match: ['composer.json'], image: 'mcr.microsoft.com/devcontainers/php:8.3', lang: 'PHP', post: 'composer install' },
];

async function detectDevcontainer(cwd) {
  for (const d of DEVCONTAINER_IMAGES) {
    for (const f of d.match) {
      try { await readFile(join(cwd, f)); return d; } catch { /* next */ }
    }
  }
  return { image: 'mcr.microsoft.com/devcontainers/base:ubuntu', lang: '通用', post: null };
}

function devcontainerJson(det) {
  const cfg = {
    name: 'expert-team verify env',
    image: det.image,
    postCreateCommand: det.post === true ? '' : det.post || '',
    customizations: { vscode: { settings: {}, extensions: [] } },
  };
  if (!cfg.postCreateCommand) delete cfg.postCreateCommand;
  return JSON.stringify(cfg, null, 2) + '\n';
}

async function renderDevcontainer(cwd, write, runArg) {
  const det = await detectDevcontainer(cwd);
  const cfgText = devcontainerJson(det);
  const root = teamRoot(cwd);
  const dir = await pickRunDir(root, runArg || null);
  // snapshot into the run dir so it appears in chat as a clickable artifact
  if (dir) {
    try { await ARTIFACT.must(join(dir, 'DEVCONTAINER.json'), cfgText); } catch { /* run dir unwritable */ }
  }
  if (write) {
    const target = join(cwd, '.devcontainer', 'devcontainer.json');
    await mkdir(join(cwd, '.devcontainer'), { recursive: true });
    await ARTIFACT.must(target, cfgText);
    return {
      kind: 'success',
      text: [
        `已写入可复现校验环境：${target}`,
        `- 语言：${det.lang} · 镜像：${det.image}`,
        `- 用法：VS Code「Reopen in Container」/ \`devcontainer up\`，在容器内跑 test/build 作为 verify 证据。`,
        `- 没装容器环境的机器：在受控 shell 跑 verify 并记录结果（EFFICIENCY §11 安全守界）。`,
      ].join('\n'),
    };
  }
  return {
    kind: 'success',
    text: [
      `可复现校验环境（Dry-run，未写入项目根）：${det.lang} · ${det.image}`,
      '',
      '配置预览：',
      '```json',
      cfgText.trimEnd(),
      '```',
      '',
      `- 写入：\`/team devcontainer --write\` 生成 <cwd>/.devcontainer/devcontainer.json（已同步快照到 ${dir ? '最新 run 目录的 DEVCONTAINER.json' : '（无 run 目录）'}）。`,
      `- 用法：VS Code「Reopen in Container」/ \`devcontainer up\`，在容器内跑 verify 作为交付证据。`,
      `- 没装容器环境的机器：在受控 shell 跑 verify 并记录结果（EFFICIENCY §11 安全守界）。`,
    ].join('\n'),
  };
}

// ── /team migrate <run>: upgrade an OLD-schema run's TASKS.json to the new
//    schema so it can use quality gates + the scheduler. Old tasks keep working
//    (kind=work) but gain kind/attempt/round/verdict/findings/verify/changedPaths.
const OWNER_KIND = { backend: 'implementation', frontend: 'implementation', reviewer: 'review', qa: 'verification', pm: 'requirements', researcher: 'research', architect: 'design' };
function migrateTask(t) {
  const o = { ...t };
  if (!o.kind) o.kind = OWNER_KIND[o.owner] || 'work';
  if (o.status === 'in-progress') o.status = 'in_progress';
  if (o.status === 'todo') o.status = 'pending';
  if (o.attempt === undefined) o.attempt = 0;
  if (o.attemptId === undefined) o.attemptId = null;
  if (o.round === undefined) o.round = 1;
  if (o.verdict === undefined) o.verdict = null;
  if (!Array.isArray(o.findings)) o.findings = [];
  if (!Array.isArray(o.verify)) o.verify = [];
  if (!Array.isArray(o.changedPaths)) o.changedPaths = [];
  return o;
}

/**
 * `STATE.json.coverage` 的**按元素形状**归一（纯函数，便于单测）。
 *
 * 缺陷（2026-09-11 实测触发）：本 run 的 `coverage` 是 `["pm","architect",…]`
 * （角色名字符串数组）—— **它本身就是一个数组**，于是 `migrateRun` 里那句
 * `if (!Array.isArray(state.coverage)) state.coverage = []` **直接放行**：
 * 用户在 `/team check` 看到「先 /team migrate」的提示，**跑了也修不好**（migrate 的判据比 guard 弱）。
 *
 * 归一策略：**不臆造** `{constraint:…}` —— 角色名不是「约束」。把原值挪到 `coverageLegacy` 留档、
 * 把 `coverage` 置空，并回报"为什么改、丢了几条"，做到可审计而非静默。
 * 返回 `{coverage, coverageLegacy?, changed, note}`；`changed === false` 时调用方不必动它。
 */
function normalizeCoverage(coverage) {
  const bad = Array.isArray(coverage)
    ? coverage.filter((c) => c === null || typeof c !== 'object' || Array.isArray(c))
    : null;
  if (Array.isArray(coverage) && bad.length === 0) {
    return { coverage, changed: false, note: 'coverage 已是合规形状，未改动' };
  }
  const out = { coverage: [], changed: true };
  if (coverage !== undefined) out.coverageLegacy = coverage;
  out.note = Array.isArray(coverage)
    ? `coverage 的元素形状不合规（${bad.length} 条，如 ${JSON.stringify(bad[0]).slice(0, 40)}）—— 已置空并把原值留档到 coverageLegacy（角色名不是「约束」，不臆造映射）`
    : 'coverage 已补为 []';
  return out;
}

async function migrateRun(cwd, run) {
  const dir = join(teamRoot(cwd), run);
  const tasks = await readJsonSafe(join(dir, 'TASKS.json'));
  if (!tasks) return { kind: 'error', text: `未找到 run "${run}" 或缺少 TASKS.json。用 /team status 查看 runId。` };
  const arr = taskList(tasks).map(migrateTask);
  // O2：migrate 也走 CAS —— 它与面板改状态 / lead 写盘 / settle 抢同一份 TASKS.json，
  // 不带版本栅栏的直写会把对方刚做的改动碾掉。
  const mr = await mutateTasks(dir, (json) => ({ next: { ...json, tasks: taskList(json).map(migrateTask) }, result: null }));
  if (!mr.ok) return { kind: 'error', text: `TASKS.json 写入失败[${mr.code}]：${mr.error}` };
  const state = await readJsonSafe(join(dir, 'STATE.json'));
  let coverageNote = '';
  if (state) {
    // ⚠️ 必须按**元素形状**归一，不能只判 Array.isArray（真实脏数据本身就是数组，旧判据放行）。
    const covFix = normalizeCoverage(state.coverage);
    if (covFix.changed) {
      if (covFix.coverageLegacy !== undefined) state.coverageLegacy = covFix.coverageLegacy;
      state.coverage = covFix.coverage;
    }
    coverageNote = covFix.note;
    await ARTIFACT.must(join(dir, 'STATE.json'), state);
  }
  await appendLog(dir, `run:migrated — 旧 schema 升级到新 schema（${arr.length} 任务补 kind/attempt/round/verdict/findings/verify/changedPaths + ${coverageNote}）`);
  return {
    kind: 'success',
    text: [
      `已迁移 run "${run}"：`,
      `- ${arr.length} 个任务补齐新 schema 字段（kind 按 owner 映射：backend/frontend→implementation、reviewer→review、qa→verification、researcher→research、architect→design、pm→requirements、其余→work；status 归一；补 attempt/round/verdict/findings/verify/changedPaths）。`,
      `- STATE.json：${coverageNote}。`,
      `- 现在可用 /team resume "${run}" 以**新 skill + 质量门禁/自动调度**继续推进；浮层也会显示 DAG/详情/覆盖率（旧任务视为 work，无门禁时不强制 verdict）。`,
    ].join('\n'),
  };
}


/**
 * O9 · writeScopes 事前重叠告警（**执行前**就能预见撞车）。
 *
 * 背景：现在只有**完成时**按 `changedPaths` vs `inScope` 做"越界"审计（规则 11）——
 * 那是**事后**才发现"两个人改了同一个文件"。本函数在**派工前**做预防：两个任务的
 * `inScope` glob 若有重叠，**提前**在 `/team check` 里报出来，让用户在派工前调整
 * （例如把两个任务合并，或把公共文件拆给其中一方）。
 *
 * 判定口径（刻意保守，不臆造"精确集合交集"）：
 *   · 只比较两个任务各自 inScope 里的 glob 的**字面前缀**（去掉 `*` 之后的部分）；
 *   · 两个字面前缀若**互为前缀**（一个是另一个的开头）⇒ 判为"可能重叠"；
 *   · 报告为 **warning**（不是违规）：重叠有时是有意的（如 reviewer 读实现者的文件），
 *     我们不阻断，只**如实报出来**让人判断。
 *
 * 返回 `[{ a, b, reason }]`；空数组 = 无重叠（或没有 inScope 可比）。
 */
function scopeOverlapWarnings(tasks) {
  const arr = (Array.isArray(tasks) ? tasks : []).filter((t) => t && typeof t === 'object' && Array.isArray(t.inScope) && t.inScope.length);
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    for (let j = i + 1; j < arr.length; j += 1) {
      const a = arr[i], b = arr[j];
      for (const sa of a.inScope) {
        for (const sb of b.inScope) {
          const pa = String(sa).replace(/[*{[\]()?+^$|]/g, '').replace(/\/+$/, '');
          const pb = String(sb).replace(/[*{[\]()?+^$|]/g, '').replace(/\/+$/, '');
          if (!pa || !pb) continue;
          if (pa.startsWith(pb) || pb.startsWith(pa)) {
            out.push({ a: String(a.id || ''), b: String(b.id || ''), reason: `inScope 前缀重叠："${sa}" 与 "${sb}"（共同前缀 "${pa.length <= pb.length ? pa : pb}"）—— 两个任务可能写同一批文件` });
            break;
          }
        }
      }
    }
  }
  // 同一对任务只报一次（多个 scope 重叠时只保留最短的共同前缀那条）
  const seen = new Set();
  return out.filter((o) => { const k = o.a + '|' + o.b; if (seen.has(k)) return false; seen.add(k); return true; });
}




async function checkRun(cwd, runArg) {
  const root = teamRoot(cwd);
  const dir = runArg ? join(root, runArg) : await pickleLatestRunDir(root);
  if (!dir) return { kind: 'error', text: '没有 run 可检查。用 /team check <run> 指定，或用 /team status 查看 runId。' };
  const runId = basename(dir);
  const tasks = await readJsonSafe(join(dir, 'TASKS.json'));
  const state = await readJsonSafe(join(dir, 'STATE.json'));
  if (!tasks) return { kind: 'error', text: `run "${runId}" 缺 TASKS.json。` };
  const arr = taskList(tasks);
  let violations = checkTasks(arr, state?.phase, state);
  // C4：存量工件的 schema 违规也要在这里被查出来（原先只有写入那一刻会告警）
  const schemaWarns = schemaViolations(state, tasks);
  violations = violations.concat(schemaWarns);
  // E2 的**记账前提**（2026-09-13 由真实 run 点名）：漏记 `phase:review`/`phase:test` ⇒ 收尾预算
  // 算不出来。实测两次真实 run 的 clarify 都走完了却一条 phase 事件都没有 —— 机制在、采纳度不在，
  // 而"漏记"本身**没有任何地方会报**。这里把它变成 `/team check` 的可见违规（读侧只报告不阻断）。
  try {
    const logText = await readFile(join(dir, 'RUN.log.md'), 'utf8');
    violations = violations.concat(phaseAccountingViolations(logText, state && state.phase));
  } catch { /* 没有日志文件 ⇒ 不判（别把"没日志"报成"没记账"） */ }
  // 设计稿 §十二 第 2 步：工件单源化 —— 权威表校验（**只在 `AUTHORITY.md` 存在时**校验；
  // 老 run 没有这个文件，一律报「缺声明」会制造满屏假阳性 —— 而假阳性会让门禁被整体忽略）。
  try {
    const authText = await readFile(join(dir, 'AUTHORITY.md'), 'utf8');
    const dirFiles = await readdir(dir);
    const rosterRoles = (rosterForPrint && Array.isArray(rosterForPrint.roles) && rosterForPrint.roles.length)
      ? rosterForPrint.roles : KNOWN_ROLES;
    violations = violations.concat(authorityViolations({ authorityText: authText, presentFiles: dirFiles, knownRoles: rosterRoles }));
  } catch { /* 没有 AUTHORITY.md ⇒ 不判（见上） */ }
  // B2（N-8）：把「LLM 自建 run」（绕过 /team 脚手架、lead 直接 write 出来的）纳入门禁。
  // 实测真实工作区里多数 run 走这条路径，而字段漂移全部出在这里 —— 不拦就等于漏掉大部头。
  const rosterForPrint = await readJsonSafe(join(dir, 'ROSTER.json'));
  const fp = scaffoldFingerprint(state, rosterForPrint, { hasRoster: !!(rosterForPrint && Array.isArray(rosterForPrint.roles) && rosterForPrint.members) });
  if (fp.selfBuilt) {
    violations.push(`非脚手架 run（疑似绕过 /team 手写）：缺 ${fp.missing.join('、')} —— 这条路径正是字段漂移的高发区；建议用 /team <task> 建 run，或补齐上述字段`);
  }
  // L3-2′ 可发现：在飞但没人做的任务（冷启动后必然出现）。**只报不动** —— 清算要显式 `/team settle`。
  const strandedHere = strandedTasks(arr, new Set());
  if (strandedHere.length) {
    violations.push(`搁浅任务 ${strandedHere.length} 个（状态仍是 claimed/in_progress，但当前无存活成员 ⇒ 不会自己动）：${strandedHere.map((s) => s.id).join(', ')} —— 用 \`/team settle ${runId}\` 清回 pending 后重新派工`);
  }
  // O-3 读侧可见：**存量**超限 run 只报告不阻断（与 L1-4′ 同口径：旧 run 不得因新规消失）
  const capHere = capacityViolations({ roles: (await readJsonSafe(join(dir, 'ROSTER.json')))?.roles, tasks: arr });
  for (const c of capHere) violations.push(c.message);
  const warnings = checkKindWarnings(arr);
  // O9 · writeScopes 事前重叠告警：两个任务的 inScope 有交集 ⇒ 派工前就**提示**撞车风险
  // （不阻断：重叠有时是有意的，我们只如实报出来让人判断）。
  for (const w of scopeOverlapWarnings(arr)) warnings.push(`写域可能撞车：${w.a} 与 ${w.b} —— ${w.reason}`);
  // R25（SG-3 · 落点：**warnings 通道**，与 `checkKindWarnings` 同级）：V2 的"无输入"要显形 ——
  // 返工过（≥2 个非 pass 质量任务）却没有任何 finding 标题跨轮重复 ⇒ V2 无从判定，必须说出来。
  // 刻意**不进 violations**：这是"门禁没数据可吃"的事实陈述，不是这个 run 的过错（普通 run 不得被判红）。
  const reopenInputMissing = findingReopenInputMissing(arr);
  if (reopenInputMissing) warnings.push(reopenInputMissing);

  const head = [`run "${runId}"（${phaseZh(state?.phase)}/${statusZh(state?.status)}）状态机检查：`, `任务 ${arr.length} 个${arr.some((t) => t.kind) ? ' · 已用新 schema' : ' · 旧 schema（建议 /team migrate 后重查）'}`];
  const body = violations.length ? violations.map((v) => `  ❌ ${v}`) : ['  ✅ 无违规：completed 满足 verify/verdict/inScope；dependency gate 一致'];
  const warnBody = warnings.map((w) => `  ⚠ ${w}`);
  const advise = arr.filter((t) => !t.kind).length
    ? '（检测到旧 schema 任务：先 /team migrate <runId> 再 /team check <runId>，否则质量门禁不生效）'
    : '';
  // Self-optimization loop: an unfilled RETRO starves the retrospective input.
  let retro = '';
  try { retro = await readFile(join(dir, 'RETRO.md'), 'utf8'); } catch { /* missing */ }
  const retroFilled = retro.length > 0 && !(/__|（交付了什么/.test(retro));
  if ((state?.phase === 'deliver' || state?.status === 'complete') && !retroFilled) {
    violations.push('RETRO.md 仍是模板占位（deliver 复盘是自我优化的输入源——请填 结果/卡点/保持/避免/可复用经验）');
  }
  const retroNote = (state?.phase === 'deliver' || state?.status === 'complete') && !retroFilled
    ? '\n（提示：RETRO.md 未填写，已计为违规）'
    : '';
  return { kind: 'success', text: [...head, ...body, ...warnBody, advise, retroNote].filter((l) => l !== '').join('\n') };
}

// pick the most recently updated run dir under team/ (helper for check/status)
async function pickleLatestRunDir(root) {
  let names = [];
  try { names = await readdir(root); } catch { return null; }
  let best = null, bestT = 0;
  for (const n of names) {
    const s = await readJsonSafe(join(root, n, 'STATE.json'));
    const t = Date.parse(s?.updatedAt ?? '') || 0;
    if (t >= bestT) { bestT = t; best = n; }
  }
  return best ? join(root, best) : null;
}

async function readJsonSafe(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

// Resolve a session's workspace cwd (same approach dsh-md-preview uses):
// ctx.get('sessions') -> session.header.{meta.cwd|cwd}|session.{meta.cwd|cwd}.
function cwdFromSession(ctx, sessionId) {
  try {
    const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null;
    if (!sessions || !sessionId) return undefined;
    const session = sessions.get(String(sessionId));
    if (!session) return undefined;
    const h = session.header;
    const cwd = (h && h.meta && h.meta.cwd) || (h && h.cwd) || (session.meta && session.meta.cwd) || session.cwd;
    return typeof cwd === 'string' ? cwd : undefined;
  } catch { return undefined; }
}

/**
 * 由 `exec` 的**调用者**解析出角色（R1 归属门禁与并发写留痕**共用同一份**解析）。
 *
 * 来源：`STATE.members` 的 `<agentSessionId>:<role>` 行 —— 宿主在派工时自动登记
 *（"派工即登记"），所以这里不需要猜 label/事件流。
 * **认不出就返回空串**：调用方据此 fail-open（宁可漏拦，不可误伤），绝不臆造角色。
 * 角色可带后缀（`frontend-F4`、`reviewer-R1`）——原样返回，归一由查表一侧负责。
 *
 * @param ctx - 插件 ctx（用 ctx.get('sessions') 反查 cwd）
 * @param exec - 工具执行记录（`exec.agent.session` 给出调用者会话 id）
 * @param runId - 目标 run（STATE.json 所在目录名）
 * @returns {Promise<string>} 角色串；解析不出返回 `''`。
 */
async function roleOfAgent(ctx, exec, runId) {
  const sid = String(exec?.agent?.session?.id || exec?.agent?.session?.header?.id || '');
  if (!sid || !runId) return '';
  try {
    const cwd = cwdFromSession(ctx, exec?.agent?.session?.header?.id || sid)
      || String(exec?.agent?.session?.header?.cwd || '');
    if (!cwd) return '';
    const st = await readJsonSafe(join(teamRoot(cwd), runId, 'STATE.json'));
    for (const m of (st && Array.isArray(st.members)) ? st.members : []) {
      const str = String(m || '');
      const i = str.indexOf(':');
      if (i > 0 && str.slice(0, i) === sid) return str.slice(i + 1);
    }
  } catch { /* 读不到 ⇒ 空串（fail-open） */ }
  return '';
}

/**
 * 目标文件**是否已存在** —— R1 门禁的"创建放行、覆写才拦"就靠这一个判据（不需要读内容）。
 *
 * 与读文本同一套纪律：**宿主 fs 优先**（run 目录可能落在宿主虚拟路径体系里），拿不到再退 node。
 * 返回三态：`true`（在）/ `false`（明确不存在）/ `undefined`（**查不到**）。
 * 调用方必须把 `undefined` 当"不知道"而放行并留痕 —— 把"查不到"当成"不存在"会让门禁
 * 在最需要它的时候静默失效（本轮反复强调的"两种零要分得清"）。
 */
async function pathExistsFor(ctx, abs) {
  try {
    const hostFs = typeof ctx.get === 'function' ? ctx.get('fs') : null;
    if (hostFs && typeof hostFs.stat === 'function' && typeof hostFs.resolve === 'function') {
      const resolvedTarget = await hostFs.resolve(abs);
      try {
        const st = await hostFs.stat(resolvedTarget);
        if (st) return true;
        // 宿主明确说"没有"：再用 node 复核一次（宿主实现语义可能不同，宁可多问一次）
      } catch { /* 宿主抛错 ⇒ 交给 node */ }
    }
  } catch { /* 宿主解析失败 ⇒ 交给 node */ }
  try { await stat(abs); return true; }
  catch (e) { return (e && e.code === 'ENOENT') ? false : undefined; }
}

// Pick the most recently updated run under <cwd>/team.
async function pickLatestRun(cwd) {
  const root = teamRoot(cwd);
  let names = [];
  try { names = await readdir(root); } catch { return null; }
  let best = null, bestT = 0;
  for (const n of names) {
    const s = await readJsonSafe(join(root, n, 'STATE.json'));
    const t = Date.parse(s?.updatedAt ?? '') || 0;
    if (t >= bestT) { bestT = t; best = n; }
  }
  return best;
}

const ARTIFACT_NAMES = ['SPEC', 'PLAN', 'RESEARCH', 'REVIEW-SPEC', 'REVIEW', 'TEST', 'SUMMARY', 'RETRO', 'TASK', '任务看板', '画布'];
const AGENT_NAMES = ['Alex', 'Sam', 'Tina', 'Jack', 'Eric', 'Lee', 'Taylor', 'Felix', 'Jay', 'Robin', 'Jimmy', 'Bill', 'James', 'Jason', 'Eva', 'Leo', 'Mia', 'Owen', 'Zoe', 'Ivy'];
const AGENT_COLORS = ['#5b8def', '#22b07d', '#e0913c', '#d05a9c', '#7a5ef0', '#3aa6b9', '#c04f4f', '#8a7a3c'];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }

/**
 * 目标指纹（批 0-3）：用于「同目标团队」判定。
 * 归一化：小写、去空白/标点，再哈希 —— 让「做个登录页」与「做个登录页。」视为同一目标。
 * 空目标返回 ''（调用方据此跳过判定，避免误拦）。
 */
function goalKeyOf(task) {
  const norm = String(task || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？""''`（）()\[\]【】<>《》~!@#$%^&*_+=|\\/?.,;:-]+/g, '');
  return norm ? 'g' + hashStr(norm).toString(36) : '';
}

/**
 * 扫描工作区已知 run，返回与该 goalKey 匹配的、已被用户丢弃（planDiscarded）的 run。
 * 只读 STATE.json；读不到/损坏的 run 跳过（与 listRuns 的容错一致）。
 */
async function findDiscardedGoal(cwd, goalKey) {
  if (!goalKey) return null;
  const root = teamRoot(cwd);
  let names = [];
  try { names = await readdir(root); } catch { return null; }
  for (const n of names.sort()) {
    try {
      const state = await readJsonSafe(join(root, n, 'STATE.json'));
      if (!state || !state.planDiscarded) continue;
      const k = state.planDiscarded.goalKey || goalKeyOf(state.goal || '');
      if (k && k === goalKey) return { runId: n, at: state.planDiscarded.at || '', reason: state.planDiscarded.reason || '' };
    } catch { /* 跳过损坏 run */ }
  }
  return null;
}
// Stable agent identity: the SAME (run, role) always yields the SAME name + color/avatar.
function agentName(runId, role) { return AGENT_NAMES[hashStr(String(runId) + '|' + role) % AGENT_NAMES.length]; }
function agentColor(runId, role) { return AGENT_COLORS[hashStr(String(runId) + '|' + role + '#c') % AGENT_COLORS.length]; }
function agentInitial(name) { return String(name || '?').slice(0, 1).toUpperCase(); }

// Cross-workspace registry: remember every workspace a /team run was created in,
// so the live overlay can list runs across projects (not just the current cwd).
async function registryFile() { return join(dshHome(), 'expert-team', 'workspaces.json'); }
async function registerWorkspace(cwd) {
  try {
    if (!cwd) return;
    const p = await registryFile();
    let ws = [];
    try { ws = JSON.parse(await readFile(p, 'utf8')); } catch { /* fresh */ }
    if (!Array.isArray(ws)) ws = [];
    if (!ws.includes(cwd)) { ws.push(cwd); await mkdir(dirname(p), { recursive: true }); await ARTIFACT.must(p, JSON.stringify(ws, null, 2)); }
  } catch { /* best-effort */ }
}
async function registeredWorkspaces() {
  try { const w = JSON.parse(await readFile(await registryFile(), 'utf8')); return Array.isArray(w) ? w : []; } catch { return []; }
}

// List runs under a single workspace; each has a `workspace`.
// ── run 列表的**逐 run 戳缓存**（2026-09-15 性能修复 #6：冷启动）────────────────────
// 实测：重启后**第一次** `?section=summary` 的 `runs+select` 段 = 876 ms（每个 run 都要读
// STATE.json + TASKS.json 再算 health/violations/owner）。而这段数据在"run 目录没动"时**完全可复用**。
//
// 失效键 = **每个 run 自己的** `STATE.json` 与 `TASKS.json` 的 `(mtimeMs, size)`：
//   · 改一次 STATE（阶段推进/任务回写）⇒ 该 run 的戳变 ⇒ 只重算**那一个** run；
//   · 新增 run ⇒ 缓存里没有 ⇒ 计算并写入（**新 run 一律可见**，这是功能不是可牺牲项）；
//   · 删 run ⇒ readdir 里没有 ⇒ 不会被读出（顺带在保存时剪掉）。
// ⚠️ 为什么**不能**只戳 run 目录：改文件**不会**改父目录 mtime（只有增删条目会）⇒ 那样会读到旧
// 阶段/旧 done 数。戳到文件本身才是"看到的就是真的"。
// 落盘（$DSH_HOME/expert-team/runs-index.json）是为了**重启后第一次**也不必从零算：本进程只需
// stat 校验 + 命中；没有索引文件的那一次仍要算一遍（这是它的性质，如实记档）。
const RUNS_INDEX_MAX = 500;
let RUNS_INDEX = null;           // Map<absRunDir, {stamp, row}>
let RUNS_INDEX_LOAD = null;      // 载入中的 promise（同刻只读一次盘）
let RUNS_INDEX_SAVE_TIMER = null;
const RUNS_INDEX_STATS = { hits: 0, misses: 0, loads: 0, saves: 0, saveErrors: 0, computes: 0 };
/**
 * 索引文件位置。可用 `DSH_EXPERT_TEAM_RUNS_INDEX` 覆盖 —— 两个用途：
 *   ① 测试（沙箱里 `~/.dsh` 可能不可写，指到临时目录即可做完整往返验证）；
 *   ② 运维（把索引放到更快的盘/容器可写卷）。
 */
function runsIndexPath() {
  const override = String((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_RUNS_INDEX) || '').trim();
  return override || join(dshHome(), 'expert-team', 'runs-index.json');
}
async function loadRunsIndex() {
  if (RUNS_INDEX) return RUNS_INDEX;
  if (RUNS_INDEX_LOAD) return RUNS_INDEX_LOAD;
  RUNS_INDEX_STATS.loads += 1;
  RUNS_INDEX_LOAD = (async () => {
    let entries = {};
    try {
      const raw = await readFile(runsIndexPath(), 'utf8');
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') entries = j.entries;
    } catch { /* 没有索引 / 坏了 ⇒ 空表（下次保存自愈）*/ }
    RUNS_INDEX = new Map(Object.entries(entries).filter(([, v]) => v && typeof v.stamp === 'string' && v.row && typeof v.row === 'object'));
    return RUNS_INDEX;
  })();
  try { return await RUNS_INDEX_LOAD; } finally { RUNS_INDEX_LOAD = null; }
}
function scheduleRunsIndexSave() {
  if (RUNS_INDEX_SAVE_TIMER) return;
  RUNS_INDEX_SAVE_TIMER = setTimeout(() => {
    RUNS_INDEX_SAVE_TIMER = null;
    (async () => {
      try {
        const map = RUNS_INDEX || new Map();
        // 剪枝：按 map 的插入顺序保留最近 RUNS_INDEX_MAX 条（Map 保序 ⇒ 旧的先丢）
        const entries = {};
        const keys = [...map.keys()];
        for (const k of keys.slice(Math.max(0, keys.length - RUNS_INDEX_MAX))) entries[k] = map.get(k);
        // 写盘走**宿主状态文件的单一受控入口**（同目录临时文件 + fsync + rename + 0600）：
        // 这一类路径（`$DSH_HOME/expert-team/runs-index.json`，**工作区之外**）既不该套工作区工件的
        // artifact-writer 语义，也不该在别处再抄一份"临时文件 + 换名"——分类与证据见该模块文件头。
        await writeHostStateFileAtomic(runsIndexPath(), JSON.stringify({ version: 1, entries }));
        RUNS_INDEX_STATS.saves += 1;
      } catch { RUNS_INDEX_STATS.saveErrors += 1; /* 索引写不进去只是下次多算一遍，绝不影响功能 */ }
    })();
  }, 1500);
  if (RUNS_INDEX_SAVE_TIMER && typeof RUNS_INDEX_SAVE_TIMER.unref === 'function') RUNS_INDEX_SAVE_TIMER.unref();
}
/** 仅供测试：丢内存索引并复位计数（不清盘上的索引文件）。 */
function _resetRunsIndex() {
  RUNS_INDEX = null; RUNS_INDEX_LOAD = null;
  if (RUNS_INDEX_SAVE_TIMER) { clearTimeout(RUNS_INDEX_SAVE_TIMER); RUNS_INDEX_SAVE_TIMER = null; }
  RUNS_INDEX_STATS.hits = 0; RUNS_INDEX_STATS.misses = 0; RUNS_INDEX_STATS.loads = 0;
  RUNS_INDEX_STATS.saves = 0; RUNS_INDEX_STATS.saveErrors = 0; RUNS_INDEX_STATS.computes = 0;
}
async function fileStampOf(p) {
  try { const st = await stat(p); return Math.round(Number(st.mtimeMs) || 0) + ':' + (Number(st.size) || 0); }
  catch { return null; }
}
/** 单个 run 的列表行：戳没变就复用缓存（落盘索引 ⇒ 重启后第一次也能命中）。 */
async function cachedRunRow(ws, dir, n) {
  await loadRunsIndex();
  const statePath = join(dir, 'STATE.json');
  const stampState = await fileStampOf(statePath);
  const stampTasks = await fileStampOf(join(dir, 'TASKS.json'));
  const stamp = stampState + '|' + stampTasks;
  const rec = RUNS_INDEX.get(dir);
  // 缺 STATE.json 时（stampState === null）**不进缓存**：坏 run 每次如实重算，代价是一次失败的读。
  if (rec && stampState !== null && rec.stamp === stamp) { RUNS_INDEX_STATS.hits += 1; return { ...rec.row }; }
  RUNS_INDEX_STATS.misses += 1;
  const st0 = stampState === null ? null : await readJsonSafe(statePath);
  let row;
  if (st0) {
    const tasks0 = taskList(stampTasks === null ? null : await readJsonSafe(join(dir, 'TASKS.json')));
    const done0 = tasks0.filter((t) => ['completed', 'done'].includes(t.status)).length;
    const owners = new Set((tasks0.map((t) => t.owner)).filter(Boolean));
    const h0 = runHealth(st0);
    row = { runId: n, workspace: ws, phase: st0.phase, status: st0.status, updatedAt: st0.updatedAt, goal: '', done: done0, total: tasks0.length, members: owners.size, violations: checkTasks(tasks0, st0.phase, st0).length, health: h0.health, healthReason: h0.reason, ownerSession: String(st0.ownerSession || ''), ownerResolved: !!st0.ownerSession };
  } else {
    // B1：面板的 run 下拉过去同样静默跳过没有 STATE.json 的目录 —— 用户在界面上
    // **完全看不到**这些遗留/损坏的 run。现在如实列出并标 `health: 'broken'`。
    row = { runId: n, workspace: ws, phase: '', status: '', updatedAt: '', goal: '', done: 0, total: 0, members: 0, violations: 0, health: 'broken', healthReason: '缺 STATE.json（或不可解析）' };
  }
  if (stampState !== null) {
    RUNS_INDEX_STATS.computes += 1;
    RUNS_INDEX.set(dir, { stamp, row });
    scheduleRunsIndexSave();
  }
  return { ...row };
}
async function listRunsInWorkspace(ws) {
  const root0 = teamRoot(ws);
  let ents0 = [];
  // ⚠️ 只要**目录**：`team/` 根下还住着普通文件（`CODEINDEX.json`、`LEARNINGS.md`、`REPOWIKI.md`…），
  // 旧实现把它们也当 run 名去读 `<name>/STATE.json` ⇒ 必然失败 ⇒ 面板的 run 下拉里出现
  // 一串"broken run"（画布上真能看到这种条目）。run 是目录，这个判据才是对的。
  try { ents0 = await readdir(root0, { withFileTypes: true }); } catch { return []; }
  const out0 = [];
  for (const ent of ents0) {
    if (!ent || ent.isDirectory?.() !== true) continue;
    const n = ent.name;
    out0.push(await cachedRunRow(ws, join(root0, n), n));
  }
  return out0;
}
// ── `/state?section=` 的解析（纯函数，便于单测）──────────────────────────────
// 语义（2026-09-15 性能修复 #3，渐进式状态）：
//   缺省 / `all` ⇒ **全部分节**（向后兼容：老客户端、脚本、既有测试一律不受影响）；
//   否则只含列出的分节。`summary` 永远在内 —— 它是"便宜基线"（阶段/进度/计数），不是可选块。
//
// ⚠️ 2026-09-15 修正：未知段名以前**静默回落到 summary**，于是 `?section=roles` 这种**打错的探测**
//   会返回一份看起来正常的 `summary` 载荷 —— 验收时我本人就被它骗过一次（把 summary 的耗时
//   当成"roles 段的耗时"）。静默回落把"你要的块不存在"伪装成"一切正常"，正是本仓最忌讳的
//   "两种零分不开"。现在：**纯函数只如实报告**（`invalid` 列出非法名，不抛错，仍可被单测直接调），
//   由**路由**决定拒绝（400 + 合法清单）。注意 `summary` 是合法段名（显式写它也允许）。
const STATE_SECTIONS = ['summary', 'people', 'feed', 'artifacts'];
export function parseStateSections(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  const all = s === '' || s === 'all';
  const names = s.split(',').map((x) => x.trim()).filter(Boolean);
  const want = (n) => all || names.includes(n);
  const invalid = all ? [] : names.filter((n) => !STATE_SECTIONS.includes(n));
  return {
    all, want, invalid, valid: STATE_SECTIONS.slice(),
    included: ['summary'].concat(['people', 'feed', 'artifacts'].filter(want)),
  };
}
// Snapshot one run's full team state from a specific workspace.
async function snapshotRun(ws, run) {
  const dir = join(ws, 'team', run);
  const state = await readJsonSafe(join(dir, 'STATE.json'));
  if (!state) return null;
  const roster = await readJsonSafe(join(dir, 'ROSTER.json'));
  const tasks = await readJsonSafe(join(dir, 'TASKS.json'));
  const goalLines = await readFile(join(dir, 'TASK.md'), 'utf8').catch(() => '');
  const goal = (goalLines.split('\n').find((l) => /^>\s*目标/.test(l)) ?? '').replace(/^>\s*目标[：:]\s*/, '');
  // F1 (AgentTeams 借鉴): a staged, panel-editable plan draft. `planStatus`
  // tells the overlay whether the gate is staged / approved / discarded.
  const draft = state.draft && typeof state.draft === 'object' ? state.draft : null;
  const planStatus = state.planDiscarded ? 'discarded' : (draft ? 'staged' : (state.planApprovedAt ? 'approved' : 'none'));
  // `stateOwnerSession`：创建该 run 的会话 id（写在 STATE.json 里，run 自带、不会被别的会话改写）。
  // 面板据此决定去**哪个会话**列人员 —— 否则在会话 A 里看会话 B 的 run 会拿到 A 的子代理。
  // ⚠️ `coverage` 只透传**形状合规**的条目：旧的 `Array.isArray(x) ? x : []` 会把
  // `["pm","architect",…]`（角色名字符串数组）原样喂给面板，面板兜底后**渲染成一串空行**
  // —— 这就是本项目记录的"生产端违约 + 消费端静默吞"。这里不再静默吞：不合规就**过滤掉**，
  // 而"存在违规"这件事由 C4（`schemaViolations` 读**原始文件**）如实报告，信息不丢。
  const coverageSafe = Array.isArray(state.coverage)
    ? state.coverage.filter((c) => c !== null && typeof c === 'object' && !Array.isArray(c))
    : [];
  // G 线（档位）：浮层要显示档位徽标 ⇒ 档位必须随 `/state` 下发（ROSTER 优先，回退 STATE；
  // 旧 run 两者都没有 ⇒ `null`，面板据此显示"档位未登记"而不是编一个默认档）。
  const tier = normalizeTier(roster?.tier) || normalizeTier(state.tier) || null;
  return { runId: run, workspace: ws, stateOwnerSession: String(state.ownerSession || ''), phase: state.phase, status: state.status, mode: state.mode, deliverable: state.deliverable, updatedAt: state.updatedAt, goal, tier, roles: roster?.roles ?? [], members: roster?.members ?? {}, agents: roster?.agents ?? {}, stateMembers: state.members ?? [], models: roster?.models ?? null, coverage: coverageSafe, coverageRaw: state.coverage, tasks: taskList(tasks), pendingDecision: state.pendingDecision ?? null, draft, planStatus, planDiscardedAt: state.planDiscarded?.at ?? null };
}

// Pick the newest run across a set of runs.
function newestRun(runs) {
  if (!runs.length) return null;
  return runs.slice().sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
}


async function pickRunDir(root, runArg) {
  let names = [];
  try { names = await readdir(root); } catch {}
  if (!names.length) return null;
  if (runArg) {
    names = names.filter((n) => n.includes(runArg));
    if (names.length === 1) return join(root, names[0]);
    return join(root, runArg);
  }
  // default to the most recently updated run (STATE.updatedAt)
  let best = null, bestT = 0;
  for (const n of names) {
    const s = await readJsonSafe(join(root, n, 'STATE.json'));
    const t = Date.parse(s?.updatedAt ?? '') || 0;
    if (t >= bestT) { bestT = t; best = n; }
  }
  return best ? join(root, best) : null;
}

async function listSubagentStatus(ctx, invocation) {
  const sid = invocation?.agent?.session?.id;
  return listSubagentStatusBySession(ctx, sid);
}

// Resolve the ROOT session (walk `parentSession` up to the top-level session).
// The overlay may be opened from a SUBAGENT session view (e.g. while watching
// Mia the PM run) — the team's members are children of the ROOT, not of the
// subagent, so listing must start from the root to show live status.
async function rootSessionId(ctx, sid) {
  try {
    let cur = sid;
    for (let i = 0; i < 5 && cur; i++) {
      const hdr = ctx?.get?.('sessions')?.get?.(cur)?.header;
      if (!hdr) break;
      if (hdr.origin !== 'subagent') return cur;
      cur = hdr.parentSession || '';
    }
    return cur || sid;
  } catch { return sid; }
}

/**
 * Durable header lookup for one child session: `{createdAt, parentId, depth}`.
 *
 * ⚠️ 为什么不能只查 `ctx.sessions.get(id)`：**已结束的子会话会被从活存储里清掉**
 * （dsh 自己的 session-query 就拿 `ctx.sessions.get(id) !== undefined` 当"是否还活着"的判据）。
 * 实测 2026-09-11 在 `php/jiu` 新建的 team：两个子代理（215ef224 / 3a342763）的会话日志第一行明明写着
 * `{"type":"session","createdAt":1789103277739,"parentSession":"session-30625072-…","delegationDepth":1}`，
 * 而 `ctx.sessions.get()` 拿不到 ⇒ 面板显示 `createdAt=0 / parentId='' / depth=0`
 * ⇒ 流转图判为「无创建时间记录，无法分批」。用户看到的正是这句。
 *
 * 三源，按"便宜且准"降级，逐 id 缓存（一次进程内不再重复读日志）：
 *   ① 活存储 `ctx.sessions.get(id).header`（子代理还在跑时最省）
 *   ② `sessionQuery.readSession(id).session` —— **durable 投影的 header**，子代理结束后仍可读
 * 两源都拿不到 ⇒ 返回 0/''/0，UI 按"无时间记录"如实降级，**不臆造**。
 */
const SUB_HEADER_CACHE = new Map(); // childId -> {createdAt, parentId, depth}
async function childSessionTiming(ctx, id) {
  const key = String(id || '');
  if (!key) return { createdAt: 0, parentId: '', depth: 0 };
  if (SUB_HEADER_CACHE.has(key)) return SUB_HEADER_CACHE.get(key);
  let out = { createdAt: 0, parentId: '', depth: 0 };
  try {
    const hdr = ctx?.get?.('sessions')?.get?.(key)?.header;
    if (hdr && Number(hdr.createdAt)) {
      out = { createdAt: Number(hdr.createdAt) || 0, parentId: String(hdr.parentSession || ''), depth: Number(hdr.delegationDepth) || 0 };
    }
  } catch { /* best-effort */ }
  if (!out.createdAt) {
    try {
      const q = (ctx && typeof ctx.get === 'function') ? ctx.get('sessionQuery') : null;
      if (q && typeof q.readSession === 'function') {
        const snap = await q.readSession(key);
        const h = snap?.session || snap?.header || null;
        if (h) out = { createdAt: Number(h.createdAt) || 0, parentId: String(h.parentSession || ''), depth: Number(h.delegationDepth) || 0 };
      }
    } catch { /* best-effort */ }
  }
  SUB_HEADER_CACHE.set(key, out);
  return out;
}

/**
 * 子会话 header **索引**：只查表，**永不读日志**。
 *
 * 为什么必须有它（2026-09-15 性能诊断）：/state 曾对**每个**子会话调 childSessionTiming，
 * 而它对"活存储里已查不到"的子代理会退回 sessionQuery.readSession(id) —— 那是**全量读该子会话日志**
 * （本机实测 21 条 = 23.6 MiB zstd / ~31,000 事件；别的 run 测到 75/92 条）。结果：端点热态 7.1–9.8 s、
 * 冷态 **283.6 s**，而面板绘制只要 52 ms；请求还压在事件循环上，把整个 dsh web 一起拖慢
 * （轻量端点 /settings 因此涨到 20.7 s / 42.5 s）。
 *
 * 三个来源都**便宜**，按"准且省"排序：
 *   ① listSubagentStatusBySession 已经带出的 durable header 字段（createdAt/parentId/depth）
 *      —— 那一支本来就要 listSessions()，字段是**顺带**拿到的，不额外读任何日志；
 *   ② 活存储 ctx.sessions.get(id).header（子代理还在跑时最省）；
 *   ③ workflow 事件流的 startedAt（父会话日志已按 WF_EVENT_TTL_MS 缓存，见 workflowEventIndex）。
 * 三源都拿不到 ⇒ 保持 0/''/0，UI 按「无时间记录」**如实降级**（hasTimestamp:false）——
 * **不臆造**，也**绝不**为了"看起来有数据"退回全量读日志。
 *
 * @returns {Map<string, {createdAt:number, parentId:string, depth:number}>}
 */
function subHeaderIndex(ctx, subs, wfLabels) {
  const out = new Map();
  for (const s of Array.isArray(subs) ? subs : []) {
    const id = String((s && s.id) || '');
    if (!id) continue;
    let createdAt = Number(s.createdAt) || 0;
    let parentId = String(s.parentId || '');
    let depth = Number(s.depth) || 0;
    if (!createdAt) {
      try {
        const hdr = ctx?.get?.('sessions')?.get?.(id)?.header;
        if (hdr) {
          createdAt = Number(hdr.createdAt) || 0;
          if (!parentId) parentId = String(hdr.parentSession || '');
          if (!depth) depth = Number(hdr.delegationDepth) || 0;
        }
      } catch { /* best-effort */ }
    }
    if (!createdAt && wfLabels) {
      const w = typeof wfLabels.get === 'function' ? wfLabels.get(id) : wfLabels[id];
      const at = w && Number(w.startedAt);
      if (at) createdAt = at;
    }
    out.set(id, { createdAt, parentId, depth });
  }
  return out;
}

/**
 * 并发合并 + **目录戳失效** + 长 TTL 的 `sessionQuery.listSessions()`。
 *
 * 为什么需要它（2026-09-15 性能诊断）：宿主的 listSessions 在持久化层是
 * **枚举全部 artifact、逐个读 header**（本机 475 个、实测 ~1.5–2.4 s），而 /state 每 3 秒轮询。
 *
 * **2026-09-15 第二轮（profile 实测 subs 段 1.3–1.4 s 之后的纠正）**：
 *   ① **2 s TTL 等于没有**：真实请求间隔就在 2 s 上下（轮询 + 退避），必然过期 ⇒ 每请求重算。
 *      现在 TTL 只作**兜底**（60 s），主失效键改成 `(sessions 根目录, mtimeMs, size)`
 *      —— 新增/删除会话必然改动目录 mtime/size ⇒ **立刻失效**，不必靠 TTL 猜新鲜度。
 *   ② **真正省时的是下面的 `SUB_HEADER_MEMO`**：按 session id 记住**不可变**的 header 字段，
 *      第二个请求起**根本不再枚举**。这才是把 subs 段打到近 0 的手段，而不是调 TTL 骗自己。
 *
 * **缓存纪律（本仓对"看到的就是真的"很敏感，所以写死在这里）**：
 *   · 只服务"活注册表里**查不到**的子代理"这一支 ⇒ 都是**已结束/历史**会话，其 header 不再变化；
 *   · **活代理**的状态一律走 listChildren/agents **实时读**，绝不经过这里的任何缓存；
 *   · 目录戳取不到时退化为 60 s TTL 兜底（有界：新生效会话最多晚 60 s 可见，且只在 stat 失败时）。
 */
const LIST_SESSIONS_TTL_MS = 60000;
let LIST_SESSIONS_CACHE = { at: 0, stamp: null, sessions: null, inflight: null };
/** 会话目录的廉价失效戳（mtime + size）。取不到 ⇒ null ⇒ 只用 TTL 兜底。 */
async function sessionsRootStamp() {
  try {
    const st = await stat(join(dshHome(), 'sessions'));
    return `${Math.round(Number(st.mtimeMs) || 0)}:${Number(st.size) || 0}`;
  } catch { return null; }
}
async function cachedListSessions(q, stamp) {
  const now = Date.now();
  const stampOk = (stamp === undefined || stamp === null) ? true : (LIST_SESSIONS_CACHE.stamp === stamp);
  if (LIST_SESSIONS_CACHE.sessions && (now - LIST_SESSIONS_CACHE.at) < LIST_SESSIONS_TTL_MS && stampOk) {
    return LIST_SESSIONS_CACHE.sessions;
  }
  if (LIST_SESSIONS_CACHE.inflight) return LIST_SESSIONS_CACHE.inflight; // 同刻只有一个枚举在跑
  SUB_HEADER_STATS.enumCalls += 1;
  const p = Promise.resolve()
    .then(() => q.listSessions())
    .then((sessions) => {
      LIST_SESSIONS_CACHE = { at: Date.now(), stamp: (stamp === undefined ? null : stamp), sessions: Array.isArray(sessions) ? sessions : [], inflight: null };
      return LIST_SESSIONS_CACHE.sessions;
    })
    .catch((e) => { LIST_SESSIONS_CACHE = { at: 0, stamp: null, sessions: null, inflight: null }; throw e; });
  LIST_SESSIONS_CACHE.inflight = p;
  return p;
}
/** 仅供测试：清空枚举缓存并复位（生产代码不需要调用它）。 */
function _resetListSessionsCache() { LIST_SESSIONS_CACHE = { at: 0, stamp: null, sessions: null, inflight: null }; }

// ── 已结束子会话的 header 备忘（按 session id，**永久**）─────────────────────────
// createdAt / parentId / depth 对**已结束**会话是不可变的；而用到备忘的这条分支，其 id 恰恰是
// "活注册表里查不到"的那些 ⇒ 记住它们**不会**让用户看到旧状态（活代理走实时路径，永不写入这里）。
// 旧实现每请求都要枚举 475 个 artifact 才能回答"这些人是何时建的、谁派工的"——
// 有了备忘，第二个请求起直接查表。
const SUB_HEADER_MEMO = new Map();
// `cut`（2026-09-15 有界化）如实记录这一段被截断/节流的原因，供调用方进 `degraded`：
//   '' = 未截断｜'throttled' = 本轮在节流窗口内、未枚举｜'deadline' = 预热/枚举到期限被截断
//   'warming' = 首次预热已在后台跑，本轮先用内存里已有的行（**不是失败**，由 `subsPending` 表达）
// 另有可观测计数器（只在 `DSH_EXPERT_TEAM_STATE_PROFILE=1` 的 profile 里出现），
// 用来把"热路径到底还去不去枚举"这件事变成可测的数字，而不是注释里的承诺。
const SUB_HEADER_STATS = {
  memoHits: 0, memoWrites: 0, enumCalls: 0, cut: '',
  rowsHits: 0, rowsMisses: 0, warms: 0, warmErrors: 0, warmMs: 0, warmTimeouts: 0, liveRows: 0,
  // 2026-09-15：预热拿到**空结果**（而调用方期望有人）的次数 —— 空结果不成基线，见 SUB_ROWS_MEMO。
  emptyBaselines: 0,
  // `notReady`（2026-09-16）：**"预期有人、却一行都没有、且还没有有效基线"** ⇒ 这是"宿主还没就绪"，
  // 不是"真的没有成员"。真机事故：重启后首轮 `agents=[] / subsPending=13`，**没有任何标记**，
  // 几分钟后才自愈 —— 调用方（以及用户）无法把这一发与"这个团队真的没有人"区分开，
  // 正是本仓纪律里说的"两种零分不开"。现在调用方据此挂 `warming:['subs']`。
  // ⚠️ 限时（`SUBS_NOT_READY_MAX_MS`）：一直拿不到就把这句话**收回**，交给 `subsPending`
  // 如实表达"这些成员的明细拿不到" —— 否则它自己又会变成一盏常亮的灯。
  // ⚠️ 2026-09-16 独立验收（222 个样本 / 三个场景）坐实：**旧的 `notReady` 判据在真实场景里
  // 一次都没置位** —— 它要求"行备忘存在**且** `provisional:true`"，而 `provisional` 只在
  // `warmSubRows` 拿到 **0 行**时才写。真实情形是：① 预热还在飞（备忘压根不存在）；
  // ② 预热返回了**别的**行（备忘写的是 `provisional:false`）；③ 该成员的行永远解析不出来。
  // 三种情形下面板上"一个人都没有"是**同一个事实**，却一个都标不出来（第三个场景：200 个样本 /
  // 37 s，`agents:0 / subsPending:1`，**全程没有任何标记**）⇒ 对外说"冷启动会标 `warming:['subs']`"
  // 是**说得比事实满**。现在改为**只看消费者侧的事实**（在册成员非空、却一个都没被覆盖），
  // 起算时刻记在 `SUB_UNCOVERED_SINCE` 上，因此**不依赖行备忘**是否写过、写的是什么。
  notReady: false,
  // 上述"首次发现有人在册却一个都没覆盖"的时刻（仅供 profile 观测）。
  notReadySince: 0,
};
function _resetSubHeaderMemo() {
  SUB_HEADER_MEMO.clear();
  SUB_HEADER_STATS.memoHits = 0;
  SUB_HEADER_STATS.memoWrites = 0;
  SUB_HEADER_STATS.enumCalls = 0;
  SUB_HEADER_STATS.cut = '';
  SUB_HEADER_STATS.rowsHits = 0;
  SUB_HEADER_STATS.rowsMisses = 0;
  SUB_HEADER_STATS.warms = 0;
  SUB_HEADER_STATS.warmErrors = 0;
  SUB_HEADER_STATS.warmMs = 0;
  SUB_HEADER_STATS.warmTimeouts = 0;
  SUB_HEADER_STATS.liveRows = 0;
  SUB_HEADER_STATS.notReady = false;
  SUB_HEADER_STATS.notReadySince = 0;
}

// ── 子代理行（`subagents.listChildren`）的**后台预热 + 备忘**（2026-09-15 第四轮）───────
// 为什么必须把它从热路径拿掉（真机实测，`DSH_EXPERT_TEAM_STATE_PROFILE=1`）：
//   `?section=people,feed` = 2,686 / 2,724 / 2,697 ms，其中 `profile.subs` 2,680 / 2,717 / 2,686 ms
//   —— 即**全部**成本都在这一句。`subagents.listChildren()` 的实现里**无条件**先做
//   `sessionQuery.listSessions()`（`dsh-subagent/lib/types/list-children.js` 的 `prepareListing`），
//   那是全库枚举：本机 475 条 artifact，每条 `lstat + stat + 读首行`。所以：
//     · 它**不受**我们的 30 s 节流管辖（节流只挡下面那段 rescue 枚举）；
//     · 800 ms 的期限**根本没机会生效**（期限只在"被 await 的那段返回之后"才被检查）。
//   结果：每轮轮询都付 2.7 s，而"有界化"在 subs 这一段是**装饰性**的。
// 修法（不改宿主、不臆造数据）：
//   ① 热路径只读**内存**：活子会话（`sessions.list()`）+ 上一次预热的备忘 + header 永久备忘；
//   ② 预热**只在后台**跑（同一 root 同刻只跑一个，结果进 `SUB_ROWS_MEMO`），
//      且只在**首次**（还没有基线）时按 `enumDeadlineAt` 等一小会儿 —— 机器快/用户库小时，
//      第一个响应就是完整的；等不到就如实标 `deadline`（真截断 ⇒ 进 degraded）并让后台继续跑；
//   ③ 到期**不等**的轮次用 `cut='warming'`（不是失败：成员不丢，细节由 `subsPending` 表达）；
//   ④ 过期（> 节流间隔）才再排一次后台刷新 —— 真机从"每请求 2.7 s"变成"≤每 120 s 一次 2.7 s"。
// 失效与正确性：活子代理的状态一律**实时读**（`sessions`/`agents`），绝不经过这里的缓存；
// 已结束子会话的行（mode/label/header）不可变，可长期复用；行的 `activity` 在服务时按
// "当下还在不在活存储/注册表里"重新判定 ⇒ 不会有"已结束却还写着 running"的陈旧值。
/**
 * 行备忘：`root -> { at, rows, provisional, retryMs, emptyStreak }`。
 *
 * ⚠️ 2026-09-15 真机事故（**1.3.20 引入的行为差**，用户实测）：重启后第一轮预热，宿主当时返回的是
 * **空集**（它自己的 artifact 索引还没热），而旧实现无条件把这个空集当成"基线"缓存
 * `SUBS_ENUM_MIN_INTERVAL_MS`(120 s) ⇒ **面板最多空 2 分钟**（真机 22:34 首批 `agents=[]`，
 * 22:40 越过窗口才自愈成 95 个）。1.3.19 每请求都 await `listChildren`，下一轮轮询就补上了
 * —— 所以这是"有界化换来的新鲜度代价"，得还回去。
 *
 * 现在的口径（三种情况分得开）：
 *   · **期望有人**（`knownIds` 非空）却拿到 0 行 ⇒ 这**不是**有效基线：记 `provisional:true`，
 *     按 `retryMs` 退避重试（2 s 起、每次翻倍、上限 `SUBS_ENUM_MIN_INTERVAL_MS`）。
 *     ⇒ 面板最多空 ~2 s 而不是 120 s，且**枚举代价有界**（不会退化成"每请求一次全库枚举"）。
 *   · **本来就没有成员**（`knownIds` 为空）⇒ 空集是**合法基线**，按正常间隔刷新，不重试风暴。
 *   · 空结果**不冲掉**已有的非空基线 —— 已结束子会话的行不可变，保着比丢掉强（这也顺带修掉了
 *     "一次瞬时空枚举把 95 行抹成 0 行"的隐患）。
 */
const SUB_ROWS_MEMO = new Map();     // root -> { at, rows, provisional, retryMs, emptyStreak }
const SUB_ROWS_INFLIGHT = new Map(); // root -> Promise<rows>（同刻只跑一个）
/**
 * "在册成员一个都没被覆盖"的**首次**时刻：`root -> ms`。
 *
 * 它和 `SUB_ROWS_MEMO.provisionalSince` 的区别是**要害**：后者只有"预热拿到 0 行"才会写，而
 * "面板上一个人都没有"可以由三种互不相同的原因造成（预热在飞 / 预热返回了**别的**行 /
 * 该成员的行永远解析不出来）。`notReady` 的限时起算点必须绑在**消费者侧的事实**上，
 * 而不是生产者侧的某一条支路 —— 否则那条诚实性标记在真实场景里根本不亮
 * （见 `SUB_HEADER_STATS.notReady` 的注释：222 个样本 / 三个场景一次都没置位）。
 */
const SUB_UNCOVERED_SINCE = new Map();
/**
 * "空结果多久后重试"的起始间隔。可用 `DSH_EXPERT_TEAM_SUBS_RETRY_MS` 覆盖（测试里调小它，
 * 免得为了一次重试等 2 s）。**每次调用都读 env**（不在模块加载时固化）—— 否则测试改不动它。
 */
function subsRowsRetryBaseMs() {
  const raw = Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_SUBS_RETRY_MS) || 0);
  return Math.max(50, raw || 2000);
}
/** 仅供测试：清空行备忘与在飞标记。 */
function _resetSubRowsMemo() { SUB_ROWS_MEMO.clear(); SUB_ROWS_INFLIGHT.clear(); SUB_UNCOVERED_SINCE.clear(); }

/**
 * 活子会话 → 行（只读内存，**零次**持久化枚举）。
 * @returns `{rows, scanned}`：`scanned=false` 表示这台宿主/桩子上没有 `sessions.list()`
 *   ⇒ 调用方**不许**据此把备忘里的 `running` 改判成 `inactive`（没有证据 ≠ 证据是没有）。
 */
function liveChildRows(ctx, root) {
  const out = [];
  let scanned = false;
  try {
    const sessions = (ctx && typeof ctx.get === 'function') ? ctx.get('sessions') : null;
    if (!sessions || typeof sessions.list !== 'function') return { rows: out, scanned };
    scanned = true;
    for (const s of sessions.list() || []) {
      const h = (s && s.header) ? s.header : null;
      if (!h || !h.id) continue;
      if (String(h.parentSession || '') !== String(root)) continue;
      if (String(h.origin || '') !== 'subagent') continue;
      out.push({
        id: String(h.id), mode: 'continuable', label: '', activity: 'running', model: '',
        createdAt: Number(h.createdAt) || 0, parentId: String(h.parentSession || ''), depth: Number(h.delegationDepth) || 0,
      });
    }
  } catch { scanned = false; /* best-effort：拿不到就少几行，绝不抛 */ }
  return { rows: out, scanned };
}

/**
 * 后台预热一个 root 的子代理行。**调用方不许 await 它**（除首次那一次有期限的等待）。
 * 同刻只跑一个；结果（含失败）都落在 `SUB_ROWS_MEMO` / 计数器里；顺带把 header 字段
 * 灌进 `SUB_HEADER_MEMO`（已结束子会话的 header 不可变 ⇒ 永久备忘安全）。
 */
function warmSubRows(ctx, root, opts) {
  const key = String(root || '');
  if (!key) return null;
  const inflight = SUB_ROWS_INFLIGHT.get(key);
  if (inflight) return inflight;
  // 调用方**是否期望这里有行**（即 `knownIds` 非空）。它决定"空结果算不算基线"：
  // 期望有人却拿到空集 ⇒ 那是"宿主还没热"，不是"团队解散了"（见 SUB_ROWS_MEMO 的注释）。
  const expectRows = !!(opts && opts.expectRows);
  let runtime = null;
  try {
    const rt = (ctx && typeof ctx.get === 'function') ? ctx.get('subagents') : null;
    runtime = rt || (ctx && ctx.subagents) || null;
  } catch { runtime = null; }
  if (!runtime || typeof runtime.listChildren !== 'function') return null;
  const t0 = Date.now();
  SUB_HEADER_STATS.warms += 1;
  const p = Promise.resolve()
    .then(() => runtime.listChildren(key))
    .then((rows) => {
      const arr = Array.isArray(rows) ? rows : [];
      const prev = SUB_ROWS_MEMO.get(key);
      const retryBase = subsRowsRetryBaseMs();
      if (arr.length === 0 && expectRows) {
        // 空结果 + 期望有人 ⇒ **不当作有效基线**（旧实现就是在这里把"还没热"缓存成了"就这么多"）。
        // 保住上一次的非空行（已结束子会话的行不可变），并把重试间隔退避加倍 ⇒ 有界、能自愈。
        const prevRows = (prev && Array.isArray(prev.rows) && prev.rows.length) ? prev.rows : [];
        const prevRetry = (prev && prev.provisional && Number(prev.retryMs)) || 0;
        SUB_ROWS_MEMO.set(key, {
          at: Date.now(), rows: prevRows, provisional: true,
          // 第一次拿到空结果的时刻（沿用旧值，不每次刷新）—— `SUB_HEADER_STATS.notReady` 用它
          // 把"还没就绪"这句话**限时**：一直拿不到就不再假装在等（见该常量的注释）。
          provisionalSince: (prev && prev.provisional && Number(prev.provisionalSince)) || Date.now(),
          retryMs: Math.min(Math.max(retryBase, prevRetry * 2), SUBS_ENUM_MIN_INTERVAL_MS),
          emptyStreak: (Number(prev && prev.emptyStreak) || 0) + 1,
        });
        SUB_HEADER_STATS.emptyBaselines += 1;
      } else {
        SUB_ROWS_MEMO.set(key, { at: Date.now(), rows: arr, provisional: false, provisionalSince: 0, retryMs: retryBase, emptyStreak: 0 });
      }
      SUB_HEADER_STATS.warmMs = Date.now() - t0;
      for (const r of arr) {
        const id = String((r && r.id) || '');
        if (!id || !Number(r?.createdAt)) continue;
        if (SUB_HEADER_MEMO.has(id)) continue;
        SUB_HEADER_MEMO.set(id, { createdAt: Number(r.createdAt) || 0, parentId: String(r.parentId || ''), depth: Number(r.depth) || 0 });
        SUB_HEADER_STATS.memoWrites += 1;
      }
      SUB_ROWS_INFLIGHT.delete(key);
      return arr;
    })
    .catch((e) => {
      SUB_HEADER_STATS.warmErrors += 1;
      SUB_ROWS_INFLIGHT.delete(key);
      throw e;
    });
  // 后台任务**不许**产生 unhandled rejection：首次等待可能已经放弃（期限到点），
  // 而 catch 里再抛出去的那份必须有人接。
  p.catch(() => {});
  SUB_ROWS_INFLIGHT.set(key, p);
  return p;
}

/** 把行按 id 合并：**后写的活行赢**（活状态永远实时）。 */
function mergeRows(base, extra) {
  const byId = new Map();
  for (const r of base || []) if (r && r.id) byId.set(String(r.id), r);
  for (const r of extra || []) if (r && r.id) byId.set(String(r.id), r);
  return [...byId.values()];
}

async function listSubagentStatusBySession(ctx, sid, knownIds, opts) {
  // 只认真 id：调用方若传进角色名（历史 bug，见 `memberAgentIds` 的注释），枚举分支会**永久**
  // 认为"还有人查不到" ⇒ 每请求重枚举。这里再兜一道，防止未来又有人把角色名传进来。
  const ids = (Array.isArray(knownIds) ? knownIds : []).filter(isAgentIdLike);
  // ⚠️ 这里**不再**复位 `notReady`：复位权归**每请求一次的调用点**（与 `cut` 同一处）。
  // 原因（2026-09-16 真机/临时实例实测）：同一个请求里本函数会被调**两次** —— 归属会话拿不到人时
  // 会退回请求会话再调一次（见路由里的 fallback）。旧写法在**每次调用开头**复位 ⇒ 第二次调用
  // （它的 `root` 往往是空串、整个判据分支压根进不去）会把第一次算出的"还没就绪"**原样抹掉**
  // ⇒ 真实冷启动（`members:13 / agents:0 / subsPending:13`）里那条标记**依然一次都不亮**。
  // 判据本身没错，错的是**归属权**：一次请求只该有一个事实。
  // 有界化（2026-09-15）：枚举整棵 sessions 树是最贵的一步（真机实测 2.4–3.6 s，且它是
  // **全库**扫描）。调用方可以（a）在节流窗口内**禁止枚举**、（b）给一个期限。两者都不命中时
  // 保持原行为（默认允许 + 无期限）。被挡住/截断时**不丢成员**：那些 id 只是没有 header ⇒
  // 既有口径已如实显示为"细节不可得"（`hasTimestamp:false`），不假装 0。
  const allowEnum = !(opts && opts.allowEnum === false);
  const enumDeadlineAt = (opts && Number.isFinite(opts.enumDeadlineAt)) ? opts.enumDeadlineAt : Infinity;
  const root = sid ? await rootSessionId(ctx, sid) : '';
  // ── 热路径：**只读内存**（活子会话 + 上一次预热留下的行）—— 见 `SUB_ROWS_MEMO` 的注释 ──
  // 这一句以前是 `await runtime.listChildren(root)`：真机 2.7 s，且它内部无条件全库枚举。
  let rows = [];
  if (root) {
    const memo = SUB_ROWS_MEMO.get(root);
    if (memo) SUB_HEADER_STATS.rowsHits += 1; else SUB_HEADER_STATS.rowsMisses += 1;
    const live = liveChildRows(ctx, root);   // 活代理**实时读**，永远覆盖备忘里的旧行
    SUB_HEADER_STATS.liveRows = live.rows.length;
    // 备忘是"上一次预热的快照"：里面的 `running` 只在**当时**为真。有 `sessions.list()` 这份
    // 现在时的证据时，把已经不在活存储里的 `running` 改判 `inactive`（否则一个刚结束的子代理
    // 会在面板上"还在跑"最多一个刷新间隔）。没有证据（老宿主/测试桩）⇒ 不动它。
    const liveIds = new Set(live.rows.map((r) => String(r.id)));
    const memoRows = !memo ? [] : (live.scanned
      ? memo.rows.map((r) => (r && r.activity === 'running' && !liveIds.has(String(r.id)) ? Object.assign({}, r, { activity: 'inactive' }) : r))
      : memo.rows);
    rows = mergeRows(memoRows, live.rows);
    // 过期判据：provisional（空结果、还没拿到基线）走**自己的退避间隔**，正常基线走 120 s。
    const rowsTtl = (memo && memo.provisional) ? (Number(memo.retryMs) || subsRowsRetryBaseMs()) : SUBS_ENUM_MIN_INTERVAL_MS;
    const stale = !memo || (Date.now() - (Number(memo.at) || 0)) > rowsTtl;
    if (allowEnum && stale) {
      // `expectRows`：有登记的成员却一行都没拿到 ⇒ 空集不得成基线（1.3.20 那个"空 2 分钟"的修法）。
      const warm = warmSubRows(ctx, root, { expectRows: ids.length > 0 });
      if (!warm) {
        // `subagents` 服务不可用（老宿主）：保持原行为，交给下面的 rescue 枚举（仍受节流+期限管）。
      } else if (memo && !memo.provisional) {
        // 有**有效基线**、只是过期 ⇒ 只管后台刷新，本轮先用旧行（已结束子会话的行不可变；
        // 活行已在上面覆盖）。
        SUB_HEADER_STATS.cut = SUB_HEADER_STATS.cut || 'warming';
      } else if (!Number.isFinite(enumDeadlineAt)) {
        // 调用方没声明期限 ⇒ 与旧行为一致：等它回来（首次基线）。
        const got = await warm.then((r) => (Array.isArray(r) ? r : []), () => null);
        if (got) rows = mergeRows(got, liveChildRows(ctx, root).rows);
      } else {
        // 有期限：**只等这一次**。等到 ⇒ 首个响应就是完整的；等不到 ⇒ 如实标 deadline
        // （真截断，调用方据此进 degraded），后台继续跑，下一轮（≤一个轮询间隔）就有基线。
        const left = enumDeadlineAt - Date.now();
        if (left <= 0) { SUB_HEADER_STATS.warmTimeouts += 1; SUB_HEADER_STATS.cut = SUB_HEADER_STATS.cut || 'deadline'; }
        else {
          const got = await Promise.race([
            warm.then((r) => ({ ok: true, rows: Array.isArray(r) ? r : [] }), () => ({ ok: false })),
            new Promise((res) => setTimeout(() => res({ ok: false, slow: true }), left)),
          ]);
          if (got.ok) rows = mergeRows(got.rows, liveChildRows(ctx, root).rows);
          else if (got.slow) { SUB_HEADER_STATS.warmTimeouts += 1; SUB_HEADER_STATS.cut = SUB_HEADER_STATS.cut || 'deadline'; }
        }
      }
    }
  }
  // Cross-session enrich: the run's registered agent ids may belong to a
  // DIFFERENT session (viewing run A from session B) — the live `agents`
  // registry still reports their status/model keyed by session id.
  if (ids && ids.length) {
    try {
      const reg = (ctx && typeof ctx.get === 'function') ? ctx.get('agents') : null;
      if (reg && typeof reg.list === 'function') {
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const ag of reg.list() || []) {
          const aid = ag?.session?.header?.id;
          if (!aid || !ids.includes(aid)) continue;
          const act = ag.status === 'running' ? 'running' : 'idle';
          const cur = byId.get(aid);
          // 行已存在（可能来自后台预热的旧快照）⇒ **注册表赢**：活状态永远实时，不吃缓存。
          // 注意**换新对象**而不是改字段：备忘里的行对象是共享的，就地改会把"此刻的状态"
          // 写进快照，之后这个 id 结束时就会顶着那份陈旧值（正是要防的东西）。
          if (cur) {
            byId.set(aid, Object.assign({}, cur, { activity: act, model: cur.model || ag?.options?.model || '' }));
            continue;
          }
          byId.set(aid, { id: aid, mode: 'continuable', label: '', activity: act, model: ag?.options?.model || '' });
        }
        rows = [...byId.values()];
      }
    } catch { /* best-effort */ }
  }
  // Fallback: completed subagents may be disposed from the live registry —
  // the durable session projection (sessionQuery) still lists them.
  //
  // ⚠️ 2026-09-15 两轮性能修复：
  //   第一轮：只有**真的缺人**才花这笔钱（旧实现无条件 listSessions()）；
  //   第二轮：缺的那些**先查 `SUB_HEADER_MEMO`**（已结束会话的 header 不可变 ⇒ 永久备忘），
  //           只有仍然未知的才去枚举 ⇒ 第二个请求起通常**零枚举**。
  const missingIds = (ids || []).filter((id) => !rows.some((r) => r.id === id));
  if (missingIds.length) {
    const memoById = new Map(rows.map((r) => [r.id, r]));
    const stillUnknown = [];
    for (const id of missingIds) {
      const memo = SUB_HEADER_MEMO.get(id);
      if (!memo) { stillUnknown.push(id); continue; }
      SUB_HEADER_STATS.memoHits += 1;
      memoById.set(id, {
        id, mode: 'continuable', label: '', activity: 'inactive', model: '',
        createdAt: memo.createdAt, parentId: memo.parentId, depth: memo.depth,
      });
    }
    rows = [...memoById.values()];
    if (stillUnknown.length) {
      if (!allowEnum) {
        SUB_HEADER_STATS.cut = SUB_HEADER_STATS.cut || 'throttled';
      } else try {
        const q = (ctx && typeof ctx.get === 'function') ? ctx.get('sessionQuery') : null;
        // 期限已经过了 ⇒ **一次都不发**：起一个 2.7 s 的全库枚举、然后在第一行上"发现超期"，
        // 正是"装饰性期限"本身（旧实现在这里白等 2.7 s 才 break）。起手就先看预算。
        const leftMs = enumDeadlineAt - Date.now();
        if (q && typeof q.listSessions === 'function' && leftMs <= 0) {
          SUB_HEADER_STATS.cut = SUB_HEADER_STATS.cut || 'deadline';
        } else if (q && typeof q.listSessions === 'function') {
          const racers = [cachedListSessions(q, await sessionsRootStamp()).then((s) => ({ ok: true, s }), () => ({ ok: false }))];
          // 有期限 ⇒ 到点就**不再等**（在飞的那次枚举留在后台把 `cachedListSessions` 缓存填上，
          // 下一轮直接命中）。这是 subs 段"有界"的关键：响应永远不会被它拖过 budget。
          if (Number.isFinite(enumDeadlineAt)) racers.push(new Promise((res) => setTimeout(() => res({ ok: false, slow: true }), leftMs)));
          const got = racers.length > 1 ? await Promise.race(racers) : await racers[0];
          if (!got.ok) { SUB_HEADER_STATS.cut = SUB_HEADER_STATS.cut || 'deadline'; }
          else {
            const byId = new Map(rows.map((r) => [r.id, r]));
            for (const rec of got.s || []) {
              if (Date.now() > enumDeadlineAt) { SUB_HEADER_STATS.cut = 'deadline'; break; }
              const h = rec?.header || rec;
              const aid = h?.id;
              if (!aid || byId.has(aid) || !ids.includes(aid)) continue;
              // ⚠️ header 里的 createdAt / parentSession / delegationDepth **必须带出来**。
              // 旧实现只取 id，把它们丢掉，导致面板上每个成员都是 createdAt=0 ⇒ 流转图
              // 判为「无创建时间记录，无法分批」，尽管会话日志第一行明明写着
              // {"type":"session","createdAt":…,"parentSession":…,"delegationDepth":1}。
              const entry = {
                createdAt: Number(h?.createdAt) || 0,
                parentId: String(h?.parentSession || ''),
                depth: Number(h?.delegationDepth) || 0,
              };
              // 只有"活注册表里查不到"的 id 会走到这里（活代理走实时路径）⇒ header 不可变 ⇒ 备忘安全。
              SUB_HEADER_MEMO.set(aid, entry);
              SUB_HEADER_STATS.memoWrites += 1;
              byId.set(aid, { id: aid, mode: 'continuable', label: '', activity: 'inactive', model: '', ...entry });
            }
            rows = [...byId.values()];
          }
        }
      } catch { /* best-effort */ }
    }
  }
  // 如实标 `warming`：只要"**在册成员一个细节都没拿到**"就算"还没有有效基线"。
  //   · 为什么放在这里而不是预热返回处：已结束的成员**本来就可能不在 `listChildren` 里**
  //     （它们要走下面的 rescue 枚举），所以"预热返回空"≠"还没热"。等整条流水线跑完再判断，
  //     才不会在**数据其实完整**的响应上贴一个假标记。
  //   · 真被期限截断时 `deadline` 优先（`cut || 'warming'` 不会盖掉它）。两者可以**同时**出现：
  //     "本轮被截断"与"人员明细尚未就绪"是两件事，都真。
  //   · 它**不进** degraded（不是失败：成员不丢，"细节不可得"由 `subsPending` 表达，
  //     与 rolesPending 同一口径）。
  //   · ⚠️ **判据只看消费者侧这一件事**：`ids.length > 0` 且没有任何 id 被覆盖。旧判据还要求
  //     "行备忘存在**且** `provisional:true`"，而 `provisional` 只在预热拿到 **0 行**时才写 ⇒
  //     2026-09-16 独立验收（222 个样本 / 三个场景）里它**一次都没置位**（第三个场景：200 个样本 /
  //     约 37 s，`agents:0 / subsPending:1 / members:1`，**全程没有任何标记**）。三种真实情形
  //     （预热在飞 / 预热返回了别的行 / 该成员的行永远解析不出来）下面板上"一个人都没有"是
  //     **同一个事实**，就不该由生产者走了哪条支路来决定标不标。
  //   · 反向必须守住：`ids` 为空（这个 run 真的没有成员）⇒ **绝不**置位——否则就是把"空"说成
  //     "还没好"，等于换一盏常亮灯。
  if (root && ids.length) {
    const covered = rows.some((r) => ids.includes(r.id));
    if (!covered) {
      SUB_HEADER_STATS.cut = SUB_HEADER_STATS.cut || 'warming';
      // 起算点绑在**本次事实**上（第一次发现"有人在册却一个都没覆盖"），因此不依赖行备忘。
      if (!SUB_UNCOVERED_SINCE.has(root)) SUB_UNCOVERED_SINCE.set(root, Date.now());
      const since = Number(SUB_UNCOVERED_SINCE.get(root)) || Date.now();
      SUB_HEADER_STATS.notReadySince = since;
      // 限时 `SUBS_NOT_READY_MAX_MS`：一直拿不到就把"还没就绪"这句收回，交给 `subsPending`
      // 如实表达"明细拿不到" —— 否则它自己又会变成一盏常亮的灯。
      // ⚠️ **只置位、不复位**：复位权归调用点（每请求一次）。否则同一个请求里的第二次调用
      // （退路那次，`root` 往往是空串、整个判据分支压根进不去）会把这里刚立的事实**原样抹掉**
      // —— 2026-09-16 在临时实例上实测到的就是这个（判据对、归属权错）。
      if ((Date.now() - since) <= SUBS_NOT_READY_MAX_MS) SUB_HEADER_STATS.notReady = true;
    } else {
      // 覆盖上了 ⇒ 这一态结束，起算点清掉（下次再出现重新计时，不许粘住）。
      SUB_UNCOVERED_SINCE.delete(root);
    }
  } else if (root) {
    // 在册成员为空 ⇒ 空列表是**合法**的，不留任何"还没就绪"的痕迹。
    SUB_UNCOVERED_SINCE.delete(root);
  }
  return Array.isArray(rows) ? rows : [];
}

// Map a subagent row to its team role.
//
// Signal order matters. A角色 prompt (role tools AND workflow agents) starts with
// 「你是「专家团」的<中文角色>（<role-id>，…）」, so the parenthesised role id is the
// most reliable signal and is checked first. The label keywords are only a
// fallback: `workflow`-spawned children carry an EMPTY `subagent/descriptor.label`
// (observed 2026-09-10), which used to fall through to matching against the
// session id and leave every roster row at "未启动" while agents were running.
// `SUB_ROLE_WORDS` / `KNOWN_ROLES` / `ROLE_LABELS_ZH` / `roleLabelKey` 已搬到
// `lib/vocab.js`（B 线 11b 的唯一真源）。**注意**：下面的角色映射逻辑仍然读这些名字，
// 只是它们的定义现在只有一份；`vocab-consistency.test.mjs` 会比对 host（vocab.js）与
// client（client.js 那份搬不动的副本）逐词一致。
/**
 * Extract a role written in a bracket: `（researcher，一次性）` / `【researcher】…`（英文 id），
 * 或 `【产品经理】…` / `[测试员] 某任务`（中文标签，2026-09-11 起的主用写法）。
 *
 * `【…】` 这一形是**刻意加上的**：dsh 的子代理列表只预览子会话首条消息的开头一小段，
 * 把角色写成 `（researcher，…` 会被截成 `（r` / `（arch` 这种碎片。中文标签同理：
 * `【产品经理】` 在 28 显示宽度内完整可见，且后面不必再写一遍身份（用户 2026-09-11 报障：
 * `【pm】你是「专家团」中的产品经理（pm，…` 既重复又是英文）。
 */
function roleFromParenthesis(text) {
  const src = String(text || '');
  const m = src.match(/[（(【[]\s*([a-z][a-z0-9-]{1,24})\s*[，,、)）】\]]/);
  if (m && KNOWN_ROLES.has(m[1])) return m[1];
  // 中文标签分支：**只有精确命中标签表才算角色** —— 自由散文里的括号
  // （「（非实验性）」「（url）」）依旧被拒绝，不与旧行为冲突。
  const zh = src.match(/[（(【[]\s*([^，,、()（）【】\[\]]{1,32}?)\s*[，,、)）】\]]/);
  if (!zh) return '';
  return ROLE_LABELS_ZH.get(roleLabelKey(zh[1])) || '';
}
/** Keyword pass over one short text (a label, or the head of a role prompt). */
function roleFromWords(text) {
  const hay = String(text || '').toLowerCase();
  for (const [role, words] of SUB_ROLE_WORDS) {
    if (words.some((w) => hay.includes(w))) return role;
  }
  return '';
}
function roleOfSub(sub, wfLabels) {
  // 1) an explicitly resolved role (see resolveSubRoles) always wins
  if (sub && typeof sub.role === 'string' && sub.role) return sub.role;
  // Only HUMAN-READABLE text is keyword-matched. The child id used to be fed in
  // as a last resort, but an opaque id is not a role hint — with 'test' now a QA
  // keyword (see SUB_ROLE_WORDS) any id containing it would silently become QA.
  const own = String(sub?.label || sub?.name || '').toLowerCase();
  // 2) role id inside parentheses (validated), then 3) label keywords
  const fromOwn = roleFromParenthesis(own) || roleFromWords(own);
  if (fromOwn) return fromOwn;
  // 4) workflow delegation label recovered from the PARENT session log.
  //    workflow-spawned children carry an EMPTY descriptor label in the live
  //    registry, so `own` is empty above — and a card-based fallback cannot see
  //    runs that were interrupted. See workflowEventIndex().
  const wf = (wfLabels instanceof Map) ? wfLabels.get(String((sub && sub.id) || '')) : null;
  if (!wf) return '';
  const wfHay = `${String(wf.label || '')} ${String(wf.phase || '')}`.toLowerCase();
  return roleFromParenthesis(wfHay) || roleFromWords(wfHay);
}
// A child's role never changes, and reading its log is the expensive path —
// cache once per child session id ('' entries are cached too, to avoid re-reads).
const SUB_ROLE_LOG_CACHE = new Map();
// ── 每请求的"子会话日志读取"预算（2026-09-15）──────────────────────────────────
// 诊断建议改成"真流式：读到首条 user/message 即停"。**做不到，且不假装做到**：
// 宿主公开 API（`sessionQuery.readSession/listEvents/filterEvents/readEvent`）**没有**
// 投影/限量/流式参数 —— `projectionMode` 只存在于内部 `corpus.read`，公开方法不暴露；
// `filterEvents`/`readEvent` 也都是"先把整条日志 load 进内存再筛"。要"只读首帧"只能绕过
// 公开接口去碰持久化层的内部方法（`readFirstZstdLine` 之类），那是**非契约、脆的**。
// ⇒ 采用**有界**做法：每次 /state 最多读 N 条子会话日志（角色结果**永久缓存**），其余留到下一个 tick。
// **这不是"优化成流式"，而是"把一次 20 秒的尖峰摊平"**，并把"本轮被推迟"的条数如实交给
// 调用方（rolesDeferred）⇒「还没解析」与「解析不出来」两件事分得清
// （本仓纪律：两种零必须可区分），**不臆造角色**。
//
// ⚠️ 2026-09-15 第二轮（profile 实测 roles 段 0.6–0.9 s、且 `deferred` 从 16 涨到 40 之后）：
// 旧实现每请求都把候选集**从零重算**，预算永远花在队首那几条上，而新派的人不断出现在队尾
// ⇒ **进度不前进、deferred 只增不减**（"限次摊平"退化成"永远摊不完"）。
// 现在改成**跨请求保留进度**：每次按"当前 subs 里仍未缓存"的顺序**重建队列**（已缓存的自动掉队、
// 既有顺序保留），再从队首消费 ≤N 条 ⇒ 进度单调推进，`deferred` 单调不增（除非真的又新派了人）。
const ROLE_READ_BUDGET_PER_REQUEST = 4;
let ROLE_READS_LEFT = ROLE_READ_BUDGET_PER_REQUEST;
/** 待解析队列（跨请求保留进度）：元素是子会话 id。 */
let ROLE_PENDING = [];

// ── 有界化策略（2026-09-15 第三轮）─────────────────────────────────────────────
// 真机基线（30+ 子代理的重会话）：`people,feed` 单发 5.4–9.2 s，其中 subs 2.9–3.7 s、roles 2.4–5.5 s，
// **两段都没有上限**。本轮的目标不是"更快"，而是"**有界**"：
//   · subs  ：枚举整棵 sessions 树很贵 ⇒ 两次之间至少 N 秒（默认 **120 s**；第四轮从 30 s 抬高：
//             真正贵的 `subagents.listChildren()` 内部**无条件**做全库枚举，已挪到后台预热
//             （见 `SUB_ROWS_MEMO`），这个窗口现在同时管"预热刷新"与"rescue 枚举"两件事）；
//   · roles ：读 MB 级子会话日志很贵且**不紧急** ⇒ 实时路径默认**不读**，未知角色如实显示为
//             "待解析"（`rolesPending`），解析交给低频后台（每轮 ≤N 条、两次间隔 ≥N 秒）；
//             已解析结果**永久缓存**（已结束会话的角色不可变）⇒ pending 单调下降并收敛到 0。
// 纪律（1.3.22 精确化，**别再把两者混成一句**）：
//   · **真截断**（软期限到点 / 读失败）⇒ `degraded`（告警）；
//   · **按设计的能力上限**（`MAX_ROLE_SUBS` / `MAX_FEED_AGENTS`，"我们主动只处理前 N 条"）⇒
//     `scopeCaps`（数字照发，**不是**故障）—— 否则真机 95 agent 时降级标记每轮常亮，
//     真告警被一起降权（常亮的告警等于没有告警）。
//   而"还没解析"（pending）与"解析不出来"（unresolved）仍是两个数（两种零要分得清）。
const SUBS_ENUM_MIN_INTERVAL_MS = Math.max(0, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_SUBS_ENUM_MIN_INTERVAL_MS) || 0) || 120000);
const SUBS_ENUM_DEADLINE_MS = Math.max(50, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_SUBS_DEADLINE_MS) || 0) || 800);
const ROLES_READ_MIN_INTERVAL_MS = Math.max(0, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_MIN_INTERVAL_MS) || 0) || 30000);
const ROLES_READ_PER_BURST = Math.max(1, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_PER_BURST) || 0) || 1);
const ROLES_READ_DEADLINE_MS = Math.max(50, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_DEADLINE_MS) || 0) || 600);
// ── 后台批**自己的**闸（2026-09-16 第四轮）─────────────────────────────────────
// 真机 1.3.23 实测的怪现象：`rolesPending` 每 **30.4 s** 才降 1（89 个积压 ⇒ 约 45 分钟），
// 而 13 个成员目录合计只有 **5.6 MiB** —— 瓶颈**不是**日志读得慢。
// 根因：这个**没人等它**的后台批却沿用了请求路径的两个旋钮 —— `ROLES_READ_PER_BURST`（=1 条/批）
// 与 `ROLES_READ_MIN_INTERVAL_MS`（=30 s 才允许踢一次）⇒ **30 s / 条**，恰好等于实测值。
// 请求路径早就不读角色日志了（`maxReads: 0`），所以那两个数字对请求路径已无意义，
// 对后台批则是纯粹的瓶颈 —— "宁慢勿并"在这里退化成了"慢到等于没做"。
// 新口径：后台批按**自己的**墙钟预算连续推进，但每读 `ROLES_WARM_CHUNK` 条就**让出事件循环**。
// 为什么必须让出：这些读是 CPU 密集型（zstd 解码 + 会话重放 + 逐事件克隆）且跑在**同一个
// 事件循环**上；只把预算调大而不让出，就会把请求的收尾顶掉（1.3.22 实测："挪到后台后总耗时
// 仍 444 ms"，时间只是从 `wfLabels` 换到 `assemble` 记账 —— **时间没有消失**）。
const ROLES_WARM_MIN_INTERVAL_MS = Math.max(0, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_WARM_MIN_INTERVAL_MS) || 0) || 2000);
const ROLES_WARM_BUDGET_MS = Math.max(50, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_WARM_BUDGET_MS) || 0) || 8000);
const ROLES_WARM_MAX_READS = Math.max(1, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_WARM_MAX_READS) || 0) || 240);
const ROLES_WARM_CHUNK = Math.max(1, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_WARM_CHUNK) || 0) || 1);
const ROLES_WARM_YIELD_MS = Math.max(0, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_WARM_YIELD_MS) || 0) || 0);
// "空列表 + 宿主还没就绪"最多被标成 `warming` 多久；超过就把"还没就绪"这句话**收回**，
// 交给 `subsPending` 如实表达"这些成员拿不到明细"。理由见 `SUB_HEADER_STATS.notReady`。
const SUBS_NOT_READY_MAX_MS = Math.max(200, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_SUBS_NOT_READY_MAX_MS) || 0) || 120000);
let SUBS_ENUM_LAST_AT = 0;
let ROLES_READ_LAST_AT = 0;
let ROLES_WARM_LAST_AT = 0;
const ROLE_READ_STATS = { cut: '' };
// 角色日志读的**后台**批（2026-09-16）：请求路径不再读任何日志，全部由这一个单飞后台批推进。
// `ROLE_WARM_RUNNING` 是全进程级（同时只允许一个后台读批）：并发全量读日志曾把事件循环压死
// （真机 283.6 s 冷态的老根因之一），所以这里**宁慢勿并**。
let ROLE_WARM_RUNNING = false;
// `noProgress` = "后台批**有活、有期限，却一条都没读成**"。它是**真故障**（进 `degraded`），
// 不是"按设计的上限"（那走 `scopeCaps`），也不是"刷新在飞"（那是 `warming`）。
// 为什么必须单独记账：1.3.22 的那个回归里，`ROLE_READ_STATS.cut='deadline'` **从不进 `cutFacts`**
// ⇒ 一次真实的功能损失既没进 degraded、也没进任何可见字段，只剩一个**不会动的**"待解析"计数
// ⇒ 看起来和"正常等待"一模一样。**没有账本，故障就只能是隐性的。**
// `chunks`/`yields`：一批分了几块、让出事件循环几次 —— 没有这两个数，"一批到底干了多少活"
// 就只能靠推断（1.3.23 那个"30 s 才 1 条"的怪现象正是靠"每批只读 1 条"这条账本才定位到的）。
const ROLE_WARM_STATS = { warms: 0, errors: 0, warmMs: 0, noProgress: false, noProgressAt: 0, lastReads: 0, lastQueued: 0, yields: 0, chunks: 0 };
/**
 * **请求路径**上取 workflow 事件索引的正式入口（/state 用这个）。
 *   · 已有快照（不管新不新）⇒ **一次都不等**：直接返回快照 + 需要时踢后台刷新（stale 时明示 ageMs）；
 *   · 从没有过快照 ⇒ 踢后台并**有界**等 `WF_EVENT_FIRST_DEADLINE_MS`（保住首屏"派工即可见"），
 *     等不到就如实标 warming（`state='missing'`），绝不无限等那次全量读。
 */
async function workflowEventIndexForRequest(ctx, sid) {
  const key = String(sid || '');
  if (!key || WF_EVENT_CACHE.has(key)) return workflowEventIndexCached(ctx, key);
  WF_EVENT_STATS.firstWaits += 1;
  const t0 = Date.now();
  const p = warmWorkflowEventIndex(ctx, key, { immediate: true });
  if (p) {
    let timer = null;
    await Promise.race([
      p.then(() => {}, () => {}),
      new Promise((r) => { timer = setTimeout(r, WF_EVENT_FIRST_DEADLINE_MS); if (timer && typeof timer.unref === 'function') timer.unref(); }),
    ]);
    if (timer) clearTimeout(timer);
    WF_EVENT_STATS.firstWaitMs = Date.now() - t0;
    if (!WF_EVENT_CACHE.has(key)) WF_EVENT_STATS.firstWaitTimeouts += 1;
  }
  return workflowEventIndexCached(ctx, key);
}
/** 仅供测试：复位后台角色读批的标记与计数。 */
function _resetRoleWarm() {
  ROLE_WARM_RUNNING = false;
  ROLE_WARM_STATS.warms = 0; ROLE_WARM_STATS.errors = 0; ROLE_WARM_STATS.warmMs = 0;
  ROLE_WARM_STATS.noProgress = false; ROLE_WARM_STATS.noProgressAt = 0;
  ROLE_WARM_STATS.lastReads = 0; ROLE_WARM_STATS.lastQueued = 0;
  ROLE_WARM_STATS.yields = 0; ROLE_WARM_STATS.chunks = 0;
  ROLES_WARM_LAST_AT = 0;
}
/** 本轮允许枚举吗（节流窗口）？ */
function subsEnumAllowed(now) { return (Number(now) - SUBS_ENUM_LAST_AT) >= SUBS_ENUM_MIN_INTERVAL_MS; }
/**
 * 本轮允许读几条角色日志（低频后台；0 = 如实显示"待解析"）。
 * ⚠️ **请求路径已不再用它**（`maxReads: 0`，零日志读）。保留它只为兼容既有测试与旧调用点；
 * 后台批现在走**自己的**闸 `rolesWarmAllowed()` + `ROLES_WARM_*`（见那组常量的注释：
 * 沿用这两个旋钮正是"30 s 才解析 1 个"的根因）。
 */
function roleReadAllowance(now) { return (Number(now) - ROLES_READ_LAST_AT) >= ROLES_READ_MIN_INTERVAL_MS ? ROLES_READ_PER_BURST : 0; }
/**
 * 后台批的踢出闸：两次批之间至少隔 `ROLES_WARM_MIN_INTERVAL_MS`。
 * 为什么还要闸：批与批之间若毫无间隔，一旦"读到 0 条"（读失败不写缓存）就会变成**忙转**，
 * 把 `warming` 变成常亮标记。闸只挡"频繁踢"，不再挡"一批读多少" —— 后者由预算决定。
 */
function rolesWarmAllowed(now) { return (Number(now) - ROLES_WARM_LAST_AT) >= ROLES_WARM_MIN_INTERVAL_MS; }
function _resetBoundedState() { SUBS_ENUM_LAST_AT = 0; ROLES_READ_LAST_AT = 0; ROLE_READ_STATS.cut = ''; SUB_HEADER_STATS.cut = ''; _resetRoleWarm(); }
/** /state 每次进来复位**本请求的读取额度**（队列进度**不**复位）。 */
function resetRoleReadBudget() { ROLE_READS_LEFT = ROLE_READ_BUDGET_PER_REQUEST; }
/**
 * 按当前 subs 重建待解析队列：保留既有顺序里"仍在场且仍未缓存"的，再把新出现的未缓存 id 追加到队尾。
 * 幂等、无副作用；已缓存（含"解析不出来"缓存为 ''）的条目自动掉队。
 *
 * ⚠️ `cap`（2026-09-16，修"待解析永远停在 35"）：只把**前 `cap` 条**纳入队列。
 * 为什么必须有它：硬上限 `MAX_ROLE_SUBS`（默认 60）之外的成员**按设计永不做日志解析**，
 * 但请求路径过去用**全量** subs 重建队列 ⇒ 队列里永远躺着那批永不被读的 id ⇒ `rolesPending`
 * 排空后**永久停在 35**（= 超出上限的条数），而同一次响应里没有任何东西说明"这 35 个是按设计
 * 跳过的"；更糟的是 `roleWarmHasWork()` 因此恒为真 ⇒ `warming:['roles']` 变成**常亮**，
 * 且每轮都踢一个"注定读 0 条"的批 —— 正是本仓最忌讳的"报进行中却没有进行"。
 * 现在：队列与 `rolesPending` 只算**可解析**的那些（能真的归零），被上限挡住的条数由
 * `scopeCaps.roles`（over/limit/total）在**同一份响应里**如实解释。
 */
function syncRolePending(subs, cap) {
  const list = (Number.isFinite(cap) && cap > 0) ? (subs || []).slice(0, cap) : (subs || []);
  const present = new Set();
  for (const s of list) { const id = String((s && s.id) || ''); if (id) present.add(id); }
  const seen = new Set();
  const next = [];
  for (const id of ROLE_PENDING) {
    if (SUB_ROLE_LOG_CACHE.has(id) || !present.has(id) || seen.has(id)) continue;
    seen.add(id); next.push(id);
  }
  for (const s of list) {
    const id = String((s && s.id) || '');
    if (!id || seen.has(id) || SUB_ROLE_LOG_CACHE.has(id)) continue;
    seen.add(id); next.push(id);
  }
  ROLE_PENDING = next;
  return ROLE_PENDING;
}
/** 仅供测试：清空待解析队列（生产代码不需要调用它）。 */
function _resetRolePending() { ROLE_PENDING = []; }
function roleReadBudgetSnapshot() {
  // deferred = **还没解析**（队列里等着读的）；unresolved = **解析不出来**（读过但日志里没有角色）。
  // 两者必须是两个数：本仓纪律"两种零要分得清"。
  let unresolved = 0;
  for (const v of SUB_ROLE_LOG_CACHE.values()) if (!v) unresolved += 1;
  return { per: ROLE_READ_BUDGET_PER_REQUEST, left: ROLE_READS_LEFT, deferred: ROLE_PENDING.length, unresolved };
}
/**
 * Infer a child's role from its own session log. **Only the first `user/message`
 * counts** — it is the delegation prompt the lead passed, e.g.
 * 「你是「专家团」的产品分析员（product-analyst，动态补位角色）…」. Later messages are
 * runtime context / skill catalogs whose prose mentions roles in passing and
 * would produce false matches (observed: 'non-experimental', 'url', QA→pm).
 * The keyword pass is therefore limited to the head of that one message.
 * Best-effort: any read failure leaves the role unknown.
 */
async function roleFromChildLog(ctx, id) {
  if (!id) return '';
  if (SUB_ROLE_LOG_CACHE.has(id)) return SUB_ROLE_LOG_CACHE.get(id);
  // 预算用尽 ⇒ 本轮不读，**且不写缓存**（下一个 tick 再试）。这是"本轮被推迟"，
  // 不是"解析不出来" —— 调用方通过 rolesDeferred（队列长度）如实区分两者（两种零可区分）。
  if (ROLE_READS_LEFT <= 0) { return ''; }
  ROLE_READS_LEFT -= 1;
  let role = '';
  try {
    const q = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null;
    if (q && typeof q.readSession === 'function') {
      const snap = await q.readSession(id);
      const events = (snap && (snap.events || snap.log)) || [];
      let text = '';
      for (const ev of events) {
        if (!ev || ev.type !== 'user/message') continue;
        const d = ev.data || ev;
        const c = (d.message && d.message.content) || d.content || [];
        text = Array.isArray(c)
          ? c.map((b) => (b && typeof b === 'object' ? b.text || '' : String(b || ''))).join(' ')
          : String(c || '');
        break; // first user message only
      }
      if (text) role = roleFromParenthesis(text) || roleFromWords(text.slice(0, 160));
    }
  } catch (e) { /* best-effort */ }
  SUB_ROLE_LOG_CACHE.set(id, role);
  return role;
}
/**
 * Recover per-child delegation labels AND per-run completeness from the PARENT
 * session's own event stream.
 *
 * Why this exists: `workflow`-spawned children carry an EMPTY descriptor label in
 * the live registry, so a label-only match leaves the roster at 「未启动」 while
 * agents run. The client falls back to the rendered workflow CARD's labels — but a
 * card only exists when the workflow tool call RETURNED a durable result. A turn
 * interrupted mid-fan-out (the user types while the fan-out is in flight) leaves no
 * card at all, so those children could never be resolved: on 2026-09-11 this
 * session listed 「另有 22 个活子代理未能解析出角色」 and every one of them belonged
 * to an interrupted run.
 *
 * `tool-workflow/*` events are durable regardless, so reading them here recovers:
 *   · label/phase → childId → role (same keyword pass as everywhere else), and
 *   · run completeness → a run with **no `run-end`** never returned a result
 *     (the turn was interrupted, or the process exited). That is the honest
 *     answer to 「任务为什么会中断」, which the card cannot give — no card exists.
 *
 * Cached for WF_EVENT_TTL_MS so the poll loop does not re-read a multi-MB log every
 * tick, while a run that finishes mid-session still converges within a tick.
 * Best-effort: any read failure yields empty results (never throws).
 */
// ⚠️ 2026-09-15 性能诊断：TTL 原为 **3000ms，恰好等于默认轮询间隔 3000ms** ⇒ **每个 tick 必失效**，
// 父会话日志（多 MB）被一遍遍全量重读，这是热态 7.1–9.8 s 的主要来源之一。现改为 30000ms：
// TTL 只是**兜底**（理想是按日志 mtime/size 失效，留待后续），代价是"run 在会话中途结束"最多晚
// 30 秒反映到面板 —— 与"每 3 秒重读整个日志"相比，这个交换值得。
const WF_EVENT_TTL_MS = 30000;
const WF_EVENT_CACHE = new Map(); // sessionId -> { at, labels: Map, runs: [] }
// ⚠️ 2026-09-16 真机性能诊断（第二处"不受任何预算管辖的重读"）：
// `workflowChildLabels(ctx, peopleSid)` 是**直接 await** 的（旧的 /state 处理器第 6048 行），
// 而它的实现是 `sessionQuery.readSession(父会话)` ＝ **全量读一遍多 MB 的父会话日志**。
// TTL 30 s 只是"多久允许重读一次"，**不是期限**：TTL 一到点的那个请求就得把这次全量读付满
// （同机实测 `profile.wfLabels` = 803–2683 ms；真机 1.3.20 窗口重开一发 1.196 s）。
// 修法与 `SUB_ROWS_MEMO`/`warmSubRows` 同口径：**请求路径只读内存**，重读挪到后台单飞预热。
// 于是 TTL 过期不再表现为"这一发卡 1–3 秒"，而是"这一发立刻返回上一份完整快照 + 如实标 warming"。
const WF_EVENT_INFLIGHT = new Map(); // sessionId -> Promise（同刻只跑一个）
const WF_EVENT_STATS = { warms: 0, warmErrors: 0, readErrors: 0, warmMs: 0, memoFresh: 0, memoStale: 0, misses: 0, firstWaits: 0, firstWaitMs: 0, firstWaitTimeouts: 0 };
/** 仅供测试：清空 workflow 事件备忘与在飞标记。 */
function _resetWfEventMemo() { WF_EVENT_CACHE.clear(); WF_EVENT_INFLIGHT.clear(); }
/**
 * "从没有过快照"的那**一轮**最多等多久。与 `warmSubRows` 的"首次基线按期限等一小会儿"同口径：
 * 首屏"派工即可见"（成员归属）依赖 wfLabels，等一小会儿能保住它；但**有界**——
 * 真机上这次全量读要 0.8–2.7 s，等满它就把性能修复又还回去了。等不到 ⇒ 如实标 warming，下一轮就有。
 */
const WF_EVENT_FIRST_DEADLINE_MS = Math.max(50, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_WF_FIRST_DEADLINE_MS) || 0) || 800);
/**
 * ⚠️ **后台预热必须晚于"触发它的那一发响应"**（2026-09-16 同机 A/B 实测的教训）：
 * 把全量读从请求路径挪走**还不够** —— 那次读是**CPU 密集型**（zstd 解码 + `Session.create`
 * 重放校验 + 逐事件克隆），跑在**同一个事件循环**上。请求在 kick 之后还要 await 若干文件 I/O，
 * 于是后台读会抢在请求收尾之前把循环占住，请求照样被拖（实测：`wfLabels` 步 0 ms，但
 * `assemble` 步 441 ms —— 时间没消失，只是换了个地方计入）。
 * 所以后台批统一**延迟一小段**再开跑：那一刻当前请求早已响应完毕，重读落在两次轮询
 * （people,feed 至少 6 s 一次）的间隙里。冷启动那一次例外（调用方本来就在等它）。
 */
function wfWarmDelayMs() {
  const raw = Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_WF_WARM_DELAY_MS) || 0);
  return Math.max(0, Number.isFinite(raw) && raw > 0 ? raw : 1000);
}
function rolesWarmDelayMs() {
  const raw = Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ROLES_WARM_DELAY_MS) || 0);
  return Math.max(0, Number.isFinite(raw) && raw > 0 ? raw : 1000);
}
/**
 * @param {{force?: boolean}} [opts] `force=true` 时**跳过 TTL 直接重读**（后台预热专用）。
 */
async function workflowEventIndex(ctx, sid, opts) {
  const key = String(sid || '');
  if (!key) return { labels: new Map(), runs: [] };
  const hit = WF_EVENT_CACHE.get(key);
  const force = !!(opts && opts.force);
  if (!force && hit && (Date.now() - hit.at) < WF_EVENT_TTL_MS) return hit;
  const labels = new Map();
  const runs = new Map();
  // 「最近一次 workflow 调用从脚本里抽出的 run 目录名」—— `tool/call` 事件在
  // `tool-workflow/run-start` **之前**出现，而 `run-start` 只带宿主 UUID（`randomUUID`），
  // 与 `team/<slug>` 目录名**恒不相等** ⇒ 必须在这里按调用顺序把它记下来，供 `run-start` 归属。
  let lastRunDir = '';
  // `team/` 下的**目录名**集合（惰性读一次，仅用于噪声过滤：脚本里出现的 `/team/<slug>`
  // 可能是注释/示例/别的路径 ⇒ 只认确实是 run 目录的那些）。判据与 `listRunsInWorkspace`
  // 逐字同源：**只要目录**（`team/` 根下还住着 `CODEINDEX.json` 这类普通文件）。
  let runDirNames = null;
  // 读成功与否必须分开记：`readSession` 抛错时下面得到的是**空 labels/runs**，那不是
  // "这个会话没有 workflow 事件"。拿空结果当基线覆盖已有快照，就是本仓反复记录的
  // "两种零分不清"（同 `SUB_ROWS_MEMO` 的空基线纪律）。
  let readOk = false;
  let readerAvailable = false;
  try {
    const q = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : null;
    if (q && typeof q.readSession === 'function') {
      readerAvailable = true;
      const snap = await q.readSession(key);
      readOk = true;
      for (const ev of (snap && (snap.events || snap.log)) || []) {
        // workflow 的 `tool/call` 在 `tool-workflow/run-start` **之前**出现，其 `arguments`
        // （JSON 字符串）里的 `script` 逐字写着本次 run 的目录：`const RUN = ROOT + '/team/<slug>'`。
        // 这里先把「最近一次 workflow 调用指向的 run 目录」抽出来（`tool/call` 不是
        // `tool-workflow/` 前缀 ⇒ 必须**先于**下一行的前缀过滤处理，否则永远看不到它）。
        // 抽不到 / 核不上 ⇒ `lastRunDir` 保持 `''` ⇒ 下游第①道一律拒（行为与从前逐字一致）。
        if (ev && ev.type === 'tool/call' && ev.data && ev.data.name === 'workflow') {
          lastRunDir = '';
          if (runDirNames === null) {
            runDirNames = new Set();
            try {
              const ws = cwdFromSession(ctx, key);
              for (const ent of (ws ? await readdir(teamRoot(ws), { withFileTypes: true }) : [])) {
                if (ent && typeof ent.isDirectory === 'function' && ent.isDirectory() === true) runDirNames.add(String(ent.name));
              }
            } catch { /* 读不到 ⇒ 空集合 ⇒ 一律核不上（保持 ''）⇒ 与从前一致，宁可拒 */ }
          }
          try {
            const args = JSON.parse(String((ev.data.arguments === undefined || ev.data.arguments === null) ? '' : ev.data.arguments));
            const script = (args && typeof args.script === 'string') ? args.script : '';
            const m = /\/team\/([^/'"`\s\\]+)/.exec(script);
            const slug = m ? m[1] : '';
            // 噪声过滤：`/team/<slug>` 也可能是注释/示例/别的路径 ⇒ 只认**确实是 `team/` 下的目录名**。
            if (slug && runDirNames.has(slug)) lastRunDir = slug;
          } catch { /* `arguments` 不是 JSON / 不是字符串 ⇒ 静默跳过（保持 ''） */ }
          continue;
        }
        if (!ev || typeof ev.type !== 'string' || ev.type.indexOf('tool-workflow/') !== 0) continue;
        const d = ev.data || ev;
        const runId = String(d.runId || '');
        if (!runId) continue;
        let r = runs.get(runId);
        if (!r) { r = { runId, name: '', started: 0, settled: 0, stopReason: '', childIds: [], startedAt: 0, endedAt: 0, settledSeq: {}, runDir: '' }; runs.set(runId, r); }
        const kind = ev.type.slice('tool-workflow/'.length);
        const t = Number(ev.time) || 0;
        if (kind === 'run-start') { r.name = String(d.name || ''); if (t) r.startedAt = t; r.runDir = lastRunDir; }
        else if (kind === 'agent-start') {
          r.started += 1;
          const cid = String(d.childId || '');
          if (cid) {
            r.childIds.push(cid);
            // first start wins: a child is never re-labelled
            if (!labels.has(cid)) labels.set(cid, { label: String(d.label || ''), phase: String(d.phase || ''), runId, seq: Number(d.seq) || 0, startedAt: t, settled: false, runDir: r.runDir || '' });
          }
        } else if (kind === 'agent-end') {
          r.settled += 1;
          // agent-end carries the same `seq` as its agent-start ⇒ per-child settlement.
          // A child with a start but NO end never reported a result (interrupted fan-out):
          // that is what the panorama must paint red, not "running forever".
          const seq = Number(d.seq) || 0;
          if (seq) r.settledSeq[seq] = String(d.outcome || 'completed');
        } else if (kind === 'run-end') { r.stopReason = String(d.stopReason || 'completed'); if (t) r.endedAt = t; }
      }
    }
  } catch (e) { /* best-effort */ }
  // 读失败 ≠ "这个会话没有 workflow 事件"。**不许**用空结果覆盖已有的非空快照
  // （同 `SUB_ROWS_MEMO` 的空基线纪律）：保住旧快照、**不刷新 `at`**（下一个 tick 再试）。
  // 从没有过快照时只能如实给空值 —— 调用方据返回值里的 `state='missing'` 标 warming，
  // 而不是把它当成"确实没有 run"（那是本仓最忌讳的假零）。
  if (readerAvailable && !readOk) {
    WF_EVENT_STATS.readErrors += 1;
    if (hit) return hit;
  }
  // 把 per-child 结算结果回填到 labels（agent-end 可能晚于 agent-start 到达）
  for (const r of runs.values()) {
    for (const cid of r.childIds) {
      const hit = labels.get(cid);
      if (hit && hit.runId === r.runId && r.settledSeq[hit.seq]) { hit.settled = true; hit.outcome = r.settledSeq[hit.seq]; }
    }
  }
  const out = { at: Date.now(), labels, runs: [...runs.values()] };
  WF_EVENT_CACHE.set(key, out);
  return out;
}
/**
 * 后台预热 workflow 事件索引（**单飞**：同一会话同刻只跑一个）。
 * 调用方**不许 await 它** —— 它的存在就是为了把"多 MB 父会话日志的全量读"从请求路径上摘掉。
 * 失败只记计数器、绝不抛（后台任务不许产生 unhandled rejection）。
 */
function warmWorkflowEventIndex(ctx, sid, opts) {
  const key = String(sid || '');
  if (!key) return null;
  const inflight = WF_EVENT_INFLIGHT.get(key);
  if (inflight) return inflight;
  // `immediate`：调用方**本来就在等**这次读（冷启动的有界首等），没必要再让它多等一个延迟。
  const delay = (opts && opts.immediate) ? 0 : wfWarmDelayMs();
  WF_EVENT_STATS.warms += 1;
  const t0 = Date.now();
  const p = new Promise((resolve, reject) => {
    setTimeout(() => { workflowEventIndex(ctx, key, { force: true }).then(resolve, reject); }, delay);
  })
    .then((v) => { WF_EVENT_STATS.warmMs = Date.now() - t0; WF_EVENT_INFLIGHT.delete(key); return v; })
    .catch((e) => { WF_EVENT_STATS.warmErrors += 1; WF_EVENT_INFLIGHT.delete(key); throw e; });
  p.catch(() => {});
  WF_EVENT_INFLIGHT.set(key, p);
  return p;
}
/**
 * **请求路径上**的 workflow 事件索引：只读内存，零次全量日志读。
 *
 * @returns {{labels: Map, runs: Array, state: 'fresh'|'stale'|'missing', refreshing: boolean, at: number, ageMs: number}}
 *   · `state='fresh'`  备忘在 TTL 内 ⇒ 数据完整且新鲜，**不许**标 warming；
 *   · `state='stale'`  备忘过期 ⇒ 已踢一次后台刷新，本轮返回的是**上一份完整快照**；
 *   · `state='missing'` 从没有过快照 ⇒ 本轮**没有** workflow 元数据（不是"没有 run"）。
 *   `refreshing=true` 表示此刻确有后台刷新在飞 ⇒ 调用方应把该分段如实标为 warming。
 *   注意 warming 的判据是"**真的有刷新在飞**"，不是"备忘过期"：否则一个 30 s TTL 配 6 s 轮询
 *   会让 warming 变成常亮标记（那正是本仓反复警告的"把告警变成噪声"）。
 */
function workflowEventIndexCached(ctx, sid) {
  const key = String(sid || '');
  if (!key) return { labels: new Map(), runs: [], state: 'fresh', refreshing: false, at: 0, ageMs: 0 };
  const hit = WF_EVENT_CACHE.get(key);
  const ageMs = hit ? Math.max(0, Date.now() - hit.at) : 0;
  const fresh = !!hit && ageMs < WF_EVENT_TTL_MS;
  if (fresh) {
    WF_EVENT_STATS.memoFresh += 1;
    return { labels: hit.labels, runs: hit.runs, state: 'fresh', refreshing: WF_EVENT_INFLIGHT.has(key), at: hit.at, ageMs };
  }
  if (hit) WF_EVENT_STATS.memoStale += 1; else WF_EVENT_STATS.misses += 1;
  warmWorkflowEventIndex(ctx, key);   // 不 await：这一发**不等**全量读
  return {
    labels: hit ? hit.labels : new Map(),
    runs: hit ? hit.runs : [],
    state: hit ? 'stale' : 'missing',
    refreshing: WF_EVENT_INFLIGHT.has(key),
    at: hit ? hit.at : 0,
    ageMs,
  };
}
/**
 * Plain-JSON view of `childId → {label, phase, runId, seq, startedAt, settled, outcome}`.
 * This is the panorama's **layering source**: workflow-spawned children have NO session
 * header (so `createdAt` is 0 for all of them, which is exactly why the flow view used to
 * degrade to "无创建时间记录，无法分批"), but their `agent-start` events carry a real
 * wall-clock `time` — measured 1ms apart inside one fan-out and ~25s between fan-outs.
 *
 * `idx`（可选）= 调用方已经拿到的 `workflowEventIndexCached(...)` 结果。处理器 `/state` **必须**传它：
 * 不传就会退回 `await workflowEventIndex` ⇒ 又把那次全量日志读放回请求路径上（本次要修的东西）。
 */
async function workflowChildMeta(ctx, sid, idx) {
  const { labels } = idx || await workflowEventIndex(ctx, sid);
  const out = {};
  for (const [cid, v] of labels) {
    out[cid] = { label: v.label, phase: v.phase, runId: v.runId, seq: v.seq, startedAt: v.startedAt, settled: v.settled === true, outcome: v.outcome || '' };
  }
  return out;
}
/** childId → {label, phase, runId} for every `workflow`-spawned child of `sid`. */
async function workflowChildLabels(ctx, sid) {
  return (await workflowEventIndex(ctx, sid)).labels;
}
/**
 * Every `workflow` run recorded in `sid`'s log, with an honest fate verdict.
 * `status`: completed | failed | interrupted | running.
 *   · run-end present                                          → completed / failed
 *   · no run-end, some child still running in the LIVE registry → running
 *   · no run-end, nothing running                               → interrupted
 * `unsettled = started - settled` counts legs that never reported a result.
 * `idx`（可选）= 已算好的索引；处理器 `/state` **必须**传（同 `workflowChildMeta` 的理由）。
 */
async function workflowRuns(ctx, sid, subs, idx) {
  const { runs } = idx || await workflowEventIndex(ctx, sid);
  const running = new Set((subs || []).filter((s) => s && s.activity === 'running').map((s) => String(s.id || '')));
  return runs.map((r) => {
    const unsettled = Math.max(0, r.started - r.settled);
    let status;
    if (r.stopReason) status = r.stopReason === 'completed' ? 'completed' : 'failed';
    else if (r.childIds.some((c) => running.has(c))) status = 'running';
    else status = 'interrupted';
    return { runId: r.runId, name: r.name, started: r.started, settled: r.settled, unsettled, stopReason: r.stopReason, status, startedAt: r.startedAt || 0, endedAt: r.endedAt || 0, childIds: r.childIds.slice() };
  });
}
/**
 * Fill `sub.role` for live subagents whose own label yields no role.
 *
 * ⚠️ 这里必须**写回 `s.role`**，不能只用 `roleOfSub(s, wfLabels)` 当"已知就跳过"的判据：
 * 那样一来"靠父会话事件流 label 能解析出来"的子代理会被 continue 掉、`s.role` 永远是空，
 * 结果是**恰好反了**——能解析的全部留空，解析不出的那批反而被下一段子会话日志兜底填上。
 * （2026-09-11 真实踩到：30 个子代理里只有 5 个有角色，正是 wfLabels 解析不出的那 5 个。）
 */
async function resolveSubRoles(ctx, subs, wfLabels, opts) {
  // 有界化：调用方决定本轮最多读几条（0 = 只查便宜来源与缓存，缺的如实显示为"待解析"）
  // 以及墙上期限；不传则保持原行为（每请求 ROLE_READ_BUDGET_PER_REQUEST 条、无期限）。
  const maxReads = (opts && Number.isFinite(opts.maxReads)) ? opts.maxReads : ROLE_READ_BUDGET_PER_REQUEST;
  const deadlineAt = (opts && Number.isFinite(opts.deadlineAt)) ? opts.deadlineAt : Infinity;
  // 队列只看**可解析**的前 N 条（= 硬上限）。`0`/不传 ⇒ 不过滤（测试与旧调用点的既有语义）。
  const queueCap = (opts && Number.isFinite(opts.queueCap) && opts.queueCap > 0) ? opts.queueCap : 0;
  const byId = new Map();
  for (const s of subs || []) { const id = String((s && s.id) || ''); if (id) byId.set(id, s); }
  // ① 便宜来源（自带 label / 父会话事件流 label）与已缓存结果 —— **不花预算、不读日志**
  for (const s of subs || []) {
    try {
      const known = roleOfSub(s, wfLabels);
      if (known) { if (!s.role) s.role = known; continue; }
      const id = String((s && s.id) || '');
      if (!id) continue;
      if (SUB_ROLE_LOG_CACHE.has(id)) {
        const cached = SUB_ROLE_LOG_CACHE.get(id);
        if (cached && !s.role) s.role = cached;
      }
    } catch (e) { /* best-effort */ }
  }
  // ② 跨请求推进：重建待解析队列（保留进度、已缓存的掉队、新人追加到队尾），再消费本请求额度。
  //    这样 `deferred`（队列长度）只减不增，除非真的又新派了人 —— 旧实现每请求从零重算，
  //    预算永远喂给队首同几条，新派的人永远轮不到（实测 deferred 16 → 40）。
  //    `queueCap`：只把前 N 条（= 硬上限内**可解析**的）纳入队列，否则 `rolesPending` 会永久
  //    停在"超出上限的条数"上（见 `syncRolePending` 的注释）。
  syncRolePending(subs, queueCap);
  let reads = 0;
  while (reads < maxReads && ROLE_READS_LEFT > 0 && ROLE_PENDING.length) {
    if (Date.now() > deadlineAt) { ROLE_READ_STATS.cut = 'deadline'; break; }
    const id = ROLE_PENDING.shift();
    if (SUB_ROLE_LOG_CACHE.has(id)) continue;
    const r = await roleFromChildLog(ctx, id);
    if (!SUB_ROLE_LOG_CACHE.has(id)) { ROLE_PENDING.unshift(id); break; } // 预算耗尽（未写缓存）⇒ 放回队首，下一轮继续
    const s = byId.get(id);
    if (s && r && !s.role) s.role = r;
    reads += 1;
  }
  if (reads) ROLES_READ_LAST_AT = Date.now();   // 本轮流过日志 ⇒ 进入节流窗口（下次至少 N 秒后）
  // 给**后台批**据实记账这一批到底干了什么（调用方据此判"零进展"，见 `ROLE_WARM_STATS`）。
  // ⚠️ 用调用方传进来的对象承载，**不写模块级字段**：并发的请求会互相覆盖，而"这一批读了几条"
  // 恰恰是 1.3.22 那次功能损失唯一能暴露它的证据 —— 记账本身必须无竞态。
  if (opts && opts.stats && typeof opts.stats === 'object') {
    opts.stats.reads = reads;
    opts.stats.queued = ROLE_PENDING.length;
    opts.stats.cut = ROLE_READ_STATS.cut;
  }
  return subs;
}
/**
 * 队列里**还有没被缓存过的 id** 吗？＝"真的有活可做"。
 * 队列非空 ≠ 有活：剩下的可能全是已缓存的 id（读它们只是查表）。本仓纪律是
 * "`warming` = 真有刷新在飞" ⇒ 没有未缓存 id 就既不许踢批、也不许挂 warming。
 */
function roleWarmHasWork() {
  for (const id of ROLE_PENDING) if (!SUB_ROLE_LOG_CACHE.has(id)) return true;
  return false;
}
/**
 * 后台把"角色解析的那几次子会话日志读"从请求路径上摘下来（2026-09-16）。
 *
 * 为什么必须摘：`ROLES_READ_DEADLINE_MS` 的期限检查在**每次读之前**（见 `resolveSubRoles` 的
 * `while` 循环），所以它只能拦住"**下一次**读"，拦不住"**正在进行**的那一次读**"。
 * 而单条子会话日志的全量读在重会话上是 **179–2023 ms** 量级（真机 1.3.20 实测）——
 * 于是"窗口重开"那一发就白等了这一整读。请求路径改成只走便宜来源 + 缓存（`maxReads: 0`），
 * 真正读日志这件事挪到本函数：**单飞**（全进程同刻最多一个后台读批）。
 *
 * 调用方**不许 await**。请求这一轮缺的角色由 `rolesPending`（"还没解析"，跨轮会推进）与
 * `warming`（"此刻确有刷新在飞"）分别如实表达 —— 两者都不是"解析不出来"。
 *
 * ⚠️ **期限从"批真正开跑"那一刻起算**（2026-09-16，修 1.3.22 的真回归）：
 * 旧实现由调用方传**绝对** deadline（`Date.now() + ROLES_READ_DEADLINE_MS`，默认 600 ms），
 * 而本批要延迟 `rolesWarmDelayMs()`（默认 1000 ms）才开跑 ⇒ **1000 > 600 恒成立** ⇒
 * `resolveSubRoles` 的循环在**第一次读之前**就 `cut='deadline'` break ⇒ **一条都不读**、
 * 队列永不前进。所以现在调用方传的是**时长**（`deadlineMs`），绝对期限在批开跑时才计算；
 * 额度（`ROLE_READS_LEFT`）同理挪进开跑那一刻 —— 否则中间插入的请求会把它复位成 0，
 * 本批就"有期限却零读"（同一个坑换个入口）。**任何"注定做不了活"的路径都不许挂 `warming`。**
 *
 * ⚠️ **一批读几条由本批自己的预算决定，不再沿用请求路径的额度**（2026-09-16 第四轮）：
 * 真机 1.3.23 实测 `rolesPending` 每 **30.4 s** 才降 1（89 个积压 ≈ 45 分钟），而语料只有 5.6 MiB
 * —— 根因就是这里沿用了 `ROLES_READ_PER_BURST`(1) × `ROLES_READ_MIN_INTERVAL_MS`(30 s)。
 * 现在：`ROLES_WARM_BUDGET_MS` 墙钟预算 + `ROLES_WARM_MAX_READS` 条数上限 + 每
 * `ROLES_WARM_CHUNK` 条**让出事件循环**（`ROLES_WARM_YIELD_MS`）。让出**不是可选项**：
 * 这些读是 CPU 密集型且跑在同一个事件循环上，不让出就会顶掉请求的收尾（1.3.22 的老坑）。
 *
 * ⚠️ **两个"耗时"不是一回事，别并列比较**（2026-09-16 口径更正）：
 *   · 「事件循环停顿」（例如 CHANGELOG 里那句"分块让出时最大停顿 41 ms"）= 一次分块解码**占住循环**多久；
 *   · 「请求端到端时延」（真机 `wfIndex` 从 `stale→fresh` 那两发量到 0.6 s 左右）= 从收到请求到写出响应，
 *     **其中包含** `WF_EVENT_FIRST_DEADLINE_MS`(800 ms) 的**有界首等** —— "等"不是"卡"。
 *   把两者并列会得出"慢了一个数量级"的错误结论。另：那个 41 ms **不可复现**（apparatus 未保留），
 *   引用它必须带上"事件循环停顿"这个定义域。
 *
 * @returns {Promise|null} 真的踢了一次预热 ⇒ Promise；已有后台批在跑 / 无事可做 ⇒ `null`。
 */
async function runRoleWarmChunks(ctx, subs, wfLabels, o) {
  while (o.stats.reads < o.maxReads) {
    if (Date.now() > o.deadlineAt) { ROLE_READ_STATS.cut = ROLE_READ_STATS.cut || 'deadline'; break; }
    const want = Math.min(o.chunk, o.maxReads - o.stats.reads);
    // 本批自己垫额度。请求路径已不读日志（`maxReads: 0`），不会跟本批抢这笔额度；
    // 而"请求把额度复位成 0"曾让本批"有期限却零读"，这里每分块前重新垫上，彻底堵掉那个入口。
    ROLE_READS_LEFT = Math.max(ROLE_READS_LEFT, want);
    const chunkStats = { reads: 0, queued: ROLE_PENDING.length, cut: '' };
    await resolveSubRoles(ctx, subs, wfLabels, { maxReads: want, deadlineAt: o.deadlineAt, stats: chunkStats, queueCap: o.queueCap });
    o.stats.reads += chunkStats.reads;
    o.stats.queued = chunkStats.queued;
    if (chunkStats.cut) o.stats.cut = chunkStats.cut;
    o.stats.chunks += 1;
    // 本分块**零进展** ⇒ 收工（队列被读空 / 读失败没写缓存 / 额度耗尽，都不该忙转）。
    if (chunkStats.reads === 0) break;
    if (o.stats.reads >= o.maxReads || Date.now() > o.deadlineAt) break;
    o.stats.yields += 1;
    await new Promise((r) => setTimeout(r, ROLES_WARM_YIELD_MS));   // 让出事件循环，别顶掉请求的收尾
  }
  return null;
}
function warmSubRoles(ctx, subs, wfLabels, opts) {
  if (ROLE_WARM_RUNNING) return null;
  // 不传 `maxReads` ⇒ 用**后台批自己的**条数上限（旧实现默认 0 = "不干活"，那是请求路径的语义；
  // 被当成后台批的默认值就会"踢了批却什么都不做"）。显式传 0 仍表示"不踢"（既有测试依赖这条）。
  const maxReads = (opts && Number.isFinite(opts.maxReads)) ? opts.maxReads : ROLES_WARM_MAX_READS;
  if (!(maxReads > 0)) return null;
  if (!ROLE_PENDING.length) { ROLE_WARM_STATS.noProgress = false; return null; } // 队列空 ⇒ 没有可做的活
  if (!roleWarmHasWork()) { ROLE_WARM_STATS.noProgress = false; return null; }   // 队列里全是已缓存的 ⇒ 也没活
  ROLE_WARM_RUNNING = true;
  ROLE_WARM_STATS.warms += 1;
  const t0 = Date.now();
  const delay = (opts && opts.immediate) ? 0 : rolesWarmDelayMs();
  // ⚠️ 只认**时长**：传绝对时刻会让"延迟"与"期限"两个数字互相打架（1.3.22 的回归就是这么来的）。
  const budgetMs = (opts && Number.isFinite(opts.deadlineMs)) ? opts.deadlineMs : ROLES_WARM_BUDGET_MS;
  const chunk = (opts && Number.isFinite(opts.chunk) && opts.chunk > 0) ? opts.chunk : ROLES_WARM_CHUNK;
  const queueCap = (opts && Number.isFinite(opts.queueCap) && opts.queueCap > 0) ? opts.queueCap : 0;
  const stats = { reads: 0, queued: ROLE_PENDING.length, cut: '', yields: 0, chunks: 0 };
  const p = new Promise((resolve, reject) => {
    setTimeout(() => {
      // 开跑那一刻才算期限（见函数头注释）；额度由 `runRoleWarmChunks` 每分块自己垫。
      runRoleWarmChunks(ctx, subs, wfLabels, { maxReads, deadlineAt: Date.now() + budgetMs, chunk, queueCap, stats }).then(resolve, reject);
    }, delay);
  })
    .then((r) => {
      ROLE_WARM_STATS.warmMs = Date.now() - t0;
      ROLE_WARM_STATS.lastReads = stats.reads;
      ROLE_WARM_STATS.lastQueued = stats.queued;
      ROLE_WARM_STATS.yields = stats.yields;
      ROLE_WARM_STATS.chunks = stats.chunks;
      // "有活、有预算，却一条都没读成" = **真故障**（不是按设计的上限，也不是"刷新在飞"）。
      // 记下来由调用方经 `classifyStateShortfall` 送进 `degraded`；而**恢复后必须自灭**：
      // 任何一批真读到东西、或队列被读空（全是缓存命中＝进度已到位），都清掉这盏灯。
      if (stats.reads > 0 || stats.queued === 0) { ROLE_WARM_STATS.noProgress = false; }
      else { ROLE_WARM_STATS.noProgress = true; ROLE_WARM_STATS.noProgressAt = Date.now(); }
      // 无论读了几条，本批结束后都进入踢出闸的窗口：否则"读到 0 条"（例如读失败没写缓存）
      // 会让每个 tick 都再踢一次、把 warming 变成常亮标记。
      ROLES_READ_LAST_AT = Date.now();
      ROLES_WARM_LAST_AT = Date.now();
      ROLE_WARM_RUNNING = false;
      return r;
    })
    .catch((e) => { ROLE_WARM_STATS.errors += 1; ROLES_READ_LAST_AT = Date.now(); ROLES_WARM_LAST_AT = Date.now(); ROLE_WARM_RUNNING = false; return null; });
  p.catch(() => {});
  return p;
}
// sub rows → Map<role, sub> (first match wins; unknown labels map to '' and
// are exposed as extra rows so the overlay can show unassigned workers).
function mapRoleToSub(subs, wfLabels) {
  const m = new Map();
  for (const s of subs || []) {
    const role = roleOfSub(s, wfLabels);
    if (!m.has(role)) m.set(role, s);
  }
  return m;
}

// Enrich roster members with live subagent status (running/idle/ready, model,
// current activity) so the overlay can show how many agents were dispatched and
// what each is doing — not just "—". `subById` is the role→sub map from
// mapRoleToSub().
function enrichMembers(runId, roles, rosterMembers, subById, rosterAgents) {
  const agents = rosterAgents || {};
  const seed = hashStr(String(runId));
  const out = {};
  for (const role of roles) {
    const sub = (subById instanceof Map) ? subById.get(role) : undefined;
    const idx = Math.max(roles.indexOf(role), 0);
    const fixed = agents[role] || {};
    const nm = fixed.name || AGENT_NAMES[(seed + idx) % AGENT_NAMES.length];
    const col = fixed.color || AGENT_COLORS[(seed + idx * 3) % AGENT_COLORS.length];
    if (sub) {
      const mid = String(sub.id || '');
      out[role] = { id: mid, active: true, name: nm, color: col, initial: agentInitial(nm), activity: sub.activity || '', mode: sub.mode || '', model: sub.model || '', running: sub.running === true, label: String(sub.label || sub.name || mid || '') };
    } else {
      const mid = rosterMembers && typeof rosterMembers[role] === 'string' ? rosterMembers[role] : '';
      out[role] = { id: mid, active: false, name: nm, color: col, initial: agentInitial(nm), activity: '', mode: '', model: '', running: false, label: '' };
    }
  }
  return out;
}

// `PHASES` 已搬到 `lib/vocab.js`（B 线 11b）—— 阶段词表同时被日志解析、看板、校验器使用，
// 散成两份就会出现"解析器认、校验器不认"这类静默跳过。

function taskList(tasks) {
  if (Array.isArray(tasks)) return tasks;
  if (tasks && Array.isArray(tasks.tasks)) return tasks.tasks;
  return [];
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildCanvasHtml({ runId, goal, state, roster, tasks, subagents, dir, cwd, watch }) {
  const taskArr = taskList(tasks);
  const byStatus = new Map();
  for (const t of taskArr) {
    const st = (t.status ?? 'pending');
    if (!byStatus.has(st)) byStatus.set(st, []);
    byStatus.get(st).push(t);
  }
  const statuses = ['pending', 'in_progress', 'done', 'rework', 'blocked', 'complete'];
  const boardCols = statuses.filter((s) => byStatus.has(s)).concat([...byStatus.keys()].filter((s) => !statuses.includes(s)));
  const memberRows = roster?.members ? Object.entries(roster.members) : [];
  const subById = new Map(subagents.map((s) => [s.id, s]));

  const rosterCards = (roster?.roles ?? []).map((role) => {
    const val = roster?.members?.[role];
    const sub = subById.get(val);
    const status = sub ? (`${activityZh(sub.activity ?? '')}${sub.mode ? ' · ' + modeZh(sub.mode) : ''}`) : (typeof val === 'string' ? val : (val === undefined ? '—' : JSON.stringify(val)));
    return `<div class="card role">
      <div class="role-h"><span class="role-name">${esc(roleZh(role))}</span><span class="badge">${esc(status)}</span></div>
      <div class="role-meta">${sub ? `id: ${esc(sub.id)}` : (val ? esc(val) : '未启动')}</div>
    </div>`;
  }).join('');

  const boardHtml = boardCols.map((st) => {
    const cards = byStatus.get(st) ?? [];
    const cardsHtml = cards.map((t) => `<div class="card task">
      <div class="task-h">${esc(t.id ?? '')} <span class="badge">${esc(statusZh(t.status))}</span></div>
      <div class="task-t">${esc(t.title ?? t.spec ?? '')}</div>
      <div class="task-meta">负责人：${esc(roleZh(t.owner))}${t.dependsOn ? ` · 依赖: ${esc(Array.isArray(t.dependsOn) ? t.dependsOn.join(', ') : t.dependsOn)}` : ''}${t.verdict ? ` · 裁决: ${esc(verdictZh(t.verdict))}` : ''}</div>
    </div>`).join('');
    return `<div class="col"><h3>${esc(statusZh(st))} <span class="count">${cards.length}</span></h3>${cardsHtml || '<div class="empty">—</div>'}</div>`;
  }).join('');

  const phaseIdx = PHASES.indexOf(state?.phase ?? '');
  const stepper = PHASES.map((p, i) => `<li class="${i === phaseIdx ? 'cur' : (i < phaseIdx ? 'done' : '')}">${esc(phaseZh(p))}</li>`).join('');

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>专家团画布 · ${esc(runId)}</title>
<style>
  :root { --bg:#f5f7fb; --card:#fff; --line:#e2e6ee; --ink:#1b2430; --muted:#66707f; --accent:#3b6ef5; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; background:var(--bg); color:var(--ink); padding:20px; }
  .wrap { max-width:1200px; margin:auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .meta { color:var(--muted); font-size:13px; line-height:1.6; }
  .path { display:flex; flex-wrap:wrap; gap:6px; list-style:none; padding:0; margin:14px 0; }
  .path li { font-size:12px; padding:4px 10px; border:1px solid var(--line); border-radius:14px; color:var(--muted); background:#fff; }
  .path li.done { background:#eef4ff; border-color:#c8daff; color:var(--accent); }
  .path li.cur { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  section { margin-top:18px; }
  h2 { font-size:15px; margin:0 0 10px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .role-h, .task-h { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:13px; font-weight:600; }
  .role-name { text-transform:capitalize; }
  .badge { font-size:11px; font-weight:500; color:var(--muted); background:var(--bg); border:1px solid var(--line); padding:2px 7px; border-radius:10px; white-space:nowrap; }
  .role-meta, .task-meta, .task-t { font-size:12px; color:var(--muted); margin-top:4px; line-height:1.5; }
  .task-t { color:var(--ink); }
  .board { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; align-items:start; }
  .col { background:#fbfcfe; border:1px solid var(--line); border-radius:10px; padding:10px; min-height:80px; }
  .col h3 { font-size:13px; margin:0 0 8px; display:flex; align-items:center; justify-content:space-between; }
  .count { font-size:11px; color:var(--muted); }
  .empty { color:var(--muted); font-size:12px; }
  .hint { color:var(--muted); font-size:12px; margin-top:16px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🧑‍🔬 专家团画布</h1>
  <div class="meta">
    <div>run：<code>${esc(runId)}</code></div>
    <div>目标：${esc(goal)}</div>
    <div>阶段：${esc(phaseZh(state?.phase))} / 状态：${esc(statusZh(state?.status))}${state?.mode ? ' · 模式：' + esc(modeZh(state.mode)) : ''}${state?.deliverable ? ' · 交付：' + esc(deliverZh(state.deliverable)) : ''}</div>
  </div>
  <ol class="path" id="path">${stepper}</ol>
  <section><h2>团队编制 <span class="live" id="live-ts"></span></h2><div class="cards" id="roster">${rosterCards || '<div class="empty">（暂无成员）</div>'}</div></section>
  <section><h2>任务看板</h2><div class="board" id="board">${boardHtml || '<div class="empty">（暂无任务）</div>'}</div></section>
  <div class="hint">本画布由 <code>/team canvas</code> 动态生成（数据源：${esc(dir)}）。任务/成员状态随各阶段推进更新；想刷新就再跑一次 <code>/team canvas</code>。${watch ? ` <b>── 当前为 live 模式：每 ${Math.round(canvasPollMs() / 1000)} 秒轮询 host 状态接口自动刷新。</b>` : ''}</div>
</div>
${watch ? watchScript(runId, cwd, canvasPollMs()) : ''}
</body>
</html>`;
}

// Renders self-contained JS for `--watch`: polls the host state route
// (md-preview-style host HTTP endpoint, avoiding typert Remotes) and live-updates
// the phase stepper, roster cards and task board. Falls back silently if the
// route is unavailable (e.g. webServer not mounted).
function watchScript(runId, cwd, pollMs) {
  // 1.3.4：轮询间隔来自设置 `display.pollMs`（此前是写死的 3000）。
  const per = Number.isFinite(Number(pollMs)) && Number(pollMs) >= 1000 ? Math.round(Number(pollMs)) : 3000;
  const base = '"/plugins/dsh-expert-team/state"';
  const stateUrl = `(${base}+"?cwd="+encodeURIComponent(${JSON.stringify(cwd)})+"&run="+encodeURIComponent(${JSON.stringify(runId)}))`;
  return `<script>
(function(){
  var URL = ${stateUrl};
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function t(tasks){return Array.isArray(tasks)?tasks:(tasks&&Array.isArray(tasks.tasks)?tasks.tasks:[]);}
  var M={phase:${JSON.stringify(PHASE_ZH)},status:${JSON.stringify(STATUS_ZH)},role:${JSON.stringify(ROLE_ZH)},kind:${JSON.stringify(KIND_ZH)},verdict:${JSON.stringify(VERDICT_ZH)},mode:${JSON.stringify(MODE_ZH)},activity:${JSON.stringify(ACTIVITY_ZH)}};
  function L(k,v){v=String(v==null?'':v);return v?(M[k]&&M[k][v]?M[k][v]:v):'—';}
  function render(d){
    try{
      var ph=['clarify','research','design','spec-review','方案确认','implement','review','test','deliver'];
      var idx=ph.indexOf(d.phase);
      var steps=ph.map(function(p,i){return '<li class="'+(i===idx?'cur':(i<idx?'done':''))+'">'+esc(L('phase',p))+'</li>';}).join('');
      var path=document.getElementById('path'); if(path) path.innerHTML=steps;
      var st=document.getElementById('live-ts'); if(st){st.textContent='· live 更新 '+new Date().toLocaleTimeString();}
      var meta=document.querySelector('.meta div:nth-child(3)'); if(meta) meta.innerHTML='阶段：'+esc(L('phase',d.phase))+' / 状态：'+esc(L('status',d.status))+' · 模式：'+esc(d.mode?L('mode',d.mode):'');
      var roles=d.roles||[]; var members=d.members||{};
      var rc=roles.map(function(r){return '<div class="card role"><div class="role-h"><span class="role-name">'+esc(L('role',r))+'</span><span class="badge">'+esc(members[r]?L('activity',members[r].activity||''):'—')+'</span></div></div>';}).join('');
      var board=document.getElementById('roster'); if(board) board.innerHTML=rc||'<div class="empty">（暂无成员）</div>';
      var order=['pending','claimed','in_progress','done','rework','blocked','failed','cancelled','completed'];
      var arr=t(d.tasks); var by={}; arr.forEach(function(x){var s=x.status||'pending'; (by[s]=by[s]||[]).push(x);});
      var cols=order.filter(function(s){return by[s];});
      if(!cols.length) cols=['pending'];
      var bh=cols.map(function(s){var cs=(by[s]||[]).map(function(x){return '<div class="card task"><div class="task-h">'+esc(x.id||'')+' <span class="badge">'+esc(L('status',x.status))+'</span></div><div class="task-t">'+esc(x.title||x.spec||'')+'</div><div class="task-meta">负责人：'+esc(L('role',x.owner))+(x.dependsOn?' · 依赖: '+esc(String(Array.isArray(x.dependsOn)?x.dependsOn.join(','):x.dependsOn)):'')+(x.verdict?' · 裁决: '+esc(L('verdict',x.verdict)):'')+'</div></div>';}).join('');
        return '<div class="col"><h3>'+esc(L('status',s))+' <span class="count">'+((by[s]||[]).length)+'</span></h3>'+(cs||'<div class="empty">—</div>')+'</div>';}).join('');
      var bb=document.getElementById('board'); if(bb) bb.innerHTML=bh||'<div class="empty">（暂无任务）</div>';
    }catch(e){}
  }
  function poll(){ fetch(URL).then(function(r){if(!r.ok)return null;return r.json();}).then(function(d){if(d)render(d);}).catch(function(){}); }
  poll(); setInterval(poll, ${per});
})();
</script>`;
}

async function renderCanvas(ctx, invocation, cwd, runArg, watch) {
  const root = teamRoot(cwd);
  const dir = await pickRunDir(root, runArg);
  if (!dir) return { kind: 'error', text: '还没有 run，无画布可渲染。用 /team <task> 组队。' };
  const runId = basename(dir);
  const state = await readJsonSafe(join(dir, 'STATE.json'));
  if (!state) return { kind: 'error', text: `run "${runId}" 缺少 STATE.json（可能被清理或损坏）。` };
  const roster = await readJsonSafe(join(dir, 'ROSTER.json'));
  const tasks = await readJsonSafe(join(dir, 'TASKS.json'));
  const goal = await readFile(join(dir, 'TASK.md'), 'utf8').catch(() => '');
  const goalLine = goal.split('\n').find((l) => /^>\s*目标/.test(l))?.replace(/^>\s*目标：\s*/, '') || (goal.split('\n').find((l) => /^>\s*目标/.test(l)) ?? '').replace(/^>\s*目标[：:]\s*/, '') || '';
  const subagents = await listSubagentStatus(ctx, invocation);
  const html = buildCanvasHtml({ runId, goal: goalLine, state, roster, tasks, subagents, dir, cwd, watch });
  const canvasPath = join(dir, '画布.html');
  await ARTIFACT.must(canvasPath, html);
  const nTasks = taskList(tasks).length;
  return {
    kind: 'success',
    text: [
      `已生成画布：${canvasPath}`,
      `- 阶段：${phaseZh(state.phase)}/${statusZh(state.status)}`,
      `- 编制：${(roster?.roles ?? []).join(', ') || '—'}`,
      `- 任务：${nTasks}`,
      `- 打开：在聊天里点上面的文件行，或浏览器打开该路径；刷新后再跑一次即时更新。`,
    ].join('\n'),
  };
}









// Tolerate both the strict `role=backend verdict=rework` form AND the natural
// prose form real runs often write (e.g. `architect 完成(designMarkdown+...)` or
// `backend 完成但契约不一致（返工）`). Without this the role-result metrics in
// /team learn under-count badly, since real RUN.log lines are frequently prose.





// Core aggregation: read every real run's STATE + RUN.log, derive metrics, refresh
// METRICS.md (idempotent snapshot) and refresh LEARNINGS.md by **replacing** the
// same-day `## <date> 自动蒸馏（/team learn）` block in place (so re-runs and the
// overlay's auto-calls never stack duplicate experience, and hand-written sections
// survive). Returns numbers for the caller to render.
async function aggregate(cwd) {
  const root = teamRoot(cwd);
  // D4：只有「目录 + 含 STATE.json / TASK.md / RUN.log.md 任一」才算真 run。
  // 旧实现直接 `readdir(root)`，把 METRICS.md / LEARNINGS.md / REPOWIKI.md /
  // CODEINDEX.json 也当 run 计入分母 ⇒ 用户看到「总 run 数：8」（真实 2）。
  const listed = await listRunNames(root);
  if (!listed.ok) return { runs: 0, completed: 0, runsWithLogs: 0, reworkRate: 0, errors: 0, asks: 0, decisions: 0, learned: 0, changed: false, skipped: 0 };
  const { names, skipped } = listed;

  const phases = new Map();    // phase -> started count
  const roles = new Map();     // role -> {pass, rework, fail, logOnly?}（**权威 = 任务派生**，R9）
  const logRoles = new Map();  // role -> {pass, rework, fail}（日志判决；R15：按 run 判定后才累加）
  // R15：`taskRolesInRun` 必须**按 run 局部**（下面每轮 `clear()`）。它曾声明在 run 循环外 ⇒
  // 某角色在 A run 有任务，就会吞掉 **B run** 的日志判决、并让 B run 的 `role:*` ticks 进不了
  // 「仅日志参与」行 —— 正好打掉 R1/R9 要救的场景（workflow 扇出没回写 TASKS.json）。
  // 角色行仍是**跨 run 汇总**（既有语义不变），变的只是「该角色在**本 run** 是否有任务」的判定域。
  const taskRolesInRun = new Set();
  const roleTicks = new Map(); // role -> `role:<角色>` 事件数（原始；用于把它从「未参与」里剔除）
  const tickNoTask = new Map();// role -> 「本 run 无任务」时的 tick 数 ⇒ 这才是「仅日志参与」的分子
  const rosterSeen = new Set();// 各 run ROSTER 声明的角色（「未参与」行的分母）
  const errors = new Map();    // `error[:子类]` -> {count, sample}
  const asks = new Map();      // `ask[:子类]`   -> {count, sample}
  const decisions = new Map(); // `decision[:来源]` -> {count, sample}
  // E 线 E3：「见一个，扫全部」的单源化总扫登记（`scan:single-source`，SKILL §7.34）。
  // 为什么要进 METRICS：这条义务没有代码能强制，只有**让它可见**才不至于沦为口号
  //（本包"D7：函数写出来了但没人调用"就是这么被发现的）。
  const scans = new Map();     // `scan[:子类]` -> {count, sample}
  // 设计稿 §十二 的验收指标：返工里「单源化类」的占比（真实基线 9/14 = 64%，目标 ≤30%）。
  const ssAgg = { repairs: 0, singleSource: 0 };
  let completed = 0;
  let runsWithLogs = 0;
  let reworkRuns = 0;
  // C 线（减返工）· 「未闭环」单独记账：跑完但**没收口**的任务不计入返工率，
  // 因此必须在这里单独可见 —— 否则"返工率不高"会把"其实没交付完"盖住。
  // 依据：Qoder 九样本里有一次会话结束时仍有 3 项被审查标为「必修」的缺陷未闭环，
  // 而这类"跑完但没收口"完全不计入返工率（`docs/Qoder对标/08-九样本返工相关性.md` §3.4）。
  const closureUnsettled = new Map(); // runName -> [taskId…]（非终态）
  const closureCancelled = new Map(); // runName -> [taskId…]
  const closureCancelReason = new Map(); // runName -> 记录的范围决策（空串 = 未记录原因）
  const closureUnverified = new Map(); // runName -> [repairId…]（有修复但无独立复验）
  // C 线第 15 项：返工**性质分解**（四个桶，合计 = 有日志的 run 数；不改上面那个率）
  let reworkEnvOnly = 0;
  let reworkProcessOnly = 0;
  let reworkBoth = 0;
  let reworkNoEvidence = 0;
  const reworkSourceTally = new Map(); // 返工证据来源 -> 命中 run 数（批 2-6：口径可审计）
  // P4（SPEC §1.5）：评审效率节 —— 轮次（review/test 各取最大）、自报 finding 数、显式撤销数。
  let maxReviewRound = 0;
  let maxTestRound = 0;
  let reportedFindings = 0;
  let revertedFindings = 0;
  // R20（C11）：`retractedSum` 只累计**真的上报过 `retracted`** 的那些任务 —— 用来区分两种"零"
  //（SG-4）：「自报了 N 条但一条撤销都没登记」≠「压根没人登记」。
  let retractedSum = 0;
  // B-08C：撤销率的**覆盖面**（分子分母各来自多少个质量任务）—— 覆盖率必须随行渲染，因为
  // "覆盖率低"正是这个指标最容易被误读的地方（拿 2 个有数据的任务当全部 run 的撤销率）。
  let coveredTasks = 0;     // 贡献了分母的质量任务数（走了分支 1 或分支 2）
  let qualityTaskCount = 0;  // 全部质量任务数
  // E 线 E1：「首个可运行产物」（SKILL §7.32）—— 度量 `first-runnable` − `run:started`。
  // 三个数**分别**记：`没登记` 与 `登记了但算不出` 是两件事，合成一个数就再也分不开
  //（本仓在撤销率上吃过这个亏：两种零必须可区分）。
  const firstRunnableSamples = []; // [{run, minutes}]（只含算得出的）
  let firstRunnableUnparsable = 0; // 写了 first-runnable 但算不出（缺 run:started / 时间戳非 HH:MM:SS）
  // E 线 E2：「收尾预算」（SKILL §7.33）—— 冻结后追加的阶段 ≤ 实现期 × 50%。
  // 三种缺失**分别**记（与 E1 同一个道理：「没记账」与「算不出」混在一起就再也分不开）。
  const closingRows = [];   // [{run, implementMinutes, closingMinutes}]（两段都算得出的）
  let closingMissing = 0;   // 有起点但没有 review/test 阶段事件 ⇒ 分不开（真实 run 正是这种）
  let closingNoStart = 0;   // 既无 first-runnable 也无 phase:implement ⇒ 起点缺失（≠ 没有收尾）
  let closingNoPhases = 0;  // **零**阶段事件（这一桶才叫"未登记"；有阶段事件就不该进这里）
  let closingNoDeliver = 0; // 有起点有冻结点、尚未交付 ⇒ 收尾还没结束（不算"分不开"）

  for (const n of names) {
    const { dir, state, log, tasksDoc, rosterDoc } = await readRunInputs(root, n);
    for (const r of (Array.isArray(rosterDoc && rosterDoc.roles) ? rosterDoc.roles : [])) {
      const s = String(r ?? '').trim();
      if (s) rosterSeen.add(s);
    }
    // E1：本 run 的「起点」与「首个可运行产物」时刻。**各取第一条** —— "首个"不能被后写的覆盖。
    let runStartedClock = null;
    let firstRunnableClock = null;
    // E2：本 run 的阶段事件序列（按日志顺序，喂给 `runTimeline` 算三段时长）。
    const phaseEvents = [];

    let sawLog = false, runRework = false, roleResultRework = false, roleTickRework = false, sawError = false;
    // C 线第 15 项：本 run 返工的**性质分解**（只用于分解显示，**不参与** `reworkRuns` 分子）
    let envRework = false, processRework = false;
    const reworkSources = new Set(); // 本 run 命中的返工证据来源
    // 批 2-6（N-2 度量口径）：返工判定必须用**真实存在的证据**（多源、可审计）。
    const taskArr = Array.isArray(tasksDoc && tasksDoc.tasks) ? tasksDoc.tasks : [];
    const isRepairTask = (t) => !!(t && (String(t.kind || '') === 'repair' || /^repair[-_]/i.test(String(t.id || ''))));
    // R15：**每个 run 重算**「本 run 有任务的角色」——日志判决/ticks 的去重判定域是 run，不是工作区。
    taskRolesInRun.clear();
    for (const t of taskArr) {
      const r = normalizeRoleName(String((t && t.owner) || ''));
      if (r) taskRolesInRun.add(r);
    }
    // D1/D2/D3：按**事件族**匹配（真实日志写 `error:<子类>` / `decision:<来源>` /
    // `role:<角色>`），旧 `switch (ev.type)` 精确匹配会把这些事件全部漏掉 ⇒
    // METRICS 恒报「无 error 事件 / 无决策记录」，角色结果与日志脱节。
    for (const line of log.split('\n')) {
      const ev = parseLogLine(line);
      if (!ev) continue;
      sawLog = true;
      const fam = eventFamily(ev.type);
      if (fam === 'phase') {
        // R7：阶段名归一 —— `phase:research:started` → `research`；`phase:implement` → `implement`；
        // 而 `phase:started` / `phase:completed` 这两种兼容写法**必须从 detail 取真阶段名**
        // （`design (architect)` ⇒ `design`），取不到就跳过 —— 否则会造出 `started`/`completed`
        // 这种伪阶段，把「阶段覆盖」这一节污染成无意义的计数。
        const sub = ev.type.slice(6);
        const head = sub.split(':')[0];
        let phaseName = head;
        if (!head || head === 'started' || head === 'completed') {
          const dm = String(ev.detail ?? '').match(/([A-Za-z][A-Za-z0-9_-]*)/);
          if (!dm) continue; // 取不到真阶段名 ⇒ 不记（不产生伪阶段）
          phaseName = dm[1];
        }
        // R14：阶段名必须落在**既有 `PHASES` 词表**内，不在词表内则跳过该事件 —— 否则
        // `phase:started — 由 backend 开始实现` 会记成伪阶段 `backend`（R7 只是把伪阶段从
        // `started`/`completed` 换成了任意英文词，同样污染「阶段覆盖」这一节）。
        // 词表复用既有常量，不另造一份（两份词表迟早不同步）。
        if (!PHASES.includes(phaseName)) continue;
        phases.set(phaseName, (phases.get(phaseName) ?? 0) + 1);
        // E2：同时留下**带时刻**的阶段序列 —— 「阶段覆盖」只数次数，算时长必须有时刻。
        phaseEvents.push({ phase: phaseName, time: ev.time });
      } else if (fam === 'role') {
        // R2：`verdict=` 一旦出现就**只认 token**，无法识别的 token 不计判决、**绝不回落 prose**
        // （真实 run 里 `verdict=needs_revision；…通过 10…` 曾被 prose 正则提升成 pass）。
        // R9 + R15：日志判决只有当该角色在**本 run** 的 TASKS.json 里没有任何任务时才计入角色行
        // （否则同一次返工会被任务与日志各计一次，实测 reviewer 3+3）；判定域是 **run**，不是
        // 工作区 —— A run 有任务不得吞掉 B run 的日志判决。run 级返工证据（下面的 flag）不受此限。
        if (ev.type === 'role:result') {
          // 兼容既有 prose 约定（role:result 从没人写，但历史 run 里有）：
          // 没有 `verdict=` 时才走 `extractVerdict` 的 prose 推断（smoke.test.mjs 依赖它）。
          const role = normalizeRoleName(extractRole(ev.detail));
          const tok = verdictFromToken(ev.detail);
          const verdict = tok === null ? extractVerdict(ev.detail) : tok;
          const countIt = role && !taskRolesInRun.has(role); // R15：本 run 无任务才计角色行
          const b = logRoles.get(role) ?? { pass: 0, rework: 0, fail: 0 };
          if (verdict === 'rework') { if (countIt) b.rework++; runRework = true; roleResultRework = true; }
          else if (verdict === 'fail') { if (countIt) b.fail++; runRework = true; roleResultRework = true; }
          else if (verdict === 'pass' && countIt) b.pass++;
          if (countIt) logRoles.set(role, b);
        } else {
          // `role:<角色名>` = 进度事件：只记 tick；**仅当 detail 含显式 `verdict=`
          // 才计判决**（不得由 prose 推断 pass，避免虚增）。
          // R11：角色名归一（`role:pm(repair)` → `pm`，不再产生幽灵桶）。
          const role = normalizeRoleName(ev.type.slice(5)) || 'unknown';
          roleTicks.set(role, (roleTicks.get(role) ?? 0) + 1);
          // R15：只有「本 run 无任务」的 tick 才进「仅日志参与」行（有任务的角色已由任务派生行代表）。
          if (!taskRolesInRun.has(role)) tickNoTask.set(role, (tickNoTask.get(role) ?? 0) + 1);
          const verdict = verdictFromToken(ev.detail); // null（无 verdict=）与 ''（token 不认识）都不计判决
          if (verdict) {
            const countIt = !taskRolesInRun.has(role); // R15：按 run 判定
            const b = logRoles.get(role) ?? { pass: 0, rework: 0, fail: 0 };
            // R5：`role:<角色>` 的判决记 `log:role`，不再冒充 `role:result`。
            if (verdict === 'rework') { if (countIt) b.rework++; runRework = true; roleTickRework = true; }
            else if (verdict === 'fail') { if (countIt) b.fail++; runRework = true; roleTickRework = true; }
            else if (verdict === 'pass' && countIt) b.pass++;
            if (countIt) logRoles.set(role, b);
          }
        }
      } else if (fam === 'error') {
        // C1（契约更正）：**只有 error 事件族算返工证据**。返工的定义是「产出被退回
        // 重做」；提问（ask）与拍板（decision）是正常流程 —— 若也计入，任何问过澄清
        // 问题的 run 都会被判「有返工」⇒ 返工率虚高、指标失去区分度。
        tallyEvent(errors, ev.type, ev.detail); runRework = true; sawError = true; // R16：独立登记 log:error
        // C 线第 15 项：顺手记下这个错误族属于"环境/平台"还是"过程"（**只做分解，不改分子**）
        if (classifyErrorFamily(ev.type) === 'env') envRework = true; else processRework = true;
      } else if (fam === 'ask') {
        tallyEvent(asks, ev.type, ev.detail);       // 只收集渲染，不进返工分子（C1）
      } else if (fam === 'decision') {
        tallyEvent(decisions, ev.type, ev.detail);  // 只收集渲染，不进返工分子（C1）
      } else if (fam === 'scan') {
        // E3：单源化总扫登记（只收集渲染 —— 它记的是"该做的动作做了没有"，与返工无关）。
        tallyEvent(scans, ev.type, ev.detail);
      } else if (ev.type === 'run:started') {
        // E 线 E1：run 起点。**只认第一条** —— 恢复/续跑会再写一次 run:started，取最后一条
        // 会把已经跑过的时间吞掉、让「首产物耗时」凭空变短（那是指标的系统性美化，不是测量）。
        if (runStartedClock === null) runStartedClock = ev.time;
      } else if (fam === 'first-runnable') {
        // E 线 E1：首个可运行产物（SKILL §7.32）。同样只认第一条（"首个"）。
        // 子类写法 `first-runnable:<子类>` 经 eventFamily 一并落进本分支 ⇒ 形态可细分而不扩词表。
        if (firstRunnableClock === null) firstRunnableClock = ev.time;
      }
    }
    // E 线 E1：算「首个可运行产物耗时」——`null` 一律记「算不出」，**绝不记 0**
    //（把算不出当 0 会让"没登记"看起来像"很快"，与撤销率那次的两种零是同一个坑）。
    if (firstRunnableClock !== null) {
      const frMinutes = clockDeltaMinutes(runStartedClock, firstRunnableClock);
      if (frMinutes === null) firstRunnableUnparsable += 1;
      else firstRunnableSamples.push({ run: n, minutes: frMinutes });
    }
    // E 线 E2：三段时长（开工 → 实现 → 收尾）。只有**有日志**的 run 才进分母 ——
    // 没有日志的 run 不是"收尾很短"，是"根本没有可读的轨迹"，混进去会让分母说谎。
    if (sawLog) {
      const tl = runTimeline({ started: runStartedClock, phases: phaseEvents, firstRunnable: firstRunnableClock });
      if (tl.implementMinutes !== null && tl.closingMinutes !== null) {
        closingRows.push({ run: n, implementMinutes: tl.implementMinutes, closingMinutes: tl.closingMinutes });
      } else if (tl.firstImplement === null) {
        // **起点缺失**（既无 first-runnable 也无 phase:implement）——这跟"没有收尾"是两回事。
        // 2026-09-13 真实数据修正：原先这一类被归进「未登记 = 一条阶段事件都没写」，
        // 而实测那个 run 明明写了 5 条阶段事件（research/design/review/test/deliver）⇒ 文案说谎。
        closingNoStart += 1;
        if (phaseEvents.length === 0) closingNoPhases += 1; // 零阶段事件才叫"未登记"（单独计数）
      } else if (tl.firstClosing === null) {
        // 有起点、没有 review/test ⇒ **分不开**（真实 run 的 3h35m 收尾就是这样隐形的）。
        // 这里刻意**不**退化成「收尾 = 实现期起点 → deliver」：那会把实现期一起算进收尾，
        // 数字看着更"完整"，实际是把两件事焊成一件 —— 正是本仓头号缺陷类的形状。
        closingMissing += 1;
      } else {
        // 有起点、有冻结点，缺的只能是交付时刻（还没交付）——如实单独计数，不混进上面任何一桶。
        closingNoDeliver += 1;
      }
    }
    // 批 2-6（N-2 度量口径）：返工判定必须用**真实存在的证据**。
    // 旧实现只看 RUN.log 的 role:result 事件与 error 事件 —— 而 LOGGING 约定**从不写** role:result，
    // ⇒ 返工恒 0、角色结果恒空。用户同时看到「返工率 0%」与 RETRO 里的 3 轮返工时，
    // 会把所有权重信号一起降权。现改为多源判定，并记录命中了哪些源（可审计）。
    // 来源名沿用既有 `log:error|role:result`（不破坏既有断言）；`log:error` 只由
    // **error 事件族**触发（C1：ask / decision 不计入返工证据）。
    // R5：`role:<角色>` 的判决走**新来源名 `log:role`** —— 日志里根本没有 `role:result`
    // 事件时，报 `log:error|role:result` 等于伪造证据来源（用户按图索骥找不到那一行）。
    // R16：`log:error` 改为 error 命中即**独立登记**，与 `log:role` / `log:error|role:result`
    // 可并存（旧写法 `if (!roleResultRework && !roleTickRework && runRework)` 是互斥的 ⇒
    // 真实 php/school run 有 7 条 error 却在口径行里完全不出现，用户无法审计）。
    // 注意：这里只改**口径行的可见性**，不改返工率分子（error 仍算返工证据，C1 裁定）。
    if (roleResultRework) reworkSources.add('log:error|role:result');
    if (roleTickRework) reworkSources.add('log:role');
    if (sawError) reworkSources.add('log:error');
    if (taskArr.some(isRepairTask)) reworkSources.add('tasks:repair');
    { const sh = singleSourceShare(taskArr); ssAgg.repairs += sh.repairs; ssAgg.singleSource += sh.singleSource; }
    if (taskArr.some((t) => Number(t && t.round) > 1)) reworkSources.add('tasks:round>1');
    if (taskArr.some((t) => ['needs_revision', 'fail'].includes(String((t && t.verdict) || '')) || String(t && t.status) === 'failed')) reworkSources.add('tasks:verdict|status');
    // 轮次来源只认 `TASKS.json`（唯一权威，SKILL §7.10）。**不再回退读 `STATE.rounds`**：
    // 该字段**全仓无写路径**（代码从不写它；真实 run 里恒为 `{0,0,0}`，而 `TASKS.rounds`
    // 是 `{3,3,3}`）⇒ 这个回退读到的是永远为零的死值，"两个家一个事实"只会误导审计
    // （`06-审计结论复核.md` 已复现该矛盾）。缺失时按 `{}` 处理：per-task 的
    // `tasks:round>1`（上一行）仍是权威信号，不会因此漏报。
    const roundsDoc = (tasksDoc && tasksDoc.rounds) || {};
    if (['review', 'test', 'repair'].some((k) => Number(roundsDoc[k]) > 1)) reworkSources.add('rounds');
    // ── C 线：未闭环三账（与返工率**分开**统计）────────────────────────────────
    // ① 非终态任务：跑完时仍 pending/claimed/in_progress/rework/blocked ⇒ 其实没交付完；
    // ② 已取消任务：用户叫停或主动放弃的；
    // ③ 有修复但**无独立复验**：该 `repair` 任务之后没有任何**已完成**的质量任务
    //    （review/verification）覆盖到它的轮次 ⇒ 只有实现者自证。判据与 `roundOf` 同源，
    //    不另立口径（本包已在"轮次口径"上吃过一次两套实现的亏）。
    {
      const TERMINAL = new Set(['completed', 'done', 'failed', 'cancelled']);
      const unset = taskArr.filter((t) => t && !TERMINAL.has(String(t.status || ''))).map((t) => String(t.id || '?'));
      const canc = taskArr.filter((t) => t && String(t.status || '') === 'cancelled').map((t) => String(t.id || '?'));
      const qualityDone = taskArr.filter((t) => t
        && isQualityTask(t) // 与轮次门禁同一份 kind 表（`ROUND_LIMIT_OF_KIND`），不另立口径
        && ['completed', 'done'].includes(String(t.status || '')));
      const unver = taskArr
        .filter((t) => isRepairTask(t))
        .filter((rep) => {
          const r = roundOf(rep);
          return !qualityDone.some((q) => roundOf(q) >= r);
        })
        .map((t) => String(t.id || '?'));
      if (unset.length) closureUnsettled.set(n, unset);
      if (canc.length) {
        closureCancelled.set(n, canc);
        // 取消**必须可解释**：主动砍范围（有记录的范围决策）与中途烂尾是两件事，
        // 只报数字会让读者无从判断。实测例子：竞品分析 run 的 7 个取消任务
        // 在 `STATE.scopeDecision.deliverableShape` 里写着「本轮不写业务代码」⇒ 是范围决策；
        // 而 run2 的 B-11/B-12 是用户叫停、无范围决策记录 ⇒ 需要人看一眼。
        const shape = String((state && state.scopeDecision && state.scopeDecision.deliverableShape) || '').trim();
        closureCancelReason.set(n, shape || '');
      }
      if (unver.length) closureUnverified.set(n, unver);
    }
    // 角色结果：由**任务结果反推**（R9 裁决：`TASKS.json` 是**唯一权威**，SKILL §7.10）。
    // D5 双计口径：failed 只计 fail（不再重复计 rework）；completed/done **总是** +1 pass，
    // 与 rework 互不排斥（`completed && round>1` 同时 +1 pass 与 +1 rework）。
    for (const t of taskArr) {
      const ownerRole = normalizeRoleName(String((t && t.owner) || '')); // R11：与日志角色名同口径归一
      if (!ownerRole) continue;
      // （R15：`taskRolesInRun` 已在日志循环**之前**按本 run 的 taskArr 建好，此处不再全局登记）
      const b = roles.get(ownerRole) ?? { pass: 0, rework: 0, fail: 0 };
      const st = String((t && t.status) || '');
      if (st === 'failed') b.fail += 1;
      else if (isRepairTask(t) || Number(t && t.round) > 1 || String((t && t.verdict) || '') === 'needs_revision') b.rework += 1;
      if (['completed', 'done'].includes(st)) b.pass += 1;
      roles.set(ownerRole, b);
    }
    // P4（SPEC §1.5）：**评审效率**口径 —— 轮次取各 run 质量任务的**最大** round（跨 run 取最大，
    // 反映"最深的返工坑"）；撤销率**只认显式撤销标记**（任务级 `revertedFindings` 数字，或 finding
    // 元素 `reverted === true` / `severity === 'reverted'`）—— **绝不**从自然语言里模糊匹配"撤销"二字：
    // 事故里 reviewer 每轮"撤销约 8 条幻觉"都写在散文里，靠猜等于把口径交给措辞。
    for (const t of taskArr) {
      if (!isQualityTask(t)) continue;
      const kind = String((t && t.kind) || '');
      const r = roundOf(t);
      if (ROUND_LIMIT_OF_KIND[kind] === 'maxReviewRounds') maxReviewRound = Math.max(maxReviewRound, r);
      else maxTestRound = Math.max(maxTestRound, r);
      const fs = Array.isArray(t && t.findings) ? t.findings : [];
      const marked = fs.filter((f) => !!(f && typeof f === 'object' && (f.reverted === true || f.severity === 'reverted'))).length;
      const declared = Number.isFinite(t && t.revertedFindings) ? Math.max(0, Math.floor(t.revertedFindings)) : 0;
      // R20（C11）+ B-08C：**per-task 分母三分支**（按优先级，唯一口径）。
      // 为什么必须分三支：`retracted` 是 **reviewer** 的上报义务，而 QA（`verification`）报的是
      // `spec-gap`、天然没有这个字段 ⇒ "无 `retracted` 就用 findings.length" 的混合分母**不是过渡态
      // 而是常态**，会系统性稀释这个指标（本 run 实测 10/19=53%，而真实可比的数是 10/12=83%）。
      //   ① 有 `retracted`（number 且 > 0）⇒ 分母用它（= 审查者自报疑似总数，含事后被撤销的）。
      //   ② 无 `retracted`、但**本任务确有撤销证据**（元素级标记，或任务级 `revertedFindings`）⇒
      //      退回 `findings.length`：撤销标记就落在这些 findings 里 ⇒ 两者是**同一总体**，不算混合。
      //      （SPEC.md §2.1 用例 8 冻结了这条：`revertedFindings:2` + 5 条 findings ⇒ `2 / 5（40%）`。）
      //   ③ 两者都没有 ⇒ **分子分母都不贡献**：数据未知，不得拿 `findings.length` 冒充"自报数"
      //      （QA 任务正是这一类 —— 它没有撤销登记，就不该进这个指标的分母）。
      const retracted = (Number.isFinite(t && t.retracted) && t.retracted > 0) ? Math.floor(t.retracted) : null;
      qualityTaskCount += 1;
      if (retracted !== null) {
        retractedSum += retracted;
        reportedFindings += retracted;
        // 两种记法是**同一事实**的两种写法（任务级总数 / 元素级标记）⇒ 取较大者，不双计（C3）。
        revertedFindings += Math.max(marked, declared);
        coveredTasks += 1;
      } else if (marked > 0 || declared > 0) {
        reportedFindings += fs.length;
        revertedFindings += Math.max(marked, declared);
        coveredTasks += 1;
      }
    }
    for (const src of reworkSources) reworkSourceTally.set(src, (reworkSourceTally.get(src) || 0) + 1);
    if (reworkSources.size > 0) runRework = true;
    // C 线第 15 项：任务/角色层命中的返工**都是过程类**（那些来源记的是"产出被退回重做"）；
    // 只有 `error:` 事件才可能是环境类，且已在事件循环里分好。
    if (roleResultRework || roleTickRework
      || ['tasks:repair', 'tasks:round>1', 'tasks:verdict|status', 'rounds'].some((k) => reworkSources.has(k))) {
      processRework = true;
    }
    if (sawLog) runsWithLogs++;
    if (state?.status === 'complete') completed++;
    if (runRework) reworkRuns++;
    // 性质分解（仅统计"有日志的 run"，与返工率同分母，保证可对照）
    if (sawLog) {
      if (envRework && processRework) reworkBoth += 1;
      else if (envRework) reworkEnvOnly += 1;
      else if (processRework) reworkProcessOnly += 1;
      else reworkNoEvidence += 1;
    }
  }

  const reworkRate = runsWithLogs ? Math.round((reworkRuns / runsWithLogs) * 100) : 0;
  const sourceLines = reworkSourceTally.size
    ? [...reworkSourceTally.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' · ')
    : '（无返工证据）';
  // C 线第 15 项：返工**性质分解** —— 只做分解，**不动**上面那个率（保持与历史可比）。
  const reworkNatureLines = [
    `- 返工性质分解（分母同上，**不改上面那个率**）：仅环境/平台 **${reworkEnvOnly}** 个 · 仅过程（质量环/角色/台账） **${reworkProcessOnly}** 个 · 两者都有 **${reworkBoth}** 个 · 无返工证据 ${reworkNoEvidence} 个`,
    `  · 「环境/平台类」判定族（换环境或没有并发就不会发生）：${[...ENV_ERROR_FAMILIES].join(' / ')}`,
    '  · **未列出的错误族一律算过程类**（宁可算过程，不放过 —— 把未知当环境类会系统性美化指标）。',
    '  · ⚠️ 「**用户新需求导致的重做**」**无法自动识别**，本分解不覆盖它；需要人工登记或在 RETRO 里说明。',
  ].join('\n');
  const iso = new Date().toISOString();

  // C 线：「未闭环」节 —— 三项都不进返工率分子，但必须可见（否则"返工率不高"会盖住"其实没交付完"）。
  const closureLine = (label, map) => {
    if (!map.size) return `- ${label}：无`;
    const total = [...map.values()].reduce((acc, a) => acc + a.length, 0);
    const detail = [...map.entries()].map(([r, a]) => `${r}: ${a.join('/')}`).join(' · ');
    return `- ${label}：**${total}** 个（${detail}）`;
  };
  const closureLines = [
    closureLine('未终态任务（pending / claimed / in_progress / rework / blocked）', closureUnsettled),
    closureLine('已取消任务', closureCancelled),
    // 取消**必须可解释**：主动砍范围 vs 中途烂尾是两件事，只报数字读不出来。
    ...(closureCancelled.size
      ? [[...closureCancelReason.entries()]
        .filter(([r]) => closureCancelled.has(r))
        .map(([r, reason]) => (reason
          ? `    · ${r}：按记录的范围决策取消 —— ${reason}`
          : `    · ${r}：⚠️ **未记录取消原因**（值得看一眼）`))
        .join('\n')]
      : []),
    closureLine('有修复但**无独立复验**（该修复之后没有已完成的质量任务覆盖到它的轮次）', closureUnverified),
    '  · 本节数字**不进返工率分子**：它们记的是"**没交付完**"，不是"返工"。两者必须分开读。',
    '  · 依据：一次真实会话结束时仍有 3 项被审查标为「必修」的缺陷未闭环，而这类"跑完但没收口"完全不计入返工率。',
  ].join('\n');

  // P5 线（token 记账）：**在渲染之前**采集 —— 数据来源优先是 DSH 会话遥测（权威、自动），
  // 读不到才回落到日志里的 `tokens:<scope>` 事件。两种来源的权威性不同，所以**不相加**。
  // 采集失败一律降级为"无记账"（由渲染器如实写明），绝不让一次读盘失败把整条 `/team learn` 打断。
  let tokenRuns = [];
  let tokenBroken = 0;
  let tokenUnattributed = 0;
  let tokenNotes = [];
  try {
    const collected = await collectTokenUsage(root, names, (name) => readRunInputs(root, name), { workspace: cwd });
    tokenRuns = collected.runs;
    tokenBroken = collected.broken;
    tokenUnattributed = collected.unattributed ?? 0;
    tokenNotes = collected.notes ?? [];
  } catch (e) {
    tokenNotes = [`token 采集失败：${(e && e.message) || String(e)}`];
  }
  const tokenLines = renderTokenSection({ runs: tokenRuns, broken: tokenBroken, unattributed: tokenUnattributed });

  // ── METRICS.md (aggregate snapshot) ──
  const phaseLines = phases.size ? [...phases.entries()].sort((a, b) => b[1] - a[1]).map(([p, c]) => `- \`${p}\`: ${c} 次`).join('\n') : '- （日志里暂无 phase 事件）';
  // E 线 E1：首产物小节。**文案在 `lib/metrics/timing.js`**（纯函数 ⇒ 版面与"两种零"的区分可单测），
  // 这里只喂三个数：算得出的样本、有日志的 run 数、登记了但算不出的 run 数。
  const firstRunnableLines = summarizeFirstRunnable({
    samples: firstRunnableSamples,
    runsWithLogs,
    unparsable: firstRunnableUnparsable,
  });
  // E 线 E2：收尾预算小节（同样的分工：文案在 `timing.js`，这里只喂计数）。
  const closingBudgetLines = summarizeClosingBudget({
    rows: closingRows,
    missingClosing: closingMissing,
    missingStart: closingNoStart,
    noPhases: closingNoPhases,
    noDeliver: closingNoDeliver,
    runsWithLogs,
  });
  // R9（lead 裁决）+ R15：`TASKS.json` 是**唯一权威**（SKILL §7.10），但权威判定域是**单个 run**：
  // 日志判决只有当该角色在**那个 run** 的 TASKS.json 里没有任何任务时才计入（判定已在上面日志循环里
  // 按 run 做完）。所以这里只做**跨 run 汇总**：某角色在 A run 有任务、在 B run 只有日志判决 ⇒
  // A 的任务派生计数 + B 的日志计数相加，且**不**标 `（仅日志）`（它有任务级权威行）。
  // 同一 run 内的重复计数仍被挡掉（T-04 实测 reviewer `3+3` 翻倍不会回来）。
  for (const [r, b] of logRoles) {
    if (!r) continue;
    const cur = roles.get(r);
    if (cur) { cur.pass += b.pass; cur.rework += b.rework; cur.fail += b.fail; }
    else roles.set(r, { pass: b.pass, rework: b.rework, fail: b.fail, logOnly: true });
  }
  // D5：角色行只列**有活动**的角色（pass+rework+fail > 0）；末尾补「未参与」。
  const activeRoles = [...roles.entries()]
    .filter(([, b]) => b.pass + b.rework + b.fail > 0)
    .sort((a, b) => (b[1].rework + b[1].fail) - (a[1].rework + a[1].fail));
  const activeRoleNames = new Set(activeRoles.map(([r]) => r));
  // R1 + R15：role tick 必须**真渲染**，且分子是 `tickNoTask`（"在**本 run** 无任务"的那些 tick）。
  // 旧实现 roleTicks 只用于从「未参与」里剔除、从不渲染 ⇒ 空 TASKS.json（workflow 扇出未回写，
  // SKILL §7.22 明示这是常见情况）时，日志里明明有 `role:pm`，角色结果节却打印「日志里暂无角色结果」
  // —— D3 要消灭的矛盾原样复发。而用全局 taskRoles 判定时，A run 有任务又会把 B run 的 tick 一起吞掉。
  const tickOnly = [...tickNoTask.entries()]
    .filter(([r, n]) => n > 0 && r && r !== 'unknown' && !activeRoleNames.has(r))
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const idleRoles = [...new Set([
    ...rosterSeen,
    ...[...roles.entries()].filter(([r, b]) => !activeRoleNames.has(r) && b.pass + b.rework + b.fail === 0).map(([r]) => r),
  ])].filter((r) => r && r !== 'unknown' && !activeRoleNames.has(r) && !roleTicks.has(r)).sort();
  const roleLines = [
    ...(activeRoles.length
      ? activeRoles.map(([r, b]) => `- ${r}: pass ${b.pass} / rework ${b.rework} / fail ${b.fail}${b.logOnly ? '（仅日志）' : ''}`)
      : []),
    ...(tickOnly.length ? [`- （仅日志参与：${tickOnly.map(([r, n]) => `${r}×${n}`).join('、')}）`] : []),
    ...((!activeRoles.length && !tickOnly.length) ? ['- （日志里暂无角色结果）'] : []),
    ...(idleRoles.length ? [`- （未参与：${idleRoles.join('、')}）`] : []),
  ].join('\n');
  const errLines = eventTallyLines(errors, '（无 error 事件）');
  // E3：单源化总扫（`scan:single-source`）。空态必须**如实说明"没有登记"**，不能省略 ——
  // 省略会被读成"不需要总扫"。
  // 返工成因：单源化类占比（§十二 的验收指标）。**无返工时如实写「暂无」，不报 0%** ——
  // 0% 会被误读成「做得很干净」，而实际是「还没有数据」。
  // ⚠️ `eventTallyLines` 返回的是**已拼好的文本**，所以这里是拼接（不是 push）。
  const ssLine = ssAgg.repairs > 0
    ? `- 返工成因：**单源化类 ${ssAgg.singleSource}/${ssAgg.repairs} = ${Math.round((ssAgg.singleSource / ssAgg.repairs) * 100)}%**（标题含「单源化 / 唯一权威 / 单写者 / 同源 / 漂移 / 口径」等词）· **目标 ≤30%**${ssAgg.singleSource / ssAgg.repairs > 0.3 ? ' ⚠️ 超标' : ''}。⚠️ 口径是关键词判定 ⇒ **下界近似**（写得含蓄的返工不算进来）`
    : '- 返工成因：单源化类占比 —— **暂无返工可算**（没有 `kind=repair` 的任务；这不等于 0%）';
  const scanLines = eventTallyLines(scans, '（无单源化总扫登记：`scan:single-source` 事件一个都还没写过）') + '\n' + ssLine;
  const askLines = eventTallyLines(asks, '（无用户提问）');
  const decLines = eventTallyLines(decisions, '（无决策记录）');

  // P4 + R20（SG-4）：撤销率行的**三种形态必须可区分** —— 这是"两种零"的全部要点：
  //   ① 有撤销标记            → `- 撤销幻觉：R / N（撤销率 X%）`
  //   ② 自报了 N 条、0 条标记 → 同一行 + 提示「（自报 N 条但 0 条标记撤销 —— 若确有撤销请补 revertedFindings）」
  //                             （"没人登记"必须显形，不能被读成"没有撤销"）
  //   ③ 压根没人登记（无 retracted 也无标记）→ `- （暂无撤销登记：质量任务 findings 未标记 reverted）`
  const revertRate = reportedFindings ? Math.round((revertedFindings / reportedFindings) * 100) : 0;
  // B-08C：撤销率行必须**如实暴露覆盖面** —— `覆盖 a/b 个质量任务`（a = 贡献了分母的质量任务数，
  // b = 全部质量任务数）。`a === b` 也照写：**"全覆盖"本身就是信息**，省略它等于让读者去猜
  // "这个 83% 是 1 个任务算出来的、还是 10 个"。
  const revertScope = ` · 覆盖 ${coveredTasks}/${qualityTaskCount} 个质量任务`;
  const revertLine = revertedFindings > 0
    ? `- 撤销幻觉：${revertedFindings} / ${reportedFindings}（撤销率 ${revertRate}%${revertScope}）`
    : (retractedSum > 0
      ? `- 撤销幻觉：${revertedFindings} / ${reportedFindings}（撤销率 ${revertRate}%${revertScope}）（自报 ${reportedFindings} 条但 ${revertedFindings} 条标记撤销 —— 若确有撤销请补 revertedFindings）`
      : '- （暂无撤销登记：质量任务 findings 未标记 reverted）');

  // B 线 10b：渲染已切到 `lib/metrics/render.js`（纯函数、零 IO）⇒ METRICS 格式可纯单测。
  // ⚠️ 字段名即契约：`metrics-render.test.mjs` 会比对"本模块解构的字段"与"这里传的键集合"，
  // 少传一个就会让报告里出现 `undefined` —— 那是闭包局部变量改成对象之后新引入的风险，靠测试兜。
  const metrics = renderMetrics({
    iso,
    runCount: names.length,
    skipped,
    completed,
    runsWithLogs,
    reworkRate,
    reworkRuns,
    sourceLines,
    reworkNatureLines,
    phaseLines,
    firstRunnableLines,
    closingBudgetLines,
    roleLines,
    closureLines,
    errLines,
    askLines,
    decLines,
    scanLines,
    maxReviewRound,
    maxTestRound,
    revertLine,
    tokenLines,
  });
  await ARTIFACT.must(join(root, 'METRICS.md'), metrics);

  // ── LEARNINGS.md (distilled, same-day block replaced in place; feeds the self-optimization loop) ──
  const learn = [];
  if (errors.size) {
    const topErrors = [...errors.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
    learn.push(`[Team Skill] 高频卡点：${topErrors.map(([k, v]) => `${k} ×${v.count}（样例：${v.sample}）`).join('；')}`);
  }
  if (asks.size) learn.push(`[Team Skill] 用户高频提问（考虑在 clarify 阶段预先澄清）：${[...asks.keys()].slice(0, 3).join('；')}`);
  // D5 蒸馏阈值：只有「集中度足够」才点名角色，否则明确说「分散」——
  // 消灭「X 返工/失败最多（1 次）」这类无信息量噪声。
  const reworking = [...roles.entries()]
    .map(([r, b]) => [r, b.rework + b.fail])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const totalRework = reworking.reduce((s, [, n]) => s + n, 0);
  if (reworking.length === 1 || (totalRework >= 3 && reworking[0][1] >= 2 * reworking[1][1])) {
    learn.push(`[Expert Skill] 角色 ${reworking[0][0]} 返工/失败最多（${totalRework} 次），重点检查其边界与契约清晰度`);
  } else if (totalRework > 0) {
    learn.push(`[Team Skill] ${reworking.length} 个角色共 ${totalRework} 件返工（分散，无单一责任角色）—— 优先查契约与并发环境，而非角色能力`);
  }

  // D6 + R8：同日蒸馏块**始终替换**（块头 → 下一个 `## ` 标题前），不再按「日期+计数」去重键
  // 反复追加 ⇒ 同一天多次 learn 后 LEARNINGS.md 里只剩 1 个当日块，且**不整文件重写**
  //（其它手写章节原样保留）。
  // R8：旧实现是 `if (learn.length)` 才写 ⇒ 同日已有块、但本次蒸馏为空时，**旧块永久留存**
  //（含本轮刚修掉的 D5 噪声，例如项目 team/LEARNINGS.md 里那条「researcher 返工/失败最多（1 次）」），
  // 还会被下一次 clarify 当「既往经验」注入 ⇒ 已修掉的噪声继续污染后续 run。
  let appended = false;
  {
    const day = iso.slice(0, 10);
    const head = `## ${day} 自动蒸馏（/team learn）`;
    const body = learn.length ? learn.map((l) => `- ${l}`) : ['- （本日无新增经验）'];
    const block = [head, ...body, ''].join('\n');
    const lp = join(root, 'LEARNINGS.md');
    let existing = '';
    try { existing = await readFile(lp, 'utf8'); } catch { existing = '# 团队经验（LEARNINGS）\n\n'; }
    const lines = existing.split('\n');
    const start = lines.findIndex((l) => l.trim() === head);
    if (start >= 0) {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i += 1) { if (/^## /.test(lines[i])) { end = i; break; } }
      const next = [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end)].join('\n');
      if (next !== existing) { await ARTIFACT.must(lp, next); appended = true; }
    } else if (learn.length && !existing.includes(block)) {
      // 当日块还不存在：**确有经验**才追加（不给干净的 LEARNINGS.md 凭空加一个空块）。
      await ARTIFACT.must(lp, existing.endsWith('\n') ? existing + block : existing + '\n' + block);
      appended = true;
    }
  }

  return {
    runs: names.length, skipped, completed, runsWithLogs, reworkRate,
    errors: errors.size, asks: asks.size, decisions: decisions.size, learned: learn.length, changed: appended,
    // P5 线：`/team learn` 的人类可读摘要要能一句话说出"钱花在哪" —— 见 `learnRuns()`。
    tokenRuns, tokenNotes,
  };
}

// Human-facing `/team learn`: aggregate now and render a summary.
async function learnRuns(cwd) {
  const root = teamRoot(cwd);
  let names = [];
  try { names = await readdir(root); } catch { /* fallthrough */ }
  if (!names.length) return { kind: 'success', text: '还没有 team run，无日志可学。用 /team <task> 先组队跑一个。' };
  const res = await aggregate(cwd);
  // P5 线：摘要里必须**直接说出"钱花在哪"** —— 只写"指标 → METRICS.md"等于把结论藏在文件里，
  // 而这条记账存在的全部理由就是"没人看得见就没刹车"。有数据才写（没数据由 METRICS 如实说明）。
  const tokenLine = (() => {
    const runs = Array.isArray(res.tokenRuns) ? res.tokenRuns : [];
    if (!runs.length) return '- token：**无记账**（会话遥测读不到、日志里也没有 `tokens:<scope>` 事件 —— 这不代表消耗低）';
    const sum = runs.reduce((a, r) => ({
      in: a.in + r.totals.in, cache: a.cache + r.totals.cache, out: a.out + r.totals.out, steps: a.steps + r.totals.steps,
    }), { in: 0, cache: 0, out: 0, steps: 0 });
    const costIn = sum.in * res.tokenRuns[0].weights.in;
    const costCache = sum.cache * res.tokenRuns[0].weights.cache;
    const costOut = sum.out * res.tokenRuns[0].weights.out;
    const cost = costIn + costCache + costOut;
    const share = cost > 0 ? Math.round((costCache / cost) * 100) : 0;
    const outShare = (sum.in + sum.cache + sum.out) > 0 ? (((sum.out) / (sum.in + sum.cache + sum.out)) * 100).toFixed(2) : '0';
    return `- token：${runs.length} 个 run 有记账 · 未缓存输入 ${sum.in.toLocaleString('en-US')} · 缓存输入 ${sum.cache.toLocaleString('en-US')} · 输出 ${sum.out.toLocaleString('en-US')} · 步数 ${sum.steps.toLocaleString('en-US')}\n` +
      `  · 输出只占总 token **${outShare}%**（少说点没用）· 成本里缓存输入占 **${share}%**（**prompt 体积 × 步数**才是杠杆）`;
  })();
  return {
    kind: 'success',
    text: [
      `已聚合 ${res.runs} 个 run：`,
      `- 返工/失败率：${res.reworkRate}%`,
      `- 高频卡点 ${res.errors} 条、用户提问 ${res.asks} 条、决策 ${res.decisions} 条`,
      tokenLine,
      // 备注分两级：**归属依据**是口径说明（不是告警），**未归属/角色认不出**才是真缺数据。
      // 一律打 ⚠️ 会让"告警"变成背景噪声 —— 本包在 schema-warn 上吃过这个亏（warn 噪声化）。
      ...(Array.isArray(res.tokenNotes) && res.tokenNotes.length
        ? res.tokenNotes.map((n) => `  · ${/(未归属|认不出|读不到|失败|不可用)/.test(n) ? '⚠️' : 'ℹ️'} ${n}`)
        : []),
      `- 指标 → ${join(root, 'METRICS.md')}`,
      res.changed
        ? `- 已蒸馏 ${res.learned} 条新经验 → ${join(root, 'LEARNINGS.md')}`
        : `- 经验无新变化（${res.learned} 条已沉淀，未重复追加）`,
    ].join('\n'),
  };
}

// ── 面板实时馈送（D7）：runLogTail / liveFiles ────────────────────────────────
// `/state` 路由一直在调用这两个函数，但全仓**无定义** ⇒ ReferenceError 被 try/catch
// 吞掉 ⇒ 浮层「运行日志（最新）」「改动的文件」永远是空的（死代码恒过测试）。

const RUN_LOG_TAIL_OPTS = { maxLines: 40, maxChars: 4000 };

/**
 * 读 <runDir>/RUN.log.md 的尾部，供浮层「运行日志（最新）」实时显示。
 * @param {string} runDir 绝对路径
 * @param {{maxLines?: number, maxChars?: number}} [opts] 默认 {maxLines: 40, maxChars: 4000}
 * @returns {Promise<string>} 失败一律返回 ''（不抛）
 */
async function runLogTail(runDir, opts = {}) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const maxLines = Number(o.maxLines) > 0 ? Math.floor(Number(o.maxLines)) : RUN_LOG_TAIL_OPTS.maxLines;
    const maxChars = Number(o.maxChars) > 0 ? Math.floor(Number(o.maxChars)) : RUN_LOG_TAIL_OPTS.maxChars;
    const raw = await readFile(join(String(runDir ?? ''), 'RUN.log.md'), 'utf8');
    // ① R4：**整行 HTML 注释一律不进馈送**（脚手架在文件尾留了一段编排者说明，真实 run 也会
    // 在中间夹注释），再去掉末尾空行。旧实现只剥「末尾」的注释 ⇒ 注释夹在中间时原样漏进面板。
    // 语义不变：仍然**保留最新**（先剔注释/尾部空行，再从尾部取 maxLines、按 maxChars 截断）。
    const lines = String(raw).split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => !/^\s*<!--[\s\S]*-->\s*$/.test(l));
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    // ② 取最后 maxLines 行（最旧在前、最新在尾）
    const tail = lines.slice(-maxLines).join('\n');
    // ③ 再按 maxChars **从尾部**截断（保留最新）
    return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
  } catch { return ''; }
}

const LIVE_FILES_TTL_MS = 5000;      // 模块级 TTL：命中不得发起任何 I/O / 进程
const LIVE_FILES_MAX = 30;           // git 兜底上限
const LIVE_FILES_CACHE = new Map();  // `${workspace}\u0000${runId}` -> { at, files }

/** run 作用域优先：在办任务（claimed / in_progress）的 changedPaths 去重。 */
async function liveFilesInRunScope(workspace, runId) {
  if (!workspace || !runId) return [];
  const doc = await readJsonSafe(join(workspace, 'team', runId, 'TASKS.json'));
  const out = [];
  const seen = new Set();
  for (const t of taskList(doc)) {
    const st = String((t && t.status) || '');
    if (!['claimed', 'in_progress'].includes(st)) continue;
    const paths = Array.isArray(t && t.changedPaths) ? t.changedPaths : [];
    for (const p of paths) {
      const s = String(p ?? '').trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** git 兜底：`git status --porcelain`（timeout 4s / maxBuffer 512KB），过滤 team/ 与 .DS_Store。 */
async function liveFilesFromGit(workspace) {
  if (!workspace) return [];
  const isRepo = await stat(join(workspace, '.git')).then(() => true).catch(() => false);
  if (!isRepo) return [];
  const { stdout } = await execFile('git', ['-C', workspace, 'status', '--porcelain'], { timeout: 4000, maxBuffer: 512 * 1024 });
  const out = [];
  const seen = new Set();
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();                      // `XY <path>`
    const arrow = p.indexOf(' -> ');                   // rename: `old -> new`
    if (arrow >= 0) p = p.slice(arrow + 4).trim();
    p = p.replace(/^"|"$/g, '');
    if (!p || p.startsWith('team/') || /(^|\/)\.DS_Store$/.test(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= LIVE_FILES_MAX) break;
  }
  return out;
}

/**
 * 当前正在被改动的文件清单（浮层「改动的文件」）。
 * @param {string} workspace 会话 cwd
 * @param {string} [runId] 当前 run；用于 run 作用域优先
 * @returns {Promise<string[]>} 失败一律返回 []（不抛）
 */
async function liveFiles(workspace, runId = '') {
  const ws = String(workspace ?? '');
  const rid = String(runId ?? '');
  const key = ws + '\u0000' + rid;
  const hit = LIVE_FILES_CACHE.get(key);
  if (hit && Date.now() - hit.at < LIVE_FILES_TTL_MS) return hit.files.slice(); // 命中：零 I/O
  let files = [];
  try {
    files = await liveFilesInRunScope(ws, rid);
    if (!files.length) files = await liveFilesFromGit(ws);
  } catch { files = []; }
  LIVE_FILES_CACHE.set(key, { at: Date.now(), files });
  return files.slice();
}

// ── /team board: cross-run timeline + quality trends (one glance) ──────────
const BOARD_HINTS = [
  [/截断|aggregate/, '大工件不走 workflow 聚合返回（规则 14）'],
  [/契约|分歧|边界/, '实现前先冻结签名级契约（规则 6）'],
  [/冻结|仍 pending|挂零|不回写/, '派工/结算立即回写 TASKS.json（规则 10/12）'],
  [/sleep|盲等/, '禁止 sleep 等活，用结算通知/job_output(wait)（规则 13）'],
  [/\[now\]/, '日志时间戳写实际时刻（规则 15）'],
  [/越界|inScope/, '完成时按 changedPaths 做越界审计（规则 11）'],
  [/reviewer.*返工|verdict=rework/, 'review 返工只重跑受影响角色，先冻结契约再并行（规则 6/9）'],
];

async function renderBoard(cwd) {
  const runs = await listRuns(cwd);
  if (!runs.length) return { kind: 'success', text: '还没有专家团 run。用 /team <task> 组队。' };
  const rows = [];
  let doneTasks = 0, totalTasks = 0, violTotal = 0, completedRuns = 0;
  const hints = new Map();
  for (const r of runs) {
    const dir = join(teamRoot(cwd), r.runId);
    const tasks = await readJsonSafe(join(dir, 'TASKS.json'));
    const arr = taskList(tasks);
    const done = arr.filter((t) => ['completed', 'done'].includes(t.status)).length;
    doneTasks += done; totalTasks += arr.length;
    const viol = checkTasks(arr, r.phase).length;
    violTotal += viol;
    if (r.status === 'complete') completedRuns++;
    // swallow the run's blockers → mapped hints
    const log = await readFile(join(dir, 'RUN.log.md'), 'utf8').catch(() => '');
    for (const line of log.split('\n')) {
      const ev = parseLogLine(line);
      if (!ev) continue;
      for (const [re, hint] of BOARD_HINTS) {
        if (re.test(ev.type + ' ' + ev.detail)) { hints.set(hint, (hints.get(hint) || 0) + 1); }
      }
    }
    rows.push(`- ${(r.updatedAt || '').slice(11, 19) || '--:--:--'}  ${r.runId}  [${phaseZh(r.phase)}/${statusZh(r.status)}]  ${done}/${arr.length} 完成${viol ? ` · ⚠违规${viol}` : ''}  ${r.task}`);
  }
  rows.sort();
  const pct = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const trend = [
    `## 趋势`,
    `- 完成 run ${completedRuns}/${runs.length} · 总任务 ${totalTasks}（完成率 ${pct}%）· 全站违规 ${violTotal} 条`,
  ];
  const hintLines = hints.size ? [...hints.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => `- ${h}（${n} 次）`) : ['- （无阻滞痕迹）'];
  return {
    kind: 'success',
    text: [
      `项目看板（${cwd.split('/').pop()} · ${runs.length} 个 run 时间线）：`,
      ...rows,
      ...trend,
      '',
      '## 自我学习提示（由日志自动映射）',
      ...hintLines,
      '',
      '（深入聚合：/team learn --deep 写出 DEEP-LEARN.md；逐 run 复核：/team check <run>）',
    ].join('\n'),
  };
}

// ── /team learn --deep: write a per-run blocker digest + mapped rules ──────
async function renderDeepLearn(cwd) {
  const root = teamRoot(cwd);
  const runs = await listRuns(cwd);
  if (!runs.length) return { kind: 'success', text: '还没有 team run，无日志可学。' };
  const lines = ['# 深度蒸馏（DEEP-LEARN）', '', `> 由 /team learn --deep 生成 · ${new Date().toISOString()}`, ''];
  let blockers = 0, fixes = 0;
  for (const r of runs) {
    const dir = join(root, r.runId);
    const log = await readFile(join(dir, 'RUN.log.md'), 'utf8').catch(() => '');
    const evs = log.split('\n').map(parseLogLine).filter(Boolean);
    const bad = evs.filter((ev) => /error|fix|返工|截断|卡点|冻结|rework|needs_revision/.test(ev.type + ' ' + ev.detail));
    if (bad.length) {
      blockers += bad.filter((e) => /error|截断|卡点|冻结/.test(e.type + ' ' + e.detail)).length;
      fixes += bad.filter((e) => /fix/.test(e.type)).length;
      lines.push(`## ${r.runId}（${phaseZh(r.phase)}/${statusZh(r.status)}）`, ...bad.map((e) => `- [${e.time}] ${e.type} — ${e.detail.slice(0, 120)}`), '');
    }
  }
  const agg = await aggregate(cwd);
  lines.push('## 归因建议（按日志痕迹映射规则库）', '');
  const counts = agg.errors + blockers;
  const suggested = [];
  if (counts) {
    for (const [re, hint] of BOARD_HINTS) {
      // re-evaluate against raw error lines is expensive; use aggregate hints
    }
  }
  // reuse BOARD_HINTS mapping via the same digest scan
  const raw = await readFile(join(root, 'LEARNINGS.md'), 'utf8').catch(() => '');
  lines.push(`- 返工/失败率 ${agg.reworkRate}% · 高频卡点 ${agg.errors} 条（详见 METRICS.md）`);
  lines.push(`- 下次跑团队前先读 team/LEARNINGS.md 的「全量运行日志分析」条目；deliver 必填 RETRO.md（/team check 会检查）。`);
  lines.push('', '> 提示：可用 hindsight_ingest_document 把本文件要点落库（标题「专家团经验 · <runId>」）。');
  const p = join(root, 'DEEP-LEARN.md');
  await ARTIFACT.must(p, lines.join('\n'));
  return {
    kind: 'success',
    text: [
      `已生成深度蒸馏：${p}`,
      `- 阻滞事件 ${blockers} 条 · 修复事件 ${fixes} 条 · 返工率 ${agg.reworkRate}%`,
      `- 下次编排前先读 team/LEARNINGS.md 经验条目；RETRO 必填（/team check 会提示）。`,
    ].join('\n'),
  };
}

// Best-effort auto-aggregation used on status/create so the hard loop stays
// fresh without the user remembering to type `/team learn`. Never throws.
async function autoAggregate(cwd) {
  try { await aggregate(cwd); } catch { /* best-effort */ }
}

// ── /team detail <run>: one-pane run detail (goal/timeline/artifacts/errors) ──
async function renderRunDetail(cwd, runArg) {
  const root = teamRoot(cwd);
  const dir = await pickRunDir(root, runArg);
  if (!dir) return { kind: 'error', text: '还没有 run。用 /team <task> 组队。' };
  const runId = basename(dir);
  const state = await readJsonSafe(join(dir, 'STATE.json'));
  const task = await readFile(join(dir, 'TASK.md'), 'utf8').catch(() => '');
  const tasks = taskList(await readJsonSafe(join(dir, 'TASKS.json')));
  const log = await readFile(join(dir, 'RUN.log.md'), 'utf8').catch(() => '');
  const violations = checkTasks(tasks, state?.phase, state);
  const goal = (task.split('\n').find((l) => /^>\s*目标/.test(l)) ?? '').replace(/^>\s*目标[：:]\s*/, '');
  const evs = log.split('\n').map(parseLogLine).filter(Boolean);
  const timeline = evs.filter((e) => /^(phase|run|role|decision|fix|error|lead|sync)/.test(e.type)).slice(-24).map((e) => `- [${e.time}] ${e.type} — ${e.detail.slice(0, 96)}`);
  // R3：按**事件族**判定首个失败点。真实日志写的是 `error:<子类>`（如 `error:external-write`），
  // 旧的 `e.type === 'error'` 精确匹配永远找不到 ⇒ detail 页恒报「首个失败点：（无 error 事件）」，
  // 与 METRICS 里明明列着卡点自相矛盾。兜底文案保持不变。
  const firstError = evs.find((e) => eventFamily(e.type) === 'error');
  const done = tasks.filter((t) => ['completed', 'done'].includes(t.status)).length;
  let files = [];
  try { files = (await readdir(dir)).filter((n) => !/\.json$/.test(n) && n !== 'RUN.log.md'); } catch { /* skip */ }
  const quota = state?.quota;
  return {
    kind: 'success',
    text: [
      `运行详情 ${runId}（${phaseZh(state?.phase)}/${statusZh(state?.status)}）`,
      `- 目标：${goal || '（未写目标）'}`,
      `- 进度：${done}/${tasks.length} 完成 · 违规 ${violations.length}${violations.length ? `（${violations.slice(0, 3).join('；')}）` : ''}${quota ? ` · 配额 ${quota.runs ?? 0}/${quota.maxRuns ?? '∞'}${quota.deadline ? ` · 至 ${quota.deadline}` : ''}` : ''}`,
      `- 首个失败点：${firstError ? `[${firstError.time}] ${firstError.detail.slice(0, 140)}` : '（无 error 事件）'}`,
      '',
      '## 时间线（最近 24 条）',
      timeline.length ? timeline : '- （空）',
      '',
      '## 产物（目录内工件文件）',
      files.length ? files.map((f) => `- ${f}`).join('\n') : '- （空）',
    ].join('\n'),
  };
}

// ── /team limit <run>: run quota (maxRuns / deadline) — enforced on resume ──
async function renderRunLimit(cwd, runArg, maxRuns, deadline, clear) {
  const root = teamRoot(cwd);
  const dir = await pickRunDir(root, runArg);
  if (!dir) return { kind: 'error', text: '还没有 run。用 /team <task> 组队。' };
  const runId = basename(dir);
  const state = await readJsonSafe(join(dir, 'STATE.json'));
  if (!state) return { kind: 'error', text: `run "${runId}" 缺 STATE.json。` };
  const q = state.quota || { runs: 0 };
  if (clear) {
    delete state.quota;
    state.updatedAt = new Date().toISOString();
    await ARTIFACT.must(join(dir, 'STATE.json'), state);
    return { kind: 'success', text: `已清除 run "${runId}" 的配额限制。` };
  }
  if (maxRuns != null && (!Number.isFinite(maxRuns) || maxRuns < 1)) return { kind: 'error', text: '--max-runs 须为正整数。' };
  if (deadline) {
    const d = new Date(String(deadline));
    if (Number.isNaN(d.getTime())) return { kind: 'error', text: '--deadline 格式应为 YYYY-MM-DD。' };
    q.deadline = String(deadline);
  }
  if (maxRuns != null) q.maxRuns = Math.floor(maxRuns);
  state.quota = q;
  state.updatedAt = new Date().toISOString();
  await ARTIFACT.must(join(dir, 'STATE.json'), state);
  return {
    kind: 'success',
    text: [`run "${runId}" 配额：已运行 ${q.runs ?? 0} 次 · 上限 ${q.maxRuns ?? '∞'}${q.deadline ? ` · 截止 ${q.deadline}` : ''}`,
      '（超限/过期后 /team resume 会拒绝并提示；定时触发同为该闸门）'].join('\n'),
  };
}

// ── resume / clear ─────────────────────────────────────────────────────────

async function resumeRun(ctx, invocation, cwd, run) {
  const dir = join(teamRoot(cwd), run);
  try {
    const state = JSON.parse(await readFile(join(dir, 'STATE.json'), 'utf8'));
    const q = state.quota;
    if (q) {
      const ran = q.runs || 0;
      const overdue = q.deadline && new Date(String(q.deadline)) < new Date();
      if (overdue || (q.maxRuns != null && ran >= q.maxRuns)) {
        return { kind: 'error', text: `run "${run}" 达到配额限制（已运行 ${ran}/${q.maxRuns ?? '∞'}${q.deadline ? `，截止 ${q.deadline}` : ''}${overdue ? '（已过期）' : ''}）。用 /team limit <run> --clear 或调整配额后再恢复。` };
      }
    }
    await ensureSkillInstalled();
    rememberSessionRun(invocation?.agent?.session?.id, cwd, run, 'view');
    await persistSessionRuns();
    if (q) { q.runs = (q.runs || 0) + 1; state.quota = q; state.updatedAt = new Date().toISOString(); await ARTIFACT.must(join(dir, 'STATE.json'), state); }
    await appendLog(dir, `run:resumed — 阶段=${state.phase}`);
    // Bug B（2026-09-11 用户实证）：断网/重启/异常中断后，用户发「继续」时 lead **盲目继续**，
    // 从不核对在飞任务 —— 在飞任务的成员其实早已随进程一起死掉，不先清算就会陷入
    // "任务在 in_progress 却没人做"的静默停滞（这正是 strandedTasks 要抓的形态）。
    // ⇒ 恢复路径上**先做检测**：把"在飞 / 搁浅 / 最近活动"直接写进 followup，让 lead 看到再动。
    const tasksNow = await readJsonSafe(join(dir, 'TASKS.json'));
    const arrNow = taskList(tasksNow);
    const inFlight = arrNow.filter((t) => IN_FLIGHT_STATUSES.includes(t.status));
    // 冷启动后本会话必然没有该 run 的活成员 ⇒ 所有在飞任务都是"疑似搁浅"（如实标注判定依据）
    const stranded = strandedTasks(arrNow, new Set());
    const detectLines = [];
    if (inFlight.length) {
      detectLines.push(`在飞任务 ${inFlight.length} 个（状态仍是 claimed/in_progress）：${inFlight.map((t) => `${t.id}@${roleNorm(t.owner) || '?'}`).join(', ')}`);
      detectLines.push(`其中疑似搁浅 ${stranded.length} 个（owner 当前无存活子代理 —— 本会话冷启动后判定，若有误请先核对）：${stranded.map((s) => s.id).join(', ') || '无'}`);
      if (stranded.length) {
        detectLines.push(`**先清算再派工**：\`/team settle ${run}\`（把搁浅任务清回 pending、attempt+1、RUN.log 留痕），再按 TASKS.json 重新派工。不要直接派新任务覆盖。`);
      } else {
        detectLines.push('（无搁浅任务，可直接从当前阶段继续）');
      }
    } else {
      detectLines.push('在飞任务 0 个（无需清算）。');
    }
    invocation.agent.followup(userMessage(
      `【专家团恢复】继续 run ${run}（阶段 ${phaseZh(state.phase)}）。\n` +
      `**中断后先检测，不要直接续跑**：\n${detectLines.join('\n')}\n` +
      `然后加载 expert-team skill，读 team/${run}/ 工件与 STATE.json，从当前阶段继续。\n` +
      `若没有成员在跑且没有待清算任务，先派 \`researcher\`（+ \`pm\` 如需澄清）恢复推进，不要停在没有派工的状态。`
    ));
    return { kind: 'success', text: `已恢复 run ${run}（当前阶段 ${phaseZh(state.phase)}）。在飞 ${inFlight.length} 个 / 疑似搁浅 ${stranded.length} 个${stranded.length ? ` —— 先 /team settle ${run} 清算` : ''}。` };
  } catch {
    return { kind: 'error', text: `未找到 run "${run}"。用 /team status 查看。` };
  }
}

/**
 * 常驻规则（"改完就提交"这类**用户立的规矩**）：list / add。
 *
 * 为什么独立成文件（不复用 LEARNINGS.md）：LEARNINGS 是团队**自动蒸馏**的经验，
 * 常驻规则是**用户直接下的指令**——权威不同、且**每次都要带上**（压缩对话后不能消失）。
 * 落点 `<cwd>/team/STANDING-RULES.md`（工作区级、跨 run、跨会话）。
 */
async function rulesRun(cwd, action, rule) {
  const p = join(teamRoot(cwd), 'STANDING-RULES.md');
  if (action === 'add') {
    const r = await appendStandingRule(cwd, rule);
    if (!r.ok) return { kind: 'error', text: `规则无效：${r.reason}` };
    return { kind: 'success', text: r.added ? `已写入常驻规则：${rule}` : `已存在（不重复写入）：${rule}` };
  }
  const txt = await readStandingRules(cwd, 999);
  if (!txt) return { kind: 'success', text: '还没有常驻规则。用 `/team rule <内容>` 添加（例如「改完代码没问题就提交并推送」）。' };
  return { kind: 'success', text: `常驻规则（${p}）：\n${txt}` };
}

/**
 * O7 · wait 语义（把"禁 sleep"从禁令变成**可观测的等待**）。
 *
 * 命令模式不能真的阻塞 —— 所以这不是"sleep 到完成"，而是：
 *   · 有在飞任务 ⇒ 如实报告"还有谁在做、做到哪了"（不瞎等，也不给假的"已完成"）；
 *   · 没有活的 ⇒ 如实说"可以动了"；
 *   · 有在飞但**长时间无进展**（updatedAt 停滞）⇒ 报 noProgress 并建议干预。
 * 这样 lead 派活后不需要 `bash sleep`：派完就回来等下一轮输入，或者发 `/team wait` 查进展。
 */
async function waitRun(cwd, runArg) {
  const root = teamRoot(cwd);
  const dir = runArg ? join(root, runArg) : await pickleLatestRunDir(root);
  if (!dir) return { kind: 'error', text: '没有 run 可等。用 /team wait <run> 指定，或 /team status 查看。' };
  const runId = basename(dir);
  const tasksRaw = await readJsonSafe(join(dir, 'TASKS.json'));
  if (!tasksRaw) return { kind: 'error', text: `run "${runId}" 缺 TASKS.json。` };
  const arr = taskList(tasksRaw);
  const inFlight = arr.filter((t) => IN_FLIGHT_STATUSES.includes(t.status));
  const done = arr.filter((t) => ['done', 'completed'].includes(t.status));
  const failed = arr.filter((t) => ['failed', 'cancelled'].includes(t.status));
  if (!inFlight.length) {
    return { kind: 'success', text: `run "${runId}"：没有在飞任务（${done.length} 完成${failed.length ? ` / ${failed.length} 已失败` : ''}）。可以继续了。` };
  }
  // noProgress 短路：如果最近没有任务完成（看 STATE.updatedAt 的停滞程度）
  const st = await readJsonSafe(join(dir, 'STATE.json'));
  const lastChange = st && st.updatedAt ? new Date(st.updatedAt).getTime() : 0;
  const idleMs = lastChange ? Date.now() - lastChange : 0;
  const progressNote = idleMs > 300000 ? ' ⚠ 无进展超过 5 分钟' : '';
  const lines = inFlight.map((t) => `  · ${t.id} ${statusZh(t.status)}${t.owner ? ` · ${t.owner}` : ''}${t.round ? ` · R${t.round}` : ''}`);
  return {
    kind: 'success',
    text: `run "${runId}"：${inFlight.length} 个任务在飞${progressNote}（完成 ${done.length}${failed.length ? ` / 失败 ${failed.length}` : ''} / 共 ${arr.length}）。\n在飞的任务：\n${lines.join('\n')}\n\n${idleMs > 300000 ? '建议：/team status 看健康度，或 /team settle 清算搁浅任务。' : '可以继续等，或做别的事（下一条消息时会再收到进展）。'}`,
  };
}

async function clearRuns(cwd, run) {
  const root = teamRoot(cwd);
  if (run) {
    try { await rm(join(root, run), { recursive: true, force: true }); return { kind: 'success', text: `已清理 run ${run}。` }; }
    catch { return { kind: 'error', text: `未找到 run "${run}"。` }; }
  }
  try { await rm(root, { recursive: true, force: true }); return { kind: 'success', text: '已清理全部专家团 run。' }; }
  catch { return { kind: 'error', text: '清理失败。' }; }
}

/**
 * L3-2′（可清算）：`/team settle [<run>]` —— 把冷启动后**没人做**的在飞任务清回可再派。
 *
 * 这是"喊一嗓子式恢复"的补丁：`resumeRun` 只查配额、写日志、发一句 followup，
 * **不核对在飞任务**（实测：重启后 `in_progress` 的任务永远停在原地，且无人知晓）。
 *
 * 刻意**只清算、不派工**：清算改数据，属显式动作；派工交给 lead 恢复后按 TASKS 自己领。
 * 也刻意**不自动**：自动改 TASKS.json 会在"成员其实还在跑"时误伤（面板与 CLI 的活跃视图不一定一致），
 * 所以由用户/lead 显式调用，并在 RUN.log 留痕。
 */
async function settleRuns(cwd, runArg, ctx) {
  const root = teamRoot(cwd);
  const dir = runArg ? join(root, runArg) : await pickleLatestRunDir(root);
  if (!dir) return { kind: 'error', text: '没有 run 可清算。用 /team settle <run> 指定，或 /team status 查看。' };
  const runId = basename(dir);
  const tasksRaw = await readJsonSafe(join(dir, 'TASKS.json'));
  if (!tasksRaw) return { kind: 'error', text: `run "${runId}" 缺 TASKS.json，无法清算。` };
  const arr = taskList(tasksRaw);
  // 活跃角色：以**本会话的活子代理**为准；拿不到就按"全都已死"处理（冷启动的真实情况）
  let liveRoles = new Set();
  let liveKnown = false;
  try {
    const subs = await listSubagentStatusBySession(ctx, '', []);
    await resolveSubRoles(ctx, subs, await workflowChildLabels(ctx, ''));
    liveRoles = new Set(subs.map((s) => roleNorm(roleOfSub(s) || '')).filter(Boolean));
    liveKnown = true;
  } catch { /* best-effort */ }
  const stranded = strandedTasks(arr, liveRoles);
  if (!stranded.length) {
    return { kind: 'success', text: `run "${runId}"：没有搁浅任务（在飞 ${arr.filter((t) => IN_FLIGHT_STATUSES.includes(t.status)).length} 个，均有存活成员或本会话查不到成员信息）。` };
  }
  const settledRes = settleStranded(arr, stranded, { reason: `冷启动搁浅清算（${liveKnown ? '按本会话活跃成员判定' : '本会话无成员信息'}）` });
  // O2：settle 也走 CAS（陈旧时对**新鲜**内容重跑一遍清算，而不是把旧数组写回去）
  const sr = await mutateTasks(dir, (json) => {
    const freshArr = taskList(json);
    const freshStranded = strandedTasks(freshArr, liveRoles);
    const out = settleStranded(freshArr, freshStranded, { reason: `冷启动搁浅清算（${liveKnown ? '按本会话活跃成员判定' : '本会话无成员信息'}）` });
    return { next: { ...json, tasks: out.tasks }, result: out.settled };
  });
  if (!sr.ok) return { kind: 'error', text: `TASKS.json 写入失败[${sr.code}]：${sr.error}` };
  if (sr.result && Array.isArray(sr.result) && !sr.result.length) return { kind: 'success', text: `run "${runId}"：没有搁浅任务（首次评估后已被别人收敛）。` };
  const settledList = sr.result || [];
  await appendLog(dir, `lead:settle — ${settledList.length} 个搁浅任务清回 pending：${settledList.map((s) => `${s.id}(${s.from})`).join(', ')}`);
  return {
    kind: 'success',
    text: [
      `run "${runId}"：已清算 ${settledRes.settled.length} 个搁浅任务（→ pending，attempt+1，已在 RUN.log 留痕）：`,
      ...settledRes.settled.map((s) => `  · ${s.id}  ${s.from} → pending`),
      '下一步：让 lead 按 TASKS.json 重新派工（或 /team resume 后自己领活）。',
    ].join('\n'),
  };
}

// ── create + launch ────────────────────────────────────────────────────────

async function createRun(ctx, invocation, cwd, mode) {
  if (mode.profile) mode = resolveProfile(mode.profile, mode); // apply a named profile (roles/deliverable/note)
  // ── roster 三项兜底（1.3.4 接线）：**flag > 设置 > 常量**，唯一落点 ────────────────────
  // 放在 `--profile` 之后：命名档位（`resolveProfile`）显式点过的 roles/deliverable 仍优先于设置，
  // 与"用户在命令里点名 > 控制台偏好"同一条纪律。
  const rosterSet = rosterSettings();
  const rd = resolveRosterDefaults(mode, rosterSet, DEFAULT_ROLES);
  mode.persist = rd.persist;
  mode.noCode = rd.noCode;
  mode.rolesBase = rd.rolesBase;
  mode.rolesFromSettings = rd.rolesFromSettings;
  if (rd.roles && !(mode.roles && mode.roles.length)) mode.roles = rd.roles;
  // ── G 线（档位）：先定档位，再建 run（档位要写进 TASK/ROSTER/STATE 三份工件）──────────
  // ① 显式 `--tier` **认不出来就拒绝**：静默退回默认会让用户以为自己选的那个生效了 ——
  //    这正是本仓反复复发的"沉默 ≠ 允许"（SKILL §7.29）。
  const pickedTier = mode.tierRaw ? normalizeTier(mode.tierRaw) : null;
  if (mode.tierRaw && !pickedTier) {
    return {
      kind: 'error',
      text: [
        `⛔ 档位取值无法识别：「${mode.tierRaw}」`,
        `- 合法值：${tierChoices().map((c) => `${c.label}（${c.tier}）`).join(' / ')}`,
        '- 也可以**不写** `--tier`：建 run 时会按项目规模与目标给出建议档位，并在浮层给你三选一。',
      ].join('\n'),
    };
  }
  // ② 没显式指定 ⇒ 按"项目规模 + 目标关键词"**建议**（建议 ≠ 替你选，见 SKILL §1 档位表）。
  const size = await probeProjectSize(cwd);
  const suggestion = suggestTier({ goal: mode.task, ...size });
  mode.tier = pickedTier || suggestion.tier;
  mode.tierPicked = pickedTier;        // 显式选的：不再问
  mode.tierSuggestion = suggestion;    // 建议 + 依据：要如实展示给用户
  // ③ **档位真正省派工的地方**：显式 `--tier` 且用户没点过角色名 ⇒ 按档定班底。
  //    （没显式指定时**不**在这里收窄：档位选择发生在浮层，用户选完那一刻才收窄 —— 见 /decide 路由。）
  //    `--roles` / `--profile` 点过名的，一律不动（`narrowedRoles` 只看"是不是基线班底"）。
  //    1.3.4：班底来自**设置**（`roster.defaultRoles`）时也算"基线" ⇒ 收窄仍应生效，
  //    只是基线换成设置里那套（否则"设了默认班底"会让档位收窄静默失效）。
  if (pickedTier && (!(mode.roles && mode.roles.length) || mode.rolesFromSettings)) {
    const narrowBase = mode.rolesBase || DEFAULT_ROLES;
    const next = narrowedRoles(pickedTier, (mode.roles && mode.roles.length ? mode.roles : narrowBase), narrowBase);
    if (next) { mode.roles = next; mode.rolesNarrowedBy = pickedTier; }
  }
  // 批 0-3：planDiscarded **代码强制** —— 用户明确丢弃过的同目标团队，不得由 lead 自动重建。
  // SKILL 规则 19 早已承诺这一点，但此前代码从不读该标记（只置位），等于软约束。
  // 解锁必须显式：/team --allow-rebuild …（并在 RUN.log 留痕）。
  const gk = goalKeyOf(mode.task);
  if (gk && !mode.allowRebuild) {
    const hit = await findDiscardedGoal(cwd, gk);
    if (hit) {
      return {
        kind: 'error',
        text: [
          `⛔ 拒绝自动重建：该目标已被用户丢弃（run "${hit.runId}"${hit.at ? '，' + hit.at : ''}）`,
          hit.reason ? `- 丢弃原因：${hit.reason}` : '',
          '- 依据：SKILL 规则 19「丢弃后禁止自动重建同目标团队，除非用户明确再次要求」。',
          '- 若用户确实要重开，请显式解锁：`/team --allow-rebuild <原目标文本>`（会记入 RUN.log）。',
          '- 或换一个目标表述（目标指纹不同则不再拦截）。',
        ].filter(Boolean).join('\n'),
      };
    }
  }
  // allowRebuild 的留痕需要 runDir，故推迟到 scaffoldRun 之后（见下）
  const unlockFrom = gk && mode.allowRebuild ? await findDiscardedGoal(cwd, gk) : null;
  await autoAggregate(cwd); // aggregate prior runs before launching a new one
  const skillTarget = await ensureSkillInstalled();
  const presetTarget = await ensurePresetInstalled();
  const { runId, runDir } = await scaffoldRun(cwd, mode);
  if (unlockFrom) {
    await appendLog(runDir, `plan:unlock — 用户显式 --allow-rebuild 重建被丢弃的目标（原 run "${unlockFrom.runId}"，丢弃于 ${unlockFrom.at || '未知'}）（${ts()}）`);
  }
  rememberSessionRun(invocation?.agent?.session?.id, cwd, runId, 'create'); // 归属：本会话创建了这个 run
  // 同时把归属写进 STATE.json —— 进程重启后 session-runs.json 可能被覆盖（用户从下拉里
  // 「查看」别的 run 会改写映射），而 STATE.json 是 run 自己的、不会被别的会话动。
  const ownerSid = String(invocation?.agent?.session?.id || '');
  if (ownerSid) {
    try {
      const st = await readJsonSafe(join(runDir, 'STATE.json'));
      if (st && !st.ownerSession) { st.ownerSession = ownerSid; await ARTIFACT.must(join(runDir, 'STATE.json'), st); }
    } catch { /* best-effort：归属缺失只影响跨会话查看，不影响本会话 */ }
  }
  await persistSessionRuns();
  // 多会话协作提示（优化①）：建 run 时检测同工作区**别的会话**的活跃 run —— 提示但不阻断。
  // "活跃" = 非终态且 ownerSession 已知且 ≠ 本会话。
  // 为什么提示而不阻断：命令模式没有交互能力，而"并行两个 run"是**合法**使用（不同任务、不同目标），
  // 阻断会误伤；但**完全不提示**又是"他人在改我却不知道"的失败模式。
  let parallelNote = '';
  try {
    const others = (await listRunsInWorkspace(cwd)).filter((r) =>
      r.ownerSession && r.ownerSession !== ownerSid && !['done', 'completed', 'failed', 'cancelled'].includes(r.status) && r.health !== 'discarded'
    );
    if (others.length) {
      parallelNote = `\n\n⚠ 注意：同工作区有 **${others.length} 个别的会话的活跃 run**：${others.map((r) => `${r.runId}（${phaseZh(r.phase)}）`).join('、')}。`
        + `两个 run 共享 \`team/\` 目录但文件级写锁（C1）已保证**不会互相覆盖**；`
        + `但同一工件被两边读改仍可能有语义冲突 —— 建议协调，或先完成一个再开另一个。`;
    }
  } catch { /* 检测失败不影响建 run */ }
  // ── G 线（档位）：**每次新建 team 都出现一次档位选择**（用户拍板 #5）──────────────
  // 为什么不阻塞派工：E1 要求 run 开始 10 分钟内就有可运行骨架；若卡在"等用户选档位"，
  // 用户不在时反而更慢。所以**建议档位先生效**，浮层同时给出三选一，用户改了就即时写回
  //（见 `/decide` 路由的 `tier-select` 分支）。显式 `--tier` 视为用户已经选过，不再问。
  let tierNote = '';
  if (!mode.tierPicked) {
    try {
      const st = await readJsonSafe(join(runDir, 'STATE.json'));
      if (st) {
        st.pendingDecision = {
          kind: 'tier-select',
          title: '选择档位',
          prompt: [
            `本次按**建议档位**开工：${tierSummaryLine(mode.tier)}`,
            `- 建议依据：${(mode.tierSuggestion && mode.tierSuggestion.reasons || []).join('；') || '（无）'}`,
            `- 规模信号：${size.fileCount === null ? '未知' : `${size.fileCount} 个代码文件 / ${size.totalBytes === null ? '字节数未统计' : `${Math.round(size.totalBytes / 1024)}KB`}`}${size.capped ? '（超过探测上限）' : ''}`,
            '- 档位只裁"角色与独立环节"，**不裁验收面**：任何档位都必须有 clarify（含边界十问）与交付前真实校验。',
            '- 不改也能跑：系统按上面那个档位继续；改了立刻生效。',
          ].join('\n'),
          options: tierChoices().map((c) => c.label),
          at: new Date().toISOString(),
        };
        st.updatedAt = new Date().toISOString();
        // `hard` 门：记下"这个 run 是**因为等选档位**才没开工的"—— `/decide` 靠它决定选完之后
        // 要不要投递派工消息（`soft` 门**不能**有这个标记，否则用户改档会二次开工）。
        if (TIER_GATE === 'hard' && !mode.confirm) st.heldForTier = true;
        await ARTIFACT.must(join(runDir, 'STATE.json'), st);
      }
    } catch { /* best-effort：立不上待决不影响开工，档位仍已写进三份工件 */ }
    // ⚠️ 只有在**真的写下了** `heldForTier` 时才拦下派工：读写 STATE 失败时宁可按 soft 开工
    //（"卡住用户"比"多派一次工"贵得多 —— 卡住时用户还没有任何可见的等待线索）。
    if (TIER_GATE === 'hard' && !mode.confirm) {
      let held = false;
      try { const cur = await readJsonSafe(join(runDir, 'STATE.json')); held = !!(cur && cur.heldForTier); } catch { held = false; }
      if (held) {
        return {
          kind: 'success',
          text: [
            `已组队 run "${runId}"（**等待你选档位**）：`,
            `- 模式：${mode.persist ? '持久化活团队' : '一次性自动组队'}`,
            `- 建议档位：${tierSummaryLine(mode.tier)}`,
            `- 依据：${(mode.tierSuggestion && mode.tierSuggestion.reasons || []).join('；') || '（无）'}`,
            `- 工作区：${runDir}`,
            '**未自动派工**：档位门设为 `hard`（不选不开工）。面板「待决」横幅有三选一（快速档 / 标准档 / 严格档），点完即按所选档位投递派工消息。',
            '要把门改回"建议先生效"，去掉 `DSH_EXPERT_TEAM_TIER_GATE=hard`（或 `config.tierGate`）即可。',
          ].join('\n') + parallelNote,
        };
      }
    }
    tierNote = `\n\n🎚 档位：**${tierSummaryLine(mode.tier)}**（\`${mode.tier}\` 仅作机器字段）。`
      + `\n- 依据：${(mode.tierSuggestion && mode.tierSuggestion.reasons || []).join('；') || '（无）'}`
      + `\n- 浮层已给出**三选一**（快速档 / 标准档 / 严格档）：每次新建 team 都要选一次，系统不记住上次的选择；不改则按上面这个档位跑。`
      + `\n- 直接指定：\`/team --tier 严格档 <目标>\`。`;
  } else {
    tierNote = `\n\n🎚 档位：**${tierSummaryLine(mode.tier)}**（你显式指定，已落进 TASK.md / ROSTER.json / STATE.json）。`
      + (mode.rolesNarrowedBy
        ? `\n- 已按档**定班底**：${(mode.roles || []).join(', ')}（你没点过角色名 ⇒ 按${TIER_LABELS_ZH[mode.rolesNarrowedBy]}的默认班底；要保留别的角色就加 \`--roles\`）。`
        : '\n- 班底按你指定的 `--roles` / `--profile` 保持不变（档位**不改写**用户点过名的编制）。');
  }
  // --confirm（大需求执行前询问）：**不自动派工** —— 立一个 pendingDecision（面板会有决策横幅），
  // 由用户点「执行 / 查看方案 / 补充意见」再开工。复用现有 pendingDecision 机制，不新增链路。
  // ⚠️ 与档位待决**互斥**（STATE 只有一个 pendingDecision 槽）：--confirm 优先 —— 它更"卡"，
  // 而档位在 --confirm 的提示里如实带出，用户仍看得到。
  if (mode.confirm) {
    try {
      const st = await readJsonSafe(join(runDir, 'STATE.json'));
      if (st) {
        st.pendingDecision = {
          kind: 'confirm-before-execute',
          title: '大需求确认',
          prompt: `已组建 run "${runId}"（${(mode.roles && mode.roles.length ? mode.roles : DEFAULT_ROLES).length} 个角色）。\n方案见工件：${join(runDir, 'SPEC.md')} / ${join(runDir, 'PLAN.md')}（可在面板「件」页点开）。`,
          options: ['执行', '查看方案', '补充意见'],
          at: new Date().toISOString(),
        };
        st.updatedAt = new Date().toISOString();
        await ARTIFACT.must(join(runDir, 'STATE.json'), st);
      }
    } catch { /* best-effort：待决立不上时仍走正常派工 */ }
    return {
      kind: 'success',
      text: [
        `已组队 run "${runId}"（**等待确认**）：`,
        `- 模式：${mode.persist ? '持久化活团队' : '一次性自动组队'}`,
        `- 编制：${(mode.roles && mode.roles.length ? mode.roles : DEFAULT_ROLES).join(', ')}`,
        `- 工作区：${runDir}`,
        `**未自动派工**。面板「待决」横幅有三个选项：执行 / 查看方案（点开 SPEC.md / PLAN.md）/ 补充意见。`,
        `点「执行」后即按正常流程开工；点「补充意见」可直接回复，lead 会收到。`,
      ].join('\n') + tierNote + parallelNote,
    };
  }
  // F 线第 4 项：把当前身份设置冻结成本 run 的 `POLICY.md`（可审计 + 子代理可读）。
  // 位置在 `launchMessage` **之前** —— 启动消息要靠读它来注入口径块。
  let policyWritten = '';
  try {
    const policy = compilePolicy(currentSettings());
    await ARTIFACT.must(join(runDir, 'POLICY.md'), policy.md);
    policyWritten = policy.label;
    await appendLog(runDir, `policy:frozen — 身份策略（${policy.label} / profile=${policy.profile}；方案确认门${policy.keepPlanGate ? '保留' : '**用户已关闭**'}）（${ts()}）`);
  } catch (e) { /* 策略写不进去不该拦住建 run（技能文本仍是默认口径） */ }
  const msg = await launchMessage(mode.task, cwd, runDir, mode);
  invocation.agent.followup(msg);
  const note = skillTarget
    ? `skill 已就绪：${skillTarget}`
    : '提示：expert-team skill 未安装到 $DSH_HOME/skills（bundle 资源不可读时会发生）；团队仍可按运行目录内 TASK.md 的说明推进。';
  const presetNote = presetTarget
    ? `角色 preset 已就绪：${presetTarget}（会话切到「专家团模式」即可用 subagent_pm/architect/backend/frontend/qa 角色工具）`
    : '提示：expert-team preset 未安装；持久化成员将用通用 subagent 回退（角色人设在 prompt 内）。';
  return {
    kind: 'success',
    text: [
      `已组队 run "${runId}"：`,
      `- 模式：${mode.persist ? '持久化活团队' : '一次性自动组队'}`,
      `- 编制：${(mode.roles && mode.roles.length ? mode.roles : DEFAULT_ROLES).join(', ')}`,
      `- 工作区：${runDir}`,
      `- 交付：${mode.noCode ? '仅工件' : '代码 + 工件'}`,
      note,
      presetNote,
      (policyWritten ? `身份策略已冻结：**${policyWritten}**（\`POLICY.md\`，随本 run 生效）` : ''),
    ].filter(Boolean).join('\n') + tierNote + parallelNote,
  };
}

// ── dispatcher ─────────────────────────────────────────────────────────────

async function executeTeamCommand(ctx, invocation) {
  // 批 2-3（L1-3′）：把本次写入者身份登记下来（会话级；run 级信息在解析出 runId 后由调用方补）
  WRITER_IDENTITY = { sessionId: String(invocation?.agent?.session?.id || ''), runId: '', role: 'lead' };
  const c = parseTeamCommand(invocation.rawInput);
  const cwd = invocation.agent?.session?.header?.cwd ?? process.cwd();
  await registerWorkspace(cwd); // remember this workspace so the overlay lists its runs
  // Multi-run isolation: when a run-targeting command omits `--run`, fall back
  // to THIS session's own run (memory) — never silently pick the workspace's
  // latest, which may belong to a parallel team in another session.
  const mem = sessionRunFor(invocation?.agent?.session?.id);
  const memRun = (mem && mem.workspace === cwd) ? mem.runId : '';
  const runArg = (s) => s || memRun;
  switch (c.kind) {
    // 懒重探兜底（2026-09-15）：加载当刻的探测可能"太早"（那时别人的服务还没挂上）。
    // `/team help` 是"用户真的来看能做什么"的时刻 ⇒ 顺手重探一次并更新结论，
    // 这样刚装上/刚修好配置的插件**不必为了这一行提示再重启**。
    case 'help': recheckOptionalPlugins(ctx); return { kind: 'success', text: USAGE };
    case 'status': return renderStatus(cwd);
    case 'members': return renderMembers(cwd);
    case 'models': return renderModels(cwd, runArg(c.run));
    case 'tier': return setTier(cwd, runArg(c.run), c.tier);
    case 'task': return renderTaskUpdate(cwd, runArg(c.run), c.id, c.status, c.note);
    case 'canvas': return renderCanvas(ctx, invocation, cwd, runArg(c.run), c.watch);
    case 'learn': return c.deep ? renderDeepLearn(cwd) : learnRuns(cwd);
    case 'board': return renderBoard(cwd);
    case 'detail': return renderRunDetail(cwd, runArg(c.run));
    case 'limit': return renderRunLimit(cwd, runArg(c.run), c.maxRuns, c.deadline, c.clear);
    case 'index': return renderIndex(cwd);
    case 'codeindex': return renderCodeIndex(cwd);
    case 'search': return renderSearch(cwd, c.kw);
    case 'devcontainer': return renderDevcontainer(cwd, c.write, runArg(''));
    case 'migrate': return migrateRun(cwd, c.run);
    case 'check': return checkRun(cwd, runArg(c.run));
    case 'resume': return resumeRun(ctx, invocation, cwd, c.run);
    case 'rules': return rulesRun(cwd, c.action, c.rule);
    case 'clear': return clearRuns(cwd, c.run);
    case 'uninstall': return uninstallInstalled();
    case 'settle': return settleRuns(cwd, c.run, ctx);
    case 'wait': return waitRun(cwd, c.run);
    case 'create': return createRun(ctx, invocation, cwd, c);
    default: return { kind: 'error', text: c.text ?? USAGE };
  }
}

// Test-only hooks for the live activity feed (unit-verifiable pure parts).
/** 并发写追踪器：**进程级单例**（跨工具调用累积；`_live` 暴露以便单测重置与断言）。 */
const WRITE_TRACER = createWriteTracer();

/**
 * lead 工具面告警去重：同一 status 每个进程只喊一次。
 * 为什么：该告警按 **agent 创建**触发，一个会话里每建一个 agent 都会喊 —— 十行同样的 warn
 * 会把"响亮"变成"噪声"，而噪声的代价是所有告警一起被降权（本仓反复记录过的失败模式）。
 * 去重只影响**重复次数**，不影响"第一次一定喊"，也不合并不同 status（两种零仍然分得清）。
 */
const LEAD_TOOLFACE_WARNED = new Set();
let LEAD_TOOLFACE_OFF_LOGGED = false;
function warnLeadToolFaceOnce(status, detail) {
  if (LEAD_TOOLFACE_WARNED.has(status)) return;
  LEAD_TOOLFACE_WARNED.add(status);
  console.warn(`[expert-team] lead 工具面**未**收窄（${status}）：${detail}`);
}

/**
 * 把"分步计时"（`steps`）与"附带账本"（`extras`）合成 `profile`。
 *
 * 为什么需要它（真实事故，1.3.20 之前就在）：
 *   `mark('subs')` 会写 `steps.subs = <毫秒数>`，而附带账本里那个 subs 计数器对象**也叫 `subs`**，
 *   合成时后者盖掉前者 ⇒ `profile.subs` 到底是"耗时"还是"计数器"说不清，**那一步的耗时被静默吞掉**
 *   （上一轮只能拿"各步之和与总耗时之差"反推，属于用算术补测量）。
 *
 * 所以这里把两件事**结构性**分开：
 *   · 数值步耗时归 `steps`（键名 = `mark()` 的名字，全仓统一）；
 *   · 结构化账本一律另起名字（如 `subsCounters` / `rolesBudget`），不再与步名同名。
 * 并且**绝不允许静默覆盖**：万一以后又撞名，保留步耗时（那是测量值，丢了就没法复现），
 * 把撞的键名如实记进 `profileKeyCollisions` —— 让"撞名"这件事在响应里可见，而不是靠人记得。
 *
 * @param {Record<string, number>} steps - `mark()` 累积的步耗时。
 * @param {Record<string, unknown>} [extras] - 附带账本（计数器 / 预算快照）。
 * @returns {Record<string, unknown>} 合成后的 profile（**不改动入参**）。
 */
export function assembleStateProfile(steps, extras) {
  const out = Object.assign({}, steps);
  const collisions = [];
  for (const k of Object.keys(extras || {})) {
    if (Object.prototype.hasOwnProperty.call(out, k)) { collisions.push(k); continue; }
    out[k] = extras[k];
  }
  if (collisions.length) out.profileKeyCollisions = collisions;
  return out;
}

/**
 * 把「本轮缺了什么」分成**两个承载位**（1.3.22）。
 *
 * 为什么必须分（真机实测，不是洁癖）：
 *   真机 95 个 agent、`MAX_ROLE_SUBS=60` ⇒ `degradedReason="roles:35,feed:35"` **每一轮都出现**。
 *   可那 35 是**按设计的能力上限**（我们主动规定"只对前 60 条做最贵的日志解析"），不是故障。
 *   后果：降级标记**长期常亮** ⇒ 真正的"期限截断"与"读失败"被这盏永久灯一起降权
 *   —— **常亮的告警等于没有告警**（本仓在 `subs:throttled` / `warming` 上已经吃过两次同样的亏）。
 *
 * 三者的判据（不许混用）：
 *   · `degraded`  = **真故障**：本轮真的少算了东西，而且是**没料到**的那种 —— 软期限截断
 *     （`*:deadline`）、读失败（`wf:read-error`）⇒ 值得有人去看；
 *   · `scopeCaps` = **按设计的能力上限**：主动只处理前 N 条。数字**一个不少**地照发，但它不是故障；
 *   · `warming`   = 重读挪到后台（数据来自上一份**完整**快照或暂时缺席），由调用方另行承载。
 *
 * ⚠️ "不报警" ≠ "隐藏"：拆开只是为了不让上限把真告警淹没；上限的数字照发（`over`/`limit`/`total`），
 *    任何声称完整的地方都不许因为拆了标记而变得看似完整。
 * ⚠️ 反向纪律：**不许把真故障混进 `scopeCaps`** 去把灯灭掉 —— 那是拿可见性换门面。
 *
 * @param {{cuts?: string[], readErrors?: string[], caps?: Array<{key: string, total: number, limit: number}>}} [facts]
 * @returns {{degraded: string[], scopeCaps: Record<string, {over: number, limit: number, total: number}>}}
 */
export function classifyStateShortfall(facts = {}) {
  const degraded = [];
  for (const c of (facts.cuts || [])) if (c) degraded.push(String(c));
  for (const c of (facts.readErrors || [])) if (c) degraded.push(String(c));
  const scopeCaps = {};
  for (const c of (facts.caps || [])) {
    if (!c) continue;
    const total = Number(c.total) || 0;
    const limit = Number(c.limit) || 0;
    // 没有真的越限 ⇒ 什么都不报（不许无中生有：上限只在**真被挡住**时才出现在负载里）
    if (!(total > limit)) continue;
    scopeCaps[String(c.key)] = { over: total - limit, limit, total };
  }
  return { degraded, scopeCaps };
}

export const _live = { assembleStateProfile, classifyStateShortfall, pushActivity, phaseAccountingViolations, loggedPhases, authorityViolations, WRITE_TRACER, createWriteTracer, formatConflict, summarizeTool, parseLogLine, roleOfSub, mapRoleToSub, membersFromState, memberAgentIds, isAgentIdLike, buildRoleSubMap, resolveSubRoles, childSessionTiming, subHeaderIndex, sessionExists, sessionOwnsWorkspace, SUB_HEADER_CACHE, workflowEventIndex, workflowChildLabels, workflowChildMeta, workflowRuns, WF_EVENT_CACHE, rememberSessionRun, sessionRunFor, runOwnerSession, SESSION_RUNS, parseTeamCommand, deriveMemberEntries, schemaViolations, runHealth, RUN_STALL_MS, scaffoldFingerprint, SCAFFOLD_REQUIRED, strandedTasks, settleStranded, IN_FLIGHT_STATUSES, normalizeCoverage, SCHEMA_WARN_SEEN, pushActivityEvent, DEFAULT_LIMITS, LIMITS, resolveLimits, capacityViolations, DEFAULT_ROUND_LIMITS, ROUND_LIMITS, ROUND_LIMIT_ENV, resolveRoundLimits, ROUND_LIMIT_OF_KIND, roundOf, isQualityTask, normTitle, roundLimitViolations, reworkLoopWriteGuard, mutateTasks, readStandingRules, appendStandingRule, rulesRun, scopeOverlapWarnings, applyTaskStatus, waitRun, eventFamily, verdictFromToken, normalizeRoleName, truncateCodepoints, filterRunScopedSubs, runCreatedAtMs, runLogTail, liveFiles, LIVE_FILES_CACHE, DEFAULT_ROLES, resolveTierGate, TIER_GATE_ENV, snapshotRun, parseStateSections, listRunsInWorkspace, runsIndexPath, RUNS_INDEX_STATS, _resetRunsIndex, settingsPath, loadSettingsSync, currentSettings, limitsBaseFromSettings, roundLimitsBaseFromSettings, effectiveTierGate: () => TIER_GATE, ensureSkillInstalled, ensurePresetInstalled, uninstallInstalled, buildSkillRegistration, parseSkillMarkdown, PLUGIN_VERSION, INSTALL_STAMP, runtimeSkillRegistered: () => RUNTIME_SKILL_REGISTERED, agentScopedToolNames, warnLeadToolFaceOnce, resolveLeadToolFace, LEAD_TOOLFACE_ENV, effectiveLeadToolFace: () => LEAD_TOOLFACE, resolveLoopGuard, LOOP_GUARD_ENV, effectiveLoopGuard: () => LOOP_GUARD_ENABLED, resolveRosterDefaults, rosterSettings, createRun, watchScript, canvasPollMs, installHostSettings, hostValues, hostScope, hostSettingsNote, updateHostSettings, pickFileOnly, pickHostExpressible, buildHostSchema, hostBase, hostSchemaPaths, reapplySettingsDerived, currentSettings, mergeSettings, detectOptionalPlugins, OPTIONAL_PLUGINS, scheduleEffortPreflight, _resetEffortPreflight, effortPreflightPlan, declaredEffortsFromPresetSource, hintOptionalPluginsOnce, _resetOptionalHintOnce, scheduleOptionalPluginCheck, recheckOptionalPlugins, OPTIONAL_PROBE_DELAYS_MS, loaderEntryNames, hindsightToolReady, costMeterReady, listSubagentStatusBySession, cachedListSessions, _resetListSessionsCache, LIST_SESSIONS_TTL_MS, SUB_HEADER_MEMO, SUB_HEADER_STATS, _resetSubHeaderMemo, SUB_ROWS_MEMO, SUB_UNCOVERED_SINCE, _resetSubRowsMemo, liveChildRows, warmSubRows, sessionsRootStamp, resetRoleReadBudget, roleReadBudgetSnapshot, syncRolePending, _resetRolePending, ROLE_READ_BUDGET_PER_REQUEST, SUBS_ENUM_MIN_INTERVAL_MS, SUBS_ENUM_DEADLINE_MS, ROLES_READ_MIN_INTERVAL_MS, ROLES_READ_PER_BURST, ROLES_READ_DEADLINE_MS, ROLES_WARM_MIN_INTERVAL_MS, ROLES_WARM_BUDGET_MS, ROLES_WARM_MAX_READS, ROLES_WARM_CHUNK, ROLES_WARM_YIELD_MS, SUBS_NOT_READY_MAX_MS, subsEnumAllowed, roleReadAllowance, rolesWarmAllowed, ROLE_READ_STATS, _resetBoundedState, ROLE_READ_LOG_CACHE: SUB_ROLE_LOG_CACHE, warmWorkflowEventIndex, workflowEventIndexCached, workflowEventIndexForRequest, WF_EVENT_FIRST_DEADLINE_MS, WF_EVENT_STATS, WF_EVENT_INFLIGHT, _resetWfEventMemo, warmSubRoles, ROLE_WARM_STATS, roleWarmHasWork, _resetRoleWarm, wfWarmDelayMs, rolesWarmDelayMs, isRoleWarmRunning: () => ROLE_WARM_RUNNING, SKILL_DIR, PRESET_DIR: fileURLToPath(PRESET_SRC).replace(/[\\/]+$/, ''), relayInstalledAssets, layFactsFor, layInstalledAsset, classifyLayTarget, describeLayOutcome, presetLayStatus, _resetPresetLay, listEntryNames, cleanStaleLayDirs, layDirAtomic, LAY_TMP_PREFIX, LAY_STATES, LAY_ACTIONS, LAY_KINDS, LAY_OUTCOMES, skillRuntimeRegisteredRecord };

export function apply(ctx, config) {
  // 留一份 config：设置在运行时改变（官方面板 / 浮层）时要**用同一份 config** 重算上限与档位门，
  // 否则 config 覆写会在重算时被悄悄丢掉（"改了设置，用户配的 config 上限没了"这种伤最难查）。
  PLUGIN_CONFIG = config || {};
  // F 线：先读设置（同步、一次性）—— 它是**最低优先级**的来源（config > env > 设置 > 内置默认）。
  const settingsRepairs = loadSettingsSync().repaired;
  if (settingsRepairs.length) {
    try { console.warn('[expert-team] 设置里有非法值，已按默认处理：', JSON.stringify(settingsRepairs)); } catch { /* 观测失败不影响加载 */ }
  }
  // O-3：容量上限（可在 config 覆写 —— cordis 以 `apply(ctx, config)` 调用，已核实宿主如此）
  resolveLimits(config, limitsBaseFromSettings());
  // P3（SPEC §1.1）：**轮次**上限与容量上限在**同一处**解析（config.limits > env > 设置 > 默认），
  // 否则两套上限会各自漂移：一个读 config、一个只读默认。
  resolveRoundLimits(config, roundLimitsBaseFromSettings());
  // G 线：档位门软/硬（config.tierGate > DSH_EXPERT_TEAM_TIER_GATE > 设置 > soft）。
  resolveTierGate(config, currentSettings().gates);
  // A 线开关：config > env > 设置 > 默认(on)。关掉即 lead 保留全部工具。
  resolveLeadToolFace(config, currentSettings().gates);
  // C 线振荡检测开关：config > env > 设置 > 默认(on)。此前只读 config ⇒ 设置页那个复选框是空转的。
  resolveLoopGuard(config, currentSettings().gates);
  // 批 2-1：宿主若提供 ctx.fs，就让它接管工件写入（真实版本栅栏）；否则保持同语义的回退实现。
  // 机会式探测而非 inject —— 见 ARTIFACT 声明处的说明（inject 缺失服务会让整条命令挂不上）。
  const hostFsAdopted = adoptHostFs(ctx);
  if (hostFsAdopted) console.log('[expert-team] 工件写入已接管宿主 ctx.fs 版本栅栏');
  // skill 走**运行时注册**（不写盘）：这是默认路径，也是"卸载即干净"的前提。
  // 宿主没有 skill 注册表时返回 false，`/team` 会退回自举复制（行为与从前一致）。
  registerRuntimeSkill(ctx);
  // 设置注册到宿主命名空间：官方面板可改、随市场的备份/恢复走、改动即时生效（watch → 重算）。
  // `base` 用**当前生效设置**填充 ⇒ 面板一打开看到的就是真正在用的值，不需要任何一次性迁移。
  installHostSettings(ctx, {
    base: currentSettings(),
    onResolved: () => reapplySettingsDerived(),
  });
  // ── 子代理列表「最新在上」（展示顺序覆盖）────────────────────────────────────
  // 为什么要 `inject(['subagents'])` 而不是在 apply 里直接装：服务可能在插件加载**之后**才就绪，
  // 直接在 apply 里 `ctx.get('subagents')` 可能拿不到 ⇒ 开关默认开着却"未生效"。
  // inject 的回调在服务可用时触发，那才是唯一可靠的装载时机。
  // 拿不到 ctx / 宿主没有 inject（测试替身、老宿主）就**只做一次即时尝试**，
  // 状态如实标 `service-missing`，**绝不**因此让插件挂不上。
  if (typeof ctx.inject === 'function') {
    ctx.inject([SUBAGENT_ORDER_SERVICE], (sctx) => {
      SUBAGENT_ORDER_CTX = sctx;
      syncSubagentOrder(sctx);
    });
  }
  // apply 时若服务已在位，立即装一次（inject 回调同样会跑，applySubagentOrder 是幂等的）。
  syncSubagentOrder(ctx);
  // 卸载：把自有属性删掉，不留痕迹（`disposeSubagentOrder` 只删**我们自己装的**那个）。
  try {
    ctx.effect(() => () => {
      try { disposeSubagentOrder(); } catch { /* 卸载失败不该影响宿主关闭流程 */ }
      SUBAGENT_ORDER_CTX = null;
    });
  } catch { /* 老宿主没有 effect ⇒ 不挂清理钩子，功能不受影响 */ }
  // ── 插件装着 ⇒ 它的 preset 就该在位 ─────────────────────────────────────────
  // 为什么必须在**加载时**铺、而不是等首次 `/team <任务>`：preset 是**会话创建时**读取的，
  // 中途缺失会让正在使用它的会话直接丢掉角色工具（2026-09-15 真实事故：用户跑 `/team uninstall`
  // 之后「专家团模式」消失，会话里 `subagent_pm/researcher/...` 12 个角色工具全部消失）。
  // 契约因此是「**插件装着 ⇒ preset 在位**」：`/team uninstall` 只清"当前那份副本"，
  // 插件只要还装着，下次加载就重新铺；真正的卸载是在插件市场里移除插件本身。
  // 用 fire-and-forget：铺不上（$DSH_HOME 不可写等）绝不能让插件挂不上。
  installInBackground('preset', () => ensurePresetInstalled());
  // skill 已有运行时注册时这里立即返回（零成本）；只有宿主没有 skill 注册表时才真复制。
  installInBackground('skill', () => ensureSkillInstalled());
  // 推荐插件自检：纯读、缺了只打一行、装了完全不打扰（见 detectOptionalPlugins 的注释）。
  // ⚠️ **不能在加载当刻就下结论**：我们的 apply() 跑在其它插件之前，那一刻 costMeter/工具表
  // 里还没有它们 ⇒ 已装且可用的插件会被误判成"已安装但当前未就绪"（2026-09-15 真实假警报）。
  // 现在改为**就绪后重探**（有界延迟 + `ctx.inject` 事件驱动，见 scheduleOptionalPluginCheck）。
  scheduleOptionalPluginCheck(ctx);
  // D 项：会话模型 effort 预检（缺 reasoningEfforts ⇒ 提前一行告警，不阻断）
  scheduleEffortPreflight(ctx);
  void loadSessionRuns(); // session→run memory for overlay auto-select
  ctx.commands.register({
    name: 'team',
    description: '组建一支角色化 AI 专家团协作交付（PM/架构/调研/前后端/审查/测试，共享工作区 + 阶段门控编排）',
    input: { hint: '[<task>|status|learn|resume <run>|clear [<run>]|members]', images: false },
    handler: (invocation) => executeTeamCommand(ctx, invocation),
  });

  // Live per-agent activity feed: record every tool result for subagent
  // sessions so the overlay can show「谁正在做什么」(Qoder-style right panel).
  if (ctx && typeof ctx.on === 'function') {
    try {
      ctx.on('tools/result', (exec, result) => {
        try {
          const sid = exec?.agent?.session?.header?.id || exec?.agent?.session?.id;
          if (!sid) return;
          pushActivity(ACTIVITY, sid, {
            ts: Date.now(),
            line: summarizeTool(exec),
            preview: (result?.isError
              ? '❌ ' + String(result?.error?.message || result?.error || '').slice(0, 60)
              : (result?.content?.[0]?.text || result?.content?.[0]?.type || '')).slice(0, 100),
          });
        } catch { /* event observation is best-effort */ }
      });
    } catch { /* tools/result unavailable — feed stays empty */ }

    // ── B2-1：把「台账契约」与「规格边界」两条散文规则搬到宿主的 `tools/post-execute` 瀑布上
    //    —— 违规**当场顶回**（工具结果变 isError + 模型可见反馈），而不是等 `/team check`
    //    事后报红、或等用户走查才发现。设计见 `docs/Qoder对标/07-B2-1真拦截设计稿.md`；
    //    判定逻辑全在 `lib/interception.js`（纯函数、零 command.js 依赖、可单测）。
    //    ⚠ 只拦**模型工具调用**：插件自身经 `ARTIFACT`（走 ctx.fs）的写入不经过这条瀑布，不会自锁。
    try {
      const boundary = createBoundaryInterceptor({
        readText: async (abs) => {
          try {
            const hostFs = typeof ctx.get === 'function' ? ctx.get('fs') : null;
            if (hostFs && typeof hostFs.readText === 'function' && typeof hostFs.resolve === 'function') {
              const resolvedTarget = await hostFs.resolve(abs);
              const viaHost = await hostFs.readText(resolvedTarget);
              if (typeof viaHost === 'string') return viaHost;
            }
          } catch { /* 宿主读不了就退到 node 读 */ }
          try { return await readFile(abs, 'utf8'); } catch { return null; }
        },
        validateTaskGraph,
        cwdFor: (exec) => cwdFromSession(ctx, exec?.agent?.session?.header?.id || exec?.agent?.session?.id),
        teamRootFor: (cwd) => teamRoot(cwd),
        phaseFor: async (runId, cwd) => {
          const st = await readJsonSafe(join(teamRoot(cwd), runId, 'STATE.json'));
          return String((st && st.phase) || '');
        },
        // 已交付/已终止的 run 放行：`post-execute` 的 block 不回滚写入，拦已冻结的历史工件
        // 只会让编辑者以为没改成（2026-09-13 实测撞到，见 lib/interception.js 的长注释）。
        statusFor: async (runId, cwd) => {
          const st = await readJsonSafe(join(teamRoot(cwd), runId, 'STATE.json'));
          return String((st && st.status) || '');
        },
        // 并发写留痕（设计稿 §十二 第 3 步）：写者身份 = 会话 id + 从 `STATE.members`
        //（格式就是 `<agentSessionId>:<role>`）解出的角色。**解不出角色就如实退到会话 id，不编造角色。**
        // 写者身份 = 会话 id + 角色。**角色解析与 R1 门禁共用 `roleOfAgent`**
        //（两处各写一遍口径迟早漂移：一处认得出、另一处认不出）。
        whoFor: async (exec, target) => {
          const sid = String(exec?.agent?.session?.id || exec?.agent?.session?.header?.id || '');
          if (!sid) return '';
          const role = await roleOfAgent(ctx, exec, target.runId);
          return role ? `${role}#${sid.slice(0, 6)}` : `session:${sid.slice(0, 6)}`;
        },
        writeTracer: WRITE_TRACER,
        onEvent: (type, payload) => {
          try {
            // 并发写：除了常规告警，额外打一行**人读得懂**的留痕（谁 → 谁、隔了多久）。
            if (type === 'concurrent-write') console.warn(`[expert-team] ${formatConflict(payload)}`);
            else console.warn(`[expert-team] ${type}`, JSON.stringify(payload));
          } catch { /* 观测失败不影响工具结果 */ }
        },
      });
      ctx.on('tools/post-execute', boundary);

      // ── R1 工件归属**硬门禁**（2026-09-15）：把"工件由产出它的角色自己落盘"从**协议约定**
      //    升级成**可执行的门禁**。挂在 `tools/pre-execute`（**写盘之前**）而不是 post：
      //    判据是"**创建放行、覆写才拦**"——只需一次存在性查询、不读内容，因此拦得住；
      //    而内容级的台账/边界校验依赖已落盘内容，继续留在上面的 post-execute，两者分工。
      //    语义、表格真源与诚实边界（只覆盖 write/edit 通道；持 bash 的角色仍可能绕过）
      //    全部写在 `lib/artifact-ownership.js` 的文件头，别在这里复制一份。
      try {
        const ownershipGate = createOwnershipGate({
          cwdFor: (exec) => cwdFromSession(ctx, exec?.agent?.session?.header?.id || exec?.agent?.session?.id),
          teamRootFor: (cwd) => teamRoot(cwd),
          statusFor: async (runId, cwd) => {
            const st = await readJsonSafe(join(teamRoot(cwd), runId, 'STATE.json'));
            return String((st && st.status) || '');
          },
          roleFor: (exec, runId) => roleOfAgent(ctx, exec, runId),
          existsFor: (abs) => pathExistsFor(ctx, abs),
          onEvent: (type, payload) => {
            try { console.warn(`[expert-team] ${type}`, JSON.stringify(payload)); } catch { /* 观测失败不影响工具 */ }
          },
        });
        ctx.on('tools/pre-execute', ownershipGate);
      } catch { /* 门禁挂不上 ⇒ 退回纯协议；绝不让它影响插件加载或工具调用 */ }

      // ── R1 绕过检测（2026-09-15）：**只报不拦**。R1 门禁只覆盖 write/edit；持 bash 的角色
      //    可以 `cat > SPEC.md` 绕过 —— 静默绕过违背本仓纪律，但静态判断 bash 写目标不可靠
      //    （重定向/变量/子命令），一旦误判就是把正常命令判成越权。⇒ 折中：**留痕**，用真实命中
      //    频率决定以后是否收紧。口径与"宁可漏报"的理由写在 `lib/artifact-redirect-watch.js` 文件头。
      try {
        const knownArtifacts = new Set([...ARTIFACT_TEMPLATES, ...Object.keys(ARTIFACT_OWNERS)]);
        const redirectWatch = createArtifactRedirectWatcher({
          knownArtifacts,
          cwdFor: (exec) => cwdFromSession(ctx, exec?.agent?.session?.header?.id || exec?.agent?.session?.id),
          teamRootFor: (cwd) => teamRoot(cwd),
          onEvent: (type, payload) => {
            try { console.warn('[expert-team] ' + type, JSON.stringify(payload)); } catch { /* 观测失败不影响工具 */ }
          },
        });
        ctx.on('tools/post-execute', redirectWatch);
      } catch { /* 观测器挂不上 ⇒ 只是少一条留痕；绝不影响插件加载或工具调用 */ }

      // ── C 线第 16 项（收窄版）：**振荡检测**。同工具重复调用由宿主
      //    `@deepseek-ai/dsh-repeat-tool-reminder` 负责（dsh-base 已启用，thresholds [3,5,8]），
      //    不重写；这里只补它明确声明不覆盖的那一种 —— A→B→A→B 在两方案间来回。
      //    刻意用 `block`（宿主那份是 advisory）：**完全相同的轮询可能合法，但振荡从来不是**。
      const loopGuard = createLoopGuard({
        // **函数入参**：本模块在构造时就把 enabled 解构成常量，只有传函数才能让设置改动即时生效
        // （传布尔值 ⇒ 改完设置要等下次加载，那是"看起来即时、其实不即时"的假象）。
        enabled: () => LOOP_GUARD_ENABLED,
        onEvent: (type, payload) => {
          try { console.warn(`[expert-team] ${type}`, JSON.stringify(payload)); } catch { /* 观测失败不影响工具结果 */ }
        },
      });
      ctx.on('tools/post-execute', loopGuard);

      // ── C 线第 17 项：**派工即回写**（状态与归属由代码写，不靠模型记得改）──
      //    挂在**事件**上而不是读接口里：`GET /state` 的写副作用刚被摘掉（B 线 10a），
      //    在读接口里顺手写 TASKS.json 会重演"3 秒轮询周期性改写用户工件 + 与 lead 并发写"。
      //    判定逻辑全在 `lib/dispatch-ledger.js`（纯函数 + 注入式 IO，可单测）。
      const dispatchLedger = createDispatchLedger({
        // 中文标签 → 角色 id：复用 host 这份 `ROLE_LABELS_ZH`，**不另造第三份表**
        //（第三份必然与另两份分叉 —— 本仓为此专门有 `vocab-consistency.test.mjs`）。
        roleOfLabel: (label) => {
          const m = String(label || '').match(/^【([^】]+)】/);
          return m ? (ROLE_LABELS_ZH.get(m[1].trim()) || '') : '';
        },
        runFor: async (exec) => {
          const sid = String((exec && exec.agent && exec.agent.session && (exec.agent.session.id || (exec.agent.session.header && exec.agent.session.header.id))) || '');
          const cwd = cwdFromSession(ctx, sid) || String((exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) || '');
          if (!cwd) return null;
          const mem = sessionRunFor(sid);
          // **只认本会话自己的 run**（与 `/team` 子命令的 `runArg` 同一套会话归属）：
          // 多会话并行时"工作区里最新的那个 run"往往是别人的，拿它记账等于改别人的台账。
          if (!mem || mem.workspace !== cwd) return null;
          return { cwd, runId: mem.runId };
        },
        readTasks: async (t) => readJsonSafe(join(teamRoot(t.cwd), t.runId, 'TASKS.json')),
        writeTasks: async (t, doc) => ARTIFACT.must(join(teamRoot(t.cwd), t.runId, 'TASKS.json'), JSON.stringify(doc, null, 2) + '\n'),
        onEvent: (type, payload) => {
          try { console.warn(`[expert-team] ${type}`, JSON.stringify(payload)); } catch { /* 观测失败不影响工具结果 */ }
        },
      });
      ctx.on('tools/post-execute', dispatchLedger);

      // ── A 线（token 成本治理 · 第 2 步）：**把执行类工具从 lead 手上拿走** ──
      //
      // 为什么：对真实会话做全量遥测审计（一次性脚本，未随包发布）——
      //   · lead 累积上下文的 **89%~98% 是工具结果**，`read`+`bash`+`edit` 约占 **93%**，
      //     而真实用户需求只占 2%~11%；输出 tokens 占总量的比例见 `./metrics/tokens.js`（**唯一权威**）。
      //   · 上下文首次越过 10 万 tokens 只发生在全程第 1%~2% 的步，而**越线之后**的步
      //     贡献了 **97%** 的总 prompt 成本 —— 贵在"带着大上下文反复走"。
      //   · 最贵的 run 里 **lead 占该 run prompt 总量的 84%**。
      //   ⇒ 杠杆不是"少说话"，是"执行不在它手上"（执行是角色子代理的活）。
      //
      // 为什么安全（三条独立印证）：施加目标是 **lead 自己的作用域**。角色子代理的父是
      //   **preset 常驻作用域**，不是 lead 的作用域 —— 宿主 `standingMountFor()` 就是
      //   `scopeParentOf(agentKey)` 找挂载，且文档写明 "the agent's own key is parented to
      //   its preset's standing key ... the mount is not under the agent's fiber"。
      //   ⇒ lead 的键**不在**子级祖先链上 ⇒ 收 lead 不波及角色。
      //   对照（已实测）：施加在**常驻层**才会波及所有角色 —— 所以绝不能改 preset 的顶层行。
      //   运行时探针：用宿主真函数分别跑「施加在常驻层」与「施加在 lead 自身作用域」各一遍。
      //
      // 为什么是这个时刻：`agent/created` 由宿主 `announce()` 在**创建时刻**发出；宿主自己对
      //   子代理也是在组合（setup）阶段调 `childCtx.tools.restrict(...)`（`dsh-subagent:554`）。
      //   即：**照抄宿主自己的时序**，不另造。
      ctx.on('agent/created', async ({ agent }) => {
        try {
          const agents = ctx.get('agents');
          // ① preset 必须是专家团（`composedPreset` 读活动作用域链，未写会话头也答得出）
          const presetId = ctx.get('agentPresets')?.composedPreset?.(agent.ctx);
          // ② 必须是根 agent。**这一条是安全闸门**：角色子代理与 lead 的 composedPreset
          //    **是同一个值**（都从同一 preset 组合而来），少了 ② 就会把角色的 bash 一起收掉。
          const isRoot = agents?.roots?.().includes(agent) === true;
          if (!shouldNarrowLeadToolFace({ presetId, isRoot }).apply) return;   // 无关 agent：静默返回，不是失败

          if (LEAD_TOOLFACE === 'off') {
            // 关掉时**出声一次**：否则"我明明关了"与"开关没生效"看起来一模一样（两种零纪律）。
            if (!LEAD_TOOLFACE_OFF_LOGGED) {
              LEAD_TOOLFACE_OFF_LOGGED = true;
              console.log(`[expert-team] lead 工具面收窄已关闭（${LEAD_TOOLFACE_ENV}=off 或设置 gates.leadToolFace=off）⇒ lead 保留全部工具`);
            }
            return;
          }

          // ③ **必须取 agent 作用域**的名字清单：`view()` 不传 scope = 全局视图，而模型可见工具
          //    在 0.1.5 起由 preset 注册在 agent 平面 ⇒ 全局视图非空但缺那几个名字，收窄会静默失效
          //    且给出"宿主里没有这些工具"的错误结论（拿真机日志换来的教训，详见 lead-toolface.js）。
          const { knownNames, reason } = await agentScopedToolNames({ agentCtx: agent.ctx });
          const plan = planLeadToolFace({ platform: process.platform, knownNames });
          if (!plan.effective) {
            // **两种零都要出声**：`no-known-names`（我不知道宿主有什么）与
            // `nothing-to-deny`（宿主确实没有这些）不是同一件事，不能长成同一个样子。
            // 但同一状态**只喊一次**：每个会话都刷会把 warn 变成噪声，而噪声会让所有告警一起被降权。
            warnLeadToolFaceOnce(plan.status, `${plan.notes.join(' ')}（清单来源：${reason}）`);
            return;
          }
          // 成功不打印：每个会话都刷一行会把 warn 变成噪声（本仓纪律：warn 必须保持可见）。
          // 回退句柄挂在 agent 作用域上，agent 销毁时随作用域一起失效，无需手工回收。
          agent.ctx.tools.restrict({ deny: plan.deny });
        } catch (e) {
          // 施加失败**绝不影响会话**：拿不到就退化为"维持原工具面"（本仓既定降级口径）。
          console.warn(`[expert-team] lead 工具面施加失败（维持原工具面）：${String((e && e.message) || e)}`);
        }
      });
    } catch { /* 装配失败绝不能影响插件加载：退化为「无写侧门禁」，读侧门禁仍在 */ }
  }

  // ── Host state route for the live canvas (md-preview-style host HTTP endpoint,
  //    NOT a typert Remote). Guarded so an absent webServer (or any plumbing
  //    issue) never breaks bundle load or the /team command surface.
  if (ctx && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (wctx) => {
        wctx.effect(() => {
          /**
           * 注册一条**只服务本机同源**的路由。
           *
           * 为什么要有这层包装：这 11 条路由以前各自决定要不要校验来源，实际结果是**一条都没校验**
           * （只校验了 HTTP 方法）。把守卫放在唯一的注册入口上，"新加一条路由"就不可能忘记加固 ——
           * routes-shared.test.mjs 里还有一条棘轮盯着这里不许再出现裸的 register。
           *
           * methods 走行内字段：它决定守卫对哪些方法做 Origin / content-type 校验，且**不会**被传给
           * 宿主（宿主只认 kind/path/handler，多传字段可能被 schema 拒）。
           */
          const registerLocal = (row = {}) => {
            const { methods = ['GET'], ...rest } = row;
            return wctx.webServer.register({ ...rest, handler: localOnly(rest.handler, { methods }) });
          };
          const dispose = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/state',
            methods: ['GET'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
                // 每请求复位"子会话日志读取"预算（见 roleFromChildLog 的注释）。
                resetRoleReadBudget();
                // 分步计时：只有显式打开才收集，平时零成本（不打印、不进响应）。
                // 用途：装上新版后**由人**核对"哪一步还贵"，而不是靠猜——验收需要可复现数字。
                const STATE_PROFILE_ON = String((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_STATE_PROFILE) || '') === '1';
                const prof = STATE_PROFILE_ON ? { at: Date.now(), steps: {} } : null;
                const mark = (name) => { if (prof) { const n = Date.now(); prof.steps[name] = n - prof.at; prof.at = n; } };
                const url = new URL(req.url ?? '/plugins/dsh-expert-team/state', 'http://127.0.0.1');
                const sid = (url.searchParams.get('sessionId') ?? '').trim();
                // cwd is OPTIONAL: if absent (e.g. overlay has no session id), fall
                // back to all registered workspaces. This makes the overlay work
                // regardless of whether the client resolves a session.
                const cwd = (url.searchParams.get('cwd') ?? '').trim() || cwdFromSession(ctx, sid);
                const runParam = (url.searchParams.get('run') ?? '').trim();
                const wsParam = (url.searchParams.get('workspace') ?? '').trim();
                if (/[\\/]/.test(runParam)) { json(400, { ok: false, error: 'bad params' }); return; }
                // ── 渐进式状态（2026-09-15 性能修复 #3）────────────────────────────
                // 为什么：完整负载的成本随「本会话子代理数 × 日志体量」线性增长，而活跃写入会不断把
                // 目录戳 `(mtime,size)` 打失效（真机实测：小会话 311 ms；20+ 子代理的重会话 2.1–6.2 s）。
                // 可出现实需要"首屏就能看见"的只有**阶段/进度/计数**（便宜），"人/料/事件流"可以晚一拍、
                // 低频拉。于是给同一个端点加 `?section=`：
                //   `summary`（便宜基线，首屏用）｜`people`（成员/角色/时间线，最贵）｜
                //   `feed`（每 agent 最近事件）｜`artifacts`（RUN.log 尾 + 工作区改动文件）
                // 兼容性第一：**不传 section（或 section=all）= 完整负载与字段语义完全不变**，
                // 所以老客户端、既有测试、脚本一律不受影响；`sections`/`degraded` 都是**新增**字段。
                // 纪律：截断**必须**上报（不许静默丢，也不许把"截断"伪装成"就这么多"）。
                const secRaw = String(url.searchParams.get('section') ?? '');
                const secRequested = secRaw.trim() !== '';
                const secParsed = parseStateSections(secRaw);
                // 非法段名 ⇒ **明确拒绝**，不再静默回落到 summary。位置在**任何 await 之前**：
                // 拒绝路径零成本，也不必先解析 workspace/run 就能给出结论。
                // 只约束"显式传了 section"的请求 —— 不传或 `all` 仍然完全兼容（那时 invalid 恒为空）。
                if (secParsed.invalid.length) {
                  json(400, {
                    ok: false,
                    error: `未知分节：${secParsed.invalid.join(', ')}（合法分节：${secParsed.valid.join(', ')}；不传该参数表示全部）`,
                    invalid: secParsed.invalid,
                    valid: secParsed.valid,
                  });
                  return;
                }
                const want = secParsed.want;
                const included = secParsed.included;
                // 硬上限：角色解析最贵（每条子会话一次全量日志读），超限只解析前 N 条。
                // "超出上限"如实进 `scopeCaps`（**按设计的能力上限，不是故障**；见下面的 cutFacts/capFacts）。
                const MAX_ROLE_SUBS = Math.max(1, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_MAX_ROLE_SUBS) || 0) || 60);
                // people 分节的软期限：超时后跳过更贵的可选增强（workflow 元数据），同样如实标注。
                const PEOPLE_DEADLINE_MS = Math.max(200, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_PEOPLE_DEADLINE_MS) || 0) || 2500);
                // artifacts 分节的软期限：它要读 RUN.log 尾、还要跑 git（liveFiles）——后者在大工作区
                // 里是最不可控的一段。超过就从**请求开始**算起跳过，并**如实进 degraded**（缺块 ≠ 空数据：
                // 跳过时键不存在，客户端据 degraded 知道"不是没有，是没来得及"）。
                const ARTIFACTS_DEADLINE_MS = Math.max(200, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_ARTIFACTS_DEADLINE_MS) || 0) || 2500);
                // feed 分节的硬上限：每 agent 只嵌最近 12 条事件，但 agent 数本身要封顶（重会话里
                // subs 可能几十上百条）。超出的条数**如实进 `scopeCaps`**（按设计的上限，不是故障）；
                // 只有**软期限截断**才算真故障进 `degraded`。
                const MAX_FEED_AGENTS = Math.max(1, Number((typeof process !== 'undefined' && process.env && process.env.DSH_EXPERT_TEAM_MAX_FEED_AGENTS) || 0) || 60);
                const peopleStartedAt = Date.now();
                // 「本轮缺了什么」先收集**事实**，最后交给纯函数 `classifyStateShortfall` 分两个承载位
                // （1.3.22；判据与理由见该函数）：
                //   · `cutFacts` = 真故障（软期限截断 / 读失败）⇒ 进 `degraded`（告警）；
                //   · `capFacts` = 按设计的能力上限（`MAX_ROLE_SUBS` / `MAX_FEED_AGENTS`）⇒ 进
                //     `scopeCaps`（数字照发，**不是**故障）。
                // 为什么必须分：真机 95 个 agent 时 `roles:35,feed:35` **每轮都出现** ⇒ 降级标记长期
                // 常亮，真正的截断/读失败被这盏永久灯一起降权（常亮的告警等于没有告警）。
                // ⚠️ 拆的是**承载位**，不是信息：上限数字一个不少（`over`/`limit`/`total`）。
                const cutFacts = [];
                const capFacts = [];
                // `warming`（2026-09-16）与 `degraded` **是两件事**，不许混用：
                //   · `degraded` = 本轮**真的少算了东西**（软期限截断 / 读失败）⇒ 报警；
                //   · `warming`  = 本轮**把这次重读挪到了后台**（单飞预热在飞）⇒ 数据是上一份完整
                //     快照或暂时缺席，**不是**失败。它出现的时长 = 那次后台读的时长（毫秒~秒级），
                //     不是整个 TTL 周期 —— 判据是"真的有刷新在飞"，否则会变成常亮噪声。
                // 优先级：真截断仍进 `degraded`；同一分段两者同时成立时以 `degraded` 为准。
                const warming = [];
                const reg = (await registeredWorkspaces()).filter(Boolean);
                const workspaces = [...new Set([...(cwd ? [cwd] : []), ...reg])];
                if (!workspaces.length) { json(200, { ok: false, runs: [], runsAvailable: 0, error: 'no workspace registered — 请先在某项目里运行一次 /team <task>' }); return; }
                let runs = [];
                for (const ws of workspaces) runs = runs.concat(await listRunsInWorkspace(ws));
                // Select a run: explicit workspace+run, else auto-select the CURRENT
                // workspace's run (so switching workspace auto-switches the overlay).
                // NO blind global fallback: a session that never opened a team must
                // not be served another workspace's run — show an empty state with a
                // run selector instead (user chooses deliberately).
                let sel = null;
                if (runParam && wsParam) {
                  sel = await snapshotRun(wsParam, runParam);
                  // 只在**该会话真实存在**、且**它的 cwd 就是该 run 所在工作区**时才记忆
                  // （假 id 不得落盘，见 sessionExists；跨工作区的"查看"不得改写归属）。
                  if (sel && sessionExists(ctx, sid) && sessionOwnsWorkspace(ctx, sid, wsParam)) rememberSessionRun(sid, wsParam, runParam, 'view'); // user deliberately picked a run
                } else if (runParam && workspaces.length === 1) {
                  sel = await snapshotRun(workspaces[0], runParam);
                } else {
                  const inCwd = runs.filter((r) => r.workspace === cwd);
                  // THIS session's own run wins (created/last viewed); then the
                  // workspace's newest by updatedAt.
                  const mem = sessionRunFor(sid);
                  if (mem && mem.workspace === cwd) {
                    const hit = inCwd.find((r) => r.runId === mem.runId);
                    if (hit) sel = await snapshotRun(hit.workspace, hit.runId);
                  }
                  if (!sel) {
                    const nr = newestRun(inCwd.length ? inCwd : (cwd ? [] : runs));
                    if (nr) sel = await snapshotRun(nr.workspace, nr.runId);
                  }
                }
                mark('runs+select');
                if (!runs.length) { json(200, { ok: false, runs, workspaces, runsAvailable: 0, error: '还没有专家团 run。先运行 /team <task> 开一个。' }); return; }
                if (!sel) {
                  // current workspace has no team run (but other workspaces do)
                  json(200, { ok: false, runs, workspaces, cwd, runsAvailable: runs.length, error: cwd ? `当前工作区还没有专家团 run——用 /team <task> 组队；其他工作区有 ${runs.length} 个 run，可在上方选择器切换。` : 'run not found' });
                  return;
                }
                // Enrich the roster with LIVE subagent status so the overlay can show
                // how many agents are dispatched + what each is doing (not just "—").
                // ⚠️「人」属于 run 的**归属会话**，不是发起请求的会话。在会话 A 里选看会话 B 的
                // run 时，用请求的 sid 会把 A 的子代理当成 B 的人（实测：在 dsh 会话里看
                // php/jiu 的 run，返回 30 个 dsh 子代理，而 jiu 自己只有 6 个）。
                // 归属两源：① run 自带的 ownerSession → ② session-runs 里 via='create' 的记录。
                // **没有第③源**（"该 run 最早一条记录"的兜底已删除）—— 实测纯 `view` 记录
                // 会造出假归属，空归属远好过错归属；解析不出就如实留空 + ownerResolved=false。
                const owner = sel.stateOwnerSession
                  ? { sid: sel.stateOwnerSession, ownerResolved: true }
                  : runOwnerSession(sel.runId);
                let peopleSid = owner.sid || sid;
                // ⚠️ **只能用 id**（`memberAgentIds`，不是 `byRole` 的 values 视图）：后者混着角色名，
                // 会让"还有谁查不到"永久非空 ⇒ 每请求重枚举 475 个 artifact（2026-09-15 真机定位）。
                const knownIds = memberAgentIds(sel.stateMembers);
                // 只有 people 分节才解析人员：这一步要枚举子会话 durable 清单（重会话里这是整条链上
                // 最大的一块）。首屏用 summary 时不付这个成本 —— `agents` 返回空数组，
                // 由客户端 `sections` 字段知道自己拿的是"摘要"，UI 如实显示"正在加载成员"。
                // `feed` 也必须先有 subs（它按子会话遍历活动缓存）。若只想要 feed 却跳过枚举，
                // feed 会**静默变空** —— 那正是本仓最忌讳的"两种零分不清"（缺块 ≠ 空数据）。
                const needSubs = want('people') || want('feed');
                // 有界化：本轮是否允许枚举（节流窗口）+ 枚举期限；结果经 SUB_HEADER_STATS.cut 上报。
                const subsStartedAt = Date.now();
                const allowEnumNow = subsEnumAllowed(subsStartedAt);
                SUB_HEADER_STATS.cut = '';
                // ⚠️ `notReady` 的复位归**这里**（每请求一次），不再由 `listSubagentStatusBySession`
                // 在每次调用开头复位 —— 同一个请求里它会因为"退路"被调两次，第二次（`root` 常为空）
                // 会把第一次算出的事实抹掉（2026-09-16 临时实例实测）。
                SUB_HEADER_STATS.notReady = false;
                SUB_HEADER_STATS.notReadySince = 0;
                const subsOpts = { allowEnum: allowEnumNow, enumDeadlineAt: subsStartedAt + SUBS_ENUM_DEADLINE_MS };
                let subs = needSubs ? await listSubagentStatusBySession(ctx, peopleSid, knownIds, subsOpts) : [];
                // 归属会话拿不到人时退回请求会话（否则面板整块空掉），但**如实标注**这不是归属会话的人。
                if (needSubs && !subs.length && peopleSid !== sid) {
                  const fallback = await listSubagentStatusBySession(ctx, sid, knownIds, subsOpts);
                  if (fallback.length) { subs = fallback; peopleSid = sid; }
                }
                // 有界化上报：本轮流过枚举 ⇒ 进入节流窗口；被节流/被期限截断一律**如实**进 degraded
                // （缺块 ≠ 空数据：被挡住的 id 只是没有 header，成员本身不丢）。
                if (needSubs && allowEnumNow) SUBS_ENUM_LAST_AT = Date.now();
                // ⚠️ 噪声纪律：**节流不是失败**，不能每轮都进 `degraded`（节流窗口内每次轮询都会命中
                // ⇒ 面板会长期挂一个降级标记，把真告警一起降权）。"某些成员细节不可得"这一事实由
                // `subsPending` 诚实表达（与 `rolesPending` 对称）；只有"开始枚举却被期限截断"算
                // **部分结果**，才进 `degraded`。
                const idsReal = (Array.isArray(knownIds) ? knownIds : []).filter(isAgentIdLike);
                const subsPending = needSubs ? idsReal.filter((id) => !subs.some((r) => r.id === id)).length : 0;
                if (needSubs && SUB_HEADER_STATS.cut === 'deadline') cutFacts.push('subs:deadline');
                // ⚠️ "还没就绪的空" vs "真的没有成员"（2026-09-16）：两者过去在响应里**长得一模一样**
                // —— 真机重启后首轮 `agents=[] / subsPending=13` 且**没有任何标记**，几分钟后才自愈。
                // 现在如实挂 `warming:['subs']`（沿用既有语义）：这一轮的人员明细**还没就绪**，
                // 不是"这个团队没有人"。它**不进** `degraded`（不是故障），也**不粘住**（服务端限时，
                // 客户端按缺席即清，见 mergeStatePayload）。
                // ⚠️ 退路那一轮如果真拿到了行 ⇒ 这一发**不该**再说"还没就绪"（面板并不空）。
                // 这是"多调用合成一个事实"时唯一会出现的假阳性方向，必须显式挡掉。
                if (needSubs && SUB_HEADER_STATS.notReady && subs.length
                    && subs.some((r) => idsReal.includes(r.id))) {
                  SUB_HEADER_STATS.notReady = false;
                }
                if (needSubs && SUB_HEADER_STATS.notReady) warming.push('subs');
                // 供面板如实提示：resolve=false 时人员名单可能来自错误的会话
                sel.peopleSession = peopleSid;
                sel.peopleSessionIsOwner = peopleSid === (owner.sid || '');
                sel.peopleSessionResolved = !!owner.sid && owner.ownerResolved;
                // 只在**有确凿理由**时才提示，避免对自己 run 的误报：
                //   ① 归属是历史推断的（owner 存在但没标 create）
                //   ② 找到了归属会话却拿不到人，只能退回当前会话
                //   ③ 根本没有可核实的归属会话（owner.sid === ''），人员取自请求会话
                let peopleNote = '';
                if (owner.sid && !owner.ownerResolved) peopleNote = '该 run 未记录归属会话，人员是按会话历史推断的（可能不准）';
                if (owner.sid && owner.sid !== peopleSid) peopleNote = '该 run 的归属会话里没有子代理，人员已退回当前会话（可能不是这个 run 的人）';
                // ③ 无归属（`owner.sid === ''`）：人员被 `|| sid` 静默替换成**请求会话**的人 ——
                //    必须与 ①② 一样如实披露，否则"别的工作区的人"会被当成这个 run 的人且无任何提示
                //    （删掉旧兜底后 ①② 恒不成立，这一条是唯一的披露出口）。
                if (!owner.sid) peopleNote = '该 run 没有可核实的归属会话，人员取自当前会话（可能不是这个 run 的人）';
                sel.peopleSessionNote = peopleNote;
                // workflow-spawned children carry an EMPTY descriptor label, so a
                // label-only match leaves the whole roster at "未启动" while agents
                // run. Two recovery sources, cheapest first:
                //   ① wfLabels — the workflow delegation labels in THIS session's own
                //      log (covers interrupted fan-outs, which have no chat card); then
                //   ② the child's own role prompt (roleFromChildLog).
                mark('subs');
                // ⚠️ 这里**不许** `await workflowEventIndex`（即旧的 `workflowChildLabels`）：
                // 那是"全量读一遍多 MB 父会话日志"，而它此前的 TTL 一到点就由**这一个请求**付满
                // （同机实测 803–2683 ms，真机 1.3.20 窗口重开一发 1.196 s）。现在只读内存备忘，
                // 重读交给后台单飞预热；备忘过期时**先返回上一份完整快照**并如实标 `warming`。
                const wfErrBefore = WF_EVENT_STATS.readErrors;
                const wfIdx = want('people')
                  ? await workflowEventIndexForRequest(ctx, peopleSid)
                  : { labels: {}, runs: [], state: 'fresh', refreshing: false, at: 0, ageMs: 0 };
                const wfLabels = want('people') ? wfIdx.labels : {};
                // ⚠️ 这里刻意**只**在"根本没有快照"时标 warming，而不是"备忘过期"：
                //   · `missing`（没有快照）⇒ 本轮确实**没有** workflow 元数据 ⇒ warming（如实）；
                //   · `stale`（有旧快照、正在后台刷新）⇒ 给出去的是**上一份完整快照**，数据不残缺，
                //     只是可能旧了 ⇒ 不标 warming（否则 30 s TTL 配 6 s 轮询会让它常亮，变成噪声），
                //     陈旧程度由随负载下发的 `wfIndex.ageMs` **明示**给调用方，客户端按秒展示。
                //   "数据其实完整时不许标 warming" 与 "数据缺席时必须标 warming" 两条同时成立。
                if (want('people') && wfIdx.state === 'missing') warming.push('wf');
                // ⚠️ 读**失败**（IO 错）与"还没有快照"不是一回事：前者是**真故障**（进 degraded），
                // 后者只是 warming。旧实现把两者都归成 warming ⇒ 一次真实的读失败会被显示成
                // "后台刷新中"，也就是**把故障伪装成正常**（本仓最忌讳的那种骗人）。
                if (want('people') && WF_EVENT_STATS.readErrors > wfErrBefore) cutFacts.push('wf:read-error');
                mark('wfLabels');
                // 角色解析是全链最贵的一段（每条子会话一次全量日志读）。两道闸：
                //   ① 只在 people 分节里做；② 硬上限 `MAX_ROLE_SUBS`（超限只解析前 N 条）。
                // ⚠️ 被上限挡住的条数进 **`scopeCaps`（按设计的能力上限），不进 `degraded`**
                // （1.3.22 起；真机 95 agent / 上限 60 时若进 degraded，降级标记会每轮常亮，
                // 把真告警一起降权 —— "常亮的告警等于没有告警"）。"还没解析"（`rolesPending`，
                // 队列长度）与"解析不出来"（`unresolved`）仍然分得开（两种零可区分）。
                // 有界化（2026-09-16 加强）：**请求路径一条日志都不读**。便宜来源 + 缓存照常做，
                // 真正读日志挪到后台单飞批（`warmSubRoles`）。旧实现是"窗口一到点就在请求里读
                // ≤ROLES_READ_PER_BURST 条、并给 600 ms 期限"，但期限只在**两次读之间**检查，
                // 拦不住正在进行的那一次读（实测单条 179–2023 ms）—— 那正是窗口重开的秒级尖峰。
                const rolesWarmGo = rolesWarmAllowed(Date.now());
                ROLE_READ_STATS.cut = '';
                if (want('people')) {
                  // ① 便宜来源（自带 label / wfLabels）与已缓存结果；`maxReads: 0` ⇒ 零日志读。
                  //    ⚠️ `queueCap: MAX_ROLE_SUBS`：队列（= `rolesPending`）**只收可解析的前 N 条**。
                  //    旧实现用**全量** subs 重建队列 ⇒ 超出上限的那批永不被读、却永远躺在队列里
                  //    ⇒ `rolesPending` 排空后**永久停在 35**（真机 95−60），且 `roleWarmHasWork()`
                  //    恒为真 ⇒ `warming:['roles']` 变成**常亮** + 每轮踢一个"注定读 0 条"的批。
                  await resolveSubRoles(ctx, subs, wfLabels, { maxReads: 0, queueCap: MAX_ROLE_SUBS });
                  if (subs.length > MAX_ROLE_SUBS) capFacts.push({ key: 'roles', total: subs.length, limit: MAX_ROLE_SUBS });
                  // ② 该读了 ⇒ 交给后台（单飞）。踢不出去（已有后台批在跑 / 队列空 / 队列里
                  //    全是已缓存的 id）就不标 warming —— 本仓纪律是 `warming` = "**真有刷新在飞**"。
                  // ⚠️ 交给后台的是 **`subs.slice(0, MAX_ROLE_SUBS)`**（与旧请求路径同一口径）：
                  // `resolveSubRoles` 内部会按 `queueCap` **重建队列**，传全量就会把超出上限的 id
                  // 也排进队列 —— 那样它们**迟早会被解析**，而 `scopeCaps.roles.over`
                  // （= 超出上限的条数）就成了一句假话。
                  // 便宜来源（wfLabels/缓存）的遍历仍在**全量** subs 上做（免费，纯为显示），
                  // 所以"超出上限"只意味着"不做日志解析"，不意味着"角色一律不显示"。
                  // ⚠️ 传的是**时长** `deadlineMs`，不是绝对时刻 —— 期限必须从批**开跑**那一刻
                  // 起算，否则 1000 ms 的延迟会吃掉 600 ms 的期限（1.3.22 的"零读"回归）。
                  // ⚠️ 读几条**不再**沿用请求路径的 `roleReadAllowance`（=1 条 / 30 s；真机实测的
                  // "30.4 s 才解析 1 个"就是它）：后台批用自己的预算 + 条数上限 + 分块让出。
                  const kicked = rolesWarmGo
                    ? warmSubRoles(ctx, subs.slice(0, MAX_ROLE_SUBS), wfLabels, { maxReads: ROLES_WARM_MAX_READS, deadlineMs: ROLES_WARM_BUDGET_MS, queueCap: MAX_ROLE_SUBS })
                    : null;
                  if (kicked) warming.push('roles');
                  // ③ **后台批有活却没读成** = 真故障（`ROLE_WARM_STATS.noProgress`，见该常量注释）。
                  //    与"按设计上限"分开承载：它进 `degraded`，上限进 `scopeCaps`。
                  //    队列里已无未缓存 id 时**不再报**（说明进度已到位）⇒ 恢复后这盏灯自己灭。
                  if (ROLE_WARM_STATS.noProgress && roleWarmHasWork()) cutFacts.push('roles:no-progress');
                }
                mark('roles');
                // R12 + R13 + R17（F-1 · P0 跨 run 成员串号）：**显示与写盘都只吃过滤后的 `subById`**。
                // R13 裁决：只严写盘的话，数据污染修好了但用户看到的串号现象一点没变 —— 面板照样把
                // 别的 run 的 8 个活人显示成本 run 成员，而 membersUnresolved 当前 client.js 并不渲染，
                // 等于"如实标注"标在了没人看的地方。
                // R17（QA 的 SG-B / F1l）：**先按 run 作用域过滤候选、再做角色归一映射**。
                // 旧顺序「先 mapRoleToSub、后过滤」有两个致命点叠加：mapRoleToSub 同角色**先到先占**
                // （`if (!m.has(role))`），而过滤**只删不补** ⇒ 当会话索引里**外 run 的同角色腿排在
                // 前面**时，本 run 自己的腿根本没进入待过滤映射，永远注册不上（实测 `members=[]`、
                // `pm.active=false`）—— 而那正是真实事故的 subs 顺序（旧 run 的 8 条腿在前）。
                // 过滤后的候选按**创建时间升序** ⇒ 随后的"先到先占"即"同角色取创建更早者"。
                // 精确路径（STATE.members 非空 ⇒ 里面的 id 本来就是本 run 登记过的）不进过滤，
                // 二次轮询不会丢已登记成员。
                let subById = new Map();
                if (want('people')) try {
                  if (membersFromState(sel.stateMembers).byRole.size) {
                    subById = buildRoleSubMap(subs, sel.stateMembers, wfLabels); // 已登记：不过滤、不丢
                  } else {
                    // 只查表、不读日志（热点 D 修复）：见 subHeaderIndex 的注释。
                    const timingOfSubs = subHeaderIndex(ctx, subs, wfLabels);
                    const scoped = filterRunScopedSubs(subs, {
                      wfLabels,
                      runId: sel.runId,
                      // ⚠️ 必须是**解析出来的归属** `owner.sid`，不能是 `peopleSid`：
                      // peopleSid = owner.sid || sid，owner 解析失败时会退成**请求会话**，
                      // 于是第②道拿"请求者"去比 parentId ⇒ 在别的会话里看这个 run 时
                      // 恒不成立、members 静默为空（空归属远好过错归属）。
                      ownerSession: sel.stateOwnerSession || owner.sid,
                      runCreatedAt: await runCreatedAtMs(join(sel.workspace, 'team', sel.runId)),
                      timingOf: timingOfSubs,
                    });
                    subById = mapRoleToSub(scoped.list, wfLabels); // R17：过滤**之后**才做角色归一映射
                    // 一道过滤都没过 ⇒ 宁可空 members 也不串号；如实告诉面板「没解析出归属」。
                    if (scoped.rejected > 0) sel.membersUnresolved = true;
                  }
                } catch { subById = new Map(); sel.membersUnresolved = true; /* 过滤自身出错 ⇒ 一律不登记 */ }
                // ⚠️ 登记块只在 people 分节里跑：summary 时 subs 为空 ⇒ deriveMemberEntries 会算出
                // "清空成员"并覆写 STATE.json（轮询触发的写）。跳过它同时避免"GET 改写 run 工件"。
                // 派工即登记（C3）：把 role→真实 agentId 落盘到 STATE.members（**由运行时回写**）。
                // SKILL §7.16① 要求这件事（lead 只读核对；STATE.json 的唯一写者是运行时），此前代码从没有写路径 ⇒ 实测所有 run 的 stateMembers 恒空。
                // host 本就算出了 subById，直接登记：① 归属从"猜"变"精确"；② 并行 run 不再串号。
                // **只在变化时写**（3s 轮询下否则会持续改写工件），且 best-effort 不影响读。
                //
                // ⚠️ 2026-09-16：**读可以拿不完整数据，写不行**。上面把 wf 索引改成了"先给上一份快照/
                // 或没有 + warming"，而 `wfLabels` 正是 `filterRunScopedSubs` 判定"哪些子代理属于本 run"
                // 的依据之一（R12/R17 那条串号事故链）。**精确路径**（`STATE.members` 已有角色映射）不吃
                // wfLabels，照常落盘；**退路**（本 run 还没登记过成员）若在索引不新鲜时落盘，就可能把
                // "归属还证明不了"的候选写进 STATE.members —— 那正是 R12 要防的污染，且**一旦落盘就留下**。
                // 所以退路分支在 wf 索引不是 fresh 时**跳过本次登记**（下一轮索引就绪后再登），
                // 并如实记一条 warming（缺的是"这次没登记"，不是"登记失败"）。
                const membersPrecise = membersFromState(sel.stateMembers).byRole.size > 0;
                const wfReadyForWrite = wfIdx.state === 'fresh' && !wfIdx.refreshing;
                if (want('people') && !membersPrecise && !wfReadyForWrite) warming.push('members:write-skipped');
                if (want('people') && (membersPrecise || wfReadyForWrite)) try {
                  const derived = deriveMemberEntries(subById, sel.stateMembers);
                  if (derived.changed) {
                    const stPath = join(sel.workspace, 'team', sel.runId, 'STATE.json');
                    const st = await readJsonSafe(stPath);
                    if (st) {
                      st.members = derived.entries;
                      st.updatedAt = new Date().toISOString();
                      // schema 告警不用在这里手动上报：ARTIFACT 的 onEvent 已经接到 writerEvents → pushActivityEvent
                      await ARTIFACT.must(stPath, st);
                      sel.stateMembers = derived.entries;
                    }
                  }
                } catch { /* best-effort：登记失败不影响读取 */ }
                // 「任务为什么会中断」的诚实答案：一次 fan-out 若从未写 run-end，其编排
                // 工具调用就没有返回（回合被打断/进程退出），成员会永远停在「进行中」。
                // 这里把每次扇出的命运一并交给面板显示。
                // ⚠️ workflow 元数据两段（见下）只在 people 分节、且**未超软期限**时才算：
                // 它们要遍历该会话的 workflow 事件（重会话里是大头之一），而首屏并不需要。
                // 超期限 ⇒ 跳过并如实进 `degraded`（不静默、也不假装算过）。
                const peopleWithinDeadline = want('people') && (Date.now() - peopleStartedAt < PEOPLE_DEADLINE_MS);
                if (want('people') && !peopleWithinDeadline) cutFacts.push('wf:deadline');
                if (peopleWithinDeadline) sel.wfRuns = await workflowRuns(ctx, peopleSid, subs, wfIdx);
                // 全景图的分层依据：workflow 派生的子代理**没有会话 header**（`createdAt` 全 0，
                // 这正是流转图退化成「无创建时间记录，无法分批」的根因）；它们唯一可辩护的
                // 时间来自 `tool-workflow/agent-start` 事件本身。同时给出逐子代理的结算态，
                // 让画布能把"被中断、从未结算"的节点画成红色，而不是永远转圈。
                if (peopleWithinDeadline) sel.wfChildren = await workflowChildMeta(ctx, peopleSid, wfIdx);
                // R13（lead 裁决 notes②）：**显示**也走同一份 run 作用域过滤结果 `subById`。
                // R12 只严了写盘，面板在 members 为空时仍会把别的 run 的活人显示成本 run 成员
                // ⇒ 数据污染修好了，但**用户看到的串号现象一点没变**（而 membersUnresolved
                // 当前 client.js 并不渲染，等于"如实标注"标在了没人看的地方）。
                // 归属不上的活人 ⇒ 该角色显示为**未启动**（active:false），并保留 membersUnresolved。
                // 精确路径（STATE.members 非空）不进过滤 ⇒ subById 直接来自 buildRoleSubMap，
                // 已登记成员的显示不丢（R12 第 4 点）。
                // ⚠️ 只在 people 分节里 enrich：summary 时 `subById` 是空 Map，enrich 会把**每个成员**
                // 都标成"未启动"（把名册信息也一起糊掉）。summary 保留 snapshotRun 给的名册视图，
                // 活跃态缺失就如实缺失（由客户端按 `sections` 显示"正在加载成员"）。
                if (want('people')) sel.members = enrichMembers(sel.runId, sel.roles, sel.members, subById, sel.agents);
                // cost/model plan: expose each role's planned model so the overlay
                // shows the scheme even before dispatch (live model wins once running).
                mark('people-enrich');
                const modelPlan = sel.models || modelPlanFor(sel.roles || []);
                for (const role of Object.keys(sel.members)) {
                  const m = sel.members[role];
                  if (m && typeof m === 'object') {
                    const p = modelPlan[role];
                    m.planModel = p && p.model ? p.model : '';
                  }
                }
                // 时间维度（任何"分批/波次"视图都需要）：createdAt 取自子会话 header，
                // lastEventAt 复用下面已收集的 per-agent feed 最后一条事件时间（零额外开销）。
                // 走 subHeaderIndex（**只查表**）：已结束的子代理会被从活存储里清掉，但它们的
                // durable header 字段由 listSubagentStatusBySession 的 listSessions() 分支
                // **顺带**带出来了（createdAt/parentId/depth），所以不需要再读一次日志。
                // 2026-09-15：此前这里对每个子会话 await childSessionTiming（会全量 readSession），
                // 是 /state 冷态 283.6 s 的根因。不臆造：三源都拿不到就保持 0，UI 如实降级。
                const timingIdx = subHeaderIndex(ctx, subs, wfLabels);
                const timingOf = {};
                for (const s of subs) timingOf[String(s.id || '')] = timingIdx.get(String(s.id || '')) || { createdAt: 0, parentId: '', depth: 0 };
                // summary 分节返回**空数组**（不是"没有成员"）：客户端据 `sections` 区分
                // "摘要里本来就没有这一块"与"真的一个成员都没有"（两种零可区分）。
                sel.agents = want('people') ? subs.map((s) => {
                  const sid2 = String(s.id || '');
                  const t = timingOf[sid2] || { createdAt: 0, parentId: '', depth: 0 };
                  // 列表阶段（listSessions 分支）已经带出 header 字段时优先用它，省一次读
                  const createdAt = Number(s.createdAt) || t.createdAt || 0;
                  const parentId = String(s.parentId || t.parentId || '');
                  const depth = Number(s.depth) || t.depth || 0;
                  return {
                    id: s.id, activity: s.activity || '', mode: s.mode || '', model: s.model || '',
                    role: roleOfSub(s) || '', createdAt, parentId, depth,
                    // UI 用它区分"0 = 无时间"与"真的是 0"；缺字段时客户端也可用 createdAt>0 兜底
                    hasTimestamp: createdAt > 0
                  };
                }) : [];
                // 实时兜底视图：`TASKS.json` 为空但确有子代理在跑时（典型：lead 用 `workflow`
                // 扇出却没按协议回写任务），把活子代理投影成只读"实时任务"，免得面板
                // 任务清单/依赖图/全景全空 —— 用户看到的是"有人在跑，面板却什么都没有"。
                // 只在真的有活子代理时投影；行上带 live:true，UI 会明确标注这不是 TASKS.json。
                // （`subs` 非空本身就意味着在 people 分节里，另外再显式判一次免得将来改坏。）
                if (want('people') && !taskList(sel.tasks).length && subs.length) {
                  sel.tasksLive = subs.filter((s) => s && s.id).map((s, i) => ({
                    id: 'L' + (i + 1),
                    title: String(s.label || '').trim() || (roleOfSub(s) || 'agent') + ' · ' + String(s.id).slice(0, 8),
                    owner: roleOfSub(s) || '',
                    status: (s.activity === 'running' || s.running === true) ? 'in_progress' : 'completed',
                    live: true,
                    agentId: String(s.id || ''),
                    model: s.model || ''
                  }));
                  sel.tasksEmpty = true;
                }
                mark('agents');
                // Live per-agent activity feed (Qoder-style): last tool events
                // per subagent session, keyed by agent id.
                // 只在 feed 分节里收集（它按子会话遍历活动缓存；summary 首屏不需要）。
                // 上限：agent 数封顶 MAX_FEED_AGENTS，超出的条数如实进 `scopeCaps`（不是 degraded）。
                const feed = {};
                if (want('feed')) {
                  const feedTargets = subs.slice(0, MAX_FEED_AGENTS);
                  if (subs.length > MAX_FEED_AGENTS) capFacts.push({ key: 'feed', total: subs.length, limit: MAX_FEED_AGENTS });
                  for (const s of feedTargets) {
                    const arr = ACTIVITY.get(s.id);
                    if (arr && arr.length) feed[s.id] = arr.slice(-12);
                  }
                }
                sel.feed = feed;
                // 用同一批 feed 事件回填 lastEventAt（不额外读日志）
                for (const a of sel.agents) {
                  try {
                    const arr = feed[a.id];
                    if (arr && arr.length) { const last = arr[arr.length - 1]; if (last && typeof last.ts === 'number') a.lastEventAt = last.ts; }
                  } catch (e) { /* best-effort */ }
                }
                // Host-time enforcement: keep the quality-gate/scheduler verdict
                // on the wire so the overlay + lead always SEE violations live
                // (a red banner), not only when someone runs /team check.
                try { sel.violations = checkTasks(taskList(sel.tasks), sel.phase, sel); } catch { sel.violations = []; }
                // C4：面板红条也要能看到**存量** schema 违规（原先只有写入瞬间告警）。
                // ⚠️ 必须校验**磁盘上的文件形状**，不能传 `sel`：`sel` 是合并视图，它的 `members`
                // 是 ROSTER 的「角色→成员对象」，而 STATE.json 的 `members` 是**数组**
                // （两者同名不同物）—— 传 sel 会恒报一条假违规 `members 应为数组`。
                try {
                  const rawState = await readJsonSafe(join(sel.workspace, 'team', sel.runId, 'STATE.json'));
                  sel.violations = sel.violations.concat(schemaViolations(rawState, { tasks: taskList(sel.tasks) }));
                  // B2：自建 run 也要在面板红条上可见（同一份指纹，口径一致）
                  const rawRoster = await readJsonSafe(join(sel.workspace, 'team', sel.runId, 'ROSTER.json'));
                  const fp = scaffoldFingerprint(rawState, rawRoster, { hasRoster: !!(rawRoster && Array.isArray(rawRoster.roles) && rawRoster.members) });
                  sel.scaffoldSelfBuilt = fp.selfBuilt;
                  sel.scaffoldMissing = fp.missing;
                  if (fp.selfBuilt) sel.violations = sel.violations.concat([`非脚手架 run（疑似绕过 /team 手写）：缺 ${fp.missing.join('、')}`]);
                } catch { /* best-effort */ }
                try { sel.warnings = checkKindWarnings(taskList(sel.tasks)); } catch { sel.warnings = []; }
                mark('assemble');
                // Live monitoring: RUN.log feed (what just happened) + git
                // changed files (what is being touched right now).
                // 只在 artifacts 分节里读（`liveFiles` 要跑 git、`runLogTail` 要读日志尾部）。
                if (want('artifacts')) {
                  const withinArtifacts = () => (Date.now() - peopleStartedAt) < ARTIFACTS_DEADLINE_MS;
                  if (!withinArtifacts()) cutFacts.push('artifacts:deadline');
                  else {
                    try { sel.logTail = await runLogTail(join(sel.workspace, 'team', sel.runId)); } catch { sel.logTail = ''; }
                    if (!withinArtifacts()) cutFacts.push('files:deadline');
                    else { try { sel.files = await liveFiles(sel.workspace, sel.runId); } catch { sel.files = []; } }
                  }
                }
                mark('artifacts');
                // 事实收集完毕 ⇒ 由**纯函数**给两个承载位下判据（单一真源、可单测）：
                //   `degraded` = 真故障（**不含**按设计的上限）；`scopeCaps` = 上限（数字照发）。
                // 变量名保持 `degraded` 不变：响应形状与既有断言不必改，改的是**进不进得来**。
                const marks = classifyStateShortfall({ cuts: cutFacts, caps: capFacts });
                const degraded = marks.degraded;
                const scopeCaps = marks.scopeCaps;
                // **GET 不写 run 工件**（2026-09-13 修）：这里原先每 ≤5 分钟触发一次
                // `autoAggregate`（`Date.now() - lastAggAt > 5*60*1000`），于是浮层每 3 秒的轮询
                // 会**周期性改写 `team/METRICS.md` 与 `team/LEARNINGS.md`** —— 而 `LEARNINGS.md`
                // 同时是 lead 在 run 里写的 ⇒ 一处真实的并发写面（本仓最高频的环境类卡点正是
                // `error:external-write`）。聚合改为**显式触发**：`/team learn`、建 run 时、
                // 以及 `POST /plugins/dsh-expert-team/metrics/refresh`。
                // ⚠️ 本 handler 仍有另外两处写（未在本轮改动）：`persistSessionRuns()` 写
                // `$DSH_HOME/expert-team/session-runs.json`（插件自身状态，在 `team/` 之外）、
                // 以及上面的「派工即登记」写本 run 的 `STATE.json`。它们同样值得搬到显式路径，
                // 但那属于「第二个写者」的设计问题（见 `docs/专家团-开发计划.md` 的第 17 项）。
                persistSessionRuns();
                mark('tail');
                // profile 只在 DSH_EXPERT_TEAM_STATE_PROFILE=1 时出现（默认不含该字段，
                // 线上响应体不变）；rolesPending = "**还没解析**"的子会话条数（与本轮是否节流无关），
                // 让调用方能把"还没解析"与"解析不出来"分开（两种零可区分）。
                const budget = roleReadBudgetSnapshot();
                json(200, Object.assign(
                  { ok: true, runs, workspaces, cwd, agents: sel.agents, rolesPending: budget.deferred, subsPending },
                  sel,
                  // 新增字段（只在相关时出现，默认负载与老客户端保持不变）：
                  //   sections —— 显式要了分节时，告诉调用方"这份负载包含哪些块"（缺的块 ≠ 空数据，
                  //               客户端据此区分"摘要里没有"与"真的是空的"）；
                  //   degraded —— 命中硬上限/软期限而**少算了东西**时的如实标注（不许静默丢）。
                  //   warming —— 重读被挪到后台（单飞预热在飞）时的如实标注：**不是失败、不是截断**，
                  //               而是"这一块的数据来自上一份完整快照或暂时缺席"。与 degraded 分开承载，
                  //               两者语义不许混（真截断仍进 degraded）。
                  secRequested ? { sections: included } : null,
                  warming.length ? { warming: warming.slice() } : null,
                  // scopeCaps —— **按设计的能力上限**（不是故障）：明示"另有 N 条只列了名、没做最贵的
                  // 日志解析 / 未纳入事件流"，并带上 limit/total 让调用方自己算比例。与 `degraded`
                  // （真故障）分开、也与 `warming`（后台刷新中）分开。数字一个不少 —— 这不是隐藏，
                  // 而是"不把设计上限当告警"（常亮的告警会把真告警一起降权）。
                  Object.keys(scopeCaps).length ? { scopeCaps } : null,
                  // workflow 事件索引的**新鲜度**（非 profile 字段：它是数据本身的属性，不是诊断开关）：
                  //   state=fresh（TTL 内）/stale（上一份完整快照，正在后台刷新）/missing（本轮没有）。
                  // 为什么要下发：把"给了你一份 31 秒前的快照"这件事**明示**，而不是让调用方以为是最新。
                  want('people') ? { wfIndex: { state: wfIdx.state, ageMs: wfIdx.ageMs, refreshing: wfIdx.refreshing } } : null,
                  degraded.length ? { degraded: true, degradedReason: degraded.join(','), sections: included } : null,
                  prof ? { profile: assembleStateProfile(prof.steps, {
                    rolesBudget: budget,
                    // subs 段的两本账（只在 profile 开关下出现）：`cut` 是**本轮的结论**
                    // （''/'throttled'/'deadline'/'warming'），其余是计数器 —— 把"热路径到底
                    // 还去不去做那次 2.7 s 的全库枚举"变成可测的数字，而不是注释里的承诺。
                    //
                    // ⚠️ 键名是 `subsCounters` 而**不是** `subs`：`mark('subs')` 已经占用了
                    // `profile.subs` 表示**该步耗时**（数值）。两者同名会互相覆盖 —— 计数器盖掉
                    // 耗时，于是那一步在 profile 里压根看不见。分工由 `assembleStateProfile` 兜住。
                    subsCounters: {
                      cut: SUB_HEADER_STATS.cut,
                      rowsHits: SUB_HEADER_STATS.rowsHits,
                      rowsMisses: SUB_HEADER_STATS.rowsMisses,
                      liveRows: SUB_HEADER_STATS.liveRows,
                      warms: SUB_HEADER_STATS.warms,
                      warmErrors: SUB_HEADER_STATS.warmErrors,
                      warmTimeouts: SUB_HEADER_STATS.warmTimeouts,
                      warmMs: SUB_HEADER_STATS.warmMs,
                      memoHits: SUB_HEADER_STATS.memoHits,
                      memoWrites: SUB_HEADER_STATS.memoWrites,
                      enumCalls: SUB_HEADER_STATS.enumCalls,
                    },
                    // wf 段（父会话 workflow 事件索引）：把"请求路径还去不去做那次全量日志读"
                    // 变成可测数字。`state`：fresh（TTL 内）/stale（过期但先给旧快照）/missing（没有快照）。
                    wfCounters: {
                      state: wfIdx.state,
                      refreshing: wfIdx.refreshing,
                      ageMs: wfIdx.ageMs,
                      warms: WF_EVENT_STATS.warms,
                      warmErrors: WF_EVENT_STATS.warmErrors,
                      readErrors: WF_EVENT_STATS.readErrors,
                      warmMs: WF_EVENT_STATS.warmMs,
                      memoFresh: WF_EVENT_STATS.memoFresh,
                      memoStale: WF_EVENT_STATS.memoStale,
                      misses: WF_EVENT_STATS.misses,
                    },
                    // 角色日志读的后台账（请求路径已 0 次读日志）
                    rolesWarm: {
                      warms: ROLE_WARM_STATS.warms,
                      errors: ROLE_WARM_STATS.errors,
                      warmMs: ROLE_WARM_STATS.warmMs,
                      running: ROLE_WARM_RUNNING,
                    },
                    warming: warming.slice(),
                  }) } : null,
                ));
              } catch (e) {
                json(500, { ok: false, error: String(e && e.message ? e.message : e) });
              }
            },
          });
          wctx.effect(() => dispose);

          // Artifact content route (client overlay right-side preview). Resolves
          // cwd from sessionId (or cwd param) + run; serves only known artifacts.
          const disposeArtifact = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/artifact',
            methods: ['GET'],
            // 试点路由：改走 `lib/routes/shared.js` 的 `withRoute`（消掉本条自己的
            // json 助手 / 405 判断 / 500 兜底三份样板）。行为逐字保持：参数校验仍由本函数负责。
            handler: withRoute(async ({ res, json, query }) => {
              const sid = (query.get('sessionId') ?? '').trim();
              const cwd = (query.get('workspace') ?? '').trim() || (query.get('cwd') ?? '').trim() || cwdFromSession(ctx, sid);
              const run = (query.get('run') ?? '').trim();
              const name = (query.get('name') ?? '').trim();
              if (!cwd || !run || !name || /[\\/]/.test(run) || /[\\/]/.test(name) || !ARTIFACT_NAMES.includes(name)) { json(400, { ok: false, error: 'bad params' }); return; }
              const md = await readFile(join(cwd, 'team', run, name + '.md'), 'utf8').catch(() => null);
              if (md == null) { json(404, { ok: false, error: 'artifact not found' }); return; }
              json(200, { ok: true, name, text: md, cwd, run });
            }, { methods: ['GET'] }),
          });
          wctx.effect(() => disposeArtifact);

          // Code index search route (Qoder-style): instant keyword hits from
          // team/CODEINDEX.json. Builds lazily if the index is missing.
          const disposeCodeidx = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/codeidx',
            methods: ['GET'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
                const url = new URL(req.url ?? '/plugins/dsh-expert-team/codeidx', 'http://127.0.0.1');
                const ws = (url.searchParams.get('workspace') ?? '').trim() || (url.searchParams.get('cwd') ?? '').trim();
                const q = (url.searchParams.get('q') ?? '').trim();
                if (!ws || !q) { json(400, { ok: false, error: 'bad params' }); return; }
                const { hits, built, source } = await searchCodeIndex(ws, q);
                json(200, { ok: true, hits, built, source });
              } catch (e) {
                json(500, { ok: false, error: String(e && e.message ? e.message : e) });
              }
            },
          });
          wctx.effect(() => disposeCodeidx);

          // Read-only file preview route (A①: click a code-index hit → preview).
          // Path must be a RELATIVE workspace path (no `..`, no absolute).
          const disposeFileView = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/file',
            methods: ['GET'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
                const url = new URL(req.url ?? '/plugins/dsh-expert-team/file', 'http://127.0.0.1');
                const ws = (url.searchParams.get('workspace') ?? '').trim();
                const rel = (url.searchParams.get('path') ?? '').trim();
                if (!ws || !rel || rel.startsWith('/') || rel.includes('..') || !/^[\w@./-]+$/.test(rel)) { json(400, { ok: false, error: 'bad params' }); return; }
                const abs = join(ws, rel);
                // 有宿主 fs 就走宿主策略；**读被拒时如实报 403，绝不退回裸 readFile** ——
                // 退回等于"策略拒绝 + 我们绕开它"，比压根不做策略校验更糟。
                if (ADOPTED_HOST_FS) {
                  try {
                    const resolved = await ADOPTED_HOST_FS.resolve(abs);
                    const text = await ADOPTED_HOST_FS.readText(resolved);
                    json(200, { ok: true, path: rel, text: String(text).slice(0, 120000), source: 'host-fs' });
                  } catch (e) {
                    const msg = String(e && e.message ? e.message : e);
                    const notFound = (e && e.code === 'ENOENT') || /ENOENT|not found/i.test(msg);
                    json(notFound ? 404 : 403, { ok: false, error: notFound ? 'not found' : 'read denied by host fs policy: ' + msg });
                  }
                  return;
                }
                const text = await readFile(abs, 'utf8');
                json(200, { ok: true, path: rel, text: text.slice(0, 120000), source: 'node-fs' });
              } catch (e) {
                json(404, { ok: false, error: String(e && e.code === 'ENOENT' ? 'not found' : (e && e.message ? e.message : e)) });
              }
            },
          });
          wctx.effect(() => disposeFileView);

          // Human-in-loop decision route: the user makes a choice in the overlay
          // (方案确认门 / 模糊选择 / quality-gate 升级). Records it into RUN.log +
          // DECISIONS.md and clears STATE.pendingDecision so the lead can proceed.
          const disposeDecide = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/decide',
            methods: ['POST'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
                let body = {};
                try { body = JSON.parse((await readRequestBody(req)) || '{}'); } catch { body = {}; }
                const sid = String(body.sessionId || '').trim();
                const cwd = String(body.workspace || '').trim() || cwdFromSession(ctx, sid);
                const run = String(body.run || '').trim();
                const choice = String(body.choice || '').trim();
                if (!cwd || !run || !choice || /[\\/]/.test(run)) { json(400, { ok: false, error: 'bad params' }); return; }
                const dir = join(cwd, 'team', run);
                const state = await readJsonSafe(join(dir, 'STATE.json'));
                if (!state) { json(404, { ok: false, error: 'run not found' }); return; }
                const tsStr = new Date().toISOString();
                await appendLog(dir, `decision:${choice} — 用户在浮层拍板（${tsStr}）`);
                const decPath = join(dir, 'DECISIONS.md');
                let dec = ''; try { dec = await readFile(decPath, 'utf8'); } catch { dec = '# 用户决策（DECISIONS）\n\n'; }
                await ARTIFACT.must(decPath, dec + `- [${tsStr}] **${choice}**\n`);
                // 大需求执行前询问（--confirm）：用户点「执行」必须**真的开工** —— 否则
                // 决策只被记录、团队永远不动（"点了没反应"）。这里用宿主 `ctx.agents.get(sessionId)`
                // 拿到该会话的 agent 并投一条 followup（与 /team 建 run 后派工同一入口）。
                const wasConfirm = !!(state.pendingDecision && state.pendingDecision.kind === 'confirm-before-execute');
                let dispatched = false;
                if (wasConfirm && choice === '执行') {
                  try {
                    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null;
                    const agent = agents && typeof agents.get === 'function' ? agents.get(sid) : null;
                    if (agent && typeof agent.followup === 'function') {
                      const mode = { task: state.goal || '', persist: state.mode === 'persist', noCode: state.deliverable === 'artifacts-only' };
                      agent.followup(await launchMessage(state.goal || '', cwd, dir, mode));
                      dispatched = true;
                      await appendLog(dir, `plan:confirmed — 用户确认执行，已投递派工消息（${tsStr}）`);
                    } else {
                      await appendLog(dir, `plan:confirm-failed — 找不到会话 ${sid} 的 agent（会话可能已结束）；请在本会话重发 /team resume ${run}（${tsStr}）`);
                    }
                  } catch (e) {
                    await appendLog(dir, `plan:confirm-error — 投递失败：${String((e && e.message) || e).slice(0, 120)}（${tsStr}）`);
                  }
                }
                // ── G 线：档位选择（浮层三选一）────────────────────────────────────────
                // 与 --confirm 同构：把用户的选择**真的写回**工件，而不是只记一条决策
                //（"点了没反应"是这个路由踩过的坑）。认不出的取值**拒绝并保留待决**，
                // 不静默吞掉 —— 用户的下一句话会是"我选了呀"。
                const wasTier = !!(state.pendingDecision && state.pendingDecision.kind === 'tier-select');
                let tierApplied = null;
                let rolesNarrowedNote = '';
                if (wasTier) {
                  const t = normalizeTier(choice);
                  if (!t) {
                    json(400, { ok: false, error: `unrecognized tier: ${choice}（合法值：${tierChoices().map((c) => c.label).join(' / ')}）` });
                    return;
                  }
                  tierApplied = t;
                  state.tier = t;
                  try {
                    const rosterPath = join(dir, 'ROSTER.json');
                    const roster = await readJsonSafe(rosterPath);
                    if (roster) {
                      roster.tier = t;
                      // **档位真正省派工的地方**：选档这一刻按档定班底 —— 但只动"未定制的基线班底"，
                      // 用户点过名的角色一个都不删（`narrowedRoles` 的规则，纯函数可单测）。
                      const narrowed = narrowedRoles(t, roster.roles, DEFAULT_ROLES);
                      if (narrowed) {
                        roster.roles = narrowed;
                        for (const r of Object.keys(roster.agents || {})) if (!narrowed.includes(r)) delete roster.agents[r];
                        roster.models = modelPlanFor(narrowed);
                        rolesNarrowedNote = ` · 已按档定班底：${narrowed.join(', ')}`;
                      }
                      await ARTIFACT.must(rosterPath, JSON.stringify(roster, null, 2) + '\n');
                    }
                  } catch { /* best-effort：ROSTER 写不进去不影响 STATE 已记档位 */ }
                  await appendLog(dir, `tier:selected — 用户选定「${TIER_LABELS_ZH[t]}」（${t}）· 上限：角色 ≤${TIER_SPEC[t].roleCap} / 验收项 ${TIER_SPEC[t].acceptanceCap === null ? '不限' : `≤${TIER_SPEC[t].acceptanceCap}`} / 派工 ${TIER_SPEC[t].dispatchCap === null ? '不限' : `≤${TIER_SPEC[t].dispatchCap}`}${rolesNarrowedNote}（${tsStr}）`);
                  // **hard 门**：这个 run 是"因为等选档位"才没开工的 ⇒ 选完必须**真的开工**
                  //（与 `--confirm` 点「执行」同一入口、同一纪律：绝不"点了没反应"）。
                  if (state.heldForTier) {
                    try {
                      const agents2 = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null;
                      const agent2 = agents2 && typeof agents2.get === 'function' ? agents2.get(sid) : null;
                      if (agent2 && typeof agent2.followup === 'function') {
                        const mode2 = { task: state.goal || '', persist: state.mode === 'persist', noCode: state.deliverable === 'artifacts-only', tier: t };
                        agent2.followup(await launchMessage(state.goal || '', cwd, dir, mode2));
                        dispatched = true;
                        await appendLog(dir, `tier:dispatched — 档位定为「${TIER_LABELS_ZH[t]}」，已投递派工消息（${tsStr}）`);
                      } else {
                        await appendLog(dir, `tier:dispatch-failed — 找不到会话 ${sid} 的 agent（会话可能已结束）；请重发 /team resume ${run}（${tsStr}）`);
                      }
                    } catch (e) {
                      await appendLog(dir, `tier:dispatch-error — 投递失败：${String((e && e.message) || e).slice(0, 120)}（${tsStr}）`);
                    }
                    delete state.heldForTier;
                  }
                }
                if (state.pendingDecision) { delete state.pendingDecision; state.updatedAt = tsStr; await ARTIFACT.must(join(dir, 'STATE.json'), state); }
                json(200, { ok: true, choice, run, dispatched, ...(tierApplied ? { tier: tierApplied } : {}), ...(rolesNarrowedNote ? { rolesNarrowed: true } : {}) });
              } catch (e) {
                json(500, { ok: false, error: String(e && e.message ? e.message : e) });
              }
            },
          });
          wctx.effect(() => disposeDecide);

          // ── F1 计划门（AgentTeams 借鉴）：暂存草稿 → 浮层可编辑 → 原子启动 ──
          // POST /plan          { sessionId, workspace, run, draft:{roles,tasks} } → 写 STATE.draft
          // POST /plan/approve  → 用 draft.tasks 落 TASKS.json、清 draft、置 planApprovedAt
          // POST /plan/discard  → 清 draft、置 planDiscarded（此后禁止自动重建同目标团队）
          const normalizeDraft = (raw, knownRaw) => {
            const d = raw && typeof raw === 'object' ? raw : {};
            const known = Array.isArray(knownRaw) && knownRaw.length ? knownRaw : DEFAULT_ROLES;
            const roles = Array.isArray(d.roles)
              ? Array.from(new Set(d.roles.map((r) => String(r || '').trim()).filter((r) => known.includes(r)))).slice(0, 24)
              : [];
            const pool = roles.length ? roles : known;
            const tasks = (Array.isArray(d.tasks) ? d.tasks : []).slice(0, 200).map((t, i) => {
              const o = t && typeof t === 'object' ? t : {};
              const owner = String(o.owner || '').trim();
              return {
                id: String(o.id || `T-${String(i + 1).padStart(2, '0')}`).slice(0, 48),
                kind: String(o.kind || 'implementation').slice(0, 24),
                owner: pool.includes(owner) ? owner : pool[0],
                title: String(o.title || '').slice(0, 160),
                spec: String(o.spec || '').slice(0, 300),
                acceptance: (Array.isArray(o.acceptance) ? o.acceptance : []).map((x) => String(x).slice(0, 200)).slice(0, 12),
                inScope: (Array.isArray(o.inScope) ? o.inScope : []).map((x) => String(x).slice(0, 200)).slice(0, 12),
                verify: (Array.isArray(o.verify) ? o.verify : []).map((x) => String(x).slice(0, 200)).slice(0, 8),
                dependsOn: (Array.isArray(o.dependsOn) ? o.dependsOn : []).map((x) => String(x).slice(0, 48)).filter(Boolean),
                attempt: 0, attemptId: null, round: 1, verdict: null, findings: [], status: 'pending',
              };
            });
            // 批 2-2（L2-2）：**不再静默删除**未知依赖 —— 保留原样并上报图结构错误，
            // 由调用方（/plan 路由）拒绝。旧行为是 `.filter(d => ids.has(d))`，
            // 让用户以为依赖生效、实则被悄悄删掉（依赖门从此形同虚设）。
            const graph = validateTaskGraph(tasks);
            return { roles: pool.slice(), tasks, graphErrors: graph.errors };
          };
          const planTarget = async (body) => {
            const sid = String(body.sessionId || '').trim();
            const cwd = String(body.workspace || '').trim() || cwdFromSession(ctx, sid);
            const run = String(body.run || '').trim();
            if (!cwd || !run || /[\\/]/.test(run)) return null;
            const dir = join(cwd, 'team', run);
            const state = await readJsonSafe(join(dir, 'STATE.json'));
            return state ? { dir, state, cwd, run } : null;
          };
          const disposePlan = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/plan',
            methods: ['POST'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
                let body = {};
                try { body = JSON.parse((await readRequestBody(req)) || '{}'); } catch { body = {}; }
                const t = await planTarget(body);
                if (!t) { json(404, { ok: false, error: 'run not found' }); return; }
                const roster = await readJsonSafe(join(t.dir, 'ROSTER.json'));
                const known = (roster?.roles && roster.roles.length) ? roster.roles : DEFAULT_ROLES;
                const draft = normalizeDraft(body.draft, known);
                if (!draft.tasks.length) { json(400, { ok: false, error: 'draft.tasks 不能为空' }); return; }
                // 批 2-2（L2-2）：图结构错误（未知依赖/重复 id/自依赖/环路）**直接拒绝**，
                // 不再静默删依赖放行 —— 否则环状 DAG 会让 implement 整体死锁而 /team check 不报违规。
                if (Array.isArray(draft.graphErrors) && draft.graphErrors.length) {
                  json(400, { ok: false, error: 'draft 依赖图不合法', detail: draft.graphErrors.map((e) => e.detail) });
                  return;
                }
                // O-3：容量上限 —— **fail loud，不静默截断**。与图结构校验同点同口径（落盘前拒）。
                const capErr = capacityViolations({ roles: draft.roles, tasks: draft.tasks });
                if (capErr.length) {
                  json(400, { ok: false, error: capErr[0].code, detail: capErr.map((c) => c.message) });
                  return;
                }
                // P3（SPEC §1.4）：**轮次**上限与容量上限**同一个写入校验点、同一风格** —— 命中即 400、
                // 连草稿都不写（否则第 N+1 轮的草稿会被批准进 TASKS.json，循环照样不收敛）。
                const loopErr = reworkLoopWriteGuard(
                  { tasks: draft.tasks, existingTasks: taskList(await readJsonSafe(join(t.dir, 'TASKS.json'))) },
                  t.state,
                );
                if (loopErr) { json(400, { ok: false, error: loopErr.code, detail: [loopErr.message] }); return; }
                const tsStr = new Date().toISOString();
                const { graphErrors: _drop, ...draftToStore } = draft; // 校验副产物，不持久化
                t.state.draft = { ...draftToStore, updatedAt: tsStr };
                // 批 0-3：**不得**在保存草稿时静默清除 planDiscarded —— 那会让「🗑 丢弃」被任何一次
                // 草稿写入复活（PM 复核指出的洞）。只有显式 allowRebuild 才解锁，并留痕。
                if (body.allowRebuild === true) {
                  if (t.state.planDiscarded) await appendLog(t.dir, `plan:unlock — 用户显式解除禁止重建标记（${tsStr}）`);
                  delete t.state.planDiscarded;
                }
                t.state.updatedAt = tsStr;
                await ARTIFACT.must(join(t.dir, 'STATE.json'), t.state);
                await appendLog(t.dir, `plan:stage — 计划草稿已更新（${draft.tasks.length} 任务 / ${draft.roles.length} 角色）（${tsStr}）`);
                json(200, { ok: true, draft: t.state.draft });
              } catch (e) { json(500, { ok: false, error: String(e && e.message ? e.message : e) }); }
            },
          });
          wctx.effect(() => disposePlan);

          const disposePlanApprove = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/plan/approve',
            methods: ['POST'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
                let body = {};
                try { body = JSON.parse((await readRequestBody(req)) || '{}'); } catch { body = {}; }
                const t = await planTarget(body);
                if (!t) { json(404, { ok: false, error: 'run not found' }); return; }
                const draft = t.state.draft;
                if (!draft || !Array.isArray(draft.tasks) || !draft.tasks.length) { json(400, { ok: false, error: '没有待批准的计划草稿' }); return; }
                const tsStr = new Date().toISOString();
                const prev = await readJsonSafe(join(t.dir, 'TASKS.json'));
                const prevTasks = taskList(prev);
                const settled = prevTasks.filter((x) => ['done', 'completed', 'failed', 'cancelled'].includes(x.status));
                const mergedTasks = [...settled, ...draft.tasks];
                // O-3：批准是真正落 TASKS.json 的地方 —— 上限必须在**写入前**拦
                // （按合并后的结果判，而不是只看草稿，否则"存量已结算 + 新草稿"会绕过上限）。
                const capErr = capacityViolations({ roles: draft.roles, tasks: mergedTasks });
                if (capErr.length) {
                  json(400, { ok: false, error: capErr[0].code, detail: capErr.map((c) => c.message) });
                  return;
                }
                // P3（SPEC §1.4）：新增的**超轮次质量任务**在真正落 TASKS.json 前被拒 —— 到顶的正确
                // 动作是写 STATE.pendingDecision 升级用户，而不是再落一个第 N+1 轮（事故里正是这么循环）。
                // 判据用 `mergedTasks` 对**磁盘现有** `prevTasks`：只有"磁盘上不存在的新增"才拦，
                // 原地更新（同一轮的结果回写）不拦。
                const loopErr = reworkLoopWriteGuard({ tasks: mergedTasks, existingTasks: prevTasks }, t.state);
                if (loopErr) { json(400, { ok: false, error: loopErr.code, detail: [loopErr.message] }); return; }
                // O2：批准的落 TASKS.json 也走 CAS —— 合并"存量已结算 + 新草稿"时对**新鲜**内容重做合并，
                // 否则两个批准者/写者会互相覆盖（这正是"静默丢更新"）。
                const ap = await mutateTasks(t.dir, (json) => {
                  const prevNow = taskList(json);
                  const settledNow = prevNow.filter((x) => ['done', 'completed', 'failed', 'cancelled'].includes(x.status));
                  return { next: { ...json, tasks: [...settledNow, ...draft.tasks] }, result: { count: settledNow.length + draft.tasks.length } };
                });
                if (!ap.ok) { json(409, { ok: false, error: ap.code, detail: [String(ap.error)] }); return; }
                if (Array.isArray(draft.roles) && draft.roles.length) {
                  const roster = (await readJsonSafe(join(t.dir, 'ROSTER.json'))) || { runId: t.run };
                  roster.roles = draft.roles;
                  roster.members = roster.members || {};
                  await ARTIFACT.must(join(t.dir, 'ROSTER.json'), JSON.stringify(roster, null, 2) + '\n');
                }
                delete t.state.draft;
                delete t.state.pendingDecision;
                t.state.planApprovedAt = tsStr;
                t.state.updatedAt = tsStr;
                await ARTIFACT.must(join(t.dir, 'STATE.json'), t.state);
                // O9：批准时就把写域撞车风险写进 RUN.log（不只靠 /team check 事后发现）
                const overlapWarns = scopeOverlapWarnings(mergedTasks);
                for (const w of overlapWarns) await appendLog(t.dir, `plan:scope-overlap — ${w.a} × ${w.b}：${w.reason}`);
                await appendLog(t.dir, `plan:approve — 用户在浮层批准计划，${draft.tasks.length} 个任务已落入 TASKS.json（${tsStr}）`);
                const decPath = join(t.dir, 'DECISIONS.md');
                let dec = ''; try { dec = await readFile(decPath, 'utf8'); } catch { dec = '# 决策记录（DECISIONS）\n\n'; }
                await ARTIFACT.must(decPath, dec + `- [${tsStr}] **Approve & Run**：批准计划草稿（${draft.tasks.length} 任务 / ${(draft.roles || []).length} 角色）\n`);
                json(200, { ok: true, tasks: draft.tasks.length, run: t.run });
              } catch (e) { json(500, { ok: false, error: String(e && e.message ? e.message : e) }); }
            },
          });
          wctx.effect(() => disposePlanApprove);

          const disposePlanDiscard = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/plan/discard',
            methods: ['POST'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
                let body = {};
                try { body = JSON.parse((await readRequestBody(req)) || '{}'); } catch { body = {}; }
                const t = await planTarget(body);
                if (!t) { json(404, { ok: false, error: 'run not found' }); return; }
                const tsStr = new Date().toISOString();
                const reason = String(body.reason || '').slice(0, 160);
                delete t.state.draft;
                delete t.state.pendingDecision;
                // discard 语义（AgentTeams 借鉴）：置标记，此后编排者不得自动重建同目标团队
                // 批 0-3：连带记录**目标指纹**，否则 createRun 无从判定"同目标"（原实现只置位、从不读）
                t.state.planDiscarded = { at: tsStr, reason: reason || '用户丢弃计划草稿', goal: t.state.goal || '', goalKey: t.state.goalKey || goalKeyOf(t.state.goal || '') };
                t.state.updatedAt = tsStr;
                await ARTIFACT.must(join(t.dir, 'STATE.json'), t.state);
                await appendLog(t.dir, `plan:discard — 用户丢弃计划草稿；已置禁止自动重建标记（${tsStr}）${reason ? ' · 原因：' + reason : ''}`);
                json(200, { ok: true, run: t.run });
              } catch (e) { json(500, { ok: false, error: String(e && e.message ? e.message : e) }); }
            },
          });
          wctx.effect(() => disposePlanDiscard);

          // Overlay task operation: change one task's status (writes TASKS.json
          // + RUN.log). Same trust level as decide.
          const disposeTaskOp = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/task',
            methods: ['POST'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
                let body = {};
                try { body = JSON.parse((await readRequestBody(req)) || '{}'); } catch { body = {}; }
                const sid = String(body.sessionId || '').trim();
                const cwd = String(body.workspace || '').trim() || cwdFromSession(ctx, sid);
                const run = String(body.run || '').trim();
                const id = String(body.id || '').trim();
                const status = String(body.status || '').trim();
                const note = String(body.note || '').slice(0, 120).trim();
                if (!cwd || !run || !id || !TASK_STATUSES.includes(status) || /[\\/]/.test(run)) { json(400, { ok: false, error: 'bad params' }); return; }
                const r = await applyTaskStatus(join(cwd, 'team', run), id, status, note);
                json(200, { ok: r.ok, text: r.text });
              } catch (e) {
                json(500, { ok: false, error: String(e && e.message ? e.message : e) });
              }
            },
          });
          wctx.effect(() => disposeTaskOp);

          // ── GET /state 不再聚合（2026-09-13）：显式刷新入口。浮层要刷新指标时用 **POST**，
          //    不要用 GET —— 一个 GET 写盘既破坏幂等，又给 run 工件引入并发写面。
          const disposeMetrics = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/metrics/refresh',
            methods: ['POST'],
            handler: async (req, res) => {
              const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
              try {
                if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
                let body = {};
                try { body = JSON.parse((await readRequestBody(req)) || '{}'); } catch { body = {}; }
                const sid = String(body.sessionId || '').trim();
                const cwd = String(body.workspace || '').trim() || cwdFromSession(ctx, sid);
                if (!cwd) { json(400, { ok: false, error: 'bad params' }); return; }
                const r = await aggregate(cwd);
                json(200, { ok: true, ...r });
              } catch (e) {
                json(500, { ok: false, error: String(e && e.message ? e.message : e) });
              }
            },
          });
          wctx.effect(() => disposeMetrics);

          // ── F 线：设置控制台路由（GET 读 / POST 写）──────────────────────────────
          // 走 `withRoute`（B 线第 9 项抽出的共享件）：方法校验 / 405 空体 / 500 兜底一条不落。
          // **诚实边界（2026-09-15 更正 → 1.3.4 接线完成）**：此前这里写"`roster`/`gates` 两类改完要
          // 重启、`display` 类即时生效"—— 当时两句都不实。现状（都已在测试里钉住）：
          //   · `roster`/`gates`：由 `reapplySettingsDerived()` 当场重算，`roster.defaultRoles` 等在建 run
          //     时读（见 `resolveRosterDefaults()`）⇒ **无需重启**；
          //   · `display.*`：1.3.4 起**真的有消费者** —— 浮层/面板由 `client.js` 的 `useDisplaySettings()`
          //     （单一设置桥 `EXPERT_DISPLAY`）读，画布 live 轮询由本文件的 `canvasPollMs()` 读。
          // 响应里不声称任何一类需要重启（1.3.2 起 `needsRestart` 恒 false）。
          const disposeSettings = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/settings',
            methods: ['GET', 'POST'],
            handler: withRoute(async ({ req, res, json, body }) => {
              const method = String((req && req.method) || 'GET').toUpperCase();
              if (method === 'GET') {
                const cur = SETTINGS_CACHE || loadSettingsSync();
                json(200, { ok: true, settings: cur.settings, schema: settingsSchema(), repaired: cur.repaired, path: settingsPath(), groups: SETTINGS_GROUPS });
                return;
              }
              // POST：补丁可以嵌套（{roster:{maxTasks:10}}）也可以扁平（{'roster.maxTasks':10}）
              const patch = body && typeof body === 'object' && body.patch ? body.patch : body;
              const merged = mergeSettings(currentSettings(), patch);
              if (!merged.ok) {
                json(400, { ok: false, errors: merged.errors, settings: merged.value });
                return;
              }
              // 宿主命名空间可用 ⇒ 可表达的字段写**宿主**（官方面板与浮层共用同一份真源，
              // 且随市场备份/恢复）；宿主表达不了的字段（如 roster.defaultRoles）继续写 settings.json。
              // 两边都只写自己拥有的字段 —— 同一个字段在两个存储里各留一份，是这个仓最忌讳的形态。
              const viaHost = await updateHostSettings(patch);
              const fileOnly = pickFileOnly(patch);
              const writeFile = !viaHost.ok || Object.keys(fileOnly).length > 0;
              try {
                if (writeFile) {
                  // `$DSH_HOME/expert-team/` 在全新环境里可能还不存在（受控写入口不会替你建目录）。
                  await mkdir(dirname(settingsPath()), { recursive: true });
                  const forFile = viaHost.ok ? pickFileOnly(merged.value) : merged.value;
                  await ARTIFACT.must(settingsPath(), JSON.stringify(forFile, null, 2) + '\n');
                }
              } catch (e) {
                json(500, { ok: false, errors: [`设置写入失败：${String((e && e.message) || e)}`], settings: currentSettings() });
                return;
              }
              SETTINGS_CACHE = { settings: merged.value, repaired: [], at: new Date().toISOString() };
              if (!viaHost.ok) reapplySettingsDerived();   // 文件路径：与 1.1.x 一样在进程内重算
              // `needsRestart` **恒为 false**（2026-09-15 逐项查明）：能改的项里，容量/轮次上限、
              // 档位门、振荡检测开关都由上面 `reapplySettingsDerived()` 当场重算；
              // `identity.*` 每次建 run 时经 `compilePolicy(currentSettings())` 现读；
              // `SETTINGS_CACHE` 就在上一行刷新 ⇒ **没有任何一项需要重启**。
              // 此前按"补丁顶层键 ∈ {roster,gates}"置 true 并回一句"重启后生效"，那是**假话**：
              // 同一个补丁刚在上一行被重算过。字段保留是为了不破坏客户端契约，但它只能说真话。
              const needsRestart = false;
              json(200, {
                ok: true,
                settings: merged.value,
                needsRestart,
                settingsSource: viaHost.ok ? 'host' : 'file',
                note: viaHost.ok
                  ? `已保存到宿主设置（命名空间 ${HOST_SETTINGS_NAMESPACE}）：官方面板与浮层共用同一份，且随插件市场的备份/恢复一起走；上限、轮次、档位门与振荡检测开关已在进程内重算，**无需重启**。`
                  : '已保存并即时生效（上限 / 轮次 / 档位门 / 振荡检测开关在进程内重算；`身份`、`班底` 等在下一次 `/team` 建 run 时读取）。',
              });
            }, { methods: ['GET', 'POST'] }),
          });
          wctx.effect(() => disposeSettings);

          // ── 1.3.18 一期（只读诊断）+ 1.3.21 二期（可写配置）────────────────────────
          // 为什么单独一条路由：那两种真实故障（服务端 PG 共享内存 500 / WAF 403 防火墙页）都在
          // **服务端**，而客户端此前只把一长串 JSON/HTML 原样抛出 ⇒ 用户不知道该改哪里。这条路由把
          // "看"做扎实：读配置（`HINDSIGHT_CONFIG || ~/.hindsight/coding-agent.json`）、读诊断日志
          // 尾部、启发式分类 + 可操作 hint，并**仅在 `?probe=1` 时**探一次连通性。
          //
          // 二期在同一路径上加了 **POST**（写配置）。它**不走**宿主的设置命名空间：这份文件是
          // Hindsight 自己的真源（它还认 `HINDSIGHT_CONFIG` 与默认路径），插件替它另存一份就是
          // "同一个字段两个家"。写路径的纪律见 `lib/hindsight-config-write.js` 顶部注释：
          // **只改提交的键、保留一切未知键、0600 原子写、校验不过不落盘、token 永不回显、
          // 空串 ≠ 删除（清除必须显式 `clear`）**。
          const disposeHindsight = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/hindsight-config',
            methods: ['GET', 'POST'],
            handler: withRoute(async ({ json, query, body, req }) => {
              const method = String((req && req.method) || 'GET').toUpperCase();
              if (method === 'POST') {
                // 校验不过 ⇒ 400 且**未写盘**；IO 失败 ⇒ 500 且原文件未动；没有改动 ⇒ saved:false。
                const out = await saveHindsightConfig({ body, env: process.env });
                if (!out.ok) { json(out.status || 400, { ok: false, path: out.path, errors: out.errors, notes: out.notes }); return; }
                json(200, out);
                return;
              }
              const wantProbe = String(query.get('probe') ?? '') === '1';
              const sid = (query.get('sessionId') ?? '').trim();
              // 工作区：优先显式 `cwd`，其次由会话 id 反查（与 /state 同一条取法）—— 只为推导 bank 名。
              const cwd = (query.get('cwd') ?? '').trim() || (sid ? (cwdFromSession(ctx, sid) || '') : '');
              const report = await buildHindsightReport({
                env: process.env,
                cwd: cwd || undefined,
                probe: wantProbe,
              });
              json(200, report);
            }, { methods: ['GET', 'POST'] }),
          });
          wctx.effect(() => disposeHindsight);

          // ── 预设/技能铺设的**归属与状态**（2026-09-16 · 用户批准 (a)+(b)）────────────
          // 为什么必须有这条路由：铺盘"没覆盖"的两种情形（目录是你的定制 / 目录不完整）
          // 旧实现只打一行 warn ⇒ 看起来完全正常，但插件预设可能**再也铺不上**。
          // 本路由把事实摊开：四态判定 + 版本 + 缺哪些入口文件；POST `{action:'relay'}`
          // 是**用户显式**要求重铺（会如实回报"替换了什么"）。
          const disposePresetLay = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/preset-lay',
            methods: ['GET', 'POST'],
            handler: withRoute(async ({ json, body, req }) => {
              const method = String((req && req.method) || 'GET').toUpperCase();
              if (method === 'POST') {
                const action = String((body && body.action) || '').trim();
                if (action !== 'relay') {
                  json(400, { ok: false, error: 'unsupported action', allowed: ['relay'] });
                  return;
                }
                const kindRaw = String((body && body.kind) || 'both').trim();
                const kind = (kindRaw === 'preset' || kindRaw === 'skill') ? kindRaw : 'both';
                const out = await relayInstalledAssets(kind);
                json(out.ok ? 200 : 500, out);
                return;
              }
              json(200, presetLayStatus({ runtimeSkillRegistered: RUNTIME_SKILL_REGISTERED, skillTarget: SKILL_DIR, pluginVersion: PLUGIN_VERSION }));
            }, { methods: ['GET', 'POST'] }),
          });
          wctx.effect(() => disposePresetLay);

          // 子代理列表顺序的**生效状态**（只读）。为什么必须有一条：设置项的值是"想不想开"，
          // 而这里回答"**到底有没有生效**"——宿主改名/换服务时插件会静默退回默认顺序，
          // 界面上必须能如实说出来（"装了却没生效"不许被藏起来）。
          const disposeSubagentOrderRoute = registerLocal({
            kind: 'exact',
            path: '/plugins/dsh-expert-team/subagent-order',
            methods: ['GET'],
            handler: withRoute(async ({ json }) => {
              const status = subagentOrderStatus();
              json(200, {
                ok: true,
                ...status,
                service: SUBAGENT_ORDER_SERVICE,
                method: 'remoteExportList',
                settingPath: 'display.subagentListNewestFirst',
                // 让客户端不必再抄一份话术：这一句就是"没生效时"的成因说明。
                note: status.effective
                  ? '已生效：宿主 GUI 的子代理列表按最新在上显示（只改展示顺序；服务端 listChildren 的升序契约未变）。'
                  : (status.enabled
                    ? '未生效：宿主结构不匹配，已退回宿主默认顺序（最旧在上）。插件其余功能不受影响。'
                    : '已关闭：使用宿主默认顺序（最旧在上）。'),
              });
            }, { methods: ['GET'] }),
          });
          wctx.effect(() => disposeSubagentOrderRoute);
        });
      });
    } catch { /* webServer plumbing unavailable — live canvas degrades to static snapshot */ }
  }
}



