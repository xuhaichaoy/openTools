import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortRuntimeSession,
  buildRuntimeSessionKey,
  clearAllRuntimeSessions,
  getForegroundRuntimeSession,
  getRuntimeSession,
  registerRuntimeAbortHandler,
  useRuntimeStateStore,
} from "./runtime-state";

describe("runtime-state", () => {
  beforeEach(() => {
    clearAllRuntimeSessions();
    localStorage.clear();
  });

  it("stores and patches runtime metadata in local persistent state", () => {
    useRuntimeStateStore.getState().upsertSession({
      mode: "agent",
      sessionId: "session-1",
      query: "继续实现设置页",
      startedAt: 100,
      workspaceRoot: "/repo",
      waitingStage: "model_first_token",
      status: "running",
    });
    useRuntimeStateStore.getState().patchSession("agent", "session-1", {
      waitingStage: "tool_waiting",
      status: "executing",
    });

    const record = getRuntimeSession("agent", "session-1");
    const raw = localStorage.getItem("mtools-runtime-state-v1");

    expect(buildRuntimeSessionKey("agent", "session-1")).toBe("agent:session-1");
    expect(record?.workspaceRoot).toBe("/repo");
    expect(record?.waitingStage).toBe("tool_waiting");
    expect(record?.status).toBe("executing");
    expect(getForegroundRuntimeSession("agent")?.sessionId).toBe("session-1");
    expect(raw).toContain("继续实现设置页");
  });

  it("invokes registered abort handlers and clears runtime entry", async () => {
    const abortSpy = vi.fn(async () => undefined);
    useRuntimeStateStore.getState().upsertSession({
      mode: "cluster",
      sessionId: "cluster-1",
      query: "并行处理任务",
      startedAt: 200,
      status: "running",
    });
    registerRuntimeAbortHandler("cluster", "cluster-1", abortSpy);

    await abortRuntimeSession("cluster", "cluster-1");

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(getRuntimeSession("cluster", "cluster-1")).toBeNull();
  });

  it("supports im conversation runtime sessions in persistent state", () => {
    useRuntimeStateStore.getState().upsertSession({
      mode: "im_conversation",
      sessionId: "im-1",
      query: "钉钉群里的后续追问",
      displayLabel: "钉钉会话",
      displayDetail: "钉钉 · 群聊",
      startedAt: 300,
      status: "awaiting_reply",
    });

    const record = getRuntimeSession("im_conversation", "im-1");

    expect(buildRuntimeSessionKey("im_conversation", "im-1")).toBe("im_conversation:im-1");
    expect(record?.displayLabel).toBe("钉钉会话");
    expect(getForegroundRuntimeSession("im_conversation")?.sessionId).toBe("im-1");
  });

  it("stores and clears compaction preview metadata", () => {
    useRuntimeStateStore.getState().upsertSession({
      mode: "dialog",
      sessionId: "dialog-1",
      query: "继续沿用刚才的话题",
      startedAt: 400,
      status: "running",
      roomCompactionSummaryPreview: "已整理较早的对话上下文",
      roomCompactionUpdatedAt: 450,
      roomCompactionMessageCount: 24,
      roomCompactionTaskCount: 2,
      roomCompactionArtifactCount: 1,
      roomCompactionPreservedIdentifiers: ["src/App.tsx", "README.md"],
    });
    useRuntimeStateStore.getState().patchSession("dialog", "dialog-1", {
      roomCompactionSummaryPreview: undefined,
      roomCompactionUpdatedAt: undefined,
      roomCompactionMessageCount: undefined,
      roomCompactionTaskCount: undefined,
      roomCompactionArtifactCount: undefined,
      roomCompactionPreservedIdentifiers: undefined,
    });

    const record = getRuntimeSession("dialog", "dialog-1");

    expect(record?.roomCompactionSummaryPreview).toBeUndefined();
    expect(record?.roomCompactionMessageCount).toBeUndefined();
    expect(record?.roomCompactionPreservedIdentifiers).toBeUndefined();
  });
});
