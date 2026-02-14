use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

// ── 类型定义 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowTrigger {
    #[serde(rename = "type")]
    pub trigger_type: String, // manual | keyword | hotkey | clipboard
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub hotkey: Option<String>,
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
        _ => Err(format!("未知步骤类型: {}", step.step_type)),
    }
}
