// 测试：host 与 client 的**角色词表必须等价**（B 线第一步 · 报告 04 的 R4 前半）
//
// 为什么需要：角色解析在两侧各有一份实现（host 在 `lib/command.js`，client 在 `client.js`），
// 因为 client 是 `__ModuleLoader__` 工厂、**不能 import**。两份表长期靠注释"请保持同步"维系 ——
// 而实测已经分叉：client 的 `WF_ROLE_WORDS` 比 host 的 `SUB_ROLE_WORDS` **少了**
// `chief` / `investigate` / `database` / `designer` / `design` 等词 ⇒ **同一段文本在 host 能解析出角色、
// 在浮层解析不出**（用户看到的就是"未匹配到角色"）。注释不是门禁；这条测试才是。
//
// 断言的是**归一化后的等价**（去空白 + 小写）—— 因为两侧 lookup 都先做 `roleLabelKey`，
// 所以 `'UI 设计师'` 与 `'ui设计师'` 在行为上等价（这一点曾被误报为"已分叉的 bug"，
// 实际只是**两份表**的维护性问题；真正的行为分叉在关键词表上）。
//
// 变异验证：见 `regression.fixtures/mutations.json` 的 **M103**。
// 运行：node vocab-consistency.test.mjs

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// B 线 11b：host 侧词表已收拢进 `lib/vocab.js`（唯一真源）。这里**直接 import 运行时值**
// 来验证"推导关系"（比解析源码文本更硬），同时仍读源码文本验证"没有第二份拷贝"。
import { ALLOWED_KINDS, ALLOWED_KINDS_ZH, KIND_ZH } from './lib/vocab.js';

const here = dirname(fileURLToPath(import.meta.url));
const hostSrc = await readFile(join(here, 'lib', 'command.js'), 'utf8');
const vocabSrc = await readFile(join(here, 'lib', 'vocab.js'), 'utf8');
const clientSrc = await readFile(join(here, 'client.js'), 'utf8');

let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '').toLowerCase();

/** 从源码里切出 `name = <literal>` 的字面量并求值（两侧都是纯字面量，可安全 eval）。 */
function literalOf(src, name, { from = 0 } = {}) {
  const at = src.indexOf(name, from);
  if (at < 0) return { ok: false, why: `找不到 ${name}` };
  const eq = src.indexOf('=', at);
  if (eq < 0) return { ok: false, why: `${name} 后没有 =` };
  let i = src.indexOf('[', eq) >= 0 && (src.indexOf('[', eq) < src.indexOf('{', eq) || src.indexOf('{', eq) < 0)
    ? src.indexOf('[', eq) : src.indexOf('{', eq);
  if (i < 0) return { ok: false, why: `${name} 后没有字面量起止符` };
  const open = src[i];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    const c = src[j];
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) { const text = src.slice(i, j + 1); try { return { ok: true, value: eval(`(${text})`) }; } catch (e) { return { ok: false, why: `${name} 字面量求值失败：${e.message}` }; } } }
  }
  return { ok: false, why: `${name} 字面量未闭合` };
}

console.log('① 两侧的角色标签表（中文标签 → 角色 id）');
// host 侧的表现在住在 `lib/vocab.js`（B 线 11b）—— 这里读的是**真源**，不是搬走前的旧位置。
const hostLabelsAt = vocabSrc.indexOf('const ROLE_LABELS_ZH');
check(hostLabelsAt >= 0, 'host 标签表在 `lib/vocab.js`（唯一真源）', hostLabelsAt >= 0 ? '' : '找不到 const ROLE_LABELS_ZH');
const hostObjStart = vocabSrc.indexOf('{', hostLabelsAt);
let depth = 0; let hostObjEnd = -1;
for (let j = hostObjStart; j < vocabSrc.length; j += 1) {
  if (vocabSrc[j] === '{') depth += 1;
  else if (vocabSrc[j] === '}') { depth -= 1; if (depth === 0) { hostObjEnd = j; break; } }
}
const hostLabels = eval(`(${vocabSrc.slice(hostObjStart, hostObjEnd + 1)})`);
const clientLabelsLit = literalOf(clientSrc, 'var ROLE_LABELS_ZH');
check(clientLabelsLit.ok, 'client 侧标签表可解析', clientLabelsLit.ok ? '' : clientLabelsLit.why);
const clientLabels = clientLabelsLit.ok ? clientLabelsLit.value : {};

const hk = Object.keys(hostLabels).map(norm).sort();
const ck = Object.keys(clientLabels).map(norm).sort();
const onlyHost = hk.filter((k) => !ck.includes(k));
const onlyClient = ck.filter((k) => !hk.includes(k));
check(onlyHost.length === 0, 'host 的标签 client 都有', onlyHost.length ? `client 缺：${onlyHost.join(', ')}` : `${hk.length} 个`);
check(onlyClient.length === 0, 'client 的标签 host 都有', onlyClient.length ? `host 缺：${onlyClient.join(', ')}` : `${ck.length} 个`);
const labelMismatch = hk.filter((k) => clientLabels[Object.keys(clientLabels).find((x) => norm(x) === k)] !== hostLabels[Object.keys(hostLabels).find((x) => norm(x) === k)]);
check(labelMismatch.length === 0, '同一标签两侧解析到同一角色 id', labelMismatch.length ? `不一致：${labelMismatch.join(', ')}` : '');

