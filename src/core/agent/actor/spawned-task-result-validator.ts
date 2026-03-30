import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { isLikelyExecutionPlanReply, taskExplicitlyRequestsPlan } from "./result-shape-detection";
import type { DialogArtifactRecord, SpawnedTaskRecord } from "./types";

export interface SpawnedTaskResultValidation {
  accepted: boolean;
  reason?: string;
  requiresConcreteOutput: boolean;
}

const CONCRETE_OUTPUT_PATTERNS = [
  /网页|页面|html|react|vue|组件|前端|ui|css|样式/i,
  /代码|文件|脚本|函数|模块|接口|实现|修复|重构|build|create|implement|write|fix/i,
  /文档|报告|方案|课程|课纲|提案|word|docx|rtf|pdf|ppt|excel|xlsx|导出|保存|下载/i,
];

const RESULT_EVIDENCE_PATTERNS = [
  /```/,
  /<!doctype html>|<html|<div|<section|<main|<template|<script|<style/i,
  /\bimport\s+|\bexport\s+|\bfunction\s+\w+|\bclass\s+\w+|\bconst\s+\w+\s*=|\blet\s+\w+\s*=/i,
  /\/[\w./-]+\.(?:tsx?|jsx?|vue|html|css|scss|less|json|rs|py|go|java|kt|swift)/i,
  /\b(?:tsx?|jsx?|vue|html|css|scss|less|json|rs|py|go|java)\b/i,
  /已创建|已生成|已修改|已修复|文件|路径|产物|artifact|patch|diff|lint|test|验证/i,
];

const COORDINATION_META_SUMMARY_PATTERNS = [
  /已确认源文件/u,
  /已完成\s*\d+\s*个(?:分段|子)?任务/u,
  /当前(?:真实)?缺口|剩余缺口|尚缺|补未齐/u,
  /产物位置[:：]/u,
  /建议作为正式交付说明/u,
  /历史文档产物/u,
  /已收到详细文本/u,
  /仅确认完成状态/u,
  /wait_for_spawned_tasks|memory_search|agents/u,
];

const SCHEDULE_MUTATION_TASK_PATTERNS = [
  /(创建|新建|设置|添加|安排|开启|启动).*(提醒|定时任务|任务|闹钟)/iu,
  /(取消|删除|暂停|恢复|修改|调整|改成).*(提醒|定时任务|任务|闹钟)/iu,
  /每隔.+(?:秒|分钟|小时|天).*(提醒|通知)/iu,
  /(?:\d+|一|二|三|四|五|六|七|八|九|十|两).*(?:秒|分钟|小时|天)后提醒/iu,
];

const SCHEDULE_MUTATION_SUCCESS_PATTERNS = [
  /已创建|已新建|已设置|已添加|已取消|已暂停|已恢复/iu,
  /任务\s*ID|首次提醒|下次执行|提醒计划|当前定时任务汇总|间隔[:：]/iu,
];

const SCHEDULE_MUTATION_TOOL_NAMES = new Set([
  "schedule_task",
  "cancel_schedule",
  "native_reminder_create",
]);

const INCOMPLETE_RESULT_PATTERNS = [
  /未能完全完成/iu,
  /未完全完成/iu,
  /部分完成/iu,
  /仍有.{0,12}(?:未完成|待补|缺失)/iu,
  /迭代限制/iu,
  /提前停止/iu,
];

const HISTORICAL_CONFIRMATION_PATTERNS = [
  /根据记忆检索结果/iu,
  /我已确认以下历史信息/iu,
  /我确认以下历史信息/iu,
  /目标\s*(?:excel|xlsx|xls|csv|表格|工作簿)\s*文件存在/iu,
];

const EXPLICIT_BLOCKER_PATTERNS = [
  /阻塞(?:原因|点)?[:：]?/iu,
  /无法(?:完成|导出|生成|写入|交付)/iu,
  /未能(?:完成|导出|生成|写入|交付)/iu,
  /失败(?:原因)?[:：]?/iu,
  /缺失条件|缺少前提|缺少权限|权限不足/iu,
  /工具(?:不可用|失败)|导出失败|参数校验失败/iu,
];

type OutputContract = {
  kind: "spreadsheet";
  label: string;
  extensions: string[];
  toolNames: string[];
};

function isContentExecutorPartialContract(task: SpawnedTaskRecord): boolean {
  return task.executionIntent === "content_executor";
}

function normalizeText(input?: string | null): string {
  return String(input ?? "").replace(/\s+/g, " ").trim();
}

function isMathOnlyResult(task: string, result: string): boolean {
  if (/计算|数学|math|sum|加减乘除|面积|尺寸换算/i.test(task)) {
    return false;
  }
  const normalized = result.replace(/\s+/g, "");
  return /^(\[.*?\])?[-\d.]+[+\-*/xX][-.\d]+=-?[-.\d]+[。.!]?$/i.test(normalized)
    || /^(\[.*?\])?[\d\s+\-*/=xX().]+$/.test(result.trim());
}

function requiresConcreteOutput(task: string): boolean {
  const inferredCoding = inferCodingExecutionProfile({ query: task });
  if (inferredCoding.profile.codingMode) return true;
  return CONCRETE_OUTPUT_PATTERNS.some((pattern) => pattern.test(task));
}

function resolveOutputContract(task: string): OutputContract | null {
  const normalized = normalizeText(task);
  const requestsSpreadsheetOutput = [
    /(?:最终|最后|输出|导出|保存|生成|给我|给出|返回).{0,18}(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿)?/iu,
    /(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿).{0,12}(?:输出|导出|保存|生成|给我|给出|返回|最终|最后)/iu,
  ].some((pattern) => pattern.test(normalized));
  const requestsExcelOutput = /(?:excel|xlsx|xls)/iu.test(normalized);
  const requestsCsvOutput = /(?:csv)/iu.test(normalized);

  if (!requestsSpreadsheetOutput) return null;
  if (requestsExcelOutput) {
    return {
      kind: "spreadsheet",
      label: "Excel 文件",
      extensions: ["xlsx", "xls"],
      toolNames: ["export_spreadsheet"],
    };
  }
  if (requestsCsvOutput) {
    return {
      kind: "spreadsheet",
      label: "CSV 文件",
      extensions: ["csv"],
      toolNames: ["export_spreadsheet"],
    };
  }
  return {
    kind: "spreadsheet",
    label: "Excel/表格文件",
    extensions: ["xlsx", "xls", "csv"],
    toolNames: ["export_spreadsheet"],
  };
}

function resolveSpawnedTaskOutputContract(task: string, opts?: { record?: SpawnedTaskRecord }): OutputContract | null {
  if (opts?.record && isContentExecutorPartialContract(opts.record)) return null;
  const contract = resolveOutputContract(task);
  if (!contract) return null;

  const normalized = normalizeText(task);
  const requestsInlineTerminalResult = taskAllowsInlineTerminalResult(normalized);
  const hasExplicitSpreadsheetOutputInstruction = [
    /(?:输出到|导出到|保存到|写入到|落盘到).{0,24}(?:\/[^\s"'`]+\.(?:xlsx|xls|csv))/iu,
    /\/[^\s"'`]+\.(?:xlsx|xls|csv)\b/i,
    /(?:必须|需要|请|直接|最终|最后).{0,20}(?:导出|输出|保存|返回|交付|生成).{0,24}(?:excel|xlsx|xls|csv|表格|工作簿)/iu,
    /(?:导出|输出|保存|返回|交付|生成).{0,24}(?:excel|xlsx|xls|csv|表格|工作簿)(?:文件|表格|工作簿)?/iu,
  ].some((pattern) => pattern.test(normalized));

  if (requestsInlineTerminalResult && !/\/[^\s"'`]+\.(?:xlsx|xls|csv)\b/i.test(normalized)) {
    return null;
  }

  if (hasExplicitSpreadsheetOutputInstruction) {
    return contract;
  }

  const looksLikeInputReferenceOnly = [
    /(?:读取|分析|参考|基于|根据).{0,16}(?:excel|xlsx|xls|csv|表格|工作簿)(?:附件|文件|模板|清单)?/iu,
    /(?:excel|xlsx|xls|csv|表格|工作簿)(?:附件|文件|模板|清单).{0,16}(?:读取|分析|参考|基于|根据|围绕)/iu,
  ].some((pattern) => pattern.test(normalized));

  if (looksLikeInputReferenceOnly) {
    return null;
  }

  return null;
}

