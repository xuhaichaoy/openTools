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
  ArrowRightCircle,
  type LucideIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AICenterHandoffCard } from "@/components/ai/AICenterHandoffCard";
import {
  buildDialogDispatchPlanBundle,
  inferDialogDispatchInsight,
  type DialogDispatchInsight,
  type DialogDispatchPlanBundle,
} from "@/core/agent/actor/dialog-dispatch-plan";
import {
  buildDialogSpawnedTaskHandoff,
  buildSpawnedTaskCheckpoint,
  collectSpawnedTaskTranscriptEntries,
  type SpawnedTaskCheckpoint,
  type SpawnedTaskTranscriptEntry,
} from "@/core/agent/actor/spawned-task-checkpoint";
import {
  describeCodingExecutionProfile,
  inferCodingExecutionProfile,
} from "@/core/agent/coding-profile";
import { useActorSystemStore, type ActorSnapshot } from "@/store/actor-system-store";
import { useAIStore } from "@/store/ai-store";
import { useAppStore, type AICenterHandoff } from "@/store/app-store";
import { useAISessionRuntimeStore } from "@/store/ai-session-runtime-store";
import { useTeamStore } from "@/store/team-store";
import { useClusterPlanApprovalStore } from "@/store/cluster-plan-approval-store";
import { useConfirmDialogStore } from "@/store/confirm-dialog-store";
import { useToolTrustStore } from "@/store/command-allowlist-store";
import { api } from "@/core/api/client";
import {
  buildAICenterHandoffFileRefs,
  normalizeAICenterHandoff,
} from "@/core/ai/ai-center-handoff";
import { routeToAICenter } from "@/core/ai/ai-center-routing";
import { buildDialogWorkingSetSnapshot } from "@/core/ai/ai-working-set";
import { KnowledgeGraph } from "@/core/knowledge/knowledge-graph";
import { primeTeamModelCache } from "@/core/ai/router";
import { queueAssistantMemoryCandidates } from "@/core/ai/assistant-memory";
import { shouldAutoSaveAssistantMemory } from "@/core/ai/assistant-config";
import { DIALOG_FULL_ROLE } from "@/core/agent/actor/agent-actor";
import {
  decodePartialToolContent,
  formatArtifactPreviewBody,
  hasArtifactPayloadKey,
  parsePartialToolJSON,
  recoverArtifactBodyFromRaw,
} from "@/plugins/builtin/SmartAgent/core/tool-streaming-preview";
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

const DIALOG_STARTER_PROMPTS = [
  {
    label: "做一次实现评审",
    prompt: "请你们一起 review 当前实现，从架构、风险和可维护性三个角度给出结论。",
  },
  {
    label: "一起定位问题",
    prompt: "请一起定位这个问题，先提出怀疑点，再收敛成可执行的排查顺序。",
  },
  {
    label: "拆解一个方案",
    prompt: "请把这个需求拆成可执行方案，分别给出实现路径、风险和协作分工。",
  },
] as const;

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

  if (latest.type === "tool_streaming") {
    const preview = buildToolStreamingPreview(latest.content || "");
    if (preview.kind === "thinking") {
      return "深度思考中";
    }
    if (preview.kind === "spawn") {
      return preview.title.replace(" -> ", " 给 ");
    }
    if (preview.kind === "artifact") {
      return preview.title.replace(/^生成文件:\s*/, "生成 ");
    }
    if (preview.title) return preview.title;
  }

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
      case "get_system_info":
        return "获取系统信息";
      case "get_current_time":
        return "获取当前时间";
      case "calculate":
        return "执行计算";
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
      if (name === "get_system_info")
        return "已获取系统信息，继续处理";
      if (name === "get_current_time")
        return "已获取当前时间，继续处理";
      if (name === "calculate")
        return "计算完成，继续处理";
      if (name === "sequential_thinking")
        return "深度思考完成，继续处理";
      if (name === "spawn_task") {
        const target = String(prevAction.toolInput?.target_agent ?? "").trim();
        const taskText = String(prevAction.toolInput?.task ?? "").trim();
        const codingLabel = describeCodingExecutionProfile(
          inferCodingExecutionProfile({ query: taskText }).profile,
        );
        if (target && codingLabel) return `${codingLabel} 子任务已派发给 ${target}`;
        if (target) return `子任务已派发给 ${target}`;
        return "子任务已派发，等待进展";
      }
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

type ToolStreamingPreview = {
  kind: "artifact" | "generic" | "thinking" | "spawn";
  title: string;
  body: string;
  fullBody?: string;
  meta?: string;
  collapsible?: boolean;
};

function buildSequentialThinkingPreview(parsed: ReturnType<typeof parsePartialToolJSON>): ToolStreamingPreview {
  const thoughtText = decodePartialToolContent(parsed.thought || "");
  const thoughtMeta = [
    typeof parsed.thoughtNumber === "number" ? `步骤 ${parsed.thoughtNumber}` : "",
    typeof parsed.totalThoughts === "number" ? `共 ${parsed.totalThoughts} 步` : "",
  ].filter(Boolean).join(" · ");

  return {
    kind: "thinking",
    title: "深度思考",
    body: thoughtText || "正在组织思路...",
    meta: thoughtMeta || "顺序推理中",
  };
}

