#!/usr/bin/env node
// 三副本一致性门禁（批 0-4）
//
// 为什么存在：本包的资产会被**自举安装**到多处运行时位置：
//   ① 源：      packages/dsh-expert-team/
//   ② 已装 skill： $DSH_HOME/skills/expert-team/
//   ③ profile 运行副本： $DSH_HOME/profiles/web/node_modules/@yangdcm/dsh-expert-team/
//   ④ 已装 preset： $DSH_HOME/.agent-presets/expert-team/
//
// 而 ensureSkillInstalled() / ensurePresetInstalled() 一旦发现目标存在就**直接 return**
// （见 lib/command.js 的 `// already present`），**不会覆盖**。后果是：
// **改了源码 ≠ 改了运行时** —— 修改在源码里生效、在真实会话里完全不生效，
// 而且没有任何报错。这是本项目最隐蔽的一类"假完成"。
//
// 用法：
//   node scripts/check-sync.mjs            # 只检查，报告漂移（CI / 交付前门禁）
//   node scripts/check-sync.mjs --fix      # 把源**覆盖**到各运行时目标（谨慎：会覆盖运行时改动）
//   node scripts/check-sync.mjs --json     # 机器可读输出
//
// 退出码：0 = 三副本一致；1 = 有漂移；2 = 用法/环境错误

import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');

/** 包自身的 package.json（`files` 是**发布面的唯一真源**，`only` 必须从它派生而不是手写）。 */
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
/**
 * 运行副本**应当**与源一致的全部顶层条目 = `files` + npm 必然包含的 `package.json` 与 `README.md`。
 * 同一表达式在 `docs-integrity.test.mjs:176` 已被用作"待发布文件"口径 —— 这里与它**同源**，
 * 不要在别处再写第二份清单（历史事故：`only` 与 `files` 分叉，导致两个真漂移文件被永久漏检）。
 */
const PUBLISHED = [...(Array.isArray(PKG.files) ? PKG.files : []), 'package.json', 'README.md'];

/** 源 → 目标 的映射：只比对真正会被自举安装的那部分资产。 */
const MAPPINGS = [
  {
    id: 'skill',
    label: '已装 skill',
    src: join(PKG_ROOT, 'skills', 'expert-team'),
    dst: join(DSH_HOME, 'skills', 'expert-team'),
    // 1.2.0 起 skill 走**运行时注册**（`ctx.skills.register`），默认根本不落地 ⇒ 目标不存在是
    // **正常状态**，不是漂移。（宿主机没有 skill 注册表时才会回退复制，那时这个目录会存在，
    // 于是照常参与比对。）旧实现把它当硬性目标，会让 gate:sync 在正常安装上误报。
    optional: true,
  },
  {
    id: 'preset',
    label: '已装 preset',
    src: join(PKG_ROOT, 'presets', 'expert-team'),
    dst: join(DSH_HOME, '.agent-presets', 'expert-team'),
    // 「专家团模式」preset 由**首次 `/team`** 铺（`ensurePresetInstalled`）⇒"目标不存在"是正常状态：
    //   ① 全新安装还没跑过 `/team`；② 刚 `/team uninstall` 回收过；③ 宿主没有 preset 服务的降级场景。
    // 旧实现把它当硬性目标，会让门禁在"还没用过"的安装上报漂移。
    // **注意 optional 只豁免"不存在"，不豁免"内容不一致"** —— 副本存在时照旧逐文件比对，
    // 仍能抓住"改了源码但运行时没同步"这个门禁真正要防的东西。
    optional: true,
  },
  {
    id: 'runtime',
    label: 'profile 运行副本',
    src: PKG_ROOT,
    dst: join(DSH_HOME, 'profiles', 'web', 'node_modules', '@yangdcm', 'dsh-expert-team'),
    // 运行副本的顶层资产 = package.json 的 `files` 字段 + npm 必然包含的 package.json/README
    // （检测范围与修复范围**必须一致**，否则会出现"报漂移但永不修复"的死角）
    // **从 `files` 派生，见上方 `PUBLISHED` 定义** —— 不要再手写第二份清单。
    only: PUBLISHED,
    nested: [
      { src: 'skills/expert-team', dst: 'skills/expert-team' },
      { src: 'presets/expert-team', dst: 'presets/expert-team' },
    ],
  },
];

