import { describe, expect, it } from "vitest";
import { buildDialogContextSummary } from "./dialog-session-summary";

describe("buildDialogContextSummary", () => {
  it("returns null for short dialogs", () => {
    expect(
      buildDialogContextSummary({
        dialogHistory: [{ id: "1", from: "user", content: "hi", timestamp: 1, priority: "normal" }],
      }),
    ).toBeNull();
  });

  it("summarizes older dialog context", () => {
    const summary = buildDialogContextSummary({
      dialogHistory: Array.from({ length: 16 }, (_, index) => ({
        id: String(index),
        from: index % 2 === 0 ? "user" : "agent-a",
        content: index % 2 === 0 ? `用户问题 ${index}` : `代理回复 ${index}`,
        timestamp: index + 1,
        priority: "normal" as const,
      })),
      artifacts: [
        {
          id: "a1",
          actorId: "agent-a",
          path: "/tmp/out.tsx",
          fileName: "out.tsx",
          directory: "/tmp",
          source: "tool_write",
          summary: "写出了首页组件",
          timestamp: 10,
        },
      ],
      actorNameById: new Map([["agent-a", "Coordinator"]]),
    });

    expect(summary).not.toBeNull();
    expect(summary?.summarizedMessageCount).toBe(4);
    expect(summary?.summary).toContain("早期用户诉求");
    expect(summary?.summary).toContain("已产生产物");
  });
});
