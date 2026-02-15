use base64::Engine;
use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct ScriptResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// 执行 Python 脚本
#[tauri::command]
pub async fn run_python_script(
    script_path: String,
    args: Vec<String>,
    env_vars: std::collections::HashMap<String, String>,
) -> Result<ScriptResult, String> {
    let python = detect_python().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&python);
    cmd.arg(&script_path);
    cmd.args(&args);

    for (key, value) in &env_vars {
        cmd.env(key, value);
    }

    let output = cmd.output().map_err(|e| format!("执行失败: {}", e))?;

    Ok(ScriptResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
    })
}

/// 检测 Python 路径（返回完整路径 + 版本）
#[tauri::command]
pub async fn get_python_path() -> Result<String, String> {
    for name in &["python3", "python"] {
        if let Ok(output) = Command::new(name).arg("--version").output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let version = if version.is_empty() {
                    String::from_utf8_lossy(&output.stderr).trim().to_string()
                } else {
                    version
                };
                // 获取完整路径
                let which_cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
                let full_path = Command::new(which_cmd).arg(name).output().ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().lines().next().unwrap_or("").to_string())
                    .unwrap_or_else(|| name.to_string());
                return Ok(format!("{} ({})", full_path, version));
            }
        }
    }
    Err("未找到 Python".to_string())
}

/// 读取文件并返回 base64 字符串（用于前端显示图片等）
#[derive(serde::Deserialize)]
pub(crate) struct ReadFileBase64Args {
    #[serde(rename = "filePath")]
    file_path: String,
}

#[tauri::command]
pub async fn read_file_base64(args: ReadFileBase64Args) -> Result<String, String> {
    let path = std::path::Path::new(&args.file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", args.file_path));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读取失败: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// 预览文件内容（限制读取大小）
#[tauri::command]
pub async fn preview_file(file_path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }

    let max = max_bytes.unwrap_or(102400); // 默认 100KB
    let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {}", e))?;
    let truncated = if bytes.len() > max { &bytes[..max] } else { &bytes };
    let content = String::from_utf8_lossy(truncated).to_string();
    Ok(content)
}

/// 用系统默认浏览器打开 URL
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("打开 URL 失败: {}", e))
}

/// 在文件管理器中打开文件所在目录
#[tauri::command]
pub async fn open_file_location(file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    let _dir = path.parent().unwrap_or(path);

    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(&file_path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg("/select,").arg(&file_path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 保存对话历史到本地
#[tauri::command]
pub async fn save_chat_history(
    app: tauri::AppHandle,
    conversations: String,
) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("chat-history.json").map_err(|e| e.to_string())?;
    store.set(
        "conversations",
        serde_json::Value::String(conversations),
    );
    Ok(())
}

/// 加载对话历史
#[tauri::command]
pub async fn load_chat_history(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("chat-history.json").map_err(|e| e.to_string())?;
    let val = store
        .get("conversations")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "[]".to_string());
    Ok(val)
}

/// 保存 Agent 会话历史
#[tauri::command]
pub async fn save_agent_history(
    app: tauri::AppHandle,
    sessions: String,
) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("agent-history.json").map_err(|e| e.to_string())?;
    store.set(
        "sessions",
        serde_json::Value::String(sessions),
    );
    Ok(())
}

/// 加载 Agent 会话历史
#[tauri::command]
pub async fn load_agent_history(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("agent-history.json").map_err(|e| e.to_string())?;
    let val = store
        .get("sessions")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "[]".to_string());
    Ok(val)
}

/// 保存通用设置
#[tauri::command]
pub async fn save_general_settings(
    app: tauri::AppHandle,
    settings: String,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_store::StoreExt;

    // 1. 尝试应用设置（如 alwaysOnTop）
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&settings) {
        if let Some(always_on_top) = json.get("alwaysOnTop").and_then(|v| v.as_bool()) {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_always_on_top(always_on_top);
            }
        }
    }

    // 2. 持久化存储
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    store.set(
        "general_settings",
        serde_json::Value::String(settings),
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// 加载通用设置
#[tauri::command]
pub async fn load_general_settings(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    let val = store
        .get("general_settings")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "{}".to_string());
    Ok(val)
}

fn detect_python() -> Result<String, String> {
    for name in &["python3", "python"] {
        if let Ok(output) = Command::new(name).arg("--version").output() {
            if output.status.success() {
                return Ok(name.to_string());
            }
        }
    }
    Err("未找到 Python".to_string())
}

/// 清理 N 天前的聊天图片缓存
#[tauri::command]
pub async fn clean_old_chat_images(app: tauri::AppHandle, days: u64) -> Result<String, String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let images_dir = app_data_dir.join("chat_images");

    if !images_dir.exists() {
        return Ok("目录不存在，无需清理".to_string());
    }

    let mut deleted_count = 0;
    let mut total_size = 0;
    let now = std::time::SystemTime::now();
    let retention_period = std::time::Duration::from_secs(days * 24 * 60 * 60);

    let entries = std::fs::read_dir(&images_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        if let Ok(entry) = entry {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(age) = now.duration_since(modified) {
                        if age > retention_period {
                            let size = metadata.len();
                            if std::fs::remove_file(entry.path()).is_ok() {
                                deleted_count += 1;
                                total_size += size;
                            }
                        }
                    }
                }
            }
        }
    }

    if deleted_count > 0 {
        Ok(format!("已清理 {} 张过期图片，释放 {:.2} MB 空间", deleted_count, total_size as f64 / 1024.0 / 1024.0))
    } else {
        Ok("没有需要清理的过期图片".to_string())
    }
}

// ── Agent 文件系统 & Shell 工具 ──

/// 读取文本文件
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    std::fs::read_to_string(p).map_err(|e| format!("读取失败: {}", e))
}

/// 写入文本文件
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    // 自动创建父目录
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    std::fs::write(p, &content).map_err(|e| format!("写入失败: {}", e))?;
    Ok(format!("已写入 {} 字节到 {}", content.len(), path))
}

/// 列出目录内容
#[tauri::command]
pub async fn list_directory(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("不是目录: {}", path));
    }

    let mut entries: Vec<serde_json::Value> = Vec::new();
    let dir = std::fs::read_dir(p).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in dir {
        if let Ok(entry) = entry {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            entries.push(serde_json::json!({
                "name": name,
                "is_dir": is_dir,
                "size": size,
            }));
        }
    }
    serde_json::to_string_pretty(&entries).map_err(|e| format!("序列化失败: {}", e))
}

/// 执行 Shell 命令
#[tauri::command]
pub async fn run_shell_command(command: String) -> Result<String, String> {
    let output = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", &command]).output()
    } else {
        Command::new("sh").args(["-c", &command]).output()
    };

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let code = out.status.code().unwrap_or(-1);
            Ok(serde_json::json!({
                "exit_code": code,
                "stdout": stdout,
                "stderr": stderr,
            }).to_string())
        }
        Err(e) => Err(format!("执行失败: {}", e)),
    }
}
