import { invoke } from "@tauri-apps/api/core";

export type ClawHubSkillSourceKind =
  | "team_proxy"
  | "personal_registry"
  | "public_registry";

export interface ClawHubRuntimeStatus {
  installed: boolean;
  version?: string;
  binary?: string;
  mode?: "http" | "cli" | "hybrid";
  site_url?: string;
  registry_url?: string;
}

export interface ClawHubSkillSearchEntry {
  slug: string;
  title?: string | null;
  description?: string | null;
  version?: string | null;
  origin_url?: string | null;
  site_url?: string | null;
  registry_url?: string | null;
  source_kind?: ClawHubSkillSourceKind | null;
}

export interface ClawHubSearchRequest {
  query: string;
  limit?: number;
  token?: string;
  site_url?: string;
  registry_url?: string;
  source_kind?: ClawHubSkillSourceKind;
}

export interface ClawHubSearchResult {
  entries: ClawHubSkillSearchEntry[];
  raw_output?: string;
}

export interface ClawHubInstallResult {
  skill_md: string;
  stdout: string;
  installed_spec: string;
  detected_skill_path?: string;
  bundle_base64?: string;
  bundle_root_path?: string;
  bundle_hash?: string;
  installed_version?: string;
  origin_url?: string;
  site_url?: string;
  registry_url?: string;
  legacy_fallback?: boolean;
}

export interface ClawHubVerifyResult {
  ok: boolean;
  stdout: string;
}

export interface ClawHubInstallRequest {
  slug: string;
  version?: string;
  token?: string;
  site_url?: string;
  registry_url?: string;
  source_kind?: ClawHubSkillSourceKind;
  bundle_base64?: string;
}

export async function getClawHubRuntimeStatus(): Promise<ClawHubRuntimeStatus> {
  return invoke<ClawHubRuntimeStatus>("skill_marketplace_clawhub_status");
}

export async function verifyClawHubToken(params: {
  token?: string;
  site_url?: string;
  registry_url?: string;
}): Promise<ClawHubVerifyResult> {
  return invoke<ClawHubVerifyResult>("skill_marketplace_clawhub_verify", params);
}

export async function searchClawHubSkills(
  params: ClawHubSearchRequest,
): Promise<ClawHubSearchResult> {
  return invoke<ClawHubSearchResult>("skill_marketplace_clawhub_search", { request: params });
}

export async function installClawHubSkill(
  params: ClawHubInstallRequest,
): Promise<ClawHubInstallResult> {
  return invoke<ClawHubInstallResult>("skill_marketplace_clawhub_install", { request: params });
}

export const getClawHubCliStatus = getClawHubRuntimeStatus;
