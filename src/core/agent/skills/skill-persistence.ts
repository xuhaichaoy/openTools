/**
 * Skill 持久化层
 *
 * 基于 Tauri Store 持久化用户自定义 Skill，
 * 与内置 Skill 合并后提供统一的 CRUD 接口。
 * 采用与 agent-role.ts 相同的缓存 + Tauri Store 模式。
 */

import { getTauriStore } from "@/core/storage";
import { handleError, ErrorLevel } from "@/core/errors";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { parseSkillMd, serializeSkillMd } from "./skill-md-parser";
import type {
  AgentSkill,
  AgentSkillInput,
  SkillMarketplaceMeta,
} from "./types";

const STORE_FILENAME = "agent-skills.json";
const STORE_KEY = "user_skills";
const MANUAL_ACTIVE_KEY = "manual_active_ids";

let userSkillsCache: AgentSkill[] | null = null;
let manualActiveIdsCache: string[] | null = null;

function generateId(): string {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function loadUserSkills(): Promise<AgentSkill[]> {
  if (userSkillsCache) return userSkillsCache;
  try {
    const store = await getTauriStore(STORE_FILENAME);
    const raw = await store.get<string>(STORE_KEY);
    if (typeof raw === "string") {
      userSkillsCache = JSON.parse(raw) as AgentSkill[];
    } else {
      userSkillsCache = [];
    }
    return userSkillsCache;
  } catch (e) {
    handleError(e, {
      context: "加载自定义 Skill",
      level: ErrorLevel.Warning,
      silent: true,
    });
    userSkillsCache = [];
    return [];
  }
}

async function saveUserSkills(skills: AgentSkill[]): Promise<void> {
  userSkillsCache = skills;
  try {
    const store = await getTauriStore(STORE_FILENAME);
    await store.set(STORE_KEY, JSON.stringify(skills));
  } catch (e) {
    handleError(e, {
      context: "保存自定义 Skill",
      level: ErrorLevel.Warning,
      silent: true,
    });
  }
}

// ── 内置 Skill 启用状态覆盖 ──

const BUILTIN_OVERRIDES_KEY = "builtin_overrides";
let builtinOverridesCache: Record<string, boolean> | null = null;

async function loadBuiltinOverrides(): Promise<Record<string, boolean>> {
  if (builtinOverridesCache) return builtinOverridesCache;
  try {
    const store = await getTauriStore(STORE_FILENAME);
    const raw = await store.get<string>(BUILTIN_OVERRIDES_KEY);
    builtinOverridesCache = raw ? JSON.parse(raw) : {};
    return builtinOverridesCache!;
  } catch {
    builtinOverridesCache = {};
    return {};
  }
}

async function saveBuiltinOverrides(overrides: Record<string, boolean>): Promise<void> {
  builtinOverridesCache = overrides;
  try {
    const store = await getTauriStore(STORE_FILENAME);
    await store.set(BUILTIN_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch (e) {
    handleError(e, {
      context: "保存内置 Skill 开关",
      level: ErrorLevel.Warning,
      silent: true,
    });
  }
}

// ── Public API ──

export async function getAllSkills(): Promise<AgentSkill[]> {
  const [user, overrides] = await Promise.all([
    loadUserSkills(),
    loadBuiltinOverrides(),
  ]);
  const builtins = BUILTIN_SKILLS.map((s) => ({
    ...s,
    enabled: overrides[s.id] ?? s.enabled,
  }));
  return [...builtins, ...user];
}

export async function getEnabledSkills(): Promise<AgentSkill[]> {
  const all = await getAllSkills();
  return all.filter((s) => s.enabled);
}

export async function getSkillById(id: string): Promise<AgentSkill | undefined> {
  const all = await getAllSkills();
  return all.find((s) => s.id === id);
}

export async function addSkill(input: AgentSkillInput): Promise<AgentSkill> {
  const now = Date.now();
  const skill: AgentSkill = {
    ...input,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };
  const user = await loadUserSkills();
  user.push(skill);
  await saveUserSkills(user);
  return skill;
}

export async function updateSkill(id: string, patch: Partial<AgentSkill>): Promise<boolean> {
  const isBuiltin = BUILTIN_SKILLS.some((s) => s.id === id);

  if (isBuiltin) {
    if ("enabled" in patch) {
      const overrides = await loadBuiltinOverrides();
      overrides[id] = !!patch.enabled;
      await saveBuiltinOverrides(overrides);
      return true;
    }
    return false;
  }

  const user = await loadUserSkills();
  const idx = user.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  user[idx] = { ...user[idx], ...patch, id, updatedAt: Date.now() };
  await saveUserSkills(user);
  return true;
}

export async function removeSkill(id: string): Promise<boolean> {
  if (BUILTIN_SKILLS.some((s) => s.id === id)) return false;
  const user = await loadUserSkills();
  const filtered = user.filter((s) => s.id !== id);
  if (filtered.length === user.length) return false;
  await saveUserSkills(filtered);
  return true;
}

export async function getManualActiveSkillIds(): Promise<string[]> {
  if (manualActiveIdsCache) return manualActiveIdsCache;
  try {
    const store = await getTauriStore(STORE_FILENAME);
    const raw = await store.get<string>(MANUAL_ACTIVE_KEY);
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        manualActiveIdsCache = [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
      } else {
        manualActiveIdsCache = [];
      }
    } else {
      manualActiveIdsCache = [];
    }
    return manualActiveIdsCache;
  } catch (e) {
    handleError(e, {
      context: "加载手动固定 Skill",
      level: ErrorLevel.Warning,
      silent: true,
    });
    manualActiveIdsCache = [];
    return [];
  }
}

export async function setManualActiveSkillIds(ids: string[]): Promise<void> {
  const normalized = [...new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0))];
  manualActiveIdsCache = normalized;
  try {
    const store = await getTauriStore(STORE_FILENAME);
    await store.set(MANUAL_ACTIVE_KEY, JSON.stringify(normalized));
  } catch (e) {
    handleError(e, {
      context: "保存手动固定 Skill",
      level: ErrorLevel.Warning,
      silent: true,
    });
  }
}

