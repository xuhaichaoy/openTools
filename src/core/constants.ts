/**
 * 全局常量集中管理
 *
 * 将散布在各文件中的魔法数字、默认值统一到此处，
 * 方便后续配置化和修改。
 */

// ── 窗口尺寸 ──
export const WINDOW_HEIGHT_COLLAPSED = 60;
export const WINDOW_HEIGHT_EXPANDED = 520;
export const WINDOW_HEIGHT_CHAT = 640;
export const WINDOW_HEIGHT_MAX = 460;
export const RESULT_ITEM_HEIGHT = 56;

// ── 对话/历史限制 ──
export const MAX_CONVERSATIONS = 50;
export const MAX_MESSAGES_PER_CONVERSATION = 100;

// ── AI 默认配置 ──
export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_AI_MODEL = "gpt-4o";
export const DEFAULT_AI_TEMPERATURE = 0.7;

// ── RAG 配置 ──
export const DEFAULT_RAG_CHUNK_SIZE = 512;
export const DEFAULT_RAG_CHUNK_OVERLAP = 50;
export const DEFAULT_RAG_TOP_K = 5;
export const DEFAULT_RAG_SCORE_THRESHOLD = 0.3;
export const DEFAULT_RAG_EMBEDDING_MODEL = "text-embedding-3-small";

// ── 持久化防抖 ──
export const PERSIST_DEBOUNCE_MS = 300;
