import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorEvent, DialogMessage } from "./types";

export const DIALOG_STEP_TRACE_FILE_NAME = "51toolbox-dialog-step-trace.txt";
export type DialogTraceMode = "off" | "full";

const DIALOG_TRACE_MODE_STORAGE_KEY = "dialog_step_trace_mode";
const TRACE_PREVIEW_MAX = 80;

let appendQueue = Promise.resolve();
let cachedTraceContent = "";
let resolvedTracePathPromise: Promise<string> | null = null;
let traceSequence = 0;
let dialogTraceModeCache: DialogTraceMode | null = null;

function hasTauriFileBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isDialogStepTraceEnabled(): boolean {
  return hasTauriFileBridge();
}

function readStoredDialogTraceMode(): DialogTraceMode {
  if (dialogTraceModeCache) return dialogTraceModeCache;
  if (typeof window === "undefined") {
    dialogTraceModeCache = "off";
    return dialogTraceModeCache;
  }
  try {
    const raw = window.localStorage.getItem(DIALOG_TRACE_MODE_STORAGE_KEY);
    dialogTraceModeCache = raw === "full" ? "full" : "off";
  } catch {
    dialogTraceModeCache = "off";
  }
  return dialogTraceModeCache;
}

export function getDialogStepTraceMode(): DialogTraceMode {
  return readStoredDialogTraceMode();
}

export function setDialogStepTraceMode(mode: DialogTraceMode): DialogTraceMode {
  const normalized: DialogTraceMode = mode === "full" ? "full" : "off";
  dialogTraceModeCache = normalized;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(DIALOG_TRACE_MODE_STORAGE_KEY, normalized);
    } catch {
      // ignore storage write failures
    }
  }
  return normalized;
}

export function isDialogFullTraceEnabled(): boolean {
  return hasTauriFileBridge() && getDialogStepTraceMode() === "full";
}

export async function getDialogStepTracePath(): Promise<string> {
  if (!resolvedTracePathPromise) {
    resolvedTracePathPromise = (async () => {
      const home = await homeDir();
      return await join(home, DIALOG_STEP_TRACE_FILE_NAME);
    })();
  }
  return resolvedTracePathPromise;
}

async function writeTraceFile(path: string, content: string): Promise<void> {
  await invoke("write_text_file", { path, content });
}

function normalizeToken(value: string | number | undefined | null): string {
  const normalized = String(value ?? "").trim();
  return normalized.replace(/\s+/g, "_") || "-";
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function normalizePreview(value: unknown, maxLength = TRACE_PREVIEW_MAX): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function formatFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  if (/^[A-Za-z0-9_./:@-]+$/.test(normalized)) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

function buildTraceLine(fields: Record<string, unknown>): string {
  const orderedKeys = [
    "ts",
    "seq",
    "session",
    "actor",
    "event",
    "phase",
    "kind",
    "task_id",
    "run_id",
    "status",
    "model",
    "tool",
    "elapsed_ms",
    "count",
    "preview",
  ];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const key of orderedKeys) {
    const formatted = formatFieldValue(fields[key]);
    if (formatted === undefined) continue;
    parts.push(`${key}=${formatted}`);
    seen.add(key);
  }
  const extraKeys = Object.keys(fields)
    .filter((key) => !seen.has(key))
    .sort((left, right) => left.localeCompare(right));
  for (const key of extraKeys) {
    const formatted = formatFieldValue(fields[key]);
    if (formatted === undefined) continue;
    parts.push(`${key}=${formatted}`);
  }
  return parts.join(" ");
}

function summarizeStep(step: AgentStep | undefined): string {
  if (!step) return "step=unknown";

  const parts = [`step=${normalizeToken(step.type)}`];
  if (step.toolName) {
    parts.push(`tool=${normalizeToken(step.toolName)}`);
  }
  if (step.streaming) {
    parts.push("streaming=1");
  }
  return parts.join(" ");
}

function isDialogMessage(event: ActorEvent | DialogMessage): event is DialogMessage {
  return "from" in event && "content" in event;
}

function formatActorEventLine(sessionId: string, event: ActorEvent): string {
  const prefix = `${formatTimestamp(event.timestamp)} session=${sessionId.slice(0, 8)} actor=${normalizeToken(event.actorId)}`;
  const detail = (event.detail ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case "step":
      return `${prefix} event=step ${summarizeStep(detail.step as AgentStep | undefined)}`;
    case "task_started":
      return `${prefix} event=task_started task_id=${normalizeToken(String(detail.taskId ?? ""))}`;
    case "task_completed":
      return `${prefix} event=task_completed task_id=${normalizeToken(String(detail.taskId ?? detail.runId ?? ""))}`;
    case "task_error":
      return `${prefix} event=task_error task_id=${normalizeToken(String(detail.taskId ?? detail.runId ?? ""))}`;
    case "spawned_task_started":
    case "spawned_task_running":
    case "spawned_task_completed":
    case "spawned_task_failed":
    case "spawned_task_timeout":
      return [
        prefix,
        `event=${event.type}`,
        `run_id=${normalizeToken(String(detail.runId ?? ""))}`,
        `spawner=${normalizeToken(String(detail.spawnerActorId ?? ""))}`,
        `target=${normalizeToken(String(detail.targetActorId ?? ""))}`,
        `status=${normalizeToken(String(detail.status ?? ""))}`,
      ].join(" ");
    case "status_change":
      return [
        prefix,
        "event=status_change",
        `from=${normalizeToken(String(detail.prev ?? ""))}`,
        `to=${normalizeToken(String(detail.next ?? ""))}`,
      ].join(" ");
    case "message_received":
    case "message_sent":
    case "session_title_updated":
    case "dialog_plan_finalized":
    case "dialog_execution_mode_changed":
    case "session_stalled":
      return `${prefix} event=${event.type}`;
    default:
      return `${prefix} event=${normalizeToken(event.type)}`;
  }
}

