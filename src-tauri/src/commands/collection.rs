//! 通用 JSON Collection CRUD 命令
//!
//! 将前端 `JsonCollection` 的文件 I/O 统一到 Rust 侧，
//! 通过 `RwLock` 避免并发读写冲突，为后续迁移到 SQLite 打下基础。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use tauri::{AppHandle, Manager};

/// 每个集合对应一把读写锁，确保同一集合不会被并发写入
struct CollectionLocks {
    locks: RwLock<HashMap<String, std::sync::Arc<RwLock<()>>>>,
}

impl CollectionLocks {
    fn new() -> Self {
        Self {
            locks: RwLock::new(HashMap::new()),
        }
    }

    fn get_lock(&self, name: &str) -> Result<std::sync::Arc<RwLock<()>>, String> {
        // 先尝试读锁快速路径
        {
            let map = self.locks.read().map_err(|e| format!("锁中毒: {}", e))?;
            if let Some(lock) = map.get(name) {
                return Ok(lock.clone());
            }
        }
        // 写锁路径：创建新锁
        let mut map = self.locks.write().map_err(|e| format!("锁中毒: {}", e))?;
        Ok(map
            .entry(name.to_string())
            .or_insert_with(|| std::sync::Arc::new(RwLock::new(())))
            .clone())
    }
}

static COLLECTION_LOCKS: once_cell::sync::Lazy<CollectionLocks> =
    once_cell::sync::Lazy::new(CollectionLocks::new);

const DB_DIR: &str = "mtools-db";

/// 获取集合文件路径：{AppData}/mtools-db/{name}.json
fn get_collection_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {}", e))?;
    let dir = app_data.join(DB_DIR);
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据库目录失败: {}", e))?;
    }
    Ok(dir.join(format!("{}.json", name)))
}

/// 读取整个集合文件，返回 JSON 字符串（数组）
fn read_collection(path: &PathBuf) -> Result<String, String> {
    if !path.exists() {
        return Ok("[]".to_string());
    }
    std::fs::read_to_string(path).map_err(|e| format!("读取集合失败: {}", e))
}

/// 写入整个集合文件
fn write_collection(path: &PathBuf, data: &str) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| format!("写入集合失败: {}", e))
}

// ── Tauri Commands ──

/// 获取集合中所有条目
#[tauri::command]
pub async fn collection_get_all(app: AppHandle, name: String) -> Result<String, String> {
    let path = get_collection_path(&app, &name)?;
    let lock = COLLECTION_LOCKS.get_lock(&name)?;
    let _guard = lock.read().map_err(|e| format!("获取读锁失败: {}", e))?;
    read_collection(&path)
}

/// 创建一条新记录（追加到数组头部）
#[tauri::command]
pub async fn collection_create(
    app: AppHandle,
    name: String,
    item: String,
) -> Result<String, String> {
    let path = get_collection_path(&app, &name)?;
    let lock = COLLECTION_LOCKS.get_lock(&name)?;
    let _guard = lock.write().map_err(|e| format!("获取写锁失败: {}", e))?;

    let raw = read_collection(&path)?;
    let mut arr: Vec<serde_json::Value> =
        serde_json::from_str(&raw).map_err(|e| format!("解析 JSON 失败: {}", e))?;

    let new_item: serde_json::Value =
        serde_json::from_str(&item).map_err(|e| format!("解析新条目 JSON 失败: {}", e))?;

    // 插入到头部（与前端 JsonCollection 行为一致）
    arr.insert(0, new_item.clone());

    let json = serde_json::to_string_pretty(&arr).map_err(|e| format!("序列化失败: {}", e))?;
    write_collection(&path, &json)?;

    Ok(new_item.to_string())
}

/// 更新一条记录（按 id 匹配，合并 partial 字段）
#[tauri::command]
pub async fn collection_update(
    app: AppHandle,
    name: String,
    id: String,
    partial: String,
) -> Result<String, String> {
    let path = get_collection_path(&app, &name)?;
    let lock = COLLECTION_LOCKS.get_lock(&name)?;
    let _guard = lock.write().map_err(|e| format!("获取写锁失败: {}", e))?;

    let raw = read_collection(&path)?;
    let mut arr: Vec<serde_json::Value> =
        serde_json::from_str(&raw).map_err(|e| format!("解析 JSON 失败: {}", e))?;

    let partial_val: serde_json::Value =
        serde_json::from_str(&partial).map_err(|e| format!("解析 partial JSON 失败: {}", e))?;

    let idx = arr
        .iter()
        .position(|item| item.get("id").and_then(|v| v.as_str()) == Some(&id))
        .ok_or_else(|| format!("未找到 id={} 的记录", id))?;

    // 合并字段
    if let (Some(existing), Some(updates)) = (arr[idx].as_object_mut(), partial_val.as_object()) {
        for (k, v) in updates {
            existing.insert(k.clone(), v.clone());
        }
    }

    let updated = arr[idx].to_string();

    let json = serde_json::to_string_pretty(&arr).map_err(|e| format!("序列化失败: {}", e))?;
    write_collection(&path, &json)?;

    Ok(updated)
}

/// 删除一条记录（按 id 匹配）
#[tauri::command]
pub async fn collection_delete(app: AppHandle, name: String, id: String) -> Result<bool, String> {
    let path = get_collection_path(&app, &name)?;
    let lock = COLLECTION_LOCKS.get_lock(&name)?;
    let _guard = lock.write().map_err(|e| format!("获取写锁失败: {}", e))?;

    let raw = read_collection(&path)?;
    let mut arr: Vec<serde_json::Value> =
        serde_json::from_str(&raw).map_err(|e| format!("解析 JSON 失败: {}", e))?;

    let original_len = arr.len();
    arr.retain(|item| item.get("id").and_then(|v| v.as_str()) != Some(&id));
    let deleted = arr.len() < original_len;

    if deleted {
        let json = serde_json::to_string_pretty(&arr).map_err(|e| format!("序列化失败: {}", e))?;
        write_collection(&path, &json)?;
    }

    Ok(deleted)
}

/// 覆盖整个集合（同步引擎 pull 后使用）
#[tauri::command]
pub async fn collection_set_all(app: AppHandle, name: String, items: String) -> Result<(), String> {
    let path = get_collection_path(&app, &name)?;
    let lock = COLLECTION_LOCKS.get_lock(&name)?;
    let _guard = lock.write().map_err(|e| format!("获取写锁失败: {}", e))?;

    // 验证是合法的 JSON 数组，并格式化后写入
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&items).map_err(|e| format!("解析 JSON 数组失败: {}", e))?;
    let json = serde_json::to_string_pretty(&arr).map_err(|e| format!("序列化失败: {}", e))?;
    write_collection(&path, &json)?;

    Ok(())
}
