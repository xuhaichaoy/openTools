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
  Settings,
  GitBranch,
  ExternalLink,
} from "lucide-react";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";
import { useAuthStore } from "@/store/auth-store";
import { maskApiKey } from "@/utils/mask";
import { EmbeddingConfigSection } from "./AIModelTab";

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
                    {team.owner_id === useAuthStore.getState().user?.id
                      ? "我创建的"
                      : "已加入"}
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
            <h3 className="text-sm font-semibold mb-4 text-center">
              创建新团队
            </h3>
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
        <AIConfigSection
          team={team}
          members={members}
          isOwnerOrAdmin={!!isOwnerOrAdmin}
        />
      )}

      {teamSection === "resources" && (
        <SharedResourcesSection team={team} isOwnerOrAdmin={!!isOwnerOrAdmin} />
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
      handleError(err, { context: "移除团队成员" });
    }
  };

  const handleChangeRole = async (memberId: string, newRole: string) => {
    try {
      await api.patch(`/teams/${team.id}/members/${memberId}`, {
        role: newRole,
      });
      onMembersChange();
    } catch (err) {
      handleError(err, { context: "修改成员角色" });
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
              {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : "邀请"}
            </button>
          </div>
          {inviteError && <p className="text-xs text-red-500">{inviteError}</p>}
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
  id?: string;
  config_id?: string;
  config_name?: string;
  display_name?: string;
  model_name: string | null;
  provider?: string;
  protocol: string;
  base_url?: string;
  member_token_limit?: number;
  priority?: number;
  is_active?: boolean;
  masked_key?: string;
}

function AIConfigSection({
  team,
  members,
  isOwnerOrAdmin,
}: {
  team: Team;
  members: TeamMember[];
  isOwnerOrAdmin: boolean;
}) {
  const [configs, setConfigs] = useState<AiConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    id: undefined as string | undefined,
    config_name: "",
    model_name: "",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    member_token_limit: 0,
    priority: 1000,
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
          setConfigs(
            (res.models || []).map((m) => ({
              id: m.config_id || m.id,
              config_id: m.config_id || m.id,
              display_name: m.display_name,
              config_name: m.display_name,
              model_name: m.model_name,
              protocol: m.protocol,
              priority: m.priority,
              is_active: true,
            })),
          );
        }
      } catch (err) {
        handleError(err, { context: "获取团队 AI 配置" });
      } finally {
        setLoading(false);
      }
    };
    fetchConfigs();
  }, [team.id, isOwnerOrAdmin]);

  const handleSave = async () => {
    if (!form.api_key && !form.id) return; // New one must have key, old one can be empty
    setSaving(true);
    try {
      await api.put(`/teams/${team.id}/ai-config`, {
        id: form.id,
        config_name: form.config_name || form.model_name || "未命名",
        model_name: form.model_name || null,
        protocol: form.protocol,
        base_url: form.base_url,
        api_key: form.api_key,
        member_token_limit: form.member_token_limit,
        priority: form.priority,
      });
      setForm({
        id: undefined,
        config_name: "",
        model_name: "",
        protocol: "openai",
        base_url: "https://api.openai.com/v1",
        api_key: "",
        member_token_limit: 0,
        priority: 1000,
      });
      // Refresh
      const res = await api.get<{ configs: AiConfigItem[] }>(
        `/teams/${team.id}/ai-config`,
      );
      setConfigs(res.configs || []);
    } catch (err) {
      handleError(err, { context: "保存团队 AI 配置" });
    } finally {
      setSaving(false);
    }
  };

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (configId: string) => {
    if (deletingId === configId) {
      try {
        await api.delete(`/teams/${team.id}/ai-config/${configId}`);
        setConfigs(configs.filter((c) => c.id !== configId));
      } catch (err) {
        handleError(err, { context: "删除团队 AI 配置" });
      } finally {
        setDeletingId(null);
      }
    } else {
      setDeletingId(configId);
      setTimeout(() => setDeletingId((prev) => (prev === configId ? null : prev)), 3000);
    }
  };

  const handleToggleActive = async (configId: string, currentActive: boolean) => {
    try {
      await api.patch(`/teams/${team.id}/ai-config/${configId}`, {
        is_active: !currentActive,
      });
      setConfigs(
        configs.map((c) =>
          c.id === configId ? { ...c, is_active: !currentActive } : c,
        ),
      );
    } catch (err) {
      handleError(err, { context: "切换 AI 配置状态" });
    }
  };

  const handleEdit = (c: AiConfigItem) => {
    setForm({
      id: c.id,
      config_name: c.config_name || c.display_name || "",
      model_name: c.model_name || "",
      protocol: c.protocol,
      base_url: c.base_url || "https://api.openai.com/v1",
      api_key: "", // Keys are not returned
      member_token_limit: c.member_token_limit || 0,
      priority: c.priority ?? 1000,
    });
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
              <div
                key={c.id || c.config_id || i}
                className="flex items-center justify-between py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <Cpu className="w-3.5 h-3.5 text-[#F28F36]" />
                  <div>
                    <div className="text-xs font-medium">
                      {c.config_name || c.display_name || c.model_name || "未命名模型"}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      {c.protocol} · {c.model_name || "全型号"}
                      {c.masked_key && (
                        <span className="ml-1.5 opacity-50">{c.masked_key}</span>
                      )}
                      {(c.member_token_limit || 0) > 0 &&
                        ` · 每人限额 ${c.member_token_limit}`}
                      {typeof c.priority === "number" &&
                        ` · 优先级P${c.priority}(越小越优先)`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isOwnerOrAdmin ? (
                    <button
                      onClick={() => c.id && handleToggleActive(c.id, !!c.is_active)}
                      className="relative w-8 h-[18px] rounded-full transition-colors shrink-0"
                      title={c.is_active ? "点击停用" : "点击启用"}
                      style={{
                        background: c.is_active
                          ? "#10b981"
                          : "var(--color-bg-secondary)",
                        border: c.is_active
                          ? "none"
                          : "1px solid var(--color-border)",
                      }}
                    >
                      <div
                        className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${c.is_active ? "translate-x-[15px]" : "translate-x-[2px]"}`}
                      />
                    </button>
                  ) : (
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full ${c.is_active ? "bg-emerald-500/10 text-emerald-500" : "bg-gray-500/10 text-gray-500"}`}
                    >
                      {c.is_active ? "已启用" : "已禁用"}
                    </span>
                  )}
                  {isOwnerOrAdmin && (
                    <>
                      <button
                        onClick={() => handleEdit(c)}
                        title="编辑"
                        className="p-1 text-[var(--color-text-secondary)] hover:text-[#F28F36] transition-colors"
                      >
                        <Settings className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => c.id && handleDelete(c.id)}
                        className={`p-1 transition-colors ${deletingId === c.id ? "text-red-500" : "text-[var(--color-text-secondary)] hover:text-red-500"}`}
                        title={deletingId === c.id ? "再次点击确认删除" : "删除"}
                        disabled={!c.id}
                      >
                        {deletingId === c.id ? (
                          <span className="text-xs font-medium">确认?</span>
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {isOwnerOrAdmin && (
          <div className="pt-3 border-t border-[var(--color-border)] space-y-2">
            <h4 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              {form.id ? "编辑配置" : "添加新配置"}
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {/* <input
                type="text"
                placeholder="配置别名 (如 核心 Key)"
                value={form.config_name}
                onChange={(e) =>
                  setForm({ ...form, config_name: e.target.value })
                }
                className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
              /> */}
              <select
                value={form.protocol}
                onChange={(e) => {
                  const protocol = e.target.value;
                  setForm({
                    ...form,
                    protocol,
                    base_url:
                      protocol === "anthropic"
                        ? "https://api.anthropic.com"
                        : "https://api.openai.com/v1",
                  });
                }}
                className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div className="grid grid-cols-1 gap-2">
              <input
                type="text"
                placeholder="限定模型名称 (如 claude-3-5-sonnet)"
                value={form.model_name}
                onChange={(e) =>
                  setForm({ ...form, model_name: e.target.value })
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
              placeholder={
                form.id
                  ? `留空不修改 (${configs.find((c) => c.id === form.id)?.masked_key || "****"})`
                  : "API Key"
              }
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            />
            <div className="flex items-center gap-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5">
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] whitespace-nowrap">
                每人每日额度
              </label>
              <input
                type="number"
                placeholder="0 为不限制"
                value={form.member_token_limit || ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    member_token_limit: parseInt(e.target.value) || 0,
                  })
                }
                className="w-full bg-transparent text-xs outline-none"
              />
            </div>
            <div className="flex items-center gap-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5">
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] whitespace-nowrap">
                优先级（越小越优先）
              </label>
              <input
                type="number"
                placeholder="数字越小越优先"
                value={form.priority}
                onChange={(e) =>
                  setForm({
                    ...form,
                    priority: Math.max(0, parseInt(e.target.value || "0", 10) || 0),
                  })
                }
                className="w-full bg-transparent text-xs outline-none"
              />
            </div>
            <p className="text-[10px] text-[var(--color-text-secondary)]">
              当同一模型有多条可用配置时，系统优先选择优先级最小的配置；如果未指定 team_config_id，
              也会按优先级自动兜底。
            </p>
            <button
              onClick={handleSave}
              disabled={!form.model_name || (!form.id && !form.api_key) || saving}
              className="w-full py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-40 transition-all flex items-center justify-center gap-1.5"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              保存配置
            </button>
          </div>
        )}
      </div>

      {isOwnerOrAdmin && <TeamQuotaSection teamId={team.id} members={members} />}

      {/* Embedding API 配置（本地知识库向量化） */}
      <EmbeddingConfigSection />
    </div>
  );
}

function currentMonthKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
}

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

function TeamQuotaSection({
  teamId,
  members: teamMembers,
}: {
  teamId: string;
  members: TeamMember[];
}) {
  const [month, setMonth] = useState(currentMonthKey());
  const [monthlyLimit, setMonthlyLimit] = useState(0);
  const [quotaMembers, setQuotaMembers] = useState<TeamQuotaMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [patchingMember, setPatchingMember] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [extraDeltaTokens, setExtraDeltaTokens] = useState(0);
  const mergedMembers: TeamQuotaMember[] = teamMembers.map((tm) => {
    const quota = quotaMembers.find((q) => q.user_id === tm.user_id);
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
      user_id: tm.user_id,
      username: tm.username,
      role: tm.role,
      used_tokens: usedTokens,
      base_tokens: baseTokens,
      extra_tokens: extraTokens,
      effective_limit_tokens: effectiveTokens,
      remaining_tokens: remainingTokens,
    };
  });

  const selectedMember = mergedMembers.find((m) => m.user_id === selectedUserId);

  const fetchQuotaData = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [policyRes, membersRes] = await Promise.all([
        api.get<{ monthly_limit_tokens: number }>(`/teams/${teamId}/ai-quota`, {
          month,
        }),
        api.get<{ members: TeamQuotaMember[] }>(`/teams/${teamId}/ai-quota/members`, {
          month,
        }),
      ]);
      setMonthlyLimit(policyRes.monthly_limit_tokens || 0);
      setQuotaMembers(membersRes.members || []);
    } catch (err: any) {
      const msg =
        err?.message ||
        "获取团队月额度配置失败，请确认服务端已升级并执行数据库迁移。";
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [teamId, month]);

  useEffect(() => {
    fetchQuotaData();
  }, [fetchQuotaData]);

  useEffect(() => {
    if (selectedUserId) return;
    if (teamMembers.length > 0) {
      setSelectedUserId(teamMembers[0].user_id);
    }
  }, [teamMembers, selectedUserId]);

  useEffect(() => {
    if (mergedMembers.length === 0) {
      if (selectedUserId) setSelectedUserId("");
      return;
    }
    if (!mergedMembers.some((m) => m.user_id === selectedUserId)) {
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
      handleError(err, { context: "设置成员月度加额" });
    } finally {
      setPatchingMember(false);
    }
  };

  return (
    <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4 space-y-3">
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
            {savingPolicy ? "保存中..." : "保存额度策略"}
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
        <div className="grid grid-cols-4 gap-2">
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="col-span-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none"
          >
            {mergedMembers.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.username}
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
            {patchingMember ? "提交中..." : "增加本月额度"}
          </button>
        </div>
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
            {mergedMembers.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between py-2 text-xs">
                <div>
                  <div className="font-medium">{m.username}</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    已用 {m.used_tokens.toLocaleString()} · 默认{" "}
                    {m.base_tokens.toLocaleString()} · 加额{" "}
                    {m.extra_tokens.toLocaleString()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">
                    {m.effective_limit_tokens > 0
                      ? `${m.effective_limit_tokens.toLocaleString()}`
                      : "不限额"}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    剩余{" "}
                    {m.remaining_tokens == null
                      ? "∞"
                      : m.remaining_tokens.toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
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
      handleError(err, { context: "获取团队共享资源" });
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
      handleError(err, { context: "取消共享资源" });
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
                  {tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : tokens}{" "}
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
