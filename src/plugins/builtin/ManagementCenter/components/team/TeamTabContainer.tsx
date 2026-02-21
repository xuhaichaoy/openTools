import { useCallback, useEffect, useState } from "react";
import {
  Users,
  Plus,
  ArrowLeft,
  Cpu,
  FolderOpen,
  BarChart3,
  Loader2,
} from "lucide-react";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";
import { useAuthStore } from "@/store/auth-store";
import { TeamMembersSection, type TeamMember } from "./TeamMembersSection";
import { TeamAIConfigSection } from "./TeamAIConfigSection";
import { TeamResourcesSection } from "./TeamResourcesSection";
import { TeamUsageSection } from "./TeamUsageSection";

export interface Team {
  id: string;
  name: string;
  owner_id: string;
  avatar_url?: string;
  created_at: string;
  subscription_plan?: "trial" | "pro";
  subscription_expires_at?: string | null;
}

function isTeamSubscriptionActive(team: Team): boolean {
  const plan = team.subscription_plan ?? "trial";
  const expiresAt = team.subscription_expires_at;
  const now = Date.now();

  return plan === "pro"
    ? !expiresAt || new Date(expiresAt).getTime() > now
    : !!expiresAt && new Date(expiresAt).getTime() > now;
}

function getTeamSubscriptionLabel(team: Team): string {
  const plan = team.subscription_plan ?? "trial";
  const active = isTeamSubscriptionActive(team);

  if (!active) return "已到期";
  if (plan === "trial") return "试用中";
  return "已开通";
}

