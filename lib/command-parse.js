// 命令解析（B 线第 8 项 · `command-parse.js`）：`/team` 的**整个 CLI 面** —— 用法文本、
// 命名 profile、以及把一行输入解析成 `{kind, …}` 的 `parseTeamCommand`。
//
// 为什么单独成模块：这三样是**同一件事的三面**（有哪些命令 / 命令怎么拼 / 输入怎么解析），
// 以前散在 5000 行编排器的三处（相隔 150 行），改一条命令要跨好几段找三个地方。
//
// 边界：**这里只解析、不执行** —— 不碰 IO、不认识 `ctx`、不调用任何 handler；返回值只是
// `{kind, …}`，由 `command.js` 的 switch 分发。所以它可以被纯单测（`command-parse.test.mjs`
// 早就在用 `_live.parseTeamCommand` 做行为断言，这次搬家**一行都不用改**）。

import { DEFAULT_ROLES } from './vocab.js';

// Named multi-role profiles: preset roster + deliverable + a short note the lead reads.
export const PROFILE_DEFS = {
  delivery: { roles: DEFAULT_ROLES, deliverable: 'code+artifacts', note: '完整交付：澄清→调研→设计→实现→评审→测试→交付' },
  review: { roles: ['pm', 'architect', 'researcher', 'reviewer', 'qa'], deliverable: 'artifacts-only', note: '只做设计与代码评审：出 REVIEW/TEST 工件，不改代码' },
  design: { roles: ['pm', 'architect', 'researcher'], deliverable: 'artifacts-only', note: '只出规格与架构设计：Ultra Spec + 接口契约，不改代码' },
  refactor: { roles: ['pm', 'architect', 'backend', 'reviewer', 'qa'], deliverable: 'code+artifacts', note: '重构：契约冻结→实现→评审→测试' },
  research: { roles: ['pm', 'researcher', 'architect'], deliverable: 'artifacts-only', note: '调研：代码定位/依赖/存量约束 + 结论' },
};
export function resolveProfile(name, fallback) {
  const d = PROFILE_DEFS[name];
  if (!d) return fallback;
  return { ...fallback, roles: d.roles, deliverable: d.deliverable, profileNote: d.note, profile: name };
}
export const USAGE = [
  'Usage:',
  '  /team <task>                       一句话组队（一次性，自动组队并交付）',
  '  /team help                         显示本用法（等价：? / -h / --help）',
  '  /team --persist <task>             启动持久化活团队（成员可反复指挥，跨会话恢复）',
  '  /team --no-code <task>             只产出计划/评审/测试工件，不改代码',
  '  /team --confirm <task>             大需求先确认：建 run 但**不自动派工**，面板点「执行」才开工',
  '  /team --tier <档位> <task>         指定流程档位：快速档 / 标准档 / 严格档（不写则在浮层三选一，每次都问）',
  '  /team tier <档位> [--run <run>]    运行中**升档**（快速档→标准档→严格档；不允许降档）',
  '  /team rule <内容>                  立一条常驻规则（如「改完没问题就提交并推送」）；/team rules 查看',
  '  /team --roles a,b,c <task>         指定/增补角色（覆盖默认编制）',
  '  /team --name <runId> <task>        指定 runId（默认由任务文本 + HHMMSS 生成）',
  '  /team --profile <name> <task>      套用命名模板（delivery|review|design|refactor|research）',
  '  /team --allow-rebuild <task>       显式解锁「该目标已被丢弃」的自动重建拦截（会记入 RUN.log）',
  '  ⚠ flags 一律写在 <task> **之前**（后置会被当成任务文本）',
  '  /team status                       查看所有 run 的阶段、成员与模型计划（⚠违规实时可见）',
  '  /team models [<run>]               查看每个角色的成本/模型计划（轻=快模型，重=顶配）',
  '  /team canvas [<run>]               生成该 run 的可视化团队画布 (HTML)',
  '  /team canvas --watch [<run>]       生成画布并轮询 host 状态接口实时刷新（live 版）',
  '  /team learn                        聚合所有 run 的日志 → METRICS.md + 蒸馏经验到 LEARNINGS.md',
  '  /team learn --deep                 再写一份 DEEP-LEARN.md（逐 run 的卡点清单 + 映射到的规则）',
  '  /team index                        扫描本工程 → team/REPOWIKI.md 项目知识库（供角色检索）',
  '  /team codeindex                    构建代码索引（符号/词频 → team/CODEINDEX.json，Qoder 式）',
  '  /team search <关键词>              代码索引秒级搜索（路径 100 > 符号 60 > 高频词 20）',
  '  /team devcontainer [--write]       生成可复现校验环境配置（按语言选镜像；--write 写入 .devcontainer/）',
  '  /team migrate <run>                把旧 run 的 TASKS.json 升级到新 schema（启用质量门禁/自动调度）',
  '  /team check [<run>]                状态机/质量门禁一致性校验（host 强制）',
  '  /team detail [<run>]               单个 run 运行详情（目标/时间线/产物/首个失败点）',
  '  /team limit <run> [--max-runs N] [--deadline YYYY-MM-DD] [--clear]  配额：次数/截止（超限后拒绝恢复并提示）',
  '  /team task <id> <状态> [--run <run>]  快捷回写单任务状态（如 /team task B1 done --note 接口通过）',
  '  /team resume <run>                 恢复/继续某个 run',
  '  /team settle [<run>]               清算冷启动后「没人做」的在飞任务（→ pending + attempt+1 + 留痕）',
  '  /team wait [<run>]                 查看在飞任务进展（不阻塞；无进展超 5 分钟会提示）',
  '  /team clear [<run>]                清理一个或全部 run',
].join('\n');

