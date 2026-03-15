use std::collections::HashMap;
use std::error::Error;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::request::{build_anthropic_request, build_api_request};
use super::stream::{extract_sse_data_line, StreamCancellation};
use super::types::{AIConfig, ChatMessage, FunctionCall, ToolCall};
use crate::error::AppError;

const CONNECT_TIMEOUT_SECS: u64 = 15;
const REQUEST_TIMEOUT_SECS: u64 = 600;
const FIRST_CHUNK_TIMEOUT_SECS: u64 = 300;
const STREAM_IDLE_TIMEOUT_SECS: u64 = 120;

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {}", e))
}

fn emit_stream_error(app: &AppHandle, conversation_id: &str, error: &str) {
    let _ = app.emit(
        "ai-stream-error",
        serde_json::json!({
            "conversation_id": conversation_id,
            "error": error,
        }),
    );
}

fn emit_stream_done(app: &AppHandle, conversation_id: &str) {
    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
}

fn value_as_nonempty_str(value: &serde_json::Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            value
                .get("text")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            value
                .as_array()
                .and_then(|items| items.iter().find_map(value_as_nonempty_str))
        })
}

fn extract_openai_reasoning_text(delta: &serde_json::Value) -> Option<&str> {
    let obj = delta.as_object()?;
    obj.get("reasoning")
        .and_then(value_as_nonempty_str)
        .or_else(|| obj.get("reasoning_content").and_then(value_as_nonempty_str))
        .or_else(|| obj.get("reasoning_text").and_then(value_as_nonempty_str))
        .or_else(|| {
            obj.iter()
                .filter(|(k, _)| !["role", "content", "tool_calls"].contains(&k.as_str()))
                .find_map(|(_, v)| value_as_nonempty_str(v))
        })
}

fn should_enable_kimi_reasoning(config: &AIConfig) -> bool {
    if !config.model.to_lowercase().contains("kimi") {
        return false;
    }
    !matches!(
        config.thinking_level.as_deref().map(|level| level.trim().to_lowercase()),
        Some(level) if level == "off"
    )
}

