import type { AIProductMode } from "@/core/ai/ai-mode-types";
import type { CollaborationSurface } from "@/core/collaboration/types";
import type {
  AccessMode,
  ApprovalMode,
  ExecutionPolicy,
  ToolPolicy,
} from "@/core/agent/actor/types";
import {
  clampAccessMode,
  clampApprovalMode,
  normalizeExecutionPolicy,
} from "@/core/agent/actor/execution-policy";

export interface SurfaceSecurityPolicy {
  surface: CollaborationSurface;
  productMode: AIProductMode;
  executionPolicy: {
    accessMode: AccessMode;
    approvalMode: ApprovalMode;
  };
  toolPolicy?: ToolPolicy;
  allowChildSpawn: boolean;
  allowAskUser: boolean;
}

export interface SessionMaintenancePolicy {
  pruneAfterDays: number;
  maxEntries: number;
  maxBytes?: number;
  archiveRetentionDays: number;
  rotateBytes?: number;
}

export interface CompactionLifecyclePolicy {
  preCompactionMemoryFlush: boolean;
  truncateVisibleTranscriptAfterCompaction: boolean;
  emitCleanupDiagnostics: boolean;
}

const READ_ONLY_CHANNEL_POLICY: ToolPolicy = {
  deny: ["ask_user", "ask_clarification"],
};

const SURFACE_SECURITY_DEFAULTS: Record<string, SurfaceSecurityPolicy> = {
  "local_dialog:dialog": {
    surface: "local_dialog",
    productMode: "dialog",
    executionPolicy: { accessMode: "auto", approvalMode: "permissive" },
    allowChildSpawn: true,
    allowAskUser: true,
  },
  "local_dialog:review": {
    surface: "local_dialog",
    productMode: "review",
    executionPolicy: { accessMode: "read_only", approvalMode: "strict" },
    toolPolicy: { deny: ["spawn_task"] },
    allowChildSpawn: false,
    allowAskUser: true,
  },
  "im_conversation:im_conversation": {
    surface: "im_conversation",
    productMode: "im_conversation",
    executionPolicy: { accessMode: "read_only", approvalMode: "normal" },
    toolPolicy: READ_ONLY_CHANNEL_POLICY,
    allowChildSpawn: false,
    allowAskUser: false,
  },
};

export const DEFAULT_SESSION_MAINTENANCE_POLICY: SessionMaintenancePolicy = {
  pruneAfterDays: 30,
  maxEntries: 500,
  archiveRetentionDays: 14,
  rotateBytes: 10 * 1024 * 1024,
};

export const DEFAULT_COMPACTION_LIFECYCLE_POLICY: CompactionLifecyclePolicy = {
  preCompactionMemoryFlush: true,
  truncateVisibleTranscriptAfterCompaction: true,
  emitCleanupDiagnostics: true,
};

function mergeToolPolicies(
  base?: ToolPolicy,
  override?: ToolPolicy,
): ToolPolicy | undefined {
  if (!base && !override) return undefined;
  const allow = [...new Set([...(base?.allow ?? []), ...(override?.allow ?? [])])];
  const deny = [...new Set([...(base?.deny ?? []), ...(override?.deny ?? [])])];
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
  };
}

export function getSurfaceSecurityPolicy(params: {
  surface: CollaborationSurface;
  productMode?: AIProductMode;
}): SurfaceSecurityPolicy {
  const productMode = params.productMode ?? (params.surface === "im_conversation" ? "im_conversation" : "dialog");
  const key = `${params.surface}:${productMode}`;
  const matched = SURFACE_SECURITY_DEFAULTS[key]
    ?? SURFACE_SECURITY_DEFAULTS[`${params.surface}:${params.surface === "im_conversation" ? "im_conversation" : "dialog"}`];
  return {
    ...matched,
    ...(matched.toolPolicy
      ? {
          toolPolicy: {
            ...(matched.toolPolicy.allow ? { allow: [...matched.toolPolicy.allow] } : {}),
            ...(matched.toolPolicy.deny ? { deny: [...matched.toolPolicy.deny] } : {}),
          },
        }
      : {}),
  };
}

export function resolveSurfaceExecutionPolicy(params: {
  surface: CollaborationSurface;
  productMode?: AIProductMode;
  basePolicy?: ExecutionPolicy | null;
  overridePolicy?: ExecutionPolicy | null;
}): ExecutionPolicy {
  const surfacePolicy = getSurfaceSecurityPolicy({
    surface: params.surface,
    productMode: params.productMode,
  });
  const base = normalizeExecutionPolicy(params.basePolicy);
  const override = normalizeExecutionPolicy(params.overridePolicy);
  return {
    accessMode: clampAccessMode(
      surfacePolicy.executionPolicy.accessMode,
      base.accessMode,
      override.accessMode,
    ),
    approvalMode: clampApprovalMode(
      surfacePolicy.executionPolicy.approvalMode,
      base.approvalMode,
      override.approvalMode,
    ),
  };
}

export function resolveSurfaceToolPolicy(params: {
  surface: CollaborationSurface;
  productMode?: AIProductMode;
  baseToolPolicy?: ToolPolicy;
  overrideToolPolicy?: ToolPolicy;
}): ToolPolicy | undefined {
  return mergeToolPolicies(
    mergeToolPolicies(
      getSurfaceSecurityPolicy({
        surface: params.surface,
        productMode: params.productMode,
      }).toolPolicy,
      params.baseToolPolicy,
    ),
    params.overrideToolPolicy,
  );
}
