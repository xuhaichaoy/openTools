import { invoke } from "@tauri-apps/api/core";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { materializeMcpToolResult } from "@/core/mcp/mcp-tool-result";
import type {
  AgentBridge,
  AgentBridgeResult,
  AgentBridgeRunOptions,
  AgentBridgeStatus,
} from "./types";

let nextId = 1;
let jsonRpcId = 1;

interface MCPToolResult {
  content?: unknown[];
  isError?: boolean;
}

/**
 * MCP 协议远程 Agent Bridge。
 *
 * 通过 Tauri 后端的 MCP Server Manager 管理 stdio 进程，
 * 使用 JSON-RPC 2.0 协议与 MCP Server 通信。
 *
 * 支持的 MCP 方法:
 * - tools/list: 获取可用工具列表
 * - tools/call: 调用工具
 *
 * 工作流程:
 * 1. 启动 MCP 服务器进程（如果未启动）
 * 2. 初始化协议握手（initialize）
 * 3. 获取工具列表（tools/list）
 * 4. 将任务交给本地 Planner 分解
 * 5. 使用 MCP 工具执行子任务
 */
export class MCPAgentBridge implements AgentBridge {
  readonly id: string;
  readonly type = "mcp" as const;

  private serverId: string;
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private abortController: AbortController | null = null;
  private initialized = false;

  constructor(
    config: {
      serverId: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    },
    id?: string,
  ) {
    this.id = id ?? `mcp-${nextId++}`;
    this.serverId = config.serverId;
    this.command = config.command;
    this.args = config.args ?? [];
    this.env = config.env ?? {};
  }

  private async ensureStarted(): Promise<void> {
    try {
      await invoke("start_mcp_stdio_server", {
        serverId: this.serverId,
        command: this.command,
        args: this.args,
        env: this.env,
      });
    } catch {
      // Server might already be running
    }
  }

  private async sendRpc(method: string, params?: unknown): Promise<unknown> {
    const id = jsonRpcId++;
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });

    const response = await invoke<string>("send_mcp_message", {
      serverId: this.serverId,
      message,
    });

    try {
      const parsed = JSON.parse(response);
      if (parsed.error) {
        throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
      }
      return parsed.result;
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`MCP 服务器返回无效 JSON: ${response.slice(0, 200)}`);
      }
      throw e;
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.ensureStarted();
    await this.sendRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "mtools-agent-cluster",
        version: "0.1.0",
      },
    });
    await this.sendRpc("notifications/initialized");
    this.initialized = true;
  }

  private async listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  > {
    const result = (await this.sendRpc("tools/list")) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    };
    return result?.tools ?? [];
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const result = (await this.sendRpc("tools/call", {
      name,
      arguments: args,
    })) as MCPToolResult;
    return result;
  }

  async run(
    task: string,
    context: Record<string, unknown>,
    options?: AgentBridgeRunOptions,
  ): Promise<AgentBridgeResult> {
    const steps: AgentStep[] = [];
    this.abortController = new AbortController();

    if (options?.signal) {
      const external = options.signal;
      if (external.aborted) {
        this.abortController.abort(external.reason);
      } else {
        external.addEventListener(
          "abort",
          () => this.abortController?.abort(external.reason),
          { once: true },
        );
      }
    }

    try {
      await this.initialize();

      steps.push({
        type: "thought",
        content: `连接 MCP 服务器 ${this.serverId}，获取可用工具...`,
        timestamp: Date.now(),
      });
      options?.onStep?.(steps[steps.length - 1]);

      if (this.abortController?.signal.aborted) throw new Error("已取消");

      const tools = await this.listTools();
      steps.push({
        type: "observation",
        content: `MCP 服务器提供 ${tools.length} 个工具: ${tools.map((t) => t.name).join(", ")}`,
        timestamp: Date.now(),
      });
      options?.onStep?.(steps[steps.length - 1]);

      if (this.abortController?.signal.aborted) throw new Error("已取消");

      const contextStr = Object.keys(context).length > 0
        ? `\n上下文: ${JSON.stringify(context)}`
        : "";
      const fullTask = `${task}${contextStr}`;

      if (tools.length === 0) {
        return {
          answer: `MCP 服务器 ${this.serverId} 没有提供任何工具`,
          steps,
          error: "no_tools",
        };
      }

      const selectedTool = this.selectBestTool(tools, fullTask);

      steps.push({
        type: "thought",
        content: `选择工具 "${selectedTool.name}" 处理任务: ${fullTask.slice(0, 200)}`,
        timestamp: Date.now(),
      });
      options?.onStep?.(steps[steps.length - 1]);

      const toolResult = await this.callTool(selectedTool.name, {
        task: fullTask,
        ...context,
      });

      const resultText = await materializeMcpToolResult(toolResult);

      steps.push({
        type: "observation",
        content: resultText,
        toolName: selectedTool.name,
        timestamp: Date.now(),
      });
      options?.onStep?.(steps[steps.length - 1]);

      return {
        answer: resultText,
        steps,
        error: toolResult.isError ? resultText : undefined,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      steps.push({
        type: "error",
        content: `MCP Bridge 错误: ${error}`,
        timestamp: Date.now(),
      });
      options?.onStep?.(steps[steps.length - 1]);
      return { answer: "", steps, error };
    } finally {
      this.abortController = null;
    }
  }

  private selectBestTool(
    tools: Array<{ name: string; description?: string }>,
    task: string,
  ): { name: string; description?: string } {
    if (tools.length === 1) return tools[0];

    const taskLower = task.toLowerCase();
    const keywords = taskLower.split(/\s+/).filter((w) => w.length > 2);

    let best = tools[0];
    let bestScore = 0;

    for (const tool of tools) {
      let score = 0;
      const desc = (tool.description ?? "").toLowerCase();
      const name = tool.name.toLowerCase();

      for (const kw of keywords) {
        if (name.includes(kw)) score += 3;
        if (desc.includes(kw)) score += 1;
      }

      if (taskLower.includes(name)) score += 5;

      if (score > bestScore) {
        bestScore = score;
        best = tool;
      }
    }

    return best;
  }

  async getStatus(): Promise<AgentBridgeStatus> {
    try {
      await this.ensureStarted();
      return "online";
    } catch {
      return "offline";
    }
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
    try {
      await invoke("stop_mcp_server", { serverId: this.serverId });
      this.initialized = false;
    } catch {
      // ignore
    }
  }
}
