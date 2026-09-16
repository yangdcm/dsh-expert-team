#!/usr/bin/env node
// 专家团「分层画布」（canvas*）离线预览器 —— 把 client.js 里**真实的** CSS + canvas 分层函数
// 渲染成一份独立 HTML，供浏览器截图核对（本仓老问题：「浮层 UI 从未浏览器实测」）。
//
// 为什么需要：分层/成环/未知依赖/同层边这些是**派生语义**，纯 Node 断言测得出"level 对不对"，
// 测不出"画出来是不是一坨、窄宽下会不会撑破"。改完画布先在这里看一眼。
//
// ── 数据源纪律（本仓铁律：一次性的东西不许看起来像实测）────────────────────────
//   ① 若存在 browser-screenshots/real-state.json（真实 `GET /plugins/dsh-expert-team/state`
//      的落盘），**优先用它**，并在页头标注「真实 /state 负载」+ 文件路径 + 抓取时间戳；
//   ② 否则用**内置 fixture**，页头必须显式标注「fixture，不是真实 run」。
//   两条路径都**同时**渲染内置的三种合成形态（成环 / 未知依赖 / 无 dependsOn 降级）——
//   因为它们**在真实负载里根本不存在**，不合成出来就永远看不到。
//
// ── 实现未落盘时的行为（重要）──────────────────────────────────────────────
//   `canvas*` 函数由另一个 agent 落盘。缺函数时本脚本**优雅退出**（exit 1）并明确打印
//   「实现未落盘，缺哪些函数」——不写一个会崩栈的版本，也不产出半真半假的 HTML。
//
// 用法：
//   node scripts/preview-canvas.mjs [输出.html]
//   默认输出 <包根>/browser-screenshots/canvas-preview.html
//   （该目录不在 package.json 的 files 里，不会被发布）

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const CLIENT = join(PKG, 'client.js');
const REAL_STATE = join(PKG, 'browser-screenshots', 'real-state.json');

// ── 实现未落盘：明确报错 + 非零退出（不崩栈）─────────────────────────────────
function bail(lines) {
  console.error('✗ 画布预览器无法生成：实现未落盘。');
  for (const l of lines) console.error('  ' + l);
  console.error('  ⇒ 先让 client.js 落盘再跑（本脚本不会用假数据糊过去）。');
  process.exit(1);
}

let src = '';
try {
  src = await readFile(CLIENT, 'utf8');
} catch (e) {
  bail([`读不到 ${CLIENT}：${e && e.message}`]);
}

/** 抽一个函数声明（沿用本仓「抽源码」范式）。 */
function sliceFn(name, text = src) {
  const at = text.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`未能抽取 ${name}`);
  let i = text.indexOf('{', at), depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') { depth -= 1; if (depth === 0) return text.slice(at, j + 1); }
  }
  throw new Error(`${name} 花括号不平衡`);
}

// 必需函数（签名已冻结）。少任何一个 ⇒ 实现未落盘。
const REQUIRED = [
  'canvasLayers', 'canvasBlockedBy', 'canvasLayerTitle', 'canvasColumns',
  'canvasFormation', 'canvasEdges', 'roleAvatarColor', 'roleAvatarSvg',
  'etcHslHex', // roleAvatarColor 的纯算术依赖（少了它 roleAvatarColor 一调就 TypeError）
];
const missing = REQUIRED.filter((n) => !src.includes(`function ${n}(`));
if (missing.length) {
  bail([
    `client.js（${CLIENT}）里找不到这些函数声明：`,
    ...missing.map((n) => '  · ' + n),
    `（已找到的 canvas/roleAvatar 函数：${(src.match(/function (canvas\w+|roleAvatar\w+)\(/g) || []).join(', ') || '无'}）`,
  ]);
}

// ── CSS：从 `var CSS =` 到**下一条顶层语句**（与 client-css-integrity.test.mjs 同一锚点）──
// ⚠️ 不能用 `src.indexOf("'\n", cssAt)` 找"链尾"：那只覆盖**第一条** CSS 语句。
// 实测（2026-09-16）：`var CSS = '…'` 在偏移 42052 就结束了，后面还有 `CSS += '…'` 追加的
// **10181 字符**——`.etc-*`（新画布全部样式）正好在那一段里 ⇒ 用旧写法预览页里画布是**裸的**
// （`.etc-cols` 计算值退回 display:block、四列竖着堆），看起来像"设计坏了"，其实是预览器截断了 CSS。
const cssAt = src.indexOf('var CSS =');
if (cssAt < 0) bail(['找不到 `var CSS =`']);
const cssAnchor = src.indexOf('// ── session store', cssAt);
if (cssAnchor < 0) bail(['找不到 CSS 语句的结束锚点 `// ── session store`']);
let CSS = '';
try {
  CSS = new Function(`${src.slice(cssAt, cssAnchor).trimEnd()}\nreturn CSS;`)();
} catch (e) { bail([`CSS 链求值失败：${e && e.message}`]); }
// 反空转：新画布样式必须真的进来了，否则预览页会静默变成"裸 DOM"
if (typeof CSS !== 'string' || !CSS.includes('.etc-cols{')) {
  bail([`CSS 求值结果里没有 \`.etc-cols{\`（len=${typeof CSS === 'string' ? CSS.length : typeof CSS}）⇒ 画布样式没进来，预览页会是无样式的假象`]);
}

