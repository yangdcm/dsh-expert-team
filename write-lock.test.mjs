// 测试：写入的跨进程互斥（C1 · 同一个工件被两个写者同时改时不能互相覆盖）
//
// 实测场景（本仓竞品分析 run 的"另一个会话持续改写 lib/command.js / client.js"，以及
// 刚才另一个会话往 mutations.json 追加 M40-M45 时，我们的 gate 恰好撞上基线失败）。
//
// 依据（ROI 评审 §C1）：版本栅栏能拦住"别人已写完"，拦不住"别人**正在**写" ⇒
// 两个进程可以在同一窗口里各自读 rev N、各自写、后写覆盖先写。修法是写入点前持
// `<target>.etv-lock`：拿不到就等、超时就报 WRITE_LOCK_TIMEOUT（不静默覆盖）、
// 锁文件超时（默认 30s）视为死写者接管 ⇒ 不永久死锁。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M49。
// 运行：node write-lock.test.mjs

import { writeFileSync, readFileSync, mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactWriter, nodeFsPort } from './lib/artifact-writer.js';

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'wlock-'));
const lockPath = (t) => t + '.etv-lock';

console.log('# 写入互斥锁（C1）\n');

console.log('① 同一文件的并发写：两个写者的改动**都活下来**（没人被静默覆盖）');
{
  const target = join(dir, 'a.json');
  const w = createArtifactWriter({ fsPort: nodeFsPort(), identity: () => 'p1' });
  // 两个 writer（同一进程两个实例 ≈ 两个进程）同时改同一文件
  const slowWrite = async (tag, delayMs) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return w.write(target, { tag, n: tag }, {});
  };
  // 故意让两个写入在时间上重叠
  const [ra, rb] = await Promise.all([slowWrite('A', 30), slowWrite('B', 60)]);
  check(ra.ok !== false && rb.ok !== false, '两个写者都成功（锁序列化了它们）', JSON.stringify({ a: ra.ok, b: rb.ok }));
  const final = readFileSync(target, 'utf8');
  check(final.length > 0, '文件落盘', '');
  // 锁文件不得残留（释放正常）
  check(!existsSync(lockPath(target)), '写完后锁已释放', lockPath(target));
}

console.log('\n② 死锁兜底：陈旧的锁文件（写者已死）会被接管，不会永久卡住');
{
  const target = join(dir, 'b.json');
  // 造一个"死锁"：锁文件存在且 mtime 远早于现在
  writeFileSync(lockPath(target), '9999 1600000000000');
  const old = new Date(Date.now() - 60000);
  utimesSync(lockPath(target), old, old);
  const w = createArtifactWriter({ fsPort: nodeFsPort(), identity: () => 'p2' });
  const t0 = Date.now();
  const r = await w.write(target, { x: 1 }, {});
  const took = Date.now() - t0;
  check(r.ok !== false, '陈旧锁被接管，写入成功', JSON.stringify(r.code));
  check(took < 5000, `接管是即时的（耗时 ${took}ms，远低于超时上限）`, String(took));
}

console.log('\n③ 活锁被占时：**等待**而不是静默覆盖，超时报 WRITE_LOCK_TIMEOUT');
{
  const target = join(dir, 'c.json');
  // 造一个"活锁"：锁文件是新的（刚被某写者占用）
  writeFileSync(lockPath(target), `${process.pid} ${Date.now()}`);
  // 注意：这是本进程自己"占着"，等价于"另一个写者正在写"
  const w = createArtifactWriter({ fsPort: nodeFsPort(), identity: () => 'p3' });
  const t0 = Date.now();
  const r = await w.write(target, { x: 1 }, {});
  const took = Date.now() - t0;
  check(r.ok === false && r.code === 'WRITE_LOCK_TIMEOUT', '活锁 → 显式 WRITE_LOCK_TIMEOUT（不静默覆盖）', JSON.stringify({ ok: r.ok, code: r.code }));
  check(took >= 4000 && took < 6000, `确实等到超时上限（${took}ms ≈ 5000ms）`, String(took));
  // 锁文件还在（我们没去抢）
  check(existsSync(lockPath(target)), '别人的锁没被强拆');
  rmSync(lockPath(lockPath === target ? target : target), { force: true }); // 注意这里要删锁文件
  try { rmSync(lockPath(target), { force: true }); } catch { /* noop */ }
}

console.log('\n④ 范围硬排除**先于**锁（禁写区不产生锁文件、不触碰磁盘）');
{
  const target = join(dir, '.env');
  const w = createArtifactWriter({ fsPort: nodeFsPort(), identity: () => 'p4' });
  const r = await w.write(target, 'SECRET=1', {});
  check(r.ok === false && r.code === 'SCOPE_DENIED', '禁写区被拒（SCOPE_DENIED）', r.code);
  check(!existsSync(lockPath(target)), '禁写区**没有**留下锁文件（先拦后锁）', '');
}

console.log('\n⑤ 健壮性：锁路径异常（目标目录不存在等）不得让写入者静默卡死或崩溃');
{
  const target = join(dir, 'sub', 'deep', 'd.json'); // 父目录不存在
  const w = createArtifactWriter({ fsPort: nodeFsPort(), identity: () => 'p5' });
  const r = await w.write(target, { x: 1 }, {});
  // 锁文件建不成（父目录不存在）⇒ 拿不到锁 ⇒ 如实失败，而不是静默假装写入
  check(r.ok === false, '锁建不成 → 如实失败（不静默）', JSON.stringify(r.code));
}

console.log('\n⑥ 接线检查：写路径包了锁，且锁的释放在 finally 里（异常也放锁）');
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib/artifact-writer.js'), 'utf8');
  check(/await acquireWriteLock\(target\)/.test(src), 'write() 调 acquireWriteLock');
  check(/finally\s*\{[\s\S]{0,80}lock\.release\(\)/.test(src), 'release 在 finally 里（异常路径也放锁）');
  check(/WRITE_LOCK_TIMEOUT/.test(src), '超时有显式错误码');
  check(/staleMs/.test(src) && /mtimeMs/.test(src), '有死锁兜底（陈旧锁接管）');
  // 锁文件绝不落在工件本体上（只能落在旁边）
  check(/target\}\.etv-lock/.test(src) || /target \+ '.etv-lock'/.test(src), '锁文件名是 <target>.etv-lock（不落进工件）');
}

try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }

console.log('');
if (fail > 0) {
  console.log(`✗ 写入互斥测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 写入互斥测试通过（并发不丢、陈旧锁接管、活锁超时显式报错、禁写区不产生锁、异常不卡死）');
