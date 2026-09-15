/**
 * R1 工件归属的**唯一机读真源** + `tools/pre-execute` 硬门禁（2026-09-15）。
 *
 * ── R1 是什么 ───────────────────────────────────────────────────────────────
 * 协议（`skills/expert-team/SKILL.md` §2 R1，唯一权威表述）：**run 工件一律由「产出它的角色」
 * 自己 `write` 到 `<run-dir>/`**；角色只回 `path` + 摘要 + `verdict`；**lead 没有 `write`**，
 * 只读工件做门控与裁决。本文件把这条协议从"约定"升级为**可执行的门禁**。
 *
 * ── 门禁语义（为什么是"创建放行、覆写才拦"）────────────────────────────────
 * `SKILL.md` §3 要求**首个成员**按模板一次性把 13 份骨架落到 `team/<run-id>/` —— 其中大多数
 * **不属于它**。若门禁写成"角色 ≠ 负责人 ⇒ 拦"，会**直接打死建 run**。因此判据是：
 *   **文件不存在（创建）⇒ 放行；文件已存在且写者不是它的负责人 ⇒ deny。**
 * 这条判据只需一次存在性查询、**不读内容**，因此可以放在 `pre-execute`（写盘之前，
 * 真正拦得住）；而"内容级"的台账/边界校验依赖已落盘内容，继续留在 `post-execute`，
 * 两者分工、互不冲突。
 *
 * ── 表格怎么来的（逐条可核，不发明所有权）──────────────────────────────────
 * 真源两张表：
 *   - `SKILL.md` 的「角色 / 产出」表（角色 → 产出工件）
 *   - `references/WORKSPACE.md` 的「文件 / 维护者」表（工件 → 维护者）
 * 取值口径：
 *   - **真源有歧义/多负责人 ⇒ 取宽松**（例如 `PLAN.md` 是 pm 骨架 → architect 设计段 → dba 数据段
 *     ⇒ 列 3 个 owner）；宁可漏拦，不可误伤。
 *   - **`[]`（空数组）= 运行时专属 ⇒ 角色一律不得覆写**（`STATE.json` 唯一写者是运行时、
 *     `ROSTER.json` 由 /team 命令（宿主）建/更新）。
 *   - **不列入本表 = 不限制**（`TASK.md` / `任务看板.md` / `SUMMARY.md` / `RUN.log.md` / `RETRO.md`
 *     在真源里的措辞是"lead 口述 + **指派的有 write 成员**落盘"⇒ 任何角色都可能被指派，
 *     所以不设 owner）。
 *   - **表里没有的文件名 = 不限制**（角色自建的临时文件、run 内的子目录文件等）。
 *
 * ── 诚实边界（必须一并引用，别把它说成"不可能违反"）────────────────────────
 * 本门禁只覆盖 **`write` / `edit` 通道**。preset 里 `backend`/`frontend`/`researcher`/`qa`/
 * `dba`/`devops` **持有 `bash`**，理论上可用 `cat > SPEC.md` 绕过。**首版刻意不对 bash 参数做
 * 启发式检查**（易误伤，且 bash 的写目标可以是重定向/变量/子命令，静态判断不可靠）。
 * 因此对外表述应为：「`write`/`edit` 通道的硬门禁」。
 */

import { targetOf, runScopedTarget, TERMINAL_RUN_STATUSES } from './interception.js';
import { DEFAULT_ROLES } from './vocab.js';

/**
 * run 工件文件名 → 允许**覆写**它的角色（不含创建；创建一律放行）。
 * `[]` = 运行时专属，角色一律不得覆写。未列入的键 = 不限制。
 */
