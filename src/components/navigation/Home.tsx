import {
  Bot,
  Database,
  Wrench,
  Settings,
  Puzzle,
  ArrowLeft,
  Pipette,
  Camera,
  QrCode,
  Search,
  FileText,
  Cloud,
  Languages,
  Workflow,
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
      id: "ai-center",
      icon: <Bot className="w-5 h-5" />,
      title: "AI 助手",
      description: "Ask / Agent 双模式对话",
      color: "text-indigo-400 bg-indigo-400/10",
      action: () => onNavigate("ai-center"),
    },
    {
      id: "dev-toolbox",
      icon: <Wrench className="w-5 h-5" />,
      title: "开发工具箱",
      description: "JSON、时间戳、Base64",
      color: "text-yellow-400 bg-yellow-400/10",
      action: () => onNavigate("dev-toolbox"),
    },
    {
      id: "screen-capture",
      icon: <Camera className="w-5 h-5" />,
      title: "截图",
      description: "截图 + OCR / 贴图 / 编辑",
      color: "text-sky-400 bg-sky-400/10",
      action: () => onNavigate("screen-capture"),
    },
    {
      id: "screen-translate",
      icon: <Languages className="w-5 h-5" />,
      title: "翻译",
      description: "屏幕翻译、实时翻译",
      color: "text-teal-400 bg-teal-400/10",
      action: () => onNavigate("screen-translate"),
    },
    {
      id: "note-hub",
      icon: <FileText className="w-5 h-5" />,
      title: "笔记中心",
      description: "速记、AI 笔记、Markdown",
      color: "text-lime-400 bg-lime-400/10",
      action: () => onNavigate("note-hub"),
    },
    {
      id: "workflows",
      icon: <Workflow className="w-5 h-5" />,
      title: "工作流",
      description: "AI 自动化工作流",
      color: "text-amber-400 bg-amber-400/10",
      action: () => onNavigate("workflows"),
    },
    {
      id: "knowledge-base",
      icon: <BookOpen className="w-5 h-5" />,
      title: "知识库",
      description: "文档导入、RAG 检索",
      color: "text-emerald-400 bg-emerald-400/10",
      action: () => onNavigate("knowledge-base"),
    },
    {
      id: "color",
      icon: <Pipette className="w-5 h-5" />,
      title: "颜色",
      description: "屏幕取色、调色板",
      color: "text-pink-400 bg-pink-400/10",
      action: () => onNavigate("color"),
    },
    {
      id: "qr-code",
      icon: <QrCode className="w-5 h-5" />,
      title: "二维码",
      description: "二维码/条形码识别与生成",
      color: "text-violet-400 bg-violet-400/10",
      action: () => onNavigate("qr-code"),
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
      id: "image-search",
      icon: <Search className="w-5 h-5" />,
      title: "以图搜图",
      description: "反向图片搜索 + AI 理解",
      color: "text-indigo-400 bg-indigo-400/10",
      action: () => onNavigate("image-search"),
    },
    {
      id: "cloud-sync",
      icon: <Cloud className="w-5 h-5" />,
      title: "云同步",
      description: "GitHub/Gitee/GitLab/WebDAV",
      color: "text-sky-400 bg-sky-400/10",
      action: () => onNavigate("cloud-sync"),
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