// ── 渲染辅助（必须先定义：sandbox 里 roleAvatarSvg 要用 h）───────────────────
const CAMEL = { className: 'class', strokeWidth: 'stroke-width', textAnchor: 'text-anchor', clipPath: 'clip-path', fontSize: 'font-size', fontWeight: 'font-weight', fillOpacity: 'fill-opacity', strokeOpacity: 'stroke-opacity', pointerEvents: 'pointer-events' };
const h = (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat(Infinity).filter((x) => x != null && x !== false) });
const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function toHtml(n) {
  if (n == null || n === false) return '';
  if (typeof n === 'string' || typeof n === 'number') return htmlEsc(n);
  if (Array.isArray(n)) return n.map(toHtml).join('');
  const { tag, props, kids } = n;
  if (!tag) return (kids || []).map(toHtml).join('');
  const attrs = Object.entries(props || {})
    .filter(([k, v]) => k !== 'key' && typeof v !== 'function' && v != null && v !== false)
    .map(([k, v]) => ` ${CAMEL[k] || k}="${htmlEsc(v).replace(/"/g, '&quot;')}"`).join('');
  return `<${tag}${attrs}>${(kids || []).map(toHtml).join('')}</${tag}>`;
}
const textsOf = (n, out = []) => {
  if (n == null || n === false) return out;
  if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((k) => textsOf(k, out)); return out; }
  (n.kids || []).forEach((k) => textsOf(k, out));
  return out;
};

// ── 沙箱：真实函数 + 本仓同款 helper ────────────────────────────────────────
const langNow = 'zh';
const S = {
  h, t: (zh) => zh, langNow, esc: (s) => htmlEsc(s == null ? '' : s),
  arrOf: (v) => (Array.isArray(v) ? v : (v == null ? [] : [v])),
  clipText: (v, maxUnits) => {
    const s = String(v == null ? '' : v);
    return s.length > maxUnits ? s.slice(0, Math.max(0, maxUnits - 1)) + '…' : s;
  },
  roleLabel: (r) => r,
  kindLabel: (k) => ({ work: '任务', review: '审查', test: '测试', repair: '返工', verification: '验证', implementation: '实现', research: '调研', design: '设计', doc: '文档' }[k] || k),
  stLabel: (s) => ({ pending: '待开始', claimed: '已领取', in_progress: '进行中', done: '已完成', completed: '完成', rework: '待返工', blocked: '受阻', failed: '失败', cancelled: '取消' }[s] || s),
  verdictLabel: (v) => ({ pass: '通过', needs_revision: '需修订', reject: '驳回' }[v] || v),
  own: (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k),
  ROLE_LABEL: {}, ROLES: [], ROLE_ORDER: [],
  // ── 桩 hook（canvasView 走的是**真 React hook**，Node 里跑不了真 React）────────
  // `useEffect` 故意**不执行**：`useCanvasEdges` 里要靠真 DOM 量 getBoundingClientRect，
  //   Node 里没有 DOM ⇒ 量不出来 ⇒ 箭头**一条都不画**（页面上会显式说明，不许冒充真机渲染）。
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init === undefined ? null : init }),
  useMemo: (fn) => fn(),
};
// 只读代理：源码里用到、这里没显式列出的**小 helper** 兜底 undefined，
// 免得一个显示层 helper 改名就让预览器整片崩掉。
// 注意：必须先落到**真全局**（Array/Number/String/Math/JSON…）——一律 undefined 会把全局内建一起挡掉，
// 于是 canvasLayers 第一行就 `Array.isArray` 崩（第一次真跑就是这么崩的）。
const PROXY = new Proxy(S, {
  has: () => true,
  get: (t, k) => (k === Symbol.unscopables ? undefined
    : (k in t ? t[k] : (typeof globalThis[k] !== 'undefined' ? globalThis[k] : undefined))),
});

