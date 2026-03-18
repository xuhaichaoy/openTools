import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExecutionContextPlan } from "./types";
import type { AgentSession } from "@/store/agent-store";

const hoisted = vi.hoisted(() => ({
  buildBootstrapContextSnapshotMock: vi.fn(async (params: {
    workspaceRoot?: string;
    filePaths?: readonly string[];
    handoffPaths?: readonly string[];
    includeMemory?: boolean;
    recentDailyFiles?: number;
  }) => ({
    workspaceRoot: params.workspaceRoot,
    files: params.workspaceRoot
      ? [
          {
            name: "AGENTS.md",
            path: `${params.workspaceRoot}/AGENTS.md`,
            content: "规则",
            source: "workspace" as const,
            truncated: false,
          },
        ]
      : [],
    prompt: params.workspaceRoot ? `BOOTSTRAP ${params.workspaceRoot}` : "",
    diagnostics: {
      maxCharsPerFile: 4000,
      totalMaxChars: 12000,
      usedChars: params.workspaceRoot ? 3200 : 0,
      remainingChars: params.workspaceRoot ? 8800 : 0,
      includedFileCount: params.workspaceRoot ? 1 : 0,
      truncatedFileCount: 0,
      omittedFileCount: 0,
      missingFileCount: 0,
      files: params.workspaceRoot
        ? [
            {
              name: "AGENTS.md",
              path: `${params.workspaceRoot}/AGENTS.md`,
              source: "workspace" as const,
              status: "included" as const,
              originalChars: 3200,
              includedChars: 3200,
            },
          ]
        : [],
    },
  })),
}));

vi.mock("@/core/ai/bootstrap-context", () => ({
  buildBootstrapContextSnapshot: hoisted.buildBootstrapContextSnapshotMock,
}));

vi.mock("@/core/ai/ai-session-runtime", () => ({
  summarizeAISessionRuntimeText: (text: string, max = 120) =>
    String(text).slice(0, max),
}));

vi.mock("@/store/agent-store", () => ({
  getVisibleAgentTasks: (session: AgentSession) => session.tasks,
  getHiddenAgentTasks: () => [],
  getAgentSessionCompactedTaskCount: (session: AgentSession) =>
    Math.max(0, Math.min(session.tasks.length, session.compaction?.compactedTaskCount ?? 0)),
}));

import {
  assembleAgentExecutionContext,
  buildCurrentTurnFileInsights,
} from "./context-assembler";

function makeSession(): AgentSession {
  return {
    id: "session-1",
    title: "旧项目",
    createdAt: 1,
    workspaceRoot: "/repo",
    sourceHandoff: {
      query: "延续旧项目",
      attachmentPaths: ["/repo/handoff-old.md"],
      files: [
        {
          path: "/repo/specs/legacy-spec.md",
        },
      ],
    },
    compaction: {
      summary: "## 最新用户目标\n- 延续旧项目\n\n## 当前结论\n- 已读取旧文件",
      compactedTaskCount: 1,
      lastCompactedAt: 10,
      preservedIdentifiers: ["legacy.ts"],
      bootstrapReinjectionPreview: ["AGENTS：先确认工作区"],
    },
    tasks: [
      {
        id: "task-1",
        query: "分析旧项目",
        attachmentPaths: ["/repo/src/legacy.ts"],
        steps: [
          {
            type: "action",
            content: "读取 legacy.ts",
            toolName: "read_file",
            toolInput: {
              path: "/repo/src/legacy.ts",
            },
            timestamp: 2,
          },
        ],
        answer: "已分析完成",
        status: "success",
        createdAt: 1,
      },
    ],
  };
}

