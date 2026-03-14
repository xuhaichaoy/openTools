import { JsonCollection, SyncableCollection, type SyncMeta } from "@/core/database/index";
import { invoke } from "@tauri-apps/api/core";
import { estimateTokens } from "./token-utils";

export type AIMemoryKind = "preference" | "fact" | "goal" | "constraint" | "project_context" | "conversation_summary" | "knowledge" | "behavior";
export type AIMemoryScope = "global" | "conversation";
export type AIMemorySource = "user" | "assistant" | "system" | "agent";

export interface AIMemoryItem extends SyncMeta {
  id: string;
  content: string;
  kind: AIMemoryKind;
  tags: string[];
  scope: AIMemoryScope;
  conversation_id?: string;
  importance: number;
  confidence: number;
  source: AIMemorySource;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
  deleted: boolean;
}

export interface AIMemoryCandidate {
  id: string;
  content: string;
  reason: string;
  confidence: number;
  created_at: number;
  conversation_id?: string;
}

export interface CandidateSanitizeResult {
  ok: boolean;
  sanitized: string;
  reason?: string;
}

interface RecallOptions {
  conversationId?: string;
  topK?: number;
}

const DEFAULT_RECALL_TOP_K = 6;
const MAX_CANDIDATE_TEXT_LENGTH = 500;
const MAX_MEMORY_TEXT_LENGTH = 260;
const MAX_CANDIDATES = 60;
const MAX_MEMORIES_IN_PROMPT = 6;
const MAX_INJECTION_TOKENS = 2000;
const FACT_CONFIDENCE_THRESHOLD = 0.7;
const MAX_FACTS = 100;

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(sk|rk|pk)-[a-z0-9]{10,}\b/i,
  /\b(api[\s_-]?key|secret|token|password|passwd|access[\s_-]?key)\b/i,
  /令牌|密钥|口令|密码|私钥|验证码/,
  /\b\d{15,19}\b/,
  /\b\d{6}[-\s]?\d{8}\b/,
  /\b1[3-9]\d{9}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

const EPHEMERAL_PATTERNS: RegExp[] = [
  /验证码|临时|一次性|仅本次|本次会话|会话id|session id/i,
  /马上|立刻|今天|明天|刚刚|刚才/,
  /短链|临时链接|过期/,
];

const CAPTURE_HINTS: RegExp[] = [
  /记住|记下来|帮我记/,
  /默认|以后|今后|长期/,
  /我希望你|请始终|总是|优先/,
  /我的偏好|我的习惯|我的角色|我的目标/,
];

const CONSTRAINT_HINTS = /(不要|不得|必须|禁止|务必|仅限)/;
const GOAL_HINTS = /(目标|里程碑|计划|推进|交付|上线)/;
const PREFERENCE_HINTS = /(默认|风格|格式|语气|模板|偏好|习惯|输出)/;
const KNOWLEDGE_HINTS = /(擅长|精通|熟悉|了解|会用|经验|专家|专长|掌握)/;
const BEHAVIOR_HINTS = /(习惯|通常|一般|总是|喜欢先|工作流|流程|方式)/;

