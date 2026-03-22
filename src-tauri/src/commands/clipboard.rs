use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 剪贴板历史条目
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClipboardEntry {
    pub id: u64,
    pub content: String,
    /// "text" | "image_path"
    pub content_type: String,
    pub timestamp: u64,
    /// 内容前 100 字符预览
    pub preview: String,
}

/// 剪贴板历史状态（内存 + 持久化）
pub struct ClipboardHistory {
    pub entries: Vec<ClipboardEntry>,
    pub max_entries: usize,
    pub next_id: u64,
    pub last_hash: u64,
    pub enabled: bool,
    pub dirty: bool,
    pub dirty_since: Option<Instant>,
}

impl Default for ClipboardHistory {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            max_entries: 200,
            next_id: 1,
            last_hash: 0,
            enabled: true,
            dirty: false,
            dirty_since: None,
        }
    }
}

/// 简单字符串哈希（DJB2）
fn djb2_hash(s: &str) -> u64 {
    let mut hash: u64 = 5381;
    for b in s.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(b as u64);
    }
    hash
}

/// 从持久化存储加载历史
fn load_history(app: &AppHandle) -> ClipboardHistory {
    use tauri_plugin_store::StoreExt;
    let store = match app.store("clipboard-history.json") {
        Ok(s) => s,
        Err(_) => return ClipboardHistory::default(),
    };

    let entries: Vec<ClipboardEntry> = store
        .get("entries")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let next_id = entries.iter().map(|e| e.id).max().unwrap_or(0) + 1;
    let last_hash = entries.first().map(|e| djb2_hash(&e.content)).unwrap_or(0);

    ClipboardHistory {
        entries,
        max_entries: 200,
        next_id,
        last_hash,
        enabled: true,
        dirty: false,
        dirty_since: None,
    }
}

/// 持久化历史到存储
fn save_history(app: &AppHandle, history: &ClipboardHistory) {
    use tauri_plugin_store::StoreExt;
    if let Ok(store) = app.store("clipboard-history.json") {
        if let Ok(val) = serde_json::to_value(&history.entries) {
            let _ = store.set("entries", val);
            let _ = store.save();
        }
    }
}

fn mark_history_dirty(history: &mut ClipboardHistory) {
    history.dirty = true;
    history.dirty_since = Some(Instant::now());
}

fn flush_history_if_needed(app: &AppHandle, force: bool) {
    let state = app.state::<Mutex<ClipboardHistory>>();
    let mut history = match state.lock() {
        Ok(history) => history,
        Err(_) => return,
    };

    let should_flush = history.dirty
        && (force
            || history
                .dirty_since
                .map(|dirty_since| dirty_since.elapsed() >= Duration::from_secs(2))
                .unwrap_or(false));

    if !should_flush {
        return;
    }

    save_history(app, &history);
    history.dirty = false;
    history.dirty_since = None;
}

pub fn flush_clipboard_history(app: &AppHandle) {
    flush_history_if_needed(app, true);
}

/// 初始化剪贴板监听（在 app setup 中调用）
pub fn start_clipboard_watcher(app: &AppHandle) {
    let app_handle = app.clone();

    // 先加载历史到状态
    let history = load_history(&app_handle);
    app_handle.manage(Mutex::new(history));

    // 启动后台轮询任务
    let app_for_task = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            flush_history_if_needed(&app_for_task, false);

            // 读取剪贴板
            let app_clone = app_for_task.clone();
            let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();

            let read_result = app_for_task.run_on_main_thread(move || {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let text = app_clone
                    .clipboard()
                    .read_text()
                    .ok()
                    .filter(|s| !s.is_empty());
                let _ = tx.send(text);
            });

            if read_result.is_err() {
                continue;
            }

            let text = match rx.await {
                Ok(Some(t)) => t,
                _ => continue,
            };

            // 检查是否启用 + 内容是否变化
            let state = app_for_task.state::<Mutex<ClipboardHistory>>();
            let mut history = match state.lock() {
                Ok(h) => h,
                Err(_) => continue,
            };

            if !history.enabled {
                continue;
            }

            let hash = djb2_hash(&text);
            if hash == history.last_hash {
                continue;
            }
            history.last_hash = hash;

            // 去重：如果已有相同内容，移到最前面
            history.entries.retain(|e| djb2_hash(&e.content) != hash);

            // 新增条目
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            let preview = if text.len() > 100 {
                format!(
                    "{}...",
                    &text[..text
                        .char_indices()
                        .nth(100)
                        .map(|(i, _)| i)
                        .unwrap_or(text.len())]
                )
            } else {
                text.clone()
            };

            let entry = ClipboardEntry {
                id: history.next_id,
                content: text,
                content_type: "text".to_string(),
                timestamp: now,
                preview,
            };
            history.next_id += 1;

            // 插入到最前面
            history.entries.insert(0, entry.clone());

            // 裁剪到 max_entries
            let max = history.max_entries;
            if history.entries.len() > max {
                history.entries.truncate(max);
            }

            mark_history_dirty(&mut history);

            // 通知前端
            let _ = app_for_task.emit(
                "clipboard-history-update",
                serde_json::json!({
                    "entry": entry,
                    "total": history.entries.len(),
                }),
            );
        }
    });
}

// ── Tauri 命令 ──

#[tauri::command]
pub async fn clipboard_history_list(
    app: AppHandle,
    search: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ClipboardEntry>, String> {
    let state = app.state::<Mutex<ClipboardHistory>>();
    let history = state.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(50);

    let entries: Vec<ClipboardEntry> = if let Some(keyword) = search.filter(|s| !s.is_empty()) {
        let kw = keyword.to_lowercase();
        history
            .entries
            .iter()
            .filter(|e| e.content.to_lowercase().contains(&kw))
            .take(limit)
            .cloned()
            .collect()
    } else {
        history.entries.iter().take(limit).cloned().collect()
    };

    Ok(entries)
}

#[tauri::command]
pub async fn clipboard_history_clear(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<ClipboardHistory>>();
    let mut history = state.lock().map_err(|e| e.to_string())?;
    history.entries.clear();
    history.last_hash = 0;
    mark_history_dirty(&mut history);
    Ok(())
}

#[tauri::command]
pub async fn clipboard_history_delete(app: AppHandle, id: u64) -> Result<(), String> {
    let state = app.state::<Mutex<ClipboardHistory>>();
    let mut history = state.lock().map_err(|e| e.to_string())?;
    history.entries.retain(|e| e.id != id);
    mark_history_dirty(&mut history);
    Ok(())
}

#[tauri::command]
pub async fn clipboard_history_write(app: AppHandle, content: String) -> Result<(), String> {
    let app_clone = app.clone();
    let content_clone = content.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let r = app_clone
            .clipboard()
            .write_text(&content_clone)
            .map_err(|e| e.to_string());
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;

    rx.await.map_err(|_| "写入超时".to_string())?
}
