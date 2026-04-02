import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { FocusedChildTranscriptPanel } from "./FocusedChildTranscriptPanel";
import type { CollaborationChildSession } from "@/core/collaboration/types";
import type {
  DialogArtifactRecord,
  DialogMessage,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";
import type { TodoItem } from "@/core/agent/actor/middlewares";
import type { ActorSnapshot } from "@/store/actor-system-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET_ACTOR: ActorSnapshot = {
  id: "reviewer",
  roleName: "Reviewer",
  roleId: "reviewer",
  persistent: true,
  status: "idle",
  pendingInbox: 0,
  sessionHistory: [
    { role: "user", content: "更早的上下文片段", timestamp: 12 },
    { role: "assistant", content: "我先检查整体改动范围。", timestamp: 14 },
    { role: "user", content: "重点看边界条件和回归点。", timestamp: 16 },
    { role: "assistant", content: "第一轮审查已完成，建议继续验证边界条件。", timestamp: 20 },
  ],
};

const TASK: SpawnedTaskRecord = {
  runId: "run-1",
  spawnerActorId: "coordinator",
  targetActorId: "reviewer",
  task: "继续做代码审查",
  label: "Patch review",
  status: "completed",
  spawnedAt: 10,
  completedAt: 30,
  lastActiveAt: 30,
  mode: "session",
  expectsCompletionMessage: true,
  cleanup: "keep",
  sessionOpen: true,
  sessionHistoryStartIndex: 1,
  result: "已完成第一轮审查",
};

const CHILD_SESSION: CollaborationChildSession = {
  id: "run-1",
  runId: "run-1",
  ownerActorId: "coordinator",
  targetActorId: "reviewer",
  label: "Patch review",
  roleBoundary: "reviewer",
  mode: "session",
  status: "waiting",
  focusable: true,
  resumable: true,
  announceToParent: true,
  lastResultSummary: "第一轮审查已完成",
  statusSummary: "主 Agent 已收到第一轮审查摘要。",
  startedAt: 10,
  updatedAt: 30,
};

const TODOS: TodoItem[] = [
  {
    id: "todo-1",
    title: "继续检查边界条件",
    status: "in_progress",
    priority: "high",
    createdAt: 15,
    updatedAt: 25,
  },
];

const DIALOG_HISTORY: DialogMessage[] = [
  {
    id: "msg-1",
    from: "user",
    to: "reviewer",
    content: "请继续检查边界条件。",
    timestamp: 18,
    priority: "normal",
    kind: "user_input",
    relatedRunId: "run-1",
  },
  {
    id: "msg-2",
    from: "reviewer",
    to: "coordinator",
    content: "第一轮审查已完成，建议继续验证边界条件。",
    timestamp: 21,
    priority: "normal",
    kind: "agent_result",
    relatedRunId: "run-1",
  },
];

const ARTIFACTS: DialogArtifactRecord[] = [
  {
    id: "artifact-1",
    actorId: "reviewer",
    path: "/tmp/review.md",
    fileName: "review.md",
    directory: "/tmp",
    source: "message",
    summary: "review notes",
    timestamp: 28,
    relatedRunId: "run-1",
  },
];

describe("FocusedChildTranscriptPanel", () => {
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

  it("renders focused transcript entries and related artifacts", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <FocusedChildTranscriptPanel
          task={TASK}
          childSession={CHILD_SESSION}
          targetActor={TARGET_ACTOR}
          actorNameById={new Map([["reviewer", "Reviewer"], ["coordinator", "Coordinator"]])}
          actorTodos={TODOS}
          dialogHistory={DIALOG_HISTORY}
          artifacts={ARTIFACTS}
        />,
      );
    });

    expect(container?.textContent).toContain("正在查看后台线程");
    expect(container?.textContent).toContain("Patch review");
    expect(container?.textContent).toContain("继续检查边界条件");
    expect(container?.textContent).toContain("会话轨迹");
    expect(container?.textContent).toContain("Dialog");
    expect(container?.textContent).toContain("第一轮审查已完成");
    expect(container?.textContent).toContain("/tmp/review.md");
    expect(container?.textContent).not.toContain("更早的上下文片段");
  });
});
