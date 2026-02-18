/**
 * 统一用户/身份 Store — 合并 auth-store + team-store + server-store
 *
 * 为保持向后兼容，此文件作为统一入口 re-export 所有子 Store。
 * 新代码应从此文件导入；旧代码的导入路径仍然有效。
 */

export { useAuthStore } from "./auth-store";
export type { User } from "./auth-store";

export { useTeamStore } from "./team-store";
export type { Team, SharedResource } from "./team-store";

export { useServerStore, getServerUrl } from "./server-store";
