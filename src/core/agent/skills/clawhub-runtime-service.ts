import {
  DEFAULT_CLAWHUB_REGISTRY_URL,
  DEFAULT_CLAWHUB_SITE_URL,
  loadClawHubPersonalConfig,
} from "./clawhub-config";
import {
  getTeamClawHubStatus,
  installTeamClawHubSkill,
  searchTeamClawHubSkills,
  type TeamClawHubSearchEntry,
} from "./clawhub-team-api";
import {
  installClawHubSkill,
  searchClawHubSkills,
  type ClawHubInstallResult,
  type ClawHubSkillSearchEntry,
  type ClawHubSkillSourceKind,
} from "./clawhub-tauri";
import { getAllSkills, importMarketplaceSkillFromMd } from "./skill-persistence";
import { useSkillStore } from "@/store/skill-store";
import { useTeamStore } from "@/store/team-store";

export const CLAWHUB_EXPLICIT_REQUEST_REFUSAL =
  "当前消息未显式要求去 ClawHub 搜索 skill，请先明确说明“去 ClawHub 搜...”";

export interface ClawHubRuntimeSkillCandidate {
  slug: string;
  title?: string | null;
  description?: string | null;
  version?: string | null;
  source: ClawHubSkillSourceKind;
  installable: boolean;
  reason?: string;
  originUrl?: string | null;
  siteUrl?: string | null;
  registryUrl?: string | null;
}

export interface ClawHubSearchContext {
  currentMessage?: string;
  limit?: number;
  requireExplicit?: boolean;
  teamId?: string | null;
}

export interface ClawHubInstallContext {
  currentMessage?: string;
  requireExplicit?: boolean;
  teamId?: string | null;
  resumePrompt?: string;
}

export interface ClawHubInstallCandidate {
  slug: string;
  version?: string | null;
  source: ClawHubSkillSourceKind;
}

export interface ClawHubRuntimeInstallResult {
  installed: boolean;
  skillId?: string;
  bundleRootPath?: string;
  resumeRequired: boolean;
  resumePrompt: string;
  installedVersion?: string;
  source: ClawHubSkillSourceKind;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isExplicitClawHubRequest(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized.includes("clawhub")) return false;
  return /(搜|搜索|找|查|安装|download|install)/i.test(normalized);
}

function ensureExplicitRequest(context?: {
  currentMessage?: string;
  requireExplicit?: boolean;
}): void {
  if (!context?.requireExplicit) return;
  if (!isExplicitClawHubRequest(context.currentMessage || "")) {
    throw new Error(CLAWHUB_EXPLICIT_REQUEST_REFUSAL);
  }
}

function mapRemoteEntry(
  entry: Pick<
    ClawHubSkillSearchEntry | TeamClawHubSearchEntry,
    "slug" | "title" | "description" | "version" | "origin_url" | "site_url" | "registry_url"
  >,
  source: ClawHubSkillSourceKind,
): ClawHubRuntimeSkillCandidate | null {
  const slug = String(entry.slug || "").trim();
  if (!slug) return null;
  return {
    slug,
    title: entry.title ?? null,
    description: entry.description ?? null,
    version: entry.version ?? null,
    source,
    installable: true,
    originUrl: entry.origin_url ?? null,
    siteUrl: entry.site_url ?? null,
    registryUrl: entry.registry_url ?? null,
  };
}

function dedupeCandidates(
  items: ClawHubRuntimeSkillCandidate[],
): ClawHubRuntimeSkillCandidate[] {
  const order: Record<ClawHubSkillSourceKind, number> = {
    team_proxy: 0,
    personal_registry: 1,
    public_registry: 2,
  };
  const byKey = new Map<string, ClawHubRuntimeSkillCandidate>();
  for (const item of items) {
    const key = `${item.slug}@@${item.version || "latest"}`;
    const existing = byKey.get(key);
    if (!existing || order[item.source] < order[existing.source]) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    const sourceDelta = order[left.source] - order[right.source];
    if (sourceDelta !== 0) return sourceDelta;
    return left.slug.localeCompare(right.slug);
  });
}

async function maybeSearchTeamProxy(
  goal: string,
  teamId: string | null | undefined,
  limit: number,
): Promise<ClawHubRuntimeSkillCandidate[]> {
  if (!teamId) return [];
  const status = await getTeamClawHubStatus(teamId).catch(() => null);
  if (!status?.active || !status.can_search) return [];
  const result = await searchTeamClawHubSkills({ teamId, query: goal, limit });
  return (result.entries ?? [])
    .map((entry) => mapRemoteEntry(entry, "team_proxy"))
    .filter((entry): entry is ClawHubRuntimeSkillCandidate => entry != null);
}

async function maybeSearchPersonal(
  goal: string,
  limit: number,
): Promise<ClawHubRuntimeSkillCandidate[]> {
  const personal = await loadClawHubPersonalConfig();
  if (!personal.token.trim()) return [];
  const result = await searchClawHubSkills({
    query: goal,
    limit,
    token: personal.token,
    site_url: personal.siteUrl,
    registry_url: personal.registryUrl,
    source_kind: "personal_registry",
  });
  return (result.entries ?? [])
    .map((entry) => mapRemoteEntry(entry, "personal_registry"))
    .filter((entry): entry is ClawHubRuntimeSkillCandidate => entry != null);
}

async function searchPublic(
  goal: string,
  limit: number,
): Promise<ClawHubRuntimeSkillCandidate[]> {
  const personal = await loadClawHubPersonalConfig().catch(() => null);
  const result = await searchClawHubSkills({
    query: goal,
    limit,
    site_url: personal?.siteUrl || DEFAULT_CLAWHUB_SITE_URL,
    registry_url: personal?.registryUrl || DEFAULT_CLAWHUB_REGISTRY_URL,
    source_kind: "public_registry",
  });
  return (result.entries ?? [])
    .map((entry) => mapRemoteEntry(entry, "public_registry"))
    .filter((entry): entry is ClawHubRuntimeSkillCandidate => entry != null);
}

