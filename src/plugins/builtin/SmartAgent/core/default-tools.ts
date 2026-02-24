import { agentRuntimeManager, type RuntimeFallbackContext } from "@/core/agent/runtime";
import type { AgentTool } from "./react-agent";

async function invokeTauri<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function createLocalDevTools(
  confirmHostFallback: (context: RuntimeFallbackContext) => Promise<boolean>,
): AgentTool[] {
  return [
    {
      name: "list_directory",
      description: "列出目录下的文件和子目录（用于定位项目结构）",
      parameters: {
        path: { type: "string", description: "目录路径（建议绝对路径）" },
      },
      execute: async (params) => {
        const path = String(params.path || ".");
        return invokeTauri("list_directory", { path });
      },
    },
    {
      name: "read_file",
      description: "读取本地文本文件（代码、配置、日志等）",
      parameters: {
        path: { type: "string", description: "文件路径（建议绝对路径）" },
      },
      execute: async (params) => {
        const path = String(params.path || "");
        if (!path.trim()) return { error: "path 不能为空" };
        return invokeTauri("read_text_file", { path });
      },
    },
    {
      name: "read_file_range",
      description: "按行读取代码文件，返回行号，适合定位函数和分析上下文",
      parameters: {
        path: { type: "string", description: "文件路径（建议绝对路径）" },
        start_line: {
          type: "integer",
          description: "起始行（可选，默认 1）",
          required: false,
        },
        end_line: {
          type: "integer",
          description: "结束行（可选）",
          required: false,
        },
        max_lines: {
          type: "integer",
          description: "最多返回行数（可选）",
          required: false,
        },
      },
      execute: async (params) => {
        const path = String(params.path || "");
        if (!path.trim()) return { error: "path 不能为空" };
        const start_line =
          typeof params.start_line === "number" ? Math.floor(params.start_line) : undefined;
        const end_line =
          typeof params.end_line === "number" ? Math.floor(params.end_line) : undefined;
        const max_lines =
          typeof params.max_lines === "number" ? Math.floor(params.max_lines) : undefined;
        return invokeTauri("read_text_file_range", {
          path,
          start_line,
          end_line,
          max_lines,
        });
      },
    },
    {
      name: "search_in_files",
      description: "递归搜索项目中的文本，返回匹配文件和行号",
      parameters: {
        path: { type: "string", description: "目录路径（建议绝对路径）" },
        query: { type: "string", description: "要搜索的关键词" },
        case_sensitive: {
          type: "boolean",
          description: "是否区分大小写（可选）",
          required: false,
        },
        max_results: {
          type: "integer",
          description: "最大结果数量（可选）",
          required: false,
        },
        file_pattern: {
          type: "string",
          description: "文件过滤模式，如 *.ts、*.rs（可选）",
          required: false,
        },
      },
      execute: async (params) => {
        const path = String(params.path || "");
        const query = String(params.query || "");
        if (!path.trim()) return { error: "path 不能为空" };
        if (!query.trim()) return { error: "query 不能为空" };
        const case_sensitive =
          typeof params.case_sensitive === "boolean" ? params.case_sensitive : undefined;
        const max_results =
          typeof params.max_results === "number" ? Math.floor(params.max_results) : undefined;
        const file_pattern =
          typeof params.file_pattern === "string" ? params.file_pattern : undefined;
        return invokeTauri("search_in_files", {
          path,
          query,
          case_sensitive,
          max_results,
          file_pattern,
        });
      },
    },
    {
      name: "write_file",
      description: "写入本地文本文件（会覆盖目标文件）",
      parameters: {
        path: { type: "string", description: "文件路径（建议绝对路径）" },
        content: { type: "string", description: "要写入的文本内容" },
      },
      dangerous: true,
      execute: async (params) => {
        const path = String(params.path || "");
        if (!path.trim()) return { error: "path 不能为空" };
        const content = String(params.content || "");
        return agentRuntimeManager.writeTextFile(path, content, {
          confirmHostFallback,
        });
      },
    },
    {
      name: "run_shell_command",
      description: "执行终端命令（用于构建、测试、格式化、搜索等）",
      parameters: {
        command: { type: "string", description: "命令行指令" },
      },
      dangerous: true,
      execute: async (params) => {
        const command = String(params.command || "").trim();
        if (!command) return { error: "command 不能为空" };
        return agentRuntimeManager.runShellCommand(command, {
          confirmHostFallback,
        });
      },
    },
  ];
}

