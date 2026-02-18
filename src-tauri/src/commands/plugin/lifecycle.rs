//! 插件生命周期 — 扫描、缓存、启用/禁用、持久化

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use super::types::{PluginCache, PluginInfo, PluginManifest};

// ── 插件扫描 ──

pub(super) fn get_plugins_dir(app: &AppHandle) -> PathBuf {
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let plugins_dir = resource_dir.join("plugins");
    if plugins_dir.exists() {
        return plugins_dir;
    }
    std::env::current_dir().unwrap_or_default().join("plugins")
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

pub(super) fn make_plugin_id(dir: &PathBuf, manifest: &PluginManifest) -> String {
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

fn scan_dirs(dirs: &[PathBuf], disabled_ids: &HashSet<String>) -> Vec<PluginInfo> {
    let mut plugins = Vec::new();
    let mut seen_ids = HashSet::new();

    for base_dir in dirs {
        if !base_dir.exists() {
            continue;
        }

        if let Some((manifest, _)) = scan_plugin_dir(base_dir) {
            let id = make_plugin_id(base_dir, &manifest);
            if seen_ids.insert(id.clone()) {
                plugins.push(PluginInfo {
                    enabled: !disabled_ids.contains(&id),
                    id,
                    is_builtin: false,
                    manifest,
                    dir_path: base_dir.to_string_lossy().to_string(),
                });
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
                    let id = make_plugin_id(&path, &manifest);
                    if seen_ids.insert(id.clone()) {
                        let is_builtin = path
                            .file_name()
                            .map(|n| n.to_string_lossy().starts_with("builtin-"))
                            .unwrap_or(false);

                        plugins.push(PluginInfo {
                            enabled: !disabled_ids.contains(&id),
                            id,
                            manifest,
                            dir_path: path.to_string_lossy().to_string(),
                            is_builtin,
                        });
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

    let mut dirs = vec![get_plugins_dir(app)];
    for dev_dir in &cache.dev_dirs {
        dirs.push(PathBuf::from(dev_dir));
    }

    cache.plugins = scan_dirs(&dirs, &cache.disabled_ids);
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
        store.set("devDirs", serde_json::to_value(&dirs_vec).unwrap_or_default());
        let disabled_vec: Vec<&String> = cache.disabled_ids.iter().collect();
        store.set("disabledIds", serde_json::to_value(&disabled_vec).unwrap_or_default());
    }
}

// ── Tauri Commands ──

#[tauri::command]
pub async fn plugin_list(app: AppHandle) -> Result<Vec<PluginInfo>, String> {
    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_add_dev_dir(app: AppHandle, dir_path: String) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.dev_dirs.insert(dir_path);
        persist_plugin_settings(&app, &cache);
    }
    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_remove_dev_dir(app: AppHandle, dir_path: String) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.dev_dirs.remove(&dir_path);
        persist_plugin_settings(&app, &cache);
    }
    Ok(refresh_plugin_cache(&app))
}

#[tauri::command]
pub async fn plugin_set_enabled(app: AppHandle, plugin_id: String, enabled: bool) -> Result<Vec<PluginInfo>, String> {
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
