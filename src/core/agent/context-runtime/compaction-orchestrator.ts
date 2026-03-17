import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import {
  ingestAutomaticMemorySignals,
  saveSessionMemoryNote,
  type MemoryCandidateIngestResult,
} from "@/core/ai/memory-store";
import { buildAgentSessionMemoryFlushText } from "@/plugins/builtin/SmartAgent/core/session-compaction";
import type { AgentTask, AgentSession, AgentSessionCompaction } from "@/store/agent-store";
import {
  collectContextPathHints,
  normalizeContextPath,
  uniqueContextPaths,
} from "./scope-resolver";

const MAX_TRANSCRIPT_CHARS = 5_000;
const MAX_STEP_LINES_PER_TASK = 6;
const MAX_STEP_PREVIEW_CHARS = 180;
const MAX_RESULT_PREVIEW_CHARS = 260;

function basename(path: string): string {
  const normalized = normalizeContextPath(path);
  return normalized.split("/").pop() || normalized;
}

function getVisibleTaskCount(session: AgentSession): number {
  if (typeof session.visibleTaskCount !== "number" || Number.isNaN(session.visibleTaskCount)) {
    return session.tasks.length;
  }
  return Math.max(0, Math.min(session.tasks.length, Math.floor(session.visibleTaskCount)));
}

function getCompactionSourceTasks(
  session: AgentSession,
  compactedTaskCount?: number,
): AgentTask[] {
  const visibleCount = getVisibleTaskCount(session);
  const targetCount = Math.max(
    0,
    Math.min(
      visibleCount,
      compactedTaskCount ?? session.compaction?.compactedTaskCount ?? 0,
    ),
  );
  if (targetCount <= 0) return [];
  return session.tasks.slice(0, targetCount);
}

function buildTaskWorkingSet(task: AgentTask): string | null {
  const paths = uniqueContextPaths([
    ...(task.attachmentPaths ?? []),
    ...(task.images ?? []),
  ]);
  if (paths.length === 0) return null;
  return paths.slice(0, 4).map(basename).join("、");
}

function buildToolPathPreview(task: AgentTask): string | null {
  const paths = uniqueContextPaths(
    task.steps.flatMap((step) => [
      ...collectContextPathHints(step.toolInput),
      ...collectContextPathHints(step.toolOutput),
    ]),
  );
  if (paths.length === 0) return null;
  return paths.slice(0, 4).map(basename).join("、");
}

function summarizeCompactionStep(task: AgentTask, stepIndex: number): string | null {
  const step = task.steps[stepIndex];
  if (!step || step.streaming) return null;

  const preview = summarizeAISessionRuntimeText(
    step.content,
    MAX_STEP_PREVIEW_CHARS,
  );

  switch (step.type) {
    case "action": {
      const stepPaths = uniqueContextPaths([
        ...collectContextPathHints(step.toolInput),
        ...collectContextPathHints(step.toolOutput),
      ]);
      const pathSuffix = stepPaths.length > 0
        ? `（${stepPaths.slice(0, 3).map(basename).join("、")}）`
        : "";
      return `工具：${step.toolName || "unknown"}${pathSuffix}${preview ? ` - ${preview}` : ""}`;
    }
    case "observation":
      return preview ? `观察：${preview}` : null;
    case "error":
      return preview ? `错误：${preview}` : null;
    default:
      return null;
  }
}

function trimTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_TRANSCRIPT_CHARS - 10).trimEnd()}\n...（已截断）`;
}

export function buildAgentSessionCompactionMemoryTranscript(
  session: AgentSession,
  compactedTaskCount?: number,
): string | null {
  const tasks = getCompactionSourceTasks(session, compactedTaskCount);
  if (tasks.length === 0) return null;

  const lines: string[] = [
    "以下是会话压缩前的历史转存，用于提取稳定的长期记忆、用户偏好和项目上下文。",
  ];
  if (session.workspaceRoot) {
    lines.push(`工作区：${session.workspaceRoot}`);
  }
  lines.push("");

  tasks.forEach((task, index) => {
    lines.push(`## 历史任务 ${index + 1}`);
    lines.push(
      `用户请求：${summarizeAISessionRuntimeText(task.query, 220) || "未记录"}`,
    );

    const workingSet = buildTaskWorkingSet(task);
    if (workingSet) {
      lines.push(`当前工作集：${workingSet}`);
    }

    const toolPaths = buildToolPathPreview(task);
    if (toolPaths) {
      lines.push(`关键文件：${toolPaths}`);
    }

    const stepLines = task.steps
      .slice(0, MAX_STEP_LINES_PER_TASK)
      .map((_, stepIndex) => summarizeCompactionStep(task, stepIndex))
      .filter((item): item is string => !!item);
    lines.push(...stepLines);

    const result = summarizeAISessionRuntimeText(
      task.answer || "",
      MAX_RESULT_PREVIEW_CHARS,
    );
    if (result) {
      lines.push(`结果：${result}`);
    }
    lines.push("");
  });

  const transcript = lines.join("\n").trim();
  return transcript ? trimTranscript(transcript) : null;
}

export interface AgentSessionCompactionPersistResult {
  flushText: string | null;
  transcript: string | null;
  noteSaved: boolean;
  memoryIngest: MemoryCandidateIngestResult;
}

export async function persistAgentSessionCompactionArtifacts(params: {
  session: AgentSession;
  compaction: Pick<AgentSessionCompaction, "compactedTaskCount">;
}): Promise<AgentSessionCompactionPersistResult> {
  const targetCount = params.compaction.compactedTaskCount;
  const flushText = buildAgentSessionMemoryFlushText(params.session, targetCount);
  const transcript = buildAgentSessionCompactionMemoryTranscript(
    params.session,
    targetCount,
  );

  let noteSaved = false;
  if (flushText) {
    const saved = await saveSessionMemoryNote(flushText, {
      conversationId: params.session.id,
      workspaceId: params.session.workspaceRoot,
      source: "system",
    }).catch(() => null);
    noteSaved = !!saved;
  }

  const memorySource = [flushText, transcript].filter(Boolean).join("\n\n");
  const memoryIngest = memorySource
    ? await ingestAutomaticMemorySignals(memorySource, {
        conversationId: params.session.id,
        workspaceId: params.session.workspaceRoot,
        source: "assistant",
        sourceMode: "system",
        evidence: transcript ?? flushText ?? memorySource,
        autoConfirm: true,
        allowNonUserSourceAutoConfirm: true,
      }).catch(() => ({ confirmed: 0, queued: 0 }))
    : { confirmed: 0, queued: 0 };

  return {
    flushText,
    transcript,
    noteSaved,
    memoryIngest,
  };
}
