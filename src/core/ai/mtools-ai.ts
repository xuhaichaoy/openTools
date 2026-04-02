/**
 * mtools.ai SDK — Core Shell 向插件暴露的 AI 能力
 *
 * 桥接 MToolsAI 接口到 Tauri 后端的 ai_chat_stream 命令。
 * 插件（内置或外部）通过该 SDK 使用用户已配置的模型，
 * 无需自行管理 API Key 或模型选择。
 */

import type {
  MToolsAI,
  AIRequestPolicy,
  AIToolCall,
} from "@/core/plugin-system/plugin-interface";
import { handleError } from "@/core/errors";
import { invoke, transformCallback } from "@tauri-apps/api/core";
import type { AICenterMode } from "@/store/app-store";
import type { AIConfig } from "@/core/ai/types";
import { AssistantReasoningStreamNormalizer } from "@/core/ai/reasoning-tag-stream";
import { resolveModelCapabilities } from "@/core/ai/model-capabilities";
import { getResolvedAIConfigForMode } from "@/core/ai/resolved-ai-config-store";
import { withRoutedAIConfig } from "@/core/ai/router";
import { mergeStreamChunk } from "@/core/ai/stream-chunk-merge";
import { createLogger } from "@/core/logger";
import {
  buildAssistantMemoryPromptForQuery,
  queueAssistantMemoryCandidates,
} from "@/core/ai/assistant-memory";

const aiLog = createLogger("MToolsAI");
const STREAM_STALL_TIMEOUT_MS = 90_000;
const STREAM_FIRST_CHUNK_TIMEOUT_MS = 90_000;
const STREAM_HARD_TIMEOUT_MS = 600_000;
const MANAGED_AUTH_STREAM_ERROR_PATTERNS = [
  /\b401\b/,
  /unauthorized/i,
  /invalid token/i,
  /http\s*401/i,
];

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

const THINKING_DEBUG_LOG_PREFIX = "[streamWithTools][thinking-window]";
const STREAM_FULL_DUMP_PREFIX = "[MToolsAI][streamWithTools][dump]";
const STREAM_STAGE_PREFIX = "[MToolsAI][streamWithTools][stage]";
const STREAM_CONTEXT_PREFIX = "[MToolsAI][streamWithTools][context]";
const AI_STREAM_EVENT_LISTENER_STORAGE_KEY = "__mtools_ai_stream_event_listeners__";
const TAURI_EVENT_LISTENERS_OBJECT_NAME = "__internal_unstable_listeners_object_id__";
const AI_STREAM_EVENT_NAMES = [
  "ai-stream-chunk",
  "ai-stream-done",
  "ai-stream-error",
  "ai-stream-raw",
  "ai-stream-thinking",
  "ai-stream-tool-args",
  "ai-agent-tool-calls",
] as const;

type TauriEventCallbackPayload<T> = {
  event: string;
  id: number;
  payload: T;
};

type PersistedAIStreamEventListener = {
  event: string;
  eventId: number;
};

type TauriInternalsLike = {
  unregisterCallback?: (id: number) => void;
};

type TauriEventPluginInternalsLike = {
  unregisterListener?: (event: string, eventId: number) => void;
};

type TauriEventListenerRecord = {
  handlerId?: number;
};

type TauriWindowLike = Window &
  Record<string, unknown> & {
  __TAURI_INTERNALS__?: TauriInternalsLike;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: TauriEventPluginInternalsLike;
};

let staleAIStreamEventListenersCleanupPromise: Promise<void> | null = null;
let staleAIStreamEventListenersCleared = false;
let aiStreamEventUnloadCleanupRegistered = false;

type StreamStageKey =
  | "start"
  | "tools_ready"
  | "rust_request_start"
  | "response_headers"
  | "first_raw"
  | "first_chunk"
  | "first_visible"
  | "first_thinking"
  | "first_tool_args"
  | "first_tool_calls"
  | "done"
  | "error"
  | "cleanup";

function dumpStreamWithToolsEvent(
  conversationId: string,
  phase: string,
  payload?: unknown,
  startedAt?: number,
): void {
  void conversationId;
  void phase;
  void payload;
  void startedAt;
  void STREAM_FULL_DUMP_PREFIX;
}

