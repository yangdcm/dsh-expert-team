#!/usr/bin/env node
/**
 * validate-agent-preset.mjs — 用「插件自己的 Config schema」逐行校验一个 agent 预设组合。
 *
 * 为什么需要它：dsh 升级可能改动插件 config 字段（例：2026-09-10 `@deepseek-ai/dsh-persona`
 * 把 `text` 改成**必填**的 `prefix` + `suffix`），而预设文件是**手写副本**——字段过期时
 * 报错只发生在「会话创建/恢复」那一刻，表现为
 *   agent-presets: preset "expert-team" failed to mount: failed to apply loader entry persona …: invalid config
 * 且**只有在建新会话时才暴露**（组合只在会话创建时读一次）。
 *
 * 用法：
 *   node scripts/validate-agent-preset.mjs <preset.agent.cordis.yml> [更多文件…]
 *   node scripts/validate-agent-preset.mjs            # 默认校验 ~/.dsh/.agent-presets/<preset>/agent.cordis.yml
 *
 * 约定：`cordis:group` 这类本地行跳过；`disabled: true` 的行跳过（未挂载）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * 解析 dsh 安装根目录，用于借用宿主自带的 `yaml`。
 *
 * 为什么不再写死一台机器的绝对路径：写死会让脚本在别人的机器上直接抛错，
 * 也把开发机的目录结构带进了公开仓库。解析顺序：
 *   ① `DSH_INSTALL`（显式覆盖，CI/多版本共存时用）；
 *   ② PATH 上 `dsh` 的真实路径 → `…/node_modules/@deepseek-ai/dsh`；
 *   ③ 常见全局安装位置兜底。
 * 全都找不到时报一条能照着做的错误，而不是 TypeError。
 */
function resolveDshInstall() {
  if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL;
  const candidates = [];
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // …/@deepseek-ai/dsh/lib/bin.js → 包根
    if (bin) candidates.push(path.resolve(fs.realpathSync(bin), '..', '..'));
  } catch { /* PATH 上没有 dsh：继续兜底 */ }
  if (process.env.npm_config_prefix) {
    candidates.push(path.join(process.env.npm_config_prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  }
  // 判据用 package.json 而不是 index.js：dsh 包根本**没有** 根 index.js（入口是 lib/bin.js），
  // 而 `createRequire` 只需要一个解析基准路径、并不要求它存在 —— 用 index.js 当判据会永远失败。
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'package.json'))) return c;
  }
  console.error('✗ 找不到 dsh 安装目录。请设置 DSH_INSTALL=/path/to/node_modules/@deepseek-ai/dsh 后重试。');
  process.exit(2);
}

const DSH = resolveDshInstall();

/**
 * 宿主版本必须覆盖本包 `engines.dsh` 的下限。
 *
 * 为什么要有这道闸：0.2.2 的 preset 会引用更新版本才有的插件（例如 `dsh-tool-schedule`
 * 在 0.2.1+ 才出现）。拿一台 **0.2.0** 的机器去校验，会把"宿主太旧"报成"预设写错了" ——
 * 那是假红，会训练人忽略门禁。此时**如实说"验不了"**（exit 2），而不是给一个错误结论。
 */
function hostVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(DSH, 'package.json'), 'utf8'));
    return String(manifest.version || '');
  } catch { return ''; }
}
function minDshVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    const range = String((pkg.engines && pkg.engines.dsh) || '');
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
    return m ? [+m[1], +m[2], +m[3]] : null;
  } catch { return null; }
}
function versionTriple(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
}
{
  // 只对**本包随附的 preset 补丁**做版本闸（默认输入，或显式指向包内 `presets/`）：
  // 它会引用较新宿主才有的插件。显式传入的 fixture 文件是你的选择 —— 它可能只用宿主编年史里
  // 一直存在的插件（例如 preset-lint 的近失键名夹具），旧宿主上照样能验。
  const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const explicit = process.argv.slice(2).map((f) => path.resolve(f));
  const packageInput = explicit.length === 0
    || explicit.some((f) => f === path.join(PKG, 'presets') || f.startsWith(path.join(PKG, 'presets') + path.sep));
  const host = versionTriple(hostVersion());
  const min = minDshVersion();
  if (packageInput && host && min) {
    const tooOld = host[0] < min[0] || (host[0] === min[0] && (host[1] < min[1] || (host[1] === min[1] && host[2] < min[2])));
    if (tooOld) {
      console.error('✗ 本机 dsh 版本 ' + host.join('.') + ' 低于本包要求（engines.dsh ' + min.join('.') + '.x）—— 无法校验：');
      console.error('  更新版本的 preset 会引用较新的宿主插件，旧宿主上的失败不能当成"预设写错了"。');
      console.error('  装好匹配的 dsh 后重跑，或设 DSH_INSTALL 指向 >= ' + min.join('.') + ' 的 @deepseek-ai/dsh 目录。');
      process.exit(2);
    }
  }
}
const require = createRequire(path.join(DSH, 'index.js'));
const YAML = require('yaml');

