use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

// ── 类型定义 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
pub struct PluginCommand {
    #[serde(rename = "type", default)]
    pub cmd_type: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(rename = "match", default)]
    pub match_pattern: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginFeature {
    pub code: String,
    #[serde(default)]
    pub explain: String,
    #[serde(default)]
    pub cmds: Vec<serde_json::Value>, // 可以是 string 或 PluginCommand 对象
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub platform: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(alias = "name")]
    pub plugin_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub logo: Option<String>,
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default)]
    pub preload: Option<String>,
    #[serde(default)]
    pub features: Vec<PluginFeature>,
    #[serde(default)]
    pub plugin_type: Option<String>,
    #[serde(default)]
    pub development: Option<serde_json::Value>,
}

fn default_version() -> String {
    "0.0.0".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginInfo {
    pub id: String,
    pub manifest: PluginManifest,
    pub dir_path: String,
    pub enabled: bool,
    pub is_builtin: bool,
}

// ── 插件扫描 ──

fn get_plugins_dir(app: &AppHandle) -> PathBuf {
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let plugins_dir = resource_dir.join("plugins");
    if plugins_dir.exists() {
        return plugins_dir;
    }
    std::env::current_dir().unwrap_or_default().join("plugins")
}

fn scan_plugin_dir(dir: &PathBuf) -> Option<(PluginManifest, String)> {
    // 优先检查 plugin.json (uTools 格式)
    let plugin_json = dir.join("plugin.json");
    if plugin_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&plugin_json) {
            if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                return Some((manifest, "plugin.json".to_string()));
            }
        }
    }

    // 再检查 package.json (Rubick 格式)
    let package_json = dir.join("package.json");
    if package_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&package_json) {
            if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                // 只有有 features 字段的才认为是插件
                if !manifest.features.is_empty() {
                    return Some((manifest, "package.json".to_string()));
                }
            }
        }
    }

    None
}

fn scan_all_plugins(app: &AppHandle) -> Vec<PluginInfo> {
    let plugins_dir = get_plugins_dir(app);
    let mut plugins = Vec::new();

    if !plugins_dir.exists() {
        return plugins;
    }

    if let Ok(entries) = std::fs::read_dir(&plugins_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            if let Some((manifest, _)) = scan_plugin_dir(&path) {
                let id = manifest
                    .plugin_name
                    .to_lowercase()
                    .replace(' ', "-")
                    .replace(['/', '\\', '.'], "");

                let is_builtin = path
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with("builtin-"))
                    .unwrap_or(false);

                plugins.push(PluginInfo {
                    id,
                    manifest,
                    dir_path: path.to_string_lossy().to_string(),
                    enabled: true,
                    is_builtin,
                });
            }
        }
    }

    plugins
}

// ── Tauri Commands ──

/// 获取所有已安装的插件
#[tauri::command]
pub async fn plugin_list(app: AppHandle) -> Result<Vec<PluginInfo>, String> {
    Ok(scan_all_plugins(&app))
}

/// 在新窗口中打开插件
#[tauri::command]
pub async fn plugin_open(
    app: AppHandle,
    plugin_id: String,
    feature_code: String,
) -> Result<(), String> {
    let plugins = scan_all_plugins(&app);
    let plugin = plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("插件 {} 不存在", plugin_id))?;

    let feature = plugin
        .manifest
        .features
        .iter()
        .find(|f| f.code == feature_code)
        .ok_or_else(|| format!("功能 {} 不存在", feature_code))?;

    let window_label = format!("plugin-{}-{}", plugin_id, feature_code);

    // 如果窗口已存在，直接显示
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    // 确定入口 URL
    let url = if let Some(dev) = &plugin.manifest.development {
        if let Some(main_url) = dev.get("main").and_then(|v| v.as_str()) {
            WebviewUrl::External(main_url.parse().map_err(|e| format!("无效 URL: {}", e))?)
        } else {
            get_plugin_url(plugin)?
        }
    } else {
        get_plugin_url(plugin)?
    };

    let title = format!(
        "{} - {}",
        plugin.manifest.plugin_name, feature.explain
    );

    // 创建插件窗口
    WebviewWindowBuilder::new(&app, &window_label, url)
        .title(&title)
        .inner_size(800.0, 600.0)
        .center()
        .build()
        .map_err(|e| format!("创建窗口失败: {}", e))?;

    Ok(())
}