let mod = null;
try {
  // 模块级常量：`roleAvatarColor` 用 ETC_ROLE_HUES、`roleAvatarSvg` 用 ETC_ROLE_SHAPE，
  // `phaseLabel`/`statusLabel` 用 PHASE_ZH / STATUS_ZH。它们是 `var` 声明（不是 `function`），
  // sliceFn 抽不到 ⇒ 必须显式带进 sandbox，否则一调就 TypeError（第一次真跑就是这么崩的）。
  // `var NAME = {...}` 可能跨行 ⇒ 按花括号/方括号配平切整条语句（单行常量也照此处理）
  const varSlice = (name) => {
    const at = src.indexOf(`var ${name} = `);
    if (at < 0) return '';
    let i = src.indexOf('=', at) + 1, d = 0;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '{' || c === '[') d += 1;
      else if (c === '}' || c === ']') { d -= 1; if (d === 0) return src.slice(at, i + 1); }
      else if (c === '\n' && d === 0) return src.slice(at, i);
    }
    return src.slice(at, i);
  };
  for (const need of ['ETC_ROLE_SHAPE', 'ETC_ROLE_HUES']) {
    if (!src.includes(`var ${need} = `)) bail([`找不到模块级常量 \`var ${need}\`（roleAvatarColor 依赖它）`]);
  }
  const consts = ['ETC_ROLE_SHAPE', 'ETC_ROLE_HUES', 'PHASE_ZH', 'STATUS_ZH'].map(varSlice).filter(Boolean).join('\n');
  // ── 编队/整视图那一半：canvasView + 它调用的渲染子节点 ────────────────────────
  // 与 REQUIRED 分开：少了它们**不退出**，只在页面上显式报"这一半渲染不出来"（不许静默少一节）。
  const VIEW_FNS = ['phaseLabel', 'statusLabel', 'stLabel', 'stBadgeCls', 'canvasBarCls', 'canvasMemberNode', 'canvasCardNode', 'canvasColNode', 'useCanvasEdges', 'canvasView'];
  const viewMissing = VIEW_FNS.filter((n) => !src.includes(`function ${n}(`));
  const viewOk = VIEW_FNS.filter((n) => !viewMissing.includes(n));
  const code = [consts, REQUIRED.map((n) => sliceFn(n)).join('\n'), viewOk.map((n) => sliceFn(n)).join('\n')].join('\n');
  mod = new Function('S', 'with (S) {\n' + code
    + '\nreturn { ' + REQUIRED.concat(viewOk).map((n) => `${n}: ${n}`).join(', ') + ' };\n}')(PROXY);
  globalThis.__VIEW_MISSING = viewMissing;
} catch (e) {
  bail([`函数抽取/求值失败：${e && e.message}`]);
}
const { canvasLayers, canvasBlockedBy, canvasLayerTitle, canvasColumns, canvasEdges, canvasFormation, roleAvatarColor, roleAvatarSvg, canvasView } = mod;
const VIEW_MISSING = globalThis.__VIEW_MISSING || [];

// ── 数据源：真实 /state 优先，否则内置 fixture（页头必须标明是哪一条）───────
function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let realData = null, realStat = null, realErr = '';
try {
  realStat = await stat(REAL_STATE);
  realData = JSON.parse(await readFile(REAL_STATE, 'utf8'));
} catch (e) { realErr = e && e.message; }

/** 从 /state 负载里取"当前 run"的一组任务 + 人员 + agents。 */
function pickReal(d) {
  const tasks = Array.isArray(d && d.tasks) ? d.tasks : [];
  const members = (d && d.members && typeof d.members === 'object') ? d.members : {};
  const agents = Array.isArray(d && d.agents) ? d.agents : [];
  return { tasks, members, agents, raw: d || {}, runId: (d && d.runId) || '', phase: (d && d.phase) || '', status: (d && d.status) || '' };
}