function createReminderTool(): AgentTool {
  return {
    name: "add_reminder",
    description: "添加定时提醒任务（如：10分钟后提醒我喝水，或者下午3点开会）",
    parameters: {
      message: { type: "string", description: "提醒内容" },
      time: {
        type: "string",
        description: "提醒时间（ISO 8601 格式字符串，例如 2024-01-01T12:00:00）",
      },
    },
    execute: async (params) => {
      try {
        const message = String(params.message);
        const time = String(params.time);
        if (!message || !time) return { error: "缺少参数" };

        const id = `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const workflow = {
          id,
          name: `提醒: ${message}`,
          icon: "Bell",
          description: "由 Agent 创建的定时提醒",
          category: "reminders",
          trigger: {
            type: "once",
            onceAt: time,
            enabled: true,
          },
          steps: [
            {
              id: `step_${Date.now()}`,
              name: "发送通知",
              type: "notification",
              config: { message },
            },
          ],
          builtin: false,
          created_at: Date.now(),
        };

        await invokeTauri("workflow_create", { workflow });
        await invokeTauri("workflow_scheduler_reload", { workflowId: id });
        return {
          success: true,
          message: `已设置提醒: "${message}" 于 ${new Date(time).toLocaleString()}`,
        };
      } catch (e) {
        return { error: `设置提醒失败: ${e}` };
      }
    },
  };
}

function createNativeAppTools(): AgentTool[] {
  return [
    {
      name: "native_calendar_list",
      description: "列出本机所有日历账户",
      execute: async () => invokeTauri("native_calendar_list"),
    },
    {
      name: "native_calendar_list_events",
      description: "查看日历事件列表（今日或指定日期范围）",
      parameters: {
        from_date: { type: "string", description: "开始日期 (YYYY-MM-DD)，默认今天" },
        to_date: { type: "string", description: "结束日期 (YYYY-MM-DD)，默认同 from_date" },
      },
      execute: async (params) =>
        invokeTauri("native_calendar_list_events", {
          fromDate: params.from_date || null,
          toDate: params.to_date || null,
        }),
    },
    {
      name: "native_calendar_create_event",
      description: "在日历中创建新事件/日程",
      parameters: {
        title: { type: "string", description: "事件标题" },
        start_date: {
          type: "string",
          description: "开始时间 (ISO 8601，如 2026-02-16T14:00:00)",
        },
        end_date: { type: "string", description: "结束时间 (ISO 8601)" },
        notes: { type: "string", description: "备注（可选）" },
        location: { type: "string", description: "地点（可选）" },
      },
      execute: async (params) =>
        invokeTauri("native_calendar_create_event", {
          title: String(params.title),
          startDate: String(params.start_date),
          endDate: String(params.end_date),
          notes: params.notes ? String(params.notes) : null,
          location: params.location ? String(params.location) : null,
          calendarName: null,
        }),
    },
    {
      name: "native_reminder_lists",
      description: "列出本机所有提醒事项列表",
      execute: async () => invokeTauri("native_reminder_lists"),
    },
    {
      name: "native_reminder_list_incomplete",
      description: "查看未完成的提醒事项",
      parameters: {
        list_name: {
          type: "string",
          description: "提醒事项列表名称（可选，不填则查所有列表）",
        },
      },
      execute: async (params) =>
        invokeTauri("native_reminder_list_incomplete", {
          listName: params.list_name ? String(params.list_name) : null,
        }),
    },
    {
      name: "native_reminder_create",
      description: "创建一条新的提醒事项",
      parameters: {
        title: { type: "string", description: "提醒标题" },
        notes: { type: "string", description: "备注（可选）" },
        due_date: { type: "string", description: "截止时间 (ISO 8601，可选)" },
        list_name: { type: "string", description: "目标列表名称（可选，默认使用系统默认列表）" },
      },
      execute: async (params) =>
        invokeTauri("native_reminder_create", {
          title: String(params.title),
          notes: params.notes ? String(params.notes) : null,
          dueDate: params.due_date ? String(params.due_date) : null,
          listName: params.list_name ? String(params.list_name) : null,
        }),
    },
    {
      name: "native_notes_search",
      description: "搜索 macOS 备忘录中的笔记",
      parameters: {
        keyword: { type: "string", description: "搜索关键词" },
      },
      execute: async (params) =>
        invokeTauri("native_notes_search", {
          keyword: String(params.keyword),
        }),
    },
    {
      name: "native_notes_create",
      description: "在 macOS 备忘录中创建新笔记",
      parameters: {
        title: { type: "string", description: "笔记标题" },
        body: { type: "string", description: "笔记正文内容" },
        folder_name: {
          type: "string",
          description: "文件夹名称（可选，默认使用「备忘录」）",
        },
      },
      execute: async (params) =>
        invokeTauri("native_notes_create", {
          title: String(params.title),
          body: String(params.body),
          folderName: params.folder_name ? String(params.folder_name) : null,
        }),
    },
    {
      name: "native_mail_create",
      description: "创建邮件草稿（打开系统邮件应用）",
      parameters: {
        to: { type: "string", description: "收件人邮箱" },
        subject: { type: "string", description: "邮件主题" },
        body: { type: "string", description: "邮件正文" },
      },
      execute: async (params) =>
        invokeTauri("native_mail_create", {
          to: String(params.to),
          subject: String(params.subject),
          body: String(params.body),
        }),
    },
    {
      name: "native_shortcuts_list",
      description: "列出 macOS 快捷指令列表",
      execute: async () => invokeTauri("native_shortcuts_list"),
    },
    {
      name: "native_shortcuts_run",
      description: "运行指定的 macOS 快捷指令",
      parameters: {
        name: { type: "string", description: "快捷指令名称" },
        input: { type: "string", description: "传入的输入文本（可选）" },
      },
      execute: async (params) =>
        invokeTauri("native_shortcuts_run", {
          name: String(params.name),
          input: params.input ? String(params.input) : null,
        }),
    },
    {
      name: "native_app_open",
      description: "打开或切换到本机应用（如微信、Safari、访达等）",
      parameters: {
        app_name: { type: "string", description: "应用名称（如 Safari、微信、备忘录）" },
      },
      execute: async (params) =>
        invokeTauri("native_app_open", {
          appName: String(params.app_name),
        }),
    },
    {
      name: "native_app_list",
      description: "列出本机已安装的可交互应用列表",
      execute: async () => invokeTauri("native_app_list_interactive"),
    },
  ];
}

export function createBuiltinAgentTools(
  confirmHostFallback: (context: RuntimeFallbackContext) => Promise<boolean>,
): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "get_current_time",
      description: "获取当前时间",
      execute: async () => ({
        time: new Date().toLocaleString("zh-CN"),
        timestamp: Date.now(),
      }),
    },
    {
      name: "calculate",
      description: "执行数学计算",
      parameters: {
        expression: { type: "string", description: "数学表达式（如 2+3*4）" },
      },
      execute: async (params) => {
        try {
          const expr = String(params.expression).replace(/[^0-9+\-*/().%\s]/g, "");
          if (!expr.trim()) return { error: "无效表达式" };
          const result = Function('"use strict"; return (' + expr + ")")();
          if (typeof result !== "number" || !isFinite(result)) {
            return { error: `计算结果无效: ${result}` };
          }
          return { expression: params.expression, result };
        } catch (e) {
          return { error: `计算失败: ${e}` };
        }
      },
    },
  ];

  tools.push(...createLocalDevTools(confirmHostFallback));
  tools.push(createReminderTool());
  tools.push(...createNativeAppTools());
  return tools;
}
