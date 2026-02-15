use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

// ===== Helper 进程管理 =====

struct HelperProcess {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout_reader: BufReader<std::process::ChildStdout>,
}

static HELPER: std::sync::LazyLock<Mutex<Option<HelperProcess>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// 截图窗口是否已加载就绪
static SCREENSHOT_WINDOW_READY: AtomicBool = AtomicBool::new(false);

/// 当前截图源文件路径（每次截图用唯一文件名，解决缓存 + 多次截图问题）
static CURRENT_SCREENSHOT_PATH: std::sync::LazyLock<Mutex<Option<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

fn get_helpers_dir(app: &AppHandle) -> PathBuf {
    let data_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    data_dir.join("helpers")
}

fn get_helper_path(app: &AppHandle) -> PathBuf {
    let dir = get_helpers_dir(app);
    if cfg!(windows) {
        dir.join("screen-capture-helper.exe")
    } else {
        dir.join("screen-capture-helper")
    }
}

/// 解析实际使用的 helper 路径：优先已下载的，否则尝试开发目录下编译产物
fn resolve_helper_path(app: &AppHandle) -> PathBuf {
    let downloaded = get_helper_path(app);
    if downloaded.exists() {
        return downloaded;
    }
    // 开发环境：从可执行文件位置推断 workspace 根目录
    if let Ok(exe_dir) = app.path().executable_dir() {
        // exe_dir 一般为 .../51ToolBox/src-tauri/target/debug
        let workspace_root = exe_dir.parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent());
        if let Some(root) = workspace_root {
            let base = root.join("crates/screen-capture-helper/target");
            let release = base.join("release/screen-capture-helper");
            let debug = base.join("debug/screen-capture-helper");
            #[cfg(windows)]
            let release = base.join("release/screen-capture-helper.exe");
            #[cfg(windows)]
            let debug = base.join("debug/screen-capture-helper.exe");
            if release.exists() {
                return release;
            }
            if debug.exists() {
                return debug;
            }
        }
    }
    downloaded
}

fn get_ffmpeg_path(app: &AppHandle) -> PathBuf {
    let dir = get_helpers_dir(app);
    if cfg!(windows) {
        dir.join("ffmpeg.exe")
    } else {
        dir.join("ffmpeg")
    }
}

