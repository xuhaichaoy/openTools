//! 统一错误类型 — 所有 Tauri command 共用，替代零散的 `Result<T, String>`。

#[derive(thiserror::Error, Debug)]
pub enum AppError {
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),

    #[error("网络请求: {0}")]
    Network(#[from] reqwest::Error),

    #[error("序列化: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("Store: {0}")]
    Store(String),

    #[error("配置: {0}")]
    Config(String),

    #[error("权限: {0}")]
    Permission(String),

    #[error("{0}")]
    Custom(String),
}

/// 允许 `Result<T, String>` 通过 `?` 自动转换为 `Result<T, AppError>`
impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Custom(s)
    }
}

/// Tauri 要求 command 错误实现 Serialize
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
