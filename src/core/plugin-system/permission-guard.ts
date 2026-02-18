/**
 * 插件权限守卫
 *
 * 根据插件清单中声明的 permissions，决定是否允许特定 API 调用。
 * 内置插件（isBuiltin=true）默认拥有全部权限。
 */

import type { PluginPermission, PluginInstance } from "./types";

/** API 方法到所需权限的映射 */
const METHOD_PERMISSIONS: Record<string, PluginPermission> = {
  // 剪贴板
  clipboard_read: "clipboard",
  clipboard_write: "clipboard",
  clipboard_history_list: "clipboard",

  // 网络
  http_request: "network",
  fetch: "network",

  // 文件系统
  read_file: "filesystem",
  write_file: "filesystem",
  list_dir: "filesystem",
  create_dir: "filesystem",
  remove_file: "filesystem",

  // Shell
  run_shell_command: "shell",
  run_command: "shell",

  // 通知
  show_notification: "notification",

  // 系统
  system_action: "system",
};

/**
 * 检查插件是否有权调用指定 API 方法
 *
 * @param plugin   插件实例
 * @param method   API 方法名
 * @returns        { allowed: true } 或 { allowed: false, reason: string }
 */
export function checkPermission(
  plugin: PluginInstance,
  method: string,
): { allowed: true } | { allowed: false; reason: string } {
  // 内置插件不受限
  if (plugin.isBuiltin) {
    return { allowed: true };
  }

  const requiredPermission = METHOD_PERMISSIONS[method];

  // 未映射的方法默认允许（安全方法如 getTheme 等）
  if (!requiredPermission) {
    return { allowed: true };
  }

  const declared = plugin.manifest.mtools?.permissions ?? [];

  if (declared.includes(requiredPermission)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `插件「${plugin.manifest.pluginName}」未声明 "${requiredPermission}" 权限，无法调用 ${method}`,
  };
}

/**
 * 获取插件声明的所有权限
 */
export function getDeclaredPermissions(
  plugin: PluginInstance,
): PluginPermission[] {
  if (plugin.isBuiltin) {
    return ["clipboard", "network", "filesystem", "shell", "notification", "system"];
  }
  return plugin.manifest.mtools?.permissions ?? [];
}

/**
 * 权限的中文描述（用于 UI 展示）
 */
export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  clipboard: "剪贴板读写",
  network: "网络请求",
  filesystem: "本地文件读写",
  shell: "Shell 命令执行",
  notification: "系统通知",
  system: "系统操作",
};
