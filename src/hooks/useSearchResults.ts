import { useMemo, useCallback } from "react";
import { type ResultItem } from "@/components/search/ResultList";
import { invoke } from "@tauri-apps/api/core";
import {
  File,
  Folder,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileCode,
  Archive,
  AppWindow,
  Rocket,
} from "lucide-react";
import {
  PluginsIcon,
  WorkflowsIcon,
  BookmarksIcon,
} from "@/components/icons/animated";
import { createElement } from "react";

import { registry } from "@/core/plugin-system/registry";
import { useWorkflowStore } from "@/store/workflow-store";
import { usePluginStore } from "@/store/plugin-store";
import { useBookmarkStore } from "@/store/bookmark-store";
import { useAppStore } from "@/store/app-store";
import { commandRouter } from "@/shell/CommandRouter";
import { useFileSearch } from "@/shell/useFileSearch";
import { useAppSearch } from "@/shell/useAppSearch";
import { formatFileSize } from "@/shell/ResultBuilder";
import { isBuiltinPluginInstallRequired } from "@/plugins/builtin";

// ── Pure helpers (no hooks, no deps) ──

const ICON_CLASS = "w-6 h-6";

function getFileIcon(fileType: string) {
  switch (fileType) {
    case "folder":
      return createElement(Folder, { className: ICON_CLASS });
    case "image":
      return createElement(FileImage, { className: ICON_CLASS });
    case "video":
      return createElement(FileVideo, { className: ICON_CLASS });
    case "audio":
      return createElement(FileAudio, { className: ICON_CLASS });
    case "code":
      return createElement(FileCode, { className: ICON_CLASS });
    case "text":
    case "document":
      return createElement(FileText, { className: ICON_CLASS });
    case "archive":
      return createElement(Archive, { className: ICON_CLASS });
    case "executable":
      return createElement(AppWindow, { className: ICON_CLASS });
    default:
      return createElement(File, { className: ICON_CLASS });
  }
}

function getFileColor(fileType: string) {
  switch (fileType) {
    case "folder":
      return "text-yellow-500 bg-yellow-500/10";
    case "image":
      return "text-pink-500 bg-pink-500/10";
    case "video":
      return "text-red-500 bg-red-500/10";
    case "audio":
      return "text-purple-500 bg-purple-500/10";
    case "code":
      return "text-green-500 bg-green-500/10";
    case "text":
    case "document":
      return "text-blue-500 bg-blue-500/10";
    case "archive":
      return "text-amber-500 bg-amber-500/10";
    case "executable":
      return "text-gray-500 bg-gray-500/10";
    default:
      return "text-slate-500 bg-slate-500/10";
  }
}

interface FileResult {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: string | null;
  file_type: string;
}

function fileResultToItem(f: FileResult): ResultItem {
  const sizeStr = f.is_dir ? "文件夹" : formatFileSize(f.size);
  return {
    id: `file-${f.path}`,
    title: f.name,
    description: `${f.path}${f.modified ? ` · ${f.modified}` : ""}${sizeStr ? ` · ${sizeStr}` : ""}`,
    icon: getFileIcon(f.file_type),
    color: getFileColor(f.file_type),
    category: "文件",
    action: () => {
      invoke("file_open", { path: f.path });
    },
  };
}

// ── Hook ──

