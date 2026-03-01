use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct ScriptResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct SystemShellResult {
    pub runtime: &'static str,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Serialize)]
pub struct SystemWriteFileResult {
    pub runtime: &'static str,
    pub path: String,
    pub bytes: usize,
    pub message: String,
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
                let which_cmd = if cfg!(target_os = "windows") {
                    "where"
                } else {
                    "which"
                };
                let full_path = Command::new(which_cmd)
                    .arg(name)
                    .output()
                    .ok()
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
    let truncated = if bytes.len() > max {
        &bytes[..max]
    } else {
        &bytes
    };
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
        Command::new("open")
            .arg("-R")
            .arg(&file_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(&file_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 保存对话历史到本地
#[tauri::command]
pub async fn save_chat_history(app: tauri::AppHandle, conversations: String) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("chat-history.json").map_err(|e| e.to_string())?;
    store.set("conversations", serde_json::Value::String(conversations));
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
pub async fn save_agent_history(app: tauri::AppHandle, sessions: String) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("agent-history.json").map_err(|e| e.to_string())?;
    store.set("sessions", serde_json::Value::String(sessions));
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
pub async fn save_general_settings(app: tauri::AppHandle, settings: String) -> Result<(), String> {
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
    store.set("general_settings", serde_json::Value::String(settings));
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
        Ok(format!(
            "已清理 {} 张过期图片，释放 {:.2} MB 空间",
            deleted_count,
            total_size as f64 / 1024.0 / 1024.0
        ))
    } else {
        Ok("没有需要清理的过期图片".to_string())
    }
}

// ── Agent 文件系统 & Shell 安全策略 ──
// 以下命令具有系统级副作用，需配合路径/命令策略使用

/// 获取允许的文件操作根目录列表
fn get_allowed_path_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;
    let mut roots: Vec<PathBuf> = Vec::new();

    // 默认允许目录：用户 Home + 临时目录 + App 数据目录
    if let Ok(home) = app.path().home_dir() {
        roots.push(home);
    }
    roots.push(std::env::temp_dir());
    if let Ok(app_data) = app.path().app_data_dir() {
        roots.push(app_data);
    }

    // 从配置加载用户自定义的允许目录
    {
        use tauri_plugin_store::StoreExt;
        if let Ok(store) = app.store("config.json") {
            if let Some(val) = store.get("allowed_file_roots") {
                if let Some(arr) = val.as_array() {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            roots.push(PathBuf::from(s));
                        }
                    }
                }
            }
        }
    }

    roots
}

/// 校验文件路径是否在允许的根目录范围内
pub(crate) fn validate_path_access(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    // 阻止显式的路径遍历攻击
    if path.contains("..") {
        return Err("安全限制：路径不允许包含 '..'".to_string());
    }

    let p = std::path::Path::new(path);

    // 尝试规范化路径（解析符号链接）；不存在时退回绝对路径
    let resolved = if p.exists() {
        p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
    } else if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };

    let roots = get_allowed_path_roots(app);
    let allowed = roots.iter().any(|root| {
        let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        resolved.starts_with(&canon_root)
    });

    if !allowed {
        let root_list = roots
            .iter()
            .map(|r| r.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "安全限制：路径 {} 不在允许的目录范围内。允许的目录: {}",
            path, root_list
        ));
    }

    Ok(())
}

/// 被禁止的 Shell 命令模式（防止误操作导致系统损坏）
const BLOCKED_COMMAND_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "sudo rm -rf",
    "mkfs",
    "dd if=",
    "> /dev/sda",
    "> /dev/nvme",
    "chmod -R 777 /",
    ":(){ :|:& };:",
    "shutdown",
    "reboot",
    "init 0",
    "halt",
    "format c:",
];

const DEFAULT_FILE_RANGE_MAX_LINES: usize = 400;
const DEFAULT_SEARCH_MAX_RESULTS: usize = 200;
const MAX_FILE_BYTES_FOR_SEARCH: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_FILES: usize = 5000;

