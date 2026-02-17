use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

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

/// 判断工具是否为"危险"操作，需要用户确认才能执行
fn is_dangerous_tool(name: &str) -> bool {
    matches!(
        name,
        "run_shell_command"
            | "write_file"
            | "open_path"
            | "run_data_script"
            | "native_calendar_create_event"
            | "native_reminder_create"
            | "native_notes_create"
            | "native_mail_create"
            | "native_shortcuts_run"
    )
}

// ── Function Calling 工具定义 ──

fn get_base_tools() -> Vec<serde_json::Value> {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "search_data_scripts",
                "description": "搜索可用的数据处理脚本。在用户想要导出数据、查询数据、处理数据时调用此工具来查找合适的脚本。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词，如客户名、数据类型、操作类型等"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_data_script",
                "description": "执行一个数据导入导出脚本。在确认脚本和参数后调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "script_id": {
                            "type": "string",
                            "description": "脚本注册表中的ID"
                        },
                        "params": {
                            "type": "object",
                            "description": "脚本参数键值对",
                            "additionalProperties": true
                        }
                    },
                    "required": ["script_id", "params"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_clipboard",
                "description": "读取系统剪贴板内容",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_clipboard",
                "description": "写入内容到系统剪贴板",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "要写入的文本" }
                    },
                    "required": ["text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_knowledge_base",
                "description": "在本地知识库中检索相关信息。当用户提问的内容可能存在于已导入的文档中时调用此工具进行 RAG 检索增强。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "检索查询内容"
                        },
                        "top_k": {
                            "type": "integer",
                            "description": "返回结果数量，默认5",
                            "default": 5
                        }
                    },
                    "required": ["query"]
                }
            }
        }
    ])
    .as_array()
    .unwrap()
    .clone()
}

fn get_advanced_tools() -> Vec<serde_json::Value> {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "run_shell_command",
                "description": "执行一个 shell 命令。用于系统操作、文件管理等。请谨慎使用，避免危险操作。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要执行的 shell 命令"
                        }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取本地文件内容。支持文本文件（如 .txt, .json, .csv, .md, .py 等）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件绝对路径"
                        },
                        "max_bytes": {
                            "type": "integer",
                            "description": "最大读取字节数，默认102400(100KB)",
                            "default": 102400
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "写入内容到本地文件。如果文件不存在则创建，存在则覆盖。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件绝对路径"
                        },
                        "content": {
                            "type": "string",
                            "description": "要写入的文本内容"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "列出指定目录中的文件和文件夹。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "目录绝对路径"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_system_info",
                "description": "获取当前操作系统信息，包括系统类型、架构、主机名、用户名、Home 目录和当前时间。",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "open_url",
                "description": "使用系统默认浏览器打开一个 URL。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "要打开的 URL 地址"
                        }
                    },
                    "required": ["url"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "open_path",
                "description": "使用系统默认程序打开一个文件或文件夹（如用 Finder 打开目录、用默认程序打开图片等）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "要打开的文件或目录的绝对路径"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_running_processes",
                "description": "获取当前系统正在运行的进程列表（按内存占用排序，返回前 30 个）。",
                "parameters": { "type": "object", "properties": {} }
            }
        }
    ])
    .as_array()
    .unwrap()
    .clone()
}

fn get_native_app_tools() -> Vec<serde_json::Value> {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "native_calendar_create_event",
                "description": "在 macOS 日历应用中创建一个日程事件。支持指定日历、标题、时间、地点等。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "事件标题"
                        },
                        "start_date": {
                            "type": "string",
                            "description": "开始时间，ISO 8601 格式，如 2026-02-17T10:00:00"
                        },
                        "end_date": {
                            "type": "string",
                            "description": "结束时间，ISO 8601 格式。若不填则默认与开始时间相同"
                        },
                        "calendar": {
                            "type": "string",
                            "description": "日历名称（如「日历」「工作」等），不填则使用默认日历"
                        },
                        "location": {
                            "type": "string",
                            "description": "地点"
                        },
                        "notes": {
                            "type": "string",
                            "description": "备注"
                        },
                        "all_day": {
                            "type": "boolean",
                            "description": "是否为全天事件"
                        }
                    },
                    "required": ["title", "start_date"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_calendar_list_events",
                "description": "查询日历中最近的日程事件。可指定查询未来几天的日程。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "days": {
                            "type": "integer",
                            "description": "查询未来几天的日程，默认 1（今天）",
                            "default": 1
                        }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_reminder_create",
                "description": "在 macOS 提醒事项中创建一条提醒。支持指定列表、截止日期、优先级。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "提醒标题"
                        },
                        "notes": {
                            "type": "string",
                            "description": "备注说明"
                        },
                        "due_date": {
                            "type": "string",
                            "description": "截止日期，ISO 8601 格式，如 2026-02-17T18:00:00"
                        },
                        "list_name": {
                            "type": "string",
                            "description": "提醒列表名称（如「提醒事项」「工作」），不填使用默认列表"
                        },
                        "priority": {
                            "type": "integer",
                            "description": "优先级: 0=无, 1=高, 5=中, 9=低"
                        }
                    },
                    "required": ["title"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_reminder_list_incomplete",
                "description": "查询未完成的提醒事项列表。可指定某个列表或查询全部。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "list_name": {
                            "type": "string",
                            "description": "提醒列表名称，不填则查询所有列表"
                        }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_notes_create",
                "description": "在 macOS 备忘录中创建一条新笔记。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "备忘录标题"
                        },
                        "body": {
                            "type": "string",
                            "description": "备忘录内容"
                        },
                        "folder": {
                            "type": "string",
                            "description": "文件夹名称，不填使用默认文件夹"
                        }
                    },
                    "required": ["title", "body"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_notes_search",
                "description": "在 macOS 备忘录中搜索笔记。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "最大返回数量，默认10",
                            "default": 10
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_mail_create",
                "description": "使用 macOS 邮件应用创建一封邮件草稿并打开编辑窗口。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "to": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "收件人邮箱地址列表"
                        },
                        "subject": {
                            "type": "string",
                            "description": "邮件主题"
                        },
                        "body": {
                            "type": "string",
                            "description": "邮件正文"
                        },
                        "cc": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "抄送邮箱地址列表"
                        }
                    },
                    "required": ["to", "subject", "body"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_shortcuts_run",
                "description": "运行一个 macOS 快捷指令（Shortcuts），可传入输入文本。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "快捷指令名称"
                        },
                        "input": {
                            "type": "string",
                            "description": "传给快捷指令的输入文本（可选）"
                        }
                    },
                    "required": ["name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_app_open",
                "description": "打开/激活一个本机应用程序。如果应用已运行则切换到前台。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "app_name": {
                            "type": "string",
                            "description": "应用名称，如 Safari、Calendar、Reminders、Notes、Finder、Terminal 等"
                        }
                    },
                    "required": ["app_name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_app_list_interactive",
                "description": "列出所有可以通过 AI 交互的本机应用及其支持的操作。用户询问「能做什么」「有哪些应用」时调用。",
                "parameters": { "type": "object", "properties": {} }
            }
        }
    ])
    .as_array()
    .unwrap()
    .clone()
}

