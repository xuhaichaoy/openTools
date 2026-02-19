/**
 * 团队管理 Store
 *
 * 管理用户所属团队列表和当前选中的团队。
 * 提供团队资源共享 API 调用。
 */

import { create } from "zustand";
import { api, assertResponseShape } from "@/core/api/client";
import { handleError } from "@/core/errors";

export interface Team {
  id: string;
  name: string;
  description?: string;
  role: string;
  member_count?: number;
}

interface TeamState {
  teams: Team[];
  activeTeamId: string | null;
  loaded: boolean;

  loadTeams: () => Promise<void>;
  setActiveTeam: (teamId: string | null) => void;
  getActiveTeam: () => Team | null;

  /** 将资源共享到团队 */
  shareResource: (
    teamId: string,
    resourceType: string,
    resourceId: string,
    resourceName?: string,
  ) => Promise<void>;

  /** 取消共享 */
  unshareResource: (teamId: string, resourceDbId: string) => Promise<void>;

  /** 获取团队共享资源列表 */
  listSharedResources: (
    teamId: string,
    filterType?: string,
  ) => Promise<SharedResource[]>;
}

export interface SharedResource {
  id: string;
  team_id: string;
  user_id: string;
  resource_type: string;
  resource_id: string;
  resource_name: string | null;
  shared_at: string;
  username: string;
}

function isSharedResource(input: unknown): input is SharedResource {
  if (!input || typeof input !== "object") return false;
  const item = input as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.team_id === "string" &&
    typeof item.user_id === "string" &&
    typeof item.resource_type === "string" &&
    typeof item.resource_id === "string" &&
    (typeof item.resource_name === "string" || item.resource_name === null) &&
    typeof item.shared_at === "string" &&
    typeof item.username === "string"
  );
}

function isSharedResourceResponse(
  input: unknown,
): input is { resources: SharedResource[] } {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return (
    Array.isArray(value.resources) &&
    value.resources.every((item) => isSharedResource(item))
  );
}

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  activeTeamId: null,
  loaded: false,

  async loadTeams() {
    try {
      const teams = await api.get<Team[]>("/teams");
      set({ teams, loaded: true });
      // 自动选中第一个团队
      if (teams.length > 0 && !get().activeTeamId) {
        set({ activeTeamId: teams[0].id });
      }
    } catch (e) {
      handleError(e, { context: "加载团队列表" });
      set({ teams: [], loaded: true });
    }
  },

  setActiveTeam(teamId) {
    set({ activeTeamId: teamId });
  },

  getActiveTeam() {
    const { teams, activeTeamId } = get();
    return teams.find((t) => t.id === activeTeamId) ?? null;
  },

  async shareResource(teamId, resourceType, resourceId, resourceName) {
    await api.post(`/teams/${teamId}/share`, {
      resource_type: resourceType,
      resource_id: resourceId,
      resource_name: resourceName,
    });
  },

  async unshareResource(teamId, resourceDbId) {
    await api.delete(`/teams/${teamId}/resources/${resourceDbId}`);
  },

  async listSharedResources(teamId, filterType) {
    const path = `/teams/${teamId}/resources`;
    const payload = await api.get<unknown>(path);
    const { resources } = assertResponseShape(
      payload,
      isSharedResourceResponse,
      path,
      "团队资源接口返回结构不正确",
    );
    const all = resources;
    if (filterType) {
      return all.filter((r) => r.resource_type === filterType);
    }
    return all;
  },
}));
