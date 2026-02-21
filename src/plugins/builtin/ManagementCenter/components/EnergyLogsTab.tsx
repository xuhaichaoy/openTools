import { useState, useEffect, useCallback } from "react";
import { Zap, Loader2, ArrowDown, ArrowUp } from "lucide-react";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";

const BRAND = "#F28F36";

interface EnergyLog {
  id: string;
  amount: number;
  balance_after: number;
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  source: string;
  created_at: string;
}

export function EnergyLogsTab() {
  const [logs, setLogs] = useState<EnergyLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ logs: EnergyLog[] }>("/ai/energy/logs", {
        limit,
        offset,
      });
      setLogs(res.logs || []);
    } catch (err) {
      handleError(err, { context: "获取能量流水" });
    } finally {
      setLoading(false);
    }
  }, [limit, offset]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return (
    <div className="max-w-xl mx-auto space-y-[var(--space-compact-3)]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">能量流水</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            AI 能量消耗和充值记录
          </p>
        </div>
        <button
          onClick={fetchLogs}
          className="text-[10px] font-medium hover:underline"
          style={{ color: BRAND }}
        >
          刷新
        </button>
      </div>

      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2
              className="w-4 h-4 animate-spin"
              style={{ color: BRAND }}
            />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center py-10 text-[var(--color-text-secondary)]">
            <Zap className="w-6 h-6 mb-2 opacity-20" />
            <p className="text-xs">暂无记录</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {logs.map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between px-[var(--space-compact-3)] py-2 hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  {log.amount < 0 ? (
                    <ArrowDown className="w-3.5 h-3.5 text-red-500" />
                  ) : (
                    <ArrowUp className="w-3.5 h-3.5 text-green-500" />
                  )}
                  <div>
                    <div className="text-xs font-medium">
                      {log.model || log.source}
                    </div>
                    {log.prompt_tokens != null && (
                      <div className="text-[10px] text-[var(--color-text-secondary)]">
                        输入 {log.prompt_tokens} / 输出{" "}
                        {log.completion_tokens} tokens
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={`text-xs font-bold ${
                      log.amount < 0 ? "text-red-500" : "text-green-500"
                    }`}
                  >
                    {log.amount > 0 ? "+" : ""}
                    {log.amount}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    余额 {log.balance_after}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {logs.length >= limit && (
        <div className="flex justify-center gap-3">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="px-3 py-1.5 text-[10px] border border-[var(--color-border)] rounded-md disabled:opacity-30"
          >
            上一页
          </button>
          <button
            onClick={() => setOffset(offset + limit)}
            className="px-3 py-1.5 text-[10px] border border-[var(--color-border)] rounded-md"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
