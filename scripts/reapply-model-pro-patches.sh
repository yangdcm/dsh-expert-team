#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 一键重打 dsh-model-pro 的本地补丁（幂等）
#
# 背景：dsh-model-pro（市场插件）的 router/composite 适配器不满足 dsh-llm 的
#       LlmAdapter 契约，且缺少模态感知。我们打了三个本地补丁：
#         ① prepareCall + imageRequestPricing  —— 修「选 auto 后主会话崩溃」
#         ② 模态收窄（requestHasImage/targetSupportsImage + stream 过滤）
#                                            —— 含图片的请求自动走 vision 目标
#         ③ 能力并集（resolveModel 汇总所有目标 inputModalities）
#                                            —— 否则宿主会在分发前剥离图片
#
# 何时需要跑：**市场插件升级/重装覆盖了 dist/host.js 之后**。
#   症状：选 auto 报 `registration.adapter.prepareCall is not a function`，
#         或带图片的消息报错 / 图片被静默剥离。
#
# 用法：bash reapply-model-pro-patches.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

P="$HOME/.dsh/profiles/web/node_modules/dsh-model-pro/dist/host.js"
if [ ! -f "$P" ]; then
  echo "✗ 找不到 $P（dsh-model-pro 未安装？）" >&2
  exit 1
fi

cp "$P" "$P.bak-$(date +%Y%m%d-%H%M%S)"
echo "· 已备份：$P.bak-$(date +%Y%m%d-%H%M%S)"

python3 - "$P" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
applied, skipped = [], []

# ── 补丁① prepareCall + imageRequestPricing ─────────────────────────────────
if 'async prepareCall' in s:
    skipped.append('① prepareCall')
else:
    a1 = "    async *stream(options) {"
    if s.count(a1) != 1:
        sys.exit(f"✗ 锚点① 命中 {s.count(a1)} 次，脚本已过期，请手工检查")
    s = s.replace(a1, (
        "    imageRequestPricing() {\n"
        "      return void 0;\n"
        "    },\n"
        "    async prepareCall(provider, model, signal) {\n"
        "      const info = await this.resolveModel(provider, model, signal);\n"
        "      return { model: info, stream: (options) => this.stream(options) };\n"
        "    },\n"
    ) + a1, 1)
    applied.append('① prepareCall')

# ── 补丁② 模态检测 helper（requestHasImage / targetSupportsImage）───────────
if 'requestHasImage' in s:
    skipped.append('② 模态 helper')
else:
    a2 = "  const cursor = {};\n  const pin = {};\n"
    if s.count(a2) != 1:
        sys.exit(f"✗ 锚点② 命中 {s.count(a2)} 次，脚本已过期，请手工检查")
    s = s.replace(a2, a2 + (
        "  // [local patch] modality-aware target filtering\n"
        "  const modalityCache = /* @__PURE__ */ new Map();\n"
        "  function requestHasImage(options) {\n"
        "    try {\n"
        "      const msgs = options && options.messages;\n"
        "      if (!Array.isArray(msgs)) return false;\n"
        "      for (const m of msgs) {\n"
        "        const c = m && m.content;\n"
        "        if (Array.isArray(c)) {\n"
        "          for (const b of c) if (b && b.type === \"image\") return true;\n"
        "        } else if (c && typeof c === \"object\" && c.type === \"image\") return true;\n"
        "      }\n"
        "    } catch (e) {}\n"
        "    return false;\n"
        "  }\n"
        "  async function targetSupportsImage(provider, model) {\n"
        "    const key = provider + \"\\0\" + model;\n"
        "    if (modalityCache.has(key)) return modalityCache.get(key);\n"
        "    let ok = /vision|vl|qvq/i.test(String(model));\n"
        "    try {\n"
        "      const wire = wireModelOf(st(), provider, model) || model;\n"
        "      const info = await llm.resolveModelInfo(provider, wire);\n"
        "      const mods = info && info.inputModalities;\n"
        "      if (Array.isArray(mods) && mods.length) ok = mods.indexOf(\"image\") >= 0;\n"
        "    } catch (e) {}\n"
        "    modalityCache.set(key, ok);\n"
        "    return ok;\n"
        "  }\n"
    ), 1)
    applied.append('② 模态 helper')

# ── 补丁②b stream 里的模态收窄 ──────────────────────────────────────────────
if 'poolForOrder' in s:
    skipped.append('②b 模态收窄')
