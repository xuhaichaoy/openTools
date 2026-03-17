import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoginModal } from "@/components/auth/LoginModal";
import { SyncManager } from "@/components/auth/SyncManager";
import { ClusterFloatingIndicator } from "@/components/cluster/ClusterFloatingIndicator";
import { GlobalAskUserDialog } from "@/components/global/GlobalAskUserDialog";
import { GlobalConfirmDialog } from "@/components/global/GlobalConfirmDialog";
import { GlobalClusterPlanApprovalDialog } from "@/components/global/GlobalClusterPlanApprovalDialog";
import { MainViewRouter } from "@/components/app/MainViewRouter";
import { WindowResizeHandles } from "@/components/app/WindowResizeHandles";
import { useAppStore } from "@/store/app-store";
import { useAskUserStore } from "@/store/ask-user-store";
import { useConfirmDialogStore } from "@/store/confirm-dialog-store";
import { useClusterPlanApprovalStore } from "@/store/cluster-plan-approval-store";
import { routeToAICenter } from "@/core/ai/ai-center-routing";

import { registry } from "@/core/plugin-system/registry";
import { usePluginEmbed } from "@/shell/usePluginEmbed";
import "@/shell/commands";
import { updateWindowSize } from "@/shell/WindowSizeManager";
import { resolveBuiltinPlugins } from "@/plugins/builtin";
import {
  MAIN_VIEW_ID,
  ROOT_VIEW_ID,
  getTopViewEntry,
} from "@/core/navigation/view-stack";

import { useColorPicker } from "@/hooks/useColorPicker";
import { useAppInitializer } from "@/hooks/useAppInitializer";
import { useSearchResults } from "@/hooks/useSearchResults";
import { usePluginLifecycle } from "@/hooks/usePluginLifecycle";
import { resolveWindowResizeBucket } from "@/core/ui/local-ui-preferences";

// 初始化：注册所有内置插件
registry.registerAll(resolveBuiltinPlugins());

function App() {
  return <MainApp />;
}

/** 主应用组件 — 所有 hooks 在此无条件调用，符合 Rules of Hooks */
function MainApp() {
  const view = useAppStore((s) => getTopViewEntry(s.viewStack).viewId);
  const viewDepth = useAppStore((s) => s.viewStack.length);
  const {
    mode,
    searchValue,
    setWindowExpanded,
    resetSearchState,
    pushView,
    popView,
    replaceView,
    resetToMain,
  } = useAppStore();

  const [contextText, setContextText] = useState("");
  const [windowFocused, setWindowFocused] = useState(() =>
    typeof document !== "undefined"
      ? document.visibilityState === "visible" && document.hasFocus()
      : true,
  );
  const askDialog = useAskUserStore((s) => s.dialog);
  const confirmPendingCount = useConfirmDialogStore(
    (s) => (s.active ? 1 : 0) + s.queue.length,
  );
  const clusterPendingCount = useClusterPlanApprovalStore(
    (s) => (s.active ? 1 : 0) + s.queue.length,
  );
  const pendingAttentionCount = (askDialog ? 1 : 0) + confirmPendingCount + clusterPendingCount;
  const trayAttentionCount = windowFocused ? 0 : pendingAttentionCount;

  // ── Extracted hooks ──
  const { handleDirectColorPicker } = useColorPicker();
  useAppInitializer(pushView, setContextText);

  const { embedTarget, setEmbedTarget, embedBridgeToken } = usePluginEmbed(
    view,
    pushView,
  );

  const { filteredResults, getFilteredResults } = useSearchResults(
    searchValue,
    pushView,
    handleDirectColorPicker,
  );
  const resizeBucket = resolveWindowResizeBucket(
    view,
    searchValue,
    filteredResults.length,
  );

  const { activePlugin, pluginContext } = usePluginLifecycle(view, resetToMain);

  const openLauncher = useCallback(() => {
    resetSearchState();
    replaceView(MAIN_VIEW_ID);
  }, [replaceView, resetSearchState]);

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
      if (e.key !== "Escape") return;

      if (view === ROOT_VIEW_ID && viewDepth === 1) {
        openLauncher();
        return;
      }

      if (view !== MAIN_VIEW_ID) {
        popView();
        resetSearchState();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [view, viewDepth, openLauncher, popView, resetSearchState]);

  useEffect(() => {
    const syncWindowFocus = () => {
      setWindowFocused(document.visibilityState === "visible" && document.hasFocus());
    };

    syncWindowFocus();
    window.addEventListener("focus", syncWindowFocus);
    window.addEventListener("blur", syncWindowFocus);
    document.addEventListener("visibilitychange", syncWindowFocus);
    return () => {
      window.removeEventListener("focus", syncWindowFocus);
      window.removeEventListener("blur", syncWindowFocus);
      document.removeEventListener("visibilitychange", syncWindowFocus);
    };
  }, []);

  useEffect(() => {
    invoke("set_tray_attention_count", {
      count: trayAttentionCount,
    }).catch(() => undefined);
  }, [trayAttentionCount]);

  return (
    <div className="relative w-full h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] overflow-hidden rounded-xl border border-[var(--color-border)] shadow-2xl">
      <WindowResizeHandles bucket={resizeBucket} />

      <MainViewRouter
        view={view}
        searchValue={searchValue}
        filteredResults={filteredResults}
        handleSubmit={handleSubmit}
        pushView={pushView}
        popView={popView}
        viewDepth={viewDepth}
        openLauncher={openLauncher}
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
