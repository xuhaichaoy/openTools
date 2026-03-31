/**
 * TelemetryMiddleware — 运行数据收集中间件
 *
 * 灵感来源：Yuxi-Know 的 dashboard_router 统计系统
 *
 * 记录每个 Agent 的工具调用、执行时间、成功率等指标，
 * 为后续仪表盘/分析功能提供数据基础。
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { isToolFailureResult } from "./tool-error-handling-middleware";
export interface ToolCallRecord {
  actorId: string;
  toolName: string;
  timestamp: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface AgentSessionStats {
  actorId: string;
  roleName: string;
  totalToolCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalDurationMs: number;
  toolBreakdown: Map<string, { calls: number; successes: number; totalMs: number }>;
  startedAt: number;
  lastActivityAt: number;
}

/** In-memory telemetry store (persisted to disk via logger sinks) */
const sessionStats = new Map<string, AgentSessionStats>();
const recentRecords: ToolCallRecord[] = [];
const MAX_RECORDS = 1000;

export function getSessionStats(actorId?: string): AgentSessionStats[] {
  if (actorId) {
    const stat = sessionStats.get(actorId);
    return stat ? [stat] : [];
  }
  return [...sessionStats.values()];
}

export function getRecentToolCalls(count = 50): ToolCallRecord[] {
  return recentRecords.slice(-count);
}

export function getAggregateStats(): {
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  topTools: Array<{ name: string; calls: number; avgMs: number }>;
} {
  let totalCalls = 0;
  let successfulCalls = 0;
  let totalDuration = 0;
  const toolAgg = new Map<string, { calls: number; totalMs: number }>();

  for (const stat of sessionStats.values()) {
    totalCalls += stat.totalToolCalls;
    successfulCalls += stat.successfulCalls;
    totalDuration += stat.totalDurationMs;

    for (const [toolName, td] of stat.toolBreakdown) {
      const existing = toolAgg.get(toolName) ?? { calls: 0, totalMs: 0 };
      existing.calls += td.calls;
      existing.totalMs += td.totalMs;
      toolAgg.set(toolName, existing);
    }
  }

  const topTools = [...toolAgg.entries()]
    .map(([name, data]) => ({ name, calls: data.calls, avgMs: data.calls > 0 ? data.totalMs / data.calls : 0 }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);

  return {
    totalCalls,
    successRate: totalCalls > 0 ? successfulCalls / totalCalls : 1,
    avgDurationMs: totalCalls > 0 ? totalDuration / totalCalls : 0,
    topTools,
  };
}

export function clearTelemetry(): void {
  sessionStats.clear();
  recentRecords.length = 0;
}

function recordToolCall(record: ToolCallRecord): void {
  recentRecords.push(record);
  if (recentRecords.length > MAX_RECORDS) recentRecords.shift();

  let stat = sessionStats.get(record.actorId);
  if (!stat) {
    stat = {
      actorId: record.actorId,
      roleName: record.actorId,
      totalToolCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      totalDurationMs: 0,
      toolBreakdown: new Map(),
      startedAt: record.timestamp,
      lastActivityAt: record.timestamp,
    };
    sessionStats.set(record.actorId, stat);
  }

  stat.totalToolCalls++;
  stat.totalDurationMs += record.durationMs;
  stat.lastActivityAt = record.timestamp;

  if (record.success) {
    stat.successfulCalls++;
  } else {
    stat.failedCalls++;
  }

  const toolStat = stat.toolBreakdown.get(record.toolName) ?? { calls: 0, successes: 0, totalMs: 0 };
  toolStat.calls++;
  toolStat.totalMs += record.durationMs;
  if (record.success) toolStat.successes++;
  stat.toolBreakdown.set(record.toolName, toolStat);
}

export class TelemetryMiddleware implements ActorMiddleware {
  readonly name = "Telemetry";

  async apply(ctx: ActorRunContext): Promise<void> {
    const actorId = ctx.actorId;

    ctx.tools = ctx.tools.map((tool) => {
      const originalExecute = tool.execute;
      return {
        ...tool,
        execute: async (params: Record<string, unknown>, signal?: AbortSignal) => {
          const start = Date.now();
          try {
            const result = await originalExecute(params, signal);
            const duration = Date.now() - start;
            const success = !isToolFailureResult(result);
            recordToolCall({
              actorId,
              toolName: tool.name,
              timestamp: start,
              durationMs: duration,
              success,
              ...(success
                ? {}
                : {
                    error: typeof (result as Record<string, unknown> | null)?.error === "string"
                      ? String((result as Record<string, unknown>).error)
                      : undefined,
                  }),
            });
            return result;
          } catch (err) {
            const duration = Date.now() - start;
            recordToolCall({
              actorId,
              toolName: tool.name,
              timestamp: start,
              durationMs: duration,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        },
      };
    });
  }
}
