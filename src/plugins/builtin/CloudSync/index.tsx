import React, { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Cloud,
  RefreshCw,
  Check,
  X,
  Loader2,
  Github,
  Server,
  Settings2,
  ArrowUpFromLine,
  ArrowDownToLine,
  AlertCircle,
} from "lucide-react";
import type { PluginStorage } from "@/core/plugin-system/storage";

interface SyncProvider {
  id: string;
  name: string;
  icon: React.ReactNode;
  color: string;
}

const PROVIDERS: SyncProvider[] = [
  {
    id: "github",
    name: "GitHub",
    icon: <Github className="w-5 h-5" />,
    color: "text-gray-800 bg-gray-100",
  },
  {
    id: "gitee",
    name: "Gitee",
    icon: <Server className="w-5 h-5" />,
    color: "text-red-600 bg-red-50",
  },
  {
    id: "gitlab",
    name: "GitLab",
    icon: <Server className="w-5 h-5" />,
    color: "text-orange-600 bg-orange-50",
  },
  {
    id: "webdav",
    name: "WebDAV",
    icon: <Cloud className="w-5 h-5" />,
    color: "text-blue-600 bg-blue-50",
  },
];

interface SyncConfig {
  provider: string;
  token: string;
  repo: string;
  branch: string;
  webdavUrl?: string;
  webdavUsername?: string;
  webdavPassword?: string;
  webdavPath?: string;
  autoSync: boolean;
}

const defaultConfig: SyncConfig = {
  provider: "",
  token: "",
  repo: "",
  branch: "main",
  autoSync: false,
};

interface CloudSyncPluginProps {
  onBack?: () => void;
  storage?: PluginStorage;
}

