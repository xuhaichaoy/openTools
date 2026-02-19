use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

// ── 类型定义 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptParam {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub param_type: String,
    pub required: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub options: Option<Vec<ParamOption>>,
    #[serde(default)]
    pub placeholder: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParamOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptOutput {
    #[serde(rename = "type")]
    pub output_type: String,
    pub filename_pattern: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub script: String,
    #[serde(default)]
    pub params: Vec<ScriptParam>,
    #[serde(default)]
    pub output: Option<ScriptOutput>,
    #[serde(default)]
    pub dependencies: Option<Vec<String>>,
    #[serde(default)]
    pub estimated_time: Option<String>,
    #[serde(default)]
    pub requires_auth: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptCategory {
    pub name: String,
    pub count: usize,
    pub scripts: Vec<ScriptMeta>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecutionRecord {
    pub id: String,
    pub script_id: String,
    pub script_name: String,
    pub category: String,
    pub params: HashMap<String, serde_json::Value>,
    pub status: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub duration_ms: Option<u64>,
    pub output_files: Vec<String>,
    pub record_count: Option<u64>,
    pub logs: String,
    pub error: Option<String>,
}

// ── 扫描脚本注册表 ──

fn get_scripts_dir(app: &AppHandle) -> PathBuf {
    // 优先查找 resource_dir/scripts（打包后）
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let scripts_dir = resource_dir.join("scripts");
    if scripts_dir.exists() {
        return scripts_dir;
    }

    // 开发模式：cwd 可能是 src-tauri/，需要往上一层找项目根目录
    let app_dir = std::env::current_dir().unwrap_or_default();
    let scripts_dir = app_dir.join("scripts");
    if scripts_dir.exists() {
        return scripts_dir;
    }

    // cwd = src-tauri/ 时，scripts/ 在上一层
    let parent_scripts = app_dir
        .parent()
        .map(|p| p.join("scripts"))
        .unwrap_or_default();
    if parent_scripts.exists() {
        log::info!("数据工坊: 使用项目根目录 scripts: {:?}", parent_scripts);
        return parent_scripts;
    }

    log::warn!(
        "数据工坊: 未找到 scripts 目录，尝试了: {:?}, {:?}",
        scripts_dir,
        parent_scripts
    );
    scripts_dir
}

fn scan_scripts(scripts_dir: &PathBuf) -> Vec<ScriptMeta> {
    let mut scripts = Vec::new();

    // 尝试读取总索引 registry.json
    let registry_path = scripts_dir.join("registry.json");
    if registry_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&registry_path) {
            if let Ok(metas) = serde_json::from_str::<Vec<ScriptMeta>>(&content) {
                return metas;
            }
        }
    }

    // 扫描子目录中的 script.meta.json
    if let Ok(entries) = std::fs::read_dir(scripts_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let meta_path = path.join("script.meta.json");
                if meta_path.exists() {
                    if let Ok(content) = std::fs::read_to_string(&meta_path) {
                        // 可能是单个 meta 或数组
                        if let Ok(meta) = serde_json::from_str::<ScriptMeta>(&content) {
                            scripts.push(meta);
                        } else if let Ok(metas) = serde_json::from_str::<Vec<ScriptMeta>>(&content)
                        {
                            scripts.extend(metas);
                        }
                    }
                }
            }
        }
    }

    scripts
}

// ── Tauri Commands ──

/// 获取所有脚本（按分类分组）
#[tauri::command]
pub async fn dataforge_get_scripts(app: AppHandle) -> Result<Vec<ScriptCategory>, String> {
    let scripts_dir = get_scripts_dir(&app);
    let scripts = scan_scripts(&scripts_dir);

    // 按 category 分组
    let mut category_map: HashMap<String, Vec<ScriptMeta>> = HashMap::new();
    for script in scripts {
        category_map
            .entry(script.category.clone())
            .or_default()
            .push(script);
    }

    let mut categories: Vec<ScriptCategory> = category_map
        .into_iter()
        .map(|(name, scripts)| ScriptCategory {
            count: scripts.len(),
            name,
            scripts,
        })
        .collect();

    categories.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(categories)
}

/// 搜索脚本
#[tauri::command]
pub async fn dataforge_search_scripts(
    app: AppHandle,
    query: String,
) -> Result<Vec<ScriptMeta>, String> {
    let scripts_dir = get_scripts_dir(&app);
    let scripts = scan_scripts(&scripts_dir);
    let query_lower = query.to_lowercase();

    let results: Vec<ScriptMeta> = scripts
        .into_iter()
        .filter(|s| {
            s.name.to_lowercase().contains(&query_lower)
                || s.description.to_lowercase().contains(&query_lower)
                || s.category.to_lowercase().contains(&query_lower)
                || s.tags
                    .iter()
                    .any(|t| t.to_lowercase().contains(&query_lower))
        })
        .collect();

    Ok(results)
}

