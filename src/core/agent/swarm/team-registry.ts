import type { AgentCapability } from "../actor/types";
import type { AgentBackendRegistry } from "../backends/registry";
import type { AgentBackendId } from "../backends/types";
import { TeamContext, type TeamSnapshot, type TeamTeammate } from "./team-context";

export interface TeamActorSnapshot {
  id: string;
  name: string;
  capabilities?: AgentCapability[];
  workspace?: string;
}

export type TeamTeammateInput =
  | string
  | {
      id?: string;
      name: string;
      actorId?: string;
      actorName?: string;
      aliases?: string[];
      backendId?: AgentBackendId;
      description?: string;
      capabilities?: AgentCapability[];
      workspace?: string;
    };

export interface CreateTeamParams {
  name: string;
  description?: string;
  defaultBackendId?: AgentBackendId;
  createdByActorId: string;
  teammates?: TeamTeammateInput[];
}

export interface CreateTeamResult {
  created: boolean;
  updated: boolean;
  team: TeamSnapshot;
}

interface TeamRegistryDependencies {
  backendRegistry: AgentBackendRegistry;
  listKnownActors?: () => TeamActorSnapshot[];
}

function createTeamId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "team";
  return `team-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTeamName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function createTeammateId(name: string, index: number): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || `teammate-${index + 1}`;
  return `teammate-${slug}-${index + 1}`;
}

export class TeamRegistry {
  private readonly teams = new Map<string, TeamContext>();
  private readonly deps: TeamRegistryDependencies;

  constructor(deps: TeamRegistryDependencies) {
    this.deps = deps;
  }

  private resolveKnownActor(candidate?: string): TeamActorSnapshot | undefined {
    const normalizedCandidate = String(candidate ?? "").trim();
    if (!normalizedCandidate) return undefined;

    return this.deps.listKnownActors?.().find((actor) =>
      actor.id === normalizedCandidate || actor.name === normalizedCandidate);
  }

  private normalizeTeammateInput(
    input: TeamTeammateInput,
    index: number,
    defaultBackendId: AgentBackendId,
  ): TeamTeammate {
    if (typeof input === "string") {
      const resolvedActor = this.resolveKnownActor(input);
      return {
        id: createTeammateId(resolvedActor?.name ?? input, index),
        name: resolvedActor?.name ?? input.trim(),
        actorId: resolvedActor?.id,
        actorName: resolvedActor?.name ?? input.trim(),
        backendId: defaultBackendId,
        ...(resolvedActor?.capabilities ? { capabilities: [...resolvedActor.capabilities] } : {}),
        ...(resolvedActor?.workspace ? { workspace: resolvedActor.workspace } : {}),
      };
    }

    const resolvedActor = this.resolveKnownActor(input.actorId ?? input.actorName ?? input.name);
    return {
      id: input.id?.trim() || createTeammateId(input.name, index),
      name: input.name.trim(),
      actorId: input.actorId?.trim() || resolvedActor?.id,
      actorName: input.actorName?.trim() || resolvedActor?.name || input.name.trim(),
      backendId: input.backendId?.trim() || defaultBackendId,
      ...(input.aliases?.length ? { aliases: [...input.aliases] } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.capabilities?.length
        ? { capabilities: [...input.capabilities] }
        : resolvedActor?.capabilities?.length
          ? { capabilities: [...resolvedActor.capabilities] }
          : {}),
      ...(input.workspace?.trim()
        ? { workspace: input.workspace.trim() }
        : resolvedActor?.workspace
          ? { workspace: resolvedActor.workspace }
          : {}),
    };
  }

  private deriveDefaultTeammates(createdByActorId: string, defaultBackendId: AgentBackendId): TeamTeammate[] {
    const knownActors = this.deps.listKnownActors?.() ?? [];
    return knownActors
      .filter((actor) => actor.id !== createdByActorId)
      .map((actor, index) => ({
        id: createTeammateId(actor.name, index),
        name: actor.name,
        actorId: actor.id,
        actorName: actor.name,
        backendId: defaultBackendId,
        ...(actor.capabilities?.length ? { capabilities: [...actor.capabilities] } : {}),
        ...(actor.workspace ? { workspace: actor.workspace } : {}),
      }));
  }

  private ensureBackendExists(backendId: AgentBackendId): void {
    if (!this.deps.backendRegistry.has(backendId)) {
      throw new Error(`backend "${backendId}" 不存在`);
    }
  }

  private findTeamByName(teamName: string): TeamContext | undefined {
    const normalizedName = normalizeTeamName(teamName);
    return [...this.teams.values()].find((team) => normalizeTeamName(team.name) === normalizedName);
  }

  createTeam(params: CreateTeamParams): CreateTeamResult {
    const teamName = params.name.trim();
    if (!teamName) {
      throw new Error("team name 不能为空");
    }

    const defaultBackendId = params.defaultBackendId?.trim() || this.deps.backendRegistry.defaultBackendId;
    this.ensureBackendExists(defaultBackendId);

    const existing = this.findTeamByName(teamName);
    const existingSnapshot = existing?.snapshot();
    const teammateInputs = params.teammates;
    const normalizedTeammates = teammateInputs
      ? teammateInputs.map((input, index) => this.normalizeTeammateInput(input, index, defaultBackendId))
      : existing
        ? existing.listTeammates().map((teammate) => ({
            ...teammate,
            backendId: teammate.backendId === existingSnapshot?.defaultBackendId
              ? defaultBackendId
              : teammate.backendId,
          }))
        : this.deriveDefaultTeammates(params.createdByActorId, defaultBackendId);

    for (const teammate of normalizedTeammates) {
      this.ensureBackendExists(teammate.backendId ?? defaultBackendId);
    }

    if (existing) {
      existing.updateRecord({
        description: params.description?.trim() || existing.snapshot().description,
        defaultBackendId,
        teammates: normalizedTeammates,
      });
      return {
        created: false,
        updated: true,
        team: existing.snapshot(),
      };
    }

    const team = new TeamContext({
      id: createTeamId(teamName),
      name: teamName,
      description: params.description?.trim() || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdByActorId: params.createdByActorId.trim(),
      defaultBackendId,
      teammates: normalizedTeammates,
    }, {
      backendRegistry: this.deps.backendRegistry,
    });
    this.teams.set(team.id, team);

    return {
      created: true,
      updated: false,
      team: team.snapshot(),
    };
  }

  getTeam(teamIdOrName: string): TeamContext | undefined {
    const normalized = teamIdOrName.trim();
    if (!normalized) return undefined;
    return this.teams.get(normalized) ?? this.findTeamByName(normalized);
  }

  listTeams(): TeamSnapshot[] {
    return [...this.teams.values()].map((team) => team.snapshot());
  }

  deleteTeam(teamIdOrName: string, requesterActorId?: string): {
    deleted: boolean;
    teamId?: string;
    teamName?: string;
    error?: string;
  } {
    const team = this.getTeam(teamIdOrName);
    if (!team) {
      return {
        deleted: false,
        error: `team "${teamIdOrName}" 不存在`,
      };
    }

    const teamSnapshot = team.snapshot();
    if (
      requesterActorId?.trim()
      && requesterActorId.trim() !== teamSnapshot.createdByActorId
    ) {
      return {
        deleted: false,
        teamId: teamSnapshot.id,
        teamName: teamSnapshot.name,
        error: "只有 team owner 可以删除 team。",
      };
    }

    this.teams.delete(teamSnapshot.id);
    return {
      deleted: true,
      teamId: teamSnapshot.id,
      teamName: teamSnapshot.name,
    };
  }

  clear(): void {
    this.teams.clear();
  }

  getCurrentTeam(): TeamContext | undefined {
    return [...this.teams.values()][0];
  }

  getTeamByName(name: string): TeamContext | undefined {
    return this.findTeamByName(name);
  }

  static getInstance(): TeamRegistry {
    return getTeamRegistry();
  }
}

let globalRegistry: TeamRegistry | null = null;

export function getTeamRegistry(): TeamRegistry {
  if (!globalRegistry) {
    throw new Error("TeamRegistry not initialized. Call initTeamRegistry first.");
  }
  return globalRegistry;
}

export function initTeamRegistry(deps: TeamRegistryDependencies): TeamRegistry {
  globalRegistry = new TeamRegistry(deps);
  return globalRegistry;
}
