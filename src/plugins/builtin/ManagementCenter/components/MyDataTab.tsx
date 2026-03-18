import { useState, useEffect, useCallback } from "react";
import { Database, Cloud, CloudOff, RefreshCw, Loader2 } from "lucide-react";
import { useBookmarkStore } from "@/store/bookmark-store";
import { useSnippetStore } from "@/store/snippet-store";
import { useWorkflowStore } from "@/store/workflow-store";
import { useAuthStore } from "@/store/auth-store";
import { getPersonalSyncPolicy } from "@/core/sync/policy";
import { marksDb } from "@/core/database/marks";
import { aiMemoryDb } from "@/core/ai/memory-store";
import { handleError } from "@/core/errors";

const BRAND = "#F28F36";

interface DataStat {
  label: string;
  count: number;
  syncStatus: "synced" | "local" | "unknown";
}

type PersonalSyncState = "local" | "active" | "expiring_soon" | "expired";

export function MyDataTab() {
  const { isLoggedIn } = useAuthStore();
  const [stats, setStats] = useState<DataStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncState, setSyncState] = useState<PersonalSyncState>("local");
  const [daysToExpire, setDaysToExpire] = useState<number | null>(null);
  const [syncStopAt, setSyncStopAt] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const bookmarks = useBookmarkStore.getState().bookmarks;
      const snippets = useSnippetStore.getState().snippets;
      const workflows = useWorkflowStore.getState().workflows;
      const marks = await marksDb.getAll();
      const memories = await aiMemoryDb.getAll();
      let nextSyncState: PersonalSyncState = "local";
      let nextDaysToExpire: number | null = null;
      let nextSyncStopAt: string | null = null;

      if (isLoggedIn) {
        try {
          const policy = await getPersonalSyncPolicy();
          nextSyncState = policy.status;
          nextDaysToExpire = policy.daysToExpire;
          nextSyncStopAt = policy.stopAt;
        } catch (e) {
          handleError(e, { context: "加载个人同步状态", silent: true });
          nextSyncState = "expired";
        }
      }

      const synced =
        nextSyncState === "active" || nextSyncState === "expiring_soon";

      setStats([
        {
          label: "书签",
          count: bookmarks.filter((bookmark) => !bookmark.deleted).length,
          syncStatus: synced ? "synced" : "local",
        },
        {
          label: "代码片段",
          count: snippets.filter((snippet) => !snippet.deleted).length,
          syncStatus: synced ? "synced" : "local",
        },
        {
          label: "工作流",
          count: workflows.filter((workflow) => !workflow.builtin).length,
          syncStatus: synced ? "synced" : "local",
        },
        {
          label: "笔记",
          count: marks.filter((mark) => !mark.deleted).length,
          syncStatus: synced ? "synced" : "local",
        },
        {
          label: "AI 记忆",
          count: memories.filter((memory) => !memory.deleted).length,
          syncStatus: synced ? "synced" : "local",
        },
      ]);
      setSyncState(nextSyncState);
      setDaysToExpire(nextDaysToExpire);
      setSyncStopAt(nextSyncStopAt);
    } catch (err) {
      handleError(err, { context: "加载我的数据统计" });
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return (
    <div className="w-full space-y-[var(--space-compact-3)]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">我的数据</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            本地数据统计与同步状态
          </p>
        </div>
        <button
          onClick={loadStats}
          className="p-1.5 rounded-md hover:bg-[var(--color-bg-secondary)] transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
        </button>
      </div>

      {/* Sync Status Banner */}
      <div
        className={`rounded-xl p-3 flex items-center gap-2.5 border ${
          syncState === "active"
            ? "bg-green-500/5 border-green-500/20"
            : syncState === "expiring_soon"
              ? "bg-amber-500/10 border-amber-500/30"
              : "bg-orange-500/5 border-orange-500/20"
        }`}
      >
        {syncState === "active" ? (
          <>
            <Cloud className="w-4 h-4 text-green-500 shrink-0" />
            <div>
              <div className="text-xs font-medium text-green-600">
                云同步已启用
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                数据每 60 秒自动同步一次
              </div>
            </div>
          </>
        ) : syncState === "expiring_soon" ? (
          <>
            <Cloud className="w-4 h-4 text-amber-500 shrink-0" />
            <div>
              <div className="text-xs font-medium text-amber-600">
                云同步即将到期
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                {daysToExpire !== null
                  ? `预计 ${daysToExpire} 天后停止云同步`
                  : "即将停止云同步，请及时续费"}
                {syncStopAt
                  ? `（到期：${new Date(syncStopAt).toLocaleString("zh-CN")}）`
                  : ""}
              </div>
            </div>
          </>
        ) : (
          <>
            <CloudOff className="w-4 h-4 text-orange-500 shrink-0" />
            <div>
              <div className="text-xs font-medium text-orange-600">
                {isLoggedIn ? "会员已到期，仅本地存储" : "仅本地存储"}
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                {isLoggedIn
                  ? "续费后恢复云同步能力"
                  : "登录后可开启云同步，跨设备使用数据"}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Data Statistics */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2
            className="w-4 h-4 animate-spin"
            style={{ color: BRAND }}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-[var(--space-compact-2)]">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] hover:border-[#F28F36]/20 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  {stat.label}
                </span>
                {stat.syncStatus === "synced" ? (
                  <Cloud className="w-3 h-3 text-green-500" />
                ) : (
                  <Database className="w-3 h-3 text-[var(--color-text-secondary)]" />
                )}
              </div>
              <div className="text-lg font-bold">{stat.count}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
