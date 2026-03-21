import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import { loadBootstrapReinjectionPreview } from "@/core/ai/bootstrap-context";
import { isContextPressureError } from "@/core/ai/context-pressure";
import type {
  AgentSession,
  AgentSessionCompaction,
  AgentTask,
} from "@/store/agent-store";
import {
  getAgentSessionCompactedTaskCount,
  getVisibleAgentTasks,
} from "@/store/agent-store";

const DEFAULT_KEEP_RECENT_TASKS = 4;
const AGGRESSIVE_KEEP_RECENT_TASKS = 2;
const MIN_VISIBLE_TASKS_FOR_COMPACTION = 7;
const MIN_VISIBLE_STEPS_FOR_COMPACTION = 60;
const MAX_SUMMARY_CHARS = 2200;
const REQUIRED_SUMMARY_SECTIONS = [
  "## 最新用户目标",
  "## 已完成工作",
  "## 关键文件",
  "## 连续性护栏",
  "## 工具失败与风险",
  "## 当前结论",
  "## 待续事项",
] as const;

function normalizePath(path: string): string {
  return String(path || "").trim().replace(/\\/g, "/");
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.split("/").pop() || normalized;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return `/${parts.slice(0, -1).join("/")}`;
}

function tailSegments(path: string, depth = 2): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return normalized;
  return parts.slice(-depth).join("/");
}

function extractPathsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = normalizePath(value);
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      ? [normalized]
      : [];
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

function buildSection(title: string, items: string[]): string[] {
  return [
    title,
    ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["- 暂无"]),
    "",
  ];
}

function summarizeTask(task: AgentTask, index: number): string {
  const query = summarizeAISessionRuntimeText(task.query, 120) || "未命名任务";
  const answer = summarizeAISessionRuntimeText(task.answer || "", 160);
  const toolNames = Array.from(
    new Set(
      task.steps
        .filter((step) => step.type === "action" && step.toolName)
        .map((step) => String(step.toolName)),
    ),
  );
  const status = task.status || (task.answer ? "success" : "pending");
  const attachments = [
    ...(task.attachmentPaths ?? []),
    ...(task.images ?? []),
  ];
  const parts = [
    `任务 ${index + 1}`,
    `状态：${status}`,
    `需求：${query}`,
  ];

  if (toolNames.length > 0) {
    parts.push(`工具：${toolNames.slice(0, 5).join("、")}`);
  }
  if (attachments.length > 0) {
    parts.push(
      `工作集：${attachments
        .slice(0, 4)
        .map((path) => path.split("/").pop() || path)
        .join("、")}`,
    );
  }
  if (answer) {
    parts.push(`结果：${answer}`);
  }

  return parts.join("；");
}

