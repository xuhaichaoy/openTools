import type {
  AICenterCompatibleMode,
  AIProductMode,
  HumanSelectableAIProductMode,
  RuntimeSessionMode,
} from "@/core/ai/ai-mode-types";
import {
  getAIProductModeForRuntimeMode,
  normalizeAIProductMode,
} from "@/core/ai/ai-mode-types";

export type AIProductModeAvailability = "available" | "staged" | "runtime_only";

export interface AIProductModeDefinition {
  id: AIProductMode;
  label: string;
  availability: AIProductModeAvailability;
  runtimeMode: RuntimeSessionMode;
  aiCenterMode?: HumanSelectableAIProductMode;
  boundaryHeadline: string;
  boundaryDetail: string;
  modelScopeShort: string;
  modelScope: string;
  skillScopeShort: string;
  skillScope: string;
  runtimeLabel: string;
}

export const AI_PRODUCT_MODE_DEFINITIONS: Record<AIProductMode, AIProductModeDefinition> = {
  explore: {
    id: "explore",
    label: "Explore",
    availability: "available",
    runtimeMode: "ask",
    aiCenterMode: "explore",
    boundaryHeadline: "快速检索、提问与轻量交互",
    boundaryDetail: "适合快速提问、读图和轻工具检索；需要持续执行时转 Build。",
    modelScopeShort: "Explore 默认模型",
    modelScope: "顶部模型会记住 Explore 模式自己的选择，并用于后续 Explore 对话。",
    skillScopeShort: "当前对话自动激活",
    skillScope: "技能会根据当前输入自动激活，并注入当前 Explore 对话。",
    runtimeLabel: "Explore 对话",
  },
  build: {
    id: "build",
    label: "Build",
    availability: "available",
    runtimeMode: "agent",
    aiCenterMode: "build",
    boundaryHeadline: "单 Agent 持续执行与落地",
    boundaryDetail: "适合读代码、改文件、跑命令和验证结果的完整落地链路。",
    modelScopeShort: "Build 默认模型",
    modelScope: "顶部模型会记住 Build 模式自己的选择，并作为后续 Build 执行的默认模型。",
    skillScopeShort: "当前任务自动激活",
    skillScope: "技能会根据当前任务自动激活，作用于本次 Build 执行。",
    runtimeLabel: "Build 任务",
  },
  plan: {
    id: "plan",
    label: "Plan",
    availability: "available",
    runtimeMode: "cluster",
    aiCenterMode: "plan",
    boundaryHeadline: "先拆解，再并行规划与推进",
    boundaryDetail: "适合复杂任务拆解、分工分析和汇总；后续会继续向更纯粹的规划入口收敛。",
    modelScopeShort: "Plan 默认模型",
    modelScope: "顶部模型会记住 Plan 模式自己的选择，并用于新一轮规划、执行和汇总。",
    skillScopeShort: "整次任务统一生效",
    skillScope: "技能会按本次任务统一激活，作用于整轮 Plan 运行。",
    runtimeLabel: "Plan 会话",
  },
  review: {
    id: "review",
    label: "Review",
    availability: "staged",
    runtimeMode: "dialog",
    aiCenterMode: "review",
    boundaryHeadline: "只读审查与风险归纳",
    boundaryDetail: "对齐 Claude Code / Codex 的 review 语义，后续会成为独立入口。",
    modelScopeShort: "Review 默认模型",
    modelScope: "Review 将复用只读执行边界与审查协议，模型选择会独立记忆。",
    skillScopeShort: "按审查任务激活",
    skillScope: "技能会以审查任务为中心激活，强调风险、回归和证据链。",
    runtimeLabel: "Review 会话",
  },
  dialog: {
    id: "dialog",
    label: "Dialog",
    availability: "available",
    runtimeMode: "dialog",
    aiCenterMode: "dialog",
    boundaryHeadline: "多 Agent 持续协作房间",
    boundaryDetail: "适合 review、debug、brainstorm 等多角色协作；输入默认仍面向主 Agent。",
    modelScopeShort: "Dialog 默认模型",
    modelScope: "顶部模型会记住 Dialog 模式自己的选择，未单独覆写模型的 Agent 会按它运行。",
    skillScopeShort: "房间内按任务生效",
    skillScope: "技能会在每个 Agent 执行自己任务时自动激活，作用于整个协作房间。",
    runtimeLabel: "Dialog 房间",
  },
  im_conversation: {
    id: "im_conversation",
    label: "IM Conversation",
    availability: "runtime_only",
    runtimeMode: "im_conversation",
    boundaryHeadline: "渠道侧协作话题",
    boundaryDetail: "面向飞书、钉钉等外部会话，默认只展示 parent 视角和稳定状态。",
    modelScopeShort: "IM 会话默认模型",
    modelScope: "IM Conversation 会继承渠道会话的协作上下文，并沿用运行时绑定的执行策略。",
    skillScopeShort: "按当前话题生效",
    skillScope: "技能会随着当前话题的主 Agent 执行自动生效，不直接暴露子线程控制。",
    runtimeLabel: "IM 会话",
  },
};

export function getAIProductModeDefinition(mode: AIProductMode): AIProductModeDefinition {
  return AI_PRODUCT_MODE_DEFINITIONS[mode];
}

export function getAICenterProductMode(mode: AICenterCompatibleMode): AIProductMode {
  return normalizeAIProductMode(mode);
}

export function getAICenterProductModeDefinition(mode: AICenterCompatibleMode): AIProductModeDefinition {
  return getAIProductModeDefinition(getAICenterProductMode(mode));
}

export function getRuntimeProductMode(mode: RuntimeSessionMode | AIProductMode): AIProductMode {
  return getAIProductModeForRuntimeMode(mode);
}

export function getRuntimeProductModeDefinition(mode: RuntimeSessionMode | AIProductMode): AIProductModeDefinition {
  return getAIProductModeDefinition(getRuntimeProductMode(mode));
}

export function formatAICenterProductLabel(mode?: AICenterCompatibleMode | null): string {
  if (!mode) return "AI";
  return getAICenterProductModeDefinition(mode).label;
}

export function getDefaultRuntimeSessionLabel(mode: RuntimeSessionMode | AIProductMode): string {
  return getRuntimeProductModeDefinition(mode).runtimeLabel;
}
