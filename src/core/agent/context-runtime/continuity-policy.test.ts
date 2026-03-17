import { describe, expect, it } from "vitest";
import { decideAgentSessionContinuity } from "./continuity-policy";

describe("decideAgentSessionContinuity", () => {
  it("soft resets when workspace switches before any meaningful history exists", () => {
    const decision = decideAgentSessionContinuity({
      scope: {
        previousWorkspaceRoot: "/workspace/a",
        workspaceRoot: "/workspace/b",
        attachmentPaths: [],
        imagePaths: [],
        handoffPaths: [],
        pathHints: [],
        queryIntent: "coding",
        explicitReset: false,
      },
      currentSession: null,
    });

    expect(decision.strategy).toBe("soft_reset");
    expect(decision.reason).toBe("workspace_switch");
    expect(decision.carrySummary).toBe(false);
    expect(decision.carryRecentSteps).toBe(false);
  });

  it("forks to a new session when workspace switches on a populated session", () => {
    const decision = decideAgentSessionContinuity({
      scope: {
        previousWorkspaceRoot: "/workspace/a",
        workspaceRoot: "/workspace/b",
        attachmentPaths: [],
        imagePaths: [],
        handoffPaths: [],
        pathHints: [],
        queryIntent: "coding",
        explicitReset: false,
      },
      currentSession: {
        id: "s1",
        title: "Test",
        createdAt: 1,
        workspaceRoot: "/workspace/a",
        tasks: [
          {
            id: "t1",
            query: "旧项目分析",
            steps: [],
            answer: "done",
          },
        ],
      },
    });

    expect(decision.strategy).toBe("fork_session");
    expect(decision.reason).toBe("workspace_switch");
    expect(decision.carrySummary).toBe(false);
    expect(decision.carryRecentSteps).toBe(false);
  });

  it("soft resets when user explicitly starts an unrelated new task before any history exists", () => {
    const decision = decideAgentSessionContinuity({
      scope: {
        previousWorkspaceRoot: "/workspace/a",
        workspaceRoot: undefined,
        attachmentPaths: [],
        imagePaths: [],
        handoffPaths: [],
        pathHints: [],
        queryIntent: "general",
        explicitReset: true,
      },
      currentSession: null,
    });

    expect(decision.strategy).toBe("soft_reset");
    expect(decision.reason).toBe("explicit_new_task");
  });

  it("forks when user explicitly starts an unrelated new task on a populated session", () => {
    const decision = decideAgentSessionContinuity({
      scope: {
        previousWorkspaceRoot: "/workspace/a",
        workspaceRoot: undefined,
        attachmentPaths: [],
        imagePaths: [],
        handoffPaths: [],
        pathHints: [],
        queryIntent: "general",
        explicitReset: true,
      },
      currentSession: {
        id: "s1",
        title: "Test",
        createdAt: 1,
        tasks: [
          {
            id: "t1",
            query: "旧项目分析",
            steps: [],
            answer: "done",
          },
        ],
      },
    });

    expect(decision.strategy).toBe("fork_session");
    expect(decision.reason).toBe("explicit_new_task");
  });

  it("keeps only summary when session is already compacted and almost no live tasks remain", () => {
    const decision = decideAgentSessionContinuity({
      scope: {
        previousWorkspaceRoot: "/workspace/a",
        workspaceRoot: "/workspace/a",
        attachmentPaths: [],
        imagePaths: [],
        handoffPaths: [],
        pathHints: [],
        queryIntent: "coding",
        explicitReset: false,
      },
      currentSession: {
        id: "s1",
        title: "Test",
        createdAt: 1,
        tasks: [
          {
            id: "t1",
            query: "q",
            steps: [],
            answer: null,
          },
        ],
        compaction: {
          summary: "summary",
          compactedTaskCount: 1,
          lastCompactedAt: 1,
        },
      },
    });

    expect(decision.strategy).toBe("inherit_summary_only");
    expect(decision.carrySummary).toBe(true);
    expect(decision.carryRecentSteps).toBe(false);
  });
});
