import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AgentContextRuntimeDebugReport } from "@/core/agent/context-runtime/debug-types";
import type { CodingExecutionProfile } from "@/core/agent/coding-profile";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type {
  AgentScheduledTask,
  AgentScheduleType,
  AgentTaskOriginMode,
  AgentTaskSkippedEvent,
  AgentTaskStatus,
  AgentTaskStatusPatch,
} from "@/core/ai/types";
import { handleError } from "@/core/errors";
import { MAX_CONVERSATIONS } from "@/core/constants";
import { createDebouncedPersister } from "@/core/storage";
import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { AICenterHandoff } from "@/store/app-store";
import { buildRecoveredAgentTaskPatch } from "@/plugins/builtin/SmartAgent/core/agent-task-state";
import { useAISessionRuntimeStore } from "@/store/ai-session-runtime-store";
import type { AgentQueryIntent } from "@/core/agent/context-runtime/types";

/** 单个任务（一次用户提问 + Agent 执行流程） */
export interface AgentTask {
  id: string;
  query: string;
  /** 用户附带的图片路径 */
  images?: string[];
  /** 非图片附件或显式工作集路径 */
  attachmentPaths?: string[];
  createdAt?: number;
  steps: AgentStep[];
  answer: string | null;
  status?: AgentTaskStatus;
  schedule_type?: AgentScheduleType;
  schedule_value?: string;
  retry_count?: number;
  next_run_at?: number;
  last_error?: string;
  last_started_at?: number;
  last_finished_at?: number;
  last_duration_ms?: number;
  last_result_status?: "success" | "error" | "skipped";
  memoryRecallAttempted?: boolean;
  appliedMemoryIds?: string[];
  appliedMemoryPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  appliedTranscriptPreview?: string[];
}

export interface AgentQueuedFollowUp {
  id: string;
  query: string;
  images?: string[];
  attachmentPaths?: string[];
  systemHint?: string;
  codingHint?: string;
  runProfile?: CodingExecutionProfile;
  sourceHandoff?: AICenterHandoff;
  forceNewSession?: boolean;
  createdAt: number;
}

export interface AgentSessionCompaction {
  summary: string;
  compactedTaskCount: number;
  lastCompactedAt: number;
  reason?: "task_count" | "step_count" | "context_recovery";
  preservedIdentifiers?: string[];
  preservedToolNames?: string[];
  bootstrapReinjectionPreview?: string[];
  workspaceRootAtCompaction?: string;
}

export interface AgentSessionForkMeta {
  parentSessionId: string;
  parentVisibleTaskCount: number;
  createdAt: number;
}

export interface AgentSession {
  id: string;
  title: string;
  tasks: AgentTask[];
  createdAt: number;
  workspaceRoot?: string;
  repoRoot?: string;
  lastActivePaths?: string[];
  lastTaskIntent?: AgentQueryIntent;
  workspaceLocked?: boolean;
  workspaceLockReason?: "user" | "session_policy";
  lastSoftResetAt?: number;
  lastContinuityStrategy?: string;
  lastContinuityReason?: string;
  lastContextResetAt?: number;
  lastMemoryItemCount?: number;
  lastMemoryRecallAttempted?: boolean;
  lastMemoryRecallPreview?: string[];
  lastTranscriptRecallAttempted?: boolean;
  lastTranscriptRecallHitCount?: number;
  lastTranscriptRecallPreview?: string[];
  lastSessionNotePreview?: string;
  lastContextRuntimeReport?: AgentContextRuntimeDebugReport;
  /** 跨模式 handoff 来源信息（如从 Ask 切换到 Agent） */
  sourceHandoff?: AICenterHandoff;
  /** 当前可见的任务数量；未设置表示全部可见 */
  visibleTaskCount?: number;
  followUpQueue?: AgentQueuedFollowUp[];
  forkMeta?: AgentSessionForkMeta;
  compaction?: AgentSessionCompaction;
}

function clampVisibleTaskCount(
  tasksLength: number,
  visibleTaskCount?: number,
): number {
  if (typeof visibleTaskCount !== "number" || Number.isNaN(visibleTaskCount)) {
    return tasksLength;
  }
  return Math.max(0, Math.min(tasksLength, Math.floor(visibleTaskCount)));
}

export function getAgentSessionVisibleTaskCount(
  session: Pick<AgentSession, "tasks" | "visibleTaskCount">,
): number {
  return clampVisibleTaskCount(session.tasks.length, session.visibleTaskCount);
}

export function getVisibleAgentTasks(
  session: Pick<AgentSession, "tasks" | "visibleTaskCount">,
): AgentTask[] {
  return session.tasks.slice(0, getAgentSessionVisibleTaskCount(session));
}

export function getHiddenAgentTasks(
  session: Pick<AgentSession, "tasks" | "visibleTaskCount">,
): AgentTask[] {
  return session.tasks.slice(getAgentSessionVisibleTaskCount(session));
}

