/**
 * AIChatService — AI 对话流式监听与消息处理逻辑
 *
 * 从 ai-store 中抽取：
 * - 6 个事件监听器的注册/清理
 * - 消息裁剪逻辑（regenerate / editAndResend）
 * - 防抖持久化
 * - 流式请求发起
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MAX_CONVERSATIONS,
  MAX_MESSAGES_PER_CONVERSATION,
} from "@/core/constants";
import { createDebouncedPersister } from "@/core/storage";
import { useAuthStore } from "@/store/auth-store";
import { routeAIRequest } from "@/core/ai/router";
import { AssistantReasoningStreamNormalizer } from "@/core/ai/reasoning-tag-stream";
import { getResolvedAIConfigForMode } from "@/core/ai/resolved-ai-config-store";
import { handleError } from "@/core/errors";
import { mergeStructuredMedia } from "@/core/media/structured-media";
import type { AICenterMode } from "@/store/app-store";
import type {
  ToolCallInfo,
  ChatMessage,
  Conversation,
  AIConfig,
  PendingToolConfirm,
} from "@/core/ai/types";

// ── 类型 ──

export interface StreamCallbacks {
  /** 更新当前 assistant 消息 */
  updateAssistant: (updater: (m: ChatMessage) => ChatMessage) => void;
  /** 设置 Store 状态 */
  setState: (partial: {
    isStreaming?: boolean;
    pendingToolConfirm?: PendingToolConfirm | null;
  }) => void;
  /** 触发防抖持久化 */
  onPersist: () => void;
  /** 最终回答完成后触发 */
  onDone?: (assistantContent: string) => void;
  /** 流式执行失败后触发 */
  onError?: (errorText: string, assistantContent: string) => void;
}

