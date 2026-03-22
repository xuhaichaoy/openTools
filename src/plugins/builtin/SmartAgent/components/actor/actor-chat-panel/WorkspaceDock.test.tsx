import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { DialogWorkspaceDock } from "./WorkspaceDock";
import type {
  CollaborationChildSession,
  CollaborationContractDelegation,
} from "@/core/collaboration/types";
import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import type { DialogContextSnapshot } from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";
import type { ActorSnapshot } from "@/store/actor-system-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTOR: ActorSnapshot = {
  id: "actor-1",
  roleName: "Reviewer",
  roleId: "reviewer",
  persistent: true,
  status: "idle",
  pendingInbox: 0,
  sessionHistory: [],
};

const BASE_TASK: SpawnedTaskRecord = {
  runId: "run-1",
  spawnerActorId: "actor-0",
  targetActorId: "actor-1",
  dispatchSource: "manual",
  roleBoundary: "reviewer",
  task: "Review the patch",
  label: "Patch review",
  status: "running",
  spawnedAt: 1,
  mode: "session",
  expectsCompletionMessage: true,
  cleanup: "keep",
  sessionOpen: true,
};

const BASE_CHILD_SESSION: CollaborationChildSession = {
  id: "run-1",
  runId: "run-1",
  ownerActorId: "actor-0",
  targetActorId: "actor-1",
  label: "Patch review",
  roleBoundary: "reviewer",
  mode: "session",
  status: "waiting",
  focusable: true,
  resumable: true,
  announceToParent: true,
  startedAt: 1,
  updatedAt: 2,
};

const BASE_DELEGATION: CollaborationContractDelegation = {
  delegationId: "delegation-1",
  targetActorId: "actor-1",
  label: "Patch review",
  state: "waiting",
  runId: "run-1",
};

function createContextBreakdown() {
  return {
    totalSharedTokens: 0,
    totalRuntimeTokens: 0,
    attachmentCount: 0,
    imageCount: 0,
    openSessionCount: 0,
    sharedSections: [],
    actors: [],
    warnings: [],
  };
}

function renderWorkspace(params?: {
  panel?: "subtasks" | "context";
  task?: SpawnedTaskRecord;
  childSession?: CollaborationChildSession;
  contractDelegation?: CollaborationContractDelegation;
  contextSnapshot?: DialogContextSnapshot | null;
  dialogRoomCompaction?: {
    summary: string;
    compactedMessageCount: number;
    compactedSpawnedTaskCount: number;
    compactedArtifactCount: number;
    preservedIdentifiers: string[];
    triggerReasons?: string[];
    memoryConfirmedCount?: number;
    memoryQueuedCount?: number;
    updatedAt: number;
  } | null;
  dialogContextSummary?: {
    summary: string;
    summarizedMessageCount: number;
    updatedAt: number;
  } | null;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <DialogWorkspaceDock
        panel={params?.panel ?? "subtasks"}
        onPanelChange={() => undefined}
        actors={[ACTOR]}
        actorTodos={{}}
        dialogHistory={[]}
        artifacts={[]}
        sessionUploads={[]}
        spawnedTasks={[params?.task ?? BASE_TASK]}
        childSessions={params?.childSession ? [params.childSession] : [BASE_CHILD_SESSION]}
        contractDelegations={[params?.contractDelegation ?? BASE_DELEGATION]}
        selectedRunId="run-1"
        onSelectRunId={() => undefined}
        onSteerSession={() => undefined}
        onCloseSession={() => undefined}
        onKillSession={() => undefined}
        onContinueTaskWithAgent={() => undefined}
        draftPlan={null}
        draftInsight={null}
        contextBreakdown={createContextBreakdown()}
        contextSnapshot={params?.contextSnapshot ?? null}
        dialogRoomCompaction={params?.dialogRoomCompaction ?? null}
        dialogContextSummary={params?.dialogContextSummary ?? null}
        requirePlanApproval={false}
        onTogglePlanApproval={() => undefined}
        lastPlanReview={null}
        graphAvailable={false}
        onOpenGraph={null}
      />,
    );
  });

  return {
    container,
    root,
  };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((button) => {
    const text = button.textContent?.replace(/\s+/g, " ").trim();
    return text === label;
  }) ?? null;
}

