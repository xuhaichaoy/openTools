use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Listener, Manager};

// ── 类型定义 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowTrigger {
    #[serde(rename = "type")]
    pub trigger_type: String, // manual | keyword | hotkey | clipboard | cron | interval | once
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub hotkey: Option<String>,
    /// Cron 表达式（type=cron 时使用）
    #[serde(default)]
    pub cron: Option<String>,
    /// 间隔秒数（type=interval 时使用）
    #[serde(default, rename = "intervalSeconds")]
    pub interval_seconds: Option<u64>,
    /// 一次性触发时间 ISO 字符串（type=once 时使用）
    #[serde(default, rename = "onceAt")]
    pub once_at: Option<String>,
    /// 定时任务是否启用
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowVariable {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub var_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<SelectOption>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SelectOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowStep {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub step_type: String,
    pub config: serde_json::Value,
    #[serde(default)]
    pub output_var: Option<String>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub on_error: Option<String>,
}

// 可视化画布节点
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowGraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub label: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub output_var: Option<String>,
    #[serde(default)]
    pub on_error: Option<String>,
    pub position: GraphPosition,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphPosition {
    pub x: f64,
    pub y: f64,
}

// 可视化画布连线
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowGraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default, rename = "sourceHandle")]
    pub source_handle: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    #[serde(default)]
    pub category: String,
    pub trigger: WorkflowTrigger,
    pub steps: Vec<WorkflowStep>,
    #[serde(default)]
    pub nodes: Option<Vec<WorkflowGraphNode>>,
    #[serde(default)]
    pub edges: Option<Vec<WorkflowGraphEdge>>,
    #[serde(default)]
    pub variables: Option<Vec<WorkflowVariable>>,
    pub builtin: bool,
    pub created_at: u64,
}

fn get_workflows_dir(app: &AppHandle) -> PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = data_dir.join("workflows");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    dir
}

// ── CRUD ──

#[tauri::command]
pub async fn workflow_list(app: AppHandle) -> Result<Vec<Workflow>, String> {
    let dir = get_workflows_dir(&app);
    let mut workflows = Vec::new();

    if !dir.exists() {
        return Ok(workflows);
    }

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(wf) = serde_json::from_str::<Workflow>(&content) {
                        workflows.push(wf);
                    }
                }
            }
        }
    }

    workflows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(workflows)
}

#[tauri::command]
pub async fn workflow_create(app: AppHandle, workflow: Workflow) -> Result<Workflow, String> {
    let dir = get_workflows_dir(&app);
    let file_path = dir.join(format!("{}.json", workflow.id));
    let json = serde_json::to_string_pretty(&workflow).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, json).map_err(|e| format!("保存工作流失败: {}", e))?;
    Ok(workflow)
}

#[tauri::command]
pub async fn workflow_update(app: AppHandle, workflow: Workflow) -> Result<Workflow, String> {
    let dir = get_workflows_dir(&app);
    let file_path = dir.join(format!("{}.json", workflow.id));
    let json = serde_json::to_string_pretty(&workflow).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, json).map_err(|e| format!("更新工作流失败: {}", e))?;
    Ok(workflow)
}

#[tauri::command]
pub async fn workflow_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = get_workflows_dir(&app);
    let file_path = dir.join(format!("{}.json", id));
    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| format!("删除工作流失败: {}", e))?;
    }
    Ok(())
}

// ── 执行引擎 ──

/// 变量插值
fn interpolate(template: &str, context: &HashMap<String, String>) -> String {
    let mut result = template.to_string();
    for (key, value) in context {
        result = result.replace(&format!("{{{{{}}}}}", key), value);
    }
    result
}

/// 图节点转步骤（供 execute_step 复用）
fn node_to_step(node: &WorkflowGraphNode) -> WorkflowStep {
    WorkflowStep {
        id: node.id.clone(),
        name: node.label.clone(),
        step_type: node.node_type.clone(),
        config: node.config.clone(),
        output_var: node.output_var.clone(),
        condition: None,
        on_error: node.on_error.clone(),
    }
}

