import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { AgentSession } from "@/store/agent-store";
import {
  getAgentSessionCompactedTaskCount,
  getHiddenAgentTasks,
  getVisibleAgentTasks,
} from "@/store/agent-store";

export interface AgentSessionFileInsight {
  path: string;
  source: "attachment" | "image" | "tool" | "handoff";
  mentions: number;
  latestAt?: number;
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

function collectPath(map: Map<string, AgentSessionFileInsight>, insight: AgentSessionFileInsight) {
  const path = normalizePath(insight.path);
  if (!path) return;
  const current = map.get(path);
  if (!current) {
    map.set(path, { ...insight, path });
    return;
  }
  current.mentions += insight.mentions;
  current.latestAt = Math.max(current.latestAt ?? 0, insight.latestAt ?? 0) || undefined;
  if (current.source !== insight.source) {
    current.source = "tool";
  }
}

function extractPathsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith("/") || text.startsWith("~/")) {
      return [text];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractPathsFromUnknown(item));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => {
      if (!/(path|file|directory|cwd|workspace|root|target)/i.test(key)) {
        return [];
      }
      return extractPathsFromUnknown(item);
    });
  }
  return [];
}

export function deriveAgentSessionFiles(
  session: AgentSession | null | undefined,
): AgentSessionFileInsight[] {
  if (!session) return [];

  const map = new Map<string, AgentSessionFileInsight>();
  for (const task of getVisibleAgentTasks(session)) {
    const timestamp = task.createdAt ?? task.last_started_at ?? task.last_finished_at;
    for (const path of task.attachmentPaths ?? []) {
      collectPath(map, {
        path,
        source: "attachment",
        mentions: 1,
        latestAt: timestamp,
      });
    }
    for (const path of task.images ?? []) {
      collectPath(map, {
        path,
        source: "image",
        mentions: 1,
        latestAt: timestamp,
      });
    }
    for (const step of task.steps) {
      const paths = [
        ...extractPathsFromUnknown(step.toolInput),
        ...extractPathsFromUnknown(step.toolOutput),
      ];
      for (const path of paths) {
        collectPath(map, {
          path,
          source: "tool",
          mentions: 1,
          latestAt: step.timestamp,
        });
      }
    }
  }

  for (const path of session.sourceHandoff?.attachmentPaths ?? []) {
    collectPath(map, {
      path,
      source: "handoff",
      mentions: 1,
      latestAt: session.createdAt,
    });
  }
  for (const file of session.sourceHandoff?.files ?? []) {
    collectPath(map, {
      path: file.path,
      source: "handoff",
      mentions: 1,
      latestAt: session.createdAt,
    });
  }

  return [...map.values()].sort((a, b) => {
    if ((b.latestAt ?? 0) !== (a.latestAt ?? 0)) {
      return (b.latestAt ?? 0) - (a.latestAt ?? 0);
    }
    return b.mentions - a.mentions;
  });
}

export function buildAgentSessionReview(session: AgentSession | null | undefined): {
  visibleTaskCount: number;
  hiddenTaskCount: number;
  compactedTaskCount: number;
  totalStepCount: number;
  uniqueToolCount: number;
  latestAnswerPreview?: string;
  latestQueryPreview?: string;
} {
  if (!session) {
    return {
      visibleTaskCount: 0,
      hiddenTaskCount: 0,
      compactedTaskCount: 0,
      totalStepCount: 0,
      uniqueToolCount: 0,
    };
  }

  const visibleTasks = getVisibleAgentTasks(session);
  const hiddenTasks = getHiddenAgentTasks(session);
  const toolNames = new Set<string>();
  for (const task of visibleTasks) {
    for (const step of task.steps) {
      if (step.type === "action" && step.toolName) {
        toolNames.add(step.toolName);
      }
    }
  }

  const latestTask = visibleTasks[visibleTasks.length - 1];
  return {
    visibleTaskCount: visibleTasks.length,
    hiddenTaskCount: hiddenTasks.length,
    compactedTaskCount: getAgentSessionCompactedTaskCount(session),
    totalStepCount: visibleTasks.reduce((sum, task) => sum + task.steps.length, 0),
    uniqueToolCount: toolNames.size,
    latestAnswerPreview: summarizeAISessionRuntimeText(latestTask?.answer ?? "", 180) || undefined,
    latestQueryPreview: summarizeAISessionRuntimeText(latestTask?.query ?? "", 120) || undefined,
  };
}

export function buildAgentSessionContextOutline(
  session: AgentSession | null | undefined,
): string[] {
  if (!session) return [];
  const lines: string[] = [];
  const visibleTasks = getVisibleAgentTasks(session);
  const latestTask = visibleTasks[visibleTasks.length - 1];

  if (session.forkMeta) {
    lines.push(
      `当前会话来自分支：基于上一个会话的前 ${session.forkMeta.parentVisibleTaskCount} 个任务创建新线索。`,
    );
  }
  if (session.compaction?.summary) {
    lines.push(
      `早期上下文已整理：前 ${session.compaction.compactedTaskCount} 个任务被压缩为摘要，以减小模型上下文压力。`,
    );
    if (session.compaction.preservedIdentifiers?.length) {
      lines.push(
        `压缩后仍保留的关键标识：${session.compaction.preservedIdentifiers.slice(0, 6).join("、")}`,
      );
    }
    if (session.compaction.preservedToolNames?.length) {
      lines.push(
        `压缩后仍延续的关键工具：${session.compaction.preservedToolNames.join("、")}`,
      );
    }
    if (session.compaction.bootstrapReinjectionPreview?.length) {
      lines.push(
        `已重新注入 AGENTS 规则：${session.compaction.bootstrapReinjectionPreview.slice(0, 2).join("；")}`,
      );
    }
  }
  if (session.sourceHandoff?.sourceMode) {
    lines.push(
      `存在跨模式来源：由 ${session.sourceHandoff.sourceMode} 模式切入，并保留了原始 handoff 信息。`,
    );
  }
  if (session.followUpQueue?.length) {
    lines.push(`有 ${session.followUpQueue.length} 条后续追问已排队等待执行。`);
  }
  if (latestTask?.attachmentPaths?.length || latestTask?.images?.length) {
    lines.push(
      `最近任务工作集：${[
        ...(latestTask.attachmentPaths ?? []),
        ...(latestTask.images ?? []),
      ]
        .slice(0, 6)
        .map((path) => path.split("/").pop() || path)
        .join("、")}`,
    );
  }
  return lines;
}