function extractTextIdentifiers(text: string): string[] {
  const normalized = String(text || "");
  if (!normalized.trim()) return [];

  const matches = [
    ...(normalized.match(/\b[A-Z]{2,12}-\d{1,6}\b/g) ?? []),
    ...(normalized.match(/(?:^|\s)(#\d{1,6})\b/g) ?? []).map((item) => item.trim()),
    ...(normalized.match(/\b(?:localhost|127(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d{2,5})?\b/gi) ?? []),
    ...(normalized.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? []),
    ...(normalized.match(/\b(?:main|master|develop|development|staging|production|prod|dev)\b/gi) ?? []),
    ...(normalized.match(/\b(?:feature|release|hotfix|bugfix)\/[A-Za-z0-9._/-]+\b/gi) ?? []),
    ...(normalized.match(/\bport\s+\d{2,5}\b/gi) ?? []),
  ];

  return matches
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

function uniqueLimited(items: Iterable<string>, limit: number): string[] {
  const values = [...new Set(
    [...items]
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  )];
  return values.slice(0, Math.max(0, limit));
}

function collectCompactionInsights(tasks: AgentTask[]): {
  readFiles: string[];
  changedFiles: string[];
  toolFailures: string[];
} {
  const readFiles = new Set<string>();
  const changedFiles = new Set<string>();
  const toolFailures = new Set<string>();

  for (const task of tasks) {
    for (const step of task.steps) {
      const paths = [
        ...extractPathsFromUnknown(step.toolInput),
        ...extractPathsFromUnknown(step.toolOutput),
      ];
      const toolName = step.toolName || "";
      if (
        toolName === "read_file"
        || toolName === "read_file_range"
        || toolName === "search_in_files"
        || toolName === "list_directory"
      ) {
        for (const path of paths) readFiles.add(path);
      }
      if (
        toolName === "write_file"
        || toolName === "str_replace_edit"
        || toolName === "json_edit"
      ) {
        for (const path of paths) changedFiles.add(path);
      }
      if (step.type === "error") {
        const preview = summarizeAISessionRuntimeText(step.content, 140);
        if (preview) toolFailures.add(preview);
      }
    }
    if (task.status === "error" && task.last_error) {
      const preview = summarizeAISessionRuntimeText(task.last_error, 140);
      if (preview) toolFailures.add(preview);
    }
  }

  return {
    readFiles: [...readFiles],
    changedFiles: [...changedFiles],
    toolFailures: [...toolFailures],
  };
}

function collectCompactionSafeguards(tasks: AgentTask[]): {
  identifiers: string[];
  toolNames: string[];
} {
  const fileNames = new Set<string>();
  const directories = new Set<string>();
  const toolNames = new Set<string>();
  const tokens = new Set<string>();

  const rememberPath = (path: string) => {
    const normalized = normalizePath(path);
    if (!normalized) return;
    const fileName = basename(normalized);
    if (fileName && fileName.length >= 2) {
      fileNames.add(fileName);
    }
    const dir = dirname(normalized);
    if (dir) {
      const tail = tailSegments(dir, 2);
      if (tail.length >= 2) {
        directories.add(tail);
      }
    }
  };

  const rememberText = (text?: string | null) => {
    for (const identifier of extractTextIdentifiers(String(text || ""))) {
      tokens.add(identifier);
    }
  };

  for (const task of tasks) {
    for (const path of [...(task.attachmentPaths ?? []), ...(task.images ?? [])]) {
      rememberPath(path);
    }
    rememberText(task.query);
    rememberText(task.answer);

    for (const step of task.steps) {
      if (step.toolName) {
        toolNames.add(step.toolName);
      }
      for (const path of [
        ...extractPathsFromUnknown(step.toolInput),
        ...extractPathsFromUnknown(step.toolOutput),
      ]) {
        rememberPath(path);
      }
      rememberText(step.content);
      rememberText(JSON.stringify(step.toolInput ?? ""));
      rememberText(JSON.stringify(step.toolOutput ?? ""));
    }
  }

  return {
    identifiers: uniqueLimited(
      [
        ...fileNames,
        ...directories,
        ...tokens,
      ],
      14,
    ),
    toolNames: uniqueLimited(toolNames, 6),
  };
}

function buildStructuredSummary(
  session: AgentSession,
  compactedTasks: AgentTask[],
  safeguards: {
    identifiers: string[];
    toolNames: string[];
  },
): string {
  const visibleTasks = getVisibleAgentTasks(session);
  const latestVisibleTask = visibleTasks[visibleTasks.length - 1];
  const insights = collectCompactionInsights(compactedTasks);
  const completedItems = compactedTasks.map((task, index) => summarizeTask(task, index));
  const resultSummaries = compactedTasks
    .map((task) => summarizeAISessionRuntimeText(task.answer || "", 140))
    .filter((item): item is string => !!item);

  const lines = [
    ...buildSection("## 最新用户目标", [
      summarizeAISessionRuntimeText(
        latestVisibleTask?.query || compactedTasks[compactedTasks.length - 1]?.query || "",
        160,
      ) || "未记录",
    ]),
    ...buildSection("## 已完成工作", completedItems),
    ...buildSection("## 关键文件", [
      insights.readFiles.length > 0
        ? `已读取：${insights.readFiles.slice(0, 8).map(basename).join("、")}`
        : "已读取：暂无明确记录",
      insights.changedFiles.length > 0
        ? `已修改：${insights.changedFiles.slice(0, 8).map(basename).join("、")}`
        : "已修改：暂无明确记录",
    ]),
    ...buildSection("## 连续性护栏", [
      safeguards.identifiers.length > 0
        ? `关键标识：${safeguards.identifiers.slice(0, 8).join("、")}`
        : "关键标识：暂无明确记录",
      safeguards.toolNames.length > 0
        ? `关键工具：${safeguards.toolNames.join("、")}`
        : "关键工具：暂无明确记录",
      session.workspaceRoot
        ? `工作区锚点：${session.workspaceRoot}`
        : "工作区锚点：当前未记录",
    ]),
    ...buildSection("## 工具失败与风险", insights.toolFailures),
    ...buildSection("## 当前结论", resultSummaries.slice(-5)),
    ...buildSection("## 待续事项", [
      "后续优先延续最近未压缩任务、最新用户要求与当前工作集。",
    ]),
  ];

  return truncateSummary(lines);
}

function appendBootstrapReinjectionToSummary(
  summary: string,
  reinjectionPreview: readonly string[],
): string {
  if (!summary.trim() || reinjectionPreview.length === 0) {
    return summary;
  }
  if (summary.includes("## AGENTS 关键规则回注")) {
    return summary;
  }
  return truncateSummary([
    summary,
    "",
    ...buildSection(
      "## AGENTS 关键规则回注",
      reinjectionPreview.slice(0, 4),
    ),
  ]);
}

function summaryHasRequiredShape(summary: string, latestQuery: string, identifiers: string[]): boolean {
  if (!summary.trim()) return false;
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!summary.includes(section)) return false;
  }

  const normalizedLatestQuery = latestQuery.trim();
  if (normalizedLatestQuery) {
    const queryPreview = summarizeAISessionRuntimeText(normalizedLatestQuery, 60) || normalizedLatestQuery;
    if (queryPreview && !summary.includes(queryPreview)) {
      return false;
    }
  }

  const requiredIdentifiers = identifiers
    .map((item) => basename(item))
    .filter((item) => item.length >= 3)
    .slice(0, 3);
  if (requiredIdentifiers.length === 0) return true;
  return requiredIdentifiers.some((identifier) => summary.includes(identifier));
}

function truncateSummary(lines: string[]): string {
  const joined = lines.join("\n");
  if (joined.length <= MAX_SUMMARY_CHARS) {
    return joined;
  }
  return `${joined.slice(0, MAX_SUMMARY_CHARS - 24).trimEnd()}\n...（历史摘要已截断）`;
}

function getVisibleStepCount(session: AgentSession): number {
  return getVisibleAgentTasks(session).reduce(
    (sum, task) => sum + task.steps.length,
    0,
  );
}

export function shouldAutoCompactAgentSession(session: AgentSession): {
  shouldCompact: boolean;
  reason?: AgentSessionCompaction["reason"];
  targetTaskCount: number;
} {
  const visibleTasks = getVisibleAgentTasks(session);
  const currentCompactedTaskCount = getAgentSessionCompactedTaskCount(session);
  const visibleStepCount = getVisibleStepCount(session);

  if (visibleTasks.length < MIN_VISIBLE_TASKS_FOR_COMPACTION) {
    return {
      shouldCompact: false,
      targetTaskCount: currentCompactedTaskCount,
    };
  }

  const reason: AgentSessionCompaction["reason"] | undefined =
    visibleStepCount >= MIN_VISIBLE_STEPS_FOR_COMPACTION
      ? "step_count"
      : visibleTasks.length >= MIN_VISIBLE_TASKS_FOR_COMPACTION
        ? "task_count"
        : undefined;
  const targetTaskCount = Math.max(
    currentCompactedTaskCount,
    visibleTasks.length - DEFAULT_KEEP_RECENT_TASKS,
  );

  return {
    shouldCompact: Boolean(reason) && targetTaskCount > currentCompactedTaskCount,
    reason,
    targetTaskCount,
  };
}

export function buildAgentSessionCompactionState(
  session: AgentSession,
  options?: {
    reason?: AgentSessionCompaction["reason"];
    aggressive?: boolean;
  },
): AgentSessionCompaction | null {
  const visibleTasks = getVisibleAgentTasks(session);
  if (visibleTasks.length < 2) {
    return null;
  }

  const existingCompactedTaskCount = getAgentSessionCompactedTaskCount(session);
  const keepRecentTasks = options?.aggressive
    ? AGGRESSIVE_KEEP_RECENT_TASKS
    : DEFAULT_KEEP_RECENT_TASKS;
  const targetTaskCount = Math.max(
    existingCompactedTaskCount,
    visibleTasks.length - keepRecentTasks,
  );

  if (targetTaskCount <= 0 || targetTaskCount <= existingCompactedTaskCount) {
    return session.compaction ?? null;
  }

  const compactedTasks = visibleTasks.slice(0, targetTaskCount);
  const safeguards = collectCompactionSafeguards(compactedTasks);
  const summary = buildStructuredSummary(session, compactedTasks, safeguards);
  if (!summary.trim()) {
    return null;
  }

  const qualityIdentifiers = collectCompactionInsights(compactedTasks);
  const qualityOk = summaryHasRequiredShape(
    summary,
    visibleTasks[visibleTasks.length - 1]?.query || "",
    [
      ...qualityIdentifiers.readFiles,
      ...qualityIdentifiers.changedFiles,
      ...safeguards.identifiers,
    ],
  );
  if (!qualityOk) {
    return session.compaction ?? null;
  }

  return {
    summary,
    compactedTaskCount: targetTaskCount,
    lastCompactedAt: Date.now(),
    reason: options?.reason ?? session.compaction?.reason ?? "task_count",
    preservedIdentifiers: safeguards.identifiers,
    preservedToolNames: safeguards.toolNames,
    workspaceRootAtCompaction: session.workspaceRoot?.trim() || undefined,
  };
}

export async function enrichAgentSessionCompactionState(
  session: AgentSession,
  compaction: AgentSessionCompaction | null | undefined,
): Promise<AgentSessionCompaction | null> {
  if (!compaction) {
    return null;
  }

  const workspaceRoot =
    compaction.workspaceRootAtCompaction?.trim()
    || session.workspaceRoot?.trim()
    || "";
  if (!workspaceRoot) {
    return compaction;
  }

  const reinjectionPreview = await loadBootstrapReinjectionPreview({
    workspaceRoot,
  }).catch(() => []);
  if (reinjectionPreview.length === 0) {
    return {
      ...compaction,
      workspaceRootAtCompaction: workspaceRoot,
    };
  }

  return {
    ...compaction,
    summary: appendBootstrapReinjectionToSummary(compaction.summary, reinjectionPreview),
    bootstrapReinjectionPreview: reinjectionPreview,
    workspaceRootAtCompaction: workspaceRoot,
  };
}

export function buildAgentSessionContextMessages(
  session: AgentSession | null | undefined,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!session?.compaction?.summary?.trim()) {
    return [];
  }

  const safeguardParts = [
    session.compaction?.preservedIdentifiers?.length
      ? `关键标识 ${session.compaction.preservedIdentifiers.length} 项`
      : "",
    session.compaction?.bootstrapReinjectionPreview?.length
      ? `AGENTS 规则 ${session.compaction.bootstrapReinjectionPreview.length} 条`
      : "",
  ].filter(Boolean);

  return [
    {
      role: "user",
      content:
        "以下是当前 Agent 会话中已整理过的结构化历史摘要，请把它视为已完成上下文，并在后续执行中延续这些结论：\n"
        + session.compaction.summary,
    },
    {
      role: "assistant",
      content:
        `已接收历史摘要${safeguardParts.length > 0 ? `，并保留了${safeguardParts.join("、")}` : ""}。后续仅需结合最近未压缩任务、当前工作集和最新用户要求继续执行。`,
    },
  ];
}

export function buildAgentSessionMemoryFlushText(
  session: AgentSession,
  compactedTaskCount?: number,
): string | null {
  const visibleTasks = getVisibleAgentTasks(session);
  const targetCount = Math.max(
    0,
    Math.min(visibleTasks.length, compactedTaskCount ?? getAgentSessionCompactedTaskCount(session)),
  );
  if (targetCount <= 0) return null;

  const tasks = visibleTasks.slice(0, targetCount);
  const insights = collectCompactionInsights(tasks);
  const safeguards = collectCompactionSafeguards(tasks);
  const latestGoal = summarizeAISessionRuntimeText(
    visibleTasks[visibleTasks.length - 1]?.query || tasks[tasks.length - 1]?.query || "",
    120,
  );
  const latestConclusion = summarizeAISessionRuntimeText(
    tasks[tasks.length - 1]?.answer || "",
    140,
  );
  const readFiles = insights.readFiles.slice(0, 4).map(basename).join("、");
  const changedFiles = insights.changedFiles.slice(0, 4).map(basename).join("、");
  const failurePreview = insights.toolFailures.slice(0, 2).join("；");

  const parts = [
    latestGoal ? `压缩前目标：${latestGoal}` : "",
    latestConclusion ? `当前结论：${latestConclusion}` : "",
    readFiles ? `已读取文件：${readFiles}` : "",
    changedFiles ? `已修改文件：${changedFiles}` : "",
    safeguards.toolNames.length > 0
      ? `关键工具：${safeguards.toolNames.slice(0, 4).join("、")}`
      : "",
    failurePreview ? `待注意风险：${failurePreview}` : "",
  ].filter(Boolean);

  if (parts.length === 0) return null;
  return parts.join("；");
}

export function isAgentContextPressureError(error: unknown): boolean {
  return isContextPressureError(error);
}
