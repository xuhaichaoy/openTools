import type { StructuredDeliveryResultSchema } from "./structured-delivery-strategy";

export interface SourceGroundingItem {
  id: string;
  label: string;
  raw: string;
  order: number;
  sourcePath?: string;
  sectionLabel?: string;
  topicIndex?: number;
  topicTitle?: string;
  themeGroup?: string;
  trainingTarget?: string;
  trainingAudience?: string;
  outline?: string;
}

export interface SourceGroundingSection {
  id: string;
  label: string;
  sourcePath?: string;
  itemIds: string[];
  itemCount: number;
}

export interface SourceGroundingSnapshot {
  sourcePaths: string[];
  sections: SourceGroundingSection[];
  items: SourceGroundingItem[];
  expectedItemCount?: number;
  workbookBaseName: string;
  warnings: string[];
}

export const AUTO_SOURCE_GROUNDING_HEADER = "## 自动 source grounding（系统真实读取）";

export function cloneSourceGroundingSnapshot(
  snapshot: SourceGroundingSnapshot,
): SourceGroundingSnapshot {
  return {
    ...snapshot,
    sourcePaths: [...snapshot.sourcePaths],
    sections: snapshot.sections.map((section) => ({
      ...section,
      itemIds: [...section.itemIds],
    })),
    items: snapshot.items.map((item) => ({ ...item })),
    warnings: [...snapshot.warnings],
  };
}