/// 执行脚本
#[tauri::command]
pub async fn dataforge_run_script(
    app: AppHandle,
    script_id: String,
    params: HashMap<String, serde_json::Value>,
) -> Result<ExecutionRecord, String> {
    let scripts_dir = get_scripts_dir(&app);
    let scripts = scan_scripts(&scripts_dir);

    let script = scripts
        .iter()
        .find(|s| s.id == script_id)
        .ok_or_else(|| format!("脚本 {} 不存在", script_id))?
        .clone();

    let execution_id = uuid::Uuid::new_v4().to_string();
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    // 发送开始事件
    let _ = app.emit(
        "dataforge-execution-start",
        serde_json::json!({
            "execution_id": execution_id,
            "script_id": script_id,
        }),
    );

    // 构造 Python 命令参数
    let script_path = scripts_dir.join(&script.script);
    let python = detect_python()?;

    let mut cmd = std::process::Command::new(&python);
    cmd.arg(script_path.to_string_lossy().as_ref());

    // 把参数以 --key=value 形式传入
    for (key, value) in &params {
        let val_str = match value {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        cmd.arg(format!("--{}={}", key, val_str));
    }

    // 从 store 读取凭证，注入环境变量
    if let Ok(creds) = load_credentials(&app) {
        for (key, value) in &creds {
            cmd.env(key, value);
        }
    }

    // 执行
    let output = cmd.output().map_err(|e| format!("执行失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success();

    let finished_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let record = ExecutionRecord {
        id: execution_id.clone(),
        script_id: script.id.clone(),
        script_name: script.name.clone(),
        category: script.category.clone(),
        params,
        status: if success {
            "success".into()
        } else {
            "failed".into()
        },
        started_at,
        finished_at: Some(finished_at),
        duration_ms: Some(finished_at - started_at),
        output_files: vec![], // TODO: 解析输出文件
        record_count: None,
        logs: format!("{}\n{}", stdout, stderr),
        error: if success { None } else { Some(stderr.clone()) },
    };

    // 持久化执行历史到 store
    {
        use tauri_plugin_store::StoreExt;
        if let Ok(store) = app.store("dataforge.json") {
            let mut history: Vec<ExecutionRecord> = store
                .get("execution_history")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            history.insert(0, record.clone());
            // 只保留最近 200 条
            history.truncate(200);
            store.set(
                "execution_history",
                serde_json::to_value(&history).unwrap_or_default(),
            );
            let _ = store.save();
        }
    }

    // 发送完成事件
    let _ = app.emit(
        "dataforge-execution-done",
        serde_json::json!({
            "execution_id": execution_id,
            "record": &record,
        }),
    );

    Ok(record)
}

/// 获取执行历史
#[tauri::command]
pub async fn dataforge_get_history(app: AppHandle) -> Result<Vec<ExecutionRecord>, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("dataforge.json").map_err(|e| e.to_string())?;

    if let Some(val) = store.get("execution_history") {
        serde_json::from_value(val).map_err(|e| e.to_string())
    } else {
        Ok(vec![])
    }
}

/// 保存凭证
#[tauri::command]
pub async fn dataforge_save_credential(
    app: AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("credentials.json").map_err(|e| e.to_string())?;
    store.set(&key, serde_json::Value::String(value));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取凭证列表（只返回 key 和是否有值，不返回实际值）
#[tauri::command]
pub async fn dataforge_get_credentials(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("credentials.json").map_err(|e| e.to_string())?;

    let known_keys = vec![
        ("ARCHERY_COOKIE", "Archery Cookie"),
        ("ARCHERY_TOKEN", "Archery Token"),
        ("SAAS_TOKEN", "SaaS API Token"),
    ];

    let result: Vec<serde_json::Value> = known_keys
        .iter()
        .map(|(key, label)| {
            let has_value = store.get(key).is_some();
            serde_json::json!({
                "key": key,
                "label": label,
                "has_value": has_value,
            })
        })
        .collect();

    Ok(result)
}

// ── 工具函数 ──

fn detect_python() -> Result<String, String> {
    for name in &["python3", "python"] {
        if let Ok(output) = std::process::Command::new(name).arg("--version").output() {
            if output.status.success() {
                return Ok(name.to_string());
            }
        }
    }
    Err("未找到 Python，请确保 Python 3 已安装并在 PATH 中".to_string())
}

fn load_credentials(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("credentials.json").map_err(|e| e.to_string())?;
    let mut creds = HashMap::new();

    for key in &["ARCHERY_COOKIE", "ARCHERY_TOKEN", "SAAS_TOKEN"] {
        if let Some(val) = store.get(key) {
            if let Some(s) = val.as_str() {
                creds.insert(key.to_string(), s.to_string());
            }
        }
    }

    Ok(creds)
}
