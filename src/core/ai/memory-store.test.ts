import { describe, expect, it } from "vitest";
import {
  buildMemoryPromptBlock,
  composeAgentMemoryContent,
  extractMemoryCandidates,
  rankMemoriesForRecall,
  sanitizeCandidateStrict,
  type AIMemoryItem,
} from "./memory-store";

function mockMemory(partial: Partial<AIMemoryItem>): AIMemoryItem {
  const now = Date.now();
  return {
    id: partial.id ?? "mem-1",
    content: partial.content ?? "默认简洁回答",
    kind: partial.kind ?? "preference",
    tags: partial.tags ?? [],
    scope: partial.scope ?? "global",
    conversation_id: partial.conversation_id,
    workspace_id: partial.workspace_id,
    importance: partial.importance ?? 0.6,
    confidence: partial.confidence ?? 0.8,
    source: partial.source ?? "user",
    created_at: partial.created_at ?? now,
    updated_at: partial.updated_at ?? now,
    last_used_at: partial.last_used_at ?? null,
    use_count: partial.use_count ?? 0,
    deleted: partial.deleted ?? false,
  };
}

describe("memory-store", () => {
  it("filters sensitive candidate text in strict mode", () => {
    const result = sanitizeCandidateStrict(
      "记住我的 API Key 是 sk-testsecret1234567890",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sensitive");
  });

  it("extracts candidate from explicit remember intent", () => {
    const candidates = extractMemoryCandidates(
      "请记住我以后默认输出 Markdown 表格并先给结论",
      { conversationId: "conv-1" },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.conversation_id).toBe("conv-1");
    expect(candidates[0]?.content).toContain("默认输出 Markdown");
    expect(candidates[0]?.kind).toBe("preference");
    expect(candidates[0]?.scope).toBe("global");
    expect(candidates[0]?.source).toBe("user");
  });

  it("does not extract generic short-term task instructions as memory", () => {
    const candidates = extractMemoryCandidates(
      "这次请让 Specialist 先做一下自我介绍，然后继续当前任务",
      { conversationId: "conv-1" },
    );
    expect(candidates).toHaveLength(0);
  });

  it("rejects internal memory extraction prompts", () => {
    const result = sanitizeCandidateStrict(
      "You are a memory extraction system. Analyze this conversation and extract important facts about the user. Conversation: 我的角色是开发者",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("prompt_leak");
  });

  it("ranks memories with lexical match plus conversation boost", () => {
    const memories: AIMemoryItem[] = [
      mockMemory({
        id: "mem-a",
        content: "以后默认输出 Markdown 表格",
        tags: ["markdown"],
        conversation_id: "conv-a",
        scope: "conversation",
        importance: 0.9,
      }),
      mockMemory({
        id: "mem-b",
        content: "回答要先给结论再展开",
        tags: ["concise"],
        conversation_id: "conv-b",
        scope: "conversation",
        importance: 0.8,
      }),
    ];

    const ranked = rankMemoriesForRecall(memories, "请用 markdown 表格回答", {
      conversationId: "conv-a",
      topK: 2,
    });
    expect(ranked[0]?.id).toBe("mem-a");
  });

  it("improves chinese recall ranking with cjk ngram tokens", () => {
    const memories: AIMemoryItem[] = [
      mockMemory({
        id: "mem-cn-a",
        content: "默认用中文回答，并且详细解释步骤",
        importance: 0.6,
        use_count: 0,
      }),
      mockMemory({
        id: "mem-cn-b",
        content: "回答要尽量简短，最多一行",
        importance: 0.6,
        use_count: 0,
      }),
    ];

    const ranked = rankMemoriesForRecall(memories, "请用中文详细说明实现步骤", {
      topK: 2,
    });
    expect(ranked[0]?.id).toBe("mem-cn-a");
  });

  it("prefers workspace-scoped project memory when workspace matches", () => {
    const memories: AIMemoryItem[] = [
      mockMemory({
        id: "mem-workspace-a",
        kind: "project_context",
        scope: "workspace",
        workspace_id: "/repo-a",
        content: "项目结构: 前端使用 React，后端使用 Rust",
        importance: 0.8,
      }),
      mockMemory({
        id: "mem-workspace-b",
        kind: "project_context",
        scope: "workspace",
        workspace_id: "/repo-b",
        content: "项目结构: 前端使用 Vue，后端使用 Go",
        importance: 0.8,
      }),
    ];

    const ranked = rankMemoriesForRecall(memories, "当前项目的前端技术栈是什么", {
      topK: 2,
      workspaceId: "/repo-a",
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.id).toBe("mem-workspace-a");
  });

  it("builds grouped prompt block from recalled memories", () => {
    const prompt = buildMemoryPromptBlock([
      mockMemory({ id: "mem-rule", content: "禁止直接删除用户文件", kind: "constraint" }),
      mockMemory({ id: "mem-x", content: "默认用中文回答", kind: "preference" }),
    ]);
    expect(prompt).toContain("长期记忆");
    expect(prompt).toContain("【必须遵守】");
    expect(prompt).toContain("【用户偏好】");
    expect(prompt).toContain("默认用中文回答");
  });

  it("composes agent memory content without trailing colon when value is empty", () => {
    expect(composeAgentMemoryContent("用户偏好简洁代码风格", "")).toBe(
      "用户偏好简洁代码风格",
    );
  });

  it("composes agent memory content with key and value when both exist", () => {
    expect(composeAgentMemoryContent("语言", "中文")).toBe("语言: 中文");
  });
});
