import { describe, expect, it } from "vitest";
import {
  buildMemoryPromptBlock,
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

  it("builds prompt block from recalled memories", () => {
    const prompt = buildMemoryPromptBlock([
      mockMemory({ id: "mem-x", content: "默认用中文回答", kind: "preference" }),
    ]);
    expect(prompt).toContain("长期记忆");
    expect(prompt).toContain("默认用中文回答");
  });
});