export function hasAgentSessionHiddenTasks(
  session: Pick<AgentSession, "tasks" | "visibleTaskCount">,
): boolean {
  return getAgentSessionVisibleTaskCount(session) < session.tasks.length;
}

export function getAgentSessionCompactedTaskCount(
  session: Pick<AgentSession, "tasks" | "visibleTaskCount" | "compaction">,
): number {
  const visibleCount = getAgentSessionVisibleTaskCount(session);
  const compactedTaskCount = session.compaction?.compactedTaskCount ?? 0;
  return Math.max(0, Math.min(visibleCount, compactedTaskCount));
}

export function getAgentSessionLiveTasks(
  session: Pick<AgentSession, "tasks" | "visibleTaskCount" | "compaction">,
): AgentTask[] {
  const visibleTasks = getVisibleAgentTasks(session);
  return visibleTasks.slice(getAgentSessionCompactedTaskCount(session));
}

function normalizeSessionState(session: AgentSession): AgentSession {
  const visibleTaskCount = clampVisibleTaskCount(
    session.tasks.length,
    session.visibleTaskCount,
  );
  const compactedTaskCount = Math.max(
    0,
    Math.min(visibleTaskCount, session.compaction?.compactedTaskCount ?? 0),
  );

  return {
    ...session,
    ...(typeof session.workspaceRoot === "string" && session.workspaceRoot.trim()
      ? { workspaceRoot: session.workspaceRoot.trim() }
      : {}),
    ...(typeof session.repoRoot === "string" && session.repoRoot.trim()
      ? { repoRoot: session.repoRoot.trim() }
      : {}),
    ...(Array.isArray(session.lastActivePaths)
      ? {
          lastActivePaths: [
            ...new Set(
              session.lastActivePaths
                .map((path) => String(path || "").trim())
                .filter(Boolean),
            ),
          ].slice(0, 16),
        }
      : {}),
    ...(session.lastTaskIntent ? { lastTaskIntent: session.lastTaskIntent } : {}),
    ...(session.workspaceLocked ? { workspaceLocked: true } : {}),
    ...(session.workspaceLockReason ? { workspaceLockReason: session.workspaceLockReason } : {}),
    ...(typeof session.lastSoftResetAt === "number"
      ? { lastSoftResetAt: session.lastSoftResetAt }
      : {}),
    ...(typeof session.lastMemoryRecallAttempted === "boolean"
      ? { lastMemoryRecallAttempted: session.lastMemoryRecallAttempted }
      : {}),
    ...(Array.isArray(session.lastMemoryRecallPreview)
      ? {
          lastMemoryRecallPreview: session.lastMemoryRecallPreview
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .slice(0, 6),
        }
      : {}),
    ...(typeof session.lastTranscriptRecallAttempted === "boolean"
      ? { lastTranscriptRecallAttempted: session.lastTranscriptRecallAttempted }
      : {}),
    ...(typeof session.lastTranscriptRecallHitCount === "number"
      ? { lastTranscriptRecallHitCount: Math.max(0, Math.floor(session.lastTranscriptRecallHitCount)) }
      : {}),
    ...(Array.isArray(session.lastTranscriptRecallPreview)
      ? {
          lastTranscriptRecallPreview: session.lastTranscriptRecallPreview
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .slice(0, 6),
        }
      : {}),
    ...(visibleTaskCount >= session.tasks.length
      ? { visibleTaskCount: undefined }
      : { visibleTaskCount }),
    followUpQueue: session.followUpQueue?.filter(
      (item) => typeof item.query === "string" && item.query.trim().length > 0,
    ) ?? [],
    compaction:
      session.compaction?.summary?.trim() && compactedTaskCount > 0
        ? {
            ...session.compaction,
            compactedTaskCount,
          }
        : undefined,
  };
}

interface AgentState {
  sessions: AgentSession[];
  scheduledTasks: AgentScheduledTask[];
  currentSessionId: string | null;
  historyLoaded: boolean;

