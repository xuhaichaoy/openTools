//! 插件 API 桥接 — plugin_api_call / 嵌入 HTML / utools shim 生成

use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::lifecycle::{get_cached_plugins, push_dev_trace};
use super::types::{PluginDevTraceItem, PluginInfo};

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

// ── plugin_api_call ──

#[tauri::command]
pub async fn plugin_api_call(
    app: AppHandle,
    plugin_id: String,
    method: String,
    args: String,
    call_id: u64,
) -> Result<String, String> {
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

    let result = match method.as_str() {
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
            for (label, window) in app.webview_windows() {
                if label.starts_with(&format!("plugin-{}", plugin_id)) {
                    let size = window.inner_size().map_err(|e| e.to_string())?;
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: size.width,
                        height: (height * scale) as u32,
                    }));
                    break;
                }
            }
            Ok("null".to_string())
        }
        "copyText" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            use tauri_plugin_clipboard_manager::ClipboardExt;
            app.clipboard()
                .write_text(text)
                .map_err(|e| e.to_string())?;
            Ok("true".to_string())
        }
        "showNotification" => {
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title("mTools")
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
        "shellOpenPath" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let _ = open::that(path);
            Ok("null".to_string())
        }
        "shellShowItemInFolder" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("open")
                    .arg("-R")
                    .arg(path)
                    .spawn();
            }
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("explorer")
                    .arg(format!("/select,{}", path))
                    .spawn();
            }
            #[cfg(target_os = "linux")]
            {
                let _ = std::process::Command::new("xdg-open")
                    .arg(
                        std::path::Path::new(path)
                            .parent()
                            .unwrap_or(std::path::Path::new("/")),
                    )
                    .spawn();
            }
            Ok("null".to_string())
        }
        "getPath" => {
            let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("home");
            let path = match name {
                "home" => dirs::home_dir(),
                "desktop" => dirs::desktop_dir(),
                "documents" | "document" => dirs::document_dir(),
                "downloads" | "download" => dirs::download_dir(),
                "pictures" | "picture" => dirs::picture_dir(),
                "music" => dirs::audio_dir(),
                "videos" | "video" => dirs::video_dir(),
                "temp" | "tmp" => Some(std::env::temp_dir()),
                _ => dirs::home_dir(),
            };
            match path {
                Some(p) => Ok(serde_json::to_string(&p.to_string_lossy().to_string())
                    .unwrap_or("null".to_string())),
                None => Err("获取路径失败".to_string()),
            }
        }
        "copyImage" => {
            let base64_data = args.get("base64").and_then(|v| v.as_str()).unwrap_or("");
            if base64_data.is_empty() {
                Err("base64 数据为空".to_string())
            } else {
                let pure_b64 = if let Some(pos) = base64_data.find(',') {
                    &base64_data[pos + 1..]
                } else {
                    base64_data
                };
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(pure_b64)
                    .map_err(|e| format!("base64 解码失败: {}", e))?;
                let tmp_dir = std::env::temp_dir();
                let tmp_path = tmp_dir.join(format!("mtools_copyimg_{}.png", std::process::id()));
                std::fs::write(&tmp_path, &bytes)
                    .map_err(|e| format!("写入临时图片失败: {}", e))?;
                let _ = app.emit(
                    "plugin-copy-image",
                    serde_json::json!({ "path": tmp_path.to_string_lossy() }),
                );
                Ok("true".to_string())
            }
        }
        "screenCapture" => {
            let _ = app.emit(
                "plugin-screen-capture",
                serde_json::json!({ "pluginId": plugin_id }),
            );
            Ok("null".to_string())
        }
        "setSubInput" => {
            let placeholder = args
                .get("placeholder")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let is_focus = args
                .get("isFocus")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let _ = app.emit(
                "plugin-set-sub-input",
                serde_json::json!({
                    "pluginId": plugin_id, "placeholder": placeholder, "isFocus": is_focus,
                }),
            );
            Ok("null".to_string())
        }
        "removeSubInput" => {
            let _ = app.emit(
                "plugin-remove-sub-input",
                serde_json::json!({ "pluginId": plugin_id }),
            );
            Ok("null".to_string())
        }
        "redirect" => {
            let label = args.get("label").and_then(|v| v.as_str()).unwrap_or("");
            let payload = args
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let _ = app.emit(
                "plugin-redirect",
                serde_json::json!({
                    "pluginId": plugin_id, "label": label, "payload": payload,
                }),
            );
            Ok("null".to_string())
        }
        "getFeatures" => {
            let plugins = get_cached_plugins(&app);
            if let Some(p) = plugins.iter().find(|p| p.id == plugin_id) {
                let features_json =
                    serde_json::to_string(&p.manifest.features).unwrap_or("[]".to_string());
                Ok(features_json)
            } else {
                Ok("[]".to_string())
            }
        }
        "dbStorage.setItem" => {
            use tauri_plugin_store::StoreExt;
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = args
                .get("value")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
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
            for (label, window) in app.webview_windows() {
                if label.starts_with(&format!("plugin-{}", plugin_id)) {
                    let _ = window.close();
                }
            }
            Ok("null".to_string())
        }
        _ => {
            log::warn!("插件 {} 调用了未实现的 API: {}", plugin_id, method);
            Err(format!("PLUGIN_API_NOT_IMPLEMENTED: {}", method))
        }
    };

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
    let plugins = get_cached_plugins(&app);
    let plugin = plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("插件 {} 不存在", plugin_id))?;
    if !plugin.enabled {
        return Err(format!("插件 {} 已被禁用", plugin_id));
    }
    let _feature = plugin
        .manifest
        .features
        .iter()
        .find(|f| f.code == feature_code)
        .ok_or_else(|| format!("功能 {} 不存在", feature_code))?;

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
    let bridge = generate_embed_bridge(&plugin_id, &bridge_token);
    let html_with_bridge = inject_embed_bridge(&html_with_base, &bridge);
    Ok(html_with_bridge)
}

