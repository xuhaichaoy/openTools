pub mod anthropic;
pub mod openai;

use std::collections::HashSet;

pub fn extract_sse_data_line(line: &str) -> Option<(&str, bool)> {
    if let Some(data) = line.strip_prefix("data: ") {
        return Some((data, false));
    }
    line.strip_prefix("data:").map(|data| (data, true))
}

// ── 工具确认状态（用于危险工具执行前的用户确认） ──

pub struct ToolConfirmationState {
    pub pending: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
}

// ── 前端工具桥接状态（Ask 模式调用 MCP/插件工具） ──

pub struct FrontendToolState {
    pub pending: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>,
}

// ── 流式取消状态 ──

pub struct StreamCancellation {
    pub cancelled: std::sync::Arc<std::sync::Mutex<HashSet<String>>>,
    pub active: std::sync::Arc<std::sync::Mutex<HashSet<String>>>,
}

impl StreamCancellation {
    pub fn new() -> Self {
        Self {
            cancelled: std::sync::Arc::new(std::sync::Mutex::new(HashSet::new())),
            active: std::sync::Arc::new(std::sync::Mutex::new(HashSet::new())),
        }
    }

    pub fn reset(&self, conversation_id: &str) {
        if let Ok(mut cancelled) = self.cancelled.lock() {
            cancelled.remove(conversation_id);
        }
        if let Ok(mut active) = self.active.lock() {
            active.insert(conversation_id.to_string());
        }
    }

    pub fn clear(&self, conversation_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(conversation_id);
        }
        if let Ok(mut cancelled) = self.cancelled.lock() {
            cancelled.remove(conversation_id);
        }
    }

    pub fn cancel(&self, conversation_id: Option<&str>) {
        if let Some(id) = conversation_id {
            if let Ok(mut cancelled) = self.cancelled.lock() {
                cancelled.insert(id.to_string());
            }
            return;
        }

        let active_ids = if let Ok(active) = self.active.lock() {
            active.iter().cloned().collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if let Ok(mut cancelled) = self.cancelled.lock() {
            for id in active_ids {
                cancelled.insert(id);
            }
        }
    }

    pub fn is_cancelled(&self, conversation_id: &str) -> bool {
        self.cancelled
            .lock()
            .map(|cancelled| cancelled.contains(conversation_id))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_sse_data_line, StreamCancellation};

    #[test]
    fn cancel_specific_conversation_only_marks_target() {
        let state = StreamCancellation::new();
        state.reset("conv-a");
        state.reset("conv-b");

        state.cancel(Some("conv-a"));

        assert!(state.is_cancelled("conv-a"));
        assert!(!state.is_cancelled("conv-b"));
    }

    #[test]
    fn cancel_without_id_marks_all_active_conversations() {
        let state = StreamCancellation::new();
        state.reset("conv-a");
        state.reset("conv-b");

        state.cancel(None);

        assert!(state.is_cancelled("conv-a"));
        assert!(state.is_cancelled("conv-b"));
    }

    #[test]
    fn clear_removes_conversation_from_global_cancel_scope() {
        let state = StreamCancellation::new();
        state.reset("conv-a");
        state.reset("conv-b");
        state.clear("conv-a");

        state.cancel(None);

        assert!(!state.is_cancelled("conv-a"));
        assert!(state.is_cancelled("conv-b"));
    }

    #[test]
    fn extract_sse_data_line_accepts_standard_prefix() {
        let (data, compat) = extract_sse_data_line("data: {\"ok\":true}").unwrap();
        assert_eq!(data, "{\"ok\":true}");
        assert!(!compat);
    }

    #[test]
    fn extract_sse_data_line_accepts_compact_prefix() {
        let (data, compat) = extract_sse_data_line("data:{\"ok\":true}").unwrap();
        assert_eq!(data, "{\"ok\":true}");
        assert!(compat);
    }
}
