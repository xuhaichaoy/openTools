import type { DialogStructuredSubtaskResult } from "./dialog-subtask-runtime";
import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import type {
  SpawnTaskOverrides,
  SpawnedTaskRoleBoundary,
} from "./types";
import { dynamicSpreadsheetStrategy } from "./dynamic-spreadsheet-strategy";
import type { SourceGroundingSnapshot } from "./source-grounding";

export type StructuredDeliveryContract = "general" | "spreadsheet" | "structured_content";
export type StructuredDeliveryManifestSource = "heuristic" | "strategy" | "planner" | "runtime";

export interface StructuredDeliveryTarget {
  id: string;
  label: string;
  description?: string;
  promptSpec?: StructuredDeliveryPromptSpec;
  dispatchSpec?: StructuredDeliveryTargetDispatchSpec;
  metadata?: Record<string, unknown>;
}

export interface StructuredDeliveryPromptSpec {
  objective: string;
  inputItemsLabel?: string;
  inputItems?: string[];
  truthScopeNote?: string;
  constraints?: string[];
  completionInstructions?: string[];
  outputExample?: unknown;
}

export interface StructuredDeliveryTargetDispatchSpec {
  label?: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
  createIfMissing?: boolean;
  overrides?: SpawnTaskOverrides;
}

export interface StructuredDeliveryResultSchemaField {
  key: string;
  label: string;
  required?: boolean;
  description?: string;
}

export interface StructuredDeliveryResultSchema {
  id: string;
  kind: "table_rows" | "json_object" | "inline_text";
  fields: StructuredDeliveryResultSchemaField[];
}

export interface StructuredDeliveryExportSpec {
  mode: "single_workbook" | "single_file" | "inline_only";
  format: "spreadsheet" | "document" | "text";
  targetLabels?: string[];
}

export interface StructuredDeliveryDispatchShard {
  plannedDelegationId?: string;
  targetActorId?: string;
  targetActorName?: string;
  label: string;
  task: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
  createIfMissing?: boolean;
  overrides?: SpawnTaskOverrides;
}

export interface StructuredDeliveryDispatchPlan {
  strategyId: string;
  deliveryContract: StructuredDeliveryContract;
  parentContract: string;
  tracePreview?: string;
  observationText?: string;
  shards: StructuredDeliveryDispatchShard[];
}

export interface StructuredDeliveryHostExportPlan {
  strategyId: string;
  deliveryContract: StructuredDeliveryContract;
  parentContract: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  expectedArtifactExtensions: string[];
  tracePreview?: string;
  targetPreview?: string;
  operationCount?: number;
  successReply: string;
}

export interface StructuredDeliveryRepairSuggestion {
  label: string;
  reason: string;
  sourceItemIds?: string[];
  missingThemes?: string[];
  task?: string;
  roleBoundary?: SpawnedTaskRoleBoundary;
  createIfMissing?: boolean;
  overrides?: SpawnTaskOverrides;
}

export interface StructuredDeliveryRepairPlan {
  summary: string;
  nextStepHint?: string;
  missingSourceItemIds?: string[];
  missingThemes?: string[];
  suggestions: StructuredDeliveryRepairSuggestion[];
}

export interface StructuredDeliveryHostExportBlocker {
  blocker: string;
  repairPlan?: StructuredDeliveryRepairPlan;
}

export interface StructuredDeliveryStrategy {
  id: string;
  deliveryContract: StructuredDeliveryContract;
  parentContract: string;
  matches(taskText: string): boolean;
  buildManifest?(taskText: string): Omit<StructuredDeliveryManifest, "strategy" | "source"> | null;
  buildInitialDispatchPlan?(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
  }): StructuredDeliveryDispatchPlan | null;
  buildDeliveryPlanBlock?(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
    structuredResults: readonly DialogStructuredSubtaskResult[];
  }): string | undefined;
  buildHostExportPlan?(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
    structuredResults: readonly DialogStructuredSubtaskResult[];
  }): StructuredDeliveryHostExportPlan | StructuredDeliveryHostExportBlocker | null;
}

