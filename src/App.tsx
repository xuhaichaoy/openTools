import { useState, useCallback, useEffect } from "react";
import { ScreenshotSelector } from "@/components/tools/ScreenshotSelector";
import { LoginModal } from "@/components/auth/LoginModal";
import { SyncManager } from "@/components/auth/SyncManager";
import { ClusterFloatingIndicator } from "@/components/cluster/ClusterFloatingIndicator";
import { GlobalAskUserDialog } from "@/components/global/GlobalAskUserDialog";
import { GlobalConfirmDialog } from "@/components/global/GlobalConfirmDialog";
import { GlobalClusterPlanApprovalDialog } from "@/components/global/GlobalClusterPlanApprovalDialog";
import { MainViewRouter } from "@/components/app/MainViewRouter";
import { useAppStore } from "@/store/app-store";
import { routeToAICenter } from "@/core/ai/ai-center-routing";

import { registry } from "@/core/plugin-system/registry";
import { usePluginEmbed } from "@/shell/usePluginEmbed";
import "@/shell/commands";
import { useScreenshotHandler } from "@/shell/useScreenshotHandler";
import { updateWindowSize } from "@/shell/WindowSizeManager";
import { resolveBuiltinPlugins } from "@/plugins/builtin";
import { MAIN_VIEW_ID, getTopViewEntry } from "@/core/navigation/view-stack";

import { useColorPicker } from "@/hooks/useColorPicker";
import { useAppInitializer } from "@/hooks/useAppInitializer";
import { useSearchResults } from "@/hooks/useSearchResults";
import { usePluginLifecycle } from "@/hooks/usePluginLifecycle";

// 初始化：注册所有内置插件
registry.registerAll(resolveBuiltinPlugins());

// 独立窗口模式检测：截图选区窗口
const specialView = window.__SCREENSHOT_MODE__ ? "screenshot" : null;

function App() {
  if (specialView === "screenshot") {
    return (
      <div className="w-full h-full" style={{ background: "#000" }}>
        <ScreenshotSelector />
      </div>
    );
  }
  return <MainApp />;
}

/** 主应用组件 — 所有 hooks 在此无条件调用，符合 Rules of Hooks */
function MainApp() {
  const view = useAppStore((s) => getTopViewEntry(s.viewStack).viewId);
  const {
    mode,
    searchValue,
    setWindowExpanded,
    resetSearchState,
    pushView,
    popView,
    resetToMain,
  } = useAppStore();

  const [contextText, setContextText] = useState("");

  // ── Extracted hooks ──
  const { handleDirectColorPicker } = useColorPicker();
  useAppInitializer(pushView, setContextText);

  const { embedTarget, setEmbedTarget, embedBridgeToken } = usePluginEmbed(
    view,
    pushView,
  );
  useScreenshotHandler(pushView);

  const { filteredResults, getFilteredResults } = useSearchResults(
    searchValue,
    pushView,
    handleDirectColorPicker,
  );

  const { activePlugin, pluginContext } = usePluginLifecycle(view, resetToMain);

  // ── Window size management ──
  useEffect(() => {
    updateWindowSize(view, searchValue, getFilteredResults, setWindowExpanded);
  }, [view, mode, searchValue, getFilteredResults, setWindowExpanded]);

  // ── Submit handler ──
  const handleSubmit = useCallback(
    (value: string, currentMode: string, images?: string[]) => {
      if (currentMode === "ai" || value.startsWith("ai ") || (images && images.length > 0)) {
        const query = value.startsWith("ai ") ? value.slice(3) : value;
        const finalQuery = query.trim() || (images?.length ? "请描述这张图片" : "");
        if (finalQuery || (images && images.length > 0)) {
          routeToAICenter({
            mode: "ask",
            source: "main_search_submit",
            query: finalQuery,
            images,
            pushView,
          });
        }
        return;
      }

      if (value.startsWith("/ ")) {
        const cmd = value.slice(2).trim();
        if (cmd) {
          routeToAICenter({
            mode: "agent",
            source: "main_shell_shortcut",
            agentInitialQuery: `请执行以下 shell 命令并解释结果：\`${cmd}\``,
            note: "main search bar shortcut",
            pushView,
          });
        }
        return;
      }

      const results = getFilteredResults();
      const { selectedIndex } = useAppStore.getState();
      if (results[selectedIndex]?.action) {
        results[selectedIndex].action!();
      }
    },
    [getFilteredResults, pushView],
  );

  // ── ESC to go back ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && view !== MAIN_VIEW_ID) {
        popView();
        resetSearchState();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, popView, resetSearchState]);

  return (
    <div className="w-full h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl">
      <MainViewRouter
        view={view}
        searchValue={searchValue}
        filteredResults={filteredResults}
        handleSubmit={handleSubmit}
        pushView={pushView}
        popView={popView}
        resetToMain={resetToMain}
        activePlugin={activePlugin}
        pluginContext={pluginContext}
        embedTarget={embedTarget}
        setEmbedTarget={setEmbedTarget}
        embedBridgeToken={embedBridgeToken}
        contextText={contextText}
      />

      <LoginModal />
      <SyncManager />
      <ClusterFloatingIndicator />
      <GlobalConfirmDialog />
      <GlobalClusterPlanApprovalDialog />
      <GlobalAskUserDialog />
    </div>
  );
}

export default App;
