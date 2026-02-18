use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// 截图窗口是否已加载就绪
static SCREENSHOT_WINDOW_READY: AtomicBool = AtomicBool::new(false);
/// 截图流程进行中（防止并发 start_capture 覆盖全局状态）
static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 当前截图源文件路径（每次截图用唯一文件名，解决缓存 + 多次截图问题）
pub(super) static CURRENT_SCREENSHOT_PATH: std::sync::LazyLock<Mutex<Option<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

// 缓存最后一次截图数据，供前端 reload 后拉取
static LAST_SCREENSHOT_DATA: std::sync::LazyLock<Mutex<Option<Value>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

struct CaptureInProgressResetGuard;
impl Drop for CaptureInProgressResetGuard {
    fn drop(&mut self) {
        CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

// ===== 截图窗口管理（参考 eSearch：预创建 + 隐藏复用） =====

/// 获取与主窗口相同的加载 URL（开发时为 dev server，打包后为 app 资源，避免 AssetNotFound）
fn get_app_url(app: &AppHandle) -> WebviewUrl {
    // 开发模式：始终使用 dev server URL（不用 main_win.url()，它可能返回 tauri://localhost/）
    #[cfg(debug_assertions)]
    {
        if let Ok(dev_url) = Url::parse("http://localhost:5173/") {
             println!("[ScreenCapture] get_app_url returning dev url: {}", dev_url);
            return WebviewUrl::External(dev_url);
        }
    }
    // 生产模式：复用主窗口 URL
    if let Some(main_win) = app.get_webview_window("main") {
        if let Ok(url) = main_win.url() {
            println!("[ScreenCapture] get_app_url returning main window url: {}", url);
            return WebviewUrl::External(url);
        }
    }
    println!("[ScreenCapture] get_app_url returning index.html");
    WebviewUrl::App(PathBuf::from("index.html"))
}

/// 预创建隐藏的截图窗口（参考 eSearch 的 getClipWin：预创建 show:false 窗口）
/// 窗口加载完 React 后保持隐藏，截图时直接发数据并显示，无需每次重建
#[tauri::command]
pub async fn init_screenshot_window(app: AppHandle) -> Result<(), String> {
    // 若已存在，直接返回
    if app.get_webview_window("screenshot").is_some() {
        return Ok(());
    }

    SCREENSHOT_WINDOW_READY.store(false, Ordering::SeqCst);

    let (mon_x, mon_y, mon_w, mon_h) = super::capture::get_monitor_info(&app);

    // 仅标记截图模式，不注入图片数据（数据通过事件传递）
    let init_script = "window.__SCREENSHOT_MODE__=true;";

    WebviewWindowBuilder::new(
        &app,
        "screenshot",
        get_app_url(&app),
    )
    .title("截图")
    .inner_size(mon_w, mon_h)
    .position(mon_x, mon_y)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false) // 关键：创建时不显示，等就绪后再 show
    .initialization_script(init_script)
    .build()
    .map_err(|e| format!("创建截图窗口失败: {e}"))?;

    Ok(())
}

/// 前端 ScreenshotSelector 组件挂载完成后调用，标记窗口已就绪
#[tauri::command]
pub async fn screenshot_window_ready() -> Result<(), String> {
    SCREENSHOT_WINDOW_READY.store(true, Ordering::SeqCst);
    Ok(())
}

/// 前端图片加载完成后调用，显示截图窗口
#[tauri::command]
pub async fn show_screenshot_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("screenshot") {
        win.show().map_err(|e| format!("显示截图窗口失败: {e}"))?;
        win.set_focus().map_err(|e| format!("聚焦截图窗口失败: {e}"))?;
    }
    Ok(())
}

/// 开始区域截图（参考 eSearch 流程：隐藏主窗口 → 截屏 → 发送数据到预创建窗口 → 窗口就绪后显示）
#[tauri::command]
pub async fn start_capture(app: AppHandle, monitor_id: Option<u32>) -> Result<String, String> {
    if CAPTURE_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("截图进行中，请先完成或取消当前截图".to_string());
    }

    // 1. 隐藏主窗口
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.hide();
    }

    // 内部实际逻辑，出错时由外层恢复主窗口
    match start_capture_inner(&app, monitor_id).await {
        Ok(path) => Ok(path),
        Err(e) => {
            CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);
            // 出错时恢复主窗口，否则用户看不到任何反馈
            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.show();
                let _ = main_win.set_focus();
            }
            Err(e)
        }
    }
}

