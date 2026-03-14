use tauri::{AppHandle, Emitter, Manager};

use super::{extract_sse_data_line, StreamCancellation};
use crate::commands::ai::request::build_anthropic_request;
use crate::commands::ai::tools::executor::execute_tool;
use crate::commands::ai::types::{AIConfig, ChatMessage, FunctionCall, ToolCall};

/// Anthropic 流式对话处理（含多轮工具调用循环）
pub async fn anthropic_stream_loop(
    app: &AppHandle,
    client: &reqwest::Client,
    config: &AIConfig,
    conversation_id: &str,
    system_prompt: &str,
    mut full_messages: Vec<ChatMessage>,
    tools: &[serde_json::Value],
) -> Result<(), String> {
    let cancellation = app.state::<StreamCancellation>();

    for _round in 0..6 {
        let request = build_anthropic_request(
            &config.model,
            &full_messages,
            system_prompt,
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
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json");
        if url.contains("coding.dashscope") || url.contains("coding-intl.dashscope") {
            req_builder = req_builder.header("User-Agent", "openclaw/1.0.0");
        }
        if is_team {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", config.api_key));
        } else {
            req_builder = req_builder.header("x-api-key", &config.api_key);
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
                request.clone()
            }
        } else {
            request.clone()
        };

        let _ = app.emit(
            "ai-stream-raw",
            serde_json::json!({
                "conversation_id": conversation_id,
                "raw_line": format!(
                    "[RUST REQUEST START] POST {}\nPayload: {}",
                    url,
                    serde_json::to_string(&final_request).unwrap_or_default()
                ),
            }),
        );

        let response = req_builder
            .json(&final_request)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;

        let status = response.status();
        let _ = app.emit(
            "ai-stream-raw",
            serde_json::json!({
                "conversation_id": conversation_id,
                "raw_line": format!("[RUST RESPONSE HEADERS RECEIVED] HTTP {}", status),
            }),
        );

        if !status.is_success() {
            let status_code = status.as_u16();
            let body = response.text().await.unwrap_or_default();
            let preview: String = body.chars().take(1200).collect();
            let _ = app.emit(
                "ai-stream-raw",
                serde_json::json!({
                    "conversation_id": conversation_id,
                    "raw_line": format!("[RUST ERROR BODY] {}", preview),
                }),
            );
            let error_detail = if body.is_empty() {
                format!("HTTP {} (无响应体)", status_code)
            } else {
                let readable = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| body[..body.len().min(300)].to_string());
                format!("HTTP {} — {}", status_code, readable)
            };
            log::error!("[anthropic_stream] {} → {}", url, error_detail);
            let error_msg = format!("Anthropic API 错误: {}", error_detail);
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
        let mut parsed_event_count: usize = 0;
        let mut compat_data_prefix_count: usize = 0;
        let mut json_parse_fail_count: usize = 0;

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

                        let Some((data, used_compact_prefix)) = extract_sse_data_line(&line) else {
                            continue;
                        };
                        if used_compact_prefix {
                            compat_data_prefix_count += 1;
                            if compat_data_prefix_count == 1 {
                                log::warn!(
                                    "[anthropic_stream] normalized compact SSE prefix conv={} sample={}",
                                    conversation_id,
                                    line.chars().take(160).collect::<String>()
                                );
                            }
                        }
                        let _ = app.emit(
                            "ai-stream-raw",
                            serde_json::json!({
                                "conversation_id": conversation_id,
                                "raw_line": format!("[RAW DATA] {}", data),
                            }),
                        );

                        let parsed: serde_json::Value = match serde_json::from_str(data) {
                            Ok(v) => v,
                            Err(e) => {
                                json_parse_fail_count += 1;
                                if json_parse_fail_count <= 3 {
                                    log::warn!(
                                        "[anthropic_stream] failed to parse SSE data conv={} err={} sample={}",
                                        conversation_id,
                                        e,
                                        data.chars().take(200).collect::<String>()
                                    );
                                }
                                continue;
                            }
                        };

                        parsed_event_count += 1;
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
                                    Some("thinking_delta") | Some("thinking") => {
                                        let thinking_text = delta["thinking"]
                                            .as_str()
                                            .or_else(|| delta["text"].as_str())
                                            .unwrap_or("");
                                        if !thinking_text.is_empty() {
                                            let _ = app.emit(
                                                "ai-stream-thinking",
                                                serde_json::json!({
                                                    "conversation_id": conversation_id,
                                                    "content": thinking_text,
                                                }),
                                            );
                                        }
                                    }
                                    Some("input_json_delta") => {
                                        if let Some(json_str) = delta["partial_json"].as_str() {
                                            current_tool_input.push_str(json_str);
                                        }
                                    }
                                    Some("signature_delta") => {}
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

        if pending_tool_calls.is_empty() {
            log::info!(
                "[anthropic_stream] done conv={} parsed_events={} compat_prefix={} json_parse_failures={}",
                conversation_id,
                parsed_event_count,
                compat_data_prefix_count,
                json_parse_fail_count
            );
            let _ = app.emit(
                "ai-stream-done",
                serde_json::json!({ "conversation_id": conversation_id }),
            );
            cancellation.clear(conversation_id);
            return Ok(());
        }

        let _ = app.emit(
            "ai-stream-tool-calls",
            serde_json::json!({
                "conversation_id": conversation_id,
                "tool_calls": &pending_tool_calls,
            }),
        );

        let mut assistant_content: Vec<serde_json::Value> = Vec::new();
        let mut tool_results: Vec<serde_json::Value> = Vec::new();

        for tc in &pending_tool_calls {
            let result = execute_tool(app, &tc.function.name, &tc.function.arguments).await;
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

            let input: serde_json::Value =
                serde_json::from_str(&tc.function.arguments).unwrap_or(serde_json::json!({}));
            assistant_content.push(serde_json::json!({
                "type": "tool_use",
                "id": tc.id,
                "name": tc.function.name,
                "input": input,
            }));
            tool_results.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": tc.id,
                "content": content,
            }));
        }

        full_messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: None,
            tool_calls: Some(pending_tool_calls),
            tool_call_id: None,
            name: None,
            images: None,
        });
        full_messages.push(ChatMessage {
            role: "user".to_string(),
            content: Some(serde_json::to_string(&tool_results).unwrap_or_default()),
            tool_calls: None,
            tool_call_id: Some("__anthropic_tool_results__".to_string()),
            name: None,
            images: None,
        });
    }

    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    log::info!(
        "[anthropic_stream] max rounds reached conv={} final_emit_done=true",
        conversation_id
    );
    cancellation.clear(conversation_id);
    Ok(())
}