console.log('\n② 两侧的角色关键词表（顺序敏感：先命中先赢）');
const hostWords = literalOf(vocabSrc, 'const SUB_ROLE_WORDS');
check(hostWords.ok, 'host 关键词表可解析', hostWords.ok ? '' : hostWords.why);
const clientWords = literalOf(clientSrc, 'var WF_ROLE_WORDS');
check(clientWords.ok, 'client 关键词表可解析', clientWords.ok ? '' : clientWords.why);

if (hostWords.ok && clientWords.ok) {
  const hw = hostWords.value; const cw = clientWords.value;
  const hRoles = hw.map(([r]) => r);
  const cRoles = cw.map(([r]) => r);
  check(JSON.stringify(hRoles) === JSON.stringify(cRoles), '两侧角色**顺序**一致（顺序决定"先命中先赢"）',
    JSON.stringify(hRoles) === JSON.stringify(cRoles) ? `${hRoles.length} 个` : `host=${hRoles.join(',')} | client=${cRoles.join(',')}`);
  const missingInClient = [];
  for (const [role, words] of hw) {
    const peer = cw.find(([r]) => r === role);
    if (!peer) { missingInClient.push(`${role}（整行缺失）`); continue; }
    const miss = words.filter((w) => !peer[1].includes(w));
    if (miss.length) missingInClient.push(`${role}: 缺 ${miss.join('/')}`);
  }
  check(missingInClient.length === 0, 'host 的每个关键词 client 都有（**这里就是实测分叉处**）',
    missingInClient.length ? missingInClient.join('；') : '逐词一致');
  const extraInClient = [];
  for (const [role, words] of cw) {
    const peer = hw.find(([r]) => r === role);
    if (!peer) continue;
    const extra = words.filter((w) => !peer[1].includes(w));
    if (extra.length) extraInClient.push(`${role}: 多 ${extra.join('/')}`);
  }
  check(extraInClient.length === 0, 'client 没有 host 不知道的关键词（多出来的会把文本猜成错误的角色）',
    extraInClient.length ? extraInClient.join('；') : '无多余');
}

console.log('\n③ 归一化本身必须两侧一致（`UI 设计师` ≡ `ui设计师`）');
{
  const hostKeyBody = /function roleLabelKey\(s\) \{\s*return ([^;]+);/.exec(vocabSrc);
  const clientKeyBody = /function roleLabelKey\(s\) \{ return ([^}]+)\}/.exec(clientSrc);
  check(!!hostKeyBody && !!clientKeyBody, '两侧都有 roleLabelKey（host 那份在 `lib/vocab.js`）', '');
  if (hostKeyBody && clientKeyBody) {
    const hExpr = hostKeyBody[1].trim();
    const cExpr = clientKeyBody[1].trim();
    check(/\\s|\\u3000/.test(hExpr) && /\\s|\\u3000/.test(cExpr), '两侧都去空白（含全角空格）与大小写');
    const hFn = new Function('s', `return ${hExpr}`);
    const cFn = new Function('s', `return ${cExpr}`);
    for (const s of ['UI 设计师', 'ui设计师', 'ＵＩ　设计师', '产品经理']) {
      check(hFn(s) === cFn(s), `归一化一致：${JSON.stringify(s)}`, `host=${JSON.stringify(hFn(s))} client=${JSON.stringify(cFn(s))}`);
    }
  }
}

console.log('\n④ B 线 11b：host 侧词表**只此一份**（搬走之后不许再抄回来）');
{
  // 这些名字是"同一个事实"：一旦在 command.js 里又出现定义，就等于词表重新分叉。
  const LEFTOVERS = ['const SUB_ROLE_WORDS', 'const ROLE_LABELS_ZH', 'function roleLabelKey', 'const KIND_ZH', 'const PHASE_ZH', 'const STATUS_ZH', 'const VERDICT_ZH', 'const ROLE_ZH', 'const ACTIVITY_ZH', 'const DELIVER_ZH', 'const MODE_ZH', 'const ALLOWED_KINDS', 'const PHASES '];
  const back = LEFTOVERS.filter((s) => hostSrc.includes(s));
  check(back.length === 0, 'command.js 里不再有这些词表的定义（全部只剩 vocab.js 一份）', back.length ? `又抄回来了：${back.join(' / ')}` : `${LEFTOVERS.length} 个名字都只在 vocab.js`);
  check(/from '\.\/vocab\.js'/.test(hostSrc), 'command.js 确实**从 vocab.js import**（不是靠全局）');

  // 「合法 kind」曾有三份：英文 Set、手写中文串、KIND_ZH 的键。现在中文串**推导**自 KIND_ZH。
  check(ALLOWED_KINDS_ZH === Object.values(KIND_ZH).join('/'), '`ALLOWED_KINDS_ZH` 与 `KIND_ZH` 的取值逐字一致', ALLOWED_KINDS_ZH);
  check(ALLOWED_KINDS.size === Object.keys(KIND_ZH).length && [...ALLOWED_KINDS].every((k) => k in KIND_ZH), '`ALLOWED_KINDS` 与 `KIND_ZH` 的键集合相等', `${ALLOWED_KINDS.size} 个`);
  check(!vocabSrc.includes('需求/调研/设计'), '源码里**不再有**那份手写中文清单（它是推导出来的，不是抄的）');
}

if (fail) { console.error(`\n✗ vocab-consistency：${fail} 项失败`); process.exit(1); }
console.log('\n✓ vocab-consistency：全部通过');
