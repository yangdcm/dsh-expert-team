// 测试：ASI（自动分号插入）类**静默死代码**的静态检测
//
// 为什么需要（E 类假绿，本仓已发生两次）：
//   一串 `+` 拼接的字符串里，只要**某一行漏了行首 `+`**，那一行就变成**独立的表达式语句**：
//     · 该字符串**不再进入**拼接结果（静默丢失）；
//     · 更隐蔽的是它**打断链条**，其后所有以 `+` 开头的续行退化成**一元加**（`+'…'` = `NaN`），
//       一并丢失。
//   `node --check` **exit 0**、全部测试绿 —— 语法完全合法，只有真实渲染/真实行为降级。
//   本仓实证：`client.js` 的 CSS 拼接链曾因此丢掉 10 条规则（`.etv-curve` / `.etv-dep-edge` /
//   `.etv-g-node*` / `.etv-link` / `.etv-list` / `.etv-row`），「任务人员流转树」的贝塞尔曲线、
//   依赖边、节点描边全部没画出来；工作日志 §95 声称已修，§96 新增代码时又犯一次。
//   `node --check` 与"测试全绿"都抓不到它 —— 只有**内容断言**或**静态检测**能抓。
//
// 判定（刻意收窄，只在**确凿**时报警）：
//   一行 trim 后**整体就是一个字符串字面量**（可带尾分号、**不带**行首 `+`），
//   且上一行（跳过空行与整行注释）**不以期待续行的记号结尾**（`+ - * / % = ? : , ( [ { & | ! < >`）
//   ⇒ 该行是一条"裸字符串语句"，即死代码，报告之。
//
// 为什么**不能**把行首 `+` 也算进来：`'A'` 换行 `+ 'B'` 是**合法的二元续行**（ASI 不会插分号），
// 本仓 `lib/command.js` 里有大量这种写法（如 status 文案拼接）。误报会把门禁变成噪声，最终被整体忽略
// —— 这正是本仓「大量假阳性让门禁被忽略」的教训。真正的断点一定表现为**某一行是裸字符串**，
// 抓住它就够了。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M93**（去掉一行行首 `+` 制造该缺陷）。
// 运行：node asi-hazards.test.mjs

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', 'browser-screenshots']);

/**
 * 已知的、**待删除**的违规文件白名单。**只许缩小，不许增长**（下面有断言钉住条目数）。
 *
 * 2026-09-13：**已清空**。此前唯一的条目是 `client 2.js`（macOS 复制残留：不被任何地方引用、
 * 不在发布文件清单里、函数集合是 `client.js` 的真子集 —— 复核为"副本独有 = 0 个"，
 * 却自带同一份未修的 ASI 缺陷 7 处）。用户确认 P4 清理后该文件已删除，
 * 因此白名单必须清空：**清空即意味着"全仓无此缺陷"**，这也是本数组存在的意义。
 * 若将来又出现必须豁免的文件，编辑本数组时要同时改下面的断言 —— 让"增长"必须是一次显式动作。
 */
const KNOWN_HAZARD_FILES = [];

const BARE = /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`);?$/;
const CONTINUES = /[+\-*/%=?:,([{&|!<>]\s*$/;
const DIRECTIVE = /^['"]use (strict|asm)['"];?$/;

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function collect(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await collect(p, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 扫描一个文件里的裸字符串语句。
 * @param raw - 文件全文。
 * @returns `[{line, text, prev}]`（行号 1 起）。
 */
export function scanSource(raw) {
  // 先把块注释整体替换成等长空白（保留换行），避免注释里的示例被计入
  const blanked = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = blanked.split('\n');
  const hits = [];
  let prev = '';
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//')) return;
    if (BARE.test(t) && !DIRECTIVE.test(t) && prev && !CONTINUES.test(prev)) {
      hits.push({ line: i + 1, text: t, prev });
    }
    prev = t;
  });
  return hits;
}

console.log('① 检测器自检（造样例，证明它真的会报警 / 也会正确放行）');
{
  const bad = ["const a =", "  'x' +", "  'y'", "  'z'", ""].join('\n');
  const badHits = scanSource(bad);
  check(badHits.length === 1 && badHits[0].line === 4, "裸字符串（前一行以 ' 结尾）⇒ 报警", `hits=${badHits.length}`);

  const good = ["const a =", "  'x'", "  + 'y'", "  + 'z'", ""].join('\n');
  check(scanSource(good).length === 0, '行首 + 的续行 ⇒ 不报警（合法二元续行）');

  const arr = ["const a = [", "  'x',", "  'y',", "]", ""].join('\n');
  check(scanSource(arr).length === 0, '数组元素（带逗号）⇒ 不报警');

  const call = ["f(", "  'x'", ")", ""].join('\n');
  check(scanSource(call).length === 0, '括号内换行（上一行以 ( 结尾）⇒ 不报警');

  const directive = ["'use strict';", "const a = 1", ""].join('\n');
  check(scanSource(directive).length === 0, '指令序言 use strict ⇒ 不报警');

  const inComment = ["const a =", "  'x' +", "/* 示例:", "  'y'", "*/", ""].join('\n');
  check(scanSource(inComment).length === 0, '块注释里的示例 ⇒ 不报警');
}

console.log('② 全仓扫描');
{
  const files = await collect(here);
  const offences = [];
  for (const f of files) {
    const rel = relative(here, f);
    const hits = scanSource(await readFile(f, 'utf8'));
    if (hits.length) offences.push({ rel, hits });
  }
  const unexpected = offences.filter((o) => !KNOWN_HAZARD_FILES.includes(o.rel));
  check(
    unexpected.length === 0,
    `除白名单外的文件没有裸字符串语句（扫描 ${files.length} 个 js/mjs）`,
    unexpected.length
      ? `\n      ${unexpected.map((o) => `${o.rel}:${o.hits.map((h) => h.line).join(',')}`).join('\n      ')}`
      : `${files.length} 个文件`,
  );
  check(
    KNOWN_HAZARD_FILES.length === 0,
    '待删白名单**已清空**（2026-09-13 删除 `client 2.js` 后归零；不得悄悄再加回来）',
    KNOWN_HAZARD_FILES.length ? `当前还有 ${KNOWN_HAZARD_FILES.join(', ')} —— 新增豁免必须是一次显式动作` : '已清空',
  );
  // 白名单里的文件必须**确实**还有该缺陷；否则说明白名单过期了（文件已修/已删），应清空条目
  for (const rel of KNOWN_HAZARD_FILES) {
    const entry = offences.find((o) => o.rel === rel);
    check(!!entry, `白名单条目仍然必要：${rel} 确实存在该缺陷`, entry ? `${entry.hits.length} 处（行 ${entry.hits.map((h) => h.line).join(',')}）` : '该文件已无此缺陷或已不存在 ⇒ 请从白名单删除该条');
  }
}

if (fail) { console.error(`\n✗ asi-hazards：${fail} 项失败`); process.exit(1); }
console.log('\n✓ asi-hazards：全部通过');