export interface StructuredDeliveryManifest {
  source: StructuredDeliveryManifestSource;
  strategyId?: string;
  recommendedStrategyId?: string;
  adapterEnabled?: boolean;
  deliveryContract: StructuredDeliveryContract;
  parentContract: string;
  requiresSpreadsheetOutput: boolean;
  applyInitialIsolation: boolean;
  sourceSnapshot?: SourceGroundingSnapshot;
  targets?: StructuredDeliveryTarget[];
  resultSchema?: StructuredDeliveryResultSchema;
  exportSpec?: StructuredDeliveryExportSpec;
  tracePreview?: string;
}

const SPREADSHEET_OUTPUT_TASK_PATTERNS = [
  /(?:最终|最后|输出|导出|保存|生成|给我|给出|返回).{0,18}(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿)?/iu,
  /(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿).{0,12}(?:输出|导出|保存|生成|给我|给出|返回|最终|最后)/iu,
] as const;

const STRUCTURED_CONTENT_TASK_PATTERNS = [
  /(?:字段|列|schema|结构化|表头|headers?)/iu,
  /(?:清单|列表|汇总|条目|记录|结果表|结果集|摘要表)/u,
  /(?:根据|基于).*(?:附件|文档|表格|工作簿|数据|条目).*(?:生成|整理|汇总|输出|填充)/iu,
] as const;

