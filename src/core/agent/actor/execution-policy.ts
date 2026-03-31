import type {
  AccessMode,
  ApprovalLevel,
  ApprovalMode,
  DialogExecutionMode,
  ExecutionPolicy,
  MiddlewareOverrides,
  SpawnedTaskRoleBoundary,
  ToolPolicy,
} from "./types";
import { resolveSurfaceExecutionPolicy } from "@/core/collaboration/surface-security-policy";

export interface NormalizedExecutionPolicy {
  accessMode: AccessMode;
  approvalMode: ApprovalMode;
}

export interface ExecutionPolicyProfile {
  executionPolicy: NormalizedExecutionPolicy;
  toolPolicy?: ToolPolicy;
  middlewareOverrides?: MiddlewareOverrides;
}

export interface ExecutionPolicyOption<TValue extends string> {
  value: TValue;
  label: string;
  description: string;
}

export type DefaultDialogActorPolicyKind = "lead" | "support" | "external_im";

export const DEFAULT_ACCESS_MODE: AccessMode = "auto";
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "normal";
export const DIALOG_PLAN_MODE_EXECUTION_POLICY: NormalizedExecutionPolicy = {
  accessMode: "read_only",
  approvalMode: "strict",
};
export const DIALOG_PLAN_MODE_TOOL_POLICY: ToolPolicy = {
  deny: [
    "spawn_task",
    "wait_for_spawned_tasks",
    "send_message",
    "agents",
    "send_local_media",
    "schedule_task",
    "cancel_schedule",
    "memory_save",
  ],
};

const ACCESS_MODE_PRIORITY: AccessMode[] = ["read_only", "auto", "full_access"];
const APPROVAL_MODE_PRIORITY: ApprovalMode[] = ["strict", "normal", "permissive", "off"];

export const ACCESS_MODE_OPTIONS: ExecutionPolicyOption<AccessMode>[] = [
  {
    value: "read_only",
    label: "只读",
    description: "只能读和检索，禁止写文件、执行命令和系统级修改",
  },
  {
    value: "auto",
    label: "工程内执行",
    description: "允许常规工程修改和验证，危险操作仍要走审批梯子",
  },
  {
    value: "full_access",
    label: "完全访问",
    description: "允许更宽的本地执行能力，仍受审批模式和工具策略约束",
  },
];

export const APPROVAL_MODE_OPTIONS: ExecutionPolicyOption<ApprovalMode>[] = [
  {
    value: "strict",
    label: "严格确认",
    description: "尽量升级到确认，适合高风险或审查型角色",
  },
  {
    value: "normal",
    label: "正常审核",
    description: "默认自动审核，高风险和不确定操作再请求确认",
  },
  {
    value: "permissive",
    label: "宽松审核",
    description: "常规工程操作尽量自动放行，只拦截明显危险行为",
  },
  {
    value: "off",
    label: "关闭审批",
    description: "跳过审批链，只有 access mode 和工具策略仍会拦截",
  },
];

const READ_ONLY_ACCESS_POLICY: ToolPolicy = {
  deny: [
    "write_file",
    "str_replace_edit",
    "json_edit",
    "delete_file",
    "run_shell_command",
    "persistent_shell",
    "native_*",
    "database_execute",
    "ssh_*",
  ],
};

const CHILD_COMMUNICATION_DENY = [
  "spawn_task",
  "delegate_task",
  "delegate_subtask",
  "wait_for_spawned_tasks",
  "send_message",
  "agents",
  "ask_user",
  "ask_clarification",
  "send_local_media",
  "enter_plan_mode",
  "exit_plan_mode",
  "memory_*",
] as const;

const REVIEWER_CHILD_ALLOW = [
  "task_done",
  "list_*",
  "read_*",
  "search_*",
  "web_search",
  "calculate",
] as const;

const VALIDATOR_CHILD_ALLOW = [
  ...REVIEWER_CHILD_ALLOW,
  "run_shell_command",
  "persistent_shell",
] as const;

