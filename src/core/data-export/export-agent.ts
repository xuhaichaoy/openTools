import { invoke } from "@tauri-apps/api/core";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import { getResolvedAIConfigForMode } from "@/core/ai/resolved-ai-config-store";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import { createLogger } from "@/core/logger";
import { loadRuntimeExportCatalog } from "./runtime-catalog";
import { listLocalExportDatasets } from "./dataset-registry";
import {
  ReActAgent,
  type AgentTool,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import type {
  ExportAgentDecision,
  ExportSourceConfig,
  RuntimeExportDatasetDefinition,
  RuntimeExportSourceConfig,
  StructuredExportIntent,
} from "./types";

const log = createLogger("ExportAgent");

interface TableInfo {
  name: string;
  schema?: string;
  table_type?: string;
}

interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
}

function normalizeDecision(raw: unknown): ExportAgentDecision {
  if (!raw || typeof raw !== "object") {
    throw new Error("导出 Agent 未返回有效对象");
  }

  const result = raw as Record<string, unknown>;
  const kind = String(result.kind ?? "").trim();
  if (kind === "clarify") {
    const question = String(result.question ?? "").trim();
    if (!question) {
      throw new Error("导出 Agent 缺少澄清问题");
    }
    return { kind, question };
  }
  if (kind === "reject") {
    const reason = String(result.reason ?? "").trim() || "当前请求暂不支持自动导出。";
    return { kind, reason };
  }
  if (kind !== "intent") {
    throw new Error(`导出 Agent 返回了未知 kind: ${kind || "(empty)"}`);
  }

  const intent = result.intent as Record<string, unknown> | undefined;
  if (!intent) {
    throw new Error("导出 Agent 缺少 intent");
  }

  const sourceId = String(intent.sourceId ?? "").trim();
  const entityName = String(intent.entityName ?? "").trim();
  if (!sourceId || !entityName) {
    throw new Error("导出 Agent 返回的 intent 缺少 sourceId 或 entityName");
  }

  const normalizedIntent: StructuredExportIntent = {
    sourceId,
    ...(intent.sourceScope === "team" ? { sourceScope: "team" as const } : {}),
    ...(typeof intent.teamId === "string" && intent.teamId.trim()
      ? { teamId: intent.teamId.trim() }
      : {}),
    ...(typeof intent.datasetId === "string" && intent.datasetId.trim()
      ? { datasetId: intent.datasetId.trim() }
      : {}),
    entityName,
    ...(typeof intent.entityType === "string"
      ? { entityType: intent.entityType as StructuredExportIntent["entityType"] }
      : {}),
    ...(typeof intent.schema === "string" && intent.schema.trim()
      ? { schema: intent.schema.trim() }
      : {}),
    ...(Array.isArray(intent.fields)
      ? {
          fields: intent.fields
            .map((item) => String(item ?? "").trim())
            .filter(Boolean),
        }
      : {}),
    ...(Array.isArray(intent.filters)
      ? {
          filters: intent.filters
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              const rawFilter = item as Record<string, unknown>;
              return {
                field: String(rawFilter.field ?? "").trim(),
                op: String(rawFilter.op ?? "eq").trim(),
                value: rawFilter.value ?? null,
              };
            })
            .filter((item) => item.field),
        }
      : {}),
    ...(Array.isArray(intent.sort)
      ? {
          sort: intent.sort
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              const rawSort = item as Record<string, unknown>;
              return {
                field: String(rawSort.field ?? "").trim(),
                direction:
                  String(rawSort.direction ?? "asc").trim().toLowerCase() === "desc"
                    ? "desc"
                    : "asc",
              } as const;
            })
            .filter((item) => item.field),
        }
      : {}),
    ...(typeof intent.limit === "number" && Number.isFinite(intent.limit) && intent.limit > 0
      ? { limit: Math.floor(intent.limit) }
      : {}),
    outputFormat: "csv",
  };

  return {
    kind,
    intent: normalizedIntent,
    ...(typeof result.summary === "string" && result.summary.trim()
      ? { summary: result.summary.trim() }
      : {}),
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("导出 Agent 返回为空");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("导出 Agent 返回不是有效 JSON");
  }
}

export async function loadExportSources(): Promise<ExportSourceConfig[]> {
  const allSources = await invoke<ExportSourceConfig[]>("db_load_connections");
  const explicitlyEnabled = allSources.filter((item) => item.export_enabled === true);
  return explicitlyEnabled.length > 0
    ? explicitlyEnabled
    : allSources.filter((item) => item.db_type === "postgres" || item.db_type === "mysql" || item.db_type === "mongodb" || item.db_type === "sqlite");
}

