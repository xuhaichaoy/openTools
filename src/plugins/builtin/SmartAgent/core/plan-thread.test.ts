import { describe, expect, it } from "vitest";
import {
  archivePlanThread,
  createPlanThread,
  finalizePlanThreadDraft,
  markPlanThreadPhase,
  parsePlanFollowupDecision,
  revisePlanThreadWithRelatedFollowup,
} from "./plan-mode";

describe("plan thread state", () => {
  it("should create and advance thread phases", () => {
    const t0 = createPlanThread({
      sessionId: "s1",
      taskId: "t1",
      baseQuery: "做一个后端服务",
      now: 100,
    });
    expect(t0.phase).toBe("drafting");
    expect(t0.planVersion).toBe(1);

    const t1 = markPlanThreadPhase(t0, "clarifying", 120);
    expect(t1.phase).toBe("clarifying");
    expect(t1.lastUpdatedAt).toBe(120);

    const t2 = finalizePlanThreadDraft(t1, "- step 1", 150);
    expect(t2.phase).toBe("awaiting_confirm");
    expect(t2.latestPlan).toContain("step 1");
  });

  it("should bump version for related followup", () => {
    const base = createPlanThread({
      sessionId: "s1",
      taskId: "t1",
      baseQuery: "构建计划",
      now: 10,
    });
    const updated = revisePlanThreadWithRelatedFollowup(base, "Rust 可以吗？", 20);
    expect(updated.planVersion).toBe(2);
    expect(updated.phase).toBe("drafting");
    expect(updated.latestFollowup).toBe("Rust 可以吗？");
    expect(updated.relationSourceTaskId).toBe("t1");
  });

  it("should archive old thread", () => {
    const base = createPlanThread({
      sessionId: "s1",
      taskId: "t1",
      baseQuery: "构建计划",
      now: 10,
    });
    const archived = archivePlanThread(base, 99);
    expect(archived.phase).toBe("archived");
    expect(archived.lastUpdatedAt).toBe(99);
  });
});

describe("followup decision parser", () => {
  it("should parse relation decision from JSON", () => {
    expect(parsePlanFollowupDecision('{"relation":"related"}').relation).toBe("related");
    expect(parsePlanFollowupDecision('{"decision":"unrelated"}').relation).toBe(
      "unrelated",
    );
  });

  it("should fallback to uncertain for invalid payload", () => {
    expect(parsePlanFollowupDecision("not-json").relation).toBe("uncertain");
  });
});
