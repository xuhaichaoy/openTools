use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

static IS_DRAGGING: AtomicBool = AtomicBool::new(false);

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

/// 开始拖拽窗口（nchao 方式：记录初始位置，轮询鼠标移动）
#[tauri::command]
pub async fn start_drag(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("找不到主窗口")?;

    // 获取窗口当前位置
    let win_pos = window.outer_position().map_err(|e| e.to_string())?;
    // 获取鼠标当前位置
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;

    let win_x = win_pos.x;
    let win_y = win_pos.y;
    let mouse_x = cursor.x as i32;
    let mouse_y = cursor.y as i32;

    IS_DRAGGING.store(true, Ordering::SeqCst);

    let win = window.clone();
    std::thread::spawn(move || {
        while IS_DRAGGING.load(Ordering::SeqCst) {
            if let Ok(cur) = win.cursor_position() {
                let dx = cur.x as i32 - mouse_x;
                let dy = cur.y as i32 - mouse_y;
                let new_x = win_x + dx;
                let new_y = win_y + dy;
                let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                    x: new_x,
                    y: new_y,
                }));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });

    Ok(())
}

/// 停止拖拽窗口
#[tauri::command]
pub async fn stop_drag() -> Result<(), String> {
    IS_DRAGGING.store(false, Ordering::SeqCst);
    Ok(())
}
