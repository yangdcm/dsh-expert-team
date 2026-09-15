// 测试：「子代理运行中」状态条的视图模型（常驻于输入框正上方）
//
// 用户报障原文（2026-09-15）：「子代理运行期间，输入框/对话框处要有一个明显的提醒，
// 不然不好区分是否有子代理在运行」。
//
// 设计取径（已实测确认，见下方"落点"与"判据"）：
//   · 落点 = 官方 `conversation.input.dock` 槽（kind=list、scope=session，官方文档原文
//     "Full-width entries above the composer card."），渲染位置在消息列表之后、输入框卡片之前
//     ⇒ 物理上就是"对话框与输入框之间"。list 槽纯增，不接管、不遮蔽 queue/todo/goal。
//   · 判据 = **宿主会话态**里 `running` 为真的子代理后代（`byId` 的 `origin/parentId/running`
//     ＋ `items` 的直接子会话 `parentSessionId`），与页头「N 个子代理」**同源** ⇒
//     两处指示不会互相矛盾。
//     **不再**用 `/state` 的 `agents[].activity === 'running'`：服务端把子代理语料的归属会话
//     解析成「当前 run 的 ownerSession」（`lib/command.js` 的 `peopleSid`），**客户端传的
//     sessionId 会被忽略** —— 真机实测：一个刚开跑、还没落 `STATE.json` 的新 run 在 `newestRun`
//     按 `updatedAt` 排序时输给同工作区 13 天前的旧 run，于是本会话明明有子代理在跑，状态条却
//     拿到旧 run 的 82 个**已冷**子代理，谎报「无子代理在运行」。
//
// 本测试只断言**纯函数** `runningSubagentIds` / `subagentBarModel` 的行为（不启浏览器）：
// 两种"零"必须分得清 —— "拿不到会话态（未知）" ≠ "拿到了但确实没有人在跑"，
// 未知时**不渲染**，绝不谎报"无子代理在运行"。
//
// 运行：node subagent-bar.test.mjs

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = await readFile(join(here, 'client.js'), 'utf8')

