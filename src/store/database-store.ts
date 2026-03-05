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
}

export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  connectedIds: new Set(),
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
    await invoke("db_connect", { config });
    set((s) => ({
      connectedIds: new Set([...s.connectedIds, id]),
      activeConnectionId: id,
    }));
    await get().loadSchemas();
    await get().loadTables();
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
      };
    });
  },

  testConnection: async (config) => {
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

  setActiveConnection: (id) => set({ activeConnectionId: id }),
}));
