#!/usr/bin/env node
// 写入绕过棘轮门禁（批 2-1 配套）
//
// 为什么需要它：`lib/artifact-writer.js` 是工件写入的**单一受控入口**（带版本栅栏/陈旧重试/
// 范围硬排除/revision 记账），但历史上有 30+ 处 `node:fs` 直写**绕过了宿主现成的栅栏**（`dsh-fs`）。
// 一次性改完 32 处风险大；正确做法是**棘轮**：
//   · 允许存量存在（记基线），但**禁止新增**绕过；
//   · 每迁移一处就下调基线，数字只能降不能升。
// 没有这道门禁，"单一受控入口"就只是建议，下一次改动仍会顺手加一处直写。
//
// 用法：
//   node scripts/check-write-bypass.mjs            # 校验（超过基线即失败）
//   node scripts/check-write-bypass.mjs --json
//   node scripts/check-write-bypass.mjs --update   # 迁移后下调基线（只允许降低）
//
// 退出码：0 = 未超过基线；1 = 新增了绕过（或 --update 试图抬高基线）；2 = 用法/环境错误
//
// 基线缺失/损坏 ⇒ **基线按 0（fail-closed）**：这是"删掉基线文件就悄悄关掉棘轮"的口子，
// 与 `check-evidence.mjs` 的弱证据棘轮同口径。基线路径可用 `DSH_WRITE_BYPASS_BASELINE`
// 覆写（与 `DSH_EVIDENCE_FRAGMENT_BASELINE` 同一惯例），便于自动化验证 fail-closed 行为。

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const BASELINE_FILE = process.env.DSH_WRITE_BYPASS_BASELINE
  || join(PKG_ROOT, 'regression.fixtures', 'write-bypass-baseline.json');

/** 统计范围：真正会写工件的模块（排除测试与脚本自身）。 */
const TARGETS = ['lib', 'client.js'];
/** 计入绕过的调用（直写文件系统的 API）。 */
const BYPASS_PATTERNS = [
  { name: 'writeFile', re: /\bwriteFile\s*\(/g },
  { name: 'appendFile', re: /\bappendFile\s*\(/g },
  { name: 'rename', re: /\brename\s*\(/g },
];
/**
 * **受控入口**自身的文件不计入 —— 规则同一条：这些文件就是"合法写者"，棘轮数的是"绕过受控入口
 * 的直写"，不是"受控入口内部的直写"（否则受控入口自己也无法存在）。当前恰好两个，对应两类不同的
 * 被写对象，**不允许扩张成第三个**（`write-bypass-ratchet.test.mjs` 有一条同源锁盯着这份清单：
 * 谁想往这里加文件，就必须同时改那条断言 ⇒ 豁免不可能静默扩张）：
 *   · `lib/artifact-writer.js` —— **工作区工件**的单一入口（版本栅栏 / 陈旧重试 / 范围硬排除 / revision）；
 *   · `lib/host-state-file.js` —— **宿主状态文件**（工作区之外，如 `$DSH_HOME/...`、`~/.hindsight/...`）
 *     的单一入口。为什么这类写入不能走宿主现成的 `ctx.fs`：默认组合挂的是 `dsh-fs-sandbox` +
 *     `workspace-write`，越界抛 `FS_SANDBOX_DENIED`（证据写在 `lib/host-state-file.js` 文件头）。
 */
const EXEMPT = new Set([
  'lib/artifact-writer.js',
  'lib/host-state-file.js',
]);

async function collectFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await collectFiles(p, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

async function scan() {
  const files = [];
  for (const t of TARGETS) {
    const p = join(PKG_ROOT, t);
    if (t.endsWith('.js')) files.push(p);
    else await collectFiles(p, files);
  }
  const perFile = {};
  let total = 0;
  for (const f of files) {
    const rel = relative(PKG_ROOT, f);
    if (EXEMPT.has(rel)) continue;
    const src = await readFile(f, 'utf8');
    // 去掉注释再做统计，避免注释里的示例被计入
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    let n = 0;
    for (const { re } of BYPASS_PATTERNS) {
      const m = code.match(new RegExp(re.source, 'g'));
      if (m) n += m.length;
    }
    if (n > 0) perFile[rel] = n;
    total += n;
  }
  return { total, perFile };
}

async function loadBaseline() {
  try {
    return JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const update = argv.includes('--update');

  const { total, perFile } = await scan();
  const baseline = await loadBaseline();

  if (update) {
    if (baseline && typeof baseline.total === 'number' && total > baseline.total) {
      console.error(`✗ 拒绝抬高基线：当前 ${total} > 基线 ${baseline.total}。棘轮只能降低 —— 新增的绕过必须先迁到 lib/artifact-writer.js。`);
      process.exit(1);
    }
    await writeFile(BASELINE_FILE, JSON.stringify({
      $comment: '直写绕过棘轮基线（批 2-1）。数字只能降不能升：迁移一处就 --update 下调一次。',
      total,
      perFile,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n');
    console.log(`✔ 基线已更新为 ${total}（此前 ${baseline ? baseline.total : '无'}）`);
    process.exit(0);
  }

  // 基线缺失/损坏 ⇒ 按 0（fail-closed）。**不能**退化成 `base = total`：那等于
  // "删掉基线文件就把棘轮关掉"，而这正是本门禁唯一要防的动作（历史：`gate:evidence`
  // 的棘轮就是按 0 fail-closed 的，两处口径必须一致）。
  const base = baseline && typeof baseline.total === 'number' ? baseline.total : 0;
  const delta = total - base;

  if (asJson) {
    console.log(JSON.stringify({ total, baseline: base, baselinePresent: !!(baseline && typeof baseline.total === 'number'), delta, perFile, baselineFile: BASELINE_FILE }, null, 2));
  } else {
    console.log('# 写入绕过棘轮');
    console.log(`统计范围：${TARGETS.join(', ')}（排除受控入口 ${[...EXEMPT].join(', ')}）`);
    console.log('');
    console.log(`当前直写调用：**${total}** 处　基线：**${base}**　差值：**${delta > 0 ? '+' : ''}${delta}**`);
    console.log('');
    if (Object.keys(perFile).length) {
      console.log('分布：');
      for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) {
        console.log(`  - ${f}: ${n}`);
      }
      console.log('');
    }
    if (!baseline) {
      console.log(`⚠ 基线文件缺失/损坏（${BASELINE_FILE}）⇒ **基线按 0（fail-closed）**，任何一处直写都会失败。`);
      console.log('  首次建立或重建基线：node scripts/check-write-bypass.mjs --update');
      console.log('');
    }
    if (delta > 0) {
      console.log(`✗ 新增了 ${delta} 处直写绕过 —— 请改走 lib/artifact-writer.js（受控入口：版本栅栏+陈旧重试+范围硬排除+revision）`);
    } else if (delta < 0) {
      console.log(`✔ 已减少 ${-delta} 处绕过（迁移有进展）。建议：node scripts/check-write-bypass.mjs --update 下调基线。`);
    } else {
      console.log('✔ 未新增绕过（棘轮保持）。');
    }
  }

  process.exit(delta > 0 ? 1 : 0);
}

main();
