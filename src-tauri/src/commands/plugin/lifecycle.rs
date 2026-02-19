//! 插件生命周期 — 扫描、缓存、启用/禁用、持久化、开发态监听

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager};
use zip::ZipArchive;

use super::api_bridge::plugin_open;
use super::types::{
    PluginCache, PluginDevState, PluginDevTraceItem, PluginDevWatchStatus, PluginInfo,
    PluginManifest,
};

// ── 插件扫描 ──

const MAX_PLUGIN_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PluginSource {
    Community,
    Official,
    Dev,
}

impl PluginSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Community => "community",
            Self::Official => "official",
            Self::Dev => "dev",
        }
    }
}

#[derive(Clone, Debug)]
struct ScanRoot {
    path: PathBuf,
    source: PluginSource,
}

pub(super) fn get_plugins_dir(app: &AppHandle) -> PathBuf {
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let plugins_dir = resource_dir.join("plugins");
    if plugins_dir.exists() {
        return plugins_dir;
    }
    std::env::current_dir().unwrap_or_default().join("plugins")
}

pub(super) fn get_official_plugins_dir(app: &AppHandle) -> PathBuf {
    let app_data_dir = app.path().app_data_dir().unwrap_or_default();
    app_data_dir.join("plugins").join("official")
}

fn is_developer_mode_enabled(app: &AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;

    let store = match app.store("config.json") {
        Ok(store) => store,
        Err(_) => return false,
    };

    let raw = match store
        .get("general_settings")
        .and_then(|v| v.as_str().map(|s| s.to_string()))
    {
        Some(v) if !v.trim().is_empty() => v,
        _ => return false,
    };

    let parsed = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v,
        Err(_) => return false,
    };

    parsed
        .get("developerMode")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn resolve_local_official_plugin_source(app: &AppHandle, slug: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("official-plugins").join(slug));
        candidates.push(resource_dir.join("plugins").join("official").join(slug));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("official-plugins").join(slug));
        candidates.push(cwd.join("src-tauri").join("official-plugins").join(slug));
        candidates.push(cwd.join("plugins").join("official").join(slug));
    }

    candidates
        .into_iter()
        .find(|path| path.is_dir() && contains_manifest(path))
}

pub(super) fn scan_plugin_dir(dir: &PathBuf) -> Option<(PluginManifest, String)> {
    let plugin_json = dir.join("plugin.json");
    if plugin_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&plugin_json) {
            if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                return Some((manifest, "plugin.json".to_string()));
            }
        }
    }

    let package_json = dir.join("package.json");
    if package_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&package_json) {
            if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                if !manifest.features.is_empty() {
                    return Some((manifest, "package.json".to_string()));
                }
            }
        }
    }

    None
}

fn make_plugin_id(
    dir: &PathBuf,
    manifest: &PluginManifest,
    source: PluginSource,
    slug: Option<&str>,
) -> String {
    if matches!(source, PluginSource::Official) {
        if let Some(s) = slug {
            let normalized = s.trim().to_lowercase().replace(' ', "-");
            if !normalized.is_empty() {
                return normalized;
            }
        }
    }

    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let name_part = manifest
        .plugin_name
        .to_lowercase()
        .replace(' ', "-")
        .replace(['/', '\\', '.'], "");
    if dir_name.is_empty() || dir_name == name_part {
        name_part
    } else {
        format!("{}-{}", dir_name, name_part)
    }
}

fn default_data_profile_for_slug(slug: &str) -> String {
    match slug {
        "snippets" => "snippets".to_string(),
        "bookmarks" => "bookmarks".to_string(),
        "note-hub" => "note_hub".to_string(),
        _ => "none".to_string(),
    }
}

fn resolve_data_profile(manifest: &PluginManifest, slug: Option<&str>) -> String {
    if let Some(profile) = manifest
        .mtools
        .as_ref()
        .and_then(|m| m.data_profile.as_ref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return profile;
    }
    if let Some(s) = slug {
        return default_data_profile_for_slug(s);
    }
    "none".to_string()
}

