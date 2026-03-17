import { describe, expect, it } from "vitest";

import { mergeStreamChunk } from "./stream-chunk-merge";

describe("stream-chunk-merge", () => {
  it("appends normal delta chunks", () => {
    expect(mergeStreamChunk("hello", " world")).toEqual({
      mode: "delta",
      full: "hello world",
      delta: " world",
    });
  });

  it("normalizes cumulative snapshot chunks into deltas", () => {
    expect(mergeStreamChunk("hello", "hello world")).toEqual({
      mode: "snapshot",
      full: "hello world",
      delta: " world",
    });
  });

  it("ignores duplicated chunks", () => {
    expect(mergeStreamChunk("hello world", "world")).toEqual({
      mode: "duplicate",
      full: "hello world",
      delta: "",
    });
  });

  it("keeps repeated middle substrings when they are a new delta, instead of dropping them", () => {
    expect(mergeStreamChunk("justify-content: center; align-items: stretch", " center")).toEqual({
      mode: "delta",
      full: "justify-content: center; align-items: stretch center",
      delta: " center",
    });
  });

  it("merges overlapping chunks without duplicating content", () => {
    expect(mergeStreamChunk("hello wor", "world")).toEqual({
      mode: "overlap",
      full: "hello world",
      delta: "ld",
    });
  });

  it("does not treat single-character numeric boundaries as overlap", () => {
    expect(mergeStreamChunk("width: 120", "0px")).toEqual({
      mode: "delta",
      full: "width: 1200px",
      delta: "0px",
    });
  });

  it("detects long prefix restarts and resets the canonical full text", () => {
    const previous = "这是一段已经写了很多很多内容的长文本，用于模拟模型流式输出中途重头开始。";
    const incoming = "这是一段已经写了很多很多内容";
    expect(mergeStreamChunk(previous, incoming)).toEqual({
      mode: "reset",
      full: incoming,
      delta: "",
    });
  });
});
