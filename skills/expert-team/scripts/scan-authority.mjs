#!/usr/bin/env node
// 工件单源化的**分叉检测**（设计稿 §十二 第 2 步）：读 `AUTHORITY.md`，对**每一行声明的事实**，
// 扫本 run 的权威文件，报出"同一个事实在两个及以上权威文件里**各有定义**"的情况。
//
// 为什么需要它：规则 34 已经要求"见一个扫全部"，但人工逐个事实名去扫**不会发生**（实测那个真实 run
// 里 64% 的返工来自"同一事实多份拷贝"，而扫描器当时也没被用起来 —— 见 `scan:limitation`）。
// 本脚本把"逐条事实 × 全部权威文件"这件事变成**一条命令**。
//
// 复用：`scanSingleSource`（同一目录，规则 34 用的就是它）—— 不另写一套扫描。
//
// ⚠️ 表格式的**完整校验**在 host 侧（`lib/validate.js` 的 `authorityViolations`，含列数/文件存在/
// 写者唯一/核心工件纳入治理）。本脚本只做**极简的第 1、2 列提取**（两个发行位置不同：`skills/` 随技能
// 装到 `~/.dsh/skills`，`lib/` 在 profile 的 node_modules 里，跨发行互 import 不可靠）。
// 表格格式由模板 + host 侧校验钉住，这里刻意不重复实现校验逻辑。
//
// 退出码：0 = 无分叉；1 = 发现分叉；2 = 用法/输入错误。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanSingleSource } from './scan-single-source.mjs';

/** 极简提取：`| 事实类别 | 唯一权威文件 | … |` 的前两列（跳过表头/分隔/空行/示例行）。 */
export function authorityFacts(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!/^\s*\|.*\|\s*$/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^事实类别$/.test(cells[0])) continue;
    if (cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c))) continue;
    if (!cells[0] || /示例/.test(cells[0])) continue; // 模板示例行不算声明
    const file = (cells[1].match(/[^\s`"'§|]+\.(?:md|json|ya?ml|txt)/i) || [''])[0];
    out.push({ fact: cells[0], file });
  }
  return out;
}

/**
 * 对一条事实判断"是否分叉"。
 *
 * ⚠️ **语义别搞反**（我第一版就搞反了，被测试当场抓住）：权威文件**本来就该定义**这个事实 ——
 * 所以在"声明的权威文件集合内部"找分叉，**永远找不出违规**（自证清白）。
 * 正确的判据是：**权威文件之外**还有谁在**定义**它。
 *
 * @returns `{ fact, authorityFile, defsInAuthority, defsElsewhere, divergent }`
 *   · `defsInAuthority` —— 权威文件里的定义点（正常，通常 1 处，多着说明权威文件自己内部也散了）
 *   · `defsElsewhere`   —— **其他文件**里的定义点（这就是分叉；引用不算）
 */
export async function divergenceFor({ runDir, fact, authorityFile, maxMs = 20000 }) {
  const r = await scanSingleSource({ root: runDir, fact, maxMs });
  // ⚠️ **必须排除 `AUTHORITY.md` 自己**：那张表天然会逐行写下每个事实名（`| 变现体系 | SPEC.md | …`），
  // 而散文定义语法里的「表格行」规则会把这种行认成"定义"⇒ 每一条声明都会被误报成"权威之外还有人定义"。
  // 本文件是**关于事实的元数据**，不是事实的定义。（2026-09-13 被退出码断言当场抓到。）
  const METADATA_FILES = new Set(['AUTHORITY.md']);
  const defs = r.definitions.filter((d) => !METADATA_FILES.has(d.file));
  const defsInAuthority = defs.filter((d) => d.file === authorityFile);
  const defsElsewhere = defs.filter((d) => d.file !== authorityFile);
  return { fact, authorityFile, defsInAuthority, defsElsewhere, divergent: defsElsewhere.length > 0 };
}

export function render(report) {
  const { runDir, rows } = report;
  const out = [];
  const bad = rows.filter((r) => r.divergent);
  out.push(`# 单源化分叉检测：${runDir}`);
  out.push('');
  out.push(`- 声明的事实 **${rows.length}** 条`);
  out.push(`- **分叉 ${bad.length} 条**${bad.length ? ' ⚠️ 权威文件之外还有人在定义同一事实 —— 这就是「迟早不一致」的形状' : '（无）'}`);
  out.push('');
  for (const r of rows) {
    const mark = r.divergent ? '✗' : '✓';
    out.push(`${mark} **${r.fact}** — 权威 \`${r.authorityFile || '(未指定)'}\` 里定义 ${r.defsInAuthority.length} 处 · **权威之外定义 ${r.defsElsewhere.length} 处**`);
    if (r.divergent) {
      out.push('    ⚠️ 权威之外的定义点（应改成引用）：');
      for (const d of r.defsElsewhere) out.push(`      - \`${d.file}\`:${d.line} — ${String(d.text).slice(0, 100)}`);
    } else if (r.defsInAuthority.length === 0) {
      out.push('    （注：权威文件里也没有"定义式"写法 —— 可能只是被引用，或该事实还没真正落笔）');
    }
  }
  return out.join('\n');
}

async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const rest = args.filter((a) => !a.startsWith('--'));
  const runDir = rest[0];
  if (!runDir) {
    console.error('用法：node scan-authority.mjs <runDir> [--json]');
    process.exit(2);
  }
  let text;
  try {
    text = await readFile(join(runDir, 'AUTHORITY.md'), 'utf8');
  } catch {
    console.error(`✗ 读不到 ${join(runDir, 'AUTHORITY.md')}（本 run 没有权威表 ⇒ 先按模板写一份）`);
    process.exit(2);
  }
  const facts = authorityFacts(text);
  if (!facts.length) {
    console.error('✗ AUTHORITY.md 里没有有效声明（表是空的或只有表头/示例行）');
    process.exit(2);
  }
  const rows = [];
  for (const f of facts) rows.push(await divergenceFor({ runDir, fact: f.fact, authorityFile: f.file }));
  const report = { runDir, files: [...new Set(facts.map((f) => f.file).filter(Boolean))], rows };
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  process.exit(rows.some((r) => r.divergent) ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((e) => { console.error('✗', (e && e.message) || e); process.exit(2); });
}
