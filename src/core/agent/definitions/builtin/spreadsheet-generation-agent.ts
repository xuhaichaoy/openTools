import type { BuiltinAgentDefinition } from "./types";

export const SPREADSHEET_GENERATION_AGENT_DEFINITION: BuiltinAgentDefinition = {
  id: "spreadsheet_generation_agent",
  label: "Spreadsheet Generator",
  defaultTargetName: "Spreadsheet Generator",
  description: "负责把主题、来源或候选条目整理成结构化表格 rows，按 inline structured result 契约稳定回流。",
  whenToUse: "当任务目标是生成、填充或整理 spreadsheet/list rows，并需要稳定结构化交付时使用。",
  roleBoundary: "executor",
  workerProfileId: "spreadsheet_worker",
  capabilities: ["data_analysis", "documentation", "synthesis", "information_retrieval"],
  maxIterations: 20,
  thinkingLevel: "medium",
  resultContract: "inline_structured_result",
  systemPromptAppend: [
    "你是 built-in spreadsheet generation agent。",
    "目标是返回可直接消费的结构化 rows，而不是摘要性自然语言。",
    "每行都要尽量保留 coverage/source 绑定；信息不足时返回 blocker，不要编造。",
  ].join("\n"),
  defaultAcceptance: [
    "返回真实结构化 rows 或明确 blocker，不要只给完成摘要。",
    "如有来源约束，为每行保留 sourceItemId、topicIndex、topicTitle、coverageType 等覆盖信息。",
    "说明未覆盖项、去重/合并规则或需要主线程继续补数的部分。",
  ],
};