#[tauri::command]
pub async fn plugin_dev_simulate_event(
    app: AppHandle,
    plugin_id: String,
    feature_code: String,
    event_type: String,
    payload_json: String,
) -> Result<(), String> {
    let payload: serde_json::Value = serde_json::from_str(&payload_json)
        .map_err(|e| format!("payload_json 不是有效 JSON: {}", e))?;

    let label = format!("plugin-{}-{}", plugin_id, feature_code);
    let payload_literal = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let script = match event_type.as_str() {
        "onPluginEnter" => format!(
            "(() => {{ const p = {payload}; if (window.__utoolsOnEnterCallback) window.__utoolsOnEnterCallback(p); }})();",
            payload = payload_literal
        ),
        "onPluginOut" => "(() => { if (window.__utoolsOnOutCallback) window.__utoolsOnOutCallback(); })();"
            .to_string(),
        "setSubInput" => format!(
            "(() => {{ const p = {payload}; const text = typeof p === 'string' ? p : (p && (p.text ?? p.value ?? '')) || ''; if (window.__utoolsSubInputCallback) window.__utoolsSubInputCallback(text); }})();",
            payload = payload_literal
        ),
        "redirect" => {
            let redirect_label = payload
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let redirect_payload = payload
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let _ = app.emit(
                "plugin-redirect",
                serde_json::json!({
                    "pluginId": plugin_id,
                    "label": redirect_label,
                    "payload": redirect_payload,
                }),
            );
            "void 0;".to_string()
        }
        "screenCapture" => format!(
            "(() => {{ const p = {payload}; if (window.__utoolsScreenCaptureCallback) window.__utoolsScreenCaptureCallback(p); }})();",
            payload = payload_literal
        ),
        _ => {
            return Err(format!(
                "不支持的事件类型: {} (支持: onPluginEnter/onPluginOut/setSubInput/redirect/screenCapture)",
                event_type
            ));
        }
    };

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.eval(&script);
    }

    let _ = app.emit(
        "plugin-dev:simulate-event",
        serde_json::json!({
            "pluginId": plugin_id,
            "featureCode": feature_code,
            "eventType": event_type,
            "payload": payload,
        }),
    );

    Ok(())
}

