import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Database,
  FileSpreadsheet,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { handleError } from "@/core/errors";
import {
  deleteTeamDataSource,
  deleteTeamExportDataset,
  isTeamDataExportApiUnavailable,
  listTeamDataSources,
  listTeamExportDatasets,
  saveTeamDataSource,
  saveTeamExportDataset,
  type TeamDataSourceSummary,
  type TeamExportDatasetSummary,
} from "@/core/data-export/team-data-export-api";
import type { ExportDatasetFieldDefinition } from "@/core/data-export/types";

const TEAM_DB_PORTS = {
  sqlite: 0,
  postgres: 5432,
  mysql: 3306,
  mongodb: 27017,
} as const;

type TeamDbType = keyof typeof TEAM_DB_PORTS;

interface SourceFormState {
  id?: string;
  name: string;
  db_type: TeamDbType;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  connection_string: string;
  export_alias: string;
  export_default_schema: string;
  max_export_rows: string;
  enabled: boolean;
}

interface DatasetFormState {
  id?: string;
  display_name: string;
  description: string;
  source_id: string;
  entity_name: string;
  entity_type: "table" | "view" | "collection";
  schema: string;
  time_field: string;
  default_fields: string;
  fields: ExportDatasetFieldDefinition[];
  enabled: boolean;
}

function createEmptySourceForm(dbType: TeamDbType = "postgres"): SourceFormState {
  return {
    name: "",
    db_type: dbType,
    host: "",
    port: String(TEAM_DB_PORTS[dbType]),
    database: "",
    username: "",
    password: "",
    connection_string: "",
    export_alias: "",
    export_default_schema: dbType === "postgres" ? "public" : "",
    max_export_rows: "10000",
    enabled: true,
  };
}

function createEmptyDatasetForm(sourceId = ""): DatasetFormState {
  return {
    display_name: "",
    description: "",
    source_id: sourceId,
    entity_name: "",
    entity_type: "table",
    schema: "",
    time_field: "",
    default_fields: "",
    fields: [],
    enabled: true,
  };
}

