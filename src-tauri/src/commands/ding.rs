use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, LogicalSize, Manager, Size, WebviewUrl, WebviewWindowBuilder};
use url::Url;

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
<meta charset="utf-8" />
<style>
  * {{ margin: 0; padding: 0; }}
  html, body {{
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #111;
  }}
  body {{
    width: 100%;
    height: 100%;
    user-select: none;
    -webkit-user-select: none;
  }}
  img {{
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }}
</style>
</head>
<body>
  <img src="data:image/png;base64,{}" draggable="false" />
</body>
</html>"#,
        image_base64
    );

    // 写入临时文件
    let temp_dir = app.path().temp_dir()
        .map_err(|e| format!("Get temp dir failed: {}", e))?;
    let html_path = temp_dir.join(format!("{}.html", id));
    std::fs::write(&html_path, html)
        .map_err(|e| format!("Write HTML failed: {}", e))?;

    // 创建透明无边框窗口：使用 file:// URL，避免错误回落到主应用首页
    let file_url = Url::from_file_path(&html_path)
        .map_err(|_| format!("Invalid temp html path: {}", html_path.display()))?;
    let url = WebviewUrl::External(file_url);

    let _window = WebviewWindowBuilder::new(&app, &id, url)
        .title("贴图（可拖动/缩放）")
        .inner_size(w, h)
        .position(x, y)
        .decorations(true)
        .transparent(false)
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

/// 拖拽贴图窗口
#[tauri::command]
pub async fn ding_start_drag(ding_id: String, app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&ding_id) {
        window
            .start_dragging()
            .map_err(|e| format!("Start dragging failed: {}", e))?;
    }
    Ok(())
}

/// 等比缩放贴图窗口（由前端 resize handle 触发）
#[tauri::command]
pub async fn ding_resize(
    ding_id: String,
    width: f64,
    height: f64,
    app: AppHandle,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&ding_id) {
        window
            .set_size(Size::Logical(LogicalSize::new(width, height)))
            .map_err(|e| format!("Resize failed: {}", e))?;
    }
    if let Some(mgr) = app.try_state::<DingManager>() {
        if let Some(info) = mgr
            .instances
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?
            .get_mut(&ding_id)
        {
            info.width = width;
            info.height = height;
        }
    }
    Ok(())
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
