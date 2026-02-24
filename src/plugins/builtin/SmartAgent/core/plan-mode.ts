import type { AIRequestPolicy } from "@/core/plugin-system/plugin-interface";

export type PlanThreadPhase =
  | "clarifying"
  | "drafting"
  | "awaiting_confirm"
  | "executing"
  | "archived";

export type PlanFollowupRelation = "related" | "unrelated" | "uncertain";

export interface PlanThreadState {
  sessionId: string;
  taskId: string;
  baseQuery: string;
  latestPlan: string;
  planVersion: number;
  phase: PlanThreadPhase;
  lastUpdatedAt: number;
  relationSourceTaskId?: string;
  latestFollowup?: string;
}

export interface PlanFollowupDecision {
  relation: PlanFollowupRelation;
  reason?: string;
}

export const PLAN_KB_KEYWORD_PATTERN =
  /基于知识库|根据文档|参考知识库|\bfrom\s+kb\b|\bfrom\s+docs\b/i;

function pickJsonPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function parseRelation(raw: unknown): PlanFollowupRelation | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "related") return "related";
  if (normalized === "unrelated") return "unrelated";
  if (normalized === "uncertain") return "uncertain";
  return null;
}

export function parsePlanFollowupDecision(content: string): PlanFollowupDecision {
  const payload = pickJsonPayload(content);
  if (!payload) return { relation: "uncertain" };

  try {
    const parsed = JSON.parse(payload) as {
      relation?: unknown;
      decision?: unknown;
      reason?: unknown;
    };
    const relation =
      parseRelation(parsed.relation) || parseRelation(parsed.decision) || "uncertain";
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : undefined;
    return { relation, reason };
  } catch {
    return { relation: "uncertain" };
  }
}

export function shouldEnablePlanKBByKeyword(query: string): boolean {
  return PLAN_KB_KEYWORD_PATTERN.test(query);
}

export function buildPlanRequestPolicy(enablePlanKB: boolean): AIRequestPolicy {
  if (enablePlanKB) {
    return {
      ragMode: "on",
      forceProductRag: "inherit",
    };
  }
  return {
    ragMode: "off",
    forceProductRag: "off",
  };
}

export function createPlanThread(params: {
  sessionId: string;
  taskId: string;
  baseQuery: string;
  now?: number;
}): PlanThreadState {
  const now = params.now ?? Date.now();
  return {
    sessionId: params.sessionId,
    taskId: params.taskId,
    baseQuery: params.baseQuery,
    latestPlan: "",
    planVersion: 1,
    phase: "drafting",
    lastUpdatedAt: now,
  };
}

export function archivePlanThread(
  thread: PlanThreadState,
  now = Date.now(),
): PlanThreadState {
  return {
    ...thread,
    phase: "archived",
    lastUpdatedAt: now,
  };
}

export function markPlanThreadPhase(
  thread: PlanThreadState,
  phase: PlanThreadPhase,
  now = Date.now(),
): PlanThreadState {
  return {
    ...thread,
    phase,
    lastUpdatedAt: now,
  };
}

export function revisePlanThreadWithRelatedFollowup(
  thread: PlanThreadState,
  followupQuery: string,
  now = Date.now(),
): PlanThreadState {
  return {
    ...thread,
    planVersion: Math.max(1, thread.planVersion) + 1,
    phase: "drafting",
    latestFollowup: followupQuery,
    relationSourceTaskId: thread.taskId,
    lastUpdatedAt: now,
  };
}

export function finalizePlanThreadDraft(
  thread: PlanThreadState,
  nextPlan: string,
  now = Date.now(),
): PlanThreadState {
  return {
    ...thread,
    latestPlan: nextPlan,
    phase: "awaiting_confirm",
    lastUpdatedAt: now,
  };
}