/// 校验 Shell 命令是否安全
pub(crate) fn validate_shell_command(command: &str) -> Result<(), String> {
    let lower = command.to_lowercase();
    let trimmed = lower.trim();
    for pattern in BLOCKED_COMMAND_PATTERNS {
        if trimmed.contains(pattern) {
            return Err(format!("安全限制：命令包含被禁止的模式 '{}'", pattern));
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct CodeSearchMatch {
    path: String,
    line: usize,
    column: usize,
    text: String,
}

fn should_skip_search_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".cache"
    )
}

fn matches_file_pattern(path: &Path, file_pattern: Option<&str>) -> bool {
    let Some(pattern) = file_pattern.map(|p| p.trim()).filter(|p| !p.is_empty()) else {
        return true;
    };

    if pattern.starts_with("*.") && pattern.len() > 2 {
        let ext = &pattern[2..].to_ascii_lowercase();
        return path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case(ext))
            .unwrap_or(false);
    }

    let path_text = path.to_string_lossy();
    if pattern.contains('*') {
        let core = pattern.replace('*', "");
        return core.is_empty() || path_text.contains(&core);
    }

    path_text.contains(pattern)
}

fn search_file_for_query(
    file_path: &Path,
    root_path: &Path,
    query: &str,
    case_sensitive: bool,
    max_results: usize,
    matches: &mut Vec<CodeSearchMatch>,
) {
    let metadata = match file_path.metadata() {
        Ok(m) => m,
        Err(_) => return,
    };
    if metadata.len() > MAX_FILE_BYTES_FOR_SEARCH {
        return;
    }

    let bytes = match std::fs::read(file_path) {
        Ok(b) => b,
        Err(_) => return,
    };
    // 简单二进制文件过滤：包含 NUL 字节则跳过
    if bytes.contains(&0) {
        return;
    }

    let content = String::from_utf8_lossy(&bytes);
    let needle = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    for (idx, line) in content.lines().enumerate() {
        if matches.len() >= max_results {
            break;
        }

        let haystack = if case_sensitive {
            line.to_string()
        } else {
            line.to_lowercase()
        };
        if let Some(found) = haystack.find(&needle) {
            let rel_path = file_path
                .strip_prefix(root_path)
                .unwrap_or(file_path)
                .display()
                .to_string();
            let text = if line.chars().count() > 300 {
                format!("{}…", line.chars().take(300).collect::<String>())
            } else {
                line.to_string()
            };
            matches.push(CodeSearchMatch {
                path: rel_path,
                line: idx + 1,
                column: found + 1,
                text,
            });
        }
    }
}

fn collect_search_matches(
    dir_path: &Path,
    root_path: &Path,
    query: &str,
    case_sensitive: bool,
    file_pattern: Option<&str>,
    max_results: usize,
    scanned_files: &mut usize,
    matches: &mut Vec<CodeSearchMatch>,
) -> Result<bool, String> {
    let entries = std::fs::read_dir(dir_path).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries {
        if matches.len() >= max_results || *scanned_files >= MAX_SEARCH_FILES {
            return Ok(true);
        }

        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let name = entry.file_name();
            if should_skip_search_dir(&name.to_string_lossy()) {
                continue;
            }
            if collect_search_matches(
                &path,
                root_path,
                query,
                case_sensitive,
                file_pattern,
                max_results,
                scanned_files,
                matches,
            )? {
                return Ok(true);
            }
            continue;
        }

        if !file_type.is_file() || !matches_file_pattern(&path, file_pattern) {
            continue;
        }

        *scanned_files += 1;
        search_file_for_query(
            &path,
            root_path,
            query,
            case_sensitive,
            max_results,
            matches,
        );
    }

    Ok(matches.len() >= max_results || *scanned_files >= MAX_SEARCH_FILES)
}

// ── Agent 文件系统 & Shell 工具 ──

/// 读取文本文件（受路径白名单保护）
#[tauri::command]
pub async fn read_text_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    validate_path_access(&app, &path)?;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }
    std::fs::read_to_string(p).map_err(|e| format!("读取失败: {}", e))
}