export const aiMemoryDb = new SyncableCollection<AIMemoryItem>("ai_memory");
export const aiMemoryCandidateDb = new JsonCollection<AIMemoryCandidate>(
  "ai_memory_candidates",
);

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function normalizeForCompare(input: string): string {
  return normalizeWhitespace(input).toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tokenize(input: string): string[] {
  const normalized = normalizeForCompare(input);
  const alphaNumericParts = normalized
    .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
    .split(/\s+/)
    .filter((part) => part.length >= 2);

  // 中文没有空格，补充 2-gram / 3-gram 提升召回准确率。
  const cjkJoined = normalized.replace(/[^\u4e00-\u9fa5]/g, "");
  const cjkNgrams: string[] = [];
  const maxN = 3;
  for (let n = 2; n <= maxN; n += 1) {
    for (let i = 0; i <= cjkJoined.length - n; i += 1) {
      cjkNgrams.push(cjkJoined.slice(i, i + n));
    }
  }

  const unique = new Set([...alphaNumericParts, ...cjkNgrams]);
  return [...unique];
}

function inferKind(text: string): AIMemoryKind {
  if (CONSTRAINT_HINTS.test(text)) return "constraint";
  if (GOAL_HINTS.test(text)) return "goal";
  if (KNOWLEDGE_HINTS.test(text)) return "knowledge";
  if (BEHAVIOR_HINTS.test(text)) return "behavior";
  if (PREFERENCE_HINTS.test(text)) return "preference";
  return "fact";
}

function inferTags(text: string): string[] {
  const tags: string[] = [];
  const lower = text.toLowerCase();
  if (/(markdown|md|表格|代码块)/i.test(lower)) tags.push("markdown");
  if (/(简短|简洁|精简)/.test(text)) tags.push("concise");
  if (/(详细|全面|展开|解释)/.test(text)) tags.push("detailed");
  if (/(中文|英文|翻译)/.test(text)) tags.push("language");
  if (/(代码|编程|开发|调试)/.test(text)) tags.push("coding");
  return tags;
}

function inferImportance(kind: AIMemoryKind, text: string): number {
  let score = 0.65;
  if (kind === "constraint") score += 0.2;
  if (kind === "goal") score += 0.1;
  if (/请始终|务必|必须|默认/.test(text)) score += 0.1;
  return clamp(score, 0.1, 1);
}

function shouldCapture(text: string): boolean {
  return CAPTURE_HINTS.some((pattern) => pattern.test(text));
}

function trimMemoryContent(text: string, max = MAX_MEMORY_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export function sanitizeCandidateStrict(content: string): CandidateSanitizeResult {
  const sanitized = normalizeWhitespace(content).slice(0, MAX_CANDIDATE_TEXT_LENGTH);
  if (!sanitized) {
    return { ok: false, sanitized: "", reason: "empty" };
  }
  if (sanitized.length < 6) {
    return { ok: false, sanitized, reason: "too_short" };
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(sanitized))) {
    return { ok: false, sanitized: "", reason: "sensitive" };
  }
  if (EPHEMERAL_PATTERNS.some((pattern) => pattern.test(sanitized))) {
    return { ok: false, sanitized: "", reason: "ephemeral" };
  }
  return { ok: true, sanitized };
}

export function extractMemoryCandidates(
  userInput: string,
  opts?: { conversationId?: string },
): AIMemoryCandidate[] {
  if (!shouldCapture(userInput)) return [];

  const sanitized = sanitizeCandidateStrict(userInput);
  if (!sanitized.ok) return [];

  const text = sanitized.sanitized;
  const confidence = /记住|请始终|务必|默认/.test(text) ? 0.9 : 0.75;

  return [
    {
      id: createId("memc"),
      content: text,
      reason: "从用户明确的长期偏好/事实指令中提取",
      confidence,
      created_at: Date.now(),
      conversation_id: opts?.conversationId,
    },
  ];
}

export async function appendMemoryCandidates(
  candidates: AIMemoryCandidate[],
): Promise<void> {
  if (!candidates.length) return;
  const confirmed = await aiMemoryDb.getAll();
  const confirmedSet = new Set(
    confirmed
      .filter((item) => !item.deleted)
      .map((item) => normalizeForCompare(item.content)),
  );
  const existing = await aiMemoryCandidateDb.getAll();
  const merged = [...candidates, ...existing];
  const dedup = new Map<string, AIMemoryCandidate>();

  for (const candidate of merged) {
    const key = normalizeForCompare(candidate.content);
    if (!key) continue;
    if (confirmedSet.has(key)) continue;
    if (!dedup.has(key)) {
      dedup.set(key, candidate);
      continue;
    }
    const current = dedup.get(key)!;
    if (candidate.created_at > current.created_at) {
      dedup.set(key, candidate);
    }
  }

  const next = [...dedup.values()]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_CANDIDATES);
  await aiMemoryCandidateDb.setAll(next);
}

