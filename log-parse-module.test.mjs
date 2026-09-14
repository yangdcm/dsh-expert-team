// 测试：B 线第 8 项 · `lib/log-parse.js`（运行日志解析）
//
// 为什么单独成模块：**同一个解析器被至少四个消费者用**（METRICS 聚合 / `/team check` 的阶段记账 /
// 命令侧状态行 / 测试的 `_live`）。2026-09-13 我为"阶段记账"检查**临时抄过一份简化版**
//（`validate.js` 的 `parseLogLineLite`）—— 那正是本仓头号返工源「一个事实多份拷贝」的形态。
// 搬出来之后**只此一份**，本测试的头号断言就是"那份抄件真的没了"。
//
// 同时钉住口径（这些是**行为契约**，不属于重构可以顺手改的范围）：
//   · 时间戳宽容（`[now]` 这类历史写法仍计入事件）；
//   · **判决只认 `verdict=<token>`**，且 `verdict=` 出现后**绝不回落**到散文猜测（历史 bug）；
//   · 角色：`【中文标签】` 走**精确表**，自由文本走**关键词表**（模糊，先命中先赢）；
//   · 错误归类只把列出的族算"环境类"，**未列出的算过程类**（宁可算过程，不美化指标）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M123**。
// 运行：node log-parse-module.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('# B 线第 8 项 · log-parse.js\n');

const cmdSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
const valSrc = await readFile(join(here, 'lib', 'validate.js'), 'utf8');
const lpSrc = await readFile(join(here, 'lib', 'log-parse.js'), 'utf8');
const { apply, _live } = await import(join(here, 'lib', 'command.js'));
const LP = await import(join(here, 'lib', 'log-parse.js'));

const MOVED = ['roleNorm', 'parseLogLine', 'eventFamily', 'truncateCodepoints', 'tallyEvent', 'eventTallyLines',
  'normalizeRoleName', 'VERDICT_TOKEN_WRAPPERS', 'VERDICT_TOKENS', 'verdictFromToken', 'extractRole',
  'extractVerdict', 'ENV_ERROR_FAMILIES', 'classifyErrorFamily', 'ROLE_NAMES'];

console.log('① 搬走了没接上？（定义只许在 log-parse.js，command.js 必须 import）');
{
  const left = MOVED.filter((n) => new RegExp(`^(?:export\\s+)?(?:function|const|let)\\s+${n}\\b`, 'm').test(cmdSrc));
  check(left.length === 0, 'command.js 里没有这 15 个符号的第二份定义', left.length ? `残留：${left.join(', ')}` : `${MOVED.length} 个都只在 log-parse.js`);
  check(/from '\.\/log-parse\.js'/.test(cmdSrc), 'command.js 确实从 `./log-parse.js` import');
  const missing = MOVED.filter((n) => !(n in LP));
  check(missing.length === 0, 'log-parse.js 都导出了', missing.length ? `缺：${missing.join(', ')}` : '');
  check(!/from '\.\/command\.js'/.test(lpSrc), 'log-parse.js **不反向依赖** command.js（否则循环 import）');
  check(/from '\.\/vocab\.js'/.test(lpSrc), '词表从 vocab.js 取（不自己抄一份）');
}

