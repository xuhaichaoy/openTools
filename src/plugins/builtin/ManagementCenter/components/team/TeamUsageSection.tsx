import { useEffect, useState } from "react";
import { Loader2, BarChart3 } from "lucide-react";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";

interface TeamUsageRow {
  username: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  request_count?: number;
}

export function TeamUsageSection({
  teamId,
  isOwnerOrAdmin,
  teamActive,
}: {
  teamId: string;
  isOwnerOrAdmin: boolean;
  teamActive: boolean;
}) {
  if (!teamActive) {
    return (
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
        <p className="text-[10px] text-[var(--color-text-secondary)] italic text-center py-6">
          团队已到期，用量统计不可用
        </p>
      </div>
    );
  }

  if (!isOwnerOrAdmin) {
    return (
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
        <p className="text-[10px] text-[var(--color-text-secondary)] italic text-center py-6">
          仅管理员可查看用量统计
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
        <h3 className="text-xs font-semibold mb-3">AI 用量统计</h3>
        <TeamUsageStats teamId={teamId} />
      </div>
    </div>
  );
}

function TeamUsageStats({ teamId }: { teamId: string }) {
  const [usage, setUsage] = useState<TeamUsageRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsage = async () => {
      try {
        const res = await api.get<{ usage: TeamUsageRow[] }>(
          `/teams/${teamId}/ai-usage`,
        );
        setUsage(res.usage || []);
      } catch (err) {
        handleError(err, { context: "获取团队用量统计" });
      } finally {
        setLoading(false);
      }
    };

    fetchUsage();
  }, [teamId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-[#F28F36]" />
      </div>
    );
  }

  if (usage.length === 0) {
    return (
      <div className="text-center py-8 text-[var(--color-text-secondary)]">
        <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-20" />
        <p className="text-xs">暂无用量数据</p>
      </div>
    );
  }

  const totalTokens = usage.reduce(
    (sum, row) => sum + (row.prompt_tokens || 0) + (row.completion_tokens || 0),
    0,
  );
  const totalRequests = usage.reduce((sum, row) => sum + (row.request_count || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-[var(--color-bg-secondary)] rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-[#F28F36]">
            {totalRequests.toLocaleString()}
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            总请求次数
          </div>
        </div>
        <div className="bg-[var(--color-bg-secondary)] rounded-lg p-3 text-center">
          <div className="text-lg font-bold text-[#F28F36]">
            {totalTokens >= 1_000_000
              ? `${(totalTokens / 1_000_000).toFixed(1)}M`
              : totalTokens >= 1_000
                ? `${(totalTokens / 1_000).toFixed(1)}K`
                : totalTokens}
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            总 Token 消耗
          </div>
        </div>
      </div>

      <div className="divide-y divide-[var(--color-border)]">
        {usage.map((row, idx) => {
          const tokens = (row.prompt_tokens || 0) + (row.completion_tokens || 0);
          return (
            <div key={idx} className="flex items-center justify-between py-2.5">
              <div className="flex items-center gap-2.5">
                <div className="w-6 h-6 rounded-full bg-[var(--color-bg-secondary)] flex items-center justify-center text-[10px] font-bold text-[#F28F36]">
                  {(row.username || "?")[0]?.toUpperCase()}
                </div>
                <span className="text-xs font-medium">{row.username}</span>
              </div>
              <div className="text-right text-xs text-[var(--color-text-secondary)]">
                <div>{row.request_count || 0} 次请求</div>
                <div>
                  {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : tokens} tokens
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
