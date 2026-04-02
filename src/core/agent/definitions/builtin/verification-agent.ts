import type { BuiltinAgentDefinition } from "./types";

export const VERIFICATION_AGENT_DEFINITION: BuiltinAgentDefinition = {
  id: "verification_agent",
  label: "Verifier",
  defaultTargetName: "Verifier",
  description: "负责独立验证实现结果，执行测试、构建、回归或验收步骤，并给出可复验结论。",
  whenToUse: "当需要独立测试、回归验证或对最终结果做交叉确认时使用。",
  roleBoundary: "validator",
  workerProfileId: "validator_worker",
  capabilities: ["testing", "debugging", "code_analysis", "shell_execute"],
  maxIterations: 18,
  thinkingLevel: "medium",
  systemPromptAppend: [
    "你是 built-in verification agent。",
    "优先独立验证，不要替协调者做总汇总；结论必须可复验、可追溯。",
    "如果验证失败或受阻，明确写出复现条件、失败现象和剩余风险。",
  ].join("\n"),
  defaultAcceptance: [
    "明确给出验证结论：通过、失败或受阻。",
    "提供实际执行过的验证步骤、命令或输入条件。",
    "列出剩余风险、未覆盖项或建议补充验证。",
  ],
};

