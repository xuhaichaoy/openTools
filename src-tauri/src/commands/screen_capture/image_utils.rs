use serde::Serialize;
use std::process::Command;

// ===== 窗口级截图（note-gen 方案） =====

#[derive(Serialize, Clone)]
pub struct WindowCapture {
    pub name: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

fn normalized_filename(s: &str) -> String {
    s.replace(' ', "-")
        .replace('/', "-")
        .replace('\\', "-")
        .replace('*', "-")
        .replace('?', "-")
        .replace(':', "-")
        .replace('<', "-")
        .replace('>', "-")
        .replace('|', "-")
}

/// 截取所有可见窗口（参考 note-gen screenshot.rs）
#[tauri::command]
pub fn capture_all_windows() -> Result<Vec<WindowCapture>, String> {
    let windows = xcap::Window::all().map_err(|e| format!("获取窗口列表失败: {e}"))?;

    // 临时目录
    let temp_dir = std::env::temp_dir().join("51toolbox-window-captures");
    if temp_dir.exists() {
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时目录失败: {e}"))?;

    let system_titles = [
        "Dock",
        "Menu Bar",
        "MenuBar",
        "Status",
        "Notification Center",
        "",
        "Desktop",
        "mTools",
        "截图",
    ];

    let mut captures: Vec<WindowCapture> = Vec::new();

    for (i, window) in windows.iter().enumerate() {
        // 跳过最小化窗口
        if window.is_minimized().unwrap_or(true) {
            continue;
        }

        let title = window.title().unwrap_or_default();
        let width = window.width().unwrap_or(0);
        let height = window.height().unwrap_or(0);

        // 跳过系统窗口、无标题窗口、过小窗口
        if system_titles.contains(&title.as_str()) || title.len() < 2 || width < 100 || height < 100
        {
            continue;
        }

        // 截取窗口
        let image = match window.capture_image() {
            Ok(img) => img,
            Err(_) => continue,
        };

        let path = temp_dir.join(format!("window-{}-{}.png", i, normalized_filename(&title)));
        if image.save(&path).is_err() {
            continue;
        }

        captures.push(WindowCapture {
            name: title,
            path: path.to_string_lossy().to_string(),
            width,
            height,
            x: window.x().unwrap_or(0),
            y: window.y().unwrap_or(0),
        });
    }

    Ok(captures)
}

/// 检查系统中是否有 ffmpeg
pub(super) fn which_ffmpeg() -> bool {
    if cfg!(windows) {
        Command::new("where")
            .arg("ffmpeg")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        Command::new("which")
            .arg("ffmpeg")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

// ===== Native Xcap Window Capture (Fixing helper stitching issues) =====

#[derive(Serialize)]
pub struct NativeWindowInfo {
    id: u32,
    title: String,
    app_name: String,
    width: u32,
    height: u32,
    thumbnail: Option<String>,
}

#[tauri::command]
pub async fn list_windows_xcap() -> Result<Vec<NativeWindowInfo>, String> {
    let windows = xcap::Window::all().map_err(|e| format!("获取窗口列表失败: {e}"))?;
    let mut results = Vec::new();

    for window in windows {
        // 尝试获取 id，xcap window可能有 id() 方法，若无则使用 pid 或其他特征
        // 在 xcap 0.8 中，Window可能有 id()。若编译失败稍后修复。
        // 这里假设 xcap::Window 有 id() 方法。如果报错，我们改用其他方式。
        let id = window.id().unwrap_or(0);
        let title = window.title().unwrap_or_default();
        let app_name = window.app_name().unwrap_or_default();
        let width = window.width().unwrap_or(0);
        let height = window.height().unwrap_or(0);

        // 过滤逻辑
        if window.is_minimized().unwrap_or(true) || width < 50 || height < 50 || title.is_empty() {
            continue;
        }

        // 生成缩略图 (可选，为了性能先不生成，或者只生成很小的)
        // 注意：capture_image 比较耗时，列出所有窗口时慎用。
        // 前端目前 logic 是 WindowInfo 需要 thumbnail。
        // 我们可以只生成一个占位符，或者异步生成。
        // 为了流畅度，这里暂时不返回缩略图，或者只返回应用图标（如果能获取）。
        // xcap 不直接提供图标。
        // 我们先返回 None，前端显示默认图标。

        results.push(NativeWindowInfo {
            id,
            title,
            app_name,
            width,
            height,
            thumbnail: None, // 暂不支持实时缩略图以提升列表加载速度
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn capture_window_xcap_by_id(window_id: u32) -> Result<String, String> {
    // 隐藏主窗口的逻辑在前端调用此命令前处理，或者这里不做处理（只负责截取）

    let windows = xcap::Window::all().map_err(|e| format!("获取窗口列表失败: {e}"))?;
    let window = windows
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == window_id)
        .ok_or_else(|| "未找到指定 ID 的窗口".to_string())?;

    let img = window
        .capture_image()
        .map_err(|e| format!("截图失败: {e}"))?;

    // 保存到临时文件
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = std::env::temp_dir().join(format!("xcap-win-{}.png", ts));
    img.save(&path).map_err(|e| format!("保存失败: {e}"))?;

    // 记录路径供 finish_capture 使用
    if let Ok(mut guard) = super::recording::CURRENT_SCREENSHOT_PATH.lock() {
        *guard = Some(path.to_string_lossy().to_string());
    }

    Ok(path.to_string_lossy().to_string())
}
