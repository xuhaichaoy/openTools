import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  flags: {
    context_runtime: false,
    memory_pipeline: false,
    compaction: false,
    workspace_switch: false,
  },
}));

vi.mock("@/core/ai/local-ai-debug-preferences", () => ({
  isAIDebugFlagEnabled: (
    flag: "context_runtime" | "memory_pipeline" | "compaction" | "workspace_switch",
  ) => hoisted.flags[flag] === true,
}));

import {
  buildAgentContextRuntimeDebugReport,
  emitAgentContextRuntimeDebugReport,
} from "./debug-report";

describe("debug-report", () => {
  beforeEach(() => {
    hoisted.flags.context_runtime = false;
    hoisted.flags.memory_pipeline = false;
    hoisted.flags.compaction = false;
    hoisted.flags.workspace_switch = false;
  });

  it("builds a structured report from scope and prompt data", () => {
    const report = buildAgentContextRuntimeDebugReport({
      sessionId: "session-1",
      taskId: "task-1",
      query: "继续实现设置页字体缩放和窗口尺寸本地存储",
      scope: {
        previousWorkspaceRoot: "/repo/app",
        workspaceRoot: "/repo/app",
        attachmentPaths: ["/repo/app/src/settings.tsx"],
        imagePaths: [],
        handoffPaths: ["/repo/app/AGENTS.md"],
        pathHints: ["/repo/app/src/settings.tsx", "/repo/app/src/core/ui/local-ui-preferences.ts"],
        queryIntent: "coding",
        explicitReset: false,
      },
      continuity: {
        strategy: "inherit_full",
        reason: "same_workspace",
        carrySummary: true,
        carryRecentSteps: true,
        carryFiles: true,
        carryHandoff: true,
      },
      workspaceRoot: "/repo/app",
      workspaceReset: false,
      promptContextSnapshot: {
        generatedAt: 1,
        runModeLabel: "Coding 模式",
        forceNewSession: false,
        review: {
          visibleTaskCount: 2,
          hiddenTaskCount: 0,
          compactedTaskCount: 1,
          totalStepCount: 5,
          uniqueToolCount: 2,
        },
        files: [],
        contextLines: [],
        compactionPreservedIdentifiers: [],
        compactionPreservedToolNames: [],
        compactionBootstrapRules: [],
        bootstrapContextFileCount: 2,
        bootstrapContextFileNames: ["AGENTS.md", "USER.md"],
        workspaceRoot: "/repo/app",
        workspaceReset: false,
        memoryItemCount: 3,
        historyContextMessageCount: 4,
        knowledgeContextMessageCount: 1,
        hasSkillsPrompt: false,
        hasExtraSystemPrompt: true,
        hasCodingHint: true,
      },
      session: {
        id: "session-1",
        title: "设置页",
        createdAt: 1,
        tasks: [],
        compaction: {
          summary: "old",
          compactedTaskCount: 3,
          lastCompactedAt: 1,
          preservedIdentifiers: ["settings.tsx"],
          bootstrapReinjectionPreview: ["Session Startup: 先读 AGENTS.md"],
        },
      },
      status: "success",
      durationMs: 24_000,
      answer: "已补充字体缩放和窗口布局本地存储。",
      sessionNoteSaved: true,
      sessionNotePreview: "任务：实现设置页字体缩放；结果：已补充本地存储",
      referencedPaths: ["/repo/app/src/settings.tsx"],
      memoryAutoExtractionScheduled: true,
    });

    expect(report.scope.queryIntent).toBe("coding");
    expect(report.prompt.bootstrapFileNames).toEqual(["AGENTS.md", "USER.md"]);
    expect(report.compaction.compactedTaskCount).toBe(3);
    expect(report.ingest.sessionNoteSaved).toBe(true);
    expect(report.execution.status).toBe("success");
    expect(report.execution.answerPreview).toContain("字体缩放");
  });

  it("emits a single debug log only when a matching flag is enabled", () => {
    const report = buildAgentContextRuntimeDebugReport({
      sessionId: "session-2",
      taskId: "task-2",
      query: "切换到另一个目录重新开始",
      scope: {
        previousWorkspaceRoot: "/repo/a",
        workspaceRoot: "/repo/b",
        attachmentPaths: [],
        imagePaths: [],
        handoffPaths: [],
        pathHints: [],
        queryIntent: "coding",
        explicitReset: true,
      },
      continuity: {
        strategy: "fork_session",
        reason: "workspace_switch",
        carrySummary: false,
        carryRecentSteps: false,
        carryFiles: false,
        carryHandoff: false,
      },
      workspaceRoot: "/repo/b",
      workspaceReset: true,
      status: "success",
      durationMs: 8_000,
      answer: "已切到新目录。",
    });

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    emitAgentContextRuntimeDebugReport(report);
    expect(debugSpy).not.toHaveBeenCalled();

    hoisted.flags.workspace_switch = true;
    emitAgentContextRuntimeDebugReport(report);
    expect(debugSpy).toHaveBeenCalledTimes(1);

    debugSpy.mockRestore();
  });
});
