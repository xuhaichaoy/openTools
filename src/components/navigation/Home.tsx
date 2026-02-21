import { ArrowLeft } from "lucide-react";
import {
  AiCenterIcon,
  DataForgeIcon,
  DevToolboxIcon,
  ManagementCenterIcon,
  PluginsIcon,
  ColorIcon,
  ScreenCaptureIcon,
  QrCodeIcon,
  ImageSearchIcon,
  NoteHubIcon,
  CloudSyncIcon,
  ScreenTranslateIcon,
  WorkflowsIcon,
  KnowledgeBaseIcon,
  SnippetsIcon,
  BookmarksIcon,
  SystemActionsIcon,
} from "@/components/icons/animated";
import { useDragWindow } from "@/hooks/useDragWindow";
import { registry } from "@/core/plugin-system/registry";
import { usePluginStore } from "@/store/plugin-store";
import { isBuiltinPluginInstallRequired } from "@/plugins/builtin";

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
  const { plugins } = usePluginStore();
  const installedOfficialSlugSet = new Set(
    plugins
      .filter((plugin) => plugin.enabled && plugin.source === "official")
      .map((plugin) => plugin.slug?.toLowerCase())
      .filter(Boolean) as string[],
  );
  const hasTool = (viewId: string) => {
    if (!isBuiltinPluginInstallRequired(viewId)) return true;
    return (
      installedOfficialSlugSet.has(viewId) &&
      Boolean(registry.getByViewId(viewId))
    );
  };

  const features: FeatureCard[] = [
    {
      id: "ai-center",
      icon: <AiCenterIcon className="w-5 h-5" />,
      title: "AI 助手",
      description: "Ask / Agent 双模式对话",
      color: "text-indigo-400 bg-indigo-400/10",
      action: () => onNavigate("ai-center"),
    },
    ...(hasTool("dev-toolbox")
      ? [
          {
            id: "dev-toolbox",
            icon: <DevToolboxIcon className="w-5 h-5" />,
            title: "开发工具箱",
            description: "JSON、时间戳、Base64",
            color: "text-yellow-400 bg-yellow-400/10",
            action: () => onNavigate("dev-toolbox"),
          },
        ]
      : []),
    {
      id: "screen-capture",
      icon: <ScreenCaptureIcon className="w-5 h-5" />,
      title: "截图",
      description: "截图 + OCR / 贴图 / 编辑",
      color: "text-sky-400 bg-sky-400/10",
      action: () => onNavigate("screen-capture"),
    },
    {
      id: "screen-translate",
      icon: <ScreenTranslateIcon className="w-5 h-5" />,
      title: "翻译",
      description: "屏幕翻译、实时翻译",
      color: "text-teal-400 bg-teal-400/10",
      action: () => onNavigate("screen-translate"),
    },
    ...(hasTool("note-hub")
      ? [
          {
            id: "note-hub",
            icon: <NoteHubIcon className="w-5 h-5" />,
            title: "笔记中心",
            description: "速记、AI 笔记、Markdown",
            color: "text-lime-400 bg-lime-400/10",
            action: () => onNavigate("note-hub"),
          },
        ]
      : []),
    {
      id: "workflows",
      icon: <WorkflowsIcon className="w-5 h-5" />,
      title: "工作流",
      description: "AI 自动化工作流",
      color: "text-amber-400 bg-amber-400/10",
      action: () => onNavigate("workflows"),
    },
    {
      id: "knowledge-base",
      icon: <KnowledgeBaseIcon className="w-5 h-5" />,
      title: "知识库",
      description: "文档导入、RAG 检索",
      color: "text-emerald-400 bg-emerald-400/10",
      action: () => onNavigate("knowledge-base"),
    },
    {
      id: "color",
      icon: <ColorIcon className="w-5 h-5" />,
      title: "颜色",
      description: "屏幕取色、调色板",
      color: "text-pink-400 bg-pink-400/10",
      action: () => onNavigate("color"),
    },
    ...(hasTool("qr-code")
      ? [
          {
            id: "qr-code",
            icon: <QrCodeIcon className="w-5 h-5" />,
            title: "二维码",
            description: "二维码/条形码识别与生成",
            color: "text-violet-400 bg-violet-400/10",
            action: () => onNavigate("qr-code"),
          },
        ]
      : []),
    {
      id: "data-forge",
      icon: <DataForgeIcon className="w-5 h-5" />,
      title: "数据工坊",
      description: "AI 驱动的数据导入导出",
      color: "text-purple-400 bg-purple-400/10",
      action: () => onNavigate("data-forge"),
    },
    ...(hasTool("image-search")
      ? [
          {
            id: "image-search",
            icon: <ImageSearchIcon className="w-5 h-5" />,
            title: "以图搜图",
            description: "反向图片搜索 + AI 理解",
            color: "text-indigo-400 bg-indigo-400/10",
            action: () => onNavigate("image-search"),
          },
        ]
      : []),
    ...(hasTool("system-actions")
      ? [
          {
            id: "system-actions",
            icon: <SystemActionsIcon className="w-5 h-5" />,
            title: "系统操作",
            description: "常用系统动作与快捷执行",
            color: "text-amber-400 bg-amber-400/10",
            action: () => onNavigate("system-actions"),
          },
        ]
      : []),
    ...(hasTool("snippets")
      ? [
          {
            id: "snippets",
            icon: <SnippetsIcon className="w-5 h-5" />,
            title: "快捷短语",
            description: "文本片段管理与快速插入",
            color: "text-emerald-400 bg-emerald-400/10",
            action: () => onNavigate("snippets"),
          },
        ]
      : []),
    ...(hasTool("bookmarks")
      ? [
          {
            id: "bookmarks",
            icon: <BookmarksIcon className="w-5 h-5" />,
            title: "网页书签",
            description: "收藏管理与快速检索",
            color: "text-blue-400 bg-blue-400/10",
            action: () => onNavigate("bookmarks"),
          },
        ]
      : []),
    {
      id: "cloud-sync",
      icon: <CloudSyncIcon className="w-5 h-5" />,
      title: "云同步",
      description: "GitHub/Gitee/GitLab/WebDAV",
      color: "text-sky-400 bg-sky-400/10",
      action: () => onNavigate("cloud-sync"),
    },
    {
      id: "plugins",
      icon: <PluginsIcon className="w-5 h-5" />,
      title: "插件",
      description: "兼容 uTools / Rubick 插件",
      color: "text-orange-400 bg-orange-400/10",
      action: () => onNavigate("plugins"),
    },
    {
      id: "management-center",
      icon: <ManagementCenterIcon className="w-5 h-5" />,
      title: "管理中心",
      description: "账号、设置、AI 模型、数据同步",
      color: "text-gray-400 bg-gray-400/10",
      action: () => onNavigate("management-center"),
    },
  ];

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* 顶部 */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
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
