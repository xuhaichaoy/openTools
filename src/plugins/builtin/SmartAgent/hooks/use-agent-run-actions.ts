import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { useToast } from "@/components/ui/Toast";
import { composeInputWithAttachmentSummary } from "@/hooks/use-input-attachments";
import {
  buildAgentCodingSystemHint,
  resolveCodingExecutionProfile,
  type CodingExecutionProfile,
} from "@/core/agent/coding-profile";
import type { AgentSession } from "@/store/agent-store";
import { useAIStore } from "@/store/ai-store";
import { modelSupportsImageInput } from "@/core/ai/model-capabilities";

interface UseAgentRunActionsParams {
  ai?: MToolsAI;
  busy?: boolean;
  currentSessionId?: string | null;
  currentSession?: AgentSession | null;
  input: string;
  imagePaths: string[];
  attachmentPaths?: string[];
  fileContextBlock: string;
  attachmentSummary: string;
  codingMode?: boolean;
  largeProjectMode?: boolean;
  openClawMode?: boolean;
  /** 来自跨模式 handoff 的来源信息 */
  pendingSourceHandoff?: AgentSession["sourceHandoff"] | null;
  setInput: Dispatch<SetStateAction<string>>;
  clearAssets: () => void;
  enqueueFollowUp?: (
    sessionId: string,
    followUp: {
      query: string;
      images?: string[];
      attachmentPaths?: string[];
      systemHint?: string;
      codingHint?: string;
      runProfile?: CodingExecutionProfile;
      sourceHandoff?: AgentSession["sourceHandoff"];
      forceNewSession?: boolean;
    },
  ) => string;
  executeAgentTask: (
    query: string,
    opts?: {
      sessionId?: string;
      taskId?: string;
      systemHint?: string;
      codingHint?: string;
      images?: string[];
      attachmentPaths?: string[];
      runProfile?: CodingExecutionProfile;
      sourceHandoff?: AgentSession["sourceHandoff"];
      forceNewSession?: boolean;
    },
  ) => Promise<void>;
  stopExecution: () => void;
}

interface UseAgentRunActionsResult {
  handleRun: () => Promise<void>;
  handleStop: () => void;
  effectiveRunProfile: ReturnType<typeof resolveCodingExecutionProfile>;
}

