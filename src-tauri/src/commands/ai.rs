use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

// ── 基础类型 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
}

impl Default for AIConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: String::new(),
            model: "gpt-4o".to_string(),
            temperature: 0.7,
            max_tokens: None,
        }
    }
}

// ── Function Calling 工具定义 ──

fn get_tools() -> Vec<serde_json::Value> {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "search_data_scripts",
                "description": "搜索可用的数据处理脚本。在用户想要导出数据、查询数据、处理数据时调用此工具来查找合适的脚本。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词，如客户名、数据类型、操作类型等"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_data_script",
                "description": "执行一个数据导入导出脚本。在确认脚本和参数后调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "script_id": {
                            "type": "string",
                            "description": "脚本注册表中的ID"
                        },
                        "params": {
                            "type": "object",
                            "description": "脚本参数键值对",
                            "additionalProperties": true
                        }
                    },
                    "required": ["script_id", "params"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_shell_command",
                "description": "执行一个 shell 命令。用于系统操作、文件管理等。请谨慎使用，避免危险操作。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要执行的 shell 命令"
                        }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_clipboard",
                "description": "读取系统剪贴板内容",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_clipboard",
                "description": "写入内容到系统剪贴板",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "要写入的文本" }
                    },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_knowledge_base",
                "description": "在本地知识库中检索相关信息。当用户提问的内容可能存在于已导入的文档中时调用此工具进行 RAG 检索增强。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "检索查询内容"
                        },
                        "top_k": {
                            "type": "integer",
                            "description": "返回结果数量，默认5",
                            "default": 5
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取本地文件内容。支持文本文件（如 .txt, .json, .csv, .md, .py 等）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件绝对路径"
                        },
                        "max_bytes": {
                            "type": "integer",
                            "description": "最大读取字节数，默认102400(100KB)",
                            "default": 102400
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "写入内容到本地文件。如果文件不存在则创建，存在则覆盖。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件绝对路径"
                        },
                        "content": {
                            "type": "string",
                            "description": "要写入的文本内容"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "列出指定目录中的文件和文件夹。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "目录绝对路径"
                        }
                    },
                    "required": ["path"]
                }
            }
        }
    ])
    .as_array()
    .unwrap()
    .clone()
}

fn get_system_prompt() -> String {
    "你是 mTools 的 AI 助手，一个强大的桌面效率工具。你可以：\n\
     1. 搜索和执行数据导入导出脚本（数据工坊）\n\
     2. 执行 shell 命令\n\
     3. 读写剪贴板\n\
     4. 搜索本地知识库（RAG 检索增强）\n\
     5. 读写本地文件、列出目录\n\n\
     当用户需要处理数据时，先用 search_data_scripts 搜索合适的脚本，\n\
     然后向用户确认参数，最后用 run_data_script 执行。\n\
     当用户提问的内容可能存在于知识库文档中时，使用 search_knowledge_base 检索相关信息，\n\
     并基于检索结果提供准确的回答，注明信息来源。\n\
     当用户需要操作文件时，使用 read_file / write_file / list_directory 工具。\n\
     回答使用中文，简洁专业。"
        .to_string()
}

// ── 工具执行 ──

