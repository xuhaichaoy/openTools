import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@/store/agent-store";

const hoisted = vi.hoisted(() => ({
  saveSessionMemoryNoteMock: vi.fn(async () => ({ id: "note-1" })),
  ingestAutomaticMemorySignalsMock: vi.fn(
    async (_content: string, _opts?: Record<string, unknown>) => ({
      confirmed: 1,
      queued: 0,
    }),
  ),
  buildAgentSessionMemoryFlushTextMock: vi.fn(
    () => "压缩前目标：继续实现设置页；已读取文件：settings.tsx、panel.tsx",
  ),
}));

vi.mock("@/core/ai/memory-store", () => ({
  saveSessionMemoryNote: hoisted.saveSessionMemoryNoteMock,
  ingestAutomaticMemorySignals: hoisted.ingestAutomaticMemorySignalsMock,
}));

vi.mock("@/plugins/builtin/SmartAgent/core/session-compaction", () => ({
  buildAgentSessionMemoryFlushText: hoisted.buildAgentSessionMemoryFlushTextMock,
}));

import {
  buildAgentSessionCompactionMemoryTranscript,
  persistAgentSessionCompactionArtifacts,
} from "./compaction-orchestrator";

function makeSession(): AgentSession {
  return {
    id: "session-1",
    title: "大型项目",
    createdAt: 1,
    workspaceRoot: "/repo/app",
    tasks: [
      {
        id: "task-1",
        query: "分析当前项目的设置页实现，并记住以后默认用中文回答",
        attachmentPaths: ["/repo/app/src/settings.tsx"],
        steps: [
          {
            type: "action",
            content: "读取设置页组件",
            toolName: "read_file",
            toolInput: { path: "/repo/app/src/settings.tsx" },
            timestamp: 1,
          },
          {
            type: "observation",
            content: "发现设置页当前缺少字体缩放控制",
            timestamp: 2,
          },
        ],
        answer: "当前设置页缺少字体缩放和窗口尺寸偏好，需要补一个本地持久化实现。",
      },
      {
        id: "task-2",
        query: "继续实现字体缩放和本地存储",
        steps: [
          {
            type: "action",
            content: "修改 local-ui-preferences.ts",
            toolName: "str_replace_edit",
            toolInput: { path: "/repo/app/src/core/ui/local-ui-preferences.ts" },
            timestamp: 3,
          },
        ],
        answer: "已补充字体缩放偏好。",
      },
    ],
    compaction: {
      summary: "old",
      compactedTaskCount: 1,
      lastCompactedAt: 1,
      reason: "task_count",
    },
  };
}

describe("compaction-orchestrator", () => {
  beforeEach(() => {
    hoisted.saveSessionMemoryNoteMock.mockClear();
    hoisted.ingestAutomaticMemorySignalsMock.mockClear();
    hoisted.buildAgentSessionMemoryFlushTextMock.mockClear();
  });

  it("builds a compact transcript for the soon-to-be-compacted tasks", () => {
    const transcript = buildAgentSessionCompactionMemoryTranscript(
      makeSession(),
      1,
    );

    expect(transcript).toContain("工作区：/repo/app");
    expect(transcript).toContain("历史任务 1");
    expect(transcript).toContain("用户请求：分析当前项目的设置页实现");
    expect(transcript).toContain("当前工作集：settings.tsx");
    expect(transcript).toContain("工具：read_file");
    expect(transcript).toContain("结果：当前设置页缺少字体缩放");
  });

  it("persists session note and durable memory before compaction", async () => {
    const session = makeSession();
    const result = await persistAgentSessionCompactionArtifacts({
      session,
      compaction: { compactedTaskCount: 1 },
    });

    expect(hoisted.saveSessionMemoryNoteMock).toHaveBeenCalledWith(
      "压缩前目标：继续实现设置页；已读取文件：settings.tsx、panel.tsx",
      {
        conversationId: "session-1",
        workspaceId: "/repo/app",
        source: "system",
      },
    );
    expect(hoisted.ingestAutomaticMemorySignalsMock).toHaveBeenCalledTimes(1);
    const firstCall = hoisted.ingestAutomaticMemorySignalsMock.mock.calls[0];
    expect(firstCall?.[0]).toContain(
      "默认用中文回答",
    );
    expect(firstCall?.[1]).toEqual({
      conversationId: "session-1",
      workspaceId: "/repo/app",
      source: "assistant",
      sourceMode: "system",
      evidence: expect.stringContaining("历史任务 1"),
      autoConfirm: true,
      allowNonUserSourceAutoConfirm: true,
    });
    expect(result.noteSaved).toBe(true);
    expect(result.memoryIngest.confirmed).toBe(1);
  });
});
