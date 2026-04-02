import { describe, expect, it, vi } from "vitest";

const aiFns = vi.hoisted(() => ({
  getMToolsAI: vi.fn(() => ({ streamWithTools: vi.fn() })),
}));

vi.mock("@/core/ai/mtools-ai", () => ({
  getMToolsAI: aiFns.getMToolsAI,
}));

import { QueryEngine } from "./query-engine";

describe("QueryEngine", () => {
  it("runs middleware, surfaces visible tools, and preserves drained inbox state", async () => {
    const onMiddlewareCompleted = vi.fn();
    const onVisibleToolNames = vi.fn();
    const runMiddlewares = vi.fn(async (_middlewares, ctx) => {
      ctx.tools = [{ name: "task_done", description: "", execute: vi.fn(async () => "ok") }];
      ctx.skillsPrompt = "skills";
      ctx.userMemoryPrompt = "memory";
      ctx.withRetry = vi.fn(async (fn) => fn());
      ctx.retryConfig = {
        maxRetries: 1,
        initialDelayMs: 1,
        maxDelayMs: 2,
        backoffMultiplier: 2,
        fallbackModels: [],
        toolTimeoutMs: 1000,
      };
    });
    const createAgent = vi.fn((_ai, _tools, config) => ({
      listVisibleToolNames: () => ["task_done"],
      run: async () => {
        const drained = config.inboxDrain?.() ?? [];
        expect(drained[0]?.from).toBe("用户");
        return "kernel result";
      },
    }));
    const engine = new QueryEngine({
      productMode: "dialog",
      temperature: 0.7,
      middlewares: [],
      runMiddlewares,
      createAgent,
      drainInbox: () => [{
        id: "msg-1",
        from: "user",
        content: "补充说明",
        images: ["/tmp/follow-up.png"],
      }],
      resolveInboxSenderName: (from) => (from === "user" ? "用户" : from),
      onMiddlewareCompleted,
      onVisibleToolNames,
    });

    const result = await engine.run({
      query: "处理任务",
      images: ["/tmp/original.png"],
      signal: new AbortController().signal,
      retryLabel: "LLM call for Lead",
      createRunContext: (messageStore) => ({
        query: "处理任务",
        images: ["/tmp/original.png"],
        getCurrentImages: () => messageStore.getCurrentImages(),
        actorId: "lead",
        role: {
          id: "lead",
          name: "Lead",
          systemPrompt: "You are Lead",
          capabilities: [],
          maxIterations: 8,
          temperature: 0.7,
        },
        maxIterations: 8,
        extraTools: [],
        tools: [],
        rolePrompt: "",
        hasCodingWorkflowSkill: false,
        fcCompatibilityKey: "",
        contextMessages: [],
      }),
    });

    expect(result.result).toBe("kernel result");
    expect(result.status).toBe("completed");
    expect(result.attempts).toBe(1);
    expect(result.capturedInboxUserQueries).toEqual(["补充说明"]);
    expect(result.currentImages).toEqual(["/tmp/original.png", "/tmp/follow-up.png"]);
    expect(result.ctxSnapshot.hasRetry).toBe(true);
    expect(onMiddlewareCompleted).toHaveBeenCalledWith(expect.objectContaining({
      toolCount: 1,
      hasSkillsPrompt: true,
      hasMemoryPrompt: true,
      hasRetry: true,
    }));
    expect(onVisibleToolNames).toHaveBeenCalledWith(["task_done"]);
  });

  it("re-runs once after runtime-level context recovery", async () => {
    const runMiddlewares = vi.fn(async (_middlewares, ctx) => {
      ctx.tools = [{ name: "task_done", description: "", execute: vi.fn(async () => "ok") }];
    });
    const createAgent = vi
      .fn()
      .mockImplementationOnce((_ai, _tools, _config, onStep, history) => {
        expect(history).toEqual([]);
        return {
          listVisibleToolNames: () => ["task_done"],
          run: async () => {
            onStep?.({
              type: "action",
              content: "read",
              toolName: "read_file",
              toolInput: { path: "/tmp/demo.ts" },
              timestamp: Date.now(),
            });
            onStep?.({
              type: "observation",
              content: "read ok",
              toolName: "read_file",
              timestamp: Date.now(),
            });
            throw new Error("context pressure");
          },
        };
      })
      .mockImplementationOnce((_ai, _tools, config, _onStep, history) => {
        expect(history).toHaveLength(2);
        expect(config.contextMessages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.stringContaining("[上轮工具与结果摘要]"),
          }),
        ]));
        return {
          listVisibleToolNames: () => ["task_done"],
          run: async () => "recovered result",
        };
      });
    const onContextRecovery = vi.fn(async () => true);
    const engine = new QueryEngine({
      productMode: "dialog",
      temperature: 0.7,
      middlewares: [],
      runMiddlewares,
      createAgent,
      drainInbox: () => [],
      resolveInboxSenderName: (from) => from,
      onContextRecovery,
    });

    const result = await engine.run({
      query: "处理任务",
      signal: new AbortController().signal,
      createRunContext: (messageStore) => ({
        query: "处理任务",
        getCurrentImages: () => messageStore.getCurrentImages(),
        actorId: "lead",
        role: {
          id: "lead",
          name: "Lead",
          systemPrompt: "You are Lead",
          capabilities: [],
          maxIterations: 8,
          temperature: 0.7,
        },
        maxIterations: 8,
        extraTools: [],
        tools: [],
        rolePrompt: "",
        hasCodingWorkflowSkill: false,
        fcCompatibilityKey: "",
        contextMessages: [],
      }),
    });

    expect(result.result).toBe("recovered result");
    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(runMiddlewares).toHaveBeenCalledTimes(2);
    expect(onContextRecovery).toHaveBeenCalledTimes(1);
  });

  it("continues with prior runtime history when the inner agent exhausts iteration budget", async () => {
    const runMiddlewares = vi.fn(async (_middlewares, ctx) => {
      ctx.tools = [{ name: "read_file", description: "", execute: vi.fn(async () => "ok") }];
    });
    const createAgent = vi
      .fn()
      .mockImplementationOnce((_ai, _tools, _config, onStep, history) => {
        expect(history).toEqual([]);
        return {
          listVisibleToolNames: () => ["read_file"],
          run: async () => {
            onStep?.({
              type: "action",
              content: "read",
              toolName: "read_file",
              toolInput: { path: "/tmp/demo.ts" },
              timestamp: Date.now(),
            });
            onStep?.({
              type: "observation",
              content: "文件读取完成，发现还需要继续整理剩余结果。",
              toolName: "read_file",
              timestamp: Date.now(),
            });
            return "已达到最大执行步数（8 步）。";
          },
        };
      })
      .mockImplementationOnce((_ai, _tools, config, _onStep, history) => {
        expect(history).toHaveLength(2);
        expect(config.contextMessages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.stringContaining("[上轮工具与结果摘要]"),
          }),
        ]));
        return {
          listVisibleToolNames: () => ["read_file"],
          run: async (query: string) => {
            expect(query).toContain("继续完成刚才尚未收尾的部分");
            return "最终完成";
          },
        };
      });

    const engine = new QueryEngine({
      productMode: "dialog",
      temperature: 0.7,
      middlewares: [],
      runMiddlewares,
      createAgent,
      drainInbox: () => [],
      resolveInboxSenderName: (from) => from,
    });

    const result = await engine.run({
      query: "处理任务",
      signal: new AbortController().signal,
      createRunContext: (messageStore) => ({
        query: "处理任务",
        getCurrentImages: () => messageStore.getCurrentImages(),
        actorId: "lead",
        role: {
          id: "lead",
          name: "Lead",
          systemPrompt: "You are Lead",
          capabilities: [],
          maxIterations: 8,
          temperature: 0.7,
        },
        maxIterations: 8,
        extraTools: [],
        tools: [],
        rolePrompt: "",
        hasCodingWorkflowSkill: false,
        fcCompatibilityKey: "",
        contextMessages: [],
      }),
    });

    expect(result.result).toBe("最终完成");
    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(runMiddlewares).toHaveBeenCalledTimes(2);
  });
});