export async function listMemoryCandidates(): Promise<AIMemoryCandidate[]> {
  const all = await aiMemoryCandidateDb.getAll();
  return [...all].sort((a, b) => b.created_at - a.created_at);
}

export async function dismissMemoryCandidate(candidateId: string): Promise<void> {
  const all = await aiMemoryCandidateDb.getAll();
  await aiMemoryCandidateDb.setAll(all.filter((item) => item.id !== candidateId));
}

export async function listConfirmedMemories(): Promise<AIMemoryItem[]> {
  const all = await aiMemoryDb.getAll();
  return [...all]
    .filter((item) => !item.deleted)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const now = Date.now();
  await aiMemoryDb.update(memoryId, {
    deleted: true,
    updated_at: now,
  });
  invalidateMemoryVectorIndex();
}

export async function confirmMemoryCandidate(
  candidateId: string,
): Promise<AIMemoryItem | null> {
  const candidates = await aiMemoryCandidateDb.getAll();
  const candidate = candidates.find((item) => item.id === candidateId);
  if (!candidate) return null;

  const sanitized = sanitizeCandidateStrict(candidate.content);
  if (!sanitized.ok) {
    await dismissMemoryCandidate(candidateId);
    return null;
  }
  const saved = await saveConfirmedMemory(sanitized.sanitized, {
    conversationId: candidate.conversation_id,
    confidence: candidate.confidence,
    source: "user",
  });
  await dismissMemoryCandidate(candidateId);
  return saved;
}

export async function saveConfirmedMemory(
  content: string,
  options?: {
    kind?: AIMemoryKind;
    source?: AIMemorySource;
    conversationId?: string;
    scope?: AIMemoryScope;
    confidence?: number;
    importance?: number;
    tags?: string[];
  },
): Promise<AIMemoryItem | null> {
  const sanitized = sanitizeCandidateStrict(content);
  if (!sanitized.ok) return null;

  const text = sanitized.sanitized;
  const now = Date.now();
  const kind = options?.kind ?? inferKind(text);
  const inferredTags = inferTags(text);
  const mergedTags = [...new Set([...(options?.tags || []), ...inferredTags])];
  const normalized = normalizeForCompare(text);
  const importance = clamp(
    options?.importance ?? inferImportance(kind, text),
    0.1,
    1,
  );
  const confidence = clamp(options?.confidence ?? 0.9, 0.1, 1);
  const memories = await aiMemoryDb.getAll();
  const existing = memories.find(
    (item) => !item.deleted && normalizeForCompare(item.content) === normalized,
  );

  if (existing) {
    const updated =
      (await aiMemoryDb.update(existing.id, {
        content: trimMemoryContent(text),
        tags: [...new Set([...(existing.tags || []), ...mergedTags])],
        kind,
        importance: Math.max(existing.importance ?? 0.5, importance),
        confidence: Math.max(existing.confidence ?? 0.5, confidence),
        source: options?.source ?? existing.source,
        updated_at: now,
        conversation_id: options?.conversationId ?? existing.conversation_id,
        scope: options?.scope
          ?? (options?.conversationId ? "conversation" : existing.scope),
        deleted: false,
      })) ?? null;
    if (updated) invalidateMemoryVectorIndex();
    return updated;
  }

  const created = await aiMemoryDb.create({
    id: createId("mem"),
    content: trimMemoryContent(text),
    kind,
    tags: mergedTags,
    scope: options?.scope ?? (options?.conversationId ? "conversation" : "global"),
    conversation_id: options?.conversationId,
    importance,
    confidence,
    source: options?.source ?? "user",
    created_at: now,
    updated_at: now,
    last_used_at: null,
    use_count: 0,
    deleted: false,
  });
  invalidateMemoryVectorIndex();
  return created;
}

