import { useCallback } from "react";
import { api } from "@/core/api/client";
import { getPersonalSyncPolicy, isSyncAllowed } from "@/core/sync/policy";
import { handleError } from "@/core/errors";
import { useAuthStore } from "@/store/auth-store";

export interface SyncItem {
  data_id: string;
  content: any;
  version: number;
  deleted: boolean;
}

export function useSync() {
  const { isLoggedIn } = useAuthStore();

  const pull = useCallback(
    async (dataType: string, afterVersion: number = 0) => {
      if (!isLoggedIn) return null;
      try {
        const policy = await getPersonalSyncPolicy();
        if (!isSyncAllowed(policy)) return null;
        return api.get<{ items: any[]; latest_version: number }>("/sync/pull", {
          data_type: dataType,
          after_version: afterVersion,
        });
      } catch (e) {
        handleError(e, { context: `同步拉取 ${dataType}`, silent: true });
        return null;
      }
    },
    [isLoggedIn],
  );

  const push = useCallback(
    async (dataType: string, items: SyncItem[]) => {
      if (!isLoggedIn || items.length === 0) return null;
      try {
        const policy = await getPersonalSyncPolicy();
        if (!isSyncAllowed(policy)) return null;
        return api.post("/sync/push", {
          data_type: dataType,
          items,
        });
      } catch (e) {
        handleError(e, { context: `同步推送 ${dataType}`, silent: true });
        return null;
      }
    },
    [isLoggedIn],
  );

  return { pull, push };
}
