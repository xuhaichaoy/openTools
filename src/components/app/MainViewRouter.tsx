import { Suspense } from "react";
import { SearchBar } from "@/components/search/SearchBar";
import { ResultList, type ResultItem } from "@/components/search/ResultList";
import { ContextActionPanel } from "@/components/ai/ContextActionPanel";
import { Home } from "@/components/navigation/Home";
import { Dashboard } from "@/components/home/Dashboard";
import { PluginEmbed } from "@/components/plugins/PluginEmbed";
import { PluginErrorBoundary } from "@/components/plugins/PluginErrorBoundary";
import type { MToolsPlugin } from "@/core/plugin-system/plugin-interface";
import type { PluginContext } from "@/core/plugin-system/context";
import type { EmbedTarget } from "@/shell/usePluginEmbed";
import {
  CONTEXT_ACTION_VIEW_ID,
  HOME_VIEW_ID,
  MAIN_VIEW_ID,
  PLUGIN_EMBED_VIEW_ID,
} from "@/core/navigation/view-stack";

interface MainViewRouterProps {
  view: string;
  searchValue: string;
  filteredResults: ResultItem[];
  handleSubmit: (value: string, currentMode: string, images?: string[]) => void;
  pushView: (viewId: string) => void;
  popView: () => void;
  resetToMain: () => void;
  activePlugin?: MToolsPlugin;
  pluginContext: PluginContext | null;
  embedTarget: EmbedTarget | null;
  setEmbedTarget: (target: EmbedTarget | null) => void;
  embedBridgeToken: string | null;
  contextText: string;
}

export function MainViewRouter({
  view,
  searchValue,
  filteredResults,
  handleSubmit,
  pushView,
  popView,
  resetToMain,
  activePlugin,
  pluginContext,
  embedTarget,
  setEmbedTarget,
  embedBridgeToken,
  contextText,
}: MainViewRouterProps) {
  return (
    <>
      {view === MAIN_VIEW_ID && (
        <>
          <div className="sticky top-0 z-10 pb-0 bg-[var(--color-bg)]/80 backdrop-blur-xl">
            <SearchBar
              onSubmit={handleSubmit}
              resultCount={filteredResults.length}
            />
          </div>

          <div className="flex-1 overflow-hidden">
            {searchValue ? (
              <div className="h-full overflow-y-auto px-[var(--space-compact-3)] pb-[var(--space-compact-3)]">
                <ResultList items={filteredResults} />
              </div>
            ) : (
              <Dashboard onNavigate={(nextViewId) => pushView(nextViewId)} />
            )}
          </div>
        </>
      )}

      {activePlugin && activePlugin.viewId !== HOME_VIEW_ID && pluginContext && (
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center text-[var(--color-text-secondary)]">
              加载中...
            </div>
          }
        >
          <PluginErrorBoundary
            pluginId={activePlugin.id}
            onReset={() => resetToMain()}
          >
            <div className="h-full">
              {activePlugin.render({
                onBack: () => popView(),
                context: pluginContext,
              })}
            </div>
          </PluginErrorBoundary>
        </Suspense>
      )}

      {view === HOME_VIEW_ID && (
        <Home onNavigate={(nextViewId) => pushView(nextViewId)} onBack={() => popView()} />
      )}

      {view === PLUGIN_EMBED_VIEW_ID && embedTarget && embedBridgeToken && (
        <div className="h-full">
          <PluginErrorBoundary
            pluginId={embedTarget.pluginId}
            onReset={() => {
              resetToMain();
              setEmbedTarget(null);
            }}
          >
            <PluginEmbed
              pluginId={embedTarget.pluginId}
              featureCode={embedTarget.featureCode}
              bridgeToken={embedBridgeToken}
              title={embedTarget.title}
              onBack={() => {
                popView();
                setEmbedTarget(null);
              }}
            />
          </PluginErrorBoundary>
        </div>
      )}

      {view === CONTEXT_ACTION_VIEW_ID && (
        <div className="h-full">
          <ContextActionPanel
            selectedText={contextText}
            onBack={() => popView()}
          />
        </div>
      )}
    </>
  );
}

