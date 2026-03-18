import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortActiveOrchestrator,
  clearActiveOrchestrator,
  getActiveOrchestratorCount,
  getActiveSessionId,
  isClusterPanelVisible,
  setActiveOrchestrator,
  setClusterPanelVisible,
} from "./active-orchestrator";
import {
  clearAllRuntimeSessions,
  getRuntimeSession,
} from "@/core/agent/context-runtime/runtime-state";

describe("active-orchestrator", () => {
  beforeEach(() => {
    clearAllRuntimeSessions();
    clearActiveOrchestrator("cluster-1");
    clearActiveOrchestrator("cluster-2");
  });

  it("syncs cluster runtime metadata while orchestrator is active", () => {
    const orchestrator = {
      abort: vi.fn(async () => undefined),
    } as any;
    const abortController = new AbortController();

    setActiveOrchestrator("cluster-1", orchestrator, abortController, {
      query: "实现首页",
      workspaceRoot: "/repo",
      status: "planning",
    });
    setClusterPanelVisible(true);

    expect(getActiveOrchestratorCount()).toBe(1);
    expect(getActiveSessionId()).toBe("cluster-1");
    expect(isClusterPanelVisible()).toBe(true);
    expect(getRuntimeSession("cluster", "cluster-1")).toMatchObject({
      query: "实现首页",
      workspaceRoot: "/repo",
      status: "planning",
    });
  });

  it("aborts orchestrator via shared runtime state and clears metadata", async () => {
    const abortSpy = vi.fn(async () => undefined);
    const orchestrator = {
      abort: abortSpy,
    } as any;
    const abortController = new AbortController();

    setActiveOrchestrator("cluster-2", orchestrator, abortController, {
      query: "修复样式",
    });

    await abortActiveOrchestrator("cluster-2");

    expect(abortController.signal.aborted).toBe(true);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(getRuntimeSession("cluster", "cluster-2")).toBeNull();
  });
});
