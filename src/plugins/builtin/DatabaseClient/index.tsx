import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  Play,
  Database,
  Table2,
  Power,
  PowerOff,
  Loader2,
  X,
  ChevronRight,
  ChevronDown,
  Columns3,
  ArrowLeft,
  Clock,
  Key,
  FileSpreadsheet,
  Pencil,
  Sparkles,
} from "lucide-react";
import {
  useDatabaseStore,
  type DatabaseConfig,
  type TableInfo,
} from "@/store/database-store";
import { useDataExportDatasetStore } from "@/store/data-export-dataset-store";
import { useDragWindow } from "@/hooks/useDragWindow";
import {
  createDatasetDraftFromTable,
} from "@/core/data-export/dataset-registry";
import type {
  PersonalExportDatasetDefinition,
} from "@/core/data-export/types";
import { useToast } from "@/components/ui/Toast";

const BRAND = "#F28F36";

const DB_TYPE_LABELS: Record<string, { label: string; color: string; defaultPort: number }> = {
  sqlite: { label: "SQLite", color: "#0ea5e9", defaultPort: 0 },
  postgres: { label: "PostgreSQL", color: "#336791", defaultPort: 5432 },
  mysql: { label: "MySQL", color: "#4479A1", defaultPort: 3306 },
  mongodb: { label: "MongoDB", color: "#47A248", defaultPort: 27017 },
};

type DatasetRelationDefinition = NonNullable<PersonalExportDatasetDefinition["relations"]>[number];

function clonePersonalDataset(dataset: PersonalExportDatasetDefinition): PersonalExportDatasetDefinition {
  return {
    ...dataset,
    aliases: [...(dataset.aliases ?? [])],
    intentTags: [...(dataset.intentTags ?? [])],
    examplePrompts: [...(dataset.examplePrompts ?? [])],
    fields: dataset.fields.map((field) => ({
      ...field,
      aliases: [...(field.aliases ?? [])],
    })),
    relations: (dataset.relations ?? []).map((relation) => ({
      ...relation,
      triggerKeywords: [...(relation.triggerKeywords ?? [])],
      on: relation.on.map((condition) => ({ ...condition })),
      defaultFields: relation.defaultFields?.map((field) => ({ ...field })),
    })),
  };
}

function createEmptyDatasetRelation(baseAlias: string): DatasetRelationDefinition {
  return {
    id: `relation-${crypto.randomUUID()}`,
    name: "",
    description: "",
    targetEntityName: "",
    targetEntityType: "table",
    targetSchema: "",
    alias: "rel",
    joinType: "left",
    triggerKeywords: [],
    on: [
      {
        left: `${baseAlias || "base"}.id`,
        op: "eq",
        right: "",
      },
    ],
    defaultFields: [],
    enabled: true,
  };
}

function formatRelationFieldsInput(
  fields?: readonly NonNullable<DatasetRelationDefinition["defaultFields"]>[number][],
): string {
  return (fields ?? [])
    .map((field) => {
      const alias = String(field.alias ?? "").trim();
      return alias ? `${field.field}:${alias}` : field.field;
    })
    .join("\n");
}

function parseRelationFieldsInput(
  value: string,
): NonNullable<DatasetRelationDefinition["defaultFields"]> {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawField, ...aliasParts] = line.split(":");
      const field = String(rawField ?? "").trim();
      const alias = aliasParts.join(":").trim();
      if (!field) return null;
      return alias ? { field, alias } : { field };
    })
    .filter((item): item is NonNullable<DatasetRelationDefinition["defaultFields"]>[number] => Boolean(item));
}

