// run 的**采集层**（B 线 10b 第二刀）：只做 IO，不做判定。
//
// `aggregate()` 原本把六件事压在一个函数里（枚举 / 读取 / 解析 / 计算 / 渲染 / 写盘）。
// 渲染已切到 `render.js`；这里把**枚举与读取**切出来，让「怎么读盘」与「读出来怎么算」分开 ——
// 值在于 ① 采集的边界（什么算 run、缺文件怎么办）可以单测；② 计算主体将来搬走时，
// 依赖面只剩一个 `readRunInputs` 返回值，而不是散落各处的 `readFile`。
//
// 设计：**逐 run 读取**（不是"一次读全部"）—— 保持与旧实现相同的内存行为：
// 旧实现每轮读一个 run 就丢掉；收集成一个大数组会让长日志全留在内存里。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 判定「真 run 目录」的标记文件（含任一即可）。 */
export const RUN_MARKER_FILES = ['STATE.json', 'TASK.md', 'RUN.log.md'];

/** 读 JSON，失败返回 null（不抛）。 */
async function readJsonSafe(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

/**
 * 列出 `<root>` 下的**真 run** 目录名。
 *
 * 为什么不能直接 `readdir` 全收：`team/` 里还躺着 METRICS.md / LEARNINGS.md / REPOWIKI.md /
 * CODEINDEX.json 这些**文件**，以及可能的空目录。旧实现把它们也算进「总 run 数」，
 * 于是用户看到「总 run 数：8」而真实只有 2（D4 实测）。
 *
 * @param root - `<cwd>/team` 的绝对路径。
 * @returns `{ ok, names, skipped }`；`ok:false` 表示 root 读不了（调用方按「零 run」处理）。
 */
export async function listRunNames(root) {
  const names = [];
  let skipped = 0;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) { skipped += 1; continue; }
      const dir = join(root, ent.name);
      let isRun = false;
      for (const marker of RUN_MARKER_FILES) {
        if (await stat(join(dir, marker)).then(() => true).catch(() => false)) { isRun = true; break; }
      }
      if (isRun) names.push(ent.name); else skipped += 1;
    }
    names.sort();
  } catch {
    return { ok: false, names: [], skipped: 0 };
  }
  return { ok: true, names, skipped };
}

/**
 * 读一个 run 的四份输入（缺哪份就返回该份的「空值」，**不抛**）。
 * @param root - `<cwd>/team` 的绝对路径。
 * @param name - run 目录名。
 * @returns `{ dir, state, log, tasksDoc, rosterDoc }`
 *   —— `state`/`tasksDoc`/`rosterDoc` 读不到或不是合法 JSON 时为 `null`；`log` 读不到时为 `''`。
 */
export async function readRunInputs(root, name) {
  const dir = join(root, name);
  let state = null;
  let log = '';
  let tasksDoc = null;
  try { state = JSON.parse(await readFile(join(dir, 'STATE.json'), 'utf8')); } catch { /* 缺件按 null */ }
  try { log = await readFile(join(dir, 'RUN.log.md'), 'utf8'); } catch { /* 缺件按空串 */ }
  try { tasksDoc = JSON.parse(await readFile(join(dir, 'TASKS.json'), 'utf8')); } catch { /* 缺件按 null */ }
  const rosterDoc = await readJsonSafe(join(dir, 'ROSTER.json'));
  return { dir, state, log, tasksDoc, rosterDoc };
}
