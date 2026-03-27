import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyRecoverableStreamResult,
  clearAIStreamEventListenersFromCurrentPage,
  shouldDeferManagedAuthStreamError,
} from "./mtools-ai";

const TAURI_EVENT_LISTENERS_OBJECT_NAME = "__internal_unstable_listeners_object_id__";

describe("shouldDeferManagedAuthStreamError", () => {
  it("matches managed auth 401 errors", () => {
    expect(shouldDeferManagedAuthStreamError(
      { source: "team" },
      'API 错误 (HTTP 401): {"code":"UNAUTHORIZED","message":"Invalid token"}',
    )).toBe(true);

    expect(shouldDeferManagedAuthStreamError(
      { source: "platform" },
      "unauthorized",
    )).toBe(true);
  });

  it("does not defer non-auth errors or own-key errors", () => {
    expect(shouldDeferManagedAuthStreamError(
      { source: "team" },
      "API 错误 (HTTP 500): internal server error",
    )).toBe(false);

    expect(shouldDeferManagedAuthStreamError(
      { source: "own_key" },
      'API 错误 (HTTP 401): {"code":"UNAUTHORIZED","message":"Invalid token"}',
    )).toBe(false);
  });
});

describe("classifyRecoverableStreamResult", () => {
  it("prefers tool calls when valid tool calls already arrived", () => {
    expect(classifyRecoverableStreamResult({
      content: "partial text",
      toolCalls: [
        {
          id: "tool-1",
          type: "function",
          function: {
            name: "spawn_task",
            arguments: "{}",
          },
        },
      ],
    })).toBe("tool_calls");
  });

  it("returns content when visible text already exists", () => {
    expect(classifyRecoverableStreamResult({
      content: "已生成大部分结果",
      toolCalls: [],
    })).toBe("content");
  });

  it("ignores empty tool calls and empty content", () => {
    expect(classifyRecoverableStreamResult({
      content: "   ",
      toolCalls: [
        {
          id: "tool-1",
          type: "function",
          function: {
            name: "",
            arguments: "{}",
          },
        },
      ],
    })).toBe(null);
  });
});

describe("clearAIStreamEventListenersFromCurrentPage", () => {
  afterEach(() => {
    delete (window as Window & Record<string, unknown>)[TAURI_EVENT_LISTENERS_OBJECT_NAME];
    delete (window as Window & {
      __TAURI_INTERNALS__?: unknown;
    }).__TAURI_INTERNALS__;
  });

  it("removes only tracked AI stream listeners from the current page", () => {
    const unregisterCallback = vi.fn();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { unregisterCallback },
    });
    const listeners = Object.create(null) as Record<string, Record<string, { handlerId: number }>>;
    Object.defineProperty(listeners, "ai-stream-chunk", {
      value: {
        11: { handlerId: 101 },
        12: { handlerId: 102 },
      },
    });
    Object.defineProperty(listeners, "ai-stream-done", {
      value: {
        13: { handlerId: 103 },
      },
    });
    Object.defineProperty(listeners, "other-event", {
      value: {
        21: { handlerId: 201 },
      },
    });
    (window as Window & Record<string, unknown>)[TAURI_EVENT_LISTENERS_OBJECT_NAME] = listeners;

    clearAIStreamEventListenersFromCurrentPage();

    expect(unregisterCallback).toHaveBeenCalledTimes(3);
    expect(unregisterCallback).toHaveBeenNthCalledWith(1, 101);
    expect(unregisterCallback).toHaveBeenNthCalledWith(2, 102);
    expect(unregisterCallback).toHaveBeenNthCalledWith(3, 103);
    expect(listeners["ai-stream-chunk"]).toEqual({});
    expect(listeners["ai-stream-done"]).toEqual({});
    expect(listeners["other-event"]).toEqual({
      21: { handlerId: 201 },
    });
  });

  it("tolerates missing listener storage", () => {
    expect(() => clearAIStreamEventListenersFromCurrentPage()).not.toThrow();
  });
});
