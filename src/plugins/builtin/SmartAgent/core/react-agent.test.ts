import { describe, expect, it } from "vitest";
import type { MToolsAI, AIToolCall } from "@/core/plugin-system/plugin-interface";
import { ReActAgent, type AgentTool } from "./react-agent";

const noopTools: AgentTool[] = [
  {
    name: "noop",
    description: "noop",
    execute: async () => ({ ok: true }),
  },
];

function createMockAI(
  streamWithTools: NonNullable<MToolsAI["streamWithTools"]>,
): MToolsAI {
  return {
    chat: async () => ({
      content: "Thought: 文本降级\nFinal Answer: 文本模式回答",
    }),
    stream: async ({ onChunk, onDone }) => {
      const full = "Thought: 文本降级\nFinal Answer: 文本模式回答";
      onChunk(full);
      onDone?.(full);
    },
    streamWithTools,
    embedding: async () => [],
    getModels: async () => [],
  };
}

describe("ReActAgent FC compatibility cache", () => {
  it("should skip FC retry for same incompatible model key", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      const badToolCalls: AIToolCall[] = [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "",
            arguments: "{}",
          },
        },
      ];
      return {
        type: "tool_calls",
        toolCalls: badToolCalls,
      };
    });

    const key = "fc-cache-test-model-v1";

    const first = new ReActAgent(ai, noopTools, {
      maxIterations: 2,
      fcCompatibilityKey: key,
    });
    const firstAnswer = await first.run("first");
    expect(firstAnswer).toContain("文本模式回答");
    expect(fcCalls).toBe(1);

    const second = new ReActAgent(ai, noopTools, {
      maxIterations: 2,
      fcCompatibilityKey: key,
    });
    const secondAnswer = await second.run("second");
    expect(secondAnswer).toContain("文本模式回答");
    expect(fcCalls).toBe(1);

    const differentModel = new ReActAgent(ai, noopTools, {
      maxIterations: 2,
      fcCompatibilityKey: "fc-cache-test-model-v2",
    });
    await differentModel.run("third");
    expect(fcCalls).toBe(2);
  });

  it("should not accept fabricated refusal claim when no dangerous confirmation happened", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "content",
          content: "用户拒绝创建备忘录，因此我直接给出文本结果。",
        };
      }
      return {
        type: "content",
        content: "未触发授权拒绝，以下是正常执行结果。",
      };
    });

    const agent = new ReActAgent(ai, noopTools, {
      maxIterations: 4,
      fcCompatibilityKey: "fabricated-refusal-guard",
    });

    const answer = await agent.run("给我一个学习计划");

    expect(answer).toContain("未触发授权拒绝");
    expect(fcCalls).toBe(2);
  });

  it("should require write_file tool call before accepting file-save outcome claim", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "content",
          content: "操作已取消。文件内容保持不变。",
        };
      }
      return {
        type: "content",
        content: "已调用 write_file 并完成保存。",
      };
    });

    const agent = new ReActAgent(ai, noopTools, {
      maxIterations: 4,
      fcCompatibilityKey: "save-outcome-guard",
    });

    const answer = await agent.run("请把内容保存到 Downloads 下的 plan.md");

    expect(answer).toContain("write_file");
    expect(fcCalls).toBe(2);
  });

  it("should recover malformed write_file arguments with raw html content", async () => {
    let fcCalls = 0;
    let capturedPath = "";
    let capturedContent = "";

    const ai = createMockAI(async () => {
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-write-file",
              type: "function",
              function: {
                name: "write_file",
                arguments:
                  "{\"path\":\"/Users/haichao/Downloads/demo.html\",\"content\":\"<!doctype html>\n<html lang=\"zh-CN\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    <title>Demo</title>\n  </head>\n  <body>\n    <button class=\"cta\">Run</button>\n  </body>\n</html>\"}",
              },
            },
          ],
        };
      }

      return {
        type: "content",
        content: "已写入 demo.html",
      };
    });

    const tools: AgentTool[] = [
      {
        name: "write_file",
        description: "write",
        parameters: {
          path: { type: "string", description: "path" },
          content: { type: "string", description: "content" },
        },
        execute: async (params) => {
          capturedPath = String(params.path ?? "");
          capturedContent = String(params.content ?? "");
          return { ok: true, path: capturedPath };
        },
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      fcCompatibilityKey: "recover-malformed-write-file",
    });

    const answer = await agent.run("根据图片生成一个 html 页面并保存到 Downloads");

    expect(answer).toContain("已写入 demo.html");
    expect(capturedPath).toBe("/Users/haichao/Downloads/demo.html");
    expect(capturedContent).toContain('<meta charset="UTF-8" />');
    expect(capturedContent).toContain('<button class="cta">Run</button>');
    expect(fcCalls).toBe(2);
  });

  it("should replace restarted tool arg streams instead of appending from the beginning", async () => {
    let fcCalls = 0;
    const steps: Array<{ type: string; content: string; streaming?: boolean }> = [];
    const finalArgs =
      "{\"path\":\"/tmp/demo.html\",\"content\":\"<!doctype html>\\n<html lang=\\\"zh-CN\\\">\\n  <body>\\n    <div>ok</div>\\n  </body>\\n</html>\"}";

    const ai = createMockAI(async ({ onToolArgs }) => {
      fcCalls += 1;
      if (fcCalls === 1) {
        onToolArgs?.(
          "{\"path\":\"/tmp/demo.html\",\"content\":\"<!doctype html>\\n<html lang=\\\"zh-CN\\\">\\n  <body>\\n    <div>temporary tail that will be reset",
        );
        onToolArgs?.(
          "{\"path\":\"/tmp/demo.html\",\"content\":\"<!doctype html>\\n<html lang=\\\"zh-CN\\\">\\n  <body>",
        );
        onToolArgs?.(finalArgs);
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-write-file",
              type: "function",
              function: {
                name: "write_file",
                arguments: finalArgs,
              },
            },
          ],
        };
      }

      return {
        type: "content",
        content: "已写入 demo.html",
      };
    });

    const tools: AgentTool[] = [
      {
        name: "write_file",
        description: "write",
        parameters: {
          path: { type: "string", description: "path" },
          content: { type: "string", description: "content" },
        },
        execute: async () => ({ ok: true }),
      },
    ];

    const agent = new ReActAgent(
      ai,
      tools,
      {
        maxIterations: 4,
        fcCompatibilityKey: "replace-restarted-tool-args",
      },
      (step) => {
        steps.push({
          type: step.type,
          content: step.content,
          streaming: step.streaming,
        });
      },
    );

    const answer = await agent.run("保存 demo.html");

    expect(answer).toContain("已写入 demo.html");
    const lastToolStep = steps.filter((step) => step.type === "tool_streaming").at(-1);
    expect(lastToolStep?.content).toBe(finalArgs);
    expect(lastToolStep?.content.match(/<!doctype html>/gi)?.length ?? 0).toBe(1);
    expect(lastToolStep?.content).not.toContain("temporary tail");
  });

  it("should not downgrade or cache on generic FC execution errors", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      throw new Error("unexpected schema mismatch");
    });

    const key = "fc-generic-error";

    const first = new ReActAgent(ai, noopTools, {
      maxIterations: 2,
      fcCompatibilityKey: key,
    });

    await expect(first.run("first")).rejects.toThrow("unexpected schema mismatch");
    expect(fcCalls).toBe(1);

    const second = new ReActAgent(ai, noopTools, {
      maxIterations: 2,
      fcCompatibilityKey: key,
    });

    await expect(second.run("second")).rejects.toThrow("unexpected schema mismatch");
    expect(fcCalls).toBe(2);
  });

  it("should downgrade and cache when provider explicitly reports tool incompatibility", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      throw new Error("tools are not supported for this model");
    });

    const key = "fc-provider-incompatible";

    const first = new ReActAgent(ai, noopTools, {
      maxIterations: 2,
      fcCompatibilityKey: key,
    });
    const firstAnswer = await first.run("first");
    expect(firstAnswer).toContain("文本模式回答");
    expect(fcCalls).toBe(1);

    const second = new ReActAgent(ai, noopTools, {
      maxIterations: 2,
      fcCompatibilityKey: key,
    });
    const secondAnswer = await second.run("second");
    expect(secondAnswer).toContain("文本模式回答");
    expect(fcCalls).toBe(1);
  });

  it("should not treat calculate output as final answer for concrete artifact tasks", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-calculate",
              type: "function",
              function: {
                name: "calculate",
                arguments: "{\"expression\":\"10+20\"}",
              },
            },
          ],
        };
      }

      return {
        type: "content",
        content: "已继续执行页面生成任务，并准备输出真实文件结果。",
      };
    });

    const tools: AgentTool[] = [
      {
        name: "calculate",
        description: "math",
        parameters: {
          expression: { type: "string", description: "expression" },
        },
        execute: async () => ({ expression: "10+20", result: 30 }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      fcCompatibilityKey: "calculate-not-final-for-artifacts",
    });

    const answer = await agent.run("根据图片生成一个 html 页面并保存到 Downloads");

    expect(answer).toContain("继续执行页面生成任务");
    expect(answer).not.toContain("10+20 = 30");
    expect(fcCalls).toBe(2);
  });

  it("should preserve the latest visual context while pruning older image turns", async () => {
    let fcCalls = 0;
    const snapshots: Array<Array<{ role: string; content: string | null; images?: string[]; name?: string }>> = [];
    let drained = false;

    const ai = createMockAI(async ({ messages }) => {
      snapshots.push(
        messages.map((message) => ({
          role: message.role,
          content: message.content,
          name: message.name,
          ...(message.images?.length ? { images: [...message.images] } : {}),
        })),
      );
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-noop-image",
              type: "function",
              function: {
                name: "noop",
                arguments: "{}",
              },
            },
          ],
        };
      }
      return {
        type: "content",
        content: "图片信息已处理完成。",
      };
    });

    const agent = new ReActAgent(ai, noopTools, {
      maxIterations: 4,
      fcCompatibilityKey: "prune-processed-images",
      inboxDrain: () => {
        if (drained) return [];
        drained = true;
        return [
          {
            id: "msg-image-update",
            from: "Coordinator",
            content: "补充一张更新后的设计稿，请以这张为准。",
            images: ["/tmp/revised-design.png"],
          },
        ];
      },
    });

    const answer = await agent.run("请根据这张图继续分析", undefined, ["/tmp/demo.png"]);

    expect(answer).toContain("图片信息已处理完成");
    expect(fcCalls).toBe(2);
    const firstRoundImageMessages = snapshots[0].filter((message) => message.role === "user" && message.images?.length);
    expect(firstRoundImageMessages).toHaveLength(1);
    expect(firstRoundImageMessages[0]?.images).toEqual(["/tmp/revised-design.png"]);

    const secondRoundImageMessages = snapshots[1].filter((message) => message.role === "user" && message.images?.length);
    expect(secondRoundImageMessages).toHaveLength(1);
    expect(secondRoundImageMessages[0]?.images).toEqual(["/tmp/revised-design.png"]);
    const prunedUserMessage = snapshots[1].find(
      (message) => message.role === "user" && typeof message.content === "string" && message.content.includes("历史图片已处理"),
    );
    expect(prunedUserMessage?.content).toContain("无需重复发送原图");
  });

  it("should compact oversized tool outputs before sending the next FC round", async () => {
    let fcCalls = 0;
    const snapshots: Array<Array<{ role: string; content: string | null; name?: string }>> = [];
    const hugeOutputA = `A-start\n${"A".repeat(9000)}\nA-end`;

    const ai = createMockAI(async ({ messages }) => {
      snapshots.push(
        messages.map((message) => ({
          role: message.role,
          content: message.content,
          name: message.name,
        })),
      );
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-big-1",
              type: "function",
              function: {
                name: "big_tool",
                arguments: "{\"label\":\"first\"}",
              },
            },
          ],
        };
      }
      return {
        type: "content",
        content: "工具输出已经压缩后继续执行。",
      };
    });

    const tools: AgentTool[] = [
      {
        name: "big_tool",
        description: "return huge output",
        parameters: {
          label: { type: "string", description: "label" },
        },
        execute: async () => hugeOutputA,
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      contextLimit: 1600,
      fcCompatibilityKey: "tool-output-context-guard",
    });

    const answer = await agent.run("请继续处理大段工具输出");

    expect(answer).toContain("压缩后继续执行");
    expect(fcCalls).toBe(2);

    const finalRoundToolMessages = snapshots[1].filter((message) => message.role === "tool");
    expect(finalRoundToolMessages).toHaveLength(1);
    expect(
      finalRoundToolMessages[0].content?.includes("按上下文预算压缩")
      || finalRoundToolMessages[0].content?.includes("已移出上下文"),
    ).toBe(true);
    expect(finalRoundToolMessages[0].content?.length ?? 0).toBeLessThan(2200);
    expect(finalRoundToolMessages[0].content).not.toBe(hugeOutputA);
  });

  it("should preserve inbox message images in FC rounds", async () => {
    const snapshots: Array<Array<{ role: string; content: string | null; images?: string[] }>> = [];
    let drained = false;

    const ai = createMockAI(async ({ messages }) => {
      snapshots.push(
        messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.images?.length ? { images: [...message.images] } : {}),
        })),
      );
      return {
        type: "content",
        content: "我已经读取到收件箱里的图片消息。",
      };
    });

    const agent = new ReActAgent(ai, noopTools, {
      maxIterations: 2,
      fcCompatibilityKey: "inbox-image-forwarding",
      inboxDrain: () => {
        if (drained) return [];
        drained = true;
        return [
          {
            id: "msg-1",
            from: "Coordinator",
            content: "请参考这张界面图继续实现页面。",
            images: ["/tmp/design-shot.png"],
          },
        ];
      },
    });

    const answer = await agent.run("继续当前任务");

    expect(answer).toContain("读取到收件箱里的图片消息");
    const inboxImageMessage = snapshots[0]?.find(
      (message) => message.role === "user"
        && typeof message.content === "string"
        && message.content.includes("[收件箱消息]")
        && message.images?.length,
    );
    expect(inboxImageMessage?.images).toEqual(["/tmp/design-shot.png"]);
  });
});
