import { getTauriStore } from "@/core/storage";
import type { PersonalExportDatasetDefinition as PersonalDataset } from "./types";

const DATASET_STORE_FILE = "data-export-datasets.json";
const DATASET_STORE_KEY = "personal_datasets_v1";
const DEFAULT_DATASET_LIMIT = 10_000;
const TIME_FIELD_CANDIDATES = [
  "created_at",
  "updated_at",
  "paid_at",
  "order_time",
  "createdAt",
  "updatedAt",
  "paidAt",
  "orderTime",
] as const;

interface DraftColumnInput {
  name: string;
  data_type?: string;
  nullable?: boolean;
  primary_key?: boolean;
}

function normalizeDataset(input: PersonalDataset): PersonalDataset {
  return {
    ...input,
    scope: "personal",
    fields: input.fields.map((field) => ({
      ...field,
      aliases: [...new Set((field.aliases ?? []).map((item) => String(item ?? "").trim()).filter(Boolean))],
      enabled: field.enabled !== false,
    })),
    defaultFields: [...new Set((input.defaultFields ?? []).map((item) => String(item ?? "").trim()).filter(Boolean))],
    displayName: String(input.displayName ?? "").trim() || input.entityName,
    description: String(input.description ?? "").trim(),
    entityType: input.entityType ?? "table",
    enabled: input.enabled !== false,
  };
}

function humanizeIdentifier(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function inferTimeField(columns: DraftColumnInput[]): string | undefined {
  const names = columns.map((item) => item.name);
  return TIME_FIELD_CANDIDATES.find((candidate) => names.includes(candidate));
}

function inferDefaultFields(columns: DraftColumnInput[]): string[] {
  const preferred = columns.filter((column) => {
    const lower = column.name.toLowerCase();
    return !lower.endsWith("password") && !lower.endsWith("secret");
  });
  return preferred.slice(0, 8).map((item) => item.name);
}

async function loadRawDatasets(): Promise<PersonalDataset[]> {
  const store = await getTauriStore(DATASET_STORE_FILE);
  const payload = await store.get<PersonalDataset[]>(DATASET_STORE_KEY);
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((item): item is PersonalDataset => Boolean(item && typeof item === "object"))
    .map(normalizeDataset);
}

async function saveRawDatasets(datasets: PersonalDataset[]): Promise<void> {
  const store = await getTauriStore(DATASET_STORE_FILE);
  await store.set(DATASET_STORE_KEY, datasets.map(normalizeDataset));
  await store.save();
}

export async function listLocalExportDatasets(): Promise<PersonalDataset[]> {
  return loadRawDatasets();
}

export async function getLocalExportDataset(datasetId: string): Promise<PersonalDataset | null> {
  const datasets = await loadRawDatasets();
  return datasets.find((item) => item.id === datasetId) ?? null;
}

export async function upsertLocalExportDataset(dataset: PersonalDataset): Promise<PersonalDataset[]> {
  const datasets = await loadRawDatasets();
  const normalized = normalizeDataset(dataset);
  const index = datasets.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    datasets[index] = normalized;
  } else {
    datasets.unshift(normalized);
  }
  await saveRawDatasets(datasets);
  return datasets;
}

export async function removeLocalExportDataset(datasetId: string): Promise<PersonalDataset[]> {
  const datasets = (await loadRawDatasets()).filter((item) => item.id !== datasetId);
  await saveRawDatasets(datasets);
  return datasets;
}

export function createDatasetDraftFromTable(params: {
  sourceId: string;
  entityName: string;
  entityType?: "table" | "view" | "collection";
  schema?: string;
  displayName?: string;
  description?: string;
  columns: DraftColumnInput[];
  maxExportRows?: number;
}): PersonalDataset {
  const now = Date.now();
  const displayName = String(params.displayName ?? "").trim() || humanizeIdentifier(params.entityName);
  const timeField = inferTimeField(params.columns);
  const defaultFields = inferDefaultFields(params.columns);

  return {
    id: `dataset-${crypto.randomUUID()}`,
    scope: "personal",
    sourceId: params.sourceId,
    entityName: params.entityName,
    entityType: params.entityType ?? "table",
    ...(params.schema ? { schema: params.schema } : {}),
    displayName,
    description:
      String(params.description ?? "").trim() || `${displayName} 数据集草稿，可用于自然语言导出。`,
    ...(timeField ? { timeField } : {}),
    defaultFields,
    fields: params.columns.map((column) => {
      const label = humanizeIdentifier(column.name);
      return {
        name: column.name,
        label,
        ...(column.data_type ? { dataType: column.data_type } : {}),
        ...(typeof column.nullable === "boolean" ? { nullable: column.nullable } : {}),
        ...(typeof column.primary_key === "boolean" ? { primaryKey: column.primary_key } : {}),
        aliases: [...new Set([column.name, label])],
        enabled: true,
      };
    }),
    maxExportRows: params.maxExportRows ?? DEFAULT_DATASET_LIMIT,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}
