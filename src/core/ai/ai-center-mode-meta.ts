import type { AICenterMode, AICenterSourceRef } from "@/store/app-store";

export interface AICenterModeMeta {
  label: string;
  boundaryHeadline: string;
  boundaryDetail: string;
  modelScopeShort: string;
  modelScope: string;
  skillScopeShort: string;
  skillScope: string;
}

export const AI_CENTER_MODE_META: Record<AICenterMode, AICenterModeMeta> = {
  ask: {
    label: "Ask",
    boundaryHeadline: "轻量对话与快速求助",
    boundaryDetail: "适合提问、读图和轻工具；需要持续执行时转 Agent。",
    modelScopeShort: "Ask 模式默认模型",
    modelScope: "顶部模型会记住 Ask 模式自己的选择，并用于 Ask 模式后续请求。",
    skillScopeShort: "当前对话自动激活",
    skillScope: "技能会根据当前输入自动激活，并注入 Ask 对话。",
  },
  agent: {
    label: "Agent",
    boundaryHeadline: "单 Agent 持续执行",
    boundaryDetail: "适合读代码、改文件、跑命令、验证结果的完整落地链路。",
    modelScopeShort: "Agent 模式默认模型",
    modelScope: "顶部模型会记住 Agent 模式自己的选择，并作为 Agent 后续执行的默认模型。",
    skillScopeShort: "当前任务自动激活",
    skillScope: "技能会根据当前任务自动激活，作用于本次 Agent 执行。",
  },
  cluster: {
    label: "Cluster",
    boundaryHeadline: "先拆解，再并行执行",
    boundaryDetail: "适合复杂任务规划、分工分析和汇总；不适合持续来回讨论。",
    modelScopeShort: "Cluster 模式默认模型",
    modelScope: "顶部模型会记住 Cluster 模式自己的选择，并用于新一轮 Planner、执行和汇总。",
    skillScopeShort: "整次任务统一生效",
    skillScope: "技能会按本次任务统一激活，作用于整轮 Cluster 运行。",
  },
  dialog: {
    label: "Dialog",
    boundaryHeadline: "多 Agent 持续协作房间",
    boundaryDetail: "适合 review、debug、brainstorm；如果目标是落地代码，优先 Agent。",
    modelScopeShort: "Dialog 房间默认模型",
    modelScope: "顶部模型会记住 Dialog 模式自己的选择，未单独覆写模型的 Agent 会按它运行。",
    skillScopeShort: "房间内按 Agent 任务生效",
    skillScope: "技能会在每个 Agent 执行自己任务时自动激活，作用于整个协作房间。",
  },
};

export function formatAICenterModeLabel(mode?: AICenterMode | null): string {
  if (!mode) return "AI";
  return AI_CENTER_MODE_META[mode]?.label ?? mode;
}

export function describeAICenterSource(source?: Partial<AICenterSourceRef> | null): string {
  if (!source?.sourceMode) return "外部上下文";
  return source.sourceLabel?.trim() || formatAICenterModeLabel(source.sourceMode);
}
