import { useState } from "react";
import { UserPlus, Loader2, Check, Crown, Shield, Trash2 } from "lucide-react";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";
import { useAuthStore } from "@/store/auth-store";

export interface TeamMember {
  team_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  username: string;
}

export function TeamMembersSection({
  teamId,
  members,
  isOwnerOrAdmin,
  teamActive,
  onMembersChange,
}: {
  teamId: string;
  members: TeamMember[];
  isOwnerOrAdmin: boolean;
  teamActive: boolean;
  onMembersChange: () => void;
}) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteSuccess, setInviteSuccess] = useState("");
  const { user } = useAuthStore();
  const canManageMembers = isOwnerOrAdmin && teamActive;

  const handleInvite = async () => {
    if (!canManageMembers) return;
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError("");
    setInviteSuccess("");
    try {
      await api.post(`/teams/${teamId}/members`, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setInviteSuccess(`已邀请 ${inviteEmail}`);
      setInviteEmail("");
      onMembersChange();
      setTimeout(() => setInviteSuccess(""), 3000);
    } catch (err: unknown) {
      setInviteError(err instanceof Error ? err.message : "邀请失败");
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!canManageMembers) return;
    if (!confirm("确定要移除该成员吗？")) return;
    try {
      await api.delete(`/teams/${teamId}/members/${memberId}`);
      onMembersChange();
    } catch (err) {
      handleError(err, { context: "移除团队成员" });
    }
  };

  const handleChangeRole = async (memberId: string, newRole: string) => {
    if (!canManageMembers) return;
    try {
      await api.patch(`/teams/${teamId}/members/${memberId}`, {
        role: newRole,
      });
      onMembersChange();
    } catch (err) {
      handleError(err, { context: "修改成员角色" });
    }
  };

  return (
    <div className="space-y-[var(--space-compact-2)]">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          成员列表 ({members.length})
        </h3>
        {canManageMembers && (
          <button
            onClick={() => setShowInvite(!showInvite)}
            className="flex items-center gap-1.5 text-xs font-bold text-[#F28F36] hover:text-[#F28F36] transition-colors"
          >
            <UserPlus className="w-3.5 h-3.5" />
            邀请成员
          </button>
        )}
      </div>

      {!teamActive && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-600">
          团队已到期，成员管理写操作已禁用。
        </div>
      )}

      {showInvite && (
        <div className="bg-[var(--color-bg)] rounded-lg border border-[#F28F36]/20 p-[var(--space-compact-4)] space-y-[var(--space-compact-2)] animate-in slide-in-from-top-2 duration-200">
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
            className="flex items-center justify-between px-[var(--space-compact-3)] py-2 border-b border-[var(--color-border)] last:border-0"
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
            {canManageMembers &&
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
