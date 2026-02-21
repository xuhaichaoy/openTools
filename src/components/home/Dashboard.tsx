import { useAppStore } from "@/store/app-store";
import { registry } from "@/core/plugin-system/registry";
import { Globe, Terminal } from "lucide-react";
import {
  PluginsIcon,
  OcrIcon,
  ScreenTranslateIcon,
  AiCenterIcon,
} from "@/components/icons/animated";
import { useMemo } from "react";
import { usePluginStore } from "@/store/plugin-store";
import { isBuiltinPluginInstallRequired } from "@/plugins/builtin";

interface DashboardProps {
  onNavigate: (view: string) => void;
}

export function Dashboard({ onNavigate }: DashboardProps) {
  const { setSelectedIndex, setSearchValue, recentTools, addRecentTool } =
    useAppStore();
  const { plugins, openPlugin } = usePluginStore();

  const allTools = useMemo(() => {
    const builtinTools = registry.getAll().map((plugin) => ({
      id: plugin.id,
      icon: plugin.icon,
      title: plugin.name,
      recentKey: plugin.viewId,
      action: () => {
        addRecentTool(plugin.viewId);
        onNavigate(plugin.viewId);
      },
      color: plugin.color,
    }));

    const externalTools = plugins
      .filter((plugin) => {
        if (
          plugin.isBuiltin ||
          !plugin.enabled ||
          plugin.manifest.features.length === 0
        ) {
          return false;
        }
        const slug = plugin.slug?.toLowerCase();
        if (
          plugin.source === "official" &&
          slug &&
          isBuiltinPluginInstallRequired(slug)
        ) {
          return false;
        }
        return true;
      })
      .map((plugin) => {
        const primaryFeature = plugin.manifest.features[0];
        return {
          id: `ext-${plugin.id}`,
          icon: <PluginsIcon className="w-6 h-6" />,
          title: plugin.manifest.pluginName,
          recentKey: `plugin:${plugin.id}`,
          action: () => {
            addRecentTool(`plugin:${plugin.id}`);
            openPlugin(plugin.id, primaryFeature.code);
          },
          color:
            plugin.source === "official"
              ? "text-orange-500 bg-orange-500/10"
              : "text-cyan-500 bg-cyan-500/10",
        };
      });

    return [...builtinTools, ...externalTools];
  }, [addRecentTool, onNavigate, openPlugin, plugins]);

  // 按最近使用排序：最近使用过的排在前面，其余保持原始顺序
  const tools = useMemo(() => {
    if (recentTools.length === 0) return allTools;
    const recentSet = new Set(recentTools);
    const recent = recentTools
      .map((key) => allTools.find((t) => t.recentKey === key))
      .filter(Boolean) as typeof allTools;
    const rest = allTools.filter((t) => !recentSet.has(t.recentKey));
    return [...recent, ...rest];
  }, [allTools, recentTools]);

  const quickActions = [
    {
      id: "screenshot-ocr",
      icon: <OcrIcon className="w-6 h-6" />,
      title: "截图 OCR",
      action: () => {
        addRecentTool("ocr");
        onNavigate("ocr");
      },
      color: "text-violet-500 bg-violet-500/10",
    },
    {
      id: "screenshot-translate",
      icon: <ScreenTranslateIcon className="w-6 h-6" />,
      title: "截图翻译",
      action: () => {
        addRecentTool("screen-translate");
        onNavigate("screen-translate");
      },
      color: "text-pink-500 bg-pink-500/10",
    },
    {
      id: "ai-chat",
      icon: <AiCenterIcon className="w-6 h-6" />,
      title: "AI 问答",
      action: () => {
        addRecentTool("ai-center");
        onNavigate("ai-center");
      },
      color: "text-indigo-500 bg-indigo-500/10",
    },
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

  const hasRecent = recentTools.length > 0;

  return (
    <div className="px-2 py-1 h-full overflow-y-auto custom-scrollbar">
      {/* 常用工具（按最近使用排序） */}
      <div className="mb-4">
        <h3 className="text-xs font-medium text-[var(--color-text-secondary)] mb-2 px-2">
          {hasRecent ? "最近使用" : "常用工具"}
        </h3>
        <div className="grid grid-cols-8 gap-x-2 gap-y-1 mt-2">
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
        <h3 className="text-xs font-medium text-[var(--color-text-secondary)] mb-2 px-2">
          快捷指令
        </h3>
        <div className="grid grid-cols-8 gap-x-2 gap-y-1 mt-2">
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