export async function ensureExportSourceConnected(source: ExportSourceConfig): Promise<void> {
  await invoke("db_connect", { config: source });
}

function createExportTools(
  sources: RuntimeExportSourceConfig[],
  datasets: RuntimeExportDatasetDefinition[],
): AgentTool[] {
  const getSource = (sourceId: string): RuntimeExportSourceConfig => {
    const source = sources.find((item) => item.id === sourceId);
    if (!source) {
      throw new Error(`未知数据源: ${sourceId}`);
    }
    return source;
  };

  return [
    {
      name: "list_export_datasets",
      description: "列出已经整理好的本地导出数据集，优先使用这些数据集理解业务请求。",
      readonly: true,
      execute: async () => ({
        datasets: datasets.map((dataset) => ({
          id: dataset.id,
          scope: dataset.scope,
          ...(dataset.scope === "team" ? { teamId: dataset.teamId } : {}),
          displayName: dataset.displayName,
          description: dataset.description,
          sourceId: dataset.sourceId,
          entityName: dataset.entityName,
          entityType: dataset.entityType,
          schema: dataset.schema,
          timeField: dataset.timeField,
          defaultFields: dataset.defaultFields,
          enabled: dataset.enabled,
        })),
      }),
    },
    {
      name: "describe_export_dataset",
      description: "查看一个本地导出数据集的字段、别名和底层映射。",
      readonly: true,
      parameters: {
        dataset_id: { type: "string", description: "数据集 ID" },
      },
      execute: async (params) => {
        const datasetId = String(params.dataset_id ?? "").trim();
        if (!datasetId) return { error: "dataset_id 不能为空" };
        const dataset = datasets.find((item) => item.id === datasetId);
        if (!dataset) return { error: `未知数据集: ${datasetId}` };
        return {
          dataset: {
            id: dataset.id,
            scope: dataset.scope,
            ...(dataset.scope === "team" ? { teamId: dataset.teamId } : {}),
            displayName: dataset.displayName,
            description: dataset.description,
            sourceId: dataset.sourceId,
            entityName: dataset.entityName,
            entityType: dataset.entityType,
            schema: dataset.schema,
            timeField: dataset.timeField,
            defaultFields: dataset.defaultFields,
            fields: dataset.fields,
          },
        };
      },
    },
    {
      name: "list_export_sources",
      description: "列出当前可用于自然语言导出的数据源。",
      readonly: true,
      execute: async () => ({
        sources: sources.map((source) => ({
          id: source.id,
          scope: source.scope,
          executionTarget: source.executionTarget,
          ...(source.scope === "team" ? { teamId: source.teamId } : {}),
          name: source.name,
          dbType: source.db_type,
          alias: source.export_alias,
          defaultSchema: source.export_default_schema,
          database: source.database,
        })),
      }),
    },
    {
      name: "list_export_tables",
      description: "列出某个数据源中的表、视图或 collection。",
      readonly: true,
      parameters: {
        source_id: { type: "string", description: "数据源 ID" },
        schema: { type: "string", description: "可选 schema 名", required: false },
      },
      execute: async (params) => {
        const sourceId = String(params.source_id ?? "").trim();
        if (!sourceId) return { error: "source_id 不能为空" };
        const source = getSource(sourceId);
        if (source.scope === "team") {
          return { error: "团队共享数据源不直接开放原始表结构浏览，请优先使用已发布数据集。" };
        }
        await ensureExportSourceConnected(source);
        const schema = String(params.schema ?? "").trim();
        const tables = await invoke<TableInfo[]>("db_list_tables", {
          connId: sourceId,
          schema: schema || null,
        });
        return { tables };
      },
    },
    {
      name: "describe_export_table",
      description: "查看某张表、视图或 collection 的字段结构。",
      readonly: true,
      parameters: {
        source_id: { type: "string", description: "数据源 ID" },
        table: { type: "string", description: "表名、视图名或 collection 名" },
      },
      execute: async (params) => {
        const sourceId = String(params.source_id ?? "").trim();
        const table = String(params.table ?? "").trim();
        if (!sourceId || !table) {
          return { error: "source_id 和 table 都不能为空" };
        }
        const source = getSource(sourceId);
        if (source.scope === "team") {
          return { error: "团队共享数据源不直接开放原始字段探查，请优先使用已发布数据集。" };
        }
        await ensureExportSourceConnected(source);
        const columns = await invoke<ColumnInfo[]>("db_describe_table", {
          connId: sourceId,
          table,
        });
        return { columns };
      },
    },
  ];
}

