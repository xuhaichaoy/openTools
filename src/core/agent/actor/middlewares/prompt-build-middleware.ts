import { buildAssistantSupplementalPrompt } from "@/core/ai/assistant-config";
import {
  assembleAgentExecutionContext,
  buildAgentExecutionContextPlan,
} from "@/core/agent/context-runtime";
import { buildExecutionContractPresentationText } from "@/core/collaboration/presentation";
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

    if (ctx.executionMode === "plan") {
      prompt += `\n\n## 当前模式：Plan（只读规划）
你当前处于规划模式，只能做信息收集、分析、方案设计和风险评估。
- 不要修改文件、执行命令或发起实际落地操作
- 不要派发子任务、等待子任务、向其他 Agent 发消息推动执行
- 输出应聚焦：现状判断、可选方案、风险/依赖、建议的下一步执行顺序`;
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
    const activeContract = system.getActiveExecutionContract();
    const delegationHint = activeContract?.plannedDelegations.length
      ? `已批准建议委派 ${activeContract.plannedDelegations.length} 条，可按需参考和复用。`
      : "";

    let section = `\n\n## 多 Agent 协作（重要！）
当前会话中有 ${system.size} 个 Agent：${agentNames}`;

    if (activeContract) {
      section += `\n\n## 当前执行契约
${buildExecutionContractPresentationText(activeContract)}`;
      if (delegationHint) {
        section += `\n${delegationHint}`;
      }
    }

    if (isCoordinator) {
      section += `\n\n你有以下方式与其他 Agent 协作：

1. **派发子任务**：用 \`spawn_task\` 派发给其他 Agent 执行（如 @${agentNames}）。
2. **等待派发结果**：当你的下一步明确依赖子任务结果时，再调用 \`wait_for_spawned_tasks\` 挂起等待。系统会把这些子任务的完整结果注入给你的上下文。
3. **发起讨论**：用 \`send_message\` 向其他 Agent 发送消息、分享发现、提出问题、请求建议。

**典型场景**：
- 需要别人帮你完成部分工作时 → 用 \`spawn_task\` 派发任务；如果你还可以继续协调、追问或安排其他步骤，不必立刻等待。
- 想和别人讨论一个问题时 → 用 \`send_message\` 发起对话。
- 当前房间没有合适角色，但确实需要专门执行者时 → 可以用 \`spawn_task\` 配合 \`create_if_missing=true\` 创建临时子 Agent。

**不要独自完成所有工作！主动与其他 Agent 讨论和协作，你能更快更好地完成复杂任务。**

## 当前角色：协调者
- 你默认是本轮主协调者，应先拆解任务，再决定是否立即用 \`spawn_task\` 派发给其他 Agent。
- 多 Agent 的首要价值是隔离注意力：你负责理解需求、拆解任务和最后整合。
- 已批准建议委派只是许可与建议，不是必须照单执行；你可以复用、改写、合并或跳过。
- 尽量把执行、验证、审查分给不同 Agent并**并行**派发多项任务；只有当后续步骤被子任务结果阻塞时，再调用 \`wait_for_spawned_tasks\`。
- 使用 \`spawn_task\` 时，任务描述至少写清：目标、范围/相关文件、补充上下文、职责边界、验收标准；子 Agent 应在这个边界内自行决定执行步骤，而不是等你逐步遥控。
- 【严禁操作】不要在派发完 \`spawn_task\` 后，没拿到结果就自己靠想象输出"最终总结"或"结论"！你必须等 \`wait_for_spawned_tasks\` 返回真实的详细结果。
- \`wait_for_spawned_tasks\` 结束并拿到各方结果后，你要继续 review、补充整合，输出一份结构清晰的全局最终结论。`;
    }

    if (!isCoordinator) {
      section += `\n\n你当前主要通过以下方式协作：

1. **执行分配给你的任务**：聚焦完成本轮职责边界，不要自己改写整轮分工。
2. **向其他 Agent 讨论**：如需补充背景、同步发现或请教建议，可以用 \`send_message\`。
3. **回传新增派工建议**：如果你判断还需要额外子线程，不要自己继续 \`spawn_task\`，而是把建议和原因回传协调者，由协调者决定是否继续派工。

## 当前角色：执行者（非协调者）
- 你当前不是协调者，默认不要向用户发"收到/待命/请分配任务"这类回执消息。
- 默认不要重复做整轮分工，也不要宣称"我来协调"。
- 当前默认由协调者统一创建子线程；你如果发现需要新增实现、审查或验证线程，请把建议回传协调者。
- **最终交付要求（十分重要）**：当你的执行步骤走完，要输出最终 answer（或告知任务完成）时，请只输出 **最精简的一两句话摘要**。
- 不要输出长篇大论的报告！你的工作全过程和完整结论已经被系统在后台自动原封不动地传给了协调者去汇总。你这里的 answer 只是公屏的一个已完成进度通知。`;
    }

    return section;
  }
}
