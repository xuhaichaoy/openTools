/**
 * TitleMiddleware — 自动会话标题生成
 *
 * 灵感来源：deer-flow 的 TitleMiddleware
 *
 * 首轮对话完成后，自动从用户消息中提取/生成简短的会话标题。
 * 标题通过 ActorSystem 事件通知 UI 层更新。
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { createLogger } from "@/core/logger";

const log = createLogger("TitleMiddleware");

/** 已生成 title 的 session 集合 */
const generatedSessions = new Set<string>();

/** 从用户消息中提取简短标题（纯前端，不调用 LLM） */
function extractTitle(query: string): string {
  const cleaned = query
    .replace(/\[系统注入\].*$/ms, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();

  // 取第一行有意义的文字
  const firstLine = cleaned.split("\n").find((l) => l.trim().length > 0)?.trim() ?? cleaned;

  if (firstLine.length <= 30) return firstLine;

  // 按标点截断
  const punctIdx = firstLine.search(/[。？！，；\n]/);
  if (punctIdx > 0 && punctIdx <= 40) return firstLine.slice(0, punctIdx);

  return firstLine.slice(0, 28) + "…";
}

export type TitleUpdateCallback = (sessionId: string, title: string) => void;

let _onTitleUpdate: TitleUpdateCallback | null = null;

/** 注册标题更新回调（UI 层调用） */
export function onSessionTitleUpdate(cb: TitleUpdateCallback): () => void {
  _onTitleUpdate = cb;
  return () => { if (_onTitleUpdate === cb) _onTitleUpdate = null; };
}

/** 手动重置已生成标题的记录（会话重置时调用） */
export function resetTitleGeneration(sessionId?: string): void {
  if (sessionId) {
    generatedSessions.delete(sessionId);
  } else {
    generatedSessions.clear();
  }
}

export class TitleMiddleware implements ActorMiddleware {
  readonly name = "Title";

  async apply(ctx: ActorRunContext): Promise<void> {
    const sessionId = ctx.actorSystem?.sessionId;
    if (!sessionId) return;
    if (generatedSessions.has(sessionId)) return;

    // 只在首轮生成（context 为空表示首轮）
    if (ctx.contextMessages.length > 0) return;

    // 标记为已生成，避免后续重复
    generatedSessions.add(sessionId);

    const title = extractTitle(ctx.query);
    if (!title) return;

    log.info(`Generated title for session ${sessionId}: "${title}"`);

    if (_onTitleUpdate) {
      try {
        _onTitleUpdate(sessionId, title);
      } catch (err) {
        log.warn("Title update callback failed", err);
      }
    }

    // 也通过 ActorSystem 事件通知
    ctx.actorSystem?.emitEvent?.({
      type: "session_title_updated",
      actorId: ctx.actorId,
      timestamp: Date.now(),
      detail: { sessionId, title },
    });
  }
}
