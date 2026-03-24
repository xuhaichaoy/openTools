import React, { useState, useCallback, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import { useShallow } from "zustand/shallow";
import {
  Users,
  MessageSquareText,
  Smartphone,
  Square,
  Loader2,
  Trash2,
  Send,
  Settings2,
  Bot,
  User,
  X,
  Reply,
  AlertTriangle,
  ChevronDown,
  FileDown,
  FolderOpen,
  RotateCcw,
  ListChecks,
  Brain,
  ShieldCheck,
  ArrowRightCircle,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AICenterHandoffCard } from "@/components/ai/AICenterHandoffCard";
import {
  buildDialogDispatchPlanBundle,
  buildClusterPresentationFromDraft,
  buildExecutionContractDraftFromDialog,
  inferDialogDispatchInsight,
  type DialogDispatchInsight,
} from "@/core/agent/actor/dialog-dispatch-plan";
import { buildDialogSpawnedTaskHandoff } from "@/core/agent/actor/spawned-task-checkpoint";
import {
  describeCodingExecutionProfile,
  inferCodingExecutionProfile,
} from "@/core/agent/coding-profile";
import { useActorSystemStore, type ActorSnapshot } from "@/store/actor-system-store";
import { useAIStore } from "@/store/ai-store";
import { useAppStore, type AICenterHandoff } from "@/store/app-store";
import { useAISessionRuntimeStore } from "@/store/ai-session-runtime-store";
import {
  useClusterPlanApprovalStore,
  type ApprovalDialogPresentation,
} from "@/store/cluster-plan-approval-store";
import { useConfirmDialogStore } from "@/store/confirm-dialog-store";
import { useToolTrustStore } from "@/store/command-allowlist-store";
import {
  getChannelManager,
  loadSavedChannels,
  saveSavedChannels,
  type ChannelStatus,
  type ChannelType,
  type SavedChannelEntry,
} from "@/core/channels";
import {
  buildAICenterHandoffScopedFileRefs,
  getAICenterHandoffImportPaths,
  normalizeAICenterHandoff,
} from "@/core/ai/ai-center-handoff";
import { routeToAICenter } from "@/core/ai/ai-center-routing";
import { buildDialogContextBreakdown, type DialogContextBreakdown } from "@/core/ai/dialog-context-breakdown";
import { buildDialogWorkingSetSnapshot } from "@/core/ai/ai-working-set";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { normalizeAIProductMode } from "@/core/ai/ai-mode-types";
import {
  abortRuntimeSession,
  buildRuntimeSessionKey,
  getForegroundRuntimeSession,
  useRuntimeStateStore,
  type RuntimeSessionRecord,
} from "@/core/agent/context-runtime/runtime-state";
import { type DialogContextSnapshot } from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";
import { KnowledgeGraph } from "@/core/knowledge/knowledge-graph";
import { queueAssistantMemoryCandidates } from "@/core/ai/assistant-memory";
import { shouldAutoSaveAssistantMemory } from "@/core/ai/assistant-config";
import { DIALOG_FULL_ROLE } from "@/core/agent/actor/agent-actor";
import { getSpawnedTaskRoleBoundaryMeta } from "@/core/agent/actor/spawned-task-role-boundary";
import type {
  DialogArtifactRecord,
  DialogContextSummary,
  DialogMessage,
  DialogQueuedFollowUp,
  DialogRoomCompactionState,
  PendingInteraction,
  SessionUploadRecord,
  SpawnedTaskEventDetail,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
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
import { buildDialogContextSummary } from "@/core/agent/actor/dialog-session-summary";
import type { TodoItem } from "@/core/agent/actor/middlewares";
import type {
  AgentStep,
  DangerousActionConfirmationContext,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ClusterPlan } from "@/core/agent/cluster/types";
import {
  useInputAttachments,
  FILE_ACCEPT_ALL,
  composeInputWithAttachmentSummary,
  type InputAttachment,
} from "@/hooks/use-input-attachments";
import { AttachDropdown } from "@/components/ui/AttachDropdown";
import { DialogFollowUpDock } from "./DialogFollowUpDock";
import { DialogContextStrip } from "./DialogContextStrip";
import { ChannelSessionBoard, buildDialogChannelGroups, formatSessionStripTime, getDialogChannelConnectionLabel, getDialogViewLabel, inferIMChannelType, type DialogChannelConnectionMeta, type DialogSessionViewKey, type DialogTopSessionItem } from "./actor-chat-panel/DialogChannelBoard";
import { DialogChildSessionStrip } from "./actor-chat-panel/DialogChildSessionStrip";
import {
  ActorStatusBar,
  AddAgentForm,
  getActorColor,
  LiveActorRow,
  MentionPopup,
  normalizeAgentCapabilities,
  ROUTING_MODES,
  RoutingModeButton,
  useAvailableModels,
  type AddActorDraft,
} from "./actor-chat-panel/ActorControls";
import { ApprovalRequestDrawer, MessageBubble } from "./actor-chat-panel/MessageBubble";
import {
  buildToolStreamingPreview,
  LiveExecutionCard,
  ThinkingBlock,
  ToolStreamingBlock,
} from "./actor-chat-panel/StreamingBlocks";
import { DialogWorkspaceDock, type DialogArtifact, type WorkspacePanel } from "./actor-chat-panel/WorkspaceDock";
import { useToast } from "@/components/ui/Toast";
import { modelSupportsImageInput } from "@/core/ai/model-capabilities";
import { createLogger } from "@/core/logger";
import {
  useIMConversationRuntimeStore,
  type IMConversationSnapshot,
  type IMConversationSessionPreview,
} from "@/store/im-conversation-runtime-store";
import { getRuntimeIndicatorStatus } from "@/core/agent/context-runtime/runtime-indicator";
import {
  assessExecutionContractApproval,
  type ExecutionContractApprovalAssessment,
} from "@/core/collaboration/contract-approval";

const TaskCenterPanel = lazy(() => import("../TaskCenterPanel"));
const KnowledgeGraphView = lazy(() => import("../KnowledgeGraphView"));
const dialogRenderLogger = createLogger("DialogRender");

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

const EMPTY_DIALOG_ACTORS: ActorSnapshot[] = [];
const EMPTY_DIALOG_HISTORY: DialogMessage[] = [];
const EMPTY_PENDING_INTERACTIONS: PendingInteraction[] = [];
const EMPTY_SPAWNED_TASKS: SpawnedTaskRecord[] = [];
const EMPTY_DIALOG_ARTIFACTS: DialogArtifactRecord[] = [];
const EMPTY_SESSION_UPLOADS: SessionUploadRecord[] = [];
const EMPTY_QUEUED_FOLLOW_UPS: DialogQueuedFollowUp[] = [];
const EMPTY_ACTOR_TODOS: Record<string, TodoItem[]> = {};
const EMPTY_RUNTIME_SESSIONS: Record<string, RuntimeSessionRecord> = {};
const EMPTY_IM_CONVERSATIONS: IMConversationSnapshot[] = [];
const EMPTY_IM_SESSION_PREVIEWS: Record<string, IMConversationSessionPreview> = {};

type DialogPlanReview = {
  status: "approved" | "rejected";
  timestamp: number;
  plan?: ClusterPlan;
  source: "human" | "auto_review" | "policy";
  risk?: ExecutionContractApprovalAssessment["risk"];
  reason?: string;
};

function mapTrustLevelToContractTrustMode(
  trustLevel: ReturnType<typeof useToolTrustStore.getState>["trustLevel"],
): "strict_manual" | "auto_review" | "full_auto" {
  switch (trustLevel) {
    case "always_ask":
      return "strict_manual";
    case "auto_approve":
      return "full_auto";
    default:
      return "auto_review";
  }
}

function contractRiskLabel(risk: ExecutionContractApprovalAssessment["risk"]): string {
  switch (risk) {
    case "safe":
      return "安全";
    case "low":
      return "低风险";
    case "medium":
      return "中风险";
    case "high":
      return "高风险";
    default:
      return "不确定";
  }
}

function mergeUniqueLines(lines: Array<string | undefined | null>): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const normalized = String(line ?? "").trim();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

function decorateBoundaryApprovalPresentation(
  presentation: ApprovalDialogPresentation,
  assessment: ExecutionContractApprovalAssessment,
): ApprovalDialogPresentation {
  if (presentation.kind !== "boundary") return presentation;
  const riskLabel = contractRiskLabel(assessment.risk);
  const layerLabel = assessment.layer === "human"
    ? "自动审核建议升级到人工确认"
    : assessment.layer === "auto_review"
      ? "自动审核允许直接通过"
      : "当前策略可直接放行";
  return {
    ...presentation,
    title: assessment.risk === "high" || assessment.risk === "unknown"
      ? "确认高风险协作边界"
      : presentation.title,
    description: `${layerLabel}。当前判定为${riskLabel}：${assessment.reason}`,
    permissions: mergeUniqueLines([
      ...presentation.permissions,
      ...assessment.permissions,
    ]),
    notes: mergeUniqueLines([
      `自动审核：${riskLabel} · ${assessment.reason}`,
      ...assessment.notes,
      ...(presentation.notes ?? []),
    ]),
  };
}

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

function describeAgentActivity(
  steps: AgentStep[],
  roleName: string,
  hasStreamingContent: boolean,
  taskStatus?: "pending" | "running" | "completed" | "error" | "aborted",
): string {
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
        const roleBoundary = getSpawnedTaskRoleBoundaryMeta(
          String(prevAction.toolInput?.role_boundary ?? prevAction.toolInput?.roleBoundary ?? "").trim() as SpawnedTaskRecord["roleBoundary"],
        );
        const codingLabel = describeCodingExecutionProfile(
          inferCodingExecutionProfile({ query: taskText }).profile,
        );
        if (target && codingLabel && roleBoundary.shortLabel !== "支援") return `${codingLabel} · ${roleBoundary.shortLabel} 已派发给 ${target}`;
        if (target && codingLabel) return `${codingLabel} 子任务已派发给 ${target}`;
        if (target && roleBoundary.shortLabel !== "支援") return `${roleBoundary.label} 已派发给 ${target}`;
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

  if (latest.type === "answer") {
    if (taskStatus === "completed") return "已生成最终回复";
    return "生成回复中";
  }
  if (latest.type === "error") {
    if (taskStatus === "error") return "处理失败";
    if (taskStatus === "aborted") return "已中止";
    return "遇到错误，处理中";
  }

  return `${roleName} 正在思考`;
}

function buildActionDetail(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file":
    case "read_file_range":
      return `文件: ${String(input.path ?? "")}`;
    case "search_in_files":
      return `搜索: "${String(input.query ?? "")}"${input.path ? ` in ${String(input.path)}` : ""}`;
    case "list_directory":
      return `目录: ${String(input.path ?? "")}`;
    case "write_file":
    case "str_replace_edit":
    case "json_edit":
      return `编辑: ${String(input.path ?? "")}`;
    case "run_shell_command":
    case "persistent_shell":
      return `命令: ${String(input.command ?? "").slice(0, 80)}`;
    case "web_search":
      return `搜索: "${String(input.query ?? "")}"`;
    case "web_fetch":
      return `访问: ${String(input.url ?? "").slice(0, 60)}`;
    case "spawn_task":
      return `派发: ${String(input.target_agent ?? "")} - ${String(input.task ?? "").slice(0, 60)}`;
    default:
      return toolName;
  }
}

function normalizeCurrentTaskStatus(
  status?: string,
): "pending" | "running" | "completed" | "error" | "aborted" | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "completed":
    case "error":
    case "aborted":
      return status;
    default:
      return undefined;
  }
}

