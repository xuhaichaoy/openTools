import {
  buildDynamicWorkbook,
  buildDynamicWorkbookReply,
} from "./dynamic-workbook-builder";
import { analyzeStructuredSpreadsheetQuality } from "./delivery-quality-gate";
import { buildSourceGroundingSnapshot, inferRequestedOutputSchema } from "./source-grounding";
import type {
  StructuredDeliveryHostExportBlocker,
  StructuredDeliveryStrategy,
  StructuredDeliveryDispatchPlan,
  StructuredDeliveryHostExportPlan,
  StructuredDeliveryManifest,
  StructuredDeliveryPromptSpec,
  StructuredDeliveryRepairPlan,
  StructuredDeliveryRepairSuggestion,
  StructuredDeliveryTarget,
} from "./structured-delivery-strategy";
import {
  buildInlineStructuredDispatchPlanFromManifest,
} from "./structured-delivery-strategy";
import type { ScopedSourceItem } from "./types";
import { buildWorkerProfileOverrides } from "./worker-profiles";

const DYNAMIC_SPREADSHEET_STRATEGY_ID = "dynamic_spreadsheet";
const DEFAULT_SHEET_LABEL = "结果清单";
const MAX_ITEMS_PER_SHARD = 8;
const SPREADSHEET_OUTPUT_PATTERNS = [
  /(?:最终|最后|输出|导出|保存|生成|给我|给出|返回).{0,18}(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿)?/iu,
  /(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿).{0,12}(?:输出|导出|保存|生成|给我|给出|返回|最终|最后)/iu,
] as const;
const STRONG_CODING_TASK_PATTERNS = [
  /repo|repository|codebase|仓库|项目结构|工程|源码/i,
  /代码|编码|编程|函数|类|模块|接口|重构|修复|debug|bug|报错/i,
  /\/[^\s"'`]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|vue|html|css|scss|less)\b/i,
] as const;
const GENERIC_STRUCTURED_CONTENT_PATTERNS = [
  /(?:字段|列|schema|结构化|表头|headers?)/iu,
  /(?:清单|列表|汇总|条目|记录|结果表|结果集|摘要表)/u,
  /(?:根据|基于).*(?:附件|文档|表格|工作簿|数据|条目).*(?:生成|整理|汇总|输出|填充)/iu,
] as const;

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
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

function taskRequestsSpreadsheetOutput(taskText: string): boolean {
  const normalized = String(taskText ?? "").trim();
  return normalized.length > 0 && SPREADSHEET_OUTPUT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function taskLooksLikeStructuredSpreadsheetDelivery(taskText: string): boolean {
  const normalized = String(taskText ?? "").trim();
  if (!taskRequestsSpreadsheetOutput(normalized)) return false;
  if (GENERIC_STRUCTURED_CONTENT_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  return !STRONG_CODING_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildScopedSourceItems(
  items: ReturnType<typeof buildSourceGroundingSnapshot>["items"],
): ScopedSourceItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    raw: item.raw,
    order: item.order,
    sourcePath: item.sourcePath,
    sectionLabel: item.sectionLabel,
    topicIndex: item.topicIndex,
    topicTitle: item.topicTitle,
    themeGroup: item.themeGroup,
    trainingTarget: item.trainingTarget,
    trainingAudience: item.trainingAudience,
    outline: item.outline,
  }));
}