function previewStageText(value: unknown, maxLength = 160): string {
  if (typeof value !== "string") {
    try {
      const serialized = JSON.stringify(value);
      return serialized.length > maxLength
        ? `${serialized.slice(0, maxLength)}...`
        : serialized;
    } catch {
      return String(value);
    }
  }

  const normalized = value
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function detectRustRawStage(rawLine: string): {
  stage: Extract<StreamStageKey, "rust_request_start" | "response_headers">;
  reportedElapsedMs?: number;
} | null {
  if (rawLine.includes("[RUST REQUEST START]")) {
    return { stage: "rust_request_start" };
  }
  if (rawLine.includes("[RUST RESPONSE HEADERS RECEIVED]")) {
    const match = rawLine.match(/Elapsed:\s*(\d+)ms/i);
    return {
      stage: "response_headers",
      reportedElapsedMs: match?.[1] ? Number(match[1]) : undefined,
    };
  }
  return null;
}

function traceStreamEvent(
  conversationId: string,
  phase: string,
  payload?: unknown,
): void {
  if (payload === undefined) {
    // console.log(`[AI TRACE][${conversationId}][${phase}]`);
    return;
  }
  // console.log(`[AI TRACE][${conversationId}][${phase}]`, payload);
}

export function shouldDeferManagedAuthStreamError(
  config: Pick<AIConfig, "source">,
  error: string,
): boolean {
  const source = config.source ?? "own_key";
  if (source !== "team" && source !== "platform") return false;
  return MANAGED_AUTH_STREAM_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function classifyRecoverableStreamResult(params: {
  content?: string | null;
  toolCalls?: readonly AIToolCall[] | null;
}): "tool_calls" | "content" | null {
  const toolCalls = (params.toolCalls ?? []).filter(
    (toolCall) => (toolCall.function?.name ?? "").trim().length > 0,
  );
  if (toolCalls.length > 0) return "tool_calls";

  const content = String(params.content ?? "").trim();
  if (content) return "content";

  return null;
}

function getTauriWindow(): TauriWindowLike | null {
  if (typeof window === "undefined") return null;
  return window as unknown as TauriWindowLike;
}

function getTauriEventListenersObject(
  tauriWindow: TauriWindowLike,
): Record<string, Record<string, TauriEventListenerRecord>> | null {
  const listeners = tauriWindow[TAURI_EVENT_LISTENERS_OBJECT_NAME];
  if (!listeners || typeof listeners !== "object") return null;
  return listeners as Record<string, Record<string, TauriEventListenerRecord>>;
}

function removeAIStreamEventListenerFromCurrentPage(
  tauriWindow: TauriWindowLike,
  event: string,
  eventId: number,
): void {
  const listenersByEvent = getTauriEventListenersObject(tauriWindow);
  const eventListeners = listenersByEvent?.[event];
  if (!eventListeners) return;

  const listener = eventListeners[String(eventId)];
  const handlerId = Number(listener?.handlerId);
  if (Number.isFinite(handlerId)) {
    tauriWindow.__TAURI_INTERNALS__?.unregisterCallback?.(handlerId);
  }

  Reflect.deleteProperty(eventListeners, String(eventId));
}

export function clearAIStreamEventListenersFromCurrentPage(
  tauriWindow: TauriWindowLike | null = getTauriWindow(),
): void {
  if (!tauriWindow) return;

  for (const event of AI_STREAM_EVENT_NAMES) {
    const listenersByEvent = getTauriEventListenersObject(tauriWindow);
    const eventListeners = listenersByEvent?.[event];
    if (!eventListeners) continue;

    for (const eventId of Object.keys(eventListeners)) {
      removeAIStreamEventListenerFromCurrentPage(tauriWindow, event, Number(eventId));
    }
  }
}

function ensureAIStreamEventUnloadCleanupRegistered(): void {
  if (aiStreamEventUnloadCleanupRegistered) return;
  const tauriWindow = getTauriWindow();
  if (!tauriWindow) return;

  const cleanup = () => {
    clearAIStreamEventListenersFromCurrentPage(tauriWindow);
  };

  tauriWindow.addEventListener("beforeunload", cleanup);
  tauriWindow.addEventListener("pagehide", cleanup);
  aiStreamEventUnloadCleanupRegistered = true;
}

function readPersistedAIStreamEventListeners(): PersistedAIStreamEventListener[] {
  const tauriWindow = getTauriWindow();
  if (!tauriWindow) return [];
  try {
    const raw = tauriWindow.sessionStorage.getItem(AI_STREAM_EVENT_LISTENER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const event = String(record.event ?? "").trim();
        const eventId = Number(record.eventId);
        if (!event || !Number.isFinite(eventId)) return null;
        return { event, eventId };
      })
      .filter((item): item is PersistedAIStreamEventListener => item !== null);
  } catch {
    return [];
  }
}

function writePersistedAIStreamEventListeners(
  listeners: readonly PersistedAIStreamEventListener[],
): void {
  const tauriWindow = getTauriWindow();
  if (!tauriWindow) return;
  try {
    tauriWindow.sessionStorage.setItem(
      AI_STREAM_EVENT_LISTENER_STORAGE_KEY,
      JSON.stringify(listeners),
    );
  } catch {
    // noop
  }
}

function rememberAIStreamEventListener(listener: PersistedAIStreamEventListener): void {
  const current = readPersistedAIStreamEventListeners();
  current.push(listener);
  writePersistedAIStreamEventListeners(current);
}

function forgetAIStreamEventListener(listener: PersistedAIStreamEventListener): void {
  const current = readPersistedAIStreamEventListeners();
  const next = current.filter((item) =>
    !(item.event === listener.event && item.eventId === listener.eventId)
  );
  writePersistedAIStreamEventListeners(next);
}

async function ensureStaleAIStreamEventListenersCleared(): Promise<void> {
  if (staleAIStreamEventListenersCleared) return;
  if (staleAIStreamEventListenersCleanupPromise) {
    await staleAIStreamEventListenersCleanupPromise;
    return;
  }

  staleAIStreamEventListenersCleanupPromise = (async () => {
    const staleListeners = readPersistedAIStreamEventListeners();
    if (staleListeners.length === 0) {
      staleAIStreamEventListenersCleared = true;
      return;
    }
    writePersistedAIStreamEventListeners([]);
    await Promise.allSettled(
      staleListeners.map(({ event, eventId }) =>
        invoke("plugin:event|unlisten", { event, eventId }),
      ),
    );
    staleAIStreamEventListenersCleared = true;
  })().finally(() => {
    staleAIStreamEventListenersCleanupPromise = null;
  });

  await staleAIStreamEventListenersCleanupPromise;
}

async function listenAIStreamEvent<T>(
  event: string,
  handler: (event: TauriEventCallbackPayload<T>) => void,
): Promise<() => Promise<void>> {
  ensureAIStreamEventUnloadCleanupRegistered();
  await ensureStaleAIStreamEventListenersCleared();

  const callbackId = transformCallback(handler);
  const eventId = await invoke<number>("plugin:event|listen", {
    event,
    target: { kind: "Any" },
    handler: callbackId,
  });
  const persistedListener = { event, eventId };
  rememberAIStreamEventListener(persistedListener);

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    forgetAIStreamEventListener(persistedListener);
    const tauriWindow = getTauriWindow();
    if (tauriWindow) {
      removeAIStreamEventListenerFromCurrentPage(tauriWindow, event, eventId);
    }
    tauriWindow?.__TAURI_INTERNALS__?.unregisterCallback?.(callbackId);
    await invoke("plugin:event|unlisten", { event, eventId }).catch(() => undefined);
  };
}

function logStreamWithToolsContext(
  conversationId: string,
  routed: AIConfig,
  finalMessages: Array<{
    role: string;
    content: string;
    images?: string[];
    tool_calls?: AIToolCall[];
    tool_call_id?: string;
    name?: string;
  }>,
  toolCount: number,
): void {
  const totalContentChars = finalMessages.reduce(
    (sum, message) => sum + String(message.content ?? "").length,
    0,
  );
  const messageStats = finalMessages.map((message, index) => ({
    index,
    role: message.role,
    name: message.name,
    contentChars: String(message.content ?? "").length,
    imageCount: message.images?.length ?? 0,
    toolCallCount: message.tool_calls?.length ?? 0,
    toolCallId: message.tool_call_id,
    preview: String(message.content ?? "").slice(0, 160),
  }));

  console.groupCollapsed(
    `${STREAM_CONTEXT_PREFIX}[${conversationId}] model=${routed.model} messages=${finalMessages.length} totalChars=${totalContentChars}`,
  );
  console.log("summary", {
    model: routed.model,
    protocol: routed.protocol ?? "openai",
    source: routed.source ?? "own_key",
    base_url: routed.base_url,
    team_id: routed.team_id,
    team_config_id: routed.team_config_id,
    thinking_level: routed.thinking_level,
    messageCount: finalMessages.length,
    toolCount,
    totalContentChars,
  });
  console.table(messageStats);
  console.log("messages", finalMessages);
  console.log("messagesJson", JSON.stringify(finalMessages, null, 2));
  console.groupEnd();
}

function normalizeStreamChunk(params: {
  conversationId: string;
  phase: string;
  previous: string;
  incoming: string;
}): { full: string; delta: string; mode: ReturnType<typeof mergeStreamChunk>["mode"] } {
  const merged = mergeStreamChunk(params.previous, params.incoming);
  if (merged.mode === "reset") {
    aiLog.warn("[stream] detected chunk restart, reset canonical buffer", {
      conversationId: params.conversationId,
      phase: params.phase,
      previousLength: params.previous.length,
      incomingLength: params.incoming.length,
      incomingPreview: params.incoming.slice(0, 120),
    });
  }
  return {
    full: merged.full,
    delta: merged.delta,
    mode: merged.mode,
  };
}

/** 获取当前 AI 配置 */
function getConfig(mode: AICenterMode): AIConfig {
  return getResolvedAIConfigForMode(mode);
}

function applyRequestPolicy(
  config: AIConfig,
  requestPolicy?: AIRequestPolicy,
): AIConfig {
  if (!requestPolicy) return config;

  const next: AIConfig = { ...config };
  if (requestPolicy.ragMode && requestPolicy.ragMode !== "inherit") {
    next.request_rag_mode = requestPolicy.ragMode;
  } else {
    next.request_rag_mode = undefined;
  }

  if (requestPolicy.forceProductRag === "off") {
    next.disable_force_rag = true;
  } else {
    next.disable_force_rag = undefined;
  }

  return next;
}