function formatDialogMessageLine(sessionId: string, event: DialogMessage): string {
  return [
    formatTimestamp(event.timestamp),
    `session=${sessionId.slice(0, 8)}`,
    "event=dialog_message",
    `kind=${normalizeToken(event.kind ?? "agent_message")}`,
    `from=${normalizeToken(event.from)}`,
    `to=${normalizeToken(event.to ?? "broadcast")}`,
  ].join(" ");
}

export function formatDialogTraceLine(sessionId: string, event: ActorEvent | DialogMessage): string {
  if (isDialogMessage(event)) {
    return formatDialogMessageLine(sessionId, event);
  }
  return formatActorEventLine(sessionId, event);
}

export function shouldTraceDialogStep(step: AgentStep | undefined): boolean {
  if (!step) return true;
  if (!step.streaming) return true;
  return step.type !== "answer" && step.type !== "tool_streaming";
}

export function traceDialogSessionStarted(sessionId: string): void {
  if (!isDialogFullTraceEnabled()) return;
  void getDialogStepTracePath().then((path) => {
    traceDialogFlowEvent({
      sessionId,
      event: "session_started",
      detail: {
        path,
      },
    });
  });
}

export function resetDialogStepTrace(): void {
  if (!hasTauriFileBridge()) return;
  appendQueue = appendQueue
    .then(async () => {
      const tracePath = await getDialogStepTracePath();
      cachedTraceContent = "";
      traceSequence = 0;
      await writeTraceFile(tracePath, "");
    })
    .catch((error) => {
      console.warn("[DialogStepTrace] reset failed:", error);
    });
}

export function traceDialogActorSystemEvent(sessionId: string, event: ActorEvent | DialogMessage): void {
  if (!isDialogFullTraceEnabled()) return;
  if (isDialogMessage(event)) {
    traceDialogFlowEvent({
      sessionId,
      event: "dialog_message",
      detail: {
        kind: event.kind ?? "agent_message",
        from: event.from,
        to: event.to ?? "broadcast",
        preview: normalizePreview(event._briefContent ?? event.content),
      },
    });
    return;
  }
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  if (event.type === "step") {
    const step = detail.step as AgentStep | undefined;
    if (!shouldTraceDialogStep(step)) return;
    traceDialogFlowEvent({
      sessionId,
      actorId: event.actorId,
      event: "step",
      detail: {
        tool: step?.toolName,
        step: step?.type,
        status: step?.streaming ? "streaming" : undefined,
        preview: normalizePreview(step?.content),
      },
    });
    return;
  }
  traceDialogFlowEvent({
    sessionId,
    actorId: event.actorId,
    event: event.type,
    detail: {
      ...(typeof detail.taskId === "string" ? { task_id: detail.taskId } : {}),
      ...(typeof detail.runId === "string" ? { run_id: detail.runId } : {}),
      ...(typeof detail.status === "string" ? { status: detail.status } : {}),
      ...(typeof detail.elapsed === "number" ? { elapsed_ms: detail.elapsed } : {}),
      ...(typeof detail.message === "string" ? { preview: normalizePreview(detail.message) } : {}),
      ...(typeof detail.error === "string" ? { preview: normalizePreview(detail.error) } : {}),
    },
  });
}

export function traceDialogFlowEvent(params: {
  event: string;
  sessionId?: string | null;
  actorId?: string | null;
  detail?: Record<string, unknown>;
}): void {
  if (!isDialogFullTraceEnabled()) return;
  const timestamp = Date.now();
  const detail = { ...(params.detail ?? {}) };
  const sequence = traceSequence + 1;
  traceSequence = sequence;
  const line = buildTraceLine({
    ts: formatTimestamp(timestamp),
    seq: sequence,
    session: params.sessionId ? params.sessionId.slice(0, 8) : undefined,
    actor: params.actorId ? normalizeToken(params.actorId) : undefined,
    event: params.event,
    ...detail,
  });
  appendDialogTraceLine(line);
}

function appendDialogTraceLine(line: string): void {
  appendQueue = appendQueue
    .then(async () => {
      const tracePath = await getDialogStepTracePath();
      cachedTraceContent = `${cachedTraceContent}${line}\n`;
      await writeTraceFile(tracePath, cachedTraceContent);
    })
    .catch((error) => {
      console.warn("[DialogStepTrace] append failed:", error);
    });
}
