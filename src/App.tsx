import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { type ResultItem } from "@/components/search/ResultList";
import { ScreenshotSelector } from "@/components/tools/ScreenshotSelector";
import { LoginModal } from "@/components/auth/LoginModal";
import { SyncManager } from "@/components/auth/SyncManager";
import { MainViewRouter } from "@/components/app/MainViewRouter";
import { useWorkflowStore } from "@/store/workflow-store";
import { usePluginStore } from "@/store/plugin-store";
import { useBookmarkStore } from "@/store/bookmark-store";
import { useAppStore } from "@/store/app-store";
import { useAIStore } from "@/store/ai-store";
import { useAgentStore } from "@/store/agent-store";
import { agentRunnerService } from "@/core/agent/agent-runner-service";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import type {
  AgentScheduledTask,
  AgentTaskSkippedEvent,
  AgentTaskStatusPatch,
} from "@/core/ai/types";
import {
  File,
  Folder,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileCode,
  Archive,
  AppWindow,
  Rocket,
} from "lucide-react";
import {
  PluginsIcon,
  WorkflowsIcon,
  BookmarksIcon,
} from "@/components/icons/animated";

// 插件注册中心
import { registry } from "@/core/plugin-system/registry";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import { ScopedStorage } from "@/core/plugin-system/storage";
import { createPluginContext } from "@/core/plugin-system/context";

// Shell hooks
import { useFileSearch } from "@/shell/useFileSearch";
import { useAppSearch } from "@/shell/useAppSearch";
import { usePluginEmbed } from "@/shell/usePluginEmbed";
import { commandRouter } from "@/shell/CommandRouter";
import "@/shell/commands";
import { useScreenshotHandler } from "@/shell/useScreenshotHandler";
import { formatFileSize } from "@/shell/ResultBuilder";
import { updateWindowSize } from "@/shell/WindowSizeManager";

import { handleError, ErrorLevel } from "@/core/errors";
import { WINDOW_HEIGHT_EXPANDED } from "@/core/constants";
import {
  isBuiltinPluginInstallRequired,
  resolveBuiltinPlugins,
} from "@/plugins/builtin";
import {
  CONTEXT_ACTION_VIEW_ID,
  MAIN_VIEW_ID,
  getTopViewEntry,
  isShellViewId,
} from "@/core/navigation/view-stack";

// 初始化：注册所有内置插件
registry.registerAll(resolveBuiltinPlugins());

// 独立窗口模式检测：截图选区窗口
const specialView = window.__SCREENSHOT_MODE__ ? "screenshot" : null;

type EyeDropperResult = { sRGBHex: string };
type EyeDropperLike = { open: () => Promise<EyeDropperResult> };
type EyeDropperCtor = new () => EyeDropperLike;
type ScreenColorPickResult =
  | { status: "picked"; hex: string }
  | { status: "failed" | "cancelled" };

function getEyeDropperCtor(): EyeDropperCtor | null {
  const ctor = (window as Window & { EyeDropper?: EyeDropperCtor }).EyeDropper;
  return ctor ?? null;
}

