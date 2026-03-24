import { invoke } from "@tauri-apps/api/core";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import { getResolvedAIConfigForMode } from "@/core/ai/resolved-ai-config-store";
import { buildAgentFCCompatibilityKey } from "@/core/agent/fc-compatibility";
import { createLogger } from "@/core/logger";
import { useDatabaseStore } from "@/store/database-store";
import { loadRuntimeExportCatalog } from "./runtime-catalog";
import { parseDatabaseProtocolDirective, type DatabaseProtocolDirective } from "./db-protocol";
import {
  isExportMetadataQuestion,
  parseExportAgentResponse,
} from "./export-agent-response";
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

interface TableSearchResult {
  name: string;
  schema?: string;
  table_type?: string;
  matched_columns?: string[];
}

interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
}

interface SampleTableResult {
  columns: string[];
  rows: unknown[][];
  affected: number;
  elapsed_ms: number;
}

function uniqueNormalizedStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function expandBusinessSearchKeywords(keyword: string): string[] {
  const normalized = String(keyword ?? "").trim();
  if (!normalized) return [];

  const lower = normalized.toLowerCase();
  const expanded: string[] = [normalized];

  if (/(公司|企业|商户|客户)/u.test(normalized) || /(company|enterprise|merchant|corp|business|customer|client)/u.test(lower)) {
    expanded.push("company", "enterprise", "corp", "business", "merchant", "customer", "client", "compname", "corp_id", "bus_name");
  }

  if (/(联系人|电话|手机|手机号)/u.test(normalized) || /(contact|phone|mobile|tel)/u.test(lower)) {
    expanded.push("contact", "phone", "mobile", "tel", "user", "customer", "member");
  }

  if (/(用户|会员|账号)/u.test(normalized) || /(user|member|account|uid)/u.test(lower)) {
    expanded.push("user", "member", "account", "customer", "mobile");
  }

  if (/(订单|支付|退款|交易|商品)/u.test(normalized) || /(order|payment|refund|trade|item|goods)/u.test(lower)) {
    expanded.push("order", "payment", "refund", "trade", "item", "goods");
  }

  return uniqueNormalizedStrings(expanded).slice(0, 12);
}