function getTableKey(table: Pick<TableInfo, "name" | "schema">): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function humanizeFieldName(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function isReadOnlyQuery(query: string): boolean {
  const normalized = query.trimStart().toLowerCase();
  return normalized.startsWith("select")
    || normalized.startsWith("with")
    || normalized.startsWith("show")
    || normalized.startsWith("describe")
    || normalized.startsWith("explain")
    || normalized.startsWith("pragma");
}

function getDefaultNamespace(connection?: DatabaseConfig | null): string | null {
  if (!connection) return null;
  switch (connection.db_type) {
    case "sqlite":
      return "main";
    case "postgres":
      return connection.export_default_schema?.trim() || null;
    case "mysql":
    case "mongodb":
      return connection.database?.trim() || null;
    default:
      return null;
  }
}

function getNamespaceLabel(dbType?: DatabaseConfig["db_type"] | null): string {
  switch (dbType) {
    case "mysql":
    case "mongodb":
      return "Databases";
    case "postgres":
      return "Schemas";
    case "sqlite":
      return "Schema";
    default:
      return "Namespaces";
  }
}

function getDefaultQuery(connection?: DatabaseConfig | null): string {
  switch (connection?.db_type) {
    case "mysql":
      return connection.database?.trim() ? "SELECT 1;" : "SHOW DATABASES;";
    case "postgres":
      return "SELECT 1;";
    case "sqlite":
      return "SELECT name FROM sqlite_master LIMIT 50;";
    case "mongodb":
      return "";
    default:
      return "";
  }
}

const DEFAULT_QUERY_VALUES = new Set([
  "SELECT * FROM sqlite_master;",
  "SELECT name FROM sqlite_master LIMIT 50;",
  "SELECT 1;",
  "SHOW DATABASES;",
  "",
]);

export default function DatabaseClientPlugin({ onBack }: { onBack?: () => void }) {
  const { onMouseDown } = useDragWindow();
  const { toast } = useToast();
  const {
    connections,
    activeConnectionId,
    connectedIds,
    databaseClientContext,
    queryResult,
    schemas,
    tables,
    tableColumns,
    isQuerying,
    loadConnections,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    loadTables,
    describeTable,
    executeQuery,
    setActiveConnection,
    setDatabaseClientContext,
    clearDatabaseClientContext,
  } = useDatabaseStore();
  const {
    datasets,
    isLoading: datasetsLoading,
    loadDatasets,
    saveDataset,
    deleteDataset,
  } = useDataExportDatasetStore();

  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [datasetDraft, setDatasetDraft] = useState<PersonalExportDatasetDefinition | null>(null);
  const [schemaSelectionByConnection, setSchemaSelectionByConnection] = useState<Record<string, string | null>>({});

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    loadDatasets();
  }, [loadDatasets]);

  const activeConnection = connections.find((item) => item.id === activeConnectionId) ?? null;
  const activeDatasets = datasets.filter((item) => item.sourceId === activeConnectionId);
  const activeConnectionLoading = activeConnectionId ? actionLoading[activeConnectionId] : false;
  const selectedSchema = activeConnectionId
    ? (schemaSelectionByConnection[activeConnectionId] ?? getDefaultNamespace(activeConnection))
    : null;
  const isActiveConnected = Boolean(activeConnectionId && connectedIds.has(activeConnectionId));
  const namespaceLabel = getNamespaceLabel(activeConnection?.db_type);
  const requiresSchemaPick = activeConnection?.db_type === "mysql" && isActiveConnected && !selectedSchema;
  const tableGroups = tables.reduce<Record<string, TableInfo[]>>((groups, table) => {
    const key = table.schema || "__default__";
    groups[key] ||= [];
    groups[key].push(table);
    return groups;
  }, {});
  const tableGroupEntries = Object.entries(tableGroups).sort(([left], [right]) => left.localeCompare(right));

  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;
    if (activeConnection?.db_type === "mysql" && !selectedSchema) {
      useDatabaseStore.setState({ tables: [], tableColumns: {} });
      return;
    }
    void loadTables(selectedSchema ?? undefined);
  }, [activeConnectionId, activeConnection?.db_type, connectedIds, loadTables, selectedSchema]);

  useEffect(() => {
    if (!activeConnectionId || !activeConnection || !connectedIds.has(activeConnectionId)) {
      if (databaseClientContext.connectionId !== null) {
        clearDatabaseClientContext();
      }
      return;
    }

    const expandedTableInfo = expandedTable
      ? tables.find((item) => getTableKey(item) === expandedTable) ?? null
      : null;

    setDatabaseClientContext({
      connectionId: activeConnectionId,
      connectionName: activeConnection.name,
      dbType: activeConnection.db_type,
      schema: expandedTableInfo?.schema ?? selectedSchema ?? null,
      tableKey: expandedTableInfo ? getTableKey(expandedTableInfo) : null,
      tableName: expandedTableInfo?.name ?? null,
    });
  }, [
    activeConnection,
    activeConnectionId,
    clearDatabaseClientContext,
    connectedIds,
    databaseClientContext.connectionId,
    expandedTable,
    selectedSchema,
    setDatabaseClientContext,
    tables,
  ]);

  const handleSelectConnection = useCallback((conn: DatabaseConfig) => {
    setActiveConnection(conn.id);
    setExpandedTable(null);
    setQuery((previous) => {
      if (!DEFAULT_QUERY_VALUES.has(previous.trim())) return previous;
      return getDefaultQuery(conn);
    });
  }, [setActiveConnection]);

  const handleSelectSchema = useCallback((schema: string | null) => {
    if (!activeConnectionId) return;
    setSchemaSelectionByConnection((current) => ({ ...current, [activeConnectionId]: schema }));
    setExpandedTable(null);
  }, [activeConnectionId]);

  const handleConnect = useCallback(async (id: string) => {
    setActionLoading((p) => ({ ...p, [id]: true }));
    try {
      await connect(id);
      const conn = connections.find((item) => item.id === id);
      toast("success", `${conn?.name ?? "数据库"}已连接`);
    } catch { /* handled by store */ }
    setActionLoading((p) => ({ ...p, [id]: false }));
  }, [connect, connections, toast]);

  const handleDisconnect = useCallback(async (id: string) => {
    await disconnect(id);
    const conn = connections.find((item) => item.id === id);
    toast("info", `${conn?.name ?? "数据库"}已断开`);
  }, [connections, disconnect, toast]);

  const handleTableClick = async (table: TableInfo) => {
    const tableKey = getTableKey(table);
    if (expandedTable === tableKey) {
      setExpandedTable(null);
    } else {
      setExpandedTable(tableKey);
      if (!tableColumns[tableKey]) {
        await describeTable(tableKey);
      }
    }
  };

  const handleExecute = () => {
    if (!query.trim()) return;
    if (!isReadOnlyQuery(query)) {
      toast("warning", "当前数据库客户端为只读模式，只允许 SELECT / SHOW / DESCRIBE / EXPLAIN 查询");
      return;
    }
    executeQuery(query.trim());
  };

  const handleCreateDatasetDraft = async (table: TableInfo) => {
    if (!activeConnectionId) return;
    const tableKey = getTableKey(table);
    const existingColumns = tableColumns[tableKey] ?? await describeTable(tableKey);
    if (!existingColumns.length) return;

    setDatasetDraft(
      createDatasetDraftFromTable({
        sourceId: activeConnectionId,
        entityName: table.name,
        entityType: table.table_type === "view" ? "view" : activeConnection?.db_type === "mongodb" ? "collection" : "table",
        schema: table.schema,
        columns: existingColumns,
        maxExportRows: activeConnection?.max_export_rows,
      }),
    );
  };

  const handleApplyDataset = (dataset: PersonalExportDatasetDefinition) => {
    const enabledFields = dataset.fields.filter((field) => field.enabled !== false).map((field) => field.name);
    const selectedFields = dataset.defaultFields.length
      ? dataset.defaultFields.join(", ")
      : enabledFields.length
        ? enabledFields.join(", ")
        : "*";
    const tableRef = dataset.schema ? `${dataset.schema}.${dataset.entityName}` : dataset.entityName;
    setQuery(`SELECT ${selectedFields} FROM ${tableRef} LIMIT 50;`);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <div
        className="h-10 flex items-center px-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing shrink-0"
        onMouseDown={onMouseDown}
      >
        <button onClick={onBack} className="mr-2 p-1 rounded hover:bg-[var(--color-bg-secondary)]">
          <ArrowLeft className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
        </button>
        <h1 className="text-xs font-semibold text-[var(--color-text-secondary)]">
          数据库客户端
        </h1>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: Connections + Schema Tree */}
        <div className="w-[200px] border-r border-[var(--color-border)] flex flex-col shrink-0">
          <div className="p-2 border-b border-[var(--color-border)]">
            <button
              onClick={() => setShowForm(true)}
              className="w-full flex items-center justify-center gap-1 py-1.5 rounded-lg text-white text-xs font-medium"
              style={{ background: BRAND }}
            >
              <Plus className="w-3 h-3" />
              新建连接
            </button>
          </div>

          {/* Connection list */}
          <div className="flex-shrink-0 max-h-[180px] overflow-y-auto p-1.5 space-y-0.5 border-b border-[var(--color-border)]">
            {connections.map((conn) => {
              const isConnected = connectedIds.has(conn.id);
              const isActive = activeConnectionId === conn.id;
              const loading = actionLoading[conn.id];
              const dbInfo = DB_TYPE_LABELS[conn.db_type] ?? { label: conn.db_type, color: "#666", defaultPort: 0 };

              return (
                <div
                  key={conn.id}
                  onClick={() => handleSelectConnection(conn)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                    isActive ? "font-medium" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={isActive ? { background: `${BRAND}15`, color: BRAND } : undefined}
                >
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: isConnected ? "#22c55e" : "#94a3b8" }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium truncate">{conn.name}</div>
                    <div className="text-[9px] opacity-60 truncate flex items-center gap-1 flex-wrap">
                      <span className="px-1 rounded" style={{ background: `${dbInfo.color}20`, color: dbInfo.color }}>
                        {dbInfo.label}
                      </span>
                      {conn.export_enabled && (
                        <span className="px-1 rounded bg-emerald-500/10 text-emerald-600">
                          导出
                        </span>
                      )}
                      {conn.export_alias?.trim() && (
                        <span className="truncate">#{conn.export_alias.trim()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {loading ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : isConnected ? (
                      <button onClick={(e) => { e.stopPropagation(); void handleDisconnect(conn.id); }} className="p-0.5 rounded hover:bg-red-500/10">
                        <PowerOff className="w-2.5 h-2.5 text-red-400" />
                      </button>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); void handleConnect(conn.id); }} className="p-0.5 rounded hover:bg-emerald-500/10">
                        <Power className="w-2.5 h-2.5 text-emerald-500" />
                      </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); removeConnection(conn.id); }} className="p-0.5 rounded hover:bg-red-500/10">
                      <Trash2 className="w-2.5 h-2.5 text-red-400" />
                    </button>
                  </div>
                </div>
              );
            })}
            {connections.length === 0 && (
              <div className="text-center py-4">
                <Database className="w-5 h-5 mx-auto mb-1 opacity-20 text-[var(--color-text-secondary)]" />
                <p className="text-[10px] text-[var(--color-text-secondary)]">无连接</p>
              </div>
            )}
          </div>

          {/* Schema Tree */}
          <div className="flex-1 overflow-y-auto p-1.5">
            {activeConnectionId && connectedIds.has(activeConnectionId) ? (
              <div className="space-y-0.5">
                {schemas.length > 0 && activeConnection?.db_type !== "sqlite" && (
                  <div className="px-2 pb-2">
                    <div className="flex items-center justify-between pb-1">
                      <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                        {namespaceLabel}
                      </div>
                      {activeConnection?.export_enabled && (
                        <div className="text-[9px] text-emerald-600">导出已启用</div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {activeConnection?.db_type !== "mysql" && (
                        <button
                          onClick={() => handleSelectSchema(null)}
                          className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                            selectedSchema === null
                              ? "text-white"
                              : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                          }`}
                          style={selectedSchema === null ? { background: BRAND, borderColor: BRAND } : undefined}
                        >
                          全部
                        </button>
                      )}
                      {schemas.map((schemaName) => (
                        <button
                          key={schemaName}
                          onClick={() => handleSelectSchema(schemaName)}
                          className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                            selectedSchema === schemaName
                              ? "text-white"
                              : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                          }`}
                          style={selectedSchema === schemaName ? { background: BRAND, borderColor: BRAND } : undefined}
                        >
                          {schemaName}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between px-2 pb-1">
                  <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    Tables
                  </div>
                  {activeConnection?.db_type === "mysql" && !activeConnection?.database?.trim() && (
                    <div className="text-[9px] text-[var(--color-text-secondary)]">支持跨库 SQL</div>
                  )}
                </div>
                {requiresSchemaPick ? (
                  <div className="px-2 py-3 text-center text-[10px] text-[var(--color-text-secondary)] space-y-1">
                    <p>已连接到 MySQL 实例。</p>
                    <p>先选择一个数据库浏览表，或直接在 SQL 中写 `db.table` 做跨库查询。</p>
                  </div>
                ) : (
                  <>
                    {tableGroupEntries.map(([groupName, groupTables]) => (
                      <div key={groupName} className="space-y-0.5">
                        {tableGroupEntries.length > 1 && (
                          <div className="px-2 pt-1 text-[9px] font-medium text-[var(--color-text-secondary)] opacity-70 uppercase">
                            {groupName === "__default__" ? "default" : groupName}
                          </div>
                        )}
                        {groupTables.map((table) => (
                          <div key={getTableKey(table)}>
                            <button
                              onClick={() => handleTableClick(table)}
                              className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--color-bg-secondary)] transition-colors"
                            >
                              {expandedTable === getTableKey(table) ? (
                                <ChevronDown className="w-2.5 h-2.5 text-[var(--color-text-secondary)]" />
                              ) : (
                                <ChevronRight className="w-2.5 h-2.5 text-[var(--color-text-secondary)]" />
                              )}
                              <Table2 className="w-3 h-3" style={{ color: BRAND }} />
                              <span className="text-[11px] truncate">{table.name}</span>
                              {table.schema && selectedSchema !== table.schema && (
                                <span className="ml-auto shrink-0 text-[9px] text-[var(--color-text-secondary)] opacity-70 truncate">
                                  {table.schema}
                                </span>
                              )}
                            </button>
                            {expandedTable === getTableKey(table) && tableColumns[getTableKey(table)] && (
                              <div className="ml-5 space-y-0.5 py-0.5">
                                <button
                                  onClick={() => void handleCreateDatasetDraft(table)}
                                  disabled={!activeConnection?.export_enabled}
                                  className="w-full mb-1 flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-dashed border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40 disabled:hover:bg-transparent"
                                >
                                  <Sparkles className="w-2.5 h-2.5" />
                                  生成数据集草稿
                                </button>
                                {tableColumns[getTableKey(table)].map((col) => (
                                  <div
                                    key={col.name}
                                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                                    onClick={() =>
                                      setQuery((q) =>
                                        q
                                          ? `${q.replace(/;$/, "")} /* ${col.name} */;`
                                          : `SELECT ${col.name} FROM ${getTableKey(table)} LIMIT 50;`,
                                      )
                                    }
                                  >
                                    {col.primary_key ? (
                                      <Key className="w-2.5 h-2.5 text-amber-500" />
                                    ) : (
                                      <Columns3 className="w-2.5 h-2.5" />
                                    )}
                                    <span className="truncate">{col.name}</span>
                                    <span className="opacity-50 ml-auto shrink-0">{col.data_type}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                    {tables.length === 0 && (
                      <p className="text-[10px] text-[var(--color-text-secondary)] text-center py-3">无表</p>
                    )}
                  </>
                )}
              </div>
            ) : activeConnectionId ? (
              <div className="flex h-full items-center justify-center px-3">
                <div className="text-center">
                  <p className="text-[10px] text-[var(--color-text-secondary)]">
                    当前连接尚未建立
                  </p>
                  <p className="mt-1 text-[10px] text-[var(--color-text-secondary)] opacity-70">
                    点击左侧电源按钮，或在这里直接连接
                  </p>
                  <button
                    onClick={() => void handleConnect(activeConnectionId)}
                    disabled={Boolean(activeConnectionLoading)}
                    className="mt-3 inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-white disabled:opacity-60"
                    style={{ background: BRAND }}
                  >
                    {activeConnectionLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Power className="h-3 w-3" />
                    )}
                    连接此数据库
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-[10px] text-[var(--color-text-secondary)] text-center py-4">
                选择连接后可浏览 Schema
              </p>
            )}
          </div>

          <div className="border-t border-[var(--color-border)] p-1.5 max-h-[170px] overflow-y-auto">
            <div className="flex items-center justify-between px-2 pb-1">
              <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                Datasets
              </div>
              <div className="text-[9px] text-[var(--color-text-secondary)]">
                {datasetsLoading ? "..." : activeDatasets.length}
              </div>
            </div>
            {activeDatasets.length > 0 ? (
              <div className="space-y-1">
                {activeDatasets.map((dataset) => (
                  <div
                    key={dataset.id}
                    className="rounded-lg border border-[var(--color-border)] px-2 py-1.5 hover:bg-[var(--color-bg-secondary)]"
                  >
                    <button
                      onClick={() => handleApplyDataset(dataset)}
                      className="w-full text-left"
                    >
                      <div className="flex items-center gap-1">
                        <FileSpreadsheet className="w-3 h-3 text-[#F28F36]" />
                        <span className="text-[11px] font-medium truncate">{dataset.displayName}</span>
                      </div>
                    <div className="text-[9px] text-[var(--color-text-secondary)] mt-0.5 truncate">
                      {dataset.schema ? `${dataset.schema}.` : ""}{dataset.entityName}
                    </div>
                    </button>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[9px] text-[var(--color-text-secondary)] truncate">
                        {dataset.aliases?.length
                          ? dataset.aliases.slice(0, 2).join(" / ")
                          : dataset.defaultFields.slice(0, 3).join(" / ") || "全部字段"}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] text-[var(--color-text-secondary)]">
                          {(dataset.relations?.length ?? 0) > 0 ? `${dataset.relations?.length ?? 0} 个关系` : ""}
                        </span>
                        <button
                          onClick={() => setDatasetDraft(clonePersonalDataset(dataset))}
                          className="p-0.5 rounded hover:bg-[var(--color-bg)]"
                          title="编辑数据集"
                        >
                          <Pencil className="w-2.5 h-2.5 text-[var(--color-text-secondary)]" />
                        </button>
                        <button
                          onClick={() => void deleteDataset(dataset.id)}
                          className="p-0.5 rounded hover:bg-red-500/10"
                          title="删除数据集"
                        >
                          <Trash2 className="w-2.5 h-2.5 text-red-400" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-2 py-3 text-[10px] text-[var(--color-text-secondary)]">
                还没有本地数据集。展开表后可快速生成草稿。
              </div>
            )}
          </div>
        </div>

        {/* Main: Query Editor + Results */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Query Editor */}
          <div className="shrink-0 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)]">
              <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">SQL</span>
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600">
                只读
              </span>
              <div className="flex-1" />
              <button
                onClick={handleExecute}
                disabled={isQuerying || !activeConnectionId || !connectedIds.has(activeConnectionId)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium text-white disabled:opacity-50"
                style={{ background: BRAND }}
              >
                {isQuerying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                执行
              </button>
            </div>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleExecute();
              }}
              className="w-full h-[100px] px-3 py-2 bg-[var(--color-bg)] text-xs font-mono text-[var(--color-text)] resize-none outline-none"
              placeholder={
                activeConnection?.db_type === "mongodb"
                  ? "MongoDB 暂不支持在这里直接写 SQL，请先连接后从集合生成数据集。"
                  : activeConnection?.db_type === "mysql" && !activeConnection?.database?.trim()
                    ? "输入 SQL 查询，如 SELECT * FROM db.table LIMIT 50; (Cmd+Enter 执行)"
                    : "输入 SQL 查询... (Cmd+Enter 执行)"
              }
              spellCheck={false}
            />
          </div>

          {/* Results */}
          <div className="flex-1 overflow-auto">
            {queryResult ? (
              <div>
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg)]">
                  <span className="text-[10px] text-[var(--color-text-secondary)]">
                    {queryResult.columns.length > 0
                      ? `${queryResult.rows.length} 行`
                      : `${queryResult.affected} 行受影响`}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-0.5">
                    <Clock className="w-2.5 h-2.5" />
                    {queryResult.elapsed_ms}ms
                  </span>
                </div>
                {queryResult.columns.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="border-b border-[var(--color-border)]">
                          {queryResult.columns.map((col) => (
                            <th
                              key={col}
                              className="text-left px-2 py-1.5 font-semibold text-[var(--color-text-secondary)] whitespace-nowrap bg-[var(--color-bg-secondary)]"
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queryResult.rows.map((row, i) => (
                          <tr
                            key={i}
                            className="border-b border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] transition-colors"
                          >
                            {row.map((val, j) => (
                              <td key={j} className="px-2 py-1 whitespace-nowrap max-w-[200px] truncate">
                                {val === null ? (
                                  <span className="text-[var(--color-text-secondary)] italic">NULL</span>
                                ) : (
                                  String(val)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <Database className="w-8 h-8 mx-auto mb-2 opacity-10 text-[var(--color-text-secondary)]" />
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    执行查询后在此显示结果
                  </p>
                  <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 opacity-60">
                    Cmd/Ctrl + Enter 快速执行
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showForm && (
        <ConnectionFormModal
          onSave={async (config) => {
            await addConnection(config);
            setShowForm(false);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {datasetDraft && (
        <DatasetDraftModal
          draft={datasetDraft}
          onCancel={() => setDatasetDraft(null)}
          onSave={async (draft) => {
            await saveDataset({ ...draft, updatedAt: Date.now() });
            setDatasetDraft(null);
          }}
        />
      )}
    </div>
  );
}

// ── Connection Form ──

function ConnectionFormModal({
  onSave,
  onCancel,
}: {
  onSave: (config: DatabaseConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [dbType, setDbType] = useState<DatabaseConfig["db_type"]>("sqlite");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [filePath, setFilePath] = useState("");
  const [exportEnabled, setExportEnabled] = useState(true);
  const [exportAlias, setExportAlias] = useState("");
  const [exportDefaultSchema, setExportDefaultSchema] = useState("");
  const [maxExportRows, setMaxExportRows] = useState("10000");
  const [saving, setSaving] = useState(false);
  const requiresDatabaseName = dbType === "postgres" || dbType === "mongodb";
  const canSubmit = Boolean(
    name.trim()
      && (dbType === "sqlite"
        ? filePath.trim()
        : requiresDatabaseName
          ? database.trim()
          : true),
  );

  const handleSubmit = async () => {
    if (!name.trim()) return;
    if (dbType === "sqlite" && !filePath.trim()) {
      toast("error", "SQLite 需要填写数据库文件路径");
      return;
    }
    if (requiresDatabaseName && !database.trim()) {
      toast("error", `${DB_TYPE_LABELS[dbType].label} 需要填写数据库名`);
      return;
    }
    setSaving(true);
    const dbInfo = DB_TYPE_LABELS[dbType];
    await onSave({
      id: `db-${Date.now()}`,
      name: name.trim(),
      db_type: dbType,
      host: dbType !== "sqlite" ? host.trim() : undefined,
      port: dbType !== "sqlite" ? (parseInt(port) || dbInfo?.defaultPort) : undefined,
      username: dbType !== "sqlite" ? username.trim() || undefined : undefined,
      password: dbType !== "sqlite" ? password || undefined : undefined,
      database: dbType !== "sqlite" ? database.trim() || undefined : undefined,
      file_path: dbType === "sqlite" ? filePath.trim() : undefined,
      export_enabled: exportEnabled,
      export_alias: exportAlias.trim() || undefined,
      export_default_schema: exportDefaultSchema.trim() || undefined,
      max_export_rows: Number.parseInt(maxExportRows, 10) || undefined,
    });
    setSaving(false);
  };

  const inputCls =
    "w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs text-[var(--color-text)] focus:ring-2 focus:ring-[#F28F3640] transition-all outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[var(--color-bg)] w-[420px] rounded-xl p-4 border border-[var(--color-border)] shadow-xl space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">新建数据库连接</h3>
          <button onClick={onCancel} className="p-1 rounded hover:bg-[var(--color-bg-secondary)]">
            <X className="w-4 h-4 text-[var(--color-text-secondary)]" />
          </button>
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Database" className={inputCls + " mt-1"} autoFocus />
          </div>

          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">数据库类型</label>
            <div className="flex gap-1.5 mt-1">
              {(Object.entries(DB_TYPE_LABELS) as [DatabaseConfig["db_type"], typeof DB_TYPE_LABELS[string]][]).map(([type, info]) => (
                <button
                  key={type}
                  onClick={() => { setDbType(type); setPort(String(info.defaultPort || "")); }}
                  className={`flex-1 px-2 py-1.5 rounded-lg border text-[10px] font-medium transition-colors ${
                    dbType === type ? "text-white" : "border-[var(--color-border)] text-[var(--color-text)]"
                  }`}
                  style={dbType === type ? { background: info.color, borderColor: info.color } : undefined}
                >
                  {info.label}
                </button>
              ))}
            </div>
          </div>

          {dbType === "sqlite" ? (
            <div>
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">文件路径</label>
              <input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="/path/to/database.db" className={inputCls + " mt-1"} />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">主机</label>
                  <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost" className={inputCls + " mt-1"} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">端口</label>
                  <input value={port} onChange={(e) => setPort(e.target.value)} className={inputCls + " mt-1"} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">用户名</label>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" className={inputCls + " mt-1"} />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">密码</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls + " mt-1"} />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  数据库{dbType === "mysql" ? "（可选）" : ""}
                </label>
                <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="mydb" className={inputCls + " mt-1"} />
                <div className="mt-1 text-[10px] text-[var(--color-text-secondary)] opacity-75">
                  {dbType === "mysql"
                    ? "留空则连接 MySQL 实例，可浏览全部可访问 database，并在 SQL 中使用 db.table 跨库查询。"
                    : `${DB_TYPE_LABELS[dbType].label} 连接需要填写数据库名，例如业务库名`}
                </div>
              </div>
            </>
          )}

          <div className="rounded-lg border border-[var(--color-border)] p-2 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] font-medium">自然语言导出</div>
                <div className="text-[10px] text-[var(--color-text-secondary)]">
                  启用后会被导出专线和数据集草稿能力使用
                </div>
              </div>
              <button
                onClick={() => setExportEnabled((value) => !value)}
                className={`px-2 py-1 rounded text-[10px] font-medium ${
                  exportEnabled
                    ? "bg-emerald-500/10 text-emerald-600"
                    : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                }`}
              >
                {exportEnabled ? "已启用" : "已关闭"}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">导出别名</label>
                <input value={exportAlias} onChange={(e) => setExportAlias(e.target.value)} placeholder="业务库" className={inputCls + " mt-1"} />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">最大导出行数</label>
                <input value={maxExportRows} onChange={(e) => setMaxExportRows(e.target.value)} placeholder="10000" className={inputCls + " mt-1"} />
              </div>
            </div>
            {dbType !== "sqlite" && (
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  {dbType === "mysql" ? "默认数据库（导出）" : "默认 Schema"}
                </label>
                <input
                  value={exportDefaultSchema}
                  onChange={(e) => setExportDefaultSchema(e.target.value)}
                  placeholder={dbType === "mysql" ? "analytics" : "public"}
                  className={inputCls + " mt-1"}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={onCancel} className="flex-1 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] text-xs font-medium">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !canSubmit}
            className="flex-1 py-2 rounded-lg text-white text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1"
            style={{ background: BRAND }}
          >
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

function DatasetDraftModal({
  draft,
  onSave,
  onCancel,
}: {
  draft: PersonalExportDatasetDefinition;
  onSave: (draft: PersonalExportDatasetDefinition) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(() => clonePersonalDataset(draft));
  const [saving, setSaving] = useState(false);
  const inputCls =
    "w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs text-[var(--color-text)] focus:ring-2 focus:ring-[#F28F3640] transition-all outline-none";

  const toggleDefaultField = (fieldName: string) => {
    setValue((current) => {
      const target = current.fields.find((field) => field.name === fieldName);
      if (!target || target.enabled === false) {
        return current;
      }
      const exists = current.defaultFields.includes(fieldName);
      return {
        ...current,
        defaultFields: exists
          ? current.defaultFields.filter((item) => item !== fieldName)
          : [...current.defaultFields, fieldName],
      };
    });
  };

  const updateField = (fieldName: string, patch: Partial<PersonalExportDatasetDefinition["fields"][number]>) => {
    setValue((current) => ({
      ...current,
      fields: current.fields.map((field) =>
        field.name === fieldName ? { ...field, ...patch } : field,
      ),
    }));
  };

  const toggleFieldEnabled = (fieldName: string) => {
    setValue((current) => {
      const nextEnabled = !current.fields.find((field) => field.name === fieldName)?.enabled;
      return {
        ...current,
        fields: current.fields.map((field) =>
          field.name === fieldName ? { ...field, enabled: nextEnabled } : field,
        ),
        defaultFields: nextEnabled
          ? current.defaultFields
          : current.defaultFields.filter((item) => item !== fieldName),
      };
    });
  };

  const updateRelation = (
    relationId: string,
    patch: Partial<DatasetRelationDefinition>,
  ) => {
    setValue((current) => ({
      ...current,
      relations: (current.relations ?? []).map((relation) =>
        relation.id === relationId ? { ...relation, ...patch } : relation,
      ),
    }));
  };

  const removeRelation = (relationId: string) => {
    setValue((current) => ({
      ...current,
      relations: (current.relations ?? []).filter((relation) => relation.id !== relationId),
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      ...value,
      aliases: (value.aliases ?? []).map((item) => item.trim()).filter(Boolean),
      intentTags: (value.intentTags ?? []).map((item) => item.trim()).filter(Boolean),
      examplePrompts: (value.examplePrompts ?? []).map((item) => item.trim()).filter(Boolean),
      baseAlias: value.baseAlias?.trim() || "base",
      keywordField: value.keywordField?.trim() || undefined,
      fields: value.fields.map((field) => ({
        ...field,
        label: field.label.trim() || field.name,
        aliases: (field.aliases ?? []).map((item) => item.trim()).filter(Boolean),
        description: field.description?.trim() || undefined,
      })),
      relations: ((value.relations ?? [])
        .map((relation) => {
          const left = relation.on?.[0]?.left?.trim() || "";
          const right = relation.on?.[0]?.right?.trim() || "";
          const targetEntityName = relation.targetEntityName.trim();
          if (!targetEntityName || !left || !right) return null;
          return {
            ...relation,
            name: relation.name.trim() || humanizeFieldName(targetEntityName),
            description: relation.description?.trim() || undefined,
            targetEntityName,
            targetSchema: relation.targetSchema?.trim() || undefined,
            alias: relation.alias?.trim() || undefined,
            triggerKeywords: (relation.triggerKeywords ?? []).map((item) => item.trim()).filter(Boolean),
            on: [
              {
                left,
                right,
                op: relation.on?.[0]?.op?.trim() || "eq",
              },
            ],
            defaultFields: (relation.defaultFields ?? []).filter((field) => field.field.trim()),
            enabled: relation.enabled !== false,
          };
        })
        .filter(Boolean) as DatasetRelationDefinition[]),
      defaultFields: value.defaultFields.filter((fieldName) =>
        value.fields.some((field) => field.name === fieldName && field.enabled !== false),
      ),
      updatedAt: Date.now(),
    });
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[var(--color-bg)] w-[860px] max-h-[84vh] overflow-y-auto rounded-xl p-4 border border-[var(--color-border)] shadow-xl space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">生成本地数据集草稿</h3>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              保存后，导出专线会优先参考这个业务入口理解自然语言请求；你可以继续补业务别名、查找字段和联表关系。
            </p>
          </div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-[var(--color-bg-secondary)]">
            <X className="w-4 h-4 text-[var(--color-text-secondary)]" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">数据集名称</label>
            <input
              value={value.displayName}
              onChange={(event) => setValue((current) => ({ ...current, displayName: event.target.value }))}
              className={inputCls + " mt-1"}
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">时间字段</label>
            <select
              value={value.timeField ?? ""}
              onChange={(event) => setValue((current) => ({ ...current, timeField: event.target.value || undefined }))}
              className={inputCls + " mt-1"}
            >
              <option value="">不指定</option>
              {value.fields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">业务别名</label>
            <input
              value={(value.aliases ?? []).join(", ")}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  aliases: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                }))
              }
              className={inputCls + " mt-1"}
              placeholder="企业, 公司, 客户资料"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">意图标签</label>
            <input
              value={(value.intentTags ?? []).join(", ")}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  intentTags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                }))
              }
              className={inputCls + " mt-1"}
              placeholder="企业基础信息, 客户详情"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">主查找字段</label>
            <select
              value={value.keywordField ?? ""}
              onChange={(event) => setValue((current) => ({ ...current, keywordField: event.target.value || undefined }))}
              className={inputCls + " mt-1"}
            >
              <option value="">自动推断</option>
              {value.fields
                .filter((field) => field.enabled !== false)
                .map((field) => (
                  <option key={field.name} value={field.name}>
                    {field.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">基础表别名</label>
            <input
              value={value.baseAlias ?? ""}
              onChange={(event) => setValue((current) => ({ ...current, baseAlias: event.target.value }))}
              className={inputCls + " mt-1"}
              placeholder="base"
            />
          </div>
        </div>

        <div>
          <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">描述</label>
          <textarea
            value={value.description}
            onChange={(event) => setValue((current) => ({ ...current, description: event.target.value }))}
            className={inputCls + " mt-1 h-[72px] resize-none"}
          />
        </div>

        <div>
          <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">示例问法</label>
          <textarea
            value={(value.examplePrompts ?? []).join("\n")}
            onChange={(event) =>
              setValue((current) => ({
                ...current,
                examplePrompts: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean),
              }))
            }
            className={inputCls + " mt-1 h-[72px] resize-none"}
            placeholder={"帮我导出某企业基础信息\n帮我查询某企业联系人和电话"}
          />
        </div>

        <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
          <span className="px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)]">
            {value.schema ? `${value.schema}.` : ""}{value.entityName}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)]">
            默认导出上限 {value.maxExportRows ?? 10000}
          </span>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase mb-1.5">字段草稿</div>
          <div className="space-y-1.5">
            {value.fields.map((field) => (
              <div key={field.name} className="rounded-lg border border-[var(--color-border)] p-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleFieldEnabled(field.name)}
                    className={`px-2 py-1 rounded text-[10px] font-medium ${
                      field.enabled !== false
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                    }`}
                  >
                    {field.enabled !== false ? "已启用" : "已隐藏"}
                  </button>
                  <button
                    onClick={() => toggleDefaultField(field.name)}
                    disabled={field.enabled === false}
                    className={`px-2 py-1 rounded text-[10px] font-medium ${
                      value.defaultFields.includes(field.name)
                        ? "bg-[#F28F36]/10 text-[#F28F36]"
                        : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                    } disabled:opacity-40`}
                  >
                    {value.defaultFields.includes(field.name) ? "默认导出" : "仅保留"}
                  </button>
                  <div className="flex-1 text-[11px] font-medium truncate">{field.name}</div>
                  <div className="text-[9px] text-[var(--color-text-secondary)]">{field.dataType || "-"}</div>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <input
                    value={field.label}
                    onChange={(event) => updateField(field.name, { label: event.target.value })}
                    className={inputCls}
                    placeholder="字段展示名"
                  />
                  <input
                    value={(field.aliases ?? []).join(", ")}
                    onChange={(event) =>
                      updateField(field.name, {
                        aliases: event.target.value
                          .split(",")
                          .map((item) => item.trim())
                          .filter(Boolean),
                      })
                    }
                    className={inputCls}
                    placeholder="别名，逗号分隔"
                  />
                </div>
                <textarea
                  value={field.description ?? ""}
                  onChange={(event) => updateField(field.name, { description: event.target.value })}
                  className={inputCls + " mt-2 h-[56px] resize-none"}
                  placeholder="补充这个字段的业务含义，可选"
                />
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">联表关系</div>
            <button
              onClick={() =>
                setValue((current) => ({
                  ...current,
                  relations: [...(current.relations ?? []), createEmptyDatasetRelation(current.baseAlias?.trim() || "base")],
                }))
              }
              className="px-2 py-1 rounded bg-[#F28F36]/10 text-[#F28F36] text-[10px] font-medium"
            >
              新增关系
            </button>
          </div>
          {(value.relations ?? []).length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-4 text-[10px] text-[var(--color-text-secondary)]">
              没有配置关系时，导出专线会按当前数据集做单表查询。
            </div>
          ) : (
            <div className="space-y-2">
              {(value.relations ?? []).map((relation) => (
                <div key={relation.id} className="rounded-lg border border-[var(--color-border)] p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateRelation(relation.id, { enabled: relation.enabled === false })}
                      className={`px-2 py-1 rounded text-[10px] font-medium ${
                        relation.enabled !== false
                          ? "bg-emerald-500/10 text-emerald-600"
                          : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                      }`}
                    >
                      {relation.enabled !== false ? "已启用" : "已禁用"}
                    </button>
                    <input
                      value={relation.name}
                      onChange={(event) => updateRelation(relation.id, { name: event.target.value })}
                      className={inputCls}
                      placeholder="关系名称，例如 企业联系人"
                    />
                    <button
                      onClick={() => removeRelation(relation.id)}
                      className="p-1 rounded hover:bg-red-500/10"
                      title="删除关系"
                    >
                      <Trash2 className="w-3 h-3 text-red-400" />
                    </button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <input
                      value={relation.targetSchema ?? ""}
                      onChange={(event) => updateRelation(relation.id, { targetSchema: event.target.value })}
                      className={inputCls}
                      placeholder="目标 schema，可选"
                    />
                    <input
                      value={relation.targetEntityName}
                      onChange={(event) => updateRelation(relation.id, { targetEntityName: event.target.value })}
                      className={inputCls}
                      placeholder="目标表名"
                    />
                    <input
                      value={relation.alias ?? ""}
                      onChange={(event) => updateRelation(relation.id, { alias: event.target.value })}
                      className={inputCls}
                      placeholder="目标别名，如 u"
                    />
                    <select
                      value={relation.joinType ?? "left"}
                      onChange={(event) =>
                        updateRelation(relation.id, {
                          joinType: event.target.value as DatasetRelationDefinition["joinType"],
                        })
                      }
                      className={inputCls}
                    >
                      <option value="left">left join</option>
                      <option value="inner">inner join</option>
                      <option value="right">right join</option>
                    </select>
                  </div>
                  <textarea
                    value={relation.description ?? ""}
                    onChange={(event) => updateRelation(relation.id, { description: event.target.value })}
                    className={inputCls + " h-[56px] resize-none"}
                    placeholder="描述这个关系适合回答什么问题，例如 联系人/电话/推广归属"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={(relation.triggerKeywords ?? []).join(", ")}
                      onChange={(event) =>
                        updateRelation(relation.id, {
                          triggerKeywords: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                        })
                      }
                      className={inputCls}
                      placeholder="触发关键词，例如 联系人, 电话, 手机"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={relation.on?.[0]?.left ?? ""}
                        onChange={(event) =>
                          updateRelation(relation.id, {
                            on: [
                              {
                                left: event.target.value,
                                op: relation.on?.[0]?.op ?? "eq",
                                right: relation.on?.[0]?.right ?? "",
                              },
                            ],
                          })
                        }
                        className={inputCls}
                        placeholder="左侧字段，如 base.id"
                      />
                      <input
                        value={relation.on?.[0]?.right ?? ""}
                        onChange={(event) =>
                          updateRelation(relation.id, {
                            on: [
                              {
                                left: relation.on?.[0]?.left ?? "",
                                op: relation.on?.[0]?.op ?? "eq",
                                right: event.target.value,
                              },
                            ],
                          })
                        }
                        className={inputCls}
                        placeholder="右侧字段，如 u.company_id"
                      />
                    </div>
                  </div>
                  <textarea
                    value={formatRelationFieldsInput(relation.defaultFields)}
                    onChange={(event) =>
                      updateRelation(relation.id, {
                        defaultFields: parseRelationFieldsInput(event.target.value),
                      })
                    }
                    className={inputCls + " h-[72px] resize-none"}
                    placeholder={"导出字段，一行一个。支持 field 或 field:展示名\ncontact_name:联系人\nmobile:手机号"}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="flex-1 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] text-xs font-medium">
            取消
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || !value.displayName.trim()}
            className="flex-1 py-2 rounded-lg text-white text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1"
            style={{ background: BRAND }}
          >
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            保存数据集
          </button>
        </div>
      </div>
    </div>
  );
}
