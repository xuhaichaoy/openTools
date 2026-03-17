import { JsonCollection, SyncableCollection, type SyncMeta } from "@/core/database/index";
import { invoke } from "@tauri-apps/api/core";
import { summarizeAISessionRuntimeText } from "./ai-session-runtime";
import {
  queueAppendDailyMemoryEntry,
  queueSyncConfirmedMemoriesToFile,
  readRecentDailyMemoryText,
} from "./file-memory";
import { estimateTokens } from "./token-utils";

export type AIMemoryKind = "preference" | "fact" | "goal" | "constraint" | "project_context" | "conversation_summary" | "session_note" | "knowledge" | "behavior";
export type AIMemoryScope = "global" | "conversation" | "workspace";
export type AIMemorySource = "user" | "assistant" | "system" | "agent";
export type AIMemoryCandidateMode = "ask" | "agent" | "cluster" | "dialog" | "system";
export type AIMemoryArchiveReason = "deleted" | "replaced" | "limit_trimmed";
export type AIMemoryCandidateReviewSurface = "inline" | "background";

export interface AIMemoryItem extends SyncMeta {
  id: string;
  content: string;
  kind: AIMemoryKind;
  tags: string[];
  scope: AIMemoryScope;
  conversation_id?: string;
  workspace_id?: string;
  importance: number;
  confidence: number;
  source: AIMemorySource;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
  deleted: boolean;
  archived_at?: number;
  archived_reason?: AIMemoryArchiveReason;
  replaced_by_memory_id?: string;
  supersedes_memory_ids?: string[];
}

export interface AIMemoryCandidate {
  id: string;
  content: string;
  reason: string;
  confidence: number;
  created_at: number;
  conversation_id?: string;
  workspace_id?: string;
  kind?: AIMemoryKind;
  scope?: AIMemoryScope;
  tags?: string[];
  source?: AIMemorySource;
  source_mode?: AIMemoryCandidateMode;
  evidence?: string;
  conflict_memory_ids?: string[];
  conflict_summary?: string;
  review_surface?: AIMemoryCandidateReviewSurface;
}

export interface CandidateSanitizeResult {
  ok: boolean;
  sanitized: string;
  reason?: string;
}

interface RecallOptions {
  conversationId?: string;
  workspaceId?: string;
  topK?: number;
}

interface MemoryCandidateBuildOptions {
  id?: string;
  reason?: string;
  confidence?: number;
  createdAt?: number;
  conversationId?: string;
  workspaceId?: string;
  kind?: AIMemoryKind;
  scope?: AIMemoryScope;
  tags?: string[];
  source?: AIMemorySource;
  sourceMode?: AIMemoryCandidateMode;
  evidence?: string;
  reviewSurface?: AIMemoryCandidateReviewSurface;
}

const DEFAULT_RECALL_TOP_K = 6;
const MAX_CANDIDATE_TEXT_LENGTH = 500;
const MAX_MEMORY_TEXT_LENGTH = 260;
const MAX_CANDIDATES = 60;
const MAX_MEMORIES_IN_PROMPT = 6;
const MAX_INJECTION_TOKENS = 2000;
const FACT_CONFIDENCE_THRESHOLD = 0.7;
const MAX_FACTS = 100;
const MAX_SESSION_NOTES_PER_SCOPE = 12;

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

const MEMORY_PROMPT_LEAK_PATTERNS: RegExp[] = [
  /you are a memory extraction system/i,
  /extract important facts about the user/i,
  /respond with valid json only/i,
  /return only valid json/i,
  /extract facts in this json format/i,
  /categories:\s*- preference:/i,
];

const EXPLICIT_CAPTURE_HINTS: RegExp[] = [
  /记住|记下来|帮我记/,
];
const LONG_TERM_CAPTURE_HINTS: RegExp[] = [
  /(?:以后|今后|长期|始终|一直|总是|默认).{0,18}(?:回答|回复|输出|使用|采用|遵循|优先|保留|用|按|写|提供|中文|英文|markdown|表格|代码块|简洁|详细|先给结论)/i,
  /(?:回答|回复|输出|使用|采用|遵循|优先|保留|用|按|写|提供).{0,18}(?:以后|今后|长期|始终|一直|总是|默认)/i,
  /(?:请始终|请一直|务必|必须|不要|禁止).{0,24}(?:回答|回复|输出|使用|采用|改动|删除|联网|透露|保存|先给结论|中文|英文|markdown|表格|代码)/i,
  /我的(?:偏好|习惯|角色|目标|长期要求)/,
  /我(?:更喜欢|习惯|通常会|一般会).{0,18}(?:回答|回复|输出|使用|采用|写|先)/,
];

const CONSTRAINT_HINTS = /(不要|不得|必须|禁止|务必|仅限)/;
const GOAL_HINTS = /(目标|里程碑|计划|推进|交付|上线)/;
const PREFERENCE_HINTS = /(默认|风格|格式|语气|模板|偏好|习惯|输出)/;
const KNOWLEDGE_HINTS = /(擅长|精通|熟悉|了解|会用|经验|专家|专长|掌握)/;
const BEHAVIOR_HINTS = /(习惯|通常|一般|总是|喜欢先|工作流|流程|方式)/;
const LONG_TERM_HINTS = /(以后|长期|默认|始终|总是|一直)/;
const CONVERSATION_SCOPE_HINTS = /(本次|这次|当前任务|当前对话|本会话|这一轮)/;
const LANGUAGE_SLOT_HINTS = /(中文|英文|英语|双语)/;
const VERBOSITY_SLOT_HINTS = /(简洁|简短|精简|详细|全面|展开)/;
const FORMAT_SLOT_HINTS = /(markdown|md|表格|代码块|纯文本|json)/i;
const STRUCTURE_SLOT_HINTS = /(先给结论|先说结论|先给答案|先给结果|先总结)/;
const CODING_STYLE_SLOT_HINTS = /(代码风格|命名风格|注释风格|测试风格)/;
const HOME_LOCATION_SLOT_HINTS = /(常驻地|常住地|常驻城市|所在城市|居住地|住在|长期所在地|默认城市|默认地点|天气默认地点|本地城市|用户常驻地)/;
const WEATHER_LOCATION_QUERY_HINTS = /(天气|气温|温度|预报|下雨|降雨|空气质量|湿度|紫外线|穿什么|本地时间|时差|附近|周边|餐厅|咖啡|酒店|路线|通勤)/;
const CODING_QUERY_HINTS = /(代码|编程|实现|函数|组件|修复|重构|typescript|javascript|rust|python|bug|测试|脚本|前端|后端|api)/i;
const AUTO_EXTRACT_TRANSIENT_PATTERNS: RegExp[] = [
  /^用户(?:正在|刚刚|当前|本次|这次|这一轮|尝试|想让|希望|要求|询问|请求|计划|打算)/,
  /当前(?:任务|会话|对话|房间)/,
  /(?:让|请).{0,16}(?:介绍自己|自我介绍)/,
  /(?:发送前审批|协作图|工作台|Dialog 房间|协作房间)/,
];
const DIALOG_META_PATTERNS: RegExp[] = [
  /\bCoordinator\b/i,
  /\bSpecialist\b/i,
  /多智能体|智能体协作|协作系统|协作房间|房间内|当前会话|Agent 持续协作房间/i,
];
const PROJECT_CONTEXT_SIGNAL_PATTERNS: RegExp[] = [
  /项目|仓库|代码库|repo|repository|技术栈|前端|后端|数据库|框架|目录结构|模块|组件|服务|workspace|工作区|根路径|语言[:：]/i,
];
const USER_BACKGROUND_PATTERNS: RegExp[] = [
  /用户(?:是|担任|从事|负责).{0,24}(?:工程师|开发者|设计师|产品经理|架构师|运维|测试|研究员|老师|学生)/,
  /我(?:是|担任|从事|负责).{0,24}(?:工程师|开发者|设计师|产品经理|架构师|运维|测试|研究员|老师|学生)/,
];

