import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Cloud,
  RefreshCw,
  Check,
  Loader2,
  ArrowUpFromLine,
  ArrowDownToLine,
  AlertCircle,
  Zap,
  CloudOff,
} from "lucide-react";
import type { PluginContext } from "@/core/plugin-system/context";
import {
  getExpiryHint,
  getPersonalSyncPolicy,
  isSyncAllowed,
  type PersonalSyncPolicy,
} from "@/core/sync/policy";
import { normalizeSyncVersion, nowSyncVersion } from "@/core/sync/version";
import { bookmarksDb, useBookmarkStore } from "@/store/bookmark-store";
import { snippetsDb, useSnippetStore } from "@/store/snippet-store";
import { useWorkflowStore } from "@/store/workflow-store";
import { marksDb, tagsDb } from "@/core/database/marks";
import { aiMemoryDb } from "@/core/ai/memory-store";
import { useAIStore } from "@/store/ai-store";
import { useAuthStore } from "@/store/auth-store";
import { getServerUrl } from "@/store/server-store";
import { handleError } from "@/core/errors";
import type { Workflow } from "@/core/workflows/types";

interface CloudSyncPluginProps {
  onBack?: () => void;
  context?: PluginContext;
}

interface SyncRow {
  data_id: string;
  content: any;
  version: number;
  deleted: boolean;
}

interface SyncPullResponse {
  items: SyncRow[];
  latest_version: number;
}

function getServerUrlV1(): string {
  return `${getServerUrl()}/v1`;
}

function mapCloudItems(items: SyncRow[]): any[] {
  const now = Date.now();
  return items.map((row) => ({
    ...row.content,
    id: row.data_id,
    deleted: row.deleted,
    _version: row.version,
    _dirty: false,
    _syncedAt: now,
  }));
}

async function hasAnyLocalData(includeAIMemory: boolean): Promise<boolean> {
  const [bookmarks, snippets, marks, tags, workflows, memories] = await Promise.all([
    bookmarksDb.getAll(),
    snippetsDb.getAll(),
    marksDb.getAll(),
    tagsDb.getAll(),
    invoke<Workflow[]>("workflow_list").catch(() => []),
    includeAIMemory ? aiMemoryDb.getAll() : Promise.resolve([]),
  ]);

  return (
    bookmarks.some((item) => !item.deleted) ||
    snippets.some((item) => !item.deleted) ||
    workflows.length > 0 ||
    marks.some((item) => !item.deleted) ||
    tags.some((item) => !item.deleted) ||
    memories.some((item) => !item.deleted)
  );
}

