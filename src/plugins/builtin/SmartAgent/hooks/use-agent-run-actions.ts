import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";

interface UseAgentRunActionsParams {
  ai?: MToolsAI;
  input: string;
  pendingImages: string[];
  setInput: Dispatch<SetStateAction<string>>;
  clearAssets: () => void;
  executeAgentTask: (
    query: string,
    opts?: {
      sessionId?: string;
      taskId?: string;
      systemHint?: string;
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
  pendingImages,
  setInput,
  clearAssets,
  executeAgentTask,
  stopExecution,
}: UseAgentRunActionsParams): UseAgentRunActionsResult {
  const handleRun = useCallback(async () => {
    if (!ai || (!input.trim() && pendingImages.length === 0)) return;

    let query = input.trim();
    const imagePaths = [...pendingImages];
    if (imagePaths.length > 0) {
      const imageInfo = imagePaths.join("\n");
      query = query
        ? `${query}\n\n[用户附带了以下图片文件]\n${imageInfo}`
        : `请分析以下图片文件:\n${imageInfo}`;
    }

    setInput("");
    clearAssets();

    await executeAgentTask(query);
  }, [ai, input, pendingImages, setInput, clearAssets, executeAgentTask]);

  const handleStop = useCallback(() => {
    stopExecution();
  }, [stopExecution]);

  return {
    handleRun,
    handleStop,
  };
}
