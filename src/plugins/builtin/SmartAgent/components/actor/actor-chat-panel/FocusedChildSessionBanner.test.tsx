import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { FocusedChildSessionBanner } from "./FocusedChildSessionBanner";
import type { CollaborationChildSession } from "@/core/collaboration/types";
import type { SpawnedTaskRecord } from "@/core/agent/actor/types";
import type { ActorSnapshot } from "@/store/actor-system-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET_ACTOR: ActorSnapshot = {
  id: "reviewer",
  roleName: "Reviewer",
  roleId: "reviewer",
  persistent: true,
  status: "idle",
  pendingInbox: 0,
  sessionHistory: [],
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

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(label)) ?? null;
}

describe("FocusedChildSessionBanner", () => {
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

  it("renders compact thread summary and actions", () => {
    const onResume = vi.fn();
    const onUnfocus = vi.fn();
    const onOpenWorkspace = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <FocusedChildSessionBanner
          task={TASK}
          childSession={CHILD_SESSION}
          targetActor={TARGET_ACTOR}
          actorNameById={new Map([["reviewer", "Reviewer"]])}
          isPendingSteer
          onResume={onResume}
          onUnfocus={onUnfocus}
          onOpenWorkspace={onOpenWorkspace}
        />,
      );
    });

    expect(container?.textContent).toContain("当前后台线程");
    expect(container?.textContent).toContain("Patch review");
    expect(container?.textContent).toContain("Steer 中");
    expect(container?.textContent).toContain("第一轮审查已完成");
    expect(container?.textContent).not.toContain("最近线程上下文");

    act(() => {
      findButton(container!, "继续")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      findButton(container!, "回主房间")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      findButton(container!, "线程详情")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onUnfocus).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
  });
});
