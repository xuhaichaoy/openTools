import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ErrorLevel, handleError } from "@/core/errors";
import {
  getExpiryHint,
  getPersonalSyncPolicy,
  isSyncAllowed,
} from "@/core/sync/policy";
import { useAuthStore } from "@/store/auth-store";
import { useBookmarkStore, bookmarksDb } from "@/store/bookmark-store";
import { useSnippetStore, snippetsDb } from "@/store/snippet-store";
import { useWorkflowStore } from "@/store/workflow-store";
import { useAIStore } from "@/store/ai-store";
import { marksDb, tagsDb } from "@/core/database/marks";
import { aiMemoryDb } from "@/core/ai/memory-store";
import {
  syncSyncableCollection,
  pullData,
  pushData,
  getLastSyncVersion,
  setLastSyncVersion,
} from "@/core/sync/engine";
import { normalizeSyncVersion, nowSyncVersion } from "@/core/sync/version";
import type { Workflow } from "@/core/workflows/types";
import { mergeCloudAIConfig, type AIConfigWithVersion } from "./sync-ai-config";

const SYNC_INTERVAL_MS = 60_000;
const PERSONAL_EXPIRY_REMINDER_KEY = "mtools-sync-personal-expiry-reminded-on";

function shouldNotifyToday(storageKey: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const lastNotified = localStorage.getItem(storageKey);
  if (lastNotified === today) {
    return false;
  }
  localStorage.setItem(storageKey, today);
  return true;
}

