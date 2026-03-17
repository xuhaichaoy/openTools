export type AgentTurnResultStatus = "success" | "error" | "cancelled";

export interface AgentContextRuntimeDebugReport {
  generatedAt: number;
  sessionId: string;
  taskId: string;
  queryPreview?: string;
  workspaceRoot?: string;
  continuityStrategy?: string;
  continuityReason?: string;
  workspaceReset: boolean;
  scope: {
    queryIntent: string;
    attachmentCount: number;
    imageCount: number;
    handoffCount: number;
    pathHintCount: number;
    pathHintPreview: string[];
  };
  prompt: {
    runModeLabel?: string;
    bootstrapFileCount: number;
    bootstrapFileNames: string[];
    historyContextMessageCount: number;
    knowledgeContextMessageCount: number;
    memoryItemCount: number;
  };
  compaction: {
    compactedTaskCount: number;
    preservedIdentifiers: string[];
    bootstrapRules: string[];
  };
  ingest: {
    sessionNoteSaved: boolean;
    sessionNotePreview?: string;
    referencedPaths: string[];
    memoryAutoExtractionScheduled: boolean;
  };
  execution: {
    status: AgentTurnResultStatus;
    durationMs: number;
    answerPreview?: string;
    errorPreview?: string;
  };
}

export interface AskContextRuntimeDebugReport {
  generatedAt: number;
  conversationId: string;
  queryPreview?: string;
  workspaceRoot?: string;
  sourceModeLabel?: string;
  scope: {
    messageCount: number;
    attachmentCount: number;
    imageCount: number;
    contextBlockCount: number;
    recalledMemoryCount: number;
  };
  ingest: {
    sessionNoteSaved: boolean;
    sessionNotePreview?: string;
    memoryAutoExtractionScheduled: boolean;
  };
  execution: {
    status: AgentTurnResultStatus;
    durationMs: number;
    answerPreview?: string;
    errorPreview?: string;
  };
}

export interface ClusterContextRuntimeDebugReport {
  generatedAt: number;
  sessionId: string;
  queryPreview?: string;
  modeLabel?: string;
  workspaceRoot?: string;
  sourceModeLabel?: string;
  planStepCount: number;
  instanceCount: number;
  runningInstanceCount: number;
  completedInstanceCount: number;
  errorInstanceCount: number;
  ingest: {
    sessionNoteSaved: boolean;
    sessionNotePreview?: string;
  };
  execution: {
    status: AgentTurnResultStatus;
    durationMs: number;
    answerPreview?: string;
    errorPreview?: string;
  };
}
