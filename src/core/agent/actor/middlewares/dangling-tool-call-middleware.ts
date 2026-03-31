/**
 * DanglingToolCallMiddleware — 对齐 DeerFlow 的 dangling tool call 修补语义
 *
 * 我们当前的 Actor middleware 链只能在 ReActAgent 运行前准备上下文，
 * 真正的消息修补发生在 ReActAgent 送模型前的 message prepare 阶段。
 * 这个 middleware 的职责是显式开启那层 guardrail。
 */

import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

export class DanglingToolCallMiddleware implements ActorMiddleware {
  readonly name = "DanglingToolCall";

  async apply(ctx: ActorRunContext): Promise<void> {
    ctx.patchDanglingToolCalls = true;
  }
}