// ── 三种合成形态：真实负载里**根本没有**，不合成出来就永远看不到 ──────────────
const FIXTURE_MAIN = [
  { id: 'F1', title: 'fixture：现状调研', kind: 'work', owner: 'researcher', status: 'done', dependsOn: [] },
  { id: 'F2', title: 'fixture：规格初稿', kind: 'work', owner: 'pm', status: 'done', dependsOn: ['F1'] },
  { id: 'F3', title: 'fixture：交互设计', kind: 'work', owner: 'ui', status: 'in_progress', dependsOn: ['F2'] },
  { id: 'F4', title: 'fixture：契约冻结', kind: 'work', owner: 'architect', status: 'in_progress', dependsOn: ['F2'] },
  { id: 'F5', title: 'fixture：实现（最长路径 → 收尾层）', kind: 'work', owner: 'backend', status: 'pending', dependsOn: ['F3', 'F4'] },
  { id: 'F6', title: 'fixture：同层互赖（只计数不画边）', kind: 'work', owner: 'qa', status: 'pending', dependsOn: ['F5'] },
  { id: 'F7', title: 'fixture：与 F6 同层的另一支', kind: 'work', owner: 'docs', status: 'pending', dependsOn: ['F5'] },
  { id: 'F8', title: 'fixture：同层边（依赖同层的 F6）', kind: 'work', owner: 'devops', status: 'pending', dependsOn: ['F6'] },
];
const FIXTURE_CYCLE = [
  { id: 'CY1', title: 'fixture·成环 A↔B（A）', kind: 'work', owner: 'backend', status: 'pending', dependsOn: ['CY2'] },
  { id: 'CY2', title: 'fixture·成环 A↔B（B）', kind: 'work', owner: 'frontend', status: 'done', dependsOn: ['CY1'] },
  { id: 'CY3', title: 'fixture·自环 C→C', kind: 'work', owner: 'dba', status: 'pending', dependsOn: ['CY3'] },
];
const FIXTURE_UNKNOWN = [
  { id: 'UN1', title: 'fixture·未知依赖（dependsOn 指向不存在的 id）', kind: 'work', owner: 'sec', status: 'pending', dependsOn: ['nope-does-not-exist'] },
  { id: 'UN2', title: 'fixture·未知依赖 + 真实依赖并存', kind: 'work', owner: 'reviewer', status: 'pending', dependsOn: ['UN1', 'also-missing'] },
];
// tasksLive 降级：服务端投影**完全没有 dependsOn**（真实负载形态之一）
const FIXTURE_NODEPS = [
  { id: 'N1', title: 'fixture·降级：无 dependsOn（tasksLive 投影）', kind: 'work', owner: 'backend', status: 'done' },
  { id: 'N2', title: 'fixture·降级：无 dependsOn', kind: 'work', owner: 'qa', status: 'in_progress' },
  { id: 'N3', title: 'fixture·降级：无 dependsOn', kind: 'work', owner: 'docs', status: 'pending' },
];
const FIXTURE_MEMBERS = {
  pm: { name: 'Zoe', color: '#c04f4f', initial: 'Z', running: false, active: false, id: '' },
  architect: { name: 'Ivy', color: '#22b07d', initial: 'I', running: false, active: false, id: '' },
  backend: { name: 'Sam', color: '#8a7a3c', initial: 'S', running: true, active: true, id: 'a1' },
  qa: { name: 'Tina', color: '#e0913c', initial: 'T', running: false, active: false, id: '' },
  docs: { name: 'Dana', color: '#4b8fd6', initial: 'D', running: false, active: false, id: '' },
  unknownrole: { name: 'Nobody', color: '', initial: 'N', running: false, active: false, id: 'x9' },
};
const FIXTURE_AGENTS = [
  { id: 'a1', role: 'backend', activity: 'inactive', parentId: '', depth: 0 },
  { id: 'a2', role: 'unknownrole', activity: 'inactive', parentId: '', depth: 0 },
];

// ── 画布渲染（全部来自 client.js 真实函数；任何一列坏掉只影响该列）──────────
const esc2 = (s) => htmlEsc(s == null ? '' : s);
const statusClass = (s) => ({ completed: 'done', done: 'done', in_progress: 'run', claimed: 'run', rework: 'rework', failed: 'failed', blocked: 'failed' }[s] || 'idle');

function taskCard(t, byId) {
  const blocked = canvasBlockedBy(t, byId);
  const bits = [`<span class="pc-st ${statusClass(t.status)}">${esc2(S.stLabel(t.status))}</span>`];
  if (t.owner) bits.push(`<span class="pc-own">${esc2(S.roleLabel(t.owner))}</span>`);
  if ((t.dependsOn || []).length) bits.push(`<span class="pc-dep">依赖 ${esc2((t.dependsOn || []).join(', '))}</span>`);
  if (blocked.length) bits.push(`<span class="pc-blk">受阻 ← ${esc2(blocked.join(', '))}</span>`);
  else bits.push('<span class="pc-ok">就绪</span>');
  return `<div class="pc-card"><div class="pc-card-h"><b>${esc2(t.id)}</b>${bits.join('')}</div>`
    + `<div class="pc-title">${esc2(t.title)}</div></div>`;
}