function scoreMemory(
  memory: AIMemoryItem,
  queryTokens: string[],
  options?: RecallOptions,
): number {
  const memoryTokens = tokenize(memory.content);
  const overlapCount = queryTokens.filter((token) => memoryTokens.includes(token)).length;
  const overlapScore =
    queryTokens.length > 0 ? overlapCount / queryTokens.length : 0;

  const tagScore =
    memory.tags.length > 0 && queryTokens.length > 0
      ? memory.tags.filter((tag) => queryTokens.includes(tag.toLowerCase())).length *
        0.1
      : 0;

  const queryText = queryTokens.join(" ");
  const fullTextMatch =
    queryText && normalizeForCompare(memory.content).includes(queryText) ? 0.15 : 0;

  const conversationBoost =
    options?.conversationId &&
    memory.conversation_id &&
    options.conversationId === memory.conversation_id
      ? 0.35
      : 0;

  const kindBoost = memory.kind === "preference" || memory.kind === "constraint" ? 0.08 : 0;
  const usageBoost = Math.min(memory.use_count || 0, 15) * 0.01;
  const importanceBoost = clamp(memory.importance ?? 0.5, 0, 1) * 0.2;

  return overlapScore * 0.45 + tagScore + fullTextMatch + conversationBoost + kindBoost + usageBoost + importanceBoost;
}

export function rankMemoriesForRecall(
  memories: AIMemoryItem[],
  query: string,
  options?: RecallOptions,
): AIMemoryItem[] {
  const queryTokens = tokenize(query);
  const topK = options?.topK ?? DEFAULT_RECALL_TOP_K;

  const ranked = memories
    .filter((item) => !item.deleted)
    .map((item) => ({ item, score: scoreMemory(item, queryTokens, options) }))
    .filter(({ score }) => score > 0.08 || queryTokens.length === 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.item.updated_at || 0) - (a.item.updated_at || 0);
    })
    .slice(0, topK)
    .map(({ item }) => item);

  return ranked;
}

export async function recallMemories(
  query: string,
  options?: RecallOptions,
): Promise<AIMemoryItem[]> {
  const all = await aiMemoryDb.getAll();
  const ranked = rankMemoriesForRecall(all, query, options);
  if (!ranked.length) return ranked;

  const now = Date.now();
  // 召回命中统计仅用于本地排序，不应触发云同步 dirty 标记。
  const touched = new Set(ranked.map((item) => item.id));
  let changed = false;
  const nextAll = all.map((item) => {
    if (!touched.has(item.id) || item.deleted) return item;
    changed = true;
    return {
      ...item,
      use_count: (item.use_count || 0) + 1,
      last_used_at: now,
    };
  });
  if (changed) {
    await aiMemoryDb.setAll(nextAll);
  }

  return ranked;
}

const KIND_LABELS: Record<AIMemoryKind, string> = {
  constraint: "约束",
  goal: "目标",
  preference: "偏好",
  knowledge: "知识",
  behavior: "行为",
  project_context: "项目",
  conversation_summary: "摘要",
  fact: "事实",
};

export function buildMemoryPromptBlock(
  memories: AIMemoryItem[],
  maxTokens: number = MAX_INJECTION_TOKENS,
): string {
  if (!memories.length) return "";

  const header = "以下是用户确认过的长期记忆，请在回答中优先遵循（如与当前明确指令冲突，以当前指令为准）：";
  let tokenBudget = maxTokens - estimateTokens(header);
  const lines: string[] = [];

  for (let i = 0; i < Math.min(memories.length, MAX_MEMORIES_IN_PROMPT); i++) {
    const memory = memories[i];
    const label = KIND_LABELS[memory.kind] ?? "事实";
    const line = `${i + 1}. [${label}] ${trimMemoryContent(memory.content, 180)}`;
    const lineCost = estimateTokens(line);
    if (lineCost > tokenBudget) break;
    lines.push(line);
    tokenBudget -= lineCost;
  }

  if (!lines.length) return "";
  return [header, ...lines].join("\n");
}

// ── Unified Agent Memory Support ──

const AGENT_KIND_MAP: Record<string, AIMemoryKind> = {
  preference: "preference",
  fact: "fact",
  pattern: "preference",
  knowledge: "knowledge",
  context: "project_context",
  behavior: "behavior",
  goal: "goal",
  constraint: "constraint",
};

