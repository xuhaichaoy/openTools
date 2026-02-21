import type { PluginMarketApp } from "@/core/plugin-system/types";
import { Download, Loader2, Search } from "lucide-react";
import { PluginAppIcon } from "@/components/plugins/market/PluginIcon";

interface InstalledPluginSummary {
  id: string;
  manifest: {
    pluginName: string;
  };
  dataProfile?: string;
}

interface FeaturedMarketPanelProps {
  marketTotal: number;
  marketQuery: string;
  onMarketQueryChange: (value: string) => void;
  onRotateMarket: () => void;
  marketLoading: boolean;
  marketCards: PluginMarketApp[];
  installingSlug: string | null;
  uninstallingPluginId: string | null;
  installedPluginBySlug: Map<string, InstalledPluginSummary>;
  onSelectInstalledPlugin: (pluginId: string) => void;
  onSelectMarketApp: (slug: string) => void;
  onInstallFromMarket: (item: PluginMarketApp) => void;
  onUninstallPlugin: (
    pluginId: string,
    pluginName: string,
    dataProfile?: string,
  ) => void;
  formatPackageSize: (bytes?: number | null) => string;
}

export function FeaturedMarketPanel({
  marketTotal,
  marketQuery,
  onMarketQueryChange,
  onRotateMarket,
  marketLoading,
  marketCards,
  installingSlug,
  uninstallingPluginId,
  installedPluginBySlug,
  onSelectInstalledPlugin,
  onSelectMarketApp,
  onInstallFromMarket,
  onUninstallPlugin,
  formatPackageSize,
}: FeaturedMarketPanelProps) {
  return (
    <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-[var(--space-compact-3)]">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-[var(--space-compact-3)]">
        <div>
          <div className="text-sm font-semibold text-[var(--color-text)]">
            精选
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)]">
            市场插件 {marketTotal} 款
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1.5 w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
            <input
              value={marketQuery}
              onChange={(e) => onMarketQueryChange(e.target.value)}
              placeholder="搜索插件"
              className="h-6 w-40 pl-7 pr-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[10px] text-[var(--color-text)] outline-none focus:border-orange-300"
            />
          </div>
          <button
            onClick={onRotateMarket}
            className="text-[10px] px-2 py-1 rounded border border-[var(--color-border)] hover:border-orange-300 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            换一批
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {marketLoading && (
          <div className="col-span-full text-center text-[10px] text-[var(--color-text-secondary)] py-6">
            <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
            加载市场插件中...
          </div>
        )}
        {marketCards.length === 0 && (
          <div className="col-span-full text-center text-[10px] text-[var(--color-text-secondary)] py-6">
            {marketLoading ? "" : "市场暂无插件（等待审核发布）"}
          </div>
        )}
        {marketCards.map((item) => {
          const installedPlugin = installedPluginBySlug.get(
            item.slug.toLowerCase(),
          );
          const installed = Boolean(installedPlugin);
          const packageSize = formatPackageSize(item.packageSizeBytes);
          return (
            <div
              key={item.id}
              onClick={() => {
                if (installedPlugin) {
                  onSelectInstalledPlugin(installedPlugin.id);
                  return;
                }
                onSelectMarketApp(item.slug);
              }}
              className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-[var(--space-compact-3)] py-[var(--space-compact-2)] flex items-center gap-[var(--space-compact-3)] transition-colors cursor-pointer hover:border-orange-300/40"
            >
              <PluginAppIcon plugin={item} size="normal" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-[var(--color-text)] font-medium truncate">
                  {item.name}
                </div>
                <div className="text-[10px] text-[var(--color-text-secondary)] truncate">
                  {item.description}
                </div>
                <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 flex items-center gap-1.5">
                  <span>
                    {item.tag} · {item.installs} 安装 · {packageSize}
                  </span>
                  <span
                    className={`px-1 rounded ${
                      item.isOfficial
                        ? "bg-orange-400/15 text-orange-300"
                        : "bg-blue-400/15 text-blue-300"
                    }`}
                  >
                    {item.isOfficial ? "官方" : "社区"}
                  </span>
                </div>
              </div>
              {installed && installedPlugin ? (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onUninstallPlugin(
                      installedPlugin.id,
                      installedPlugin.manifest.pluginName,
                      installedPlugin.dataProfile,
                    );
                  }}
                  disabled={uninstallingPluginId === installedPlugin.id}
                  className={`px-2 py-1 rounded text-[10px] shrink-0 ${
                    uninstallingPluginId === installedPlugin.id
                      ? "bg-red-500/15 text-red-300 opacity-70"
                      : "bg-red-500/15 text-red-300 hover:bg-red-500/25"
                  }`}
                >
                  {uninstallingPluginId === installedPlugin.id
                    ? "卸载中..."
                    : "卸载"}
                </button>
              ) : (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onInstallFromMarket(item);
                  }}
                  disabled={installingSlug === item.slug}
                  className="p-1.5 rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"
                  title="下载插件"
                >
                  {installingSlug === item.slug ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
