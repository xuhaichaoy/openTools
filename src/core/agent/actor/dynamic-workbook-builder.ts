import type { DialogStructuredSubtaskResult } from "./dialog-subtask-runtime";
import type { StructuredDeliveryResultSchema } from "./structured-delivery-strategy";
export {
  extractStructuredJsonCandidate,
  tryParseStructuredPayload,
} from "./structured-json-utils";
import {
  extractStructuredJsonCandidate,
  tryParseStructuredPayload,
} from "./structured-json-utils";

// ── Types ──

export interface DynamicWorkbookSheet {
  name: string;
  headers: string[];
  rows: string[][];
}

export interface DynamicWorkbookPlan {
  fileName: string;
  sheets: DynamicWorkbookSheet[];
  totalRowCount: number;
  sourceRowCount: number;
  duplicateRowCount: number;
  sheetRowCounts: Record<string, number>;
  coverageSourceItemIds: string[];
  directCoverageSourceItemIds: string[];
  coverageTopicIndexes: number[];
  unmappedRowCount: number;
  rowCoverage: DynamicWorkbookRowCoverage[];
}

export type StructuredRowRecord = Record<string, string>;

export interface DynamicWorkbookRowCoverage {
  sheetName: string;
  rowIndex: number;
  sourceItemIds: string[];
  topicIndexes: number[];
  coverageType?: string;
}

// ── Column Inference ──

export function inferColumnsFromRows(rows: unknown[]): string[] {
  const frequencyMap = new Map<string, number>();
  const firstSeen = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      const normalizedKey = key.trim();
      if (!normalizedKey) continue;
      frequencyMap.set(normalizedKey, (frequencyMap.get(normalizedKey) ?? 0) + 1);
      if (!firstSeen.has(normalizedKey)) {
        firstSeen.set(normalizedKey, i);
      }
    }
  }

  return [...frequencyMap.entries()]
    .sort((a, b) => {
      const freqDiff = b[1] - a[1];
      if (freqDiff !== 0) return freqDiff;
      return (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0);
    })
    .map(([key]) => key);
}

// ── Row Normalization ──

export function normalizeGenericRow(
  value: unknown,
  columns: string[],
): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const normalizedEntries = new Map<string, unknown>();
  for (const [key, entryValue] of Object.entries(record)) {
    normalizedEntries.set(normalizeColumnLookupKey(key), entryValue);
  }
  const cells = columns.map((col) => {
    const raw = readRecordValueByColumn(record, normalizedEntries, col);
    if (raw == null) return "";
    return String(raw).replace(/\s+/g, " ").trim();
  });
  if (cells.every((cell) => !cell)) return null;
  return cells;
}

function normalizeColumnLookupKey(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[\s_\-]/g, "")
    .toLowerCase();
}

const STRUCTURED_FIELD_ALIASES = new Map<string, string[]>([
  ["课程名称", ["courseName", "course_name", "courseTitle", "course_title", "title", "name", "课程名"]],
  ["课程介绍", ["courseIntro", "course_intro", "courseIntroduction", "course_introduction", "introduction", "description", "课程简介", "简介", "介绍"]],
]);

function buildColumnLookupCandidates(column: string): string[] {
  const normalizedColumn = String(column ?? "").trim();
  const aliases = STRUCTURED_FIELD_ALIASES.get(normalizedColumn) ?? [];
  return [normalizedColumn, ...aliases];
}

function readRecordValueByColumn(
  record: Record<string, unknown>,
  normalizedEntries: ReadonlyMap<string, unknown>,
  column: string,
): unknown {
  if (column in record) return record[column];
  for (const candidate of buildColumnLookupCandidates(column)) {
    if (candidate in record) return record[candidate];
    const normalizedCandidate = normalizeColumnLookupKey(candidate);
    if (normalizedEntries.has(normalizedCandidate)) {
      return normalizedEntries.get(normalizedCandidate);
    }
  }
  return undefined;
}

