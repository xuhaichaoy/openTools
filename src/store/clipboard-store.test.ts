import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen,
}));

vi.mock("@/core/errors", () => ({
  handleError: vi.fn(),
}));

import {
  startClipboardListener,
  stopClipboardListener,
  useClipboardStore,
  type ClipboardEntry,
} from "./clipboard-store";

describe("clipboard store", () => {
  let eventHandler:
    | ((event: { payload: { entry: ClipboardEntry; total: number } }) => void)
    | undefined;

  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    eventHandler = undefined;
    listen.mockImplementation(
      async (
        _event: string,
        handler: (event: { payload: { entry: ClipboardEntry; total: number } }) => void,
      ) => {
        eventHandler = handler;
        return () => {};
      },
    );
    stopClipboardListener();
    useClipboardStore.setState({
      entries: [],
      search: "",
      loading: false,
    });
  });

  afterEach(() => {
    stopClipboardListener();
  });

  it("should update search text without triggering an immediate backend load", () => {
    useClipboardStore.getState().setSearch("hello");

    expect(useClipboardStore.getState().search).toBe("hello");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("should ignore live updates that do not match the active search", () => {
    startClipboardListener();
    useClipboardStore.setState({
      entries: [
        {
          id: 1,
          content: "hello world",
          content_type: "text",
          timestamp: 1,
          preview: "hello world",
        },
      ],
      search: "hello",
      loading: false,
    });

    eventHandler?.({
      payload: {
        entry: {
          id: 2,
          content: "unrelated content",
          content_type: "text",
          timestamp: 2,
          preview: "unrelated content",
        },
        total: 2,
      },
    });

    expect(useClipboardStore.getState().entries.map((entry) => entry.id)).toEqual([
      1,
    ]);
  });

  it("should prepend matching live updates while a search filter is active", () => {
    startClipboardListener();
    useClipboardStore.setState({
      entries: [
        {
          id: 1,
          content: "hello world",
          content_type: "text",
          timestamp: 1,
          preview: "hello world",
        },
      ],
      search: "hello",
      loading: false,
    });

    eventHandler?.({
      payload: {
        entry: {
          id: 2,
          content: "say hello again",
          content_type: "text",
          timestamp: 2,
          preview: "say hello again",
        },
        total: 2,
      },
    });

    expect(useClipboardStore.getState().entries.map((entry) => entry.id)).toEqual([
      2,
      1,
    ]);
  });
});