export function useSearchResults(
  searchValue: string,
  pushView: (viewId: string) => void,
  handleDirectColorPicker: () => Promise<void>,
) {
  const fileResults = useFileSearch(searchValue);
  const appResults = useAppSearch(searchValue);

  const commandCtx = useMemo(() => ({ pushView }), [pushView]);

  // Subscribe to reactive store slices so results update when data changes
  const workflows = useWorkflowStore((s) => s.workflows);
  const externalPlugins = usePluginStore((s) => s.plugins);
  const bookmarks = useBookmarkStore((s) => s.bookmarks);

  const filteredResults = useMemo((): ResultItem[] => {
    if (!searchValue) return [];

    // 1) Prefix commands
    const cmdResults = commandRouter.match(searchValue, commandCtx);
    if (cmdResults !== null) return cmdResults;

    // 2) File search prefix
    if (searchValue.startsWith("f ")) {
      return fileResults.map(fileResultToItem);
    }

    // 3) App search prefix
    if (searchValue.startsWith("app ")) {
      return appResults.map((a) => ({
        id: `app-${a.path}`,
        title: a.name,
        description: a.path,
        icon: createElement(Rocket, { className: ICON_CLASS }),
        color: "text-green-500 bg-green-500/10",
        category: "应用",
        action: () => {
          invoke("file_open", { path: a.path });
        },
      }));
    }

    // 4) Workflow match
    const workflowStore = useWorkflowStore.getState();
    const matchedWorkflow = workflowStore.matchByKeyword(searchValue);
    if (matchedWorkflow) {
      return [
        {
          id: `wf-${matchedWorkflow.id}`,
          title: `${matchedWorkflow.icon} 运行: ${matchedWorkflow.name}`,
          description: matchedWorkflow.description,
          icon: createElement(WorkflowsIcon, { className: ICON_CLASS }),
          color: "text-teal-500 bg-teal-500/10",
          category: "工作流",
          action: () => {
            workflowStore.executeWorkflow(matchedWorkflow.id);
            pushView("workflows");
          },
        },
      ];
    }

    // 5) Built-in plugins
    const builtinResults: ResultItem[] = registry
      .search(searchValue)
      .map(({ plugin }) => ({
        id: plugin.id,
        title: plugin.name,
        description: plugin.description,
        icon: plugin.icon,
        color: plugin.color,
        category: plugin.category,
        action: () => pushView(plugin.viewId),
      }));

    // 6) External plugins
    const pluginMatches = usePluginStore
      .getState()
      .matchInput(searchValue)
      .filter((pr) => {
        const slug = pr.plugin.slug?.toLowerCase();
        if (
          pr.plugin.source === "official" &&
          slug &&
          isBuiltinPluginInstallRequired(slug) &&
          registry.getByViewId(slug)
        ) {
          return false;
        }
        return true;
      });
    const BUILTIN_COLOR_PICKER = "color-picker";
    const BUILTIN_SCREEN_CAPTURE = "screen-capture";
    const pluginResults: ResultItem[] = pluginMatches.map((pr) => {
      const code = pr.feature.code;
      const isColorPicker = code === BUILTIN_COLOR_PICKER;
      const isScreenCapture = code === BUILTIN_SCREEN_CAPTURE;
      const slug = pr.plugin.slug?.toLowerCase();
      const openBuiltin = () => {
        if (
          slug &&
          isBuiltinPluginInstallRequired(slug) &&
          registry.getByViewId(slug)
        ) {
          pushView(slug);
          return true;
        }
        return false;
      };
      return {
        id: `plugin-${pr.plugin.id}-${code}`,
        title: pr.plugin.manifest.pluginName,
        description: pr.feature.explain,
        icon: createElement(PluginsIcon, { className: ICON_CLASS }),
        color: "text-orange-500 bg-orange-500/10",
        category: "插件",
        action: isColorPicker
          ? handleDirectColorPicker
          : isScreenCapture
            ? () => pushView("screen-capture")
            : () => {
                if (openBuiltin()) return;
                if (pr.plugin.manifest.mtools?.openMode === "embed") {
                  useAppStore.getState().requestEmbed({
                    pluginId: pr.plugin.id,
                    featureCode: code,
                    title: pr.feature.explain || pr.plugin.manifest.pluginName,
                  });
                  return;
                }
                usePluginStore.getState().openPlugin(pr.plugin.id, code);
              },
      };
    });

    // 7) App results interleaved
    const appItems: ResultItem[] = appResults.map((a) => ({
      id: `app-${a.path}`,
      title: a.name,
      description: a.path,
      icon: createElement(Rocket, { className: ICON_CLASS }),
      color: "text-green-500 bg-green-500/10",
      category: "应用",
      action: () => {
        invoke("file_open", { path: a.path });
      },
    }));

    const fileItems: ResultItem[] = fileResults.map(fileResultToItem);

    // 8) Bookmarks interleaved
    const bmStore = useBookmarkStore.getState();
    const bookmarkPluginInstalled = Boolean(registry.getByViewId("bookmarks"));
    const bmMatches =
      bookmarkPluginInstalled && searchValue.length >= 2
        ? bmStore.searchBookmarks(searchValue).slice(0, 6)
        : [];
    const bookmarkItems: ResultItem[] = bmMatches.map((bm) => ({
      id: `bm-${bm.id}`,
      title: bm.title,
      description: bm.url,
      icon: createElement(BookmarksIcon, { className: ICON_CLASS }),
      color: "text-blue-500 bg-blue-500/10",
      category: "书签",
      action: () => {
        bmStore.markVisited(bm.id);
        invoke("open_url", { url: bm.url });
      },
    }));

    return [
      ...appItems,
      ...builtinResults,
      ...pluginResults,
      ...fileItems,
      ...bookmarkItems,
    ];
  }, [
    searchValue,
    commandCtx,
    handleDirectColorPicker,
    fileResults,
    appResults,
    pushView,
    // Reactive store slices — trigger re-computation when data changes
    workflows,
    externalPlugins,
    bookmarks,
  ]);

  const getFilteredResults = useCallback(() => filteredResults, [filteredResults]);

  return { filteredResults, getFilteredResults };
}
