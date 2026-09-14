#!/usr/bin/env node
// 包名改名器（上架准备 · 一次性但可重复使用）
//
// 为什么需要它：包名在这套代码里**不是一处事实**，而是散落在 14 个文件里的三种书写形状：
//   ① 字面量          `<scope>/<name>`（cordis.patch.yml 的 insert 两行、package.json、
//                     client.js 的 `__ModuleLoader__.load({ id })`、README、脚本注释……）
//   ② 转义正则片段    `<scope>\/<name>`（agent-scope-guard.test.mjs 校验 patch 行的正则）
//   ③ 拆开的路径段    `join(..., '<scope>', '<name>')`（check-sync.mjs、sync-gate.test.mjs）
// 漏改任意一种都不会立刻报错，而是**静默失效**（客户端模块 id 对不上 ⇒ 浮层不加载；
// 棘轮正则对不上 ⇒ 门禁形同虚设）。所以改名必须由机器做，且必须能自检。
//
// 事实来源：**package.json 的 name 字段**（脚本自身不含任何硬编码包名，改名后可重复使用；
// 因此文件扫描会跳过本文件本身）。
//
// 用法：
//   node scripts/rename-package.mjs @myscope/my-plugin          # 预演（默认不落盘）
//   node scripts/rename-package.mjs @myscope/my-plugin --write   # 真的改
//   node scripts/rename-package.mjs --check                      # 只做一致性自检（CI 用）
//
// 退出码：0 = 无残留/改名成功；1 = 有残留或无处可改；2 = 用法/参数非法

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIR = new Set(['node_modules', '.git', '__pycache__', 'team']);
const SKIP_FILE = /(?:\.bak|\.bak-.*|\.tsbuildinfo|\.DS_Store|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.ico|\.tgz)$/i;
// 只扫文本类文件（改名器不该去动二进制），按扩展名白名单。
const TEXT_EXT = /\.(?:js|mjs|cjs|json|yml|yaml|md|txt|ts)$/i;

/** npm 包名文法（与 dshmarket 的 NPM_NAME_RE 同口径）。 */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** 上架前必须清除的占位 scope（拼出来，避免本文件自己被 --check 判为残留）。 */
const PLACEHOLDER = ['@', 'myorg'].join('');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name) || SKIP_FILE.test(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(e.name) && p !== SELF) out.push(p);
  }
  return out;
}

const parts = (name) => (name.startsWith('@') ? name.split('/') : [null, name]);

/**
 * 由「旧名 → 新名」派生全部书写形状。**顺序敏感**：
 * ① 转义正则 → ② 拆开的两段路径 → ③ 单独一段 scope（`join(..., 'node_modules', '@scope')`）
 * → ④ 字面量。反过来先替换字面量会把 ②/③ 的上下文一并吃掉，留下半改的残骸。
 */
