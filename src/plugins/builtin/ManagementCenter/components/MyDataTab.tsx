import { useState, useEffect } from "react";
import { Database, Cloud, CloudOff, RefreshCw, Loader2 } from "lucide-react";
import { useBookmarkStore } from "@/store/bookmark-store";
import { useSnippetStore } from "@/store/snippet-store";
import { useWorkflowStore } from "@/store/workflow-store";
import { useAuthStore } from "@/store/auth-store";
import { marksDb } from "@/core/database/marks";

const BRAND = "#F28F36";

interface DataStat {
  label: string;
  count: number;
  syncStatus: "synced" | "local" | "unknown";
}

export function MyDataTab() {
  const { isLoggedIn } = useAuthStore();
  const [stats, setStats] = useState<DataStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    setLoading(true);
    try {
      const bookmarks = useBookmarkStore.getState().bookmarks;
      const snippets = useSnippetStore.getState().snippets;
      const workflows = useWorkflowStore.getState().workflows;
      const marks = await marksDb.getAll();

      setStats([
        {
          label: "书签",
          count: bookmarks.filter((b: any) => !b.deleted).length,
          syncStatus: isLoggedIn ? "synced" : "local",
        },
        {
          label: "代码片段",
          count: snippets.filter((s: any) => !s.deleted).length,
          syncStatus: isLoggedIn ? "synced" : "local",
        },
        {
          label: "工作流",
          count: workflows.filter((w: any) => !w.builtin).length,
          syncStatus: isLoggedIn ? "synced" : "local",
        },
        {
          label: "笔记",
          count: marks.filter((m: any) => !m.deleted).length,
          syncStatus: isLoggedIn ? "synced" : "local",
        },
      ]);
    } catch (err) {
      console.error("Failed to load stats:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-4">
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
          isLoggedIn
            ? "bg-green-500/5 border-green-500/20"
            : "bg-orange-500/5 border-orange-500/20"
        }`}
      >
        {isLoggedIn ? (
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
        ) : (
          <>
            <CloudOff className="w-4 h-4 text-orange-500 shrink-0" />
            <div>
              <div className="text-xs font-medium text-orange-600">
                仅本地存储
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                登录后可开启云同步，跨设备使用数据
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
        <div className="grid grid-cols-2 gap-3">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="bg-[var(--color-bg)] rounded-xl p-4 border border-[var(--color-border)] hover:border-[#F28F36]/20 transition-colors"
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
