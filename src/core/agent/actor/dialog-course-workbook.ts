import type { DialogStructuredSubtaskResult } from "./dialog-subtask-runtime";
import type {
  StructuredDeliveryStrategy,
  StructuredDeliveryDispatchPlan,
  StructuredDeliveryHostExportPlan,
  StructuredDeliveryManifest,
  StructuredDeliveryPromptSpec,
  StructuredDeliveryResultSchema,
  StructuredDeliveryTargetDispatchSpec,
} from "./structured-delivery-strategy";
import {
  buildInlineStructuredDispatchPlanFromManifest,
  buildInlineStructuredResultPrompt,
} from "./structured-delivery-strategy";

export const DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES = [
  "技术方向课程",
  "产品运营方向课程",
  "数据与通识方向课程",
] as const;

export const DETERMINISTIC_COURSE_WORKBOOK_HEADERS = ["课程名称", "课程介绍"] as const;

export type DeterministicCourseWorkbookSheetName = typeof DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES[number];

export interface DeterministicCourseTheme {
  index?: number;
  title: string;
  raw: string;
  sheetName: DeterministicCourseWorkbookSheetName;
}

export interface DeterministicCourseShardPlan {
  totalThemeCount: number;
  shards: Array<{
    sheetName: DeterministicCourseWorkbookSheetName;
    label: string;
    task: string;
    themes: DeterministicCourseTheme[];
  }>;
}

export interface DeterministicCourseWorkbookSheet {
  name: DeterministicCourseWorkbookSheetName;
  headers: string[];
  rows: string[][];
}

export interface DeterministicCourseWorkbookPlan {
  fileName: string;
  sheets: DeterministicCourseWorkbookSheet[];
  sheetRowCounts: Record<DeterministicCourseWorkbookSheetName, number>;
  totalRowCount: number;
}

const COURSE_WORKBOOK_RESULT_SCHEMA: StructuredDeliveryResultSchema = {
  id: "course_workbook_rows",
  kind: "table_rows",
  fields: [
    { key: "课程名称", label: "课程名称", required: true },
    { key: "课程介绍", label: "课程介绍", required: true },
  ],
};

const PRODUCT_OPERATION_PATTERNS = [
  /产品|运营|解决方案|商业|需求|增长|营销|转化|客户|售前|售后/u,
];

const DATA_AND_LITERACY_PATTERNS = [
  /数据|分析|洞察|通识|全员|赋能|办公|素养|认知|思维|协同|金融科技/u,
];

const TECHNICAL_PATTERNS = [
  /开发|工程|模型|算法|安全|测试|运维|部署|知识库|智能体|prompt|rag|架构|评测|训练|调优/u,
];

const THEME_EXCLUDE_PATTERNS = [
  /^序号$/u,
  /^课程主题$/u,
  /^培训(?:对象|目标)$/u,
  /^项目路径/u,
  /^sheet[:：]/iu,
  /^file[:：]/iu,
  /^\/Users\//u,
  /^以下是/u,
  /^用户要求/u,
  /^工作上下文/u,
];

const COURSE_CONTENT_DELIVERY_PATTERNS = [
  /课程|培训|课纲|课程候选|课程名称|课程介绍|培训目标|培训对象|课程清单/u,
  /按主题.*(?:生成|整理|汇总).*(?:课程|条目|清单)/u,
  /基于.*(?:excel|xlsx|xls|csv|表格|工作簿).*(?:生成|整理|汇总).*(?:课程|条目|清单)/iu,
] as const;

const SPREADSHEET_OUTPUT_PATTERNS = [
  /(?:最终|最后|输出|导出|保存|生成|给我|给出|返回).{0,18}(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿)?/iu,
  /(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿).{0,12}(?:输出|导出|保存|生成|给我|给出|返回|最终|最后)/iu,
] as const;