function makePlan(
  overrides?: Partial<AgentExecutionContextPlan>,
): AgentExecutionContextPlan {
  return {
    scope: {
      previousWorkspaceRoot: "/repo",
      workspaceRoot: "/repo",
      attachmentPaths: ["/repo/src/new-page.tsx"],
      imagePaths: ["/repo/assets/mock.png"],
      handoffPaths: ["/repo/handoff-new.md"],
      pathHints: [
        "/repo/src/new-page.tsx",
        "/repo/assets/mock.png",
        "/repo/handoff-new.md",
      ],
      queryIntent: "coding",
      explicitReset: false,
    },
    continuity: {
      strategy: "inherit_summary_only",
      reason: "same_workspace",
      carrySummary: true,
      carryRecentSteps: false,
      carryFiles: false,
      carryHandoff: true,
    },
    effectiveWorkspaceRoot: "/repo",
    workspaceRootToPersist: "/repo",
    promptSourceHandoff: makeSession().sourceHandoff,
    shouldResetInheritedContext: false,
    ...overrides,
  };
}

describe("context-assembler", () => {
  beforeEach(() => {
    hoisted.buildBootstrapContextSnapshotMock.mockClear();
  });

  it("keeps current-turn files when continuity does not carry session files", async () => {
    const session = makeSession();
    const assembly = await assembleAgentExecutionContext({
      session,
      query: "实现一个全新的页面",
      executionContextPlan: makePlan(),
      attachmentSummary: "附件 1 项，图片 1 张",
      supplementalSystemPrompt: "SYSTEM",
      knowledgeContextMessageCount: 3,
    });

    expect(assembly.sessionContextMessages).toHaveLength(2);
    expect(assembly.promptContextSnapshot.historyContextMessageCount).toBe(2);
    expect(assembly.effectiveFiles.map((file) => file.path)).toEqual([
      "/repo/src/new-page.tsx",
      "/repo/assets/mock.png",
      "/repo/handoff-new.md",
    ]);
    expect(assembly.bootstrapHandoffPaths).toEqual([
      "/repo/handoff-old.md",
      "/repo/specs/legacy-spec.md",
      "/repo/handoff-new.md",
    ]);
    expect(assembly.promptContextSnapshot.continuityStrategy).toBe("inherit_summary_only");
    expect(assembly.promptContextSnapshot.bootstrapDiagnostics.totalMaxChars).toBe(12000);
    expect(assembly.extraSystemPrompt).toContain("BOOTSTRAP /repo");
    expect(assembly.extraSystemPrompt).toContain("## 当前执行上下文");
    expect(hoisted.buildBootstrapContextSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/repo",
        filePaths: [
          "/repo/src/new-page.tsx",
          "/repo/assets/mock.png",
          "/repo/handoff-new.md",
        ],
        handoffPaths: [
          "/repo/handoff-old.md",
          "/repo/specs/legacy-spec.md",
          "/repo/handoff-new.md",
        ],
        includeMemory: true,
        recentDailyFiles: 1,
      }),
    );
  });

  it("reuses session files and trims handoff inheritance when continuity requires it", async () => {
    const session = makeSession();
    const assembly = await assembleAgentExecutionContext({
      session,
      query: "继续修改现有仓库",
      executionContextPlan: makePlan({
        continuity: {
          strategy: "inherit_full",
          reason: "same_workspace",
          carrySummary: false,
          carryRecentSteps: true,
          carryFiles: true,
          carryHandoff: false,
        },
      }),
    });

    expect(assembly.sessionContextMessages).toHaveLength(0);
    expect(assembly.effectiveFiles.some((file) => file.path === "/repo/src/legacy.ts")).toBe(true);
    expect(assembly.effectiveFiles.some((file) => file.path === "/repo/src/new-page.tsx")).toBe(false);
    expect(assembly.bootstrapFilePaths).toContain("/repo/src/legacy.ts");
    expect(assembly.bootstrapFilePaths).toContain("/repo/src/new-page.tsx");
    expect(assembly.bootstrapHandoffPaths).toEqual(["/repo/handoff-new.md"]);
    expect(assembly.promptContextSnapshot.historyContextMessageCount).toBe(0);
  });

  it("merges duplicate current-turn paths into a single insight entry", () => {
    const insights = buildCurrentTurnFileInsights({
      attachmentPaths: ["/repo/src/page.tsx"],
      handoffPaths: ["/repo/src/page.tsx"],
    });

    expect(insights).toEqual([
      {
        path: "/repo/src/page.tsx",
        source: "tool",
        mentions: 2,
      },
    ]);
  });
});
