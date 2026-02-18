use serde::{Deserialize, Serialize};

// ── 基础类型 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 图片路径列表（用于 vision API）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AIConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub enable_advanced_tools: bool,
    #[serde(default)]
    pub system_prompt: String,
    /// 对话时自动检索知识库（RAG）
    #[serde(default)]
    pub enable_rag_auto_search: bool,
    /// 启用本机原生应用工具（日历、提醒事项、备忘录、邮件、快捷指令等）
    #[serde(default = "default_true")]
    pub enable_native_tools: bool,
    /// AI 来源：own_key / team / platform
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 团队模式时的团队 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// API 协议：openai / anthropic
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// 当前激活的自有 Key 配置 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_own_key_id: Option<String>,
}

fn default_true() -> bool { true }

impl Default for AIConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: String::new(),
            model: "gpt-4o".to_string(),
            temperature: 0.7,
            max_tokens: None,
            enable_advanced_tools: false,
            system_prompt: String::new(),
            enable_rag_auto_search: false,
            enable_native_tools: true,
            source: Some("own_key".to_string()),
            team_id: None,
            protocol: None,
            active_own_key_id: None,
        }
    }
}

/// 自有 Key 模型配置项
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OwnKeyModelConfig {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
}
