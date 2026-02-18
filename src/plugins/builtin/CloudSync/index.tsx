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
  Zap,
} from "lucide-react";
import type { PluginContext } from "@/core/plugin-system/context";
import { useAuthStore } from "@/store/auth-store";
import { useBookmarkStore } from "@/store/bookmark-store";
import { useSnippetStore } from "@/store/snippet-store";
import { useWorkflowStore } from "@/store/workflow-store";
import { marksDb, tagsDb } from "@/core/database/marks";
import { getServerUrl } from "@/store/server-store";

function getServerUrlV1(): string {
  return `${getServerUrl()}/v1`;
}

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
  {
    id: "mtools",
    name: "mTools Cloud",
    icon: <Zap className="w-5 h-5" />,
    color: "text-amber-600 bg-amber-50",
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
  context?: PluginContext;
}

const CloudSyncPlugin: React.FC<CloudSyncPluginProps> = ({
  onBack,
  context,
}) => {
  const storage = context?.storage;
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
      } else if (config.provider === "mtools") {
        const { token } = useAuthStore.getState();
        if (!token) {
          setError("请先登录账号");
          setConnected(false);
          return;
        }
        const ok = await invoke<boolean>("mtools_sync_test", {
          token,
          baseUrl: getServerUrl(),
        });
        setConnected(ok);
        if (!ok) setError("无法连接到 mTools 服务器");
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
      } else if (config.provider !== "mtools") {
        await invoke("git_sync_push", {
          provider: config.provider,
          token: config.token,
          repo: config.repo,
          branch: config.branch,
        });
      } else if (config.provider === "mtools") {
        const { token } = useAuthStore.getState();
        if (!token) throw new Error("未登录");

        // 1. 同步书签
        const bookmarks = useBookmarkStore.getState().bookmarks;
        await invoke("mtools_sync_push", {
          token,
          baseUrl: getServerUrlV1(),
          request: {
            data_type: "bookmarks",
            items: bookmarks.map((b) => ({
              data_id: b.id,
              content: b,
              version: b.version || 1,
              deleted: b.deleted || false,
            })),
          },
        });

        // 2. 同步代码片段
        const snippets = useSnippetStore.getState().snippets;
        await invoke("mtools_sync_push", {
          token,
          baseUrl: getServerUrlV1(),
          request: {
            data_type: "snippets",
            items: snippets.map((s) => ({
              data_id: s.id,
              content: s,
              version: s.version || 1,
              deleted: s.deleted || false,
            })),
          },
        });

        // 3. 同步工作流
        const workflows = useWorkflowStore.getState().workflows.filter(w => !w.builtin);
        await invoke("mtools_sync_push", {
          token,
          baseUrl: getServerUrlV1(),
          request: {
            data_type: "workflows",
            items: workflows.map((w) => ({
              data_id: w.id,
              content: w,
              version: (w as any).version || 1,
              deleted: false,
            })),
          },
        });

        // 4. 同步 Marks (笔记)
        const marks = await marksDb.getAll();
        await invoke("mtools_sync_push", {
          token,
          baseUrl: getServerUrlV1(),
          request: {
            data_type: "marks",
            items: marks.map((m) => ({
              data_id: m.id,
              content: m,
              version: m.version || 1,
              deleted: m.deleted || false,
            })),
          },
        });

        // 5. 同步 Tags
        const tags = await tagsDb.getAll();
        await invoke("mtools_sync_push", {
          token,
          baseUrl: getServerUrlV1(),
          request: {
            data_type: "tags",
            items: tags.map((t) => ({
              data_id: t.id,
              content: t,
              version: t.version || 1,
              deleted: t.deleted || false,
            })),
          },
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
      if (config.provider === "webdav") {
        // WebDAV pull not implemented yet
      } else if (config.provider !== "mtools") {
        await invoke("git_sync_pull", {
          provider: config.provider,
          token: config.token,
          repo: config.repo,
          branch: config.branch,
        });
      } else if (config.provider === "mtools") {
        const { token } = useAuthStore.getState();
        if (!token) throw new Error("未登录");

        // 1. 拉取书签
        const bookmarkResp = await invoke<any>("mtools_sync_pull", {
          token,
          baseUrl: getServerUrlV1(),
          dataType: "bookmarks",
        });
        if (bookmarkResp.items && bookmarkResp.items.length > 0) {
            const items = bookmarkResp.items.map((i: any) => i.content);
            localStorage.setItem("mtools-bookmarks", JSON.stringify(items));
            useBookmarkStore.setState({ bookmarks: items, loaded: true });
        }

        // 2. 拉取代码片段
        const snippetResp = await invoke<any>("mtools_sync_pull", {
          token,
          baseUrl: getServerUrlV1(),
          dataType: "snippets",
        });
        if (snippetResp.items && snippetResp.items.length > 0) {
            const items = snippetResp.items.map((i: any) => i.content);
            localStorage.setItem("mtools-snippets", JSON.stringify(items));
            useSnippetStore.setState({ snippets: items, loaded: true });
        }

        // 3. 拉取工作流
        const workflowResp = await invoke<any>("mtools_sync_pull", {
          token,
          baseUrl: getServerUrlV1(),
          dataType: "workflows",
        });
        if (workflowResp.items && workflowResp.items.length > 0) {
            for (const item of workflowResp.items) {
                await invoke("workflow_create", { workflow: item.content });
            }
            useWorkflowStore.getState().loadWorkflows();
        }

        // 4. 拉取 Marks
        const marksResp = await invoke<any>("mtools_sync_pull", {
          token,
          baseUrl: getServerUrlV1(),
          dataType: "marks",
        });
        if (marksResp.items && marksResp.items.length > 0) {
            // 这里简单全量同步，后续应做增量合并
            const items = marksResp.items.map((i: any) => i.content);
            const { writeTextFile } = await import("@tauri-apps/plugin-fs");
            const { BaseDirectory: BD } = await import("@tauri-apps/plugin-fs");
            await writeTextFile("mtools-db/marks.json", JSON.stringify(items, null, 2), {
                baseDir: BD.AppData,
            });
            marksDb.invalidateCache();
        }

        // 5. 拉取 Tags
        const tagsResp = await invoke<any>("mtools_sync_pull", {
          token,
          baseUrl: getServerUrlV1(),
          dataType: "tags",
        });
        if (tagsResp.items && tagsResp.items.length > 0) {
            const items = tagsResp.items.map((i: any) => i.content);
            const { writeTextFile } = await import("@tauri-apps/plugin-fs");
            const { BaseDirectory: BD } = await import("@tauri-apps/plugin-fs");
            await writeTextFile("mtools-db/tags.json", JSON.stringify(items, null, 2), {
                baseDir: BD.AppData,
            });
            tagsDb.invalidateCache();
        }
      }
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
