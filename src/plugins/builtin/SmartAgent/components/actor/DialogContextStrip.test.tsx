import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { DialogContextStrip } from "./DialogContextStrip";
import type { DialogContextSnapshot } from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DialogContextStrip", () => {
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

  it("keeps recall details out of the main-room context strip", () => {
    const snapshot: DialogContextSnapshot = {
      generatedAt: Date.now(),
      workspaceRoot: "/Users/demo/project",
      dialogHistoryCount: 12,
      summarizedMessageCount: 6,
      uploadCount: 0,
      artifactCount: 2,
      spawnedTaskCount: 3,
      openSessionCount: 1,
      actorCount: 3,
      runningActorCount: 1,
      pendingInteractionCount: 0,
      pendingApprovalCount: 0,
      queuedFollowUpCount: 0,
      roomCompactionMessageCount: 0,
      roomCompactionTaskCount: 0,
      roomCompactionArtifactCount: 0,
      roomCompactionPreservedIdentifiers: [],
      roomCompactionTriggerReasons: [],
      roomCompactionMemoryConfirmedCount: 0,
      roomCompactionMemoryQueuedCount: 0,
      memoryRecallAttempted: true,
      memoryHitCount: 2,
      memoryPreview: ["默认中文回答", "注意保留暖色调"],
      transcriptRecallAttempted: true,
      transcriptRecallHitCount: 1,
      transcriptPreview: ["Dialog：继续完成首页实现"],
      contextLines: [],
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<DialogContextStrip snapshot={snapshot} />);
    });

    expect(container?.textContent).toContain("工作区 project");
    expect(container?.textContent).not.toContain("记忆 2");
    expect(container?.textContent).not.toContain("轨迹 1");
    expect(container?.textContent).not.toContain("默认中文回答");
    expect(container?.textContent).not.toContain("继续完成首页实现");
    expect(container?.textContent).not.toContain("摘要 6");
    expect(container?.textContent).not.toContain("已整理");
  });

  it("stays hidden when only recall bookkeeping exists", () => {
    const snapshot: DialogContextSnapshot = {
      generatedAt: Date.now(),
      dialogHistoryCount: 0,
      summarizedMessageCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      spawnedTaskCount: 0,
      openSessionCount: 0,
      actorCount: 0,
      runningActorCount: 0,
      pendingInteractionCount: 0,
      pendingApprovalCount: 0,
      queuedFollowUpCount: 0,
      roomCompactionMessageCount: 0,
      roomCompactionTaskCount: 0,
      roomCompactionArtifactCount: 0,
      roomCompactionPreservedIdentifiers: [],
      roomCompactionTriggerReasons: [],
      roomCompactionMemoryConfirmedCount: 0,
      roomCompactionMemoryQueuedCount: 0,
      memoryRecallAttempted: true,
      memoryHitCount: 1,
      memoryPreview: ["默认中文回答"],
      transcriptRecallAttempted: true,
      transcriptRecallHitCount: 1,
      transcriptPreview: ["Dialog：继续完成首页实现"],
      contextLines: [],
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<DialogContextStrip snapshot={snapshot} />);
    });

    expect(container?.textContent).toBe("");
  });
});
