pub mod definitions;
pub mod executor;

use definitions::{get_base_tools, get_advanced_tools, get_native_app_tools};

/// 判断工具是否为"危险"操作，需要用户确认才能执行
pub fn is_dangerous_tool(name: &str) -> bool {
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

/// 根据开关组合返回可用工具集合
pub fn get_tools(enable_advanced: bool, enable_native: bool) -> Vec<serde_json::Value> {
    let mut tools = get_base_tools();
    if enable_advanced {
        tools.extend(get_advanced_tools());
    }
    #[cfg(target_os = "macos")]
    if enable_native {
        tools.extend(get_native_app_tools());
    }
    tools
}

/// 构建 AI system prompt
pub fn get_system_prompt(enable_advanced: bool, enable_native: bool, custom_prompt: &str) -> String {
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

    if !custom_prompt.is_empty() {
        prompt.push_str("\n\n用户补充指令：\n");
        prompt.push_str(custom_prompt);
    }

    prompt
}
