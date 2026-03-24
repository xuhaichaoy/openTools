import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";

export interface DatabaseConfig {
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

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  affected: number;
  elapsed_ms: number;
}

export interface TableInfo {
  name: string;
  schema?: string;
  table_type?: string;
  row_count?: number;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  primary_key: boolean;
  default_value?: string;
}

export interface DatabaseClientContext {
  connectionId: string | null;
  connectionName?: string;
  dbType?: DatabaseConfig["db_type"];
  schema: string | null;
  tableKey: string | null;
  tableName: string | null;
}

function getDatabaseTypeLabel(dbType: DatabaseConfig["db_type"]): string {
  switch (dbType) {
    case "sqlite":
      return "SQLite";
    case "postgres":
      return "PostgreSQL";
    case "mysql":
      return "MySQL";
    case "mongodb":
      return "MongoDB";
    default:
      return dbType;
  }
}

function requiresDatabaseName(config: Pick<DatabaseConfig, "db_type" | "connection_string" | "database">): boolean {
  if (config.connection_string?.trim()) return false;
  return config.db_type === "postgres" || config.db_type === "mongodb";
}

interface QueryHistoryItem {
  query: string;
  connId: string;
  executedAt: number;
  elapsed_ms: number;
  success: boolean;
}

interface DatabaseState {
  connections: DatabaseConfig[];
  activeConnectionId: string | null;
  connectedIds: Set<string>;
  databaseClientContext: DatabaseClientContext;
  queryResult: QueryResult | null;
  queryHistory: QueryHistoryItem[];
  tables: TableInfo[];
  tableColumns: Record<string, ColumnInfo[]>;
  schemas: string[];
  isLoading: boolean;
  isQuerying: boolean;

  loadConnections: () => Promise<void>;
  saveConnections: () => Promise<void>;
  addConnection: (config: DatabaseConfig) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  updateConnection: (id: string, partial: Partial<DatabaseConfig>) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  testConnection: (config: DatabaseConfig) => Promise<boolean>;
  executeQuery: (query: string) => Promise<QueryResult | null>;
  loadSchemas: () => Promise<void>;
  loadTables: (schema?: string) => Promise<void>;
  describeTable: (table: string) => Promise<ColumnInfo[]>;
  setActiveConnection: (id: string | null) => void;
  setDatabaseClientContext: (context: Partial<DatabaseClientContext>) => void;
  clearDatabaseClientContext: () => void;
}

const EMPTY_DATABASE_CLIENT_CONTEXT: DatabaseClientContext = {
  connectionId: null,
  schema: null,
  tableKey: null,
  tableName: null,
};

