// 测试共享小件（**不随包发布**：package.json 的 `files` 不含它）。
//
// 运行：被各测试 `import`，本身不是测试文件（所以不在 test:all 的名单里）。

import { rm } from 'node:fs/promises';

/**
 * 拆除测试 fixture 目录，容忍"插件异步写入还在飞"造成的瞬时 ENOTEMPTY / EBUSY。
 *
 * 为什么需要：插件对 `$DSH_HOME/expert-team/session-runs.json` 的写入是**事件驱动、不阻塞调用方**的
 * （`apply()` 里就有 `void loadSessionRuns()`）。测试拆环境时若恰好有一次写正在落盘，`rm -rf` 会撞上
 * "目录刚被清空、又被写进一个文件"的瞬间，报：
 *
 *   ENOTEMPTY: directory not empty, rmdir '/tmp/dsh-et-members-XXXX/fake-dsh/expert-team'
 *
 * 这是**测试自身的竞态**，不是被测代码的缺陷 —— 判据：同一批改动在"超集提交"上全绿。
 * （2026-09-14 CI 在提交 3f25008 上偶发红即此因，而包含同样改动还有更多改动的后续提交全绿。）
 *
 * 修在测试侧的理由：那条写入是刻意 fire-and-forget 的（插件不该为了测试去 await 它），
 * 所以"等写入落地 + 对瞬时错误重试"是这里唯一合理的位置。
 *
 * @param dir - 要删除的目录。
 * @param options.settleMs - 先等多久让在飞写入落盘（默认 60ms）。
 * @param options.retries - 遇到瞬时错误时的重试次数（默认 4）。
 * @param options.retryMs - 每次重试前等多久（默认 40ms）。
 */
export async function rmFixture(dir, { settleMs = 60, retries = 4, retryMs = 40 } = {}) {
  await new Promise((r) => setTimeout(r, settleMs));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = String((e && e.code) || e);
      // 只对"瞬时"错误重试；真的删不掉（权限等）要如实抛出来，不能吞
      if (attempt >= retries || !/ENOTEMPTY|EBUSY/.test(code)) throw e;
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}
