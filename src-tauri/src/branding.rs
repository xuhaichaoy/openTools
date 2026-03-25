/// 应用品牌配置 — 集中管理 Rust 端所有用户可见的品牌名称
///
/// 需要改名时只改此文件即可（Rust 部分）。
/// 前端对应文件：src/config/app-branding.ts
/// 静态文件需手动同步：package.json / tauri.conf.json / index.html / README.md

pub const APP_NAME: &str = "HiClow";
pub const APP_CLOUD_NAME: &str = "HiClow Cloud";
pub const APP_AI_ASSISTANT_DESC: &str = "HiClow 内置助手";
