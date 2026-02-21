//! 插件 API 桥接 — plugin_api_call / 嵌入 HTML / utools shim 生成

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use self::api_methods::dispatch_plugin_api_call;
use self::html_bridge::{generate_plugin_enter_script, generate_utools_shim, inject_base_tag};
use super::lifecycle::{get_cached_plugins, push_dev_trace};
use super::types::{PluginDevTraceItem, PluginInfo};

mod api_methods;
mod dev_tools;
mod html_bridge;

static NEXT_PLUGIN_CALL_ID: AtomicU64 = AtomicU64::new(1);

fn next_plugin_call_id() -> u64 {
    NEXT_PLUGIN_CALL_ID.fetch_add(1, Ordering::Relaxed)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn find_plugin<'a>(plugins: &'a [PluginInfo], plugin_id: &str) -> Option<&'a PluginInfo> {
    plugins.iter().find(|p| p.id == plugin_id)
}

fn required_permission(method: &str) -> Option<&'static str> {
    match method {
        "copyText" | "copyImage" => Some("clipboard"),
        "showNotification" => Some("notification"),
        "shellOpenExternal" | "shellOpenPath" | "shellShowItemInFolder" => Some("shell"),
        "getPath" => Some("filesystem"),
        "screenCapture" => Some("system"),
        _ => None,
    }
}

fn evaluate_permission(plugin: &PluginInfo, method: &str) -> (bool, String, Option<String>) {
    if plugin.is_builtin {
        return (true, "allow".to_string(), None);
    }

    let required = match required_permission(method) {
        Some(p) => p,
        None => return (true, "allow".to_string(), None),
    };
    let declared = plugin
        .manifest
        .mtools
        .as_ref()
        .map(|m| &m.permissions)
        .cloned()
        .unwrap_or_default();

    if declared.iter().any(|p| p == required) {
        return (true, "allow".to_string(), None);
    }

    let reason = format!("缺少权限 `{}`，无法调用 `{}`", required, method);
    (false, "deny".to_string(), Some(reason))
}

fn record_trace(
    app: &AppHandle,
    plugin_id: String,
    method: String,
    call_id: u64,
    started: Instant,
    result: &Result<String, String>,
    permission_decision: String,
    permission_reason: Option<String>,
) {
    let duration_ms = started.elapsed().as_millis();
    let (success, error) = match result {
        Ok(_) => (true, None),
        Err(e) => (false, Some(e.clone())),
    };
    push_dev_trace(
        app,
        PluginDevTraceItem {
            plugin_id,
            method,
            call_id,
            duration_ms,
            success,
            error,
            permission_decision,
            permission_reason,
            created_at: now_rfc3339(),
        },
    );
}

// ── 插件窗口管理 ──

