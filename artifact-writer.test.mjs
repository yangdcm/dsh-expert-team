// 测试：受控写入口的四条硬性质（批 2-1 载体）
//
// 覆盖：
//   ① 范围硬排除（L2-3）：禁写区**拒绝且不落盘**（不是"仅告警"）
//   ② 版本栅栏：并发写者失配时报 FS_STALE_VERSION，**不静默覆盖**
//   ③ 陈旧重试：失配后**重读→重基线→重试一次**能成功（否则加栅栏只是把静默丢更新换成用户可见失败=降级）
//   ④ revision 记账：对象写入自增；调用方声明的 expectedRevision 与磁盘不符时**拒绝**（不覆盖）
//
// 变异验证见 `regression.fixtures/mutations.json` 的 M6（关掉范围检查 → 本测试必须红）。
//
// 运行：node artifact-writer.test.mjs

import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactWriter, nodeFsPort, scopeViolation, readRevision, DEFAULT_EXCLUSIONS } from './lib/artifact-writer.js';

const here = dirname(fileURLToPath(import.meta.url));

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const root = await mkdtemp(join(tmpdir(), 'dsh-et-aw-'));
const events = [];
const writer = createArtifactWriter({ fsPort: nodeFsPort(), onEvent: (e) => events.push(e) });

console.log('# 受控写入口（artifact-writer）\n');

console.log('① 范围硬排除（L2-3）：禁写区拒绝且不落盘');
check(!!scopeViolation('/proj/.env'), '识别 .env', String(scopeViolation('/proj/.env')));
check(!!scopeViolation('/proj/.git/config'), '识别 .git/');
check(!!scopeViolation('/proj/secrets/token.json'), '识别 secrets/');
check(!scopeViolation('/proj/team/run/STATE.json'), '正常工件路径不误伤');
const envPath = join(root, '.env');
const rEnv = await writer.write(envPath, 'SECRET=1\n');
check(rEnv.ok === false && rEnv.code === 'SCOPE_DENIED', '写 .env → SCOPE_DENIED', `code=${rEnv.code}`);
check(!(await exists(envPath)), '**文件确实没有被创建**（硬拒绝，不只是返回错误）');
check(events.some((e) => e.type === 'scope-denied'), '留下 scope-denied 事件（可审计）');
const gitPath = join(root, '.git', 'config');
const rGit = await writer.write(gitPath, 'x');
check(rGit.ok === false && rGit.code === 'SCOPE_DENIED', '写 .git/config → SCOPE_DENIED');

console.log('\n② 版本栅栏：并发写者不得静默覆盖');
const p2 = join(root, 'STATE.json');
// 先建一个基线
await writer.write(p2, { phase: 'clarify' });
const before = JSON.parse(await readFile(p2, 'utf8'));
check(before.revision === 1, '首次对象写入 revision = 1', `revision=${before.revision}`);
// 模拟"另一个写者在我 statVersion 之后、writeText 之前改了文件"
const port = nodeFsPort();
const racy = createArtifactWriter({
  fsPort: {
    ...port,
    async statVersion(p) {
      const v = await port.statVersion(p);
      // 注入竞态：读取版本后立刻由"别人"改写文件
      await writeFile(p, JSON.stringify({ revision: 99, hijacked: true }, null, 2) + '\n');
      return v; // 返回**过期的**版本 → 触发 FS_STALE_VERSION
    },
  },
});
const rRace = await racy.write(p2, { phase: 'design' });
check(rRace.ok === false, '版本失配 → 写入失败（不覆盖）', `code=${rRace.code} attempts=${rRace.attempts}`);
const after = JSON.parse(await readFile(p2, 'utf8'));
check(after.hijacked === true && after.phase === undefined, '**劫持者的内容没有被覆盖**（证明没有静默覆盖）');

console.log('\n③ 陈旧重试：重读→重基线→重试一次应当成功');
const p3 = join(root, 'RETRY.json');
await writer.write(p3, { n: 1 });
let firstCall = true;
const retryPort = {
  ...port,
  async statVersion(p) {
    const v = await port.statVersion(p);
    if (firstCall) {
      firstCall = false;
      // 第一次读取版本后制造一次失配，第二次不再制造 → 重试应成功
      await writeFile(p, JSON.stringify({ revision: 7, mutated: true }, null, 2) + '\n');
    }
    return v;
  },
};
const retryWriter = createArtifactWriter({ fsPort: retryPort, onEvent: (e) => events.push(e) });
const rRetry = await retryWriter.write(p3, { n: 2 });
check(rRetry.ok === true, '失配一次后重试成功', `ok=${rRetry.ok} attempts=${rRetry.attempts}`);
check(rRetry.attempts === 2, '尝试次数 = 2（首次 + 重试一次）', `attempts=${rRetry.attempts}`);
check(events.some((e) => e.type === 'version-stale'), '留下 version-stale 事件');
check(events.some((e) => e.type === 'write-retried'), '留下 write-retried 事件');
const retried = JSON.parse(await readFile(p3, 'utf8'));
check(retried.n === 2, '重试后内容是新值');

console.log('\n④ revision 记账');
const p4 = join(root, 'REV.json');
await writer.write(p4, { a: 1 });            // rev 1
await writer.write(p4, { a: 2 });            // rev 2
const r4 = await writer.write(p4, { a: 3 }); // rev 3
check(r4.revision === 3, '连续写入 revision 单调自增 → 3', `revision=${r4.revision}`);
// 调用方声明了过期的 expectedRevision
const r5 = await writer.write(p4, { a: 4 }, { expectedRevision: 1 });
check(r5.ok === false && r5.code === 'REVISION_STALE', 'expectedRevision 过期 → 拒绝', `code=${r5.code}`);
const revText = await readFile(p4, 'utf8');
check(readRevision(revText) === 3, '文件仍停在 rev 3（拒绝写入没有落地副作用）', `revision=${readRevision(revText)}`);
// 声明正确则放行
const r6 = await writer.write(p4, { a: 5 }, { expectedRevision: 3 });
check(r6.ok === true && r6.revision === 4, 'expectedRevision 正确 → 放行并自增到 4', `revision=${r6.revision}`);

console.log('\n⑤ 读取接口与默认规则常量');
const rd = await writer.read(p4);
check(rd.revision === 4, 'read() 返回当前 revision');
check((await writer.read(join(root, '不存在.json'))).text === null, 'read() 对缺失文件返回 text=null');
check(DEFAULT_EXCLUSIONS.length >= 5, '默认禁写规则不少于 5 条', `共 ${DEFAULT_EXCLUSIONS.length} 条`);

console.log('');
if (fail > 0) {
  console.log(`✗ 受控写入口测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ 受控写入口测试通过（范围硬排除 + 版本栅栏 + 陈旧重试 + revision 记账）');