function normalizeWhitespace(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function taskRequestsSpreadsheetOutput(task: string): boolean {
  const normalized = normalizeWhitespace(task);
  if (!normalized) return false;
  return SPREADSHEET_OUTPUT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function taskLooksLikeCourseContentDelivery(task: string): boolean {
  const normalized = normalizeWhitespace(task);
  if (!normalized) return false;
  return COURSE_CONTENT_DELIVERY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function matchesDeterministicCourseWorkbookTask(task: string): boolean {
  if (!taskRequestsSpreadsheetOutput(task)) return false;
  if (!taskLooksLikeCourseContentDelivery(task)) return false;
  return extractDeterministicCourseThemes(task).length >= 9;
}

function cleanThemeTitle(raw: string): string {
  return normalizeWhitespace(
    raw
      .replace(/^课程主题[:：]?/u, "")
      .replace(/^[>*\-•\s]+/u, "")
      .replace(/\|/g, " ")
      .split(/(?:培训对象|培训目标|期数|天数|供应商课程信息|响应信息)/u)[0] ?? "",
  )
    .replace(/[：:;；,，。]+$/u, "")
    .trim();
}

function inferSheetNameFromText(
  text: string | undefined,
  fallback: DeterministicCourseWorkbookSheetName = "技术方向课程",
): DeterministicCourseWorkbookSheetName {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return fallback;
  if (PRODUCT_OPERATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "产品运营方向课程";
  }
  if (DATA_AND_LITERACY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "数据与通识方向课程";
  }
  if (TECHNICAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "技术方向课程";
  }
  return fallback;
}

function isDeterministicCourseWorkbookSheetName(
  value: string | undefined,
): value is DeterministicCourseWorkbookSheetName {
  return DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.includes(value as DeterministicCourseWorkbookSheetName);
}

function resolveStructuredResultSheetName(
  result: DialogStructuredSubtaskResult,
): DeterministicCourseWorkbookSheetName {
  if (isDeterministicCourseWorkbookSheetName(result.deliveryTargetLabel)) {
    return result.deliveryTargetLabel;
  }
  if (isDeterministicCourseWorkbookSheetName(result.sheetName)) {
    return result.sheetName;
  }

  const explicitSheet = DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.find((sheetName) =>
    [result.deliveryTargetLabel, result.label, result.task].some((value) => normalizeWhitespace(value).includes(sheetName))
      || normalizeWhitespace(result.task).includes(`「${sheetName}」`)
      || normalizeWhitespace(result.task).includes(`"${sheetName}"`)
      || normalizeWhitespace(result.task).includes(`“${sheetName}”`),
  );
  if (explicitSheet) return explicitSheet;

  return inferSheetNameFromText(
    [result.label, result.task, result.progressSummary].filter(Boolean).join(" "),
  );
}

function isLikelyThemeTitle(title: string): boolean {
  const normalized = cleanThemeTitle(title);
  if (!normalized || normalized.length < 4 || normalized.length > 120) return false;
  if (THEME_EXCLUDE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (/```|\{|\}|\[|\]/.test(normalized)) return false;
  return /[\u4e00-\u9fa5A-Za-z]/.test(normalized);
}

export function extractDeterministicCourseThemes(text: string): DeterministicCourseTheme[] {
  const themes: DeterministicCourseTheme[] = [];
  const seen = new Set<string>();
  let currentSheetHint: DeterministicCourseWorkbookSheetName = "技术方向课程";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeWhitespace(rawLine);
    if (!line) continue;

    const headingSheet = inferSheetNameFromText(line, currentSheetHint);
    if (/方向|产品|运营|解决方案|数据|通识|赋能|开发|模型|算法/u.test(line)) {
      currentSheetHint = headingSheet;
    }

    const match = line.match(/^(\d{1,2})\s*[.、．]\s*(.+)$/u);
    if (!match) continue;

    const index = Number.parseInt(match[1] ?? "", 10);
    const title = cleanThemeTitle(match[2] ?? "");
    if (!isLikelyThemeTitle(title)) continue;

    const sheetName = inferSheetNameFromText(title, currentSheetHint);
    const key = `${Number.isFinite(index) ? index : "x"}::${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    themes.push({
      index: Number.isFinite(index) ? index : undefined,
      title,
      raw: line,
      sheetName,
    });
  }

  if (themes.length > 0) return themes;

  const inlinePattern = /(?:^|[\n\r\s])(\d{1,2})\s*[.、．]\s*([^\n\r]{4,120}?)(?=(?:\s+\d{1,2}\s*[.、．])|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = inlinePattern.exec(text)) !== null) {
    const index = Number.parseInt(match[1] ?? "", 10);
    const title = cleanThemeTitle(match[2] ?? "");
    if (!isLikelyThemeTitle(title)) continue;
    const sheetName = inferSheetNameFromText(title);
    const key = `${Number.isFinite(index) ? index : "x"}::${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    themes.push({
      index: Number.isFinite(index) ? index : undefined,
      title,
      raw: normalizeWhitespace(match[0]),
      sheetName,
    });
  }

  return themes;
}

function buildThemeLines(
  themes: readonly DeterministicCourseTheme[],
): string[] {
  return themes.map((theme, index) => {
    const prefix = typeof theme.index === "number" ? `${theme.index}.` : `${index + 1}.`;
    return `${prefix} ${theme.title}`;
  });
}

function buildCourseTargetPromptSpec(
  sheetName: DeterministicCourseWorkbookSheetName,
  themes: readonly DeterministicCourseTheme[],
): StructuredDeliveryPromptSpec {
  return {
    objective: `围绕以下主题，为「${sheetName}」工作表生成尽可能多的高质量课程候选。`,
    inputItemsLabel: `本组主题（${themes.length} 个）`,
    inputItems: buildThemeLines(themes),
    truthScopeNote: "不要重新读取附件、Excel 或其他文档；以下主题列表就是你当前唯一的输入真相。",
    constraints: [
      "课程名称不要直接照抄主题，需包装成可交付课程名；课程介绍需简洁说明定位、对象或收益。",
      "优先覆盖入门 / 进阶 / 实战多个层级，并尽量减少重复课程。",
      "不要把主题改分类到别的工作表。",
    ],
    outputExample: [
      { 课程名称: "示例课程", 课程介绍: "示例介绍" },
    ],
  };
}

function buildCourseTargetDispatchSpec(
  sheetName: DeterministicCourseWorkbookSheetName,
): StructuredDeliveryTargetDispatchSpec {
  return {
    label: `${sheetName}生成`,
    roleBoundary: "executor",
    createIfMissing: true,
    overrides: {
      executionIntent: "content_executor",
      resultContract: "inline_structured_result",
      deliveryTargetId: sheetName,
      deliveryTargetLabel: sheetName,
      sheetName,
    },
  };
}

function buildCourseShardTask(
  sheetName: DeterministicCourseWorkbookSheetName,
  themes: readonly DeterministicCourseTheme[],
): string {
  return buildInlineStructuredResultPrompt({
    target: {
      id: sheetName,
      label: sheetName,
      promptSpec: buildCourseTargetPromptSpec(sheetName, themes),
    },
    manifest: {
      source: "strategy",
      strategyId: "deterministic_course_workbook",
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      requiresSpreadsheetOutput: true,
      applyInitialIsolation: true,
      resultSchema: COURSE_WORKBOOK_RESULT_SCHEMA,
    },
  });
}

export function buildDeterministicCourseShardPlan(query: string): DeterministicCourseShardPlan | null {
  const themes = extractDeterministicCourseThemes(query);
  if (themes.length < 9) return null;

  const grouped = new Map<DeterministicCourseWorkbookSheetName, DeterministicCourseTheme[]>(
    DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.map((sheetName) => [sheetName, []]),
  );
  for (const theme of themes) {
    grouped.get(theme.sheetName)?.push(theme);
  }

  const shards = DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES
    .map((sheetName) => {
      const sheetThemes = grouped.get(sheetName) ?? [];
      if (sheetThemes.length === 0) return null;
      return {
        sheetName,
        label: `${sheetName}生成`,
        task: buildCourseShardTask(sheetName, sheetThemes),
        themes: sheetThemes,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  if (shards.length !== DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.length) {
    return null;
  }

  return {
    totalThemeCount: themes.length,
    shards,
  };
}

function extractStructuredJsonCandidate(value: string | undefined): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  const blockMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (blockMatch?.[1]?.trim()) return blockMatch[1].trim();
  if ((normalized.startsWith("{") && normalized.endsWith("}")) || (normalized.startsWith("[") && normalized.endsWith("]"))) {
    return normalized;
  }
  return undefined;
}

function tryParseStructuredPayload(value: string | undefined): unknown {
  const candidate = extractStructuredJsonCandidate(value);
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeWhitespace(typeof value === "string" || typeof value === "number" ? String(value) : undefined);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeCourseRow(value: unknown): { 课程名称: string; 课程介绍: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const courseName = firstNonEmptyString([
    record["课程名称"],
    record["课程名"],
    record["name"],
    record["title"],
    record["course_name"],
  ]);
  const courseIntro = firstNonEmptyString([
    record["课程介绍"],
    record["课程简介"],
    record["description"],
    record["summary"],
    record["course_intro"],
  ]);
  if (!courseName || !courseIntro) return null;
  return {
    课程名称: courseName,
    课程介绍: courseIntro,
  };
}

function extractCourseRowsFromPayload(payload: unknown, depth = 0): Array<{ 课程名称: string; 课程介绍: string }> {
  if (depth > 3 || payload == null) return [];
  if (Array.isArray(payload)) {
    const rows = payload
      .map((item) => normalizeCourseRow(item))
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (rows.length > 0) return rows;
    for (const item of payload) {
      const nestedRows = extractCourseRowsFromPayload(item, depth + 1);
      if (nestedRows.length > 0) return nestedRows;
    }
    return [];
  }
  if (typeof payload === "object") {
    for (const nested of Object.values(payload as Record<string, unknown>)) {
      const nestedRows = extractCourseRowsFromPayload(nested, depth + 1);
      if (nestedRows.length > 0) return nestedRows;
    }
  }
  return [];
}

function extractStructuredRowsFromResult(result: DialogStructuredSubtaskResult): Array<{ 课程名称: string; 课程介绍: string }> {
  return extractCourseRowsFromPayload(tryParseStructuredPayload(result.terminalResult));
}

function deriveWorkbookFileName(query: string): string {
  const pathMatch = query.match(/\/([^/\s"'`]+)\.(?:xlsx|xls|csv)\b/iu);
  let baseName = pathMatch?.[1] ?? "AI培训课程体系";
  baseName = baseName.replace(/(?:需求|清单|附件|模板)$/u, "体系");
  if (!/课程/u.test(baseName)) {
    baseName = `${baseName}_课程体系`;
  }
  return `${baseName}.xlsx`;
}

export function buildDeterministicCourseWorkbook(params: {
  taskText: string;
  structuredResults: readonly DialogStructuredSubtaskResult[];
}): DeterministicCourseWorkbookPlan | { blocker: string } {
  const sheetRows = new Map<DeterministicCourseWorkbookSheetName, Array<{ 课程名称: string; 课程介绍: string }>>(
    DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.map((sheetName) => [sheetName, []]),
  );
  const dedupeKeys = new Set<string>();

  for (const taskResult of params.structuredResults) {
    if (taskResult.status !== "completed") {
      return { blocker: `存在未完成的子任务（${taskResult.label ?? taskResult.task}），暂不能直接生成固定工作簿。` };
    }
    const rows = extractStructuredRowsFromResult(taskResult);
    if (rows.length === 0) continue;
    const sheetName = resolveStructuredResultSheetName(taskResult);
    for (const row of rows) {
      const dedupeKey = `${sheetName}::${row.课程名称}`.toLowerCase();
      if (dedupeKeys.has(dedupeKey)) continue;
      dedupeKeys.add(dedupeKey);
      sheetRows.get(sheetName)?.push(row);
    }
  }

  const sheetRowCounts = Object.fromEntries(
    DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.map((sheetName) => [sheetName, sheetRows.get(sheetName)?.length ?? 0]),
  ) as Record<DeterministicCourseWorkbookSheetName, number>;

  const missingSheets = DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.filter((sheetName) => sheetRowCounts[sheetName] === 0);
  if (missingSheets.length > 0) {
    return {
      blocker: `结构化结果未能覆盖固定工作簿要求，缺少 sheet：${missingSheets.join("、")}。`,
    };
  }

  const sheets = DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.map((sheetName) => ({
    name: sheetName,
    headers: [...DETERMINISTIC_COURSE_WORKBOOK_HEADERS],
    rows: (sheetRows.get(sheetName) ?? []).map((row) => [row.课程名称, row.课程介绍]),
  }));

  const totalRowCount = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  return {
    fileName: deriveWorkbookFileName(params.taskText),
    sheets,
    sheetRowCounts,
    totalRowCount,
  };
}

export function buildDeterministicCourseWorkbookReply(params: {
  exportPath: string;
  workbookPlan: DeterministicCourseWorkbookPlan;
  structuredTaskCount: number;
}): string {
  const countLines = DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES.map((sheetName) =>
    `- ${sheetName}：${params.workbookPlan.sheetRowCounts[sheetName]}门`,
  );

  return [
    "已完成课程工作簿的最终整合与交付。",
    "",
    `已导出 Excel 文件：${params.exportPath}`,
    `本轮已汇总 ${params.structuredTaskCount} 个子任务的结构化结果，共 ${params.workbookPlan.totalRowCount} 门课程。`,
    ...countLines,
  ].join("\n");
}

export const deterministicCourseWorkbookStrategy: StructuredDeliveryStrategy = {
  id: "deterministic_course_workbook",
  deliveryContract: "spreadsheet",
  parentContract: "single_workbook",
  matches(taskText: string): boolean {
    return matchesDeterministicCourseWorkbookTask(taskText);
  },
  buildManifest(taskText: string): Omit<StructuredDeliveryManifest, "strategy" | "source"> | null {
    const shardPlan = buildDeterministicCourseShardPlan(taskText);
    if (!shardPlan) return null;
    return {
      strategyId: "deterministic_course_workbook",
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      requiresSpreadsheetOutput: true,
      applyInitialIsolation: true,
      tracePreview: shardPlan.shards.map((shard) => shard.sheetName).join("、"),
      targets: shardPlan.shards.map((shard) => ({
        id: shard.sheetName,
        label: shard.sheetName,
        description: `${shard.sheetName} 课程聚合目标`,
        promptSpec: buildCourseTargetPromptSpec(shard.sheetName, shard.themes),
        dispatchSpec: buildCourseTargetDispatchSpec(shard.sheetName),
        metadata: {
          themeCount: shard.themes.length,
          themes: shard.themes.map((theme) => theme.title),
        },
      })),
      resultSchema: COURSE_WORKBOOK_RESULT_SCHEMA,
      exportSpec: {
        mode: "single_workbook",
        format: "spreadsheet",
        targetLabels: shardPlan.shards.map((shard) => shard.sheetName),
      },
    };
  },
  buildInitialDispatchPlan(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
  }): StructuredDeliveryDispatchPlan | null {
    return buildInlineStructuredDispatchPlanFromManifest({
      strategyId: "deterministic_course_workbook",
      manifest: params.manifest,
      defaultRoleBoundary: "executor",
      defaultCreateIfMissing: true,
      defaultOverrides: {
        executionIntent: "content_executor",
        resultContract: "inline_structured_result",
      },
      observationText: `已按 delivery targets 派发 ${(params.manifest.targets ?? []).length} 个结构化子任务，等待结果。`,
    });
  },
  buildDeliveryPlanBlock(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
    structuredResults: readonly DialogStructuredSubtaskResult[];
  }): string | undefined {
    if (!taskRequestsSpreadsheetOutput(params.taskText)) return undefined;
    const targetLabels = params.manifest.exportSpec?.targetLabels ?? DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES;
    const lines = [
      "## 系统锁定的最终交付计划",
      "- 你现在只能消费当前 run 的 structured child results 与当前 run artifacts。",
      "- 最终只允许交付一个 Excel 工作簿；禁止输出多个分散的 xlsx/csv/tsv 文件。",
      "- 禁止用 JSON / Markdown / TSV / 历史文件确认代替 Excel 成功交付。",
      `- 当前启用 single_workbook_mode，优先输出以下分组：${targetLabels.join("、")}。`,
      "- 若任一方向缺失，请明确 blocker，不要改成交付多个分散文件。",
    ];
    if (params.manifest.resultSchema?.fields?.length) {
      lines.push(`- 子任务结构化结果字段：${params.manifest.resultSchema.fields.map((field) => field.label).join("、")}。`);
    }
    if (params.structuredResults.length > 0) {
      lines.push(`- 当前可用 structured child results 数量：${params.structuredResults.length}。`);
    }
    return lines.join("\n");
  },
  buildHostExportPlan(params: {
    taskText: string;
    manifest: StructuredDeliveryManifest;
    structuredResults: readonly DialogStructuredSubtaskResult[];
  }): StructuredDeliveryHostExportPlan | { blocker: string } | null {
    const workbookPlan = buildDeterministicCourseWorkbook({
      taskText: params.taskText,
      structuredResults: params.structuredResults,
    });
    if ("blocker" in workbookPlan) {
      return { blocker: workbookPlan.blocker };
    }
    return {
      strategyId: "deterministic_course_workbook",
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      toolName: "export_spreadsheet",
      toolInput: {
        file_name: workbookPlan.fileName,
        sheets: workbookPlan.sheets,
      },
      expectedArtifactExtensions: ["xlsx", "xls"],
      tracePreview: `${workbookPlan.fileName} (${workbookPlan.totalRowCount} rows)`,
      targetPreview: (params.manifest.exportSpec?.targetLabels ?? workbookPlan.sheets.map((sheet) => sheet.name)).join("、"),
      operationCount: workbookPlan.sheets.length,
      successReply: buildDeterministicCourseWorkbookReply({
        exportPath: "__EXPORT_PATH__",
        workbookPlan,
        structuredTaskCount: params.structuredResults.length,
      }),
    };
  },
};
