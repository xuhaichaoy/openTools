import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@/core/logger";
import type { ChannelIncomingMessage, ChannelType } from "@/core/channels/types";
import {
  ensureExportSourceConnected,
  runExportAgent,
} from "./export-agent";
import { loadRuntimeExportCatalog } from "./runtime-catalog";
import {
  isEnterDatabaseOperationModeCommand,
  isExportCancellation,
  isExportConfirmation,
  isExitDatabaseOperationModeCommand,
  normalizeExportIntentText,
} from "./export-intent-router";
import {
  confirmTeamDataExport,
  isTeamDataExportApiUnavailable,
  previewTeamDataExport,
  type TeamExportExecutionResult,
} from "./team-data-export-api";
import { useAuthStore } from "@/store/auth-store";
import { useIMConversationRuntimeStore } from "@/store/im-conversation-runtime-store";
import { getServerUrl } from "@/store/server-store";
import type {
  ExportPreview,
  ExportResult,
  ExportSessionState,
  StructuredExportIntent,
} from "./types";

const log = createLogger("IMDataExportRuntime");
const ENTER_DATABASE_OPERATION_MODE_REPLY = "已进入数据库操作模式。接下来你可以直接描述查数或导出需求，如需退出请发送“退出数据库操作”。";
const EXIT_DATABASE_OPERATION_MODE_REPLY = "已退出数据库操作模式，后续消息将按普通对话处理。";
const CANCEL_EXPORT_IN_DATABASE_OPERATION_MODE_REPLY = "已取消这次导出请求。当前仍处于数据库操作模式，如需退出请发送“退出数据库操作”。";

type IMConversationMode = "normal" | "database_operation";

function buildSessionKey(channelId: string, conversationId: string): string {
  return `${channelId.trim()}::${conversationId.trim()}`;
}

function buildRuntimeDisplayLabel(
  channelType: ChannelType,
  msg: ChannelIncomingMessage,
): string {
  const senderName = String(msg.senderName ?? "").trim();
  if (msg.conversationType === "private" && senderName) {
    return senderName;
  }
  return channelType === "dingtalk" ? "钉钉会话" : "飞书会话";
}

function buildRuntimeDisplayDetail(
  channelType: ChannelType,
  msg: ChannelIncomingMessage,
): string {
  const platform = channelType === "dingtalk" ? "钉钉" : "飞书";
  const conversation = msg.conversationType === "group" ? "群聊" : "私聊";
  return `${platform} · ${conversation}`;
}

function summarizePreview(preview: ExportPreview): string {
  if (preview.previewRowCount <= 0) {
    return [
      "当前没有查到匹配记录。",
      preview.columns.length ? `字段：${preview.columns.join("、")}` : "",
      "你可以继续补充更准确的企业名、筛选条件，或者直接说“看一下 某个库 某个表”来查看表结构和样本数据。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const previewLines = preview.rows.slice(0, 5).map((row, index) => {
    const values = preview.columns.map((column) => {
      const value = row[column];
      if (value == null) return "null";
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    });
    return `${index + 1}. ${values.join(" | ")}`;
  });

  return [
    `已生成导出预览，共 ${preview.previewRowCount} 条预览记录。`,
    preview.columns.length ? `字段：${preview.columns.join("、")}` : "",
    previewLines.length ? "预览：" : "",
    ...previewLines,
    "如果确认导出 CSV，请回复“确认导出”；如果需要改条件，直接继续补充你的要求。",
  ]
    .filter(Boolean)
    .join("\n");
}

