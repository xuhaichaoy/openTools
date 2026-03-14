use super::model_capabilities::{supports_image_input, AIProtocol};
use super::types::ChatMessage;

const IMAGE_FALLBACK_TEXT: &str =
    "[用户发送了图片，但当前模型或协议不支持图片识别，请提醒用户切换到支持视觉输入的模型或接口]";

fn text_content_block(text: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "text",
        "text": text,
    })
}

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
                    }
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
        if let Some(tc) = &msg.tool_calls {
            json["tool_calls"] = serde_json::to_value(tc).unwrap_or_default();
        }
        if let Some(id) = &msg.tool_call_id {
            json["tool_call_id"] = serde_json::json!(id);
        }
        if let Some(n) = &msg.name {
            json["name"] = serde_json::json!(n);
        }
        json
    } else {
        let mut json = serde_json::json!({ "role": msg.role });
        if let Some(c) = &msg.content {
            json["content"] = serde_json::json!(c);
        }
        if let Some(tc) = &msg.tool_calls {
            json["tool_calls"] = serde_json::to_value(tc).unwrap_or_default();
        }
        if let Some(id) = &msg.tool_call_id {
            json["tool_call_id"] = serde_json::json!(id);
        }
        if let Some(n) = &msg.name {
            json["name"] = serde_json::json!(n);
        }
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
    let vision = supports_image_input(model, AIProtocol::OpenAI);
    let api_messages: Vec<serde_json::Value> = if vision {
        messages.iter().map(message_to_api_json).collect()
    } else {
        messages
            .iter()
            .map(|m| {
                let has_images = m.images.as_ref().map_or(false, |imgs| !imgs.is_empty());
                if has_images && m.role == "user" {
                    let mut degraded = m.clone();
                    degraded.images = None;
                    let prefix = degraded.content.as_deref().unwrap_or("").to_string();
                    degraded.content = Some(if prefix.is_empty() {
                        IMAGE_FALLBACK_TEXT.to_string()
                    } else {
                        format!("{}\n\n{}", prefix, IMAGE_FALLBACK_TEXT)
                    });
                    message_to_api_json(&degraded)
                } else {
                    message_to_api_json(m)
                }
            })
            .collect()
    };
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
    let vision = supports_image_input(model, AIProtocol::Anthropic);
    let api_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            let has_images = m.images.as_ref().map_or(false, |imgs| !imgs.is_empty());
            if !vision && has_images && m.role == "user" {
                log::info!(
                    "[anthropic_request] image input downgraded for model={} role={} reason=vision_unsupported_in_current_protocol image_count={}",
                    model,
                    m.role,
                    m.images.as_ref().map(|imgs| imgs.len()).unwrap_or(0)
                );
                let mut degraded = m.clone();
                degraded.images = None;
                let prefix = degraded.content.as_deref().unwrap_or("").to_string();
                degraded.content = Some(if prefix.is_empty() {
                    IMAGE_FALLBACK_TEXT.to_string()
                } else {
                    format!("{}\n\n{}", prefix, IMAGE_FALLBACK_TEXT)
                });
                message_to_anthropic_json(&degraded)
            } else {
                message_to_anthropic_json(m)
            }
        })
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
                parts.push(text_content_block(text));
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
                        log::info!(
                            "[anthropic_request] loaded image path={} bytes={} mime={}",
                            img_path,
                            bytes.len(),
                            mime
                        );
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
                    Err(err) => {
                        log::warn!(
                            "[anthropic_request] failed to read image path={} err={}",
                            img_path,
                            err
                        );
                    }
                }
            }
        }
        serde_json::json!({ "role": "user", "content": parts })
    } else {
        let mut parts: Vec<serde_json::Value> = Vec::new();
        if let Some(text) = &msg.content {
            if !text.is_empty() {
                parts.push(text_content_block(text));
            }
        }
        serde_json::json!({
            "role": msg.role,
            "content": if parts.is_empty() {
                serde_json::json!(msg.content.as_deref().unwrap_or(""))
            } else {
                serde_json::json!(parts)
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{build_anthropic_request, build_api_request};
    use crate::commands::ai::types::ChatMessage;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_temp_png() -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mtools-test-{nanos}.png"));
        let png_bytes: &[u8] = &[
            0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0x00, 0x00, 0x00, 0x0d, b'I', b'H',
            b'D', b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, b'I', b'D', b'A', b'T', 0x08,
            0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
            0xef, 0x00, 0x00, 0x00, 0x00, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82,
        ];
        std::fs::write(&path, png_bytes).expect("write temp png");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn minimax_anthropic_request_downgrades_image_input_to_fallback_text() {
        let request = build_anthropic_request(
            "MiniMax-M2.5",
            &[ChatMessage {
                role: "user".to_string(),
                content: Some("请根据图片生成页面".to_string()),
                images: Some(vec!["/tmp/demo.png".to_string()]),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            "",
            0.7,
            Some(1024),
            &[],
            false,
        );

        let content = request["messages"][0]["content"]
            .as_array()
            .expect("anthropic messages should use content blocks");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"].as_str(), Some("text"));

        let text = content[0]["text"].as_str().unwrap_or("");
        assert!(text.contains("请根据图片生成页面"));
        assert!(text.contains("当前模型或协议不支持图片识别"));
    }

    #[test]
    fn qwen3_5_plus_openai_request_keeps_image_blocks() {
        let image_path = write_temp_png();
        let request = build_api_request(
            "qwen3.5-plus",
            &[ChatMessage {
                role: "user".to_string(),
                content: Some("请分析这张图片".to_string()),
                images: Some(vec![image_path.clone()]),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            0.7,
            Some(1024),
            &[],
            false,
        );

        let content = request["messages"][0]["content"]
            .as_array()
            .expect("openai vision messages should use content array");
        assert_eq!(content[0]["type"].as_str(), Some("text"));
        assert_eq!(content[1]["type"].as_str(), Some("image_url"));
        let _ = std::fs::remove_file(image_path);
    }

    #[test]
    fn minimax_openai_request_downgrades_image_input_to_fallback_text() {
        let request = build_api_request(
            "MiniMax-M2.5",
            &[ChatMessage {
                role: "user".to_string(),
                content: Some("看看这张图".to_string()),
                images: Some(vec!["/tmp/demo.png".to_string()]),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            0.7,
            Some(1024),
            &[],
            false,
        );

        let content = request["messages"][0]["content"].as_str().unwrap_or("");
        assert!(content.contains("看看这张图"));
        assert!(content.contains("当前模型或协议不支持图片识别"));
    }
}