const STRONG_CODING_TASK_PATTERNS = [
  /repo|repository|codebase|仓库|项目结构|工程|源码/i,
  /代码|编码|编程|函数|类|模块|接口|重构|修复|debug|bug|报错/i,
  /\/[^\s"'`]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|vue|html|css|scss|less)\b/i,
] as const;

const STRUCTURED_DELIVERY_STRATEGIES: StructuredDeliveryStrategy[] = [
  dynamicSpreadsheetStrategy,
];

export function getStructuredDeliveryStrategies(): readonly StructuredDeliveryStrategy[] {
  return STRUCTURED_DELIVERY_STRATEGIES;
}

export function resolveStructuredDeliveryStrategy(
  taskText: string | null | undefined,
): StructuredDeliveryStrategy | null {
  const normalized = String(taskText ?? "").trim();
  if (!normalized) return null;
  return STRUCTURED_DELIVERY_STRATEGIES.find((strategy) => strategy.matches(normalized)) ?? null;
}

export function resolveStructuredDeliveryStrategyById(
  strategyId: string | null | undefined,
): StructuredDeliveryStrategy | null {
  const normalized = String(strategyId ?? "").trim();
  if (!normalized) return null;
  return STRUCTURED_DELIVERY_STRATEGIES.find((strategy) => strategy.id === normalized) ?? null;
}

export function taskRequestsSpreadsheetOutput(task: string | null | undefined): boolean {
  const normalized = String(task ?? "").trim();
  if (!normalized) return false;
  return SPREADSHEET_OUTPUT_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function taskLooksLikeStructuredContentTask(task: string | null | undefined): boolean {
  const normalized = String(task ?? "").trim();
  if (!normalized) return false;
  return STRUCTURED_CONTENT_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function taskLooksLikeStructuredSpreadsheetDelivery(task: string | null | undefined): boolean {
  const normalized = String(task ?? "").trim();
  if (!normalized) return false;
  if (!taskRequestsSpreadsheetOutput(normalized)) return false;
  if (taskLooksLikeStructuredContentTask(normalized)) return true;
  const strongCoding = STRONG_CODING_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
  if (strongCoding) return false;
  const inferred = inferCodingExecutionProfile({ query: normalized });
  return !inferred.profile.codingMode;
}

export function resolveRequestedSpreadsheetExtensions(task: string | null | undefined): string[] {
  const normalized = String(task ?? "").trim();
  if (!normalized) return ["xlsx", "xls", "csv"];
  if (/(?:excel|xlsx|xls)/iu.test(normalized)) return ["xlsx", "xls"];
  if (/(?:csv)/iu.test(normalized)) return ["csv"];
  return ["xlsx", "xls", "csv"];
}

function buildDefaultStructuredExample(
  schema: StructuredDeliveryResultSchema | undefined,
): unknown {
  if (!schema?.fields?.length) {
    return [{ result: "示例结果" }];
  }
  const exampleRecord = Object.fromEntries(
    schema.fields.map((field) => [field.label, `示例${field.label}`]),
  );
  switch (schema.kind) {
    case "json_object":
      return exampleRecord;
    case "inline_text":
      return Object.values(exampleRecord).join("，");
    case "table_rows":
    default:
      return [exampleRecord];
  }
}

function mergeSpawnTaskOverrides(
  ...overrides: Array<SpawnTaskOverrides | undefined>
): SpawnTaskOverrides | undefined {
  const merged = overrides.reduce<SpawnTaskOverrides>((acc, current) => ({
    ...acc,
    ...(current ?? {}),
  }), {});
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function buildInlineStructuredResultPrompt(params: {
  target: StructuredDeliveryTarget;
  manifest: StructuredDeliveryManifest;
}): string {
  const promptSpec = params.target.promptSpec;
  if (!promptSpec) return "";
  const lines = [
    "## 任务目标",
    promptSpec.objective,
    "",
    "## 输出要求",
    "- 你是内容型 executor，只返回结构化结果，不要导出文件，不要写文件。",
    `- 当前结果合同已锁定为 inline_structured_result，直接通过 \`task_done\` 返回完整结构化结果。`,
    promptSpec.truthScopeNote
      ? `- ${promptSpec.truthScopeNote}`
      : "- 只使用当前任务给定的输入真相，不要自行扫描历史目录、旧文件或外部资料。",
  ];
  if (params.manifest.resultSchema?.fields?.length) {
    const fieldLabels = params.manifest.resultSchema.fields.map((field) => `\`${field.label}\``).join("、");
    lines.push(`- 输出需满足结构化字段：${fieldLabels}。`);
  }
  for (const constraint of promptSpec.constraints ?? []) {
    lines.push(`- ${constraint}`);
  }
  const completionInstructions = promptSpec.completionInstructions ?? [
    "完成后直接调用 `task_done`。",
    "`summary` 只写一句短摘要，完整结构化结果放进 `result` 字段。",
    "不要发送中间消息，不要输出额外解释性正文。",
  ];
  for (const instruction of completionInstructions) {
    lines.push(`- ${instruction}`);
  }
  if (promptSpec.inputItems?.length) {
    lines.push("", `## ${promptSpec.inputItemsLabel ?? "输入材料"}`, ...promptSpec.inputItems);
  }
  lines.push("", "## 输出格式", "```json");
  lines.push(JSON.stringify(
    promptSpec.outputExample ?? buildDefaultStructuredExample(params.manifest.resultSchema),
    null,
    2,
  ));
  lines.push("```");
  return lines.join("\n");
}

export function buildInlineStructuredDispatchPlanFromManifest(params: {
  strategyId: string;
  manifest: StructuredDeliveryManifest;
  tracePreview?: string;
  observationText?: string;
  defaultRoleBoundary?: SpawnedTaskRoleBoundary;
  defaultCreateIfMissing?: boolean;
  defaultOverrides?: SpawnTaskOverrides;
}): StructuredDeliveryDispatchPlan | null {
  const targets = params.manifest.targets ?? [];
  if (targets.length === 0) return null;
  const shards = targets.reduce<StructuredDeliveryDispatchShard[]>((acc, target) => {
    const task = buildInlineStructuredResultPrompt({
      target,
      manifest: params.manifest,
    });
    if (!task) return acc;
    const overrides = mergeSpawnTaskOverrides(
      params.defaultOverrides,
      target.dispatchSpec?.overrides,
      {
        deliveryTargetId: target.dispatchSpec?.overrides?.deliveryTargetId ?? target.id,
        deliveryTargetLabel: target.dispatchSpec?.overrides?.deliveryTargetLabel ?? target.label,
      },
    );
    acc.push({
      label: target.dispatchSpec?.label ?? target.label,
      task,
      roleBoundary: target.dispatchSpec?.roleBoundary ?? params.defaultRoleBoundary,
      createIfMissing: target.dispatchSpec?.createIfMissing ?? params.defaultCreateIfMissing,
      overrides,
    });
    return acc;
  }, []);
  if (shards.length === 0) return null;
  return {
    strategyId: params.strategyId,
    deliveryContract: params.manifest.deliveryContract,
    parentContract: params.manifest.parentContract,
    tracePreview: params.tracePreview ?? params.manifest.tracePreview,
    observationText: params.observationText,
    shards,
  };
}

export function resolveStructuredDeliveryManifest(
  taskText: string | null | undefined,
): StructuredDeliveryManifest {
  const strategy = resolveStructuredDeliveryStrategy(taskText);
  const requiresSpreadsheetOutput = taskRequestsSpreadsheetOutput(taskText);
  const applyInitialIsolation = false;

  if (strategy) {
    const strategyManifest = strategy.buildManifest?.(String(taskText ?? "").trim()) ?? null;
    return {
      source: "strategy",
      strategyId: strategyManifest?.adapterEnabled ? (strategyManifest?.strategyId ?? strategy.id) : undefined,
      recommendedStrategyId: strategyManifest?.recommendedStrategyId ?? strategyManifest?.strategyId ?? strategy.id,
      adapterEnabled: strategyManifest?.adapterEnabled ?? false,
      deliveryContract: strategyManifest?.deliveryContract ?? strategy.deliveryContract,
      parentContract: strategyManifest?.parentContract ?? strategy.parentContract,
      requiresSpreadsheetOutput,
      applyInitialIsolation: strategyManifest?.applyInitialIsolation ?? applyInitialIsolation,
      sourceSnapshot: strategyManifest?.sourceSnapshot,
      targets: strategyManifest?.targets,
      resultSchema: strategyManifest?.resultSchema,
      exportSpec: strategyManifest?.exportSpec,
      tracePreview: strategyManifest?.tracePreview,
    };
  }

  return {
    source: "heuristic",
    strategyId: undefined,
    recommendedStrategyId: undefined,
    adapterEnabled: false,
    deliveryContract: requiresSpreadsheetOutput
      ? "spreadsheet"
      : applyInitialIsolation
        ? "structured_content"
        : "general",
    parentContract: requiresSpreadsheetOutput
      ? "single_workbook"
      : applyInitialIsolation
        ? "structured_content"
        : "general",
    requiresSpreadsheetOutput,
    applyInitialIsolation,
    sourceSnapshot: undefined,
    targets: undefined,
    resultSchema: undefined,
    exportSpec: requiresSpreadsheetOutput
      ? {
          mode: "single_file",
          format: "spreadsheet",
        }
      : undefined,
    tracePreview: undefined,
  };
}

export function isStructuredDeliveryAdapterEnabled(
  manifest: StructuredDeliveryManifest | null | undefined,
): boolean {
  if (!manifest) return false;
  if (manifest.adapterEnabled === true) return true;
  return manifest.source === "planner";
}

export function enableStructuredDeliveryAdapter(
  manifest: StructuredDeliveryManifest,
  source: StructuredDeliveryManifestSource = manifest.source,
): StructuredDeliveryManifest {
  const strategyId = manifest.strategyId ?? manifest.recommendedStrategyId;
  return {
    ...manifest,
    source,
    strategyId,
    adapterEnabled: true,
  };
}

export function getStructuredDeliveryStrategyReferenceId(
  manifest: StructuredDeliveryManifest | null | undefined,
): string | undefined {
  if (!manifest) return undefined;
  return manifest.strategyId ?? manifest.recommendedStrategyId;
}
