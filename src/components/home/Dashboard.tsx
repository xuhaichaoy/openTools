import {
  Bot,
  Database,
  Hash,
  Clock,
  Wrench,
  Settings,
  Puzzle,
  BookOpen,
  Terminal,
  Globe,
  Grid,
} from "lucide-react";
import { useAppStore } from "@/store/app-store";

interface DashboardProps {
  onNavigate: (view: string) => void;
}

export function Dashboard({ onNavigate }: DashboardProps) {
  const { setSelectedIndex, setSearchValue } = useAppStore();

  const tools = [
    {
      id: "ai-chat",
      icon: <Bot className="w-6 h-6" />,
      title: "AI 助手",
      action: () => onNavigate("chat"),
      color: "text-indigo-500 bg-indigo-500/10",
    },
    {
      id: "data-forge",
      icon: <Database className="w-6 h-6" />,
      title: "数据工坊",
      action: () => onNavigate("data-forge"),
      color: "text-purple-500 bg-purple-500/10",
    },
    {
      id: "json",
      icon: <Hash className="w-6 h-6" />,
      title: "JSON",
      action: () => onNavigate("json"),
      color: "text-yellow-500 bg-yellow-500/10",
    },
    {
      id: "timestamp",
      icon: <Clock className="w-6 h-6" />,
      title: "时间戳",
      action: () => onNavigate("timestamp"),
      color: "text-green-500 bg-green-500/10",
    },
    {
      id: "base64",
      icon: <Wrench className="w-6 h-6" />,
      title: "Base64",
      action: () => onNavigate("base64"),
      color: "text-blue-500 bg-blue-500/10",
    },
    {
      id: "knowledge-base",
      icon: <BookOpen className="w-6 h-6" />,
      title: "知识库",
      action: () => onNavigate("knowledge-base"),
      color: "text-emerald-500 bg-emerald-500/10",
    },
    {
      id: "plugins",
      icon: <Puzzle className="w-6 h-6" />,
      title: "插件市场",
      action: () => onNavigate("plugins"),
      color: "text-orange-500 bg-orange-500/10",
    },
    {
      id: "settings",
      icon: <Settings className="w-6 h-6" />,
      title: "设置",
      action: () => onNavigate("settings"),
      color: "text-gray-500 bg-gray-500/10",
    },
    {
      id: "all",
      icon: <Grid className="w-6 h-6" />,
      title: "全部",
      action: () => onNavigate("home"),
      color: "text-cyan-500 bg-cyan-500/10",
    },
  ];

  const quickActions = [
    {
      id: "baidu",
      icon: <Globe className="w-6 h-6" />,
      title: "百度一下",
      action: () => setSearchValue("bd "),
      color: "text-blue-500 bg-blue-500/10",
    },
    {
      id: "google",
      icon: <Globe className="w-6 h-6" />,
      title: "Google",
      action: () => setSearchValue("gg "),
      color: "text-green-500 bg-green-500/10",
    },
    {
      id: "shell",
      icon: <Terminal className="w-6 h-6" />,
      title: "终端",
      action: () => setSearchValue("/ "),
      color: "text-orange-500 bg-orange-500/10",
    },
  ];

  return (
    <div className="px-2 py-1 h-full overflow-y-auto custom-scrollbar">
      {/* 常用工具 */}
      <div className="mb-8">
        <h3 className="text-xs font-medium text-[var(--color-text-secondary)] mb-4 px-2">
          常用工具
        </h3>
        <div className="grid grid-cols-8 gap-x-2 gap-y-1 mt-5">
          {tools.map((tool) => (
            <button
              key={tool.id}
              onClick={tool.action}
              className="flex flex-col items-center justify-start gap-3 p-2 rounded-xl hover:bg-[var(--color-bg-hover)] transition-colors group"
            >
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center ${tool.color} shadow-sm`}
              >
                {tool.icon}
              </div>
              <span className="text-[11px] text-[var(--color-text)] font-medium truncate w-full text-center opacity-90 group-hover:opacity-100">
                {tool.title}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 快捷指令 */}
      <div>
        <h3 className="text-xs font-medium text-[var(--color-text-secondary)] mb-4 px-2">
          快捷指令
        </h3>
        <div className="grid grid-cols-8 gap-x-2 gap-y-1 mt-5">
          {quickActions.map((action) => (
            <button
              key={action.id}
              onClick={() => {
                action.action();
                setSelectedIndex(0);
                const input = document.querySelector(
                  'input[type="text"]',
                ) as HTMLInputElement;
                input?.focus();
              }}
              className="flex flex-col items-center justify-start gap-3 p-2 rounded-xl hover:bg-[var(--color-bg-hover)] transition-colors group"
            >
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center ${action.color} shadow-sm`}
              >
                {action.icon}
              </div>
              <span className="text-[11px] text-[var(--color-text)] font-medium truncate w-full text-center opacity-90 group-hover:opacity-100">
                {action.title}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
