export type DatabaseProtocolAction =
  | "delegate"
  | "list_namespaces"
  | "namespace_exists"
  | "list_tables"
  | "describe_table"
  | "sample_table"
  | "search_tables"
  | "list_datasets"
  | "describe_dataset";

export interface DatabaseProtocolDirective {
  version: "dbproto/v1";
  action: DatabaseProtocolAction;
  sourceId?: string;
  namespace?: string;
  table?: string;
  datasetId?: string;
  keyword?: string;
  target?: string;
  limit?: number;
  reason?: string;
}

function unwrapMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  return trimmed;
}

function normalizeString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function normalizeLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (normalized <= 0) return undefined;
  return Math.min(normalized, 10);
}

function normalizeDirective(raw: unknown): DatabaseProtocolDirective | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (String(candidate.version ?? "").trim() !== "dbproto/v1") return null;

  const action = String(candidate.action ?? "").trim() as DatabaseProtocolAction;
  if (![
    "delegate",
    "list_namespaces",
    "namespace_exists",
    "list_tables",
    "describe_table",
    "sample_table",
    "search_tables",
    "list_datasets",
    "describe_dataset",
  ].includes(action)) {
    return null;
  }

  const directive: DatabaseProtocolDirective = {
    version: "dbproto/v1",
    action,
    ...(normalizeString(candidate.sourceId) ? { sourceId: normalizeString(candidate.sourceId) } : {}),
    ...(normalizeString(candidate.namespace) ? { namespace: normalizeString(candidate.namespace) } : {}),
    ...(normalizeString(candidate.table) ? { table: normalizeString(candidate.table) } : {}),
    ...(normalizeString(candidate.datasetId) ? { datasetId: normalizeString(candidate.datasetId) } : {}),
    ...(normalizeString(candidate.keyword) ? { keyword: normalizeString(candidate.keyword) } : {}),
    ...(normalizeString(candidate.target) ? { target: normalizeString(candidate.target) } : {}),
    ...(normalizeString(candidate.reason) ? { reason: normalizeString(candidate.reason) } : {}),
    ...(normalizeLimit(candidate.limit) ? { limit: normalizeLimit(candidate.limit) } : {}),
  };

  if (directive.action === "namespace_exists" && !(directive.namespace || directive.target)) {
    return null;
  }
  if (["describe_table", "sample_table"].includes(directive.action) && !directive.table) {
    return null;
  }
  if (directive.action === "search_tables" && !directive.keyword) {
    return null;
  }
  if (directive.action === "describe_dataset" && !(directive.datasetId || directive.target)) {
    return null;
  }

  return directive;
}

export function parseDatabaseProtocolDirective(text?: string | null): DatabaseProtocolDirective | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;

  const unfenced = unwrapMarkdownFence(trimmed);
  const candidates = [unfenced];
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(unfenced.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeDirective(parsed);
      if (normalized) return normalized;
    } catch {
      continue;
    }
  }

  return null;
}
