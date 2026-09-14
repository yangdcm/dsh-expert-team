// 设置项的**消费者棘轮**（1.3.2 诚实性收口）：spec 里每一个设置项，要么在生产代码里真的被读，
// 要么**明确登记**在 `INERT_SETTINGS`（`lib/settings.js` 的单一真源，界面上也会标注「暂未生效」）。
//
// 为什么需要这条测试（它才是本版真正的产出）：设置项曾**悄悄变成装饰**而无人察觉 ——
// 20 项里有 10 项的设置值没有任何消费者（用户在设置页勾了、改了，什么都不会发生），
// 而没有任何测试守这件事。门禁/开关只要没人守，就会慢慢退化成摆设。
//
// 棘轮语义（**集合相等**，不是"包含"）：
//   · 新增一个没有消费者的设置项 ⇒ 红（必须要么接线、要么进白名单并说明原因）；
//   · 把某项接线之后忘了从 `INERT_SETTINGS` 删掉 ⇒ 也红（白名单只减不增）。
//
// 判真口径（**为什么不能只按叶子名搜**）：这些叶子名在本仓另有同名的**不同概念** ——
//   `mode.deliverable`（run 模式）、`mode.persist`（`--persist`）、`TIER_SPEC[].defaultRoles`（档位默认班底）、
//   甚至有**注释里提到 `roster.defaultRoles` 路径**（注释不是消费者 —— 恰恰是没有消费者的常见迹象）。
//   因此：歧义叶子必须**限定路径**命中才算；且搜索前**剔除整行注释**。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatSpec, INERT_SETTINGS } from './lib/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** 合并了**歧义叶子**的项：必须限定路径命中才算消费者。 */
const AMBIGUOUS = new Set(['deliverable', 'persist', 'defaultRoles']);

/** 生产代码 = 真会被加载的代码。**不含**测试、文档、`skills/`、`presets/`（提示词读不了设置）。 */
function productionFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '.git') continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e) && !/\.test\.mjs$/.test(e)) out.push(p);
    }
  };
  walk(join(here, 'lib'));
  for (const e of readdirSync(join(here, 'scripts'))) if (/\.mjs$/.test(e) && !/\.test\.mjs$/.test(e)) out.push(join(here, 'scripts', e));
  out.push(join(here, 'client.js'));
  // ⚠️ **不能**整文件排除 `lib/settings.js`：它不只是 spec，还含真正的消费者
  // （`compilePolicy` 读 `id.askBudget` / `id.offerDecideForMe`）—— 排除整文件会把这两项
  // 误判成"无消费者"（本测试第一版就这么错过一次）。改为在 `codeText()` 里**逐行**排除
  // spec 定义行与白名单键行，其余代码照搜。
  return out;
}

/** 逐行剔除注释 / spec 定义行 / 白名单键行后拼成一份文本（保留文件出处，便于失败时定位）。 */
function codeText(files) {
  const parts = [];
  for (const f of files) {
    const rel = f.slice(here.length + 1);
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;                      // 注释不算消费者（注释里提到某设置项，恰是它没消费者的常见迹象）
      if (/^\s*[A-Za-z_$][\w$]*:\s*\{\s*type:/.test(line)) return;       // spec 定义行（`pollMs: { type: 'int' … }`）
      if (/^\s*'[a-z]+\.[A-Za-z]+':/.test(line)) return;                 // INERT_SETTINGS 的键行
      parts.push(`${rel}:${i + 1}: ${line}`);
    });
  }
  return parts.join('\n');
}

const text = codeText(productionFiles());
const spec = flatSpec();
const paths = Object.keys(spec);

console.log('① 判真口径自检（防"搜错东西"造成的假绿/假红）');
{
  check(text.includes('client.js:309'), '生产代码文本包含 client.js（且带行号）', '');
  check(!/^\s*(\/\/|\*)/m.test(text.split('\n').slice(0, 1)[0]), '注释行已被剔除（首行不是注释）', '');
  check(!text.includes("label: '面板轮询间隔（毫秒）'"), 'spec 的定义行不出现在搜索面里（逐行排除，不是整文件排除）', '');
  check(text.includes('id.askBudget'), 'settings.js 里的真消费者仍在搜索面里（compilePolicy 读 id.askBudget）', '');
}