export const aiMemoryDb = new SyncableCollection<AIMemoryItem>("ai_memory");
export const aiMemoryCandidateDb = new JsonCollection<AIMemoryCandidate>(
  "ai_memory_candidates",
);

async function syncConfirmedMemoriesToFile(): Promise<void> {
  const all = await aiMemoryDb.getAll();
  await queueSyncConfirmedMemoriesToFile(all.filter((item) => !item.deleted));
}

function scheduleConfirmedMemoriesFileSync(): void {
  void syncConfirmedMemoriesToFile().catch(() => undefined);
}

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
  const normalized = normalizeWhitespace(text);
  if (!normalized) return false;
  if (EXPLICIT_CAPTURE_HINTS.some((pattern) => pattern.test(normalized))) return true;
  return LONG_TERM_CAPTURE_HINTS.some((pattern) => pattern.test(normalized));
}

function inferScope(
  text: string,
  kind: AIMemoryKind,
  conversationId?: string,
  workspaceId?: string,
): AIMemoryScope {
  if (CONVERSATION_SCOPE_HINTS.test(text)) return "conversation";
  if (kind === "project_context") {
    return workspaceId ? "workspace" : (conversationId ? "conversation" : "global");
  }
  if (kind === "conversation_summary") {
    return conversationId ? "conversation" : "global";
  }
  if (kind === "fact" && conversationId && !LONG_TERM_HINTS.test(text)) {
    return "conversation";
  }
  return "global";
}

function trimMemoryContent(text: string, max = MAX_MEMORY_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function trimCandidateEvidence(text: string, max = 180): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function containsAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && value.trim().length > 0))];
}

function memoryDisplayScope(scope: AIMemoryScope): string {
  switch (scope) {
    case "conversation":
      return "会话";
    case "workspace":
      return "工作区";
    default:
      return "全局";
  }
}

type MemoryPreferenceSlot =
  | "language"
  | "verbosity"
  | "format"
  | "structure"
  | "coding_style"
  | "home_location";

export interface AutomaticStructuredMemoryPlan {
  slot: MemoryPreferenceSlot;
  content: string;
  kind: AIMemoryKind;
  scope: AIMemoryScope;
  conversationId?: string;
  workspaceId?: string;
  tags: string[];
}

const AUTO_CONFIRM_MEMORY_SLOTS = new Set<MemoryPreferenceSlot>([
  "language",
  "verbosity",
  "format",
  "structure",
  "coding_style",
  "home_location",
]);

const STABLE_RESPONSE_MEMORY_SLOTS = new Set<MemoryPreferenceSlot>([
  "language",
  "verbosity",
  "format",
  "structure",
]);

function inferMemorySlot(
  text: string,
  kind: AIMemoryKind,
): MemoryPreferenceSlot | null {
  if (HOME_LOCATION_SLOT_HINTS.test(text)) return "home_location";
  if (kind !== "preference" && kind !== "constraint" && kind !== "behavior") {
    return null;
  }
  if (LANGUAGE_SLOT_HINTS.test(text)) return "language";
  if (VERBOSITY_SLOT_HINTS.test(text)) return "verbosity";
  if (FORMAT_SLOT_HINTS.test(text)) return "format";
  if (STRUCTURE_SLOT_HINTS.test(text)) return "structure";
  if (CODING_STYLE_SLOT_HINTS.test(text)) return "coding_style";
  return null;
}

function describeMemorySlot(slot: MemoryPreferenceSlot): string {
  switch (slot) {
    case "language":
      return "回答语言";
    case "verbosity":
      return "回答详略";
    case "format":
      return "输出格式";
    case "structure":
      return "回答结构";
    case "coding_style":
      return "代码风格";
    case "home_location":
      return "常驻地";
    default:
      return "偏好槽位";
  }
}

function extractLocationValue(text: string): string | null {
  const patterns = [
    /(?:常驻地|常住地|常驻城市|所在城市|居住地|长期所在地)(?:是|为|在)?[:：]?\s*([^，。；,\n]{2,24})/,
    /我(?:住在|常驻在|长期在)[:：]?\s*([^，。；,\n]{2,24})/,
    /(?:查|问).{0,8}(?:天气|气温|预报).{0,10}(?:默认|按|用)[:：]?\s*([^，。；,\n]{2,24})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const value = match[1]
      .replace(/^(是|为|在|按|用)\s*/u, "")
      .replace(/\s*(查天气|天气|气温|预报|回答|处理|查询|记住|保存).*$/u, "")
      .trim();
    if (value.length >= 2 && value.length <= 24) {
      return value;
    }
  }
  return null;
}

function normalizeLanguageValue(text: string): string | null {
  if (/双语/.test(text)) return "双语";
  if (/(中文|汉语|普通话)/.test(text)) return "中文";
  if (/(英文|英语)/.test(text)) return "英文";
  return null;
}