  loadHistory: () => Promise<void>;
  persistHistory: () => Promise<void>;
  loadScheduledTasks: () => Promise<void>;
  createScheduledTask: (params: {
    query: string;
    scheduleType: AgentScheduleType;
    scheduleValue: string;
    sessionId?: string;
    originMode?: AgentTaskOriginMode;
    originLabel?: string;
  }) => Promise<AgentScheduledTask | null>;
  pauseScheduledTask: (taskId: string) => Promise<void>;
  resumeScheduledTask: (taskId: string) => Promise<void>;
  cancelScheduledTask: (taskId: string) => Promise<void>;
  deleteScheduledTask: (taskId: string) => Promise<void>;
  upsertScheduledTask: (task: AgentScheduledTask) => void;
  applyScheduledTaskPatch: (patch: AgentTaskStatusPatch) => void;
  applyScheduledTaskSkipped: (event: AgentTaskSkippedEvent) => void;
  createSession: (
    query: string,
    sourceHandoff?: AgentSession["sourceHandoff"],
    initialTask?: Pick<AgentTask, "images" | "attachmentPaths">,
  ) => string;
  getCurrentSession: () => AgentSession | null;
  setCurrentSession: (id: string) => void;
  /** 向会话追加一个新任务，返回新任务的 id */
  addTask: (
    sessionId: string,
    query: string,
    images?: string[],
    attachmentPaths?: string[],
  ) => string;
  /** 更新指定任务的 steps / answer（按 taskId 查找） */
  updateTask: (
    sessionId: string,
    taskId: string,
    updates: Partial<
      Pick<
        AgentTask,
        | "steps"
        | "answer"
        | "status"
        | "retry_count"
        | "next_run_at"
        | "last_error"
        | "last_started_at"
        | "last_finished_at"
        | "last_duration_ms"
        | "last_result_status"
        | "memoryRecallAttempted"
        | "appliedMemoryIds"
        | "appliedMemoryPreview"
        | "transcriptRecallAttempted"
        | "transcriptRecallHitCount"
        | "appliedTranscriptPreview"
      >
    >,
  ) => void;
  /** 更新会话级字段（如清空 tasks） */
  updateSession: (
    id: string,
    updates: Partial<
      Pick<
        AgentSession,
        | "tasks"
        | "title"
        | "visibleTaskCount"
        | "followUpQueue"
        | "forkMeta"
        | "compaction"
        | "workspaceRoot"
        | "repoRoot"
        | "lastActivePaths"
        | "lastTaskIntent"
        | "workspaceLocked"
        | "workspaceLockReason"
        | "lastSoftResetAt"
        | "lastContinuityStrategy"
        | "lastContinuityReason"
        | "lastContextResetAt"
        | "lastMemoryItemCount"
        | "lastMemoryRecallAttempted"
        | "lastMemoryRecallPreview"
        | "lastTranscriptRecallAttempted"
        | "lastTranscriptRecallHitCount"
        | "lastTranscriptRecallPreview"
        | "lastSessionNotePreview"
        | "lastContextRuntimeReport"
      >
    >,
  ) => void;
  setWorkspaceLock: (
    sessionId: string,
    locked: boolean,
    reason?: "user" | "session_policy",
  ) => void;
  revertCurrentSessionToPreviousTask: () => void;
  redoCurrentSession: () => void;
  restoreCurrentSession: () => void;
  forkSession: (
    sessionId: string,
    options?: { title?: string; visibleOnly?: boolean },
  ) => string | null;
  enqueueFollowUp: (
    sessionId: string,
    followUp: Omit<AgentQueuedFollowUp, "id" | "createdAt">,
  ) => string;
  dequeueFollowUp: (sessionId: string) => AgentQueuedFollowUp | null;
  removeFollowUp: (sessionId: string, followUpId: string) => void;
  clearFollowUpQueue: (sessionId: string) => void;
  deleteSession: (id: string) => void;
  deleteAllSessions: () => void;
  renameSession: (id: string, title: string) => void;
  clearCurrentSession: () => void;
}

const generateId = () =>
  Math.random().toString(36).substring(2, 15) + Date.now().toString(36);

function buildAgentRuntimeSummary(task: Partial<AgentTask>): string | undefined {
  if (typeof task.answer === "string" && task.answer.trim()) {
    return summarizeAISessionRuntimeText(task.answer, 140);
  }
  if (typeof task.last_error === "string" && task.last_error.trim()) {
    const preview = summarizeAISessionRuntimeText(task.last_error, 110);
    return preview ? `失败：${preview}` : "任务执行失败";
  }
  switch (task.status) {
    case "running":
      return "任务运行中";
    case "success":
      return "任务已完成";
    case "error":
      return "任务执行失败";
    case "paused":
      return "任务已暂停";
    case "pending":
      return "任务等待执行";
    default:
      return undefined;
  }
}

/**
 * 兼容旧格式：将 { query, steps, answer } 迁移到 { tasks: [...] }
 */
