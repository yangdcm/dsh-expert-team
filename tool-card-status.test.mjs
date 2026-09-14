// 测试：对话流「角色卡」的状态语义与名称显示（用户 2026-09-11 报障两处）
//
// 报障原文（截图）：
//   ① 「任务进行中 应该标记为进行中」—— 卡上是 ✅完成，而同一角色在子代理列表里
//      显示 `3分39秒 · 正在运…`。根因：旧实现把 `settled`（工具调用**已返回**）当成
//      完成标记，而可继续委派（`backgroundMode: continuable`）下 `subagent_<role>`
//      **几乎立刻**返回 `started subagent <id>`（dsh-tool-subagent 实测文本），
//      子代理随后仍在跑 ⇒ 运行中的任务被标成完成。
//   ② 「子代理名称没有显示完」—— 名称行旧实现 `String(prompt).slice(0, 90)`：**硬切**
//      且不补省略号，句子断在半截（label 也被一起切掉），看起来就是「没显示完」。
//
// 修法：
//   ① 状态判定抽成**纯函数** `roleCardState(block, out, liveAgents)`：工具调用在飞，
//      或结果里的子代理 id 在 `/state` 的活子代理里仍 `activity === 'running'` ⇒ 进行中；
//      拿不到 id / 已不在活列表 ⇒ 按调用结果结算（✅完成 / ❌失败）。
//   ② 名称（label）**不截断**；只有 prompt 预览按显示宽度截断并**补 `…`**（复用 clipText）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M40**（状态语义）/ **M41**（名称截断）。
// 运行：node tool-card-status.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = await readFile(join(here, 'client.js'), 'utf8');

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 抽源码 + new Function（沿用本仓 panorama.test.mjs 的范式）──
function sliceFn(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) { console.error(`✗ 未能从 client.js 抽取 ${name}`); process.exit(1); }
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
  }
  console.error(`✗ ${name} 花括号不平衡`); process.exit(1);
}
const code = [sliceFn('roleCardState'), sliceFn('clipText')].join('\n');
const mod = new Function(`${code}\n return { roleCardState: roleCardState, clipText: clipText };`)();
const { roleCardState, clipText } = mod;

/** 报障截图里的真实子代理 id（可继续委派结果文本） */
const CHILD = 'de6326c1-c47a-47ab-a1dc-b422258066cf';
const settledBlock = { kind: 'tool-result', callId: 'call_1', argsRaw: '{}' };

console.log('# 角色卡状态语义 + 名称显示\n');

console.log('① 工具调用在飞 ⇒ 进行中（callId 有、kind 无）');
{
  const st = roleCardState({ callId: 'call_1' }, '', null);
  check(st.isRunning === true, 'isRunning=true', `isRunning=${st.isRunning}`);
  check(st.statusText === '⏳ 进行中', 'statusText=进行中', st.statusText);
}

console.log('② 报障主场景：可继续委派已返回 + 子代理仍 running ⇒ 进行中（不是完成）');
{
  const st = roleCardState(settledBlock, `started subagent ${CHILD}`, [{ id: CHILD, activity: 'running' }]);
  check(st.settled === true, 'settled 仍为真（调用确实返回了）');
  check(st.childId === CHILD, '解析出子代理 id', st.childId);
  check(st.isRunning === true, 'isRunning=true（活的子代理说了算）', `isRunning=${st.isRunning}`);
  check(st.statusText === '⏳ 进行中', 'statusText=进行中', st.statusText);
}

console.log('③ 子代理已结算（idle）或不在活列表 ⇒ ✅完成（不把完成也标成进行中）');
{
  const idle = roleCardState(settledBlock, `started subagent ${CHILD}`, [{ id: CHILD, activity: 'idle' }]);
  check(idle.isRunning === false && idle.statusText === '✅ 完成', 'idle ⇒ 完成', idle.statusText);
  const gone = roleCardState(settledBlock, `started subagent ${CHILD}`, [{ id: 'other-id-12345678', activity: 'running' }]);
  check(gone.isRunning === false && gone.statusText === '✅ 完成', 'id 不在活列表 ⇒ 完成', gone.statusText);
  const noLive = roleCardState(settledBlock, `started subagent ${CHILD}`, null);
  check(noLive.isRunning === false && noLive.statusText === '✅ 完成', '拿不到活态 ⇒ 完成（不误报进行中）', noLive.statusText);
}

console.log('④ 失败仍为失败；非委派结果（无子代理 id）不被活子代理误判为运行');
{
  const err = roleCardState({ kind: 'tool-result', callId: 'call_1', isError: true }, 'boom', [{ id: CHILD, activity: 'running' }]);
  check(err.isErr === true && err.statusText === '❌ 失败', 'isError ⇒ 失败', err.statusText);
  const plain = roleCardState(settledBlock, 'all good', [{ id: CHILD, activity: 'running' }]);
  check(plain.childId === '' && plain.isRunning === false, '无 id 的结果按结算处理', `childId="${plain.childId}"`);
  const bg = roleCardState(settledBlock, 'started background subagent job job-abcdefgh', [{ id: 'job-abcdefgh', activity: 'running' }]);
  check(bg.childId === 'job-abcdefgh', 'background job 形态也能解析', bg.childId);
}

console.log('⑤ 名称不截断、prompt 预览截断必须补省略号（报障②）');
{
  // 只断言**代码行**：仅看片段是否出现会误伤注释里引用的旧实现（本测试第一版就踩了）。
  const nameLine = src.split('\n').find((l) => l.includes("className: 'et-tc-t'")) || '';
  check(nameLine.includes('clipText(prompt, 120)') && !nameLine.includes('.slice(0, 90)'), '名称行不硬切、prompt 走 clipText', nameLine.trim().slice(0, 110));
  check(src.includes('esc(st.statusText)'), '状态徽章取 roleCardState 的 statusText');
  check(!src.includes("esc(running ? '⏳ 进行中'"), '徽章不再只看工具调用是否返回');
  check(src.includes('子代理运行中'), '卡片底部如实说明子代理仍在运行');
  const long = 'A'.repeat(400);
  const clipped = clipText(long, 120);
  check(clipped.endsWith('…') && clipped.length <= 121, '超长文本截断补 …', `len=${clipped.length}`);
  check(clipText('短名称', 120) === '短名称', '未超长不加省略号');
  // 名称（label）必须完整出现：任务行里 label 原样拼进文本，不带切片
  check(src.includes('esc(label ? String(label)'), 'label 原样渲染（不切片）');
}

if (fail) { console.error(`\n✗ tool-card-status：${fail} 项失败`); process.exit(1); }
console.log('\n✓ tool-card-status：全部通过');
