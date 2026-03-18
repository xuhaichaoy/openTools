import type { CodingExecutionProfile } from "@/core/agent/coding-profile";
import {
  buildBootstrapContextSnapshot,
  type BootstrapContextSnapshot,
} from "@/core/ai/bootstrap-context";
import {
  buildAgentPromptContextPrompt,
  buildAgentPromptContextSnapshot,
  type AgentPromptContextSnapshot,
} from "@/plugins/builtin/SmartAgent/core/prompt-context";
import { buildAgentSessionContextMessages } from "@/plugins/builtin/SmartAgent/core/session-compaction";
import {
  deriveAgentSessionFiles,
  type AgentSessionFileInsight,
} from "@/plugins/builtin/SmartAgent/core/session-insights";
import type { AgentSession } from "@/store/agent-store";
import {
  collectHandoffPaths,
  normalizeContextPath,
  uniqueContextPaths,
} from "./scope-resolver";
import type { AgentExecutionContextPlan } from "./types";

export interface AgentExecutionContextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BuildCurrentTurnFileInsightsParams {
  attachmentPaths?: readonly string[];
  images?: readonly string[];
  handoffPaths?: readonly string[];
}

export interface AssembleAgentExecutionContextParams {
  session?: AgentSession | null;
  query: string;
  executionContextPlan: AgentExecutionContextPlan;
  runProfile?: CodingExecutionProfile;
  forceNewSession?: boolean;
  attachmentSummary?: string;
  systemHint?: string;
  userMemoryPrompt?: string;
  skillsPrompt?: string;
  supplementalSystemPrompt?: string;
  codingHint?: string;
  knowledgeContextMessageCount?: number;
  bootstrapIncludeMemory?: boolean;
  bootstrapRecentDailyFiles?: number;
  memoryRecallAttempted?: boolean;
  memoryRecallPreview?: string[];
  transcriptRecallAttempted?: boolean;
  transcriptRecallHitCount?: number;
  transcriptRecallPreview?: string[];
}

export interface AgentExecutionContextAssembly {
  sessionContextMessages: AgentExecutionContextMessage[];
  bootstrapContext: BootstrapContextSnapshot | null;
  promptContextSnapshot: AgentPromptContextSnapshot;
  promptContextPrompt: string;
  extraSystemPrompt?: string;
  effectiveFiles: AgentSessionFileInsight[];
  currentTurnFiles: AgentSessionFileInsight[];
  sessionFiles: AgentSessionFileInsight[];
  bootstrapFilePaths: string[];
  bootstrapHandoffPaths: string[];
  effectiveWorkspaceRoot?: string;
  promptSourceHandoff?: AgentSession["sourceHandoff"];
  shouldResetInheritedContext: boolean;
}

export function buildCurrentTurnFileInsights(
  params: BuildCurrentTurnFileInsightsParams,
): AgentSessionFileInsight[] {
  const map = new Map<string, AgentSessionFileInsight>();
  const push = (
    path: string,
    source: AgentSessionFileInsight["source"],
  ) => {
    const normalized = normalizeContextPath(path);
    if (!normalized) return;
    const current = map.get(normalized);
    if (current) {
      current.mentions += 1;
      if (current.source !== source) current.source = "tool";
      return;
    }
    map.set(normalized, {
      path: normalized,
      source,
      mentions: 1,
    });
  };

  for (const path of params.attachmentPaths ?? []) push(path, "attachment");
  for (const path of params.images ?? []) push(path, "image");
  for (const path of params.handoffPaths ?? []) push(path, "handoff");

  return [...map.values()];
}

function joinPromptBlocks(
  blocks: readonly Array<string | null | undefined>,
): string | undefined {
  const joined = blocks
    .filter((block): block is string => typeof block === "string" && block.trim().length > 0)
    .join("\n\n");
  return joined || undefined;
}

