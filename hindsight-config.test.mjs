// Hindsight 记忆后端**诊断 + 配置**的回归护栏（2026-09-15，1.3.18 一期诊断 / 1.3.21 二期写路径）。
//
// 背景：用户的两类记忆故障都在**服务端**，客户端此前只把原始 JSON/HTML 抛出来：
//   · `… -> 500 {"detail":"could not resize shared memory segment … No space left on device"}`
//     ⇒ 服务端 PostgreSQL 分配共享内存失败（自托管最常见：容器 `/dev/shm` 只有 64 MB）；
//   · `… -> 403 <!doctype html><html>…网站防火墙…` ⇒ 服务端 **WAF 返回 HTML 防火墙页**（**不是 token 问题**）。
//
// 本文件钉九件事：① 分类器正反例（含两条真实原文）；② 摘要必须**剥 HTML + 压平 + 截断**；
// ③ 日志解析的"两种零"（`inject_empty` = 召回为空 **不是失败**；坏行/半行不许抛）；
// ④ 形态/地址/bank 的语义；⑤ 探测语义（**不探测绝不发网络**；任何 HTTP 响应都算可达）；
// ⑥ **诊断模块只读**（源码级：无写入、无 POST）；⑦ 写路径的**纯函数**（只改提交的键 / 保留未知键 /
// 空串 ≠ 删除 / daemon 强制地址不悄悄改写）；⑧ 写路径的**落盘**（0600 原子写、校验不过盘上逐字节不变、
// 显式 clear 才删）；⑨ **token 不回显 + 来源守卫**（回执全文、错误信息里一律不得出现 token 明文）。
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmFixture } from './test-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (ok, name, detail) => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const hs = await import(join(here, 'lib', 'hindsight-config.js'));

// 两条**真实日志原文**（来自用户机器的 `~/.hindsight/coding-agents-logs/diag.jsonl`）
const PG_500 = 'POST https://qbbt.8nit.cn/v1/default/banks/coding-agent%3A%3Aliangge/knowledge-base/pages -> 500 {"detail":"could not resize shared memory segment \\"/PostgreSQL.3111854576\\" to 533794976 bytes: No space left on device"}';
const WAF_403 = 'POST https://qbbt.8nit.cn/v1/default/banks/coding-agent%3A%3Adsh/memories -> 403 <!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>网站防火墙</title>\n</head>\n<body>您的请求被拦截</body>\n</html>';

console.log('\n① 分类器（启发式；两条真实原文必须各自归到自己的类）');
{
  const a = hs.classifyFailure(PG_500);
  check(a.classification === 'server-shm-or-disk', 'PG 共享内存 500 ⇒ server-shm-or-disk', a.classification);
  check(/shm-size|dev\/shm/.test(a.hint), 'hint 指向容器 `/dev/shm` / `--shm-size`（可操作）', a.hint.slice(0, 40));

  const b = hs.classifyFailure(WAF_403);
  check(b.classification === 'http-403-html', '403 + HTML 页 ⇒ http-403-html（**只描述观察到的现象**）', b.classification);
  // ⚠️ 纠错（2026-09-16）：旧分类名 `waf-blocked` 与旧话术（"检查 WAF / 加白名单"）**超出证据**，
  // 真机上把用户和派工方都误导了。403 + HTML **推不出** WAF；本页也不该对未确定的根因给整改动作。
  check(!/\bWAF\b/i.test(b.classification + b.hint) && !/白名单/.test(b.hint),
    '分类名与话术都**不含** WAF / 白名单这类未验证的断言（这是本次纠错的核心）', b.classification + ' | ' + b.hint.slice(0, 30));
  check(/不是根因/.test(b.hint) && /已恢复|历史/.test(b.hint), '话术只陈述观察到的事实 + 指出要先看"之后是否已有成功"', b.hint.slice(0, 40));
  check(a.classification !== b.classification, '**两种故障不会混成一类**（这正是本期要区分的事）', `${a.classification} vs ${b.classification}`);

  check(hs.classifyFailure('POST https://x/v1/… -> 401 {"detail":"invalid token"}').classification === 'auth', '401（无 HTML）⇒ auth', '');
  check(hs.classifyFailure('… -> 403 {"detail":"forbidden"}').classification === 'auth', '403（无 HTML，JSON 体）⇒ auth（不是 WAF）', '');
  check(hs.classifyFailure('… -> 502 Bad Gateway').classification === 'server-5xx', '502 ⇒ server-5xx', '');
  check(hs.classifyFailure('fetch failed: ECONNREFUSED 127.0.0.1:9077').classification === 'unreachable', 'ECONNREFUSED ⇒ unreachable（本地部署没起）', '');
  check(hs.classifyFailure('一切都好').classification === 'unknown', '无关文本 ⇒ unknown（不硬猜）', '');
}

console.log('\n② 摘要：剥 HTML / 压平空白 / 截断 ≤200 字');
{
  const s = hs.summarizeError(WAF_403);
  check(!/<\/?[a-zA-Z!]/.test(s) && !/doctype|<\/title/i.test(s), 'HTML 标签已剥净（正文里的 `->` 箭头不算 HTML）', s.slice(0, 50));
  check(!/\n/.test(s) && !/\s{2,}/.test(s), '换行/多余空白已压平（否则 UI 会被 HTML 撑爆）', '');
  check(/403/.test(s) && /网站防火墙|拦截/.test(s), '保留关键信息（状态码 + 防火墙字样）', s.slice(0, 60));
  const long = hs.summarizeError('x'.repeat(500));
  check(long.length === 201 && long.endsWith('…'), '超长摘要截断到 200 字 + 省略号', String(long.length));
  check(hs.summarizeError(null) === '' && hs.summarizeError(undefined) === '', 'null/undefined ⇒ 空串（不抛）', '');
}