function migrateSession(raw: Record<string, unknown>): AgentSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as any;
  const createdAt = typeof r.createdAt === "number" ? r.createdAt : Date.now();
  if (Array.isArray(r.tasks)) {
    // 为旧数据中缺少 id 的 task 补充 id
    const tasks = r.tasks.map((t: AgentTask) => {
      const baseTask: AgentTask = {
        ...t,
        id: t.id || generateId(),
        status: t.status || (t.answer ? "success" : "pending"),
        retry_count: t.retry_count ?? 0,
        createdAt: t.createdAt ?? createdAt,
        appliedMemoryIds: Array.isArray(t.appliedMemoryIds)
          ? t.appliedMemoryIds
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .slice(0, 8)
          : undefined,
        appliedMemoryPreview: Array.isArray(t.appliedMemoryPreview)
          ? t.appliedMemoryPreview
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .slice(0, 4)
          : undefined,
        transcriptRecallAttempted:
          typeof t.transcriptRecallAttempted === "boolean"
            ? t.transcriptRecallAttempted
            : undefined,
        transcriptRecallHitCount:
          typeof t.transcriptRecallHitCount === "number"
            ? Math.max(0, Math.floor(t.transcriptRecallHitCount))
            : undefined,
        appliedTranscriptPreview: Array.isArray(t.appliedTranscriptPreview)
          ? t.appliedTranscriptPreview
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .slice(0, 4)
          : undefined,
      };
      return {
        ...baseTask,
        ...(buildRecoveredAgentTaskPatch(baseTask) ?? {}),
      };
    });
    return normalizeSessionState({
      id: r.id,
      title: r.title,
      tasks,
      createdAt,
      ...(typeof r.workspaceRoot === "string" && r.workspaceRoot.trim()
        ? { workspaceRoot: r.workspaceRoot.trim() }
        : {}),
      ...(typeof r.repoRoot === "string" && r.repoRoot.trim()
        ? { repoRoot: r.repoRoot.trim() }
        : {}),
      ...(Array.isArray(r.lastActivePaths)
        ? { lastActivePaths: r.lastActivePaths }
        : {}),
      ...(typeof r.lastTaskIntent === "string" && r.lastTaskIntent.trim()
        ? { lastTaskIntent: r.lastTaskIntent.trim() }
        : {}),
      ...(r.workspaceLocked ? { workspaceLocked: true } : {}),
      ...(typeof r.workspaceLockReason === "string" && r.workspaceLockReason.trim()
        ? { workspaceLockReason: r.workspaceLockReason.trim() }
        : {}),
      ...(typeof r.lastSoftResetAt === "number"
        ? { lastSoftResetAt: r.lastSoftResetAt }
        : {}),
      ...(typeof r.lastContinuityStrategy === "string" && r.lastContinuityStrategy.trim()
        ? { lastContinuityStrategy: r.lastContinuityStrategy.trim() }
        : {}),
      ...(typeof r.lastContinuityReason === "string" && r.lastContinuityReason.trim()
        ? { lastContinuityReason: r.lastContinuityReason.trim() }
        : {}),
      ...(typeof r.lastContextResetAt === "number"
        ? { lastContextResetAt: r.lastContextResetAt }
        : {}),
      ...(typeof r.lastMemoryItemCount === "number"
        ? { lastMemoryItemCount: r.lastMemoryItemCount }
        : {}),
      ...(typeof r.lastMemoryRecallAttempted === "boolean"
        ? { lastMemoryRecallAttempted: r.lastMemoryRecallAttempted }
        : {}),
      ...(Array.isArray(r.lastMemoryRecallPreview)
        ? { lastMemoryRecallPreview: r.lastMemoryRecallPreview }
        : {}),
      ...(typeof r.lastTranscriptRecallAttempted === "boolean"
        ? { lastTranscriptRecallAttempted: r.lastTranscriptRecallAttempted }
        : {}),
      ...(typeof r.lastTranscriptRecallHitCount === "number"
        ? { lastTranscriptRecallHitCount: r.lastTranscriptRecallHitCount }
        : {}),
      ...(Array.isArray(r.lastTranscriptRecallPreview)
        ? { lastTranscriptRecallPreview: r.lastTranscriptRecallPreview }
        : {}),
      ...(typeof r.lastSessionNotePreview === "string" && r.lastSessionNotePreview.trim()
        ? { lastSessionNotePreview: r.lastSessionNotePreview.trim() }
        : {}),
      ...(r.lastContextRuntimeReport ? { lastContextRuntimeReport: r.lastContextRuntimeReport } : {}),
      ...(r.sourceHandoff ? { sourceHandoff: r.sourceHandoff } : {}),
      ...(typeof r.visibleTaskCount === "number"
        ? { visibleTaskCount: r.visibleTaskCount }
        : {}),
      ...(Array.isArray(r.followUpQueue)
        ? { followUpQueue: r.followUpQueue }
        : {}),
      ...(r.forkMeta ? { forkMeta: r.forkMeta } : {}),
      ...(r.compaction ? { compaction: r.compaction } : {}),
    });
  }
  // Legacy: query / steps / answer 作为唯一一个 task
  const hasContent = r.query || (Array.isArray(r.steps) && r.steps.length > 0) || r.answer;
  return normalizeSessionState({
    id: r.id,
    title: r.title || "新任务",
    tasks: hasContent
      ? [
          (() => {
            const task: AgentTask = {
              id: generateId(),
              query: r.query || "",
              steps: r.steps || [],
              answer: r.answer ?? null,
              status: r.answer ? "success" : "pending",
              retry_count: 0,
              createdAt,
            };
            return {
              ...task,
              ...(buildRecoveredAgentTaskPatch(task) ?? {}),
            };
          })(),
        ]
      : [],
    createdAt,
    ...(typeof r.workspaceRoot === "string" && r.workspaceRoot.trim()
      ? { workspaceRoot: r.workspaceRoot.trim() }
      : {}),
    ...(typeof r.repoRoot === "string" && r.repoRoot.trim()
      ? { repoRoot: r.repoRoot.trim() }
      : {}),
    ...(Array.isArray(r.lastActivePaths)
      ? { lastActivePaths: r.lastActivePaths }
      : {}),
    ...(typeof r.lastTaskIntent === "string" && r.lastTaskIntent.trim()
      ? { lastTaskIntent: r.lastTaskIntent.trim() }
      : {}),
    ...(r.workspaceLocked ? { workspaceLocked: true } : {}),
    ...(typeof r.workspaceLockReason === "string" && r.workspaceLockReason.trim()
      ? { workspaceLockReason: r.workspaceLockReason.trim() }
      : {}),
    ...(typeof r.lastSoftResetAt === "number"
      ? { lastSoftResetAt: r.lastSoftResetAt }
      : {}),
    ...(typeof r.lastContinuityStrategy === "string" && r.lastContinuityStrategy.trim()
      ? { lastContinuityStrategy: r.lastContinuityStrategy.trim() }
      : {}),
    ...(typeof r.lastContinuityReason === "string" && r.lastContinuityReason.trim()
      ? { lastContinuityReason: r.lastContinuityReason.trim() }
      : {}),
    ...(typeof r.lastContextResetAt === "number"
      ? { lastContextResetAt: r.lastContextResetAt }
      : {}),
    ...(typeof r.lastMemoryItemCount === "number"
      ? { lastMemoryItemCount: r.lastMemoryItemCount }
      : {}),
    ...(typeof r.lastMemoryRecallAttempted === "boolean"
      ? { lastMemoryRecallAttempted: r.lastMemoryRecallAttempted }
      : {}),
    ...(Array.isArray(r.lastMemoryRecallPreview)
      ? { lastMemoryRecallPreview: r.lastMemoryRecallPreview }
      : {}),
    ...(typeof r.lastTranscriptRecallAttempted === "boolean"
      ? { lastTranscriptRecallAttempted: r.lastTranscriptRecallAttempted }
      : {}),
    ...(typeof r.lastTranscriptRecallHitCount === "number"
      ? { lastTranscriptRecallHitCount: r.lastTranscriptRecallHitCount }
      : {}),
    ...(Array.isArray(r.lastTranscriptRecallPreview)
      ? { lastTranscriptRecallPreview: r.lastTranscriptRecallPreview }
      : {}),
    ...(typeof r.lastSessionNotePreview === "string" && r.lastSessionNotePreview.trim()
      ? { lastSessionNotePreview: r.lastSessionNotePreview.trim() }
      : {}),
    ...(r.lastContextRuntimeReport ? { lastContextRuntimeReport: r.lastContextRuntimeReport } : {}),
    ...(r.sourceHandoff ? { sourceHandoff: r.sourceHandoff } : {}),
  });
}

