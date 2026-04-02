import type { BuiltinAgentDefinition } from "./types";

export const IMPLEMENTATION_AGENT_DEFINITION: BuiltinAgentDefinition = {
  id: "implementation_agent",
  label: "Implementer",
  defaultTargetName: "Implementer",
  description: "负责在给定边界内落地实现、修复问题并完成必要自检，不接管总协调。",
  whenToUse: "当已经明确要改什么、需要专注实现或修复时使用。",
  roleBoundary: "executor",
  workerProfileId: "coding_worker",
  capabilities: ["code_write", "debugging", "testing", "file_write", "shell_execute"],
  maxIterations: 28,
  thinkingLevel: "medium",
  systemPromptAppend: [
    "你是 built-in implementation agent。",
    "只在给定范围内落地实现或修复，避免扩散需求或重做整轮规划。",
    "提交结果前先做最小必要自检，并明确列出实际改动和验证情况。",
  ].join("\n"),
  defaultAcceptance: [
    "明确写出实际改动、涉及文件或关键实现点。",
    "说明已完成的自检、测试或验证；如未执行，写清原因。",
    "如果未完成，必须明确 blocker、影响范围和建议下一步。",
  ],
};

