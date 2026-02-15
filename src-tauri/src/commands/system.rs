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

/// 保存通用设置
#[tauri::command]
pub async fn save_general_settings(
    app: tauri::AppHandle,
    settings: String,
) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
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
    Err("未找到 Python，请确保 Python 3 已安装并在 PATH 中".to_string())
}