export function SyncManager() {
  const { isLoggedIn } = useAuthStore();
  const isSyncing = useRef(false);
  const syncBlockedNotified = useRef(false);

  useEffect(() => {
    if (!isLoggedIn) return;

    const doSync = async () => {
      if (isSyncing.current) return;
      isSyncing.current = true;

      try {
        const personalPolicy = await getPersonalSyncPolicy();
        if (!isSyncAllowed(personalPolicy)) {
          if (!syncBlockedNotified.current) {
            syncBlockedNotified.current = true;
            const hint =
              getExpiryHint(personalPolicy, "个人云同步") ??
              "个人云同步需要会员，仅本地可用";
            handleError(new Error(hint), {
              context: "数据同步",
              level: ErrorLevel.Warning,
              silent: true,
            });
          }
          return;
        }
        syncBlockedNotified.current = false;
        if (
          personalPolicy.status === "expiring_soon" &&
          shouldNotifyToday(PERSONAL_EXPIRY_REMINDER_KEY)
        ) {
          const hint =
            getExpiryHint(personalPolicy, "个人云同步") ?? "个人云同步即将到期";
          handleError(new Error(hint), {
            context: "数据同步",
            level: ErrorLevel.Warning,
          });
        }

        // 1. 同步书签（SyncableCollection — dirty 追踪）
        await syncSyncableCollection({
          dataType: "bookmarks",
          db: bookmarksDb,
        });

        // 2. 同步代码片段（SyncableCollection — dirty 追踪）
        await syncSyncableCollection({
          dataType: "snippets",
          db: snippetsDb,
        });

        // 3. 同步笔记（SyncableCollection — dirty 追踪）
        await syncSyncableCollection({
          dataType: "marks",
          db: marksDb,
        });

        // 4. 同步标签（SyncableCollection — dirty 追踪）
        await syncSyncableCollection({
          dataType: "tags",
          db: tagsDb,
        });

        // 5. 同步长期记忆（受 AI 配置开关控制）
        const aiConfig = useAIStore.getState().config;
        if (aiConfig.enable_long_term_memory && aiConfig.enable_memory_sync) {
          await syncSyncableCollection({
            dataType: "ai_memory",
            db: aiMemoryDb,
          });
        }

        // 刷新 Zustand Store，确保 UI 拿到同步后的最新数据
        const freshBookmarks = await bookmarksDb.getAll();
        useBookmarkStore.setState({ bookmarks: freshBookmarks });
        const freshSnippets = await snippetsDb.getAll();
        useSnippetStore.setState({ snippets: freshSnippets });

        // 6. 同步工作流（自定义工作流，通过 Tauri 后端持久化）
        await syncWorkflows();

        // 7. 同步 AI 配置
        await syncAIConfig();
      } catch (err) {
        handleError(err, { context: "数据同步" });
      } finally {
        isSyncing.current = false;
      }
    };

    doSync();

    const interval = setInterval(doSync, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isLoggedIn]);

  return null;
}

// ── 工作流同步 ──

async function syncWorkflows() {
  const dataType = "workflows";
  const lastVersion = await getLastSyncVersion(dataType);

  // 获取自定义工作流（排除内置和插件工作流）
  const allWorkflows = useWorkflowStore.getState().workflows;
  const customWorkflows = allWorkflows.filter((w) => !w.builtin);

  // 1. PULL — 从云端拉取
  const cloudData = await pullData(dataType, lastVersion);
  if (cloudData && cloudData.items.length > 0) {
    for (const cloudItem of cloudData.items) {
      const localIdx = customWorkflows.findIndex(
        (w) => w.id === cloudItem.data_id,
      );
      const cloudWorkflow: Workflow = {
        id: cloudItem.data_id,
        ...cloudItem.content,
        builtin: false,
      };

      if (cloudItem.deleted) {
        // 云端删除 → 本地也删除
        if (localIdx >= 0) {
          try {
            await invoke("workflow_delete", { id: cloudItem.data_id });
          } catch (e) {
            handleError(e, { context: "删除工作流", silent: true });
          }
        }
      } else if (localIdx >= 0) {
        // 存在则更新（云端版本更新时）
        const localVersion = normalizeSyncVersion(
          (customWorkflows[localIdx] as any).version ?? 0,
          0,
        );
        if (localVersion < cloudItem.version) {
          try {
            await invoke("workflow_update", { workflow: cloudWorkflow });
          } catch (e) {
            handleError(e, { context: "同步更新工作流", silent: true });
          }
        }
      } else {
        // 本地不存在则创建
        try {
          await invoke("workflow_create", { workflow: cloudWorkflow });
        } catch (e) {
          handleError(e, { context: "同步创建工作流", silent: true });
        }
      }
    }
    // 重新加载工作流列表到 Zustand
    await useWorkflowStore.getState().loadWorkflows();
  }

  // 2. PUSH — 推送本地自定义工作流
  const itemsToPush = customWorkflows
    .filter((w) => ((w as any).version ?? 0) > lastVersion || lastVersion === 0)
    .map((w) => {
      const { id, builtin, ...content } = w;
      return {
        data_id: id,
        content,
        version: normalizeSyncVersion(
          (w as any).version ?? w.created_at,
          nowSyncVersion(),
        ),
        deleted: false,
      };
    });

  await pushData(dataType, itemsToPush);

  // 3. 更新版本号
  const allVersions = customWorkflows.map(
    (w) => normalizeSyncVersion((w as any).version ?? w.created_at ?? 0, 0),
  );
  const cloudLatest = normalizeSyncVersion(cloudData?.latest_version ?? 0, 0);
  const newMax = Math.max(
    lastVersion,
    ...allVersions,
    cloudLatest,
  );
  await setLastSyncVersion(dataType, newMax);
}

// ── AI 配置同步 ──

async function syncAIConfig() {
  const dataType = "ai_config";
  const lastVersion = await getLastSyncVersion(dataType);

  let effectiveConfig = useAIStore.getState().config as AIConfigWithVersion;
  let effectiveVersion = normalizeSyncVersion(
    effectiveConfig._syncVersion ?? 0,
    0,
  );

  // 1. PULL
  const cloudData = await pullData(dataType, lastVersion);
  if (cloudData && cloudData.items.length > 0) {
    const cloudItem = cloudData.items[0]; // AI 配置只有一条
    if (cloudItem && cloudItem.version > effectiveVersion) {
      // 云端配置更新 → 合并到本地（保留本地 api_key，不同步密钥）
      const cloudConfig = cloudItem.content;
      const merged = mergeCloudAIConfig(
        effectiveConfig,
        cloudConfig,
        cloudItem.version,
      );

      useAIStore.getState().setConfig(merged);
      await useAIStore.getState().saveConfig(merged);
      effectiveConfig = merged;
      effectiveVersion = normalizeSyncVersion(cloudItem.version, effectiveVersion);
    }
  }

  // 2. PUSH（只推送可跨设备复用的非敏感配置）
  const syncContent = {
    model: effectiveConfig.model,
    temperature: effectiveConfig.temperature,
    max_tokens: effectiveConfig.max_tokens,
    system_prompt: effectiveConfig.system_prompt,
    enable_rag_auto_search: effectiveConfig.enable_rag_auto_search,
    enable_long_term_memory: effectiveConfig.enable_long_term_memory,
    enable_memory_auto_recall: effectiveConfig.enable_memory_auto_recall,
    enable_memory_auto_save: effectiveConfig.enable_memory_auto_save,
    enable_memory_sync: effectiveConfig.enable_memory_sync,
    source: effectiveConfig.source,
    team_id: effectiveConfig.team_id,
    team_config_id: effectiveConfig.team_config_id,
    protocol: effectiveConfig.protocol,
    active_own_key_id: effectiveConfig.active_own_key_id,
  };

  await pushData(dataType, [
    {
      data_id: "default",
      content: syncContent,
      version: effectiveVersion > 0 ? effectiveVersion : nowSyncVersion(),
      deleted: false,
    },
  ]);

  // 3. 更新版本号
  const cloudLatest = normalizeSyncVersion(cloudData?.latest_version ?? 0, 0);
  const newMax = Math.max(
    lastVersion,
    effectiveVersion,
    cloudLatest,
  );
  await setLastSyncVersion(dataType, newMax);
}