const EXECUTOR_CHILD_ALLOW = [
  ...VALIDATOR_CHILD_ALLOW,
  "write_file",
  "str_replace_edit",
  "json_edit",
  "export_document",
  "export_spreadsheet",
] as const;

const GENERAL_CHILD_ALLOW = [...REVIEWER_CHILD_ALLOW] as const;

const REVIEWER_CHILD_POLICY: ToolPolicy = {
  allow: [...REVIEWER_CHILD_ALLOW],
  deny: [
    ...CHILD_COMMUNICATION_DENY,
    ...(READ_ONLY_ACCESS_POLICY.deny ?? []),
  ],
};

const VALIDATOR_CHILD_POLICY: ToolPolicy = {
  allow: [...VALIDATOR_CHILD_ALLOW],
  deny: [
    ...CHILD_COMMUNICATION_DENY,
    "write_file",
    "str_replace_edit",
    "json_edit",
    "delete_file",
    "native_*",
    "database_execute",
    "ssh_*",
  ],
};

const EXECUTOR_CHILD_POLICY: ToolPolicy = {
  allow: [...EXECUTOR_CHILD_ALLOW],
  deny: [
    ...CHILD_COMMUNICATION_DENY,
    "delete_file",
    "native_*",
    "ssh_*",
  ],
};

const GENERAL_CHILD_POLICY: ToolPolicy = {
  allow: [...GENERAL_CHILD_ALLOW],
  deny: [...(REVIEWER_CHILD_POLICY.deny ?? [])],
};

const ROLE_BOUNDARY_POLICY_PROFILES: Record<SpawnedTaskRoleBoundary, ExecutionPolicyProfile> = {
  reviewer: {
    executionPolicy: { accessMode: "read_only", approvalMode: "strict" },
    toolPolicy: REVIEWER_CHILD_POLICY,
  },
  validator: {
    executionPolicy: { accessMode: "auto", approvalMode: "normal" },
    toolPolicy: VALIDATOR_CHILD_POLICY,
  },
  executor: {
    executionPolicy: { accessMode: "full_access", approvalMode: "permissive" },
    toolPolicy: EXECUTOR_CHILD_POLICY,
  },
  general: {
    executionPolicy: { accessMode: "read_only", approvalMode: "strict" },
    toolPolicy: GENERAL_CHILD_POLICY,
  },
};

const DEFAULT_DIALOG_ACTOR_POLICY_PROFILES: Record<DefaultDialogActorPolicyKind, ExecutionPolicyProfile> = {
  lead: {
    executionPolicy: { accessMode: "auto", approvalMode: "permissive" },
  },
  support: {
    executionPolicy: { accessMode: "auto", approvalMode: "normal" },
  },
  external_im: {
    executionPolicy: { accessMode: "read_only", approvalMode: "off" },
    toolPolicy: { deny: ["ask_user", "ask_clarification"] },
    middlewareOverrides: { disable: ["Clarification"] },
  },
};

function accessModeRank(mode: AccessMode): number {
  const index = ACCESS_MODE_PRIORITY.indexOf(mode);
  return index >= 0 ? index : ACCESS_MODE_PRIORITY.indexOf(DEFAULT_ACCESS_MODE);
}

function approvalModeRank(mode: ApprovalMode): number {
  const index = APPROVAL_MODE_PRIORITY.indexOf(mode);
  return index >= 0 ? index : APPROVAL_MODE_PRIORITY.indexOf(DEFAULT_APPROVAL_MODE);
}

export function clampAccessMode(
  ...modes: Array<AccessMode | undefined>
): AccessMode {
  const normalized = modes.filter((mode): mode is AccessMode => Boolean(mode));
  if (normalized.length === 0) return DEFAULT_ACCESS_MODE;
  return normalized.reduce((mostRestrictive, current) => (
    accessModeRank(current) < accessModeRank(mostRestrictive) ? current : mostRestrictive
  ));
}

export function clampApprovalMode(
  ...modes: Array<ApprovalMode | undefined>
): ApprovalMode {
  const normalized = modes.filter((mode): mode is ApprovalMode => Boolean(mode));
  if (normalized.length === 0) return DEFAULT_APPROVAL_MODE;
  return normalized.reduce((mostRestrictive, current) => (
    approvalModeRank(current) < approvalModeRank(mostRestrictive) ? current : mostRestrictive
  ));
}