async function persistInstalledSkill(
  installResult: ClawHubInstallResult,
  candidate: ClawHubInstallCandidate,
  teamId?: string | null,
): Promise<string> {
  const skill = await importMarketplaceSkillFromMd({
    content: installResult.skill_md,
    marketplaceMeta: {
      provider: "clawhub",
      slug: candidate.slug,
      remoteVersion: candidate.version ?? undefined,
      installedVersion:
        installResult.installed_version ?? candidate.version ?? undefined,
      installedVia: candidate.source === "team_proxy" ? "team" : "personal",
      sourceKind: candidate.source,
      ...(teamId && candidate.source === "team_proxy" ? { teamId } : {}),
      siteUrl: installResult.site_url ?? undefined,
      registryUrl: installResult.registry_url ?? undefined,
      bundleRootPath: installResult.bundle_root_path ?? undefined,
      bundleHash: installResult.bundle_hash ?? undefined,
      originUrl: installResult.origin_url ?? undefined,
    },
  });
  if (!skill) {
    throw new Error("已下载 ClawHub bundle，但当前项目无法解析其中的 SKILL.md");
  }
  await useSkillStore.getState().reload();
  return skill.id;
}

export const clawHubRuntimeService = {
  isExplicitClawHubRequest,

  async searchSkills(
    goal: string,
    context?: ClawHubSearchContext,
  ): Promise<ClawHubRuntimeSkillCandidate[]> {
    ensureExplicitRequest(context);
    const trimmedGoal = normalizeText(goal);
    if (!trimmedGoal) {
      throw new Error("goal 不能为空");
    }
    const limit = Math.min(Math.max(context?.limit ?? 8, 1), 20);
    const teamId = context?.teamId ?? useTeamStore.getState().activeTeamId;
    const settled = await Promise.allSettled([
      maybeSearchTeamProxy(trimmedGoal, teamId, limit),
      maybeSearchPersonal(trimmedGoal, limit),
      searchPublic(trimmedGoal, limit),
    ]);

    const entries = dedupeCandidates(
      settled.flatMap((item) => (item.status === "fulfilled" ? item.value : [])),
    ).slice(0, limit);
    if (entries.length > 0) return entries;

    const firstError = settled.find((item) => item.status === "rejected");
    if (firstError?.status === "rejected") {
      throw firstError.reason instanceof Error
        ? firstError.reason
        : new Error(String(firstError.reason));
    }
    return [];
  },

  async installSkill(
    candidate: ClawHubInstallCandidate,
    context?: ClawHubInstallContext,
  ): Promise<ClawHubRuntimeInstallResult> {
    ensureExplicitRequest(context);
    const slug = normalizeText(candidate.slug);
    if (!slug) throw new Error("slug 不能为空");
    const teamId = context?.teamId ?? useTeamStore.getState().activeTeamId;
    const installResult = await (async () => {
      if (candidate.source === "team_proxy") {
        if (!teamId) {
          throw new Error("当前没有可用的团队上下文，无法通过团队代理安装");
        }
        const proxyResult = await installTeamClawHubSkill({
          teamId,
          slug,
          ...(candidate.version ? { version: candidate.version } : {}),
        });
        if (!proxyResult.bundle_base64) {
          throw new Error("团队代理未返回可安装的 bundle 数据");
        }
        return installClawHubSkill({
          slug,
          ...(candidate.version ? { version: candidate.version } : {}),
          site_url: proxyResult.site_url ?? DEFAULT_CLAWHUB_SITE_URL,
          registry_url: proxyResult.registry_url ?? DEFAULT_CLAWHUB_REGISTRY_URL,
          source_kind: "team_proxy",
          bundle_base64: proxyResult.bundle_base64,
        });
      }

      const personal = await loadClawHubPersonalConfig();
      return installClawHubSkill({
        slug,
        ...(candidate.version ? { version: candidate.version } : {}),
        token: candidate.source === "personal_registry" ? personal.token : undefined,
        site_url: personal.siteUrl || DEFAULT_CLAWHUB_SITE_URL,
        registry_url: personal.registryUrl || DEFAULT_CLAWHUB_REGISTRY_URL,
        source_kind: candidate.source,
      });
    })();

    const skillId = await persistInstalledSkill(installResult, candidate, teamId);
    return {
      installed: true,
      skillId,
      bundleRootPath: installResult.bundle_root_path ?? undefined,
      resumeRequired: true,
      resumePrompt:
        context?.resumePrompt || "已安装所需 ClawHub skill，请继续处理刚才任务",
      installedVersion:
        installResult.installed_version ?? candidate.version ?? undefined,
      source: candidate.source,
    };
  },

  async listInstalledSkills(): Promise<
    Array<{
      skillId: string;
      slug: string;
      version?: string;
      sourceKind?: ClawHubSkillSourceKind;
      bundleRootPath?: string;
    }>
  > {
    const skills = await getAllSkills();
    return skills
      .filter(
        (skill) =>
          skill.source === "marketplace"
          && skill.marketplaceMeta?.provider === "clawhub",
      )
      .map((skill) => ({
        skillId: skill.id,
        slug: skill.marketplaceMeta?.slug || skill.name,
        version:
          skill.marketplaceMeta?.installedVersion
          || skill.marketplaceMeta?.remoteVersion
          || skill.version,
        sourceKind: skill.marketplaceMeta?.sourceKind,
        bundleRootPath: skill.marketplaceMeta?.bundleRootPath,
      }));
  },
};