export function composeAgentMemoryContent(key: string, value: string): string {
  const normalizedKey = normalizeWhitespace(String(key || ""));
  const normalizedValue = normalizeWhitespace(String(value || ""));
  if (normalizedKey && normalizedValue) {
    return `${normalizedKey}: ${normalizedValue}`;
  }
  return normalizedKey || normalizedValue;
}

export async function addMemoryFromAgent(
  key: string,
  value: string,
  category: string = "preference",
): Promise<AIMemoryItem | null> {
  const content = composeAgentMemoryContent(key, value);
  const sanitized = sanitizeCandidateStrict(content);
  if (!sanitized.ok) return null;

  const text = sanitized.sanitized;
  const normalized = normalizeForCompare(text);
  const kind = AGENT_KIND_MAP[category] ?? inferKind(text);
  const tags = inferTags(text);
  const importance = inferImportance(kind, text);
  const now = Date.now();

  const memories = await aiMemoryDb.getAll();
  const existing = memories.find(
    (item) => !item.deleted && normalizeForCompare(item.content) === normalized,
  );

  if (existing) {
    const updated = (
      (await aiMemoryDb.update(existing.id, {
        content: trimMemoryContent(text),
        kind,
        tags: [...new Set([...(existing.tags || []), ...tags])],
        importance: Math.max(existing.importance ?? 0.5, importance),
        updated_at: now,
        use_count: (existing.use_count || 0) + 1,
      })) ?? null
    );
    if (updated) invalidateMemoryVectorIndex();
    return updated;
  }

  const created = await aiMemoryDb.create({
    id: createId("mem"),
    content: trimMemoryContent(text),
    kind,
    tags,
    scope: "global",
    importance,
    confidence: 0.8,
    source: "agent",
    created_at: now,
    updated_at: now,
    last_used_at: null,
    use_count: 1,
    deleted: false,
  });
  invalidateMemoryVectorIndex();
  return created;
}

// ── Semantic Recall (vector-store based, inspired by cocoindex-code sqlite-vec) ──

let _memoryVectorStoreReady = false;

/**
 * Ensure the in-memory vector index is rebuilt from the latest persistent
 * memory snapshot. Called lazily on first semantic recall after invalidation.
 */
async function ensureMemoryVectorIndex(): Promise<void> {
  if (_memoryVectorStoreReady) return;
  const { getMemoryVectorStore } = await import("./vector-store");
  const store = getMemoryVectorStore();
  await store.clear();
  const all = await aiMemoryDb.getAll();
  const active = all.filter((m) => !m.deleted);
  if (active.length > 0) {
    await store.upsert(
      active.map((m) => ({
        id: m.id,
        content: m.content,
        partition: m.kind,
        metadata: { tags: m.tags, importance: m.importance, source: m.source },
      })),
    );
  }
  _memoryVectorStoreReady = true;
}

/** Reset the vector index ready flag (call after bulk memory mutations). */
export function invalidateMemoryVectorIndex(): void {
  _memoryVectorStoreReady = false;
}

export async function semanticRecall(
  query: string,
  options?: RecallOptions,
): Promise<AIMemoryItem[]> {
  const topK = options?.topK ?? DEFAULT_RECALL_TOP_K;

  // 1. Try native Rust vector store (sqlite-vec) via Tauri invoke
  try {
    const results = await invoke<Array<{ content: string; score: number }>>("rag_search", {
      query,
      topK,
      collection: "ai_memory",
    });
    if (results && results.length > 0) {
      const all = await aiMemoryDb.getAll();
      const contentMap = new Map(all.filter((m) => !m.deleted).map((m) => [normalizeForCompare(m.content), m]));
      const matched: AIMemoryItem[] = [];
      for (const r of results) {
        const found = contentMap.get(normalizeForCompare(r.content));
        if (found) matched.push(found);
      }
      if (matched.length > 0) return matched;
    }
  } catch {
    // Native RAG not available, try in-memory vector store
  }

  // 2. Try in-memory vector store (VectorStore with simple embeddings)
  try {
    await ensureMemoryVectorIndex();
    const { getMemoryVectorStore } = await import("./vector-store");
    const store = getMemoryVectorStore();
    if (store.size > 0) {
      const results = await store.search(query, {
        topK,
        minScore: 0.1,
      });
      if (results.length > 0) {
        const all = await aiMemoryDb.getAll();
        const idMap = new Map(all.filter((m) => !m.deleted).map((m) => [m.id, m]));
        const matched: AIMemoryItem[] = [];
        for (const r of results) {
          const found = idMap.get(r.id);
          if (found) matched.push(found);
        }
        if (matched.length > 0) return matched;
      }
    }
  } catch {
    // Vector store not available
  }

  // 3. Fallback to keyword-based recall
  return recallMemories(query, options);
}

