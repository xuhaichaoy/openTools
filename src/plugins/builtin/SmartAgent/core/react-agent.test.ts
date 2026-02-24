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
});