/// 邻接表：source -> [(target, source_handle)]
fn build_adjacency(edges: &[WorkflowGraphEdge]) -> HashMap<String, Vec<(String, Option<String>)>> {
    let mut adj: HashMap<String, Vec<(String, Option<String>)>> = HashMap::new();
    for e in edges {
        adj.entry(e.source.clone())
            .or_default()
            .push((e.target.clone(), e.source_handle.clone()));
    }
    adj
}

/// DAG 执行：从 __start__ BFS，condition 节点只沿匹配的边继续
async fn execute_dag(
    app: &AppHandle,
    workflow_id: &str,
    nodes: &[WorkflowGraphNode],
    edges: &[WorkflowGraphEdge],
    context: &mut HashMap<String, String>,
) -> Result<String, String> {
    let adj = build_adjacency(edges);
    let node_map: HashMap<String, &WorkflowGraphNode> = nodes.iter().map(|n| (n.id.clone(), n)).collect();
    let step_ids: HashSet<String> = nodes
        .iter()
        .filter(|n| n.node_type != "start" && n.node_type != "end")
        .map(|n| n.id.clone())
        .collect();
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();

    visited.insert("__start__".to_string());
    for (target, _) in adj.get("__start__").unwrap_or(&vec![]) {
        queue.push_back(target.clone());
    }

    while let Some(node_id) = queue.pop_front() {
        if node_id == "__end__" {
            continue;
        }
        if visited.contains(&node_id) {
            continue;
        }
        let node = match node_map.get(&node_id) {
            Some(n) => n,
            None => continue,
        };
        if node.node_type == "start" || node.node_type == "end" {
            visited.insert(node_id.clone());
            for (t, _) in adj.get(&node_id).unwrap_or(&vec![]) {
                queue.push_back(t.clone());
            }
            continue;
        }

        let step = node_to_step(node);
        let _ = app.emit(
            "workflow-step-start",
            serde_json::json!({ "workflowId": workflow_id, "stepId": step.id, "name": step.name }),
        );

        let result = match execute_step(app, &step, context).await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    "workflow-step-error",
                    serde_json::json!({ "workflowId": workflow_id, "stepId": step.id, "error": e.to_string() }),
                );
                match step.on_error.as_deref() {
                    Some("skip") => {
                        visited.insert(node_id.clone());
                        for (t, _) in adj.get(&node_id).unwrap_or(&vec![]) {
                            queue.push_back(t.clone());
                        }
                        continue;
                    }
                    Some("retry") => {
                        match execute_step(app, &step, context).await {
                            Ok(r) => r,
                            Err(e2) => return Err(format!("步骤 {} 重试失败: {}", step.name, e2)),
                        }
                    }
                    _ => return Err(format!("步骤 {} 执行失败: {}", step.name, e)),
                }
            }
        };

        if let Some(ref var) = step.output_var {
            context.insert(var.clone(), result.clone());
        }
        match step.step_type.as_str() {
            "notification" | "clipboard_write" => {}
            _ => {
                context.insert("prev.output".to_string(), result.clone());
            }
        }

        let _ = app.emit(
            "workflow-step-done",
            serde_json::json!({ "workflowId": workflow_id, "stepId": step.id, "result": result }),
        );
        visited.insert(node_id.clone());

        let empty: Vec<(String, Option<String>)> = vec![];
        let out_edges = adj.get(&node_id).unwrap_or(&empty);
        if node.node_type == "condition" {
            for (t, h) in out_edges {
                if h.as_deref() == Some(result.trim()) {
                    queue.push_back(t.clone());
                }
            }
        } else {
            for (t, _) in out_edges {
                queue.push_back(t.clone());
            }
        }
    }

    for sid in &step_ids {
        if !visited.contains(sid) {
            let _ = app.emit(
                "workflow-step-skipped",
                serde_json::json!({ "workflowId": workflow_id, "stepId": sid }),
            );
        }
    }

    Ok(context.get("prev.output").cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn workflow_execute(
    app: AppHandle,
    workflow: Workflow,
    vars: HashMap<String, String>,
) -> Result<String, String> {
    let mut context = vars;

    let _ = app.emit(
        "workflow-start",
        serde_json::json!({ "workflowId": workflow.id, "name": workflow.name }),
    );

    let final_output = if let (Some(ref nodes), Some(ref edges)) = (&workflow.nodes, &workflow.edges) {
        if !nodes.is_empty() && !edges.is_empty() {
            let out = execute_dag(&app, &workflow.id, nodes, edges, &mut context).await?;
            out
        } else {
            execute_linear(&app, &workflow, &mut context).await?
        }
    } else {
        execute_linear(&app, &workflow, &mut context).await?
    };

    let _ = app.emit(
        "workflow-done",
        serde_json::json!({ "workflowId": workflow.id, "result": final_output }),
    );

    Ok(final_output)
}

/// 线性执行（兼容无 nodes/edges 的旧工作流）
async fn execute_linear(
    app: &AppHandle,
    workflow: &Workflow,
    context: &mut HashMap<String, String>,
) -> Result<String, String> {
    for step in &workflow.steps {
        if let Some(cond) = &step.condition {
            let evaluated = interpolate(cond, context);
            if evaluated.trim().is_empty() || evaluated.trim() == "''" || evaluated.trim() == "\"\"" {
                continue;
            }
        }

        let _ = app.emit(
            "workflow-step-start",
            serde_json::json!({ "workflowId": workflow.id, "stepId": step.id, "name": step.name }),
        );

        let result = match execute_step(app, step, context).await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    "workflow-step-error",
                    serde_json::json!({ "workflowId": workflow.id, "stepId": step.id, "error": e.to_string() }),
                );
                match step.on_error.as_deref() {
                    Some("skip") => continue,
                    Some("retry") => {
                        match execute_step(app, step, context).await {
                            Ok(r) => r,
                            Err(e2) => return Err(format!("步骤 {} 重试失败: {}", step.name, e2)),
                        }
                    }
                    _ => return Err(format!("步骤 {} 执行失败: {}", step.name, e)),
                }
            }
        };

        if let Some(var) = &step.output_var {
            context.insert(var.clone(), result.clone());
        }
        match step.step_type.as_str() {
            "notification" | "clipboard_write" => {}
            _ => {
                context.insert("prev.output".to_string(), result.clone());
            }
        }

        let _ = app.emit(
            "workflow-step-done",
            serde_json::json!({ "workflowId": workflow.id, "stepId": step.id, "result": result }),
        );
    }

    Ok(context.get("prev.output").cloned().unwrap_or_default())
}

