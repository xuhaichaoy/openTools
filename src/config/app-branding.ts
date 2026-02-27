/**
 * 应用品牌配置 — 集中管理所有用户可见的品牌名称
 *
 * 需要改名时只改此文件即可（前端部分）。
 * Rust 端对应文件：src-tauri/src/branding.rs
 * 静态文件需手动同步：package.json / tauri.conf.json / index.html / README.md
 */

export const APP_NAME = "51ToolBox";
export const APP_NAME_EN = "51ToolBox";
export const APP_NAME_CN = "51工具箱";
export const APP_CLOUD_NAME = `${APP_NAME} Cloud`;
export const APP_DESCRIPTION = "AI-First 桌面效率工具箱";
export const APP_AI_ASSISTANT_NAME = `${APP_NAME} 内置助手`;

export const APP_IDENTIFIER = "com.51cto.toolbox";
export const APP_VERSION = "0.1.0";
export const APP_TECH_STACK = "Tauri v2 + React 19";
