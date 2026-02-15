import React, { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import {
  Bot,
  Send,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wrench,
  Brain,
  Eye,
  MessageCircle,
  AlertCircle,
  Trash2,
  PanelLeftClose,
  Search,
  Plus,
  Pencil,
  Check,
  X,
} from "lucide-react";
import {
  ReActAgent,
  pluginActionToTool,
  type AgentStep,
  type AgentTool,
} from "./core/react-agent";
import { registry } from "@/core/plugin-system/registry";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { useAgentStore } from "@/store/agent-store";

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

const STEP_ICONS: Record<string, React.ReactNode> = {
  thought: <Brain className="w-3.5 h-3.5 text-purple-500" />,
  action: <Wrench className="w-3.5 h-3.5 text-blue-500" />,
  observation: <Eye className="w-3.5 h-3.5 text-green-500" />,
  answer: <MessageCircle className="w-3.5 h-3.5 text-emerald-500" />,
  error: <AlertCircle className="w-3.5 h-3.5 text-red-500" />,
};

const STEP_LABELS: Record<string, string> = {
  thought: "思考",
  action: "操作",
  observation: "观察",
  answer: "回答",
  error: "错误",
};

const SmartAgentPlugin = forwardRef<SmartAgentHandle, SmartAgentProps>(function SmartAgentPlugin({ onBack, ai, headless }, ref) {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const [availableTools, setAvailableTools] = useState<AgentTool[]>([]);
  const [showTools, setShowTools] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    deleteSession,
    renameSession,
  } = useAgentStore();

  const currentSession = getCurrentSession();
  const steps = currentSession?.steps || [];
  const answer = currentSession?.answer || null;

  // 加载历史
  useEffect(() => {
    if (!historyLoaded) {
      loadHistory();
    }
  }, [historyLoaded, loadHistory]);

  // 收集所有插件暴露的 actions 作为工具
  useEffect(() => {
    if (!ai) return;
    const allActions = registry.getAllActions();
    const tools = allActions.map(({ pluginId, pluginName, action }) =>
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
        expression: {
          type: "string",
          description: "数学表达式（如 2+3*4）",
        },
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

    setAvailableTools(tools);
  }, [ai]);

  const handleRun = useCallback(async () => {
    if (!ai || !input.trim() || running) return;
    const query = input.trim();

    // 创建新会话并清空输入
    const sessionId = createSession(query);
    setInput("");
    setRunning(true);
    setExpandedSteps(new Set());

    const collectedSteps: AgentStep[] = [];

    const agent = new ReActAgent(
      ai,
      availableTools,
      {
        maxIterations: 8,
        verbose: true,
        dangerousToolPatterns: ["write_file", "shell", "run_shell"],
        confirmDangerousAction: (toolName, params) => {
          return new Promise<boolean>((resolve) => {
            setConfirmDialog({ toolName, params, resolve });
          });
        },
      },
      (step) => {
        collectedSteps.push(step);
        updateSession(sessionId, { steps: [...collectedSteps] });
        setTimeout(() => {
          scrollRef.current?.scrollTo({
            top: scrollRef.current.scrollHeight,
            behavior: "smooth",
          });
        }, 100);
      },
    );

    try {
      const result = await agent.run(query);
      updateSession(sessionId, { answer: result });
    } catch (e) {
      updateSession(sessionId, { answer: `Agent 执行失败: ${e}` });
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }, [ai, input, running, availableTools, createSession, updateSession]);

  const toggleStep = useCallback((idx: number) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const handleClear = useCallback(() => {
    const id = useAgentStore.getState().currentSessionId;
    if (id) {
      updateSession(id, { steps: [], answer: null });
    }
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
        {/* 头部 — headless 模式下隐藏 */}
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
            {steps.length > 0 && (
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

        {/* 推理过程 */}
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-2">
          {/* 当前查询 */}
          {currentSession?.query && (
            <div className="mb-3 p-3 bg-indigo-500/5 border border-indigo-500/20 rounded-lg">
              <span className="text-xs text-indigo-500 font-medium">任务：</span>
              <span className="text-sm ml-1">{currentSession.query}</span>
            </div>
          )}

          {steps.length === 0 && !running && !currentSession?.query && (
            <div className="text-center text-[var(--color-text-secondary)] py-12">
              <Bot className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">输入问题或任务，Agent 会自主思考并调用工具</p>
              <p className="text-xs mt-1 opacity-60">
                思考 → 行动 → 观察 → 回答
              </p>
            </div>
          )}

          {steps.map((step, i) => (
            <div
              key={i}
              className={`rounded-lg border transition-colors ${
                step.type === "answer"
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : step.type === "error"
                    ? "border-red-500/30 bg-red-500/5"
                    : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
              }`}
            >
              <button
                onClick={() => toggleStep(i)}
                className="w-full flex items-center gap-2 p-2 text-left"
              >
                {expandedSteps.has(i) ? (
                  <ChevronDown className="w-3 h-3 shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 shrink-0" />
                )}
                {STEP_ICONS[step.type]}
                <span className="text-xs font-medium">
                  {STEP_LABELS[step.type]}
                </span>
                {step.toolName && (
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    → {step.toolName}
                  </span>
                )}
                <span className="text-xs text-[var(--color-text-secondary)] ml-auto">
                  {new Date(step.timestamp).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              </button>
              {expandedSteps.has(i) && (
                <div className="px-3 pb-2 text-sm whitespace-pre-wrap border-t border-[var(--color-border)] pt-2 mx-2 mb-2">
                  {step.content}
                </div>
              )}
            </div>
          ))}

          {running && (
            <div className="flex items-center gap-2 p-3 text-[var(--color-text-secondary)]">
              <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
              <span className="text-sm">Agent 思考中...</span>
            </div>
          )}

          {/* 最终回答 */}
          {answer && !running && (
            <div className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
              <h4 className="text-sm font-medium text-emerald-600 mb-2 flex items-center gap-1.5">
                <MessageCircle className="w-4 h-4" />
                最终回答
              </h4>
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {answer}
              </div>
            </div>
          )}
        </div>

        {/* 输入区域 */}
        <div className="p-3 border-t border-[var(--color-border)]">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleRun()}
              placeholder="输入任务或问题... (如: 把当前时间戳转成日期)"
              disabled={running || !ai}
              className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50"
            />
            <button
              onClick={handleRun}
              disabled={running || !input.trim() || !ai}
              className="px-4 py-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
          {!ai && (
            <p className="text-xs text-red-500 mt-1">
              请先在设置中配置 AI 模型
            </p>
          )}
        </div>
      </div>

      {/* 危险操作确认对话框 */}
      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl w-[380px] p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center">
                <AlertCircle className="w-4 h-4 text-amber-500" />
              </div>
              <h3 className="text-sm font-semibold text-[var(--color-text)]">
                操作确认
              </h3>
            </div>
            <p className="text-xs text-[var(--color-text-secondary)] mb-2">
              Agent 想要执行以下操作，是否允许？
            </p>
            <div className="bg-[var(--color-bg-secondary)] rounded-lg p-3 mb-4 text-xs font-mono">
              <div className="text-amber-500 font-medium mb-1">
                {confirmDialog.toolName}
              </div>
              <pre className="text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-32 overflow-auto">
                {JSON.stringify(confirmDialog.params, null, 2)}
              </pre>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  confirmDialog.resolve(false);
                  setConfirmDialog(null);
                }}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                拒绝
              </button>
              <button
                onClick={() => {
                  confirmDialog.resolve(true);
                  setConfirmDialog(null);
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors"
              >
                允许执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default SmartAgentPlugin;

/* ========== Agent 历史会话列表组件 ========== */

interface AgentSessionListProps {
  sessions: Array<{ id: string; title: string; query: string; steps: AgentStep[]; answer: string | null; createdAt: number }>;
  currentSessionId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
  onClose: () => void;
}

function AgentSessionList({
  sessions,
  currentSessionId,
  onSelect,
  onDelete,
  onRename,
  onNew,
  onClose,
}: AgentSessionListProps) {
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const filtered = sessions.filter(
    (s) =>
      s.title.toLowerCase().includes(search.toLowerCase()) ||
      s.query.toLowerCase().includes(search.toLowerCase()),
  );

  const handleConfirmRename = (id: string) => {
    const trimmed = editTitle.trim();
    if (trimmed) onRename(id, trimmed);
    setEditingId(null);
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    const time = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    if (isToday) return `今天 ${time}`;
    if (isYesterday) return `昨天 ${time}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  };

  return (
    <div className="flex flex-col h-full relative">
      {/* 删除确认 */}
      {deleteConfirmId && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 rounded-r-xl">
          <div className="w-[260px] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-xl p-4 mx-3">
            <p className="text-sm text-[var(--color-text)] mb-4">确定删除这个会话？</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onDelete(deleteConfirmId);
                  setDeleteConfirmId(null);
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 顶部 */}
      <div className="px-3 pt-3 pb-2 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-colors"
              title="关闭"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold text-[var(--color-text)]">
              Agent 历史
            </span>
          </div>
          <button
            onClick={onNew}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
          >
            <Plus className="w-3 h-3" />
            新任务
          </button>
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索历史任务..."
            className="w-full text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded-lg pl-7 pr-2 py-1.5 outline-none border border-[var(--color-border)] focus:border-emerald-500/40 transition-colors"
          />
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-secondary)]">
            <Bot className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs opacity-60">
              {search ? "没有找到匹配的任务" : "暂无历史记录"}
            </p>
          </div>
        ) : (
          filtered.map((session) => {
            const isActive = session.id === currentSessionId;
            const isEditing = editingId === session.id;
            const preview = session.answer?.slice(0, 60) || session.query?.slice(0, 60) || "空会话";

            return (
              <div
                key={session.id}
                className={`group relative rounded-xl px-3 py-2 cursor-pointer transition-all ${
                  isActive
                    ? "bg-emerald-500/10 border border-emerald-500/20"
                    : "hover:bg-[var(--color-bg-hover)] border border-transparent"
                }`}
                onClick={() => !isEditing && onSelect(session.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleConfirmRename(session.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="flex-1 text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded px-1.5 py-0.5 outline-none border border-emerald-500/40"
                        />
                        <button
                          onClick={() => handleConfirmRename(session.id)}
                          className="p-0.5 text-green-400 hover:text-green-300"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="p-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs font-medium text-[var(--color-text)] truncate">
                        {session.title || "新任务"}
                      </div>
                    )}
                    {!isEditing && (
                      <div className="text-[10px] text-[var(--color-text-secondary)] truncate mt-0.5">
                        {preview}
                      </div>
                    )}
                  </div>

                  {!isEditing && (
                    <div
                      className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => { setEditingId(session.id); setEditTitle(session.title); }}
                        className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                        title="重命名"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(session.id)}
                        className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="删除"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                {!isEditing && (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
                      {formatTime(session.createdAt)}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-secondary)] opacity-40">
                      {session.steps.length} 步
                    </span>
                    {session.answer && (
                      <span className="text-[10px] text-emerald-500 opacity-60">
                        已完成
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
