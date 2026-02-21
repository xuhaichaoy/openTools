/**
 * 团队管理 Store
 *
 * 管理用户所属团队列表和当前选中的团队。
 * 提供团队资源共享 API 调用。
 */

import { create } from "zustand";
import { api, assertResponseShape } from "@/core/api/client";
import { handleError } from "@/core/errors";
import type { Workflow } from "@/core/workflows/types";

export interface Team {
  id: string;
  name: string;
  owner_id?: string;
  avatar_url?: string;
  created_at?: string;
  subscription_plan?: "trial" | "pro";
  subscription_started_at?: string;
  subscription_expires_at?: string | null;
  subscription_updated_at?: string;
}

export interface TeamEntitlements {
  team_plan: "trial" | "pro";
  is_team_active: boolean;
  can_team_server_storage?: boolean;
  expires_at: string | null;
  status: "trial_active" | "pro_active" | "expired";
  is_member: boolean;
  role: "owner" | "admin" | "member" | null;
}

export interface TeamWorkflowTemplateSummary {
  id: string;
  team_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  is_legacy: boolean;
  legacy_resource_id?: string | null;
  created_by_username?: string | null;
}

export interface TeamWorkflowTemplateDetail
  extends Omit<TeamWorkflowTemplateSummary, "id"> {
  id: string;
  workflow_json: Workflow;
}

export interface CreateTeamWorkflowTemplatePayload {
  name: string;
  description?: string;
  icon?: string;
  category?: string;
  workflow_json: Omit<Workflow, "id" | "builtin" | "created_at">;
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

  /** 获取团队订阅权益 */
  getTeamEntitlements: (teamId: string) => Promise<TeamEntitlements>;

  /** 获取团队工作流模板列表 */
  listWorkflowTemplates: (
    teamId: string,
  ) => Promise<TeamWorkflowTemplateSummary[]>;

  /** 创建团队工作流模板 */
  createWorkflowTemplate: (
    teamId: string,
    payload: CreateTeamWorkflowTemplatePayload,
  ) => Promise<TeamWorkflowTemplateDetail>;

  /** 获取团队工作流模板详情 */
  getWorkflowTemplate: (
    teamId: string,
    templateId: string,
  ) => Promise<TeamWorkflowTemplateDetail>;
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

function isTeamEntitlements(input: unknown): input is TeamEntitlements {
  if (!input || typeof input !== "object") return false;
  const item = input as Record<string, unknown>;
  return (
    (item.team_plan === "trial" || item.team_plan === "pro") &&
    typeof item.is_team_active === "boolean" &&
    (typeof item.can_team_server_storage === "boolean" ||
      item.can_team_server_storage === undefined) &&
    (typeof item.expires_at === "string" || item.expires_at === null) &&
    (item.status === "trial_active" ||
      item.status === "pro_active" ||
      item.status === "expired") &&
    typeof item.is_member === "boolean" &&
    (item.role === "owner" ||
      item.role === "admin" ||
      item.role === "member" ||
      item.role === null)
  );
}

function isTeamWorkflowTemplateSummary(
  input: unknown,
): input is TeamWorkflowTemplateSummary {
  if (!input || typeof input !== "object") return false;
  const item = input as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.team_id === "string" &&
    typeof item.name === "string" &&
    (typeof item.description === "string" || item.description === null) &&
    (typeof item.icon === "string" || item.icon === null) &&
    (typeof item.category === "string" || item.category === null) &&
    typeof item.version === "number" &&
    typeof item.created_by === "string" &&
    typeof item.updated_by === "string" &&
    typeof item.created_at === "string" &&
    typeof item.updated_at === "string" &&
    typeof item.is_legacy === "boolean"
  );
}

function isTeamWorkflowTemplateListResponse(
  input: unknown,
): input is { templates: TeamWorkflowTemplateSummary[] } {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return (
    Array.isArray(value.templates) &&
    value.templates.every((item) => isTeamWorkflowTemplateSummary(item))
  );
}

function isTeamWorkflowTemplateDetail(
  input: unknown,
): input is TeamWorkflowTemplateDetail {
  if (!isTeamWorkflowTemplateSummary(input)) return false;
  const item = input as unknown as Record<string, unknown>;
  return typeof item.workflow_json === "object" && item.workflow_json !== null;
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

  async getTeamEntitlements(teamId) {
    const path = `/teams/${teamId}/entitlements`;
    const payload = await api.get<unknown>(path);
    return assertResponseShape(
      payload,
      isTeamEntitlements,
      path,
      "团队权益接口返回结构不正确",
    );
  },

  async listWorkflowTemplates(teamId) {
    const path = `/teams/${teamId}/workflow-templates`;
    const payload = await api.get<unknown>(path);
    const { templates } = assertResponseShape(
      payload,
      isTeamWorkflowTemplateListResponse,
      path,
      "团队工作流模板接口返回结构不正确",
    );
    return templates;
  },

  async createWorkflowTemplate(teamId, payload) {
    const path = `/teams/${teamId}/workflow-templates`;
    const result = await api.post<unknown>(path, payload);
    return assertResponseShape(
      result,
      isTeamWorkflowTemplateDetail,
      path,
      "创建团队工作流模板返回结构不正确",
    );
  },

  async getWorkflowTemplate(teamId, templateId) {
    const path = `/teams/${teamId}/workflow-templates/${templateId}`;
    const result = await api.get<unknown>(path);
    return assertResponseShape(
      result,
      isTeamWorkflowTemplateDetail,
      path,
      "团队工作流模板详情返回结构不正确",
    );
  },
}));