/// 写入文本文件（受路径白名单保护）
#[tauri::command]
pub async fn write_text_file(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<SystemWriteFileResult, String> {
    validate_path_access(&app, &path)?;
    let p = std::path::Path::new(&path);
    // 自动创建父目录
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    std::fs::write(p, &content).map_err(|e| format!("写入失败: {}", e))?;
    Ok(SystemWriteFileResult {
        runtime: "host",
        path: path.clone(),
        bytes: content.len(),
        message: format!("已写入 {} 字节到 {}", content.len(), path),
    })
}

/// 列出目录内容（受路径白名单保护）
#[tauri::command]
pub async fn list_directory(app: tauri::AppHandle, path: String) -> Result<String, String> {
    validate_path_access(&app, &path)?;
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

/// 按行范围读取文本文件（适合代码审阅）
#[tauri::command]
pub async fn read_text_file_range(
    app: tauri::AppHandle,
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
) -> Result<String, String> {
    validate_path_access(&app, &path)?;

    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let content = std::fs::read_to_string(p).map_err(|e| format!("读取失败: {}", e))?;
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return Ok("".to_string());
    }

    let max_lines = max_lines
        .unwrap_or(DEFAULT_FILE_RANGE_MAX_LINES)
        .clamp(1, 2000);
    let start = start_line.unwrap_or(1).max(1);
    let requested_end = end_line.unwrap_or(start + max_lines - 1);
    if requested_end < start {
        return Err("参数错误：end_line 不能小于 start_line".to_string());
    }
    let capped_end = requested_end.min(start + max_lines - 1);

    let total_lines = lines.len();
    if start > total_lines {
        return Ok(format!(
            "文件共 {} 行，请求起始行 {} 超出范围",
            total_lines, start
        ));
    }

    let start_idx = start - 1;
    let end_idx = capped_end.min(total_lines);
    let mut output: Vec<String> = Vec::new();
    for (offset, line) in lines[start_idx..end_idx].iter().enumerate() {
        let line_no = start + offset;
        output.push(format!("{:>6} | {}", line_no, line));
    }

    if end_idx < total_lines {
        output.push(format!(
            "\n[已截断：显示到第 {} 行，文件总计 {} 行]",
            end_idx, total_lines
        ));
    }

    Ok(output.join("\n"))
}

/// 在目录下递归搜索文本内容（适合代码检索）
#[tauri::command]
pub async fn search_in_files(
    app: tauri::AppHandle,
    path: String,
    query: String,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
    file_pattern: Option<String>,
) -> Result<String, String> {
    if query.trim().is_empty() {
        return Err("query 不能为空".to_string());
    }

    validate_path_access(&app, &path)?;

    let root = PathBuf::from(&path);
    if !root.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("不是目录: {}", path));
    }

    let case_sensitive = case_sensitive.unwrap_or(false);
    let max_results = max_results
        .unwrap_or(DEFAULT_SEARCH_MAX_RESULTS)
        .clamp(1, 1000);
    let mut scanned_files = 0usize;
    let mut matches = Vec::<CodeSearchMatch>::new();

    let truncated = collect_search_matches(
        &root,
        &root,
        &query,
        case_sensitive,
        file_pattern.as_deref(),
        max_results,
        &mut scanned_files,
        &mut matches,
    )?;

    let payload = serde_json::json!({
        "root": root.display().to_string(),
        "query": query,
        "case_sensitive": case_sensitive,
        "file_pattern": file_pattern,
        "scanned_files": scanned_files,
        "match_count": matches.len(),
        "truncated": truncated,
        "matches": matches,
    });
    serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化失败: {}", e))
}

/// 执行 Shell 命令（受命令策略保护）
#[tauri::command]
pub async fn run_shell_command(command: String) -> Result<SystemShellResult, String> {
    validate_shell_command(&command)?;
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
            Ok(SystemShellResult {
                runtime: "host",
                exit_code: code,
                stdout,
                stderr,
            })
        }
        Err(e) => Err(format!("执行失败: {}", e)),
    }
}