#[tauri::command]
pub async fn plugin_dev_open_devtools(
    app: AppHandle,
    window_label_or_embed_target: String,
) -> Result<(), String> {
    let label = if window_label_or_embed_target == "embed" {
        "main".to_string()
    } else {
        window_label_or_embed_target
    };

    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("窗口不存在: {}", label))?;
    window.open_devtools();
    Ok(())
}

#[tauri::command]
pub async fn plugin_dev_storage_dump(
    app: AppHandle,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_store::StoreExt;

    let store_name = format!("plugin-{}.json", plugin_id);
    let store = app.store(&store_name).map_err(|e| e.to_string())?;
    let entries = store.entries();
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    Ok(serde_json::Value::Object(map))
}

#[tauri::command]
pub async fn plugin_dev_storage_clear(app: AppHandle, plugin_id: String) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;

    let store_name = format!("plugin-{}.json", plugin_id);
    let store = app.store(&store_name).map_err(|e| e.to_string())?;
    store.clear();
    Ok(())
}

// ── HTML 工具函数 ──

pub(super) fn inject_base_tag(html: &str, base_url: &str) -> String {
    let base_tag = format!("<base href=\"{}\">", base_url);
    let lower = html.to_lowercase();
    if let Some(pos) = lower.find("<head>") {
        let insert_pos = pos + 6;
        format!("{}{}{}", &html[..insert_pos], base_tag, &html[insert_pos..])
    } else if let Some(pos) = lower.find("<html>") {
        let insert_pos = pos + 6;
        format!(
            "{}<head>{}</head>{}",
            &html[..insert_pos],
            base_tag,
            &html[insert_pos..]
        )
    } else {
        format!("<head>{}</head>{}", base_tag, html)
    }
}

fn inject_embed_bridge(html: &str, bridge_script: &str) -> String {
    let script_tag = format!("<script>{}</script>", bridge_script);
    let lower = html.to_lowercase();
    if let Some(pos) = lower.find("<head>") {
        let insert_pos = pos + 6;
        format!(
            "{}{}{}",
            &html[..insert_pos],
            script_tag,
            &html[insert_pos..]
        )
    } else if let Some(pos) = lower.find("<html>") {
        let insert_pos = pos + 6;
        format!(
            "{}<head>{}</head>{}",
            &html[..insert_pos],
            script_tag,
            &html[insert_pos..]
        )
    } else {
        format!("<head>{}</head>{}", script_tag, html)
    }
}

fn escape_js_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
}

// ── Shim 生成 ──

