/**
 * **宿主状态文件**的单一受控入口（原子替换）—— 写绕过棘轮的**第二个合法写者**。
 *
 * ── 它为什么存在（先有证据，再谈豁免）──────────────────────────────────────────
 * `scripts/check-write-bypass.mjs` 数的是 `lib/` 与 `client.js` 里的 `writeFile` /
 * `appendFile` / `rename`，纪律是"要么走受控入口，要么进基线"。本包有**两类**受控入口，
 * 因为要写的是两类完全不同的东西：
 *
 *   ① **工作区工件**（用户工作区里的 `team/<run-id>/...`）⇒ `lib/artifact-writer.js`。
 *      它带来版本栅栏 / 陈旧重试 / 范围硬排除 / revision 记账 —— 那些保证对"工件"才有意义。
 *   ② **宿主状态文件**（**工作区之外**，例如 `$DSH_HOME/expert-team/runs-index.json`、
 *      `~/.hindsight/coding-agent.json`）⇒ 本模块。它们是本机运行时状态/配置，不是交付物，
 *      没有"两个人同时编辑同一份工件"的语义，也不该被工作区范围硬排除管辖。
 *
 * ── 为什么不能用宿主现成的栅栏（`ctx.fs`）—— 实测证据，不是猜测 ──────────────────
 * `lib/artifact-writer.js` 的注释说宿主**有**文件级 CAS（`@deepseek-ai/dsh-fs` 的
 * `writeText(target, content, expected)`）。那把栅栏**在默认组合里够不到工作区之外**：
 *   · `dsh-base` 的 `cordis.patch.yml` 挂的 fs 后端是 `@deepseek-ai/dsh-fs-sandbox`
 *     （行 `- id: fs-sandbox / name: '@deepseek-ai/dsh-fs-sandbox'`），不是 `fs-local`；
 *   · 同一份 patch 里 `sandbox-policy` 的 `mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`、
 *     `workspaceRoot = process.cwd()`；
 *   · `dsh-fs-sandbox` 的 README 写死：`workspace-write` 下"allows a mutation only when the target
 *     canonicalizes under the workspace root or a platform temp area"，越界抛结构化
 *     `FS_SANDBOX_DENIED`（源码 `lib/index.js` 的 `cannot write "...": file access denied under
 *     workspace-write mode`）。
 *   ⇒ 拿 `ctx.fs` 写 `$DSH_HOME/...` 在默认组合下**必被拒**。宿主自己也走 `node:fs` 写这些路径
 *     （`dsh-base` 的 `dshHomePath('sessions')` / `dshHomePath('storages')` 就是宿主包内的直写）。
 *   顺带核实过：宿主的 `@deepseek-ai/dsh-atomic-write`（它 README 的例子恰好就是写 `~/.dsh/settings.yaml`）
 *   在插件目录下 `import` **解析不到**（`ERR_MODULE_NOT_FOUND`），且本包承诺 `dependencies: {}` —— 所以
 *   不能借它，只能把同样的语义在本模块里实现。
 *
 * ── 所以本模块必须自己做到的（与 `dsh-atomic-write` 同口径的那几条）────────────────
 *   · **同目录**临时文件（`rename` 只在同一文件系统内原子；放 `/tmp` 再 rename 会退化成复制，
 *     中途断电就是半个文件）；
 *   · 写入后 `fsync` **再**换名 ⇒ 读者只会看到旧的完整内容或新的完整内容；
 *   · 权限由**新建 inode**时就指定（`open(tmp, 'w', mode)`）并用 `chmod` 兜住 umask ⇒ 不依赖
 *     目标文件原有的权限，也不会把权限放宽；
 *   · 失败路径**清掉临时文件**，绝不留下半成品，也绝不破坏原文件；
 *   · 唯一临时名（pid + 时间 + 序号）⇒ 并发/重入不会互踩同一个临时文件。
 *
 * ⚠️ 与 `lib/artifact-writer.js` 的分工是**硬的**：工作区工件**不要**走这里（那会绕过工件归属门禁
 * 与范围硬排除），宿主状态文件**不要**走 artifact-writer（那会套上不相干的语义）。两者都不允许
 * 在别处再抄一份"临时文件 + rename"。
 */

