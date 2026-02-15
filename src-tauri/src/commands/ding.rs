use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 贴图实例信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DingInfo {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub opacity: f64,
    pub passthrough: bool,
}

/// 贴图管理器状态
pub struct DingManager {
    pub instances: Mutex<HashMap<String, DingInfo>>,
}

impl DingManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
        }
    }
}

/// 创建贴图窗口
#[tauri::command]
pub async fn ding_create(
    image_base64: String,
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
    app: AppHandle,
) -> Result<String, String> {
    let id = format!("ding-{}", uuid::Uuid::new_v4());
    let w = width.unwrap_or(300.0);
    let h = height.unwrap_or(300.0);

    // 构建内联 HTML 展示图片
    let html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
<style>
  * {{ margin: 0; padding: 0; }}
  body {{
    overflow: hidden;
    background: transparent;
    user-select: none;
    -webkit-user-select: none;
  }}
  img {{
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: auto;
    cursor: move;
  }}
  .controls {{
    position: fixed;
    top: 4px;
    right: 4px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 10;
  }}
  body:hover .controls {{ opacity: 1; }}
  .btn {{
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.6);
    color: white;
  }}
  .btn:hover {{ background: rgba(0,0,0,0.8); }}
</style>
</head>
<body>
  <div class="controls">
    <button class="btn" onclick="window.__TAURI__?.core.invoke('ding_close', {{dingId: '{}'}})">✕</button>
  </div>
  <img src="data:image/png;base64,{}" draggable="false" />
</body>
</html>"#,
        id, image_base64
    );

    // 写入临时文件
    let temp_dir = app.path().temp_dir()
        .map_err(|e| format!("Get temp dir failed: {}", e))?;
    let html_path = temp_dir.join(format!("{}.html", id));
    std::fs::write(&html_path, html)
        .map_err(|e| format!("Write HTML failed: {}", e))?;

    // 创建透明无边框窗口
    let url = WebviewUrl::App(
        format!("../../../{}", html_path.display()).into()
    );

    let _window = WebviewWindowBuilder::new(&app, &id, url)
        .title("贴图")
        .inner_size(w, h)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .build()
        .map_err(|e| format!("Create ding window failed: {}", e))?;

    let info = DingInfo {
        id: id.clone(),
        x,
        y,
        width: w,
        height: h,
        opacity: 1.0,
        passthrough: false,
    };

    if let Some(mgr) = app.try_state::<DingManager>() {
        mgr.instances.lock().map_err(|e| format!("Lock poisoned: {}", e))?.insert(id.clone(), info);
    }

    Ok(id)
}

/// 关闭贴图窗口
#[tauri::command]
pub async fn ding_close(ding_id: String, app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&ding_id) {
        window.close().map_err(|e| format!("Close failed: {}", e))?;
    }
    if let Some(mgr) = app.try_state::<DingManager>() {
        mgr.instances.lock().map_err(|e| format!("Lock poisoned: {}", e))?.remove(&ding_id);
    }
    Ok(())
}

/// 设置贴图透明度
#[tauri::command]
pub async fn ding_set_opacity(
    ding_id: String,
    opacity: f64,
    app: AppHandle,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&ding_id) {
        // Tauri 2 doesn't have set_opacity directly; use JS injection
        let js = format!("document.body.style.opacity = '{}'", opacity);
        window.eval(&js).map_err(|e| format!("Eval failed: {}", e))?;
    }
    if let Some(mgr) = app.try_state::<DingManager>() {
        if let Some(info) = mgr.instances.lock().map_err(|e| format!("Lock poisoned: {}", e))?.get_mut(&ding_id) {
            info.opacity = opacity;
        }
    }
    Ok(())
}

/// 列出所有贴图
#[tauri::command]
pub async fn ding_list(app: AppHandle) -> Result<Vec<DingInfo>, String> {
    if let Some(mgr) = app.try_state::<DingManager>() {
        Ok(mgr.instances.lock().map_err(|e| format!("Lock poisoned: {}", e))?.values().cloned().collect())
    } else {
        Ok(vec![])
    }
}

/// 关闭所有贴图
#[tauri::command]
pub async fn ding_close_all(app: AppHandle) -> Result<(), String> {
    if let Some(mgr) = app.try_state::<DingManager>() {
        let ids: Vec<String> = mgr.instances.lock().map_err(|e| format!("Lock poisoned: {}", e))?.keys().cloned().collect();
        for id in ids {
            if let Some(window) = app.get_webview_window(&id) {
                let _ = window.close();
            }
        }
        mgr.instances.lock().map_err(|e| format!("Lock poisoned: {}", e))?.clear();
    }
    Ok(())
}
