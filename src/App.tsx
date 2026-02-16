import { useState, useCallback, useEffect, Suspense, useRef } from "react";
import { SearchBar } from "@/components/search/SearchBar";
import { ResultList, type ResultItem } from "@/components/search/ResultList";
import { ScreenshotSelector } from "@/components/tools/ScreenshotSelector";
import { ContextActionPanel } from "@/components/ai/ContextActionPanel";
import { Home } from "@/components/navigation/Home";
import { Dashboard } from "@/components/home/Dashboard";
import { PluginEmbed } from "@/components/plugins/PluginEmbed";
import { PluginErrorBoundary } from "@/components/plugins/PluginErrorBoundary";
import { useWorkflowStore } from "@/store/workflow-store";
import { usePluginStore } from "@/store/plugin-store";
import { useBookmarkStore } from "@/store/bookmark-store";
import { useAppStore } from "@/store/app-store";
import { useAIStore } from "@/store/ai-store";
import { useAgentStore } from "@/store/agent-store";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { Bot, Globe, Puzzle, Terminal, Database, Workflow as WorkflowIcon, ClipboardList, File, Folder, FileImage, FileVideo, FileAudio, FileText, FileCode, Archive, AppWindow } from "lucide-react";
import {
  emitPluginEvent,
  PluginEventTypes,
} from "@/core/plugin-system/event-bus";

// 插件注册中心
import { registry } from "@/core/plugin-system/registry";
import { builtinPlugins } from "@/plugins/builtin";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import { ScopedStorage } from "@/core/plugin-system/storage";

// 初始化：注册所有内置插件
registry.registerAll(builtinPlugins);

// 核心壳保留的特殊视图（不走插件注册）
type ShellView = "main" | "plugin-embed" | "context-action" | "home";

import {
  WINDOW_HEIGHT_COLLAPSED,
  WINDOW_HEIGHT_EXPANDED,
  WINDOW_HEIGHT_CHAT,
} from "@/core/constants";

// 独立窗口模式检测：截图选区窗口
const specialView = (window as any).__SCREENSHOT_MODE__ ? "screenshot" : null;

