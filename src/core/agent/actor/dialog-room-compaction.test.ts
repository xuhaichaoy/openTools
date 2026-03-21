import { describe, expect, it, vi } from "vitest";
import type {
  DialogArtifactRecord,
  DialogMessage,
  DialogRoomCompactionState,
  SessionUploadRecord,
  SpawnedTaskRecord,
} from "./types";

const hoisted = vi.hoisted(() => ({
  saveSessionMemoryNote: vi.fn(async () => ({ id: "note-1" })),
  ingestAutomaticMemorySignals: vi.fn(async () => ({ confirmed: 2, queued: 1 })),
}));

vi.mock("@/core/ai/memory-store", () => ({
  saveSessionMemoryNote: hoisted.saveSessionMemoryNote,
  ingestAutomaticMemorySignals: hoisted.ingestAutomaticMemorySignals,
}));

import {
  buildDialogRoomCompactionContextMessages,
  buildDialogRoomCompactionState,
  computeDialogRoomCompactionTriggerReasons,
  persistDialogRoomCompactionArtifacts,
  shouldRefreshDialogRoomCompaction,
} from "./dialog-room-compaction";

function createMessage(
  id: string,
  from: string,
  content: string,
  timestamp: number,
): DialogMessage {
  return {
    id,
    from,
    content,
    timestamp,
  };
}