async fn execute_step(
    app: &AppHandle,
    step: &WorkflowStep,
    context: &HashMap<String, String>,
) -> Result<String, String> {
    match step.step_type.as_str() {
        "clipboard_read" => {
            let app_clone = app.clone();
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
            app.run_on_main_thread(move || {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let text = app_clone.clipboard().read_text().unwrap_or_default();
                let _ = tx.send(Ok(text));
            })
            .map_err(|e| e.to_string())?;
            let text = rx.await.map_err(|_| "剪贴板读取超时".to_string())??;
            Ok(text)
        }
        "clipboard_write" => {
            let text = step.config.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let text = interpolate(text, context);
            let app_clone = app.clone();
            let text_clone = text.clone();
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
            app.run_on_main_thread(move || {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let r = app_clone.clipboard().write_text(&text_clone).map_err(|e| e.to_string());
                let _ = tx.send(r);
            })
            .map_err(|e| e.to_string())?;
            rx.await.map_err(|_| "剪贴板写入超时".to_string())??;
            Ok(text)
        }
        "ai_chat" => {
            let prompt = step.config.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            let prompt = interpolate(prompt, context);
            let system_prompt = step.config.get("system_prompt").and_then(|v| v.as_str()).unwrap_or("你是一个有用的助手。回答使用中文。");
            let system_prompt = interpolate(system_prompt, context);
            let model = step.config.get("model").and_then(|v| v.as_str()).unwrap_or("gpt-4o");
            let temperature = step.config.get("temperature").and_then(|v| v.as_f64()).unwrap_or(0.7) as f32;

            // 加载配置获取 API key
            use tauri_plugin_store::StoreExt;
            let store = app.store("config.json").map_err(|e| e.to_string())?;
            let ai_config: super::ai::AIConfig = store.get("ai_config")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();

            let client = reqwest::Client::new();
            let request = serde_json::json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": prompt }
                ],
                "temperature": temperature,
                "stream": false,
            });

            let response = client
                .post(format!("{}/chat/completions", ai_config.base_url))
                .header("Authorization", format!("Bearer {}", ai_config.api_key))
                .header("Content-Type", "application/json")
                .json(&request)
                .send()
                .await
                .map_err(|e| format!("AI 请求失败: {}", e))?;

            let body = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
            let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;
            let content = parsed["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string();
            Ok(content)
        }
        "script" => {
            let script_type = step.config.get("type").and_then(|v| v.as_str()).unwrap_or("shell");
            let script = step.config.get("script").and_then(|v| v.as_str()).unwrap_or("");
            let script = interpolate(script, context);

            let (cmd, args) = match script_type {
                "python" => ("python3".to_string(), vec!["-c".to_string(), script.clone()]),
                _ => ("sh".to_string(), vec!["-c".to_string(), script.clone()]),
            };

            // 使用 tokio::process 避免阻塞异步运行时
            let output = tokio::process::Command::new(&cmd)
                .args(&args)
                .output()
                .await
                .map_err(|e| format!("脚本执行失败: {}", e))?;

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            if !output.status.success() {
                return Err(format!("脚本错误: {}", stderr));
            }
            Ok(stdout.trim().to_string())
        }
        "transform" => {
            let transform_type = step.config.get("type").and_then(|v| v.as_str()).unwrap_or("template");
            let input = step.config.get("input").and_then(|v| v.as_str()).unwrap_or("{{prev.output}}");
            let input = interpolate(input, context);

            match transform_type {
                "template" => {
                    let template = step.config.get("template").and_then(|v| v.as_str()).unwrap_or("");
                    Ok(interpolate(template, context))
                }
                "replace" => {
                    let pattern = step.config.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
                    let replacement = step.config.get("replacement").and_then(|v| v.as_str()).unwrap_or("");
                    Ok(input.replace(pattern, replacement))
                }
                "split" => {
                    let delimiter = step.config.get("delimiter").and_then(|v| v.as_str()).unwrap_or("\n");
                    let index = step.config.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    let parts: Vec<&str> = input.split(delimiter).collect();
                    Ok(parts.get(index).unwrap_or(&"").to_string())
                }
                _ => Ok(input),
            }
        }
        "http" => {
            let method = step.config.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
            let url = step.config.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let url = interpolate(url, context);
            let body_str = step.config.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let body_str = interpolate(body_str, context);

            let client = reqwest::Client::new();
            let mut req = match method {
                "POST" => client.post(&url),
                "PUT" => client.put(&url),
                "DELETE" => client.delete(&url),
                _ => client.get(&url),
            };

            if let Some(headers) = step.config.get("headers").and_then(|v| v.as_object()) {
                for (k, v) in headers {
                    if let Some(v_str) = v.as_str() {
                        req = req.header(k.as_str(), interpolate(v_str, context));
                    }
                }
            }

            if !body_str.is_empty() {
                req = req.body(body_str);
            }

            let response = req.send().await.map_err(|e| format!("HTTP 请求失败: {}", e))?;
            let text = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
            Ok(text)
        }
        "file_read" => {
            let path = step.config.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let path = interpolate(path, context);
            std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
        }
        "file_write" => {
            let path = step.config.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let path = interpolate(path, context);
            let content = step.config.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let content = interpolate(content, context);
            if let Some(parent) = std::path::Path::new(&path).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&path, &content).map_err(|e| format!("写入文件失败: {}", e))?;
            Ok(format!("已写入 {}", path))
        }
        "notification" => {
            let message = step.config.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let message = interpolate(message, context);
            use tauri_plugin_notification::NotificationExt;
            let _ = app.notification().builder().title("mTools").body(&message).show();
            Ok(message)
        }
        "user_input" => {
            // 用户输入步骤 — 在前端处理，此处返回已有变量
            let var_name = step.config.get("variable").and_then(|v| v.as_str()).unwrap_or("input");
            Ok(context.get(var_name).cloned().unwrap_or_default())
        }
        "condition" => {
            // 条件判断 — 对表达式做变量插值，非空即为 true
            let expr = step.config.get("expression").and_then(|v| v.as_str()).unwrap_or("");
            let evaluated = interpolate(expr, context);
            let is_true = !evaluated.trim().is_empty()
                && evaluated.trim() != "false"
                && evaluated.trim() != "0"
                && evaluated.trim() != "''"
                && evaluated.trim() != "\"\"";
            Ok(if is_true { "true".to_string() } else { "false".to_string() })
        }
        "plugin_action" => {
            // 插件动作 — 通过事件桥委托前端执行
            let plugin_id = step.config.get("pluginId").and_then(|v| v.as_str()).unwrap_or("");
            let action_name = step.config.get("actionName").and_then(|v| v.as_str()).unwrap_or("");
            let params_raw = step.config.get("params").and_then(|v| v.as_str()).unwrap_or("{}");
            let params_raw = interpolate(params_raw, context);

            // 生成唯一请求 ID
            let request_id = format!("wf-pa-{}", uuid::Uuid::new_v4());
            let request_id_clone = request_id.clone();

            // 向前端发送执行请求
            let _ = app.emit("workflow-plugin-action", serde_json::json!({
                "requestId": request_id,
                "pluginId": plugin_id,
                "actionName": action_name,
                "params": params_raw,
            }));

            // 监听前端返回的结果
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
            let app_clone = app.clone();
            let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
            let tx_clone = tx.clone();

            let _handler = app_clone.listen("workflow-plugin-action-result", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if payload.get("requestId").and_then(|v| v.as_str()) == Some(&request_id_clone) {
                        let result = if let Some(err) = payload.get("error").and_then(|v| v.as_str()) {
                            Err(err.to_string())
                        } else {
                            Ok(payload.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string())
                        };
                        if let Ok(mut guard) = tx_clone.lock() {
                            if let Some(sender) = guard.take() {
                                let _ = sender.send(result);
                            }
                        }
                    }
                }
            });

            // 等待结果（最多 60 秒超时）
            match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("插件动作结果通道关闭".to_string()),
                Err(_) => Err("插件动作执行超时（60s）".to_string()),
            }
        }
        _ => Err(format!("未知步骤类型: {}", step.step_type)),
    }
}

