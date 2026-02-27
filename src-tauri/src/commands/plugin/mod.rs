//! 插件系统模块 — 类型、生命周期、API 桥、取色器

pub mod api_bridge;
pub mod lifecycle;
pub mod types;

// Re-export types for external use (e.g. managed state in lib.rs)
pub use types::{PluginCache, PluginDevState};

use tauri::{AppHandle, Manager};

// ── 屏幕取色 ──

#[tauri::command]
pub async fn plugin_get_pixel_at(x: i32, y: i32) -> Result<String, String> {
    get_pixel_at_screen(x, y)
}

#[cfg(target_os = "macos")]
fn get_pixel_at_screen(sx: i32, sy: i32) -> Result<String, String> {
    let path = std::env::temp_dir().join("mtools_pixel.png");
    let status = std::process::Command::new("screencapture")
        .args([
            "-x",
            "-R",
            &format!("{},{},1,1", sx, sy),
            &*path.to_string_lossy(),
        ])
        .status()
        .map_err(|e| format!("screencapture 失败: {}", e))?;
    if !status.success() {
        return Err("截取像素失败，请检查屏幕录制权限".to_string());
    }
    let buf = std::fs::read(&path).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&buf).map_err(|e| e.to_string())?;
    let rgb = img.to_rgb8();
    let p = rgb.get_pixel(0, 0);
    let (r, g, b) = (p[0], p[1], p[2]);
    let _ = std::fs::remove_file(&path);
    Ok(format!("#{:02X}{:02X}{:02X}", r, g, b))
}

#[cfg(target_os = "windows")]
fn get_pixel_at_screen(sx: i32, sy: i32) -> Result<String, String> {
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
    use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;
    unsafe {
        let hwnd = GetDesktopWindow();
        let hdc = GetDC(hwnd);
        if hdc.is_invalid() {
            return Err("GetDC 失败".to_string());
        }
        let color = GetPixel(hdc, sx, sy);
        let _ = ReleaseDC(hwnd, hdc);
        if color.0 == 0xFFFFFFFF {
            return Err("GetPixel 无效".to_string());
        }
        let r = (color.0 & 0xFF) as u8;
        let g = ((color.0 >> 8) & 0xFF) as u8;
        let b = ((color.0 >> 16) & 0xFF) as u8;
        Ok(format!("#{:02X}{:02X}{:02X}", r, g, b))
    }
}

#[cfg(target_os = "linux")]
fn get_pixel_at_screen(_x: i32, _y: i32) -> Result<String, String> {
    Err("Linux 暂不支持直接取色，请使用截图模式".to_string())
}

#[tauri::command]
pub async fn plugin_start_color_picker(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
        }

        let result = macos_native_color_pick().await;

        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
        }

        let hex = result?;
        if !hex.is_empty() {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let _ = app.clipboard().write_text(hex.clone());
        }
        return Ok(hex);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return Err("Windows 请使用 EyeDropper 取色".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return Err("Linux 暂不支持直接取色".to_string());
    }
}

#[cfg(target_os = "macos")]
async fn macos_native_color_pick() -> Result<String, String> {
    let cache_dir = std::env::temp_dir();
    let binary_path = cache_dir.join("mtools_color_sampler");
    let source_path = cache_dir.join("mtools_color_sampler.m");

    if !binary_path.exists() {
        let objc_code = include_str!("../picker_macos.m");
        std::fs::write(&source_path, objc_code).map_err(|e| format!("写入源文件失败: {}", e))?;

        let compile = tokio::process::Command::new("/usr/bin/clang")
            .args([
                "-framework",
                "Cocoa",
                "-o",
                &*binary_path.to_string_lossy(),
                &*source_path.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(|e| format!("clang 编译失败: {}", e))?;

        let _ = std::fs::remove_file(&source_path);

        if !compile.status.success() {
            let _ = std::fs::remove_file(&binary_path);
            let msg = format!(
                "编译取色程序失败: {}",
                String::from_utf8_lossy(&compile.stderr).trim()
            );
            log::error!("{}", msg);
            return Err(msg);
        }
    }

    let output = tokio::process::Command::new(&*binary_path.to_string_lossy())
        .output()
        .await
        .map_err(|e| {
            let msg = format!("启动取色器失败: {}", e);
            log::error!("{}", msg);
            msg
        })?;

    let hex = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if hex.starts_with('#') && hex.len() == 7 {
        Ok(hex)
    } else if hex.is_empty() {
        Ok(String::new())
    } else {
        let msg = format!(
            "取色返回异常 stdout={:?} stderr={}",
            hex,
            if stderr.is_empty() {
                "(空)"
            } else {
                stderr.as_str()
            }
        );
        log::error!("{}", msg);
        Err(msg)
    }
}
