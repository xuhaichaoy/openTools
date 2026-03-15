use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

use super::super::lifecycle::get_cached_plugins;
use super::html_bridge::{generate_embed_bridge, inject_base_tag, inject_embed_bridge};

pub(super) async fn plugin_get_embed_html(
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
    let feature = plugin
        .manifest
        .features
        .iter()
        .find(|f| f.code == feature_code)
        .ok_or_else(|| format!("功能 {} 不存在", feature_code))?;
    if !super::feature_supported_on_current_platform(feature) {
        return Err(super::platform_not_supported_error(&feature_code));
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

    let base_url = crate::mtplugin::build_mtplugin_base_url(&plugin.dir_path);
    let html_with_base = inject_base_tag(&html_content, &base_url);
    let bridge = generate_embed_bridge(&plugin_id, &bridge_token);
    let html_with_bridge = inject_embed_bridge(&html_with_base, &bridge);
    Ok(html_with_bridge)
}

pub(super) async fn plugin_dev_simulate_event(
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
        _ => {
            return Err(format!(
                "不支持的事件类型: {} (支持: onPluginEnter/onPluginOut/setSubInput/redirect)",
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

pub(super) async fn plugin_dev_open_devtools(
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

pub(super) async fn plugin_dev_storage_dump(
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

pub(super) async fn plugin_dev_storage_clear(
    app: AppHandle,
    plugin_id: String,
) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;

    let store_name = format!("plugin-{}.json", plugin_id);
    let store = app.store(&store_name).map_err(|e| e.to_string())?;
    store.clear();
    Ok(())
}