function normalizeVerbosityValue(text: string): string | null {
  if (/(简洁|简短|精简)/.test(text)) return "简洁";
  if (/(详细|全面|展开)/.test(text)) return "详细";
  return null;
}

function normalizeFormatValue(text: string): string | null {
  if (/(markdown|md)/i.test(text)) return "Markdown";
  if (/表格/.test(text)) return "表格";
  if (/json/i.test(text)) return "JSON";
  if (/纯文本/.test(text)) return "纯文本";
  if (/代码块/.test(text)) return "代码块";
  return null;
}

function normalizeStructureValue(text: string): string | null {
  if (/(先给结论|先说结论|先给答案|先给结果|先总结)/.test(text)) {
    return "先给结论，再展开";
  }
  return null;
}

function buildStructuredMemoryContent(
  slot: MemoryPreferenceSlot,
  text: string,
): string | null {
  switch (slot) {
    case "language": {
      const value = normalizeLanguageValue(text);
      return value ? `默认回答语言：${value}` : null;
    }
    case "verbosity": {
      const value = normalizeVerbosityValue(text);
      return value ? `默认回答详略：${value}` : null;
    }
    case "format": {
      const value = normalizeFormatValue(text);
      return value ? `默认输出格式：${value}` : null;
    }
    case "structure": {
      const value = normalizeStructureValue(text);
      return value ? `默认回答结构：${value}` : null;
    }
    case "coding_style":
      return text;
    case "home_location": {
      const value = extractLocationValue(text);
      return value ? `用户常驻地：${value}` : null;
    }
    default:
      return null;
  }
}

function inferQueryMemorySlots(query: string): Set<MemoryPreferenceSlot> {
  const normalized = normalizeWhitespace(query);
  const slots = new Set<MemoryPreferenceSlot>();
  if (WEATHER_LOCATION_QUERY_HINTS.test(normalized)) {
    slots.add("home_location");
  }
  if (CODING_QUERY_HINTS.test(normalized)) {
    slots.add("coding_style");
  }
  return slots;
}

function planAutomaticStructuredMemorySaves(
  text: string,
  opts?: { conversationId?: string; workspaceId?: string },
): AutomaticStructuredMemoryPlan[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  if (!containsAnyPattern(normalized, EXPLICIT_CAPTURE_HINTS)) return [];

  const inferredKind = inferKind(normalized);
  const slots: MemoryPreferenceSlot[] = [
    "home_location",
    "language",
    "verbosity",
    "format",
    "structure",
    "coding_style",
  ];

  const plans: AutomaticStructuredMemoryPlan[] = [];

  for (const slot of slots) {
    if (!AUTO_CONFIRM_MEMORY_SLOTS.has(slot)) continue;

    const content = buildStructuredMemoryContent(slot, normalized);
    if (!content) continue;
    if (slot === "coding_style" && !CODING_STYLE_SLOT_HINTS.test(normalized)) {
      continue;
    }

    const kind: AutomaticStructuredMemoryPlan["kind"] = slot === "home_location"
      ? "fact"
      : inferredKind === "constraint"
        ? "constraint"
        : "preference";
    const scope = inferScope(normalized, kind, opts?.conversationId, opts?.workspaceId);

    plans.push({
      slot,
      content,
      kind,
      scope,
      conversationId: opts?.conversationId,
      workspaceId: opts?.workspaceId,
      tags: uniqueStrings([
        `slot:${slot}`,
        slot === "home_location" ? "location" : undefined,
        "structured_memory",
        "auto_confirmed",
      ]),
    });
  }

  return plans;
}

export function planAutomaticStructuredMemorySave(
  text: string,
  opts?: { conversationId?: string; workspaceId?: string },
): AutomaticStructuredMemoryPlan | null {
  return planAutomaticStructuredMemorySaves(text, opts)[0] ?? null;
}

function buildMemoryCandidate(
  content: string,
  options: MemoryCandidateBuildOptions = {},
): AIMemoryCandidate | null {
  const sanitized = sanitizeCandidateStrict(content);
  if (!sanitized.ok) return null;

  const text = sanitized.sanitized;
  const kind = options.kind ?? inferKind(text);
  const scope = options.scope ?? inferScope(text, kind, options.conversationId, options.workspaceId);

  return {
    id: options.id ?? createId("memc"),
    content: text,
    reason: options.reason ?? "从对话中提取的长期记忆候选",
    confidence: clamp(options.confidence ?? 0.8, 0.1, 1),
    created_at: options.createdAt ?? Date.now(),
    conversation_id: options.conversationId,
    workspace_id: options.workspaceId,
    kind,
    scope,
    tags: uniqueStrings([...(options.tags || []), ...inferTags(text)]),
    source: options.source ?? "user",
    source_mode: options.sourceMode,
    evidence: trimCandidateEvidence(options.evidence ?? text),
    review_surface: options.reviewSurface ?? inferCandidateReviewSurface(text, options.source),
  };
}

function inferCandidateReviewSurface(
  text: string,
  source?: AIMemorySource,
): AIMemoryCandidateReviewSurface {
  if ((source ?? "user") !== "user") {
    return "background";
  }
  return containsAnyPattern(text, EXPLICIT_CAPTURE_HINTS) ? "inline" : "background";
}

function detectCandidateConflicts(
  candidate: AIMemoryCandidate,
  confirmedMemories: AIMemoryItem[],
): {
  ids: string[];
  summary?: string;
} {
  const kind = candidate.kind ?? inferKind(candidate.content);
  const slot = inferMemorySlot(candidate.content, kind);
  if (!slot) {
    return { ids: [] };
  }

  const normalized = normalizeForCompare(candidate.content);
  const conflicts = confirmedMemories.filter((memory) => {
    if (memory.deleted) return false;
    if (memory.scope !== candidate.scope) {
      return false;
    }
    if (
      candidate.scope === "conversation"
      && memory.conversation_id
      && candidate.conversation_id
      && memory.conversation_id !== candidate.conversation_id
    ) {
      return false;
    }
    if (
      candidate.scope === "workspace"
      && memory.workspace_id
      && candidate.workspace_id
      && memory.workspace_id !== candidate.workspace_id
    ) {
      return false;
    }
    if (normalizeForCompare(memory.content) === normalized) return false;
    return inferMemorySlot(memory.content, memory.kind) === slot;
  });

  if (!conflicts.length) {
    return { ids: [] };
  }

  return {
    ids: conflicts.map((memory) => memory.id),
    summary: `${describeMemorySlot(slot)} 已有 ${conflicts.length} 条正式记忆，确认前请留意是否需要替换旧偏好。`,
  };
}

