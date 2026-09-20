// @yangdcm/dsh-expert-team — client half: a live team overlay panel + header button.
//
// Mirrors dsh-md-preview's proven wiring: a header button in
// `conversation.session.header.actions` captures the session id into a module
// store; the overlay registered into `shell.overlay` reads it via
// useCurrentSession(). It fetches `/plugins/dsh-expert-team/state` every 3s and
// renders: overall progress, phase stepper, roster (member model/status),
// an interactive SVG task DAG, coverage matrix, and artifact preview.
// Follows --dsw-alias-* theme vars.

window.__ModuleLoader__.load({
  id: '@yangdcm/dsh-expert-team',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var useState = react.useState
    var useEffect = react.useEffect
    var useRef = react.useRef
    var createElement = react.createElement
    var Fragment = react.Fragment
    var h = createElement

    var CSS =
      '.exp-panel{position:fixed;top:0;right:0;bottom:0;width:420px;max-width:100vw;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,var(--bg,#fff));border-left:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));box-shadow:-10px 0 32px rgba(0,0,0,.16);z-index:120;font-size:13px;color:var(--dsw-alias-label-primary,var(--text,#1f2328));font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif}' +
      '.exp-head{padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,var(--border,#d0d7de));background:linear-gradient(180deg,var(--dsw-alias-bg-module-platform,var(--bg-subtle,#f6f8fa)),var(--dsw-alias-bg-base,var(--bg,#fff)));display:flex;align-items:center;justify-content:space-between;flex:none}' +
      '.exp-head.exp-grab{cursor:move;user-select:none}' +
      '.exp-dock-handle{position:absolute;left:-2px;top:0;bottom:0;width:9px;cursor:col-resize;z-index:3;transition:background .12s}' +
      '.exp-dock-handle::after{content:"";position:absolute;left:3px;top:0;bottom:0;width:2px;background:var(--dsw-alias-border-l2,var(--border,#d0d7de));opacity:.7}' +
      '.exp-dock-handle:hover::after{background:var(--dsw-alias-state-business-primary,var(--accent,#0969da));opacity:.9;width:3px}' +
      '.exp-panel.exp-float{left:auto;right:auto;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));box-shadow:0 18px 48px rgba(0,0,0,.24)}' +
      '.exp-title{font-weight:700;font-size:14px;color:var(--dsw-alias-label-primary,var(--text,#1f2328))}' +
      '.exp-run{font-size:11px;color:var(--dsw-alias-label-secondary,var(--text,#57606a));font-family:ui-monospace,monospace;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.exp-close{padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:7px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));cursor:pointer;font-size:12px}' +
      '.exp-open{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));color:var(--dsw-alias-label-primary,var(--text,#1f2328));cursor:pointer;font-size:12px}' +
      '.exp-open:hover{background:var(--dsw-alias-bg-layer-2,var(--bg-subtle,#f6f8fa))}' +
      // 头部状态徽章（与画布标签职责区分：徽章=状态+并排面板）
      '.exp-live-badge{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}' +
      '.exp-live-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l2,#c5ccd6);flex:none}' +
      '.exp-live-dot.on{background:#22b07d;animation:exp-pulse 1.4s ease-in-out infinite}' +
      '.exp-live-badge.run{border-color:#9db4ff;color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-live-badge.run .exp-live-dot{background:#3b6ef5}' +
      '.exp-live-badge.dec{border-color:#e0a83c;color:#8a6100;background:rgba(224,168,60,.10)}' +
      '.exp-live-badge.dec .exp-live-dot{background:#e0a83c;animation:exp-pulse 1.4s ease-in-out infinite}' +
      '.exp-live-badge.warn{border-color:#f0bcb6;color:#b3291e;background:rgba(179,41,30,.08)}' +
      '.exp-live-badge.warn .exp-live-dot{background:#c62828}' +
      '.exp-live-badge.done{border-color:#bfe6d5;color:#1a7f5a;background:rgba(34,176,125,.10)}' +
      '.exp-live-badge.done .exp-live-dot{background:#22b07d}' +
      '.exp-modehint{padding:7px 14px;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary,var(--text,#57606a));background:var(--dsw-alias-bg-layer-2,var(--bg-subtle,#f6f8fa));border-bottom:1px solid var(--dsw-alias-border-l1,var(--border,#eef1f5))}' +
      // ── F1 计划草稿编辑器 ──
      '.exp-plan{margin:0 0 10px;padding:10px 12px;border:1px solid var(--dsw-alias-state-business-primary,#0969da);border-radius:10px;background:linear-gradient(180deg,#f6f9ff,var(--dsw-alias-bg-layer-1,var(--bg,#fff)))}' +
      '.exp-plan-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px}' +
      '.exp-plan-t{font-weight:700;font-size:12.5px;color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-plan-msg{margin-left:auto;font-size:11px;font-weight:700;color:#1a7f5a}' +
      '.exp-plan-roles{display:flex;flex-wrap:wrap;gap:6px;align-items:center}' +
      '.exp-plan-chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));background:var(--dsw-alias-bg-layer-3,var(--bg,#fff))}' +
      '.exp-plan-add{font-size:11px;padding:2px 6px;border-radius:7px;border:1px dashed var(--dsw-alias-border-l2,var(--border,#d0d7de));background:transparent;color:var(--dsw-alias-label-secondary,#57606a)}' +
      '.exp-plan-row{display:flex;gap:4px;align-items:center;margin:4px 0}' +
      '.exp-plan-id{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#57606a);flex:none;width:42px;overflow:hidden;text-overflow:ellipsis}' +
      '.exp-plan-in{flex:1;min-width:0;font-size:11.5px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));color:inherit}' +
      '.exp-plan-sel{flex:none;width:74px;font-size:11px;padding:2px 4px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));color:inherit}' +
      '.exp-plan-dep{flex:none;width:62px;font-size:10.5px;padding:2px 5px;border:1px dashed var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:6px;background:transparent;color:inherit}' +
      '.exp-plan-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
      '.exp-plan-b{font-size:11.5px;padding:3px 10px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:8px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));color:inherit;cursor:pointer}' +
      '.exp-plan-b.go{border-color:#22b07d;color:#1a7f5a;font-weight:700;background:rgba(34,176,125,.10)}' +
      '.exp-plan-b.bad{border-color:#f0bcb6;color:#b3291e}' +
      '.exp-plan-discarded{margin:0 0 10px;padding:8px 12px;border:1px dashed #e0a83c;border-radius:10px;font-size:11.5px;color:#8a6100;background:rgba(224,168,60,.10)}' +
      '.exp-body{flex:1;overflow:auto;padding:12px 14px 20px}' +
      '.exp-prog{height:8px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,var(--bg-subtle,#eef1f5));overflow:hidden;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de))}' +
      '.exp-prog-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,#3b6ef5,#22b07d);transition:width .4s}' +
      '.exp-meta{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary,var(--text,#57606a));margin:8px 0 4px}' +
      '.exp-sec{margin:16px 0 7px;font-size:11.5px;font-weight:700;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,var(--text,#57606a));text-transform:uppercase;display:flex;align-items:center;gap:8px}' +
      '.exp-sec::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1,var(--border,#e6e8ec))}' +
      '.exp-sec-col{cursor:pointer;user-select:none}' +
      '.exp-sec-col:hover{color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-chev{flex:none;font-size:10px;color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-path{display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:8px 0 0}' +
      '.exp-path li{font-size:11px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:14px;color:var(--dsw-alias-label-secondary,var(--text,#57606a));background:var(--dsw-alias-bg-layer-1,var(--bg,#fff))}' +
      '.exp-path li.done{background:#eef4ff;border-color:#c8daff;color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-path li.cur{background:linear-gradient(90deg,#3b6ef5,#2f5ad8);border-color:transparent;color:#fff;font-weight:700;box-shadow:0 2px 8px rgba(59,110,245,.35)}' +
      '.exp-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1,var(--border,#eef1f5))}' +
      '.exp-row.mem{flex-wrap:wrap;align-items:flex-start}' +
      '.exp-mem-main{display:flex;align-items:center;gap:7px;flex:1;min-width:0}' +
      '.exp-mem-name{font-weight:600}' +
      '.exp-mem-sub{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.exp-mem-cur{width:100%;font-size:11px;color:var(--dsw-alias-state-business-primary,#0969da);margin-left:14px;margin-top:2px}' +
      '.exp-legend{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 2px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a)}' +
      '.exp-legend i{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:4px}' +
      '.exp-dot.running{animation:exp-pulse 1.4s ease-in-out infinite}' +
      '@keyframes exp-pulse{0%,100%{opacity:1}50%{opacity:.4}}' +
      '.exp-prog-fill{position:relative;overflow:hidden}' +
      '.exp-prog-fill::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:exp-shimmer 1.8s infinite}' +
      '@keyframes exp-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}' +
      '.exp-edge-run{stroke-dasharray:6 4;animation:exp-dash 1s linear infinite}' +
      '@keyframes exp-dash{to{stroke-dashoffset:-20}}' +
      '.exp-node-run{animation:exp-nodepulse 1.6s ease-in-out infinite}' +
      '@keyframes exp-nodepulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.3}}' +
      '.exp-live{width:7px;height:7px;border-radius:50%;background:#22b07d;animation:exp-pulse 1.4s infinite;display:inline-block;margin-right:6px}' +
      // 「更新中」：服务端 `warming`（重读挪到后台）如实提示。**刻意用虚线边框 + 中性色**，
      // 与 `degraded`（真截断）的告警色区分开 —— 不是失败，是"这一块正在后台刷新"。
      '.exp-warming{margin-left:8px;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:8px;border:1px dashed #d9a441;color:#8a5a00;background:rgba(217,164,65,.10);white-space:nowrap;flex:none}' +
      '@media (prefers-color-scheme:dark){.exp-warming{color:#f7ad31;border-color:#7a5a22;background:rgba(247,173,49,.12)}}' +
      // 「按上限」：服务端 `scopeCaps`（**按设计的能力上限**，不是故障）如实提示。
      // 三者样式刻意互不相同：`.exp-warming` 虚线金黄（后台刷新中）、degraded 走告警色（真故障）、
      // 这里中性实线（"我们主动只处理前 N 条"）—— 既**不报警**，也**不被静默吞掉**。
      '.exp-scope{margin-left:8px;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:8px;border:1px solid #c3c8d1;color:#4a5261;background:rgba(120,130,150,.10);white-space:nowrap;flex:none}' +
      '@media (prefers-color-scheme:dark){.exp-scope{color:#aab3c2;border-color:#4a5261;background:rgba(170,179,194,.12)}}' +
      '.exp-mem-run{position:relative;overflow:hidden}' +
      '.exp-mem-run::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(59,110,245,.14),transparent);animation:exp-shimmer 1.8s infinite}' +
      '.exp-row.task{cursor:pointer;border-radius:8px;padding:7px 6px}' +
      '.exp-row.task:hover{background:var(--dsw-alias-interactive-bg-hover,var(--bg-subtle,#f6f8fa))}' +
      '.exp-row.task.cur{background:linear-gradient(90deg,rgba(59,110,245,.09),transparent)}' +
      '.exp-ava{width:26px;height:26px;border-radius:50%;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none;margin-right:7px}' +
      '.exp-lead{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-state-business-primary,#0969da);border-radius:10px;background:linear-gradient(90deg,#eef4ff,var(--dsw-alias-bg-layer-1,#fff));margin-bottom:8px}' +
      '.exp-lead b{font-weight:700}' +
      '.exp-panorama{display:grid;grid-template-columns:repeat(auto-fill,minmax(156px,1fr));gap:8px;margin:6px 0}' +
      '.exp-agent{border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,#fff)}' +
      '.exp-agent-a{display:flex;align-items:center;gap:7px}' +
      '.exp-agent-n{font-weight:600;font-size:12.5px}' +
      '.exp-agent-r{font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);margin-top:4px}' +
      '.exp-agent-t{font-size:11px;color:var(--dsw-alias-label-primary,#1f2328);margin-top:4px}' +
      '.exp-agent-off{opacity:.5}' +
      '.exp-flow-note{font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);margin:2px 0 6px}' +
      '.exp-flow-row{display:flex;gap:6px;align-items:stretch;overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}' +
      '.exp-flow{flex:0 0 auto;min-width:168px;max-width:224px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:10px;padding:7px 9px;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer}' +
      '.exp-flow.cur{border-color:var(--dsw-alias-state-business-primary,#0969da);box-shadow:0 0 0 1px rgba(9,105,218,.25)}' +
      '.exp-flow-a{display:flex;align-items:center;gap:6px;font-size:12px}' +
      '.exp-flow-a b{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:84px}' +
      '.exp-flow-t{font-size:11.5px;margin:4px 0 5px;color:var(--dsw-alias-label-primary,#1f2328);line-height:1.4}' +
      '.exp-flow-a2{align-self:center;color:var(--dsw-alias-label-secondary,#57606a);font-size:13px;flex:none;padding:0 1px}' +
      '.exp-flow-sep{height:8px;margin:2px 0;border-left:2px dashed var(--dsw-alias-border-l2,var(--border,#d0d7de))}' +
      '.exp-roster-strip{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 6px}' +
      '.exp-roster-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:8px;padding:3px 7px;background:var(--dsw-alias-bg-layer-1,#fff)}' +
      '.exp-roster-chip.exp-mem-run{border-color:#22b07d;box-shadow:0 0 0 1px rgba(34,176,125,.3)}' +
      '.exp-codeidx{margin:2px 0 6px}' +
      '.exp-search{width:100%;box-sizing:border-box;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px;color:var(--dsw-alias-label-primary,#1f2328);outline:none}' +
      '.exp-search:focus{border-color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-qhits{margin-top:5px}' +
      '.exp-qhit{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;padding:2px 0;color:var(--dsw-alias-label-primary,#1f2328);border-bottom:1px dashed var(--dsw-alias-border-l2,var(--border,#d0d7de))}' +
      '.exp-feed{margin:6px 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f6f8fa)}' +
      '.exp-feed-h{display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:12px;margin-bottom:4px}' +
      '.exp-feed-x{border:none;background:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}' +
      '.exp-feed-i{display:flex;gap:6px;padding:2px 0;align-items:baseline;flex-wrap:wrap}' +
      '.exp-feed-t{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#57606a);flex:none}' +
      '.exp-feed-l{font-size:11.5px;color:var(--dsw-alias-label-primary,#1f2328)}' +
      '.exp-feed-p{font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a);width:100%;margin-left:66px;white-space:pre-wrap;word-break:break-all}' +
      '.exp-toggle{font-size:11px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:7px;cursor:pointer;background:var(--dsw-alias-bg-layer-3,#fff)}' +
      '.exp-role{font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(90,130,240,.12);color:var(--dsw-alias-state-business-primary,#0969da);border:1px solid var(--dsw-alias-border-l2,#d0d7de);white-space:nowrap}' +
      '.exp-muted{color:var(--dsw-alias-label-secondary,var(--text,#57606a));font-size:11.5px}' +
      '.exp-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}' +
      '.exp-badge{font-size:10.5px;padding:1px 7px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,var(--bg-subtle,#f0f2f4));border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));color:var(--dsw-alias-label-secondary,var(--text,#57606a));white-space:nowrap}' +
      '.exp-badge.v-pass{color:#19713a;border-color:#b7e0c2;background:#ecf7ef}' +
      '.exp-badge.v-fail{color:#b3291e;border-color:#f0bcb6;background:#fdeeed}' +
      '.exp-badge.v-rev{color:#8a5a00;border-color:#f0d79a;background:#fff6e3}' +
      '.exp-badge.st-pending{color:#57606a;border-color:#d0d7de;background:#f6f8fa}' +
      '.exp-badge.st-claimed{color:#8a5a00;border-color:#f0d79a;background:#fff6e3}' +
      '.exp-badge.st-progress{color:#0969da;border-color:#a8c7f5;background:#e9f2fe}' +
      '.exp-badge.st-done{color:#19713a;border-color:#b7e0c2;background:#ecf7ef}' +
      '.exp-badge.st-rework{color:#a34a00;border-color:#f3c9a0;background:#fff1e0}' +
      '.exp-badge.st-failed{color:#b3291e;border-color:#f0bcb6;background:#fdeeed}' +
      '.exp-badge.st-blocked{color:#6f5c00;border-color:#e3d488;background:#faf6e0}' +
      '.exp-badge.st-cancelled{color:#57606a;border-color:#d0d7de;background:#eceff1}' +
      '.exp-dag{overflow:auto;margin:4px 0;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--bg,#fff))}' +
      '.exp-node{cursor:pointer}' +
      '.exp-node:hover .exp-node-bg{stroke:var(--dsw-alias-state-business-primary,#0969da);stroke-width:1.5}' +
      '.exp-node-bg{transition:stroke .12s}' +
      // 底部状态带：运行中流光（"动态的"）；状态变更时整卡闪两下
      '.exp-node-bar{transition:fill .2s}' +
      '.exp-node-bar-run{animation:exp-bar-shimmer 1.6s linear infinite}' +
      '@keyframes exp-bar-shimmer{0%{fill-opacity:1}50%{fill-opacity:.6}100%{fill-opacity:1}}' +
      '.exp-node-flash{animation:exp-node-flash 1.1s ease-out 2}' +
      '@keyframes exp-node-flash{0%{stroke-width:4;stroke-opacity:1}60%{stroke-width:4;stroke-opacity:.45}100%{stroke-width:1.6;stroke-opacity:1}}' +
      '.exp-node-status{pointer-events:none}' +
      '.exp-legend-item{display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));background:var(--dsw-alias-bg-layer-1,var(--bg,#fff))}' +
      '.exp-legend-item b{font-variant-numeric:tabular-nums}' +
      '.exp-legend-item.zero{opacity:.55}' +
      '.exp-legend-item.live{border-color:#9db4ff;box-shadow:0 0 0 2px rgba(59,110,245,.10);animation:exp-pulse 1.6s ease-in-out infinite}' +
      '.exp-sub{font-size:9.5px;font-family:ui-monospace,monospace;fill:var(--dsw-alias-label-secondary,#57606a)}' +
      '.exp-art{display:inline-block;padding:3px 9px;margin:3px 4px 0 0;font-size:11px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:7px;cursor:pointer;background:var(--dsw-alias-bg-layer-1,var(--bg,#fff));transition:border-color .12s}' +
      '.exp-art:hover{background:var(--dsw-alias-interactive-bg-hover,var(--bg-subtle,#f6f8fa));border-color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-detail{margin-top:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:9px;background:var(--dsw-alias-bg-layer-1,var(--bg,#fff));font-size:12px}' +
      '.exp-detail h4{margin:0 0 6px;font-size:12.5px}' +
      '.exp-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11.5px;margin:4px 0}' +
      '.exp-kv b{color:var(--dsw-alias-label-secondary,var(--text,#57606a));font-weight:500}' +
      '.exp-detail-who{display:flex;align-items:center;gap:6px;font-size:12px;margin:2px 0 6px}' +
      '.exp-task-op{display:flex;gap:6px;margin:2px 0 6px}' +
      '.exp-op-btn{font-size:11px;padding:2px 10px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);cursor:pointer;color:var(--dsw-alias-label-primary,#1f2328)}' +
      '.exp-op-btn.bad{color:#b3291e;border-color:#f0bcb6}' +
      '.exp-fileview{margin-top:5px}' +
      '.exp-fileview-h{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);margin-bottom:2px}' +
      '.exp-tabs{display:flex;gap:6px;align-items:center;margin:6px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));padding-bottom:4px}' +
      '.exp-tab{font-size:12px;padding:3px 12px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary,#1f2328);opacity:.72}' +
      '.exp-tab.on{opacity:1;font-weight:600;background:var(--dsw-alias-state-business-primary,#0969da);color:#fff}' +
      '.exp-viol-badge{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:9px;background:#c62828;color:#fff;cursor:pointer;font-weight:600}' +
      '.exp-viol-list{margin:2px 0 6px;font-size:11.5px}' +
      '.exp-viol-list div{padding:2px 0;color:#b3291e}' +
      '.exp-board-row{display:flex;gap:6px;align-items:baseline;padding:5px 6px;border-bottom:1px dashed var(--dsw-alias-border-l2,var(--border,#d0d7de));cursor:pointer}' +
      '.exp-board-t{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#57606a);flex:none}' +
      '.exp-board-n{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}' +
      '.exp-detail-sec{border-top:1px dashed var(--dsw-alias-border-l2,var(--border,#d0d7de));margin-top:8px;padding-top:6px}' +
      '.exp-detail-sec b{font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);font-weight:600}' +
      '.exp-doing{font-size:11.5px;margin-top:3px;color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-files{margin-top:3px}' +
      '.exp-file{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-primary,#1f2328);padding:1px 0}' +
      '.exp-log{margin:4px 0 0;padding:6px 8px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);border-radius:6px;font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:140px;overflow:auto;color:var(--dsw-alias-label-primary,#1f2328)}' +
      '.exp-findings{margin:6px 0 0;padding-left:16px;font-size:11.5px}' +
      '.exp-findings li{margin:2px 0}' +
      '.exp-preview{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:9px;background:var(--dsw-alias-bg-layer-1,var(--bg,#fff));font-size:12px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;max-height:330px;overflow:auto}' +
      '.exp-empty{color:var(--dsw-alias-label-secondary,var(--text,#57606a));font-size:12px;padding:8px 0}' +
      '.exp-err{color:#b3291e;font-size:12px;padding:8px 0}' +
      // ── 设置表单（官方「设置」面板的专家团分节；浮层里已不再有「设」页签）──
      // 这些类以前**没有任何 CSS**（只有 JS 里的 className），在浮层里靠浏览器默认样式勉强能看；
      // 搬进官方设置面板后需要一个真正的表单布局：左标签、中控件、右说明。
      '.exp-settings{font-size:12.5px;color:var(--dsw-alias-label-primary,var(--text,#1f2328));max-width:760px}' +
      '.exp-settings-head{margin:0 0 4px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--text,#57606a))}' +
      '.exp-settings-group{margin:16px 0 2px;font-size:11.5px;font-weight:700;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,var(--text,#57606a))}' +
      '.exp-settings-row{display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1,var(--border,#eef1f5))}' +
      '.exp-settings-label{flex:0 0 188px;max-width:188px;font-size:12.5px;line-height:1.5}' +
      '.exp-settings-ctl{flex:none;display:flex;align-items:center;min-height:20px}' +
      '.exp-settings-note{flex:1;min-width:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,var(--text,#57606a))}' +
      // 长说明（spec hint 里有两条：记忆后端 296 字、子代理列表顺序 221 字）挤在「控件右边剩下的
      // 那点宽度」里会被压成一条又窄又高的文字柱 —— 控件列是 `flex:none`，宽度先被它吃掉。
      // ⇒ 说明过长时让该行换行、说明独占一行（`flex-basis:100%`）。判据在 JS 里（阈值见行渲染处），
      // 只影响真正过长的两行，其余行的版面一个像素都不动。
      '.exp-settings-row-wide{flex-wrap:wrap}' +
      '.exp-settings-row-wide .exp-settings-note{flex:1 1 100%;margin-top:2px}' +
      '.exp-settings-msg{margin-top:10px;padding:6px 0;font-size:11.5px;font-weight:700;color:#1a7f5a}' +
      '.exp-settings-msg.bad{color:#b3291e;font-weight:600}' +
      '.exp-settings-retry{margin-top:10px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:8px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));color:inherit;cursor:pointer;font-size:12px}' +
      '.exp-settings-retry:hover{background:var(--dsw-alias-bg-layer-2,var(--bg-subtle,#f6f8fa))}' +
      // 记忆后端（Hindsight）只读诊断块（1.3.18 一期）
      '.exp-hs{margin-top:18px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1,var(--border,#eef1f4))}' +
      '.exp-hs-kv{display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1,var(--border,#eef1f4))}' +
      '.exp-hs-k{flex:0 0 152px;max-width:152px;font-size:12.5px;line-height:1.5}' +
      '.exp-hs-v{flex:1;min-width:0;font-size:12px;line-height:1.5;word-break:break-all}' +
      // ⚠️ 值列的 `word-break:break-all` 只对「长而不可断的 ASCII 串」（profile 补丁的路径）是**必要**的；
      // 对「实际状态」那句中英混排的句子，它会把 `disabled:`、`Hindsight` 这类拉丁词从**词中间**劈开。
      // 所以只给状态那一列挂专用类退回正常断词（CJK 本来就能在任意字间断），并用 `overflow-wrap:break-word`
      // 兜住万一出现的超长不可断 token。**不动** `.exp-hs-v` 本身：「profile 补丁」那行的路径正靠它不撑破列。
      '.exp-hs-v.exp-hs-v-status{word-break:normal;overflow-wrap:break-word}' +
      '.exp-hs-v code{font-size:11.5px;background:var(--dsw-alias-bg-layer-2,var(--bg-subtle,#f6f8fa));padding:1px 4px;border-radius:4px}' +
      '.exp-hs-ok{color:#1a7f5a;font-weight:700}' +
      '.exp-hs-bad{color:#b3291e;font-weight:700}' +
      // ⚠️ 状态**文字**的琥珀色档（2026-09-17 用户真机截图：三选一的「实际状态」行渲染成一个**缺边的破框**）：
      // 那一行的状态文字曾直接复用下面的 `.exp-hs-warn` —— 可它**根本不是一个文字色类**，而是一整个告警
      // **框**（margin/padding/1px 边/3px 左重条/圆角/渐变背景）。同一个类名挂在内联 <span>（在 `.exp-hs-v`
      // 这个 flex 值列里）上，就把边框、左重条与渐变背景画在了文字周围 ⇒ 于是出现"琥珀色小框缺两条边、
      // 文字在框里折行"的怪样子。`.exp-hs-ok`/`.exp-hs-bad` 本来就只有 color+font-weight，**只有 warn 这档**
      // 把"文字色"和"告警框"混成了一个类名 —— 这就是缺陷的全部根因。
      // 处置：把两种用途**拆成两个类**。状态文字用这一条（只有颜色与字重，永不带任何盒子）；
      // `.exp-hs-warn` 保持原样，它仍是重启提示（见下）与 HindsightBlock 诊断里那处**真**·告警框的样式。
      // 色值取自本文件既有的"琥珀色墨水"（`.exp-hs-tag{color:#8a6100}`）—— 不新造一个色。
      '.exp-hs-warn-text{color:#8a6100;font-weight:700}' +
      // ⚠️ 「off 但 mcp-midas 行还活着」那条诚实话（2026-09-19）**另起一个类**，刻意**不**复用上面两条：
      //   ① `exp-hs-warn-text` 是「实际状态」那**一个**值列的专用墨水（⑦d 把它钉在恰好 1 个 JSX 挂点、
      //      且样式表里恰好 2 条规则）—— 借它来渲染第二处会把那条计数守卫撑坏；
      //   ② `exp-hs-msg bad` / `exp-hs-bad` 断言的语义是**失败**（红），而这里的事实是**警告**：
      //      Hindsight 确实关了（用户的目的达到了），只是补丁里还躺着一行 ⇒ 用红色等于把"你做了个
      //      错误决定"画在用户脸上，与 `.exp-hs-warn`（琥珀）那条既有视觉语言也不一致；
      //   ③ 本仓既有规律：`.exp-hs-warn` 本身是一个**告警框**（border/padding/渐变）——挂到内联
      //      文字上就是 2026-09-17 那个"缺边的破框"。这里**只**给颜色与上边距，**没有任何盒子声明**，
      //      所以它既能贴在块级 div 上、也不会重演那个缺陷（⑦d 的 `boxless` 断言会核它）。
      // 色值仍是本文件既有的琥珀墨水 `#8a6100`（同 `.exp-hs-tag` / `.exp-hs-warn-text`），不新造色：
      //   白底上 5.54:1、深色底（`#151517`）上换 `#f7ad31` 后 9.53:1，两档都在 WCAG AA 正文之上。
      '.exp-hs-offwarn{margin-top:6px;color:#8a6100;font-weight:700}' +
      '.exp-hs-warn{margin:8px 0;padding:8px 10px;border:1px solid #f0c36d;border-left:3px solid #e0a83c;border-radius:8px;background:linear-gradient(180deg,rgba(224,168,60,.12),transparent);font-size:11.5px;line-height:1.6}' +
      // ⚠️ 中性「历史 / 已恢复」样式（2026-09-16）：失败之后**已有成功**时不许再挂告警框。
      // 灰蓝细边、无渐变、无左侧重色条 —— 与 `.exp-hs-warn` 视觉上明确区分。
      '.exp-hs-hist{margin:8px 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-secondary,#dfe3e8);border-radius:8px;background:transparent;font-size:11.5px;line-height:1.6;opacity:.92}' +
      '.exp-hs-hist .exp-hs-tag{color:var(--dsw-alias-label-secondary,var(--text,#57606a));background:rgba(127,127,127,.14)}' +
      '.exp-hs-hist .exp-hs-tag-ok{color:#1a7f5a;background:rgba(26,127,90,.14)}' +
      '.exp-hs-tag{display:inline-block;font-weight:700;color:#8a6100;background:rgba(224,168,60,.18);border-radius:4px;padding:0 5px;margin-right:6px}' +
      '.exp-hs-hint{color:var(--dsw-alias-label-secondary,var(--text,#57606a))}' +
      '.exp-hs-notes{margin:6px 0 0;padding-left:16px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,var(--text,#57606a))}' +
      '.exp-hs-copy{margin-left:6px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));color:inherit;cursor:pointer;font-size:11px}' +
      '.exp-hs-form{margin:10px 0 4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,var(--border,#eef1f4));border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--bg-subtle,#f6f8fa))}' +
      '.exp-hs-row{display:flex;align-items:center;gap:8px;padding:3px 0}' +
      '.exp-hs-label{flex:0 0 104px;max-width:104px;font-size:12px}' +
      '.exp-hs-input,.exp-hs-select{flex:1;min-width:0;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));color:inherit;font-size:12px}' +
      // ── 记忆后端三选一的**版式**（2026-09-17 用户截图：下拉被 `flex:1` 拉到 ~620px）──
      // 症状：标签只占 104px，控件横贯一整行（选中的那句中文只占 ~200px ⇒ 右边一大片空白，
      // 读起来像"控件被拉坏了"），而下方 `.exp-hs-kv` 的键列是 152px ⇒ 同一块里出现**两条不
      // 对齐的竖线**。处置只做两件事，且**都作用在元素自己的类上**：
      //   ① 标签列与键列对齐到 152px —— 用**复合选择器 + 专用类**（不是 `.exp-hs-mb .exp-hs-label`
      //      这种靠祖先关系的写法）：`HindsightBlock` 里那张配置表单的三个标签（部署形态 / 服务地址 /
      //      访问令牌）用的是同一个共享类 `.exp-hs-label`，一旦有人把那张表单搬进三选一这块，
      //      后代选择器会让它们**静默**变 152px 而没有任何断言会红。挂在自己的类上就没有这个隐患；
      //   ② 只给这一个下拉设上限（320px 够放下最长那条中文标签，实测 ~237px）。
      '.exp-hs-label.exp-hs-label-mb{flex:0 0 152px;max-width:152px}' +
      '.exp-hs-select.exp-hs-select-narrow{flex:0 1 320px;max-width:340px}' +
      // ⚠️ 这条是**全局**的：`.exp-settings-ctl` 里所有的 <select> 都吃到这个上限 —— 也就是设置页
      // **每一个 enum 行的控件**（identity.profile / roster.deliverable / display.defaultTab /
      // gates.tierGate / gates.leadToolFace / memory.backend），不只记忆后端那一行。
      // 为什么可以全局：这些行的固有宽度由最长选项文本决定（真机量过：89 / 142 / 89 / 142 / 188 /
      // 248 px，最大 248 < 340 ⇒ 今天**一个都没被裁**，等于给未来留的护栏，而不是当前的必要约束）；
      // 为什么需要它：`.exp-settings-ctl` 是 `flex:none`，控件按内容撑开、先把宽度吃掉 ⇒
      // 选项文案一长，右边那列说明（`.exp-settings-note`，`flex:1`）就被挤扁，而**说明那列才是给人读的**。
      // 超长说明另有出路：`.exp-settings-row-wide` 让它整行换到下一行（见上）。
      '.exp-settings-ctl select{max-width:340px}' +
      // 重启提示（`MemoryBackendBlock` 顶部那块）：复用 `.exp-hs-warn` 的琥珀色重条 —— 本仓
      // "需要你看一眼"的既有视觉语言 —— 再放大字号、加粗标题，让它在满屏灰字里第一眼被看到
      // （用户原话：「重启提示出现了 但是在最下面 用户可能看不到 需要有明显提示」）。
      '.exp-hs-warn.exp-hs-restart{margin:10px 0 2px;font-size:12px}' +
      '.exp-hs-restart-h{font-weight:700;margin-bottom:2px}' +
      // Midas 首装引导（2026-09-19 一期）：**刻意不用** `.exp-hs-warn`。
      // 两条理由：① 那是一个"告警框"类（`memory-backend.test.mjs` ⑦d 把它钉在**恰好两处**：
      // 重启提示 + 诊断块的当前故障）—— 首装引导不是告警，占用它会把那条计数守卫撑坏；
      // ② 它是个**块级**容器（步骤是有序列表 + 代码块 + 复制按钮），与"内联文字色"必须分开
      // —— 这正是用户截图里那个"缺边的破框"的根因，所以这里另起一个块级类，边界清楚。
      '.exp-hs-midas-guide{margin:8px 0 2px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:8px;font-size:11.5px;line-height:1.6}' +
      '.exp-hs-midas-guide-h{font-weight:700;margin-bottom:2px}' +
      '.exp-hs-midas-steps{margin:6px 0 0;padding-left:18px}' +
      '.exp-hs-midas-steps li{margin-bottom:4px}' +
      '.exp-hs-midas-steps code{font-size:11px;word-break:break-all}' +
      '.exp-hs-actions{display:flex;flex-wrap:wrap;gap:6px;padding-top:6px}' +
      '.exp-hs-btn{padding:3px 10px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));color:inherit;cursor:pointer;font-size:11.5px}' +
      '.exp-hs-btn:disabled{opacity:.55;cursor:default}' +
      '.exp-hs-btn.danger{color:#b3291e;border-color:#e3b0aa}' +
      '.exp-hs-msg{margin-top:6px;font-size:11.5px;font-weight:700;color:#1a7f5a}' +
      '.exp-hs-msg.bad{color:#b3291e;font-weight:600}' +
      // ── 深色主题覆写：宿主用的是 `body[data-ds-dark-theme]`，**不是** OS 的 prefers-color-scheme ──
      // 为什么本文件原来的机制是**错的**：宿主 `packages/client/ui-theme/src/boot-theme.ts` 把深色写成
      //   `document.body.toggleAttribute('data-ds-dark-theme', dark)`，而 `dark` 来自**三选一偏好**
      //   `light | dark | system`（只有 `system` 那一档才去读 `matchMedia('(prefers-color-scheme: dark)')`）。
      //   ⇒「宿主里选 Dark、操作系统仍是浅色」的用户：宿主调色板已经变深，而本插件那 4 个
      //   `@media (prefers-color-scheme:dark)` 块（.exp-warming / .exp-scope / .etv-* / .etc-*）一条都不生效。
      //   所以下面是**新增的**一处深色覆写，判据改用宿主真正写下的那个属性 —— 与 OS 无关。
      // 为什么只**增**、不动那 4 个块：它们是「机制选错」的历史包袱，但删除/迁移属于另一轮（要连带重写
      //   `dag-status.test.mjs` 的 `stripDark()` 花括号配平口径与两条「浅/深取值必须不同」的 NEGATIVE）——
      //   本轮只做最小新增，历史块一个字不动（⑦e 有断言钉住它们恰好 4 个）。
      // 对比度理由（数字按 WCAG 相对亮度公式、对宿主深色底 `--dsw-alias-bg-base` = `rgb(21,21,23)` 算得）：
      //   `.exp-hs-warn-text` 自 2026-09-17 起**直接贴在面板底上**（不再有浅色底衬的 callout 盒）⇒ 基规则的
      //   琥珀墨水 `#8a6100` 在深色底上只剩 **3.29:1**（绿 `#1a7f5a` 3.67:1、红 `#b3291e` 2.82:1 同理），
      //   低于 WCAG AA 正文 4.5:1。换成 `#f7ad31` 后是 **9.53:1**（`#4ed17e` 9.33:1、`#ff7b7b` 7.27:1）。
      //   `#f7ad31` 不是新造色：本文件 `.etv-*` 与 `.etc-*` 两处深色块已经在用它，数值上等于宿主
      //   `--dsw-static-amber-400`（`rgb(247,173,49)`）；`#4ed17e` / `#ff7b7b` 正是那两处的 `--etc-ok` / `--etc-fail`。
      //   底衬（半透明 wash）不动也够：`#f7ad31` 压在 `.exp-hs-tag` 的 `rgba(224,168,60,.18)` 上仍有 6.84:1，
      //   `#4ed17e` 压在「历史 · 已恢复」那层 `rgba(26,127,90,.14)` 上仍有 8.22:1 —— 都在 AA 之上。
      // ⚠️ 不能拿 `--dsw-alias-state-warn-secondary` / `state-success-*` 来「自动适配」：这两族令牌在明暗两套
      //   调色板里**取值相同**（本来就不随主题翻转）⇒ 深色下确实需要**另一个**琥珀色时，只能像本文件既有
      //   做法那样写显式字面量。反过来 `.exp-hs-hist .exp-hs-tag` 用的是 `--dsw-alias-label-secondary`，
      //   那一族**真的**随主题翻转 ⇒ 不需要覆写（这正是本块只列 8 条的原因）。
      // 只覆写 `color`（墨水）：半透明底衬（rgba wash）与非文字边框在深色下不构成对比度缺陷，动它们会越出
      //   「最小新增」的范围（`.exp-hs-btn.danger` 的浅粉描边同理：它是边框不是文字）。
      'body[data-ds-dark-theme] .exp-hs-warn-text{color:#f7ad31}' +
      // 第 9 条（2026-09-19）：`.exp-hs-offwarn` 是「off 但 mcp-midas 行还活着」那条警告的墨水 ——
      // 它与 `.exp-hs-warn-text` 的浅色基值**逐字相同**（都是 `#8a6100`），所以深色下同样必须换掉
      // （`#8a6100` 在 `#151517` 上只有 3.29:1，低于 AA 4.5:1）。取值与理由同上面那段对比度说明。
      // ⚠️ 加了这一条就必须同步 `memory-backend.test.mjs` 的 `DARK_INK`（8 → 9）—— ⑦ 的「不多不少」
      //    要求 `body[data-ds-dark-theme] …{…color:…}` 这一类规则**只允许** `DARK_INK` 里那些条。
      'body[data-ds-dark-theme] .exp-hs-offwarn{color:#f7ad31}' +
      'body[data-ds-dark-theme] .exp-hs-tag{color:#f7ad31}' +
      'body[data-ds-dark-theme] .exp-hs-ok{color:#4ed17e}' +
      'body[data-ds-dark-theme] .exp-hs-hist .exp-hs-tag-ok{color:#4ed17e}' +
      'body[data-ds-dark-theme] .exp-hs-msg{color:#4ed17e}' +
      'body[data-ds-dark-theme] .exp-hs-bad{color:#ff7b7b}' +
      'body[data-ds-dark-theme] .exp-hs-msg.bad{color:#ff7b7b}' +
      'body[data-ds-dark-theme] .exp-hs-btn.danger{color:#ff7b7b}' +
      '.exp-viol{color:#fff;background:linear-gradient(90deg,#c62828,#e53935);font-size:12px;font-weight:600;padding:7px 10px;border-radius:8px;margin:0 0 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.exp-decision{margin:8px 0;padding:12px 14px;border:1px solid var(--dsw-alias-state-business-primary,#0969da);border-radius:10px;background:linear-gradient(180deg,#f6f9ff,var(--dsw-alias-bg-layer-1,#fff))}' +
      '.exp-decision-title{font-weight:700;font-size:13px;color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-opt{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:8px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary,#1f2328)}' +
      '.exp-opt:hover{border-color:var(--dsw-alias-state-business-primary,#0969da);color:var(--dsw-alias-state-business-primary,#0969da)}' +
      // ── 对话流角色化工具卡（tool.call.toolview 注册）──
      '.et-tc{margin:6px 0;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:10px;background:linear-gradient(180deg,var(--dsw-alias-bg-module-platform,var(--bg-subtle,#f6f8fa)),var(--dsw-alias-bg-layer-1,var(--bg,#fff)));font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2328)}' +
      '.et-tc.run{border-color:#9db4ff;box-shadow:0 0 0 3px rgba(59,110,245,.08);animation:et-tc-pulse 1.6s ease-in-out infinite}' +
      '.et-tc.err{border-color:#f0bcb6;background:linear-gradient(180deg,#fff5f4,var(--dsw-alias-bg-layer-1,var(--bg,#fff)))}' +
      '@keyframes et-tc-pulse{0%,100%{box-shadow:0 0 0 3px rgba(59,110,245,.08)}50%{box-shadow:0 0 0 6px rgba(59,110,245,.16)}}' +
      '.et-tc-h{display:flex;align-items:center;gap:7px}' +
      '.et-tc-ava{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;background:rgba(120,140,255,.14);border:1px solid rgba(140,160,255,.3);flex:none}' +
      '.et-tc-nm{font-weight:700}' +
      '.et-tc-duty{font-size:11px;color:var(--dsw-alias-label-secondary,#57606a)}' +
      '.et-tc-st{margin-left:auto;font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:8px;white-space:nowrap;color:#3b6ef5;background:rgba(59,110,245,.1)}' +
      '.et-tc-st.done{color:#22b07d;background:rgba(34,176,125,.12)}' +
      '.et-tc-st.e{color:#b3291e;background:rgba(179,41,30,.1)}' +
      '.et-tc-t{margin:6px 0 3px;font-weight:600;line-height:1.45}' +
      '.et-tc-f{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a);line-height:1.5;word-break:break-all}' +
      '.et-tc-b{display:flex;gap:6px;margin-top:7px}' +
      '.et-tc-b button{font-size:11px;padding:2px 10px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:7px;background:var(--dsw-alias-bg-layer-3,var(--bg,#fff));cursor:pointer;color:var(--dsw-alias-state-business-primary,#0969da)}' +
      // ── N5 嵌入式画布视图（conversation.view）──
      // ⚠️ `position:relative;z-index:9` 不是装饰：完整页视图（conversation.view）**取代**了对话列，
      // 而对话列的两个列宽拖拽手柄（宿主的 `.wSkVaW_widthHandle`：`position:absolute;z-index:8`，
      // 40px 宽竖带 ×2）**仍然留在原地**。旧值是 `position:static` ⇒ `.exp-panel` 上那个 `z-index:120`
      // **完全不生效**（静态定位元素的 z-index 无效）⇒ 手柄画在视图之上，既遮挡又**抢走点击**
      // （真机实测：`document.elementFromPoint` 打在「编队画布」chip 中心命中的是
      // `DIV.wSkVaW_widthHandle`，在那里按下会变成拖列宽）。`relative` + 9 让本视图在
      // 同一层叠上下文里压过手柄（8）。视图切回「对话」时本视图卸载，手柄自然恢复 —— 不改宿主。
      '.exp-canvas{position:relative;z-index:9;width:100%;height:100%;border-left:none;box-shadow:none;border-radius:0}' +
      '.exp-canvas .exp-head{border-radius:0}' +
      // ── N1 对话流团队动态胶囊 ──
      '.exp-cap{position:fixed;z-index:118;top:64px;left:50%;transform:translateX(-50%);max-width:76vw;font-size:12px}' +
      '.exp-cap-btn{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;background:linear-gradient(180deg,#1f2937,#111827);color:#e6edff;border:1px solid rgba(140,160,255,.45);box-shadow:0 6px 18px rgba(0,0,0,.35);cursor:pointer;max-width:100%}' +
      '.exp-cap-dot{width:8px;height:8px;border-radius:50%;background:#22b07d;animation:exp-pulse 1.4s ease-in-out infinite;flex:none}' +
      '.exp-cap-tx{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.exp-cap-panel{margin-top:6px;background:var(--dsw-alias-bg-base,var(--bg,#fff));border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.28);padding:6px 8px;max-height:320px;overflow:auto}' +
      '.exp-cap-row{display:flex;gap:8px;align-items:baseline;padding:5px 6px;font-size:12px;color:var(--dsw-alias-label-primary,#1f2328);border-bottom:1px dashed var(--dsw-alias-border-l1,#eef1f5)}' +
      '.exp-cap-row.cur{font-weight:700}' +
      '.exp-cap-ic{flex:none}' +
      '.exp-cap-t{margin-left:auto;font-family:ui-monospace,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#57606a)}' +
      '.exp-cap-foot{padding:7px 6px 3px;text-align:right}' +
      '.exp-cap-foot button{font-size:11.5px;padding:3px 12px;border:1px solid var(--dsw-alias-state-business-primary,#0969da);border-radius:8px;background:transparent;color:var(--dsw-alias-state-business-primary,#0969da);cursor:pointer}' +
      // ── N2 待拍板横幅（composer 接管）──
      '.exp-decbar{display:flex;align-items:center;gap:10px;padding:10px 14px;margin:6px 12px;border:1px solid var(--dsw-alias-state-business-primary,#0969da);border-radius:12px;background:linear-gradient(180deg,#f6f9ff,var(--dsw-alias-bg-layer-1,#fff));box-shadow:0 4px 14px rgba(59,110,245,.14)}' +
      '.exp-decbar-ic{font-size:18px;flex:none}' +
      '.exp-decbar-t{font-weight:700;font-size:13px;color:var(--dsw-alias-state-business-primary,#0969da)}' +
      '.exp-decbar-p{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);margin-top:2px}' +
      // ── 子代理运行状态条（常驻在输入框正上方；conversation.input.dock）──
      // 运行中 = 醒目横幅 + 呼吸点（可点击打开团队面板）；无人在跑 = 一行灰字（几乎不占位）。
      // 为什么必须有它：原先只有会话页头一个小徽章 + 右侧面板，输入框附近没有任何指示，
      // 用户无法一眼判断"现在到底有没有子代理在跑"。本条的运行态判据与页头徽章**同源**
      // （都取 /state 的 agents[].activity === 'running'），两条指示不会互相矛盾。
      // 宽度：dock 条目渲染在输入框根容器的左右内边距**之外**，必须自己让出 `--dsh-composer-side-clearance` 并 `margin:0 auto` 居中；宽度上限还必须再取卡片自己的上限 `--dsh-composer-card-max-width`（否则在宽窗口下会无视卡片上限、左右各鼓出一段 —— 真机实测过 card 846 vs bar 948）。绝不能写 width:100%。 +
      '.exp-subbusy{display:flex;align-items:center;gap:8px;box-sizing:border-box;flex:none;width:auto;min-width:0;max-width:min(calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance)), var(--dsh-composer-card-max-width));margin:0 auto 4px;padding:1px 12px;border:1px solid #f0c36d;border-left:3px solid #e0a83c;border-radius:10px;background:linear-gradient(180deg,rgba(224,168,60,.13),var(--dsw-alias-bg-layer-1,#fff));color:#8a6100;font-size:12px;line-height:1.4}' +
      '.exp-subbusy.on{cursor:pointer}' +
      '.exp-subbusy.on:hover{border-color:#d99b1f}' +
      '.exp-subbusy-dot{width:8px;height:8px;border-radius:50%;background:#e0a83c;flex:none;animation:exp-pulse 1.4s ease-in-out infinite}' +
      '.exp-subbusy-t{font-weight:700}' +
      '.exp-subbusy-who{color:#6a4a00;opacity:.9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.exp-subbusy-go{margin-left:auto;flex:none;font-size:11.5px;font-weight:700;color:#8a6100;opacity:.75}' +
      '.exp-subbusy-idle{box-sizing:border-box;flex:none;width:auto;min-width:0;max-width:min(calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance)), var(--dsh-composer-card-max-width));margin:0 auto;padding:1px 12px 4px;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#8b949e))}' +
      // ── 任务人员流转（波次带）样式：来自 UI.md §4.2（.etv-*，主题变量 + 深色覆写，零依赖）──
      '/* ── 任务人员流转：竖直时间轴 + 波次带 ── */\n.etv-root{display:block;position:relative;padding:2px 0 4px}\n.etv-note{font-size:11px;color:var(--dsw-alias-label-secondary);margin:2px 0 8px;display:flex;align-items:center;gap:6px}\n.etv-wide-btn{margin-left:auto;font-size:10.5px;padding:1px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer}\n.etv-wave{position:relative;margin:0 0 var(--etv-wave-gap);border-radius:0 8px 8px 0}\n.etv-wave.cur{background:rgba(65,118,230,.055);border-left:2px solid var(--dsw-alias-state-business-primary)}\n.etv-wave-h{display:flex;align-items:center;gap:6px;height:22px;padding-left:var(--etv-indent);font-size:11.5px;font-weight:600;cursor:default}\n.etv-wave.collapsed .etv-wave-h{cursor:pointer}\n.etv-wave-no{display:inline-flex;align-items:center;justify-content:center;height:16px;min-width:16px;padding:0 5px;border-radius:8px;font-size:10px;font-weight:700;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}\n.etv-wave.cur .etv-wave-no{background:var(--dsw-alias-state-business-primary);color:#fff}\n.etv-time{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}\n.etv-delta{font-size:10px;color:var(--dsw-alias-label-tertiary)}\n.etv-wave-n{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}\n.etv-wave-sum{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.etv-cards{display:flex;flex-wrap:wrap;gap:var(--etv-gap);padding:6px 0 2px var(--etv-indent)}\n.etv-scroll{overflow-x:auto;padding-bottom:4px;scrollbar-width:thin}\n.etv-scroll .etv-cards{flex-wrap:nowrap}\n.etv-card{flex:1 1 var(--etv-card-min);min-width:0;max-width:100%;box-sizing:border-box;border:1.4px solid var(--etv-idle);border-radius:9px;background:var(--dsw-alias-bg-layer-1);padding:6px 8px 6px 7px;min-height:56px;cursor:pointer;position:relative;transition:border-color .12s,background .12s}\n.etv-card:hover{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}\n.etv-card.sel{background:var(--dsw-alias-state-business-tertiary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}\n.etv-card.run{border-color:var(--etv-run);border-width:2px;background:rgba(59,110,245,.08)}\n.etv-card.done{border-color:var(--etv-ok);background:rgba(34,176,125,.10)}\n.etv-card.rework{border-color:var(--etv-rework);border-style:dashed;background:rgba(217,119,6,.10)}\n.etv-card.failed{border-color:var(--etv-fail);background:rgba(192,57,43,.09)}\n.etv-card.more{align-items:center;justify-content:center;display:flex;border-style:dashed;color:var(--dsw-alias-label-secondary);font-size:11.5px}\n.etv-card.tiny{min-height:40px}\n.etv-card.tiny .etv-task{display:none}\n.etv-card-h{display:flex;align-items:center;gap:5px;min-width:0}\n.etv-card .exp-ava{width:18px;height:18px;font-size:10px;margin-right:0;flex:none}\n.etv-role{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}\n.etv-who{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}\n.etv-task{margin-top:3px;font-size:11px;line-height:1.35;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.etv-card-f{display:flex;align-items:center;gap:6px;margin-top:5px;height:16px}\n.etv-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}\n.etv-dot.run{animation:exp-pulse 1.4s ease-in-out infinite}\n.etv-dot.hollow{background:transparent!important;border:1.5px solid var(--etv-idle)}\n.etv-dur{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}\n.etv-rework-tag{position:absolute;top:-7px;left:6px;font-size:9.5px;line-height:14px;padding:0 5px;border-radius:7px;background:var(--dsw-alias-state-warn-tertiary,#fff7ea);border:1px solid #f3c9a0;color:#a34a00}\n.etv-rail{position:absolute;left:0;top:0;bottom:0;width:16px;pointer-events:none}\n.etv-rail-i{position:absolute;left:7px;top:0;bottom:0;width:2px;background:var(--etv-line)}\n.etv-rail-n{position:absolute;left:3px;width:10px;height:10px;border-radius:50%;border:2px solid var(--dsw-alias-bg-layer-1);box-sizing:content-box}\n.etv-handoff{stroke:#8aa8e8;stroke-width:1.4;fill:none}\n.etv-rework-link{stroke:var(--etv-rework);stroke-width:1.5;stroke-dasharray:4 3;fill:none}\n.etv-para{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:2px}\n.etv-group{border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;padding:6px 8px;margin:0 0 var(--etv-gap) var(--etv-indent);background:var(--dsw-alias-bg-module-platform)}\n/* ── 深色主题覆写（零依赖：prefers-color-scheme 兜底；若 shell 在根节点暴露主题标记，优先用它） ── */\n@media (prefers-color-scheme:dark){\n  .exp-panel{--etv-run:#679efe;--etv-ok:#4ed17e;--etv-rework:#f7ad31;--etv-fail:#ff7b7b;--etv-idle:#adb2b8;\n             --etv-text-ok:#4ed17e;--etv-text-run:#679efe;--etv-text-rework:#f7ad31}\n  .etv-handoff{stroke:#679efe}\n  .etv-rework-tag{background:#3a2c14;border-color:#7a5a22;color:#f7ad31}\n  .etv-degrade.warn{background:rgba(247,173,49,.12);color:#f7ad31}\n  .etv-degrade.info{color:#9dc0ff}\n  .etv-wave.cur{background:rgba(103,158,254,.10)}\n}\n/* ── 无障碍：减少动效 ── */\n@media (prefers-reduced-motion:reduce){.etv-dot.run,.etv-skel{animation:none!important}}'

      // lead 微调（UI.md 基线之上）：360px 两列时 8px 间距偏挤 → 10px；卡更高一点；分组区更松
      + '.etv-cards{gap:10px}.etv-card{min-height:58px}.etv-group{padding:8px 10px 4px}'
      // ── 补漏：`--etv-*` 的**浅色**取值 ──
      // 为什么必须有这一段（真缺陷，非推测）：`--etv-lead/idle/run/ok/rework/fail/line/text-*/indent/gap/card-min/wave-gap`
      // 在本插件里**只在** `@media (prefers-color-scheme:dark)`（见上一段 `.etv-*` 尾部）里被赋值，
      // 浅色路径**从未定义**，却被 `.etv-card{border:1.4px solid var(--etv-idle)}`、`.etv-rail-i{background:var(--etv-line)}`、
      // `.etv-cards{gap:var(--etv-gap)}` 等**无 fallback** 地使用 ⇒ 浅色下这些声明整条失效（边框/导轨/间距消失）。
      // 作用域取 `.exp-panel,.exp-canvas`：与深色覆写同一选择器，深色靠"后出现"同权重胜出。
      + '.exp-panel,.exp-canvas{--etv-lead:#3b6ef5;--etv-idle:#c2c8d0;--etv-run:#3b6ef5;--etv-ok:#22b07d;--etv-rework:#d97706;--etv-fail:#c0392b;--etv-line:#d8dee7;--etv-text-run:#1f6feb;--etv-text-ok:#1a7f5a;--etv-text-rework:#b45309;--etv-indent:16px;--etv-gap:8px;--etv-card-min:132px;--etv-wave-gap:10px}'
      // ── 专家团画布（`.etc-*` = expert-team canvas）：编队 + 共享任务列表 ──
      // 变量一律"浅色在此、深色在紧随其后的同条件块里"成对给出，绝不留只在单侧生效的变量。
      + '.etc-root{--etc-line:#d0d7de;--etc-edge-ok:#22b07d;--etc-edge-warn:#d29922;--etc-lead:#3b6ef5;--etc-ok:#22b07d;--etc-run:#3b6ef5;--etc-warn:#b45309;--etc-rework:#d97706;--etc-fail:#c0392b;--etc-idle:#c2c8d0;--etc-soft:rgba(59,110,245,.06);display:block;min-width:0}'
      + '.etc-sec-h{font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary,#57606a);margin:8px 0 5px}'
      + '.etc-formation{display:flex;flex-direction:column;align-items:center;gap:0;min-width:0}'
      + '.etc-leader{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center}'
      + '.etc-leader-name{display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:center}'
      + '.etc-badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:center}'
      + '.etc-badge{font-size:10px;line-height:15px;padding:0 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#57606a);white-space:nowrap}'
      + '.etc-lead-note{font-size:10px;color:var(--dsw-alias-label-tertiary,#8b949e)}'
      + '.etc-bus{position:relative;width:100%;min-height:20px;margin:4px 0 0}'
      + '.etc-bus-line{position:absolute;left:4%;right:4%;top:9px;border-top:1.4px dashed var(--etc-line)}'
      + '.etc-assign{position:absolute;left:50%;top:1px;transform:translateX(-50%);font-size:10px;line-height:16px;padding:0 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#57606a);white-space:nowrap}'
      + '.etc-members{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;width:100%;min-width:0}'
      + '.etc-member{position:relative;flex:1 1 168px;min-width:0;max-width:260px;box-sizing:border-box;border:1.4px solid var(--etc-idle);border-radius:10px;padding:6px 8px 5px;background:var(--dsw-alias-bg-layer-1,#fff)}'
      + '.etc-member-h{display:flex;align-items:center;gap:6px;min-width:0}'
      + '.etc-avatar{width:36px;height:36px;border-radius:50%;flex:none;overflow:hidden;display:block;background:var(--dsw-alias-bg-layer-2,#f6f8fa)}'
      + '.etc-avatar-svg{width:100%;height:100%;display:block}'
      + '.etc-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));min-width:0}'
      + '.etc-state{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a);margin-top:4px}'
      + '.etc-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;background:var(--etc-idle)}'
      + '.etc-dot.run{animation:exp-pulse 1.4s ease-in-out infinite}'
      + '.etc-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2,#eef1f4);overflow:hidden;margin-top:5px}'
      + '.etc-bar>i{display:block;height:6px;width:0;background:var(--etc-idle)}'
      + '.etc-bar.run>i{background:var(--etc-run);animation:exp-pulse 1.6s ease-in-out infinite}'
      + '.etc-bar.ok>i{background:var(--etc-ok)}'
      + '.etc-bar.bad>i{background:var(--etc-rework)}'
      + '.etc-cols{position:relative;display:flex;gap:12px;overflow-x:auto;align-items:flex-start;max-width:100%;padding:2px 2px 6px}'
      + '.etc-col{flex:0 0 auto;width:min(280px,78vw);min-width:0;box-sizing:border-box}'
      + '.etc-col-h{display:flex;align-items:baseline;gap:6px;font-size:11.5px;font-weight:700;margin:0 0 2px}'
      + '.etc-col-n{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#57606a);flex:none}'
      + '.etc-col-note{font-size:10px;line-height:1.35;color:var(--dsw-alias-label-tertiary,#8b949e);margin:0 0 5px}'
      + '.etc-cards{display:flex;flex-direction:column;gap:8px;min-height:4px}'
      + '.etc-card{box-sizing:border-box;border:1.4px solid var(--etc-idle);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);padding:6px 8px;cursor:pointer;min-width:0}'
      + '.etc-card:hover{border-color:var(--dsw-alias-state-business-primary,#0969da)}'
      + '.etc-card.sel{border-color:var(--dsw-alias-state-business-primary,#0969da);box-shadow:0 0 0 2px var(--etc-soft)}'
      + '.etc-card.run{border-color:var(--etc-run)}'
      + '.etc-card.ok{border-color:var(--etc-ok)}'
      // 失败/返工卡：`canvasCardNode` 会挂 `.bad`（rework|failed）。缺这条规则时它们与"未开始"看起来一样，
      // 只有胶囊和状态条能区分 —— 边框是画布上最先被看到的信号，不能缺。
      + '.etc-card.bad{border-color:var(--etc-fail)}'
      + '.etc-card-h{display:flex;align-items:center;gap:5px;min-width:0}'
      + '.etc-id{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a);font-variant-numeric:tabular-nums}'
      + '.etc-card-t{font-size:11.5px;line-height:1.4;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'
      + '.etc-owner{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#57606a);margin-top:5px}'
      + '.etc-owner .etc-avatar{width:14px;height:14px}'
      + '.etc-owner-none{color:var(--dsw-alias-label-tertiary,#8b949e)}'
      + '.etc-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}'
      + '.etc-chip{font-family:ui-monospace,Menlo,monospace;font-size:10px;line-height:15px;padding:0 5px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de));background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#57606a);white-space:nowrap}'
      + '.etc-chip.ok{border-color:var(--etc-ok);color:var(--etc-ok)}'
      + '.etc-chip.warn{border-color:var(--etc-edge-warn);color:var(--etc-warn)}'
      + '.etc-chip.more{border-style:dashed}'
      + '.etc-blocked{font-size:10.5px;line-height:1.35;color:var(--etc-warn);margin-top:4px}'
      // ⚠️ `width:100%;height:100%` **不是冗余**：`<svg>` 是**替换元素**（replaced element），
      // `inset:0` 对替换元素只决定"放在哪"，**不会把它撑开** —— 没有 width/height 属性时浏览器
      // 退回 SVG 的默认内在尺寸 **300×150**。真机实测：列容器 `.etc-cols` 是 962×297，而 `.etc-edges`
      // 的计算尺寸恒为 300×150 ⇒ 即使量到了正确的卡片坐标，箭头也被裁在左上角那 300×150 里看不见
      // （观感就是"一条依赖箭头都没有"）。
      + '.etc-edges{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:0}'
      + '.etc-edge{fill:none;stroke:var(--etc-edge-warn);stroke-width:1.4;stroke-dasharray:5 4}'
      + '.etc-edge.ok{stroke:var(--etc-edge-ok);stroke-dasharray:none;opacity:.95}'
      + '.etc-edge.warn{stroke:var(--etc-edge-warn)}'
      + '.etc-edge-arrow{fill:var(--etc-edge-warn)}'
      + '.etc-edge-arrow.ok{fill:var(--etc-edge-ok)}'
      + '.etc-empty{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b949e);padding:6px 2px}'
      + '.etc-warn{font-size:10.5px;line-height:1.4;color:var(--etc-warn);border:1px dashed var(--etc-edge-warn);background:rgba(210,153,34,.10);border-radius:8px;padding:4px 7px;margin:4px 0}'
      + '.etc-degrade{font-size:10.5px;line-height:1.4;border:1px solid #e3c56b;background:linear-gradient(180deg,rgba(217,164,65,.14),var(--dsw-alias-bg-layer-1,#fff));color:#7a5a00;border-radius:8px;padding:5px 8px;margin:4px 0}'
      + '.etc-legend .etc-edge-sample{width:16px;border-top:1.4px dashed var(--etc-edge-warn);display:inline-block;margin-right:4px}'
      + '.etc-legend .etc-edge-sample.ok{border-top-style:solid;border-top-color:var(--etc-edge-ok)}'
      // 深色：与浅色**同条件、同变量名**成对覆写；只列两边值不同的项，避免"漏一侧"。
      + '@media (prefers-color-scheme:dark){.etc-root{--etc-line:#4a5261;--etc-edge-ok:#4ed17e;--etc-edge-warn:#f7ad31;--etc-ok:#4ed17e;--etc-run:#679efe;--etc-warn:#f7ad31;--etc-rework:#f7ad31;--etc-fail:#ff7b7b;--etc-idle:#adb2b8;--etc-soft:rgba(103,158,254,.12)}.etc-degrade{border-color:#7a5a22;color:#f7ad31}}'
      + '@media (prefers-reduced-motion:reduce){.etc-bar.run>i,.etc-dot.run{animation:none!important}}'
      // SVG 树（照抄目标形态）：曲线 + 节点卡，全部用主题变量，深色自动适配
      + '.etv-graph{overflow-x:auto;margin:2px 0 6px;padding-bottom:2px}'
      + '.etv-curve{fill:none;stroke:#8aa8e8;stroke-width:1.4;opacity:.85}'
      // 依赖边是视觉主角（真实 DAG），委派边降权成虚线
      + '.etv-dep-edge{fill:none;stroke:#5b8def;stroke-width:1.4;opacity:.95;stroke-linecap:round}'
      + '.etv-g-node{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-border-l2);stroke-width:1.4}'
      + '.etv-g-node.run{stroke:var(--etv-run);stroke-width:2}'
      + '.etv-g-node.failed{stroke:var(--etv-fail);stroke-width:2;stroke-dasharray:5 3}'
      + '.etv-g-node.crit{stroke:var(--etv-ok);stroke-width:2}'
      + '.etv-g-node.lead{stroke:var(--etv-lead);stroke-width:1.6}'
      + '.etv-link{position:relative;height:16px;margin-left:var(--etv-indent)}.etv-link i{position:absolute;left:6px;top:0;bottom:0;width:2px;background:var(--etv-line)}.etv-link b{position:absolute;left:1.5px;bottom:-2px;font-size:9px;line-height:1;color:var(--dsw-alias-label-tertiary)}.etv-list{position:relative;margin:2px 0 6px var(--etv-indent);padding-left:16px}.etv-list-i{position:absolute;left:0;top:0;bottom:14px;width:2px;background:var(--etv-line)}.etv-row{position:relative;margin:0 0 10px}.etv-row::before{content:"";position:absolute;left:-16px;top:28px;width:14px;height:2px;background:var(--etv-line)}.etv-row::after{content:"";position:absolute;left:-19px;top:25px;width:6px;height:6px;border-radius:50%;background:var(--etv-line)}'
    // ── session store (mirrors dsh-md-preview) ──
    /**
     * 注入本插件的样式表（幂等）。**必须由任何会渲染本插件 UI 的入口调用** ——
     * 原来只有 HeaderButton 在渲染时注入，于是「会话还没建/首屏打开官方设置面板」时
     * 设置表单是一堆无样式控件。
     */
    function ensureCss() {
      try {
        if (typeof document === 'undefined' || document.querySelector('style[data-et-css]')) return
        var stEl = document.createElement('style')
        stEl.setAttribute('data-et-css', '1')
        stEl.textContent = CSS
        document.head.appendChild(stEl)
      } catch (e) {}
    }
    var currentSessionId = null
    var open = false // default collapsed so the panel never auto-blocks the workspace; open via the「专家团」header button
    var listeners = new Set()
    function notify() { listeners.forEach(function (f) { try { f() } catch (e) {} }) }
    function setCurrentSession(sid) { if (currentSessionId === sid) return; currentSessionId = sid; notify() }
    function setOpen() { open = !open; notify() }
    function subscribe(f) { listeners.add(f); return function () { listeners.delete(f) } }
    function useExternal(getValue) { var s = useState(getValue()); useEffect(function () { return subscribe(function () { s[1](getValue()) }) }, []); return s[0] }

    // ── 设置桥（1.3.4）：`display.*` 的**唯一**运行态来源 ───────────────────────────
    // 为什么必须有它：此前全仓只有一处 `/settings` 拉取，而且只在设置表单里 —— display 四项因此
    // 永远流不到运行态（轮询间隔/胶囊停留/面板宽度/默认页签各自硬编码或读 localStorage）。
    // 这里建**一条**共享的路：面板挂载时拉一次；设置页保存成功后复用同一条路把新值通知出去
    // ⇒ 改设置**当场生效**（同一 client、进程内），不必重启。
    var EXPERT_DISPLAY = { pollMs: 3000, capsuleMs: 4000, panelWidth: 420, defaultTab: 'team' }
    var DISPLAY_TABS = ['team', 'tasks', 'board', 'info']
    var DISPLAY_RANGE = { pollMs: [1000, 60000], capsuleMs: [0, 60000], panelWidth: [280, 900] }
    var displayLoaded = false
    var displayLoading = null
    function clampInt(v, lo, hi, def) { var n = Number(v); if (!isFinite(n)) return def; n = Math.round(n); return Math.max(lo, Math.min(hi, n)) }
    /** 从 `/settings` 响应挑出 display 四项并按值域夹紧；缺项/越界一律回退当前值（不制造 NaN/空白）。 */
    function pickDisplay(settings) {
      var d = (settings && settings.display) || {}
      return {
        pollMs: clampInt(d.pollMs, DISPLAY_RANGE.pollMs[0], DISPLAY_RANGE.pollMs[1], EXPERT_DISPLAY.pollMs),
        capsuleMs: clampInt(d.capsuleMs, DISPLAY_RANGE.capsuleMs[0], DISPLAY_RANGE.capsuleMs[1], EXPERT_DISPLAY.capsuleMs),
        panelWidth: clampInt(d.panelWidth, DISPLAY_RANGE.panelWidth[0], DISPLAY_RANGE.panelWidth[1], EXPERT_DISPLAY.panelWidth),
        defaultTab: DISPLAY_TABS.indexOf(String(d.defaultTab)) >= 0 ? String(d.defaultTab) : EXPERT_DISPLAY.defaultTab
      }
    }
    /** 应用一份设置：换对象（useExternal 才看得见变化）+ 未拖动过宽度时采纳设置值 + 通知重渲染。 */
    function applyDisplaySettings(settings) {
      var next = pickDisplay(settings)
      var changed = next.pollMs !== EXPERT_DISPLAY.pollMs || next.capsuleMs !== EXPERT_DISPLAY.capsuleMs || next.defaultTab !== EXPERT_DISPLAY.defaultTab
      EXPERT_DISPLAY = next
      // 宽度：设置值是**默认宽度**；用户拖过就以拖动结果为准（拖动结束会把宽度写回设置）。
      if (!panelWidthUserSet && next.panelWidth !== panelWidth) { panelWidth = clampW(next.panelWidth); changed = true }
      if (changed) notify()
      return next
    }
    function fetchSettingsPayload() {
      return fetch('/plugins/dsh-expert-team/settings').then(function (r) {
        return r.json().catch(function () { return null }).then(function (d) { return { ok: r.ok, status: r.status, d: d } })
      })
    }
    /** 拉一次设置（幂等：同一次加载只拉一次；失败静默 —— 面板照旧用默认值工作）。 */
    function loadDisplaySettings() {
      if (displayLoaded) return displayLoading || Promise.resolve(EXPERT_DISPLAY)
      displayLoading = fetchSettingsPayload().then(function (res) {
        displayLoaded = true
        if (res.ok && res.d && res.d.ok && res.d.settings) applyDisplaySettings(res.d.settings)
        return EXPERT_DISPLAY
      }).catch(function () { displayLoaded = true; return EXPERT_DISPLAY })
      return displayLoading
    }
    /** 运行态取 display 配置（挂载时拉一次；保存后由 applyDisplaySettings 通知更新）。 */
    function useDisplaySettings() {
      var v = useExternal(function () { return EXPERT_DISPLAY })
      useEffect(function () { loadDisplaySettings() }, [])
      return v
    }
    /** 拖动结束把宽度**防抖**写回设置（单一真源）；localStorage 只作首帧缓存。 */
    var widthSaveTimer = null
    function persistDisplayWidth(w) {
      if (widthSaveTimer) clearTimeout(widthSaveTimer)
      widthSaveTimer = setTimeout(function () {
        widthSaveTimer = null
        try {
          fetch('/plugins/dsh-expert-team/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'display.panelWidth': w })
          }).then(function (r) { return r.json().catch(function () { return null }) }).then(function (d) {
            if (d && d.ok && d.settings) applyDisplaySettings(d.settings)
          }).catch(function () {})
        } catch (e) {}
      }, 400)
    }
    /** 对话流 workflow 卡是否已回退到 dsh 原生（localStorage 开关，刷新生效）。 */
    function nativeWfOn() { try { return window.localStorage.getItem('et-native-workflow') === '1' } catch (e) { return false } }
    function useCurrentSession() { return useExternal(function () { return currentSessionId }) }
    function useOpen() { return useExternal(function () { return open }) }
    // 切换开关必须**订阅**才可见：旧写法在渲染时直接调 nativeWfOn()，而 notify() 触发的一批
    // setState 值全都没变 ⇒ React 直接 bail out ⇒ 标签不翻转，点击看起来「没反应」。
    function useNativeWf() { return useExternal(nativeWfOn) }

    // ── panel dock / drag state (memory like dsh-md-preview) ──
    function loadLS(key, def) { try { var v = window.localStorage.getItem(key); return v ? JSON.parse(v) : def } catch (e) { return def } }
    function saveLS(key, v) { try { window.localStorage.setItem(key, JSON.stringify(v)) } catch (e) {} }
    var dockState = loadLS('et-dock', true)
    var panelPos = loadLS('et-pos', { x: 0, y: 0 })
    // 1.3.4：默认宽度来自设置 `display.panelWidth`（首帧用 localStorage 缓存避免闪烁）；
    // 值域与设置对齐 280..900（此前 clamp 到 640、CSS 写死 360 —— 三处互不一致）。
    var panelWidthLS = loadLS('et-width', null)
    var panelWidthUserSet = typeof panelWidthLS === 'number'
    var panelWidth = clampW(typeof panelWidthLS === 'number' ? panelWidthLS : EXPERT_DISPLAY.panelWidth)
    function clampW(w) { return Math.max(280, Math.min(900, w)) }
    function setDock(v) { if (dockState === v) return; dockState = v; if (!v) { panelPos = { x: ((window && window.innerWidth) || 1280) - panelWidth, y: 80 }; saveLS('et-pos', panelPos) } saveLS('et-dock', dockState); notify() }
    function setPanelPos(x, y) { panelPos = { x: x, y: y }; saveLS('et-pos', panelPos); notify() }
    /**
     * 任务点击 → 把团队面板**停靠到右侧**并展开，用右栏展示该任务详情，而不是停在浮动浮层里。
     * 停靠态由 shell frame 让位（见 Panel 的 paddingRight 副作用），因此是真正的右侧并排栏。
     * 直接置位 open（setOpen() 是 toggle 语义，会误关已打开的面板）。
     */
    function focusPanelRight() {
      try {
        var changed = false
        if (dockState !== true) { dockState = true; saveLS('et-dock', true); changed = true }
        if (!open) { open = true; changed = true }
        if (changed) notify()
      } catch (e) {}
    }
    function setPanelWidth(w) { panelWidth = clampW(w); panelWidthUserSet = true; saveLS('et-width', panelWidth); notify(); persistDisplayWidth(panelWidth) }

    /**
     * ── 对话流卡片 → 右侧面板的「聚焦意图」通道 ──
     * 对话里的角色卡/任务卡被点击时**不跳新页面、不切视图**：只写一条意图并把面板停靠到右侧，
     * 由常驻的 Panel 消费该意图、选中对应角色的进行中任务 —— 详情就渲染在右栏。
     * 用自增 seq 做去重，避免轮询重渲染时重复应用同一条意图。
     */
    var focusIntent = null
    var focusSeq = 0
    function requestFocus(v) { focusSeq += 1; focusIntent = Object.assign({ seq: focusSeq }, v || {}); notify() }
    function useFocusIntent() { return useExternal(function () { return focusIntent }) }

    // ── 波次聚类（SPEC §2.3 纯函数，可单测）──────────────────────────────
    // 主轴 = 时间波次：同波内 createdAt 相差 ≤ WAVE_GAP_MS，视为"同一批派工"（实证同波 Δ≤1ms、
    // 波间 ≥60s，故 1500ms 切分零歧义：13 人 → 7 波）。**不臆造**：createdAt 缺失的人进 untimed，
    // 绝不按数组顺序/阶段/依赖去伪造批次。
    var WAVE_GAP_MS = 1500
    var MAX_WAVES = 12
    function buildWaves(people, gapMs) {
      var gap = typeof gapMs === 'number' && gapMs > 0 ? gapMs : WAVE_GAP_MS
      var timed = [], untimed = []
      ;(people || []).forEach(function (p) {
        if (p && typeof p.createdAt === 'number' && p.createdAt > 0) timed.push(p)
        else if (p) untimed.push(p)
      })
      timed.sort(function (a, b) { return (a.createdAt - b.createdAt) || String(a.id || '').localeCompare(String(b.id || '')) })
      var waves = []
      timed.forEach(function (p) {
        var last = waves[waves.length - 1]
        if (last && p.createdAt - last.startAt <= gap) last.members.push(p)
        else waves.push({ index: waves.length + 1, startAt: p.createdAt, members: [p] })
      })
      // 精修（仅当有 parentId）：派生 ≠ 并列 —— 父在同波时，把子挪到下一波（实证 047765b8）
      if (waves.length && timed.some(function (p) { return p && p.parentId })) {
        var moved = true, guard = 0
        while (moved && guard++ < 8) {
          moved = false
          for (var wi = 0; wi < waves.length; wi++) {
            var w = waves[wi]
            var keep = [], spill = []
            w.members.forEach(function (p) {
              var sameWaveParent = p.parentId && w.members.some(function (q) { return q.id && String(q.id) === String(p.parentId) })
              if (sameWaveParent) { spill.push(p); moved = true } else keep.push(p)
            })
            if (spill.length) {
              w.members = keep
              if (!waves[wi + 1]) waves.push({ index: wi + 2, startAt: spill[0].createdAt, members: [] })
              waves[wi + 1].members = waves[wi + 1].members.concat(spill)
            }
          }
          waves = waves.filter(function (w) { return w.members.length })
        }
      }
      waves.forEach(function (w, i) { w.index = i + 1 })
      // 上限：> MAX_WAVES 时把尾部并入最后一波
      var merged = 0
      if (waves.length > MAX_WAVES) {
        var tail = waves.slice(MAX_WAVES - 1)
        tail.forEach(function (w) { merged += w.members.length })
        waves = waves.slice(0, MAX_WAVES - 1)
        waves.push({ index: MAX_WAVES, startAt: tail.length ? tail[0].startAt : 0, members: tail.reduce(function (a, w) { return a.concat(w.members) }, []), merged: merged })
      }
      var base = waves.length ? waves[0].startAt : 0
      return { waves: waves, untimed: untimed, base: base, gap: gap }
    }

    /**
     * 补全成员的 `createdAt` —— **全景图的分层依据**（纯函数，便于单测）。
     *
     * 为什么需要：分层唯一依据是 `createdAt`，而 **workflow 派生的子代理没有会话 header**，
     * host 只能拿到 0。实测本会话 30 个子代理**全部**为 0 ⇒ `buildWaves` 判为
     * 「无创建时间记录，无法分批」⇒ 全景图退化成一条竖直列表（用户看到的就是这个）。
     *
     * 两源，按可信度降级，并**回报用了哪一源**（UI 必须如实标注，不得把推断当事实）：
     *   ① `header` —— host 从子会话 header 读到的真实时刻（最准）
     *   ② `event`  —— 父会话事件流 `tool-workflow/agent-start` 的**真实墙钟时间**
     *                 （实测同一次扇出内 Δ≤1ms、扇出之间 ~25s，正好是 buildWaves 的切分粒度）
     * 两源都拿不到 ⇒ 保持 `createdAt: 0` 走既有的「无时间戳」降级路径，
     * **刻意不按数组下标合成时间戳**：那会把"不知道"伪装成"知道"。
     *
     * 顺带把 workflow 归属与**逐子代理结算态**挂上，供画布画"同一次扇出"的边、
     * 并把"被中断、从未结算"的节点标红（而不是让它永远转圈）。
     */
    function enrichPeopleTiming(people, wfChildren) {
      var meta = (wfChildren && typeof wfChildren === 'object' && !Array.isArray(wfChildren)) ? wfChildren : {}
      var out = [], used = { header: 0, event: 0, none: 0 }
      ;(people || []).forEach(function (p) {
        if (!p) return
        var q = { id: p.id, role: p.role, label: p.label, activity: p.activity, model: p.model,
          lastEventAt: p.lastEventAt, parentId: p.parentId, depth: p.depth, projected: p.projected }
        var m = meta[String(p.id || '')] || null
        var t = (typeof p.createdAt === 'number' && p.createdAt > 0) ? p.createdAt : 0
        if (t) { q.createdAt = t; q.timeSource = 'header'; used.header += 1 }
        else if (m && typeof m.startedAt === 'number' && m.startedAt > 0) { q.createdAt = m.startedAt; q.timeSource = 'event'; used.event += 1 }
        else { q.createdAt = 0; q.timeSource = 'none'; used.none += 1 }
        if (m) {
          q.runId = String(m.runId || '')
          q.wfPhase = String(m.phase || '')
          q.wfLabel = String(m.label || '')
          q.settled = m.settled === true
          q.outcome = String(m.outcome || '')
        }
        out.push(q)
      })
      return { people: out, used: used }
    }

    /**
     * 对话流 workflow 卡把「阶段 → 成员」结构发到这里，面板据此画**任务人员流转图**：
     * 列 = 阶段（真实阶段顺序，来自 dsh 的 workflow-run 节点），卡 = 人（按角色聚合）。
     * 只有 workflow 卡渲染过才会有数据；没有时面板退回"依赖层"分列。
     */
    var wfPhaseStore = { name: '', phases: null, sig: '' }
    function publishWfPhases(name, phases) {
      var sig = ''
      try {
        sig = JSON.stringify([name, (phases || []).map(function (p) { return [p.key, (p.members || []).map(function (m) { return [m.childId, m.label, m.status] })] })])
      } catch (e) { sig = 'x' + Date.now() }
      if (sig === wfPhaseStore.sig) return
      wfPhaseStore = { name: name, phases: phases, sig: sig }
      notify()
    }
    function useWfPhases() { return useExternal(function () { return wfPhaseStore }) }
    function useDocked() { return useExternal(function () { return dockState }) }
    function usePanelPos() { return useExternal(function () { return panelPos }) }
    function usePanelWidth() { return useExternal(function () { return panelWidth }) }

    // ── i18n: follow the shell's document lang (zh/en) ──
    function detectLang() { try { var l = (document.documentElement.lang || '').toLowerCase(); return l.indexOf('zh') === 0 ? 'zh' : 'en' } catch (e) { return 'zh' } }
    var langListeners = new Set()
    var langNow = detectLang()
    function notifyLang() { langNow = detectLang(); langListeners.forEach(function (f) { try { f() } catch (e) {} }) }
    if (typeof MutationObserver !== 'undefined') { try { new MutationObserver(notifyLang).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] }) } catch (e) {} }
    function useLang() { var s = useState(detectLang()); useEffect(function () { function on() { s[1](detectLang()) } langListeners.add(on); return function () { langListeners.delete(on) } }, []); return s[0] }
    function t(zh, en) { return langNow === 'en' ? en : zh }

    function startResize(e, curW) {
      var startX = e.clientX, baseW = curW
      function onMove(ev) { setPanelWidth(baseW - (ev.clientX - startX)) }
      function onUp() { if (window.removeEventListener) { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) } }
      if (window.addEventListener) { window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp) }
      if (e.preventDefault) e.preventDefault()
    }
    function startDrag(e, curDock, curPos) {
      if (curDock) return
      var startX = e.clientX, startY = e.clientY, baseX = curPos.x, baseY = curPos.y
      function onMove(ev) { setPanelPos(baseX + (ev.clientX - startX), baseY + (ev.clientY - startY)) }
      function onUp() { if (window.removeEventListener) { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) } }
      if (window.addEventListener) { window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp) }
      if (e.preventDefault) e.preventDefault()
    }

    // Text is rendered by React as a text node, so React already escapes it.
    // Escaping here as well produced DOUBLE-escaped text on screen: a live-feed
    // line such as `cat x.yml; echo "=== dirs ===";` showed literal `&quot;`.
    // Kept as the identity (all call sites document "this is text, not markup";
    // there is no innerHTML/dangerouslySetInnerHTML anywhere in this client).
    function esc(s) { return String(s == null ? '' : s) }
    function basename(p) { var i = String(p).lastIndexOf('/'); return i >= 0 ? String(p).slice(i + 1) : String(p) }

    var PHASES = ['clarify', 'research', 'design', 'spec-review', '方案确认', 'implement', 'review', 'test', 'deliver']
    var PHASE_ZH = { clarify: '澄清', research: '调研', design: '设计', 'spec-review': '规格评审', '方案确认': '方案确认', implement: '实现', review: '审查', test: '测试', deliver: '交付' }
    function phaseLabel(p) { var zh = PHASE_ZH[p] || p; var en = { clarify: 'Clarify', research: 'Research', design: 'Design', 'spec-review': 'Spec Review', implement: 'Implement', review: 'Review', test: 'Test', deliver: 'Deliver' }[p] || p; return (p === '方案确认') ? (t('方案确认', 'Approve')) : (langNow === 'en' ? en : zh) }
    var ARTIFACT = ['SPEC', 'PLAN', 'RESEARCH', 'REVIEW-SPEC', 'REVIEW', 'TEST', 'SUMMARY', 'RETRO', 'TASK', '任务看板']
    var FINAL = ['completed', 'done', 'cancelled', 'failed']
    var ST_COLOR = { pending: '#9aa4b2', claimed: '#e0a83c', in_progress: '#3b6ef5', done: '#22b07d', rework: '#e05f45', blocked: '#8a6d00', failed: '#c0392b', cancelled: '#8a94a3', completed: '#22b07d' }
    function stColor(s) { return ST_COLOR[s] || '#9aa4b2' }
    function stBadgeCls(s) { return { pending: 'st-pending', claimed: 'st-claimed', in_progress: 'st-progress', done: 'st-done', completed: 'st-done', rework: 'st-rework', failed: 'st-failed', blocked: 'st-blocked', cancelled: 'st-cancelled' }[s] || '' }
    /**
     * 状态元数据（纯函数）：节点状态带 / 图例 / 描边都从这里取，保证"同一状态一个口径"。
     * 用户 2026-09-11 报障「状态给一个明显的展示，动态的」—— 此前节点上只有一个 4px 圆点，
     * 状态文字只存在于顶部图例里，看图得靠颜色猜。
     * @returns {key,label,color,tint,icon,active}
     */
    var DAG_STATUS_ORDER = ['pending', 'claimed', 'in_progress', 'done', 'rework', 'failed', 'blocked']
    // color = 描边/色条/图例点；band = 底部状态带底色（浅色状态单独加深，白字才够对比度）
    var DAG_STATUS_META = {
      pending: { color: '#9aa4b2', band: '#6f7b87', tint: '#ffffff', icon: '●' },
      claimed: { color: '#d9a13a', band: '#b5811f', tint: '#fffaf0', icon: '◆' },
      in_progress: { color: '#3b6ef5', band: '#2f5fd8', tint: '#f4f8ff', icon: '▶' },
      done: { color: '#22b07d', band: '#1c9268', tint: '#f2fbf7', icon: '✔' },  // completed 见下方归一
      rework: { color: '#e05f45', band: '#c74a30', tint: '#fff8f1', icon: '↻' },
      failed: { color: '#c0392b', band: '#a52c20', tint: '#fdf3f2', icon: '✕' },
      blocked: { color: '#8a6d00', band: '#6f5700', tint: '#fffdf2', icon: '■' },
      cancelled: { color: '#8a94a3', band: '#6d7885', tint: '#f7f8f9', icon: '⊘' },
    }
    function dagStatusMeta(status) {
      // completed 是 done 的别名：归一，避免同一个状态出现"完成/已完成"两种标签
      var raw = (status === 'completed') ? 'done' : (DAG_STATUS_META[status] ? String(status) : 'pending')
      var key = raw
      var m = DAG_STATUS_META[key]
      return { key: key, label: stLabel(key), color: m.color, band: m.band || m.color, tint: m.tint, icon: m.icon, active: (key === 'in_progress' || key === 'claimed') }
    }
    /** 图例顺序（pending 在前、blocked 在后；claimed 与 in_progress 分开，因为"已领取"是真实中间态）。 */
    function dagStatusOrder() { return DAG_STATUS_ORDER.slice() }
    /** 各状态任务数（图例上的实时计数）；completed 合并到 done。 */
    function dagStatusCounts(tasks) {
      var out = {}
      ;(Array.isArray(tasks) ? tasks : []).forEach(function (t) {
        var k = dagStatusMeta(t && t.status).key
        if (k === 'completed') k = 'done'
        out[k] = (out[k] || 0) + 1
      })
      return out
    }
    /**
     * 状态**变更**检测（纯函数）：返回"刚刚变化、值得闪一下"的任务 id。
     * 为什么要它：面板每 2.5s 轮询，状态是**跳变**的；不闪的话用户盯着图也看不出刚才是谁
     * 从"待开始"变成"进行中"、谁完成了（用户要的"动态的"）。
     * 首次见到某任务只登记、不闪烁（否则打开面板时满屏乱闪）。
     * @param tasks - 当前任务数组
     * @param now - 当前时刻（ms；显式传入便于测试）
     * @param windowMs - 变更后保持闪烁的时长（默认 1500ms）
     * @param prev - 上一次的 snapshot（不传则视为首次）
     * @returns {flash:{id:true}, snapshot:{id:{status,at}}}
     */
    function dagStatusFlash(tasks, now, windowMs, prev) {
      var t0 = Number(now) || 0
      var win = Number(windowMs) > 0 ? Number(windowMs) : 1500
      var before = (prev && typeof prev === 'object') ? prev : {}
      var snap = {}, flash = {}
      ;(Array.isArray(tasks) ? tasks : []).forEach(function (t) {
        var id = String((t && t.id) || ''); if (!id) return
        var st = String((t && t.status) || '')
        var old = before[id]
        if (old === undefined) { snap[id] = { status: st, at: 0 }; return }
        if (old.status !== st) { snap[id] = { status: st, at: t0 }; flash[id] = true; return }
        var at = Number(old.at) || 0
        snap[id] = { status: st, at: at }
        if (at && t0 - at <= win) flash[id] = true
      })
      return { flash: flash, snapshot: snap }
    }
    /** 本轮 dagSvg 渲染要闪烁的 id 与状态快照（由 dagSvg 内部刷新）。 */
    var DAG_FLASH = {}
    var DAG_STATUS_SNAP = {}

    function stLabel(s) { var m = { pending: ['待开始', 'Pending'], claimed: ['已领取', 'Claimed'], in_progress: ['进行中', 'In progress'], done: ['已完成', 'Done'], rework: ['待返工', 'Rework'], blocked: ['受阻', 'Blocked'], failed: ['失败', 'Failed'], cancelled: ['取消', 'Cancelled'], completed: ['完成', 'Complete'] }[s]; return m ? (langNow === 'en' ? m[1] : m[0]) : s }
    // run 级状态（STATE.json 的 status）——与任务状态分开，running/complete/…
    var STATUS_ZH = { running: ['进行中', 'running'], complete: ['已完成', 'complete'], completed: ['已完成', 'completed'], done: ['已完成', 'done'], failed: ['失败', 'failed'], cancelled: ['已取消', 'cancelled'], canceled: ['已取消', 'canceled'], idle: ['空闲', 'idle'], paused: ['已暂停', 'paused'], blocked: ['受阻', 'blocked'], draft: ['草稿', 'draft'] }
    function statusLabel(s) { if (s == null || s === '') return ''; var m = STATUS_ZH[s]; return m ? (langNow === 'en' ? m[1] : m[0]) : String(s) }
    // 任务类型（TASKS.json 的 kind）——必须覆盖 host 的 KIND_ZH 全部键，否则面板会漏出英文 id
    var KIND_ZH = { work: ['任务', 'work'], requirements: ['需求', 'requirements'], research: ['调研', 'research'], design: ['设计', 'design'], implementation: ['编码实现', 'implementation'], verification: ['验证测试', 'verification'], review: ['代码审查', 'review'], repair: ['返工修复', 'repair'], integration: ['集成', 'integration'], quality: ['质量自检', 'quality'], docs: ['文档', 'docs'], security: ['安全审计', 'security'], data: ['数据', 'data'], test: ['测试', 'test'] }
    function kindLabel(k) { var m = KIND_ZH[k]; return m ? (langNow === 'en' ? m[1] : m[0]) : (k || t('任务', 'work')) }
    // 裁决（verdict）
    var VERDICT_ZH = { pass: ['通过', 'pass'], approved: ['已通过', 'approved'], needs_revision: ['需修订', 'needs-revision'], reject: ['驳回', 'reject'], rejected: ['驳回', 'rejected'], fail: ['未通过', 'fail'], failed: ['未通过', 'failed'], pending: ['待判定', 'pending'], none: ['—', '—'] }
    function verdictLabel(v) { var m = VERDICT_ZH[v]; return m ? (langNow === 'en' ? m[1] : m[0]) : String(v == null ? '' : v) }
    var ROLE_LABEL = { pm: ['产品', 'PM'], architect: ['架构', 'Arch'], researcher: ['调研员', 'Research'], ui: ['UI 设计师', 'UI Design'], backend: ['后端', 'Backend'], frontend: ['前端', 'Frontend'], dba: ['数据工程师', 'Data'], sec: ['安全审计员', 'Security'], reviewer: ['评审员', 'Review'], qa: ['测试员', 'QA'], devops: ['运维', 'DevOps'], docs: ['文档工程师', 'Docs'] }
    function roleLabel(r) { var m = ROLE_LABEL[r]; return m ? (langNow === 'en' ? m[1] : m[0]) : r }
    /**
     * 文本 → 角色（纯函数，便于单测）。镜像 host 侧 SUB_ROLE_WORDS 的关键词序：
     * 动态角色在前（「产品分析」与「产品经理」会重叠）。
     *
     * 为什么要它：workflow 派生的子代理在 host 侧常解析不出角色（descriptor label 为空、
     * 子会话日志经 seam 读不到），于是面板如实把它们列为「未匹配到角色」（用户实测看到 22 个）。
     * 但对话流 workflow 卡上每个成员是有 label 的（publishWfPhases 收了 m.label），
     * 那里通常带着角色线索 —— 这就是补解析的来源。
     */
    var WF_ROLE_WORDS = [
      ['competitive-analyst', ['competitive', '竞品', '对标']],
      ['product-analyst', ['product-analyst', '产品分析', '收益成本', '差距分析']],
      ['pm', ['pm', '产品经理', '澄清', '起草', 'ultra spec', '需求', '规格']],
      ['architect', ['architect', '架构', 'chief', '接口契约']],
      ['researcher', ['research', '调研', '研究员', 'researcher', 'investigate', '现状']],
      ['backend', ['backend', '后端']],
      ['dba', ['dba', '数据', 'sql', 'ddl', '迁移', 'database', '表结构']],
      ['frontend', ['frontend', '前端', 'uni-app', 'uniapp']],
      ['ui', ['ui', '视觉', '界面', '走查', '设计', 'designer', 'design']],
      ['reviewer', ['review', '评审', '审查']],
      // '重测'/'test': workflow legs are labelled 「[重测] test-2 …」「[终局重测] test-3 …」;
      // neither contains 测试, so without these every verification leg stayed role-less.
      // Keep in sync with SUB_ROLE_WORDS in lib/command.js.
      ['qa', ['qa', '测试', '重测', 'test', '验证']],
      ['sec', ['sec', '安全', '越权', '注入', '渗透', 'security']],
      ['devops', ['devops', '部署', '构建', 'cicd', '环境', '运维', '发布']],
      ['docs', ['docs', '文档', 'readme', '手册']],
    ]
    /**
     * 规范中文角色标签 → 角色 id（2026-09-11 起 prompt 与派工 label 用中文标签）。
     * **必须与 host 侧 `lib/vocab.js` 的 `ROLE_LABELS_ZH`（@ :82）保持同步**：两边解析同一批
     * `【产品经理】…` / `[测试员] 任务` 文本，任一侧漏掉就会让浮层把成员列成「未匹配到角色」。
     * 取值 = 浮层显示名（本文件 `ROLE_TOOL` 的 nm），避免同一角色两套叫法。
     */
    var ROLE_LABELS_ZH = { '产品经理': 'pm', '架构师': 'architect', '研究员': 'researcher', 'ui设计师': 'ui', '后端工程师': 'backend', '前端工程师': 'frontend', '数据工程师': 'dba', '安全审计员': 'sec', '审查官': 'reviewer', '测试员': 'qa', '运维': 'devops', '文档工程师': 'docs', '竞品分析师': 'competitive-analyst', '产品分析员': 'product-analyst', 'UI 验证专家': 'ui-verifier', '故障诊断工程师': 'debugger' }
    /** 标签归一：去空白（含全角空格）与大小写 ⇒ `UI 设计师` / `ui设计师` 等价。 */
    function roleLabelKey(s) { return String(s == null ? '' : s).replace(/[\s\u3000]+/g, '').toLowerCase() }
    /**
     * 档位中文标签（G 线档位徽标用）。
     * **必须与 host 侧 `lib/tier.js` 的 `TIER_LABELS_ZH` 逐字一致** —— client 是
     * `__ModuleLoader__` 工厂、不能 import，所以又是一份"搬不动的副本"；
     * `tier-badge.test.mjs` 会拿两侧的值逐字比对（缺一项就红）。
     */
    var TIER_LABELS_ZH = { quick: '快速档', standard: '标准档', strict: '严格档' }
    /**
     * 档位徽标：认得的档位返回 `🎚快速档`，**认不出/缺省一律返回空串**。
     * 为什么认不出要空而不是退回原值：把 `涡轮档`、`undefined`、`1` 直接画到面板上
     * 比"不显示"更糟 —— 那是把脏数据当事实展示（与 host 侧 `normalizeTier` 拒绝非法值同一纪律）。
     */
    function tierBadge(tier) {
      var key = String(tier == null ? '' : tier).trim().toLowerCase()
      return Object.prototype.hasOwnProperty.call(TIER_LABELS_ZH, key) ? ('🎚' + TIER_LABELS_ZH[key]) : ''
    }
    /**
     * 损坏 run 的徽标文案（**唯一出口**）：`health === 'broken'` 时给出显式标记，
     * 否则返回空串（正常 run 由 phase/status 渲染，不在此处插手）。
     * 为什么缺 STATE.json 的 run 必须**显式**标出来：`/state` 的 `runs[]` 里这类目录的
     * `phase`/`status` 都是空串 ⇒ 面板会渲染成 `/ · 0/0`、下拉渲染成 `2026-09-17-160412 ()`，
     * 用户看不出这是"坏了"，只会以为面板自己出了故障。文案与 host 侧 `lib/command.js` 的
     * `⛔ 损坏：` 逐字对齐，避免同一个事实在两侧两套词表。
     */
    function runHealthBadge(r) {
      var h = (r && r.health) || ''
      if (h !== 'broken') return ''
      var why = (r && r.healthReason) || t('缺 STATE.json（或不可解析）', 'missing STATE.json')
      return t('⛔ 损坏 · ' + why, '⛔ broken · ' + why)
    }
    function roleFromText(text) {
      var hay = String(text || '')
      if (!hay) return ''
      var low = hay.toLowerCase()
      // ① 英文 id 写在括号/【】里（历史写法）：`（researcher，一次性）` / `【researcher】…`
      var m = low.match(/[（(【[]\s*([a-z][a-z0-9-]{1,24})\s*[，,、)）】\]]/)
      if (m && m[1]) return m[1]
      // ② 中文标签（2026-09-11 起主用写法）：`【产品经理】…`。**只有精确命中标签表才算角色**
      //    —— 自由散文里的括号（「（非实验性）」）仍然被拒绝。
      var zh = hay.match(/[（(【[]\s*([^，,、()（）【】\[\]]{1,32}?)\s*[，,、)）】\]]/)
      if (zh) { var hit = ROLE_LABELS_ZH[roleLabelKey(zh[1])]; if (hit) return hit }
      // ③ 关键词兜底（表序先命中先赢；动态角色在前）
      for (var i = 0; i < WF_ROLE_WORDS.length; i++) {
        var role = WF_ROLE_WORDS[i][0], words = WF_ROLE_WORDS[i][1]
        for (var j = 0; j < words.length; j++) if (low.indexOf(words[j]) >= 0) return role
      }
      return ''
    }

    /**
     * 活子代理 → 角色 的三源合并（纯函数，便于单测）：
     *   ① members[role].id   —— host enrichMembers 的权威绑定（lead 回写 STATE.members 时最准）
     *   ② agents[].role      —— host 按 label / 括号角色 id / 首条 prompt 三级推断的结果
     *   ③ workflow 卡成员 label —— ② 拿不到时的兜底（卡上有 label 而子代理 descriptor 没有）
     * @returns {byRole, byId, matched, unmatched, dispatched, wfRole}
     */
    function resolveAgentRoles(members, roles, agentsLive, wfPhases) {
      // 加固：本函数在**面板渲染路径**上，任何字段形状不符都**不得抛错**（否则整个浮层白屏）。
      // 全部入口先做 Array.isArray / typeof 归一化。
      var agentList = Array.isArray(agentsLive) ? agentsLive : []
      var roleList = Array.isArray(roles) ? roles : []
      var memMap = (members && typeof members === 'object' && !Array.isArray(members)) ? members : {}
      var phaseList = (wfPhases && Array.isArray(wfPhases.phases)) ? wfPhases.phases : []
      var byId = {}
      agentList.forEach(function (a) { if (a && a.id) byId[String(a.id)] = a })
      var wfRole = {}
      phaseList.forEach(function (p) {
        var mem = (p && Array.isArray(p.members)) ? p.members : []
        mem.forEach(function (mm) {
          var cid = mm && mm.childId
          if (!cid) return
          var r = roleFromText(mm.label)
          if (r && !wfRole[String(cid)]) wfRole[String(cid)] = r
        })
      })
      var byRole = {}, matched = {}, dispatched = 0
      roleList.forEach(function (r) {
        var mm2 = memMap[r]
        if (mm2 && typeof mm2 === 'object' && mm2.id) { byRole[r] = String(mm2.id); matched[String(mm2.id)] = 1; dispatched += 1; return }
        // 排除**已被认领**的 agent，避免同一 agent 被两个角色同时选中
        var a2 = agentList.filter(function (x) { return x && x.role && String(x.role) === String(r) && !matched[String(x.id)] })[0]
        if (a2) { byRole[r] = String(a2.id); matched[String(a2.id)] = 1; dispatched += 1; return }
        var cid2 = Object.keys(wfRole).filter(function (c) { return wfRole[c] === String(r) && !matched[c] && byId[c] })[0]
        if (cid2) { byRole[r] = cid2; matched[cid2] = 1; dispatched += 1 }
      })
      var unmatched = agentList.filter(function (a) { return a && a.id && !matched[String(a.id)] })
      // 「没被匹配」≠「解析不出角色」：一个角色在面板上只展示 1 个成员，而同一角色常被派工
      // 多次（实测本会话 30 个活子代理 / 14 个角色 ⇒ 必然有一大批"多余的同角色 leg"）。
      // 把它们说成"未能解析出角色"是错的，分开统计。
      var roleless = unmatched.filter(function (a) { return !(a && a.role) })
      var extraByRole = {}
      unmatched.forEach(function (a) { if (a && a.role) extraByRole[a.role] = (extraByRole[a.role] || 0) + 1 })
      return { byRole: byRole, byId: byId, matched: matched, unmatched: unmatched, roleless: roleless, extraByRole: extraByRole, dispatched: dispatched, wfRole: wfRole }
    }

    // ── 对话流角色化工具卡：为每个 subagent_<role> 工具注册 tool.call.toolview ──
    // 用户在主对话流直接看到「派 XX 调研」的编排动作（运行中/完成状态卡片）。
    var ROLE_TOOL = {
      subagent_pm: ['👨‍💼', '产品经理', '需求澄清 · Ultra Spec'],
      subagent_architect: ['🏗️', '架构师', '接口契约 · 技术选型'],
      subagent_researcher: ['🔎', '研究员', '项目调研 · 竞品分析'],
      subagent_ui: ['🎨', 'UI 设计师', '设计规范 · 交互稿'],
      subagent_backend: ['🖥️', '后端工程师', '后端实现'],
      subagent_frontend: ['💻', '前端工程师', '前端实现'],
      subagent_dba: ['🗄️', '数据工程师', '数据契约 · 迁移'],
      subagent_sec: ['🛡️', '安全审计员', '权限 · 越权 · 注入'],
      subagent_reviewer: ['🕵️', '审查官', '代码审查 · 验收质量'],
      subagent_qa: ['🧪', '测试员', '用例 · 回归验证'],
      subagent_devops: ['🚀', '运维', '构建 · 部署 · CI'],
      subagent_docs: ['📖', '文档工程师', '手册 · README · API']
    }
    /**
     * 角色卡状态判定（纯函数；`tool-card-status.test.mjs` 抽源码直测 + 变异验证）。
     *
     * 为什么单独抽出来：`settled`（工具调用已返回）**不等于**任务完成。可继续委派
     * （`backgroundMode: continuable`）下 `subagent_<role>` 几乎立刻返回
     * `started subagent <id>`（dsh-tool-subagent 实测文本），而子代理随后仍在跑 ——
     * 旧实现拿 `settled` 当完成标记，于是**正在运行的任务卡显示 ✅完成**
     * （用户 2026-09-11 报障：卡上 ✅完成，同一角色在子代理列表里 3分39秒 · 正在运行）。
     *
     * 判据：① 工具调用在飞（有 `callId` 且无 `kind`）⇒ 进行中；② 调用已返回、结果里带
     * 子代理 id、且该 id 在 `/state` 的 `data.agents` 里仍 `activity === 'running'` ⇒ 进行中。
     * 拿不到 id 或 id 已不在活子代理里 ⇒ 按调用结果结算（✅完成 / ❌失败），与旧行为一致。
     *
     * @param block - 工具调用块（`{kind, callId, isError}`）
     * @param out - 结算文本（可继续委派为 `started subagent <id>`）
     * @param liveAgents - `/state` 的 `data.agents`（`[{id, activity, ...}]`），可为 null
     * @returns `{settled, running, isErr, isRunning, childId, liveAgent, statusText}`
     */
    function roleCardState(block, out, liveAgents) {
      var b = block || {}
      var settled = b.kind === 'tool-result'
      var inFlight = !!b.callId && !b.kind
      var isErr = settled && !!b.isError
      var text = String(out == null ? '' : out)
      var childId = ''
      if (settled) {
        var m = /started (?:background )?subagent (?:job )?([0-9a-z-]{8,})/i.exec(text)
        if (m) childId = m[1]
      }
      var liveAgent = null
      if (childId && Array.isArray(liveAgents)) {
        for (var i = 0; i < liveAgents.length; i++) {
          var a = liveAgents[i]
          if (a && String(a.id) === childId) { liveAgent = a; break }
        }
      }
      var liveRunning = !!liveAgent && String(liveAgent.activity || '') === 'running'
      var isRunning = inFlight || liveRunning
      return {
        settled: settled, running: inFlight, isErr: isErr, isRunning: isRunning,
        childId: childId, liveAgent: liveAgent,
        statusText: isRunning ? '⏳ 进行中' : (isErr ? '❌ 失败' : '✅ 完成')
      }
    }

    function RoleToolView(props) {
      var meta = ROLE_TOOL[(props && props.toolName) || ''] || [null, (props && props.toolName) || '成员', '']
      var em = meta[0], nm = meta[1], duty = meta[2]
      // 活子代理状态来自共享轮询（HeaderButton/LiveCapsule 同一份，单例；无订阅者即停）。
      // 必须有会话 id 才认这份数据：否则宁可按旧口径结算，也不拿别的会话的状态下判断。
      var sid = useCurrentSession()
      var live = useLiveState(sid)
      var block = (props && props.block) || {}
      var argsRaw = block.argsRaw || (block.call && block.call.argsRaw) || ''
      var label = '', prompt = ''
      try {
        var a = JSON.parse(argsRaw)
        if (a && typeof a === 'object') { label = a.label || ''; prompt = String(a.prompt || a.task || a.message || '') }
        else if (a) prompt = String(a)
      } catch (e) { prompt = String(argsRaw).slice(0, 160) }
      var out = ''
      if (block.kind === 'tool-result' && Array.isArray(block.content)) {
        out = block.content.map(function (c) { var t2 = (c && typeof c === 'object') ? (c.text || c.content || '') : String(c || ''); return t2 }).join(' ').replace(/\s+/g, ' ').trim()
      }
      // 状态判定：工具调用「已返回」≠「任务完成」（可继续委派下调用秒返、子代理仍在跑）。
      var st = roleCardState(block, out, (sid && live && live.agents) ? live.agents : null)
      // 子代理 id 一出现就立刻刷一次共享轮询：避免最长 2.5s 的「先 ✅完成、后跳 ⏳进行中」抖动。
      useEffect(function () { if (st.childId) { try { liveTick() } catch (e) {} } }, [st.childId])
      // 点卡片本体 → 不跳页面、不切视图：把该角色的任务详情渲染到**右侧面板**。
      var roleId = String((props && props.toolName) || '').replace(/^subagent[_-]?/, '')
      function focusRight(e) {
        try {
          if (e && e.stopPropagation) e.stopPropagation()
          requestFocus({ kind: 'role', role: roleId })
          focusPanelRight()
        } catch (err) {}
      }
      return h('div', { className: 'et-tc' + (st.isRunning ? ' run' : '') + (st.isErr ? ' err' : ''), onClick: focusRight, title: t('点击在右侧面板查看该角色任务详情', 'Click to open this role\u2019s task detail in the right panel') },
        h('div', { className: 'et-tc-h' },
          h('span', { className: 'et-tc-ava' }, em || '🤖'),
          h('span', { className: 'et-tc-nm' }, esc(nm)),
          h('span', { className: 'et-tc-duty' }, esc(duty)),
          h('span', { className: 'et-tc-st' + (st.isRunning ? '' : (st.isErr ? ' e' : ' done')) }, esc(st.statusText))),
        // 名称（label）**不截断**：它是这张卡「谁在干什么」的身份，截了用户就认不出来
        // （用户 2026-09-11 报障）。只有 prompt 预览按显示宽度截断，且截断处**补省略号**
        // （clipText：CJK 记 2 单位）—— 旧实现 `String(prompt).slice(0, 90)` 是硬切且无省略号，
        // 句子断在半截，看起来正是「名称没有显示完」。
        (label || prompt) ? h('div', { className: 'et-tc-t' }, esc(label ? String(label) + (prompt ? ' — ' + clipText(prompt, 120) : '') : clipText(prompt, 200))) : null,
        st.settled ? h('div', { className: 'et-tc-f' }, esc(
          st.isRunning && st.childId ? t('⏳ 子代理运行中 · ', '⏳ subagent running · ') + st.childId + t('（点「调用详情」看实时状态）', ' (open call detail for live status)')
            : st.childId ? t('✅ 子代理已结算 · ', '✅ subagent settled · ') + st.childId
              : clipText(out || t('· 已完成（展开调用查看结果）', '· done (expand to view)'), 200))) : null,
        h('div', { className: 'et-tc-b' },
          h('button', { onClick: function (e) { try { if (e && e.stopPropagation) e.stopPropagation(); if (!open) { dockState = true; saveLS('et-dock', true); notify(); setOpen() } } catch (err) {} } }, esc('🧑‍🔬 团队浮层')),
          props && props.inspect ? h('button', { onClick: function (e) { try { if (e && e.stopPropagation) e.stopPropagation(); props.inspect() } catch (err) {} } }, esc('🔍 调用详情')) : null))
    }

    // ── 对话流 workflow 运行卡（接管 dsh 原生 `conversation.chat.node` / key=workflow-run）──
    // 为什么接管：dsh 原生卡把成员行硬接成 `ctx.sessions.open(childId)`（打开新标签页），
    // 且它的 `openSession` 来自该条目自己的 inject —— 外部无法只替换点击行为；
    // renderer 的规则是「每个 slot cell 取 order 最小的存活条目」，所以本插件用 order:-1
    // 成为该 cell 的赢家，渲染同构的卡但把点击改为「保留当前对话页 + 右侧面板看实时细节」。
    // 可逆：localStorage['et-native-workflow']='1' 时不注册（回退原生卡，刷新生效）。
    var WF_STATUS_ZH = { running: ['运行中', 'running'], completed: ['已完成', 'completed'], failed: ['失败', 'failed'], cancelled: ['已取消', 'cancelled'], interrupted: ['已中断', 'interrupted'], pending: ['等待', 'pending'], queued: ['排队', 'queued'], paused: ['已暂停', 'paused'] }
    function wfStatusLabel(s) { var m = WF_STATUS_ZH[s]; return m ? (langNow === 'en' ? m[1] : m[0]) : String(s || '') }
    function wfDotColor(s) { return s === 'running' ? '#0969da' : s === 'completed' ? '#1a7f37' : (s === 'failed' || s === 'interrupted') ? '#cf222e' : '#9aa4b2' }
    function wfPhases(node) {
      var out = []
      var phases = (node && node.data && Array.isArray(node.data.phases)) ? node.data.phases : []
      for (var i = 0; i < phases.length; i++) {
        var ph = phases[i] || {}
        out.push({ key: String(ph.key || ph.name || ('#' + (i + 1))), members: Array.isArray(ph.members) ? ph.members : [] })
      }
      return out
    }
    function WorkflowRunCard(props) {
      useLang()
      var node = (props && props.node) || {}
      var data = (node && node.data) || {}
      var phases = wfPhases(node)
      var name = String(data.name || node.name || t('工作流运行', 'Workflow run'))
      var status = String(data.status || '')
      var total = 0, runningN = 0
      phases.forEach(function (p) { p.members.forEach(function (m) { total += 1; if (m && m.status === 'running') runningN += 1 }) })
      var oS = useState(true); var open = oS[0], setOpen = oS[1]
      // 把阶段结构发给面板（effect 内发布，避免渲染期 notify）
      useEffect(function () { publishWfPhases(name, phases) }, [node])
      function focusMember(m) { try { requestFocus({ kind: 'agent', agentId: String(m.childId || ''), label: String(m.label || '') }); focusPanelRight() } catch (e) {} }
      var rows = []
      phases.forEach(function (p) {
        rows.push(h('div', { key: 'ph-' + p.key, style: { display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 2px', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary,#57606a)' } },
          h('span', null, '▸ ' + esc(p.key)), h('span', null, '· ' + p.members.length + t(' 个成员', ' members'))))
        p.members.forEach(function (m, i) {
          var lab = String((m && m.label) || '').trim() || (String((m && m.childId) || '').slice(0, 8) || t('（未命名）', '(unnamed)'))
          rows.push(h('div', {
            key: 'm-' + p.key + '-' + i,
            onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); focusMember(m) },
            title: t('点击在右侧面板查看该成员实时细节（不跳转）', 'Click to inspect this member in the right panel (no navigation)'),
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderTop: '1px dashed var(--dsw-alias-border-l1,#eef1f5)', cursor: 'pointer', fontSize: 12.5 }
          },
            h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: wfDotColor(m && m.status), flex: 'none' } }),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, esc(lab)),
            h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary,#57606a)', fontSize: 11.5 } }, esc(wfStatusLabel(m && m.status)))))
        })
      })
      return h('div', { style: { margin: '6px 0', border: '1px solid var(--dsw-alias-border-l2,var(--border,#d0d7de))', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1,var(--bg,#fff))', fontSize: 12.5, color: 'var(--dsw-alias-label-primary,#1f2328)', overflow: 'hidden' } },
        h('div', { onClick: function () { setOpen(!open) }, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer' } },
          h('span', null, open ? '▾' : '▸'),
          h('b', { style: { fontWeight: 600 } }, esc(name)),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary,#57606a)' } }, '· ' + total + t(' 个成员', ' members')),
          h('span', { style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--dsw-alias-label-secondary,#57606a)' } },
            h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: wfDotColor(status) } }),
            esc(wfStatusLabel(status) + (runningN ? ' · ' + runningN + t(' 进行中', ' running') : '')))),
        open ? h('div', { style: { padding: '0 10px 8px' } },
          rows.length ? rows : h('div', { style: { color: 'var(--dsw-alias-label-secondary,#57606a)', padding: '4px 0' } }, t('（暂无成员）', '(no members)')),
          h('div', { style: { marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary,#57606a)' } }, t('点击成员 → 右侧面板显示其实时细节（不跳页）', 'Click a member to inspect it in the right panel (no navigation)'))) : null)
    }

    // Normalize old/mixed-format task fields: verify/changedPaths/dependsOn/
    // findings may be a STRING in legacy runs — always work with arrays.
    function arrOf(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]) }
    function strOf(v) { return v == null ? '' : String(v) }

    function verdictBadge(v) {
      if (!v || v === 'pending' || v === 'none') return null
      var cls = v === 'pass' ? 'v-pass' : (v === 'needs_revision' || v === 'reject' ? 'v-fail' : 'v-rev')
      var label = verdictLabel(v)
      return h('span', { className: 'exp-badge ' + cls }, esc(label))
    }

    // ── interactive SVG task DAG ──
    var NODE_W = 168, NODE_H = 64, HGAP = 46, VGAP = 10

    /**
     * SVG 没有 CSS ellipsis：按显示宽度近似截断（CJK 记 2 个单位、其余记 1）。
     * 用于把「任务标题」放进卡片可见行 —— 超宽就省略，绝不撑破节点。
     */
    function clipText(v, maxUnits) {
      var str = String(v == null ? '' : v)
      var used = 0, out = ''
      for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i)
        var w = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1
        if (used + w > maxUnits) return (out || str.charAt(0)) + '…'
        used += w; out += ch
      }
      return out
    }

    /**
     * 任务绑定推断（纯函数，便于单测与变异验证）。
     *
     * 背景：**真实 TASKS.json 不记录 agentId**，而早期实现只按 agentId 精确匹配
     * ⇒ 面板里**每一个人都显示「未绑定任务」**（用户实测报障）。
     *
     * 两段式：
     *   ① 权威：task.agentId === person.id（tasksLive 投影 / lead 回写时存在）
     *   ② 推断：task.owner === person.role + **状态亲和**（在跑→in_progress/claimed；
     *      已结束→completed/done），再按 round 取最近一轮。
     * 推断命中的 id 写入 inferredOut，UI 据此用「~」前缀**明确标注是推断**，不冒充精确。
     * @returns 绑定的任务；无候选时 null（此时 UI 才显示「未绑定任务」）
     */
    function bindTaskFor(person, tasks, inferredOut) {
      var p = person || {}
      var list = Array.isArray(tasks) ? tasks : []
      var hit = null
      list.forEach(function (tk) { if (!hit && tk && tk.agentId && String(tk.agentId) === String(p.id)) hit = tk })
      if (hit) return hit
      if (!p.role) return null
      var mine = list.filter(function (tk) { return tk && String(tk.owner || '') === String(p.role) })
      if (!mine.length) return null
      var running = p.activity === 'running'
      var want = running ? ['in_progress', 'claimed'] : ['completed', 'done']
      var pref = mine.filter(function (tk) { return want.indexOf(String(tk.status || '')) >= 0 })
      var pool = (pref.length ? pref : mine).slice().sort(function (a, b) { return (Number(b.round) || 1) - (Number(a.round) || 1) })
      var pick = pool[0]
      if (pick && inferredOut) inferredOut[String(pick.id)] = 1
      return pick
    }

    function dagLayout(tasks) {
      var byId = {}; tasks.forEach(function (t) { byId[t.id] = t })
      var layer = {}
      function compute(id) { if (id in layer) return layer[id]; var t = byId[id]; if (!t) return 0; var deps = arrOf(t.dependsOn).filter(function (d) { return byId[d] }); layer[id] = deps.length ? 1 + Math.max.apply(null, deps.map(compute)) : 0; return layer[id] }
      tasks.forEach(function (t) { compute(t.id) })
      var cols = []; tasks.forEach(function (t) { var L = layer[t.id] || 0; (cols[L] = cols[L] || []).push(t) })
      var pos = {}; var width = 0, height = 0
      cols.forEach(function (col, li) { col.forEach(function (t, i) { var x = li * (NODE_W + HGAP); var y = i * (NODE_H + VGAP); pos[t.id] = { x: x, y: y, L: li }; width = Math.max(width, x + NODE_W); height = Math.max(height, y + NODE_H) }) })
      return { byId: byId, pos: pos, width: width || NODE_W, height: height || NODE_H }
    }
    var DAG_RENDER_SEQ = 0
    function dagSvg(tasks, onPick, selId, hoverId, onHover) {
      if (!tasks.length) return h('div', { className: 'exp-empty' }, t('（暂无任务）', '(no tasks)'))
      var L = dagLayout(tasks)
      var childOf = {}, parentOf = {}
      tasks.forEach(function (t) { arrOf(t.dependsOn).forEach(function (d) { if (L.pos[d]) { (parentOf[t.id] = parentOf[t.id] || []).push(d); (childOf[d] = childOf[d] || []).push(t.id) } }) })
      // highlight set = hoverId + upstream + downstream
      var hot = {}
      if (hoverId) {
        hot[hoverId] = 1
        ;(function walk(seed, next) { var q = [seed]; while (q.length) { var id = q.shift(); (next[id] || []).forEach(function (n) { if (!hot[n]) { hot[n] = 1; q.push(n) } }) } })(hoverId, parentOf)
        ;(function walk(seed, next) { var q = [seed]; while (q.length) { var id = q.shift(); (next[id] || []).forEach(function (n) { if (!hot[n]) { hot[n] = 1; q.push(n) } }) } })(hoverId, childOf)
      }
      var edges = []
      tasks.forEach(function (t) { arrOf(t.dependsOn).forEach(function (d) { if (L.pos[d]) edges.push([d, t.id]) }) })
      var edgeEls = edges.map(function (e, i) {
        var a = L.pos[e[0]], b = L.pos[e[1]]; var x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2; var mx = (x1 + x2) / 2
        var on = hoverId && hot[e[0]] && hot[e[1]]
        var run = (L.byId[e[0]] && (L.byId[e[0]].status === 'in_progress' || L.byId[e[0]].status === 'claimed')) || (L.byId[e[1]] && (L.byId[e[1]].status === 'in_progress' || L.byId[e[1]].status === 'claimed'))
        return h('path', { key: i, className: on ? 'exp-edge-run' : (run ? 'exp-edge-run' : ''), d: 'M' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2, stroke: on ? '#0969da' : '#8aa8e8', strokeWidth: on ? 2 : 1.4, opacity: (hoverId && !on) ? 0.35 : 1, fill: 'none' })
      })
      // 状态"变更即闪"：面板每 2.5s 轮询，状态是跳变的，闪烁让用户看见"刚刚谁变了"。
      // 首次见到只登记不闪（打开面板时不该满屏乱闪）。
      var fl = dagStatusFlash(tasks, Date.now(), 1500, DAG_STATUS_SNAP)
      DAG_FLASH = fl.flash; DAG_STATUS_SNAP = fl.snapshot
      var dagSeq = (DAG_RENDER_SEQ += 1)
      var BAR_H = 15
      var nodeEls = tasks.map(function (t, ti) {
        var p = L.pos[t.id]; if (!p) return null
        var meta = dagStatusMeta(t.status)
        var col = meta.color
        var sel = selId === t.id
        var hl = hoverId && hot[t.id]
        var dim = hoverId && !hl
        var run = meta.active
        var flash = !!DAG_FLASH[t.id]
        var clipId = 'dagclip-' + dagSeq + '-' + ti
        var title = String(t.title || t.spec || (t.acceptance && t.acceptance[0]) || '（无标题）')
        var metaLine = kindLabel(t.kind || 'work') + (t.owner ? ' · ' + roleLabel(t.owner) : '') + (t.verdict ? ' · ' + verdictLabel(t.verdict) : '')
        var roundTag = (Number(t.round) > 1 || Number(t.attempt) > 1) ? ('r' + (Number(t.round) || 1) + '·a' + (Number(t.attempt) || 1)) : ''
        return h('g', { key: t.id, className: 'exp-node', onClick: function () { onPick(t) }, onMouseEnter: function () { onHover && onHover(t.id) }, onMouseLeave: function () { onHover && onHover(null) }, transform: 'translate(' + p.x + ' ' + p.y + ')', opacity: dim ? 0.4 : 1 },
          h('defs', null, h('clipPath', { id: clipId }, h('rect', { width: NODE_W, height: NODE_H, rx: 9 }))),
          // 卡片主体（裁进圆角）：状态色柔底 + 左侧状态色条 + 底部**状态带**（明显的状态展示）
          h('g', { 'clip-path': 'url(#' + clipId + ')' },
            h('rect', { width: NODE_W, height: NODE_H, fill: sel ? '#eef4ff' : (hl ? '#f2f7ff' : meta.tint) }),
            h('rect', { x: 0, y: 0, width: 4, height: NODE_H, fill: col }),
            h('rect', { className: 'exp-node-bar' + (run ? ' exp-node-bar-run' : ''), x: 4, y: NODE_H - BAR_H, width: NODE_W - 4, height: BAR_H, fill: meta.band })),
          // 描边：状态色；选中=业务蓝；运行中脉冲；刚变更过闪一下
          h('rect', { className: 'exp-node-bg' + (run ? ' exp-node-run' : '') + (flash ? ' exp-node-flash' : ''), width: NODE_W, height: NODE_H, rx: 9, fill: 'none', stroke: sel ? '#0969da' : col, strokeWidth: sel || hl ? 2 : 1.6 }),
          h('text', { x: 12, y: 15, 'font-size': 11, 'font-weight': 700, 'fill': '#1f2328' }, esc(clipText(String(t.id || ''), 20))),
          // 「具体干了什么」：任务标题提到**可见行**（此前只藏在 <title> tooltip 里，卡片上看不到内容）
          h('text', { x: 12, y: 31, 'font-size': 11, 'font-weight': 600, 'fill': '#1f2328' }, esc(clipText(title, 24))),
          h('text', { x: 12, y: 45, 'font-size': 9.5, 'fill': '#57606a' }, esc(clipText(metaLine, 30))),
          // 底部状态带文字：图标 + 中文状态（白字打在状态色上，一眼可见）
          h('text', { className: 'exp-node-status', x: 12, y: NODE_H - 4.5, 'font-size': 10, 'font-weight': 700, fill: '#ffffff' }, esc(meta.icon + ' ' + meta.label)),
          roundTag ? h('text', { x: NODE_W - 8, y: NODE_H - 4.5, 'font-size': 9, 'text-anchor': 'end', fill: 'rgba(255,255,255,.88)' }, esc(roundTag)) : null,
          h('title', null, esc(String(t.id || '') + ' · ' + title + ' · ' + meta.label + '（' + metaLine + '）')))
      })
      return h('div', { className: 'exp-dag' },
        h('svg', { width: L.width + 6, height: L.height + 6, style: { display: 'block' } },
          h('g', null, edgeEls), h('g', null, nodeEls)))
    }

    function TaskDetail(props) {
      try {
      var tk = props.task || {}
      var mem = props.member
      var nm = mem ? (mem.name || tk.owner) : tk.owner
      var col = mem ? (mem.color || '#5b8def') : '#9aa4b2'
      var ini = mem ? (mem.initial || nm.slice(0, 1).toUpperCase()) : nm.slice(0, 1).toUpperCase()
      var act = mem ? (mem.activity || '') : ''
      var st = act === 'running' ? t('运行中', 'running') : (act === 'idle' || act === 'ready' || act === 'inactive') ? t('空闲', 'idle') : ((mem && mem.active) ? t('已派', 'dispatched') : t('未启动', 'not started'))
      var model = mem ? (mem.model || mem.planModel || '') : ''
      var mt = props.current || null
      var files = props.files || []
      var onOp = props.onOp || null
      var logTail = props.logTail || ''
      var findings = arrOf(tk.findings).map(function (f, i) { return h('li', { key: i }, esc((f.severity || 'low') + ': ' + (f.title || f.detail || ''))) })
      var kv = [['id', tk.id], ['kind', kindLabel(tk.kind)], ['status', stLabel(tk.status)], ['round', tk.round], ['attempt', tk.attempt], ['verdict', verdictLabel(tk.verdict)], ['dependsOn', arrOf(tk.dependsOn).join(', ')], ['changedPaths', arrOf(tk.changedPaths).join(', ') || '—'], ['verify', arrOf(tk.verify).join('; ') || '—'], ['acceptance', Array.isArray(tk.acceptance) ? tk.acceptance.join('; ') : (tk.acceptance == null ? '' : String(tk.acceptance))]]
      return h('div', { className: 'exp-detail' },
        h('h4', null, esc(tk.title || tk.spec || tk.id || '')),
        h('div', { className: 'exp-detail-who' },
          h('span', { className: 'exp-ava', style: { background: col } }, esc(ini)),
          h('span', null, esc(nm) + ' · ' + esc(roleLabel(tk.owner)) + ' · ' + esc(st) + (model ? ' · ' + esc(String(model).slice(0, 20)) : '')),
          act === 'running' ? h('span', { className: 'exp-live', title: t('后台运行中，完成会自动通知', 'running — you will be notified') }) : null),
        onOp ? h('div', { className: 'exp-task-op' },
          h('button', { className: 'exp-op-btn', onClick: function () { onOp('in_progress') } }, t('进行中', 'Start')),
          h('button', { className: 'exp-op-btn', onClick: function () { onOp('completed') } }, t('完成', 'Done')),
          h('button', { className: 'exp-op-btn bad', onClick: function () { onOp('failed') } }, t('失败', 'Fail'))) : null,
        h('div', null, kv.map(function (k) { return h('div', { className: 'exp-kv', key: k[0] }, h('b', null, esc(k[0])), h('span', null, esc(String(k[1] == null ? '' : k[1])))) })),
        mt ? h('div', { className: 'exp-detail-sec' }, h('b', null, t('正在做', 'Doing')), h('div', { className: 'exp-doing' }, '▶ ' + esc(String(mt.title || mt.spec || mt.id || '').slice(0, 64)))) : null,
        files.length ? h('div', { className: 'exp-detail-sec' }, h('b', null, t('改动的文件（git 实时）', 'Changed files (live)')), h('div', { className: 'exp-files' }, files.map(function (f, i) { return h('div', { key: i, className: 'exp-file' }, esc(String(f).slice(0, 96))) }))) : null,
        findings.length ? h('ul', { className: 'exp-findings' }, findings) : null,
        logTail ? h('div', { className: 'exp-detail-sec' }, h('b', null, t('运行日志（最新）', 'Run log (latest)')), h('pre', { className: 'exp-log' }, esc(logTail))) : null)
      } catch (e) {
        return h('div', { className: 'exp-preview' }, 'TASK ERR: ' + esc(String(e && e.stack ? e.stack : e)).slice(0, 700))
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 专家团画布 · 第一批纯函数（依赖分层 / 编队 / 边 / 角色徽章）
    //
    // 设计口径（每条都写"为什么"，因为画布上最容易犯的错就是**编造一个看起来合理的层次**）：
    //   · 层次**完全客户端自算**，只读 TASKS.json 的 `dependsOn`；服务端零改动。
    //   · 最长路径分层（与既有 `dagLayout` 同口径），但**自带环检测** —— 旧 `compute` 是递归 memo，
    //     遇环会用"正在计算中"的中间值收口，等于**静默**给环上一个层号。
    //   · 未知依赖、环、同层/回边**一律只记录不乱画**，绝不静默吞掉。
    //   · 没有任何 `dependsOn`（含 `tasksLive` 投影）⇒ **绝不编造层次**：只留一层并标 `depsKnown:false`。
    //
    // 自包含性：这些函数会被测试按名抽取到 sandbox 里单独求值，所以除 `t`/`h`（全仓通用桩）
    // 外**不引用任何模块级符号**（依赖数组归一并就地写，`FINAL` 口径就地重复一份并注明来源）。
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * 依赖分层：**唯一权威入口**。
     * @returns {{byId:Object, level:Object, layers:Array, maxLayer:number, cycles:Array,
     *            unknownDeps:Array, edges:Array, skippedSameLayer:Array, hasDeps:boolean, depsKnown:boolean}}
     *
     * `depsKnown=false` 的判据是 `hasDeps===false`（一条 `dependsOn` 都没有）。此时"每层 0"与
     * "每层 1"完全等价，任何 >1 层的画法都是凭空造的 ⇒ 只留一层。
     */
    function canvasLayers(tasks) {
      // 依赖字段兼容旧格式（可能是字符串），就地归一，不依赖模块级 helper
      var depList = function (v) { return Array.isArray(v) ? v : (v == null ? [] : [v]) }
      var arr = (Array.isArray(tasks) ? tasks : []).filter(function (x) { return x && x.id != null && String(x.id) !== '' })
      var byId = {}
      arr.forEach(function (t) { byId[String(t.id)] = t })
      var ids = Object.keys(byId)
      var unknownDeps = []
      var deps = {}
      arr.forEach(function (t) {
        var id = String(t.id)
        deps[id] = depList(t.dependsOn).map(function (d) { return d == null ? '' : String(d) }).filter(function (d) {
          if (!d) return false
          if (d === id) return false // 自环：单独归入环列，不作为"层内依赖"参与最长路径
          if (!byId[d]) { unknownDeps.push({ from: id, to: d }); return false } // 未知依赖：记下来，不静默丢
          return true
        })
      })
      var hasDeps = arr.some(function (t) { return depList(t.dependsOn).length > 0 })

      // ── 环检测：Kahn 残留法（拓扑剥离不掉的即环的候选集）──
      // 不用递归 DFS：长链会爆栈，而"剥不掉"本身就是**可证明**的环证据。
      var indeg = {}, layerEdges = {}
      ids.forEach(function (id) { indeg[id] = 0; layerEdges[id] = [] })
      ids.forEach(function (id) { deps[id].forEach(function (d) { indeg[id] += 1; layerEdges[d].push(id) }) })
      var q = ids.filter(function (id) { return indeg[id] === 0 })
      var order = []
      while (q.length) {
        var cur = q.shift()
        order.push(cur)
        layerEdges[cur].forEach(function (nx) { indeg[nx] -= 1; if (indeg[nx] === 0) q.push(nx) })
      }
      var settled = {}
      order.forEach(function (id) { settled[id] = 1 })
      var remainder = {}
      ids.forEach(function (id) { if (!settled[id]) remainder[id] = 1 })
      // 残留集里**真正在环上**的才算：从残留节点顺依赖走，能走回自己的才是环成员。
      // 为什么多这一步：残留集会把"挂在环下游"的节点一起留下（入度永远降不到 0），
      // 它们其实没有环，直接标"成环"就是假报。
      var cycleSet = {}
      Object.keys(remainder).forEach(function (start) {
        var queue = [start], seen = {}
        while (queue.length) {
          var n = queue.shift()
          deps[n].forEach(function (d) {
            if (d === start) cycleSet[start] = 1
            if (remainder[d] && !seen[d]) { seen[d] = 1; queue.push(d) }
          })
        }
      })

      // ── 最长路径分层：只在**非环**节点上算 ──
      var level = {}, visiting = {}
      function lvl(id) {
        if (id in level) return level[id]
        if (visiting[id]) return 0 // 双保险（环已摘除，这里不该再遇到）；防御，不当结论用
        visiting[id] = 1
        var ds = deps[id].filter(function (d) { return !cycleSet[d] })
        level[id] = ds.length ? 1 + Math.max.apply(null, ds.map(lvl)) : 0
        visiting[id] = 0
        return level[id]
      }
      ids.forEach(function (id) { if (!cycleSet[id]) lvl(id) })
      var maxLayer = 0
      Object.keys(level).forEach(function (id) { if (level[id] > maxLayer) maxLayer = level[id] })
      var layers = []
      for (var L = 0; L <= maxLayer; L++) layers.push([])
      arr.forEach(function (t) { var id = String(t.id); if (!cycleSet[id]) layers[level[id]].push(t) })
      if (!hasDeps) {
        layers = [arr.slice()]
        level = {}
        arr.forEach(function (t) { level[String(t.id)] = 0 })
        maxLayer = 0
      }

      // ── 边表：from=上游，to=下游；同层/反向/指向环的边**只计数不画** ──
      // 为什么不画：等高层之间贝塞尔箭头退化成水平线，会与"左→右 = 依赖先后"矛盾，
      // 硬画等于给出错误的因果暗示。
      //
      // ⚠️ 实测结论（测试员穷举法证明，2026-09 复核）：**`skippedSameLayer` 恒为空数组**，
      // 页脚那条「N 条依赖同层或反向」告警在当前口径下**永远不会出现**。理由：
      //   · 本函数用的是"最长路径分层"⇒ 非环依赖恒有 `level[上游] < level[下游]`，
      //     所以 `lt <= lf` 这一半判据不可达；
      //   · 反向边与"依赖目标在环上"的情形，已被上面的 `cycleSet[to]`（1339 行）与
      //     `cycleSet[from]`（1342 行）两道守卫提前 `return` 掉，`lf/lt === undefined` 那一半同样不可达。
      // **为什么仍然保留这个分支**：它是"只画跨层边"这条口径的**显式表达**（不是死代码 ——
      // 删掉它就等于把口径藏进隐式假设），且测试用"edges 与 skipped 不重叠、edges 恰为两端非环的
      // 依赖边"这个**邻接不变量**把它钉住（比"计数为 0"更强）。若将来换分层算法（例如允许同层边、
      // 或改成最短路径/波次分层），这里会立刻变成真判据，而调用方与告警文案不必再改。
      var edges = [], skippedSameLayer = []
      arr.forEach(function (t) {
        var to = String(t.id)
        if (cycleSet[to]) return
        depList(t.dependsOn).forEach(function (d) {
          var from = d == null ? '' : String(d)
          if (!from || !byId[from] || from === to || cycleSet[from]) return
          var lf = level[from], lt = level[to]
          if (lf === undefined || lt === undefined || lt <= lf) { skippedSameLayer.push({ from: from, to: to }); return }
          edges.push({ from: from, to: to })
        })
      })
      var cycles = ids.filter(function (id) { return !!cycleSet[id] })
      return {
        byId: byId, level: level, layers: layers, maxLayer: maxLayer,
        cycles: cycles, unknownDeps: unknownDeps, edges: edges,
        skippedSameLayer: skippedSameLayer, hasDeps: hasDeps, depsKnown: hasDeps
      }
    }

    /**
     * 派生受阻：该任务**已存在但未完成**的依赖 id 列表。
     * 只有上报为 `completed`/`done` 才算完成（"绝不推断完成"）。
     * 依赖不存在 ⇒ 不进这个列表（它进 `canvasLayers().unknownDeps`，两件事不许混为一谈）。
     */
    function canvasBlockedBy(task, byId) {
      var depList = function (v) { return Array.isArray(v) ? v : (v == null ? [] : [v]) }
      var t = task || {}
      var map = byId || {}
      var out = []
      depList(t.dependsOn).forEach(function (d) {
        var id = d == null ? '' : String(d)
        if (!id) return
        var dep = map[id]
        if (!dep) return
        var st = String(dep.status || '')
        // 缺 status 也算未完成：宁可保守（下游显示"受阻"），也不替它宣布解锁
        if (st !== 'completed' && st !== 'done') out.push(id)
      })
      return out
    }

    /** 层标题：0 层不叫"第 1 层"（会让人以为还有第 0 层）；最末层且确实有依赖时叫"收尾"。 */
    function canvasLayerTitle(l, maxLayer) {
      var max = Number(maxLayer) || 0
      var n = Number(l) || 0
      if (n === 0) return t('无依赖 · 可立即领', 'no deps · ready to claim')
      if (max > 0 && n === max) return t('收尾', 'final')
      return t('第 ' + (n + 1) + ' 层', 'layer ' + (n + 1))
    }

    /**
     * 列模型：按依赖分层的列 + 成环列（单独一列）。
     * 无任何 `dependsOn` 时返回**单列** `key:'unknown'` —— 调用方据此走"依赖未知"的降级口径。
     * `done` 口径与面板既有 `FINAL` 计数一致（completed/done/cancelled/failed 视为终态），
     * 就地重复一份以免依赖模块级常量（测试会单独抽取本函数求值）。
     */
    function canvasColumns(tasks) {
      var FIN = ['completed', 'done', 'cancelled', 'failed']
      var L = canvasLayers(tasks)
      var doneOf = function (list) {
        return list.filter(function (x) { return FIN.indexOf(String((x && x.status) || '')) >= 0 }).length
      }
      var blockedOf = function (list) {
        return list.filter(function (x) {
          var st = String((x && x.status) || '')
          if (st !== 'pending' && st !== 'claimed') return false
          return canvasBlockedBy(x, L.byId).length > 0
        }).length
      }
      if (!L.depsKnown) {
        var all = L.layers[0] || []
        return [{
          key: 'unknown', kind: 'unknown', title: t('依赖关系未知', 'dependencies unknown'),
          // 措辞必须与"分层成功"区分开：不是"只有一层"，是**依赖无从得知**
          note: t('本 run 没有 TASKS.json，依赖无从得知', 'no TASKS.json — dependencies unknown'),
          tasks: all, done: doneOf(all), total: all.length, blocked: blockedOf(all)
        }]
      }
      var cols = L.layers.map(function (list, i) {
        return {
          key: 'L' + i, title: canvasLayerTitle(i, L.maxLayer), kind: 'layer',
          // 每列都写明"层号是本插件推导出来的"：否则用户会以为层号是服务端上报的事实
          note: t('分层由本插件按 dependsOn 推导（Claude Code 无此视图）', 'layers derived here from dependsOn (no such view in Claude Code)'),
          tasks: list, done: doneOf(list), total: list.length, blocked: blockedOf(list)
        }
      })
      if (L.cycles.length) {
        var cyc = L.cycles.map(function (id) { return L.byId[id] }).filter(Boolean)
        cols.push({
          key: 'cycle', title: t('成环 · 无法分层', 'cycle · unlayered'), kind: 'cycle',
          // 环**单独一列**而不是塞进某一层：层号对环上的任务没有意义，塞进去就是给假结论
          note: t('这 ' + cyc.length + ' 个任务的依赖互相成环，无法分层', cyc.length + ' tasks form a dependency cycle'),
          tasks: cyc, done: doneOf(cyc), total: cyc.length, blocked: blockedOf(cyc)
        })
      }
      return cols
    }

    /**
     * 编队模型（队长 + 成员六态）。
     *
     * ⚠️ **诚实前提（已核实，非推测）**：`/state` 负载里**没有 leader 记录**，面板这个队长位置是硬编码
     * 标记。`lead.label` 实际返回的是 **ASCII 契约值 `'team-lead'`**（不是 `null`，也不是人名），
     * 来源语义由 `lead.badges` 如实标出：`长` + `本会话`（渲染成「team-lead 长 本会话」）——
     * 不冒充真实队员，也不编一个人名。
     *
     * 六态优先级（必须可区分）：in_progress(执行 #id) > claimed(领取中 #id) > running(工作中) >
     *   有待命(待命) > membersUnresolved && !active(未解析, warn) > (未启动)。
     * 第 4 态用的是**真实字段**：`/state` 的 `agents[].activity` 为 `idle`/`ready`
     *   （复核 client.js 既有 `statusOf`/`TaskDetail` 里已验证的取值集合：running/idle/ready/inactive/''）。
     *   集合外的取值**不当待命**（未验到就不猜），落"未启动"，不虚构活动态。
     */
    function canvasFormation(members, agents, tasks, data) {
      var mem = members && typeof members === 'object' ? members : {}
      var ats = Array.isArray(agents) ? agents : []
      var tks = Array.isArray(tasks) ? tasks : []
      var d = data && typeof data === 'object' ? data : {}
      var unresolved = d.membersUnresolved === true
      var byAgent = {}
      tks.forEach(function (tk) {
        var aid = tk && tk.agentId != null ? String(tk.agentId) : ''
        if (aid) (byAgent[aid] = byAgent[aid] || []).push(tk)
      })
      var names = []
      ats.forEach(function (a) { if (a && a.name && names.indexOf(String(a.name)) < 0) names.push(String(a.name)) })
      var out = []
      Object.keys(mem).sort().forEach(function (role) {
        var m = mem[role] || {}
        var mine = tks.filter(function (tk) { return tk && String(tk.owner || '') === String(role) })
        var done = mine.filter(function (tk) { var s = String(tk.status || ''); return s === 'completed' || s === 'done' }).length
        // ① 执行中 / ② 领取中：**只显示已确认的认领** —— 必须真有任务 id，绝不按名字猜
        var runTask = mine.filter(function (tk) { return String(tk.status || '') === 'in_progress' })[0] || null
        if (!runTask && m.id && byAgent[String(m.id)]) {
          runTask = byAgent[String(m.id)].filter(function (tk) { return String(tk.status || '') === 'in_progress' })[0] || null
        }
        var claimTask = runTask ? null : (mine.filter(function (tk) { return String(tk.status || '') === 'claimed' })[0] || null)
        var agentIds = []
        if (m.id) agentIds.push(String(m.id))
        ats.forEach(function (a) {
          if (!a) return
          var roleOk = a.role && String(a.role) === String(role)
          var nameOk = a.name && String(a.name) === String(m.name || '')
          if ((roleOk || nameOk) && agentIds.indexOf(String(a.id)) < 0) agentIds.push(String(a.id))
        })
        // ③ 工作中 / ④ 待命：成员自身的 activity 优先，缺失时看归属到的 agent
        var act = String(m.activity || '')
        if (!act && agentIds.length) {
          var mineAts = ats.filter(function (a) { return a && agentIds.indexOf(String(a.id)) >= 0 })
          var hitRun = mineAts.filter(function (a) { return a && a.activity === 'running' })[0]
          var hitIdle = mineAts.filter(function (a) { return a && (a.activity === 'idle' || a.activity === 'ready') })[0]
          if (hitRun) act = 'running'
          else if (hitIdle) act = hitIdle.activity
        }
        var state
        if (runTask) state = { key: 'in_progress', text: t('执行 #' + runTask.id, 'on #' + runTask.id), warn: false }
        else if (claimTask) state = { key: 'claimed', text: t('领取中 #' + claimTask.id, 'claimed #' + claimTask.id), warn: false }
        else if (act === 'running') state = { key: 'running', text: t('工作中', 'working'), warn: false }
        // 「待命」= **有过完成记录、当前没有进行中/已领取的任务**。`activity` 只是其中一条可用证据，
        // 不是唯一判据：真实负载里 `members[].activity` 常见为空串（≠ 没干过活），若只看它，
        // 名下任务全做完的成员会被显示成"未启动"——那是**假话**。所以 `done > 0` 也算待命。
        // 本分支必须留在「未解析」之前：有完成记录的人不该被判成"未解析"。
        else if (act === 'idle' || act === 'ready' || done > 0) state = { key: 'standby', text: t('待命', 'standby'), warn: false }
        else if (unresolved && m.active !== true) state = { key: 'unresolved', text: t('未解析', 'unresolved'), warn: true }
        else state = { key: 'idle', text: t('未启动', 'not started'), warn: false }
        out.push({
          role: role, name: m.name || '', color: m.color || '', initial: m.initial || '',
          avatarRole: role, state: state,
          taskId: (runTask || claimTask) ? String((runTask || claimTask).id) : '',
          done: done, total: mine.length, agents: agentIds
        })
      })
      var empty = null
      if (!out.length) {
        empty = { kind: 'no-members', text: t('这一轮还没有登记成员', 'no members registered in this run') }
        var warmingList = Array.isArray(d.warming) ? d.warming : []
        // 三种空态语义**必须分开**（"没有成员"/"还没读出来"/"角色待解析"混成一句就是骗人）：
        // 只用**已核实存在于负载里**的两个字段：`warming`（6978 行附近 sel 合并而来）与 `rolesPending`。
        if (warmingList.indexOf('subs') >= 0 && !ats.length) {
          empty = { kind: 'warming', text: t('成员明细还在就绪中（后台读取中，未读出来 ≠ 没有人）', 'member details still warming up (not read yet ≠ no members)') }
        } else if (Number(d.rolesPending) > 0) {
          empty = { kind: 'roles-pending', text: t('尚无成员可显示；另有 ' + Number(d.rolesPending) + ' 条子代理角色待解析', 'no members yet; ' + Number(d.rolesPending) + ' subagent role(s) pending') }
        } else if (!ats.length) {
          empty = { kind: 'no-members', text: t('这一轮没有任何子代理在运行', 'no subagents in this run') }
        } else {
          empty = { kind: 'roles-pending', text: t('有 ' + ats.length + ' 个子代理在跑，但角色未解析出来', ats.length + ' subagent(s) running, roles unresolved') }
        }
      }
      // 队长：**`/state` 里没有 leader 记录**（已核实，不是推测）⇒ 绝不冒充一名真实队员：
      // 用 badges 把"来源"如实标出来（`长` + `本会话`），并保留冻结契约的字段形状 `label:'team-lead'`，
      // 免得每个视图各编一个队长名。`phase`/`status` 缺值时退回子代理名字列表（宁可显示读到的东西，不显示空串）。
      var leadNote = (typeof phaseLabel === 'function' ? phaseLabel(d.phase || '') : String(d.phase == null ? '' : d.phase))
        + ' · ' + (typeof statusLabel === 'function' ? statusLabel(d.status || '') : String(d.status == null ? '' : d.status))
      var pend = (Number(d.subsPending) || 0) + (Number(d.rolesPending) || 0)
      if (pend > 0) leadNote += ' · ' + t('待解析 ' + pend, pend + ' pending parse')
      if ((Array.isArray(d.warming) ? d.warming : []).length) leadNote += ' · ' + t('还在就绪中', 'warming up')
      if (!leadNote.replace(/[\s·]/g, '')) leadNote = names.join('、')
      return {
        lead: {
          label: 'team-lead',
          note: leadNote,
          // 这两条是**来源标注**（不是上报字段）：画布上必须能看出"队长不是从数据里读出来的"
          badges: [{ k: 'lead', text: t('长', 'Lead') }, { k: 'this-session', text: t('本会话', 'this session') }]
        },
        members: out, empty: empty
      }
    }

    /** 边相关子集：给画布覆盖层与页脚图例用（把 `canvasLayers` 的边信息收成一次调用）。 */
    function canvasEdges(tasks) {
      var L = canvasLayers(tasks)
      return {
        edges: L.edges.map(function (e) {
          var up = L.byId[e.from] || {}
          var st = String(up.status || '')
          // "绝不推断完成"：satisfied 只认上报的 completed/done
          return { from: e.from, to: e.to, satisfied: (st === 'completed' || st === 'done') }
        }),
        skippedSameLayer: L.skippedSameLayer.length,
        cycles: L.cycles.length,
        unknownDeps: L.unknownDeps.length
      }
    }

    // 12 个固定角色的徽章**几何图形**键（不是颜色差异：色盲/深色主题下也分得开）。
    var ETC_ROLE_SHAPE = {
      pm: 'diamond', architect: 'hex', researcher: 'lens', ui: 'round', backend: 'square', frontend: 'grid',
      dba: 'stack', sec: 'shield', reviewer: 'check', qa: 'bug', devops: 'gear', docs: 'page'
    }
    var ETC_ROLE_HUES = [210, 275, 200, 330, 175, 155, 255, 0, 40, 95, 20, 195]

    /**
     * 角色头像底色：优先用真实 `members[role].color`（服务端下发），否则按 role 字符串**稳定哈希**取色。
     * 同一 role 恒同色。已知 12 角色不走哈希（它们的区分靠 `ETC_ROLE_SHAPE` 的图形）。
     * **未验到**：服务端 `AGENT_COLORS` 的确切色域（未读该表）⇒ 只做"是 `#rrggbb` 就原样透传，否则退回哈希"，
     * 不做任何"看起来像品牌色就替换"的推断。
     */
    function roleAvatarColor(role, fallbackColor) {
      var fb = fallbackColor == null ? '' : String(fallbackColor)
      if (/^#[0-9a-fA-F]{6}$/.test(fb)) return fb.toLowerCase()
      var s = String(role == null ? '' : role)
      var h = 0
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
      var hue = ETC_ROLE_HUES[h % ETC_ROLE_HUES.length]
      return etcHslHex(hue, 52 + (h % 3) * 8, 42 + (Math.floor(h / 8) % 3) * 4)
    }

    /** HSL → `#rrggbb`（纯算术；不依赖 CSS 求值，测试里也能跑）。 */
    function etcHslHex(h, s, l) {
      var S = s / 100, L = l / 100
      var c = (1 - Math.abs(2 * L - 1)) * S
      var hp = (((h % 360) + 360) % 360) / 60
      var x = c * (1 - Math.abs((hp % 2) - 1))
      var rgb = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
      var m = L - c / 2
      var to = function (v) { var n = Math.round((v + m) * 255); return ('0' + Math.max(0, Math.min(255, n)).toString(16)).slice(-2) }
      return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2])
    }

    /**
     * 内联 SVG 角色徽章：12 固定角色各一个极简几何图形；`lead` 用专属图形；未知角色用中性兜底 + 名字首字。
     * @param {string} role 角色 id
     * @param {{size?:number,color?:string,initial?:string,name?:string,lead?:boolean}} opts
     */
    function roleAvatarSvg(role, opts) {
      var o = opts || {}
      var r = String(role == null ? '' : role)
      var size = Number(o.size) || 36
      var isLead = o.lead === true || r === 'lead'
      var col = roleAvatarColor(isLead ? 'lead' : r, o.color)
      var shape = ETC_ROLE_SHAPE[r] || (isLead ? 'lead' : 'fallback')
      var fg = 'rgba(255,255,255,.94)'
      var shapes = {
        diamond: h('rect', { x: 11, y: 11, width: 18, height: 18, rx: 3, fill: fg, transform: 'rotate(45 20 20)' }),
        hex: h('path', { d: 'M20 7l11 6.5v13L20 33 9 26.5v-13z', fill: 'none', stroke: fg, strokeWidth: 2.2, strokeLinejoin: 'round' }),
        lens: h('g', null, h('circle', { cx: 18, cy: 18, r: 7, fill: 'none', stroke: fg, strokeWidth: 2.2 }), h('path', { d: 'M23 23l6 6', stroke: fg, strokeWidth: 2.6, strokeLinecap: 'round' })),
        round: h('circle', { cx: 20, cy: 20, r: 8, fill: 'none', stroke: fg, strokeWidth: 2.2 }),
        square: h('rect', { x: 11, y: 11, width: 18, height: 18, rx: 2.5, fill: 'none', stroke: fg, strokeWidth: 2.2 }),
        grid: h('g', null,
          h('rect', { x: 10, y: 10, width: 8.5, height: 8.5, rx: 1.5, fill: fg }),
          h('rect', { x: 21.5, y: 10, width: 8.5, height: 8.5, rx: 1.5, fill: 'none', stroke: fg, strokeWidth: 2 }),
          h('rect', { x: 10, y: 21.5, width: 8.5, height: 8.5, rx: 1.5, fill: 'none', stroke: fg, strokeWidth: 2 }),
          h('rect', { x: 21.5, y: 21.5, width: 8.5, height: 8.5, rx: 1.5, fill: fg })),
        stack: h('g', null,
          h('ellipse', { cx: 20, cy: 13, rx: 9, ry: 4, fill: fg }),
          h('path', { d: 'M11 13v7c0 2.2 4 4 9 4s9-1.8 9-4v-7', fill: 'none', stroke: fg, strokeWidth: 2 })),
        shield: h('path', { d: 'M20 7l11 4v9c0 7-5 11-11 13-6-2-11-6-11-13v-9z', fill: 'none', stroke: fg, strokeWidth: 2.2, strokeLinejoin: 'round' }),
        check: h('path', { d: 'M10 21l7 7 13-15', fill: 'none', stroke: fg, strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        bug: h('g', null,
          h('ellipse', { cx: 20, cy: 21, rx: 7, ry: 8.5, fill: 'none', stroke: fg, strokeWidth: 2.2 }),
          h('path', { d: 'M13 15l-5-4M27 15l5-4M12 21H4M28 21h8M13 27l-5 4M27 27l5 4', stroke: fg, strokeWidth: 2, strokeLinecap: 'round' })),
        gear: h('g', null,
          h('circle', { cx: 20, cy: 20, r: 6.5, fill: 'none', stroke: fg, strokeWidth: 2.2 }),
          h('path', { d: 'M20 7v5M20 28v5M7 20h5M28 20h5M11 11l3.5 3.5M25.5 25.5L29 29M29 11l-3.5 3.5M14.5 25.5L11 29', stroke: fg, strokeWidth: 2.2, strokeLinecap: 'round' })),
        page: h('g', null,
          h('path', { d: 'M12 8h11l6 6v18H12z', fill: 'none', stroke: fg, strokeWidth: 2.2, strokeLinejoin: 'round' }),
          h('path', { d: 'M23 8v6h6', fill: 'none', stroke: fg, strokeWidth: 2.2, strokeLinejoin: 'round' }),
          h('path', { d: 'M16 21h9M16 26h9', stroke: fg, strokeWidth: 1.8, strokeLinecap: 'round' })),
        lead: h('g', null,
          h('path', { d: 'M8 26l3-12 9 5 9-5 3 12z', fill: 'none', stroke: fg, strokeWidth: 2.4, strokeLinejoin: 'round' }),
          h('path', { d: 'M8 30h24', stroke: fg, strokeWidth: 2.4, strokeLinecap: 'round' })),
        fallback: h('circle', { cx: 20, cy: 20, r: 7, fill: fg })
      }
      var initial = String(o.initial == null ? '' : o.initial).trim()
      if (shape === 'fallback' && initial) {
        shapes.fallback = h('text', { x: 20, y: 25.5, 'text-anchor': 'middle', 'font-size': 16, 'font-weight': 700, fill: '#fff' }, initial.slice(0, 1).toUpperCase())
      }
      // `roleLabel` 是可选的显示增强：抽取到 sandbox 单测时可能没有这个模块级函数，缺了就回落 role id（不抛错）
      var title = o.name ? String(o.name) : (isLead ? t('队长', 'lead') : (typeof roleLabel === 'function' ? roleLabel(r) : r))
      var kids = [h('title', null, title)]
      if (isLead) kids.push(h('rect', { x: 2.5, y: 2.5, width: 35, height: 35, rx: 17.5, fill: 'none', stroke: fg, strokeWidth: 2, opacity: 0.55 }))
      kids.push(h('circle', { cx: 20, cy: 20, r: 19, fill: col }))
      kids.push(shapes[shape] || shapes.fallback)
      var svg = h('svg', {
        className: 'etc-avatar-svg', viewBox: '0 0 40 40', width: size, height: size,
        role: 'img', 'aria-label': title, focusable: 'false'
      }, kids)
      return svg
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 专家团画布 · 视图层（`.etc-*` 的 DOM 只在这里产出；样式规则全在 CSS 常量里，这里不写任何 CSS）
    //
    // 三条纪律，每条都对应一种"看起来对、其实在骗人"的画法：
    //   · 卡片上的状态胶囊 = **上报的 status**；「受阻」是我们**推导**的 ⇒ 单独一行，绝不替换胶囊。
    //   · 层号、边都是本插件推的 ⇒ 列注与图例写明来源；环/未知依赖/同层边/降级**都要有可见出口**，不许静默吞。
    //   · 没有的数字不写：不出现百分比文字、不出现"收信箱 N"这类负载里根本没有的字段。
    // ══════════════════════════════════════════════════════════════════════════

    /** 任务/成员条的状态类：completed⇒ok / in_progress|claimed⇒run / rework|failed⇒bad / 其余空槽。 */
    function canvasBarCls(status) {
      var s = String(status || '')
      if (s === 'completed' || s === 'done') return 'ok'
      if (s === 'in_progress' || s === 'claimed') return 'run'
      if (s === 'rework' || s === 'failed') return 'bad'
      return ''
    }

    /**
     * 单个成员卡：几何头像 + 名字 + 六态文字 + 完成度条。
     * 条宽用**真实 done/total**；`total===0` 时留 0 宽（宁可空着，也不给一条"看起来忙碌"的假进度）。
     */
    function canvasMemberNode(m) {
      var st = (m && m.state) || {}
      var live = st.key === 'in_progress' || st.key === 'running'
      var total = Number(m && m.total) || 0, doneN = Number(m && m.done) || 0
      var barCls = live ? 'run' : (st.warn ? 'bad' : (total > 0 && doneN >= total ? 'ok' : ''))
      return h('div', { key: m.role, className: 'etc-member' },
        h('div', { className: 'etc-member-h' },
          h('span', { className: 'etc-avatar' }, roleAvatarSvg(m.role, { size: 36, color: m.color, initial: m.initial, name: m.name })),
          h('span', { className: 'etc-name', title: m.role }, esc(m.name || roleLabel(m.role)))),
        h('div', { className: 'etc-state' },
          // 状态点：warn（如"未解析"）单独染色 —— 它与"未启动"是两件事，颜色不能一样
          h('i', { className: 'etc-dot' + (live ? ' run' : ''), style: st.warn ? { background: 'var(--etc-warn)' } : null }),
          esc(st.text || '')),
        h('div', { className: 'etc-bar' + (barCls ? ' ' + barCls : '') },
          h('i', { style: { width: total ? Math.round((doneN / total) * 100) + '%' : '0' } })))
    }

    /**
     * 单张任务卡。`ctx = {L, members, selId, onPick}`：分层结果由调用方算一次复用，卡里不重算。
     *
     * 为什么「受阻」另起一行、不动状态胶囊：胶囊是 TASKS.json **上报的事实**，
     * 「依赖未完成 ⇒ 受阻」是**我们推的**；用推导结论覆盖上报事实，用户就再也分不清
     * "任务自己报了受阻" 和 "我们算出它现在动不了" —— 这正是画布最容易骗人的地方。
     */
    function canvasCardNode(tk, ctx) {
      var c = ctx || {}, L = c.L || { byId: {} }, members = c.members || {}
      var id = String(tk.id)
      var st = String(tk.status || '')
      var bar = canvasBarCls(st)
      var deps = arrOf(tk.dependsOn).map(function (d) { return d == null ? '' : String(d) }).filter(function (d) { return !!d })
      var blocked = canvasBlockedBy(tk, L.byId)
      var chips
      if (!deps.length) {
        chips = [h('span', { key: 'start', className: 'etc-chip' }, t('起点', 'start'))]
      } else {
        // 只画前 4 个、其余折成 `+N`：卡片宽度固定，多余 chip 会把状态胶囊挤没；
        // 但 `+N` 的 title 里给出**完整**依赖列表，折叠不等于丢信息。
        chips = deps.slice(0, 4).map(function (d) {
          var dep = L.byId[d]
          var ok = !!dep && (String(dep.status || '') === 'completed' || String(dep.status || '') === 'done')
          return h('span', { key: d, className: 'etc-chip ' + (ok ? 'ok' : 'warn'), title: d }, '← #' + esc(d))
        })
        if (deps.length > 4) chips.push(h('span', { key: 'more', className: 'etc-chip more', title: deps.slice(4).join(', ') }, '+' + (deps.length - 4)))
      }
      var ownerKey = String(tk.owner || '')
      var ownerNode = ownerKey
        ? h('div', { className: 'etc-owner' },
            h('span', { className: 'etc-avatar' }, roleAvatarSvg(ownerKey, { size: 14, color: members[ownerKey] && members[ownerKey].color })),
            esc(roleLabel(ownerKey)))
        : h('div', { className: 'etc-owner etc-owner-none' }, t('未指派', 'unassigned'))
      return h('div', {
        key: id, 'data-etc-id': id, title: t('点击查看任务详情', 'click for task detail'),
        className: 'etc-card' + (bar ? ' ' + bar : '') + (String(c.selId || '') === id ? ' sel' : ''),
        onClick: function () { if (c.onPick) c.onPick(tk) }
      },
        h('div', { className: 'etc-card-h' },
          h('span', { className: 'etc-id' }, '#' + esc(id)),
          h('span', { className: 'exp-badge ' + stBadgeCls(st) }, esc(stLabel(st)))),
        // 标题回落链：title → objective → #id（负载里可能两个都没有，此时显示 id 而不是空白）
        h('div', { className: 'etc-card-t' }, esc(String(tk.title || tk.objective || ('#' + id)))),
        ownerNode,
        h('div', { className: 'etc-chips' }, chips),
        // 只在"还没动"的任务上报受阻（pending/claimed）：已完成的任务再挂"受阻"是噪音
        (blocked.length && (st === 'pending' || st === 'claimed'))
          ? h('div', { className: 'etc-blocked' }, t('受阻：依赖 ', 'blocked: deps ') + blocked.map(function (b) { return '#' + b }).join(' ') + t(' 未完成', ' not done'))
          : null,
        h('div', { className: 'etc-bar' + (bar ? ' ' + bar : '') }, h('i', { style: bar ? { width: '100%' } : { width: '0' } })))
    }

    /** 一列（一层，或成环列）：标题 + 真实 done/total + 来源注 + 卡片栈。 */
    function canvasColNode(c, ctx) {
      var col = c || {}, list = arrOf(col.tasks)
      var blockedN = Number(col.blocked) || 0
      return h('div', { key: col.key, className: 'etc-col' },
        h('div', { className: 'etc-col-h' },
          h('span', null, esc(col.title || '')),
          h('span', { className: 'etc-col-n' }, (Number(col.done) || 0) + '/' + (Number(col.total) || list.length)),
          // 受阻计数只在 >0 时出现：挂一个"受阻 0"是噪音，不是信息
          blockedN > 0 ? h('span', { className: 'etc-chip warn' }, t('受阻 ', 'blocked ') + blockedN) : null),
        h('div', { className: 'etc-col-note' }, esc(col.note || '')),
        h('div', { className: 'etc-cards' }, list.length ? list.map(function (tk) { return canvasCardNode(tk, ctx) }) : h('div', { className: 'etc-empty' }, t('（空）', '(empty)'))))
    }

    /**
     * 依赖箭头的几何测量（自定义 hook）：返回 `[{from,to,satisfied,x1,y1,x2,y2}]`，坐标**相对 `.etc-cols` 本体**。
     *
     * 为什么要 ResizeObserver + scroll 监听、而且必须清理：列宽随窗口与滚动变化，用旧坐标画的箭头
     * 会指向错误的卡片 —— 那时它比"没有箭头"更糟，因为它在**断言一个假的依赖关系**。
     * `typeof document === 'undefined'` 时整体跳过：本文件在测试里会被 `new Function` 求值，渲染期不许摸 document。
     * 依赖签名 `sig` 由调用方给（任务集合或状态变化才重量），避免每帧都测一遍。
     *
     * ⚠️ `active`（可见/激活）**必须进依赖**，否则切页签后永不重测（2026-09-16 真机根因）：
     *   面板是**无条件**求值 `canvasView`（hook 数量不能随视图变），但画布元素只在
     *   「事」页签 + 编队画布视图下**真的挂进 DOM**。首帧（面板默认在「人」页签）时
     *   `boxRef.current` 是 `null` ⇒ 旧实现直接 `return`（**连 ResizeObserver 都没挂上**）；
     *   切到「事」页签时 `sig` 不变（任务集合没变）⇒ effect 不再跑 ⇒ 真机 `.etc-edges`
     *   子节点数**恒为 0**。"可见性变化"是一次真实的输入变化，必须让 effect 重跑。
     */
    function useCanvasEdges(boxRef, eg, sig, active) {
      var s = useState([]); var v = s[0], setV = s[1]
      useEffect(function () {
        if (typeof document === 'undefined') return undefined
        if (!active) return undefined   // 画布此刻不在 DOM（别的页签/别的视图）⇒ 不量、也不挂观察器
        var box = boxRef && boxRef.current
        if (!box) return undefined
        function measure() {
          try {
            var br = box.getBoundingClientRect(), nb = {}, nodes = box.querySelectorAll('[data-etc-id]')
            for (var i = 0; i < nodes.length; i++) nb[nodes[i].getAttribute('data-etc-id')] = nodes[i].getBoundingClientRect()
            var out = [], list = (eg && eg.edges) || []
            for (var j = 0; j < list.length; j++) {
              var e = list[j], a = nb[e.from], b = nb[e.to]
              if (!a || !b) continue   // 端点不可见（还没渲染/不在这一屏）⇒ 不画，不猜位置
              // scrollLeft 必须计入：容器横向滚动后，getBoundingClientRect 是"视口坐标"，而覆盖层是"内容坐标"
              out.push({
                from: e.from, to: e.to, satisfied: e.satisfied,
                x1: a.right - br.left + box.scrollLeft, y1: a.top + a.height / 2 - br.top,
                x2: b.left - br.left + box.scrollLeft, y2: b.top + b.height / 2 - br.top
              })
            }
            setV(out)
          } catch (err) { /* 测量失败就不画箭头：错位的箭头等于伪造依赖关系 */ }
        }
        measure()
        // 首帧合并进 DOM 之后尺寸才算得准：effect 里那次 measure 可能跑在浏览器**布局之前**
        // （卡片刚插入、字体/横向滚动条还没定），量出来的是 0 或旧值。补一次 rAF（没有 rAF 的
        // 环境退回 setTimeout 0），并在 cleanup 里取消 —— 卸载后再量再 setState 纯属浪费。
        var cancelTick = null
        try {
          if (typeof requestAnimationFrame === 'function') {
            var raf = requestAnimationFrame(measure)
            cancelTick = function () { cancelAnimationFrame(raf) }
          } else {
            var tid = setTimeout(measure, 0)
            cancelTick = function () { clearTimeout(tid) }
          }
        } catch (e0) { cancelTick = null }
        var ro = null
        try { if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(box) } } catch (e1) {}
        try { box.addEventListener('scroll', measure) } catch (e2) {}
        try { window.addEventListener('resize', measure) } catch (e3) {}
        return function () {
          try { if (cancelTick) cancelTick() } catch (e7) {}
          try { if (ro) ro.disconnect() } catch (e4) {}
          try { box.removeEventListener('scroll', measure) } catch (e5) {}
          try { window.removeEventListener('resize', measure) } catch (e6) {}
        }
      }, [sig, active])
      return v
    }

    /**
     * 画布视图：§A 编队（队长 / 指派总线 / 成员）+ §B 共享任务列表（分层列 + 依赖箭头覆盖层 + 图例）。
     *
     * ⚠️ 本函数**含 React hook**（`useCanvasEdges`）⇒ 调用方必须**每次渲染都调用它**，
     * 不能只在 `viewV === 'canvas'` 的三元分支里调：条件调用会让 hook 数量随视图切换变化，React 直接抛错。
     * 所以 Panel 里先无条件算出元素、再在三元里挑用（见 `canvasEl`）。
     *
     * 降级是**显式**的：没有 dependsOn 时不画层次、不画箭头，只给一列 + 横幅说明；
     * 环 / 未知依赖 / 同层边各有自己的可见出口 —— 静默吞掉它们等于让用户以为图是完整的。
     */
    function canvasView(props) {
      var p = props || {}
      var tasks = arrOf(p.tasks)
      var members = p.members && typeof p.members === 'object' ? p.members : {}
      var F = canvasFormation(members, arrOf(p.agents), tasks, p.data || {})
      var cols = canvasColumns(tasks)
      var L = canvasLayers(tasks)                      // 分层只算一次：卡片的 byId 与边表复用同一份
      var eg = canvasEdges(tasks)
      var cctx = { L: L, members: members, selId: p.selectedId, onPick: p.onPick || null }
      var boxRef = useRef(null)
      // 任务集合或状态一变就得重量箭头；只看 `tasks.length` 会在"换了一个任务"时留旧箭头
      var sig = tasks.map(function (t) { return String(t.id) + ':' + String(t.status || '') }).join(',')
      // `p.active`：本画布此刻是否**真的在 DOM 里**（由 Panel 传：`tab === 'tasks' && viewV === 'canvas'`）。
      // 缺省（老调用方/测试）按 `true` 处理 = 保持旧行为，避免"没传就永不测量"的静默降级。
      var edgeV = useCanvasEdges(boxRef, eg, sig, p.active !== false)
      var edgeSvg = h('svg', { className: 'etc-edges' }, edgeV.map(function (e, i) {
        var mx = (e.x1 + e.x2) / 2
        return h('g', { key: i },
          h('path', { className: 'etc-edge ' + (e.satisfied ? 'ok' : 'warn'), d: 'M' + e.x1 + ' ' + e.y1 + 'C' + mx + ' ' + e.y1 + ' ' + mx + ' ' + e.y2 + ' ' + e.x2 + ' ' + e.y2 }),
          h('path', { className: 'etc-edge-arrow' + (e.satisfied ? ' ok' : ''), d: 'M' + e.x2 + ' ' + e.y2 + 'l-6 -3.5v7z' }))
      }))
      var warns = []
      if (!L.depsKnown) warns.push(t('⚠ 这些任务没有 dependsOn：依赖无从得知 ⇒ 只给一列，不编造层次', '⚠ no dependsOn — dependencies unknown: single column, no invented layers'))
      if (L.cycles.length) warns.push(t('⚠ 依赖成环 ', '⚠ dependency cycle ') + L.cycles.map(function (x) { return '#' + x }).join(' ') + t('（单独成列，层号对它们无意义）', ' (own column; layer numbers are meaningless)'))
      if (L.unknownDeps.length) warns.push(t('⚠ ', '⚠ ') + L.unknownDeps.length + t(' 条依赖指向不存在的任务：', ' dep(s) point at missing tasks: ') + L.unknownDeps.slice(0, 6).map(function (u) { return '#' + u.from + '→#' + u.to }).join(' ') + (L.unknownDeps.length > 6 ? ' …' : ''))
      if (eg.skippedSameLayer) warns.push(t('⚠ ', '⚠ ') + eg.skippedSameLayer + t(' 条依赖同层或反向：只计数不画线（硬画会暗示错误的先后）', ' dep edge(s) same-layer/reversed: counted, not drawn (would imply a false order)'))
      var degrade = p.degrade || (!L.depsKnown && tasks.length ? t('降级：本 run 没有 TASKS.json（或 dependsOn 全空）⇒ 分层与箭头不可用，下面按单列平铺。', 'degraded: no TASKS.json in this run — layering and arrows unavailable; flat single column below.') : '')
      return h('div', { className: 'etc-root' },
        h('div', { className: 'etc-sec-h' }, t('编队', 'Formation')),
        h('div', { className: 'etc-formation' },
          h('div', { className: 'etc-leader' },
            h('span', { className: 'etc-avatar' }, roleAvatarSvg('lead', { lead: true, size: 64 })),
            h('div', { className: 'etc-leader-name' },
              // 名字胶囊写 `team-lead`（ASCII 名字/id，**不进 t()**）：旁边的 `.etc-badges` 已经打了「长」徽章，
              // 这里若再写中文"队长"，渲染出来是「队长 长 本会话」——同一个意思说两遍。
              h('span', { className: 'etc-name', title: F.lead.label || 'team-lead' }, esc(F.lead.label || 'team-lead')),
              h('span', { className: 'etc-badges' }, (F.lead.badges || []).map(function (b) { return h('span', { key: b.k, className: 'etc-badge' }, esc(b.text)) }))),
            h('div', { className: 'etc-lead-note' }, esc(F.lead.note || ''))),
          h('div', { className: 'etc-bus' },
            h('span', { className: 'etc-bus-line' }),
            h('span', { className: 'etc-assign' }, t('指派', 'Assign'))),
          F.members.length
            ? h('div', { className: 'etc-members' }, F.members.map(canvasMemberNode))
            : h('div', { className: 'etc-empty' }, esc((F.empty && F.empty.text) || t('本次 run 还没有成员', 'no members in this run')))),
        h('div', { className: 'etc-sec-h' }, t('共享任务列表', 'Shared task list')),
        degrade ? h('div', { className: 'etc-degrade' }, esc(degrade)) : null,
        warns.map(function (w, i) { return h('div', { key: i, className: 'etc-warn' }, esc(w)) }),
        // `.etc-edges` 是 `.etc-cols` 的绝对定位覆盖层 ⇒ 必须放在同一个滚动容器里（CSS 已给 position:relative + overflow-x:auto）
        h('div', { className: 'etc-cols', ref: boxRef }, edgeSvg, cols.map(function (c) { return canvasColNode(c, cctx) })),
        h('div', { className: 'etc-legend exp-legend' },
          h('span', { className: 'etc-edge-sample ok' }), t('依赖已满足', 'dep satisfied'),
          h('span', { className: 'etc-edge-sample' }), t('依赖未完成', 'dep pending'),
          h('span', { className: 'exp-muted' }, t('层号与箭头由本插件按 dependsOn 推导', 'layers & arrows derived here from dependsOn'))))
    }

    /**
     * F 线第 3 项：把 host 的 `settingsSchema()` + 当前设置编译成**表单行**（纯函数 ⇒ 可单测）。
     * UI 结构来自 host 的 spec（不在客户端另写一份默认值/值域），认不出的类型**如实标出来**
     * 而不是静默渲染成一个空控件 —— 那会让"新增了设置项但界面没跟上"变得看不见。
     */
    function settingsFormModel(schema, settings) {
      var groups = Array.isArray(schema) ? schema : []
      var vals = settings && typeof settings === 'object' ? settings : {}
      return groups.map(function (g) {
        var rows = (g.items || []).map(function (it) {
          var cur = vals[g.group] ? vals[g.group][it.key] : undefined
          var value = typeof cur === 'undefined' ? it.default : cur
          return {
            path: it.path, key: it.key, type: it.type, label: it.label, hint: it.hint || '',
            values: it.values || null, labels: it.labels || null, min: typeof it.min === 'number' ? it.min : null, max: typeof it.max === 'number' ? it.max : null,
            value: it.type === 'roles' ? (Array.isArray(value) ? value.join(', ') : '') : value,
            known: ['bool', 'int', 'enum', 'roles'].indexOf(it.type) >= 0,
          }
        })
        return { group: g.group, label: g.label, hint: g.hint || '', rows: rows }
      })
    }

    /**
     * 设置页：**只做四件事** —— 读（GET /settings）、渲染（照 schema）、存（POST，自动保存）、
     * **读失败要照实说**。
     *
     * 为什么读失败必须显式报错：旧实现是 `r.ok ? r.json() : null` —— 非 200 被静默丢成 null，
     * 于是永远停在「（正在读取设置…）」，既不报错也不超时。实测运行中的 `dsh web` 若启动早于
     * 本功能（宿主路由只在插件加载时注册），`GET /settings` 就是 **404**，用户看到的就是无限加载。
     *
     * 保存失败（400 的错误列表）与读失败分开渲染：读失败整页显示 +「重试」；保存失败只在表单
     * 下方出红字，**不把已经填好的表单整页换掉**，控件始终回滚到服务端的值 ——
     * "界面显示 A、服务端是 B"是最难排查的状态，宁可回滚也不装作成功。
     */
    /**
     * 面板把文案**原样渲染**（没有 markdown 渲染器）⇒ 服务端来的说明性文本要先去掉标记。
     * 客户端自己的字面量有一条 lint 盯着（`hindsight-config.test.mjs` 第⑨节），但**服务端塞进
     * 这些容器的文案**（notes / display / restartReason）不过那条 lint —— 所以在这里做一次收口，
     * 否则用户会看到 `**加载 profile 时**` 这种原文。
     */
    function plainText(s) {
      return String(s == null ? '' : s)
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    }

    /**
     * 记忆后端改动后的回执文案（**重启要求必须如实说**）。单一实现，两个调用点共用
     * （设置表单里那一行 / Hindsight 块里的三选一）—— 两处各写一套必然分叉。
     *
     * 四件事分得开（服务端的回执就是这么给的）：
     *   saved：这次有没有真的写盘（没有改动时**不假报已保存**）；
     *   notWired：`midas` 这次**没接通**（只记住了选择，实际仍走 Hindsight）—— 一期起它只在
     *     "二进制没找到 / 补丁那一行没落地"时为真，而不是"这个功能没做"；
     *   needsRestart：**只有真的改了 profile 补丁**才为 true（一次性动作，不是"永远要重启"）；
     *   restartReason：为什么（profile 在**加载时**读那份补丁）。
     *
     * ⚠️ 2026-09-17 拆出**分段**版本（`memoryBackendParts`）**不是**为了多一套文案：三选一那块要把
     * "需重启"单独提成显眼的告警框（用户原话：提示在最下面，可能看不到），又不能因此另写一句同义的
     * 话。所以句子仍由**这一个函数**产出，`memoryBackendMsg` 对外输出与拆分前**逐字相同**（两个调用
     * 点不用改），三选一那处只是把同一份分段拿去自己排版。
     */
    function memoryBackendParts(d) {
      var r = d && typeof d === 'object' ? d : {}
      var needRestart = !!r.needsRestart
      var saved = r.saved ? t('已保存', 'Saved') : t('没有改动、未写盘', 'No change — nothing written')
      var notWired = r.notWired ? t('Midas 未接通：这次只记住了选择，实际记忆仍走 Hindsight（profile 补丁里没有那一行，原因见下方引导）。', 'Midas is NOT connected: only the choice was stored; memory still goes through Hindsight (the patch has no such row — see the guide below).') : ''
      var restartHead = ''
      var restartWhy = ''
      if (needRestart) {
        restartHead = t('需重启 dsh web 才生效', 'restart dsh web to take effect')
        restartWhy = r.restartReason ? plainText(r.restartReason) : ''
      }
      // `receipt` = 告警框**没有**说的那半句（改动到底落盘没有 / 选的后端接通没有）；
      // `restart` = 完整那一句（含原因，与拆分前的整句逐字相同）。
      // 两段都由上面这几个字面量拼出 —— 没有任何一处再另写一句同义的话。
      var receipt = notWired ? saved + ' · ' + notWired : saved
      return {
        saved: saved,
        notWired: notWired,
        restartHead: restartHead,
        restartWhy: restartWhy,
        receipt: receipt,
        restart: restartHead ? restartHead + (restartWhy ? t('（', ' (') + restartWhy + t('）', ')') : '') : '',
      }
    }
    function memoryBackendMsg(d) {
      var p = memoryBackendParts(d)
      return p.restart ? p.receipt + ' · ' + p.restart : p.receipt
    }

    function SettingsSection() {
      var sS = useState(null); var data = sS[0], setData = sS[1]
      var mS = useState(''); var msg = mS[0], setMsg = mS[1]
      var eS = useState(''); var err = eS[0], setErr = eS[1]
      var lS = useState(''); var loadErr = lS[0], setLoadErr = lS[1]
      var rS = useState(0); var retry = rS[0], setRetry = rS[1]
      var loadingS = useState(true); var loading = loadingS[0], setLoading = loadingS[1]
      useEffect(function () {
        var alive = true
        setLoading(true); setLoadErr('')
        fetchSettingsPayload().then(function (res) {
          if (!alive) return
          setLoading(false)
          if (res.ok && res.d && res.d.ok && res.d.schema) { applyDisplaySettings(res.d.settings); setData(res.d); return }
          var detail = (res.d && (res.d.error || (res.d.errors || []).join('；'))) || ''
          setLoadErr(t('读取设置失败：HTTP ', 'Reading settings failed: HTTP ') + res.status + (detail ? ' ' + t('（', '(') + detail + t('）', ')') : ''))
        }).catch(function (e) {
          if (!alive) return
          setLoading(false)
          setLoadErr(t('读取设置失败：', 'Reading settings failed: ') + String(e && e.message ? e.message : e))
        })
        return function () { alive = false }
      }, [retry])
      function save(patch) {
        // ⚠️ `memory.backend` **不走** `/settings`（2026-09-17 更正）：选 `off` 时还要把 dsh profile 的
        // 补丁文件改成一致（给 `hindsight` 行加/去 `disabled: true`），而那份补丁是 profile **加载时**
        // 才读的 ⇒ 改它**需要重启 `dsh web`**。所以这一个键走专用路由
        // `/plugins/dsh-expert-team/memory-backend`，并由那条路由的回执如实给出重启要求。
        // （此前这里挂着「没有任何设置需要重启 ⇒ 死分支已删」—— 对这一个键它已不成立，那句话不能再留。）
        var mb = patch && typeof patch === 'object' ? patch['memory.backend'] : undefined
        if (typeof mb === 'string') { saveMemoryBackend(mb); return }
        setErr(''); setMsg('保存中…')
        fetch('/plugins/dsh-expert-team/settings', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) }).then(function (res) {
          if (!res.ok || !res.d || !res.d.ok) {
            setErr(((res.d && res.d.errors) || ['保存失败']).join('；'))
            setMsg('')
            return
          }
          setData(function (prev) { return { schema: (prev && prev.schema) || [], settings: res.d.settings, ok: true } })
          applyDisplaySettings(res.d.settings)   // 1.3.4：设置页改完 display 四项**当场生效**（不必重启/刷新）
          setMsg('已保存')   // 除「记忆 → 记忆后端」外，没有任何设置需要重启（那一项走专用路由，见 saveMemoryBackend）
        }).catch(function (e) { setErr(String(e && e.message ? e.message : e)); setMsg('') })
      }
      /** 记忆后端：走 `/memory-backend`（同一次调用里**落地 profile 补丁** + **存值**，并如实回 `needsRestart`）。 */
      function saveMemoryBackend(v) {
        setErr(''); setMsg('保存中…')
        fetch('/plugins/dsh-expert-team/memory-backend', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: v }),
        }).then(function (r) { return r.json().catch(function () { return null }).then(function (d) { return { ok: r.ok, d: d } }) }).then(function (res) {
          if (!res.ok || !res.d || !res.d.ok) {
            setErr(((res.d && (res.d.errors || [res.d.error])) || ['保存失败']).join('；'))
            setMsg('')
            return
          }
          setData(function (prev) { return { schema: (prev && prev.schema) || [], settings: res.d.settings || (prev && prev.settings) || {}, ok: true } })
          setMsg(memoryBackendMsg(res.d))
        }).catch(function (e) { setErr(String(e && e.message ? e.message : e)); setMsg('') })
      }
      if (loading) return h('div', { className: 'exp-settings' }, h('div', { className: 'exp-empty' }, t('（正在读取设置…）', '(loading settings…)')))
      if (loadErr) return h('div', { className: 'exp-settings' },
        h('div', { className: 'exp-err' }, '✗ ' + esc(loadErr)),
        h('div', { className: 'exp-settings-note' },
          esc(t('若是 404：运行中的 dsh web 启动早于本功能 —— 宿主的 /settings 路由在插件加载时才注册，重启 dsh web 后点「重试」即可。',
            'On a 404: the running dsh web started before this feature — the host /settings route registers at plugin load. Restart dsh web, then retry.'))),
        h('button', { className: 'exp-settings-retry', onClick: function () { setRetry(retry + 1) } }, esc(t('重试', 'Retry'))))
      if (!data || !data.schema) return h('div', { className: 'exp-settings' }, h('div', { className: 'exp-empty' }, t('（正在读取设置…）', '(loading settings…)')))
      var model = settingsFormModel(data.schema, data.settings)
      var hasInertMark = model.some(function (g) { return (g.rows || []).some(function (r) { return /暂未生效/.test(String(r.hint || '')) }) })
      var rows = []
      model.forEach(function (g) {
        rows.push(h('div', { key: 'h-' + g.group, className: 'exp-settings-group' }, esc(g.label) + (g.hint ? ' · ' + esc(g.hint) : '')))
        g.rows.forEach(function (r) {
          var ctl
          if (!r.known) {
            ctl = h('span', { style: { color: '#c0392b' } }, '未知类型 ' + esc(String(r.type)) + '（界面未跟上 spec）')
          } else if (r.type === 'bool') {
            ctl = h('input', { type: 'checkbox', checked: !!r.value, onChange: function (e) { save({ [r.path]: e.target.checked }) } })
          } else if (r.type === 'int') {
            ctl = h('input', { type: 'number', value: String(r.value), min: r.min === null ? undefined : r.min, max: r.max === null ? undefined : r.max, style: { width: 84 },
              onChange: function (e) { var v = e.target.value; if (v !== '' && /^-?\d+$/.test(v)) save({ [r.path]: Number(v) }) } })
          } else if (r.type === 'enum') {
            ctl = h('select', { value: String(r.value), onChange: function (e) { save({ [r.path]: e.target.value }) } },
              (r.values || []).map(function (v) { return h('option', { key: v, value: v }, esc((r.labels && r.labels[v]) || v)) }))
          } else {
            ctl = h('input', { type: 'text', value: String(r.value), placeholder: t('留空 = 按档位默认', 'empty = tier default'), style: { width: 168 },
              onBlur: function (e) { var v = e.target.value.trim(); save({ [r.path]: v === '' ? null : v.split(',').map(function (x) { return x.trim() }).filter(Boolean) }) } })
          }
          // 说明过长（>120 字）就让这一行换行、说明独占一行 —— 否则它会被控件列挤成一条
          // 又窄又高的文字柱（真机截图里「记忆后端」那行就是这样）。阈值取 120：spec 里现存的
          // hint 只有两条超过它，其余行（≤83 字）照旧排在控件右边，版面不受影响。
          rows.push(h('div', { key: r.path, className: 'exp-settings-row' + (String(r.hint || '').length > 120 ? ' exp-settings-row-wide' : '') },
            // ⚠️ 说明文本与 `title` 都要先过 `plainText()`（**只过 `esc()` 不够**）：面板没有 markdown
            // 渲染器，服务端来的 hint 一旦带标记就原样显示给用户 —— 真机截图里「记忆后端」那行就是
            // `三种选择**互斥**（…`，`**` 明晃晃挂在界面上（鼠标悬停的原生 title 气泡里同样带 `**`）。
            // `lib/settings.js` 的 hint **本来就该是纯文本**（现存 19 条里 18 条是，唯一带标记的就是这条），
            // 所以这里的 strip 是**防御性收口** —— 不靠"作者记得别写 markdown"这条纪律兜底。
            // 顺序固定为 `esc(plainText(...))`：先剥标记、再转义 HTML（与其它 10 处调用点同一套）。
            h('span', { className: 'exp-settings-label', title: plainText(r.hint) }, esc(r.label)),
            h('span', { className: 'exp-settings-ctl' }, ctl),
            h('span', { className: 'exp-settings-note', title: plainText(r.hint) }, r.hint ? esc(plainText(r.hint)) : null)))
        })
      })
      return h('div', { className: 'exp-settings' },
        // 这句必须按**事实**说（2026-09-15 审核逐项查过消费者后定的口径；2026-09-17 加了一条例外）：
        //   ① 上限 / 轮次 / 档位门 / 振荡检测开关 ⇒ `reapplySettingsDerived()` 在**进程内即时重算**；
        //   ② `身份`、`班底` 等 ⇒ 下一次 `/team` 建 run 时现读；
        //   ③ 除「记忆 → 记忆后端」外**没有任何一项需要重启** ⇒ 回执只说"已保存"（`needsRestart` 恒 false）。
        //      ⚠️ 例外：`memory.backend` 走专用路由（`/memory-backend`），它要改 dsh profile 的补丁文件，
        //      而 profile 是**加载时**读的 ⇒ **需要重启 dsh web**。那句话由那条路由给（见 MemoryBackendBlock），
        //      所以这里的 headline 必须点明这一条例外，不能笼统写"全部即时生效"。
        //   ④ 标着「暂未生效」的项 = **还没接线**（`INERT_SETTINGS`，见 lib/settings.js）：写在这里
        //      不是承诺，而是如实告知；逐项标记由 per-item hint 携带，不在这里重复。
        // 「暂未生效」那句**只在真有这种项时**才渲染（1.3.5）：INERT_SETTINGS 现在是空的，
        // 无条件渲染会让用户去找一个不存在的标注。判据直接取 hint 里的标记 ⇒ 与后端单一真源一致。
        h('div', { className: 'exp-settings-head' }, esc(hasInertMark
          ? t('改动即保存并即时生效（上限 / 轮次 / 档位门 / 振荡检测开关在进程内重算）。唯一例外是「记忆 → 记忆后端」：它要改 dsh profile 的补丁文件，需重启 dsh web 才生效（那一行会自己告诉你）。标着「暂未生效」的项尚未接线，改了不会有作用。',
            'Saved on change and applied immediately (caps, rounds, the tier gate and the oscillation switch are recomputed in-process). The one exception is "Memory → backend": it edits dsh\u2019s profile patch, so it needs a dsh web restart (that row says so itself). Items marked as not yet in effect are not wired up — changing them does nothing.')
          : t('改动即保存并即时生效（上限 / 轮次 / 档位门 / 振荡检测开关在进程内重算）。唯一例外是「记忆 → 记忆后端」：它要改 dsh profile 的补丁文件，需重启 dsh web 才生效（那一行会自己告诉你）。',
            'Saved on change and applied immediately (caps, rounds, the tier gate and the oscillation switch are recomputed in-process). The one exception is "Memory → backend": it edits dsh\u2019s profile patch, so it needs a dsh web restart (that row says so itself).'))),
        rows,
        h(SubagentOrderBlock),
        h(PresetLayBlock),
        h(HindsightBlock, {
          onSettings: function (s) { setData(function (prev) { return { schema: (prev && prev.schema) || [], settings: s, ok: true } }) },
          // 块里的「记忆后端」三选一与上面表单里那一行是**同一个键**：把当前值当刷新信号传下去，
          // 任一处改完，另一处都会重新拉服务端状态（否则界面会自相矛盾）。
          memoryBackend: String((((data.settings || {}).memory) || {}).backend || ''),
        }),
        h('div', { className: 'exp-settings-msg' + (err ? ' bad' : '') }, esc(err ? '✗ ' + err : (msg || ''))))
    }

    /**
     * 记忆后端（Hindsight）块：**诊断 + 配置**（1.3.18 一期只读诊断；1.3.21 二期加写路径）。
     *
     * 诊断部分（配置路径 · 形态 · 地址 · **token 是否已配置**（值绝不回显）· 最近失败已分类 + 可操作
     * hint · 可选一次连通性探测）保持不变；写部分只做三件事：改形态 / 改地址 / **设置或显式清除** token。
     *
     * 五条纪律（有测试盯着）：
     *   ① **token 值不回显** —— 输入框是 password、保存后立刻清空，界面只显示"已配置/未配置"；
     *   ② 空输入 = **保持原值不变**（要清除必须按「清除」按钮 —— 空串不等于删除）；
     *   ③ 保存后按**实际改了哪个键**提示是否要重启（改 `serverMode`/`apiUrl` 要重启，只改 token 不用）；
     *   ④ 没有改动 ⇒ 如实说"没有改动、未写盘"，**不假报已保存**；
     *   ⑤ 失败原样显示服务端给的 `errors`（不吞、不美化）。
     */
    /**
     * 子代理列表顺序的**生效状态**（只读）。
     *
     * 为什么单独一块：设置项的值只回答"想不想开"，这一块回答"**到底有没有生效**"——
     * 宿主结构不匹配时插件会静默退回宿主默认顺序，界面上必须能如实说出来。
     * 本仓纪律：不许在没生效时让人以为生效。
     */
    function SubagentOrderBlock() {
      var sS = useState(null); var st = sS[0], setSt = sS[1]
      useEffect(function () {
        fetch('/plugins/dsh-expert-team/subagent-order')
          .then(function (r) { return r.json().catch(function () { return null }) })
          .then(function (d) { setSt(d && d.ok ? d : null) })
          .catch(function () { setSt(null) })
      }, [])
      if (!st) return null   // 读不到状态就不占位、也不假报
      var label = st.effective
        ? t('已生效', 'Active')
        : (st.enabled
          ? t('未生效（已退回宿主默认顺序）', 'Not active (fell back to the host default)')
          : t('已关闭（用宿主默认：最旧在上）', 'Off (host default: oldest first)'))
      return h('div', { className: 'exp-settings-row' },
        h('div', { className: 'exp-settings-label' }, esc(t('子代理列表顺序', 'Subagent list order'))),
        h('div', { className: 'exp-settings-ctl' },
          h('span', { className: st.effective ? 'exp-hs-ok' : (st.enabled ? 'exp-hs-bad' : '') }, esc(label))),
        h('div', { className: 'exp-settings-note' }, esc(st.note || '')))
    }

    /**
     * 预设/技能铺设的**归属与状态**（只读 + 显式重铺）。
     *
     * 为什么必须有这一块：铺盘"没覆盖"的两种情形 —— 目录是**你自己的定制**、或目录**内容不完整**
     * （很可能是上次铺设被打断）—— 旧实现只打一行 warn ⇒ 界面上完全看不出来，
     * 而插件预设可能**再也铺不上**。本仓纪律：没铺上就必须说没铺上。
     *
     * 「重新铺设」要**再点一次确认**：它可能在用户明确要求下**覆盖掉自己的定制**，
     * 所以第一次点击只武装并说清会覆盖什么（与「清除 token」同一套防误触）。
     */
    function PresetLayBlock() {
      var sS = useState(null); var st = sS[0], setSt = sS[1]
      var mS = useState(''); var msg = mS[0], setMsg = mS[1]
      var eS = useState(''); var err = eS[0], setErr = eS[1]
      var bS = useState(false); var busy = bS[0], setBusy = bS[1]
      var aS = useState(false); var armed = aS[0], setArmed = aS[1]
      function load() {
        return fetch('/plugins/dsh-expert-team/preset-lay')
          .then(function (r) { return r.json().catch(function () { return null }) })
          .then(function (d) { setSt(d && d.ok ? d : null) })
          .catch(function () { setSt(null) })
      }
      useEffect(function () { load() }, [])
      if (!st) return null   // 读不到状态就不占位、也不假报
      function relay() {
        if (!armed) {
          setArmed(true); setErr('')
          setMsg(t('再点一次「确认重新铺设」才会真的覆盖当前目录。', 'Click “Confirm re-lay” once more to actually overwrite the current directory.'))
          return
        }
        setArmed(false); setBusy(true); setErr(''); setMsg('')
        fetch('/plugins/dsh-expert-team/preset-lay', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'relay' }),
        })
          .then(function (r) { return r.json().catch(function () { return null }) })
          .then(function (d) {
            setBusy(false)
            if (!d || !d.ok) { setErr(t('重新铺设失败：', 're-lay failed: ') + String((d && (d.error || (d.results && d.results.map(function (x) { return x.kind + '=' + (x.ok ? 'ok' : 'fail') }).join(',')))) || 'unknown')); return }
            // 如实回报**替换了什么**（不静默）——服务端把 before 一起回来了。
            var parts = (d.results || []).map(function (r) {
              if (r.skipped) return t(r.kind + '：走运行时注册，无需铺盘', r.kind + ': runtime registration, nothing laid')
              var b = r.before ? t('（原 ' + r.before.state + '，' + (r.before.missingBeforeLay || []).length + ' 项缺失）', ' (was ' + r.before.state + ')') : ''
              return r.kind + b
            })
            setMsg(t('已重新铺设 ', 're-laid ') + parts.join('；'))
            load()
          })
          .catch(function (e) { setBusy(false); setErr(t('重新铺设失败：', 're-lay failed: ') + String(e && e.message ? e.message : e)) })
      }
      function lineFor(kindLabel, disp) {
        if (!disp) return h('div', { className: 'exp-hs-kv' },
          h('span', { className: 'exp-hs-k' }, esc(kindLabel)),
          h('span', { className: 'exp-hs-v' }, esc(t('（尚无记录）', '(no record yet)'))))
        var cls = disp.level === 'ok' ? 'exp-hs-ok' : (disp.level === 'bad' ? 'exp-hs-bad' : '')
        return h('div', { className: 'exp-hs-kv' },
          h('span', { className: 'exp-hs-k' }, esc(kindLabel)),
          h('span', { className: 'exp-hs-v' }, h('span', { className: cls }, esc(t(disp.zh, disp.en)))))
      }
      var d = st.display || {}
      return h('div', { className: 'exp-hs' },
        h('div', { className: 'exp-settings-group' }, esc(t('预设铺设 · 归属与状态', 'Preset lay · ownership & state'))),
        lineFor(t('专家团模式 preset', 'Expert-team preset'), d.preset),
        lineFor(t('skill 副本', 'skill copy'), d.skill),
        h('div', { className: 'exp-settings-note' }, esc(t(
          '本插件版本 ' + ((st.preset && st.preset.pluginVersion) || '') + '。铺设用原子换名：先把整份内容写进临时目录，再整目录换名到位；所以被打断只会留下"目录不存在"或"我们自己的临时目录"，不会再留下"看起来像你的定制的半成品"。但删除旧目录与换名之间若被打断，目录会短暂不存在（下次自动重铺）—— 它消灭的是"假用户定制"，不是"任何时刻都存在一份完整副本"，所以它不是"完全原子"。',
          'Plugin version ' + ((st.preset && st.preset.pluginVersion) || '') + '. Laying is atomic by swapping a fully written temp directory into place, so an interruption leaves either no directory or our own temp dir — never a half copy that looks like your customization. If interrupted between removing the old directory and the swap, the directory can briefly be absent (it is re-laid next time); it removes the false-customization case, not the possibility of a momentary gap, so it is not fully atomic.'))),
        h('div', { className: 'exp-hs-actions' },
          h('button', { className: 'exp-hs-btn' + (armed ? ' danger' : ''), disabled: busy, onClick: relay },
            esc(armed ? t('确认重新铺设', 'Confirm re-lay') : t('重新铺设', 'Re-lay')))),
        msg ? h('div', { className: 'exp-hs-msg' }, esc(msg)) : null,
        err ? h('div', { className: 'exp-hs-msg bad' }, esc('✗ ' + err)) : null)
    }

    /**
     * 记忆后端**三选一**（hindsight / midas / off）—— 就放在 Hindsight 那个块里（用户看诊断的地方）。
     *
     * 为什么不能只靠设置表单里那个下拉（`memory.backend` 由 schema 自动生成，确实能改）：
     *   ① 设置项的值只回答"用户想选什么"；这一块回答"**现在到底走哪个后端**"（profile 补丁有没有真的禁用
     *      Hindsight、设置与实际是否一致）。两者会分叉（改了没落地 / 补丁被别的工具改回去），界面必须说出来；
     *   ② **"你选了不使用"与"你选了 Hindsight 但不通"绝不能渲染成同一个灰掉的东西** ——
     *      前者是你的选择，后者是故障（要去看下面的诊断），处置动作正好相反；
     *   ③ `midas` 本轮**未接通** ⇒ 明说"只记住了选择、实际仍走 Hindsight"（静默 no-op 是本仓最忌讳的形态）；
     *   ④ 改这一项**需要重启 dsh web**（profile 补丁在加载 profile 时读）⇒ 回执里的 `needsRestart` 必须显示。
     *
     * 三选一的候选值与中文标签都**来自服务端**（`lib/settings.js` 的 spec 是唯一真源）——
     * 客户端不另写一份值域，也就不可能与设置表单里那一行分叉。
     *
     * ⚠️ `refresh`：同一个键有**两个入口**（设置表单里那一行 / 这里的三选一）。在任一处保存后，
     * 另一处必须重新拉一次服务端状态 —— 否则会出现"上面那一行已经是 off，这一块还写着 Hindsight"的
     * 界面不一致（本仓名为最难排查的状态）。父组件把当前设置里的值当 `refresh` 传下来，它就是判据。
     */
    function MemoryBackendBlock(props) {
      var onSettings = (props && props.onSettings) || null
      var refresh = props && props.refresh
      var sS = useState(null); var st = sS[0], setSt = sS[1]
      var eS = useState(''); var err = eS[0], setErr = eS[1]
      var mS = useState(''); var msg = mS[0], setMsg = mS[1]
      // 结构化回执：只用来把"需重启"提到顶部那块显眼的告警框里（分段文案仍出自 `memoryBackendParts`）。
      var rcS = useState(null); var receipt = rcS[0], setReceipt = rcS[1]
      var bS = useState(false); var busy = bS[0], setBusy = bS[1]
      // ── 「移除 mcp-midas 那一行」的**两次点击**武装位（与 `HindsightBlock.armClear` 同一套先例）──
      // 第一次点只是武装（按钮文案变成"再点一次确认"），第二次才真的 POST。理由：这是一个**删用户
      // 补丁文件内容**的动作，误触的代价与「清除令牌」同级 ⇒ 沿用本仓既有的确认习惯，不另发明一种。
      // 刻意**不**复用 `receipt`：那条回执链（`memoryBackendParts`）描述的是"改了后端选择 ⇒ 要不要重启"，
      // 与"删掉一行"不是同一件事 —— 混进去会让顶部的重启告警框在最坏的时候说着上一轮的话
      // （⑦c 的「setReceipt 恰好两处」计数守卫也正是不许这里多出一处）。
      var rS = useState(false); var armRemove = rS[0], setArmRemove = rS[1]
      function load(withProbe) {
        // `?probe=1` 只有用户点「探测一次启动」时才带：那会在服务端**真的启动一次** Midas 进程做 MCP 握手，
        // 与 Hindsight 那条连通性探测同一口径（进页面不发任何探测请求）。
        return fetch('/plugins/dsh-expert-team/memory-backend' + (withProbe ? '?probe=1' : ''))
          .then(function (r) { return r.json().catch(function () { return null }) })
          .then(function (dd) { setSt(dd && dd.ok ? dd : null) })
          .catch(function () { setSt(null) })
      }
      useEffect(function () { load() }, [refresh])
      if (!st) return null   // 读不到状态就不占位、也不假报（与 SubagentOrderBlock 同口径）
      var values = (st.backends && st.backends.length) ? st.backends : ['hindsight', 'midas', 'off']
      var labels = st.labels || {}
      var cur = String(st.stored || 'hindsight')
      /** 复制一段命令：与「复制路径」同一套（`try/catch` 兜住没有 clipboard 的环境，复制失败不影响任何事）。 */
      function copyText(s) {
        try { navigator.clipboard.writeText(String(s == null ? '' : s)) } catch (e) { /* 复制失败不阻断 */ }
      }
      function apply(v) {
        setBusy(true); setErr(''); setMsg(''); setReceipt(null)   // 开新一轮就撤掉旧告警：绝不让人看着上一次的重启要求做这一次的决定
        fetch('/plugins/dsh-expert-team/memory-backend', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: v }),
        }).then(function (r) { return r.json().catch(function () { return null }).then(function (dd) { return { ok: r.ok, d: dd } }) }).then(function (res) {
          setBusy(false)
          if (!res.ok || !res.d || !res.d.ok) { setErr(((res.d && (res.d.errors || [res.d.error])) || ['保存失败']).join('；')); return }
          // 让上面那张设置表单同步到新值（"界面显示 A、服务端是 B"是最难排查的状态）。
          // 有 `onSettings` 时父组件会回传新设置 ⇒ `refresh` 变化 ⇒ 上面的 effect 自己重新拉一次；
          // 没有的话（本块被单独渲染）就这里自己拉，两种路径都不会停在旧状态。
          if (res.d.settings && onSettings) onSettings(res.d.settings)
          else load()
          setMsg(memoryBackendMsg(res.d))          // 整句回执（含重启那句）—— 与拆分前的输出逐字相同
          setReceipt(memoryBackendParts(res.d))    // 同一份字面量的分段版：顶部告警框排版用
        }).catch(function (e) { setBusy(false); setErr(String(e && e.message ? e.message : e)) })
      }
      /**
       * 移除补丁里那个 `- insert:` 包裹的 `mcp-midas` 行 —— 「选 off 也关不干净」的**一键处置**。
       *
       * 为什么要这个按钮：选 `off` 只写 `hindsight: disabled: true`，**不碰** `mcp-midas` 那一行 ⇒
       * Midas 的 MCP 服务照样随 dsh web 启动、它的工具照样注册，而界面原来只说"不会有任何记忆调用"。
       * 服务端已经把"那一行还在不在 / 能不能安全删"当成**独立事实**（`midasRowPresent` /
       * `midasRowRemovable`，与 `stored` 无关）发下来 ⇒ 客户端只在它说"能删"时才给这个按钮。
       *
       * 三条纪律：
       *   ① **不碰 `setReceipt`**：那条回执链是给"改后端选择"的（顶部重启告警框取它的分段文案）。
       *      删一行是另一件事，它的回执只走下面的 `setMsg` / `setErr` —— 否则重启告警框会拿着
       *      上一轮的形状说这一轮的话（⑦c 的「setReceipt 恰好两处」计数守卫也钉着不许这里多出一处）。
       *   ② **成功后回读一次真实状态**（`load()`），不自己把"我以为删掉了"当成事实：服务端回执里
       *      虽然带了 `state`，但走 `load()` 与 `apply()` 是同一条路径 ⇒ 界面停在旧状态的机会为零。
       *   ③ 回执如实说**这次到底改了没有**（`saved`/`changed`）与**要不要重启**（`needsRestart`）——
       *      没有改动时不许说"已删除"。
       */
      function removeMidasRow() {
        setBusy(true); setErr(''); setMsg(''); setArmRemove(false)   // 开新一轮一律先撤掉旧的武装位与旧回执
        fetch('/plugins/dsh-expert-team/memory-backend', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove-midas-row' }),
        }).then(function (r) { return r.json().catch(function () { return null }).then(function (dd) { return { ok: r.ok, d: dd } }) }).then(function (res) {
          setBusy(false)
          if (!res.ok || !res.d || !res.d.ok) { setErr(((res.d && (res.d.errors || [res.d.error])) || ['移除失败']).join('；')); return }
          load()   // 回读服务端真实状态（`midasRowPresent` 必须已经是 false —— 与 `apply()` 同一口径）
          var d = res.d
          // 没有改动 ⇒ 不许说"已删除"（"本来就没有"与"刚删掉"是两件事，服务端 `changed`/`saved` 分得开）。
          if (!d.saved) setMsg(t('本次没有改动 ⇒ 那一行本来就不在（或形态不认识、服务端没动它）。', 'No change was made — the row was not there (or its shape was unknown, so nothing was touched).'))
          else setMsg(d.needsRestart
            ? t('已移除 profile 补丁里那个 mcp-midas 行。⚠ 需要重启 dsh web 才生效（profile 补丁在加载 profile 时读取）。',
                'Removed the mcp-midas row from the profile patch. ⚠ A dsh web restart is required for it to take effect (the patch is read when the profile loads).')
            : t('已移除 profile 补丁里那个 mcp-midas 行。', 'Removed the mcp-midas row from the profile patch.'))
        }).catch(function (e) { setBusy(false); setErr(String(e && e.message ? e.message : e)) })
      }
      var disp = st.display || {}
      // 状态文字走**文本级**三档类（ok / bad / warn-text）。⚠️ 这里**必须**是 `exp-hs-warn-text` 而不是
      // `exp-hs-warn`：后者是一个告警**框**（margin/padding/边框/左重条/渐变背景），挂在这个内联 <span>
      // 上就会画出用户截图里那个"缺边的破框"—— 三档里**只有 warn 这一档**会这样（ok/bad 本来就只是文字色）。
      // `.exp-hs-warn` 只允许挂在块级容器上：本块顶部的重启提示、HindsightBlock 里那处当前故障告警框。
      var cls = disp.level === 'ok' ? 'exp-hs-ok' : (disp.level === 'bad' ? 'exp-hs-bad' : 'exp-hs-warn-text')
      var unreachableish = st.statusKind === 'on-failing' || st.statusKind === 'on-unconfigured'
      // ⚠️ 重启提示**必须显眼且靠上**（2026-09-17 用户原话：「重启提示出现了 但是在最下面 用户可能
      // 看不到 需要有明显提示」）。此前它只是最底下那行绿色回执里的一段 ⇒ 改完一屏之内看不到。
      // 现在复用本块既有的琥珀色重条（`.exp-hs-warn`）并加粗标题，紧跟在三选一**正下方**。
      // 文案一个字都不新写：整句仍由 `memoryBackendParts` 产出（标题 = restartHead，原因 = restartWhy）。
      var restartNotice = (receipt && receipt.restart)
        ? h('div', { className: 'exp-hs-warn exp-hs-restart', role: 'status' },
            h('div', { className: 'exp-hs-restart-h' }, esc('⚠ ' + receipt.restartHead)),
            receipt.restartWhy ? h('div', null, esc(t('原因：', 'Why: ') + receipt.restartWhy)) : null)
        : null
      // 底部回执只说告警框**没说**的那半句：重启要求已经显著提示过，同一句话印两遍会让人以为发生了两件事。
      var bottomMsg = err ? '✗ ' + err : String(msg || '')
      if (!err && receipt && receipt.restart) bottomMsg = receipt.receipt

      // ── Midas 首装引导（2026-09-19 一期）──────────────────────────────────────────────
      // 只在**用户真的选了 midas 且还没就绪**时渲染：一个块级 section（不是内联 span —— 内联挂盒子类
      // 就是 2026-09-17 那个"缺边的破框"的成因）。它是这一期的主要交付物：任何人装上本插件后，
      // 在这里就能看懂 Midas 是什么、现在卡在哪一步、下一步该敲哪条命令。
      //
      // 三条纪律：
      //   ① **结论在上、动作在下**：状态句仍由上面那一行「实际状态」给（`display`），这里不重写同义句；
      //   ② **命令全部来自服务端**（`midasSetup.steps`）—— 客户端是手写 bundle、不能 `import lib/`，
      //      硬编一份就等于"同一件事两个家"，profile 名一变就分叉（中文标签就是这样传过来的）；
      //   ③ **`unknown` 不给结论也不给命令清单的假安慰**：服务端在那一档会把"探测不可用"说清楚，
      //      这里照原样呈现（同一份 `steps` 仍在，因为"怎么装"在任何一档都是有用的事实）。
      var midasSetup = cur === 'midas' ? (st.midasSetup || null) : null
      var midasGuide = (midasSetup && !midasSetup.ready)
        ? h('div', { className: 'exp-hs-midas-guide', role: 'status' },
            h('div', { className: 'exp-hs-midas-guide-h' }, esc(t('Midas 还没接通 —— 按下面三步装好它', 'Midas is not connected yet — three steps to make it work'))),
            h('div', { className: 'exp-settings-note' }, esc(plainText(t(String((midasSetup.why || {}).zh || ''), String((midasSetup.why || {}).en || (midasSetup.why || {}).zh || ''))))),
            // 代价说在前面（不吹）：它不做整会话摘要 —— 这是它的设计取舍，不是缺陷，但必须让人知道。
            h('div', { className: 'exp-settings-note' }, esc(plainText(t(String((midasSetup.tradeoff || {}).zh || ''), String((midasSetup.tradeoff || {}).en || (midasSetup.tradeoff || {}).zh || ''))))),
            h('ol', { className: 'exp-hs-midas-steps' },
              (midasSetup.steps || []).map(function (sp, i) {
                return h('li', { key: 'midas-step-' + i },
                  h('span', null, esc(plainText(t(String(sp.zh || ''), String(sp.en || sp.zh || ''))))),
                  sp.command ? h('code', null, esc(String(sp.command))) : null,
                  sp.command ? h('button', { className: 'exp-hs-copy', onClick: function () { copyText(sp.command) } }, esc(t('复制', 'Copy'))) : null)
              })),
            // 找过哪里（诚实：结论从哪来）——`lookedAt` 是服务端截断好的**纯文本**，客户端不拼路径。
            midasSetup.lookedAt ? h('div', { className: 'exp-settings-note' }, esc(t('已经找过：', 'Already looked in: ') + plainText(midasSetup.lookedAt))) : null,
            // 探测（用户点了才真的启动一次进程）：这一档才区分得出"装了但起不来"。
            h('div', { className: 'exp-hs-actions' },
              h('button', { className: 'exp-hs-btn', disabled: busy, onClick: function () { setBusy(true); load(true).then(function () { setBusy(false) }) } },
                esc(t('探测一次启动（会真的启动一次 Midas）', 'Probe startup once (really starts Midas once)')))),
            (midasSetup.start && midasSetup.start.ok === false)
              ? h('div', { className: 'exp-hs-msg bad' }, esc(t('探测失败：', 'Probe failed: ') + plainText(String(midasSetup.start.error || '')) + (midasSetup.start.stderr ? t('；stderr 摘要：', '; stderr: ') + plainText(String(midasSetup.start.stderr)) : '')))
              : null,
            (midasSetup.start && midasSetup.start.ok === true)
              ? h('div', { className: 'exp-hs-msg' }, esc(t('探测成功：MCP 握手已通过（记忆要重启 dsh web 后才真的走它）。', 'Probe succeeded: the MCP handshake went through (memory only switches after a dsh web restart).')))
              : null)
        : null

      // ── 「off 但 mcp-midas 行还在」的诚实话 + 一键移除（2026-09-19）───────────────────────────
      // 为什么这块必须存在：选 `off` 只写 `hindsight: disabled: true`，**不碰**那个 `- insert:` 包裹的
      // `mcp-midas` 行 ⇒ Midas 的 MCP 服务照样随 dsh web 启动、`mcp__midas__*` 工具照样注册在模型的
      // 工具面上，而界面原来只说"不会有任何记忆调用" —— 那句话在那个格子里是**假的**。
      //
      // ⚠️ **防御性读法**（本轮硬约束）：服务端那两个新字段可能晚于本文件落地。所以判据一律写成
      // `st.midasRowPresent === true` 而不是真值判断 —— 旧服务端下它是 `undefined` ⇒ 这一段
      // **一个字都不渲染**（没有警告、没有按钮），既不误报也不假报。**绝不用 `!st.midasRowPresent`
      // 之类的反写**：那会把 `undefined` 当成"行不在"，等于替旧服务端编一个它没给的结论。
      // ⚠️ 渲染成**块级 `<div>` + 专用文字类 `.exp-hs-offwarn`**，不是 `exp-hs-warn`：后者是告警
      // **框**且被 ⑦d 钉在恰好 2 处（重启提示 / 诊断块故障），这里既不是那两处、也不该占用它。
      var midasRowLive = st.midasRowPresent === true
      // ⚠️ 告警的判据**不是** `midasRowLive`（2026-09-19 语义变更配套修复）：三选一现在真的是**互斥**的 ——
      // `midas` 档的**目标形态**就是 `{hindsight 行 disabled} × {mcp-midas 行在}`，而 `off` 档落地时会把
      // 那一行**连根删掉**；**同一个物理状态**在 `midas` 下是"已接通"（ok）、在 `off` 下才是"没写成的关闭
      // 动作的残留"（warn）。只看 `midasRowPresent` 就等于把这个不对称**抹平**：用户**成功**选中 Midas 时
      // 会看到下面这段"你这里是一堆残留"的琥珀告警 —— 与功能目的正好相反（本仓 2026-09-17 那个"缺边的
      // 破框"级别的自伤）。所以告警改键在**服务端自己的结论** `statusKind === 'off-midas-row-live'` 上：
      // 服务端**只**在 `stored === 'off' && hindsightDisabled && midasRowPresent` 时才发这一档
      //（`lib/memory-backend.js` 的 `off-midas-row-live`），这正是"这一格是残留"的**唯一**权威判据。
      // 为什么不在客户端自己再推一遍（`stored === 'off' && …`）：服务端已经是"这个组合坏不坏"的**唯一
      // 事实源**，客户端重推一次就是**同一件事两个家** —— 下次服务端改分档（本仓第一号返工来源）时两边
      // 必然分叉，而界面会拿旧口径说新状态。客户端只做一件事：**照渲染服务端给的结论**。
      // 这与本文件既有的 `unreachableish`（上面读 `st.statusKind === 'on-failing' / 'on-unconfigured'`）
      // 是**同一套成熟写法**，不是新发明。
      // ⚠️ 防御性读法照旧：旧服务端没有 `statusKind` ⇒ 它是 `undefined` ⇒ 这一段**一个字都不渲染**。
      var offLeftover = st.statusKind === 'off-midas-row-live'
      var midasRowId = plainText(String(st.midasRowId || 'mcp-midas'))
      var midasServerName = plainText(String(st.midasServerName || 'midas'))
      var midasRowWarn = offLeftover
        ? h('div', { className: 'exp-hs-offwarn', role: 'status' }, esc(t(
            '⚠ 补丁里那个 - insert: 包裹的 ' + midasRowId + ' 行还在 —— 所以这不是"记忆完全没接"。'
            + '重启 dsh web 后，' + midasServerName + ' 的 MCP 服务照样启动、它的工具照样注册在模型的工具面上。'
            + '区别在于：没有任何东西会自动调用它们 —— 本插件不再自动读写记忆，只有你自己（或别的会话）显式调那些工具时才会动到库。',
            '⚠ The - insert:-wrapped ' + midasRowId + ' row is STILL in the patch — so this is NOT "no memory wiring at all". '
            + 'After a dsh web restart the ' + midasServerName + ' MCP server still starts and its tools stay registered on the model\'s tool surface. '
            + 'The difference: nothing calls them automatically — this plugin no longer reads or writes memory on its own; only an explicit tool call (by you or another session) touches the store.')))
        : null
      // 只在服务端明确说"能安全删"时才给按钮；`midasRowPresent` 为真但删不动（读不到文件 / 形态不认识 /
      // 删完文件会非法）时**照旧显示警告、但把按钮去掉**，并如实说"得手工处置" ——
      // 给一个点了必然失败的按钮比不给按钮更糟（用户会以为是自己的操作错了）。
      var midasRowAction = (midasRowLive && st.midasRowRemovable === true)
        ? h('div', { className: 'exp-hs-actions' },
            h('button', { className: 'exp-hs-btn danger', disabled: busy, onClick: function () { if (armRemove) removeMidasRow(); else setArmRemove(true) } },
              esc(armRemove
                ? t('再点一次：移除 mcp-midas 那一行', 'Click again: remove the mcp-midas row')
                : t('移除 mcp-midas 那一行', 'Remove the mcp-midas row'))))
        : (midasRowLive
          ? h('div', { className: 'exp-settings-note' }, esc(t('这一行不能用这里的按钮安全移除（补丁读不到、或形态不认识）⇒ 请手工删掉它，然后重启 dsh web。',
              'This row cannot be safely removed by the button here (the patch is unreadable, or its shape is unknown) — delete it by hand, then restart dsh web.')))
          : null)
      // ⚠️ **渲染**用的是这个（与上面那条告警**同一个**判据）—— `midasRowAction` 回答的是"按钮做不做得
      // 出来"（**能力**问题），这里回答的是"这个按钮该不该出现在这一格"（**语境**问题）。两者都对，但只有
      // 后者是这一格要问的：健康的 `midas` 档下 `midasRowRemovable` 本来就是 true（那一行**确实**删得动，
      // 字段没说谎），所以只按能力判据渲染的话，一个**刚接通 Midas** 的用户会在"已接通"旁边看到一颗
      // 「移除 mcp-midas 那一行」的红色按钮 —— 那等于请他去拆自己刚配好的东西，与三选一互斥语义下
      // `midas` 档的目标形态**直接矛盾**（本仓第一号返工来源：同一件事两个家）。真想删的用户并不缺路径：
      // 选 `off` 保存一次（新语义下那一步会**真的**连行一起删掉），或自己编辑补丁文件。
      // 两块都键在 `offLeftover`（= 服务端的 `off-midas-row-live`）⇒ 告警与按钮**永远同进同退**，
      // 结构上不可能出现"有按钮没解释"或"有解释没按钮"。
      var midasRowActionShown = (offLeftover && st.midasRowRemovable === true)
        ? midasRowAction
        : (offLeftover
          ? h('div', { className: 'exp-settings-note' }, esc(t('这一行不能用这里的按钮安全移除（补丁读不到、或形态不认识）⇒ 请手工删掉它，然后重启 dsh web。',
              'This row cannot be safely removed by the button here (the patch is unreadable, or its shape is unknown) — delete it by hand, then restart dsh web.')))
          : null)

      return h('div', { className: 'exp-hs-form' },
        h('div', { className: 'exp-settings-group' }, esc(t('记忆后端 · 三选一', 'Memory backend · choose one'))),
        h('div', { className: 'exp-hs-row' },
          h('span', { className: 'exp-hs-label exp-hs-label-mb' }, esc(t('写哪个后端', 'Which backend'))),
          h('select', { className: 'exp-hs-select exp-hs-select-narrow', value: cur, disabled: busy, onChange: function (e) { apply(e.target.value) } },
            values.map(function (v) { return h('option', { key: v, value: v }, esc(labels[v] || v)) }))),
        restartNotice,
        h('div', { className: 'exp-hs-kv' },
          h('span', { className: 'exp-hs-k' }, esc(t('实际状态', 'Actual state'))),
          // `exp-hs-v-status` 只挂这一列：状态是一句中英混排的话，不需要共享的 `word-break:break-all`
          // （它会把拉丁词从中间劈开）；下一行「profile 补丁」的路径仍用共享的值列规则。
          h('span', { className: 'exp-hs-v exp-hs-v-status' }, h('span', { className: cls }, esc(plainText(t(String(disp.zh || ''), String(disp.en || disp.zh || ''))))))),
        h('div', { className: 'exp-hs-kv' },
          h('span', { className: 'exp-hs-k' }, esc(t('profile 补丁', 'Profile patch'))),
          h('span', { className: 'exp-hs-v' },
            h('code', null, esc(String(st.patchPath || ''))),
            h('span', { className: 'exp-settings-note' }, esc(st.patchExists
              ? (st.hindsightDisabled ? t('（Hindsight 行已禁用）', ' (the hindsight row is disabled)') : t('（Hindsight 行未禁用）', ' (the hindsight row is not disabled)'))
              : t('（文件不存在）', ' (file absent)'))))),
        // ── (D) 同一行里并排说出**另一个**补丁事实（2026-09-19）────────────────────────────
        // 为什么紧挨着「profile 补丁」那一行：这两件事说的是**同一个文件**里躺着的两行
        //（`hindsight` 行 / `mcp-midas` 行）—— 分开摆会让人以为要去看两个地方。
        // ⚠️ 非 midas 情形下这一整段是 `null` ⇒ 上面那句 Hindsight 文案**逐字不变**
        //（有测试钉着那句），旧服务端下同样一个字都不多。
        // ⚠️ 仍走防御性读法（`=== true`）：旧服务端 `undefined` ⇒ 不渲染、不编造。
        midasRowLive
          ? h('div', { className: 'exp-settings-note' }, esc(t('（另外：profile 补丁里 mcp-midas 那一行仍在）', ' (also: the mcp-midas row is still in the profile patch)')))
          : null,
        // 警告与「移除那一行」的按钮：紧跟「实际状态 / profile 补丁」这两行事实**正下方**
        //（约束：必须排在第一个 `exp-hs-kv` **之后** —— 首个 `exp-hs-kv` 是重启告警框定位的锚点）。
        // ⚠️ 两块都由服务端的 `off-midas-row-live` 决定（残留才说、残留才给按钮）—— 见上面那两段注释。
        midasRowWarn,
        midasRowActionShown,
        // Midas 首装引导：摆在「实际状态」那句实话**正下方**（先看到"现在没接通"，紧接着就是"怎么接通"）。
        midasGuide,
        // ⚠️ 这一句是这块界面存在的理由之一：把"故障"与"你的选择"分开说，别让人去关一个本来该开的开关。
        unreachableish
          ? h('div', { className: 'exp-settings-note' }, esc(t('注意：这与「你选了不使用」不是一回事 —— 你的选择是 Hindsight，只是它可能不通；先看下面的诊断，不要用「不使用」来绕过故障。',
            'Note: this is NOT the same as choosing "off" — Hindsight IS your selection, it just may be unreachable; read the diagnostics below instead of turning memory off to hide the failure.')))
          : null,
        (st.notes && st.notes.length) ? h('ul', { className: 'exp-hs-notes' }, st.notes.map(function (n, i) { return h('li', { key: 'mb' + i }, esc(plainText(n))) })) : null,
        h('div', { className: 'exp-hs-msg' + (err ? ' bad' : '') }, esc(bottomMsg)))
    }

    function HindsightBlock(props) {
      var onSettings = (props && props.onSettings) || null
      // 当前设置里的后端值 —— 只当"要不要重新拉状态"的刷新信号用（见 MemoryBackendBlock 注释）。
      var memoryBackend = (props && props.memoryBackend) || ''
      var dS = useState(null); var d = dS[0], setD = dS[1]
      var pS = useState(null); var probed = pS[0], setProbed = pS[1]
      var eS = useState(''); var err = eS[0], setErr = eS[1]
      var bS = useState(false); var busy = bS[0], setBusy = bS[1]
      // ── 写路径的表单状态：只装**用户正在输入的东西**，初始全空 ⇒ 绝不预填 token ──
      var mS = useState(''); var mode = mS[0], setMode = mS[1]
      var uS = useState(''); var url = uS[0], setUrl = uS[1]
      var tS = useState(''); var token = tS[0], setToken = tS[1]
      var gS = useState(''); var msg = gS[0], setMsg = gS[1]
      var wS = useState(false); var saving = wS[0], setSaving = wS[1]
      var cS = useState(''); var armClear = cS[0], setArmClear = cS[1]   // 「再点一次确认」武装的键（'' = 未武装）
      var nS = useState([]); var postNotes = nS[0], setPostNotes = nS[1]
      var sid = useCurrentSessionId()
      function load(withProbe) {
        var q = '/plugins/dsh-expert-team/hindsight-config'
        var sep = '?'
        if (withProbe) { q += sep + 'probe=1'; sep = '&' }
        if (sid) q += sep + 'sessionId=' + encodeURIComponent(String(sid))
        if (withProbe) { setBusy(true); setErr('') }
        return fetch(q).then(function (r) {
          return r.json().catch(function () { return null }).then(function (dd) { return { ok: r.ok, d: dd } })
        }).then(function (res) {
          setBusy(false)
          if (!res.ok || !res.d || !res.d.ok) {
            setErr(t('读取记忆后端诊断失败：', 'Reading memory-backend diagnostics failed: ') + String((res.d && res.d.error) || ''))
            return
          }
          if (withProbe) setProbed(res.d); else setD(res.d)
        }).catch(function (e) { setBusy(false); setErr(String(e && e.message ? e.message : e)) })
      }
      // 进页面只拉一次（**不带 probe** ⇒ 不发任何探测请求；探测必须由用户点）。
      useEffect(function () { load(false) }, [])
      function copyPath() {
        try { navigator.clipboard.writeText(String((d && d.path) || '')) } catch (e) { /* 复制失败不影响只读展示 */ }
      }
      /** 提交一次写：`body` 里**只放用户明确改动的键**（清除走 `clear`）。 */
      function submit(body) {
        setSaving(true); setErr(''); setMsg('')
        fetch('/plugins/dsh-expert-team/hindsight-config', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }).then(function (r) {
          return r.json().catch(function () { return null }).then(function (dd) { return { ok: r.ok, d: dd } })
        }).then(function (res) {
          setSaving(false)
          if (!res.ok || !res.d || !res.d.ok) {
            setErr(((res.d && res.d.errors) || [t('保存失败', 'save failed')]).join('；'))
            return
          }
          var r = res.d
          setPostNotes(r.notes || [])
          // 表单清空 —— **尤其是 token 输入框**（提交过就不再留在界面上）。
          setMode(''); setUrl(''); setToken(''); setArmClear('')
          setMsg(r.saved
            ? t('已保存', 'Saved') + ((r.changed || []).length ? '：' + r.changed.join('、') : '') + ' —— ' + (r.needsRestart
              ? t('需重启 dsh web 才生效', 'restart dsh web to take effect')
              : t('无需重启（token 在 401 时会重读）', 'no restart needed (the token is re-read on 401)'))
            : t('提交的内容与现有配置一致 ⇒ 没有改动、未写盘', 'Nothing changed — nothing was written'))
          load(false)
        }).catch(function (e) { setSaving(false); setErr(String(e && e.message ? e.message : e)) })
      }
      function saveForm() {
        var body = {}
        if (mode) body.serverMode = mode
        if (url.trim() !== '') body.apiUrl = url.trim()
        if (token !== '') body.apiToken = token
        if (!Object.keys(body).length) {
          setErr(t('表单是空的：请先改形态/地址，或填入 token（要清除已有 token 请按「清除 token」）。',
            'The form is empty: change the mode/URL or type a token (use “Clear token” to remove one).'))
          return
        }
        submit(body)
      }
      /** 显式清除：token 要**再点一次确认**（防误删）；地址一次即可。 */
      function clearKey(key) {
        if (key === 'apiToken' && armClear !== 'apiToken') {
          setArmClear('apiToken'); setErr('')
          setMsg(t('再点一次「确认清除 token」才会真正删除。', 'Click “Confirm clear token” once more to actually delete it.'))
          return
        }
        submit({ clear: [key] })
      }
      if (!d) {
        return h('div', { className: 'exp-hs' },
          h('div', { className: 'exp-settings-group' }, esc(t('记忆后端（Hindsight）· 诊断与配置', 'Memory backend (Hindsight) · diagnostics & settings'))),
          // 三选一自己从 `/memory-backend` 取状态 ⇒ 诊断读不到时**仍然**能选后端（两条路互不阻塞）。
          h(MemoryBackendBlock, { onSettings: onSettings, refresh: memoryBackend }),
          h('div', { className: 'exp-settings-note' }, esc(err || t('（正在读取记忆后端配置…）', '(loading memory backend…)')))
        )
      }
      var rows = []
      rows.push(h('div', { key: 'hs-path', className: 'exp-hs-kv' },
        h('span', { className: 'exp-hs-k' }, esc(t('配置文件', 'Config file'))),
        h('span', { className: 'exp-hs-v' }, h('code', null, esc(String(d.path || ''))),
          h('button', { className: 'exp-hs-copy', onClick: copyPath }, esc(t('复制路径', 'Copy path'))))))
      rows.push(h('div', { key: 'hs-exists', className: 'exp-hs-kv' },
        h('span', { className: 'exp-hs-k' }, esc(t('是否已配置', 'Configured'))),
        h('span', { className: 'exp-hs-v' }, d.exists
          ? h('span', { className: 'exp-hs-ok' }, esc(t('已找到配置文件', 'config file found')))
          : h('span', { className: 'exp-hs-bad' }, esc(t('未找到（可能未配置或使用默认值）', 'not found (unconfigured or using defaults)'))))))
      rows.push(h('div', { key: 'hs-mode', className: 'exp-hs-kv' },
        h('span', { className: 'exp-hs-k' }, esc(t('部署形态', 'Server mode'))),
        h('span', { className: 'exp-hs-v' }, esc(String(d.serverMode || t('（未声明）', '(not declared)'))))))
      rows.push(h('div', { key: 'hs-url', className: 'exp-hs-kv' },
        h('span', { className: 'exp-hs-k' }, esc(t('服务地址', 'API URL'))),
        h('span', { className: 'exp-hs-v' }, esc(String(d.apiUrlEffective || d.apiUrl || t('（未声明）', '(not declared)'))),
          d.apiUrl && d.apiUrlEffective && d.apiUrl !== d.apiUrlEffective
            ? h('span', { className: 'exp-settings-note' }, esc(t('（daemon 形态会强制本地地址）', ' (daemon mode forces the local URL)'))) : null)))
      rows.push(h('div', { key: 'hs-token', className: 'exp-hs-kv' },
        h('span', { className: 'exp-hs-k' }, esc(t('访问令牌', 'API token'))),
        h('span', { className: 'exp-hs-v' }, d.apiTokenConfigured
          ? h('span', { className: 'exp-hs-ok' }, esc(t('已配置 ✓（值不显示）', 'configured ✓ (value never shown)')))
          : h('span', { className: 'exp-hs-bad' }, esc(t('未配置', 'not configured'))))))
      if (d.bankForWorkspace) {
        rows.push(h('div', { key: 'hs-bank', className: 'exp-hs-kv' },
          h('span', { className: 'exp-hs-k' }, esc(t('本工作区的 bank', 'Bank for this workspace'))),
          h('span', { className: 'exp-hs-v' }, h('code', null, esc(String(d.bankForWorkspace))))))
      }
      if (d.lastFailure && d.lastFailure.summary) {
        // ⚠️ 历史失败 ≠ 当前故障（2026-09-16 两次纠错；第二次是"证据撑不起结论"）：
        //   ① 旧实现一律按"当前故障"渲染 ⇒ 把两小时前的失败以现在时呈现（已修）；
        //   ② 第二次修的：判"已恢复"**必须用同类证据** —— 那次失败是 `retain_failed`（写 memories），
        //      而旧判据（一个把**一切无 error 记录**都算成"成功"的混合计数）把 `inject_ok`（读路径）、`session_start`（生命周期）、
        //      `reflect_deferred_new_bank`（**被推迟**，根本没干活）全算成"成功" ⇒ 界面说"已恢复"，
        //      但读者无法从中判断**写入**是否恢复。现在只认 `sfa.recovered`（= 其后有**同操作**的 `_ok`），
        //      并在话术里点明是**哪一类**成功；证据不足时**一律按当前故障渲染**，绝不说"已恢复"。
        var lf = d.lastFailure
        var sfa = (lf.sinceFailure && typeof lf.sinceFailure === 'object') ? lf.sinceFailure : null
        var same = (sfa && sfa.sameKind && typeof sfa.sameKind === 'object') ? sfa.sameKind : null
        var recovered = !!(sfa && sfa.recovered === true)
        var HS_OP_LABEL = {
          retain: ['记忆写入 retain', 'memory write (retain)'],
          pages: ['知识页写入 pages', 'knowledge-page write (pages)'],
          inject: ['召回读取 inject', 'recall / inject'],
          reflect: ['反思 reflect', 'reflect'],
        }
        // 未知操作**原样显示**事件里那个词（不替它编一个好听的名字 —— 分类是观察，不是结论）
        var hsOpLabel = function (op) {
          var key = String(op == null ? '' : op)
          var pair = HS_OP_LABEL[key]
          if (pair) return t(pair[0], pair[1])
          return key ? key : t('（未知操作）', '(unknown op)')
        }
        // "其它类别的成功"要摆出来，但**必须**同时说清它们不构成证据
        var hsOtherCounts = function () {
          if (!sfa || !sfa.byKind || typeof sfa.byKind !== 'object') return ''
          var parts = []
          var label = { write: ['写入', 'write'], read: ['读取', 'read'], reflect: ['反思', 'reflect'], lifecycle: ['生命周期', 'lifecycle'], unknown: ['未知类别', 'unknown'] }
          for (var k in label) {
            if (!Object.prototype.hasOwnProperty.call(label, k)) continue
            var b = sfa.byKind[k]
            if (!b || !(b.ok > 0)) continue
            if (k === (same && same.kind)) continue
            parts.push(t(label[k][0], label[k][1]) + ' ' + String(b.ok))
          }
          if (sfa.emptyRecalls > 0) parts.push(t('召回为空', 'empty recalls') + ' ' + String(sfa.emptyRecalls))
          return parts.length ? t('（另有：', '(also: ') + parts.join(' / ') + t(' —— 它们不构成"这一类已恢复"的证据）', ' — they do NOT prove THIS kind recovered)') : ''
        }
        if (recovered) {
          rows.push(h('div', { key: 'hs-fail', className: 'exp-hs-hist' },
            h('div', null,
              h('span', { className: 'exp-hs-tag exp-hs-tag-ok' }, esc(t('历史 · 已恢复', 'historical · recovered'))),
              h('span', { className: 'exp-hs-tag' }, esc(String(lf.classification || 'unknown'))),
              esc(' ' + String(lf.at || '') + (lf.event ? ' · ' + String(lf.event) : ''))),
            h('div', null, esc(t('这是 ', 'This failure happened at ') + String(lf.at || '')
              + t(' 的历史失败（', ' ; it was a ')
              + hsOpLabel(same && same.op)
              + t(' 失败）；此后已有 ', ' failure); since then there have been ')
              + String((same && same.count) || 0)
              + t(' 次同类成功', ' same-operation successes')
              + (same && same.lastAt ? t('（最近 ', ' (latest ') + String(same.lastAt)
                + (same.lastMs == null ? '' : t('，耗时 ', ', took ') + String(same.lastMs) + ' ms') + '）' : '')
              + t('。它现在不是当前故障 —— 因此不给你整改动作。', '. It is NOT a current failure, so no fix is suggested.'))),
            h('div', null, esc(hsOtherCounts())),
            h('div', { className: 'exp-hs-hint' }, esc(String(lf.summary || '')))))
        } else {
          var basis = (sfa && sfa.recovered === false)
            ? t('尚无同类成功', 'no same-operation success yet')
            : t('无法判定（缺后续证据）', 'cannot tell (no later evidence)')
          rows.push(h('div', { key: 'hs-fail', className: 'exp-hs-warn' },
            h('div', null, h('span', { className: 'exp-hs-tag' }, esc(String(lf.classification || 'unknown'))),
              esc(' ' + String(lf.at || '') + (lf.event ? ' · ' + String(lf.event) : '')),
              h('span', { className: 'exp-hs-tag' }, esc(basis))),
            h('div', null, esc(sfa && sfa.recovered === false
              ? t('这条失败是「', 'The failure was in ') + hsOpLabel(sfa.lastFailureOp)
                + t('」；此后没有同一个操作的成功记录 ⇒ 不能据此说它已恢复。', ' — there is NO later success for that same operation, so it cannot be called recovered.')
              : t('拿不到"此后有没有同类成功"的证据（诊断日志读不到或字段缺失）⇒ 不做判断。', 'No evidence about later same-operation successes (diag log unreadable or fields missing) — no judgement made.'))),
            h('div', null, esc(hsOtherCounts())),
            h('div', null, esc(String(lf.summary || ''))),
            h('div', { className: 'exp-hs-hint' }, esc(t('这说明什么：', 'What this means: ') + String(lf.hint || '')))))
        }
      }
      if (probed) {
        rows.push(h('div', { key: 'hs-probe', className: 'exp-hs-kv' },
          h('span', { className: 'exp-hs-k' }, esc(t('连通性', 'Reachability'))),
          h('span', { className: 'exp-hs-v' }, probed.reachable === true
            ? h('span', { className: 'exp-hs-ok' }, esc(t('可达 ✓ ', 'reachable ✓ ') + String(probed.probeMs == null ? '' : probed.probeMs + ' ms')))
            : h('span', { className: 'exp-hs-bad' }, esc(t('不可达 ✗ ', 'unreachable ✗ ') + String(probed.probeMs == null ? '' : probed.probeMs + ' ms'))))))
      }
      var notes = (d.notes || []).concat(probed && probed.notes ? probed.notes : []).concat(postNotes)
      // ── 写路径表单：只呈现"能改什么"，**不呈现任何已存的值**（token 尤其）──────────────
      // 空输入 = 保持原值不变；清除是**独立按钮**（token 还要再点一次确认）——
      // 空串当删除是最难排查的一类隐式语义，这里刻意不做。
      var form = h('div', { className: 'exp-hs-form' },
        h('div', { className: 'exp-hs-row' },
          h('span', { className: 'exp-hs-label' }, esc(t('部署形态', 'Server mode'))),
          h('select', { className: 'exp-hs-select', value: mode, onChange: function (e) { setMode(e.target.value) } },
            h('option', { value: '' }, esc(t('（不修改）', '(leave unchanged)'))),
            ['cloud', 'self-hosted', 'daemon'].map(function (m) { return h('option', { key: m, value: m }, m) }))),
        h('div', { className: 'exp-hs-row' },
          h('span', { className: 'exp-hs-label' }, esc(t('服务地址', 'API URL'))),
          h('input', { className: 'exp-hs-input', type: 'text', value: url, spellCheck: false,
            placeholder: t('留空 = 不修改（不要带 /v1）', 'empty = keep (do not include /v1)'),
            onChange: function (e) { setUrl(e.target.value) } })),
        h('div', { className: 'exp-hs-row' },
          h('span', { className: 'exp-hs-label' }, esc(t('访问令牌', 'API token'))),
          h('input', { className: 'exp-hs-input', type: 'password', value: token, autoComplete: 'off', spellCheck: false,
            placeholder: d.apiTokenConfigured
              ? t('已配置（留空 = 不修改；值不显示）', 'configured (empty = keep; value never shown)')
              : t('未配置（留空 = 不修改）', 'not configured (empty = keep)'),
            onChange: function (e) { setToken(e.target.value) } })),
        h('div', { className: 'exp-hs-actions' },
          h('button', { className: 'exp-hs-btn', onClick: saveForm, disabled: saving },
            esc(saving ? t('保存中…', 'saving…') : t('保存', 'Save'))),
          h('button', { className: 'exp-hs-btn danger', onClick: function () { clearKey('apiToken') }, disabled: saving || !d.apiTokenConfigured },
            esc(armClear === 'apiToken' ? t('确认清除 token', 'Confirm clear token') : t('清除 token', 'Clear token'))),
          h('button', { className: 'exp-hs-btn', onClick: function () { clearKey('apiUrl') }, disabled: saving || !d.apiUrl },
            esc(t('清除地址', 'Clear URL')))),
        h('div', { className: 'exp-hs-msg' + (err ? ' bad' : '') }, esc(err ? '✗ ' + err : (msg || ''))))
      return h('div', { className: 'exp-hs' },
        h('div', { className: 'exp-settings-group' }, esc(t('记忆后端（Hindsight）· 诊断与配置', 'Memory backend (Hindsight) · diagnostics & settings'))),
        // 三选一摆在最上面：它是"要不要用记忆"这个更上位的问题，诊断回答的是"配好了没有/通不通"。
        h(MemoryBackendBlock, { onSettings: onSettings, refresh: memoryBackend }),
        rows,
        // 这段以前是**一整块文字**（用户读不到重点，一屏之内也找不到"要不要重启"）。
        // 拆成一屏可扫的条目：每条只讲一件事。与三选一顶部那条琥珀色告警**分工明确** ——
        // 那条是**事件**（这一次真的改了补丁），这里是**一直成立的规则**，所以读起来不重复。
        h('ul', { className: 'exp-hs-notes' },
          h('li', null, esc(t('重启语义：改 serverMode / apiUrl 需要重启 dsh web；只改 apiToken 不需要（401 时会重读）。',
            'Restart semantics: changing serverMode / apiUrl needs a dsh web restart; changing apiToken alone does not (it is re-read on 401).'))),
          h('li', null, esc(t('上面的「记忆后端」若真的改了 profile 补丁，同样必须重启才生效（改完会在选择器正下方显著提示）。',
            'If the backend selector above actually changed the profile patch, that also needs a restart (you get a prominent notice right under the selector).'))),
          h('li', null, esc(t('保存前先校验；写入保留文件里其它键，并以 0600 权限原子替换。',
            'Writes are validated first, keep every other key in the file, and replace it atomically with mode 0600.'))),
          h('li', null, esc(t('token 的值在任何地方都不会回显（输入框也不预填）。',
            'The token value is never echoed anywhere (the field is never pre-filled).')))),
        form,
        h('button', { className: 'exp-settings-retry', onClick: function () { load(true) }, disabled: busy },
          esc(busy ? t('探测中…', 'probing…') : t('检测连通性', 'Check connectivity'))),
        notes.length ? h('ul', { className: 'exp-hs-notes' }, notes.map(function (n, i) { return h('li', { key: 'n' + i }, esc(String(n))) })) : null)
    }

    function DecisionCard(props) {
      var d = props.decision || {}
      var options = (d.options || []).map(function (o) {
        var v = typeof o === 'string' ? o : o.label
        var id = typeof o === 'string' ? o : (o.id || o.label)
        return h('button', { key: id, className: 'exp-opt', onClick: function () { props.onChoose(id, v) } }, esc(v))
      })
      return h('div', { className: 'exp-decision' },
        h('div', { className: 'exp-decision-title' }, esc(d.title || t('等待你的决策', 'Your decision needed'))),
        d.prompt ? h('div', { className: 'exp-muted', style: { margin: '4px 0 8px' } }, esc(d.prompt)) : null,
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, options))
    }

    // ── 标签 → 重分节映射（性能收尾批次：把"后台一直在拉三块"变成"只拉当前可见的那一块"）──
    // 依据是各标签**实际渲染所用的字段**（读代码得出，不是猜）：
    //   `team`（人）：agents/members/roles/wfRuns（people）+ 每个成员的实时操作流（feed）
    //   `tasks`（事）：依赖图的人员标签来自 people；任务本身在 summary 里（便宜）；
    //                  任务详情要 files/logTail（artifacts）⇒ 选中时**一次性**补拉（见下）
    //   `info`（料）：违规/覆盖率在 summary 里；实时日志（logTail）需要 artifacts
    //   `board`（盘）：只渲染 runs[]（summary 里已有）⇒ **不需要任何重分节**
    // 这条映射是单一真源：订阅与"选中任务补拉"都读它，护栏测试也钉它。
    function heavySectionsForTab(tb) {
      if (tb === 'info') return 'artifacts'
      if (tb === 'tasks') return 'people,feed' // feed 是内存切片（近乎免费），与徽章同 URL ⇒ 合并成一条
      if (tb === 'board') return ''
      return 'people,feed' // team（默认）与人相关视图
    }

    // ── 分节负载的合并（2026-09-15 性能修复 #3；2026-09-16 缺陷 C 修正）──────────────
    // 为什么必须合并而不是替换：首屏只发 `?section=summary`（便宜：阶段/进度/计数），
    // "人/料/事件流"晚一拍才到。若直接 `setData(d)`，摘要那一拍会把上一拍已知的成员/事件流
    // **抹掉**（UI 闪空、通知误判"成员消失"）。规则：**新负载里有的键覆盖旧值，没有的键保留**
    // —— 缺块 ≠ 空数据；`sections` 字段如实告诉 UI"这份负载包含哪些块"（两种零可区分）。
    // 放在**模块级**（不再嵌在 Panel 里）：面板的 `onState` 与徽章/胶囊共用的
    // `publishToLive`（liveStore）必须走**同一条**规则，否则徽章那一份仍会被 summary 拍掉成员。
    //
    // ⚠️ 但"新负载里**有**这个键"≠"这个键**算过**"（真机根因，2026-09-16 实测，非推断）：
    //   `?section=summary`（以及 `?section=artifacts`）的响应里**照样带** `members`/`agents`/`feed`
    //   三个键，而它们是**没算过的桩值** —— host 只在 `want('people')`/`want('feed')` 时才 enrich：
    //     lib/command.js：`if (want('people')) sel.members = enrichMembers(...)`
    //                     `sel.agents = want('people') ? subs.map(...) : []`
    //                     `if (want('feed')) { ... }` 然后 `sel.feed = feed`
    //   同一个 run 实测：`section=summary` ⇒ `members:{}`、`agents:[]`、`feed:{}`（`roles` 却永远有 6 条）；
    //   `section=people,feed` ⇒ `members` 6 条 enriched（pm:Zoe / architect:Ivy / researcher:Alex …）。
    //   ⇒ "新键覆盖旧键"就等于让**快的那一发**（summary，3 s）每 tick 把慢的那一发
    //   （people,feed，≥6 s）刚 enrich 出来的成员抹回 `{}` ⇒ 真机 `.etc-member` 恒为 0，
    //   而「人」页签仍能从 `roles` 列出 6 个角色 —— 这就是"有角色、没成员"的来源。
    // 规则（上面 warming/scopeCaps 那条纪律的延伸）：**负载没声明 people/feed 分节 ⇒
    //   `members`/`agents`/`feed` 是"没算"，不是"没有" ⇒ 保留旧值**。真的没有成员时，
    //   people 那一发会带着 `sections:['summary','people',…]` 明确清空 —— 两种零仍然分得开。
    function mergeStatePayload(prev, d) {
      if (!d || typeof d !== 'object') return d
      if (!prev || typeof prev !== 'object' || prev.ok !== true) return d
      var out = {}, k
      for (k in prev) { if (Object.prototype.hasOwnProperty.call(prev, k)) out[k] = prev[k] }
      for (k in d) { if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k] }
      var secs = Array.isArray(d.sections) ? d.sections : []
      // 只有**显式声明了分节**的负载才谈得上"这一段算没算"；完整负载（不带 `sections`）照旧全量覆盖。
      var scoped = secs.length > 0
      var keepDerived = function (keys) {
        keys.forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(prev, key)) out[key] = prev[key]
          else delete out[key]   // 连桩值也不留："没算过"不许冒充"是空的"
        })
      }
      if (scoped && secs.indexOf('people') < 0) keepDerived(['members', 'agents'])
      if (scoped && secs.indexOf('feed') < 0) keepDerived(['feed'])
      // 标记类字段（`warming` / `scopeCaps`）**只在非空时下发**，而上面的合并"缺键 = 保留旧值"
      // ⇒ 一旦出现过就**永久粘住**（"更新中"徽章再也消不掉 = 常亮的噪声，正是本轮要治的病）。
      // `sections` 含 people 时（连续的 `people,feed` 重负载）这一发**重算过**这两个标记
      // ⇒ 缺席即"现在真的没有"，必须清掉。
      // 只认 people：summary 那一发**根本没算**它们，那时"缺键"只能表示"没算"，
      // **不能**表示"没有"（否则等于拿"没算"覆盖"有" —— 缺块被当成空数据）。
      // ⚠️ `degraded` **不**在这里清：它的条目跨分段产生（people 的 `subs:`/`wf:` 与 artifacts 的
      // `artifacts:`/`files:`），而一次重分节只覆盖一个分段 ⇒ 一刀清掉会把另一分段的**真**告警
      // 抹成"一切正常"。这条已如实记进 CHANGELOG 的未修边界。
      if (secs.indexOf('people') >= 0) {
        if (!d.warming) delete out.warming
        if (!d.scopeCaps) delete out.scopeCaps
      }
      return out
    }

    function Panel(props) {
      var sidProp = (props && props.sessionId) || ''
      var viewMode = (props && props.mode) === 'view'
      var sessionId = sidProp || useCurrentSession()
      var isOpen = useOpen()
      var nativeWf = useNativeWf()
      var docked = useDocked()
      var pos = usePanelPos()
      useLang() // re-render when the shell language changes
      var pw = usePanelWidth()
      // 1.3.4：display 四项在这里取（挂载时拉一次设置；保存后即时通知更新）
      var dispCfg = useDisplaySettings()
      var dataS = useState(null), data = dataS[0], setData = dataS[1]
      var runsMetaS = useState([]); var runsMeta = runsMetaS[0], setRunsMeta = runsMetaS[1]
      var selTask = useState(null); var selTaskV = selTask[0], setSelTask = selTask[1]
      var selArt = useState(null); var selArtV = selArt[0], setSelArt = selArt[1]
      var artText = useState(null); var artTextV = artText[0], setArtText = artText[1]
      var selRun = useState(null); var selRunV = selRun[0], setSelRun = selRun[1]
      var feedS = useState(null); var feedRole = feedS[0], setFeedRole = feedS[1]
      // 按 agentId 看实时细节流（对话流 workflow 卡的成员未必能反查到角色）
      var feedAS = useState(null); var feedAgent = feedAS[0], setFeedAgent = feedAS[1]
      var qState = useState(''); var qV = qState[0], setQ = qState[1]
      var qHitsState = useState(null); var qHitsV = qHitsState[0], setQHits = qHitsState[1]
      var qInfoS = useState(null); var qInfoV = qInfoS[0], setQInfo = qInfoS[1]
      var fileS = useState(null); var fileV = fileS[0], setFileV = fileS[1]
      var prevActRef = useRef(null)
      var prevDecRef = useRef(0)
      var hoverS = useState(null); var hoverId = hoverS[0], setHover = hoverS[1]
      // 默认视图 = 编队画布：它同时回答"这轮谁在编队里"和"任务按依赖怎么排"，是信息密度最高的入口；
      // dag / panorama 保留为可切换视图（一个都没删）。
      var view = useState('canvas'); var viewV = view[0], setView = view[1]
      var tabS = useState(null); var tab = tabS[0] || dispCfg.defaultTab; var setTab = tabS[1]   // 1.3.4：初始页签来自设置 display.defaultTab
      var listOpenS = useState(false); var listOpen = listOpenS[0], setListOpen = listOpenS[1]
      // 流转视图（波次带）自己的 UI 状态：宽视图 / 波折叠 / 未绑定任务展开
      var wideS = useState(false); var wideV = wideS[0], setWide = wideS[1]
      var cwS = useState({}); var collapsedWaves = cwS[0], setCollapsedWaves = cwS[1]
      var ubS = useState(false); var unboundOpen = ubS[0], setUnboundOpen = ubS[1]
      // 全景图的可画宽度：**实测容器宽度**，不能拿"侧栏宽度 360"当全屏画布的宽度。
      // 旧实现用 pw（停靠面板宽度偏好，默认 360）算 NODE_W ⇒ 在**全屏画布**里卡片被挤成
      // 一小撮、右侧留一大片空白；同时 `wideV`（宽视图按钮）当时压根没接进宽度计算，是个死按钮。
      var flowWS = useState(0); var flowW = flowWS[0], setFlowW = flowWS[1]
      useEffect(function () {
        function measure() {
          try {
            var be = document.querySelector('.exp-body') || document.querySelector('.exp-panel')
            var w = be && be.clientWidth ? be.clientWidth : 0
            if (w) setFlowW(w)
          } catch (e) { /* best-effort */ }
        }
        measure()
        try { window.addEventListener('resize', measure) } catch (e) {}
        return function () { try { window.removeEventListener('resize', measure) } catch (e) {} }
      }, [viewMode, docked])
      // 消费对话流卡片发来的「聚焦意图」：role → 该角色的进行中任务 + 实时操作流；task → 直接选中。
      // 只处理新 seq，避免轮询重渲染时重复应用。
      var focusIv = useFocusIntent()
      var wfPhaseIv = useWfPhases()
      var focusSeqRef = useRef(0)
      useEffect(function () {
        if (!focusIv || !focusIv.seq || focusIv.seq === focusSeqRef.current) return
        try {
          if (focusIv.kind === 'task' && focusIv.task) { focusSeqRef.current = focusIv.seq; setTab('team'); setSelTask(focusIv.task); return }
          if (focusIv.kind === 'role' && focusIv.role) {
            var arr = ((data && data.tasks) || [])
            var active = arr.filter(function (x) { return x && x.owner === focusIv.role && ['in_progress', 'claimed', 'rework'].indexOf(x.status) >= 0 })[0]
            if (!active) active = arr.filter(function (x) { return x && x.owner === focusIv.role })[0]
            // 任务列表可能还没拉到：此时不消费该意图，等 data 到达后由依赖变化再应用一次。
            if (!active && !arr.length) return
            focusSeqRef.current = focusIv.seq
            setTab('team')
            setFeedRole(focusIv.role)
            if (active) setSelTask(active)
            return
          }
          // kind:'agent' —— 对话流 workflow 卡的成员行（拿得到 childId，未必知道角色）：
          // 先按 childId 反查角色（members[r].id）；查不到就退化成"只看该 agent 的实时细节流"。
          if (focusIv.kind === 'agent' && focusIv.agentId) {
            var role = ''
            var mem = (data && data.members) || {}
            Object.keys(mem).forEach(function (r) { if (!role && mem[r] && String(mem[r].id || '') === String(focusIv.agentId)) role = r })
            var arr2 = ((data && data.tasks) || [])
            focusSeqRef.current = focusIv.seq
            setTab('team')
            if (role) {
              setFeedRole(role); setFeedAgent(null)
              var t2 = arr2.filter(function (x) { return x && x.owner === role && ['in_progress', 'claimed', 'rework'].indexOf(x.status) >= 0 })[0] || arr2.filter(function (x) { return x && x.owner === role })[0]
              if (t2) setSelTask(t2)
            } else {
              setFeedRole(null)
              setFeedAgent({ id: String(focusIv.agentId), label: String(focusIv.label || '') })
            }
          }
        } catch (e) {}
      }, [focusIv, data])
      // F1 计划门：草稿本地编辑态（dirty 时不被轮询覆盖）
      var draftS = useState(null); var draftV = draftS[0], setDraftV = draftS[1]
      var draftMeta = useRef({ loadedAt: '', dirty: false })
      var planMsgS = useState(''); var planMsg = planMsgS[0], setPlanMsg = planMsgS[1]
      var err = useState(''); var errV = err[0], setErr = err[1]

      function stateUrl(section) {
        var url = '/plugins/dsh-expert-team/state', q = []
        if (sessionId) q.push('sessionId=' + encodeURIComponent(sessionId))
        if (selRunV && selRunV.workspace && selRunV.runId) { q.push('workspace=' + encodeURIComponent(selRunV.workspace)); q.push('run=' + encodeURIComponent(selRunV.runId)) }
        // `section`：渐进式状态（2026-09-15 性能修复 #3）。首屏只发 `summary`（便宜），
        // 人/料/事件流晚一拍、低频拉（见下面的双订阅）。不传 = 完整负载（服务端向后兼容）。
        if (section) q.push('section=' + encodeURIComponent(section))
        return url + (q.length ? ('?' + q.join('&')) : '')
      }
      // ── 数据到达后的副作用（**本组件不再自带轮询器**；由 stateHub 统一驱动）─────────
      // 2026-09-15 性能修复 #2：面板原先自己 hold 一个 setInterval + in-flight 守卫，而徽章与
      // 画布另走 liveStore 的 setInterval ⇒ 画布一开就有 2–3 个轮询并发压同一个重端点
      // （实测 10 秒 7 发、6 次重叠、单发被拖到 5.9/8.3 s）。现在全部经 stateHub：
      // 同 URL 同刻只跑一次、全局单一时钟、统一退避（见 stateHub 的注释）。
      // ── 分节负载的合并（2026-09-15 性能修复 #3；2026-09-16 缺陷 C 修正）─────────────
      // 规则与根因说明见**模块级**的 `mergeStatePayload`（原始注释随函数一起搬过去了）：
      // 它同时服务面板（`onState`）与徽章/胶囊的 `publishToLive`（liveStore），
      // 两边必须用同一条规则 —— 否则徽章那一份仍会被 summary 的"桩值"拍掉 members/agents。
      function onState(d) {
          if (d && d.ok) {
            setData(function (prev) { return mergeStatePayload(prev, d) }); setErr(''); reschedule(d)
            try { publishToLive(d) } catch (e) {}
            // N2: keep the composer takeover in sync with pendingDecision
            // 批 0-2：把 /state 已经返回的 runId/workspace 一并传出，供横幅拍板时回传给 /decide
            try { if (exports._syncPending) exports._syncPending(d.pendingDecision, sessionId, d.runId, d.workspace) } catch (e) {}
            // A⑤ browser notification when a running member settles
            try {
              if (window.Notification && Notification.permission === 'granted') {
                var prev = prevActRef.current || {}
                var now = {}
                var names = {}
                Object.keys(d.members || {}).forEach(function (k) {
                  var mm = d.members[k]
                  if (mm && typeof mm === 'object') { now[mm.id] = mm.activity || ''; if (mm.id) names[mm.id] = (mm.name || '') + ' · ' + roleLabel(k); if (mm.id == null) names[mm.name] = (mm.name || '') + ' · ' + roleLabel(k); if (!mm.id) { now[k] = mm.activity || ''; names[k] = (mm.name || '') + ' · ' + roleLabel(k) } }
                })
                Object.keys(now).forEach(function (id) {
                  if (prev[id] === 'running' && now[id] !== 'running') {
                    try { new Notification('专家团：' + (names[id] || id) + ' 完成当前任务', { body: String(d.runId || '') }) } catch (e) {}
                  }
                })
                prevActRef.current = now
              }
            } catch (e) {}
            // B1: notify the moment a decision gate opens (方案确认门等)
            try {
              var decNow = (d.pendingDecision && d.pendingDecision.options && d.pendingDecision.options.length) ? 1 : 0
              if (decNow && !prevDecRef.current && window.Notification && Notification.permission === 'granted') {
                try { new Notification('专家团等待你的决策', { body: String((d.pendingDecision && d.pendingDecision.title) || phaseLabel(d.phase || '') || '') }) } catch (e) {}
              }
              prevDecRef.current = decNow
            } catch (e) {}
          } else if (d && !d.ok && d.runsAvailable === 0) { setData(null); if (d.runs) setRunsMeta(d.runs); setErr(t('还没有专家团 run。先运行 /team <task> 开一个。', 'No team run yet — run /team <task> first.')) }
          else if (d && !d.ok) { if (d.runs) setRunsMeta(d.runs); setErr(d.error || ''); }
      }
      useEffect(function () {
        if (!isOpen && !viewMode) return undefined // panel closed & not canvas → no polling
        setLivePublisher(true)   // 面板/画布开着 ⇒ 接管徽章的数据（见 publishToLive 的注释）
        // **双订阅**（性能修复 #3）：`summary` 便宜（阶段/进度/计数）⇒ 按 `pollMs` 快拉，
        // 首屏立刻有内容；`people,feed,artifacts` 贵（成员解析/事件流/日志尾+git）⇒ 至少 6 秒一次，
        // 到达后由 `mergeStatePayload` 合并进同一份 data（**不会**把摘要拍掉的字段抹掉）。
        // stateHub 按 URL 各自计时（per-URL due），所以"一快一慢"不会互相拖。
        var off = stateHubSubscribe(stateUrl('summary'), dispCfg.pollMs, onState)
        // 重分节**按当前可见子标签**订阅（不再无条件拉 people,feed,artifacts）：切标签时旧的 URL
        // 随卸载退订、新的立即拉一次 ⇒ 后台只保留"你正在看的那一块"。
        var heavy = heavySectionsForTab(tab)
        var offDetail = heavy ? stateHubSubscribe(stateUrl(heavy), Math.max(dispCfg.pollMs, 6000), onState) : function () {}
        // catch up instantly when the user returns to the tab / window（只补便宜那一份）
        var onVis = function () { if (document.visibilityState === 'visible') stateHubFetch(stateUrl('summary'), onState) }
        var onFocus = function () { stateHubFetch(stateUrl('summary'), onState) }
        document.addEventListener('visibilitychange', onVis)
        window.addEventListener('focus', onFocus)
        return function () {
          off(); offDetail()
          setLivePublisher(false)
          document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onFocus)
        }
      }, [sessionId, selRunV, isOpen, viewMode, dispCfg.pollMs, tab])

      // 任务详情（files / logTail）属于 artifacts 分节：**只在真的点开任务时补拉一次**，
      // 不在后台常驻（否则等于把 artifacts 又变回常驻重分节）。切换选中任务会重新拉一次。
      useEffect(function () {
        if (!selTaskV) return
        if (tab !== 'tasks') return   // 任务详情（files/logTail）只在「事」标签渲染
        try { stateHubFetch(stateUrl('artifacts'), onState) } catch (e) {}
      }, [selTaskV && selTaskV.id])

      // Make the docked panel reserve space (shift the shell frame) instead of
      // covering the workspace; clears when closed or floating (md-preview trick).
      useEffect(function () {
        try {
          var overlay = document.querySelector('[data-shell-overlay]')
          var frame = overlay && overlay.parentElement
          if (frame) frame.style.paddingRight = (isOpen && docked) ? pw + 'px' : ''
        } catch (e) {}
      }, [isOpen, docked, pw])

      function openArtifact(name, runId, workspace) {
        setSelArt(name)
        var q = '?name=' + encodeURIComponent(name) + '&run=' + encodeURIComponent(runId)
        if (workspace) q += '&workspace=' + encodeURIComponent(workspace); else if (sessionId) q += '&sessionId=' + encodeURIComponent(sessionId)
        fetch('/plugins/dsh-expert-team/artifact' + q).then(function (r) { return r.json() }).then(function (d) { setArtText((d && d.ok) ? d.text : ('（无法读取 ' + name + '）')) }).catch(function () { setArtText('读取失败') })
      }

      function decide(body) {
        var payload = Object.assign({ sessionId: sessionId, workspace: workspace, run: runId }, body)
        fetch('/plugins/dsh-expert-team/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          .then(function (r) { return r.json() }).then(function (d) { load() }).catch(function () { load() })
      }

      // ── F1 计划门：草稿同步 / 编辑 / 保存 / 批准 / 丢弃（AgentTeams 借鉴）──
      // 轮询不覆盖正在编辑的草稿（dirty 优先），仅在 updatedAt 变化且未编辑时重载。
      useEffect(function () {
        var d = data && data.draft
        if (!d) { if (!draftMeta.current.dirty) { draftMeta.current.loadedAt = ''; setDraftV(null) } return }
        if (draftMeta.current.dirty) return
        var at = String(d.updatedAt || '')
        if (draftMeta.current.loadedAt === at) return
        draftMeta.current.loadedAt = at
        try { setDraftV(JSON.parse(JSON.stringify(d))) } catch (e) { setDraftV(d) }
      }, [data])

      function planPost(path, extra) {
        var ws = (selRunV && selRunV.workspace) || workspace || (data && data.workspace) || ''
        var rn = (selRunV && selRunV.runId) || runId || (data && data.runId) || ''
        var body = Object.assign({ sessionId: sessionId, workspace: ws, run: rn }, extra || {})
        setPlanMsg(t('提交中…', 'sending…'))
        fetch('/plugins/dsh-expert-team/plan' + (path || ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json() }).then(function (j) {
            if (j && j.ok) {
              draftMeta.current.dirty = false; draftMeta.current.loadedAt = ''
              if (path === '/approve') { setPlanMsg(t('✅ 已批准并派工', 'approved & dispatched')) }
              else if (path === '/discard') { setPlanMsg(t('🗑 已丢弃（禁止自动重建）', 'discarded')) }
              else { setPlanMsg(t('💾 草稿已保存', 'draft saved')) }
              load()
            } else { setPlanMsg((j && j.error) || t('操作失败', 'failed')) }
          }).catch(function () { setPlanMsg(t('请求失败', 'request failed')) })
      }
      function draftEdit(fn) {
        var d
        try { d = draftV ? JSON.parse(JSON.stringify(draftV)) : { roles: [], tasks: [] } } catch (e) { d = { roles: [], tasks: [] } }
        fn(d)
        draftMeta.current.dirty = true
        setDraftV(d)
      }

      // Qoder-style code index: instant keyword hits from team/CODEINDEX.json.
      function codeSearch() {
        var ws = workspace || (data && data.workspace) || ''
        var kw = qV.trim()
        if (!ws || !kw) return
        setQHits(null); setQInfo(null)
        fetch('/plugins/dsh-expert-team/codeidx?workspace=' + encodeURIComponent(ws) + '&q=' + encodeURIComponent(kw))
          .then(function (r) { return r.json() }).then(function (d) { setQHits((d && d.ok) ? d.hits : []); setQInfo(d && d.ok ? d : null) }).catch(function () { setQHits([]) })
      }
      // A① click a code-index hit → preview the file inside the panel
      function openFileView(rel) {
        var ws = workspace || (data && data.workspace) || ''
        if (!ws || !rel) return
        setFileV({ path: rel, text: t('加载中…', 'Loading…'), loading: true })
        fetch('/plugins/dsh-expert-team/file?workspace=' + encodeURIComponent(ws) + '&path=' + encodeURIComponent(rel))
          .then(function (r) { return r.json() }).then(function (d) { setFileV(d && d.ok ? { path: rel, text: d.text, loading: false } : { path: rel, text: t('（无法读取）', '(unreadable)') + ' ' + String((d && d.error) || ''), loading: false }) }).catch(function () { setFileV({ path: rel, text: t('读取失败', 'read failed'), loading: false }) })
      }
      // B⑦ overlay task operation (writes TASKS.json + RUN.log)
      function taskOp(status) {
        if (!selTaskV || !workspace || !runId) return
        setErr(t('正在写状态…', 'updating…'))
        fetch('/plugins/dsh-expert-team/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId, workspace: workspace, run: runId, id: selTaskV.id, status: status, note: '浮层操控' }) })
          .then(function (r) { return r.json() }).then(function () { load() }).catch(function () { load() })
      }

      var runId = (data && data.runId) || '', workspace = (data && data.workspace) || '', runs = (data && data.runs) || []
      var tasks0 = (data && data.tasks) || []
      var tasksLive = (data && data.tasksLive) || []
      // TASKS.json 为空但确有活子代理（lead 用 workflow 扇出却没回写任务）→ 用主机投影的
      // 实时任务兜底，让任务清单/依赖图/全景可用；行上带 live:true，UI 会明确标注来源。
      var usingLiveTasks = !tasks0.length && tasksLive.length > 0
      // 实时投影没有依赖数据；把"运行中"排前面、再按角色聚合，明细视图才不显得杂乱
      var tasks = usingLiveTasks
        ? tasksLive.slice().sort(function (a, b) {
            var ra = a.status === 'in_progress' ? 0 : 1, rb = b.status === 'in_progress' ? 0 : 1
            if (ra !== rb) return ra - rb
            return String(a.owner || '').localeCompare(String(b.owner || ''))
          })
        : tasks0
      var roles = (data && data.roles) || [], members = (data && data.members) || {}, coverage = (data && data.coverage) || []
      var violations = (data && data.violations) || []
      var phaseIdx = PHASES.indexOf((data && data.phase) || '')
      var total = tasks.length, done = tasks.filter(function (t) { return FINAL.indexOf(t.status) >= 0 }).length, pct = total ? Math.round((done / total) * 100) : 0
      var models = []
      roles.forEach(function (r) { var m = members[r]; if (m && (m.model || m.provider || m.activity)) { var v = m.model || m.provider || m.activity; var s = typeof v === 'string' ? v : (v.model || ''); if (s && models.indexOf(s) < 0) models.push(s) } })
      var modelsLine = models.length ? (t('在用模型：', 'Models: ') + models.join(', ') + ' · ' + t('会话费用见 dsh-cost-meter', 'see dsh-cost-meter for cost')) : ''
      // cost/model plan (heavy=top / light=fast) from ROSTER.models
      var plan = (data && data.models) || {}
      var byM = {}
      roles.forEach(function (r) { var p = plan[r]; if (p && p.model) { byM[p.model] = byM[p.model] || []; byM[p.model].push(roleLabel(r)) } })
      var planLine = Object.keys(byM).sort().map(function (m) { return m.replace(/^deepseek-/, '') + '(' + byM[m].join('/') + ')' }).join(' · ')
      planLine = planLine ? t('模型计划：', 'Plan: ') + planLine : ''

      var stepper = PHASES.map(function (p, i) { return h('li', { key: p, className: i === phaseIdx ? 'cur' : (i < phaseIdx ? 'done' : '') }, esc(phaseLabel(p))) })

      // 活子代理里匹配不到角色的（host 侧按 label/括号角色 id/首条 prompt 推断；
      // workflow 派生的子代理 label 常为空）→ 如实列出，避免「有人跑着但名单全未启动」。
      var agentsLive = (data && data.agents) || []
      // 角色三源合并（members 权威 → agents[].role → workflow 卡 label 兜底）。
      // 旧实现只按 members[role].id 建索引 —— 对 workflow 派生子代理（host 解析不出角色）必然落空，
      // 于是面板把它们全列进「未匹配到角色」（用户实测看到 22 个）。
      var roleResolve = (function () {
        try { return resolveAgentRoles(members, roles, agentsLive, wfPhaseIv) }
        catch (e) {
          // 兜底：宁可退化成"全部未匹配"（用户至少还能看到如实清单），也不让浮层整块渲染失败。
          try { console.warn("[expert-team] 角色解析失败，已降级：", e && e.message) } catch (e2) {}
          return { byRole: {}, byId: {}, matched: {}, unmatched: agentsLive, roleless: agentsLive, extraByRole: {}, dispatched: 0, wfRole: {} }
        }
      })()
      var unmatchedAgents = roleResolve.unmatched
      var rolelessAgents = Array.isArray(roleResolve.roleless) ? roleResolve.roleless : []
      var extraByRole = (roleResolve.extraByRole && typeof roleResolve.extraByRole === 'object') ? roleResolve.extraByRole : {}
      // ⚠️ dispatched 必须在 roleResolve **之后**取值。var 会提升，写在前面会读到 undefined：
      // 真实事故（浏览器实测抓到，Node 层测试抓不到）——
      //   TypeError: Cannot read properties of undefined (reading 'dispatched')
      //   slot entry crashed in 'conversation.view'   ← 嵌入式画布整块崩掉
      var dispatched = roleResolve.dispatched
      var roster = roles.map(function (r) {
        var m = members[r], live = (m && typeof m === 'object') ? m : null
        var nm = live ? (live.name || r) : r
        var col = live ? (live.color || '#5b8def') : '#9aa4b2'
        var ini = live ? (live.initial || nm.slice(0, 1).toUpperCase()) : nm.slice(0, 1).toUpperCase()
        var hasAgent = !!(live && live.active)
        var act = live ? (live.activity || '') : ''
        var st = act === 'running' ? 'running' : (act === 'idle' || act === 'ready' || act === 'inactive') ? 'idle' : ''
        var dot = !hasAgent ? '#c5ccd6' : st === 'running' ? '#22b07d' : st === 'idle' ? '#3b6ef5' : '#9aa4b2'
        var sub = live ? (live.model || live.planModel || live.label || live.id || '') : ((m && typeof m === 'object' && m.planModel) || '')
        var cur = tasks.filter(function (t) { return t.owner === r && ['in_progress', 'claimed', 'rework'].indexOf(t.status) >= 0 })
        var curT = cur[0]
        return h('div', { className: 'exp-row mem' + (st === 'running' ? ' exp-mem-run' : ''), key: r, onClick: function () { setFeedRole(feedRole === r ? null : r) }, title: (live && live.id ? t('子代理 ', 'agent ') + String(live.id).slice(0, 8) + (live.label ? ' · ' + String(live.label).slice(0, 40) : '') + ' · ' : '') + t('点击查看实时操作流', 'click for live feed') },
          h('span', { className: 'exp-mem-main' },
            h('span', { className: 'exp-ava', style: { background: col } }, esc(ini)),
            h('span', { className: 'exp-mem-name' }, esc(nm)),
            h('span', { className: 'exp-role' }, esc(roleLabel(r))),
            h('span', { className: 'exp-muted' }, esc(st ? (st === 'running' ? t('运行中', 'running') : t('空闲', 'idle')) : (hasAgent ? t('已派', 'dispatched') : t('未启动', 'not started'))))),
          h('span', { className: 'exp-mem-sub' }, sub ? esc(String(sub).slice(0, 20)) : null),
          curT ? h('div', { className: 'exp-mem-cur' }, '▶ ' + esc(String(curT.title || curT.spec || curT.id || '').slice(0, 24))) : null)
      })

      var taskRows = tasks.map(function (tk) {
        var owner = tk.owner || '—'
        var mm = members[owner], live = (mm && typeof mm === 'object') ? mm : null
        var nm = live ? (live.name || owner) : owner
        var colC = live ? (live.color || '#5b8def') : '#9aa4b2'
        var ini = live ? (live.initial || nm.slice(0, 1).toUpperCase()) : nm.slice(0, 1).toUpperCase()
        var cur = ['in_progress', 'claimed', 'rework'].indexOf(tk.status) >= 0
        var f = arrOf(tk.findings).length
        return h('div', { className: 'exp-row task' + (cur ? ' cur' : ''), key: tk.id, onClick: function () { var same = selTaskV && selTaskV.id === tk.id; setSelTask(same ? null : tk); if (!same) focusPanelRight() } },
          h('span', { className: 'exp-ava', style: { background: colC } }, esc(ini)),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'exp-task-t' }, esc(String(tk.id || '')) + ' · ' + esc(String(tk.title || tk.spec || '').slice(0, 34))),
            h('div', { className: 'exp-muted' },
              esc(nm) + ' ⟶ ' + esc(roleLabel(owner)) + ((live && (live.model || live.planModel)) ? ' · ' + esc(String(live.model || live.planModel).slice(0, 16)) : '') + (f ? ' · ' + f + t(' 条发现', ' findings') : '') + ((tk.round || 1) > 1 ? ' · 第' + tk.round + '轮' : ''))),
          h('span', { style: { display: 'flex', gap: 4, flex: 'none' } },
            tk.verdict ? verdictBadge(tk.verdict) : null,
            h('span', { className: 'exp-badge ' + stBadgeCls(tk.status) }, esc(stLabel(tk.status)))))
      })
      // 收起态摘要：按状态计数一行显示（默认折叠，点标题展开）
      var sumMap = {}
      tasks.forEach(function (tk) { var s = tk.status || 'pending'; sumMap[s] = (sumMap[s] || 0) + 1 })
      var listSummary = ['in_progress', 'claimed', 'pending', 'done', 'rework', 'blocked', 'failed'].filter(function (s) { return sumMap[s] }).map(function (s) { return sumMap[s] + ' ' + stLabel(s) }).join(' · ')

      // 任务流转（全景）：先把任务按 dependsOn 分层（同层=并行），再把
      // 「单卡连续链」合并为一行（横向滚动 + → 箭头），只在并行分支/汇合
      // 处换行——B 链 9 个任务一行滚过，而不是瀑布 9 层刷屏。
      function flowLevels(ts) {
        var byId = {}, lvl = {}
        ts.forEach(function (t) { byId[t.id] = t; lvl[t.id] = 0 })
        var changed = true, guard = 0
        while (changed && guard++ < 32) {
          changed = false
          ts.forEach(function (t) {
            arrOf(t.dependsOn).forEach(function (d) {
              if (byId[d] && lvl[t.id] <= lvl[d]) { lvl[t.id] = lvl[d] + 1; changed = true }
            })
          })
        }
        var maxL = 0
        ts.forEach(function (t) { maxL = Math.max(maxL, lvl[t.id]) })
        var rows = []
        for (var l = 0; l <= maxL; l++) rows.push(ts.filter(function (t) { return lvl[t.id] === l }))
        return rows
      }
      function flowRows(ts) {
        var levels = flowLevels(ts)
        var out = [], cur = []
        levels.forEach(function (lv) {
          if (lv.length === 1) {
            var t0 = lv[0]
            var deps = arrOf(t0.dependsOn)
            // continue the current chain when any dep is already in it
            var continues = cur.length && deps.some(function (d) { return cur.some(function (c) { return c.id === d }) })
            if (continues) { cur.push(t0); return }
            if (cur.length) out.push(cur)
            cur = [t0]
            return
          }
          if (cur.length) out.push(cur)
          cur = []
          out.push(lv.slice()) // parallel row: keep as its own line
        })
        if (cur.length) out.push(cur)
        return out
      }
      var flowArrow = h('span', { className: 'exp-flow-a2' }, '→')
      var flowCards = function (tk) {
        var owner = tk.owner || '—', mm = members[owner], live = (mm && typeof mm === 'object') ? mm : null
        var nm = live ? (live.name || owner) : owner, col = live ? (live.color || '#5b8def') : '#9aa4b2'
        var ini = live ? (live.initial || nm.slice(0, 1).toUpperCase()) : nm.slice(0, 1).toUpperCase()
        var cur = ['in_progress', 'claimed', 'rework'].indexOf(tk.status) >= 0
        return h('div', { className: 'exp-flow' + (cur ? ' cur' : ''), key: tk.id, onClick: function () { var same = selTaskV && selTaskV.id === tk.id; setSelTask(same ? null : tk); if (!same) focusPanelRight() } },
          h('div', { className: 'exp-flow-a' }, h('span', { className: 'exp-ava', style: { background: col } }, esc(ini)),
            h('b', null, esc(String(nm).slice(0, 10))), h('span', { className: 'exp-role' }, esc(roleLabel(owner)))),
          h('div', { className: 'exp-flow-t' }, esc(String(tk.id || '') + ' · ' + String(tk.title || tk.spec || '').slice(0, 24))),
          h('span', { className: 'exp-badge ' + stBadgeCls(tk.status) }, esc(stLabel(tk.status))))
      }
      // ── 实时投影的"按角色分组"视图 ──
      // TASKS.json 为空时没有 dependsOn 数据，DAG 只能画成一排（用户反馈"一排效果不好"）。
      // 改为按 owner（角色）分组：每组标题带活动态计数，组内每行一个 agent（状态点 + label + 状态），
      // 点击行 → 选中该任务（右侧详情）；无依赖数据这件事在顶部明确说明。
      var liveGroups = null
      if (usingLiveTasks) {
        var byRole = {}
        tasks.forEach(function (tk) {
          var r = tk.owner || '—'
          if (!byRole[r]) byRole[r] = []
          byRole[r].push(tk)
        })
        var roleOrder = Object.keys(byRole).sort(function (a, b) { return byRole[b].length - byRole[a].length })
        liveGroups = h('div', null,
          h('div', { className: 'exp-flow-note' }, t('⚠ 无依赖数据（TASKS.json 为空）→ 改为按角色分组展示；点每行看右侧详情', '⚠ no dependency data (TASKS.json empty) → grouped by role; click a row for detail')),
          roleOrder.map(function (r) {
            var arr = byRole[r]
            var runN = arr.filter(function (x) { return x.status === 'in_progress' }).length
            return h('div', { key: 'g-' + r, style: { margin: '6px 0 2px' } },
              h('div', { className: 'exp-mem-sub', style: { display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 2px' } },
                h('b', null, esc(roleLabel(r) || r)),
                h('span', { className: 'exp-muted' }, arr.length + t(' 个', '') + (runN ? ' · ' + runN + t(' 运行中', ' running') : ''))),
              arr.map(function (tk) {
                var cur = tk.status === 'in_progress'
                return h('div', {
                  className: 'exp-row task' + (cur ? ' cur' : ''),
                  key: tk.id,
                  title: t('点击查看详情（右侧面板）', 'click for detail (right panel)'),
                  onClick: function () { var same = selTaskV && selTaskV.id === tk.id; setSelTask(same ? null : tk); if (!same) focusPanelRight() }
                },
                  h('span', { className: 'exp-ava', style: { background: cur ? '#0969da' : '#9aa4b2' } }, cur ? '▶' : '✓'),
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { className: 'exp-task-t' }, esc(String(tk.title || tk.id).slice(0, 60))),
                    h('div', { className: 'exp-muted' }, esc(roleLabel(tk.owner) || t('未识别角色', 'unknown role')) + (tk.model ? ' · ' + esc(String(tk.model).slice(0, 16)) : ''))),
                  h('span', { className: 'exp-badge ' + stBadgeCls(tk.status) }, esc(stLabel(tk.status))))
              }))
          }))
      }

      // ── 任务人员流转（SPEC §3-S1「波次主轴 · 紧凑流转」+ UI.md「竖直时间轴 + 波次带」）──
      // 主轴 = **时间波次**：纵向=波次（时间先后），横向=同波并列的人。leader 收缩为顶部唯一一行，
      // 不占"一层"。三条禁止：不臆造绑定（tasks 无 agentId 就不挂任务）、不臆造层级（无 createdAt 不分波）、
      // 不把 ROSTER 计划当已上场的人。降级一律在视图内写明原因。
      var flowDiagram = null
      ;(function buildFlowView() {
        var agentsAll = (data && data.agents) || []
        var agentRole = {}
        agentsAll.forEach(function (a) { if (a && a.id) agentRole[String(a.id)] = a.role || '' })
        var wfPh = (wfPhaseIv && wfPhaseIv.phases) || []
        // 阶段归属：childId → 阶段 key（仅用于波头徽章，不参与分层）
        var phaseOf = {}
        wfPh.forEach(function (ph) { (ph.members || []).forEach(function (m) { if (m && m.childId) phaseOf[String(m.childId)] = String(ph.key || '') }) })
        // 人：以 host agents[] 为准；agents 为空但有实时投影任务时，用投影行当"人"（无 createdAt → 时刻未知）
        var people = agentsAll.filter(function (a) { return a && a.id }).map(function (a) {
          return { id: String(a.id), role: a.role || '', label: '', activity: a.activity || '', model: a.model || '', createdAt: a.createdAt, parentId: a.parentId || '', depth: a.depth || 0, projected: false }
        })
        if (!people.length) {
          var liveRows = (data && data.tasksLive) || []
          liveRows.forEach(function (r) { if (r && r.agentId) people.push({ id: String(r.agentId), role: r.owner || '', label: String(r.title || ''), activity: r.status === 'in_progress' ? 'running' : 'inactive', model: r.model || '', createdAt: 0, parentId: '', depth: 0, projected: true }) })
        }
        var roles = (data && data.roles) || []
        // 分层依据补全：workflow 派生的子代理没有会话 header，改用事件流真实时间戳。
        // `timing` 回报用了哪一源，UI 必须如实标注（不把推断当事实）。
        var timed = enrichPeopleTiming(people, (data && data.wfChildren) || null)
        people = timed.people
        var timing = timed.used
        var W = buildWaves(people, WAVE_GAP_MS)
        var summary = W.waves.length + t(' 波 · ', ' waves · ') + people.length + t(' 人 · ', ' people · ') + people.filter(function (p) { return p.activity === 'running' }).length + t(' 在跑', ' running')

        function hhmmss(ms) { try { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2) } catch (e) { return '' } }
        function durLabel(p) { if (!p.lastEventAt || !p.createdAt) return ''; var s = Math.max(0, Math.round((p.lastEventAt - p.createdAt) / 1000)); return s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's' }
        function feedLine(id) { var arr = (data && data.feed && data.feed[id]) || []; var last = arr[arr.length - 1]; return last ? String(last.line || last.preview || '').slice(0, 28) : '' }
        // 同一角色多人时用 ①② 区分（禁止聚合）
        var roleCount = {}
        people.forEach(function (p) { roleCount[p.role] = (roleCount[p.role] || 0) + 1 })
        var roleSeen = {}
        function personTitle(p) {
          var base = p.role ? roleLabel(p.role) : (p.label || String(p.id).slice(0, 8))
          if (p.role && roleCount[p.role] > 1) { var n = (roleSeen[p.role] = (roleSeen[p.role] || 0) + 1); return base + ' ' + '①②③④⑤⑥⑦⑧⑨'[n - 1 >= 0 && n - 1 < 9 ? n - 1 : 8] }
          return base
        }
        // 绑定：委托模块内纯函数 bindTaskFor（可单测 + 变异验证）。
        // 推断命中的 id 登记到 inferredBind ⇒ UI 用「~」前缀明确标注是推断，不冒充精确。
        var inferredBind = {}
        function taskOf(p) { return bindTaskFor(p, tasks, inferredBind) }
        function miniCard(p, opts) {
          var tk = taskOf(p)
          var running = p.activity === 'running'
          var done = !running && p.activity === 'inactive'
          var rw = tk && (tk.status === 'rework' || tk.verdict === 'needs_revision')
          var fl = feedLine(p.id)
          return h('div', {
            className: 'etv-card' + (running ? ' run' : (rw ? ' rework' : (done ? ' done' : ''))),
            key: 'p-' + p.id,
            title: personTitle(p) + ' · ' + String(p.id).slice(0, 8) + (tk ? ' · ' + (inferredBind[String(tk.id)] ? '~' : '') + String(tk.id || '') + (inferredBind[String(tk.id)] ? t('（按角色推断的绑定：TASKS.json 未记录 agentId）', ' (inferred by role: no agentId in TASKS.json)') : '') : ''),
            onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); try { requestFocus({ kind: 'agent', agentId: p.id, label: p.label || personTitle(p) }); focusPanelRight() } catch (e2) {} }
          },
            rw ? h('span', { className: 'etv-rework-tag' }, '↺R' + (tk.round || 1)) : null,
            h('div', { className: 'etv-card-h' },
              h('span', { className: 'exp-ava', style: { background: running ? 'var(--etv-run)' : (done ? 'var(--etv-ok)' : 'var(--etv-idle)'), fontSize: 10, width: 18, height: 18 } }, running ? '▶' : (done ? '✓' : '·')),
              h('span', { className: 'etv-role' }, esc(personTitle(p))),
              h('span', { className: 'etv-who' }, esc(String(p.id).slice(0, 8)))),
            tk ? h('div', { className: 'etv-task', onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); try { setSelTask(tk); focusPanelRight() } catch (e2) {} } }, esc((inferredBind[String(tk.id)] ? '~' : '') + String(tk.id || '') + ' · ' + String(tk.title || tk.spec || ''))) : h('div', { className: 'etv-task', style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('未绑定任务', 'no task bound')),
            h('div', { className: 'etv-card-f' },
              h('span', { className: 'etv-dot' + (running ? ' run' : (done ? '' : ' hollow')), style: running ? { background: 'var(--etv-run)' } : (done ? { background: 'var(--etv-ok)' } : {}) }),
              h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' } }, esc(fl || (running ? t('进行中', 'running') : t('已结束', 'finished')))),
              h('span', { className: 'etv-dur' }, esc(durLabel(p)))))
        }
        var body = []
        // 顶部说明 + 控件
        // 缺块 ≠ 空数据：`wf` 在 warming 时，workflow 元数据（含 agent-start 时间戳）本轮**没有**，
        // 于是 `createdAt` 全 0 会让这里得出"无创建时间记录，无法分批"——那是一个**编出来的结论**
        // （真实原因是"还没读到"）。两种情况必须分开说。
        var wfWarming = ((data && data.warming) || []).indexOf('wf') >= 0
        var degradeNote = null
        if (!people.length && roles.length) degradeNote = t('⚠ 尚未派工：以下为计划编制，不代表已上场', '⚠ not dispatched yet: planned roster only')
        else if (!people.length) degradeNote = t('还没有可展示的人员流转（无任务、无子代理）', 'nothing to show yet (no tasks, no subagents)')
        else if (!W.waves.length && wfWarming) degradeNote = t('⏳ 工作流元数据正在后台读取：本轮拿不到 agent-start 时间戳，批次划分暂时不可用（不是「没有记录」）', '⏳ workflow metadata is being read in the background: agent-start timestamps are unavailable this round, so batching is pending (not "no records")')
        else if (!W.waves.length) degradeNote = t('⚠ 无创建时间记录，无法分批（已按角色分组展示）', '⚠ no createdAt records — cannot batch (grouped by role)')
        else if (W.waves.length === 1 && wfWarming) degradeNote = t('⏳ 工作流元数据正在后台读取：批次可能不止 1 个（本轮只见到 1 个）', '⏳ workflow metadata is being read: there may be more than one batch (only 1 seen this round)')
        else if (W.waves.length === 1) degradeNote = t('仅检测到 1 个批次（无先后可分）', 'only one batch detected (no ordering)')
        else if (!wfPh.length) degradeNote = null
        body.push(h('div', { className: 'etv-note' },
          h('span', null, t('任务人员流转', 'Task-person flow')),
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, esc('W1–W' + Math.max(1, W.waves.length) + ' · ' + people.length + t('人 · ', ' ppl · ') + people.filter(function (p) { return p.activity === 'running' }).length + t('在跑', ' running'))),
          h('button', { className: 'etv-wide-btn', onClick: function () { try { setWide(!wideV) } catch (e) {} } }, esc(wideV ? t('窄视图', 'narrow') : t('宽视图', 'wide'))),
          h('button', { className: 'etv-wide-btn', onClick: function () { try { var el = document.querySelector('.exp-body'); if (el) el.scrollTop = el.scrollHeight } catch (e) {} } }, esc(t('⤓ 最新一波', '⤓ latest')))))
        if (degradeNote) body.push(h('div', { className: 'etv-degrade warn' }, esc(degradeNote)))
        // 分层依据必须**如实标注**：workflow 派生的子代理没有会话 header，改用事件流真实时间戳。
        // 不说清来源，用户会以为"时间"是会话创建时间（两者含义不同）。
        if (W.waves.length && (timing.event > 0 || timing.none > 0)) {
          var srcBits = []
          if (timing.header) srcBits.push(t(timing.header + ' 人取自子会话创建时间', timing.header + ' from child-session createdAt'))
          if (timing.event) srcBits.push(t(timing.event + ' 人取自父会话事件流 agent-start 时间戳（workflow 子代理无会话 header）', timing.event + ' from parent-session agent-start timestamps (workflow children have no session header)'))
          if (timing.none) srcBits.push(t(timing.none + ' 人无任何时间记录', timing.none + ' with no time record at all'))
          // 新鲜度如实标注：stale = 给的是上一份完整快照（后台正在刷新），不是最新值。
          var wfIx = (data && data.wfIndex) || null
          if (wfIx && wfIx.state === 'stale') srcBits.push(t('工作流元数据为 ' + Math.round((wfIx.ageMs || 0) / 1000) + ' 秒前的快照（后台刷新中）', 'workflow metadata is a snapshot from ' + Math.round((wfIx.ageMs || 0) / 1000) + 's ago (refreshing in background)'))
          body.push(h('div', { className: 'etv-degrade info' }, esc(t('分批依据：', 'Layering source: ') + srcBits.join('；'))))
        }
        // ── 主视图：SVG 树 + 贝塞尔曲线（照 dsh-agent-teams 的 live 面板形态抄）──
        // 层 = 波次（时间轴）；层内 = 同批并列的人（横向并排）；层间 = 从上层节点发散的曲线。
        // 卡片内容 = 头像(角色色/首字母) + 「角色 名字」 + 任务标题/label + 状态行（✓已完成/●运行中）。
        // 名字/颜色来自 host 的 enrichMembers（data.members[role].{name,color,initial}），按 agentId 反查。
        var nameById = {}
        Object.keys(members || {}).forEach(function (r) {
          var m = members[r]
          if (m && m.id) nameById[String(m.id)] = { name: m.name || '', color: m.color || '', initial: m.initial || '', role: r }
        })
        function personNameColor(p) {
          var hit = nameById[String(p.id)]
          return { name: (hit && hit.name) || '', color: (hit && hit.color) || '#5b8def', initial: (hit && hit.initial) || (p.role ? roleLabel(p.role).slice(0, 1) : String(p.id).slice(0, 1).toUpperCase()) }
        }
        // 可画宽度三源：实测容器 → 全屏画布按窗口估 → 停靠侧栏宽度偏好。
        // 「宽视图」开关终于有作用了：放宽单卡上限（否则 12 波里每波只有 2–3 人时，
        // 卡片被 176px 封顶、右侧大片空白）。
        var baseW = flowW || (viewMode ? Math.max(320, ((typeof window !== 'undefined' && window.innerWidth) || 1200) - 340) : (typeof pw === 'number' ? pw : 420))
        var avail = Math.max(240, baseW - 26)
        var widest = 1
        W.waves.forEach(function (w) { widest = Math.max(widest, w.members.length) })
        var NGAP = 12, NODE_H = 84, LEVEL_GAP = 34, ROW_TITLE = 15
        var maxNodeW = wideV ? 268 : 200
        var NODE_W = Math.max(104, Math.min(maxNodeW, Math.floor((avail - (widest - 1) * NGAP) / widest)))
        var levels = [{ title: '', nodes: [{ leader: true, id: '__leader' }] }]
        W.waves.forEach(function (w) {
          levels.push({ title: 'W' + w.index + ' · +Δ' + Math.round((w.startAt - W.base) / 1000) + 's · ' + hhmmss(w.startAt), members: w.members, nodes: w.members.map(function (p) { return p }) })
        })
        var totalW = 0
        levels.forEach(function (lv) { totalW = Math.max(totalW, lv.nodes.length * NODE_W + (lv.nodes.length - 1) * NGAP) })
        totalW = Math.max(totalW, 200)
        var pos = {}
        levels.forEach(function (lv, li) {
          var rowW = lv.nodes.length * NODE_W + (lv.nodes.length - 1) * NGAP
          var x0 = (totalW - rowW) / 2
          lv.nodes.forEach(function (n, i) { pos[(n.id || ('ln' + li + i))] = { x: x0 + i * (NODE_W + NGAP), y: li * (NODE_H + LEVEL_GAP) + ROW_TITLE, li: li } })
        })
        // 节点状态语义（全明星 → 参考图的「✅ 已完成」，但多两档真实状态）：
        //   running(蓝·脉冲) / done(绿✓) / **settled=false 且有 runId → 未结算(红)** / idle(灰) / rework(橙虚线)
        // 「未结算」的数据源是父会话事件流里 **agent-start 有、agent-end 没有** —— 即被中断的扇出，
        // 过去这种节点会永远显示成"进行中"，正是用户问的「任务为什么会中断」在画布上的盲点。
        function statusOf(p) {
          if (!p) return { txt: t('编排中', 'orchestrating'), col: 'var(--etv-lead)', kind: 'lead' }
          if (p.activity === 'running') return { txt: t('运行中', 'running'), col: 'var(--etv-run)', kind: 'run' }
          if (p.runId && p.settled === false) return { txt: t('未结算 · 扇出被中断', 'unsettled · fan-out interrupted'), col: 'var(--etv-fail)', kind: 'fail' }
          if (p.activity === 'inactive') return { txt: t('已完成', 'done'), col: 'var(--etv-ok)', kind: 'done' }
          return { txt: t('未启动', 'idle'), col: 'var(--etv-idle)', kind: 'idle' }
        }
        // ── 依赖边：由 TASKS.json 的 dependsOn 决定，**不再"只连上一层第 0 个节点"** ──
        // 旧实现把每一层都挂到上层的第一个节点上：多父多子直接画错，且与真实依赖无关。
        var personOfTask = {}
        people.forEach(function (p) { var tk = taskOf(p); if (tk && tk.id && !personOfTask[String(tk.id)]) personOfTask[String(tk.id)] = p })
        var layerOf = {}
        levels.forEach(function (lv, li) { lv.nodes.forEach(function (n, i) { layerOf[String(n.id || ('ln' + li + i))] = li }) })
        var depEdges = [], depSkipped = 0
        ;(tasks || []).forEach(function (tk) {
          if (!tk || !tk.id) return
          var to = personOfTask[String(tk.id)]
          if (!to) return
          var deps = Array.isArray(tk.dependsOn) ? tk.dependsOn : []
          deps.forEach(function (dd) {
            var from = personOfTask[String(dd)]
            if (!from || String(from.id) === String(to.id)) return
            var lf = layerOf[String(from.id)], lt = layerOf[String(to.id)]
            if (lf === undefined || lt === undefined) return
            if (lt <= lf) { depSkipped += 1; return }  // 同层/回边画不出跨层曲线：如实跳过并计数，不硬画
            depEdges.push([String(from.id), String(to.id), String(tk.id)])
          })
        })
        // ── 关键路径：任务图上从"最深"节点回溯最长链（纯 computed，不改数据） ──
        var depthOf = {}, byTaskId = {}
        ;(tasks || []).forEach(function (tk) { if (tk && tk.id) byTaskId[String(tk.id)] = tk })
        function taskDepth(id, seen) {
          id = String(id || '')
          if (!id || depthOf[id] !== undefined) return depthOf[id] || 0
          if (seen[id]) return 0
          seen[id] = 1
          var tk = byTaskId[id]
          var deps = (tk && Array.isArray(tk.dependsOn)) ? tk.dependsOn : []
          var best = 0
          deps.forEach(function (dd) { if (byTaskId[String(dd)]) best = Math.max(best, taskDepth(String(dd), seen) + 1) })
          delete seen[id]
          depthOf[id] = best
          return best
        }
        var criticalTasks = {}
        ;(function markCritical() {
          var arr = Object.keys(byTaskId)
          if (!arr.length) return
          var deepest = '', best = -1
          arr.forEach(function (id) { var d = taskDepth(id, {}); if (d > best) { best = d; deepest = id } })
          var cur = deepest, guard = 0
          while (cur && guard++ < 64) {
            criticalTasks[cur] = 1
            var tk = byTaskId[cur]
            var deps = (tk && Array.isArray(tk.dependsOn)) ? tk.dependsOn.slice() : []
            var next = ''
            deps.forEach(function (dd) { if (byTaskId[String(dd)] && (next === '' || taskDepth(String(dd), {}) > taskDepth(next, {}))) next = String(dd) })
            cur = next
          }
        })()
        function isCriticalPerson(p) { var tk = taskOf(p); return !!(tk && tk.id && criticalTasks[String(tk.id)]) }
        // ── 血缘：悬停节点时高亮它的依赖祖先/后代（双向 BFS），其余淡出 ──
        var fwd = {}, rev = {}
        depEdges.forEach(function (e) { (fwd[e[0]] = fwd[e[0]] || []).push(e[1]); (rev[e[1]] = rev[e[1]] || []).push(e[0]) })
        // 血缘高亮复用 Panel 顶部的 hover 状态（dagSvg 也用它）——**不要在这里再声明同名变量**，
        // `var` 会提升并遮蔽外层状态，导致 hover 恒为 undefined（本文件已被这个坑咬过一次）。
        var lineage = null
        if (hoverId) {
          lineage = {}; lineage[String(hoverId)] = 1
          ;[[fwd, 0], [rev, 0]].forEach(function (pair) {
            var adj = pair[0], queue = [String(hoverId)], guard = 0
            while (queue.length && guard++ < 500) {
              var cur = queue.shift()
              ;(adj[cur] || []).forEach(function (nx) { if (!lineage[nx]) { lineage[nx] = 1; queue.push(nx) } })
            }
          })
        }
        function dimmed(id) { return !!(lineage && !lineage[String(id)]) }

        var svgEdge = [], svgNode = [], svgLabel = []
        levels.forEach(function (lv, li) {
          if (li > 0) {
            var a = pos[levels[0].nodes[0].id || 'ln00']  // 根 = Lead
            lv.nodes.forEach(function (n, i) {
              var b = pos[(n.id || ('ln' + li + i))]
              if (!a || !b) return
              var x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y
              var midY = (y1 + y2) / 2
              var dim = dimmed(n.id)
              // 委派边：lead → 每一次扇出的成员。第 1 波实线；后续波**淡虚线**（确实由 lead 发起，
              // 但为了让「依赖边」成为视觉主角而降权），并在 tooltip 里写明。
              svgEdge.push(h('path', {
                key: 'e' + li + '-' + i, className: 'etv-curve', d: 'M' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ', ' + x2 + ' ' + midY + ', ' + x2 + ' ' + y2,
                style: { opacity: dim ? .05 : (li === 1 ? .55 : .18), strokeDasharray: li === 1 ? null : '3 4' }
              },
                h('title', null, t('委派：Lead → 本次扇出成员', 'delegation: lead → this fan-out member'))))
            })
          }
          if (lv.title) svgLabel.push(h('text', { key: 'lt' + li, x: 2, y: li * (NODE_H + LEVEL_GAP) + 11, 'font-size': 9.5, fill: 'var(--dsw-alias-label-tertiary)' }, esc(lv.title)))
        })
        // 依赖边（视觉主角）：上游任务的人 → 下游任务的人
        depEdges.forEach(function (e, i) {
          var a = pos[e[0]], b = pos[e[1]]
          if (!a || !b) return
          var x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y
          var midY = (y1 + y2) / 2
          var hot = lineage && (lineage[e[0]] && lineage[e[1]])
          svgEdge.push(h('path', {
            key: 'd' + i, className: 'etv-dep-edge', d: 'M' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + midY + ', ' + x2 + ' ' + midY + ', ' + x2 + ' ' + y2,
            style: { opacity: (lineage && !hot) ? .07 : .95, strokeWidth: hot ? 2.4 : 1.4 }
          },
            h('title', null, t('依赖：', 'dependsOn: ') + e[2] + ' ← ' + (taskOf(people.filter(function (p) { return String(p.id) === e[0] })[0]) || {}).id)))
        })
        levels.forEach(function (lv, li) {
          lv.nodes.forEach(function (n, i) {
            var b = pos[(n.id || ('ln' + li + i))]
            if (!b) return
            if (n.leader) {
              svgNode.push(h('g', { key: 'lead', transform: 'translate(' + b.x + ' ' + b.y + ')' },
                h('rect', { width: NODE_W, height: NODE_H, rx: 10, className: 'etv-g-node lead' }),
                h('circle', { cx: 20, cy: 22, r: 9, fill: 'rgba(65,118,230,.2)', stroke: 'var(--etv-lead)', strokeWidth: 1.4 }),
                h('text', { x: 20, y: 26, 'font-size': 10, 'text-anchor': 'middle', fill: 'var(--etv-lead)' }, '◎'),
                h('text', { x: 36, y: 19, 'font-size': 11.5, 'font-weight': 700, fill: 'var(--dsw-alias-label-primary)' }, 'Lead Agent'),
                h('text', { x: 36, y: 33, 'font-size': 10, fill: 'var(--dsw-alias-label-secondary)' }, esc(t('协调专家任务', 'orchestrating'))),
                h('text', { x: 12, y: 62, 'font-size': 10, fill: 'var(--dsw-alias-label-secondary)' }, esc('✓ ' + t('运行中', 'running')))))
              return
            }
            var pc = personNameColor(n)
            var st = statusOf(n)
            var tk = taskOf(n)
            var title = tk ? String(tk.title || tk.spec || '') : (String(n.label || n.wfLabel || '').trim() || feedLine(n.id) || '')
            var idLine = tk ? ((inferredBind[String(tk.id)] ? '~' : '') + String(tk.id || '')) : (String(n.id || '').slice(0, 8))
            // 参考图是「任务标题两行」：SVG 没有 line-clamp，按显示宽度手工切成两行
            var per = Math.max(10, Math.floor((NODE_W - 30) / 6.1))
            var t1 = clipText(title, per)
            var rest = String(title).slice(t1.length)
            var t2 = rest ? clipText(rest, per) : ''
            var dim2 = dimmed(n.id)
            var crit = isCriticalPerson(n)
            var fileN = (tk && Array.isArray(tk.changedPaths)) ? tk.changedPaths.length : 0
            var badges = []
            if (crit) badges.push('★' + t('关键路径', 'critical'))
            if (fileN) badges.push(fileN + t(' 文件', ' files'))
            if (tk && tk.round > 1) badges.push('R' + tk.round)
            if (n.runId) badges.push(t('扇出 ', 'fan ') + String(n.runId).slice(0, 4))
            // tooltip 先拼好再传：直接内联一个超长三元表达式极易漏括号（本轮真踩过 SyntaxError）
            var nodeTip = (roleLabel(n.role) || '') + ' ' + (pc.name || '') + ' · ' + String(n.id).slice(0, 8) + ' · ' + st.txt
            if (n.runId) nodeTip += ' · ' + t('扇出 ', 'fan ') + String(n.runId).slice(0, 8) + (n.settled === false ? t('（未结算）', ' (unsettled)') : '')
            if (tk) nodeTip += ' · ' + String(tk.id || '') + ' ' + String(tk.title || '')
            if (crit) nodeTip += ' · ' + t('关键路径', 'critical path')
            // 子元素先组成数组再一次性传入：深度嵌套的 h(...) 极易漏括号（本轮真踩过 SyntaxError）
            var kids = [
              h('rect', { width: NODE_W, height: NODE_H, rx: 10, className: 'etv-g-node' + (st.kind === 'run' ? ' run' : (st.kind === 'fail' ? ' failed' : '')) + (crit ? ' crit' : ''), strokeWidth: crit ? 2 : undefined }),
              h('circle', { cx: 20, cy: 22, r: 9, fill: pc.color, opacity: .9 }),
              h('text', { x: 20, y: 26, 'font-size': 10, 'text-anchor': 'middle', fill: '#fff' }, esc(String(pc.initial || '?').slice(0, 1))),
              h('text', { x: 34, y: 19, 'font-size': 11, 'font-weight': 600, fill: 'var(--dsw-alias-label-primary)' }, esc((roleLabel(n.role) || t('未识别角色', 'unknown')) + (pc.name ? ' ' + pc.name : ''))),
              h('text', { x: 34, y: 33, 'font-size': 9.5, fill: 'var(--dsw-alias-label-tertiary)' }, esc(idLine)),
              h('text', { x: 12, y: 50, 'font-size': 10.5, fill: 'var(--dsw-alias-label-primary)' }, esc(t1)),
              t2 ? h('text', { x: 12, y: 63, 'font-size': 10.5, fill: 'var(--dsw-alias-label-primary)' }, esc(t2)) : null,
              h('circle', { cx: 16, cy: 74, r: 3.5, fill: st.col }),
              h('text', { x: 24, y: 77, 'font-size': 10, fill: 'var(--dsw-alias-label-secondary)' }, esc(st.txt + (durLabel(n) ? ' · ' + durLabel(n) : ''))),
              badges.length ? h('text', { x: NODE_W - 8, y: 77, 'font-size': 9, 'text-anchor': 'end', fill: 'var(--dsw-alias-label-tertiary)' }, esc(badges.join(' · '))) : null,
              h('title', null, esc(nodeTip)),
            ]
            svgNode.push(h('g', {
              key: 'n' + n.id,
              transform: 'translate(' + b.x + ' ' + b.y + ')',
              style: { cursor: 'pointer', opacity: dim2 ? .22 : 1 },
              onMouseEnter: function () { try { setHover(String(n.id)) } catch (e) {} },
              onMouseLeave: function () { try { setHover(null) } catch (e) {} },
              onClick: function () { try { requestFocus({ kind: 'agent', agentId: n.id, label: n.label || n.wfLabel || '' }); focusPanelRight() } catch (e) {} }
            }, kids))
          })
        })
        body.push(h('div', { className: 'etv-graph' },
          h('svg', { width: totalW, height: levels.length * (NODE_H + LEVEL_GAP) + 6, style: { display: 'block', maxWidth: 'none' } },
            h('g', null, svgEdge), h('g', null, svgLabel), h('g', null, svgNode))))
        if (depSkipped) body.push(h('div', { className: 'etv-degrade info' }, esc(t(depSkipped + ' 条依赖跨不了层（上游与下游在同一波，画曲线会误导）—— 已如实省略', depSkipped + ' dependency edge(s) cannot cross layers (both ends in one wave) — omitted rather than misdrawn'))))

        if (W.waves.length === 1) body.push(h('div', { className: 'etv-degrade info' }, esc(t('仅检测到 1 个批次（无先后可分）', 'only one batch (no ordering)'))))

        // 时刻未知（部分缺失）
        if (W.untimed.length) {
          body.push(h('div', { className: 'etv-group', key: 'untimed' },
            h('div', { className: 'etv-degrade info' }, t('⚠ ' + W.untimed.length + ' 人无创建时间（不参与分批，按派工顺序串成一条链）', '⚠ ' + W.untimed.length + ' without createdAt (chained in dispatch order)')),
            // SQL 单列 + 左脊 + 肘形连线：无时间戳不能分批，但按派工顺序串链比密排两列好读（用户要求"要有线连接"）
            h('div', { className: 'etv-list' }, h('div', { className: 'etv-list-i' }),
              W.untimed.map(function (p) { return h('div', { className: 'etv-row', key: 'ur-' + p.id }, miniCard(p)) }))))
        }
        // 计划编制（未派工）
        if (!people.length && roles.length) {
          var planRows = roles.map(function (r) {
            return h('div', { className: 'etv-row', key: 'pl-' + r },
              h('div', { className: 'etv-card', style: { borderStyle: 'dashed', opacity: 0.75, cursor: 'default' } },
                h('div', { className: 'etv-card-h' }, h('span', { className: 'etv-role' }, esc(roleLabel(r))))))
          })
          body.push(h('div', { className: 'etv-group', key: 'plan' },
            h('div', { className: 'etv-degrade info' }, t('计划编制（未派工）', 'Planned roster (not dispatched)')),
            h('div', { className: 'etv-list' }, h('div', { className: 'etv-list-i' }), planRows)))
        }
        // 未绑定任务（真实 TASKS.json 无 agentId → 一律进这里，不臆造绑定）
        var boundIds = {}
        people.forEach(function (p) { var tk = taskOf(p); if (tk) boundIds[String(tk.id)] = 1 })
        var unbound = tasks.filter(function (tk) { return tk && !boundIds[String(tk.id)] })
        if (unbound.length) {
          var ubRows = unbound.slice(0, 40).map(function (tk) {
            return h('div', { className: 'etv-row', key: 'ub-' + tk.id },
              h('div', { className: 'etv-card tiny', onClick: function () { try { setSelTask(tk); focusPanelRight() } catch (e) {} } },
                h('div', { className: 'etv-card-h' },
                  h('span', { className: 'etv-role' }, esc(String(tk.id || '') + ' · ' + String(tk.title || '').slice(0, 18))),
                  h('span', { className: 'etv-who' }, esc(roleLabel(tk.owner) || '')))))
          })
          body.push(h('div', { className: 'etv-group', key: 'unbound' },
            h('div', { className: 'etv-degrade info', onClick: function () { setUnboundOpen(!unboundOpen) }, style: { cursor: 'pointer' } },
              t('⚠ 这些任务未与子代理建立绑定（TASKS.json 无 agentId 字段）· ', '⚠ tasks unbound to subagents (no agentId in TASKS.json) · ') + unbound.length + (unboundOpen ? ' ▾' : ' ▸')),
            unboundOpen ? h('div', { className: 'etv-list' }, h('div', { className: 'etv-list-i' }), ubRows) : null))
        }
        flowDiagram = h('div', { className: 'etv-root' }, body)
      })()

      var panorama = null
      if (tasks.length) {
        var rows = flowRows(tasks)
        panorama = h('div', null,
          h('div', { className: 'exp-flow-note' }, t('已安排任务（一行=依赖顺序 →；换行=并行分支）', 'Assigned tasks (a row = dependency order →; line break = parallel branch)')),
          rows.map(function (row, i) {
            var cells = []
            row.forEach(function (tk, j) {
              if (j > 0) cells.push(h('span', { key: 'a' + j, className: 'exp-flow-a2' }, '→'))
              cells.push(flowCards(tk))
            })
            return h('div', { key: i },
              h('div', { className: 'exp-flow-row' }, cells),
              i < rows.length - 1 ? h('div', { className: 'exp-flow-sep' }) : null)
          }))
      } else if (roles.length) {
        panorama = h('div', { className: 'exp-empty' }, t('（暂无任务——设计阶段分工后这里显示任务流转链）', '(no tasks — the flow appears after design)'))
      }
      // 编制摘要（身份标记保留）：横向一张卡，带状态/当前任务
      var rosterStrip = roles.length ? h('div', { className: 'exp-roster-strip' }, roles.map(function (r) {
        var m = members[r], live = (m && typeof m === 'object') ? m : null
        var nm = live ? (live.name || r) : r, col = live ? (live.color || '#5b8def') : '#9aa4b2', ini = live ? (live.initial || nm.slice(0, 1).toUpperCase()) : nm.slice(0, 1).toUpperCase()
        var hasAgent = !!(live && live.active)
        var act = live ? (live.activity || '') : '', st = act === 'running' ? 'running' : (act === 'idle' || act === 'ready' || act === 'inactive') ? 'idle' : ''
        var lbl = !hasAgent ? t('未启动', 'not started') : (st === 'running' ? t('运行中', 'running') : st === 'idle' ? t('空闲', 'idle') : t('已派', 'dispatched'))
        return h('span', { className: 'exp-roster-chip' + (st === 'running' ? ' exp-mem-run' : ''), key: r, onClick: function () { setFeedRole(feedRole === r ? null : r) }, title: t('点击查看实时操作流', 'click for live feed') },
          h('span', { className: 'exp-ava', style: { background: col } }, esc(ini)),
          esc(nm.slice(0, 6)) + ' ' + esc(roleLabel(r)) + ' · ' + esc(lbl))
      })) : null

      // 覆盖矩阵：只渲染**形状合规**的条目。历史事故：`coverage` 曾被写成
      // `["pm","architect",…]`（角色名字符串数组），而 `c.constraint || ''` 对字符串取不到
      // 属性 ⇒ 渲染出**一串空行**，用户只看到空白却不知为何（"消费端静默吞"）。
      // 这里显式过滤 + 把被丢弃的条数如实说出来（信息不丢，也不静默）。
      var coverageArr = Array.isArray(coverage) ? coverage : []
      var coverageBad = coverageArr.filter(function (c) { return !c || typeof c !== 'object' || Array.isArray(c) }).length
      var coverageRows = coverageArr
        .filter(function (c) { return c && typeof c === 'object' && !Array.isArray(c) })
        .map(function (c, i) { return h('div', { className: 'exp-row', key: i }, h('span', { style: { flex: 1 } }, esc(c.constraint || '')), h('span', { className: 'exp-muted' }, esc(arrOf(c.tasks).join(', ')))) })
      if (coverageBad) coverageRows = coverageRows.concat([h('div', { className: 'exp-legend', key: 'cov-bad' }, t('⚠ 另有 ' + coverageBad + ' 条覆盖率记录形状不合规（应为 {constraint, tasks}）—— 已跳过渲染，未静默吞掉；跑 /team migrate 可修', '⚠ ' + coverageBad + ' coverage record(s) have an invalid shape (expected {constraint, tasks}) — skipped, not silently swallowed; /team migrate can fix it'))])
      var artifactBar = ARTIFACT.map(function (a) { return h('span', { className: 'exp-art', key: a, onClick: function () { openArtifact(a, runId, workspace) } }, esc(a)) })
      var runsAll = (data && data.runs) || runsMeta
      // 归属标记（多会话协作）：别的会话创建的 run 在下拉里标 👥，本/未知会话不加（避免噪音）
      // 损坏 run 的下拉只写徽标（`<option>` 不支持富 DOM ⇒ 纯文本前缀），否则退回原来的阶段文案。
      var runSelector = runsAll.map(function (r) { var v = r.workspace + '\u0001' + r.runId; var ownerTag = (r.ownerSession && r.ownerSession !== sessionId) ? ' 👥' : ''; return h('option', { key: v, value: v }, esc(r.runId) + ownerTag + ' (' + esc(runHealthBadge(r) || phaseLabel(r.phase)) + (r.workspace ? ' · ' + esc(basename(r.workspace) || r.workspace) : '') + ')') })
      var curSel = (workspace && runId) ? workspace + '\u0001' + runId : ''
      var selNode = runSelector.length ? h('select', { className: 'exp-art', value: curSel, onChange: function (e) { var p = e.target.value.split('\u0001'); setSelTask(null); setSelArt(null); setSelRun({ workspace: p[0], runId: p[1] }) } },
        (!curSel ? h('option', { key: '_', value: '', disabled: true }, t('选择 run…', 'Pick a run…')) : null), runSelector) : null

      var panelCls = viewMode ? 'exp-panel exp-canvas' : ('exp-panel' + (docked ? '' : ' exp-float'))
      var panelStyle = viewMode ? null : (docked ? { width: pw + 'px' } : { left: pos.x, top: pos.y, width: pw + 'px' })
      var headCls = 'exp-head' + (docked || viewMode ? '' : ' exp-grab')
      // 服务端 `warming`（本次性能收口新增）：重读被挪到后台、数据取自上一份快照或暂时缺席。
      // **必须显式渲染**，不许静默用旧数据假装一切正常；同时它**不是** degraded（真截断），
      // 所以用中性样式 + 独立文案，而不是红/黄告警。
      var warmingList = (data && Array.isArray(data.warming)) ? data.warming : []
      var warmingSeg = { wf: t('工作流元数据', 'workflow metadata'), roles: t('角色解析', 'role resolution'), subs: t('成员明细', 'member rows'), 'members:write-skipped': t('成员登记（等元数据就绪）', 'member registration (waiting for metadata)') }
      var warmingTitle = warmingList.map(function (k) { return warmingSeg[k] || k }).join('、')
      // ⚠️ 两条 `warming` 的含义**不一样**，标题不许含糊（2026-09-16）：
      //   · `subs` = "**还没有就绪**"（宿主刚起来、一行子会话都还没枚举到）⇒ 本轮**没有**明细可显示，
      //     绝不是"这个团队没有人"（服务端还有 `subsPending` 与之对称）；
      //   · 其余 = "重读挪到后台"⇒ 本轮显示的是**上一份完整快照**（数据不残缺，只是可能旧）。
      // 旧文案一律写"本轮显示的是上一份完整快照"，对 `subs` 那种情况就是**假话**（没有快照）。
      var warmingNoSnapshot = warmingList.indexOf('subs') >= 0
      var warmingTail = warmingNoSnapshot
        ? t('）—— 本轮人员明细尚未就绪，不是"这个团队没有人"', ') — member rows are not ready yet this round; this does not mean the team is empty')
        : t('）—— 本轮显示的是上一份完整快照', ') — showing the previous complete snapshot this round')
      // 服务端 `scopeCaps`（1.3.22）：**按设计的能力上限**（不是故障）—— 必须**显式渲染**。
      // 把 `roles:N`/`feed:N` 从 degraded 里拆出来只是"不把它当告警"，**不是**"藏起来"：
      // 任何声称完整的地方都不许因为拆了标记而变得看似完整。
      var scopeCaps = (data && data.scopeCaps && typeof data.scopeCaps === 'object') ? data.scopeCaps : {}
      var capKeys = Object.keys(scopeCaps).filter(function (k) { return scopeCaps[k] && scopeCaps[k].over > 0 })
      var capOver = capKeys.reduce(function (n, k) { return n + (scopeCaps[k].over || 0) }, 0)
      var capName = { roles: t('角色', 'roles'), feed: t('事件流', 'feed') }
      var capWhy = { roles: t('仅列名、未解析日志', 'name only, logs not parsed'), feed: t('未纳入事件流', 'not in the event feed') }
      var capTitle = capKeys.map(function (k) { var c = scopeCaps[k]; return (capName[k] || k) + ' ' + c.over + '/' + c.total + t('（上限 ' + c.limit + '）', ' (limit ' + c.limit + ')') + '：' + (capWhy[k] || '') }).join('；')

      try {
        // ── hook 顺序必须与「面板开/关」无关（React #310）────────────────────────────
        // `canvasView` 内含 3 个 hook（useRef → useCanvasEdges 的 useState/useEffect）。它必须
        // **每次渲染都无条件求值一次**：旧实现把这个早退（`!isOpen && !viewMode` → `return null`）放在它
        // 前面 ⇒「关着」54 个 hook、「打开/全屏」57 个 ⇒ React 抛 #310，而下面的 catch 又把这条
        // React 错误渲染成 `PANEL ERR: …` 文本框（真机上看起来是"面板坏了"）。
        // 放在 `try` 的**第一条语句**是刻意的第二道保险：此后 try 内任何 throw 都发生在 3 个
        // hook **之后**，hook 数不会因为"这次算到一半抛了"而少 3 个（那条路径同样触发 #310）。
        // 放进 `viewV === 'canvas'` 的三元分支里条件调用也属同一类错误（旧注释的理由已并入本段）。
        // `active` 是**可见性**输入：这个元素真的挂进 DOM 的条件就是下面那个三元分支的条件 ——
        // 「事」页签 + 编队画布视图。全屏视图（mode:'view'）也走同一分支，所以不需要再额外判
        // viewMode（也不该判 `isOpen`：全屏时 isOpen 可能为 false，判了会把可见的测量关掉）。
        var canvasEl = canvasView({
          tasks: tasks, members: members, agents: agentsLive, data: data,
          active: tab === 'tasks' && viewV === 'canvas',
          selectedId: selTaskV && selTaskV.id,
          degrade: usingLiveTasks ? t('降级：TASKS.json 为空，下面是「实时子代理投影」——角色由 prompt 推断、依赖无从得知，因此不分层、不画依赖箭头。', 'degraded: TASKS.json is empty — this is a LIVE subagent projection (role inferred, no dependency data): no layers, no dependency arrows.') : '',
          onPick: function (tk) { var same = selTaskV && selTaskV.id === tk.id; setSelTask(same ? null : tk); if (!same) focusPanelRight() }
        })
        // 早退**必须在 hook 之后**（见上）；语义与原来的 3351 行完全相同：面板既没开着、也不在
        // 全屏视图 ⇒ 不渲染任何 DOM。关着时的快路径也因此保住：下面那几百行 DOM 构造仍然被跳过。
        if (!isOpen && !viewMode) return null
        // 「设」页签已移除：设置页搬进**官方「设置」菜单**（`settings.section` 槽，见 apply()）。
        // 为什么改：浮层页签是一个只有打开浮层才够得着的第二入口，且它依赖一个「读取设置」的
        // 自建请求路径 —— 一旦宿主路由没注册就永远停在「正在读取设置…」。搬进官方菜单后与
        // 其它插件的设置同一入口、同一套面板 chrome。
        var TAB_ZH = { team: '人', tasks: '事', info: '料', board: '盘' }
        var tabBar = h('div', { className: 'exp-tabs' },
          ['team', 'tasks', 'info', 'board'].map(function (tb) {
            return h('span', { key: tb, className: 'exp-tab' + (tab === tb ? ' on' : ''), onClick: function () { setTab(tb) } },
              esc((langNow === 'en' ? TAB_ZH[tb] : TAB_ZH[tb])) + (tb === 'tasks' ? ' ' + tasks.length : ''))
          }),
          violations.length ? h('span', { className: 'exp-viol-badge', onClick: function () { setTab('info') }, title: violations.join('\n') }, '⚠ ' + violations.length) : null)

        // 「人」属于 run 的**归属会话**，不是发起请求的会话。host 已按归属解析；这里把
        // 解析不确定的情况**如实说出来**（不确定就说不确定，不默默把两个 run 的人混在一起）。
        var peopleNote = (data && typeof data.peopleSessionNote === 'string') ? data.peopleSessionNote : ''
        var peopleNoteBlock = peopleNote ? h('div', { className: 'exp-viol-list', key: 'peoplenote' },
          h('div', { style: { color: '#b3291e' } }, esc('⚠ ' + peopleNote))) : null

        // 多会话协作（优化①）：这个 run 属于别的会话时，顶部加一条**明确可见**的归属横幅 ——
        // "你在看别人的 run"。避免两个会话同时指挥同一个 run 时互相覆盖却毫无感知。
        var isOtherSessionRun = !!(data && data.stateOwnerSession && data.stateOwnerSession !== sessionId)
        var ownerBanner = isOtherSessionRun ? h('div', { className: 'exp-viol-list', key: 'owner-banner' },
          h('div', { style: { color: '#6a4a00', background: '#fff8e6', padding: '6px 10px', borderRadius: 6 } },
            esc('👥 这个 run 由「另一个会话」创建并拥有（' + data.stateOwnerSession.slice(0, 18) + '…）。你可以查看，但直接派工会与它竞争同一份工作区 —— 建议先与它协调，或确认它已结束后用 /team resume 接管。'))) : null

        // 「任务为什么会中断」——host 从本会话事件流读出每次 workflow 扇出的命运：
        // 没有 run-end 的那次，其编排工具调用从未返回（回合被新消息打断，或进程退出），
        // 于是成员会永远停在「进行中」。没有卡片的运行也能在这里显示（卡片根本不存在）。
        var wfRuns = (data && Array.isArray(data.wfRuns)) ? data.wfRuns : []
        // 只报「没正常收尾」的：正在跑的扇出（running/unsettled）是常态，不该刷红条。
        var badRuns = wfRuns.filter(function (r) { return r && (r.status === 'interrupted' || r.status === 'failed') })
        var wfRunBlock = badRuns.length ? h('div', { className: 'exp-viol-list', key: 'wfruns' },
          h('div', { key: 'h', style: { fontWeight: 600 } }, esc(t('⚠ ' + badRuns.length + ' 次 workflow 扇出未正常结算', '⚠ ' + badRuns.length + ' workflow fan-out(s) did not settle cleanly'))),
          badRuns.slice(0, 4).map(function (r, i) {
            var why = r.status === 'interrupted'
              ? t('已中断——编排工具调用未返回（回合被新消息打断，或进程退出）', 'interrupted — the orchestrating tool call never returned (turn interrupted by a new message, or the process exited)')
              : t('失败——stopReason=error', 'failed — stopReason=error')
            return h('div', { key: 'wfr' + i },
              esc(String(r.name || r.runId || '').slice(0, 40) + ' · ' + r.started + t(' 派工 / ', ' dispatched / ') + r.unsettled + t(' 未结算 · ', ' unsettled · ') + why))
          })) : null

        var teamTab = h('div', null,
          h('div', { className: 'exp-sec' }, t('团队编制（已派 ', 'Roster (') + dispatched + t(' / ', '/') + roles.length + t(' 个 agent）', ' agents)')),
          ownerBanner,
          wfRunBlock,
          peopleNoteBlock,
          roster.length ? roster : h('div', { className: 'exp-empty' }, t('（暂无成员）', '(no members)')),
          // 有界化（2026-09-15）：实时路径**不读**大日志解析角色 ⇒ 未知角色是"**待解析**"，
          // 与下面那段"确实解析不出角色"是**两件事**（本仓纪律：两种零必须分得开，别混成一句话）。
          (data && Number(data.rolesPending) > 0) ? h('div', { className: 'exp-legend', key: 'roles-pending' },
            t('另有 ' + data.rolesPending + ' 条子代理的角色「待解析」（实时路径不读大日志，后台低频解析中；「待解析」≠「解析不出来」）',
              'Roles for ' + data.rolesPending + ' subagent(s) are still "pending" (the live path does not read large logs; pending is not the same as unresolvable)')) : null,
          // 真实性提示：活子代理里没被名册认领的分两类，必须分开说 ——
          //   ① 同角色的重复派工/历史 leg（**有角色**，只是每个角色只展示 1 个成员）
          //   ② 真的解析不出角色的（label 为空、子会话日志不可读、事件流里也没有派工 label）
          // 把 ① 说成"未能解析出角色"是错的（本会话 30 个子代理 / 14 个角色，① 必然很多）。
          unmatchedAgents.length ? (function () {
            var extraKeys = Object.keys(extraByRole)
            var segs = []
            if (extraKeys.length) {
              segs.push(t('另有 ' + unmatchedAgents.length + ' 个活子代理是同一角色的重复派工/历史 leg（每个角色只展示 1 个成员），角色已知：',
                unmatchedAgents.length + ' live subagent(s) are repeat/historical legs of a role already shown (one member per role); roles known: ') +
                extraKeys.map(function (r) { return roleLabel(r) + '×' + extraByRole[r] }).join('  '))
            }
            if (rolelessAgents.length) {
              segs.push(t((extraKeys.length ? '其中 ' : '另有 ') + rolelessAgents.length + ' 个确实解析不出角色（label 为空、子会话日志不可读、本会话事件流里也没有其 workflow 派工 label）：',
                (extraKeys.length ? 'of them, ' : '') + rolelessAgents.length + ' truly have no resolvable role (empty label, unreadable child log, and no workflow delegation label in this session log): ') +
                rolelessAgents.slice(0, 6).map(function (a) { return String(a.id || '').slice(0, 8) + (a.model ? '·' + a.model : '') }).join('  '))
            }
            return h('div', { className: 'exp-legend', key: 'unmatched' }, segs.join(' '))
          })() : null,
          // 可逆开关：本地可回退到 dsh 原生 workflow 卡（改动只影响"对话流卡片的点击去向"）
          h('div', { className: 'exp-legend', key: 'wf-flag' },
            h('span', null, t('对话流 workflow 卡：', 'Conversation workflow card: ')),
            h('button', {
              className: 'exp-opt',
              onClick: function () { try { var cur = window.localStorage.getItem('et-native-workflow') === '1'; window.localStorage.setItem('et-native-workflow', cur ? '0' : '1'); notify() } catch (e) {} }
            }, esc(t('当前：', 'now: ') + (nativeWf ? t('dsh 原生卡', 'dsh native') : t('专家团卡', 'expert-team')) + t(' → 点击切换', ' → click to switch'))),
            h('span', { className: 'exp-muted' }, t('（切换后刷新页面生效）', '(refresh to apply)'))),
          feedRole ? (function () {
            var fm = members[feedRole], fid = (fm && fm.id) || ''
            var fe = (data && data.feed && fid && data.feed[fid]) || []
            return h('div', { className: 'exp-feed', key: 'feed' + feedRole },
              h('div', { className: 'exp-feed-h' },
                h('span', null, esc((fm && fm.name ? fm.name + ' · ' : '') + roleLabel(feedRole) + ' · ' + t('实时操作流', 'live feed'))),
                h('button', { className: 'exp-feed-x', onClick: function () { setFeedRole(null) } }, '✕')),
              fe.length ? fe.map(function (en, i) {
                var tm = ''
                try { var d2 = new Date(en.ts); tm = ('0' + d2.getHours()).slice(-2) + ':' + ('0' + d2.getMinutes()).slice(-2) + ':' + ('0' + d2.getSeconds()).slice(-2) } catch (e) {}
                return h('div', { className: 'exp-feed-i', key: i },
                  h('span', { className: 'exp-feed-t' }, esc(tm)),
                  h('span', { className: 'exp-feed-l' }, esc(en.line || '')),
                  en.preview ? h('div', { className: 'exp-feed-p' }, esc(en.preview)) : null)
              }) : h('div', { className: 'exp-empty' }, t('（暂无操作记录——成员执行工具即显示）', '(no activity yet — appears as tools run)')))
          }()) : null,
          // 按 agentId 的实时细节流（对话流 workflow 卡点成员 → 右侧看"正在进行的细节记录"）
          feedAgent ? (function () {
            var fid2 = String(feedAgent.id || '')
            var fe2 = (data && data.feed && fid2 && data.feed[fid2]) || []
            var liveA = ((data && data.agents) || []).filter(function (a) { return a && String(a.id) === fid2 })[0] || {}
            return h('div', { className: 'exp-feed', key: 'feedA' + fid2 },
              h('div', { className: 'exp-feed-h' },
                h('span', null, esc((feedAgent.label || fid2.slice(0, 8)) + ' · ' + t('实时细节记录', 'live detail') + (liveA.mode ? ' · ' + liveA.mode : '') + (liveA.model ? ' · ' + liveA.model : ''))),
                h('button', { className: 'exp-feed-x', onClick: function () { setFeedAgent(null) } }, '✕')),
              fe2.length ? fe2.map(function (en, i) {
                var tm2 = ''
                try { var d3 = new Date(en.ts); tm2 = ('0' + d3.getHours()).slice(-2) + ':' + ('0' + d3.getMinutes()).slice(-2) + ':' + ('0' + d3.getSeconds()).slice(-2) } catch (e) {}
                return h('div', { className: 'exp-feed-i', key: i },
                  h('span', { className: 'exp-feed-t' }, esc(tm2)),
                  h('span', { className: 'exp-feed-l' }, esc(en.line || '')),
                  en.preview ? h('div', { className: 'exp-feed-p' }, esc(en.preview)) : null)
              }) : h('div', { className: 'exp-empty' }, t('（该成员暂无操作记录——它执行工具即显示）', '(no activity for this member yet)')))
          }()) : null,
          rosterStrip ? [h('div', { className: 'exp-sec' }, t('编制摘要', 'Roster')), rosterStrip] : null)

        // ── F1 计划草稿编辑器（暂存 → 可编辑 → Approve & Run / Discard）──
        var ALL_ROLES = ['pm', 'architect', 'researcher', 'ui', 'backend', 'frontend', 'dba', 'sec', 'reviewer', 'qa', 'devops', 'docs']
        var planEditor = null
        if (draftV) {
          var dv = draftV
          planEditor = h('div', { className: 'exp-plan' },
            h('div', { className: 'exp-plan-h' },
              h('span', { className: 'exp-plan-t' }, t('📋 计划草稿（可编辑）', '📋 Plan draft (editable)')),
              h('span', { className: 'exp-muted' }, (dv.tasks || []).length + ' ' + t('任务', 'tasks') + ' · ' + (dv.roles || []).length + ' ' + t('角色', 'roles')),
              planMsg ? h('span', { className: 'exp-plan-msg' }, esc(planMsg)) : null),
            h('div', { className: 'exp-sec', style: { marginTop: 6 } }, t('角色编制', 'Roster')),
            h('div', { className: 'exp-plan-roles' },
              (dv.roles || []).map(function (r) {
                return h('span', { className: 'exp-plan-chip', key: r }, esc(roleLabel(r)),
                  h('b', { className: 'exp-plan-x', title: t('移除', 'remove'), onClick: function () { draftEdit(function (d) { d.roles = (d.roles || []).filter(function (x) { return x !== r }) }) } }, '✕'))
              }),
              h('select', { className: 'exp-plan-add', value: '', onChange: function (e) {
                var v = e.target.value
                if (v) draftEdit(function (d) { d.roles = (d.roles || []).concat([v]) })
                e.target.value = ''
              } },
                h('option', { value: '' }, t('+ 添加角色', '+ add role')),
                ALL_ROLES.filter(function (r) { return (dv.roles || []).indexOf(r) < 0 }).map(function (r) { return h('option', { key: r, value: r }, roleLabel(r) + ' · ' + r) }))),
            h('div', { className: 'exp-sec', style: { marginTop: 10 } }, t('任务与依赖', 'Tasks & deps')),
            (dv.tasks || []).map(function (tk, i) {
              return h('div', { className: 'exp-plan-row', key: i },
                h('span', { className: 'exp-plan-id' }, esc(tk.id)),
                h('input', { className: 'exp-plan-in', value: tk.title || '', placeholder: t('任务标题', 'task title'),
                  onChange: function (e) { var v = e.target.value; draftEdit(function (d) { d.tasks[i].title = v }) } }),
                h('select', { className: 'exp-plan-sel', value: tk.owner || '', onChange: function (e) { var v = e.target.value; draftEdit(function (d) { d.tasks[i].owner = v }) } },
                  (dv.roles || []).map(function (r) { return h('option', { key: r, value: r }, roleLabel(r)) })),
                h('input', { className: 'exp-plan-dep', value: (tk.dependsOn || []).join(','), placeholder: t('依赖', 'deps'), title: t('依赖任务 id，逗号分隔', 'dependsOn ids, comma separated'),
                  onChange: function (e) { var v = e.target.value; draftEdit(function (d) { d.tasks[i].dependsOn = v.split(',').map(function (s) { return s.trim() }).filter(Boolean) }) } }),
                h('b', { className: 'exp-plan-x', title: t('删除任务', 'delete task'), onClick: function () { draftEdit(function (d) { d.tasks.splice(i, 1) }) } }, '✕'))
            }),
            h('div', { className: 'exp-plan-btns' },
              h('button', { className: 'exp-plan-b', onClick: function () {
                draftEdit(function (d) { d.tasks = (d.tasks || []).concat([{ id: 'T-' + String((d.tasks || []).length + 1).padStart(2, '0'), kind: 'implementation', owner: (d.roles || [])[0] || 'frontend', title: '', spec: '', acceptance: [], inScope: [], verify: [], dependsOn: [] }]) })
              } }, t('＋ 任务', '＋ task')),
              h('button', { className: 'exp-plan-b', onClick: function () { planPost('', { draft: draftV }) } }, t('💾 保存草稿', '💾 Save')),
              h('button', { className: 'exp-plan-b go', onClick: function () { planPost('/approve', {}) } }, t('✅ 批准并运行', '✅ Approve & Run')),
              h('button', { className: 'exp-plan-b bad', onClick: function () { planPost('/discard', {}) } }, t('🗑 丢弃', '🗑 Discard'))))
        } else if (data && data.planStatus === 'discarded') {
          planEditor = h('div', { className: 'exp-plan-discarded' },
            t('🗑 计划已丢弃，禁止自动重建（如需重来请明确要求）', '🗑 Plan discarded — auto-recreate blocked'))
        }

        var tasksTab = h('div', null,
          planEditor,
          h('div', { className: 'exp-sec exp-sec-col', onClick: function () { setListOpen(!listOpen) }, title: t('点击展开/收起', 'click to expand/collapse') },
            h('span', { className: 'exp-chev' }, listOpen ? '\u25be' : '\u25b8'),
            h('span', null, t('任务清单（点看详情）', 'Tasks (click for detail)') + ' (' + tasks.length + ')' + (usingLiveTasks ? t(' · 实时视图', ' · live') : '')),
            !listOpen && listSummary ? h('span', { className: 'exp-muted', style: { fontWeight: 400 } }, esc(listSummary)) : null),
          listOpen ? (taskRows.length ? taskRows : h('div', { className: 'exp-empty' }, t('（暂无任务）', '(no tasks)'))) : null,
          // 诚实标注：这些行不是 TASKS.json，而是从活子代理投影出来的只读视图。
          usingLiveTasks ? h('div', { className: 'exp-legend', key: 'live-note' },
            t('⚠ TASKS.json 为空（本轮未按协议回写任务）——以下 ' + tasks.length + ' 行为「实时子代理投影」：角色由各子代理的 prompt 推断，状态取活动态，依赖关系无从得知。', '⚠ TASKS.json is empty — the rows below are a LIVE projection of subagents (role inferred from each prompt; no dependency data).')) : null,
          h('div', { className: 'exp-sec' }, t('团队视图', 'View'),
            h('span', { className: 'exp-toggle', onClick: function () { setView('canvas') }, style: viewV === 'canvas' ? { borderColor: '#0969da', color: '#0969da' } : null }, t('编队画布', 'Team canvas')),
            // dag 这个键在 live 投影下展示的是"按角色分组"，所以标签随数据源换词，但**视图分支与实现不动**
            h('span', { className: 'exp-toggle', onClick: function () { setView('dag') }, style: viewV === 'dag' ? { borderColor: '#0969da', color: '#0969da' } : null }, usingLiveTasks ? t('按角色分组', 'By role') : t('紧凑图', 'Compact graph')),
            h('span', { className: 'exp-toggle', onClick: function () { setView('panorama') }, style: viewV === 'panorama' ? { borderColor: '#0969da', color: '#0969da' } : null }, t('任务人员流转', 'Task-person flow'))),
          viewV === 'canvas'
            ? canvasEl
            : usingLiveTasks && viewV === 'dag'
            ? liveGroups
            : viewV === 'dag'
            ? h('div', null,
                h('div', { className: 'exp-legend' }, (function () {
                  var counts = dagStatusCounts(tasks)
                  return dagStatusOrder().map(function (s) {
                    var m = dagStatusMeta(s)
                    var n = counts[s] || 0
                    var cls = 'exp-legend-item' + (m.active && n ? ' live' : '') + (n ? '' : ' zero')
                    return h('span', { key: s, className: cls, title: m.label + '：' + n + ' 项' }, h('i', { style: { background: m.color } }), esc(m.label), n ? h('b', null, ' ' + n) : null)
                  })
                })()),
                dagSvg(tasks, function (t) { var same = selTaskV && selTaskV.id === t.id; setSelTask(same ? null : t); if (!same) focusPanelRight() }, selTaskV && selTaskV.id, hoverId, setHover))
            : h('div', null, flowDiagram || panorama),
          selTaskV ? h(TaskDetail, { task: selTaskV, member: members[selTaskV.owner], current: tasks.filter(function (t2) { return t2.owner === selTaskV.owner && ['in_progress', 'claimed', 'rework'].indexOf(t2.status) >= 0 })[0], files: (data && data.files) || [], logTail: (data && data.logTail) || '', onOp: taskOp }) : null)

        var infoTab = h('div', null,
          h('div', { className: 'exp-sec' }, t('质量门禁', 'Quality gates')),
          violations.length
            ? h('div', { className: 'exp-viol-list' }, violations.map(function (v, i) { return h('div', { key: i }, '❌ ' + esc(v)) }))
            : h('div', { className: 'exp-empty' }, t('✅ 无违规：verify/verdict/归属/依赖门一致', '✅ clean: verify/verdict/ownership/deps OK')),
          (data && data.logTail) ? [h('div', { className: 'exp-sec' }, t('实时日志（最新）', 'Run log (latest)')), h('pre', { className: 'exp-log' }, esc(data.logTail))] : null,
          h('div', { className: 'exp-sec' }, t('覆盖率（用户约束 → 任务）', 'Coverage (constraint → tasks)')),
          coverageRows.length ? coverageRows : h('div', { className: 'exp-empty' }, t('（design 阶段填）', '(set in design)')),
          h('div', { className: 'exp-sec' }, t('工件（点击预览）', 'Artifacts (click to preview)')),
          h('div', {}, artifactBar),
          selArtV ? h('div', { className: 'exp-preview' }, esc(artTextV || t('加载中…', 'Loading…'))) : null,
          h('div', { className: 'exp-sec' }, t('代码索引（Enter 搜索）', 'Code index (Enter to search)')),
          h('div', { className: 'exp-codeidx' },
            h('input', { className: 'exp-search', value: qV, placeholder: t('搜索符号/文件名/关键词…', 'Search symbol/file/keyword…'), onInput: function (e) { setQ(e.target.value) }, onKeyDown: function (e) { if (e.key === 'Enter') codeSearch() } }),
            qInfoV && qInfoV.source ? h('div', { className: 'exp-muted', style: { margin: '3px 0' } }, esc(t('索引时间 ', 'index ') + String(qInfoV.source).replace('T', ' ').slice(5, 16) + (qInfoV.built ? t(' · 已自动重建', ' · rebuilt') : ''))) : null,
            qHitsV ? h('div', { className: 'exp-qhits' },
              qHitsV.length ? qHitsV.slice(0, 12).map(function (ht, i) {
                return h('div', { key: i, className: 'exp-qhit', onClick: function () { openFileView(ht.file) }, title: t('点击在浮层内预览文件', 'click to preview') }, esc(String(ht.file) + ':' + ht.line + '  [' + ht.kind + '] ' + ht.name))
              }) : h('div', { className: 'exp-empty' }, t('无命中', 'no hits'))) : null),
          fileV ? h('div', { className: 'exp-fileview' },
            h('div', { className: 'exp-fileview-h' },
              h('span', null, esc(String(fileV.path))),
              h('button', { className: 'exp-feed-x', onClick: function () { setFileV(null) } }, '✕')),
            h('pre', { className: 'exp-log' }, esc((fileV.text || '').slice(0, 16000)))) : null)

        var boardTab = h('div', null,
          h('div', { className: 'exp-sec' }, t('全部 run（跨工作区，按更新时间排序）', 'All runs (updated first)')),
          (runsAll.length ? runsAll.slice().sort(function (a, b) { return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) }).map(function (ri, i) {
            var tot = ri.total || 0, dn = ri.done || 0
            return h('div', { className: 'exp-board-row', key: i, onClick: function () { setSelRun({ workspace: ri.workspace, runId: ri.runId }) }, title: (ri.health === 'broken' && ri.healthReason) ? ri.healthReason : ri.workspace },
              h('span', { className: 'exp-board-t' }, esc(String(ri.updatedAt || '').replace('T', ' ').slice(5, 16))),
              h('span', { className: 'exp-board-n' }, esc(String(ri.runId).slice(0, 22))),
              h('span', { className: 'exp-muted' }, esc(
                runHealthBadge(ri)
                  ? runHealthBadge(ri) + ' · ' + dn + '/' + tot + (ri.violations ? ' · ⚠' + ri.violations : '')
                  : phaseLabel(ri.phase) + '/' + statusLabel(ri.status) + ' · ' + dn + '/' + tot + (ri.members ? ' · ' + ri.members + '人' : '') + (ri.violations ? ' · ⚠' + ri.violations : '')
              )),
              h('span', { className: 'exp-role' }, esc(basename(ri.workspace) || ri.workspace)))
          }) : h('div', { className: 'exp-empty' }, t('（暂无 run）', '(no runs)')))
        )
        return h('div', { className: panelCls, style: panelStyle },
        h('style', null, CSS),
        (docked && !viewMode) ? h('div', { className: 'exp-dock-handle', title: '拖拽调宽', onMouseDown: function (e) { startResize(e, pw) } }) : null,
        h('div', { className: headCls, onMouseDown: function (e) { startDrag(e, docked && !viewMode, pos) } },
          h('div', { className: 'exp-title' }, h('span', { className: 'exp-live', title: t('实时刷新中', 'live') }), '🧑‍🔬 ' + t('专家团', 'Team')),
          h('span', { className: 'exp-run' }, runId ? esc(runId) : ''),
          warmingList.length ? h('span', { className: 'exp-warming', title: t('后台处理中（', 'working in background: ') + warmingTitle + warmingTail }, t('更新中', 'warming')) : null,
          capKeys.length ? h('span', { className: 'exp-scope', title: t('按设计上限（不是故障）：', 'by design, not a failure: ') + capTitle }, t('另有 ' + capOver + ' 条按上限只列名', capOver + ' capped (name only)')) : null,
          h('span', { style: { display: 'flex', gap: 6 } },
            !viewMode ? h('button', { className: 'exp-close', title: docked ? t('转为可拖动浮窗', 'Make floating') : t('停靠回右侧', 'Dock right'), onClick: function () { setDock(!docked) } }, docked ? t('浮动', 'Float') : t('停靠', 'Dock')) : null,
            viewMode ? h('button', { className: 'exp-close', onClick: function () { try { if (props && props.openView) props.openView('chat', '') } catch (e) {} } }, t('回到对话', 'Chat')) : null,
            !viewMode ? h('button', { className: 'exp-close', onClick: setOpen }, t('关闭', 'Close')) : null)),
        h('div', { className: 'exp-modehint' },
          viewMode
            ? t('💡 全屏画布 · 想边聊边看？点会话头的「🧑‍💼」徽章打开并排面板', 'Full canvas · tip: use the 🧑‍💼 header badge for a side-by-side panel')
            : t('💡 并排面板 · 想要全屏画布？切到上方「🧑‍🔬 专家团」标签', 'Side panel · tip: switch to the 🧑‍🔬 team tab above for the full canvas')),
        h('div', { className: 'exp-body' },
          errV ? h('div', { className: 'exp-err' }, esc(errV)) : null,
          selNode,
          data ? [
            h('div', { className: 'exp-prog' }, h('div', { className: 'exp-prog-fill', style: { width: pct + '%' } })),
            h('div', { className: 'exp-meta' }, h('span', null, t('阶段', 'Phase') + ' ' + esc(phaseLabel(data.phase)) + ' / ' + esc(statusLabel(data.status)) + (tierBadge(data.tier) ? ' · ' + esc(tierBadge(data.tier)) : '') + (data.goal ? ' · ' + esc(String(data.goal).slice(0, 46)) : '')), h('b', null, pct + '%')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginBottom: 4 } },
              modelsLine ? h('span', { className: 'exp-muted' }, esc(modelsLine)) : null,
              planLine ? h('span', { className: 'exp-muted' }, esc(planLine)) : null),
            h('ol', { className: 'exp-path' }, stepper),
            (data.pendingDecision && data.pendingDecision.options && data.pendingDecision.options.length) ? h(DecisionCard, { decision: data.pendingDecision, onChoose: function (id, label) { decide({ choice: label || id }) } }) : null,
            tabBar,
            tab === 'team' ? teamTab : (tab === 'tasks' ? tasksTab : (tab === 'board' ? boardTab : infoTab))
          ] : null))
      } catch (e) {
        return h('div', { className: 'exp-preview' }, 'PANEL ERR: ' + esc(String(e && e.stack ? e.stack : e)).slice(0, 800))
      }
    }

    function Boundary(props) { var e = useState(null); if (e[0]) return h('div', { className: 'exp-preview' }, t('专家团面板渲染出错：', 'Team panel render error: ') + esc(String(e[0] && e[0].message || e[0]))); return h('div', {}, props.children) }
    function wrap(Component) { return function (props) { return h(Boundary, null, h(Component, props || {})) } }

    // ── 统一的 /state 加载器（2026-09-15 性能修复 #2）────────────────────────────
    // 为什么必须统一：同一个重端点在客户端曾有三套轮询 —— 面板组件自己的 load()、
    // HeaderButton 徽章与画布共用的 liveStore.liveTick()（还有画布标签自己那一份）。
    // 画布一开就有 2–3 个 setInterval 并发压同一个 /state（实测 10 秒 7 发、6 次重叠，
    // 单发被拖到 5.9/8.3 s；服务端每请求还有 ~2 s 同步 CPU ⇒ 把整个 web 一起拖慢）。
    // 现在**所有** /state 拉取都经这里：
    //   ① 同一 URL 同刻只跑一次（in-flight 合并，后来者复用在飞 promise 的结果）；
    //   ② 全局**一个**时钟（不再每个组件一个 setInterval）；
    //   ③ 间隔 = clamp(max(基础间隔, 上次耗时×2), 基础间隔, 30000)；
    //      团队有人在跑时基础间隔按 40% 加速（面板原有意图，现在对徽章/画布同样生效）。
    // 纪律不变：**未回绝不发下一个**（晚一点看到状态，好过把 web 拖死）。
    var stateHub = { inflight: {}, lastMs: {}, lastAt: {}, subs: [], timer: 0, busy: false }
    function stateHubNow() { return (window.performance && performance.now) ? performance.now() : Date.now() }
    function stateHubUrls() { var out = []; stateHub.subs.forEach(function (x) { if (out.indexOf(x.url) < 0) out.push(x.url) }) ; return out }
    // 每个 URL 的**自己的**基础间隔（同一 URL 有多个订阅者时取最小 ⇒ 谁最急听谁的）。
    // 性能修复 #3 的"一快一慢"就靠它：`summary` 3 s 一发、`people,feed,artifacts` ≥ 6 s 一发，
    // 两者互不拖拽（旧实现是"全局取最小 base、每个 tick 把所有 URL 都拉一遍" ⇒ 慢的那份被快钟拖着跑）。
    function stateHubBaseOf(u) {
      var base = 0
      stateHub.subs.forEach(function (x) { if (x.url === u && (!base || x.base < base)) base = x.base })
      if (!base) base = 3000
      return stateHub.busy ? Math.max(300, Math.round(base * 0.4)) : base
    }
    function stateHubDueAt(u) { return (stateHub.lastAt[u] || 0) + stateHubBaseOf(u) }
    function stateHubSchedule() {
      clearInterval(stateHub.timer)
      stateHub.timer = 0
      if (!stateHub.subs.length) return
      var slowest = 0
      stateHubUrls().forEach(function (u) { if ((stateHub.lastMs[u] || 0) > slowest) slowest = stateHub.lastMs[u] })
      var now = stateHubNow(), earliest = Infinity
      stateHubUrls().forEach(function (u) { var at = stateHubDueAt(u); if (at < earliest) earliest = at })
      if (!isFinite(earliest)) earliest = now + 3000
      // 基础等待 = 最早到期的那一刻；再按"最慢一次请求 ×2"放大（未回绝不发下一个的纪律仍由
      // in-flight 守卫保证，这里的放大只是为了别把慢端点压成队列）。
      var wait = Math.max(200, Math.round(earliest - now))
      var next = Math.max(wait, Math.min(30000, Math.round(slowest * 2)))
      stateHub.timer = setInterval(stateHubTick, next)
    }
    function stateHubDeliver(url) {
      return function (d) {
        var list = stateHub.subs.slice()
        for (var i = 0; i < list.length; i++) { if (list[i].url === url) { try { list[i].onData(d) } catch (e) {} } }
      }
    }
    function stateHubFetch(url, onData) {
      if (typeof fetch === 'undefined') return
      var p = stateHub.inflight[url]
      if (p) { p.then(function (d) { try { onData(d) } catch (e) {} }); return }  // 同刻同 URL：复用在飞结果
      var t0 = stateHubNow()
      // 记"上次发出时刻"：即使**失败**也记（否则失败会变成热循环重试）。
      stateHub.lastAt[url] = t0
      p = fetch(url).then(function (r) { return r.ok ? r.json() : null }).then(function (d) {
        delete stateHub.inflight[url]
        stateHub.lastMs[url] = Math.max(0, stateHubNow() - t0)
        return d
      }, function () { delete stateHub.inflight[url]; return null })
      stateHub.inflight[url] = p
      p.then(function (d) { try { onData(d) } catch (e) {} })
    }
    function stateHubTick() {
      if (!stateHub.subs.length) { clearInterval(stateHub.timer); stateHub.timer = 0; return }
      var now = stateHubNow()
      // **只发改到期的那些 URL**（不是每个 tick 把所有 URL 拉一遍）
      stateHubUrls().forEach(function (u) { if (stateHubDueAt(u) <= now && !stateHub.inflight[u]) stateHubFetch(u, stateHubDeliver(u)) })
      stateHubSchedule()
    }
    function stateHubSubscribe(url, base, onData) {
      var sub = { url: url, base: base || 3000, onData: onData }
      stateHub.subs.push(sub)
      stateHubFetch(url, onData)      // 立即拉一次（面板/徽章打开即有数据）
      stateHubSchedule()
      return function () {
        var i = stateHub.subs.indexOf(sub)
        if (i >= 0) stateHub.subs.splice(i, 1)
        if (!stateHub.subs.length) { clearInterval(stateHub.timer); stateHub.timer = 0 }
        else stateHubSchedule()
      }
    }

    // ── 共享 state 轮询（HeaderButton / LiveCapsule 复用，单例；无订阅者即停）──
    var liveStore = { data: null, sid: '', off: null, subs: new Set() }
    // 徽章/胶囊的基础节奏：它订阅的是 `people,feed`（重分节）。原先 2.5 s 等于**让重活常驻**
    // （即使没开面板也在拉），实测那正是"重请求在飞时 summary 被拖到 772 ms"的来源之一。
    // 徽章是环境状态（有没有人在跑／有没有待决策），10 s 的延迟可以接受；
    // 需要立刻刷新时另有 `liveTick()`（子代理出现时主动催一次），不靠高频轮询。
    var LIVE_BASE_MS = 10000
    function liveUrl(sid) { return '/plugins/dsh-expert-team/state?sessionId=' + encodeURIComponent(sid) + '&section=people,feed' }
    // 手动催一次（子代理刚出现时立刻刷新一次徽章，不必等下一个 tick）
    function liveTick() {
      var sid = liveStore.sid
      if (!sid || typeof fetch === 'undefined') return
      stateHubFetch(liveUrl(sid), liveDeliver)
    }
    // 会话 id → 角色名（来自 /state 的 agents[]，**只用于把 id 翻译成可读名字**）。
    // 为什么不参与判定：判定必须与页头同源（宿主会话态）。这份映射只是显示层的润色，
    // 缺了它就回落 id 前 8 位；它来自本来就有的 /state 拉取（页头徽章/面板），**不新增任何请求**。
    var liveRoles = {}
    function harvestRoles(d) {
      try {
        var arr = (d && Array.isArray(d.agents)) ? d.agents : null
        if (!arr) return
        for (var i = 0; i < arr.length; i++) {
          var a = arr[i]
          if (a && a.id && a.role) liveRoles[String(a.id)] = String(a.role)
        }
      } catch (e) {}
    }
    function liveDeliver(d) {
      if (!d) return
      liveStore.data = d
      try { harvestActivity(d) } catch (e) {}
      try { harvestRoles(d) } catch (e) {}
      try { stateHub.busy = teamBusy(d) } catch (e) {}
      liveStore.subs.forEach(function (f) { try { f(d) } catch (e) {} })
    }
    function teamBusy(d) {
      var m = (d && d.members) || {}
      return Object.keys(m).some(function (k) { var v = m[k]; return v && typeof v === 'object' && (v.activity === 'running' || v.shortStatus === 'running') })
    }
    // ── 子代理运行状态条的**唯一**判据（纯函数，无 React、无 DOM：便于单测直接断言）──────
    // 与页头「N 个子代理」**同源**：宿主会话态（host session store）里 `running` 为真的子代理。
    // 之前的版本读插件自己的 `/state` → `agents[].activity === 'running'`，那是**错的**：服务端把
    // 子代理语料的归属会话解析成「当前 run 的 ownerSession」（`lib/command.js` 的 `peopleSid`），
    // 客户端传的 sessionId 会被忽略 ⇒ 新 run 还没落 `STATE.json` 时视图会落到同工作区的旧 run 上，
    // 面板拿到别人的（已冷的）子代理，状态条就谎报「无子代理在运行」。
    // 两种"零"必须分清：拿不到会话态（null 快照 / 无 sid）是"未知"⇒ 不渲染；只有拿到会话态且
    // 里面没有 running 的子代理后代，才是"确实没有人在跑"。

    /**
     * 正在运行的子代理 id（宿主会话态的 `running` 字段，**与页头「N 个子代理」同源**）。
     *
     * 为什么不再用插件自己的 `/state` → `agents[].activity`：服务端把子代理语料的**归属会话**
     * 解析成「当前 run 的 ownerSession」（`lib/command.js` 的 `peopleSid`），于是**客户端传的
     * sessionId 会被忽略**。真机实测的翻车场景：一个刚开跑、还没落 `STATE.json` 的新 run，
     * 在 `newestRun` 按 `updatedAt` 排序时输给同工作区一个 13 天前的旧 run，于是本会话明明
     * 有子代理在跑，面板却拿到旧 run 的 82 个**已冷**子代理（`activity:'inactive'`）⇒ 状态条
     * 谎报「无子代理在运行」。改用宿主会话态后，既与页头同源，又不再经过那条会串会话的解析。
     *
     * 两个集合都要：`byId` 给 `running`/`origin`/`parentId`，`items` 给直接子会话
     * （`parentSessionId` + `origin:'subagent'`）—— 只靠其一都会漏（与页头同一套数据源）。
     * 计数按**会话是当前会话的子代理后代**判定（任一深度），不是只数直接子级。
     */
    function runningSubagentIds(sessions, sid) {
      var out = []
      if (!sid || !sessions || typeof sessions !== 'object') return out
      var byId = sessions.byId || {}
      var items = Array.isArray(sessions.items) ? sessions.items : []
      var seen = {}
      function consider(id, running) {
        if (!id) return
        var k = String(id)
        if (seen[k] || !running) return
        seen[k] = 1
        out.push(k)
      }
      // ① 直接子会话：列表项自带 parentSessionId + origin
      items.forEach(function (s) {
        if (!s) return
        if (s.origin !== 'subagent') return
        if (String(s.parentSessionId || '') !== String(sid)) return
        consider(s.sessionId, s.running === true)
      })
      // ② 任一深度的后代：沿 byId 的 parentId 往上走，只有 origin==='subagent' 才继续
      Object.keys(byId).forEach(function (key) {
        var e = byId[key]
        if (!e || e.origin !== 'subagent') return
        var cur = e
        var guard = 0
        while (cur && cur.parentId !== undefined && guard++ < 64) {
          if (String(cur.parentId) === String(sid)) { consider(key, e.running === true); return }
          var up = byId[String(cur.parentId)]
          if (!up || up.origin !== 'subagent') return
          cur = up
        }
      })
      return out
    }

    /**
     * 状态条视图模型（纯函数）。返回值：
     *   null                      → 不渲染（没有会话 / 会话态还没到）
     *   { kind: 'idle',  text }   → 一行灰字：确实没有子代理在跑
     *   { kind: 'busy',  n, text, names } → 运行中横幅
     * `names` 取不到角色名时回落 id 前 8 位（如实显示"这是谁"，不编造角色名）。
     */
    function subagentBarModel(sessions, sid) {
      if (!sid || !sessions || typeof sessions !== 'object') return null
      if (!sessions.byId && !Array.isArray(sessions.items)) return null
      // `/state` 的 role 名（可选）：只用于把 id 翻成更好读的角色名，**不参与任何判定**
      var roles = (sessions.__roles && typeof sessions.__roles === 'object') ? sessions.__roles : {}
      var run = runningSubagentIds(sessions, sid)
      if (!run.length) return { kind: 'idle', n: 0, text: t('无子代理在运行', 'No subagents running'), names: [] }
      var names = run.slice(0, 3).map(function (id) {
        var nm = roleLabel(roles[id])
        return nm || String(id).slice(0, 8)
      })
      var more = run.length > 3 ? ' +' + (run.length - 3) : ''
      return {
        kind: 'busy', n: run.length, names: names,
        text: t(run.length + ' 个子代理运行中', run.length + ' subagent(s) running') + more
      }
    }
    // ── 面板/画布 → 徽章的**发布**路径（性能收尾批次）────────────────────────────
    // 为什么需要：徽章订阅的是 `people,feed`（重分节）。若它一直自己轮询，而当前标签是「料」
    // （重分节 = `artifacts`），同一时刻就有**两条重活并发** —— 真机上那正是单发从 2.4 s 变
    // 4.8 s 的原因（同一事件循环上串行，各自看着都慢一倍），连带把 9 ms 的 summary 拖到 772 ms。
    // 现在：面板/画布开着时由它们**发布**同一份 payload（零额外请求）；都没开时徽章才自己轮询。
    var livePublishers = 0
    function publishToLive(d) {
      if (!d || typeof d !== 'object') return
      // 合并而不是替换：面板按标签只发一部分块（缺块 ≠ 空数据），合并后徽章不会因为
      // 收到一份只有 summary 的负载就把已知的成员/活动抹掉。
      // ⚠️ 但浅合并**只做到"缺键保留"**：summary 那一发是**带着桩键**来的
      // （实测 `members:{}` / `agents:[]`）⇒ 只写下面那行，徽章/胶囊已知的成员与 `agents`
      // 活状态照样被抹空（`RoleToolView` 的实时状态、`teamBusy` 都读它 —— 与面板的
      // 缺陷 C 同一个根因）。所以先把负载过一遍与面板**同一条**规则 `mergeStatePayload`
      // （它会把"没算过"的派生字段还原成旧值），再照原样浅合并。
      d = mergeStatePayload(liveStore.data, d)
      liveStore.data = Object.assign({}, liveStore.data || {}, d)
      try { harvestActivity(liveStore.data) } catch (e) {}
      try { harvestRoles(d) } catch (e) {}
      try { stateHub.busy = teamBusy(liveStore.data) } catch (e) {}
      liveStore.subs.forEach(function (f) { try { f(liveStore.data) } catch (e) {} })
    }
    function setLivePublisher(on) {
      livePublishers += on ? 1 : -1
      if (livePublishers < 0) livePublishers = 0
      notify()
    }
    function useLivePublishers() { return useExternal(function () { return livePublishers }) }

    function useLiveState(sid) {
      var st = useState(liveStore.data); var data = st[0], setData = st[1]
      var pubs = useLivePublishers()
      useEffect(function () {
        if (!sid) return undefined
        liveStore.sid = sid
        var fn = function (d) { setData(d) }
        liveStore.subs.add(fn)
        // 有人发布（面板/画布开着）⇒ 徽章**不再另开一条重分节**，靠发布的数据保持新鲜。
        if (pubs > 0) return function () { liveStore.subs.delete(fn) }
        // 经 hub 订阅：与面板/画布共用同一个时钟与在飞守卫（这里**不再**自己 setInterval）
        var off = stateHubSubscribe(liveUrl(sid), LIVE_BASE_MS, liveDeliver)
        return function () {
          liveStore.subs.delete(fn)
          off()
        }
      }, [sid, pubs])
      return data
    }
    // 头部徽章文案：让「并排面板」入口自带团队实时状态（与画布标签职责区分）
    function teamBadge(live) {
      if (!live || !live.ok) return { text: '🧑‍💼 专家团', title: '并排团队面板' }
      var tasks = live.tasks || []
      var done = tasks.filter(function (t) { return ['done', 'completed'].indexOf(t.status) >= 0 }).length
      var dec = !!(live.pendingDecision && live.pendingDecision.options && live.pendingDecision.options.length)
      var viol = (live.violations || []).length
      var members = live.members || {}
      var running = Object.keys(members).some(function (k) { var m = members[k]; return m && typeof m === 'object' && m.activity === 'running' })
      if (dec) return { text: '🤔 待你拍板', cls: ' dec', title: '团队等待你的决策' }
      if (viol) return { text: '⚠ ' + viol + ' 违规', cls: ' warn', title: '门禁违规 ' + viol + ' 项' }
      if (running) return { text: '🧑‍💼 ' + done + '/' + tasks.length + ' 运行中', cls: ' run', pulse: true, title: '运行中 · ' + phaseLabel(live.phase || '') + '/' + statusLabel(live.status || '') }
      if (live.status === 'complete' || live.phase === 'deliver') return { text: '✅ 已完成', cls: ' done', title: '已完成 · ' + phaseLabel(live.phase || '') + '/' + statusLabel(live.status || '') }
      if (!tasks.length && !Object.keys(members).length) return { text: '🧑‍💼 专家团', title: '本工作区还没有 run' }
      return { text: '🧑‍💼 ' + done + '/' + tasks.length, title: phaseLabel(live.phase || '') + '/' + statusLabel(live.status || '') }
    }

    /**
     * 当前会话 id。优先用宿主 `uiSession` 适配器的 current 绑定（贴会话作用域真源）；
     * 拿不到（宿主 API 形状变了）就回落到 HeaderButton 维护的会话 store —— 两种都拿不到
     * 就返回 null ⇒ 状态条不渲染（宁可不显示，也不显示"别人的会话"的子代理数）。
     */
    function useCurrentSessionId() {
      var sid = useCurrentSession()
      var st = useState(function () {
        try { var u = ctxUISession; var snap = (u && u.current && u.current.getSnapshot) ? u.current.getSnapshot() : null; return (snap && snap.value && snap.value.key) ? snap.value.key : null } catch (e) { return null }
      })
      var hostSid = st[0], setHostSid = st[1]
      useEffect(function () {
        var u = ctxUISession
        if (!u || !u.current || typeof u.current.subscribe !== 'function') return undefined
        function pull() {
          try { var s = u.current.getSnapshot(); setHostSid((s && s.value && s.value.key) ? s.value.key : null) } catch (e) { setHostSid(null) }
        }
        pull()
        return u.current.subscribe(pull)
      }, [])
      return hostSid || sid || null
    }

    /**
     * 「子代理运行中」状态条（注册进 conversation.input.dock ⇒ 输入框正上方）。
     * 常驻：运行中给醒目横幅，无人运行给一行灰字（用户要求"能一眼区分有没有在跑"）。
     * 判据 = 宿主会话态（与页头「N 个子代理」**同源**），**不再**读插件自己的 `/state`：
     * 那条路会把子代理语料的归属会话解析成「当前 run 的 ownerSession」，客户端传的 sessionId
     * 会被忽略 ⇒ 新 run 还没落 `STATE.json` 时视图落到旧 run，状态条谎报「无子代理在运行」。
     * 取数全程 try/catch：宿主 API 形状一变就退化成"不渲染这一条"，绝不把界面炸掉。
     */
    function SubagentBar(props) {
      // 会话 id 的解法与之前一致；`useCurrentSessionId()` **无条件**先调（钩子顺序必须稳定，
      // 不能因为这一帧有没有 props.sessionId 就少调一次）。
      var fallbackSid = useCurrentSessionId()
      ensureCss()
      var sid = (props && props.sessionId) || fallbackSid
      var snap = null
      var useSessions = props && props.useSessions
      if (typeof useSessions === 'function') {
        // 标准 prop：宿主把会话 store 的 hook 直接递给槽组件（页头「N 个子代理」用的同一份数据）。
        try { snap = useSessions(function (s) { return s }) } catch (e) { snap = null }
      } else {
        // 降级：宿主没递标准 prop（API 形状变了）时，直接向 `ctx.sessions` 的**同一个**会话
        // store 要列表快照（`{ ids, byId, current, … }`）。任何一步拿不到或抛错 ⇒ 保持 null
        // ⇒ subagentBarModel 返回 null ⇒ 不渲染（宁可不显示，也不显示"别人的会话"的子代理数）。
        try {
          var svc = ctxRoot && ctxRoot.sessions ? ctxRoot.sessions : null
          var list = svc && svc.list ? svc.list : null
          var st = (list && typeof list.getSnapshot === 'function') ? list.getSnapshot() : null
          if (!st && svc && typeof svc.getSnapshot === 'function') st = svc.getSnapshot()
          if (st && typeof st === 'object') snap = st
        } catch (e) { snap = null }
      }
      // 角色映射只影响**命名**，不参与判定：把它挂在交给 `subagentBarModel` 的输入上。
      // ⚠️ **不能写进 `snap`**：那是宿主会话 store 的共享/缓存快照，写进去会污染页头等别的视图。
      // 因此需要时才做一层浅拷贝（只复制自有键），再挂 `__roles`；任何一步出错都退回原快照 ⇒
      // 最坏也只是回落 id 前 8 位，绝不把状态条弄没。
      var modelInput = snap
      try {
        if (snap && typeof snap === 'object' && snap.__roles !== liveRoles) {
          modelInput = {}
          for (var k in snap) { if (Object.prototype.hasOwnProperty.call(snap, k)) modelInput[k] = snap[k] }
          modelInput.__roles = liveRoles
        }
      } catch (e) { modelInput = snap }
      var m = subagentBarModel(modelInput, sid)
      if (!m) return null
      if (m.kind === 'idle') return h('div', { className: 'exp-subbusy-idle' }, esc(m.text))
      function openPanel() {
        try {
          if (!open) { dockState = true; saveLS('et-dock', true); notify(); setOpen() }
        } catch (e) {}
        focusPanelRight()
      }
      return h('div', {
        className: 'exp-subbusy on',
        role: 'status',
        title: t(m.n + ' 个子代理正在运行（本会话）· 点击打开团队面板', m.n + ' subagent(s) running in this session · click to open the team panel'),
        onClick: openPanel
      },
        h('span', { className: 'exp-subbusy-dot' }),
        h('span', { className: 'exp-subbusy-t' }, esc(m.text)),
        m.names.length ? h('span', { className: 'exp-subbusy-who' }, esc(m.names.join(' · '))) : null,
        h('span', { className: 'exp-subbusy-go' }, esc(t('打开面板 ›', 'open panel ›'))))
    }

    function HeaderButton(props) {
      var sid = props && props.sessionId
      useEffect(function () { if (sid) setCurrentSession(sid) }, [sid])
      var isOpen = useOpen()
      var live = useLiveState(sid)
      // Open DOCKED (md-preview style: reserves space, never covers the
      // workspace). The in-panel「浮动」button switches to a draggable float.
      function toggle() { if (!isOpen) { dockState = true; saveLS('et-dock', true); notify(); setOpen() } else setOpen() }
      // CSS must exist for the HEADER button too — the panel's own <style> is
      // only in the DOM while the panel is open. Inject once, globally.
      ensureCss()
      var badge = teamBadge(live)
      var tip = '专家团 · ' + badge.title + '｜点击' + (isOpen ? '收起' : '打开') + '并排面板（全屏画布：切到上方「🧑‍🔬 专家团」标签）'
      return h('button', { className: 'exp-open exp-live-badge' + (badge.cls || ''), title: tip, onClick: toggle },
        h('span', { className: 'exp-live-dot' + (badge.pulse ? ' on' : '') }),
        esc(badge.text))
    }

    // ── 对话流「团队动态」胶囊（N1）：轮询 state 的 feed/阶段/门禁/决策，取最近事件 ──
    var activityQ = [] // {icon, text, ts}
    function pushActivity(icon, text) {
      try {
        var last = activityQ[0]
        if (last && last.text === text && Date.now() - (last.ts || 0) < 4000) return
        var entry = { icon: icon, text: String(text || '').slice(0, 90), ts: Date.now() }
        activityQ.unshift(entry)
        if (activityQ.length > 8) activityQ.length = 8
        // 1.3.4：停留时长来自设置 `display.capsuleMs`（0 = 不自动消失）。
        // ⚠️ 上面那个 4000 是**同文本去重窗口**，不是停留时长 —— 旧实现把它当停留时长，
        // 于是"胶囊 N 毫秒后消失"这个功能**压根不存在**（只入队、永不自动出队，>8 才截断）。
        var ttl = EXPERT_DISPLAY.capsuleMs
        if (ttl > 0) setTimeout(function () { var i = activityQ.indexOf(entry); if (i >= 0) { activityQ.splice(i, 1); notify() } }, ttl)
        notify()
      } catch (e) {}
    }
    var activitySeen = { phase: '', dec: '', viol: '', feed: '' }
    function harvestActivity(d) {
      try {
        if (!d || !d.ok) return
        if (d.phase && d.phase !== activitySeen.phase) { activitySeen.phase = d.phase; pushActivity('⚙️', '阶段 → ' + phaseLabel(String(d.phase))) }
        var dec = d.pendingDecision
        if (dec && dec.options && dec.options.length) {
          var dk = String(dec.title || '')
          if (dk !== activitySeen.dec) { activitySeen.dec = dk; pushActivity('🤔', '待你拍板：' + (String(dec.title || '').slice(0, 48) || '方案确认')) }
        } else if (activitySeen.dec) { activitySeen.dec = '' }
        if (d.violations && d.violations.length) {
          var vk = d.violations.join('|')
          if (vk !== activitySeen.viol) { activitySeen.viol = vk; pushActivity('⚠️', '门禁违规：' + String(d.violations[0]).slice(0, 48)) }
        }
        var feed = d.feed || {}
        var lastLine = '', lastRole = '', lastTs = 0
        Object.keys(feed).forEach(function (k) {
          var arr = feed[k] || []
          if (arr.length) {
            var e = arr[arr.length - 1]
            if (e && (!lastLine || (e.ts || 0) >= lastTs)) { lastLine = e.line || ''; lastRole = k; lastTs = e.ts || 0 }
          }
        })
        if (lastLine) {
          var fk = lastLine.slice(0, 80)
          if (fk !== activitySeen.feed) { activitySeen.feed = fk; pushActivity('📋', lastLine.slice(0, 68)) }
        }
      } catch (e) {}
    }
    function LiveCapsule(props) {
      var q = useExternal(function () { return activityQ.slice() })
      var openedS = useState(false); var opened = openedS[0], setOpened = openedS[1]
      var sid = props && props.sessionId
      useLiveState(sid) // 共享轮询：state 拉取与 harvestActivity 统一由 liveStore 驱动
      if (!q.length) return null
      var cur = q[0]
      return h('div', { className: 'exp-cap' + (opened ? ' open' : '') },
        h('span', { className: 'exp-cap-btn', onClick: function () { setOpened(!opened) }, title: t('专家团 · 团队动态', 'Team activity') },
          h('span', { className: 'exp-cap-dot' }),
          h('span', { className: 'exp-cap-tx' }, esc(String((cur.icon || '') + ' ' + cur.text).slice(0, 90)))),
        opened ? h('div', { className: 'exp-cap-panel' },
          q.map(function (a, i) {
            var tm = ''
            try { var dd = new Date(a.ts); tm = ('0' + dd.getHours()).slice(-2) + ':' + ('0' + dd.getMinutes()).slice(-2) } catch (e) {}
            return h('div', { className: 'exp-cap-row' + (i === 0 ? ' cur' : ''), key: i },
              h('span', { className: 'exp-cap-ic' }, esc(a.icon)), h('span', null, esc(a.text)),
              h('span', { className: 'exp-cap-t' }, esc(tm)))
          }),
          h('div', { className: 'exp-cap-foot' },
            h('button', { onClick: function () { try { if (!open) { dockState = true; saveLS('et-dock', true); notify(); setOpen() } } catch (e) {} } }, esc('🧑‍🔬 打开团队浮层'))))
        : null)
    }

    // ── N2：待拍板 composer 横幅（conversation.composer 接管）──
    function DecisionComposer(props) {
      var p = props && props.pendingInteraction
      var interact = (p && p.decision) || {}
      var opts = interact.options || []
      function choose(id) {
        // 「查看方案」（大需求确认横幅）：这是**查看**动作，不是决策 —— 直接打开该 run 的
        // SPEC.md 预览，**不发 /decide**（否则会把待决清掉，团队还没开工就被"确认"了）。
        if (/查看方案|view plan/i.test(String(id))) {
          try { openArtifact('SPEC.md', interact.runId || p.runId, p.workspace || interact.workspace) } catch (e) {}
          return
        }
        try {
          // 批 0-2：字段必须与 /decide 路由**逐字对齐**（sessionId|workspace 推 cwd + run + choice）。
          // 旧写法发 {sessionId, runId, id} ⇒ 路由判 400 bad params，用户点「执行」静默失败、
          // pendingDecision 永不清除。run/workspace 由 syncPending 随 pendingInteraction 发布。
          fetch('/plugins/dsh-expert-team/decide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: p.sessionId, workspace: p.workspace || '', run: p.runId || interact.runId || '', choice: id })
          }).then(function () { try { if (exports._resolvePending) exports._resolvePending() } catch (e) {} }).catch(function () {})
        } catch (e) {}
      }
      return h('div', { className: 'exp-decbar' },
        h('span', { className: 'exp-decbar-ic' }, '🤔'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'exp-decbar-t' }, esc(String(interact.title || t('专家团等待你的决策', 'Team needs your decision')))),
          interact.prompt ? h('div', { className: 'exp-decbar-p' }, esc(String(interact.prompt).slice(0, 90))) : null),
        h('div', { style: { display: 'flex', gap: 6, flex: 'none', flexWrap: 'wrap' } },
          opts.map(function (o) {
            var id = typeof o === 'string' ? o : ((o && o.id) || o.label || '')
            var lb = typeof o === 'string' ? o : (o && (o.label || o.id)) || id
            return h('button', { key: id, className: 'exp-opt', onClick: function () { choose(id) } }, esc(String(lb)))
          })))
    }

    // Test hook (same convention as the host half's `_live`): lets the regression
    // suite assert text safety without booting the overlay in a browser.
    exports._live = { esc: esc, tierBadge: tierBadge, TIER_LABELS_ZH: TIER_LABELS_ZH, settingsFormModel: settingsFormModel, runHealthBadge: runHealthBadge }
    // 测试钩子（沿用 `_live` 的约定）：状态条的纯函数可脱离浏览器直接断言。
    exports._subagentBar = { subagentBarModel: subagentBarModel, runningSubagentIds: runningSubagentIds }
    exports.inject = ['slots', 'sessions', 'remote', 'uiSession', 'uiConversation', 'locale']
    var ctxUISession = null
    // 宿主 ctx 本体：只给状态条**降级**取数用（标准 prop `useSessions` 拿不到时，退到
    // `ctx.sessions.list` 的同一份会话 store 快照）。声明位置与 `ctxUISession` 同理：
    // var 提升到工厂作用域，组件在 apply() 之后才渲染，读到的一定是已赋值的引用。
    var ctxRoot = null
    exports.apply = function (ctx) {
      console.log('[dsh-expert-team] client apply() called')
      try { ctxRoot = ctx || null } catch (e) { ctxRoot = null }
      try { ctxUISession = ctx && ctx.uiSession ? ctx.uiSession : null } catch (e) { ctxUISession = null }
      try {
        // N2：待拍板 pendingInteraction 发布（composer select 据此接管）
        var publishPending = (ctx.uiSession && ctx.uiSession.registerPendingInteraction) ? ctx.uiSession.registerPendingInteraction(function () { return 5 }) : null
        var pendingPub = null
        function resolvePending(fn) { try { if (pendingPub) { pendingPub.unsub(); pendingPub = null } } catch (e) {} try { if (fn) fn() } catch (e) {} }
        function syncPending(dec, sessionId, runId, workspace) {
          try {
            if (!publishPending) return
            var has = !!(dec && dec.options && dec.options.length)
            // 批 0-2：必须把 run/workspace 一起发布，否则 composer 横幅回传时无法满足 /decide 的必需字段
            // （pendingDecision 本体只有 title/prompt/options，不含 runId —— 之前的 dec.runId 恒空，导致恒 400）
            var runIdV = runId || (dec && dec.runId) || ''
            var wsV = workspace || (dec && dec.workspace) || ''
            if (has && !pendingPub) {
              pendingPub = publishPending({ type: 'et-decision', sessionId: sessionId, runId: runIdV, workspace: wsV, decision: { title: dec.title, prompt: dec.prompt, options: dec.options, runId: runIdV, workspace: wsV } }, function () { return Promise.resolve() })
            } else if (!has && pendingPub) {
              pendingPub.unsub(); pendingPub = null
            }
          } catch (e) {}
        }
        exports._syncPending = syncPending
        exports._resolvePending = resolvePending

        // CSS 必须在这里就注入：官方「设置」面板可以在**没有会话**（新会话/首屏）时打开，
        // 而原来这份 CSS 只挂在 HeaderButton 的渲染里 —— 那样设置面板会是一堆无样式的裸控件。
        ensureCss()

        // 设置页进**官方设置菜单**（`settings.section` 是宿主 ui-settings-general 声明、其它
        // 插件（agent-preset / models / plugins）同样在用的槽）。`ctx.slots.inject` 等的是**声明**
        // 而不是包顺序：宿主没声明该槽时这条贡献不会挂上，插件其余部分照常工作。
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'expert-team',
            order: 50,
            label: function () { return t('专家团', 'Expert team') }
          }, wrap(SettingsSection))
        })

        ctx.slots.inject('conversation.session.header.actions', function () {
          return ctx.slots.register({ name: 'conversation.session.header.actions', id: 'expert-team-open', order: 900, inject: function (sessionId) { return sessionId ? { sessionId: sessionId } : {} } }, wrap(HeaderButton))
        })
        // 子代理运行状态条：`conversation.input.dock` 是官方声明在 composer 之上的 list 槽
        // （文档原文 "Full-width entries above the composer card."），渲染位置在消息列表之后、
        // 输入框卡片之前 ⇒ 正是"对话框与输入框之间"。list 槽是**纯增**的（不接管、不遮蔽
        // queue/todo/goal 三个既有条目），所以这里 order 排在它们之后。
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register({ name: 'conversation.input.dock', id: 'expert-team-subagents', order: 200 }, wrap(SubagentBar))
        })
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'expert-team-panel', order: 100 }, wrap(Panel))
        })
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'expert-team-capsule', order: 110 }, wrap(LiveCapsule))
        })
        // N5：嵌入式画布视图标签（conversation.view，trajectory 同款范式）
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: 'expert-team',
            order: 20,
            label: function () { return '🧑‍🔬 ' + t('专家团', 'Team') },
            inject: function (sessionId) { return { sessionId: sessionId, mode: 'view' } }
          }, wrap(Panel))
        })
        // N2：待拍板横幅接管 composer（有 pendingInteraction=et-decision 时）
        ctx.slots.inject('conversation.composer', function () {
          return ctx.slots.register({
            name: 'conversation.composer',
            priority: 1,
            select: function (props) { var p = props && props.pendingInteraction; return (p && p.type === 'et-decision') ? p : null }
          }, wrap(DecisionComposer))
        })
        // 对话流角色化工具卡（官方 keyed slot）：subagent_<role> 调用 → 角色卡
        Object.keys(ROLE_TOOL).forEach(function (wire) {
          ctx.slots.inject('tool.call.toolview', function () {
            return ctx.slots.register({ name: 'tool.call.toolview', key: wire }, wrap(RoleToolView))
          })
        })
        // 接管 dsh 原生 workflow 运行卡：点成员不再打开新标签页，改为右侧面板看实时细节。
        // order:-1 让本条目在同一 cell 上压过原生条目（renderer：每个 cell 取 order 最小的存活条目）。
        // 可逆开关：localStorage['et-native-workflow']='1' → 不注册，回退 dsh 原生卡（刷新生效）。
        try {
          if (!nativeWfOn()) {
            ctx.slots.inject('conversation.chat.node', function () {
              // ⚠️ keyed 插槽的遮蔽参数是 **priority**（不是 order）：注册表实现里
              //   同 key 且同 priority 会**直接抛错**并让整个插件加载失败
              //   （实测：「keyed slot "conversation.chat.node" already has an entry for key
              //   "workflow-run" at priority 0 … register at a different priority to shadow it
              //   (lowest renders)」）；keyed 只按 priority 升序渲染，order 被忽略。
              //   这里动态挑一个未被占用的更低 priority，避免 dsh 改原生优先级后再撞。
              var prio = -1
              try {
                // 注意：下面的 register 必须自己 try/catch —— 它在本回调里执行，
                // 外层 try 只包住 ctx.slots.inject() 的调用，包不住回调抛错。

                var existing = (typeof ctx.slots.entriesOfSlot === 'function') ? (ctx.slots.entriesOfSlot('conversation.chat.node') || []) : []
                var used = {}
                existing.forEach(function (en) {
                  var k = en && en.options ? en.options.key : undefined
                  if (k === 'workflow-run') used[en.options.priority == null ? 0 : en.options.priority] = 1
                })
                while (used[prio]) prio -= 1
              } catch (e4) {}
              try {
                return ctx.slots.register({ name: 'conversation.chat.node', key: 'workflow-run', priority: prio }, wrap(WorkflowRunCard))
              } catch (e5) {
                // 注册失败只放弃"接管卡片"，绝不连累插件加载（历史上同 key 同 priority 会整站 Failed to load plugins）
                console.log('[dsh-expert-team] workflow card override refused, falling back to the native card:', e5 && e5.message || e5)
                return undefined
              }
            })
          }
        } catch (e3) { console.log('[dsh-expert-team] workflow card override skipped', e3 && e3.message || e3) }
      } catch (e) { console.log('[dsh-expert-team] apply() ERROR', e && e.message || e) }
    }

    return module.exports
  },
})
