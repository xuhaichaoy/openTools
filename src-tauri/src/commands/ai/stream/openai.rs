use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::{extract_sse_data_line, StreamCancellation};
use crate::commands::ai::request::build_api_request;
use crate::commands::ai::tool_call_stream::{
    apply_openai_tool_call_delta, finalize_openai_tool_calls,
};
use crate::commands::ai::tools::executor::execute_tool;
use crate::commands::ai::types::{AIConfig, ChatMessage, FunctionCall, ToolCall};

const FIRST_CHUNK_TIMEOUT_SECS: u64 = 120;
const STREAM_IDLE_TIMEOUT_SECS: u64 = 120;
const START_REQUEST_MAX_RETRIES: usize = 2;
const START_REQUEST_RETRY_DELAYS_MS: [u64; START_REQUEST_MAX_RETRIES] = [1200, 2800];

fn preview_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn summarize_retryable_headers(headers: &reqwest::header::HeaderMap) -> String {
    const KEYS: [&str; 8] = [
        "x-request-id",
        "x-trace-id",
        "traceparent",
        "cf-ray",
        "server",
        "via",
        "retry-after",
        "content-type",
    ];

    KEYS.iter()
        .filter_map(|key| {
            headers
                .get(*key)
                .and_then(|value| value.to_str().ok())
                .map(|value| format!("{}={}", key, value))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn is_retryable_upstream_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 502 | 503 | 504)
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

fn emit_openai_content_chunk(app: &AppHandle, conversation_id: &str, content: &str) {
    let _ = app.emit(
        "ai-stream-chunk",
        serde_json::json!({
            "conversation_id": conversation_id,
            "content": content,
        }),
    );
}

fn emit_openai_reasoning_chunk(app: &AppHandle, conversation_id: &str, content: &str) {
    let _ = app.emit(
        "ai-stream-thinking",
        serde_json::json!({
            "conversation_id": conversation_id,
            "content": content,
        }),
    );
}

fn apply_openai_tool_calls_payload(
    tool_calls: &[serde_json::Value],
    pending_tool_calls: &mut Vec<ToolCall>,
    tc_args_buffer: &mut HashMap<usize, String>,
) -> bool {
    let mut emitted = false;
    for (fallback_index, tool_call) in tool_calls.iter().enumerate() {
        let normalized = if tool_call.get("index").is_some() {
            tool_call.clone()
        } else {
            serde_json::json!({
                "index": tool_call["index"].as_u64().unwrap_or(fallback_index as u64),
                "id": tool_call.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "function": tool_call.get("function").cloned().unwrap_or(serde_json::Value::Null),
            })
        };
        if apply_openai_tool_call_delta(&normalized, pending_tool_calls, tc_args_buffer).is_some() {
            emitted = true;
        }
    }
    emitted
}

fn emit_openai_choice_events(
    app: &AppHandle,
    conversation_id: &str,
    choice: &serde_json::Value,
    pending_tool_calls: &mut Vec<ToolCall>,
    tc_args_buffer: &mut HashMap<usize, String>,
) -> bool {
    for payload in [choice.get("delta"), choice.get("message")] {
        let Some(payload) = payload else {
            continue;
        };
        if payload.is_null() {
            continue;
        }

        let mut emitted = false;

        if let Some(content) = payload
            .get("content")
            .and_then(value_as_nonempty_str)
            .or_else(|| choice.get("text").and_then(value_as_nonempty_str))
        {
            emit_openai_content_chunk(app, conversation_id, content);
            emitted = true;
        }

        if let Some(tool_calls) = payload.get("tool_calls").and_then(|value| value.as_array()) {
            if apply_openai_tool_calls_payload(tool_calls, pending_tool_calls, tc_args_buffer) {
                emitted = true;
            }
        }

        if let Some(thinking_text) = extract_openai_reasoning_text(payload) {
            emit_openai_reasoning_chunk(app, conversation_id, thinking_text);
            emitted = true;
        }

        if emitted {
            return true;
        }
    }

    false
}

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
    let started_at = std::time::Instant::now();

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

    let response = loop {
        let mut response_opt = None;
        for attempt in 0..=START_REQUEST_MAX_RETRIES {
            let mut req_builder = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", config.api_key))
                .header("Content-Type", "application/json")
                .header("Accept-Encoding", "identity");
            if url.contains("coding.dashscope") || url.contains("coding-intl.dashscope") {
                req_builder = req_builder.header("User-Agent", "openclaw/1.0.0");
            }

            match req_builder.json(&request).send().await {
                Ok(response) => {
                    let status = response.status();
                    let header_summary = summarize_retryable_headers(response.headers());
                    log::info!(
                        "[ai_chat_stream] {} → HTTP {} attempt={} headers=[{}]",
                        url,
                        status,
                        attempt + 1,
                        header_summary
                    );

                    if status.is_success() {
                        response_opt = Some(response);
                        break;
                    }

                    let body = response.text().await.unwrap_or_default();
                    let preview = preview_text(&body, 240);
                    let retryable =
                        is_retryable_upstream_status(status) && attempt < START_REQUEST_MAX_RETRIES;
                    log::error!(
                        "[ai_chat_stream] {} → HTTP {} attempt={} retryable={} headers=[{}] body={}",
                        url,
                        status,
                        attempt + 1,
                        retryable,
                        header_summary,
                        preview
                    );

                    if retryable {
                        let delay = START_REQUEST_RETRY_DELAYS_MS[attempt];
                        log::warn!(
                            "[ai_chat_stream] retrying upstream request conv={} status={} attempt={} delay={}ms",
                            conversation_id,
                            status,
                            attempt + 1,
                            delay
                        );
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        continue;
                    }

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
                Err(e) => {
                    let retryable = attempt < START_REQUEST_MAX_RETRIES;
                    log::error!(
                        "[ai_chat_stream] request failed conv={} attempt={} retryable={} err={}",
                        conversation_id,
                        attempt + 1,
                        retryable,
                        e
                    );
                    if retryable {
                        let delay = START_REQUEST_RETRY_DELAYS_MS[attempt];
                        log::warn!(
                            "[ai_chat_stream] retrying request send failure conv={} attempt={} delay={}ms",
                            conversation_id,
                            attempt + 1,
                            delay
                        );
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        continue;
                    }
                    cancellation.clear(conversation_id);
                    return Err(format!("请求失败: {}", e));
                }
            }
        }
        if let Some(response) = response_opt {
            break response;
        }
    };

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
                "[ai_chat_stream] cancelled conv={} elapsed={}ms chunks={} lines={} bytes={}",
                conversation_id,
                started_at.elapsed().as_millis(),
                chunk_count,
                line_count,
                byte_count
            );
            cancellation.clear(conversation_id);
            let _ = app.emit(
                "ai-stream-done",
                serde_json::json!({ "conversation_id": conversation_id }),
            );
            return Ok(());
        }

        let timeout_secs = if got_first_chunk {
            STREAM_IDLE_TIMEOUT_SECS
        } else {
            FIRST_CHUNK_TIMEOUT_SECS
        };

        let next =
            match tokio::time::timeout(Duration::from_secs(timeout_secs), stream.next()).await {
                Ok(next) => next,
                Err(_) => {
                    let msg = if got_first_chunk {
                        format!("流读取空闲超时（{}s）", STREAM_IDLE_TIMEOUT_SECS)
                    } else {
                        format!("等待首个流响应超时（{}s）", FIRST_CHUNK_TIMEOUT_SECS)
                    };
                    log::error!(
                        "[ai_chat_stream] timeout conv={} elapsed={}ms chunks={} lines={} err={}",
                        conversation_id,
                        started_at.elapsed().as_millis(),
                        chunk_count,
                        line_count,
                        msg
                    );
                    let _ = app.emit(
                        "ai-stream-error",
                        serde_json::json!({
                            "conversation_id": conversation_id,
                            "error": msg.clone(),
                        }),
                    );
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
                "[ai_chat_stream] first chunk conv={} latency={}ms",
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

                    let Some((data, _)) = extract_sse_data_line(&line) else {
                        continue;
                    };
                    if data == "[DONE]" {
                        if !pending_tool_calls.is_empty() {
                            let dropped = finalize_openai_tool_calls(
                                &mut pending_tool_calls,
                                &tc_args_buffer,
                            );
                            if dropped > 0 {
                                log::warn!(
                                    "[ai_chat_stream] dropped {} incomplete tool_calls conv={}",
                                    dropped,
                                    conversation_id
                                );
                            }
                            if !pending_tool_calls.is_empty() {
                                let _ = app.emit(
                                    "ai-stream-tool-calls",
                                    serde_json::json!({
                                        "conversation_id": conversation_id,
                                        "tool_calls": &pending_tool_calls,
                                    }),
                                );
                                let mut tool_messages = Vec::new();
                                for tc in &pending_tool_calls {
                                    let result = execute_tool(
                                        app,
                                        &tc.function.name,
                                        &tc.function.arguments,
                                    )
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
                                            follow_request["team_config_id"] =
                                                serde_json::json!(tcid);
                                        }
                                    }

                                    let follow_url =
                                        format!("{}/chat/completions", config.base_url);
                                    let mut follow_builder = client
                                        .post(&follow_url)
                                        .header(
                                            "Authorization",
                                            format!("Bearer {}", config.api_key),
                                        )
                                        .header("Content-Type", "application/json")
                                        .header("Accept-Encoding", "identity");
                                    if follow_url.contains("coding.dashscope")
                                        || follow_url.contains("coding-intl.dashscope")
                                    {
                                        follow_builder =
                                            follow_builder.header("User-Agent", "openclaw/1.0.0");
                                    }
                                    match follow_builder.json(&follow_request).send().await {
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
                                                            let mut round_tool_calls: Vec<
                                                                ToolCall,
                                                            > = Vec::new();
                                                            for tc_val in new_tcs {
                                                                let tc = ToolCall {
                                                                    id: tc_val["id"]
                                                                        .as_str()
                                                                        .unwrap_or("")
                                                                        .to_string(),
                                                                    call_type: "function"
                                                                        .to_string(),
                                                                    function: FunctionCall {
                                                                        name: tc_val["function"]
                                                                            ["name"]
                                                                            .as_str()
                                                                            .unwrap_or("")
                                                                            .to_string(),
                                                                        arguments: tc_val
                                                                            ["function"]
                                                                            ["arguments"]
                                                                            .as_str()
                                                                            .unwrap_or("{}")
                                                                            .to_string(),
                                                                    },
                                                                };
                                                                round_tool_calls.push(tc);
                                                            }
                                                            for (index, tool_call) in
                                                                round_tool_calls
                                                                    .iter_mut()
                                                                    .enumerate()
                                                            {
                                                                tool_call.function.name = tool_call
                                                                    .function
                                                                    .name
                                                                    .trim()
                                                                    .to_string();
                                                                if tool_call.id.trim().is_empty()
                                                                    && !tool_call
                                                                        .function
                                                                        .name
                                                                        .is_empty()
                                                                {
                                                                    tool_call.id = format!(
                                                                        "call_round_{}",
                                                                        index
                                                                    );
                                                                }
                                                            }
                                                            round_tool_calls.retain(|tool_call| {
                                                                !tool_call
                                                                    .function
                                                                    .name
                                                                    .trim()
                                                                    .is_empty()
                                                            });
                                                            if round_tool_calls.is_empty() {
                                                                continue;
                                                            }

                                                            let _ = app.emit(
                                                            "ai-stream-tool-calls",
                                                            serde_json::json!({
                                                                "conversation_id": conversation_id,
                                                                "tool_calls": &round_tool_calls,
                                                            }),
                                                        );

                                                            let mut round_tool_messages =
                                                                Vec::new();
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
                                                                        format!(
                                                                            "工具执行失败: {}",
                                                                            e
                                                                        )
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
                                                                round_tool_messages.push(
                                                                    ChatMessage {
                                                                        role: "tool".to_string(),
                                                                        content: Some(content),
                                                                        tool_calls: None,
                                                                        tool_call_id: Some(
                                                                            tc.id.clone(),
                                                                        ),
                                                                        name: Some(
                                                                            tc.function
                                                                                .name
                                                                                .clone(),
                                                                        ),
                                                                        images: None,
                                                                    },
                                                                );
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
                                                            full_messages
                                                                .extend(round_tool_messages);
                                                            continue;
                                                        }
                                                    }

                                                    if let Some(content) =
                                                        message["content"].as_str()
                                                    {
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
                        }

                        let _ = app.emit(
                            "ai-stream-done",
                            serde_json::json!({ "conversation_id": conversation_id }),
                        );
                        log::info!(
                            "[ai_chat_stream] done conv={} elapsed={}ms chunks={} lines={} bytes={} tool_calls={}",
                            conversation_id,
                            started_at.elapsed().as_millis(),
                            chunk_count,
                            line_count,
                            byte_count,
                            pending_tool_calls.len()
                        );
                        cancellation.clear(conversation_id);
                        return Ok(());
                    }

                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let choice = &parsed["choices"][0];
                        let emitted = emit_openai_choice_events(
                            app,
                            conversation_id,
                            choice,
                            &mut pending_tool_calls,
                            &mut tc_args_buffer,
                        );
                        if !emitted && chunk_count <= 3 {
                            let preview: String = format!("{}", choice).chars().take(200).collect();
                            log::info!(
                                "[ai_chat_stream] payload preview={} conv={}",
                                preview,
                                conversation_id
                            );
                        }
                    }
                }
            }
            Err(e) => {
                let err_msg = format!("流读取错误: {}", e);
                log::error!(
                    "[ai_chat_stream] read error conv={} elapsed={}ms chunks={} lines={} err={}",
                    conversation_id,
                    started_at.elapsed().as_millis(),
                    chunk_count,
                    line_count,
                    err_msg
                );
                if got_first_chunk && chunk_count > 10 {
                    log::warn!(
                            "[ai_chat_stream] treating read error as stream end (chunks={} lines={}), conv={}",
                            chunk_count, line_count, conversation_id
                        );
                    break;
                }
                let _ = app.emit(
                    "ai-stream-error",
                    serde_json::json!({
                        "conversation_id": conversation_id,
                        "error": err_msg.clone(),
                    }),
                );
                cancellation.clear(conversation_id);
                return Err(err_msg);
            }
        }
    }

    if !buffer.trim().is_empty() {
        line_count += 1;
        if let Some((data, _)) = extract_sse_data_line(buffer.trim()) {
            if data != "[DONE]" {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    let choice = &parsed["choices"][0];
                    let emitted = emit_openai_choice_events(
                        app,
                        conversation_id,
                        choice,
                        &mut pending_tool_calls,
                        &mut tc_args_buffer,
                    );
                    if !emitted {
                        let preview: String = format!("{}", choice).chars().take(200).collect();
                        log::info!(
                            "[ai_chat_stream] trailing payload preview={} conv={}",
                            preview,
                            conversation_id
                        );
                    }
                }
            }
        }
    }

    log::warn!(
        "[ai_chat_stream] stream ended without [DONE] conv={} elapsed={}ms chunks={} lines={} bytes={}",
        conversation_id,
        started_at.elapsed().as_millis(),
        chunk_count,
        line_count,
        byte_count
    );
    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    cancellation.clear(conversation_id);
    Ok(())
}
