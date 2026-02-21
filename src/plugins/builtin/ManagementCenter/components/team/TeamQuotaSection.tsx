import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";
import type { TeamMember } from "./TeamMembersSection";

interface TeamQuotaMember {
  user_id: string;
  username: string;
  role: string;
  used_tokens: number;
  base_tokens: number;
  extra_tokens: number;
  effective_limit_tokens: number;
  remaining_tokens: number | null;
}

interface TeamQuotaPolicyResponse {
  month: string;
  monthly_limit_tokens: number;
}

interface TeamQuotaMembersResponse {
  month: string;
  monthly_limit_tokens: number;
  members: TeamQuotaMember[];
}

const QUICK_DELTA_OPTIONS = [50_000, 200_000, 1_000_000];

export function TeamQuotaSection({
  teamId,
  teamMembers,
}: {
  teamId: string;
  teamMembers: TeamMember[];
}) {
  const [month, setMonth] = useState("");
  const [monthlyLimit, setMonthlyLimit] = useState(0);
  const [quotaMembers, setQuotaMembers] = useState<TeamQuotaMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [patchingMember, setPatchingMember] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [extraDeltaTokens, setExtraDeltaTokens] = useState(0);

  const mergedMembers = useMemo<TeamQuotaMember[]>(() => {
    return teamMembers.map((member) => {
      const quota = quotaMembers.find((q) => q.user_id === member.user_id);
      const baseTokens = quota?.base_tokens ?? monthlyLimit;
      const extraTokens = quota?.extra_tokens ?? 0;
      const effectiveTokens =
        quota?.effective_limit_tokens ??
        (baseTokens <= 0 ? 0 : baseTokens + extraTokens);
      const usedTokens = quota?.used_tokens ?? 0;
      const remainingTokens =
        quota?.remaining_tokens ??
        (effectiveTokens <= 0 ? null : Math.max(effectiveTokens - usedTokens, 0));

      return {
        user_id: member.user_id,
        username: member.username,
        role: member.role,
        used_tokens: usedTokens,
        base_tokens: baseTokens,
        extra_tokens: extraTokens,
        effective_limit_tokens: effectiveTokens,
        remaining_tokens: remainingTokens,
      };
    });
  }, [teamMembers, quotaMembers, monthlyLimit]);

  const selectedMember = mergedMembers.find((member) => member.user_id === selectedUserId);

  const fetchQuotaData = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const params = month ? { month } : undefined;
      const [policyRes, membersRes] = await Promise.all([
        api.get<TeamQuotaPolicyResponse>(`/teams/${teamId}/ai-quota`, params),
        api.get<TeamQuotaMembersResponse>(`/teams/${teamId}/ai-quota/members`, params),
      ]);

      const effectiveMonth = policyRes.month || membersRes.month || month;
      if (effectiveMonth && effectiveMonth !== month) {
        setMonth(effectiveMonth);
      }

      setMonthlyLimit(
        policyRes.monthly_limit_tokens ?? membersRes.monthly_limit_tokens ?? 0,
      );
      setQuotaMembers(membersRes.members || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "获取团队月额度配置失败";
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [teamId, month]);

  useEffect(() => {
    fetchQuotaData();
  }, [fetchQuotaData]);

  useEffect(() => {
    if (mergedMembers.length === 0) {
      if (selectedUserId) setSelectedUserId("");
      return;
    }

    if (!selectedUserId || !mergedMembers.some((m) => m.user_id === selectedUserId)) {
      setSelectedUserId(mergedMembers[0].user_id);
    }
  }, [mergedMembers, selectedUserId]);

  const handleSavePolicy = async () => {
    setSavingPolicy(true);
    try {
      await api.put(`/teams/${teamId}/ai-quota/policy`, {
        monthly_limit_tokens: Math.max(0, monthlyLimit),
      });
      await fetchQuotaData();
    } catch (err) {
      handleError(err, { context: "保存团队月额度策略" });
    } finally {
      setSavingPolicy(false);
    }
  };

  const handlePatchMember = async () => {
    if (!selectedUserId || !extraDeltaTokens) return;
    setPatchingMember(true);
    try {
      await api.patch(`/teams/${teamId}/ai-quota/member/${selectedUserId}`, {
        month,
        extra_delta_tokens: extraDeltaTokens,
      });
      setExtraDeltaTokens(0);
      await fetchQuotaData();
    } catch (err) {
      handleError(err, { context: "设置成员本月加额" });
    } finally {
      setPatchingMember(false);
    }
  };

  return (
    <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)] space-y-[var(--space-compact-2)]">
      <div>
        <h3 className="text-xs font-semibold">团队月额度策略</h3>
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
          按自然月生效。成员有效额度 = 团队月额度 + 成员本月加额。
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <div className="col-span-1">
          <label className="text-[10px] text-[var(--color-text-secondary)]">月份</label>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none"
          />
        </div>
        <div className="col-span-2">
          <label className="text-[10px] text-[var(--color-text-secondary)]">
            团队成员月额度（token，0=不限额）
          </label>
          <input
            type="number"
            min={0}
            value={monthlyLimit}
            onChange={(e) =>
              setMonthlyLimit(Math.max(0, parseInt(e.target.value || "0", 10) || 0))
            }
            className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none"
          />
        </div>
        <div className="col-span-1 flex items-end">
          <button
            onClick={handleSavePolicy}
            disabled={savingPolicy}
            className="w-full py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-50"
          >
            {savingPolicy ? "保存中..." : "保存策略"}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
          <div className="text-[11px] text-red-400 font-medium">额度数据加载失败</div>
          <div className="text-[10px] text-red-300/90 mt-0.5">{loadError}</div>
          <button
            onClick={fetchQuotaData}
            className="mt-2 text-[10px] px-2 py-1 rounded border border-red-400/40 text-red-300 hover:bg-red-500/10"
          >
            重试
          </button>
        </div>
      )}

      <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
        <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          成员本月加额
        </div>

        {mergedMembers.length === 0 ? (
          <div className="text-[10px] text-[var(--color-text-secondary)] py-1">
            当前团队还没有可选择成员。
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="col-span-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none"
              >
                {mergedMembers.map((member) => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.username}
                  </option>
                ))}
              </select>
              <input
                type="number"
                value={extraDeltaTokens || ""}
                onChange={(e) =>
                  setExtraDeltaTokens(
                    Math.max(0, parseInt(e.target.value || "0", 10) || 0),
                  )
                }
                placeholder="本月增加 token"
                className="col-span-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none"
              />
              <button
                onClick={handlePatchMember}
                disabled={!selectedUserId || extraDeltaTokens <= 0 || patchingMember}
                className="col-span-1 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
              >
                {patchingMember ? "提交中..." : "增加额度"}
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {QUICK_DELTA_OPTIONS.map((value) => (
                <button
                  key={value}
                  onClick={() => setExtraDeltaTokens(value)}
                  className="text-[10px] px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]"
                >
                  +{value.toLocaleString()}
                </button>
              ))}
            </div>
          </>
        )}

        {selectedMember && (
          <div className="text-[10px] text-[var(--color-text-secondary)]">
            当前成员：已用 {selectedMember.used_tokens.toLocaleString()}，当前加额{" "}
            {selectedMember.extra_tokens.toLocaleString()}，剩余{" "}
            {selectedMember.remaining_tokens == null
              ? "∞"
              : selectedMember.remaining_tokens.toLocaleString()}
          </div>
        )}
      </div>

      <div className="pt-2 border-t border-[var(--color-border)]">
        <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">
          本月成员额度概览
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-[#F28F36]" />
          </div>
        ) : mergedMembers.length === 0 ? (
          <div className="text-[10px] text-[var(--color-text-secondary)] text-center py-4">
            当前团队还没有成员
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {mergedMembers.map((member) => (
              <button
                key={member.user_id}
                onClick={() => setSelectedUserId(member.user_id)}
                className={`w-full flex items-center justify-between py-2 text-left text-xs ${
                  selectedUserId === member.user_id
                    ? "bg-[#F28F36]/5"
                    : "hover:bg-[var(--color-bg-secondary)]"
                }`}
              >
                <div>
                  <div className="font-medium">{member.username}</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    已用 {member.used_tokens.toLocaleString()} · 默认{" "}
                    {member.base_tokens.toLocaleString()} · 加额{" "}
                    {member.extra_tokens.toLocaleString()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">
                    {member.effective_limit_tokens > 0
                      ? `${member.effective_limit_tokens.toLocaleString()}`
                      : "不限额"}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    剩余{" "}
                    {member.remaining_tokens == null
                      ? "∞"
                      : member.remaining_tokens.toLocaleString()}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
