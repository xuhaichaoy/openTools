import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";

interface UseAgentRunActionsParams {
  ai?: MToolsAI;
  input: string;
  imagePaths: string[];
  fileContextBlock: string;
  attachmentSummary: string;
  setInput: Dispatch<SetStateAction<string>>;
  clearAssets: () => void;
  executeAgentTask: (
    query: string,
    opts?: {
      sessionId?: string;
      taskId?: string;
      systemHint?: string;
      images?: string[];
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

    setInput("");
    clearAssets();

    await executeAgentTask(query, {
      images: imagePaths.length > 0 ? imagePaths : undefined,
      systemHint,
    });
  }, [ai, input, imagePaths, fileContextBlock, attachmentSummary, setInput, clearAssets, executeAgentTask]);

  const handleStop = useCallback(() => {
    stopExecution();
  }, [stopExecution]);

  return {
    handleRun,
    handleStop,
  };
}