console.log('\n② 每个设置项：有消费者，或已登记为「暂未生效」');
{
  const unconsumed = [];
  for (const path of paths) {
    const [group, leaf] = path.split('.');
    // 歧义叶子：必须限定路径（`roster.persist`）命中；其余：`.<leaf>` 属性读 或 限定路径命中
    const hit = AMBIGUOUS.has(leaf)
      ? text.includes(`${group}.${leaf}`)
      : (new RegExp(`\\.${leaf}\\b`).test(text) || text.includes(`${group}.${leaf}`));
    const listed = Object.prototype.hasOwnProperty.call(INERT_SETTINGS, path);
    if (!hit) unconsumed.push(path);
    check(hit !== listed, hit ? `\`${path}\` 有消费者 ⇒ 不该在 INERT_SETTINGS 里` : `\`${path}\` 无消费者 ⇒ 必须在 INERT_SETTINGS 里登记`, hit ? '' : '');
  }
  // 棘轮 · 集合相等：漏登一个 / 多登一个都红
  const declared = Object.keys(INERT_SETTINGS).sort();
  const measured = unconsumed.slice().sort();
  check(declared.join(',') === measured.join(','), 'INERT_SETTINGS 与实测「无消费者」集合**完全一致**（集合相等，不是包含）',
    `声明 ${declared.length} 项 / 实测 ${measured.length} 项` + (declared.join(',') === measured.join(',') ? '' : `｜只在声明里：${declared.filter((p) => !measured.includes(p)).join(',') || '（无）'}｜只在实测里：${measured.filter((p) => !declared.includes(p)).join(',') || '（无）'}`));
}

console.log('\n③ 白名单自身的卫生');
{
  const badKeys = Object.keys(INERT_SETTINGS).filter((p) => !paths.includes(p));
  check(badKeys.length === 0, 'INERT_SETTINGS 的键都是真实存在的设置项（打错字会红）', badKeys.join(','));
  const noReason = Object.entries(INERT_SETTINGS).filter(([, why]) => typeof why !== 'string' || why.trim().length < 4);
  check(noReason.length === 0, '每一项都写了"为什么现在没用"（不接受空原因）', noReason.map(([k]) => k).join(','));
}

console.log('\n④ 界面标注与白名单同源（接线后标注自动消失）');
{
  const { decorateHint, settingsSchema } = await import('./lib/settings.js');
  const schema = settingsSchema().flatMap((g) => g.items);
  for (const path of Object.keys(INERT_SETTINGS)) {
    const item = schema.find((i) => i.path === path);
    check(Boolean(item) && item.hint.includes('暂未生效'), `设置页 schema 里 \`${path}\` 的 hint 带「暂未生效」标记`, item ? item.hint.slice(0, 60) : '（找不到该项）');
  }
  const wired = paths.filter((p) => !Object.prototype.hasOwnProperty.call(INERT_SETTINGS, p));
  const leaked = wired.filter((p) => (schema.find((i) => i.path === p) || {}).hint?.includes('暂未生效'));
  check(leaked.length === 0, '已接线的项**不会**被标注（标记只来自白名单，不是写死的文案）', leaked.join(','));
  // 幂等：重复加工不叠字
  const h = decorateHint('display.pollMs', '越小越实时');
  check(decorateHint('display.pollMs', h) === h, 'decorateHint 幂等（二次加工不重复追加）', '');
  check(decorateHint('roster.maxTasks', '原样') === '原样', '非白名单项原样返回（不误伤）', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ 设置消费者棘轮失败：${fail} 项`);
  process.exit(1);
}
console.log(`✔ 设置消费者棘轮通过（${paths.length} 项设置：已接线 ${paths.length - Object.keys(INERT_SETTINGS).length} · 登记为暂未生效 ${Object.keys(INERT_SETTINGS).length}）`);
