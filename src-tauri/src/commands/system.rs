use base64::Engine;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
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
const PROJECT_IGNORE_FILES: [&str; 3] = [".gitignore", ".ignore", ".rgignore"];

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

fn build_project_ignore_matcher(root_path: &Path) -> Option<Gitignore> {
    let mut builder = GitignoreBuilder::new(root_path);
    let mut added_any = false;

    for filename in PROJECT_IGNORE_FILES {
        let candidate = root_path.join(filename);
        if candidate.exists() {
            builder.add(candidate);
            added_any = true;
        }
    }

    if !added_any {
        return None;
    }

    match builder.build() {
        Ok(matcher) => Some(matcher),
        Err(err) => {
            log::warn!("构建 ignore 规则失败: {}", err);
            None
        }
    }
}

fn is_path_ignored(path: &Path, is_dir: bool, matcher: Option<&Gitignore>) -> bool {
    matcher
        .map(|m| m.matched(path, is_dir).is_ignore())
        .unwrap_or(false)
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
    ignore_matcher: Option<&Gitignore>,
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

        if is_path_ignored(&path, file_type.is_dir(), ignore_matcher) {
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
                ignore_matcher,
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

/// 创建目录（受路径白名单保护，支持递归创建）
#[tauri::command]
pub async fn create_directory(
    app: tauri::AppHandle,
    path: String,
    recursive: Option<bool>,
) -> Result<String, String> {
    validate_path_access(&app, &path)?;
    let p = std::path::Path::new(&path);
    let recursive = recursive.unwrap_or(true);

    if p.exists() {
        if p.is_dir() {
            return Ok(format!("目录已存在: {}", path));
        } else {
            return Err(format!("路径存在但不是目录: {}", path));
        }
    }

    if recursive {
        std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败: {}", e))?;
    } else {
        std::fs::create_dir(p).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    Ok(format!("已创建目录: {}", path))
}

/// 删除文件或空目录（受路径白名单保护）
#[tauri::command]
pub async fn delete_file(app: tauri::AppHandle, path: String) -> Result<String, String> {
    validate_path_access(&app, &path)?;
    let p = std::path::Path::new(&path);

    if !p.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    let metadata = std::fs::metadata(p).map_err(|e| format!("获取元数据失败: {}", e))?;

    if metadata.is_dir() {
        // 检查目录是否为空
        if std::fs::read_dir(p)
            .map_err(|e| format!("读取目录失败: {}", e))?
            .next()
            .is_some()
        {
            return Err(format!("目录非空，请先删除内容: {}", path));
        }
        std::fs::remove_dir(p).map_err(|e| format!("删除目录失败: {}", e))?;
    } else {
        std::fs::remove_file(p).map_err(|e| format!("删除文件失败: {}", e))?;
    }

    Ok(format!("已删除: {}", path))
}

/// 移动/重命名文件或目录
#[tauri::command]
pub async fn move_file(
    app: tauri::AppHandle,
    source: String,
    destination: String,
) -> Result<String, String> {
    validate_path_access(&app, &source)?;
    validate_path_access(&app, &destination)?;

    let src = std::path::Path::new(&source);
    if !src.exists() {
        return Err(format!("源路径不存在: {}", source));
    }

    std::fs::rename(src, &destination).map_err(|e| format!("移动失败: {}", e))?;
    Ok(format!("已移动: {} → {}", source, destination))
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
    let ignore_matcher = build_project_ignore_matcher(&root);

    let truncated = collect_search_matches(
        &root,
        &root,
        ignore_matcher.as_ref(),
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
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
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
    let encoded = percent_encoding::utf8_percent_encode(query, percent_encoding::NON_ALPHANUMERIC)
        .to_string();
    let url = format!(
        "https://www.bing.com/search?q={}&count={}",
        encoded, max_results
    );

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
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "q={}",
            percent_encoding::utf8_percent_encode(query, percent_encoding::NON_ALPHANUMERIC)
        ))
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
        let snippet_text = if let Some(snippet_block) = block.split("class='result-snippet'").nth(1)
        {
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
        for block in html
            .split("class=\"result-link\"")
            .chain(html.split("class='result-link'"))
            .skip(1)
            .take(max_results)
        {
            let title_text = block
                .split("</a>")
                .next()
                .map(|s| {
                    let clean = if let Some(pos) = s.rfind('>') {
                        &s[pos + 1..]
                    } else {
                        s
                    };
                    strip_html_tags(clean).trim().to_string()
                })
                .unwrap_or_default();

            // URL could be from uddg redirect or direct
            let link = extract_first_href(block)
                .and_then(|u| decode_search_redirect(&u))
                .unwrap_or_default();

            if !title_text.is_empty() && link.starts_with("http") {
                results.push((title_text, link, String::new()));
                if results.len() >= max_results {
                    break;
                }
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
        Some(
            percent_encoding::percent_decode_str(&encoded[..end])
                .decode_utf8_lossy()
                .to_string(),
        )
    } else if url.starts_with("/url?q=") {
        let cleaned = &url[7..];
        let end = cleaned.find('&').unwrap_or(cleaned.len());
        Some(
            percent_encoding::percent_decode_str(&cleaned[..end])
                .decode_utf8_lossy()
                .to_string(),
        )
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

#[tauri::command]
pub async fn extract_spreadsheet_text(
    file_path: String,
    max_rows: Option<usize>,
) -> Result<String, String> {
    use calamine::{open_workbook_auto, Data, Reader};

    let mut workbook = open_workbook_auto(&file_path).map_err(|e| e.to_string())?;
    let sheet_names = workbook.sheet_names().to_vec();
    let limit = max_rows.unwrap_or(500);
    let mut output = String::new();

    for sheet_name in &sheet_names {
        if let Ok(range) = workbook.worksheet_range(sheet_name) {
            output.push_str(&format!("## Sheet: {}\n", sheet_name));
            for (i, row) in range.rows().enumerate() {
                if i >= limit {
                    output.push_str(&format!("... (截断，共 {} 行)\n", range.height()));
                    break;
                }
                let cells: Vec<String> = row
                    .iter()
                    .map(|c| match c {
                        Data::Empty => String::new(),
                        other => other.to_string(),
                    })
                    .collect();
                output.push_str(&cells.join("\t"));
                output.push('\n');
            }
            output.push('\n');
        }
    }

    Ok(output)
}

// ── Document Text Extraction (PDF, DOCX, PPTX, XMind, FreeMind) ──

#[tauri::command]
pub async fn extract_document_text(path: String) -> Result<String, String> {
    let file_path = std::path::Path::new(&path);
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", path));
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let text = match ext.as_str() {
        "pdf" => extract_pdf_text(&path)?,
        "docx" => extract_docx_text(&path)?,
        "pptx" | "ppt" => extract_pptx_text(&path)?,
        "xmind" => extract_xmind_text(&path)?,
        "mm" => extract_freemind_text(&path)?,
        _ => return Err(format!("不支持的文档格式: .{}", ext)),
    };

    const MAX_CHARS: usize = 200_000;
    if text.len() > MAX_CHARS {
        Ok(format!(
            "{}...\n\n(文档内容已截断，共约 {} 字符)",
            &text[..MAX_CHARS],
            text.len()
        ))
    } else {
        Ok(text)
    }
}

fn extract_pdf_text(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取 PDF 失败: {}", e))?;
    pdf_extract::extract_text_from_mem(&bytes).map_err(|e| format!("解析 PDF 失败: {}", e))
}

fn extract_docx_text(path: &str) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader as XmlReader;

    let file = std::fs::File::open(path).map_err(|e| format!("打开 DOCX 失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压 DOCX 失败: {}", e))?;

    let doc_xml = archive
        .by_name("word/document.xml")
        .map_err(|_| "DOCX 中未找到 word/document.xml".to_string())?;

    let mut reader = XmlReader::from_reader(std::io::BufReader::new(doc_xml));
    reader.config_mut().trim_text(true);

    let mut result = String::new();
    let mut buf = Vec::new();
    let mut in_paragraph = false;
    let mut paragraph_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                if e.local_name().as_ref() == b"p" {
                    in_paragraph = true;
                    paragraph_text.clear();
                }
            }
            Ok(Event::Text(ref e)) => {
                if in_paragraph {
                    if let Ok(t) = e.unescape() {
                        paragraph_text.push_str(&t);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if e.local_name().as_ref() == b"p" && in_paragraph {
                    in_paragraph = false;
                    let trimmed = paragraph_text.trim();
                    if !trimmed.is_empty() {
                        result.push_str(trimmed);
                        result.push('\n');
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("解析 DOCX XML 失败: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    Ok(result)
}

fn extract_pptx_text(path: &str) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader as XmlReader;

    let file = std::fs::File::open(path).map_err(|e| format!("打开 PPTX 失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压 PPTX 失败: {}", e))?;

    let slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let name = archive.by_index(i).ok()?.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    let mut sorted_slides = slide_names;
    sorted_slides.sort_by(|a, b| {
        let num_a = a
            .trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0);
        let num_b = b
            .trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0);
        num_a.cmp(&num_b)
    });

    let mut result = String::new();

    for (idx, slide_name) in sorted_slides.iter().enumerate() {
        let slide_file = archive
            .by_name(slide_name)
            .map_err(|e| format!("读取幻灯片失败: {}", e))?;
        let mut reader = XmlReader::from_reader(std::io::BufReader::new(slide_file));
        reader.config_mut().trim_text(true);

        let mut buf = Vec::new();
        let mut slide_texts: Vec<String> = Vec::new();
        let mut current_text = String::new();
        let mut in_text = false;

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) => {
                    if e.local_name().as_ref() == b"t" {
                        in_text = true;
                        current_text.clear();
                    }
                }
                Ok(Event::Text(ref e)) => {
                    if in_text {
                        if let Ok(t) = e.unescape() {
                            current_text.push_str(&t);
                        }
                    }
                }
                Ok(Event::End(ref e)) => {
                    if e.local_name().as_ref() == b"t" && in_text {
                        in_text = false;
                        let trimmed = current_text.trim().to_string();
                        if !trimmed.is_empty() {
                            slide_texts.push(trimmed);
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Err(_) => break,
                _ => {}
            }
            buf.clear();
        }

        if !slide_texts.is_empty() {
            result.push_str(&format!("## Slide {}\n", idx + 1));
            result.push_str(&slide_texts.join("\n"));
            result.push_str("\n\n");
        }
    }

    if result.is_empty() {
        return Err("PPTX 中未提取到文本内容".to_string());
    }
    Ok(result)
}

fn extract_xmind_text(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开 XMind 失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压 XMind 失败: {}", e))?;

    if let Ok(mut entry) = archive.by_name("content.json") {
        let mut content = String::new();
        std::io::Read::read_to_string(&mut entry, &mut content)
            .map_err(|e| format!("读取 content.json 失败: {}", e))?;

        let json: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| format!("解析 content.json 失败: {}", e))?;

        let mut result = String::new();
        if let Some(sheets) = json.as_array() {
            for (i, sheet) in sheets.iter().enumerate() {
                let title = sheet
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("Sheet");
                result.push_str(&format!("## {}\n", title));
                if let Some(root) = sheet.get("rootTopic") {
                    xmind_topic_to_text(root, 0, &mut result);
                }
                if i < sheets.len() - 1 {
                    result.push('\n');
                }
            }
        } else if let Some(root) = json.get("rootTopic") {
            xmind_topic_to_text(root, 0, &mut result);
        }
        return Ok(result);
    }

    if let Ok(mut entry) = archive.by_name("content.xml") {
        let mut content = String::new();
        std::io::Read::read_to_string(&mut entry, &mut content)
            .map_err(|e| format!("读取 content.xml 失败: {}", e))?;
        return extract_xmind_xml(&content);
    }

    Err("XMind 文件中未找到 content.json 或 content.xml".to_string())
}

fn xmind_topic_to_text(topic: &serde_json::Value, depth: usize, out: &mut String) {
    let indent = "  ".repeat(depth);
    let marker = if depth == 0 { "" } else { "- " };
    if let Some(title) = topic.get("title").and_then(|t| t.as_str()) {
        out.push_str(&format!("{}{}{}\n", indent, marker, title));
    }
    if let Some(children) = topic
        .get("children")
        .and_then(|c| c.get("attached"))
        .and_then(|a| a.as_array())
    {
        for child in children {
            xmind_topic_to_text(child, depth + 1, out);
        }
    }
    if let Some(topics) = topic
        .get("children")
        .and_then(|c| c.get("topics"))
        .and_then(|t| t.as_array())
    {
        for child in topics {
            xmind_topic_to_text(child, depth + 1, out);
        }
    }
}

fn extract_xmind_xml(content: &str) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader as XmlReader;

    let mut reader = XmlReader::from_str(content);
    reader.config_mut().trim_text(true);

    let mut result = String::new();
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                if e.local_name().as_ref() == b"topic" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"title" || attr.key.as_ref() == b"text" {
                            if let Ok(val) = attr.unescape_value() {
                                result.push_str(&val);
                                result.push('\n');
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("解析 XMind XML 失败: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    Ok(result)
}

fn extract_freemind_text(path: &str) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader as XmlReader;

    let content =
        std::fs::read_to_string(path).map_err(|e| format!("读取 FreeMind 文件失败: {}", e))?;
    let mut reader = XmlReader::from_str(&content);
    reader.config_mut().trim_text(true);

    let mut result = String::new();
    let mut buf = Vec::new();
    let mut depth: i32 = -1;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                if e.local_name().as_ref() == b"node" {
                    depth += 1;
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"TEXT" {
                            if let Ok(val) = attr.unescape_value() {
                                let indent = "  ".repeat(depth.max(0) as usize);
                                let marker = if depth == 0 { "" } else { "- " };
                                result.push_str(&format!("{}{}{}\n", indent, marker, val));
                            }
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if e.local_name().as_ref() == b"node" {
                    depth -= 1;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("解析 FreeMind XML 失败: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    Ok(result)
}

// ── Excel Export (write .xlsx from JSON data) ──

#[derive(serde::Deserialize)]
struct SheetData {
    name: Option<String>,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

#[tauri::command]
pub async fn export_spreadsheet(
    output_path: String,
    sheets_json: String,
) -> Result<String, String> {
    use rust_xlsxwriter::{Format, Workbook};

    let sheets: Vec<SheetData> =
        serde_json::from_str(&sheets_json).map_err(|e| format!("解析表格数据失败: {}", e))?;

    if sheets.is_empty() {
        return Err("至少需要一个工作表".to_string());
    }

    let mut workbook = Workbook::new();
    let header_format = Format::new().set_bold();

    for (i, sheet) in sheets.iter().enumerate() {
        let default_name = format!("Sheet{}", i + 1);
        let sheet_name = sheet.name.as_deref().unwrap_or(&default_name);

        let worksheet = workbook.add_worksheet();
        worksheet
            .set_name(sheet_name)
            .map_err(|e| format!("设置工作表名称失败: {}", e))?;

        for (col, header) in sheet.headers.iter().enumerate() {
            worksheet
                .write_string_with_format(0, col as u16, header, &header_format)
                .map_err(|e| format!("写入表头失败: {}", e))?;
        }

        for (row_idx, row) in sheet.rows.iter().enumerate() {
            for (col_idx, cell) in row.iter().enumerate() {
                if let Ok(num) = cell.parse::<f64>() {
                    worksheet
                        .write_number((row_idx + 1) as u32, col_idx as u16, num)
                        .map_err(|e| format!("写入数字失败: {}", e))?;
                } else {
                    worksheet
                        .write_string((row_idx + 1) as u32, col_idx as u16, cell)
                        .map_err(|e| format!("写入文本失败: {}", e))?;
                }
            }
        }

        for (col, header) in sheet.headers.iter().enumerate() {
            let mut max_len = header.len();
            for row in &sheet.rows {
                if let Some(cell) = row.get(col) {
                    max_len = max_len.max(cell.len());
                }
            }
            let width = (max_len as f64 * 1.2).min(60.0).max(8.0);
            let _ = worksheet.set_column_width(col as u16, width);
        }
    }

    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    workbook
        .save(&output_path)
        .map_err(|e| format!("保存 Excel 失败: {}", e))?;

    let abs_path = std::fs::canonicalize(&output_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&output_path));

    Ok(abs_path.display().to_string())
}
