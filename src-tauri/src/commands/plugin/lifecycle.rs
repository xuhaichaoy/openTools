//! 插件生命周期 — 扫描、缓存、启用/禁用、持久化、开发态监听

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

use super::types::{
    MtpluginResourceCacheInfo, MtpluginResourceMeta, PluginCache, PluginDevTraceItem,
    PluginDevWatchStatus, PluginInfo, PluginManifest,
};

mod dev_watch;
mod market_ops;

// ── 插件扫描 ──

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

fn load_plugin_settings_if_needed(app: &AppHandle, cache: &mut PluginCache) {
    if cache.settings_loaded {
        return;
    }

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
    cache.settings_loaded = true;
}

fn build_scan_roots(app: &AppHandle, cache: &PluginCache) -> Vec<ScanRoot> {
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
    roots
}

fn build_allowed_mtplugin_roots(app: &AppHandle, cache: &PluginCache) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join("plugins"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("plugins"));
    }
    for dev_dir in &cache.dev_dirs {
        roots.push(PathBuf::from(dev_dir));
    }
    roots.push(std::env::temp_dir());
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        roots.push(app_data_dir.join("plugins").join("official"));
    }

    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let canonical = match root.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        let key = canonical.to_string_lossy().to_string();
        if seen.insert(key) {
            deduped.push(canonical);
        }
    }
    deduped
}

fn rebuild_plugin_runtime(app: &AppHandle, cache: &mut PluginCache) -> Vec<PluginInfo> {
    let roots = build_scan_roots(app, cache);
    cache.runtime.plugin_list = scan_dirs(&roots, &cache.disabled_ids);
    cache.runtime.allowed_mtplugin_roots = build_allowed_mtplugin_roots(app, cache);
    cache.runtime.resource_meta.clear();
    cache.runtime.initialized = true;
    cache.runtime.dirty = false;
    cache.runtime.plugin_list.clone()
}

fn invalidate_plugin_runtime_locked(cache: &mut PluginCache) {
    cache.runtime.dirty = true;
    cache.runtime.allowed_mtplugin_roots.clear();
    cache.runtime.resource_meta.clear();
}

pub(super) fn invalidate_plugin_runtime(app: &AppHandle) {
    let cache = app.state::<Mutex<PluginCache>>();
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    invalidate_plugin_runtime_locked(&mut cache);
}

pub(super) fn refresh_plugin_cache(app: &AppHandle) -> Vec<PluginInfo> {
    let cache = app.state::<Mutex<PluginCache>>();
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    load_plugin_settings_if_needed(app, &mut cache);

    if cache.runtime.initialized && !cache.runtime.dirty {
        return cache.runtime.plugin_list.clone();
    }

    rebuild_plugin_runtime(app, &mut cache)
}

pub(super) fn get_cached_plugins(app: &AppHandle) -> Vec<PluginInfo> {
    refresh_plugin_cache(app)
}

pub(super) fn get_plugin_dev_dirs(app: &AppHandle) -> Vec<String> {
    let cache = app.state::<Mutex<PluginCache>>();
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    load_plugin_settings_if_needed(app, &mut cache);
    cache.dev_dirs.iter().cloned().collect()
}

pub fn get_allowed_mtplugin_roots(app: &AppHandle) -> Vec<PathBuf> {
    let cache = app.state::<Mutex<PluginCache>>();
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    load_plugin_settings_if_needed(app, &mut cache);

    if !cache.runtime.initialized || cache.runtime.dirty {
        rebuild_plugin_runtime(app, &mut cache);
    }

    cache.runtime.allowed_mtplugin_roots.clone()
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn is_temporary_mtplugin_path(canonical: &Path) -> bool {
    std::env::temp_dir()
        .canonicalize()
        .map(|root| canonical.starts_with(root))
        .unwrap_or(false)
}

fn is_dev_mtplugin_path(app: &AppHandle, canonical: &Path) -> bool {
    get_plugin_dev_dirs(app).into_iter().any(|dir| {
        let root = PathBuf::from(dir);
        let canonical_root = root.canonicalize().unwrap_or(root);
        canonical.starts_with(canonical_root)
    })
}

fn metadata_signature(path: &Path) -> Option<(u64, u128)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_ms = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    Some((metadata.len(), modified_ms))
}

fn format_http_date(modified_ms: u128) -> Option<String> {
    let secs = (modified_ms / 1000) as i64;
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)?;
    Some(dt.format("%a, %d %b %Y %H:%M:%S GMT").to_string())
}

fn build_resource_meta(_path: &Path, file_len: u64, modified_ms: u128) -> MtpluginResourceMeta {
    MtpluginResourceMeta {
        file_len,
        modified_ms,
        etag: format!("W/\"{:x}-{:x}\"", file_len, modified_ms),
        last_modified: format_http_date(modified_ms),
    }
}

