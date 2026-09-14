// @yangdcm/dsh-expert-team — bundle entry.
// The bundle's composition lives in cordis.patch.yml (the dsh.bundle.patch file).
// This module is the `.` export. It is ALSO a deliberate inert cordis plugin: the
// bundle patch adds a bundle-root row named exactly `@yangdcm/dsh-expert-team` so
// dsh-client-modules' Loader scan (which only considers exact package specifiers)
// discovers this package's `dsh.client` and serves the live overlay. It registers
// no service — the real work is `./command` (the /team command) and the skill.
export const name = 'dsh-expert-team';
export const inject = [];
export function apply() {
  /* inert marker row: exists so the client module scan discovers dsh.client */
}
// P4 清理（2026-09-13）：此处原有 `export const BUNDLE_NAME = '@yangdcm/dsh-expert-team';` ——
// 全仓（含 cordis.patch.yml / presets / 三副本）**无任何引用**，是纯死导出；已删除。
// 注意：bundle 的标识不靠它，靠 cordis.patch.yml 里那一行**逐字的包名**（见文件头注释）。
