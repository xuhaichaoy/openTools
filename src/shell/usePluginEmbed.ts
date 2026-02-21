/**
 * 插件嵌入 Hook — 管理 iframe 嵌入状态、安全上下文和 PostMessage 桥
 * 从 App.tsx 提取的插件嵌入逻辑
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { useAppStore } from "@/store/app-store";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import { MAIN_VIEW_ID, PLUGIN_EMBED_VIEW_ID } from "@/core/navigation/view-stack";
import {
  createBridgeToken,
  isAllowedEmbedOrigin,
  toPostMessageTargetOrigin,
  getAllowedEmbedCommands,
  isAllowedPluginApiMethod,
  isValidPluginApiCallArgs,
  checkPluginApiPermission,
} from "@/shell/PluginBridge";
import { invoke } from "@tauri-apps/api/core";

export interface EmbedTarget {
  pluginId: string;
  featureCode: string;
  title?: string;
}

interface EmbedSecurity {
  view: string;
  pluginId: string | null;
  token: string | null;
  source: Window | null;
  origin: string | null;
}

export function usePluginEmbed(view: string, pushView: (v: string) => void) {
  const [embedTarget, setEmbedTarget] = useState<EmbedTarget | null>(null);
  const embedBridgeToken = useMemo(() => {
    if (view !== PLUGIN_EMBED_VIEW_ID || !embedTarget) {
      return null;
    }
    return createBridgeToken();
  }, [view, embedTarget]);
  const embedSecurityRef = useRef<EmbedSecurity>({
    view: MAIN_VIEW_ID,
    pluginId: null,
    token: null,
    source: null,
    origin: null,
  });

  // 同步安全上下文
  useEffect(() => {
    embedSecurityRef.current = {
      view,
      pluginId: embedTarget?.pluginId ?? null,
      token: embedBridgeToken,
      source: null,
      origin: null,
    };
  }, [view, embedTarget?.pluginId, embedBridgeToken]);

  // 监听 app-store 嵌入请求
  useEffect(() => {
    const openPendingEmbed = () => {
      const req = useAppStore.getState().consumeEmbed();
      if (req) {
        setEmbedTarget(req);
        pushView(PLUGIN_EMBED_VIEW_ID);
      }
    };

    queueMicrotask(openPendingEmbed);

    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      if (
        state.pendingEmbed &&
        state.pendingEmbed !== prevState.pendingEmbed
      ) {
        openPendingEmbed();
      }
    });

    return unsubscribe;
  }, [pushView]);

  // PostMessage 桥接处理器
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const d = e.data;
      if (!d || !e.source) return;
      const source = e.source as Window;
      const type = d.type as string | undefined;
      const isBridgeMessage =
        type === "mtools-embed-invoke" ||
        type === "mtools-ai-chat" ||
        type === "mtools-ai-stream";

      if (isBridgeMessage) {
        const origin = typeof e.origin === "string" ? e.origin : "";
        if (!isAllowedEmbedOrigin(origin)) {
          console.warn(
            `[Security] Blocked bridge message from origin: ${origin}`,
          );
          return;
        }
        const sec = embedSecurityRef.current;
        if (
          sec.view !== PLUGIN_EMBED_VIEW_ID ||
          !sec.pluginId ||
          !sec.token ||
          d.pluginId !== sec.pluginId ||
          d.token !== sec.token
        ) {
          console.warn("[Security] Blocked unauthorized embed bridge message");
          return;
        }
        if (!sec.source) {
          sec.source = source;
          sec.origin = origin;
        } else if (sec.source !== source) {
          console.warn("[Security] Blocked bridge message from unknown source");
          return;
        }
      }

      // 标准 invoke 桥
      if (d.type === "mtools-embed-invoke") {
        const id = d.id as string;
        const cmd = d.cmd as string;
        const token = d.token as string;
        const args = (d.args as Record<string, unknown>) ?? {};

        const sec = embedSecurityRef.current;
        const SAFE_COMMANDS = getAllowedEmbedCommands(sec.pluginId || "");

        const send = (result: unknown, error?: string) => {
          try {
            const targetOrigin = toPostMessageTargetOrigin(
              embedSecurityRef.current.origin,
            );
            source.postMessage(
              {
                type: "mtools-embed-result",
                id,
                token,
                result: error === undefined ? result : undefined,
                error,
              },
              targetOrigin,
            );
          } catch {
            // iframe 可能已卸载
          }
        };

        if (!SAFE_COMMANDS.has(cmd)) {
          console.warn(`[Security] Blocked unauthorized invoke: ${cmd}`);
          send(
            undefined,
            `Permission denied: Command '${cmd}' is not allowed.`,
          );
          return;
        }

        if (cmd === "plugin_api_call") {
          if (!isValidPluginApiCallArgs(args)) {
            send(undefined, "Invalid plugin_api_call args payload.");
            return;
          }
          if (args.pluginId !== sec.pluginId) {
            send(undefined, "Permission denied: plugin identity mismatch.");
            return;
          }
          if (!isAllowedPluginApiMethod(args.method)) {
            send(
              undefined,
              "Permission denied: plugin API method is not allowed.",
            );
            return;
          }
          const denyReason = checkPluginApiPermission(
            args.pluginId,
            args.method,
          );
          if (denyReason) {
            send(undefined, `Permission denied: ${denyReason}`);
            return;
          }
        }

        if (cmd === "plugin_action_callback") {
          const callbackArgs = args as Record<string, unknown>;
          const pluginId =
            typeof callbackArgs.pluginId === "string" ? callbackArgs.pluginId : "";
          const requestId =
            typeof callbackArgs.requestId === "string"
              ? callbackArgs.requestId
              : "";
          if (pluginId !== sec.pluginId) {
            send(undefined, "Permission denied: plugin identity mismatch.");
            return;
          }
          if (!requestId) {
            send(undefined, "Invalid plugin_action_callback args payload.");
            return;
          }
        }

        try {
          const result = await invoke(cmd, args);
          send(result);
        } catch (err) {
          send(undefined, String(err));
        }
        return;
      }

      // AI chat（单轮）
      if (d.type === "mtools-ai-chat") {
        const ai = getMToolsAI();
        const token = d.token as string;
        try {
          const targetOrigin = toPostMessageTargetOrigin(
            embedSecurityRef.current.origin,
          );
          const result = await ai.chat({
            messages: d.messages,
            model: d.model,
            temperature: d.temperature,
          });
          source.postMessage(
            {
              type: "mtools-ai-result",
              id: d.id,
              token,
              content: result.content,
            },
            targetOrigin,
          );
        } catch (err) {
          const targetOrigin = toPostMessageTargetOrigin(
            embedSecurityRef.current.origin,
          );
          source.postMessage(
            { type: "mtools-ai-result", id: d.id, token, error: String(err) },
            targetOrigin,
          );
        }
        return;
      }

      // AI stream（流式）
      if (d.type === "mtools-ai-stream") {
        const ai = getMToolsAI();
        const token = d.token as string;
        const targetOrigin = toPostMessageTargetOrigin(
          embedSecurityRef.current.origin,
        );
        try {
          await ai.stream({
            messages: d.messages,
            onChunk: (chunk: string) => {
              source.postMessage(
                { type: "mtools-ai-chunk", id: d.id, token, chunk },
                targetOrigin,
              );
            },
            onDone: (content: string) => {
              source.postMessage(
                { type: "mtools-ai-done", id: d.id, token, content },
                targetOrigin,
              );
            },
          });
        } catch (err) {
          source.postMessage(
            { type: "mtools-ai-error", id: d.id, token, error: String(err) },
            targetOrigin,
          );
        }
        return;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return {
    embedTarget,
    setEmbedTarget,
    embedBridgeToken,
  };
}