export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  connectedIds: new Set(),
  databaseClientContext: EMPTY_DATABASE_CLIENT_CONTEXT,
  queryResult: null,
  queryHistory: [],
  tables: [],
  tableColumns: {},
  schemas: [],
  isLoading: false,
  isQuerying: false,

  loadConnections: async () => {
    set({ isLoading: true });
    try {
      const conns = await invoke<DatabaseConfig[]>("db_load_connections");
      set({ connections: conns });
    } catch (e) {
      handleError(e, { context: "加载数据库连接" });
    }
    set({ isLoading: false });
  },

  saveConnections: async () => {
    try {
      await invoke("db_save_connections", { connections: get().connections });
    } catch (e) {
      handleError(e, { context: "保存数据库连接" });
    }
  },

  addConnection: async (config) => {
    const next = [...get().connections, config];
    set({ connections: next });
    await invoke("db_save_connections", { connections: next }).catch(() => {});
  },

  removeConnection: async (id) => {
    await get().disconnect(id).catch(() => {});
    const next = get().connections.filter((c) => c.id !== id);
    set({ connections: next });
    await invoke("db_save_connections", { connections: next }).catch(() => {});
  },

  updateConnection: async (id, partial) => {
    const next = get().connections.map((c) => (c.id === id ? { ...c, ...partial } : c));
    set({ connections: next });
    await invoke("db_save_connections", { connections: next }).catch(() => {});
  },

  connect: async (id) => {
    const config = get().connections.find((c) => c.id === id);
    if (!config) throw new Error("Connection not found");
    if (
      requiresDatabaseName(config)
      && !config.database?.trim()
    ) {
      const error = new Error(`${getDatabaseTypeLabel(config.db_type)} 需要填写数据库名，请删除该连接后重新创建`);
      handleError(error, { context: `连接数据库（${config.name}）` });
      throw error;
    }
    try {
      await invoke("db_connect", { config });
      set((s) => ({
        connectedIds: new Set([...s.connectedIds, id]),
        activeConnectionId: id,
        databaseClientContext: {
          connectionId: id,
          connectionName: config.name,
          dbType: config.db_type,
          schema: config.database?.trim() || null,
          tableKey: null,
          tableName: null,
        },
      }));
      await get().loadSchemas();
      if (config.db_type === "mysql" && !config.database?.trim()) {
        set({ tables: [], tableColumns: {} });
      } else {
        await get().loadTables();
      }
    } catch (e) {
      handleError(e, { context: `连接数据库（${config.name}）` });
      throw e;
    }
  },

  disconnect: async (id) => {
    try {
      await invoke("db_disconnect", { connId: id });
    } catch { /* ignore */ }
    set((s) => {
      const next = new Set(s.connectedIds);
      next.delete(id);
      return {
        connectedIds: next,
        activeConnectionId: s.activeConnectionId === id ? null : s.activeConnectionId,
        databaseClientContext:
          s.databaseClientContext.connectionId === id
            ? EMPTY_DATABASE_CLIENT_CONTEXT
            : s.databaseClientContext,
      };
    });
  },

  testConnection: async (config) => {
    if (
      requiresDatabaseName(config)
      && !config.database?.trim()
    ) {
      handleError(new Error(`${getDatabaseTypeLabel(config.db_type)} 需要填写数据库名`), { context: "测试数据库连接" });
      return false;
    }
    try {
      return await invoke<boolean>("db_test_connection", { config });
    } catch {
      return false;
    }
  },

  executeQuery: async (query) => {
    const connId = get().activeConnectionId;
    if (!connId) return null;

    set({ isQuerying: true });
    try {
      const result = await invoke<QueryResult>("db_execute_query", { connId, query });
      const historyItem: QueryHistoryItem = {
        query,
        connId,
        executedAt: Date.now(),
        elapsed_ms: result.elapsed_ms,
        success: true,
      };
      set((s) => ({
        queryResult: result,
        queryHistory: [historyItem, ...s.queryHistory.slice(0, 99)],
      }));
      return result;
    } catch (e) {
      const historyItem: QueryHistoryItem = {
        query,
        connId,
        executedAt: Date.now(),
        elapsed_ms: 0,
        success: false,
      };
      set((s) => ({
        queryHistory: [historyItem, ...s.queryHistory.slice(0, 99)],
      }));
      handleError(e, { context: "执行查询" });
      return null;
    } finally {
      set({ isQuerying: false });
    }
  },

  loadSchemas: async () => {
    const connId = get().activeConnectionId;
    if (!connId) return;
    try {
      const schemas = await invoke<string[]>("db_list_schemas", { connId });
      set({ schemas });
    } catch { /* ignore */ }
  },

  loadTables: async (schema) => {
    const connId = get().activeConnectionId;
    if (!connId) return;
    try {
      const tables = await invoke<TableInfo[]>("db_list_tables", {
        connId,
        schema: schema ?? null,
      });
      set({ tables });
    } catch { /* ignore */ }
  },

  describeTable: async (table) => {
    const connId = get().activeConnectionId;
    if (!connId) return [];
    try {
      const columns = await invoke<ColumnInfo[]>("db_describe_table", { connId, table });
      set((s) => ({ tableColumns: { ...s.tableColumns, [table]: columns } }));
      return columns;
    } catch {
      return [];
    }
  },

  setActiveConnection: (id) => set((state) => {
    const connection = state.connections.find((item) => item.id === id) ?? null;
    return {
      activeConnectionId: id,
      databaseClientContext: {
        connectionId: id,
        connectionName: connection?.name,
        dbType: connection?.db_type,
        schema:
          state.databaseClientContext.connectionId === id
            ? state.databaseClientContext.schema
            : connection?.database?.trim() || null,
        tableKey:
          state.databaseClientContext.connectionId === id
            ? state.databaseClientContext.tableKey
            : null,
        tableName:
          state.databaseClientContext.connectionId === id
            ? state.databaseClientContext.tableName
            : null,
      },
    };
  }),

  setDatabaseClientContext: (context) => set((state) => ({
    databaseClientContext: {
      ...state.databaseClientContext,
      ...context,
    },
  })),

  clearDatabaseClientContext: () => set({
    databaseClientContext: EMPTY_DATABASE_CLIENT_CONTEXT,
  }),
}));