export function mergeTableSearchResults(results: readonly TableSearchResult[]): TableSearchResult[] {
  const merged = new Map<string, TableSearchResult>();
  for (const item of results) {
    const name = String(item.name ?? "").trim();
    if (!name) continue;
    const schema = String(item.schema ?? "").trim();
    const key = `${schema.toLowerCase()}::${name.toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...item,
        ...(item.matched_columns?.length
          ? { matched_columns: uniqueNormalizedStrings(item.matched_columns) }
          : {}),
      });
      continue;
    }
    merged.set(key, {
      ...existing,
      matched_columns: uniqueNormalizedStrings([
        ...(existing.matched_columns ?? []),
        ...(item.matched_columns ?? []),
      ]),
    });
  }
  return [...merged.values()];
}

type ExportMetadataQuestionKind = "sources" | "namespaces" | "generic";

type DeterministicBusinessKind = "company";
type DeterministicCompanyFacet = "base" | "contact" | "order" | "promotion";

interface TableMetadataCandidate {
  source: RuntimeExportSourceConfig;
  table: TableSearchResult;
  qualifiedName: string;
  columns: ColumnInfo[];
}

interface ExplicitTableInspectionRequest {
  schemaCandidates: string[];
  tableCandidates: string[];
}

const SEMANTIC_TABLE_ALIASES: Record<string, string[]> = {
  company: ["企业", "公司", "企业表", "公司表", "商户", "客户"],
  company_user: ["企业用户", "公司用户", "企业成员", "企业账号", "公司成员"],
  user: ["用户", "用户表"],
  department: ["部门", "部门表"],
  department_member: ["部门成员", "成员表"],
  company_rights: ["企业权益", "权益"],
  company_package: ["企业套餐", "套餐"],
  company_source: ["企业来源", "来源"],
};

const COMPANY_NAME_FIELD_CANDIDATES = [
  "bus_name",
  "compname",
  "company_name",
  "company",
  "corp_name",
  "corporation_name",
  "enterprise_name",
  "merchant_name",
  "customer_name",
  "client_name",
  "shop_name",
  "organization_name",
  "org_name",
  "name",
];

const COMPANY_ID_FIELD_CANDIDATES = [
  "company_id",
  "corp_id",
  "bus_id",
  "business_id",
  "enterprise_id",
  "merchant_id",
  "customer_id",
  "client_id",
  "org_id",
  "organization_id",
  "id",
];

const COMPANY_FOREIGN_KEY_CANDIDATES = COMPANY_ID_FIELD_CANDIDATES.filter((field) => field !== "id");
const CONTACT_NAME_FIELD_CANDIDATES = ["contact_name", "linkman", "real_name", "username", "user_name", "nickname"];
const CONTACT_NAME_FIELD_PARTIAL_CANDIDATES = ["contact", "linkman", "real_name", "username", "user_name", "nickname"];
const MOBILE_FIELD_CANDIDATES = ["mobile", "mobile_phone", "phone_mobile", "phone_num", "phone_number", "tel_mobile"];
const PHONE_FIELD_CANDIDATES = ["phone", "telephone", "tel", "contact_phone", "landline"];
const STATUS_FIELD_CANDIDATES = ["status", "state", "company_status", "bus_status"];
const INDUSTRY_FIELD_CANDIDATES = ["industry", "industry_name", "trade", "business_type"];
const REGION_FIELD_CANDIDATES = ["province", "city", "region", "district", "area"];
const TIME_FIELD_CANDIDATES = ["updated_at", "update_time", "modified_at", "modify_time", "created_at", "create_time", "gmt_create", "ctime"];
const ORDER_NO_FIELD_CANDIDATES = ["order_no", "order_num", "order_sn", "trade_no", "pay_no"];
const ORDER_STATUS_FIELD_CANDIDATES = ["order_status", "pay_status", "status", "trade_status", "refund_status"];
const ORDER_STATUS_STRICT_CANDIDATES = ["order_status", "pay_status", "trade_status", "refund_status"];
const ORDER_AMOUNT_FIELD_CANDIDATES = ["pay_amount", "amount", "order_amount", "total_amount", "real_amount", "refund_amount"];
const CHANNEL_FIELD_CANDIDATES = ["channel", "channel_name", "source", "source_name", "utm_source"];
const SALES_FIELD_CANDIDATES = ["sales_name", "consultant_name", "owner_name", "bd_name", "advisor_name", "service_name"];

function normalizeLower(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function includesAnyToken(value: string, tokens: readonly string[]): boolean {
  const normalized = normalizeLower(value);
  return tokens.some((token) => normalized.includes(normalizeLower(token)));
}

function buildQualifiedTableName(table: Pick<TableSearchResult, "schema" | "name">): string {
  const schema = String(table.schema ?? "").trim();
  const name = String(table.name ?? "").trim();
  return schema ? `${schema}.${name}` : name;
}

function compactWhitespace(value: string): string {
  return String(value ?? "").replace(/\s+/gu, "");
}

function normalizeIdentifierCandidates(value: string): string[] {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return [];
  return uniqueNormalizedStrings([
    trimmed,
    trimmed.replace(/-/g, "_"),
    trimmed.replace(/_/g, "-"),
  ]).filter(Boolean);
}

function looksLikeExplicitTableInspectionRequest(text: string): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  if (/\b[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/.test(normalized)) return true;
  if (/^(?:看一下|看下|看看|查看|看一眼|瞅一下)/iu.test(normalized)) return true;
  return [
    /(?:表|table|字段|结构|schema)/iu,
    /(?:企业|公司|用户|部门|权益|套餐|来源|describe|desc)/iu,
  ].every((pattern) => pattern.test(normalized)) || [
    /(?:表|table|字段|结构|schema)/iu,
    /(?:企业|公司|用户|部门|权益|套餐|来源|activity)/iu,
  ].every((pattern) => pattern.test(normalized));
}

function normalizeSemanticInspectionSubject(text: string): string | null {
  const normalized = String(text ?? "").trim();
  if (!normalized) return null;
  const stripped = normalized
    .replace(/^(?:看一下|看下|看看|查看|看一眼|瞅一下)\s*/iu, "")
    .replace(/^(?:给我看下|给我看一下)\s*/iu, "")
    .replace(/\s*(?:这个|这张|该)?(?:表|table|字段|结构|schema)\s*$/iu, "")
    .replace(/\s*(?:的)?(?:字段|结构)\s*$/iu, "")
    .trim();
  return stripped || null;
}

function scoreSemanticTableAliasMatch(tableName: string, subject: string): number {
  const normalizedTable = normalizeLower(tableName);
  const normalizedSubject = normalizeLower(subject);
  if (!normalizedSubject) return -1;
  let score = -1;

  if (normalizeIdentifierCandidates(tableName).some((item) => normalizeLower(item) === normalizedSubject)) {
    score = Math.max(score, 100);
  }
  if (normalizedTable.includes(normalizedSubject) || normalizedSubject.includes(normalizedTable)) {
    score = Math.max(score, 70);
  }

  const aliases = SEMANTIC_TABLE_ALIASES[normalizedTable] ?? [];
  for (const alias of aliases) {
    const normalizedAlias = normalizeLower(alias);
    if (normalizedAlias === normalizedSubject) {
      score = Math.max(score, 95);
    } else if (normalizedSubject.includes(normalizedAlias) || normalizedAlias.includes(normalizedSubject)) {
      score = Math.max(score, 80);
    }
  }

  if (normalizedSubject === "企业" || normalizedSubject === "公司") {
    if (normalizedTable === "company") score = Math.max(score, 98);
    if (normalizedTable.startsWith("company_")) score = Math.max(score, 40);
  }

  return score;
}

async function inspectResolvedTable(params: {
  source: RuntimeExportSourceConfig;
  qualifiedName: string;
  displayQualifiedName?: string;
}): Promise<ExportAgentDecision | null> {
  const { source, qualifiedName } = params;
  const displayQualifiedName = params.displayQualifiedName ?? qualifiedName;
  const databaseState = useDatabaseStore.getState();
  const cachedColumns = databaseState.tableColumns[qualifiedName];

  const columns = cachedColumns?.length
    ? cachedColumns
    : await invoke<ColumnInfo[]>("db_describe_table", {
      connId: source.id,
      table: qualifiedName,
    });
  if (!columns.length) {
    return null;
  }

  let sample: SampleTableResult | null = null;
  try {
    sample = await invoke<SampleTableResult>("db_sample_table", {
      connId: source.id,
      table: qualifiedName,
      limit: 3,
    });
  } catch (error) {
    log.warn("Failed to sample inspected table", {
      sourceId: source.id,
      qualifiedName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    kind: "answer",
    answer: buildTableInspectionAnswer({
      qualifiedName: displayQualifiedName,
      source,
      columns,
      sample,
    }),
  };
}

async function resolveSemanticTableInspectionFromCurrentContext(params: {
  userInput: string;
  sources: RuntimeExportSourceConfig[];
}): Promise<ExportAgentDecision | null> {
  const normalized = String(params.userInput ?? "").trim();
  if (!looksLikeExplicitTableInspectionRequest(normalized)) {
    return null;
  }

  const subject = normalizeSemanticInspectionSubject(normalized);
  if (!subject) {
    return null;
  }
  if (/[._-]/.test(subject) || /[a-z0-9]{2,}/iu.test(subject)) {
    return null;
  }

  const databaseState = useDatabaseStore.getState();
  const context = databaseState.databaseClientContext;
  if (!context.connectionId || !databaseState.tables.length) {
    return null;
  }

  const source = params.sources.find((item) =>
    isPersonalSqlSource(item)
    && (item.id === context.connectionId || item.originSourceId === context.connectionId),
  );
  if (!source) {
    return null;
  }

  const scopedTables = context.schema
    ? databaseState.tables.filter((table) => String(table.schema ?? "").trim() === context.schema)
    : databaseState.tables;

  const ranked = scopedTables
    .map((table) => ({
      table,
      score: scoreSemanticTableAliasMatch(table.name, subject),
    }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || left.table.name.localeCompare(right.table.name));

  const best = ranked[0];
  if (!best || best.score < 70) {
    return null;
  }

  const qualifiedName = buildQualifiedTableName({
    name: best.table.name,
    schema: best.table.schema ?? context.schema ?? undefined,
  });
  await ensureExportSourceConnected(source);
  return inspectResolvedTable({
    source,
    qualifiedName,
  });
}

function parseExplicitTableInspectionRequest(text: string): ExplicitTableInspectionRequest | null {
  const normalized = String(text ?? "").trim();
  if (!looksLikeExplicitTableInspectionRequest(normalized)) {
    return null;
  }

  const dotted = normalized.match(/\b([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\b/u);
  const schemaCandidates = new Set<string>();
  const tableCandidates = new Set<string>();

  if (dotted) {
    normalizeIdentifierCandidates(dotted[1]).forEach((value) => schemaCandidates.add(value));
    normalizeIdentifierCandidates(dotted[2]).forEach((value) => tableCandidates.add(value));
  }

  const schemaMatch = normalized.match(/([a-zA-Z0-9_-]+)\s*这个(?:库|schema|database)/iu);
  if (schemaMatch?.[1]) {
    normalizeIdentifierCandidates(schemaMatch[1]).forEach((value) => schemaCandidates.add(value));
  }

  const tableMatch = normalized.match(/([a-zA-Z0-9_-]+)\s*这个(?:表|table|view|collection)/iu);
  if (tableMatch?.[1]) {
    normalizeIdentifierCandidates(tableMatch[1]).forEach((value) => tableCandidates.add(value));
  }

  if (tableCandidates.size === 0) {
    const looseTable = normalized.match(/\b([a-zA-Z][a-zA-Z0-9_-]{1,63})\b/u);
    if (looseTable?.[1]) {
      normalizeIdentifierCandidates(looseTable[1]).forEach((value) => tableCandidates.add(value));
    }
  }

  if (tableCandidates.size === 0) {
    return null;
  }

  return {
    schemaCandidates: [...schemaCandidates],
    tableCandidates: [...tableCandidates],
  };
}

function normalizeEntityType(tableType?: string): StructuredExportIntent["entityType"] {
  const normalized = normalizeLower(tableType);
  if (normalized.includes("view")) return "view";
  if (normalized.includes("collection")) return "collection";
  return "table";
}

function stringifySampleValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildTableInspectionAnswer(params: {
  qualifiedName: string;
  source: RuntimeExportSourceConfig;
  columns: ColumnInfo[];
  sample?: SampleTableResult | null;
}): string {
  const fieldSummary = params.columns
    .slice(0, 20)
    .map((column) => {
      const tags = [
        column.primary_key ? "主键" : "",
        column.nullable ? "可空" : "非空",
      ].filter(Boolean);
      return tags.length > 0
        ? `${column.name}（${column.data_type}${tags.length ? ` / ${tags.join(" / ")}` : ""}）`
        : `${column.name}（${column.data_type}）`;
    })
    .join("、");

  const sampleRows = (params.sample?.rows ?? [])
    .slice(0, 3)
    .map((row, index) => {
      const rendered = params.sample?.columns.map((column, columnIndex) => {
        const cell = Array.isArray(row) ? row[columnIndex] : undefined;
        return `${column}=${stringifySampleValue(cell)}`;
      }) ?? [];
      return `${index + 1}. ${rendered.join("；")}`;
    });

  return [
    `已定位到表 ${params.qualifiedName}（数据源：${params.source.name}）。`,
    fieldSummary ? `字段：${fieldSummary}` : "当前没有读取到字段定义。",
    params.sample
      ? params.sample.rows.length > 0
        ? "样本数据："
        : "当前样本为空，可能是空表，或当前条件下没有可读数据。"
      : "",
    ...sampleRows,
    "如果你接下来想按条件查询这张表，可以继续告诉我筛选条件；如果要导出，再明确说“导出这张表的数据”。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function inspectQualifiedTableAcrossSources(params: {
  sources: RuntimeExportSourceConfig[];
  request: ExplicitTableInspectionRequest;
}): Promise<ExportAgentDecision | null> {
  for (const source of params.sources.filter(isPersonalSqlSource)) {
    try {
      await ensureExportSourceConnected(source);
      const schemaCandidates = params.request.schemaCandidates.length > 0
        ? params.request.schemaCandidates
        : [""];
      for (const schema of schemaCandidates) {
        for (const table of params.request.tableCandidates) {
          const qualifiedName = schema ? `${schema}.${table}` : table;
          try {
            const answer = await inspectResolvedTable({
              source,
              qualifiedName,
            });
            if (answer) return answer;
          } catch {
            continue;
          }
        }
      }

      if (params.request.schemaCandidates.length === 0) {
        for (const tableKeyword of params.request.tableCandidates) {
          const matches = await invoke<TableSearchResult[]>("db_search_tables", {
            connId: source.id,
            keyword: tableKeyword,
            schema: null,
            limit: 12,
          });
          const exactMatch = matches.find((item) =>
            normalizeIdentifierCandidates(item.name).includes(tableKeyword),
          ) ?? matches.find((item) => normalizeLower(item.name) === normalizeLower(tableKeyword));
          if (!exactMatch) continue;
          const qualifiedName = buildQualifiedTableName(exactMatch);
          const answer = await inspectResolvedTable({
            source,
            qualifiedName,
          });
          if (answer) return answer;
        }
      }
    } catch (error) {
      log.warn("Failed to inspect explicit table reference", {
        sourceId: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const schemaHint = params.request.schemaCandidates[0]?.trim();
  const tableHint = params.request.tableCandidates[0]?.trim();
  const displayTarget = schemaHint ? `${schemaHint}.${tableHint ?? ""}` : (tableHint || "目标表");
  return {
    kind: "answer",
    answer: `暂时没有在当前个人数据源里定位到 ${displayTarget}。你可以继续发更准确的库名/表名，或者先问“目前有哪些库/表可以查”。`,
  };
}

function isPersonalSqlSource(source: RuntimeExportSourceConfig): source is RuntimeExportSourceConfig & { scope: "personal" } {
  return source.scope === "personal" && source.db_type !== "mongodb";
}

function findPreferredColumn(
  columns: readonly ColumnInfo[],
  exactCandidates: readonly string[],
  partialCandidates: readonly string[] = exactCandidates,
): string | null {
  const normalized = columns.map((column) => ({
    raw: column.name,
    lower: normalizeLower(column.name),
  }));

  for (const candidate of exactCandidates) {
    const matched = normalized.find((item) => item.lower === normalizeLower(candidate));
    if (matched) return matched.raw;
  }

  for (const candidate of partialCandidates) {
    const matched = normalized.find((item) => item.lower.includes(normalizeLower(candidate)));
    if (matched) return matched.raw;
  }

  return null;
}

function collectIdLikeColumns(columns: readonly ColumnInfo[]): string[] {
  return uniqueNormalizedStrings(
    columns
      .map((column) => String(column.name ?? "").trim())
      .filter((name) => {
        const lower = normalizeLower(name);
        return lower === "id"
          || lower.endsWith("_id")
          || COMPANY_ID_FIELD_CANDIDATES.some((candidate) => lower.includes(candidate));
      }),
  );
}

function buildFieldRef(alias: string, column: string): string {
  return `${alias}.${column}`;
}

function addSelectedField(
  fields: Array<{ field: string; alias: string }>,
  field: string | null,
  alias: string,
  tableAlias: string,
): void {
  const column = String(field ?? "").trim();
  if (!column) return;
  const fieldRef = buildFieldRef(tableAlias, column);
  if (fields.some((item) => item.field === fieldRef || item.alias === alias)) return;
  fields.push({ field: fieldRef, alias });
}

async function resolveDatabaseClientContextCandidate(
  sources: RuntimeExportSourceConfig[],
): Promise<TableMetadataCandidate | null> {
  const databaseState = useDatabaseStore.getState();
  const context = databaseState.databaseClientContext;
  if (!context.connectionId || !context.tableName) {
    return null;
  }

  const source = sources.find((item) =>
    isPersonalSqlSource(item)
    && (item.id === context.connectionId || item.originSourceId === context.connectionId),
  );
  if (!source) {
    return null;
  }

  const qualifiedName = context.schema ? `${context.schema}.${context.tableName}` : context.tableName;
  const cachedColumns = context.tableKey
    ? databaseState.tableColumns[context.tableKey]
    : undefined;

  try {
    await ensureExportSourceConnected(source);
    const columns = cachedColumns?.length
      ? cachedColumns
      : await invoke<ColumnInfo[]>("db_describe_table", {
        connId: source.id,
        table: qualifiedName,
      });
    if (!columns.length) {
      return null;
    }
    return {
      source,
      table: {
        name: context.tableName,
        ...(context.schema ? { schema: context.schema } : {}),
      },
      qualifiedName,
      columns,
    };
  } catch (error) {
    log.warn("Failed to resolve database client context candidate", {
      sourceId: source.id,
      qualifiedName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function detectDeterministicBusinessKind(text: string): DeterministicBusinessKind | null {
  const normalized = String(text ?? "").trim();
  if (!normalized) return null;
  if (/(公司|企业|商户|客户|client|company|enterprise|merchant|corp|business)/iu.test(normalized)) {
    return "company";
  }
  return null;
}

function detectCompanyFacet(text: string): DeterministicCompanyFacet {
  const normalized = String(text ?? "").trim();
  if (/(联系人|联系|电话|手机|手机号|mobile|phone|tel|contact|wechat|微信|邮箱|email)/iu.test(normalized)) {
    return "contact";
  }
  if (/(订单|支付|退款|交易|下单|order|payment|refund|trade)/iu.test(normalized)) {
    return "order";
  }
  if (/(推广|渠道|来源|归属|顾问|销售|线索|投放|promote|channel|source|sales|consultant)/iu.test(normalized)) {
    return "promotion";
  }
  return "base";
}

function isBroadDetailRequest(text: string): boolean {
  return /(详细|详情|完整|全部|所有|全量|明细都要)/u.test(String(text ?? "").trim());
}

function extractQuotedPhrase(text: string): string | null {
  const matched = String(text ?? "").match(/[“"'`](.{1,40}?)[”"'`]/u);
  return matched?.[1]?.trim() || null;
}

function cleanBusinessEntityKeyword(text: string): string | null {
  let normalized = String(text ?? "")
    .replace(/[\n\r]+/gu, " ")
    .trim();
  if (!normalized) return null;

  const quoted = extractQuotedPhrase(normalized);
  if (quoted) return quoted;

  normalized = normalized
    .replace(/^(?:帮我|麻烦|请|我想|我需要|我要|可以帮我|请帮我)\s*/u, "")
    .replace(/^(?:从数据库(?:内)?|在数据库(?:里|中|内)?|数据库(?:里|中|内)?)(?:查询|查|导出)?\s*/u, "")
    .replace(/^(?:查询|查一下|查下|查|导出|导一下|找一下|找出|看看)\s*/u, "")
    .replace(/^(?:这个|这家|该)\s*/u, "")
    .replace(/\s*(?:这个|这家|该)?(?:公司|企业|商户|客户)(?:的)?(?:联系人(?:信息)?|联系方式|电话|手机|手机号|订单(?:信息)?|支付(?:信息)?|退款(?:信息)?|交易(?:信息)?|推广(?:信息)?|渠道(?:信息)?|来源(?:信息)?|归属(?:信息)?|顾问(?:信息)?|销售(?:信息)?|信息|数据|详情|详细信息|资料|记录|明细)\s*$/u, "")
    .replace(/\s*(?:这个|这家|该)?(?:公司|企业|商户|客户)(?:的)?(?:基础)?(?:信息|数据|详情|详细信息|资料|记录|明细)?\s*$/u, "")
    .replace(/\s*(?:的信息|的数据|详情|详细信息|资料|记录|明细)\s*$/u, "")
    .replace(/^(?:帮我|请|麻烦)\s*/u, "")
    .trim();

  const companyMarker = normalized.match(/^(.{1,40}?)\s*(?:这个|这家|该)?(?:公司|企业|商户|客户)(?:.*)$/u);
  if (companyMarker?.[1]?.trim()) {
    normalized = companyMarker[1].trim();
  }

  if (!normalized) return null;
  if (/(?:公司|企业|商户|客户|数据库|查询|导出|信息|数据)$/u.test(normalized) && normalized.length <= 6) {
    return null;
  }
  return normalized;
}

function extractCompanyKeyword(candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    const cleaned = cleanBusinessEntityKeyword(candidate);
    if (cleaned) return cleaned;
  }
  return null;
}