fn build_plugin_info(
    path: &PathBuf,
    manifest: PluginManifest,
    source: PluginSource,
    disabled_ids: &HashSet<String>,
) -> PluginInfo {
    let dir_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let slug = if matches!(source, PluginSource::Official) {
        Some(dir_name.to_lowercase())
    } else {
        None
    };
    let is_builtin = !matches!(source, PluginSource::Official) && dir_name.starts_with("builtin-");
    let id = make_plugin_id(path, &manifest, source, slug.as_deref());
    let data_profile = resolve_data_profile(&manifest, slug.as_deref());

    PluginInfo {
        enabled: !disabled_ids.contains(&id),
        id,
        manifest,
        dir_path: path.to_string_lossy().to_string(),
        is_builtin,
        source: if is_builtin {
            "builtin".to_string()
        } else {
            source.as_str().to_string()
        },
        slug,
        is_official: matches!(source, PluginSource::Official),
        data_profile,
    }
}

fn scan_dirs(roots: &[ScanRoot], disabled_ids: &HashSet<String>) -> Vec<PluginInfo> {
    let mut plugins = Vec::new();
    let mut seen_ids = HashSet::new();

    for root in roots {
        let base_dir = &root.path;
        if !base_dir.exists() {
            continue;
        }

        if let Some((manifest, _)) = scan_plugin_dir(base_dir) {
            let plugin = build_plugin_info(base_dir, manifest, root.source, disabled_ids);
            let id = plugin.id.clone();
            if seen_ids.insert(id.clone()) {
                plugins.push(plugin);
            }
            continue;
        }

        if let Ok(entries) = std::fs::read_dir(base_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                if let Some((manifest, _)) = scan_plugin_dir(&path) {
                    let plugin = build_plugin_info(&path, manifest, root.source, disabled_ids);
                    let id = plugin.id.clone();
                    if seen_ids.insert(id.clone()) {
                        plugins.push(plugin);
                    }
                }
            }
        }
    }

    plugins
}

// ── 缓存管理 ──

pub(super) fn refresh_plugin_cache(app: &AppHandle) -> Vec<PluginInfo> {
    let cache = app.state::<Mutex<PluginCache>>();
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());

    if cache.dev_dirs.is_empty() && cache.plugins.is_empty() {
        use tauri_plugin_store::StoreExt;
        if let Ok(store) = app.store("plugin-settings.json") {
            if let Some(dirs) = store.get("devDirs") {
                if let Some(arr) = dirs.as_array() {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            cache.dev_dirs.insert(s.to_string());
                        }
                    }
                }
            }
            if let Some(disabled) = store.get("disabledIds") {
                if let Some(arr) = disabled.as_array() {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            cache.disabled_ids.insert(s.to_string());
                        }
                    }
                }
            }
        }
    }

    let mut roots = vec![
        ScanRoot {
            path: get_plugins_dir(app),
            source: PluginSource::Community,
        },
        ScanRoot {
            path: get_official_plugins_dir(app),
            source: PluginSource::Official,
        },
    ];
    for dev_dir in &cache.dev_dirs {
        roots.push(ScanRoot {
            path: PathBuf::from(dev_dir),
            source: PluginSource::Dev,
        });
    }

    cache.plugins = scan_dirs(&roots, &cache.disabled_ids);
    cache.plugins.clone()
}

pub(super) fn get_cached_plugins(app: &AppHandle) -> Vec<PluginInfo> {
    let cache = app.state::<Mutex<PluginCache>>();
    let cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    if cache.plugins.is_empty() {
        drop(cache);
        return refresh_plugin_cache(app);
    }
    cache.plugins.clone()
}

pub(super) fn persist_plugin_settings(app: &AppHandle, cache: &PluginCache) {
    use tauri_plugin_store::StoreExt;
    if let Ok(store) = app.store("plugin-settings.json") {
        let dirs_vec: Vec<&String> = cache.dev_dirs.iter().collect();
        store.set(
            "devDirs",
            serde_json::to_value(&dirs_vec).unwrap_or_default(),
        );
        let disabled_vec: Vec<&String> = cache.disabled_ids.iter().collect();
        store.set(
            "disabledIds",
            serde_json::to_value(&disabled_vec).unwrap_or_default(),
        );
    }
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn modified_ms(path: &Path) -> Option<u128> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_millis())
}

