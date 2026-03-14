import React, { useState, useCallback, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import {
  Users,
  Square,
  Loader2,
  Plus,
  Trash2,
  Send,
  Settings2,
  Bot,
  User,
  X,
  Reply,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileDown,
  FolderOpen,
  RotateCcw,
  ListChecks,
  Network,
  Brain,
  ShieldCheck,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useActorSystemStore, type ActorSnapshot } from "@/store/actor-system-store";
import { useAIStore } from "@/store/ai-store";
import { useTeamStore } from "@/store/team-store";
import { useClusterPlanApprovalStore } from "@/store/cluster-plan-approval-store";
import { api } from "@/core/api/client";
import { primeTeamModelCache } from "@/core/ai/router";
import { DIALOG_FULL_ROLE } from "@/core/agent/actor/agent-actor";
import type {
  AgentCapability,
  AgentCapabilities,
    ApprovalDecisionOption,
    ApprovalLevel,
    DialogArtifactRecord,
    DialogExecutionPlan,
    DialogMessage,
    MiddlewareOverrides,
    PendingInteraction,
    SessionUploadRecord,
    SpawnedTaskRecord,
    ThinkingLevel,
    ToolPolicy,
  } from "@/core/agent/actor/types";
import { ChatImage } from "@/components/ai/MessageBubble";
import {
  DIALOG_PRESETS,
  loadCustomPresets,
  saveCustomPreset,
  deleteCustomPreset,
  exportCustomPresets,
  importCustomPresets,
  type DialogPreset,
  type DialogRoutingMode,
} from "@/core/agent/actor/dialog-presets";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ClusterPlan } from "@/core/agent/cluster/types";
import { useInputAttachments, FILE_ACCEPT_ALL, type InputAttachment } from "@/hooks/use-input-attachments";
import { AttachDropdown } from "@/components/ui/AttachDropdown";

const TaskCenterPanel = lazy(() => import("../TaskCenterPanel"));
const KnowledgeGraphView = lazy(() => import("../KnowledgeGraphView"));

type DialogOverlay = "tasks" | "graph" | null;

function basename(path: unknown): string {
  const s = String(path ?? "");
  return s.split("/").pop() || s;
}

function dirname(path: unknown): string {
  const s = String(path ?? "");
  if (!s) return "";
  const parts = s.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/") || "/";
}

function formatApprovalResponse(content: string): string | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;
  if (/^(允许|允许一次|本次允许|仅此一次|y|yes|ok|可以|同意|确认|approve|allow)$/i.test(normalized)) {
    return "已批准本次执行";
  }
  if (/^(始终允许|本会话允许|always|always[\s-]?allow|总是允许)/i.test(normalized)) {
    return `已批准并在本会话内记住：${content.trim()}`;
  }
  if (/^(拒绝|n|no|deny|reject)/i.test(normalized)) {
    return "已拒绝此次执行";
  }
  return null;
}

function getInteractionStatusLabel(status?: DialogMessage["interactionStatus"]): string {
  switch (status) {
    case "answered":
      return "已处理";
    case "timed_out":
      return "已超时";
    case "cancelled":
      return "已取消";
    default:
      return "等待批准";
  }
}

function describeAgentActivity(steps: AgentStep[], roleName: string, hasStreamingContent: boolean): string {
  if (hasStreamingContent) return "正在生成回复";

  const latest = steps[steps.length - 1];
  if (!latest) return `${roleName} 正在思考`;

  if (latest.type === "thinking") return "深度思考中";

  if (latest.type === "action" && latest.toolName) {
    const input = latest.toolInput ?? {};
    switch (latest.toolName) {
      case "read_file":
      case "read_file_range":
        return `读取 ${basename(input.path)}`;
      case "list_directory":
        return `浏览目录 ${basename(input.path)}`;
      case "search_in_files":
        return `搜索 "${String(input.query ?? "").slice(0, 30)}"`;
      case "write_file":
        return `写入 ${basename(input.path)}`;
      case "str_replace_edit":
        return `编辑 ${basename(input.path)}`;
      case "json_edit":
        return `编辑 ${basename(input.path)}`;
      case "run_shell_command":
      case "persistent_shell":
        return `执行 ${String(input.command ?? "").slice(0, 40)}`;
      case "web_search":
        return `搜索 "${String(input.query ?? "").slice(0, 30)}"`;
      case "web_fetch":
        return `访问 ${String(input.url ?? "").replace(/^https?:\/\//, "").slice(0, 35)}`;
      case "sequential_thinking":
        return `推理分析中`;
      case "ckg_search_function":
      case "ckg_search_class":
      case "ckg_search_class_method":
        return `查找 ${String(input.name ?? "")}`;
      case "run_lint":
        return `检查代码`;
      case "ask_user":
        return `等待用户回答`;
      case "task_done":
        return `任务完成`;
      default:
        return `${latest.toolName}`;
    }
  }

  if (latest.type === "observation") {
    const prevAction = [...steps].reverse().find((s) => s.type === "action");
    if (prevAction?.toolName) {
      const name = prevAction.toolName;
      if (name === "read_file" || name === "read_file_range")
        return `已读取 ${basename(prevAction.toolInput?.path)}，分析中`;
      if (name === "search_in_files")
        return `搜索完成，分析结果`;
      if (name === "run_shell_command" || name === "persistent_shell")
        return `命令执行完成，分析输出`;
      return `${name} 完成，继续处理`;
    }
    return `处理结果中`;
  }

  if (latest.type === "thought") {
    const text = latest.content.replace(/\n/g, " ").trim();
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
  }

  if (latest.type === "answer") return "生成回复中";
  if (latest.type === "error") return "遇到错误，处理中";

  return `${roleName} 正在思考`;
}