function sanitizeExportFileName(value: string): string {
  const normalized = String(value ?? "").trim().replace(/[\\/:*?"<>|]+/g, "_");
  return normalized || `team-export-${Date.now()}.csv`;
}

function resolveDownloadUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const baseUrl = getServerUrl().replace(/\/+$/, "");
  return `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
}

async function materializeTeamExportAttachment(
  result: TeamExportExecutionResult,
): Promise<{ path: string; fileName: string }> {
  const directPath = String(result.filePath ?? "").trim();
  if (directPath) {
    return {
      path: directPath,
      fileName: sanitizeExportFileName(
        String(result.fileName ?? directPath.split("/").pop() ?? "team-export.csv"),
      ),
    };
  }

  const downloadUrl = String(result.downloadUrl ?? "").trim();
  if (!downloadUrl) {
    throw new Error("团队导出服务未返回可下载文件。");
  }

  const resolvedUrl = resolveDownloadUrl(downloadUrl);
  const headers: Record<string, string> = {};
  const token = useAuthStore.getState().token;
  const serverOrigin = new URL(getServerUrl()).origin;
  const downloadOrigin = new URL(resolvedUrl).origin;
  if (token && serverOrigin === downloadOrigin) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(resolvedUrl, { headers });
  if (!response.ok) {
    throw new Error(`下载团队导出文件失败: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const { appDataDir } = await import("@tauri-apps/api/path");
  const { BaseDirectory, mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
  await mkdir("data-export-downloads/team", {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });

  const appData = await appDataDir();
  const fileName = sanitizeExportFileName(
    String(result.fileName ?? resolvedUrl.split("/").pop() ?? "team-export.csv"),
  );
  const filePath = `${appData}/data-export-downloads/team/${fileName}`;
  await writeFile(filePath, bytes);
  return { path: filePath, fileName };
}

export class IMDataExportRuntimeManager {
  private readonly sessions = new Map<string, ExportSessionState>();
  private readonly conversationModes = new Map<string, IMConversationMode>();
  private readonly onReply: (params: {
    channelId: string;
    conversationId: string;
    text: string;
    messageId?: string;
    attachments?: { path: string; fileName?: string }[];
  }) => Promise<void>;

  constructor(options: {
    onReply: (params: {
      channelId: string;
      conversationId: string;
      text: string;
      messageId?: string;
      attachments?: { path: string; fileName?: string }[];
    }) => Promise<void>;
  }) {
    this.onReply = options.onReply;
  }

  dispose(): void {
    this.sessions.clear();
    this.conversationModes.clear();
  }

  hasActiveSession(channelId: string, conversationId: string): boolean {
    return this.sessions.has(buildSessionKey(channelId, conversationId));
  }

  disposeChannel(channelId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.channelId === channelId) {
        this.sessions.delete(key);
      }
    }
    for (const [key] of this.conversationModes) {
      if (key.startsWith(`${channelId.trim()}::`)) {
        this.conversationModes.delete(key);
      }
    }
    useIMConversationRuntimeStore.getState().clearChannel(channelId);
  }

  clearConversation(channelId: string, conversationId: string): void {
    this.clearExportSession(channelId, conversationId);
    this.setConversationMode(channelId, conversationId, "normal");
    useIMConversationRuntimeStore.getState().clearExternalConversation(channelId, conversationId);
  }

  private getSession(channelId: string, conversationId: string): ExportSessionState | undefined {
    return this.sessions.get(buildSessionKey(channelId, conversationId));
  }

  private clearExportSession(channelId: string, conversationId: string): void {
    this.sessions.delete(buildSessionKey(channelId, conversationId));
  }

  private getConversationMode(channelId: string, conversationId: string): IMConversationMode {
    return this.conversationModes.get(buildSessionKey(channelId, conversationId)) ?? "normal";
  }

  private setConversationMode(
    channelId: string,
    conversationId: string,
    mode: IMConversationMode,
  ): IMConversationMode {
    const key = buildSessionKey(channelId, conversationId);
    if (mode === "database_operation") {
      this.conversationModes.set(key, mode);
      return mode;
    }
    this.conversationModes.delete(key);
    return "normal";
  }

  private upsertSession(
    channelId: string,
    conversationId: string,
    patch: Partial<ExportSessionState> & Pick<ExportSessionState, "originalRequest" | "status">,
  ): ExportSessionState {
    const key = buildSessionKey(channelId, conversationId);
    const now = Date.now();
    const existing = this.sessions.get(key);
    const next: ExportSessionState = {
      key,
      channelId,
      conversationId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...existing,
      ...patch,
    };
    this.sessions.set(key, next);
    return next;
  }

  private async sendReply(params: {
    channelId: string;
    conversationId: string;
    messageId?: string;
    text: string;
    attachments?: { path: string; fileName?: string }[];
  }): Promise<void> {
    await this.onReply(params);
  }

  private recordConversationTurn(params: {
    channelId: string;
    channelType: ChannelType;
    msg: ChannelIncomingMessage;
    content: string;
    conversationMode: IMConversationMode;
    from: "user" | "assistant";
    status: "idle" | "running" | "waiting";
    attachments?: { path: string; fileName?: string }[];
  }): void {
    log.info("recording export conversation turn", {
      channelId: params.channelId,
      channelType: params.channelType,
      conversationId: params.msg.conversationId,
      conversationType: params.msg.conversationType,
      from: params.from,
      status: params.status,
      textPreview: params.content.slice(0, 120),
      attachmentCount: params.attachments?.length ?? 0,
    });
    useIMConversationRuntimeStore.getState().upsertExternalConversationTurn({
      channelId: params.channelId,
      channelType: params.channelType,
      conversationId: params.msg.conversationId,
      conversationType: params.msg.conversationType,
      content: params.content,
      from: params.from,
      status: params.status,
      messageId: params.from === "user" ? params.msg.messageId : undefined,
      timestamp: params.from === "user" ? (params.msg.timestamp || Date.now()) : Date.now(),
      displayLabel: buildRuntimeDisplayLabel(params.channelType, params.msg),
      displayDetail: buildRuntimeDisplayDetail(params.channelType, params.msg),
      conversationMode: params.conversationMode,
      attachments: params.attachments,
    });
  }

  async handleIncoming(params: {
    channelId: string;
    channelType: ChannelType;
    msg: ChannelIncomingMessage;
  }): Promise<{ handled: boolean }> {
    const { channelId, msg } = params;
    const conversationId = msg.conversationId;
    const text = String(msg.text ?? "").trim();
    const normalizedExportText = normalizeExportIntentText(text);
    const conversationMode = this.getConversationMode(channelId, conversationId);
    const session = this.getSession(channelId, conversationId);
    const isEnterModeCommand = isEnterDatabaseOperationModeCommand(text);
    const isExitModeCommand = isExitDatabaseOperationModeCommand(text);

    log.info("evaluating incoming IM message for export lane", {
      channelId,
      conversationId,
      messageId: msg.messageId,
      senderName: msg.senderName,
      conversationMode,
      hasSession: Boolean(session),
      isEnterModeCommand,
      isExitModeCommand,
      rawText: text.slice(0, 160),
      normalizedExportText: normalizedExportText.slice(0, 160),
    });

    if (isEnterModeCommand) {
      const nextMode = this.setConversationMode(channelId, conversationId, "database_operation");
      this.recordConversationTurn({
        channelId,
        channelType: params.channelType,
        msg,
        content: text,
        conversationMode: nextMode,
        from: "user",
        status: "running",
      });
      this.recordConversationTurn({
        channelId,
        channelType: params.channelType,
        msg,
        content: ENTER_DATABASE_OPERATION_MODE_REPLY,
        conversationMode: nextMode,
        from: "assistant",
        status: "idle",
      });
      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: ENTER_DATABASE_OPERATION_MODE_REPLY,
      });
      return { handled: true };
    }

    if (conversationMode !== "database_operation") {
      return { handled: false };
    }

    this.recordConversationTurn({
      channelId,
      channelType: params.channelType,
      msg,
      content: text,
      conversationMode,
      from: "user",
      status: "running",
    });

    if (isExitModeCommand) {
      this.clearExportSession(channelId, conversationId);
      const nextMode = this.setConversationMode(channelId, conversationId, "normal");
      this.recordConversationTurn({
        channelId,
        channelType: params.channelType,
        msg,
        content: EXIT_DATABASE_OPERATION_MODE_REPLY,
        conversationMode: nextMode,
        from: "assistant",
        status: "idle",
      });
      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: EXIT_DATABASE_OPERATION_MODE_REPLY,
      });
      return { handled: true };
    }

    if (session && isExportCancellation(text)) {
      this.clearExportSession(channelId, conversationId);
      const replyText = CANCEL_EXPORT_IN_DATABASE_OPERATION_MODE_REPLY;
      this.recordConversationTurn({
        channelId,
        channelType: params.channelType,
        msg,
        content: replyText,
        conversationMode,
        from: "assistant",
        status: "idle",
      });
      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: replyText,
      });
      return { handled: true };
    }

    if (session?.status === "exporting") {
      if (isExportConfirmation(text) || isExportCancellation(text)) {
        log.info("ignoring duplicate export control message while export is already running", {
          channelId,
          conversationId,
          messageId: msg.messageId,
          textPreview: text.slice(0, 80),
        });
        return { handled: true };
      }

      const replyText = "上一份导出还在处理中，请稍候，完成后我会把文件回传给你。";
      this.recordConversationTurn({
        channelId,
        channelType: params.channelType,
        msg,
        content: replyText,
        conversationMode,
        from: "assistant",
        status: "waiting",
      });
      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: replyText,
      });
      return { handled: true };
    }

    try {
      if (session?.status === "awaiting_confirmation" && isExportConfirmation(text)) {
        const previewToken = String(session.preview?.previewToken ?? "").trim();
        if (!previewToken) {
          throw new Error("缺少可确认的导出预览，请重新发起一次导出请求。");
        }
        this.upsertSession(channelId, conversationId, {
          status: "exporting",
          originalRequest: session.originalRequest,
          preview: session.preview,
          lastIntent: session.lastIntent,
        });
        log.info("starting confirmed export", {
          channelId,
          conversationId,
          messageId: msg.messageId,
          previewToken,
        });

        let attachment: { path: string; fileName?: string };
        let rowCount = 0;
        if (session.lastIntent?.sourceScope === "team") {
          const teamId = String(session.lastIntent.teamId ?? "").trim();
          if (!teamId) {
            throw new Error("缺少团队上下文，无法确认团队导出。");
          }
          try {
            const result = await confirmTeamDataExport(teamId, previewToken);
            rowCount = result.rowCount;
            attachment = await materializeTeamExportAttachment(result);
          } catch (error) {
            if (isTeamDataExportApiUnavailable(error)) {
              throw new Error("当前团队导出服务尚未启用，已识别到团队数据集，但还不能真正执行导出。");
            }
            throw error;
          }
        } else {
          const result = await invoke<ExportResult>("data_export_confirm_csv_export", {
            previewToken,
          });
          rowCount = result.rowCount;
          attachment = {
            path: result.filePath,
            fileName: result.filePath.split("/").pop() || "export.csv",
          };
        }
        this.clearExportSession(channelId, conversationId);
        const replyText = `导出完成，共 ${rowCount} 行。文件已回传给你。`;
        this.recordConversationTurn({
          channelId,
          channelType: params.channelType,
          msg,
          content: replyText,
          conversationMode,
          from: "assistant",
          status: "idle",
          attachments: [attachment],
        });
        await this.sendReply({
          channelId,
          conversationId,
          messageId: msg.messageId,
          text: replyText,
          attachments: [attachment],
        });
        return { handled: true };
      }

      const originalRequest = session?.originalRequest?.trim() || normalizedExportText;
      const decision = await runExportAgent({
        userInput: normalizedExportText,
        originalRequest: session ? originalRequest : undefined,
      });

      if (decision.kind === "clarify") {
        this.upsertSession(channelId, conversationId, {
          status: "awaiting_clarification",
          originalRequest,
          clarificationQuestion: decision.question,
          preview: undefined,
          lastIntent: undefined,
        });
        this.recordConversationTurn({
          channelId,
          channelType: params.channelType,
          msg,
          content: decision.question,
          conversationMode,
          from: "assistant",
          status: "waiting",
        });
        await this.sendReply({
          channelId,
          conversationId,
          messageId: msg.messageId,
          text: decision.question,
        });
        return { handled: true };
      }

      if (decision.kind === "answer") {
        this.upsertSession(channelId, conversationId, {
          status: "awaiting_followup",
          originalRequest,
          preview: undefined,
          lastIntent: undefined,
        });
        this.recordConversationTurn({
          channelId,
          channelType: params.channelType,
          msg,
          content: decision.answer,
          conversationMode,
          from: "assistant",
          status: "waiting",
        });
        await this.sendReply({
          channelId,
          conversationId,
          messageId: msg.messageId,
          text: decision.answer,
        });
        return { handled: true };
      }

      if (decision.kind === "reject") {
        this.upsertSession(channelId, conversationId, {
          status: "awaiting_followup",
          originalRequest,
          preview: undefined,
          lastIntent: undefined,
        });
        this.recordConversationTurn({
          channelId,
          channelType: params.channelType,
          msg,
          content: decision.reason,
          conversationMode,
          from: "assistant",
          status: "idle",
        });
        await this.sendReply({
          channelId,
          conversationId,
          messageId: msg.messageId,
          text: decision.reason,
        });
        return { handled: true };
      }

      const { sources, datasets } = await loadRuntimeExportCatalog();
      const source = sources.find((item) => item.id === decision.intent.sourceId);
      if (!source) {
        throw new Error(`导出 Agent 选择了未知数据源: ${decision.intent.sourceId}`);
      }
      const dataset =
        decision.intent.datasetId
          ? datasets.find((item) => item.id === decision.intent.datasetId)
          : undefined;
      const resolvedIntent: StructuredExportIntent = {
        ...decision.intent,
        sourceId: source.id,
        sourceScope: source.scope,
        ...(source.scope === "team" ? { teamId: source.teamId } : {}),
      };

      let preview: ExportPreview;
      if (source.scope === "team") {
        if (decision.intent.joins?.length) {
          throw new Error("当前联表导出仅支持个人 SQL 数据源，团队共享数据集暂不支持联表。");
        }
        try {
          preview = await previewTeamDataExport(source.teamId, {
            ...decision.intent,
            sourceId: source.originSourceId,
            sourceScope: "team",
            teamId: source.teamId,
            ...(dataset && dataset.scope === "team"
              ? { datasetId: dataset.originDatasetId }
              : {}),
          });
        } catch (error) {
          if (isTeamDataExportApiUnavailable(error)) {
            throw new Error("当前团队导出服务尚未启用，已识别到团队数据集，但还不能真正执行导出。");
          }
          throw error;
        }
      } else {
        await ensureExportSourceConnected(source);
        preview = await invoke<ExportPreview>("data_export_preview", {
          intent: {
            sourceId: source.originSourceId,
            entityName: decision.intent.entityName,
            entityType: decision.intent.entityType,
            schema: decision.intent.schema ?? null,
            baseAlias: decision.intent.baseAlias ?? null,
            fields: decision.intent.fields ?? null,
            joins: decision.intent.joins ?? null,
            filters: decision.intent.filters ?? null,
            sort: decision.intent.sort ?? null,
            limit: decision.intent.limit ?? null,
            outputFormat: "csv",
          } satisfies {
            sourceId: string;
            entityName: string;
            entityType?: string;
            schema: string | null;
            baseAlias: string | null;
            fields: StructuredExportIntent["fields"] | null;
            joins: StructuredExportIntent["joins"] | null;
            filters: StructuredExportIntent["filters"] | null;
            sort: StructuredExportIntent["sort"] | null;
            limit: number | null;
            outputFormat: "csv";
          },
        });
      }

      const hasPreviewRows = preview.previewRowCount > 0;
      this.upsertSession(channelId, conversationId, {
        status: hasPreviewRows ? "awaiting_confirmation" : "awaiting_followup",
        originalRequest,
        preview: hasPreviewRows ? preview : undefined,
        lastIntent: hasPreviewRows ? resolvedIntent : undefined,
      });

      const replyText = [
        decision.summary?.trim() || `我理解的是：从 ${decision.intent.entityName} 导出符合条件的数据。`,
        summarizePreview(preview),
      ]
        .filter(Boolean)
        .join("\n\n");
      this.recordConversationTurn({
        channelId,
        channelType: params.channelType,
        msg,
        content: replyText,
        conversationMode,
        from: "assistant",
        status: "waiting",
      });
      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: replyText,
      });
      return { handled: true };
    } catch (error) {
      log.error("Failed to handle IM export request", error);
      this.upsertSession(channelId, conversationId, {
        status: "awaiting_followup",
        originalRequest: session?.originalRequest?.trim() || text,
        preview: undefined,
        lastIntent: undefined,
      });
      const replyText = `这次导出没有跑通：${error instanceof Error ? error.message : String(error)}`;
      this.recordConversationTurn({
        channelId,
        channelType: params.channelType,
        msg,
        content: replyText,
        conversationMode,
        from: "assistant",
        status: "idle",
      });
      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: replyText,
      });
      return { handled: true };
    }
  }
}
