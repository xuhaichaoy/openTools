import type { InboxMessage } from "./types";
import type { DialogStructuredSubtaskResult } from "./dialog-subtask-runtime";

const TASK_FAILED_PATTERN = /^\[(?:Task failed|任务失败):\s*([^\]\n]+)\]/iu;
const TASK_COMPLETED_PATTERN = /^\[(?:Task completed|任务完成):\s*([^\]\n]+)\]/iu;

export interface FollowUpMessageSummary {
  userMessageCount: number;
  userImageCount: number;
  actorMessageCount: number;
  structuredTaskCount: number;
  hasTaskFailure: boolean;
  hasTaskCompletion: boolean;
  failedTaskLabels: string[];
  completedTaskLabels: string[];
}

export interface FollowUpPromptDescriptor {
  mode: "general" | "spawn_failure" | "spawn_completion";
  prompt: string;
  summary: FollowUpMessageSummary;
  images?: string[];
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function compactPromptText(value: string | undefined, maxLength = 320): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function extractStructuredPathCandidates(
  structuredTasks: readonly DialogStructuredSubtaskResult[],
): string[] {
  const paths: string[] = [];
  for (const task of structuredTasks) {
    if ((task.structuredRows?.length ?? 0) > 0) {
      continue;
    }
    for (const artifact of task.artifacts ?? []) {
      if (artifact.path?.trim()) {
        paths.push(artifact.path.trim());
      }
    }
    for (const source of [task.progressSummary, task.terminalResult, task.terminalError]) {
      if (!source) continue;
      const matches = source.match(/\/[^\s"'`]+/g) ?? [];
      for (const match of matches) {
        const normalized = match.replace(/[),.;:]+$/g, "").trim();
        if (normalized) paths.push(normalized);
      }
    }
  }
  return uniqueNonEmpty(paths);
}

function summarizeStructuredRowsPreview(task: DialogStructuredSubtaskResult): string | undefined {
  const rows = task.structuredRows ?? [];
  if (rows.length === 0) return undefined;
  return rows
    .slice(0, 2)
    .map((row) => {
      const courseName = String(row["课程名称"] ?? row["courseName"] ?? row["name"] ?? "").trim();
      const courseIntro = compactPromptText(
        String(row["课程介绍"] ?? row["courseIntro"] ?? row["description"] ?? "").trim(),
        48,
      );
      if (courseName && courseIntro) return `${courseName}｜${courseIntro}`;
      return courseName || courseIntro || compactPromptText(Object.values(row).join(" / "), 48);
    })
    .filter(Boolean)
    .join("；");
}

export function buildStructuredTaskSummaryBlock(
  structuredTasks: readonly DialogStructuredSubtaskResult[],
): string {
  if (structuredTasks.length === 0) return "";

  const completedCount = structuredTasks.filter((task) => task.status === "completed").length;
  const failedCount = structuredTasks.filter((task) => task.status === "error").length;
  const timedOutCount = structuredTasks.filter((task) => task.timeoutReason).length;
  const abortedCount = structuredTasks.filter((task) => task.status === "aborted").length;
  const runningCount = structuredTasks.filter((task) => task.status === "running").length;
  const structuredRowTaskCount = structuredTasks.filter((task) => (task.structuredRows?.length ?? 0) > 0).length;
  const pathCandidates = extractStructuredPathCandidates(structuredTasks).slice(0, 12);

  const headerLines = [
    "## 结构化子任务摘要（本轮最终综合的主输入）",
    `- 子任务总数：${structuredTasks.length}`,
    `- 完成：${completedCount}；失败：${failedCount}；中止：${abortedCount}；超时：${timedOutCount}；运行中：${runningCount}`,
    "- 聚合范围：仅允许引用当前 run 关联的结构化结果与 artifacts，禁止回头扫描 Downloads / 历史目录 / 记忆结果。",
    structuredRowTaskCount > 0
      ? `- 已有 ${structuredRowTaskCount} 个子任务回传可直接消费的 structured rows；优先使用这些 rows，禁止再次根据路径猜测文件并手动 read_file。`
      : "",
    pathCandidates.length > 0
      ? `- 产物 / 路径摘要：${pathCandidates.join("、")}`
      : "- 产物 / 路径摘要：暂无可直接抽取的明确路径，请优先引用各子任务终态里的文件路径、验证结论和 blocker。",
  ];

  const taskLines = structuredTasks.flatMap((task, index) => {
    const title = `${index + 1}. ${task.targetActorName}${task.label ? ` · ${task.label}` : ""}`;
    const statusLines = [
      `- profile: ${task.profile}`,
      task.workerProfileId ? `- worker_profile: ${task.workerProfileId}` : "",
      task.executionIntent ? `- execution_intent: ${task.executionIntent}` : "",
      `- status: ${task.status}${task.timeoutReason ? ` (${task.timeoutReason})` : ""}`,
      task.progressSummary ? `- progress: ${compactPromptText(task.progressSummary)}` : "",
      task.terminalResult ? `- terminal_result: ${compactPromptText(task.terminalResult)}` : "",
      task.terminalError ? `- terminal_error: ${compactPromptText(task.terminalError)}` : "",
      task.resultKind ? `- result_kind: ${task.resultKind}` : "",
      typeof task.rowCount === "number" ? `- row_count: ${task.rowCount}` : "",
      summarizeStructuredRowsPreview(task) ? `- structured_rows_preview: ${summarizeStructuredRowsPreview(task)}` : "",
      typeof task.sourceItemCount === "number" ? `- source_item_count: ${task.sourceItemCount}` : "",
      task.scopedSourceItems?.length ? `- scoped_source_item_count: ${task.scopedSourceItems.length}` : "",
      task.schemaFields?.length ? `- schema_fields: ${task.schemaFields.join("、")}` : "",
      task.blocker ? `- blocker: ${compactPromptText(task.blocker)}` : "",
      task.artifacts?.length
        ? `- artifacts: ${task.artifacts
          .slice(0, 6)
          .map((artifact) => compactPromptText(artifact.path, 120))
          .filter(Boolean)
          .join("；")}`
        : "",
    ].filter(Boolean);
    return [title, ...statusLines];
  });

  return [...headerLines, "", ...taskLines].join("\n");
}

function extractTaskLabel(content: string, pattern: RegExp): string | null {
  const match = pattern.exec(content);
  return match?.[1]?.trim() || null;
}

export function summarizeFollowUpMessages(
  drained: Array<Pick<InboxMessage, "from" | "content" | "images">>,
): FollowUpMessageSummary {
  const failedTaskLabels: string[] = [];
  const completedTaskLabels: string[] = [];
  let userMessageCount = 0;
  let userImageCount = 0;
  let actorMessageCount = 0;

  for (const message of drained) {
    if (message.from === "user") {
      userMessageCount++;
      userImageCount += message.images?.length ?? 0;
      continue;
    }

    actorMessageCount++;
    const failedLabel = extractTaskLabel(message.content, TASK_FAILED_PATTERN);
    if (failedLabel) {
      failedTaskLabels.push(failedLabel);
      continue;
    }

    const completedLabel = extractTaskLabel(message.content, TASK_COMPLETED_PATTERN);
    if (completedLabel) {
      completedTaskLabels.push(completedLabel);
    }
  }

  return {
    userMessageCount,
    userImageCount,
    actorMessageCount,
    structuredTaskCount: 0,
    hasTaskFailure: failedTaskLabels.length > 0,
    hasTaskCompletion: completedTaskLabels.length > 0,
    failedTaskLabels: uniqueNonEmpty(failedTaskLabels),
    completedTaskLabels: uniqueNonEmpty(completedTaskLabels),
  };
}

function summarizeStructuredTasks(
  structuredTasks: readonly DialogStructuredSubtaskResult[],
): FollowUpMessageSummary {
  const failedTaskLabels = structuredTasks
    .filter((task) => task.status === "error" || task.status === "aborted")
    .map((task) => task.label ?? task.task);
  const completedTaskLabels = structuredTasks
    .filter((task) => task.status === "completed")
    .map((task) => task.label ?? task.task);

  return {
    userMessageCount: 0,
    userImageCount: 0,
    actorMessageCount: structuredTasks.length,
    structuredTaskCount: structuredTasks.length,
    hasTaskFailure: failedTaskLabels.length > 0,
    hasTaskCompletion: completedTaskLabels.length > 0,
    failedTaskLabels: uniqueNonEmpty(failedTaskLabels),
    completedTaskLabels: uniqueNonEmpty(completedTaskLabels),
  };
}

function mergeFollowUpSummaries(
  messageSummary: FollowUpMessageSummary,
  structuredSummary: FollowUpMessageSummary,
): FollowUpMessageSummary {
  return {
    userMessageCount: messageSummary.userMessageCount + structuredSummary.userMessageCount,
    userImageCount: messageSummary.userImageCount + structuredSummary.userImageCount,
    actorMessageCount: messageSummary.actorMessageCount + structuredSummary.actorMessageCount,
    structuredTaskCount: messageSummary.structuredTaskCount + structuredSummary.structuredTaskCount,
    hasTaskFailure: messageSummary.hasTaskFailure || structuredSummary.hasTaskFailure,
    hasTaskCompletion: messageSummary.hasTaskCompletion || structuredSummary.hasTaskCompletion,
    failedTaskLabels: uniqueNonEmpty([
      ...messageSummary.failedTaskLabels,
      ...structuredSummary.failedTaskLabels,
    ]),
    completedTaskLabels: uniqueNonEmpty([
      ...messageSummary.completedTaskLabels,
      ...structuredSummary.completedTaskLabels,
    ]),
  };
}

function renderStructuredTasks(
  structuredTasks: readonly DialogStructuredSubtaskResult[],
): string[] {
  return structuredTasks.map((task) => {
    const lines = [
      `[结构化子任务结果] ${task.targetActorName}${task.label ? ` · ${task.label}` : ""}`,
      `- run_id: ${task.runId}`,
      `- profile: ${task.profile}`,
      task.workerProfileId ? `- worker_profile: ${task.workerProfileId}` : "",
      task.executionIntent ? `- execution_intent: ${task.executionIntent}` : "",
      `- status: ${task.status}`,
      task.progressSummary ? `- progress: ${task.progressSummary}` : "",
      task.terminalResult ? `- result: ${task.terminalResult.slice(0, 320)}` : "",
      task.terminalError ? `- error: ${task.terminalError.slice(0, 320)}` : "",
      task.resultKind ? `- result_kind: ${task.resultKind}` : "",
      typeof task.rowCount === "number" ? `- row_count: ${task.rowCount}` : "",
      summarizeStructuredRowsPreview(task) ? `- structured_rows_preview: ${summarizeStructuredRowsPreview(task)}` : "",
      typeof task.sourceItemCount === "number" ? `- source_item_count: ${task.sourceItemCount}` : "",
      task.scopedSourceItems?.length ? `- scoped_source_item_count: ${task.scopedSourceItems.length}` : "",
      task.schemaFields?.length ? `- schema_fields: ${task.schemaFields.join("、")}` : "",
      task.blocker ? `- blocker: ${task.blocker.slice(0, 240)}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  });
}

export function buildFollowUpPromptFromRenderedMessages(params: {
  renderedMessages: string[];
  summary: FollowUpMessageSummary;
  structuredTasks?: readonly DialogStructuredSubtaskResult[];
}): FollowUpPromptDescriptor {
  const { renderedMessages } = params;
  const structuredTasks = params.structuredTasks ?? [];
  const summary = mergeFollowUpSummaries(
    params.summary,
    summarizeStructuredTasks(structuredTasks),
  );
  const blocks = [
    renderedMessages.join("\n"),
    ...renderStructuredTasks(structuredTasks),
  ].filter(Boolean);
  const messageBlock = blocks.join("\n");
  const failedSummary = summary.failedTaskLabels.length
    ? `失败子任务：${summary.failedTaskLabels.join("、")}`
    : "存在子任务失败。";
  const completedSummary = summary.completedTaskLabels.length
    ? `已完成子任务：${summary.completedTaskLabels.join("、")}`
    : "";

  if (summary.hasTaskFailure) {
    return {
      mode: "spawn_failure",
      summary,
      prompt: [
        "你收到了新的协作消息，其中包含子任务失败。",
        failedSummary,
        completedSummary,
        "消息列表：",
        messageBlock,
        "",
        "请优先处理这个失败，不要回到泛化分析循环。",
        "要求：",
        "1. 先判断你是否已经有足够信息直接接管主任务；如果可以，立即使用工具继续完成，不要继续等待。",
        "2. 只有当失败明显来自任务描述不够具体时，才允许重新派发一次子任务；重试时必须补充明确的输出文件、保存路径和验收标准。",
        "3. 如果任务本质是生成网页、代码、文档或其他文件产物，优先直接产出可交付文件，不要只重复“先分析需求/代码结构”。",
        "4. 回复必须明确：失败原因、你采取的处理方式、当前最终结果或真实缺口。",
        "5. 在真正执行接管 / 重试 / 兜底之前，禁止只输出过程纪要、分段进度、执行计划或状态总结。",
        "6. 不要输出“我先分析”“稍后汇总”“继续整理”这类中间态话术。",
      ].filter(Boolean).join("\n"),
    };
  }

  if (summary.hasTaskCompletion && summary.userMessageCount === 0) {
    return {
      mode: "spawn_completion",
      summary,
      prompt: [
        "你收到了新的协作消息，主要是子任务完成回报。",
        completedSummary,
        "消息列表：",
        messageBlock,
        "",
        "请直接整合这些结果并给出最终成果。",
        "要求：",
        "1. 直接输出最终结论和可交付内容，不要重新分析或重复分工。",
        "2. 明确列出已经完成的事项、产物位置和验证情况。",
        "3. 如果仍有真实缺口，只说明尚未完成的部分，不要使用中间态话术。",
      ].filter(Boolean).join("\n"),
    };
  }

  return {
    mode: "general",
    summary,
    prompt: `你收到了新消息：\n${messageBlock}\n\n请处理这些消息。如果所有子任务已完成，请整合结果并输出最终成果。`,
  };
}

export function buildFinalSynthesisPrompt(params?: {
  hadFailedSpawnFollowUp?: boolean;
  failedTaskLabels?: string[];
  structuredTasks?: readonly DialogStructuredSubtaskResult[];
  deliveryPlanBlock?: string;
  aggregateOnly?: boolean;
  hostExportPath?: string;
}): string {
  const failedTaskSummary = uniqueNonEmpty(params?.failedTaskLabels ?? []);
  const structuredTasks = params?.structuredTasks ?? [];
  const structuredSummaryBlock = buildStructuredTaskSummaryBlock(structuredTasks);
  const failureLine = params?.hadFailedSpawnFollowUp
    ? `注意：本轮至少有一个子任务失败${failedTaskSummary.length ? `（${failedTaskSummary.join("、")}）` : ""}。`
    : "";
  const takeoverLine = params?.hadFailedSpawnFollowUp
    ? "如果你已经接管并完成主任务，请直接给出接管后的最终产物；如果仍有缺口，只说明真实失败原因和剩余缺口。"
    : "";

  return [
    "你派发的子任务现在都已经结束。",
    failureLine,
    structuredSummaryBlock,
    params?.deliveryPlanBlock ?? "",
    structuredTasks.length > 0
      ? "请直接以上面的结构化子任务摘要作为主要事实来源，输出给上游的最终综合答复。"
      : "请基于当前会话中的已有结果和刚收到的子任务反馈，输出给上游的最终综合答复。",
    "要求：",
    "1. 直接给结论，不要再说“稍后整理”“继续汇总”之类的中间态话术。",
    "2. 明确列出已经完成的部分、真实产物路径、验证结论与最终判断。",
    "3. 如果子任务里已经给出 terminal_result / terminal_error / progress / artifacts，不要重新猜测；优先直接引用这些结构化事实。",
    "4. 只允许引用当前 run 关联的 artifacts；禁止回头扫描 Downloads、历史文件、memory_search 结果或旧产物目录。",
    "5. 如果仍有缺口，只说明真实缺口，不要重复之前已经完成的工作。",
    params?.aggregateOnly
      ? "6. 本轮 final synthesis 只能聚合已有 structured rows、terminal facts 和当前 run artifacts；禁止重新生成课程内容、重新压缩主题，或重新编造 workbook rows / export 参数。"
      : "",
    params?.aggregateOnly && params?.hostExportPath
      ? `7. 当前 host 已完成导出，直接围绕导出结果确认路径与覆盖情况：${params.hostExportPath}`
      : params?.aggregateOnly
        ? "7. 如果 host 导出尚未成功，只能说明真实 blocker 或缺失条件，不要退回自由生成。"
        : "",
    params?.hadFailedSpawnFollowUp
      ? `${params?.aggregateOnly ? "8" : "6"}. 既然出现过子任务失败，先完成一次主协调复核：自己接管补齐，或说明你已经带着明确输出与验收标准完成过一次重派。`
      : "",
    params?.hadFailedSpawnFollowUp
      ? `${params?.aggregateOnly ? "9" : "7"}. 禁止只输出过程纪要、分段任务汇总、执行计划或状态盘点。`
      : "",
    takeoverLine,
  ].filter(Boolean).join("\n");
}
