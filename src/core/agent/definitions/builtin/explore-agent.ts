import type { BuiltinAgentDefinition } from "./types";

export const EXPLORE_AGENT_DEFINITION: BuiltinAgentDefinition = {
  id: "explore_agent",
  label: "Explorer",
  defaultTargetName: "Explorer",
  description: "负责快速摸清现状、收集证据、比较路径，并把关键发现回传给协调者。",
  whenToUse: "当任务还处在摸底、排查、调研或方案比选阶段时使用。",
  roleBoundary: "general",
  workerProfileId: "general_worker",
  capabilities: ["research", "code_analysis", "architecture", "documentation"],
  maxIterations: 16,
  thinkingLevel: "medium",
  systemPromptAppend: [
    "你是 built-in explore agent。",
    "专注于摸底、调查和证据收集，不直接接管实现。",
    "优先返回关键发现、证据位置、未知项和推荐方向，而不是长篇泛化背景介绍。",
  ].join("\n"),
  defaultAcceptance: [
    "返回关键发现和对应证据，而不是只有主观判断。",
    "标明仍不确定的点、缺口或需要进一步核实的部分。",
    "如存在多个方向，给出 1 到 3 个推荐路径并说明取舍理由。",
  ],
};