console.log('\n③ 日志解析：两种零分得开；坏行/半行不许抛');
{
  const ok = hs.pickLastFailure([
    JSON.stringify({ ts: '2026-09-15T12:05:26Z', event: 'retain_failed', ms: 1003, error: WAF_403 }),
    JSON.stringify({ ts: '2026-09-15T12:06:00Z', event: 'inject_empty', ms: 12 }),
  ].join('\n'));
  check(ok && ok.classification === 'http-403-html' && ok.at === '2026-09-15T12:05:26Z', '取到带 error 的那条并分类', ok && ok.classification);
  // 新判据（2026-09-16 第二次纠错）：不再有那个"把一切无 error 记录都算成功"的混合计数。
  // 失败的操作是 `retain`，其后只有一次 `inject_empty` ⇒ 同类成功 0，且**不得**判为已恢复。
  check(ok && ok.sinceFailure && ok.sinceFailure.recovered === false
    && ok.sinceFailure.sameKind && ok.sinceFailure.sameKind.count === 0
    && ok.sinceFailure.emptyRecalls === 1,
    '失败之后**没有同类成功**、只有一次召回为空 ⇒ recovered=false / sameKind.count=0 / emptyRecalls=1（三者分开）',
    JSON.stringify(ok && ok.sinceFailure && { recovered: ok.sinceFailure.recovered, same: ok.sinceFailure.sameKind && ok.sinceFailure.sameKind.count, empty: ok.sinceFailure.emptyRecalls }));
  check(ok && ok.op === 'retain' && ok.kind === 'write',
    '失败记录本身带上「操作/类别」（retain_failed ⇒ retain / write）—— 判"同类证据"必须先知道失败在哪一类',
    ok && (ok.op + ' / ' + ok.kind));

  check(hs.pickLastFailure(JSON.stringify({ ts: 't', event: 'inject_empty', ms: 3 })) === null,
    '**只有 `inject_empty`（召回为空）⇒ 不算失败**（两种零必须分得开）', '');
  check(hs.pickLastFailure('not json\n{"broken":') === null, '坏行/半行 ⇒ null，不抛', '');
  const half = hs.pickLastFailure([JSON.stringify({ ts: 't1', event: 'retain_failed', error: PG_500 }), '{"ts":"t2","event":"retain_fail'].join('\n'));
  check(half && half.classification === 'server-shm-or-disk', '末行半行（被截断的写入）⇒ 用上一条完整记录', half && half.classification);
  check(hs.pickLastFailure('') === null, '空日志 ⇒ null', '');
}

console.log('\n④ 配置解析：只输出可公开字段（token 只折算成布尔）');
{
  const p = hs.parseConfigText(JSON.stringify({ serverMode: 'self-hosted', apiUrl: 'https://qbbt.8nit.cn', apiToken: 'SENTINEL-abc' }));
  check(p && p.serverMode === 'self-hosted' && p.apiUrl === 'https://qbbt.8nit.cn' && p.apiTokenConfigured === true, '三键正常解析', JSON.stringify({ ...p, apiTokenConfigured: p.apiTokenConfigured }));
  check(Object.keys(p).sort().join(',') === 'apiTokenConfigured,apiUrl,serverMode', '**返回对象只有三个键**（没有 token 字段）', Object.keys(p).join(','));
  check(!JSON.stringify(p).includes('SENTINEL-abc'), '解析结果里**不含 token 值**', '');
  check(hs.parseConfigText('{not json') === null && hs.parseConfigText('[]') === null && hs.parseConfigText('') === null, '非法 JSON / 数组 / 空 ⇒ null（不抛）', '');
  check(hs.parseConfigText(JSON.stringify({ serverMode: 'nope' })).serverMode === 'nope', '未知 serverMode 如实回传（不静默改写成别的形态）', '');
}

console.log('\n⑤ 形态 / 地址 / bank 语义（与 Hindsight 的约定一致）');
{
  check(hs.effectiveApiUrl({ serverMode: 'daemon', apiUrl: 'https://ignored.example' }) === hs.HINDSIGHT_DAEMON_URL,
    'daemon ⇒ **强制**本地地址（忽略 apiUrl）', hs.HINDSIGHT_DAEMON_URL);
  check(hs.effectiveApiUrl({ serverMode: 'cloud' }) === hs.HINDSIGHT_CLOUD_URL, 'cloud 且未写 apiUrl ⇒ 官方默认域名', hs.HINDSIGHT_CLOUD_URL);
  check(hs.effectiveApiUrl({ serverMode: 'self-hosted', apiUrl: 'https://qbbt.8nit.cn/' }) === 'https://qbbt.8nit.cn',
    'self-hosted ⇒ 照抄 apiUrl（只去掉尾部斜杠）', '');
  check(hs.effectiveApiUrl({}) === null, '什么都没写 ⇒ null（不编默认值）', '');
  check(hs.bankForWorkspace('/Users/yangbingtao/Documents/dsh') === 'coding-agent::dsh', 'bank 名 = `coding-agent::<工作区目录名>`', hs.bankForWorkspace('/Users/yangbingtao/Documents/dsh'));
  check(hs.bankForWorkspace('') === null && hs.bankForWorkspace(undefined) === null, '没有 cwd ⇒ null（不硬编假的 bank）', '');
}