const CloudSyncPlugin: React.FC<CloudSyncPluginProps> = ({
  onBack,
  storage,
}) => {
  const [config, setConfig] = useState<SyncConfig>(defaultConfig);
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(true);

  // 加载保存的配置
  useEffect(() => {
    if (storage) {
      const saved = storage.getItem("sync-config");
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setConfig(parsed);
          setShowConfig(false);
        } catch {
          // ignore
        }
      }
    }
  }, [storage]);

  const saveConfig = useCallback(
    (newConfig: SyncConfig) => {
      setConfig(newConfig);
      if (storage) {
        storage.setItem("sync-config", JSON.stringify(newConfig));
      }
    },
    [storage],
  );

  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      if (config.provider === "webdav") {
        const ok = await invoke<boolean>("webdav_test", {
          url: config.webdavUrl || "",
          username: config.webdavUsername || "",
          password: config.webdavPassword || "",
          path: config.webdavPath || "/",
        });
        setConnected(ok);
      } else {
        const status = await invoke<{
          provider: string;
          connected: boolean;
        }>("git_sync_status", {
          provider: config.provider,
          token: config.token,
          repo: config.repo,
        });
        setConnected(status.connected);
        if (!status.connected) {
          setError("连接失败，请检查 Token 和仓库名");
        }
      }
    } catch (e) {
      setError(String(e));
      setConnected(false);
    } finally {
      setTesting(false);
    }
  }, [config]);

  const handlePush = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      if (config.provider === "webdav") {
        // WebDAV 同步
        await invoke("webdav_create_dir", {
          url: config.webdavUrl,
          username: config.webdavUsername,
          password: config.webdavPassword,
          path: `${config.webdavPath || ""}/51toolbox`,
        });
      } else {
        await invoke("git_sync_push", {
          provider: config.provider,
          token: config.token,
          repo: config.repo,
          branch: config.branch,
        });
      }
      setLastSync(new Date().toLocaleString("zh-CN"));
    } catch (e) {
      setError(`推送失败: ${e}`);
    } finally {
      setSyncing(false);
    }
  }, [config]);

  const handlePull = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      await invoke("git_sync_pull", {
        provider: config.provider,
        token: config.token,
        repo: config.repo,
        branch: config.branch,
      });
      setLastSync(new Date().toLocaleString("zh-CN"));
    } catch (e) {
      setError(`拉取失败: ${e}`);
    } finally {
      setSyncing(false);
    }
  }, [config]);

  const isWebDAV = config.provider === "webdav";

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
            >
              ←
            </button>
          )}
          <Cloud className="w-5 h-5 text-sky-500" />
          <h2 className="font-semibold">云同步</h2>
          {connected && (
            <span className="flex items-center gap-1 text-xs text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">
              <Check className="w-3 h-3" /> 已连接
            </span>
          )}
        </div>
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="p-1.5 rounded-md hover:bg-[var(--color-bg-secondary)]"
        >
          <Settings2 className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 配置区域 */}
        {showConfig && (
          <div className="space-y-3 p-4 bg-[var(--color-bg-secondary)] rounded-lg">
            <h3 className="text-sm font-medium">同步配置</h3>

            {/* 平台选择 */}
            <div className="grid grid-cols-4 gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => saveConfig({ ...config, provider: p.id })}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ${
                    config.provider === p.id
                      ? "border-sky-500 bg-sky-500/10"
                      : "border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]"
                  }`}
                >
                  {p.icon}
                  <span className="text-xs">{p.name}</span>
                </button>
              ))}
            </div>

            {config.provider && !isWebDAV && (
              <>
                <input
                  type="password"
                  value={config.token}
                  onChange={(e) =>
                    saveConfig({ ...config, token: e.target.value })
                  }
                  placeholder="Access Token"
                  className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                />
                <input
                  type="text"
                  value={config.repo}
                  onChange={(e) =>
                    saveConfig({ ...config, repo: e.target.value })
                  }
                  placeholder="owner/repo"
                  className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                />
                <input
                  type="text"
                  value={config.branch}
                  onChange={(e) =>
                    saveConfig({ ...config, branch: e.target.value })
                  }
                  placeholder="分支 (默认 main)"
                  className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                />
              </>
            )}

            {isWebDAV && (
              <>
                <input
                  type="text"
                  value={config.webdavUrl || ""}
                  onChange={(e) =>
                    saveConfig({ ...config, webdavUrl: e.target.value })
                  }
                  placeholder="WebDAV URL (如 https://dav.example.com)"
                  className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={config.webdavUsername || ""}
                    onChange={(e) =>
                      saveConfig({ ...config, webdavUsername: e.target.value })
                    }
                    placeholder="用户名"
                    className="flex-1 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                  />
                  <input
                    type="password"
                    value={config.webdavPassword || ""}
                    onChange={(e) =>
                      saveConfig({ ...config, webdavPassword: e.target.value })
                    }
                    placeholder="密码"
                    className="flex-1 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                  />
                </div>
                <input
                  type="text"
                  value={config.webdavPath || ""}
                  onChange={(e) =>
                    saveConfig({ ...config, webdavPath: e.target.value })
                  }
                  placeholder="远程路径 (如 /backup)"
                  className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                />
              </>
            )}

            {config.provider && (
              <button
                onClick={handleTestConnection}
                disabled={testing}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium disabled:opacity-50"
              >
                {testing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                测试连接
              </button>
            )}
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-500/10 text-red-500 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {/* 同步操作 */}
        {config.provider && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <button
                onClick={handlePush}
                disabled={syncing || !connected}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-[var(--color-bg-secondary)] rounded-lg hover:bg-[var(--color-bg-tertiary)] text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {syncing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowUpFromLine className="w-4 h-4" />
                )}
                推送到云端
              </button>
              <button
                onClick={handlePull}
                disabled={syncing || !connected}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-[var(--color-bg-secondary)] rounded-lg hover:bg-[var(--color-bg-tertiary)] text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {syncing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowDownToLine className="w-4 h-4" />
                )}
                从云端拉取
              </button>
            </div>

            {/* 自动同步 */}
            <label className="flex items-center justify-between p-3 bg-[var(--color-bg-secondary)] rounded-lg cursor-pointer">
              <div>
                <p className="text-sm font-medium">自动同步</p>
                <p className="text-xs text-[var(--color-text-secondary)]">
                  笔记变更时自动推送
                </p>
              </div>
              <input
                type="checkbox"
                checked={config.autoSync}
                onChange={(e) =>
                  saveConfig({ ...config, autoSync: e.target.checked })
                }
                className="rounded"
              />
            </label>

            {/* 上次同步时间 */}
            {lastSync && (
              <p className="text-xs text-[var(--color-text-secondary)] text-center">
                上次同步: {lastSync}
              </p>
            )}
          </div>
        )}

        {!config.provider && (
          <div className="text-center text-[var(--color-text-secondary)] py-12">
            <Cloud className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p className="text-sm">选择同步平台开始配置</p>
            <p className="text-xs mt-1 opacity-60">
              支持 GitHub、Gitee、GitLab 和 WebDAV
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default CloudSyncPlugin;