function columnBlock(col, byId) {
  const kindCls = col.kind === 'cycle' ? 'cycle' : (col.kind === 'unknown' ? 'unknown' : 'layer');
  const note = col.note ? `<div class="pc-col-note">${esc2(col.note)}</div>` : '';
  const cards = (col.tasks || []).map((t) => taskCard(t, byId)).join('') || '<div class="pc-empty">（无任务）</div>';
  return `<section class="pc-col ${kindCls}">
  <header class="pc-col-h"><h3>${esc2(col.title)}</h3>
    <span class="pc-count">${Number(col.done) || 0}/${Number(col.total) || 0}</span>
    ${Number(col.blocked) ? `<span class="pc-blk">受阻 ${Number(col.blocked)}</span>` : ''}
    <span class="pc-kind">${esc2(col.kind)}</span></header>
  ${note}${cards}</section>`;
}

function edgesBlock(e) {
  const rows = (e.edges || []).map((x) => `<li><code>${esc2(x.from)} → ${esc2(x.to)}</code> <span class="pc-st ${x.satisfied ? 'done' : 'idle'}">${x.satisfied ? '已满足' : '未满足'}</span></li>`).join('');
  return `<ul class="pc-edges">${rows || '<li>（无边）</li>'}
    <li class="pc-sum">跳过同层边 <b>${Number(e.skippedSameLayer) || 0}</b> · 成环 <b>${Number(e.cycles) || 0}</b> · 未知依赖 <b>${Number(e.unknownDeps) || 0}</b></li></ul>`;
}

function rolesBlock(members, agents) {
  const keys = Object.keys(members || {});
  const rows = keys.map((role) => {
    const m = members[role] || {};
    const isKnown = ['pm', 'architect', 'researcher', 'ui', 'backend', 'frontend', 'dba', 'sec', 'reviewer', 'qa', 'devops', 'docs'].includes(role);
    const color = roleAvatarColor(role, m.color || null);
    let ava = '';
    try { ava = toHtml(roleAvatarSvg(role, { size: 36, color: m.color || null, initial: m.initial, name: m.name, lead: false })); }
    catch (e) { ava = `<span class="pc-ava-err" title="${esc2(e && e.message)}">svg 渲染抛错</span>`; }
    return `<div class="pc-role">${ava}<div><b>${esc2(S.roleLabel(role))}</b>
      <div class="pc-role-meta">${esc2(m.name || '')} · <code>${esc2(color)}</code>${m.color ? ' （真实色）' : ' （回退色）'} · ${isKnown ? '已知 role' : '未知 role'}</div></div></div>`;
  }).join('');
  const unknown = keys.filter((r) => !['pm', 'architect', 'researcher', 'ui', 'backend', 'frontend', 'dba', 'sec', 'reviewer', 'qa', 'devops', 'docs'].includes(r));
  const pair = roleAvatarColor('backend', null) !== roleAvatarColor('xyz', null);
  const agentsNote = `<div class="pc-col-note">agents=${(agents || []).length} 条；未知 role 徽章色与已知 role 不撞色：<b>${pair ? '是' : '否（红）'}</b></div>`;
  return `<div class="pc-roles">${rows || '<div class="pc-empty">（无成员）</div>'}</div>${agentsNote}`;
}

function canvasBlock(title, tasks, members, agents, banner) {
  const byId = {};
  for (const t of tasks) if (t && t.id) byId[t.id] = t;
  const L = canvasLayers(tasks);
  const cols = canvasColumns(tasks);
  const e = canvasEdges(tasks);
  const deg = (L.hasDeps === false)
    ? `<div class="pc-warn">⚠ hasDeps=<b>false</b> ⇒ 这组任务**没有 dependsOn**（tasksLive 投影形态）：canvasColumns 必须只给 <b>1 列 kind=unknown</b>，实际 ${cols.length} 列［${cols.map((c) => c.kind).join(',')}］</div>`
    : '';
  return `<section class="pc-block">
  <h2>${esc2(title)}</h2>
  ${banner || ''}${deg}
  <div class="pc-meta">hasDeps=<b>${L.hasDeps}</b> · 层数=<b>${L.layers.length}</b> · maxLayer=<b>${L.maxLayer}</b>
    · level=${esc2(JSON.stringify(L.level))} · cycles=[${esc2((L.cycles || []).join(','))}]
    · unknownDeps=${esc2(JSON.stringify(L.unknownDeps || []))}</div>
  <div class="pc-cols">${cols.map((c) => columnBlock(c, byId)).join('')}</div>
  ${edgesBlock(e)}</section>`;
}