fn get_tools(enable_advanced: bool, enable_native: bool) -> Vec<serde_json::Value> {
    let mut tools = get_base_tools();
    if enable_advanced {
        tools.extend(get_advanced_tools());
    }
    if enable_native {
        tools.extend(get_native_app_tools());
    }
    tools
}

fn get_system_prompt(enable_advanced: bool, enable_native: bool, custom_prompt: &str) -> String {
    let mut base = String::from("你是 mTools 的 AI 助手，一个强大的桌面效率工具。你可以：\n\
     1. 搜索和执行数据导入导出脚本（数据工坊）\n\
     2. 读写剪贴板\n\
     3. 搜索本地知识库（RAG 检索增强）\n\n\
     当用户需要处理数据时，先用 search_data_scripts 搜索合适的脚本，\n\
     然后向用户确认参数，最后用 run_data_script 执行。\n\
     当用户提问的内容可能存在于知识库文档中时，使用 search_knowledge_base 检索相关信息，\n\
     并基于检索结果提供准确的回答，注明信息来源。\n");

    if enable_native {
        base.push_str("\n你拥有强大的本机应用交互能力：\n\
     - 日历：创建日程事件、查看今日/近期日程（native_calendar_create_event, native_calendar_list_events）\n\
     - 提醒事项：创建提醒、查看未完成提醒（native_reminder_create, native_reminder_list_incomplete）\n\
     - 备忘录：创建笔记、搜索笔记（native_notes_create, native_notes_search）\n\
     - 邮件：创建邮件草稿（native_mail_create）\n\
     - 快捷指令：运行 macOS 快捷指令（native_shortcuts_run）\n\
     - 打开应用：启动或切换到任意应用（native_app_open）\n\
     当用户说「定一个日程」「提醒我」「记一下」「发邮件」等，应自动识别意图并调用对应的原生应用工具。\n\
     调用前先从用户描述中提取关键信息（时间、标题、内容等），缺少必要信息时简短追问。\n");
    }

    let mut prompt = if enable_advanced {
        format!(
            "{}此外，你还拥有以下高级能力：\n\
             - 执行 shell 命令（run_shell_command）\n\
             - 读写本地文件、列出目录（read_file / write_file / list_directory）\n\
             - 获取系统信息（get_system_info）\n\
             - 用默认浏览器打开 URL（open_url）\n\
             - 用系统默认程序打开文件/目录（open_path）\n\
             - 获取运行中的进程列表（get_running_processes）\n\n\
             注意：部分危险操作（执行命令、写入文件、打开路径）会在执行前请求用户确认。\n\
             回答使用中文，简洁专业。",
            base
        )
    } else {
        format!("{}回答使用中文，简洁专业。", base)
    };

    // 追加用户自定义 prompt
    if !custom_prompt.is_empty() {
        prompt.push_str("\n\n用户补充指令：\n");
        prompt.push_str(custom_prompt);
    }

    prompt
}

// ── 工具执行 ──

