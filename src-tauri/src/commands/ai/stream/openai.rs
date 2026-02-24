use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

use super::StreamCancellation;
use crate::commands::ai::request::build_api_request;
use crate::commands::ai::tools::executor::execute_tool;
use crate::commands::ai::types::{AIConfig, ChatMessage, FunctionCall, ToolCall};

/// OpenAI 兼容协议的流式对话处理（含多轮 tool_calls 循环）
pub async fn openai_stream_loop(
    app: &AppHandle,
    client: &reqwest::Client,
    config: &AIConfig,
    conversation_id: &str,
    mut full_messages: Vec<ChatMessage>,
    tools: &[serde_json::Value],
) -> Result<(), String> {
    let cancellation = app.state::<StreamCancellation>();

    let mut request = build_api_request(
        &config.model,
        &full_messages,
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

    let url = format!("{}/chat/completions", config.base_url);
    log::info!(
        "[ai_chat_stream] POST {} | source={:?} model={} team_id={:?} team_config_id={:?}",
        url,
        config.source,
        config.model,
        config.team_id,
        config.team_config_id
    );

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        log::error!(
            "[ai_chat_stream] {} → HTTP {} body={}",
            url,
            status,
            &body[..body.len().min(200)]
        );
        let _ = app.emit(
            "ai-stream-error",
            serde_json::json!({
                "conversation_id": conversation_id,
                "error": format!("API 错误: {}", body),
            }),
        );
        cancellation.clear(conversation_id);
        return Err(format!("API 错误: {}", body));
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
                                "ai-stream-tool-calls",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "tool_calls": &pending_tool_calls,
                                }),
                            );
                            let mut tool_messages = Vec::new();
                            for tc in &pending_tool_calls {
                                let result =
                                    execute_tool(app, &tc.function.name, &tc.function.arguments)
                                        .await;
                                let content = match result {
                                    Ok(r) => r,
                                    Err(e) => format!("工具执行失败: {}", e),
                                };
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
                                    images: None,
                                });
                            }

                            full_messages.push(ChatMessage {
                                role: "assistant".to_string(),
                                content: None,
                                tool_calls: Some(pending_tool_calls.clone()),
                                tool_call_id: None,
                                name: None,
                                images: None,
                            });
                            full_messages.extend(tool_messages);

                            for _round in 0..5 {
                                if cancellation.is_cancelled(conversation_id) {
                                    break;
                                }
                                let mut follow_request = build_api_request(
                                    &config.model,
                                    &full_messages,
                                    config.temperature,
                                    config.max_tokens,
                                    tools,
                                    false,
                                );
                                if let Some(ref tid) = config.team_id {
                                    follow_request["team_id"] = serde_json::json!(tid);
                                    if let Some(ref tcid) = config.team_config_id {
                                        follow_request["team_config_id"] = serde_json::json!(tcid);
                                    }
                                }

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
                                            if let Ok(parsed) =
                                                serde_json::from_str::<serde_json::Value>(&body)
                                            {
                                                let message = &parsed["choices"][0]["message"];

                                                if let Some(new_tcs) =
                                                    message["tool_calls"].as_array()
                                                {
                                                    if !new_tcs.is_empty() {
                                                        let mut round_tool_calls: Vec<ToolCall> =
                                                            Vec::new();
                                                        for tc_val in new_tcs {
                                                            let tc = ToolCall {
                                                                id: tc_val["id"]
                                                                    .as_str()
                                                                    .unwrap_or("")
                                                                    .to_string(),
                                                                call_type: "function".to_string(),
                                                                function: FunctionCall {
                                                                    name: tc_val["function"]
                                                                        ["name"]
                                                                        .as_str()
                                                                        .unwrap_or("")
                                                                        .to_string(),
                                                                    arguments: tc_val["function"]
                                                                        ["arguments"]
                                                                        .as_str()
                                                                        .unwrap_or("{}")
                                                                        .to_string(),
                                                                },
                                                            };
                                                            round_tool_calls.push(tc);
                                                        }

                                                        let _ = app.emit(
                                                            "ai-stream-tool-calls",
                                                            serde_json::json!({
                                                                "conversation_id": conversation_id,
                                                                "tool_calls": &round_tool_calls,
                                                            }),
                                                        );

                                                        let mut round_tool_messages = Vec::new();
                                                        for tc in &round_tool_calls {
                                                            let result = execute_tool(
                                                                app,
                                                                &tc.function.name,
                                                                &tc.function.arguments,
                                                            )
                                                            .await;
                                                            let content = match result {
                                                                Ok(r) => r,
                                                                Err(e) => {
                                                                    format!("工具执行失败: {}", e)
                                                                }
                                                            };
                                                            let _ = app.emit(
                                                                "ai-stream-tool-result",
                                                                serde_json::json!({
                                                                    "conversation_id": conversation_id,
                                                                    "tool_call_id": tc.id,
                                                                    "name": tc.function.name,
                                                                    "result": &content,
                                                                }),
                                                            );
                                                            round_tool_messages.push(ChatMessage {
                                                                role: "tool".to_string(),
                                                                content: Some(content),
                                                                tool_calls: None,
                                                                tool_call_id: Some(tc.id.clone()),
                                                                name: Some(
                                                                    tc.function.name.clone(),
                                                                ),
                                                                images: None,
                                                            });
                                                        }

                                                        full_messages.push(ChatMessage {
                                                            role: "assistant".to_string(),
                                                            content: message["content"]
                                                                .as_str()
                                                                .map(|s| s.to_string()),
                                                            tool_calls: Some(round_tool_calls),
                                                            tool_call_id: None,
                                                            name: None,
                                                            images: None,
                                                        });
                                                        full_messages.extend(round_tool_messages);
                                                        continue;
                                                    }
                                                }

                                                if let Some(content) = message["content"].as_str() {
                                                    let _ = app.emit(
                                                        "ai-stream-chunk",
                                                        serde_json::json!({
                                                            "conversation_id": conversation_id,
                                                            "content": content,
                                                        }),
                                                    );
                                                }
                                                break;
                                            }
                                        }
                                        break;
                                    }
                                    Err(e) => {
                                        let _ = app.emit(
                                            "ai-stream-error",
                                            serde_json::json!({
                                                "conversation_id": conversation_id,
                                                "error": format!("后续请求失败: {}", e),
                                            }),
                                        );
                                        break;
                                    }
                                }
                            }
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

    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    cancellation.clear(conversation_id);
    Ok(())
}
