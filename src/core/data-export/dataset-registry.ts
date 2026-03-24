import { getTauriStore } from "@/core/storage";
import type {
  ExportDatasetRelationDefinition,
  ExportFieldSelection,
  PersonalExportDatasetDefinition as PersonalDataset,
} from "./types";

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
const KEYWORD_FIELD_CANDIDATES = [
  "name",
  "title",
  "compname",
  "bus_name",
  "company_name",
  "enterprise_name",
  "corp_name",
  "customer_name",
  "merchant_name",
  "contact_name",
] as const;

interface DraftColumnInput {
  name: string;
  data_type?: string;
  nullable?: boolean;
  primary_key?: boolean;
}

function normalizeStringList(values?: readonly string[] | null): string[] {
  return [...new Set((values ?? []).map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function normalizeFieldSelections(
  values?: readonly ExportFieldSelection[] | null,
): ExportFieldSelection[] {
  return (values ?? [])
    .filter((item): item is ExportFieldSelection => Boolean(item && typeof item === "object"))
    .map((item) => {
      const field = String(item.field ?? "").trim();
      const alias = String(item.alias ?? "").trim();
      if (!field) return null;
      return alias ? { field, alias } : { field };
    })
    .filter((item): item is ExportFieldSelection => Boolean(item));
}

function normalizeRelations(
  values?: readonly ExportDatasetRelationDefinition[] | null,
): ExportDatasetRelationDefinition[] {
  return (values ?? [])
    .filter((item): item is ExportDatasetRelationDefinition => Boolean(item && typeof item === "object"))
    .map((item, index) => {
      const targetEntityName = String(item.targetEntityName ?? "").trim();
      if (!targetEntityName) return null;
      const name = String(item.name ?? "").trim();
      const alias = String(item.alias ?? "").trim();
      const triggerKeywords = normalizeStringList(item.triggerKeywords);
      const on = (item.on ?? [])
        .filter((condition) => Boolean(condition && typeof condition === "object"))
        .map((condition) => {
          const left = String(condition.left ?? "").trim();
          const right = String(condition.right ?? "").trim();
          const op = String(condition.op ?? "").trim();
          if (!left || !right) return null;
          return op ? { left, right, op } : { left, right };
        })
        .filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
      if (on.length === 0) return null;
      return {
        id: String(item.id ?? "").trim() || `relation-${index + 1}`,
        name: name || humanizeIdentifier(targetEntityName),
        ...(String(item.description ?? "").trim()
          ? { description: String(item.description ?? "").trim() }
          : {}),
        targetEntityName,
        ...(item.targetEntityType ? { targetEntityType: item.targetEntityType } : {}),
        ...(String(item.targetSchema ?? "").trim()
          ? { targetSchema: String(item.targetSchema ?? "").trim() }
          : {}),
        ...(alias ? { alias } : {}),
        ...(item.joinType ? { joinType: item.joinType } : {}),
        ...(triggerKeywords.length ? { triggerKeywords } : {}),
        on,
        ...(normalizeFieldSelections(item.defaultFields).length
          ? { defaultFields: normalizeFieldSelections(item.defaultFields) }
          : {}),
        enabled: item.enabled !== false,
      };
    })
    .filter((item): item is ExportDatasetRelationDefinition => Boolean(item));
}

function inferBaseAlias(entityName: string): string {
  const trimmed = String(entityName ?? "").trim();
  const match = trimmed.match(/[a-z]/i);
  return match?.[0]?.toLowerCase() || "base";
}

function normalizeDataset(input: PersonalDataset): PersonalDataset {
  const normalizedFields = input.fields.map((field) => ({
    ...field,
    label: String(field.label ?? "").trim() || humanizeIdentifier(field.name),
    aliases: normalizeStringList(field.aliases),
    ...(String(field.description ?? "").trim()
      ? { description: String(field.description ?? "").trim() }
      : {}),
    enabled: field.enabled !== false,
  }));
  return {
    ...input,
    scope: "personal",
    fields: normalizedFields,
    defaultFields: normalizeStringList(input.defaultFields).filter((fieldName) =>
      normalizedFields.some((field) => field.name === fieldName && field.enabled !== false),
    ),
    displayName: String(input.displayName ?? "").trim() || input.entityName,
    description: String(input.description ?? "").trim(),
    entityType: input.entityType ?? "table",
    aliases: normalizeStringList(input.aliases ?? [input.displayName, input.entityName]),
    intentTags: normalizeStringList(input.intentTags),
    examplePrompts: normalizeStringList(input.examplePrompts),
    ...(String(input.keywordField ?? "").trim() ? { keywordField: String(input.keywordField ?? "").trim() } : {}),
    baseAlias: String(input.baseAlias ?? "").trim() || inferBaseAlias(input.entityName),
    relations: normalizeRelations(input.relations),
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

function inferKeywordField(columns: DraftColumnInput[]): string | undefined {
  const exact = KEYWORD_FIELD_CANDIDATES.find((candidate) =>
    columns.some((item) => item.name === candidate),
  );
  if (exact) return exact;
  return columns.find((item) => {
    const lower = item.name.toLowerCase();
    return lower.includes("name") || lower.includes("title");
  })?.name;
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
  const keywordField = inferKeywordField(params.columns);

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
    aliases: normalizeStringList([displayName, params.entityName, humanizeIdentifier(params.entityName)]),
    intentTags: normalizeStringList([displayName]),
    examplePrompts: [],
    ...(keywordField ? { keywordField } : {}),
    baseAlias: inferBaseAlias(params.entityName),
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
    relations: [],
    maxExportRows: params.maxExportRows ?? DEFAULT_DATASET_LIMIT,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}
