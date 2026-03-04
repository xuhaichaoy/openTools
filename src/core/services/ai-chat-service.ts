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
import { handleError } from "@/core/errors";
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

  // 采样哈希避免完全遍历：取长度+头64+尾64+中间64字符
  const sampleLen = 64;
  const mid = Math.max(0, Math.floor(json.length / 2) - sampleLen / 2);
  const sample = `${json.length}:${json.slice(0, sampleLen)}:${json.slice(mid, mid + sampleLen)}:${json.slice(-sampleLen)}`;
  const hash = fnv1a(sample);
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
): { keptMessages: ChatMessage[]; lastUserContent: string | null } {
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
    lastUserContent: lastUserMsg?.content ?? null,
  };
}

/**
 * 为 editAndResend 准备消息列表：截断到指定消息之前
 */
export function prepareEditMessages(
  messages: ChatMessage[],
  messageId: string,
): ChatMessage[] | null {
  const msgIndex = messages.findIndex((m) => m.id === messageId);
  if (msgIndex === -1) return null;
  return messages.slice(0, msgIndex);
}

// ── <think> 标签过滤器 ──

/**
 * 流式 chunk 中剥离 `<think>...</think>` 标签及其内容。
 * 支持跨 chunk 边界的标签匹配。
 */
export class ThinkTagFilter {
  private inThink = false;
  private buffer = "";

  /** 处理一个 chunk，返回过滤后的可展示文本 */
  process(chunk: string): string {
    this.buffer += chunk;
    let output = "";

    while (this.buffer.length > 0) {
      if (this.inThink) {
        const endIdx = this.buffer.indexOf("</think>");
        if (endIdx !== -1) {
          this.inThink = false;
          this.buffer = this.buffer.slice(endIdx + 8); // skip "</think>"
        } else {
          // 仍在 think 块内，保留可能的 partial "</think>" 尾部
          if (this.buffer.length > 8) {
            this.buffer = this.buffer.slice(-8);
          }
          break;
        }
      } else {
        const startIdx = this.buffer.indexOf("<think>");
        if (startIdx !== -1) {
          output += this.buffer.slice(0, startIdx);
          this.inThink = true;
          this.buffer = this.buffer.slice(startIdx + 7); // skip "<think>"
        } else {
          // 检查尾部是否有不完整的 "<think>" 开头
          let safeEnd = this.buffer.length;
          for (let i = 1; i < Math.min(7, this.buffer.length + 1); i++) {
            if ("<think>".startsWith(this.buffer.slice(-i))) {
              safeEnd = this.buffer.length - i;
              break;
            }
          }
          output += this.buffer.slice(0, safeEnd);
          this.buffer = this.buffer.slice(safeEnd);
          break;
        }
      }
    }

    return output;
  }

  /** 流结束时刷出剩余缓冲 */
  flush(): string {
    const remaining = this.inThink ? "" : this.buffer;
    this.buffer = "";
    this.inThink = false;
    return remaining;
  }
}

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
  callbacks: StreamCallbacks;
}): Promise<() => void> {
  const { conversationId, assistantMessageId, apiMessages, config, callbacks } = opts;
  const { updateAssistant, setState, onPersist } = callbacks;

  // <think> 标签过滤器（DeepSeek 等模型的思考过程）
  const thinkFilter = new ThinkTagFilter();

  // chunk 缓冲：累积多个 chunk 后批量刷新到 React state，减少 re-render 次数
  let _chunkBuffer = "";
  let _chunkRafId: number | null = null;

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

  // 并行注册所有事件监听器（减少 IPC 串行等待）
  const [
    unlisten,
    unlistenToolCalls,
    unlistenToolResult,
    unlistenToolConfirm,
    unlistenDone,
    unlistenError,
  ] = await Promise.all([
    listen<{ conversation_id: string; content: string }>(
      "ai-stream-chunk",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          const filtered = thinkFilter.process(event.payload.content);
          if (filtered) {
            _chunkBuffer += filtered;
            if (_chunkRafId === null) {
              _chunkRafId = requestAnimationFrame(flushChunkBuffer);
            }
          }
        }
      },
    ),
    listen<{ conversation_id: string; tool_calls: ToolCallInfo[] }>(
      "ai-stream-tool-calls",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          const newCalls = event.payload.tool_calls.map((tc: any) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));
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
        if (!useToolTrustStore.getState().shouldConfirm(event.payload.name)) {
          await invoke("ai_confirm_tool", { approved: true });
          return;
        }
        setState({ pendingToolConfirm: event.payload });
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
          const remaining = (_chunkBuffer || "") + thinkFilter.flush();
          _chunkBuffer = "";
          updateAssistant((m) => ({
            ...m,
            content: remaining ? m.content + remaining : m.content,
            streaming: false,
          }));
          setState({ isStreaming: false });
          cleanup();
          onPersist();
        }
      },
    ),
    listen<{ conversation_id: string; error: string }>(
      "ai-stream-error",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          updateAssistant((m) => ({
            ...m,
            content: `❌ ${event.payload.error}`,
            streaming: false,
          }));
          setState({ isStreaming: false });
          cleanup();
        }
      },
    ),
  ]);

  const cleanup = () => {
    if (_chunkRafId !== null) {
      cancelAnimationFrame(_chunkRafId);
      _chunkRafId = null;
    }
    if (_chunkBuffer) flushChunkBuffer();
    unlisten();
    unlistenToolCalls();
    unlistenToolResult();
    unlistenToolConfirm();
    unlistenDone();
    unlistenError();
  };

  // 发起 AI 请求
  try {
    const { token } = useAuthStore.getState();
    await routeAIRequest({
      messages: apiMessages,
      config,
      conversationId,
      token,
    });
  } catch (e) {
    handleError(e, { context: "AI 对话" });
    setState({ isStreaming: false });
    cleanup();
  }

  return cleanup;
}
