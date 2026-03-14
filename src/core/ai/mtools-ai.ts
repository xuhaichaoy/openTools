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
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAIStore } from "@/store/ai-store";
import type { AIConfig } from "@/core/ai/types";
import { AssistantReasoningStreamNormalizer } from "@/core/ai/reasoning-tag-stream";
import { resolveModelCapabilities } from "@/core/ai/model-capabilities";
import { resolveRoutedConfig } from "@/core/ai/router";
import { createLogger } from "@/core/logger";
import {
  buildAssistantMemoryPromptForQuery,
  queueAssistantMemoryCandidates,
} from "@/core/ai/assistant-memory";

const aiLog = createLogger("MToolsAI");
const STREAM_STALL_TIMEOUT_MS = 120_000;
const STREAM_FIRST_CHUNK_TIMEOUT_MS = 300_000; // Increased for image models
const STREAM_HARD_TIMEOUT_MS = 600_000;

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

function traceStreamEvent(
  conversationId: string,
  phase: string,
  payload?: unknown,
): void {
  if (payload === undefined) {
    console.log(`[AI TRACE][${conversationId}][${phase}]`);
    return;
  }
  console.log(`[AI TRACE][${conversationId}][${phase}]`, payload);
}

/** 获取当前 AI 配置 */
function getConfig(): AIConfig {
  return useAIStore.getState().config;
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
 * 每次调用返回同一个单例；配置始终从 useAIStore 实时读取。
 */
export function createMToolsAI(): MToolsAI {
  return {
    /**
     * 单轮对话 — 发送消息并等待完整回复
     */
    async chat(options) {
      const config = getConfig();
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
            listen<{ conversation_id: string; content: string }>(
              "ai-stream-chunk",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  kickWatchdog("chunk");
                  content += event.payload.content;
                  traceStreamEvent(conversationId, "chunk", event.payload.content);
                }
              },
            ),
            listen<{ conversation_id: string }>(
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
            listen<{ conversation_id: string; error: string }>(
              "ai-stream-error",
              (event) => {
                if (event.payload.conversation_id === conversationId && !settled) {
                  kickWatchdog("error");
                  if (abortBridge.isAborted()) {
                    safeReject(new Error("Aborted"));
                    return;
                  }
                  traceStreamEvent(conversationId, "error", event.payload.error);
                  safeReject(new Error(event.payload.error));
                }
              },
            ),
            listen<{ conversation_id: string; raw_line: string }>(
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
          const routed = await resolveRoutedConfig(effectiveConfig);

          kickWatchdog("invoke_start");
          aiLog.info("[chat] invoke ai_chat_stream", { conversationId });
          await invoke("ai_chat_stream", {
            messages: requestMessages,
            config: routed,
            conversationId,
            skipTools: !!options.skipTools,
          });
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
      const config = getConfig();
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
            listen<{ conversation_id: string; content: string }>(
              "ai-stream-chunk",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  kickWatchdog("chunk");
                  const parsed = reasoningStream.processTextChunk(
                    event.payload.content,
                  );
                  if (parsed.visible) {
                    fullContent += parsed.visible;
                    traceStreamEvent(conversationId, "chunk", parsed.visible);
                    options.onChunk(parsed.visible);
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
            listen<{ conversation_id: string }>(
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
                    fullContent += remaining.visible;
                    traceStreamEvent(conversationId, "chunk", remaining.visible);
                    options.onChunk(remaining.visible);
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
            listen<{ conversation_id: string; error: string }>(
              "ai-stream-error",
              (event) => {
                if (event.payload.conversation_id === conversationId && !settled) {
                  kickWatchdog("error");
                  if (abortBridge.isAborted()) {
                    safeReject(new Error("Aborted"));
                    return;
                  }
                  traceStreamEvent(conversationId, "error", event.payload.error);
                  safeReject(new Error(event.payload.error));
                }
              },
            ),
            listen<{ conversation_id: string; raw_line: string }>(
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
          const routed = await resolveRoutedConfig(effectiveConfig);

          kickWatchdog("invoke_start");
          aiLog.info("[stream] invoke ai_chat_stream", { conversationId });
          await invoke("ai_chat_stream", {
            messages: enrichedMessages,
            config: routed,
            conversationId,
          });
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
      const config = getConfig();
      try {
        const result = await invoke<number[]>("ai_embedding", {
          text,
          config,
        });
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
      const config = getConfig();
      try {
        const models = await invoke<{ id: string; name: string }[]>(
          "ai_list_models",
          {
            config,
          },
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
        ...getConfig(),
        ...(options.modelOverride ? { model: options.modelOverride } : {}),
      };
      const conversationId = `agent-${generateId()}`;
      let fullContent = "";
      const reasoningStream = new AssistantReasoningStreamNormalizer();
      let resolvedToolCalls: AIToolCall[] | null = null;
      let hadModelResponse = false;

      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const abortBridge = attachAbortBridge(options.signal, conversationId);
        let cleaned = false;
        let settled = false;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let lastActivityAt = startedAt;
        let firstChunkAt: number | null = null;
        let chunkCount = 0;
        let chunkChars = 0;
        const unlisteners: Array<() => void> = [];
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          if (stallTimer) clearTimeout(stallTimer);
          if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
          for (const fn of unlisteners) fn();
          abortBridge.detach();
          aiLog.info("[streamWithTools] cleanup", {
            conversationId,
            elapsedMs: Date.now() - startedAt,
            chunkCount,
            chunkChars,
            hasToolCalls: !!resolvedToolCalls?.length,
          });
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
            listen<{ conversation_id: string; raw_line: string }>(
              "ai-stream-raw",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  traceStreamEvent(conversationId, "raw", event.payload.raw_line);
                }
              },
            ),
            listen<{ conversation_id: string; content: string }>(
              "ai-stream-chunk",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  kickWatchdog("chunk");
                  if (!firstChunkAt) {
                    firstChunkAt = Date.now();
                    aiLog.info("[streamWithTools] first chunk", {
                      conversationId,
                      latencyMs: firstChunkAt - startedAt,
                    });
                  }
                  chunkCount += 1;
                  chunkChars += event.payload.content.length;
                  const parsed = reasoningStream.processTextChunk(
                    event.payload.content,
                  );
                  if (parsed.visible) {
                    hadModelResponse = true;
                    fullContent += parsed.visible;
                    traceStreamEvent(conversationId, "chunk", parsed.visible);
                    options.onChunk(parsed.visible);
                  }
                  if (parsed.thinking) {
                    hadModelResponse = true;
                    traceStreamEvent(
                      conversationId,
                      "thinking_inline",
                      parsed.thinking,
                    );
                    options.onThinking?.(parsed.thinking);
                  }
                }
              },
            ),
            listen<{ conversation_id: string; tool_calls: AIToolCall[] }>(
              "ai-agent-tool-calls",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  resolvedToolCalls = event.payload.tool_calls;
                  kickWatchdog("tool_calls");
                  traceStreamEvent(conversationId, "tool_calls", event.payload.tool_calls);
                  aiLog.info("[streamWithTools] tool calls received", {
                    conversationId,
                    count: resolvedToolCalls.length,
                  });
                }
              },
            ),
            listen<{ conversation_id: string }>(
              "ai-stream-done",
              (event) => {
                if (event.payload.conversation_id !== conversationId || settled) {
                  return;
                }
                kickWatchdog("done");
                traceStreamEvent(
                  conversationId,
                  "done",
                  resolvedToolCalls && resolvedToolCalls.length > 0
                    ? { toolCalls: resolvedToolCalls }
                    : fullContent,
                );
                aiLog.info("[streamWithTools] done event", {
                  conversationId,
                  elapsedMs: Date.now() - startedAt,
                  chunkCount,
                  chunkChars,
                  hasToolCalls: !!resolvedToolCalls?.length,
                });
                if (abortBridge.isAborted()) {
                  safeReject(new Error("Aborted"));
                  return;
                }
                const remaining = reasoningStream.flush();
                if (remaining.visible) {
                  hadModelResponse = true;
                  fullContent += remaining.visible;
                  traceStreamEvent(conversationId, "chunk", remaining.visible);
                  options.onChunk(remaining.visible);
                }
                if (remaining.thinking) {
                  hadModelResponse = true;
                  traceStreamEvent(
                    conversationId,
                    "thinking_inline",
                    remaining.thinking,
                  );
                  options.onThinking?.(remaining.thinking);
                }
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
                  options.onDone?.(fullContent);
                  safeResolve({ type: "content", content: fullContent });
                }
              },
            ),
            listen<{ conversation_id: string; error: string }>(
              "ai-stream-error",
              (event) => {
                if (event.payload.conversation_id !== conversationId || settled) {
                  return;
                }
                kickWatchdog("error");
                traceStreamEvent(conversationId, "error", event.payload.error);
                aiLog.error("[streamWithTools] error event", {
                  conversationId,
                  elapsedMs: Date.now() - startedAt,
                  chunkCount,
                  chunkChars,
                  error: event.payload.error,
                });
                if (abortBridge.isAborted()) {
                  safeReject(new Error("Aborted"));
                  return;
                }
                const remaining = reasoningStream.flush();
                if (remaining.thinking) {
                  hadModelResponse = true;
                  traceStreamEvent(
                    conversationId,
                    "thinking_inline",
                    remaining.thinking,
                  );
                  options.onThinking?.(remaining.thinking);
                }
                safeReject(new Error(event.payload.error));
              },
            ),
            listen<{ conversation_id: string; content: string }>(
              "ai-stream-thinking",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  kickWatchdog("thinking");
                  const parsed = reasoningStream.processThinkingChunk(
                    event.payload.content ?? "",
                  );
                  traceStreamEvent(conversationId, "thinking", parsed.thinking);
                  if (parsed.thinking) {
                    hadModelResponse = true;
                    options.onThinking?.(parsed.thinking);
                  }
                }
              },
            ),
            listen<{ conversation_id: string; content: string }>(
              "ai-stream-tool-args",
              (event) => {
                if (event.payload.conversation_id === conversationId) {
                  kickWatchdog("tool-args");
                  traceStreamEvent(conversationId, "tool_args", event.payload.content ?? "");
                  options.onToolArgs?.(event.payload.content ?? "");
                }
              },
            ),
          ]);
          unlisteners.push(...listeners);
          aiLog.info("[streamWithTools] listeners ready", { conversationId });

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
          const routed = await resolveRoutedConfig(config);
          aiLog.info("[streamWithTools] start", {
            conversationId,
            model: routed.model,
            protocol: routed.protocol ?? "openai",
            source: routed.source,
            baseUrl: routed.base_url,
            teamId: routed.team_id,
            teamConfigId: routed.team_config_id,
            tools: options.tools?.length ?? 0,
            messages: options.messages.length,
          });
          aiLog.info("[streamWithTools] invoke ai_agent_stream", {
            conversationId,
            messages: finalMessages.length,
            tools: options.tools?.length ?? 0,
          });
          await invoke("ai_agent_stream", {
            messages: finalMessages,
            config: routed,
            tools: options.tools,
            conversationId,
          });
          aiLog.info("[streamWithTools] invoke resolved", {
            conversationId,
            elapsedMs: Date.now() - startedAt,
          });
        })().catch((e) => {
          const errMsg = e instanceof Error ? e.message : String(e);
          aiLog.error("[streamWithTools] invoke failed", {
            conversationId,
            elapsedMs: Date.now() - startedAt,
            error: errMsg,
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

/** 全局单例 */
let _instance: MToolsAI | null = null;
export function getMToolsAI(): MToolsAI {
  if (!_instance) {
    _instance = createMToolsAI();
  }
  return _instance;
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
}): Promise<{ content: string }> {
  const config = getConfig();
  const routed = await resolveRoutedConfig({
    ...config,
    ...(options.model ? { model: options.model } : {}),
    ...(options.temperature != null ? { temperature: options.temperature } : {}),
  });
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
    throw new Error(`API 错误: ${text}`);
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
}