/**
 * 默认校验**本包随附的 preset 补丁**。
 *
 * dsh 0.2.x 起 preset 不再来自 `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`：
 * 注册表不扫描目录（见 `@deepseek-ai/dsh-agent-preset-registry` README），
 * preset 由 bundle 补丁里的 `@deepseek-ai/dsh-agent-preset` 行声明。
 * 所以默认输入是包内 `presets/*.patch.yml`，而不是用户目录。
 */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function discoverPresetFiles() {
  const dir = path.join(PKG_ROOT, 'presets');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    console.log(`· ${dir} 不存在 —— 没有可校验的 preset 补丁。`);
    return [];
  }
  const files = entries
    .filter((d) => d.isFile() && /\.patch\.ya?ml$/.test(d.name))
    .map((d) => path.join(dir, d.name));
  if (!files.length) console.log(`· ${dir} 下没有 *.patch.yml —— 没有可校验的 preset 补丁。`);
  return files;
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : discoverPresetFiles();

/** 递归展开 cordis:group 的 config 数组，并展开 preset 行的 config.plugins，收集叶子行。 */
function collectRows(rows, out = [], parent = '') {
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const id = row.id ?? '?';
    const where = parent ? `${parent}/${id}` : id;
    if (row.name === 'cordis:group' || Array.isArray(row.config)) {
      out.push({ where, id, name: row.name, group: true });
      collectRows(row.config, out, where);
      continue;
    }
    out.push({ where, id, name: row.name, disabled: row.disabled === true, config: row.config });
    // preset 行：`config.plugins` 是这份 preset 的子插件列表，必须逐行校验 ——
    // 否则"preset 里配错了插件"会整个漏检（旧版目录式 preset 的 collectRows 只认 group）。
    if (row.name === '@deepseek-ai/dsh-agent-preset' && Array.isArray(row.config?.plugins)) {
      collectRows(row.config.plugins, out, `${where}(${row.config.id || '?'})`);
    }
  }
  return out;
}

/** 按行名解析插件模块（预览包名解析基准 = harness 自己的 node_modules）。 */
async function loadPlugin(name) {
  const spec = name.startsWith('@') ? name : name;
  const resolved = require.resolve(spec);
  const mod = await import(pathToFileURL(resolved).href);
  return mod;
}

let failures = 0;
let checked = 0;
let skipped = 0;
let lintWarns = 0;

/**
 * L3-4b 前置：角色级 `agentOptions` 的**已知键**（宿主契约，2026-09-11 实测）。
 *
 * 来源：`@deepseek-ai/dsh-tool-subagent/lib/index.js` 的 `Config` 里
 *   `agentOptions: z.object({ provider, model, reasoningEffort, maxTokens })`（约 258-263 行）。
 * 关键风险：该 object **非 strict** —— 实测写错键名（如 `reasoning_efforts`）**不会被拒绝、
 * 也不会被剥掉**，配置原样留下、运行时按"没有这个键"处理 ⇒ **角色静默失去该设置**。
 * 这正是本插件最危险的失败模式（"承诺≠能力，且不告诉你"），所以在这里做**近失键名**拦截。
 *
 * 只把「归一化后等于某个已知键、但字面不等」的键判为失败（`reasoning_efforts` / `reasoning-effort`
 * / `ReasoningEffort` 这类必是拼错）；完全无关的键只提示，不判失败 —— 上游新增字段时不会误伤。
 */
const KNOWN_AGENT_OPTION_KEYS = ['provider', 'model', 'reasoningEffort', 'maxTokens'];
/**
 * `reasoningEffort` 的**合法值域**（与宿主 `dsh-llm` 的 effort id 一致）。
 *
 * 为什么在这里也校验（2026-09-15 真实故障）：宿主在**任何网络 I/O 之前**就用
 * `llm.resolveCallWithInfo` 把"请求的 effort"与"该模型公布的 efforts"比对，不匹配即抛
 * `UNSUPPORTED_REASONING_EFFORT`。preset 侧写一个不在值域里的字符串（例如 `medium`），
 * 或用户路由侧**漏声明** `reasoningEfforts`，都会让带 effort 的角色派工全部失败。
 * 本脚本只做 preset 侧的**值域**校验；用户机器上的路由能力表不在这里读（脚本不许依赖用户环境）。
 */
