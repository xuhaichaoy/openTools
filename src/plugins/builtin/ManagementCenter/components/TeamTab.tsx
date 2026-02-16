import { useState, useEffect, useCallback } from "react";
import {
  Users,
  Plus,
  UserPlus,
  Shield,
  Loader2,
  ArrowLeft,
  Cpu,
  FolderOpen,
  BarChart3,
  Crown,
  Trash2,
  ChevronDown,
  Copy,
  Check,
  X,
  FileText,
  GitBranch,
  ExternalLink,
} from "lucide-react";
import { api } from "@/core/api/client";
import { useAuthStore } from "@/store/auth-store";

const BRAND = "#F28F36";

interface Team {
  id: string;
  name: string;
  owner_id: string;
  avatar_url?: string;
  created_at: string;
}

interface TeamMember {
  team_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  username: string;
}

interface SharedResource {
  id: string;
  team_id: string;
  resource_type: string;
  resource_id: string;
  owner_id: string;
  shared_at: string;
  description?: string;
  owner_name?: string;
}

export function TeamTab() {
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
        console.error("Failed to fetch teams:", err);
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
      console.error("Failed to create team:", err);
    }
  };

  const fetchMembers = useCallback(async (teamId: string) => {
    try {
      const res = await api.get<TeamMember[]>(`/teams/${teamId}/members`);
      setMembers(res);
    } catch (err) {
      console.error("Failed to fetch members:", err);
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
    <div className="max-w-xl mx-auto space-y-4">
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
        <div className="flex flex-col items-center justify-center py-12 text-[var(--color-text-secondary)]">
          <Loader2 className="w-5 h-5 animate-spin mb-2" />
          <p className="text-xs">加载中...</p>
        </div>
      ) : teams.length === 0 ? (
        <div className="text-center py-12 bg-[var(--color-bg)] rounded-xl border border-dashed border-[var(--color-border)]">
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
                    {team.owner_id === useAuthStore.getState().user?.id ? "我创建的" : "已加入"}
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
          <div className="bg-[var(--color-bg)] w-[340px] rounded-xl p-5 border border-[var(--color-border)] shadow-xl">
            <h3 className="text-sm font-semibold mb-4 text-center">创建新团队</h3>
            <div className="space-y-3">
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
  const isOwnerOrAdmin =
    team &&
    user &&
    members.some(
      (m) =>
        m.user_id === user.id && (m.role === "owner" || m.role === "admin"),
    );

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        返回列表
      </button>

      <div className="bg-[var(--color-bg)] rounded-xl p-4 border border-[var(--color-border)] flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-[#F28F36]/10 flex items-center justify-center border border-[#F28F36]/20">
          <Users className="w-5 h-5 text-[#F28F36]" />
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-semibold">{team.name}</h2>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            {members.length} 名成员 · 创建于{" "}
            {new Date(team.created_at).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1 border border-[var(--color-border)]">
        {[
          { id: "members" as const, icon: Users, label: "成员" },
          { id: "ai-config" as const, icon: Cpu, label: "AI 配置" },
          { id: "resources" as const, icon: FolderOpen, label: "共享资源" },
          { id: "usage" as const, icon: BarChart3, label: "用量统计" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setTeamSection(tab.id)}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-all ${
              teamSection === tab.id
                ? "bg-[#F28F36]/10 text-[#F28F36]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {teamSection === "members" && (
        <MembersSection
          team={team}
          members={members}
          isOwnerOrAdmin={!!isOwnerOrAdmin}
          onMembersChange={onMembersChange}
        />
      )}

      {teamSection === "ai-config" && (
        <AIConfigSection team={team} isOwnerOrAdmin={!!isOwnerOrAdmin} />
      )}

      {teamSection === "resources" && (
        <SharedResourcesSection
          team={team}
          isOwnerOrAdmin={!!isOwnerOrAdmin}
        />
      )}

      {teamSection === "usage" && (
        <UsageSection team={team} isOwnerOrAdmin={!!isOwnerOrAdmin} />
      )}
    </div>
  );
}

// ── 成员管理 ──

function MembersSection({
  team,
  members,
  isOwnerOrAdmin,
  onMembersChange,
}: {
  team: Team;
  members: TeamMember[];
  isOwnerOrAdmin: boolean;
  onMembersChange: () => void;
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteSuccess, setInviteSuccess] = useState("");
  const { user } = useAuthStore();

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError("");
    setInviteSuccess("");
    try {
      await api.post(`/teams/${team.id}/members`, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteSuccess(`已邀请 ${inviteEmail}`);
      setInviteEmail("");
      onMembersChange();
      setTimeout(() => setInviteSuccess(""), 3000);
    } catch (err: any) {
      setInviteError(err?.message || "邀请失败");
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm("确定要移除该成员吗？")) return;
    try {
      await api.delete(`/teams/${team.id}/members/${memberId}`);
      onMembersChange();
    } catch (err) {
      console.error("Failed to remove member:", err);
    }
  };

  const handleChangeRole = async (memberId: string, newRole: string) => {
    try {
      await api.patch(`/teams/${team.id}/members/${memberId}`, {
        role: newRole,
      });
      onMembersChange();
    } catch (err) {
      console.error("Failed to change role:", err);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          成员列表 ({members.length})
        </h3>
        {isOwnerOrAdmin && (
          <button
            onClick={() => setShowInvite(!showInvite)}
            className="flex items-center gap-1.5 text-xs font-bold text-[#F28F36] hover:text-[#F28F36] transition-colors"
          >
            <UserPlus className="w-3.5 h-3.5" />
            邀请成员
          </button>
        )}
      </div>

      {showInvite && (
        <div className="bg-[var(--color-bg)] rounded-lg border border-[#F28F36]/20 p-5 space-y-3 animate-in slide-in-from-top-2 duration-200">
          <div className="flex gap-2">
            <input
              type="email"
              autoFocus
              placeholder="输入成员邮箱..."
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleInvite()}
              className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-3 text-sm outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            />
            <select
              value={inviteRole}
              onChange={(e) =>
                setInviteRole(e.target.value as "member" | "admin")
              }
              className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-3 text-sm outline-none"
            >
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
            <button
              onClick={handleInvite}
              disabled={!inviteEmail.trim() || inviting}
              className="px-4 py-2 rounded-lg bg-[#F28F36] text-white text-sm font-bold disabled:opacity-40 transition-all"
            >
              {inviting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "邀请"
              )}
            </button>
          </div>
          {inviteError && (
            <p className="text-xs text-red-500">{inviteError}</p>
          )}
          {inviteSuccess && (
            <p className="text-xs text-emerald-500 flex items-center gap-1">
              <Check className="w-3 h-3" />
              {inviteSuccess}
            </p>
          )}
        </div>
      )}

      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        {members.map((member) => (
          <div
            key={member.user_id}
            className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-border)] last:border-0"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-[var(--color-bg-secondary)] flex items-center justify-center text-[10px] font-bold text-[#F28F36]">
                {member.username[0]?.toUpperCase() || "?"}
              </div>
              <div>
                <div className="text-xs font-medium flex items-center gap-1.5">
                  {member.username}
                  {member.user_id === user?.id && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#F28F36]/10 text-[#F28F36]">
                      我
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-[var(--color-text-secondary)] uppercase tracking-widest flex items-center gap-1">
                  {member.role === "owner" ? (
                    <>
                      <Crown className="w-3 h-3 text-amber-500" />
                      所有者
                    </>
                  ) : member.role === "admin" ? (
                    <>
                      <Shield className="w-3 h-3 text-[#F28F36]" />
                      管理员
                    </>
                  ) : (
                    "成员"
                  )}
                </div>
              </div>
            </div>
            {isOwnerOrAdmin &&
              member.role !== "owner" &&
              member.user_id !== user?.id && (
                <div className="flex items-center gap-2">
                  <select
                    value={member.role}
                    onChange={(e) =>
                      handleChangeRole(member.user_id, e.target.value)
                    }
                    className="text-xs bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2 outline-none"
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                  </select>
                  <button
                    onClick={() => handleRemoveMember(member.user_id)}
                    className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="移除成员"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AI 配置 ──

interface AiConfigItem {
  model_name: string;
  display_name: string;
  provider: string;
  base_url: string;
  api_key_encrypted: string;
  enabled: boolean;
}

function AIConfigSection({
  team,
  isOwnerOrAdmin,
}: {
  team: Team;
  isOwnerOrAdmin: boolean;
}) {
  const [configs, setConfigs] = useState<AiConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    model_name: "",
    display_name: "",
    provider: "openai",
    base_url: "https://api.openai.com/v1",
    api_key: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetchConfigs = async () => {
      try {
        if (isOwnerOrAdmin) {
          const res = await api.get<{ configs: AiConfigItem[] }>(
            `/teams/${team.id}/ai-config`,
          );
          setConfigs(res.configs || []);
        } else {
          const res = await api.get<{ models: AiConfigItem[] }>(
            `/teams/${team.id}/ai-models`,
          );
          setConfigs(res.models || []);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchConfigs();
  }, [team.id, isOwnerOrAdmin]);

  const handleSave = async () => {
    if (!form.model_name || !form.api_key) return;
    setSaving(true);
    try {
      await api.put(`/teams/${team.id}/ai-config`, {
        model_name: form.model_name,
        display_name: form.display_name || form.model_name,
        provider: form.provider,
        base_url: form.base_url,
        api_key: form.api_key,
      });
      setForm({
        model_name: "",
        display_name: "",
        provider: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "",
      });
      // Refresh
      const res = await api.get<{ configs: AiConfigItem[] }>(
        `/teams/${team.id}/ai-config`,
      );
      setConfigs(res.configs || []);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-[#F28F36]" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4 space-y-3">
        <div>
          <h3 className="text-xs font-semibold">团队 AI 模型配置</h3>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            {isOwnerOrAdmin
              ? "配置团队共享的 AI API Key，成员使用时无需消耗个人能量。"
              : "以下是团队可用的 AI 模型。"}
          </p>
        </div>

        {configs.length > 0 && (
          <div className="divide-y divide-[var(--color-border)]">
            {configs.map((c, i) => (
              <div key={i} className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-2.5">
                  <Cpu className="w-3.5 h-3.5 text-[#F28F36]" />
                  <div>
                    <div className="text-xs font-medium">
                      {c.display_name || c.model_name}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      {c.provider} · {c.model_name}
                    </div>
                  </div>
                </div>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full ${c.enabled ? "bg-emerald-500/10 text-emerald-500" : "bg-gray-500/10 text-gray-500"}`}
                >
                  {c.enabled ? "已启用" : "已禁用"}
                </span>
              </div>
            ))}
          </div>
        )}

        {isOwnerOrAdmin && (
          <div className="pt-3 border-t border-[var(--color-border)] space-y-2">
            <h4 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              添加新模型
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="模型名称 (如 gpt-4o)"
                value={form.model_name}
                onChange={(e) =>
                  setForm({ ...form, model_name: e.target.value })
                }
                className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
              />
              <input
                type="text"
                placeholder="显示名称 (如 GPT-4o)"
                value={form.display_name}
                onChange={(e) =>
                  setForm({ ...form, display_name: e.target.value })
                }
                className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
              />
            </div>
            <input
              type="url"
              placeholder="API Base URL (如 https://api.openai.com/v1)"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            />
            <input
              type="password"
              placeholder="API Key"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            />
            <button
              onClick={handleSave}
              disabled={!form.model_name || !form.api_key || saving}
              className="w-full py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-40 transition-all flex items-center justify-center gap-1.5"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              保存配置
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 共享资源 ──

function SharedResourcesSection({
  team,
  isOwnerOrAdmin,
}: {
  team: Team;
  isOwnerOrAdmin: boolean;
}) {
  const [resources, setResources] = useState<SharedResource[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchResources = useCallback(async () => {
    try {
      const res = await api.get<{ resources: SharedResource[] }>(
        `/teams/${team.id}/resources`,
      );
      setResources(res.resources || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [team.id]);

  useEffect(() => {
    fetchResources();
  }, [fetchResources]);

  const handleUnshare = async (resourceId: string) => {
    if (!confirm("确定要取消共享该资源吗？")) return;
    try {
      await api.delete(`/teams/${team.id}/resources/${resourceId}`);
      await fetchResources();
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-[#F28F36]" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-xs font-semibold">共享资源</h3>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              团队成员共享的知识库文档和工作流模板
            </p>
          </div>
        </div>

        {resources.length === 0 ? (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <FolderOpen className="w-6 h-6 mx-auto mb-2 opacity-20" />
            <p className="text-xs">暂无共享资源</p>
            <p className="text-[10px] mt-0.5 opacity-60">
              在知识库或工作流中选择「共享到团队」即可
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {resources.map((res) => (
              <div
                key={res.id}
                className="flex items-center justify-between py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  {res.resource_type === "knowledge_doc" ? (
                    <FileText className="w-3.5 h-3.5 text-blue-500" />
                  ) : (
                    <GitBranch className="w-3.5 h-3.5 text-purple-500" />
                  )}
                  <div>
                    <div className="text-xs font-medium">
                      {res.description || res.resource_id}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      {res.resource_type === "knowledge_doc"
                        ? "知识库文档"
                        : "工作流模板"}{" "}
                      · 由 {res.owner_name || "成员"} 共享 ·{" "}
                      {new Date(res.shared_at).toLocaleDateString()}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isOwnerOrAdmin && (
                    <button
                      onClick={() => handleUnshare(res.id)}
                      className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title="取消共享"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 用量统计 ──

function UsageSection({
  team,
  isOwnerOrAdmin,
}: {
  team: Team;
  isOwnerOrAdmin: boolean;
}) {
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
        <TeamUsageStats teamId={team.id} />
      </div>
    </div>
  );
}

function TeamUsageStats({ teamId }: { teamId: string }) {
  const [usage, setUsage] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsage = async () => {
      try {
        const res = await api.get<{ usage: any[] }>(
          `/teams/${teamId}/ai-usage`,
        );
        setUsage(res.usage || []);
      } catch (err) {
        console.error("Failed to fetch usage:", err);
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
    (sum, r) => sum + (r.prompt_tokens || 0) + (r.completion_tokens || 0),
    0,
  );
  const totalRequests = usage.reduce(
    (sum, r) => sum + (r.request_count || 0),
    0,
  );

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
            {totalTokens >= 1000000
              ? `${(totalTokens / 1000000).toFixed(1)}M`
              : totalTokens >= 1000
                ? `${(totalTokens / 1000).toFixed(1)}K`
                : totalTokens}
          </div>
          <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            总 Token 消耗
          </div>
        </div>
      </div>

      <div className="divide-y divide-[var(--color-border)]">
        {usage.map((row: any, idx: number) => {
          const tokens =
            (row.prompt_tokens || 0) + (row.completion_tokens || 0);
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
                  {tokens >= 1000
                    ? `${(tokens / 1000).toFixed(1)}K`
                    : tokens}{" "}
                  tokens
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