const SKIP_DIR = new Set(['node_modules', '.git', '__pycache__']);
/**
 * 不参与比对的文件。
 *
 * `.expert-team-version` 是**我们自己的归属/版本标记**（`lib/command.js` 的 `INSTALL_STAMP`），
 * 不是待同步的包内资产：它只存在于运行时副本里，源里永远没有这一份。两侧都不比 ⇒ 带戳副本判
 * `IN_SYNC`。不加这条的话，1.2.x 起"加载即铺"给每个用户都盖章，skill/preset 两条映射会立刻
 * 因为"目标多了一个文件"报假漂移 —— 而 `listFiles` 同时喂给 `compareTree` 与 `syncTree`，
 * 所以放在这里也让**检测范围与 `--fix` 范围保持一致**（本仓既有纪律：不许"报漂移但永不修复"）。
 */
const SKIP_FILE = /(?:\.bak|\.bak-.*|\.tsbuildinfo|\.DS_Store|\.expert-team-version)$/;

function sha1(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 收集目录下的相对文件清单（跳过噪音文件）。 */
function listFiles(root, base = root, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name) || SKIP_FILE.test(e.name)) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else out.push(relative(base, p));
  }
  return out.sort();
}

/** 比对一对 {src,dst}，返回 {onlySrc, onlyDst, differ, same}。 */
function compareTree(srcDir, dstDir, relPrefix = '') {
  const result = { onlySrc: [], onlyDst: [], differ: [], same: [] };
  if (!existsSync(srcDir)) return { ...result, missingSrc: true };
  if (!existsSync(dstDir)) return { ...result, missingDst: true };
  const srcFiles = new Set(listFiles(srcDir));
  const dstFiles = new Set(listFiles(dstDir));
  for (const f of srcFiles) {
    const rel = relPrefix ? join(relPrefix, f) : f;
    if (!dstFiles.has(f)) {
      result.onlySrc.push(rel);
      continue;
    }
    const a = sha1(join(srcDir, f));
    const b = sha1(join(dstDir, f));
    if (a === b) result.same.push(rel);
    else result.differ.push(rel);
  }
  for (const f of dstFiles) {
    if (!srcFiles.has(f)) result.onlyDst.push(relPrefix ? join(relPrefix, f) : f);
  }
  return result;
}

/**
 * 把源文件覆盖到目标（--fix）。
 * @param only 顶层白名单（对应 package.json 的 `files` 字段）；给定后只同步这些顶层条目，
 *             避免把 tests / scripts 等**不该进运行时**的文件也塞进去。
 * @returns `{copied, failed}` —— failed 必须如实上报，否则"同步失败"会被误读成"已同步"。
 */
