// `/state?section=` 渐进式状态的回归护栏（2026-09-15，性能修复 #3）。
//
// 为什么要有它：`/state` 的成本随「本会话子代理数 × 日志体量」线性增长，而**首屏真正需要的
// 只有阶段/进度/计数**（便宜）。真机实测：小会话 311 ms；我这条 20+ 子代理的重会话 2.1–6.2 s
// （诊断 `profile` 分步：`subs` 1.33–1.39 s + `roles` 0.64–0.87 s）。
// 本文件钉住四件事，缺一条都会让"渐进式"悄悄退回"每次全量"：
//   ① `parseStateSections` 的语义（缺省/ all 向后兼容；summary 永远在内；未知名字忽略而不报错）；
//   ② 服务端**真的**把贵块关在分节后面（people/feed/artifacts 各自的守卫点在位）；
//   ③ 硬上限与软期限**存在**，且截断走 `degraded` **如实上报**（不许静默丢）；
//   ④ summary 路径**不写盘**（登记块被 people 分节挡住 —— 否则一次摘要请求就会覆写 STATE.json）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const { _live } = await import(join(here, 'lib', 'command.js'));
const { parseStateSections } = _live;
const src = readFileSync(join(here, 'lib', 'command.js'), 'utf8');

console.log('① `parseStateSections`：语义正确，且**默认向后兼容**');
{
  const none = parseStateSections(undefined);
  check(none.all === true && none.want('people') === true && none.want('artifacts') === true,
    '不传 section ⇒ 全部分节（老客户端/脚本/既有测试不受影响）', JSON.stringify(none.included));
  check(none.included.join(',') === 'summary,people,feed,artifacts', 'included 是完整四块', none.included.join(','));

  const sum = parseStateSections('summary');
  check(sum.all === false && sum.want('people') === false && sum.want('feed') === false && sum.want('artifacts') === false,
    'section=summary ⇒ 只有便宜基线', JSON.stringify(sum.included));
  check(sum.included.join(',') === 'summary', 'summary 仍在内（它是基线，不是可选块）', sum.included.join(','));

  const pf = parseStateSections('people,feed');
  check(pf.want('people') === true && pf.want('feed') === true && pf.want('artifacts') === false,
    '多分节按逗号解析', JSON.stringify(pf.included));
  check(pf.included.join(',') === 'summary,people,feed', '被要到的分节按固定顺序出现', pf.included.join(','));

  const all = parseStateSections('all');
  check(all.want('people') === true && all.want('artifacts') === true, 'section=all ⇒ 等价于不传', '');

  let threw = false;
  let weird = null;
  try { weird = parseStateSections(' summary , , 未知块 '); } catch (e) { threw = true; }
  check(!threw && weird.want('people') === false, '未知名字/空白/空项**不抛错**（多传参数不该把面板打死）', '');
  check(weird.included.join(',') === 'summary', '未知块被忽略，included 不含它', weird.included.join(','));
}

console.log('\n② 服务端：贵块真的关在分节后面（守卫点在位）');
{
  check(/const secParsed = parseStateSections\(secRaw\)/.test(src), 'handler 用同一个纯函数解析（单一真源）', '');
  check(/want\('people'\) \? await listSubagentStatusBySession\(ctx, peopleSid, knownIds\) : \[\]/.test(src),
    'people：子会话清单解析被分节挡住（这是重会话最大的一块）', '');
  check(/want\('people'\) && !subs\.length && peopleSid !== sid/.test(src), 'people：归属回退也在同一分节内', '');
  check(/want\('people'\) \? await workflowChildLabels\(ctx, peopleSid\) : \{\}/.test(src), 'people：workflow 标签只在分节内取', '');
  check(/if \(want\('people'\)\) \{\n\s*if \(subs\.length > MAX_ROLE_SUBS\)/.test(src), 'people：角色解析带硬上限分支', '');
  check(/want\('people'\) \? subs\.map\(\(s\) => \{/.test(src) && /\}\) : \[\];/.test(src),
    'people：agents 在摘要里是**空数组**（不是"没有成员"—— 由 sections 区分）', '');
  check(/if \(want\('people'\)\) sel\.members = enrichMembers\(/.test(src), 'people：成员 enrich 只在分节内（否则空 subById 会把名册糊成"未启动"）', '');
  check(/if \(want\('feed'\)\) for \(const s of subs\)/.test(src), 'feed：每 agent 事件流只在分节内收集', '');
  check(/if \(want\('artifacts'\)\) \{/.test(src), 'artifacts：RUN.log 尾 + git 改动只在分节内读', '');
  check(/if \(want\('people'\) && !taskList\(sel\.tasks\)\.length && subs\.length\)/.test(src), 'people：tasksLive 兜底投影同样受分节约束', '');
}

console.log('\n③ 硬上限 / 软期限：截断必须**如实上报**（不许静默丢）');
{
  check(/const MAX_ROLE_SUBS = /.test(src) && /DSH_EXPERT_TEAM_MAX_ROLE_SUBS/.test(src), '角色解析有硬上限（可用环境变量覆盖）', '');
  check(/degraded\.push\('roles:' \+ \(subs\.length - MAX_ROLE_SUBS\)\)/.test(src), '被上限挡住的条数进 degraded（带数量）', '');
  check(/const PEOPLE_DEADLINE_MS = /.test(src) && /DSH_EXPERT_TEAM_PEOPLE_DEADLINE_MS/.test(src), 'people 有软期限（可覆盖）', '');
  check(/degraded\.push\('wf:deadline'\)/.test(src), '超期限跳过 workflow 元数据时如实标注', '');
  check(/degraded\.length \? \{ degraded: true, degradedReason: degraded\.join\(','\), sections: included \} : null/.test(src),
    '响应里带 degraded + degradedReason（调用方看得见"少算了什么"）', '');
  check(/secRequested \? \{ sections: included \} : null/.test(src),
    '响应里带 sections（缺的块 ≠ 空数据，两种零可区分）', '');
}

console.log('\n④ summary 路径**不写盘**（否则一次摘要请求就覆写 STATE.json）');
{
  const at = src.indexOf('派工即登记（C3）');
  const block = at >= 0 ? src.slice(at, at + 900) : '';
  check(!!block, '找到登记块', '');
  check(/if \(want\('people'\)\) try \{/.test(block), '登记块被 people 分节挡住（摘要轮询不再触发写）', '');
  check(/ARTIFACT\.must\(stPath, st\)/.test(block), '（原有不变）登记仍走受控写入', '');
}

console.log('\n⑤ 客户端：一快一慢双订阅 + 合并（防"摘要拍掉成员"）');
{
  const clientSrc = readFileSync(join(here, 'client.js'), 'utf8');
  check(/stateUrl\('summary'\)/.test(clientSrc) && /stateUrl\('people,feed,artifacts'\)/.test(clientSrc),
    '两条订阅：summary 快、重块慢', '');
  check(/function mergeStatePayload\(prev, d\)/.test(clientSrc), '合并函数在位（缺块 ≠ 空数据）', '');
  check(/if \(section\) q\.push\('section=' \+ encodeURIComponent\(section\)\)/.test(clientSrc), 'stateUrl 支持 section 参数', '');
  check(/function stateHubBaseOf\(u\)/.test(clientSrc), 'hub 按 URL 各自计时（否则慢块被快钟拖着跑）', '');
  check(/&section=people,feed/.test(clientSrc), '徽章订阅只要 people,feed（不拉 artifacts）', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ /state 分节测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ /state 分节通过（解析语义 / 贵块分节 / 上限与 degraded / 摘要不写盘 / 客户端双订阅+合并）');
