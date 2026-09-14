# expert-team · dsh-expert-team

English | [中文](README.md)

[![npm](https://img.shields.io/npm/v/@yangdcm/dsh-expert-team)](https://www.npmjs.com/package/@yangdcm/dsh-expert-team)
[![license](https://img.shields.io/npm/l/@yangdcm/dsh-expert-team)](LICENSE)
[![CI](https://github.com/yangdcm/dsh-expert-team/actions/workflows/ci.yml/badge.svg)](https://github.com/yangdcm/dsh-expert-team/actions/workflows/ci.yml)

> **One sentence in, a gated team delivery out.** `/team build a payments module with login`
> assembles a 12-role expert team and runs
> clarify → research → design → spec-review → plan-approval → implement → review → test → deliver,
> with implementers editing your workspace directly and every hand-off persisted as a reviewable artifact.

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).
**Zero runtime dependencies, no build step, no install hooks.**

![Quality-gate violations surfaced live](docs/images/panel-gate.png)
![Members, models and task detail](docs/images/panel-live.png)
![Phase progress and artifact preview](docs/images/panel-flow.png)

<sub>Real screenshots of the overlay: the gate-violation banner, the roster (who is running, on which model), and task/artifact detail.</sub>

---

## What it solves

A single agent doing large work fails in three predictable ways: **context drift** (long tasks wander),
**self-review** (nobody verifies independently), and **rework that never converges**. The team attacks
all three:

| Mechanism | How |
|---|---|
| **Role separation** | 12 roles, each with its own persona, tool boundary (`toolFilter`) and delegation depth (`maxDepth: 1`). PM/architect only read and write planning artifacts, reviewers are read-only, only implementers touch code |
| **Phase gating** | 9 phases; every hand-off travels as *structured return value + artifact file*, not as chat history |
| **Quality gates enforced in code** | State-machine consistency is enforced by the plugin (not requested in a prompt): unfinished tasks cannot be marked completed, quality findings must be adjudicated by qa/reviewer, coverage gaps and rework over budget are flagged. Violations appear **live** in the overlay and in `/team status` |
| **Convergence and accounting** | Per-run token/time/first-runnable/closing-budget metrics; `/team learn` distils cross-run lessons and re-injects them before the next run starts |

## Roles and phases

**12 roles**: pm · architect · researcher · ui · backend · frontend · dba · sec · reviewer · qa · devops · docs.
The roster is trimmed per task; small jobs start only the roles they need.

**9 phases**: `clarify → research → design → spec-review → plan-approval → implement → review → test → deliver`
(`/team --tier` picks a quick / standard / strict pipeline).

## Install

**Requirements**

- `dsh web` (developed and verified against **0.1.5-rc.1**; earlier versions are untested)
- Node.js ≥ 20
- The 12 role tools (`subagent_pm`, `subagent_architect`, …) require a session running the
  **「专家团模式」 ("Expert Team mode")** preset. Without it the team falls back to the generic
  `subagent` tool with personas written into the prompt — nothing breaks, you just lose the
  config-level boundary guarantees.

**Option 1 — plugin market (recommended)**

`dsh web` → **Settings → Plugin market** → search for "专家团" / "expert team" → install → refresh.

**Option 2 — CLI**

```sh
dsh plugin --profile web add @yangdcm/dsh-expert-team
# then restart dsh web so the new bundle joins the composition
```

**Option 3 — from source (development)**

```sh
cd ~/.dsh/profiles/web
# package.json: add "@yangdcm/dsh-expert-team": "file:<absolute path to this package>" to dependencies
# package.json: add "@yangdcm/dsh-expert-team" to dsh.profile.bundles
pnpm install && dsh web
```

> **The skill is never copied to disk**: when the plugin loads it registers the `expert-team` skill as a
> **runtime entry** in the host skill registry (relative resources resolve through `resourceBase` back into
> the package), so nothing appears under `$DSH_HOME/skills/` — uninstalling stays clean. Only when the host
> has no skill registry does it fall back to copying.
>
> **The 「专家团模式」 preset is still copied** into `$DSH_HOME/.agent-presets/` (the host offers no
> runtime API to add a preset scan root), but it carries a version stamp and is re-materialised in full on
> upgrade instead of silently going stale. `/team uninstall` reclaims the copies this plugin laid down —
> it only removes directories carrying our stamp, and never touches content you authored yourself.
>
> **Where settings live**: on load the plugin registers its settings as the host namespace `expert-team`
> — the **data layer**: the host owns them, they travel with the plugin market's **backup and restore**,
> any interface that renders the schema can read them, and a changed value recomputes limits, round caps
> and the tier gate in-process (no restart).
> **The card inside the built-in settings page is not shipped yet**: that page renders the intersection of
> *the host service's namespaces* and *registered cards*. We only have the first half
> (`ctx.settings.register`); the second half needs a **client-side section contribution** (slot
> `settings.plugin.item` keyed by this namespace, plus `@deepseek-ai/dsh-client-ui-settings` added to
> `dsh.client.inject`) — see `docs/专家团-设置卡片-实施要点.md` for the implementation notes.
> So **settings are currently edited from the overlay's settings tab**
> (`/plugins/dsh-expert-team/settings`).
> **Honest boundary**: the default roster (an array of role ids) is deliberately *not* in the host schema
> (its value type cannot be expressed reliably), so it stays with the overlay's tab and
> `$DSH_HOME/expert-team/settings.json`. On a host with no settings service every setting falls back to
> that file.
>
> **The A-line switch**: the "narrow the lead's tool face" gate (`gates.leadToolFace`, default `on`)
> decides whether execution tools (`bash/write/edit/grep/glob`) are taken away from the lead and given
> to the role subagents. Turn it off with `config.leadToolFace` or `DSH_EXPERT_TEAM_LEAD_TOOLFACE=off`.

## Quick start

```
/team build a payments module with login   # one-shot: assemble, deliver, report
/team --persist refactor the orders module # persistent live team; members stay commandable, resumable across sessions
/team --no-code review the existing API    # artifacts only (plan/review/test), no code changes
/team --confirm <task>                     # scaffold the run but do not dispatch until you click "execute"
/team status                               # phases, roster, model plan and live gate violations
/team resume <run-id>                      # resume a run in a later session
```

`/team help` lists the full surface (`/team canvas` visual canvas, `/team codeindex` code index,
`/team learn` self-learning, `/team limit` quota, `/team settle` cold-start settlement, …).

**Where output lands**

- `<your workspace>/team/<run-id>/` — artifacts: `SPEC / PLAN / TASKS / ROSTER / STATE / REVIEW / TEST / SUMMARY / RUN.log.md`
- `$DSH_HOME/expert-team/` — machine-local preferences and cross-project lessons: `settings.json`, `session-runs.json`, `LEARNINGS.md`

## Layout

```
cordis.patch.yml       the only composition contribution: one host-plane /team command row
lib/command.js         /team command: parse + scaffold workspace + install skill + launch + 11 overlay routes
lib/validate.js        pure validators for state machine, quality gates and capacity limits
lib/tier.js            single source of truth for pipeline tiers
lib/metrics/           token accounting, first-runnable timing, closing budget, METRICS rendering
lib/routes/            shared route plumbing (uniform 405/500/JSON handling)
client.js              the overlay panel (module-loader bundle; requires only 'react')
skills/expert-team/    the orchestration "brain": SKILL.md + references/ + artifact templates
presets/expert-team/   the 「专家团模式」 preset: 12 role subagent tool instances
```

The orchestration protocol lives in the skill rather than in code, so the team protocol can evolve
without a package release.

## Development

```sh
npm run test:all        # 75 test files, zero dependencies, no install needed (this is what CI runs)
npm run rename <name>   # re-brand a fork: syncs 4 spellings of the package name across 13 files
npm run check:name      # verify no placeholder package name is left behind
```

`npm run gate` (`gate:preset` / `gate:sync` / `gate:evidence` / `gate:bypass` / `gate:mutation`) is a
**developer-machine-only** set: `gate:sync` diffs the self-installed copies under your local
`$DSH_HOME`, and `gate:preset` borrows the Config schemas shipped inside your local dsh install
(the dsh path is auto-detected; override with `DSH_INSTALL`). Neither runs in CI.

## Known limitations

- **The local routes are guarded, but that is not authentication**: all 11 overlay routes now check
  `Host` (blocks DNS rebinding), the `Origin` of write requests (blocks cross-site writes), and the
  client address (blocks non-loopback clients); write requests must also send `application/json`
  (blocks form / text-plain "simple requests" that never trigger a preflight). `/file` now goes through
  the host `ctx.fs` policy and reports 403 instead of falling back to a raw read when the policy denies it.
  **Residual risk, stated plainly**: a local non-browser process can forge any header, and dsh plugins
  have no authentication model — so do not expose `dsh web` to an untrusted network (with
  `host: 0.0.0.0` the guard only stops clients without a loopback address).
- **Web profile only**: the overlay and routes need `webServer`. The command and artifacts still work without it.
- **Preset drift**: the bundled 「专家团模式」 is a copy of the official `standard` preset plus the role
  tools; upstream preset restructuring needs a matching update here. Upgrades re-materialise it by version
  stamp, and `/team uninstall` reclaims it (a same-named preset you authored yourself is left alone).
- Calls `git status --porcelain` (read-only) to judge artifact freshness.

## License

MIT © yangdcm
