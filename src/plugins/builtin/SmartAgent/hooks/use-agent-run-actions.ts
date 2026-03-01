import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";

interface UseAgentRunActionsParams {
  ai?: MToolsAI;
  input: string;
  imagePaths: string[];
  fileContextBlock: string;
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
  setInput,
  clearAssets,
  executeAgentTask,
  stopExecution,
}: UseAgentRunActionsParams): UseAgentRunActionsResult {
  const handleRun = useCallback(async () => {
    const hasContent = input.trim() || imagePaths.length > 0 || fileContextBlock.trim().length > 0;
    if (!ai || !hasContent) return;

    let query = input.trim();
    if (fileContextBlock.trim()) {
      query = query ? `${fileContextBlock}\n\n---\n\n${query}` : `${fileContextBlock}\n\n请根据以上附件内容完成任务。`;
    }

    setInput("");
    clearAssets();

    await executeAgentTask(query, { images: imagePaths.length > 0 ? imagePaths : undefined });
  }, [ai, input, imagePaths, fileContextBlock, setInput, clearAssets, executeAgentTask]);

  const handleStop = useCallback(() => {
    stopExecution();
  }, [stopExecution]);

  return {
    handleRun,
    handleStop,
  };
}