export function TeamTabContainer() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);

  useEffect(() => {
    const fetchTeams = async () => {
      try {
        const res = await api.get<Team[]>("/teams");
        setTeams(res);
      } catch (err) {
        handleError(err, { context: "获取团队列表" });
      } finally {
        setLoading(false);
      }
    };

    fetchTeams();
  }, []);

  const handleCreateTeam = async () => {
    if (!newTeamName.trim()) return;

    try {
      const team = await api.post<Team>("/teams", { name: newTeamName });
      setTeams([team, ...teams]);
      setNewTeamName("");
      setShowCreate(false);
    } catch (err) {
      handleError(err, { context: "创建团队" });
    }
  };

  const fetchMembers = useCallback(async (teamId: string) => {
    try {
      const res = await api.get<TeamMember[]>(`/teams/${teamId}/members`);
      setMembers(res);
    } catch (err) {
      handleError(err, { context: "获取团队成员" });
    }
  }, []);

  const handleViewTeam = async (team: Team) => {
    setSelectedTeam(team);
    await fetchMembers(team.id);
  };

  if (selectedTeam) {
    return (
      <TeamDetail
        team={selectedTeam}
        members={members}
        onBack={() => setSelectedTeam(null)}
        onMembersChange={() => fetchMembers(selectedTeam.id)}
      />
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-[var(--space-compact-3)]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">团队空间</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            创建或加入团队，共享 AI 模型额度和工作流。
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold active:scale-95 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          创建团队
        </button>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-10 text-[var(--color-text-secondary)]">
          <Loader2 className="w-5 h-5 animate-spin mb-2" />
          <p className="text-xs">加载中...</p>
        </div>
      ) : teams.length === 0 ? (
        <div className="text-center py-10 bg-[var(--color-bg)] rounded-xl border border-dashed border-[var(--color-border)]">
          <Users className="w-8 h-8 text-[var(--color-text-secondary)] mx-auto mb-2 opacity-20" />
          <p className="text-xs text-[var(--color-text-secondary)]">
            您还没有加入任何团队
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {teams.map((team) => (
            <button
              key={team.id}
              onClick={() => handleViewTeam(team)}
              className="flex items-center justify-between p-3 bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] hover:border-[#F28F36]/30 hover:shadow-sm transition-all group text-left"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#F28F36]/10 flex items-center justify-center transition-colors group-hover:bg-[#F28F36] group-hover:text-white text-[#F28F36]">
                  <Users className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-xs">{team.name}</h3>
                  <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                    {team.owner_id === useAuthStore.getState().user?.id
                      ? "我创建的"
                      : "已加入"}
                    {" · "}
                    {getTeamSubscriptionLabel(team)}
                  </p>
                </div>
              </div>
              <div className="p-1.5 rounded-md bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] group-hover:text-[#F28F36] group-hover:bg-[#F28F36]/10 transition-colors">
                <ArrowLeft className="w-3.5 h-3.5 rotate-180" />
              </div>
            </button>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-[var(--color-bg)] w-[340px] rounded-xl p-[var(--space-compact-4)] border border-[var(--color-border)] shadow-xl">
            <h3 className="text-sm font-semibold mb-3 text-center">创建新团队</h3>
            <div className="space-y-[var(--space-compact-2)]">
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  团队名称
                </label>
                <input
                  autoFocus
                  type="text"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateTeam()}
                  placeholder="输入团队名称..."
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-[#F28F36] transition-all text-[var(--color-text)]"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setShowCreate(false)}
                  className="flex-1 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] text-xs font-medium transition-all"
                >
                  取消
                </button>
                <button
                  onClick={handleCreateTeam}
                  disabled={!newTeamName.trim()}
                  className="flex-1 py-2 rounded-lg bg-[#F28F36] text-white text-xs font-semibold active:scale-95 transition-all disabled:opacity-50"
                >
                  确认创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TeamDetail({
  team,
  members,
  onBack,
  onMembersChange,
}: {
  team: Team;
  members: TeamMember[];
  onBack: () => void;
  onMembersChange: () => void;
}) {
  const [teamSection, setTeamSection] = useState<
    "members" | "ai-config" | "resources" | "usage"
  >("members");
  const { user } = useAuthStore();
  const teamActive = isTeamSubscriptionActive(team);
  const isOwnerOrAdmin =
    team &&
    user &&
    members.some(
      (member) =>
        member.user_id === user.id &&
        (member.role === "owner" || member.role === "admin"),
    );
  const effectiveTeamSection =
    !teamActive && teamSection !== "members" ? "members" : teamSection;

  return (
    <div className="max-w-xl mx-auto space-y-[var(--space-compact-3)]">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        返回列表
      </button>

      <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-[#F28F36]/10 flex items-center justify-center border border-[#F28F36]/20">
          <Users className="w-5 h-5 text-[#F28F36]" />
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-semibold">{team.name}</h2>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            {members.length} 名成员 · {getTeamSubscriptionLabel(team)} · 创建于 {new Date(team.created_at).toLocaleDateString()}
          </p>
        </div>
      </div>

      {!teamActive && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-[var(--space-compact-3)] py-2.5">
          <div className="text-xs font-semibold text-amber-600">团队已到期</div>
          <div className="text-[10px] text-amber-600/90 mt-1">
            当前仅可查看团队基础信息与成员列表，团队业务能力需续费后恢复。
          </div>
        </div>
      )}

      <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1 border border-[var(--color-border)]">
        {[
          { id: "members" as const, icon: Users, label: "成员", requiresActive: false },
          { id: "ai-config" as const, icon: Cpu, label: "AI 配置", requiresActive: true },
          { id: "resources" as const, icon: FolderOpen, label: "共享资源", requiresActive: true },
          { id: "usage" as const, icon: BarChart3, label: "用量统计", requiresActive: true },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              if (tab.requiresActive && !teamActive) return;
              setTeamSection(tab.id);
            }}
            disabled={tab.requiresActive && !teamActive}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-all ${
              effectiveTeamSection === tab.id
                ? "bg-[#F28F36]/10 text-[#F28F36]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
            } ${
              tab.requiresActive && !teamActive
                ? "opacity-45 cursor-not-allowed hover:bg-transparent"
                : ""
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {effectiveTeamSection === "members" && (
        <TeamMembersSection
          teamId={team.id}
          members={members}
          isOwnerOrAdmin={!!isOwnerOrAdmin}
          teamActive={teamActive}
          onMembersChange={onMembersChange}
        />
      )}

      {effectiveTeamSection === "ai-config" && (
        <TeamAIConfigSection
          teamId={team.id}
          teamMembers={members}
          isOwnerOrAdmin={!!isOwnerOrAdmin}
          teamActive={teamActive}
        />
      )}

      {effectiveTeamSection === "resources" && (
        <TeamResourcesSection
          teamId={team.id}
          isOwnerOrAdmin={!!isOwnerOrAdmin}
          teamActive={teamActive}
        />
      )}

      {effectiveTeamSection === "usage" && (
        <TeamUsageSection
          teamId={team.id}
          isOwnerOrAdmin={!!isOwnerOrAdmin}
          teamActive={teamActive}
        />
      )}
    </div>
  );
}
