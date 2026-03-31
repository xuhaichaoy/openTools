import type { DynamicWorkbookPlan } from "./dynamic-workbook-builder";
import { validateWorkbookCompleteness } from "./dynamic-workbook-builder";
import type { SourceGroundingItem } from "./source-grounding";
import type { StructuredDeliveryManifest } from "./structured-delivery-strategy";

type ExpectedThemeEntry = {
  key: string;
  display: string;
  sourceItemIds: string[];
};

export interface StructuredSpreadsheetQualityAnalysis {
  blocker: string | null;
  expectedThemeCount: number;
  directCoveredThemeCount: number;
  themeToRowCoverageRatio: string;
  missingThemeLabels: string[];
  missingSourceItems: SourceGroundingItem[];
  multiTopicRowCount: number;
  directCoverageSourceItemCount: number;
  unmappedRowCount: number;
  duplicateRowCount: number;
  hasGroundingCountDrift: boolean;
}

function normalizeThemeKey(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function buildExpectedThemeEntries(
  items: NonNullable<StructuredDeliveryManifest["sourceSnapshot"]>["items"],
): {
  entries: ExpectedThemeEntry[];
  sourceItemToThemeKey: Map<string, string>;
} {
  const entries: ExpectedThemeEntry[] = [];
  const entryByKey = new Map<string, ExpectedThemeEntry>();
  const sourceItemToThemeKey = new Map<string, string>();

  for (const item of items) {
    const display = String(item.topicTitle ?? item.label ?? "").trim() || `主题${item.topicIndex ?? item.order}`;
    const key = normalizeThemeKey(display) || `source-item:${item.id}`;
    sourceItemToThemeKey.set(item.id, key);
    const existing = entryByKey.get(key);
    if (existing) {
      existing.sourceItemIds.push(item.id);
      continue;
    }
    const entry: ExpectedThemeEntry = {
      key,
      display,
      sourceItemIds: [item.id],
    };
    entryByKey.set(key, entry);
    entries.push(entry);
  }

  return { entries, sourceItemToThemeKey };
}

function formatThemeToRowCoverageRatio(expectedThemeCount: number, totalRowCount: number): string {
  if (expectedThemeCount <= 0 || totalRowCount <= 0) return "0.00";
  return (expectedThemeCount / totalRowCount).toFixed(2);
}

export function analyzeStructuredSpreadsheetQuality(params: {
  manifest: StructuredDeliveryManifest;
  workbookPlan: DynamicWorkbookPlan;
}): StructuredSpreadsheetQualityAnalysis {
  const expectedSourceItems = params.manifest.sourceSnapshot?.items ?? [];
  const {
    entries: expectedThemeEntries,
    sourceItemToThemeKey,
  } = buildExpectedThemeEntries(expectedSourceItems);
  const expectedSourceItemIds = expectedSourceItems.map((item) => item.id);
  const directCoveredSourceItemIds = new Set(params.workbookPlan.directCoverageSourceItemIds);
  const missingSourceItems = expectedSourceItems.filter((item) => !directCoveredSourceItemIds.has(item.id));
  const explicitExpectedItemCount = Number(params.manifest.sourceSnapshot?.expectedItemCount ?? 0);
  const groundedItemCount = expectedSourceItems.length;
  const hasGroundingCountDrift = Number.isFinite(explicitExpectedItemCount)
    && explicitExpectedItemCount > 0
    && groundedItemCount > explicitExpectedItemCount;
  const mappedTopicCount = Math.max(
    params.workbookPlan.coverageTopicIndexes.length,
    params.workbookPlan.coverageSourceItemIds.length,
    params.workbookPlan.directCoverageSourceItemIds.length,
  );
  const effectiveExpectedThemeEntries = (
    hasGroundingCountDrift
    && explicitExpectedItemCount > 0
    && expectedThemeEntries.length > explicitExpectedItemCount
  )
    ? expectedThemeEntries.slice(0, explicitExpectedItemCount)
    : expectedThemeEntries;
  const effectiveExpectedThemeCount = effectiveExpectedThemeEntries.length;
  const directCoveredThemeKeys = new Set(
    [...directCoveredSourceItemIds]
      .map((sourceItemId) => sourceItemToThemeKey.get(sourceItemId))
      .filter((value): value is string => Boolean(value)),
  );
  const missingThemeEntries = effectiveExpectedThemeEntries.filter(
    (entry) => !directCoveredThemeKeys.has(entry.key),
  );
  const directCoveredThemeCount = effectiveExpectedThemeCount - missingThemeEntries.length;
  const multiTopicRowCount = params.workbookPlan.rowCoverage.filter(
    (row) => row.sourceItemIds.length > 1 || row.topicIndexes.length > 1,
  ).length;
  const hasCrossTopicRows = multiTopicRowCount > 0;
  const themeToRowCoverageRatio = formatThemeToRowCoverageRatio(
    effectiveExpectedThemeCount,
    params.workbookPlan.totalRowCount,
  );

  const expectedByLabel = new Map<string, number>();
  for (const target of params.manifest.targets ?? []) {
    const label = String(target.label ?? "").trim();
    const sourceItemCount = Number(target.metadata?.sourceItemCount ?? 0);
    if (!label || !Number.isFinite(sourceItemCount) || sourceItemCount <= 0) continue;
    expectedByLabel.set(label, (expectedByLabel.get(label) ?? 0) + sourceItemCount);
  }

  if (expectedByLabel.size === 0 && expectedSourceItemIds.length === 0) {
    return {
      blocker: validateWorkbookCompleteness({
        workbookPlan: params.workbookPlan,
      }),
      expectedThemeCount: 0,
      directCoveredThemeCount: 0,
      themeToRowCoverageRatio: formatThemeToRowCoverageRatio(0, params.workbookPlan.totalRowCount),
      missingThemeLabels: [],
      missingSourceItems: [],
      multiTopicRowCount,
      directCoverageSourceItemCount: directCoveredSourceItemIds.size,
      unmappedRowCount: params.workbookPlan.unmappedRowCount,
      duplicateRowCount: params.workbookPlan.duplicateRowCount,
      hasGroundingCountDrift,
    };
  }

  const labelCoverage = [...expectedByLabel.entries()]
    .map(([label, expected]) => ({
      label,
      expected,
      actual: params.workbookPlan.sheetRowCounts[label] ?? 0,
    }));
  const missingLabels = labelCoverage.filter((entry) => entry.actual < entry.expected);
  const missingCount = missingLabels.reduce((sum, entry) => sum + (entry.expected - entry.actual), 0);

  const expectedMinRows = expectedByLabel.size > 0
    ? labelCoverage.reduce((sum, entry) => sum + entry.expected, 0)
    : expectedSourceItemIds.length;
  const effectiveExpectedMinRows = hasGroundingCountDrift
    ? explicitExpectedItemCount
    : expectedMinRows;
  const completenessBlocker = validateWorkbookCompleteness({
    workbookPlan: params.workbookPlan,
    expectedMinRows: effectiveExpectedMinRows > 0 ? effectiveExpectedMinRows : undefined,
  });
  const missingTopicCount = missingSourceItems.length;
  const hasCoverageGap = missingLabels.length > 0 || missingTopicCount > 0 || missingThemeEntries.length > 0;
  const hasUnmappedRows = params.workbookPlan.unmappedRowCount > 0;
  if (hasGroundingCountDrift) {
    const effectiveMissingThemeCount = Math.max(0, effectiveExpectedThemeCount - directCoveredThemeCount);
    if (
      !completenessBlocker
      && !hasUnmappedRows
      && !hasCrossTopicRows
      && effectiveMissingThemeCount === 0
    ) {
      return {
        blocker: null,
        expectedThemeCount: effectiveExpectedThemeCount,
        directCoveredThemeCount,
        themeToRowCoverageRatio,
        missingThemeLabels: [],
        missingSourceItems: [],
        multiTopicRowCount,
        directCoverageSourceItemCount: directCoveredSourceItemIds.size,
        unmappedRowCount: params.workbookPlan.unmappedRowCount,
        duplicateRowCount: params.workbookPlan.duplicateRowCount,
        hasGroundingCountDrift,
      };
    }
    return {
      blocker: [
      completenessBlocker
        ? "结构化结果行数不足，暂不能直接导出表格。"
        : hasUnmappedRows
          ? "结构化结果存在未绑定 topic/sourceItemId 的行，暂不能直接导出表格。"
          : hasCrossTopicRows
            ? "结构化结果存在单行绑定多个主题/sourceItemId，暂不能直接导出表格。"
            : "结构化结果主题覆盖不足，暂不能直接导出表格。",
      "grounding_drift=true",
      `expected_topic_count=${explicitExpectedItemCount}`,
      `grounded_item_count=${groundedItemCount}`,
      `expected_theme_count=${effectiveExpectedThemeCount}`,
      `direct_covered_theme_count=${directCoveredThemeCount}`,
      `mapped_topic_count=${mappedTopicCount}`,
      `direct_coverage_source_item_count=${directCoveredSourceItemIds.size}`,
      `theme_to_row_coverage_ratio=${themeToRowCoverageRatio}`,
      `multi_topic_row_count=${multiTopicRowCount}`,
      `actual_rows=${params.workbookPlan.totalRowCount}`,
      `missing_theme_count=${effectiveMissingThemeCount}`,
      `unmapped_row_count=${params.workbookPlan.unmappedRowCount}`,
      `duplicate_row_count=${params.workbookPlan.duplicateRowCount}`,
      missingThemeEntries.length > 0
        ? `missing_themes=${missingThemeEntries
          .slice(0, 8)
          .map((entry) => entry.display)
          .join("；")}`
        : "",
      ].join(" "),
      expectedThemeCount: effectiveExpectedThemeCount,
      directCoveredThemeCount,
      themeToRowCoverageRatio,
      missingThemeLabels: missingThemeEntries.map((entry) => entry.display),
      missingSourceItems,
      multiTopicRowCount,
      directCoverageSourceItemCount: directCoveredSourceItemIds.size,
      unmappedRowCount: params.workbookPlan.unmappedRowCount,
      duplicateRowCount: params.workbookPlan.duplicateRowCount,
      hasGroundingCountDrift,
    };
  }
  if (!completenessBlocker && !hasCoverageGap && !hasUnmappedRows && !hasCrossTopicRows) {
    return {
      blocker: null,
      expectedThemeCount: effectiveExpectedThemeCount,
      directCoveredThemeCount,
      themeToRowCoverageRatio,
      missingThemeLabels: [],
      missingSourceItems: [],
      multiTopicRowCount,
      directCoverageSourceItemCount: directCoveredSourceItemIds.size,
      unmappedRowCount: params.workbookPlan.unmappedRowCount,
      duplicateRowCount: params.workbookPlan.duplicateRowCount,
      hasGroundingCountDrift,
    };
  }

  return {
    blocker: [
    completenessBlocker
      ? "结构化结果行数不足，暂不能直接导出表格。"
      : hasUnmappedRows
        ? "结构化结果存在未绑定 topic/sourceItemId 的行，暂不能直接导出表格。"
        : hasCrossTopicRows
          ? "结构化结果存在单行绑定多个主题/sourceItemId，暂不能直接导出表格。"
          : missingThemeEntries.length > 0
            ? "结构化结果主题覆盖不足，暂不能直接导出表格。"
            : "结构化结果覆盖不足，暂不能直接导出表格。",
    `expected_min_rows=${expectedMinRows}`,
    `actual_rows=${params.workbookPlan.totalRowCount}`,
    `covered_topic_count=${directCoveredSourceItemIds.size}`,
    `direct_coverage_source_item_count=${directCoveredSourceItemIds.size}`,
    `expected_theme_count=${effectiveExpectedThemeCount}`,
    `direct_covered_theme_count=${directCoveredThemeCount}`,
    `theme_to_row_coverage_ratio=${themeToRowCoverageRatio}`,
    `missing_source_item_count=${Math.max(missingCount, missingTopicCount)}`,
    `unmapped_row_count=${params.workbookPlan.unmappedRowCount}`,
    `duplicate_row_count=${params.workbookPlan.duplicateRowCount}`,
    `multi_topic_row_count=${multiTopicRowCount}`,
    `labels=${missingLabels.map((entry) => `${entry.label} ${entry.actual}/${entry.expected}`).join("；")}`,
    missingSourceItems.length > 0
      ? `missing_topics=${missingSourceItems
        .slice(0, 8)
        .map((item) => `${item.topicIndex ?? item.order}.${item.topicTitle ?? item.label}`)
        .join("；")}`
      : "",
    missingThemeEntries.length > 0
      ? `missing_themes=${missingThemeEntries
        .slice(0, 8)
        .map((entry) => entry.display)
        .join("；")}`
      : "",
    ].join(" "),
    expectedThemeCount: effectiveExpectedThemeCount,
    directCoveredThemeCount,
    themeToRowCoverageRatio,
    missingThemeLabels: missingThemeEntries.map((entry) => entry.display),
    missingSourceItems,
    multiTopicRowCount,
    directCoverageSourceItemCount: directCoveredSourceItemIds.size,
    unmappedRowCount: params.workbookPlan.unmappedRowCount,
    duplicateRowCount: params.workbookPlan.duplicateRowCount,
    hasGroundingCountDrift,
  };
}

export function validateStructuredSpreadsheetQuality(params: {
  manifest: StructuredDeliveryManifest;
  workbookPlan: DynamicWorkbookPlan;
}): string | null {
  return analyzeStructuredSpreadsheetQuality(params).blocker;
}