export const ARTIFACT_OWNERS = Object.freeze({
  // ── 单一负责人（SKILL.md「角色 / 产出」+ WORKSPACE.md「文件 / 维护者」一致）──
  'SPEC.md': Object.freeze(['pm']),
  'RESEARCH.md': Object.freeze(['researcher']),
  'UI.md': Object.freeze(['ui']),
  'REVIEW.md': Object.freeze(['reviewer']),
  'REVIEW-SPEC.md': Object.freeze(['reviewer']),
  'TEST.md': Object.freeze(['qa']),
  'DATA.md': Object.freeze(['dba']),
  'SECURITY.md': Object.freeze(['sec']),
  'RELEASE.md': Object.freeze(['devops']),
  'DOCS.md': Object.freeze(['docs']),
  // ── 多负责人（真源就是多段/多角色 ⇒ 取宽松）──
  // PLAN.md：pm 骨架 → architect 设计段 → dba 数据段（WORKSPACE.md 明写）
  'PLAN.md': Object.freeze(['pm', 'architect', 'dba']),
  // TASKS.json：pm 初稿 → architect 细化（lead 用 `/team task` 回写，不走 write 通道）
  'TASKS.json': Object.freeze(['pm', 'architect']),
  // ── 运行时专属：角色不得覆写 ──
  // STATE.json：唯一写者是运行时（`SKILL.md` §2 R1 明写）
  'STATE.json': Object.freeze([]),
  // ROSTER.json：/team 命令（宿主）建/更新，lead 无 write
  'ROSTER.json': Object.freeze([]),
});

/**
 * **认得出的角色**（用于区分"角色认不出 ⇒ 放行"与"角色认得但没权限 ⇒ 拦"）。
 * 真源是角色词汇表 `lib/vocab.js` 的 `DEFAULT_ROLES`（12 个固定角色）—— **不能**从上面的所有权表反推：
 * `backend`/`frontend` 只产出工作区代码、不拥有任何工件，但它们**是**可识别的角色，
 * 覆写别人的工件时必须能认出并拦下（冒烟测试抓到的反例：反推会让它们被当成"认不出"而放行）。
 */
export const KNOWN_ROLES = Object.freeze([...new Set([...DEFAULT_ROLES, ...Object.values(ARTIFACT_OWNERS).flat()])]);

/**
 * 查某个工件的负责人。
 * @param {string} base - run 目录内的文件名（如 `SPEC.md`）。
 * @returns {readonly string[] | null} 负责人数组；`null` = **不限制**（不在表里）。
 */
export function ownersOf(base) {
  const key = String(base || '');
  if (!Object.prototype.hasOwnProperty.call(ARTIFACT_OWNERS, key)) return null;
  return ARTIFACT_OWNERS[key];
}

/**
 * 角色名归一：成员表里允许带后缀（`frontend-F4`、`reviewer-R1`）⇒ 取基名再查表；
 * 认不出的角色**返回空串**（调用方据此 fail-open，而不是把它当成"没有权限"）。
 * @param {string} role - `STATE.members` 解出的角色串。
 * @returns {string} 归一后的角色（认不出则为空串）。
 */
export function normalizeOwnerRole(role) {
  const raw = String(role || '').trim();
  if (!raw) return '';
  if (KNOWN_ROLES.includes(raw)) return raw;
  const base = raw.includes('-') ? raw.split('-')[0] : raw;
  return KNOWN_ROLES.includes(base) ? base : '';
}

/**
 * 判定一次写入是否违反 R1 工件归属（纯函数，零 IO，可单测）。
 * @param {object} input
 * @param {string} input.role - 写者角色（**已归一**；空串 = 认不出）。
 * @param {string} input.base - 目标文件名。
 * @param {boolean} input.exists - 目标是否**已存在**。
 * @returns {string|null} 违规理由；合规返回 null。
 */
export function ownerViolation({ role, base, exists } = {}) {
  if (!exists) return null;             // 创建 ⇒ 放行（建 run 的骨架落盘依赖这条）
  const r = String(role || '');
  if (!r) return null;                  // 角色认不出 ⇒ 放行（fail-open，宁可漏拦）
  const owners = ownersOf(base);
  if (owners === null) return null;     // 不在表里 ⇒ 不限制
  if (owners.includes(r)) return null;  // 是负责人 ⇒ 放行
  const who = owners.length > 0 ? owners.join(' / ') : '运行时（唯一写者）';
  return `R1 工件归属：\`${base}\` 已存在，而角色 \`${r}\` 不是它的负责人（负责人：${who}）⇒ 按协议不得覆写。`
    + '请把结论（path + 摘要 + verdict）回给 lead，由负责角色落盘；创建工作目录/骨架不受此限制。';
}

