import {
  Bot,
  Globe,
  Terminal,
  Database,
  ClipboardList,
  FileText,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAIStore } from "@/store/ai-store";
import { commandRouter } from "./CommandRouter";
import type { ResultItem } from "@/components/search/ResultList";

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
      useAIStore.getState().sendMessage(query);
      ctx.pushView("ai-center");
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
        useAIStore.getState().sendMessage(`请执行以下 shell 命令并解释结果：\`${cmd.trim()}\``);
        ctx.pushView("ai-center");
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
  prefix: "sn",
  name: "快捷短语",
  handle: (keyword, ctx) => [{
    id: "snippets-enter",
    title: keyword ? `搜索短语：${keyword}` : "打开快捷短语",
    description: "管理和使用文本片段",
    icon: <FileText className="w-6 h-6" />,
    color: "text-emerald-500 bg-emerald-500/10",
    category: "工具",
    action: () => ctx.pushView("snippets"),
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
    action: () => ctx.pushView("bookmarks"),
  }],
});

export function registerCommands(): void {
  // Side-effect: all handlers are registered on import via the top-level calls above.
  // This function exists to ensure the module is imported.
}
