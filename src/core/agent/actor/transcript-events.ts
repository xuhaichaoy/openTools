/**
 * Transcript Events — 事件驱动的 Transcript 更新通知
 * 
 * 对标 OpenClaw 的 session transcript 事件系统。
 * 
 * 允许其他模块监听 transcript 的变化：
 * - 新消息添加
 * - Session 创建/归档/删除
 * - Transcript 压缩
 */

type TranscriptUpdateListener = (update: TranscriptUpdate) => void;

export interface TranscriptUpdate {
  sessionId: string;
  type: "message" | "tool_call" | "tool_result" | "spawn" | "announce" | "session_created" | "session_archived" | "session_deleted" | "compacted";
  timestamp: number;
  data?: Record<string, unknown>;
}

const TRANSCRIPT_LISTENERS = new Set<TranscriptUpdateListener>();

/**
 * 监听 Transcript 更新
 * 
 * @param listener 回调函数
 * @returns 取消监听的函数
 */
export function onTranscriptUpdate(listener: TranscriptUpdateListener): () => void {
  TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    TRANSCRIPT_LISTENERS.delete(listener);
  };
}

/**
 * 触发 Transcript 更新事件
 */
export function emitTranscriptUpdate(update: TranscriptUpdate): void {
  const trimmedSessionId = update.sessionId.trim();
  if (!trimmedSessionId) {
    return;
  }

  const event: TranscriptUpdate = {
    ...update,
    sessionId: trimmedSessionId,
    timestamp: update.timestamp || Date.now(),
  };

  for (const listener of TRANSCRIPT_LISTENERS) {
    try {
      listener(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

/**
 * 便捷方法：触发消息添加事件
 */
export function emitMessageAdded(
  sessionId: string,
  data: Record<string, unknown>,
): void {
  emitTranscriptUpdate({
    sessionId,
    type: "message",
    timestamp: Date.now(),
    data,
  });
}

/**
 * 便捷方法：触发工具调用事件
 */
export function emitToolCall(
  sessionId: string,
  data: Record<string, unknown>,
): void {
  emitTranscriptUpdate({
    sessionId,
    type: "tool_call",
    timestamp: Date.now(),
    data,
  });
}

/**
 * 便捷方法：触发工具结果事件
 */
export function emitToolResult(
  sessionId: string,
  data: Record<string, unknown>,
): void {
  emitTranscriptUpdate({
    sessionId,
    type: "tool_result",
    timestamp: Date.now(),
    data,
  });
}

/**
 * 便捷方法：触发 Spawn 事件
 */
export function emitSpawned(
  sessionId: string,
  data: Record<string, unknown>,
): void {
  emitTranscriptUpdate({
    sessionId,
    type: "spawn",
    timestamp: Date.now(),
    data,
  });
}

/**
 * 便捷方法：触发 Announce 事件
 */
export function emitAnnounce(
  sessionId: string,
  data: Record<string, unknown>,
): void {
  emitTranscriptUpdate({
    sessionId,
    type: "announce",
    timestamp: Date.now(),
    data,
  });
}

/**
 * 便捷方法：触发 Session 创建事件
 */
export function emitSessionCreated(sessionId: string): void {
  emitTranscriptUpdate({
    sessionId,
    type: "session_created",
    timestamp: Date.now(),
  });
}

/**
 * 便捷方法：触发 Session 归档事件
 */
export function emitSessionArchived(
  sessionId: string,
  data?: Record<string, unknown>,
): void {
  emitTranscriptUpdate({
    sessionId,
    type: "session_archived",
    timestamp: Date.now(),
    data,
  });
}

/**
 * 便捷方法：触发 Session 删除事件
 */
export function emitSessionDeleted(sessionId: string): void {
  emitTranscriptUpdate({
    sessionId,
    type: "session_deleted",
    timestamp: Date.now(),
  });
}

/**
 * 便捷方法：触发 Transcript 压缩事件
 */
export function emitCompacted(
  sessionId: string,
  data?: Record<string, unknown>,
): void {
  emitTranscriptUpdate({
    sessionId,
    type: "compacted",
    timestamp: Date.now(),
    data,
  });
}