#[tauri::command]
pub async fn plugin_open(
    app: AppHandle,
    plugin_id: String,
    feature_code: String,
) -> Result<(), String> {
    let plugins = get_cached_plugins(&app);
    let plugin = plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("插件 {} 不存在", plugin_id))?;

    if !plugin.enabled {
        return Err(format!("插件 {} 已被禁用", plugin_id));
    }

    let feature = plugin
        .manifest
        .features
        .iter()
        .find(|f| f.code == feature_code)
        .ok_or_else(|| format!("功能 {} 不存在", feature_code))?;

    let window_label = format!("plugin-{}-{}", plugin_id, feature_code);

    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let title = format!("{} - {}", plugin.manifest.plugin_name, feature.explain);
    let shim_script = generate_utools_shim(&plugin_id);

    // 开发模式
    if let Some(dev) = &plugin.manifest.development {
        if let Some(main_url) = dev.get("main").and_then(|v| v.as_str()) {
            let url =
                WebviewUrl::External(main_url.parse().map_err(|e| format!("无效 URL: {}", e))?);
            let enter_script = generate_plugin_enter_script(&feature_code, "text", None);
            WebviewWindowBuilder::new(&app, &window_label, url)
                .title(&title)
                .inner_size(800.0, 600.0)
                .center()
                .initialization_script(&shim_script)
                .initialization_script(&enter_script)
                .build()
                .map_err(|e| format!("创建窗口失败: {}", e))?;
            return Ok(());
        }
    }

    let main_file = plugin
        .manifest
        .main
        .as_deref()
        .ok_or("插件缺少 main 入口")?;
    let main_path = PathBuf::from(&plugin.dir_path).join(main_file);
    if !main_path.exists() {
        return Err(format!("插件入口文件不存在: {}", main_path.display()));
    }
    let html_content =
        std::fs::read_to_string(&main_path).map_err(|e| format!("读取插件文件失败: {}", e))?;

    let base_url = format!(
        "mtplugin://localhost{}/",
        plugin.dir_path.replace('\\', "/")
    );
    let html_with_base = inject_base_tag(&html_content, &base_url);

    let json_html = serde_json::to_string(&html_with_base).map_err(|e| e.to_string())?;

    let inject_script = format!(
        r#"(function(){{
if(window.__mtools_injected)return;
window.__mtools_injected=true;
var __h={json_html};
function __replace(){{
  document.open();document.write(__h);document.close();
  setTimeout(function(){{if(window.__utoolsOnEnterCallback)window.__utoolsOnEnterCallback({{code:'{code}',type:'text',payload:undefined}});}},200);
}}
function __run(){{
  if(document.readyState==='loading'){{
    document.addEventListener('DOMContentLoaded',function(){{ setTimeout(__replace,0); }},{{once:true}});
  }}else{{
    setTimeout(__replace,0);
  }}
}}
setTimeout(__run,0);
}})();"#,
        json_html = json_html,
        code = feature_code,
    );

    let window = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::App(PathBuf::from("index.html")),
    )
    .title(&title)
    .inner_size(800.0, 600.0)
    .center()
    .initialization_script(&shim_script)
    .initialization_script(&inject_script)
    .build()
    .map_err(|e| format!("创建窗口失败: {}", e))?;

    if let Some(preload) = &plugin.manifest.preload {
        let preload_path = PathBuf::from(&plugin.dir_path).join(preload);
        if preload_path.exists() {
            if let Ok(preload_content) = std::fs::read_to_string(&preload_path) {
                let w = window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    let _ = w.eval(&preload_content);
                });
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn plugin_close(
    app: AppHandle,
    plugin_id: String,
    feature_code: String,
) -> Result<(), String> {
    let window_label = format!("plugin-{}-{}", plugin_id, feature_code);
    if let Some(window) = app.get_webview_window(&window_label) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_action_callback(
    app: AppHandle,
    plugin_id: String,
    request_id: String,
    result: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    app.emit(
        "plugin-mtools-action-result",
        serde_json::json!({
            "pluginId": plugin_id,
            "requestId": request_id,
            "result": result,
            "error": error,
        }),
    )
    .map_err(|e| e.to_string())
}

// ── plugin_api_call ──

#[tauri::command]
pub async fn plugin_api_call(
    app: AppHandle,
    plugin_id: String,
    method: String,
    args: String,
    call_id: Option<u64>,
) -> Result<String, String> {
    let call_id = call_id.unwrap_or_else(next_plugin_call_id);
    let started = Instant::now();
    let args: serde_json::Value = match serde_json::from_str(&args) {
        Ok(v) => v,
        Err(e) => {
            let result = Err(format!("无效参数 JSON: {}", e));
            record_trace(
                &app,
                plugin_id,
                method,
                call_id,
                started,
                &result,
                "deny".to_string(),
                Some("参数解析失败".to_string()),
            );
            return result;
        }
    };

    let plugins = get_cached_plugins(&app);
    let plugin = match find_plugin(&plugins, &plugin_id) {
        Some(p) => p,
        None => {
            let result = Err(format!("插件 {} 不存在", plugin_id));
            record_trace(
                &app,
                plugin_id,
                method,
                call_id,
                started,
                &result,
                "deny".to_string(),
                Some("插件不存在".to_string()),
            );
            return result;
        }
    };

    if !plugin.enabled {
        let result = Err(format!("插件 {} 已被禁用", plugin_id));
        record_trace(
            &app,
            plugin_id,
            method,
            call_id,
            started,
            &result,
            "deny".to_string(),
            Some("插件已禁用".to_string()),
        );
        return result;
    }

    let (permission_allowed, permission_decision, permission_reason) =
        evaluate_permission(plugin, &method);
    if !permission_allowed {
        let reason = permission_reason
            .clone()
            .unwrap_or_else(|| "权限校验未通过".to_string());
        let result = Err(format!("PLUGIN_PERMISSION_DENIED: {}", reason));
        record_trace(
            &app,
            plugin_id,
            method,
            call_id,
            started,
            &result,
            permission_decision,
            permission_reason,
        );
        return result;
    }

    let result = dispatch_plugin_api_call(&app, &plugin_id, &method, &args).await;

    record_trace(
        &app,
        plugin_id,
        method,
        call_id,
        started,
        &result,
        permission_decision,
        permission_reason,
    );
    result
}

// ── iframe 嵌入 HTML ──

#[tauri::command]
pub async fn plugin_get_embed_html(
    app: AppHandle,
    plugin_id: String,
    feature_code: String,
    bridge_token: String,
) -> Result<String, String> {
    dev_tools::plugin_get_embed_html(app, plugin_id, feature_code, bridge_token).await
}

#[tauri::command]
pub async fn plugin_dev_simulate_event(
    app: AppHandle,
    plugin_id: String,
    feature_code: String,
    event_type: String,
    payload_json: String,
) -> Result<(), String> {
    dev_tools::plugin_dev_simulate_event(app, plugin_id, feature_code, event_type, payload_json)
        .await
}

#[tauri::command]
pub async fn plugin_dev_open_devtools(
    app: AppHandle,
    window_label_or_embed_target: String,
) -> Result<(), String> {
    dev_tools::plugin_dev_open_devtools(app, window_label_or_embed_target).await
}

#[tauri::command]
pub async fn plugin_dev_storage_dump(
    app: AppHandle,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    dev_tools::plugin_dev_storage_dump(app, plugin_id).await
}

#[tauri::command]
pub async fn plugin_dev_storage_clear(app: AppHandle, plugin_id: String) -> Result<(), String> {
    dev_tools::plugin_dev_storage_clear(app, plugin_id).await
}