fn summarize_anthropic_request_payload(request: &serde_json::Value) -> String {
    let Some(messages) = request.get("messages").and_then(|v| v.as_array()) else {
        return "messages=0".to_string();
    };

    let parts = messages
        .iter()
        .enumerate()
        .map(|(idx, message)| {
            let role = message
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let content = message.get("content");
            if let Some(blocks) = content.and_then(|v| v.as_array()) {
                let text_blocks = blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("text"))
                    .count();
                let image_blocks = blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("image"))
                    .count();
                let tool_use_blocks = blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
                    .count();
                format!(
                    "#{}:{} blocks(text={}, image={}, tool_use={})",
                    idx, role, text_blocks, image_blocks, tool_use_blocks
                )
            } else {
                let content_len = content
                    .and_then(|v| v.as_str())
                    .map(|text| text.chars().count())
                    .unwrap_or(0);
                format!("#{}:{} text_chars={}", idx, role, content_len)
            }
        })
        .collect::<Vec<_>>();

    format!("messages={} {}", messages.len(), parts.join(" | "))
}

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
    log::info!(
        "[ai_agent_stream] start conv={} protocol={} source={:?} model={} base_url={} team_id={:?} team_config_id={:?} thinking_level={:?} messages={} tools={}",
        conversation_id,
        protocol,
        config.source,
        config.model,
        config.base_url,
        config.team_id,
        config.team_config_id,
        config.thinking_level,
        messages.len(),
        tools.len()
    );

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
    let client = build_http_client().map_err(AppError::Custom)?;
    let cancellation = app.state::<StreamCancellation>();
    cancellation.reset(conversation_id);

    let started_at = std::time::Instant::now();

    let mut request = build_api_request(
        &config.model,
        &messages,
        config.temperature,
        config.max_tokens,
        tools,
        true,
    );

    if should_enable_kimi_reasoning(config) {
        request["reasoning"] = serde_json::json!({"enabled": true});
    }

    if let Some(ref tid) = config.team_id {
        request["team_id"] = serde_json::json!(tid);
        if let Some(ref tcid) = config.team_config_id {
            request["team_config_id"] = serde_json::json!(tcid);
        }
    }

    let url = format!("{}/chat/completions", config.base_url);
    log::info!(
        "[ai_agent_stream/openai] POST {} conv={} model={} source={:?} team_id={:?} team_config_id={:?} thinking_level={:?}",
        url,
        conversation_id,
        config.model,
        config.source,
        config.team_id,
        config.team_config_id,
        config.thinking_level,
    );

    let _ = app.emit(
        "ai-stream-raw",
        serde_json::json!({
            "conversation_id": conversation_id,
            "raw_line": format!("[RUST REQUEST START] POST {}\nPayload: {}", url, serde_json::to_string(&request).unwrap_or_default()),
        }),
    );

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "identity")
        .json(&request)
        .send()
        .await
        .map_err(|e| {
            let msg = format!("请求失败: {} (source: {:?})", e, e.source());
            log::error!(
                "[ai_agent_stream/openai] request failed conv={} err={:?}",
                conversation_id,
                e
            );
            AppError::Custom(msg)
        })?;

    let status = response.status();
    log::info!(
        "[ai_agent_stream/openai] HTTP {} conv={} elapsed={}ms",
        status,
        conversation_id,
        started_at.elapsed().as_millis()
    );

    let _ = app.emit(
        "ai-stream-raw",
        serde_json::json!({
            "conversation_id": conversation_id,
            "raw_line": format!("[RUST RESPONSE HEADERS RECEIVED] HTTP {} Elapsed: {}ms", status, started_at.elapsed().as_millis()),
        }),
    );

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let preview: String = body.chars().take(800).collect();

        let _ = app.emit(
            "ai-stream-raw",
            serde_json::json!({
                "conversation_id": conversation_id,
                "raw_line": format!("[RUST ERROR BODY] {}", preview),
            }),
        );

        let error_msg = format!("API 错误 (HTTP {}): {}", status.as_u16(), preview);
        log::error!(
            "[ai_agent_stream/openai] non-success conv={} err={}",
            conversation_id,
            error_msg
        );
        emit_stream_error(app, conversation_id, &error_msg);
        cancellation.clear(conversation_id);
        return Err(AppError::Custom(error_msg));
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut tc_args_buffer: HashMap<usize, String> = HashMap::new();

    let mut got_first_chunk = false;
    let mut chunk_count: usize = 0;
    let mut line_count: usize = 0;
    let mut byte_count: usize = 0;

    loop {
        if cancellation.is_cancelled(conversation_id) {
            log::warn!(
                "[ai_agent_stream/openai] cancelled conv={} elapsed={}ms chunks={} bytes={}",
                conversation_id,
                started_at.elapsed().as_millis(),
                chunk_count,
                byte_count
            );
            cancellation.clear(conversation_id);
            emit_stream_done(app, conversation_id);
            return Ok(());
        }

        let timeout_secs = if got_first_chunk {
            STREAM_IDLE_TIMEOUT_SECS
        } else {
            FIRST_CHUNK_TIMEOUT_SECS
        };

        let next = match tokio::time::timeout(Duration::from_secs(timeout_secs), stream.next())
            .await
        {
            Ok(next) => next,
            Err(_) => {
                let msg = if got_first_chunk {
                    format!("流读取空闲超时（{}s）", STREAM_IDLE_TIMEOUT_SECS)
                } else {
                    format!("等待首个流响应超时（{}s）", FIRST_CHUNK_TIMEOUT_SECS)
                };
                log::error!(
                    "[ai_agent_stream/openai] timeout conv={} elapsed={}ms chunks={} lines={} err={}",
                    conversation_id,
                    started_at.elapsed().as_millis(),
                    chunk_count,
                    line_count,
                    msg
                );
                emit_stream_error(app, conversation_id, &msg);
                cancellation.clear(conversation_id);
                return Err(AppError::Custom(msg));
            }
        };

        let Some(chunk) = next else {
            break;
        };

        if !got_first_chunk {
            got_first_chunk = true;
            log::info!(
                "[ai_agent_stream/openai] first chunk conv={} latency={}ms",
                conversation_id,
                started_at.elapsed().as_millis()
            );
        }

        match chunk {
            Ok(bytes) => {
                chunk_count += 1;
                byte_count += bytes.len();
                buffer.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buffer.find('\n') {
                    line_count += 1;
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    // --- EMIT RAW DATA FOR DEBUGGING ---
                    let _ = app.emit(
                        "ai-stream-raw",
                        serde_json::json!({
                            "conversation_id": conversation_id,
                            "raw_line": line,
                        }),
                    );

                    let Some((data, _)) = extract_sse_data_line(&line) else {
                        continue;
                    };
                    if data == "[DONE]" {
                        if !pending_tool_calls.is_empty() {
                            for (idx, args) in &tc_args_buffer {
                                if let Some(tc) = pending_tool_calls.get_mut(*idx) {
                                    tc.function.arguments = args.clone();
                                }
                            }
                            log::info!(
                                "[ai_agent_stream/openai] tool calls conv={} count={}",
                                conversation_id,
                                pending_tool_calls.len()
                            );
                            let _ = app.emit(
                                "ai-agent-tool-calls",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "tool_calls": &pending_tool_calls,
                                }),
                            );
                        }

                        log::info!(
                            "[ai_agent_stream/openai] done conv={} elapsed={}ms chunks={} lines={} bytes={} tool_calls={}",
                            conversation_id,
                            started_at.elapsed().as_millis(),
                            chunk_count,
                            line_count,
                            byte_count,
                            pending_tool_calls.len()
                        );
                        emit_stream_done(app, conversation_id);
                        cancellation.clear(conversation_id);
                        return Ok(());
                    }

                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let delta = &parsed["choices"][0]["delta"];
                        let mut emitted = false;

                        if let Some(content) = delta["content"].as_str() {
                            let _ = app.emit(
                                "ai-stream-chunk",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "content": content,
                                }),
                            );
                            emitted = true;
                        }

                        if let Some(thinking_text) = extract_openai_reasoning_text(delta) {
                            let payload = serde_json::json!({
                                "conversation_id": conversation_id,
                                "content": thinking_text
                            });
                            let _ = app.emit("ai-stream-thinking", payload);
                            emitted = true;
                        }

                        if let Some(tcs) = delta["tool_calls"].as_array() {
                            emitted = true;
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
                                        let payload = serde_json::json!({
                                            "conversation_id": conversation_id,
                                            "content": args
                                        });
                                        let _ = app.emit("ai-stream-tool-args", payload);
                                    }
                                }
                            }
                        }

                        if !emitted {
                            if chunk_count <= 3 {
                                let preview: String =
                                    format!("{}", delta).chars().take(200).collect();
                                log::info!(
                                    "[ai_agent_stream/openai] delta preview={} conv={}",
                                    preview,
                                    conversation_id
                                );
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let msg = format!("流读取错误: {}", e);
                log::error!(
                    "[ai_agent_stream/openai] read error conv={} elapsed={}ms chunks={} lines={} err={}",
                    conversation_id,
                    started_at.elapsed().as_millis(),
                    chunk_count,
                    line_count,
                    msg
                );
                if got_first_chunk && chunk_count > 10 {
                    log::warn!(
                        "[ai_agent_stream/openai] treating read error as stream end (chunks={} lines={}), conv={}",
                        chunk_count, line_count, conversation_id
                    );
                    break;
                }
                cancellation.clear(conversation_id);
                emit_stream_error(app, conversation_id, &msg);
                return Err(AppError::Custom(msg));
            }
        }
    }

    if !pending_tool_calls.is_empty() {
        for (idx, args) in &tc_args_buffer {
            if let Some(tc) = pending_tool_calls.get_mut(*idx) {
                tc.function.arguments = args.clone();
            }
        }
        log::warn!(
            "[ai_agent_stream/openai] stream ended without [DONE], but has tool_calls conv={} count={}",
            conversation_id,
            pending_tool_calls.len()
        );
        let _ = app.emit(
            "ai-agent-tool-calls",
            serde_json::json!({
                "conversation_id": conversation_id,
                "tool_calls": &pending_tool_calls,
            }),
        );
    }

    log::warn!(
        "[ai_agent_stream/openai] stream ended without [DONE] conv={} elapsed={}ms chunks={} lines={} bytes={}",
        conversation_id,
        started_at.elapsed().as_millis(),
        chunk_count,
        line_count,
        byte_count
    );
    cancellation.clear(conversation_id);
    emit_stream_done(app, conversation_id);
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
    let client = build_http_client()?;
    let cancellation = app.state::<StreamCancellation>();
    cancellation.reset(conversation_id);

    let started_at = std::time::Instant::now();

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
    let is_team =
        config.source.as_deref() == Some("team") || config.source.as_deref() == Some("platform");

    let mut req_builder = client
        .post(&url)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .header("Accept-Encoding", "identity");
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
            request
        }
    } else {
        request
    };

    log::info!(
        "[ai_agent_stream/anthropic] POST {} conv={} model={} source={:?} team_id={:?} team_config_id={:?} thinking_level={:?}",
        url,
        conversation_id,
        config.model,
        config.source,
        config.team_id,
        config.team_config_id,
        config.thinking_level,
    );
    let _ = app.emit(
        "ai-stream-raw",
        serde_json::json!({
            "conversation_id": conversation_id,
            "raw_line": format!(
                "[RUST REQUEST SUMMARY] {}",
                summarize_anthropic_request_payload(&final_request)
            ),
        }),
    );

    let response = req_builder.json(&final_request).send().await.map_err(|e| {
        let msg = format!("请求失败: {} (source: {:?})", e, e.source());
        log::error!(
            "[ai_agent_stream/anthropic] request failed conv={} err={:?}",
            conversation_id,
            e
        );
        msg
    })?;

    let status = response.status();
    log::info!(
        "[ai_agent_stream/anthropic] HTTP {} conv={} elapsed={}ms",
        status,
        conversation_id,
        started_at.elapsed().as_millis()
    );

    if !status.is_success() {
        let status_code = status.as_u16();
        let body = response.text().await.unwrap_or_default();
        let readable = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| body.chars().take(300).collect::<String>());
        let error_msg = format!("Anthropic API 错误: HTTP {} — {}", status_code, readable);
        log::error!(
            "[ai_agent_stream/anthropic] non-success conv={} err={}",
            conversation_id,
            error_msg
        );
        emit_stream_error(app, conversation_id, &error_msg);
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

    let mut got_first_chunk = false;
    let mut chunk_count: usize = 0;
    let mut line_count: usize = 0;
    let mut byte_count: usize = 0;
    let mut text_chunk_count: usize = 0;
    let mut parsed_event_count: usize = 0;
    let mut compat_data_prefix_count: usize = 0;
    let mut json_parse_fail_count: usize = 0;

    loop {
        if cancellation.is_cancelled(conversation_id) {
            log::warn!(
                "[ai_agent_stream/anthropic] cancelled conv={} elapsed={}ms chunks={} bytes={} text_chunks={}",
                conversation_id,
                started_at.elapsed().as_millis(),
                chunk_count,
                byte_count,
                text_chunk_count
            );
            cancellation.clear(conversation_id);
            emit_stream_done(app, conversation_id);
            return Ok(());
        }

        let timeout_secs = if got_first_chunk {
            STREAM_IDLE_TIMEOUT_SECS
        } else {
            FIRST_CHUNK_TIMEOUT_SECS
        };

        let next = match tokio::time::timeout(Duration::from_secs(timeout_secs), stream.next())
            .await
        {
            Ok(next) => next,
            Err(_) => {
                let msg = if got_first_chunk {
                    format!("流读取空闲超时（{}s）", STREAM_IDLE_TIMEOUT_SECS)
                } else {
                    format!("等待首个流响应超时（{}s）", FIRST_CHUNK_TIMEOUT_SECS)
                };
                log::error!(
                    "[ai_agent_stream/anthropic] timeout conv={} elapsed={}ms chunks={} lines={} err={}",
                    conversation_id,
                    started_at.elapsed().as_millis(),
                    chunk_count,
                    line_count,
                    msg
                );
                emit_stream_error(app, conversation_id, &msg);
                cancellation.clear(conversation_id);
                return Err(msg);
            }
        };

        let Some(chunk) = next else {
            break;
        };

        if !got_first_chunk {
            got_first_chunk = true;
            log::info!(
                "[ai_agent_stream/anthropic] first chunk conv={} latency={}ms",
                conversation_id,
                started_at.elapsed().as_millis()
            );
        }

        match chunk {
            Ok(bytes) => {
                chunk_count += 1;
                byte_count += bytes.len();
                buffer.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buffer.find('\n') {
                    line_count += 1;
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    // --- EMIT RAW DATA FOR DEBUGGING ---
                    let _ = app.emit(
                        "ai-stream-raw",
                        serde_json::json!({
                            "conversation_id": conversation_id,
                            "raw_line": line,
                        }),
                    );

                    let Some((data, used_compact_prefix)) = extract_sse_data_line(&line) else {
                        continue;
                    };
                    if used_compact_prefix {
                        compat_data_prefix_count += 1;
                        if compat_data_prefix_count == 1 {
                            log::warn!(
                                "[ai_agent_stream/anthropic] normalized compact SSE prefix conv={} sample={}",
                                conversation_id,
                                line.chars().take(160).collect::<String>()
                            );
                        }
                    }

                    let parsed: serde_json::Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(e) => {
                            json_parse_fail_count += 1;
                            if json_parse_fail_count <= 3 {
                                log::warn!(
                                    "[ai_agent_stream/anthropic] failed to parse SSE data conv={} err={} sample={}",
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
                                current_tool_id = block["id"].as_str().unwrap_or("").to_string();
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
                                        text_chunk_count += 1;
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
                                    let payload = serde_json::json!({
                                        "conversation_id": conversation_id,
                                        "content": thinking_text
                                    });
                                    let _ = app.emit("ai-stream-thinking", payload);
                                }
                                Some("input_json_delta") => {
                                    if let Some(json_str) = delta["partial_json"].as_str() {
                                        current_tool_input.push_str(json_str);
                                        let payload = serde_json::json!({
                                            "conversation_id": conversation_id,
                                            "content": json_str
                                        });
                                        let _ = app.emit("ai-stream-tool-args", payload);
                                    }
                                }
                                other => {
                                    let fallback = delta["text"]
                                        .as_str()
                                        .or_else(|| delta["insert"].as_str())
                                        .or_else(|| delta["value"].as_str());
                                    if let Some(text) = fallback {
                                        text_chunk_count += 1;
                                        let _ = app.emit(
                                            "ai-stream-chunk",
                                            serde_json::json!({
                                                "conversation_id": conversation_id,
                                                "content": text,
                                            }),
                                        );
                                    }
                                    if chunk_count <= 5 {
                                        let preview: String =
                                            format!("{}", delta).chars().take(200).collect();
                                        log::info!(
                                            "[ai_agent_stream/anthropic] unknown delta type={:?} preview={} conv={}",
                                            other, preview, conversation_id
                                        );
                                    }
                                }
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
                        other => {
                            if chunk_count <= 5 {
                                let preview: String =
                                    format!("{}", parsed).chars().take(200).collect();
                                log::info!(
                                    "[ai_agent_stream/anthropic] unknown event type={} preview={} conv={}",
                                    other, preview, conversation_id
                                );
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let msg = format!("流读取错误: {}", e);
                log::error!(
                    "[ai_agent_stream/anthropic] read error conv={} elapsed={}ms chunks={} lines={} err={}",
                    conversation_id,
                    started_at.elapsed().as_millis(),
                    chunk_count,
                    line_count,
                    msg
                );
                if got_first_chunk && chunk_count > 10 {
                    log::warn!(
                        "[ai_agent_stream/anthropic] treating read error as stream end (chunks={} lines={}), conv={}",
                        chunk_count, line_count, conversation_id
                    );
                    break;
                }
                emit_stream_error(app, conversation_id, &msg);
                cancellation.clear(conversation_id);
                return Err(msg);
            }
        }
    }

    if !pending_tool_calls.is_empty() {
        log::info!(
            "[ai_agent_stream/anthropic] tool calls conv={} count={}",
            conversation_id,
            pending_tool_calls.len()
        );
        let _ = app.emit(
            "ai-agent-tool-calls",
            serde_json::json!({
                "conversation_id": conversation_id,
                "tool_calls": &pending_tool_calls,
            }),
        );
    }

    log::info!(
        "[ai_agent_stream/anthropic] done conv={} elapsed={}ms chunks={} lines={} bytes={} text_chunks={} tool_calls={} parsed_events={} compat_prefix={} json_parse_failures={}",
        conversation_id,
        started_at.elapsed().as_millis(),
        chunk_count,
        line_count,
        byte_count,
        text_chunk_count,
        pending_tool_calls.len(),
        parsed_event_count,
        compat_data_prefix_count,
        json_parse_fail_count
    );
    emit_stream_done(app, conversation_id);
    cancellation.clear(conversation_id);
    Ok(())
}
