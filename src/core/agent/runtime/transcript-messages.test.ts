import { describe, expect, it } from "vitest";
import {
  prepareTranscriptMessagesForResume,
  trimTranscriptMessagesToBudget,
  type RuntimeTranscriptMessage,
} from "./transcript-messages";

describe("transcript-messages", () => {
  it("removes unresolved tool calls, orphaned tool results, and whitespace-only assistant messages", () => {
    const messages: RuntimeTranscriptMessage[] = [
      {
        role: "user",
        content: "旧需求",
      },
      {
        role: "assistant",
        content: " \n ",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-drop",
            type: "function",
            function: {
              name: "read_file",
              arguments: "{\"path\":\"/tmp/drop.txt\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        content: "孤立结果",
        tool_call_id: "missing-parent",
        name: "read_file",
      },
      {
        role: "user",
        content: "补充说明",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-keep",
            type: "function",
            function: {
              name: "read_file",
              arguments: "{\"path\":\"/tmp/keep.txt\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        content: "保留结果",
        tool_call_id: "call-keep",
        name: "read_file",
      },
    ];

    expect(prepareTranscriptMessagesForResume(messages)).toEqual([
      {
        role: "user",
        content: "旧需求\n\n补充说明",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-keep",
            type: "function",
            function: {
              name: "read_file",
              arguments: "{\"path\":\"/tmp/keep.txt\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        content: "保留结果",
        tool_call_id: "call-keep",
        name: "read_file",
      },
    ]);
  });

  it("drops orphaned tool results introduced by budget trimming", () => {
    const trimmed = trimTranscriptMessagesToBudget(
      [
        {
          role: "user",
          content: "初始请求",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-heavy",
              type: "function",
              function: {
                name: "read_file",
                arguments: `{"path":"/tmp/demo.txt","padding":"${"x".repeat(2000)}"}`,
              },
            },
          ],
        },
        {
          role: "tool",
          content: "工具结果",
          tool_call_id: "call-heavy",
          name: "read_file",
        },
        {
          role: "user",
          content: "继续",
        },
      ] satisfies RuntimeTranscriptMessage[],
      40,
    );

    expect(trimmed).toEqual([
      {
        role: "user",
        content: "继续",
      },
    ]);
  });
});
