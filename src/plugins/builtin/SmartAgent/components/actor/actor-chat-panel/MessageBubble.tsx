import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  FileDown,
  FolderOpen,
  Loader2,
  User,
  X,
} from "lucide-react";

import type {
  ApprovalDecisionOption,
  DialogMessage,
  PendingInteraction,
} from "@/core/agent/actor/types";
import { ChatImage } from "@/components/ai/MessageBubble";
import { StructuredMediaAttachments } from "@/components/ai/StructuredMediaAttachments";
import { mergeStructuredMedia } from "@/core/media/structured-media";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const FILE_PATH_REGEX = /(?:\/[\w.\-/]+\.(?:xlsx|csv|pdf|docx|pptx|xls))/g;
const ACTOR_COLORS = [
  { bg: "bg-cyan-500/10", text: "text-cyan-600", dot: "bg-cyan-500" },
  { bg: "bg-emerald-500/10", text: "text-emerald-600", dot: "bg-emerald-500" },
  { bg: "bg-amber-500/10", text: "text-amber-600", dot: "bg-amber-500" },
  { bg: "bg-violet-500/10", text: "text-violet-600", dot: "bg-violet-500" },
  { bg: "bg-rose-500/10", text: "text-rose-600", dot: "bg-rose-500" },
  { bg: "bg-sky-500/10", text: "text-sky-600", dot: "bg-sky-500" },
  { bg: "bg-orange-500/10", text: "text-orange-600", dot: "bg-orange-500" },
  { bg: "bg-teal-500/10", text: "text-teal-600", dot: "bg-teal-500" },
  { bg: "bg-indigo-500/10", text: "text-indigo-600", dot: "bg-indigo-500" },
  { bg: "bg-fuchsia-500/10", text: "text-fuchsia-600", dot: "bg-fuchsia-500" },
];

