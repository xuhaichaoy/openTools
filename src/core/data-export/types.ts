export interface ExportSourceConfig {
  id: string;
  name: string;
  db_type: "sqlite" | "postgres" | "mysql" | "mongodb";
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  file_path?: string;
  connection_string?: string;
  export_enabled?: boolean;
  export_alias?: string;
  export_default_schema?: string;
  max_export_rows?: number;
}

export interface ExportFilter {
  field: string;
  op: string;
  value: unknown;
}

export interface ExportSort {
  field: string;
  direction: "asc" | "desc";
}

export interface StructuredExportIntent {
  sourceId: string;
  entityName: string;
  entityType?: "table" | "view" | "collection";
  schema?: string;
  fields?: string[];
  filters?: ExportFilter[];
  sort?: ExportSort[];
  limit?: number;
  outputFormat?: "csv";
}

export interface ExportPreview {
  previewToken: string;
  sourceKind: string;
  canonicalQuery: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  previewRowCount: number;
  estimatedTotal?: number | null;
}

export interface ExportResult {
  previewToken: string;
  filePath: string;
  rowCount: number;
  columns: string[];
}

export type ExportAgentDecision =
  | {
      kind: "clarify";
      question: string;
    }
  | {
      kind: "reject";
      reason: string;
    }
  | {
      kind: "intent";
      summary?: string;
      intent: StructuredExportIntent;
    };

export interface ExportSessionState {
  key: string;
  channelId: string;
  conversationId: string;
  status:
    | "awaiting_clarification"
    | "awaiting_confirmation"
    | "exporting";
  createdAt: number;
  updatedAt: number;
  originalRequest: string;
  clarificationQuestion?: string;
  preview?: ExportPreview;
  lastIntent?: StructuredExportIntent;
}