// ── 定时调度 ──

use std::sync::{Arc, Mutex};
use once_cell::sync::Lazy;

/// 活跃定时任务: workflow_id → JoinHandle（用于取消）
static SCHEDULED_TASKS: Lazy<Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 启动所有定时工作流的调度（应用启动时调用）
#[tauri::command]
pub async fn workflow_scheduler_start(app: AppHandle) -> Result<String, String> {
    let workflows = workflow_list(app.clone()).await?;
    let mut count = 0;
    for wf in &workflows {
        let trigger = &wf.trigger;
        let enabled = trigger.enabled.unwrap_or(true);
        if !enabled {
            continue;
        }
        match trigger.trigger_type.as_str() {
            "cron" | "interval" | "once" => {
                schedule_workflow(app.clone(), wf.clone());
                count += 1;
            }
            _ => {}
        }
    }
    Ok(format!("已启动 {} 个定时任务", count))
}

/// 停止所有定时任务
#[tauri::command]
pub async fn workflow_scheduler_stop() -> Result<(), String> {
    if let Ok(mut tasks) = SCHEDULED_TASKS.lock() {
        for (_, handle) in tasks.drain() {
            handle.abort();
        }
    }
    Ok(())
}

/// 重新加载单个工作流的调度（创建/更新/删除后调用）
#[tauri::command]
pub async fn workflow_scheduler_reload(app: AppHandle, workflow_id: String) -> Result<(), String> {
    // 先取消旧任务
    if let Ok(mut tasks) = SCHEDULED_TASKS.lock() {
        if let Some(handle) = tasks.remove(&workflow_id) {
            handle.abort();
        }
    }

    // 如果工作流仍存在且是定时类型，重新调度
    let dir = get_workflows_dir(&app);
    let path = dir.join(format!("{}.json", workflow_id));
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(wf) = serde_json::from_str::<Workflow>(&content) {
                let enabled = wf.trigger.enabled.unwrap_or(true);
                if enabled {
                    match wf.trigger.trigger_type.as_str() {
                        "cron" | "interval" | "once" => {
                            schedule_workflow(app, wf);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(())
}

/// 获取所有定时任务的状态
#[tauri::command]
pub async fn workflow_scheduler_status() -> Result<Vec<String>, String> {
    let ids: Vec<String> = SCHEDULED_TASKS
        .lock()
        .map_err(|e| e.to_string())?
        .keys()
        .cloned()
        .collect();
    Ok(ids)
}

fn schedule_workflow(app: AppHandle, wf: Workflow) {
    let wf_id = wf.id.clone();
    let trigger = wf.trigger.clone();

    let handle = tokio::spawn(async move {
        match trigger.trigger_type.as_str() {
            "interval" => {
                let secs = trigger.interval_seconds.unwrap_or(3600);
                let duration = std::time::Duration::from_secs(secs);
                loop {
                    tokio::time::sleep(duration).await;
                    let _ = trigger_workflow_execution(&app, &wf.id, &wf.name).await;
                }
            }
            "once" => {
                if let Some(once_at) = &trigger.once_at {
                    if let Ok(target) = chrono::DateTime::parse_from_rfc3339(once_at) {
                        let now = chrono::Utc::now();
                        let target_utc = target.with_timezone(&chrono::Utc);
                        if target_utc > now {
                            let wait = (target_utc - now).to_std().unwrap_or_default();
                            tokio::time::sleep(wait).await;
                            let _ = trigger_workflow_execution(&app, &wf.id, &wf.name).await;
                        }
                    }
                }
            }
            "cron" => {
                if let Some(cron_expr) = &trigger.cron {
                    use chrono::Timelike;
                    // 简易 cron 调度：每分钟检查一次是否匹配
                    // 支持 "分 时 日 月 周" 五字段格式
                    let expr = cron_expr.clone();
                    loop {
                        // 等到下一个整分钟
                        let now = chrono::Local::now();
                        let secs_to_next_min = 60 - now.second() as u64;
                        tokio::time::sleep(std::time::Duration::from_secs(secs_to_next_min)).await;

                        let now = chrono::Local::now();
                        if cron_matches(&expr, &now) {
                            let _ = trigger_workflow_execution(&app, &wf.id, &wf.name).await;
                        }
                    }
                }
            }
            _ => {}
        }
    });

    if let Ok(mut tasks) = SCHEDULED_TASKS.lock() {
        tasks.insert(wf_id, handle);
    }
}

/// 触发工作流执行并发送系统通知
async fn trigger_workflow_execution(app: &AppHandle, wf_id: &str, wf_name: &str) -> Result<(), String> {
    // 通过事件通知前端执行工作流
    let _ = app.emit("workflow-scheduled-trigger", serde_json::json!({
        "workflowId": wf_id,
        "workflowName": wf_name,
        "time": chrono::Local::now().format("%H:%M:%S").to_string(),
    }));

    // 发送系统通知
    let _ = app.emit("send-notification", serde_json::json!({
        "title": "定时任务触发",
        "body": format!("工作流「{}」已开始执行", wf_name),
    }));

    Ok(())
}

/// 简易 cron 匹配（支持 5 字段：分 时 日 月 周）
fn cron_matches(expr: &str, now: &chrono::DateTime<chrono::Local>) -> bool {
    use chrono::Datelike;
    use chrono::Timelike;
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }

    let minute = now.minute();
    let hour = now.hour();
    let day = now.day();
    let month = now.month();
    let weekday = now.weekday().num_days_from_monday(); // 0=Mon, 6=Sun

    cron_field_matches(fields[0], minute)
        && cron_field_matches(fields[1], hour)
        && cron_field_matches(fields[2], day)
        && cron_field_matches(fields[3], month)
        && cron_field_matches_weekday(fields[4], weekday)
}

/// 匹配单个 cron 字段（支持 *, 数字, 逗号列表, 范围 x-y, 步进 */n）
fn cron_field_matches(field: &str, value: u32) -> bool {
    if field == "*" {
        return true;
    }
    for part in field.split(',') {
        let part = part.trim();
        // 步进: */n 或 x/n
        if part.contains('/') {
            let segs: Vec<&str> = part.split('/').collect();
            if segs.len() == 2 {
                let step: u32 = segs[1].parse().unwrap_or(1);
                if step == 0 {
                    continue;
                }
                let base: u32 = if segs[0] == "*" {
                    0
                } else {
                    segs[0].parse().unwrap_or(0)
                };
                if (value >= base) && ((value - base) % step == 0) {
                    return true;
                }
            }
            continue;
        }
        // 范围: x-y
        if part.contains('-') {
            let segs: Vec<&str> = part.split('-').collect();
            if segs.len() == 2 {
                let lo: u32 = segs[0].parse().unwrap_or(0);
                let hi: u32 = segs[1].parse().unwrap_or(0);
                if value >= lo && value <= hi {
                    return true;
                }
            }
            continue;
        }
        // 精确匹配
        if let Ok(v) = part.parse::<u32>() {
            if v == value {
                return true;
            }
        }
    }
    false
}

/// 周几字段匹配（支持 0-7 格式，0 和 7 都表示周日）
fn cron_field_matches_weekday(field: &str, weekday_mon0: u32) -> bool {
    if field == "*" {
        return true;
    }
    // 将 Monday=0 格式转为 Sunday=0 格式（cron 标准）
    let weekday_sun0 = if weekday_mon0 == 6 { 0 } else { weekday_mon0 + 1 };
    for part in field.split(',') {
        let part = part.trim();
        if part.contains('-') {
            let segs: Vec<&str> = part.split('-').collect();
            if segs.len() == 2 {
                let lo: u32 = segs[0].parse().unwrap_or(0);
                let hi: u32 = segs[1].parse().unwrap_or(0);
                // 处理 0/7 统一为 Sunday
                let lo = if lo == 7 { 0 } else { lo };
                let hi = if hi == 7 { 0 } else { hi };
                if lo <= hi {
                    if weekday_sun0 >= lo && weekday_sun0 <= hi {
                        return true;
                    }
                } else {
                    // 跨周 (如 5-1 表示周五到周一)
                    if weekday_sun0 >= lo || weekday_sun0 <= hi {
                        return true;
                    }
                }
            }
            continue;
        }
        if let Ok(v) = part.parse::<u32>() {
            let v = if v == 7 { 0 } else { v };
            if v == weekday_sun0 {
                return true;
            }
        }
    }
    false
}
