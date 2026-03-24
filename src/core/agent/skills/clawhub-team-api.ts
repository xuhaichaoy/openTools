import { api } from "@/core/api/client";
import {
  DEFAULT_CLAWHUB_REGISTRY_URL,
  DEFAULT_CLAWHUB_SITE_URL,
} from "./clawhub-config";
import type {
  ClawHubInstallResult,
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

export interface TeamClawHubSearchEntry {
  slug: string;
  title?: string | null;
  description?: string | null;
}

export interface TeamClawHubStatus {
  provider: "clawhub";
  configured: boolean;
  active: boolean;
  site_url?: string | null;
  registry_url?: string | null;
  updated_at?: string | null;
  cli_installed: boolean;
  cli_version?: string | null;
  can_search: boolean;
  can_install: boolean;
}

export interface TeamPublishedSkill {
  id: string;
  team_id: string;
  provider: "clawhub";
  slug: string;
  version: string;
  display_name: string;
  description?: string | null;
  is_active: boolean;
  published_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
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
    site_url: config.site_url?.trim() || DEFAULT_CLAWHUB_SITE_URL,
    registry_url: config.registry_url?.trim() || DEFAULT_CLAWHUB_REGISTRY_URL,
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
    site_url: payload?.site_url?.trim() || null,
    registry_url: payload?.registry_url?.trim() || null,
    updated_at: payload?.updated_at ?? null,
    cli_installed: payload?.cli_installed === true,
    cli_version: payload?.cli_version ?? null,
    can_search: payload?.can_search === true,
    can_install: payload?.can_install === true,
  };
}

export async function saveTeamClawHubConfig(params: {
  teamId: string;
  id?: string;
  site_url: string;
  registry_url: string;
  token: string;
  is_active: boolean;
}): Promise<void> {
  await api.put(`/teams/${params.teamId}/skill-marketplace-config`, {
    id: params.id,
    provider: "clawhub",
    site_url: params.site_url,
    registry_url: params.registry_url,
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

export async function listTeamPublishedSkills(
  teamId: string,
): Promise<TeamPublishedSkill[]> {
  const payload = await api.get<{ skills?: TeamPublishedSkill[] }>(
    `/teams/${teamId}/published-skills`,
  );
  return payload?.skills ?? [];
}

export async function publishTeamClawHubSkill(params: {
  teamId: string;
  slug: string;
  version?: string;
}): Promise<{ skill: TeamPublishedSkill; stdout: string }> {
  return api.post<{ skill: TeamPublishedSkill; stdout: string }>(
    `/teams/${params.teamId}/published-skills`,
    {
      provider: "clawhub",
      slug: params.slug,
      ...(params.version ? { version: params.version } : {}),
    },
  );
}

export async function patchTeamPublishedSkill(params: {
  teamId: string;
  skillId: string;
  is_active: boolean;
}): Promise<void> {
  await api.patch(`/teams/${params.teamId}/published-skills/${params.skillId}`, {
    is_active: params.is_active,
  });
}

export async function installTeamPublishedSkill(params: {
  teamId: string;
  skillId: string;
}): Promise<ClawHubInstallResult> {
  return api.post<ClawHubInstallResult>(
    `/teams/${params.teamId}/published-skills/${params.skillId}/install`,
  );
}