function attachAbortBridge(signal: AbortSignal | undefined, conversationId: string) {
  let locallyAborted = false;
  const stopRemoteStream = () => {
    if (locallyAborted) return;
    locallyAborted = true;
    void invoke("ai_stop_stream", { conversationId }).catch(() => undefined);
  };

  const onAbort = () => {
    stopRemoteStream();
  };

  if (signal) {
    if (signal.aborted) {
      stopRemoteStream();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    isAborted: () => locallyAborted || !!signal?.aborted,
    detach: () => {
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

interface SimpleAIMessage {
  role: string;
  content?: string;
}

const IMAGE_FALLBACK_TEXT =
  "[用户发送了图片，但当前模型或协议不支持图片识别，请提醒用户切换到支持视觉输入的模型或接口]";

function inferImageMimeType(pathOrDataUrl: string): string {
  if (pathOrDataUrl.startsWith("data:")) {
    const match = pathOrDataUrl.match(/^data:([^;,]+)[;,]/i);
    if (match?.[1]) return match[1];
  }

  const normalized = pathOrDataUrl.toLowerCase();
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

function isRemoteImageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function appendImageFallbackText(content?: string): string {
  const prefix = content?.trim() ?? "";
  return prefix ? `${prefix}\n\n${IMAGE_FALLBACK_TEXT}` : IMAGE_FALLBACK_TEXT;
}

function parseDataUrl(value: string): { mime: string; base64: string } | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match?.[1] || !match?.[2]) return null;
  return { mime: match[1], base64: match[2] };
}

async function readImagePayload(
  imageRef: string,
): Promise<{ dataUrl: string; mime: string; base64: string } | null> {
  if (!imageRef) return null;

  const dataUrlPayload = parseDataUrl(imageRef);
  if (dataUrlPayload) {
    return {
      dataUrl: imageRef,
      mime: dataUrlPayload.mime,
      base64: dataUrlPayload.base64,
    };
  }

  if (isRemoteImageUrl(imageRef)) {
    return {
      dataUrl: imageRef,
      mime: inferImageMimeType(imageRef),
      base64: "",
    };
  }

  const base64 = await invoke<string>("read_file_base64", { filePath: imageRef });
  const mime = inferImageMimeType(imageRef);
  return {
    dataUrl: `data:${mime};base64,${base64}`,
    mime,
    base64,
  };
}

async function buildDirectOpenAIMessage(
  message: { role: string; content: string; images?: string[] },
  supportsImageInput: boolean,
): Promise<Record<string, unknown>> {
  if (message.role !== "user" || !message.images?.length) {
    return {
      role: message.role,
      content: message.content,
    };
  }

  if (!supportsImageInput) {
    return {
      role: message.role,
      content: appendImageFallbackText(message.content),
    };
  }

  const parts: Array<Record<string, unknown>> = [];
  if (message.content.trim()) {
    parts.push({ type: "text", text: message.content });
  }

  for (const imageRef of message.images) {
    const payload = await readImagePayload(imageRef).catch((error) => {
      aiLog.warn("[chatDirect] failed to read image for openai payload", {
        imageRef,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (!payload) continue;

    parts.push({
      type: "image_url",
      image_url: {
        url: payload.dataUrl,
        detail: "auto",
      },
    });
  }

  return {
    role: message.role,
    content: parts.length > 0 ? parts : appendImageFallbackText(message.content),
  };
}

async function buildDirectAnthropicMessage(
  message: { role: string; content: string; images?: string[] },
  supportsImageInput: boolean,
): Promise<Record<string, unknown>> {
  const normalizedRole = message.role === "assistant" ? "assistant" : "user";

  if (message.role !== "user" || !message.images?.length) {
    return {
      role: normalizedRole,
      content: message.content.trim()
        ? [{ type: "text", text: message.content }]
        : "",
    };
  }

  if (!supportsImageInput) {
    return {
      role: normalizedRole,
      content: [{ type: "text", text: appendImageFallbackText(message.content) }],
    };
  }

  const parts: Array<Record<string, unknown>> = [];
  if (message.content.trim()) {
    parts.push({ type: "text", text: message.content });
  }

  for (const imageRef of message.images) {
    const payload = await readImagePayload(imageRef).catch((error) => {
      aiLog.warn("[chatDirect] failed to read image for anthropic payload", {
        imageRef,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (!payload) continue;

    if (isRemoteImageUrl(payload.dataUrl) || !payload.base64) {
      aiLog.warn("[chatDirect] skip remote image for anthropic direct request", { imageRef });
      continue;
    }

    parts.push({
      type: "image",
      source: {
        type: "base64",
        media_type: payload.mime,
        data: payload.base64,
      },
    });
  }

  return {
    role: normalizedRole,
    content: parts.length > 0
      ? parts
      : [{ type: "text", text: appendImageFallbackText(message.content) }],
  };
}

const MEMORY_INJECT_TIMEOUT_MS = 500;

async function injectMemoryForMessages(
  messages: SimpleAIMessage[],
  config: AIConfig,
  conversationId?: string,
): Promise<SimpleAIMessage[]> {
  if (!config.enable_long_term_memory) return messages;

  const lastUser = [...messages]
    .reverse()
    .find((item) => item.role === "user" && item.content?.trim());
  if (!lastUser?.content) return messages;

  const userText = lastUser.content.trim();

  if (config.enable_memory_auto_save) {
    Promise.resolve().then(async () => {
      try {
        await queueAssistantMemoryCandidates(userText, { conversationId });
      } catch { /* non-critical */ }
    });
  }

  if (!config.enable_memory_auto_recall) return messages;

  try {
    const memoryPrompt = await buildAssistantMemoryPromptForQuery(userText, {
      conversationId,
      topK: 6,
      timeoutMs: MEMORY_INJECT_TIMEOUT_MS,
      preferSemantic: true,
    });
    if (memoryPrompt) {
      return [{ role: "system", content: memoryPrompt }, ...messages];
    }
  } catch { /* non-critical, proceed without memory */ }

  return messages;
}

/**
 * 创建 MToolsAI SDK 实例
 * 每个 mode 维护一个单例；配置始终从 stores 实时 resolve。
 */
export function createMToolsAI(mode: AICenterMode = "explore"): MToolsAI {
  return {
    /**
     * 单轮对话 — 发送消息并等待完整回复
     */
    async chat(options) {
      const config = getConfig(mode);
      const conversationId = `sdk-${generateId()}`;
      const baseConfig: AIConfig = {
        ...config,
        model: options.model || config.model,
        temperature: options.temperature ?? config.temperature,
      };
      const effectiveConfig = applyRequestPolicy(
        baseConfig,
        options.requestPolicy,
      );

      return new Promise((resolve, reject) => {
        let content = "";
        const abortBridge = attachAbortBridge(options.signal, conversationId);
        let cleaned = false;
        let settled = false;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let lastActivityAt = Date.now();
        const startedAt = Date.now();
        
        const unlisteners: Array<() => void> = [];
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          if (stallTimer) clearTimeout(stallTimer);
          if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
          for (const fn of unlisteners) fn();
          abortBridge.detach();
        };

        const safeResolve = (value: { content: string }) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const safeReject = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const kickWatchdog = (phase: string) => {
          lastActivityAt = Date.now();
          if (stallTimer) clearTimeout(stallTimer);
          const timeoutMs = content.length === 0 ? STREAM_FIRST_CHUNK_TIMEOUT_MS : STREAM_STALL_TIMEOUT_MS;
          stallTimer = setTimeout(() => {
            const idleMs = Date.now() - lastActivityAt;
            aiLog.error("[chat] stall timeout", { conversationId, phase, idleMs });
            void invoke("ai_stop_stream", { conversationId }).catch(() => undefined);
            safeReject(new Error(`ai_chat_stream 卡住（phase=${phase}, idle=${idleMs}ms）`));
          }, timeoutMs);
        };

        hardTimeoutTimer = setTimeout(() => {
          aiLog.error("[chat] hard timeout", { conversationId, elapsedMs: Date.now() - startedAt });
          void invoke("ai_stop_stream", { conversationId }).catch(() => undefined);
          safeReject(new Error(`ai_chat_stream 总耗时超时超时`));
        }, STREAM_HARD_TIMEOUT_MS);

        kickWatchdog("init");

        void (async () => {
          const [u1, u2, u3, u4] = await Promise.all([
            listenAIStreamEvent<{ conversation_id: string; content: string }>(
              "ai-stream-chunk",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  kickWatchdog("chunk");
                  const normalized = normalizeStreamChunk({
                    conversationId,
                    phase: "chat",
                    previous: content,
                    incoming: event.payload.content,
                  });
                  content = normalized.full;
                  traceStreamEvent(conversationId, "chunk", normalized.delta || event.payload.content);
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string }>(
              "ai-stream-done",
              (event) => {
                if (event.payload.conversation_id === conversationId && !settled) {
                  kickWatchdog("done");
                  if (abortBridge.isAborted()) {
                    safeReject(new Error("Aborted"));
                    return;
                  }
                  traceStreamEvent(conversationId, "done", content);
                  safeResolve({ content });
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; error: string }>(
              "ai-stream-error",
              (event) => {
                if (event.payload.conversation_id === conversationId && !settled) {
                  kickWatchdog("error");
                  if (abortBridge.isAborted()) {
                    safeReject(new Error("Aborted"));
                    return;
                  }
                  if (shouldDeferManagedAuthStreamError(
                    effectiveConfig,
                    event.payload.error,
                  )) {
                    aiLog.warn("[chat] defer managed-auth stream error until routed retry settles", {
                      conversationId,
                      source: effectiveConfig.source ?? "own_key",
                      error: event.payload.error,
                    });
                    return;
                  }
                  const recoveredKind = classifyRecoverableStreamResult({
                    content,
                  });
                  if (recoveredKind === "content") {
                    aiLog.warn("[chat] recover partial content after error", {
                      conversationId,
                      elapsedMs: Date.now() - startedAt,
                      contentLength: content.trim().length,
                      error: event.payload.error,
                    });
                    traceStreamEvent(conversationId, "error_recovered", {
                      error: event.payload.error,
                      content,
                    });
                    safeResolve({ content });
                    return;
                  }
                  traceStreamEvent(conversationId, "error", event.payload.error);
                  safeReject(new Error(event.payload.error));
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; raw_line: string }>(
              "ai-stream-raw",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  traceStreamEvent(conversationId, "raw", event.payload.raw_line);
                }
              },
            ),
          ]);
          unlisteners.push(u1, u2, u3, u4);

          if (abortBridge.isAborted()) {
            safeReject(new Error("Aborted"));
            return;
          }

          const baseMessages = options.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.images?.length ? { images: m.images } : {}),
          }));
          const requestMessages = options.skipMemory
            ? baseMessages
            : await injectMemoryForMessages(
                baseMessages,
                effectiveConfig,
                conversationId,
              );
          kickWatchdog("invoke_start");
          aiLog.info("[chat] invoke ai_chat_stream", { conversationId });
          await withRoutedAIConfig(effectiveConfig, (routed) =>
            invoke("ai_chat_stream", {
              messages: requestMessages,
              config: routed,
              conversationId,
              skipTools: !!options.skipTools,
            }),
          );
        })().catch((e) => {
          if (abortBridge.isAborted()) {
            safeReject(new Error("Aborted"));
            return;
          }
          safeReject(e);
        });
      });
    },

    /**
     * 流式对话 — 逐 chunk 回调
     */
    async stream(options) {
      const config = getConfig(mode);
      const conversationId = `sdk-${generateId()}`;
      const effectiveConfig = applyRequestPolicy(config, options.requestPolicy);
      let fullContent = "";
      const reasoningStream = new AssistantReasoningStreamNormalizer();

      return new Promise((resolve, reject) => {
        const abortBridge = attachAbortBridge(options.signal, conversationId);
        let cleaned = false;
        let settled = false;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let lastActivityAt = Date.now();
        const startedAt = Date.now();
        
        const unlisteners: Array<() => void> = [];
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          if (stallTimer) clearTimeout(stallTimer);
          if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
          for (const fn of unlisteners) fn();
          abortBridge.detach();
        };

        const safeResolve = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };

        const safeReject = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const kickWatchdog = (phase: string) => {
          lastActivityAt = Date.now();
          if (stallTimer) clearTimeout(stallTimer);
          const timeoutMs = fullContent.length === 0 ? STREAM_FIRST_CHUNK_TIMEOUT_MS : STREAM_STALL_TIMEOUT_MS;
          stallTimer = setTimeout(() => {
            const idleMs = Date.now() - lastActivityAt;
            aiLog.error("[stream] stall timeout", { conversationId, phase, idleMs });
            void invoke("ai_stop_stream", { conversationId }).catch(() => undefined);
            safeReject(new Error(`ai_chat_stream 卡住（phase=${phase}, idle=${idleMs}ms）`));
          }, timeoutMs);
        };

        hardTimeoutTimer = setTimeout(() => {
          aiLog.error("[stream] hard timeout", { conversationId, elapsedMs: Date.now() - startedAt });
          void invoke("ai_stop_stream", { conversationId }).catch(() => undefined);
          safeReject(new Error(`ai_chat_stream 总耗时超时`));
        }, STREAM_HARD_TIMEOUT_MS);

        kickWatchdog("init");

        void (async () => {
          const [u1, u2, u3, u4] = await Promise.all([
            listenAIStreamEvent<{ conversation_id: string; content: string }>(
              "ai-stream-chunk",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  kickWatchdog("chunk");
                  const parsed = reasoningStream.processTextChunk(
                    event.payload.content,
                  );
                  if (parsed.visible) {
                    const normalized = normalizeStreamChunk({
                      conversationId,
                      phase: "stream_visible",
                      previous: fullContent,
                      incoming: parsed.visible,
                    });
                    fullContent = normalized.full;
                    if (normalized.delta) {
                      traceStreamEvent(conversationId, "chunk", normalized.delta);
                      options.onChunk(normalized.delta);
                    }
                  }
                  if (parsed.thinking) {
                    traceStreamEvent(
                      conversationId,
                      "thinking_inline",
                      parsed.thinking,
                    );
                  }
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string }>(
              "ai-stream-done",
              (event) => {
                if (event.payload.conversation_id === conversationId && !settled) {
                  kickWatchdog("done");
                  if (abortBridge.isAborted()) {
                    safeReject(new Error("Aborted"));
                    return;
                  }
                  const remaining = reasoningStream.flush();
                  if (remaining.visible) {
                    const normalized = normalizeStreamChunk({
                      conversationId,
                      phase: "stream_flush",
                      previous: fullContent,
                      incoming: remaining.visible,
                    });
                    fullContent = normalized.full;
                    if (normalized.delta) {
                      traceStreamEvent(conversationId, "chunk", normalized.delta);
                      options.onChunk(normalized.delta);
                    }
                  }
                  if (remaining.thinking) {
                    traceStreamEvent(
                      conversationId,
                      "thinking_inline",
                      remaining.thinking,
                    );
                  }
                  traceStreamEvent(conversationId, "done", fullContent);
                  options.onDone?.(fullContent);
                  safeResolve();
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; error: string }>(
              "ai-stream-error",
              (event) => {
                if (event.payload.conversation_id === conversationId && !settled) {
                  kickWatchdog("error");
                  if (abortBridge.isAborted()) {
                    safeReject(new Error("Aborted"));
                    return;
                  }
                  if (shouldDeferManagedAuthStreamError(
                    effectiveConfig,
                    event.payload.error,
                  )) {
                    aiLog.warn("[stream] defer managed-auth stream error until routed retry settles", {
                      conversationId,
                      source: effectiveConfig.source ?? "own_key",
                      error: event.payload.error,
                    });
                    return;
                  }
                  const remaining = reasoningStream.flush();
                  if (remaining.visible) {
                    const normalized = normalizeStreamChunk({
                      conversationId,
                      phase: "stream_error_flush",
                      previous: fullContent,
                      incoming: remaining.visible,
                    });
                    fullContent = normalized.full;
                    if (normalized.delta) {
                      traceStreamEvent(conversationId, "chunk", normalized.delta);
                      options.onChunk(normalized.delta);
                    }
                  }
                  const recoveredKind = classifyRecoverableStreamResult({
                    content: fullContent,
                  });
                  if (recoveredKind === "content") {
                    aiLog.warn("[stream] recover partial content after error", {
                      conversationId,
                      elapsedMs: Date.now() - startedAt,
                      chunkCount: fullContent.length > 0 ? 1 : 0,
                      contentLength: fullContent.trim().length,
                      error: event.payload.error,
                    });
                    traceStreamEvent(conversationId, "error_recovered", {
                      error: event.payload.error,
                      content: fullContent,
                    });
                    options.onDone?.(fullContent);
                    safeResolve();
                    return;
                  }
                  traceStreamEvent(conversationId, "error", event.payload.error);
                  safeReject(new Error(event.payload.error));
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; raw_line: string }>(
              "ai-stream-raw",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  traceStreamEvent(conversationId, "raw", event.payload.raw_line);
                }
              },
            ),
          ]);
          unlisteners.push(u1, u2, u3, u4);

          if (abortBridge.isAborted()) {
            safeReject(new Error("Aborted"));
            return;
          }

          const enrichedMessages = await injectMemoryForMessages(
            options.messages.map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.images?.length ? { images: m.images } : {}),
            })),
            effectiveConfig,
            conversationId,
          );
          kickWatchdog("invoke_start");
          aiLog.info("[stream] invoke ai_chat_stream", { conversationId });
          await withRoutedAIConfig(effectiveConfig, (routed) =>
            invoke("ai_chat_stream", {
              messages: enrichedMessages,
              config: routed,
              conversationId,
            }),
          );
        })().catch((e) => {
          if (abortBridge.isAborted()) {
            safeReject(new Error("Aborted"));
            return;
          }
          safeReject(e);
        });
      });
    },

    /**
     * 文本向量化 — 通过后端 embedding API
     */
    async embedding(text: string) {
      const config = getConfig(mode);
      try {
        const result = await withRoutedAIConfig(
          config,
          (routed) =>
            invoke<number[]>("ai_embedding", {
              text,
              config: routed,
            }),
        );
        return result;
      } catch (e) {
        handleError(e, { context: "mtools.ai embedding", silent: true });
        return [];
      }
    },

    /**
     * 获取当前可用模型列表
     */
    async getModels() {
      const config = getConfig(mode);
      try {
        const models = await withRoutedAIConfig(
          config,
          (routed) =>
            invoke<{ id: string; name: string }[]>(
              "ai_list_models",
              {
                config: routed,
              },
            ),
        );
        return models;
      } catch {
        // fallback: 返回当前配置的模型
        return [{ id: config.model, name: config.model }];
      }
    },

    /**
     * 带工具定义的流式对话 — Agent 专用
     * 后端传递 tools 给 API，收到 tool_calls 时通知前端，不自动执行。
     */
    async streamWithTools(options) {
      const config: AIConfig = {
        ...getConfig(mode),
        ...(options.modelOverride ? { model: options.modelOverride } : {}),
        ...(options.thinkingLevel && options.thinkingLevel !== "adaptive"
          ? { thinking_level: options.thinkingLevel }
          : {}),
      };
      const conversationId = `agent-${generateId()}`;
      let fullContent = "";
      const reasoningStream = new AssistantReasoningStreamNormalizer();
      let resolvedToolCalls: AIToolCall[] | null = null;
      let hadModelResponse = false;
      let fullThinking = "";
      let fullToolArgs = "";
      const emitTrace = (event: string, detail?: Record<string, unknown>) => {
        options.onTraceEvent?.(event, detail);
      };

      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const abortBridge = attachAbortBridge(options.signal, conversationId);
        const stageMarks: Partial<Record<StreamStageKey, number>> = { start: startedAt };
        let rustReportedHeaderElapsedMs: number | undefined;
        const dump = (phase: string, payload?: unknown) => {
          dumpStreamWithToolsEvent(conversationId, phase, payload, startedAt);
        };
        const deltaBetween = (from: StreamStageKey, to: StreamStageKey): number | undefined => {
          const fromAt = stageMarks[from];
          const toAt = stageMarks[to];
          return typeof fromAt === "number" && typeof toAt === "number"
            ? toAt - fromAt
            : undefined;
        };
        const summarizeStages = () => ({
          startedAt: new Date(startedAt).toISOString(),
          toolsReadyMs: deltaBetween("start", "tools_ready"),
          rustRequestStartMs: deltaBetween("start", "rust_request_start"),
          requestBuildGapMs: deltaBetween("tools_ready", "rust_request_start"),
          waitHeadersMs: deltaBetween("rust_request_start", "response_headers"),
          rustReportedHeaderElapsedMs,
          headersToFirstChunkMs: deltaBetween("response_headers", "first_chunk"),
          headersToFirstVisibleMs: deltaBetween("response_headers", "first_visible"),
          headersToFirstThinkingMs: deltaBetween("response_headers", "first_thinking"),
          headersToFirstToolArgsMs: deltaBetween("response_headers", "first_tool_args"),
          headersToFirstToolCallsMs: deltaBetween("response_headers", "first_tool_calls"),
          requestToFirstVisibleMs: deltaBetween("rust_request_start", "first_visible"),
          requestToFirstThinkingMs: deltaBetween("rust_request_start", "first_thinking"),
          totalToDoneMs: deltaBetween("start", "done"),
          totalToErrorMs: deltaBetween("start", "error"),
          totalToCleanupMs: deltaBetween("start", "cleanup"),
          marks: Object.fromEntries(
            Object.entries(stageMarks).map(([stage, at]) => [
              stage,
              typeof at === "number" ? new Date(at).toISOString() : at,
            ]),
          ),
        });
        const markStage = (stage: StreamStageKey, detail?: Record<string, unknown>) => {
          if (typeof stageMarks[stage] === "number") return;
          stageMarks[stage] = Date.now();
          void detail;
          void STREAM_STAGE_PREFIX;
          void conversationId;
          void startedAt;
        };
        const dumpStageSummary = (reason: string) => {
          void reason;
          void STREAM_STAGE_PREFIX;
          void conversationId;
          void summarizeStages;
        };
        dump("start", {
          modelOverride: options.modelOverride ?? null,
          thinkingLevel: options.thinkingLevel ?? "adaptive",
          messageCount: options.messages.length,
          toolCount: options.tools?.length ?? 0,
        });
        emitTrace("llm_invoke_started", {
          phase: "mtools_stream_start",
          model: config.model,
          count: options.messages.length,
          tool_count: options.tools?.length ?? 0,
        });
        let cleaned = false;
        let settled = false;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let lastActivityAt = startedAt;
        let chunkCount = 0;
        let chunkChars = 0;
        let thinkingDebugActive = false;
        let thinkingDebugStartedAt = 0;
        const unlisteners: Array<() => void> = [];
        const logThinkingWindow = (phase: string, context?: Record<string, unknown>) => {
          void phase;
          void context;
          void thinkingDebugActive;
          void THINKING_DEBUG_LOG_PREFIX;
        };
        const beginThinkingWindow = (trigger: string, context?: Record<string, unknown>) => {
          if (thinkingDebugActive || fullContent.trim() || (resolvedToolCalls?.length ?? 0) > 0) return;
          thinkingDebugActive = true;
          thinkingDebugStartedAt = Date.now();
          void trigger;
          void context;
          void THINKING_DEBUG_LOG_PREFIX;
        };
        const endThinkingWindow = (reason: string, context?: Record<string, unknown>) => {
          if (!thinkingDebugActive) return;
          void reason;
          void context;
          void thinkingDebugStartedAt;
          void fullThinking;
          void fullContent;
          void resolvedToolCalls;
          void THINKING_DEBUG_LOG_PREFIX;
          thinkingDebugActive = false;
          thinkingDebugStartedAt = 0;
        };
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          if (stallTimer) clearTimeout(stallTimer);
          if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
          markStage("cleanup", {
            chunkCount,
            chunkChars,
            hasToolCalls: !!resolvedToolCalls?.length,
          });
          dump("cleanup", {
            elapsedMs: Date.now() - startedAt,
            chunkCount,
            chunkChars,
            fullThinking,
            fullContent,
            fullToolArgs,
            hasToolCalls: !!resolvedToolCalls?.length,
          });
          dumpStageSummary("cleanup");
          endThinkingWindow("cleanup");
          for (const fn of unlisteners) fn();
          abortBridge.detach();
        };

        const safeResolve = (value: { type: "tool_calls"; toolCalls: AIToolCall[] } | { type: "content"; content: string }) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const safeReject = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const kickWatchdog = (phase: string) => {
          lastActivityAt = Date.now();
          if (stallTimer) clearTimeout(stallTimer);
          const timeoutMs = chunkCount === 0
            ? STREAM_FIRST_CHUNK_TIMEOUT_MS
            : STREAM_STALL_TIMEOUT_MS;
          stallTimer = setTimeout(() => {
            const idleMs = Date.now() - lastActivityAt;
            const timeoutSec = Math.floor(timeoutMs / 1000);
            const message = `ai_agent_stream 卡住超过 ${timeoutSec} 秒（phase=${phase}, idle=${idleMs}ms）`;
            emitTrace("llm_stream_stall", {
              phase,
              elapsed_ms: Date.now() - startedAt,
              idle_ms: idleMs,
              count: chunkCount,
            });
            aiLog.error("[streamWithTools] stall timeout", {
              conversationId,
              phase,
              idleMs,
              chunkCount,
              chunkChars,
            });
            void invoke("ai_stop_stream", { conversationId }).catch(() => undefined);
            safeReject(new Error(message));
          }, timeoutMs);
        };

        hardTimeoutTimer = setTimeout(() => {
          const elapsedMs = Date.now() - startedAt;
          const message = `ai_agent_stream 总耗时超过 ${Math.floor(STREAM_HARD_TIMEOUT_MS / 1000)} 秒，已自动终止`;
          aiLog.error("[streamWithTools] hard timeout", {
            conversationId,
            elapsedMs,
            chunkCount,
            chunkChars,
          });
          void invoke("ai_stop_stream", { conversationId }).catch(() => undefined);
          safeReject(new Error(message));
        }, STREAM_HARD_TIMEOUT_MS);

        kickWatchdog("init");

        void (async () => {
          const listeners = await Promise.all([
            listenAIStreamEvent<{ conversation_id: string; raw_line: string }>(
              "ai-stream-raw",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  markStage("first_raw", {
                    rawPreview: previewStageText(event.payload.raw_line),
                  });
                  const rawStage = detectRustRawStage(event.payload.raw_line);
                  if (rawStage) {
                    if (rawStage.stage === "response_headers") {
                      rustReportedHeaderElapsedMs = rawStage.reportedElapsedMs;
                    }
                    markStage(rawStage.stage, {
                      rawPreview: previewStageText(event.payload.raw_line),
                      ...(typeof rawStage.reportedElapsedMs === "number"
                        ? { rustReportedElapsedMs: rawStage.reportedElapsedMs }
                        : {}),
                    });
                  }
                  dump("ai-stream-raw", event.payload);
                  traceStreamEvent(conversationId, "raw", event.payload.raw_line);
                  logThinkingWindow("raw", {
                    rawLine: event.payload.raw_line,
                  });
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; content: string }>(
              "ai-stream-chunk",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  const isFirstChunk = typeof stageMarks.first_chunk !== "number";
                  markStage("first_chunk", {
                    chunkLength: event.payload.content.length,
                    chunkPreview: previewStageText(event.payload.content),
                  });
                  if (isFirstChunk && event.payload.content.trim()) {
                    emitTrace("llm_first_chunk", {
                      elapsed_ms: Date.now() - startedAt,
                      phase: "mtools_stream_chunk",
                      preview: previewStageText(event.payload.content, 80),
                    });
                  }
                  dump("ai-stream-chunk:raw", event.payload);
                  kickWatchdog("chunk");
                  chunkCount += 1;
                  chunkChars += event.payload.content.length;
                  const parsed = reasoningStream.processTextChunk(
                    event.payload.content,
                  );
                  dump("ai-stream-chunk:parsed", parsed);
                  if (parsed.thinking && !thinkingDebugActive) {
                    beginThinkingWindow("chunk.thinking", {
                      rawChunk: event.payload.content,
                      parsedThinking: parsed.thinking,
                      parsedVisible: parsed.visible,
                    });
                  }
                  logThinkingWindow("chunk", {
                    rawChunk: event.payload.content,
                    parsedThinking: parsed.thinking,
                    parsedVisible: parsed.visible,
                  });
                  if (parsed.visible) {
                    markStage("first_visible", {
                      visiblePreview: previewStageText(parsed.visible),
                      visibleLength: parsed.visible.length,
                    });
                    hadModelResponse = true;
                    const normalized = normalizeStreamChunk({
                      conversationId,
                      phase: "stream_with_tools_visible",
                      previous: fullContent,
                      incoming: parsed.visible,
                    });
                    fullContent = normalized.full;
                    const emittedChunk = normalized.mode === "reset" ? normalized.full : normalized.delta;
                    if (emittedChunk) {
                      traceStreamEvent(conversationId, "chunk", emittedChunk);
                      options.onChunk(emittedChunk);
                    }
                    endThinkingWindow("visible_chunk", {
                      visibleChunk: emittedChunk || parsed.visible,
                    });
                  }
                  if (parsed.thinking) {
                    markStage("first_thinking", {
                      thinkingPreview: previewStageText(parsed.thinking),
                      thinkingLength: parsed.thinking.length,
                    });
                    hadModelResponse = true;
                    const normalizedThinking = normalizeStreamChunk({
                      conversationId,
                      phase: "stream_with_tools_inline_thinking",
                      previous: fullThinking,
                      incoming: parsed.thinking,
                    });
                    fullThinking = normalizedThinking.full;
                    const emittedThinking =
                      normalizedThinking.mode === "reset"
                        ? normalizedThinking.full
                        : normalizedThinking.delta;
                    traceStreamEvent(
                      conversationId,
                      "thinking_inline",
                      emittedThinking || parsed.thinking,
                    );
                    if (emittedThinking) {
                      options.onThinking?.(emittedThinking);
                    }
                    logThinkingWindow("thinking_from_chunk", {
                      thinkingChunk: emittedThinking || parsed.thinking,
                      fullThinking,
                    });
                  }
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; tool_calls: AIToolCall[] }>(
              "ai-agent-tool-calls",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  const normalizedToolCalls = (event.payload.tool_calls ?? []).filter(
                    (toolCall) => (toolCall.function?.name ?? "").trim().length > 0,
                  );
                  if (normalizedToolCalls.length === 0) {
                    dump("ai-agent-tool-calls:ignored-empty", event.payload);
                    return;
                  }
                  markStage("first_tool_calls", {
                    toolCallCount: normalizedToolCalls.length,
                    tools: normalizedToolCalls.map((toolCall) => toolCall.function?.name ?? "unknown"),
                  });
                  emitTrace("llm_tool_calls_received", {
                    elapsed_ms: Date.now() - startedAt,
                    count: normalizedToolCalls.length,
                    preview: previewStageText(
                      normalizedToolCalls.map((toolCall) => toolCall.function?.name ?? "unknown").join(", "),
                      80,
                    ),
                  });
                  dump("ai-agent-tool-calls", {
                    ...event.payload,
                    tool_calls: normalizedToolCalls,
                  });
                  resolvedToolCalls = normalizedToolCalls;
                  kickWatchdog("tool_calls");
                  traceStreamEvent(conversationId, "tool_calls", normalizedToolCalls);
                  logThinkingWindow("tool_calls", {
                    toolCalls: normalizedToolCalls,
                  });
                  endThinkingWindow("tool_calls", {
                    toolCalls: normalizedToolCalls,
                  });
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string }>(
              "ai-stream-done",
              (event) => {
                if (event.payload.conversation_id !== conversationId || settled) {
                  return;
                }
                markStage("done", {
                  chunkCount,
                  chunkChars,
                  hasToolCalls: !!resolvedToolCalls?.length,
                });
                dump("ai-stream-done", event.payload);
                dumpStageSummary("done");
                kickWatchdog("done");
                traceStreamEvent(
                  conversationId,
                  "done",
                  resolvedToolCalls && resolvedToolCalls.length > 0
                    ? { toolCalls: resolvedToolCalls }
                    : fullContent,
                );
                logThinkingWindow("done_event", {
                  chunkCount,
                  chunkChars,
                });
                if (abortBridge.isAborted()) {
                  safeReject(new Error("Aborted"));
                  return;
                }
                const remaining = reasoningStream.flush();
                if (remaining.visible) {
                  hadModelResponse = true;
                  const normalized = normalizeStreamChunk({
                    conversationId,
                    phase: "stream_with_tools_flush",
                    previous: fullContent,
                    incoming: remaining.visible,
                  });
                  fullContent = normalized.full;
                  const emittedChunk = normalized.mode === "reset" ? normalized.full : normalized.delta;
                  if (emittedChunk) {
                    traceStreamEvent(conversationId, "chunk", emittedChunk);
                    options.onChunk(emittedChunk);
                  }
                  endThinkingWindow("flush_visible_chunk", {
                    visibleChunk: emittedChunk || remaining.visible,
                  });
                }
                if (remaining.thinking) {
                  hadModelResponse = true;
                  const normalizedThinking = normalizeStreamChunk({
                    conversationId,
                    phase: "stream_with_tools_thinking_flush",
                    previous: fullThinking,
                    incoming: remaining.thinking,
                  });
                  fullThinking = normalizedThinking.full;
                  const emittedThinking =
                    normalizedThinking.mode === "reset"
                      ? normalizedThinking.full
                      : normalizedThinking.delta;
                  traceStreamEvent(
                    conversationId,
                    "thinking_inline",
                    emittedThinking || remaining.thinking,
                  );
                  if (emittedThinking) {
                    options.onThinking?.(emittedThinking);
                  }
                  logThinkingWindow("thinking_flush", {
                    thinkingChunk: emittedThinking || remaining.thinking,
                    fullThinking,
                  });
                }
                endThinkingWindow("done", {
                  chunkCount,
                  chunkChars,
                });
                if (resolvedToolCalls && resolvedToolCalls.length > 0) {
                  safeResolve({ type: "tool_calls", toolCalls: resolvedToolCalls });
                } else {
                  if (!fullContent.trim()) {
                    if (hadModelResponse) {
                      aiLog.warn(
                        "[streamWithTools] model responded without visible content/tool calls",
                        {
                          conversationId,
                          elapsedMs: Date.now() - startedAt,
                          chunkCount,
                          chunkChars,
                        },
                      );
                      options.onDone?.("");
                      safeResolve({ type: "content", content: "" });
                      return;
                    }
                    const emptyErr = new Error("FC_INCOMPATIBLE: ai_agent_stream 返回空响应（无 chunk 且无 tool_calls）");
                    aiLog.error("[streamWithTools] empty stream result", {
                      conversationId,
                      elapsedMs: Date.now() - startedAt,
                      chunkCount,
                      chunkChars,
                    });
                    safeReject(emptyErr);
                    return;
                  }
                  emitTrace("llm_content_completed", {
                    elapsed_ms: Date.now() - startedAt,
                    count: fullContent.trim().length,
                    preview: previewStageText(fullContent, 80),
                  });
                  options.onDone?.(fullContent);
                  safeResolve({ type: "content", content: fullContent });
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; error: string }>(
              "ai-stream-error",
              (event) => {
                if (event.payload.conversation_id !== conversationId || settled) {
                  return;
                }
                markStage("error", {
                  error: event.payload.error,
                  chunkCount,
                  chunkChars,
                });
                dump("ai-stream-error", event.payload);
                dumpStageSummary("error");
                kickWatchdog("error");
                traceStreamEvent(conversationId, "error", event.payload.error);
                logThinkingWindow("error_event", {
                  error: event.payload.error,
                });
                if (abortBridge.isAborted()) {
                  safeReject(new Error("Aborted"));
                  return;
                }
                if (shouldDeferManagedAuthStreamError(
                  config,
                  event.payload.error,
                )) {
                  aiLog.warn("[streamWithTools] defer managed-auth stream error until routed retry settles", {
                    conversationId,
                    source: config.source ?? "own_key",
                    error: event.payload.error,
                  });
                  return;
                }
                const remaining = reasoningStream.flush();
                if (remaining.visible) {
                  hadModelResponse = true;
                  const normalized = normalizeStreamChunk({
                    conversationId,
                    phase: "stream_with_tools_error_visible_flush",
                    previous: fullContent,
                    incoming: remaining.visible,
                  });
                  fullContent = normalized.full;
                  const emittedChunk =
                    normalized.mode === "reset"
                      ? normalized.full
                      : normalized.delta;
                  if (emittedChunk) {
                    traceStreamEvent(conversationId, "chunk", emittedChunk);
                    options.onChunk(emittedChunk);
                  }
                }
                if (remaining.thinking) {
                  hadModelResponse = true;
                  const normalizedThinking = normalizeStreamChunk({
                    conversationId,
                    phase: "stream_with_tools_error_flush",
                    previous: fullThinking,
                    incoming: remaining.thinking,
                  });
                  fullThinking = normalizedThinking.full;
                  const emittedThinking =
                    normalizedThinking.mode === "reset"
                      ? normalizedThinking.full
                      : normalizedThinking.delta;
                  traceStreamEvent(
                    conversationId,
                    "thinking_inline",
                    emittedThinking || remaining.thinking,
                  );
                  if (emittedThinking) {
                    options.onThinking?.(emittedThinking);
                  }
                  logThinkingWindow("thinking_error_flush", {
                    thinkingChunk: emittedThinking || remaining.thinking,
                    fullThinking,
                  });
                }
                endThinkingWindow("error", {
                  error: event.payload.error,
                });
                const recoveredKind = classifyRecoverableStreamResult({
                  content: fullContent,
                  toolCalls: resolvedToolCalls,
                });
                if (recoveredKind === "tool_calls" && resolvedToolCalls) {
                  aiLog.warn("[streamWithTools] recover tool calls after error", {
                    conversationId,
                    elapsedMs: Date.now() - startedAt,
                    chunkCount,
                    chunkChars,
                    toolCallCount: resolvedToolCalls.length,
                    error: event.payload.error,
                  });
                  traceStreamEvent(conversationId, "error_recovered", {
                    error: event.payload.error,
                    toolCalls: resolvedToolCalls,
                  });
                  safeResolve({ type: "tool_calls", toolCalls: resolvedToolCalls });
                  return;
                }
                if (recoveredKind === "content") {
                  aiLog.warn("[streamWithTools] recover partial content after error", {
                    conversationId,
                    elapsedMs: Date.now() - startedAt,
                    chunkCount,
                    chunkChars,
                    contentLength: fullContent.trim().length,
                    error: event.payload.error,
                  });
                  traceStreamEvent(conversationId, "error_recovered", {
                    error: event.payload.error,
                    content: fullContent,
                  });
                  options.onDone?.(fullContent);
                  safeResolve({ type: "content", content: fullContent });
                  return;
                }
                aiLog.error("[streamWithTools] error event", {
                  conversationId,
                  elapsedMs: Date.now() - startedAt,
                  chunkCount,
                  chunkChars,
                  error: event.payload.error,
                });
                emitTrace("llm_failed", {
                  elapsed_ms: Date.now() - startedAt,
                  phase: "mtools_stream_error",
                  preview: previewStageText(event.payload.error, 80),
                });
                safeReject(new Error(event.payload.error));
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; content: string }>(
              "ai-stream-thinking",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  if ((event.payload.content ?? "").length > 0) {
                    markStage("first_thinking", {
                      thinkingPreview: previewStageText(event.payload.content ?? ""),
                      thinkingLength: (event.payload.content ?? "").length,
                      source: "ai-stream-thinking.raw",
                    });
                  }
                  dump("ai-stream-thinking:raw", event.payload);
                  kickWatchdog("thinking");
                  if ((event.payload.content ?? "").trim()) {
                    beginThinkingWindow("thinking_event.raw", {
                      rawThinking: event.payload.content ?? "",
                    });
                  }
                  const parsed = reasoningStream.processThinkingChunk(
                    event.payload.content ?? "",
                  );
                  dump("ai-stream-thinking:parsed", parsed);
                  logThinkingWindow("thinking_event", {
                    rawThinking: event.payload.content ?? "",
                    parsedThinking: parsed.thinking,
                  });
                  if (parsed.thinking) {
                    hadModelResponse = true;
                    const normalizedThinking = normalizeStreamChunk({
                      conversationId,
                      phase: "stream_with_tools_reasoning_event",
                      previous: fullThinking,
                      incoming: parsed.thinking,
                    });
                    fullThinking = normalizedThinking.full;
                    const emittedThinking =
                      normalizedThinking.mode === "reset"
                        ? normalizedThinking.full
                        : normalizedThinking.delta;
                    traceStreamEvent(conversationId, "thinking", emittedThinking || parsed.thinking);
                    if (emittedThinking) {
                      options.onThinking?.(emittedThinking);
                    }
                    logThinkingWindow("thinking_event_parsed", {
                      thinkingChunk: emittedThinking || parsed.thinking,
                      fullThinking,
                    });
                  }
                }
              },
            ),
            listenAIStreamEvent<{ conversation_id: string; content: string }>(
              "ai-stream-tool-args",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  if ((event.payload.content ?? "").length > 0) {
                    markStage("first_tool_args", {
                      toolArgsPreview: previewStageText(event.payload.content ?? ""),
                      toolArgsLength: (event.payload.content ?? "").length,
                    });
                  }
                  dump("ai-stream-tool-args:raw", event.payload);
                  kickWatchdog("tool-args");
                  const normalizedToolArgs = normalizeStreamChunk({
                    conversationId,
                    phase: "stream_with_tools_tool_args",
                    previous: fullToolArgs,
                    incoming: event.payload.content ?? "",
                  });
                  fullToolArgs = normalizedToolArgs.full;
                  const emittedToolArgs =
                    normalizedToolArgs.mode === "reset"
                      ? normalizedToolArgs.full
                      : normalizedToolArgs.delta;
                  dump("ai-stream-tool-args:normalized", {
                    normalizedToolArgs,
                    fullToolArgs,
                    emittedToolArgs,
                  });
                  traceStreamEvent(
                    conversationId,
                    "tool_args",
                    emittedToolArgs || event.payload.content || "",
                  );
                  logThinkingWindow("tool_args", {
                    toolArgsChunk: emittedToolArgs || event.payload.content || "",
                    fullToolArgs,
                  });
                  if (emittedToolArgs) {
                    options.onToolArgs?.(emittedToolArgs);
                  }
                }
              },
            ),
          ]);
          unlisteners.push(...listeners);

          if (abortBridge.isAborted()) {
            safeReject(new Error("Aborted"));
            return;
          }

          const finalMessages = options.messages.map((m) => ({
            role: m.role,
            content: m.content ?? "",
            ...(m.images?.length ? { images: m.images } : {}),
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            ...(m.name ? { name: m.name } : {}),
          }));

          kickWatchdog("invoke_start");
          await withRoutedAIConfig(config, async (routed) => {
            dump("invoke:resolved-config", {
              model: routed.model,
              protocol: routed.protocol ?? "openai",
              source: routed.source ?? "own_key",
              base_url: routed.base_url,
              team_id: routed.team_id,
              team_config_id: routed.team_config_id,
              thinking_level: routed.thinking_level,
              messageCount: finalMessages.length,
              toolCount: options.tools?.length ?? 0,
            });
            logStreamWithToolsContext(
              conversationId,
              routed,
              finalMessages,
              options.tools?.length ?? 0,
            );
            dump("invoke:messages", finalMessages);
            markStage("tools_ready", {
              toolCount: options.tools?.length ?? 0,
              messageCount: finalMessages.length,
              model: routed.model,
              source: routed.source ?? "own_key",
            });
            dump("invoke:tools", options.tools ?? []);
            return invoke("ai_agent_stream", {
              messages: finalMessages,
              config: routed,
              tools: options.tools,
              conversationId,
            });
          });
          dump("invoke:dispatched");
        })().catch((e) => {
          const errMsg = e instanceof Error ? e.message : String(e);
          dump("invoke:failed", {
            error: errMsg,
          });
          aiLog.error("[streamWithTools] invoke failed", {
            conversationId,
            elapsedMs: Date.now() - startedAt,
            error: errMsg,
          });
          emitTrace("llm_failed", {
            elapsed_ms: Date.now() - startedAt,
            phase: "mtools_invoke_failed",
            preview: previewStageText(errMsg, 80),
          });
          if (abortBridge.isAborted()) {
            safeReject(new Error("Aborted"));
            return;
          }
          safeReject(e instanceof Error ? e : new Error(errMsg));
        });
      });
    },
  };
}

