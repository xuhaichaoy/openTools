import { ArrowLeft, Database, Terminal } from "lucide-react";
import {
  BookmarksIcon,
  ClipboardHistoryIcon,
  ColorIcon,
  DataForgeIcon,
  DevToolboxIcon,
  ImageSearchIcon,
  ManagementCenterIcon,
  NoteHubIcon,
  OcrIcon,
  PluginsIcon,
  QrCodeIcon,
  ScreenTranslateIcon,
  SnippetsIcon,
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

interface FeatureGroup {
  id: string;
  title: string;
  description: string;
  features: FeatureCard[];
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
    const exists = Boolean(registry.getByViewId(viewId));
    if (!exists) return false;
    if (!isBuiltinPluginInstallRequired(viewId)) return true;
    return installedOfficialSlugSet.has(viewId);
  };

  const feature = (
    id: string,
    icon: React.ReactNode,
    title: string,
    description: string,
    color: string,
  ): FeatureCard | null => {
    if (!hasTool(id)) return null;
    return {
      id,
      icon,
      title,
      description,
      color,
      action: () => onNavigate(id),
    };
  };

  const groups: FeatureGroup[] = [
    {
      id: "image",
      title: "图片与文本",
      description: "承接外部截图、图片识别与轻处理",
      features: [
        feature(
          "ocr",
          <OcrIcon className="w-5 h-5" />,
          "图片 OCR",
          "粘贴或上传图片识别文字",
          "text-amber-400 bg-amber-400/10",
        ),
        feature(
          "screen-translate",
          <ScreenTranslateIcon className="w-5 h-5" />,
          "翻译",
          "文本翻译与多语言转换",
          "text-pink-400 bg-pink-400/10",
        ),
        feature(
          "image-search",
          <ImageSearchIcon className="w-5 h-5" />,
          "以图搜图",
          "反向搜图与 AI 理解",
          "text-indigo-400 bg-indigo-400/10",
        ),
        feature(
          "color",
          <ColorIcon className="w-5 h-5" />,
          "颜色",
          "取色、HEX/RGB/HSL 转换",
          "text-rose-400 bg-rose-400/10",
        ),
        feature(
          "qr-code",
          <QrCodeIcon className="w-5 h-5" />,
          "二维码",
          "识别与生成二维码/条形码",
          "text-violet-400 bg-violet-400/10",
        ),
      ].filter((item): item is FeatureCard => item != null),
    },
    {
      id: "efficiency",
      title: "效率工具",
      description: "辅助输入、整理和日常信息复用",
      features: [
        feature(
          "clipboard-history",
          <ClipboardHistoryIcon className="w-5 h-5" />,
          "剪贴板",
          "历史记录搜索与复用",
          "text-cyan-400 bg-cyan-400/10",
        ),
        feature(
          "note-hub",
          <NoteHubIcon className="w-5 h-5" />,
          "笔记中心",
          "速记、AI 笔记、Markdown",
          "text-lime-400 bg-lime-400/10",
        ),
        feature(
          "snippets",
          <SnippetsIcon className="w-5 h-5" />,
          "快捷短语",
          "片段管理与快速插入",
          "text-emerald-400 bg-emerald-400/10",
        ),
        feature(
          "bookmarks",
          <BookmarksIcon className="w-5 h-5" />,
          "网页书签",
          "收藏管理与快速检索",
          "text-blue-400 bg-blue-400/10",
        ),
      ].filter((item): item is FeatureCard => item != null),
    },
    {
      id: "dev",
      title: "开发与数据",
      description: "偏专业的开发辅助和数据处理能力",
      features: [
        feature(
          "dev-toolbox",
          <DevToolboxIcon className="w-5 h-5" />,
          "开发工具箱",
          "JSON、时间戳、Base64",
          "text-yellow-400 bg-yellow-400/10",
        ),
        feature(
          "data-forge",
          <DataForgeIcon className="w-5 h-5" />,
          "数据工坊",
          "AI 驱动的数据导入导出",
          "text-purple-400 bg-purple-400/10",
        ),
        feature(
          "ssh-manager",
          <Terminal className="w-5 h-5" />,
          "SSH 管理",
          "远程连接、终端与 SFTP",
          "text-cyan-400 bg-cyan-400/10",
        ),
        feature(
          "database-client",
          <Database className="w-5 h-5" />,
          "数据库",
          "SQLite / MySQL / PostgreSQL",
          "text-sky-400 bg-sky-400/10",
        ),
      ].filter((item): item is FeatureCard => item != null),
    },
    {
      id: "system",
      title: "系统与扩展",
      description: "插件市场、系统动作和配置入口",
      features: [
        feature(
          "system-actions",
          <SystemActionsIcon className="w-5 h-5" />,
          "系统操作",
          "锁屏、静音、回收站等",
          "text-amber-400 bg-amber-400/10",
        ),
        feature(
          "plugins",
          <PluginsIcon className="w-5 h-5" />,
          "插件",
          "安装与管理扩展能力",
          "text-orange-400 bg-orange-400/10",
        ),
        feature(
          "management-center",
          <ManagementCenterIcon className="w-5 h-5" />,
          "管理中心",
          "账号、模型、同步与设置",
          "text-gray-400 bg-gray-400/10",
        ),
      ].filter((item): item is FeatureCard => item != null),
    },
  ].filter((group) => group.features.length > 0);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
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
        <div>
          <h2 className="text-sm font-medium text-[var(--color-text)]">
            更多工具
          </h2>
          <p className="text-[10px] text-[var(--color-text-secondary)]">
            首页保留核心 AI 能力，这里收纳次级工具
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {groups.map((group) => (
          <section key={group.id}>
            <div className="mb-2 px-1">
              <h3 className="text-xs font-semibold text-[var(--color-text)]">
                {group.title}
              </h3>
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                {group.description}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {group.features.map((feature) => (
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
          </section>
        ))}
      </div>
    </div>
  );
}
