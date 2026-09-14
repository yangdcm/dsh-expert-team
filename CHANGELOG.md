# 变更记录

本包遵循[语义化版本](https://semver.org/lang/zh-CN/)。dsh 宿主版本线的对应关系写在
`package.json` 的 `engines.dsh` 与 `dsh.compatibility` 里，插件市场按它判断"这个插件跟你的宿主兼不兼容"。

## 1.1.1

**兼容性声明 + 可移植性修复**（不含功能变更）

- 新增 `engines.dsh: ">=0.1.5-rc.1"`、`dsh.compatibility`（含 `dshReleases` 与 `profiles: ["web"]`）
  与 `@deepseek-ai/dsh-*` 的 `peerDependencies`：市场卡片与插件市场据此显示宿主要求，
  不再一律显示"未知"。目前**实测通过**的宿主版本是 `0.1.5-rc.1`。
- 修复"只在作者机器上能过"的测试（这类问题会让任何 clone 下来跑 `npm run test:all` 的人全红）：
  - `flow.test.mjs` 原来读作者工作区里的真实 run 目录 → 夹具已入库 `regression.fixtures/waves.sample.json`
  - `log-parse-module.test.mjs` 原来读 `/tmp` 里的手工备份 → 基准已入库
    `regression.fixtures/live-keys-before-logparse.json`
  - `check-evidence.mjs` / `preview-dag.mjs` 不再假设"工作区根 = 包根往上两级"
  - `preset-lint.test.mjs` 在没有 dsh 的机器上跳过（而不是把它当成 15 项失败）
  - `token-accounting.test.mjs` 不再顶层静态导入 `zstdCompressSync`（Node 20 没有该导出）
- CI：Node 20 / 22 / 24 三档跑 `npm run test:all` 与包名残留检查；失败时把输出尾部贴成注解
  （job 日志下载需要仓库 admin 权限，注解无需鉴权）。

## 1.1.0

首次公开发布。

- 12 角色专家团（产品/架构/调研/界面设计/后端/前端/数据/安全审计/评审/测试/运维/文档）+
  9 阶段门控流水线（澄清 → 调研 → 设计 → 规格评审 → 方案确认 → 实现 → 审查 → 测试 → 交付）
- 共享工作区工件协议（`team/<run-id>/` 下的 SPEC / PLAN / TASKS / ROSTER / STATE / REVIEW / TEST / SUMMARY）
- 质量门禁由插件代码强制（状态机一致性、任务完成度、覆盖率、返工轮次），违规实时显示在浮层与 `/team status`
- live 团队浮层：阶段推进、成员与模型、任务 DAG、工件预览、人工决策按钮
- `/team` 命令面：一次性组队 / 持久化活团队 / 仅工件 / 先确认后开工 / 流程档位 / 画布 / 代码索引 /
  自学习 / 配额 / 冷启动清算
- 零运行时依赖、无构建步骤、无安装钩子