const SOURCE_ITEM_ID_KEYS = [
  "sourceItemId",
  "source_item_id",
  "coverageSourceItemIds",
  "coverage_source_item_ids",
] as const;
const TOPIC_INDEX_KEYS = [
  "topicIndex",
  "topic_index",
  "coverageTopicIndexes",
  "coverage_topic_indexes",
] as const;
const COVERAGE_TYPE_KEYS = [
  "coverageType",
  "coverage_type",
] as const;

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }
  const normalized = String(value ?? "").trim();
  if (!normalized) return [];
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    try {
      const parsed = JSON.parse(normalized);
      return parseStringList(parsed);
    } catch {
      // fall through to delimited parsing
    }
  }
  if (!/[，,、|]/u.test(normalized)) return [normalized];
  return normalized
    .split(/[，,、|]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumberList(value: unknown): number[] {
  return parseStringList(value)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function readFirstRecordValue(
  row: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (key in row) return row[key];
  }
  return undefined;
}

function extractRowCoverage(row: unknown): {
  sourceItemIds: string[];
  topicIndexes: number[];
  coverageType?: string;
} {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { sourceItemIds: [], topicIndexes: [] };
  }
  const record = row as Record<string, unknown>;
  const sourceItemIds = [...new Set(
    SOURCE_ITEM_ID_KEYS.flatMap((key) => parseStringList(record[key])),
  )];
  const topicIndexes = [...new Set(
    TOPIC_INDEX_KEYS.flatMap((key) => parseNumberList(record[key])),
  )];
  const coverageType = String(readFirstRecordValue(record, COVERAGE_TYPE_KEYS) ?? "").trim() || undefined;
  return { sourceItemIds, topicIndexes, coverageType };
}

// ── Deep Row Extraction ──

function extractRowsFromPayload(payload: unknown, depth = 0): unknown[] {
  if (depth > 3 || payload == null) return [];
  if (Array.isArray(payload)) {
    const objects = payload.filter(
      (item): item is Record<string, unknown> =>
        item != null && typeof item === "object" && !Array.isArray(item),
    );
    if (objects.length > 0) return objects;
    for (const item of payload) {
      const nested = extractRowsFromPayload(item, depth + 1);
      if (nested.length > 0) return nested;
    }
    return [];
  }
  if (typeof payload === "object") {
    for (const nested of Object.values(payload as Record<string, unknown>)) {
      const rows = extractRowsFromPayload(nested, depth + 1);
      if (rows.length > 0) return rows;
    }
  }
  return [];
}

export function extractRowsFromStructuredResult(
  result: DialogStructuredSubtaskResult,
): unknown[] {
  return extractRowsFromPayload(tryParseStructuredPayload(result.terminalResult));
}

export function extractNormalizedStructuredRows(params: {
  result: DialogStructuredSubtaskResult;
  resultSchema?: StructuredDeliveryResultSchema;
}): StructuredRowRecord[] {
  if (params.result.structuredRows?.length) {
    return params.result.structuredRows.map((row) => ({ ...row }));
  }
  const rawRows = extractRowsFromStructuredResult(params.result);
  const schemaColumns = params.resultSchema?.fields?.map((field) => field.label);
  const columns = schemaColumns?.length
    ? schemaColumns
    : inferColumnsFromRows(rawRows);
  if (columns.length === 0) return [];
  return rawRows
    .map((row) => normalizeGenericRow(row, columns))
    .filter((row): row is string[] => row !== null)
    .map((cells) => Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ""])));
}

export function hasExportableStructuredRows(params: {
  result: DialogStructuredSubtaskResult;
  resultSchema?: StructuredDeliveryResultSchema;
}): boolean {
  if (params.result.status !== "completed") return false;
  return extractNormalizedStructuredRows(params).length > 0;
}

export function filterExportableStructuredResults(params: {
  structuredResults: readonly DialogStructuredSubtaskResult[];
  resultSchema?: StructuredDeliveryResultSchema;
}): DialogStructuredSubtaskResult[] {
  return params.structuredResults.filter((result) =>
    hasExportableStructuredRows({
      result,
      resultSchema: params.resultSchema,
    })
  );
}

export interface StructuredResultExportabilitySummary {
  runId: string;
  label: string;
  rowCount: number;
  hasStructuredRows: boolean;
  hasJsonCandidate: boolean;
  resultKind: string;
  status: string;
}

