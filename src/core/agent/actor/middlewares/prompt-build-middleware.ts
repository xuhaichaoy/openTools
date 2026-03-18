import { buildAssistantSupplementalPrompt } from "@/core/ai/assistant-config";
import {
  assembleAgentExecutionContext,
  buildAgentExecutionContextPlan,
} from "@/core/agent/context-runtime";
import { useAIStore } from "@/store/ai-store";
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
    const supplementalSystemPrompt = buildAssistantSupplementalPrompt(
      useAIStore.getState().config.system_prompt,
    );
    const executionContextPlan = await buildAgentExecutionContextPlan({
      query: ctx.query,
      explicitWorkspaceRoot: ctx.workspace,
      images: ctx.getCurrentImages?.() ?? ctx.images,
    });
    const assembledContext = await assembleAgentExecutionContext({
      query: ctx.query,
      executionContextPlan,
      supplementalSystemPrompt,
    });
    const effectiveWorkspaceRoot = assembledContext.effectiveWorkspaceRoot;

    if (assembledContext.extraSystemPrompt) {
      prompt += `\n\n${assembledContext.extraSystemPrompt}`;
    }

    if (effectiveWorkspaceRoot) {
      prompt += `\n\n## 工作目录\n你的工作目录为: ${effectiveWorkspaceRoot}\n执行 shell 命令和文件操作时，请在此目录下进行。`;
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
    const coordinator = system.getCoordinator();
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
- 当前房间没有合适角色，但确实需要专门执行者 / 独立审查者时 → 可以用 \`spawn_task\` 配合 \`create_if_missing=true\` 创建临时子 Agent

**不要独自完成所有工作！主动与其他 Agent 讨论和协作，你能更快更好地完成复杂任务。**`;

    if (isCoordinator) {
      section += `\n\n## 当前角色：协调者
- 你默认是本轮主协调者，应先拆解任务，再决定是否立即用 \`spawn_task\` 派发给其他 Agent。
- 多 Agent 的首要价值是隔离注意力：你负责理解需求、拆解任务和最后整合。
- 尽量把执行、验证、审查分给不同 Agent；如果条件允许，保留一个独立审查 Agent，避免实现上下文污染审查判断。
- 子任务返回后，要继续 review、补问、整合，而不是只转述结果。
- 最终结论、最终方案、最终交付说明应由你统一输出。`;
    }

    if (!isCoordinator) {
      section += `\n\n## 当前角色：执行者（非协调者）
- 你当前不是协调者，默认不要向用户发"收到/待命/请分配任务"这类回执消息。
- 默认不要重复做整轮分工，也不要宣称"我来协调"。
- 但如果你收到的子任务本身仍然复杂到必须继续拆分，你可以再用 \`spawn_task\` 派发更小、更具体的子任务。
- 即使继续拆分，你仍然要对自己这段任务的结果负责，并把整理后的可用结论回传给上游协调者。`;
    }

    return section;
  }
}