// ── 页头：数据源必须一眼可辨（真实 or fixture + 时间戳 + 路径）───────────────
const srcBadge = realData
  ? `<div class="pc-src real">数据源：<b>真实 /state 负载</b> · 文件 <code>${esc2(REAL_STATE)}</code>
      · 文件抓取/落盘时间 <b>${esc2(nowStamp(realStat.mtime))}</b> · 本次渲染 <b>${esc2(nowStamp())}</b>
      · runId=<code>${esc2(pickReal(realData).runId)}</code> phase=<code>${esc2(pickReal(realData).phase)}</code></div>`
  : `<div class="pc-src fixture">数据源：<b>内置 fixture（不是真实 run）</b> · 未找到 <code>${esc2(REAL_STATE)}</code>
      ${realErr ? `（${esc2(realErr)}）` : ''} · 本次渲染 <b>${esc2(nowStamp())}</b></div>`;

const bannerFixture = (what) => `<div class="pc-src fixture">⚠ 本节是 <b>fixture</b>：${esc2(what)}。真实负载里没有这种形态，故合成出来核对。</div>`;

// ── §0 画布全貌：真跑 canvasView（**桩 hook**，不是真 React）────────────────────
// 为什么必须另立本节：上面几节只覆盖 canvasColumns/canvasEdges/roleAvatarSvg ⇒ 设计稿**上半部**
// （队长居中置顶 + 虚线总线 + 成员落线 + 状态行/进度条）会完全没有视觉证据。
// 诚实边界（页面必须写明，不许让它看起来像真机渲染）：
//   · hook 是桩：useState 不触发重渲染、useEffect 不执行 ⇒ 依赖 DOM 测量的 `useCanvasEdges`
//     返回 [] ⇒ **箭头一条都不画**（画不出来就说画不出来，不猜位置）。
//   · 因此本节同时用 `canvasEdges()` 的文字清单把"本该画哪些边"如实列出来。
function viewBlock(real, title, widthNote, containerPx) {
  const banner = `<div class="pc-src fixture">⚠ <b>canvasView 全貌 · 桩 hook 渲染</b>：数据源=${real ? '<b>真实 /state 负载</b>（' + esc2(REAL_STATE) + '，落盘 ' + esc2(nowStamp(realStat.mtime)) + '）' : '<b>内置 fixture（不是真实 run）</b>'}
    · hook 为桩（<code>useState/useEffect/useRef/useMemo</code>）⇒ <b>箭头不绘制</b>：箭头坐标要靠真实 DOM 的 <code>getBoundingClientRect</code> 测量，Node 里没有 DOM（"量不出来" ≠ "没有依赖"）。${esc2(widthNote)}</div>`;
  if (!canvasView) {
    return `<section class="pc-block"><h2>${esc2(title)}</h2>${banner}
      <div class="pc-warn">✗ 这一半渲染不出来：client.js 里缺 ${esc2(VIEW_MISSING.join(', ')) || 'canvasView'}。</div></section>`;
  }
  let html = '', err = '';
  try {
    const el = canvasView({
      tasks: real ? real.tasks : FIXTURE_MAIN,
      members: real ? real.members : FIXTURE_MEMBERS,
      agents: real ? real.agents : FIXTURE_AGENTS,
      data: real ? real.raw : { phase: 'implement', status: 'running', membersUnresolved: true },
      selectedId: real ? (real.tasks[0] && real.tasks[0].id) : 'F3',
      onPick: null,
    });
    html = toHtml(el);
  } catch (e) { err = String((e && e.message) || e); }
  const eg = canvasEdges(real ? real.tasks : FIXTURE_MAIN);
  const edgeList = (eg.edges || []).map((x) => `${x.from}→${x.to}${x.satisfied ? '(已满足)' : '(未完成)'}`).join('  ');
  return `<section class="pc-block"><h2>${esc2(title)}</h2>${banner}
    ${err ? `<div class="pc-warn">✗ canvasView 抛错：${esc2(err)}</div>` : ''}
    <div class="pc-view-scope"${containerPx ? ` style="width:${Number(containerPx)}px;max-width:100%"` : ''}>${html}</div>
    <div class="pc-meta">桩 hook 渲染；<b>箭头 0 条</b>（DOM 无法测量）。本该画的依赖边（<code>canvasEdges()</code> 文字清单，共 ${(eg.edges || []).length} 条）：
      <code>${esc2(edgeList || '（无边）')}</code></div>
    <div class="pc-meta">跳过同层边 ${Number(eg.skippedSameLayer) || 0} · 成环 ${Number(eg.cycles) || 0} · 未知依赖 ${Number(eg.unknownDeps) || 0}</div></section>`;
}

