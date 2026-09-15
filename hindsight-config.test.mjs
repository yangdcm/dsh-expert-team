// Hindsight 记忆后端**只读诊断**的回归护栏（2026-09-15，1.3.18 一期）。
//
// 背景：用户的两类记忆故障都在**服务端**，客户端此前只把原始 JSON/HTML 抛出来：
//   · `… -> 500 {"detail":"could not resize shared memory segment … No space left on device"}`
//     ⇒ 服务端 PostgreSQL 分配共享内存失败（自托管最常见：容器 `/dev/shm` 只有 64 MB）；
//   · `… -> 403 <!doctype html><html>…网站防火墙…` ⇒ 服务端 **WAF 返回 HTML 防火墙页**（**不是 token 问题**）。
//
// 本文件钉六件事：① 分类器正反例（含两条真实原文）；② 摘要必须**剥 HTML + 压平 + 截断**；
// ③ 日志解析的"两种零"（`inject_empty` = 召回为空 **不是失败**；坏行/半行不许抛）；
// ④ 形态/地址/bank 的语义；⑤ 探测语义（**不探测绝不发网络**；任何 HTTP 响应都算可达）；
// ⑥ **两条安全/纪律红线**：响应全文**绝不出现 token 值**；模块**只读**（源码级：无写入、无 POST）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  check(b.classification === 'waf-blocked', '403 + HTML 防火墙页 ⇒ waf-blocked', b.classification);
  check(/WAF/.test(b.hint) && /不是 token 问题/.test(b.hint), 'hint 点明是 WAF 拦的、且**不是 token 问题**', b.hint.slice(0, 40));
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
  check(ok && ok.classification === 'waf-blocked' && ok.at === '2026-09-15T12:05:26Z', '取到带 error 的那条并分类', ok && ok.classification);

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
  check(noProbe.lastFailure && noProbe.lastFailure.classification === 'waf-blocked', '最近失败已分类并带 hint', noProbe.lastFailure && noProbe.lastFailure.classification);
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

console.log('\n⑦ 两条纪律的源码级守卫（只读 / 安全）');
{
  const modSrc = readFileSync(join(here, 'lib', 'hindsight-config.js'), 'utf8');
  check(!/writeFile|writeText|createWriteStream|mkdir|rename\(|rm\(/.test(modSrc), '**模块内没有任何写入 API**（一期只读）', '');
  check(!/method:\s*'POST'|method:\s*"POST"/.test(modSrc), '模块内没有 POST（只有探测用的 GET）', '');

  const cmdSrc = readFileSync(join(here, 'lib', 'command.js'), 'utf8');
  check(cmdSrc.includes("path: '/plugins/dsh-expert-team/hindsight-config'"), '路由已注册', '');
  const at = cmdSrc.indexOf("path: '/plugins/dsh-expert-team/hindsight-config'");
  check(at !== -1 && cmdSrc.slice(at, at + 260).includes("methods: ['GET']"), '**只暴露 GET**（没有写入口）', '');
  check(cmdSrc.slice(at - 400, at).includes('registerLocal({'), '走 registerLocal（本机来源守卫；棘轮也盯着这条）', '');

  const cliSrc = readFileSync(join(here, 'client.js'), 'utf8');
  check(/h\(HindsightBlock\)/.test(cliSrc), '设置页里渲染了这个块', '');
  const cAt = cliSrc.indexOf("'/plugins/dsh-expert-team/hindsight-config'");
  check(cAt !== -1, '客户端确实打这条路由', '');
  check(!/hindsight-config[\s\S]{0,300}?method:\s*'POST'/.test(cliSrc), '客户端的记忆后端请求**没有 POST**（无写入控件）', '');
  check(/token[^\n]{0,40}值不显示|value never shown/.test(cliSrc), '界面明确写出"token 值不显示"', '');
}

console.log('');
if (fail > 0) {
  console.log(`✗ Hindsight 只读诊断护栏失败：${fail} 项`);
  process.exit(1);
}
console.log('✔ Hindsight 只读诊断通过（分类两零可分 / 摘要剥 HTML / 日志健壮 / token 不回显 / 只读且不探测不发网络）');
