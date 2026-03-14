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

function decodeBase64Utf8(input: string): string {
  const normalized = input.replace(/\s+/g, "");
  const binary = globalThis.atob(normalized);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
      description: "写入本地文本文件（会覆盖目标文件）。注意：对于已有文件的局部修改，优先使用 str_replace_edit 工具（更精确、更安全）。write_file 仅适合创建全新文件或需要完全重写的场景。严禁在生成网页或代码时将图片转为 base64 嵌入！请务必优先使用外部占位符图片（如 https://placehold.co/600x400）或假文件路径，确保只输出纯文本代码。",
      parameters: {
        path: { type: "string", description: "文件路径（建议绝对路径）" },
        content: { type: "string", description: "要写入的纯文本内容，禁止使用 base64", required: true },
      },
      dangerous: true,
      execute: async (params) => {
        const path = String(params.path || "");
        if (!path.trim()) return { error: "path 不能为空" };
        const content = String(params.content || "");
        
        if (!content) return { error: "content 不能为空" };
        return agentRuntimeManager.writeTextFile(path, content, {
          confirmHostFallback,
          allowInteractiveHostWriteWhenNoPolicyRoots: true,
        });
      },
    },
    {
      name: "export_spreadsheet",
      description:
        "将数据导出为 Excel (.xlsx) 文件，用户可以直接打开。适用于数据分析结果、报表生成、数据清洗后输出等场景。",
      parameters: {
        file_name: {
          type: "string",
          description:
            "输出文件名（如 report.xlsx），会保存到用户的下载目录",
        },
        sheets: {
          type: "string",
          description:
            'JSON 字符串，格式: [{"name":"Sheet1","headers":["列A","列B"],"rows":[["值1","值2"]]}]',
        },
      },
      execute: async (params) => {
        const fileName = String(params.file_name || "export.xlsx");
        const sheetsJson = String(params.sheets || "[]");
        // Validate JSON
        try {
          JSON.parse(sheetsJson);
        } catch {
          return { error: "sheets 参数不是有效的 JSON" };
        }
        // Resolve output path to Downloads directory
        let outputDir: string;
        try {
          const { downloadDir } = await import("@tauri-apps/api/path");
          outputDir = await downloadDir();
        } catch {
          outputDir = "/tmp";
        }
        const outputPath = `${outputDir}${fileName}`;
        try {
          const result = await invokeTauri<string>("export_spreadsheet", {
            outputPath,
            sheetsJson,
          });
          return `已导出 Excel 文件: ${result}`;
        } catch (err) {
          return { error: `导出失败: ${err}` };
        }
      },
    },
    {
      name: "str_replace_edit",
      description: `对文件进行精确编辑。支持三种命令：
- str_replace: 精确替换文件中的一段文本（old_str → new_str）。old_str 必须在文件中唯一匹配。
- insert: 在指定行号之后插入新文本。
- create: 创建新文件（文件已存在则报错，防止误覆盖）。
优先使用此工具而非 write_file 来修改已有文件。`,
      parameters: {
        command: {
          type: "string",
          description: "操作命令: str_replace | insert | create",
        },
        path: { type: "string", description: "文件绝对路径" },
        old_str: {
          type: "string",
          description: "[str_replace] 要被替换的原始文本（必须与文件内容完全匹配，包括缩进和空白）",
          required: false,
        },
        new_str: {
          type: "string",
          description: "[str_replace/create] 替换后的新文本，或 create 时的文件内容",
          required: false,
        },
        insert_line: {
          type: "integer",
          description: "[insert] 在此行号之后插入文本（0 表示插入到文件开头）",
          required: false,
        },
      },
      dangerous: true,
      execute: async (params) => {
        const command = String(params.command || "").trim();
        const path = String(params.path || "").trim();
        if (!path) return { error: "path 不能为空" };
        if (!["str_replace", "insert", "create"].includes(command)) {
          return { error: `无效命令: ${command}，可选: str_replace, insert, create` };
        }

        // ── create: 创建新文件（已存在则报错） ──
        if (command === "create") {
          const content = String(params.new_str ?? "");
          try {
            const existing = await invokeTauri<string>("read_text_file", { path }).catch(() => null);
            if (existing !== null) {
              return { error: `文件已存在: ${path}。如需覆盖请使用 write_file，如需修改请使用 str_replace 命令。` };
            }
            await agentRuntimeManager.writeTextFile(path, content, {
              confirmHostFallback,
              allowInteractiveHostWriteWhenNoPolicyRoots: true,
            });
            return { success: true, path, message: `文件已创建 (${content.split("\n").length} 行)` };
          } catch (e) {
            return { error: `创建文件失败: ${e}` };
          }
        }

        // ── 读取文件内容 ──
        let fileContent: string;
        try {
          const result = await invokeTauri<string | { content: string }>("read_text_file", { path });
          fileContent = typeof result === "string" ? result : result.content;
        } catch (e) {
          return { error: `无法读取文件 ${path}: ${e}` };
        }

        const lines = fileContent.split("\n");

        // ── str_replace: 精确替换 ──
        if (command === "str_replace") {
          const oldStr = String(params.old_str ?? "");
          const newStr = String(params.new_str ?? "");
          if (!oldStr) return { error: "old_str 不能为空" };
          if (oldStr === newStr) return { error: "old_str 和 new_str 相同，无需替换" };

          // 计算匹配次数和位置
          let matchCount = 0;
          let searchFrom = 0;
          const matchPositions: number[] = [];
          while (true) {
            const idx = fileContent.indexOf(oldStr, searchFrom);
            if (idx === -1) break;
            matchCount++;
            matchPositions.push(idx);
            searchFrom = idx + 1;
          }

          if (matchCount === 0) {
            // 提供诊断信息帮助 LLM 修正
            const firstLine = oldStr.split("\n")[0].trim();
            const candidates = lines
              .map((l, i) => ({ line: i + 1, content: l }))
              .filter((l) => l.content.includes(firstLine))
              .slice(0, 5);
            return {
              error: `old_str 在文件中未找到匹配。请确认文本完全一致（包括缩进、空格、换行）。`,
              hint: candidates.length > 0
                ? `首行 "${firstLine}" 出现在以下行: ${candidates.map((c) => `第${c.line}行: "${c.content.trim()}"`).join("; ")}`
                : `首行 "${firstLine}" 在文件中未找到。请用 read_file_range 确认文件内容。`,
            };
          }

          if (matchCount > 1) {
            const lineNumbers = matchPositions.map((pos) => {
              const before = fileContent.slice(0, pos);
              return before.split("\n").length;
            });
            return {
              error: `old_str 在文件中匹配了 ${matchCount} 次（行: ${lineNumbers.join(", ")}）。请提供更多上下文使其唯一匹配。`,
            };
          }

          // 唯一匹配，执行替换
          const newContent = fileContent.replace(oldStr, newStr);
          try {
            await agentRuntimeManager.writeTextFile(path, newContent, {
              confirmHostFallback,
              allowInteractiveHostWriteWhenNoPolicyRoots: true,
            });
          } catch (e) {
            return { error: `写入文件失败: ${e}` };
          }

          // 返回编辑区域的上下文片段
          const replaceStart = fileContent.indexOf(oldStr);
          const beforeLines = fileContent.slice(0, replaceStart).split("\n");
          const startLine = beforeLines.length;
          const newLines = newContent.split("\n");
          const snippetStart = Math.max(0, startLine - 3);
          const snippetEnd = Math.min(newLines.length, startLine + newStr.split("\n").length + 2);
          const snippet = newLines
            .slice(snippetStart, snippetEnd)
            .map((l, i) => `${snippetStart + i + 1} | ${l}`)
            .join("\n");

          return {
            success: true,
            path,
            replacements: 1,
            snippet,
          };
        }

        // ── insert: 在指定行后插入 ──
        if (command === "insert") {
          const insertLine = typeof params.insert_line === "number" ? Math.floor(params.insert_line) : -1;
          const newStr = String(params.new_str ?? "");
          if (insertLine < 0) return { error: "insert_line 必须 >= 0（0 表示插入到文件开头）" };
          if (insertLine > lines.length) {
            return { error: `insert_line (${insertLine}) 超出文件总行数 (${lines.length})` };
          }
          if (!newStr) return { error: "new_str 不能为空" };

          const insertLines = newStr.split("\n");
          lines.splice(insertLine, 0, ...insertLines);
          const newContent = lines.join("\n");

          try {
            await agentRuntimeManager.writeTextFile(path, newContent, {
              confirmHostFallback,
              allowInteractiveHostWriteWhenNoPolicyRoots: true,
            });
          } catch (e) {
            return { error: `写入文件失败: ${e}` };
          }

          const snippetStart = Math.max(0, insertLine - 2);
          const snippetEnd = Math.min(lines.length, insertLine + insertLines.length + 2);
          const snippet = lines
            .slice(snippetStart, snippetEnd)
            .map((l, i) => `${snippetStart + i + 1} | ${l}`)
            .join("\n");

          return {
            success: true,
            path,
            inserted_lines: insertLines.length,
            after_line: insertLine,
            snippet,
          };
        }

        return { error: "未知命令" };
      },
    },
    {
      name: "run_shell_command",
      description: "执行终端命令（用于构建、测试、格式化、搜索等）。每次调用独立执行，不保留工作目录等状态。如需保持会话状态（如 cd 后继续操作），请使用 persistent_shell 工具。",
      timeout: 240_000,
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
      name: "run_lint",
      description: `在项目目录中运行代码检查（lint/typecheck）并返回结构化诊断结果。
自动检测项目类型并选择合适的检查器：TypeScript 项目用 tsc + eslint，Python 用 ruff/flake8，Rust 用 cargo check。
修改代码后建议调用此工具验证没有引入语法或类型错误。`,
      readonly: true,
      parameters: {
        project_path: { type: "string", description: "项目根目录（绝对路径）" },
        files: {
          type: "string",
          description: "只检查指定文件（逗号分隔的相对路径，可选。不填则检查整个项目）",
          required: false,
        },
      },
      execute: async (params) => {
        const projectPath = String(params.project_path || "").trim();
        if (!projectPath) return { error: "project_path 不能为空" };

        const files = params.files ? String(params.files).split(",").map((f) => f.trim()).filter(Boolean) : [];

        // 检测项目类型
        const detectFile = async (name: string): Promise<boolean> => {
          try {
            await invokeTauri("read_text_file", { path: `${projectPath}/${name}` });
            return true;
          } catch { return false; }
        };

        const [hasTsConfig, hasPackageJson, hasCargoToml, hasPyproject] = await Promise.all([
          detectFile("tsconfig.json"),
          detectFile("package.json"),
          detectFile("Cargo.toml"),
          detectFile("pyproject.toml"),
        ]);

        const commands: string[] = [];
        if (hasTsConfig) {
          commands.push("npx tsc --noEmit --pretty 2>&1 | head -60");
        }
        if (hasPackageJson && !hasTsConfig) {
          // JS 项目无 tsconfig，尝试 eslint
          const fileArgs = files.length > 0 ? files.join(" ") : ".";
          commands.push(`npx eslint ${fileArgs} --format compact 2>&1 | head -60`);
        }
        if (hasTsConfig && files.length > 0) {
          const fileArgs = files.join(" ");
          commands.push(`npx eslint ${fileArgs} --format compact 2>&1 | head -40`);
        }
        if (hasCargoToml) {
          commands.push("cargo check --message-format short 2>&1 | head -60");
        }
        if (hasPyproject) {
          commands.push("(ruff check . --output-format concise 2>/dev/null || python -m flake8 . --max-line-length 120 2>/dev/null || echo 'No Python linter found') | head -60");
        }

        if (commands.length === 0) {
          return { note: "未检测到已知项目类型（需要 tsconfig.json / package.json / Cargo.toml / pyproject.toml）" };
        }

        const fullCommand = `cd ${JSON.stringify(projectPath)} && ${commands.join(" && echo '---' && ")}`;
        try {
          const result = (await agentRuntimeManager.runShellCommand(fullCommand, {
            confirmHostFallback,
          })) as unknown as Record<string, unknown>;

          const stdout = String(result.stdout || result.output || "").trim();
          const stderr = String(result.stderr || "").trim();
          const exitCode = typeof result.exit_code === "number" ? result.exit_code
            : typeof result.exitCode === "number" ? result.exitCode : null;

          const hasErrors = exitCode !== 0 || /error/i.test(stdout);
          return {
            project: projectPath,
            checkers: commands.map((c) => c.split(" ")[0].replace("npx ", "")),
            exit_code: exitCode,
            has_errors: hasErrors,
            diagnostics: stdout || "(无输出)",
            ...(stderr ? { stderr } : {}),
          };
        } catch (e) {
          return { error: `检查执行失败: ${e}` };
        }
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
  notifyToolCalled: (toolName: string) => void;
}

export function createBuiltinAgentTools(
  confirmHostFallback: (context: RuntimeFallbackContext) => Promise<boolean>,
  askUser?: (questions: AskUserQuestion[]) => Promise<AskUserAnswers>,
): BuiltinToolsResult {
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
        "按需获取系统与常用目录信息（home/desktop/downloads），用于构造绝对路径并避免 ~ 路径错误。仅在无法从上下文直接确定路径时使用，不要把它当作默认第一步。",
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

  let askUserCallCount = 0;
  if (askUser) {
    tools.push({
      name: "ask_user",
      description:
        `向用户提问（弹出交互对话框）。最多调用 2 次，第一次就用 extra_questions 把所有问题问完。
获得回答后立即执行任务，不要反复追问。
示例: ask_user(question='搜索什么主题？', options='技术文档,学术论文,新闻', extra_questions='[{"question":"具体关键词？","type":"text"},{"question":"语言偏好？","options":["中文","英文"]}]')`,
      parameters: {
        question: {
          type: "string",
          description: "主问题，要清晰具体",
        },
        type: {
          type: "string",
          description: "问题类型: single(单选,默认), multi(多选), text(仅自由输入)",
          required: false,
        },
        options: {
          type: "string",
          description: "选项列表，逗号分隔。如: '在线搜索,本地文件,知识库'。type 为 text 时可不传",
          required: false,
        },
        extra_questions: {
          type: "string",
          description: `追加问题（JSON 数组），一次性问完所有需要的信息。格式: [{"question":"...","type":"single","options":["A","B"]}]`,
          required: false,
        },
      },
      execute: async (params) => {
        askUserCallCount++;
        if (askUserCallCount > 2) {
          return {
            error: "ask_user 已调用 2 次，不要再向用户提问。请根据已有信息直接执行任务并给出结果。",
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

        const hint = askUserCallCount > 1
          ? { tip: "提示：可以用 extra_questions 参数把多个问题合并到一次调用中，减少打扰用户。" }
          : {};

        try {
          const answers = await askUser(questions);
          return {
            answers,
            ...(extraQuestionsParseError ? { warning: "extra_questions JSON 格式无法解析，仅展示了主问题" } : {}),
            ...hint,
          };
        } catch (e) {
          askUserCallCount--;
          return { error: `ask_user 执行失败: ${e}` };
        }
      },
    });
  }

  const sequentialThinkingState = {
    history: [] as Array<{ thought: string; number: number; total: number; isRevision?: boolean; revisesThought?: number; branchId?: string }>,
    branches: {} as Record<string, unknown[]>,
    consecutiveCalls: 0,
  };

  tools.push(
    {
      name: "sequential_thinking",
      description:
        `逐步推理工具。仅在需要分解复杂问题时使用，每次思考后应立即使用 read_file、list_directory 等工具获取实际信息。
重要：不要连续调用此工具超过 3 次，思考后必须执行实际操作（读取文件、搜索代码等）再继续。`,
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
        const MAX_CONSECUTIVE = 3;
        sequentialThinkingState.consecutiveCalls++;

        if (sequentialThinkingState.consecutiveCalls > MAX_CONSECUTIVE) {
          sequentialThinkingState.consecutiveCalls = 0;
          return {
            error: "已连续思考超过 3 次，请停止调用 sequential_thinking，立即使用 read_file、list_directory、search_in_files 等工具获取实际信息后再继续。",
            next_thought_needed: false,
          };
        }

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

        const warningSuffix = sequentialThinkingState.consecutiveCalls >= MAX_CONSECUTIVE
          ? " ⚠️ 你已连续思考 3 次，下一步必须使用实际工具（read_file / list_directory / search_in_files 等）获取信息。"
          : "";

        return {
          thought_number: entry.number,
          total_thoughts: entry.total,
          next_thought_needed: nextNeeded,
          branches: Object.keys(sequentialThinkingState.branches),
          thought_history_length: sequentialThinkingState.history.length,
          ...(warningSuffix ? { warning: warningSuffix } : {}),
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
        const docs = await invokeTauri<Array<{ id: string }>>("rag_list_doc_summaries");
        if (!docs || docs.length === 0) {
          return { note: "用户知识库为空或尚未完成索引，请先导入并入库文档" };
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
      const category = String(params.category || "preference");
      try {
        const { addMemoryFromAgent } = await import("@/core/ai/memory-store");
        const saved = await addMemoryFromAgent(key, value, category);
        return saved ? { status: "saved", key, value } : { status: "filtered", reason: "content filtered" };
      } catch (e) {
        return { error: `保存记忆失败: ${e}` };
      }
    },
  });

  tools.push(...createLocalDevTools(confirmHostFallback));
  tools.push(createReminderTool());

  // ── persistent_shell: 持久化 Shell 会话工具 ──
  const shellSession = {
    cwd: "",
    env: {} as Record<string, string>,
    history: [] as Array<{ command: string; exitCode: number | null }>,
    timedOut: false,
  };

  tools.push({
    name: "persistent_shell",
    description: `持久化终端会话。与 run_shell_command 不同，此工具在多次调用间保持工作目录和环境变量状态。
适用场景：cd 进入项目目录后连续操作、激活虚拟环境后运行命令、需要多步 shell 操作的编程任务。
超时（120秒）后会话将被标记为失效，需传 restart=true 重启。`,
    parameters: {
      command: { type: "string", description: "要执行的 shell 命令" },
      restart: {
        type: "boolean",
        description: "是否重启会话（清除工作目录和环境状态）",
        required: false,
      },
      timeout_seconds: {
        type: "integer",
        description: "超时秒数（默认 120，最大 300）",
        required: false,
      },
    },
    dangerous: true,
    execute: async (params) => {
      const restart = params.restart === true || params.restart === "true";
      if (restart) {
        shellSession.cwd = "";
        shellSession.env = {};
        shellSession.history = [];
        shellSession.timedOut = false;
      }
      if (shellSession.timedOut && !restart) {
        return {
          error: "会话已超时失效。请传 restart=true 重启会话后再执行命令。",
          hint: "上次超时的命令可能仍在后台运行，请注意检查。",
        };
      }

      const command = String(params.command || "").trim();
      if (!command) return { error: "command 不能为空" };

      const timeoutSec = Math.min(Math.max(Number(params.timeout_seconds) || 120, 5), 300);

      // 构建带状态的命令：先 cd 到上次的工作目录，设置环境变量，执行命令，最后输出当前目录
      const envPrefix = Object.entries(shellSession.env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
        .join(" && ");
      const cdPrefix = shellSession.cwd ? `cd ${JSON.stringify(shellSession.cwd)}` : "";
      const sentinel = `__AGENT_CWD_${Date.now()}__`;
      const parts = [cdPrefix, envPrefix, command, `echo "${sentinel}$(pwd)"`].filter(Boolean);
      const fullCommand = parts.join(" && ");

      try {
        const resultPromise = agentRuntimeManager.runShellCommand(fullCommand, {
          confirmHostFallback,
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SHELL_TIMEOUT")), timeoutSec * 1000),
        );

        const result = (await Promise.race([resultPromise, timeoutPromise])) as unknown as Record<string, unknown>;

        // 从输出中提取新的 cwd
        const stdout = String(result.stdout || result.output || "");
        const sentinelIdx = stdout.lastIndexOf(sentinel);
        let cleanOutput = stdout;
        if (sentinelIdx !== -1) {
          const newCwd = stdout.slice(sentinelIdx + sentinel.length).trim();
          if (newCwd) shellSession.cwd = newCwd;
          cleanOutput = stdout.slice(0, sentinelIdx).trimEnd();
        }

        const exitCode = typeof result.exit_code === "number" ? result.exit_code
          : typeof result.exitCode === "number" ? result.exitCode : null;

        shellSession.history.push({ command, exitCode });

        // 解析 export 命令来跟踪环境变量
        const exportMatch = command.match(/export\s+(\w+)=(.+?)(?:\s*&&|$)/g);
        if (exportMatch) {
          for (const m of exportMatch) {
            const kv = m.match(/export\s+(\w+)=(.+?)(?:\s*&&|$)/);
            if (kv) shellSession.env[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
          }
        }

        return {
          output: cleanOutput,
          stderr: result.stderr || "",
          exit_code: exitCode,
          cwd: shellSession.cwd,
          session_commands: shellSession.history.length,
        };
      } catch (e) {
        if (e instanceof Error && e.message === "SHELL_TIMEOUT") {
          shellSession.timedOut = true;
          return {
            error: `命令执行超时（${timeoutSec}秒）。会话已失效，请传 restart=true 重启。`,
            command,
            timeout_seconds: timeoutSec,
          };
        }
        return { error: `命令执行失败: ${e}` };
      }
    },
  });

  // ── json_edit: JSON 文件精确编辑工具 ──
  tools.push({
    name: "json_edit",
    description: `精确编辑 JSON 文件（如 package.json, tsconfig.json 等配置文件）。支持四种操作：
- view: 查看指定路径的值（如 "dependencies.react"）
- set: 设置指定路径的值
- add: 在指定路径添加新字段
- remove: 删除指定路径的字段
使用点号分隔的路径（如 "compilerOptions.strict"），数组用数字索引（如 "scripts.0"）。`,
    parameters: {
      path: { type: "string", description: "JSON 文件的绝对路径" },
      operation: {
        type: "string",
        description: "操作类型: view | set | add | remove",
      },
      json_path: {
        type: "string",
        description: '目标字段路径，用点号分隔（如 "dependencies.react"、"compilerOptions.strict"）。空字符串表示根对象。',
      },
      value: {
        type: "string",
        description: '[set/add] 要设置的值（JSON 格式字符串，如 \'"hello"\'、\'true\'、\'{ "key": "val" }\'）',
        required: false,
      },
    },
    dangerous: true,
    execute: async (params) => {
      const filePath = String(params.path || "").trim();
      const operation = String(params.operation || "").trim();
      const jsonPath = String(params.json_path ?? "").trim();

      if (!filePath) return { error: "path 不能为空" };
      if (!["view", "set", "add", "remove"].includes(operation)) {
        return { error: `无效操作: ${operation}，可选: view, set, add, remove` };
      }

      // 读取并解析 JSON
      let fileContent: string;
      let jsonData: unknown;
      try {
        const result = await invokeTauri<string | { content: string }>("read_text_file", { path: filePath });
        fileContent = typeof result === "string" ? result : result.content;
        jsonData = JSON.parse(fileContent);
      } catch (e) {
        return { error: `读取或解析 JSON 失败: ${e}` };
      }

      // 路径解析辅助
      const pathParts = jsonPath ? jsonPath.split(".") : [];

      const getByPath = (obj: unknown, parts: string[]): unknown => {
        let current = obj;
        for (const part of parts) {
          if (current === null || current === undefined) return undefined;
          if (Array.isArray(current)) {
            const idx = parseInt(part, 10);
            current = isNaN(idx) ? undefined : current[idx];
          } else if (typeof current === "object") {
            current = (current as Record<string, unknown>)[part];
          } else {
            return undefined;
          }
        }
        return current;
      };

      const setByPath = (obj: unknown, parts: string[], value: unknown): boolean => {
        if (parts.length === 0) return false;
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          if (current === null || current === undefined || typeof current !== "object") return false;
          const part = parts[i];
          if (Array.isArray(current)) {
            const idx = parseInt(part, 10);
            if (isNaN(idx)) return false;
            current = current[idx];
          } else {
            current = (current as Record<string, unknown>)[part];
          }
        }
        if (current === null || current === undefined || typeof current !== "object") return false;
        const lastPart = parts[parts.length - 1];
        if (Array.isArray(current)) {
          const idx = parseInt(lastPart, 10);
          if (isNaN(idx)) return false;
          current[idx] = value;
        } else {
          (current as Record<string, unknown>)[lastPart] = value;
        }
        return true;
      };

      const deleteByPath = (obj: unknown, parts: string[]): boolean => {
        if (parts.length === 0) return false;
        const parent = parts.length === 1 ? obj : getByPath(obj, parts.slice(0, -1));
        if (parent === null || parent === undefined || typeof parent !== "object") return false;
        const lastPart = parts[parts.length - 1];
        if (Array.isArray(parent)) {
          const idx = parseInt(lastPart, 10);
          if (isNaN(idx) || idx >= parent.length) return false;
          parent.splice(idx, 1);
        } else {
          if (!(lastPart in (parent as Record<string, unknown>))) return false;
          delete (parent as Record<string, unknown>)[lastPart];
        }
        return true;
      };

      // ── view ──
      if (operation === "view") {
        const value = pathParts.length === 0 ? jsonData : getByPath(jsonData, pathParts);
        if (value === undefined) {
          return { error: `路径 "${jsonPath}" 不存在`, available_keys: typeof jsonData === "object" && jsonData !== null ? Object.keys(jsonData as Record<string, unknown>).slice(0, 20) : [] };
        }
        return { path: jsonPath || "(root)", value };
      }

      // 解析 value 参数
      let parsedValue: unknown;
      if (operation === "set" || operation === "add") {
        const rawValue = String(params.value ?? "");
        if (rawValue === "" && operation !== "add") return { error: "value 不能为空" };
        try {
          parsedValue = rawValue === "" ? null : JSON.parse(rawValue);
        } catch {
          // 如果不是合法 JSON，当作字符串
          parsedValue = rawValue;
        }
      }

      // ── set ──
      if (operation === "set") {
        if (pathParts.length === 0) {
          jsonData = parsedValue;
        } else {
          const existing = getByPath(jsonData, pathParts);
          if (existing === undefined) {
            return { error: `路径 "${jsonPath}" 不存在。如需添加新字段请使用 add 操作。` };
          }
          if (!setByPath(jsonData, pathParts, parsedValue)) {
            return { error: `无法设置路径 "${jsonPath}"` };
          }
        }
      }

      // ── add ──
      if (operation === "add") {
        if (pathParts.length === 0) {
          return { error: "add 操作需要指定 json_path" };
        }
        const existing = getByPath(jsonData, pathParts);
        if (existing !== undefined) {
          return { error: `路径 "${jsonPath}" 已存在（当前值: ${JSON.stringify(existing).slice(0, 100)}）。如需修改请使用 set 操作。` };
        }
        // 确保父路径存在
        const parentParts = pathParts.slice(0, -1);
        const parent = parentParts.length === 0 ? jsonData : getByPath(jsonData, parentParts);
        if (parent === null || parent === undefined || typeof parent !== "object") {
          return { error: `父路径 "${parentParts.join(".")}" 不存在或不是对象/数组` };
        }
        if (!setByPath(jsonData, pathParts, parsedValue)) {
          return { error: `无法在路径 "${jsonPath}" 添加值` };
        }
      }

      // ── remove ──
      if (operation === "remove") {
        if (pathParts.length === 0) {
          return { error: "remove 操作需要指定 json_path" };
        }
        if (!deleteByPath(jsonData, pathParts)) {
          return { error: `路径 "${jsonPath}" 不存在或无法删除` };
        }
      }

      // 写回文件（保持 2 空格缩进 + 尾换行，与常见 JSON 格式一致）
      try {
        const newContent = JSON.stringify(jsonData, null, 2) + "\n";
        await agentRuntimeManager.writeTextFile(filePath, newContent, {
          confirmHostFallback,
          allowInteractiveHostWriteWhenNoPolicyRoots: true,
        });
        return {
          success: true,
          operation,
          path: jsonPath || "(root)",
          new_value: operation === "remove" ? "(deleted)" : getByPath(jsonData, pathParts),
        };
      } catch (e) {
        return { error: `写入 JSON 文件失败: ${e}` };
      }
    },
  });

  // ── manage_skills: 技能管理工具 ──
  tools.push({
    name: "manage_skills",
    description: `管理 AI 技能（领域知识包）。可以列出、创建、启用/禁用、删除技能。
技能会注入 system prompt，为 AI 提供特定领域的知识和行为约束。
当用户要求你"学会"某个领域知识、"记住"某类工作流程、或安装/创建技能时使用此工具。`,
    parameters: {
      action: {
        type: "string",
        description: "操作类型：list | create | enable | disable | delete | get",
      },
      id: {
        type: "string",
        description: "技能 ID（enable/disable/delete/get 时必填）",
        required: false,
      },
      name: {
        type: "string",
        description: "技能名称（create 时必填）",
        required: false,
      },
      description: {
        type: "string",
        description: "技能简短描述（create 时必填）",
        required: false,
      },
      system_prompt: {
        type: "string",
        description: "技能的系统提示词，Markdown 格式的领域知识和行为约束（create 时必填）",
        required: false,
      },
      trigger_patterns: {
        type: "string",
        description: "触发模式，用逗号分隔的正则表达式列表（create 时可选，留空则需手动激活）",
        required: false,
      },
      category: {
        type: "string",
        description: "分类标签，如 coding / writing / devops / data（create 时可选）",
        required: false,
      },
    },
    execute: async (params) => {
      const { useSkillStore } = await import("@/store/skill-store");
      const action = String(params.action || "").trim().toLowerCase();

      let snap = useSkillStore.getState();
      if (!snap.loaded) {
        await snap.load();
        snap = useSkillStore.getState();
      }

      switch (action) {
        case "list": {
          return {
            skills: snap.skills.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              category: s.category,
              source: s.source,
              enabled: s.enabled,
              autoActivate: s.autoActivate,
              triggerCount: s.triggerPatterns?.length ?? 0,
            })),
            total: snap.skills.length,
            enabled: snap.skills.filter((s) => s.enabled).length,
          };
        }

        case "get": {
          const id = String(params.id || "").trim();
          const skill = snap.skills.find((s) => s.id === id);
          if (!skill) return { error: `技能 "${id}" 不存在` };
          return {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            category: skill.category,
            source: skill.source,
            enabled: skill.enabled,
            autoActivate: skill.autoActivate,
            triggerPatterns: skill.triggerPatterns,
            systemPrompt: skill.systemPrompt?.slice(0, 500),
            promptLength: skill.systemPrompt?.length ?? 0,
          };
        }

        case "create": {
          const name = String(params.name || "").trim();
          const description = String(params.description || "").trim();
          const systemPrompt = String(params.system_prompt || "").trim();
          if (!name || !systemPrompt) {
            return { error: "create 操作需要 name 和 system_prompt 参数" };
          }
          const patterns = params.trigger_patterns
            ? String(params.trigger_patterns).split(",").map((s: string) => s.trim()).filter(Boolean)
            : [];
          const skill = await snap.add({
            name,
            description: description || name,
            version: "1.0.0",
            enabled: true,
            autoActivate: patterns.length > 0,
            triggerPatterns: patterns.length > 0 ? patterns : undefined,
            systemPrompt,
            category: params.category ? String(params.category).trim() : undefined,
            source: "user",
          });
          return {
            success: true,
            message: `技能 "${name}" 已创建并启用`,
            id: skill.id,
          };
        }

        case "enable": {
          const id = String(params.id || "").trim();
          const skill = snap.skills.find((s) => s.id === id);
          if (!skill) return { error: `技能 "${id}" 不存在` };
          if (skill.enabled) return { message: `技能 "${skill.name}" 已经是启用状态` };
          await snap.toggleEnabled(id);
          return { success: true, message: `技能 "${skill.name}" 已启用` };
        }

        case "disable": {
          const id = String(params.id || "").trim();
          const skill = snap.skills.find((s) => s.id === id);
          if (!skill) return { error: `技能 "${id}" 不存在` };
          if (!skill.enabled) return { message: `技能 "${skill.name}" 已经是禁用状态` };
          await snap.toggleEnabled(id);
          return { success: true, message: `技能 "${skill.name}" 已禁用` };
        }

        case "delete": {
          const id = String(params.id || "").trim();
          const skill = snap.skills.find((s) => s.id === id);
          if (!skill) return { error: `技能 "${id}" 不存在` };
          if (skill.source === "builtin") return { error: "内置技能不能删除，只能禁用" };
          const ok = await snap.remove(id);
          return ok
            ? { success: true, message: `技能 "${skill.name}" 已删除` }
            : { error: "删除失败" };
        }

        default:
          return { error: `未知操作 "${action}"。支持的操作：list, get, create, enable, disable, delete` };
      }
    },
  });

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
      askUserCallCount = 0;
      sequentialThinkingState.history = [];
      sequentialThinkingState.branches = {};
      sequentialThinkingState.consecutiveCalls = 0;
      shellSession.cwd = "";
      shellSession.env = {};
      shellSession.history = [];
      shellSession.timedOut = false;
    },
    notifyToolCalled: (toolName: string) => {
      if (toolName !== "sequential_thinking") {
        sequentialThinkingState.consecutiveCalls = 0;
      }
    },
  };
}
