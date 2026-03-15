import { inferCodingExecutionProfile } from "@/core/agent/coding-profile";
import type { DialogArtifactRecord, SpawnedTaskRecord } from "./types";

export interface SpawnedTaskResultValidation {
  accepted: boolean;
  reason?: string;
  requiresConcreteOutput: boolean;
}

const CONCRETE_OUTPUT_PATTERNS = [
  /网页|页面|html|react|vue|组件|前端|ui|css|样式/i,
  /代码|文件|脚本|函数|模块|接口|实现|修复|重构|build|create|implement|write|fix/i,
];

const RESULT_EVIDENCE_PATTERNS = [
  /```/,
  /<!doctype html>|<html|<div|<section|<main|<template|<script|<style/i,
  /\bimport\s+|\bexport\s+|\bfunction\s+\w+|\bclass\s+\w+|\bconst\s+\w+\s*=|\blet\s+\w+\s*=/i,
  /\/[\w./-]+\.(?:tsx?|jsx?|vue|html|css|scss|less|json|rs|py|go|java|kt|swift)/i,
  /\b(?:tsx?|jsx?|vue|html|css|scss|less|json|rs|py|go|java)\b/i,
  /已创建|已生成|已修改|已修复|文件|路径|产物|artifact|patch|diff|lint|test|验证/i,
];

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
  const veryShort = resultText.length < 40;

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
}): SpawnedTaskResultValidation {
  const taskText = normalizeText(params.taskText);
  const resultText = normalizeText(params.result);
  const needsConcreteOutput = requiresConcreteOutput(taskText);

  if (!needsConcreteOutput) {
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
  const veryShort = resultText.length < 40;

  if (!hasArtifactEvidence && !hasResultEvidence && veryShort) {
    return {
      accepted: false,
      requiresConcreteOutput: true,
      reason: "最终答复缺少文件、代码片段或验证证据，且内容过短，不像真正完成了产物型任务。",
    };
  }

  return {
    accepted: true,
    requiresConcreteOutput: true,
  };
}
