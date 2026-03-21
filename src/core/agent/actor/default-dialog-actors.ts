import { DIALOG_FULL_ROLE } from "./agent-actor";
import type { ActorSystem } from "./actor-system";
import type { ChannelType } from "@/core/channels/types";
import type { ActorConfig, ExecutionPolicy, MiddlewareOverrides, ToolPolicy } from "./types";

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
    "- 系统具备【智能媒体回传】能力：如果你在回答中包含了本地图片或文件的绝对路径（如 /tmp/xxx.png），系统会自动将其作为媒体消息发送给用户。",
    "- 不要声称“当前渠道不能发图片/文件”或“只能把本机路径给用户去打开”。",
    "- 只要你生成了图片、截图或附件，并认为对用户有帮助，就直接在回答中输出其绝对路径即可，系统会代劳发送。",
  ].join("\n");
}

export function buildDefaultDialogActorConfig(
  roleName: string,
  options?: DefaultDialogActorSpawnOptions,
): Pick<ActorConfig, "role" | "toolPolicy" | "executionPolicy" | "middlewareOverrides"> {
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
  const executionPolicy: ExecutionPolicy = isExternalIM
    ? { accessMode: "read_only", approvalMode: "off" }
    : roleName === "Lead"
      ? { accessMode: "auto", approvalMode: "permissive" }
      : { accessMode: "auto", approvalMode: "normal" };
  const middlewareOverrides: MiddlewareOverrides = isExternalIM
    ? { approvalLevel: executionPolicy.approvalMode, disable: ["Clarification"] }
    : roleName === "Lead"
      ? { approvalLevel: executionPolicy.approvalMode }
      : {};

  return {
    role,
    toolPolicy,
    executionPolicy,
    middlewareOverrides,
  };
}

export function spawnDefaultDialogActors(
  system: ActorSystem,
  options?: DefaultDialogActorSpawnOptions,
): void {
  const coordinatorConfig = buildDefaultDialogActorConfig("Lead", options);
  system.spawn({
    id: `agent-${makeId()}`,
    role: coordinatorConfig.role,
    capabilities: {
      tags: [
        "coordinator",
        "synthesis",
        "code_analysis",
        "code_write",
        "debugging",
        "code_review",
        "testing",
        "file_write",
        "shell_execute",
        "information_retrieval",
        "web_search",
      ],
      description: "默认主代理，先独立推进任务；只有在确实值得时才按需创建临时子代理做探索、审查或验证。",
    },
    maxIterations: 40,
    contextTokens: 16_000,
    ...(coordinatorConfig.toolPolicy ? { toolPolicy: coordinatorConfig.toolPolicy } : {}),
    executionPolicy: coordinatorConfig.executionPolicy,
    middlewareOverrides: coordinatorConfig.middlewareOverrides,
  });
}