else:
    a3 = "      const ordered = orderTargets(spec, pool, health(), cursor, routeName, options);"
    if s.count(a3) != 1:
        sys.exit(f"✗ 锚点②b 命中 {s.count(a3)} 次，脚本已过期，请手工检查")
    s = s.replace(a3, (
        "      let poolForOrder = pool;\n"
        "      if (requestHasImage(options)) {\n"
        "        const flags = [];\n"
        "        for (const t of pool) flags.push(await targetSupportsImage(t.provider, t.model));\n"
        "        const visionPool = pool.filter((t, i) => flags[i]);\n"
        "        if (visionPool.length) poolForOrder = visionPool;\n"
        "        else throw new Error(`\\u667A\\u80FD\\u8DEF\\u7531\\u300C${model}\\u300D\\u65E0\\u652F\\u6301\\u56FE\\u7247\\u7684\\u76EE\\u6807\\uFF1A\\u672C\\u6B21\\u8BF7\\u6C42\\u542B\\u56FE\\u7247\\uFF0C\\u8BF7\\u5728\\u8DEF\\u7531\\u91CC\\u52A0\\u5165 vision \\u6A21\\u578B\\uFF08\\u5982 deepseek-v4-flash-vision-exp / qvq-max\\uFF09`);\n"
        "      }\n"
        "      const ordered = orderTargets(spec, poolForOrder, health(), cursor, routeName, options);"
    ), 1)
    applied.append('②b 模态收窄')

# ── 补丁③ resolveModel 能力并集 ─────────────────────────────────────────────
if 'capability union' in s:
    skipped.append('③ 能力并集')
else:
    a4 = (
        "      const first = spec.targets[0];\n"
        "      try {\n"
        "        const wire = wireModelOf(st(), first.provider, first.model);\n"
        "        const info = await llm.resolveModelInfo(first.provider, wire, signal);\n"
        "        return { ...info, provider, id: model, name: model };\n"
        "      } catch {\n"
        "        return base;\n"
        "      }"
    )
    if s.count(a4) != 1:
        sys.exit(f"✗ 锚点③ 命中 {s.count(a4)} 次，脚本已过期，请手工检查")
    s = s.replace(a4, (
        "      const first = spec.targets[0];\n"
        "      try {\n"
        "        // [local patch] capability union: a route advertises what ANY of its\n"
        "        // targets can do — otherwise the host projects images away before\n"
        "        // dispatch (dsh-llm strips image blocks for text-only modelInfo).\n"
        "        let merged;\n"
        "        const mergedMods = [];\n"
        "        let anyDeclared = false;\n"
        "        for (const t of spec.targets) {\n"
        "          if (t.enabled === false) continue;\n"
        "          try {\n"
        "            const wire = wireModelOf(st(), t.provider, t.model);\n"
        "            const info = await llm.resolveModelInfo(t.provider, wire, signal);\n"
        "            if (!info) continue;\n"
        "            if (!merged) merged = info;\n"
        "            if (Array.isArray(info.inputModalities)) {\n"
        "              anyDeclared = true;\n"
        "              for (const m of info.inputModalities) if (mergedMods.indexOf(m) < 0) mergedMods.push(m);\n"
        "            }\n"
        "          } catch (e) {}\n"
        "        }\n"
        "        if (!merged) {\n"
        "          const wire = wireModelOf(st(), first.provider, first.model);\n"
        "          merged = await llm.resolveModelInfo(first.provider, wire, signal);\n"
        "        }\n"
        "        const out = { ...merged, provider, id: model, name: model };\n"
        "        if (anyDeclared) out.inputModalities = mergedMods;\n"
        "        else delete out.inputModalities;\n"
        "        return out;\n"
        "      } catch {\n"
        "        return base;\n"
        "      }"
    ), 1)
    applied.append('③ 能力并集')

open(p, 'w', encoding='utf-8').write(s)
print('· 本次应用：' + (', '.join(applied) if applied else '（无，已是最新）'))
if skipped:
    print('· 已存在跳过：' + ', '.join(skipped))
PY

node --check "$P" && echo "✓ 语法校验通过"
echo "✓ 完成。请重启 dsh 使其生效：~/.local/bin/dsh-restart"
echo "  回滚：cp \"$P\".bak-* \"$P\""