const CloudSyncPlugin: React.FC<CloudSyncPluginProps> = ({
  onBack,
  context,
}) => {
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PersonalSyncPolicy | null>(null);

  const { token, isLoggedIn } = useAuthStore();

  const refreshPolicy = useCallback(async () => {
    if (!isLoggedIn) {
      setPolicy(null);
      return null;
    }
    const next = await getPersonalSyncPolicy();
    setPolicy(next);
    return next;
  }, [isLoggedIn]);

  useEffect(() => {
    if (!context) return;
    const value = context.storage.getItem("cloud-sync-last");
    if (value) setLastSync(value);
  }, [context]);

  useEffect(() => {
    if (!isLoggedIn) {
      setConnected(false);
      return;
    }
    refreshPolicy().catch((e) => {
      handleError(e, { context: "加载同步状态", silent: true });
    });
  }, [isLoggedIn, refreshPolicy]);

  const syncBlockedHint = useMemo(() => {
    if (!isLoggedIn) return "请先登录账号";
    if (!policy) return null;
    if (isSyncAllowed(policy)) return null;
    return getExpiryHint(policy, "个人云同步") || "个人云同步不可用";
  }, [isLoggedIn, policy]);

  const canOperate =
    connected && !syncing && isLoggedIn && (!policy || isSyncAllowed(policy));

  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setError(null);

    try {
      if (!token) {
        setConnected(false);
        setError("请先登录账号");
        return;
      }

      const nextPolicy = await refreshPolicy();
      if (nextPolicy && !isSyncAllowed(nextPolicy)) {
        setConnected(false);
        setError(getExpiryHint(nextPolicy, "个人云同步") || "同步不可用");
        return;
      }

      const ok = await invoke<boolean>("mtools_sync_test", {
        token,
        baseUrl: getServerUrl(),
      });
      setConnected(ok);
      if (!ok) setError("无法连接到 mTools 服务器");
    } catch (e) {
      setConnected(false);
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }, [token, refreshPolicy]);

  const handlePush = useCallback(async () => {
    setSyncing(true);
    setError(null);

    try {
      if (!canOperate || !token) {
        throw new Error(syncBlockedHint || "同步不可用");
      }
      const latestPolicy = await refreshPolicy();
      if (latestPolicy && !isSyncAllowed(latestPolicy)) {
        throw new Error(
          getExpiryHint(latestPolicy, "个人云同步") || "个人云同步不可用",
        );
      }

      const aiConfig = useAIStore.getState().config;
      const memorySyncEnabled =
        aiConfig.enable_long_term_memory && aiConfig.enable_memory_sync;

      const [bookmarks, snippets, marks, tags, memories] = await Promise.all([
        bookmarksDb.getAll(),
        snippetsDb.getAll(),
        marksDb.getAll(),
        tagsDb.getAll(),
        memorySyncEnabled ? aiMemoryDb.getAll() : Promise.resolve([]),
      ]);
      const workflows = useWorkflowStore
        .getState()
        .workflows.filter((w) => !w.builtin);

      await invoke("mtools_sync_push", {
        token,
        baseUrl: getServerUrlV1(),
        request: {
          data_type: "bookmarks",
          items: bookmarks.map((b) => ({
            data_id: b.id,
            content: b,
            version: normalizeSyncVersion(
              (b as any)._version ?? (b as any).version,
              nowSyncVersion(),
            ),
            deleted: b.deleted || false,
          })),
        },
      });

      await invoke("mtools_sync_push", {
        token,
        baseUrl: getServerUrlV1(),
        request: {
          data_type: "snippets",
          items: snippets.map((s) => ({
            data_id: s.id,
            content: s,
            version: normalizeSyncVersion(
              (s as any)._version ?? (s as any).version,
              nowSyncVersion(),
            ),
            deleted: s.deleted || false,
          })),
        },
      });

      await invoke("mtools_sync_push", {
        token,
        baseUrl: getServerUrlV1(),
        request: {
          data_type: "workflows",
          items: workflows.map((w) => ({
            data_id: w.id,
            content: w,
            version: normalizeSyncVersion(
              (w as any).version ?? w.created_at,
              nowSyncVersion(),
            ),
            deleted: false,
          })),
        },
      });

      await invoke("mtools_sync_push", {
        token,
        baseUrl: getServerUrlV1(),
        request: {
          data_type: "marks",
          items: marks.map((m) => ({
            data_id: m.id,
            content: m,
            version: normalizeSyncVersion(
              (m as any)._version ?? m.version,
              nowSyncVersion(),
            ),
            deleted: m.deleted || false,
          })),
        },
      });

      await invoke("mtools_sync_push", {
        token,
        baseUrl: getServerUrlV1(),
        request: {
          data_type: "tags",
          items: tags.map((t) => ({
            data_id: t.id,
            content: t,
            version: normalizeSyncVersion(
              (t as any)._version ?? t.version,
              nowSyncVersion(),
            ),
            deleted: t.deleted || false,
          })),
        },
      });

      if (memorySyncEnabled) {
        await invoke("mtools_sync_push", {
          token,
          baseUrl: getServerUrlV1(),
          request: {
            data_type: "ai_memory",
            items: memories.map((memory) => ({
              data_id: memory.id,
              content: memory,
              version: normalizeSyncVersion(
                (memory as any)._version ?? memory.updated_at,
                nowSyncVersion(),
              ),
              deleted: memory.deleted || false,
            })),
          },
        });
      }

      const syncAt = new Date().toLocaleString("zh-CN");
      setLastSync(syncAt);
      if (context) {
        context.storage.setItem("cloud-sync-last", syncAt);
      }
    } catch (e) {
      setError(`推送失败: ${e}`);
    } finally {
      setSyncing(false);
    }
  }, [canOperate, context, refreshPolicy, syncBlockedHint, token]);

  const handlePull = useCallback(async () => {
    setSyncing(true);
    setError(null);

    try {
      if (!canOperate || !token) {
        throw new Error(syncBlockedHint || "同步不可用");
      }
      const latestPolicy = await refreshPolicy();
      if (latestPolicy && !isSyncAllowed(latestPolicy)) {
        throw new Error(
          getExpiryHint(latestPolicy, "个人云同步") || "个人云同步不可用",
        );
      }

      const aiConfig = useAIStore.getState().config;
      const memorySyncEnabled =
        aiConfig.enable_long_term_memory && aiConfig.enable_memory_sync;
      const hasLocalData = await hasAnyLocalData(memorySyncEnabled);
      if (hasLocalData) {
        const confirmed = window.confirm(
          memorySyncEnabled
            ? "从云端拉取会覆盖当前本地同步数据（书签/短语/工作流/笔记/标签/AI记忆）。是否继续？"
            : "从云端拉取会覆盖当前本地同步数据（书签/短语/工作流/笔记/标签）。是否继续？",
        );
        if (!confirmed) return;
      }

      const bookmarkResp = await invoke<SyncPullResponse>("mtools_sync_pull", {
        token,
        baseUrl: getServerUrlV1(),
        dataType: "bookmarks",
      });
      const bookmarkItems = mapCloudItems(bookmarkResp.items || []);
      await bookmarksDb.setAll(bookmarkItems as any);
      useBookmarkStore.setState({ bookmarks: bookmarkItems as any, loaded: true });

      const snippetResp = await invoke<SyncPullResponse>("mtools_sync_pull", {
        token,
        baseUrl: getServerUrlV1(),
        dataType: "snippets",
      });
      const snippetItems = mapCloudItems(snippetResp.items || []);
      await snippetsDb.setAll(snippetItems as any);
      useSnippetStore.setState({ snippets: snippetItems as any, loaded: true });

      const marksResp = await invoke<SyncPullResponse>("mtools_sync_pull", {
        token,
        baseUrl: getServerUrlV1(),
        dataType: "marks",
      });
      await marksDb.setAll(mapCloudItems(marksResp.items || []) as any);
      marksDb.invalidateCache();

      const tagsResp = await invoke<SyncPullResponse>("mtools_sync_pull", {
        token,
        baseUrl: getServerUrlV1(),
        dataType: "tags",
      });
      await tagsDb.setAll(mapCloudItems(tagsResp.items || []) as any);
      tagsDb.invalidateCache();

      if (memorySyncEnabled) {
        const memoryResp = await invoke<SyncPullResponse>("mtools_sync_pull", {
          token,
          baseUrl: getServerUrlV1(),
          dataType: "ai_memory",
        });
        await aiMemoryDb.setAll(mapCloudItems(memoryResp.items || []) as any);
        aiMemoryDb.invalidateCache();
      }

      const workflowResp = await invoke<SyncPullResponse>("mtools_sync_pull", {
        token,
        baseUrl: getServerUrlV1(),
        dataType: "workflows",
      });

      const existingCustom = useWorkflowStore
        .getState()
        .workflows.filter((w) => !w.builtin);
      const existingById = new Map(existingCustom.map((wf) => [wf.id, wf]));
      const cloudItems = workflowResp.items || [];
      const cloudActiveItems = cloudItems.filter((item) => !item.deleted);
      const cloudActiveIdSet = new Set(cloudActiveItems.map((item) => item.data_id));

      // 删除云端不存在（或已删除）的本地工作流
      for (const localWorkflow of existingCustom) {
        if (cloudActiveIdSet.has(localWorkflow.id)) continue;
        try {
          await invoke("workflow_delete", { id: localWorkflow.id });
        } catch (e) {
          handleError(e, {
            context: `删除本地工作流 ${localWorkflow.id}`,
            silent: true,
          });
        }
      }

      // 对云端工作流做增量更新/创建，避免“先全删后重建”的数据丢失窗口
      for (const item of cloudActiveItems) {
        const workflowPayload = {
          ...item.content,
          id: item.data_id,
          builtin: false,
        };
        try {
          if (existingById.has(item.data_id)) {
            await invoke("workflow_update", { workflow: workflowPayload });
          } else {
            await invoke("workflow_create", { workflow: workflowPayload });
          }
        } catch (e) {
          handleError(e, {
            context: `拉取工作流 ${item.data_id}`,
            silent: true,
          });
        }
      }
      await useWorkflowStore.getState().loadWorkflows();

      const syncAt = new Date().toLocaleString("zh-CN");
      setLastSync(syncAt);
      if (context) {
        context.storage.setItem("cloud-sync-last", syncAt);
      }
    } catch (e) {
      setError(`拉取失败: ${e}`);
    } finally {
      setSyncing(false);
    }
  }, [canOperate, context, refreshPolicy, syncBlockedHint, token]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
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
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <Zap className="w-4 h-4 text-amber-500" />
            当前同步通道：mTools Cloud
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)] break-all">
            服务地址：{getServerUrlV1()}
          </div>
          <button
            onClick={handleTestConnection}
            disabled={testing || syncing || !isLoggedIn}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium disabled:opacity-50"
          >
            {testing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            测试连接
          </button>
        </div>

        {!isLoggedIn && (
          <div className="flex items-start gap-2 p-3 bg-orange-500/10 text-orange-600 rounded-lg text-sm">
            <CloudOff className="w-4 h-4 shrink-0 mt-0.5" />
            请先登录后使用云同步
          </div>
        )}

        {policy?.status === "expiring_soon" && (
          <div className="flex items-start gap-2 p-3 bg-amber-500/10 text-amber-700 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <div>会员即将到期，云同步将自动停止。</div>
              <div className="text-xs mt-1 opacity-80">
                {policy.daysToExpire !== null
                  ? `预计 ${policy.daysToExpire} 天后到期`
                  : "请及时续费"}
                {policy.stopAt
                  ? `（${new Date(policy.stopAt).toLocaleString("zh-CN")}）`
                  : ""}
              </div>
            </div>
          </div>
        )}

        {syncBlockedHint && isLoggedIn && (
          <div className="flex items-start gap-2 p-3 bg-orange-500/10 text-orange-600 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {syncBlockedHint}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-500/10 text-red-500 rounded-lg text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <div className="space-y-3">
          <div className="flex gap-2">
            <button
              onClick={handlePush}
              disabled={!canOperate}
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
              disabled={!canOperate}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-[var(--color-bg-secondary)] rounded-lg hover:bg-[var(--color-bg-tertiary)] text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {syncing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ArrowDownToLine className="w-4 h-4" />
              )}
              从云端拉取（覆盖本地）
            </button>
          </div>

          <div className="text-xs text-[var(--color-text-secondary)] rounded-lg border border-[var(--color-border)] p-3 bg-[var(--color-bg-secondary)]">
            手动拉取会按数据集覆盖本地内容；当本地存在数据时会先弹出二次确认。
            {lastSync && (
              <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                上次同步：{lastSync}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CloudSyncPlugin;