function taskAllowsInlineTerminalResult(task: string): boolean {
  const normalized = normalizeText(task);
  if (!normalized) return false;
  return [
    /terminal result.{0,24}(?:返回|给出|输出)/iu,
    /(?:直接|最终).{0,24}(?:在|用).{0,12}terminal result.{0,24}(?:返回|给出|输出)/iu,
    /(?:直接|最终).{0,24}(?:返回|给出|输出).{0,24}(?:课程名称|课程介绍|清单|列表|候选|摘要|正文|内容明细)/iu,
  ].some((pattern) => pattern.test(normalized));
}

function hasInlineTerminalResultEvidence(task: string, result: string): boolean {
  if (!taskAllowsInlineTerminalResult(task)) return false;
  const normalized = normalizeText(result);
  if (!normalized || normalized.length < 18) return false;

  const strongInlinePatterns = [
    /以下为|如下|包含|明细|列表|清单|候选|逐条|课程名称|课程介绍|摘要|正文/iu,
    /已生成\s*\d+\s*(?:门|条|项|个|份)/iu,
    /(?:^|\n)\s*(?:[-*•]|\d+[.、])/u,
  ];
  return strongInlinePatterns.some((pattern) => pattern.test(normalized));
}

function hasStructuredCoursePayloadEvidence(result: string): boolean {
  const normalized = normalizeText(result);
  if (!normalized) return false;
  if (/```(?:json)?[\s\S]*```/iu.test(result) && /课程(?:名称|介绍)|course_(?:name|intro)/iu.test(result)) {
    return true;
  }
  return /已生成\s*\d+\s*门.*课程/u.test(normalized)
    || /课程名称|课程介绍|course_name|course_intro/iu.test(normalized);
}