export function inspectStructuredResultExportability(params: {
  structuredResults: readonly DialogStructuredSubtaskResult[];
  resultSchema?: StructuredDeliveryResultSchema;
}): StructuredResultExportabilitySummary[] {
  return params.structuredResults.map((result) => {
    const rows = extractNormalizedStructuredRows({
      result,
      resultSchema: params.resultSchema,
    });
    return {
      runId: result.runId,
      label: result.label ?? result.deliveryTargetLabel ?? result.targetActorName ?? result.runId,
      rowCount: rows.length,
      hasStructuredRows: Array.isArray(result.structuredRows) && result.structuredRows.length > 0,
      hasJsonCandidate: Boolean(extractStructuredJsonCandidate(result.terminalResult)),
      resultKind: result.resultKind ?? "unknown",
      status: result.status,
    };
  });
}

// ── File Name Derivation ──

export function deriveWorkbookFileName(query: string): string {
  const pathMatch = query.match(/\/([^/\s"'`]+)\.(?:xlsx|xls|csv)\b/iu);
  if (pathMatch?.[1]) {
    return `${pathMatch[1]}.xlsx`;
  }
  const chineseNameMatch = query.match(
    /(?:生成|导出|整理|汇总|制作).{0,6}(?:一[份个张])?[《「""]?([^\s《》「」""]{2,12}?)(?:表格|表|文件|工作簿|excel|xlsx)[》」""]?/iu,
  );
  if (chineseNameMatch?.[1]) {
    return `${chineseNameMatch[1]}.xlsx`;
  }
  return "导出结果.xlsx";
}

// ── Sheet Grouping ──

function resolveSheetName(result: DialogStructuredSubtaskResult): string {
  return (
    result.deliveryTargetLabel
    || result.sheetName
    || result.label
    || "Sheet1"
  ).replace(/生成$/, "").trim() || "Sheet1";
}

// ── Core: Build Dynamic Workbook ──

export function buildDynamicWorkbook(params: {
  taskText: string;
  structuredResults: readonly DialogStructuredSubtaskResult[];
  resultSchema?: StructuredDeliveryResultSchema;
}): DynamicWorkbookPlan | { blocker: string } {
  const sheetDataMap = new Map<string, unknown[]>();
  const sheetOrder: string[] = [];
  let sourceRowCount = 0;

  for (const taskResult of params.structuredResults) {
    if (taskResult.status !== "completed") continue;
    const rawRows = extractNormalizedStructuredRows({
      result: taskResult,
    });
    if (rawRows.length === 0) continue;
    sourceRowCount += rawRows.length;
    const sheetName = resolveSheetName(taskResult);
    if (!sheetDataMap.has(sheetName)) {
      sheetDataMap.set(sheetName, []);
      sheetOrder.push(sheetName);
    }
    sheetDataMap.get(sheetName)!.push(...rawRows);
  }

  if (sheetOrder.length === 0) {
    return { blocker: "所有子任务的结构化结果均为空，无法构建工作簿。" };
  }

  const globalDedupeKeys = new Set<string>();
  const sheets: DynamicWorkbookSheet[] = [];
  const sheetRowCounts: Record<string, number> = {};
  const coverageSourceItemIds = new Set<string>();
  const directCoverageSourceItemIds = new Set<string>();
  const coverageTopicIndexes = new Set<number>();
  const rowCoverage: DynamicWorkbookRowCoverage[] = [];
  let unmappedRowCount = 0;

  for (const sheetName of sheetOrder) {
    const rawRows = sheetDataMap.get(sheetName) ?? [];
    const schemaColumns = params.resultSchema?.fields?.map((f) => f.label);
    const columns = schemaColumns?.length
      ? schemaColumns
      : inferColumnsFromRows(rawRows);

    if (columns.length === 0) continue;

    const deduplicatedRows: string[][] = [];
    for (const rawRow of rawRows) {
      const cells = normalizeGenericRow(rawRow, columns);
      if (!cells) continue;
      const coverage = extractRowCoverage(rawRow);
      const dedupeKey = [
        sheetName,
        coverage.sourceItemIds.slice().sort().join("|"),
        coverage.topicIndexes.slice().sort((left, right) => left - right).join("|"),
        cells.join("||"),
      ].join("::").toLowerCase();
      if (globalDedupeKeys.has(dedupeKey)) continue;
      globalDedupeKeys.add(dedupeKey);
      deduplicatedRows.push(cells);
      if (coverage.sourceItemIds.length === 0 && coverage.topicIndexes.length === 0) {
        unmappedRowCount += 1;
      }
      for (const sourceItemId of coverage.sourceItemIds) {
        coverageSourceItemIds.add(sourceItemId);
      }
      for (const topicIndex of coverage.topicIndexes) {
        coverageTopicIndexes.add(topicIndex);
      }
      const directCoverage = (
        coverage.coverageType !== "synthesized"
        && coverage.sourceItemIds.length === 1
      );
      if (directCoverage) {
        directCoverageSourceItemIds.add(coverage.sourceItemIds[0]);
      }
      rowCoverage.push({
        sheetName,
        rowIndex: deduplicatedRows.length - 1,
        sourceItemIds: [...coverage.sourceItemIds],
        topicIndexes: [...coverage.topicIndexes],
        coverageType: coverage.coverageType,
      });
    }

    sheets.push({
      name: sheetName,
      headers: [...columns],
      rows: deduplicatedRows,
    });
    sheetRowCounts[sheetName] = deduplicatedRows.length;
  }

  const totalRowCount = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  if (totalRowCount === 0) {
    return { blocker: "去重后无有效行数据，无法导出。" };
  }

  return {
    fileName: deriveWorkbookFileName(params.taskText),
    sheets,
    totalRowCount,
    sourceRowCount,
    duplicateRowCount: Math.max(0, sourceRowCount - totalRowCount),
    sheetRowCounts,
    coverageSourceItemIds: [...coverageSourceItemIds],
    directCoverageSourceItemIds: [...directCoverageSourceItemIds],
    coverageTopicIndexes: [...coverageTopicIndexes],
    unmappedRowCount,
    rowCoverage,
  };
}

// ── Completeness Validation ──

export function validateWorkbookCompleteness(params: {
  workbookPlan: DynamicWorkbookPlan;
  expectedMinRows?: number;
  maxDuplicateRatio?: number;
}): string | null {
  const { workbookPlan, expectedMinRows, maxDuplicateRatio = 0.5 } = params;

  const emptySheets = workbookPlan.sheets.filter((s) => s.rows.length === 0);
  if (emptySheets.length > 0) {
    return `以下 sheet 无数据行：${emptySheets.map((s) => s.name).join("、")}`;
  }

  if (
    typeof expectedMinRows === "number"
    && expectedMinRows > 0
    && workbookPlan.totalRowCount < expectedMinRows
  ) {
    return [
      "结构化结果行数不足。",
      `expected_min_rows=${expectedMinRows}`,
      `actual_rows=${workbookPlan.totalRowCount}`,
    ].join(" ");
  }

  if (
    workbookPlan.sourceRowCount > 0
    && workbookPlan.duplicateRowCount / workbookPlan.sourceRowCount > maxDuplicateRatio
  ) {
    return [
      "去重率过高，子任务间存在大量重复。",
      `source_rows=${workbookPlan.sourceRowCount}`,
      `duplicate_rows=${workbookPlan.duplicateRowCount}`,
      `ratio=${(workbookPlan.duplicateRowCount / workbookPlan.sourceRowCount).toFixed(2)}`,
    ].join(" ");
  }

  return null;
}

// ── Reply Builder ──

export function buildDynamicWorkbookReply(params: {
  exportPath: string;
  workbookPlan: DynamicWorkbookPlan;
  structuredTaskCount: number;
}): string {
  const sheetLines = params.workbookPlan.sheets.map(
    (sheet) => `- ${sheet.name}：${sheet.rows.length} 行`,
  );
  return [
    "已完成工作簿的最终整合与交付。",
    "",
    `已导出 Excel 文件：${params.exportPath}`,
    `本轮已汇总 ${params.structuredTaskCount} 个子任务的结构化结果，共 ${params.workbookPlan.totalRowCount} 行。`,
    ...sheetLines,
  ].join("\n");
}