async fn execute_tool(app: &AppHandle, name: &str, args: &str) -> Result<String, String> {
    let args_value: serde_json::Value =
        serde_json::from_str(args).unwrap_or(serde_json::Value::Object(Default::default()));

    match name {
        "search_data_scripts" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let results = super::data_forge::dataforge_search_scripts(app.clone(), query).await?;
            Ok(serde_json::to_string_pretty(&results).unwrap_or_default())
        }
        "run_data_script" => {
            let script_id = args_value["script_id"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let params: HashMap<String, serde_json::Value> = args_value["params"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            let result =
                super::data_forge::dataforge_run_script(app.clone(), script_id, params).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "run_shell_command" => {
            let command = args_value["command"].as_str().unwrap_or("echo hello");
            let output = std::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .output()
                .map_err(|e| format!("执行失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(format!(
                "exit_code: {}\nstdout:\n{}\nstderr:\n{}",
                output.status.code().unwrap_or(-1),
                stdout,
                stderr
            ))
        }
        "read_clipboard" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let text = app.clipboard().read_text().unwrap_or_default();
            Ok(text)
        }
        "write_clipboard" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let text = args_value["text"].as_str().unwrap_or("").to_string();
            app.clipboard()
                .write_text(&text)
                .map_err(|e| e.to_string())?;
            Ok("已写入剪贴板".to_string())
        }
        "search_knowledge_base" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let top_k = args_value["top_k"].as_u64().map(|v| v as usize);
            let results = super::rag::rag_search(app.clone(), query, top_k, None).await?;
            if results.is_empty() {
                Ok("知识库中未找到相关内容。".to_string())
            } else {
                let mut output = format!("在知识库中找到 {} 个相关片段:\n\n", results.len());
                for (i, r) in results.iter().enumerate() {
                    output.push_str(&format!(
                        "--- 片段 {} (来源: {}, 相似度: {:.1}%) ---\n{}\n\n",
                        i + 1,
                        r.chunk.metadata.source,
                        r.score * 100.0,
                        r.chunk.content
                    ));
                }
                Ok(output)
            }
        }
        "read_file" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            let max_bytes = args_value["max_bytes"].as_u64().unwrap_or(102400) as usize;
            let file_path = std::path::Path::new(&path);
            if !file_path.exists() {
                return Err(format!("文件不存在: {}", path));
            }
            let bytes = std::fs::read(&file_path).map_err(|e| format!("读取失败: {}", e))?;
            let truncated = if bytes.len() > max_bytes { &bytes[..max_bytes] } else { &bytes };
            let content = String::from_utf8_lossy(truncated).to_string();
            if bytes.len() > max_bytes {
                Ok(format!("{}\n\n[文件截断，已读取 {}/{} 字节]", content, max_bytes, bytes.len()))
            } else {
                Ok(content)
            }
        }
        "write_file" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            let content = args_value["content"].as_str().unwrap_or("").to_string();
            let file_path = std::path::Path::new(&path);
            // 自动创建父目录
            if let Some(parent) = file_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
            }
            std::fs::write(&file_path, &content).map_err(|e| format!("写入失败: {}", e))?;
            Ok(format!("已写入 {} ({} 字节)", path, content.len()))
        }
        "list_directory" => {
            let path = args_value["path"].as_str().unwrap_or(".").to_string();
            let dir_path = std::path::Path::new(&path);
            if !dir_path.exists() {
                return Err(format!("目录不存在: {}", path));
            }
            if !dir_path.is_dir() {
                return Err(format!("不是目录: {}", path));
            }
            let mut entries = Vec::new();
            let read_dir = std::fs::read_dir(&dir_path).map_err(|e| format!("读取目录失败: {}", e))?;
            for entry in read_dir {
                if let Ok(entry) = entry {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let ft = entry.file_type().map(|t| {
                        if t.is_dir() { "📁" } else if t.is_symlink() { "🔗" } else { "📄" }
                    }).unwrap_or("❓");
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        entries.push(format!("{} {}/", ft, name));
                    } else {
                        entries.push(format!("{} {} ({} bytes)", ft, name, size));
                    }
                }
            }
            entries.sort();
            Ok(format!("目录 {} 下共 {} 项:\n{}", path, entries.len(), entries.join("\n")))
        }
        _ => Err(format!("未知工具: {}", name)),
    }
}

// ── API 请求结构 ──

#[derive(Debug, Serialize)]
struct AgentRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    tools: Vec<serde_json::Value>,
    stream: bool,
}

// ── Tauri Commands ──

/// 非流式 AI 对话（保持向后兼容）
#[tauri::command]
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    config: AIConfig,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let request = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "stream": false,
    });

    let response = client
        .post(format!("{}/chat/completions", config.base_url))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let body = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("API 错误 ({}): {}", status, body));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;

    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "无回复内容".to_string())
}

