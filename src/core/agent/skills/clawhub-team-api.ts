import { api } from "@/core/api/client";
import {
  normalizeClawHubRegistryUrl,
  normalizeClawHubSiteUrl,
} from "./clawhub-config";
import type {
  ClawHubInstallResult,
  ClawHubSkillSearchEntry,
  ClawHubVerifyResult,
} from "./clawhub-tauri";

export interface TeamClawHubConfig {
  id?: string;
  provider: "clawhub";
  site_url: string;
  registry_url: string;
  is_active: boolean;
  masked_token?: string | null;
  token?: string;
  updated_at?: string;
}

export interface TeamClawHubSearchEntry extends ClawHubSkillSearchEntry {}

export interface TeamClawHubStatus {
  provider: "clawhub";
  configured: boolean;
  active: boolean;
  site_url?: string | null;
  registry_url?: string | null;
  updated_at?: string | null;
  can_search: boolean;
  can_install: boolean;
  service_ready?: boolean;
}

export async function getTeamClawHubConfig(
  teamId: string,
  options?: { resolveToken?: boolean },
): Promise<TeamClawHubConfig | null> {
  const payload = await api.get<{ config?: TeamClawHubConfig | null }>(
    `/teams/${teamId}/skill-marketplace-config`,
    options?.resolveToken ? { resolve: "true" } : undefined,
  );
  const config = payload?.config ?? null;
  if (!config) return null;
  return {
    provider: "clawhub",
    site_url: normalizeClawHubSiteUrl(config.site_url),
    registry_url: normalizeClawHubRegistryUrl(config.registry_url),
    is_active: config.is_active !== false,
    ...(config.id ? { id: config.id } : {}),
    ...(config.masked_token !== undefined ? { masked_token: config.masked_token } : {}),
    ...(config.token ? { token: config.token } : {}),
    ...(config.updated_at ? { updated_at: config.updated_at } : {}),
  };
}

export async function getTeamClawHubStatus(
  teamId: string,
): Promise<TeamClawHubStatus> {
  const payload = await api.get<TeamClawHubStatus>(
    `/teams/${teamId}/skill-marketplace-status`,
  );
  return {
    provider: "clawhub",
    configured: payload?.configured === true,
    active: payload?.active === true,
    site_url: payload?.site_url ? normalizeClawHubSiteUrl(payload.site_url) : null,
    registry_url: payload?.registry_url ? normalizeClawHubRegistryUrl(payload.registry_url) : null,
    updated_at: payload?.updated_at ?? null,
    can_search: payload?.can_search === true,
    can_install: payload?.can_install === true,
    service_ready: payload?.service_ready === true,
  };
}

export async function saveTeamClawHubConfig(params: {
  teamId: string;
  id?: string;
  token: string;
  is_active: boolean;
}): Promise<void> {
  await api.put(`/teams/${params.teamId}/skill-marketplace-config`, {
    id: params.id,
    provider: "clawhub",
    api_token: params.token,
    is_active: params.is_active,
  });
}

export async function verifyTeamClawHubConfig(
  teamId: string,
): Promise<ClawHubVerifyResult> {
  return api.post<ClawHubVerifyResult>(
    `/teams/${teamId}/skill-marketplace-config/verify`,
    {
      provider: "clawhub",
    },
  );
}

export async function installTeamClawHubSkill(params: {
  teamId: string;
  slug: string;
  version?: string;
}): Promise<ClawHubInstallResult> {
  return api.post<ClawHubInstallResult>(
    `/teams/${params.teamId}/skill-marketplace-install`,
    {
      provider: "clawhub",
      slug: params.slug,
      ...(params.version ? { version: params.version } : {}),
    },
  );
}

export async function searchTeamClawHubSkills(params: {
  teamId: string;
  query: string;
  limit?: number;
}): Promise<{ entries: TeamClawHubSearchEntry[]; raw_output: string; cached?: boolean }> {
  return api.post<{ entries: TeamClawHubSearchEntry[]; raw_output: string; cached?: boolean }>(
    `/teams/${params.teamId}/skill-marketplace-search`,
    {
      provider: "clawhub",
      query: params.query,
      ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
    },
  );
}
