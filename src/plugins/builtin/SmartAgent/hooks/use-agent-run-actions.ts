import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import {
  buildAgentCodingSystemHint,
  type CodingExecutionProfile,
} from "@/core/agent/coding-profile";
import type { AgentSession } from "@/store/agent-store";

interface UseAgentRunActionsParams {
  ai?: MToolsAI;
  input: string;
  imagePaths: string[];
  fileContextBlock: string;
  attachmentSummary: string;
  codingMode?: boolean;
  largeProjectMode?: boolean;
  openClawMode?: boolean;
  /** 来自跨模式 handoff 的来源信息 */
  pendingSourceHandoff?: AgentSession["sourceHandoff"] | null;
  setInput: Dispatch<SetStateAction<string>>;
  clearAssets: () => void;
  executeAgentTask: (
    query: string,
    opts?: {
      sessionId?: string;
      taskId?: string;
      systemHint?: string;
      codingHint?: string;
      images?: string[];
      runProfile?: CodingExecutionProfile;
      sourceHandoff?: AgentSession["sourceHandoff"];
    },
  ) => Promise<void>;
  stopExecution: () => void;
}

interface UseAgentRunActionsResult {
  handleRun: () => Promise<void>;
  handleStop: () => void;
}

export function useAgentRunActions({
  ai,
  input,
  imagePaths,
  fileContextBlock,
  attachmentSummary,
  codingMode = false,
  largeProjectMode = false,
  openClawMode = false,
  pendingSourceHandoff,
  setInput,
  clearAssets,
  executeAgentTask,
  stopExecution,
}: UseAgentRunActionsParams): UseAgentRunActionsResult {
  const handleRun = useCallback(async () => {
    const hasContent = input.trim() || imagePaths.length > 0 || fileContextBlock.trim().length > 0;
    if (!ai || !hasContent) return;

    const userText = input.trim() || (fileContextBlock.trim() ? "请了解项目结构，等待下一步指令。" : "");
    const query = attachmentSummary ? `${attachmentSummary}\n${userText}` : userText;
    const systemHint = fileContextBlock.trim() || undefined;
    const codingHint = buildAgentCodingSystemHint({ codingMode, largeProjectMode, openClawMode });
    const runProfile = (codingMode || openClawMode)
      ? { codingMode, largeProjectMode, openClawMode }
      : undefined;

    setInput("");
    clearAssets();

    await executeAgentTask(query, {
      images: imagePaths.length > 0 ? imagePaths : undefined,
      systemHint,
      codingHint: codingHint || undefined,
      ...(runProfile ? { runProfile } : {}),
      ...(pendingSourceHandoff ? { sourceHandoff: pendingSourceHandoff } : {}),
    });
  }, [
    ai,
    input,
    imagePaths,
    fileContextBlock,
    attachmentSummary,
    codingMode,
    largeProjectMode,
    openClawMode,
    pendingSourceHandoff,
    setInput,
    clearAssets,
    executeAgentTask,
  ]);

  const handleStop = useCallback(() => {
    stopExecution();
  }, [stopExecution]);

  return {
    handleRun,
    handleStop,
  };
}
