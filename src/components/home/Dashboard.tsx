import { useAppStore } from "@/store/app-store";
import { registry } from "@/core/plugin-system/registry";
import { Bot, Globe, Terminal } from "lucide-react";

interface DashboardProps {
  onNavigate: (view: string) => void;
}

export function Dashboard({ onNavigate }: DashboardProps) {
  const { setSelectedIndex, setSearchValue } = useAppStore();

  // AI 助手是 Core Shell 组件，不在 registry 中，手动添加为第一项
  const aiEntry = {
    id: "ai-chat",
    icon: <Bot className="w-6 h-6" />,
    title: "AI 助手",
    action: () => onNavigate("chat"),
    color: "text-indigo-500 bg-indigo-500/10",
  };

  // 从 registry 获取所有内置插件作为工具列表
  const registryTools = registry.getAll().map((plugin) => ({
    id: plugin.id,
    icon: plugin.icon,
    title: plugin.name,
    action: () => onNavigate(plugin.viewId),
    color: plugin.color,
  }));

  const tools = [aiEntry, ...registryTools];

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
      id: "bing",
      icon: <Globe className="w-6 h-6" />,
      title: "必应",
      action: () => setSearchValue("bing "),
      color: "text-teal-500 bg-teal-500/10",
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
