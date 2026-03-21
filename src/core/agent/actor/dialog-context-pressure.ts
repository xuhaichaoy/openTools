import { buildDialogContextBreakdown } from "@/core/ai/dialog-context-breakdown";
import { isContextPressureError } from "@/core/ai/context-pressure";
import {
  buildDialogRoomCompactionState,
  computeDialogRoomCompactionTriggerReasons,
  persistDialogRoomCompactionArtifacts,
  shouldRefreshDialogRoomCompaction,
} from "./dialog-room-compaction";
import { getActorTodoList } from "./middlewares";
import type { ActorSystem } from "./actor-system";
import type { DialogRoomCompactionState } from "./types";

const CONTEXT_PRESSURE_TRIGGER = "模型返回上下文压力错误";

function uniqueStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function resolveDialogRuntimeWorkspaceRoot(system: ActorSystem): string | undefined {
  const actors = system.getAll();
  const coordinatorId = system.getCoordinatorId();
  const coordinatorWorkspace = coordinatorId
    ? actors.find((actor) => actor.id === coordinatorId)?.workspace
    : undefined;
  const fallbackWorkspace = actors.find(
    (actor) => typeof actor.workspace === "string" && actor.workspace.trim().length > 0,
  )?.workspace;
  const workspaceRoot = coordinatorWorkspace || fallbackWorkspace;
  return workspaceRoot?.trim() ? workspaceRoot : undefined;
}

export interface EnsureDialogRoomCompactionOptions {
  extraTriggerReasons?: readonly string[];
  force?: boolean;
}

export interface EnsureDialogRoomCompactionResult {
  state: DialogRoomCompactionState;
  changed: boolean;
}

export async function ensureDialogRoomCompaction(
  system: ActorSystem,
  options: EnsureDialogRoomCompactionOptions = {},
): Promise<EnsureDialogRoomCompactionResult | null> {
  const actors = system.getAll();
  if (actors.length === 0) return null;

  const dialogHistory = [...system.getDialogHistory()];
  const artifacts = system.getArtifactRecordsSnapshot();
  const sessionUploads = system.getSessionUploadsSnapshot();
  const spawnedTasks = system.getSpawnedTasksSnapshot();
  const currentCompaction = system.getDialogRoomCompaction();
  const breakdown = buildDialogContextBreakdown({
    actors: actors.map((actor) => ({
      id: actor.id,
      roleName: actor.role.name,
      modelOverride: actor.modelOverride,
      systemPromptOverride: actor.getSystemPromptOverride(),
      workspace: actor.workspace,
      contextTokens: actor.contextTokens,
      thinkingLevel: actor.thinkingLevel,
      sessionHistory: actor.getSessionHistory(),
      currentTask: actor.currentTask
        ? {
            query: actor.currentTask.query,
            status: actor.currentTask.status,
            steps: actor.currentTask.steps.map((step) => ({
              type: step.type,
              content: step.content,
            })),
          }
        : undefined,
    })),
    dialogHistory,
    artifacts,
    sessionUploads,
    spawnedTasks,
  });
  const triggerReasons = uniqueStrings([
    ...(options.extraTriggerReasons ?? []),
    ...computeDialogRoomCompactionTriggerReasons({
      breakdown,
      dialogHistoryCount: dialogHistory.length,
    }),
  ]);
  if (!options.force) {
    const shouldRefresh = shouldRefreshDialogRoomCompaction({
      current: currentCompaction,
      triggerReasons,
      dialogHistoryCount: dialogHistory.length,
      artifactsCount: artifacts.length,
      spawnedTaskCount: spawnedTasks.length,
    });
    if (!shouldRefresh) return null;
  }
  const actorNameById = new Map(actors.map((actor) => [actor.id, actor.role.name] as const));
  const actorSessionHistoryById = new Map(
    actors.map((actor) => [actor.id, actor.getSessionHistory()]),
  );
  const actorTodosById = Object.fromEntries(
    actors.map((actor) => [actor.id, getActorTodoList(actor.id).map((todo) => ({ ...todo }))]),
  );
  const built = buildDialogRoomCompactionState({
    dialogHistory,
    artifacts,
    sessionUploads,
    spawnedTasks,
    actorNameById,
    actorSessionHistoryById,
    actorTodosById,
    triggerReasons,
  });
  if (!built) return null;

  if (
    currentCompaction?.summary?.trim() === built.summary.trim()
    && triggerReasons.every((reason) => (currentCompaction.triggerReasons ?? []).includes(reason))
  ) {
    return {
      state: currentCompaction,
      changed: false,
    };
  }

  const persisted = await persistDialogRoomCompactionArtifacts({
    state: built,
    conversationId: system.sessionId,
    workspaceId: resolveDialogRuntimeWorkspaceRoot(system),
  });
  system.setDialogRoomCompaction(persisted);
  return {
    state: persisted,
    changed: true,
  };
}

export async function recoverDialogRoomCompactionFromContextPressure(
  system: ActorSystem,
): Promise<DialogRoomCompactionState | null> {
  const result = await ensureDialogRoomCompaction(system, {
    force: true,
    extraTriggerReasons: [CONTEXT_PRESSURE_TRIGGER],
  });
  return result?.state ?? null;
}

export { CONTEXT_PRESSURE_TRIGGER, isContextPressureError as isDialogContextPressureError };
