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
    const [pendingImagePreviews, setPendingImagePreviews] = useState<string[]>([]);

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
      const tools: AgentTool[] = allActions.map(({ pluginId, pluginName, action }) =>
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
            const expr = String(params.expression).replace(/[^0-9+\-*/().%\s]/g, "");
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

    const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
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
    }, []);

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
      if (!ai || (!input.trim() && pendingImages.length === 0) || running) return;

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
        const newSession = useAgentStore.getState().sessions.find((s) => s.id === sessionId);
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
          dangerousToolPatterns: ["write_file", "shell", "run_shell"],
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
          if (sessionId && taskId) updateTask(sessionId, taskId, { steps: [...collectedSteps] });
          setTimeout(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
          }, 100);
        },
        historySteps,
      );

      try {
        const result = await agent.run(query, abortController.signal);
        if (sessionId && taskId) updateTask(sessionId, taskId, { answer: result });
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
    }, [ai, input, running, availableTools, pendingImages, createSession, addTask, updateTask, currentSessionId, getCurrentSession]);

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
                <p className="text-sm">输入问题或任务，Agent 会自主思考并调用工具</p>
                <p className="text-xs mt-1 opacity-60">思考 → 行动 → 观察 → 回答</p>
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
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { setTimeout(() => { isComposingRef.current = false; }, 200); }}
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