function syncTree(srcDir, dstDir, only) {
  let copied = 0;
  const failed = [];
  for (const f of listFiles(srcDir)) {
    const top = f.split(/[\\/]/)[0];
    if (only && !only.includes(top)) continue;
    const s = join(srcDir, f);
    const d = join(dstDir, f);
    try {
      mkdirSync(dirname(d), { recursive: true });
      if (sha1(s) !== sha1(d)) {
        copyFileSync(s, d);
        copied += 1;
      }
    } catch (err) {
      failed.push({ file: f, code: err.code || 'ERROR', message: err.message });
    }
  }
  return { copied, failed };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const fix = argv.includes('--fix');

  if (!existsSync(DSH_HOME)) {
    console.error(`✗ DSH_HOME 不存在：${DSH_HOME}`);
    process.exit(2);
  }

  const report = { dshHome: DSH_HOME, pkgRoot: PKG_ROOT, mappings: [], driftCount: 0, fixed: [], fixSkipped: [], fixFailures: 0 };

  /** 扫描一遍全部映射，重建 report.mappings / driftCount（供初次扫描与修复后复扫共用）。 */
  const scanAll = () => {
    report.mappings = [];
    report.driftCount = 0;
    for (const m of MAPPINGS) {
      if (!existsSync(m.dst)) {
        // optional：目标不存在是**正常状态**（例：1.2.0 起 skill 走运行时注册，不落地）
        report.mappings.push({ id: m.id, label: m.label, dst: m.dst, status: m.optional ? 'ABSENT_OPTIONAL' : 'MISSING_TARGET' });
        if (!m.optional) report.driftCount += 1;
        continue;
      }
      let agg = { onlySrc: [], onlyDst: [], differ: [], same: [] };
      if (m.nested) {
        // 运行副本：逐个子树比对，避免把 node_modules 等无关内容算进来
        for (const n of m.nested) {
          const r = compareTree(join(m.src, n.src), join(m.dst, n.dst), n.src);
          agg.onlySrc.push(...r.onlySrc);
          agg.onlyDst.push(...r.onlyDst);
          agg.differ.push(...r.differ);
          agg.same.push(...r.same);
        }
        // 运行副本的顶层单文件也要比 —— **名单从 `only` 派生**，不再手写：
        // 手写清单漏过 `README.md`（它在 `only` 里、会被 `--fix` 覆盖，却从不被检测），
        // 而 :60-61 的纪律明写"检测范围与修复范围必须一致"。派生后，往 `only` 加条目即
        // 自动进入检测，结构上不会再长出"报了却永不修 / 修了却从不报"的死角。
        // 排除项：`lib` 由下面的 compareTree 单独比；`m.nested` 的顶层目录（skills/presets）
        // 由上面的 nested 循环比 —— 若把它们当文件走 sha1()，对目录 readFileSync 会抛错，
        // 在"源存在、目标缺失"时会误报成 onlySrc。
        const nestedTops = new Set((m.nested || []).map((n) => String(n.src).split('/')[0]));
        for (const f of (m.only || []).filter((t) => t !== 'lib' && !nestedTops.has(t))) {
          const s = join(m.src, f);
          const d = join(m.dst, f);
          if (!existsSync(s)) continue;
          if (!existsSync(d)) agg.onlySrc.push(f);
          else if (sha1(s) !== sha1(d)) agg.differ.push(f);
          else agg.same.push(f);
        }
        // lib/ 是构建产物目录，单独比对
        const libR = compareTree(join(m.src, 'lib'), join(m.dst, 'lib'), 'lib');
        agg.onlySrc.push(...libR.onlySrc);
        agg.onlyDst.push(...libR.onlyDst);
        agg.differ.push(...libR.differ);
        agg.same.push(...libR.same);
      } else {
        agg = compareTree(m.src, m.dst);
      }
      const drift = agg.onlySrc.length + agg.onlyDst.length + agg.differ.length;
      report.mappings.push({
        id: m.id,
        label: m.label,
        src: m.src,
        dst: m.dst,
        status: drift === 0 ? 'IN_SYNC' : 'DRIFT',
        onlySrc: agg.onlySrc,
        onlyDst: agg.onlyDst,
        differ: agg.differ,
        sameCount: agg.same.length,
      });
      report.driftCount += drift;
    }
  };

  scanAll();

  // --fix：逐映射同步；**同步后必须重新扫描**，否则报告仍是修复前的状态
  // （会出现"刚修完却仍报漂移并 exit 1"的自相矛盾，让"修完即验证"的工作流不成立）
  if (fix && report.driftCount > 0) {
    for (const m of MAPPINGS) {
      if (!existsSync(m.dst)) {
        // **不替用户铺一份**：skill 走运行时注册（不落地）、preset 由首次 `/team` 铺。
        // 主动铺会掩盖"还没用过 / 刚卸载"这两个正常状态，也会让 `/team uninstall` 看起来自我撤销。
        report.fixSkipped.push({ id: m.id, dst: m.dst });
        continue;
      }
      const res = syncTree(m.src, m.dst, m.only);
      report.fixed.push({ id: m.id, copied: res.copied, failed: res.failed });
      report.fixFailures += res.failed.length;
    }
    scanAll(); // 复扫：让报告反映"修复后"的真实状态
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('# 三副本一致性检查');
    console.log(`DSH_HOME：${report.dshHome}`);
    console.log(`源包：${report.pkgRoot}`);
    console.log('');
    for (const m of report.mappings) {
      if (m.status === 'MISSING_TARGET') {
        console.log(`✗ [${m.id}] ${m.label} —— 目标不存在：${m.dst}`);
        continue;
      }
      if (m.status === 'ABSENT_OPTIONAL') {
        // 可选目标缺席 = 正常状态（skill 走运行时注册、不落地；preset 由首次 `/team` 铺）
        // ⇒ 明确打印一行说明、**不计入漂移**。
        //
        // ⚠️ 这条分支必须**显式存在**：早前只特判了 MISSING_TARGET，ABSENT_OPTIONAL 直接落到下面去读
        // `sameCount / onlySrc / onlyDst / differ` —— 那些字段在这一状态下**根本不存在**，于是
        // TypeError 让**整个报告一行都打不出来**（skill 恰是第一个映射，所以看起来像"输出被吞了"）。
        // 教训：状态机里"默认落到底"的分支就是崩溃点，每个状态都要有自己的出口。
        console.log(`· [${m.id}] ${m.label} —— 目标不存在（可选映射，视为正常）：${m.dst}`);
        continue;
      }
      const icon = m.status === 'IN_SYNC' ? '✔' : '⚠';
      console.log(`${icon} [${m.id}] ${m.label} —— 一致 ${m.sameCount} 个文件，漂移 ${m.onlySrc.length + m.onlyDst.length + m.differ.length} 个`);
      if (m.status === 'DRIFT') {
        for (const f of m.differ.slice(0, 12)) console.log(`    ≠ 内容不同：${f}`);
        for (const f of m.onlySrc.slice(0, 12)) console.log(`    + 仅源有：${f}`);
        for (const f of m.onlyDst.slice(0, 12)) console.log(`    - 仅运行时副本有：${f}`);
        const shown = Math.min(12, m.differ.length) + Math.min(12, m.onlySrc.length) + Math.min(12, m.onlyDst.length);
        const total = m.differ.length + m.onlySrc.length + m.onlyDst.length;
        if (total > shown) console.log(`    … 另有 ${total - shown} 个`);
      }
    }
    if (report.fixed.length > 0) {
      console.log('');
      console.log('同步（--fix）结果：');
      for (const f of report.fixed) {
        const failNote = f.failed.length > 0 ? `，**失败 ${f.failed.length} 个**` : '';
        console.log(`  · [${f.id}] 覆盖 ${f.copied} 个文件${failNote}`);
        for (const x of f.failed.slice(0, 6)) console.log(`      ✗ ${x.file}（${x.code}）`);
        if (f.failed.length > 6) console.log(`      … 另有 ${f.failed.length - 6} 个失败`);
      }
      console.log('  ⚠ `--fix` 用**源**覆盖运行时：运行时副本上未回流的改动会被丢弃。');
      for (const s of report.fixSkipped) {
        // 缺席的可选目标**不铺**：说清"跳过了什么、为什么"，而不是静默略过（静默会让人以为已修好）
        console.log(`  · [${s.id}] 跳过（目标不存在，属正常状态）：${s.dst}`);
      }
      if (report.fixFailures > 0) {
        console.log('');
        console.log(`✗ 同步未完成：${report.fixFailures} 个文件写入被拒绝（EPERM）。`);
        console.log('  原因：当前会话的文件沙箱为 workspace-write，**不允许写工作区外**的 $DSH_HOME 路径。');
        console.log('  ⇒ 这不是脚本缺陷，是沙箱策略。可选做法：');
        console.log('     ① 在宽权限会话中执行 `npm run fix:sync`；');
        console.log('     ② 或走正式安装流程把包重新装进 profile（推荐，语义正确）；');
        console.log('     ③ 或手工复制 3 个文件（见上方 ✗ 明细）。');
      }
    }
    console.log('');
    console.log(
      report.driftCount === 0
        ? '✔ 三副本一致（源码改动已全部进入运行时）'
        : `⚠ 存在 ${report.driftCount} 处漂移 —— 改了源码但运行时未同步（副本带版本戳：插件升级会整目录重铺；skill 走运行时注册、不落地）`,
    );
    if (report.driftCount > 0) console.log('  修复：node scripts/check-sync.mjs --fix（需宽权限，见上）');
  }

  // 有漂移即失败；同步失败同样是失败（不能因为"试过了"就放行）
  process.exit(report.driftCount === 0 && report.fixFailures === 0 ? 0 : 1);
}

main();
