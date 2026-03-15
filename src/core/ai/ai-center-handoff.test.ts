import { describe, expect, it } from "vitest";

import {
  buildAICenterHandoffFileRefs,
  describeAICenterHandoffIntent,
  normalizeAICenterHandoff,
} from "./ai-center-handoff";

describe("ai-center-handoff", () => {
  it("normalizes and deduplicates structured handoff fields", () => {
    const handoff = normalizeAICenterHandoff({
      query: "  继续处理这个任务  ",
      attachmentPaths: ["/tmp/a.ts", "/tmp/a.ts", " "],
      title: "  从 Ask 接力  ",
      goal: "  完成最终落地  ",
      intent: "delivery",
      keyPoints: ["A", "A", "  ", "B"],
      nextSteps: ["先读上下文", "先读上下文", "再继续"],
      contextSections: [
        { title: "  结论  ", items: ["发现 1", "发现 1", "发现 2"] },
        { title: "空", items: [] },
      ],
      files: [
        { path: "/tmp/a.ts", label: "a.ts", reason: "主文件", lineStart: 10, lineEnd: 20 },
        { path: "/tmp/a.ts", label: "dup.ts" },
      ],
      sourceMode: "ask",
      sourceSessionId: " conv-1 ",
      sourceLabel: " Ask ",
      summary: " 已带入上下文 ",
    });

    expect(handoff).toEqual({
      query: "继续处理这个任务",
      attachmentPaths: ["/tmp/a.ts"],
      title: "从 Ask 接力",
      goal: "完成最终落地",
      intent: "delivery",
      keyPoints: ["A", "B"],
      nextSteps: ["先读上下文", "再继续"],
      contextSections: [
        { title: "结论", items: ["发现 1", "发现 2"] },
      ],
      files: [
        { path: "/tmp/a.ts", label: "a.ts", reason: "主文件", lineStart: 10, lineEnd: 20 },
      ],
      sourceMode: "ask",
      sourceSessionId: "conv-1",
      sourceLabel: "Ask",
      summary: "已带入上下文",
    });
  });

  it("builds file refs and labels intent", () => {
    expect(buildAICenterHandoffFileRefs(["/tmp/demo.ts"], "上下文")).toEqual([
      { path: "/tmp/demo.ts", label: "demo.ts", reason: "上下文" },
    ]);
    expect(describeAICenterHandoffIntent("coding")).toBe("编码任务");
    expect(describeAICenterHandoffIntent(undefined)).toBeNull();
  });
});