/// start_capture 的内部实现，分离出来以便统一错误恢复
async fn start_capture_inner(app: &AppHandle, monitor_id: Option<u32>) -> Result<String, String> {
    println!("[ScreenCapture] start_capture_inner called");
    // 1. 立即隐藏截图窗口（如果有），防止"显示旧图"
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.hide();
    }

    // 2. 获取显示器信息
    let main_win = app.get_webview_window("main");
    let monitor_info = main_win.as_ref()
        .and_then(|w| w.current_monitor().ok().flatten());

    // 发送开始截图事件，通知前端重置状态（解决"显示旧图"问题）
    let _ = app.emit("screenshot-start", ());

    let (mon_x, mon_y, mon_w, mon_h) = if let Some(m) = &monitor_info {
        let pos = m.position();
        let size = m.size();
        let sf = m.scale_factor();
        (
            pos.x as f64 / sf,
            pos.y as f64 / sf,
            size.width as f64 / sf,
            size.height as f64 / sf,
        )
    } else {
        (0.0, 0.0, 1440.0, 900.0)
    };

    // 3. 确保截图窗口存在
    let need_wait = if app.get_webview_window("screenshot").is_none() {
        // 窗口不存在（首次或被关闭了），创建新的（使用与主窗口相同 URL，开发模式才能加载）
        SCREENSHOT_WINDOW_READY.store(false, Ordering::SeqCst);
        let init_script = "window.__SCREENSHOT_MODE__=true;";
        WebviewWindowBuilder::new(
            app,
            "screenshot",
            get_app_url(app),
        )
        .title("截图")
        .inner_size(mon_w, mon_h)
        .position(mon_x, mon_y)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .initialization_script(init_script)
        .build()
        .map_err(|e| format!("创建截图窗口失败: {e}"))?;
        true
    } else {
        // 窗口已存在，调整位置和大小以匹配目标显示器
        if let Some(win) = app.get_webview_window("screenshot") {
            let _ = win.set_position(tauri::Position::Logical(
                tauri::LogicalPosition::new(mon_x, mon_y),
            ));
            let _ = win.set_size(tauri::Size::Logical(
                tauri::LogicalSize::new(mon_w, mon_h),
            ));
        }
        false
    };

    // 4. 短暂等待主窗口隐藏（macOS hide 是即时的，50ms 足够）
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // 5. 在阻塞线程中用 xcap 截全屏
    //    使用唯一文件名（时间戳），避免 webview 协议缓存导致第二次截图还显示旧图
    //    使用 BMP 格式：无压缩，写入速度比 PNG 快 10 倍以上（~10ms vs ~500ms）
    let (path_str, img_w, img_h, data_url) = tokio::task::spawn_blocking(move || -> Result<(String, u32, u32, String), String> {
        let monitors = xcap::Monitor::all().map_err(|e| format!("获取显示器列表失败: {e}"))?;
        if monitors.is_empty() {
            return Err("无可用显示器".to_string());
        }
        let idx = match monitor_id {
            Some(mid) => mid as usize,
            None => monitors.iter().position(|m| m.is_primary().unwrap_or(false)).unwrap_or(0),
        };
        let monitor = monitors.into_iter().nth(idx).ok_or_else(|| "指定显示器不存在".to_string())?;
        let img = monitor.capture_image().map_err(|e| {
            format!("截屏失败(可能需要授予<屏幕录制>权限: 系统设置 > 隐私与安全性 > 屏幕录制 > 添加本应用): {e}")
        })?;
        println!("[ScreenCapture] Image captured: {}x{}", img.width(), img.height());
        let w = img.width();
        let h = img.height();

        // 清理上一次的临时文件
        if let Ok(guard) = CURRENT_SCREENSHOT_PATH.lock() {
            if let Some(old_path) = guard.as_ref() {
                let _ = std::fs::remove_file(old_path);
            }
        }

        // 唯一文件名 + BMP（无压缩，极快写入）
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let path = std::env::temp_dir().join(format!("51toolbox-cap-{}.bmp", ts));
        img.save(&path).map_err(|e| format!("保存截图失败: {e}"))?;
        let path_s = path.to_string_lossy().to_string();

        // 记录当前路径，供 finish_capture 读取
        if let Ok(mut guard) = CURRENT_SCREENSHOT_PATH.lock() {
            *guard = Some(path_s.clone());
        }

        // 生成 Base64 Data URL (JPEG格式，编码快且体积小，适合预览)
        // JPEG 不支持 RGBA，必须先转为 RGB
        let mut buffer = std::io::Cursor::new(Vec::new());
        let rgb_img = image::DynamicImage::ImageRgba8(img).to_rgb8();
        image::DynamicImage::ImageRgb8(rgb_img)
            .write_to(&mut buffer, image::ImageFormat::Jpeg)
            .map_err(|e| format!("图片编码失败: {e}"))?;
        use base64::{engine::general_purpose, Engine as _};
        let base64_str = general_purpose::STANDARD.encode(buffer.get_ref());
        let data_url = format!("data:image/jpeg;base64,{}", base64_str);
        println!("[ScreenCapture] Encoding JPEG success, data length: {}", data_url.len());

        Ok((path_s, w, h, data_url))
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))??;

    // 6. 若窗口是刚创建的，等待前端就绪（最多 3 秒）
    if need_wait {
        for _ in 0..30 {
            if SCREENSHOT_WINDOW_READY.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    // 7. 通过事件发送截图数据到截图窗口
    println!("[ScreenCapture] Emitting screenshot-data: path={}", path_str);
    let payload = serde_json::json!({
        "path": path_str,
        "base64": data_url,
        "width": img_w,
        "height": img_h,
    });

    // 保存到缓存
    if let Ok(mut guard) = LAST_SCREENSHOT_DATA.lock() {
        *guard = Some(payload.clone());
    }

    if let Some(win) = app.get_webview_window("screenshot") {
        println!("[ScreenCapture] Window found, emitting to target window");
        if let Err(e) = win.emit("screenshot-data", &payload) {
             eprintln!("[ScreenCapture] Emit to window failed: {}", e);
             // Fallback to global emit
             let _ = app.emit("screenshot-data", &payload);
        }
    } else {
        println!("[ScreenCapture] Window not found (unexpected), emitting globally");
        let _ = app.emit("screenshot-data", &payload);
    }

    // 8. 显示并聚焦截图窗口
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.show();
        let _ = win.set_focus();
    }

    Ok(path_str)
}

