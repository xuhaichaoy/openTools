use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

use super::types::{AIConfig, ChatMessage, ToolCall, FunctionCall};
use super::request::build_api_request;
use super::stream::StreamCancellation;
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
    let client = reqwest::Client::new();
    let cancellation = app.state::<StreamCancellation>();
    cancellation.reset();

    let mut request = build_api_request(
        &config.model, &messages, config.temperature, config.max_tokens, &tools, true,
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
        return Err(AppError::Custom(format!("API 错误: {}", body)));
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut tc_args_buffer: HashMap<usize, String> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        if cancellation.is_cancelled() {
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
                return Err(AppError::Custom(format!("流读取错误: {}", e)));
            }
        }
    }

    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    Ok(())
}
