import { describe, expect, it } from "vitest";
import { buildDialogContextSnapshot } from "./dialog-context-snapshot";

describe("buildDialogContextSnapshot", () => {
  it("captures workspace, handoff, summary and pending interaction state", () => {
    const snapshot = buildDialogContextSnapshot({
      sessionId: "dialog-1",
      workspaceRoot: "/tmp/project",
      sourceHandoff: {
        query: "继续实现页面",
        sourceMode: "agent",
        sourceLabel: "Agent 会话",
        summary: "已经完成需求分析和结构拆分",
        goal: "继续完成首页实现",
        intent: "coding",
      },
      dialogContextSummary: {
        summary: "更早的消息里已经确认了布局、配色和组件拆分。",
        summarizedMessageCount: 18,
        updatedAt: 123,
      },
      dialogRoomCompaction: {
        summary: "房间较早内容已压缩，保留首页布局结论、Hero 修改点和关键文件路径。",
        compactedMessageCount: 12,
        compactedSpawnedTaskCount: 2,
        compactedArtifactCount: 1,
        preservedIdentifiers: ["index.tsx", "design.png"],
        triggerReasons: ["共享工作集偏大", "房间历史已明显拉长"],
        memoryConfirmedCount: 2,
        memoryQueuedCount: 1,
        updatedAt: 456,
      },
      dialogHistoryCount: 26,
      sessionUploads: [{ id: "u1", type: "image", name: "design.png", size: 1, addedAt: 1 }],
      artifacts: [{
        id: "a1",
        actorId: "actor-1",
        path: "/tmp/project/index.tsx",
        fileName: "index.tsx",
        directory: "/tmp/project",
        source: "tool_write",
        summary: "已生成首页草稿",
        timestamp: 2,
      }],
      spawnedTasks: [{
        runId: "run-1",
        spawnerActorId: "actor-1",
        targetActorId: "actor-2",
        task: "实现首页 Hero 区",
        status: "running",
        spawnedAt: 3,
        mode: "session",
        expectsCompletionMessage: false,
        cleanup: "keep",
        sessionOpen: true,
      }],
      actorCount: 3,
      runningActorCount: 1,
      pendingUserInteractions: [
        {
          id: "p1",
          fromActorId: "actor-1",
          messageId: "m1",
          question: "是否继续？",
          type: "approval",
          replyMode: "single",
          status: "pending",
          createdAt: 4,
          resolve: () => {},
        },
      ],
      queuedFollowUpCount: 2,
      focusedSessionRunId: "run-1",
      focusedSessionLabel: "前端子会话",
      memoryRecallAttempted: true,
      memoryHitCount: 2,
      memoryPreview: ["默认中文回答", "常驻上海"],
      transcriptRecallAttempted: true,
      transcriptRecallHitCount: 1,
      transcriptPreview: ["Dialog：继续完成首页实现"],
    });

    expect(snapshot.workspaceRoot).toBe("/tmp/project");
    expect(snapshot.sourceModeLabel).toBe("Build 模式");
    expect(snapshot.summarizedMessageCount).toBe(18);
    expect(snapshot.roomCompactionMessageCount).toBe(12);
    expect(snapshot.roomCompactionTaskCount).toBe(2);
    expect(snapshot.roomCompactionArtifactCount).toBe(1);
    expect(snapshot.roomCompactionPreservedIdentifiers).toEqual(["index.tsx", "design.png"]);
    expect(snapshot.roomCompactionTriggerReasons).toEqual(["共享工作集偏大", "房间历史已明显拉长"]);
    expect(snapshot.roomCompactionMemoryConfirmedCount).toBe(2);
    expect(snapshot.roomCompactionMemoryQueuedCount).toBe(1);
    expect(snapshot.pendingInteractionCount).toBe(1);
    expect(snapshot.pendingApprovalCount).toBe(1);
    expect(snapshot.openSessionCount).toBe(1);
    expect(snapshot.focusedSessionLabel).toBe("前端子会话");
    expect(snapshot.memoryHitCount).toBe(2);
    expect(snapshot.transcriptRecallHitCount).toBe(1);
    expect(snapshot.contextLines.some((line) => line.includes("当前工作区"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("跨模式来源"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("待处理交互"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("房间压缩"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("压缩原因"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("保留线索"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("压缩记忆沉淀"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("长期记忆"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("会话轨迹回补"))).toBe(true);
  });
});
