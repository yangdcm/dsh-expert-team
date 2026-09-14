#!/usr/bin/env node
// 任务依赖图（DAG）离线预览器 —— 把 client.js 里**真实的** CSS + dagSvg 渲染成独立 HTML，
// 供浏览器截图核对视觉效果（本仓的老问题：「浮层 UI 从未浏览器实测」）。
//
// 为什么需要：DAG 是 SVG + CSS 动画，纯 Node 断言测得出"状态文字在不在"，但测不出
// "状态看不看得见""动画动不动"。这个预览器复用真源码，改完 UI 先在这里看一眼。
//
// 用法：
//   node scripts/preview-dag.mjs [输出.html]      # 默认 <工作区>/browser-screenshots/dag-status-preview.html
// 然后用浏览器打开该文件（或 node scripts/preview-dag.mjs 后用 Playwright 截图）。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const src = await readFile(join(PKG, 'client.js'), 'utf8');

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

// ── CSS：从 `var CSS =` 到赋值链结尾 ──────────────────────────────────────
const cssAt = src.indexOf('var CSS =');
if (cssAt < 0) throw new Error('找不到 var CSS');
// 链的中间行都以 `' +` 结尾，最后一行是「行尾引号、后面没有 +」（末尾分号由 ASI 省略）
const cssEnd = src.indexOf("'\n", cssAt);
if (cssEnd < 0) throw new Error('找不到 CSS 赋值链结尾');
const cssExpr = src.slice(cssAt + 'var CSS ='.length, cssEnd + 1);
const CSS = new Function(`return (${cssExpr})`)();

// ── 依赖的小函数 + 常量 ────────────────────────────────────────────────────
const constLine = src.match(/var NODE_W = \d+, NODE_H = \d+, HGAP = \d+, VGAP = \d+/)[0];
const code = [
  constLine,
  src.slice(src.indexOf('var ST_COLOR ='), src.indexOf('\n', src.indexOf('var ST_COLOR ='))),
  sliceFn('stColor'), sliceFn('stLabel'), sliceFn('dagStatusMeta'), sliceFn('dagStatusFlash'),
  // DAG_STATUS_ORDER + DAG_STATUS_META（多行对象）→ 一直取到 dagStatusMeta 声明之前
  src.slice(src.indexOf('var DAG_STATUS_ORDER'), src.indexOf('    function dagStatusMeta(')),
  sliceFn('dagStatusOrder'), sliceFn('dagStatusCounts'),
  'var DAG_FLASH = {}', 'var DAG_STATUS_SNAP = {}', 'var DAG_RENDER_SEQ = 0',
  sliceFn('arrOf'), sliceFn('clipText'), sliceFn('dagLayout'), sliceFn('dagSvg'),
].join('\n');

const t = (zh) => zh;
const strip = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '');
const stubs = {
  t, langNow: 'zh', arrOf: (v) => (Array.isArray(v) ? v : (v == null ? [] : [v])),
  kindLabel: (k) => ({ work: '任务', review: '审查', test: '测试', repair: '返工', verification: '验证' }[k] || k),
  roleLabel: (r) => ({ pm: '产品', architect: '架构', researcher: '调研', ui: 'UI 设计师', backend: '后端', frontend: '前端', dba: '数据工程师', sec: '安全审计员', reviewer: '审查官', qa: '测试员', devops: '运维', docs: '文档工程师' }[r] || r),
  verdictLabel: (v) => ({ pass: '通过', needs_revision: '需修订', reject: '驳回' }[v] || v),
  esc: strip,
};
// ── 渲染辅助（必须先定义：sandbox 里 dagSvg 要用 h）──────────────────────
// className→class、camelCase→kebab，模拟 React 对 SVG 的输出
const CAMEL = { className: 'class', strokeWidth: 'stroke-width', textAnchor: 'text-anchor', clipPath: 'clip-path', fontSize: 'font-size', fontWeight: 'font-weight', fillOpacity: 'fill-opacity', strokeOpacity: 'stroke-opacity', pointerEvents: 'pointer-events' };
const h = (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat(Infinity).filter((x) => x != null && x !== false) });
const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function toHtml(n) {
  if (typeof n === 'string' || typeof n === 'number') return htmlEsc(n);
  const { tag, props, kids } = n;
  const attrs = Object.entries(props)
    .filter(([k, v]) => k !== 'key' && typeof v !== 'function' && v != null)
    .map(([k, v]) => ` ${CAMEL[k] || k}="${htmlEsc(v).replace(/"/g, '&quot;')}"`).join('');
  return `<${tag}${attrs}>${kids.map(toHtml).join('')}</${tag}>`;
}