function scoreCompanyBaseCandidate(candidate: TableMetadataCandidate): number {
  const tableName = normalizeLower(candidate.table.name);
  let score = 0;
  if (includesAnyToken(tableName, ["company", "corp", "enterprise", "merchant", "customer", "client", "business"])) {
    score += 8;
  }
  if (findPreferredColumn(candidate.columns, COMPANY_NAME_FIELD_CANDIDATES)) {
    score += 10;
  }
  if (findPreferredColumn(candidate.columns, COMPANY_ID_FIELD_CANDIDATES)) {
    score += 5;
  }
  if ((candidate.table.matched_columns ?? []).some((field) => includesAnyToken(field, [...COMPANY_NAME_FIELD_CANDIDATES, ...COMPANY_ID_FIELD_CANDIDATES]))) {
    score += 3;
  }
  if (includesAnyToken(tableName, ["user", "member", "contact", "mobile", "phone", "order", "refund", "payment", "trade", "promote", "channel", "log"])) {
    score -= 4;
  }
  return score;
}

function scoreCompanyFacetCandidate(
  candidate: TableMetadataCandidate,
  facet: DeterministicCompanyFacet,
): number {
  const tableName = normalizeLower(candidate.table.name);
  const hasCompanyForeignKey = Boolean(findPreferredColumn(candidate.columns, COMPANY_FOREIGN_KEY_CANDIDATES));
  const hasBaseId = Boolean(findPreferredColumn(candidate.columns, COMPANY_ID_FIELD_CANDIDATES));
  let score = 0;

  if (facet === "contact") {
    if (includesAnyToken(tableName, ["user", "member", "contact", "phone", "mobile", "wechat"])) {
      score += 8;
    }
    if (findPreferredColumn(candidate.columns, CONTACT_NAME_FIELD_CANDIDATES)) score += 6;
    if (findPreferredColumn(candidate.columns, MOBILE_FIELD_CANDIDATES)) score += 6;
    if (findPreferredColumn(candidate.columns, PHONE_FIELD_CANDIDATES)) score += 4;
    if (hasCompanyForeignKey) score += 6;
  }

  if (facet === "order") {
    if (includesAnyToken(tableName, ["order", "trade", "payment", "refund"])) {
      score += 8;
    }
    if (findPreferredColumn(candidate.columns, ORDER_NO_FIELD_CANDIDATES)) score += 6;
    if (findPreferredColumn(candidate.columns, ORDER_STATUS_FIELD_CANDIDATES)) score += 4;
    if (findPreferredColumn(candidate.columns, ORDER_AMOUNT_FIELD_CANDIDATES)) score += 4;
    if (hasCompanyForeignKey || hasBaseId) score += 6;
  }

  if (facet === "promotion") {
    if (includesAnyToken(tableName, ["promote", "channel", "source", "sales", "consultant", "wechat"])) {
      score += 8;
    }
    if (findPreferredColumn(candidate.columns, CHANNEL_FIELD_CANDIDATES)) score += 5;
    if (findPreferredColumn(candidate.columns, SALES_FIELD_CANDIDATES)) score += 5;
    if (hasCompanyForeignKey || hasBaseId) score += 6;
  }

  return score;
}

function hasFacetColumns(
  columns: readonly ColumnInfo[],
  facet: DeterministicCompanyFacet,
): boolean {
  if (facet === "contact") {
    return Boolean(
      findPreferredColumn(columns, MOBILE_FIELD_CANDIDATES)
      || findPreferredColumn(columns, PHONE_FIELD_CANDIDATES)
      || findPreferredColumn(columns, CONTACT_NAME_FIELD_CANDIDATES, CONTACT_NAME_FIELD_PARTIAL_CANDIDATES),
    );
  }
  if (facet === "order") {
    return Boolean(
      findPreferredColumn(columns, ORDER_NO_FIELD_CANDIDATES)
      || findPreferredColumn(columns, ORDER_AMOUNT_FIELD_CANDIDATES)
      || findPreferredColumn(columns, ORDER_STATUS_STRICT_CANDIDATES),
    );
  }
  if (facet === "promotion") {
    return Boolean(findPreferredColumn(columns, [...CHANNEL_FIELD_CANDIDATES, ...SALES_FIELD_CANDIDATES]));
  }
  return true;
}

function buildCompanyBaseSearchKeywords(): string[] {
  return uniqueNormalizedStrings([
    ...expandBusinessSearchKeywords("公司"),
    "企业",
    "客户",
    "merchant",
    "customer",
  ]).slice(0, 10);
}

function buildCompanyFacetSearchKeywords(facet: DeterministicCompanyFacet): string[] {
  if (facet === "contact") {
    return uniqueNormalizedStrings([
      ...expandBusinessSearchKeywords("联系人 电话 手机"),
      "contact",
      "wechat",
      ...COMPANY_FOREIGN_KEY_CANDIDATES,
    ]).slice(0, 10);
  }
  if (facet === "order") {
    return uniqueNormalizedStrings([
      ...expandBusinessSearchKeywords("订单 支付 退款 交易"),
      ...COMPANY_FOREIGN_KEY_CANDIDATES,
    ]).slice(0, 10);
  }
  return uniqueNormalizedStrings([
    "推广",
    "渠道",
    "来源",
    "顾问",
    "销售",
    "promote",
    "channel",
    "source",
    "consultant",
    "sales",
    ...COMPANY_FOREIGN_KEY_CANDIDATES,
  ]).slice(0, 10);
}

