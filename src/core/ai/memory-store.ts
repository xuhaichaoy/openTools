import { JsonCollection, SyncableCollection, type SyncMeta } from "@/core/database/index";

export type AIMemoryKind = "preference" | "fact" | "goal" | "constraint";
export type AIMemoryScope = "global" | "conversation";
export type AIMemorySource = "user" | "assistant" | "system";

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
  const existing = await aiMemoryCandidateDb.getAll();
  const merged = [...candidates, ...existing];
  const dedup = new Map<string, AIMemoryCandidate>();

  for (const candidate of merged) {
    const key = normalizeForCompare(candidate.content);
    if (!key) continue;
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

  const text = sanitized.sanitized;
  const now = Date.now();
  const kind = inferKind(text);
  const tags = inferTags(text);
  const importance = inferImportance(kind, text);
  const normalized = normalizeForCompare(text);
  const memories = await aiMemoryDb.getAll();
  const existing = memories.find(
    (item) => !item.deleted && normalizeForCompare(item.content) === normalized,
  );

  let saved: AIMemoryItem | null = null;
  if (existing) {
    const mergedTags = [...new Set([...(existing.tags || []), ...tags])];
    saved =
      (await aiMemoryDb.update(existing.id, {
        content: trimMemoryContent(text),
        tags: mergedTags,
        kind,
        importance: Math.max(existing.importance ?? 0.5, importance),
        confidence: Math.max(existing.confidence ?? 0.5, candidate.confidence),
        updated_at: now,
        conversation_id: candidate.conversation_id ?? existing.conversation_id,
        scope: candidate.conversation_id ? "conversation" : existing.scope,
        deleted: false,
      })) ?? null;
  } else {
    const created: AIMemoryItem = {
      id: createId("mem"),
      content: trimMemoryContent(text),
      kind,
      tags,
      scope: candidate.conversation_id ? "conversation" : "global",
      conversation_id: candidate.conversation_id,
      importance,
      confidence: candidate.confidence,
      source: "user",
      created_at: now,
      updated_at: now,
      last_used_at: null,
      use_count: 0,
      deleted: false,
    };
    saved = await aiMemoryDb.create(created);
  }

  await dismissMemoryCandidate(candidateId);
  return saved;
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

export function buildMemoryPromptBlock(memories: AIMemoryItem[]): string {
  if (!memories.length) return "";

  const selected = memories.slice(0, MAX_MEMORIES_IN_PROMPT);
  const lines = selected.map((memory, index) => {
    const label =
      memory.kind === "constraint"
        ? "约束"
        : memory.kind === "goal"
          ? "目标"
          : memory.kind === "preference"
            ? "偏好"
            : "事实";
    return `${index + 1}. [${label}] ${trimMemoryContent(memory.content, 180)}`;
  });

  return [
    "以下是用户确认过的长期记忆，请在回答中优先遵循（如与当前明确指令冲突，以当前指令为准）：",
    ...lines,
  ].join("\n");
}