const dagMod = new Function('S', `with (S) {\n${code}\nreturn { dagSvg: dagSvg, dagStatusOrder: dagStatusOrder, dagStatusMeta: dagStatusMeta, dagStatusCounts: dagStatusCounts };\n}`)({ ...stubs, h });
const { dagSvg, dagStatusOrder, dagStatusMeta, dagStatusCounts } = dagMod;

const tasks = [
  { id: 're-1', title: '现状调研：评论模块存量代码', kind: 'work', owner: 'researcher', status: 'done', dependsOn: [] },
  { id: 're-2', title: '竞品与合规调研：评论互动', kind: 'work', owner: 'researcher', status: 'done', dependsOn: [] },
  { id: 'pm-1', title: 'Ultra Spec 初稿：PRD / SPEC', kind: 'work', owner: 'pm', status: 'done', dependsOn: ['re-1', 're-2'] },
  { id: 'pm-2', title: '范围收敛修订：落地 7 条', kind: 'work', owner: 'pm', status: 'in_progress', dependsOn: ['pm-1'] },
  { id: 'ui-1', title: '通用评论组件交互与视觉设计', kind: 'work', owner: 'ui', status: 'in_progress', dependsOn: ['pm-1'] },
  { id: 'ar-1', title: '签名级契约冻结与任务拆解', kind: 'work', owner: 'architect', status: 'in_progress', dependsOn: ['pm-1'] },
  { id: 'db-1', title: '数据契约与迁移脚本草案', kind: 'work', owner: 'dba', status: 'claimed', dependsOn: ['ar-1'] },
  { id: 'se-1', title: '安全与合规审计（设计阶段）', kind: 'review', owner: 'sec', status: 'pending', dependsOn: ['ar-1'] },
  { id: 'do-1', title: '上线/灰度/回滚手册', kind: 'work', owner: 'devops', status: 'pending', dependsOn: ['ar-1'] },
  { id: 'rv-1', title: '规格多视角交叉评审', kind: 'review', owner: 'reviewer', status: 'rework', dependsOn: ['db-1', 'se-1', 'do-1'], round: 2, attempt: 2, verdict: 'needs_revision' },
  { id: 'qa-1', title: '测试计划与验收用例（本轮）', kind: 'test', owner: 'qa', status: 'blocked', dependsOn: ['rv-1'] },
  { id: 'dc-1', title: '交付说明与后续实现指引', kind: 'work', owner: 'docs', status: 'failed', dependsOn: ['rv-1'], attempt: 3 },
];

const svg = toHtml(dagSvg(tasks, () => {}, 'ar-1', null, null));
// 图例：与面板同一份 helpers（状态胶囊 + 实时计数），保证预览=运行时
const counts = dagStatusCounts(tasks);
const legend = toHtml(h('div', { className: 'exp-legend' }, dagStatusOrder().map((s) => {
  const m = dagStatusMeta(s);
  const n = counts[s] || 0;
  return h('span', { key: s, className: 'exp-legend-item' + (m.active && n ? ' live' : '') + (n ? '' : ' zero'), title: `${m.label}：${n} 项` },
    h('i', { style: `background:${m.color}` }), m.label, n ? h('b', null, ' ' + n) : null);
})));

const out = process.argv[2] || join(resolve(PKG, '..', '..'), 'browser-screenshots', 'dag-status-preview.html');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>任务依赖图 · 状态展示预览</title>
<style>
  :root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-base:#fff;--dsw-alias-bg-module-platform:#f6f8fa;--dsw-alias-border-l2:#d0d7de;--dsw-alias-border-l1:#e6e9ee;--dsw-alias-label-primary:#1f2328;--dsw-alias-label-secondary:#57606a;--dsw-alias-state-business-primary:#0969da;--dsw-alias-interactive-bg-hover:#f3f5f8;--etv-run:#3b6ef5;--etv-ok:#22b07d;--etv-rework:#e05f45;--etv-fail:#c0392b;--etv-idle:#9aa4b2;--etv-line:#dfe4ec;--etv-text-run:#3b6ef5;--etv-text-ok:#22b07d;--etv-text-rework:#e05f45}
  body{margin:0;padding:18px;background:#fff;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;color:#1f2328}
  h1{font-size:15px;margin:0 0 4px}
  p.note{font-size:12px;color:#57606a;margin:0 0 14px}
${CSS}
</style></head><body>
<h1>任务依赖图 · 状态展示预览（真实 client.js CSS + dagSvg 输出）</h1>
<p class="note">每张卡：状态色柔底 + 左侧色条 + 底部状态带（图标 + 中文状态）；进行中=流光 + 描边脉冲；状态变更=闪两下（此静态图看不到动画，可打开 HTML 观察）。</p>
${legend}
${svg}
</body></html>
`, 'utf8');
console.log(`已生成：${out}`);
console.log(`file://${pathToFileURL(out).pathname}`);