function truncateWorkflowText(value: string | undefined, max = 80): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
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
  dialogContextSummary?: DialogContextSummary | null;
  dialogRoomCompaction?: DialogRoomCompactionState | null;
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
    dialogContextSummary,
    dialogRoomCompaction,
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
    actorNameById,
    extraAttachmentPaths: recentMessages.flatMap((message) => message.images || []),
    maxArtifacts,
    maxSpawnedTasks,
    maxAttachmentPaths,
  });
  const attachmentPaths = workingSet.attachmentPaths;
  const visualAttachmentPaths = workingSet.visualAttachmentPaths;

  const intro = visualAttachmentPaths.length > 0
    ? "以下是之前 Dialog 协作房间的最近上下文，并已附带当前仍相关的视觉参考图与文件，请继续落地执行："
    : attachmentPaths.length > 0
      ? "以下是之前 Dialog 协作房间的最近上下文，并已附带相关图片/文件，请继续落地执行："
      : "以下是之前 Dialog 协作房间的最近上下文，请继续落地执行：";
  const earlyRoomSummary = dialogRoomCompaction
    ? `已压缩更早的 ${dialogRoomCompaction.compactedMessageCount} 条房间消息：\n${dialogRoomCompaction.summary}`
    : dialogContextSummary
      ? `已整理更早的 ${dialogContextSummary.summarizedMessageCount} 条房间消息：\n${dialogContextSummary.summary}`
      : "";
  const visualSummary = workingSet.visualSummaryLine ?? "";
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
    earlyRoomSummary ? `---\n\n${earlyRoomSummary}` : "",
    transcript,
    spawnedTaskSummary ? `---\n\n${spawnedTaskSummary}` : "",
    artifactSummary ? `---\n\n${artifactSummary}` : "",
    visualSummary ? `---\n\n${visualSummary}` : "",
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
    ...(visualAttachmentPaths.length > 0 ? { visualAttachmentPaths } : {}),
    title: "延续 Dialog 协作房间",
    goal: summarizeAISessionRuntimeText(
      latestUserMessage?._briefContent || latestUserMessage?.content,
      120,
    ) || "延续 Dialog 房间中的当前协作任务",
    intent: inferredCoding.profile.codingMode ? "coding" : "delivery",
    keyPoints: [
      dialogRoomCompaction
        ? `已压缩更早的 ${dialogRoomCompaction.compactedMessageCount} 条房间消息`
        : dialogContextSummary
          ? `已整理更早的 ${dialogContextSummary.summarizedMessageCount} 条房间消息`
          : "",
      `带入最近 ${recentMessages.length} 条 Dialog 消息`,
      visualAttachmentPaths.length > 0 ? `${visualAttachmentPaths.length} 张视觉参考图` : "",
      workingSet.artifactSummaryLines.length > 0 ? `${workingSet.artifactSummaryLines.length} 条产物线索` : "",
      workingSet.spawnedTaskSummaryLines.length > 0 ? `${workingSet.spawnedTaskSummaryLines.length} 条子任务线索` : "",
    ].filter(Boolean),
    nextSteps: [
      "先阅读 Dialog 最近讨论与工作集，再继续执行或收束结论",
      visualAttachmentPaths.length > 0 ? "先结合视觉参考图理解界面/截图，再决定具体实现或修改" : "",
      workingSet.openSessionCount > 0 ? `注意当前仍有 ${workingSet.openSessionCount} 个开放子会话线索` : "",
    ].filter(Boolean),
    contextSections: [
      dialogRoomCompaction
        ? { title: "房间压缩保留", items: [dialogRoomCompaction.summary] }
        : dialogContextSummary
          ? { title: "早期协作摘要", items: [dialogContextSummary.summary] }
        : null,
      visualAttachmentPaths.length > 0 && visualSummary
        ? { title: "视觉参考", items: [visualSummary] }
        : null,
      workingSet.spawnedTaskSummaryLines.length > 0
        ? { title: "子任务概览", items: workingSet.spawnedTaskSummaryLines }
        : null,
      workingSet.artifactSummaryLines.length > 0
        ? { title: "产物线索", items: workingSet.artifactSummaryLines }
        : null,
    ].filter((section): section is { title: string; items: string[] } => Boolean(section)),
    files: buildAICenterHandoffScopedFileRefs({
      attachmentPaths,
      visualAttachmentPaths,
      visualReason: "Dialog 视觉参考图",
      attachmentReason: "Dialog 工作集文件",
    }),
    sourceMode: "dialog",
    ...(sourceSessionId ? { sourceSessionId } : {}),
    sourceLabel: "Dialog 房间",
    summary: workingSet.summary,
  });
}

const generateId = () =>
  Math.random().toString(36).substring(2, 8);

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

const FILE_PATH_REGEX = /(?:\/[\w.\-/]+\.(?:xlsx|csv|pdf|docx|pptx|xls))/g;
const NEW_MESSAGE_TARGET = "__new_message__";
const DIALOG_PLAN_APPROVAL_KEY = "dialog-plan-approval-enabled";
// ── Main Panel ──