pub fn get_mtplugin_resource_cache_info(
    app: &AppHandle,
    canonical: &Path,
) -> Option<MtpluginResourceCacheInfo> {
    let is_temporary = is_temporary_mtplugin_path(canonical);
    let is_dev = !is_temporary && is_dev_mtplugin_path(app, canonical);
    if is_temporary {
        return Some(MtpluginResourceCacheInfo {
            is_temporary,
            is_dev: false,
            etag: None,
            last_modified: None,
        });
    }

    let (file_len, modified_ms) = metadata_signature(canonical)?;
    let key = path_key(canonical);

    let cache = app.state::<Mutex<PluginCache>>();
    let mut cache = cache.lock().unwrap_or_else(|e| e.into_inner());
    load_plugin_settings_if_needed(app, &mut cache);

    let entry = cache
        .runtime
        .resource_meta
        .entry(key)
        .and_modify(|meta| {
            if meta.file_len != file_len || meta.modified_ms != modified_ms {
                *meta = build_resource_meta(canonical, file_len, modified_ms);
            }
        })
        .or_insert_with(|| build_resource_meta(canonical, file_len, modified_ms))
        .clone();

    Some(MtpluginResourceCacheInfo {
        is_temporary,
        is_dev,
        etag: Some(entry.etag),
        last_modified: entry.last_modified,
    })
}

pub fn is_allowed_mtplugin_path(app: &AppHandle, canonical: &Path) -> bool {
    get_allowed_mtplugin_roots(app)
        .iter()
        .any(|root| canonical.starts_with(root))
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

pub(super) fn push_dev_trace(app: &AppHandle, item: PluginDevTraceItem) {
    dev_watch::push_dev_trace(app, item);
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn plugin_list(app: AppHandle) -> Result<Vec<PluginInfo>, String> {
    Ok(get_cached_plugins(&app))
}

#[tauri::command]
pub async fn plugin_add_dev_dir(
    app: AppHandle,
    dir_path: String,
) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        load_plugin_settings_if_needed(&app, &mut cache);
        cache.dev_dirs.insert(dir_path);
        invalidate_plugin_runtime_locked(&mut cache);
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
        load_plugin_settings_if_needed(&app, &mut cache);
        cache.dev_dirs.remove(&dir_path);
        invalidate_plugin_runtime_locked(&mut cache);
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
        load_plugin_settings_if_needed(&app, &mut cache);
        if enabled {
            cache.disabled_ids.remove(&plugin_id);
        } else {
            cache.disabled_ids.insert(plugin_id);
        }
        invalidate_plugin_runtime_locked(&mut cache);
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
    market_ops::plugin_market_install(app, slug, version, download_url, sha256, size_bytes).await
}

#[tauri::command]
pub async fn plugin_market_install_official_local(
    app: AppHandle,
    slug: String,
) -> Result<Vec<PluginInfo>, String> {
    market_ops::plugin_market_install_official_local(app, slug).await
}

#[tauri::command]
pub async fn plugin_market_uninstall(
    app: AppHandle,
    plugin_id: String,
) -> Result<Vec<PluginInfo>, String> {
    market_ops::plugin_market_uninstall(app, plugin_id).await
}

#[tauri::command]
pub async fn plugin_market_clear_data(app: AppHandle, data_profile: String) -> Result<(), String> {
    market_ops::plugin_market_clear_data(app, data_profile).await
}

#[tauri::command]
pub async fn plugin_dev_watch_start(
    app: AppHandle,
    dir_paths: Vec<String>,
    plugin_id: Option<String>,
) -> Result<PluginDevWatchStatus, String> {
    dev_watch::plugin_dev_watch_start(app, dir_paths, plugin_id).await
}

#[tauri::command]
pub async fn plugin_dev_watch_stop(app: AppHandle) -> Result<PluginDevWatchStatus, String> {
    dev_watch::plugin_dev_watch_stop(app).await
}

#[tauri::command]
pub async fn plugin_dev_watch_status(app: AppHandle) -> Result<PluginDevWatchStatus, String> {
    dev_watch::plugin_dev_watch_status(app).await
}

#[tauri::command]
pub async fn plugin_dev_get_trace_buffer(
    app: AppHandle,
    plugin_id: Option<String>,
) -> Result<Vec<PluginDevTraceItem>, String> {
    dev_watch::plugin_dev_get_trace_buffer(app, plugin_id).await
}

#[tauri::command]
pub async fn plugin_dev_clear_trace_buffer(
    app: AppHandle,
    plugin_id: Option<String>,
) -> Result<(), String> {
    dev_watch::plugin_dev_clear_trace_buffer(app, plugin_id).await
}
