import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@/core/logger";
import type { ChannelIncomingMessage, ChannelType } from "@/core/channels/types";
import {
  ensureExportSourceConnected,
  loadExportSources,
  runExportAgent,
} from "./export-agent";
import {
  isExportCancellation,
  isExportConfirmation,
  isLikelyExportIntent,
} from "./export-intent-router";
import type {
  ExportPreview,
  ExportResult,
  ExportSessionState,
  StructuredExportIntent,
} from "./types";

const log = createLogger("IMDataExportRuntime");

function buildSessionKey(channelId: string, conversationId: string): string {
  return `${channelId.trim()}::${conversationId.trim()}`;
}

function summarizePreview(preview: ExportPreview): string {
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

export class IMDataExportRuntimeManager {
  private readonly sessions = new Map<string, ExportSessionState>();
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
  }

  clearConversation(channelId: string, conversationId: string): void {
    this.sessions.delete(buildSessionKey(channelId, conversationId));
  }

  private getSession(channelId: string, conversationId: string): ExportSessionState | undefined {
    return this.sessions.get(buildSessionKey(channelId, conversationId));
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

  async handleIncoming(params: {
    channelId: string;
    channelType: ChannelType;
    msg: ChannelIncomingMessage;
  }): Promise<{ handled: boolean }> {
    const { channelId, msg } = params;
    const conversationId = msg.conversationId;
    const text = String(msg.text ?? "").trim();
    const session = this.getSession(channelId, conversationId);

    if (!session && !isLikelyExportIntent(text)) {
      return { handled: false };
    }

    if (session && isExportCancellation(text)) {
      this.clearConversation(channelId, conversationId);
      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: "已取消这次数据导出请求。需要重新导出时，直接再发一句自然语言给我就行。",
      });
      return { handled: true };
    }

    try {
      if (session?.status === "awaiting_confirmation" && isExportConfirmation(text)) {
        const result = await invoke<ExportResult>("data_export_confirm_csv_export", {
          previewToken: session.preview?.previewToken,
        });
        this.clearConversation(channelId, conversationId);
        const fileName = result.filePath.split("/").pop() || "export.csv";
        await this.sendReply({
          channelId,
          conversationId,
          messageId: msg.messageId,
          text: `导出完成，共 ${result.rowCount} 行。文件已回传给你。`,
          attachments: [{ path: result.filePath, fileName }],
        });
        return { handled: true };
      }

      const originalRequest = session?.originalRequest?.trim() || text;
      const decision = await runExportAgent({
        userInput: text,
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
        await this.sendReply({
          channelId,
          conversationId,
          messageId: msg.messageId,
          text: decision.question,
        });
        return { handled: true };
      }

      if (decision.kind === "reject") {
        this.clearConversation(channelId, conversationId);
        await this.sendReply({
          channelId,
          conversationId,
          messageId: msg.messageId,
          text: decision.reason,
        });
        return { handled: true };
      }

      const sources = await loadExportSources();
      const source = sources.find((item) => item.id === decision.intent.sourceId);
      if (!source) {
        throw new Error(`导出 Agent 选择了未知数据源: ${decision.intent.sourceId}`);
      }
      await ensureExportSourceConnected(source);
      const preview = await invoke<ExportPreview>("data_export_preview", {
        intent: {
          sourceId: decision.intent.sourceId,
          entityName: decision.intent.entityName,
          entityType: decision.intent.entityType,
          schema: decision.intent.schema ?? null,
          fields: decision.intent.fields ?? null,
          filters: decision.intent.filters ?? null,
          sort: decision.intent.sort ?? null,
          limit: decision.intent.limit ?? null,
          outputFormat: "csv",
        } satisfies {
          sourceId: string;
          entityName: string;
          entityType?: string;
          schema: string | null;
          fields: string[] | null;
          filters: StructuredExportIntent["filters"] | null;
          sort: StructuredExportIntent["sort"] | null;
          limit: number | null;
          outputFormat: "csv";
        },
      });

      this.upsertSession(channelId, conversationId, {
        status: "awaiting_confirmation",
        originalRequest,
        preview,
        lastIntent: decision.intent,
      });

      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: [
          decision.summary?.trim() || `我理解的是：从 ${decision.intent.entityName} 导出符合条件的数据。`,
          summarizePreview(preview),
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      return { handled: true };
    } catch (error) {
      log.error("Failed to handle IM export request", error);
      this.clearConversation(channelId, conversationId);
      await this.sendReply({
        channelId,
        conversationId,
        messageId: msg.messageId,
        text: `这次导出没有跑通：${error instanceof Error ? error.message : String(error)}`,
      });
      return { handled: true };
    }
  }
}
