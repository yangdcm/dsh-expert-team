// 测试：跨会话查看 run 时「人」的归属（run 元信息来自 B、人却来自 A 的串味）
//
// 实测报障（2026-09-11）：在 dsh 会话的面板里用下拉切到 php/jiu 的 run，得到
//   runId = 分析当前项目-组建最新项目记忆-050630   ← jiu 的
//   tasks = 17                                    ← jiu 的
//   agents = 30                                   ← **dsh 会话的字子代理**（jiu 只有 6 个）
// 根因：`listSubagentStatusBySession(ctx, sid, …)` 用的是**请求里的 sessionId**，
// 而 run 没有记录"它属于哪个会话"。
//
// 修法：
//   ① `session-runs.json` 的条目加 `via`：'create'（归属）vs 'view'（只是看了一眼）；
//   ② 创建 run 时把归属写进 `STATE.json.ownerSession`（run 自带，不会被别的会话改写）；
//   ③ `runOwnerSession(runId)` 三源解析归属，并用 `ownerResolved` 明示哪一源是推断；
//   ④ 面板据此如实提示，不确定就说不确定 —— 不默默把两个 run 的人混在一起。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 M23。
// 运行：node run-ownership.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _live } from './lib/command.js';

const { rememberSessionRun, sessionRunFor, runOwnerSession, SESSION_RUNS } = _live;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const WS = '/w/jiu';
const RUN = 'run-A';

console.log('# 跨会话 run 归属（runOwnerSession / via 语义）\n');

console.log('① 归属优先于「查看」：create 记录赢');
{
  SESSION_RUNS.clear();
  rememberSessionRun('session-jiu', WS, RUN, 'view');   // 先被看一眼
  rememberSessionRun('session-me', WS, RUN, 'view');    // 我也看一眼
  rememberSessionRun('session-jiu', WS, RUN, 'create'); // 真正创建者（晚到也要赢）
  const o = runOwnerSession(RUN);
  check(o.sid === 'session-jiu', 'create 的会话被认成归属', o.sid);
  check(o.ownerResolved === true, '来源可靠 → ownerResolved=true');
}

console.log('\n② 无 create 记录 ⇒ 不给归属（去掉「最早一条」兜底）');
{
  SESSION_RUNS.clear();
  rememberSessionRun('session-jiu', WS, RUN, 'view');
  await new Promise((r) => setTimeout(r, 2));
  rememberSessionRun('session-me', WS, RUN, 'view');
  const o = runOwnerSession(RUN);
  check(o.sid === '', '只有 view 记录 ⇒ 空 sid（不许用 view 记录造归属）', o.sid);
  check(o.ownerResolved === false, '未解析 → ownerResolved=false（面板必须据此提示）');
}

console.log('\n③ 「查看」不得把已记录的归属降级或改写');
{
  SESSION_RUNS.clear();
  rememberSessionRun('session-jiu', WS, RUN, 'create');
  rememberSessionRun('session-jiu', WS, RUN, 'view');   // 同会话再看一眼
  check(sessionRunFor('session-jiu').via === 'create', 'via 保持 create');
  check(runOwnerSession(RUN).ownerResolved === true, '归属仍然可靠');
  // 别的会话查看，不能把归属挪到它身上
  rememberSessionRun('session-me', WS, RUN, 'view');
  check(runOwnerSession(RUN).sid === 'session-jiu', '归属没有被后到的 view 抢走');
}

console.log('\n④ 无记录 / 空参：不得抛错，如实返回空 + 未解析');
{
  SESSION_RUNS.clear();
  check(runOwnerSession(RUN).sid === '', '无记录 → 空 sid');
  check(runOwnerSession(RUN).ownerResolved === false, '无记录 → ownerResolved=false');
  check(runOwnerSession('').sid === '' && runOwnerSession(null).sid === '', '空/undefined runId → 空');
  rememberSessionRun('', WS, RUN, 'create');
  rememberSessionRun('s', '', RUN, 'create');
  rememberSessionRun('s', WS, '', 'create');
  check(SESSION_RUNS.size === 0, '缺参数的记录被忽略（不写入垃圾归属）');
}

console.log('\n⑤ 多个 run 互不串味');
{
  SESSION_RUNS.clear();
  rememberSessionRun('s1', WS, 'run-1', 'create');
  rememberSessionRun('s2', WS, 'run-2', 'create');
  check(runOwnerSession('run-1').sid === 's1', 'run-1 → s1');
  check(runOwnerSession('run-2').sid === 's2', 'run-2 → s2');
  check(runOwnerSession('run-3').sid === '', '不存在的 run → 空（不误配）');
}

console.log('\n⑥ 接线检查：查询路径必须真的用归属会话，而不是请求会话');
{
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'lib/command.js'), 'utf8');
  // 锚点切片（2026-09-15）：旧写法用**固定 2600 字符窗口**，与插入位置强耦合 ——
  // 在它前面加五行代码就会把 `workflowChildLabels`/`peopleSessionNote` 挤出窗口而**假红**
  // （实测：加"有界化"的 degraded 上报后红了两条）。断言本身不变，只把"块"的边界改成
  // 语义锚点：从归属查询起、到 `mark('wfLabels')` 止 —— 这段就是"人员解析块"。
  const at = src.indexOf('const owner = sel.stateOwnerSession');
  const endAt = at >= 0 ? src.indexOf("mark('wfLabels')", at) : -1;
  const block = (at >= 0 && endAt > at) ? src.slice(at, endAt) : '';
  check(!!block, '找到人员解析块');
  check(/listSubagentStatusBySession\(ctx, peopleSid/.test(block), '列人员用 peopleSid（归属会话）而不是 sid', '');
  // 2026-09-16：入口从 `workflowChildLabels` 换成有界后台预热的 `workflowEventIndexForRequest`
  // （函数名变了，但"取的是**归属会话** peopleSid"这条断言本身不变）。
  check(/workflowEventIndexForRequest\(ctx, peopleSid\)/.test(block), 'workflow 事件流也走归属会话');
  check(!/workflowEventIndexForRequest\(ctx, sid\)/.test(block), 'workflow 事件流**不**走请求会话（防回归）');
  check(/sel\.peopleSessionNote/.test(block), '不确定时产出如实提示（peopleSessionNote）');
  check(/ownerResolved/.test(block), '推断来源被显式区分');
  // createRun 必须写归属
  check(/rememberSessionRun\(invocation\?\.agent\?\.session\?\.id, cwd, runId, 'create'\)/.test(src), 'createRun 记录 via=create');
  check(/st\.ownerSession = ownerSid/.test(src), 'createRun 把归属写进 STATE.json');
  check(/stateOwnerSession: String\(state\.ownerSession/.test(src), 'snapshotRun 暴露 ownerSession');
}

console.log('');
if (fail > 0) {
  console.log(`✗ run 归属测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ run 归属测试通过（归属优先于查看；推断来源如实标注；查询走归属会话）');