fn collect_file_snapshot(paths: &[PathBuf]) -> HashMap<String, u128> {
    fn collect_one(path: &Path, snapshot: &mut HashMap<String, u128>) {
        if !path.exists() {
            return;
        }
        if path.is_file() {
            if let Some(ms) = modified_ms(path) {
                let key = path
                    .canonicalize()
                    .unwrap_or_else(|_| path.to_path_buf())
                    .to_string_lossy()
                    .to_string();
                snapshot.insert(normalize_path(&key), ms);
            }
            return;
        }
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                collect_one(&entry.path(), snapshot);
            }
        }
    }

    let mut snapshot = HashMap::new();
    for root in paths {
        collect_one(root, &mut snapshot);
    }
    snapshot
}

fn diff_snapshots(prev: &HashMap<String, u128>, next: &HashMap<String, u128>) -> Vec<String> {
    let mut changed = Vec::new();
    for (path, modified) in next {
        if prev.get(path) != Some(modified) {
            changed.push(path.clone());
        }
    }
    for path in prev.keys() {
        if !next.contains_key(path) {
            changed.push(path.clone());
        }
    }
    changed.sort();
    changed.dedup();
    changed
}

fn validate_manifest_file(path: &str) -> Option<String> {
    let p = Path::new(path);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name != "plugin.json" && name != "package.json" {
        return None;
    }

    let content = match std::fs::read_to_string(p) {
        Ok(c) => c,
        Err(e) => return Some(format!("读取清单失败: {}", e)),
    };
    match serde_json::from_str::<PluginManifest>(&content) {
        Ok(manifest) => {
            if name == "package.json" && manifest.features.is_empty() {
                return Some("Rubick package.json 缺少 features".to_string());
            }
            None
        }
        Err(e) => Some(format!("清单解析失败: {}", e)),
    }
}

fn path_is_within(path: &str, root: &str) -> bool {
    let p = normalize_path(path);
    let r = normalize_path(root);
    p == r || p.starts_with(&(r + "/"))
}

fn resolve_changed_plugin_ids(
    app: &AppHandle,
    changed_paths: &[String],
    plugin_filter: &Option<String>,
) -> HashSet<String> {
    let plugins = get_cached_plugins(app);
    let mut changed_ids = HashSet::new();

    for plugin in plugins {
        if let Some(target_id) = plugin_filter {
            if &plugin.id != target_id {
                continue;
            }
        }
        let dir = normalize_path(&plugin.dir_path);
        let hit = changed_paths.iter().any(|path| path_is_within(path, &dir));
        if hit {
            changed_ids.insert(plugin.id.clone());
        }
    }
    changed_ids
}

async fn reload_plugin_windows(app: AppHandle, plugin_id: &str) {
    let prefix = format!("plugin-{}-", plugin_id);
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(&prefix))
        .cloned()
        .collect();

    for label in labels {
        let mut should_reopen = false;
        if let Some(window) = app.get_webview_window(&label) {
            if window.eval("window.location.reload()").is_err() {
                should_reopen = true;
                let _ = window.close();
            }
        }

        if should_reopen {
            let feature_code = label.strip_prefix(&prefix).unwrap_or("").to_string();
            if !feature_code.is_empty() {
                let _ = plugin_open(app.clone(), plugin_id.to_string(), feature_code).await;
            }
        }
    }
}

fn set_watch_status(
    app: &AppHandle,
    updater: impl FnOnce(&mut PluginDevWatchStatus),
) -> PluginDevWatchStatus {
    let state = app.state::<Mutex<PluginDevState>>();
    let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
    updater(&mut state.watch_status);
    state.watch_status.clone()
}

pub(super) fn push_dev_trace(app: &AppHandle, item: PluginDevTraceItem) {
    let state = app.state::<Mutex<PluginDevState>>();
    let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
    state.trace_buffer.push_back(item);
    while state.trace_buffer.len() > state.trace_limit {
        state.trace_buffer.pop_front();
    }
}