// ── command parsing ────────────────────────────────────────────────────────

export function parseTeamCommand(rawInput) {
  const input = (rawInput ?? '').trim();
  if (input.length === 0) return { kind: 'help' };
  const lower = input.toLowerCase();
  // ⚠️ `help` 必须有独立分支：旧实现只在**空输入**时返回 help，`/team help` 会穿过所有
  // 子命令判断、落到最后的 `create` 分支，把 "help" 当成任务文本 ⇒ **建出一个
  // runId 形如 `help-HHMMSS` 的空 run**。用户一按就中，且几乎不会自己发现。
  if (lower === 'help' || lower === '?' || lower === '-h' || lower === '--help' || lower === '帮助') return { kind: 'help' };
  if (lower === 'status') return { kind: 'status' };
  if (lower === 'members') return { kind: 'members' };
  if (lower === 'models') return { kind: 'models' };
  if (lower.startsWith('models ')) return { kind: 'models', run: input.slice(7).trim() };
  if (lower === 'task') return { kind: 'error', text: 'Usage: /team task <id> <状态> [--run <run>] [--note <原因>]' };
  if (lower.startsWith('task ')) {
    const parts = input.slice(5).trim().split(/\s+/);
    let run = null, note = '';
    const rest = parts.filter((p) => !p.startsWith('--'));
    let i = parts.indexOf('--run'); if (i >= 0 && parts[i + 1]) run = parts[i + 1];
    i = parts.indexOf('--note'); if (i >= 0 && parts[i + 1]) { note = parts.slice(i + 1).join(' '); }
    return { kind: 'task', id: rest[0] || '', status: (rest[1] || '').toLowerCase(), run, note };
  }
  if (lower === 'learn') return { kind: 'learn', deep: false };
  if (lower.startsWith('learn ')) return { kind: 'learn', deep: /--deep/.test(input) };
  // G 线：`/team tier <档位> [--run <run>]` —— 只允许**升档**（跑不顺就降级等于用档位掩盖问题）。
  if (lower === 'tier') return { kind: 'error', text: 'Usage: /team tier <档位> [--run <run>]（档位：快速档 / 标准档 / 严格档；只允许升档）' };
  if (lower.startsWith('tier ')) {
    const parts = input.slice(5).trim().split(/\s+/);
    let run = null;
    const ri = parts.indexOf('--run'); if (ri >= 0 && parts[ri + 1]) run = parts[ri + 1];
    const rest = parts.filter((p) => !p.startsWith('--') && p !== run);
    return { kind: 'tier', tier: rest[0] || '', run };
  }
  if (lower === 'board') return { kind: 'board' };
  if (lower === 'detail') return { kind: 'detail' };
  if (lower.startsWith('detail ')) return { kind: 'detail', run: input.slice(7).trim() };
  if (lower === 'limit') return { kind: 'error', text: 'Usage: /team limit <run> --max-runs <N> | --deadline <YYYY-MM-DD> | --clear' };
  if (lower.startsWith('limit ')) {
    const parts = input.slice(6).trim().split(/\s+/);
    let maxRuns = null, deadline = null, clear = false;
    const rest = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '--max-runs' && parts[i + 1]) { maxRuns = Number(parts[i + 1]); i++; }
      else if (parts[i] === '--deadline' && parts[i + 1]) { deadline = parts[i + 1]; i++; }
      else if (parts[i] === '--clear') clear = true;
      else rest.push(parts[i]);
    }
    return { kind: 'limit', run: rest[0] || '', maxRuns, deadline, clear };
  }
  if (lower === 'canvas') return { kind: 'canvas', watch: false };
  if (lower.startsWith('canvas ')) {
    const watch = /(^|\s)--watch(\s|$)/.test(input);
    const run = input.slice(7).replace(/\s*--watch\s*/gi, '').trim();
    return { kind: 'canvas', run, watch };
  }
  if (lower === 'clear') return { kind: 'clear' };
  if (lower.startsWith('clear ')) return { kind: 'clear', run: input.slice(6).trim() };
  // L3-2′ 可清算：显式清算冷启动后的搁浅任务（回 pending + attempt+1 + 留痕）
  if (lower === 'settle') return { kind: 'settle', run: null };
  if (lower.startsWith('settle ')) return { kind: 'settle', run: input.slice(7).trim() };
  if (lower === 'index') return { kind: 'index' };
  if (lower === 'codeindex') return { kind: 'codeindex' };
  if (lower === 'search') return { kind: 'error', text: 'Usage: /team search <关键词>' };
  if (lower.startsWith('search ')) return { kind: 'search', kw: input.slice(7).trim() };
  if (lower === 'devcontainer') return { kind: 'devcontainer', write: false };
  if (/^devcontainer\s+--write(\s+.*)?$/.test(input)) return { kind: 'devcontainer', write: true };
  if (lower.startsWith('devcontainer ')) return { kind: 'devcontainer', write: /--write/.test(input) };
  if (lower === 'check') return { kind: 'check' };
  if (lower.startsWith('check ')) return { kind: 'check', run: input.slice(6).trim() };
  if (lower === 'migrate') return { kind: 'error', text: 'Usage: /team migrate <run>' };
  if (lower.startsWith('migrate ')) return { kind: 'migrate', run: input.slice(8).trim() };
  if (lower === 'resume') return { kind: 'error', text: 'Usage: /team resume <run>' };
  if (lower.startsWith('resume ')) return { kind: 'resume', run: input.slice(7).trim() };
  if (lower === 'wait') return { kind: 'wait', run: '' };
  if (lower.startsWith('wait ')) return { kind: 'wait', run: input.slice(5).trim() };
  if (lower === 'rule' || lower === 'rules') return { kind: 'rules', action: 'list', rule: '' };
  if (lower.startsWith('rule ')) return { kind: 'rules', action: 'add', rule: input.slice(5).trim() };
  if (lower.startsWith('rules ')) return { kind: 'rules', action: 'add', rule: input.slice(6).trim() };

  // Consume leading flags; everything after the last flag is the task text.
  const tokens = input.split(/\s+/);
  let i = 0;
  let persist = false;
  let noCode = false;
  let roles = null;
  let runName = null;
  let profile = null;
  let allowRebuild = false; // 批 0-3：显式解锁「该目标已被用户丢弃」的拦截
  let confirm = false; // 大需求执行前询问：先建 run + 立待决，**不自动派工**，等用户拍板
  let tierRaw = null; // G 线：显式 `--tier <快速档|标准档|严格档|quick|standard|strict>`
  while (i < tokens.length && tokens[i].startsWith('--')) {
    const flag = tokens[i];
    if (flag === '--persist') persist = true;
    else if (flag === '--no-code') noCode = true;
    else if (flag === '--allow-rebuild') allowRebuild = true;
    else if (flag.startsWith('--roles')) {
      const eq = flag.indexOf('=');
      if (eq >= 0) roles = flag.slice(eq + 1).split(',').map((s) => s.trim()).filter(Boolean);
      else { i += 1; if (i < tokens.length) roles = tokens[i].split(',').map((s) => s.trim()).filter(Boolean); }
    } else if (flag.startsWith('--name')) {
      const eq = flag.indexOf('=');
      if (eq >= 0) runName = flag.slice(eq + 1).trim();
      else { i += 1; if (i < tokens.length) runName = tokens[i]; }
    } else if (flag.startsWith('--profile')) {
      const eq = flag.indexOf('=');
      if (eq >= 0) profile = flag.slice(eq + 1).trim();
      else { i += 1; if (i < tokens.length) profile = tokens[i]; }
    } else if (flag.startsWith('--tier')) {
      // 支持 `--tier=quick` 与 `--tier quick` 两种写法（与 --roles/--profile 一致）。
      const eq = flag.indexOf('=');
      if (eq >= 0) tierRaw = flag.slice(eq + 1).trim();
      else { i += 1; if (i < tokens.length) tierRaw = tokens[i].trim(); }
    } else if (flag === '--confirm') confirm = true;
    i += 1;
  }
  const task = tokens.slice(i).join(' ').trim();
  if (!task) return { kind: 'help' };
  return { kind: 'create', task, persist, noCode, roles, runName, profile, allowRebuild, confirm, tierRaw };
}