function ThinkingBlock({
  roleName,
  content,
  startedAt,
  isStreaming,
  color,
}: {
  roleName: string;
  content: string;
  startedAt: number;
  isStreaming: boolean;
  color: { bg: string; text: string; border: string; dot: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  useEffect(() => {
    if (expanded && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [expanded, content]);

  const elapsed = Math.floor(((isStreaming ? now : Date.now()) - startedAt) / 1000);
  const timeLabel = elapsed >= 60
    ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`
    : `${elapsed}秒`;

  return (
    <div className={`flex gap-2 ${color.text}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${color.bg}`}>
        <Brain className="w-3.5 h-3.5" />
      </div>
      <div className="max-w-[80%] min-w-[200px]">
        <div className="text-[10px] mb-0.5">{roleName}</div>
        <div className={`rounded-xl ${color.bg} overflow-hidden`}>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] cursor-pointer hover:opacity-80 transition-opacity"
          >
            {expanded
              ? <ChevronDown className="w-3 h-3 shrink-0" />
              : <ChevronRight className="w-3 h-3 shrink-0" />
            }
            <span className="opacity-70">
              深度思考{isStreaming ? "中" : "完成"}
            </span>
            <span className="opacity-50 ml-auto tabular-nums">
              {isStreaming && <Loader2 className="w-3 h-3 animate-spin inline mr-1" />}
              {timeLabel}
            </span>
          </button>
          {expanded && (
            <div
              ref={containerRef}
              className="px-3 pb-2 text-[12px] leading-relaxed opacity-70 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words border-t border-current/5"
            >
              {content}
              {isStreaming && <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function parsePartialToolJSON(jsonStr: string): { path: string; content: string } {
  let path = "";
  let content = "";
  try {
    const pathMatch = jsonStr.match(/"path"\s*:\s*"([^"]*)"/);
    if (pathMatch) path = pathMatch[1];
    
    // Attempt rudimentary extraction of content
    const contentIdx = jsonStr.indexOf('"content"');
    if (contentIdx !== -1) {
      const startQuote = jsonStr.indexOf('"', contentIdx + 9);
      if (startQuote !== -1) {
        let extracted = jsonStr.substring(startQuote + 1);
        if (extracted.endsWith('"}')) extracted = extracted.slice(0, -2);
        else if (extracted.endsWith('"')) extracted = extracted.slice(0, -1);
        
        // Unescape literal newlines and quotes
        extracted = extracted.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        content = extracted;
      }
    }
  } catch (e) {
    // ignore
  }
  return { path: path || "未知文件", content };
}

function ToolStreamingBlock({
  roleName,
  content,
  startedAt,
  isStreaming,
  color,
}: {
  roleName: string;
  content: string;
  startedAt: number;
  isStreaming: boolean;
  color: { bg: string; text: string; border: string; dot: string };
}) {
  const [now, setNow] = useState(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);
  
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [content]);

  const elapsed = Math.floor(((isStreaming ? now : Date.now()) - startedAt) / 1000);
  const timeLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒` : `${elapsed}秒`;
  
  const parsed = parsePartialToolJSON(content);

  return (
    <div className={`flex gap-2 ${color.text} mt-2`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${color.bg}`}>
        <FileDown className="w-3.5 h-3.5" />
      </div>
      <div className="max-w-[90%] min-w-[250px] flex-1">
        <div className="text-[10px] mb-0.5">{roleName}</div>
        <div className={`rounded-xl border border-current/10 bg-[var(--color-bg)] overflow-hidden shadow-sm`}>
          <div className={`flex items-center gap-2 px-3 py-2 text-[11px] border-b border-current/10 ${color.bg}`}>
            <span className="font-medium opacity-90 truncate max-w-[70%]">
              生成文件: {parsed.path}
            </span>
            <span className="opacity-50 ml-auto tabular-nums flex items-center gap-1">
              {isStreaming && <Loader2 className="w-3 h-3 animate-spin" />}
              {timeLabel}
            </span>
          </div>
          <div
            ref={containerRef}
            className="p-3 text-[12px] leading-[1.6] bg-[#1e1e1e] text-[#d4d4d4] font-mono max-h-[350px] overflow-y-auto whitespace-pre overflow-x-auto"
          >
            {parsed.content || <span className="opacity-30">准备写入中...</span>}
            {isStreaming && <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5" />}
          </div>
        </div>
      </div>
    </div>
  );
}

const ACTOR_COLORS = [
  { bg: "bg-blue-500/10", text: "text-blue-600", border: "border-blue-500/20", dot: "bg-blue-500" },
  { bg: "bg-purple-500/10", text: "text-purple-600", border: "border-purple-500/20", dot: "bg-purple-500" },
  { bg: "bg-emerald-500/10", text: "text-emerald-600", border: "border-emerald-500/20", dot: "bg-emerald-500" },
  { bg: "bg-amber-500/10", text: "text-amber-600", border: "border-amber-500/20", dot: "bg-amber-500" },
  { bg: "bg-rose-500/10", text: "text-rose-600", border: "border-rose-500/20", dot: "bg-rose-500" },
  { bg: "bg-cyan-500/10", text: "text-cyan-600", border: "border-cyan-500/20", dot: "bg-cyan-500" },
];

function getActorColor(index: number) {
  return ACTOR_COLORS[index % ACTOR_COLORS.length];
}

const generateId = () =>
  Math.random().toString(36).substring(2, 8);

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

const FILE_PATH_REGEX = /(?:\/[\w.\-/]+\.(?:xlsx|csv|pdf|docx|pptx|xls))/g;
const NEW_MESSAGE_TARGET = "__new_message__";
const DIALOG_PLAN_APPROVAL_KEY = "dialog-plan-approval-enabled";

type DialogArtifact = DialogArtifactRecord & {
  actorName: string;
};

interface DialogDispatchPlanBundle {
  clusterPlan: ClusterPlan;
  runtimePlan: DialogExecutionPlan;
}

type ArtifactAvailability = "ready" | "missing" | "unknown";

type WorkspacePanel = "todos" | "artifacts" | "uploads" | "subtasks" | "plan" | null;

function formatShortTime(timestamp?: number): string {
  if (!timestamp) return "刚刚";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatElapsedTime(ms?: number): string {
  if (!ms || ms < 1000) return "刚刚";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function summarizeToolPolicy(policy?: ToolPolicy): string {
  if (!policy) return "全工具";
  const parts: string[] = [];
  if (policy.allow?.length) parts.push(`允许 ${policy.allow.join(", ")}`);
  if (policy.deny?.length) parts.push(`禁止 ${policy.deny.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "全工具";
}

function summarizeMiddleware(middleware?: MiddlewareOverrides): string {
  if (!middleware) return "默认审批";
  const parts: string[] = [];
  if (middleware.approvalLevel) parts.push(`审批 ${middleware.approvalLevel}`);
  if (middleware.disable?.length) parts.push(`关闭 ${middleware.disable.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "默认审批";
}

function getApprovalActions(approval?: DialogMessage["approvalRequest"]): ApprovalDecisionOption[] {
  if (approval?.decisionOptions?.length) return approval.decisionOptions;
  return [
    { label: "允许一次", policy: "ask-every-time" },
    { label: "本会话允许", policy: "always-allow" },
    { label: "拒绝", policy: "deny" },
  ];
}

function getApprovalActionClass(option: ApprovalDecisionOption): string {
  if (option.policy === "deny") {
    return "border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-red-600 hover:border-red-500/30 hover:bg-red-500/5";
  }
  if (option.policy === "ask-every-time") {
    return "bg-[var(--color-accent)] text-white hover:opacity-90";
  }
  return "border border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15";
}

function getArtifactSourceMeta(source: DialogArtifactRecord["source"]): {
  label: string;
  className: string;
  missingHint: string;
} {
  switch (source) {
    case "approval":
      return {
        label: "审批预览",
        className: "bg-amber-500/10 text-amber-700",
        missingHint: "这是审批阶段的候选产物，确认写入后才会真正落盘。",
      };
    case "tool_write":
      return {
        label: "工具写入",
        className: "bg-emerald-500/10 text-emerald-700",
        missingHint: "运行记录显示它曾被写入，但当前没有检测到磁盘文件。",
      };
    case "tool_edit":
      return {
        label: "工具编辑",
        className: "bg-sky-500/10 text-sky-700",
        missingHint: "运行记录显示它曾被编辑，但当前没有检测到磁盘文件。",
      };
    case "upload":
      return {
        label: "用户上传",
        className: "bg-violet-500/10 text-violet-700",
        missingHint: "这份上传文件当前已不在原路径，可能已被移动或删除。",
      };
    default:
      return {
        label: "消息引用",
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
        missingHint: "当前没有检测到该路径对应的文件。",
      };
  }
}

function getDialogKindLabel(kind?: DialogMessage["kind"]): string | undefined {
  switch (kind) {
    case "approval_request":
      return "审批请求";
    case "approval_response":
      return "审批回复";
    case "clarification_request":
      return "澄清请求";
    case "clarification_response":
      return "澄清回复";
    case "agent_result":
      return "结果回传";
    case "system_notice":
      return "系统提示";
    default:
      return undefined;
  }
}

interface TaskTranscriptEntry {
  id: string;
  content: string;
  timestamp: number;
  label: string;
  kindLabel?: string;
  source: "history" | "dialog";
}

function collectTaskTranscript(params: {
  task: SpawnedTaskRecord | null;
  actorById: Map<string, ActorSnapshot>;
  dialogHistory: DialogMessage[];
}): TaskTranscriptEntry[] {
  const { task, actorById, dialogHistory } = params;
  if (!task) return [];

  const targetActor = actorById.get(task.targetActorId);
  if (!targetActor) return [];

  const start = typeof task.sessionHistoryStartIndex === "number"
    ? Math.max(0, task.sessionHistoryStartIndex)
    : 0;
  const end = task.mode === "session" && task.sessionOpen
    ? undefined
    : typeof task.sessionHistoryEndIndex === "number"
      ? Math.max(start, task.sessionHistoryEndIndex)
      : undefined;
  const historySlice = typeof task.sessionHistoryStartIndex === "number"
    ? targetActor.sessionHistory.slice(start, end)
    : targetActor.sessionHistory.filter((entry) => {
        const completedAt = task.completedAt ?? Number.POSITIVE_INFINITY;
        return entry.timestamp >= task.spawnedAt - 1000 && entry.timestamp <= completedAt;
      });

  const dialogEntries: TaskTranscriptEntry[] = dialogHistory
    .filter((message) => message.relatedRunId === task.runId)
    .map((message) => {
      const fromLabel = message.from === "user"
        ? "你"
        : (actorById.get(message.from)?.roleName ?? message.from);
      const toLabel = message.to
        ? (message.to === "user" ? "你" : (actorById.get(message.to)?.roleName ?? message.to))
        : undefined;
      const directionLabel = toLabel ? `${fromLabel} → ${toLabel}` : fromLabel;
      return {
        id: `dialog-${message.id}`,
        content: message._briefContent ?? message.content,
        timestamp: message.timestamp,
        label: directionLabel,
        kindLabel: getDialogKindLabel(message.kind),
        source: "dialog",
      };
    });

  const dedupedHistoryEntries: TaskTranscriptEntry[] = historySlice
    .filter((entry) => !dialogEntries.some((message) =>
      message.content.trim() === entry.content.trim()
      && Math.abs(message.timestamp - entry.timestamp) <= 1500,
    ))
    .map((entry, index) => ({
      id: `history-${entry.timestamp}-${index}`,
      content: entry.content,
      timestamp: entry.timestamp,
      label: entry.role === "user"
        ? (task.mode === "session" ? "子会话输入" : "任务输入")
        : (targetActor.roleName ?? task.targetActorId),
      source: "history",
    }));

  return [...dedupedHistoryEntries, ...dialogEntries].sort((a, b) => a.timestamp - b.timestamp);
}

function collectArtifacts(
  dialogHistory: DialogMessage[],
  actorById: Map<string, ActorSnapshot>,
  structuredArtifacts: DialogArtifactRecord[],
): DialogArtifact[] {
  const artifacts = new Map<string, DialogArtifact>();

  for (const artifact of structuredArtifacts) {
    const actorName = actorById.get(artifact.actorId)?.roleName ?? artifact.actorId;
    artifacts.set(artifact.path, {
      ...artifact,
      actorName,
    });
  }

  for (const message of dialogHistory) {
    const actorName = message.from === "user"
      ? "你"
      : (actorById.get(message.from)?.roleName ?? message.from);

    const targetPath = message.approvalRequest?.targetPath;
    if (targetPath) {
      const existing = artifacts.get(targetPath);
      if (!existing || existing.source === "message") {
        artifacts.set(targetPath, {
          id: `artifact-approval-${targetPath}`,
          path: targetPath,
          fileName: basename(targetPath),
          directory: dirname(targetPath),
          actorId: message.from,
          actorName,
          source: "approval",
          toolName: message.approvalRequest?.toolName,
          timestamp: message.timestamp,
          summary: message.approvalRequest?.summary ?? "待写入产物",
          preview: message.approvalRequest?.preview,
          fullContent: message.approvalRequest?.fullContent,
          language: message.approvalRequest?.previewLanguage,
        });
      }
    }

    const paths = message.content.match(FILE_PATH_REGEX) ?? [];
    for (const path of paths) {
      if (!artifacts.has(path)) {
        artifacts.set(path, {
          id: `artifact-message-${path}`,
          path,
          fileName: basename(path),
          directory: dirname(path),
          actorId: message.from,
          actorName,
          source: "message",
          timestamp: message.timestamp,
          summary: message.kind === "agent_result" ? "任务输出引用了该文件" : "消息提到了该文件",
        });
      }
    }
  }

  return [...artifacts.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function buildSessionUploadRecords(attachments: InputAttachment[]): SessionUploadRecord[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    type: attachment.type,
    name: attachment.name,
    path: attachment.path,
    size: attachment.size,
    addedAt: Date.now(),
    originalExt: attachment.originalExt,
    preview: attachment.preview,
    excerpt: attachment.textContent?.slice(0, 1200),
  }));
}

function buildDialogDispatchPlanBundle(params: {
  actors: ActorSnapshot[];
  routingMode: DialogRoutingMode;
  content: string;
  attachmentSummary?: string;
  mentionedTargetId?: string | null;
  selectedRoute?: { agentId: string; reason: string } | null;
  coordinatorActorId?: string | null;
}): DialogDispatchPlanBundle | null {
  const {
    actors,
    routingMode,
    content,
    attachmentSummary,
    mentionedTargetId,
    selectedRoute,
    coordinatorActorId,
  } = params;
  if (actors.length === 0) return null;

  const planId = `dialog-plan-${Date.now().toString(36)}`;
  const normalizedTask = content.trim() || "等待用户输入任务";
  const taskSummary = attachmentSummary
    ? `${attachmentSummary}\n${normalizedTask}`.trim()
    : normalizedTask;

  if (mentionedTargetId) {
    const target = actors.find((actor) => actor.id === mentionedTargetId);
    if (!target) return null;
    return {
      clusterPlan: {
        id: planId,
        mode: "multi_role",
        sharedContext: { routingMode: "direct" },
        steps: [
          {
            id: "direct-1",
            role: target.roleName,
            task: `直接处理用户指派任务：${taskSummary.slice(0, 240)}`,
            dependencies: [],
            critical: true,
          },
        ],
      },
      runtimePlan: {
        id: planId,
        routingMode: "direct",
        summary: `仅 ${target.roleName} 直接处理本轮任务`,
        approvedAt: Date.now(),
        initialRecipientActorIds: [target.id],
        participantActorIds: [target.id],
        allowedMessagePairs: [],
        allowedSpawnPairs: [],
        state: "armed",
      },
    };
  }

  if (routingMode === "broadcast") {
    return {
      clusterPlan: {
        id: planId,
        mode: "parallel_split",
        sharedContext: { routingMode, actorCount: actors.length },
        steps: actors.map((actor, index) => ({
          id: `broadcast-${index + 1}`,
          role: actor.roleName,
          task: `并行处理同一主题并给出视角：${taskSummary.slice(0, 220)}`,
          dependencies: [],
          critical: index === 0,
        })),
      },
      runtimePlan: {
        id: planId,
        routingMode: "broadcast",
        summary: `广播到 ${actors.length} 个 Agent 并行处理`,
        approvedAt: Date.now(),
        initialRecipientActorIds: actors.map((actor) => actor.id),
        participantActorIds: actors.map((actor) => actor.id),
        allowedMessagePairs: [],
        allowedSpawnPairs: [],
        state: "armed",
      },
    };
  }

  const preferredPrimaryId = routingMode === "smart"
    ? selectedRoute?.agentId
    : coordinatorActorId;
  const primaryActor = preferredPrimaryId
    ? actors.find((actor) => actor.id === preferredPrimaryId) ?? actors[0]
    : actors[0];
  const supportingActors = actors.filter((actor) => actor.id !== primaryActor.id);
  const allowedMessagePairs = supportingActors.flatMap((actor) => ([
    { fromActorId: primaryActor.id, toActorId: actor.id },
    { fromActorId: actor.id, toActorId: primaryActor.id },
  ]));
  const allowedSpawnPairs = supportingActors.map((actor) => ({
    fromActorId: primaryActor.id,
    toActorId: actor.id,
  }));

  const steps = [
    {
      id: "plan-1",
      role: primaryActor.roleName,
      task: routingMode === "smart"
        ? `优先接手用户任务并判断是否要派发子任务：${taskSummary.slice(0, 240)}${selectedRoute?.reason ? `（路由理由：${selectedRoute.reason}）` : ""}`
        : `作为协调者先拆解任务，再按需 spawn_task：${taskSummary.slice(0, 240)}`,
      dependencies: [],
      critical: true,
    },
    ...supportingActors.map((actor, index) => ({
      id: `plan-${index + 2}`,
      role: actor.roleName,
      task: `保持待命；当 ${primaryActor.roleName} 派发任务时，负责自己擅长的子问题`,
      dependencies: ["plan-1"],
      critical: false,
    })),
  ];

  return {
    clusterPlan: {
      id: planId,
      mode: "multi_role",
      sharedContext: { routingMode, coordinator: primaryActor.roleName },
      steps,
    },
    runtimePlan: {
      id: planId,
      routingMode: routingMode === "smart" ? "smart" : "coordinator",
      summary: `${primaryActor.roleName} 作为主协调者按需调度其他 Agent`,
      approvedAt: Date.now(),
      initialRecipientActorIds: [primaryActor.id],
      participantActorIds: [primaryActor.id, ...supportingActors.map((actor) => actor.id)],
      coordinatorActorId: primaryActor.id,
      allowedMessagePairs,
      allowedSpawnPairs,
      state: "armed",
    },
  };
}

function FileActionButtons({ content }: { content: string }) {
  const paths = content.match(FILE_PATH_REGEX);
  if (!paths?.length) return null;

  const unique = [...new Set(paths)];

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {unique.map((filePath) => {
        const fileName = filePath.replace(/^.*[/\\]/, "");
        return (
          <div key={filePath} className="flex items-center gap-1 text-[11px]">
            <button
              onClick={() => {
                void invoke("open_file_location", { filePath });
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
              title={filePath}
            >
              <FolderOpen className="w-3 h-3" />
              <span className="max-w-[120px] truncate">{fileName}</span>
            </button>
            <button
              onClick={async () => {
                try {
                  const { save } = await import("@tauri-apps/plugin-dialog");
                  const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
                  const dest = await save({ defaultPath: fileName });
                  if (dest) {
                    const data = await readFile(filePath);
                    await writeFile(dest, data);
                  }
                } catch (err) {
                  if (err && typeof err === "object" && "message" in err && /cancel/i.test(String((err as Error).message))) return;
                  console.warn("[ActorChatPanel] File save failed:", err);
                }
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 transition-colors"
              title="另存为..."
            >
              <FileDown className="w-3 h-3" />
              下载
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Models Hook ──

interface ModelOption {
  id: string;
  name: string;
  model: string;
}

function useAvailableModels(): ModelOption[] {
  const config = useAIStore((s) => s.config);
  const ownKeys = useAIStore((s) => s.ownKeys);
  const { teams, loaded: teamsLoaded, loadTeams } = useTeamStore();
  const [teamModels, setTeamModels] = useState<ModelOption[]>([]);
  const source = config.source || "own_key";

  useEffect(() => {
    if (source === "team" && !teamsLoaded) void loadTeams();
  }, [source, teamsLoaded, loadTeams]);

  useEffect(() => {
    if (source !== "team" || !config.team_id) { setTeamModels([]); return; }
    if (!teamsLoaded || !teams.some((t) => t.id === config.team_id)) return;
    let cancelled = false;
    api
      .get<{ models: { config_id: string; display_name: string; model_name: string }[] }>(
        `/teams/${config.team_id}/ai-models`,
      )
      .then((res) => {
        if (!cancelled) {
          primeTeamModelCache(config.team_id!, res.models || []);
          setTeamModels((res.models || []).map((m) => ({ id: m.config_id, name: m.display_name, model: m.model_name })));
        }
      })
      .catch((err) => { if (!cancelled) { console.warn("[ActorChatPanel] Failed to load team models:", err); setTeamModels([]); } });
    return () => { cancelled = true; };
  }, [source, config.team_id, teamsLoaded, teams]);

  if (source === "team") return teamModels;
  return ownKeys.map((k) => ({ id: k.id, name: k.name, model: k.model }));
}

// ── Message Bubble ──

interface MessageBubbleProps {
  message: DialogMessage;
  actorIndex: number;
  actorName: string;
  targetName?: string;
  isUser: boolean;
  isWaitingReply?: boolean;
  pendingInteraction?: PendingInteraction;
  onReplyToInteraction?: (messageId: string, content: string) => void;
  onOpenApprovalDrawer?: (messageId: string) => void;
}

function ApprovalRequestCard({
  message,
  pendingInteraction,
  onOpenApprovalDrawer,
}: {
  message: DialogMessage;
  pendingInteraction?: PendingInteraction;
  onOpenApprovalDrawer?: (messageId: string) => void;
}) {
  const approval = pendingInteraction?.approvalRequest ?? message.approvalRequest;

  if (!approval) return null;

  const detailItems = (approval.details ?? []).slice(0, 3);
  const hasPreview = Boolean(approval.preview?.trim());
  const status = pendingInteraction?.status ?? message.interactionStatus;
  const canRespond = status === "pending" && Boolean(pendingInteraction);
  const isStalePending = status === "pending" && !pendingInteraction;
  const fileName = approval.targetPath ? basename(approval.targetPath) : "";
  const directory = approval.targetPath ? dirname(approval.targetPath) : "";
  const statusLabel = isStalePending ? "需重新发起" : getInteractionStatusLabel(status);

  return (
    <div className="w-[min(100%,620px)] rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 via-[var(--color-bg)] to-[var(--color-bg-secondary)] overflow-hidden shadow-sm">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="w-9 h-9 rounded-2xl bg-amber-500/15 text-amber-600 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--color-text)]">
              {approval.title}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700">
              {statusLabel}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
              {approval.toolName}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-text)]">
            {approval.summary}
          </p>
          {approval.riskDescription && (
            <p className="mt-1 text-[11px] text-amber-700/90">
              风险：{approval.riskDescription}
            </p>
          )}
          {approval.cacheScopeSummary && (
            <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
              记住范围：{approval.cacheScopeSummary}
            </p>
          )}
        </div>
      </div>

      <div className="px-4 pb-4 space-y-3">
        {approval.targetPath && (
          <div className="rounded-xl border border-[var(--color-border)]/70 bg-[var(--color-bg)]/70 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
              目标位置
            </div>
            <div className="mt-1 text-[13px] font-medium text-[var(--color-text)] break-all">
              {fileName || approval.targetPath}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)] break-all">
              {directory || approval.targetPath}
            </div>
          </div>
        )}

        {detailItems.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-3">
            {detailItems.map((detail) => (
              <div key={`${detail.label}-${detail.value}`} className="min-w-0 rounded-xl border border-[var(--color-border)]/70 bg-[var(--color-bg)]/60 px-3 py-2">
                <div className="text-[10px] text-[var(--color-text-tertiary)]">
                  {detail.label}
                </div>
                <div className={`mt-1 text-[12px] text-[var(--color-text)] break-all ${detail.mono ? "font-mono" : ""}`}>
                  {detail.value}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/15 bg-[var(--color-bg)]/55 px-3 py-2.5">
          <div className="text-[11px] text-[var(--color-text-secondary)]">
            {canRespond
              ? hasPreview
                ? "代码和操作按钮已移到右侧审批面板，阅读空间更大。"
                : "详情和操作按钮已移到右侧审批面板。"
              : isStalePending
                ? "这条审批来自历史会话，可查看详情。"
                : status === "timed_out"
                  ? "审批已超时，可查看详情后让 Agent 重新发起。"
                  : "可查看本次审批详情。"}
          </div>
          <button
            onClick={() => onOpenApprovalDrawer?.(message.id)}
            className="px-3 py-1.5 rounded-xl text-[12px] font-medium border border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 transition-colors"
          >
            {canRespond ? "查看并审批" : "查看详情"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ApprovalRequestDrawer({
  message,
  pendingInteraction,
  actorName,
  onClose,
  onReplyToInteraction,
}: {
  message: DialogMessage;
  pendingInteraction?: PendingInteraction;
  actorName: string;
  onClose: () => void;
  onReplyToInteraction?: (messageId: string, content: string) => void;
}) {
  const approval = pendingInteraction?.approvalRequest ?? message.approvalRequest;
  const [activeTab, setActiveTab] = useState<"overview" | "preview" | "full">("overview");

  useEffect(() => {
    setActiveTab("overview");
  }, [message.id]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!approval) return null;

  const detailItems = approval.details ?? [];
  const status = pendingInteraction?.status ?? message.interactionStatus;
  const canRespond = status === "pending" && Boolean(pendingInteraction && onReplyToInteraction);
  const isStalePending = status === "pending" && !pendingInteraction;
  const fullContent = approval.fullContent ?? approval.preview ?? "";
  const fileName = approval.targetPath ? basename(approval.targetPath) : "";
  const directory = approval.targetPath ? dirname(approval.targetPath) : "";
  const statusLabel = isStalePending ? "需重新发起" : getInteractionStatusLabel(status);
  const approvalActions = getApprovalActions(approval);
  const tabs: Array<{ key: "overview" | "preview" | "full"; label: string }> = [
    { key: "overview", label: "概览" },
    { key: "preview", label: approval.previewLabel ?? "代码预览" },
    { key: "full", label: "完整内容" },
  ];

  return (
    <>
      <div className="absolute inset-0 bg-black/25 z-40" onClick={onClose} />
      <div className="absolute inset-3 z-50 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl overflow-hidden flex flex-col md:inset-y-3 md:right-3 md:left-auto md:w-[min(78vw,880px)]">
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/12 text-amber-600 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold text-[var(--color-text)]">
                  {approval.title}
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700">
                  {statusLabel}
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
                  {approval.toolName}
                </span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-text)]">
                {approval.summary}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--color-text-secondary)]">
                <span>发起者：{actorName}</span>
                {approval.targetPath && <span className="truncate max-w-full">目标：{approval.targetPath}</span>}
              </div>
              {approval.riskDescription && (
                <p className="mt-1 text-[11px] text-amber-700/90">
                  风险：{approval.riskDescription}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-1.5 rounded-xl text-[12px] font-medium transition-colors ${
                  activeTab === tab.key
                    ? "bg-[var(--color-accent)]/12 text-[var(--color-accent)] border border-[var(--color-accent)]/20"
                    : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] border border-transparent hover:text-[var(--color-text)]"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 bg-[var(--color-bg-secondary)]/35">
          {activeTab === "overview" && (
            <div className="space-y-4">
              {approval.targetPath && (
                <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    目标位置
                  </div>
                  <div className="mt-2 text-[15px] font-semibold text-[var(--color-text)] break-all">
                    {fileName || approval.targetPath}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--color-text-secondary)] break-all font-mono">
                    {directory || approval.targetPath}
                  </div>
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {detailItems.map((detail) => (
                  <div key={`${detail.label}-${detail.value}`} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                    <div className="text-[11px] text-[var(--color-text-tertiary)]">
                      {detail.label}
                    </div>
                    <div className={`mt-2 text-[13px] leading-relaxed text-[var(--color-text)] break-all ${detail.mono ? "font-mono" : ""}`}>
                      {detail.value}
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4">
                <div className="text-[12px] font-medium text-amber-800">
                  审批说明
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-amber-900/80">
                  {canRespond
                    ? "代码内容和审批按钮已固定在右侧面板里，阅读时不再受聊天区域宽度限制。"
                    : isStalePending
                      ? "这是历史审批记录，当前无法直接执行，但你仍然可以查看当时的内容。"
                      : status === "timed_out"
                        ? "这次审批已经超时，如需继续请让 Agent 重新发起。"
                        : "这次审批已经处理完成，下面保留的是本次操作详情。"}
                </p>
              </div>
            </div>
          )}

          {activeTab === "preview" && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[#0f172a] text-[#e5e7eb] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/10 text-[11px] flex items-center justify-between">
                <span>{approval.previewLabel ?? "代码预览"}</span>
                {approval.previewTruncated && (
                  <span className="text-[#94a3b8]">当前展示的是截断预览</span>
                )}
              </div>
              <pre className="p-4 text-[12px] leading-[1.7] overflow-auto whitespace-pre-wrap break-words font-mono min-h-[360px] max-h-[calc(100vh-22rem)]">
                {approval.preview || "暂无预览内容"}
              </pre>
            </div>
          )}

          {activeTab === "full" && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[#0b1120] text-[#e2e8f0] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/10 text-[11px] flex items-center justify-between">
                <span>完整内容</span>
                <span className="text-[#94a3b8]">
                  {fullContent ? `${fullContent.length} 字符` : "暂无内容"}
                </span>
              </div>
              <pre className="p-4 text-[12px] leading-[1.7] overflow-auto whitespace-pre-wrap break-words font-mono min-h-[420px] max-h-[calc(100vh-22rem)]">
                {fullContent || approval.preview || "暂无内容"}
              </pre>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[var(--color-border)] bg-[var(--color-bg)]/96 backdrop-blur-sm">
          {canRespond ? (
            <div className="flex flex-wrap items-center gap-2">
              {approvalActions.map((option) => (
                <button
                  key={option.label}
                  onClick={() => onReplyToInteraction?.(message.id, option.label)}
                  className={`px-4 py-2 rounded-xl text-[13px] font-medium transition-colors ${getApprovalActionClass(option)}`}
                  title={option.description}
                >
                  {option.label}
                </button>
              ))}
              <div className="text-[11px] text-[var(--color-text-tertiary)] md:ml-auto">
                {approval.cacheScopeSummary
                  ? `也可以直接在输入框回复这些选项，记住范围：${approval.cacheScopeSummary}`
                  : "也可以直接在输入框回复审批选项"}
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-[var(--color-text-secondary)]">
              {isStalePending
                ? "这条审批来自历史会话，当前不能直接执行。"
                : status === "timed_out"
                  ? "审批已超时，可让 Agent 重新发起。"
                  : "审批已结束。"}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function MessageBubbleBase({
  message,
  actorIndex,
  actorName,
  targetName,
  isUser,
  isWaitingReply,
  pendingInteraction,
  onReplyToInteraction,
  onOpenApprovalDrawer,
}: MessageBubbleProps) {
  const [showFullContext, setShowFullContext] = useState(false);
  const color = isUser ? null : getActorColor(actorIndex);
  const approvalResponseText = message.kind === "approval_response"
    ? formatApprovalResponse(message.content)
    : null;
  const hasBrief = !approvalResponseText && isUser && !!message._briefContent && message._briefContent !== message.content;
  const displayText = approvalResponseText ?? (hasBrief && !showFullContext ? message._briefContent! : message.content);
  const isStructuredApproval = message.kind === "approval_request" && !!message.approvalRequest;
  const bubbleClassName = isStructuredApproval
    ? "bg-transparent p-0 rounded-none shadow-none"
    : isUser
      ? "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
      : `${color!.bg} text-[var(--color-text)]`;
  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse justify-start" : ""}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
        isUser
          ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          : `${color!.bg} ${color!.text}`
      }`}>
        {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
      </div>
      <div className={`max-w-[80%] min-w-0 ${isUser ? "flex flex-col items-end text-right" : ""}`}>
        <div className={`text-[10px] mb-0.5 ${isUser ? "text-[var(--color-accent)]" : color!.text}`}>
          {actorName}
          {targetName && (
            <span className="text-[var(--color-text-tertiary)] ml-1">
              → {targetName}
            </span>
          )}
          <span className="text-[var(--color-text-tertiary)] ml-1">
            {new Date(message.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
        <div className={`inline-block w-fit text-[13px] leading-relaxed max-w-full ${bubbleClassName} ${isStructuredApproval ? "" : "rounded-xl px-3 py-2"}`}>
          {!isStructuredApproval && message.images && message.images.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-1.5">
              {message.images.map((imgPath: string, i: number) => (
                <ChatImage
                  key={i}
                  path={imgPath}
                  className="max-w-[200px] max-h-[200px] object-cover rounded-lg cursor-zoom-in hover:opacity-90 transition-opacity"
                />
              ))}
            </div>
          )}
          {isStructuredApproval ? (
            <ApprovalRequestCard
              message={message}
              pendingInteraction={pendingInteraction}
              onOpenApprovalDrawer={onOpenApprovalDrawer}
            />
          ) : (
            <>
              <div className={`prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_code]:break-words ${isUser ? "[&_p]:text-right [&_li]:text-right [&_ol]:text-right [&_ul]:text-right" : ""}`}>
                <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                  {displayText}
                </ReactMarkdown>
              </div>
              {hasBrief && (
                <button
                  onClick={() => setShowFullContext((v) => !v)}
                  className="mt-1 text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] flex items-center gap-0.5 ml-auto transition-colors"
                >
                  <ChevronDown className={`w-3 h-3 transition-transform ${showFullContext ? "rotate-180" : ""}`} />
                  {showFullContext ? "收起上下文" : "查看完整上下文"}
                </button>
              )}
              {!isUser && message.kind !== "approval_request" && <FileActionButtons content={message.content} />}
            </>
          )}
        </div>
        {isWaitingReply && !isStructuredApproval && (
          <div className="flex items-center gap-1 mt-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 animate-pulse">
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
            等待你的回复...
          </div>
        )}
      </div>
    </div>
  );
}

const MessageBubble = React.memo(
  MessageBubbleBase,
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message._briefContent === next.message._briefContent &&
    prev.message.images === next.message.images &&
    prev.message.timestamp === next.message.timestamp &&
    prev.actorIndex === next.actorIndex &&
    prev.actorName === next.actorName &&
    prev.targetName === next.targetName &&
    prev.isUser === next.isUser &&
    prev.isWaitingReply === next.isWaitingReply &&
    prev.pendingInteraction?.id === next.pendingInteraction?.id &&
    prev.pendingInteraction?.status === next.pendingInteraction?.status &&
    prev.onReplyToInteraction === next.onReplyToInteraction &&
    prev.onOpenApprovalDrawer === next.onOpenApprovalDrawer,
);

// ── Capability Badge ──

const CAPABILITY_LABELS: Record<string, { label: string; color: string }> = {
  coordinator: { label: "协调", color: "bg-blue-500/20 text-blue-600" },
  code_review: { label: "Review", color: "bg-green-500/20 text-green-600" },
  code_write: { label: "编写", color: "bg-emerald-500/20 text-emerald-600" },
  code_analysis: { label: "分析", color: "bg-teal-500/20 text-teal-600" },
  security: { label: "安全", color: "bg-red-500/20 text-red-600" },
  performance: { label: "性能", color: "bg-orange-500/20 text-orange-600" },
  architecture: { label: "架构", color: "bg-purple-500/20 text-purple-600" },
  debugging: { label: "调试", color: "bg-rose-500/20 text-rose-600" },
  research: { label: "调研", color: "bg-cyan-500/20 text-cyan-600" },
  documentation: { label: "文档", color: "bg-slate-500/20 text-slate-600" },
  testing: { label: "测试", color: "bg-indigo-500/20 text-indigo-600" },
  devops: { label: "DevOps", color: "bg-amber-500/20 text-amber-600" },
  data_analysis: { label: "数据", color: "bg-pink-500/20 text-pink-600" },
  creative: { label: "创意", color: "bg-violet-500/20 text-violet-600" },
  synthesis: { label: "整合", color: "bg-cyan-500/20 text-cyan-600" },
};

function CapabilityBadges({ tags }: { tags?: AgentCapability[] }) {
  if (!tags?.length) return null;
  return (
    <div className="flex items-center gap-0.5 ml-1">
      {tags.slice(0, 3).map((tag) => {
        const info = CAPABILITY_LABELS[tag];
        return (
          <span
            key={tag}
            className={`text-[8px] px-1 rounded-full ${info?.color ?? "bg-gray-500/20 text-gray-600"}`}
            title={tag}
          >
            {info?.label ?? tag}
          </span>
        );
      })}
      {tags.length > 3 && (
        <span className="text-[8px] text-gray-400">+{tags.length - 3}</span>
      )}
    </div>
  );
}

// ── Status Bar ──

function ActorStatusBar({ actors }: { actors: ActorSnapshot[] }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {actors.map((actor, i) => {
        const color = getActorColor(i);
        const isThinking = actor.status === "running";
        return (
          <div
            key={actor.id}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] ${color.bg} ${color.text}`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${color.dot} ${isThinking ? "animate-pulse" : ""}`} />
            <span className="font-medium">{actor.roleName}</span>
            <CapabilityBadges tags={actor.capabilities?.tags} />
            {actor.modelOverride && (
              <span className="opacity-60 max-w-[80px] truncate">{actor.modelOverride}</span>
            )}
            {isThinking && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
            {actor.pendingInbox > 0 && (
              <span className="bg-red-500 text-white text-[8px] w-3.5 h-3.5 rounded-full flex items-center justify-center">
                {actor.pendingInbox}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── @ Mention Popup ──

function MentionPopup({
  actors,
  filter,
  onSelect,
  onClose,
}: {
  actors: ActorSnapshot[];
  filter: string;
  onSelect: (name: string) => void;
  onClose: () => void;
}) {
  const filtered = actors.filter((a) =>
    a.roleName.toLowerCase().includes(filter.toLowerCase()),
  );

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full mb-1 left-0 w-48 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50">
      <div className="py-1 max-h-[150px] overflow-y-auto">
        {filtered.map((a, i) => {
          const color = getActorColor(i);
          return (
            <button
              key={a.id}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors text-left"
              onMouseDown={(e) => { e.preventDefault(); onSelect(a.roleName); }}
            >
              <div className={`w-2 h-2 rounded-full ${color.dot}`} />
              <span>{a.roleName}</span>
              {a.status === "running" && <Loader2 className="w-2.5 h-2.5 animate-spin opacity-50" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Live Actor Config Row (for settings panel) ──

function LiveActorRow({
  actor,
  index,
  onRemove,
}: {
  actor: ActorSnapshot;
  index: number;
  onRemove: () => void;
}) {
  const color = getActorColor(index);
  const isRunning = actor.status === "running";
  return (
    <div className={`p-2 rounded-lg border ${color.border} ${color.bg}`}>
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${color.dot} ${isRunning ? "animate-pulse" : ""} shrink-0`} />
        <span className="text-[11px] font-medium min-w-[60px]">{actor.roleName}</span>
        <span className="text-[10px] text-[var(--color-text-tertiary)] truncate max-w-[140px]">
          {actor.modelOverride || "(默认模型)"}
        </span>
        <div className="flex-1" />
        {isRunning && <Loader2 className="w-3 h-3 animate-spin opacity-50" />}
        <button
          onClick={onRemove}
          disabled={isRunning}
          className="p-0.5 rounded hover:bg-red-500/10 text-[var(--color-text-tertiary)] hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
          title={isRunning ? "运行中，无法移除" : "移除此 Agent"}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
          {summarizeToolPolicy(actor.toolPolicy)}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
          {summarizeMiddleware(actor.middlewareOverrides)}
        </span>
        {actor.workspace && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
            工作区 {actor.workspace}
          </span>
        )}
        {actor.thinkingLevel && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
            思考 {actor.thinkingLevel}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Add Agent Inline Form ──

const ALL_CAPABILITIES: { value: AgentCapability; label: string }[] = [
  { value: "coordinator", label: "协调者" },
  { value: "code_review", label: "代码审查" },
  { value: "code_write", label: "代码编写" },
  { value: "code_analysis", label: "代码分析" },
  { value: "security", label: "安全评估" },
  { value: "performance", label: "性能优化" },
  { value: "architecture", label: "架构设计" },
  { value: "debugging", label: "调试排错" },
  { value: "research", label: "调研搜索" },
  { value: "documentation", label: "文档撰写" },
  { value: "testing", label: "测试编写" },
  { value: "devops", label: "DevOps" },
  { value: "data_analysis", label: "数据分析" },
  { value: "creative", label: "创意头脑风暴" },
  { value: "synthesis", label: "综合整合" },
];

const AGENT_CAPABILITY_SET = new Set<AgentCapability>(ALL_CAPABILITIES.map((c) => c.value));
const APPROVAL_LEVELS: ApprovalLevel[] = ["normal", "permissive", "strict", "off"];
const THINKING_LEVELS: ThinkingLevel[] = ["adaptive", "minimal", "low", "medium", "high", "xhigh", "off"];

function normalizeAgentCapabilities(tags?: string[]): AgentCapability[] | undefined {
  if (!tags?.length) return undefined;
  const normalized = tags.filter((tag): tag is AgentCapability =>
    AGENT_CAPABILITY_SET.has(tag as AgentCapability),
  );
  return normalized.length ? normalized : undefined;
}

interface AddActorDraft {
  name: string;
  model: string;
  capabilities?: AgentCapabilities;
  workspace?: string;
  toolPolicy?: ToolPolicy;
  middlewareOverrides?: MiddlewareOverrides;
  thinkingLevel?: ThinkingLevel;
}

function AddAgentForm({
  models,
  existingNames,
  onAdd,
}: {
  models: ModelOption[];
  existingNames: string[];
  onAdd: (draft: AddActorDraft) => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [selectedCaps, setSelectedCaps] = useState<AgentCapability[]>([]);
  const [showCapMenu, setShowCapMenu] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [toolAllow, setToolAllow] = useState("");
  const [toolDeny, setToolDeny] = useState("");
  const [approvalLevel, setApprovalLevel] = useState<ApprovalLevel>("normal");
  const [disabledMiddlewares, setDisabledMiddlewares] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("adaptive");

  const handleAdd = () => {
    const trimmed = name.trim();
    let agentName = trimmed;

    // 如果未填写名称，则根据现有 Agent 生成不重名的默认名称：Agent 1, Agent 2, ...
    if (!agentName) {
      const taken = new Set(existingNames);
      let index = 1;
      while (taken.has(`Agent ${index}`)) {
        index += 1;
      }
      agentName = `Agent ${index}`;
    }

    const capabilities = selectedCaps.length > 0 ? { tags: selectedCaps } : undefined;
    const allow = toolAllow.split(",").map((item) => item.trim()).filter(Boolean);
    const deny = toolDeny.split(",").map((item) => item.trim()).filter(Boolean);
    const disabled = disabledMiddlewares.split(",").map((item) => item.trim()).filter(Boolean);
    onAdd({
      name: agentName,
      model,
      capabilities,
      workspace: workspace.trim() || undefined,
      toolPolicy: allow.length > 0 || deny.length > 0
        ? {
            allow: allow.length > 0 ? allow : undefined,
            deny: deny.length > 0 ? deny : undefined,
          }
        : undefined,
      middlewareOverrides: approvalLevel !== "normal" || disabled.length > 0
        ? {
            approvalLevel,
            disable: disabled.length > 0 ? disabled : undefined,
          }
        : undefined,
      thinkingLevel: thinkingLevel !== "adaptive" ? thinkingLevel : undefined,
    });
    setName("");
    setModel("");
    setSelectedCaps([]);
    setWorkspace("");
    setToolAllow("");
    setToolDeny("");
    setApprovalLevel("normal");
    setDisabledMiddlewares("");
    setThinkingLevel("adaptive");
  };

  const toggleCap = (cap: AgentCapability) => {
    setSelectedCaps((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]
    );
  };

  return (
    <div className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名称 (可选)"
          className="text-[11px] px-1.5 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] w-[100px]"
        />
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="text-[11px] px-1.5 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] min-w-[120px] max-w-[180px]"
        >
          <option value="">(默认模型)</option>
          {models.map((m) => (
            <option key={m.id} value={m.model}>{m.name}</option>
          ))}
        </select>
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowCapMenu(!showCapMenu)}
            className="text-[11px] px-1.5 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] flex items-center gap-1 hover:bg-[var(--color-bg-hover)]"
          >
            <span className="text-[var(--color-text-tertiary)]">能力:</span>
            {selectedCaps.length > 0 ? (
              <span className="text-[var(--color-accent)]">{selectedCaps.length}</span>
            ) : (
              <span className="text-[var(--color-text-tertiary)]">选择</span>
            )}
          </button>
          {showCapMenu && (
            <div className="absolute top-full mt-1 left-0 w-48 max-h-32 overflow-auto bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl z-50 p-1">
              {ALL_CAPABILITIES.map((cap) => (
                <label
                  key={cap.value}
                  className="flex items-center gap-1.5 px-2 py-1 text-[10px] hover:bg-[var(--color-bg-hover)] cursor-pointer rounded"
                >
                  <input
                    type="checkbox"
                    checked={selectedCaps.includes(cap.value)}
                    onChange={() => toggleCap(cap.value)}
                    className="w-3 h-3 rounded"
                  />
                  <span>{cap.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          className="text-[11px] px-1.5 py-1 rounded border border-dashed border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]/40"
        >
          {showAdvanced ? "收起高级" : "高级配置"}
        </button>
        <button
          onClick={handleAdd}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
        >
          <Plus className="w-3 h-3" /> 添加
        </button>
      </div>
      {showAdvanced && (
        <div className="grid gap-2 md:grid-cols-2">
          <input
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder="工作目录，如 /project/root"
            className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <select
            value={approvalLevel}
            onChange={(e) => setApprovalLevel(e.target.value as ApprovalLevel)}
            className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            {APPROVAL_LEVELS.map((level) => (
              <option key={level} value={level}>
                审批 {level}
              </option>
            ))}
          </select>
          <input
            value={toolAllow}
            onChange={(e) => setToolAllow(e.target.value)}
            placeholder="允许工具，逗号分隔"
            className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <input
            value={toolDeny}
            onChange={(e) => setToolDeny(e.target.value)}
            placeholder="禁止工具，逗号分隔"
            className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <input
            value={disabledMiddlewares}
            onChange={(e) => setDisabledMiddlewares(e.target.value)}
            placeholder="关闭中间件，逗号分隔"
            className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <select
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                思考 {level}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// ── Routing Mode Button ──

const ROUTING_MODES = [
  { value: "coordinator" as const, icon: "👤", label: "协调", desc: "消息发给当前协调者 Agent" },
  { value: "smart" as const, icon: "⚡", label: "智能", desc: "自动选择最合适的 Agent" },
  { value: "broadcast" as const, icon: "📢", label: "广播", desc: "消息发送给所有 Agent" },
];

function RoutingModeButton({
  value,
  onChange,
}: {
  value: "coordinator" | "smart" | "broadcast";
  onChange: (v: "coordinator" | "smart" | "broadcast") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = ROUTING_MODES.find((m) => m.value === value) ?? ROUTING_MODES[0];

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <span>{current.icon}</span>
        <span>{current.label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-52 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50">
          <div className="py-1">
            {ROUTING_MODES.map((mode) => (
              <button
                key={mode.value}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--color-bg-hover)] transition-colors text-left ${
                  mode.value === value ? "bg-[var(--color-accent)]/5 text-[var(--color-accent)]" : ""
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(mode.value);
                  setOpen(false);
                }}
              >
                <span className="text-sm">{mode.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{mode.label}</div>
                  <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">{mode.desc}</div>
                </div>
                {mode.value === value && (
                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] shrink-0" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ArtifactPathActions({ filePath, available }: { filePath: string; available: boolean }) {
  const fileName = basename(filePath);

  if (!available) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => {
          void invoke("open_file_location", { filePath });
        }}
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
      >
        <FolderOpen className="w-3 h-3" />
        打开位置
      </button>
      <button
        onClick={async () => {
          try {
            const { save } = await import("@tauri-apps/plugin-dialog");
            const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
            const dest = await save({ defaultPath: fileName });
            if (dest) {
              const data = await readFile(filePath);
              await writeFile(dest, data);
            }
          } catch (err) {
            if (err && typeof err === "object" && "message" in err && /cancel/i.test(String((err as Error).message))) return;
            console.warn("[ActorChatPanel] File save failed:", err);
          }
        }}
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-accent)]/10 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 transition-colors"
      >
        <FileDown className="w-3 h-3" />
        下载
      </button>
    </div>
  );
}

function DialogWorkspaceDock({
  panel,
  onPanelChange,
  actors,
  actorTodos,
  dialogHistory,
  artifacts,
  sessionUploads,
  spawnedTasks,
  selectedRunId,
  onSelectRunId,
  focusedSessionRunId,
  onFocusSession,
  onCloseSession,
  draftPlan,
  requirePlanApproval,
  onTogglePlanApproval,
  lastPlanReview,
}: {
  panel: WorkspacePanel;
  onPanelChange: (panel: WorkspacePanel) => void;
  actors: ActorSnapshot[];
  actorTodos: Record<string, Array<{ id: string; title: string; status: string; priority: string; notes?: string; updatedAt: number }>>;
  dialogHistory: DialogMessage[];
  artifacts: DialogArtifact[];
  sessionUploads: SessionUploadRecord[];
  spawnedTasks: SpawnedTaskRecord[];
  selectedRunId: string | null;
  onSelectRunId: (runId: string) => void;
  focusedSessionRunId: string | null;
  onFocusSession: (runId: string | null) => void;
  onCloseSession: (runId: string) => void;
  draftPlan: ClusterPlan | null;
  requirePlanApproval: boolean;
  onTogglePlanApproval: (value: boolean) => void;
  lastPlanReview: { status: "approved" | "rejected"; timestamp: number; plan: ClusterPlan } | null;
}) {
  const actorById = useMemo(() => {
    const map = new Map<string, ActorSnapshot>();
    actors.forEach((actor) => map.set(actor.id, actor));
    return map;
  }, [actors]);

  const sortedTasks = useMemo(() => {
    return [...spawnedTasks].sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return b.spawnedAt - a.spawnedAt;
    });
  }, [spawnedTasks]);

  const selectedTask = useMemo(() => {
    if (sortedTasks.length === 0) return null;
    return sortedTasks.find((task) => task.runId === selectedRunId) ?? sortedTasks[0];
  }, [sortedTasks, selectedRunId]);

  const selectedTaskTranscript = useMemo(() => {
    return collectTaskTranscript({
      task: selectedTask,
      actorById,
      dialogHistory,
    });
  }, [actorById, dialogHistory, selectedTask]);

  const [artifactAvailabilityByPath, setArtifactAvailabilityByPath] = useState<Record<string, ArtifactAvailability>>({});

  useEffect(() => {
    if (panel !== "artifacts") return;
    if (artifacts.length === 0) {
      setArtifactAvailabilityByPath({});
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const { exists } = await import("@tauri-apps/plugin-fs");
        const entries = await Promise.all(
          artifacts.map(async (artifact) => [
            artifact.path,
            (await exists(artifact.path)) ? "ready" : "missing",
          ] as const),
        );
        if (!cancelled) {
          setArtifactAvailabilityByPath(Object.fromEntries(entries));
        }
      } catch (error) {
        console.warn("[ActorChatPanel] Failed to verify artifact existence:", error);
        if (!cancelled) {
          setArtifactAvailabilityByPath(
            Object.fromEntries(artifacts.map((artifact) => [artifact.path, "unknown" as ArtifactAvailability])),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [panel, artifacts]);

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-1 px-4 pt-3">
        {[
          { id: "todos" as const, label: "Todo", icon: <ListChecks className="w-3.5 h-3.5" /> },
          { id: "artifacts" as const, label: "Artifacts", icon: <FileDown className="w-3.5 h-3.5" /> },
          { id: "uploads" as const, label: "Uploads", icon: <FolderOpen className="w-3.5 h-3.5" /> },
          { id: "subtasks" as const, label: "Subtasks", icon: <Network className="w-3.5 h-3.5" /> },
          { id: "plan" as const, label: "Plan", icon: <ShieldCheck className="w-3.5 h-3.5" /> },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => onPanelChange(panel === tab.id ? null : tab.id)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-t-lg border border-b-0 transition-colors ${
              panel === tab.id
                ? "bg-[var(--color-bg)] text-[var(--color-text)] border-[var(--color-border)]"
                : "text-[var(--color-text-tertiary)] border-transparent hover:text-[var(--color-text-secondary)]"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {panel && (
        <div className="mx-4 mb-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] max-h-[320px] overflow-auto">
        {panel === "todos" && (
          <div className="p-4 space-y-3">
            {actors.map((actor) => {
              const todos = actorTodos[actor.id] ?? [];
              const activeTodos = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
              return (
                <div key={actor.id} className="rounded-xl border border-[var(--color-border)]/80 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-medium text-[var(--color-text)]">{actor.roleName}</div>
                    <div className="text-[10px] text-[var(--color-text-tertiary)]">
                      活跃 {activeTodos.length} / 全部 {todos.length}
                    </div>
                  </div>
                  {todos.length === 0 ? (
                    <div className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">当前没有待办。</div>
                  ) : (
                    <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {todos
                        .slice()
                        .sort((a, b) => b.updatedAt - a.updatedAt)
                        .map((todo) => (
                          <div key={todo.id} className="rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/70 px-2.5 py-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-medium text-[var(--color-text)]">{todo.title}</span>
                              <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">{todo.priority}</span>
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
                              <span>{todo.status}</span>
                              <span>更新于 {formatShortTime(todo.updatedAt)}</span>
                            </div>
                            {todo.notes && (
                              <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{todo.notes}</div>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {panel === "artifacts" && (
          <div className="p-4 space-y-3">
            {artifacts.length === 0 ? (
              <div className="text-[12px] text-[var(--color-text-tertiary)]">当前还没有检测到文件产物。</div>
            ) : (
              artifacts.map((artifact) => (
                <div key={artifact.id} className="rounded-xl border border-[var(--color-border)]/80 p-3">
                  {(() => {
                    const sourceMeta = getArtifactSourceMeta(artifact.source);
                    const availability = artifactAvailabilityByPath[artifact.path] ?? "unknown";
                    const availabilityLabel = availability === "ready"
                      ? "已落盘"
                      : availability === "missing"
                        ? (artifact.source === "approval" ? "未落盘" : "文件缺失")
                        : "未验证";
                    const availabilityClass = availability === "ready"
                      ? "bg-emerald-500/10 text-emerald-700"
                      : availability === "missing"
                        ? "bg-amber-500/10 text-amber-700"
                        : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]";

                    return (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-[12px] font-medium text-[var(--color-text)]">{artifact.fileName}</div>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${sourceMeta.className}`}>
                            {sourceMeta.label}
                          </span>
                          {artifact.relatedRunId && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600">
                              子会话产物
                            </span>
                          )}
                          {artifact.toolName && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
                              {artifact.toolName}
                            </span>
                          )}
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${availabilityClass}`}>
                            {availabilityLabel}
                          </span>
                          <span className="text-[10px] text-[var(--color-text-tertiary)]">
                            {artifact.actorName} · {formatShortTime(artifact.timestamp)}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--color-text-secondary)] break-all">
                          {artifact.path}
                        </div>
                        <div className="mt-2 text-[11px] text-[var(--color-text-secondary)]">{artifact.summary}</div>
                        {availability !== "ready" && (
                          <div className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
                            {availability === "missing"
                              ? sourceMeta.missingHint
                              : "当前环境无法确认该文件是否已存在。"}
                          </div>
                        )}
                        <div className="mt-3">
                          <ArtifactPathActions filePath={artifact.path} available={availability === "ready"} />
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        )}

        {panel === "uploads" && (
          <div className="p-4 space-y-3">
            {sessionUploads.length === 0 ? (
              <div className="text-[12px] text-[var(--color-text-tertiary)]">当前会话里还没有登记过上传文件。</div>
            ) : (
              sessionUploads.map((upload) => (
                <div key={upload.id} className="rounded-xl border border-[var(--color-border)]/80 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-[12px] font-medium text-[var(--color-text)]">{upload.name}</div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
                      {upload.type}
                    </span>
                    <span className="text-[10px] text-[var(--color-text-tertiary)]">
                      {formatShortTime(upload.addedAt)}
                    </span>
                  </div>
                  {upload.path ? (
                    <div className="mt-1 text-[11px] text-[var(--color-text-secondary)] break-all">{upload.path}</div>
                  ) : (
                    <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">该上传项来自临时附件，当前没有可再次读取的物理路径。</div>
                  )}
                  {upload.excerpt && (
                    <div className="mt-2 rounded-lg bg-[var(--color-bg-secondary)]/70 px-3 py-2 text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-words max-h-[100px] overflow-auto">
                      {upload.excerpt}
                    </div>
                  )}
                  {upload.path && (
                    <div className="mt-3">
                      <ArtifactPathActions filePath={upload.path} available />
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {panel === "subtasks" && (
          <div className="p-4">
            {sortedTasks.length === 0 ? (
              <div className="text-[12px] text-[var(--color-text-tertiary)]">还没有 spawn_task 记录。</div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
                <div className="space-y-2">
                  {sortedTasks.map((task) => {
                    const spawner = actorById.get(task.spawnerActorId)?.roleName ?? task.spawnerActorId;
                    const target = actorById.get(task.targetActorId)?.roleName ?? task.targetActorId;
                    return (
                      <button
                        key={task.runId}
                        onClick={() => onSelectRunId(task.runId)}
                        className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${
                          selectedTask?.runId === task.runId
                            ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5"
                            : "border-[var(--color-border)] hover:border-[var(--color-accent)]/30"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-medium text-[var(--color-text)] truncate">
                            {task.label || task.task.slice(0, 24)}
                          </span>
                          {task.mode === "session" && task.sessionOpen && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600">
                              子会话
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">{task.status}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-[var(--color-text-secondary)] truncate">
                          {spawner} → {target}
                        </div>
                        <div className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">
                          {formatShortTime(task.spawnedAt)}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {selectedTask && (
                  <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-[13px] font-medium text-[var(--color-text)]">
                        {selectedTask.label || selectedTask.task.slice(0, 32)}
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
                        {selectedTask.status}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-tertiary)]">
                        持续 {formatElapsedTime((selectedTask.completedAt ?? Date.now()) - selectedTask.spawnedAt)}
                      </span>
                      {selectedTask.mode === "session" && selectedTask.sessionOpen && (
                        <>
                          <button
                            onClick={() => onFocusSession(focusedSessionRunId === selectedTask.runId ? null : selectedTask.runId)}
                            className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                              focusedSessionRunId === selectedTask.runId
                                ? "border-blue-500/30 bg-blue-500/10 text-blue-600"
                                : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-blue-500/30 hover:text-blue-600"
                            }`}
                          >
                            {focusedSessionRunId === selectedTask.runId ? "取消聚焦" : "聚焦子会话"}
                          </button>
                          <button
                            onClick={() => onCloseSession(selectedTask.runId)}
                            className="text-[10px] px-2 py-1 rounded-full border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-red-500/30 hover:text-red-600 transition-colors"
                          >
                            关闭会话
                          </button>
                        </>
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-words">
                      {selectedTask.task}
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="rounded-lg bg-[var(--color-bg-secondary)]/70 px-3 py-2">
                        <div className="text-[10px] text-[var(--color-text-tertiary)]">派发者</div>
                        <div className="mt-1 text-[12px] text-[var(--color-text)]">
                          {actorById.get(selectedTask.spawnerActorId)?.roleName ?? selectedTask.spawnerActorId}
                        </div>
                      </div>
                      <div className="rounded-lg bg-[var(--color-bg-secondary)]/70 px-3 py-2">
                        <div className="text-[10px] text-[var(--color-text-tertiary)]">执行者</div>
                        <div className="mt-1 text-[12px] text-[var(--color-text)]">
                          {actorById.get(selectedTask.targetActorId)?.roleName ?? selectedTask.targetActorId}
                        </div>
                      </div>
                    </div>
                    {selectedTask.result && (
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">结果摘要</div>
                        <div className="mt-1 rounded-lg bg-[var(--color-bg-secondary)]/70 px-3 py-2 text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-words max-h-[120px] overflow-auto">
                          {selectedTask.result}
                        </div>
                      </div>
                    )}
                    {selectedTask.error && (
                      <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-600 whitespace-pre-wrap break-words">
                        {selectedTask.error}
                      </div>
                    )}
                    {selectedTask.mode === "session" && selectedTask.sessionOpen && (
                      <div className="rounded-lg border border-blue-500/15 bg-blue-500/5 px-3 py-2 text-[11px] text-blue-700">
                        这个子任务已经提升为可持续交互的子会话。聚焦后，输入框会把后续消息直接发给这个 Agent，而不是发给主协调者。
                      </div>
                    )}
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">子会话视图</div>
                      {selectedTaskTranscript.length === 0 ? (
                        <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">这个子任务还没有可聚焦的会话片段。</div>
                      ) : (
                        <div className="mt-2 space-y-2 max-h-[160px] overflow-auto">
                          {selectedTaskTranscript.map((entry, index) => (
                            <div
                              key={entry.id || `${entry.timestamp}-${index}`}
                              className={`rounded-lg px-3 py-2 ${
                                entry.source === "dialog"
                                  ? "border border-blue-500/15 bg-blue-500/5"
                                  : "bg-[var(--color-bg-secondary)]/70"
                              }`}
                            >
                              <div className="flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-tertiary)]">
                                <span>{entry.label}</span>
                                {entry.kindLabel && (
                                  <span className="px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
                                    {entry.kindLabel}
                                  </span>
                                )}
                                <span>{formatShortTime(entry.timestamp)}</span>
                              </div>
                              <div className="mt-1 text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-words">
                                {entry.content}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {panel === "plan" && (
          <div className="p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[12px] text-[var(--color-text)]">
                <input
                  type="checkbox"
                  checked={requirePlanApproval}
                  onChange={(e) => onTogglePlanApproval(e.target.checked)}
                  className="rounded"
                />
                发送前先审批执行计划
              </label>
              {lastPlanReview && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                  lastPlanReview.status === "approved"
                    ? "bg-emerald-500/10 text-emerald-600"
                    : "bg-red-500/10 text-red-600"
                }`}>
                  最近一次{lastPlanReview.status === "approved" ? "已批准" : "已拒绝"} · {formatShortTime(lastPlanReview.timestamp)}
                </span>
              )}
            </div>
            {draftPlan ? (
              <div className="space-y-2">
                <div className="text-[11px] text-[var(--color-text-secondary)]">
                  当前输入会生成以下 dispatch plan 预览。
                </div>
                {draftPlan.steps.map((step) => (
                  <div key={step.id} className="rounded-xl border border-[var(--color-border)]/80 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium text-[var(--color-text)]">{step.role}</span>
                      <span className="text-[10px] text-[var(--color-text-tertiary)]">{step.id}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{step.task}</div>
                    {step.dependencies.length > 0 && (
                      <div className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">
                        依赖: {step.dependencies.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12px] text-[var(--color-text-tertiary)]">
                输入一条新任务后，这里会显示即将发送给 dialog runtime 的执行计划预览。
              </div>
            )}
          </div>
        )}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ──

export function ActorChatPanel({ active = true }: { active?: boolean }) {
  const [showConfig, setShowConfig] = useState(false);
  const [overlay, setOverlay] = useState<DialogOverlay>(null);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>("todos");
  const [input, setInput] = useState("");
  const [showMention, setShowMention] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [customPresets, setCustomPresets] = useState<DialogPreset[]>([]);
  /** 路由模式：coordinator=只发给第一个，smart=智能路由，broadcast=发给所有 */
  const [routingMode, setRoutingMode] = useState<DialogRoutingMode>("coordinator");
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [selectedPendingMessageId, setSelectedPendingMessageId] = useState<string | null>(null);
  const [openApprovalMessageId, setOpenApprovalMessageId] = useState<string | null>(null);
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  const [selectedSpawnRunId, setSelectedSpawnRunId] = useState<string | null>(null);
  const [requirePlanApproval, setRequirePlanApproval] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DIALOG_PLAN_APPROVAL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [lastPlanReview, setLastPlanReview] = useState<{ status: "approved" | "rejected"; timestamp: number; plan: ClusterPlan } | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initRef = useRef(false);

  const {
    active: systemActive, actors, dialogHistory, pendingUserInteractions, spawnedTasks, artifacts: structuredArtifacts,
    sessionUploads, focusedSpawnedSessionRunId,
    coordinatorActorId, actorTodos,
    init, spawnActor, killActor, destroyAll, sendMessage, broadcastMessage, broadcastAndResolve,
    abortAll, steer, focusSpawnedSession, closeSpawnedSession, resetSession, sync, routeTask, replyToMessage, getSystem,
  } = useActorSystemStore();

  const models = useAvailableModels();
  const openPlanApprovalDialog = useClusterPlanApprovalStore((state) => state.open);

  const {
    attachments,
    imagePaths,
    fileContextBlock,
    attachmentSummary,
    hasAttachments,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleFileSelect: onFileSelect,
    handleFileSelectNative,
    handleFolderSelect,
    removeAttachment,
    clearAttachments,
  } = useInputAttachments();

  const runningActors = useMemo(() => actors.filter((a) => a.status === "running"), [actors]);
  const hasRunningActors = runningActors.length > 0;

  // Auto-init: mount 时自动创建 ActorSystem
  // ActorSystemStore 会负责恢复磁盘会话快照或补齐默认 Agent。
  const ensureSystem = useCallback(() => {
    const storeState = useActorSystemStore.getState();
    if (storeState.active) return;
    init();
    sync();
  }, [init, sync]);

  useEffect(() => {
    if (active && !initRef.current) {
      initRef.current = true;
      ensureSystem();
    }
  }, [active, ensureSystem]);

  // 加载自定义预设
  useEffect(() => {
    if (showConfig) {
      setCustomPresets(loadCustomPresets());
    }
  }, [showConfig]);

  useEffect(() => {
    try {
      localStorage.setItem(DIALOG_PLAN_APPROVAL_KEY, requirePlanApproval ? "1" : "0");
    } catch {
      // ignore
    }
  }, [requirePlanApproval]);

  const lastDialogLengthRef = useRef(0);
  useEffect(() => {
    if (dialogHistory.length > lastDialogLengthRef.current) {
      // Only auto-scroll when new messages arrive, not on re-renders
      requestAnimationFrame(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    }
    lastDialogLengthRef.current = dialogHistory.length;
  }, [dialogHistory.length]);

  useEffect(() => {
    if (active && systemActive) sync();
  }, [active, systemActive, sync]);

  const actorIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    actors.forEach((a, i) => map.set(a.id, i));
    return map;
  }, [actors]);

  const actorNameToId = useMemo(() => {
    const map = new Map<string, string>();
    actors.forEach((a) => map.set(a.roleName, a.id));
    return map;
  }, [actors]);

  const actorById = useMemo(() => {
    const map = new Map<string, ActorSnapshot>();
    actors.forEach((a) => map.set(a.id, a));
    return map;
  }, [actors]);

  const artifacts = useMemo(
    () => collectArtifacts(dialogHistory, actorById, structuredArtifacts),
    [dialogHistory, actorById, structuredArtifacts],
  );

  const pendingUserReplySet = useMemo(
    () => new Set(pendingUserInteractions.map((interaction) => interaction.messageId)),
    [pendingUserInteractions],
  );

  /** Visible messages: limit DOM nodes for large conversations */
  const MESSAGE_WINDOW_SIZE = 100;
  const visibleMessages = useMemo(() => {
    if (showAllMessages || dialogHistory.length <= MESSAGE_WINDOW_SIZE) return dialogHistory;
    return dialogHistory.slice(-MESSAGE_WINDOW_SIZE);
  }, [dialogHistory, showAllMessages]);
  const messageById = useMemo(() => {
    const map = new Map<string, DialogMessage>();
    dialogHistory.forEach((m) => map.set(m.id, m));
    return map;
  }, [dialogHistory]);
  const pendingInteractionByMessageId = useMemo(() => {
    const map = new Map<string, PendingInteraction>();
    pendingUserInteractions.forEach((interaction) => map.set(interaction.messageId, interaction));
    return map;
  }, [pendingUserInteractions]);
  const approvalInteractions = useMemo(
    () => pendingUserInteractions.filter((interaction) => interaction.type === "approval"),
    [pendingUserInteractions],
  );
  const previousApprovalIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (spawnedTasks.length === 0) {
      setSelectedSpawnRunId(null);
      return;
    }
    if (selectedSpawnRunId && spawnedTasks.some((task) => task.runId === selectedSpawnRunId)) {
      return;
    }
    const nextTask = [...spawnedTasks].sort((a, b) => b.spawnedAt - a.spawnedAt)[0];
    setSelectedSpawnRunId(nextTask?.runId ?? null);
  }, [spawnedTasks, selectedSpawnRunId]);

  const focusedSessionTask = useMemo(
    () => focusedSpawnedSessionRunId
      ? spawnedTasks.find((task) => task.runId === focusedSpawnedSessionRunId && task.mode === "session" && task.sessionOpen)
      : undefined,
    [spawnedTasks, focusedSpawnedSessionRunId],
  );

  useEffect(() => {
    if (focusedSpawnedSessionRunId && !focusedSessionTask) {
      focusSpawnedSession(null);
    }
  }, [focusSpawnedSession, focusedSessionTask, focusedSpawnedSessionRunId]);

  const openApprovalMessage = openApprovalMessageId
    ? messageById.get(openApprovalMessageId) ?? null
    : null;
  const openApprovalInteraction = openApprovalMessageId
    ? pendingInteractionByMessageId.get(openApprovalMessageId)
    : undefined;

  const handleOpenApprovalDrawer = useCallback((messageId: string) => {
    setOpenApprovalMessageId(messageId);
  }, []);

  const handleCloseApprovalDrawer = useCallback(() => {
    setOpenApprovalMessageId(null);
  }, []);

  const handleApprovalReply = useCallback((messageId: string, content: string) => {
    replyToMessage(messageId, content);
    setOpenApprovalMessageId(null);
    setInputNotice(null);
  }, [replyToMessage]);

  useEffect(() => {
    if (pendingUserInteractions.length === 0) {
      if (selectedPendingMessageId !== null) setSelectedPendingMessageId(null);
      return;
    }
    if (selectedPendingMessageId === NEW_MESSAGE_TARGET) return;
    const exists = selectedPendingMessageId
      ? pendingUserInteractions.some((interaction) => interaction.messageId === selectedPendingMessageId)
      : false;
    if (exists) return;
    setSelectedPendingMessageId(
      pendingUserInteractions.length === 1 ? pendingUserInteractions[0].messageId : null,
    );
  }, [pendingUserInteractions, selectedPendingMessageId]);
  useEffect(() => {
    const approvalIds = approvalInteractions.map((interaction) => interaction.messageId);
    const previousApprovalIds = previousApprovalIdsRef.current;
    const newApprovalId = approvalIds.find((id) => !previousApprovalIds.includes(id));

    if (newApprovalId) {
      setOpenApprovalMessageId(newApprovalId);
    } else if (openApprovalMessageId && !approvalIds.includes(openApprovalMessageId) && previousApprovalIds.includes(openApprovalMessageId)) {
      setOpenApprovalMessageId(null);
    }
    previousApprovalIdsRef.current = approvalIds;
  }, [approvalInteractions, openApprovalMessageId]);


  // 热添加 Agent
  const handleAddAgent = useCallback((draft: AddActorDraft) => {
    ensureSystem();
    spawnActor({
      id: `agent-${generateId()}`,
      role: { ...DIALOG_FULL_ROLE, name: draft.name },
      modelOverride: draft.model || undefined,
      capabilities: draft.capabilities,
      workspace: draft.workspace,
      toolPolicy: draft.toolPolicy,
      middlewareOverrides: draft.middlewareOverrides,
      thinkingLevel: draft.thinkingLevel,
    });
  }, [ensureSystem, spawnActor]);

  // 热移除 Agent
  const handleRemoveAgent = useCallback((actorId: string) => {
    killActor(actorId);
  }, [killActor]);

  // 应用预设：清除当前 agents，重新 spawn 预设参与者
  const handleApplyPreset = useCallback((presetId: string) => {
    const preset = [...DIALOG_PRESETS, ...customPresets].find((p) => p.id === presetId);
    if (!preset) return;
    destroyAll();
    initRef.current = false;
    init();
    for (const p of preset.participants) {
      const normalizedCaps = normalizeAgentCapabilities(p.suggestedCapabilities);
      spawnActor({
        id: `agent-${generateId()}`,
        role: { ...DIALOG_FULL_ROLE, name: p.customName },
        modelOverride: p.suggestedModel ?? undefined,
        systemPromptOverride: p.systemPromptOverride,
        capabilities: normalizedCaps ? { tags: normalizedCaps } : undefined,
        workspace: p.workspace,
        toolPolicy: p.toolPolicy,
        middlewareOverrides: p.middlewareOverrides,
        timeoutSeconds: p.timeoutSeconds,
        contextTokens: p.contextTokens,
        thinkingLevel: p.thinkingLevel,
      });
    }
    initRef.current = true;
    if (preset.defaultRoutingMode) {
      setRoutingMode(preset.defaultRoutingMode);
    }
    if (typeof preset.requirePlanApproval === "boolean") {
      setRequirePlanApproval(preset.requirePlanApproval);
    }
    setShowConfig(false);
  }, [destroyAll, init, spawnActor, customPresets]);

  // 保存当前配置为新预设
  const handleSaveCurrentAsPreset = useCallback(() => {
    if (actors.length === 0) return;
    const name = prompt("请输入预设名称：");
    if (!name?.trim()) return;
    
    const newPreset: DialogPreset = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      description: `自定义预设 (${actors.length} 个 Agent)`,
      participants: actors.map((a) => ({
        customName: a.roleName,
        suggestedModel: a.modelOverride,
        suggestedCapabilities: a.capabilities?.tags,
        systemPromptOverride: a.systemPromptOverride || a.currentTask?.query,
        workspace: a.workspace,
        toolPolicy: a.toolPolicy,
        middlewareOverrides: a.middlewareOverrides,
        timeoutSeconds: a.timeoutSeconds,
        contextTokens: a.contextTokens,
        thinkingLevel: a.thinkingLevel,
      })),
      defaultRoutingMode: routingMode,
      requirePlanApproval,
    };
    saveCustomPreset(newPreset);
    setCustomPresets(loadCustomPresets());
  }, [actors, routingMode, requirePlanApproval]);

  const handleStop = useCallback(() => { abortAll(); }, [abortAll]);
  const handleNewTopic = useCallback(() => {
    resetSession();
  }, [resetSession]);
  const handleFullReset = useCallback(() => {
    destroyAll();
    initRef.current = false;
  }, [destroyAll]);

  const parseMention = useCallback((text: string): { targetId: string | null; cleanContent: string } => {
    if (!text.startsWith("@")) return { targetId: null, cleanContent: text };
    for (const [name, id] of actorNameToId) {
      if (text.startsWith(`@${name}`)) {
        const rest = text.slice(name.length + 1).trim();
        return { targetId: id, cleanContent: rest };
      }
    }
    return { targetId: null, cleanContent: text };
  }, [actorNameToId]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed && !hasAttachments) return;

    ensureSystem();

    const hasContext = fileContextBlock.trim().length > 0;
    const hasImages = imagePaths.length > 0;
    const userText = trimmed || (hasContext ? "请分析以上文件内容。" : (hasImages ? "请描述这张图片" : ""));
    const content = hasContext
      ? `${fileContextBlock}\n\n${userText}`
      : userText;

    if (!content && !hasImages) return;

    const briefContent = hasContext
      ? (attachmentSummary ? `${attachmentSummary}\n${userText}` : userText)
      : undefined;

    const imagesToSend = hasImages ? [...imagePaths] : undefined;
    const uploadRecords = attachments.length > 0 ? buildSessionUploadRecords(attachments) : [];

    const hasPendingInteractions = pendingUserInteractions.length > 0;
    const explicitlySelected = selectedPendingMessageId && selectedPendingMessageId !== NEW_MESSAGE_TARGET
      ? pendingInteractionByMessageId.get(selectedPendingMessageId)
      : undefined;
    const sendAsNewMessage = selectedPendingMessageId === NEW_MESSAGE_TARGET;

    // 单个待回复时自动绑定（兼容 useEffect 异步时序），多个时要求显式选择
    const effectiveReplyTarget = explicitlySelected
      ?? (hasPendingInteractions && !sendAsNewMessage && pendingUserInteractions.length === 1
        ? pendingUserInteractions[0]
        : undefined);
    const replyRelatedRunId = effectiveReplyTarget
      ? messageById.get(effectiveReplyTarget.messageId)?.relatedRunId
      : undefined;

    // 有多个待回复交互时，必须显式选择回复目标
    if (hasPendingInteractions && !effectiveReplyTarget && !sendAsNewMessage && pendingUserInteractions.length > 1) {
      setInputNotice("当前有多个待回复问题，请先选择要回复的那一条，或选择“作为新消息发送”。");
      inputRef.current?.focus();
      return;
    }

    if (effectiveReplyTarget) {
      const liveSystem = useActorSystemStore.getState().getSystem() ?? getSystem();
      replyToMessage(effectiveReplyTarget.messageId, content, {
        _briefContent: briefContent,
        images: imagesToSend,
      });
      if (uploadRecords.length > 0) {
        liveSystem?.registerSessionUploads(uploadRecords, {
          actorId: "user",
          relatedRunId: replyRelatedRunId,
        });
      }
      setInput("");
      setInputNotice(null);
      setShowMention(false);
      clearAttachments();
      inputRef.current?.focus();
      return;
    }

    const { targetId, cleanContent } = parseMention(trimmed);
    const finalContent = hasContext
      ? `${fileContextBlock}\n\n${cleanContent || userText}`
      : (cleanContent || content);
    const finalBrief = hasContext
      ? (attachmentSummary ? `${attachmentSummary}\n${cleanContent || userText}` : (cleanContent || userText))
      : undefined;
    const isSteerCommand = Boolean(targetId && finalContent.startsWith("!steer "));
    const shouldRouteToFocusedSession = Boolean(
      focusedSessionTask &&
      focusedSessionTask.sessionOpen &&
      !targetId &&
      !isSteerCommand,
    );
    const smartRoutes = !targetId && routingMode === "smart" && finalContent
      ? routeTask(finalContent)
      : [];
    const selectedSmartRoute = smartRoutes.length > 0 ? smartRoutes[0] : null;

    const system = useActorSystemStore.getState().getSystem() ?? getSystem();
    let runtimePlan: DialogExecutionPlan | null = null;

    if (!effectiveReplyTarget && requirePlanApproval && !isSteerCommand) {
      if (shouldRouteToFocusedSession) {
        runtimePlan = null;
      } else {
        const planBundle = buildDialogDispatchPlanBundle({
          actors,
          routingMode,
          content: finalContent,
          attachmentSummary: finalBrief,
          mentionedTargetId: targetId,
          selectedRoute: selectedSmartRoute,
          coordinatorActorId,
        });
        if (planBundle) {
          const approvalResult = await openPlanApprovalDialog({
            plan: planBundle.clusterPlan,
            sessionId: system?.sessionId,
          });
          if (approvalResult.status !== "approved") {
            setLastPlanReview({ status: "rejected", timestamp: Date.now(), plan: planBundle.clusterPlan });
            setWorkspacePanel("plan");
            setInputNotice("执行计划已取消，调整后可重新发送。");
            inputRef.current?.focus();
            return;
          }
          runtimePlan = planBundle.runtimePlan;
          setLastPlanReview({ status: "approved", timestamp: Date.now(), plan: planBundle.clusterPlan });
        }
      }
    }

    if (!effectiveReplyTarget) {
      if (runtimePlan) {
        system?.armDialogExecutionPlan(runtimePlan);
      } else {
        system?.clearDialogExecutionPlan();
      }
    }

    try {
      if (shouldRouteToFocusedSession && focusedSessionTask) {
        system?.sendUserMessageToSpawnedSession(focusedSessionTask.runId, finalContent, {
          _briefContent: finalBrief,
          images: imagesToSend,
        });
      } else if (isSteerCommand && targetId) {
        const directive = finalContent.slice(7).trim();
        if (directive) steer(targetId, directive);
      } else if (targetId) {
        sendMessage("user", targetId, finalContent, { _briefContent: finalBrief, images: imagesToSend });
      } else {
        if (routingMode === "smart" && finalContent) {
          if (smartRoutes.length > 0) {
            const selectedAgent = smartRoutes[0].agentId;
            const reason = smartRoutes[0].reason;
            console.log(`[Smart Routing] "${finalContent.slice(0, 30)}..." → ${selectedAgent} (${reason})`);
            sendMessage("user", selectedAgent, finalContent, { _briefContent: finalBrief, images: imagesToSend });
            if (uploadRecords.length > 0) {
              system?.registerSessionUploads(uploadRecords, { actorId: "user" });
            }
            setInput("");
            setShowMention(false);
            clearAttachments();
            inputRef.current?.focus();
            return;
          }
        }
        if (routingMode === "broadcast") {
          broadcastMessage("user", finalContent, { _briefContent: finalBrief, images: imagesToSend });
        } else {
          broadcastAndResolve("user", finalContent, { _briefContent: finalBrief, images: imagesToSend });
        }
      }
      if (uploadRecords.length > 0) {
        system?.registerSessionUploads(uploadRecords, {
          actorId: "user",
          relatedRunId: shouldRouteToFocusedSession ? focusedSessionTask?.runId : undefined,
        });
      }
    } catch (error) {
      system?.clearDialogExecutionPlan();
      const message = error instanceof Error ? error.message : String(error);
      setInputNotice(message || "发送失败，请稍后重试。");
      inputRef.current?.focus();
      return;
    }

    setInput("");
    setInputNotice(null);
    setShowMention(false);
    clearAttachments();
    inputRef.current?.focus();
  }, [input, hasAttachments, imagePaths, attachments, fileContextBlock, attachmentSummary, ensureSystem, pendingUserInteractions, pendingInteractionByMessageId, selectedPendingMessageId, parseMention, actors, sendMessage, broadcastMessage, broadcastAndResolve, steer, replyToMessage, routingMode, routeTask, clearAttachments, requirePlanApproval, openPlanApprovalDialog, getSystem, coordinatorActorId, focusedSessionTask, messageById]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    if (inputNotice) setInputNotice(null);

    const lastAt = val.lastIndexOf("@");
    if (lastAt >= 0 && lastAt === val.length - 1) {
      setShowMention(true);
      setMentionFilter("");
    } else if (lastAt >= 0 && !val.slice(lastAt).includes(" ")) {
      setShowMention(true);
      setMentionFilter(val.slice(lastAt + 1));
    } else {
      setShowMention(false);
    }
  }, [inputNotice]);

  const handleMentionSelect = useCallback((name: string) => {
    const lastAt = input.lastIndexOf("@");
    const before = lastAt >= 0 ? input.slice(0, lastAt) : input;
    setInput(`${before}@${name} `);
    setShowMention(false);
    inputRef.current?.focus();
  }, [input]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape" && showMention) {
        setShowMention(false);
      }
    },
    [handleSend, showMention],
  );

  const pendingAgentNames = useMemo(() => {
    if (pendingUserInteractions.length === 0) return "";
    const names = pendingUserInteractions.map((interaction) => {
      const actor = actorById.get(interaction.fromActorId);
      return actor?.roleName ?? interaction.fromActorId;
    }).filter(Boolean);
    return names.join("、");
  }, [pendingUserInteractions, actorById]);

  const selectedPendingInteractionLabel = useMemo(() => {
    if (!selectedPendingMessageId || selectedPendingMessageId === NEW_MESSAGE_TARGET) return "";
    const interaction = pendingInteractionByMessageId.get(selectedPendingMessageId);
    if (!interaction) return "";
    const actor = actorById.get(interaction.fromActorId);
    const actorName = actor?.roleName ?? interaction.fromActorId;
    const kindLabel = interaction.type === "approval"
      ? "审批"
      : interaction.type === "clarification"
        ? "澄清"
        : "提问";
    return `${actorName} 的${kindLabel}`;
  }, [selectedPendingMessageId, pendingInteractionByMessageId, actorById]);

  const draftDispatchBundle = useMemo(() => {
    const trimmed = input.trim();
    const hasContext = fileContextBlock.trim().length > 0;
    const hasImages = imagePaths.length > 0;
    const isReplyingToInteraction = Boolean(
      selectedPendingMessageId && selectedPendingMessageId !== NEW_MESSAGE_TARGET && pendingInteractionByMessageId.get(selectedPendingMessageId),
    ) || (pendingUserInteractions.length > 0 && selectedPendingMessageId !== NEW_MESSAGE_TARGET && pendingUserInteractions.length === 1);

    if (isReplyingToInteraction) return null;
    if (!trimmed && !hasContext && !hasImages) return null;

    const { targetId, cleanContent } = parseMention(trimmed);
    const userText = cleanContent || trimmed || (hasContext ? "请分析以上文件内容。" : (hasImages ? "请描述这张图片" : ""));
    const content = hasContext ? `${fileContextBlock}\n\n${userText}` : userText;
    const brief = hasContext
      ? (attachmentSummary ? `${attachmentSummary}\n${userText}` : userText)
      : attachmentSummary || undefined;
    const smartRoute = !targetId && routingMode === "smart" && content
      ? routeTask(content)[0] ?? null
      : null;

    return buildDialogDispatchPlanBundle({
      actors,
      routingMode,
      content,
      attachmentSummary: brief,
      mentionedTargetId: targetId,
      selectedRoute: smartRoute,
      coordinatorActorId,
    });
  }, [input, fileContextBlock, imagePaths, selectedPendingMessageId, pendingInteractionByMessageId, pendingUserInteractions, parseMention, attachmentSummary, routingMode, routeTask, actors, coordinatorActorId]);
  const draftDispatchPlan = draftDispatchBundle?.clusterPlan ?? null;

  // 图谱数据
  const graphData = useMemo(() => {
    if (overlay !== "graph") return null;
    try {
      const { KnowledgeGraph } = require("@/core/knowledge/knowledge-graph");
      const actorNodes = actors.map((a) => ({
        id: a.id, name: a.roleName, status: a.status, capabilities: a.capabilities?.tags,
      }));
      const spawnEvents = useActorSystemStore.getState().spawnedTaskEvents || [];
      const tasks = spawnEvents.map((e: any) => ({
        spawner: e.spawnerActorId, target: e.targetActorId, label: e.label || "", status: e.status,
      }));
      const dialog = dialogHistory.map((m) => ({ from: m.from, to: m.to }));
      return KnowledgeGraph.fromActorSystem(actorNodes, tasks, dialog);
    } catch { return { nodes: [], edges: [] }; }
  }, [overlay, actors, dialogHistory]);

  return (
    <div className="relative flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-medium">Agent Dialog</span>
          {actors.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">
              {actors.length} 个 Agent
            </span>
          )}
          {actors.length === 1 && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]" title="与 OpenClaw 一致：多 Agent 可同时执行子任务">
              点击 ⚙ 添加 Agent 可并行执行子任务
            </span>
          )}
          {actors.length >= 2 && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]" title="用户消息只发给当前协调者；协调者用 spawn_task 派活后，其他 Agent 才会参与">
              消息发给协调者，其他由协调者 spawn_task 激活
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowConfig(!showConfig)}
            className={`p-1 rounded transition-colors ${
              showConfig ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            }`}
            title="Agent 设置"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setOverlay(overlay === "tasks" ? null : "tasks")}
            className={`p-1 rounded transition-colors ${
              overlay === "tasks" ? "bg-blue-500/10 text-blue-500" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            }`}
            title="任务中心"
          >
            <ListChecks className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setOverlay(overlay === "graph" ? null : "graph")}
            className={`p-1 rounded transition-colors ${
              overlay === "graph" ? "bg-purple-500/10 text-purple-500" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            }`}
            title="知识图谱"
          >
            <Network className="w-3.5 h-3.5" />
          </button>
          {hasRunningActors && (
            <span className="mx-0.5 h-3 w-px bg-[var(--color-border)]" />
          )}
          {hasRunningActors && (
            <button onClick={handleStop} className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1">
              <Square className="w-3 h-3" /> 停止
            </button>
          )}
          <button onClick={handleNewTopic} className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] flex items-center gap-1"
            title="清空对话和 Agent 记忆，保留当前 Agent 阵容">
            <RotateCcw className="w-3 h-3" /> 新话题
          </button>
          <button onClick={handleFullReset} className="text-xs text-[var(--color-text-tertiary)] hover:text-red-500 flex items-center gap-1"
            title="销毁所有 Agent，回到初始状态">
            <Trash2 className="w-3 h-3" /> 重置
          </button>
        </div>
      </div>

      {/* Settings Panel (collapsible) */}
      {showConfig && (
        <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-3 bg-[var(--color-bg-secondary)]">
          {/* Presets */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-[var(--color-text-tertiary)]">预设:</span>
            {DIALOG_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className="text-[10px] px-2 py-1 rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
                onClick={() => handleApplyPreset(preset.id)}
                title={preset.description}
              >
                {preset.name}
              </button>
            ))}
            {customPresets.length > 0 && (
              <>
                <span className="text-[10px] text-[var(--color-text-tertiary)]">|</span>
                {customPresets.map((preset) => (
                  <button
                    key={preset.id}
                    className="text-[10px] px-2 py-1 rounded-md border border-purple-500/30 text-purple-600 hover:border-purple-500/60 hover:text-purple-500 transition-colors"
                    onClick={() => handleApplyPreset(preset.id)}
                    title={preset.description}
                  >
                    {preset.name}
                  </button>
                ))}
              </>
            )}
            <button
              onClick={handleSaveCurrentAsPreset}
              className="text-[10px] px-2 py-1 rounded-md border border-dashed border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:border-green-500/40 hover:text-green-500 transition-colors"
              title="保存当前 Agent 配置为新预设"
            >
              + 保存当前
            </button>
          </div>
          {/* Live Agents */}
          <div className="text-[10px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
            当前 Agent ({actors.length})
          </div>
          <div className="space-y-2">
            {actors.map((actor, i) => (
              <LiveActorRow
                key={actor.id}
                actor={actor}
                index={i}
                onRemove={() => handleRemoveAgent(actor.id)}
              />
            ))}
            {actors.length === 0 && (
              <div className="text-[11px] text-[var(--color-text-tertiary)] py-1">暂无 Agent</div>
            )}
          </div>
          {/* Add Agent */}
          <AddAgentForm
            models={models}
            existingNames={actors.map((a) => a.roleName)}
            onAdd={handleAddAgent}
          />
        </div>
      )}

      {/* Status bar */}
      {!showConfig && actors.length > 0 && (
        <div className="px-4 py-2 border-b border-[var(--color-border)]">
          <ActorStatusBar actors={actors} />
        </div>
      )}

      {!showConfig && actors.length > 0 && (
        <DialogWorkspaceDock
          panel={workspacePanel}
          onPanelChange={setWorkspacePanel}
          actors={actors}
          actorTodos={actorTodos}
          dialogHistory={dialogHistory}
          artifacts={artifacts}
          sessionUploads={sessionUploads}
          spawnedTasks={spawnedTasks}
          selectedRunId={selectedSpawnRunId}
          onSelectRunId={setSelectedSpawnRunId}
          focusedSessionRunId={focusedSpawnedSessionRunId}
          onFocusSession={focusSpawnedSession}
          onCloseSession={closeSpawnedSession}
          draftPlan={draftDispatchPlan}
          requirePlanApproval={requirePlanApproval}
          onTogglePlanApproval={setRequirePlanApproval}
          lastPlanReview={lastPlanReview}
        />
      )}

      {/* Chat Stream */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-3">
        {dialogHistory.length === 0 && (
          <div className="text-center text-[var(--color-text-secondary)] py-12">
            <Bot className="w-10 h-10 mx-auto mb-3 opacity-15" />
            <p className="text-xs opacity-60">直接输入消息开始对话，点击 ⚙ 可添加更多 Agent</p>
          </div>
        )}

        {/* Message windowing: show all when < 100, otherwise show load-more + recent */}
        {dialogHistory.length > 100 && !showAllMessages && (
          <button
            onClick={() => setShowAllMessages(true)}
            className="w-full text-center text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] py-2 transition-colors"
          >
            ↑ 加载更早的 {dialogHistory.length - 100} 条消息
          </button>
        )}

        {visibleMessages.map((msg) => {
          const isUser = msg.from === "user";
          const actorIdx = actorIdToIndex.get(msg.from) ?? 0;
          const actor = actorById.get(msg.from);
          const actorName = isUser ? "你" : (actor?.roleName ?? msg.from);
          const targetName = msg.to
            ? (msg.to === "user" ? "你" : (actorById.get(msg.to)?.roleName ?? msg.to))
            : undefined;
          const isWaiting = !isUser && msg.expectReply && pendingUserReplySet.has(msg.id);
          const pendingInteraction = pendingInteractionByMessageId.get(msg.id);

          return (
            <div key={msg.id} className="max-w-full">
              <MessageBubble
                message={msg}
                actorIndex={actorIdx}
                actorName={actorName}
                targetName={targetName}
                isUser={isUser}
                isWaitingReply={isWaiting}
                pendingInteraction={pendingInteraction}
                onReplyToInteraction={replyToMessage}
                onOpenApprovalDrawer={handleOpenApprovalDrawer}
              />
            </div>
          );
        })}

        {/* Thinking indicators - 流式输出 */}
        {runningActors.map((a, i) => {
            const color = getActorColor(actorIdToIndex.get(a.id) ?? i);
            const steps = a.currentTask?.steps ?? [];
            const hasPendingApproval = pendingUserInteractions.some(
              (interaction) => interaction.fromActorId === a.id && interaction.type === "approval",
            );

            const latestStreamingAnswer = [...steps].reverse().find((s) => s.streaming && s.type === "answer");
            const latestThinkingStep = [...steps].reverse().find((s) => s.type === "thinking");
            const latestToolStreamingStep = hasPendingApproval
              ? undefined
              : [...steps].reverse().find((s) => s.type === "tool_streaming" && s.streaming);

            const streamingContent = latestStreamingAnswer?.content;
            const thinkingContent = latestThinkingStep?.content;
            const toolStreamingContent = latestToolStreamingStep?.content;

            return (
              <div key={`thinking-${a.id}`} className="space-y-2">
                {/* 思考过程折叠面板 */}
                {latestThinkingStep && (
                  <ThinkingBlock
                    roleName={a.roleName}
                    content={thinkingContent ?? ""}
                    startedAt={latestThinkingStep.timestamp}
                    isStreaming={latestThinkingStep.streaming ?? false}
                    color={color}
                  />
                )}
                
                {/* 工具流式输出代码块 */}
                {latestToolStreamingStep && (
                  <ToolStreamingBlock
                    roleName={a.roleName}
                    content={toolStreamingContent ?? ""}
                    startedAt={latestToolStreamingStep.timestamp}
                    isStreaming={latestToolStreamingStep.streaming ?? false}
                    color={color}
                  />
                )}

                {/* 流式生成的内容气泡 */}
                {streamingContent && (
                  <div className={`flex gap-2 ${color.text}`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${color.bg}`}>
                      <Bot className="w-3.5 h-3.5" />
                    </div>
                    <div className="max-w-[80%]">
                      <div className="text-[10px] mb-0.5">
                        {a.roleName}
                        <span className="text-[var(--color-text-tertiary)] ml-1">
                          正在输入中...
                        </span>
                      </div>
                      <div className={`inline-block text-[13px] leading-relaxed rounded-xl px-3 py-2 ${color.bg}`}>
                        <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1">
                          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                            {streamingContent}
                          </ReactMarkdown>
                          <span className="inline-block w-2 h-4 bg-current animate-pulse ml-0.5" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* 思考状态指示器 */}
                <div className={`flex items-center gap-2 ${color.text}`}>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span className="text-[11px] truncate max-w-[80%]">
                    <span className="font-medium">{a.roleName}</span>
                    <span className="opacity-70 ml-1">
                      {describeAgentActivity(steps, a.roleName, !!streamingContent)}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}

        <div ref={chatEndRef} />
      </div>

      {/* Input Bar — always visible */}
      <div className="px-4 py-3 border-t border-[var(--color-border)]" onDrop={handleDrop} onDragOver={handleDragOver}>
        {focusedSessionTask && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-blue-700 bg-blue-500/10 rounded-lg px-2.5 py-1.5">
            <Network className="w-3 h-3" />
            <span>
              当前正在聚焦子会话：
              {focusedSessionTask.label || (actorById.get(focusedSessionTask.targetActorId)?.roleName ?? focusedSessionTask.targetActorId)}
            </span>
            <button
              onClick={() => focusSpawnedSession(null)}
              className="ml-auto px-2 py-0.5 rounded-full border border-blue-500/20 hover:border-blue-500/40 transition-colors"
            >
              退出聚焦
            </button>
          </div>
        )}
        {pendingUserInteractions.length > 0 && pendingAgentNames && (
          <div className="mb-2 space-y-1.5">
            <div className="flex items-center gap-2 text-[10px] text-amber-600 bg-amber-500/10 rounded-lg px-2.5 py-1.5">
              <Reply className="w-3 h-3" />
              <span>
                {pendingAgentNames} 正在等待你的回复
                {pendingUserInteractions.length > 1 ? "，请先选择要回复的问题" : "，发送消息将回复当前问题"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pendingUserInteractions.map((interaction) => {
                const actorName = actorById.get(interaction.fromActorId)?.roleName ?? interaction.fromActorId;
                const isSelected = selectedPendingMessageId === interaction.messageId;
                const kindLabel = interaction.type === "approval"
                  ? "审批"
                  : interaction.type === "clarification"
                    ? "澄清"
                    : "提问";
                return (
                  <button
                    key={interaction.messageId}
                    onClick={() => {
                      setSelectedPendingMessageId(interaction.messageId);
                      setInputNotice(null);
                      inputRef.current?.focus();
                    }}
                    className={`text-[10px] px-2 py-1 rounded-full border transition-colors ${
                      isSelected
                        ? "border-amber-500/50 bg-amber-500/15 text-amber-700"
                        : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:border-amber-500/40 hover:text-amber-600"
                    }`}
                    title={interaction.question}
                  >
                    {actorName} · {kindLabel}
                  </button>
                );
              })}
              {selectedPendingMessageId !== NEW_MESSAGE_TARGET && (
                <button
                  onClick={() => setSelectedPendingMessageId(NEW_MESSAGE_TARGET)}
                  className="text-[10px] px-2 py-1 rounded-full border border-dashed border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]/40 transition-colors"
                >
                  作为新消息发送
                </button>
              )}
            </div>
            {inputNotice && (
              <div className="text-[10px] text-amber-600 px-1">{inputNotice}</div>
            )}
          </div>
        )}
        {/* Attachment preview */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[11px]"
              >
                {att.type === "image" && att.preview ? (
                  <img src={att.preview} alt="" className="w-5 h-5 rounded object-cover" />
                ) : (
                  <span className="opacity-60">{att.type === "folder" ? "📂" : "📄"}</span>
                )}
                <span className="max-w-[100px] truncate">{att.name}</span>
                <button
                  onClick={() => removeAttachment(att.id)}
                  className="ml-0.5 p-0.5 rounded hover:bg-red-500/10 text-[var(--color-text-tertiary)] hover:text-red-500"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={FILE_ACCEPT_ALL}
          className="hidden"
          onChange={onFileSelect}
        />
        <div className="flex items-end gap-2" ref={inputWrapRef}>
          <div className="flex-1 relative bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl focus-within:ring-1 focus-within:ring-[var(--color-accent)] focus-within:border-[var(--color-accent)] transition-shadow">
            {showMention && (
              <MentionPopup
                actors={actors}
                filter={mentionFilter}
                onSelect={handleMentionSelect}
                onClose={() => setShowMention(false)}
              />
            )}
            <textarea
              ref={inputRef}
              className="w-full text-sm bg-transparent px-3 pt-2 pb-1 resize-none focus:outline-none min-h-[36px] max-h-[140px]"
              rows={1}
              placeholder={selectedPendingMessageId === NEW_MESSAGE_TARGET
                ? "作为新消息发送，不会绑定到待回复问题..."
                : selectedPendingInteractionLabel
                ? `回复${selectedPendingInteractionLabel}...`
                : focusedSessionTask
                  ? `继续和 ${actorById.get(focusedSessionTask.targetActorId)?.roleName ?? focusedSessionTask.targetActorId} 的子会话...`
                : pendingUserInteractions.length > 0
                  ? `有 ${pendingUserInteractions.length} 条待回复交互，先选择要回复的问题...`
                : "输入消息... 输入 @ 可指定发送给某个 Agent"}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onBlur={() => setTimeout(() => setShowMention(false), 150)}
            />
            <div className="flex items-center px-2 pb-1.5">
              <AttachDropdown
                onFileClick={() => {
                  if ("__TAURI_INTERNALS__" in window) {
                    void handleFileSelectNative();
                  } else {
                    fileInputRef.current?.click();
                  }
                }}
                onFolderClick={handleFolderSelect}
                accent="accent"
              />
              <RoutingModeButton value={routingMode} onChange={setRoutingMode} />
            </div>
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim() && !hasAttachments}
            className="h-9 w-9 rounded-xl bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 shrink-0 flex items-center justify-center mb-0.5"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Overlay Panel — 浮层弹窗，不压缩聊天区 */}
      {overlay && (
        <>
          <div className="absolute inset-0 bg-black/20 z-30" onClick={() => setOverlay(null)} />
          <div className="absolute inset-x-4 top-14 bottom-4 z-40 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
              <span className="text-sm font-medium">
                {overlay === "tasks" && "任务中心"}
                {overlay === "graph" && "知识图谱"}
              </span>
              <button
                onClick={() => setOverlay(null)}
                className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <Suspense fallback={<div className="p-4 text-xs text-[var(--color-text-secondary)]">加载中...</div>}>
                {overlay === "tasks" && <TaskCenterPanel />}
                {overlay === "graph" && graphData && (
                  <KnowledgeGraphView data={graphData} className="h-full" />
                )}
              </Suspense>
            </div>
          </div>
        </>
      )}

      {openApprovalMessage && (
        <ApprovalRequestDrawer
          message={openApprovalMessage}
          pendingInteraction={openApprovalInteraction}
          actorName={openApprovalMessage.from === "user" ? "你" : (actorById.get(openApprovalMessage.from)?.roleName ?? openApprovalMessage.from)}
          onClose={handleCloseApprovalDrawer}
          onReplyToInteraction={handleApprovalReply}
        />
      )}
    </div>
  );
}