interface StreamToolCallPayload {
  id: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

// ── ID 生成器 ──

export function generateChatId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// ── 防抖持久化（使用统一工具） ──

let _lastPersistedHash: number = 0;
let _debouncedPersistCb: (() => void) | null = null;
const _chatPersister = createDebouncedPersister(() => {
  _debouncedPersistCb?.();
});

/**
 * 防抖触发持久化（向后兼容旧签名）
 */
export function debouncedPersist(persistFn: () => void) {
  _debouncedPersistCb = persistFn;
  _chatPersister.trigger();
}

// ── 持久化逻辑 ──

/** FNV-1a 32-bit 字符串哈希 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0, len = str.length; i < len; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

const PERSIST_MAX_RETRIES = 2;

export async function persistConversations(conversations: Conversation[]): Promise<void> {
  const trimmed = conversations
    .slice(0, MAX_CONVERSATIONS)
    .map((c) => ({
      ...c,
      messages: c.messages.slice(-MAX_MESSAGES_PER_CONVERSATION).map((m) => ({
        ...m,
        streaming: false,
      })),
    }));
  const json = JSON.stringify(trimmed);
  const hash = fnv1a(json);
  if (hash === _lastPersistedHash) return;

  for (let attempt = 0; attempt <= PERSIST_MAX_RETRIES; attempt++) {
    try {
      await invoke("save_chat_history", { conversations: json });
      _lastPersistedHash = hash;
      return;
    } catch (e) {
      if (attempt === PERSIST_MAX_RETRIES) {
        handleError(e, { context: "保存对话历史", silent: true });
      } else {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
}

export async function loadConversationHistory(): Promise<Conversation[]> {
  try {
    const json = await invoke<string>("load_chat_history");
    return JSON.parse(json) as Conversation[];
  } catch (e) {
    handleError(e, { context: "加载对话历史", silent: true });
    return [];
  }
}

// ── 消息裁剪 ──

/**
 * 为 regenerate 准备消息列表：移除尾部 assistant 消息和最后一条 user 消息
 * @returns 裁剪后的消息列表和被移除的 user 消息内容
 */
export function prepareRegenerateMessages(
  messages: ChatMessage[],
): { keptMessages: ChatMessage[]; lastUserMessage: ChatMessage | null } {
  const copy = [...messages];
  while (copy.length > 0 && copy[copy.length - 1].role === "assistant") {
    copy.pop();
  }
  const lastUserMsg =
    copy.length > 0 && copy[copy.length - 1].role === "user"
      ? copy.pop()
      : null;
  return {
    keptMessages: copy,
    lastUserMessage: lastUserMsg ?? null,
  };
}

/**
 * 为 editAndResend 准备消息列表：截断到指定消息之前
 */
export function prepareEditMessages(
  messages: ChatMessage[],
  messageId: string,
): { keptMessages: ChatMessage[]; targetMessage: ChatMessage | null } | null {
  const msgIndex = messages.findIndex((m) => m.id === messageId);
  if (msgIndex === -1) return null;
  return {
    keptMessages: messages.slice(0, msgIndex),
    targetMessage: messages[msgIndex] ?? null,
  };
}

// ── reasoning 标签过滤器 ──

/**
 * 流式 chunk 中拆分 `<think> / <thinking> / <final>` 等标签内容，
 * 支持跨 chunk 边界的增量解析。
 */
// ── 流式监听 ──

/**
 * 注册所有流式事件监听器，并发起 AI 请求。
 * 返回 cleanup 函数用于手动清理。
 */
export async function startStreamingChat(opts: {
  conversationId: string;
  assistantMessageId: string;
  apiMessages: Array<{ role: string; content: string; images?: string[] }>;
  config: AIConfig;
  mode?: AICenterMode;
  callbacks: StreamCallbacks;
  extraTools?: any[];
  onFrontendToolCall?: (name: string, args: string) => Promise<{ success: boolean; result: string }>;
}): Promise<() => void> {
  const {
    conversationId,
    assistantMessageId,
    apiMessages,
    config,
    mode,
    callbacks,
    extraTools,
    onFrontendToolCall,
  } = opts;
  const { updateAssistant, setState, onPersist } = callbacks;
  const effectiveConfig = mode ? getResolvedAIConfigForMode(mode) : config;

  // OpenClaw 风格的统一 reasoning 规范化层：
  // 原生 thinking 事件和 <think>/<final> 标签都先汇总到这里。
  const reasoningStream = new AssistantReasoningStreamNormalizer();

  // chunk 缓冲：累积多个 chunk 后批量刷新到 React state，减少 re-render 次数
  let _chunkBuffer = "";
  let _chunkRafId: number | null = null;
  let _thinkingBuffer = "";
  let _thinkingRafId: number | null = null;

  function clearPendingFrames() {
    if (_chunkRafId !== null) {
      cancelAnimationFrame(_chunkRafId);
      _chunkRafId = null;
    }
    if (_thinkingRafId !== null) {
      cancelAnimationFrame(_thinkingRafId);
      _thinkingRafId = null;
    }
  }

  function flushChunkBuffer() {
    _chunkRafId = null;
    if (!_chunkBuffer) return;
    const flushed = _chunkBuffer;
    _chunkBuffer = "";
    updateAssistant((m) => ({
      ...m,
      content: m.content + flushed,
    }));
  }

  function flushThinkingBuffer() {
    _thinkingRafId = null;
    if (!_thinkingBuffer) return;
    const flushed = _thinkingBuffer;
    _thinkingBuffer = "";
    updateAssistant((m) => ({
      ...m,
      thinkingContent: (m.thinkingContent || "") + flushed,
      thinkingStreaming: true,
    }));
  }

  function finalizeStreamFailure(errorText: string) {
    clearPendingFrames();
    const remaining = reasoningStream.flush();
    const visibleContent = (_chunkBuffer || "") + remaining.visible;
    const thinkingContent = _thinkingBuffer + remaining.thinking;
    _chunkBuffer = "";
    _thinkingBuffer = "";

    let finalizedAssistantContent = "";
    updateAssistant((m) => {
      const nextContent = visibleContent ? m.content + visibleContent : m.content;
      const normalizedError = errorText.trim() || "请求失败";
      const rawFinalContent = nextContent.trim()
        ? `${nextContent}\n\n⚠️ 生成中断：${normalizedError}`
        : `❌ ${normalizedError}`;
      const structuredReply = mergeStructuredMedia({
        text: rawFinalContent,
        images: m.images,
        attachments: m.attachments,
      });
      finalizedAssistantContent = structuredReply.text;
      return {
        ...m,
        content: structuredReply.text,
        streaming: false,
        thinkingContent: thinkingContent
          ? (m.thinkingContent || "") + thinkingContent
          : m.thinkingContent,
        thinkingStreaming: false,
        ...(structuredReply.images?.length ? { images: structuredReply.images } : {}),
        ...(structuredReply.attachments?.length
          ? { attachments: structuredReply.attachments }
          : {}),
      };
    });
    setState({ isStreaming: false, pendingToolConfirm: null });
    cleanup();
    onPersist();
    callbacks.onError?.(errorText.trim() || "请求失败", finalizedAssistantContent);
  }

  // 并行注册所有事件监听器（减少 IPC 串行等待）
  const [
    unlisten,
    unlistenToolCalls,
    unlistenToolResult,
    unlistenToolConfirm,
    unlistenThinking,
    unlistenDone,
    unlistenError,
    unlistenFrontendTool,
  ] = await Promise.all([
    listen<{ conversation_id: string; content: string }>(
      "ai-stream-chunk",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          const filtered = reasoningStream.processTextChunk(
            event.payload.content,
          );
          if (filtered.visible) {
            _chunkBuffer += filtered.visible;
            if (_chunkRafId === null) {
              _chunkRafId = requestAnimationFrame(flushChunkBuffer);
            }
          }
          if (filtered.thinking) {
            _thinkingBuffer += filtered.thinking;
            if (_thinkingRafId === null) {
              _thinkingRafId = requestAnimationFrame(flushThinkingBuffer);
            }
          }
        }
      },
    ),
    listen<{ conversation_id: string; tool_calls: StreamToolCallPayload[] }>(
      "ai-stream-tool-calls",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          const newCalls = event.payload.tool_calls
            .filter((tc) => typeof tc.function?.name === "string" && tc.function.name.trim().length > 0)
            .map<ToolCallInfo>((tc) => ({
              id: tc.id,
              name: tc.function?.name?.trim() ?? "",
              arguments: tc.function?.arguments ?? "",
            }));
          if (newCalls.length === 0) return;
          updateAssistant((m) => ({
            ...m,
            content: m.content || "正在调用工具...",
            toolCalls: [...(m.toolCalls || []), ...newCalls],
          }));
        }
      },
    ),
    listen<{ conversation_id: string; tool_call_id: string; name: string; result: string }>(
      "ai-stream-tool-result",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          updateAssistant((m) => ({
            ...m,
            toolCalls: m.toolCalls?.map((tc) =>
              tc.id === event.payload.tool_call_id
                ? { ...tc, result: event.payload.result }
                : tc,
            ),
          }));
        }
      },
    ),
    listen<{ name: string; arguments: string }>(
      "ai-tool-confirm-request",
      async (event) => {
        const { useToolTrustStore } = await import("@/store/command-allowlist-store");
        let params: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(event.payload.arguments || "{}");
          if (parsed && typeof parsed === "object") {
            params = parsed as Record<string, unknown>;
          }
        } catch {
          params = { rawArguments: event.payload.arguments };
        }
        if (!useToolTrustStore.getState().shouldConfirm(event.payload.name, params)) {
          await invoke("ai_confirm_tool", { approved: true });
          return;
        }
        setState({ pendingToolConfirm: event.payload });
      },
    ),
    listen<{ conversation_id: string; content: string }>(
      "ai-stream-thinking",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          const filtered = reasoningStream.processThinkingChunk(
            event.payload.content || "",
          );
          if (!filtered.thinking) return;
          _thinkingBuffer += filtered.thinking;
          if (_thinkingRafId === null) {
            _thinkingRafId = requestAnimationFrame(flushThinkingBuffer);
          }
        }
      },
    ),
    listen<{ conversation_id: string }>(
      "ai-stream-done",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          if (_chunkRafId !== null) {
            cancelAnimationFrame(_chunkRafId);
            _chunkRafId = null;
          }
          const remaining = reasoningStream.flush();
          const remainingVisible = (_chunkBuffer || "") + remaining.visible;
          _chunkBuffer = "";
          if (_thinkingRafId !== null) {
            cancelAnimationFrame(_thinkingRafId);
            _thinkingRafId = null;
          }
          const thinkingRemaining = _thinkingBuffer + remaining.thinking;
          _thinkingBuffer = "";
          let completedAssistantContent = "";
          updateAssistant((m) => {
            const shouldSuggestUpgrade = (m.toolCalls?.length ?? 0) >= 2;
            const rawCompletedContent = remainingVisible ? m.content + remainingVisible : m.content;
            const structuredReply = mergeStructuredMedia({
              text: rawCompletedContent,
              images: m.images,
              attachments: m.attachments,
            });
            completedAssistantContent = structuredReply.text;
            return {
              ...m,
              content: structuredReply.text,
              streaming: false,
              thinkingContent: thinkingRemaining
                ? (m.thinkingContent || "") + thinkingRemaining
                : m.thinkingContent,
              thinkingStreaming: false,
              ...(structuredReply.images?.length ? { images: structuredReply.images } : {}),
              ...(structuredReply.attachments?.length
                ? { attachments: structuredReply.attachments }
                : {}),
              ...(shouldSuggestUpgrade ? { suggestAgentUpgrade: true } : {}),
            };
          });
          setState({ isStreaming: false });
          cleanup();
          onPersist();
          callbacks.onDone?.(completedAssistantContent);
        }
      },
    ),
    listen<{ conversation_id: string; error: string }>(
      "ai-stream-error",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          finalizeStreamFailure(event.payload.error);
        }
      },
    ),
    listen<{ name: string; arguments: string }>(
      "ai-frontend-tool-call",
      async (event) => {
        const { name, arguments: args } = event.payload;
        try {
          if (onFrontendToolCall) {
            const { success, result } = await onFrontendToolCall(name, args);
            await invoke("ai_frontend_tool_result", { success, result });
          } else {
            await invoke("ai_frontend_tool_result", {
              success: false,
              result: `工具 ${name} 无前端执行器`,
            });
          }
        } catch (e) {
          await invoke("ai_frontend_tool_result", {
            success: false,
            result: `前端工具执行异常: ${e}`,
          });
        }
      },
    ),
  ]);

  const cleanup = () => {
    clearPendingFrames();
    if (_chunkBuffer) flushChunkBuffer();
    if (_thinkingBuffer) flushThinkingBuffer();
    unlisten();
    unlistenToolCalls();
    unlistenToolResult();
    unlistenToolConfirm();
    unlistenThinking();
    unlistenDone();
    unlistenError();
    unlistenFrontendTool();
  };

  // 发起 AI 请求
  try {
    const { token } = useAuthStore.getState();
    await routeAIRequest({
      messages: apiMessages,
      config: effectiveConfig,
      conversationId,
      token,
      extraTools,
    });
  } catch (e) {
    handleError(e, { context: "AI 对话" });
    const message = e instanceof Error ? e.message : String(e);
    finalizeStreamFailure(message || "发起对话失败");
  }

  return cleanup;
}
