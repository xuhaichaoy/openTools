pub mod openai;
pub mod anthropic;

// ── 工具确认状态（用于危险工具执行前的用户确认） ──

pub struct ToolConfirmationState {
    pub pending: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<bool>>>,
}

// ── 流式取消状态 ──

pub struct StreamCancellation {
    pub cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl StreamCancellation {
    pub fn new() -> Self {
        Self {
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn reset(&self) {
        self.cancelled.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::Relaxed)
    }
}