function enrichMemoryCandidate(
  candidate: AIMemoryCandidate,
  confirmedMemories: AIMemoryItem[],
): AIMemoryCandidate | null {
  const rebuilt = buildMemoryCandidate(candidate.content, {
    id: candidate.id,
    reason: candidate.reason,
    confidence: candidate.confidence,
    createdAt: candidate.created_at,
    conversationId: candidate.conversation_id,
    workspaceId: candidate.workspace_id,
    kind: candidate.kind,
    scope: candidate.scope,
    tags: candidate.tags,
    source: candidate.source,
    sourceMode: candidate.source_mode,
    evidence: candidate.evidence,
    reviewSurface: candidate.review_surface,
  });
  if (!rebuilt) return null;

  const conflicts = detectCandidateConflicts(rebuilt, confirmedMemories);
  return {
    ...rebuilt,
    conflict_memory_ids: uniqueStrings([
      ...(candidate.conflict_memory_ids || []),
      ...conflicts.ids,
    ]),
    conflict_summary: candidate.conflict_summary ?? conflicts.summary,
  };
}

function mergeMemoryCandidates(
  current: AIMemoryCandidate,
  incoming: AIMemoryCandidate,
): AIMemoryCandidate {
  const newer = incoming.created_at >= current.created_at ? incoming : current;
  const older = newer === incoming ? current : incoming;
  return {
    ...older,
    ...newer,
    confidence: Math.max(current.confidence, incoming.confidence),
    tags: uniqueStrings([...(current.tags || []), ...(incoming.tags || [])]),
    conflict_memory_ids: uniqueStrings([
      ...(current.conflict_memory_ids || []),
      ...(incoming.conflict_memory_ids || []),
    ]),
    evidence: newer.evidence || older.evidence,
    conflict_summary: newer.conflict_summary || older.conflict_summary,
    review_surface:
      current.review_surface === "inline" || incoming.review_surface === "inline"
        ? "inline"
        : newer.review_surface ?? older.review_surface,
  };
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
  if (MEMORY_PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(sanitized))) {
    return { ok: false, sanitized: "", reason: "prompt_leak" };
  }
  return { ok: true, sanitized };
}

export function extractMemoryCandidates(
  userInput: string,
  opts?: {
    conversationId?: string;
    workspaceId?: string;
    kind?: AIMemoryKind;
    scope?: AIMemoryScope;
    source?: AIMemorySource;
    sourceMode?: AIMemoryCandidateMode;
    reason?: string;
    evidence?: string;
  },
): AIMemoryCandidate[] {
  if (!shouldCapture(userInput)) return [];
  const confidence = /记住|请始终|务必|默认/.test(userInput) ? 0.9 : 0.75;
  const candidate = buildMemoryCandidate(userInput, {
    conversationId: opts?.conversationId,
    kind: opts?.kind,
    scope: opts?.scope,
    source: opts?.source ?? "user",
    sourceMode: opts?.sourceMode,
    reason: opts?.reason ?? "从用户明确的长期偏好/事实指令中提取",
    confidence,
    evidence: opts?.evidence ?? userInput,
    workspaceId: opts?.workspaceId,
  });
  return candidate ? [candidate] : [];
}

export async function appendMemoryCandidates(
  candidates: AIMemoryCandidate[],
): Promise<void> {
  if (!candidates.length) return;
  const confirmed = (await aiMemoryDb.getAll()).filter((item) => !item.deleted);
  const confirmedSet = new Set(
    confirmed.map((item) => normalizeForCompare(item.content)),
  );
  const existing = await aiMemoryCandidateDb.getAll();
  const merged = [...candidates, ...existing];
  const dedup = new Map<string, AIMemoryCandidate>();

  for (const candidate of merged) {
    const prepared = enrichMemoryCandidate(candidate, confirmed);
    if (!prepared) continue;
    const key = normalizeForCompare(prepared.content);
    if (!key) continue;
    if (confirmedSet.has(key)) continue;
    if (!dedup.has(key)) {
      dedup.set(key, prepared);
      continue;
    }
    dedup.set(key, mergeMemoryCandidates(dedup.get(key)!, prepared));
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

export async function listArchivedMemories(): Promise<AIMemoryItem[]> {
  const all = await aiMemoryDb.getAll();
  return [...all]
    .filter((item) => item.deleted)
    .sort((a, b) => (b.archived_at || b.updated_at || 0) - (a.archived_at || a.updated_at || 0));
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const now = Date.now();
  await aiMemoryDb.update(memoryId, {
    deleted: true,
    updated_at: now,
    archived_at: now,
    archived_reason: "deleted",
  });
  invalidateMemoryVectorIndex();
  scheduleConfirmedMemoriesFileSync();
}

async function applyReplacementAudit(
  savedMemoryId: string,
  replacedMemoryIds: string[],
): Promise<void> {
  const ids = uniqueStrings(replacedMemoryIds);
  if (ids.length === 0) return;

  const now = Date.now();
  const all = await aiMemoryDb.getAll();
  const saved = all.find((memory) => memory.id === savedMemoryId);
  if (saved) {
    await aiMemoryDb.update(savedMemoryId, {
      supersedes_memory_ids: uniqueStrings([
        ...(saved.supersedes_memory_ids || []),
        ...ids,
      ]),
      updated_at: now,
    });
  }

  await Promise.all(
    ids.map((memoryId) =>
      aiMemoryDb.update(memoryId, {
        deleted: true,
        updated_at: now,
        archived_at: now,
        archived_reason: "replaced",
        replaced_by_memory_id: savedMemoryId,
      })),
  );
  scheduleConfirmedMemoriesFileSync();
}

export async function confirmMemoryCandidate(
  candidateId: string,
  options?: { replaceConflicts?: boolean },
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
    kind: candidate.kind,
    conversationId: candidate.conversation_id,
    workspaceId: candidate.workspace_id,
    scope: candidate.scope,
    confidence: candidate.confidence,
    source: candidate.source ?? "user",
    tags: candidate.tags,
  });
  if (saved && options?.replaceConflicts && candidate.conflict_memory_ids?.length) {
    await applyReplacementAudit(saved.id, candidate.conflict_memory_ids);
    invalidateMemoryVectorIndex();
  }
  await dismissMemoryCandidate(candidateId);
  return saved;
}

