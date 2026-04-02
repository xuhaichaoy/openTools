import type {
  AgentCapability,
  SpawnTaskOverrides,
  SpawnedTaskRoleBoundary,
  WorkerProfileId,
} from "@/core/agent/actor/types";
import { EXPLORE_AGENT_DEFINITION } from "./explore-agent";
import { IMPLEMENTATION_AGENT_DEFINITION } from "./implementation-agent";
import { PLAN_AGENT_DEFINITION } from "./plan-agent";
import { REVIEW_AGENT_DEFINITION } from "./review-agent";
import { SPREADSHEET_GENERATION_AGENT_DEFINITION } from "./spreadsheet-generation-agent";
import { VERIFICATION_AGENT_DEFINITION } from "./verification-agent";
import { GENERAL_PURPOSE_AGENT_DEFINITION } from "./general-purpose-agent";
import type { AppliedBuiltinAgentDefinition, BuiltinAgentDefinition, BuiltinAgentId } from "./types";

export type { AppliedBuiltinAgentDefinition, BuiltinAgentDefinition, BuiltinAgentId } from "./types";

const BUILTIN_AGENT_REGISTRY: Record<BuiltinAgentId, BuiltinAgentDefinition> = {
  general_purpose: GENERAL_PURPOSE_AGENT_DEFINITION,
  plan_agent: PLAN_AGENT_DEFINITION,
  verification_agent: VERIFICATION_AGENT_DEFINITION,
  explore_agent: EXPLORE_AGENT_DEFINITION,
  implementation_agent: IMPLEMENTATION_AGENT_DEFINITION,
  review_agent: REVIEW_AGENT_DEFINITION,
  spreadsheet_generation_agent: SPREADSHEET_GENERATION_AGENT_DEFINITION,
};

function dedupeNonEmptyStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function mergePromptAppend(
  builtinPromptAppend: string | undefined,
  overridePromptAppend: string | undefined,
): string | undefined {
  const blocks = dedupeNonEmptyStrings([builtinPromptAppend, overridePromptAppend]);
  if (blocks.length === 0) return undefined;
  return blocks.join("\n\n");
}

function mergeCapabilities(
  builtinCapabilities: AgentCapability[],
  requestedCapabilities?: AgentCapability[],
): AgentCapability[] {
  const merged = new Set<AgentCapability>(builtinCapabilities);
  for (const capability of requestedCapabilities ?? []) {
    merged.add(capability);
  }
  return [...merged];
}

export function listBuiltinAgentIds(): BuiltinAgentId[] {
  return Object.keys(BUILTIN_AGENT_REGISTRY) as BuiltinAgentId[];
}

export function resolveBuiltinAgentDefinition(raw?: string | null): BuiltinAgentDefinition | undefined {
  const normalized = String(raw ?? "").trim() as BuiltinAgentId;
  return BUILTIN_AGENT_REGISTRY[normalized];
}

export function applyBuiltinAgentDefaults(params: {
  builtinAgentId?: BuiltinAgentId;
  requestedTargetName?: string;
  requestedRoleBoundary?: SpawnedTaskRoleBoundary;
  requestedWorkerProfileId?: WorkerProfileId;
  requestedChildDescription?: string;
  requestedChildCapabilities?: AgentCapability[];
  overrides?: SpawnTaskOverrides;
}): AppliedBuiltinAgentDefinition {
  const definition = params.builtinAgentId
    ? BUILTIN_AGENT_REGISTRY[params.builtinAgentId]
    : undefined;
  const requestedOverrides = { ...(params.overrides ?? {}) };
  const requestedWorkerProfileId = params.requestedWorkerProfileId ?? requestedOverrides.workerProfileId;

  if (!definition) {
    return {
      targetName: params.requestedTargetName,
      roleBoundary: params.requestedRoleBoundary,
      workerProfileId: requestedWorkerProfileId,
      childDescription: params.requestedChildDescription,
      childCapabilities: params.requestedChildCapabilities,
      overrides: requestedOverrides,
      defaultAcceptance: [],
    };
  }

  const roleBoundary = params.requestedRoleBoundary ?? definition.roleBoundary;
  const workerProfileId = requestedWorkerProfileId ?? definition.workerProfileId;

  return {
    definition,
    targetName: params.requestedTargetName || definition.defaultTargetName,
    roleBoundary,
    workerProfileId,
    childDescription: params.requestedChildDescription || definition.description,
    childCapabilities: mergeCapabilities(definition.capabilities, params.requestedChildCapabilities),
    overrides: {
      ...requestedOverrides,
      ...(requestedOverrides.workerProfileId
        ? {}
        : workerProfileId
          ? { workerProfileId }
          : {}),
      ...(typeof requestedOverrides.maxIterations === "number"
        ? {}
        : typeof definition.maxIterations === "number"
          ? { maxIterations: definition.maxIterations }
          : {}),
      ...(requestedOverrides.thinkingLevel
        ? {}
        : definition.thinkingLevel
          ? { thinkingLevel: definition.thinkingLevel }
          : {}),
      ...(requestedOverrides.resultContract
        ? {}
        : definition.resultContract
          ? { resultContract: definition.resultContract }
          : {}),
      ...(definition.toolPolicy
        ? {
            toolPolicy: requestedOverrides.toolPolicy
              ? {
                  ...(definition.toolPolicy.allow || requestedOverrides.toolPolicy.allow
                    ? {
                        allow: dedupeNonEmptyStrings([
                          ...(definition.toolPolicy.allow ?? []),
                          ...(requestedOverrides.toolPolicy.allow ?? []),
                        ]),
                      }
                    : {}),
                  ...(definition.toolPolicy.deny || requestedOverrides.toolPolicy.deny
                    ? {
                        deny: dedupeNonEmptyStrings([
                          ...(definition.toolPolicy.deny ?? []),
                          ...(requestedOverrides.toolPolicy.deny ?? []),
                        ]),
                      }
                    : {}),
                }
              : definition.toolPolicy,
          }
        : requestedOverrides.toolPolicy
          ? { toolPolicy: requestedOverrides.toolPolicy }
          : {}),
      ...(mergePromptAppend(definition.systemPromptAppend, requestedOverrides.systemPromptAppend)
        ? {
            systemPromptAppend: mergePromptAppend(
              definition.systemPromptAppend,
              requestedOverrides.systemPromptAppend,
            ),
          }
        : {}),
    },
    defaultAcceptance: [...definition.defaultAcceptance],
  };
}