/// Agent 用：获取 URL 网页内容（绕过 WebView CORS 限制）
#[tauri::command]
pub async fn web_fetch_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("MTools-Agent/1.0")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown")));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    // 限制返回大小（按字符截断，避免在多字节字符边界 panic）
    if body.len() > 100_000 {
        Ok(body.chars().take(100_000).collect())
    } else {
        Ok(body)
    }
}

/// 网络搜索（Tauri command + 内部可复用）
#[tauri::command]
pub async fn web_search(query: String, max_results: Option<usize>) -> Result<String, String> {
    web_search_impl(query, max_results.unwrap_or(5)).await
}

/// 网络搜索实现：Bing (主) → DuckDuckGo (备) → 提示用户
pub async fn web_search_impl(query: String, max_results: usize) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let max_results = max_results.min(10).max(1);
    let mut results: Vec<(String, String, String)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // ── 引擎 1: Bing（国内可用） ──
    if results.is_empty() {
        match search_bing(&client, &query, max_results).await {
            Ok(r) => results = r,
            Err(e) => {
                log::warn!("Bing 搜索失败: {}", e);
                errors.push(format!("Bing: {}", e));
            }
        }
    }

    // ── 引擎 2: DuckDuckGo HTML Lite（备选） ──
    if results.is_empty() {
        match search_duckduckgo(&client, &query, max_results).await {
            Ok(r) => results = r,
            Err(e) => {
                log::warn!("DuckDuckGo 搜索失败: {}", e);
                errors.push(format!("DuckDuckGo: {}", e));
            }
        }
    }

    if results.is_empty() {
        let error_detail = if errors.is_empty() {
            String::new()
        } else {
            format!("\n搜索引擎状态: {}", errors.join("; "))
        };
        return Ok(format!(
            "未找到与「{}」相关的搜索结果。{}",
            query, error_detail
        ));
    }

    let mut output = format!("搜索「{}」找到 {} 条结果：\n\n", query, results.len());
    for (i, (title, url, snippet)) in results.iter().enumerate() {
        output.push_str(&format!("{}. {}\n   链接: {}\n", i + 1, title, url));
        if !snippet.is_empty() {
            output.push_str(&format!("   摘要: {}\n", snippet));
        }
        output.push('\n');
    }
    output.push_str("如需查看某条结果的详细内容，可使用 web_fetch 工具获取对应链接。");

    Ok(output)
}

