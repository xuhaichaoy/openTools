import {
  Bot,
  Database,
  Hash,
  Clock,
  Wrench,
  Settings,
  Puzzle,
  ArrowLeft,
  BookOpen,
} from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";

interface FeatureCard {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  color: string;
  action: () => void;
}

interface HomeProps {
  onNavigate: (view: string) => void;
  onBack: () => void;
}

export function Home({ onNavigate, onBack }: HomeProps) {
  const { onMouseDown } = useDragWindow();
  const features: FeatureCard[] = [
    {
      id: "ai-chat",
      icon: <Bot className="w-5 h-5" />,
      title: "问问 AI",
      description: "对话、Agent、Function Calling",
      color: "text-indigo-400 bg-indigo-400/10",
      action: () => onNavigate("chat"),
    },
    {
      id: "data-forge",
      icon: <Database className="w-5 h-5" />,
      title: "数据工坊",
      description: "AI 驱动的数据导入导出",
      color: "text-purple-400 bg-purple-400/10",
      action: () => onNavigate("data-forge"),
    },
    {
      id: "json",
      icon: <Hash className="w-5 h-5" />,
      title: "JSON 格式化",
      description: "格式化、校验、压缩",
      color: "text-yellow-400 bg-yellow-400/10",
      action: () => onNavigate("json"),
    },
    {
      id: "timestamp",
      icon: <Clock className="w-5 h-5" />,
      title: "时间戳转换",
      description: "Unix 时间戳 ⟷ 日期",
      color: "text-green-400 bg-green-400/10",
      action: () => onNavigate("timestamp"),
    },
    {
      id: "base64",
      icon: <Wrench className="w-5 h-5" />,
      title: "Base64",
      description: "编码 / 解码",
      color: "text-blue-400 bg-blue-400/10",
      action: () => onNavigate("base64"),
    },
    {
      id: "knowledge-base",
      icon: <BookOpen className="w-5 h-5" />,
      title: "知识库",
      description: "文档向量化检索增强",
      color: "text-emerald-400 bg-emerald-400/10",
      action: () => onNavigate("knowledge-base"),
    },
    {
      id: "plugins",
      icon: <Puzzle className="w-5 h-5" />,
      title: "插件",
      description: "兼容 uTools / Rubick 插件",
      color: "text-orange-400 bg-orange-400/10",
      action: () => onNavigate("plugins"),
    },
    {
      id: "settings",
      icon: <Settings className="w-5 h-5" />,
      title: "设置",
      description: "AI 模型、通用配置、凭证",
      color: "text-gray-400 bg-gray-400/10",
      action: () => onNavigate("settings"),
    },
  ];

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* 顶部 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h2 className="text-sm font-medium text-[var(--color-text)]">
          全部功能
        </h2>
      </div>

      {/* 功能网格 */}
      <div className="p-4 grid grid-cols-3 gap-3 max-h-[420px] overflow-y-auto">
        {features.map((feature) => (
          <button
            key={feature.id}
            onClick={feature.action}
            className="flex flex-col items-center gap-2 p-4 rounded-xl bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-all group"
          >
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center ${feature.color} group-hover:scale-110 transition-transform`}
            >
              {feature.icon}
            </div>
            <div className="text-center">
              <div className="text-xs font-medium text-[var(--color-text)]">
                {feature.title}
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                {feature.description}
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* 底部提示 */}
      <div className="text-center py-2 text-[10px] text-[var(--color-text-secondary)] border-t border-[var(--color-border)]">
        在搜索框中输入关键词即可快速访问
      </div>
    </div>
  );
}
