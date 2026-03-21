import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { FocusedChildSessionCard } from "./FocusedChildSessionCard";
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

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(label)) ?? null;
}

describe("FocusedChildSessionCard", () => {
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

  it("renders focused child session summary and action buttons", () => {
    const onResume = vi.fn();
    const onUnfocus = vi.fn();
    const onSteer = vi.fn();
    const onKill = vi.fn();
    const onOpenWorkspace = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <FocusedChildSessionCard
          task={TASK}
          childSession={CHILD_SESSION}
          targetActor={TARGET_ACTOR}
          actorNameById={new Map([["reviewer", "Reviewer"]])}
          actorTodos={TODOS}
          dialogHistory={DIALOG_HISTORY}
          artifacts={ARTIFACTS}
          isPendingSteer
          onResume={onResume}
          onUnfocus={onUnfocus}
          onSteer={onSteer}
          onKill={onKill}
          onOpenWorkspace={onOpenWorkspace}
        />,
      );
    });

    expect(container?.textContent).toContain("当前后台线程");
    expect(container?.textContent).toContain("Patch review");
    expect(container?.textContent).toContain("Steer 中");
    expect(container?.textContent).toContain("查看线程详情");
    expect(container?.textContent).not.toContain("最近线程上下文");
    expect(container?.textContent).not.toContain("继续检查边界条件");
    expect(container?.textContent).not.toContain("更早的上下文片段");

    act(() => {
      findButton(container!, "继续对话")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      findButton(container!, "回主房间")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      findButton(container!, "发送 steer")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      findButton(container!, "打开工作台")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      findButton(container!, "中止线程")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onUnfocus).toHaveBeenCalledTimes(1);
    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
    expect(onKill).toHaveBeenCalledTimes(1);

    act(() => {
      findButton(container!, "查看线程详情")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container?.textContent).toContain("最近线程上下文");
    expect(container?.textContent).toContain("继续检查边界条件");

    act(() => {
      findButton(container!, "展开完整线程")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container?.textContent).toContain("完整线程上下文");
    expect(container?.textContent).toContain("更早的上下文片段");
    expect(container?.textContent).toContain("review.md");
  });
});
