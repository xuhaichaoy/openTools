import { DIALOG_FULL_ROLE } from "./agent-actor";
import type { ActorSystem } from "./actor-system";
import type { ChannelType } from "@/core/channels/types";
import type { ActorConfig } from "./types";
import {
  buildMiddlewareOverridesForExecutionPolicy,
  getDefaultDialogActorPolicyProfile,
} from "./execution-policy";
import {
  resolveSurfaceExecutionPolicy,
  resolveSurfaceToolPolicy,
} from "@/core/collaboration/surface-security-policy";

function makeId(): string {
  return Math.random().toString(36).substring(2, 8);
}

export interface DefaultDialogActorSpawnOptions {
  mode?: "local" | "external_im";
  channelType?: ChannelType;
  productMode?: "dialog" | "review";
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
    "- 当前渠道使用 OpenClaw 风格的结构化媒体协议。",
    "- 如果你已经知道要发回的本地图片/文件路径，优先调用 `send_local_media` 工具，而不是把路径直接写进正文。",
    "- 当用户说“把这张图/本地图片发给我”时，优先使用 `send_local_media(path=...)` 或 `send_local_media(use_current_images=true)`。",
    "- 如果你希望系统把图片、截图或文件作为附件发回给用户，必须单独输出一行 `MEDIA:<path-or-url>`。",
    "- `MEDIA:` 主要用作 fallback：适合工具原样产出截图路径、浏览器 CLI、MCP 返回媒体引用时转发。",
    "- 一条回复里可以有多条 `MEDIA:`；每条各占一行，不要和正文混写。",
    "- 正文里先正常说明结果，再附 `MEDIA:` 行。例如：`已完成，见截图。` 换行后再写 `MEDIA:/tmp/weather.png`。",
    "- 不要只输出裸绝对路径来代替 `MEDIA:`。",
    "- 不要声称“当前渠道不能发图片/文件”或“只能把本机路径给用户去打开”。",
  ].join("\n");
}

function buildLocalDialogSystemPromptAppend(productMode?: "dialog" | "review"): string {
  const surfaceLabel = productMode === "review" ? "桌面 Review" : "桌面 Dialog";
  return [
    `## ${surfaceLabel} 媒体回传规则（高优先级）`,
    "当前是桌面端本机会话，不是外部 IM。",
    "- 桌面端可以直接展示本地图片和导出文件，不要声称“当前会话不能直接回发本地图片/文件”。",
    "- 当你已经拿到本地图片、截图或导出文件路径时，正文正常说明结果后，单独输出一行 `MEDIA:<绝对路径或 URL>`，桌面端会直接展示。",
    "- 一条回复里可以有多条 `MEDIA:`；每条各占一行，不要和正文混写。",
    "- 如果用户说“发我图/把图片给我/把文件给我”，在本地桌面会话里就直接用 `MEDIA:` 回传，不要让用户再去 Finder/Downloads 手动找。",
    "- 不要只说“路径在 /Users/...”，而不附 `MEDIA:`。",
  ].join("\n");
}

export function buildDefaultDialogActorConfig(
  roleName: string,
  options?: DefaultDialogActorSpawnOptions,
): Pick<ActorConfig, "role" | "toolPolicy" | "executionPolicy" | "middlewareOverrides"> {
  const isExternalIM = options?.mode === "external_im";
  const localProductMode = options?.productMode === "review" ? "review" : "dialog";
  const policyProfile = isExternalIM
    ? getDefaultDialogActorPolicyProfile("external_im")
    : roleName === "Lead"
      ? getDefaultDialogActorPolicyProfile("lead")
      : getDefaultDialogActorPolicyProfile("support");
  const executionPolicy = resolveSurfaceExecutionPolicy({
    surface: isExternalIM ? "im_conversation" : "local_dialog",
    productMode: isExternalIM ? "im_conversation" : localProductMode,
    basePolicy: policyProfile.executionPolicy,
  });
  const toolPolicy = resolveSurfaceToolPolicy({
    surface: isExternalIM ? "im_conversation" : "local_dialog",
    productMode: isExternalIM ? "im_conversation" : localProductMode,
    baseToolPolicy: policyProfile.toolPolicy,
  });
  const role = isExternalIM
    ? {
        ...DIALOG_FULL_ROLE,
        name: roleName,
        systemPrompt: [
          DIALOG_FULL_ROLE.systemPrompt,
          buildExternalIMSystemPromptAppend(options?.channelType),
        ].join("\n\n"),
      }
    : {
        ...DIALOG_FULL_ROLE,
        name: roleName,
        systemPrompt: [
          DIALOG_FULL_ROLE.systemPrompt,
          buildLocalDialogSystemPromptAppend(localProductMode),
        ].join("\n\n"),
      };

  return {
    role,
    ...(toolPolicy ? { toolPolicy } : {}),
    executionPolicy,
    middlewareOverrides: buildMiddlewareOverridesForExecutionPolicy(
      executionPolicy,
      policyProfile.middlewareOverrides,
    ),
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
