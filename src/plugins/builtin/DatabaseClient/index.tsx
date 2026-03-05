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
} from "lucide-react";
import {
  useDatabaseStore,
  type DatabaseConfig,
  type TableInfo,
  type ColumnInfo,
} from "@/store/database-store";
import { useDragWindow } from "@/hooks/useDragWindow";

const BRAND = "#F28F36";

const DB_TYPE_LABELS: Record<string, { label: string; color: string; defaultPort: number }> = {
  sqlite: { label: "SQLite", color: "#0ea5e9", defaultPort: 0 },
  postgres: { label: "PostgreSQL", color: "#336791", defaultPort: 5432 },
  mysql: { label: "MySQL", color: "#4479A1", defaultPort: 3306 },
  mongodb: { label: "MongoDB", color: "#47A248", defaultPort: 27017 },
};

export default function DatabaseClientPlugin({ onBack }: { onBack?: () => void }) {
  const { onMouseDown } = useDragWindow();
  const {
    connections,
    activeConnectionId,
    connectedIds,
    queryResult,
    tables,
    tableColumns,
    isLoading,
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
  } = useDatabaseStore();

  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("SELECT * FROM sqlite_master;");
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const handleConnect = useCallback(async (id: string) => {
    setActionLoading((p) => ({ ...p, [id]: true }));
    try {
      await connect(id);
    } catch { /* handled by store */ }
    setActionLoading((p) => ({ ...p, [id]: false }));
  }, [connect]);

  const handleTableClick = async (table: TableInfo) => {
    if (expandedTable === table.name) {
      setExpandedTable(null);
    } else {
      setExpandedTable(table.name);
      if (!tableColumns[table.name]) {
        await describeTable(table.name);
      }
    }
  };

  const handleExecute = () => {
    if (!query.trim()) return;
    executeQuery(query.trim());
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
                  onClick={() => setActiveConnection(conn.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                    isActive ? "font-medium" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={isActive ? { background: `${BRAND}15`, color: BRAND } : undefined}
                >
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: isConnected ? "#22c55e" : "#94a3b8" }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium truncate">{conn.name}</div>
                    <div className="text-[9px] opacity-60 truncate">
                      <span className="px-1 rounded" style={{ background: `${dbInfo.color}20`, color: dbInfo.color }}>
                        {dbInfo.label}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {loading ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : isConnected ? (
                      <button onClick={(e) => { e.stopPropagation(); disconnect(conn.id); }} className="p-0.5 rounded hover:bg-red-500/10">
                        <PowerOff className="w-2.5 h-2.5 text-red-400" />
                      </button>
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); handleConnect(conn.id); }} className="p-0.5 rounded hover:bg-emerald-500/10">
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
                <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase px-2 pb-1">
                  Tables
                </div>
                {tables.map((table) => (
                  <div key={table.name}>
                    <button
                      onClick={() => handleTableClick(table)}
                      className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--color-bg-secondary)] transition-colors"
                    >
                      {expandedTable === table.name ? (
                        <ChevronDown className="w-2.5 h-2.5 text-[var(--color-text-secondary)]" />
                      ) : (
                        <ChevronRight className="w-2.5 h-2.5 text-[var(--color-text-secondary)]" />
                      )}
                      <Table2 className="w-3 h-3" style={{ color: BRAND }} />
                      <span className="text-[11px] truncate">{table.name}</span>
                    </button>
                    {expandedTable === table.name && tableColumns[table.name] && (
                      <div className="ml-5 space-y-0.5 py-0.5">
                        {tableColumns[table.name].map((col) => (
                          <div
                            key={col.name}
                            className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                            onClick={() => setQuery((q) => q ? `${q.replace(/;$/, "")} /* ${col.name} */;` : `SELECT ${col.name} FROM ${table.name};`)}
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
                {tables.length === 0 && (
                  <p className="text-[10px] text-[var(--color-text-secondary)] text-center py-3">无表</p>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-[var(--color-text-secondary)] text-center py-4">
                连接后可浏览 Schema
              </p>
            )}
          </div>
        </div>

        {/* Main: Query Editor + Results */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Query Editor */}
          <div className="shrink-0 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)]">
              <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">SQL</span>
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
              placeholder="输入 SQL 查询... (Cmd+Enter 执行)"
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
  const [name, setName] = useState("");
  const [dbType, setDbType] = useState<DatabaseConfig["db_type"]>("sqlite");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [filePath, setFilePath] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) return;
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
                <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">数据库</label>
                <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="mydb" className={inputCls + " mt-1"} />
              </div>
            </>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={onCancel} className="flex-1 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] text-xs font-medium">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !name.trim()}
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