fn stop_dev_watcher(app: &AppHandle) -> PluginDevWatchStatus {
    {
        let state = app.state::<Mutex<PluginDevState>>();
        let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut runtime) = state.watcher.take() {
            if let Some(tx) = runtime.stop_tx.take() {
                let _ = tx.send(());
            }
            if let Some(task) = runtime.task.take() {
                task.abort();
            }
        }
        state.watch_status.running = false;
    }
    set_watch_status(app, |_| {})
}

fn ensure_safe_relative_path(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn contains_manifest(path: &Path) -> bool {
    path.join("plugin.json").exists() || path.join("package.json").exists()
}

fn resolve_extracted_plugin_root(staging_dir: &Path) -> Result<PathBuf, String> {
    if contains_manifest(staging_dir) {
        return Ok(staging_dir.to_path_buf());
    }

    let mut candidates = Vec::new();
    let entries = std::fs::read_dir(staging_dir).map_err(|e| format!("读取解压目录失败: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && contains_manifest(&path) {
            candidates.push(path);
        }
    }

    if candidates.len() == 1 {
        return Ok(candidates.remove(0));
    }

    Err("插件包缺少 plugin.json/package.json，或包含多个候选根目录".to_string())
}

fn extract_zip_safely(zip_bytes: &[u8], target_dir: &Path) -> Result<(), String> {
    let reader = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("无法打开 zip: {}", e))?;

    let mut total_uncompressed: u64 = 0;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| format!("读取 zip 条目失败: {}", e))?;
        let enclosed = file
            .enclosed_name()
            .map(PathBuf::from)
            .ok_or_else(|| "插件包包含非法路径（路径穿越）".to_string())?;
        if !ensure_safe_relative_path(&enclosed) {
            return Err("插件包包含非法路径（路径穿越）".to_string());
        }

        total_uncompressed = total_uncompressed.saturating_add(file.size());
        if total_uncompressed > 200 * 1024 * 1024 {
            return Err("插件包解压后体积超过安全限制（200MB）".to_string());
        }

        let out_path = target_dir.join(&enclosed);
        if file.name().ends_with('/') {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {}", e))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
        }
        let mut out_file = File::create(&out_path).map_err(|e| format!("写入文件失败: {}", e))?;
        std::io::copy(&mut file, &mut out_file).map_err(|e| format!("解压文件失败: {}", e))?;
    }

    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| format!("删除目录失败: {}", e))
    } else {
        std::fs::remove_file(path).map_err(|e| format!("删除文件失败: {}", e))
    }
}

fn path_within(path: &Path, root: &Path) -> bool {
    let normalized_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let normalized_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    normalized_path.starts_with(normalized_root)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() || !source.is_dir() {
        return Err(format!(
            "复制目录失败：源目录不存在或不是目录 ({})",
            source.display()
        ));
    }

    std::fs::create_dir_all(target).map_err(|e| format!("创建目录失败: {}", e))?;

    let entries = std::fs::read_dir(source).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries.flatten() {
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {}", e))?;

        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
            }
            std::fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "复制文件失败: {} -> {} ({})",
                    source_path.display(),
                    target_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

async fn download_plugin_package(
    download_url: &str,
    expected_size: u64,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::new();
    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("下载插件包失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "下载插件包失败: HTTP {}",
            response.status().as_u16()
        ));
    }

    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取下载数据失败: {}", e))?;
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_PLUGIN_PACKAGE_BYTES {
            return Err(format!("插件包超过 50MB 限制（{} bytes）", bytes.len()));
        }
    }

    if expected_size > 0 && bytes.len() as u64 != expected_size {
        return Err(format!(
            "插件包大小不匹配: expected={}, actual={}",
            expected_size,
            bytes.len()
        ));
    }

    Ok(bytes)
}