// ── Migrate Agent Memory from localStorage ──

export async function migrateAgentMemory(): Promise<number> {
  const STORAGE_KEY = "agent_user_memory";
  let migrated = 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const items = JSON.parse(raw) as Array<{
      key: string;
      value: string;
      category: string;
      createdAt: number;
      usedCount: number;
    }>;
    for (const item of items) {
      await addMemoryFromAgent(item.key, item.value, item.category);
      migrated++;
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // migration is best-effort
  }
  return migrated;
}

// ── Update/Edit Memory ──

export async function updateMemoryContent(
  memoryId: string,
  content: string,
): Promise<AIMemoryItem | null> {
  const sanitized = sanitizeCandidateStrict(content);
  if (!sanitized.ok) return null;
  const updated = (
    (await aiMemoryDb.update(memoryId, {
      content: trimMemoryContent(sanitized.sanitized),
      kind: inferKind(sanitized.sanitized),
      tags: inferTags(sanitized.sanitized),
      updated_at: Date.now(),
    })) ?? null
  );
  if (updated) invalidateMemoryVectorIndex();
  return updated;
}

// ── Get Memory Stats ──

export async function getMemoryStats(): Promise<{
  total: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
}> {
  const all = await aiMemoryDb.getAll();
  const active = all.filter((m) => !m.deleted);
  const byKind: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const m of active) {
    byKind[m.kind] = (byKind[m.kind] || 0) + 1;
    bySource[m.source] = (bySource[m.source] || 0) + 1;
  }
  return { total: active.length, byKind, bySource };
}

// ── LLM-based Memory Extraction (inspired by deer-flow) ──

interface LLMExtractedFact {
  content: string;
  category: string;
  confidence: number;
}

const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction system. Analyze this conversation and extract important facts about the user.

Conversation:
{conversation}

Extract facts in this JSON format:
{
  "facts": [
    { "content": "...", "category": "preference|knowledge|context|behavior|goal|constraint", "confidence": 0.0-1.0 }
  ]
}

Categories:
- preference: 用户偏好（工具、风格、方法的偏好/厌恶）
- knowledge: 专业知识（擅长的技术、领域专长）
- context: 背景信息（职位、项目、技术栈）
- behavior: 行为模式（工作习惯、沟通风格、解决问题方式）
- goal: 目标（学习目标、项目目标）
- constraint: 约束（硬性限制、规则）

Confidence levels:
- 0.9-1.0: 用户明确表述的事实（"我在做X"、"我的角色是Y"）
- 0.7-0.8: 从行为/讨论中强推断
- 0.5-0.6: 推测的模式（仅限明确的模式，谨慎使用）

