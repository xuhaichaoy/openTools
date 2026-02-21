import {
  ArrowLeft,
  Download,
  ExternalLink,
  Loader2,
  Play,
  ToggleLeft,
  ToggleRight,
  Trash2,
} from "lucide-react";
import { PluginsIcon } from "@/components/icons/animated";
import { PluginAppIcon } from "@/components/plugins/market/PluginIcon";
import { isBuiltinPluginInstallRequired } from "@/plugins/builtin";
import { FeaturedMarketPanel } from "@/components/plugins/market/FeaturedMarketPanel";
import type {
  PluginInstance,
  PluginMarketApp,
} from "@/core/plugin-system/types";

interface ExternalPluginPanelProps {
  loading: boolean;
  externalPlugins: PluginInstance[];
  selectedExternalPluginId: string | null;
  selectedExternalPlugin: PluginInstance | null;
  selectedMarketApp: PluginMarketApp | null;
  marketTotal: number;
  marketQuery: string;
  marketLoading: boolean;
  marketCards: PluginMarketApp[];
  installingSlug: string | null;
  uninstallingPluginId: string | null;
  installedPluginBySlug: Map<string, PluginInstance>;
  onSelectExternalPlugin: (pluginId: string | null) => void;
  onSelectMarketApp: (slug: string | null) => void;
  onOpenPluginDir: () => void;
  onRotateMarket: () => void;
  onMarketQueryChange: (value: string) => void;
  onInstallFromMarket: (item: PluginMarketApp) => void;
  onUninstallPlugin: (
    pluginId: string,
    pluginName: string,
    dataProfile?: string,
  ) => void;
  onOpenSelectedExternalPlugin: (
    plugin: PluginInstance,
    featureCode: string,
  ) => void;
  onTogglePluginEnabled: (pluginId: string, enabled: boolean) => void;
  onRequestEmbed: (plugin: PluginInstance, featureCode: string) => void;
  formatPackageSize: (bytes?: number | null) => string;
}