function buildSpawnTaskPreview(parsed: ReturnType<typeof parsePartialToolJSON>): ToolStreamingPreview {
  const taskText = decodePartialToolContent(parsed.task || "");
  const target = parsed.targetAgent || "未知 Agent";
  const codingLabel = describeCodingExecutionProfile(
    inferCodingExecutionProfile({ query: `${parsed.label}\n${taskText}` }).profile,
  );
  const title = codingLabel
    ? `派发 ${codingLabel} 子任务 -> ${target}`
    : `派发子任务 -> ${target}`;
  const meta = [
    parsed.label ? `标签: ${parsed.label}` : "",
    codingLabel ? `模式: ${codingLabel}` : "",
  ].filter(Boolean).join(" · ");

  return {
    kind: "spawn",
    title,
    body: taskText || "正在整理委派任务...",
    meta: meta || "协作派发中",
  };
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
  const containerRef = useRef<HTMLPreElement>(null);

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
  const displayContent = content.trim() || "模型正在深度思考，暂未返回可展示内容。";

  return (
    <div className={`flex gap-2 ${color.text}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${color.bg}`}>
        <Brain className="w-3.5 h-3.5" />
      </div>
      <div className="max-w-[88%] min-w-[200px] lg:max-w-[78%]">
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
              {displayContent}
              {isStreaming && <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveExecutionCard({
  roleName,
  title,
  detail,
  startedAt,
  isStreaming,
  color,
  icon: Icon = Settings2,
}: {
  roleName: string;
  title: string;
  detail?: string;
  startedAt: number;
  isStreaming: boolean;
  color: { bg: string; text: string; border: string; dot: string };
  icon?: LucideIcon;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  const elapsed = Math.floor(((isStreaming ? now : Date.now()) - startedAt) / 1000);
  const timeLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}分${elapsed % 60}秒` : `${elapsed}秒`;

  return (
    <div className={`flex gap-2 ${color.text}`}>
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${color.bg}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="max-w-[88%] min-w-[220px] lg:max-w-[78%]">
        <div className="mb-0.5 text-[10px]">{roleName}</div>
        <div className={`rounded-xl border border-current/10 ${color.bg} px-3 py-2`}>
          <div className="flex items-center gap-2 text-[12px]">
            {isStreaming && <Loader2 className="h-3.5 w-3.5 animate-spin opacity-70" />}
            <span className="font-medium">{title}</span>
            <span className="ml-auto text-[10px] opacity-50 tabular-nums">{timeLabel}</span>
          </div>
          {detail && (
            <div className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed opacity-75">
              {detail}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function inferStreamingArtifactLanguage(path: string): string | undefined {
  const fileName = basename(path).toLowerCase();
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  switch (ext) {
    case "html":
    case "htm":
      return "HTML";
    case "tsx":
    case "ts":
      return "TypeScript";
    case "jsx":
    case "js":
      return "JavaScript";
    case "css":
    case "scss":
    case "less":
      return "CSS";
    case "json":
      return "JSON";
    case "md":
      return "Markdown";
    case "py":
      return "Python";
    case "rs":
      return "Rust";
    case "sh":
    case "bash":
    case "zsh":
      return "Shell";
    default:
      return ext ? ext.toUpperCase() : undefined;
  }
}

function shouldRevealStreamingArtifactBody(path: string, body: string, formattedBody: string): boolean {
  const normalized = body.trim();
  if (!normalized) return false;
  if (normalized.includes("\n")) return true;
  if (formattedBody.includes("\n")) return true;
  if (normalized.length >= 72) return true;

  const ext = basename(path).toLowerCase().split(".").pop() || "";
  const codeLikePattern = /<!doctype html>|<html\b|<head\b|<body\b|<div\b|<main\b|<section\b|function\b|const\b|let\b|var\b|class\b|import\b|export\b|body\s*\{|@media\b/i;
  if (["html", "htm", "css", "scss", "less", "js", "jsx", "ts", "tsx", "json", "md"].includes(ext)) {
    return normalized.length >= 24 || codeLikePattern.test(normalized);
  }

  return codeLikePattern.test(normalized);
}

function buildStreamingArtifactPreview(path: string, body: string): {
  meta: string;
  previewBody: string;
  fullBody: string;
  truncated: boolean;
} {
  const normalized = formatArtifactPreviewBody(path, body);
  const lines = normalized ? normalized.split("\n") : [];
  const maxLines = 18;
  const maxChars = 1200;
  const previewByLines = lines.slice(0, maxLines).join("\n");
  const previewBase = previewByLines.length > maxChars
    ? `${previewByLines.slice(0, maxChars)}...`
    : previewByLines;
  const truncated = normalized.length > previewBase.length || lines.length > maxLines;
  const previewBody = truncated ? `${previewBase}\n...` : previewBase;
  const language = inferStreamingArtifactLanguage(path);
  const metaParts = [
    language,
    lines.length > 0 ? `${lines.length} 行` : "",
    normalized.length > 0 ? `${normalized.length} 字符` : "",
  ].filter(Boolean);

  return {
    meta: metaParts.join(" · "),
    previewBody,
    fullBody: normalized,
    truncated,
  };
}

function buildToolStreamingPreview(jsonStr: string): ToolStreamingPreview {
  const parsed = parsePartialToolJSON(jsonStr);
  const raw = decodePartialToolContent(jsonStr);
  const looksLikeArtifact = Boolean(
    parsed.path
      && (
        parsed.content
        || hasArtifactPayloadKey(jsonStr)
      ),
  );

  if (parsed.thought.trim()) {
    return buildSequentialThinkingPreview(parsed);
  }

  if (parsed.targetAgent.trim() && parsed.task.trim()) {
    return buildSpawnTaskPreview(parsed);
  }

  if (looksLikeArtifact) {
    const artifactBody = decodePartialToolContent(parsed.content || "")
      || recoverArtifactBodyFromRaw(jsonStr, parsed.path);
    const preview = buildStreamingArtifactPreview(parsed.path || "未知文件", artifactBody);
    return {
      kind: "artifact",
      title: `生成文件: ${parsed.path || "未知文件"}`,
      body: preview.previewBody,
      fullBody: preview.fullBody,
      meta: preview.meta,
      collapsible: preview.truncated,
    };
  }

  if (parsed.query) {
    return {
      kind: "generic",
      title: `准备搜索: ${parsed.query.slice(0, 48)}`,
      body: raw,
    };
  }
  if (parsed.url) {
    return {
      kind: "generic",
      title: `准备访问: ${parsed.url.replace(/^https?:\/\//, "").slice(0, 56)}`,
      body: raw,
    };
  }
  if (parsed.command) {
    return {
      kind: "generic",
      title: `准备执行命令`,
      body: raw,
    };
  }
  if (parsed.path) {
    return {
      kind: "generic",
      title: `准备处理: ${basename(parsed.path)}`,
      body: raw,
    };
  }

  return {
    kind: "generic",
    title: "准备调用工具",
    body: raw,
  };
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
  const containerRef = useRef<HTMLPreElement>(null);

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
  const artifactPath = parsed.path || "未知文件";
  const rawArtifactBody = decodePartialToolContent(parsed.content || "")
    || recoverArtifactBodyFromRaw(content, artifactPath);
  const normalizedArtifactBody = rawArtifactBody
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const formattedArtifactBody = normalizedArtifactBody
    ? formatArtifactPreviewBody(artifactPath, normalizedArtifactBody)
    : "";
  const streamingArtifactBody = shouldRevealStreamingArtifactBody(
    artifactPath,
    normalizedArtifactBody,
    formattedArtifactBody,
  )
    ? (formattedArtifactBody || normalizedArtifactBody)
    : "";
  const displayedBody = isStreaming
    ? streamingArtifactBody
    : (formattedArtifactBody || normalizedArtifactBody);
  const isBufferingPreview = !displayedBody;

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
              生成文件: {artifactPath}
            </span>
            <span className="opacity-50 ml-auto tabular-nums flex items-center gap-1">
              {isStreaming && <Loader2 className="w-3 h-3 animate-spin" />}
              {timeLabel}
            </span>
          </div>
          <pre
            ref={containerRef}
            className="max-h-[350px] overflow-auto whitespace-pre bg-[#1e1e1e] p-3 font-mono text-[12px] leading-[1.6] text-[#d4d4d4]"
          >
            {displayedBody || (
              <span className="opacity-30">{isBufferingPreview ? "正在整理代码内容..." : "准备写入中..."}</span>
            )}
            {isStreaming && <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5" />}
          </pre>
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

function collectTaskTranscript(params: {
  task: SpawnedTaskRecord | null;
  actorById: Map<string, ActorSnapshot>;
  dialogHistory: DialogMessage[];
}): SpawnedTaskTranscriptEntry[] {
  const { task, actorById, dialogHistory } = params;
  if (!task) return [];

  const targetActor = actorById.get(task.targetActorId);
  return collectSpawnedTaskTranscriptEntries({
    task,
    targetActor,
    actorNameById: new Map(
      [...actorById.entries()].map(([id, actor]) => [id, actor.roleName]),
    ),
    dialogHistory,
  });
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
    parsed: attachment.type !== "image" ? Boolean(attachment.textContent) : undefined,
    truncated: Boolean(attachment.textContent && attachment.textContent.length > 1200),
    canReadFromPath: Boolean(attachment.path),
    multimodalEligible: attachment.type === "image",
  }));
}

function buildDialogAgentHandoff(params: {
  dialogHistory: DialogMessage[];
  actorById: Map<string, ActorSnapshot>;
  artifacts: DialogArtifact[];
  sessionUploads: SessionUploadRecord[];
  spawnedTasks: SpawnedTaskRecord[];
  sourceSessionId?: string;
  maxMessages?: number;
  maxCharsPerMessage?: number;
  maxArtifacts?: number;
  maxSpawnedTasks?: number;
  maxAttachmentPaths?: number;
}): AICenterHandoff | null {
  const {
    dialogHistory,
    actorById,
    artifacts,
    sessionUploads,
    spawnedTasks,
    sourceSessionId,
    maxMessages = 10,
    maxCharsPerMessage = 500,
    maxArtifacts = 6,
    maxSpawnedTasks = 6,
    maxAttachmentPaths = 16,
  } = params;
  const recentMessages = dialogHistory.slice(-maxMessages);
  if (recentMessages.length === 0) return null;

  const transcript = recentMessages.map((message) => {
    const fromLabel = message.from === "user"
      ? "你"
      : (actorById.get(message.from)?.roleName ?? message.from);
    const toLabel = message.to
      ? (message.to === "user" ? "你" : (actorById.get(message.to)?.roleName ?? message.to))
      : "房间";
    const rawContent = (message._briefContent || message.content || "").trim();
    const clipped = rawContent.length > maxCharsPerMessage
      ? `${rawContent.slice(0, maxCharsPerMessage)}…`
      : rawContent;
    const parts = [`[${fromLabel} -> ${toLabel}]: ${clipped || "（空）"}`];
    if (message.kind) parts.push(`  [类型]: ${message.kind}`);
    if (message.images?.length) parts.push(`  [图片]: ${message.images.length} 张`);
    return parts.join("\n");
  }).join("\n");

  const workingSet = buildDialogWorkingSetSnapshot({
    artifacts,
    sessionUploads,
    spawnedTasks,
    actorNameById: new Map(
      [...actorById.entries()].map(([id, actor]) => [id, actor.roleName]),
    ),
    extraAttachmentPaths: recentMessages.flatMap((message) => message.images || []),
    maxArtifacts,
    maxSpawnedTasks,
    maxAttachmentPaths,
  });
  const attachmentPaths = workingSet.attachmentPaths;

  const intro = attachmentPaths.length > 0
    ? "以下是之前 Dialog 协作房间的最近上下文，并已附带相关图片/文件，请继续落地执行："
    : "以下是之前 Dialog 协作房间的最近上下文，请继续落地执行：";
  const uploadSummary = workingSet.uploadSummaryLine ?? "";
  const artifactSummary = workingSet.artifactSummaryLines.length > 0
    ? `当前房间最近生成/修改的文件产物：\n${workingSet.artifactSummaryLines.join("\n")}`
    : "";
  const spawnedTaskSummary = workingSet.spawnedTaskSummaryLines.length > 0
    ? `当前房间子任务/子会话概览：\n${workingSet.spawnedTaskSummaryLines.join("\n")}`
    : "";
  const query = [
    intro,
    "",
    transcript,
    spawnedTaskSummary ? `---\n\n${spawnedTaskSummary}` : "",
    artifactSummary ? `---\n\n${artifactSummary}` : "",
    uploadSummary ? `---\n\n${uploadSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const latestUserMessage = [...recentMessages]
    .reverse()
    .find((message) => message.from === "user" && (message._briefContent || message.content).trim());
  const inferredCoding = inferCodingExecutionProfile({
    query,
    attachmentPaths,
  });

  return normalizeAICenterHandoff({
    query,
    ...(attachmentPaths.length > 0 ? { attachmentPaths } : {}),
    title: "延续 Dialog 协作房间",
    goal: summarizeAISessionRuntimeText(
      latestUserMessage?._briefContent || latestUserMessage?.content,
      120,
    ) || "延续 Dialog 房间中的当前协作任务",
    intent: inferredCoding.profile.codingMode ? "coding" : "delivery",
    keyPoints: [
      `带入最近 ${recentMessages.length} 条 Dialog 消息`,
      workingSet.artifactSummaryLines.length > 0 ? `${workingSet.artifactSummaryLines.length} 条产物线索` : "",
      workingSet.spawnedTaskSummaryLines.length > 0 ? `${workingSet.spawnedTaskSummaryLines.length} 条子任务线索` : "",
    ].filter(Boolean),
    nextSteps: [
      "先阅读 Dialog 最近讨论与工作集，再继续执行或收束结论",
      workingSet.openSessionCount > 0 ? `注意当前仍有 ${workingSet.openSessionCount} 个开放子会话线索` : "",
    ].filter(Boolean),
    contextSections: [
      workingSet.spawnedTaskSummaryLines.length > 0
        ? { title: "子任务概览", items: workingSet.spawnedTaskSummaryLines }
        : null,
      workingSet.artifactSummaryLines.length > 0
        ? { title: "产物线索", items: workingSet.artifactSummaryLines }
        : null,
    ].filter((section): section is { title: string; items: string[] } => Boolean(section)),
    files: [
      ...(buildAICenterHandoffFileRefs(attachmentPaths, "Dialog 工作集文件") || []),
    ],
    sourceMode: "dialog",
    ...(sourceSessionId ? { sourceSessionId } : {}),
    sourceLabel: "Dialog 房间",
    summary: workingSet.summary,
  });
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
      <div className="absolute inset-3 z-50 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl overflow-hidden flex flex-col md:inset-y-3 md:right-3 md:left-auto md:w-[min(68vw,760px)]">
        <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur-sm">
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

        <div className="flex-1 overflow-y-auto px-4 py-3 bg-[var(--color-bg-secondary)]/35">
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
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
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

        <div className="px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg)]/96 backdrop-blur-sm">
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
  const interactionStatus = pendingInteraction?.status ?? message.interactionStatus;
  const showTimedOutHint = !isUser && message.expectReply && !isStructuredApproval && interactionStatus === "timed_out";
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
      <div className={`max-w-[88%] min-w-0 lg:max-w-[78%] ${isUser ? "flex flex-col items-end text-right" : ""}`}>
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
              <div className={`prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_code]:break-words [&_p]:whitespace-pre-wrap [&_li]:whitespace-pre-wrap ${isUser ? "[&_p]:text-right [&_li]:text-right [&_ol]:text-right [&_ul]:text-right" : ""}`}>
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
        {showTimedOutHint && (
          <div className="mt-1 max-w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
            这次提问会保持已超时。Agent 已按已有信息继续或结束当前分支；现在再发送内容，只会作为新的跟进消息发给原提问 Actor，不会把状态改回已处理，也不会接回原等待流程。
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

function ActorStatusBar({ actors, compact = false }: { actors: ActorSnapshot[]; compact?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {actors.map((actor, i) => {
        const color = getActorColor(i);
        const isThinking = actor.status === "running";
        return (
          <div
            key={actor.id}
            className={`flex items-center gap-1.5 rounded-full border ${compact ? "px-2 py-0.5 text-[10px]" : "px-2 py-1 text-[10px]"} ${color.bg} ${color.text} ${color.border}`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${color.dot} ${isThinking ? "animate-pulse" : ""}`} />
            <span className="font-medium">{actor.roleName}</span>
            {!compact && <CapabilityBadges tags={actor.capabilities?.tags} />}
            {!compact && actor.modelOverride && (
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
    <div className={`p-1.5 rounded-xl border ${color.border} ${color.bg}`}>
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
      <div className="mt-1.5 flex flex-wrap gap-1">
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
    <div className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名称 (可选)"
          className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] w-[96px]"
        />
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] min-w-[108px] max-w-[160px]"
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
            className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] flex items-center gap-1 hover:bg-[var(--color-bg-hover)]"
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
          className="text-[10px] px-1.5 py-1 rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]/40"
        >
          {showAdvanced ? "收起高级" : "高级配置"}
        </button>
        <button
          onClick={handleAdd}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
        >
          <Plus className="w-3 h-3" /> 添加
        </button>
      </div>
      {showAdvanced && (
        <div className="grid gap-1.5 md:grid-cols-2">
          <input
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder="工作目录，如 /project/root"
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <select
            value={approvalLevel}
            onChange={(e) => setApprovalLevel(e.target.value as ApprovalLevel)}
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
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
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <input
            value={toolDeny}
            onChange={(e) => setToolDeny(e.target.value)}
            placeholder="禁止工具，逗号分隔"
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <input
            value={disabledMiddlewares}
            onChange={(e) => setDisabledMiddlewares(e.target.value)}
            placeholder="关闭中间件，逗号分隔"
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <select
            value={thinkingLevel}
            onChange={(e) => setThinkingLevel(e.target.value as ThinkingLevel)}
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
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
        className="flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/30 hover:text-[var(--color-text)] transition-colors"
      >
        <span>{current.icon}</span>
        <span>{current.label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 w-52 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl shadow-xl overflow-hidden z-50">
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
  onContinueTaskWithAgent,
  draftPlan,
  draftInsight,
  requirePlanApproval,
  onTogglePlanApproval,
  lastPlanReview,
  graphAvailable,
  onOpenGraph,
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
  onContinueTaskWithAgent: (runId: string) => void;
  draftPlan: ClusterPlan | null;
  draftInsight: DialogDispatchPlanBundle["insight"] | null;
  requirePlanApproval: boolean;
  onTogglePlanApproval: (value: boolean) => void;
  lastPlanReview: { status: "approved" | "rejected"; timestamp: number; plan: ClusterPlan } | null;
  graphAvailable: boolean;
  onOpenGraph: (() => void) | null;
}) {
  const actorById = useMemo(() => {
    const map = new Map<string, ActorSnapshot>();
    actors.forEach((actor) => map.set(actor.id, actor));
    return map;
  }, [actors]);
  const actorNameById = useMemo(() => {
    const map = new Map<string, string>();
    actors.forEach((actor) => map.set(actor.id, actor.roleName));
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
  const taskCheckpointByRunId = useMemo(() => {
    const map = new Map<string, SpawnedTaskCheckpoint>();
    for (const task of sortedTasks) {
      const checkpoint = buildSpawnedTaskCheckpoint({
        task,
        targetActor: actorById.get(task.targetActorId),
        actorTodos: actorTodos[task.targetActorId] ?? [],
        dialogHistory,
        artifacts,
        actorNameById,
      });
      if (checkpoint) {
        map.set(task.runId, checkpoint);
      }
    }
    return map;
  }, [sortedTasks, actorById, actorTodos, dialogHistory, artifacts, actorNameById]);
  const selectedTaskCheckpoint = useMemo<SpawnedTaskCheckpoint | null>(() => {
    if (!selectedTask) return null;
    return taskCheckpointByRunId.get(selectedTask.runId) ?? null;
  }, [selectedTask, taskCheckpointByRunId]);

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

  const activeTodoCount = useMemo(
    () =>
      Object.values(actorTodos).reduce(
        (sum, todos) =>
          sum + todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length,
        0,
      ),
    [actorTodos],
  );

  const totalTodoCount = useMemo(
    () => Object.values(actorTodos).reduce((sum, todos) => sum + todos.length, 0),
    [actorTodos],
  );

  const openSessionCount = useMemo(
    () => sortedTasks.filter((task) => task.mode === "session" && task.sessionOpen).length,
    [sortedTasks],
  );

  const workspaceTabs: Array<{
    id: Exclude<WorkspacePanel, null>;
    label: string;
    icon: LucideIcon;
    count: number;
    description: string;
  }> = [
    {
      id: "todos",
      label: "待办",
      icon: ListChecks,
      count: activeTodoCount || totalTodoCount,
      description: activeTodoCount > 0 ? `${activeTodoCount} 个活跃待办` : "查看全部 Agent 待办",
    },
    {
      id: "artifacts",
      label: "产物",
      icon: FileDown,
      count: artifacts.length,
      description: artifacts.length > 0 ? "浏览本轮生成的文件产物" : "当前还没有生成文件产物",
    },
    {
      id: "uploads",
      label: "上传",
      icon: FolderOpen,
      count: sessionUploads.length,
      description: sessionUploads.length > 0 ? "查看会话上传与上下文附件" : "当前会话没有登记上传项",
    },
    {
      id: "subtasks",
      label: "子任务",
      icon: Network,
      count: sortedTasks.length,
      description: openSessionCount > 0 ? `${openSessionCount} 个子会话仍可继续交互` : "查看已派发子任务与子会话",
    },
    {
      id: "plan",
      label: "计划",
      icon: ShieldCheck,
      count: draftPlan?.steps.length ?? 0,
      description: requirePlanApproval ? "发送前会先审批执行计划" : "当前发送将直接进入执行",
    },
  ];

  const activePanelMeta = panel
    ? workspaceTabs.find((tab) => tab.id === panel) ?? null
    : null;
  const ActivePanelIcon = activePanelMeta?.icon ?? ListChecks;
  const defaultPanel = useMemo<Exclude<WorkspacePanel, null>>(() => {
    if (activeTodoCount > 0 || totalTodoCount > 0) return "todos";
    if (sortedTasks.length > 0) return "subtasks";
    if (artifacts.length > 0) return "artifacts";
    if (sessionUploads.length > 0) return "uploads";
    return "plan";
  }, [activeTodoCount, totalTodoCount, sortedTasks.length, artifacts.length, sessionUploads.length]);
  const summaryItems = useMemo(() => {
    const items = [
      { key: "todos", label: "待办", value: activeTodoCount || totalTodoCount },
      { key: "artifacts", label: "产物", value: artifacts.length },
      { key: "uploads", label: "上传", value: sessionUploads.length },
      { key: "subtasks", label: "子任务", value: sortedTasks.length },
    ];
    return items.filter((item) => item.value > 0).slice(0, 3);
  }, [activeTodoCount, totalTodoCount, artifacts.length, sessionUploads.length, sortedTasks.length]);
  const currentPanelLabel = activePanelMeta ? `工作台 · ${activePanelMeta.label}` : "工作台";

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {summaryItems.map((item) => (
          <span
            key={item.key}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
          >
            <span>{item.label}</span>
            <span className="rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-tertiary)]">
              {item.value}
            </span>
          </span>
        ))}
        <span
          className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] ${
            requirePlanApproval
              ? "border-amber-500/25 bg-amber-500/10 text-amber-700"
              : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 text-[var(--color-text-secondary)]"
          }`}
        >
          {requirePlanApproval ? "发送前审批" : "直接发送"}
        </span>
        {graphAvailable && onOpenGraph && (
          <button
            onClick={onOpenGraph}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-fuchsia-500/30 hover:text-fuchsia-600 transition-colors"
            title="查看当前房间的角色关系、消息流和子任务派发"
          >
            <Network className="w-3 h-3" />
            协作图
          </button>
        )}
        <button
          onClick={() => onPanelChange(panel ? null : defaultPanel)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
            panel
              ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
              : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/25 hover:text-[var(--color-text)]"
          }`}
          title="打开会话工作台"
        >
          <ListChecks className="w-3 h-3" />
          {currentPanelLabel}
        </button>
      </div>

      {panel && activePanelMeta && (
        <>
          <div className="absolute inset-0 z-20 bg-black/20" onClick={() => onPanelChange(null)} />
          <div className="absolute inset-3 z-30 flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl md:inset-y-3 md:right-3 md:left-auto md:w-[min(420px,calc(100%-1rem))]">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-3.5 py-2.5 backdrop-blur-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-2xl bg-[var(--color-accent)]/12 text-[var(--color-accent)]">
                    <ActivePanelIcon className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-[13px] font-medium text-[var(--color-text)]">{activePanelMeta.label}</span>
                  <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                    {activePanelMeta.count}
                  </span>
                </div>
                <div className="mt-1 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
                  {activePanelMeta.description}
                </div>
              </div>
              <button
                onClick={() => onPanelChange(null)}
                className="rounded-xl p-1.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
              <div className="flex flex-wrap gap-1.5">
                {workspaceTabs.map((tab) => {
                  const active = panel === tab.id;
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => onPanelChange(tab.id)}
                      className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] transition-all ${
                        active
                          ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/10 text-[var(--color-text)] shadow-sm"
                          : "border-[var(--color-border)] bg-[var(--color-bg)]/75 text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/25 hover:text-[var(--color-text)]"
                      }`}
                      title={tab.description}
                    >
                      <span
                        className={`flex h-5 w-5 items-center justify-center rounded-full ${
                          active ? "bg-[var(--color-accent)]/12 text-[var(--color-accent)]" : "bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)]"
                        }`}
                      >
                        <Icon className="w-3 h-3" />
                      </span>
                      <span>{tab.label}</span>
                      {tab.count > 0 && (
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[9px] ${
                            active
                              ? "bg-[var(--color-bg)] text-[var(--color-text-secondary)]"
                              : "bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)]"
                          }`}
                        >
                          {tab.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-[var(--color-bg-secondary)]/35">
        {panel === "todos" && (
          <div className="p-3 space-y-2.5">
            {actors.map((actor) => {
              const todos = actorTodos[actor.id] ?? [];
              const activeTodos = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
              return (
                <div key={actor.id} className="rounded-xl border border-[var(--color-border)]/80 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] font-medium text-[var(--color-text)]">{actor.roleName}</div>
                    <div className="text-[10px] text-[var(--color-text-tertiary)]">
                      活跃 {activeTodos.length} / 全部 {todos.length}
                    </div>
                  </div>
                  {todos.length === 0 ? (
                    <div className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">当前没有待办。</div>
                  ) : (
                    <div className="mt-2 grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
                      {todos
                        .slice()
                        .sort((a, b) => b.updatedAt - a.updatedAt)
                        .map((todo) => (
                          <div key={todo.id} className="rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-bg-secondary)]/70 px-2.5 py-1.5">
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
          <div className="p-3 space-y-2.5">
            {artifacts.length === 0 ? (
              <div className="text-[12px] text-[var(--color-text-tertiary)]">当前还没有检测到文件产物。</div>
            ) : (
              artifacts.map((artifact) => (
                <div key={artifact.id} className="rounded-xl border border-[var(--color-border)]/80 p-2.5">
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
          <div className="p-3 space-y-2.5">
            {sessionUploads.length === 0 ? (
              <div className="text-[12px] text-[var(--color-text-tertiary)]">当前会话里还没有登记过上传文件。</div>
            ) : (
              sessionUploads.map((upload) => (
                <div key={upload.id} className="rounded-xl border border-[var(--color-border)]/80 p-2.5">
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
          <div className="p-3">
            {sortedTasks.length === 0 ? (
              <div className="text-[12px] text-[var(--color-text-tertiary)]">还没有 spawn_task 记录。</div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
                <div className="space-y-2">
                  {sortedTasks.map((task) => {
                    const spawner = actorById.get(task.spawnerActorId)?.roleName ?? task.spawnerActorId;
                    const target = actorById.get(task.targetActorId)?.roleName ?? task.targetActorId;
                    const checkpoint = taskCheckpointByRunId.get(task.runId);
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
                          {checkpoint && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-700">
                              {checkpoint.stageLabel}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-[var(--color-text-tertiary)]">{task.status}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-[var(--color-text-secondary)] truncate">
                          {spawner} → {target}
                        </div>
                        {checkpoint?.summary && (
                          <div className="mt-1 text-[10px] text-[var(--color-text-secondary)] line-clamp-2 text-left">
                            {checkpoint.summary}
                          </div>
                        )}
                        <div className="mt-1 text-[10px] text-[var(--color-text-tertiary)]">
                          {formatShortTime(task.spawnedAt)}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {selectedTask && (
                  <div className="rounded-xl border border-[var(--color-border)] p-2.5 space-y-2.5">
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
                      <button
                        onClick={() => onContinueTaskWithAgent(selectedTask.runId)}
                        className="ml-auto text-[10px] px-2 py-1 rounded-full border border-cyan-500/20 bg-cyan-500/5 text-cyan-700 hover:border-cyan-500/35 hover:bg-cyan-500/10 transition-colors"
                        title="把当前子任务的 checkpoint、待办、最近子会话记录和相关文件带到 Agent 继续执行"
                      >
                        转 Agent 接力
                      </button>
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
                    {selectedTaskCheckpoint && (
                      <div className="rounded-xl border border-cyan-500/15 bg-cyan-500/5 px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-[10px] uppercase tracking-[0.12em] text-cyan-700">Checkpoint</div>
                          <span className="rounded-full border border-cyan-500/20 bg-white/70 px-1.5 py-0.5 text-[10px] text-cyan-700">
                            {selectedTaskCheckpoint.stageLabel}
                          </span>
                          {selectedTaskCheckpoint.activeTodoCount > 0 && (
                            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700">
                              {selectedTaskCheckpoint.activeTodoCount} 个活跃待办
                            </span>
                          )}
                          <span className="text-[10px] text-[var(--color-text-tertiary)]">
                            更新于 {formatShortTime(selectedTaskCheckpoint.updatedAt)}
                          </span>
                        </div>
                        <div className="mt-2 text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-words">
                          {selectedTaskCheckpoint.summary}
                        </div>
                        {selectedTaskCheckpoint.nextStep && (
                          <div className="mt-2 rounded-lg bg-white/60 px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)]">
                            下一步：{selectedTaskCheckpoint.nextStep}
                          </div>
                        )}
                        {(selectedTaskCheckpoint.activeTodos.length > 0 || selectedTaskCheckpoint.relatedArtifactPaths.length > 0) && (
                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            {selectedTaskCheckpoint.activeTodos.length > 0 && (
                              <div className="rounded-lg bg-white/60 px-2.5 py-2">
                                <div className="text-[10px] text-[var(--color-text-tertiary)]">活跃待办</div>
                                <div className="mt-1 space-y-1">
                                  {selectedTaskCheckpoint.activeTodos.map((todo) => (
                                    <div key={todo} className="text-[11px] text-[var(--color-text-secondary)]">
                                      {todo}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {selectedTaskCheckpoint.relatedArtifactPaths.length > 0 && (
                              <div className="rounded-lg bg-white/60 px-2.5 py-2">
                                <div className="text-[10px] text-[var(--color-text-tertiary)]">相关文件</div>
                                <div className="mt-1 space-y-1">
                                  {selectedTaskCheckpoint.relatedArtifactPaths.slice(0, 3).map((filePath) => (
                                    <div key={filePath} className="text-[11px] text-[var(--color-text-secondary)] break-all">
                                      {filePath}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
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
          <div className="p-3 space-y-2.5">
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
                {draftInsight?.autoModeLabel && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-emerald-700">
                      自动识别 {draftInsight.autoModeLabel}
                    </span>
                    {draftInsight.focusLabel && (
                      <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-sky-700">
                        {draftInsight.focusLabel}
                      </span>
                    )}
                    {draftInsight.reasons[0] && (
                      <span
                        className="truncate text-[10px] text-[var(--color-text-tertiary)]"
                        title={draftInsight.reasons.join(" · ")}
                      >
                        {draftInsight.reasons[0]}
                      </span>
                    )}
                  </div>
                )}
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
          </div>
        </>
      )}
    </>
  );
}

// ── Main Panel ──

export function ActorChatPanel({ active = true }: { active?: boolean }) {
  const [showConfig, setShowConfig] = useState(false);
  const [overlay, setOverlay] = useState<DialogOverlay>(null);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>(null);
  const [input, setInput] = useState("");
  const [incomingHandoff, setIncomingHandoff] = useState<AICenterHandoff | null>(null);
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
  const [lastCommittedDispatchInsight, setLastCommittedDispatchInsight] = useState<DialogDispatchInsight | null>(null);
  const [requirePlanApproval, setRequirePlanApproval] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DIALOG_PLAN_APPROVAL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [lastPlanReview, setLastPlanReview] = useState<{ status: "approved" | "rejected"; timestamp: number; plan: ClusterPlan } | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initRef = useRef(false);
  const dialogUserScrolledUpRef = useRef(false);
  const dialogScrollThrottleRef = useRef(0);
  const actorThinkingAnchorRef = useRef<Record<string, { taskId: string; startedAt: number }>>({});

  const {
    active: systemActive, actors, dialogHistory, pendingUserInteractions, spawnedTasks, artifacts: structuredArtifacts,
    sessionUploads, focusedSpawnedSessionRunId,
    coordinatorActorId, actorTodos,
    init, spawnActor, killActor, destroyAll, sendMessage, broadcastMessage, broadcastAndResolve,
    abortAll, steer, focusSpawnedSession, closeSpawnedSession, resetSession, sync, routeTask, replyToMessage, getSystem,
  } = useActorSystemStore();

  const models = useAvailableModels();
  const openPlanApprovalDialog = useClusterPlanApprovalStore((state) => state.open);
  const planApprovalActive = useClusterPlanApprovalStore((state) => state.active !== null);
  const openConfirmDialog = useConfirmDialogStore((state) => state.open);

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
    addAttachmentFromPath,
  } = useInputAttachments();
  const inputAttachmentPaths = useMemo(
    () => [...new Set([
      ...imagePaths,
      ...attachments
        .map((attachment) => attachment.path)
        .filter((path): path is string => typeof path === "string" && path.trim().length > 0),
    ])],
    [attachments, imagePaths],
  );
  const pendingAICenterHandoff = useAppStore((s) => s.pendingAICenterHandoff);
  const config = useAIStore((s) => s.config);

  const runningActors = useMemo(() => actors.filter((a) => a.status === "running"), [actors]);
  const confirmDangerousAction = useCallback(
    (toolName: string, params: Record<string, unknown>): Promise<boolean> => {
      if (!useToolTrustStore.getState().shouldConfirm(toolName)) {
        return Promise.resolve(true);
      }
      return openConfirmDialog({
        source: "actor_dialog",
        toolName,
        params,
      });
    },
    [openConfirmDialog],
  );
  const hasRunningActors = runningActors.length > 0;
  const runningActivityKey = useMemo(
    () =>
      runningActors
        .map((actor) => {
          const steps = actor.currentTask?.steps ?? [];
          const lastStep = steps[steps.length - 1];
          return [
            actor.id,
            actor.currentTask?.id ?? "",
            steps.length,
            lastStep?.type ?? "",
            lastStep?.timestamp ?? 0,
            lastStep?.streaming ? 1 : 0,
            lastStep?.content?.length ?? 0,
          ].join(":");
        })
        .join("|"),
    [runningActors],
  );

  useEffect(() => {
    const activeActorIds = new Set<string>();
    for (const actor of runningActors) {
      activeActorIds.add(actor.id);
      const taskId = actor.currentTask?.id ?? "";
      const taskStartedAt = actor.currentTask?.startedAt;
      const firstStepTimestamp = actor.currentTask?.steps[0]?.timestamp;
      const existing = actorThinkingAnchorRef.current[actor.id];
      if (!existing || existing.taskId !== taskId) {
        actorThinkingAnchorRef.current[actor.id] = {
          taskId,
          startedAt: taskStartedAt ?? firstStepTimestamp ?? Date.now(),
        };
        continue;
      }
      if (typeof taskStartedAt === "number" && taskStartedAt < existing.startedAt) {
        existing.startedAt = taskStartedAt;
      }
      if (typeof firstStepTimestamp === "number" && firstStepTimestamp < existing.startedAt) {
        existing.startedAt = firstStepTimestamp;
      }
    }

    for (const actorId of Object.keys(actorThinkingAnchorRef.current)) {
      if (!activeActorIds.has(actorId)) {
        delete actorThinkingAnchorRef.current[actorId];
      }
    }
  }, [runningActors, runningActivityKey]);

  // Auto-init: mount 时自动创建 ActorSystem
  // ActorSystemStore 会负责恢复磁盘会话快照或补齐默认 Agent。
  const ensureSystem = useCallback(() => {
    const storeState = useActorSystemStore.getState();
    if (storeState.active) return;
    init({
      confirmDangerousAction,
    });
    sync();
  }, [confirmDangerousAction, init, sync]);

  useEffect(() => {
    if (active && !initRef.current) {
      initRef.current = true;
      ensureSystem();
    }
  }, [active, ensureSystem]);

  useEffect(() => {
    if (!pendingAICenterHandoff || pendingAICenterHandoff.mode !== "dialog") return;
    let cancelled = false;

    const applyHandoff = async () => {
      const payload = pendingAICenterHandoff.payload;
      ensureSystem();
      setInput(payload.query);
      clearAttachments();
      setIncomingHandoff(payload);
      const sessionId = getSystem()?.sessionId;
      if (sessionId && payload.sourceMode) {
        useAISessionRuntimeStore.getState().ensureSession({
          mode: "dialog",
          externalSessionId: sessionId,
          title: "Dialog 房间",
          updatedAt: Date.now(),
          source: {
            sourceMode: payload.sourceMode,
            sourceSessionId: payload.sourceSessionId,
            sourceLabel: payload.sourceLabel,
            summary: payload.summary,
          },
        });
      }

      if (payload.attachmentPaths?.length) {
        for (const path of payload.attachmentPaths) {
          if (cancelled) return;
          await addAttachmentFromPath(path);
        }
      }
    };

    void applyHandoff().finally(() => {
      if (!cancelled) {
        useAppStore.getState().setPendingAICenterHandoff(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [pendingAICenterHandoff, ensureSystem, clearAttachments, addAttachmentFromPath, getSystem]);

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

  const scrollDialogToBottom = useCallback((instant = false) => {
    const container = chatScrollRef.current;
    if (!container) return;

    if (instant) {
      container.scrollTop = container.scrollHeight;
    } else {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    dialogUserScrolledUpRef.current = false;
  }, []);

  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;

    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom > 280) {
        dialogUserScrolledUpRef.current = true;
      } else if (distanceFromBottom < 48) {
        dialogUserScrolledUpRef.current = false;
      }
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const lastDialogLengthRef = useRef(0);
  useEffect(() => {
    if (dialogHistory.length > lastDialogLengthRef.current) {
      requestAnimationFrame(() => {
        scrollDialogToBottom();
      });
    }
    lastDialogLengthRef.current = dialogHistory.length;
  }, [dialogHistory.length, scrollDialogToBottom]);

  useEffect(() => {
    if (!hasRunningActors) return;
    if (dialogUserScrolledUpRef.current) return;

    const now = Date.now();
    if (now - dialogScrollThrottleRef.current < 150) return;
    dialogScrollThrottleRef.current = now;

    const id = requestAnimationFrame(() => {
      const container = chatScrollRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [hasRunningActors, runningActivityKey]);

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
  const dialogMemoryWorkspaceId = useMemo(
    () => (
      (coordinatorActorId ? actorById.get(coordinatorActorId)?.workspace : undefined)
      ?? actors.find((actor) => typeof actor.workspace === "string" && actor.workspace.trim().length > 0)?.workspace
    ),
    [actorById, actors, coordinatorActorId],
  );

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
  const handleContinueWithAgent = useCallback(() => {
    const handoff = buildDialogAgentHandoff({
      dialogHistory,
      actorById,
      artifacts,
      sessionUploads,
      spawnedTasks,
      sourceSessionId: getSystem()?.sessionId,
    });
    if (!handoff) return;
    routeToAICenter({
      mode: "agent",
      source: "dialog_continue_to_agent",
      handoff,
      navigate: false,
    });
  }, [actorById, artifacts, dialogHistory, getSystem, sessionUploads, spawnedTasks]);
  const handleContinueSpawnedTaskWithAgent = useCallback((runId: string) => {
    const task = spawnedTasks.find((item) => item.runId === runId);
    if (!task) return;
    const handoff = buildDialogSpawnedTaskHandoff({
      task,
      targetActor: actorById.get(task.targetActorId),
      actorTodos: actorTodos[task.targetActorId] ?? [],
      dialogHistory,
      artifacts,
      actorNameById: new Map(actors.map((actor) => [actor.id, actor.roleName])),
      sourceSessionId: getSystem()?.sessionId,
    });
    if (!handoff) return;
    routeToAICenter({
      mode: "agent",
      source: "dialog_continue_to_agent",
      handoff,
      navigate: false,
    });
  }, [spawnedTasks, actorById, actorTodos, dialogHistory, artifacts, actors, getSystem]);
  const handleNewTopic = useCallback(() => {
    resetSession();
    setIncomingHandoff(null);
  }, [resetSession]);
  const handleFullReset = useCallback(() => {
    destroyAll();
    initRef.current = false;
    setIncomingHandoff(null);
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
  const queueDialogUserMemoryCapture = useCallback((rawText: string) => {
    const normalized = rawText.trim();
    if (!normalized) return;
    if (!shouldAutoSaveAssistantMemory(config)) return;
    const sessionId = getSystem()?.sessionId;
    Promise.resolve().then(async () => {
      try {
        await queueAssistantMemoryCandidates(normalized, {
          conversationId: sessionId,
          workspaceId: dialogMemoryWorkspaceId,
          sourceMode: "dialog",
        });
      } catch {
        // best-effort only: typing a message should never be blocked by memory extraction
      }
    });
  }, [config, dialogMemoryWorkspaceId, getSystem]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed && !hasAttachments) return;

    ensureSystem();
    const currentSystem = useActorSystemStore.getState().getSystem() ?? getSystem();
    if (!currentSystem) {
      setInputNotice("Dialog 房间尚未准备好，请稍后再试。");
      inputRef.current?.focus();
      return;
    }
    if (currentSystem.size === 0) {
      setInputNotice("当前房间还没有可执行的 Agent，请先检查 Agent 阵容，或等待房间恢复完成。");
      inputRef.current?.focus();
      return;
    }

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
    const committedDispatchInsight = inferDialogDispatchInsight({
      content,
      attachmentSummary: briefContent,
      attachmentPaths: inputAttachmentPaths,
      handoff: incomingHandoff,
    });

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
      setLastCommittedDispatchInsight(committedDispatchInsight);
      queueDialogUserMemoryCapture(trimmed);
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
      setIncomingHandoff(null);
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
    const planAttachmentSummary = finalBrief ?? attachmentSummary ?? undefined;
    const isSteerCommand = Boolean(targetId && finalContent.startsWith("!steer "));
    const shouldRouteToFocusedSession = Boolean(
      focusedSessionTask &&
      focusedSessionTask.sessionOpen &&
      !targetId &&
      !isSteerCommand,
    );
    const dispatchInsight = inferDialogDispatchInsight({
      content: finalContent,
      attachmentSummary: planAttachmentSummary,
      attachmentPaths: inputAttachmentPaths,
      handoff: incomingHandoff,
    });
    const smartRoutes = !targetId && routingMode === "smart" && finalContent
      ? routeTask(finalContent, dispatchInsight.preferredCapabilities)
      : [];
    const selectedSmartRoute = smartRoutes.length > 0 ? smartRoutes[0] : null;

    const system = currentSystem;
    let runtimePlan: DialogExecutionPlan | null = null;

    if (!effectiveReplyTarget && requirePlanApproval && !isSteerCommand) {
      if (shouldRouteToFocusedSession) {
        runtimePlan = null;
      } else {
        const planBundle = buildDialogDispatchPlanBundle({
          actors,
          routingMode,
          content: finalContent,
          attachmentSummary: planAttachmentSummary,
          attachmentPaths: inputAttachmentPaths,
          handoff: incomingHandoff,
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
            setShowConfig(false);
            setOverlay(null);
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
      setLastCommittedDispatchInsight(dispatchInsight);
      queueDialogUserMemoryCapture(cleanContent || trimmed);
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
            setIncomingHandoff(null);
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
    setIncomingHandoff(null);
    inputRef.current?.focus();
  }, [input, hasAttachments, imagePaths, attachments, fileContextBlock, attachmentSummary, ensureSystem, pendingUserInteractions, pendingInteractionByMessageId, selectedPendingMessageId, parseMention, actors, sendMessage, broadcastMessage, broadcastAndResolve, steer, replyToMessage, routingMode, routeTask, clearAttachments, requirePlanApproval, openPlanApprovalDialog, getSystem, coordinatorActorId, focusedSessionTask, messageById, queueDialogUserMemoryCapture, inputAttachmentPaths, incomingHandoff]);

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
      if (planApprovalActive) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape" && showMention) {
        setShowMention(false);
      }
    },
    [handleSend, planApprovalActive, showMention],
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

  const routingModeMeta = useMemo(
    () => ROUTING_MODES.find((mode) => mode.value === routingMode) ?? ROUTING_MODES[0],
    [routingMode],
  );

  const activeTodoCount = useMemo(
    () =>
      Object.values(actorTodos).reduce(
        (sum, todos) =>
          sum + todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length,
        0,
      ),
    [actorTodos],
  );

  const openSessionCount = useMemo(
    () => spawnedTasks.filter((task) => task.mode === "session" && task.sessionOpen).length,
    [spawnedTasks],
  );

  const coordinatorName = coordinatorActorId
    ? actorById.get(coordinatorActorId)?.roleName ?? null
    : null;
  const collaborationGraphAvailable = actors.length > 1 || dialogHistory.length > 0 || spawnedTasks.length > 0;

  const handleUseStarterPrompt = useCallback((prompt: string) => {
    setInput(prompt);
    setInputNotice(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "0px";
    const nextHeight = Math.min(Math.max(element.scrollHeight, 64), 180);
    element.style.height = `${nextHeight}px`;
  }, [input]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || openApprovalMessageId) return;
      if (showConfig) {
        setShowConfig(false);
        return;
      }
      if (overlay) {
        setOverlay(null);
        return;
      }
      if (workspacePanel) {
        setWorkspacePanel(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openApprovalMessageId, overlay, showConfig, workspacePanel]);

  const handleToggleConfig = useCallback(() => {
    setOverlay(null);
    setWorkspacePanel(null);
    setShowConfig((value) => !value);
  }, []);

  const handleToggleOverlay = useCallback((nextOverlay: DialogOverlay) => {
    setShowConfig(false);
    setWorkspacePanel(null);
    setOverlay((current) => (current === nextOverlay ? null : nextOverlay));
  }, []);

  const handleWorkspacePanelChange = useCallback((nextPanel: WorkspacePanel) => {
    setShowConfig(false);
    setOverlay(null);
    setWorkspacePanel(nextPanel);
  }, []);

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
    const dispatchInsight = inferDialogDispatchInsight({
      content,
      attachmentSummary: brief,
      attachmentPaths: inputAttachmentPaths,
      handoff: incomingHandoff,
    });
    const smartRoute = !targetId && routingMode === "smart" && content
      ? routeTask(content, dispatchInsight.preferredCapabilities)[0] ?? null
      : null;

    return buildDialogDispatchPlanBundle({
      actors,
      routingMode,
      content,
      attachmentSummary: brief,
      attachmentPaths: inputAttachmentPaths,
      handoff: incomingHandoff,
      mentionedTargetId: targetId,
      selectedRoute: smartRoute,
      coordinatorActorId,
    });
  }, [input, fileContextBlock, imagePaths, selectedPendingMessageId, pendingInteractionByMessageId, pendingUserInteractions, parseMention, attachmentSummary, routingMode, routeTask, actors, coordinatorActorId, inputAttachmentPaths, incomingHandoff]);
  const draftDispatchPlan = draftDispatchBundle?.clusterPlan ?? null;
  const draftDispatchInsight = draftDispatchBundle?.insight ?? null;
  const latestUserDispatchInsight = useMemo(() => {
    if (draftDispatchInsight) return null;

    const latestUserMessage = [...dialogHistory]
      .reverse()
      .find((message) =>
        message.from === "user"
        && message.kind === "user_input"
        && (message._briefContent || message.content).trim(),
      );

    if (!latestUserMessage) return null;

    const latestAttachmentSummary =
      latestUserMessage._briefContent
      && latestUserMessage._briefContent !== latestUserMessage.content
        ? latestUserMessage._briefContent
        : undefined;

    return inferDialogDispatchInsight({
      content: latestUserMessage.content,
      attachmentSummary: latestAttachmentSummary,
      attachmentPaths: latestUserMessage.images ?? [],
    });
  }, [dialogHistory, draftDispatchInsight]);
  const activeDispatchInsight = draftDispatchInsight ?? latestUserDispatchInsight ?? lastCommittedDispatchInsight;

  useEffect(() => {
    if (dialogHistory.length === 0) {
      setLastCommittedDispatchInsight(null);
      return;
    }
    if (latestUserDispatchInsight) {
      setLastCommittedDispatchInsight(latestUserDispatchInsight);
    }
  }, [dialogHistory.length, latestUserDispatchInsight]);

  // 图谱数据
  const graphData = useMemo(() => {
    if (overlay !== "graph") return null;
    try {
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
    <div className="relative flex h-full flex-col overflow-hidden bg-[var(--color-bg)]">
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Users className="h-4 w-4 text-[var(--color-accent)]" />
              <span className="text-[13px] font-semibold text-[var(--color-text)]">协作房间</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                actors.length > 0
                  ? "bg-emerald-500/10 text-emerald-600"
                  : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
              }`}>
                {actors.length > 0 ? `${actors.length} 个 Agent` : "等待配置"}
              </span>
              {coordinatorName && (
                <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                  协调者 {coordinatorName}
                </span>
              )}
              <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                {routingModeMeta.icon} {routingModeMeta.label}
              </span>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <button
                onClick={handleToggleConfig}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
                  showConfig
                    ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                    : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/25 hover:text-[var(--color-text)]"
                }`}
                title="Agent 设置"
              >
                <Settings2 className="w-3 h-3" />
                Agent 设置
              </button>
              <button
                onClick={() => handleToggleOverlay("tasks")}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
                  overlay === "tasks"
                    ? "border-blue-500/30 bg-blue-500/10 text-blue-600"
                    : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-blue-500/25 hover:text-blue-600"
                }`}
                title="任务中心"
              >
                <ListChecks className="w-3 h-3" />
                任务中心
              </button>
              {hasRunningActors && (
                <button
                  onClick={handleStop}
                  className="inline-flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/5 px-2.5 py-1 text-[10px] text-red-600 hover:border-red-500/35 hover:bg-red-500/10 transition-colors"
                >
                  <Square className="w-3 h-3" />
                  停止
                </button>
              )}
              {dialogHistory.length > 0 && (
                <button
                  onClick={handleContinueWithAgent}
                  className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-1 text-[10px] text-cyan-700 hover:border-cyan-500/35 hover:bg-cyan-500/10 transition-colors"
                  title="把当前多 Agent 协作上下文带到 Agent，继续落地执行"
                >
                  <ArrowRightCircle className="w-3 h-3" />
                  转 Agent
                </button>
              )}
            </div>
          </div>

          {(pendingUserInteractions.length > 0 || hasRunningActors || openSessionCount > 0 || activeTodoCount > 0 || dialogHistory.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
              {pendingUserInteractions.length > 0 && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700">
                  {pendingUserInteractions.length} 条待回复
                </span>
              )}
              {hasRunningActors && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-700">
                  {runningActors.length} 个运行中
                </span>
              )}
              {openSessionCount > 0 && (
                <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-blue-700">
                  {openSessionCount} 个子会话可继续
                </span>
              )}
              {activeTodoCount > 0 && (
                <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5">
                  {activeTodoCount} 个活跃待办
                </span>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {dialogHistory.length > 0 && (
                  <button
                    onClick={handleNewTopic}
                    className="inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-1 text-[10px] text-[var(--color-text-tertiary)] hover:border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-secondary)] transition-colors"
                    title="清空对话和 Agent 记忆，保留当前 Agent 阵容"
                  >
                    <RotateCcw className="w-3 h-3" />
                    新话题
                  </button>
                )}
                <button
                  onClick={handleFullReset}
                  className="inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-1 text-[10px] text-[var(--color-text-tertiary)] hover:border-red-500/20 hover:bg-red-500/5 hover:text-red-600 transition-colors"
                  title="销毁所有 Agent，回到初始状态"
                >
                  <Trash2 className="w-3 h-3" />
                  重置房间
                </button>
              </div>
            </div>
          )}

          {actors.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <ActorStatusBar actors={actors} compact />
              <div className="min-w-0 flex-1" />
              <DialogWorkspaceDock
                panel={workspacePanel}
                onPanelChange={handleWorkspacePanelChange}
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
                onContinueTaskWithAgent={handleContinueSpawnedTaskWithAgent}
                draftPlan={draftDispatchPlan}
                draftInsight={draftDispatchInsight}
                requirePlanApproval={requirePlanApproval}
                onTogglePlanApproval={setRequirePlanApproval}
                lastPlanReview={lastPlanReview}
                graphAvailable={collaborationGraphAvailable}
                onOpenGraph={collaborationGraphAvailable ? () => handleToggleOverlay("graph") : null}
              />
            </div>
          )}
        </div>
      </div>

      <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3.5">
          {dialogHistory.length === 0 && (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 px-4 py-4 text-center">
              <div className="flex flex-col items-center gap-1.5">
                <Bot className="w-5 h-5 text-[var(--color-text-tertiary)] opacity-60" />
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  {actors.length > 0 ? "从下方发起一条协作任务" : "先搭一个协作房间，再开始对话"}
                </div>
                <div className="text-[11px] text-[var(--color-text-secondary)]">
                  {actors.length > 0
                    ? "适合 review、debug、brainstorm 这类持续协作；如果目标是直接改代码，优先切到 Agent。"
                    : "建议先保留一个协调者，再按分析、编写或审查角色继续补充。"}
                </div>
                <div className="mt-0.5 flex flex-wrap justify-center gap-2">
                  {actors.length > 0
                    ? DIALOG_STARTER_PROMPTS.map((item) => (
                      <button
                        key={item.label}
                        onClick={() => handleUseStarterPrompt(item.prompt)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/25 hover:text-[var(--color-accent)] transition-colors"
                      >
                        {item.label}
                      </button>
                    ))
                    : (
                      <>
                        <button
                          onClick={() => handleApplyPreset("code_review")}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:border-cyan-500/25 hover:text-cyan-600 transition-colors"
                        >
                          快速建 Review 房间
                        </button>
                        <button
                          onClick={() => handleApplyPreset("debug_session")}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:border-amber-500/25 hover:text-amber-600 transition-colors"
                        >
                          快速建 Debug 房间
                        </button>
                        <button
                          onClick={() => handleApplyPreset("brainstorming")}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:border-emerald-500/25 hover:text-emerald-600 transition-colors"
                        >
                          快速建 Brainstorm 房间
                        </button>
                      </>
                    )}
                </div>
                <div className="flex flex-wrap justify-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
                  <button
                    onClick={() => {
                      setOverlay(null);
                      setWorkspacePanel(null);
                      setShowConfig(true);
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-1 hover:border-[var(--color-border)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors"
                  >
                    <Settings2 className="w-3 h-3" />
                    {actors.length > 0 ? "调整 Agent 阵容" : "管理 Agent"}
                  </button>
                  {actors.length > 0 && (
                    <button
                      onClick={() => handleWorkspacePanelChange("plan")}
                      className="inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-1 hover:border-[var(--color-border)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors"
                    >
                      <ShieldCheck className="w-3 h-3" />
                      查看执行计划
                    </button>
                  )}
                  {actors.length === 0 && (
                    <button
                      onClick={() => setRoutingMode("smart")}
                      className="inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-1 hover:border-[var(--color-border)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors"
                    >
                      <span>⚡</span>
                      默认改为智能路由
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {dialogHistory.length > 100 && !showAllMessages && (
            <button
              onClick={() => setShowAllMessages(true)}
              className="self-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-[11px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/25 hover:text-[var(--color-accent)] transition-colors"
            >
              加载更早的 {dialogHistory.length - 100} 条消息
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

          {runningActors.map((a, i) => {
            const color = getActorColor(actorIdToIndex.get(a.id) ?? i);
            const steps = a.currentTask?.steps ?? [];
            const hasPendingApproval = pendingUserInteractions.some(
              (interaction) => interaction.fromActorId === a.id && interaction.type === "approval",
            );
            const reversedSteps = [...steps].reverse();

            const latestStreamingAnswer = reversedSteps.find((s) => s.streaming && s.type === "answer");
            const latestThinkingStep = reversedSteps.find((s) => s.type === "thinking");
            const latestThoughtToolStep = hasPendingApproval
              ? undefined
              : reversedSteps.find((s) => {
                if (s.type !== "tool_streaming") return false;
                return buildToolStreamingPreview(s.content).kind === "thinking";
              });
            const latestThoughtToolPreview = latestThoughtToolStep
              ? buildToolStreamingPreview(latestThoughtToolStep.content)
              : null;
            const latestExecutionToolStep = hasPendingApproval
              ? undefined
              : reversedSteps.find((s) => {
                if (s.type !== "tool_streaming" || !s.streaming) return false;
                const kind = buildToolStreamingPreview(s.content).kind;
                return kind !== "thinking" && kind !== "artifact";
              });
            const latestExecutionToolPreview = latestExecutionToolStep
              ? buildToolStreamingPreview(latestExecutionToolStep.content)
              : null;
            const latestToolStreamingStep = hasPendingApproval
              ? undefined
              : reversedSteps.find((s) => {
                if (s.type !== "tool_streaming" || !s.streaming) return false;
                return buildToolStreamingPreview(s.content).kind === "artifact";
              });
            const latestToolStreamingPreview = latestToolStreamingStep
              ? buildToolStreamingPreview(latestToolStreamingStep.content)
              : null;
            const latestExecutionStateStep = reversedSteps.find(
              (s) => s.type === "action" || s.type === "observation" || s.type === "error",
            );
            const derivedThinkingContent = !latestThinkingStep && latestThoughtToolPreview?.kind === "thinking"
              ? latestThoughtToolPreview.body
              : undefined;

            const streamingContent = latestStreamingAnswer?.content;
            const thinkingContent = latestThinkingStep?.content ?? derivedThinkingContent;
            const toolStreamingContent = latestToolStreamingStep?.content;
            const showExecutionCard = Boolean(
              !streamingContent
              && !(latestThinkingStep || derivedThinkingContent)
              && !latestToolStreamingStep
              && (latestExecutionToolStep || latestExecutionStateStep),
            );
            const showThinkingPlaceholder = Boolean(
              !streamingContent
              && !latestToolStreamingStep
              && !showExecutionCard
              && !(latestThinkingStep || derivedThinkingContent)
              && a.currentTask?.status === "running",
            );
            const showThinkingBlock = Boolean(
              !streamingContent
              && !latestToolStreamingStep
              && !showExecutionCard
              && (latestThinkingStep || derivedThinkingContent || showThinkingPlaceholder),
            );
            const executionCardTitle = showExecutionCard
              ? describeAgentActivity(steps, a.roleName, false)
              : "";
            const executionCardDetail = latestExecutionToolPreview?.kind === "spawn"
              ? latestExecutionToolPreview.body
              : undefined;
            const executionCardIcon = latestExecutionToolPreview?.kind === "spawn"
              ? ArrowRightCircle
              : Settings2;
            const executionCardStartedAt = latestExecutionToolStep?.timestamp
              ?? latestExecutionStateStep?.timestamp
              ?? Date.now();
            const thinkingStartedAt = latestThinkingStep?.timestamp
              ?? latestThoughtToolStep?.timestamp
              ?? a.currentTask?.startedAt
              ?? actorThinkingAnchorRef.current[a.id]?.startedAt
              ?? Date.now();
            const thinkingIsStreaming = showThinkingPlaceholder
              || latestThinkingStep?.streaming
              || latestThoughtToolStep?.streaming
              || false;
            const hasRichLiveBlock = Boolean(
              showThinkingBlock
              || showExecutionCard
              || (latestToolStreamingStep && latestToolStreamingPreview?.kind === "artifact")
              || streamingContent,
            );

            return (
              <div key={`thinking-${a.id}`} className="space-y-2">
                {showThinkingBlock && (
                  <ThinkingBlock
                    roleName={a.roleName}
                    content={thinkingContent ?? ""}
                    startedAt={thinkingStartedAt}
                    isStreaming={thinkingIsStreaming}
                    color={color}
                  />
                )}

                {showExecutionCard && (
                  <LiveExecutionCard
                    roleName={a.roleName}
                    title={executionCardTitle}
                    detail={executionCardDetail}
                    startedAt={executionCardStartedAt}
                    isStreaming
                    color={color}
                    icon={executionCardIcon}
                  />
                )}

                {latestToolStreamingStep && latestToolStreamingPreview?.kind === "artifact" && (
                  <ToolStreamingBlock
                    roleName={a.roleName}
                    content={toolStreamingContent ?? ""}
                    startedAt={latestToolStreamingStep.timestamp}
                    isStreaming={latestToolStreamingStep.streaming ?? false}
                    color={color}
                  />
                )}

                {streamingContent && (
                  <div className={`flex gap-2 ${color.text}`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${color.bg}`}>
                      <Bot className="w-3.5 h-3.5" />
                    </div>
                    <div className="max-w-[88%] lg:max-w-[78%]">
                      <div className="text-[10px] mb-0.5">
                        {a.roleName}
                        <span className="text-[var(--color-text-tertiary)] ml-1">
                          正在输入中...
                        </span>
                      </div>
                      <div className={`inline-block text-[13px] leading-relaxed rounded-xl px-3 py-2 ${color.bg}`}>
                        <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 [&_p]:whitespace-pre-wrap [&_li]:whitespace-pre-wrap">
                          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                            {streamingContent}
                          </ReactMarkdown>
                          <span className="inline-block w-2 h-4 bg-current animate-pulse ml-0.5" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!hasRichLiveBlock && (
                  <div className={`flex items-center gap-2 ${color.text}`}>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span className="text-[11px] truncate max-w-[88%] lg:max-w-[78%]">
                      <span className="font-medium">{a.roleName}</span>
                      <span className="opacity-70 ml-1">
                        {describeAgentActivity(steps, a.roleName, !!streamingContent)}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}

          <div ref={chatEndRef} />
        </div>
      </div>

      <div
        className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)]/92 backdrop-blur-sm"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <div className="mx-auto w-full max-w-6xl px-3 py-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_ACCEPT_ALL}
            className="hidden"
            onChange={onFileSelect}
          />

          <div className="overflow-visible rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_12px_32px_-24px_rgba(15,23,42,0.35)]">
            {(incomingHandoff || focusedSessionTask || pendingUserInteractions.length > 0 || attachments.length > 0 || inputNotice) && (
              <div className="space-y-2 border-b border-[var(--color-border)] bg-[linear-gradient(135deg,rgba(15,23,42,0.02),transparent_45%)] px-3 py-2.5">
                {incomingHandoff?.sourceMode && (
                  <AICenterHandoffCard
                    handoff={incomingHandoff}
                    dismissLabel="仅隐藏提示"
                    onDismiss={() => setIncomingHandoff(null)}
                  />
                )}

                {focusedSessionTask && (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-500/15 bg-blue-500/10 px-3 py-1.5 text-[10px] text-blue-700">
                    <Network className="w-3 h-3" />
                    <span>
                      当前正在聚焦子会话：
                      {focusedSessionTask.label || (actorById.get(focusedSessionTask.targetActorId)?.roleName ?? focusedSessionTask.targetActorId)}
                    </span>
                    <button
                      onClick={() => focusSpawnedSession(null)}
                      className="ml-auto rounded-full border border-blue-500/20 px-2.5 py-1 text-[10px] hover:border-blue-500/40 transition-colors"
                    >
                      退出聚焦
                    </button>
                  </div>
                )}

                {pendingUserInteractions.length > 0 && pendingAgentNames && (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/15 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-700">
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
                            className={`rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
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
                          className="rounded-full border border-dashed border-[var(--color-border)] px-2.5 py-1 text-[10px] text-[var(--color-text-tertiary)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
                        >
                          作为新消息发送
                        </button>
                      )}
                    </div>
                    {inputNotice && (
                      <div className="px-1 text-[10px] text-amber-700">{inputNotice}</div>
                    )}
                  </div>
                )}

                {attachments.length > 0 && (
                  <div className="flex max-h-[96px] flex-wrap gap-1.5 overflow-y-auto pr-1">
                    {attachments.map((att) => (
                      <div
                        key={att.id}
                        className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[10px]"
                        title={att.name}
                      >
                        {att.type === "image" && att.preview ? (
                          <img src={att.preview} alt="" className="h-6 w-6 rounded-lg object-cover" />
                        ) : att.type === "folder" ? (
                          <FolderOpen className="w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
                        ) : (
                          <FileDown className="w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
                        )}
                        <span className="max-w-[140px] truncate text-[var(--color-text-secondary)]">{att.name}</span>
                        <button
                          onClick={() => removeAttachment(att.id)}
                          className="rounded-full p-1 text-[var(--color-text-tertiary)] hover:bg-red-500/10 hover:text-red-500 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {inputNotice && pendingUserInteractions.length === 0 && (
                  <div className="rounded-xl border border-amber-500/15 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-700">
                    {inputNotice}
                  </div>
                )}
              </div>
            )}

            <div className="relative" ref={inputWrapRef}>
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
                className="w-full resize-none bg-transparent px-3 pt-2.5 pb-2 text-[14px] leading-6 focus:outline-none min-h-[56px] max-h-[160px]"
                rows={1}
                placeholder={selectedPendingMessageId === NEW_MESSAGE_TARGET
                  ? "作为新消息发送，不会绑定到待回复问题..."
                  : selectedPendingInteractionLabel
                    ? `回复${selectedPendingInteractionLabel}...`
                    : focusedSessionTask
                      ? `继续和 ${actorById.get(focusedSessionTask.targetActorId)?.roleName ?? focusedSessionTask.targetActorId} 的子会话...`
                      : pendingUserInteractions.length > 0
                        ? `有 ${pendingUserInteractions.length} 条待回复交互，先选择要回复的问题...`
                        : "输入消息，Shift+Enter 换行，输入 @ 可指定发送给某个 Agent"}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onBlur={() => setTimeout(() => setShowMention(false), 150)}
              />
            </div>

            <div className="flex flex-col gap-2 border-t border-[var(--color-border)] px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
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
                {activeDispatchInsight?.autoModeLabel && (
                  <span
                    className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] text-emerald-700"
                    title={activeDispatchInsight.reasons.join(" · ")}
                  >
                    {draftDispatchInsight ? "自动" : "当前任务"} {activeDispatchInsight.autoModeLabel}
                    {activeDispatchInsight.focusLabel
                      ? ` · ${activeDispatchInsight.focusLabel}`
                      : ""}
                  </span>
                )}
                {selectedPendingInteractionLabel ? (
                  <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[10px] text-amber-700">
                    当前回复 {selectedPendingInteractionLabel}
                  </span>
                ) : focusedSessionTask ? (
                  <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[10px] text-blue-700">
                    已聚焦子会话
                  </span>
                ) : coordinatorName ? (
                  <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)]">
                    默认发给 {coordinatorName}
                  </span>
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-3 sm:justify-end">
                <span className="hidden text-[10px] text-[var(--color-text-tertiary)] sm:inline">
                  Enter 发送 · Shift+Enter 换行
                </span>
                <button
                  onClick={handleSend}
                  disabled={!input.trim() && !hasAttachments}
                  className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--color-accent)] px-3.5 text-[11px] font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Send className="w-3.5 h-3.5" />
                  发送
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showConfig && (
        <>
          <div className="absolute inset-0 z-30 bg-black/20" onClick={() => setShowConfig(false)} />
          <div className="absolute inset-3 z-[35] flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl md:inset-y-3 md:right-3 md:left-auto md:w-[min(460px,calc(100%-1rem))]">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 py-3 backdrop-blur-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--color-text)]">Agent 设置</span>
                  <span className="rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                    {actors.length} 个 Agent
                  </span>
                </div>
                <div className="mt-1 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
                  预设、当前阵容和新增 Agent 都在这里。
                </div>
              </div>
              <button
                onClick={() => setShowConfig(false)}
                className="rounded-xl p-1.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto bg-[var(--color-bg-secondary)]/35 px-3 py-3 space-y-3">
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-2.5">
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                  预设
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {DIALOG_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      className="rounded-full border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
                      onClick={() => handleApplyPreset(preset.id)}
                      title={preset.description}
                    >
                      {preset.name}
                    </button>
                  ))}
                  {customPresets.map((preset) => (
                    <button
                      key={preset.id}
                      className="rounded-full border border-fuchsia-500/25 px-2 py-1 text-[10px] text-fuchsia-600 hover:border-fuchsia-500/45 hover:text-fuchsia-500 transition-colors"
                      onClick={() => handleApplyPreset(preset.id)}
                      title={preset.description}
                    >
                      {preset.name}
                    </button>
                  ))}
                  <button
                    onClick={handleSaveCurrentAsPreset}
                    className="rounded-full border border-dashed border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-tertiary)] hover:border-green-500/35 hover:text-green-600 transition-colors"
                    title="保存当前 Agent 配置为新预设"
                  >
                    + 保存当前
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                    当前 Agent
                  </div>
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">
                    {actors.length} 个在线配置
                  </span>
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
                    <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-3 text-[11px] text-[var(--color-text-tertiary)]">
                      暂无 Agent，先创建一个协调者即可开始。
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
                  添加 Agent
                </div>
                <AddAgentForm
                  models={models}
                  existingNames={actors.map((a) => a.roleName)}
                  onAdd={handleAddAgent}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {overlay && (
        <>
          <div className="absolute inset-0 z-30 bg-black/20" onClick={() => setOverlay(null)} />
          <div
            className={`absolute inset-3 z-[35] flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl md:inset-y-3 md:right-3 md:left-auto ${
              overlay === "graph"
                ? "md:w-[min(680px,calc(100%-1rem))]"
                : "md:w-[min(520px,calc(100%-1rem))]"
            }`}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 py-3 backdrop-blur-sm">
              <div>
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  {overlay === "tasks" ? "任务中心" : "协作图"}
                </div>
                <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                  {overlay === "tasks"
                    ? "查看全局任务执行情况，不打断当前对话流。"
                    : "用于观察角色关系、消息流和子任务派发，本身不会改变对话结果。"}
                </div>
              </div>
              <button
                onClick={() => setOverlay(null)}
                className="rounded-xl p-1.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <Suspense fallback={<div className="p-4 text-xs text-[var(--color-text-secondary)]">加载中...</div>}>
                {overlay === "tasks" && <TaskCenterPanel />}
                {overlay === "graph" && graphData && (
                  graphData.nodes.length > 0
                    ? <KnowledgeGraphView data={graphData} className="h-full" />
                    : (
                      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[var(--color-text-secondary)]">
                        当前协作还没有形成可观察的结构，等房间里出现多 Agent、消息往来或子任务后，这里才会更有价值。
                      </div>
                    )
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
