// 测试：**工件归属**（防回归 · 本轮 A4）
//
// 为什么需要：R1 的权威表述**只有一处** —— `skills/expert-team/SKILL.md`：
//   「**run 工件一律由产出它的角色自己 `write` 到 `<run-dir>/`**；lead 没有 `write` 工具」。
// 而 `references/ROLES.md` 等文件曾长期写着**相反**的旧口径（「由 lead 落盘」「不要写文件」）：
// 成员读到旧口径就**拒绝自己落盘** ⇒ 骨架没人建、工件没人写，用户看到的是「团队不动」。
// 旧表述清掉之后，"清掉"本身不是机制 —— 任何一次改写都可能把它抄回来。本测试就是防它回来的门禁。
//
// 四条断言，一律**整串子串匹配**（不用模糊正则：正则的宽容度会让"看起来还在"蒙混过关）：
//   A 真源含 R1 权威关键子串（逐字）
//   B 旧表述在 `skills/expert-team/**` + `presets/expert-team/agent.cordis.yml` 里命中 **0**
//   C `skills/expert-team/**` 里所有 `assets/templates/<文件名>` 引用都**真实存在**
//     （悬空引用 = 用户点开预览是空/报错，且说明模板被改名或没落盘）
//   D 看板名唯一：不得再出现非「任务」前缀的 `看板.md`
//     （同一个东西两个名字 ⇒ 模板名与引用名对不上；**排掉 `任务看板.md` 这个子串**，别把自己判红）
//
// 纪律：每条失败信息都打印**命中文件 + 行号** —— 在一个并发改文件的仓里，
// 没有行号的失败信息"等于没说"（读的人还得自己 grep 一遍）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M137-artifact-ownership-r1-revert**
// （把 A 的关键子串改回旧表述 ⇒ A 必红）。运行：node artifact-ownership.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(here, 'skills', 'expert-team');
const TEMPLATES_DIR = join(SKILL_ROOT, 'assets', 'templates');
const SKILL_MD = join(SKILL_ROOT, 'SKILL.md');
const PRESET_YML = join(here, 'presets', 'expert-team', 'agent.cordis.yml');