const viewSections = [];
{
  // 真实负载里 `membersUnresolved` 缺省 ⇒ 用原始 data 对象（page 上如实在 note 里反映 phase/status）
  const r = realData ? pickReal(realData) : null;
  viewSections.push(viewBlock(r, '§0 画布全貌：canvasView（真实 canvas.js 函数 + 桩 hook）· 全宽', '', 0));
  viewSections.push(viewBlock(r, '§0b 同一份 canvasView 放进 420px 容器（**容器约束，不是真机视口**）', ' 本节把同一份渲染结果放进 width:420px 的容器，用于核对"窄宽不撑破"。', 420));
}

const blocks = [];
if (realData) {
  const r = pickReal(realData);
  blocks.push(canvasBlock(`真实负载：${r.runId || '(无 runId)'}（tasks=${r.tasks.length}）`, r.tasks, r.members, r.agents));
}
blocks.push(canvasBlock('合成形态 1：正常 DAG（最长路径 / 同层边 / 收尾层）', FIXTURE_MAIN, FIXTURE_MEMBERS, FIXTURE_AGENTS, bannerFixture('分层/同层边/收尾层，真实负载里凑不齐')));
blocks.push(canvasBlock('合成形态 2：成环 A↔B + 自环 C→C', FIXTURE_CYCLE, FIXTURE_MEMBERS, FIXTURE_AGENTS, bannerFixture('环：真实负载里没有，必须证明"不崩、不塞进某层"')));
blocks.push(canvasBlock('合成形态 3：未知依赖 dependsOn=[不存在的 id]', FIXTURE_UNKNOWN, FIXTURE_MEMBERS, FIXTURE_AGENTS, bannerFixture('未知依赖：真实负载里没有，必须证明"不崩、不消失"')));
blocks.push(canvasBlock('合成形态 4：没有 dependsOn（tasksLive 降级）', FIXTURE_NODEPS, FIXTURE_MEMBERS, FIXTURE_AGENTS, bannerFixture('tasksLive 投影完全没有 dependsOn ⇒ 只许单列 kind=unknown')));

const rolesHtml = `<section class="pc-block"><h2>角色徽章（roleAvatarColor / roleAvatarSvg 真实函数）</h2>
  <div class="pc-src fixture">⚠ 人员取自：${realData ? '真实负载 members' : 'fixture members'}；<code>xyz</code> 用于证明未知 role 不复用已知 role 的色。</div>
  ${rolesBlock(realData ? pickReal(realData).members : FIXTURE_MEMBERS, realData ? pickReal(realData).agents : FIXTURE_AGENTS)}</section>`;

const out = process.argv[2] || join(PKG, 'browser-screenshots', 'canvas-preview.html');
await mkdir(dirname(out), { recursive: true });

