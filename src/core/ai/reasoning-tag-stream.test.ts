import { describe, expect, it } from "vitest";

import {
  AssistantReasoningStreamNormalizer,
  ReasoningTagStreamFilter,
  stripReasoningTagsFromText,
} from "./reasoning-tag-stream";

describe("ReasoningTagStreamFilter", () => {
  it("splits think tags into visible and thinking output", () => {
    const filter = new ReasoningTagStreamFilter();

    expect(filter.process("<think>Plan")).toEqual({
      visible: "",
      thinking: "Plan",
    });
    expect(filter.process(" A</think>Final answer")).toEqual({
      visible: "Final answer",
      thinking: " A",
    });
    expect(filter.flush()).toEqual({ visible: "", thinking: "" });
  });

  it("supports thinking and final tags in the same stream", () => {
    const filter = new ReasoningTagStreamFilter();

    expect(
      filter.process("<thinking>internal</thinking><final>shown</final>"),
    ).toEqual({
      visible: "shown",
      thinking: "internal",
    });
  });

  it("waits for partial tag prefixes across chunk boundaries", () => {
    const filter = new ReasoningTagStreamFilter();

    expect(filter.process("<thin")).toEqual({ visible: "", thinking: "" });
    expect(filter.process("king>trace</thinking>done")).toEqual({
      visible: "done",
      thinking: "trace",
    });
  });

  it("passes normal text through unchanged", () => {
    const filter = new ReasoningTagStreamFilter();

    expect(filter.process("plain response")).toEqual({
      visible: "plain response",
      thinking: "",
    });
    expect(filter.flush()).toEqual({ visible: "", thinking: "" });
  });

  it("does not treat code examples as reasoning tags", () => {
    const filter = new ReasoningTagStreamFilter();

    expect(
      filter.process("```xml\n<think>literal</think>\n```\n<think>trace"),
    ).toEqual({
      visible: "```xml\n<think>literal</think>\n```\n",
      thinking: "trace",
    });
    expect(filter.process("</think>done")).toEqual({
      visible: "done",
      thinking: "",
    });
  });
});

describe("stripReasoningTagsFromText", () => {
  it("strips real reasoning tags but preserves code snippets", () => {
    expect(
      stripReasoningTagsFromText(
        "Visible <think>hidden</think> text and `<think>literal</think>` code",
        { mode: "strict", trim: "none" },
      ),
    ).toBe("Visible  text and `<think>literal</think>` code");
  });

  it("keeps final tag contents while removing the wrapper", () => {
    expect(
      stripReasoningTagsFromText("<final>answer</final>", {
        mode: "strict",
        trim: "none",
      }),
    ).toBe("answer");
  });
});

describe("AssistantReasoningStreamNormalizer", () => {
  it("stops promoting tagged reasoning after native thinking starts", () => {
    const normalizer = new AssistantReasoningStreamNormalizer();

    expect(normalizer.processThinkingChunk("native trace")).toEqual({
      visible: "",
      thinking: "native trace",
    });
    expect(
      normalizer.processTextChunk("<think>duplicate</think>Answer <thin"),
    ).toEqual({
      visible: "Answer ",
      thinking: "",
    });
    expect(normalizer.flush()).toEqual({ visible: "", thinking: "" });
  });
});
