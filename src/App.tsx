import { useState, useCallback, useEffect } from "react";
import { SearchBar } from "@/components/search/SearchBar";
import { ResultList, type ResultItem } from "@/components/search/ResultList";
import { ChatView } from "@/components/ai/ChatView";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { DataForgeLayout } from "@/components/data-forge/DataForgeLayout";
import { JsonFormatter } from "@/components/tools/JsonFormatter";
import { TimestampConverter } from "@/components/tools/TimestampConverter";
import { Base64Tool } from "@/components/tools/Base64Tool";
import { ColorPicker } from "@/components/tools/ColorPicker";
import { ScreenCapture } from "@/components/tools/ScreenCapture";
import { ContextActionPanel } from "@/components/ai/ContextActionPanel";
import { Home } from "@/components/navigation/Home";
import { Dashboard } from "@/components/home/Dashboard";
import { KnowledgeBase } from "@/components/rag/KnowledgeBase";
import { PluginMarket } from "@/components/plugins/PluginMarket";
import { PluginEmbed } from "@/components/plugins/PluginEmbed";
import { WorkflowList } from "@/components/workflows/WorkflowList";
import { useWorkflowStore } from "@/store/workflow-store";
import { usePluginStore } from "@/store/plugin-store";
import { useAppStore } from "@/store/app-store";
import { useAIStore } from "@/store/ai-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { multiFieldPinyinScore } from "@/utils/pinyin-search";
import {
  Bot,
  Settings,
  Wrench,
  Clock,
  Hash,
  Globe,
  Database,
  Languages,
  LayoutGrid,
  Puzzle,
  BookOpen,
  Terminal,
  Workflow,
  Pipette,
  Camera,
} from "lucide-react";

type View =
  | "main"
  | "home"
  | "chat"
  | "settings"
  | "data-forge"
  | "json"
  | "timestamp"
  | "base64"
  | "color"
  | "screen-capture"
  | "plugin-embed"
  | "context-action"
  | "plugins"
  | "knowledge-base"
  | "workflows";

// 窗口尺寸常量
const WINDOW_HEIGHT_COLLAPSED = 60;
const WINDOW_HEIGHT_EXPANDED = 520;
const WINDOW_HEIGHT_CHAT = 640;
const WINDOW_HEIGHT_MAX = 460;
const RESULT_ITEM_HEIGHT = 56;

// 对话/历史限制
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 100;

