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
import { getRoutedConfig } from "@/core/ai/router";
import {
  appendMemoryCandidates,
  buildMemoryPromptBlock,
  extractMemoryCandidates,
  recallMemories,
} from "@/core/ai/memory-store";

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

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
    const candidates = extractMemoryCandidates(userText, {
      conversationId,
    });
    if (candidates.length > 0) {
      await appendMemoryCandidates(candidates);
    }
  }

  if (!config.enable_memory_auto_recall) return messages;

  const recalled = await recallMemories(userText, {
    conversationId,
    topK: 6,
  });
  const memoryPrompt = buildMemoryPromptBlock(recalled);
  if (!memoryPrompt) return messages;

  return [{ role: "system", content: memoryPrompt }, ...messages];
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
      const routed = getRoutedConfig(effectiveConfig);

      return new Promise((resolve, reject) => {
        let content = "";
        const abortBridge = attachAbortBridge(options.signal, conversationId);
        let cleaned = false;
        const unlisteners: Array<() => void> = [];
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          for (const fn of unlisteners) fn();
          abortBridge.detach();
        };

        void (async () => {
          unlisteners.push(await listen<{
            conversation_id: string;
            content: string;
          }>("ai-stream-chunk", (event) => {
            if (event.payload.conversation_id === conversationId) {
              content += event.payload.content;
            }
          }));

          unlisteners.push(await listen<{ conversation_id: string }>(
            "ai-stream-done",
            (event) => {
              if (event.payload.conversation_id === conversationId) {
                cleanup();
                if (abortBridge.isAborted()) {
                  reject(new Error("Aborted"));
                  return;
                }
                resolve({ content });
              }
            },
          ));

          unlisteners.push(await listen<{
            conversation_id: string;
            error: string;
          }>("ai-stream-error", (event) => {
            if (event.payload.conversation_id === conversationId) {
              cleanup();
              if (abortBridge.isAborted()) {
                reject(new Error("Aborted"));
                return;
              }
              reject(new Error(event.payload.error));
            }
          }));

          if (abortBridge.isAborted()) {
            cleanup();
            reject(new Error("Aborted"));
            return;
          }

          const enrichedMessages = await injectMemoryForMessages(
            options.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            effectiveConfig,
            conversationId,
          );

          await invoke("ai_chat_stream", {
            messages: enrichedMessages,
            config: routed,
            conversationId,
          });
        })().catch((e) => {
          cleanup();
          if (abortBridge.isAborted()) {
            reject(new Error("Aborted"));
            return;
          }
          reject(e);
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
      const routed = getRoutedConfig(effectiveConfig);
      let fullContent = "";

      return new Promise((resolve, reject) => {
        const abortBridge = attachAbortBridge(options.signal, conversationId);
        let cleaned = false;
        const unlisteners: Array<() => void> = [];
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          for (const fn of unlisteners) fn();
          abortBridge.detach();
        };

        void (async () => {
          unlisteners.push(await listen<{
            conversation_id: string;
            content: string;
          }>("ai-stream-chunk", (event) => {
            if (event.payload.conversation_id === conversationId) {
              fullContent += event.payload.content;
              options.onChunk(event.payload.content);
            }
          }));

          unlisteners.push(await listen<{ conversation_id: string }>(
            "ai-stream-done",
            (event) => {
              if (event.payload.conversation_id === conversationId) {
                cleanup();
                if (abortBridge.isAborted()) {
                  reject(new Error("Aborted"));
                  return;
                }
                options.onDone?.(fullContent);
                resolve();
              }
            },
          ));

          unlisteners.push(await listen<{
            conversation_id: string;
            error: string;
          }>("ai-stream-error", (event) => {
            if (event.payload.conversation_id === conversationId) {
              cleanup();
              if (abortBridge.isAborted()) {
                reject(new Error("Aborted"));
                return;
              }
              reject(new Error(event.payload.error));
            }
          }));

          if (abortBridge.isAborted()) {
            cleanup();
            reject(new Error("Aborted"));
            return;
          }

          const enrichedMessages = await injectMemoryForMessages(
            options.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            effectiveConfig,
            conversationId,
          );

          await invoke("ai_chat_stream", {
            messages: enrichedMessages,
            config: routed,
            conversationId,
          });
        })().catch((e) => {
          cleanup();
          if (abortBridge.isAborted()) {
            reject(new Error("Aborted"));
            return;
          }
          reject(e);
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
      const config = getConfig();
      const conversationId = `agent-${generateId()}`;
      const routed = getRoutedConfig(config);
      let fullContent = "";
      let resolvedToolCalls: AIToolCall[] | null = null;

      return new Promise((resolve, reject) => {
        const abortBridge = attachAbortBridge(options.signal, conversationId);
        let cleaned = false;
        const unlisteners: Array<() => void> = [];
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          for (const fn of unlisteners) fn();
          abortBridge.detach();
        };

        void (async () => {
          unlisteners.push(await listen<{
            conversation_id: string;
            content: string;
          }>("ai-stream-chunk", (event) => {
            if (event.payload.conversation_id === conversationId) {
              fullContent += event.payload.content;
              options.onChunk(event.payload.content);
            }
          }));

          unlisteners.push(await listen<{
            conversation_id: string;
            tool_calls: AIToolCall[];
          }>("ai-agent-tool-calls", (event) => {
            if (event.payload.conversation_id === conversationId) {
              resolvedToolCalls = event.payload.tool_calls;
            }
          }));

          unlisteners.push(await listen<{ conversation_id: string }>(
            "ai-stream-done",
            (event) => {
              if (event.payload.conversation_id === conversationId) {
                cleanup();
                if (abortBridge.isAborted()) {
                  reject(new Error("Aborted"));
                  return;
                }
                if (resolvedToolCalls && resolvedToolCalls.length > 0) {
                  resolve({ type: "tool_calls", toolCalls: resolvedToolCalls });
                } else {
                  options.onDone?.(fullContent);
                  resolve({ type: "content", content: fullContent });
                }
              }
            },
          ));

          unlisteners.push(await listen<{
            conversation_id: string;
            error: string;
          }>("ai-stream-error", (event) => {
            if (event.payload.conversation_id === conversationId) {
              cleanup();
              if (abortBridge.isAborted()) {
                reject(new Error("Aborted"));
                return;
              }
              reject(new Error(event.payload.error));
            }
          }));

          if (abortBridge.isAborted()) {
            cleanup();
            reject(new Error("Aborted"));
            return;
          }

          const finalMessages = options.messages.map((m) => ({
            role: m.role,
            content: m.content ?? "",
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            ...(m.name ? { name: m.name } : {}),
          }));

          await invoke("ai_agent_stream", {
            messages: finalMessages,
            config: routed,
            tools: options.tools,
            conversationId,
          });
        })().catch((e) => {
          cleanup();
          if (abortBridge.isAborted()) {
            reject(new Error("Aborted"));
            return;
          }
          reject(e);
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