function countOutputContractPaths(result: string, contract: OutputContract): number {
  const extensionPattern = new RegExp("\\/[^\\s'`]+\\.(?:" + contract.extensions.join("|") + ")\\b", "ig");
  return new Set(result.match(extensionPattern) ?? []).size;
}

function hasExtension(path: string | undefined, extensions: readonly string[]): boolean {
  if (!path) return false;
  const normalized = path.trim().toLowerCase();
  return extensions.some((extension) => normalized.endsWith(`.${extension}`));
}

function resultShowsOutputContract(result: string, contract: OutputContract): boolean {
  if (contract.kind === "spreadsheet") {
    const extensionPattern = new RegExp("\\/[^\\s']+\\.(?:" + contract.extensions.join("|") + ")\\b", "i");
    return extensionPattern.test(result) && /(文件|路径|产物|附件|下载|导出|保存|输出)/iu.test(result);
  }
  return false;
}

function artifactsMatchOutputContract(
  artifacts: readonly DialogArtifactRecord[],
  contract: OutputContract,
): boolean {
  return artifacts.some((artifact) => hasExtension(artifact.path || artifact.fileName, contract.extensions));
}

function hasToolOutputEvidenceForContract(
  steps: readonly AgentStep[] | undefined,
  contract: OutputContract,
): boolean {
  if (!steps?.length) return false;
  return steps.some((step) =>
    step.type === "observation"
    && typeof step.toolName === "string"
    && contract.toolNames.includes(step.toolName)
    && resultShowsOutputContract(
      normalizeText(typeof step.toolOutput === "string" ? step.toolOutput : JSON.stringify(step.toolOutput)),
      contract,
    )
  );
}