/// 获取最后一次截图数据（用于前端加载/刷新后恢复状态）
#[tauri::command]
pub async fn get_last_screenshot() -> Result<Option<Value>, String> {
    let guard = LAST_SCREENSHOT_DATA.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

/// 完成区域截图：裁剪 → 复制到剪贴板 → 隐藏截图窗口 → 通知主窗口
#[tauri::command]
pub async fn finish_capture(
    app: AppHandle,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    copy_to_clipboard: Option<bool>,
    action: Option<String>,
    annotated_image: Option<String>,
) -> Result<String, String> {
    // 无论成功还是失败，都在结束时释放并发锁
    let _reset_guard = CaptureInProgressResetGuard;

    // 1. 隐藏截图窗口（不关闭，供下次复用）
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.hide();
    }

    // 2. 在阻塞线程中裁剪并复制到剪贴板
    let do_copy = copy_to_clipboard.unwrap_or(true);
    let source_path_opt = CURRENT_SCREENSHOT_PATH.lock()
        .map_err(|e| format!("获取截图锁失败: {e}"))?
        .clone();

    // 如果没有 annotated_image，则必须有 source_path
    if annotated_image.is_none() && source_path_opt.is_none() {
         return Err("没有可用的截图源文件".to_string());
    }

    let source_path_for_crop = source_path_opt.clone();
    let (result_str, result_base64, result_w, result_h) = tokio::task::spawn_blocking(move || -> Result<(String, String, u32, u32), String> {
        let dynamic_img = if let Some(base64_str) = annotated_image {
             // Case A: 前端传来了已标注的图片 (Base64)
             // 去掉头部的 "data:image/png;base64,"
             let data = base64_str.split(',').last().unwrap_or(&base64_str);
             use base64::{engine::general_purpose, Engine as _};
             let bytes = general_purpose::STANDARD
                 .decode(data)
                 .map_err(|e| format!("Base64 解码失败: {e}"))?;
             image::load_from_memory(&bytes)
                 .map_err(|e| format!("加载标注图片失败: {e}"))?
        } else {
             // Case B: 仅裁剪原图
             let path = source_path_for_crop
                 .as_ref()
                 .ok_or_else(|| "没有可用的截图源文件".to_string())?;
             let img = image::open(&path).map_err(|e| format!("打开截图失败: {e}"))?;
             img.crop_imm(x, y, width, height)
        };
        
        let out_w = dynamic_img.width();
        let out_h = dynamic_img.height();

        // 保存（统一存为 png）
        let result_path = std::env::temp_dir().join("51toolbox-screenshot-result.png");
        dynamic_img.save(&result_path).map_err(|e| format!("保存截图结果失败: {e}"))?;

        // 同时返回 base64，前端可直接消费，避免再次读临时文件失败
        let mut encoded = std::io::Cursor::new(Vec::new());
        dynamic_img
            .write_to(&mut encoded, image::ImageFormat::Png)
            .map_err(|e| format!("编码截图结果失败: {e}"))?;
        use base64::{engine::general_purpose, Engine as _};
        let image_base64 = general_purpose::STANDARD.encode(encoded.get_ref());

        if do_copy {
            let rgba = dynamic_img.to_rgba8();
            let w = rgba.width() as usize;
            let h = rgba.height() as usize;
            let bytes = rgba.into_raw();
            match arboard::Clipboard::new() {
                Ok(mut clipboard) => {
                    let _ = clipboard.set_image(arboard::ImageData {
                        width: w,
                        height: h,
                        bytes: bytes.into(),
                    });
                }
                Err(e) => {
                    eprintln!("剪贴板初始化失败（不影响截图保存）: {e}");
                }
            }
        }

        Ok((result_path.to_string_lossy().to_string(), image_base64, out_w, out_h))
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))??;

    // 3. 通知主窗口（含 action 字段）
    let action_str = action.unwrap_or_else(|| "copy".to_string());
    let _ = app.emit("capture-done", serde_json::json!({
        "path": result_str,
        "action": action_str,
        "imageBase64": result_base64,
        "imageWidth": result_w,
        "imageHeight": result_h,
    }));

    // 4. 恢复主窗口
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.set_focus();
    }

    Ok(result_str)
}

/// 取消区域截图：隐藏截图窗口（不关闭），恢复主窗口
#[tauri::command]
pub async fn cancel_capture(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.hide();
    }
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.set_focus();
    }
    CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);
    Ok(())
}
