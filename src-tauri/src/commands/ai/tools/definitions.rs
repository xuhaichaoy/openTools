/// 基础工具定义（数据工坊、剪贴板、知识库检索）
pub fn get_base_tools() -> Vec<serde_json::Value> {
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
                "name": "web_search",
                "description": "联网搜索信息。在用户需要最新资讯、查询不确定的事实、搜索技术文档、了解实时信息时调用。返回搜索结果列表（标题、链接、摘要）。如需查看某条结果的完整内容，再用 web_fetch 获取对应链接。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词，简洁精确"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "最大返回结果数，默认5",
                            "default": 5
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "获取指定 URL 的网页内容（纯文本）。适用于查阅在线文档、阅读搜索结果中某条链接的详细内容。通常在 web_search 之后使用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "要获取的完整 URL 地址（必须以 http:// 或 https:// 开头）"
                        }
                    },
                    "required": ["url"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_knowledge_docs",
                "description": "列出知识库中所有已索引文档的元数据。仅在需要了解知识库有哪些文档时调用，普通问答直接用 search_docs。",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_docs",
                "description": "在知识库中搜索相关文档片段，返回内容足够直接回答问题。搜索一次即可，结果为空则停止搜索直接回答。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词，简短精确，如「创建团队」「配置AI」"
                        },
                        "top_k": {
                            "type": "integer",
                            "description": "返回结果数量，默认3，通常不需要更多",
                            "default": 3
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_doc_chunks",
                "description": "读取 search_docs 找到的相关片段的完整内容及上下文。仅在 search_docs 返回了明确相关的结果后才调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "文档ID（从 search_docs 结果中获取）"
                        },
                        "chunk_indices": {
                            "type": "array",
                            "items": { "type": "integer" },
                            "description": "要读取的 chunk 索引列表（从 search_docs 结果中获取）"
                        },
                        "context_window": {
                            "type": "integer",
                            "description": "上下文窗口大小，即目标 chunk 前后各包含几个相邻 chunk，默认1",
                            "default": 1
                        }
                    },
                    "required": ["doc_id", "chunk_indices"]
                }
            }
        }
    ])
    .as_array()
    .expect("static JSON must be array")
    .clone()
}

/// 高级工具定义（Shell、文件操作、系统信息、URL/路径打开、进程列表）
pub fn get_advanced_tools() -> Vec<serde_json::Value> {
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
                "name": "read_file_range",
                "description": "按行范围读取文本文件，返回带行号内容，适合代码审阅。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件绝对路径"
                        },
                        "start_line": {
                            "type": "integer",
                            "description": "起始行号（从 1 开始），默认 1"
                        },
                        "end_line": {
                            "type": "integer",
                            "description": "结束行号（包含），默认按 max_lines 推断"
                        },
                        "max_lines": {
                            "type": "integer",
                            "description": "最多返回行数，默认 400，上限 2000"
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
                "name": "search_in_files",
                "description": "递归搜索目录中的文本内容，返回匹配文件、行号和片段，适合代码定位。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "目录绝对路径"
                        },
                        "query": {
                            "type": "string",
                            "description": "要搜索的关键词"
                        },
                        "case_sensitive": {
                            "type": "boolean",
                            "description": "是否区分大小写，默认 false"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "最大返回结果数，默认 200，上限 1000"
                        },
                        "file_pattern": {
                            "type": "string",
                            "description": "文件过滤模式，例如 *.ts、*.rs、src/*"
                        }
                    },
                    "required": ["path", "query"]
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
    .expect("static JSON must be array")
    .clone()
}

/// Windows 原生能力工具定义（设置、打开应用等），供 AI 助手在 Windows 上调用
#[cfg(target_os = "windows")]
pub fn get_native_app_tools_windows() -> Vec<serde_json::Value> {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "win_open_settings",
                "description": "打开 Windows 系统设置页面。用户要求打开设置、修改显示/网络/蓝牙/通知等时使用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "page": {
                            "type": "string",
                            "description": "设置页面标识。常用: display(显示), network(网络), bluetooth(蓝牙), notifications(通知), sound(声音), storage(存储), apps(应用), defaultapps(默认应用), privacy(隐私), update(更新)。不填则打开设置首页。"
                        }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "native_app_open",
                "description": "打开或激活一个已安装的应用程序。如：记事本、计算器、资源管理器、cmd、PowerShell 等。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "app_name": {
                            "type": "string",
                            "description": "应用名称或可执行文件名，如 notepad、calc、explorer、cmd、powershell、msedge、chrome 等"
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
                "description": "列出 Windows 上可供 AI 调用的原生能力（打开设置、打开应用等）。用户问「能做什么」「有哪些功能」时调用。",
                "parameters": { "type": "object", "properties": {} }
            }
        }
    ])
    .as_array()
    .expect("static JSON must be array")
    .clone()
}

/// macOS 原生应用工具定义（日历、提醒、备忘录、邮件、快捷指令、应用操作）
pub fn get_native_app_tools() -> Vec<serde_json::Value> {
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
    .expect("static JSON must be array")
    .clone()
}