function hasToolInvocationForContract(
  steps: readonly AgentStep[] | undefined,
  contract: OutputContract,
): boolean {
  if (!steps?.length) return false;
  return steps.some((step) =>
    typeof step.toolName === "string"
    && contract.toolNames.includes(step.toolName)
    && (step.type === "action" || step.type === "observation")
  );
}

function isExplicitlyIncompleteResult(result: string): boolean {
  return INCOMPLETE_RESULT_PATTERNS.some((pattern) => pattern.test(result));
}

function isLikelyHistoricalConfirmation(result: string): boolean {
  return HISTORICAL_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(result));
}

function isExplicitBlockerResult(result: string): boolean {
  return EXPLICIT_BLOCKER_PATTERNS.some((pattern) => pattern.test(result));
}

function isScheduleMutationTask(task: string): boolean {
  return SCHEDULE_MUTATION_TASK_PATTERNS.some((pattern) => pattern.test(task));
}

function claimsScheduleMutationSuccess(result: string): boolean {
  return SCHEDULE_MUTATION_SUCCESS_PATTERNS.some((pattern) => pattern.test(result));
}

function hasScheduleMutationToolEvidence(steps: readonly AgentStep[] | undefined): boolean {
  if (!steps?.length) return false;
  return steps.some(
    (step) => step.type === "action"
      && typeof step.toolName === "string"
      && SCHEDULE_MUTATION_TOOL_NAMES.has(step.toolName),
  );
}

function isLikelyCoordinationMetaSummary(result: string): boolean {
  if (result.length < 120) return false;

  let score = 0;
  for (const pattern of COORDINATION_META_SUMMARY_PATTERNS) {
    if (pattern.test(result)) score += 1;
  }

  const numberedSectionCount = (result.match(/(?:^|\n)\s*[一二三四五六七八九十]+、/g) ?? []).length;
  if (numberedSectionCount >= 3) score += 2;

  const checklistCount = (result.match(/(?:^|\n)\s*(?:主题|步骤|工具|依赖|输出|结论)[:：]/g) ?? []).length;
  if (checklistCount >= 3) score += 1;

  return score >= 4;
}

function collectRelatedArtifacts(
  task: SpawnedTaskRecord,
  artifacts: readonly DialogArtifactRecord[],
): DialogArtifactRecord[] {
  const taskEnd = task.completedAt ?? Number.POSITIVE_INFINITY;
  return artifacts.filter((artifact) => {
    if (artifact.relatedRunId === task.runId) return true;
    if (artifact.actorId !== task.targetActorId) return false;
    return artifact.timestamp >= task.spawnedAt - 1000 && artifact.timestamp <= taskEnd;
  });
}

function collectActorArtifactsWithinWindow(params: {
  actorId?: string;
  startedAt?: number;
  completedAt?: number;
  artifacts: readonly DialogArtifactRecord[];
}): DialogArtifactRecord[] {
  const startedAt = params.startedAt ?? Number.NEGATIVE_INFINITY;
  const completedAt = params.completedAt ?? Number.POSITIVE_INFINITY;
  return params.artifacts.filter((artifact) => {
    if (params.actorId && artifact.actorId !== params.actorId) return false;
    return artifact.timestamp >= startedAt - 1000 && artifact.timestamp <= completedAt;
  });
}

export function buildSpawnTaskExecutionHint(task: string): string | undefined {
  if (!requiresConcreteOutput(task)) return undefined;
  return [
    "额外完成约束：",
    "- 这是一个需要具体产物或可验证结果的任务，不要只给抽象一句话就结束。",
    "- 在调用 task_done 前，至少满足以下其一：给出真实修改/生成的文件路径；给出关键代码片段；说明验证步骤或执行结果。",
    "- 如果没有完成，不要假装完成；继续执行或明确说明阻塞原因。",
  ].join("\n");
}

