import { describe, expect, it, vi } from "vitest";

interface AgentSession {
  id: string;
  title: string;
  createdAt: number;
  tasks: Array<{
    id: string;
    query: string;
    steps: Array<{
      type: "action" | "observation";
      content: string;
      toolName?: string;
      timestamp: number;
    }>;
    answer: string | null;
    status: string;
    createdAt: number;
  }>;
  followUpQueue?: unknown[];
  compaction?: {
    summary: string;
    compactedTaskCount: number;
    lastCompactedAt: number;
    reason?: "task_count" | "step_count" | "context_recovery";
  };
}

vi.mock("@/core/ai/ai-session-runtime", () => ({
  summarizeAISessionRuntimeText: (text: string, max = 120) =>
    String(text).slice(0, max),
}));

vi.mock("@/store/agent-store", () => ({
  getVisibleAgentTasks: (session: AgentSession) => {
    const visibleCount =
      typeof (session as AgentSession & { visibleTaskCount?: number }).visibleTaskCount === "number"
        ? Math.min(
            (session as AgentSession & { visibleTaskCount?: number }).visibleTaskCount ?? 0,
            session.tasks.length,
          )
        : session.tasks.length;
    return session.tasks.slice(0, visibleCount);
  },
  getAgentSessionCompactedTaskCount: (session: AgentSession) =>
    Math.max(
      0,
      Math.min(session.tasks.length, session.compaction?.compactedTaskCount ?? 0),
    ),
}));

import {
  buildAgentSessionCompactionState,
  buildAgentSessionContextMessages,
  shouldAutoCompactAgentSession,
} from "./session-compaction";

function makeSession(taskCount = 8): AgentSession {
  return {
    id: "session-1",
    title: "大项目",
    createdAt: 1,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index}`,
      query: `处理任务 ${index + 1}`,
      steps: [
        {
          type: "action" as const,
          content: "读取文件",
          toolName: "read_file",
          timestamp: index + 1,
        },
        {
          type: "observation" as const,
          content: "已读取",
          timestamp: index + 2,
        },
      ],
      answer: `任务 ${index + 1} 已完成`,
      status: "success",
      createdAt: index + 1,
    })),
    followUpQueue: [],
  };
}

describe("session-compaction", () => {
  it("builds auto compaction state for long sessions", () => {
    const session = makeSession();
    const decision = shouldAutoCompactAgentSession(session);
    expect(decision.shouldCompact).toBe(true);

    const compaction = buildAgentSessionCompactionState(session, {
      reason: decision.reason,
    });
    expect(compaction?.compactedTaskCount).toBeGreaterThan(0);
    expect(compaction?.summary).toContain("任务 1");
  });

  it("emits context messages after compaction", () => {
    const session = makeSession();
    session.compaction = buildAgentSessionCompactionState(session) ?? undefined;
    const messages = buildAgentSessionContextMessages(session);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("历史摘要");
  });
});
