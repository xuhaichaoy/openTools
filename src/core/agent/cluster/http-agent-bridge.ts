import { invoke } from "@tauri-apps/api/core";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type {
  AgentBridge,
  AgentBridgeResult,
  AgentBridgeRunOptions,
  AgentBridgeStatus,
} from "./types";

let nextId = 1;

interface HTTPAgentRequest {
  task: string;
  context: Record<string, unknown>;
  role?: string;
}

interface HTTPAgentResponse {
  answer: string;
  error?: string;
  steps?: Array<{
    type: string;
    content: string;
    toolName?: string;
  }>;
}

/**
 * HTTP 协议远程 Agent Bridge。
 *
 * 通过 HTTP API 与远程 Agent 服务通信。
 * 支持标准的 REST 风格接口和 SSE 流式响应。
 *
 * 期望的远程 Agent 接口:
 * - POST /run    — 执行任务，返回结果
 * - GET  /status — 获取 Agent 状态
 * - POST /abort  — 取消当前任务
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class HTTPAgentBridge implements AgentBridge {
  readonly id: string;
  readonly type = "http" as const;

  private endpoint: string;
  private headers: Record<string, string>;
  private abortController: AbortController | null = null;
  private requestTimeoutMs: number;

  constructor(
    config: {
      endpoint: string;
      headers?: Record<string, string>;
      requestTimeoutMs?: number;
    },
    id?: string,
  ) {
    this.id = id ?? `http-${nextId++}`;
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.headers = {
      "Content-Type": "application/json",
      ...config.headers,
    };
  }

  async run(
    task: string,
    context: Record<string, unknown>,
    options?: AgentBridgeRunOptions,
  ): Promise<AgentBridgeResult> {
    const steps: AgentStep[] = [];
    this.abortController = new AbortController();
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const allSignals = [this.abortController.signal, timeoutSignal];
    if (options?.signal) allSignals.push(options.signal);
    const signal = mergeSignals(allSignals);

    try {
      steps.push({
        type: "thought",
        content: `连接远程 Agent: ${this.endpoint}`,
        timestamp: Date.now(),
      });
      options?.onStep?.(steps[steps.length - 1]);

      const body: HTTPAgentRequest = {
        task,
        context,
        role: options?.role?.id,
      };

      const response = await invoke<string>("http_request", {
        url: `${this.endpoint}/run`,
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      }).catch(async () => {
        const resp = await fetch(`${this.endpoint}/run`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        }
        return resp.text();
      });

      const result: HTTPAgentResponse = JSON.parse(response);

      if (result.steps) {
        for (const s of result.steps) {
          const step: AgentStep = {
            type: s.type as AgentStep["type"],
            content: s.content,
            toolName: s.toolName,
            timestamp: Date.now(),
          };
          steps.push(step);
          options?.onStep?.(step);
        }
      }

      steps.push({
        type: "answer",
        content: result.answer || "",
        timestamp: Date.now(),
      });
      options?.onStep?.(steps[steps.length - 1]);

      return {
        answer: result.answer,
        steps,
        error: result.error,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      steps.push({
        type: "error",
        content: `HTTP Bridge 错误: ${error}`,
        timestamp: Date.now(),
      });
      options?.onStep?.(steps[steps.length - 1]);
      return { answer: "", steps, error };
    } finally {
      this.abortController = null;
    }
  }

  async getStatus(): Promise<AgentBridgeStatus> {
    try {
      const response = await fetch(`${this.endpoint}/status`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return "offline";
      const data = await response.json();
      return data.status ?? "online";
    } catch {
      return "offline";
    }
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
    try {
      await fetch(`${this.endpoint}/abort`, {
        method: "POST",
        headers: this.headers,
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // ignore
    }
  }
}

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
