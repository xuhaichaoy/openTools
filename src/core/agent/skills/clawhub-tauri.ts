import { invoke } from "@tauri-apps/api/core";

export interface ClawHubCliStatus {
  installed: boolean;
  version?: string;
  binary?: string;
}

export interface ClawHubInstallResult {
  skill_md: string;
  stdout: string;
  installed_spec: string;
  detected_skill_path?: string;
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
}

export async function getClawHubCliStatus(): Promise<ClawHubCliStatus> {
  return invoke<ClawHubCliStatus>("skill_marketplace_clawhub_status");
}

export async function verifyClawHubToken(params: {
  token?: string;
  site_url?: string;
  registry_url?: string;
}): Promise<ClawHubVerifyResult> {
  return invoke<ClawHubVerifyResult>("skill_marketplace_clawhub_verify", params);
}

export async function installClawHubSkill(
  params: ClawHubInstallRequest,
): Promise<ClawHubInstallResult> {
  return invoke<ClawHubInstallResult>("skill_marketplace_clawhub_install", { request: params });
}
