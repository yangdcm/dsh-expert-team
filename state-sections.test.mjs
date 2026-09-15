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
  check(/const needSubs = want\('people'\) \|\| want\('feed'\)/.test(src) && /needSubs \? await listSubagentStatusBySession\(ctx, peopleSid, knownIds\) : \[\]/.test(src),
    'people/feed：子会话清单解析被分节挡住（这是重会话最大的一块）', '');
  check(/if \(needSubs && !subs\.length && peopleSid !== sid\)/.test(src), 'people/feed：归属回退也在同一分节内', '');
  check(/want\('people'\) \? await workflowChildLabels\(ctx, peopleSid\) : \{\}/.test(src), 'people：workflow 标签只在分节内取', '');
  check(/if \(want\('people'\)\) \{\n\s*if \(subs\.length > MAX_ROLE_SUBS\)/.test(src), 'people：角色解析带硬上限分支', '');
  check(/want\('people'\) \? subs\.map\(\(s\) => \{/.test(src) && /\}\) : \[\];/.test(src),
    'people：agents 在摘要里是**空数组**（不是"没有成员"—— 由 sections 区分）', '');
  check(/if \(want\('people'\)\) sel\.members = enrichMembers\(/.test(src), 'people：成员 enrich 只在分节内（否则空 subById 会把名册糊成"未启动"）', '');
  check(/if \(want\('feed'\)\) \{/.test(src) && /const feedTargets = subs\.slice\(0, MAX_FEED_AGENTS\)/.test(src),
    'feed：每 agent 事件流只在分节内收集，且 agent 数封顶', '');
  check(/const needSubs = want\('people'\) \|\| want\('feed'\)/.test(src),
    'feed 也依赖 subs（否则 feed-only 请求会**静默变空** —— 缺块 ≠ 空数据）', '');
  check(/if \(want\('artifacts'\)\) \{/.test(src), 'artifacts：RUN.log 尾 + git 改动只在分节内读', '');
  check(/if \(want\('people'\) && !taskList\(sel\.tasks\)\.length && subs\.length\)/.test(src), 'people：tasksLive 兜底投影同样受分节约束', '');
}

console.log('\n③ 硬上限 / 软期限：截断必须**如实上报**（不许静默丢）');
{
  check(/const MAX_ROLE_SUBS = /.test(src) && /DSH_EXPERT_TEAM_MAX_ROLE_SUBS/.test(src), '角色解析有硬上限（可用环境变量覆盖）', '');
  check(/degraded\.push\('roles:' \+ \(subs\.length - MAX_ROLE_SUBS\)\)/.test(src), '被上限挡住的条数进 degraded（带数量）', '');
  check(/const PEOPLE_DEADLINE_MS = /.test(src) && /DSH_EXPERT_TEAM_PEOPLE_DEADLINE_MS/.test(src), 'people 有软期限（可覆盖）', '');
  check(/degraded\.push\('wf:deadline'\)/.test(src), '超期限跳过 workflow 元数据时如实标注', '');
  check(/const ARTIFACTS_DEADLINE_MS = /.test(src) && /DSH_EXPERT_TEAM_ARTIFACTS_DEADLINE_MS/.test(src),
    'artifacts 有软期限（可覆盖）—— 它要跑 git，是全链最不可控的一段', '');
  check(/if \(!withinArtifacts\(\)\) degraded\.push\('artifacts:deadline'\)/.test(src), '超期限连 logTail 都不读时如实标注', '');
  check(/degraded\.push\('files:deadline'\)/.test(src), '读完 logTail 仍超期限 ⇒ 跳过 git 并单独如实标注', '');
  check(/const MAX_FEED_AGENTS = /.test(src) && /DSH_EXPERT_TEAM_MAX_FEED_AGENTS/.test(src), 'feed 有 agent 数硬上限（可覆盖）', '');
  check(/degraded\.push\('feed:' \+ \(subs\.length - MAX_FEED_AGENTS\)\)/.test(src), '被 feed 上限挡住的条数进 degraded（带数量）', '');
  check(/mark\('people-enrich'\)/.test(src), 'profile 补账：people 增强段有独立计时（原先并进 roles→tail 的大块）', '');
  check(/mark\('agents'\);[\s\S]{0,6000}?mark\('assemble'\);[\s\S]{0,6000}?mark\('artifacts'\);[\s\S]{0,6000}?mark\('tail'\);/.test(src),
    'profile 补账点按执行顺序覆盖「agents → 装配 → 工件 → 收尾」（真机上这 ~2 s 原先无账）', '');
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
  check(/stateUrl\('summary'\)/.test(clientSrc), 'summary 订阅在位（快、首屏用）', '');
  check(/function heavySectionsForTab\(tb\)/.test(clientSrc), '重分节按**当前可见标签**选（映射是单一真源）', '');
  check(!/stateUrl\('people,feed,artifacts'\)/.test(clientSrc),
    '不再无条件拉 people,feed,artifacts（重活常驻正是"快路径被拖慢"的根源）', '');
  check(/stateHubSubscribe\(stateUrl\(heavy\), Math\.max\(dispCfg\.pollMs, 6000\), onState\)/.test(clientSrc),
    '重块仍 ≥6 s 低频拉，但只拉当前标签那一块', '');
  check(/if \(tb === 'board'\) return ''/.test(clientSrc), '「盘」只要 runs[]（summary 已有）⇒ 不拉任何重分节', '');
  check(/stateHubFetch\(stateUrl\('artifacts'\), onState\)/.test(clientSrc),
    '「事」点开任务详情时才**一次性**补拉 artifacts（不常驻）', '');
  check(/}, \[sessionId, selRunV, isOpen, viewMode, dispCfg\.pollMs, tab\]\)/.test(clientSrc),
    '订阅 effect 依赖 tab（切标签即换订阅）', '');
  check(/function mergeStatePayload\(prev, d\)/.test(clientSrc), '合并函数在位（缺块 ≠ 空数据）', '');
  check(/if \(section\) q\.push\('section=' \+ encodeURIComponent\(section\)\)/.test(clientSrc), 'stateUrl 支持 section 参数', '');
  check(/function stateHubBaseOf\(u\)/.test(clientSrc), 'hub 按 URL 各自计时（否则慢块被快钟拖着跑）', '');
  check(/&section=people,feed/.test(clientSrc), '徽章订阅只要 people,feed（不拉 artifacts）', '');
  // ── 同一时刻**至多一条重活**（这是 4.8 s ≈ 2×2.4 s 的真正原因：两条重分节 URL 并发，
  //    同一事件循环上串行 ⇒ 各自看着慢一倍，还把 summary 拖到 772 ms）──
  check(/function publishToLive\(d\)/.test(clientSrc) && /liveStore\.data = Object\.assign\(\{\}, liveStore\.data \|\| \{\}, d\)/.test(clientSrc),
    '面板/画布把 payload **发布**给徽章（发布时合并 —— 缺块 ≠ 空数据）', '');
  check(/if \(pubs > 0\) return function \(\) \{ liveStore\.subs\.delete\(fn\) \}/.test(clientSrc),
    '有发布者时徽章**不再另开**一条重分节（否则 info 标签下会两条重活并发）', '');
  check(/var pubs = useLivePublishers\(\)/.test(clientSrc) && /\}, \[sid, pubs\]\)/.test(clientSrc),
    '徽章订阅随发布者数量重评（开着面板就停自己的轮询）', '');
  check(/if \(tb === 'tasks'\) return 'people,feed'/.test(clientSrc),
    '「事」与徽章共用 canonical `people,feed` ⇒ hub 合并成同一条（不产生第二条重活）', '');
  // 映射本身只允许产出 canonical 组合（否则又会造出第三条重活 URL）
  {
    const mapBody = (clientSrc.match(/function heavySectionsForTab\(tb\) \{[\s\S]*?\n    \}/) || [''])[0];
    const returns = [...mapBody.matchAll(/return '([^']*)'/g)].map((m) => m[1]);
    check(mapBody.length > 100, '取到映射函数体（不是空串 —— 防"匹配不到 ⇒ 永远通过"）', 'len ' + mapBody.length);
    check(returns.length === 4 && returns.every((r) => r === '' || r === 'people,feed' || r === 'artifacts'),
      '映射只产出 canonical 重分节（people,feed / artifacts / 空），不会造出第三条重活 URL', JSON.stringify(returns));
  }
}

console.log('');
if (fail > 0) {
  console.log(`✗ /state 分节测试失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ /state 分节通过（解析语义 / 贵块分节 / 上限与 degraded / 摘要不写盘 / 客户端双订阅+合并）');