function buildDynamicPromptSpec(params: {
  taskText: string;
  sheetLabel: string;
  inputItems: ReturnType<typeof buildSourceGroundingSnapshot>["items"];
  resultFields: string[];
}): StructuredDeliveryPromptSpec {
  const firstItem = params.inputItems[0];
  const outputExample = firstItem
    ? [{
        sourceItemId: firstItem.id,
        topicIndex: firstItem.topicIndex ?? firstItem.order,
        topicTitle: firstItem.topicTitle ?? firstItem.label,
        coverageType: "direct",
        ...Object.fromEntries(
          params.resultFields.map((field) => [field, `示例${field}`]),
        ),
      }]
    : undefined;
  return {
    objective: `请基于以下输入条目，为「${params.sheetLabel}」整理最终表格所需的结构化结果。`,
    inputItemsLabel: `本组输入（${params.inputItems.length} 项）`,
    inputItems: params.inputItems.map((item, itemIndex) => [
      `- sourceItemId: ${item.id}`,
      `- topicIndex: ${item.topicIndex ?? item.order ?? itemIndex + 1}`,
      `- topicTitle: ${item.topicTitle ?? item.label}`,
      item.trainingTarget ? `- trainingTarget: ${item.trainingTarget}` : "",
      item.trainingAudience ? `- trainingAudience: ${item.trainingAudience}` : "",
      item.outline ? `- outline: ${item.outline}` : "",
      item.themeGroup ? `- themeGroup: ${item.themeGroup}` : "",
    ].filter(Boolean).join("\n")),
    truthScopeNote: "这些条目来自当前源文件快照，是你本组任务的唯一真相；不要自行扫描历史目录或补充未给出的源数据。",
    constraints: [
      "优先保证覆盖率：本组每个输入条目至少对应 1 行结果；若无法覆盖，请在结果里给出 blocker。",
      "每一行结果必须且只能绑定 1 个 `sourceItemId`，并显式包含 `topicIndex`、`topicTitle`、`coverageType`。",
      "如果同一个主题需要扩展成多门课程，可以返回多行，但这些行都必须复用同一个 `sourceItemId`；不要用一行跨多个主题做泛化覆盖。",
      "除覆盖元数据外，还必须包含用户要求的业务字段。",
      "不要写文件、不要导出表格、不要再次派工，只返回结构化 JSON 结果。",
      "若结果需要分多列，请直接返回对象数组；若只需要单列，也统一返回对象数组。",
    ],
    completionInstructions: [
      "完成后直接调用 `task_done`。",
      "`summary` 里写清已处理条目数、已产出行数，以及是否存在 blocker。",
      "完整结构化结果放进 `result` 字段；如果有 blocker，可返回 `{ \"rows\": [...], \"blocker\": \"...\" }` 这类对象。",
    ],
    outputExample,
  };
}

function buildDynamicTargets(taskText: string): StructuredDeliveryTarget[] {
  const snapshot = buildSourceGroundingSnapshot(taskText);
  if (snapshot.items.length === 0) return [];
  const resultFields = inferRequestedOutputSchema(taskText)?.fields?.map((field) => field.label)
    ?? ["课程名称", "课程介绍"];

  const grouped = new Map<string, typeof snapshot.items>();
  for (const item of snapshot.items) {
    const label = item.sectionLabel || DEFAULT_SHEET_LABEL;
    const group = grouped.get(label) ?? [];
    group.push(item);
    grouped.set(label, group);
  }

  const targets: StructuredDeliveryTarget[] = [];
  for (const [sheetLabel, items] of grouped.entries()) {
    for (let index = 0; index < items.length; index += MAX_ITEMS_PER_SHARD) {
      const chunk = items.slice(index, index + MAX_ITEMS_PER_SHARD);
      const batchIndex = Math.floor(index / MAX_ITEMS_PER_SHARD) + 1;
      const chunkLabel = items.length > MAX_ITEMS_PER_SHARD
        ? `${sheetLabel}生成（第${batchIndex}组）`
        : `${sheetLabel}生成`;
      const chunkId = `${sheetLabel.replace(/\s+/g, "-") || "sheet"}-batch-${batchIndex}`;
      targets.push({
        id: chunkId,
        label: sheetLabel,
        description: `${sheetLabel} 的结构化输出分片`,
        promptSpec: buildDynamicPromptSpec({
          taskText,
          sheetLabel,
          inputItems: chunk,
          resultFields,
        }),
        dispatchSpec: {
          label: chunkLabel,
          roleBoundary: "executor",
          createIfMissing: true,
          overrides: {
            ...buildWorkerProfileOverrides("spreadsheet_worker"),
            deliveryTargetId: chunkId,
            deliveryTargetLabel: sheetLabel,
            sheetName: sheetLabel,
            sourceItemIds: chunk.map((item) => item.id),
            sourceItemCount: chunk.length,
            scopedSourceItems: buildScopedSourceItems(chunk),
          },
        },
        metadata: {
          sourceItemCount: chunk.length,
          sourceItemIds: chunk.map((item) => item.id),
          sectionLabel: sheetLabel,
          sourcePaths: uniqueNonEmpty(chunk.map((item) => item.sourcePath)),
        },
      });
    }
  }
  return targets;
}

