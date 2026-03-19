import { DIALOG_FULL_ROLE } from "./agent-actor";
import type { ActorSystem } from "./actor-system";
import type { ChannelType } from "@/core/channels/types";
import type { ActorConfig, MiddlewareOverrides, ToolPolicy } from "./types";

function makeId(): string {
  return Math.random().toString(36).substring(2, 8);
}

export interface DefaultDialogActorSpawnOptions {
  mode?: "local" | "external_im";
  channelType?: ChannelType;
}

function buildExternalIMSystemPromptAppend(channelType?: ChannelType): string {
  const channelLabel = channelType === "dingtalk"
    ? "钉钉"
    : channelType === "feishu"
      ? "飞书"
      : "外部 IM";
  return [
    "## 外部 IM 渠道约束（高优先级，覆盖下方通用规则）",
    `当前用户通过${channelLabel}渠道和你交流，这不是桌面交互界面。`,
    "- 不要调用 ask_user 工具。",
    "- 不要调用 ask_clarification 工具。",
    "- 不要发起任何审批流程，也不要等待审批。",
    "- 如果信息不足，直接用自然语言向用户提一个简洁问题，等待用户下一条消息。",
    "- 提问时不要把问题拆成复杂表单，优先一次只问最关键的一个问题。",
    "- 如果操作本应审批，直接明确说明“这个操作需要回到本机确认”，不要在渠道里卡住流程。",
    "- 渠道对话里不要提及 ask_user、审批弹窗、计划模式等内部机制。",
  ].join("\n");
}

function buildDefaultActorConfig(
  roleName: "Coordinator" | "Specialist",
  options?: DefaultDialogActorSpawnOptions,
): Pick<ActorConfig, "role" | "toolPolicy" | "middlewareOverrides"> {
  const isExternalIM = options?.mode === "external_im";
  const role = isExternalIM
    ? {
        ...DIALOG_FULL_ROLE,
        name: roleName,
        systemPrompt: [
          DIALOG_FULL_ROLE.systemPrompt,
          buildExternalIMSystemPromptAppend(options?.channelType),
        ].join("\n\n"),
      }
    : { ...DIALOG_FULL_ROLE, name: roleName };

  const toolPolicy: ToolPolicy | undefined = isExternalIM
    ? { deny: ["ask_user"] }
    : undefined;
  const middlewareOverrides: MiddlewareOverrides = isExternalIM
    ? { approvalLevel: "off", disable: ["Clarification"] }
    : roleName === "Coordinator"
      ? { approvalLevel: "permissive" }
      : {};

  return {
    role,
    toolPolicy,
    middlewareOverrides,
  };
}

export function spawnDefaultDialogActors(
  system: ActorSystem,
  options?: DefaultDialogActorSpawnOptions,
): void {
  const coordinatorConfig = buildDefaultActorConfig("Coordinator", options);
  system.spawn({
    id: `agent-${makeId()}`,
    role: coordinatorConfig.role,
    capabilities: {
      tags: ["coordinator", "synthesis", "code_analysis"],
      description: "默认协调者，负责理解任务、分配讨论方向并收束结论。",
    },
    ...(coordinatorConfig.toolPolicy ? { toolPolicy: coordinatorConfig.toolPolicy } : {}),
    middlewareOverrides: coordinatorConfig.middlewareOverrides,
  });

  const specialistConfig = buildDefaultActorConfig("Specialist", options);
  system.spawn({
    id: `agent-${makeId()}`,
    role: specialistConfig.role,
    capabilities: {
      tags: ["code_analysis", "code_write", "debugging"],
      description: "默认执行者，负责深入分析、修复建议和具体实现细节。",
    },
    ...(specialistConfig.toolPolicy ? { toolPolicy: specialistConfig.toolPolicy } : {}),
    middlewareOverrides: specialistConfig.middlewareOverrides,
  });
}
