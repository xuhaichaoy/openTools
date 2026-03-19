use std::collections::HashMap;

use serde_json::Value;

use super::types::{FunctionCall, ToolCall};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAIToolCallDelta {
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub raw_name: Option<String>,
    pub arguments_chunk: Option<String>,
}

impl OpenAIToolCallDelta {
    pub fn has_identity(&self) -> bool {
        self.id.is_some() || self.name.is_some()
    }
}

fn non_empty_str(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn blank_tool_call() -> ToolCall {
    ToolCall {
        id: String::new(),
        call_type: "function".to_string(),
        function: FunctionCall {
            name: String::new(),
            arguments: String::new(),
        },
    }
}

pub fn apply_openai_tool_call_delta(
    tool_call_delta: &Value,
    pending_tool_calls: &mut Vec<ToolCall>,
    tc_args_buffer: &mut HashMap<usize, String>,
) -> Option<OpenAIToolCallDelta> {
    let index = tool_call_delta["index"].as_u64().unwrap_or(0) as usize;
    let id = non_empty_str(tool_call_delta["id"].as_str());
    let raw_name_value = tool_call_delta
        .get("function")
        .and_then(|function| function.get("name"));
    let raw_name = raw_name_value.map(|value| value.to_string());
    let name = non_empty_str(raw_name_value.and_then(Value::as_str));
    let arguments_chunk = non_empty_str(
        tool_call_delta
            .get("function")
            .and_then(|function| function.get("arguments"))
            .and_then(Value::as_str),
    );

    if id.is_none() && name.is_none() && arguments_chunk.is_none() {
        return None;
    }

    while pending_tool_calls.len() <= index {
        pending_tool_calls.push(blank_tool_call());
    }

    if let Some(id) = &id {
        pending_tool_calls[index].id = id.clone();
    }
    if let Some(name) = &name {
        pending_tool_calls[index].function.name = name.clone();
    }
    if let Some(arguments_chunk) = &arguments_chunk {
        tc_args_buffer
            .entry(index)
            .or_default()
            .push_str(arguments_chunk);
    }

    Some(OpenAIToolCallDelta {
        index,
        id,
        name,
        raw_name,
        arguments_chunk,
    })
}

pub fn finalize_openai_tool_calls(
    pending_tool_calls: &mut Vec<ToolCall>,
    tc_args_buffer: &HashMap<usize, String>,
) -> usize {
    for (index, arguments) in tc_args_buffer {
        if let Some(tool_call) = pending_tool_calls.get_mut(*index) {
            tool_call.function.arguments = arguments.clone();
        }
    }

    for (index, tool_call) in pending_tool_calls.iter_mut().enumerate() {
        tool_call.function.name = tool_call.function.name.trim().to_string();
        if tool_call.id.trim().is_empty() && !tool_call.function.name.is_empty() {
            tool_call.id = format!("call_{}", index);
        }
    }

    let before = pending_tool_calls.len();
    pending_tool_calls.retain(|tool_call| !tool_call.function.name.trim().is_empty());
    before.saturating_sub(pending_tool_calls.len())
}

#[cfg(test)]
mod tests {
    use super::{apply_openai_tool_call_delta, finalize_openai_tool_calls};

    #[test]
    fn ignores_empty_name_delta_without_id_or_args() {
        let mut pending = Vec::new();
        let mut args = std::collections::HashMap::new();

        let delta = serde_json::json!({
            "index": 0,
            "function": {
                "name": ""
            }
        });

        let applied = apply_openai_tool_call_delta(&delta, &mut pending, &mut args);

        assert!(applied.is_none());
        assert!(pending.is_empty());
        assert!(args.is_empty());
    }

    #[test]
    fn finalization_drops_incomplete_tool_calls_and_keeps_valid_ones() {
        let mut pending = Vec::new();
        let mut args = std::collections::HashMap::new();

        let valid = serde_json::json!({
            "index": 0,
            "id": "call_abc",
            "function": {
                "name": "mcp_browser_open",
                "arguments": "{\"url\":\"https://example.com\"}"
            }
        });
        let invalid = serde_json::json!({
            "index": 1,
            "function": {
                "arguments": "{\"unused\":true}"
            }
        });

        apply_openai_tool_call_delta(&valid, &mut pending, &mut args);
        apply_openai_tool_call_delta(&invalid, &mut pending, &mut args);

        let dropped = finalize_openai_tool_calls(&mut pending, &args);

        assert_eq!(dropped, 1);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "call_abc");
        assert_eq!(pending[0].function.name, "mcp_browser_open");
        assert_eq!(
            pending[0].function.arguments,
            "{\"url\":\"https://example.com\"}"
        );
    }

    #[test]
    fn finalization_generates_missing_ids_for_valid_tool_calls() {
        let mut pending = Vec::new();
        let mut args = std::collections::HashMap::new();

        let valid = serde_json::json!({
            "index": 2,
            "function": {
                "name": "memory_search"
            }
        });

        apply_openai_tool_call_delta(&valid, &mut pending, &mut args);
        let dropped = finalize_openai_tool_calls(&mut pending, &args);

        assert_eq!(dropped, 2);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "call_2");
        assert_eq!(pending[0].function.name, "memory_search");
    }
}