function buildExportPrompt(params: {
  userInput: string;
  sources: RuntimeExportSourceConfig[];
  datasets: RuntimeExportDatasetDefinition[];
  originalRequest?: string;
}): string {
  const sourceSummary = params.sources
    .map((source) => {
      const parts = [
        source.scope === "team" ? `[团队${source.teamId ? `:${source.teamId}` : ""}]` : "[个人]",
        source.name,
        source.export_alias ? `alias=${source.export_alias}` : "",
        source.database ? `database=${source.database}` : "",
        source.export_default_schema ? `defaultSchema=${source.export_default_schema}` : "",
        source.executionTarget === "team_service" ? "execution=team_service" : "execution=local",
        `type=${source.db_type}`,
      ].filter(Boolean);
      return `- ${parts.join(", ")}`;
    })
    .join("\n");
  const datasetSummary = params.datasets
    .filter((dataset) => dataset.enabled !== false)
    .map((dataset) => {
      const defaultFields = dataset.defaultFields.length
        ? `defaultFields=${dataset.defaultFields.join("|")}`
        : "";
      const fieldNames = dataset.fields
        .filter((field) => field.enabled !== false)
        .map((field) => field.name)
        .slice(0, 8)
        .join("|");
      const scopeLabel = dataset.scope === "team" ? `[团队:${dataset.teamId}]` : "[个人]";
      return `- ${scopeLabel} ${dataset.displayName} -> ${dataset.sourceId}:${dataset.schema ? `${dataset.schema}.` : ""}${dataset.entityName} (${dataset.entityType}) ${defaultFields} ${fieldNames ? `fields=${fieldNames}` : ""} ${dataset.description}`.trim();
    })
    .join("\n");

  return [
    "你是一个钉钉数据导出专员，只负责把自然语言请求整理成安全的导出意图。",
    "你必须先通过工具查看可用数据源、已发布数据集和表结构，再决定导出意图；禁止臆造表名、字段名、schema。",
    "当前能力边界：",
    "- 只输出 CSV 导出意图。",
    "- 优先使用已经整理好的数据集理解业务请求，尤其是团队已发布数据集。",
    "- 优先单表明细导出，不做复杂 join 规划。",
    "- 团队共享数据源不允许直接浏览原始表结构时，只能基于已发布数据集做导出判断。",
    "- 如果信息不足，只提一个最关键的问题。",
    "- 如果请求明显超出当前已知 schema，请直接 reject。",
    "你的最终回答必须是严格 JSON，且只能是以下三种之一：",
    '{"kind":"clarify","question":"..."}',
    '{"kind":"reject","reason":"..."}',
    '{"kind":"intent","summary":"...","intent":{"sourceId":"...","sourceScope":"personal|team","teamId":"...","datasetId":"...","entityName":"...","entityType":"table|view|collection","schema":"...","fields":["..."],"filters":[{"field":"...","op":"eq|gt|gte|lt|lte|like|contains|in","value":"..."}],"sort":[{"field":"...","direction":"asc|desc"}],"limit":1000,"outputFormat":"csv"}}',
    "可用数据源：",
    sourceSummary || "- 无",
    "可用数据集：",
    datasetSummary || "- 无",
    params.originalRequest?.trim()
      ? `原始请求：${params.originalRequest.trim()}`
      : "",
    `当前用户消息：${params.userInput.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runExportAgent(params: {
  userInput: string;
  originalRequest?: string;
}): Promise<ExportAgentDecision> {
  const { sources, datasets } = await loadRuntimeExportCatalog();
  if (sources.length === 0 && datasets.length === 0) {
    return {
      kind: "reject",
      reason: "当前还没有可用的数据源或已发布数据集，请先在数据库客户端配置个人数据源，或在团队里发布可导出的数据集。",
    };
  }

  const ai = getMToolsAI("agent");
  const aiConfig = getResolvedAIConfigForMode("agent");
  const agent = new ReActAgent(
    ai,
    createExportTools(sources, datasets),
    {
      maxIterations: 8,
      temperature: 0.1,
      verbose: true,
      fcCompatibilityKey: buildAgentFCCompatibilityKey(aiConfig),
      extraSystemPrompt: "你现在运行在 IM 导出专线中，最终回答必须是 JSON，不要输出 markdown、解释或代码块。",
    },
    () => {},
  );

  const answer = await agent.run(
    buildExportPrompt({
      userInput: params.userInput,
      sources,
      datasets,
      originalRequest: params.originalRequest,
    }),
  );

  log.info("Export agent answer", { answer: answer.slice(0, 500) });
  return normalizeDecision(extractJsonObject(answer));
}
