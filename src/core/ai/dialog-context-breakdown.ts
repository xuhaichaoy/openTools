import type { ClusterPlan } from "@/core/agent/cluster/types";
import type {
  DialogArtifactRecord,
  DialogMessage,
  SessionUploadRecord,
  SpawnedTaskRecord,
  ThinkingLevel,
} from "@/core/agent/actor/types";
import { buildDialogWorkingSetSnapshot } from "@/core/ai/ai-working-set";
import { estimateTokens } from "@/core/ai/token-utils";

const DEFAULT_ACTOR_CONTEXT_BUDGET = 8000;
const MAX_STEP_PREVIEW_CHARS = 320;
const MAX_RESULT_PREVIEW_CHARS = 220;

export interface DialogContextActorState {
  id?: string;
  roleName: string;
  modelOverride?: string;
  systemPromptOverride?: string;
  workspace?: string;
  contextTokens?: number;
  thinkingLevel?: ThinkingLevel;
  sessionHistory: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
  currentTask?: {
    query: string;
    status: string;
    steps: Array<{ type: string; content: string }>;
  };
}

export interface DialogContextSectionMetric {
  id: "messages" | "uploads" | "artifacts" | "subtasks" | "plan";
  label: string;
  tokens: number;
  itemCount: number;
  description: string;
}

export interface DialogActorContextMetric {
  actorId?: string;
  roleName: string;
  modelLabel: string;
  budgetTokens: number;
  budgetUsageTokens: number;
  budgetUsageRatio: number;
  sharedTokens: number;
  estimatedTotalTokens: number;
  estimatedTotalRatio: number;
  memoryTokens: number;
  promptTokens: number;
  runtimeTokens: number;
  workspaceLabel?: string;
  thinkingLevel?: ThinkingLevel;
  status: "comfortable" | "busy" | "tight";
}

export interface DialogContextBreakdown {
  totalSharedTokens: number;
  totalRuntimeTokens: number;
  attachmentCount: number;
  imageCount: number;
  openSessionCount: number;
  sharedSections: DialogContextSectionMetric[];
  actors: DialogActorContextMetric[];
  warnings: string[];
}

