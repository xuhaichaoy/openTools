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

export type ExportScope = "personal" | "team";
export type ExportExecutionTarget = "local" | "team_service";

export interface ExportDatasetFieldDefinition {
  name: string;
  label: string;
  dataType?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  aliases?: string[];
  enabled: boolean;
}

export interface PersonalExportDatasetDefinition {
  id: string;
  scope: "personal";
  sourceId: string;
  entityName: string;
  entityType: "table" | "view" | "collection";
  schema?: string;
  displayName: string;
  description: string;
  timeField?: string;
  defaultFields: string[];
  fields: ExportDatasetFieldDefinition[];
  maxExportRows?: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PersonalRuntimeExportSourceConfig extends ExportSourceConfig {
  scope: "personal";
  executionTarget: "local";
  originSourceId: string;
}

export interface TeamRuntimeExportSourceConfig {
  id: string;
  scope: "team";
  executionTarget: "team_service";
  teamId: string;
  originSourceId: string;
  name: string;
  db_type: "sqlite" | "postgres" | "mysql" | "mongodb";
  host?: string;
  port?: number;
  database?: string;
  export_enabled?: boolean;
  export_alias?: string;
  export_default_schema?: string;
  max_export_rows?: number;
}

export type RuntimeExportSourceConfig =
  | PersonalRuntimeExportSourceConfig
  | TeamRuntimeExportSourceConfig;

export interface TeamExportDatasetDefinition {
  id: string;
  scope: "team";
  teamId: string;
  originDatasetId: string;
  sourceId: string;
  originSourceId: string;
  entityName: string;
  entityType: "table" | "view" | "collection";
  schema?: string;
  displayName: string;
  description: string;
  timeField?: string;
  defaultFields: string[];
  fields: ExportDatasetFieldDefinition[];
  maxExportRows?: number;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export type RuntimeExportDatasetDefinition =
  | PersonalExportDatasetDefinition
  | TeamExportDatasetDefinition;

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
  sourceScope?: ExportScope;
  teamId?: string;
  datasetId?: string;
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
