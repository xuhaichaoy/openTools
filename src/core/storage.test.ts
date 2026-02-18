/**
 * storage.ts 单元测试
 * 仅测试不依赖 Tauri runtime 的纯逻辑部分（createDebouncedPersister）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDebouncedPersister } from "./storage";

describe("createDebouncedPersister", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should debounce multiple trigger calls", () => {
    const fn = vi.fn();
    const persister = createDebouncedPersister(fn, 200);

    persister.trigger();
    persister.trigger();
    persister.trigger();

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should reset the timer on each trigger", () => {
    const fn = vi.fn();
    const persister = createDebouncedPersister(fn, 300);

    persister.trigger();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    persister.trigger(); // resets timer
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush should execute immediately", () => {
    const fn = vi.fn();
    const persister = createDebouncedPersister(fn, 1000);

    persister.trigger();
    persister.flush();

    expect(fn).toHaveBeenCalledTimes(1);

    // no more calls after timer expires (timer was cleared by flush)
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel should prevent pending persist", () => {
    const fn = vi.fn();
    const persister = createDebouncedPersister(fn, 200);

    persister.trigger();
    persister.cancel();

    vi.advanceTimersByTime(300);
    expect(fn).not.toHaveBeenCalled();
  });

  it("should use default debounce from constants when not specified", () => {
    const fn = vi.fn();
    // PERSIST_DEBOUNCE_MS is 300
    const persister = createDebouncedPersister(fn);

    persister.trigger();
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