const DOCUMENT_PATH_PATTERN = /\/[^\s"'`]+?\.(?:xlsx|xls|csv|pdf|docx?|pptx?|md|txt|json)\b/giu;
const FILE_SECTION_PATTERN = /^###\s*(?:文件|file)\s+(.+)$/imu;
const SHEET_HEADING_PATTERN = /^##\s*Sheet:\s*(.+)$/iu;
const NUMBERED_LINE_PATTERN = /^(\d{1,3})\s*[.、．]\s*(.+)$/u;
const HEADING_PATTERN = /^(?:#{1,6}\s*)?([^#\n]{2,40})$/u;
const OUTPUT_FIELD_PATTERNS = [
  /(?:需要提供的字段(?:只有|为|包括|包含)?|输出字段(?:只有|为|包括|包含)?|字段(?:只有|为|包括|包含)?|列(?:只有|为|包括|包含)?)[：:\s]*([^\n。]+)/iu,
  /(?:字段|列名)\s*(?:仅|只)?\s*(?:保留|输出)?[：:\s]*([^\n。]+)/iu,
] as const;
const DEFAULT_SHEET_LABEL = "结果清单";
const EXPECTED_ITEM_PATTERNS = [
  /(\d{1,4})\s*个(?:课程)?主题/u,
  /(\d{1,4})\s*(?:条|项|行|个)(?:记录|条目|事项|主题|课程候选|候选)?/u,
  /(?:共|一共|合计|总计|文件内|包含)\s*(\d{1,4})\s*(?:条|项|行|个)(?:记录|条目|事项|主题|课程候选|候选)?/u,
] as const;
const TOPIC_HEADER_PATTERNS = [
  /^主题$/u,
  /^课程主题$/u,
  /^topic$/iu,
  /^topic\s*title$/iu,
] as const;
const TRAINING_TARGET_HEADER_PATTERNS = [
  /培训目标/u,
  /学习目标/u,
  /目标/u,
] as const;
const TRAINING_AUDIENCE_HEADER_PATTERNS = [
  /培训对象/u,
  /适用对象/u,
  /受众/u,
  /对象/u,
  /学员/u,
] as const;
const OUTLINE_HEADER_PATTERNS = [
  /课程大纲/u,
  /大纲/u,
  /提纲/u,
  /outline/iu,
] as const;
const SECTION_EXCLUDE_PATTERNS = [
  /^工作上下文/u,
  /^项目路径/u,
  /^以下是/u,
  /^用户要求/u,
  /^培训(?:目标|对象)$/u,
  /^课程主题$/u,
  /^file[:：]/iu,
  /^sheet[:：]/iu,
  /^\/Users\//u,
  /^输出要求/u,
  /^任务目标/u,
  /^协作方式/u,
] as const;

function normalizeWhitespace(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSectionLabel(value: string | undefined): string | undefined {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return undefined;
  if (SECTION_EXCLUDE_PATTERNS.some((pattern) => pattern.test(normalized))) return undefined;
  if (normalized.length > 40) return undefined;
  return normalized.replace(/[：:;；,，。]+$/u, "").trim() || undefined;
}

function deriveWorkbookBaseName(taskText: string): string {
  const pathMatch = taskText.match(DOCUMENT_PATH_PATTERN);
  const firstPath = pathMatch?.[0];
  if (firstPath) {
    const fileName = firstPath.replace(/\\/g, "/").split("/").pop() ?? "";
    const dotIndex = fileName.lastIndexOf(".");
    if (dotIndex > 0) return fileName.slice(0, dotIndex);
  }
  return "导出结果";
}

function splitFileSections(taskText: string): Array<{ sourcePath?: string; content: string }> {
  const sections: Array<{ sourcePath?: string; content: string }> = [];
  const lines = taskText.split(/\r?\n/);
  let currentPath: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) {
      sections.push({ sourcePath: currentPath, content });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const match = line.match(FILE_SECTION_PATTERN);
    if (match) {
      flush();
      currentPath = normalizeWhitespace(match[1]);
      continue;
    }
    buffer.push(rawLine);
  }
  flush();

  return sections.length > 0 ? sections : [{ content: taskText }];
}

function getGroundingExtractionText(taskText: string): string {
  const markerIndex = taskText.indexOf(AUTO_SOURCE_GROUNDING_HEADER);
  if (markerIndex < 0) return taskText;
  return taskText.slice(markerIndex);
}

function extractSourcePaths(taskText: string): string[] {
  return [...new Set((taskText.match(DOCUMENT_PATH_PATTERN) ?? []).map((item) => item.trim()))];
}

function extractExpectedItemCount(taskText: string): number | undefined {
  for (const pattern of EXPECTED_ITEM_PATTERNS) {
    const match = taskText.match(pattern);
    const value = Number.parseInt(match?.[1] ?? "", 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function extractItemsFromBlock(params: {
  content: string;
  sourcePath?: string;
  itemOffset: number;
  sectionOffset: number;
}): {
  items: SourceGroundingItem[];
  sections: SourceGroundingSection[];
} {
  const items: SourceGroundingItem[] = [];
  const sections = new Map<string, SourceGroundingSection>();
  let currentSectionLabel: string | undefined;
  const tabularLines: Array<{ line: string; sectionLabel?: string }> = [];

  for (const rawLine of params.content.split(/\r?\n/)) {
    const rawTrimmed = String(rawLine ?? "").trim();
    if (!rawTrimmed) continue;
    const line = normalizeWhitespace(rawLine);

    const sheetHeading = line.match(SHEET_HEADING_PATTERN);
    if (sheetHeading?.[1]) {
      currentSectionLabel = normalizeSectionLabel(sheetHeading[1]) ?? currentSectionLabel;
      continue;
    }

    const numbered = line.match(NUMBERED_LINE_PATTERN);
    if (!numbered) {
      if (/\t|,|，/.test(rawLine)) {
        tabularLines.push({ line: rawTrimmed, sectionLabel: currentSectionLabel });
      }
      const headingMatch = line.match(HEADING_PATTERN);
      const candidate = headingMatch?.[1] ? normalizeSectionLabel(headingMatch[1]) : normalizeSectionLabel(line);
      if (candidate) currentSectionLabel = candidate;
      continue;
    }

    const label = normalizeWhitespace(numbered[2]);
    if (!label) continue;
    const itemIndex = params.itemOffset + items.length + 1;
    const itemId = `source-item-${itemIndex}`;
    const topicIndex = Number.parseInt(numbered[1] ?? "", 10);
    items.push({
      id: itemId,
      label,
      raw: line,
      order: itemIndex,
      sourcePath: params.sourcePath,
      sectionLabel: currentSectionLabel,
      topicIndex: Number.isFinite(topicIndex) && topicIndex > 0 ? topicIndex : itemIndex,
      topicTitle: label,
      themeGroup: currentSectionLabel,
    });

    const sectionKey = currentSectionLabel ?? "__default__";
    if (!sections.has(sectionKey)) {
      const sectionIndex = params.sectionOffset + sections.size + 1;
      sections.set(sectionKey, {
        id: `source-section-${sectionIndex}`,
        label: currentSectionLabel ?? "结果清单",
        sourcePath: params.sourcePath,
        itemIds: [],
        itemCount: 0,
      });
    }
    const section = sections.get(sectionKey)!;
    section.itemIds.push(itemId);
    section.itemCount += 1;
  }

  if (items.length === 0 && tabularLines.length > 1) {
    const headerLine = tabularLines[0];
    const splitCells = (line: string) => line.includes("\t")
      ? line.split("\t")
      : line.split(/[,，]/u);
    const headers = splitCells(headerLine.line)
      .map((cell) => normalizeWhitespace(cell))
      .filter(Boolean);
    if (headers.length > 0) {
      const findHeaderIndex = (patterns: readonly RegExp[]) => headers.findIndex((header) =>
        patterns.some((pattern) => pattern.test(header)),
      );
      const topicHeaderIndex = findHeaderIndex(TOPIC_HEADER_PATTERNS);
      const trainingTargetHeaderIndex = findHeaderIndex(TRAINING_TARGET_HEADER_PATTERNS);
      const trainingAudienceHeaderIndex = findHeaderIndex(TRAINING_AUDIENCE_HEADER_PATTERNS);
      const outlineHeaderIndex = findHeaderIndex(OUTLINE_HEADER_PATTERNS);
      for (const row of tabularLines.slice(1)) {
        const cells = splitCells(row.line).map((cell) => normalizeWhitespace(cell));
        if (cells.every((cell) => !cell)) continue;
        const itemIndex = params.itemOffset + items.length + 1;
        const topicTitle = (
          (topicHeaderIndex >= 0 ? cells[topicHeaderIndex] : "")
          || cells[0]
          || ""
        ).trim();
        const trainingTarget = trainingTargetHeaderIndex >= 0 ? cells[trainingTargetHeaderIndex] : undefined;
        const trainingAudience = trainingAudienceHeaderIndex >= 0 ? cells[trainingAudienceHeaderIndex] : undefined;
        const outline = outlineHeaderIndex >= 0 ? cells[outlineHeaderIndex] : undefined;
        const fallbackLabel = headers
          .map((header, index) => `${header}: ${cells[index] ?? ""}`.trim())
          .filter((entry) => !/:\s*$/u.test(entry))
          .join("；");
        const label = topicTitle || fallbackLabel;
        if (!label) continue;
        const itemId = `source-item-${itemIndex}`;
        const sectionLabel = row.sectionLabel ?? headerLine.sectionLabel ?? currentSectionLabel ?? DEFAULT_SHEET_LABEL;
        items.push({
          id: itemId,
          label,
          raw: row.line,
          order: itemIndex,
          sourcePath: params.sourcePath,
          sectionLabel,
          topicIndex: itemIndex,
          topicTitle: topicTitle || label,
          themeGroup: sectionLabel,
          trainingTarget: trainingTarget || undefined,
          trainingAudience: trainingAudience || undefined,
          outline: outline || undefined,
        });

        const sectionKey = sectionLabel;
        if (!sections.has(sectionKey)) {
          const sectionIndex = params.sectionOffset + sections.size + 1;
          sections.set(sectionKey, {
            id: `source-section-${sectionIndex}`,
            label: sectionLabel,
            sourcePath: params.sourcePath,
            itemIds: [],
            itemCount: 0,
          });
        }
        const section = sections.get(sectionKey)!;
        section.itemIds.push(itemId);
        section.itemCount += 1;
      }
    }
  }

  return {
    items,
    sections: [...sections.values()],
  };
}

function splitFieldLabels(raw: string): string[] {
  const normalized = raw
    .replace(/^[：:\s]+/u, "")
    .replace(/[。；;]+$/u, "")
    .trim();
  if (!normalized) return [];

  const cleaned = normalized
    .replace(/(?:,|，)?\s*(?:最终|最后|然后|并最终|并最后).*/u, "")
    .replace(/(?:,|，)?\s*(?:导出|输出|保存|返回).*/u, "")
    .replace(/(?:只有|仅|只|包括|包含|为|是)/gu, " ")
    .replace(/[`"'“”‘’]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  return [...new Set(
    cleaned
      .split(/(?:、|,|，|\/|和|及|以及|\band\b)/iu)
      .map((item) => normalizeWhitespace(item))
      .filter((item) => (
        item.length > 0
        && item.length <= 24
        && !/^(?:最终|excel|xlsx|csv|工作簿|文件|结果|输出)$/iu.test(item)
      )),
  )];
}

export function inferRequestedOutputSchema(
  taskText: string,
): StructuredDeliveryResultSchema | undefined {
  for (const pattern of OUTPUT_FIELD_PATTERNS) {
    const match = taskText.match(pattern);
    const labels = splitFieldLabels(match?.[1] ?? "");
    if (labels.length === 0) continue;
    return {
      id: "dynamic_spreadsheet_rows",
      kind: "table_rows",
      fields: labels.map((label) => ({
        key: label,
        label,
        required: true,
      })),
    };
  }
  return undefined;
}

export function buildSourceGroundingSnapshot(taskText: string): SourceGroundingSnapshot {
  const sourcePaths = extractSourcePaths(taskText);
  const fileSections = splitFileSections(getGroundingExtractionText(taskText));
  const items: SourceGroundingItem[] = [];
  const sections: SourceGroundingSection[] = [];

  for (const block of fileSections) {
    const extracted = extractItemsFromBlock({
      content: block.content,
      sourcePath: block.sourcePath,
      itemOffset: items.length,
      sectionOffset: sections.length,
    });
    items.push(...extracted.items);
    sections.push(...extracted.sections);
  }

  const warnings: string[] = [];
  const expectedItemCount = extractExpectedItemCount(taskText);
  if (typeof expectedItemCount === "number" && items.length > 0 && expectedItemCount !== items.length) {
    warnings.push(`expected_item_count=${expectedItemCount} but grounded_items=${items.length}`);
  }
  if (items.length === 0) {
    warnings.push("未能从当前任务文本中抽取出结构化源条目");
  }

  return {
    sourcePaths,
    sections,
    items,
    expectedItemCount,
    workbookBaseName: deriveWorkbookBaseName(taskText),
    warnings,
  };
}