/** R1 的权威关键子串（逐字；改一个字都算红）。 */
const R1_KEY = 'run 工件一律由产出它的角色自己';
/** 旧口径（与 R1 矛盾；成员据此拒绝落盘）。 */
const LEGACY_PHRASES = ['由 lead 落盘', '不要写文件', '工件文件一律由 lead'];
/** 看板唯一名（D 断言的"合法"形态）。 */
const KANBAN = '看板.md';
const KANBAN_OK_PREFIX = '任务';
/** `assets/templates/<文件名>` 引用（文件名可含中文；遇到空白/引号/括号/标点即止）。 */
const TEMPLATE_REF_RE = /assets\/templates\/([^\s`'"()[\]（）【】、，。；：:|<>*]+)/g;

/** 仓内相对路径（统一 / 分隔，报错信息里可直接点开）。 */
const rel = (p) => relative(here, p).split('\\').join('/');

/** 递归列出目录下所有文件（自己实现，不依赖 bash / find）。 */
async function listFiles(dir) {
  const out = [];
  const walk = async (d) => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

/** 文本缓存（同一文件被 B/C/D 反复读）。 */
const cache = new Map();
async function readText(p) {
  if (!cache.has(p)) cache.set(p, await readFile(p, 'utf8'));
  return cache.get(p);
}

/** 1-based 行号。 */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

test('A · SKILL.md 含 R1 权威表述关键子串（逐字）', async (t) => {
  const src = await readText(SKILL_MD);
  const at = src.indexOf(R1_KEY);
  if (at >= 0) {
    const hits = src.split(R1_KEY).length - 1;
    t.diagnostic(`命中 ${rel(SKILL_MD)}:${lineOf(src, at)}（共 ${hits} 次）`);
    return;
  }
  const legacyLines = src.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => LEGACY_PHRASES.some((p) => line.includes(p)))
    .map(({ line, no }) => `${rel(SKILL_MD)}:${no} → ${line.trim().slice(0, 100)}`);
  assert.ok(false,
    `A 失败：${rel(SKILL_MD)} 里找不到 R1 权威关键子串「${R1_KEY}」`
    + `（整串子串匹配，${rel(SKILL_MD)} 全文命中 0 次）`
    + (legacyLines.length
      ? `\n      同文件里的旧口径（R1 被改回去了？）：\n      ${legacyLines.join('\n      ')}`
      : '\n      同文件里也没有旧口径 —— 该子串是被改写/删掉，而不是被替换成旧表述。'));
});

test('B · 旧口径在 skills/expert-team/** + agent 预设里命中 0 次', async (t) => {
  assert.ok(existsSync(PRESET_YML),
    `B 失败：目标文件不存在 ${rel(PRESET_YML)} —— 旧口径清查的覆盖面缺一块，不能静默少扫一个文件`);
  const files = [...(await listFiles(SKILL_ROOT)), PRESET_YML];
  const found = [];
  for (const f of files) {
    const lines = (await readText(f)).split('\n');
    lines.forEach((line, i) => {
      for (const p of LEGACY_PHRASES) {
        let at = line.indexOf(p);
        while (at >= 0) {
          found.push(`${rel(f)}:${i + 1} 「${p}」 → ${line.trim().slice(0, 90)}`);
          at = line.indexOf(p, at + 1);
        }
      }
    });
  }
  assert.equal(found.length, 0,
    `B 失败：旧口径共命中 ${found.length} 处（应为 0；扫了 ${files.length} 个文件）`
    + `\n      ${found.slice(0, 20).join('\n      ')}`
    + (found.length > 20 ? `\n      …（还有 ${found.length - 20} 处）` : ''));
  t.diagnostic(`${files.length} 个文件、${LEGACY_PHRASES.length} 个旧口径串：0 命中`);
});

test('C · assets/templates/<文件名> 引用无悬空（引用都能落地）', async (t) => {
  const tplNames = new Set(await readdir(TEMPLATES_DIR));
  const refs = [];
  for (const f of await listFiles(SKILL_ROOT)) {
    const lines = (await readText(f)).split('\n');
    lines.forEach((line, i) => {
      TEMPLATE_REF_RE.lastIndex = 0;
      let m;
      while ((m = TEMPLATE_REF_RE.exec(line)) !== null) refs.push({ file: rel(f), line: i + 1, name: m[1] });
    });
  }
  const missing = refs.filter((r) => !tplNames.has(r.name));
  assert.equal(missing.length, 0,
    `C 失败：${missing.length} 处悬空引用（目标不在 ${rel(TEMPLATES_DIR)}/ 下）`
    + `\n      ${missing.map((r) => `${r.file}:${r.line} → assets/templates/${r.name}`).join('\n      ')}`
    + `\n      现有模板：${[...tplNames].sort().join(', ')}`);
  // 反空转：解析器若一条都读不到，这条断言就会变成"永远通过"的假门禁。
  assert.ok(refs.length > 0,
    `C 失败：一条 assets/templates/<文件名> 引用都没解析到 —— 解析器与实际写法脱节`
    + `（扫了 ${rel(SKILL_ROOT)} 下 ${(await listFiles(SKILL_ROOT)).length} 个文件）`);
  t.diagnostic(`${refs.length} 处引用，全部命中 ${rel(TEMPLATES_DIR)}/ 下的真实文件`);
});

test('D · 看板名唯一：非「任务」前缀的 看板.md 命中 0 次', async (t) => {
  const found = [];
  let okCount = 0;
  for (const f of await listFiles(SKILL_ROOT)) {
    const lines = (await readText(f)).split('\n');
    lines.forEach((line, i) => {
      let at = line.indexOf(KANBAN);
      while (at >= 0) {
        const before = line.slice(Math.max(0, at - KANBAN_OK_PREFIX.length), at);
        if (before === KANBAN_OK_PREFIX) okCount += 1;
        else found.push(`${rel(f)}:${i + 1} → …${line.slice(Math.max(0, at - 14), at + KANBAN.length + 8)}…`);
        at = line.indexOf(KANBAN, at + 1);
      }
    });
  }
  assert.equal(found.length, 0,
    `D 失败：非「${KANBAN_OK_PREFIX}${KANBAN}」的 ${KANBAN} 共 ${found.length} 处（看板名必须唯一）`
    + `\n      ${found.slice(0, 20).join('\n      ')}`
    + (found.length > 20 ? `\n      …（还有 ${found.length - 20} 处）` : ''));
  t.diagnostic(`${KANBAN_OK_PREFIX}${KANBAN} 命中 ${okCount} 处，其它形态 0 处`);
});

test('反空转 · 真源/模板目录/唯一看板名都还在扫描面里（防「解析不到 ⇒ 永远通过」）', async (t) => {
  const files = await listFiles(SKILL_ROOT);
  assert.ok(files.some((f) => f === SKILL_MD), `${rel(SKILL_MD)} 不在扫描面里`);
  const tplNames = await readdir(TEMPLATES_DIR);
  assert.ok(tplNames.length > 0, `${rel(TEMPLATES_DIR)}/ 是空的`);
  // D 的反空转：唯一看板名（`任务看板.md`）必须真的出现在扫描面里 —— 否则"把看板整个改名/删掉"
  // 会让 D 因为"一处都没扫到"而变绿（本仓教训：解析不到东西的门禁＝永远通过的门禁）。
  const kanbanSeen = [];
  for (const f of files) if ((await readText(f)).includes(KANBAN_OK_PREFIX + KANBAN)) kanbanSeen.push(rel(f));
  assert.ok(kanbanSeen.length > 0,
    `扫描面（${files.length} 个文件）里一处 ${KANBAN_OK_PREFIX}${KANBAN} 都没有 —— D 的判据失去了对象，不能算通过`);
  t.diagnostic(`扫描面：${files.length} 个文件；模板 ${tplNames.length} 个；${KANBAN_OK_PREFIX}${KANBAN} 出现在 ${kanbanSeen.join(', ')}`);
});

// ── E 工件清单三处一致（2026-09-15 阶段 C 的口径收口）──────────────────────────
// 起因：`lib/command.js` 的 `templates` 常量与两个 e2e 的"run 目录必需文件"清单**都是 13 项、
// 但集合不同**（常量含 `AUTHORITY.md` 不含 `RUN.log.md`；测试反之）—— 看起来像"抄错了一处"，
// 于是很容易被后来者"对齐"成同一件事，结果要么漏检 `RUN.log.md`、要么把模板清单改坏。
// 真相是：**两者语义不同、关系确定**，本断言把它钉死：
//   ① `templates` 常量 ≡ `assets/templates/` 目录文件集合（它就是从这儿复制的清单）；
//   ② 两个 e2e 的必需清单 ≡ ① ∪ {`RUN.log.md`}（RUN.log.md 由日志器创建，不经模板）。
// 任何一侧漂移（模板改名/加文件、测试加漏检）都会红在这里，而不是等到线上缺文件。
test('E · 工件清单一致：常量 ≡ 模板目录；e2e 必须清单 ≡ 常量 ∪ {RUN.log.md}', async () => {
  // 2026-09-15：模板清单已提升为**模块级单一真源** `ARTIFACT_TEMPLATES`（建 run 与 R1 绕过检测
  // 共用同一份）。断言因此改为**直接读那份真源**，而不是解析源码里的字面量 —— 后者会在重构后
  // "失去判据对象"（这次就是），而失去对象比断言失败更危险：它看起来像通过。
  const { ARTIFACT_TEMPLATES: constList } = await import(join(here, 'lib', 'command.js'));
  assert.ok(Array.isArray(constList) && constList.length > 0, '导出的 ARTIFACT_TEMPLATES 不是非空数组 —— E 的判据失去对象');
  const cmd = await readText(join(here, 'lib', 'command.js'));
  assert.ok(/const templates = ARTIFACT_TEMPLATES;/.test(cmd), '建 run 的复制逻辑必须用那份真源（不得另抄清单）');
  const dirList = (await readdir(TEMPLATES_DIR)).filter((f) => !f.startsWith('.'));
  assert.deepEqual([...constList].sort(), [...dirList].sort(),
    `templates 常量与 ${rel(TEMPLATES_DIR)}/ 不一致（常量=${constList.length} 项，目录=${dirList.length} 项）`);

  const RUNLOG = 'RUN.log.md';
  const expected = [...constList, RUNLOG].sort();
  for (const tf of ['smoke.test.mjs', 'regression.test.mjs']) {
    const src = await readText(join(here, tf));
    const mm = src.match(/for \(const f of \[([^\]]+)\]\)/);
    assert.ok(mm, `${tf} 里找不到必需文件清单 —— E 的判据失去对象`);
    const list = mm[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.deepEqual([...list].sort(), expected,
      `${tf} 的必需文件清单与「模板 ${constList.length} 项 + ${RUNLOG}」不一致（该文件 ${list.length} 项）`);
  }
});

// ── F/G：把**新的机读真源**（`lib/artifact-ownership.js` 的 ARTIFACT_OWNERS）双向钉回真源 ──
// 为什么必须双向：单向只能防一类错误 ——
//   F（表 → 真源）：防**发明工件名/拼错**（把 SECURITY.md 写成 SEC.md 之类 ⇒ 门禁静默失效）；
//   G（真源 → 表）：防**漏项**（SKILL.md 给某角色派了工件，而门禁表里没有它 ⇒ 那份工件谁都能覆写）。
test('F · 所有权表的键都来自真源（不发明文件/不拼错）', async () => {
  const { ARTIFACT_OWNERS } = await import(join(here, 'lib', 'artifact-ownership.js'));
  const { ARTIFACT_TEMPLATES: templates } = await import(join(here, 'lib', 'command.js'));
  assert.ok(Array.isArray(templates) && templates.length > 0, 'ARTIFACT_TEMPLATES 不是非空数组 —— F 的判据失去对象');
  const skill = await readText(SKILL_MD);
  const workspace = await readText(join(SKILL_ROOT, 'references', 'WORKSPACE.md'));
  const known = new Set([
    ...templates,
    ...[...skill.matchAll(/`([A-Za-z0-9_-]+\.(?:md|json))`/g)].map((x) => x[1]),
    ...[...workspace.matchAll(/`([A-Za-z0-9_-]+\.(?:md|json))`/g)].map((x) => x[1]),
  ]);
  const invented = Object.keys(ARTIFACT_OWNERS).filter((k) => !known.has(k));
  assert.deepEqual(invented, [], `所有权表里的这些工件名在真源（templates / SKILL.md / WORKSPACE.md）里找不到：${invented.join(', ')}`);
});

test('G · SKILL.md 产出列里每个 run 工件都在所有权表里（R1 不漏项）', async () => {
  const { ARTIFACT_OWNERS } = await import(join(here, 'lib', 'artifact-ownership.js'));
  const skill = await readText(SKILL_MD);
  const missing = [];
  for (const line of skill.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 3 || cells[0] === '角色') continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    for (const mm of cells[2].matchAll(/`([A-Za-z0-9_-]+\.(?:md|json))`/g)) {
      if (!Object.prototype.hasOwnProperty.call(ARTIFACT_OWNERS, mm[1])) missing.push(`${cells[0]} → ${mm[1]}`);
    }
  }
  assert.deepEqual(missing, [], `SKILL.md 给这些角色派了工件，但所有权表里没有 ⇒ 那几份谁都能覆写：${missing.join(' / ')}`);
  assert.deepEqual([...ARTIFACT_OWNERS['STATE.json']], [], 'STATE.json 必须显式列为运行时专属');
  assert.deepEqual([...ARTIFACT_OWNERS['ROSTER.json']], [], 'ROSTER.json 必须显式列为运行时专属');
});
