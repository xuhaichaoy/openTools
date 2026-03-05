use tauri::{AppHandle, Manager};

/// 切换主窗口显隐
#[tauri::command]
pub async fn toggle_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            // window.center().map_err(|e| e.to_string())?; // removed
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 调整窗口高度（插件 setExpendHeight 兼容）
#[tauri::command]
pub async fn resize_window(app: AppHandle, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().unwrap_or(1.0);
        let physical_height = (height * scale) as u32;
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: size.width,
                height: physical_height,
            }))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 隐藏窗口
#[tauri::command]
pub async fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 显示主窗口
#[tauri::command]
pub async fn show_window_cmd(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        // let _ = window.center(); // removed
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
    }
    Ok(())
}

/// 开始拖拽窗口（使用 Tauri 原生 API）
#[tauri::command]
pub async fn start_drag(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("找不到主窗口")?;
    window
        .start_dragging()
        .map_err(|e| format!("开始拖拽失败: {}", e))?;
    Ok(())
}

/// 停止拖拽窗口（原生拖拽不需要手动停止，但保留接口兼容前端）
#[tauri::command]
pub async fn stop_drag() -> Result<(), String> {
    // 原生拖拽由系统管理，无需手动处理
    Ok(())
}
