/// 应用品牌配置 — 集中管理 Rust 端所有用户可见的品牌名称
///
/// 需要改名时只改此文件即可（Rust 部分）。
/// 前端对应文件：src/config/app-branding.ts
/// 静态文件需手动同步：package.json / tauri.conf.json / index.html / README.md

pub const APP_NAME: &str = "51ToolBox";
pub const APP_CLOUD_NAME: &str = "51ToolBox Cloud";
pub const APP_AI_ASSISTANT_DESC: &str = "51ToolBox 内置助手";
