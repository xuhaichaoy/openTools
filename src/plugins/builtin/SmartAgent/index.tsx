import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { Bot, Wrench, Trash2 } from "lucide-react";
import {
  ReActAgent,
  pluginActionToTool,
  type AgentStep,
  type AgentTool,
} from "./core/react-agent";
import { registry } from "@/core/plugin-system/registry";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { useAgentStore } from "@/store/agent-store";

import { AgentSessionList } from "./components/AgentSessionList";
import { AgentTaskBlock } from "./components/AgentTaskBlock";
import { AgentInputBar } from "./components/AgentInputBar";
import { ConfirmDialog } from "./components/ConfirmDialog";

export interface SmartAgentHandle {
  clear: () => void;
  getToolCount: () => number;
  toggleTools: () => void;
  toggleHistory: () => void;
  newSession: () => void;
  getSessionCount: () => number;
}

interface SmartAgentProps {
  onBack?: () => void;
  ai?: MToolsAI;
  headless?: boolean;
}

const SmartAgentPlugin = forwardRef<SmartAgentHandle, SmartAgentProps>(
  function SmartAgentPlugin({ onBack, ai, headless }, ref) {
    const [input, setInput] = useState("");
    const [running, setRunning] = useState(false);
    const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
    const [availableTools, setAvailableTools] = useState<AgentTool[]>([]);
    const [showTools, setShowTools] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const isComposingRef = useRef(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [pendingImages, setPendingImages] = useState<string[]>([]);
    const [pendingImagePreviews, setPendingImagePreviews] = useState<string[]>(
      [],
    );

    // 危险操作确认对话框
    const [confirmDialog, setConfirmDialog] = useState<{
      toolName: string;
      params: Record<string, unknown>;
      resolve: (confirmed: boolean) => void;
    } | null>(null);

    // Agent store
    const {
      sessions,
      currentSessionId,
      historyLoaded,
      loadHistory,
      createSession,
      getCurrentSession,
      setCurrentSession,
      updateSession,
      addTask,
      updateTask,
      deleteSession,
      renameSession,
    } = useAgentStore();

    const currentSession = getCurrentSession();
    const tasks = currentSession?.tasks || [];
    const hasAnySteps = tasks.some((t) => t.steps.length > 0);

    // ---- Effects ----

    useEffect(() => {
      if (!historyLoaded) loadHistory();
    }, [historyLoaded, loadHistory]);

    // 收集所有插件暴露的 actions 作为工具
    useEffect(() => {
      if (!ai) return;
      const allActions = registry.getAllActions();
      const tools: AgentTool[] = allActions.map(
        ({ pluginId, pluginName, action }) =>
          pluginActionToTool(pluginId, pluginName, action, ai),
      );

      tools.push({
        name: "get_current_time",
        description: "获取当前时间",
        execute: async () => ({
          time: new Date().toLocaleString("zh-CN"),
          timestamp: Date.now(),
        }),
      });

      tools.push({
        name: "calculate",
        description: "执行数学计算",
        parameters: {
          expression: { type: "string", description: "数学表达式（如 2+3*4）" },
        },
        execute: async (params) => {
          try {
            const expr = String(params.expression).replace(
              /[^0-9+\-*/().%\s]/g,
              "",
            );
            if (!expr.trim()) return { error: "无效表达式" };
            const result = Function('"use strict"; return (' + expr + ")")();
            if (typeof result !== "number" || !isFinite(result))
              return { error: `计算结果无效: ${result}` };
            return { expression: params.expression, result };
          } catch (e) {
            return { error: `计算失败: ${e}` };
          }
        },
      });

      // 添加本地开发工具（代码读写/命令执行）
      tools.push({
        name: "list_directory",
        description: "列出目录下的文件和子目录（用于定位项目结构）",
        parameters: {
          path: { type: "string", description: "目录路径（建议绝对路径）" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          const path = String(params.path || ".");
          return invoke("list_directory", { path });
        },
      });

      tools.push({
        name: "read_file",
        description: "读取本地文本文件（代码、配置、日志等）",
        parameters: {
          path: { type: "string", description: "文件路径（建议绝对路径）" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          const path = String(params.path || "");
          if (!path.trim()) return { error: "path 不能为空" };
          return invoke("read_text_file", { path });
        },
      });

      tools.push({
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
          const { invoke } = await import("@tauri-apps/api/core");
          const path = String(params.path || "");
          if (!path.trim()) return { error: "path 不能为空" };
          const start_line =
            typeof params.start_line === "number"
              ? Math.floor(params.start_line)
              : undefined;
          const end_line =
            typeof params.end_line === "number"
              ? Math.floor(params.end_line)
              : undefined;
          const max_lines =
            typeof params.max_lines === "number"
              ? Math.floor(params.max_lines)
              : undefined;
          return invoke("read_text_file_range", {
            path,
            start_line,
            end_line,
            max_lines,
          });
        },
      });

      tools.push({
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
          const { invoke } = await import("@tauri-apps/api/core");
          const path = String(params.path || "");
          const query = String(params.query || "");
          if (!path.trim()) return { error: "path 不能为空" };
          if (!query.trim()) return { error: "query 不能为空" };
          const case_sensitive =
            typeof params.case_sensitive === "boolean"
              ? params.case_sensitive
              : undefined;
          const max_results =
            typeof params.max_results === "number"
              ? Math.floor(params.max_results)
              : undefined;
          const file_pattern =
            typeof params.file_pattern === "string"
              ? params.file_pattern
              : undefined;
          return invoke("search_in_files", {
            path,
            query,
            case_sensitive,
            max_results,
            file_pattern,
          });
        },
      });

      tools.push({
        name: "write_file",
        description: "写入本地文本文件（会覆盖目标文件）",
        parameters: {
          path: { type: "string", description: "文件路径（建议绝对路径）" },
          content: { type: "string", description: "要写入的文本内容" },
        },
        dangerous: true,
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          const path = String(params.path || "");
          if (!path.trim()) return { error: "path 不能为空" };
          const content = String(params.content || "");
          return invoke("write_text_file", { path, content });
        },
      });

      tools.push({
        name: "run_shell_command",
        description: "执行终端命令（用于构建、测试、格式化、搜索等）",
        parameters: {
          command: { type: "string", description: "命令行指令" },
        },
        dangerous: true,
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          const command = String(params.command || "").trim();
          if (!command) return { error: "command 不能为空" };
          return invoke("run_shell_command", { command });
        },
      });

      // 添加提醒工具
      tools.push({
        name: "add_reminder",
        description:
          "添加定时提醒任务（如：10分钟后提醒我喝水，或者下午3点开会）",
        parameters: {
          message: { type: "string", description: "提醒内容" },
          time: {
            type: "string",
            description:
              "提醒时间（ISO 8601 格式字符串，例如 2024-01-01T12:00:00）",
          },
        },
        execute: async (params) => {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const message = String(params.message);
            const time = String(params.time);

            if (!message || !time) return { error: "缺少参数" };

            // 生成唯一 ID
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

            await invoke("workflow_create", { workflow });
            await invoke("workflow_scheduler_reload", { workflowId: id });

            return {
              success: true,
              message: `已设置提醒: "${message}" 于 ${new Date(time).toLocaleString()}`,
            };
          } catch (e) {
            return { error: `设置提醒失败: ${e}` };
          }
        },
      });

      // ── 本机原生应用工具 ──

      tools.push({
        name: "native_calendar_list",
        description: "列出本机所有日历账户",
        execute: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_calendar_list");
        },
      });

      tools.push({
        name: "native_calendar_list_events",
        description: "查看日历事件列表（今日或指定日期范围）",
        parameters: {
          from_date: { type: "string", description: "开始日期 (YYYY-MM-DD)，默认今天" },
          to_date: { type: "string", description: "结束日期 (YYYY-MM-DD)，默认同 from_date" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_calendar_list_events", {
            fromDate: params.from_date || null,
            toDate: params.to_date || null,
          });
        },
      });

      tools.push({
        name: "native_calendar_create_event",
        description: "在日历中创建新事件/日程",
        parameters: {
          title: { type: "string", description: "事件标题" },
          start_date: { type: "string", description: "开始时间 (ISO 8601，如 2026-02-16T14:00:00)" },
          end_date: { type: "string", description: "结束时间 (ISO 8601)" },
          notes: { type: "string", description: "备注（可选）" },
          location: { type: "string", description: "地点（可选）" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_calendar_create_event", {
            title: String(params.title),
            startDate: String(params.start_date),
            endDate: String(params.end_date),
            notes: params.notes ? String(params.notes) : null,
            location: params.location ? String(params.location) : null,
            calendarName: null,
          });
        },
      });

      tools.push({
        name: "native_reminder_lists",
        description: "列出本机所有提醒事项列表",
        execute: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_reminder_lists");
        },
      });

      tools.push({
        name: "native_reminder_list_incomplete",
        description: "查看未完成的提醒事项",
        parameters: {
          list_name: { type: "string", description: "提醒事项列表名称（可选，不填则查所有列表）" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_reminder_list_incomplete", {
            listName: params.list_name ? String(params.list_name) : null,
          });
        },
      });

      tools.push({
        name: "native_reminder_create",
        description: "创建一条新的提醒事项",
        parameters: {
          title: { type: "string", description: "提醒标题" },
          notes: { type: "string", description: "备注（可选）" },
          due_date: { type: "string", description: "截止时间 (ISO 8601，可选)" },
          list_name: { type: "string", description: "目标列表名称（可选，默认使用系统默认列表）" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_reminder_create", {
            title: String(params.title),
            notes: params.notes ? String(params.notes) : null,
            dueDate: params.due_date ? String(params.due_date) : null,
            listName: params.list_name ? String(params.list_name) : null,
          });
        },
      });

      tools.push({
        name: "native_notes_search",
        description: "搜索 macOS 备忘录中的笔记",
        parameters: {
          keyword: { type: "string", description: "搜索关键词" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_notes_search", {
            keyword: String(params.keyword),
          });
        },
      });

      tools.push({
        name: "native_notes_create",
        description: "在 macOS 备忘录中创建新笔记",
        parameters: {
          title: { type: "string", description: "笔记标题" },
          body: { type: "string", description: "笔记正文内容" },
          folder_name: { type: "string", description: "文件夹名称（可选，默认使用「备忘录」）" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_notes_create", {
            title: String(params.title),
            body: String(params.body),
            folderName: params.folder_name ? String(params.folder_name) : null,
          });
        },
      });

      tools.push({
        name: "native_mail_create",
        description: "创建邮件草稿（打开系统邮件应用）",
        parameters: {
          to: { type: "string", description: "收件人邮箱" },
          subject: { type: "string", description: "邮件主题" },
          body: { type: "string", description: "邮件正文" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_mail_create", {
            to: String(params.to),
            subject: String(params.subject),
            body: String(params.body),
          });
        },
      });

      tools.push({
        name: "native_shortcuts_list",
        description: "列出 macOS 快捷指令列表",
        execute: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_shortcuts_list");
        },
      });

      tools.push({
        name: "native_shortcuts_run",
        description: "运行指定的 macOS 快捷指令",
        parameters: {
          name: { type: "string", description: "快捷指令名称" },
          input: { type: "string", description: "传入的输入文本（可选）" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_shortcuts_run", {
            name: String(params.name),
            input: params.input ? String(params.input) : null,
          });
        },
      });

      tools.push({
        name: "native_app_open",
        description: "打开或切换到本机应用（如微信、Safari、访达等）",
        parameters: {
          app_name: { type: "string", description: "应用名称（如 Safari、微信、备忘录）" },
        },
        execute: async (params) => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_app_open", {
            appName: String(params.app_name),
          });
        },
      });

      tools.push({
        name: "native_app_list",
        description: "列出本机已安装的可交互应用列表",
        execute: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          return invoke("native_app_list_interactive");
        },
      });

      setAvailableTools(tools);
    }, [ai]);

    // ---- Image handling ----

    const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          const reader = new FileReader();
          reader.onload = async () => {
            const dataUrl = reader.result as string;
            setPendingImagePreviews((prev) => [...prev, dataUrl]);
            const base64 = dataUrl.split(",")[1];
            const ext = blob.type.split("/")[1] || "png";
            const fileName = `agent_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const filePath = await invoke<string>("ai_save_chat_image", {
                imageData: base64,
                fileName,
              });
              setPendingImages((prev) => [...prev, filePath]);
            } catch (err) {
              console.error("保存图片失败:", err);
              setPendingImagePreviews((prev) => prev.slice(0, -1));
            }
          };
          reader.readAsDataURL(blob);
        }
      }
    }, []);

    const handleFileSelect = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !file.type.startsWith("image/")) return;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          setPendingImagePreviews((prev) => [...prev, dataUrl]);
          const base64 = dataUrl.split(",")[1];
          const ext = file.type.split("/")[1] || "png";
          const fileName = `agent_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const filePath = await invoke<string>("ai_save_chat_image", {
              imageData: base64,
              fileName,
            });
            setPendingImages((prev) => [...prev, filePath]);
          } catch (err) {
            console.error("保存图片失败:", err);
            setPendingImagePreviews((prev) => prev.slice(0, -1));
          }
        };
        reader.readAsDataURL(file);
        e.target.value = "";
      },
      [],
    );

    const removeImage = useCallback((index: number) => {
      setPendingImages((prev) => prev.filter((_, i) => i !== index));
      setPendingImagePreviews((prev) => prev.filter((_, i) => i !== index));
    }, []);

    // ---- Agent Run ----

    const handleRunRef = useRef<(() => void) | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !isComposingRef.current &&
        e.keyCode !== 229
      ) {
        e.preventDefault();
        handleRunRef.current?.();
      }
    }, []);

    const handleStop = useCallback(() => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
        setRunning(false);
      }
    }, []);

    const handleRun = useCallback(async () => {
      if (!ai || (!input.trim() && pendingImages.length === 0) || running)
        return;

      let query = input.trim();
      const imagePaths = [...pendingImages];
      if (imagePaths.length > 0) {
        const imageInfo = imagePaths.join("\n");
        query = query
          ? `${query}\n\n[用户附带了以下图片文件]\n${imageInfo}`
          : `请分析以下图片文件:\n${imageInfo}`;
      }

      let sessionId = currentSessionId;
      let taskId: string;
      let historySteps: AgentStep[] = [];

      if (!sessionId) {
        sessionId = createSession(query);
        // createSession 已创建第一个 task，获取其 id
        const newSession = useAgentStore
          .getState()
          .sessions.find((s) => s.id === sessionId);
        taskId = newSession?.tasks[0]?.id ?? "";
      } else {
        const session = getCurrentSession();
        if (session) {
          for (const task of session.tasks) {
            historySteps.push(...task.steps);
            if (task.answer) {
              historySteps.push({
                type: "answer",
                content: task.answer,
                timestamp: session.createdAt,
              });
            }
          }
        }
        taskId = addTask(sessionId, query);
      }

      setInput("");
      setPendingImages([]);
      setPendingImagePreviews([]);
      setRunning(true);
      if (inputRef.current) inputRef.current.style.height = "auto";

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const collectedSteps: AgentStep[] = [];

      const agent = new ReActAgent(
        ai,
        availableTools,
        {
          maxIterations: 8,
          verbose: true,
          dangerousToolPatterns: [
            "write_file",
            "open_path",
            "shell",
            "run_shell",
            "system-actions_",
            "native_calendar_create",
            "native_reminder_create",
            "native_notes_create",
            "native_mail_create",
            "native_shortcuts_run",
          ],
          confirmDangerousAction: (toolName, params) =>
            new Promise<boolean>((resolve) => {
              setConfirmDialog({ toolName, params, resolve });
            }),
        },
        (step) => {
          // findLastIndex 兼容实现（ES2022 无此方法）
          const findLastIdx = (pred: (s: AgentStep) => boolean) => {
            for (let i = collectedSteps.length - 1; i >= 0; i--) {
              if (pred(collectedSteps[i])) return i;
            }
            return -1;
          };

          if (step.streaming) {
            // 流式中间步骤：替换最后一个同类型的 streaming 步骤（而非新增）
            const lastIdx = findLastIdx(
              (s) => !!s.streaming && s.type === step.type,
            );
            if (lastIdx >= 0) {
              collectedSteps[lastIdx] = step;
            } else {
              collectedSteps.push(step);
            }
          } else {
            // 最终步骤：移除同类型的 streaming 临时步骤，添加确定版本
            const streamIdx = findLastIdx(
              (s) => !!s.streaming && s.type === step.type,
            );
            if (streamIdx >= 0) {
              collectedSteps.splice(streamIdx, 1);
            }
            collectedSteps.push(step);
          }
          if (sessionId && taskId)
            updateTask(sessionId, taskId, { steps: [...collectedSteps] });
          setTimeout(() => {
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior: "smooth",
            });
          }, 100);
        },
        historySteps,
      );

      try {
        const result = await agent.run(query, abortController.signal);
        if (sessionId && taskId)
          updateTask(sessionId, taskId, { answer: result });
      } catch (e) {
        const msg =
          (e as Error).message === "Aborted"
            ? "任务已通过用户请求停止。"
            : `Agent 执行失败: ${e}`;
        if (sessionId && taskId) updateTask(sessionId, taskId, { answer: msg });
      } finally {
        setRunning(false);
        abortControllerRef.current = null;
        inputRef.current?.focus();
      }
    }, [
      ai,
      input,
      running,
      availableTools,
      pendingImages,
      createSession,
      addTask,
      updateTask,
      currentSessionId,
      getCurrentSession,
    ]);

    handleRunRef.current = handleRun;

    // ---- Helpers ----

    const toggleStep = useCallback((key: string) => {
      setExpandedSteps((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }, []);

    const handleClear = useCallback(() => {
      const id = useAgentStore.getState().currentSessionId;
      if (id) updateSession(id, { tasks: [] });
      setInput("");
      setExpandedSteps(new Set());
    }, [updateSession]);

    const handleNewSession = useCallback(() => {
      createSession("");
      setInput("");
      setExpandedSteps(new Set());
      inputRef.current?.focus();
    }, [createSession]);

    useImperativeHandle(ref, () => ({
      clear: handleClear,
      getToolCount: () => availableTools.length,
      toggleTools: () => setShowTools((v) => !v),
      toggleHistory: () => setShowHistory((v) => !v),
      newSession: handleNewSession,
      getSessionCount: () => sessions.length,
    }));

    // ---- Render ----

    return (
      <div className="flex h-full bg-[var(--color-bg)] text-[var(--color-text)] relative">
        {/* 历史会话侧边栏 */}
        {showHistory && (
          <>
            <div
              className="absolute inset-0 bg-black/20 z-20"
              onClick={() => setShowHistory(false)}
            />
            <div className="absolute left-0 top-0 bottom-0 w-[280px] bg-[var(--color-bg)] border-r border-[var(--color-border)] z-30 shadow-2xl animate-in slide-in-from-left duration-200">
              <AgentSessionList
                sessions={sessions}
                currentSessionId={currentSessionId}
                onSelect={(id) => {
                  setCurrentSession(id);
                  setShowHistory(false);
                  setExpandedSteps(new Set());
                  setInput("");
                }}
                onDelete={deleteSession}
                onRename={renameSession}
                onNew={() => {
                  handleNewSession();
                  setShowHistory(false);
                }}
                onClose={() => setShowHistory(false)}
              />
            </div>
          </>
        )}

        {/* 主体 */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* 头部 */}
          {!headless && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-2">
                {onBack && (
                  <button
                    onClick={onBack}
                    className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
                  >
                    ←
                  </button>
                )}
                <Bot className="w-5 h-5 text-emerald-500" />
                <h2 className="font-semibold">智能 Agent</h2>
                <span className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] px-2 py-0.5 rounded-full">
                  ReAct
                </span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setShowHistory(true)}
                  className="text-xs px-2 py-1 rounded bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] relative"
                >
                  历史
                  {sessions.length > 1 && (
                    <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-emerald-500 text-white text-[7px] rounded-full flex items-center justify-center font-medium">
                      {sessions.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setShowTools(!showTools)}
                  className="text-xs px-2 py-1 rounded bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <Wrench className="w-3 h-3 inline mr-1" />
                  {availableTools.length} 工具
                </button>
                {hasAnySteps && (
                  <button
                    onClick={handleClear}
                    className="p-1 rounded hover:bg-[var(--color-bg-secondary)]"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 可用工具列表 */}
          {showTools && (
            <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/30 max-h-32 overflow-auto">
              <p className="text-xs text-[var(--color-text-secondary)] mb-1">
                Agent 可调用的工具:
              </p>
              <div className="flex flex-wrap gap-1">
                {availableTools.map((tool) => (
                  <span
                    key={tool.name}
                    className="text-xs px-2 py-0.5 bg-[var(--color-bg-secondary)] rounded"
                    title={tool.description}
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 推理过程：多任务块 */}
          <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
            {tasks.length === 0 && !running && (
              <div className="text-center text-[var(--color-text-secondary)] py-12">
                <Bot className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm">
                  输入问题或任务，Agent 会自主思考并调用工具
                </p>
                <p className="text-xs mt-1 opacity-60">
                  思考 → 行动 → 观察 → 回答
                </p>
              </div>
            )}

            {tasks.map((task, taskIdx) => (
              <AgentTaskBlock
                key={taskIdx}
                task={task}
                taskIdx={taskIdx}
                isLastTask={taskIdx === tasks.length - 1}
                isRunning={running}
                expandedSteps={expandedSteps}
                onToggleStep={toggleStep}
              />
            ))}
          </div>

          {/* 输入区域 */}
          <AgentInputBar
            running={running}
            ai={!!ai}
            hasExistingTasks={tasks.length > 0}
            onRun={handleRun}
            onStop={handleStop}
            input={input}
            onInputChange={setInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              setTimeout(() => {
                isComposingRef.current = false;
              }, 200);
            }}
            pendingImagePreviews={pendingImagePreviews}
            onFileSelect={handleFileSelect}
            onRemoveImage={removeImage}
            inputRef={inputRef}
            fileInputRef={fileInputRef}
          />
        </div>

        {/* 危险操作确认对话框 */}
        {confirmDialog && (
          <ConfirmDialog
            toolName={confirmDialog.toolName}
            params={confirmDialog.params}
            onConfirm={() => {
              confirmDialog.resolve(true);
              setConfirmDialog(null);
            }}
            onCancel={() => {
              confirmDialog.resolve(false);
              setConfirmDialog(null);
            }}
          />
        )}
      </div>
    );
  },
);

export default SmartAgentPlugin;
