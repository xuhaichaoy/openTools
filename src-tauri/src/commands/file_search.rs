use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileSearchResult {
    /// 文件名
    pub name: String,
    /// 完整路径
    pub path: String,
    /// 是否为目录
    pub is_dir: bool,
    /// 文件大小（字节），目录为 0
    pub size: u64,
    /// 最后修改时间（ISO 8601）
    pub modified: Option<String>,
    /// 文件类型标签（用于前端选择图标）
    pub file_type: String,
}

/// 根据文件扩展名推断类型标签
fn classify_file(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        // 图片
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "tiff" => "image",
        // 视频
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "flv" => "video",
        // 音频
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" => "audio",
        // 文档
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "pages" | "numbers" | "key" => {
            "document"
        }
        // 代码
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "c" | "cpp" | "h" | "swift"
        | "kt" | "rb" | "php" | "vue" | "svelte" => "code",
        // 文本
        "txt" | "md" | "log" | "csv" | "json" | "xml" | "yaml" | "yml" | "toml" | "ini" | "cfg" => {
            "text"
        }
        // 压缩包
        "zip" | "tar" | "gz" | "7z" | "rar" | "bz2" | "xz" | "dmg" | "iso" => "archive",
        // 可执行
        "app" | "exe" | "msi" | "sh" | "bat" | "cmd" => "executable",
        // 其他
        _ => "file",
    }
    .to_string()
}

/// 获取文件元数据（大小、修改时间）
fn get_file_metadata(path_str: &str) -> (u64, Option<String>, bool) {
    let path = Path::new(path_str);
    match std::fs::metadata(path) {
        Ok(meta) => {
            let is_dir = meta.is_dir();
            let size = if is_dir { 0 } else { meta.len() };
            let modified = meta.modified().ok().map(|t| {
                let datetime: chrono::DateTime<chrono::Local> = t.into();
                datetime.format("%Y-%m-%d %H:%M").to_string()
            });
            (size, modified, is_dir)
        }
        Err(_) => (0, None, false),
    }
}

/// 将路径转为搜索结果
fn path_to_result(path_str: &str) -> FileSearchResult {
    let path = Path::new(path_str);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path_str)
        .to_string();
    let (size, modified, is_dir) = get_file_metadata(path_str);
    let file_type = if is_dir {
        "folder".to_string()
    } else {
        classify_file(path_str)
    };

    FileSearchResult {
        name,
        path: path_str.to_string(),
        is_dir,
        size,
        modified,
        file_type,
    }
}

/// macOS: 使用 mdfind (Spotlight) 搜索
#[cfg(target_os = "macos")]
fn platform_search(
    query: &str,
    max_results: usize,
    file_types: &Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let mut mdfind_query = format!("kMDItemDisplayName == '*{}*'c", query);

    // 按文件类型过滤
    if let Some(types) = file_types {
        let type_conditions: Vec<String> = types
            .iter()
            .map(|t| match t.as_str() {
                "image" => "kMDItemContentTypeTree == 'public.image'".to_string(),
                "video" => "kMDItemContentTypeTree == 'public.movie'".to_string(),
                "audio" => "kMDItemContentTypeTree == 'public.audio'".to_string(),
                "document" => "(kMDItemContentTypeTree == 'public.composite-content' || kMDItemContentTypeTree == 'com.adobe.pdf')".to_string(),
                "code" => "kMDItemContentTypeTree == 'public.source-code'".to_string(),
                "folder" => "kMDItemContentTypeTree == 'public.folder'".to_string(),
                _ => format!("kMDItemFSName == '*.{}'c", t),
            })
            .collect();
        if !type_conditions.is_empty() {
            mdfind_query = format!("({}) && ({})", mdfind_query, type_conditions.join(" || "));
        }
    }

    let output = Command::new("mdfind")
        .arg("-limit")
        .arg(max_results.to_string())
        .arg(&mdfind_query)
        .output()
        .map_err(|e| format!("mdfind 执行失败: {}", e))?;

    if !output.status.success() {
        // mdfind 失败时降级为 find 命令
        return fallback_search(query, max_results);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<String> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(|s| s.to_string())
        .collect();

    Ok(paths)
}

/// Windows: 使用 where 命令或 dir 搜索
#[cfg(target_os = "windows")]
fn platform_search(
    query: &str,
    max_results: usize,
    _file_types: &Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    // 尝试使用 PowerShell 搜索常用目录
    let search_dirs = get_search_directories();
    let dirs_str = search_dirs
        .iter()
        .map(|d| format!("'{}'", d))
        .collect::<Vec<_>>()
        .join(",");

    let ps_script = format!(
        "Get-ChildItem -Path {} -Recurse -ErrorAction SilentlyContinue -Filter '*{}*' | Select-Object -First {} -ExpandProperty FullName",
        dirs_str, query, max_results
    );

    let output = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(&ps_script)
        .output()
        .map_err(|e| format!("PowerShell 搜索失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<String> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .map(|s| s.to_string())
        .collect();

    Ok(paths)
}

/// Linux: 使用 locate 或 find 搜索
#[cfg(target_os = "linux")]
fn platform_search(
    query: &str,
    max_results: usize,
    _file_types: &Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    // 先尝试 locate（快速，使用索引）
    let output = Command::new("locate")
        .arg("-i") // 忽略大小写
        .arg("-l")
        .arg(max_results.to_string())
        .arg(query)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let paths: Vec<String> = stdout
                .lines()
                .filter(|line| !line.is_empty())
                .map(|s| s.to_string())
                .collect();
            Ok(paths)
        }
        _ => fallback_search(query, max_results),
    }
}

/// 降级搜索：使用 find 命令搜索常用目录
fn fallback_search(query: &str, max_results: usize) -> Result<Vec<String>, String> {
    let search_dirs = get_search_directories();
    let mut all_results = Vec::new();

    for dir in &search_dirs {
        if all_results.len() >= max_results {
            break;
        }
        let remaining = max_results - all_results.len();

        let output = Command::new("find")
            .arg(dir)
            .arg("-maxdepth")
            .arg("4")
            .arg("-iname")
            .arg(format!("*{}*", query))
            .arg("-not")
            .arg("-path")
            .arg("*/.*") // 排除隐藏文件/目录
            .arg("-not")
            .arg("-path")
            .arg("*/node_modules/*")
            .arg("-not")
            .arg("-path")
            .arg("*/target/*")
            .output();

        if let Ok(o) = output {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let paths: Vec<String> = stdout
                .lines()
                .filter(|line| !line.is_empty())
                .take(remaining)
                .map(|s| s.to_string())
                .collect();
            all_results.extend(paths);
        }
    }

    Ok(all_results)
}

/// 获取默认搜索目录
fn get_search_directories() -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let home_str = home.display().to_string();
        dirs.push(format!("{}/Desktop", home_str));
        dirs.push(format!("{}/Documents", home_str));
        dirs.push(format!("{}/Downloads", home_str));
        dirs.push(home_str);
    }
    dirs
}