import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** 宿主状态文件的默认权限：只给属主读写（状态/配置里可能带 token）。 */
export const HOST_STATE_FILE_MODE = 0o600;
/** 状态目录的默认权限（**仅在该目录不存在而由我们创建时**生效）。 */
export const HOST_STATE_DIR_MODE = 0o700;

/** 临时文件序号：同一毫秒内的多次写入也不会撞名。 */
let TMP_SEQ = 0;

/**
 * 原子替换一个宿主状态文件。
 *
 * @param {string} path - 目标路径（绝对或相对调用方 cwd 均可）。
 * @param {string} text - 完整内容（会被 `String()` 一次，调用方负责自己序列化好）。
 * @param {{mode?: number, dirMode?: number}} [options]
 *   `mode` 默认 `0600`；`dirMode` 默认 `0700` 且只影响"目录不存在、需要创建"这一种情况
 *   （已存在的目录权限**不会被改**，我们不越权动别人的目录）。
 * @returns {Promise<{ok: true, path: string, mode: number, dirCreated: boolean, bytes: number}>}
 * @throws 任何 IO 失败都**原样上抛**（临时文件已清理、原文件未动）—— 是否降级由调用方决定。
 */
export async function writeHostStateFileAtomic(path, text, options = {}) {
  const target = String(path == null ? '' : path);
  if (target === '') throw new Error('writeHostStateFileAtomic: 需要目标路径');
  const mode = Number.isInteger(options && options.mode) ? options.mode : HOST_STATE_FILE_MODE;
  const dirMode = Number.isInteger(options && options.dirMode) ? options.dirMode : HOST_STATE_DIR_MODE;
  const body = String(text == null ? '' : text);

  const dir = dirname(target);
  const dirCreated = await ensureDir(dir, dirMode);

  TMP_SEQ += 1;
  // 临时名以 `.` 开头：即使残留（进程被 SIGKILL）也不会被当成正常状态文件读走。
  const tmp = join(dir, `.${basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}-${TMP_SEQ}`);
  let fh = null;
  try {
    fh = await open(tmp, 'w', mode);          // 权限在**新建 inode**时就指定
    await fh.writeFile(body, 'utf8');
    await fh.sync();                          // 内容先真正落盘，再换名
    await fh.close();
    fh = null;
    await chmod(tmp, mode);                   // umask 不再有机会削权限
    await rename(tmp, target);                // 同目录 rename ⇒ 原子替换
  } catch (e) {
    if (fh) { try { await fh.close(); } catch { /* 已在错误路径上，关不掉也不掩盖原错误 */ } }
    try { await unlink(tmp); } catch { /* 临时文件可能压根没建起来 */ }
    throw e;
  }

  // 目录项 fsync（best-effort）：个别平台/文件系统不支持，失败不影响 rename 的原子性。
  try {
    const dh = await open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* 平台不支持目录 fsync */ }

  return { ok: true, path: target, mode, dirCreated, bytes: Buffer.byteLength(body, 'utf8') };
}

/**
 * 确保目录存在；返回**是否由本次调用创建**（已存在 ⇒ `false`，且**不动它的权限**）。
 *
 * ⚠️ 为什么不能用 `mkdir(recursive:true)` 的返回值糊过去：目录已存在时 recursive 模式**不抛 EEXIST**，
 * 所以"没抛错"根本区分不出"我建的"和"本来就有" —— 那样 `dirCreated` 就是一句假话。这里先 `stat`
 * 判存在性，**拿不到结论就如实上抛**（绝不猜）。
 * @param {string} dir
 * @param {number} dirMode
 * @returns {Promise<boolean>} true = 由本次创建（并已按 dirMode 建好）
 */
async function ensureDir(dir, dirMode) {
  let existed = false;
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) {
      // 路径被占成了文件/符号链接指向非目录 ⇒ **不是**"已存在"，如实上抛（调用方会看到 EEXIST/ENOTDIR
      // 之外的明确原因，而不是一个"成功"）。
      const err = new Error(`宿主状态目录被占用且不是目录：${dir}`);
      err.code = 'ENOTDIR';
      throw err;
    }
    existed = true;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;   // 只有 ENOENT 才意味着"确实不存在"
  }
  if (existed) return false;
  await mkdir(dir, { recursive: true, mode: dirMode });
  return true;
}
