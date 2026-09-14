// 测试：任务依赖图（DAG）的**状态展示必须明显、且会动**
//
// 用户报障（截图，2026-09-11）：「状态给一个明显的展示，动态的」——
// 此前节点上只有一个 4px 圆点，状态文字只存在于顶部图例里，看图得靠颜色猜；
// 面板每 2.5s 轮询、状态是跳变的，也看不出"刚刚谁变了"。
//
// 修法：
//   · 每张卡：状态色柔底 + 左侧状态色条 + **底部状态带（图标 + 中文状态）**（"明显的展示"）
//   · 运行中/已领取：状态带流光 + 描边脉冲；**状态变更闪两下**（"动态的"）
//   · 图例：状态胶囊 + **实时计数**
//
// 本测试做两件事：① 纯函数行为（状态元数据 / 计数 / 变更检测）；
// ② **真渲染**：用 client.js 里真实的 dagSvg（stub 掉 h/t/esc）渲染一组覆盖全部状态的
//    任务，断言每张卡都带自己的中文状态文字与状态带 —— 这才是"看得见"的机器化保证
//    （纯源码 grep 测不出"状态有没有渲染到卡上"）。
//
// 变异验证：M43（变更不闪）/ M44（状态带只画图标不写状态）/ M45（运行中不加流光）
// 运行：node dag-status.test.mjs

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

// ── 抽源码（本仓范式）：把 DAG 相关的真实实现装进一个 sandbox ────────────────
function sliceFn(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) { console.error(`✗ 未能抽取 ${name}`); process.exit(1); }
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
  }
  console.error(`✗ ${name} 花括号不平衡`); process.exit(1);
}
const constLine = src.match(/var NODE_W = \d+, NODE_H = \d+, HGAP = \d+, VGAP = \d+/)[0];
const code = [
  constLine,
  src.slice(src.indexOf('var ST_COLOR ='), src.indexOf('\n', src.indexOf('var ST_COLOR ='))),
  sliceFn('stColor'), sliceFn('stLabel'),
  src.slice(src.indexOf('var DAG_STATUS_ORDER'), src.indexOf('    function dagStatusMeta(')),
  sliceFn('dagStatusMeta'), sliceFn('dagStatusOrder'), sliceFn('dagStatusCounts'), sliceFn('dagStatusFlash'),
  'var DAG_FLASH = {}', 'var DAG_STATUS_SNAP = {}', 'var DAG_RENDER_SEQ = 0',
  sliceFn('arrOf'), sliceFn('clipText'), sliceFn('dagLayout'), sliceFn('dagSvg'),
].join('\n');

const strip = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '');
const h = (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat(Infinity).filter((x) => x != null && x !== false) });
const stubs = {
  h, esc: strip, langNow: 'zh', t: (zh) => zh,
  arrOf: (v) => (Array.isArray(v) ? v : (v == null ? [] : [v])),
  kindLabel: (k) => ({ work: '任务', review: '审查', test: '测试', repair: '返工', verification: '验证' }[k] || k),
  roleLabel: (r) => r,
  verdictLabel: (v) => ({ pass: '通过', needs_revision: '需修订', reject: '驳回' }[v] || v),
};
const mod = new Function('S', `with (S) {\n${code}\nreturn { dagSvg: dagSvg, dagStatusMeta: dagStatusMeta, dagStatusOrder: dagStatusOrder, dagStatusCounts: dagStatusCounts, dagStatusFlash: dagStatusFlash, DAG_STATUS_ORDER: DAG_STATUS_ORDER };\n}`)(stubs);
const { dagSvg, dagStatusMeta, dagStatusOrder, dagStatusCounts, dagStatusFlash, DAG_STATUS_ORDER } = mod;

/** 收集渲染树里的全部文本节点（= 卡上真正写出来的字）。 */
function texts(n, out = []) {
  if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
  if (n && n.kids) n.kids.forEach((k) => texts(k, out));
  return out;
}
const withStatus = (status, id = 'T-1') => [{ id, title: '某任务标题', kind: 'work', owner: 'backend', status }];

console.log('# 任务依赖图 · 状态展示（明显 + 动态）\n');

