// 零依赖测试 runner：**逐个文件跑、最后汇总**。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// 旧实现是 `package.json` 里一条 **`node X.test.mjs && node Y.test.mjs …` 的 `&&` 串联**（当时的套件清单与个数写死在那条脚本里；**现在的套件清单以 `package.json` 为准，本注释不再写死个数**）：
//   · **一红遮八十** —— 链上第一个失败的文件之后，所有文件的输出都不会出现（2026-09-15 排查一次
//     真机 CI 红时，"31 秒就失败"却看不到任何失败细节，就是因为这个）；`&&` 还会把逐条输出吞掉，
//     慢测试的进度也完全不可见。
//   · 失败定位要靠下载 job 日志、翻 `test.log` 尾部，救援成本高。
// 本 runner 保持**顺序不变**、**语义等价**（任一文件失败 ⇒ 整体非 0），但：
//   ① 逐个文件跑（`spawnSync`），**每个文件的输出实时透传**（CI 里行为与旧链一致，便于人读）；
//   ② 结束时**汇总一次**：文件数、总耗时、失败清单，以及每个失败文件的**最后 30 行**；
//   ③ **反空转**：清单为空、或清单里的文件不存在、或一个文件都没跑起来 ⇒ **直接判失败** ——
//      不允许出现"没跑任何测试却报绿"（本仓最讨厌的假绿）。
//
// 清单的**单一真源**：`package.json` 的 `scripts["test:files"]`（仍是同一串 `node X.test.mjs && …`，
// 只是不再被 `test:all` 直接执行）。`test:all` = `node scripts/run-tests.mjs`。
//
// 运行：npm run test:all

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const list = String(pkg.scripts?.['test:files'] || '');
const files = [...list.matchAll(/node\s+(\S+\.test\.mjs)/g)].map((m) => m[1]);

// ── 反空转：清单坏了必须**响**，不能静默"零测试通过" ──────────────────────────
if (files.length === 0) {
  console.error('✗ test:files 里没解析出任何测试文件 —— 拒绝以"零测试"报绿（检查 scripts["test:files"]）');
  process.exit(1);
}
const missing = files.filter((f) => !existsSync(join(pkgRoot, f)));
if (missing.length) {
  console.error(`✗ test:files 里有 ${missing.length} 个文件在磁盘上不存在：`);
  for (const m of missing) console.error('   · ' + m);
  process.exit(1);
}

console.log(`# 全套测试（${files.length} 个文件，零依赖、无需 install）\n`);

const t0 = Date.now();
const failures = [];

for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [f], { cwd: pkgRoot, encoding: 'utf8' });
  const ms = Date.now() - started;
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // 实时透传（与旧 `&&` 链的日志形态一致，便于人读 CI）
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const ok = r.status === 0;
  if (!ok) failures.push({ file: f, status: r.status, signal: r.signal, ms, tail: out.split('\n').filter((l) => l.trim() !== '').slice(-30) });
  console.log(`  ${ok ? '·' : '✗'} ${f} — ${(ms / 1000).toFixed(1)}s`);
}

const total = ((Date.now() - t0) / 1000).toFixed(1);

// ── 汇总（本 runner 存在的意义所在：**一次报全**） ────────────────────────────
console.log(`\n# 汇总：${files.length} 个文件，${failures.length} 个失败，总耗时 ${total}s`);
if (failures.length === 0) {
  console.log('✓ 全部通过');
  process.exit(0);
}
for (const f of failures) {
  console.error(`\n✗ 失败文件：${f.file}（exit=${f.status}${f.signal ? ', signal=' + f.signal : ''}, ${(f.ms / 1000).toFixed(1)}s）`);
  console.error('  最后 30 行输出：');
  for (const l of f.tail) console.error('  | ' + l);
}
console.error(`\n✗ ${failures.length} 个测试文件失败（共 ${files.length} 个）：${failures.map((f) => f.file).join(', ')}`);
process.exit(1);