function buildDynamicRepairPlan(params: {
  taskText: string;
  manifest: StructuredDeliveryManifest;
  blocker: string;
  missingSourceItems: NonNullable<StructuredDeliveryManifest["sourceSnapshot"]>["items"];
  missingThemeLabels: string[];
  multiTopicRowCount: number;
  unmappedRowCount: number;
}): StructuredDeliveryRepairPlan | undefined {
  const suggestions: StructuredDeliveryRepairSuggestion[] = [];
  const targets = params.manifest.targets ?? [];
  if (targets.length === 0) return undefined;
  const resultFields = params.manifest.resultSchema?.fields?.map((field) => field.label)
    ?? ["课程名称", "课程介绍"];
  const missingItemMap = new Map(params.missingSourceItems.map((item) => [item.id, item] as const));

  targets.forEach((target, index) => {
    const targetSourceItemIds = Array.isArray(target.metadata?.sourceItemIds)
      ? target.metadata?.sourceItemIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const targetMissingItems = targetSourceItemIds
      .map((sourceItemId) => missingItemMap.get(sourceItemId))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (targetMissingItems.length === 0) return;

    const repairLabel = `${target.label}补派（第${index + 1}组修复）`;
    const repairTargetId = `${target.id}-repair`;
    const repairPromptSpec = buildDynamicPromptSpec({
      taskText: params.taskText,
      sheetLabel: target.label,
      inputItems: targetMissingItems,
      resultFields,
    });
    const task = [
      buildInlineStructuredDispatchPlanFromManifest({
        strategyId: DYNAMIC_SPREADSHEET_STRATEGY_ID,
        manifest: {
          ...params.manifest,
          targets: [{
            ...target,
            promptSpec: repairPromptSpec,
            dispatchSpec: {
              ...target.dispatchSpec,
              label: repairLabel,
              overrides: {
                ...(target.dispatchSpec?.overrides ?? {}),
                deliveryTargetId: repairTargetId,
                deliveryTargetLabel: target.label,
                sheetName: target.label,
                sourceItemIds: targetMissingItems.map((item) => item.id),
                sourceItemCount: targetMissingItems.length,
                scopedSourceItems: buildScopedSourceItems(targetMissingItems),
              },
            },
          }],
        },
      })?.shards[0]?.task ?? buildDynamicPromptSpec({
        taskText: params.taskText,
        sheetLabel: target.label,
        inputItems: targetMissingItems,
        resultFields,
      }).objective,
    ][0];

    suggestions.push({
      label: repairLabel,
      reason: `补齐缺失主题：${targetMissingItems
        .map((item) => item.topicTitle ?? item.label)
        .slice(0, 6)
        .join("、")}`,
      sourceItemIds: targetMissingItems.map((item) => item.id),
      missingThemes: uniqueNonEmpty(targetMissingItems.map((item) => item.topicTitle ?? item.label)),
      task,
      roleBoundary: target.dispatchSpec?.roleBoundary ?? "executor",
      createIfMissing: target.dispatchSpec?.createIfMissing ?? true,
      overrides: {
        ...buildWorkerProfileOverrides("spreadsheet_worker"),
        ...(target.dispatchSpec?.overrides ?? {}),
        deliveryTargetId: repairTargetId,
        deliveryTargetLabel: target.label,
        sheetName: target.label,
        sourceItemIds: targetMissingItems.map((item) => item.id),
        sourceItemCount: targetMissingItems.length,
        scopedSourceItems: buildScopedSourceItems(targetMissingItems),
      },
    });
  });

  if (suggestions.length === 0 && params.multiTopicRowCount === 0 && params.unmappedRowCount === 0) {
    return undefined;
  }

  const nextStepHint = suggestions.length > 0
    ? "优先只补派缺失主题对应的 repair shards，避免重写已经覆盖的主题；补齐后再重试 host export。"
    : "优先修复 row-level mapping：一行只绑定一个主题/sourceItemId，并去掉未映射行后再重试 host export。";

  return {
    summary: params.blocker,
    nextStepHint,
    missingSourceItemIds: params.missingSourceItems.map((item) => item.id),
    missingThemes: params.missingThemeLabels,
    suggestions,
  };
}