function App() {
  const [view, setView] = useState<View>("main");
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

  // iframe 嵌入插件：子页通过 postMessage 请求 invoke，主窗口代为调用并回传结果
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== "mtools-embed-invoke" || !e.source) return;
      const id = d.id as string;
      const cmd = d.cmd as string;
      const args = (d.args as Record<string, unknown>) ?? {};
      const source = e.source as Window;
      const send = (result: unknown, error?: string) => {
        try {
          source.postMessage(
            { type: "mtools-embed-result", id, result: error === undefined ? result : undefined, error },
            "*"
          );
        } catch (_) {}
      };
      try {
        const result = await invoke(cmd, args);
        send(result);
      } catch (err) {
        send(undefined, String(err));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // 内置功能列表
  const builtinItems: ResultItem[] = [
    {
      id: "ai-chat",
      title: "AI 助手",
      description: config.model
        ? `使用 ${config.model} 对话`
        : "配置 API Key 后可用",
      icon: <Bot className="w-6 h-6" />,
      color: "text-indigo-500 bg-indigo-500/10",
      category: "AI",
      action: () => setView("chat"),
    },
    {
      id: "data-forge",
      title: "数据工坊",
      description: "AI 驱动的数据导入导出平台",
      icon: <Database className="w-6 h-6" />,
      color: "text-purple-500 bg-purple-500/10",
      category: "核心",
      action: () => setView("data-forge"),
    },
    {
      id: "settings",
      title: "设置",
      description: "AI 模型配置、快捷键、通用设置",
      icon: <Settings className="w-6 h-6" />,
      color: "text-gray-500 bg-gray-500/10",
      category: "系统",
      action: () => setView("settings"),
    },
    {
      id: "json-formatter",
      title: "JSON",
      description: "JSON 格式化、校验、压缩",
      icon: <Hash className="w-6 h-6" />,
      color: "text-yellow-500 bg-yellow-500/10",
      category: "工具",
      action: () => setView("json"),
    },
    {
      id: "timestamp",
      title: "时间戳",
      description: "Unix 时间戳 ⟷ 日期时间",
      icon: <Clock className="w-6 h-6" />,
      color: "text-green-500 bg-green-500/10",
      category: "工具",
      action: () => setView("timestamp"),
    },
    {
      id: "base64",
      title: "Base64",
      description: "Base64 编码 / 解码",
      icon: <Wrench className="w-6 h-6" />,
      color: "text-blue-500 bg-blue-500/10",
      category: "工具",
      action: () => setView("base64"),
    },
    {
      id: "color",
      title: "颜色",
      description: "屏幕取色、调色板、HEX/RGB/HSL",
      icon: <Pipette className="w-6 h-6" />,
      color: "text-pink-500 bg-pink-500/10",
      category: "工具",
      action: () => setView("color"),
    },
    {
      id: "screen-capture",
      title: "截图录屏",
      description: "区域截图、滚动长截图、屏幕录制",
      icon: <Camera className="w-6 h-6" />,
      color: "text-sky-500 bg-sky-500/10",
      category: "工具",
      action: () => setView("screen-capture"),
    },
    {
      id: "knowledge-base",
      title: "知识库",
      description: "本地文档向量检索增强",
      icon: <BookOpen className="w-6 h-6" />,
      color: "text-emerald-500 bg-emerald-500/10",
      category: "AI",
      action: () => setView("knowledge-base"),
    },
    {
      id: "workflows",
      title: "工作流",
      description: "多步骤自动化流程",
      icon: <Workflow className="w-6 h-6" />,
      color: "text-teal-500 bg-teal-500/10",
      category: "AI",
      action: () => setView("workflows"),
    },
    {
      id: "plugins",
      title: "插件",
      description: "兼容 uTools / Rubick 格式",
      icon: <Puzzle className="w-6 h-6" />,
      color: "text-orange-500 bg-orange-500/10",
      category: "系统",
      action: () => setView("plugins"),
    },
    {
      id: "all-features",
      title: "全部功能",
      description: "查看所有可用工具和功能",
      icon: <LayoutGrid className="w-6 h-6" />,
      color: "text-cyan-500 bg-cyan-500/10",
      category: "系统",
      action: () => setView("home"),
    },
  ];

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
    const workflowStore = useWorkflowStore.getState()
    const matchedWorkflow = workflowStore.matchByKeyword(searchValue)
    if (matchedWorkflow) {
      return [{
        id: `wf-${matchedWorkflow.id}`,
        title: `${matchedWorkflow.icon} 运行: ${matchedWorkflow.name}`,
        description: matchedWorkflow.description,
        icon: <Workflow className="w-6 h-6" />,
        color: "text-teal-500 bg-teal-500/10",
        category: "工作流",
        action: () => {
          workflowStore.executeWorkflow(matchedWorkflow.id)
          setView("workflows")
        },
      }]
    }

    // 搜索内置功能（支持拼音匹配）
    const builtinResults = builtinItems
      .map((item) => ({
        item,
        score: multiFieldPinyinScore(
          [item.title, item.description, item.id, item.category || ""],
          searchValue,
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);

    // 搜索插件（关键词/拼音匹配）
    const pluginMatches = usePluginStore.getState().matchInput(searchValue);
    const pluginResults: ResultItem[] = pluginMatches.map((pr) => {
      const isColorPickerPlugin = pr.plugin.manifest.pluginName === "取色器";
      const isScreenCapturePlugin = pr.plugin.manifest.pluginName === "截图录屏";
      return {
        id: `plugin-${pr.plugin.id}-${pr.feature.code}`,
        title: pr.plugin.manifest.pluginName,
        description: isColorPickerPlugin
          ? "直接屏幕取色，结果复制到剪贴板"
          : isScreenCapturePlugin
            ? "区域截图、滚动长截图、屏幕录制"
            : pr.feature.explain,
        icon: <Puzzle className="w-6 h-6" />,
        color: "text-orange-500 bg-orange-500/10",
        category: "插件",
        action: isColorPickerPlugin
          ? handleDirectColorPicker
          : isScreenCapturePlugin
            ? () => setView("screen-capture")
            : () => usePluginStore.getState().openPlugin(pr.plugin.id, pr.feature.code),
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
    (value: string, currentMode: string) => {
      if (currentMode === "ai" || value.startsWith("ai ")) {
        const query = value.startsWith("ai ") ? value.slice(3) : value;
        if (query.trim()) {
          useAIStore.getState().sendMessage(query.trim());
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
              <Dashboard onNavigate={(v) => setView(v as View)} />
            )}
          </div>
        </>
      )}

      {view === "chat" && (
        <div className="h-full">
          <ChatView onBack={() => setView("main")} />
        </div>
      )}

      {view === "data-forge" && (
        <div className="h-full">
          <DataForgeLayout onBack={() => setView("main")} />
        </div>
      )}

      {view === "json" && (
        <div className="h-full">
          <JsonFormatter onBack={() => setView("main")} />
        </div>
      )}

      {view === "timestamp" && (
        <div className="h-full">
          <TimestampConverter onBack={() => setView("main")} />
        </div>
      )}

      {view === "base64" && (
        <div className="h-full">
          <Base64Tool onBack={() => setView("main")} />
        </div>
      )}

      {view === "color" && (
        <div className="h-full">
          <ColorPicker onBack={() => setView("main")} />
        </div>
      )}

      {view === "screen-capture" && (
        <div className="h-full">
          <ScreenCapture onBack={() => setView("main")} />
        </div>
      )}

      {view === "plugin-embed" && embedTarget && (
        <div className="h-full">
          <PluginEmbed
            pluginId={embedTarget.pluginId}
            featureCode={embedTarget.featureCode}
            title={embedTarget.title}
            onBack={() => {
              setView("main");
              setEmbedTarget(null);
            }}
          />
        </div>
      )}

      {view === "context-action" && (
        <div className="h-full">
          <ContextActionPanel
            selectedText={contextText}
            onBack={() => setView("main")}
          />
        </div>
      )}

      {view === "knowledge-base" && (
        <div className="h-full">
          <KnowledgeBase onBack={() => setView("main")} />
        </div>
      )}

      {view === "home" && (
        <Home onNavigate={(v) => setView(v as View)} onBack={() => setView("main")} />
      )}

      {view === "workflows" && (
        <div className="h-full">
          <WorkflowList onBack={() => setView("main")} />
        </div>
      )}

      {view === "plugins" && (
        <div className="h-full">
          <PluginMarket onBack={() => setView("main")} />
        </div>
      )}

      {view === "settings" && <SettingsPage onBack={() => setView("main")} />}
    </div>
  );
}

export default App;
