use tauri::{AppHandle, Emitter, Listener, Manager};

use super::super::lifecycle::get_cached_plugins;

pub(super) async fn dispatch_plugin_api_call(
    app: &AppHandle,
    plugin_id: &str,
    method: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    match method {
        "hideMainWindow" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            Ok("null".to_string())
        }
        "showMainWindow" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = crate::commands::window::prepare_main_window_for_show(&w);
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
                    let logical_width = size.to_logical::<f64>(scale).width;
                    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                        logical_width.max(1.0),
                        height.max(1.0),
                    )));
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
                .title(crate::branding::APP_NAME)
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
            let _ = (app, plugin_id);
            log::warn!("插件调用了已移除的 screenCapture 能力，已按空结果兼容返回");
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
            let plugins = get_cached_plugins(app);
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
        "mtools_action" => handle_mtools_action(app, plugin_id, args).await,
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
    }
}

async fn handle_mtools_action(
    app: &AppHandle,
    plugin_id: &str,
    args: &serde_json::Value,
) -> Result<String, String> {
    let action_name = args
        .get("actionName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if action_name.is_empty() {
        return Err("mtools_action 缺少 actionName".to_string());
    }

    let params_value = args
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
    let params_json = serde_json::to_string(&params_value).unwrap_or_else(|_| "{}".to_string());

    if let Some(window) = app
        .webview_windows()
        .into_iter()
        .find(|(label, _)| label.starts_with(&format!("plugin-{}-", plugin_id)))
        .map(|(_, window)| window)
    {
        let request_id = format!("pa-{}", uuid::Uuid::new_v4());
        let request_id_for_listener = request_id.clone();
        let plugin_id_for_listener = plugin_id.to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
        let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let tx_clone = tx.clone();

        let listener_id = app.listen("plugin-mtools-action-result", move |event| {
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                let matches_request = payload.get("requestId").and_then(|v| v.as_str())
                    == Some(request_id_for_listener.as_str());
                let matches_plugin = payload.get("pluginId").and_then(|v| v.as_str())
                    == Some(plugin_id_for_listener.as_str());
                if !matches_request || !matches_plugin {
                    return;
                }
                let parsed = if let Some(err) = payload.get("error").and_then(|v| v.as_str()) {
                    Err(err.to_string())
                } else {
                    Ok(payload
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("null")
                        .to_string())
                };
                if let Ok(mut guard) = tx_clone.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(parsed);
                    }
                }
            }
        });

        let request_id_literal = serde_json::to_string(&request_id).unwrap_or("\"\"".to_string());
        let action_name_literal = serde_json::to_string(&action_name).unwrap_or("\"\"".to_string());
        let params_json_literal =
            serde_json::to_string(&params_json).unwrap_or("\"{}\"".to_string());

        let script = format!(
            r#"(function() {{
  try {{
    if (typeof window.__mtoolsHostInvokeAction !== 'function') {{
      throw new Error('插件未注册 mtools action 处理器');
    }}
    window.__mtoolsHostInvokeAction({request_id}, {action_name}, {params_json});
  }} catch (err) {{
    var msg = (err && err.message) ? err.message : String(err);
    if (typeof window.__mtoolsActionCallback === 'function') {{
      window.__mtoolsActionCallback({request_id}, null, msg);
    }}
  }}
}})();"#,
            request_id = request_id_literal,
            action_name = action_name_literal,
            params_json = params_json_literal,
        );

        if let Err(e) = window.eval(&script) {
            app.unlisten(listener_id);
            Err(format!("触发 mtools_action 失败: {}", e))
        } else {
            let wait_result =
                match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
                    Ok(Ok(result)) => result,
                    Ok(Err(_)) => Err("插件动作结果通道关闭".to_string()),
                    Err(_) => Err("插件动作执行超时（30s）".to_string()),
                };
            app.unlisten(listener_id);
            wait_result
        }
    } else {
        Err(format!(
            "插件 {} 尚未打开，无法执行 action `{}`",
            plugin_id, action_name
        ))
    }
}
