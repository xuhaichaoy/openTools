use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, Position, Size,
    WebviewWindow,
};

const WINDOW_SCREEN_MARGIN: i32 = 24;
const WINDOW_TOP_OFFSET_RATIO: f64 = 0.08;
const MONITOR_SCALE_EPSILON: f64 = 0.01;
const MIN_MAIN_WINDOW_WIDTH_LOGICAL: f64 = 800.0;
const MIN_MAIN_WINDOW_HEIGHT_LOGICAL: f64 = 60.0;

fn fallback_monitor(window: &WebviewWindow) -> Option<Monitor> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn cursor_monitor(window: &WebviewWindow) -> Option<Monitor> {
    use cocoa::foundation::NSPoint;
    use objc::{class, msg_send, sel, sel_impl};

    let point: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
    window
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                let position = monitor.position().to_logical::<f64>(monitor.scale_factor());
                let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
                point.x >= position.x
                    && point.x < position.x + size.width
                    && point.y >= position.y
                    && point.y < position.y + size.height
            })
        })
        .or_else(|| fallback_monitor(window))
}

#[cfg(not(target_os = "macos"))]
fn cursor_monitor(window: &WebviewWindow) -> Option<Monitor> {
    let cursor = window.cursor_position().ok()?;
    window
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| fallback_monitor(window))
}

pub(crate) fn same_monitor(lhs: &Monitor, rhs: &Monitor) -> bool {
    lhs.position() == rhs.position()
        && lhs.size() == rhs.size()
        && lhs.work_area().position == rhs.work_area().position
        && lhs.work_area().size == rhs.work_area().size
        && (lhs.scale_factor() - rhs.scale_factor()).abs() < MONITOR_SCALE_EPSILON
}

fn current_outer_size(window: &WebviewWindow) -> Result<PhysicalSize<u32>, String> {
    window
        .outer_size()
        .or_else(|_| window.inner_size())
        .map_err(|e| e.to_string())
}

fn clamp_size_to_monitor(size: PhysicalSize<u32>, monitor: &Monitor) -> PhysicalSize<u32> {
    let work_area = monitor.work_area();
    let margin = (WINDOW_SCREEN_MARGIN * 2) as u32;
    let min_size = PhysicalSize::<u32>::from_logical::<(f64, f64), f64>(
        (
            MIN_MAIN_WINDOW_WIDTH_LOGICAL,
            MIN_MAIN_WINDOW_HEIGHT_LOGICAL,
        ),
        monitor.scale_factor(),
    );
    let max_width = work_area
        .size
        .width
        .saturating_sub(margin)
        .max(min_size.width);
    let max_height = work_area
        .size
        .height
        .saturating_sub(margin)
        .max(min_size.height);

    PhysicalSize::new(
        size.width.max(min_size.width).min(max_width),
        size.height.max(min_size.height).min(max_height),
    )
}

fn scale_size_for_monitor_change(
    size: PhysicalSize<u32>,
    source_monitor: Option<&Monitor>,
    target_monitor: &Monitor,
) -> PhysicalSize<u32> {
    let Some(source_monitor) = source_monitor else {
        return clamp_size_to_monitor(size, target_monitor);
    };

    let logical_size = size.to_logical::<f64>(source_monitor.scale_factor());
    let physical_size = logical_size.to_physical::<u32>(target_monitor.scale_factor());
    clamp_size_to_monitor(physical_size, target_monitor)
}

fn top_center_position(monitor: &Monitor, size: PhysicalSize<u32>) -> PhysicalPosition<i32> {
    let work_area = monitor.work_area();
    let centered_x =
        work_area.position.x + ((work_area.size.width as i32 - size.width as i32) / 2).max(0);
    let centered_y =
        work_area.position.y + ((work_area.size.height as i32 - size.height as i32) / 2).max(0);
    let upward_offset = (work_area.size.height as f64 * WINDOW_TOP_OFFSET_RATIO).round() as i32;
    let min_y = work_area.position.y + WINDOW_SCREEN_MARGIN;
    let max_y = work_area.position.y + work_area.size.height as i32
        - size.height as i32
        - WINDOW_SCREEN_MARGIN;
    let y = if max_y >= min_y {
        (centered_y - upward_offset).clamp(min_y, max_y)
    } else {
        min_y
    };

    PhysicalPosition::new(centered_x, y)
}

fn clamp_position_to_monitor(
    monitor: &Monitor,
    size: PhysicalSize<u32>,
    desired: PhysicalPosition<i32>,
) -> PhysicalPosition<i32> {
    let work_area = monitor.work_area();
    let min_x = work_area.position.x + WINDOW_SCREEN_MARGIN;
    let min_y = work_area.position.y + WINDOW_SCREEN_MARGIN;
    let max_x = work_area.position.x + work_area.size.width as i32
        - size.width as i32
        - WINDOW_SCREEN_MARGIN;
    let max_y = work_area.position.y + work_area.size.height as i32
        - size.height as i32
        - WINDOW_SCREEN_MARGIN;

    let x = if max_x >= min_x {
        desired.x.clamp(min_x, max_x)
    } else {
        min_x
    };
    let y = if max_y >= min_y {
        desired.y.clamp(min_y, max_y)
    } else {
        min_y
    };

    PhysicalPosition::new(x, y)
}

pub(crate) fn fit_window_to_monitor(
    window: &WebviewWindow,
    monitor: &Monitor,
    source_monitor: Option<&Monitor>,
    preserve_position: bool,
) -> Result<(), String> {
    let current_size = current_outer_size(window)?;
    let fitted_size = scale_size_for_monitor_change(current_size, source_monitor, monitor);
    if fitted_size != current_size {
        window
            .set_size(Size::Physical(fitted_size))
            .map_err(|e| e.to_string())?;
    }

    let fallback_position = top_center_position(monitor, fitted_size);
    let desired_position = if preserve_position {
        window.outer_position().unwrap_or(fallback_position)
    } else {
        fallback_position
    };
    let fitted_position = clamp_position_to_monitor(monitor, fitted_size, desired_position);

    window
        .set_position(Position::Physical(fitted_position))
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) fn fit_window_to_current_monitor(
    window: &WebviewWindow,
    preserve_position: bool,
) -> Result<(), String> {
    let monitor = fallback_monitor(window).ok_or_else(|| "无法获取当前显示器".to_string())?;
    fit_window_to_monitor(window, &monitor, None, preserve_position)
}

pub(crate) fn prepare_main_window_for_show(window: &WebviewWindow) -> Result<(), String> {
    let target_monitor =
        cursor_monitor(window).ok_or_else(|| "无法定位鼠标所在显示器".to_string())?;
    let current_monitor = window.current_monitor().ok().flatten();
    let preserve_position = current_monitor
        .as_ref()
        .map(|monitor| same_monitor(monitor, &target_monitor))
        .unwrap_or(false);

    fit_window_to_monitor(
        window,
        &target_monitor,
        current_monitor.as_ref(),
        preserve_position,
    )
}

/// 切换主窗口显隐
#[tauri::command]
pub async fn toggle_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            let _ = prepare_main_window_for_show(&window);
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
        let logical_width = size.to_logical::<f64>(scale).width;
        window
            .set_size(Size::Logical(LogicalSize::new(
                logical_width.max(1.0),
                height.max(1.0),
            )))
            .map_err(|e| e.to_string())?;
        fit_window_to_current_monitor(&window, true)?;
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
        let _ = prepare_main_window_for_show(&window);
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
