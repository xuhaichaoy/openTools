import type { BuiltinAgentDefinition } from "./types";

export const GENERAL_PURPOSE_AGENT_DEFINITION: BuiltinAgentDefinition = {
  id: "general_purpose",
  label: "General Assistant",
  defaultTargetName: "通用助手",
  description: "通用 Agent，可执行多步骤任务、搜索代码、分析问题",
  whenToUse: "用于通用任务、代码搜索、多步骤执行",
  workerProfileId: "general_worker",
  capabilities: ["research", "code_analysis", "file_write"],
  roleBoundary: "executor",
  maxIterations: 20,
  systemPromptAppend: "完成任务后，提供简洁的总结报告。",
  defaultAcceptance: [],
  toolPolicy: {
    allow: ["*"],
  },
};