pub(super) fn generate_utools_shim(plugin_id: &str) -> String {
    format!(
        r#"
(function() {{
  'use strict';
  const coreInvoke = window.__TAURI__?.core?.invoke;
  if (coreInvoke) {{
      delete window.__TAURI__;
  }} else {{
      console.error('[mTools] Panic: Tauri API not found during shim initialization');
  }}

  const __pluginId = '{plugin_id}';
  let __callId = 0;

  function __invoke(method, args) {{
    return new Promise((resolve, reject) => {{
      if (!coreInvoke) {{
        console.warn('[mTools] Tauri IPC unavailable or stripped', method);
        reject(new Error('Tauri IPC not available'));
        return;
      }}
      const id = ++__callId;
      coreInvoke('plugin_api_call', {{
        pluginId: __pluginId,
        method: method,
        args: JSON.stringify(args || {{}}),
        callId: id,
      }}).then(result => {{
        resolve(JSON.parse(result || 'null'));
      }}).catch(err => {{
        reject(err);
      }});
    }});
  }}

  const utools = {{
    hideMainWindow() {{ __invoke('hideMainWindow'); }},
    showMainWindow() {{ __invoke('showMainWindow'); }},
    setExpendHeight(height) {{ __invoke('setExpendHeight', {{ height }}); }},
    setSubInput(onChange, placeholder, isFocus) {{
      window.__utoolsSubInputCallback = onChange;
      __invoke('setSubInput', {{ placeholder, isFocus }});
    }},
    removeSubInput() {{
      window.__utoolsSubInputCallback = null;
      __invoke('removeSubInput');
    }},
    copyText(text) {{ return __invoke('copyText', {{ text }}); }},
    copyImage(base64) {{ return __invoke('copyImage', {{ base64 }}); }},
    getCopyedFiles() {{ return []; }},
    dbStorage: {{
      setItem(key, value) {{ return __invoke('dbStorage.setItem', {{ key, value }}); }},
      getItem(key) {{ return __invoke('dbStorage.getItem', {{ key }}); }},
      removeItem(key) {{ return __invoke('dbStorage.removeItem', {{ key }}); }},
    }},
    getPath(name) {{ return __invoke('getPath', {{ name }}); }},
    showNotification(body, clickFeatureCode) {{ __invoke('showNotification', {{ body, clickFeatureCode }}); }},
    shellOpenExternal(url) {{ __invoke('shellOpenExternal', {{ url }}); }},
    shellOpenPath(path) {{ __invoke('shellOpenPath', {{ path }}); }},
    shellShowItemInFolder(path) {{ __invoke('shellShowItemInFolder', {{ path }}); }},
    screenCapture(callback) {{
      window.__utoolsScreenCaptureCallback = callback;
      __invoke('screenCapture');
    }},
    getFeatures() {{ return __invoke('getFeatures'); }},
    screenColorPick(callback) {{
      __invoke('plugin_start_color_picker').then(function(hex) {{
        callback && callback(hex || null);
      }}).catch(function(err) {{
        console.error('[mTools] 取色失败:', err);
        callback && callback(null);
      }});
    }},
    getUser() {{ return {{ avatar: '', nickname: '本地用户', type: 'member' }}; }},
    getAppVersion() {{ return '0.1.0'; }},
    isDarkColors() {{ return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }},
    isMacOS() {{ return navigator.platform.toLowerCase().includes('mac'); }},
    isWindows() {{ return navigator.platform.toLowerCase().includes('win'); }},
    isLinux() {{ return navigator.platform.toLowerCase().includes('linux'); }},
    onPluginReady(callback) {{ if (callback) setTimeout(callback, 0); }},
    onPluginEnter(callback) {{ window.__utoolsOnEnterCallback = callback; }},
    onPluginOut(callback) {{ window.__utoolsOnOutCallback = callback; }},
    redirect(label, payload) {{ __invoke('redirect', {{ label, payload }}); }},
    outPlugin() {{ __invoke('outPlugin'); }},
  }};

  window.utools = utools;
  window.rubick = utools;
  console.log('[mTools] utools API shim 已注入, pluginId:', __pluginId);
}})();
"#,
        plugin_id = plugin_id
    )
}

