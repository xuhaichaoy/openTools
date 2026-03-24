import { createElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookmarksIcon, PluginsIcon, WorkflowsIcon } from "@/components/icons/animated";
import type { ResultItem } from "@/components/search/ResultList";
import {
  AppWindow,
  ClipboardList,
  Database,
  FileText,
  Globe,
  Search,
  Zap,
} from "lucide-react";
import { registry } from "@/core/plugin-system/registry";
import { isFeatureSupportedOnCurrentPlatform } from "@/core/plugin-system/platform";
import type { MToolsPlugin } from "@/core/plugin-system/plugin-interface";
import type { PluginFeature, PluginInstance } from "@/core/plugin-system/types";
import { handleError } from "@/core/errors";
import type { Bookmark } from "@/store/bookmark-store";
import { useAppStore } from "@/store/app-store";
import { useBookmarkStore } from "@/store/bookmark-store";
import { usePluginStore } from "@/store/plugin-store";
import {
  multiPreparedFieldScore,
  preparePinyinField,
  type PreparedPinyinField,
} from "@/utils/pinyin-search";
import { isBuiltinPluginInstallRequired } from "@/plugins/builtin";

const ICON_CLASS = "w-6 h-6";
const BUILTIN_COLOR_PICKER = "color-picker";

interface IndexedEntry<T> {
  fields: PreparedPinyinField[];
  payload: T;
}

interface BuiltinPayload {
  plugin: MToolsPlugin;
}

interface ExternalPluginPayload {
  plugin: PluginInstance;
  feature: PluginFeature;
}

interface BookmarkPayload {
  bookmark: Bookmark;
}

interface ShortcutPayload {
  result: ResultItem;
}

interface SearchShortcutDefinition {
  id: string;
  title: string;
  description: string;
  category: string;
  color: string;
  icon: React.ReactNode;
  searchTerms: string[];
  action: () => void;
}