export function getAccessModeLabel(mode?: AccessMode | null): string {
  return ACCESS_MODE_OPTIONS.find((item) => item.value === (mode ?? DEFAULT_ACCESS_MODE))?.label ?? "工程内执行";
}

export function getApprovalModeLabel(mode?: ApprovalMode | ApprovalLevel | null): string {
  return APPROVAL_MODE_OPTIONS.find((item) => item.value === (mode ?? DEFAULT_APPROVAL_MODE))?.label ?? "正常审核";
}

export function getDialogExecutionModeLabel(mode?: DialogExecutionMode | null): string {
  return mode === "plan" ? "规划模式" : "执行模式";
}

export function normalizeExecutionPolicy(
  policy?: ExecutionPolicy | null,
  legacy?: { approvalLevel?: ApprovalLevel | null; accessMode?: AccessMode | null },
): NormalizedExecutionPolicy {
  return {
    accessMode: policy?.accessMode ?? legacy?.accessMode ?? DEFAULT_ACCESS_MODE,
    approvalMode: policy?.approvalMode ?? legacy?.approvalLevel ?? DEFAULT_APPROVAL_MODE,
  };
}

export function normalizeExecutionPolicyWithMiddlewareCompat(
  policy?: ExecutionPolicy | null,
  middlewareOverrides?: MiddlewareOverrides | null,
  legacy?: { accessMode?: AccessMode | null },
): NormalizedExecutionPolicy {
  return normalizeExecutionPolicy(policy, {
    accessMode: legacy?.accessMode,
    approvalLevel: middlewareOverrides?.approvalLevel,
  });
}