let fail = 0
let total = 0
const check = (ok, name, detail) => {
  total += 1
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

// roleLabel / t 在本测试里用最简替身：本测试只关心"计数、两种零与命名回落"，不关心译名。
// 注意替身 roleLabel 对认不出的角色返回 ''（真身返回原值）——两者都是 falsy ⇒ 都会回落到 id。
const stubs = `
  function t(zh, en) { return zh }
  function roleLabel(r) { return ({ pm: '产品经理', backend: '后端工程师' })[r] || '' }
`
const code = [sliceFn('runningSubagentIds'), sliceFn('subagentBarModel')].join('\n')
const mod = new Function(`${stubs}\n${code}\n return { runningSubagentIds: runningSubagentIds, subagentBarModel: subagentBarModel };`)()
const { runningSubagentIds, subagentBarModel } = mod

console.log('# 子代理运行状态条视图模型\n')

console.log('① 两种"零"必须分得清：未知/无会话 ⇒ 不渲染；拿到会话态且没人跑 ⇒ idle')
{
  check(subagentBarModel(null, 'ROOT') === null, '没有会话态快照 ⇒ null（宁可不显示，不谎报）')
  check(subagentBarModel({ byId: {}, items: [] }, null) === null, '没有会话 id ⇒ null')
  check(subagentBarModel({ byId: {}, items: [] }, undefined) === null, '会话 id 为 undefined ⇒ null')
  check(subagentBarModel({}, 'ROOT') === null, '快照里既没有 byId 也没有 items ⇒ null（"未知"不是"没人跑"）')
  const idle = subagentBarModel({ byId: {}, items: [] }, 'ROOT')
  check(idle && idle.kind === 'idle' && idle.n === 0, '拿到空会话态 ⇒ idle（确实没有人在跑）', idle && idle.text)
  check(!!idle && Array.isArray(idle.names) && idle.names.length === 0, 'idle 时 names 为空数组（渲染层不会读到 undefined）')
}

console.log('② 直接子会话（items）：只认 origin=subagent + parentSessionId=本会话 + running')
{
  const snap = { byId: {}, items: [
    { sessionId: 'a', parentSessionId: 'ROOT', origin: 'subagent', running: true },
    { sessionId: 'b', parentSessionId: 'ROOT', origin: 'subagent', running: false },
    { sessionId: 'c', parentSessionId: 'ROOT', origin: null, running: true },
  ] }
  const ids = runningSubagentIds(snap, 'ROOT')
  check(ids.join('|') === 'a', '非 subagent origin、非 running 都被排除 ⇒ 恰好 [a]', ids.join('|'))
  const m = subagentBarModel(snap, 'ROOT')
  check(m && m.kind === 'busy' && m.n === 1, 'busy 且 n=1', m && `kind=${m.kind} n=${m.n}`)
  const other = runningSubagentIds({ byId: {}, items: [
    { sessionId: 'a', parentSessionId: 'OTHER', origin: 'subagent', running: true },
  ] }, 'ROOT')
  check(other.length === 0, 'parentSessionId 不是本会话 ⇒ 不计（不看"别人的会话"）', other.join('|'))
}

console.log('③ 任一深度的后代（沿 byId 的 parentId 上溯；链路一断就停）')
{
  const byId = {
    g: { origin: 'subagent', parentId: 'm', running: true },
    m: { origin: 'subagent', parentId: 'ROOT', running: false },
    x: { origin: 'subagent', parentId: 'OTHER', running: true },
  }
  const ids = runningSubagentIds({ byId: byId }, 'ROOT')
  check(ids.indexOf('g') >= 0, '孙辈 g（g→m→ROOT）计入（不只看直接子级）', ids.join('|'))
  check(ids.indexOf('m') < 0, 'm 没有在跑 ⇒ 不计', ids.join('|'))
  check(ids.indexOf('x') < 0, '挂在 OTHER 下的 x ⇒ 不计', ids.join('|'))
  const stopped = { byId: {
    h: { origin: 'subagent', parentId: 'o', running: true },
    o: { origin: null, parentId: 'ROOT', running: false },
  } }
  check(runningSubagentIds(stopped, 'ROOT').length === 0, '中间夹了非 subagent 会话（origin:null）⇒ 链路截断，不计', runningSubagentIds(stopped, 'ROOT').join('|'))
  const orphan = { byId: { z: { origin: 'subagent', parentId: 'GONE', running: true } } }
  check(runningSubagentIds(orphan, 'ROOT').length === 0, 'parentId 指向本快照里不存在的会话 ⇒ 不计（不猜）', runningSubagentIds(orphan, 'ROOT').join('|'))
  const rootless = { byId: { t1: { origin: 'subagent', running: true } } }
  check(runningSubagentIds(rootless, 'ROOT').length === 0, 'origin=subagent 但没有 parentId ⇒ 不是本会话的后代，不计', runningSubagentIds(rootless, 'ROOT').join('|'))
}

console.log('④ 去重：同一会话同时出现在 items 与 byId ⇒ 只数一次')
{
  const snap = {
    byId: { d: { origin: 'subagent', parentId: 'ROOT', running: true } },
    items: [{ sessionId: 'd', parentSessionId: 'ROOT', origin: 'subagent', running: true }],
  }
  const ids = runningSubagentIds(snap, 'ROOT')
  check(ids.length === 1 && ids[0] === 'd', 'items + byId 同一 id ⇒ 恰好 1 个', ids.join('|'))
  const m = subagentBarModel(snap, 'ROOT')
  check(m && m.n === 1, '文案计数也只算 1', m && m.n)
}

console.log('⑤ 命名：优先角色名，取不到回落 id 前 8 位（不编造）；超过 3 个补 "+N"')
{
  const withRoles = { byId: { a: { origin: 'subagent', parentId: 'ROOT', running: true } }, __roles: { a: 'backend' } }
  check(subagentBarModel(withRoles, 'ROOT').names.join('|') === '后端工程师', '有 __roles ⇒ 用角色名', subagentBarModel(withRoles, 'ROOT').names.join('|'))
  const long = { byId: { abcdefgh1234: { origin: 'subagent', parentId: 'ROOT', running: true } } }
  check(subagentBarModel(long, 'ROOT').names[0] === 'abcdefgh', '无角色名 ⇒ id 前 8 位', subagentBarModel(long, 'ROOT').names[0])
  const unknown = { byId: { abcdefgh1234: { origin: 'subagent', parentId: 'ROOT', running: true } }, __roles: { abcdefgh1234: 'nope' } }
  check(subagentBarModel(unknown, 'ROOT').names[0] === 'abcdefgh', '角色名解析不出 ⇒ 回落 id（不编造角色名）', subagentBarModel(unknown, 'ROOT').names[0])
  const badRoles = { byId: { a: { origin: 'subagent', parentId: 'ROOT', running: true } }, __roles: 'x' }
  check(subagentBarModel(badRoles, 'ROOT').n === 1, '__roles 不是对象 ⇒ 忽略而不是抛错', subagentBarModel(badRoles, 'ROOT').names.join('|'))
  const many = {}
  for (let i = 1; i <= 5; i += 1) many['a' + i] = { origin: 'subagent', parentId: 'ROOT', running: true }
  const m = subagentBarModel({ byId: many }, 'ROOT')
  check(m.n === 5 && m.names.length === 3, '最多展示 3 个名字', `n=${m.n} names=${m.names.length}`)
  check(m.text.slice(-3) === ' +2', '超出部分以 +N 如实标注（结尾）', m.text)
}

console.log('⑤′ 命名链路：/state 的 agents[] → liveRoles（只用于命名；不新增任何请求）')
{
  // harvestRoles 只依赖模块级的 liveRoles ⇒ 用替身承接它，直接断言"收纳什么、放过什么"。
  const harv = new Function(`var liveRoles = {}\n${sliceFn('harvestRoles')}\n return { harvestRoles: harvestRoles, liveRoles: liveRoles };`)()
  const roles = harv.liveRoles
  harv.harvestRoles({ agents: [{ id: 'a', role: 'backend' }] })
  check(roles.a === 'backend', 'agents[{id, role}] ⇒ 收进映射（只看 id/role）', JSON.stringify(roles))
  const mapped = { byId: { a: { origin: 'subagent', parentId: 'ROOT', running: true } }, __roles: roles }
  check(subagentBarModel(mapped, 'ROOT').names.join('|') === '后端工程师', '在跑的那个 id 有角色名 ⇒ 芯片显示角色名', subagentBarModel(mapped, 'ROOT').names.join('|'))

  const bare = { byId: { a1b2c3d4e5: { origin: 'subagent', parentId: 'ROOT', running: true } } }
  check(subagentBarModel(bare, 'ROOT').names[0] === 'a1b2c3d4', '__roles 缺席 ⇒ 回落 id 前 8 位（不空白、不编造）', subagentBarModel(bare, 'ROOT').names[0])

  harv.harvestRoles({ agents: [{ id: 'zz9', role: 'no-such-role' }] })
  const unknownRole = { byId: { zz9: { origin: 'subagent', parentId: 'ROOT', running: true } }, __roles: roles }
  const um = subagentBarModel(unknownRole, 'ROOT')
  check(um.names[0] === 'zz9' && um.names[0].length > 0, '角色键认不出 ⇒ 回落 id（绝不渲染空芯片）', JSON.stringify(um.names))

  let threw = false
  try {
    harv.harvestRoles(null)
    harv.harvestRoles({})
    harv.harvestRoles({ agents: 'not-an-array' })
    harv.harvestRoles({ agents: [null, 'x', { id: 'noRole' }, { role: 'noId' }, { id: 'g', role: 'pm' }] })
  } catch (e) { threw = true }
  check(!threw && roles.g === 'pm' && !roles.noRole && !roles.noId, '脏负载（null / 非数组 / 残缺条目）⇒ 跳过而不是抛错', JSON.stringify(roles))
}

console.log('⑥ 源码层锚点（防止未来改口径改歪）')
{
  check(src.indexOf('runningAgents') < 0, '旧的 /state 判据函数 runningAgents 已彻底删除（无残留引用）')
  const barSrc = sliceFn('SubagentBar')
  check(barSrc.indexOf('useLiveState') < 0, '状态条不再引用 useLiveState（/state 依赖已移除）')
  check(barSrc.indexOf('props.useSessions') >= 0, '状态条改读宿主会话态（useSessions，与页头同源）')
  const liveRefs = (src.match(/useLiveState\(/g) || []).length
  check(src.indexOf('function useLiveState(') >= 0 && liveRefs >= 3, 'useLiveState 仍在（页头徽章 / LiveCapsule 继续用）', `refs=${liveRefs}`)
  check(src.indexOf('_subagentBar = { subagentBarModel: subagentBarModel, runningSubagentIds: runningSubagentIds }') >= 0, 'exports._subagentBar 暴露 runningSubagentIds')
  check(/function subagentBarModel\(sessions, sid\)/.test(src), 'subagentBarModel 签名改为 (sessions, sid)')
  check(src.indexOf("ctx.slots.inject('conversation.input.dock'") >= 0, '注册进 conversation.input.dock（输入框正上方）')
  check(src.indexOf("id: 'expert-team-subagents'") >= 0, '新 id（不撞 queue/todo/goal）')
  check(src.indexOf('.exp-subbusy{') >= 0 && src.indexOf('.exp-subbusy-idle{') >= 0, 'CSS 两类状态都在场')
  const bareCount = (src.match(/fetch\(['"]\/plugins\/dsh-expert-team\/state/gi) || []).length
  check(bareCount === 0, '没有裸 /state fetch（state-perf-guard 棘轮）', `bare=${bareCount}`)
  // 宽度回归（真机报障：状态条比输入框宽）：dock 条目必须让出侧边留白 + 居中，
  // 且宽度上限要取 min(可用宽度, 卡片自身上限 --dsh-composer-card-max-width)，绝不能 width:100%
  const busyRule = (src.match(/\.exp-subbusy\{[^']*\}/) || [''])[0]
  check(busyRule.indexOf('width:100%') < 0, '状态条不写 width:100%（否则比输入框宽）', busyRule.slice(0, 60))
  check(busyRule.indexOf('--dsh-composer-card-max-width') >= 0, '宽度上限取卡片上限（宽窗口下不会比输入框宽）')
  check(busyRule.indexOf('min(') >= 0 && busyRule.indexOf('--dsh-composer-side-clearance') >= 0, '同时让出侧边留白（窄窗口回退）')
  check(busyRule.indexOf('margin:0 auto') >= 0, 'margin:0 auto 居中（对齐输入框卡片）')
  // 新增：/state → liveRoles 的接线锚点（状态条不新增任何请求，只搭徽章/面板本来那趟车）
  check(src.indexOf('function harvestRoles(') >= 0, 'harvestRoles 在场（从 /state 的 agents[] 收角色名）')
  check(sliceFn('liveDeliver').indexOf('harvestRoles(') >= 0, 'liveDeliver（徽章轮询那一份）调用 harvestRoles')
  check(sliceFn('publishToLive').indexOf('harvestRoles(') >= 0, 'publishToLive（面板/画布发布那一份）调用 harvestRoles')
  check(barSrc.indexOf('modelInput.__roles = liveRoles') >= 0 && barSrc.indexOf('subagentBarModel(modelInput, sid)') >= 0, 'SubagentBar 把映射挂到浅拷贝上再交给 subagentBarModel')
  check(!/snap\.__roles\s*=/.test(barSrc) && barSrc.indexOf('hasOwnProperty.call(snap, k)') >= 0, '不写入收到的快照（宿主 store 的共享对象不被污染）')
}

console.log(`\n断言总数：${total}`)
if (fail) { console.error(`\n✗ subagent-bar：${fail} 项失败`); process.exit(1) }
console.log('\n✓ subagent-bar：全部通过')