export async function saveAutomaticStructuredMemory(
  text: string,
  opts?: { conversationId?: string; workspaceId?: string },
): Promise<AIMemoryItem | null> {
  const plans = planAutomaticStructuredMemorySaves(text, opts);
  if (plans.length === 0) return null;

  let firstSaved: AIMemoryItem | null = null;
  for (const plan of plans) {
    const confirmedMemories = (await aiMemoryDb.getAll()).filter((item) => !item.deleted);
    const probe = buildMemoryCandidate(plan.content, {
      conversationId: plan.conversationId,
      workspaceId: plan.workspaceId,
      kind: plan.kind,
      scope: plan.scope,
      source: "user",
      tags: plan.tags,
      confidence: 0.94,
      reviewSurface: "inline",
    });
    const conflicts = probe
      ? detectCandidateConflicts(probe, confirmedMemories).ids
      : [];

    const saved = await saveConfirmedMemory(plan.content, {
      kind: plan.kind,
      source: "user",
      conversationId: plan.conversationId,
      workspaceId: plan.workspaceId,
      scope: plan.scope,
      confidence: 0.94,
      importance: slotImportance(plan.slot),
      tags: plan.tags,
    });
    if (saved && conflicts.length > 0) {
      await applyReplacementAudit(saved.id, conflicts);
      invalidateMemoryVectorIndex();
    }
    if (!firstSaved && saved) {
      firstSaved = saved;
    }
  }
  return firstSaved;
}

function slotImportance(slot: MemoryPreferenceSlot): number {
  if (slot === "home_location") return 0.82;
  if (slot === "coding_style") return 0.84;
  return 0.88;
}

export async function saveConfirmedMemory(
  content: string,
  options?: {
    kind?: AIMemoryKind;
    source?: AIMemorySource;
    conversationId?: string;
    workspaceId?: string;
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
        workspace_id: options?.workspaceId ?? existing.workspace_id,
        scope: options?.scope
          ?? (
            options?.workspaceId
              ? "workspace"
              : options?.conversationId
                ? "conversation"
                : existing.scope
        ),
        deleted: false,
        archived_at: undefined,
        archived_reason: undefined,
        replaced_by_memory_id: undefined,
      })) ?? null;
    if (updated) {
      invalidateMemoryVectorIndex();
      scheduleConfirmedMemoriesFileSync();
    }
    return updated;
  }

  const created = await aiMemoryDb.create({
    id: createId("mem"),
    content: trimMemoryContent(text),
    kind,
    tags: mergedTags,
    scope: options?.scope ?? (
      options?.workspaceId
        ? "workspace"
        : options?.conversationId
          ? "conversation"
          : "global"
    ),
    conversation_id: options?.conversationId,
    workspace_id: options?.workspaceId,
    importance,
    confidence,
    source: options?.source ?? "user",
    created_at: now,
    updated_at: now,
    last_used_at: null,
    use_count: 0,
    deleted: false,
    archived_at: undefined,
    archived_reason: undefined,
    replaced_by_memory_id: undefined,
    supersedes_memory_ids: [],
  });
  invalidateMemoryVectorIndex();
  scheduleConfirmedMemoriesFileSync();
  return created;
}

function scoreMemory(
  memory: AIMemoryItem,
  queryTokens: string[],
  queryText: string,
  options?: RecallOptions,
): number {
  if (memory.kind === "session_note" && !options?.conversationId && !options?.workspaceId) {
    return -1;
  }
  if (
    memory.scope === "conversation"
    && options?.conversationId
    && memory.conversation_id
    && options.conversationId !== memory.conversation_id
  ) {
    return -1;
  }
  if (
    memory.scope === "workspace"
    && options?.workspaceId
    && memory.workspace_id
    && options.workspaceId !== memory.workspace_id
  ) {
    return -1;
  }
  const memoryTokens = tokenize(memory.content);
  const overlapCount = queryTokens.filter((token) => memoryTokens.includes(token)).length;
  const overlapScore =
    queryTokens.length > 0 ? overlapCount / queryTokens.length : 0;

  const tagScore =
    memory.tags.length > 0 && queryTokens.length > 0
      ? memory.tags.filter((tag) => queryTokens.includes(tag.toLowerCase())).length *
        0.1
      : 0;

  const queryPhrase = queryTokens.join(" ");
  const fullTextMatch =
    queryPhrase && normalizeForCompare(memory.content).includes(queryPhrase) ? 0.15 : 0;

  const conversationBoost =
    options?.conversationId &&
    memory.conversation_id &&
    options.conversationId === memory.conversation_id
      ? 0.35
      : 0;
  const workspaceBoost =
    options?.workspaceId &&
    memory.workspace_id &&
    options.workspaceId === memory.workspace_id
      ? 0.28
      : 0;

  const kindBoost = memory.kind === "preference" || memory.kind === "constraint" ? 0.08 : 0;
  const slot = inferMemorySlot(memory.content, memory.kind);
  const querySlotHints = inferQueryMemorySlots(queryText);
  const stableStructuredBoost = slot && STABLE_RESPONSE_MEMORY_SLOTS.has(slot) && memory.scope === "global"
    ? 0.06
    : 0;
  const slotQueryBoost = slot && querySlotHints.has(slot)
    ? (slot === "home_location" ? 0.34 : 0.18)
    : 0;
  const sessionNoteBoost = memory.kind === "session_note"
    ? (
        (options?.conversationId && memory.conversation_id === options.conversationId ? 0.22 : 0)
        + (options?.workspaceId && memory.workspace_id === options.workspaceId ? 0.18 : 0)
      )
    : 0;
  const usageBoost = Math.min(memory.use_count || 0, 15) * 0.01;
  const importanceBoost = clamp(memory.importance ?? 0.5, 0, 1) * 0.2;

  return overlapScore * 0.45 + tagScore + fullTextMatch + conversationBoost + workspaceBoost + kindBoost + stableStructuredBoost + slotQueryBoost + sessionNoteBoost + usageBoost + importanceBoost;
}