function summarizeDialogHistory(dialogHistory: readonly DialogMessage[]): string {
  return dialogHistory
    .map((message) => {
      const header = message.to
        ? `[${message.from} -> ${message.to}]`
        : `[${message.from}]`;
      const body = String(message._briefContent || message.content || "")
        .replace(/\s+/g, " ")
        .trim();
      return `${header} ${body}`;
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeUploads(sessionUploads: readonly SessionUploadRecord[]): string {
  return sessionUploads
    .map((upload) => {
      const parts = [
        `${upload.name} (${upload.type})`,
        upload.path ? `path=${upload.path}` : "",
        upload.excerpt ? upload.excerpt.slice(0, MAX_RESULT_PREVIEW_CHARS) : "",
      ].filter(Boolean);
      return parts.join(" · ");
    })
    .join("\n");
}

function summarizePlan(
  draftPlan: ClusterPlan | null | undefined,
  draftInsight?: {
    taskSummary?: string;
    autoModeLabel?: string | null;
    focusLabel?: string | null;
    reasons?: string[];
  } | null,
): string {
  if (!draftPlan && !draftInsight) return "";
  const parts: string[] = [];
  if (draftInsight?.taskSummary) parts.push(`任务摘要: ${draftInsight.taskSummary}`);
  if (draftInsight?.autoModeLabel) parts.push(`自动模式: ${draftInsight.autoModeLabel}`);
  if (draftInsight?.focusLabel) parts.push(`焦点: ${draftInsight.focusLabel}`);
  if (draftInsight?.reasons?.length) parts.push(`原因: ${draftInsight.reasons.slice(0, 2).join("；")}`);
  if (draftPlan?.steps?.length) {
    parts.push(
      ...draftPlan.steps.map((step) => {
        const deps = step.dependencies.length > 0 ? ` <- ${step.dependencies.join(", ")}` : "";
        return `${step.role}: ${step.task}${deps}`;
      }),
    );
  }
  return parts.join("\n");
}

function estimateMemoryTokens(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  budgetTokens: number,
): number {
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(history[i].content);
    if (used + tokens > budgetTokens) break;
    used += tokens;
  }
  return used;
}

function estimateRuntimeTokens(
  currentTask: DialogContextActorState["currentTask"],
): number {
  if (!currentTask) return 0;
  const queryText = currentTask.query || "";
  const stepsText = currentTask.steps
    .slice(-10)
    .map((step) => {
      const preview = String(step.content || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_STEP_PREVIEW_CHARS);
      return `${step.type}: ${preview}`;
    })
    .join("\n");
  return estimateTokens([queryText, stepsText].filter(Boolean).join("\n"));
}

function getActorStatus(ratio: number): DialogActorContextMetric["status"] {
  if (ratio >= 0.8) return "tight";
  if (ratio >= 0.5) return "busy";
  return "comfortable";
}

function normalizeImageKey(input: string): string {
  return String(input ?? "").trim().replace(/\\/g, "/").toLowerCase();
}

export function buildDialogContextBreakdown(params: {
  actors: readonly DialogContextActorState[];
  dialogHistory: readonly DialogMessage[];
  artifacts: readonly DialogArtifactRecord[];
  sessionUploads: readonly SessionUploadRecord[];
  spawnedTasks: readonly SpawnedTaskRecord[];
  draftPlan?: ClusterPlan | null;
  draftInsight?: {
    taskSummary?: string;
    autoModeLabel?: string | null;
    focusLabel?: string | null;
    reasons?: string[];
  } | null;
}): DialogContextBreakdown {
  const {
    actors,
    dialogHistory,
    artifacts,
    sessionUploads,
    spawnedTasks,
    draftPlan,
    draftInsight,
  } = params;

  const actorNameById = new Map(
    actors
      .filter((actor) => actor.id)
      .map((actor) => [actor.id!, actor.roleName] as const),
  );

  const workingSet = buildDialogWorkingSetSnapshot({
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      fileName: artifact.fileName,
      actorName: actorNameById.get(artifact.actorId) ?? artifact.actorId,
    })),
    sessionUploads,
    spawnedTasks,
    actorNameById,
  });

  const sectionSources = [
    {
      id: "messages" as const,
      label: "房间消息",
      itemCount: dialogHistory.length,
      text: summarizeDialogHistory(dialogHistory),
      description: dialogHistory.length > 0 ? `共 ${dialogHistory.length} 条房间消息摘要` : "当前没有房间消息",
    },
    {
      id: "uploads" as const,
      label: "上传附件",
      itemCount: sessionUploads.length,
      text: summarizeUploads(sessionUploads),
      description: sessionUploads.length > 0 ? `登记了 ${sessionUploads.length} 个上传/附件摘要` : "当前没有上传附件",
    },
    {
      id: "artifacts" as const,
      label: "产物线索",
      itemCount: workingSet.artifactSummaryLines.length,
      text: workingSet.artifactSummaryLines.join("\n"),
      description: workingSet.artifactSummaryLines.length > 0 ? `引用 ${workingSet.artifactSummaryLines.length} 条最近产物线索` : "当前没有产物线索",
    },
    {
      id: "subtasks" as const,
      label: "子任务/子会话",
      itemCount: workingSet.spawnedTaskSummaryLines.length,
      text: workingSet.spawnedTaskSummaryLines.join("\n"),
      description: workingSet.spawnedTaskSummaryLines.length > 0 ? `引用 ${workingSet.spawnedTaskSummaryLines.length} 条子任务线索` : "当前没有子任务线索",
    },
    {
      id: "plan" as const,
      label: "派发计划",
      itemCount: draftPlan?.steps.length ?? 0,
      text: summarizePlan(draftPlan, draftInsight),
      description: draftPlan?.steps.length ? `当前 dispatch plan 含 ${draftPlan.steps.length} 个步骤` : "当前没有计划草案",
    },
  ];

  const sharedSections: DialogContextSectionMetric[] = sectionSources
    .map((section) => ({
      id: section.id,
      label: section.label,
      tokens: estimateTokens(section.text),
      itemCount: section.itemCount,
      description: section.description,
    }))
    .filter((section) => section.tokens > 0 || section.itemCount > 0);

  const totalSharedTokens = sharedSections.reduce((sum, section) => sum + section.tokens, 0);
  const uniqueImageRefs = new Set<string>();
  sessionUploads
    .filter((upload) => upload.type === "image")
    .forEach((upload) => {
      if (upload.path) {
        uniqueImageRefs.add(normalizeImageKey(upload.path));
      } else {
        uniqueImageRefs.add(`upload:${normalizeImageKey(upload.name)}:${upload.addedAt}`);
      }
    });
  dialogHistory.forEach((message) => {
    for (const image of message.images ?? []) {
      const normalized = normalizeImageKey(image);
      if (normalized) uniqueImageRefs.add(normalized);
    }
  });
  const imageCount = uniqueImageRefs.size;

  const actorMetrics: DialogActorContextMetric[] = actors
    .map((actor) => {
      const budgetTokens = actor.contextTokens ?? DEFAULT_ACTOR_CONTEXT_BUDGET;
      const promptTokens = estimateTokens(actor.systemPromptOverride ?? "");
      const memoryTokens = estimateMemoryTokens(actor.sessionHistory, budgetTokens);
      const budgetUsageTokens = promptTokens + memoryTokens;
      const budgetUsageRatio = budgetTokens > 0 ? budgetUsageTokens / budgetTokens : 0;
      const runtimeTokens = estimateRuntimeTokens(actor.currentTask);
      const sharedTokens = totalSharedTokens;
      const estimatedTotalTokens = sharedTokens + budgetUsageTokens + runtimeTokens;
      const estimatedTotalRatio = budgetTokens > 0 ? estimatedTotalTokens / budgetTokens : 0;
      return {
        actorId: actor.id,
        roleName: actor.roleName,
        modelLabel: actor.modelOverride || "默认模型",
        budgetTokens,
        budgetUsageTokens,
        budgetUsageRatio,
        sharedTokens,
        estimatedTotalTokens,
        estimatedTotalRatio,
        memoryTokens,
        promptTokens,
        runtimeTokens,
        workspaceLabel: actor.workspace,
        thinkingLevel: actor.thinkingLevel,
        status: getActorStatus(estimatedTotalRatio),
      };
    })
    .sort((a, b) => {
      if (b.estimatedTotalRatio !== a.estimatedTotalRatio) return b.estimatedTotalRatio - a.estimatedTotalRatio;
      return b.estimatedTotalTokens - a.estimatedTotalTokens;
    });

  const warnings: string[] = [];
  if (totalSharedTokens >= 4000) {
    warnings.push("房间共享工作集已经偏大，建议开启新话题、关闭无关子会话，或把落地执行切到 Agent。");
  }
  const tightActors = actorMetrics.filter((actor) => actor.status === "tight");
  if (tightActors.length > 0) {
    warnings.push(`以下 Agent 的专属预算较紧：${tightActors.map((actor) => actor.roleName).join("、")}。`);
  }
  const busyActors = actorMetrics.filter((actor) => actor.runtimeTokens >= 2500);
  if (busyActors.length > 0) {
    warnings.push(`当前运行现场较重：${busyActors.map((actor) => actor.roleName).join("、")} 有较长的执行轨迹。`);
  }
  const openSessionCount = workingSet.openSessionCount;
  if (openSessionCount >= 3) {
    warnings.push(`当前有 ${openSessionCount} 个开放子会话，继续累积会明显放大协作上下文。`);
  }
  if (imageCount >= 4) {
    warnings.push(`房间内已有 ${imageCount} 张图片/图像附件，建议只保留当前仍然相关的视觉输入。`);
  }

  return {
    totalSharedTokens,
    totalRuntimeTokens: actorMetrics.reduce((sum, actor) => sum + actor.runtimeTokens, 0),
    attachmentCount: workingSet.attachmentPaths.length,
    imageCount,
    openSessionCount,
    sharedSections,
    actors: actorMetrics,
    warnings,
  };
}
