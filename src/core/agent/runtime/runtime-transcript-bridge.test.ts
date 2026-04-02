import { describe, expect, it, vi } from "vitest";

const transcriptFns = vi.hoisted(() => ({
  appendToolCallSync: vi.fn(),
  appendToolResultSync: vi.fn(),
}));

vi.mock("@/core/agent/actor/actor-transcript", () => transcriptFns);

import { createRuntimeTranscriptBridge } from "./runtime-transcript-bridge";

describe("RuntimeTranscriptBridge", () => {
  it("persists tool calls and results while forwarding artifact hooks", () => {
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const bridge = createRuntimeTranscriptBridge({
      sessionId: "session-1",
      actorId: "lead",
      onToolCall,
      onToolResult,
    });

    bridge.recordStep({
      type: "action",
      toolName: "write_file",
      toolInput: { path: "/tmp/demo.ts" },
      content: "",
      timestamp: Date.now(),
    });
    bridge.recordStep({
      type: "observation",
      toolName: "write_file",
      toolOutput: { ok: true },
      content: "",
      timestamp: Date.now(),
    });

    expect(transcriptFns.appendToolCallSync).toHaveBeenCalledWith(
      "session-1",
      "lead",
      "write_file",
      { path: "/tmp/demo.ts" },
    );
    expect(transcriptFns.appendToolResultSync).toHaveBeenCalledWith(
      "session-1",
      "lead",
      "write_file",
      { ok: true },
    );
    expect(onToolCall).toHaveBeenCalledWith("write_file", { path: "/tmp/demo.ts" });
    expect(onToolResult).toHaveBeenCalledWith("write_file", { ok: true });
  });
});
