import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
  auto_start?: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mime_type?: string;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: unknown[];
}

interface McpState {
  servers: McpServerConfig[];
  serverStatus: Record<string, "online" | "offline" | "starting">;
  serverTools: Record<string, McpToolDef[]>;
  serverResources: Record<string, McpResourceDef[]>;
  serverPrompts: Record<string, McpPromptDef[]>;
  isLoading: boolean;

  loadServers: () => Promise<void>;
  saveServers: (servers?: McpServerConfig[]) => Promise<void>;
  addServer: (config: McpServerConfig) => Promise<void>;
  removeServer: (id: string) => Promise<void>;
  updateServer: (id: string, partial: Partial<McpServerConfig>) => Promise<void>;
  startServer: (id: string) => Promise<void>;
  stopServer: (id: string) => Promise<void>;
  refreshTools: (id: string) => Promise<void>;
  refreshAllTools: () => Promise<void>;
  testConnection: (id: string) => Promise<boolean>;
  getAllMcpTools: () => McpToolDef[];
}

let jsonRpcId = 1000;

async function sendRpc(
  serverId: string,
  method: string,
  params?: unknown,
  transport?: "stdio" | "sse",
  url?: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const id = jsonRpcId++;
  const message = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params ?? {},
  });

  let response: string;
  if (transport === "sse" && url) {
    response = await invoke<string>("mcp_send_sse_message", {
      url,
      message,
      headers: headers ?? null,
    });
  } else {
    response = await invoke<string>("send_mcp_message", {
      serverId,
      message,
    });
  }

  const parsed = JSON.parse(response);
  if (parsed.error) {
    throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
  }
  return parsed.result;
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  serverStatus: {},
  serverTools: {},
  serverResources: {},
  serverPrompts: {},
  isLoading: false,

  loadServers: async () => {
    set({ isLoading: true });
    try {
      const configs = await invoke<McpServerConfig[]>("mcp_load_config");
      set({ servers: configs });
      for (const c of configs) {
        if (c.enabled && c.auto_start) {
          get().startServer(c.id).catch(() => {});
        }
      }
    } catch (e) {
      handleError(e, { context: "加载 MCP 配置" });
    }
    set({ isLoading: false });
  },

  saveServers: async (servers) => {
    const list = servers ?? get().servers;
    try {
      await invoke("mcp_save_config", { configs: list });
    } catch (e) {
      handleError(e, { context: "保存 MCP 配置" });
    }
  },

  addServer: async (config) => {
    const next = [...get().servers, config];
    set({ servers: next });
    await get().saveServers(next);
  },

  removeServer: async (id) => {
    try {
      await invoke("stop_mcp_server", { serverId: id }).catch(() => {});
    } catch { /* ignore */ }
    const next = get().servers.filter((s) => s.id !== id);
    const { serverStatus, serverTools, serverResources, serverPrompts } = get();
    const newStatus = { ...serverStatus };
    const newTools = { ...serverTools };
    const newResources = { ...serverResources };
    const newPrompts = { ...serverPrompts };
    delete newStatus[id];
    delete newTools[id];
    delete newResources[id];
    delete newPrompts[id];
    set({
      servers: next,
      serverStatus: newStatus,
      serverTools: newTools,
      serverResources: newResources,
      serverPrompts: newPrompts,
    });
    await get().saveServers(next);
  },

  updateServer: async (id, partial) => {
    const next = get().servers.map((s) =>
      s.id === id ? { ...s, ...partial } : s,
    );
    set({ servers: next });
    await get().saveServers(next);
  },

  startServer: async (id) => {
    const server = get().servers.find((s) => s.id === id);
    if (!server) return;

    set((s) => ({
      serverStatus: { ...s.serverStatus, [id]: "starting" },
    }));

    try {
      if (server.transport === "stdio" && server.command) {
        await invoke("start_mcp_stdio_server", {
          serverId: id,
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? {},
        });

        await sendRpc(id, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "51ToolBox", version: "0.1.0" },
        });
        await sendRpc(id, "notifications/initialized");
      }
      // SSE servers don't need start — they're always available

      set((s) => ({
        serverStatus: { ...s.serverStatus, [id]: "online" },
      }));

      await get().refreshTools(id);
    } catch (e) {
      set((s) => ({
        serverStatus: { ...s.serverStatus, [id]: "offline" },
      }));
      throw e;
    }
  },

  stopServer: async (id) => {
    try {
      await invoke("stop_mcp_server", { serverId: id });
    } catch { /* ignore */ }
    set((s) => ({
      serverStatus: { ...s.serverStatus, [id]: "offline" },
      serverTools: { ...s.serverTools, [id]: [] },
      serverResources: { ...s.serverResources, [id]: [] },
      serverPrompts: { ...s.serverPrompts, [id]: [] },
    }));
  },

  refreshTools: async (id) => {
    const server = get().servers.find((s) => s.id === id);
    if (!server) return;

    try {
      const toolsResult = (await sendRpc(
        id,
        "tools/list",
        undefined,
        server.transport,
        server.url,
        server.headers,
      )) as { tools?: McpToolDef[] };

      set((s) => ({
        serverTools: { ...s.serverTools, [id]: toolsResult?.tools ?? [] },
      }));

      // Try resources/list (optional)
      try {
        const resourcesResult = (await sendRpc(
          id,
          "resources/list",
          undefined,
          server.transport,
          server.url,
          server.headers,
        )) as { resources?: McpResourceDef[] };
        set((s) => ({
          serverResources: {
            ...s.serverResources,
            [id]: resourcesResult?.resources ?? [],
          },
        }));
      } catch { /* server may not support resources */ }

      // Try prompts/list (optional)
      try {
        const promptsResult = (await sendRpc(
          id,
          "prompts/list",
          undefined,
          server.transport,
          server.url,
          server.headers,
        )) as { prompts?: McpPromptDef[] };
        set((s) => ({
          serverPrompts: {
            ...s.serverPrompts,
            [id]: promptsResult?.prompts ?? [],
          },
        }));
      } catch { /* server may not support prompts */ }
    } catch (e) {
      handleError(e, { context: `刷新 MCP 工具列表 (${id})`, silent: true });
    }
  },

  refreshAllTools: async () => {
    const { servers, serverStatus } = get();
    const onlineServers = servers.filter(
      (s) => s.enabled && serverStatus[s.id] === "online",
    );
    await Promise.allSettled(onlineServers.map((s) => get().refreshTools(s.id)));
  },

  testConnection: async (id) => {
    try {
      await get().startServer(id);
      return true;
    } catch {
      return false;
    }
  },

  getAllMcpTools: () => {
    const { servers, serverStatus, serverTools } = get();
    const tools: McpToolDef[] = [];
    for (const server of servers) {
      if (!server.enabled || serverStatus[server.id] !== "online") continue;
      const st = serverTools[server.id] ?? [];
      for (const tool of st) {
        tools.push({
          ...tool,
          name: `mcp_${server.id}_${tool.name}`,
          description: `[MCP:${server.name}] ${tool.description ?? ""}`,
        });
      }
    }
    return tools;
  },
}));
