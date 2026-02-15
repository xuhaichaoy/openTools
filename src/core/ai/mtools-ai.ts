/**
 * mtools.ai SDK — Core Shell 向插件暴露的 AI 能力
 *
 * 桥接 MToolsAI 接口到 Tauri 后端的 ai_chat_stream 命令。
 * 插件（内置或外部）通过该 SDK 使用用户已配置的模型，
 * 无需自行管理 API Key 或模型选择。
 */

import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAIStore, type AIConfig } from "@/store/ai-store";

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

/** 获取当前 AI 配置 */
function getConfig(): AIConfig {
  return useAIStore.getState().config;
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
      const effectiveConfig: AIConfig = {
        ...config,
        model: options.model || config.model,
        temperature: options.temperature ?? config.temperature,
      };

      return new Promise(async (resolve, reject) => {
        let content = "";

        const unlisten = await listen<{
          conversation_id: string;
          content: string;
        }>("ai-stream-chunk", (event) => {
          if (event.payload.conversation_id === conversationId) {
            content += event.payload.content;
          }
        });

        const unlistenDone = await listen<{ conversation_id: string }>(
          "ai-stream-done",
          (event) => {
            if (event.payload.conversation_id === conversationId) {
              cleanup();
              resolve({ content });
            }
          },
        );

        const unlistenError = await listen<{
          conversation_id: string;
          error: string;
        }>("ai-stream-error", (event) => {
          if (event.payload.conversation_id === conversationId) {
            cleanup();
            reject(new Error(event.payload.error));
          }
        });

        const cleanup = () => {
          unlisten();
          unlistenDone();
          unlistenError();
        };

        try {
          await invoke("ai_chat_stream", {
            messages: options.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            config: effectiveConfig,
            conversationId,
          });
        } catch (e) {
          cleanup();
          reject(e);
        }
      });
    },

    /**
     * 流式对话 — 逐 chunk 回调
     */
    async stream(options) {
      const config = getConfig();
      const conversationId = `sdk-${generateId()}`;
      let fullContent = "";

      return new Promise(async (resolve, reject) => {
        const unlisten = await listen<{
          conversation_id: string;
          content: string;
        }>("ai-stream-chunk", (event) => {
          if (event.payload.conversation_id === conversationId) {
            fullContent += event.payload.content;
            options.onChunk(event.payload.content);
          }
        });

        const unlistenDone = await listen<{ conversation_id: string }>(
          "ai-stream-done",
          (event) => {
            if (event.payload.conversation_id === conversationId) {
              cleanup();
              options.onDone?.(fullContent);
              resolve();
            }
          },
        );

        const unlistenError = await listen<{
          conversation_id: string;
          error: string;
        }>("ai-stream-error", (event) => {
          if (event.payload.conversation_id === conversationId) {
            cleanup();
            reject(new Error(event.payload.error));
          }
        });

        const cleanup = () => {
          unlisten();
          unlistenDone();
          unlistenError();
        };

        try {
          await invoke("ai_chat_stream", {
            messages: options.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            config,
            conversationId,
          });
        } catch (e) {
          cleanup();
          reject(e);
        }
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
        console.warn("[mtools.ai] embedding 调用失败，返回空向量:", e);
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
