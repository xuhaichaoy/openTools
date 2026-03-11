import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import {
  semanticRecall,
  recallMemories,
  addMemoryFromAgent,
  buildMemoryPromptBlock,
  extractMemoryCandidates,
  appendMemoryCandidates,
  listConfirmedMemories,
  type AIMemoryItem,
} from "@/core/ai/memory-store";

const MAX_SEARCH_RESULTS = 8;
const MAX_EXTRACT_CONTENT_LENGTH = 2000;

/**
 * 创建 Actor 专用的记忆工具（memory_search / memory_save）。
 * 让 Agent 能主动检索和存储记忆，对标 OpenClaw 的 memory_search / memory_get。
 */
export function createActorMemoryTools(actorId: string): AgentTool[] {
  return [
    {
      name: "memory_search",
      description:
        "搜索用户的长期记忆（偏好、事实、约束、目标等）。" +
        "在回答涉及用户偏好、历史决策、待办事项、项目上下文等问题前，应先调用此工具检索。" +
        "返回匹配的记忆条目列表。",
      parameters: {
        query: {
          type: "string",
          description: "搜索关键词或语义描述",
          required: true,
        },
        max_results: {
          type: "number",
          description: `返回结果数量上限，默认 ${MAX_SEARCH_RESULTS}`,
          required: false,
        },
      },
      readonly: true,
      execute: async (params) => {
        const query = String(params.query ?? "");
        const maxResults = params.max_results ? Number(params.max_results) : MAX_SEARCH_RESULTS;

        if (!query.trim()) {
          const all = await listConfirmedMemories();
          return {
            results: all.slice(0, maxResults).map(formatMemoryItem),
            total: all.length,
          };
        }

        try {
          const results = await semanticRecall(query, { topK: maxResults });
          return {
            results: results.map(formatMemoryItem),
            total: results.length,
          };
        } catch {
          const fallback = await recallMemories(query, { topK: maxResults });
          return {
            results: fallback.map(formatMemoryItem),
            total: fallback.length,
            note: "使用关键词匹配（向量搜索不可用）",
          };
        }
      },
    },
    {
      name: "memory_save",
      description:
        "保存用户的长期记忆。当用户表达了偏好、约束、目标、重要事实时，调用此工具存储。" +
        "示例：用户说'我喜欢简洁的代码风格'→ 存为偏好。",
      parameters: {
        content: {
          type: "string",
          description: "要记忆的内容（如 '用户偏好简洁代码风格'）",
          required: true,
        },
        category: {
          type: "string",
          description: "分类：preference（偏好）、fact（事实）、constraint（约束）、goal（目标）",
          required: false,
        },
      },
      readonly: false,
      execute: async (params) => {
        const content = String(params.content ?? "");
        const category = String(params.category ?? "preference");
        if (!content.trim()) return { saved: false, error: "内容不能为空" };

        const result = await addMemoryFromAgent(content, "", category);
        return result
          ? { saved: true, id: result.id, kind: result.kind }
          : { saved: false, error: "保存失败（内容不合规或重复）" };
      },
    },
  ];
}

function formatMemoryItem(m: AIMemoryItem) {
  return {
    id: m.id,
    content: m.content,
    kind: m.kind,
    tags: m.tags,
    importance: m.importance,
    updated_at: m.updated_at,
  };
}

/**
 * 从对话内容中自动提取记忆候选（用于任务结束后的自动提取）。
 * 对标 OpenClaw 的 session-memory hook。
 */
export async function autoExtractMemories(
  conversationContent: string,
  conversationId?: string,
): Promise<number> {
  if (!conversationContent || conversationContent.length < 20) return 0;

  const truncated = conversationContent.slice(0, MAX_EXTRACT_CONTENT_LENGTH);
  const candidates = extractMemoryCandidates(truncated, { conversationId });
  if (candidates.length === 0) return 0;

  await appendMemoryCandidates(candidates);
  return candidates.length;
}

/**
 * 构建记忆 prompt 片段（用于注入 system prompt）。
 */
export async function buildActorMemoryPrompt(query: string): Promise<string> {
  try {
    const memories = await semanticRecall(query, { topK: 6 });
    return buildMemoryPromptBlock(memories);
  } catch {
    const fallback = await recallMemories(query, { topK: 6 });
    return buildMemoryPromptBlock(fallback);
  }
}