/// 搜索本地文件
#[tauri::command]
pub async fn file_search(
    query: String,
    max_results: Option<usize>,
    file_types: Option<Vec<String>>,
) -> Result<Vec<FileSearchResult>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let max = max_results.unwrap_or(20).min(50);

    // 使用平台特定搜索
    let paths = platform_search(&query, max, &file_types)?;

    // 转换为结果结构
    let results: Vec<FileSearchResult> = paths
        .into_iter()
        .filter(|p| Path::new(p).exists()) // 过滤不存在的路径
        .map(|p| path_to_result(&p))
        .collect();

    Ok(results)
}

// ── 本地应用搜索 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSearchResult {
    /// 应用显示名称
    pub name: String,
    /// 应用完整路径
    pub path: String,
}

/// macOS: 使用 mdfind 搜索应用程序
#[cfg(target_os = "macos")]
fn platform_app_search(query: &str, max_results: usize) -> Result<Vec<AppSearchResult>, String> {
    let mdfind_query = format!(
        "kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '*{}*'c",
        query
    );

    let output = Command::new("mdfind")
        .arg("-limit")
        .arg(max_results.to_string())
        .arg(&mdfind_query)
        .output()
        .map_err(|e| format!("mdfind 执行失败: {}", e))?;

    if !output.status.success() {
        return fallback_app_search_macos(query, max_results);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let results: Vec<AppSearchResult> = stdout
        .lines()
        .filter(|line| !line.is_empty() && line.ends_with(".app"))
        .map(|line| {
            let path = Path::new(line);
            let name = path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            AppSearchResult {
                name,
                path: line.to_string(),
            }
        })
        .collect();

    Ok(results)
}

/// macOS 降级：直接扫描 /Applications 目录
#[cfg(target_os = "macos")]
fn fallback_app_search_macos(
    query: &str,
    max_results: usize,
) -> Result<Vec<AppSearchResult>, String> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    let dirs = ["/Applications", "/System/Applications"];

    for dir in &dirs {
        if results.len() >= max_results {
            break;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if results.len() >= max_results {
                    break;
                }
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    if ext == "app" {
                        let name = path
                            .file_stem()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string();
                        if name.to_lowercase().contains(&query_lower) {
                            results.push(AppSearchResult {
                                name,
                                path: path.display().to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    // 也搜索 ~/Applications
    if let Some(home) = dirs::home_dir() {
        let user_apps = home.join("Applications");
        if user_apps.exists() {
            if let Ok(entries) = std::fs::read_dir(&user_apps) {
                for entry in entries.flatten() {
                    if results.len() >= max_results {
                        break;
                    }
                    let path = entry.path();
                    if let Some(ext) = path.extension() {
                        if ext == "app" {
                            let name = path
                                .file_stem()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                            if name.to_lowercase().contains(&query_lower) {
                                results.push(AppSearchResult {
                                    name,
                                    path: path.display().to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(results)
}

/// Windows: 搜索已安装应用（开始菜单快捷方式 + Program Files）
#[cfg(target_os = "windows")]
fn platform_app_search(query: &str, max_results: usize) -> Result<Vec<AppSearchResult>, String> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // 搜索开始菜单快捷方式
    let start_menu_dirs: Vec<String> =
        vec![r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs".to_string()];
    let user_start = if let Some(home) = dirs::home_dir() {
        Some(format!(
            "{}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
            home.display()
        ))
    } else {
        None
    };
    let all_dirs: Vec<&str> = start_menu_dirs
        .iter()
        .map(|s| s.as_str())
        .chain(user_start.iter().map(|s| s.as_str()))
        .collect();

    for dir in all_dirs {
        if results.len() >= max_results {
            break;
        }
        scan_lnk_files(dir, &query_lower, max_results, &mut results, &mut seen);
    }

    Ok(results)
}

#[cfg(target_os = "windows")]
fn scan_lnk_files(
    dir: &str,
    query_lower: &str,
    max_results: usize,
    results: &mut Vec<AppSearchResult>,
    seen: &mut std::collections::HashSet<String>,
) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if results.len() >= max_results {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                scan_lnk_files(
                    &path.display().to_string(),
                    query_lower,
                    max_results,
                    results,
                    seen,
                );
            } else if let Some(ext) = path.extension() {
                if ext == "lnk" {
                    let name = path
                        .file_stem()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    if name.to_lowercase().contains(query_lower)
                        && !seen.contains(&name.to_lowercase())
                    {
                        seen.insert(name.to_lowercase());
                        results.push(AppSearchResult {
                            name,
                            path: path.display().to_string(),
                        });
                    }
                }
            }
        }
    }
}

/// Linux: 搜索 .desktop 文件
#[cfg(target_os = "linux")]
fn platform_app_search(query: &str, max_results: usize) -> Result<Vec<AppSearchResult>, String> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let desktop_dirs = vec![
        "/usr/share/applications".to_string(),
        "/usr/local/share/applications".to_string(),
    ];
    let user_desktop = if let Some(home) = dirs::home_dir() {
        Some(format!("{}/.local/share/applications", home.display()))
    } else {
        None
    };

    let all_dirs: Vec<&str> = desktop_dirs
        .iter()
        .map(|s| s.as_str())
        .chain(user_desktop.iter().map(|s| s.as_str()))
        .collect();

    for dir in all_dirs {
        if results.len() >= max_results {
            break;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if results.len() >= max_results {
                    break;
                }
                let path = entry.path();
                if let Some(ext) = path.extension() {
                    if ext == "desktop" {
                        if let Ok(content) = std::fs::read_to_string(&path) {
                            let name = content
                                .lines()
                                .find(|l| l.starts_with("Name="))
                                .map(|l| l.trim_start_matches("Name=").to_string())
                                .unwrap_or_default();
                            let exec = content
                                .lines()
                                .find(|l| l.starts_with("Exec="))
                                .map(|l| l.trim_start_matches("Exec=").to_string())
                                .unwrap_or_default();
                            // 检查是否隐藏
                            let no_display = content.lines().any(|l| l.trim() == "NoDisplay=true");
                            if !no_display
                                && !name.is_empty()
                                && name.to_lowercase().contains(&query_lower)
                                && !seen.contains(&name.to_lowercase())
                            {
                                seen.insert(name.to_lowercase());
                                results.push(AppSearchResult {
                                    name,
                                    path: if exec.is_empty() {
                                        path.display().to_string()
                                    } else {
                                        exec.split_whitespace().next().unwrap_or("").to_string()
                                    },
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(results)
}

/// 搜索本地已安装应用
#[tauri::command]
pub async fn app_search(
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<AppSearchResult>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let max = max_results.unwrap_or(10).min(30);
    platform_app_search(&query, max)
}

/// 使用系统默认程序打开文件
#[tauri::command]
pub async fn file_open(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("打开失败: {}", e))
}

/// 在文件管理器中显示文件
#[tauri::command]
pub async fn file_show_in_folder(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    let folder = if file_path.is_dir() {
        file_path
    } else {
        file_path.parent().unwrap_or(file_path)
    };

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(folder.display().to_string())
            .spawn()
            .map_err(|e| format!("打开文件管理器失败: {}", e))?;
    }

    let _ = folder; // suppress unused warning on non-Linux
    Ok(())
}
