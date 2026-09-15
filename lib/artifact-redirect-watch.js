/**
 * R1 绕过检测：`bash` / `pwsh` 里"重定向写进 run 工件"的**只报不拦**观测器（2026-09-15）。
 *
 * ── 为什么需要它（而不是把它也做成门禁）────────────────────────────────────
 * R1 硬门禁（`lib/artifact-ownership.js`）只覆盖 **`write` / `edit`** 通道。preset 里
 * `backend` / `frontend` / `researcher` / `qa` / `dba` / `devops` **持 `bash`**，理论上可以
 * `cat > SPEC.md` 绕过门禁。**静默绕过**违背本仓纪律（"失败要出声"），但**首版刻意不做阻断**：
 *   · `bash` 的写目标可以是重定向、`tee`、变量、子命令替换 —— 静态判断**不可靠**；
 *   · 一旦误判，代价是"把正常命令判成越权"（比漏报更伤，本仓有前车之鉴：门禁变成故障源）。
 * ⇒ 折中：**只留痕**，用真实运行里的命中频率来决定以后要不要收紧。
 *
 * ── 口径（保守，宁可漏报）────────────────────────────────────────────────
 * 只有同时满足下面三条才算命中：
 *   ① 工具是 `bash` / `pwsh`；
 *   ② 命令里出现**明显的写目标**：`>` / `>>` / `tee [-a]` 之后紧跟一个路径 token；
 *   ③ 该路径解析后**恰好是** `<team 根>/<runId>/<文件名>`（沿用 `runScopedTarget` 的两段口径，
 *      更深的子目录 / 工作区代码 / `/tmp` / `/dev/null` 一律不命中），且文件名属于**已知工件**。
 *
 * 本监听器**绝不**改动结果、**绝不**抛错（沿用 `interception.js` 的纪律：
 * 监听器一旦抛错会被宿主收敛为工具失败，2026-09-12 出过全工具瘫痪事故）。
 */

import { resolve, basename } from 'node:path';
import { runScopedTarget } from './interception.js';

/** shell 类工具（R1 门禁覆盖不到的那些）。 */
export const SHELL_WRITE_TOOLS = Object.freeze(new Set(['bash', 'pwsh']));

/** 去掉包裹的引号（`"a b"` / `'a b'`），保留原样其余内容。 */
function unquote(tok) {
  const s = String(tok || '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * 从命令串里提取**候选写目标**（纯函数、保守）。
 * 只认两种形态：`>` / `>>`（可带 fd 前缀如 `2>`）与 `tee [-a] <path>`。
 * 变量 / 命令替换 / 通配符**不解析**（拿不准就漏报 —— 这是本文件的既定口径）。
 */
export function extractWriteTargets(command) {
  const cmd = String(command || '');
  const out = [];
  const push = (raw) => {
    const t = unquote(raw);
    if (!t) return;
    if (t === '/dev/null' || t === '/dev/stdout' || t === '/dev/stderr') return;
    if (/[$`*?]/.test(t)) return;      // 含变量/替换/通配 ⇒ 不解析（宁可漏报）
    if (t.startsWith('&')) return;     // `&>` 的 fd 形式交给下一条规则
    out.push(t);
  };
  // `>` / `>>`（含 `1>`, `2>>`, `&>`），后跟一个 token
  const redir = /(?:\d?&?>>?|&>>?)\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g;
  let m;
  while ((m = redir.exec(cmd)) !== null) push(m[1]);
  // `tee [-a] <path>`：只取**第一个**路径参数（`tee a b` 少见，且多写不算漏报）
  const tee = /(?:^|[\s;|&(])tee(?:\s+-[a-zA-Z]+)*\s+("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g;
  while ((m = tee.exec(cmd)) !== null) push(m[1]);
  return out;
}

/**
 * 判定命令里是否**明显**写向 `<teamRoot>/<runId>/<已知工件>`。
 * @returns {{abs:string, runId:string, base:string}|null}
 */
export function detectArtifactRedirect(command, { cwd, teamRoot, knownArtifacts } = {}) {
  if (!cwd || !teamRoot) return null;
  const known = knownArtifacts instanceof Set ? knownArtifacts : new Set(knownArtifacts || []);
  if (!known.size) return null;
  for (const raw of extractWriteTargets(command)) {
    let abs;
    try { abs = resolve(cwd, raw); } catch { continue; }
    const scoped = runScopedTarget(abs, teamRoot);   // 只认 `<teamRoot>/<runId>/<文件名>` 两段
    if (!scoped) continue;
    const base = basename(abs);
    if (!known.has(base)) continue;
    return { abs, runId: scoped.runId, base };
  }
  return null;
}

/**
 * 创建 `tools/post-execute` 监听器（**纯观测**：不改结果、不阻断、不抛错）。
 * deps：`knownArtifacts`（已知工件文件名集合，由调用方从**单一真源**传入）、
 *       `cwdFor(exec)`、`teamRootFor(cwd)`、`onEvent(type, payload)`、可选 `warn(line)`。
 */
export function createArtifactRedirectWatcher({ knownArtifacts, cwdFor, teamRootFor, onEvent, warn } = {}) {
  const known = knownArtifacts instanceof Set ? knownArtifacts : new Set(knownArtifacts || []);
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const say = typeof warn === 'function' ? warn : (line) => console.warn(line);
  return async function artifactRedirectWatcher(exec, result, next) {
    // 与 `interception.js` 同契约：签名是 (exec, result, next)；next 不是函数就降级为不干涉。
    if (typeof next !== 'function') return { kind: 'accept' };
    const downstream = await next();
    try {
      const name = String((exec && exec.name) || '');
      if (!SHELL_WRITE_TOOLS.has(name)) return downstream;
      const args = (exec && exec.arguments) || {};
      const command = String(args.command || args.cmd || args.script || '');
      if (!command) return downstream;
      const cwd = typeof cwdFor === 'function' ? cwdFor(exec) : '';
      if (!cwd) return downstream;
      const teamRoot = typeof teamRootFor === 'function' ? teamRootFor(cwd) : '';
      if (!teamRoot) return downstream;
      const hit = detectArtifactRedirect(command, { cwd, teamRoot, knownArtifacts: known });
      if (!hit) return downstream;
      try {
        say(`[expert-team] R1 绕过检测：${name} 写入 run 工件 ${hit.abs}（write/edit 门禁覆盖不到；仅留痕，不阻断）`);
      } catch { /* 打印失败也不能影响工具调用 */ }
      emit('artifact-redirect-bypass', { tool: name, runId: hit.runId, base: hit.base });
    } catch (e) {
      try { emit('artifact-redirect-watch-error', { error: String((e && e.message) || e) }); } catch { /* ignore */ }
    }
    return downstream;
  };
}