async fn execute_tool(app: &AppHandle, name: &str, args: &str) -> Result<String, String> {
    let args_value: serde_json::Value =
        serde_json::from_str(args).unwrap_or(serde_json::Value::Object(Default::default()));

    // 对危险工具，先请求用户确认
    if is_dangerous_tool(name) {
        let approved = request_tool_confirmation(app, name, args).await?;
        if !approved {
            return Ok("用户拒绝执行此操作。".to_string());
        }
    }

    match name {
        "search_data_scripts" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let results = super::data_forge::dataforge_search_scripts(app.clone(), query).await?;
            Ok(serde_json::to_string_pretty(&results).unwrap_or_default())
        }
        "run_data_script" => {
            let script_id = args_value["script_id"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let params: HashMap<String, serde_json::Value> = args_value["params"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            let result =
                super::data_forge::dataforge_run_script(app.clone(), script_id, params).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "run_shell_command" => {
            let command = args_value["command"].as_str().unwrap_or("echo hello");
            let output = std::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .output()
                .map_err(|e| format!("执行失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(format!(
                "exit_code: {}\nstdout:\n{}\nstderr:\n{}",
                output.status.code().unwrap_or(-1),
                stdout,
                stderr
            ))
        }
        "read_clipboard" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let text = app.clipboard().read_text().unwrap_or_default();
            Ok(text)
        }
        "write_clipboard" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let text = args_value["text"].as_str().unwrap_or("").to_string();
            app.clipboard()
                .write_text(&text)
                .map_err(|e| e.to_string())?;
            Ok("已写入剪贴板".to_string())
        }
        "search_knowledge_base" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let top_k = args_value["top_k"].as_u64().map(|v| v as usize);
            let results = super::rag::rag_search(app.clone(), query, top_k, None).await?;
            if results.is_empty() {
                Ok("知识库中未找到相关内容。".to_string())
            } else {
                let mut output = format!("在知识库中找到 {} 个相关片段:\n\n", results.len());
                for (i, r) in results.iter().enumerate() {
                    output.push_str(&format!(
                        "--- 片段 {} (来源: {}, 相似度: {:.1}%) ---\n{}\n\n",
                        i + 1,
                        r.chunk.metadata.source,
                        r.score * 100.0,
                        r.chunk.content
                    ));
                }
                Ok(output)
            }
        }
        "read_file" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            let max_bytes = args_value["max_bytes"].as_u64().unwrap_or(102400) as usize;
            let file_path = std::path::Path::new(&path);
            if !file_path.exists() {
                return Err(format!("文件不存在: {}", path));
            }
            let bytes = std::fs::read(&file_path).map_err(|e| format!("读取失败: {}", e))?;
            let truncated = if bytes.len() > max_bytes { &bytes[..max_bytes] } else { &bytes };
            let content = String::from_utf8_lossy(truncated).to_string();
            if bytes.len() > max_bytes {
                Ok(format!("{}\n\n[文件截断，已读取 {}/{} 字节]", content, max_bytes, bytes.len()))
            } else {
                Ok(content)
            }
        }
        "write_file" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            let content = args_value["content"].as_str().unwrap_or("").to_string();
            let file_path = std::path::Path::new(&path);
            if let Some(parent) = file_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
            }
            std::fs::write(&file_path, &content).map_err(|e| format!("写入失败: {}", e))?;
            Ok(format!("已写入 {} ({} 字节)", path, content.len()))
        }
        "list_directory" => {
            let path = args_value["path"].as_str().unwrap_or(".").to_string();
            let dir_path = std::path::Path::new(&path);
            if !dir_path.exists() {
                return Err(format!("目录不存在: {}", path));
            }
            if !dir_path.is_dir() {
                return Err(format!("不是目录: {}", path));
            }
            let mut entries = Vec::new();
            let read_dir = std::fs::read_dir(&dir_path).map_err(|e| format!("读取目录失败: {}", e))?;
            for entry in read_dir {
                if let Ok(entry) = entry {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let ft = entry.file_type().map(|t| {
                        if t.is_dir() { "📁" } else if t.is_symlink() { "🔗" } else { "📄" }
                    }).unwrap_or("❓");
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        entries.push(format!("{} {}/", ft, name));
                    } else {
                        entries.push(format!("{} {} ({} bytes)", ft, name, size));
                    }
                }
            }
            entries.sort();
            Ok(format!("目录 {} 下共 {} 项:\n{}", path, entries.len(), entries.join("\n")))
        }
        // ── 新增高级工具 ──
        "get_system_info" => {
            let os = std::env::consts::OS;
            let arch = std::env::consts::ARCH;
            let hostname = hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string());
            let username = std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .unwrap_or_else(|_| "unknown".to_string());
            let home = dirs::home_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            Ok(format!(
                "操作系统: {} {}\n主机名: {}\n用户名: {}\nHome目录: {}\n当前时间: {}",
                os, arch, hostname, username, home, now
            ))
        }
        "open_url" => {
            let url = args_value["url"].as_str().unwrap_or("").to_string();
            if url.is_empty() {
                return Err("URL 不能为空".to_string());
            }
            open::that(&url).map_err(|e| format!("打开失败: {}", e))?;
            Ok(format!("已在默认浏览器打开: {}", url))
        }
        "open_path" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            if path.is_empty() {
                return Err("路径不能为空".to_string());
            }
            open::that(&path).map_err(|e| format!("打开失败: {}", e))?;
            Ok(format!("已打开: {}", path))
        }
        "get_running_processes" => {
            let output = std::process::Command::new("ps")
                .args(["aux"])
                .output()
                .map_err(|e| format!("获取进程列表失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let lines: Vec<&str> = stdout.lines().collect();
            let top_lines: Vec<&str> = lines.iter().take(31).copied().collect();
            Ok(format!("当前运行进程 (前30):\n{}", top_lines.join("\n")))
        }
        // ── 原生应用工具 ──
        "native_calendar_create_event" => {
            let title = args_value["title"].as_str().unwrap_or("").to_string();
            let start_date = args_value["start_date"].as_str().unwrap_or("").to_string();
            let end_date = args_value["end_date"].as_str().map(|s| s.to_string());
            let calendar = args_value["calendar"].as_str().map(|s| s.to_string());
            let location = args_value["location"].as_str().map(|s| s.to_string());
            let notes = args_value["notes"].as_str().map(|s| s.to_string());
            let all_day = args_value["all_day"].as_bool();
            let result = super::native_apps::native_calendar_create_event(
                calendar, title, start_date, end_date, location, notes, all_day,
            ).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_calendar_list_events" => {
            let days = args_value["days"].as_i64().map(|d| d as i32);
            let result = super::native_apps::native_calendar_list_events(days).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_reminder_create" => {
            let title = args_value["title"].as_str().unwrap_or("").to_string();
            let list_name = args_value["list_name"].as_str().map(|s| s.to_string());
            let notes = args_value["notes"].as_str().map(|s| s.to_string());
            let due_date = args_value["due_date"].as_str().map(|s| s.to_string());
            let priority = args_value["priority"].as_i64().map(|p| p as i32);
            let result = super::native_apps::native_reminder_create(
                list_name, title, notes, due_date, priority,
            ).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_reminder_list_incomplete" => {
            let list_name = args_value["list_name"].as_str().map(|s| s.to_string());
            let result = super::native_apps::native_reminder_list_incomplete(list_name).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_notes_create" => {
            let title = args_value["title"].as_str().unwrap_or("").to_string();
            let body = args_value["body"].as_str().unwrap_or("").to_string();
            let folder = args_value["folder"].as_str().map(|s| s.to_string());
            let result = super::native_apps::native_notes_create(folder, title, body).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_notes_search" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let limit = args_value["limit"].as_u64().map(|l| l as usize);
            let result = super::native_apps::native_notes_search(query, limit).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_mail_create" => {
            let to: Vec<String> = args_value["to"].as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            let subject = args_value["subject"].as_str().unwrap_or("").to_string();
            let body = args_value["body"].as_str().unwrap_or("").to_string();
            let cc: Option<Vec<String>> = args_value["cc"].as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());
            let result = super::native_apps::native_mail_create(to, subject, body, cc).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_shortcuts_run" => {
            let shortcut_name = args_value["name"].as_str().unwrap_or("").to_string();
            let input = args_value["input"].as_str().map(|s| s.to_string());
            let result = super::native_apps::native_shortcuts_run(shortcut_name, input).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_app_open" => {
            let app_name = args_value["app_name"].as_str().unwrap_or("").to_string();
            let result = super::native_apps::native_app_open(app_name).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_app_list_interactive" => {
            let result = super::native_apps::native_app_list_interactive().await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        _ => Err(format!("未知工具: {}", name)),
    }
}