export function ExternalPluginPanel({
  loading,
  externalPlugins,
  selectedExternalPluginId,
  selectedExternalPlugin,
  selectedMarketApp,
  marketTotal,
  marketQuery,
  marketLoading,
  marketCards,
  installingSlug,
  uninstallingPluginId,
  installedPluginBySlug,
  onSelectExternalPlugin,
  onSelectMarketApp,
  onOpenPluginDir,
  onRotateMarket,
  onMarketQueryChange,
  onInstallFromMarket,
  onUninstallPlugin,
  onOpenSelectedExternalPlugin,
  onTogglePluginEnabled,
  onRequestEmbed,
  formatPackageSize,
}: ExternalPluginPanelProps) {
  const selectedExternalPrimaryFeature =
    selectedExternalPlugin?.manifest.features[0];
  const selectedExternalSlug = selectedExternalPlugin?.slug?.toLowerCase();
  const selectedExternalIsMigratedBuiltin = Boolean(
    selectedExternalPlugin &&
    selectedExternalPlugin.source === "official" &&
    selectedExternalSlug &&
    isBuiltinPluginInstallRequired(selectedExternalSlug),
  );

  return (
    <div className="h-full min-h-0 grid grid-cols-1 md:grid-cols-[208px_1fr] gap-1.5 overflow-hidden">
      <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-2 h-full flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-xs font-semibold text-[var(--color-text)]">
              已安装插件应用
            </div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              {externalPlugins.length} 个插件
            </div>
          </div>
          <button
            onClick={onOpenPluginDir}
            className="px-2 py-1 text-[10px] rounded bg-orange-400/15 text-orange-300 hover:bg-orange-400/25"
          >
            导入
          </button>
        </div>
        {loading && (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
            <span className="text-xs">加载中...</span>
          </div>
        )}
        {!loading && externalPlugins.length === 0 && (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <PluginsIcon className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-xs">暂无扩展插件</p>
            <p className="text-[10px] mt-1">
              点击右上角导入，或在开发者页添加目录
            </p>
          </div>
        )}
        <div className="space-y-1 flex-1 min-h-0 overflow-y-auto">
          {externalPlugins.map((plugin) => {
            const selected = selectedExternalPluginId === plugin.id;
            return (
              <button
                key={plugin.id}
                onClick={() => {
                  onSelectExternalPlugin(plugin.id);
                  onSelectMarketApp(null);
                }}
                className={`w-full rounded-lg border px-1 py-1.5 transition-colors text-left ${
                  selected
                    ? "border-orange-400/60 bg-orange-400/10"
                    : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-orange-300/40"
                } ${plugin.enabled ? "" : "opacity-65"}`}
              >
                <div className="flex items-center gap-2">
                  <PluginAppIcon plugin={plugin} size="small" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-[var(--color-text)] truncate">
                      {plugin.manifest.pluginName}
                    </div>
                  </div>
                  <span
                    className={`w-2 h-2 rounded-full ${plugin.enabled ? "bg-green-400" : "bg-gray-400"}`}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="h-full min-w-0 overflow-hidden">
        {selectedExternalPlugin ? (
          <div className="h-full rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col overflow-hidden">
            <div className="px-[var(--space-compact-3)] py-[var(--space-compact-2)] border-b border-[var(--color-border)] flex items-center justify-between">
              <button
                onClick={() => onSelectExternalPlugin(null)}
                className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                返回插件中心
              </button>
              <span className="text-[11px] text-[var(--color-text-secondary)]">
                插件详情
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-[var(--space-compact-1)] space-y-[var(--space-compact-3)]">
              <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-[var(--space-compact-3)]">
                <div className="flex items-start gap-[var(--space-compact-3)]">
                  <PluginAppIcon plugin={selectedExternalPlugin} size="large" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[var(--color-text)] truncate">
                      {selectedExternalPlugin.manifest.pluginName}
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                      {selectedExternalPlugin.manifest.description || "无描述"}
                    </div>
                    <div className="mt-2 text-[11px] text-[var(--color-text-secondary)] flex items-center gap-2">
                      <span>v{selectedExternalPlugin.manifest.version}</span>
                      {selectedExternalPlugin.source && (
                        <span className="px-1 rounded bg-[var(--color-bg-hover)]">
                          {selectedExternalPlugin.source}
                        </span>
                      )}
                      <span>
                        {selectedExternalPlugin.manifest.features.length} 功能
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-[var(--space-compact-3)]">
                <div className="text-xs font-medium text-[var(--color-text)] mb-2">
                  可执行操作
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    disabled={
                      !selectedExternalPlugin.enabled ||
                      !selectedExternalPrimaryFeature
                    }
                    onClick={() => {
                      if (
                        !selectedExternalPlugin.enabled ||
                        !selectedExternalPrimaryFeature
                      )
                        return;
                      onOpenSelectedExternalPlugin(
                        selectedExternalPlugin,
                        selectedExternalPrimaryFeature.code,
                      );
                    }}
                    className="px-2.5 py-1.5 rounded text-[11px] bg-orange-400/12 text-orange-300 hover:bg-orange-400/22 disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Play className="w-3.5 h-3.5" />
                    打开
                  </button>
                  <button
                    onClick={() =>
                      onTogglePluginEnabled(
                        selectedExternalPlugin.id,
                        !selectedExternalPlugin.enabled,
                      )
                    }
                    className={`px-2.5 py-1.5 rounded text-[11px] inline-flex items-center gap-1 ${
                      selectedExternalPlugin.enabled
                        ? "bg-green-500/12 text-green-300 hover:bg-green-500/22"
                        : "bg-gray-500/12 text-gray-300 hover:bg-gray-500/22"
                    }`}
                  >
                    {selectedExternalPlugin.enabled ? (
                      <ToggleRight className="w-3.5 h-3.5" />
                    ) : (
                      <ToggleLeft className="w-3.5 h-3.5" />
                    )}
                    {selectedExternalPlugin.enabled ? "已启用" : "已禁用"}
                  </button>
                  <button
                    disabled={
                      !selectedExternalPlugin.enabled ||
                      !selectedExternalPrimaryFeature ||
                      selectedExternalIsMigratedBuiltin
                    }
                    onClick={() => {
                      if (
                        !selectedExternalPrimaryFeature ||
                        selectedExternalIsMigratedBuiltin
                      )
                        return;
                      onRequestEmbed(
                        selectedExternalPlugin,
                        selectedExternalPrimaryFeature.code,
                      );
                    }}
                    className="px-2.5 py-1.5 rounded text-[11px] bg-blue-400/12 text-blue-300 hover:bg-blue-400/22 disabled:opacity-40 inline-flex items-center gap-1"
                    title={
                      selectedExternalIsMigratedBuiltin
                        ? "官方迁移插件请使用内置视图，不支持嵌入"
                        : "嵌入"
                    }
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    嵌入
                  </button>
                  <button
                    disabled={
                      uninstallingPluginId === selectedExternalPlugin.id
                    }
                    onClick={() =>
                      onUninstallPlugin(
                        selectedExternalPlugin.id,
                        selectedExternalPlugin.manifest.pluginName,
                        selectedExternalPlugin.dataProfile,
                      )
                    }
                    className="px-2.5 py-1.5 rounded text-[11px] bg-red-500/15 text-red-300 hover:bg-red-500/25 disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {uninstallingPluginId === selectedExternalPlugin.id
                      ? "卸载中..."
                      : "卸载"}
                  </button>
                </div>
              </div>

              <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-[var(--space-compact-3)]">
                <div className="text-xs font-medium text-[var(--color-text)] mb-2">
                  插件信息
                </div>
                <div className="space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
                  <div>插件 ID: {selectedExternalPlugin.id}</div>
                  <div>目录路径: {selectedExternalPlugin.dirPath}</div>
                  <div>
                    入口功能: {selectedExternalPrimaryFeature?.code || "-"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : selectedMarketApp ? (
          <div className="h-full rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex flex-col overflow-hidden">
            <div className="px-[var(--space-compact-3)] py-[var(--space-compact-2)] border-b border-[var(--color-border)] flex items-center justify-between">
              <button
                onClick={() => onSelectMarketApp(null)}
                className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                返回插件中心
              </button>
              <span className="text-[11px] text-[var(--color-text-secondary)]">
                市场详情
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-[var(--space-compact-1)] space-y-[var(--space-compact-3)]">
              <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-[var(--space-compact-3)]">
                <div className="flex items-start gap-[var(--space-compact-3)]">
                  <PluginAppIcon plugin={selectedMarketApp} size="large" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-[var(--color-text)] truncate">
                      {selectedMarketApp.name}
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                      {selectedMarketApp.description || "无描述"}
                    </div>
                    <div className="mt-2 text-[11px] text-[var(--color-text-secondary)] flex items-center gap-2 flex-wrap">
                      <span>v{selectedMarketApp.version}</span>
                      <span>{selectedMarketApp.tag}</span>
                      <span>{selectedMarketApp.installs} 安装</span>
                      <span>
                        {formatPackageSize(selectedMarketApp.packageSizeBytes)}
                      </span>
                      <span
                        className={`px-1 rounded ${
                          selectedMarketApp.isOfficial
                            ? "bg-orange-400/15 text-orange-300"
                            : "bg-blue-400/15 text-blue-300"
                        }`}
                      >
                        {selectedMarketApp.isOfficial ? "官方" : "社区"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-[var(--space-compact-3)]">
                <div className="text-xs font-medium text-[var(--color-text)] mb-2">
                  可执行操作
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => onInstallFromMarket(selectedMarketApp)}
                    disabled={installingSlug === selectedMarketApp.slug}
                    className="px-2.5 py-1.5 rounded text-[11px] bg-orange-400/12 text-orange-300 hover:bg-orange-400/22 disabled:opacity-40 inline-flex items-center gap-1"
                  >
                    <Download className="w-3.5 h-3.5" />
                    {installingSlug === selectedMarketApp.slug
                      ? "安装中..."
                      : "安装"}
                  </button>
                </div>
              </div>

              <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] p-[var(--space-compact-3)]">
                <div className="text-xs font-medium text-[var(--color-text)] mb-2">
                  插件信息
                </div>
                <div className="space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
                  <div>插件标识: {selectedMarketApp.slug}</div>
                  <div>当前版本: v{selectedMarketApp.version}</div>
                  <div>
                    包体大小:{" "}
                    {formatPackageSize(selectedMarketApp.packageSizeBytes)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto pr-1">
            <div className="space-y-[var(--space-compact-3)] min-w-0">
              <FeaturedMarketPanel
                marketTotal={marketTotal}
                marketQuery={marketQuery}
                onMarketQueryChange={onMarketQueryChange}
                onRotateMarket={onRotateMarket}
                marketLoading={marketLoading}
                marketCards={marketCards}
                installingSlug={installingSlug}
                uninstallingPluginId={uninstallingPluginId}
                installedPluginBySlug={installedPluginBySlug}
                onSelectInstalledPlugin={(pluginId) => {
                  onSelectExternalPlugin(pluginId);
                  onSelectMarketApp(null);
                }}
                onSelectMarketApp={(slug) => {
                  onSelectExternalPlugin(null);
                  onSelectMarketApp(slug);
                }}
                onInstallFromMarket={onInstallFromMarket}
                onUninstallPlugin={onUninstallPlugin}
                formatPackageSize={formatPackageSize}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
