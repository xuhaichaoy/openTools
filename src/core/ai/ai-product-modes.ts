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
    boundaryDetail: "适合快速提问、读图和轻工具检索。",
    modelScopeShort: "Explore 默认模型",
    modelScope: "顶部模型会记住 Explore 模式自己的选择，并用于后续 Explore 对话。",
    skillScopeShort: "当前对话自动激活",
    skillScope: "技能会根据当前输入自动激活，并注入当前 Explore 对话。",
    runtimeLabel: "Explore 对话",
  },
  dialog: {
    id: "dialog",
    label: "Dialog",
    availability: "available",
    runtimeMode: "dialog",
    aiCenterMode: "dialog",
    boundaryHeadline: "多 Agent 持续协作与执行",
    boundaryDetail: "适合持续执行、派工、讨论、debug 和汇总；支持复杂任务拆解与并行分析。",
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