/// 请求用户确认危险工具的执行
async fn request_tool_confirmation(app: &AppHandle, name: &str, args: &str) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

    // 存储 sender 到 managed state
    {
        let state = app.state::<ToolConfirmationState>();
        let mut pending = state.pending.lock().map_err(|e| format!("锁获取失败: {}", e))?;
        *pending = Some(tx);
    }

    // 发送确认请求事件到前端
    let _ = app.emit(
        "ai-tool-confirm-request",
        serde_json::json!({
            "name": name,
            "arguments": args,
        }),
    );

    // 等待前端回复（60 秒超时）
    match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
        Ok(Ok(approved)) => Ok(approved),
        Ok(Err(_)) => Ok(false), // channel 关闭，视为拒绝
        Err(_) => {
            // 超时，清理 pending state
            let state = app.state::<ToolConfirmationState>();
            let mut pending = state.pending.lock().map_err(|e| format!("锁获取失败: {}", e))?;
            *pending = None;
            Ok(false) // 超时视为拒绝
        }
    }
}

// ── API 请求构建 ──

/// 将 ChatMessage 转为 Vision API 兼容的 JSON（含图片 multipart content）
fn message_to_api_json(msg: &ChatMessage) -> serde_json::Value {
    let has_images = msg.images.as_ref().map_or(false, |imgs| !imgs.is_empty());

    if has_images && msg.role == "user" {
        // Vision multipart content: 专家建议文本在前，图片在后
        let mut parts: Vec<serde_json::Value> = Vec::new();
        
        // 1. 文本部分
        if let Some(text) = &msg.content {
            if !text.is_empty() {
                parts.push(serde_json::json!({
                    "type": "text",
                    "text": text
                }));
            }
        }

        // 2. 图片部分
        if let Some(images) = &msg.images {
            for img_path in images {
                // 读取图片文件并转为 base64 data URI
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
        // 保留可选字段
        if let Some(tc) = &msg.tool_calls { json["tool_calls"] = serde_json::to_value(tc).unwrap(); }
        if let Some(id) = &msg.tool_call_id { json["tool_call_id"] = serde_json::json!(id); }
        if let Some(n) = &msg.name { json["name"] = serde_json::json!(n); }
        json
    } else {
        // 普通消息：直接序列化（images 字段 skip_serializing_if None）
        let mut json = serde_json::json!({ "role": msg.role });
        if let Some(c) = &msg.content { json["content"] = serde_json::json!(c); }
        if let Some(tc) = &msg.tool_calls { json["tool_calls"] = serde_json::to_value(tc).unwrap(); }
        if let Some(id) = &msg.tool_call_id { json["tool_call_id"] = serde_json::json!(id); }
        if let Some(n) = &msg.name { json["name"] = serde_json::json!(n); }
        json
    }
}

/// 构建 API 请求体
fn build_api_request(
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
fn convert_tools_to_anthropic(tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
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
fn build_anthropic_request(
    model: &str,
    messages: &[ChatMessage],
    system_prompt: &str,
    temperature: f32,
    max_tokens: Option<u32>,
    tools: &[serde_json::Value],
    stream: bool,
) -> serde_json::Value {
    // 过滤掉 system 消息（Anthropic 的 system 是顶层字段）
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
fn message_to_anthropic_json(msg: &ChatMessage) -> serde_json::Value {
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

/// Anthropic 流式对话处理
async fn anthropic_stream_loop(
    app: &AppHandle,
    client: &reqwest::Client,
    config: &AIConfig,
    conversation_id: &str,
    system_prompt: &str,
    mut full_messages: Vec<ChatMessage>,
    tools: &[serde_json::Value],
) -> Result<(), String> {
    let cancellation = app.state::<StreamCancellation>();

    for _round in 0..6 {
        let request = build_anthropic_request(
            &config.model,
            &full_messages,
            system_prompt,
            config.temperature,
            config.max_tokens,
            tools,
            true,
        );

        let url = format!("{}/v1/messages", config.base_url);
        let is_team = config.source.as_deref() == Some("team") || config.source.as_deref() == Some("platform");

        // 团队/平台模式：需要同时发 Authorization（给服务端 auth middleware）和 x-api-key
        let mut req_builder = client
            .post(&url)
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json");
        if is_team {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", config.api_key));
        }

        // 团队模式：注入 team_id 到请求体
        let final_request = if is_team {
            if let Some(ref tid) = config.team_id {
                let mut r = request.clone();
                r["team_id"] = serde_json::json!(tid);
                r
            } else {
                request.clone()
            }
        } else {
            request.clone()
        };

        let response = req_builder
            .json(&final_request)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let status_code = status.as_u16();
            let body = response.text().await.unwrap_or_default();
            let error_detail = if body.is_empty() {
                format!("HTTP {} (无响应体)", status_code)
            } else {
                // 尝试提取 Anthropic JSON 错误中的 message 字段
                let readable = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| body[..body.len().min(300)].to_string());
                format!("HTTP {} — {}", status_code, readable)
            };
            log::error!("[anthropic_stream] {} → {}", url, error_detail);
            let error_msg = format!("Anthropic API 错误: {}", error_detail);
            let _ = app.emit(
                "ai-stream-error",
                serde_json::json!({
                    "conversation_id": conversation_id,
                    "error": &error_msg,
                }),
            );
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

        while let Some(chunk) = stream.next().await {
            if cancellation.is_cancelled() {
                let _ = app.emit(
                    "ai-stream-done",
                    serde_json::json!({ "conversation_id": conversation_id }),
                );
                return Ok(());
            }

            match chunk {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    while let Some(pos) = buffer.find('\n') {
                        let line = buffer[..pos].trim().to_string();
                        buffer = buffer[pos + 1..].to_string();

                        if !line.starts_with("data: ") {
                            continue;
                        }
                        let data = &line[6..];

                        let parsed: serde_json::Value = match serde_json::from_str(data) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };

                        let event_type = parsed["type"].as_str().unwrap_or("");

                        match event_type {
                            "content_block_start" => {
                                let block = &parsed["content_block"];
                                if block["type"].as_str() == Some("tool_use") {
                                    has_tool_use = true;
                                    current_tool_id = block["id"].as_str().unwrap_or("").to_string();
                                    current_tool_name = block["name"].as_str().unwrap_or("").to_string();
                                    current_tool_input.clear();
                                }
                            }
                            "content_block_delta" => {
                                let delta = &parsed["delta"];
                                match delta["type"].as_str() {
                                    Some("text_delta") => {
                                        if let Some(text) = delta["text"].as_str() {
                                            let _ = app.emit(
                                                "ai-stream-chunk",
                                                serde_json::json!({
                                                    "conversation_id": conversation_id,
                                                    "content": text,
                                                }),
                                            );
                                        }
                                    }
                                    Some("input_json_delta") => {
                                        if let Some(json_str) = delta["partial_json"].as_str() {
                                            current_tool_input.push_str(json_str);
                                        }
                                    }
                                    _ => {}
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
                            "message_stop" => {
                                // 处理完成
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    let _ = app.emit(
                        "ai-stream-error",
                        serde_json::json!({
                            "conversation_id": conversation_id,
                            "error": format!("流读取错误: {}", e),
                        }),
                    );
                    return Err(format!("流读取错误: {}", e));
                }
            }
        }

        // 如果没有工具调用，结束
        if pending_tool_calls.is_empty() {
            let _ = app.emit(
                "ai-stream-done",
                serde_json::json!({ "conversation_id": conversation_id }),
            );
            return Ok(());
        }

        // 有工具调用：通知前端并执行
        let _ = app.emit(
            "ai-stream-tool-calls",
            serde_json::json!({
                "conversation_id": conversation_id,
                "tool_calls": &pending_tool_calls,
            }),
        );

        // 构建 assistant 消息（带 tool_use）和 tool_result 消息
        let mut assistant_content: Vec<serde_json::Value> = Vec::new();
        let mut tool_results: Vec<serde_json::Value> = Vec::new();

        for tc in &pending_tool_calls {
            let result = execute_tool(app, &tc.function.name, &tc.function.arguments).await;
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

            let input: serde_json::Value =
                serde_json::from_str(&tc.function.arguments).unwrap_or(serde_json::json!({}));
            assistant_content.push(serde_json::json!({
                "type": "tool_use",
                "id": tc.id,
                "name": tc.function.name,
                "input": input,
            }));
            tool_results.push(serde_json::json!({
                "type": "tool_result",
                "tool_use_id": tc.id,
                "content": content,
            }));
        }

        // 追加到消息历史
        full_messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: None,
            tool_calls: Some(pending_tool_calls),
            tool_call_id: None,
            name: None,
            images: None,
        });
        // tool_result 作为 user 消息（Anthropic 格式）
        full_messages.push(ChatMessage {
            role: "user".to_string(),
            content: Some(serde_json::to_string(&tool_results).unwrap_or_default()),
            tool_calls: None,
            tool_call_id: Some("__anthropic_tool_results__".to_string()),
            name: None,
            images: None,
        });

        // 继续下一轮
    }

    // 达到最大轮次
    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    Ok(())
}

/// 保存聊天图片到应用数据目录，返回文件路径
#[tauri::command]
pub async fn ai_save_chat_image(
    app: AppHandle,
    image_data: String,  // base64 编码的图片数据（不含 data:... 前缀）
    file_name: String,    // 文件名，如 "img_1234.png"
) -> Result<String, String> {
    use tauri::Manager;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {}", e))?;
    let images_dir = app_data_dir.join("chat_images");
    std::fs::create_dir_all(&images_dir).map_err(|e| format!("创建目录失败: {}", e))?;

    let file_path = images_dir.join(&file_name);

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_data)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    std::fs::write(&file_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}


// ── Tauri Commands ──

/// 前端调用此命令取消流式生成
#[tauri::command]
pub async fn ai_stop_stream(app: AppHandle) -> Result<(), String> {
    let state = app.state::<StreamCancellation>();
    state.cancel();
    Ok(())
}

/// 前端调用此命令，回复工具确认请求
#[tauri::command]
pub async fn ai_confirm_tool(app: AppHandle, approved: bool) -> Result<(), String> {
    let state = app.state::<ToolConfirmationState>();
    let mut pending = state.pending.lock().map_err(|e| format!("锁获取失败: {}", e))?;
    if let Some(tx) = pending.take() {
        let _ = tx.send(approved);
    }
    Ok(())
}

/// 非流式 AI 对话（保持向后兼容）
#[tauri::command]
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    config: AIConfig,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let protocol = config.protocol.as_deref().unwrap_or("openai");
    let is_team = config.source.as_deref() == Some("team") || config.source.as_deref() == Some("platform");

    if protocol == "anthropic" {
        // ── Anthropic Messages API ──
        // 提取 system prompt（从 messages 中的 system 角色消息）
        let system_prompt: String = messages
            .iter()
            .filter(|m| m.role == "system")
            .filter_map(|m| m.content.as_deref())
            .collect::<Vec<_>>()
            .join("\n");

        let request = build_anthropic_request(
            &config.model,
            &messages,
            &system_prompt,
            config.temperature,
            config.max_tokens,
            &[],   // 非流式不传工具
            false,  // stream = false
        );

        let url = format!("{}/v1/messages", config.base_url);
        let mut req_builder = client
            .post(&url)
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json");
        if is_team {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", config.api_key));
        }

        // 团队模式：注入 team_id 到请求体
        let final_request = if let Some(ref tid) = config.team_id {
            let mut r = request.clone();
            r["team_id"] = serde_json::json!(tid);
            r
        } else {
            request
        };

        let response = req_builder
            .json(&final_request)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;

        let status = response.status();
        let body = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;

        if !status.is_success() {
            return Err(format!("Anthropic API 错误 (HTTP {}): {}", status.as_u16(), body));
        }

        let parsed: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;

        // Anthropic 响应格式：content[].text
        if let Some(content_arr) = parsed["content"].as_array() {
            let text_parts: Vec<&str> = content_arr
                .iter()
                .filter(|block| block["type"].as_str() == Some("text"))
                .filter_map(|block| block["text"].as_str())
                .collect();
            if !text_parts.is_empty() {
                return Ok(text_parts.join(""));
            }
        }
        Err("Anthropic 无回复内容".to_string())
    } else {
        // ── OpenAI 协议（默认） ──
        let mut request = build_api_request(
            &config.model, &messages, config.temperature, config.max_tokens, &[], false,
        );

        // 团队模式：注入 team_id 到请求体
        if let Some(ref tid) = config.team_id {
            request["team_id"] = serde_json::json!(tid);
        }

        let response = client
            .post(format!("{}/chat/completions", config.base_url))
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;

        let status = response.status();
        let body = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;

        if !status.is_success() {
            return Err(format!("API 错误 (HTTP {}): {}", status.as_u16(), body));
        }

        let parsed: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;

        parsed["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "无回复内容".to_string())
    }
}

/// 流式 AI 对话（支持 Function Calling + 多轮工具调用）
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    messages: Vec<ChatMessage>,
    config: AIConfig,
    conversation_id: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let enable_advanced = config.enable_advanced_tools;
    let enable_native = config.enable_native_tools;
    let tools = get_tools(enable_advanced, enable_native);

    // 重置取消标志
    let cancellation = app.state::<StreamCancellation>();
    cancellation.reset();

    // 构建 system prompt（可能包含 RAG 检索结果）
    let mut system_prompt = get_system_prompt(enable_advanced, enable_native, &config.system_prompt);

    // RAG 自动检索：如果开启，从用户最后一条消息中提取查询词进行知识库检索
    if config.enable_rag_auto_search {
        if let Some(user_query) = messages.iter().rev().find(|m| m.role == "user").and_then(|m| m.content.as_ref()) {
            match super::rag::rag_search(app.clone(), user_query.clone(), Some(3), Some(0.5)).await {
                Ok(results) if !results.is_empty() => {
                    let mut rag_context = String::from(
                        "\n\n---\n以下是从用户知识库中检索到的相关信息，请参考回答（如有引用请标注来源文档）：\n\n"
                    );
                    for (i, r) in results.iter().enumerate() {
                        rag_context.push_str(&format!(
                            "[{}] 来源：{}（相关度 {:.0}%）\n{}\n\n",
                            i + 1, r.chunk.metadata.source, r.score * 100.0, r.chunk.content,
                        ));
                    }
                    system_prompt.push_str(&rag_context);
                    log::info!("RAG 自动检索：注入 {} 条知识库结果", results.len());
                }
                Ok(_) => { /* 无相关结果，不注入 */ }
                Err(e) => {
                    log::warn!("RAG 自动检索失败: {}", e);
                }
            }
        }
    }

    // Anthropic 协议分支
    let protocol = config.protocol.as_deref().unwrap_or("openai");
    if protocol == "anthropic" {
        let full_messages: Vec<ChatMessage> = messages;
        return anthropic_stream_loop(
            &app, &client, &config, &conversation_id,
            &system_prompt, full_messages, &tools,
        ).await;
    }

    // ── OpenAI 协议（默认） ──

    // 注入 system prompt
    let mut full_messages = vec![ChatMessage {
        role: "system".to_string(),
        content: Some(system_prompt),
        tool_calls: None,
        tool_call_id: None,
        name: None,
        images: None,
    }];
    full_messages.extend(messages);

    let mut request = build_api_request(
        &config.model, &full_messages, config.temperature, config.max_tokens, &tools, true,
    );

    // 团队模式：注入 team_id 到请求体（服务端团队代理需要此字段）
    if let Some(ref tid) = config.team_id {
        request["team_id"] = serde_json::json!(tid);
    }

    let url = format!("{}/chat/completions", config.base_url);
    log::info!("[ai_chat_stream] POST {} | source={:?} model={} team_id={:?}",
        url, config.source, config.model, config.team_id);

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        log::error!("[ai_chat_stream] {} → HTTP {} body={}", url, status, &body[..body.len().min(200)]);
        let _ = app.emit(
            "ai-stream-error",
            serde_json::json!({
                "conversation_id": conversation_id,
                "error": format!("API 错误: {}", body),
            }),
        );
        return Err(format!("API 错误: {}", body));
    }

    // 流式读取 SSE — 收集 tool_calls
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut tc_args_buffer: HashMap<usize, String> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        // 检查是否已取消
        if cancellation.is_cancelled() {
            let _ = app.emit(
                "ai-stream-done",
                serde_json::json!({ "conversation_id": conversation_id }),
            );
            return Ok(());
        }

        match chunk {
            Ok(bytes) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    if !line.starts_with("data: ") {
                        continue;
                    }
                    let data = &line[6..];
                    if data == "[DONE]" {
                        // 检查是否有 pending tool calls
                        if !pending_tool_calls.is_empty() {
                            // 先组装完整的 arguments
                            for (idx, args) in &tc_args_buffer {
                                if let Some(tc) = pending_tool_calls.get_mut(*idx) {
                                    tc.function.arguments = args.clone();
                                }
                            }
                            // 通知前端有工具调用
                            let _ = app.emit(
                                "ai-stream-tool-calls",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "tool_calls": &pending_tool_calls,
                                }),
                            );
                            // 执行工具并返回结果
                            let mut tool_messages = Vec::new();
                            for tc in &pending_tool_calls {
                                let result = execute_tool(&app, &tc.function.name, &tc.function.arguments).await;
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

                            // 用工具结果继续对话
                            full_messages.push(ChatMessage {
                                role: "assistant".to_string(),
                                content: None,
                                tool_calls: Some(pending_tool_calls.clone()),
                                tool_call_id: None,
                                name: None,
                                images: None,
                            });
                            full_messages.extend(tool_messages);

                            // 多轮工具调用循环（最多 5 轮）
                            for _round in 0..5 {
                                // 检查是否已取消
                                if cancellation.is_cancelled() {
                                    break;
                                }
                                let mut follow_request = build_api_request(
                                    &config.model, &full_messages, config.temperature, config.max_tokens, &tools, false,
                                );
                                // 团队模式：注入 team_id
                                if let Some(ref tid) = config.team_id {
                                    follow_request["team_id"] = serde_json::json!(tid);
                                }

                                match client
                                    .post(format!("{}/chat/completions", config.base_url))
                                    .header("Authorization", format!("Bearer {}", config.api_key))
                                    .header("Content-Type", "application/json")
                                    .json(&follow_request)
                                    .send()
                                    .await
                                {
                                    Ok(resp) => {
                                        if let Ok(body) = resp.text().await {
                                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
                                                let message = &parsed["choices"][0]["message"];

                                                // 检查是否还有 tool_calls（多轮）
                                                if let Some(new_tcs) = message["tool_calls"].as_array() {
                                                    if !new_tcs.is_empty() {
                                                        // 解析新一轮 tool_calls
                                                        let mut round_tool_calls: Vec<ToolCall> = Vec::new();
                                                        for tc_val in new_tcs {
                                                            let tc = ToolCall {
                                                                id: tc_val["id"].as_str().unwrap_or("").to_string(),
                                                                call_type: "function".to_string(),
                                                                function: FunctionCall {
                                                                    name: tc_val["function"]["name"].as_str().unwrap_or("").to_string(),
                                                                    arguments: tc_val["function"]["arguments"].as_str().unwrap_or("{}").to_string(),
                                                                },
                                                            };
                                                            round_tool_calls.push(tc);
                                                        }

                                                        // 通知前端
                                                        let _ = app.emit(
                                                            "ai-stream-tool-calls",
                                                            serde_json::json!({
                                                                "conversation_id": conversation_id,
                                                                "tool_calls": &round_tool_calls,
                                                            }),
                                                        );

                                                        // 执行工具
                                                        let mut round_tool_messages = Vec::new();
                                                        for tc in &round_tool_calls {
                                                            let result = execute_tool(&app, &tc.function.name, &tc.function.arguments).await;
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
                                                            round_tool_messages.push(ChatMessage {
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
                                                            content: message["content"].as_str().map(|s| s.to_string()),
                                                            tool_calls: Some(round_tool_calls),
                                                            tool_call_id: None,
                                                            name: None,
                                                            images: None,
                                                        });
                                                        full_messages.extend(round_tool_messages);
                                                        continue; // 继续下一轮
                                                    }
                                                }

                                                // 没有更多 tool_calls，输出最终文本
                                                if let Some(content) = message["content"].as_str() {
                                                    let _ = app.emit(
                                                        "ai-stream-chunk",
                                                        serde_json::json!({
                                                            "conversation_id": conversation_id,
                                                            "content": content,
                                                        }),
                                                    );
                                                }
                                                break; // 结束循环
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

                        let _ = app.emit(
                            "ai-stream-done",
                            serde_json::json!({ "conversation_id": conversation_id }),
                        );
                        return Ok(());
                    }

                    // 解析 delta（修复：先确保条目存在，再分别填充字段）
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let delta = &parsed["choices"][0]["delta"];

                        // 普通内容
                        if let Some(content) = delta["content"].as_str() {
                            let _ = app.emit(
                                "ai-stream-chunk",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "content": content,
                                }),
                            );
                        }

                        // tool_calls delta
                        if let Some(tcs) = delta["tool_calls"].as_array() {
                            for tc in tcs {
                                let idx = tc["index"].as_u64().unwrap_or(0) as usize;

                                // 确保 index 对应的条目已存在
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

                                // 填充 id（可能在第一个 chunk 到达）
                                if let Some(id) = tc["id"].as_str() {
                                    pending_tool_calls[idx].id = id.to_string();
                                }

                                // 填充 function 字段
                                if let Some(func) = tc["function"].as_object() {
                                    if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                                        pending_tool_calls[idx].function.name = name.to_string();
                                    }
                                    if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                                        tc_args_buffer
                                            .entry(idx)
                                            .or_default()
                                            .push_str(args);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "ai-stream-error",
                    serde_json::json!({
                        "conversation_id": conversation_id,
                        "error": format!("流读取错误: {}", e),
                    }),
                );
                return Err(format!("流读取错误: {}", e));
            }
        }
    }

    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    Ok(())
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
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let cancellation = app.state::<StreamCancellation>();
    cancellation.reset();

    let mut request = build_api_request(
        &config.model, &messages, config.temperature, config.max_tokens, &tools, true,
    );

    // 团队模式：注入 team_id 到请求体（服务端团队代理需要此字段）
    if let Some(ref tid) = config.team_id {
        request["team_id"] = serde_json::json!(tid);
    }

    let response = client
        .post(format!("{}/chat/completions", config.base_url))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        let _ = app.emit(
            "ai-stream-error",
            serde_json::json!({
                "conversation_id": conversation_id,
                "error": format!("API 错误: {}", body),
            }),
        );
        return Err(format!("API 错误: {}", body));
    }

    // 流式读取 SSE — 收集 content 和 tool_calls
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_tool_calls: Vec<ToolCall> = Vec::new();
    let mut tc_args_buffer: HashMap<usize, String> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        if cancellation.is_cancelled() {
            let _ = app.emit(
                "ai-stream-done",
                serde_json::json!({ "conversation_id": conversation_id }),
            );
            return Ok(());
        }

        match chunk {
            Ok(bytes) => {
                buffer.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();

                    if !line.starts_with("data: ") {
                        continue;
                    }
                    let data = &line[6..];
                    if data == "[DONE]" {
                        // 如果有 pending tool_calls，组装完整参数后通知前端
                        if !pending_tool_calls.is_empty() {
                            for (idx, args) in &tc_args_buffer {
                                if let Some(tc) = pending_tool_calls.get_mut(*idx) {
                                    tc.function.arguments = args.clone();
                                }
                            }
                            // 通知前端：有工具需要调用（Agent 自行执行）
                            let _ = app.emit(
                                "ai-agent-tool-calls",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "tool_calls": &pending_tool_calls,
                                }),
                            );
                        }

                        let _ = app.emit(
                            "ai-stream-done",
                            serde_json::json!({ "conversation_id": conversation_id }),
                        );
                        return Ok(());
                    }

                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                        let delta = &parsed["choices"][0]["delta"];

                        // 普通内容 chunk
                        if let Some(content) = delta["content"].as_str() {
                            let _ = app.emit(
                                "ai-stream-chunk",
                                serde_json::json!({
                                    "conversation_id": conversation_id,
                                    "content": content,
                                }),
                            );
                        }

                        // tool_calls delta — 收集但不执行
                        if let Some(tcs) = delta["tool_calls"].as_array() {
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
                                    if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                                        tc_args_buffer
                                            .entry(idx)
                                            .or_default()
                                            .push_str(args);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "ai-stream-error",
                    serde_json::json!({
                        "conversation_id": conversation_id,
                        "error": format!("流读取错误: {}", e),
                    }),
                );
                return Err(format!("流读取错误: {}", e));
            }
        }
    }

    let _ = app.emit(
        "ai-stream-done",
        serde_json::json!({ "conversation_id": conversation_id }),
    );
    Ok(())
}

/// 获取 AI 配置
#[tauri::command]
pub async fn ai_get_config(app: AppHandle) -> Result<AIConfig, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;

    if let Some(val) = store.get("ai_config") {
        serde_json::from_value(val).map_err(|e| e.to_string())
    } else {
        Ok(AIConfig::default())
    }
}

/// 保存 AI 配置
#[tauri::command]
pub async fn ai_set_config(app: AppHandle, config: AIConfig) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    store.set(
        "ai_config",
        serde_json::to_value(&config).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取自有 Key 列表
#[tauri::command]
pub async fn ai_get_own_keys(app: AppHandle) -> Result<Vec<OwnKeyModelConfig>, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;

    if let Some(val) = store.get("ai_own_keys") {
        serde_json::from_value(val).map_err(|e| e.to_string())
    } else {
        Ok(Vec::new())
    }
}

/// 保存自有 Key 列表
#[tauri::command]
pub async fn ai_set_own_keys(app: AppHandle, keys: Vec<OwnKeyModelConfig>) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    store.set(
        "ai_own_keys",
        serde_json::to_value(&keys).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