/** 按 mode 缓存的单例 */
const _instances = new Map<AICenterMode, MToolsAI>();
export function getMToolsAI(mode: AICenterMode = "explore"): MToolsAI {
  const existing = _instances.get(mode);
  if (existing) {
    return existing;
  }
  const next = createMToolsAI(mode);
  _instances.set(mode, next);
  return next;
}

/**
 * 直接通过 fetch 调用 LLM API，绕过 Rust 后端（不注入系统工具和默认提示词）。
 * 用于 Cluster Planner/Aggregator 等纯文本对话场景，避免服务端 API 网关
 * 因 tools 字段触发功能限制。
 */
export async function chatDirect(options: {
  messages: { role: string; content: string; images?: string[] }[];
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
  mode?: AICenterMode;
}): Promise<{ content: string }> {
  const config = getConfig(options.mode ?? "explore");
  return withRoutedAIConfig(
    {
      ...config,
      ...(options.model ? { model: options.model } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
    },
    async (routed) => {
      const isAnthropic = routed.protocol === "anthropic";
      const url = isAnthropic
        ? `${routed.base_url}/v1/messages`
        : `${routed.base_url}/chat/completions`;
      const supportsImageInput = resolveModelCapabilities(
        routed.model,
        routed.protocol,
      ).supportsImageInput;

      const systemMessages = options.messages
        .filter((message) => message.role === "system" && message.content.trim())
        .map((message) => message.content.trim());
      const directMessages = await Promise.all(
        options.messages
          .filter((message) => !isAnthropic || message.role !== "system")
          .map((message) => isAnthropic
            ? buildDirectAnthropicMessage(message, supportsImageInput)
            : buildDirectOpenAIMessage(message, supportsImageInput)),
      );
      const body: Record<string, unknown> = isAnthropic
        ? {
            model: routed.model,
            messages: directMessages,
            temperature: routed.temperature ?? 0.7,
            max_tokens: routed.max_tokens ?? 2048,
            ...(systemMessages.length > 0
              ? { system: systemMessages.join("\n\n") }
              : {}),
          }
        : {
            model: routed.model,
            messages: directMessages,
            temperature: routed.temperature ?? 0.7,
          };
      if (!isAnthropic && routed.max_tokens) body.max_tokens = routed.max_tokens;
      if (routed.team_id) {
        body.team_id = routed.team_id;
        if (routed.team_config_id) body.team_config_id = routed.team_config_id;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (isAnthropic && routed.source === "own_key") {
        headers["x-api-key"] = routed.api_key;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.Authorization = `Bearer ${routed.api_key}`;
      }
      if (url.includes("coding.dashscope") || url.includes("coding-intl.dashscope")) {
        headers["User-Agent"] = "openclaw/1.0.0";
      }

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`API 错误 (HTTP ${resp.status}): ${text}`);
      }

      const data = await resp.json();
      const content = isAnthropic
        ? Array.isArray(data?.content)
          ? data.content
              .filter((part: { type?: string }) => part?.type === "text")
              .map((part: { text?: string }) => part?.text ?? "")
              .join("")
          : ""
        : data?.choices?.[0]?.message?.content ?? "";
      return { content };
    },
  );
}
