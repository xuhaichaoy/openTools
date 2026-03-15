import { describe, expect, it } from "vitest";

import type { Conversation } from "@/core/ai/types";

import { buildAskAgentHandoff } from "./ask-agent-handoff";

describe("buildAskAgentHandoff", () => {
  it("builds a handoff from the current conversation and deduplicates attachments", () => {
    const conversation: Conversation = {
      id: "conv-1",
      title: "demo",
      createdAt: 1,
      messages: [
        {
          id: "u1",
          role: "user",
          content: "请帮我看下这个项目",
          timestamp: 1,
          attachmentPaths: ["/tmp/demo.ts", "/tmp/project"],
          images: ["/tmp/diagram.png"],
        },
        {
          id: "a1",
          role: "assistant",
          content: "我先梳理一下结构",
          timestamp: 2,
          toolCalls: [
            {
              id: "tool-1",
              name: "read_file",
              arguments: "{\"path\":\"/tmp/demo.ts\"}",
            },
          ],
        },
        {
          id: "a2",
          role: "assistant",
          content: "streaming",
          timestamp: 3,
          streaming: true,
        },
      ],
    };

    expect(buildAskAgentHandoff(conversation)).toEqual(expect.objectContaining({
      query: [
        "以下是之前的对话上下文，并已附带相关图片、文件或目录，请基于此继续执行任务：",
        "",
        "[用户]: 请帮我看下这个项目",
        "  [图片]: 1 张",
        "[助手]: 我先梳理一下结构",
        "  [工具调用]: read_file",
      ].join("\n"),
      attachmentPaths: ["/tmp/demo.ts", "/tmp/project", "/tmp/diagram.png"],
      sourceMode: "ask",
      sourceSessionId: "conv-1",
      sourceLabel: "Ask 对话",
      summary: "Ask 对话上下文，附带 3 个文件/图片/目录",
      title: "延续 Ask 对话：demo",
      goal: "请帮我看下这个项目",
      intent: "coding",
      keyPoints: expect.arrayContaining(["带入最近 2 条 Ask 消息", "包含 3 个附件路径"]),
      nextSteps: expect.arrayContaining(["先阅读 Ask 对话与附件上下文，再继续处理任务"]),
      files: expect.arrayContaining([
        expect.objectContaining({ path: "/tmp/demo.ts", reason: "Ask 附件/目录上下文" }),
      ]),
    }));
  });

  it("returns null when there is no reusable conversation context", () => {
    expect(buildAskAgentHandoff(null)).toBeNull();
    expect(
      buildAskAgentHandoff({
        id: "conv-2",
        title: "empty",
        createdAt: 1,
        messages: [],
      }),
    ).toBeNull();
  });

  it("embeds recent attachment context snippets when available", () => {
    const handoff = buildAskAgentHandoff({
      id: "conv-3",
      title: "ctx",
      createdAt: 1,
      messages: [
        {
          id: "u1",
          role: "user",
          content: "继续分析",
          timestamp: 1,
          contextPrefix: "## 附件内容\nfoo.ts\nconst value = 1;",
        },
      ],
    });

    expect(handoff?.query).toContain("原始附件/目录上下文摘录");
    expect(handoff?.query).toContain("foo.ts");
  });
});
