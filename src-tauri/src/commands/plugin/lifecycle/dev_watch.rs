use notify::{recommended_watcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::plugin::api_bridge::plugin_open;
use crate::commands::plugin::types::{
    PluginDevState, PluginDevTraceItem, PluginDevWatchStatus, PluginDevWatcherRuntime,
    PluginInfo, PluginManifest,
};

use super::{get_cached_plugins, get_plugin_dev_dirs, invalidate_plugin_runtime, refresh_plugin_cache};

const DEV_WATCH_DEBOUNCE_MS: u64 = 200;

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn normalize_fs_path(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    normalize_path(&resolved.to_string_lossy())
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
    plugins: &[PluginInfo],
    changed_paths: &[String],
    plugin_filter: &Option<String>,
) -> HashSet<String> {
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

fn emit_watch_error(app: &AppHandle, plugin_id: &Option<String>, error: String) {
    let status = set_watch_status(app, |status| {
        status.last_error = Some(error.clone());
        status.last_changed_at = Some(now_rfc3339());
    });
    let _ = app.emit("plugin-dev:watch-status", &status);
    let _ = app.emit(
        "plugin-dev:reload-error",
        serde_json::json!({
            "pluginId": plugin_id,
            "errors": [{
                "path": null,
                "error": error,
            }],
        }),
    );
}

async fn process_changed_paths(
    app: &AppHandle,
    changed_paths: Vec<String>,
    plugin_filter: &Option<String>,
) {
    if changed_paths.is_empty() {
        return;
    }

    let parse_errors: Vec<serde_json::Value> = changed_paths
        .iter()
        .filter_map(|path| {
            validate_manifest_file(path).map(|err| {
                serde_json::json!({
                    "path": path,
                    "error": err,
                })
            })
        })
        .collect();

    if !parse_errors.is_empty() {
        let status = set_watch_status(app, |status| {
            status.last_error = Some("插件清单解析失败，已保持当前运行版本".to_string());
            status.last_changed_at = Some(now_rfc3339());
        });
        let _ = app.emit("plugin-dev:watch-status", &status);
        let _ = app.emit(
            "plugin-dev:reload-error",
            serde_json::json!({
                "pluginId": plugin_filter,
                "errors": parse_errors,
            }),
        );
        return;
    }

    let previous_plugins = get_cached_plugins(app);
    let previous_changed_ids =
        resolve_changed_plugin_ids(&previous_plugins, &changed_paths, plugin_filter);
    invalidate_plugin_runtime(app);
    let refreshed_plugins = refresh_plugin_cache(app);
    let mut changed_ids = previous_changed_ids;
    changed_ids.extend(resolve_changed_plugin_ids(
        &refreshed_plugins,
        &changed_paths,
        plugin_filter,
    ));
    if changed_ids.is_empty() {
        return;
    }

    let status = set_watch_status(app, |status| {
        status.changed_count += changed_paths.len() as u64;
        status.last_changed_at = Some(now_rfc3339());
        status.last_error = None;
    });
    let _ = app.emit("plugin-dev:watch-status", &status);
    let changed_ids_vec: Vec<String> = changed_ids.iter().cloned().collect();
    let _ = app.emit(
        "plugin-dev:file-changed",
        serde_json::json!({
            "pluginIds": changed_ids_vec,
            "paths": changed_paths,
            "at": now_rfc3339(),
        }),
    );

    for id in changed_ids {
        reload_plugin_windows(app.clone(), &id).await;
    }
}

pub(super) async fn plugin_dev_watch_start(
    app: AppHandle,
    dir_paths: Vec<String>,
    plugin_id: Option<String>,
) -> Result<PluginDevWatchStatus, String> {
    let _ = stop_dev_watcher(&app);
    let _ = get_cached_plugins(&app);

    let mut watch_dirs: Vec<String> = if dir_paths.is_empty() {
        get_plugin_dev_dirs(&app)
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

    let (event_tx, mut event_rx) =
        tokio::sync::mpsc::unbounded_channel::<notify::Result<notify::Event>>();
    let mut watcher = recommended_watcher(move |result| {
        let _ = event_tx.send(result);
    })
    .map_err(|e| format!("创建文件监听失败: {}", e))?;

    for path in &watch_paths {
        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| format!("监听目录失败 ({}): {}", path.display(), e))?;
    }

    let status = set_watch_status(&app, |status| {
        status.running = true;
        status.watched_dirs = watch_dirs.clone();
        status.plugin_id = plugin_id.clone();
        status.changed_count = 0;
        status.last_changed_at = None;
        status.last_error = None;
    });
    let _ = app.emit("plugin-dev:watch-status", &status);

    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let app_handle = app.clone();
    let plugin_filter = plugin_id.clone();

    let task = tauri::async_runtime::spawn(async move {
        let _watcher = watcher;
        let mut pending_paths = HashSet::<String>::new();
        let mut debounce: Option<Pin<Box<tokio::time::Sleep>>> = None;

        loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    break;
                }
                maybe_event = event_rx.recv() => {
                    match maybe_event {
                        Some(Ok(event)) => {
                            for path in event.paths {
                                pending_paths.insert(normalize_fs_path(&path));
                            }
                            if !pending_paths.is_empty() {
                                debounce = Some(Box::pin(tokio::time::sleep(std::time::Duration::from_millis(
                                    DEV_WATCH_DEBOUNCE_MS,
                                ))));
                            }
                        }
                        Some(Err(err)) => {
                            emit_watch_error(&app_handle, &plugin_filter, format!("文件监听失败: {}", err));
                        }
                        None => break,
                    }
                }
                _ = async {
                    if let Some(timer) = &mut debounce {
                        timer.as_mut().await;
                    }
                }, if debounce.is_some() => {
                    let mut changed_paths: Vec<String> = pending_paths.drain().collect();
                    changed_paths.sort();
                    debounce = None;
                    process_changed_paths(&app_handle, changed_paths, &plugin_filter).await;
                }
            }
        }
    });

    {
        let state = app.state::<Mutex<PluginDevState>>();
        let mut state = state.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        state.watcher = Some(PluginDevWatcherRuntime {
            stop_tx: Some(stop_tx),
            task: Some(task),
        });
    }

    Ok(set_watch_status(&app, |_| {}))
}

pub(super) async fn plugin_dev_watch_stop(app: AppHandle) -> Result<PluginDevWatchStatus, String> {
    let status = stop_dev_watcher(&app);
    let _ = app.emit("plugin-dev:watch-status", &status);
    Ok(status)
}

pub(super) async fn plugin_dev_watch_status(
    app: AppHandle,
) -> Result<PluginDevWatchStatus, String> {
    Ok(set_watch_status(&app, |_| {}))
}

pub(super) async fn plugin_dev_get_trace_buffer(
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

pub(super) async fn plugin_dev_clear_trace_buffer(
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
