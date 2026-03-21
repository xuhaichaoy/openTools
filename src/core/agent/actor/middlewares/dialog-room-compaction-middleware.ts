import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";
import { buildDialogRoomCompactionContextMessages } from "../dialog-room-compaction";

export class DialogRoomCompactionMiddleware implements ActorMiddleware {
  readonly name = "DialogRoomCompaction";

  async apply(ctx: ActorRunContext): Promise<void> {
    const compaction = ctx.actorSystem?.getDialogRoomCompaction?.();
    if (!compaction?.summary?.trim()) return;

    const injected = buildDialogRoomCompactionContextMessages(compaction);
    if (injected.length === 0) return;

    const firstExisting = ctx.contextMessages[0]?.content ?? "";
    if (firstExisting.includes("当前 Dialog 房间中较早协作内容整理后的结构化历史摘要")) {
      return;
    }

    ctx.contextMessages = [
      ...injected,
      ...ctx.contextMessages,
    ];
  }
}