export function rankMemoriesForRecall(
  memories: AIMemoryItem[],
  query: string,
  options?: RecallOptions,
): AIMemoryItem[] {
  const queryTokens = tokenize(query);
  const normalizedQuery = normalizeWhitespace(query);
  const topK = options?.topK ?? DEFAULT_RECALL_TOP_K;

  const ranked = memories
    .filter((item) => !item.deleted)
    .map((item) => ({ item, score: scoreMemory(item, queryTokens, normalizedQuery, options) }))
    .filter(({ score }) => score > 0.08 || (queryTokens.length === 0 && score >= 0))
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
  session_note: "会话笔记",
  fact: "事实",
};

const PROMPT_GROUPS: Array<{
  title: string;
  match: (memory: AIMemoryItem) => boolean;
}> = [
  {
    title: "必须遵守",
    match: (memory) => memory.kind === "constraint",
  },
  {
    title: "用户偏好",
    match: (memory) => memory.kind === "preference" || memory.kind === "behavior",
  },
  {
    title: "当前目标与上下文",
    match: (memory) =>
      memory.kind === "goal"
      || memory.kind === "project_context"
      || memory.kind === "conversation_summary"
      || memory.kind === "session_note",
  },
  {
    title: "相关知识与事实",
    match: () => true,
  },
];

export function buildMemoryPromptBlock(
  memories: AIMemoryItem[],
  maxTokens: number = MAX_INJECTION_TOKENS,
): string {
  if (!memories.length) return "";

  const header = "以下是已保存的用户长期记忆与当前会话笔记，请在回答中优先利用（如与当前明确指令冲突，以当前指令为准）：";
  let tokenBudget = maxTokens - estimateTokens(header);
  let usedMemoryCount = 0;
  const lines: string[] = [];
  const seenIds = new Set<string>();

  for (const group of PROMPT_GROUPS) {
    if (usedMemoryCount >= MAX_MEMORIES_IN_PROMPT) break;

    const groupItems = memories.filter((memory) => {
      if (seenIds.has(memory.id)) return false;
      return group.match(memory);
    });
    if (!groupItems.length) continue;

    const groupLines: string[] = [];
    for (const memory of groupItems) {
      if (usedMemoryCount >= MAX_MEMORIES_IN_PROMPT) break;
      const label = KIND_LABELS[memory.kind] ?? "事实";
      const line = `- [${label}] ${trimMemoryContent(memory.content, 180)}`;
      const lineCost = estimateTokens(line);
      if (lineCost > tokenBudget) break;
      groupLines.push(line);
      tokenBudget -= lineCost;
      usedMemoryCount += 1;
      seenIds.add(memory.id);
    }

    if (!groupLines.length) continue;
    const titleLine = `【${group.title}】`;
    const titleCost = estimateTokens(titleLine);
    if (titleCost > tokenBudget) break;
    tokenBudget -= titleCost;
    lines.push(titleLine, ...groupLines);
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
  project_context: "project_context",
  conversation_summary: "conversation_summary",
  session_note: "session_note",
  behavior: "behavior",
  goal: "goal",
  constraint: "constraint",
};

function buildSessionNoteScope(options?: {
  conversationId?: string;
  workspaceId?: string;
}): AIMemoryScope | null {
  if (options?.workspaceId) return "workspace";
  if (options?.conversationId) return "conversation";
  return null;
}

async function trimExcessSessionNotes(
  scope: AIMemoryScope,
  options?: {
    conversationId?: string;
    workspaceId?: string;
  },
): Promise<void> {
  const all = await aiMemoryDb.getAll();
  const scopedNotes = all
    .filter((item) => {
      if (item.deleted || item.kind !== "session_note" || item.scope !== scope) return false;
      if (scope === "conversation") {
        return item.conversation_id === options?.conversationId;
      }
      if (scope === "workspace") {
        return item.workspace_id === options?.workspaceId;
      }
      return false;
    })
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  const overflow = scopedNotes.slice(MAX_SESSION_NOTES_PER_SCOPE);
  if (overflow.length === 0) return;

  const now = Date.now();
  await Promise.all(
    overflow.map((item) =>
      aiMemoryDb.update(item.id, {
        deleted: true,
        updated_at: now,
        archived_at: now,
        archived_reason: "limit_trimmed",
      }),
    ),
  );
}

export async function saveSessionMemoryNote(
  content: string,
  options?: {
    conversationId?: string;
    workspaceId?: string;
    source?: AIMemorySource;
  },
): Promise<AIMemoryItem | null> {
  const scope = buildSessionNoteScope(options);
  if (!scope) return null;

  const normalized = normalizeWhitespace(content);
  const summarized = summarizeAISessionRuntimeText(normalized, 220);
  if (!summarized || summarized.length < 12) return null;

  const saved = await saveConfirmedMemory(summarized, {
    kind: "session_note",
    source: options?.source ?? "assistant",
    conversationId: options?.conversationId,
    workspaceId: options?.workspaceId,
    scope,
    confidence: 0.72,
    importance: 0.45,
    tags: ["session_note"],
  });

  if (saved) {
    await trimExcessSessionNotes(scope, options);
    invalidateMemoryVectorIndex();
    void queueAppendDailyMemoryEntry({
      content: saved.content,
      kind: saved.kind,
      source: options?.source ?? "assistant",
      scope,
      conversationId: options?.conversationId,
      workspaceId: options?.workspaceId,
      timestamp: saved.updated_at,
    }).catch(() => undefined);
  }

  return saved;
}

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
  options?: {
    scope?: AIMemoryScope;
    conversationId?: string;
    workspaceId?: string;
    source?: AIMemorySource;
  },
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
        source: options?.source ?? existing.source,
        conversation_id: options?.conversationId ?? existing.conversation_id,
        workspace_id: options?.workspaceId ?? existing.workspace_id,
        scope: options?.scope ?? (
          options?.workspaceId
            ? "workspace"
            : options?.conversationId
              ? "conversation"
              : existing.scope
        ),
        updated_at: now,
        use_count: (existing.use_count || 0) + 1,
        deleted: false,
        archived_at: undefined,
        archived_reason: undefined,
        replaced_by_memory_id: undefined,
      })) ?? null
    );
    if (updated) {
      invalidateMemoryVectorIndex();
      scheduleConfirmedMemoriesFileSync();
    }
    return updated;
  }

  const created = await aiMemoryDb.create({
    id: createId("mem"),
    content: trimMemoryContent(text),
    kind,
    tags,
    scope: options?.scope ?? (
      options?.workspaceId
        ? "workspace"
        : options?.conversationId
          ? "conversation"
          : "global"
    ),
    conversation_id: options?.conversationId,
    workspace_id: options?.workspaceId,
    importance,
    confidence: 0.8,
    source: options?.source ?? "agent",
    created_at: now,
    updated_at: now,
    last_used_at: null,
    use_count: 1,
    deleted: false,
    archived_at: undefined,
    archived_reason: undefined,
    replaced_by_memory_id: undefined,
    supersedes_memory_ids: [],
  });
  invalidateMemoryVectorIndex();
  scheduleConfirmedMemoriesFileSync();
  return created;
}