export const dynamicSpreadsheetStrategy: StructuredDeliveryStrategy = {
  id: DYNAMIC_SPREADSHEET_STRATEGY_ID,
  deliveryContract: "spreadsheet",
  parentContract: "single_workbook",
  matches(taskText: string): boolean {
    return taskLooksLikeStructuredSpreadsheetDelivery(taskText);
  },
  buildManifest(taskText: string): Omit<StructuredDeliveryManifest, "strategy" | "source"> | null {
    if (!taskRequestsSpreadsheetOutput(taskText)) return null;
    const snapshot = buildSourceGroundingSnapshot(taskText);
    const targets = buildDynamicTargets(taskText);
    const resultSchema = inferRequestedOutputSchema(taskText);
    return {
      recommendedStrategyId: DYNAMIC_SPREADSHEET_STRATEGY_ID,
      adapterEnabled: false,
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      requiresSpreadsheetOutput: true,
      applyInitialIsolation: false,
      sourceSnapshot: snapshot,
      targets,
      resultSchema,
      exportSpec: {
        mode: "single_workbook",
        format: "spreadsheet",
        targetLabels: uniqueNonEmpty(targets.map((target) => target.label)),
      },
      tracePreview: snapshot.sourcePaths.length > 0
        ? `${snapshot.workbookBaseName}.xlsx (${snapshot.items.length || snapshot.expectedItemCount || 0} items)`
        : `dynamic spreadsheet (${snapshot.items.length || snapshot.expectedItemCount || 0} items)`,
    };
  },
  buildInitialDispatchPlan(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
  }): StructuredDeliveryDispatchPlan | null {
    if (!params.manifest.targets?.length) return null;
    return buildInlineStructuredDispatchPlanFromManifest({
      strategyId: DYNAMIC_SPREADSHEET_STRATEGY_ID,
      manifest: params.manifest,
      defaultRoleBoundary: "executor",
      defaultCreateIfMissing: true,
      defaultOverrides: buildWorkerProfileOverrides("spreadsheet_worker"),
      observationText: `已按 source snapshot 派发 ${(params.manifest.targets ?? []).length} 个结构化子任务，等待结果。`,
    });
  },
  buildDeliveryPlanBlock(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
    structuredResults: readonly import("./dialog-subtask-runtime").DialogStructuredSubtaskResult[];
  }): string | undefined {
    if (!taskRequestsSpreadsheetOutput(params.taskText)) return undefined;
    const expectedMinRows = (params.manifest.targets ?? []).reduce((sum, target) => {
      const count = Number(target.metadata?.sourceItemCount ?? 0);
      return sum + (Number.isFinite(count) && count > 0 ? count : 0);
    }, 0);
    const lines = [
      "## 系统锁定的最终交付计划",
      "- 首轮必须先以当前用户输入/附件为真相来源；如尚未读取源文档，请优先读取，不要扫描历史目录。",
      "- 你现在只能消费当前 run 的 structured child results 与当前 run artifacts。",
      "- 最终只允许交付一个 Excel 工作簿；禁止输出多个分散的 xlsx/csv/tsv 文件。",
      "- 若结构化结果足够，请直接调用 `export_spreadsheet`；若仍不足，请返回真实 blocker。",
    ];
    if (params.manifest.resultSchema?.fields?.length) {
      lines.push(`- 期望输出字段：${params.manifest.resultSchema.fields.map((field) => field.label).join("、")}。`);
    }
    if (params.manifest.targets?.length) {
      lines.push(`- 当前 source snapshot 已拆为 ${params.manifest.targets.length} 个结构化子任务。`);
    }
    if (expectedMinRows > 0) {
      lines.push(`- 最低 coverage 基线：至少 ${expectedMinRows} 行（每个源条目至少覆盖 1 行）。`);
    }
    if (params.structuredResults.length > 0) {
      lines.push(`- 当前可用 structured child results 数量：${params.structuredResults.length}。`);
    }
    return lines.join("\n");
  },
  buildHostExportPlan(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
    structuredResults: readonly import("./dialog-subtask-runtime").DialogStructuredSubtaskResult[];
  }): StructuredDeliveryHostExportPlan | StructuredDeliveryHostExportBlocker | null {
    const workbookPlan = buildDynamicWorkbook({
      taskText: params.taskText,
      structuredResults: params.structuredResults,
      resultSchema: params.manifest.resultSchema,
    });
    if ("blocker" in workbookPlan) {
      return { blocker: workbookPlan.blocker };
    }
    const qualityAnalysis = analyzeStructuredSpreadsheetQuality({
      manifest: params.manifest,
      workbookPlan,
    });
    if (qualityAnalysis.blocker) {
      return {
        blocker: qualityAnalysis.blocker,
        repairPlan: buildDynamicRepairPlan({
          taskText: params.taskText,
          manifest: params.manifest,
          blocker: qualityAnalysis.blocker,
          missingSourceItems: qualityAnalysis.missingSourceItems,
          missingThemeLabels: qualityAnalysis.missingThemeLabels,
          multiTopicRowCount: qualityAnalysis.multiTopicRowCount,
          unmappedRowCount: qualityAnalysis.unmappedRowCount,
        }),
      };
    }
    return {
      strategyId: DYNAMIC_SPREADSHEET_STRATEGY_ID,
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      toolName: "export_spreadsheet",
      toolInput: {
        file_name: workbookPlan.fileName,
        sheets: workbookPlan.sheets,
      },
      expectedArtifactExtensions: ["xlsx", "xls"],
      tracePreview: `${workbookPlan.fileName} (${workbookPlan.totalRowCount} rows)`,
      targetPreview: uniqueNonEmpty(params.manifest.targets?.map((target) => target.label) ?? []).join("、"),
      operationCount: workbookPlan.sheets.length,
      successReply: buildDynamicWorkbookReply({
        exportPath: "__EXPORT_PATH__",
        workbookPlan,
        structuredTaskCount: params.structuredResults.length,
      }),
    };
  },
};
