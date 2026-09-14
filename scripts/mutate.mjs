#!/usr/bin/env node
// 变异运行器（批 1 · N-7）：自动验证「测试是否真的能失败」
//
// 为什么需要它：本 run 的核心纪律是「每项修复必须附变异证据（旧代码上失败、新代码上通过）」。
// 前几轮这份证据是**手工**产出的（复制目录 → 注入缺陷 → 跑测试 → 观察是否红），
// 容易漏、不可复跑、也无法在 CI 里守门。本脚本把它变成**一键可复跑的自动化验证**。
//
// 工作方式（每个变异体）：
//   1. 把整包复制到临时目录（含 lib/skills/presets/client.js/测试/脚本）
//   2. **基线**：在未变异的副本上跑目标测试 → 必须**通过**（否则说明测试本来就坏）
//   3. **变异**：对副本做精确字符串替换（要求 `find` 恰好命中 1 次，否则报错而非静默）
//   4. **判定**：再跑目标测试 → 必须**失败**（失败 = 测试抓住了这个缺陷）
//
// 退出码：0 = 全部变异体都被抓住且基线全绿；1 = 有变异体没被抓住（测试存在盲区）或基线失败。
//
// 用法：
//   node scripts/mutate.mjs                 # 跑全部变异体
//   node scripts/mutate.mjs --only M1,M2    # 只跑指定 id（前缀匹配）
//   node scripts/mutate.mjs --json          # 机器可读
//   node scripts/mutate.mjs --keep          # 保留临时目录（排障）

import { readFile, writeFile, mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const CATALOG = join(PKG_ROOT, 'regression.fixtures', 'mutations.json');

const SKIP = new Set(['node_modules', '.git', '.tmp-mut', '.tmp-mA', '.tmp-mB', '.tmp-sync-fixture', 'browser-screenshots']);

/** 复制整包到 dest（跳过噪音目录）。 */
async function copyPkg(dest) {
  await cp(PKG_ROOT, dest, {
    recursive: true,
    filter: (src) => {
      const base = src.split('/').pop();
      if (SKIP.has(base)) return false;
      if (/^\.tmp-/.test(base)) return false;
      return true;
    },
  });
}

/** 在 dir 里跑 `node <script>`；返回 {code, out}。 */
async function runScript(dir, script) {
  try {
    const { stdout } = await run('node', [script], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.code ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

/** 应用一个精确字符串替换；命中次数必须为 1。 */
async function applyEdit(dir, edit) {
  const p = join(dir, edit.file);
  const before = await readFile(p, 'utf8');
  const hits = before.split(edit.find).length - 1;
  if (hits !== 1) {
    throw new Error(`变异锚点在 ${edit.file} 中命中 ${hits} 次（要求恰好 1 次）：${JSON.stringify(edit.find.slice(0, 60))}`);
  }
  await writeFile(p, before.replace(edit.find, edit.replace));
  return hits;
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const keep = argv.includes('--keep');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 && argv[onlyIdx + 1] ? argv[onlyIdx + 1].split(',').map((s) => s.trim()) : null;

  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  let entries = catalog.mutations || [];
  if (only) entries = entries.filter((m) => only.some((o) => m.id.startsWith(o)));
  if (entries.length === 0) {
    console.error('✗ 没有匹配的变异体');
    process.exit(2);
  }

  const results = [];
  for (const m of entries) {
    const row = { id: m.id, title: m.title, test: m.test, baseline: null, mutant: null, caught: null, error: null };
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mut-'));
    try {
      const pkgDir = join(dir, 'pkg');
      await copyPkg(pkgDir);

      // 目标测试是否存在于包内
      const present = (await readdir(pkgDir)).includes(m.test);
      if (!present) {
        row.error = `目标测试不存在：${m.test}`;
        results.push(row);
        continue;
      }

      // ① 基线：未变异必须通过
      const base = await runScript(pkgDir, m.test);
      row.baseline = base.code;
      if (base.code !== 0) {
        row.error = '基线未通过 —— 变异证据无意义（测试本来就坏）';
        results.push(row);
        continue;
      }

      // ② 注入变异
      for (const edit of m.edits) await applyEdit(pkgDir, edit);

      // ③ 变异后必须失败
      const mut = await runScript(pkgDir, m.test);
      row.mutant = mut.code;
      row.caught = mut.code !== 0;
      if (!row.caught) row.error = '变异体未被抓住（测试存在盲区）';
    } catch (e) {
      row.error = String(e && e.message ? e.message : e);
    } finally {
      if (!keep) await rm(dir, { recursive: true, force: true });
    }
    results.push(row);
  }

  const caught = results.filter((r) => r.caught === true).length;
  const bad = results.filter((r) => r.caught !== true).length;

  if (asJson) {
    console.log(JSON.stringify({ total: results.length, caught, bad, results }, null, 2));
  } else {
    console.log('# 变异验证（自动化）');
    console.log(`目录：${CATALOG}`);
    console.log('');
    console.log('| 变异体 | 目标测试 | 基线 | 变异体 | 判定 |');
    console.log('|---|---|---|---|---|');
    for (const r of results) {
      const verdict = r.caught === true ? '✅ 被抓住' : '❌ **未抓住**';
      console.log(`| ${r.id} | ${r.test} | ${r.baseline === 0 ? 'pass' : (r.baseline ?? '-')} | ${r.mutant ?? '-'} | ${verdict} |`);
    }
    const errs = results.filter((r) => r.error);
    if (errs.length > 0) {
      console.log('');
      console.log('问题明细：');
      for (const r of errs) console.log(`  - [${r.id}] ${r.error}`);
    }
    console.log('');
    console.log(`合计：${results.length} 个变异体，**${caught} 个被抓住**，${bad} 个未被抓住。`);
    console.log('');
    console.log(bad === 0
      ? '✔ 变异验证通过：所有变异体都被测试抓住（即：这些测试真的能失败）'
      : `✗ 变异验证失败：${bad} 个变异体没被抓住 —— 对应测试存在盲区`);
  }

  process.exit(bad === 0 ? 0 : 1);
}

main();
