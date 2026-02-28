import { getTauriStore } from "@/core/storage";
import { handleError, ErrorLevel } from "@/core/errors";
import { PRESET_ROLES, getRoleById as getPresetRoleById } from "./preset-roles";
import type { AgentRole } from "./types";

const STORE_FILENAME = "agent-cluster-roles.json";
const STORE_KEY = "custom_roles";

let customRolesCache: AgentRole[] | null = null;

async function loadCustomRoles(): Promise<AgentRole[]> {
  if (customRolesCache) return customRolesCache;
  try {
    const store = await getTauriStore(STORE_FILENAME);
    const raw = await store.get<string>(STORE_KEY);
    if (typeof raw === "string") {
      customRolesCache = JSON.parse(raw) as AgentRole[];
    } else {
      customRolesCache = [];
    }
    return customRolesCache;
  } catch (e) {
    handleError(e, {
      context: "加载自定义 Agent 角色",
      level: ErrorLevel.Warning,
      silent: true,
    });
    customRolesCache = [];
    return [];
  }
}

async function saveCustomRoles(roles: AgentRole[]): Promise<void> {
  customRolesCache = roles;
  try {
    const store = await getTauriStore(STORE_FILENAME);
    await store.set(STORE_KEY, JSON.stringify(roles));
  } catch (e) {
    handleError(e, {
      context: "保存自定义 Agent 角色",
      level: ErrorLevel.Warning,
      silent: true,
    });
  }
}

export async function getAllRoles(): Promise<AgentRole[]> {
  const custom = await loadCustomRoles();
  return [...PRESET_ROLES, ...custom];
}

export function getPresetRoles(): AgentRole[] {
  return [...PRESET_ROLES];
}

export async function getRoleById(id: string): Promise<AgentRole | undefined> {
  if (!id) return undefined;
  const preset = getPresetRoleById(id);
  if (preset) return preset;
  const custom = await loadCustomRoles();
  return custom.find((r) => r.id === id);
}

export async function addCustomRole(role: AgentRole): Promise<void> {
  if (PRESET_ROLES.some((r) => r.id === role.id)) {
    throw new Error(`角色 ID "${role.id}" 与预设角色冲突`);
  }
  const custom = await loadCustomRoles();
  const existingIdx = custom.findIndex((r) => r.id === role.id);
  if (existingIdx >= 0) {
    custom[existingIdx] = role;
  } else {
    custom.push(role);
  }
  await saveCustomRoles(custom);
}

export async function removeCustomRole(id: string): Promise<boolean> {
  if (PRESET_ROLES.some((r) => r.id === id)) return false;
  const custom = await loadCustomRoles();
  const filtered = custom.filter((r) => r.id !== id);
  if (filtered.length === custom.length) return false;
  await saveCustomRoles(filtered);
  return true;
}

export function filterToolsByRole(
  toolNames: string[],
  role: AgentRole,
): string[] {
  if (!role.toolFilter) return toolNames;
  let filtered = toolNames;
  if (role.toolFilter.include) {
    const includeSet = new Set(role.toolFilter.include);
    filtered = filtered.filter((name) => includeSet.has(name));
  }
  if (role.toolFilter.exclude) {
    const excludeSet = new Set(role.toolFilter.exclude);
    filtered = filtered.filter((name) => !excludeSet.has(name));
  }
  return filtered;
}