export function validateSpawnedTaskResult(params: {
  task: SpawnedTaskRecord;
  result?: string | null;
  artifacts?: readonly DialogArtifactRecord[];
}): SpawnedTaskResultValidation {
  const taskText = normalizeText(`${params.task.label || ""}\n${params.task.task}`);
  const rawResultText = String(params.result ?? "");
  const resultText = normalizeText(params.result);
  const needsConcreteOutput = requiresConcreteOutput(taskText);

  if (!resultText) {
    return {
      accepted: false,
      requiresConcreteOutput: needsConcreteOutput,
      reason: "子任务没有返回有效结果。",
    };
  }

  if (isMathOnlyResult(taskText, resultText)) {
    return {
      accepted: false,
      requiresConcreteOutput: needsConcreteOutput,
      reason: "子任务返回内容像无关的算术结果，疑似没有真正完成原任务。",
    };
  }

  if (!needsConcreteOutput) {
    return {
      accepted: true,
      requiresConcreteOutput: false,
    };
  }

  const relatedArtifacts = collectRelatedArtifacts(params.task, params.artifacts ?? []);
  const hasArtifactEvidence = relatedArtifacts.length > 0;
  const hasResultEvidence = RESULT_EVIDENCE_PATTERNS.some((pattern) => pattern.test(resultText));
  const outputContract = resolveSpawnedTaskOutputContract(taskText, { record: params.task });
  const matchesOutputContract = outputContract
    ? artifactsMatchOutputContract(relatedArtifacts, outputContract) || resultShowsOutputContract(resultText, outputContract)
    : true;
  const veryShort = resultText.length < 40;

  if (!taskExplicitlyRequestsPlan(taskText) && isLikelyExecutionPlanReply(rawResultText)) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "子任务返回内容更像执行计划/任务拆解，而不是实际完成后的可交付结果。",
    };
  }

  if (isExplicitlyIncompleteResult(resultText)) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "子任务明确表示尚未完整完成，不能作为最终交付结果。",
    };
  }

  if (outputContract && countOutputContractPaths(resultText, outputContract) > 1) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: `最终答复包含多个${outputContract.label}路径；本轮必须只交付一个最终工作簿。`,
    };
  }

  if (outputContract && !matchesOutputContract) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: `子任务没有交付符合要求的${outputContract.label}，当前结果缺少对应格式的文件或导出证据。`,
    };
  }

  if (!hasArtifactEvidence && isLikelyCoordinationMetaSummary(resultText)) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "最终答复更像协作过程总结/状态盘点，而不是实际可交付结果。",
    };
  }

  if (!hasArtifactEvidence && !outputContract && (hasInlineTerminalResultEvidence(taskText, resultText) || hasStructuredCoursePayloadEvidence(resultText))) {
    return {
      accepted: true,
      requiresConcreteOutput: true,
    };
  }

  if (!hasArtifactEvidence && !hasResultEvidence && veryShort) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "子任务声称已完成，但没有提供文件、代码片段或验证证据，结果过短且不可信。",
    };
  }

  return {
    accepted: true,
    requiresConcreteOutput: true,
  };
}

