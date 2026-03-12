import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

/**
 * PromptBuildMiddleware — assembles the final system prompt by appending:
 *  1. Workspace directive
 *  2. Multi-agent collaboration instructions (when ≥2 agents)
 *  3. Non-coordinator role hints
 */
export class PromptBuildMiddleware implements ActorMiddleware {
  readonly name = "PromptBuild";

  async apply(ctx: ActorRunContext): Promise<void> {
    let prompt = ctx.systemPromptOverride ?? ctx.role.systemPrompt ?? "";

    if (ctx.workspace) {
      prompt += `\n\n## 工作目录\n你的工作目录为: ${ctx.workspace}\n执行 shell 命令和文件操作时，请在此目录下进行。`;
    }

    if (ctx.actorSystem && ctx.actorSystem.size >= 2) {
      prompt += this.buildCollaborationPrompt(ctx);
    }

    ctx.rolePrompt = prompt;
  }

  private buildCollaborationPrompt(ctx: ActorRunContext): string {
    const system = ctx.actorSystem!;
    const otherAgents = system.getAll().filter((a) => a.id !== ctx.actorId);
    const agentNames = otherAgents.map((a) => a.role.name).join("、");
    const coordinator = system.getFirstActor();
    const isCoordinator = coordinator?.id === ctx.actorId;

    let section = `\n\n## 多 Agent 协作（重要！）
当前会话中有 ${system.size} 个 Agent：${agentNames}

你有两种方式与其他 Agent 协作：

1. **派发子任务**：用 \`spawn_task\` 派发给其他 Agent 执行（如 @${agentNames}），结果会自动回送
2. **发起讨论**：用 \`send_message\` 向其他 Agent 发送消息、分享发现、提出问题、请求建议

**典型场景**：
- 需要别人帮你完成部分工作时 → 用 \`spawn_task\` 派发任务
- 想和别人讨论一个问题时 → 用 \`send_message\` 发起对话
- 遇到难题时 → 可以先 \`send_message\` 询问其他 Agent 的看法，再决定是否派发任务

**不要独自完成所有工作！主动与其他 Agent 讨论和协作，你能更快更好地完成复杂任务。**`;

    if (!isCoordinator) {
      section += `\n\n## 当前角色：执行者（非协调者）
- 你当前不是协调者，默认不要向用户发"收到/待命/请分配任务"这类回执消息。
- 除非被明确要求，不要安排其他 Agent，不要重复分工，不要宣称"我来协调"。
- 你的职责是执行被分配的任务，并输出可直接使用的结果。`;
    }

    return section;
  }
}