function App() {
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
  const view = useAppStore((s) => getTopViewEntry(s.viewStack).viewId);
  const {
    mode,
    searchValue,
    setWindowExpanded,
    resetSearchState,
    pushView,
    popView,
    resetToMain,
  } = useAppStore();
  const runtimePlugins = usePluginStore((s) => s.plugins);

  const [contextText, setContextText] = useState("");

  // ── 提取的 Hooks ──
  const fileResults = useFileSearch(searchValue);
  const appResults = useAppSearch(searchValue);
  const { embedTarget, setEmbedTarget, embedBridgeToken } = usePluginEmbed(
    view,
    pushView,
  );
  useScreenshotHandler(pushView);

  const pickScreenColor = useCallback(async (): Promise<ScreenColorPickResult> => {
    const isWindows = navigator.platform.toLowerCase().includes("win");

    const pickWithEyeDropper = async (): Promise<ScreenColorPickResult> => {
      const ctor = getEyeDropperCtor();
      if (!ctor) return { status: "failed" };
      try {
        const result = await new ctor().open();
        if (result?.sRGBHex) {
          return { status: "picked", hex: result.sRGBHex.toUpperCase() };
        }
      } catch (e) {
        const message = String(e).toLowerCase();
        if (
          message.includes("abort") ||
          message.includes("cancel") ||
          message.includes("denied")
        ) {
          return { status: "cancelled" };
        }
        handleError(e, { context: "取色", silent: true });
      }
      return { status: "failed" };
    };

    const pickWithNative = async (): Promise<ScreenColorPickResult> => {
      try {
        const hex = await invoke<string>("plugin_start_color_picker");
        if (hex) {
          return { status: "picked", hex: hex.toUpperCase() };
        }
        return { status: "cancelled" };
      } catch (e) {
        handleError(e, { context: "取色", silent: true });
        return { status: "failed" };
      }
    };

    if (isWindows) {
      const eyeResult = await pickWithEyeDropper();
      if (eyeResult.status !== "failed") return eyeResult;
      return pickWithNative();
    }

    const nativeResult = await pickWithNative();
    if (nativeResult.status !== "failed") return nativeResult;
    return pickWithEyeDropper();
  }, []);

  const handleDirectColorPicker = useCallback(async () => {
    const result = await pickScreenColor();
    if (result.status === "picked") {
      try {
        await navigator.clipboard.writeText(result.hex);
      } catch {
        // ignore clipboard error
      }
      return;
    }
    if (result.status === "failed") {
      handleError(new Error("当前环境不支持屏幕取色"), { context: "取色" });
    }
  }, [pickScreenColor]);

  // 启动时加载 AI 配置、对话历史、工作流、插件和通用设置
  useEffect(() => {
    let cancelled = false;

    useAIStore
      .getState()
      .loadConfig()
      .then(() => {
        if (!cancelled) useAIStore.getState().loadOwnKeys();
      });
    useAIStore.getState().loadHistory();
    useAgentStore.getState().loadHistory();
    useAgentStore.getState().loadScheduledTasks();
    useWorkflowStore.getState().loadWorkflows();
    usePluginStore.getState().loadPlugins();
    useBookmarkStore.getState().loadBookmarks();

    invoke("workflow_scheduler_start").catch((e) =>
      handleError(e, { context: "定时调度启动", level: ErrorLevel.Warning }),
    );
    invoke("agent_scheduler_start").catch((e) =>
      handleError(e, { context: "Agent 编排调度启动", level: ErrorLevel.Warning }),
    );

    let unlistenScheduled: (() => void) | undefined;
    let unlistenAgentTrigger: (() => void) | undefined;
    let unlistenAgentStatus: (() => void) | undefined;
    let unlistenAgentSkipped: (() => void) | undefined;
    listen<{ workflowId: string; workflowName: string }>(
      "workflow-scheduled-trigger",
      (event) => {
        if (cancelled) return;
        const { workflowId } = event.payload;
        useWorkflowStore.getState().executeWorkflow(workflowId);
      },
    ).then((fn) => {
      unlistenScheduled = fn;
    });
    listen<AgentScheduledTask>("agent-task-trigger", (event) => {
      if (cancelled) return;
      const task = event.payload;
      useAgentStore.getState().upsertScheduledTask(task);
      agentRunnerService.enqueue(task);
    }).then((fn) => {
      unlistenAgentTrigger = fn;
    });
    listen<AgentTaskStatusPatch>("agent-task-status", (event) => {
      if (cancelled) return;
      useAgentStore.getState().applyScheduledTaskPatch(event.payload);
    }).then((fn) => {
      unlistenAgentStatus = fn;
    });
    listen<AgentTaskSkippedEvent>("agent-task-skipped", (event) => {
      if (cancelled) return;
      useAgentStore.getState().applyScheduledTaskSkipped(event.payload);
    }).then((fn) => {
      unlistenAgentSkipped = fn;
    });

    invoke<string>("load_general_settings")
      .then((json) => {
        if (cancelled) return;
        const settings = JSON.parse(json);
        if (settings.theme) {
          document.documentElement.setAttribute("data-theme", settings.theme);
        }
      })
      .catch((e) => handleError(e, { context: "加载通用设置" }));

    return () => {
      cancelled = true;
      unlistenScheduled?.();
      unlistenAgentTrigger?.();
      unlistenAgentStatus?.();
      unlistenAgentSkipped?.();
    };
  }, []);

  const installedOfficialBuiltinPluginIds = useMemo(() => {
    const ids = new Set<string>();
    runtimePlugins.forEach((plugin) => {
      const slug = plugin.slug?.toLowerCase();
      if (!plugin.enabled || !slug) return;
      if (plugin.source !== "official") return;
      if (!isBuiltinPluginInstallRequired(slug)) return;
      ids.add(slug);
    });
    return Array.from(ids).sort();
  }, [runtimePlugins]);

  useEffect(() => {
    registry.registerAll(
      resolveBuiltinPlugins(installedOfficialBuiltinPluginIds),
    );
  }, [installedOfficialBuiltinPluginIds]);

  // 监听 app-store 导航请求
  const pendingNavigate = useAppStore((s) => s.pendingNavigate);
  useEffect(() => {
    if (pendingNavigate) {
      const viewId = useAppStore.getState().consumeNavigate();
      if (viewId) {
        pushView(viewId);
      }
    }
  }, [pendingNavigate, pushView]);

  // 监听 Rust 发来的上下文操作事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ text: string }>("context-action", (event) => {
      setContextText(event.payload.text);
      pushView(CONTEXT_ACTION_VIEW_ID);
      invoke("resize_window", { height: WINDOW_HEIGHT_EXPANDED });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [pushView]);

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
        const allActions = registry.getAllActions();
        const found = allActions.find(
          (a) => a.pluginId === pluginId && a.action.name === actionName,
        );
        if (!found) {
          throw new Error(`找不到插件动作: ${pluginId}/${actionName}`);
        }
        let parsedParams: Record<string, unknown> = {};
        try {
          parsedParams = JSON.parse(params);
        } catch (e) {
          handleError(e, { context: "解析工作流参数", silent: true });
        }
        const result = await found.action.execute(parsedParams, {
          ai: getMToolsAI(),
        });
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

  // 插件窗口 BroadcastChannel 取色
  useEffect(() => {
    const CH = "mtools-screen-pick";
    const bc = new BroadcastChannel(CH);
    bc.onmessage = async (e) => {
      if (e.data?.type !== "request-screen-pick") return;
      const result = await pickScreenColor();
      if (result.status === "picked") {
        bc.postMessage({ type: "screen-color-picked", color: result.hex });
      }
    };
    return () => bc.close();
  }, [pickScreenColor]);

  // ── 文件搜索结果 → ResultItem 转换 ──
  const getFileIcon = useCallback((fileType: string) => {
    switch (fileType) {
      case "folder":
        return <Folder className="w-6 h-6" />;
      case "image":
        return <FileImage className="w-6 h-6" />;
      case "video":
        return <FileVideo className="w-6 h-6" />;
      case "audio":
        return <FileAudio className="w-6 h-6" />;
      case "code":
        return <FileCode className="w-6 h-6" />;
      case "text":
      case "document":
        return <FileText className="w-6 h-6" />;
      case "archive":
        return <Archive className="w-6 h-6" />;
      case "executable":
        return <AppWindow className="w-6 h-6" />;
      default:
        return <File className="w-6 h-6" />;
    }
  }, []);

  const getFileColor = useCallback((fileType: string) => {
    switch (fileType) {
      case "folder":
        return "text-yellow-500 bg-yellow-500/10";
      case "image":
        return "text-pink-500 bg-pink-500/10";
      case "video":
        return "text-red-500 bg-red-500/10";
      case "audio":
        return "text-purple-500 bg-purple-500/10";
      case "code":
        return "text-green-500 bg-green-500/10";
      case "text":
      case "document":
        return "text-blue-500 bg-blue-500/10";
      case "archive":
        return "text-amber-500 bg-amber-500/10";
      case "executable":
        return "text-gray-500 bg-gray-500/10";
      default:
        return "text-slate-500 bg-slate-500/10";
    }
  }, []);

  const fileResultToItem = useCallback(
    (f: {
      name: string;
      path: string;
      is_dir: boolean;
      size: number;
      modified: string | null;
      file_type: string;
    }): ResultItem => {
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
    },
    [getFileIcon, getFileColor],
  );

  // ── 统一搜索 ──
  const commandCtx = useMemo(() => ({ pushView }), [pushView]);

  const getFilteredResults = useCallback((): ResultItem[] => {
    if (!searchValue) return [];

    // 1) 前缀命令：通过 CommandRouter 分发
    const cmdResults = commandRouter.match(searchValue, commandCtx);
    if (cmdResults !== null) return cmdResults;

    // 2) 文件搜索（特殊前缀，需要 hook 数据）
    if (searchValue.startsWith("f ")) {
      return fileResults.map(fileResultToItem);
    }

    // 3) 应用搜索（特殊前缀，需要 hook 数据）
    if (searchValue.startsWith("app ")) {
      return appResults.map((a) => ({
        id: `app-${a.path}`,
        title: a.name,
        description: a.path,
        icon: <Rocket className="w-6 h-6" />,
        color: "text-green-500 bg-green-500/10",
        category: "应用",
        action: () => {
          invoke("file_open", { path: a.path });
        },
      }));
    }

    // 4) 搜索工作流
    const workflowStore = useWorkflowStore.getState();
    const matchedWorkflow = workflowStore.matchByKeyword(searchValue);
    if (matchedWorkflow) {
      return [
        {
          id: `wf-${matchedWorkflow.id}`,
          title: `${matchedWorkflow.icon} 运行: ${matchedWorkflow.name}`,
          description: matchedWorkflow.description,
          icon: <WorkflowsIcon className="w-6 h-6" />,
          color: "text-teal-500 bg-teal-500/10",
          category: "工作流",
          action: () => {
            workflowStore.executeWorkflow(matchedWorkflow.id);
            pushView("workflows");
          },
        },
      ];
    }

    // 5) 搜索内置插件
    const builtinResults: ResultItem[] = registry
      .search(searchValue)
      .map(({ plugin }) => ({
        id: plugin.id,
        title: plugin.name,
        description: plugin.description,
        icon: plugin.icon,
        color: plugin.color,
        category: plugin.category,
        action: () => pushView(plugin.viewId),
      }));

    // 6) 搜索外部插件
    const pluginMatches = usePluginStore
      .getState()
      .matchInput(searchValue)
      .filter((pr) => {
        const slug = pr.plugin.slug?.toLowerCase();
        if (
          pr.plugin.source === "official" &&
          slug &&
          isBuiltinPluginInstallRequired(slug) &&
          registry.getByViewId(slug)
        ) {
          return false;
        }
        return true;
      });
    const BUILTIN_COLOR_PICKER = "color-picker";
    const BUILTIN_SCREEN_CAPTURE = "screen-capture";
    const pluginResults: ResultItem[] = pluginMatches.map((pr) => {
      const code = pr.feature.code;
      const isColorPicker = code === BUILTIN_COLOR_PICKER;
      const isScreenCapture = code === BUILTIN_SCREEN_CAPTURE;
      const slug = pr.plugin.slug?.toLowerCase();
      const openBuiltin = () => {
        if (
          slug &&
          isBuiltinPluginInstallRequired(slug) &&
          registry.getByViewId(slug)
        ) {
          pushView(slug);
          return true;
        }
        return false;
      };
      return {
        id: `plugin-${pr.plugin.id}-${code}`,
        title: pr.plugin.manifest.pluginName,
        description: pr.feature.explain,
        icon: <PluginsIcon className="w-6 h-6" />,
        color: "text-orange-500 bg-orange-500/10",
        category: "插件",
        action: isColorPicker
          ? handleDirectColorPicker
          : isScreenCapture
            ? () => pushView("screen-capture")
            : () => {
                if (openBuiltin()) return;
                usePluginStore.getState().openPlugin(pr.plugin.id, code);
              },
      };
    });

    // 7) 本地应用混排
    const appItems: ResultItem[] = appResults.map((a) => ({
      id: `app-${a.path}`,
      title: a.name,
      description: a.path,
      icon: <Rocket className="w-6 h-6" />,
      color: "text-green-500 bg-green-500/10",
      category: "应用",
      action: () => {
        invoke("file_open", { path: a.path });
      },
    }));

    const fileItems: ResultItem[] = fileResults.map(fileResultToItem);

    // 8) 书签搜索混排
    const bmStore = useBookmarkStore.getState();
    const bookmarkPluginInstalled = Boolean(registry.getByViewId("bookmarks"));
    const bmMatches =
      bookmarkPluginInstalled && searchValue.length >= 2
        ? bmStore.searchBookmarks(searchValue).slice(0, 6)
        : [];
    const bookmarkItems: ResultItem[] = bmMatches.map((bm) => ({
      id: `bm-${bm.id}`,
      title: bm.title,
      description: bm.url,
      icon: <BookmarksIcon className="w-6 h-6" />,
      color: "text-blue-500 bg-blue-500/10",
      category: "书签",
      action: () => {
        bmStore.markVisited(bm.id);
        invoke("open_url", { url: bm.url });
      },
    }));

    return [
      ...appItems,
      ...builtinResults,
      ...pluginResults,
      ...fileItems,
      ...bookmarkItems,
    ];
  }, [
    searchValue,
    commandCtx,
    handleDirectColorPicker,
    fileResults,
    appResults,
    fileResultToItem,
    pushView,
  ]);

  // 窗口大小管理
  useEffect(() => {
    updateWindowSize(view, searchValue, getFilteredResults, setWindowExpanded);
  }, [view, mode, searchValue, getFilteredResults, setWindowExpanded]);

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
          pushView("ai-center");
        }
        return;
      }

      if (value.startsWith("/ ")) {
        const cmd = value.slice(2).trim();
        if (cmd) {
          useAIStore
            .getState()
            .sendMessage(`请执行以下 shell 命令并解释结果：\`${cmd}\``);
        }
        useAppStore.getState().setAiInitialMode("agent");
        pushView("ai-center");
        return;
      }

      const results = getFilteredResults();
      const { selectedIndex } = useAppStore.getState();
      if (results[selectedIndex]?.action) {
        results[selectedIndex].action!();
      }
    },
    [getFilteredResults, pushView],
  );

  // ESC 返回上一级
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && view !== MAIN_VIEW_ID) {
        popView();
        resetSearchState();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, popView, resetSearchState]);

  const filteredResults = getFilteredResults();

  // 当前激活的插件
  const activePlugin = registry.getByViewId(view);
  const prevPluginRef = useRef<typeof activePlugin>(null);

  useEffect(() => {
    if (!activePlugin && !isShellViewId(view)) {
      resetToMain();
    }
  }, [activePlugin, view, resetToMain]);

  const pluginContext = useMemo(
    () =>
      activePlugin
        ? createPluginContext(getMToolsAI(), new ScopedStorage(activePlugin.id))
        : null,
    [activePlugin],
  );

  // 插件生命周期钩子
  useEffect(() => {
    const prevPlugin = prevPluginRef.current;
    if (prevPlugin && prevPlugin !== activePlugin) {
      prevPlugin.onDeactivate?.();
    }
    if (activePlugin && activePlugin !== prevPlugin && pluginContext) {
      activePlugin.onActivate?.(pluginContext);
    }
    prevPluginRef.current = activePlugin;
  }, [activePlugin, pluginContext]);

  return (
    <div className="w-full h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl">
      <MainViewRouter
        view={view}
        searchValue={searchValue}
        filteredResults={filteredResults}
        handleSubmit={handleSubmit}
        pushView={pushView}
        popView={popView}
        resetToMain={resetToMain}
        activePlugin={activePlugin}
        pluginContext={pluginContext}
        embedTarget={embedTarget}
        setEmbedTarget={setEmbedTarget}
        embedBridgeToken={embedBridgeToken}
        contextText={contextText}
      />

      <LoginModal />
      <SyncManager />
    </div>
  );
}

export default App;
