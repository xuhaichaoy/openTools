import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/store/auth-store";
import { bookmarksDb } from "@/store/bookmark-store";
import { snippetsDb } from "@/store/snippet-store";
import { useWorkflowStore } from "@/store/workflow-store";
import { useAIStore } from "@/store/ai-store";
import { marksDb, tagsDb } from "@/core/database/marks";
import {
  syncSyncableCollection,
  pullData,
  pushData,
  getLastSyncVersion,
  setLastSyncVersion,
} from "@/core/sync/engine";
import type { Workflow } from "@/core/workflows/types";

const SYNC_INTERVAL_MS = 60_000;

export function SyncManager() {
  const { isLoggedIn } = useAuthStore();
  const isSyncing = useRef(false);

  useEffect(() => {
    if (!isLoggedIn) return;

    const doSync = async () => {
      if (isSyncing.current) return;
      isSyncing.current = true;

      try {
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

        // 5. 同步工作流（自定义工作流，通过 Tauri 后端持久化）
        await syncWorkflows();

        // 6. 同步 AI 配置
        await syncAIConfig();
      } catch (err) {
        console.error("[Sync] Error:", err);
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
          } catch {
            /* 可能已不存在 */
          }
        }
      } else if (localIdx >= 0) {
        // 存在则更新（云端版本更新时）
        const localVersion = (customWorkflows[localIdx] as any).version ?? 0;
        if (localVersion < cloudItem.version) {
          try {
            await invoke("workflow_update", { workflow: cloudWorkflow });
          } catch (e) {
            console.error("[Sync] Update workflow failed:", e);
          }
        }
      } else {
        // 本地不存在则创建
        try {
          await invoke("workflow_create", { workflow: cloudWorkflow });
        } catch (e) {
          console.error("[Sync] Create workflow failed:", e);
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
        version: (w as any).version ?? w.created_at ?? Date.now(),
        deleted: false,
      };
    });

  await pushData(dataType, itemsToPush);

  // 3. 更新版本号
  const allVersions = customWorkflows.map(
    (w) => (w as any).version ?? w.created_at ?? 0,
  );
  const newMax = Math.max(
    lastVersion,
    ...allVersions,
    cloudData?.latest_version ?? 0,
  );
  await setLastSyncVersion(dataType, newMax);
}

// ── AI 配置同步 ──

async function syncAIConfig() {
  const dataType = "ai_config";
  const lastVersion = await getLastSyncVersion(dataType);

  const config = useAIStore.getState().config;
  const localVersion = (config as any)._syncVersion ?? 0;

  // 1. PULL
  const cloudData = await pullData(dataType, lastVersion);
  if (cloudData && cloudData.items.length > 0) {
    const cloudItem = cloudData.items[0]; // AI 配置只有一条
    if (cloudItem && cloudItem.version > localVersion) {
      // 云端配置更新 → 合并到本地（保留本地 api_key，不同步密钥）
      const cloudConfig = cloudItem.content;
      const merged = {
        ...config,
        model: cloudConfig.model ?? config.model,
        temperature: cloudConfig.temperature ?? config.temperature,
        max_tokens: cloudConfig.max_tokens ?? config.max_tokens,
        system_prompt: cloudConfig.system_prompt ?? config.system_prompt,
        enable_advanced_tools:
          cloudConfig.enable_advanced_tools ?? config.enable_advanced_tools,
        enable_rag_auto_search:
          cloudConfig.enable_rag_auto_search ?? config.enable_rag_auto_search,
        source: cloudConfig.source ?? config.source,
        _syncVersion: cloudItem.version,
      };
      useAIStore.getState().setConfig(merged);
      await useAIStore.getState().saveConfig(merged);
    }
  }

  // 2. PUSH（只推送非敏感配置）
  const syncContent = {
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    system_prompt: config.system_prompt,
    enable_advanced_tools: config.enable_advanced_tools,
    enable_rag_auto_search: config.enable_rag_auto_search,
    source: config.source,
  };

  await pushData(dataType, [
    {
      data_id: "default",
      content: syncContent,
      version: localVersion > 0 ? localVersion : Date.now(),
      deleted: false,
    },
  ]);

  // 3. 更新版本号
  const newMax = Math.max(
    lastVersion,
    localVersion,
    cloudData?.latest_version ?? 0,
  );
  await setLastSyncVersion(dataType, newMax);
}