/// Bing 搜索
async fn search_bing(
    client: &reqwest::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<(String, String, String)>, String> {
    let encoded = percent_encoding::utf8_percent_encode(query, percent_encoding::NON_ALPHANUMERIC).to_string();
    let url = format!("https://www.bing.com/search?q={}&count={}", encoded, max_results);

    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36")
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let html = resp.text().await.map_err(|e| format!("读取失败: {}", e))?;
    let mut results = Vec::new();

    // Bing 结构: <li class="b_algo"><h2><a href="URL">Title</a></h2> ... <p>Snippet</p></li>
    for block in html.split("class=\"b_algo\"").skip(1).take(max_results) {
        let title = extract_tag_content(block, "<h2", "</h2>")
            .map(|h2| strip_html_tags(&h2))
            .unwrap_or_default();
        let url = extract_first_href(block).unwrap_or_default();
        let snippet = extract_tag_content(block, "<p", "</p>")
            .map(|p| strip_html_tags(&p))
            .unwrap_or_default();

        let title = title.trim().to_string();
        let url = url.trim().to_string();
        let snippet = snippet.trim().to_string();

        if !title.is_empty() && url.starts_with("http") {
            results.push((title, url, snippet));
        }
    }

    if results.is_empty() {
        return Err("解析结果为空".to_string());
    }
    Ok(results)
}

/// DuckDuckGo HTML Lite 搜索
async fn search_duckduckgo(
    client: &reqwest::Client,
    query: &str,
    max_results: usize,
) -> Result<Vec<(String, String, String)>, String> {
    let resp = client
        .post("https://lite.duckduckgo.com/lite/")
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!("q={}", percent_encoding::utf8_percent_encode(query, percent_encoding::NON_ALPHANUMERIC)))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }

    let html = resp.text().await.map_err(|e| format!("读取失败: {}", e))?;
    let mut results = Vec::new();

    // DuckDuckGo Lite: <a rel="nofollow" href="URL" class='result-link'>Title</a>
    //                   <td class='result-snippet'>Snippet</td>
    for block in html.split("class='result-link'").skip(1).take(max_results) {
        // title is the text content right after the class marker, inside the <a> tag
        let title = if let Some(end) = block.find("</a>") {
            let inner = &block[..end];
            if let Some(gt) = inner.rfind('>') {
                strip_html_tags(&inner[gt + 1..]).trim().to_string()
            } else {
                strip_html_tags(inner).trim().to_string()
            }
        } else {
            String::new()
        };

        // URL is in the href before the class marker - need to look back at previous content
        // Actually, href="URL" comes before class='result-link' in the same <a> tag
        // So we need to find it in the preceding text of the split
        let url = String::new(); // will get from href below

        // Try extracting href from the block (it may appear as href="..." before class)
        // Let's find the actual URL by looking at result-link blocks differently
        let snippet_text = if let Some(snippet_block) = block.split("class='result-snippet'").nth(1) {
            extract_tag_content(snippet_block, "", "</td>")
                .or_else(|| extract_tag_content(snippet_block, "", "</span>"))
                .map(|s| strip_html_tags(&s).trim().to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };

        if !title.is_empty() && !url.is_empty() {
            results.push((title, url, snippet_text));
        }
    }

    // Alternative parsing: split by "result-link" href
    if results.is_empty() {
        for block in html.split("class=\"result-link\"").chain(html.split("class='result-link'")).skip(1).take(max_results) {
            let title_text = block.split("</a>").next()
                .map(|s| {
                    let clean = if let Some(pos) = s.rfind('>') { &s[pos + 1..] } else { s };
                    strip_html_tags(clean).trim().to_string()
                })
                .unwrap_or_default();

            // URL could be from uddg redirect or direct
            let link = extract_first_href(block)
                .and_then(|u| decode_search_redirect(&u))
                .unwrap_or_default();

            if !title_text.is_empty() && link.starts_with("http") {
                results.push((title_text, link, String::new()));
                if results.len() >= max_results { break; }
            }
        }
    }

    if results.is_empty() {
        return Err("解析结果为空".to_string());
    }
    Ok(results)
}

fn decode_search_redirect(url: &str) -> Option<String> {
    if url.contains("uddg=") {
        let uddg_pos = url.find("uddg=")?;
        let encoded = &url[uddg_pos + 5..];
        let end = encoded.find('&').unwrap_or(encoded.len());
        Some(percent_encoding::percent_decode_str(&encoded[..end]).decode_utf8_lossy().to_string())
    } else if url.starts_with("/url?q=") {
        let cleaned = &url[7..];
        let end = cleaned.find('&').unwrap_or(cleaned.len());
        Some(percent_encoding::percent_decode_str(&cleaned[..end]).decode_utf8_lossy().to_string())
    } else if url.starts_with("http") {
        Some(url.to_string())
    } else {
        None
    }
}

/// 提取标签内容（从 start_tag 的 '>' 到 end_tag）
fn extract_tag_content(text: &str, start_tag: &str, end_tag: &str) -> Option<String> {
    let start = if start_tag.is_empty() {
        0
    } else {
        text.find(start_tag)?
    };
    let after = &text[start..];
    let content_start = after.find('>')? + 1;
    let content = &after[content_start..];
    let end = content.find(end_tag)?;
    Some(content[..end].to_string())
}

/// 提取第一个 href 属性值
fn extract_first_href(text: &str) -> Option<String> {
    let href_pos = text.find("href=\"")?;
    let after = &text[href_pos + 6..];
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}
