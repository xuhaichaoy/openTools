import { api, ApiError } from "@/core/api/client";
import type {
  ExportDatasetFieldDefinition,
  ExportPreview,
  ExportResult,
  StructuredExportIntent,
} from "./types";

export interface TeamDataSourceSummary {
  id: string;
  name: string;
  db_type: "postgres" | "mysql" | "mongodb" | "sqlite";
  host?: string | null;
  port?: number | null;
  database?: string | null;
  export_alias?: string | null;
  export_default_schema?: string | null;
  max_export_rows?: number | null;
  enabled?: boolean;
  has_password?: boolean;
  masked_username?: string | null;
  updated_at?: string | null;
}

export interface TeamDataSourceUpsertPayload {
  id?: string;
  name: string;
  db_type: TeamDataSourceSummary["db_type"];
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  connection_string?: string;
  export_alias?: string;
  export_default_schema?: string;
  max_export_rows?: number;
  enabled?: boolean;
}

export interface TeamExportDatasetSummary {
  id: string;
  display_name: string;
  description?: string | null;
  source_id: string;
  entity_name: string;
  entity_type: "table" | "view" | "collection";
  schema?: string | null;
  time_field?: string | null;
  default_fields?: string[];
  fields?: ExportDatasetFieldDefinition[];
  enabled?: boolean;
  updated_at?: string | null;
}

export interface TeamExportDatasetUpsertPayload {
  id?: string;
  display_name: string;
  description?: string;
  source_id: string;
  entity_name: string;
  entity_type: TeamExportDatasetSummary["entity_type"];
  schema?: string;
  time_field?: string;
  default_fields?: string[];
  fields?: ExportDatasetFieldDefinition[];
  enabled?: boolean;
}

export interface TeamExportExecutionResult
  extends Omit<ExportResult, "filePath"> {
  filePath?: string;
  downloadUrl?: string;
  fileName?: string;
}

function normalizeArrayResponse<T>(
  payload: unknown,
  keys: string[],
): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) {
        return record[key] as T[];
      }
    }
  }
  return [];
}

export function isTeamDataExportApiUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 501);
}

export async function listTeamDataSources(teamId: string): Promise<TeamDataSourceSummary[]> {
  const payload = await api.get<unknown>(`/teams/${teamId}/data-sources`);
  return normalizeArrayResponse<TeamDataSourceSummary>(payload, ["data_sources", "sources", "items"]);
}

export async function saveTeamDataSource(
  teamId: string,
  payload: TeamDataSourceUpsertPayload,
): Promise<TeamDataSourceSummary> {
  return api.put<TeamDataSourceSummary>(`/teams/${teamId}/data-sources`, payload);
}

export async function patchTeamDataSource(
  teamId: string,
  dataSourceId: string,
  payload: Partial<TeamDataSourceUpsertPayload>,
): Promise<TeamDataSourceSummary> {
  return api.patch<TeamDataSourceSummary>(`/teams/${teamId}/data-sources/${dataSourceId}`, payload);
}

export async function deleteTeamDataSource(teamId: string, dataSourceId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/data-sources/${dataSourceId}`);
}

export async function listTeamExportDatasets(teamId: string): Promise<TeamExportDatasetSummary[]> {
  const payload = await api.get<unknown>(`/teams/${teamId}/export-datasets`);
  return normalizeArrayResponse<TeamExportDatasetSummary>(payload, ["datasets", "export_datasets", "items"]);
}

export async function saveTeamExportDataset(
  teamId: string,
  payload: TeamExportDatasetUpsertPayload,
): Promise<TeamExportDatasetSummary> {
  return api.put<TeamExportDatasetSummary>(`/teams/${teamId}/export-datasets`, payload);
}

export async function patchTeamExportDataset(
  teamId: string,
  datasetId: string,
  payload: Partial<TeamExportDatasetUpsertPayload>,
): Promise<TeamExportDatasetSummary> {
  return api.patch<TeamExportDatasetSummary>(`/teams/${teamId}/export-datasets/${datasetId}`, payload);
}

export async function deleteTeamExportDataset(teamId: string, datasetId: string): Promise<void> {
  await api.delete(`/teams/${teamId}/export-datasets/${datasetId}`);
}

export async function previewTeamDataExport(
  teamId: string,
  intent: StructuredExportIntent,
): Promise<ExportPreview> {
  return api.post<ExportPreview>(`/teams/${teamId}/data-export/preview`, {
    intent,
  });
}

export async function confirmTeamDataExport(
  teamId: string,
  previewToken: string,
): Promise<TeamExportExecutionResult> {
  return api.post<TeamExportExecutionResult>(`/teams/${teamId}/data-export/confirm`, {
    previewToken,
  });
}