export function validateActorTaskResult(params: {
  taskText: string;
  result?: string | null;
  actorId?: string;
  startedAt?: number;
  completedAt?: number;
  artifacts?: readonly DialogArtifactRecord[];
  steps?: readonly AgentStep[];
}): SpawnedTaskResultValidation {
  const taskText = normalizeText(params.taskText);
  const rawResultText = String(params.result ?? "");
  const resultText = normalizeText(params.result);
  const needsConcreteOutput = requiresConcreteOutput(taskText);
  const scheduleMutationTask = isScheduleMutationTask(taskText);

  if (!needsConcreteOutput) {
    if (
      scheduleMutationTask
      && resultText
      && claimsScheduleMutationSuccess(resultText)
      && !hasScheduleMutationToolEvidence(params.steps)
    ) {
      return {
        accepted: false,
        requiresConcreteOutput: false,
        reason: "最终答复声称已经创建或更新了提醒/定时任务，但本轮没有对应的真实工具调用证据。",
      };
    }
    return {
      accepted: true,
      requiresConcreteOutput: false,
    };
  }

  if (!resultText) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "任务没有返回有效结果。",
    };
  }

  if (isMathOnlyResult(taskText, resultText)) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "最终答复看起来像无关的算术结果，疑似没有真正完成需要产物的任务。",
    };
  }

  const relatedArtifacts = collectActorArtifactsWithinWindow({
    actorId: params.actorId,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    artifacts: params.artifacts ?? [],
  });
  const hasArtifactEvidence = relatedArtifacts.length > 0;
  const hasResultEvidence = RESULT_EVIDENCE_PATTERNS.some((pattern) => pattern.test(resultText));
  const outputContract = resolveOutputContract(taskText);
  const hasArtifactContractEvidence = outputContract
    ? artifactsMatchOutputContract(relatedArtifacts, outputContract)
    : false;
  const hasResultContractEvidence = outputContract
    ? resultShowsOutputContract(resultText, outputContract)
    : false;
  const hasToolContractEvidence = outputContract
    ? hasToolOutputEvidenceForContract(params.steps, outputContract)
    : false;
  const hasToolInvocationEvidence = outputContract
    ? hasToolInvocationForContract(params.steps, outputContract)
    : false;
  const matchesOutputContract = outputContract
    ? hasArtifactContractEvidence
      || hasResultContractEvidence
      || (outputContract.kind !== "spreadsheet" && hasToolContractEvidence)
    : true;
  const veryShort = resultText.length < 40;

  if (!taskExplicitlyRequestsPlan(taskText) && isLikelyExecutionPlanReply(rawResultText)) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "最终答复更像执行计划/任务拆解，而不是实际完成后的可交付结果。",
    };
  }

  if (isExplicitlyIncompleteResult(resultText)) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "最终答复明确表示任务尚未完整完成，不能作为最终交付。",
    };
  }

  if (outputContract && countOutputContractPaths(resultText, outputContract) > 1) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: `最终答复包含多个${outputContract.label}路径；本轮必须只交付一个最终工作簿。`,
    };
  }

  if (outputContract && !matchesOutputContract) {
    if (isExplicitBlockerResult(resultText)) {
      return {
        accepted: true,
        requiresConcreteOutput: true,
      };
    }
    if (outputContract.kind === "spreadsheet" && (hasToolContractEvidence || hasToolInvocationEvidence)) {
      return {
        accepted: false,
        requiresConcreteOutput: true,
        reason: `最终答复提到已执行${outputContract.label}导出，但没有给出当前 run 的真实文件路径；请直接返回绝对路径或真实 blocker。`,
      };
    }
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: `最终答复没有交付符合要求的${outputContract.label}，当前结果缺少对应格式的文件或导出证据。`,
    };
  }

  if (
    outputContract
    && isLikelyHistoricalConfirmation(resultText)
    && !/(已导出|导出为|保存到|输出到|生成并保存|附件|下载)/iu.test(resultText)
  ) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: `最终答复更像对历史产物的确认，而不是直接交付${outputContract.label}。请直接给出导出结果、绝对路径或真实 blocker。`,
    };
  }

  if (!hasArtifactEvidence && isLikelyCoordinationMetaSummary(resultText)) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "最终答复更像协作过程总结/状态盘点，而不是实际可交付结果。",
    };
  }

  if (!hasArtifactEvidence && !hasResultEvidence && veryShort) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "最终答复缺少文件、代码片段或验证证据，且内容过短，不像真正完成了产物型任务。",
    };
  }

  if (
    scheduleMutationTask
    && claimsScheduleMutationSuccess(resultText)
    && !hasScheduleMutationToolEvidence(params.steps)
  ) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "最终答复声称已经创建或更新了提醒/定时任务，但本轮没有对应的真实工具调用证据。",
    };
  }

  return {
    accepted: true,
    requiresConcreteOutput: true,
  };
}
