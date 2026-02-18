use super::types::ChatMessage;

/// 将 ChatMessage 转为 Vision API 兼容的 JSON（含图片 multipart content）
pub fn message_to_api_json(msg: &ChatMessage) -> serde_json::Value {
    let has_images = msg.images.as_ref().map_or(false, |imgs| !imgs.is_empty());

    if has_images && msg.role == "user" {
        let mut parts: Vec<serde_json::Value> = Vec::new();

        if let Some(text) = &msg.content {
            if !text.is_empty() {
                parts.push(serde_json::json!({
                    "type": "text",
                    "text": text
                }));
            }
        }

        if let Some(images) = &msg.images {
            for img_path in images {
                match std::fs::read(img_path) {
                    Ok(bytes) => {
                        let ext = std::path::Path::new(img_path)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("png");
                        let mime = match ext {
                            "jpg" | "jpeg" => "image/jpeg",
                            "gif" => "image/gif",
                            "webp" => "image/webp",
                            _ => "image/png",
                        };
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        parts.push(serde_json::json!({
                            "type": "image_url",
                            "image_url": {
                                "url": format!("data:{};base64,{}", mime, b64),
                                "detail": "auto"
                            }
                        }));
                    },
                    Err(e) => {
                        eprintln!("Failed to read image at {}: {}", img_path, e);
                    }
                }
            }
        }

        let mut json = serde_json::json!({
            "role": msg.role,
            "content": parts
        });
        if let Some(tc) = &msg.tool_calls { json["tool_calls"] = serde_json::to_value(tc).unwrap_or_default(); }
        if let Some(id) = &msg.tool_call_id { json["tool_call_id"] = serde_json::json!(id); }
        if let Some(n) = &msg.name { json["name"] = serde_json::json!(n); }
        json
    } else {
        let mut json = serde_json::json!({ "role": msg.role });
        if let Some(c) = &msg.content { json["content"] = serde_json::json!(c); }
        if let Some(tc) = &msg.tool_calls { json["tool_calls"] = serde_json::to_value(tc).unwrap_or_default(); }
        if let Some(id) = &msg.tool_call_id { json["tool_call_id"] = serde_json::json!(id); }
        if let Some(n) = &msg.name { json["name"] = serde_json::json!(n); }
        json
    }
}

/// 构建 OpenAI 兼容 API 请求体
pub fn build_api_request(
    model: &str,
    messages: &[ChatMessage],
    temperature: f32,
    max_tokens: Option<u32>,
    tools: &[serde_json::Value],
    stream: bool,
) -> serde_json::Value {
    let api_messages: Vec<serde_json::Value> = messages.iter().map(message_to_api_json).collect();
    let mut req = serde_json::json!({
        "model": model,
        "messages": api_messages,
        "temperature": temperature,
        "stream": stream,
    });
    if let Some(mt) = max_tokens {
        req["max_tokens"] = serde_json::json!(mt);
    }
    if !tools.is_empty() {
        req["tools"] = serde_json::json!(tools);
    }
    req
}

// ── Anthropic 协议支持 ──

/// 将 OpenAI 格式的工具定义转换为 Anthropic 格式
pub fn convert_tools_to_anthropic(tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .filter_map(|t| {
            let func = t.get("function")?;
            Some(serde_json::json!({
                "name": func.get("name")?,
                "description": func.get("description").unwrap_or(&serde_json::json!("")),
                "input_schema": func.get("parameters").unwrap_or(&serde_json::json!({"type": "object", "properties": {}})),
            }))
        })
        .collect()
}

/// 构建 Anthropic Messages API 请求体
pub fn build_anthropic_request(
    model: &str,
    messages: &[ChatMessage],
    system_prompt: &str,
    temperature: f32,
    max_tokens: Option<u32>,
    tools: &[serde_json::Value],
    stream: bool,
) -> serde_json::Value {
    let api_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| message_to_anthropic_json(m))
        .collect();

    let anthropic_tools = convert_tools_to_anthropic(tools);
    let mt = max_tokens.unwrap_or(4096);

    let mut req = serde_json::json!({
        "model": model,
        "max_tokens": mt,
        "messages": api_messages,
        "temperature": temperature,
        "stream": stream,
    });

    if !system_prompt.is_empty() {
        req["system"] = serde_json::json!(system_prompt);
    }
    if !anthropic_tools.is_empty() {
        req["tools"] = serde_json::json!(anthropic_tools);
    }
    req
}

/// 将 ChatMessage 转为 Anthropic API 格式的 JSON
pub fn message_to_anthropic_json(msg: &ChatMessage) -> serde_json::Value {
    // 特殊标记：批量 tool_results（由 anthropic_stream_loop 生成）
    if msg.tool_call_id.as_deref() == Some("__anthropic_tool_results__") {
        if let Some(content) = &msg.content {
            if let Ok(results) = serde_json::from_str::<Vec<serde_json::Value>>(content) {
                return serde_json::json!({
                    "role": "user",
                    "content": results,
                });
            }
        }
    }

    // 工具结果消息：转为 Anthropic 的 tool_result content block
    if msg.role == "tool" {
        return serde_json::json!({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": msg.tool_call_id.as_deref().unwrap_or(""),
                "content": msg.content.as_deref().unwrap_or(""),
            }],
        });
    }

    // assistant 消息带 tool_calls：转为 Anthropic 的 tool_use content blocks
    if msg.role == "assistant" && msg.tool_calls.is_some() {
        let mut content_blocks: Vec<serde_json::Value> = Vec::new();
        if let Some(text) = &msg.content {
            if !text.is_empty() {
                content_blocks.push(serde_json::json!({
                    "type": "text",
                    "text": text,
                }));
            }
        }
        if let Some(tool_calls) = &msg.tool_calls {
            for tc in tool_calls {
                let input: serde_json::Value =
                    serde_json::from_str(&tc.function.arguments).unwrap_or(serde_json::json!({}));
                content_blocks.push(serde_json::json!({
                    "type": "tool_use",
                    "id": tc.id,
                    "name": tc.function.name,
                    "input": input,
                }));
            }
        }
        return serde_json::json!({
            "role": "assistant",
            "content": content_blocks,
        });
    }

    // 普通用户/assistant 消息
    let has_images = msg.images.as_ref().map_or(false, |imgs| !imgs.is_empty());
    if has_images && msg.role == "user" {
        let mut parts: Vec<serde_json::Value> = Vec::new();
        if let Some(text) = &msg.content {
            if !text.is_empty() {
                parts.push(serde_json::json!({ "type": "text", "text": text }));
            }
        }
        if let Some(images) = &msg.images {
            for img_path in images {
                if let Ok(bytes) = std::fs::read(img_path) {
                    let ext = std::path::Path::new(img_path)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("png");
                    let mime = match ext {
                        "jpg" | "jpeg" => "image/jpeg",
                        "gif" => "image/gif",
                        "webp" => "image/webp",
                        _ => "image/png",
                    };
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    parts.push(serde_json::json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime,
                            "data": b64,
                        }
                    }));
                }
            }
        }
        serde_json::json!({ "role": "user", "content": parts })
    } else {
        serde_json::json!({
            "role": msg.role,
            "content": msg.content.as_deref().unwrap_or(""),
        })
    }
}
