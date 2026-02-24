use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

use super::request::{build_api_request, build_anthropic_request};
use super::stream::StreamCancellation;
use super::types::{AIConfig, ChatMessage, FunctionCall, ToolCall};
use crate::error::AppError;

/// Agent 专用流式对话 — 前端传入 tools 定义，后端不执行工具
/// 收到 tool_calls 时通过事件通知前端，由 Agent 自行执行
#[tauri::command]
pub async fn ai_agent_stream(
    app: AppHandle,
    messages: Vec<ChatMessage>,
    config: AIConfig,
    tools: Vec<serde_json::Value>,
    conversation_id: String,
) -> Result<(), AppError> {
    let protocol = config.protocol.as_deref().unwrap_or("openai");
    if protocol == "anthropic" {
        return agent_stream_anthropic(&app, messages, &config, &tools, &conversation_id)
            .await
            .map_err(AppError::Custom);
    }
    agent_stream_openai(&app, messages, &config, &tools, &conversation_id).await
}

/// OpenAI 协议的 Agent 流式处理
async fn agent_stream_openai(
    app: &AppHandle,
    messages: Vec<ChatMessage>,
    config: &AIConfig,
    tools: &[serde_json::Value],
    conversation_id: &str,
) -> Result<(), AppError> {
    let client = reqwest::Client::new();
    let cancellation = app.state::<StreamCancellation>();
    cancellation.reset(conversation_id);

    let mut request = build_api_request(
        &config.model,
        &messages,
        config.temperature,
        config.max_tokens,
        tools,
        true,
    );

    if let Some(ref tid) = config.team_id {
        request["team_id"] = serde_json::json!(tid);
        if let Some(ref tcid) = config.team_config_id {
            request["team_config_id"] = serde_json::json!(tcid);
        }
    }

    let response = client
        .post(format!("{}/chat/completions", config.base_url))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        let _ = app.emit(
            "ai-stream-error",
            serde_json::json!({
                "conversation_id": conversation_id,
                "error": format!("API 错误: {}", body),
            }),
        );
        cancellation.clear(conversation_id);
        return Err(AppError::Custom(format!("API 错误: {}", body)));
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut tc_args_buffer: HashMap<usize, String> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        if cancellation.is_cancelled(conversation_id) {
            cancellation.clear(conversation_id);
            let _ = app.emit(
                "ai-stream-done",
                serde_json::json!({ "conversation_id": conversation_id }),
            );
            return Ok(());
        }

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
                        if !pending_tool_calls.is_empty() {
                            for (idx, args) in &tc_args_buffer {
                                if let Some(tc) = pending_tool_calls.get_mut(*idx) {
                                    tc.function.arguments = args.clone();
                                }
                            }
                            let _ = app.emit(
                                "ai-agent-tool-calls",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "tool_calls": &pending_tool_calls,
                                }),
                            );
                        }

                        let _ = app.emit(
                            "ai-stream-done",
                            serde_json::json!({ "conversation_id": conversation_id }),
                        );
                        cancellation.clear(conversation_id);
                        return Ok(());
                    }

                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let delta = &parsed["choices"][0]["delta"];

                        if let Some(content) = delta["content"].as_str() {
                            let _ = app.emit(
                                "ai-stream-chunk",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "content": content,
                                }),
                            );
                        }

                        if let Some(tcs) = delta["tool_calls"].as_array() {
                            for tc in tcs {
                                let idx = tc["index"].as_u64().unwrap_or(0) as usize;
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
                                if let Some(id) = tc["id"].as_str() {
                                    pending_tool_calls[idx].id = id.to_string();
                                }
                                if let Some(func) = tc["function"].as_object() {
                                    if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                                        pending_tool_calls[idx].function.name = name.to_string();
                                    }
                                    if let Some(args) =
                                        func.get("arguments").and_then(|a| a.as_str())
                                    {
                                        tc_args_buffer.entry(idx).or_default().push_str(args);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                cancellation.clear(conversation_id);
                let _ = app.emit(
                    "ai-stream-error",
                    serde_json::json!({
                        "conversation_id": conversation_id,
                        "error": format!("流读取错误: {}", e),
                    }),
                );
                return Err(AppError::Custom(format!("流读取错误: {}", e)));
            }
        }
    }

    cancellation.clear(conversation_id);
    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    Ok(())
}