fn verify_package_sha256(bytes: &[u8], expected_sha256: &str) -> Result<(), String> {
    let expected = expected_sha256.trim().to_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("无效的 SHA256 校验值".to_string());
    }

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(format!(
            "PLUGIN_PACKAGE_INTEGRITY_FAILED: sha256 mismatch, expected={}, actual={}",
            expected, actual
        ));
    }
    Ok(())
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn plugin_list(app: AppHandle) -> Result<Vec<PluginInfo>, String> {
    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_add_dev_dir(
    app: AppHandle,
    dir_path: String,
) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.dev_dirs.insert(dir_path);
        persist_plugin_settings(&app, &cache);
    }
    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_remove_dev_dir(
    app: AppHandle,
    dir_path: String,
) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.dev_dirs.remove(&dir_path);
        persist_plugin_settings(&app, &cache);
    }
    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_set_enabled(
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        if enabled {
            cache.disabled_ids.remove(&plugin_id);
        } else {
            cache.disabled_ids.insert(plugin_id);
        }
        persist_plugin_settings(&app, &cache);
    }
    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_market_install(
    app: AppHandle,
    slug: String,
    version: String,
    download_url: String,
    sha256: String,
    size_bytes: u64,
) -> Result<Vec<PluginInfo>, String> {
    let slug = slug.trim().to_lowercase();
    if slug.is_empty() {
        return Err("插件 slug 不能为空".to_string());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("插件 slug 含非法字符".to_string());
    }
    if version.trim().is_empty() {
        return Err("插件 version 不能为空".to_string());
    }
    if !download_url.starts_with("http://") && !download_url.starts_with("https://") {
        return Err("PLUGIN_INSTALL_NOT_SUPPORTED: 仅支持 http/https 下载链接".to_string());
    }
    if size_bytes > MAX_PLUGIN_PACKAGE_BYTES {
        return Err(format!(
            "插件包声明大小超过 50MB 限制（{} bytes）",
            size_bytes
        ));
    }

    let package_bytes = download_plugin_package(&download_url, size_bytes).await?;
    verify_package_sha256(&package_bytes, &sha256)?;

    let official_root = get_official_plugins_dir(&app);
    std::fs::create_dir_all(&official_root).map_err(|e| format!("创建官方插件目录失败: {}", e))?;

    let staging_parent = official_root.join(".staging");
    std::fs::create_dir_all(&staging_parent).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let staging_dir = staging_parent.join(format!("{}-{}", slug, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let install_dir = official_root.join(&slug);
    let backup_dir = official_root.join(format!(".backup-{}-{}", slug, uuid::Uuid::new_v4()));

    let install_result = (|| -> Result<(), String> {
        extract_zip_safely(&package_bytes, &staging_dir)?;
        let extracted_root = resolve_extracted_plugin_root(&staging_dir)?;

        if install_dir.exists() {
            std::fs::rename(&install_dir, &backup_dir)
                .map_err(|e| format!("备份旧版本失败: {}", e))?;
        }

        if let Err(e) = std::fs::rename(&extracted_root, &install_dir) {
            if backup_dir.exists() {
                let _ = std::fs::rename(&backup_dir, &install_dir);
            }
            return Err(format!("安装插件失败（原子替换失败）: {}", e));
        }

        if backup_dir.exists() {
            let _ = std::fs::remove_dir_all(&backup_dir);
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
        Ok(())
    })();

    if install_result.is_err() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    install_result?;

    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.disabled_ids.remove(&slug);
        persist_plugin_settings(&app, &cache);
    }

    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_market_install_official_local(
    app: AppHandle,
    slug: String,
) -> Result<Vec<PluginInfo>, String> {
    if !is_developer_mode_enabled(&app) {
        return Err(
            "PLUGIN_INSTALL_NOT_SUPPORTED: 本地官方包安装仅在开发者模式下可用".to_string(),
        );
    }

    let slug = slug.trim().to_lowercase();
    if slug.is_empty() {
        return Err("插件 slug 不能为空".to_string());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("插件 slug 含非法字符".to_string());
    }

    let source_dir = resolve_local_official_plugin_source(&app, &slug).ok_or_else(|| {
        format!(
            "官方插件 {} 本地包不存在，请先发布到插件市场或检查 official-plugins 目录",
            slug
        )
    })?;

    let official_root = get_official_plugins_dir(&app);
    std::fs::create_dir_all(&official_root).map_err(|e| format!("创建官方插件目录失败: {}", e))?;

    let staging_parent = official_root.join(".staging");
    std::fs::create_dir_all(&staging_parent).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let staging_dir = staging_parent.join(format!("{}-{}", slug, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let staged_plugin_dir = staging_dir.join(&slug);

    let install_dir = official_root.join(&slug);
    let backup_dir = official_root.join(format!(".backup-{}-{}", slug, uuid::Uuid::new_v4()));

    let install_result = (|| -> Result<(), String> {
        copy_dir_recursive(&source_dir, &staged_plugin_dir)?;
        if !contains_manifest(&staged_plugin_dir) {
            return Err("官方插件目录缺少 plugin.json/package.json".to_string());
        }

        if install_dir.exists() {
            std::fs::rename(&install_dir, &backup_dir)
                .map_err(|e| format!("备份旧版本失败: {}", e))?;
        }

        if let Err(e) = std::fs::rename(&staged_plugin_dir, &install_dir) {
            if backup_dir.exists() {
                let _ = std::fs::rename(&backup_dir, &install_dir);
            }
            return Err(format!("安装官方本地插件失败（原子替换失败）: {}", e));
        }

        if backup_dir.exists() {
            let _ = std::fs::remove_dir_all(&backup_dir);
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
        Ok(())
    })();

    if install_result.is_err() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    install_result?;

    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.disabled_ids.remove(&slug);
        persist_plugin_settings(&app, &cache);
    }

    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_market_uninstall(
    app: AppHandle,
    plugin_id: String,
) -> Result<Vec<PluginInfo>, String> {
    let plugins = get_cached_plugins(&app);
    let plugin = plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("插件不存在: {}", plugin_id))?;

    if plugin.is_builtin {
        return Err("内置插件不支持卸载".to_string());
    }

    let plugin_dir = PathBuf::from(&plugin.dir_path);
    let official_root = get_official_plugins_dir(&app);
    if !path_within(&plugin_dir, &official_root) {
        return Err("仅支持卸载通过插件市场安装到官方目录的插件".to_string());
    }

    remove_path_if_exists(&plugin_dir)?;

    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.disabled_ids.remove(&plugin_id);
        persist_plugin_settings(&app, &cache);
    }

    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_market_clear_data(app: AppHandle, data_profile: String) -> Result<(), String> {
    let profile = data_profile.trim().to_lowercase();
    if profile.is_empty() || profile == "none" {
        return Ok(());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 目录失败: {}", e))?;
    let db_dir = app_data_dir.join("mtools-db");

    match profile.as_str() {
        "snippets" => {
            remove_path_if_exists(&db_dir.join("snippets.json"))?;
        }
        "bookmarks" => {
            remove_path_if_exists(&db_dir.join("bookmarks.json"))?;
        }
        "note_hub" | "note-hub" => {
            remove_path_if_exists(&db_dir.join("marks.json"))?;
            remove_path_if_exists(&db_dir.join("tags.json"))?;
            remove_path_if_exists(&app_data_dir.join("notes"))?;
        }
        _ => {
            return Err(format!("未知 data_profile: {}", profile));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_dev_watch_start(
    app: AppHandle,
    dir_paths: Vec<String>,
    plugin_id: Option<String>,
) -> Result<PluginDevWatchStatus, String> {
    let _ = stop_dev_watcher(&app);

    let mut watch_dirs: Vec<String> = if dir_paths.is_empty() {
        let cache = app.state::<Mutex<PluginCache>>();
        let cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.dev_dirs.iter().cloned().collect()
    } else {
        dir_paths
    };

    watch_dirs.sort();
    watch_dirs.dedup();
    if watch_dirs.is_empty() {
        return Err("未提供可监听目录，请先添加开发目录".to_string());
    }

    let watch_paths: Vec<PathBuf> = watch_dirs
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();
    if watch_paths.is_empty() {
        return Err("监听目录不存在".to_string());
    }

    let status = set_watch_status(&app, |status| {
        status.running = true;
        status.watched_dirs = watch_dirs.clone();
        status.plugin_id = plugin_id.clone();
        status.last_error = None;
    });
    let _ = app.emit("plugin-dev:watch-status", &status);

    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let app_handle = app.clone();
    let plugin_filter = plugin_id.clone();
    let initial_snapshot = collect_file_snapshot(&watch_paths);

    let task = tauri::async_runtime::spawn(async move {
        let mut previous = initial_snapshot;
        loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    break;
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(400)) => {
                    let current = collect_file_snapshot(&watch_paths);
                    let changed_paths = diff_snapshots(&previous, &current);
                    previous = current;

                    if changed_paths.is_empty() {
                        continue;
                    }

                    let parse_errors: Vec<serde_json::Value> = changed_paths
                        .iter()
                        .filter_map(|path| validate_manifest_file(path).map(|err| {
                            serde_json::json!({
                                "path": path,
                                "error": err,
                            })
                        }))
                        .collect();

                    if !parse_errors.is_empty() {
                        let status = set_watch_status(&app_handle, |status| {
                            status.last_error = Some("插件清单解析失败，已保持当前运行版本".to_string());
                            status.last_changed_at = Some(now_rfc3339());
                        });
                        let _ = app_handle.emit("plugin-dev:watch-status", &status);
                        let _ = app_handle.emit(
                            "plugin-dev:reload-error",
                            serde_json::json!({
                                "pluginId": plugin_filter,
                                "errors": parse_errors,
                            }),
                        );
                        continue;
                    }

                    let changed_ids = resolve_changed_plugin_ids(&app_handle, &changed_paths, &plugin_filter);
                    if changed_ids.is_empty() {
                        continue;
                    }

                    let status = set_watch_status(&app_handle, |status| {
                        status.changed_count += changed_paths.len() as u64;
                        status.last_changed_at = Some(now_rfc3339());
                        status.last_error = None;
                    });
                    let _ = app_handle.emit("plugin-dev:watch-status", &status);
                    let changed_ids_vec: Vec<String> = changed_ids.iter().cloned().collect();
                    let _ = app_handle.emit(
                        "plugin-dev:file-changed",
                        serde_json::json!({
                            "pluginIds": changed_ids_vec,
                            "paths": changed_paths,
                            "at": now_rfc3339(),
                        }),
                    );

                    for id in changed_ids {
                        reload_plugin_windows(app_handle.clone(), &id).await;
                    }
                }
            }
        }
    });

    {
        let state = app.state::<Mutex<PluginDevState>>();
        let mut state = state.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        state.watcher = Some(super::types::PluginDevWatcherRuntime {
            stop_tx: Some(stop_tx),
            task: Some(task),
        });
    }

    Ok(set_watch_status(&app, |_| {}))
}

#[tauri::command]
pub async fn plugin_dev_watch_stop(app: AppHandle) -> Result<PluginDevWatchStatus, String> {
    let status = stop_dev_watcher(&app);
    let _ = app.emit("plugin-dev:watch-status", &status);
    Ok(status)
}

#[tauri::command]
pub async fn plugin_dev_watch_status(app: AppHandle) -> Result<PluginDevWatchStatus, String> {
    Ok(set_watch_status(&app, |_| {}))
}

#[tauri::command]
pub async fn plugin_dev_get_trace_buffer(
    app: AppHandle,
    plugin_id: Option<String>,
) -> Result<Vec<PluginDevTraceItem>, String> {
    let state = app.state::<Mutex<PluginDevState>>();
    let state = state.lock().map_err(|e| format!("Lock poisoned: {}", e))?;

    let traces = state
        .trace_buffer
        .iter()
        .filter(|item| match &plugin_id {
            Some(id) => &item.plugin_id == id,
            None => true,
        })
        .cloned()
        .collect();
    Ok(traces)
}

#[tauri::command]
pub async fn plugin_dev_clear_trace_buffer(
    app: AppHandle,
    plugin_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<Mutex<PluginDevState>>();
    let mut state = state.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
    if let Some(id) = plugin_id {
        state.trace_buffer.retain(|item| item.plugin_id != id);
    } else {
        state.trace_buffer.clear();
    }
    Ok(())
}
