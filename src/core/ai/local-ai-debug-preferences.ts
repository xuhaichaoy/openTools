const LOCAL_AI_DEBUG_FLAGS_KEY = "mtools-ai-local-debug-flags";

export type AIDebugFlag =
  | "context_runtime"
  | "memory_pipeline"
  | "compaction"
  | "workspace_switch";

export type AIDebugFlagState = Record<AIDebugFlag, boolean>;

const DEFAULT_AI_DEBUG_FLAGS: AIDebugFlagState = {
  context_runtime: false,
  memory_pipeline: false,
  compaction: false,
  workspace_switch: false,
};

function canUseLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadAIDebugFlags(): AIDebugFlagState {
  if (!canUseLocalStorage()) {
    return { ...DEFAULT_AI_DEBUG_FLAGS };
  }

  try {
    const raw = localStorage.getItem(LOCAL_AI_DEBUG_FLAGS_KEY);
    if (!raw) {
      return { ...DEFAULT_AI_DEBUG_FLAGS };
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      context_runtime: parsed.context_runtime === true,
      memory_pipeline: parsed.memory_pipeline === true,
      compaction: parsed.compaction === true,
      workspace_switch: parsed.workspace_switch === true,
    };
  } catch {
    return { ...DEFAULT_AI_DEBUG_FLAGS };
  }
}

export function saveAIDebugFlags(
  patch: Partial<AIDebugFlagState>,
): AIDebugFlagState {
  const next = {
    ...loadAIDebugFlags(),
    ...patch,
  };

  if (!canUseLocalStorage()) {
    return next;
  }

  try {
    localStorage.setItem(LOCAL_AI_DEBUG_FLAGS_KEY, JSON.stringify(next));
  } catch {
    // ignore local persistence failures
  }

  return next;
}

export function isAIDebugFlagEnabled(flag: AIDebugFlag): boolean {
  return loadAIDebugFlags()[flag] === true;
}