/**
 * 创建 `tools/pre-execute` 监听器（**写盘之前**拦，因此真拦得住）。
 *
 * 纪律（与既有 `post-execute` 拦截器逐条一致）：
 *   - 监听器**绝不允许**成为工具调用的故障源：任何异常 ⇒ 放行 + 留痕；
 *   - 判定不出来（角色认不出 / 存在性查不到 / 路径不在 run 目录）⇒ **放行**；
 *   - 已终止的 run 放行（与 `interception.js` 同一理由：冻结的历史工件不该在写侧拦）；
 *   - 下游（`next()`）已给出 deny/ask 时不插嘴，尊重"最严格优先"。
 *
 * @param deps - 注入依赖：
 *   `cwdFor(exec) => string|null`、`teamRootFor(cwd) => string|null`、
 *   `statusFor(runId, cwd) => Promise<string>`、`roleFor(exec, runId, cwd) => Promise<string>`、
 *   `existsFor(abs) => Promise<boolean|undefined>`（undefined = 查不到 ⇒ 放行）、
 *   `onEvent(type, payload)`（可观测：让"门禁被行使/降级"看得见）。
 * @returns `(exec, next) => Promise<PreToolDecision>`
 */
export function createOwnershipGate(deps) {
  const {
    cwdFor = () => null,
    teamRootFor = () => null,
    statusFor = async () => '',
    roleFor = async () => '',
    existsFor = async () => undefined,
    onEvent = () => {},
  } = deps || {};

  const trace = (type, payload) => { try { onEvent(type, payload); } catch { /* 观测失败不影响工具 */ } };

  return async function ownershipGate(exec, next) {
    try {
      // ① 先让下游表态：它已 deny/ask 就不插嘴（宿主 waterfall 的最严格优先）。
      const downstream = typeof next === 'function' ? await next() : { kind: 'allow' };
      if (downstream && downstream.kind && downstream.kind !== 'allow') return downstream;

      // ② 只认 write/edit 的 file_path；其余工具（含 bash）**一律放行**（见文件头的诚实边界）。
      const raw = targetOf(exec);
      if (!raw) return { kind: 'allow' };

      // ③ 只认 `<teamRoot>/<runId>/<文件名>` 恰好两段（与 post-execute 同一作用域）。
      const cwd = cwdFor(exec);
      const teamRootAbs = teamRootFor(cwd);
      if (!cwd || !teamRootAbs) return { kind: 'allow' };
      const target = runScopedTarget(raw, teamRootAbs);
      if (!target || !target.base) return { kind: 'allow' };

      // ④ 终态 run 放行（冻结的历史工件）
      const status = String((await statusFor(target.runId, cwd)) || '');
      if (TERMINAL_RUN_STATUSES.has(status)) return { kind: 'allow' };

      // ⑤ 存在性：查不到（undefined）⇒ **放行 + 留痕**（门禁降级必须可见）
      const exists = await existsFor(target.abs);
      if (typeof exists !== 'boolean') {
        trace('ownership-gate-degraded', { runId: target.runId, base: target.base, abs: target.abs, why: 'existence-unknown' });
        return { kind: 'allow' };
      }

      // ⑥ 角色：认不出 ⇒ 放行（fail-open，`normalizeOwnerRole` 已把不认识的角色归一成空串）
      const role = normalizeOwnerRole(await roleFor(exec, target.runId, cwd));
      if (!role) {
        if (exists) trace('ownership-gate-degraded', { runId: target.runId, base: target.base, why: 'role-unknown' });
        return { kind: 'allow' };
      }

      // ⑦ 判定
      const reason = ownerViolation({ role, base: target.base, exists });
      if (reason) {
        trace('ownership-denied', { runId: target.runId, base: target.base, role, abs: target.abs });
        return { kind: 'deny', reason };
      }
      return { kind: 'allow' };
    } catch (e) {
      // **绝不允许**门禁成为工具故障源（真实事故：post-execute 签名写错曾让全工具瘫痪）
      trace('ownership-gate-error', { message: String((e && e.message) || e) });
      return { kind: 'allow' };
    }
  };
}