console.log('\n⑥ 探测语义：不探测绝不发网络；任何 HTTP 响应都算"可达"（连通 ≠ 鉴权）');
{
  const cfgText = JSON.stringify({ serverMode: 'self-hosted', apiUrl: 'https://qbbt.8nit.cn', apiToken: 'SENTINEL-abc' });
  const diagText = JSON.stringify({ ts: '2026-09-15T12:05:26Z', event: 'retain_failed', error: WAF_403 });
  const ioOf = (hasCfg = true, hasDiag = true) => ({
    readText: async (p) => {
      if (hasCfg && p.endsWith('coding-agent.json')) return cfgText;
      if (hasDiag && p.endsWith('diag.jsonl')) return diagText;
      throw new Error('ENOENT: no such file');
    },
  });

  let calls = 0;
  const neverFetch = async () => { calls += 1; throw new Error('不该被调用'); };
  const noProbe = await hs.buildHindsightReport({ env: {}, home: '/fake/home', cwd: '/Users/x/liangge', probe: false, io: ioOf(), fetchImpl: neverFetch });
  check(noProbe.ok === true && noProbe.exists === true, '报告形状：`ok`/`exists` 在场', '');
  check(noProbe.reachable === null && noProbe.probeMs === null, '**不带 probe ⇒ reachable/probeMs = null**（界面据此显示"未探测"）', '');
  check(calls === 0, '**不带 probe ⇒ 一次网络请求都没发**（这是"进页面不会打服务端"的保证）', `calls=${calls}`);
  check(noProbe.apiTokenConfigured === true && typeof noProbe.apiTokenConfigured === 'boolean', 'apiTokenConfigured 是布尔（不是值）', String(noProbe.apiTokenConfigured));
  check(!JSON.stringify(noProbe).includes('SENTINEL-abc'), '**安全红线：整个响应全文不含 token 值**', '');
  check(noProbe.bankForWorkspace === 'coding-agent::liangge', '带 cwd ⇒ 给出本工作区 bank', String(noProbe.bankForWorkspace));
  check(noProbe.lastFailure && noProbe.lastFailure.classification === 'http-403-html', '最近失败已分类并带 hint', noProbe.lastFailure && noProbe.lastFailure.classification);
  check(noProbe.lastFailure && noProbe.lastFailure.sinceFailure
    && typeof noProbe.lastFailure.sinceFailure.recovered === 'boolean'
    && noProbe.lastFailure.sinceFailure.sameKind && typeof noProbe.lastFailure.sinceFailure.sameKind.count === 'number'
    && noProbe.lastFailure.op === 'retain' && noProbe.lastFailure.kind === 'write',
    '报告里的 lastFailure 带 `sinceFailure`（判"历史还是当前"的承重字段）＋ 失败自身的 `op`/`kind`（判"同类证据"的前提）',
    JSON.stringify({ op: noProbe.lastFailure.op, kind: noProbe.lastFailure.kind, recovered: noProbe.lastFailure.sinceFailure.recovered, sameKind: (noProbe.lastFailure.sinceFailure.sameKind || {}).count }));
  const keys = Object.keys(noProbe).sort().join(',');
  check(keys === 'apiTokenConfigured,apiUrl,apiUrlEffective,bankForWorkspace,diagPath,exists,lastFailure,notes,ok,path,probeMs,reachable,serverMode',
    '报告字段集合稳定（前端可依赖）', keys);

  let probedUrl = '';
  const fakeFetch = async (u) => { probedUrl = String(u); return { status: 401 }; };
  const withProbe = await hs.buildHindsightReport({ env: {}, home: '/fake/home', probe: true, io: ioOf(), fetchImpl: fakeFetch });
  check(withProbe.reachable === true && typeof withProbe.probeMs === 'number', '**401 也算可达**（连通 ≠ 鉴权成功）', `reachable=${withProbe.reachable}`);
  check(probedUrl === 'https://qbbt.8nit.cn/v1/default/banks', '探测打到 `/v1/default/banks`（只读端点）', probedUrl);
  check(withProbe.notes.some((n) => /连通/.test(n)), 'notes 如实说明"只验连通、不带 token"的语义', '');

  const downFetch = async () => { throw new Error('fetch failed: ECONNREFUSED'); };
  const down = await hs.buildHindsightReport({ env: {}, home: '/fake/home', probe: true, io: ioOf(), fetchImpl: downFetch });
  check(down.reachable === false && down.notes.some((n) => /探测失败/.test(n)), '连接失败 ⇒ reachable=false + note（不抛）', '');

  const noCfg = await hs.buildHindsightReport({ env: {}, home: '/fake/home', probe: true, io: ioOf(false, false), fetchImpl: neverFetch });
  check(noCfg.exists === false && noCfg.reachable === null && noCfg.lastFailure === null,
    '**配置文件与日志都不存在 ⇒ fail-open**（exists=false / reachable=null / lastFailure=null，不抛）', '');
  check(noCfg.notes.length >= 2, '缺失原因写进 notes（不静默）', String(noCfg.notes.length));

  const broken = await hs.buildHindsightReport({ env: {}, home: '/fake/home', io: { readText: async () => '{oops' }, fetchImpl: neverFetch });
  check(broken.exists === true && broken.serverMode === null && broken.apiTokenConfigured === false,
    '配置存在但非法 JSON ⇒ 不抛，且 token 判为未配置', '');
}

