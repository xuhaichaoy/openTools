/**
 * Actor Transcript — 完整对话记录持久化
 * 
 * 对标 OpenClaw 的 session transcript 系统。
 * 
 * 底层使用 actor-transcript-fs.ts 提供的文件系统存储。
 * 
 * API 保持同步/异步兼容：
 * - 写操作：异步 (append*)
 * - 读操作：异步 (load*)
 */

export * from "./actor-transcript-fs";

import type { DialogMessage } from "./types";
import {
  appendDialogMessage as fsAppendDialogMessage,
  appendToolCall as fsAppendToolCall,
  appendToolResult as fsAppendToolResult,
  appendSpawnEvent as fsAppendSpawnEvent,
  appendAnnounceEvent as fsAppendAnnounceEvent,
  loadTranscriptSession as fsLoadTranscriptSession,
  readSessionHistory as fsReadSessionHistory,
  getSessionSummary as fsGetSessionSummary,
  compactTranscript as fsCompactTranscript,
  archiveSession as fsArchiveSession,
  loadArchivedSessions as fsLoadArchivedSessions,
  deleteTranscriptSession as fsDeleteTranscriptSession,
  listTranscriptSessionIds as fsListTranscriptSessionIds,
  updateTranscriptActors as fsUpdateTranscriptActors,
} from "./actor-transcript-fs";

// ── 同步包装器 (兼容现有代码) ──
// 注意：底层使用文件系统，会有延迟，但保持同步接口以避免大规模重构

export function appendTranscriptEntry(
  sessionId: string,
  entry: { type: string; timestamp: number; data: Record<string, unknown> },
): void {
  // 异步调用，不等待（fire-and-forget）
  fsAppendDialogMessage(sessionId, {
    id: String(Date.now()),
    from: entry.data.from as string || "system",
    to: entry.data.to as string || "",
    content: JSON.stringify(entry.data),
    timestamp: entry.timestamp,
    priority: "normal",
  } as DialogMessage).catch(() => {});
}

export function appendDialogMessageSync(sessionId: string, msg: DialogMessage): void {
  fsAppendDialogMessage(sessionId, msg).catch(() => {});
}

export function appendToolCallSync(
  sessionId: string,
  actorId: string,
  toolName: string,
  params: Record<string, unknown>,
): void {
  fsAppendToolCall(sessionId, actorId, toolName, params).catch(() => {});
}

export function appendToolResultSync(
  sessionId: string,
  actorId: string,
  toolName: string,
  result: unknown,
): void {
  fsAppendToolResult(sessionId, actorId, toolName, result).catch(() => {});
}

export function appendSpawnEventSync(
  sessionId: string,
  spawnerActorId: string,
  targetActorId: string,
  task: string,
  runId: string,
): void {
  fsAppendSpawnEvent(sessionId, spawnerActorId, targetActorId, task, runId).catch(() => {});
}

export function appendAnnounceEventSync(
  sessionId: string,
  runId: string,
  status: string,
  result?: string,
  error?: string,
): void {
  fsAppendAnnounceEvent(sessionId, runId, status, result, error).catch(() => {});
}

// ── 异步 API ──

export {
  fsAppendDialogMessage as appendDialogMessage,
  fsAppendToolCall as appendToolCall,
  fsAppendToolResult as appendToolResult,
  fsAppendSpawnEvent as appendSpawnEvent,
  fsAppendAnnounceEvent as appendAnnounceEvent,
  fsLoadTranscriptSession as loadTranscriptSession,
  fsReadSessionHistory as readSessionHistory,
  fsGetSessionSummary as getSessionSummary,
  fsCompactTranscript as compactTranscript,
  fsArchiveSession as archiveSession,
  fsLoadArchivedSessions as loadArchivedSessions,
  fsDeleteTranscriptSession as deleteTranscriptSession,
  fsListTranscriptSessionIds as listTranscriptSessionIds,
  fsUpdateTranscriptActors as updateTranscriptActors,
};
