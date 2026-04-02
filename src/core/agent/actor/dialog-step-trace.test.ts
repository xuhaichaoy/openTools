import { afterEach, describe, expect, it } from "vitest";
import type { ActorEvent, DialogMessage } from "./types";
import {
  formatDialogTraceLine,
  getDialogStepTraceMode,
  getDialogTraceScopeKey,
  registerDialogTraceActorSystemInstance,
  setDialogStepTraceMode,
  shouldTraceDialogStep,
  unregisterDialogTraceActorSystemInstance,
  updateDialogTraceActorSystemSession,
} from "./dialog-step-trace";

afterEach(() => {
  setDialogStepTraceMode("off");
});

describe("dialog-step-trace", () => {
  it("stores full trace mode as a separate toggle", () => {
    expect(setDialogStepTraceMode("full")).toBe("full");
    expect(getDialogStepTraceMode()).toBe("full");

    expect(setDialogStepTraceMode("off")).toBe("off");
    expect(getDialogStepTraceMode()).toBe("off");
  });

  it("formats step events as single-line summaries without content bodies", () => {
    const line = formatDialogTraceLine("session-123456", {
      type: "step",
      actorId: "coordinator",
      timestamp: 1,
      detail: {
        step: {
          type: "action",
          toolName: "spawn_task",
          content: "不要把这段正文写进日志",
          timestamp: 1,
        },
      },
    } satisfies ActorEvent);

    expect(line).toContain("session=session-");
    expect(line).toContain("actor=coordinator");
    expect(line).toContain("event=step");
    expect(line).toContain("tool=spawn_task");
    expect(line).not.toContain("不要把这段正文写进日志");
  });

  it("formats dialog messages as one-line routing summaries", () => {
    const line = formatDialogTraceLine("session-abcdef", {
      id: "msg-1",
      from: "user",
      to: "coordinator",
      content: "正文不需要进调试文件",
      timestamp: 2,
      priority: "normal",
      kind: "user_input",
    } satisfies DialogMessage);

    expect(line).toContain("event=dialog_message");
    expect(line).toContain("kind=user_input");
    expect(line).toContain("from=user");
    expect(line).toContain("to=coordinator");
    expect(line).not.toContain("正文不需要进调试文件");
  });

  it("skips token-level streaming answer and tool streaming steps", () => {
    expect(shouldTraceDialogStep({
      type: "answer",
      content: "正在逐 token 输出",
      timestamp: 1,
      streaming: true,
    })).toBe(false);

    expect(shouldTraceDialogStep({
      type: "tool_streaming",
      content: "{\"thought\":\"streaming\"}",
      timestamp: 1,
      streaming: true,
    })).toBe(false);

    expect(shouldTraceDialogStep({
      type: "action",
      content: "调用 read_file",
      timestamp: 1,
    })).toBe(true);
  });

  it("tracks rapid actor-system replacement only within the same trace scope", () => {
    const sharedContext = {
      surface: "local_dialog" as const,
      ownerId: "dialog_main",
      runtimeKey: "local_dialog::replacement-test",
    };
    const otherScopeContext = {
      surface: "local_dialog" as const,
      ownerId: "dialog_main",
      runtimeKey: "local_dialog::replacement-test-other",
    };

    const initial = registerDialogTraceActorSystemInstance({
      sessionId: "session-scope-a",
      traceContext: sharedContext,
      timestamp: 1_000,
    });
    const replaced = registerDialogTraceActorSystemInstance({
      sessionId: "session-scope-b",
      traceContext: sharedContext,
      timestamp: 1_800,
    });
    const isolated = registerDialogTraceActorSystemInstance({
      sessionId: "session-scope-c",
      traceContext: otherScopeContext,
      timestamp: 1_900,
    });

    expect(initial.replacedSessionId).toBeUndefined();
    expect(replaced.replacedSessionId).toBe("session-scope-a");
    expect(replaced.elapsedMs).toBe(800);
    expect(isolated.replacedSessionId).toBeUndefined();
    expect(getDialogTraceScopeKey(sharedContext)).not.toBe(getDialogTraceScopeKey(otherScopeContext));

    unregisterDialogTraceActorSystemInstance({
      sessionId: "session-scope-b",
      traceContext: sharedContext,
    });
    unregisterDialogTraceActorSystemInstance({
      sessionId: "session-scope-c",
      traceContext: otherScopeContext,
    });
  });

  it("rebinds the registered actor-system session when a restored session id is adopted", () => {
    const traceContext = {
      surface: "im_conversation" as const,
      ownerId: "dingtalk",
      runtimeKey: "im::conversation::restore-test",
    };

    registerDialogTraceActorSystemInstance({
      sessionId: "session-before-restore",
      traceContext,
      timestamp: 2_000,
    });
    updateDialogTraceActorSystemSession({
      previousSessionId: "session-before-restore",
      nextSessionId: "session-restored",
      traceContext,
    });
    const replacement = registerDialogTraceActorSystemInstance({
      sessionId: "session-after-restore",
      traceContext,
      timestamp: 3_000,
    });

    expect(replacement.replacedSessionId).toBe("session-restored");
    expect(replacement.elapsedMs).toBe(1_000);

    unregisterDialogTraceActorSystemInstance({
      sessionId: "session-after-restore",
      traceContext,
    });
  });
});
