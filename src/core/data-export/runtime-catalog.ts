import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@/core/logger";
import { useAuthStore } from "@/store/auth-store";
import { useTeamStore } from "@/store/team-store";
import { listLocalExportDatasets } from "./dataset-registry";
import {
  isTeamDataExportApiUnavailable,
  listTeamDataSources,
  listTeamExportDatasets,
} from "./team-data-export-api";
import type {
  ExportDatasetFieldDefinition,
  ExportSourceConfig,
  PersonalRuntimeExportSourceConfig,
  RuntimeExportDatasetDefinition,
  RuntimeExportSourceConfig,
  TeamExportDatasetDefinition,
  TeamRuntimeExportSourceConfig,
} from "./types";

const log = createLogger("ExportRuntimeCatalog");

export function buildTeamRuntimeSourceId(teamId: string, sourceId: string): string {
  return `team:${teamId}:source:${sourceId}`;
}

export function buildTeamRuntimeDatasetId(teamId: string, datasetId: string): string {
  return `team:${teamId}:dataset:${datasetId}`;
}

function toPersonalRuntimeSource(source: ExportSourceConfig): PersonalRuntimeExportSourceConfig {
  return {
    ...source,
    scope: "personal",
    executionTarget: "local",
    originSourceId: source.id,
  };
}

function fallbackDatasetFields(params: {
  defaultFields?: string[];
  timeField?: string | null;
}): ExportDatasetFieldDefinition[] {
  const names = new Set<string>();
  for (const field of params.defaultFields ?? []) {
    const normalized = String(field ?? "").trim();
    if (normalized) names.add(normalized);
  }
  const timeField = String(params.timeField ?? "").trim();
  if (timeField) names.add(timeField);

  return [...names].map((name) => ({
    name,
    label: name,
    aliases: [name],
    enabled: true,
  }));
}

async function loadPersonalExportSources(): Promise<PersonalRuntimeExportSourceConfig[]> {
  const allSources = await invoke<ExportSourceConfig[]>("db_load_connections");
  const explicitlyEnabled = allSources.filter((item) => item.export_enabled === true);
  const candidates =
    explicitlyEnabled.length > 0
      ? explicitlyEnabled
      : allSources.filter(
          (item) =>
            item.db_type === "postgres" ||
            item.db_type === "mysql" ||
            item.db_type === "mongodb" ||
            item.db_type === "sqlite",
        );
  return candidates.map(toPersonalRuntimeSource);
}

async function loadTeamRuntimeCatalog(): Promise<{
  activeTeamId: string | null;
  runtimeAvailable: boolean;
  sources: TeamRuntimeExportSourceConfig[];
  datasets: TeamExportDatasetDefinition[];
}> {
  if (!useAuthStore.getState().isLoggedIn) {
    return {
      activeTeamId: null,
      runtimeAvailable: false,
      sources: [],
      datasets: [],
    };
  }

  const teamStore = useTeamStore.getState();
  if (!teamStore.loaded && !teamStore.loadError) {
    await teamStore.loadTeams();
  }

  const latestTeamState = useTeamStore.getState();
  const activeTeamId = latestTeamState.activeTeamId ?? latestTeamState.teams[0]?.id ?? null;
  if (!activeTeamId) {
    return {
      activeTeamId: null,
      runtimeAvailable: false,
      sources: [],
      datasets: [],
    };
  }

  try {
    const [sources, datasets] = await Promise.all([
      listTeamDataSources(activeTeamId),
      listTeamExportDatasets(activeTeamId),
    ]);
    const enabledSources = sources.filter((source) => source.enabled !== false);
    const enabledDatasets = datasets.filter((dataset) => dataset.enabled !== false);

    const mappedSources = enabledSources.map<TeamRuntimeExportSourceConfig>((source) => ({
      id: buildTeamRuntimeSourceId(activeTeamId, source.id),
      scope: "team",
      executionTarget: "team_service",
      teamId: activeTeamId,
      originSourceId: source.id,
      name: source.name,
      db_type: source.db_type,
      ...(source.host ? { host: source.host } : {}),
      ...(typeof source.port === "number" ? { port: source.port } : {}),
      ...(source.database ? { database: source.database } : {}),
      export_enabled: source.enabled !== false,
      ...(source.export_alias ? { export_alias: source.export_alias } : {}),
      ...(source.export_default_schema ? { export_default_schema: source.export_default_schema } : {}),
      ...(typeof source.max_export_rows === "number" ? { max_export_rows: source.max_export_rows } : {}),
    }));

    const sourceMap = new Map(mappedSources.map((source) => [source.originSourceId, source]));
    const mappedDatasets = enabledDatasets.map<TeamExportDatasetDefinition>((dataset) => {
      const runtimeSource = sourceMap.get(dataset.source_id);
      const fallbackFields = fallbackDatasetFields({
        defaultFields: dataset.default_fields,
        timeField: dataset.time_field,
      });
      return {
        id: buildTeamRuntimeDatasetId(activeTeamId, dataset.id),
        scope: "team",
        teamId: activeTeamId,
        originDatasetId: dataset.id,
        sourceId: runtimeSource?.id ?? buildTeamRuntimeSourceId(activeTeamId, dataset.source_id),
        originSourceId: dataset.source_id,
        entityName: dataset.entity_name,
        entityType: dataset.entity_type,
        ...(dataset.schema ? { schema: dataset.schema } : {}),
        displayName: dataset.display_name,
        description: dataset.description ?? "",
        ...(dataset.time_field ? { timeField: dataset.time_field } : {}),
        defaultFields: dataset.default_fields ?? [],
        fields: dataset.fields?.length ? dataset.fields : fallbackFields,
        ...(dataset.aliases?.length ? { aliases: dataset.aliases } : {}),
        ...(dataset.intent_tags?.length ? { intentTags: dataset.intent_tags } : {}),
        ...(dataset.example_prompts?.length ? { examplePrompts: dataset.example_prompts } : {}),
        ...(dataset.keyword_field ? { keywordField: dataset.keyword_field } : {}),
        ...(dataset.base_alias ? { baseAlias: dataset.base_alias } : {}),
        ...(dataset.relations?.length ? { relations: dataset.relations } : {}),
        ...(runtimeSource?.max_export_rows ? { maxExportRows: runtimeSource.max_export_rows } : {}),
        enabled: dataset.enabled !== false,
        ...(dataset.updated_at ? { updatedAt: Date.parse(dataset.updated_at) || Date.now() } : {}),
      };
    });

    return {
      activeTeamId,
      runtimeAvailable: true,
      sources: mappedSources,
      datasets: mappedDatasets,
    };
  } catch (error) {
    if (!isTeamDataExportApiUnavailable(error)) {
      log.warn("Failed to load active team export catalog", error);
    }
    return {
      activeTeamId,
      runtimeAvailable: false,
      sources: [],
      datasets: [],
    };
  }
}

export async function loadRuntimeExportCatalog(): Promise<{
  sources: RuntimeExportSourceConfig[];
  datasets: RuntimeExportDatasetDefinition[];
  activeTeamId: string | null;
  teamRuntimeAvailable: boolean;
}> {
  const [personalSources, personalDatasets, teamCatalog] = await Promise.all([
    loadPersonalExportSources(),
    listLocalExportDatasets(),
    loadTeamRuntimeCatalog(),
  ]);

  return {
    sources: [...personalSources, ...teamCatalog.sources],
    datasets: [...teamCatalog.datasets, ...personalDatasets],
    activeTeamId: teamCatalog.activeTeamId,
    teamRuntimeAvailable: teamCatalog.runtimeAvailable,
  };
}
