import { agentRuntimeManager, type RuntimeFallbackContext } from "@/core/agent/runtime";
import type { AgentTool } from "./react-agent";

/**
 * 安全的数学表达式解析器（递归下降），不使用 eval/Function。
 * 支持: +, -, *, /, %, 括号, 负数
 */
function safeEvaluateMath(expr: string): number {
  let pos = 0;
  const input = expr.replace(/\s+/g, "");

  function peek(): string { return input[pos] || ""; }
  function consume(ch?: string): string {
    if (ch !== undefined && input[pos] !== ch) throw new Error(`期望 '${ch}'，得到 '${peek()}'`);
    return input[pos++];
  }

  function parseNumber(): number {
    const start = pos;
    if (peek() === "-") pos++;
    if (!/\d/.test(peek()) && peek() !== ".") throw new Error(`无效字符: '${peek()}'`);
    while (/[\d.]/.test(peek())) pos++;
    const num = Number(input.slice(start, pos));
    if (isNaN(num)) throw new Error(`无效数字: ${input.slice(start, pos)}`);
    return num;
  }

  function parsePrimary(): number {
    if (peek() === "(") {
      consume("(");
      const val = parseAddSub();
      consume(")");
      return val;
    }
    return parseNumber();
  }

  function parseMulDiv(): number {
    let left = parsePrimary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = consume();
      const right = parsePrimary();
      if (op === "*") left *= right;
      else if (op === "/") { if (right === 0) throw new Error("除零错误"); left /= right; }
      else left %= right;
    }
    return left;
  }

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (peek() === "+" || peek() === "-") {
      const op = consume();
      const right = parseMulDiv();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  const result = parseAddSub();
  if (pos < input.length) throw new Error(`未预期的字符: '${peek()}'`);
  return result;
}

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
      readonly: true,
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
      readonly: true,
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
      readonly: true,
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
      readonly: true,
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
          allowInteractiveHostWriteWhenNoPolicyRoots: true,
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
    {
      name: "ckg_search_function",
      description:
        "在项目代码知识图谱中搜索函数定义。首次调用会自动索引项目（基于 tree-sitter AST 解析）。支持精确匹配和模糊搜索。适用于：查找函数实现、理解代码结构、定位关键逻辑。",
      readonly: true,
      parameters: {
        project_path: { type: "string", description: "项目根目录（绝对路径）" },
        name: { type: "string", description: "函数名称（精确名或模糊关键词）" },
        fuzzy: { type: "boolean", description: "是否模糊搜索（默认 false）", required: false },
      },
      execute: async (params) => {
        const projectPath = String(params.project_path || "").trim();
        const name = String(params.name || "").trim();
        if (!projectPath) return { error: "project_path 不能为空" };
        if (!name) return { error: "name 不能为空" };
        return invokeTauri("ckg_search_function", {
          path: projectPath,
          name,
          fuzzy: params.fuzzy === true,
        });
      },
    },
    {
      name: "ckg_search_class",
      description:
        "在项目代码知识图谱中搜索类/结构体/接口定义。返回类名、文件路径、字段、方法签名等信息。",
      readonly: true,
      parameters: {
        project_path: { type: "string", description: "项目根目录（绝对路径）" },
        name: { type: "string", description: "类名（精确名或模糊关键词）" },
        fuzzy: { type: "boolean", description: "是否模糊搜索（默认 false）", required: false },
      },
      execute: async (params) => {
        const projectPath = String(params.project_path || "").trim();
        const name = String(params.name || "").trim();
        if (!projectPath) return { error: "project_path 不能为空" };
        if (!name) return { error: "name 不能为空" };
        return invokeTauri("ckg_search_class", {
          path: projectPath,
          name,
          fuzzy: params.fuzzy === true,
        });
      },
    },
    {
      name: "ckg_search_class_method",
      description:
        "在项目代码知识图谱中搜索类方法（属于某个类的函数）。可用于查找特定方法的实现和所属类。",
      readonly: true,
      parameters: {
        project_path: { type: "string", description: "项目根目录（绝对路径）" },
        name: { type: "string", description: "方法名（精确名或模糊关键词）" },
        fuzzy: { type: "boolean", description: "是否模糊搜索（默认 false）", required: false },
      },
      execute: async (params) => {
        const projectPath = String(params.project_path || "").trim();
        const name = String(params.name || "").trim();
        if (!projectPath) return { error: "project_path 不能为空" };
        if (!name) return { error: "name 不能为空" };
        return invokeTauri("ckg_search_class_method", {
          path: projectPath,
          name,
          fuzzy: params.fuzzy === true,
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
      readonly: true,
      execute: async () => invokeTauri("native_calendar_list"),
    },
    {
      name: "native_calendar_list_events",
      description: "查看日历事件列表（今日或指定日期范围）",
      readonly: true,
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
      readonly: true,
      execute: async () => invokeTauri("native_reminder_lists"),
    },
    {
      name: "native_reminder_list_incomplete",
      description: "查看未完成的提醒事项",
      readonly: true,
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
      readonly: true,
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
      readonly: true,
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
      readonly: true,
      execute: async () => invokeTauri("native_app_list_interactive"),
    },
  ];
}

/** Windows 原生能力：打开系统设置、打开应用等（仅 Windows 显示） */
function createWindowsNativeTools(): AgentTool[] {
  return [
    {
      name: "win_open_settings",
      description:
        "打开 Windows 系统设置页面。用户要求打开设置、修改显示/网络/蓝牙/通知等时使用。",
      parameters: {
        page: {
          type: "string",
          description:
            "设置页面标识。常用: display(显示), network(网络), bluetooth(蓝牙), notifications(通知), sound(声音), storage(存储), apps(应用), defaultapps(默认应用), privacy(隐私), update(更新)。不填则打开设置首页。",
          required: false,
        },
      },
      execute: async (params) =>
        invokeTauri("win_open_settings", {
          page: params.page ? String(params.page) : null,
        }),
    },
    {
      name: "native_app_open",
      description:
        "打开或激活一个已安装的应用程序。如：记事本(notepad)、计算器(calc)、资源管理器(explorer)、cmd、PowerShell(powershell)、Edge(msedge)、Chrome(chrome) 等。",
      parameters: {
        app_name: {
          type: "string",
          description:
            "应用名称或可执行文件名，如 notepad、calc、explorer、cmd、powershell、msedge、chrome 等",
        },
      },
      execute: async (params) =>
        invokeTauri("native_app_open", {
          appName: String(params.app_name ?? ""),
        }),
    },
    {
      name: "native_app_list_interactive",
      description:
        "列出 Windows 上可供 AI 调用的原生能力（打开设置、打开应用等）。用户问「能做什么」「有哪些功能」时调用。",
      readonly: true,
      execute: async () => invokeTauri("native_app_list_interactive"),
    },
  ];
}

export interface AskUserQuestion {
  id: string;
  question: string;
  type: "single" | "multi" | "text";
  options?: string[];
}

export type AskUserAnswers = Record<string, string | string[]>;

export interface BuiltinToolsResult {
  tools: AgentTool[];
  resetPerRunState: () => void;
}

export function createBuiltinAgentTools(
  confirmHostFallback: (context: RuntimeFallbackContext) => Promise<boolean>,
  askUser?: (questions: AskUserQuestion[]) => Promise<AskUserAnswers>,
): BuiltinToolsResult {
  let askUserCalled = false;
  const tools: AgentTool[] = [
    {
      name: "get_current_time",
      description: "获取当前时间",
      readonly: true,
      execute: async () => ({
        time: new Date().toLocaleString("zh-CN"),
        timestamp: Date.now(),
      }),
    },
    {
      name: "calculate",
      description: "执行数学计算",
      readonly: true,
      parameters: {
        expression: { type: "string", description: "数学表达式（如 2+3*4）" },
      },
      execute: async (params) => {
        try {
          const expr = String(params.expression).trim();
          if (!expr) return { error: "无效表达式" };
          const result = safeEvaluateMath(expr);
          if (typeof result !== "number" || !isFinite(result)) {
            return { error: `计算结果无效: ${result}` };
          }
          return { expression: params.expression, result };
        } catch (e) {
          return { error: `计算失败: ${e}` };
        }
      },
    },
    {
      name: "get_system_info",
      description:
        "获取系统与常用目录信息（home/desktop/downloads），用于构造绝对路径并避免 ~ 路径错误",
      readonly: true,
      execute: async () => {
        const { homeDir, desktopDir, downloadDir } = await import("@tauri-apps/api/path");
        const safeResolve = async (resolver: () => Promise<string>) => {
          try {
            return await resolver();
          } catch {
            return "";
          }
        };
        const [home, desktop, downloads] = await Promise.all([
          safeResolve(homeDir),
          safeResolve(desktopDir),
          safeResolve(downloadDir),
        ]);
        return {
          platform: typeof navigator !== "undefined" ? navigator.platform || "unknown" : "unknown",
          home_dir: home,
          desktop_dir: desktop,
          downloads_dir: downloads,
          path_hint:
            "请使用绝对路径，不要使用 ~ 开头路径。写文件请调用 write_file 工具。",
        };
      },
    },
  ];

  if (askUser) {
    tools.push({
      name: "ask_user",
      description:
        "向用户提问并等待回答（弹出交互对话框，显示选项供用户选择）。需要用户输入时必须调用此工具，绝不要在回复文本中直接提问。调用时必须提供 options 参数给出可选项，用户也可以忽略选项自行输入。此工具每轮只能调用一次，需要多个问题时用 extra_questions 参数。示例: ask_user(question='保存为什么格式？', options='Markdown,TXT,PDF')",
      parameters: {
        question: {
          type: "string",
          description: "问题内容，要清晰具体",
        },
        type: {
          type: "string",
          description: "问题类型: single(单选,默认), multi(多选), text(仅自由输入)。",
          required: false,
        },
        options: {
          type: "string",
          description: "选项列表，逗号分隔，必须提供。如: '在线搜索,本地文件,知识库'。用户始终可以额外自定义输入",
        },
        extra_questions: {
          type: "string",
          description: "如需同时问多个问题，传 JSON 数组: [{\"question\":\"...\",\"type\":\"single\",\"options\":[\"A\",\"B\"]}]。可选参数，单个问题时不需要",
          required: false,
        },
      },
      execute: async (params) => {
        if (askUserCalled) {
          return {
            error: "ask_user 每轮只能调用一次。请根据用户上次回答继续执行任务，不要再次提问。",
          };
        }
        const mainQ = String(params.question || "").trim();
        if (!mainQ) return { error: "question 不能为空" };

        const questions: AskUserQuestion[] = [];

        const mainType = (["single", "multi", "text"].includes(String(params.type || ""))
          ? String(params.type)
          : params.options ? "single" : "text") as AskUserQuestion["type"];
        const mainOptions = params.options
          ? String(params.options).split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        questions.push({
          id: "q1",
          question: mainQ,
          type: mainType,
          options: mainOptions,
        });

        let extraQuestionsParseError = false;
        if (params.extra_questions) {
          try {
            const extra = JSON.parse(String(params.extra_questions));
            if (Array.isArray(extra)) {
              extra.forEach((eq: Record<string, unknown>, i: number) => {
                const q = String(eq.question || "").trim();
                if (!q) return;
                const t = (["single", "multi", "text"].includes(String(eq.type || ""))
                  ? String(eq.type)
                  : eq.options ? "single" : "text") as AskUserQuestion["type"];
                const opts = Array.isArray(eq.options)
                  ? (eq.options as string[]).map(String)
                  : typeof eq.options === "string"
                    ? String(eq.options).split(",").map((s) => s.trim()).filter(Boolean)
                    : undefined;
                questions.push({ id: `q${i + 2}`, question: q, type: t, options: opts });
              });
            }
          } catch {
            extraQuestionsParseError = true;
          }
        }

        askUserCalled = true;
        try {
          const answers = await askUser(questions);
          return extraQuestionsParseError
            ? { answers, warning: "extra_questions JSON 格式无法解析，仅展示了主问题" }
            : { answers };
        } catch (e) {
          askUserCalled = false;
          return { error: `ask_user 执行失败: ${e}` };
        }
      },
    });
  }

  const sequentialThinkingState = {
    history: [] as Array<{ thought: string; number: number; total: number; isRevision?: boolean; revisesThought?: number; branchId?: string }>,
    branches: {} as Record<string, unknown[]>,
  };

  tools.push(
    {
      name: "sequential_thinking",
      description:
        `动态、可反思的逐步推理工具。将复杂问题分解为多步思考，支持修订已有结论和分支探索。
使用场景: 分解复杂问题、规划多步执行方案、分析需要修正方向的问题、过滤无关信息。
关键特性: 可随时调整 total_thoughts 估值；可标记修订或分支；到达末尾仍可追加步骤。
使用建议: 初始设置 total_thoughts 为 3-8，需要时动态增加；每步聚焦一个子问题；发现错误时标记 is_revision。`,
      readonly: true,
      parameters: {
        thought: { type: "string", description: "当前思考步骤内容" },
        next_thought_needed: { type: "boolean", description: "是否需要下一步思考" },
        thought_number: { type: "integer", description: "当前思考编号（从 1 开始）" },
        total_thoughts: { type: "integer", description: "预估总步数（可动态调整）" },
        is_revision: { type: "boolean", description: "是否在修订先前思考", required: false },
        revises_thought: { type: "integer", description: "修订哪一步的编号", required: false },
        branch_from_thought: { type: "integer", description: "从哪一步分支", required: false },
        branch_id: { type: "string", description: "分支标识符", required: false },
        needs_more_thoughts: { type: "boolean", description: "是否需要追加更多步骤", required: false },
      },
      execute: async (params) => {
        const thought = String(params.thought || "").trim();
        if (!thought) return { error: "thought 不能为空" };
        const thoughtNumber = typeof params.thought_number === "number" ? params.thought_number : 1;
        const totalThoughts = typeof params.total_thoughts === "number" ? params.total_thoughts : 5;
        const nextNeeded = params.next_thought_needed !== false;

        const entry = {
          thought,
          number: thoughtNumber,
          total: Math.max(totalThoughts, thoughtNumber),
          isRevision: params.is_revision === true,
          revisesThought: typeof params.revises_thought === "number" ? params.revises_thought : undefined,
          branchId: typeof params.branch_id === "string" ? params.branch_id : undefined,
        };
        sequentialThinkingState.history.push(entry);

        if (entry.branchId) {
          if (!sequentialThinkingState.branches[entry.branchId]) {
            sequentialThinkingState.branches[entry.branchId] = [];
          }
          sequentialThinkingState.branches[entry.branchId].push(entry);
        }

        return {
          thought_number: entry.number,
          total_thoughts: entry.total,
          next_thought_needed: nextNeeded,
          branches: Object.keys(sequentialThinkingState.branches),
          thought_history_length: sequentialThinkingState.history.length,
        };
      },
    },
    {
      name: "task_done",
      description: "显式标记当前任务已完成。必须在验证结果正确后才能调用。调用后 Agent 将停止执行并返回最终结论。",
      readonly: true,
      parameters: {
        summary: {
          type: "string",
          description: "任务完成摘要（可选）",
          required: false,
        },
      },
      execute: async (params) => {
        const summary = String(params.summary || "任务已完成。").trim();
        return { status: "done", summary };
      },
    },
    {
      name: "web_search",
      description:
        "联网搜索信息。在需要最新资讯、查询不确定的事实、搜索技术文档、了解实时信息时调用。返回搜索结果列表（标题、链接、摘要）。如需查看某条结果的完整内容，再用 web_fetch 获取对应链接。",
      readonly: true,
      parameters: {
        query: {
          type: "string",
          description: "搜索关键词，简洁精确",
        },
        max_results: {
          type: "number",
          description: "最大返回结果数（默认5，最多10）",
          required: false,
        },
      },
      execute: async (params) => {
        const query = String(params.query || "").trim();
        if (!query) return { error: "搜索关键词不能为空" };
        const maxResults = Math.min(Math.max(Number(params.max_results) || 5, 1), 10);
        try {
          const result = await invokeTauri<string>("web_search", {
            query,
            maxResults,
          });
          return { query, results: result };
        } catch (e) {
          return { error: `搜索失败: ${e}` };
        }
      },
    },
    {
      name: "web_fetch",
      description:
        "获取指定 URL 的网页内容（文本）。适用于查阅在线文档、阅读搜索结果中某条链接的详细内容。通常在 web_search 之后使用。",
      readonly: true,
      parameters: {
        url: {
          type: "string",
          description: "要访问的完整 URL（如 https://example.com）",
        },
      },
      execute: async (params) => {
        const url = String(params.url || "").trim();
        if (!url) return { error: "URL 不能为空" };
        try {
          new URL(url);
        } catch {
          return { error: `无效的 URL: ${url}` };
        }
        try {
          const body = await invokeTauri<string>("web_fetch_url", { url });
          const trimmed = (body || "").trim();
          if (!trimmed) return { url, content_type: "text", content: "(空内容)" };
          // JSON detection
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
              JSON.parse(trimmed);
              return { url, content_type: "json", content: trimmed.slice(0, 8000) };
            } catch {
              // not valid JSON, treat as HTML/text
            }
          }
          const text = trimmed
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          return { url, content_type: "text", content: text.slice(0, 8000) };
        } catch (e) {
          return { error: `网页获取失败: ${e}` };
        }
      },
    },
  );

  tools.push({
    name: "knowledge_base_query",
    description:
      "仅用于搜索用户主动导入到「本地知识库」中的私有文档。不要用于通用搜索或查找在线信息。只在用户明确提到「知识库」「我的文档」或你确定需要查阅用户私有文档时才调用。",
    readonly: true,
    parameters: {
      query: {
        type: "string",
        description: "在用户私有知识库中搜索的关键词",
      },
    },
    execute: async (params) => {
      const query = String(params.query || "").trim();
      if (!query) return { error: "搜索查询不能为空" };
      try {
        const docs = await invokeTauri<Array<{ id: string }>>("rag_list_docs");
        if (!docs || docs.length === 0) {
          return { note: "用户知识库为空（未导入任何文档），请使用其他方式获取信息" };
        }
      } catch {
        return { note: "知识库不可用，请使用其他方式获取信息" };
      }
      try {
        type KBResult = {
          chunk: { content: string; metadata?: { source?: string; heading?: string } };
          score: number;
        };
        let results = await invokeTauri<KBResult[]>("rag_search", {
          query, topK: 5, threshold: 0.3,
        });
        if (!results || results.length === 0) {
          try {
            results = await invokeTauri<KBResult[]>("rag_keyword_search", {
              query, topK: 5,
            });
          } catch {
            // fall through
          }
        }
        if (!results || results.length === 0) {
          return { results: [], note: "知识库中未找到相关内容" };
        }
        return {
          results: results.map((r) => ({
            content: r.chunk.content,
            source: r.chunk.metadata?.source || "",
            heading: r.chunk.metadata?.heading || "",
            score: r.score,
          })),
        };
      } catch (e) {
        return { error: `知识库搜索失败: ${e}` };
      }
    },
  });

  tools.push({
    name: "save_user_memory",
    description:
      "将用户偏好或习惯保存到长期记忆中，以便在后续对话中自动参考。例如：用户习惯将文件保存到 ~/Downloads、用户偏好 Markdown 格式等。仅在用户明确表达偏好或你发现重复模式时使用。",
    parameters: {
      key: {
        type: "string",
        description: "偏好的简短标识（如 '默认保存路径'、'输出格式偏好'）",
      },
      value: {
        type: "string",
        description: "偏好的具体内容",
      },
      category: {
        type: "string",
        description: "类型：preference（偏好）、fact（事实）、pattern（模式）",
        required: false,
      },
    },
    execute: async (params) => {
      const key = String(params.key || "").trim();
      const value = String(params.value || "").trim();
      if (!key || !value) return { error: "key 和 value 不能为空" };
      const category = (params.category as "preference" | "fact" | "pattern") || "preference";
      try {
        const { useAgentMemoryStore } = await import("@/store/agent-memory-store");
        useAgentMemoryStore.getState().addMemory(key, value, category);
        return { status: "saved", key, value };
      } catch (e) {
        return { error: `保存记忆失败: ${e}` };
      }
    },
  });

  tools.push(...createLocalDevTools(confirmHostFallback));
  tools.push(createReminderTool());

  const isMac =
    typeof navigator !== "undefined" &&
    navigator.platform.toLowerCase().includes("mac");
  if (isMac) {
    tools.push(...createNativeAppTools());
  }

  const isWin =
    typeof navigator !== "undefined" &&
    navigator.platform.toLowerCase().includes("win");
  if (isWin) {
    tools.push(...createWindowsNativeTools());
  }

  return {
    tools,
    resetPerRunState: () => {
      askUserCalled = false;
      sequentialThinkingState.history = [];
      sequentialThinkingState.branches = {};
    },
  };
}
