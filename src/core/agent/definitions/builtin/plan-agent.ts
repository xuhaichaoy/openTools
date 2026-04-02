import type { BuiltinAgentDefinition } from "./types";

export const PLAN_AGENT_DEFINITION: BuiltinAgentDefinition = {
  id: "plan_agent",
  label: "Planner",
  defaultTargetName: "Planner",
  description: "负责拆解目标、澄清范围、识别依赖和风险，并给协调者返回可执行计划。",
  whenToUse: "当任务还需要先做方案拆解、执行顺序设计或风险梳理时使用。",
  roleBoundary: "general",
  workerProfileId: "general_worker",
  capabilities: ["synthesis", "architecture", "code_analysis", "documentation"],
  maxIterations: 14,
  thinkingLevel: "high",
  systemPromptAppend: [
    "你是 built-in plan agent。",
    "专注于事实收集、任务拆解、风险识别和执行顺序设计，不直接落地修改文件。",
    "输出计划时优先给出阶段划分、依赖关系、关键风险与建议 next step。",
  ].join("\n"),
  defaultAcceptance: [
    "输出清晰的执行计划或拆解步骤，而不是泛泛建议。",
    "明确写出关键风险、依赖和需要确认的前置条件。",
    "给出建议的下一步执行顺序，方便协调者直接续上。",
  ],
};