function normalizeCsvFields(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function TeamDataExportSection({
  teamId,
  isOwnerOrAdmin,
  teamActive,
}: {
  teamId: string;
  isOwnerOrAdmin: boolean;
  teamActive: boolean;
}) {
  const [sources, setSources] = useState<TeamDataSourceSummary[]>([]);
  const [datasets, setDatasets] = useState<TeamExportDatasetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiUnavailable, setApiUnavailable] = useState(false);
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [showDatasetForm, setShowDatasetForm] = useState(false);
  const [sourceForm, setSourceForm] = useState<SourceFormState>(() => createEmptySourceForm());
  const [datasetForm, setDatasetForm] = useState<DatasetFormState>(() => createEmptyDatasetForm());
  const [sourceUsernameHint, setSourceUsernameHint] = useState("");
  const [savingSource, setSavingSource] = useState(false);
  const [savingDataset, setSavingDataset] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const sourceNameMap = useMemo(
    () => new Map(sources.map((source) => [source.id, source.name])),
    [sources],
  );

  const resetDatasetForm = useCallback((preferredSourceId = "") => {
    setDatasetForm(createEmptyDatasetForm(preferredSourceId));
  }, []);

  const handleApiError = useCallback((error: unknown, context: string) => {
    if (isTeamDataExportApiUnavailable(error)) {
      setApiUnavailable(true);
      return true;
    }
    handleError(error, { context });
    return false;
  }, []);

  const fetchData = useCallback(async () => {
    if (!teamActive) {
      setSources([]);
      setDatasets([]);
      setApiUnavailable(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [sourceItems, datasetItems] = await Promise.all([
        listTeamDataSources(teamId),
        listTeamExportDatasets(teamId),
      ]);
      setSources(sourceItems);
      setDatasets(datasetItems);
      setApiUnavailable(false);
    } catch (error) {
      if (handleApiError(error, "获取团队数据导出配置")) {
        setSources([]);
        setDatasets([]);
      }
    } finally {
      setLoading(false);
    }
  }, [handleApiError, teamActive, teamId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (showDatasetForm || datasetForm.id) return;
    if (!datasetForm.source_id && sources.length > 0) {
      setDatasetForm((current) => ({ ...current, source_id: sources[0].id }));
    }
  }, [datasetForm.id, datasetForm.source_id, showDatasetForm, sources]);

  const handleEditSource = (source: TeamDataSourceSummary) => {
    setSourceForm({
      id: source.id,
      name: source.name,
      db_type: source.db_type,
      host: source.host ?? "",
      port: source.port ? String(source.port) : String(TEAM_DB_PORTS[source.db_type]),
      database: source.database ?? "",
      username: "",
      password: "",
      connection_string: "",
      export_alias: source.export_alias ?? "",
      export_default_schema: source.export_default_schema ?? "",
      max_export_rows: source.max_export_rows ? String(source.max_export_rows) : "10000",
      enabled: source.enabled !== false,
    });
    setSourceUsernameHint(source.masked_username ?? "");
    setShowSourceForm(true);
  };

  const handleSaveSource = async () => {
    if (!sourceForm.name.trim()) return;
    setSavingSource(true);
    try {
      await saveTeamDataSource(teamId, {
        ...(sourceForm.id ? { id: sourceForm.id } : {}),
        name: sourceForm.name.trim(),
        db_type: sourceForm.db_type,
        ...(sourceForm.host.trim() ? { host: sourceForm.host.trim() } : {}),
        ...(sourceForm.port.trim() ? { port: Number.parseInt(sourceForm.port, 10) } : {}),
        ...(sourceForm.database.trim() ? { database: sourceForm.database.trim() } : {}),
        ...(sourceForm.username.trim() ? { username: sourceForm.username.trim() } : {}),
        ...(sourceForm.password.trim() ? { password: sourceForm.password } : {}),
        ...(sourceForm.connection_string.trim()
          ? { connection_string: sourceForm.connection_string.trim() }
          : {}),
        ...(sourceForm.export_alias.trim() ? { export_alias: sourceForm.export_alias.trim() } : {}),
        ...(sourceForm.export_default_schema.trim()
          ? { export_default_schema: sourceForm.export_default_schema.trim() }
          : {}),
        ...(sourceForm.max_export_rows.trim()
          ? { max_export_rows: Number.parseInt(sourceForm.max_export_rows, 10) }
          : {}),
        enabled: sourceForm.enabled,
      });
      setShowSourceForm(false);
      setSourceForm(createEmptySourceForm());
      setSourceUsernameHint("");
      await fetchData();
    } catch (error) {
      handleApiError(error, "保存团队数据源");
    } finally {
      setSavingSource(false);
    }
  };

  const handleDeleteSource = async (sourceId: string) => {
    if (!confirm("确定删除这个团队数据源吗？已发布的数据集也可能受影响。")) return;
    setDeletingKey(`source:${sourceId}`);
    try {
      await deleteTeamDataSource(teamId, sourceId);
      await fetchData();
    } catch (error) {
      handleApiError(error, "删除团队数据源");
    } finally {
      setDeletingKey(null);
    }
  };

  const handleEditDataset = (dataset: TeamExportDatasetSummary) => {
    setDatasetForm({
      id: dataset.id,
      display_name: dataset.display_name,
      description: dataset.description ?? "",
      source_id: dataset.source_id,
      entity_name: dataset.entity_name,
      entity_type: dataset.entity_type,
      schema: dataset.schema ?? "",
      time_field: dataset.time_field ?? "",
      default_fields: (dataset.default_fields ?? []).join(", "),
      fields: dataset.fields ?? [],
      enabled: dataset.enabled !== false,
    });
    setShowDatasetForm(true);
  };

  const handleSaveDataset = async () => {
    if (!datasetForm.display_name.trim() || !datasetForm.source_id || !datasetForm.entity_name.trim()) {
      return;
    }
    setSavingDataset(true);
    try {
      await saveTeamExportDataset(teamId, {
        ...(datasetForm.id ? { id: datasetForm.id } : {}),
        display_name: datasetForm.display_name.trim(),
        ...(datasetForm.description.trim() ? { description: datasetForm.description.trim() } : {}),
        source_id: datasetForm.source_id,
        entity_name: datasetForm.entity_name.trim(),
        entity_type: datasetForm.entity_type,
        ...(datasetForm.schema.trim() ? { schema: datasetForm.schema.trim() } : {}),
        ...(datasetForm.time_field.trim() ? { time_field: datasetForm.time_field.trim() } : {}),
        ...(datasetForm.default_fields.trim()
          ? { default_fields: normalizeCsvFields(datasetForm.default_fields) }
          : {}),
        ...(datasetForm.fields.length ? { fields: datasetForm.fields } : {}),
        enabled: datasetForm.enabled,
      });
      setShowDatasetForm(false);
      resetDatasetForm();
      await fetchData();
    } catch (error) {
      handleApiError(error, "保存团队数据集");
    } finally {
      setSavingDataset(false);
    }
  };

  const handleDeleteDataset = async (datasetId: string) => {
    if (!confirm("确定删除这个已发布数据集吗？")) return;
    setDeletingKey(`dataset:${datasetId}`);
    try {
      await deleteTeamExportDataset(teamId, datasetId);
      await fetchData();
    } catch (error) {
      handleApiError(error, "删除团队数据集");
    } finally {
      setDeletingKey(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-[#F28F36]" />
      </div>
    );
  }

  if (!teamActive) {
    return (
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)]">
        <h3 className="text-xs font-semibold">数据导出</h3>
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
          团队已到期，团队共享数据源与已发布数据集能力暂不可用。
        </p>
      </div>
    );
  }

  if (apiUnavailable) {
    return (
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)]">
        <h3 className="text-xs font-semibold">数据导出</h3>
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
          服务端暂未启用团队数据导出能力。当前桌面端已预留数据源和数据集管理契约，后端接入后即可启用。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-[var(--space-compact-2)]">
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold">团队数据导出</h3>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              团队机器人在服务端执行导出，成员只消费已发布数据集，不直接接触数据库凭证和原始表结构。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 min-w-[180px]">
            <div className="rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2">
              <div className="text-lg font-semibold text-[#F28F36]">{sources.length}</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">共享数据源</div>
            </div>
            <div className="rounded-lg bg-[var(--color-bg-secondary)] px-3 py-2">
              <div className="text-lg font-semibold text-[#F28F36]">{datasets.length}</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">已发布数据集</div>
            </div>
          </div>
        </div>
      </div>

      {isOwnerOrAdmin && (
        <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)] space-y-[var(--space-compact-2)]">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold">共享数据源</h3>
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                先配置团队只读数据源，再从中发布业务可理解的数据集。
              </p>
            </div>
            <button
              onClick={() => {
                setSourceForm(createEmptySourceForm());
                setSourceUsernameHint("");
                setShowSourceForm((value) => !value);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold"
            >
              <Plus className="w-3.5 h-3.5" />
              新建数据源
            </button>
          </div>

          {showSourceForm && (
            <div className="rounded-xl border border-[#F28F36]/20 bg-[#F28F36]/5 p-[var(--space-compact-3)] space-y-[var(--space-compact-2)]">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    名称
                  </label>
                  <input
                    value={sourceForm.name}
                    onChange={(event) => setSourceForm((current) => ({ ...current, name: event.target.value }))}
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder="订单只读库"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    数据库类型
                  </label>
                  <div className="mt-1 flex gap-1.5">
                    {(Object.keys(TEAM_DB_PORTS) as TeamDbType[]).map((dbType) => (
                      <button
                        key={dbType}
                        onClick={() =>
                          setSourceForm((current) => ({
                            ...current,
                            db_type: dbType,
                            port: String(TEAM_DB_PORTS[dbType]),
                            export_default_schema:
                              dbType === "postgres"
                                ? current.export_default_schema || "public"
                                : current.export_default_schema,
                          }))
                        }
                        className={`flex-1 rounded-lg border px-2 py-1.5 text-[10px] font-medium ${
                          sourceForm.db_type === dbType
                            ? "border-[#F28F36] bg-[#F28F36]/10 text-[#F28F36]"
                            : "border-[var(--color-border)] text-[var(--color-text-secondary)]"
                        }`}
                      >
                        {dbType}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    主机
                  </label>
                  <input
                    value={sourceForm.host}
                    onChange={(event) => setSourceForm((current) => ({ ...current, host: event.target.value }))}
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder="db.internal.company"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    端口
                  </label>
                  <input
                    value={sourceForm.port}
                    onChange={(event) => setSourceForm((current) => ({ ...current, port: event.target.value }))}
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder={String(TEAM_DB_PORTS[sourceForm.db_type])}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    数据库
                  </label>
                  <input
                    value={sourceForm.database}
                    onChange={(event) => setSourceForm((current) => ({ ...current, database: event.target.value }))}
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder={sourceForm.db_type === "mongodb" ? "analytics" : "app_prod"}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    导出别名
                  </label>
                  <input
                    value={sourceForm.export_alias}
                    onChange={(event) => setSourceForm((current) => ({ ...current, export_alias: event.target.value }))}
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder="订单库"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    用户名
                  </label>
                  <input
                    value={sourceForm.username}
                    onChange={(event) => setSourceForm((current) => ({ ...current, username: event.target.value }))}
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder={sourceUsernameHint || "readonly_user"}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    密码
                  </label>
                  <input
                    type="password"
                    value={sourceForm.password}
                    onChange={(event) => setSourceForm((current) => ({ ...current, password: event.target.value }))}
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder={sourceForm.id ? "留空则不更新" : "输入只读密码"}
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  连接串
                </label>
                <input
                  value={sourceForm.connection_string}
                  onChange={(event) => setSourceForm((current) => ({ ...current, connection_string: event.target.value }))}
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                  placeholder="可选，已使用 DSN 时可直接填写"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    默认 Schema
                  </label>
                  <input
                    value={sourceForm.export_default_schema}
                    onChange={(event) =>
                      setSourceForm((current) => ({ ...current, export_default_schema: event.target.value }))
                    }
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder={sourceForm.db_type === "postgres" ? "public" : "可选"}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    最大导出行数
                  </label>
                  <input
                    value={sourceForm.max_export_rows}
                    onChange={(event) => setSourceForm((current) => ({ ...current, max_export_rows: event.target.value }))}
                    className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                    placeholder="10000"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                    状态
                  </label>
                  <button
                    onClick={() => setSourceForm((current) => ({ ...current, enabled: !current.enabled }))}
                    className={`mt-1 w-full rounded-lg px-3 py-2 text-xs font-medium ${
                      sourceForm.enabled
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                    }`}
                  >
                    {sourceForm.enabled ? "已启用" : "已停用"}
                  </button>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => {
                    setShowSourceForm(false);
                    setSourceForm(createEmptySourceForm());
                    setSourceUsernameHint("");
                  }}
                  className="flex-1 py-2 rounded-lg border border-[var(--color-border)] text-xs font-medium"
                >
                  取消
                </button>
                <button
                  onClick={() => void handleSaveSource()}
                  disabled={savingSource || !sourceForm.name.trim()}
                  className="flex-1 py-2 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1"
                >
                  {savingSource && <Loader2 className="w-3 h-3 animate-spin" />}
                  保存数据源
                </button>
              </div>
            </div>
          )}

          {sources.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-6 text-center">
              <Database className="w-6 h-6 mx-auto mb-2 opacity-20 text-[var(--color-text-secondary)]" />
              <p className="text-xs text-[var(--color-text-secondary)]">还没有团队共享数据源</p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {sources.map((source) => (
                <div key={source.id} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-[#F28F36]/10 text-[#F28F36] flex items-center justify-center shrink-0">
                      <Server className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium flex items-center gap-2 flex-wrap">
                        <span>{source.name}</span>
                        <span className="px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[10px] text-[var(--color-text-secondary)]">
                          {source.db_type}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded-full text-[10px] ${
                            source.enabled !== false
                              ? "bg-emerald-500/10 text-emerald-600"
                              : "bg-gray-500/10 text-gray-500"
                          }`}
                        >
                          {source.enabled !== false ? "启用中" : "已停用"}
                        </span>
                      </div>
                      <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 break-all">
                        {(source.export_alias || source.database || source.host || "未填写连接信息") +
                          (source.export_default_schema ? ` · schema: ${source.export_default_schema}` : "")}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                        最大导出 {source.max_export_rows ?? 10000} 行
                        {source.has_password ? " · 已保存凭证" : ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleEditSource(source)}
                      className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[#F28F36] hover:bg-[#F28F36]/10 transition-colors"
                      title="编辑数据源"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => void handleDeleteSource(source.id)}
                      disabled={deletingKey === `source:${source.id}`}
                      className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      title="删除数据源"
                    >
                      {deletingKey === `source:${source.id}` ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-[var(--space-compact-3)] space-y-[var(--space-compact-2)]">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold">已发布数据集</h3>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              {isOwnerOrAdmin
                ? "成员自然语言导出时，只会优先看到你发布的业务数据集。"
                : "这里展示管理员已经发布的数据集，成员只通过这些业务入口发起导出。"}
            </p>
          </div>
          {isOwnerOrAdmin && (
            <button
              onClick={() => {
                resetDatasetForm();
                setShowDatasetForm((value) => !value);
              }}
              disabled={sources.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              发布数据集
            </button>
          )}
        </div>

        {isOwnerOrAdmin && showDatasetForm && (
          <div className="rounded-xl border border-[#F28F36]/20 bg-[#F28F36]/5 p-[var(--space-compact-3)] space-y-[var(--space-compact-2)]">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  数据集名称
                </label>
                <input
                  value={datasetForm.display_name}
                  onChange={(event) =>
                    setDatasetForm((current) => ({ ...current, display_name: event.target.value }))
                  }
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                  placeholder="近 30 天订单"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  绑定数据源
                </label>
                <select
                  value={datasetForm.source_id}
                  onChange={(event) => setDatasetForm((current) => ({ ...current, source_id: event.target.value }))}
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                >
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  底层实体
                </label>
                <input
                  value={datasetForm.entity_name}
                  onChange={(event) =>
                    setDatasetForm((current) => ({ ...current, entity_name: event.target.value }))
                  }
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                  placeholder="orders_daily_view"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  类型
                </label>
                <select
                  value={datasetForm.entity_type}
                  onChange={(event) =>
                    setDatasetForm((current) => ({
                      ...current,
                      entity_type: event.target.value as DatasetFormState["entity_type"],
                    }))
                  }
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                >
                  <option value="table">table</option>
                  <option value="view">view</option>
                  <option value="collection">collection</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  Schema
                </label>
                <input
                  value={datasetForm.schema}
                  onChange={(event) => setDatasetForm((current) => ({ ...current, schema: event.target.value }))}
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                  placeholder="public"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  时间字段
                </label>
                <input
                  value={datasetForm.time_field}
                  onChange={(event) => setDatasetForm((current) => ({ ...current, time_field: event.target.value }))}
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                  placeholder="created_at"
                />
              </div>
              <div>
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                  默认字段
                </label>
                <input
                  value={datasetForm.default_fields}
                  onChange={(event) =>
                    setDatasetForm((current) => ({ ...current, default_fields: event.target.value }))
                  }
                  className="mt-1 w-full bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none"
                  placeholder="order_id, amount, created_at"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">
                描述
              </label>
              <textarea
                value={datasetForm.description}
                onChange={(event) =>
                  setDatasetForm((current) => ({ ...current, description: event.target.value }))
                }
                className="mt-1 w-full h-[72px] bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 text-xs outline-none resize-none"
                placeholder="告诉成员这个数据集适合回答什么问题。"
              />
            </div>

            <div className="flex items-center justify-between">
              <button
                onClick={() => setDatasetForm((current) => ({ ...current, enabled: !current.enabled }))}
                className={`px-3 py-2 rounded-lg text-xs font-medium ${
                  datasetForm.enabled
                    ? "bg-emerald-500/10 text-emerald-600"
                    : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]"
                }`}
              >
                {datasetForm.enabled ? "数据集已发布" : "数据集已停用"}
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowDatasetForm(false);
                    resetDatasetForm();
                  }}
                  className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-xs font-medium"
                >
                  取消
                </button>
                <button
                  onClick={() => void handleSaveDataset()}
                  disabled={
                    savingDataset ||
                    !datasetForm.display_name.trim() ||
                    !datasetForm.source_id ||
                    !datasetForm.entity_name.trim()
                  }
                  className="px-4 py-2 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1"
                >
                  {savingDataset && <Loader2 className="w-3 h-3 animate-spin" />}
                  保存数据集
                </button>
              </div>
            </div>
          </div>
        )}

        {datasets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-6 text-center">
            <FileSpreadsheet className="w-6 h-6 mx-auto mb-2 opacity-20 text-[var(--color-text-secondary)]" />
            <p className="text-xs text-[var(--color-text-secondary)]">
              {isOwnerOrAdmin ? "还没有发布数据集" : "管理员尚未发布数据集"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {datasets.map((dataset) => (
              <div key={dataset.id} className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-[#F28F36]/10 text-[#F28F36] flex items-center justify-center shrink-0">
                    <FileSpreadsheet className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium flex items-center gap-2 flex-wrap">
                      <span>{dataset.display_name}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded-full text-[10px] ${
                          dataset.enabled !== false
                            ? "bg-emerald-500/10 text-emerald-600"
                            : "bg-gray-500/10 text-gray-500"
                        }`}
                      >
                        {dataset.enabled !== false ? "已发布" : "已停用"}
                      </span>
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                      {sourceNameMap.get(dataset.source_id) || dataset.source_id}
                      {" · "}
                      {dataset.schema ? `${dataset.schema}.` : ""}
                      {dataset.entity_name}
                      {" · "}
                      {dataset.entity_type}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 flex items-center gap-1.5 flex-wrap">
                      {dataset.time_field && <span>时间字段: {dataset.time_field}</span>}
                      {(dataset.default_fields ?? []).length > 0 && (
                        <span>默认字段: {(dataset.default_fields ?? []).slice(0, 4).join(", ")}</span>
                      )}
                      {(dataset.fields ?? []).length > 0 && (
                        <span>字段数: {dataset.fields?.length}</span>
                      )}
                    </div>
                    {dataset.description && (
                      <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                        {dataset.description}
                      </div>
                    )}
                  </div>
                </div>
                {isOwnerOrAdmin && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleEditDataset(dataset)}
                      className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[#F28F36] hover:bg-[#F28F36]/10 transition-colors"
                      title="编辑数据集"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => void handleDeleteDataset(dataset.id)}
                      disabled={deletingKey === `dataset:${dataset.id}`}
                      className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      title="删除数据集"
                    >
                      {deletingKey === `dataset:${dataset.id}` ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!isOwnerOrAdmin && datasets.length > 0 && (
          <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[10px] text-emerald-600 flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5" />
            成员侧只读取这些已发布数据集，后续 IM 导出 Agent 会基于这里的业务入口理解查询请求。
          </div>
        )}
      </div>
    </div>
  );
}