function rulesFor(oldName, newName) {
  const [oldScope, oldBase] = parts(oldName);
  const [newScope, newBase] = parts(newName);
  const escaped = (name) => name.replace(/\//g, '\\/');
  const seg = (scope, base, q) => (scope ? `${q}${scope}${q}, ${q}${base}${q}` : `${q}${base}${q}`);
  const rules = [];
  if (oldScope) {
    rules.push({ kind: 'escaped', from: escaped(oldName), to: escaped(newName) });
    rules.push({ kind: 'segments-sq', from: seg(oldScope, oldBase, "'"), to: seg(newScope, newBase, "'") });
    rules.push({ kind: 'segments-dq', from: seg(oldScope, oldBase, '"'), to: seg(newScope, newBase, '"') });
    // 只出现 scope 一段的写法（如 `mkdir(join(..., 'node_modules', '@scope'))`）。
    // 目标无 scope 时这里**不猜**：一段变两段/零段的路径结构差异必须人工看，故只在新名有 scope 时替换。
    if (newScope) {
      rules.push({ kind: 'scope-sq', from: `'${oldScope}'`, to: `'${newScope}'` });
      rules.push({ kind: 'scope-dq', from: `"${oldScope}"`, to: `"${newScope}"` });
    }
  }
  rules.push({ kind: 'literal', from: oldName, to: newName });
  return rules.filter((r) => r.from !== r.to);
}

function readPkg() {
  const p = join(PKG_ROOT, 'package.json');
  if (!existsSync(p)) { console.error('✗ 找不到 package.json'); process.exit(2); }
  return { path: p, json: JSON.parse(readFileSync(p, 'utf8')) };
}

function placeholderResidue() {
  const hits = [];
  for (const f of walk(PKG_ROOT)) {
    if (readFileSync(f, 'utf8').includes(PLACEHOLDER)) hits.push(relative(PKG_ROOT, f).split(sep).join('/'));
  }
  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const target = argv.filter((a) => !a.startsWith('--'))[0];
  const { path: pkgPath, json: pkg } = readPkg();
  const current = pkg.name;
  const hits = placeholderResidue();

  if (argv.includes('--check')) {
    console.log(`当前包名：${current}`);
    if (hits.length === 0) { console.log('✓ 无占位包名残留'); process.exit(0); }
    console.error(`✗ 仍有 ${hits.length} 个文件带占位包名：\n  - ${hits.join('\n  - ')}`);
    process.exit(1);
  }

  if (!target) {
    console.log(`当前包名：${current}`);
    console.log(hits.length ? `占位包名残留 ${hits.length} 个文件（--check 看清单）` : '✓ 无占位包名残留');
    console.log('用法：node scripts/rename-package.mjs <新包名> [--write] | --check');
    process.exit(0);
  }

  if (!NPM_NAME_RE.test(target)) {
    console.error(`✗ 非法 npm 包名：${target}（须全小写、可带 @scope/，字符集 [a-z0-9-._~]）`);
    process.exit(2);
  }
  if (target === current && hits.length === 0) {
    console.log(`= 包名已是 ${target}，且无占位残留。`);
    process.exit(0);
  }

  // 规则集 = 当前名 → 目标名；若还留着占位包名，再补一组「占位名 → 目标名」。
  // 后者让本脚本具备**自愈**能力：上一次改名漏掉的形状（例如只出现 scope 一段的写法）
  // 可以在下一次运行时补齐，而不必手工改。
  const placeholderName = `${PLACEHOLDER}/${parts(current)[1]}`;
  const rules = [...rulesFor(current, target), ...(hits.length ? rulesFor(placeholderName, target) : [])];
  const files = walk(PKG_ROOT);
  const plan = [];
  const texts = new Map();
  for (const f of files) {
    const before = readFileSync(f, 'utf8');
    let text = before;
    let count = 0;
    const kinds = [];
    for (const r of rules) {
      const pieces = text.split(r.from);
      if (pieces.length > 1) { count += pieces.length - 1; text = pieces.join(r.to); kinds.push(r.kind); }
    }
    texts.set(f, text);
    if (count > 0) plan.push({ file: relative(PKG_ROOT, f).split(sep).join('/'), count, kinds });
  }

  if (plan.length === 0) {
    console.error(`✗ 没有任何文件包含当前包名 ${current}，无法改名。`);
    process.exit(1);
  }

  console.log(`${write ? '改名（写盘）' : '预演（不写盘）'}：${current} → ${target}`);
  console.log(`命中 ${plan.length} 个文件，共 ${plan.reduce((n, p) => n + p.count, 0)} 处：`);
  for (const p of plan) console.log(`  ${String(p.count).padStart(2)} × ${p.file}  [${p.kinds.join(', ')}]`);
  if (!write) { console.log('\n（加 --write 才会真的落盘）'); process.exit(0); }

  for (const [f, text] of texts) {
    if (text !== readFileSync(f, 'utf8')) writeFileSync(f, text);
  }
  pkg.name = target;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const residual = placeholderResidue();
  const nameOk = JSON.parse(readFileSync(pkgPath, 'utf8')).name === target;
  if (residual.length || !nameOk) {
    console.error(`✗ 改名后仍有残留（请手工检查）：\n  - ${[...residual, ...(nameOk ? [] : ['package.json: name 未更新'])].join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`✓ 改名完成（${plan.length} 个文件），且无占位残留。`);
  console.log('下一步：node scripts/rename-package.mjs --check && npm run test:all');
  console.log(`注意：仓库外的地方（profile 的 package.json 依赖、远端仓库名）需另行同步为 ${target}。`);
}

main();