fn generate_embed_bridge(plugin_id: &str, bridge_token: &str) -> String {
    let plugin_id_esc = escape_js_string(plugin_id);
    let bridge_token_esc = escape_js_string(bridge_token);
    format!(
        r#"
(function(){{
  var __pluginId = '{plugin_id_esc}';
  var __bridgeToken = '{bridge_token_esc}';
  var __invokeId = 0;
  function __invoke(cmd, args) {{
    return new Promise(function(resolve, reject) {{
      var id = 'inv-' + (++__invokeId);
      var done = false;
      function onResp(e) {{
        if (e.data && e.data.type === 'mtools-embed-result' && e.data.id === id && e.data.token === __bridgeToken) {{
          done = true;
          window.removeEventListener('message', onResp);
          if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result);
        }}
      }}
      window.addEventListener('message', onResp);
      try {{
        window.parent.postMessage({{ type: 'mtools-embed-invoke', id: id, cmd: cmd, args: args || {{}}, pluginId: __pluginId, token: __bridgeToken }}, '*');
      }} catch (err) {{
        if (!done) {{ window.removeEventListener('message', onResp); reject(err); }}
      }}
      setTimeout(function() {{
        if (!done) {{ done = true; window.removeEventListener('message', onResp); reject(new Error('embed invoke timeout')); }}
      }}, 30000);
    }});
  }}
  window.__TAURI__ = {{
    core: {{ invoke: __invoke }},
    event: {{ listen: function(name, cb) {{ return __invoke('event-listen', {{ name: name }}).then(function() {{ return function() {{}}; }}); }} }}
  }};
  var __callId = 0;
  function __apiInvoke(method, args) {{
    return __invoke('plugin_api_call', {{ pluginId: __pluginId, method: method, args: JSON.stringify(args || {{}}), callId: ++__callId }}).then(function(r) {{ return JSON.parse(r || 'null'); }});
  }}
  window.utools = window.rubick = {{
    hideMainWindow: function() {{ return __apiInvoke('hideMainWindow'); }},
    showMainWindow: function() {{ return __apiInvoke('showMainWindow'); }},
    setExpendHeight: function(o) {{ return __apiInvoke('setExpendHeight', o); }},
    setSubInput: function(onChange, p, f) {{ window.__utoolsSubInputCallback = onChange; return __apiInvoke('setSubInput', {{ placeholder: p, isFocus: f }}); }},
    removeSubInput: function() {{ window.__utoolsSubInputCallback = null; return __apiInvoke('removeSubInput'); }},
    copyText: function(t) {{ return __apiInvoke('copyText', {{ text: t }}); }},
    copyImage: function(b) {{ return __apiInvoke('copyImage', {{ base64: b }}); }},
    getCopyedFiles: function() {{ return []; }},
    dbStorage: {{ setItem: function(k,v) {{ return __apiInvoke('dbStorage.setItem', {{ key: k, value: v }}); }}, getItem: function(k) {{ return __apiInvoke('dbStorage.getItem', {{ key: k }}); }}, removeItem: function(k) {{ return __apiInvoke('dbStorage.removeItem', {{ key: k }}); }} }},
    getPath: function(n) {{ return __apiInvoke('getPath', {{ name: n }}); }},
    showNotification: function(b,c) {{ return __apiInvoke('showNotification', {{ body: b, clickFeatureCode: c }}); }},
    shellOpenExternal: function(u) {{ return __apiInvoke('shellOpenExternal', {{ url: u }}); }},
    shellOpenPath: function(p) {{ return __apiInvoke('shellOpenPath', {{ path: p }}); }},
    shellShowItemInFolder: function(p) {{ return __apiInvoke('shellShowItemInFolder', {{ path: p }}); }},
    screenCapture: function(cb) {{ if (cb) cb(null); }},
    screenColorPick: function(cb) {{ __invoke('plugin_start_color_picker').then(function(hex) {{ if (cb) cb(hex || null); }}).catch(function() {{ if (cb) cb(null); }}); }},
    getUser: function() {{ return {{ avatar: '', nickname: '本地用户', type: 'member' }}; }},
    getAppVersion: function() {{ return '0.1.0'; }},
    isDarkColors: function() {{ return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }},
    isMacOS: function() {{ return /mac/i.test(navigator.platform); }},
    isWindows: function() {{ return /win/i.test(navigator.platform); }},
    isLinux: function() {{ return /linux/i.test(navigator.platform); }},
    onPluginReady: function(cb) {{ if (cb) setTimeout(cb, 0); }},
    onPluginEnter: function(cb) {{ window.__utoolsOnEnterCallback = cb; }},
    onPluginOut: function(cb) {{ window.__utoolsOnOutCallback = cb; }},
    redirect: function(l, p) {{ return __apiInvoke('redirect', {{ label: l, payload: p }}); }},
    outPlugin: function() {{ return __apiInvoke('outPlugin'); }}
  }};

  var __aiReqId = 0;
  window.mtools = {{
    ai: {{
      chat: function(opts) {{
        return new Promise(function(resolve, reject) {{
          var id = 'ai-' + (++__aiReqId);
          function onResp(e) {{
            if (e.data && e.data.type === 'mtools-ai-result' && e.data.id === id && e.data.token === __bridgeToken) {{
              window.removeEventListener('message', onResp);
              if (e.data.error) reject(new Error(e.data.error));
              else resolve({{ content: e.data.content }});
            }}
          }}
          window.addEventListener('message', onResp);
          window.parent.postMessage({{ type: 'mtools-ai-chat', id: id, messages: opts.messages, model: opts.model, temperature: opts.temperature, pluginId: __pluginId, token: __bridgeToken }}, '*');
        }});
      }},
      stream: function(opts) {{
        return new Promise(function(resolve, reject) {{
          var id = 'ai-' + (++__aiReqId);
          function onMsg(e) {{
            if (!e.data || e.data.id !== id || e.data.token !== __bridgeToken) return;
            if (e.data.type === 'mtools-ai-chunk' && opts.onChunk) opts.onChunk(e.data.chunk);
            if (e.data.type === 'mtools-ai-done') {{
              window.removeEventListener('message', onMsg);
              if (opts.onDone) opts.onDone(e.data.content);
              resolve();
            }}
            if (e.data.type === 'mtools-ai-error') {{
              window.removeEventListener('message', onMsg);
              reject(new Error(e.data.error));
            }}
          }}
          window.addEventListener('message', onMsg);
          window.parent.postMessage({{ type: 'mtools-ai-stream', id: id, messages: opts.messages, pluginId: __pluginId, token: __bridgeToken }}, '*');
        }});
      }},
      getModels: function() {{
        return __invoke('ai_list_models', {{}}).then(function(r) {{ return r || []; }}).catch(function() {{ return []; }});
      }}
    }}
  }};

  window.addEventListener('message', function(e) {{
    var d = e.data || {{}};
    if (d.type !== 'mtools-dev-simulate') return;
    if (d.pluginId !== __pluginId) return;
    var p = d.payload;
    switch (d.eventType) {{
      case 'onPluginEnter':
        if (window.__utoolsOnEnterCallback) window.__utoolsOnEnterCallback(p || {{ code: '', type: 'text', payload: null }});
        break;
      case 'onPluginOut':
        if (window.__utoolsOnOutCallback) window.__utoolsOnOutCallback();
        break;
      case 'setSubInput':
        var text = typeof p === 'string' ? p : (p && (p.text || p.value || '')) || '';
        if (window.__utoolsSubInputCallback) window.__utoolsSubInputCallback(text);
        break;
      case 'screenCapture':
        if (window.__utoolsScreenCaptureCallback) window.__utoolsScreenCaptureCallback(p || null);
        break;
      case 'redirect':
        // redirect 无内建回调，这里仅保留兼容入口
        break;
    }}
  }});
}})();
"#,
        plugin_id_esc = plugin_id_esc,
        bridge_token_esc = bridge_token_esc
    )
}

pub(super) fn generate_plugin_enter_script(
    code: &str,
    cmd_type: &str,
    payload: Option<&str>,
) -> String {
    let payload_js = match payload {
        Some(p) => format!("'{}'", p.replace('\'', "\\'")),
        None => "undefined".to_string(),
    };
    format!(
        r#"
(function() {{
  setTimeout(function() {{
    if (window.__utoolsOnEnterCallback) {{
      window.__utoolsOnEnterCallback({{
        code: '{code}',
        type: '{cmd_type}',
        payload: {payload_js},
      }});
    }}
  }}, 100);
}})();
"#,
        code = code,
        cmd_type = cmd_type,
        payload_js = payload_js
    )
}