/// Anthropic 协议的 Agent 流式处理（不执行工具，仅通知前端）
async fn agent_stream_anthropic(
    app: &AppHandle,
    messages: Vec<ChatMessage>,
    config: &AIConfig,
    tools: &[serde_json::Value],
    conversation_id: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let cancellation = app.state::<StreamCancellation>();
    cancellation.reset(conversation_id);

    let system_prompt = messages
        .iter()
        .filter(|m| m.role == "system")
        .filter_map(|m| m.content.as_deref())
        .collect::<Vec<_>>()
        .join("\n\n");

    let non_system_messages: Vec<ChatMessage> = messages
        .into_iter()
        .filter(|m| m.role != "system")
        .collect();

    let request = build_anthropic_request(
        &config.model,
        &non_system_messages,
        &system_prompt,
        config.temperature,
        config.max_tokens,
        tools,
        true,
    );

    let url = format!("{}/v1/messages", config.base_url);
    let is_team = config.source.as_deref() == Some("team")
        || config.source.as_deref() == Some("platform");

    let mut req_builder = client
        .post(&url)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json");
    if is_team {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", config.api_key));
    }

    let final_request = if is_team {
        if let Some(ref tid) = config.team_id {
            let mut r = request.clone();
            r["team_id"] = serde_json::json!(tid);
            if let Some(ref tcid) = config.team_config_id {
                r["team_config_id"] = serde_json::json!(tcid);
            }
            r
        } else {
            request
        }
    } else {
        request
    };

    let response = req_builder
        .json(&final_request)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let readable = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| body[..body.len().min(300)].to_string());
        let error_msg = format!("Anthropic API 错误: HTTP {} — {}", status_code, readable);
        let _ = app.emit(
            "ai-stream-error",
            serde_json::json!({
                "conversation_id": conversation_id,
                "error": &error_msg,
            }),
        );
        cancellation.clear(conversation_id);
        return Err(error_msg);
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut current_tool_id = String::new();
    let mut current_tool_name = String::new();
    let mut current_tool_input = String::new();
    let mut has_tool_use = false;

    while let Some(chunk) = stream.next().await {
        if cancellation.is_cancelled(conversation_id) {
            cancellation.clear(conversation_id);
            let _ = app.emit(
                "ai-stream-done",
                serde_json::json!({ "conversation_id": conversation_id }),
            );
            return Ok(());
        }

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

                    let parsed: serde_json::Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    let event_type = parsed["type"].as_str().unwrap_or("");

                    match event_type {
                        "content_block_start" => {
                            let block = &parsed["content_block"];
                            if block["type"].as_str() == Some("tool_use") {
                                has_tool_use = true;
                                current_tool_id =
                                    block["id"].as_str().unwrap_or("").to_string();
                                current_tool_name =
                                    block["name"].as_str().unwrap_or("").to_string();
                                current_tool_input.clear();
                            }
                        }
                        "content_block_delta" => {
                            let delta = &parsed["delta"];
                            match delta["type"].as_str() {
                                Some("text_delta") => {
                                    if let Some(text) = delta["text"].as_str() {
                                        let _ = app.emit(
                                            "ai-stream-chunk",
                                            serde_json::json!({
                                                "conversation_id": conversation_id,
                                                "content": text,
                                            }),
                                        );
                                    }
                                }
                                Some("input_json_delta") => {
                                    if let Some(json_str) = delta["partial_json"].as_str() {
                                        current_tool_input.push_str(json_str);
                                    }
                                }
                                _ => {}
                            }
                        }
                        "content_block_stop" => {
                            if has_tool_use && !current_tool_id.is_empty() {
                                pending_tool_calls.push(ToolCall {
                                    id: current_tool_id.clone(),
                                    call_type: "function".to_string(),
                                    function: FunctionCall {
                                        name: current_tool_name.clone(),
                                        arguments: current_tool_input.clone(),
                                    },
                                });
                                current_tool_id.clear();
                                current_tool_name.clear();
                                current_tool_input.clear();
                            }
                        }
                        "message_stop" => {}
                        _ => {}
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
                cancellation.clear(conversation_id);
                return Err(format!("流读取错误: {}", e));
            }
        }
    }

    if !pending_tool_calls.is_empty() {
        let _ = app.emit(
            "ai-agent-tool-calls",
            serde_json::json!({
                "conversation_id": conversation_id,
                "tool_calls": &pending_tool_calls,
            }),
        );
    }

    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    cancellation.clear(conversation_id);
    Ok(())
}
