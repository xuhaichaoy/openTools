import { useEffect, type Dispatch, type SetStateAction } from "react";
import { pluginActionToTool, type AgentTool } from "../core/react-agent";
import { registry } from "@/core/plugin-system/registry";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import type { AgentTask } from "@/store/agent-store";
import type { RuntimeFallbackContext } from "@/core/agent/runtime";
import {
  createBuiltinAgentTools,
  type AskUserQuestion,
  type AskUserAnswers,
  type BuiltinToolsResult,
} from "../core/default-tools";
import { shouldAutoCollapseProcess } from "../core/ui-state";
import { useMcpStore } from "@/store/mcp-store";
import { invoke } from "@tauri-apps/api/core";
import { useAIStore } from "@/store/ai-store";
import { filterAssistantToolsByConfig } from "@/core/ai/assistant-config";

interface UseAgentEffectsParams {
  ai?: MToolsAI;
  historyLoaded: boolean;
  loadHistory: () => Promise<void>;
  loadScheduledTasks: () => Promise<void>;
  tasks: AgentTask[];
  setCollapsedTaskProcesses: Dispatch<SetStateAction<Set<string>>>;
  confirmHostFallback: (context: RuntimeFallbackContext) => Promise<boolean>;
  askUser: (questions: AskUserQuestion[]) => Promise<AskUserAnswers>;
  setAvailableTools: Dispatch<SetStateAction<AgentTool[]>>;
  setResetPerRunState: Dispatch<SetStateAction<(() => void) | null>>;
  setNotifyToolCalled: Dispatch<SetStateAction<((toolName: string) => void) | null>>;
}

export function useAgentEffects({
  ai,
  historyLoaded,
  loadHistory,
  loadScheduledTasks,
  tasks,
  setCollapsedTaskProcesses,
  confirmHostFallback,
  askUser,
  setAvailableTools,
  setResetPerRunState,
  setNotifyToolCalled,
}: UseAgentEffectsParams) {
  const aiConfig = useAIStore((s) => s.config);

  useEffect(() => {
    if (!historyLoaded) void loadHistory();
    void loadScheduledTasks();
  }, [historyLoaded, loadHistory, loadScheduledTasks]);

  useEffect(() => {
    setCollapsedTaskProcesses((prev) => {
      const next = new Set(prev);
      let changed = false;

      const aliveIds = new Set(tasks.map((task) => task.id));
      for (const taskId of next) {
        if (!aliveIds.has(taskId)) {
          next.delete(taskId);
          changed = true;
        }
      }

      for (const task of tasks) {
        const shouldCollapse = shouldAutoCollapseProcess(task);
        if (shouldCollapse && !next.has(task.id)) {
          next.add(task.id);
          changed = true;
        } else if (!shouldCollapse && next.has(task.id)) {
          next.delete(task.id);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [tasks, setCollapsedTaskProcesses]);

  useEffect(() => {
    if (!ai) return;
    const allActions = registry.getAllActions();
    const tools: AgentTool[] = allActions.map(({ pluginId, pluginName, action }) =>
      pluginActionToTool(pluginId, pluginName, action, ai),
    );
    const builtinResult: BuiltinToolsResult = createBuiltinAgentTools(confirmHostFallback, askUser);
    tools.push(...builtinResult.tools);

    // Merge MCP server tools into agent tool list
    const mcpState = useMcpStore.getState();
    const mcpToolDefs = mcpState.getAllMcpTools();
    for (const def of mcpToolDefs) {
      const parts = def.name.match(/^mcp_([^_]+)_(.+)$/);
      const serverId = parts?.[1] ?? "";
      const realToolName = parts?.[2] ?? def.name;
      const server = mcpState.servers.find((s) => s.id === serverId);

      const params: Record<string, { type: string; description?: string }> = {};
      if (def.input_schema && typeof def.input_schema === "object") {
        const schema = def.input_schema as Record<string, unknown>;
        const props = (schema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
        for (const [k, v] of Object.entries(props)) {
          params[k] = { type: v.type ?? "string", description: v.description };
        }
      }

      tools.push({
        name: def.name,
        description: def.description ?? `MCP tool: ${realToolName}`,
        parameters: Object.keys(params).length > 0 ? params : { input: { type: "string", description: "Tool input" } },
        execute: async (args) => {
          try {
            const message = JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now(),
              method: "tools/call",
              params: { name: realToolName, arguments: args },
            });

            let response: string;
            if (server?.transport === "sse" && server.url) {
              response = await invoke<string>("mcp_send_sse_message", {
                url: server.url,
                message,
                headers: server.headers ?? null,
              });
            } else {
              response = await invoke<string>("send_mcp_message", {
                serverId,
                message,
              });
            }

            const parsed = JSON.parse(response);
            if (parsed.error) return { error: parsed.error.message ?? JSON.stringify(parsed.error) };
            const content = parsed.result?.content;
            if (Array.isArray(content)) {
              return content.map((c: { text?: string }) => c.text ?? "").join("\n");
            }
            return parsed.result;
          } catch (e) {
            return { error: `MCP tool call failed: ${e}` };
          }
        },
      });
    }

    setAvailableTools(filterAssistantToolsByConfig(tools, aiConfig));
    setResetPerRunState(() => builtinResult.resetPerRunState);
    setNotifyToolCalled(() => builtinResult.notifyToolCalled);
  }, [
    ai,
    aiConfig,
    confirmHostFallback,
    askUser,
    setAvailableTools,
    setResetPerRunState,
    setNotifyToolCalled,
  ]);
}