async function searchSourceTableMetadata(
  source: RuntimeExportSourceConfig,
  keywords: readonly string[],
  limit = 8,
): Promise<TableMetadataCandidate[]> {
  await ensureExportSourceConnected(source);
  const searchResults = await Promise.all(
    uniqueNormalizedStrings([...keywords]).map((keyword) =>
      invoke<TableSearchResult[]>("db_search_tables", {
        connId: source.id,
        keyword,
        schema: null,
        limit,
      }),
    ),
  );
  const merged = mergeTableSearchResults(searchResults.flat()).slice(0, limit);
  const described = await Promise.all(
    merged.map(async (table) => {
      const qualifiedName = buildQualifiedTableName(table);
      try {
        const columns = await invoke<ColumnInfo[]>("db_describe_table", {
          connId: source.id,
          table: qualifiedName,
        });
        return {
          source,
          table,
          qualifiedName,
          columns,
        } satisfies TableMetadataCandidate;
      } catch (error) {
        log.warn("Failed to describe candidate export table", {
          sourceId: source.id,
          table: qualifiedName,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  return described.filter((item): item is TableMetadataCandidate => Boolean(item));
}

async function findBestCompanyBaseCandidate(
  sources: RuntimeExportSourceConfig[],
): Promise<TableMetadataCandidate | null> {
  const contextCandidate = await resolveDatabaseClientContextCandidate(sources);
  if (contextCandidate && scoreCompanyBaseCandidate(contextCandidate) >= 8) {
    return contextCandidate;
  }

  let best: { candidate: TableMetadataCandidate; score: number } | null = null;
  for (const source of sources.filter(isPersonalSqlSource)) {
    try {
      const candidates = await searchSourceTableMetadata(source, buildCompanyBaseSearchKeywords(), 10);
      for (const candidate of candidates) {
        const score = scoreCompanyBaseCandidate(candidate);
        if (!best || score > best.score) {
          best = { candidate, score };
        }
      }
    } catch (error) {
      log.warn("Failed to search company base tables", {
        sourceId: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return best && best.score >= 10 ? best.candidate : null;
}

async function findBestCompanyFacetCandidate(params: {
  source: RuntimeExportSourceConfig;
  baseCandidate: TableMetadataCandidate;
  facet: DeterministicCompanyFacet;
}): Promise<TableMetadataCandidate | null> {
  try {
    const candidates = await searchSourceTableMetadata(
      params.source,
      buildCompanyFacetSearchKeywords(params.facet),
      10,
    );
    const filtered = candidates.filter(
      (candidate) => candidate.qualifiedName !== params.baseCandidate.qualifiedName,
    );
    let best: { candidate: TableMetadataCandidate; score: number } | null = null;
    for (const candidate of filtered) {
      const score = scoreCompanyFacetCandidate(candidate, params.facet);
      if (!best || score > best.score) {
        best = { candidate, score };
      }
    }
    return best && best.score >= 10 ? best.candidate : null;
  } catch (error) {
    log.warn("Failed to search company facet tables", {
      sourceId: params.source.id,
      facet: params.facet,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function resolveCompanyJoinCondition(params: {
  baseAlias: string;
  joinAlias: string;
  baseColumns: readonly ColumnInfo[];
  joinColumns: readonly ColumnInfo[];
}): { left: string; right: string; op: "eq" } | null {
  const baseIds = collectIdLikeColumns(params.baseColumns);
  const joinIds = collectIdLikeColumns(params.joinColumns);

  for (const joinKey of COMPANY_FOREIGN_KEY_CANDIDATES) {
    const actualJoinKey = joinIds.find((column) => normalizeLower(column) === joinKey);
    if (!actualJoinKey) continue;
    const sameBaseKey = baseIds.find((column) => normalizeLower(column) === joinKey);
    if (sameBaseKey) {
      return {
        left: buildFieldRef(params.baseAlias, sameBaseKey),
        right: buildFieldRef(params.joinAlias, actualJoinKey),
        op: "eq",
      };
    }
    const baseId = baseIds.find((column) => normalizeLower(column) === "id");
    if (baseId) {
      return {
        left: buildFieldRef(params.baseAlias, baseId),
        right: buildFieldRef(params.joinAlias, actualJoinKey),
        op: "eq",
      };
    }
  }

  for (const baseKey of baseIds) {
    const sameJoinKey = joinIds.find((column) => normalizeLower(column) === normalizeLower(baseKey));
    if (!sameJoinKey) continue;
    return {
      left: buildFieldRef(params.baseAlias, baseKey),
      right: buildFieldRef(params.joinAlias, sameJoinKey),
      op: "eq",
    };
  }

  return null;
}

function buildCompanyBaseFields(
  columns: readonly ColumnInfo[],
  baseAlias: string,
): Array<{ field: string; alias: string }> {
  const fields: Array<{ field: string; alias: string }> = [];
  addSelectedField(fields, findPreferredColumn(columns, COMPANY_NAME_FIELD_CANDIDATES), "企业名称", baseAlias);
  addSelectedField(fields, findPreferredColumn(columns, STATUS_FIELD_CANDIDATES), "状态", baseAlias);
  addSelectedField(fields, findPreferredColumn(columns, INDUSTRY_FIELD_CANDIDATES), "行业", baseAlias);
  const regionColumn = findPreferredColumn(columns, REGION_FIELD_CANDIDATES);
  if (regionColumn) {
    const alias = /province|省/u.test(regionColumn) ? "省份" : /city|市/u.test(regionColumn) ? "城市" : "区域";
    addSelectedField(fields, regionColumn, alias, baseAlias);
  }
  addSelectedField(fields, findPreferredColumn(columns, TIME_FIELD_CANDIDATES), "更新时间", baseAlias);
  return fields;
}

function buildCompanyFacetFields(params: {
  facet: DeterministicCompanyFacet;
  columns: readonly ColumnInfo[];
  alias: string;
}): Array<{ field: string; alias: string }> {
  const fields: Array<{ field: string; alias: string }> = [];
  if (params.facet === "contact") {
    addSelectedField(
      fields,
      findPreferredColumn(params.columns, CONTACT_NAME_FIELD_CANDIDATES, CONTACT_NAME_FIELD_PARTIAL_CANDIDATES),
      "联系人",
      params.alias,
    );
    addSelectedField(fields, findPreferredColumn(params.columns, MOBILE_FIELD_CANDIDATES), "手机号", params.alias);
    addSelectedField(fields, findPreferredColumn(params.columns, PHONE_FIELD_CANDIDATES), "联系电话", params.alias);
    addSelectedField(fields, findPreferredColumn(params.columns, TIME_FIELD_CANDIDATES), "最近更新时间", params.alias);
    return fields;
  }
  if (params.facet === "order") {
    addSelectedField(fields, findPreferredColumn(params.columns, ORDER_NO_FIELD_CANDIDATES), "订单号", params.alias);
    addSelectedField(fields, findPreferredColumn(params.columns, ORDER_STATUS_FIELD_CANDIDATES), "订单状态", params.alias);
    addSelectedField(fields, findPreferredColumn(params.columns, ORDER_AMOUNT_FIELD_CANDIDATES), "订单金额", params.alias);
    addSelectedField(fields, findPreferredColumn(params.columns, TIME_FIELD_CANDIDATES), "订单时间", params.alias);
    return fields;
  }
  addSelectedField(fields, findPreferredColumn(params.columns, CHANNEL_FIELD_CANDIDATES), "渠道来源", params.alias);
  addSelectedField(fields, findPreferredColumn(params.columns, SALES_FIELD_CANDIDATES), "负责人", params.alias);
  addSelectedField(fields, findPreferredColumn(params.columns, TIME_FIELD_CANDIDATES), "最近更新时间", params.alias);
  return fields;
}

function buildCompanySummary(facet: DeterministicCompanyFacet): string {
  if (facet === "contact") {
    return "我理解的是：查询该企业的基础信息，并带出联系人与电话。";
  }
  if (facet === "order") {
    return "我理解的是：查询该企业相关的订单/交易信息。";
  }
  if (facet === "promotion") {
    return "我理解的是：查询该企业的推广归属信息。";
  }
  return "我理解的是：查询该企业的基础信息。";
}

function buildCompanyClarifyQuestion(
  facet?: DeterministicCompanyFacet,
): string {
  if (facet === "contact") {
    return "我先定位到了企业主体数据，但还不能稳定补全联系人明细。你可以继续说明是要联系人姓名、手机号，还是其他联系方式。";
  }
  if (facet === "order") {
    return "我先定位到了企业主体数据，但还不能稳定补全订单口径。请告诉我是要订单基础信息、支付结果，还是退款信息。";
  }
  if (facet === "promotion") {
    return "我先定位到了企业主体数据，但还不能稳定补全推广归属。请告诉我是要渠道来源、负责人，还是推广明细。";
  }
  return "我还不能稳定确认你要的是哪类企业数据。请直接告诉我你更想导出哪一种业务信息：企业基础信息、联系人/电话、推广归属，还是订单/交易相关信息。";
}

type DatasetFieldDefinition = RuntimeExportDatasetDefinition["fields"][number];
type DatasetRelationDefinition = NonNullable<RuntimeExportDatasetDefinition["relations"]>[number];

interface DatasetSemanticMatch {
  dataset: RuntimeExportDatasetDefinition;
  source: RuntimeExportSourceConfig;
  score: number;
  relation?: DatasetRelationDefinition;
  relationScore: number;
}

interface RelativeTimeRange {
  start: string;
  end: string;
  label: string;
}

function normalizeSemanticText(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./\\,，。:：;；!！?？"'`“”‘’()[\]{}【】]+/gu, "");
}

function semanticIncludes(text: string, phrase: string): boolean {
  const normalizedPhrase = normalizeSemanticText(phrase);
  return normalizedPhrase.length >= 2 && normalizeSemanticText(text).includes(normalizedPhrase);
}

function scorePhraseMatches(
  text: string,
  phrases: readonly (string | undefined)[],
  weight: number,
  cap = Number.POSITIVE_INFINITY,
): number {
  let score = 0;
  for (const phrase of phrases) {
    const normalized = String(phrase ?? "").trim();
    if (!normalized || !semanticIncludes(text, normalized)) continue;
    score += weight;
    if (score >= cap) return cap;
  }
  return score;
}

function humanizeFieldName(value: string): string {
  const normalized = String(value ?? "").trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getEnabledDatasetFields(dataset: RuntimeExportDatasetDefinition): DatasetFieldDefinition[] {
  return dataset.fields.filter((field) => field.enabled !== false);
}

function findDatasetField(
  dataset: RuntimeExportDatasetDefinition,
  fieldName?: string | null,
): DatasetFieldDefinition | null {
  const normalized = String(fieldName ?? "").trim();
  if (!normalized) return null;
  return getEnabledDatasetFields(dataset).find((field) => field.name === normalized) ?? null;
}

function inferDatasetBaseAlias(dataset: RuntimeExportDatasetDefinition): string {
  const explicit = String(dataset.baseAlias ?? "").trim();
  if (explicit) return explicit;
  const firstLetter = String(dataset.entityName ?? "").match(/[a-z]/i)?.[0]?.toLowerCase();
  return firstLetter || "base";
}

function inferDatasetKeywordField(dataset: RuntimeExportDatasetDefinition): DatasetFieldDefinition | null {
  const explicit = findDatasetField(dataset, dataset.keywordField);
  if (explicit) return explicit;
  const enabledFields = getEnabledDatasetFields(dataset);
  const exactCandidates = [
    "compname",
    "bus_name",
    "company_name",
    "enterprise_name",
    "corp_name",
    "customer_name",
    "merchant_name",
    "contact_name",
    "name",
    "title",
  ];
  for (const candidate of exactCandidates) {
    const matched = enabledFields.find((field) => normalizeLower(field.name) === candidate);
    if (matched) return matched;
  }
  return enabledFields.find((field) =>
    includesAnyToken(
      [field.name, field.label, ...(field.aliases ?? [])].join(" "),
      ["名称", "姓名", "企业", "公司", "客户", "标题", "name", "title", "company", "customer"],
    ),
  ) ?? null;
}

function qualifyFieldRef(
  source: RuntimeExportSourceConfig,
  alias: string,
  fieldName: string,
): string {
  return source.db_type === "mongodb" ? fieldName : `${alias}.${fieldName}`;
}

function normalizeJoinFieldRef(value: string, alias: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return trimmed.includes(".") ? trimmed : `${alias}.${trimmed}`;
}

function collectDatasetFieldMatches(
  text: string,
  fields: readonly DatasetFieldDefinition[],
): DatasetFieldDefinition[] {
  return fields.filter((field) => {
    const phrases = [field.label, field.name, ...(field.aliases ?? [])];
    return phrases.some((phrase) => semanticIncludes(text, phrase));
  });
}

function uniqueDatasetFields(fields: readonly DatasetFieldDefinition[]): DatasetFieldDefinition[] {
  const seen = new Set<string>();
  const result: DatasetFieldDefinition[] = [];
  for (const field of fields) {
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    result.push(field);
  }
  return result;
}

function buildDatasetFieldSelections(params: {
  source: RuntimeExportSourceConfig;
  dataset: RuntimeExportDatasetDefinition;
  text: string;
  baseAlias: string;
  includeKeywordField?: boolean;
}): Array<{ field: string; alias?: string }> {
  const enabledFields = getEnabledDatasetFields(params.dataset);
  const defaultFields = params.dataset.defaultFields
    .map((fieldName) => enabledFields.find((field) => field.name === fieldName) ?? null)
    .filter((field): field is DatasetFieldDefinition => Boolean(field));
  const requestedFields = collectDatasetFieldMatches(params.text, enabledFields);
  const keywordField = params.includeKeywordField ? inferDatasetKeywordField(params.dataset) : null;
  const selectedFields = requestedFields.length > 0
    ? requestedFields
    : isBroadDetailRequest(params.text)
      ? enabledFields.slice(0, 12)
      : defaultFields.length > 0
        ? defaultFields
        : enabledFields.slice(0, 6);
  return uniqueDatasetFields([
    ...(keywordField ? [keywordField] : []),
    ...selectedFields,
  ]).map((field) => {
    const fieldRef = qualifyFieldRef(params.source, params.baseAlias, field.name);
    if (params.source.db_type === "mongodb") {
      return { field: fieldRef };
    }
    return {
      field: fieldRef,
      alias: String(field.label ?? "").trim() || humanizeFieldName(field.name),
    };
  });
}

function buildRelationFieldSelections(params: {
  relation: DatasetRelationDefinition;
  text: string;
  relationAlias: string;
}): Array<{ field: string; alias?: string }> {
  const selections = params.relation.defaultFields ?? [];
  if (selections.length === 0) return [];

  const requested = selections.filter((selection) =>
    [selection.alias, selection.field].some((phrase) => semanticIncludes(params.text, String(phrase ?? ""))),
  );
  const matched = requested.length >= 2 ? requested : selections;
  return matched
    .map((selection) => {
      const field = normalizeJoinFieldRef(selection.field, params.relationAlias);
      if (!field) return null;
      const alias = String(selection.alias ?? "").trim();
      return alias ? { field, alias } : { field };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function scoreDatasetRelationMatch(text: string, relation: DatasetRelationDefinition): number {
  return (
    scorePhraseMatches(text, [relation.name], 14, 14)
    + scorePhraseMatches(text, relation.triggerKeywords ?? [], 10, 30)
    + scorePhraseMatches(text, [relation.description], 6, 6)
    + scorePhraseMatches(
      text,
      (relation.defaultFields ?? []).flatMap((field) => [field.alias, field.field]),
      4,
      12,
    )
  );
}

function resolveDatasetSemanticMatch(params: {
  text: string;
  datasets: RuntimeExportDatasetDefinition[];
  sources: RuntimeExportSourceConfig[];
}): DatasetSemanticMatch | null {
  const context = useDatabaseStore.getState().databaseClientContext;
  const matches: DatasetSemanticMatch[] = [];

  for (const dataset of params.datasets.filter((item) => item.enabled !== false)) {
    const source = params.sources.find((item) => item.id === dataset.sourceId);
    if (!source) continue;

    const fieldMatches = collectDatasetFieldMatches(params.text, getEnabledDatasetFields(dataset));
    const relationCandidates = (dataset.relations ?? [])
      .filter((relation) => relation.enabled !== false)
      .map((relation) => ({ relation, score: scoreDatasetRelationMatch(params.text, relation) }))
      .sort((left, right) => right.score - left.score);
    const topRelation = relationCandidates[0];

    let score = 0;
    score += scorePhraseMatches(params.text, [dataset.displayName], 20, 20);
    score += scorePhraseMatches(params.text, dataset.aliases ?? [], 16, 32);
    score += scorePhraseMatches(params.text, dataset.intentTags ?? [], 12, 24);
    score += scorePhraseMatches(params.text, dataset.examplePrompts ?? [], 8, 16);
    score += scorePhraseMatches(params.text, [dataset.description], 6, 6);
    score += scorePhraseMatches(params.text, [dataset.entityName], 6, 6);
    score += Math.min(fieldMatches.length * 4, 12);
    if (context.connectionId && (context.connectionId === source.id || context.connectionId === source.originSourceId)) {
      score += 10;
    }
    if (topRelation?.score) {
      score += Math.min(topRelation.score, 12);
    }

    matches.push({
      dataset,
      source,
      score,
      ...(topRelation?.relation ? { relation: topRelation.relation, relationScore: topRelation.score } : { relationScore: 0 }),
    });
  }

  const sorted = matches.sort((left, right) => right.score - left.score);
  const top = sorted[0];
  if (!top) return null;
  const minimumScore = sorted.length === 1 ? 10 : 18;
  return top.score >= minimumScore ? top : null;
}

function stripSemanticPhrases(text: string, phrases: readonly string[]): string {
  let result = String(text ?? "");
  const sorted = [...phrases]
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length >= 2)
    .sort((left, right) => right.length - left.length);
  for (const phrase of sorted) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "giu"), " ");
  }
  return result;
}

function extractSemanticLookupKeyword(params: {
  text: string;
  dataset: RuntimeExportDatasetDefinition;
  relation?: DatasetRelationDefinition;
}): string | null {
  const quoted = extractQuotedPhrase(params.text);
  if (quoted) return quoted;

  const companyKeyword = cleanBusinessEntityKeyword(params.text);
  if (companyKeyword) return companyKeyword;

  const stripped = stripSemanticPhrases(params.text, [
    params.dataset.displayName,
    params.dataset.description,
    params.dataset.entityName,
    ...(params.dataset.aliases ?? []),
    ...(params.dataset.intentTags ?? []),
    ...(params.dataset.examplePrompts ?? []),
    ...(params.dataset.fields.flatMap((field) => [field.label, field.name, ...(field.aliases ?? [])])),
    ...(params.relation
      ? [
          params.relation.name,
          params.relation.description ?? "",
          ...(params.relation.triggerKeywords ?? []),
          ...(params.relation.defaultFields ?? []).flatMap((field) => [field.alias ?? "", field.field]),
        ]
      : []),
  ]);

  const candidate = stripped
    .replace(/^(?:帮我|麻烦|请|我想|我需要|我要|可以帮我|请帮我)\s*/u, "")
    .replace(/^(?:从数据库(?:内)?|在数据库(?:里|中|内)?|数据库(?:里|中|内)?)(?:查询|查|导出)?\s*/u, "")
    .replace(/^(?:查询|查一下|查下|查|导出|导一下|找一下|找出|看看|查看|看一下)\s*/u, "")
    .replace(/\b(?:database|export|query|detail|details)\b/giu, " ")
    .replace(/(?:数据|明细|详情|详细|信息|记录|列表|结果|导出|查询|筛选|帮忙|继续|一下|一些|相关)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .split(/[，,。；;！!？?]/u)[0]
    ?.trim();

  if (!candidate || candidate.length <= 1) return null;
  return candidate;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatDateTime(value: Date): string {
  return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())} ${padDatePart(value.getHours())}:${padDatePart(value.getMinutes())}:${padDatePart(value.getSeconds())}`;
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
}

function addDays(value: Date, delta: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + delta);
  return next;
}

function startOfWeek(value: Date): Date {
  const current = startOfDay(value);
  const day = current.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  return addDays(current, delta);
}

function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1, 0, 0, 0, 0);
}

function resolveRelativeTimeRange(text: string, now = new Date()): RelativeTimeRange | null {
  const normalized = String(text ?? "").trim();
  if (!normalized) return null;
  const today = startOfDay(now);
  if (/(今天|今日)/u.test(normalized)) {
    return {
      start: formatDateTime(today),
      end: formatDateTime(addDays(today, 1)),
      label: "今天",
    };
  }
  if (/(昨天|昨日)/u.test(normalized)) {
    return {
      start: formatDateTime(addDays(today, -1)),
      end: formatDateTime(today),
      label: "昨天",
    };
  }
  const recentDaysMatch = normalized.match(/(?:最近|近)\s*(\d{1,3})\s*天/u);
  if (recentDaysMatch?.[1]) {
    const days = Math.max(1, Math.min(365, Number.parseInt(recentDaysMatch[1], 10)));
    return {
      start: formatDateTime(addDays(today, -(days - 1))),
      end: formatDateTime(addDays(today, 1)),
      label: `近 ${days} 天`,
    };
  }
  if (/本周/u.test(normalized)) {
    const start = startOfWeek(now);
    return {
      start: formatDateTime(start),
      end: formatDateTime(addDays(start, 7)),
      label: "本周",
    };
  }
  if (/上周/u.test(normalized)) {
    const currentWeek = startOfWeek(now);
    const lastWeek = addDays(currentWeek, -7);
    return {
      start: formatDateTime(lastWeek),
      end: formatDateTime(currentWeek),
      label: "上周",
    };
  }
  if (/本月/u.test(normalized)) {
    const start = startOfMonth(now);
    return {
      start: formatDateTime(start),
      end: formatDateTime(new Date(start.getFullYear(), start.getMonth() + 1, 1, 0, 0, 0, 0)),
      label: "本月",
    };
  }
  if (/上月/u.test(normalized)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return {
      start: formatDateTime(start),
      end: formatDateTime(end),
      label: "上月",
    };
  }
  return null;
}

function resolveRequestedLimit(text: string, maxLimit: number): number | null {
  const match = String(text ?? "").match(/(?:前|最多|限制|导出|给我)?\s*(\d{1,5})\s*(?:条|行|个)/u);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(value, maxLimit);
}

function buildDatasetSummary(params: {
  dataset: RuntimeExportDatasetDefinition;
  relation?: DatasetRelationDefinition;
  lookupKeyword?: string | null;
  timeRange?: RelativeTimeRange | null;
}): string {
  const parts = [
    params.relation
      ? `我理解的是：从「${params.dataset.displayName}」中带出「${params.relation.name}」，导出符合条件的数据。`
      : `我理解的是：导出「${params.dataset.displayName}」中符合条件的数据。`,
  ];
  if (params.lookupKeyword) {
    parts.push(`筛选对象：${params.lookupKeyword}`);
  }
  if (params.timeRange?.label) {
    parts.push(`时间范围：${params.timeRange.label}`);
  }
  return parts.join(" ");
}

function buildDatasetDrivenIntent(params: {
  text: string;
  match: DatasetSemanticMatch;
}): ExportAgentDecision | null {
  const { dataset, source } = params.match;
  const baseAlias = inferDatasetBaseAlias(dataset);
  const keywordField = inferDatasetKeywordField(dataset);
  const timeRange = dataset.timeField ? resolveRelativeTimeRange(params.text) : null;
  const canJoin = source.scope === "personal" && source.db_type !== "mongodb";
  const selectedRelation = canJoin && params.match.relation && params.match.relationScore >= 12
    ? params.match.relation
    : undefined;
  const lookupKeyword = extractSemanticLookupKeyword({
    text: params.text,
    dataset,
    ...(selectedRelation ? { relation: selectedRelation } : {}),
  });
  const baseFields = buildDatasetFieldSelections({
    source,
    dataset,
    text: params.text,
    baseAlias,
    includeKeywordField: Boolean(lookupKeyword),
  });
  const relationAlias = String(selectedRelation?.alias ?? "").trim()
    || (selectedRelation?.targetEntityName?.match(/[a-z]/i)?.[0]?.toLowerCase() || "rel");
  const relationFields = selectedRelation
    ? buildRelationFieldSelections({
        relation: selectedRelation,
        text: params.text,
        relationAlias,
      })
    : [];
  const hasStrongFieldIntent = baseFields.length > 0 || relationFields.length > 0;
  const hasConstraint = Boolean(lookupKeyword || timeRange);
  if (!hasStrongFieldIntent) {
    return null;
  }
  if (!hasConstraint && params.match.score < 24 && !isBroadDetailRequest(params.text)) {
    return null;
  }

  const keywordFieldRef = keywordField
    ? qualifyFieldRef(source, baseAlias, keywordField.name)
    : null;
  const timeFieldRef = dataset.timeField
    ? qualifyFieldRef(source, baseAlias, dataset.timeField)
    : null;
  const filters = [
    ...(lookupKeyword && keywordFieldRef
      ? [{
          field: keywordFieldRef,
          op: source.db_type === "mongodb" ? "contains" : "contains_compact",
          value: source.db_type === "mongodb" ? lookupKeyword : (compactWhitespace(lookupKeyword) || lookupKeyword),
        }]
      : []),
    ...(timeRange && timeFieldRef
      ? [
          { field: timeFieldRef, op: "gte", value: timeRange.start },
          { field: timeFieldRef, op: "lt", value: timeRange.end },
        ]
      : []),
  ];
  const resolvedMaxLimit = Math.max(1, dataset.maxExportRows ?? source.max_export_rows ?? 1000);
  const limit = resolveRequestedLimit(params.text, resolvedMaxLimit)
    ?? Math.min(selectedRelation ? 1000 : 500, resolvedMaxLimit);

  return {
    kind: "intent",
    summary: buildDatasetSummary({
      dataset,
      ...(selectedRelation ? { relation: selectedRelation } : {}),
      lookupKeyword,
      timeRange,
    }),
    intent: {
      sourceId: source.id,
      datasetId: dataset.id,
      entityName: dataset.entityName,
      entityType: dataset.entityType,
      ...(dataset.schema ? { schema: dataset.schema } : {}),
      ...(source.db_type !== "mongodb" ? { baseAlias } : {}),
      fields: [...baseFields, ...relationFields],
      ...(selectedRelation
        ? {
            joins: [
              {
                entityName: selectedRelation.targetEntityName,
                ...(selectedRelation.targetEntityType ? { entityType: selectedRelation.targetEntityType } : {}),
                ...(selectedRelation.targetSchema ? { schema: selectedRelation.targetSchema } : {}),
                alias: relationAlias,
                joinType: selectedRelation.joinType ?? "left",
                on: selectedRelation.on.map((condition) => ({
                  left: normalizeJoinFieldRef(condition.left, baseAlias),
                  right: normalizeJoinFieldRef(condition.right, relationAlias),
                  op: String(condition.op ?? "eq").trim() || "eq",
                })),
              },
            ],
          }
        : {}),
      ...(filters.length ? { filters } : {}),
      ...(timeFieldRef
        ? {
            sort: [
              {
                field: timeFieldRef,
                direction: "desc" as const,
              },
            ],
          }
        : {}),
      limit,
      outputFormat: "csv",
    },
  };
}

export async function resolveDeterministicExportDecision(params: {
  userInput: string;
  originalRequest?: string;
  sources: RuntimeExportSourceConfig[];
  datasets: RuntimeExportDatasetDefinition[];
}): Promise<ExportAgentDecision | null> {
  const requestContext = [params.originalRequest, params.userInput].filter(Boolean).join("\n");

  const semanticDatasetMatch = resolveDatasetSemanticMatch({
    text: requestContext,
    datasets: params.datasets,
    sources: params.sources,
  });
  if (semanticDatasetMatch) {
    const semanticDecision = buildDatasetDrivenIntent({
      text: requestContext,
      match: semanticDatasetMatch,
    });
    if (semanticDecision) {
      return semanticDecision;
    }
  }

  const businessKind = detectDeterministicBusinessKind(requestContext);
  if (businessKind !== "company") {
    return null;
  }

  const companyKeyword = extractCompanyKeyword([params.userInput, params.originalRequest]);
  if (!companyKeyword) {
    return {
      kind: "clarify",
      question: "请先告诉我你要查哪家企业，例如“查询 王者荣耀 这家公司的基础信息”。",
    };
  }

  const personalSqlSources = params.sources.filter(isPersonalSqlSource);
  if (personalSqlSources.length === 0) {
    return null;
  }

  const facet = detectCompanyFacet(requestContext);
  if (facet === "base" && isBroadDetailRequest(requestContext)) {
    return {
      kind: "clarify",
      question: buildCompanyClarifyQuestion(),
    };
  }

  const baseCandidate = await findBestCompanyBaseCandidate(personalSqlSources);
  if (!baseCandidate) {
    return {
      kind: "clarify",
      question: buildCompanyClarifyQuestion(),
    };
  }

  const baseAlias = "c";
  const companyNameColumn = findPreferredColumn(baseCandidate.columns, COMPANY_NAME_FIELD_CANDIDATES);
  if (!companyNameColumn) {
    return {
      kind: "clarify",
      question: buildCompanyClarifyQuestion(),
    };
  }

  const baseFields = buildCompanyBaseFields(baseCandidate.columns, baseAlias);
  const baseSortField = findPreferredColumn(baseCandidate.columns, TIME_FIELD_CANDIDATES);
  const compactCompanyKeyword = compactWhitespace(companyKeyword) || companyKeyword;

  if (facet === "base" || hasFacetColumns(baseCandidate.columns, facet)) {
    const fields = [
      ...baseFields,
      ...(facet === "base"
        ? []
        : buildCompanyFacetFields({
            facet,
            columns: baseCandidate.columns,
            alias: baseAlias,
          })),
    ];
    return {
      kind: "intent",
      summary: buildCompanySummary(facet),
      intent: {
        sourceId: baseCandidate.source.id,
        entityName: baseCandidate.table.name,
        entityType: normalizeEntityType(baseCandidate.table.table_type),
        ...(baseCandidate.table.schema ? { schema: baseCandidate.table.schema } : {}),
        baseAlias,
        fields,
        filters: [
          {
            field: buildFieldRef(baseAlias, companyNameColumn),
            op: "contains_compact",
            value: compactCompanyKeyword,
          },
        ],
        ...(baseSortField
          ? {
              sort: [
                {
                  field: buildFieldRef(baseAlias, baseSortField),
                  direction: "desc" as const,
                },
              ],
            }
          : {}),
        limit: 500,
        outputFormat: "csv",
      },
    };
  }

  const joinCandidate = await findBestCompanyFacetCandidate({
    source: baseCandidate.source,
    baseCandidate,
    facet,
  });
  if (!joinCandidate) {
    return {
      kind: "clarify",
      question: buildCompanyClarifyQuestion(facet),
    };
  }

  const joinAlias = facet === "contact" ? "u" : facet === "order" ? "o" : "p";
  const joinCondition = resolveCompanyJoinCondition({
    baseAlias,
    joinAlias,
    baseColumns: baseCandidate.columns,
    joinColumns: joinCandidate.columns,
  });
  if (!joinCondition) {
    return {
      kind: "clarify",
      question: buildCompanyClarifyQuestion(facet),
    };
  }

  const joinFields = buildCompanyFacetFields({
    facet,
    columns: joinCandidate.columns,
    alias: joinAlias,
  });
  if (joinFields.length === 0) {
    return {
      kind: "clarify",
      question: buildCompanyClarifyQuestion(facet),
    };
  }

  const joinSortField = findPreferredColumn(joinCandidate.columns, TIME_FIELD_CANDIDATES);

  return {
    kind: "intent",
    summary: buildCompanySummary(facet),
    intent: {
      sourceId: baseCandidate.source.id,
      entityName: baseCandidate.table.name,
      entityType: normalizeEntityType(baseCandidate.table.table_type),
      ...(baseCandidate.table.schema ? { schema: baseCandidate.table.schema } : {}),
      baseAlias,
      fields: [...baseFields, ...joinFields],
      joins: [
        {
          entityName: joinCandidate.table.name,
          entityType: normalizeEntityType(joinCandidate.table.table_type),
          ...(joinCandidate.table.schema ? { schema: joinCandidate.table.schema } : {}),
          alias: joinAlias,
          joinType: "left",
          on: [joinCondition],
        },
      ],
      filters: [
        {
          field: buildFieldRef(baseAlias, companyNameColumn),
          op: "contains_compact",
          value: compactCompanyKeyword,
        },
      ],
      ...(joinSortField
        ? {
            sort: [
              {
                field: buildFieldRef(joinAlias, joinSortField),
                direction: "desc" as const,
              },
            ],
          }
        : baseSortField
          ? {
              sort: [
                {
                  field: buildFieldRef(baseAlias, baseSortField),
                  direction: "desc" as const,
                },
              ],
            }
          : {}),
      limit: 1000,
      outputFormat: "csv",
    },
  };
}

export async function resolveExplicitTableInspectionAnswer(params: {
  userInput: string;
  sources: RuntimeExportSourceConfig[];
}): Promise<ExportAgentDecision | null> {
  const semanticAnswer = await resolveSemanticTableInspectionFromCurrentContext(params);
  if (semanticAnswer) {
    return semanticAnswer;
  }

  const request = parseExplicitTableInspectionRequest(params.userInput);
  if (!request) {
    return null;
  }
  return inspectQualifiedTableAcrossSources({
    sources: params.sources,
    request,
  });
}

function classifyExportMetadataQuestion(text: string): ExportMetadataQuestionKind | null {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized || !isExportMetadataQuestion(normalized)) {
    return null;
  }
  if (/(数据源|source|sources)/u.test(normalized)) {
    return "sources";
  }
  if (/(?:库|database|schema|schemas)/u.test(normalized)) {
    return "namespaces";
  }
  return "generic";
}

function extractNamespaceExistenceTarget(params: {
  userInput: string;
  originalRequest?: string;
}): string | null {
  const rawInput = String(params.userInput ?? "").trim();
  if (!rawInput) return null;

  const hasExistenceSignal = /(?:是否有|有没有|有无|在不在|存在(?:吗)?|有吗|在吗)/u.test(rawInput);
  const hasNamespaceSignal = /(?:库|database|schema|数据库)/iu.test(rawInput);
  const hasMetadataContext = hasNamespaceSignal
    || isExportMetadataQuestion(rawInput)
    || (isExportMetadataQuestion(params.originalRequest) && /(?:里面|里|其中|上面|这里|当前|是否|有|存在|在不在)/u.test(rawInput));
  if (!hasMetadataContext || !hasExistenceSignal) {
    return null;
  }

  const patterns = [
    /(?:里面|里|其中|上面|这里|当前(?:这些)?|这些)?\s*(?:是否有|有没有|有无|在不在|存在(?:吗)?)\s*([a-zA-Z0-9_-]{1,64})\s*(?:的)?\s*(?:库|database|schema|数据库)?/iu,
    /([a-zA-Z0-9_-]{1,64})\s*(?:这个|的)?\s*(?:库|database|schema|数据库)\s*(?:是否有|有没有|有无|在不在|存在(?:吗)?|有吗|在吗|可查吗|能查吗)/iu,
    /(?:里面|里|其中|上面|这里|当前(?:这些)?|这些)?\s*([a-zA-Z0-9_-]{1,64})\s*(?:有吗|在吗|在不在|存在(?:吗)?)/iu,
  ];
  for (const pattern of patterns) {
    const matched = rawInput.match(pattern);
    const target = matched?.[1]?.trim();
    if (!target) continue;
    return normalizeIdentifierCandidates(target)[0] ?? null;
  }
  return null;
}

function formatReadableList(items: readonly string[], maxItems = 12): string {
  const normalized = [...new Set(items.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (normalized.length === 0) return "无";
  if (normalized.length <= maxItems) {
    return normalized.join("、");
  }
  return `${normalized.slice(0, maxItems).join("、")} 等 ${normalized.length} 个`;
}

function buildSourceLabel(source: RuntimeExportSourceConfig): string {
  const alias = String(source.export_alias ?? "").trim();
  const database = String(source.database ?? "").trim();
  const defaultSchema = String(source.export_default_schema ?? "").trim();
  const scope = source.scope === "team" ? "团队" : "个人";
  const parts = [
    `${source.name}（${scope} / ${source.db_type}）`,
    alias ? `别名 ${alias}` : "",
    database ? `默认库 ${database}` : "",
    defaultSchema ? `默认 schema ${defaultSchema}` : "",
  ].filter(Boolean);
  return parts.join("，");
}

async function listReadableNamespacesForSource(
  source: RuntimeExportSourceConfig,
): Promise<{
  source: RuntimeExportSourceConfig;
  namespaceKind: "database" | "schema";
  namespaces: string[];
  restricted?: boolean;
  error?: string;
}> {
  if (source.scope === "team") {
    return {
      source,
      namespaceKind: source.db_type === "mysql" || source.db_type === "mongodb" ? "database" : "schema",
      namespaces: [],
      restricted: true,
    };
  }

  if (source.db_type === "sqlite") {
    const fallback = String(source.database ?? "").trim()
      || String(source.file_path ?? "").trim()
      || "main";
    return {
      source,
      namespaceKind: "database",
      namespaces: [fallback],
    };
  }

  try {
    await ensureExportSourceConnected(source);
    const namespaces = await invoke<string[]>("db_list_schemas", { connId: source.id });
    const fallback = String(source.database ?? "").trim();
    return {
      source,
      namespaceKind: source.db_type === "mysql" || source.db_type === "mongodb" ? "database" : "schema",
      namespaces: namespaces.length > 0 ? namespaces : (fallback ? [fallback] : []),
    };
  } catch (error) {
    return {
      source,
      namespaceKind: source.db_type === "mysql" || source.db_type === "mongodb" ? "database" : "schema",
      namespaces: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildDatabaseProtocolPrompt(params: {
  userInput: string;
  originalRequest?: string;
  sources: RuntimeExportSourceConfig[];
}): string {
  const sourceSummary = params.sources
    .map((source) => {
      const browseMode = source.scope === "personal" ? "raw_browse=allowed" : "raw_browse=forbidden";
      return [
        `- id=${source.id}`,
        `name=${source.name}`,
        `scope=${source.scope}`,
        `type=${source.db_type}`,
        source.database ? `database=${source.database}` : "",
        source.export_default_schema ? `defaultSchema=${source.export_default_schema}` : "",
        browseMode,
      ].filter(Boolean).join(", ");
    })
    .join("\n");

  return [
    "你是 IM 数据库模式的只读协议路由器。",
    "你的任务不是直接回答用户，而是为运行时选择下一步只读数据库动作。",
    "只输出严格 JSON，不要输出 markdown、解释、代码块或自然语言。",
    "协议版本固定为 dbproto/v1。",
    "允许的 action 只有：delegate、list_namespaces、namespace_exists、list_tables、describe_table、sample_table。",
    "当用户在问“有哪些库/schema”“有没有某个库/schema”“某个库里有哪些表”“这张表有哪些字段”“看一下样本数据”时，优先输出协议。",
    "当用户是在查业务数据、导出数据、筛选企业/订单、需要联表、需要真正执行导出时，输出 delegate。",
    "不能为团队共享源选择原始 schema/table 浏览动作；这些动作只能针对 personal source。",
    "如果只有一个 personal source，可以省略 sourceId；如果有多个 personal source，尽量明确 sourceId。",
    "协议示例：",
    '{"version":"dbproto/v1","action":"delegate","reason":"需要进一步业务查询或导出"}',
    '{"version":"dbproto/v1","action":"list_namespaces","sourceId":"personal-mysql"}',
    '{"version":"dbproto/v1","action":"namespace_exists","sourceId":"personal-mysql","namespace":"athena_user"}',
    '{"version":"dbproto/v1","action":"list_tables","sourceId":"personal-mysql","namespace":"athena_user"}',
    '{"version":"dbproto/v1","action":"describe_table","sourceId":"personal-mysql","namespace":"athena_user","table":"company"}',
    '{"version":"dbproto/v1","action":"sample_table","sourceId":"personal-mysql","namespace":"athena_user","table":"company","limit":5}',
    "可用数据源：",
    sourceSummary || "- 无",
    params.originalRequest?.trim() ? `历史上下文：${params.originalRequest.trim()}` : "",
    `当前用户消息：${params.userInput.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function getNamespaceKind(source: RuntimeExportSourceConfig): "database" | "schema" {
  return source.db_type === "mysql" || source.db_type === "mongodb" ? "database" : "schema";
}

function resolveQualifiedDirectiveTable(directive: DatabaseProtocolDirective): string | null {
  const table = String(directive.table ?? "").trim();
  if (!table) return null;
  if (table.includes(".")) return table;
  const namespace = String(directive.namespace ?? "").trim();
  return namespace ? `${namespace}.${table}` : table;
}

function formatSampleRows(params: {
  columns: string[];
  rows: unknown[][];
  maxRows?: number;
}): string[] {
  const maxRows = params.maxRows ?? 5;
  return params.rows.slice(0, maxRows).map((row, index) => {
    const cells = params.columns.map((column, columnIndex) => `${column}=${stringifySampleValue(row[columnIndex])}`);
    return `${index + 1}. ${cells.join("；")}`;
  });
}

function formatTableListAnswer(params: {
  source: RuntimeExportSourceConfig;
  namespace?: string;
  tables: TableInfo[];
}): string {
  const namespaceKind = getNamespaceKind(params.source);
  const displayTarget = params.namespace
    ? `${namespaceKind} ${params.namespace}`
    : (params.source.database?.trim() || params.source.export_default_schema?.trim() || "当前默认范围");
  const tableNames = params.tables.map((table) => {
    const schema = String(table.schema ?? "").trim();
    const name = String(table.name ?? "").trim();
    if (!schema || schema === params.namespace) return name;
    return `${schema}.${name}`;
  });

  return [
    `已读取 ${buildSourceLabel(params.source)} 下 ${displayTarget} 的表 / 视图列表。`,
    params.tables.length > 0
      ? `共 ${params.tables.length} 个对象：${formatReadableList(tableNames, 20)}`
      : "当前没有读取到可见表 / 视图。",
  ].join("\n");
}

function resolveProtocolSource(params: {
  directive: DatabaseProtocolDirective;
  sources: RuntimeExportSourceConfig[];
  allowAllPersonal?: boolean;
}): {
  sources?: RuntimeExportSourceConfig[];
  decision?: ExportAgentDecision;
} {
  const personalSources = params.sources.filter((source) => source.scope === "personal");
  if (personalSources.length === 0) {
    return {
      decision: {
        kind: "reject",
        reason: "当前没有可直接浏览原始库表结构的个人数据源，请先配置个人数据源。",
      },
    };
  }

  if (params.directive.sourceId) {
    const matchedSource = params.sources.find((source) =>
      source.id === params.directive.sourceId || source.originSourceId === params.directive.sourceId,
    );
    if (!matchedSource) {
      return {
        decision: {
          kind: "clarify",
          question: `我没有找到数据源 ${params.directive.sourceId}。请先告诉我你想查哪个数据源。`,
        },
      };
    }
    if (matchedSource.scope !== "personal") {
      return {
        decision: {
          kind: "answer",
          answer: "团队共享数据源当前不直接开放原始库 / 表 / 字段浏览，请优先使用团队已发布数据集。",
        },
      };
    }
    return { sources: [matchedSource] };
  }

  if (params.allowAllPersonal) {
    return { sources: personalSources };
  }

  if (personalSources.length === 1) {
    return { sources: personalSources };
  }

  return {
    decision: {
      kind: "clarify",
      question: `当前有 ${personalSources.length} 个个人数据源，请先告诉我你想查哪个数据源：${personalSources.map((source) => source.name).join("、")}。`,
    },
  };
}

async function executeDatabaseProtocolDirective(params: {
  directive: DatabaseProtocolDirective;
  sources: RuntimeExportSourceConfig[];
}): Promise<ExportAgentDecision | null> {
  const { directive } = params;
  if (directive.action === "delegate") {
    return null;
  }

  if (directive.action === "list_namespaces" || directive.action === "namespace_exists") {
    const resolved = resolveProtocolSource({
      directive,
      sources: params.sources,
      allowAllPersonal: true,
    });
    if (resolved.decision) return resolved.decision;
    const namespaceResults = await Promise.all(
      (resolved.sources ?? []).map((source) => listReadableNamespacesForSource(source)),
    );

    if (directive.action === "list_namespaces") {
      return {
        kind: "answer",
        answer: [
          `当前可读取的库 / schema 信息如下（共 ${(resolved.sources ?? []).length} 个个人数据源）：`,
          namespaceResults.map((result, index) => {
            if (result.error) {
              return `${index + 1}. ${buildSourceLabel(result.source)}：暂时读取失败（${result.error}）`;
            }
            return `${index + 1}. ${buildSourceLabel(result.source)}：可读 ${result.namespaceKind} 有 ${formatReadableList(result.namespaces)}`;
          }).join("\n"),
        ].join("\n"),
      };
    }

    const target = String(directive.namespace ?? directive.target ?? "").trim();
    const targetCandidates = normalizeIdentifierCandidates(target).map((item) => item.toLowerCase());
    const matched = namespaceResults.flatMap((result, index) => {
      if (result.error) return [];
      const namespace = result.namespaces.find((item) =>
        targetCandidates.includes(String(item ?? "").trim().toLowerCase()),
      );
      if (!namespace) return [];
      return [{ index, result, namespace }];
    });

    if (matched.length > 0) {
      return {
        kind: "answer",
        answer: [
          `有，当前可读取的库 / schema 里包含 ${target}。`,
          matched.map((item) =>
            `${item.index + 1}. ${buildSourceLabel(item.result.source)}：包含 ${item.result.namespaceKind} ${item.namespace}`,
          ).join("\n"),
        ].join("\n"),
      };
    }

    return {
      kind: "answer",
      answer: `目前没在当前可读取的库 / schema 列表里看到 ${target}。`,
    };
  }

  const resolved = resolveProtocolSource({
    directive,
    sources: params.sources,
    allowAllPersonal: false,
  });
  if (resolved.decision) return resolved.decision;
  const source = resolved.sources?.[0];
  if (!source) return null;

  await ensureExportSourceConnected(source);

  if (directive.action === "list_tables") {
    const namespace = String(directive.namespace ?? "").trim();
    if (source.db_type === "mysql" && !namespace && !source.database?.trim()) {
      return {
        kind: "clarify",
        question: "当前这个 MySQL 数据源下有多个库，请先告诉我你想看哪个库，或者先让我列出可读库。",
      };
    }
    const tables = await invoke<TableInfo[]>("db_list_tables", {
      connId: source.id,
      schema: namespace || null,
    });
    return {
      kind: "answer",
      answer: formatTableListAnswer({
        source,
        namespace: namespace || undefined,
        tables,
      }),
    };
  }

  const qualifiedTable = resolveQualifiedDirectiveTable(directive);
  if (!qualifiedTable) {
    return {
      kind: "clarify",
      question: "请先告诉我你想看的具体表名。",
    };
  }

  if (source.db_type === "mysql" && !qualifiedTable.includes(".") && !source.database?.trim()) {
    return {
      kind: "clarify",
      question: "当前这个 MySQL 数据源下有多个库，请补充库名后再看表结构或样本。",
    };
  }

  if (directive.action === "describe_table") {
    const columns = await invoke<ColumnInfo[]>("db_describe_table", {
      connId: source.id,
      table: qualifiedTable,
    });
    return {
      kind: "answer",
      answer: buildTableInspectionAnswer({
        qualifiedName: qualifiedTable,
        source,
        columns,
      }),
    };
  }

  if (directive.action === "sample_table") {
    const limit = directive.limit ?? 5;
    const [columns, sample] = await Promise.all([
      invoke<ColumnInfo[]>("db_describe_table", {
        connId: source.id,
        table: qualifiedTable,
      }),
      invoke<SampleTableResult>("db_sample_table", {
        connId: source.id,
        table: qualifiedTable,
        limit,
      }),
    ]);
    return {
      kind: "answer",
      answer: [
        buildTableInspectionAnswer({
          qualifiedName: qualifiedTable,
          source,
          columns,
        }),
        sample.rows.length > 0
          ? ["样本数据：", ...formatSampleRows({ columns: sample.columns, rows: sample.rows, maxRows: limit })].join("\n")
          : "当前样本为空，可能是空表，或当前条件下没有可读数据。",
      ].filter(Boolean).join("\n"),
    };
  }

  return null;
}

async function runDatabaseProtocolRouter(params: {
  userInput: string;
  originalRequest?: string;
  sources: RuntimeExportSourceConfig[];
}): Promise<ExportAgentDecision | null> {
  const ai = getMToolsAI("agent");
  const result = await ai.chat({
    messages: [
      {
        role: "system",
        content: buildDatabaseProtocolPrompt({
          userInput: params.userInput,
          originalRequest: params.originalRequest,
          sources: params.sources,
        }),
      },
    ],
    temperature: 0.1,
    skipTools: true,
    skipMemory: true,
  });

  const directive = parseDatabaseProtocolDirective(result.content);
  if (!directive) {
    return null;
  }

  log.info("Database protocol directive", {
    action: directive.action,
    sourceId: directive.sourceId,
    namespace: directive.namespace,
    table: directive.table,
    limit: directive.limit,
  });
  return executeDatabaseProtocolDirective({
    directive,
    sources: params.sources,
  });
}

export async function resolveExportMetadataAnswer(params: {
  userInput: string;
  sources: RuntimeExportSourceConfig[];
  datasets: RuntimeExportDatasetDefinition[];
  originalRequest?: string;
}): Promise<ExportAgentDecision | null> {
  const namespaceExistenceTarget = extractNamespaceExistenceTarget({
    userInput: params.userInput,
    originalRequest: params.originalRequest,
  });
  const questionKind = classifyExportMetadataQuestion(params.userInput);
  if (!questionKind && !namespaceExistenceTarget) {
    return null;
  }

  const enabledDatasets = params.datasets.filter((dataset) => dataset.enabled !== false);
  const sourceLines = params.sources.map((source, index) => `${index + 1}. ${buildSourceLabel(source)}`);

  if (questionKind === "sources") {
    const answerParts = [
      `当前可用数据源共 ${params.sources.length} 个。`,
      sourceLines.length > 0 ? sourceLines.join("\n") : "暂时没有可用数据源。",
    ];
    if (enabledDatasets.length > 0) {
      answerParts.push(
        `另外有 ${enabledDatasets.length} 个可直接导出的数据集：${formatReadableList(
          enabledDatasets.map((dataset) => dataset.displayName),
          10,
        )}。`,
      );
    }
    answerParts.push("当前只支持只读查询/导出，不会写入数据库。");
    return {
      kind: "answer",
      answer: answerParts.filter(Boolean).join("\n"),
    };
  }

  const namespaceResults = await Promise.all(
    params.sources.map((source) => listReadableNamespacesForSource(source)),
  );

  if (namespaceExistenceTarget) {
    const targetCandidates = normalizeIdentifierCandidates(namespaceExistenceTarget).map((item) => item.toLowerCase());
    const matchedSources = namespaceResults.flatMap((result, index) => {
      if (result.restricted || result.error) return [];
      const matchedNamespace = result.namespaces.find((namespace) =>
        targetCandidates.includes(String(namespace ?? "").trim().toLowerCase()),
      );
      if (!matchedNamespace) return [];
      return [{
        index,
        source: result.source,
        namespace: matchedNamespace,
        namespaceKind: result.namespaceKind,
      }];
    });

    if (matchedSources.length > 0) {
      const lines = matchedSources.map((item) =>
        `${item.index + 1}. ${buildSourceLabel(item.source)}：包含 ${item.namespaceKind} ${item.namespace}`,
      );
      return {
        kind: "answer",
        answer: [
          `有，当前可读取的库 / schema 里包含 ${namespaceExistenceTarget}。`,
          lines.join("\n"),
        ].join("\n"),
      };
    }

    const readableCount = namespaceResults.filter((result) => !result.restricted && !result.error).length;
    const failedCount = namespaceResults.filter((result) => result.error).length;
    const restrictedCount = namespaceResults.filter((result) => result.restricted).length;
    const answerParts = [
      `目前没在当前可读取的库 / schema 列表里看到 ${namespaceExistenceTarget}。`,
      readableCount > 0 ? `已成功核对 ${readableCount} 个个人数据源。` : "",
      failedCount > 0 ? `另有 ${failedCount} 个数据源本次读取失败。` : "",
      restrictedCount > 0 ? `还有 ${restrictedCount} 个团队共享数据源不开放原始 database/schema 浏览。` : "",
    ].filter(Boolean);
    return {
      kind: "answer",
      answer: answerParts.join("\n"),
    };
  }

  const namespaceLines = namespaceResults.map((result, index) => {
    if (result.restricted) {
      return `${index + 1}. ${buildSourceLabel(result.source)}：团队共享源当前不直接开放原始 ${result.namespaceKind} 浏览，请优先使用团队已发布数据集。`;
    }
    if (result.error) {
      return `${index + 1}. ${buildSourceLabel(result.source)}：暂时读取失败（${result.error}）`;
    }
    return `${index + 1}. ${buildSourceLabel(result.source)}：可读 ${result.namespaceKind} 有 ${formatReadableList(result.namespaces)}`;
  });

  const answerParts = [
    questionKind === "namespaces"
      ? `当前可读取的库 / schema 信息如下（共 ${params.sources.length} 个数据源）：`
      : `当前可用数据源与可读取库 / schema 如下（共 ${params.sources.length} 个数据源）：`,
    namespaceLines.join("\n"),
  ];
  if (enabledDatasets.length > 0) {
    answerParts.push(
      `团队/本地已整理的数据集还有：${formatReadableList(
        enabledDatasets.map((dataset) => dataset.displayName),
        10,
      )}。`,
    );
  }
  answerParts.push("如果你接下来要查业务数据，可以直接说“帮我查订单相关表”或“帮我导出某企业详细信息”。");
  return {
    kind: "answer",
    answer: answerParts.filter(Boolean).join("\n"),
  };
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
      description: "列出当前可用的个人数据集和团队已发布数据集，优先使用这些数据集理解业务请求。",
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
          aliases: dataset.aliases,
          intentTags: dataset.intentTags,
          examplePrompts: dataset.examplePrompts,
          keywordField: dataset.keywordField,
          baseAlias: dataset.baseAlias,
          relations: dataset.relations,
          enabled: dataset.enabled,
        })),
      }),
    },
    {
      name: "describe_export_dataset",
      description: "查看一个个人数据集或团队已发布数据集的字段、别名和底层映射。",
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
            aliases: dataset.aliases,
            intentTags: dataset.intentTags,
            examplePrompts: dataset.examplePrompts,
            keywordField: dataset.keywordField,
            baseAlias: dataset.baseAlias,
            relations: dataset.relations,
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
      name: "list_export_namespaces",
      description: "列出某个个人数据源当前可访问的 database 或 schema，用于先缩小搜索范围。",
      readonly: true,
      parameters: {
        source_id: { type: "string", description: "数据源 ID" },
      },
      execute: async (params) => {
        const sourceId = String(params.source_id ?? "").trim();
        if (!sourceId) return { error: "source_id 不能为空" };
        const source = getSource(sourceId);
        if (source.scope === "team") {
          return { error: "团队共享数据源不直接开放原始 database/schema 浏览，请优先使用已发布数据集。" };
        }
        await ensureExportSourceConnected(source);
        const namespaces = await invoke<string[]>("db_list_schemas", { connId: sourceId });
        return {
          namespaces,
          namespaceKind:
            source.db_type === "mysql" || source.db_type === "mongodb"
              ? "database"
              : source.db_type === "postgres"
                ? "schema"
                : "schema",
        };
      },
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
        if (source.db_type === "mysql" && !schema && !source.database?.trim()) {
          return { error: "当前是 MySQL 实例级连接，请先调用 list_export_namespaces 选择 database，或用 search_export_tables 搜索候选表。" };
        }
        const tables = await invoke<TableInfo[]>("db_list_tables", {
          connId: sourceId,
          schema: schema || null,
        });
        return { tables };
      },
    },
    {
      name: "search_export_tables",
      description: "按业务关键词搜索候选表；当用户不知道表名时，先用这个工具。",
      readonly: true,
      parameters: {
        source_id: { type: "string", description: "数据源 ID" },
        keyword: { type: "string", description: "业务关键词，例如 订单、退款、客户、手机号" },
        schema: { type: "string", description: "可选 database/schema 名", required: false },
        limit: { type: "number", description: "最多返回多少张候选表", required: false },
      },
      execute: async (params) => {
        const sourceId = String(params.source_id ?? "").trim();
        const keyword = String(params.keyword ?? "").trim();
        if (!sourceId || !keyword) {
          return { error: "source_id 和 keyword 都不能为空" };
        }
        const source = getSource(sourceId);
        if (source.scope === "team") {
          return { error: "团队共享数据源不直接开放原始表搜索，请优先使用已发布数据集。" };
        }
        await ensureExportSourceConnected(source);
        const schema = String(params.schema ?? "").trim();
        const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.min(20, Math.floor(params.limit)))
          : 8;
        const searchKeywords = expandBusinessSearchKeywords(keyword);
        const searchResults = await Promise.all(
          searchKeywords.map((searchKeyword) =>
            invoke<TableSearchResult[]>("db_search_tables", {
              connId: sourceId,
              keyword: searchKeyword,
              schema: schema || null,
              limit,
            })),
        );
        const tables = mergeTableSearchResults(searchResults.flat()).slice(0, limit);
        return { tables, searchKeywords };
      },
    },
    {
      name: "describe_export_table",
      description: "查看某张表、视图或 collection 的字段结构；如果候选结果带了 schema/database，传入 schema.table 形式。",
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
    {
      name: "sample_export_table",
      description: "抽样预览某张表的少量数据，用于确认是不是用户真正想要的那张表；如果候选结果带了 schema/database，传入 schema.table 形式。",
      readonly: true,
      parameters: {
        source_id: { type: "string", description: "数据源 ID" },
        table: { type: "string", description: "表名，必要时带上 schema/database 前缀" },
        limit: { type: "number", description: "抽样行数，默认 5", required: false },
      },
      execute: async (params) => {
        const sourceId = String(params.source_id ?? "").trim();
        const table = String(params.table ?? "").trim();
        if (!sourceId || !table) {
          return { error: "source_id 和 table 都不能为空" };
        }
        const source = getSource(sourceId);
        if (source.scope === "team") {
          return { error: "团队共享数据源不直接开放原始样本探查，请优先使用已发布数据集。" };
        }
        await ensureExportSourceConnected(source);
        const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.min(10, Math.floor(params.limit)))
          : 5;
        const sample = await invoke<SampleTableResult>("db_sample_table", {
          connId: sourceId,
          table,
          limit,
        });
        return sample;
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
      const aliases = dataset.aliases?.length ? `aliases=${dataset.aliases.join("|")}` : "";
      const intentTags = dataset.intentTags?.length ? `tags=${dataset.intentTags.join("|")}` : "";
      const keywordField = dataset.keywordField ? `keywordField=${dataset.keywordField}` : "";
      const relations = dataset.relations?.length
        ? `relations=${dataset.relations
          .filter((relation) => relation.enabled !== false)
          .map((relation) => relation.name)
          .join("|")}`
        : "";
      const scopeLabel = dataset.scope === "team" ? `[团队:${dataset.teamId}]` : "[个人]";
      return `- ${scopeLabel} ${dataset.displayName} -> ${dataset.sourceId}:${dataset.schema ? `${dataset.schema}.` : ""}${dataset.entityName} (${dataset.entityType}) ${defaultFields} ${fieldNames ? `fields=${fieldNames}` : ""} ${aliases} ${intentTags} ${keywordField} ${relations} ${dataset.description}`.trim();
    })
    .join("\n");

  return [
    "你是一个钉钉数据导出专员，只负责把自然语言请求整理成安全的导出意图。",
    "你的用户是运营人员，他们通常不知道真实表名、字段名、schema，也不会写 SQL。",
    "你必须先通过工具查看可用数据源、已发布数据集、database/schema、候选表、字段和样本数据，再决定导出意图；禁止臆造表名、字段名、schema。",
    "当前能力边界：",
    "- 对于导出请求，只输出 CSV 导出意图。",
    "- 对于“目前能读取哪些库 / 有哪些数据源 / 有哪些 schema / 有哪些表 / 这张表有什么字段”这类元数据问题，直接回答，不要强行生成导出意图。",
    "- 优先使用已经整理好的数据集理解业务请求，尤其是团队已发布数据集。",
    "- 优先单表明细导出；只有当请求明确需要两张或三张 SQL 表组合时，才生成联表导出。",
    "- 对个人数据源：先找数据源，再找 database/schema，再搜索候选表，再看字段或样本确认。",
    "- 团队共享数据源不允许直接浏览原始表结构时，只能基于已发布数据集做导出判断。",
    "- 不要要求用户提供表名；只有业务口径无法确定时，才提一个最关键的问题。",
    "- 在 clarify / answer / reject 文案中，禁止直接输出物理表名、schema、database、字段名；只能用业务口径表达。",
    "- 联表仅用于个人 SQL 数据源（sqlite/postgres/mysql）；MongoDB、团队共享数据集、本轮都不做联表。",
    "- 如果生成联表导出，必须显式提供 fields，并给输出列设置易读 alias；filters/sort/join on 中的字段必须写成 alias.column 或 table.column。",
    "- 联表最多 2 个 join；优先使用主键/外键或同名 *_id 字段做等值连接，不做聚合、子查询、窗口函数。",
    "- 生成联表前，先查看相关候选表的字段结构；只有确认 join 键后，才能输出 joins。",
    "- 如果请求明显超出当前已知 schema，请直接 reject。",
    "- 即使是直接回答元数据问题，也必须先调用工具确认后再回答。",
    "你的最终回答必须是严格 JSON，且只能是以下四种之一：",
    '{"kind":"clarify","question":"..."}',
    '{"kind":"answer","answer":"..."}',
    '{"kind":"reject","reason":"..."}',
    '{"kind":"intent","summary":"...","intent":{"sourceId":"...","sourceScope":"personal|team","teamId":"...","datasetId":"...","entityName":"...","entityType":"table|view|collection","schema":"...","baseAlias":"...","fields":[{"field":"base.name","alias":"company_name"}],"joins":[{"entityName":"...","schema":"...","alias":"...","joinType":"inner|left","on":[{"left":"base.id","op":"eq","right":"detail.base_id"}]}],"filters":[{"field":"...","op":"eq|gt|gte|lt|lte|like|contains|in","value":"..."}],"sort":[{"field":"...","direction":"asc|desc"}],"limit":1000,"outputFormat":"csv"}}',
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

async function runModelFirstExportDecision(params: {
  userInput: string;
  sources: RuntimeExportSourceConfig[];
  datasets: RuntimeExportDatasetDefinition[];
  originalRequest?: string;
}): Promise<ExportAgentDecision> {
  const ai = getMToolsAI("agent");
  const aiConfig = getResolvedAIConfigForMode("agent");
  const agent = new ReActAgent(
    ai,
    createExportTools(params.sources, params.datasets),
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
      sources: params.sources,
      datasets: params.datasets,
      originalRequest: params.originalRequest,
    }),
  );

  log.info("Export agent answer", { answer: answer.slice(0, 1200) });
  return parseExportAgentResponse(answer, { userInput: params.userInput });
}

async function resolveRuleFallbackExportDecision(params: {
  userInput: string;
  sources: RuntimeExportSourceConfig[];
  datasets: RuntimeExportDatasetDefinition[];
  originalRequest?: string;
}): Promise<ExportAgentDecision | null> {
  const metadataAnswer = await resolveExportMetadataAnswer({
    userInput: params.userInput,
    sources: params.sources,
    datasets: params.datasets,
    originalRequest: params.originalRequest,
  });
  if (metadataAnswer) {
    log.info("Export request resolved by metadata fallback", {
      userInput: params.userInput.slice(0, 200),
      kind: metadataAnswer.kind,
    });
    return metadataAnswer;
  }

  const explicitTableInspection = await resolveExplicitTableInspectionAnswer({
    userInput: params.userInput,
    sources: params.sources,
  });
  if (explicitTableInspection) {
    log.info("Export request resolved by explicit table inspection fallback", {
      userInput: params.userInput.slice(0, 200),
      kind: explicitTableInspection.kind,
    });
    return explicitTableInspection;
  }

  const deterministicDecision = await resolveDeterministicExportDecision({
    userInput: params.userInput,
    originalRequest: params.originalRequest,
    sources: params.sources,
    datasets: params.datasets,
  });
  if (deterministicDecision) {
    log.info("Export request resolved by deterministic fallback", {
      userInput: params.userInput.slice(0, 200),
      kind: deterministicDecision.kind,
    });
    return deterministicDecision;
  }

  return null;
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

  try {
    const protocolDecision = await runDatabaseProtocolRouter({
      userInput: params.userInput,
      originalRequest: params.originalRequest,
      sources,
    });
    if (protocolDecision) {
      log.info("Export request resolved by dbproto router", {
        userInput: params.userInput.slice(0, 200),
        kind: protocolDecision.kind,
      });
      return protocolDecision;
    }
  } catch (error) {
    log.warn("dbproto router failed, falling through to agent routing", {
      userInput: params.userInput.slice(0, 200),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let modelDecision: ExportAgentDecision | null = null;
  let modelError: unknown = null;
  try {
    modelDecision = await runModelFirstExportDecision({
      userInput: params.userInput,
      sources,
      datasets,
      originalRequest: params.originalRequest,
    });
    log.info("Export request resolved by model-first agent", {
      userInput: params.userInput.slice(0, 200),
      kind: modelDecision.kind,
    });
    if (modelDecision.kind !== "reject") {
      return modelDecision;
    }
  } catch (error) {
    modelError = error;
    log.warn("Model-first export routing failed, trying rule fallback", {
      userInput: params.userInput.slice(0, 200),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const fallbackDecision = await resolveRuleFallbackExportDecision({
    userInput: params.userInput,
    sources,
    datasets,
    originalRequest: params.originalRequest,
  });
  if (fallbackDecision) {
    return fallbackDecision;
  }

  if (modelDecision) {
    return modelDecision;
  }

  if (modelError) {
    return {
      kind: "reject",
      reason: "这次查数没有稳定跑通。你可以稍后重试，或者把需求说得更具体一些，例如“查询某公司的基础信息”或“查看某个库里有哪些表”。",
    };
  }

  return {
    kind: "reject",
    reason: "当前请求暂时还不能稳定处理，请换一种更具体的表达再试一次。",
  };
}