/** 清除缓存（用于测试或热重载） */
export function clearSkillCache(): void {
  userSkillsCache = null;
  builtinOverridesCache = null;
  manualActiveIdsCache = null;
}

// ── SKILL.md Import / Export ──

/**
 * Import a skill from SKILL.md content string.
 * Returns the created skill, or null if parsing failed.
 */
export async function importSkillFromMd(content: string): Promise<AgentSkill | null> {
  const parsed = parseSkillMd(content);
  if (!parsed) return null;

  const user = await loadUserSkills();
  const existing = user.find(
    (s) => s.source === "skillmd" && s.name === parsed.name,
  );
  if (existing) {
    Object.assign(existing, {
      ...parsed,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    });
    await saveUserSkills(user);
    return existing;
  }

  parsed.id = generateId();
  user.push(parsed);
  await saveUserSkills(user);
  return parsed;
}

export async function importMarketplaceSkillFromMd(params: {
  content: string;
  marketplaceMeta: SkillMarketplaceMeta;
}): Promise<AgentSkill | null> {
  const parsed = parseSkillMd(params.content);
  if (!parsed) return null;

  const now = Date.now();
  const nextMarketplaceMeta: SkillMarketplaceMeta = {
    ...params.marketplaceMeta,
    installedAt: now,
  };
  const user = await loadUserSkills();
  const existing = user.find((skill) =>
    skill.source === "marketplace"
    && skill.marketplaceMeta?.provider === nextMarketplaceMeta.provider
    && skill.marketplaceMeta?.slug === nextMarketplaceMeta.slug
  );

  if (existing) {
    Object.assign(existing, {
      ...parsed,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      enabled: existing.enabled,
      source: "marketplace",
      marketplaceMeta: nextMarketplaceMeta,
    } satisfies AgentSkill);
    await saveUserSkills(user);
    return existing;
  }

  const skill: AgentSkill = {
    ...parsed,
    id: generateId(),
    source: "marketplace",
    marketplaceMeta: nextMarketplaceMeta,
    createdAt: now,
    updatedAt: now,
  };
  user.push(skill);
  await saveUserSkills(user);
  return skill;
}

/**
 * Export a skill to SKILL.md format string.
 */
export function exportSkillToMd(skill: AgentSkill): string {
  return serializeSkillMd(skill);
}
