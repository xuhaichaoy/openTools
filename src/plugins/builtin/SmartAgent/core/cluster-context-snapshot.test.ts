import { describe, expect, it } from "vitest";
import { buildClusterContextSnapshot } from "./cluster-context-snapshot";

describe("buildClusterContextSnapshot", () => {
  it("captures workspace, handoff and execution progress", () => {
    const snapshot = buildClusterContextSnapshot({
      sessionId: "cluster-1",
      query: "继续实现首页并补全交互",
      mode: "parallel_split",
      status: "done",
      workspaceRoot: "/tmp/project",
      sourceHandoff: {
        query: "继续实现页面",
        sourceMode: "agent",
        sourceLabel: "Agent 会话",
        summary: "已经完成需求分析和组件拆分",
        goal: "继续完成首页实现",
        intent: "coding",
      },
      imageCount: 2,
      messageCount: 5,
      planStepCount: 4,
      instanceCount: 3,
      runningInstanceCount: 0,
      completedInstanceCount: 3,
      errorInstanceCount: 0,
      finalAnswer: "已完成首页布局、交互动效和移动端适配。",
      lastSessionNotePreview: "Cluster 任务：继续实现首页并补全交互；结果：已完成首页布局",
      lastRunStatus: "success",
      lastRunDurationMs: 18000,
      memoryRecallAttempted: true,
      memoryHitCount: 2,
      memoryPreview: ["用户常驻上海", "默认中文回答"],
      transcriptRecallAttempted: true,
      transcriptRecallHitCount: 1,
      transcriptPreview: ["Agent：继续实现首页并补全交互"],
    });

    expect(snapshot.workspaceRoot).toBe("/tmp/project");
    expect(snapshot.modeLabel).toBe("并行分治");
    expect(snapshot.sourceModeLabel).toBe("Build 模式");
    expect(snapshot.planStepCount).toBe(4);
    expect(snapshot.completedInstanceCount).toBe(3);
    expect(snapshot.reportPreview).toContain("已完成首页布局");
    expect(snapshot.lastRunStatus).toBe("success");
    expect(snapshot.lastSessionNotePreview).toContain("Cluster 任务");
    expect(snapshot.memoryHitCount).toBe(2);
    expect(snapshot.transcriptRecallHitCount).toBe(1);
    expect(snapshot.contextLines.some((line) => line.includes("当前工作区"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("跨模式来源"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("执行实例"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("最近运行"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("最近会话笔记"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("长期记忆"))).toBe(true);
    expect(snapshot.contextLines.some((line) => line.includes("会话轨迹回补"))).toBe(true);
  });
});
