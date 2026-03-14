import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorRunContext } from "../actor-middleware";

const { invoke, aiState } = vi.hoisted(() => ({
  invoke: vi.fn(),
  aiState: {
    config: {
      enable_rag_auto_search: true,
    },
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
}));

vi.mock("@/store/ai-store", () => ({
  useAIStore: {
    getState: () => aiState,
  },
}));

import {
  KnowledgeBaseMiddleware,
  registerKnowledgeBase,
  unregisterKnowledgeBase,
} from "./knowledge-base-middleware";

function createContext(query = "怎么部署"): ActorRunContext {
  return {
    query,
    actorId: "actor-1",
    role: {} as any,
    maxIterations: 8,
    extraTools: [],
    tools: [],
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "",
    contextMessages: [],
  } as ActorRunContext;
}

describe("KnowledgeBaseMiddleware", () => {
  beforeEach(() => {
    invoke.mockReset();
    aiState.config.enable_rag_auto_search = true;
  });

  afterEach(() => {
    unregisterKnowledgeBase("kb-legacy");
  });

  it("skips auto retrieval when knowledge auto search is disabled", async () => {
    aiState.config.enable_rag_auto_search = false;
    const ctx = createContext();

    await new KnowledgeBaseMiddleware().apply(ctx);

    expect(invoke).not.toHaveBeenCalled();
    expect(ctx.contextMessages).toEqual([]);
  });

  it("injects local RAG results into actor context", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "rag_list_doc_summaries") {
        return [{ id: "doc-1", name: "README.md", status: "indexed_full" }];
      }
      if (command === "rag_search") {
        return [
          {
            chunk: {
              content: "部署前先执行数据库迁移，然后再重启服务。",
              metadata: { source: "README.md", heading: "部署" },
            },
            score: 0.92,
          },
        ];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const ctx = createContext("部署步骤");
    await new KnowledgeBaseMiddleware().apply(ctx);

    expect(ctx.contextMessages).toHaveLength(2);
    expect(ctx.contextMessages[0].content).toContain("本地知识库 / README.md / 部署");
    expect(ctx.contextMessages[0].content).toContain("部署前先执行数据库迁移");
  });

  it("falls back to keyword search when local rag search fails", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "rag_list_doc_summaries") {
        return [{ id: "doc-1", name: "FAQ.md", status: "indexed_keyword" }];
      }
      if (command === "rag_search") {
        throw new Error("vector unavailable");
      }
      if (command === "rag_keyword_search") {
        return [
          {
            chunk: {
              content: "可以直接使用 pnpm build 完成打包。",
              metadata: { source: "FAQ.md" },
            },
            score: 0.66,
          },
        ];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const ctx = createContext("如何打包");
    await new KnowledgeBaseMiddleware().apply(ctx);

    expect(invoke).toHaveBeenCalledWith("rag_keyword_search", {
      query: "如何打包",
      topK: 5,
    });
    expect(ctx.contextMessages[0].content).toContain("FAQ.md");
    expect(ctx.contextMessages[0].content).toContain("pnpm build");
  });

  it("keeps legacy registered knowledge bases working when local rag is empty", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        content: "团队规范要求提交前必须通过 lint 和测试。",
        score: 0.88,
        source: "团队规范",
      },
    ]);
    registerKnowledgeBase({
      id: "kb-legacy",
      name: "团队知识库",
      search,
    });

    invoke.mockImplementation(async (command: string) => {
      if (command === "rag_list_doc_summaries") return [];
      throw new Error(`unexpected command: ${command}`);
    });

    const ctx = createContext("提交流程");
    await new KnowledgeBaseMiddleware().apply(ctx);

    expect(search).toHaveBeenCalledWith("提交流程", 5);
    expect(ctx.contextMessages[0].content).toContain("团队知识库 / 团队规范");
    expect(ctx.contextMessages[0].content).toContain("lint 和测试");
  });
});
