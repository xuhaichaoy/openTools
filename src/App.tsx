import { useState, useCallback, useEffect } from "react";
import { SearchBar } from "@/components/search/SearchBar";
import { ResultList, type ResultItem } from "@/components/search/ResultList";
import { ChatView } from "@/components/ai/ChatView";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { DataForgeLayout } from "@/components/data-forge/DataForgeLayout";
import { JsonFormatter } from "@/components/tools/JsonFormatter";
import { TimestampConverter } from "@/components/tools/TimestampConverter";
import { Base64Tool } from "@/components/tools/Base64Tool";
import { ContextActionPanel } from "@/components/ai/ContextActionPanel";
import { Home } from "@/components/navigation/Home";
import { Dashboard } from "@/components/home/Dashboard";
import { KnowledgeBase } from "@/components/rag/KnowledgeBase";
import { PluginMarket } from "@/components/plugins/PluginMarket";
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
  | "context-action"
  | "plugins"
  | "knowledge-base";

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
  const { mode, searchValue, setWindowExpanded, reset } = useAppStore();
  const { config } = useAIStore();

  // 启动时加载 AI 配置、对话历史和通用设置
  useEffect(() => {
    useAIStore.getState().loadConfig();
    useAIStore.getState().loadHistory();

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
      id: "knowledge-base",
      title: "知识库",
      description: "本地文档向量检索增强",
      icon: <BookOpen className="w-6 h-6" />,
      color: "text-emerald-500 bg-emerald-500/10",
      category: "AI",
      action: () => setView("knowledge-base"),
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

    // 搜索内置功能（支持拼音匹配）
    return builtinItems
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
  }, [searchValue, config.model]);

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
        <Home
          onNavigate={(v) => setView(v as View)}
          onBack={() => setView("main")}
        />
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