const EFFORT_DOMAIN = ['off', 'low', 'high', 'max'];
const normKey = (k) => String(k || '').toLowerCase().replace(/[_-]/g, '');
/** 去掉一个尾随的 `s`（`reasoningEfforts` → `reasoningeffort` 这种复数拼错很常见）。 */
const depluralize = (s) => (s.length > 1 && s.endsWith('s') ? s.slice(0, -1) : s);
/** 两个键是否"归一化后等价"（忽略大小写、`_`/`-`、以及尾随复数 s）。 */
function sameKeyShape(a, b) {
  const na = normKey(a), nb = normKey(b);
  return na === nb || depluralize(na) === nb || na === depluralize(nb) || depluralize(na) === depluralize(nb);
}
/**
 * 编辑距离 ≤1（含**相邻换位**，即 Damerau 意义上的 1）。
 * 为什么需要：`modle` → `model` 这类**换位**是最常见的手滑之一，而它既不是大小写/分隔符变体、
 * 也不是复数变体，`sameKeyShape` 抓不到。
 * 为什么限长度 ≥5：短键（`id`/`ui`/`pm`）之间距离 1 太容易撞，会制造误报；
 * 而本清单里的键都 ≥5（provider/model/reasoningEffort/maxTokens）。
 */
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    const diff = [];
    for (let i = 0; i < la; i += 1) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
    return false;
  }
  const short = la < lb ? a : b, long = la < lb ? b : a;
  let i = 0, j = 0, skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i += 1; j += 1; continue }
    if (skipped) return false;
    skipped = true; j += 1;
  }
  return true;
}
/** 键是否"形近"（归一化等价，或长键之间编辑距离 ≤1）。 */
function looksLike(a, b) {
  if (sameKeyShape(a, b)) return true;
  const na = normKey(a), nb = normKey(b);
  return na.length >= 5 && nb.length >= 5 && withinOneEdit(na, nb);
}
/** @returns {Array<{key:string, should:string}>} 判为"近失拼写"的键（会被运行时静默忽略） */
function nearMissKeys(obj, known) {
  const out = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(obj)) {
    if (known.includes(k)) continue;
    const hit = known.find((kk) => looksLike(k, kk));
    if (hit) out.push({ key: k, should: hit });
  }
  return out;
}
/** @returns {string[]} 与已知键**形状也不同**的键（只提示，不判失败） */
function unknownKeys(obj, known) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj).filter((k) => !known.includes(k) && !known.some((kk) => looksLike(k, kk)));
}