function getActorColor(index: number) {
  return ACTOR_COLORS[index % ACTOR_COLORS.length];
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

function RecallInfoChips({ message }: { message: DialogMessage }) {
  const memoryPreview = message.appliedMemoryPreview ?? [];
  const transcriptPreview = message.appliedTranscriptPreview ?? [];
  const transcriptHitCount = Math.max(
    0,
    message.transcriptRecallHitCount ?? transcriptPreview.length,
  );

  if (
    message.memoryRecallAttempted !== true
    && message.transcriptRecallAttempted !== true
    && memoryPreview.length === 0
    && transcriptPreview.length === 0
  ) {
    return null;
  }

  return (
    <div className="mt-1.5 flex max-w-full flex-col gap-1">
      <div className="flex flex-wrap gap-1.5">
        {message.memoryRecallAttempted && (
          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700">
            {memoryPreview.length > 0 ? `已用记忆 ${memoryPreview.length} 条` : "记忆已检索"}
          </span>
        )}
        {message.transcriptRecallAttempted && (
          <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-700">
            {transcriptHitCount > 0 ? `已回补轨迹 ${transcriptHitCount} 条` : "轨迹已检索"}
          </span>
        )}
      </div>
      {memoryPreview.length > 0 && (
        <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-800/90">
          记忆命中：{memoryPreview.join("；")}
        </div>
      )}
      {transcriptPreview.length > 0 && (
        <div className="rounded-xl border border-violet-500/15 bg-violet-500/5 px-2.5 py-1.5 text-[10px] leading-relaxed text-violet-800/90">
          轨迹回补：{transcriptPreview.join("；")}
        </div>
      )}
    </div>
  );
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

export function ApprovalRequestDrawer({
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
                  <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">目标位置</div>
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
                    <div className="text-[11px] text-[var(--color-text-tertiary)]">{detail.label}</div>
                    <div className={`mt-2 text-[13px] leading-relaxed text-[var(--color-text)] break-all ${detail.mono ? "font-mono" : ""}`}>
                      {detail.value}
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
                <div className="text-[12px] font-medium text-amber-800">审批说明</div>
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

export interface MessageBubbleProps {
  message: DialogMessage;
  actorIndex: number;
  actorName: string;
  targetName?: string;
  isUser: boolean;
  isWaitingReply?: boolean;
  showRecallInfo?: boolean;
  pendingInteraction?: PendingInteraction;
  onReplyToInteraction?: (messageId: string, content: string) => void;
  onOpenApprovalDrawer?: (messageId: string) => void;
}

function MessageBubbleBase({
  message,
  actorIndex,
  actorName,
  targetName,
  isUser,
  isWaitingReply,
  showRecallInfo = true,
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
  const structuredDisplay = useMemo(
    () => mergeStructuredMedia({
      text: displayText,
      images: message.images,
      attachments: message.attachments,
    }),
    [displayText, message.attachments, message.images],
  );
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
      <div className={`max-w-[88%] min-w-0 lg:max-w-[78%] ${isUser ? "flex flex-col items-end" : ""}`}>
        <div className={`text-[10px] mb-0.5 ${isUser ? "self-end text-right text-[var(--color-accent)]" : color!.text}`}>
          {actorName}
          {targetName && (
            <span className="text-[var(--color-text-tertiary)] ml-1">→ {targetName}</span>
          )}
          <span className="text-[var(--color-text-tertiary)] ml-1">
            {new Date(message.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
        <div className={`inline-block w-fit max-w-full text-left text-[13px] leading-relaxed ${bubbleClassName} ${isStructuredApproval ? "" : "rounded-xl px-3 py-2"}`}>
          {!isStructuredApproval && structuredDisplay.images && structuredDisplay.images.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mb-1.5">
              {structuredDisplay.images.map((imgPath: string, i: number) => (
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
              <div className="prose prose-sm dark:prose-invert max-w-none text-left prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_code]:break-words [&_p]:whitespace-pre-wrap [&_li]:whitespace-pre-wrap">
                <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                  {structuredDisplay.text}
                </ReactMarkdown>
              </div>
              <StructuredMediaAttachments attachments={structuredDisplay.attachments} compact />
              {hasBrief && (
                <button
                  onClick={() => setShowFullContext((v) => !v)}
                  className="mt-1 text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] flex items-center gap-0.5 ml-auto transition-colors"
                >
                  <ChevronDown className={`w-3 h-3 transition-transform ${showFullContext ? "rotate-180" : ""}`} />
                  {showFullContext ? "收起上下文" : "查看完整上下文"}
                </button>
              )}
              {!isUser && message.kind !== "approval_request" && <FileActionButtons content={structuredDisplay.text} />}
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
        {!isUser && showRecallInfo && <RecallInfoChips message={message} />}
      </div>
    </div>
  );
}

export const MessageBubble = React.memo(
  MessageBubbleBase,
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message._briefContent === next.message._briefContent &&
    (prev.message.images?.join("\n") || "") === (next.message.images?.join("\n") || "") &&
    (
      prev.message.attachments?.map((item) => `${item.path}:${item.fileName ?? ""}`).join("\n")
      || ""
    ) === (
      next.message.attachments?.map((item) => `${item.path}:${item.fileName ?? ""}`).join("\n")
      || ""
    ) &&
    prev.message.timestamp === next.message.timestamp &&
    prev.message.memoryRecallAttempted === next.message.memoryRecallAttempted &&
    (prev.message.appliedMemoryPreview?.join("\n") || "") ===
      (next.message.appliedMemoryPreview?.join("\n") || "") &&
    prev.message.transcriptRecallAttempted === next.message.transcriptRecallAttempted &&
    prev.message.transcriptRecallHitCount === next.message.transcriptRecallHitCount &&
    (prev.message.appliedTranscriptPreview?.join("\n") || "") ===
      (next.message.appliedTranscriptPreview?.join("\n") || "") &&
    prev.actorIndex === next.actorIndex &&
    prev.actorName === next.actorName &&
    prev.targetName === next.targetName &&
    prev.isUser === next.isUser &&
    prev.isWaitingReply === next.isWaitingReply &&
    prev.showRecallInfo === next.showRecallInfo &&
    prev.pendingInteraction?.id === next.pendingInteraction?.id &&
    prev.pendingInteraction?.status === next.pendingInteraction?.status &&
    prev.onReplyToInteraction === next.onReplyToInteraction &&
    prev.onOpenApprovalDrawer === next.onOpenApprovalDrawer,
);
