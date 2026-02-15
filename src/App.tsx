import { useState, useCallback, useEffect, Suspense } from "react";
import { SearchBar } from "@/components/search/SearchBar";
import { ResultList, type ResultItem } from "@/components/search/ResultList";
import { ChatView } from "@/components/ai/ChatView";
import { ScreenshotSelector } from "@/components/tools/ScreenshotSelector";
import { ContextActionPanel } from "@/components/ai/ContextActionPanel";
import { Home } from "@/components/navigation/Home";
import { Dashboard } from "@/components/home/Dashboard";
import { PluginEmbed } from "@/components/plugins/PluginEmbed";
import { PluginErrorBoundary } from "@/components/plugins/PluginErrorBoundary";
import { useWorkflowStore } from "@/store/workflow-store";
import { usePluginStore } from "@/store/plugin-store";
import { useAppStore } from "@/store/app-store";
import { useAIStore } from "@/store/ai-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bot, Globe, Puzzle, Terminal, Database, Workflow } from "lucide-react";

// 插件注册中心
import { registry } from "@/core/plugin-system/registry";
import { builtinPlugins } from "@/plugins/builtin";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import { ScopedStorage } from "@/core/plugin-system/storage";

// 初始化：注册所有内置插件
registry.registerAll(builtinPlugins);

// 核心壳保留的特殊视图（不走插件注册）
type ShellView = "main" | "chat" | "plugin-embed" | "context-action" | "home";

// 窗口尺寸常量
const WINDOW_HEIGHT_COLLAPSED = 60;
const WINDOW_HEIGHT_EXPANDED = 520;
const WINDOW_HEIGHT_CHAT = 640;
const WINDOW_HEIGHT_MAX = 460;
const RESULT_ITEM_HEIGHT = 56;

// 对话/历史限制
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 100;

// 独立窗口模式检测：截图选区窗口
const specialView = (window as any).__SCREENSHOT_MODE__ ? "screenshot" : null;

function App() {
  // 如果是截图选区窗口，只渲染选区 UI
  if (specialView === "screenshot") {
    return (
      <div className="w-full h-full" style={{ background: "#000" }}>
        <ScreenshotSelector />
      </div>
    );
  }

  // view 可以是 ShellView 或任意插件的 viewId
  const [view, setView] = useState<string>("main");
  const [contextText, setContextText] = useState("");
  const [embedTarget, setEmbedTarget] = useState<{
    pluginId: string;
    featureCode: string;
    title?: string;
  } | null>(null);
  const { mode, searchValue, setWindowExpanded, reset } = useAppStore();
  const { config } = useAIStore();

  const handleDirectColorPicker = useCallback(async () => {
    try {
      await invoke<string>("plugin_start_color_picker");
    } catch (e) {
      console.error("取色失败:", e);
    }
  }, []);

  // 启动时加载 AI 配置、对话历史、工作流、插件和通用设置
  useEffect(() => {
    useAIStore.getState().loadConfig();
    useAIStore.getState().loadHistory();
    useWorkflowStore.getState().loadWorkflows();
    usePluginStore.getState().loadPlugins();

    // 加载主题设置
    invoke<string>("load_general_settings")
      .then((json) => {
        const settings = JSON.parse(json);
        if (settings.theme) {
          document.documentElement.setAttribute("data-theme", settings.theme);
        }
      })
      .catch((e) => console.error("Failed to load settings:", e));
  }, []);

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

      // ── 标准 invoke 桥 ──
      if (d.type === "mtools-embed-invoke") {
        const id = d.id as string;
        const cmd = d.cmd as string;
        const args = (d.args as Record<string, unknown>) ?? {};

        // 安全白名单：只允许外部插件调用特定的 Tauri 命令
        const SAFE_COMMANDS = ["open_url", "plugin_start_color_picker"];

        const send = (result: unknown, error?: string) => {
          try {
            source.postMessage(
              {
                type: "mtools-embed-result",
                id,
                result: error === undefined ? result : undefined,
                error,
              },
              "*",
            );
          } catch (_) {}
        };

        if (!SAFE_COMMANDS.includes(cmd)) {
          console.warn(`[Security] Blocked unauthorized invoke: ${cmd}`);
          send(
            undefined,
            `Permission denied: Command '${cmd}' is not allowed.`,
          );
          return;
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
        try {
          const result = await ai.chat({
            messages: d.messages,
            model: d.model,
            temperature: d.temperature,
          });
          source.postMessage(
            { type: "mtools-ai-result", id: d.id, content: result.content },
            "*",
          );
        } catch (err) {
          source.postMessage(
            { type: "mtools-ai-result", id: d.id, error: String(err) },
            "*",
          );
        }
        return;
      }

      // ── AI stream（流式，逐 chunk 推送）──
      if (d.type === "mtools-ai-stream") {
        const ai = getMToolsAI();
        try {
          await ai.stream({
            messages: d.messages,
            onChunk: (chunk) => {
              source.postMessage(
                { type: "mtools-ai-chunk", id: d.id, chunk },
                "*",
              );
            },
            onDone: (content) => {
              source.postMessage(
                { type: "mtools-ai-done", id: d.id, content },
                "*",
              );
            },
          });
        } catch (err) {
          source.postMessage(
            { type: "mtools-ai-error", id: d.id, error: String(err) },
            "*",
          );
        }
        return;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

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
            setView("chat");
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
              setView("chat");
            }
          },
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

    // 搜索工作流 — 关键词匹配触发
    const workflowStore = useWorkflowStore.getState();
    const matchedWorkflow = workflowStore.matchByKeyword(searchValue);
    if (matchedWorkflow) {
      return [
        {
          id: `wf-${matchedWorkflow.id}`,
          title: `${matchedWorkflow.icon} 运行: ${matchedWorkflow.name}`,
          description: matchedWorkflow.description,
          icon: <Workflow className="w-6 h-6" />,
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

    return [...builtinResults, ...pluginResults];
  }, [searchValue, config.model, handleDirectColorPicker]);

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
    } else if (view === "chat") {
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
          setView("chat");
        }
        return;
      }

      // / 前缀 → AI Agent Shell 模式
      if (value.startsWith("/ ")) {
        const cmd = value.slice(2).trim();
        if (cmd) {
          useAIStore
            .getState()
            .sendMessage(`请执行以下 shell 命令并解释结果：\`${cmd}\``);
          setView("chat");
        }
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

      {/* AI 助手 — Core Shell 核心组件 */}
      {view === "chat" && (
        <div className="h-full">
          <ChatView onBack={() => setView("main")} />
        </div>
      )}

      {/* 注册中心的插件 — 统一渲染 */}
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
      {view === "plugin-embed" && embedTarget && (
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
