import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import {
  semanticRecall,
  recallMemories,
  extractMemoryCandidates,
  listConfirmedMemories,
  llmExtractMemories,
  queueMemoryCandidateFromAgent,
  type AIMemoryCandidateMode,
  type AIMemoryItem,
} from "@/core/ai/memory-store";
import { useAIStore } from "@/store/ai-store";
import {
  shouldAutoSaveAssistantMemory,
  shouldRecallAssistantMemory,
} from "@/core/ai/assistant-config";
import {
  appendAssistantMemoryCandidates,
  buildAssistantMemoryPromptForQuery,
} from "@/core/ai/assistant-memory";

const MAX_SEARCH_RESULTS = 8;
const MAX_EXTRACT_CONTENT_LENGTH = 2000;

/**
 * 创建 Actor 专用的记忆工具（memory_search / memory_save）。
 * 让 Agent 能主动检索和存储记忆，对标 OpenClaw 的 memory_search / memory_get。
 */
export function createActorMemoryTools(actorId: string, workspaceId?: string): AgentTool[] {
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
          const visible = all.filter((memory) => {
            if (memory.scope === "conversation") return false;
            if (memory.scope === "workspace") {
              return !!workspaceId && memory.workspace_id === workspaceId;
            }
            return true;
          });
          return {
            results: visible.slice(0, maxResults).map(formatMemoryItem),
            total: visible.length,
          };
        }

        try {
          const results = await semanticRecall(query, {
            topK: maxResults,
            workspaceId,
          });
          return {
            results: results.map(formatMemoryItem),
            total: results.length,
          };
        } catch {
          const fallback = await recallMemories(query, {
            topK: maxResults,
            workspaceId,
          });
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
        "将用户的长期记忆加入待确认候选。当用户表达了偏好、约束、目标、重要事实时，调用此工具建议保存。" +
        "示例：用户说'我喜欢简洁的代码风格'→ 进入偏好候选，等待用户确认。",
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

        const result = await queueMemoryCandidateFromAgent(content, "", category, {
          workspaceId,
          sourceMode: "agent",
          reason: "Dialog / Agent 提议将这条用户信息加入长期记忆候选",
          evidence: content,
        });
        return result
          ? {
              saved: true,
              queued: true,
              pending_review: true,
              candidate_id: result.id,
              kind: result.kind,
            }
          : { saved: false, error: "保存失败（内容不合规、过短或已存在）" };
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
 * Extract memories from conversation using LLM-based extraction (primary)
 * with regex-based fallback. Results are queued as memory candidates and
 * require user confirmation before entering the long-term memory store.
 */
export async function autoExtractMemories(
  conversationContent: string,
  conversationId?: string,
  opts?: { sourceMode?: AIMemoryCandidateMode; workspaceId?: string },
): Promise<number> {
  if (!shouldAutoSaveAssistantMemory(useAIStore.getState().config)) {
    return 0;
  }
  // Dialog 房间里包含大量内部 Agent 协作内容，直接拿内部任务对话做长期记忆会非常吵。
  // Dialog 模式改为仅在用户原始输入侧做轻量候选提取，这里不再分析内部运行结果。
  if (opts?.sourceMode === "dialog") {
    return 0;
  }
  if (!conversationContent || conversationContent.length < 20) return 0;

  const truncated = conversationContent.slice(0, MAX_EXTRACT_CONTENT_LENGTH);

  // Try LLM-based extraction first for richer results
  const llmCandidates = await llmExtractMemories(truncated, {
    conversationId,
    workspaceId: opts?.workspaceId,
    source: "assistant",
    sourceMode: opts?.sourceMode ?? "agent",
    evidence: truncated,
  }).catch(() => []);

  if (llmCandidates.length > 0) {
    await appendAssistantMemoryCandidates(llmCandidates);
    return llmCandidates.length;
  }

  // Fallback to regex-based heuristic
  const candidates = extractMemoryCandidates(truncated, {
    conversationId,
    workspaceId: opts?.workspaceId,
    source: "assistant",
    sourceMode: opts?.sourceMode ?? "agent",
    reason: "从对话中匹配到明确的长期记忆提示词",
    evidence: truncated,
  });
  if (candidates.length === 0) return 0;

  await appendAssistantMemoryCandidates(candidates);
  return candidates.length;
}

/**
 * 构建记忆 prompt 片段（用于注入 system prompt）。
 */
export async function buildActorMemoryPrompt(
  query: string,
  opts?: { workspaceId?: string },
): Promise<string> {
  if (!shouldRecallAssistantMemory(useAIStore.getState().config)) {
    return "";
  }
  return buildAssistantMemoryPromptForQuery(query, {
    topK: 6,
    preferSemantic: true,
    workspaceId: opts?.workspaceId,
  });
}