function scoreEntries<T>(entries: IndexedEntry<T>[], query: string) {
  return entries
    .map((entry) => ({
      entry,
      score: multiPreparedFieldScore(entry.fields, query),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
}

function commandText(value: string | { label?: string; match?: string }) {
  if (typeof value === "string") return value;
  return [value.label, value.match].filter(Boolean).join(" ");
}

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
    void openPlugin(target.id, feature.code);
    return;
  }

  ensureBuiltinPluginInstalled(slug, pluginName, pushView);
}

export class RuntimeSearchIndex {
  private readonly options: {
    builtinPlugins: MToolsPlugin[];
    externalPlugins: PluginInstance[];
    bookmarks: Bookmark[];
    pushView: (viewId: string) => void;
    handleDirectColorPicker: () => Promise<void>;
  };
  private builtinEntries: IndexedEntry<BuiltinPayload>[];
  private externalPluginEntries: IndexedEntry<ExternalPluginPayload>[];
  private bookmarkEntries: IndexedEntry<BookmarkPayload>[];
  private shortcutEntries: IndexedEntry<ShortcutPayload>[];

  constructor(
    options: {
      builtinPlugins: MToolsPlugin[];
      externalPlugins: PluginInstance[];
      bookmarks: Bookmark[];
      pushView: (viewId: string) => void;
      handleDirectColorPicker: () => Promise<void>;
    },
  ) {
    this.options = options;
    this.builtinEntries = options.builtinPlugins.map((plugin) => ({
      fields: [plugin.name, plugin.description, ...plugin.keywords, plugin.id].map(preparePinyinField),
      payload: { plugin },
    }));

    this.externalPluginEntries = options.externalPlugins.flatMap((plugin) => {
      if (!plugin.enabled) return [];

      return plugin.manifest.features
        .filter((feature) => isFeatureSupportedOnCurrentPlatform(feature))
        .map((feature) => ({
          fields: [
            plugin.manifest.pluginName,
            feature.explain,
            feature.code,
            ...feature.cmds.map(commandText),
          ].map(preparePinyinField),
          payload: { plugin, feature },
        }));
    });

    this.bookmarkEntries = options.bookmarks
      .filter((bookmark) => !bookmark.deleted)
      .map((bookmark) => ({
        fields: [
          bookmark.title,
          bookmark.keyword,
          bookmark.category,
          bookmark.url,
        ].map(preparePinyinField),
        payload: { bookmark },
      }));

    const shortcuts: SearchShortcutDefinition[] = [
      {
        id: "shortcut-file-search",
        title: "文件搜索",
        description: "输入 f 后搜索本地文件",
        category: "搜索",
        color: "text-slate-500 bg-slate-500/10",
        icon: createElement(Search, { className: ICON_CLASS }),
        searchTerms: ["f", "文件", "文件搜索", "file", "finder", "查找文件"],
        action: () => useAppStore.getState().setSearchValue("f "),
      },
      {
        id: "shortcut-app-search",
        title: "应用搜索",
        description: "输入 app 后搜索和启动应用",
        category: "搜索",
        color: "text-green-500 bg-green-500/10",
        icon: createElement(AppWindow, { className: ICON_CLASS }),
        searchTerms: ["app", "应用", "应用搜索", "启动应用", "application"],
        action: () => useAppStore.getState().setSearchValue("app "),
      },
      {
        id: "shortcut-baidu",
        title: "百度搜索",
        description: "输入 bd 后使用百度搜索",
        category: "搜索",
        color: "text-blue-500 bg-blue-500/10",
        icon: createElement(Globe, { className: ICON_CLASS }),
        searchTerms: ["bd", "baidu", "百度", "百度搜索", "网页搜索"],
        action: () => useAppStore.getState().setSearchValue("bd "),
      },
      {
        id: "shortcut-google",
        title: "Google 搜索",
        description: "输入 gg 后使用 Google 搜索",
        category: "搜索",
        color: "text-green-500 bg-green-500/10",
        icon: createElement(Globe, { className: ICON_CLASS }),
        searchTerms: ["gg", "google", "谷歌", "谷歌搜索", "Google 搜索"],
        action: () => useAppStore.getState().setSearchValue("gg "),
      },
      {
        id: "shortcut-bing",
        title: "必应搜索",
        description: "输入 bing 后使用必应搜索",
        category: "搜索",
        color: "text-teal-500 bg-teal-500/10",
        icon: createElement(Globe, { className: ICON_CLASS }),
        searchTerms: ["bing", "必应", "必应搜索", "Bing 搜索"],
        action: () => useAppStore.getState().setSearchValue("bing "),
      },
      {
        id: "shortcut-clipboard",
        title: "剪贴板历史",
        description: "打开剪贴板记录和搜索",
        category: "工具",
        color: "text-cyan-500 bg-cyan-500/10",
        icon: createElement(ClipboardList, { className: ICON_CLASS }),
        searchTerms: ["cb", "剪贴板", "clipboard", "剪贴板历史", "历史记录"],
        action: () => options.pushView("clipboard-history"),
      },
      {
        id: "shortcut-data-forge",
        title: "数据工坊",
        description: "打开数据工坊",
        category: "数据",
        color: "text-purple-500 bg-purple-500/10",
        icon: createElement(Database, { className: ICON_CLASS }),
        searchTerms: ["data", "数据工坊", "数据", "data forge"],
        action: () => options.pushView("data-forge"),
      },
      {
        id: "shortcut-system-actions",
        title: "系统操作",
        description: "打开系统操作工具",
        category: "工具",
        color: "text-amber-500 bg-amber-500/10",
        icon: createElement(Zap, { className: ICON_CLASS }),
        searchTerms: ["sys", "系统操作", "system", "操作", "动作"],
        action: () => openMarketPluginBySlug("system-actions", "系统操作", options.pushView),
      },
      {
        id: "shortcut-snippets",
        title: "快捷短语",
        description: "打开快捷短语",
        category: "工具",
        color: "text-emerald-500 bg-emerald-500/10",
        icon: createElement(FileText, { className: ICON_CLASS }),
        searchTerms: ["sn", "snippets", "快捷短语", "片段", "文本片段"],
        action: () => openMarketPluginBySlug("snippets", "快捷短语", options.pushView),
      },
      {
        id: "shortcut-bookmarks",
        title: "网页书签",
        description: "打开网页书签",
        category: "工具",
        color: "text-blue-500 bg-blue-500/10",
        icon: createElement(Globe, { className: ICON_CLASS }),
        searchTerms: ["bk", "bookmarks", "网页书签", "书签", "收藏"],
        action: () => openMarketPluginBySlug("bookmarks", "网页书签", options.pushView),
      },
    ];

    this.shortcutEntries = shortcuts.map((shortcut) => ({
      fields: [shortcut.title, shortcut.description, ...shortcut.searchTerms].map(preparePinyinField),
      payload: {
        result: {
          id: shortcut.id,
          title: shortcut.title,
          description: shortcut.description,
          category: shortcut.category,
          color: shortcut.color,
          icon: shortcut.icon,
          action: shortcut.action,
        },
      },
    }));
  }

  searchBuiltinPlugins(query: string): ResultItem[] {
    return scoreEntries(this.builtinEntries, query).map(({ entry }) => {
      const { plugin } = entry.payload;
      return {
        id: plugin.id,
        title: plugin.name,
        description: plugin.description,
        icon: plugin.icon,
        color: plugin.color,
        category: plugin.category,
        action: () => this.options.pushView(plugin.viewId),
      };
    });
  }

  searchExternalPlugins(query: string): ResultItem[] {
    return scoreEntries(this.externalPluginEntries, query)
      .filter(({ entry }) => {
        const slug = entry.payload.plugin.slug?.toLowerCase();
        if (
          entry.payload.plugin.source === "official" &&
          slug &&
          isBuiltinPluginInstallRequired(slug) &&
          registry.getByViewId(slug)
        ) {
          return false;
        }
        return true;
      })
      .map(({ entry }) => {
        const { plugin, feature } = entry.payload;
        const slug = plugin.slug?.toLowerCase();
        const openBuiltin = () => {
          if (
            slug &&
            isBuiltinPluginInstallRequired(slug) &&
            registry.getByViewId(slug)
          ) {
            this.options.pushView(slug);
            return true;
          }
          return false;
        };

        return {
          id: `plugin-${plugin.id}-${feature.code}`,
          title: plugin.manifest.pluginName,
          description: feature.explain,
          icon: createElement(PluginsIcon, { className: ICON_CLASS }),
          color: "text-orange-500 bg-orange-500/10",
          category: "插件",
          action:
            feature.code === BUILTIN_COLOR_PICKER
              ? this.options.handleDirectColorPicker
              : () => {
                  if (openBuiltin()) return;
                  if (plugin.manifest.mtools?.openMode === "embed") {
                    useAppStore.getState().requestEmbed({
                      pluginId: plugin.id,
                      featureCode: feature.code,
                      title: feature.explain || plugin.manifest.pluginName,
                    });
                    return;
                  }
                  usePluginStore.getState().openPlugin(plugin.id, feature.code);
                },
        } satisfies ResultItem;
      });
  }

  searchBookmarks(query: string): ResultItem[] {
    const bookmarkPluginInstalled = Boolean(registry.getByViewId("bookmarks"));
    if (!bookmarkPluginInstalled || query.length < 2) {
      return [];
    }

    return scoreEntries(this.bookmarkEntries, query)
      .slice(0, 6)
      .map(({ entry }) => {
        const { bookmark } = entry.payload;
        return {
          id: `bm-${bookmark.id}`,
          title: bookmark.title,
          description: bookmark.url,
          icon: createElement(BookmarksIcon, { className: ICON_CLASS }),
          color: "text-blue-500 bg-blue-500/10",
          category: "书签",
          action: () => {
            void useBookmarkStore.getState().markVisited(bookmark.id);
            void invoke("open_url", { url: bookmark.url });
          },
        };
      });
  }

  searchShortcuts(query: string): ResultItem[] {
    return scoreEntries(this.shortcutEntries, query).map(({ entry }) => entry.payload.result);
  }

  buildWorkflowResult(
    workflow: { id: string; name: string; description: string; icon: string },
    execute: (id: string) => void,
  ): ResultItem {
    return {
      id: `wf-${workflow.id}`,
      title: `${workflow.icon} 运行: ${workflow.name}`,
      description: workflow.description,
      icon: createElement(WorkflowsIcon, { className: ICON_CLASS }),
      color: "text-teal-500 bg-teal-500/10",
      category: "工作流",
      action: () => {
        execute(workflow.id);
        this.options.pushView("workflows");
      },
    };
  }
}