export async function assembleAgentExecutionContext(
  params: AssembleAgentExecutionContextParams,
): Promise<AgentExecutionContextAssembly> {
  const { session, query, executionContextPlan } = params;
  const continuityDecision = executionContextPlan.continuity;
  const sessionContextMessages = continuityDecision.carrySummary
    ? buildAgentSessionContextMessages(session)
    : [];
  const sessionFiles = deriveAgentSessionFiles(session);
  const currentTurnFiles = buildCurrentTurnFileInsights({
    attachmentPaths: executionContextPlan.scope.attachmentPaths,
    images: executionContextPlan.scope.imagePaths,
    handoffPaths: executionContextPlan.scope.handoffPaths,
  });
  const effectiveFiles = continuityDecision.carryFiles
    ? sessionFiles
    : currentTurnFiles;
  const currentTurnPaths = executionContextPlan.scope.pathHints;
  const sessionHandoffPaths = collectHandoffPaths(session?.sourceHandoff);
  const bootstrapFilePaths = uniqueContextPaths([
    ...(continuityDecision.carryFiles
      ? effectiveFiles.map((file) => file.path)
      : currentTurnPaths),
    ...currentTurnPaths,
  ]);
  const bootstrapHandoffPaths = uniqueContextPaths(
    continuityDecision.carryHandoff
      ? [...sessionHandoffPaths, ...executionContextPlan.scope.handoffPaths]
      : executionContextPlan.scope.handoffPaths,
  );
  const bootstrapContext = await buildBootstrapContextSnapshot({
    workspaceRoot: executionContextPlan.effectiveWorkspaceRoot,
    filePaths: bootstrapFilePaths,
    handoffPaths: bootstrapHandoffPaths,
    query,
    includeMemory: params.bootstrapIncludeMemory ?? true,
    recentDailyFiles: params.bootstrapRecentDailyFiles ?? 1,
  }).catch(() => null);

  const promptContextSnapshot = buildAgentPromptContextSnapshot({
    session,
    query,
    runProfile: params.runProfile,
    forceNewSession: params.forceNewSession,
    attachmentSummary: params.attachmentSummary,
    systemHint: params.systemHint,
    sourceHandoff: executionContextPlan.promptSourceHandoff,
    userMemoryPrompt: params.userMemoryPrompt,
    skillsPrompt: params.skillsPrompt,
    extraSystemPrompt: params.supplementalSystemPrompt,
    codingHint: params.codingHint,
    bootstrapContextFileNames: bootstrapContext?.files.map((file) => file.name) ?? [],
    bootstrapContextDiagnostics: bootstrapContext?.diagnostics,
    workspaceRoot: bootstrapContext?.workspaceRoot ?? executionContextPlan.effectiveWorkspaceRoot,
    workspaceReset: executionContextPlan.shouldResetInheritedContext,
    continuityStrategy: continuityDecision.strategy,
    continuityReason: continuityDecision.reason,
    historyContextMessageCount: sessionContextMessages.length,
    knowledgeContextMessageCount: params.knowledgeContextMessageCount ?? 0,
    memoryRecallAttempted: params.memoryRecallAttempted,
    memoryRecallPreview: params.memoryRecallPreview,
    transcriptRecallAttempted: params.transcriptRecallAttempted,
    transcriptRecallHitCount: params.transcriptRecallHitCount,
    transcriptRecallPreview: params.transcriptRecallPreview,
    files: effectiveFiles,
  });
  const promptContextPrompt = buildAgentPromptContextPrompt(promptContextSnapshot);

  return {
    sessionContextMessages,
    bootstrapContext,
    promptContextSnapshot,
    promptContextPrompt,
    extraSystemPrompt: joinPromptBlocks([
      params.supplementalSystemPrompt,
      bootstrapContext?.prompt || "",
      promptContextPrompt,
    ]),
    effectiveFiles,
    currentTurnFiles,
    sessionFiles,
    bootstrapFilePaths,
    bootstrapHandoffPaths,
    effectiveWorkspaceRoot: executionContextPlan.effectiveWorkspaceRoot,
    promptSourceHandoff: executionContextPlan.promptSourceHandoff,
    shouldResetInheritedContext: executionContextPlan.shouldResetInheritedContext,
  };
}
