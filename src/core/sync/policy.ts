import { api } from "@/core/api/client";

export type SyncStatus = "active" | "expiring_soon" | "expired";

export interface SyncPolicy {
  status: SyncStatus;
  allowed: boolean;
  daysToExpire: number | null;
  stopAt: string | null;
}

export interface PersonalSyncPolicy extends SyncPolicy {
  scope: "personal";
}

export interface TeamSyncPolicy extends SyncPolicy {
  scope: "team";
  teamId: string;
  isMember: boolean;
  role: "owner" | "admin" | "member" | null;
}

interface PersonalEntitlementsResponse {
  can_personal_sync?: boolean;
  can_personal_server_storage?: boolean;
  personal_sync_status?: string;
  days_to_expire?: number | null;
  personal_sync_stop_at?: string | null;
  personal_plan_expires_at?: string | null;
}

interface TeamEntitlementsResponse {
  is_team_active?: boolean;
  is_member?: boolean;
  role?: "owner" | "admin" | "member" | null;
  can_team_sync?: boolean;
  can_team_server_storage?: boolean;
  team_sync_status?: string;
  days_to_expire?: number | null;
  team_sync_stop_at?: string | null;
  expires_at?: string | null;
}

function parseSyncStatus(value: unknown): SyncStatus | null {
  if (value === "active" || value === "expiring_soon" || value === "expired") {
    return value;
  }
  return null;
}

function deriveDaysToExpire(stopAt: string | null): number | null {
  if (!stopAt) return null;
  const target = new Date(stopAt).getTime();
  if (!Number.isFinite(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function inferStatus(
  explicitStatus: SyncStatus | null,
  allowed: boolean,
  daysToExpire: number | null,
): SyncStatus {
  if (explicitStatus) return explicitStatus;
  if (!allowed) return "expired";
  if (daysToExpire !== null && daysToExpire > 0 && daysToExpire <= 3) {
    return "expiring_soon";
  }
  return "active";
}

export function isSyncAllowed(policy: SyncPolicy): boolean {
  return policy.allowed && policy.status !== "expired";
}

export function getExpiryHint(
  policy: SyncPolicy,
  scopeLabel = "同步",
): string | null {
  if (policy.status === "expired") {
    return `${scopeLabel}已到期，仅本地可用`;
  }

  if (policy.status === "expiring_soon") {
    const days = policy.daysToExpire;
    if (days === null) {
      return `${scopeLabel}即将到期，请及时续费`;
    }
    if (days <= 0) {
      return `${scopeLabel}今天到期，请及时续费`;
    }
    return `${scopeLabel}将在 ${days} 天后到期并停止云同步`;
  }

  return null;
}

export async function getPersonalSyncPolicy(): Promise<PersonalSyncPolicy> {
  const entitlements = await api.get<PersonalEntitlementsResponse>(
    "/users/entitlements",
  );
  const allowed = Boolean(
    entitlements.can_personal_sync ?? entitlements.can_personal_server_storage,
  );
  const stopAt =
    entitlements.personal_sync_stop_at ??
    entitlements.personal_plan_expires_at ??
    null;
  const daysToExpire =
    typeof entitlements.days_to_expire === "number"
      ? entitlements.days_to_expire
      : deriveDaysToExpire(stopAt);
  const status = inferStatus(
    parseSyncStatus(entitlements.personal_sync_status),
    allowed,
    daysToExpire,
  );

  return {
    scope: "personal",
    status,
    allowed,
    daysToExpire,
    stopAt,
  };
}

export async function getTeamSyncPolicy(teamId: string): Promise<TeamSyncPolicy> {
  const entitlements = await api.get<TeamEntitlementsResponse>(
    `/teams/${teamId}/entitlements`,
  );
  const isMember = Boolean(entitlements.is_member);
  const allowed = Boolean(
    entitlements.can_team_sync ??
      entitlements.can_team_server_storage ??
      (entitlements.is_team_active && isMember),
  );
  const stopAt = entitlements.team_sync_stop_at ?? entitlements.expires_at ?? null;
  const daysToExpire =
    typeof entitlements.days_to_expire === "number"
      ? entitlements.days_to_expire
      : deriveDaysToExpire(stopAt);
  const status = inferStatus(
    parseSyncStatus(entitlements.team_sync_status),
    allowed,
    daysToExpire,
  );

  return {
    scope: "team",
    teamId,
    status,
    allowed,
    daysToExpire,
    stopAt,
    isMember,
    role: entitlements.role ?? null,
  };
}
