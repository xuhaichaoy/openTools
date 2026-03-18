import { describe, expect, it } from "vitest";
import { buildAskContextSnapshot } from "./ask-context-snapshot";

describe("buildAskContextSnapshot", () => {
  it("captures ask conversation, recalled memory and draft overlay", () => {
    const snapshot = buildAskContextSnapshot({
      conversationId: "ask-1",
      title: "继续处理首页实现",
      workspaceRoot: "/tmp/project",
      sourceHandoff: {
        query: "继续基于报告修复页面",
        sourceMode: "cluster",
        sourceLabel: "Cluster 报告",
        summary: "已经完成方案拆分和风险整理",
        goal: "继续落地首页修复",
        intent: "coding",
      },
      messages: [
        {
          id: "u1",
          role: "user",
          content: "帮我看看这个首页还差什么",
          timestamp: 1,
          attachmentPaths: ["/tmp/project/src/App.tsx"],
          contextPrefix: "项目目录结构如下...",
        },
        {
          id: "a1",
          role: "assistant",
          content: "目前主要缺少移动端布局和状态收敛。",
          timestamp: 2,
          appliedMemoryIds: ["m1", "m2"],
          appliedMemoryPreview: ["用户偏好简洁输出", "项目默认使用 pnpm"],
          transcriptRecallAttempted: true,
          transcriptRecallHitCount: 1,
          appliedTranscriptPreview: ["Agent：任务结果：已完成首页基础布局"],
        },
      ],
      draftInput: "顺便补一下移动端适配",
      draftAttachmentCount: 2,
      draftImageCount: 1,
      draftHasContextBlock: true,
      lastSessionNotePreview: "Ask 问题：帮我看看这个首页还差什么；回答：主要缺少移动端布局",
      lastRunStatus: "success",
      lastRunDurationMs: 12000,
      isStreaming: true,
    });

    expect(snapshot.workspaceRoot).toBe("/tmp/project");
    expect(snapshot.sourceModeLabel).toBe("Cluster 模式");
    expect(snapshot.messageCount).toBe(2);
    expect(snapshot.attachmentCount).toBe(1);
    expect(snapshot.contextBlockCount).toBe(1);
    expect(snapshot.recalledMemoryCount).toBe(2);
    expect(snapshot.recalledTranscriptCount).toBe(1);
    expect(snapshot.lastRunStatus).toBe("success");
    expect(snapshot.lastSessionNotePreview).toContain("Ask 问题");
    expect(snapshot.draftAttachmentCount).toBe(2);
    expect(snapshot.isStreaming).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("当前工作区"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("长期记忆"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("会话轨迹"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("最近运行"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("最近会话笔记"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("当前草稿"))).toBe(true);
  });
});
