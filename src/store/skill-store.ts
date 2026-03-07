/**
 * Skill Zustand Store
 *
 * 提供响应式的 Skill 管理状态，驱动 UI 更新。
 * 底层持久化委托给 skill-persistence.ts 的 Tauri Store 层。
 */

import { create } from "zustand";
import type { AgentSkill, AgentSkillInput, ResolvedSkillContext } from "@/core/agent/skills/types";
import { resolveSkills } from "@/core/agent/skills/skill-resolver";
import {
  getAllSkills,
  addSkill as addSkillPersist,
  updateSkill as updateSkillPersist,
  removeSkill as removeSkillPersist,
  getManualActiveSkillIds,
  setManualActiveSkillIds,
} from "@/core/agent/skills/skill-persistence";

interface SkillStoreState {
  skills: AgentSkill[];
  loaded: boolean;

  /** 手动激活的 Skill ID 集合（这些 Skill 无论 autoActivate 如何都会激活） */
  manualActiveIds: Set<string>;

  load: () => Promise<void>;
  reload: () => Promise<void>;
  add: (input: AgentSkillInput) => Promise<AgentSkill>;
  update: (id: string, patch: Partial<AgentSkill>) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  toggleEnabled: (id: string) => Promise<void>;
  toggleManualActive: (id: string) => void;
  clearManualActive: () => void;
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills: [],
  loaded: false,
  manualActiveIds: new Set(),

  load: async () => {
    if (get().loaded) return;
    const [skills, persistedManualIds] = await Promise.all([
      getAllSkills(),
      getManualActiveSkillIds(),
    ]);
    const skillIdSet = new Set(skills.map((s) => s.id));
    const validManualIds = persistedManualIds.filter((id) => skillIdSet.has(id));
    set({
      skills,
      loaded: true,
      manualActiveIds: new Set(validManualIds),
    });
    if (validManualIds.length !== persistedManualIds.length) {
      await setManualActiveSkillIds(validManualIds);
    }
  },

  reload: async () => {
    const [skills, persistedManualIds] = await Promise.all([
      getAllSkills(),
      getManualActiveSkillIds(),
    ]);
    const skillIdSet = new Set(skills.map((s) => s.id));
    const validManualIds = persistedManualIds.filter((id) => skillIdSet.has(id));
    set({
      skills,
      loaded: true,
      manualActiveIds: new Set(validManualIds),
    });
    if (validManualIds.length !== persistedManualIds.length) {
      await setManualActiveSkillIds(validManualIds);
    }
  },

  add: async (input) => {
    const skill = await addSkillPersist(input);
    await get().reload();
    return skill;
  },

  update: async (id, patch) => {
    const ok = await updateSkillPersist(id, patch);
    if (ok) await get().reload();
    return ok;
  },

  remove: async (id) => {
    const ok = await removeSkillPersist(id);
    if (ok) {
      let nextManual: Set<string> = new Set();
      set((s) => {
        const next = new Set(s.manualActiveIds);
        next.delete(id);
        nextManual = next;
        return { manualActiveIds: next };
      });
      await setManualActiveSkillIds([...nextManual]);
      await get().reload();
    }
    return ok;
  },

  toggleEnabled: async (id) => {
    const skill = get().skills.find((s) => s.id === id);
    if (!skill) return;
    await updateSkillPersist(id, { enabled: !skill.enabled });
    await get().reload();
  },

  toggleManualActive: (id) => {
    let nextManual: Set<string> = new Set();
    set((s) => {
      const next = new Set(s.manualActiveIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      nextManual = next;
      return { manualActiveIds: next };
    });
    void setManualActiveSkillIds([...nextManual]);
  },

  clearManualActive: () => {
    set({ manualActiveIds: new Set() });
    void setManualActiveSkillIds([]);
  },
}));

/**
 * 一站式加载 + 解析技能。
 *
 * 自动处理 store 未加载的情况，消除各消费方的重复 boilerplate。
 */
const EMPTY_SKILL_CONTEXT: ResolvedSkillContext = {
  activeSkillIds: [],
  mergedSystemPrompt: "",
  mergedToolFilter: {},
};

/**
 * 一站式加载 + 解析技能。
 *
 * 自动处理 store 未加载的情况和异常，消除各消费方的重复 boilerplate。
 * 即使加载失败也不会抛出，返回空上下文。
 */
export async function loadAndResolveSkills(
  query: string,
  roleHint?: string,
): Promise<ResolvedSkillContext> {
  try {
    let snap = useSkillStore.getState();
    if (!snap.loaded) {
      await snap.load();
      snap = useSkillStore.getState();
    }
    const enabled = snap.skills.filter((s) => s.enabled);
    if (enabled.length === 0) return EMPTY_SKILL_CONTEXT;
    return resolveSkills(enabled, query, [...snap.manualActiveIds], roleHint);
  } catch {
    return EMPTY_SKILL_CONTEXT;
  }
}
