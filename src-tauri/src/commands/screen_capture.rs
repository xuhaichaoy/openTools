use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

// ===== Helper 进程管理 =====

struct HelperProcess {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout_reader: BufReader<std::process::ChildStdout>,
}

static HELPER: std::sync::LazyLock<Mutex<Option<HelperProcess>>> =
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

    // 启动新进程
    let helper_path = get_helper_path(app);
    if !helper_path.exists() {
        return Err("helper 未安装，请先下载".to_string());
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

        // 如果是事件推送 (id 为 null)，转发给前端
        if resp.get("event").is_some() {
            // 这里需要 app handle 来发送事件，但我们在锁内
            // 暂时跳过事件转发，后续优化
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
    let helper_path = get_helper_path(&app);
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
        return Err(format!("下载失败: HTTP {}", resp.status()));
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
