// 测试：「子代理运行中」状态条的视图模型（常驻于输入框正上方）
//
// 用户报障原文（2026-09-15）：「子代理运行期间，输入框/对话框处要有一个明显的提醒，
// 不然不好区分是否有子代理在运行」。
//
// 设计取径（已实测确认，见下方"落点"）：
//   · 落点 = 官方 `conversation.input.dock` 槽（kind=list、scope=session，官方文档原文
//     "Full-width entries above the composer card."），渲染位置在消息列表之后、输入框卡片之前
//     ⇒ 物理上就是"对话框与输入框之间"。list 槽纯增，不接管、不遮蔽 queue/todo/goal。
//   · 判据 = `/state` 负载的 `agents[].activity === 'running'`（host 由 `subagents.listChildren`
//     产出），与页头徽章**同源** ⇒ 两处指示不会互相矛盾。
//
// 本测试只断言**纯函数** `subagentBarModel` 的行为（不启浏览器）：两种"零"必须分得清 ——
// "拿不到 agents 块（未知）" ≠ "拿到了但确实没有人在跑"，未知时不许谎报"无子代理在运行"。
//
// 运行：node subagent-bar.test.mjs

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = await readFile(join(here, 'client.js'), 'utf8')

let fail = 0
const check = (ok, name, detail) => {
  if (!ok) fail += 1
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ── 抽纯函数（沿用本仓 tool-card-status.test.mjs 的 sliceFn 范式）──
function sliceFn(name) {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) { console.error(`✗ 未能从 client.js 抽取 ${name}`); process.exit(1) }
  let i = src.indexOf('{', at), depth = 0
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1) }
  }
  console.error(`✗ ${name} 花括号不平衡`); process.exit(1)
}

// roleLabel / t 在本测试里用最简替身：本测试只关心"计数与两种零"，不关心译名。
const stubs = `
  function t(zh, en) { return zh }
  function roleLabel(r) { return ({ pm: '产品经理', backend: '后端工程师' })[r] || '' }
`
const code = [sliceFn('runningAgents'), sliceFn('subagentBarModel')].join('\n')
const mod = new Function(`${stubs}\n${code}\n return { runningAgents: runningAgents, subagentBarModel: subagentBarModel };`)()
const { runningAgents, subagentBarModel } = mod

console.log('# 子代理运行状态条视图模型\n')

console.log('① 没有会话 ⇒ 不渲染（不显示"别人的会话"的子代理数）')
{
  check(subagentBarModel({ ok: true, agents: [{ id: 'a', activity: 'running' }] }, false) === null, 'hasSession=false ⇒ null')
  check(subagentBarModel(null, false) === null, '无负载 + 无会话 ⇒ null')
}

console.log('② 两种"零"必须分得清：未知 ≠ 确实没有人在跑')
{
  check(subagentBarModel(null, true) === null, '还没拿到负载 ⇒ null（占位，不谎报）')
  check(subagentBarModel({ ok: false, runs: [] }, true) === null, 'ok:false（早退负载没有 agents 键）⇒ null')
  check(subagentBarModel({ ok: true }, true) === null, '缺 agents 键（老 host / section=summary）⇒ null')
  check(subagentBarModel({ ok: true, agents: {} }, true) === null, 'agents 不是数组 ⇒ null')
  const idle = subagentBarModel({ ok: true, agents: [] }, true)
  check(idle && idle.kind === 'idle' && idle.n === 0, '拿到 agents=[] ⇒ idle（确实没有）', idle && idle.text)
  const idle2 = subagentBarModel({ ok: true, agents: [{ id: 'a', activity: 'idle' }, { id: 'b', activity: 'inactive' }] }, true)
  check(idle2 && idle2.kind === 'idle' && idle2.n === 0, '全部 idle/inactive ⇒ idle')
}

console.log('③ 运行中 ⇒ 横幅 + 计数 + 角色名')
{
  const d = { ok: true, agents: [
    { id: 'a1', activity: 'running', role: 'backend' },
    { id: 'a2', activity: 'idle', role: 'pm' },
    { id: 'a3', activity: 'running', role: 'pm' },
  ] }
  const m = subagentBarModel(d, true)
  check(m && m.kind === 'busy', 'kind=busy', m && m.kind)
  check(m.n === 2, 'n=2（只数 running）', m && m.n)
  check(m.text.indexOf('2 个子代理运行中') >= 0, '文案含计数', m && m.text)
  check(m.names.join('|') === '后端工程师|产品经理', '角色名按 running 顺序取', m && m.names.join('|'))
}

console.log('④ 角色名解析不出 ⇒ 回落到 id 前 8 位（不编造角色名）；超过 3 个 ⇒ 补 "+N"')
{
  const m = subagentBarModel({ ok: true, agents: [{ id: 'abcdefgh1234', activity: 'running', role: '' }] }, true)
  check(m.names[0] === 'abcdefgh', '无角色名 ⇒ id 前 8 位', m.names[0])
  const many = { ok: true, agents: [1, 2, 3, 4, 5].map((i) => ({ id: 'a' + i, activity: 'running', role: 'backend' })) }
  const m2 = subagentBarModel(many, true)
  check(m2.n === 5 && m2.names.length === 3, '最多展示 3 个名字', `n=${m2.n} names=${m2.names.length}`)
  check(m2.text.indexOf('+2') >= 0, '超出部分以 +N 如实标注', m2.text)
}

console.log('⑤ 运行态判据与页头徽章同源（源码层锚点，防止未来改口径改歪）')
{
  check(/activity \|\| ''\) === 'running'/.test(src), '判据取 agents[].activity === running')
  check(src.indexOf("ctx.slots.inject('conversation.input.dock'") >= 0, '注册进 conversation.input.dock（输入框正上方）')
  check(src.indexOf("id: 'expert-team-subagents'") >= 0, '新 id（不撞 queue/todo/goal）')
  check(src.indexOf('.exp-subbusy{') >= 0 && src.indexOf('.exp-subbusy-idle{') >= 0, 'CSS 两类状态都在场')
  // 不许新开轮询：状态条必须复用既有 useLiveState/stateHub
  check(src.indexOf('useLiveState(barSessionId)') >= 0, '状态条复用 useLiveState（零新增轮询）')
  const bareCount = (src.match(/fetch\(['"]\/plugins\/dsh-expert-team\/state/gi) || []).length
  check(bareCount === 0, '没有裸 /state fetch（state-perf-guard 棘轮）', `bare=${bareCount}`)
  // 宽度回归（真机报障：状态条比输入框宽）：dock 条目必须让出侧边留白 + 居中，
  // 且宽度上限要取 min(可用宽度, 卡片自身上限 --dsh-composer-card-max-width)，绝不能 width:100%
  const busyRule = (src.match(/\.exp-subbusy\{[^']*\}/) || [''])[0]
  check(busyRule.indexOf('width:100%') < 0, '状态条不写 width:100%（否则比输入框宽）', busyRule.slice(0, 60))
  check(busyRule.indexOf('--dsh-composer-card-max-width') >= 0, '宽度上限取卡片上限（宽窗口下不会比输入框宽）')
  check(busyRule.indexOf('min(') >= 0 && busyRule.indexOf('--dsh-composer-side-clearance') >= 0, '同时让出侧边留白（窄窗口回退）')
  check(busyRule.indexOf('margin:0 auto') >= 0, 'margin:0 auto 居中（对齐输入框卡片）')
}

if (fail) { console.error(`\n✗ subagent-bar：${fail} 项失败`); process.exit(1) }
console.log('\n✓ subagent-bar：全部通过')
