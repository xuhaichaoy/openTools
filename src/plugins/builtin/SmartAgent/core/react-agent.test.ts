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
  it("respects authoritative tool lists without auto-injecting delegate or mode tools", () => {
    const ai = createMockAI(async () => ({
      type: "content",
      content: "done",
    }));

    const tools: AgentTool[] = [
      {
        name: "task_done",
        description: "done",
        execute: async () => ({ ok: true }),
      },
      {
        name: "export_spreadsheet",
        description: "export",
        parameters: {
          file_name: { type: "string", description: "file" },
          sheets: { type: "string", description: "sheets" },
        },
        execute: async () => ({ ok: true }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 2,
      fcCompatibilityKey: "authoritative-tool-list",
      authoritativeToolList: true,
    });

    const toolNames = (agent as unknown as {
      getAvailableTools(): AgentTool[];
    }).getAvailableTools().map((tool) => tool.name);

    expect(toolNames).toEqual(["task_done", "export_spreadsheet"]);
    expect(toolNames).not.toContain("delegate_subtask");
    expect(toolNames).not.toContain("enter_plan_mode");
    expect(toolNames).not.toContain("exit_plan_mode");
  });

  it("should not expose delegate_subtask when managed dialog delegation tools exist", () => {
    const ai = createMockAI(async () => ({
      type: "content",
      content: "done",
    }));

    const tools: AgentTool[] = [
      ...noopTools,
      {
        name: "spawn_task",
        description: "spawn task",
        execute: async () => ({ status: "queued" }),
      },
      {
        name: "wait_for_spawned_tasks",
        description: "wait spawned tasks",
        execute: async () => ({ status: "waiting" }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 2,
      fcCompatibilityKey: "managed-dialog-delegation-tools",
    });

    const toolNames = (agent as unknown as {
      getAvailableTools(): AgentTool[];
    }).getAvailableTools().map((tool) => tool.name);

    expect(toolNames).toContain("spawn_task");
    expect(toolNames).toContain("wait_for_spawned_tasks");
    expect(toolNames).not.toContain("delegate_subtask");
  });

  it("should not trigger memory recall correction from wrapped system planning text alone", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      return {
        type: "content",
        content: "天津未来一周以晴到多云为主。",
      };
    });

    const tools: AgentTool[] = [
      {
        name: "memory_search",
        description: "memory search",
        execute: async () => ({ results: [] }),
      },
      {
        name: "memory_get",
        description: "memory get",
        execute: async () => ({ content: "" }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      fcCompatibilityKey: "wrapped-system-text-should-not-trigger-memory-recall",
    });

    const answer = await agent.run([
      "[用户]: 未来一周 天津 天气",
      "",
      "[system]: [已批准协作计划 / 内部指令]",
      "请先决定如何分工，再继续执行。",
      "执行时注意 review、进度、方案与决策收敛。",
    ].join("\n"));

    expect(answer).toContain("天津未来一周");
    expect(fcCalls).toBe(1);
  });

  it("should still enforce memory recall for wrapped memory questions", async () => {
    let fcCalls = 0;
    let memorySearchCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "content",
          content: "你在北京。",
        };
      }
      if (fcCalls === 2) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-memory-search",
              type: "function",
              function: {
                name: "memory_search",
                arguments: "{\"query\":\"我在哪个城市\"}",
              },
            },
          ],
        };
      }
      return {
        type: "content",
        content: "已检查记忆，你所在城市是北京。",
      };
    });

    const tools: AgentTool[] = [
      {
        name: "memory_search",
        description: "memory search",
        parameters: {
          query: { type: "string", description: "query" },
        },
        execute: async () => {
          memorySearchCalls += 1;
          return {
            results: [
              {
                path: "MEMORY.md",
                snippet: "用户所在城市：北京",
              },
            ],
          };
        },
      },
      {
        name: "memory_get",
        description: "memory get",
        execute: async () => ({ content: "用户所在城市：北京" }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 5,
      fcCompatibilityKey: "wrapped-memory-question-should-still-recall",
    });

    const answer = await agent.run([
      "[用户]: 还记得我在哪个城市吗？",
      "",
      "[system]: [已批准协作计划 / 内部指令]",
      "请先决定如何分工，再继续执行。",
    ].join("\n"));

    expect(answer).toContain("已检查记忆");
    expect(memorySearchCalls).toBe(1);
    expect(fcCalls).toBe(3);
  });

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

  it("should allow direct user questions when ask_user tool is unavailable", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      return {
        type: "content",
        content: "要继续接入飞书，我还缺少你的 appId。请直接发我 appId。",
      };
    });

    const agent = new ReActAgent(ai, noopTools, {
      maxIterations: 3,
      fcCompatibilityKey: "external-im-direct-question-without-ask-user",
    });

    const answer = await agent.run("继续完成飞书渠道接入");

    expect(answer).toContain("请直接发我 appId");
    expect(fcCalls).toBe(1);
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

  it("should finish immediately after export_document succeeds for docx saves", async () => {
    let fcCalls = 0;
    let capturedPath = "";
    let capturedContent = "";

    const ai = createMockAI(async () => {
      fcCalls += 1;
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: "call-export-document",
            type: "function",
            function: {
              name: "export_document",
              arguments: JSON.stringify({
                path: "/Users/haichao/Downloads/1.docx",
                content: "# 课程方案\n\n- 模块一：运营方法论",
                title: "课程方案",
              }),
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "export_document",
        description: "export docx",
        parameters: {
          path: { type: "string", description: "path" },
          content: { type: "string", description: "content" },
          title: { type: "string", description: "title", required: false },
        },
        execute: async (params) => {
          capturedPath = String(params.path ?? "");
          capturedContent = String(params.content ?? "");
          return { path: capturedPath, format: "docx" };
        },
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      fcCompatibilityKey: "export-document-quick-answer",
    });

    const answer = await agent.run("将课程方案保存为 Word 到 Downloads/1.docx");

    expect(answer).toContain("已导出Word 文档到 /Users/haichao/Downloads/1.docx");
    expect(capturedPath).toBe("/Users/haichao/Downloads/1.docx");
    expect(capturedContent).toContain("课程方案");
    expect(fcCalls).toBe(1);
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

  it("should not surface generic tool arg streams as UI tool_streaming steps", async () => {
    const steps: Array<{ type: string; content: string; streaming?: boolean }> = [];

    const ai = createMockAI(async ({ onToolArgs }) => {
      onToolArgs?.("{\"summary\":\"先给出 15-20 门课程列表\"}");
      onToolArgs?.("{\"summary\":\"先给出 15-20 门课程列表，并导出 Excel\"}");
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: "call-task-done",
            type: "function",
            function: {
              name: "task_done",
              arguments: "{\"summary\":\"已整理课程列表并准备导出 Excel\"}",
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "task_done",
        description: "finish task",
        parameters: {
          summary: { type: "string", description: "summary" },
        },
        execute: async (params) => ({
          ok: true,
          summary: String(params.summary ?? ""),
        }),
      },
    ];

    const agent = new ReActAgent(
      ai,
      tools,
      {
        maxIterations: 2,
        fcCompatibilityKey: "hide-generic-tool-args-preview",
      },
      (step) => {
        steps.push({
          type: step.type,
          content: step.content,
          streaming: step.streaming,
        });
      },
    );

    const answer = await agent.run("生成课程列表并导出 Excel");

    expect(answer).toContain("课程列表");
    expect(steps.some((step) => step.type === "tool_streaming")).toBe(false);
  });

  it("should flush the final streamed answer before task_done uses it", async () => {
    const steps: Array<{ type: string; content: string; streaming?: boolean }> = [];

    const ai = createMockAI(async ({ onChunk }) => {
      onChunk("页面主容器宽度设置为 120");
      onChunk("0px");
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: "call-task-done",
            type: "function",
            function: {
              name: "task_done",
              arguments: "{\"summary\":\"页面主容器宽度设置为 1200px\"}",
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "task_done",
        description: "finish task",
        parameters: {
          summary: { type: "string", description: "summary" },
        },
        execute: async (params) => ({
          ok: true,
          summary: String(params.summary ?? ""),
        }),
      },
    ];

    const agent = new ReActAgent(
      ai,
      tools,
      {
        maxIterations: 2,
        fcCompatibilityKey: "flush-final-streaming-answer",
      },
      (step) => {
        steps.push({
          type: step.type,
          content: step.content,
          streaming: step.streaming,
        });
      },
    );

    const answer = await agent.run("把页面主容器宽度改成 1200px");

    expect(answer).toContain("1200px");
    const finalStreamingAnswer = steps
      .filter((step) => step.type === "answer" && step.streaming)
      .at(-1);
    expect(finalStreamingAnswer?.content).toContain("1200px");
  });

  it("should prefer task_done summary when it preserves the user's full numeric intent", async () => {
    const ai = createMockAI(async ({ onChunk }) => {
      onChunk("文件主容器宽度是 100px，不需要修改。");
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: "call-task-done",
            type: "function",
            function: {
              name: "task_done",
              arguments: "{\"summary\":\"文件主容器宽度是 1000px，不需要修改。\"}",
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "task_done",
        description: "finish task",
        parameters: {
          summary: { type: "string", description: "summary" },
        },
        execute: async (params) => ({
          status: "done",
          summary: String(params.summary ?? ""),
        }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 2,
      fcCompatibilityKey: "prefer-task-done-summary-for-precise-numbers",
    });

    const answer = await agent.run("确认页面主容器是不是 1000px");

    expect(answer).toContain("1000px");
    expect(answer).not.toContain("100px，不需要修改");
  });

  it("should prefer explicit task_done result for structured content delivery", async () => {
    const ai = createMockAI(async ({ onChunk }) => {
      onChunk("已先整理出课程候选。");
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: "call-task-done-structured-result",
            type: "function",
            function: {
              name: "task_done",
              arguments: JSON.stringify({
                summary: "已生成 2 门课程候选",
                result: JSON.stringify([
                  { 课程名称: "智能体工程化开发实战", 课程介绍: "覆盖开发、评测与部署。" },
                  { 课程名称: "RAG 知识库构建与检索优化", 课程介绍: "覆盖索引、召回与检索优化。" },
                ]),
              }),
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "task_done",
        description: "finish task",
        parameters: {
          summary: { type: "string", description: "summary" },
          result: { type: "string", description: "result" },
          answer: { type: "string", description: "answer" },
        },
        execute: async (params) => ({
          status: "done",
          summary: String(params.summary ?? ""),
        }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 2,
      fcCompatibilityKey: "prefer-task-done-explicit-structured-result",
    });

    const answer = await agent.run("基于主题生成课程候选，直接返回结构化 JSON");

    expect(answer).toContain("课程名称");
    expect(answer).toContain("智能体工程化开发实战");
    expect(answer.trim().startsWith("[")).toBe(true);
  });

  it("should stop immediately after task_done without forcing memory recall correction", async () => {
    let fcCalls = 0;
    let memorySearchCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: "call-task-done-memory",
            type: "function",
            function: {
              name: "task_done",
              arguments: "{\"summary\":\"我记得你在北京。\"}",
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "task_done",
        description: "finish task",
        parameters: {
          summary: { type: "string", description: "summary" },
        },
        execute: async (params) => ({
          status: "done",
          summary: String(params.summary ?? ""),
        }),
      },
      {
        name: "memory_search",
        description: "memory search",
        parameters: {
          query: { type: "string", description: "query" },
        },
        execute: async () => {
          memorySearchCalls += 1;
          return { results: [] };
        },
      },
      {
        name: "memory_get",
        description: "memory get",
        execute: async () => ({ content: "" }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      fcCompatibilityKey: "task-done-hard-stop-no-memory-correction",
    });

    const answer = await agent.run("还记得我在哪个城市吗？");

    expect(answer).toContain("北京");
    expect(fcCalls).toBe(1);
    expect(memorySearchCalls).toBe(0);
  });

  it("should treat non-zero run_shell_command exits as tool failures", async () => {
    const traceEvents: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-run-shell",
              type: "function",
              function: {
                name: "run_shell_command",
                arguments: "{\"command\":\"bad-command\"}",
              },
            },
          ],
        };
      }
      return {
        type: "content",
        content: "命令执行失败，已停止继续重试。",
      };
    });

    const tools: AgentTool[] = [
      {
        name: "run_shell_command",
        description: "run shell command",
        parameters: {
          command: { type: "string", description: "command" },
        },
        execute: async () => ({
          exit_code: 127,
          stdout: "",
          stderr: "sh: bad-command: command not found",
        }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 3,
      fcCompatibilityKey: "non-zero-shell-is-failure",
      onTraceEvent: (event, detail) => {
        traceEvents.push({ event, detail });
      },
    });

    const answer = await agent.run("执行 bad-command");

    expect(answer).toContain("命令执行失败");
    expect(traceEvents.some(({ event, detail }) => event === "tool_call_failed" && detail?.tool === "run_shell_command")).toBe(true);
  });

  it("emits tool_call_dropped when a repeated tool call is satisfied from cache", async () => {
    const traceEvents: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    let fcCalls = 0;
    let executeCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      if (fcCalls === 1 || fcCalls === 3) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: `call-list-${fcCalls}`,
              type: "function",
              function: {
                name: "list_directory",
                arguments: "{\"path\":\"/tmp/demo\"}",
              },
            },
          ],
        };
      }
      if (fcCalls === 2) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-calculate",
              type: "function",
              function: {
                name: "calculate",
                arguments: "{\"expression\":\"1+1\"}",
              },
            },
          ],
        };
      }
      return {
        type: "content",
        content: "目录结果已确认，无需再次执行。",
      };
    });

    const tools: AgentTool[] = [
      {
        name: "list_directory",
        description: "list directory",
        parameters: {
          path: { type: "string", description: "path" },
        },
        readonly: true,
        execute: async () => {
          executeCalls += 1;
          return "a.txt\nb.txt";
        },
      },
      {
        name: "calculate",
        description: "calculate",
        parameters: {
          expression: { type: "string", description: "expression" },
        },
        readonly: true,
        execute: async () => "2",
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      fcCompatibilityKey: "tool-call-dropped-cache",
      onTraceEvent: (event, detail) => {
        traceEvents.push({ event, detail });
      },
    });

    const answer = await agent.run("列出 /tmp/demo 目录");

    expect(answer).toContain("无需再次执行");
    expect(executeCalls).toBe(1);
    expect(traceEvents.some(({ event, detail }) => (
      event === "tool_call_dropped"
      && detail?.tool === "list_directory"
      && detail?.status === "cached"
    ))).toBe(true);
  });

  it("parses multiline text-mode spreadsheet action input without collapsing to empty params", async () => {
    let textCalls = 0;
    let capturedFileName = "";
    let capturedSheets = "";
    const ai: MToolsAI = {
      chat: async () => ({ content: "" }),
      stream: async ({ onChunk, onDone }) => {
        textCalls += 1;
        const full = textCalls === 1
          ? `Thought: 我先直接导出 Excel。\nAction: export_spreadsheet\nAction Input:\n\`\`\`json\n{\n  "file_name": "AI培训课程需求_课程生成结果.xlsx",\n  "sheets": "[{\\"name\\":\\"课程清单\\",\\"headers\\":[\\"课程名称\\",\\"课程介绍\\"],\\"rows\\":[[\\"课程A\\",\\"介绍A\\"],[\\"课程B\\",\\"介绍B\\"]]}]"\n}\n\`\`\``
          : "Thought: 导出已完成。\nFinal Answer: 已导出 Excel 文件。";
        onChunk(full);
        onDone?.(full);
      },
      streamWithTools: async () => ({ type: "content", content: "" }),
      embedding: async () => [],
      getModels: async () => [],
    };

    const tools: AgentTool[] = [
      {
        name: "export_spreadsheet",
        description: "export",
        parameters: {
          file_name: { type: "string", description: "file" },
          sheets: { type: "string", description: "sheets" },
        },
        execute: async (params) => {
          capturedFileName = String(params.file_name ?? "");
          capturedSheets = String(params.sheets ?? "");
          return "已导出 Excel 文件: /Users/haichao/Downloads/AI培训课程需求_课程生成结果.xlsx";
        },
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      forceTextMode: true,
      authoritativeToolList: true,
      fcCompatibilityKey: "text-mode-export-spreadsheet-json",
    });

    const answer = await agent.run("根据课程数据导出 Excel");

    expect(answer).toContain("已导出 Excel 文件");
    expect(capturedFileName).toBe("AI培训课程需求_课程生成结果.xlsx");
    expect(capturedSheets).toContain("\"课程清单\"");
    expect(capturedSheets).toContain("\"课程A\"");
  });

  it("should append generate_suggestions output without forcing a third model round", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async ({ onChunk }) => {
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "call-manage-skills",
              type: "function",
              function: {
                name: "manage_skills",
                arguments: "{\"action\":\"list\"}",
              },
            },
          ],
        };
      }

      onChunk("## 当前技能列表\n\n共有 **11 个技能**，全部已启用。");
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: "call-generate-suggestions",
            type: "function",
            function: {
              name: "generate_suggestions",
              arguments:
                "{\"context_summary\":\"用户查看了技能列表\",\"suggestions\":\"[{\\\"text\\\":\\\"查看某个技能的详细内容\\\",\\\"type\\\":\\\"question\\\"}]\"}",
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "manage_skills",
        description: "list skills",
        parameters: {
          action: { type: "string", description: "action" },
        },
        execute: async () => ({
          skills: [{ id: "skill-1", name: "天气查询助手" }],
          total: 1,
        }),
      },
      {
        name: "generate_suggestions",
        description: "generate suggestions",
        parameters: {
          context_summary: { type: "string", description: "summary" },
          suggestions: { type: "string", description: "suggestions" },
        },
        execute: async () => ({
          display: "\n---\n**你可能还想了解：**\n💡 1. 查看某个技能的详细内容",
          suggestions: [{ text: "查看某个技能的详细内容", type: "question" }],
        }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 4,
      fcCompatibilityKey: "append-generate-suggestions-without-rerun",
    });

    const answer = await agent.run("现在都有什么技能了");

    expect(answer).toContain("当前技能列表");
    expect(answer).toContain("你可能还想了解");
    expect(answer).toContain("查看某个技能的详细内容");
    expect(fcCalls).toBe(2);
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

  it("should stop early when downgraded text mode keeps returning empty content", async () => {
    let fcCalls = 0;
    let streamCalls = 0;
    let chatCalls = 0;

    const ai: MToolsAI = {
      chat: async () => {
        chatCalls += 1;
        return { content: "" };
      },
      stream: async ({ onDone }) => {
        streamCalls += 1;
        onDone?.("");
      },
      streamWithTools: async () => {
        fcCalls += 1;
        throw new Error("FC_INCOMPATIBLE: ai_agent_stream 返回空响应（无 chunk 且无 tool_calls）");
      },
      embedding: async () => [],
      getModels: async () => [],
    };

    const agent = new ReActAgent(ai, noopTools, {
      maxIterations: 10,
      fcCompatibilityKey: "downgrade-text-empty-stop",
    });

    const answer = await agent.run("根据上传的 xlsx 生成课程方案");

    expect(answer).toContain("模型连续未返回有效内容");
    expect(answer).toContain("实际运行轮数：3 / 10");
    expect(answer).not.toContain("已达到最大执行步数（10 步）");
    expect(fcCalls).toBe(1);
    expect(streamCalls).toBe(3);
    expect(chatCalls).toBe(3);
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

  it("should include structured diagnostics when FC stops due to repeated tool calls", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "repeat-search",
              type: "function",
              function: {
                name: "memory_search",
                arguments: "{\"query\":\"baidu devtools\"}",
              },
            },
          ],
        };
      }
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: `repeat-${fcCalls}`,
            type: "function",
            function: {
              name: "noop",
              arguments: "{\"tag\":\"same\"}",
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "noop",
        description: "noop",
        parameters: {
          tag: { type: "string", description: "tag" },
        },
        execute: async () => ({ ok: true }),
      },
      {
        name: "memory_search",
        description: "memory search",
        parameters: {
          query: { type: "string", description: "query" },
        },
        execute: async () => ({ results: [] }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 6,
      fcCompatibilityKey: "iteration-diagnostics-repeat-tools",
    });

    const answer = await agent.run("继续处理当前任务");

    expect(answer).toContain("执行已提前停止：检测到连续重复的 tool_calls 计划（最大 6 步）。");
    expect(answer).toContain("执行诊断：");
    expect(answer).toContain("实际运行轮数：4 / 6");
    expect(answer).toContain("轮数定义：1 轮 = 1 次模型决策（返回回答或 tool_calls），不等于 1 次工具执行");
    expect(answer).toContain("停止原因：连续 2 轮 tool_calls 计划完全相同");
    expect(answer).toContain("工具执行次数：2");
    expect(answer).toContain("重复工具模式：noop");
  });

  it("should give the model one chance to self-correct repeated tool calls", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async ({ messages }) => {
      const hasCorrectionPrompt = messages.some((message) =>
        message.role === "user"
        && typeof message.content === "string"
        && message.content.includes("不要再次提交完全相同的 tool_calls 计划"),
      );
      if (hasCorrectionPrompt) {
        return {
          type: "content",
          content: "我不会再重复调用了。基于现有结果，页面已经创建成功，接下来应直接访问或总结。",
        };
      }

      fcCalls += 1;
      if (fcCalls === 1) {
        return {
          type: "tool_calls",
          toolCalls: [
            {
              id: "recover-search",
              type: "function",
              function: {
                name: "memory_search",
                arguments: "{\"query\":\"baidu devtools\"}",
              },
            },
          ],
        };
      }
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: `recover-repeat-${fcCalls}`,
            type: "function",
            function: {
              name: "noop",
              arguments: "{\"tag\":\"same\"}",
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "noop",
        description: "noop",
        parameters: {
          tag: { type: "string", description: "tag" },
        },
        execute: async () => ({ ok: true }),
      },
      {
        name: "memory_search",
        description: "memory search",
        parameters: {
          query: { type: "string", description: "query" },
        },
        execute: async () => ({ results: [] }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 6,
      fcCompatibilityKey: "iteration-diagnostics-repeat-tools-recover",
    });

    const answer = await agent.run("继续处理当前任务");

    expect(answer).toContain("不会再重复调用");
    expect(answer).not.toContain("执行诊断：");
  });

  it("should include structured diagnostics when FC truly reaches the iteration limit", async () => {
    let fcCalls = 0;
    const ai = createMockAI(async () => {
      fcCalls += 1;
      return {
        type: "tool_calls",
        toolCalls: [
          {
            id: `limit-${fcCalls}`,
            type: "function",
            function: {
              name: "noop",
              arguments: `{"tag":"${fcCalls}"}`,
            },
          },
        ],
      };
    });

    const tools: AgentTool[] = [
      {
        name: "noop",
        description: "noop",
        parameters: {
          tag: { type: "string", description: "tag" },
        },
        execute: async () => ({ ok: true }),
      },
    ];

    const agent = new ReActAgent(ai, tools, {
      maxIterations: 2,
      fcCompatibilityKey: "iteration-diagnostics-true-limit",
    });

    const answer = await agent.run("继续处理当前任务");

    expect(answer).toContain("已达到最大执行步数（2 步）。");
    expect(answer).toContain("执行诊断：");
    expect(answer).toContain("实际运行轮数：2 / 2");
    expect(answer).toContain("轮数定义：1 轮 = 1 次模型决策（返回回答或 tool_calls），不等于 1 次工具执行");
    expect(answer).toContain("停止原因：已达到迭代上限");
    expect(answer).toContain("工具执行次数：2");
  });
});
