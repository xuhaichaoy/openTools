import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@/store/agent-store";

vi.mock("@/core/ai/ai-session-runtime", () => ({
  summarizeAISessionRuntimeText: (text: string, max = 120) =>
    String(text).slice(0, max),
}));

vi.mock("@/core/ai/bootstrap-context", () => ({
  loadBootstrapReinjectionPreview: vi.fn(async () => [
    "Session Startup：先确认工作区和约束",
    "Red Lines：不要跳过现有规则",
  ]),
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
  buildAgentSessionMemoryFlushText,
  enrichAgentSessionCompactionState,
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
          toolInput: {
            path: `/repo/src/task-${index + 1}.ts`,
          },
          timestamp: index + 1,
        },
        {
          type: "observation" as const,
          content: "已读取",
          timestamp: index + 2,
        },
      ],
      answer: `任务 ${index + 1} 已完成`,
      status: "success" as const,
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
    expect(compaction?.summary).toContain("## 最新用户目标");
    expect(compaction?.summary).toContain("## 关键文件");
    expect(compaction?.summary).toContain("## 连续性护栏");
    expect(compaction?.summary).toContain("task-1.ts");
    expect(compaction?.preservedIdentifiers).toContain("task-1.ts");
    expect(compaction?.preservedToolNames).toContain("read_file");
  });

  it("reinjects AGENTS guardrails into compaction summary", async () => {
    const session = makeSession();
    session.workspaceRoot = "/repo";
    const compaction = buildAgentSessionCompactionState(session);
    const enriched = await enrichAgentSessionCompactionState(session, compaction);

    expect(enriched?.summary).toContain("## AGENTS 关键规则回注");
    expect(enriched?.bootstrapReinjectionPreview).toContain(
      "Session Startup：先确认工作区和约束",
    );
    expect(enriched?.workspaceRootAtCompaction).toBe("/repo");
  });

  it("emits context messages after compaction", () => {
    const session = makeSession();
    session.compaction = buildAgentSessionCompactionState(session) ?? undefined;
    const messages = buildAgentSessionContextMessages(session);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("历史摘要");
    expect(messages[1]?.content).toContain("关键标识");
  });

  it("builds memory flush text before compaction", () => {
    const session = makeSession();
    const flushText = buildAgentSessionMemoryFlushText(session, 4);
    expect(flushText).toContain("压缩前目标");
    expect(flushText).toContain("已读取文件");
    expect(flushText).toContain("关键工具");
  });
});