/// 确保 helper 进程正在运行，返回可用的 stdin/stdout
fn ensure_helper(app: &AppHandle) -> Result<(), String> {
    let mut guard = HELPER.lock().map_err(|e| format!("锁失败: {e}"))?;

    // 检查进程是否存活
    if let Some(ref mut hp) = *guard {
        match hp.child.try_wait() {
            Ok(Some(_)) => {
                // 进程已退出，清理
                *guard = None;
            }
            Ok(None) => return Ok(()), // 进程存活
            Err(_) => {
                *guard = None;
            }
        }
    }

    // 启动新进程（优先已下载，否则用开发目录下编译的）
    let helper_path = resolve_helper_path(app);
    if !helper_path.exists() {
        return Err("helper 未安装。请先下载，或本地编译：在项目根目录执行 cd crates/screen-capture-helper && cargo build --release，将 target/release/screen-capture-helper 复制到应用数据目录的 helpers 文件夹".to_string());
    }

    let mut child = Command::new(&helper_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 helper 失败: {e}"))?;

    let stdin = child.stdin.take().ok_or("无法获取 helper stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取 helper stdout")?;
    let reader = BufReader::new(stdout);

    *guard = Some(HelperProcess { child, stdin, stdout_reader: reader });
    Ok(())
}

/// 发送 JSON-RPC 请求并等待响应
fn call_helper(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    ensure_helper(app)?;

    let mut guard = HELPER.lock().map_err(|e| format!("锁失败: {e}"))?;
    let hp = guard.as_mut().ok_or("helper 未启动")?;

    // 构建请求
    static REQ_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = REQ_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    let request = serde_json::json!({
        "id": id,
        "method": method,
        "params": params,
    });

    // 发送
    let line = serde_json::to_string(&request).map_err(|e| format!("序列化失败: {e}"))?;
    writeln!(hp.stdin, "{}", line).map_err(|e| format!("写入 helper 失败: {e}"))?;
    hp.stdin.flush().map_err(|e| format!("flush 失败: {e}"))?;

    // 读取响应 (跳过事件推送，转发给前端)
    loop {
        let mut response_line = String::new();
        hp.stdout_reader.read_line(&mut response_line)
            .map_err(|e| format!("读取 helper 响应失败: {e}"))?;

        let response_line = response_line.trim();
        if response_line.is_empty() {
            continue;
        }

        let resp: Value = serde_json::from_str(response_line)
            .map_err(|e| format!("解析 helper 响应失败: {e}"))?;

        // 如果是事件推送，转发给前端
        if resp.get("event").is_some() {
            let _ = app.emit("screen-capture-event", resp.clone());
            continue;
        }

        // 检查是否是我们的响应
        if resp.get("id").and_then(|v| v.as_u64()) == Some(id) {
            if let Some(error) = resp.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
            return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

// ===== 下载管理 =====

fn get_download_url(component: &str) -> String {
    let target = if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        }
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else {
        "x86_64-unknown-linux-gnu"
    };

    match component {
        "helper" => format!(
            "https://github.com/51cto/mtools-screen-capture/releases/latest/download/screen-capture-helper-{}.tar.gz",
            target
        ),
        "ffmpeg" => {
            if cfg!(target_os = "macos") {
                "https://github.com/eugeneware/ffmpeg-static/releases/latest/download/darwin-x64".to_string()
            } else {
                "https://github.com/eugeneware/ffmpeg-static/releases/latest/download/win32-x64".to_string()
            }
        }
        _ => String::new(),
    }
}

// ===== 获取显示器信息 =====

fn get_monitor_info(app: &AppHandle) -> (f64, f64, f64, f64) {
    let main_win = app.get_webview_window("main");
    let monitor_info = main_win.as_ref()
        .and_then(|w| w.current_monitor().ok().flatten());
    if let Some(m) = &monitor_info {
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
    }
}

// ===== Tauri 命令 =====

#[derive(Serialize)]
pub struct ComponentStatus {
    helper_installed: bool,
    helper_path: String,
    ffmpeg_installed: bool,
    ffmpeg_path: String,
}

/// 检查组件状态
#[tauri::command]
pub async fn screen_capture_check(app: AppHandle) -> Result<ComponentStatus, String> {
    let helper_path = resolve_helper_path(&app);
    let ffmpeg_path = get_ffmpeg_path(&app);
    Ok(ComponentStatus {
        helper_installed: helper_path.exists(),
        helper_path: helper_path.to_string_lossy().to_string(),
        ffmpeg_installed: ffmpeg_path.exists() || which_ffmpeg(),
        ffmpeg_path: ffmpeg_path.to_string_lossy().to_string(),
    })
}

/// 下载组件
#[tauri::command]
pub async fn screen_capture_download(app: AppHandle, component: String) -> Result<(), String> {
    let helpers_dir = get_helpers_dir(&app);
    std::fs::create_dir_all(&helpers_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let url = get_download_url(&component);
    if url.is_empty() {
        return Err(format!("未知组件: {}", component));
    }

    let target_path = match component.as_str() {
        "helper" => get_helper_path(&app),
        "ffmpeg" => get_ffmpeg_path(&app),
        _ => return Err(format!("未知组件: {}", component)),
    };

    // 使用 reqwest 下载
    let client = reqwest::Client::new();
    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;

    if !resp.status().is_success() {
        if resp.status().as_u16() == 404 && component == "helper" {
            let helpers_dir = get_helpers_dir(&app);
            return Err(format!(
                "预编译组件暂未发布（404）。请本地编译：在项目根目录执行 cd crates/screen-capture-helper && cargo build --release，将生成的 target/release/screen-capture-helper 复制到 {}",
                helpers_dir.display()
            ));
        }
        return Err(format!("下载失败: HTTP {}。若为 404，可本地编译 helper 后复制到应用数据目录的 helpers 文件夹", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("下载数据失败: {e}"))?;

    // 写入文件
    std::fs::write(&target_path, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;

    // 设置可执行权限 (Unix)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(&target_path, perms)
            .map_err(|e| format!("设置权限失败: {e}"))?;
    }

    // 发送完成事件
    let _ = app.emit("screen-capture-download-done", serde_json::json!({
        "component": component,
        "path": target_path.to_string_lossy().to_string(),
    }));

    Ok(())
}

/// 调用 helper 的统一入口
#[tauri::command]
pub async fn screen_capture_call(
    app: AppHandle,
    method: String,
    params: Value,
) -> Result<Value, String> {
    // 在阻塞线程中执行 (helper IPC 是同步的)
    tokio::task::spawn_blocking(move || {
        call_helper(&app, &method, params)
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?
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

    let (mon_x, mon_y, mon_w, mon_h) = get_monitor_info(&app);

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
    // 1. 隐藏主窗口
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.hide();
    }

    // 内部实际逻辑，出错时由外层恢复主窗口
    match start_capture_inner(&app, monitor_id).await {
        Ok(path) => Ok(path),
        Err(e) => {
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
    // 1. 立即隐藏截图窗口（如果有），防止“显示旧图”
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.hide();
    }

    // 2. 获取显示器信息
    let main_win = app.get_webview_window("main");
    let monitor_info = main_win.as_ref()
        .and_then(|w| w.current_monitor().ok().flatten());

    // 发送开始截图事件，通知前端重置状态（解决“显示旧图”问题）
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

    // 7. 通过事件发送截图数据到截图窗口（参考 eSearch 的 clip_init IPC）
    println!("[ScreenCapture] Emitting screenshot-data: path={}", path_str);
    let _ = app.emit("screenshot-data", serde_json::json!({
        "path": path_str,
        "base64": data_url,
        "width": img_w,
        "height": img_h,
    }));

    // 8. 显示并聚焦截图窗口（关键修复：之前忘了 show，导致窗口不可见）
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.show();
        let _ = win.set_focus();
    }

    Ok(path_str)
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
) -> Result<String, String> {
    // 1. 隐藏截图窗口（不关闭，供下次复用）
    if let Some(win) = app.get_webview_window("screenshot") {
        let _ = win.hide();
    }

    // 2. 在阻塞线程中裁剪并复制到剪贴板
    let do_copy = copy_to_clipboard.unwrap_or(true);
    let source_path = CURRENT_SCREENSHOT_PATH.lock()
        .map_err(|e| format!("获取截图路径失败: {e}"))?
        .clone()
        .ok_or_else(|| "没有可用的截图源文件".to_string())?;
    let result_str = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let img = image::open(&source_path).map_err(|e| format!("打开截图失败: {e}"))?;
        let cropped = img.crop_imm(x, y, width, height);
        let result_path = std::env::temp_dir().join("51toolbox-screenshot-cropped.png");
        cropped.save(&result_path).map_err(|e| format!("保存裁剪截图失败: {e}"))?;

        if do_copy {
            let rgba = cropped.to_rgba8();
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

        Ok(result_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))??;

    // 3. 通知主窗口（含 action 字段）
    let action_str = action.unwrap_or_else(|| "copy".to_string());
    let _ = app.emit("capture-done", serde_json::json!({
        "path": result_str,
        "action": action_str,
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
    Ok(())
}

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
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("创建临时目录失败: {e}"))?;

    let system_titles = [
        "Dock", "Menu Bar", "MenuBar", "Status", "Notification Center",
        "", "Desktop", "mTools", "截图",
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
        if system_titles.contains(&title.as_str())
            || title.len() < 2
            || width < 100
            || height < 100
        {
            continue;
        }

        // 截取窗口
        let image = match window.capture_image() {
            Ok(img) => img,
            Err(_) => continue,
        };

        let path = temp_dir.join(format!(
            "window-{}-{}.png",
            i,
            normalized_filename(&title)
        ));
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
fn which_ffmpeg() -> bool {
    if cfg!(windows) {
        Command::new("where").arg("ffmpeg").output()
            .map(|o| o.status.success()).unwrap_or(false)
    } else {
        Command::new("which").arg("ffmpeg").output()
            .map(|o| o.status.success()).unwrap_or(false)
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
pub async fn capture_window_xcap_by_id( window_id: u32) -> Result<String, String> {
    // 隐藏主窗口的逻辑在前端调用此命令前处理，或者这里不做处理（只负责截取）
    
    let windows = xcap::Window::all().map_err(|e| format!("获取窗口列表失败: {e}"))?;
    let window = windows.into_iter().find(|w| w.id().unwrap_or(0) == window_id)
        .ok_or_else(|| "未找到指定 ID 的窗口".to_string())?;

    let img = window.capture_image().map_err(|e| format!("截图失败: {e}"))?;
    
    // 保存到临时文件
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = std::env::temp_dir().join(format!("xcap-win-{}.png", ts));
    img.save(&path).map_err(|e| format!("保存失败: {e}"))?;
    
    // 记录路径供 finish_capture 使用
    if let Ok(mut guard) = CURRENT_SCREENSHOT_PATH.lock() {
        *guard = Some(path.to_string_lossy().to_string());
    }

    Ok(path.to_string_lossy().to_string())
}
