import { describe, expect, it } from "vitest";
import { buildDialogContextSummary } from "./dialog-session-summary";
import type { DialogMessage, SpawnedTaskRecord } from "./types";

describe("dialog-session-summary", () => {
  it("includes spawned task role boundaries in the older task summary", () => {
    const dialogHistory: DialogMessage[] = Array.from({ length: 14 }, (_, index) => ({
      id: `msg-${index}`,
      from: index % 2 === 0 ? "user" : "coordinator",
      content: index % 2 === 0 ? `用户消息 ${index}` : `房间回复 ${index}`,
      timestamp: 1000 + index * 100,
      priority: "normal",
    }));

    const spawnedTasks: SpawnedTaskRecord[] = [
      {
        runId: "run-1",
        spawnerActorId: "coordinator",
        targetActorId: "tester",
        roleBoundary: "validator",
        task: "补充验证并执行回归",
        label: "验证支援",
        status: "running",
        spawnedAt: 1500,
        mode: "run",
        expectsCompletionMessage: true,
        cleanup: "keep",
      },
    ];

    const summary = buildDialogContextSummary({
      dialogHistory,
      spawnedTasks,
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["tester", "Tester"],
      ]),
      keepRecentMessages: 4,
    });

    expect(summary).not.toBeNull();
    expect(summary?.summary).toContain("Tester · 验证回归 · 验证支援 · running");
  });
});

