import { describe, expect, it } from "vitest";
import { buildDialogContextBreakdown } from "./dialog-context-breakdown";

describe("buildDialogContextBreakdown", () => {
  it("deduplicates repeated image references and includes shared context in actor budget status", () => {
    const breakdown = buildDialogContextBreakdown({
      actors: [
        {
          id: "coordinator",
          roleName: "Coordinator",
          contextTokens: 200,
          systemPromptOverride: "你是协调者，需要整合多人协作上下文并继续推进。",
          sessionHistory: [
            { role: "user", content: "请继续协作", timestamp: 1 },
            { role: "assistant", content: "收到，继续推进当前任务。", timestamp: 2 },
          ],
          currentTask: {
            query: "根据房间上下文整理下一步行动",
            status: "running",
            steps: [
              { type: "thought", content: "先阅读所有共享上下文和最近消息，再给出协调建议。" },
            ],
          },
        },
      ],
      dialogHistory: [
        {
          id: "msg-1",
          from: "user",
          content: "请参考这张图继续实现",
          timestamp: 10,
          priority: "normal",
          images: ["/tmp/design.png", "/tmp/design.png"],
        },
      ],
      artifacts: [],
      sessionUploads: [
        {
          id: "upload-1",
          type: "image",
          name: "design.png",
          path: "/tmp/design.png",
          size: 1024,
          addedAt: 11,
        },
      ],
      spawnedTasks: [],
      draftPlan: {
        title: "继续推进页面实现",
        goal: "整理多人协作后的下一步",
        steps: [
          {
            id: "step-1",
            role: "Coordinator",
            task: "总结现状并安排下一步",
            dependencies: [],
          },
        ],
      } as any,
      draftInsight: {
        taskSummary: "继续推进页面实现",
      },
    });

    expect(breakdown.imageCount).toBe(1);
    expect(breakdown.totalSharedTokens).toBeGreaterThan(0);
    expect(breakdown.actors).toHaveLength(1);
    expect(breakdown.actors[0]?.sharedTokens).toBe(breakdown.totalSharedTokens);
    expect(breakdown.actors[0]?.estimatedTotalTokens).toBeGreaterThan(
      breakdown.actors[0]?.budgetUsageTokens ?? 0,
    );
    expect(["busy", "tight"]).toContain(breakdown.actors[0]?.status);
  });
});
