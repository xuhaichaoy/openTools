/**
 * 插件桥接安全工具函数
 * 从 App.tsx 提取的 PostMessage 安全验证和嵌入命令白名单逻辑
 */

import { usePluginStore } from "@/store/plugin-store";
import { checkPermission } from "@/core/plugin-system/permission-guard";

/** 生成随机桥接 Token */
export function createBridgeToken(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 检查嵌入 origin 是否允许 */
export function isAllowedEmbedOrigin(origin: string): boolean {
  return origin === "null" || origin === window.location.origin;
}

/** 转换 postMessage 目标 origin */
export function toPostMessageTargetOrigin(origin: string | null): string {
  if (origin && origin !== "null") return origin;
  return "*";
}

/** 获取指定插件允许的嵌入命令集合 */
export function getAllowedEmbedCommands(pluginId: string): Set<string> {
  const plugin = usePluginStore
    .getState()
    .plugins.find((p) => p.id === pluginId && p.enabled);
  if (!plugin) return new Set<string>();

  const base = new Set<string>([
    "plugin_api_call",
    "open_url",
    "plugin_start_color_picker",
  ]);
  return base;
}

/** 验证插件 API 方法名是否在白名单中 */
export function isAllowedPluginApiMethod(method: unknown): method is string {
  if (typeof method !== "string") return false;
  const allowed = new Set<string>([
    "hideMainWindow",
    "showMainWindow",
    "setExpendHeight",
    "copyText",
    "showNotification",
    "shellOpenExternal",
    "shellOpenPath",
    "shellShowItemInFolder",
    "getPath",
    "copyImage",
    "setSubInput",
    "removeSubInput",
    "redirect",
    "dbStorage.setItem",
    "dbStorage.getItem",
    "dbStorage.removeItem",
    "outPlugin",
  ]);
  return allowed.has(method);
}

/** 验证插件 API 调用参数格式 */
export function isValidPluginApiCallArgs(args: Record<string, unknown>): args is {
  pluginId: string;
  method: string;
  args: string;
  callId: number;
} {
  return (
    typeof args.pluginId === "string" &&
    typeof args.method === "string" &&
    typeof args.args === "string" &&
    typeof args.callId === "number" &&
    Number.isFinite(args.callId)
  );
}

/**
 * 根据插件清单中声明的权限，检查外部插件是否有权调用指定方法。
 * 内置插件自动放行。
 *
 * @returns null 表示允许，否则返回拒绝原因
 */
export function checkPluginApiPermission(
  pluginId: string,
  method: string,
): string | null {
  const plugin = usePluginStore
    .getState()
    .plugins.find((p) => p.id === pluginId);
  if (!plugin) return `未找到插件 ${pluginId}`;

  const result = checkPermission(plugin, method);
  if (result.allowed) return null;
  return result.reason;
}
