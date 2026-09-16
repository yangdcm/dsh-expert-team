// 测试：`client.js` 里 CSS 拼接链的**完整性**（每一段写下的 CSS 都必须真的进样式表）
//
// 报障与根因（2026-09-12，由体检发现，非推断）：
//   `var CSS = '…'` 是一长串 `+` 拼接。§96「照抄 AgentTeams SVG 树」新增的 9 行里，
//   7 行漏了行首 `+`（第 250、252–257 行），于是：
//     · `'…'` 单独成句 ⇒ 死表达式，规则**永远进不了** CSS；
//     · 第 258 行原本是 `+ '…'`，因为上一句已经结束，它变成**一元加** ⇒ `+'…'` = `NaN`，同样丢失。
//   净效果：`.etv-curve` / `.etv-dep-edge` / `.etv-g-node*`（6 条）/ `.etv-link` / `.etv-list` /
//   `.etv-row` 共 10 条规则静默缺席 —— 「任务人员流转树」的贝塞尔曲线、依赖边、节点描边、
//   降级区左脊全部无样式渲染。
//
// 为什么门禁没拦住（E 类假绿）：`node --check client.js` **exit 0** —— ASI 把死字符串
//   断成合法语句，语法检查、`test:all` 全绿，而真实渲染已经降级。
//
// 本测试断言的是**语义不变量**，不是某几行有没有 `+`：
//   把 `var CSS = …` 整条语句求值，要求**源码里写下的每一个 CSS 片段都逐字出现在结果里**。
//   任何一段被 ASI 丢掉（漏 `+`、`+` 写成多余的一元加、误加分号…），该片段就不是结果的
//   子串，测试立刻变红。这比"检查行首有没有 +"更难绕过，也不绑定具体写法。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M90**（删掉行首 `+` 让一段 CSS 变死）。
// 运行：node client-css-integrity.test.mjs

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

// ── 1. 切出 `var CSS = …;` 这条语句 ──
// 起点：`var CSS =`；终点：下一条顶层语句（本文件里是 `// ── session store` 注释之后）。
const start = src.indexOf('var CSS =');
if (start < 0) { console.error('✗ client.js 里找不到 `var CSS =`'); process.exit(1); }
const endMarker = src.indexOf('// ── session store', start);
if (endMarker < 0) { console.error('✗ client.js 里找不到 CSS 语句的结束锚点 `// ── session store`'); process.exit(1); }
const stmt = src.slice(start, endMarker).trimEnd();

let css;
try {
  // 语句本身以 `var CSS = …` 开头，用函数体求值再取出变量，避免污染本测试的模块作用域。
  css = new Function(`${stmt}\nreturn CSS;`)();
} catch (error) {
  console.error(`✗ CSS 语句求值失败（拼接链本身已坏）：${error && error.message}`);
  process.exit(1);
}
check(typeof css === 'string' && css.length > 1000, 'CSS 变量可求值且非空', `len=${typeof css === 'string' ? css.length : typeof css}`);

// ── 2. 收集源码里写下的每一个 CSS 片段 ──
// 只取字符串字面量行（跳过注释行），把该行里的字面量内容按「含 `{` 视作 CSS 片段」筛出来。
// 不用正则去解析 JS 字符串，而是直接按行剥离注释后取所有 `'…'` 配对——本文件这一段
// 是纯字面量拼接，写法固定，配对简单可靠。
const literalLines = stmt.split('\n');
const fragments = [];
for (const raw of literalLines) {
  const line = raw.trim();
  if (!line || line.startsWith('//') || line.startsWith('var CSS')) continue;
  // 去掉行首可能存在的 `+` 与行尾可能存在的 `+`，再取全部单引号字面量
  const body = line.replace(/^\+\s*/, '').replace(/\+\s*$/, '');
  const matches = body.match(/'((?:[^'\\]|\\.)*)'/g);
  if (!matches) continue;
  for (const m of matches) {
    // 求值这个字面量本身拿真实内容（`\n` 等转义要还原，否则与求值结果的子串比较会假红）
    const text = new Function(`return ${m};`)();
    if (text.includes('{')) fragments.push({ line: raw.trim().slice(0, 60), text });
  }
}
check(fragments.length >= 5, '从源码里抽到 CSS 片段', `count=${fragments.length}`);

