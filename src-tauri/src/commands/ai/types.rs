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
    /// 本次请求 RAG 覆盖策略：inherit / off / on（仅运行时）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_rag_mode: Option<String>,
    /// 禁用产品名触发的 RAG 兜底（仅运行时）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_force_rag: Option<bool>,
    /// 启用本机原生应用工具（日历、提醒事项、备忘录、邮件、快捷指令等）
    #[serde(default = "default_true")]
    pub enable_native_tools: bool,
    /// 启用长期记忆（总开关）
    #[serde(default = "default_true")]
    pub enable_long_term_memory: bool,
    /// 自动召回长期记忆
    #[serde(default = "default_true")]
    pub enable_memory_auto_recall: bool,
    /// 自动提取长期记忆候选
    #[serde(default = "default_true")]
    pub enable_memory_auto_save: bool,
    /// 长期记忆参与云同步
    #[serde(default = "default_true")]
    pub enable_memory_sync: bool,
    /// AI 来源：own_key / team / platform
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 团队模式时的团队 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// 团队模式时精确选择的配置 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_config_id: Option<String>,
    /// API 协议：openai / anthropic
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// 当前激活的自有 Key 配置 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_own_key_id: Option<String>,
    /// Agent 运行模式：host / hybrid / container_preferred
    #[serde(default = "default_agent_runtime_mode")]
    pub agent_runtime_mode: String,
    /// Agent 最大并发任务数
    #[serde(default = "default_agent_max_concurrency")]
    pub agent_max_concurrency: u32,
    /// Agent 重试次数上限
    #[serde(default = "default_agent_retry_max")]
    pub agent_retry_max: u32,
    /// Agent 重试退避基准毫秒
    #[serde(default = "default_agent_retry_backoff_ms")]
    pub agent_retry_backoff_ms: u64,
}

fn default_true() -> bool {
    true
}

fn default_agent_runtime_mode() -> String {
    "host".to_string()
}

fn default_agent_max_concurrency() -> u32 {
    2
}

fn default_agent_retry_max() -> u32 {
    3
}

fn default_agent_retry_backoff_ms() -> u64 {
    5000
}

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
            enable_rag_auto_search: true,
            request_rag_mode: None,
            disable_force_rag: None,
            enable_native_tools: true,
            enable_long_term_memory: true,
            enable_memory_auto_recall: true,
            enable_memory_auto_save: true,
            enable_memory_sync: true,
            source: Some("own_key".to_string()),
            team_id: None,
            team_config_id: None,
            protocol: None,
            active_own_key_id: None,
            agent_runtime_mode: default_agent_runtime_mode(),
            agent_max_concurrency: default_agent_max_concurrency(),
            agent_retry_max: default_agent_retry_max(),
            agent_retry_backoff_ms: default_agent_retry_backoff_ms(),
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