export async function queueMemoryCandidateFromAgent(
  key: string,
  value: string,
  category: string = "preference",
  opts?: {
    conversationId?: string;
    workspaceId?: string;
    sourceMode?: AIMemoryCandidateMode;
    reason?: string;
    evidence?: string;
  },
): Promise<AIMemoryCandidate | null> {
  const content = composeAgentMemoryContent(key, value);
  const kind = AGENT_KIND_MAP[category] ?? inferKind(content);
  const candidate = buildMemoryCandidate(content, {
    conversationId: opts?.conversationId,
    workspaceId: opts?.workspaceId,
    kind,
    source: "agent",
    sourceMode: opts?.sourceMode ?? "agent",
    reason: opts?.reason ?? "Agent 建议保存用户长期记忆，等待确认后才会生效",
    confidence: 0.85,
    evidence: opts?.evidence ?? content,
    reviewSurface: "inline",
  });
  if (!candidate) return null;
  await appendMemoryCandidates([candidate]);
  return candidate;
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
      if (matched.length > 0) return rankMemoriesForRecall(matched, query, options);
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
        if (matched.length > 0) return rankMemoriesForRecall(matched, query, options);
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
  if (updated) {
    invalidateMemoryVectorIndex();
    scheduleConfirmedMemoriesFileSync();
  }
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

function extractBalancedJsonObject(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, index + 1);
        }
      }
    }
  }
  return null;
}

function parseLLMExtractedFacts(text: string): { facts?: LLMExtractedFact[] } | null {
  const normalized = String(text || "").trim();
  if (!normalized) return null;

  const directCandidates = [
    normalized,
    normalized.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim(),
  ];

  const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    directCandidates.push(fencedMatch[1].trim());
  }

  const balancedObject = extractBalancedJsonObject(normalized);
  if (balancedObject) {
    directCandidates.push(balancedObject);
  }

  for (const candidate of directCandidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as { facts?: LLMExtractedFact[] };
    } catch {
      continue;
    }
  }

  return null;
}

function normalizeLLMExtractedKind(category: string, content: string): AIMemoryKind {
  const mapped = AGENT_KIND_MAP[category] ?? inferKind(content);
  if (mapped !== "project_context") return mapped;
  if (containsAnyPattern(content, PROJECT_CONTEXT_SIGNAL_PATTERNS)) return mapped;
  if (containsAnyPattern(content, USER_BACKGROUND_PATTERNS)) return "knowledge";
  return "fact";
}

function shouldSkipLLMExtractedFact(content: string, kind: AIMemoryKind): boolean {
  const normalized = normalizeWhitespace(content);
  if (!normalized) return true;
  if (containsAnyPattern(normalized, MEMORY_PROMPT_LEAK_PATTERNS)) return true;
  if (containsAnyPattern(normalized, AUTO_EXTRACT_TRANSIENT_PATTERNS)) return true;
  if (
    containsAnyPattern(normalized, DIALOG_META_PATTERNS)
    && !containsAnyPattern(normalized, PROJECT_CONTEXT_SIGNAL_PATTERNS)
    && kind !== "knowledge"
  ) {
    return true;
  }
  return false;
}

function shouldAttemptAutomaticMemoryExtraction(
  content: string,
  source?: AIMemorySource,
): boolean {
  const normalized = normalizeWhitespace(content);
  if (!normalized || normalized.length < 20) return false;
  if (containsAnyPattern(normalized, MEMORY_PROMPT_LEAK_PATTERNS)) return false;
  if (containsAnyPattern(normalized, SENSITIVE_PATTERNS)) return false;
  if (containsAnyPattern(normalized, EPHEMERAL_PATTERNS)) return false;
  if (containsAnyPattern(normalized, AUTO_EXTRACT_TRANSIENT_PATTERNS)) return false;
  if (containsAnyPattern(normalized, EXPLICIT_CAPTURE_HINTS)) return true;
  if (containsAnyPattern(normalized, LONG_TERM_CAPTURE_HINTS)) return true;
  if (containsAnyPattern(normalized, USER_BACKGROUND_PATTERNS)) return true;
  if (containsAnyPattern(normalized, PROJECT_CONTEXT_SIGNAL_PATTERNS)) return true;
  return (source ?? "assistant") === "user" && shouldCapture(normalized);
}