/// 流式 AI 对话（支持 Function Calling）
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    messages: Vec<ChatMessage>,
    config: AIConfig,
    conversation_id: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let tools = get_tools();

    // 注入 system prompt
    let mut full_messages = vec![ChatMessage {
        role: "system".to_string(),
        content: Some(get_system_prompt()),
        tool_calls: None,
        tool_call_id: None,
        name: None,
    }];
    full_messages.extend(messages);

    let request = AgentRequest {
        model: config.model.clone(),
        messages: full_messages.clone(),
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        tools: tools.clone(),
        stream: true,
    };

    let response = client
        .post(format!("{}/chat/completions", config.base_url))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        let _ = app.emit(
            "ai-stream-error",
            serde_json::json!({
                "conversation_id": conversation_id,
                "error": format!("API 错误: {}", body),
            }),
        );
        return Err(format!("API 错误: {}", body));
    }

    // 流式读取 SSE — 收集 tool_calls
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut tc_args_buffer: HashMap<usize, String> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    if !line.starts_with("data: ") {
                        continue;
                    }
                    let data = &line[6..];
                    if data == "[DONE]" {
                        // 检查是否有 pending tool calls
                        if !pending_tool_calls.is_empty() {
                            // 先组装完整的 arguments
                            for (idx, args) in &tc_args_buffer {
                                if let Some(tc) = pending_tool_calls.get_mut(*idx) {
                                    tc.function.arguments = args.clone();
                                }
                            }
                            // 通知前端有工具调用
                            let _ = app.emit(
                                "ai-stream-tool-calls",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "tool_calls": &pending_tool_calls,
                                }),
                            );
                            // 执行工具并返回结果
                            let mut tool_messages = Vec::new();
                            for tc in &pending_tool_calls {
                                let result = execute_tool(&app, &tc.function.name, &tc.function.arguments).await;
                                let content = match result {
                                    Ok(r) => r,
                                    Err(e) => format!("工具执行失败: {}", e),
                                };
                                // 通知前端工具结果
                                let _ = app.emit(
                                    "ai-stream-tool-result",
                                    serde_json::json!({
                                        "conversation_id": conversation_id,
                                        "tool_call_id": tc.id,
                                        "name": tc.function.name,
                                        "result": &content,
                                    }),
                                );
                                tool_messages.push(ChatMessage {
                                    role: "tool".to_string(),
                                    content: Some(content),
                                    tool_calls: None,
                                    tool_call_id: Some(tc.id.clone()),
                                    name: Some(tc.function.name.clone()),
                                });
                            }

                            // 用工具结果继续对话（非流式，简化）
                            full_messages.push(ChatMessage {
                                role: "assistant".to_string(),
                                content: None,
                                tool_calls: Some(pending_tool_calls.clone()),
                                tool_call_id: None,
                                name: None,
                            });
                            full_messages.extend(tool_messages);

                            // 第二轮请求（非流式获取最终回复，通过事件推送）
                            let follow_request = serde_json::json!({
                                "model": config.model,
                                "messages": full_messages,
                                "temperature": config.temperature,
                                "max_tokens": config.max_tokens,
                                "stream": false,
                            });

                            match client
                                .post(format!("{}/chat/completions", config.base_url))
                                .header("Authorization", format!("Bearer {}", config.api_key))
                                .header("Content-Type", "application/json")
                                .json(&follow_request)
                                .send()
                                .await
                            {
                                Ok(resp) => {
                                    if let Ok(body) = resp.text().await {
                                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
                                            if let Some(content) = parsed["choices"][0]["message"]["content"].as_str() {
                                                let _ = app.emit(
                                                    "ai-stream-chunk",
                                                    serde_json::json!({
                                                        "conversation_id": conversation_id,
                                                        "content": content,
                                                    }),
                                                );
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    let _ = app.emit(
                                        "ai-stream-error",
                                        serde_json::json!({
                                            "conversation_id": conversation_id,
                                            "error": format!("后续请求失败: {}", e),
                                        }),
                                    );
                                }
                            }
                        }

                        let _ = app.emit(
                            "ai-stream-done",
                            serde_json::json!({ "conversation_id": conversation_id }),
                        );
                        return Ok(());
                    }

                    // 解析 delta
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let delta = &parsed["choices"][0]["delta"];

                        // 普通内容
                        if let Some(content) = delta["content"].as_str() {
                            let _ = app.emit(
                                "ai-stream-chunk",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "content": content,
                                }),
                            );
                        }

                        // tool_calls delta
                        if let Some(tcs) = delta["tool_calls"].as_array() {
                            for tc in tcs {
                                let idx = tc["index"].as_u64().unwrap_or(0) as usize;

                                // 新的 tool call
                                if let Some(func) = tc["function"].as_object() {
                                    if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                                        let id = tc["id"]
                                            .as_str()
                                            .unwrap_or("tc_0")
                                            .to_string();
                                        while pending_tool_calls.len() <= idx {
                                            pending_tool_calls.push(ToolCall {
                                                id: String::new(),
                                                call_type: "function".to_string(),
                                                function: FunctionCall {
                                                    name: String::new(),
                                                    arguments: String::new(),
                                                },
                                            });
                                        }
                                        pending_tool_calls[idx].id = id;
                                        pending_tool_calls[idx].function.name = name.to_string();
                                    }

                                    // arguments delta（逐步拼接）
                                    if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                                        tc_args_buffer
                                            .entry(idx)
                                            .or_default()
                                            .push_str(args);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "ai-stream-error",
                    serde_json::json!({
                        "conversation_id": conversation_id,
                        "error": format!("流读取错误: {}", e),
                    }),
                );
                return Err(format!("流读取错误: {}", e));
            }
        }
    }

    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    Ok(())
}

/// 获取 AI 配置
#[tauri::command]
pub async fn ai_get_config(app: AppHandle) -> Result<AIConfig, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;

    if let Some(val) = store.get("ai_config") {
        serde_json::from_value(val).map_err(|e| e.to_string())
    } else {
        Ok(AIConfig::default())
    }
}

/// 保存 AI 配置
#[tauri::command]
pub async fn ai_set_config(app: AppHandle, config: AIConfig) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    store.set(
        "ai_config",
        serde_json::to_value(&config).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
