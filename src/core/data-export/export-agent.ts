import { invoke } from "@tauri-apps/api/core";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import { getResolvedAIConfigForMode } from "@/core/ai/resolved-ai-config-store";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import { createLogger } from "@/core/logger";
import {
  ReActAgent,
  type AgentTool,
} from "@/plugins/builtin/SmartAgent/core/react-agent";
import type {
  ExportAgentDecision,
  ExportSourceConfig,
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

function createExportTools(sources: ExportSourceConfig[]): AgentTool[] {
  const getSource = (sourceId: string): ExportSourceConfig => {
    const source = sources.find((item) => item.id === sourceId);
    if (!source) {
      throw new Error(`未知数据源: ${sourceId}`);
    }
    return source;
  };

  return [
    {
      name: "list_export_sources",
      description: "列出当前可用于自然语言导出的数据源。",
      readonly: true,
      execute: async () => ({
        sources: sources.map((source) => ({
          id: source.id,
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
  sources: ExportSourceConfig[];
  originalRequest?: string;
}): string {
  const sourceSummary = params.sources
    .map((source) => {
      const parts = [
        source.name,
        source.export_alias ? `alias=${source.export_alias}` : "",
        source.database ? `database=${source.database}` : "",
        source.export_default_schema ? `defaultSchema=${source.export_default_schema}` : "",
        `type=${source.db_type}`,
      ].filter(Boolean);
      return `- ${parts.join(", ")}`;
    })
    .join("\n");

  return [
    "你是一个钉钉数据导出专员，只负责把自然语言请求整理成安全的导出意图。",
    "你必须先通过工具查看可用数据源以及表结构，再决定导出意图；禁止臆造表名、字段名、schema。",
    "当前能力边界：",
    "- 只输出 CSV 导出意图。",
    "- 优先单表明细导出，不做复杂 join 规划。",
    "- 如果信息不足，只提一个最关键的问题。",
    "- 如果请求明显超出当前已知 schema，请直接 reject。",
    "你的最终回答必须是严格 JSON，且只能是以下三种之一：",
    '{"kind":"clarify","question":"..."}',
    '{"kind":"reject","reason":"..."}',
    '{"kind":"intent","summary":"...","intent":{"sourceId":"...","entityName":"...","entityType":"table|view|collection","schema":"...","fields":["..."],"filters":[{"field":"...","op":"eq|gt|gte|lt|lte|like|contains|in","value":"..."}],"sort":[{"field":"...","direction":"asc|desc"}],"limit":1000,"outputFormat":"csv"}}',
    "可用数据源：",
    sourceSummary || "- 无",
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
  const sources = await loadExportSources();
  if (sources.length === 0) {
    return {
      kind: "reject",
      reason: "当前还没有可用的数据源配置，请先在数据库客户端里配置一个可连接的数据源。",
    };
  }

  const ai = getMToolsAI("agent");
  const aiConfig = getResolvedAIConfigForMode("agent");
  const agent = new ReActAgent(
    ai,
    createExportTools(sources),
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
      originalRequest: params.originalRequest,
    }),
  );

  log.info("Export agent answer", { answer: answer.slice(0, 500) });
  return normalizeDecision(extractJsonObject(answer));
}