console.log('\n⑦ 纪律的源码级守卫（诊断模块只读 / 写模块原子写 / token 不回显）');
{
  // 一期那个模块**仍然是只读的** —— 这正是把写路径拆成独立模块的理由：
  // "诊断可以放心调用、它不会改任何东西"这句话必须继续成立（有源码级断言盯着）。
  const modSrc = readFileSync(join(here, 'lib', 'hindsight-config.js'), 'utf8');
  check(!/writeFile|writeText|createWriteStream|mkdir|rename\(|rm\(/.test(modSrc), '**诊断模块内没有任何写入 API**（这句话继续成立）', '');
  check(!/method:\s*'POST'|method:\s*"POST"/.test(modSrc), '诊断模块内没有 POST（只有探测用的 GET）', '');

  const wSrc = readFileSync(join(here, 'lib', 'hindsight-config-write.js'), 'utf8');
  // 原子写本身现在**只有一份实现**（`lib/host-state-file.js`）—— 写模块委派给它，自己的直写归零。
  // 这样写绕过棘轮（`scripts/check-write-bypass.mjs`）才不必为"同一段逻辑换个文件再抄一遍"开豁免口子。
  check(/from '\.\/host-state-file\.js'/.test(wSrc) && /writeHostStateFileAtomic\(/.test(wSrc),
    '写模块**委派**给宿主状态文件受控入口（原子写的唯一实现处）', '');
  check(!/\brename\s*\(/.test(wSrc) && !/\bwriteFile\s*\(/.test(wSrc),
    '写模块里**没有直写调用**（临时文件 + 换名不许散落多处）', '');
  check(!/from '\.\/command\.js'/.test(wSrc), '写模块不从 command.js 反向 import（叶子纪律，不成环）', '');
  check(/from '\.\/hindsight-config\.js'/.test(wSrc), '写模块复用诊断模块的真源（不另抄一份常量/解析）', '');

  const hSrc = readFileSync(join(here, 'lib', 'host-state-file.js'), 'utf8');
  check(/\.sync\(\)/.test(hSrc) && /rename\(/.test(hSrc), '受控入口用**临时文件 + fsync + rename**（原子替换）', '');
  check(/0o600/.test(hSrc) && /0o700/.test(hSrc), '受控入口显式设 0600（文件）/ 0700（目录）', '');

  const cmdSrc = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  check(cmdSrc.includes("path: '/plugins/dsh-expert-team/hindsight-config'"), '路由已注册', '');
  const at = cmdSrc.indexOf("path: '/plugins/dsh-expert-team/hindsight-config'");
  check(at !== -1 && cmdSrc.slice(at, at + 300).includes("methods: ['GET', 'POST']"), '二期同时暴露 GET（诊断）与 POST（写配置）', '');
  check(cmdSrc.slice(at - 400, at).includes('registerLocal({'), '走 registerLocal（本机来源守卫；棘轮也盯着这条）', '');

  const cliSrc = readFileSync(join(here, 'client.js'), 'utf8');
  check(/h\(HindsightBlock\)/.test(cliSrc), '设置页里渲染了这个块', '');
  const cAt = cliSrc.indexOf("'/plugins/dsh-expert-team/hindsight-config'");
  check(cAt !== -1, '客户端确实打这条路由', '');
  check(/'password'/.test(cliSrc) && /autoComplete: 'off'/.test(cliSrc), 'token 输入框是 password 且关自动填充', '');
  check(!/\bd\.apiToken\b/.test(cliSrc), '**客户端从不读响应里的 token 字段**（后端根本不发 ⇒ 界面也无从回填）', '');
  check(/token[^\n]{0,40}值不显示|value never shown/.test(cliSrc), '界面明确写出"token 值不显示"', '');
  check(/clear: \[key\]/.test(cliSrc), '客户端清除走显式 `clear`（空串不当删除）', '');
}

console.log('\n⑧ 写路径的纯函数（只改提交的键 / 保留未知键 / 校验不过不算数 / 空串 ≠ 删除）');
{
  const w = await import(join(here, 'lib', 'hindsight-config-write.js'));
  const EXISTING = JSON.stringify({
    serverMode: 'self-hosted', apiUrl: 'https://qbbt.8nit.cn', apiToken: 'SENTINEL-old',
    未来键: { keep: [1, 2] }, legacyFlag: true,
  }, null, 2) + '\n';

  // ① 只改 token ⇒ 其余键（含**我们不认识**的）逐字节保留
  const p1 = w.planHindsightConfigWrite(EXISTING, { apiToken: 'SENTINEL-new' });
  check(p1.ok && p1.saved, '合法补丁 ⇒ ok + saved', JSON.stringify(p1.errors));
  check(p1.changed.join(',') === 'apiToken', '只把 apiToken 记为改动', p1.changed.join(','));
  check(p1.safe.apiTokenConfigured === true && !JSON.stringify(p1.safe).includes('SENTINEL'), '**safe 里只有布尔、没有 token 值**', JSON.stringify(p1.safe));
  const next1 = JSON.parse(p1.text);
  check(next1.未来键 && next1.未来键.keep.length === 2 && next1.legacyFlag === true, '**未知键原样保留**（升级后多出来的键不许被写没）', Object.keys(next1).join(','));
  check(next1.serverMode === 'self-hosted' && next1.apiUrl === 'https://qbbt.8nit.cn', '未提交的键保持原值', '');
  check(!p1.text.includes('SENTINEL-old'), '旧 token 已被替换（不会被留在文件里）', '');
  check(p1.needsRestart === false, '只改 token ⇒ **不需要重启**', '');

  // ② 改 serverMode/apiUrl ⇒ 需要重启
  const p2 = w.planHindsightConfigWrite(EXISTING, { apiUrl: 'https://new.example/' });
  check(p2.ok && p2.saved && p2.needsRestart === true, '改 apiUrl ⇒ needsRestart=true', '');
  check(JSON.parse(p2.text).apiUrl === 'https://new.example', '尾部斜杠被去掉', '');
  check(p2.notes.some((n) => /尾部斜杠/.test(n)), '去掉斜杠这件事**写进 notes**（不是悄悄改）', '');
  check(p2.changed.join(',') === 'apiUrl', 'changed 只报 apiUrl', p2.changed.join(','));

  // ③ 校验：非法 serverMode / 带 /v1 的地址 / 非 http(s) ⇒ 拒绝，且不产出可写文本
  const badMode = w.planHindsightConfigWrite(EXISTING, { serverMode: 'on-prem' });
  check(!badMode.ok && badMode.text === null && badMode.errors.some((e) => /serverMode/.test(e)), '非法 serverMode ⇒ 拒绝（没有可写文本）', badMode.errors.join(' '));
  const badUrl = w.planHindsightConfigWrite(EXISTING, { apiUrl: 'https://qbbt.8nit.cn/v1' });
  check(!badUrl.ok && badUrl.errors.some((e) => /\/v1/.test(e)), '带 `/v1` 的地址 ⇒ 拒绝，并说清"Hindsight 自己会拼 /v1"', badUrl.errors.join(' '));
  check(!w.planHindsightConfigWrite(EXISTING, { apiUrl: 'ftp://x' }).ok, '非 http(s) ⇒ 拒绝', '');

  // ④ 空串/空白 ⇒ 保持原值不变（**不是删除**）
  const emptyTok = w.planHindsightConfigWrite(EXISTING, { apiToken: '   ' });
  check(emptyTok.ok && emptyTok.saved === false && emptyTok.changed.length === 0, '空 token ⇒ 无改动、无可写文本（不写盘）', JSON.stringify(emptyTok.changed));
  check(emptyTok.notes.some((n) => /保持原值不变/.test(n)), 'notes 明确写"保持原值不变（空串不等于删除）"', '');

  // ⑤ 显式清除才是删除
  const cleared = w.planHindsightConfigWrite(EXISTING, { clear: ['apiToken'] });
  check(cleared.ok && cleared.saved && !('apiToken' in JSON.parse(cleared.text)), '`clear:["apiToken"]` ⇒ 真的删掉该键', '');
  check(cleared.removed.join(',') === 'apiToken' && cleared.changed.join(',') === 'apiToken', 'removed/changed 都如实报它', '');
  check(w.planHindsightConfigWrite(EXISTING, { clear: ['serverMode'] }).ok === false, '不可清除的键 ⇒ 拒绝（可清除集合是显式白名单）', '');
  check(w.planHindsightConfigWrite(EXISTING, { apiToken: 'x', clear: ['apiToken'] }).ok === false, '同一个键既写又清 ⇒ 拒绝（不做"最后一个赢"的猜测）', '');

  // ⑥ 现有文件不是合法 JSON ⇒ **拒绝覆盖**（盲目合并等于把未知内容写没）
  const broken = w.planHindsightConfigWrite('# 手写备注\n{oops', { apiToken: 'x' });
  check(!broken.ok && /拒绝写入/.test(broken.errors.join(' ')), '坏 JSON ⇒ 拒绝写入', broken.errors.join(' ').slice(0, 60));

  // ⑦ 没有改动 ⇒ saved:false（不假报成功）
  const same = w.planHindsightConfigWrite(EXISTING, { apiToken: 'SENTINEL-old' });
  check(same.ok && same.saved === false && same.text === null, '提交值与现值相同 ⇒ **没有改动、不写盘**', '');
  check(same.notes.some((n) => /完全一致/.test(n)), 'notes 如实说"完全一致 ⇒ 未写盘"', '');

  // ⑧ daemon 形态：强制地址**不悄悄改写、也不悄悄接受**
  const daemonDst = w.planHindsightConfigWrite(EXISTING, { serverMode: 'daemon', apiUrl: 'https://qbbt.8nit.cn' });
  check(!daemonDst.ok && /强制/.test(daemonDst.errors.join(' ')), 'daemon + 别的 apiUrl ⇒ 拒绝，并写明"被强制"与两条出路', daemonDst.errors.join(' ').slice(0, 70));
  const daemonOk = w.planHindsightConfigWrite(EXISTING, { serverMode: 'daemon', clear: ['apiUrl'] });
  check(daemonOk.ok && daemonOk.saved && JSON.parse(daemonOk.text).serverMode === 'daemon', 'daemon + `clear:["apiUrl"]` ⇒ 允许（给出的出路真的走得通）', daemonOk.errors.join(' '));
  const daemonStale = w.planHindsightConfigWrite(EXISTING, { serverMode: 'daemon' });
  check(daemonStale.ok && daemonStale.forcedApiUrl === true && daemonStale.notes.some((n) => /强制/.test(n)),
    '切到 daemon 但文件里留着别的 apiUrl ⇒ 允许，但**写明它不生效**（forcedApiUrl=true）', '');
  check(w.planHindsightConfigWrite(EXISTING, { serverMode: 'daemon', apiUrl: w.HINDSIGHT_DAEMON_URL }).ok, 'daemon + 它自己的强制地址 ⇒ 接受', '');

  // ⑨ 文件还不存在（首次配置）也能从零写
  const fresh = w.planHindsightConfigWrite(null, { serverMode: 'cloud', apiToken: 'SENTINEL-new' });
  check(fresh.ok && fresh.saved && JSON.parse(fresh.text).serverMode === 'cloud', '文件不存在 ⇒ 从 `{}` 起写', '');

  // ⑩ **敌意**检查：把机密**误粘进别的字段**，错误信息里也不许出现它。
  // 为什么必须这么测："哪个字段装的是 token"是个靠不住的判据（粘错栏就会漏），
  // 所以"不回显"必须由**结构**保证：回执里根本没有任何"用户提交的原值"。
  const LEAK = 'SENTINEL-TOKEN-9f3a';
  const mis = [
    w.planHindsightConfigWrite(EXISTING, { serverMode: LEAK }),
    w.planHindsightConfigWrite(EXISTING, { apiUrl: LEAK }),
    w.planHindsightConfigWrite(EXISTING, { clear: [LEAK] }),
  ];
  check(mis.every((p) => !p.ok), '（前置）三种误粘都被拒绝', mis.map((p) => p.ok).join(','));
  check(mis.every((p) => !JSON.stringify(p).includes(LEAK)),
    '**误粘进 serverMode / apiUrl / clear 的值，回执全文同样不回显**',
    mis.map((p) => JSON.stringify(p).includes(LEAK)).join(','));
}

console.log('\n⑨ 路由级：真的落盘 / 0600 / 校验不过不动盘 / token 不回显 / 来源守卫');
const root = await mkdtemp(join(tmpdir(), 'et-hindsight-'));
process.env.DSH_HOME = join(root, 'fake-dsh');
const cfgFile = join(root, 'hindsight', 'coding-agent.json');
const prevCfgEnv = process.env.HINDSIGHT_CONFIG;
process.env.HINDSIGHT_CONFIG = cfgFile;
{
  const { apply } = await import(join(here, 'lib', 'command.js'));
  let hsHandler = null;
  apply({
    commands: { register: () => {} },
    on: () => {},
    get: () => undefined,
    inject: (deps, f) => {
      if (String(deps) !== 'webServer') return;
      f({ effect: (fn) => { fn(); }, webServer: { register: (c) => { if (String(c.path).endsWith('/hindsight-config')) hsHandler = c.handler; return () => {}; } } });
    },
  });
  check(typeof hsHandler === 'function', '路由已注册（走 withRoute 共享件）');

  const call = async (method, body, headers) => {
    const out = { code: 0, text: '' };
    const req = { method, url: '/plugins/dsh-expert-team/hindsight-config', headers };
    if (body !== undefined) req.body = JSON.stringify(body);
    await hsHandler(req, { writeHead: (c) => { out.code = c; }, end: (b) => { out.text = String(b || ''); } });
    return { code: out.code, text: out.text, json: (() => { try { return JSON.parse(out.text); } catch { return null; } })() };
  };
  const errsOf = (r) => ((r.json && r.json.errors) || []).join(' ');

  const SENTINEL = 'SENTINEL-TOKEN-9f3a';

  // ── 首次写入：文件不存在 ⇒ 建目录、落盘、0600 ──
  {
    const r = await call('POST', { serverMode: 'self-hosted', apiUrl: 'https://qbbt.8nit.cn', apiToken: SENTINEL });
    check(r.code === 200 && r.json && r.json.ok && r.json.saved === true, 'POST 合法补丁 ⇒ 200 + saved', `${r.code} ${errsOf(r)}`);
    check(!r.text.includes(SENTINEL), '**回执全文不含 token 值**', '');
    check(r.json.apiTokenConfigured === true, '回执只给"是否已配置"布尔', String(r.json.apiTokenConfigured));
    check(r.json.needsRestart === true, '含 serverMode/apiUrl ⇒ 如实提示需重启', '');
    const onDisk = JSON.parse(await readFile(cfgFile, 'utf8'));
    check(onDisk.serverMode === 'self-hosted' && onDisk.apiUrl === 'https://qbbt.8nit.cn' && onDisk.apiToken === SENTINEL, '**真的落盘**（含 token）', '');
    const st = await stat(cfgFile);
    check((st.mode & 0o777) === 0o600, '**文件权限 = 0600**（token 就在里头）', '0' + (st.mode & 0o777).toString(8));
    const dirSt = await stat(join(root, 'hindsight'));
    check((dirSt.mode & 0o777) === 0o700, '目录权限 = 0700', '0' + (dirSt.mode & 0o777).toString(8));
  }

  // ── GET 仍然只读诊断、默认不探测、且不回显 token ──
  {
    const r = await call('GET');
    check(r.code === 200 && r.json && r.json.ok && r.json.exists === true, 'GET 仍返回诊断报告', '');
    check(!r.text.includes(SENTINEL), '**诊断响应全文同样不含 token 值**', '');
    check(r.json.reachable === null, '不带 probe ⇒ 不探测（一次网络都不发）', '');
  }

  // ── 校验失败 ⇒ 400 且盘上逐字节不变 ──
  {
    const before = await readFile(cfgFile, 'utf8');
    const r = await call('POST', { apiUrl: 'https://qbbt.8nit.cn/v1' });
    check(r.code === 400 && r.json && r.json.ok === false && /\/v1/.test(errsOf(r)), '带 /v1 ⇒ 400 + 明确原因', errsOf(r).slice(0, 60));
    check((await readFile(cfgFile, 'utf8')) === before, '**被拒绝时磁盘逐字节未变**', '');
    check((await call('POST', { serverMode: 'nope' })).code === 400, '非法形态 ⇒ 400', '');
    check((await readFile(cfgFile, 'utf8')) === before, '（同上）磁盘未变', '');
  }

  // ── 未知键保留 + 覆写后权限仍是 0600 ──
  {
    const withUnknown = JSON.stringify({ ...JSON.parse(await readFile(cfgFile, 'utf8')), 未来键: { keep: 1 }, legacyFlag: 'x' }, null, 2) + '\n';
    await writeFile(cfgFile, withUnknown);
    const r = await call('POST', { apiToken: 'SENTINEL-TOKEN-2' });
    check(r.code === 200 && r.json && r.json.saved === true && r.json.needsRestart === false, '只改 token ⇒ saved 且**无需重启**', errsOf(r));
    check(!r.text.includes('SENTINEL-TOKEN-2'), '回执里没有新 token 的值', '');
    const onDisk = JSON.parse(await readFile(cfgFile, 'utf8'));
    check(onDisk.未来键 && onDisk.legacyFlag === 'x', '**未知键原样保留**', Object.keys(onDisk).join(','));
    check(onDisk.apiToken === 'SENTINEL-TOKEN-2', '新 token 已落盘', '');
    const st = await stat(cfgFile);
    check((st.mode & 0o777) === 0o600, '覆写之后权限**仍是 0600**（rename 不会继承旧权限）', '0' + (st.mode & 0o777).toString(8));
  }

  // ── 现有文件坏 JSON ⇒ 拒绝且原文件逐字节未动 ──
  {
    const junk = '# 手写备注\n{oops\n';
    await writeFile(cfgFile, junk);
    const r = await call('POST', { apiToken: 'SENTINEL-3' });
    check(r.code === 400 && /拒绝写入/.test(errsOf(r)), '现有文件坏 JSON ⇒ 400 拒绝写入', errsOf(r).slice(0, 50));
    check((await readFile(cfgFile, 'utf8')) === junk, '**原文件逐字节未动**', '');
  }

  // ── 空串不改值；显式 clear 才删 ──
  {
    await writeFile(cfgFile, JSON.stringify({ serverMode: 'cloud', apiToken: 'SENTINEL-4', apiUrl: 'https://a.example' }, null, 2) + '\n');
    const keep = await call('POST', { apiToken: '   ' });
    check(keep.code === 200 && keep.json && keep.json.saved === false, '空 token ⇒ saved:false（不假报成功）', '');
    check(JSON.parse(await readFile(cfgFile, 'utf8')).apiToken === 'SENTINEL-4', '空 token **没有改值**（空串 ≠ 删除）', '');
    const cl = await call('POST', { clear: ['apiToken'] });
    check(cl.code === 200 && cl.json && cl.json.saved === true && cl.json.apiTokenConfigured === false, '`clear` ⇒ 删除并如实回"未配置"', '');
    const onDisk = JSON.parse(await readFile(cfgFile, 'utf8'));
    check(!('apiToken' in onDisk) && onDisk.serverMode === 'cloud', '盘上确实删了这个键、别的键还在', Object.keys(onDisk).join(','));
    check(!cl.text.includes('SENTINEL-4'), '回执不含被删掉的旧 token', '');
  }

  // ── 来源守卫：跨站写 / 非 JSON content-type / 非回环 Host ──
  {
    const xo = await call('POST', { apiToken: 'x' }, { origin: 'http://evil.example', 'content-type': 'application/json' });
    check(xo.code === 403, '跨站 POST ⇒ 403（DNS rebinding / CSRF 挡在守卫上）', String(xo.code));
    const ct = await call('POST', { apiToken: 'x' }, { 'content-type': 'text/plain' });
    check(ct.code === 415, '非 JSON content-type 的 POST ⇒ 415', String(ct.code));
    const host = await call('GET', undefined, { host: 'evil.example' });
    check(host.code === 403, '非回环 Host ⇒ 403', String(host.code));
    const loop = await call('GET', undefined, { host: '127.0.0.1:3080' });
    check(loop.code === 200, '回环 Host ⇒ 正常放行（守卫不是"一律拒绝"）', String(loop.code));
    // 被守卫拦下的那几次**一次都没写盘**
    check(JSON.parse(await readFile(cfgFile, 'utf8')).apiToken === undefined, '被 403/415 拦下的请求没有产生任何写入', '');
  }
}
process.env.HINDSIGHT_CONFIG = prevCfgEnv;
if (prevCfgEnv === undefined) delete process.env.HINDSIGHT_CONFIG;
console.log('\n⑨ 面板文案不许带 markdown 标记（这些字符串是**原样渲染**的，面板没有 markdown 渲染器）');
{
  // 真机实测（2026-09-16）：设置页「记忆后端（Hindsight）· 诊断与配置」里
  //   · 失败提示把 `**HTML 防火墙页**` 的星号**字面显示**出来；
  //   · 重启语义那段把 `serverMode` / `apiToken` 的**反引号字面显示**出来。
  // 根因不是"漏改两处"，而是**根本没有门禁**：这些文案以 `esc()` 原样进 DOM，
  // 写的人按 markdown 习惯加了标记，界面就把标记一起显示 —— 用户看到的是排版残渣。
  // 所以这里做一条**跨文件**的 lint（client.js + 两个 Hindsight 模块），并且带反空转：
  // 解析不到足够的字符串就红（否则"正则失配 ⇒ 零命中 ⇒ 假绿"）。
  const files = ['client.js', join('lib', 'hindsight-config.js'), join('lib', 'hindsight-config-write.js')];
  // 只认单/双引号字符串字面量；**先剥注释**（注释里用 markdown 是允许的，且本仓注释大量用反引号）。
  const LIT = /(^|[^\\])'([^'\\]*(?:\\.[^'\\]*)*)'|(^|[^\\])"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let scanned = 0;
  const leaks = [];
  for (const rel of files) {
    const lines = readFileSync(join(here, rel), 'utf8').split('\n');
    let inBlock = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
      if (t.startsWith('//') || t.startsWith('*')) return;
      LIT.lastIndex = 0;
      let m;
      while ((m = LIT.exec(line)) !== null) {
        const str = m[2] !== undefined ? m[2] : m[4];
        if (!str) continue;
        scanned += 1;
        const marks = [];
        if (/\*\*/.test(str)) marks.push('**粗体**');
        if (/`/.test(str)) marks.push('反引号');
        if (/\]\(/.test(str)) marks.push('markdown 链接');
        if (/(^|\s)#{1,6}\s/.test(str)) marks.push('# 标题');
        if (marks.length) leaks.push(`${rel}:${i + 1} [${marks.join('+')}] ${str.slice(0, 90)}`);
      }
    });
  }
  check(scanned > 500, 'lint 真的扫到了字符串字面量（反空转：解析失配不许静默通过）', '扫描 ' + scanned + ' 条字面量');
  check(leaks.length === 0,
    '三个会**原样渲染**的文件里没有任何 markdown 标记（星号/反引号/链接/标题）',
    leaks.length ? leaks.length + ' 处：' + leaks.slice(0, 4).join(' ｜ ') : '0 处');
  // 实证这条 lint 抓得住真事故：把当初那两处喂给它，必须命中（否则它只是"看着很严"的空壳）。
  const probe = "hint: '返回的是 **HTML 防火墙页**，改 `serverMode` 需重启'";
  const probeMarks = [];
  LIT.lastIndex = 0;
  const pm = LIT.exec(probe);
  if (pm) {
    const str = pm[2] !== undefined ? pm[2] : pm[4];
    if (/\*\*/.test(str)) probeMarks.push('**粗体**');
    if (/`/.test(str)) probeMarks.push('反引号');
  }
  check(probeMarks.length === 2, '把当初的两处泄漏喂给这条 lint ⇒ 两个标记都被认出来（不是空壳断言）', probeMarks.join('+'));
}


console.log('\n⑩ **历史失败 ≠ 当前故障**（2026-09-16 两次纠错）：判「已恢复」只认**同类证据**；读不到日志 ≠ 没有失败');
{
  const mk = (o) => JSON.stringify(o);
  const FAIL = mk({ ts: '2026-09-15T14:22:32.239Z', event: 'retain_failed', ms: 1200, error: WAF_403 });
  const OK1 = mk({ ts: '2026-09-15T16:34:26Z', event: 'retain_ok', ms: 88 });
  const OK2 = mk({ ts: '2026-09-15T16:36:00Z', event: 'retain_ok', ms: 74 });
  const EMPTY = mk({ ts: '2026-09-15T16:35:00Z', event: 'inject_empty', ms: 6 });
  // 断言里的**取值**一律走这三个 null-safe 取值器：旧代码没有这些字段时，
  // 断言要**逐条报红**（"修复前是红的"才算证据），而不是在详情表达式里崩掉。
  const sk = (sf) => (sf && sf.sameKind) || { count: 0, op: null, lastAt: null, lastMs: null, lastEvent: null };
  const bk = (sf, kind) => (sf && sf.byKind && sf.byKind[kind]) || { ok: 0, neutral: 0 };
  const bop = (sf, op) => (sf && sf.byOperation && sf.byOperation[op]) || { ok: 0, neutral: 0 };

  // ① 失败之后有**同操作**成功 ⇒ 判为历史，且证据能说清是哪一类
  const rec = hs.scanDiag([FAIL, EMPTY, OK1, OK2].join('\n'));
  check(rec.lastFailure && rec.lastFailure.op === 'retain' && rec.lastFailure.kind === 'write',
    '① 失败记录带上 op/kind（retain_failed ⇒ retain / write）—— 判"同类证据"必须先知道失败在哪一类',
    rec.lastFailure && (rec.lastFailure.op + ' / ' + rec.lastFailure.kind));
  check(rec.sinceFailure.recovered === true && sk(rec.sinceFailure).count === 2
    && sk(rec.sinceFailure).op === 'retain' && sk(rec.sinceFailure).lastEvent === 'retain_ok',
    '① 其后有 2 次**同类**（retain_ok）成功 ⇒ recovered=true，且 sameKind 指向同一个操作',
    JSON.stringify(rec.sinceFailure.sameKind));
  check(sk(rec.sinceFailure).lastAt === '2026-09-15T16:36:00Z' && sk(rec.sinceFailure).lastMs === 74,
    '① 同类证据的**最近一次**时间与耗时都取到（文案要用它们说清「最近 <ts>，耗时 <ms> ms」）',
    sk(rec.sinceFailure).lastAt + ' / ' + sk(rec.sinceFailure).lastMs);
  check(rec.sinceFailure.emptyRecalls === 1 && bk(rec.sinceFailure, 'read').ok === 0,
    '① 「召回为空」既不算成功也不算失败 ⇒ 单独计数，且不进任何 ok 桶',
    'empty=' + rec.sinceFailure.emptyRecalls + ' read.ok=' + bk(rec.sinceFailure, 'read').ok);

  // ② 【本次承重用例】写失败 + 其后**只有读路径 / 生命周期** ⇒ **不得**判为已恢复
  const wrong = hs.scanDiag([
    FAIL,
    mk({ ts: '2026-09-15T16:30:00Z', event: 'inject_ok', ms: 5 }),
    mk({ ts: '2026-09-15T16:31:00Z', event: 'session_start' }),
    mk({ ts: '2026-09-15T16:32:00Z', event: 'reflect_deferred_new_bank' }),
    EMPTY,
  ].join('\n'));
  check(wrong.sinceFailure.recovered === false && sk(wrong.sinceFailure).count === 0,
    '② **写失败 + 其后只有读路径/生命周期 ⇒ recovered=false**（真机上"结论碰巧对、证据撑不起结论"就是这个形态）',
    JSON.stringify({ recovered: wrong.sinceFailure.recovered, sameKind: sk(wrong.sinceFailure).count }));
  check(bk(wrong.sinceFailure, 'read').ok === 1 && bk(wrong.sinceFailure, 'lifecycle').neutral === 1
    && bk(wrong.sinceFailure, 'lifecycle').ok === 0,
    '② 分类计数互不串台：读路径成功进 read.ok；`session_start` 是 lifecycle.**neutral**（"发生了" ≠ "成功"）',
    JSON.stringify(wrong.sinceFailure.byKind));
  check(bk(wrong.sinceFailure, 'reflect').neutral === 1 && bk(wrong.sinceFailure, 'reflect').ok === 0,
    '② **被推迟**的事件（`reflect_deferred_new_bank`）算 neutral、**不算成功**（没干活的不许记成功）',
    JSON.stringify(bk(wrong.sinceFailure, 'reflect')));

  // ③ 跨类别不算证据：读失败 + 其后只有写成功 ⇒ 仍不得判为已恢复
  const cross = hs.scanDiag([mk({ ts: '2026-09-15T16:00:00Z', event: 'inject_failed', error: 'boom' }), OK1].join('\n'));
  check(cross.sinceFailure.recovered === false && bk(cross.sinceFailure, 'write').ok === 1,
    '③ 失败在**读**路径、其后只有**写**成功 ⇒ recovered=false（写成功证明不了读恢复了）',
    JSON.stringify({ recovered: cross.sinceFailure.recovered, writeOk: bk(cross.sinceFailure, 'write').ok }));

  // ④ 按**端点**分开归并：`pages_ok` 与 `retain_ok` 同属 write，但是两个不同的操作
  const ops = hs.scanDiag([FAIL, OK1, mk({ ts: '2026-09-15T16:40:00Z', event: 'pages_ok', ms: 30 })].join('\n'));
  check(bop(ops.sinceFailure, 'retain').ok === 1 && bop(ops.sinceFailure, 'pages').ok === 1
    && bk(ops.sinceFailure, 'write').ok === 2,
    '④ `retain`（写 memories）与 `pages`（写知识页）按端点分开计数，同时都归 write（那次 WAF 403 就出在 /pages 上）',
    JSON.stringify(ops.sinceFailure.byOperation));
  check(sk(ops.sinceFailure).count === 1,
    '④ 同类证据只认**同一个端点**（`pages_ok` 不被当成 `retain` 的同类成功）', String(ops.sinceFailure.sameKind.count));

  // ⑤ 失败之后没有任何成功 ⇒ 仍按当前故障处理
  const cur = hs.scanDiag([OK1, FAIL].join('\n'));
  check(cur.sinceFailure.recovered === false && sk(cur.sinceFailure).count === 0,
    '⑤ 失败在最后、之后没有任何记录 ⇒ recovered=false（仍按当前故障处理）',
    JSON.stringify(sk(cur.sinceFailure)));

  // ⑥ 客户端：只认同类证据；证据不足时**不许**出现"已恢复"
  const clientSrc = readFileSync(join(here, 'client.js'), 'utf8');
  check(/var recovered = !!\(sfa && sfa\.recovered === true\)/.test(clientSrc),
    '⑥ 客户端按 `sinceFailure.recovered === true` 判「已恢复」（不再用那个把一切无 error 记录都算成功的混合计数）', '');
  check(!/sfa\.successes|sinceFailure\.successes/.test(clientSrc) && !/\.successes/.test(readFileSync(join(here, 'lib', 'hindsight-config.js'), 'utf8')),
    '⑥ 客户端与诊断模块里**都再也没有** `successes` 这个混合计数（它是这次缺陷的载体）', '');
  check(/className: 'exp-hs-hist'/.test(clientSrc) && /\.exp-hs-hist\{/.test(clientSrc),
    '⑥ 历史态走**中性的** .exp-hs-hist（告警框是 .exp-hs-warn，两者样式区分）', '');
  check(/历史 · 已恢复/.test(clientSrc) && /次同类成功/.test(clientSrc) && /same\.lastMs/.test(clientSrc),
    '⑥ 历史态文案说清「这是 <ts> 的历史失败（<哪一类>失败）；此后已有 N 次**同类**成功（最近 <ts>，耗时 <ms> ms）」', '');
  check(/尚无同类成功/.test(clientSrc) && /不能据此说它已恢复/.test(clientSrc),
    '⑥ 没有同类成功时**明说**"不能据此说它已恢复"（不许含糊成"尚无后续成功"）', '');
  check(/无法判定（缺后续证据）/.test(clientSrc),
    '⑥ 拿不到证据时**明说无法判定**（证据不足时不许显示"已恢复"）', '');
  const histBlock = (clientSrc.match(/if \(recovered\) \{[\s\S]*?\} else \{/) || [''])[0];
  check(histBlock.length > 0 && !/处理建议|这说明什么/.test(histBlock),
    '⑥ 历史态里**不含**任何整改指令（把历史失败当当前故障给动作，正是这次误导的形态）', 'len=' + histBlock.length);

  // ⑦ 「读不到」 ≠ 「没有失败」（两种零必须分得开）
  const cfgText10 = JSON.stringify({ serverMode: 'self-hosted', apiUrl: 'https://qbbt.8nit.cn', apiToken: 'SENTINEL-abc' });
  const reportWith = async (diag) => hs.buildHindsightReport({
    env: {}, home: '/fake/home', probe: false, io: { readText: async (p) => { if (p.endsWith('coding-agent.json')) return cfgText10; if (diag === null) throw new Error('ENOENT'); return diag; } },
    fetchImpl: async () => { throw new Error('不该被调用'); },
  });
  const noLog = await reportWith(null);
  check(noLog.lastFailure === null && noLog.notes.some((n) => /读不到/.test(n) && /无法判断/.test(n)),
    '⑦ 日志**读不到** ⇒ 如实说「无法判断有没有失败」（**不许**说成「没有失败」）',
    JSON.stringify(noLog.notes.filter((n) => /日志/.test(n))));
  const junkLog = await reportWith('{"ts":"a","event":\n不是 JSON\n{');
  check(junkLog.lastFailure === null && junkLog.notes.some((n) => /没有一条可解析/.test(n) && /无法判断/.test(n)),
    '⑦ 日志**存在但一行都解析不出来**（坏行/半写）⇒ 同样是「无法判断」（读不懂 ≠ 没问题）',
    JSON.stringify(junkLog.notes.filter((n) => /日志/.test(n))));
  const cleanLog = await reportWith(mk({ ts: 't', event: 'retain_ok', ms: 5 }));
  check(cleanLog.lastFailure === null && cleanLog.notes.some((n) => /其中没有失败/.test(n)),
    '⑦ 真读到了记录且其中没有失败 ⇒ 这才叫「没有失败」（三种情况三种说法）',
    JSON.stringify(cleanLog.notes.filter((n) => /日志/.test(n))));
}

await rmFixture(root);

console.log('');
if (fail > 0) {
  console.log(`✗ Hindsight 诊断/配置护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ Hindsight 诊断/配置通过（分类两零可分 / 摘要剥 HTML / 日志健壮 / 只读且不探测不发网络 / 只改提交的键且保留未知键 / 0600 原子写 / 空串≠删除 / token 全程不回显 / 来源守卫）');