for (const file of files) {
  console.log(`\n=== ${file}`);
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v) => v }],
    });
  } catch (e) {
    console.log(`  ✗ YAML 解析失败：${e.message}`);
    failures++;
    continue;
  }
  // 输入可能是「补丁文件」（`- insert: [...]`）也可能是「插件行列表」；补丁里所有 insert
  // 内容都要展开，其它补丁动作（override/disable）不构成新的 preset，跳过即可。
  const patchRows = Array.isArray(doc)
    ? doc.flatMap((entry) => (entry && Array.isArray(entry.insert) ? entry.insert : []))
    : [];
  const rows = collectRows(patchRows.length ? patchRows : (Array.isArray(doc) ? doc : []));
  // 声明的 preset id 先收齐：`agentPreset:` 引用必须指向真实存在的子预设（拼错 ⇒ 角色派工在
  // **调用时**才失败，属于本仓最讨厌的"配好了但一跑就错"）。
  const declaredPresets = new Set(rows.filter((r) => r.name === '@deepseek-ai/dsh-agent-preset').map((r) => r.config?.id).filter(Boolean));
  for (const row of rows) {
    if (row.group) continue;
    if (!row.name || !row.name.startsWith('@')) {
      skipped++;
      continue;
    }
    if (row.disabled) {
      console.log(`  · ${row.where} (${row.name}) —— disabled，跳过`);
      skipped++;
      continue;
    }
    let mod;
    try {
      mod = await loadPlugin(row.name);
    } catch (e) {
      console.log(`  ✗ ${row.where} (${row.name}) —— 无法解析插件：${e.message}`);
      failures++;
      continue;
    }
    if (typeof mod.Config !== 'function') {
      console.log(`  · ${row.where} (${row.name}) —— 无 Config schema，跳过`);
      skipped++;
      continue;
    }
    try {
      const validated = mod.Config(row.config ?? {});
      checked++;
      // 显式指认最容易过期的那类字段：必填项是否真的拿到值
      const missing = Object.keys(validated ?? {}).filter((k) => validated[k] === undefined);
      console.log(`  ✓ ${row.where} (${row.name})${missing.length ? ` —— ⚠ 解析后为 undefined 的键：${missing.join(',')}` : ''}`);
      // L3-4b 前置 lint：agentOptions 的近失键名 / 未知键（静默失效区）
      const ao = row.config && row.config.agentOptions;
      const near = nearMissKeys(ao, KNOWN_AGENT_OPTION_KEYS);
      if (near.length) {
        failures++;
        console.log(`    ✗ agentOptions 键名疑似拼错，运行时会被**静默忽略**：${near.map((n) => `${n.key}（应为 ${n.should}）`).join('、')}`);
      }
      const effRaw = ao && ao.reasoningEffort;
      if (effRaw !== undefined && !EFFORT_DOMAIN.includes(String(effRaw).toLowerCase())) {
        failures++;
        console.log('    ✗ reasoningEffort="' + effRaw + '" 不在合法值域（' + EFFORT_DOMAIN.join('/') + '）⇒ 该角色派工会被宿主拒绝（UNSUPPORTED_REASONING_EFFORT）');
      }
      const unknown = unknownKeys(ao, KNOWN_AGENT_OPTION_KEYS);
      if (unknown.length) {
        lintWarns++;
        console.log(`    ⚠ agentOptions 含未知键（宿主 schema 不适用的键，确认是否有意）：${unknown.join('、')}`);
      }
      // ── dsh 0.2.2 的**挂载期**契约（schema 不拦，apply 时直接 throw）──────────────
      // `dsh-tool-subagent` 0.2.2: persona/toolFilter 已移除，配置里出现即
      // "persona is no longer supported; configure persona and tool plugins in an Agent
      // Preset and select it with agentPreset (spawn only)" —— 整份 preset 因此挂不上。
      if (row.name === '@deepseek-ai/dsh-tool-subagent') {
        const cfg = row.config && typeof row.config === 'object' ? row.config : {};
        for (const gone of ['persona', 'toolFilter']) {
          if (Object.hasOwn(cfg, gone)) {
            failures++;
            console.log(`    ✗ config.${gone} 在 dsh >= 0.2.2 已移除（挂载时直接报错）⇒ 把角色人设/工具限制放进 Agent Preset，用 agentPreset 选择`);
          }
        }
        for (const obsolete of ['backgroundMode', 'modelSelectionSettings']) {
          if (Object.hasOwn(cfg, obsolete)) {
            lintWarns++;
            console.log(`    ⚠ config.${obsolete} 是 0.1.x 字段，0.2.x 会静默忽略（已无后台模式；模型选择改用 modelSelection/modelDiscovery）`);
          }
        }
        if (cfg.agentPreset !== undefined) {
          if (!declaredPresets.has(cfg.agentPreset)) {
            failures++;
            console.log(`    ✗ agentPreset="${cfg.agentPreset}" 没有对应的 @deepseek-ai/dsh-agent-preset 声明`
              + `（已声明：${[...declaredPresets].join('、') || '无'}）`);
          }
        }
      }
    } catch (e) {
      failures++;
      console.log(`  ✗ ${row.where} (${row.name}) —— schema 校验失败：${e.message}`);
    }
  }
}

console.log(`\n合计：校验 ${checked} 行通过，${failures} 个失败，${skipped} 个跳过${lintWarns ? `，${lintWarns} 个键名提示` : ''}`);
if (failures === 0) {
  console.log('ⓘ 提醒：上面只校验了 **preset 侧**。会话默认路由（~/.dsh/settings.yaml 的 agent-default-model）');
  console.log('  里的模型条目**必须**声明 reasoningEfforts（' + EFFORT_DOMAIN.join('/') + '）—— 否则该模型下');
  console.log('  **任何**带 effort 的角色派工都会被宿主在派工前拒绝（UNSUPPORTED_REASONING_EFFORT）。');
  console.log('  插件在加载时会对此做一次预检告警（只告警、不阻断）。');
}
process.exit(failures ? 1 : 0);