export function ActorChatPanel({
  active = true,
  productMode = "dialog",
}: {
  active?: boolean;
  productMode?: "dialog" | "review";
}) {
  const [showConfig, setShowConfig] = useState(false);
  const [overlay, setOverlay] = useState<DialogOverlay>(null);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>(null);
  const [input, setInput] = useState("");
  const [showMention, setShowMention] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [customPresets, setCustomPresets] = useState<DialogPreset[]>([]);
  /** 路由模式：coordinator=只发给第一个，smart=智能路由，broadcast=发给所有 */
  const [routingMode, setRoutingMode] = useState<DialogRoutingMode>("coordinator");
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [selectedPendingMessageId, setSelectedPendingMessageId] = useState<string | null>(null);
  const [pendingSteerSessionRunId, setPendingSteerSessionRunId] = useState<string | null>(null);
  const [openApprovalMessageId, setOpenApprovalMessageId] = useState<string | null>(null);
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  const [selectedSpawnRunId, setSelectedSpawnRunId] = useState<string | null>(null);
  const [lastCommittedDispatchInsight, setLastCommittedDispatchInsight] = useState<DialogDispatchInsight | null>(null);
  const [manualDialogView, setManualDialogView] = useState<DialogSessionViewKey | null>(null);
  const [requirePlanApproval, setRequirePlanApproval] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DIALOG_PLAN_APPROVAL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [lastPlanReview, setLastPlanReview] = useState<DialogPlanReview | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initRef = useRef(false);
  const dialogUserScrolledUpRef = useRef(false);
  const dialogScrollThrottleRef = useRef(0);
  const actorThinkingAnchorRef = useRef<Record<string, { taskId: string; startedAt: number }>>({});
  const streamingAnswerRenderRef = useRef<Record<string, {
    taskId: string;
    maxVisibleLength: number;
    lastVisibleLength: number;
  }>>({});
  const queuedFollowUpDispatchRef = useRef(false);
  const lastDialogSelectionRef = useRef<string | null>(null);
  const dialogSurfaceMode = productMode === "review" ? "review" : "dialog";
  const isReviewSurface = dialogSurfaceMode === "review";

  const {
    active: systemActive, actors, dialogHistory, pendingUserInteractions, spawnedTasks, artifacts: structuredArtifacts,
    sessionUploads, queuedFollowUps, dialogRoomCompaction,
    coordinatorActorId, actorTodos, sourceHandoff: incomingHandoff, contextSnapshot, collaborationSnapshot,
    init, spawnActor, killActor, destroyAll,
    abortAll, closeSpawnedSession, abortSpawnedSession, resetSession, removeFollowUp, clearQueuedFollowUps,
    dispatchDialogInput, replyToPendingInteraction, applyDraftExecutionContract, runQueuedFollowUp,
    sync, routeTask, getSystem, setSourceHandoff,
    setCoordinator, reorderActors, updateActorConfig,
  } = useActorSystemStore(
    useShallow((state) => ({
      active: active ? state.active : false,
      actors: active ? state.actors : EMPTY_DIALOG_ACTORS,
      dialogHistory: active ? state.dialogHistory : EMPTY_DIALOG_HISTORY,
      pendingUserInteractions: active ? state.pendingUserInteractions : EMPTY_PENDING_INTERACTIONS,
      spawnedTasks: active ? state.spawnedTasks : EMPTY_SPAWNED_TASKS,
      artifacts: active ? state.artifacts : EMPTY_DIALOG_ARTIFACTS,
      sessionUploads: active ? state.sessionUploads : EMPTY_SESSION_UPLOADS,
      queuedFollowUps: active ? state.queuedFollowUps : EMPTY_QUEUED_FOLLOW_UPS,
      dialogRoomCompaction: active ? state.dialogRoomCompaction : null,
      coordinatorActorId: active ? state.coordinatorActorId : null,
      actorTodos: active ? state.actorTodos : EMPTY_ACTOR_TODOS,
      sourceHandoff: active ? state.sourceHandoff : null,
      contextSnapshot: active ? state.contextSnapshot : null,
      collaborationSnapshot: active ? state.collaborationSnapshot : null,
      init: state.init,
      spawnActor: state.spawnActor,
      killActor: state.killActor,
      destroyAll: state.destroyAll,
      abortAll: state.abortAll,
      closeSpawnedSession: state.closeSpawnedSession,
      abortSpawnedSession: state.abortSpawnedSession,
      resetSession: state.resetSession,
      removeFollowUp: state.removeFollowUp,
      clearQueuedFollowUps: state.clearQueuedFollowUps,
      dispatchDialogInput: state.dispatchDialogInput,
      replyToPendingInteraction: state.replyToPendingInteraction,
      applyDraftExecutionContract: state.applyDraftExecutionContract,
      runQueuedFollowUp: state.runQueuedFollowUp,
      sync: state.sync,
      routeTask: state.routeTask,
      getSystem: state.getSystem,
      setSourceHandoff: state.setSourceHandoff,
      setCoordinator: state.setCoordinator,
      reorderActors: state.reorderActors,
      updateActorConfig: state.updateActorConfig,
    })),
  );

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
  const pendingAICenterHandoff = useAppStore((s) => (active ? s.pendingAICenterHandoff : null));
  const config = useAIStore((s) => s.config);
  const { toast } = useToast();
  const [dialogSavedChannels, setDialogSavedChannels] = useState<SavedChannelEntry[]>([]);
  const [dialogChannelStatuses, setDialogChannelStatuses] = useState<Record<string, ChannelStatus>>({});
  const [dialogChannelConnectPending, setDialogChannelConnectPending] = useState<
    Partial<Record<"dingtalk" | "feishu", boolean>>
  >({});
  const { runtimeSessions, foregroundDialogSessionId, foregroundIMConversationSessionId } = useRuntimeStateStore(
    useShallow((state) => ({
      runtimeSessions: active ? state.sessions : EMPTY_RUNTIME_SESSIONS,
      foregroundDialogSessionId: active ? state.foregroundSessionIds.dialog : undefined,
      foregroundIMConversationSessionId: active ? state.foregroundSessionIds.im_conversation : undefined,
    })),
  );
  const { imConversations, imSessionPreviews } = useIMConversationRuntimeStore(
    useShallow((state) => ({
      imConversations: active ? state.conversations : EMPTY_IM_CONVERSATIONS,
      imSessionPreviews: active ? state.sessionPreviews : EMPTY_IM_SESSION_PREVIEWS,
    })),
  );
  const refreshDialogChannelMeta = useCallback(() => {
    const saved = loadSavedChannels();
    setDialogSavedChannels(saved);
    const statusMap: Record<string, ChannelStatus> = {};
    for (const status of getChannelManager().getStatuses()) {
      statusMap[status.id] = status.status;
    }
    setDialogChannelStatuses(statusMap);
  }, []);

  useEffect(() => {
    if (!active) return;
    refreshDialogChannelMeta();
    const timer = window.setInterval(refreshDialogChannelMeta, 4000);
    return () => window.clearInterval(timer);
  }, [active, refreshDialogChannelMeta]);

  const actorById = useMemo(() => {
    const map = new Map<string, ActorSnapshot>();
    actors.forEach((a) => map.set(a.id, a));
    return map;
  }, [actors]);
  const contractApprovalActors = useMemo(
    () => actors.map((actor) => ({
      id: actor.id,
      roleName: actor.roleName,
      executionPolicy: actor.normalizedExecutionPolicy,
    })),
    [actors],
  );
  const dialogMemoryWorkspaceId = useMemo(
    () => (
      (coordinatorActorId ? actorById.get(coordinatorActorId)?.workspace : undefined)
      ?? actors.find((actor) => typeof actor.workspace === "string" && actor.workspace.trim().length > 0)?.workspace
    ),
    [actorById, actors, coordinatorActorId],
  );
  const runningActors = useMemo(() => actors.filter((a) => a.status === "running"), [actors]);
  const confirmDangerousAction = useCallback(
    (
      toolName: string,
      params: Record<string, unknown>,
      context?: DangerousActionConfirmationContext,
    ): Promise<boolean> => {
      const toolTrust = useToolTrustStore.getState();
      const cachedDecision = toolTrust.getCachedDecision(toolName, params);
      if (cachedDecision !== null) {
        return Promise.resolve(cachedDecision);
      }
      const assessment = toolTrust.assess(toolName, params, {
        executionPolicy: context?.executionPolicy,
        workspace: context?.workspace ?? dialogMemoryWorkspaceId,
      });
      if (assessment.decision !== "ask") {
        toolTrust.rememberDecision(toolName, params, true);
        return Promise.resolve(true);
      }
      return openConfirmDialog({
        source: "actor_dialog",
        toolName,
        params,
        risk: assessment.risk,
        reason: assessment.reason,
      }).then((confirmed) => {
        toolTrust.rememberDecision(toolName, params, confirmed);
        return confirmed;
      });
    },
    [dialogMemoryWorkspaceId, openConfirmDialog],
  );
  const hasRunningActors = runningActors.length > 0;
  const currentRoomSessionId = getSystem()?.sessionId ?? null;
  const dialogChannelGroups = useMemo(
    () =>
      buildDialogChannelGroups({
        currentRoomSessionId,
        conversations: imConversations,
        runtimeSessions,
        sessionPreviews: imSessionPreviews,
      }),
    [currentRoomSessionId, imConversations, imSessionPreviews, runtimeSessions],
  );
  const dialogChannelConnectionMeta = useMemo<Record<"dingtalk" | "feishu", DialogChannelConnectionMeta>>(() => {
    const buildMeta = (channelType: "dingtalk" | "feishu"): DialogChannelConnectionMeta => {
      const entries = dialogSavedChannels.filter((entry) => entry.config.type === channelType);
      const configured = entries.length > 0;
      const statuses = entries.map((entry) => dialogChannelStatuses[entry.config.id] ?? "disconnected");
      const connectedCount = statuses.filter((status) => status === "connected").length;
      const hasConnecting = Boolean(dialogChannelConnectPending[channelType]) || statuses.some((status) => status === "connecting");
      const hasError = statuses.some((status) => status === "error");
      const hasLiveConversation = dialogChannelGroups[channelType].conversations.length > 0;
      const connectionState: DialogChannelConnectionMeta["connectionState"] = !configured
        ? (hasLiveConversation ? "unconfigured" : "unconfigured")
        : connectedCount > 0
          ? "connected"
          : hasConnecting
            ? "connecting"
            : hasError
              ? "error"
              : "disconnected";
      return {
        channelType,
        entries,
        configured,
        connectionState,
        connectionLabel: getDialogChannelConnectionLabel(connectionState, configured, connectedCount),
        canAutoConnect: configured && connectionState !== "connected" && connectionState !== "connecting",
      };
    };

    return {
      dingtalk: buildMeta("dingtalk"),
      feishu: buildMeta("feishu"),
    };
  }, [dialogChannelConnectPending, dialogChannelGroups, dialogChannelStatuses, dialogSavedChannels]);
  const selectedDialogSessionId = useMemo(() => {
    const normalizedIM = foregroundIMConversationSessionId?.trim() || "";
    if (normalizedIM) return normalizedIM;
    const normalized = foregroundDialogSessionId?.trim() || "";
    if (normalized) return normalized;
    return currentRoomSessionId;
  }, [currentRoomSessionId, foregroundDialogSessionId, foregroundIMConversationSessionId]);
  const derivedDialogView = useMemo<DialogSessionViewKey>(() => {
    if (!selectedDialogSessionId || selectedDialogSessionId === currentRoomSessionId) {
      return "local";
    }
    const preview = imSessionPreviews[selectedDialogSessionId];
    const runtimeRecord = runtimeSessions[buildRuntimeSessionKey("im_conversation", selectedDialogSessionId)]
      ?? runtimeSessions[buildRuntimeSessionKey("dialog", selectedDialogSessionId)];
    const channelType = inferIMChannelType({ preview, runtimeRecord });
    if (!channelType) return "local";
    const hasLiveConversation = dialogChannelGroups[channelType].conversations.some((conversation) =>
      conversation.activeSessionId === selectedDialogSessionId
      || conversation.conversation.topics.some((topic) => topic.sessionId === selectedDialogSessionId),
    );
    return preview || hasLiveConversation ? channelType : "local";
  }, [currentRoomSessionId, dialogChannelGroups, imSessionPreviews, runtimeSessions, selectedDialogSessionId]);
  const requestedDialogView = manualDialogView ?? derivedDialogView;
  const dialogTopSessionItems = useMemo<DialogTopSessionItem[]>(() => {
    const localRuntimeRecord = currentRoomSessionId
      ? runtimeSessions[buildRuntimeSessionKey("dialog", currentRoomSessionId)]
      : null;
    const items: DialogTopSessionItem[] = [
      {
        key: "local",
        label: "本机",
        detail: isReviewSurface ? "本地 Dialog 审查房间" : "本地 Dialog 协作房间",
        statusLabel: localRuntimeRecord ? getRuntimeIndicatorStatus(localRuntimeRecord) : (isReviewSurface ? "本机审查" : "本机协作"),
        updatedAt: localRuntimeRecord?.updatedAt ?? (dialogHistory[dialogHistory.length - 1]?.timestamp ?? 0),
        connectionState: "connected",
        connectionLabel: isReviewSurface ? "本机审查" : "本机协作",
      },
    ];
    for (const channelType of ["dingtalk", "feishu"] as const) {
      const group = dialogChannelGroups[channelType];
      const connectionMeta = dialogChannelConnectionMeta[channelType];
      if (!connectionMeta.configured && group.conversations.length === 0) {
        continue;
      }
      items.push({
        key: channelType,
        label: channelType === "dingtalk" ? "钉钉渠道" : "飞书渠道",
        detail: group.detail,
        statusLabel: group.statusLabel,
        updatedAt: group.updatedAt,
        connectionState: connectionMeta.connectionState,
        connectionLabel: connectionMeta.connectionLabel,
        canAutoConnect: connectionMeta.canAutoConnect,
      });
    }
    return items;
  }, [currentRoomSessionId, dialogChannelConnectionMeta, dialogChannelGroups, dialogHistory, isReviewSurface, runtimeSessions]);
  const activeDialogView = dialogTopSessionItems.some((item) => item.key === requestedDialogView)
    ? requestedDialogView
    : "local";
  const activeDialogTopSessionItem = useMemo(
    () => dialogTopSessionItems.find((item) => item.key === activeDialogView) ?? dialogTopSessionItems[0] ?? null,
    [activeDialogView, dialogTopSessionItems],
  );
  const activeDialogViewSummary = useMemo(() => {
    if (!activeDialogTopSessionItem) return null;
    const parts: string[] = [];
    if (activeDialogTopSessionItem.key === "local") {
      parts.push("当前主房间");
    } else if (activeDialogTopSessionItem.connectionLabel) {
      parts.push(activeDialogTopSessionItem.connectionLabel);
    }
    if (activeDialogTopSessionItem.statusLabel && activeDialogTopSessionItem.key !== "local") {
      parts.push(activeDialogTopSessionItem.statusLabel);
    }
    if (activeDialogTopSessionItem.updatedAt > 0) {
      parts.push(formatSessionStripTime(activeDialogTopSessionItem.updatedAt));
    }
    return parts.join(" · ");
  }, [activeDialogTopSessionItem]);
  const activeChannelGroup = activeDialogView === "local"
    ? null
    : dialogChannelGroups[activeDialogView];
  const activeChannelConversationKey = useMemo(() => {
    if (!activeChannelGroup) return null;
    const matchedForeground = activeChannelGroup.conversations.find((item) =>
      item.activeSessionId === selectedDialogSessionId
      || item.conversation.topics.some((topic) => topic.sessionId === selectedDialogSessionId),
    );
    return matchedForeground?.key ?? activeChannelGroup.conversations[0]?.key ?? null;
  }, [activeChannelGroup, selectedDialogSessionId]);
  const activeChannelConversation = activeChannelGroup?.conversations.find((item) => item.key === activeChannelConversationKey)
    ?? activeChannelGroup?.conversations[0]
    ?? null;
  useEffect(() => {
    if (activeDialogView === "local") return;
    dialogRenderLogger.info("active dialog channel snapshot", {
      activeDialogView,
      selectedDialogSessionId,
      activeChannelConversationKey,
      activeChannelConversation: activeChannelConversation
        ? {
            key: activeChannelConversation.key,
            conversationId: activeChannelConversation.conversationId,
            activeSessionId: activeChannelConversation.activeSessionId,
            previewSessionId: activeChannelConversation.preview?.sessionId,
            previewTopicId: activeChannelConversation.preview?.topicId,
            previewMessageCount: activeChannelConversation.preview?.dialogHistory.length ?? 0,
            statusLabel: activeChannelConversation.statusLabel,
            updatedAt: activeChannelConversation.updatedAt,
          }
        : null,
      groupConversations: activeChannelGroup?.conversations.map((conversation) => ({
        key: conversation.key,
        conversationId: conversation.conversationId,
        activeSessionId: conversation.activeSessionId,
        previewSessionId: conversation.preview?.sessionId,
        previewTopicId: conversation.preview?.topicId,
        previewMessageCount: conversation.preview?.dialogHistory.length ?? 0,
        updatedAt: conversation.updatedAt,
      })) ?? [],
    });
  }, [
    activeChannelConversation,
    activeChannelConversationKey,
    activeChannelGroup,
    activeDialogView,
    selectedDialogSessionId,
  ]);
  const returnToLocalDialogRoom = useCallback(() => {
    useRuntimeStateStore.getState().setForegroundSession("im_conversation", null);
    if (currentRoomSessionId) {
      useRuntimeStateStore.getState().setForegroundSession("dialog", currentRoomSessionId);
    }
  }, [currentRoomSessionId]);
  const handleSelectDialogView = useCallback((viewKey: DialogSessionViewKey) => {
    setManualDialogView(viewKey);
    if (viewKey === "local") {
      returnToLocalDialogRoom();
      return;
    }
    const targetGroup = dialogChannelGroups[viewKey];
    const targetConversation =
      targetGroup.conversations.find((conversation) =>
        conversation.activeSessionId === selectedDialogSessionId
        || conversation.conversation.topics.some((topic) => topic.sessionId === selectedDialogSessionId),
      )
      ?? targetGroup.conversations[0];
    const targetSessionId =
      targetConversation?.activeSessionId
      || targetConversation?.conversation.topics[0]?.sessionId;
    if (targetSessionId) {
      useRuntimeStateStore.getState().setForegroundSession("im_conversation", targetSessionId);
    }
  }, [dialogChannelGroups, returnToLocalDialogRoom, selectedDialogSessionId]);
  const ensureDialogChannelConnected = useCallback(async (channelType: "dingtalk" | "feishu"): Promise<boolean> => {
    const meta = dialogChannelConnectionMeta[channelType];
    if (!meta.configured || meta.entries.length === 0) {
      return false;
    }
    setDialogChannelConnectPending((prev) => ({ ...prev, [channelType]: true }));
    try {
      const manager = getChannelManager();
      const latestSaved = loadSavedChannels();
      const nextSaved = latestSaved.map((entry) => (
        entry.config.type === channelType && entry.config.enabled === false
          ? { config: { ...entry.config, enabled: true } }
          : entry
      ));
      if (nextSaved.some((entry, index) => entry !== latestSaved[index])) {
        saveSavedChannels(nextSaved);
        setDialogSavedChannels(nextSaved);
      }

      const results = await Promise.allSettled(
        nextSaved
          .filter((entry) => entry.config.type === channelType)
          .map(async (entry) => {
            const currentStatus = manager.getStatuses().find((status) => status.id === entry.config.id)?.status;
            if (currentStatus === "connected" || currentStatus === "connecting") {
              return entry.config.id;
            }
            const configToConnect = { ...entry.config, enabled: true };
            await manager.register(configToConnect);
            return entry.config.id;
          }),
      );
      refreshDialogChannelMeta();

      const successCount = results.filter((result) => result.status === "fulfilled").length;
      if (successCount === 0) {
        const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        throw firstFailure?.reason ?? new Error("未知连接错误");
      }

      toast("success", `${channelType === "dingtalk" ? "钉钉" : "飞书"}渠道已连接`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast("error", `连接${channelType === "dingtalk" ? "钉钉" : "飞书"}渠道失败：${message}`);
      refreshDialogChannelMeta();
      return false;
    } finally {
      setDialogChannelConnectPending((prev) => ({ ...prev, [channelType]: false }));
    }
  }, [dialogChannelConnectionMeta, refreshDialogChannelMeta, toast]);
  const handleDialogTopViewClick = useCallback(async (item: DialogTopSessionItem) => {
    if (item.key === "local") {
      handleSelectDialogView("local");
      return;
    }
    const connectionMeta = dialogChannelConnectionMeta[item.key];
    if (connectionMeta.connectionState === "connecting") {
      return;
    }
    if (connectionMeta.connectionState === "connected" || !connectionMeta.canAutoConnect) {
      handleSelectDialogView(item.key);
      return;
    }
    const connected = await ensureDialogChannelConnected(item.key);
    if (connected) {
      handleSelectDialogView(item.key);
    }
  }, [dialogChannelConnectionMeta, ensureDialogChannelConnected, handleSelectDialogView]);
  const actorSupportsImageInput = useCallback((actorId?: string | null) => {
    if (!actorId) {
      return modelSupportsImageInput(config.model || "", config.protocol);
    }
    const actor = actors.find((item) => item.id === actorId);
    return modelSupportsImageInput(actor?.modelOverride || config.model || "", config.protocol);
  }, [actors, config.model, config.protocol]);
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
      const taskStartedAt = actor.currentTask?.steps[0]?.timestamp;
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

  useEffect(() => {
    const nextSnapshot: Record<string, {
      taskId: string;
      maxVisibleLength: number;
      lastVisibleLength: number;
    }> = {};

    for (const actor of runningActors) {
      const taskId = actor.currentTask?.id ?? "";
      if (!taskId) continue;
      const steps = actor.currentTask?.steps ?? [];
      const reversedSteps = [...steps].reverse();
      const latestStreamingAnswer = reversedSteps.find((step) => step.streaming && step.type === "answer");
      const currentLength = latestStreamingAnswer?.content?.trim().length ?? 0;
      const previous = streamingAnswerRenderRef.current[actor.id];

      if (previous && previous.taskId === taskId) {
        const looksLikeRestart =
          previous.maxVisibleLength >= 320
          && currentLength > 0
          && currentLength <= 120
          && currentLength + 160 < previous.maxVisibleLength;
        if (looksLikeRestart) {
          dialogRenderLogger.warn("streaming answer visibly restarted in Dialog UI", {
            actorId: actor.id,
            actorName: actor.roleName,
            taskId,
            previousMaxLength: previous.maxVisibleLength,
            previousVisibleLength: previous.lastVisibleLength,
            currentLength,
            stepCount: steps.length,
          });
        }
      }

      nextSnapshot[actor.id] = {
        taskId,
        maxVisibleLength: Math.max(previous?.taskId === taskId ? previous.maxVisibleLength : 0, currentLength),
        lastVisibleLength: currentLength,
      };
    }

    streamingAnswerRenderRef.current = nextSnapshot;
  }, [runningActors, runningActivityKey]);

  // Auto-init: mount 时自动创建 ActorSystem
  // ActorSystemStore 会负责恢复磁盘会话快照或补齐默认 Agent。
  const ensureSystem = useCallback(() => {
    const storeState = useActorSystemStore.getState();
    if (storeState.active) return;
    init({
      confirmDangerousAction,
      defaultProductMode: dialogSurfaceMode,
    });
    sync();
  }, [confirmDangerousAction, dialogSurfaceMode, init, sync]);

  useEffect(() => {
    if (active && !initRef.current) {
      initRef.current = true;
      ensureSystem();
    }
  }, [active, ensureSystem]);

  useEffect(() => {
    const system = useActorSystemStore.getState().getSystem();
    if (system) {
      system.defaultProductMode = dialogSurfaceMode;
    }
  }, [dialogSurfaceMode]);

  useEffect(() => {
    useRuntimeStateStore.getState().setPanelVisible("dialog", active);
    if (!active) return;
    const foregroundSessionId =
      getForegroundRuntimeSession("im_conversation")?.sessionId
      ?? foregroundIMConversationSessionId
      ?? getForegroundRuntimeSession("dialog")?.sessionId
      ?? foregroundDialogSessionId
      ?? null;
    if (foregroundSessionId) return;
    if (currentRoomSessionId) {
      useRuntimeStateStore.getState().setForegroundSession("dialog", currentRoomSessionId);
    }
  }, [active, currentRoomSessionId, foregroundDialogSessionId, foregroundIMConversationSessionId, systemActive]);

  useEffect(() => () => {
    useRuntimeStateStore.getState().setPanelVisible("dialog", false);
  }, []);

  const prevDerivedDialogViewRef = useRef<DialogSessionViewKey>(derivedDialogView);

  useEffect(() => {
    const selectionKey = `${derivedDialogView}:${selectedDialogSessionId ?? ""}`;
    if (lastDialogSelectionRef.current === null) {
      lastDialogSelectionRef.current = selectionKey;
      prevDerivedDialogViewRef.current = derivedDialogView;
      return;
    }
    if (lastDialogSelectionRef.current !== selectionKey) {
      lastDialogSelectionRef.current = selectionKey;
      // 仅当用户未手动选择视图时才跟随 derived 切换，避免本机发送时自动跳转到渠道 tab
      // 如果当前没有手动指定，且是从 local 突然变成渠道，我们帮用户锁定在之前的视图
      if (manualDialogView === null) {
        setManualDialogView(prevDerivedDialogViewRef.current);
      }
      prevDerivedDialogViewRef.current = derivedDialogView;
    }
  }, [derivedDialogView, manualDialogView, selectedDialogSessionId]);

  useEffect(() => {
    if (activeDialogView === "local" || !chatScrollRef.current) return;
    chatScrollRef.current.scrollTop = 0;
  }, [activeChannelConversationKey, activeDialogView]);

  useEffect(() => {
    if (!pendingAICenterHandoff || normalizeAIProductMode(pendingAICenterHandoff.mode) !== dialogSurfaceMode) return;
    let cancelled = false;

    const applyHandoff = async () => {
      const payload = pendingAICenterHandoff.payload;
      ensureSystem();
      setInput(payload.query);
      clearAttachments();
      setSourceHandoff(payload);
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

      for (const path of getAICenterHandoffImportPaths(payload)) {
          if (cancelled) return;
          await addAttachmentFromPath(path);
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
  }, [pendingAICenterHandoff, ensureSystem, clearAttachments, addAttachmentFromPath, getSystem, setSourceHandoff, dialogSurfaceMode]);

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

    const id = requestAnimationFrame(() => {
      const container = chatScrollRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [hasRunningActors]);

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

  const actorNameById = useMemo(() => {
    const map = new Map<string, string>();
    actors.forEach((a) => map.set(a.id, a.roleName));
    return map;
  }, [actors]);

  const artifacts = useMemo(
    () => collectArtifacts(dialogHistory, actorById, structuredArtifacts),
    [dialogHistory, actorById, structuredArtifacts],
  );
  const dialogContextSummary = useMemo(
    () => buildDialogContextSummary({
      dialogHistory,
      artifacts: structuredArtifacts,
      sessionUploads,
      spawnedTasks,
      actorNameById,
    }),
    [actorNameById, dialogHistory, sessionUploads, spawnedTasks, structuredArtifacts],
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

  const openApprovalMessage = openApprovalMessageId
    ? messageById.get(openApprovalMessageId) ?? null
    : null;
  const openApprovalInteraction = openApprovalMessageId
    ? pendingInteractionByMessageId.get(openApprovalMessageId)
    : undefined;
  const collaborationQueuedFollowUpById = useMemo(
    () => new Map((collaborationSnapshot?.queuedFollowUps ?? []).map((item) => [item.id, item] as const)),
    [collaborationSnapshot],
  );
  const collaborationChildSessionByRunId = useMemo(
    () => new Map((collaborationSnapshot?.childSessions ?? []).map((item) => [item.runId, item] as const)),
    [collaborationSnapshot],
  );
  const collaborationDelegationByRunId = useMemo(
    () => new Map(
      (collaborationSnapshot?.contractDelegations ?? [])
        .flatMap((item) => (item.runId ? [[item.runId, item] as const] : [])),
    ),
    [collaborationSnapshot],
  );
  const pendingSteerSession = useMemo(() => {
    if (!pendingSteerSessionRunId) return null;
    return collaborationChildSessionByRunId.get(pendingSteerSessionRunId)
      ?? spawnedTasks.find((task) => task.runId === pendingSteerSessionRunId && task.mode === "session" && task.sessionOpen)
      ?? null;
  }, [collaborationChildSessionByRunId, pendingSteerSessionRunId, spawnedTasks]);
  const pendingSteerTargetActorId = pendingSteerSession?.targetActorId ?? null;
  const pendingSteerTargetLabel = useMemo(() => {
    if (!pendingSteerSession) return null;
    return pendingSteerSession.label
      || actorById.get(pendingSteerSession.targetActorId)?.roleName
      || pendingSteerSession.targetActorId;
  }, [actorById, pendingSteerSession]);

  const handleOpenApprovalDrawer = useCallback((messageId: string) => {
    setOpenApprovalMessageId(messageId);
  }, []);

  const handleCloseApprovalDrawer = useCallback(() => {
    setOpenApprovalMessageId(null);
  }, []);

  const handleInteractionReply = useCallback((messageId: string, content: string) => {
    try {
      replyToPendingInteraction(messageId, {
        content,
        displayText: content,
      });
      setInputNotice(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInputNotice(message || "回复失败，请稍后再试。");
      return false;
    }
  }, [replyToPendingInteraction]);

  const handleApprovalReply = useCallback((messageId: string, content: string) => {
    const replied = handleInteractionReply(messageId, content);
    if (replied) {
      setOpenApprovalMessageId(null);
    }
  }, [handleInteractionReply]);

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
    if (selectedPendingMessageId && selectedPendingMessageId !== NEW_MESSAGE_TARGET && pendingSteerSessionRunId) {
      setPendingSteerSessionRunId(null);
    }
  }, [pendingSteerSessionRunId, selectedPendingMessageId]);
  useEffect(() => {
    if (!pendingSteerSessionRunId) return;
    if (pendingSteerSession && pendingSteerSession.mode === "session" && pendingSteerSession.focusable) return;
    setPendingSteerSessionRunId(null);
    setInput((current) => current.trimStart().startsWith("!steer ") ? "" : current);
    setInputNotice((current) => current ?? "目标子会话已不可继续，已退出 steer 模式。");
  }, [pendingSteerSession, pendingSteerSessionRunId]);
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
      executionPolicy: draft.executionPolicy,
      middlewareOverrides: draft.middlewareOverrides,
      thinkingLevel: draft.thinkingLevel,
    });
  }, [ensureSystem, spawnActor]);

  // 热移除 Agent
  const handleRemoveAgent = useCallback((actorId: string) => {
    killActor(actorId);
  }, [killActor]);

  // 移动 Agent 位置
  const handleMoveAgent = useCallback((actorId: string, direction: -1 | 1) => {
    const ids = actors.map((a) => a.id);
    const idx = ids.indexOf(actorId);
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    reorderActors(ids);
  }, [actors, reorderActors]);

  // 设为默认发送 Agent
  const handleSetCoordinator = useCallback((actorId: string) => {
    setCoordinator(actorId);
  }, [setCoordinator]);

  // 热更新 Agent 配置
  const handleUpdateAgent = useCallback((actorId: string, patch: Parameters<typeof updateActorConfig>[1]) => {
    updateActorConfig(actorId, patch);
  }, [updateActorConfig]);

  // 应用预设：清除当前 agents，重新 spawn 预设参与者
  const handleApplyPreset = useCallback((presetId: string) => {
    const preset = [...DIALOG_PRESETS, ...customPresets].find((p) => p.id === presetId);
    if (!preset) return;
    destroyAll();
    initRef.current = false;
    init({
      confirmDangerousAction,
      defaultProductMode: dialogSurfaceMode,
    });
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
        executionPolicy: p.executionPolicy,
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
  }, [confirmDangerousAction, customPresets, destroyAll, dialogSurfaceMode, init, spawnActor]);

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
        executionPolicy: a.normalizedExecutionPolicy,
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
      dialogContextSummary,
      dialogRoomCompaction,
      sourceSessionId: getSystem()?.sessionId,
    });
    if (!handoff) return;
    routeToAICenter({
      mode: "build",
      source: "dialog_continue_to_agent",
      handoff,
      navigate: false,
    });
  }, [actorById, artifacts, dialogContextSummary, dialogHistory, dialogRoomCompaction, getSystem, sessionUploads, spawnedTasks]);
  const handleContinueSpawnedTaskWithAgent = useCallback((runId: string) => {
    const task = spawnedTasks.find((item) => item.runId === runId);
    if (!task) return;
    const handoff = buildDialogSpawnedTaskHandoff({
      task,
      targetActor: actorById.get(task.targetActorId),
      actorTodos: actorTodos[task.targetActorId] ?? [],
      dialogHistory,
      artifacts,
      actorNameById,
      projectedChildSession: collaborationChildSessionByRunId.get(runId),
      projectedDelegation: collaborationDelegationByRunId.get(runId),
      sourceSessionId: getSystem()?.sessionId,
    });
    if (!handoff) return;
    routeToAICenter({
      mode: "build",
      source: "dialog_continue_to_agent",
      handoff,
      navigate: false,
    });
  }, [
    spawnedTasks,
    actorById,
    actorNameById,
    actorTodos,
    dialogHistory,
    artifacts,
    collaborationChildSessionByRunId,
    collaborationDelegationByRunId,
    getSystem,
  ]);
  const handlePrepareChildSessionSteer = useCallback((runId: string) => {
    const childSession = collaborationChildSessionByRunId.get(runId);
    if (!childSession || childSession.mode !== "session" || !childSession.focusable) return;
    const actorLabel = actorById.get(childSession.targetActorId)?.roleName ?? childSession.targetActorId;
    setSelectedSpawnRunId(runId);
    setPendingSteerSessionRunId(runId);
    setSelectedPendingMessageId(NEW_MESSAGE_TARGET);
    setShowMention(false);
    setWorkspacePanel(null);
    setInput((current) => current.trimStart().startsWith("!steer ") ? current : "!steer ");
    setInputNotice(`已选中 ${actorLabel} 的后台线程补充指令，发送后会由主 Agent 协调转交。`);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [actorById, collaborationChildSessionByRunId]);
  const handleCancelPendingSteer = useCallback(() => {
    setPendingSteerSessionRunId(null);
    setInput((current) => current.trimStart().startsWith("!steer ") ? "" : current);
    setInputNotice(null);
    inputRef.current?.focus();
  }, []);
  const handleAbortChildSession = useCallback(async (runId: string) => {
    const task = spawnedTasks.find((item) => item.runId === runId && item.mode === "session" && item.sessionOpen);
    if (!task) return;
    const actorLabel = actorById.get(task.targetActorId)?.roleName ?? task.targetActorId;
    const sessionLabel = task.label?.trim() || actorLabel;
    const confirmed = await openConfirmDialog({
      source: "actor_dialog",
      toolName: "abort_child_session",
      params: {
        runId,
        actor: actorLabel,
        childSession: sessionLabel,
        action: "终止当前子会话并中断它派生的后续协作",
      },
    });
    if (!confirmed) return;
    abortSpawnedSession(runId);
    if (pendingSteerSessionRunId === runId) {
      setPendingSteerSessionRunId(null);
      setInput((current) => current.trimStart().startsWith("!steer ") ? "" : current);
    }
    setInputNotice(`已中止 ${sessionLabel}。`);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [abortSpawnedSession, actorById, openConfirmDialog, pendingSteerSessionRunId, spawnedTasks]);
  const handleNewTopic = useCallback(() => {
    resetSession();
    setPendingSteerSessionRunId(null);
    setSourceHandoff(null);
  }, [resetSession, setSourceHandoff]);
  const handleFullReset = useCallback(() => {
    destroyAll();
    initRef.current = false;
    setPendingSteerSessionRunId(null);
    setSourceHandoff(null);
  }, [destroyAll, setSourceHandoff]);

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
  const reviewExecutionContractBoundary = useCallback(async (params: {
    draft: NonNullable<ReturnType<typeof buildExecutionContractDraftFromDialog>>;
    plan: ClusterPlan | null;
    sessionId?: string;
    forceHuman?: boolean;
  }): Promise<{
    approved: boolean;
    assessment: ExecutionContractApprovalAssessment;
  }> => {
    const trustMode = mapTrustLevelToContractTrustMode(useToolTrustStore.getState().trustLevel);
    const assessment = assessExecutionContractApproval(params.draft, contractApprovalActors, {
      trustMode,
    });
    const reviewPlan = params.plan ?? undefined;

    if (assessment.decision === "deny") {
      setLastPlanReview({
        status: "rejected",
        timestamp: Date.now(),
        plan: reviewPlan,
        source: "policy",
        risk: assessment.risk,
        reason: assessment.reason,
      });
      setInputNotice(assessment.reason);
      inputRef.current?.focus();
      return { approved: false, assessment };
    }

    const needsHuman = Boolean(params.forceHuman) || assessment.decision === "ask";
    if (needsHuman) {
      if (!params.plan) {
        setInputNotice("当前协作契约需要人工确认，但没有可展示的审批草案，请先调整后再试。");
        inputRef.current?.focus();
        return { approved: false, assessment };
      }
      const approvalResult = await openPlanApprovalDialog({
        plan: params.plan,
        sessionId: params.sessionId,
        presentation: decorateBoundaryApprovalPresentation(
          buildClusterPresentationFromDraft({
            draft: {
              ...params.draft,
              insight: params.draft.insight,
            },
            actors,
          }),
          assessment,
        ),
      });
      if (approvalResult.status !== "approved") {
        setLastPlanReview({
          status: "rejected",
          timestamp: Date.now(),
          plan: params.plan,
          source: "human",
          risk: assessment.risk,
          reason: assessment.reason,
        });
        return { approved: false, assessment };
      }
      setLastPlanReview({
        status: "approved",
        timestamp: Date.now(),
        plan: params.plan,
        source: "human",
        risk: assessment.risk,
        reason: assessment.reason,
      });
      return { approved: true, assessment };
    }

    setLastPlanReview({
      status: "approved",
      timestamp: Date.now(),
      plan: reviewPlan,
      source: assessment.layer === "policy" ? "policy" : "auto_review",
      risk: assessment.risk,
      reason: assessment.reason,
    });
    return { approved: true, assessment };
  }, [actors, contractApprovalActors, openPlanApprovalDialog]);

  const handleEditQueuedFollowUpItem = useCallback(async (itemId: string) => {
    const nextItem = queuedFollowUps.find((item) => item.id === itemId);
    if (!nextItem) return;

    const restorablePaths = [...new Set([
      ...(nextItem.attachmentPaths ?? []),
      ...(nextItem.images ?? []),
    ])];
    clearAttachments();
    setSelectedPendingMessageId(NEW_MESSAGE_TARGET);
    setPendingSteerSessionRunId(null);
    setInput(nextItem.displayText || nextItem.briefContent || nextItem.content);
    setShowMention(false);
    setSourceHandoff(null);
    for (const path of restorablePaths) {
      try {
        await addAttachmentFromPath(path);
      } catch {
        // best-effort only; missing files should not block editing
      }
    }
    removeFollowUp(nextItem.id);
    setInputNotice("已载入排队消息，可修改后重新审批或发送。");
    inputRef.current?.focus();
  }, [addAttachmentFromPath, clearAttachments, queuedFollowUps, removeFollowUp, setSourceHandoff]);

  const handleRunQueuedFollowUpItem = useCallback(async (itemId?: string) => {
    const nextItem = itemId
      ? queuedFollowUps.find((item) => item.id === itemId)
      : queuedFollowUps[0];
    if (!nextItem || queuedFollowUpDispatchRef.current) return;

    queuedFollowUpDispatchRef.current = true;
    try {
      if (nextItem.contractStatus === "ready") {
        queueDialogUserMemoryCapture(nextItem.displayText || nextItem.content);
        runQueuedFollowUp(nextItem.id);
        setInputNotice(null);
      } else {
        const persistedItem = collaborationQueuedFollowUpById.get(nextItem.id);
        const directTargetActorId = persistedItem?.contract?.executionStrategy === "direct"
          && persistedItem.contract.initialRecipientActorIds.length === 1
          ? persistedItem.contract.initialRecipientActorIds[0]
          : undefined;
        const planningRoutingMode: DialogRoutingMode = nextItem.routingMode === "smart" || nextItem.routingMode === "broadcast"
          ? nextItem.routingMode
          : "coordinator";
        const dispatchInsight = inferDialogDispatchInsight({
          content: nextItem.content,
          attachmentSummary: nextItem.briefContent,
          attachmentPaths: nextItem.attachmentPaths,
        });
        const selectedRoute = nextItem.routingMode === "smart"
          ? routeTask(nextItem.content, dispatchInsight.preferredCapabilities)[0] ?? null
          : null;
        const planBundle = buildDialogDispatchPlanBundle({
          actors,
          routingMode: planningRoutingMode,
          content: nextItem.content,
          attachmentSummary: nextItem.briefContent,
          attachmentPaths: nextItem.attachmentPaths ?? [],
          mentionedTargetId: directTargetActorId ?? null,
          selectedRoute,
          coordinatorActorId,
        });
        const executionDraft = buildExecutionContractDraftFromDialog({
          actors,
          routingMode: planningRoutingMode,
          content: nextItem.content,
          attachmentSummary: nextItem.briefContent,
          attachmentPaths: nextItem.attachmentPaths ?? [],
          mentionedTargetId: directTargetActorId ?? null,
          selectedRoute,
          coordinatorActorId,
        });
        if (!executionDraft) {
          setInputNotice("当前排队消息无法自动重建协作契约，请先编辑后重新发送。");
          inputRef.current?.focus();
          return;
        }
        if (requirePlanApproval || nextItem.contractStatus === "needs_reapproval") {
          const reviewed = await reviewExecutionContractBoundary({
            draft: executionDraft,
            plan: planBundle?.clusterPlan ?? null,
            sessionId: getSystem()?.sessionId,
            forceHuman: nextItem.contractStatus === "needs_reapproval",
          });
          if (!reviewed.approved) {
            setInputNotice(nextItem.contractStatus === "needs_reapproval"
              ? "排队消息已保留，等待重新审批或编辑。"
              : (reviewed.assessment.reason || "当前协作边界未通过审批。"));
            inputRef.current?.focus();
            return;
          }
        }

        const sealedContract = applyDraftExecutionContract(executionDraft, {
          content: nextItem.content,
          briefContent: nextItem.briefContent,
          images: nextItem.images,
          attachmentPaths: nextItem.attachmentPaths,
        });
        try {
          queueDialogUserMemoryCapture(nextItem.displayText || nextItem.content);
          dispatchDialogInput({
            content: nextItem.content,
            displayText: nextItem.displayText,
            briefContent: nextItem.briefContent,
            images: nextItem.images,
            attachmentPaths: nextItem.attachmentPaths,
            uploadRecords: nextItem.uploadRecords,
          }, {
            contract: sealedContract,
            policy: persistedItem?.policy,
            allowQueue: false,
            focusedChildSessionId: persistedItem?.focusedChildSessionId ?? null,
            directTargetActorId,
            forceAsNewMessage: true,
          });
          removeFollowUp(nextItem.id);
          setInputNotice(null);
        } catch (error) {
          applyDraftExecutionContract(null);
          throw error;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInputNotice(message || "队列消息发送失败，请稍后重试。");
      inputRef.current?.focus();
    } finally {
      window.setTimeout(() => {
        queuedFollowUpDispatchRef.current = false;
      }, 180);
    }
  }, [
    actors,
    applyDraftExecutionContract,
    collaborationQueuedFollowUpById,
    coordinatorActorId,
    dispatchDialogInput,
    getSystem,
    queueDialogUserMemoryCapture,
    queuedFollowUps,
    removeFollowUp,
    requirePlanApproval,
    reviewExecutionContractBoundary,
    routeTask,
    runQueuedFollowUp,
  ]);

  const handleRunNextQueuedFollowUp = useCallback(async () => {
    await handleRunQueuedFollowUpItem();
  }, [handleRunQueuedFollowUpItem]);

  useEffect(() => {
    if (queuedFollowUps.length === 0) {
      queuedFollowUpDispatchRef.current = false;
    }
  }, [queuedFollowUps.length]);

  useEffect(() => {
    if (hasRunningActors) return;
    if (pendingUserInteractions.length > 0) return;
    if (queuedFollowUps.length === 0) return;
    if (queuedFollowUps[0]?.contractStatus !== "ready") return;
    if (queuedFollowUpDispatchRef.current) return;

    void handleRunQueuedFollowUpItem();
  }, [
    handleRunQueuedFollowUpItem,
    hasRunningActors,
    pendingUserInteractions.length,
    queuedFollowUps,
  ]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed && !hasAttachments) return;

    if (activeDialogView !== "local") {
      setInputNotice(`当前正在查看 ${getDialogViewLabel(activeDialogView)}，请先返回本机再发送消息。`);
      inputRef.current?.focus();
      return;
    }

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

    const imagesToSend = hasImages ? [...imagePaths] : undefined;
    const uploadRecords = attachments.length > 0 ? buildSessionUploadRecords(attachments) : [];

    const hasPendingInteractions = pendingUserInteractions.length > 0;
    const explicitlySelected = selectedPendingMessageId && selectedPendingMessageId !== NEW_MESSAGE_TARGET
      ? pendingInteractionByMessageId.get(selectedPendingMessageId)
      : undefined;
    const sendAsNewMessage = selectedPendingMessageId === NEW_MESSAGE_TARGET;
    const willReplyToInteraction = !sendAsNewMessage
      && (Boolean(explicitlySelected) || pendingUserInteractions.length === 1);

    // 有多个待回复交互时，必须显式选择回复目标
    if (hasPendingInteractions && !sendAsNewMessage && !explicitlySelected && pendingUserInteractions.length > 1) {
      setInputNotice("当前有多个待回复问题，请先选择要回复的那一条，或选择“作为新消息发送”。");
      inputRef.current?.focus();
      return;
    }

    const { targetId, cleanContent } = parseMention(trimmed);
    const finalContent = hasContext
      ? `${fileContextBlock}\n\n${cleanContent || userText}`
      : (cleanContent || content);
    const finalBrief = hasContext
      ? composeInputWithAttachmentSummary(cleanContent || userText, attachmentSummary)
      : undefined;
    const planAttachmentSummary = finalBrief ?? attachmentSummary ?? undefined;
    const steerTargetActorId = targetId ?? pendingSteerTargetActorId;
    const isSteerCommand = Boolean(steerTargetActorId && finalContent.startsWith("!steer "));
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

    if (hasImages) {
      const roomHasVisualModel = actors.some((actor) => actorSupportsImageInput(actor.id));
      const targetSupportsImages = targetId ? actorSupportsImageInput(targetId) : null;
      const smartRouteSupportsImages = selectedSmartRoute
        ? actorSupportsImageInput(selectedSmartRoute.agentId)
        : null;

      if (targetId && targetSupportsImages === false) {
        toast(
          "warning",
          "当前选中的 Dialog Agent 不支持图片识别，本次图片内容可能无法被正确理解；如需看图，请切换到支持视觉输入的模型。",
        );
      } else if (selectedSmartRoute && smartRouteSupportsImages === false) {
        toast(
          "warning",
          "当前智能路由命中的 Agent 不支持图片识别，本次图片内容可能无法被正确理解；如需看图，请切换到支持视觉输入的模型。",
        );
      } else if (!roomHasVisualModel) {
        toast(
          "warning",
          "当前 Dialog 房间内没有支持图片识别的模型，本次会忽略图片细节；如需看图，请切换到支持视觉输入的模型。",
        );
      }
    }

    let sealedContract = null;
    if (!willReplyToInteraction && !isSteerCommand) {
      const planningRoutingMode: DialogRoutingMode =
        routingMode === "direct" ? "coordinator" : routingMode;
      const planBundle = buildDialogDispatchPlanBundle({
        actors,
        routingMode: planningRoutingMode,
        content: finalContent,
        attachmentSummary: planAttachmentSummary,
        attachmentPaths: inputAttachmentPaths,
        handoff: incomingHandoff,
        mentionedTargetId: targetId,
        selectedRoute: selectedSmartRoute,
        coordinatorActorId,
      });
      const executionDraft = buildExecutionContractDraftFromDialog({
        actors,
        routingMode: planningRoutingMode,
        content: finalContent,
        attachmentSummary: planAttachmentSummary,
        attachmentPaths: inputAttachmentPaths,
        handoff: incomingHandoff,
        mentionedTargetId: targetId,
        selectedRoute: selectedSmartRoute,
        coordinatorActorId,
      });

      if (executionDraft && requirePlanApproval) {
        const reviewed = await reviewExecutionContractBoundary({
          draft: executionDraft,
          plan: planBundle?.clusterPlan ?? null,
          sessionId: currentSystem.sessionId,
        });
        if (!reviewed.approved) {
          setShowConfig(false);
          setOverlay(null);
          setWorkspacePanel("plan");
          setInputNotice(reviewed.assessment.reason || "执行计划已取消，调整后可重新发送。");
          inputRef.current?.focus();
          return;
        }
      }

      sealedContract = applyDraftExecutionContract(executionDraft, {
        content: finalContent,
        briefContent: finalBrief,
        images: imagesToSend,
        attachmentPaths: inputAttachmentPaths,
      });
    }

    let nextInputNotice: string | null = null;
    try {
      setLastCommittedDispatchInsight(dispatchInsight);
      queueDialogUserMemoryCapture(cleanContent || trimmed);
      const steerDirective = isSteerCommand ? finalContent.slice(7).trim() : "";
      if (isSteerCommand && !steerDirective) {
        setInputNotice("请输入要发送给当前 Agent 的 steer 指令内容。");
        inputRef.current?.focus();
        return;
      }
      const result = dispatchDialogInput({
        content: isSteerCommand ? steerDirective : finalContent,
        displayText: isSteerCommand ? steerDirective : (cleanContent || trimmed || userText),
        briefContent: finalBrief,
        images: imagesToSend,
        attachmentPaths: inputAttachmentPaths,
        uploadRecords,
      }, {
        contract: sealedContract,
        selectedPendingMessageId: explicitlySelected?.messageId,
        forceAsNewMessage: sendAsNewMessage,
        directTargetActorId: !isSteerCommand ? targetId ?? undefined : undefined,
        steerTargetActorId: isSteerCommand ? steerTargetActorId ?? undefined : undefined,
        focusedChildSessionId: isSteerCommand ? undefined : null,
        allowQueue: !isSteerCommand,
      });
      if (result?.disposition === "queued") {
        nextInputNotice = "当前房间仍在处理上一轮协作，这条消息已加入队列，待房间空闲后继续。";
      }
    } catch (error) {
      if (sealedContract) {
        applyDraftExecutionContract(null);
      }
      const message = error instanceof Error ? error.message : String(error);
      setInputNotice(message || "发送失败，请稍后重试。");
      inputRef.current?.focus();
      return;
    }

    setInput("");
    setInputNotice(nextInputNotice);
    setPendingSteerSessionRunId(null);
    setShowMention(false);
    clearAttachments();
    setSourceHandoff(null);
    inputRef.current?.focus();
  }, [input, hasAttachments, imagePaths, attachments, fileContextBlock, attachmentSummary, ensureSystem, pendingUserInteractions, pendingInteractionByMessageId, selectedPendingMessageId, parseMention, actors, routingMode, routeTask, clearAttachments, requirePlanApproval, coordinatorActorId, queueDialogUserMemoryCapture, inputAttachmentPaths, incomingHandoff, actorSupportsImageInput, toast, dispatchDialogInput, applyDraftExecutionContract, getSystem, setSourceHandoff, activeDialogView, pendingSteerTargetActorId, reviewExecutionContractBoundary]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    if (inputNotice) setInputNotice(null);
    if (pendingSteerSessionRunId && val.trim().length > 0 && !val.trimStart().startsWith("!steer")) {
      setPendingSteerSessionRunId(null);
    }

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
  }, [inputNotice, pendingSteerSessionRunId]);

  const handleMentionSelect = useCallback((name: string) => {
    const lastAt = input.lastIndexOf("@");
    const before = lastAt >= 0 ? input.slice(0, lastAt) : input;
    setInput(`${before}@${name} `);
    setPendingSteerSessionRunId(null);
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
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
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

  const handleClearExtraChannelConversations = useCallback(async () => {
    if (!activeChannelGroup || activeChannelGroup.conversations.length <= 1) return;

    const groupedByChannelId = new Map<string, typeof activeChannelGroup.conversations>();
    const runtimeOnlySessions: string[] = [];
    for (const conversation of activeChannelGroup.conversations) {
      const channelId = conversation.conversation.channelId?.trim();
      if (!channelId) {
        const sessionId = conversation.activeSessionId?.trim();
        if (sessionId && sessionId !== activeChannelConversation?.activeSessionId) {
          runtimeOnlySessions.push(sessionId);
        }
        continue;
      }
      const existing = groupedByChannelId.get(channelId) ?? [];
      existing.push(conversation);
      groupedByChannelId.set(channelId, existing);
    }

    if (groupedByChannelId.size === 0 && runtimeOnlySessions.length === 0) {
      toast("warning", `当前${activeDialogView === "dingtalk" ? "钉钉" : "飞书"}会话缺少有效清理目标，暂时无法清理`);
      return;
    }

    let removedTotal = 0;
    for (const [channelId, conversations] of groupedByChannelId) {
      const keepConversationId = conversations.find(
        (item) => item.key === activeChannelConversation?.key,
      )?.conversationId ?? conversations[0]?.conversationId;
      removedTotal += getChannelManager().clearChannelConversations(channelId, {
        keepConversationId,
      });
    }
    for (const sessionId of runtimeOnlySessions) {
      await abortRuntimeSession("im_conversation", sessionId);
      removedTotal += 1;
    }

    if (removedTotal > 0) {
      if (activeChannelConversation?.activeSessionId) {
        useRuntimeStateStore.getState().setForegroundSession("im_conversation", activeChannelConversation.activeSessionId);
      }
      toast("success", `已清理 ${removedTotal} 个多余${activeDialogView === "dingtalk" ? "钉钉" : "飞书"}会话`);
    } else {
      toast("info", "没有需要清理的多余会话");
    }
  }, [activeChannelConversation, activeChannelGroup, activeDialogView, toast]);

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
      ? composeInputWithAttachmentSummary(userText, attachmentSummary)
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
  const contextBreakdown = useMemo(
    () => buildDialogContextBreakdown({
      actors,
      dialogHistory,
      artifacts,
      sessionUploads,
      spawnedTasks,
      draftPlan: draftDispatchPlan,
      draftInsight: draftDispatchInsight,
    }),
    [actors, dialogHistory, artifacts, sessionUploads, spawnedTasks, draftDispatchPlan, draftDispatchInsight],
  );
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
  const hasActiveCollaborationFlow = useMemo(
    () =>
      spawnedTasks.some((task) => task.status === "running")
      || runningActors.length > 1
      || runningActors.some((actor) => actor.id !== coordinatorActorId),
    [spawnedTasks, runningActors, coordinatorActorId],
  );
  const headerMetaItems = useMemo(() => {
    const items: string[] = [];
    if (coordinatorName) {
      items.push(`主代理 ${coordinatorName}`);
    }
    items.push(isReviewSurface ? "只读审查" : "主房间协作");
    items.push(routingModeMeta.label);
    if (activeDialogView !== "local") {
      items.push(`当前查看 ${getDialogViewLabel(activeDialogView)}`);
    }
    return items;
  }, [activeDialogView, coordinatorName, isReviewSurface, routingModeMeta.label]);
  const localStatusBadges = useMemo(() => {
    if (activeDialogView !== "local") return [];
    const badges: Array<{ key: string; label: string; className: string }> = [];
    if (pendingUserInteractions.length > 0) {
      badges.push({
        key: "pending-replies",
        label: `${pendingUserInteractions.length} 条待回复`,
        className: "bg-amber-500/10 text-amber-700",
      });
    }
    if (hasRunningActors) {
      badges.push({
        key: "running-actors",
        label: `${runningActors.length} 个运行中`,
        className: "bg-amber-500/10 text-amber-700",
      });
    }
    if (openSessionCount > 0) {
      badges.push({
        key: "open-sessions",
        label: `${openSessionCount} 个后台线程保留中`,
        className: "bg-blue-500/10 text-blue-700",
      });
    }
    if (activeTodoCount > 0) {
      badges.push({
        key: "active-todos",
        label: `${activeTodoCount} 个活跃待办`,
        className: "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
      });
    }
    if (queuedFollowUps.length > 0) {
      badges.push({
        key: "queued-followups",
        label: `${queuedFollowUps.length} 条排队消息`,
        className: "bg-cyan-500/10 text-cyan-700",
      });
    }
    return badges;
  }, [
    activeDialogView,
    activeTodoCount,
    hasRunningActors,
    openSessionCount,
    pendingUserInteractions.length,
    queuedFollowUps.length,
    runningActors.length,
  ]);

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
      const tasks = spawnEvents.map((e: SpawnedTaskEventDetail) => ({
        spawner: e.spawnerActorId, target: e.targetActorId, label: e.label || "", status: e.status,
      }));
      const dialog = dialogHistory.map((m) => ({ from: m.from, to: m.to }));
      return KnowledgeGraph.fromActorSystem(actorNodes, tasks, dialog);
    } catch { return { nodes: [], edges: [] }; }
  }, [overlay, actors, dialogHistory]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[var(--color-bg)]">
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="flex w-full min-w-0 flex-col gap-2.5 px-3 py-2.5 sm:px-4 lg:px-5">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-2xl bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                  <Users className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-[var(--color-text)]">
                      {isReviewSurface ? "Dialog · 审查工作台" : "Dialog 工作台"}
                    </span>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
                      isReviewSurface
                        ? "bg-violet-500/10 text-violet-600"
                        : "bg-cyan-500/10 text-cyan-700"
                    }`}>
                      {isReviewSurface && <ShieldCheck className="h-3 w-3" />}
                      {isReviewSurface ? "只读审查" : "主 Agent 协作"}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                      actors.length > 0
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                    }`}>
                      {actors.length > 0 ? `${actors.length} 个 Agent` : "等待配置"}
                    </span>
                  </div>
                  {headerMetaItems.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
                      {headerMetaItems.map((item, index) => (
                        <React.Fragment key={item}>
                          {index > 0 && <span className="text-[var(--color-text-tertiary)]">·</span>}
                          <span>{item}</span>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              {activeDialogView === "local" && dialogHistory.length > 0 && (
                <button
                  onClick={handleNewTopic}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/25 hover:text-[var(--color-text)] transition-colors"
                  title="清空对话和 Agent 记忆，保留当前 Agent 阵容"
                >
                  <RotateCcw className="w-3 h-3" />
                  新话题
                </button>
              )}
              {activeDialogView === "local" && (
                <button
                  onClick={handleFullReset}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-red-500/20 hover:bg-red-500/5 hover:text-red-600 transition-colors"
                  title="销毁所有 Agent，回到初始状态"
                >
                  <Trash2 className="w-3 h-3" />
                  重置房间
                </button>
              )}
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
                  title="把当前多 Agent 协作上下文带到 Build，继续落地执行"
                >
                  <ArrowRightCircle className="w-3 h-3" />
                  转 Build
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {dialogTopSessionItems.length > 0 && (
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/32 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {dialogTopSessionItems.map((item) => {
                    const isSelected = item.key === activeDialogView;
                    const isConnectable = item.key !== "local" && item.canAutoConnect;
                    const isConnecting = item.connectionState === "connecting";
                    const indicatorClass = item.connectionState === "connected"
                      ? "bg-emerald-500"
                      : item.connectionState === "error"
                        ? "bg-amber-500"
                        : item.connectionState === "unconfigured"
                          ? "bg-slate-400"
                          : "bg-slate-300";
                    const statusBadgeLabel = item.connectionState === "connected"
                      ? "在线"
                      : item.connectionState === "connecting"
                        ? "连接中"
                        : item.connectionState === "error"
                          ? "异常"
                          : item.connectionState === "unconfigured"
                            ? "历史"
                            : "未连接";
                    const CardIcon = item.key === "local"
                      ? MessageSquareText
                      : item.key === "dingtalk"
                        ? Smartphone
                        : Bot;

                    return (
                      <button
                        key={item.key}
                        onClick={() => { void handleDialogTopViewClick(item); }}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] transition-colors ${
                          isSelected
                            ? "border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                            : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/20 hover:text-[var(--color-text)]"
                        }`}
                        title={`${item.label} · ${item.connectionLabel}${isConnectable ? " · 点击自动连接" : ""}${item.statusLabel ? ` · ${item.statusLabel}` : ""}`}
                      >
                        <CardIcon className="h-3.5 w-3.5" />
                        <span>{item.label}</span>
                        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] ${
                          item.connectionState === "connected"
                            ? "bg-emerald-500/10 text-emerald-600"
                            : item.connectionState === "connecting"
                              ? "bg-blue-500/10 text-blue-600"
                              : item.connectionState === "error"
                                ? "bg-amber-500/10 text-amber-700"
                                : "bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)]"
                        }`}>
                          {isConnecting ? (
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          ) : (
                            <span className={`h-1.5 w-1.5 rounded-full ${indicatorClass}`} />
                          )}
                          <span>{statusBadgeLabel}</span>
                        </span>
                      </button>
                    );
                  })}

                  {activeDialogViewSummary && (
                    <span className="ml-auto text-[10px] text-[var(--color-text-secondary)]">
                      {activeDialogViewSummary}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2.5">
              {activeDialogView === "local" && localStatusBadges.length > 0 && (
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
                  {localStatusBadges.map((badge) => (
                    <span
                      key={badge.key}
                      className={`rounded-full px-2 py-0.5 ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  ))}
                </div>
              )}

              {activeDialogView === "local" && actors.length > 1 && (
                <div className="min-w-0 flex-1">
                  <ActorStatusBar actors={actors} compact />
                </div>
              )}

              {activeDialogView === "local" && actors.length > 0 && (
                <div className="ml-auto flex shrink-0 items-center">
                  <DialogWorkspaceDock
                    panel={workspacePanel}
                    onPanelChange={handleWorkspacePanelChange}
                    actors={actors}
                    actorTodos={actorTodos}
                    dialogHistory={dialogHistory}
                    artifacts={artifacts}
                    sessionUploads={sessionUploads}
                    spawnedTasks={spawnedTasks}
                    childSessions={collaborationSnapshot?.childSessions ?? []}
                    contractDelegations={collaborationSnapshot?.contractDelegations ?? []}
                    selectedRunId={selectedSpawnRunId}
                    onSelectRunId={setSelectedSpawnRunId}
                    onSteerSession={handlePrepareChildSessionSteer}
                    onCloseSession={closeSpawnedSession}
                    onKillSession={handleAbortChildSession}
                    onContinueTaskWithAgent={handleContinueSpawnedTaskWithAgent}
                    draftPlan={draftDispatchPlan}
                    draftInsight={draftDispatchInsight}
                    contextBreakdown={contextBreakdown}
                    contextSnapshot={contextSnapshot}
                    dialogRoomCompaction={dialogRoomCompaction}
                    dialogContextSummary={dialogContextSummary}
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
        </div>
      </div>

      <div ref={chatScrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5 sm:px-4 lg:px-5">
        <div className="flex min-h-full w-full min-w-0 flex-col gap-3.5">
          {activeDialogView !== "local" ? (
            activeChannelGroup ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <ChannelSessionBoard
                  group={activeChannelGroup}
                  selectedConversationKey={activeChannelConversationKey}
                  currentRoomSessionId={currentRoomSessionId}
                  onSelectConversation={(conversationKey) => {
                    setManualDialogView(activeDialogView);
                    const targetConversation = activeChannelGroup.conversations.find((item) => item.key === conversationKey);
                    const targetSessionId = targetConversation?.activeSessionId
                      || targetConversation?.conversation.topics[0]?.sessionId;
                    if (targetSessionId) {
                      useRuntimeStateStore.getState().setForegroundSession("im_conversation", targetSessionId);
                    }
                  }}
                  onClearExtraConversations={handleClearExtraChannelConversations}
                  onReturnToCurrentRoom={currentRoomSessionId
                    ? returnToLocalDialogRoom
                    : null}
                  renderMessageBubble={({ message, actorIndex, actorName, targetName, isUser }) => (
                    <MessageBubble
                      message={message}
                      actorIndex={actorIndex}
                      actorName={actorName}
                      targetName={targetName}
                      isUser={isUser}
                      isWaitingReply={false}
                      pendingInteraction={undefined}
                      onReplyToInteraction={() => {}}
                      onOpenApprovalDrawer={() => {}}
                    />
                  )}
                />
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 px-4 py-4 text-center text-[12px] text-[var(--color-text-secondary)]">
                当前渠道暂无可展示内容。
              </div>
            )
          ) : (
            <>
              {dialogHistory.length === 0 && (
                <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-secondary)]/20 px-4 py-4 text-center">
                  <div className="flex flex-col items-center gap-1.5">
                    <Bot className="w-5 h-5 text-[var(--color-text-tertiary)] opacity-60" />
                    <div className="text-[13px] font-medium text-[var(--color-text)]">
                      {actors.length > 0 ? "从下方发起一条任务，主代理会先接住它" : "先启动一个主代理，再开始对话"}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-secondary)]">
                      {actors.length > 0
                        ? "默认像单代理一样工作；只有在值得时，主代理才会临时创建审查、验证或探索子代理。"
                        : "建议先保留一个主代理，再按需要补充现有 Agent 或让主代理临时创建子代理。"}
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
                      onReplyToInteraction={handleInteractionReply}
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
                const findLastStepIndex = (predicate: (step: AgentStep) => boolean) => {
                  for (let index = steps.length - 1; index >= 0; index -= 1) {
                    const step = steps[index];
                    if (step && predicate(step)) return index;
                  }
                  return -1;
                };

                const latestStreamingAnswer = reversedSteps.find((s) => s.streaming && s.type === "answer");
                const latestStreamingAnswerIndex = findLastStepIndex(
                  (s) => Boolean(s.streaming) && s.type === "answer",
                );
                const latestThinkingStep = reversedSteps.find(
                  (s) => s.type === "thinking" || s.type === "thought",
                );
                const latestThinkingStepIndex = findLastStepIndex(
                  (s) => s.type === "thinking" || s.type === "thought",
                );
                const latestThoughtToolStep = hasPendingApproval
                  ? undefined
                  : reversedSteps.find((s) => {
                    if (s.type !== "tool_streaming") return false;
                    return buildToolStreamingPreview(s.content).kind === "thinking";
                  });
                const latestThoughtToolStepIndex = hasPendingApproval
                  ? -1
                  : findLastStepIndex((s) => {
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
                const latestExecutionToolStepIndex = hasPendingApproval
                  ? -1
                  : findLastStepIndex((s) => {
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
                const latestToolStreamingStepIndex = hasPendingApproval
                  ? -1
                  : findLastStepIndex((s) => {
                    if (s.type !== "tool_streaming" || !s.streaming) return false;
                    return buildToolStreamingPreview(s.content).kind === "artifact";
                  });
                const latestToolStreamingPreview = latestToolStreamingStep
                  ? buildToolStreamingPreview(latestToolStreamingStep.content)
                  : null;
                const latestExecutionStateStep = reversedSteps.find(
                  (s) => s.type === "action" || s.type === "observation" || s.type === "error",
                );
                const latestExecutionStateStepIndex = findLastStepIndex(
                  (s) => s.type === "action" || s.type === "observation" || s.type === "error",
                );
                const prefersThoughtToolPreview = latestThoughtToolStepIndex > latestThinkingStepIndex;
                const derivedThinkingContent = latestThoughtToolPreview?.kind === "thinking"
                  ? latestThoughtToolPreview.body
                  : undefined;
                const effectiveThinkingIndex = Math.max(latestThinkingStepIndex, latestThoughtToolStepIndex);
                const effectiveExecutionIndex = Math.max(latestExecutionToolStepIndex, latestExecutionStateStepIndex);
                const effectiveArtifactIndex = latestToolStreamingStepIndex;
                const effectiveLiveBlockIndex = Math.max(
                  effectiveThinkingIndex,
                  effectiveExecutionIndex,
                  effectiveArtifactIndex,
                );

                const streamingContent = latestStreamingAnswer?.content;
                const thinkingContent = prefersThoughtToolPreview
                  ? derivedThinkingContent
                  : latestThinkingStep?.content ?? derivedThinkingContent;
                const toolStreamingContent = latestToolStreamingStep?.content;
                const showExecutionCard = Boolean(
                  !streamingContent
                  && latestStreamingAnswerIndex < effectiveExecutionIndex
                  && effectiveExecutionIndex >= 0
                  && effectiveExecutionIndex === effectiveLiveBlockIndex,
                );
                const showThinkingPlaceholder = Boolean(
                  !streamingContent
                  && latestStreamingAnswerIndex < 0
                  && !showExecutionCard
                  && effectiveLiveBlockIndex < 0
                  && a.currentTask?.status === "running",
                );
                const hasDetailedThinkingContent = Boolean(latestThinkingStep || derivedThinkingContent);
                const showThinkingBlock = Boolean(
                  !streamingContent
                  && hasDetailedThinkingContent
                  && latestStreamingAnswerIndex < effectiveThinkingIndex
                  && effectiveThinkingIndex >= 0
                  && effectiveThinkingIndex === effectiveLiveBlockIndex,
                );
                const showThinkingSummaryOnly = Boolean(
                  hasActiveCollaborationFlow
                  && !streamingContent
                  && !showExecutionCard
                  && !hasDetailedThinkingContent
                  && showThinkingPlaceholder,
                );
                const showArtifactBlock = Boolean(
                  !streamingContent
                  && latestStreamingAnswerIndex < effectiveArtifactIndex
                  && effectiveArtifactIndex >= 0
                  && effectiveArtifactIndex === effectiveLiveBlockIndex,
                );
                const currentTaskStatus = normalizeCurrentTaskStatus(a.currentTask?.status);
                const executionCardTitle = showExecutionCard || showThinkingSummaryOnly
                  ? describeAgentActivity(steps, a.roleName, false, currentTaskStatus)
                  : "";
                const executionCardDetail = (() => {
                  if (latestExecutionToolPreview?.kind === "spawn") return latestExecutionToolPreview.body;
                  if (showThinkingSummaryOnly) return truncateWorkflowText(thinkingContent ?? "正在整理思路...", 72);
                  const lastAction = reversedSteps.find((s) => s.type === "action");
                  const lastObs = reversedSteps.find((s) => s.type === "observation");
                  if (lastAction?.toolName) {
                    const input = lastAction.toolInput ?? {};
                    const toolDetail = buildActionDetail(lastAction.toolName, input);
                    if (lastObs?.content) {
                      const obsPreview = lastObs.content.slice(0, 120).replace(/\n/g, " ");
                      return `${toolDetail}\n${obsPreview}${lastObs.content.length > 120 ? "..." : ""}`;
                    }
                    return toolDetail;
                  }
                  return undefined;
                })();
                const executionCardIcon = latestExecutionToolPreview?.kind === "spawn"
                  ? ArrowRightCircle
                  : showThinkingSummaryOnly
                    ? Brain
                  : Settings2;
                const executionCardStartedAt = latestExecutionToolStep?.timestamp
                  ?? latestExecutionStateStep?.timestamp
                  ?? Date.now();
                const thinkingStartedAt = prefersThoughtToolPreview
                  ? latestThoughtToolStep?.timestamp
                  ?? latestThinkingStep?.timestamp
                  ?? a.currentTask?.steps[0]?.timestamp
                  ?? actorThinkingAnchorRef.current[a.id]?.startedAt
                  ?? Date.now()
                  : latestThinkingStep?.timestamp
                  ?? latestThoughtToolStep?.timestamp
                  ?? a.currentTask?.steps[0]?.timestamp
                  ?? actorThinkingAnchorRef.current[a.id]?.startedAt
                  ?? Date.now();
                const thinkingIsStreaming = showThinkingPlaceholder
                  || (prefersThoughtToolPreview
                    ? latestThoughtToolStep?.streaming
                    : latestThinkingStep?.streaming || latestThoughtToolStep?.streaming)
                  || false;
                const hasRichLiveBlock = Boolean(
                  showThinkingBlock
                  || showExecutionCard
                  || showThinkingSummaryOnly
                  || showArtifactBlock
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

                    {(showExecutionCard || showThinkingSummaryOnly) && (
                      <LiveExecutionCard
                        roleName={a.roleName}
                        title={executionCardTitle}
                        detail={executionCardDetail}
                        startedAt={executionCardStartedAt}
                        isStreaming={showThinkingSummaryOnly ? thinkingIsStreaming : true}
                        color={color}
                        icon={executionCardIcon}
                      />
                    )}

                    {showArtifactBlock && latestToolStreamingStep && latestToolStreamingPreview?.kind === "artifact" && (
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
                            {describeAgentActivity(steps, a.roleName, !!streamingContent, currentTaskStatus)}
                          </span>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      <div
        className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)]/92 backdrop-blur-sm"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <div className="w-full px-3 py-2 sm:px-4 lg:px-5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_ACCEPT_ALL}
            className="hidden"
            onChange={onFileSelect}
          />

          <div className="overflow-visible rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[0_12px_32px_-24px_rgba(15,23,42,0.35)]">
            {(incomingHandoff || dialogMemoryWorkspaceId || dialogContextSummary || dialogHistory.length > 0 || openSessionCount > 0 || queuedFollowUps.length > 0 || pendingUserInteractions.length > 0 || attachments.length > 0 || inputNotice || activeDialogView !== "local") && (
              <div className="space-y-2 border-b border-[var(--color-border)] bg-[linear-gradient(135deg,rgba(15,23,42,0.02),transparent_45%)] px-3 py-2.5">
                {activeDialogView !== "local" ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-full border border-sky-500/15 bg-sky-500/10 px-3 py-1.5 text-[10px] text-sky-700">
                    <Users className="w-3 h-3" />
                    <span className="min-w-0 flex-1">
                      {inputNotice || `当前正在查看 ${getDialogViewLabel(activeDialogView)}，返回本机后再发送消息。`}
                    </span>
                    {currentRoomSessionId && (
                      <button
                        onClick={returnToLocalDialogRoom}
                        className="rounded-full border border-sky-500/20 px-2.5 py-1 text-[10px] hover:border-sky-500/40 transition-colors"
                      >
                        返回本机
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <DialogContextStrip snapshot={contextSnapshot} />

                    {incomingHandoff?.sourceMode && (
                      <AICenterHandoffCard
                        handoff={incomingHandoff}
                        dismissLabel="仅隐藏提示"
                        onDismiss={() => setSourceHandoff(null)}
                      />
                    )}

                    <DialogChildSessionStrip
                      sessions={collaborationSnapshot?.childSessions ?? []}
                      actorNameById={actorNameById}
                      pendingSteerSessionRunId={pendingSteerSessionRunId}
                      onOpenWorkspace={() => handleWorkspacePanelChange("subtasks")}
                    />

                    {queuedFollowUps.length > 0 && (
                      <DialogFollowUpDock
                        items={queuedFollowUps}
                        disabled={hasRunningActors || pendingUserInteractions.length > 0 || queuedFollowUpDispatchRef.current}
                        onRunNext={() => {
                          void handleRunNextQueuedFollowUp();
                        }}
                        onRunItem={(id) => {
                          void handleRunQueuedFollowUpItem(id);
                        }}
                        onEditItem={(id) => {
                          void handleEditQueuedFollowUpItem(id);
                        }}
                        onRemove={removeFollowUp}
                        onClear={clearQueuedFollowUps}
                      />
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
                      <div className="flex flex-wrap gap-1.5">
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
                  </>
                )}
              </div>
            )}

            {activeDialogView !== "local" ? (
              <div className="flex flex-wrap items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium text-[var(--color-text)]">
                    当前正在查看 {getDialogViewLabel(activeDialogView)}
                  </div>
                  <div className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]">
                    不在渠道页里输入，返回本机后继续发送和协作。
                  </div>
                </div>
                {currentRoomSessionId && (
                  <button
                    onClick={returnToLocalDialogRoom}
                    className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-sky-500/8 px-3 py-1.5 text-[11px] text-sky-700 hover:border-sky-500/35 hover:bg-sky-500/12 transition-colors"
                  >
                    <Users className="h-3.5 w-3.5" />
                    返回本机继续
                  </button>
                )}
              </div>
            ) : (
              <>
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
                        : pendingSteerTargetLabel
                          ? `向 ${pendingSteerTargetLabel} 发送 steer 指令...`
                          : pendingUserInteractions.length > 0
                            ? `有 ${pendingUserInteractions.length} 条待回复交互，先选择要回复的问题...`
                            : isReviewSurface
                              ? "输入审查任务给主 Agent；它会按只读审查边界组织协作，不直接改业务文件"
                              : "输入消息给主 Agent，必要时它会自动复用后台线程或分派子 Agent"}
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
                    ) : pendingSteerTargetLabel ? (
                      <button
                        type="button"
                        onClick={handleCancelPendingSteer}
                        className="inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[10px] text-sky-700 hover:border-sky-500/35 hover:bg-sky-500/15 transition-colors"
                      >
                        Steer 到 {pendingSteerTargetLabel}
                        <X className="h-3 w-3" />
                      </button>
                    ) : coordinatorName ? (
                      <span
                        className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-[10px] text-[var(--color-text-secondary)]"
                        title="是否需要后台线程由主代理自动判断"
                      >
                        默认发给 {coordinatorName} · 自动判断是否开线程
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
              </>
            )}
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
                      isCoordinator={actor.id === coordinatorActorId}
                      isFirst={i === 0}
                      isLast={i === actors.length - 1}
                      onRemove={() => handleRemoveAgent(actor.id)}
                      onMoveUp={() => handleMoveAgent(actor.id, -1)}
                      onMoveDown={() => handleMoveAgent(actor.id, 1)}
                      onSetDefault={() => handleSetCoordinator(actor.id)}
                      onUpdate={(patch) => handleUpdateAgent(actor.id, patch)}
                      models={models}
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
                : "md:w-[min(760px,calc(100%-1rem))]"
            }`}
          >
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 px-4 py-3 backdrop-blur-sm">
              <div>
                <div className="text-[13px] font-medium text-[var(--color-text)]">
                  {overlay === "tasks" ? "定时任务" : "协作图"}
                </div>
                <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                  {overlay === "tasks"
                    ? "统一查看和维护 Agent 创建的定时任务，不打断当前对话流。"
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
