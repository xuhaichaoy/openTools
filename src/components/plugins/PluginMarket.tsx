import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ArrowLeft, Code, RefreshCw, Package } from "lucide-react";
import { handleError } from "@/core/errors";
import { usePluginStore } from "@/store/plugin-store";
import { useAppStore } from "@/store/app-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readFile } from "@tauri-apps/plugin-fs";
import { useDragWindow } from "@/hooks/useDragWindow";
import { api, ApiError } from "@/core/api/client";
import { registry } from "@/core/plugin-system/registry";
import {
  builtinPlugins as builtinPluginCatalog,
  isBuiltinPluginInstallRequired,
} from "@/plugins/builtin";
import { PluginsIcon } from "@/components/icons/animated";
import { getServerUrl } from "@/store/server-store";
import { BuiltinPluginList } from "@/components/plugins/market/BuiltinPluginList";
import { ExternalPluginPanel } from "@/components/plugins/market/ExternalPluginPanel";
import { PluginDeveloperPanel } from "@/components/plugins/market/PluginDeveloperPanel";
import { getPrimarySupportedFeature } from "@/core/plugin-system/platform";
import type {
  PluginCompatMatrixItem,
  PluginDevTraceItem,
  PluginDevWatchStatus,
  PluginInstance,
  PluginMarketApp,
  PluginMarketPackage,
  PluginPreflightReport,
} from "@/core/plugin-system/types";

interface PluginDevFileChangedPayload {
  pluginIds?: string[];
  paths?: string[];
}

interface PluginDevReloadErrorPayload {
  errors?: Array<{ path?: string; error?: string }>;
}