const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction system. Analyze this conversation and extract only stable, reusable long-term facts about the user.

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
- Only extract clear, specific, reusable long-term facts
- Skip current requests, one-off tasks, and temporary actions
- Skip statements like "用户尝试..." / "用户正在..." / "当前会话..."
- Skip current room/agent topology, internal roles, UI state, system prompts, and tool instructions
- Preserve technical terms and proper nouns
- Do NOT extract file paths, session IDs, or ephemeral data
- Return ONLY valid JSON, no explanation`;

/**
 * LLM-based memory extraction from conversation content.
 * Falls back to regex-based heuristic when LLM is unavailable.
 */
export async function llmExtractMemories(
  conversationContent: string,
  opts?: {
    conversationId?: string;
    workspaceId?: string;
    source?: AIMemorySource;
    sourceMode?: AIMemoryCandidateMode;
    evidence?: string;
  },
): Promise<AIMemoryCandidate[]> {
  if (!conversationContent || conversationContent.length < 30) return [];
  const truncated = conversationContent.slice(0, 3000);
  const source = opts?.source ?? "assistant";

  if (!shouldAttemptAutomaticMemoryExtraction(truncated, source)) {
    return [];
  }

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
      skipMemory: true,
    });

    const parsed = parseLLMExtractedFacts(result.content);
    if (!parsed) return fallbackExtract(truncated, opts);
    if (!parsed.facts?.length) return [];

    const candidates: AIMemoryCandidate[] = [];
    for (const fact of parsed.facts) {
      if (fact.confidence < FACT_CONFIDENCE_THRESHOLD) continue;
      const kind = normalizeLLMExtractedKind(fact.category, fact.content);
      if (shouldSkipLLMExtractedFact(fact.content, kind)) continue;
      const candidate = buildMemoryCandidate(fact.content, {
        conversationId: opts?.conversationId,
        workspaceId: opts?.workspaceId,
        kind,
        source,
        sourceMode: opts?.sourceMode,
        reason: `AI 从对话中提取出 ${KIND_LABELS[kind] ?? fact.category} 候选`,
        confidence: clamp(fact.confidence, 0, 1),
        evidence: opts?.evidence ?? fact.content,
        reviewSurface: "background",
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }
    return candidates
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 2);
  } catch {
    return fallbackExtract(truncated, opts);
  }
}

export async function organizeRecentFileMemories(days: number = 5): Promise<AIMemoryCandidate[]> {
  const recentText = (await readRecentDailyMemoryText(days)).trim();
  if (!recentText) return [];

  const truncated = recentText.slice(0, 4000);

  try {
    const { getMToolsAI } = await import("@/core/ai/mtools-ai");
    const ai = getMToolsAI();
    const prompt = MEMORY_EXTRACTION_PROMPT.replace("{conversation}", truncated);

    const result = await ai.chat({
      messages: [
        {
          role: "system",
          content: "You extract structured long-term memory facts from recent daily notes. Respond with valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      skipTools: true,
      skipMemory: true,
    });

    const parsed = parseLLMExtractedFacts(result.content);
    if (!parsed?.facts?.length) return [];

    const candidates: AIMemoryCandidate[] = [];
    for (const fact of parsed.facts) {
      if (fact.confidence < FACT_CONFIDENCE_THRESHOLD) continue;
      const kind = normalizeLLMExtractedKind(fact.category, fact.content);
      if (shouldSkipLLMExtractedFact(fact.content, kind)) continue;
      const candidate = buildMemoryCandidate(fact.content, {
        kind,
        source: "assistant",
        sourceMode: "system",
        reason: "从最近的 daily memory 中整理出的长期记忆候选",
        confidence: clamp(fact.confidence, 0, 1),
        evidence: truncated,
        reviewSurface: "background",
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }

    if (candidates.length > 0) {
      await appendMemoryCandidates(candidates);
    }
    return candidates;
  } catch {
    const fallback = extractMemoryCandidates(truncated, {
      source: "assistant",
      sourceMode: "system",
      reason: "从最近的 daily memory 中整理出的长期记忆候选",
      evidence: truncated,
    });
    if (fallback.length > 0) {
      await appendMemoryCandidates(fallback);
    }
    return fallback;
  }
}

function fallbackExtract(
  text: string,
  opts?: {
    conversationId?: string;
    workspaceId?: string;
    source?: AIMemorySource;
    sourceMode?: AIMemoryCandidateMode;
    evidence?: string;
  },
): AIMemoryCandidate[] {
  if ((opts?.source ?? "assistant") !== "user") {
    return [];
  }
  return extractMemoryCandidates(text, {
    conversationId: opts?.conversationId,
    workspaceId: opts?.workspaceId,
    source: opts?.source ?? "assistant",
    sourceMode: opts?.sourceMode,
    reason: "从对话中匹配到明确的长期记忆提示词",
    evidence: opts?.evidence ?? text,
  });
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
  let changed = false;

  for (const candidate of candidates) {
    const sanitized = sanitizeCandidateStrict(candidate.content);
    if (!sanitized.ok) { skipped++; continue; }

    const normalized = normalizeForCompare(sanitized.sanitized);
    const match = activeMemories.find(
      (m) => normalizeForCompare(m.content) === normalized,
    );

    if (match) {
      if (candidate.confidence > (match.confidence ?? 0.5)) {
        const kind = candidate.kind ?? inferKind(sanitized.sanitized);
        await aiMemoryDb.update(match.id, {
          content: trimMemoryContent(sanitized.sanitized),
          kind,
          confidence: candidate.confidence,
          tags: uniqueStrings([
            ...(match.tags || []),
            ...(candidate.tags || []),
            ...inferTags(sanitized.sanitized),
          ]),
          importance: Math.max(match.importance ?? 0.5, inferImportance(kind, sanitized.sanitized)),
          scope: candidate.scope ?? match.scope,
          conversation_id: candidate.conversation_id ?? match.conversation_id,
          workspace_id: candidate.workspace_id ?? match.workspace_id,
          source: candidate.source ?? match.source,
          updated_at: Date.now(),
        });
        updated++;
        invalidateMemoryVectorIndex();
        changed = true;
      } else {
        skipped++;
      }
    } else {
      const kind = candidate.kind ?? inferKind(sanitized.sanitized);
      await aiMemoryDb.create({
        id: createId("mem"),
        content: trimMemoryContent(sanitized.sanitized),
        kind,
        tags: uniqueStrings([...(candidate.tags || []), ...inferTags(sanitized.sanitized)]),
        scope: candidate.scope ?? (
          candidate.workspace_id
            ? "workspace"
            : candidate.conversation_id
              ? "conversation"
              : "global"
        ),
        conversation_id: candidate.conversation_id,
        workspace_id: candidate.workspace_id,
        importance: inferImportance(kind, sanitized.sanitized),
        confidence: candidate.confidence,
        source: candidate.source ?? "system",
        created_at: Date.now(),
        updated_at: Date.now(),
        last_used_at: null,
        use_count: 0,
        deleted: false,
      });
      added++;
      invalidateMemoryVectorIndex();
      changed = true;
    }
  }

  // Enforce max facts limit
  const allAfter = await aiMemoryDb.getAll();
  const activeAfter = allAfter.filter((m) => !m.deleted);
  if (activeAfter.length > MAX_FACTS) {
    const sorted = activeAfter.sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5));
    const toDelete = sorted.slice(MAX_FACTS);
    for (const m of toDelete) {
      const now = Date.now();
      await aiMemoryDb.update(m.id, {
        deleted: true,
        updated_at: now,
        archived_at: now,
        archived_reason: "limit_trimmed",
      });
      invalidateMemoryVectorIndex();
      changed = true;
    }
  }

  if (changed) {
    scheduleConfirmedMemoriesFileSync();
  }

  return { added, updated, skipped };
}
