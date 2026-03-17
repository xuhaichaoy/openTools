import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import {
  semanticRecall,
  recallMemories,
  listConfirmedMemories,
  ingestAutomaticMemorySignals,
  queueMemoryCandidateFromAgent,
  saveSessionMemoryNote,
  type AIMemoryCandidateMode,
  type AIMemoryItem,
} from "@/core/ai/memory-store";
import { useAIStore } from "@/store/ai-store";
import {
  shouldAutoSaveAssistantMemory,
  shouldRecallAssistantMemory,
} from "@/core/ai/assistant-config";
import {
  buildAssistantMemoryPromptForQuery,
} from "@/core/ai/assistant-memory";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import {
  readFileMemorySnippet,
  searchFileMemories,
} from "@/core/ai/file-memory";

const MAX_SEARCH_RESULTS = 8;
const MAX_EXTRACT_CONTENT_LENGTH = 2000;

export function createMemoryTools(options?: {
  workspaceId?: string;
  sourceMode?: AIMemoryCandidateMode;
  saveReason?: string;
}): AgentTool[] {
  const workspaceId = options?.workspaceId;
  const sourceMode = options?.sourceMode ?? "agent";
  const saveReason = options?.saveReason ?? "Agent 提议将这条用户信息加入长期记忆候选";

  return [
    {
      name: "memory_search",
      description:
        "搜索 MEMORY.md 与 memory/*.md 中的长期记忆和 daily memory。" +
        "在回答涉及用户偏好、历史决策、待办事项、项目上下文等问题前，应先调用此工具检索。" +
        "如果命中的是文件片段，接着用 memory_get 按行读取需要的上下文。",
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
            mode: "structured",
          };
        }

        const fileResults = await searchFileMemories(query, {
          topK: maxResults,
        }).catch(() => []);
        if (fileResults.length > 0) {
          return {
            results: fileResults.map((result) => ({
              path: result.path,
              snippet: result.snippet,
              start_line: result.startLine,
              end_line: result.endLine,
              citation: result.citation,
              score: result.score,
              source: result.source,
            })),
            total: fileResults.length,
            mode: "file",
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
            mode: "structured_fallback",
            note: "文件型记忆未直接命中，已回退到结构化记忆召回。",
          };
        } catch {
          const fallback = await recallMemories(query, {
            topK: maxResults,
            workspaceId,
          });
          return {
            results: fallback.map(formatMemoryItem),
            total: fallback.length,
            mode: "keyword_fallback",
            note: "文件型记忆未命中，且向量召回不可用，已退回关键词匹配。",
          };
        }
      },
    },
    {
      name: "memory_get",
      description:
        "按路径和行号读取 MEMORY.md 或 memory/*.md 中的精确片段。" +
        "通常在 memory_search 命中之后使用，避免一次把整份记忆文件塞进上下文。",
      parameters: {
        path: {
          type: "string",
          description: "memory_search 返回的 path，例如 MEMORY.md 或 memory/2026-03-17.md",
          required: true,
        },
        from: {
          type: "number",
          description: "起始行号，默认 1",
          required: false,
        },
        lines: {
          type: "number",
          description: "读取行数，默认读取到文件结尾，最多 200 行",
          required: false,
        },
      },
      readonly: true,
      execute: async (params) => {
        try {
          const result = await readFileMemorySnippet({
            path: String(params.path ?? ""),
            from: typeof params.from === "number" ? params.from : undefined,
            lines: typeof params.lines === "number" ? params.lines : undefined,
          });
          return {
            path: result.path,
            text: result.text,
            start_line: result.startLine,
            end_line: result.endLine,
            citation:
              result.startLine === result.endLine
                ? `${result.path}#L${result.startLine}`
                : `${result.path}#L${result.startLine}-L${result.endLine}`,
          };
        } catch (error) {
          return {
            path: String(params.path ?? ""),
            error: error instanceof Error ? error.message : String(error),
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
          sourceMode,
          reason: saveReason,
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

/**
 * 创建 Actor 专用的记忆工具（memory_search / memory_get / memory_save）。
 * 让 Agent 能主动检索和存储记忆，对标 OpenClaw 的 memory_search / memory_get。
 */
export function createActorMemoryTools(actorId: string, workspaceId?: string): AgentTool[] {
  void actorId;
  return createMemoryTools({
    workspaceId,
    sourceMode: "agent",
    saveReason: "Dialog / Agent 提议将这条用户信息加入长期记忆候选",
  });
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
 * Extract durable session context from a finished run.
 * Automatic runs now prefer silent session notes over noisy long-term candidates.
 */
export async function autoExtractMemories(
  conversationContent: string,
  conversationId?: string,
  opts?: {
    sourceMode?: AIMemoryCandidateMode;
    workspaceId?: string;
    skipSessionNote?: boolean;
  },
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
  const note = opts?.skipSessionNote ? null : buildSessionNoteSummary(truncated);
  let savedCount = 0;

  if (note) {
    const saved = await saveSessionMemoryNote(note, {
      conversationId,
      workspaceId: opts?.workspaceId,
      source: "assistant",
    }).catch(() => null);
    if (saved) {
      savedCount += 1;
    }
  }

  // Keep automatic long-term extraction very conservative.
  // Silent session notes carry most transient context; only explicit durable signals
  // should still surface as candidate memories.
  const ingested = await ingestAutomaticMemorySignals(truncated, {
    conversationId,
    workspaceId: opts?.workspaceId,
    source: "assistant",
    sourceMode: opts?.sourceMode ?? "agent",
    evidence: truncated,
    autoConfirm: false,
  }).catch(() => ({ confirmed: 0, queued: 0 }));
  return savedCount + ingested.confirmed + ingested.queued;
}

function buildSessionNoteSummary(conversationContent: string): string | null {
  const normalized = conversationContent.trim();
  if (!normalized) return null;

  const [queryPart, ...restParts] = normalized.split(/\n+/);
  const query = summarizeAISessionRuntimeText(queryPart, 100);
  const result = summarizeAISessionRuntimeText(restParts.join(" "), 140);

  if (query && result) {
    return `任务：${query}；进展：${result}`;
  }
  return summarizeAISessionRuntimeText(normalized, 200) ?? null;
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