function createBridgeToken(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

function isAllowedEmbedOrigin(origin: string): boolean {
  // srcDoc + sandbox 场景常见 "null"，同源嵌入允许当前 origin
  return origin === "null" || origin === window.location.origin;
}

function toPostMessageTargetOrigin(origin: string | null): string {
  if (origin && origin !== "null") return origin;
  return "*";
}

function getAllowedEmbedCommands(pluginId: string): Set<string> {
  const plugin = usePluginStore
    .getState()
    .plugins.find((p) => p.id === pluginId && p.enabled);
  if (!plugin) return new Set<string>();

  const base = new Set<string>([
    "plugin_api_call",
    "open_url",
    "plugin_start_color_picker",
  ]);
  // 预留：未来可按 manifest/capabilities 做更细粒度扩展
  return base;
}

function isAllowedPluginApiMethod(method: unknown): method is string {
  if (typeof method !== "string") return false;
  const allowed = new Set<string>([
    "hideMainWindow",
    "showMainWindow",
    "setExpendHeight",
    "copyText",
    "showNotification",
    "shellOpenExternal",
    "shellOpenPath",
    "shellShowItemInFolder",
    "getPath",
    "copyImage",
    "setSubInput",
    "removeSubInput",
    "redirect",
    "dbStorage.setItem",
    "dbStorage.getItem",
    "dbStorage.removeItem",
    "outPlugin",
  ]);
  return allowed.has(method);
}

function isValidPluginApiCallArgs(
  args: Record<string, unknown>,
): args is {
  pluginId: string;
  method: string;
  args: string;
  callId: number;
} {
  return (
    typeof args.pluginId === "string" &&
    typeof args.method === "string" &&
    typeof args.args === "string" &&
    typeof args.callId === "number" &&
    Number.isFinite(args.callId)
  );
}

function App() {
  // 截图选区窗口使用独立组件，避免加载主应用逻辑
  if (specialView === "screenshot") {
    return (
      <div className="w-full h-full" style={{ background: "#000" }}>
        <ScreenshotSelector />
      </div>
    );
  }
  return <MainApp />;
}

/** 主应用组件 — 所有 hooks 在此无条件调用，符合 Rules of Hooks */
function MainApp() {
  // view 可以是 ShellView 或任意插件的 viewId
  const [view, setView] = useState<string>("main");
  const [contextText, setContextText] = useState("");
  const [embedTarget, setEmbedTarget] = useState<{
    pluginId: string;
    featureCode: string;
    title?: string;
  } | null>(null);
  const [embedBridgeToken, setEmbedBridgeToken] = useState<string | null>(null);
  const embedSecurityRef = useRef<{
    view: string;
    pluginId: string | null;
    token: string | null;
    source: Window | null;
    origin: string | null;
  }>({
    view: "main",
    pluginId: null,
    token: null,
    source: null,
    origin: null,
  });
  const { mode, searchValue, setWindowExpanded, reset } = useAppStore();
  const { config } = useAIStore();
  const lastCaptureHandledRef = (window as any).__LAST_CAPTURE_HANDLED_REF__ ||
    ((window as any).__LAST_CAPTURE_HANDLED_REF__ = { key: "", ts: 0 });

  const handleDirectColorPicker = useCallback(async () => {
    try {
      await invoke<string>("plugin_start_color_picker");
    } catch (e) {
      console.error("取色失败:", e);
    }
  }, []);

  // ── 文件搜索（异步 + 防抖） ──
  interface FileSearchResult {
    name: string;
    path: string;
    is_dir: boolean;
    size: number;
    modified: string | null;
    file_type: string;
  }
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
  const fileSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 清理上一次定时器
    if (fileSearchTimerRef.current) {
      clearTimeout(fileSearchTimerRef.current);
      fileSearchTimerRef.current = null;
    }

    const trimmed = searchValue.trim();

    // 仅在有 >= 2 字符的查询词时触发文件搜索（f 前缀 或 普通搜索）
    const isFilePrefix = trimmed.startsWith("f ");
    const query = isFilePrefix ? trimmed.slice(2).trim() : trimmed;

    // 前缀模式（bd/gg/bing/ai/cb/data/）不搜文件
    const prefixModes = ["ai ", "bd ", "gg ", "bing ", "/ ", "cb", "data "];
    const isPrefix = prefixModes.some((p) => trimmed.startsWith(p) || trimmed === p.trim());
    if (!query || query.length < 2 || (isPrefix && !isFilePrefix)) {
      setFileResults([]);
      return;
    }

    // 300ms 防抖
    fileSearchTimerRef.current = setTimeout(async () => {
      try {
        const results = await invoke<FileSearchResult[]>("file_search", {
          query,
          maxResults: isFilePrefix ? 24 : 8, // f 前缀模式显示更多结果
        });
        setFileResults(results);
      } catch (e) {
        console.warn("文件搜索失败:", e);
        setFileResults([]);
      }
    }, 300);

    return () => {
      if (fileSearchTimerRef.current) {
        clearTimeout(fileSearchTimerRef.current);
      }
    };
  }, [searchValue]);

  // 启动时加载 AI 配置、对话历史、工作流、插件和通用设置
  useEffect(() => {
    useAIStore.getState().loadConfig();
    useAIStore.getState().loadHistory();
    useAgentStore.getState().loadHistory();
    useWorkflowStore.getState().loadWorkflows();
    usePluginStore.getState().loadPlugins();
    useBookmarkStore.getState().loadBookmarks();

    // 启动定时工作流调度器
    invoke("workflow_scheduler_start").catch((e) =>
      console.warn("定时调度启动失败:", e),
    );

    // 监听定时工作流触发事件
    let unlistenScheduled: (() => void) | undefined;
    listen<{ workflowId: string; workflowName: string }>(
      "workflow-scheduled-trigger",
      (event) => {
        const { workflowId } = event.payload;
        useWorkflowStore.getState().executeWorkflow(workflowId);
      },
    ).then((fn) => {
      unlistenScheduled = fn;
    });

    // 加载主题设置
    invoke<string>("load_general_settings")
      .then((json) => {
        const settings = JSON.parse(json);
        if (settings.theme) {
          document.documentElement.setAttribute("data-theme", settings.theme);
        }
      })
      .catch((e) => console.error("Failed to load settings:", e));

    return () => {
      unlistenScheduled?.();
    };
  }, []);

  useEffect(() => {
    if (view === "plugin-embed" && embedTarget) {
      setEmbedBridgeToken(createBridgeToken());
    } else {
      setEmbedBridgeToken(null);
    }
  }, [view, embedTarget?.pluginId, embedTarget?.featureCode]);

  useEffect(() => {
    embedSecurityRef.current = {
      view,
      pluginId: embedTarget?.pluginId ?? null,
      token: embedBridgeToken,
      source: null,
      origin: null,
    };
  }, [view, embedTarget?.pluginId, embedBridgeToken]);

  // 监听 app-store 的嵌入请求（来自 PluginMarket 等）
  const pendingEmbed = useAppStore((s) => s.pendingEmbed);
  useEffect(() => {
    if (pendingEmbed) {
      const req = useAppStore.getState().consumeEmbed();
      if (req) {
        setEmbedTarget(req);
        setView("plugin-embed");
      }
    }
  }, [pendingEmbed]);

  // 监听 app-store 的导航请求（来自 PluginMarket 内置插件点击等）
  const pendingNavigate = useAppStore((s) => s.pendingNavigate);
  useEffect(() => {
    if (pendingNavigate) {
      const viewId = useAppStore.getState().consumeNavigate();
      if (viewId) {
        setView(viewId);
      }
    }
  }, [pendingNavigate]);

  // 监听 Rust 发来的上下文操作事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ text: string }>("context-action", (event) => {
      setContextText(event.payload.text);
      setView("context-action");
      invoke("resize_window", { height: WINDOW_HEIGHT_EXPANDED });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // 监听工作流插件动作请求（后端 → 前端）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{
      requestId: string;
      pluginId: string;
      actionName: string;
      params: string;
    }>("workflow-plugin-action", async (event) => {
      const { requestId, pluginId, actionName, params } = event.payload;
      try {
        // 查找注册表中的 action
        const allActions = registry.getAllActions();
        const found = allActions.find(
          (a) => a.pluginId === pluginId && a.action.name === actionName,
        );
        if (!found) {
          throw new Error(
            `找不到插件动作: ${pluginId}/${actionName}`,
          );
        }
        // 解析参数
        let parsedParams: Record<string, unknown> = {};
        try {
          parsedParams = JSON.parse(params);
        } catch {
          /* 忽略无效 JSON */
        }
        // 执行 action
        const result = await found.action.execute(
          parsedParams,
          { ai: getMToolsAI() },
        );
        // 返回结果给后端
        await emit("workflow-plugin-action-result", {
          requestId,
          result: typeof result === "string" ? result : JSON.stringify(result),
        });
      } catch (e: unknown) {
        await emit("workflow-plugin-action-result", {
          requestId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // 全局监听截图完成事件，保证 OCR/贴图在任意页面都生效
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<{
      path?: string;
      action?: string;
      imageBase64?: string;
      imageWidth?: number;
      imageHeight?: number;
    }>(
      "capture-done",
      async (e) => {
        const {
          path: capPath,
          action,
          imageBase64,
          imageWidth,
          imageHeight,
        } = e.payload || {};
        if (!capPath) return;

        // 去重：StrictMode/重复监听/重复事件时，短时间内同 key 只处理一次
        const key = `${action || "copy"}|${capPath}`;
        const now = Date.now();
        if (
          lastCaptureHandledRef.key === key &&
          now - lastCaptureHandledRef.ts < 1200
        ) {
          return;
        }
        lastCaptureHandledRef.key = key;
        lastCaptureHandledRef.ts = now;

        if (action === "pin") {
          try {
            if (!imageBase64) {
              console.warn("pin 缺少 imageBase64，跳过");
              return;
            }
            const srcW = Math.max(1, imageWidth || 300);
            const srcH = Math.max(1, imageHeight || 300);
            const maxW = 560;
            const maxH = 420;
            const scale = Math.min(maxW / srcW, maxH / srcH, 1);
            const width = Math.round(srcW * scale);
            const height = Math.round(srcH * scale);
            await invoke("ding_create", {
              imageBase64,
              x: 100.0,
              y: 100.0,
              width,
              height,
            });
          } catch (err) {
            console.error("全局贴图失败:", err);
          }
          return;
        }

        if (action === "ocr") {
          try {
            if (!imageBase64) {
              console.warn("ocr 缺少 imageBase64，跳过");
              return;
            }
            (window as any).__PENDING_OCR_IMAGE__ = imageBase64;
            setView("ocr");
            // 先切到 OCR 页，再投喂截图事件；插件端也会从全局变量兜底读取
            setTimeout(() => {
              emitPluginEvent(
                PluginEventTypes.SCREENSHOT_CAPTURED,
                "screen-capture",
                {
                  imageBase64,
                },
              );
            }, 80);
          } catch (err) {
            console.error("全局 OCR 处理失败:", err);
          }
        }
      },
    ).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 插件窗口通过 BroadcastChannel 请求屏幕取色（不依赖插件窗口的 __TAURI__）
  useEffect(() => {
    const CH = "mtools-screen-pick";
    const bc = new BroadcastChannel(CH);
    bc.onmessage = async (e) => {
      if (e.data?.type !== "request-screen-pick") return;
      try {
        const hex = await invoke<string>("plugin_start_color_picker");
        if (hex) {
          bc.postMessage({ type: "screen-color-picked", color: hex });
        }
      } catch (err) {
        console.error("[mTools] 取色失败:", err);
      }
    };
    return () => bc.close();
  }, []);

  // iframe 嵌入插件：子页通过 postMessage 请求 invoke / AI，主窗口代为调用并回传结果
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
          console.warn(`[Security] Blocked bridge message from origin: ${origin}`);
          return;
        }
        const sec = embedSecurityRef.current;
        if (
          sec.view !== "plugin-embed" ||
          !sec.pluginId ||
          !sec.token ||
          d.pluginId !== sec.pluginId ||
          d.token !== sec.token
        ) {
          console.warn("[Security] Blocked unauthorized embed bridge message");
          return;
        }
        // 绑定 source：首条合法消息建立会话来源，后续必须同一窗口
        if (!sec.source) {
          sec.source = source;
          sec.origin = origin;
        } else if (sec.source !== source) {
          console.warn("[Security] Blocked bridge message from unknown source");
          return;
        }
      }

      // ── 标准 invoke 桥 ──
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
          } catch (_) {}
        };

        if (!SAFE_COMMANDS.has(cmd)) {
          console.warn(`[Security] Blocked unauthorized invoke: ${cmd}`);
          send(
            undefined,
            `Permission denied: Command '${cmd}' is not allowed.`,
          );
          return;
        }

        // 进一步约束 plugin_api_call：插件身份与可调用方法都要匹配
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
            send(undefined, "Permission denied: plugin API method is not allowed.");
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

      // ── AI chat（单轮，等完整结果）──
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
            { type: "mtools-ai-result", id: d.id, token, content: result.content },
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

      // ── AI stream（流式，逐 chunk 推送）──
      if (d.type === "mtools-ai-stream") {
        const ai = getMToolsAI();
        const token = d.token as string;
        const targetOrigin = toPostMessageTargetOrigin(
          embedSecurityRef.current.origin,
        );
        try {
          await ai.stream({
            messages: d.messages,
            onChunk: (chunk) => {
              source.postMessage(
                { type: "mtools-ai-chunk", id: d.id, token, chunk },
                targetOrigin,
              );
            },
            onDone: (content) => {
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

  // ── 文件搜索结果 → ResultItem 转换 ──
  const getFileIcon = useCallback((fileType: string) => {
    switch (fileType) {
      case "folder": return <Folder className="w-6 h-6" />;
      case "image": return <FileImage className="w-6 h-6" />;
      case "video": return <FileVideo className="w-6 h-6" />;
      case "audio": return <FileAudio className="w-6 h-6" />;
      case "code": return <FileCode className="w-6 h-6" />;
      case "text": case "document": return <FileText className="w-6 h-6" />;
      case "archive": return <Archive className="w-6 h-6" />;
      case "executable": return <AppWindow className="w-6 h-6" />;
      default: return <File className="w-6 h-6" />;
    }
  }, []);

  const getFileColor = useCallback((fileType: string) => {
    switch (fileType) {
      case "folder": return "text-yellow-500 bg-yellow-500/10";
      case "image": return "text-pink-500 bg-pink-500/10";
      case "video": return "text-red-500 bg-red-500/10";
      case "audio": return "text-purple-500 bg-purple-500/10";
      case "code": return "text-green-500 bg-green-500/10";
      case "text": case "document": return "text-blue-500 bg-blue-500/10";
      case "archive": return "text-amber-500 bg-amber-500/10";
      case "executable": return "text-gray-500 bg-gray-500/10";
      default: return "text-slate-500 bg-slate-500/10";
    }
  }, []);

  const fileResultToItem = useCallback((f: FileSearchResult): ResultItem => {
    const sizeStr = f.is_dir ? "文件夹" : formatFileSize(f.size);
    return {
      id: `file-${f.path}`,
      title: f.name,
      description: `${f.path}${f.modified ? ` · ${f.modified}` : ""}${sizeStr ? ` · ${sizeStr}` : ""}`,
      icon: getFileIcon(f.file_type),
      color: getFileColor(f.file_type),
      category: "文件",
      action: () => {
        invoke("file_open", { path: f.path });
      },
    };
  }, [getFileIcon, getFileColor]);

  // ── 统一搜索 ──
  const getFilteredResults = useCallback((): ResultItem[] => {
    if (!searchValue) return [];

    // 前缀模式处理
    if (searchValue.startsWith("ai ")) {
      return [
        {
          id: "ai-enter",
          title: `问 AI：${searchValue.slice(3)}`,
          description: "按 Enter 开始对话",
          icon: <Bot className="w-6 h-6" />,
          color: "text-indigo-500 bg-indigo-500/10",
          category: "AI",
          action: () => {
            useAIStore.getState().sendMessage(searchValue.slice(3));
            setView("ai-center");
          },
        },
      ];
    }

    if (searchValue.startsWith("bd ")) {
      const query = searchValue.slice(3);
      return [
        {
          id: "baidu-search",
          title: `百度：${query}`,
          description: "https://www.baidu.com",
          icon: <Globe className="w-6 h-6" />,
          color: "text-blue-500 bg-blue-500/10",
          category: "搜索",
          action: () => {
            invoke("open_url", {
              url: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
            });
          },
        },
      ];
    }

    if (searchValue.startsWith("gg ")) {
      const query = searchValue.slice(3);
      return [
        {
          id: "google-search",
          title: `Google：${query}`,
          description: "https://www.google.com",
          icon: <Globe className="w-6 h-6" />,
          color: "text-green-500 bg-green-500/10",
          category: "搜索",
          action: () => {
            invoke("open_url", {
              url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
            });
          },
        },
      ];
    }

    if (searchValue.startsWith("bing ")) {
      const query = searchValue.slice(5);
      return [
        {
          id: "bing-search",
          title: `必应：${query}`,
          description: "https://www.bing.com",
          icon: <Globe className="w-6 h-6" />,
          color: "text-teal-500 bg-teal-500/10",
          category: "搜索",
          action: () => {
            invoke("open_url", {
              url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
            });
          },
        },
      ];
    }

    if (searchValue.startsWith("/ ")) {
      const cmd = searchValue.slice(2);
      return [
        {
          id: "shell-enter",
          title: `Shell：${cmd || "..."}`,
          description: "AI Agent 执行 shell 命令并返回结果",
          icon: <Terminal className="w-6 h-6" />,
          color: "text-orange-500 bg-orange-500/10",
          category: "Agent",
          action: () => {
            if (cmd.trim()) {
              useAIStore
                .getState()
                .sendMessage(
                  `请执行以下 shell 命令并解释结果：\`${cmd.trim()}\``,
                );
              setView("ai-center");
            }
          },
        },
      ];
    }

    if (searchValue.startsWith("cb ") || searchValue === "cb") {
      const keyword = searchValue.slice(3).trim();
      return [
        {
          id: "clipboard-history-enter",
          title: keyword ? `剪贴板搜索：${keyword}` : "打开剪贴板历史",
          description: "查看和搜索剪贴板记录",
          icon: <ClipboardList className="w-6 h-6" />,
          color: "text-cyan-500 bg-cyan-500/10",
          category: "工具",
          action: () => setView("clipboard-history"),
        },
      ];
    }

    if (searchValue.startsWith("data ")) {
      const query = searchValue.slice(5);
      return [
        {
          id: "data-forge-enter",
          title: `数据工坊：${query || "打开"}`,
          description: "搜索数据脚本或用 AI 描述数据需求",
          icon: <Database className="w-6 h-6" />,
          color: "text-purple-500 bg-purple-500/10",
          category: "数据",
          action: () => setView("data-forge"),
        },
      ];
    }

    // f 前缀：仅搜索文件
    if (searchValue.startsWith("f ")) {
      return fileResults.map(fileResultToItem);
    }

    // sn 前缀：快捷短语
    if (searchValue.startsWith("sn ") || searchValue === "sn") {
      const keyword = searchValue.slice(3).trim();
      return [
        {
          id: "snippets-enter",
          title: keyword ? `搜索短语：${keyword}` : "打开快捷短语",
          description: "管理和使用文本片段",
          icon: <FileText className="w-6 h-6" />,
          color: "text-emerald-500 bg-emerald-500/10",
          category: "工具",
          action: () => setView("snippets"),
        },
      ];
    }

    // bk 前缀：网页书签
    if (searchValue.startsWith("bk ") || searchValue === "bk") {
      const keyword = searchValue.slice(3).trim();
      return [
        {
          id: "bookmarks-enter",
          title: keyword ? `搜索书签：${keyword}` : "打开网页书签",
          description: "管理和搜索收藏的网页",
          icon: <Globe className="w-6 h-6" />,
          color: "text-blue-500 bg-blue-500/10",
          category: "工具",
          action: () => setView("bookmarks"),
        },
      ];
    }

    // 搜索工作流 — 关键词匹配触发
    const workflowStore = useWorkflowStore.getState();
    const matchedWorkflow = workflowStore.matchByKeyword(searchValue);
    if (matchedWorkflow) {
      return [
        {
          id: `wf-${matchedWorkflow.id}`,
          title: `${matchedWorkflow.icon} 运行: ${matchedWorkflow.name}`,
          description: matchedWorkflow.description,
          icon: <WorkflowIcon className="w-6 h-6" />,
          color: "text-teal-500 bg-teal-500/10",
          category: "工作流",
          action: () => {
            workflowStore.executeWorkflow(matchedWorkflow.id);
            setView("workflows");
          },
        },
      ];
    }

    // 搜索内置插件（通过 registry）
    const builtinResults: ResultItem[] = registry
      .search(searchValue)
      .map(({ plugin }) => ({
        id: plugin.id,
        title: plugin.name,
        description: plugin.description,
        icon: plugin.icon,
        color: plugin.color,
        category: plugin.category,
        action: () => setView(plugin.viewId),
      }));

    // 搜索外部插件（uTools/Rubick 兼容）
    const pluginMatches = usePluginStore.getState().matchInput(searchValue);
    const BUILTIN_COLOR_PICKER = "color-picker";
    const BUILTIN_SCREEN_CAPTURE = "screen-capture";
    const pluginResults: ResultItem[] = pluginMatches.map((pr) => {
      const code = pr.feature.code;
      const isColorPicker = code === BUILTIN_COLOR_PICKER;
      const isScreenCapture = code === BUILTIN_SCREEN_CAPTURE;
      return {
        id: `plugin-${pr.plugin.id}-${code}`,
        title: pr.plugin.manifest.pluginName,
        description: pr.feature.explain,
        icon: <Puzzle className="w-6 h-6" />,
        color: "text-orange-500 bg-orange-500/10",
        category: "插件",
        action: isColorPicker
          ? handleDirectColorPicker
          : isScreenCapture
            ? () => setView("screen-capture")
            : () => usePluginStore.getState().openPlugin(pr.plugin.id, code),
      };
    });

    // 文件搜索结果混排（排在插件之后）
    const fileItems: ResultItem[] = fileResults.map(fileResultToItem);

    // 书签搜索结果混排（排在文件之后，最多显示 6 条）
    const bmStore = useBookmarkStore.getState();
    const bmMatches = searchValue.length >= 2
      ? bmStore.searchBookmarks(searchValue).slice(0, 6)
      : [];
    const bookmarkItems: ResultItem[] = bmMatches.map((bm) => ({
      id: `bm-${bm.id}`,
      title: bm.title,
      description: bm.url,
      icon: <Globe className="w-6 h-6" />,
      color: "text-blue-500 bg-blue-500/10",
      category: "书签",
      action: () => {
        bmStore.markVisited(bm.id);
        invoke("open_url", { url: bm.url });
      },
    }));

    return [...builtinResults, ...pluginResults, ...fileItems, ...bookmarkItems];
  }, [searchValue, config.model, handleDirectColorPicker, fileResults]);

  // 窗口大小管理
  useEffect(() => {
    const BASE_HEIGHT = 80; // 搜索框 + padding
    const GRID_COLS = 8;
    const ROW_HEIGHT = 110; // 每行网格高度（图标 + 文字 + padding）

    if (view === "main") {
      if (!searchValue) {
        // Dashboard 模式：固定高度
        invoke("resize_window", { height: WINDOW_HEIGHT_EXPANDED });
        setWindowExpanded(true);
      } else {
        // 搜索模式：按网格行数计算高度
        const results = getFilteredResults();
        if (results.length > 0) {
          const rows = Math.ceil(results.length / GRID_COLS);
          const contentHeight = rows * ROW_HEIGHT;
          const height = Math.min(
            BASE_HEIGHT + contentHeight + 16,
            WINDOW_HEIGHT_EXPANDED,
          );
          invoke("resize_window", { height });
          setWindowExpanded(true);
        } else {
          invoke("resize_window", { height: WINDOW_HEIGHT_COLLAPSED });
          setWindowExpanded(false);
        }
      }
    } else if (view === "ai-center") {
      invoke("resize_window", { height: WINDOW_HEIGHT_CHAT });
      setWindowExpanded(true);
    } else {
      invoke("resize_window", { height: WINDOW_HEIGHT_EXPANDED });
      setWindowExpanded(true);
    }
  }, [view, mode, searchValue, getFilteredResults]);

  const handleSubmit = useCallback(
    (value: string, currentMode: string, images?: string[]) => {
      if (
        currentMode === "ai" ||
        value.startsWith("ai ") ||
        (images && images.length > 0)
      ) {
        const query = value.startsWith("ai ") ? value.slice(3) : value;
        const finalQuery =
          query.trim() || (images?.length ? "请描述这张图片" : "");

        if (finalQuery || (images && images.length > 0)) {
          useAIStore.getState().sendMessage(finalQuery, images);
          setView("ai-center");
        }
        return;
      }

      // / 前缀 → AI Agent 模式（直接进入 Agent Tab）
      if (value.startsWith("/ ")) {
        const cmd = value.slice(2).trim();
        if (cmd) {
          useAIStore
            .getState()
            .sendMessage(`请执行以下 shell 命令并解释结果：\`${cmd}\``);
        }
        useAppStore.getState().setAiInitialMode("agent");
        setView("ai-center");
        return;
      }

      // 执行选中项
      const results = getFilteredResults();
      const { selectedIndex } = useAppStore.getState();
      if (results[selectedIndex]?.action) {
        results[selectedIndex].action!();
      }
    },
    [getFilteredResults],
  );

  // ESC 返回主界面
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && view !== "main") {
        setView("main");
        reset();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, reset]);

  const filteredResults = getFilteredResults();

  // 当前激活的插件（通过 viewId 查找 registry）
  const activePlugin = registry.getByViewId(view);

  return (
    <div className="w-full h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl">
      {view === "main" && (
        <>
          <div className="sticky top-0 z-10 pb-0 bg-[var(--color-bg)]/80 backdrop-blur-xl">
            <SearchBar
              onSubmit={handleSubmit}
              resultCount={filteredResults.length}
            />
          </div>

          <div className="flex-1 overflow-hidden">
            {searchValue ? (
              <div className="px-4 pb-4 h-full overflow-y-auto">
                <ResultList items={filteredResults} />
              </div>
            ) : (
              <Dashboard onNavigate={(v) => setView(v)} />
            )}
          </div>
        </>
      )}

      {/* 注册中心的插件 — 统一渲染（含合并后的 AI 助手） */}
      {activePlugin && activePlugin.viewId !== "home" && (
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center text-[var(--color-text-secondary)]">
              加载中...
            </div>
          }
        >
          <PluginErrorBoundary
            pluginId={activePlugin.id}
            onReset={() => setView("main")}
          >
            <div className="h-full">
              {activePlugin.render({
                onBack: () => setView("main"),
                ai: getMToolsAI(),
                storage: new ScopedStorage(activePlugin.id),
              })}
            </div>
          </PluginErrorBoundary>
        </Suspense>
      )}

      {/* 全部功能页 — 特殊处理 */}
      {view === "home" && (
        <Home onNavigate={(v) => setView(v)} onBack={() => setView("main")} />
      )}

      {/* 外部插件嵌入 */}
      {view === "plugin-embed" && embedTarget && embedBridgeToken && (
        <div className="h-full">
          <PluginErrorBoundary
            pluginId={embedTarget.pluginId}
            onReset={() => {
              setView("main");
              setEmbedTarget(null);
            }}
          >
            <PluginEmbed
              pluginId={embedTarget.pluginId}
              featureCode={embedTarget.featureCode}
              bridgeToken={embedBridgeToken}
              title={embedTarget.title}
              onBack={() => {
                setView("main");
                setEmbedTarget(null);
              }}
            />
          </PluginErrorBoundary>
        </div>
      )}

      {/* 上下文操作面板 */}
      {view === "context-action" && (
        <div className="h-full">
          <ContextActionPanel
            selectedText={contextText}
            onBack={() => setView("main")}
          />
        </div>
      )}
    </div>
  );
}

export default App;