// ── 3. 核心不变量：每一段都必须逐字出现在求值结果里 ──
const missing = fragments.filter(f => !css.includes(f.text));
check(
  missing.length === 0,
  '每一段写下的 CSS 都真的进了样式表（无 ASI 静默丢失）',
  missing.length ? `丢失 ${missing.length} 段，首段所在行：${missing[0].line}` : `checked=${fragments.length}`,
);
if (missing.length) {
  for (const f of missing.slice(0, 5)) console.log(`      ✗ 丢失片段（行首）：${f.line}…`);
}

// ── 4. 回归锚点：本次真实丢过的 10 条规则，逐条必须在 ──
// 这是「问题确实被修好」的可核验证据，也防止未来重构把某条规则整段删掉而不自知。
const knownLost = [
  '.etv-curve', '.etv-dep-edge',
  '.etv-g-node{', '.etv-g-node.run', '.etv-g-node.failed', '.etv-g-node.crit', '.etv-g-node.lead',
  '.etv-link', '.etv-list', '.etv-row',
];
const stillMissing = knownLost.filter(s => !css.includes(s));
check(stillMissing.length === 0, '10 条曾静默丢失的规则全部在场', stillMissing.length ? `缺：${stillMissing.join(', ')}` : '10/10');

// ── 5. 拼接污染：多余的一元加会把相邻片段变成 NaN ──
check(!css.includes('NaN'), '拼接结果无 NaN 污染（无多余/缺失的连接符）');

// ── 6. 真机两处 CSS 缺陷的护栏（2026-09-16，见 §7/§8）──────────────────────────
// 两条都来自真机实测（不是推断），且都属于"规则在场、但**声明的属性**不够"这一类——
// §3 的"片段是否进了样式表"查不出来（片段在、子串在，规则却是坏的）。

console.log('\n⑥ 真机两处 CSS 缺陷：替换元素必须显式给宽高；吸满画布的浮层必须可层叠');

/** 取出所有选择器列表里含 `sel` 的规则的**声明合并**（含 @media 内的嵌套规则）。 */
function declsOf(sel) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.indexOf(sel) >= 0) out.push(m[2]);
  }
  return out.join(';').replace(/\s+/g, '');
}
const hasDecl = (sel, decl) => declsOf(sel).split(';').indexOf(decl) >= 0;

// ⑥-A：`.etc-edges` 是绝对定位铺满画布的 **SVG 覆盖层**。SVG 是**替换元素**，不随 `inset:0`
//   拉伸 —— 只写 `position:absolute;inset:0` 时它的计算尺寸仍是 SVG 默认 **300×150**
//   （真机实测容器 962×297，于是箭头被挤在左上角一小块里）。
//   ⇒ 必须**显式**给 `width:100%` 与 `height:100%`。
{
  const sel = '.etc-edges';
  const d = declsOf(sel);
  check(d.length > 0, `找到 ${sel} 规则（反空转：规则本身必须在）`, d ? d.slice(0, 80) : '未找到');
  for (const decl of ['position:absolute', 'inset:0', 'width:100%', 'height:100%']) {
    check(hasDecl(sel, decl), `${sel} 声明了 ${decl}`, hasDecl(sel, decl) ? '' : `实际声明：${d}`);
  }
}

// ⑥-B：`.exp-canvas` 是吸满整个面板的浮层（画布视图）。`z-index` **只对定位元素有效**：
//   `position:static` 时它自己的 `z-index:120` 完全不生效，宿主的
//   `.wSkVaW_widthHandle`（absolute / z-index:8 / 40px 宽）就压在视图上 ——
//   真机 `elementFromPoint` 在「编队画布」chip 中心命中手柄 ⇒ 遮挡 + 抢点击。
//   ⇒ 必须 `position:relative`（建立层叠上下文）且 `z-index` 高于 8。
{
  const sel = '.exp-canvas';
  const d = declsOf(sel);
  check(d.length > 0, `找到 ${sel} 规则（反空转：规则本身必须在）`, d ? d.slice(0, 80) : '未找到');
  check(hasDecl(sel, 'position:relative'), `${sel} 声明了 position:relative（static 下 z-index 无效）`, hasDecl(sel, 'position:relative') ? '' : `实际声明：${d}`);
  const zi = /(?:^|;)z-index:(\d+)/.exec(d);
  check(!!zi && Number(zi[1]) > 8, `${sel} 的 z-index 大于宿主手柄的 8（真机手柄是 z-index:8）`, zi ? `z-index=${zi[1]}` : `实际声明：${d}`);
}

if (fail) { console.error(`\n✗ client-css-integrity：${fail} 项失败`); process.exit(1); }
console.log('\n✓ client-css-integrity：全部通过');