export function useAgentRunActions({
  ai,
  busy = false,
  currentSessionId,
  currentSession,
  input,
  imagePaths,
  attachmentPaths,
  fileContextBlock,
  attachmentSummary,
  codingMode = false,
  largeProjectMode = false,
  openClawMode = false,
  pendingSourceHandoff,
  setInput,
  clearAssets,
  enqueueFollowUp,
  executeAgentTask,
  stopExecution,
}: UseAgentRunActionsParams): UseAgentRunActionsResult {
  const { toast } = useToast();
  const aiConfig = useAIStore((s) => s.config);
  const effectiveRunProfile = resolveCodingExecutionProfile({
    manualProfile: { codingMode, largeProjectMode, openClawMode },
    query: input,
    fileContextBlock,
    attachmentPaths: [...(attachmentPaths ?? []), ...imagePaths],
    handoff: pendingSourceHandoff,
  });

  const shouldStartFreshSession = useCallback((
    query: string,
    options: {
      currentSession?: AgentSession | null;
      hasImages: boolean;
      hasAttachmentPaths: boolean;
      hasSystemHint: boolean;
      pendingSourceHandoff?: AgentSession["sourceHandoff"] | null;
    },
  ): boolean => {
    const session = options.currentSession;
    if (!session || session.tasks.length === 0 || options.pendingSourceHandoff) {
      return false;
    }

    const normalized = query.trim().toLowerCase();
    if (!normalized) return false;

    const continuitySignals = [
      "继续", "接着", "刚才", "之前", "上述", "上面", "这个项目", "当前项目", "这个仓库", "在原项目",
      "基于之前", "沿用", "继续处理", "继续改", "继续修", "在这个页面", "这个页面", "这个文件",
    ];
    if (continuitySignals.some((token) => normalized.includes(token))) {
      return false;
    }

    const explicitFreshSignals = [
      "新任务", "另一个", "无关", "独立", "单独做", "重新做", "从零开始", "不要参考之前", "忽略之前",
    ];
    if (explicitFreshSignals.some((token) => normalized.includes(token))) {
      return true;
    }

    const standaloneArtifactIntent =
      /(实现|生成|创建|写|做|产出)/.test(normalized)
      && /(网页|页面|html|landing|demo|原型|海报|脚本|文档|markdown|md)/.test(normalized);
    const explicitOutputTarget =
      /(保存到|写入|输出到|放到|存到|downloads|desktop|\/users\/|\.html|\.md|\.txt)/.test(normalized);
    const currentSessionLooksHeavy =
      session.tasks.length >= 3
      || Boolean(session.compaction?.summary)
      || Boolean(session.sourceHandoff?.files?.length)
      || session.tasks.some((task) => (task.attachmentPaths?.length ?? 0) > 0);

    if (
      currentSessionLooksHeavy
      && !options.hasSystemHint
      && (standaloneArtifactIntent || options.hasImages)
      && (explicitOutputTarget || options.hasImages)
      && !options.hasAttachmentPaths
    ) {
      return true;
    }

    return false;
  }, []);

  const handleRun = useCallback(async () => {
    const hasContent = input.trim() || imagePaths.length > 0 || fileContextBlock.trim().length > 0;
    if (!ai || !hasContent) return;

    const hasImages = imagePaths.length > 0;
    const supportsImageInput = modelSupportsImageInput(
      aiConfig.model || "",
      aiConfig.protocol,
    );
    if (hasImages && !supportsImageInput) {
      toast(
        "warning",
        "当前模型不支持图片识别，本次会忽略图片内容；如需看图，请切换到支持视觉输入的模型。",
      );
    }

    const userText = input.trim() || (
      fileContextBlock.trim()
        ? "请了解项目结构，等待下一步指令。"
        : imagePaths.length > 0
          ? "请描述这张图片"
          : ""
    );
    const query = composeInputWithAttachmentSummary(userText, attachmentSummary);
    const systemHint = fileContextBlock.trim() || undefined;
  const forceNewSession = shouldStartFreshSession(query, {
      currentSession,
      hasImages,
      hasAttachmentPaths: (attachmentPaths?.length ?? 0) > 0,
      hasSystemHint: Boolean(systemHint),
      pendingSourceHandoff,
    });
    const manualCodingEnabled = codingMode || largeProjectMode || openClawMode;
    const runProfile = manualCodingEnabled
      ? effectiveRunProfile.profile
      : undefined;
    const codingHint = buildAgentCodingSystemHint(runProfile);

    setInput("");
    clearAssets();

    if (busy && currentSessionId && enqueueFollowUp) {
      enqueueFollowUp(currentSessionId, {
        query,
        images: imagePaths.length > 0 ? imagePaths : undefined,
        ...(attachmentPaths?.length ? { attachmentPaths } : {}),
        systemHint,
        codingHint: codingHint || undefined,
        ...(runProfile ? { runProfile } : {}),
        ...(pendingSourceHandoff ? { sourceHandoff: pendingSourceHandoff } : {}),
        ...(forceNewSession ? { forceNewSession: true } : {}),
      });
      return;
    }

    await executeAgentTask(query, {
      ...(forceNewSession ? { forceNewSession: true } : {}),
      images: imagePaths.length > 0 ? imagePaths : undefined,
      ...(attachmentPaths?.length ? { attachmentPaths } : {}),
      systemHint,
      codingHint: codingHint || undefined,
      ...(runProfile ? { runProfile } : {}),
      ...(pendingSourceHandoff ? { sourceHandoff: pendingSourceHandoff } : {}),
    });
  }, [
    ai,
    input,
    imagePaths,
    attachmentPaths,
    fileContextBlock,
    attachmentSummary,
    busy,
      currentSessionId,
      currentSession,
      enqueueFollowUp,
      pendingSourceHandoff,
      aiConfig.model,
      aiConfig.protocol,
      setInput,
      clearAssets,
      executeAgentTask,
      effectiveRunProfile,
      toast,
    ]);

  const handleStop = useCallback(() => {
    stopExecution();
  }, [stopExecution]);

  return {
    handleRun,
    handleStop,
    effectiveRunProfile,
  };
}
