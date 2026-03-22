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
import { createElement } from "react";

import { registry } from "@/core/plugin-system/registry";
import { RuntimeSearchIndex } from "@/core/search/runtime-search-index";
import { useWorkflowStore } from "@/store/workflow-store";
import { usePluginStore } from "@/store/plugin-store";
import { useBookmarkStore } from "@/store/bookmark-store";
import { commandRouter } from "@/shell/CommandRouter";
import { useFileSearch } from "@/shell/useFileSearch";
import { useAppSearch } from "@/shell/useAppSearch";
import { formatFileSize } from "@/shell/ResultBuilder";

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

function fileResultToItem(file: FileResult): ResultItem {
  const sizeStr = file.is_dir ? "文件夹" : formatFileSize(file.size);
  return {
    id: `file-${file.path}`,
    title: file.name,
    description: `${file.path}${file.modified ? ` · ${file.modified}` : ""}${sizeStr ? ` · ${sizeStr}` : ""}`,
    icon: getFileIcon(file.file_type),
    color: getFileColor(file.file_type),
    category: "文件",
    action: () => {
      void invoke("file_open", { path: file.path });
    },
  };
}

export function useSearchResults(
  searchValue: string,
  pushView: (viewId: string) => void,
  handleDirectColorPicker: () => Promise<void>,
) {
  const fileResults = useFileSearch(searchValue);
  const appResults = useAppSearch(searchValue);
  const commandCtx = useMemo(() => ({ pushView }), [pushView]);

  const workflows = useWorkflowStore((state) => state.workflows);
  const externalPlugins = usePluginStore((state) => state.plugins);
  const bookmarks = useBookmarkStore((state) => state.bookmarks);

  const runtimeSearchIndex = useMemo(
    () =>
      new RuntimeSearchIndex({
        builtinPlugins: registry.getSearchable(),
        externalPlugins,
        bookmarks,
        pushView,
        handleDirectColorPicker,
      }),
    [externalPlugins, bookmarks, pushView, handleDirectColorPicker],
  );

  const filteredResults = useMemo((): ResultItem[] => {
    void workflows;

    if (!searchValue) return [];

    const commandResults = commandRouter.match(searchValue, commandCtx);
    if (commandResults !== null) return commandResults;

    if (searchValue.startsWith("f ")) {
      return fileResults.map(fileResultToItem);
    }

    if (searchValue.startsWith("app ")) {
      return appResults.map((app) => ({
        id: `app-${app.path}`,
        title: app.name,
        description: app.path,
        icon: createElement(Rocket, { className: ICON_CLASS }),
        color: "text-green-500 bg-green-500/10",
        category: "应用",
        action: () => {
          void invoke("file_open", { path: app.path });
        },
      }));
    }

    const workflowStore = useWorkflowStore.getState();
    const matchedWorkflow = workflowStore.matchByKeyword(searchValue);
    if (matchedWorkflow) {
      return [runtimeSearchIndex.buildWorkflowResult(matchedWorkflow, workflowStore.executeWorkflow)];
    }

    const builtinResults = runtimeSearchIndex.searchBuiltinPlugins(searchValue);
    const pluginResults = runtimeSearchIndex.searchExternalPlugins(searchValue);
    const bookmarkItems = runtimeSearchIndex.searchBookmarks(searchValue);
    const shortcutItems = runtimeSearchIndex.searchShortcuts(searchValue);

    const appItems: ResultItem[] = appResults.map((app) => ({
      id: `app-${app.path}`,
      title: app.name,
      description: app.path,
      icon: createElement(Rocket, { className: ICON_CLASS }),
      color: "text-green-500 bg-green-500/10",
      category: "应用",
      action: () => {
        void invoke("file_open", { path: app.path });
      },
    }));

    return [
      ...appItems,
      ...shortcutItems,
      ...builtinResults,
      ...pluginResults,
      ...fileResults.map(fileResultToItem),
      ...bookmarkItems,
    ];
  }, [
    searchValue,
    commandCtx,
    fileResults,
    appResults,
    workflows,
    runtimeSearchIndex,
  ]);

  const getFilteredResults = useCallback(() => filteredResults, [filteredResults]);

  return { filteredResults, getFilteredResults };
}