Rules:
- Only extract clear, specific facts
- Skip vague or temporary information
- Preserve technical terms and proper nouns
- Do NOT extract file paths, session IDs, or ephemeral data
- Return ONLY valid JSON, no explanation`;

/**
 * LLM-based memory extraction from conversation content.
 * Falls back to regex-based heuristic when LLM is unavailable.
 */
export async function llmExtractMemories(
  conversationContent: string,
  opts?: { conversationId?: string },
): Promise<AIMemoryCandidate[]> {
  if (!conversationContent || conversationContent.length < 30) return [];
  const truncated = conversationContent.slice(0, 3000);

  try {
    const { getMToolsAI } = await import("@/core/ai/mtools-ai");
    const ai = getMToolsAI();
    const prompt = MEMORY_EXTRACTION_PROMPT.replace("{conversation}", truncated);

    const result = await ai.chat({
      messages: [
        {
          role: "system",
          content: "You extract structured memory facts from conversations. Respond with valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      skipTools: true,
    });

    const text = result.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackExtract(truncated, opts);

    const parsed = JSON.parse(jsonMatch[0]) as { facts?: LLMExtractedFact[] };
    if (!parsed.facts?.length) return [];

    const candidates: AIMemoryCandidate[] = [];
    for (const fact of parsed.facts) {
      if (fact.confidence < FACT_CONFIDENCE_THRESHOLD) continue;

      const sanitized = sanitizeCandidateStrict(fact.content);
      if (!sanitized.ok) continue;

      candidates.push({
        id: createId("memc"),
        content: sanitized.sanitized,
        reason: `LLM extracted [${fact.category}] confidence=${fact.confidence}`,
        confidence: clamp(fact.confidence, 0, 1),
        created_at: Date.now(),
        conversation_id: opts?.conversationId,
      });
    }
    return candidates;
  } catch {
    return fallbackExtract(truncated, opts);
  }
}

function fallbackExtract(
  text: string,
  opts?: { conversationId?: string },
): AIMemoryCandidate[] {
  return extractMemoryCandidates(text, opts);
}

/**
 * Merge new candidates into existing memory, handling deduplication by content
 * similarity and confidence-based replacement (higher confidence wins).
 * Enforces MAX_FACTS limit by dropping lowest-confidence items.
 */
export async function mergeMemoryCandidatesIntoStore(
  candidates: AIMemoryCandidate[],
): Promise<{ added: number; updated: number; skipped: number }> {
  if (!candidates.length) return { added: 0, updated: 0, skipped: 0 };

  const existing = await aiMemoryDb.getAll();
  const activeMemories = existing.filter((m) => !m.deleted);
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const sanitized = sanitizeCandidateStrict(candidate.content);
    if (!sanitized.ok) { skipped++; continue; }

    const normalized = normalizeForCompare(sanitized.sanitized);
    const match = activeMemories.find(
      (m) => normalizeForCompare(m.content) === normalized,
    );

    if (match) {
      if (candidate.confidence > (match.confidence ?? 0.5)) {
        const kind = inferKind(sanitized.sanitized);
        await aiMemoryDb.update(match.id, {
          content: trimMemoryContent(sanitized.sanitized),
          kind,
          confidence: candidate.confidence,
          tags: [...new Set([...(match.tags || []), ...inferTags(sanitized.sanitized)])],
          importance: Math.max(match.importance ?? 0.5, inferImportance(kind, sanitized.sanitized)),
          updated_at: Date.now(),
        });
        updated++;
        invalidateMemoryVectorIndex();
      } else {
        skipped++;
      }
    } else {
      const kind = inferKind(sanitized.sanitized);
      await aiMemoryDb.create({
        id: createId("mem"),
        content: trimMemoryContent(sanitized.sanitized),
        kind,
        tags: inferTags(sanitized.sanitized),
        scope: candidate.conversation_id ? "conversation" : "global",
        conversation_id: candidate.conversation_id,
        importance: inferImportance(kind, sanitized.sanitized),
        confidence: candidate.confidence,
        source: "system",
        created_at: Date.now(),
        updated_at: Date.now(),
        last_used_at: null,
        use_count: 0,
        deleted: false,
      });
      added++;
      invalidateMemoryVectorIndex();
    }
  }

  // Enforce max facts limit
  const allAfter = await aiMemoryDb.getAll();
  const activeAfter = allAfter.filter((m) => !m.deleted);
  if (activeAfter.length > MAX_FACTS) {
    const sorted = activeAfter.sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5));
    const toDelete = sorted.slice(MAX_FACTS);
    for (const m of toDelete) {
      await aiMemoryDb.update(m.id, { deleted: true, updated_at: Date.now() });
      invalidateMemoryVectorIndex();
    }
  }

  return { added, updated, skipped };
}