describe("dialog-room-compaction", () => {
  it("builds a structured room summary from earlier messages, artifacts and tasks", () => {
    const dialogHistory: DialogMessage[] = [
      createMessage("m1", "user", "请先梳理首页实现方案，并补全主视觉。", 10),
      createMessage("m2", "builder", "已经确认会先改 Hero、导航和 CTA。", 20),
      createMessage("m3", "user", "要保留暖色调和大标题。", 30),
      createMessage("m4", "builder", "收到，开始拆分子任务。", 40),
      createMessage("m5", "reviewer", "会补一轮回归检查。", 50),
      createMessage("m6", "builder", "正在整理最终 patch。", 60),
    ];
    const artifacts: DialogArtifactRecord[] = [
      {
        id: "a1",
        actorId: "builder",
        path: "/repo/src/main.tsx",
        fileName: "main.tsx",
        directory: "/repo/src",
        source: "tool_write",
        summary: "更新首页结构",
        timestamp: 15,
      },
      {
        id: "a2",
        actorId: "builder",
        path: "/repo/src/footer.tsx",
        fileName: "footer.tsx",
        directory: "/repo/src",
        source: "tool_write",
        summary: "后续补充",
        timestamp: 65,
      },
    ];
    const sessionUploads: SessionUploadRecord[] = [
      {
        id: "u1",
        type: "image",
        name: "design.png",
        path: "/repo/assets/design.png",
        size: 1,
        addedAt: 12,
      },
    ];
    const spawnedTasks: SpawnedTaskRecord[] = [
      {
        runId: "run-1",
        spawnerActorId: "coordinator",
        targetActorId: "builder",
        task: "实现首页 Hero",
        label: "前端执行",
        status: "completed",
        spawnedAt: 18,
        completedAt: 24,
        result: "Hero 已完成",
        mode: "run",
        expectsCompletionMessage: true,
        cleanup: "keep",
      },
      {
        runId: "run-2",
        spawnerActorId: "coordinator",
        targetActorId: "reviewer",
        task: "做回归检查",
        label: "回归检查",
        status: "running",
        spawnedAt: 58,
        mode: "session",
        expectsCompletionMessage: true,
        cleanup: "keep",
        sessionOpen: true,
        lastActiveAt: 58,
      },
    ];

    const state = buildDialogRoomCompactionState({
      dialogHistory,
      artifacts,
      sessionUploads,
      spawnedTasks,
      actorNameById: new Map([
        ["builder", "Builder"],
        ["reviewer", "Reviewer"],
      ]),
      actorSessionHistoryById: new Map([
        ["reviewer", [
          { role: "assistant", content: "我先做一轮回归路径梳理。", timestamp: 58 },
          { role: "assistant", content: "下一步会补充 Hero 和 CTA 的回归验证。", timestamp: 59 },
        ]],
      ]),
      actorTodosById: {
        reviewer: [
          {
            id: "todo-1",
            title: "回归测试 Hero、导航和 CTA",
            status: "in_progress",
            priority: "high",
            createdAt: 58,
            updatedAt: 60,
          },
        ],
      },
      keepRecentMessages: 4,
      triggerReasons: ["房间历史已明显拉长"],
      updatedAt: 999,
    });

    expect(state).not.toBeNull();
    expect(state?.compactedMessageCount).toBe(2);
    expect(state?.compactedSpawnedTaskCount).toBe(1);
    expect(state?.compactedArtifactCount).toBe(1);
    expect(state?.triggerReasons).toEqual(["房间历史已明显拉长"]);
    expect(state?.updatedAt).toBe(999);
    expect(state?.summary).toContain("早期用户诉求");
    expect(state?.summary).toContain("已形成的房间结论");
    expect(state?.summary).toContain("后续续跑应优先沿用的当前工作集");
    expect(state?.summary).toContain("当前仍需延续的子线程检查点");
    expect(state?.summary).toContain("Reviewer · 验证中");
    expect(state?.preservedIdentifiers).toEqual(expect.arrayContaining(["main.tsx", "design.png", "前端执行"]));
  });

  it("builds reinjection messages and persists room compaction into memory stores", async () => {
    const state: DialogRoomCompactionState = {
      summary: "房间已经确认首页需要暖色调 Hero，主按钮文案改为立即开始。",
      compactedMessageCount: 14,
      compactedSpawnedTaskCount: 2,
      compactedArtifactCount: 1,
      preservedIdentifiers: ["main.tsx", "design.png"],
      memoryConfirmedCount: 2,
      updatedAt: 123,
    };

    const messages = buildDialogRoomCompactionContextMessages(state);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("结构化历史摘要");
    expect(messages[1]?.content).toContain("关键线索 2 项");
    expect(messages[1]?.content).toContain("记忆沉淀 2 条");

    const persisted = await persistDialogRoomCompactionArtifacts({
      state,
      conversationId: "dialog-1",
      workspaceId: "/repo",
    });

    expect(hoisted.saveSessionMemoryNote).toHaveBeenCalledWith(
      expect.stringContaining("Dialog 房间压缩摘要"),
      expect.objectContaining({
        conversationId: "dialog-1",
        workspaceId: "/repo",
        source: "system",
      }),
    );
    expect(hoisted.ingestAutomaticMemorySignals).toHaveBeenCalledWith(
      expect.stringContaining("Dialog 房间压缩后的结构化续跑摘要"),
      expect.objectContaining({
        conversationId: "dialog-1",
        workspaceId: "/repo",
        autoConfirm: true,
      }),
    );
    expect(persisted.memoryFlushNoteId).toBe("note-1");
    expect(persisted.memoryConfirmedCount).toBe(2);
    expect(persisted.memoryQueuedCount).toBe(1);
  });

  it("computes trigger reasons and refresh decisions from room pressure", () => {
    const reasons = computeDialogRoomCompactionTriggerReasons({
      breakdown: {
        totalSharedTokens: 4500,
        totalRuntimeTokens: 1200,
        attachmentCount: 3,
        imageCount: 5,
        openSessionCount: 4,
        sharedSections: [],
        actors: [
          {
            actorId: "coordinator",
            roleName: "Coordinator",
            modelLabel: "gpt",
            budgetTokens: 8000,
            budgetUsageTokens: 6500,
            budgetUsageRatio: 0.81,
            sharedTokens: 4500,
            estimatedTotalTokens: 8600,
            estimatedTotalRatio: 1.075,
            memoryTokens: 300,
            promptTokens: 400,
            runtimeTokens: 800,
            status: "tight",
          },
        ],
        warnings: [],
      },
      dialogHistoryCount: 20,
      keepRecentMessages: 4,
    });

    expect(reasons).toEqual(expect.arrayContaining([
      "共享工作集偏大",
      "至少一个 Agent 的预算占用接近或超过上限",
      "开放子会话数量偏多",
      "视觉输入累计较多",
      "房间历史已明显拉长",
    ]));

    expect(shouldRefreshDialogRoomCompaction({
      current: null,
      triggerReasons: reasons,
      dialogHistoryCount: 20,
      artifactsCount: 2,
      spawnedTaskCount: 2,
      keepRecentMessages: 4,
      now: 1000,
    })).toBe(true);

    expect(shouldRefreshDialogRoomCompaction({
      current: {
        summary: "已有摘要",
        compactedMessageCount: 16,
        compactedSpawnedTaskCount: 2,
        compactedArtifactCount: 2,
        preservedIdentifiers: [],
        triggerReasons: ["共享工作集偏大"],
        updatedAt: 980,
      },
      triggerReasons: ["共享工作集偏大", "视觉输入累计较多"],
      dialogHistoryCount: 24,
      artifactsCount: 5,
      spawnedTaskCount: 5,
      keepRecentMessages: 4,
      now: 1000,
    })).toBe(false);

    expect(shouldRefreshDialogRoomCompaction({
      current: {
        summary: "已有摘要",
        compactedMessageCount: 10,
        compactedSpawnedTaskCount: 1,
        compactedArtifactCount: 1,
        preservedIdentifiers: [],
        triggerReasons: ["共享工作集偏大"],
        updatedAt: 0,
      },
      triggerReasons: ["共享工作集偏大", "视觉输入累计较多"],
      dialogHistoryCount: 22,
      artifactsCount: 4,
      spawnedTaskCount: 4,
      keepRecentMessages: 4,
      now: 60_000,
    })).toBe(true);
  });
});