console.log('\n② 那份**临时抄件**真的没了（本仓头号返工源：一个事实多份拷贝）');
{
  check(!/function parseLogLineLite/.test(valSrc), 'validate.js 里没有第二份日志解析器（`parseLogLineLite` 已删）');
  check(!/parseLogLineLite\s*\(/.test(valSrc.replace(/`parseLogLineLite`/g, '')), '也没有它的调用点（只允许出现在注释里）');
  check(/import \{ parseLogLine \} from '\.\/log-parse\.js'/.test(valSrc), 'validate.js 改用真源（`import { parseLogLine }`）');
  // 阶段记账与聚合器**现在字面上就是同一个函数** —— 比"两套实现 + 一条一致性断言"更强。
  check(_live.loggedPhases('- [10:00:00] phase:design — x').has('design'), '阶段集合仍由真源解析');
}

console.log('\n③ 行为契约（重构不许顺手改口径；下面的期望值都是**读实现 + 实跑**得到的，不是猜的）');
{
  check(JSON.stringify(LP.parseLogLine('- [22:21:03] run:started — 目标=x')) === JSON.stringify({ time: '22:21:03', type: 'run:started', detail: '目标=x' }), '规范行解析');
  check(LP.parseLogLine('- [now] decision:lead — 裁定')?.time === 'now', '**历史写法 `[now]` 仍计入事件**（否则当年那些 run 的决策会被静默丢掉）');
  check(LP.parseLogLine('随便一行没有前缀') === null && LP.parseLogLine('') === null, '非事件行 ⇒ null');

  // 事件族：**有冒号就取冒号前那段**（`run:started` → `run`，不是原样）
  check(LP.eventFamily('error:external-write') === 'error' && LP.eventFamily('role:pm') === 'role' && LP.eventFamily('phase:clarify') === 'phase', '有冒号 ⇒ 取冒号前那段');
  check(LP.eventFamily('run:started') === 'run' && LP.eventFamily('answer') === 'answer', '`run:started` → `run`；无冒号则原样');

  // 判决：只认 token；**返回的是"归一到聚合口径"的判决**（`needs_revision` → `rework`）
  check(LP.verdictFromToken('role=backend verdict=pass') === 'pass', '`verdict=pass` → pass');
  check(LP.verdictFromToken('role=backend verdict=needs_revision') === 'rework', '`needs_revision` **归一到 `rework`**（聚合口径，不是原样返回 token）', String(LP.verdictFromToken('role=backend verdict=needs_revision')));
  check(LP.verdictFromToken('role=backend verdict=「needs_revision」') === 'rework' && LP.verdictFromToken('role=backend verdict=**needs_revision**') === 'rework', '容忍全角引号 / markdown 粗体包裹');
  check(LP.verdictFromToken('role=backend verdict=fake_token') === '', '认不出的 token ⇒ **空串**（既不是 null、也不猜）');
  check(LP.verdictFromToken('role=backend') === null, '没有 `verdict=` ⇒ null（调用方才知道要不要走散文推断）');
  check(LP.verdictFromToken('role=backend verdict:pass') === null, '`verdict:`（冒号）**不算**（历史 bug 的来源之一）');
  check(LP.extractVerdict('结论：返工了') === 'rework', '无 token 时散文推断仍可用（兼容历史日志）');
  // 历史 bug 的守卫：`verdict=needs_revision；…通过 10…` 曾被散文正则提升成 pass
  check(LP.verdictFromToken('verdict=needs_revision；其中 10 项通过') === 'rework', '**token 在场时，散文里的「通过」不得翻案**');

  // 角色：三个函数**分工不同**，别把它们当成一个
  check(LP.roleNorm('pm(repair)') === 'pm' && LP.roleNorm('frontend-F4') === 'frontend', '`roleNorm`：取 `-` 前那段 + 关键词表（`frontend-F4` → `frontend`）');
  check(LP.normalizeRoleName('pm(repair)') === 'pm', '`normalizeRoleName`：去掉括号后缀');
  check(LP.normalizeRoleName('frontend-F4') === 'frontend-F4', '但它**不**去 `-` 后缀（与 roleNorm 的差别如实钉住，防止有人"统一"掉）');
  check(LP.extractRole('role=backend verdict=pass') === 'backend', '`extractRole`：先认 `role=`');
  check(LP.extractRole('随便一句话') === 'unknown', '`extractRole` 认不出 ⇒ `unknown`（它**不**认中文标签）');
  check(_live.roleOfSub({ label: '【后端工程师】实现 T24' }) === 'backend', '**中文标签走 `roleOfSub`**（`【后端工程师】` → backend）');
  check(_live.roleOfSub({ label: '【审查官】复审' }) === 'reviewer' && _live.roleOfSub({ label: 'pm(repair)' }) === 'pm', '`roleOfSub`：精确标签表优先，退回关键词表');

  check(LP.classifyErrorFamily('error:external-write') === 'env' && LP.classifyErrorFamily('error:workflow') === 'process', '错误归类：列出的族算环境类');
  check(LP.classifyErrorFamily('error:某个没见过的族') === 'process', '**未列出的族算过程类**（宁可算过程，不美化指标）');
  check(LP.truncateCodepoints('x'.repeat(119) + '🙂', 120) === 'x'.repeat(119) + '🙂', '按**码点**截断（不劈开代理对）');
}

console.log('\n④ 兼容层：`_live` 的导出键**一个都没少**（用改动前的快照比对，不靠人列清单）');
{
  // 基准随仓提交（regression.fixtures/live-keys-before-logparse.json）。
  // 以前这里读的是 `/tmp/backup-lib-before-logparse/command.js` —— 重构当天作者手工留下的备份，
  // CI 与别人的机器上都不存在，于是这条断言在 CI 上以 ENOENT 直接失败（2026-09-14 三档全红）。
  // 抽成夹具后基准可评审、可追溯，且不再依赖任何机器状态；本基线只允许**增**键、不允许丢键。
  const baseline = JSON.parse(await readFile(join(here, 'regression.fixtures', 'live-keys-before-logparse.json'), 'utf8'));
  const keysOf = (src) => {
    const m = src.match(/export const _live = \{([\s\S]*?)\};/);
    const out = new Set();
    for (const part of (m ? m[1] : '').split(',')) {
      const name = part.trim().split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
    return out;
  };
  const b = new Set(baseline.keys);
  const a = keysOf(cmdSrc);
  check(b.size > 20, `基准快照可用（${b.size} 个键，取自 ${baseline._source}）`);
  const lost = [...b].filter((k) => !a.has(k));
  check(lost.length === 0, '改动前的 `_live` 键一个都没丢', lost.length ? `丢：${lost.join(', ')}` : `${b.size} → ${a.size}`);
  check(_live.parseLogLine === LP.parseLogLine, '`_live.parseLogLine` 与模块里**是同一个函数**（不是又包一层）');
  check(typeof _live.roleOfSub === 'function' && typeof _live.mapRoleToSub === 'function', '角色解析入口仍在 `_live`（成员域还没搬，仍由 command.js 提供）');
  // 端到端：两个最重的消费者都还跑得通
  apply({ commands: { register: () => {} }, on: () => {}, get: () => undefined, inject: () => {} });
  check(_live.phaseAccountingViolations('- [10:00:00] role:pm — x', 'deliver').length === 1, '消费者 1（阶段记账）照常工作');
  // 注：`eventTallyLines` **从来不在 `_live` 里**（它只在 aggregate 内部用）⇒ 这里直接测模块导出，
  // 而不是假装它一直挂在兼容层上。
  check(LP.eventTallyLines(new Map([['error:x', { count: 2, sample: 's' }]]), '（无）').includes('error:x'), '消费者 2（事件计数渲染）照常工作');
}

if (fail) { console.error(`\n✗ log-parse-module：${fail} 项失败`); process.exit(1); }
console.log('\n✓ log-parse-module：全部通过（搬走/接上/抄件已删/口径不变/兼容层）');