function clickButton(button: HTMLButtonElement | null) {
  act(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("DialogWorkspaceDock child session actions", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  it("shows steer and lifecycle actions for retained child sessions", () => {
    ({ container, root } = renderWorkspace());

    expect(findButton(container!, "补充指令")).not.toBeNull();
    expect(findButton(container!, "结束保留")).not.toBeNull();
    expect(findButton(container!, "立即中止")).not.toBeNull();
    expect(findButton(container!, "继续子会话")).toBeNull();
    expect(findButton(container!, "聚焦子会话")).toBeNull();
  });

  it("keeps closed child sessions read-only in the workspace", () => {
    ({ container, root } = renderWorkspace({
      task: {
        ...BASE_TASK,
        status: "completed",
        sessionOpen: false,
        completedAt: 10,
      },
      childSession: {
        ...BASE_CHILD_SESSION,
        status: "completed",
        focusable: false,
        resumable: false,
        endedAt: 10,
      },
    }));

    expect(container?.textContent).toContain("该线程已结束");
    expect(findButton(container!, "补充指令")).toBeNull();
    expect(findButton(container!, "结束保留")).toBeNull();
    expect(findButton(container!, "立即中止")).toBeNull();
    expect(findButton(container!, "聚焦子会话")).toBeNull();
  });

  it("prefers delegation projection summaries for compact thread rows", () => {
    ({ container, root } = renderWorkspace({
      contractDelegation: {
        ...BASE_DELEGATION,
        statusSummary: "主 Agent 已收到第一轮审查摘要，线程仍可复用。",
        nextStepHint: "主 Agent 可按需补充新的审查范围。",
      },
    }));

    expect(container?.textContent).toContain("主 Agent 已收到第一轮审查摘要，线程仍可复用。");
    expect(container?.textContent).toContain("主 Agent 可按需补充新的审查范围。");
  });

  it("explains continuation and compaction on the context panel", () => {
    ({ container, root } = renderWorkspace({
      panel: "context",
      contextSnapshot: {
        generatedAt: 111,
        sessionId: "dialog-1",
        workspaceRoot: "/tmp/project",
        dialogHistoryCount: 20,
        summarizedMessageCount: 8,
        uploadCount: 1,
        artifactCount: 2,
        spawnedTaskCount: 1,
        openSessionCount: 1,
        actorCount: 2,
        runningActorCount: 1,
        pendingInteractionCount: 1,
        pendingApprovalCount: 0,
        queuedFollowUpCount: 2,
        summaryPreview: "更早消息已经整理为摘要。",
        roomCompactionUpdatedAt: 222,
        roomCompactionMessageCount: 12,
        roomCompactionTaskCount: 1,
        roomCompactionArtifactCount: 2,
        roomCompactionSummaryPreview: "系统已经把较早消息整理成续跑摘要。",
        roomCompactionPreservedIdentifiers: ["main.tsx", "design.png"],
        roomCompactionTriggerReasons: ["模型返回上下文压力错误"],
        roomCompactionMemoryConfirmedCount: 1,
        roomCompactionMemoryQueuedCount: 1,
        memoryRecallAttempted: true,
        memoryHitCount: 2,
        memoryPreview: ["默认中文回答", "注意保留暖色调"],
        transcriptRecallAttempted: true,
        transcriptRecallHitCount: 1,
        transcriptPreview: ["Dialog：继续完成首页实现"],
        contextLines: [
          "当前工作区：/tmp/project",
          "待处理交互：1 条",
          "房间压缩：已整理 12 条消息、1 条子任务线索、2 条产物线索",
        ],
      },
      dialogContextSummary: {
        summary: "这是一个很长的早期协作摘要。".repeat(30),
        summarizedMessageCount: 8,
        updatedAt: 333,
      },
      dialogRoomCompaction: {
        summary: "这是一个很长的房间压缩摘要。".repeat(30),
        compactedMessageCount: 12,
        compactedSpawnedTaskCount: 1,
        compactedArtifactCount: 2,
        preservedIdentifiers: ["main.tsx", "design.png"],
        triggerReasons: ["模型返回上下文压力错误", "房间历史已明显拉长"],
        memoryConfirmedCount: 1,
        memoryQueuedCount: 1,
        updatedAt: 444,
      },
    }));

    expect(container?.textContent).toContain("这页在说明什么");
    expect(container?.textContent).toContain("执行概览");
    expect(container?.textContent).toContain("本轮会沿用什么");
    expect(container?.textContent).toContain("记忆如何回补");
    expect(container?.textContent).toContain("系统如何接住复杂房间");
    expect(container?.textContent).toContain("续跑细项清单");
    expect(container?.textContent).toContain("成本观察（调试）");
    expect(container?.textContent).toContain("当前会优先沿用工作区 /tmp/project");
    expect(container?.textContent).toContain("还有 1 条待回复/待确认交互");
    expect(container?.textContent).toContain("本轮会自动回补 3 条长期记忆/历史轨迹");
    expect(container?.textContent).toContain("长期记忆会回补 2 条：默认中文回答；注意保留暖色调");
    expect(container?.textContent).toContain("会话轨迹会回补 1 条：Dialog：继续完成首页实现");
    expect(container?.textContent).toContain("较早的 12 条消息、1 条子任务线索、2 条产物线索已经压缩为结构化续跑摘要");
    expect(findButton(container!, "展开详情")).not.toBeNull();

    clickButton(findButton(container!, "展开详情"));
    expect(container?.textContent).toContain("收起详情");
  });
});
