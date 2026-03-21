import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { DialogChildSessionStrip } from "./DialogChildSessionStrip";
import type { CollaborationChildSession } from "@/core/collaboration/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createSession(
  input: Partial<CollaborationChildSession> & Pick<CollaborationChildSession, "id" | "runId" | "targetActorId" | "label">,
): CollaborationChildSession {
  return {
    id: input.id,
    runId: input.runId,
    ownerActorId: input.ownerActorId ?? "coordinator",
    targetActorId: input.targetActorId,
    label: input.label,
    roleBoundary: input.roleBoundary ?? "executor",
    mode: input.mode ?? "session",
    status: input.status ?? "waiting",
    focusable: input.focusable ?? true,
    resumable: input.resumable ?? true,
    announceToParent: input.announceToParent ?? true,
    lastResultSummary: input.lastResultSummary,
    lastError: input.lastError,
    startedAt: input.startedAt ?? 1,
    updatedAt: input.updatedAt ?? 2,
    endedAt: input.endedAt,
  };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(label)) ?? null;
}

describe("DialogChildSessionStrip", () => {
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

  it("renders the compact retained-thread summary", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DialogChildSessionStrip
          sessions={[
            createSession({
              id: "run-1",
              runId: "run-1",
              targetActorId: "reviewer",
              label: "Patch review",
              lastResultSummary: "第一轮审查已完成，等待继续。",
            }),
          ]}
          actorNameById={new Map([["reviewer", "Reviewer"]])}
          pendingSteerSessionRunId={null}
        />,
      );
    });

    expect(container?.textContent).toContain("Patch review");
    expect(container?.textContent).toContain("Reviewer");
    expect(container?.textContent).toContain("第一轮审查已完成");
    expect(container?.textContent).toContain("后台线程 1");
    expect(container?.textContent).toContain("由主 Agent 在后台保留");
  });

  it("shows pending steer state and overflow hint", () => {
    const onOpenWorkspace = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DialogChildSessionStrip
          sessions={[
            createSession({ id: "run-1", runId: "run-1", targetActorId: "reviewer", label: "Review" }),
            createSession({ id: "run-2", runId: "run-2", targetActorId: "builder", label: "Build" }),
            createSession({ id: "run-3", runId: "run-3", targetActorId: "validator", label: "Validate" }),
            createSession({ id: "run-4", runId: "run-4", targetActorId: "ops", label: "Ops" }),
          ]}
          actorNameById={new Map([
            ["reviewer", "Reviewer"],
            ["builder", "Builder"],
            ["validator", "Validator"],
            ["ops", "Ops"],
          ])}
          pendingSteerSessionRunId="run-3"
          onOpenWorkspace={onOpenWorkspace}
        />,
      );
    });

    expect(container?.textContent).toContain("主 Agent 正在接管");
    expect(container?.textContent).toContain("还有 1 个后台线程");

    act(() => {
      findButton(container!, "查看全部")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
  });
});