await writeFile(out, `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>专家团 · 分层画布预览</title>
<style>
  :root{--dsw-alias-bg-layer-2:#f6f8fa;--dsw-alias-border-l2:#d0d7de;--dsw-alias-border-l1:#e6e9ee;--dsw-alias-label-primary:#1f2328;--dsw-alias-label-secondary:#57606a;--dsw-alias-label-tertiary:#8b949e;--dsw-alias-state-business-primary:#0969da;--dsw-alias-state-business-tertiary:#ddf4ff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-base:#fff;--dsw-alias-bg-module-platform:#f6f8fa;--dsw-alias-interactive-bg-hover:#f3f5f8;--dsw-alias-state-warn-tertiary:#fff7ea;
    --etv-run:#3b6ef5;--etv-ok:#22b07d;--etv-rework:#d97706;--etv-fail:#c0392b;--etv-idle:#9aa4b2;--etv-line:#dfe4ec;--etv-text-run:#3b6ef5;--etv-text-ok:#22b07d;--etv-text-rework:#d97706;--etv-gap:8px;--etv-indent:14px;--etv-card-min:140px;--etv-wave-gap:10px;
}
  /* ⚠️ 这里**故意不写** --etc-* 一族：画布配色的单一真源是 client.js 自己的 .etc-root{--etc-line/--etc-ok/…}
     （随上面的 CSS 链一起注入）。预览页再抄一份同名"猜值"= 两套 token 漂移。
     2026-09-16 实测过这个坑：曾以为"缺宿主 token"，实际是 CSS 链被截断、.etc-* 规则整段没进来。 */
  body{margin:0;padding:18px;background:#fff;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;color:#1f2328}
  h1{font-size:16px;margin:0 0 6px} h2{font-size:13.5px;margin:18px 0 6px}
  .pc-src{font-size:11.5px;line-height:1.6;border-radius:8px;padding:6px 9px;margin:0 0 10px;border:1px solid var(--dsw-alias-border-l2)}
  .pc-src.real{background:#eefaf3;border-color:#9fd9bd} .pc-src.fixture{background:#fff7ea;border-color:#f0cfa0;color:#8a5a00}
  .pc-warn{font-size:11.5px;background:#fff3f2;border:1px solid #f0b6ae;color:#8a2a20;border-radius:8px;padding:6px 9px;margin:0 0 8px}
  .pc-meta{font-size:10.5px;color:#57606a;font-family:ui-monospace,Menlo,monospace;margin:0 0 8px;word-break:break-all}
  .pc-cols{display:flex;gap:10px;align-items:flex-start;overflow-x:auto;padding-bottom:6px}
  .pc-col{flex:0 0 226px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:#fbfcfe;padding:7px 8px}
  .pc-col.cycle{background:#fff7f5;border-color:#f0b6ae} .pc-col.unknown{background:#fbf7ee;border-color:#f0cfa0}
  .pc-col-h{display:flex;align-items:center;gap:6px;margin:0 0 6px;flex-wrap:wrap}
  .pc-col-h h3{font-size:12px;margin:0}
  .pc-count{font-size:10.5px;font-weight:700;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:1px 6px}
  .pc-kind{font-size:9.5px;color:#8b949e;margin-left:auto;font-family:ui-monospace,monospace}
  .pc-col-note{font-size:10.5px;color:#57606a;margin:0 0 6px}
  .pc-card{border:1.4px solid var(--etv-idle);border-radius:8px;background:#fff;padding:5px 7px;margin:0 0 6px}
  .pc-card-h{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px}
  .pc-title{font-size:11px;color:#1f2328;margin-top:2px;line-height:1.35}
  .pc-st{font-size:9.5px;border-radius:7px;padding:0 5px;border:1px solid var(--etv-idle);color:#57606a}
  .pc-st.done{color:#186b4c;border-color:var(--etv-ok);background:rgba(34,176,125,.10)}
  .pc-st.run{color:#274b9f;border-color:var(--etv-run);background:rgba(59,110,245,.08)}
  .pc-st.rework{color:#8a5a00;border-color:var(--etv-rework);background:rgba(217,119,6,.10)}
  .pc-st.failed{color:#8a2a20;border-color:var(--etv-fail);background:rgba(192,57,43,.09)}
  .pc-own,.pc-dep{font-size:9.5px;color:#8b949e}
  .pc-blk{font-size:9.5px;color:#8a2a20} .pc-ok{font-size:9.5px;color:#186b4c}
  .pc-edges{list-style:none;margin:6px 0 0;padding:0;font-size:11px;display:flex;flex-wrap:wrap;gap:4px 12px}
  .pc-sum{color:#57606a}
  .pc-roles{display:flex;flex-wrap:wrap;gap:10px}
  .pc-role{display:flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:5px 9px;font-size:11.5px}
  .pc-role-meta{font-size:10px;color:#57606a}
  .pc-empty{font-size:11px;color:#8b949e}
  .pc-ava-err{font-size:10px;color:#8a2a20;border:1px dashed #f0b6ae;border-radius:6px;padding:2px 5px}
  .pc-foot{font-size:10.5px;color:#8b949e;margin-top:14px;border-top:1px solid #e6e9ee;padding-top:8px}
  .pc-view-scope{background:#f0f3f8;padding:10px;border-radius:10px;overflow-x:auto}
  .pc-view-scope .etc-root{background:#fff;border-radius:8px;padding:10px}
${CSS}
</style></head><body>
<h1>专家团 · 分层画布预览（真实 client.js CSS + canvas* 函数输出）</h1>
${srcBadge}
${viewSections.join('\n')}
<div class="pc-src fixture">⚠ 下面几节的"合成形态"都<b>不是</b>真实 run，只为核对真实负载里不存在的三种形态：<b>成环</b> / <b>未知依赖</b> / <b>无 dependsOn（tasksLive 降级）</b>。</div>
${blocks.join('\n')}
${rolesHtml}
<div class="pc-foot">生成时间 ${esc2(nowStamp())} · client.js md5 未记录 · 由 <code>npm run preview:canvas</code> 生成；
窄宽（≈420px）下 <code>.pc-cols</code> 横向滚动，不应撑破视口。</div>
</body></html>
`, 'utf8');

console.log(`已生成：${out}`);
console.log(`数据源：${realData ? `真实 /state 负载（${REAL_STATE}，落盘 ${nowStamp(realStat.mtime)}）` : `内置 fixture（未找到 ${REAL_STATE}${realErr ? '：' + realErr : ''}）`}`);
console.log(`含合成形态：成环 / 未知依赖 / 无 dependsOn 降级（真实负载里没有）`);
console.log(`file://${pathToFileURL(out).pathname}`);
