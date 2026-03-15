import { describe, expect, it } from "vitest";

import {
  buildAISessionRuntimeChildExternalId,
  buildAISessionRuntimeId,
  getAISessionRuntimeFallbackTitle,
  getAISessionRuntimeKind,
  resolveAISessionRuntimeSourceId,
  summarizeAISessionRuntimeText,
} from "./ai-session-runtime";

describe("ai-session-runtime helpers", () => {
  it("builds stable runtime ids from mode and external session id", () => {
    expect(buildAISessionRuntimeId("ask", "conv-1")).toBe("ask:conv-1");
    expect(buildAISessionRuntimeId("dialog", "room/1")).toBe("dialog:room%2F1");
    expect(buildAISessionRuntimeChildExternalId("room-1", "spawn_run", "abc")).toBe("room-1::spawn_run:abc");
  });

  it("maps mode metadata consistently", () => {
    expect(getAISessionRuntimeKind("ask")).toBe("conversation");
    expect(getAISessionRuntimeKind("agent")).toBe("task_session");
    expect(getAISessionRuntimeKind("cluster")).toBe("workflow_session");
    expect(getAISessionRuntimeKind("dialog")).toBe("collaboration_room");

    expect(getAISessionRuntimeFallbackTitle("ask")).toBe("Ask 对话");
    expect(getAISessionRuntimeFallbackTitle("dialog")).toBe("Dialog 房间");
  });

  it("resolves runtime source ids only when the source ref is complete", () => {
    expect(resolveAISessionRuntimeSourceId({
      sourceMode: "cluster",
      sourceSessionId: "cluster-1",
    })).toBe("cluster:cluster-1");

    expect(resolveAISessionRuntimeSourceId({
      sourceMode: "cluster",
    })).toBeUndefined();

    expect(resolveAISessionRuntimeSourceId(null)).toBeUndefined();
  });

  it("builds compact runtime-safe text previews", () => {
    expect(summarizeAISessionRuntimeText("  hello   world  ", 20)).toBe("hello world");
    expect(summarizeAISessionRuntimeText("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefg...");
    expect(summarizeAISessionRuntimeText("   ")).toBeUndefined();
  });
});