export function PluginMarket({ onBack }: { onBack: () => void }) {
  const {
    plugins,
    loadPlugins,
    openPlugin,
    addDevDir,
    removeDevDir,
    setPluginEnabled,
    devDirs,
  } = usePluginStore();
  const [activeTab, setActiveTab] = useState<"builtin" | "external" | "dev">(
    "builtin",
  );
  const [loading, setLoading] = useState(false);
  const [devLogs, setDevLogs] = useState<string[]>([]);
  const [developerMode, setDeveloperMode] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchStatus, setWatchStatus] = useState<PluginDevWatchStatus | null>(
    null,
  );
  const [traceItems, setTraceItems] = useState<PluginDevTraceItem[]>([]);
  const [tracePluginFilter, setTracePluginFilter] = useState<string>("");
  const [traceMethodFilter, setTraceMethodFilter] = useState<string>("");
  const [simPluginId, setSimPluginId] = useState<string>("");
  const [simFeatureCode, setSimFeatureCode] = useState<string>("");
  const [simEventType, setSimEventType] = useState<string>("onPluginEnter");
  const [simPayload, setSimPayload] = useState<string>("{}");
  const [storagePluginId, setStoragePluginId] = useState<string>("");
  const [compatMatrix, setCompatMatrix] = useState<PluginCompatMatrixItem[]>(
    [],
  );
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightReport, setPreflightReport] =
    useState<PluginPreflightReport | null>(null);
  const [preflightFilePath, setPreflightFilePath] = useState<string>("");
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string>("");
  const [marketQuery, setMarketQuery] = useState("");
  const [marketBatchSeed, setMarketBatchSeed] = useState(0);
  const [marketApps, setMarketApps] = useState<PluginMarketApp[]>([]);
  const [marketTotal, setMarketTotal] = useState(0);
  const [marketLoading, setMarketLoading] = useState(false);
  const [debouncedMarketQuery, setDebouncedMarketQuery] = useState("");
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [uninstallingPluginId, setUninstallingPluginId] = useState<
    string | null
  >(null);
  const [uninstallDialog, setUninstallDialog] = useState<{
    pluginId: string;
    pluginName: string;
    dataProfile?: string;
  } | null>(null);
  const uninstallResolveRef = useRef<
    ((choice: "cancel" | "uninstall" | "uninstall_and_clear") => void) | null
  >(null);
  const [selectedExternalPluginId, setSelectedExternalPluginId] = useState<
    string | null
  >(null);
  const [selectedMarketAppSlug, setSelectedMarketAppSlug] = useState<
    string | null
  >(null);
  const { onMouseDown } = useDragWindow();

  // 获取内置插件目录（过滤掉「插件」和「设置」这类系统页面）
  const builtinPlugins = useMemo(() => {
    const systemViewIds = new Set(["plugins", "settings"]);
    return builtinPluginCatalog
      .filter((p) => !systemViewIds.has(p.viewId))
      .filter((p) => !isBuiltinPluginInstallRequired(p.id))
      .map((plugin) => {
        return {
          ...plugin,
          installRequired: false,
          installed: true,
        };
      });
  }, []);

  const traceMethods = useMemo(() => {
    const methods = new Set(traceItems.map((t) => t.method));
    return Array.from(methods).sort();
  }, [traceItems]);

  const filteredTraces = useMemo(() => {
    return traceItems.filter((item) => {
      if (tracePluginFilter && item.pluginId !== tracePluginFilter)
        return false;
      if (traceMethodFilter && item.method !== traceMethodFilter) return false;
      return true;
    });
  }, [traceItems, tracePluginFilter, traceMethodFilter]);

  const permissionSummary = useMemo(() => {
    const allow = filteredTraces.filter(
      (t) => t.permissionDecision === "allow",
    ).length;
    const denyItems = filteredTraces.filter(
      (t) => t.permissionDecision === "deny",
    );
    return {
      allow,
      deny: denyItems.length,
      lastDenyReason: denyItems[0]?.permissionReason || "",
    };
  }, [filteredTraces]);

  const externalPlugins = useMemo(() => {
    return plugins.filter((p) => !p.isBuiltin);
  }, [plugins]);

  const selectedExternalPlugin = useMemo(() => {
    if (!selectedExternalPluginId) return null;
    return (
      externalPlugins.find(
        (plugin) => plugin.id === selectedExternalPluginId,
      ) || null
    );
  }, [externalPlugins, selectedExternalPluginId]);

  const marketCards = useMemo(() => {
    if (marketApps.length === 0) return [];
    const start = marketBatchSeed % marketApps.length;
    const rotated = [...marketApps.slice(start), ...marketApps.slice(0, start)];
    return rotated.slice(0, 6);
  }, [marketApps, marketBatchSeed]);

  const selectedMarketApp = useMemo(() => {
    if (!selectedMarketAppSlug) return null;
    const key = selectedMarketAppSlug.toLowerCase();
    return marketApps.find((item) => item.slug.toLowerCase() === key) || null;
  }, [marketApps, selectedMarketAppSlug]);

  const installedPluginBySlug = useMemo(() => {
    const map = new Map<string, (typeof externalPlugins)[number]>();
    externalPlugins.forEach((plugin) => {
      if (plugin.slug) {
        map.set(plugin.slug.toLowerCase(), plugin);
      }
    });
    return map;
  }, [externalPlugins]);

  const resolveDownloadUrl = (downloadUrl: string): string => {
    if (
      downloadUrl.startsWith("http://") ||
      downloadUrl.startsWith("https://")
    ) {
      return downloadUrl;
    }
    const base = getServerUrl().replace(/\/$/, "");
    if (downloadUrl.startsWith("/")) {
      return `${base}${downloadUrl}`;
    }
    return `${base}/${downloadUrl}`;
  };

  const formatPackageSize = (bytes?: number | null): string => {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
      return "大小待发布";
    }
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}KB`;
    return `${Math.round(bytes / 1024 / 102.4) / 10}MB`;
  };

  const resolveDefaultFeatureCode = useCallback((plugin?: PluginInstance) => {
    if (!plugin) return "";
    return (
      getPrimarySupportedFeature(plugin)?.code ||
      plugin.manifest.features[0]?.code ||
      ""
    );
  }, []);

  const reportInstall = async (slug: string) => {
    try {
      await api.post(
        `/plugins/market/apps/${encodeURIComponent(slug)}/install-report`,
      );
      setMarketApps((prev) =>
        prev.map((item) =>
          item.slug.toLowerCase() === slug.toLowerCase()
            ? { ...item, installs: item.installs + 1 }
            : item,
        ),
      );
    } catch (e) {
      handleError(e, { context: "上报插件安装量", silent: true });
    }
  };

  const loadMarketApps = useCallback(async (query: string) => {
    try {
      setMarketLoading(true);
      const data = await api.get<{ items: PluginMarketApp[]; total: number }>(
        "/plugins/market/apps",
        {
          q: query || undefined,
          limit: 60,
          offset: 0,
        },
      );
      setMarketApps(Array.isArray(data.items) ? data.items : []);
      setMarketTotal(typeof data.total === "number" ? data.total : 0);
      setMarketBatchSeed(0);
    } catch (e) {
      handleError(e, { context: "加载插件市场" });
      setMarketApps([]);
      setMarketTotal(0);
    } finally {
      setMarketLoading(false);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    await loadPlugins();
    setLoading(false);
    if (activeTab === "external") {
      await loadMarketApps(debouncedMarketQuery);
    }
  }, [loadPlugins, activeTab, loadMarketApps, debouncedMarketQuery]);

  const loadTraceBuffer = useCallback(async () => {
    try {
      const traces = await invoke<PluginDevTraceItem[]>(
        "plugin_dev_get_trace_buffer",
        {
          pluginId: tracePluginFilter || null,
        },
      );
      setTraceItems(traces);
    } catch (e) {
      handleError(e, { context: "加载 API 追踪", silent: true });
    }
  }, [tracePluginFilter]);

  useEffect(() => {
    void handleRefresh();
    // 加载开发者模式设置
    invoke<string>("load_general_settings")
      .then((json) => {
        try {
          const s = JSON.parse(json);
          if (s.developerMode) setDeveloperMode(true);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, [handleRefresh]);

  useEffect(() => {
    if (!developerMode || activeTab !== "dev") return;
    loadWatchStatus();
    void loadTraceBuffer();
    loadCompatMatrix();

    const timer = window.setInterval(() => {
      void loadTraceBuffer();
    }, 1200);

    const unlistenTasks = [
      listen<PluginDevFileChangedPayload>(
        "plugin-dev:file-changed",
        async (event) => {
          const pluginIds = Array.isArray(event.payload?.pluginIds)
            ? event.payload.pluginIds
            : [];
          addDevLog(
            `✓ 文件变化: ${pluginIds.join(", ") || "未知插件"} (${event.payload?.paths?.length || 0} files)`,
          );
          await loadPlugins();
          void loadTraceBuffer();
        },
      ),
      listen<PluginDevReloadErrorPayload>(
        "plugin-dev:reload-error",
        (event) => {
          const errors = Array.isArray(event.payload?.errors)
            ? event.payload.errors
            : [];
          addDevLog(
            `✗ 重载失败: ${
              errors
                .map((e) => e.path || "unknown")
                .slice(0, 2)
                .join(", ") || "清单解析错误"
            }`,
          );
          loadWatchStatus();
        },
      ),
      listen<PluginDevWatchStatus>("plugin-dev:watch-status", (event) => {
        setWatchStatus(event.payload);
      }),
    ];

    return () => {
      window.clearInterval(timer);
      unlistenTasks.forEach((task) => task.then((fn) => fn()).catch(() => {}));
    };
  }, [developerMode, activeTab, loadPlugins, loadTraceBuffer]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedMarketQuery(marketQuery.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [marketQuery]);

  useEffect(() => {
    if (activeTab !== "external") return;
    loadMarketApps(debouncedMarketQuery);
  }, [activeTab, debouncedMarketQuery, loadMarketApps]);

  useEffect(() => {
    if (!selectedExternalPluginId) return;
    if (
      externalPlugins.some((plugin) => plugin.id === selectedExternalPluginId)
    )
      return;
    setSelectedExternalPluginId(null);
  }, [externalPlugins, selectedExternalPluginId]);

  useEffect(() => {
    if (!selectedMarketAppSlug) return;
    const key = selectedMarketAppSlug.toLowerCase();
    if (marketApps.some((item) => item.slug.toLowerCase() === key)) return;
    setSelectedMarketAppSlug(null);
  }, [marketApps, selectedMarketAppSlug]);

  useEffect(() => {
    if (!selectedMarketAppSlug) return;
    const installed = installedPluginBySlug.get(
      selectedMarketAppSlug.toLowerCase(),
    );
    if (!installed) return;
    setSelectedExternalPluginId(installed.id);
    setSelectedMarketAppSlug(null);
  }, [installedPluginBySlug, selectedMarketAppSlug]);

  const handleRotateMarket = () => {
    setMarketBatchSeed((prev) => prev + 3);
  };

  const loadWatchStatus = async () => {
    try {
      const status = await invoke<PluginDevWatchStatus>(
        "plugin_dev_watch_status",
      );
      setWatchStatus(status);
    } catch (e) {
      handleError(e, { context: "获取监听状态", silent: true });
    }
  };

  const loadCompatMatrix = async () => {
    try {
      const data = await api.get<{ matrix: PluginCompatMatrixItem[] }>(
        "/plugins/compat-matrix",
      );
      setCompatMatrix(Array.isArray(data?.matrix) ? data.matrix : []);
    } catch (e) {
      if (e instanceof ApiError && e.code === "NOT_FOUND") return;
      handleError(e, { context: "加载兼容矩阵", silent: true });
    }
  };

  const handleInstallFromMarket = async (appItem: PluginMarketApp) => {
    try {
      setInstallingSlug(appItem.slug);
      try {
        const pkg = await api.get<PluginMarketPackage>(
          `/plugins/market/apps/${encodeURIComponent(appItem.slug)}/package`,
        );
        const downloadUrl = resolveDownloadUrl(pkg.downloadUrl);

        await invoke("plugin_market_install", {
          slug: pkg.slug,
          version: pkg.version,
          downloadUrl,
          sha256: pkg.packageSha256,
          sizeBytes: pkg.packageSizeBytes,
        });
        await loadPlugins();
        await reportInstall(appItem.slug);
        addDevLog(`✓ 安装成功: ${appItem.name} ${pkg.version}`);
      } catch (e) {
        const shouldFallbackToLocalOfficial =
          developerMode === true &&
          appItem.isOfficial === true &&
          e instanceof ApiError &&
          e.code === "PLUGIN_PACKAGE_NOT_FOUND";

        if (!shouldFallbackToLocalOfficial) {
          throw e;
        }

        await invoke("plugin_market_install_official_local", {
          slug: appItem.slug,
        });
        await loadPlugins();
        addDevLog(`✓ 安装成功(本地官方包): ${appItem.name}`);
      }
    } catch (e) {
      handleError(e, { context: `安装插件 ${appItem.name}` });
      addDevLog(`✗ 安装失败: ${appItem.name} ${String(e)}`);
    } finally {
      setInstallingSlug(null);
    }
  };

  const showUninstallDialog = (
    pluginId: string,
    pluginName: string,
    dataProfile?: string,
  ): Promise<"cancel" | "uninstall" | "uninstall_and_clear"> =>
    new Promise((resolve) => {
      uninstallResolveRef.current = resolve;
      setUninstallDialog({ pluginId, pluginName, dataProfile });
    });

  const confirmUninstall = (choice: "uninstall" | "uninstall_and_clear") => {
    setUninstallDialog(null);
    uninstallResolveRef.current?.(choice);
    uninstallResolveRef.current = null;
  };

  const cancelUninstall = () => {
    setUninstallDialog(null);
    uninstallResolveRef.current?.("cancel");
    uninstallResolveRef.current = null;
  };

  const handleUninstallPlugin = async (
    pluginId: string,
    pluginName: string,
    dataProfile?: string,
  ) => {
    const choice = await showUninstallDialog(pluginId, pluginName, dataProfile);
    if (choice === "cancel") return;

    try {
      setUninstallingPluginId(pluginId);
      if (
        choice === "uninstall_and_clear" &&
        dataProfile &&
        dataProfile !== "none"
      ) {
        await invoke("plugin_market_clear_data", { dataProfile });
      }
      await invoke("plugin_market_uninstall", { pluginId });
      await loadPlugins();
      addDevLog(`✓ 卸载成功: ${pluginName}`);
    } catch (e) {
      handleError(e, { context: `卸载插件 ${pluginName}` });
      addDevLog(`✗ 卸载失败: ${pluginName} ${String(e)}`);
    } finally {
      setUninstallingPluginId(null);
    }
  };

  const handleWatchStart = async () => {
    const watchDirs =
      devDirs.length > 0
        ? devDirs
        : plugins.filter((p) => !p.isBuiltin).map((p) => p.dirPath);

    if (watchDirs.length === 0) {
      addDevLog("✗ 请先添加开发目录");
      return;
    }
    setWatchBusy(true);
    try {
      const status = await invoke<PluginDevWatchStatus>(
        "plugin_dev_watch_start",
        {
          dirPaths: watchDirs,
          pluginId: tracePluginFilter || null,
        },
      );
      setWatchStatus(status);
      addDevLog(`✓ 已开始监听 ${status.watchedDirs.length} 个目录`);
    } catch (e) {
      handleError(e, { context: "启动监听" });
      addDevLog(`✗ 启动监听失败: ${String(e)}`);
    } finally {
      setWatchBusy(false);
    }
  };

  const handleWatchStop = async () => {
    setWatchBusy(true);
    try {
      const status = await invoke<PluginDevWatchStatus>(
        "plugin_dev_watch_stop",
      );
      setWatchStatus(status);
      addDevLog("✓ 已停止监听");
    } catch (e) {
      handleError(e, { context: "停止监听" });
      addDevLog(`✗ 停止监听失败: ${String(e)}`);
    } finally {
      setWatchBusy(false);
    }
  };

  const handleClearTrace = async () => {
    try {
      await invoke("plugin_dev_clear_trace_buffer", {
        pluginId: tracePluginFilter || null,
      });
      await loadTraceBuffer();
      addDevLog("✓ 已清空追踪缓存");
    } catch (e) {
      handleError(e, { context: "清空追踪缓存" });
    }
  };

  const handleExportTrace = async () => {
    try {
      const selected = await save({
        title: "导出 API 追踪",
        defaultPath: `plugin-dev-trace-${Date.now()}.json`,
      });
      if (!selected) return;
      await writeTextFile(selected, JSON.stringify(filteredTraces, null, 2));
      addDevLog(`✓ 追踪已导出: ${selected}`);
    } catch (e) {
      handleError(e, { context: "导出追踪" });
    }
  };

  const handleSimulateEvent = async () => {
    try {
      if (!simPluginId || !simFeatureCode) {
        addDevLog("✗ 请先选择插件与功能");
        return;
      }
      await invoke("plugin_dev_simulate_event", {
        pluginId: simPluginId,
        featureCode: simFeatureCode,
        eventType: simEventType,
        payloadJson: simPayload || "{}",
      });
      addDevLog(
        `✓ 已注入事件 ${simEventType} -> ${simPluginId}/${simFeatureCode}`,
      );
    } catch (e) {
      handleError(e, { context: "注入事件" });
      addDevLog(`✗ 事件注入失败: ${String(e)}`);
    }
  };

  const handleOpenDevtools = async () => {
    try {
      await invoke("plugin_dev_open_devtools", {
        windowLabelOrEmbedTarget: "main",
      });
    } catch (e) {
      handleError(e, { context: "打开 DevTools" });
    }
  };

  const handleStorageDump = async () => {
    try {
      if (!storagePluginId) {
        addDevLog("✗ 请先选择存储目标插件");
        return;
      }
      const data = await invoke<Record<string, unknown>>(
        "plugin_dev_storage_dump",
        {
          pluginId: storagePluginId,
        },
      );
      const selected = await save({
        title: "导出插件本地存储",
        defaultPath: `${storagePluginId}-storage.json`,
      });
      if (!selected) return;
      await writeTextFile(selected, JSON.stringify(data, null, 2));
      addDevLog(`✓ 已导出本地存储: ${selected}`);
    } catch (e) {
      handleError(e, { context: "导出插件存储" });
    }
  };

  const handleStorageClear = async () => {
    try {
      if (!storagePluginId) {
        addDevLog("✗ 请先选择存储目标插件");
        return;
      }
      await invoke("plugin_dev_storage_clear", { pluginId: storagePluginId });
      addDevLog(`✓ 已清空插件存储: ${storagePluginId}`);
    } catch (e) {
      handleError(e, { context: "清空插件存储" });
    }
  };

  const handlePreflight = async () => {
    try {
      const selected = await open({
        title: "选择插件 ZIP 包",
        filters: [{ name: "Zip", extensions: ["zip"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      setPreflightLoading(true);
      const filePath = selected as string;
      const bytes = await readFile(filePath);
      const fileName =
        filePath.split("/").pop()?.split("\\").pop() || "plugin.zip";
      const formData = new FormData();
      formData.append("file", new Blob([bytes]), fileName);
      const report = await api.upload<PluginPreflightReport>(
        "/plugins/submissions/preflight",
        formData,
      );
      setPreflightReport(report);
      setPreflightFilePath(filePath);
      setSubmitMessage("");
      addDevLog(`✓ 预检完成: ${fileName}`);
    } catch (e) {
      handleError(e, { context: "插件预检" });
      addDevLog(`✗ 预检失败: ${String(e)}`);
    } finally {
      setPreflightLoading(false);
    }
  };

  const handleSubmitPlugin = async () => {
    if (!preflightReport?.ok || !preflightFilePath) {
      addDevLog("✗ 请先完成预检并确保通过");
      return;
    }
    try {
      setSubmitLoading(true);
      const bytes = await readFile(preflightFilePath);
      const fileName =
        preflightFilePath.split("/").pop()?.split("\\").pop() || "plugin.zip";
      const formData = new FormData();
      formData.append("file", new Blob([bytes]), fileName);
      const result = await api.upload<{
        submissionId: string;
        status: string;
        message: string;
      }>("/plugins/submissions", formData);
      setSubmitMessage(`${result.message}（${result.status}）`);
      addDevLog(`✓ 提交成功: ${result.submissionId}`);
    } catch (e) {
      handleError(e, { context: "正式提交插件" });
      addDevLog(`✗ 提交失败: ${String(e)}`);
    } finally {
      setSubmitLoading(false);
    }
  };

  useEffect(() => {
    if (plugins.length === 0) return;
    if (!simPluginId || !plugins.some((p) => p.id === simPluginId)) {
      const first = plugins[0];
      setSimPluginId(first.id);
      setSimFeatureCode(resolveDefaultFeatureCode(first));
    } else {
      const plugin = plugins.find((p) => p.id === simPluginId);
      if (
        plugin &&
        !plugin.manifest.features.some((f) => f.code === simFeatureCode)
      ) {
        setSimFeatureCode(resolveDefaultFeatureCode(plugin));
      }
    }
    if (!storagePluginId || !plugins.some((p) => p.id === storagePluginId)) {
      setStoragePluginId(plugins[0].id);
    }
  }, [
    plugins,
    simPluginId,
    simFeatureCode,
    storagePluginId,
    resolveDefaultFeatureCode,
  ]);

  const handleOpenPluginDir = async () => {
    try {
      const selected = await open({
        directory: true,
        title: "选择插件目录",
      });
      if (selected) {
        addDevLog(`正在加载目录: ${selected}`);
        await addDevDir(selected as string);
        const count = usePluginStore.getState().plugins.length;
        addDevLog(`✓ 插件列表已刷新，共 ${count} 个插件`);
      }
    } catch (e) {
      handleError(e, { context: "选择插件目录" });
      addDevLog(`✗ 加载失败: ${e}`);
    }
  };

  const handleRemoveDevDir = async (dirPath: string) => {
    addDevLog(`移除开发目录: ${dirPath}`);
    await removeDevDir(dirPath);
    addDevLog(
      `✓ 已移除，剩余 ${usePluginStore.getState().plugins.length} 个插件`,
    );
  };

  const addDevLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setDevLogs((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 50));
  };

  const handleOpenSelectedExternalPlugin = (
    plugin: PluginInstance,
    featureCode: string,
  ) => {
    const slug = plugin.slug?.toLowerCase();
    if (slug && registry.getByViewId(slug)) {
      useAppStore.getState().requestNavigate(slug);
      return;
    }
    if (plugin.manifest.mtools?.openMode === "embed") {
      const feature = plugin.manifest.features.find(
        (f) => f.code === featureCode,
      );
      useAppStore.getState().requestEmbed({
        pluginId: plugin.id,
        featureCode,
        title: feature?.explain || plugin.manifest.pluginName,
      });
      return;
    }
    openPlugin(plugin.id, featureCode);
  };

  const handleRequestExternalEmbed = (
    plugin: PluginInstance,
    featureCode: string,
  ) => {
    const feature = plugin.manifest.features.find(
      (item) => item.code === featureCode,
    );
    useAppStore.getState().requestEmbed({
      pluginId: plugin.id,
      featureCode,
      title: feature?.explain || plugin.manifest.pluginName,
    });
  };

  const handleSimPluginChange = (pluginId: string) => {
    setSimPluginId(pluginId);
    const plugin = plugins.find((item) => item.id === pluginId);
    setSimFeatureCode(resolveDefaultFeatureCode(plugin));
  };

  return (
    <div className="bg-[var(--color-bg)] overflow-hidden flex flex-col h-full">
      {/* 顶部 */}
      <div
        className="flex items-center justify-between px-[var(--space-compact-3)] py-[var(--space-compact-2)] border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <PluginsIcon className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-medium text-[var(--color-text)]">
            插件
          </span>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          title="刷新"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {/* Tab */}
      <div className="flex gap-1 px-[var(--space-compact-3)] pt-[var(--space-compact-1)]">
        <button
          onClick={() => setActiveTab("builtin")}
          className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
            activeTab === "builtin"
              ? "border-orange-400 text-orange-400 bg-[var(--color-bg-secondary)]"
              : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          }`}
        >
          <Package className="w-3 h-3" />
          内置 ({builtinPlugins.length})
        </button>
        <button
          onClick={() => setActiveTab("external")}
          className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
            activeTab === "external"
              ? "border-orange-400 text-orange-400 bg-[var(--color-bg-secondary)]"
              : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          }`}
        >
          <PluginsIcon className="w-3 h-3" />
          扩展 ({externalPlugins.length})
        </button>
        {developerMode && (
          <button
            onClick={() => setActiveTab("dev")}
            className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded-t-lg border-b-2 transition-colors ${
              activeTab === "dev"
                ? "border-orange-400 text-orange-400 bg-[var(--color-bg-secondary)]"
                : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            <Code className="w-3 h-3" />
            开发者
          </button>
        )}
      </div>
      <div className="h-px bg-[var(--color-border)]" />

      {/* 内容 */}
      <div className="flex-1 overflow-hidden min-h-0 p-[var(--space-compact-1)]">
        {/* 内置插件 */}
        {activeTab === "builtin" && (
          <BuiltinPluginList
            plugins={builtinPlugins}
            onOpen={(viewId) => {
              useAppStore.getState().addRecentTool(viewId);
              useAppStore.getState().requestNavigate(viewId);
            }}
          />
        )}

        {/* 扩展插件（外部 uTools/Rubick） */}
        {activeTab === "external" && (
          <ExternalPluginPanel
            loading={loading}
            externalPlugins={externalPlugins}
            selectedExternalPluginId={selectedExternalPluginId}
            selectedExternalPlugin={selectedExternalPlugin}
            selectedMarketApp={selectedMarketApp}
            marketTotal={marketTotal}
            marketQuery={marketQuery}
            marketLoading={marketLoading}
            marketCards={marketCards}
            installingSlug={installingSlug}
            uninstallingPluginId={uninstallingPluginId}
            installedPluginBySlug={installedPluginBySlug}
            onSelectExternalPlugin={setSelectedExternalPluginId}
            onSelectMarketApp={setSelectedMarketAppSlug}
            onOpenPluginDir={handleOpenPluginDir}
            onRotateMarket={handleRotateMarket}
            onMarketQueryChange={setMarketQuery}
            onInstallFromMarket={handleInstallFromMarket}
            onUninstallPlugin={handleUninstallPlugin}
            onOpenSelectedExternalPlugin={handleOpenSelectedExternalPlugin}
            onTogglePluginEnabled={setPluginEnabled}
            onRequestEmbed={handleRequestExternalEmbed}
            formatPackageSize={formatPackageSize}
          />
        )}

        {activeTab === "dev" && developerMode && (
          <PluginDeveloperPanel
            plugins={plugins}
            devDirs={devDirs}
            onOpenPluginDir={handleOpenPluginDir}
            onRemoveDevDir={handleRemoveDevDir}
            watchBusy={watchBusy}
            watchStatus={watchStatus}
            onWatchStart={handleWatchStart}
            onWatchStop={handleWatchStop}
            onOpenDevtools={handleOpenDevtools}
            onExportTrace={handleExportTrace}
            onClearTrace={handleClearTrace}
            tracePluginFilter={tracePluginFilter}
            onTracePluginFilterChange={setTracePluginFilter}
            traceMethodFilter={traceMethodFilter}
            onTraceMethodFilterChange={setTraceMethodFilter}
            traceMethods={traceMethods}
            permissionSummary={permissionSummary}
            filteredTraces={filteredTraces}
            simPluginId={simPluginId}
            onSimPluginChange={handleSimPluginChange}
            simFeatureCode={simFeatureCode}
            onSimFeatureCodeChange={setSimFeatureCode}
            simEventType={simEventType}
            onSimEventTypeChange={setSimEventType}
            simPayload={simPayload}
            onSimPayloadChange={setSimPayload}
            onSimulateEvent={handleSimulateEvent}
            storagePluginId={storagePluginId}
            onStoragePluginChange={setStoragePluginId}
            onStorageDump={handleStorageDump}
            onStorageClear={handleStorageClear}
            preflightLoading={preflightLoading}
            onPreflight={handlePreflight}
            submitLoading={submitLoading}
            onSubmitPlugin={handleSubmitPlugin}
            preflightReport={preflightReport}
            submitMessage={submitMessage}
            compatMatrix={compatMatrix}
            devLogs={devLogs}
          />
        )}
      </div>

      {/* 卸载确认 Dialog（原生 confirm/prompt 会让窗口失焦隐藏，改用内嵌） */}
      {uninstallDialog && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 rounded-xl"
          onClick={cancelUninstall}
        >
          <div
            className="bg-(--color-bg) border border-(--color-border) rounded-xl shadow-xl p-6 w-80 flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold text-(--color-text)">
                卸载插件
              </p>
              <p className="text-xs text-(--color-text-secondary)">
                确认卸载插件「{uninstallDialog.pluginName}」吗？此操作不可恢复。
              </p>
            </div>

            {uninstallDialog.dataProfile &&
              uninstallDialog.dataProfile !== "none" && (
                <label className="flex items-center gap-2 text-xs text-(--color-text-secondary) cursor-pointer select-none">
                  <input
                    id="clearDataCheckbox"
                    type="checkbox"
                    className="rounded"
                    defaultChecked={false}
                  />
                  同时清除插件本地数据
                </label>
              )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={cancelUninstall}
                className="px-3 py-1.5 text-xs rounded-lg border border-(--color-border) text-(--color-text-secondary) hover:bg-(--color-bg-hover) transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const checkbox = document.getElementById(
                    "clearDataCheckbox",
                  ) as HTMLInputElement | null;
                  confirmUninstall(
                    checkbox?.checked ? "uninstall_and_clear" : "uninstall",
                  );
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                确认卸载
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
