import { api } from "@/core/api/client";
import { load } from "@tauri-apps/plugin-store";
import type { SyncableCollection, SyncMeta } from "@/core/database/index";
import { handleError } from "@/core/errors";

export interface SyncItem {
  data_id: string;
  content: any;
  version: number;
  deleted: boolean;
}

export interface SyncPullResponse {
  items: Array<{
    data_id: string;
    content: any;
    version: number;
    deleted: boolean;
  }>;
  latest_version: number;
}

// ── 版本追踪（持久化到 Tauri Store） ──

let _syncVersionStore: Awaited<ReturnType<typeof load>> | null = null;
async function getSyncVersionStore() {
  if (!_syncVersionStore) {
    _syncVersionStore = await load("sync-versions.json", {
      defaults: {},
      autoSave: true,
    });
  }
  return _syncVersionStore;
}

export async function getLastSyncVersion(dataType: string): Promise<number> {
  const store = await getSyncVersionStore();
  return (await store.get<number>(`version_${dataType}`)) ?? 0;
}

export async function setLastSyncVersion(dataType: string, version: number): Promise<void> {
  const store = await getSyncVersionStore();
  await store.set(`version_${dataType}`, version);
  await store.save();
}

// ── 底层网络操作 ──

export async function pullData(dataType: string, afterVersion: number = 0): Promise<SyncPullResponse | null> {
  try {
    return await api.get<SyncPullResponse>("/sync/pull", {
      data_type: dataType,
      after_version: afterVersion,
    });
  } catch (e) {
    handleError(e, { context: `同步拉取 ${dataType}`, silent: true });
    return null;
  }
}

export async function pushData(dataType: string, items: SyncItem[]): Promise<boolean> {
  if (items.length === 0) return true;
  try {
    await api.post("/sync/push", { data_type: dataType, items });
    return true;
  } catch (e) {
    handleError(e, { context: `同步推送 ${dataType}`, silent: true });
    return false;
  }
}

// ── SyncableCollection 同步（marks, tags, bookmarks, snippets — 使用 dirty/mergeFromCloud API） ──

export async function syncSyncableCollection<T extends { id: string } & SyncMeta>(opts: {
  dataType: string;
  db: SyncableCollection<T>;
}): Promise<void> {
  const { dataType, db } = opts;
  const lastVersion = await getLastSyncVersion(dataType);

  // 1. PULL — 从云端拉取增量，合并到本地
  const cloudData = await pullData(dataType, lastVersion);
  if (cloudData && cloudData.items.length > 0) {
    await db.mergeFromCloud(cloudData.items);
  }

  // 2. PUSH — 推送本地 dirty 条目
  const dirtyItems = await db.getDirty();
  if (dirtyItems.length > 0) {
    const itemsToPush: SyncItem[] = dirtyItems.map((item) => {
      const { id, _version, _dirty, _syncedAt, ...content } = item as any;
      return {
        data_id: id,
        content,
        version: _version ?? Date.now(),
        deleted: content.deleted ?? false,
      };
    });

    const ok = await pushData(dataType, itemsToPush);
    if (ok) {
      await db.markSynced(dirtyItems.map((i) => i.id));
    }
  }

  // 3. 更新版本号
  const allItems = await db.getAll();
  const allVersions = allItems.map((i) => i._version ?? 0);
  const newMax = Math.max(
    lastVersion,
    ...allVersions,
    cloudData?.latest_version ?? 0,
  );
  await setLastSyncVersion(dataType, newMax);
}
