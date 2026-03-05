import {
  Bot,
  Globe,
  Terminal,
  Database,
  ClipboardList,
  FileText,
  Zap,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { commandRouter } from "./CommandRouter";
import { registry } from "@/core/plugin-system/registry";
import { useAppStore } from "@/store/app-store";
import { usePluginStore } from "@/store/plugin-store";
import { handleError } from "@/core/errors";
import { routeToAICenter } from "@/core/ai/ai-center-routing";

function ensureBuiltinPluginInstalled(
  viewId: string,
  pluginName: string,
  pushView: (viewId: string) => void,
) {
  if (registry.getByViewId(viewId)) {
    pushView(viewId);
    return;
  }
  handleError(new Error(`请先在插件市场安装「${pluginName}」`), {
    context: "插件未安装",
  });
  useAppStore.getState().requestNavigate("plugins");
}

function openMarketPluginBySlug(
  slug: string,
  pluginName: string,
  pushView: (viewId: string) => void,
) {
  // 迁移插件安装后优先走内置成熟实现（与历史功能保持一致）
  if (registry.getByViewId(slug)) {
    pushView(slug);
    return;
  }

  const { plugins, openPlugin } = usePluginStore.getState();
  const target = plugins.find(
    (plugin) => plugin.enabled && plugin.slug?.toLowerCase() === slug.toLowerCase(),
  );
  const feature = target?.manifest.features?.[0];
  if (target && feature) {
    openPlugin(target.id, feature.code);
    return;
  }
  ensureBuiltinPluginInstalled(slug, pluginName, pushView);
}

commandRouter.register({
  prefix: "ai",
  name: "AI 对话",
  handle: (query, ctx) => [{
    id: "ai-enter",
    title: `问 AI：${query}`,
    description: "按 Enter 开始对话",
    icon: <Bot className="w-6 h-6" />,
    color: "text-indigo-500 bg-indigo-500/10",
    category: "AI",
    action: () => {
      routeToAICenter({
        mode: "ask",
        source: "command_palette_ai",
        query,
        pushView: ctx.pushView,
      });
    },
  }],
});

commandRouter.register({
  prefix: "bd",
  name: "百度搜索",
  handle: (query) => [{
    id: "baidu-search",
    title: `百度：${query}`,
    description: "https://www.baidu.com",
    icon: <Globe className="w-6 h-6" />,
    color: "text-blue-500 bg-blue-500/10",
    category: "搜索",
    action: () => invoke("open_url", { url: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}` }),
  }],
});

commandRouter.register({
  prefix: "gg",
  name: "Google 搜索",
  handle: (query) => [{
    id: "google-search",
    title: `Google：${query}`,
    description: "https://www.google.com",
    icon: <Globe className="w-6 h-6" />,
    color: "text-green-500 bg-green-500/10",
    category: "搜索",
    action: () => invoke("open_url", { url: `https://www.google.com/search?q=${encodeURIComponent(query)}` }),
  }],
});

commandRouter.register({
  prefix: "bing",
  name: "必应搜索",
  handle: (query) => [{
    id: "bing-search",
    title: `必应：${query}`,
    description: "https://www.bing.com",
    icon: <Globe className="w-6 h-6" />,
    color: "text-teal-500 bg-teal-500/10",
    category: "搜索",
    action: () => invoke("open_url", { url: `https://www.bing.com/search?q=${encodeURIComponent(query)}` }),
  }],
});

commandRouter.register({
  prefix: "/",
  name: "Shell 命令",
  handle: (cmd, ctx) => [{
    id: "shell-enter",
    title: `Shell：${cmd || "..."}`,
    description: "AI Agent 执行 shell 命令并返回结果",
    icon: <Terminal className="w-6 h-6" />,
    color: "text-orange-500 bg-orange-500/10",
    category: "Agent",
    action: () => {
      if (cmd.trim()) {
        routeToAICenter({
          mode: "agent",
          source: "command_palette_shell",
          agentInitialQuery: `请执行以下 shell 命令并解释结果：\`${cmd.trim()}\``,
          pushView: ctx.pushView,
        });
      }
    },
  }],
});

commandRouter.register({
  prefix: "cb",
  name: "剪贴板历史",
  handle: (keyword, ctx) => [{
    id: "clipboard-history-enter",
    title: keyword ? `剪贴板搜索：${keyword}` : "打开剪贴板历史",
    description: "查看和搜索剪贴板记录",
    icon: <ClipboardList className="w-6 h-6" />,
    color: "text-cyan-500 bg-cyan-500/10",
    category: "工具",
    action: () => ctx.pushView("clipboard-history"),
  }],
});

commandRouter.register({
  prefix: "data",
  name: "数据工坊",
  handle: (query, ctx) => [{
    id: "data-forge-enter",
    title: `数据工坊：${query || "打开"}`,
    description: "搜索数据脚本或用 AI 描述数据需求",
    icon: <Database className="w-6 h-6" />,
    color: "text-purple-500 bg-purple-500/10",
    category: "数据",
    action: () => ctx.pushView("data-forge"),
  }],
});

commandRouter.register({
  prefix: "sys",
  name: "系统操作",
  handle: (keyword, ctx) => [{
    id: "system-actions-enter",
    title: keyword ? `系统操作：${keyword}` : "打开系统操作",
    description: "执行常用系统动作",
    icon: <Zap className="w-6 h-6" />,
    color: "text-amber-500 bg-amber-500/10",
    category: "工具",
    action: () => openMarketPluginBySlug("system-actions", "系统操作", ctx.pushView),
  }],
});

commandRouter.register({
  prefix: "sn",
  name: "快捷短语",
  handle: (keyword, ctx) => [{
    id: "snippets-enter",
    title: keyword ? `搜索短语：${keyword}` : "打开快捷短语",
    description: "管理和使用文本片段",
    icon: <FileText className="w-6 h-6" />,
    color: "text-emerald-500 bg-emerald-500/10",
    category: "工具",
    action: () => openMarketPluginBySlug("snippets", "快捷短语", ctx.pushView),
  }],
});

commandRouter.register({
  prefix: "bk",
  name: "网页书签",
  handle: (keyword, ctx) => [{
    id: "bookmarks-enter",
    title: keyword ? `搜索书签：${keyword}` : "打开网页书签",
    description: "管理和搜索收藏的网页",
    icon: <Globe className="w-6 h-6" />,
    color: "text-blue-500 bg-blue-500/10",
    category: "工具",
    action: () => openMarketPluginBySlug("bookmarks", "网页书签", ctx.pushView),
  }],
});

export function registerCommands(): void {
  // Side-effect: all handlers are registered on import via the top-level calls above.
  // This function exists to ensure the module is imported.
}