export function compactMiddlewareOverridesForPersistence(
  middlewareOverrides?: MiddlewareOverrides | null,
): MiddlewareOverrides | undefined {
  const disable = [...new Set(
    (middlewareOverrides?.disable ?? [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  )];
  return disable.length > 0 ? { disable } : undefined;
}

export function synchronizeExecutionPolicyCompat(params: {
  executionPolicy?: ExecutionPolicy | null;
  middlewareOverrides?: MiddlewareOverrides | null;
}): {
  executionPolicy: NormalizedExecutionPolicy | undefined;
  middlewareOverrides: MiddlewareOverrides | undefined;
} {
  const hasPolicySignal = Boolean(
    params.executionPolicy?.accessMode
    || params.executionPolicy?.approvalMode
    || params.middlewareOverrides?.approvalLevel,
  );
  const executionPolicy = hasPolicySignal
    ? normalizeExecutionPolicyWithMiddlewareCompat(
        params.executionPolicy,
        params.middlewareOverrides,
      )
    : undefined;
  const compactedBase = compactMiddlewareOverridesForPersistence(params.middlewareOverrides);
  const middlewareOverrides = executionPolicy
    ? buildMiddlewareOverridesForExecutionPolicy(executionPolicy, compactedBase)
    : compactedBase;

  return {
    executionPolicy: executionPolicy ? { ...executionPolicy } : undefined,
    middlewareOverrides,
  };
}

export function resolveExecutionPolicyInheritance(params: {
  parentPolicy?: ExecutionPolicy | null;
  boundaryPolicy?: ExecutionPolicy | null;
  overridePolicy?: ExecutionPolicy | null;
  parentApprovalLevel?: ApprovalLevel | null;
  overrideApprovalLevel?: ApprovalLevel | null;
}): NormalizedExecutionPolicy {
  const parent = normalizeExecutionPolicy(params.parentPolicy, {
    approvalLevel: params.parentApprovalLevel,
  });
  return {
    accessMode: clampAccessMode(
      parent.accessMode,
      params.boundaryPolicy?.accessMode,
      params.overridePolicy?.accessMode,
    ),
    approvalMode: clampApprovalMode(
      parent.approvalMode,
      params.boundaryPolicy?.approvalMode,
      params.overridePolicy?.approvalMode ?? params.overrideApprovalLevel ?? undefined,
    ),
  };
}

export function summarizeExecutionPolicy(
  policy?: ExecutionPolicy | NormalizedExecutionPolicy | null,
  legacy?: { approvalLevel?: ApprovalLevel | null; accessMode?: AccessMode | null },
): string {
  const normalized = normalizeExecutionPolicy(policy, legacy);
  return `访问 ${getAccessModeLabel(normalized.accessMode)} · 审批 ${getApprovalModeLabel(normalized.approvalMode)}`;
}

export function deriveToolPolicyForAccessMode(
  accessMode?: AccessMode,
): ToolPolicy | undefined {
  switch (accessMode ?? DEFAULT_ACCESS_MODE) {
    case "read_only":
      return {
        deny: [...(READ_ONLY_ACCESS_POLICY.deny ?? [])],
      };
    default:
      return undefined;
  }
}

export function buildMiddlewareOverridesForExecutionPolicy(
  executionPolicy?: ExecutionPolicy | NormalizedExecutionPolicy | null,
  base?: MiddlewareOverrides,
): MiddlewareOverrides {
  const normalized = normalizeExecutionPolicy(executionPolicy);
  const disable = [...new Set([...(base?.disable ?? [])])];
  return {
    ...(disable.length > 0 ? { disable } : {}),
    approvalLevel: normalized.approvalMode,
  };
}

export function deriveIMConversationExecutionPolicy(
  coordinatorPolicy?: ExecutionPolicy | null,
): NormalizedExecutionPolicy {
  return normalizeExecutionPolicy(
    resolveSurfaceExecutionPolicy({
      surface: "im_conversation",
      productMode: "im_conversation",
      basePolicy: coordinatorPolicy,
    }),
  );
}

export function getRoleBoundaryPolicyProfile(
  boundary: SpawnedTaskRoleBoundary = "general",
): ExecutionPolicyProfile {
  const profile = ROLE_BOUNDARY_POLICY_PROFILES[boundary] ?? ROLE_BOUNDARY_POLICY_PROFILES.general;
  const middlewareOverrides = buildMiddlewareOverridesForExecutionPolicy(
    profile.executionPolicy,
    compactMiddlewareOverridesForPersistence(profile.middlewareOverrides),
  );
  return {
    executionPolicy: { ...profile.executionPolicy },
    ...(profile.toolPolicy
      ? {
          toolPolicy: {
            ...(profile.toolPolicy.allow ? { allow: [...profile.toolPolicy.allow] } : {}),
            ...(profile.toolPolicy.deny ? { deny: [...profile.toolPolicy.deny] } : {}),
          },
        }
      : {}),
    ...(middlewareOverrides
      ? {
          middlewareOverrides: {
            ...middlewareOverrides,
            ...(middlewareOverrides.disable
              ? { disable: [...middlewareOverrides.disable] }
              : {}),
          },
        }
      : {}),
  };
}

export function getDefaultDialogActorPolicyProfile(
  kind: DefaultDialogActorPolicyKind,
): ExecutionPolicyProfile {
  const profile = DEFAULT_DIALOG_ACTOR_POLICY_PROFILES[kind] ?? DEFAULT_DIALOG_ACTOR_POLICY_PROFILES.support;
  const middlewareOverrides = buildMiddlewareOverridesForExecutionPolicy(
    profile.executionPolicy,
    compactMiddlewareOverridesForPersistence(profile.middlewareOverrides),
  );
  return {
    executionPolicy: { ...profile.executionPolicy },
    ...(profile.toolPolicy
      ? {
          toolPolicy: {
            ...(profile.toolPolicy.allow ? { allow: [...profile.toolPolicy.allow] } : {}),
            ...(profile.toolPolicy.deny ? { deny: [...profile.toolPolicy.deny] } : {}),
          },
        }
      : {}),
    ...(middlewareOverrides
      ? {
          middlewareOverrides: {
            ...middlewareOverrides,
            ...(middlewareOverrides.disable
              ? { disable: [...middlewareOverrides.disable] }
              : {}),
          },
        }
      : {}),
  };
}