/// 关闭插件窗口
#[tauri::command]
pub async fn plugin_close(app: AppHandle, plugin_id: String, feature_code: String) -> Result<(), String> {
    let window_label = format!("plugin-{}-{}", plugin_id, feature_code);
    if let Some(window) = app.get_webview_window(&window_label) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 处理插件内 utools API 调用
#[tauri::command]
pub async fn plugin_api_call(
    app: AppHandle,
    plugin_id: String,
    method: String,
    args: String,
    _call_id: u64,
) -> Result<String, String> {
    let args: serde_json::Value = serde_json::from_str(&args).unwrap_or(serde_json::Value::Null);

    match method.as_str() {
        "hideMainWindow" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            Ok("null".to_string())
        }
        "showMainWindow" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            Ok("null".to_string())
        }
        "setExpendHeight" => {
            let height = args.get("height").and_then(|v| v.as_f64()).unwrap_or(600.0);
            // 找到对应插件窗口并调整高度
            for (label, window) in app.webview_windows() {
                if label.starts_with(&format!("plugin-{}", plugin_id)) {
                    let size = window.inner_size().map_err(|e| e.to_string())?;
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: size.width,
                        height: height as u32,
                    }));
                    break;
                }
            }
            Ok("null".to_string())
        }
        "copyText" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            use tauri_plugin_clipboard_manager::ClipboardExt;
            app.clipboard().write_text(text).map_err(|e| e.to_string())?;
            Ok("true".to_string())
        }
        "showNotification" => {
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title("51ToolBox")
                .body(body)
                .show()
                .map_err(|e| e.to_string())?;
            Ok("null".to_string())
        }
        "shellOpenExternal" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let _ = open::that(url);
            Ok("null".to_string())
        }
        "dbStorage.setItem" => {
            use tauri_plugin_store::StoreExt;
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = args.get("value").cloned().unwrap_or(serde_json::Value::Null);
            let store_name = format!("plugin-{}.json", plugin_id);
            let store = app.store(&store_name).map_err(|e| e.to_string())?;
            store.set(key, value);
            Ok("null".to_string())
        }
        "dbStorage.getItem" => {
            use tauri_plugin_store::StoreExt;
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let store_name = format!("plugin-{}.json", plugin_id);
            let store = app.store(&store_name).map_err(|e| e.to_string())?;
            let value = store.get(key).unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string(&value).unwrap_or("null".to_string()))
        }
        "dbStorage.removeItem" => {
            use tauri_plugin_store::StoreExt;
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let store_name = format!("plugin-{}.json", plugin_id);
            let store = app.store(&store_name).map_err(|e| e.to_string())?;
            let _ = store.delete(key);
            Ok("null".to_string())
        }
        "outPlugin" => {
            // 关闭插件窗口
            for (label, window) in app.webview_windows() {
                if label.starts_with(&format!("plugin-{}", plugin_id)) {
                    let _ = window.close();
                }
            }
            Ok("null".to_string())
        }
        _ => {
            log::warn!("插件 {} 调用了未实现的 API: {}", plugin_id, method);
            Err(format!("API 未实现: {}", method))
        }
    }
}

// ── 工具函数 ──

fn get_plugin_url(plugin: &PluginInfo) -> Result<WebviewUrl, String> {
    if let Some(main) = &plugin.manifest.main {
        let main_path = PathBuf::from(&plugin.dir_path).join(main);
        if main_path.exists() {
            let url_str = format!("file://{}", main_path.to_string_lossy());
            return Ok(WebviewUrl::External(
                url_str.parse().map_err(|e| format!("无效路径: {}", e))?,
            ));
        }
        return Err(format!("插件入口文件不存在: {}", main_path.display()));
    }
    Err("插件缺少 main 入口".to_string())
}