let _lastPersistedHash = 0;

/** DJB2 哈希算法 —— 简单高效的字符串哈希 */
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// 使用统一的防抖持久化工具
const _agentPersister = createDebouncedPersister(() => {
  useAgentStore.getState().persistHistory();
});
const debouncedPersist = () => _agentPersister.trigger();

export const useAgentStore = create<AgentState>((set, get) => ({
  sessions: [],
  scheduledTasks: [],
  currentSessionId: null,
  historyLoaded: false,

  loadHistory: async () => {
    try {
      const json = await invoke<string>("load_agent_history");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawSessions = JSON.parse(json) as any[];
      const sessions = rawSessions.map(migrateSession);
      useAISessionRuntimeStore.getState().syncSessions(
        sessions.map((session) => ({
          externalSessionId: session.id,
          mode: "agent" as const,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: getVisibleAgentTasks(session)[getVisibleAgentTasks(session).length - 1]?.last_finished_at
            ?? getVisibleAgentTasks(session)[getVisibleAgentTasks(session).length - 1]?.last_started_at
            ?? session.createdAt,
          summary: buildAgentRuntimeSummary(
            getVisibleAgentTasks(session)[getVisibleAgentTasks(session).length - 1]
              ?? session.tasks[session.tasks.length - 1]
              ?? {},
          ),
          source: session.sourceHandoff,
        })),
      );
      if (sessions.length > 0) {
        set({
          sessions,
          currentSessionId: sessions[0]?.id || null,
          historyLoaded: true,
        });
      } else {
        set({ historyLoaded: true });
      }
    } catch (e) {
      handleError(e, { context: "加载Agent历史" });
      set({ historyLoaded: true });
    }
  },

  persistHistory: async () => {
    try {
      const { sessions } = get();
      // 最多保留 MAX_CONVERSATIONS 个会话，每个任务最多 50 步
      const trimmed = sessions
        .slice(0, MAX_CONVERSATIONS)
        .map((s) => ({
          ...s,
          tasks: s.tasks.map((t) => ({
            ...t,
            steps: t.steps.slice(-50),
          })),
        }));
      const json = JSON.stringify(trimmed);
      const hash = djb2Hash(json);
      if (hash === _lastPersistedHash) return;
      _lastPersistedHash = hash;
      await invoke("save_agent_history", { sessions: json });
    } catch (e) {
      handleError(e, { context: "保存Agent历史", silent: true });
    }
  },

  loadScheduledTasks: async () => {
    try {
      const tasks = await invoke<AgentScheduledTask[]>("agent_task_list");
      set({ scheduledTasks: tasks });
    } catch (e) {
      handleError(e, { context: "加载 Agent 编排任务", silent: true });
    }
  },

  createScheduledTask: async ({ query, scheduleType, scheduleValue, sessionId, originMode, originLabel }) => {
    try {
      const task = await invoke<AgentScheduledTask>("agent_task_create", {
        query,
        sessionId: sessionId || null,
        scheduleType,
        scheduleValue,
        ...(originMode ? { originMode } : {}),
        ...(originLabel?.trim() ? { originLabel: originLabel.trim() } : {}),
      });
      set((state) => ({
        scheduledTasks: [task, ...state.scheduledTasks.filter((t) => t.id !== task.id)],
      }));
      return task;
    } catch (e) {
      handleError(e, { context: "创建 Agent 编排任务" });
      return null;
    }
  },

  pauseScheduledTask: async (taskId) => {
    try {
      await invoke("agent_task_pause", { taskId });
      set((state) => ({
        scheduledTasks: state.scheduledTasks.map((task) =>
          task.id === taskId
            ? { ...task, status: "paused", updated_at: Date.now() }
            : task,
        ),
      }));
    } catch (e) {
      handleError(e, { context: "暂停 Agent 编排任务" });
    }
  },

  resumeScheduledTask: async (taskId) => {
    try {
      await invoke("agent_task_resume", { taskId });
      set((state) => ({
        scheduledTasks: state.scheduledTasks.map((task) =>
          task.id === taskId
            ? { ...task, status: "pending", updated_at: Date.now() }
            : task,
        ),
      }));
    } catch (e) {
      handleError(e, { context: "恢复 Agent 编排任务" });
    }
  },

  cancelScheduledTask: async (taskId) => {
    try {
      await invoke("agent_task_cancel", { taskId });
      set((state) => ({
        scheduledTasks: state.scheduledTasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                status: "cancelled",
                next_run_at: undefined,
                updated_at: Date.now(),
              }
            : task,
        ),
      }));
    } catch (e) {
      handleError(e, { context: "取消 Agent 编排任务" });
    }
  },

  deleteScheduledTask: async (taskId) => {
    try {
      await invoke("agent_task_delete", { taskId });
      set((state) => ({
        scheduledTasks: state.scheduledTasks.filter((task) => task.id !== taskId),
      }));
    } catch (e) {
      handleError(e, { context: "删除 Agent 编排任务" });
    }
  },

  upsertScheduledTask: (task) => {
    set((state) => {
      const exists = state.scheduledTasks.some((t) => t.id === task.id);
      if (!exists) {
        return { scheduledTasks: [task, ...state.scheduledTasks] };
      }
      return {
        scheduledTasks: state.scheduledTasks.map((t) =>
          t.id === task.id ? { ...t, ...task } : t,
        ),
      };
    });
  },

  applyScheduledTaskPatch: (patch) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map((task) =>
        task.id === patch.task_id
          ? {
              ...task,
              status: patch.status,
              retry_count: patch.retry_count,
              next_run_at: patch.next_run_at,
              last_error: patch.last_error,
              last_started_at: patch.last_started_at,
              last_finished_at: patch.last_finished_at,
              last_duration_ms: patch.last_duration_ms,
              last_result_status: patch.last_result_status,
              last_skip_reason: patch.last_skip_reason,
              updated_at: patch.updated_at,
            }
          : task,
      ),
    }));
  },

  applyScheduledTaskSkipped: (event) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map((task) =>
        task.id === event.task_id
          ? {
              ...task,
              next_run_at: event.next_run_at,
              last_result_status: "skipped",
              last_skip_reason: event.reason,
              updated_at: event.skipped_at,
            }
          : task,
      ),
    }));
  },

  createSession: (
    query: string,
    sourceHandoff?: AgentSession["sourceHandoff"],
    initialTask?: Pick<AgentTask, "images" | "attachmentPaths">,
  ) => {
    const id = generateId();
    const now = Date.now();
    const session = normalizeSessionState({
      id,
      title: query.slice(0, 30) || "新任务",
      tasks: query
        ? [
            {
              id: generateId(),
              query,
              images: initialTask?.images,
              attachmentPaths: initialTask?.attachmentPaths,
              createdAt: now,
              steps: [],
              answer: null,
              status: "pending",
              retry_count: 0,
            },
          ]
        : [],
      createdAt: now,
      followUpQueue: [],
      ...(sourceHandoff ? { sourceHandoff } : {}),
    });
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }));
    useAISessionRuntimeStore.getState().ensureSession({
      mode: "agent",
      externalSessionId: id,
      title: session.title,
      createdAt: now,
      updatedAt: now,
      source: sourceHandoff,
      sessionIdentity: {
        surface: "ai_center",
        sessionKey: id,
        sessionKind: "task_session",
        runtimeSessionId: id,
      },
    });
    debouncedPersist();
    return id;
  },

  getCurrentSession: () => {
    const { sessions, currentSessionId } = get();
    return sessions.find((s) => s.id === currentSessionId) || null;
  },

  setCurrentSession: (id) => set({ currentSessionId: id }),

  addTask: (
    sessionId: string,
    query: string,
    images?: string[],
    attachmentPaths?: string[],
  ) => {
    const taskId = generateId();
    const createdAt = Date.now();
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const newTask: AgentTask = {
          id: taskId,
          query,
          images,
          attachmentPaths,
          createdAt,
          steps: [],
          answer: null,
          status: "pending",
          retry_count: 0,
        };
        return normalizeSessionState({
          ...s,
          tasks: [...s.tasks, newTask],
          visibleTaskCount: undefined,
        });
      }),
    }));
    useAISessionRuntimeStore.getState().touchSession("agent", sessionId, {
      title: query.slice(0, 30) || undefined,
    });
    debouncedPersist();
    return taskId;
  },

  updateTask: (sessionId, taskId, updates) => {
    set((state) => {
      // 校验 session 和 task 仍然存在，防止异步竞态
      const session = state.sessions.find((s) => s.id === sessionId);
      if (!session) return state;
      const taskExists = session.tasks.some((t) => t.id === taskId);
      if (!taskExists) return state;

      return {
        sessions: state.sessions.map((s) => {
          if (s.id !== sessionId) return s;
          const newTasks = s.tasks.map((t) =>
            t.id === taskId ? { ...t, ...updates } : t,
          );
          return normalizeSessionState({ ...s, tasks: newTasks });
        }),
      };
    });
    const shouldSyncRuntime = [
      updates.status,
      updates.answer,
      updates.last_error,
      updates.last_started_at,
      updates.last_finished_at,
      updates.last_result_status,
    ].some((value) => value !== undefined);
    if (shouldSyncRuntime) {
      const session = get().sessions.find((item) => item.id === sessionId);
      const updatedAt =
        updates.last_finished_at
        ?? updates.last_started_at
        ?? Date.now();
      useAISessionRuntimeStore.getState().ensureSession({
        mode: "agent",
        externalSessionId: sessionId,
        title: session?.title,
        summary: buildAgentRuntimeSummary(updates),
        updatedAt,
        source: session?.sourceHandoff,
        sessionIdentity: {
          surface: "ai_center",
          sessionKey: sessionId,
          sessionKind: "task_session",
          runtimeSessionId: sessionId,
        },
      });
    }
    debouncedPersist();
  },

  updateSession: (id, updates) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? normalizeSessionState({ ...s, ...updates }) : s,
      ),
    }));
    if (updates.title !== undefined) {
      useAISessionRuntimeStore.getState().touchSession("agent", id, {
        title: updates.title,
      });
    }
    debouncedPersist();
  },

  setWorkspaceLock: (sessionId, locked, reason = "user") => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? normalizeSessionState({
              ...session,
              workspaceLocked: locked,
              workspaceLockReason: locked ? reason : undefined,
            })
          : session,
      ),
    }));
    debouncedPersist();
  },

  revertCurrentSessionToPreviousTask: () => {
    const session = get().getCurrentSession();
    if (!session) return;
    const visibleTaskCount = getAgentSessionVisibleTaskCount(session);
    if (visibleTaskCount <= 0) return;
    get().updateSession(session.id, {
      visibleTaskCount: visibleTaskCount - 1,
    });
  },

  redoCurrentSession: () => {
    const session = get().getCurrentSession();
    if (!session) return;
    const visibleTaskCount = getAgentSessionVisibleTaskCount(session);
    if (visibleTaskCount >= session.tasks.length) return;
    get().updateSession(session.id, {
      visibleTaskCount: visibleTaskCount + 1,
    });
  },

  restoreCurrentSession: () => {
    const session = get().getCurrentSession();
    if (!session) return;
    get().updateSession(session.id, {
      visibleTaskCount: undefined,
    });
  },

  forkSession: (sessionId, options) => {
    const session = get().sessions.find((item) => item.id === sessionId);
    if (!session) return null;
    const visibleOnly = options?.visibleOnly !== false;
    const sourceTasks = visibleOnly ? getVisibleAgentTasks(session) : session.tasks;
    const now = Date.now();
    const clonedTasks = sourceTasks.map((task, index) => ({
      ...task,
      id: generateId(),
      createdAt: task.createdAt ?? now + index,
      steps: task.steps.map((step) => ({
        ...step,
        ...(step.toolInput ? { toolInput: { ...step.toolInput } } : {}),
      })),
      images: task.images ? [...task.images] : undefined,
      attachmentPaths: task.attachmentPaths ? [...task.attachmentPaths] : undefined,
      appliedMemoryIds: task.appliedMemoryIds ? [...task.appliedMemoryIds] : undefined,
      appliedMemoryPreview: task.appliedMemoryPreview ? [...task.appliedMemoryPreview] : undefined,
      transcriptRecallAttempted: task.transcriptRecallAttempted,
      transcriptRecallHitCount: task.transcriptRecallHitCount,
      appliedTranscriptPreview: task.appliedTranscriptPreview
        ? [...task.appliedTranscriptPreview]
        : undefined,
    }));
    const forked: AgentSession = normalizeSessionState({
      id: generateId(),
      title: options?.title ?? `${session.title || "新任务"} · 分支`,
      tasks: clonedTasks,
      createdAt: now,
      workspaceRoot: session.workspaceRoot,
      repoRoot: session.repoRoot,
      lastActivePaths: session.lastActivePaths,
      lastTaskIntent: session.lastTaskIntent,
      workspaceLocked: session.workspaceLocked,
      workspaceLockReason: session.workspaceLockReason,
      lastSoftResetAt: session.lastSoftResetAt,
      lastMemoryRecallAttempted: session.lastMemoryRecallAttempted,
      lastMemoryRecallPreview: session.lastMemoryRecallPreview,
      lastTranscriptRecallAttempted: session.lastTranscriptRecallAttempted,
      lastTranscriptRecallHitCount: session.lastTranscriptRecallHitCount,
      lastTranscriptRecallPreview: session.lastTranscriptRecallPreview,
      sourceHandoff: session.sourceHandoff,
      forkMeta: {
        parentSessionId: session.id,
        parentVisibleTaskCount: getAgentSessionVisibleTaskCount(session),
        createdAt: now,
      },
      compaction: session.compaction,
      followUpQueue: [],
    });
    set((state) => ({
      sessions: [forked, ...state.sessions],
      currentSessionId: forked.id,
    }));
    useAISessionRuntimeStore.getState().ensureSession({
      mode: "agent",
      externalSessionId: forked.id,
      title: forked.title,
      createdAt: now,
      updatedAt: now,
      summary: buildAgentRuntimeSummary(clonedTasks[clonedTasks.length - 1] ?? {}),
      source: forked.sourceHandoff,
      sessionIdentity: {
        surface: "ai_center",
        sessionKey: forked.id,
        sessionKind: "task_session",
        runtimeSessionId: forked.id,
      },
    });
    debouncedPersist();
    return forked.id;
  },

  enqueueFollowUp: (sessionId, followUp) => {
    const queued: AgentQueuedFollowUp = {
      ...followUp,
      id: generateId(),
      createdAt: Date.now(),
    };
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? normalizeSessionState({
              ...session,
              followUpQueue: [...(session.followUpQueue ?? []), queued],
            })
          : session,
      ),
    }));
    debouncedPersist();
    return queued.id;
  },

  dequeueFollowUp: (sessionId) => {
    const session = get().sessions.find((item) => item.id === sessionId);
    const next = session?.followUpQueue?.[0] ?? null;
    if (!next) return null;
    set((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === sessionId
          ? normalizeSessionState({
              ...item,
              followUpQueue: (item.followUpQueue ?? []).slice(1),
            })
          : item,
      ),
    }));
    debouncedPersist();
    return next;
  },

  removeFollowUp: (sessionId, followUpId) => {
    set((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === sessionId
          ? normalizeSessionState({
              ...item,
              followUpQueue: (item.followUpQueue ?? []).filter(
                (followUp) => followUp.id !== followUpId,
              ),
            })
          : item,
      ),
    }));
    debouncedPersist();
  },

  clearFollowUpQueue: (sessionId) => {
    set((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === sessionId
          ? normalizeSessionState({ ...item, followUpQueue: [] })
          : item,
      ),
    }));
    debouncedPersist();
  },

  deleteSession: (id) => {
    set((state) => {
      const remaining = state.sessions.filter((s) => s.id !== id);
      const needSwitch = state.currentSessionId === id;
      return {
        sessions: remaining,
        currentSessionId: needSwitch
          ? remaining[0]?.id || null
          : state.currentSessionId,
      };
    });
    debouncedPersist();
  },

  deleteAllSessions: () => {
    set({
      sessions: [],
      currentSessionId: null,
    });
    debouncedPersist();
  },

  renameSession: (id, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title } : s,
      ),
    }));
    useAISessionRuntimeStore.getState().touchSession("agent", id, { title });
    debouncedPersist();
  },

  clearCurrentSession: () => {
    const id = generateId();
    const now = Date.now();
    const session = normalizeSessionState({
      id,
      title: "新任务",
      tasks: [],
      createdAt: now,
      followUpQueue: [],
    });
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }));
    useAISessionRuntimeStore.getState().ensureSession({
      mode: "agent",
      externalSessionId: id,
      title: session.title,
      createdAt: now,
      updatedAt: now,
      sessionIdentity: {
        surface: "ai_center",
        sessionKey: id,
        sessionKind: "task_session",
        runtimeSessionId: id,
      },
    });
    debouncedPersist();
  },
}));