console.log('① 状态元数据：每个状态都有中文标签 / 颜色 / 状态带色 / 图标');
{
  const want = { pending: '待开始', claimed: '已领取', in_progress: '进行中', done: '已完成', rework: '待返工', failed: '失败', blocked: '受阻', cancelled: '取消' };
  for (const [k, label] of Object.entries(want)) {
    const m = dagStatusMeta(k);
    check(m.label === label && !!m.color && !!m.band && !!m.icon, `${k} → ${label} / ${m.icon}`, `${m.label} ${m.color} ${m.band} ${m.icon}`);
  }
  check(dagStatusMeta('completed').label === '已完成', 'completed 与 done 同口径', dagStatusMeta('completed').label);
  check(dagStatusMeta('外星状态').key === 'pending', '未知状态兜底 pending', dagStatusMeta('外星状态').key);
  check(dagStatusMeta('in_progress').active === true && dagStatusMeta('claimed').active === true && dagStatusMeta('done').active === false, '只有进行中/已领取算"活跃"（要流光 + 脉冲）');
}

console.log('\n② 图例：顺序固定 + 实时计数（completed 并入 done）');
{
  check(JSON.stringify(dagStatusOrder()) === JSON.stringify(DAG_STATUS_ORDER), '图例顺序 = 规范顺序', dagStatusOrder().join(','));
  const counts = dagStatusCounts([{ status: 'in_progress' }, { status: 'in_progress' }, { status: 'done' }, { status: 'completed' }, { status: 'pending' }, { status: 'x' }]);
  check(counts.in_progress === 2 && counts.done === 2 && counts.pending === 2, '计数正确（done+completed 合并、未知计 pending）', JSON.stringify(counts));
}

console.log('\n③ 变更检测：首见不闪、变化才闪、窗口内持续、超窗停');
{
  const t1 = [{ id: 'a', status: 'pending' }, { id: 'b', status: 'done' }];
  const first = dagStatusFlash(t1, 1000, 1500, {});
  check(Object.keys(first.flash).length === 0, '首次见到（无快照）不闪（否则打开面板满屏乱闪）', JSON.stringify(first.flash));
  const same = dagStatusFlash(t1, 2000, 1500, first.snapshot);
  check(Object.keys(same.flash).length === 0, '状态没变不闪');
  const t2 = [{ id: 'a', status: 'in_progress' }, { id: 'b', status: 'done' }];
  const changed = dagStatusFlash(t2, 2500, 1500, same.snapshot);
  check(changed.flash.a === true && !changed.flash.b, 'a 从待开始→进行中：闪', JSON.stringify(changed.flash));
  const still = dagStatusFlash(t2, 3000, 1500, changed.snapshot);
  check(still.flash.a === true, '窗口内（2500+1500）继续闪');
  const expired = dagStatusFlash(t2, 9000, 1500, changed.snapshot);
  check(!expired.flash.a, '超窗（2500+1500 之后）停闪');
}

console.log('\n④ 真渲染：每张卡都必须写出**自己的中文状态文字** + 状态带（明显的展示）');
{
  for (const k of ['pending', 'claimed', 'in_progress', 'done', 'rework', 'failed', 'blocked']) {
    const m = dagStatusMeta(k);
    const tree = dagSvg(withStatus(k), () => {}, null, null, null);
    const all = texts(tree);
    check(all.some((x) => x === `${m.icon} ${m.label}`), `节点卡上写着「${m.icon} ${m.label}」`, all.filter((x) => /进行中|已完成|待开始|失败|受阻|待返工|已领取/.test(x)).join(' | '));
    const flat = JSON.stringify(tree);
    check(flat.includes('exp-node-bar'), `${k}：有状态带`, '');
  }
  const runFlat = JSON.stringify(dagSvg(withStatus('in_progress'), () => {}, null, null, null));
  check(runFlat.includes('exp-node-bar-run'), '进行中：状态带带流光动画类');
  check(runFlat.includes('exp-node-run'), '进行中：描边带脉冲动画类');
  const doneFlat = JSON.stringify(dagSvg(withStatus('done'), () => {}, null, null, null));
  check(!doneFlat.includes('exp-node-bar-run'), '已完成：不加流光（不给完成态制造"还在跑"的错觉）');
}

console.log('\n⑤ 动画与状态带样式确实存在（CSS 层）');
{
  for (const need of ['exp-bar-shimmer', 'exp-node-flash', 'exp-node-bar-run', '.exp-legend-item']) {
    check(src.includes(need), `CSS 含 ${need}`);
  }
}

console.log('');
if (fail > 0) {
  console.log(`✗ DAG 状态展示测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ DAG 状态展示测试通过（每张卡写明中文状态 + 状态带；运行中流光/脉冲；变更闪烁；图例实时计数）');
