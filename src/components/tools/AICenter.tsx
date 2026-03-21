import { useRef, useEffect, useState, lazy, Suspense } from "react";
import {
  ArrowLeft,
  MessageCircle,
  Bot,
  History,
  Clock3,
  Search,
  Download,
  Plus,
  Wrench,
  Network,
  Users,
  ArrowRightCircle,
  Sparkles,
  X,
  MoreHorizontal,
  LayoutGrid,
} from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";
import { ModelSelector } from "@/components/ai/ModelSelector";
import { useAIStore } from "@/store/ai-store";
import { useAgentStore } from "@/store/agent-store";
import { useClusterStore } from "@/store/cluster-store";
import { useAppStore } from "@/store/app-store";
import { isClusterRunning } from "@/core/agent/cluster/active-orchestrator";
import { AI_CENTER_MODE_META } from "@/core/ai/ai-center-mode-meta";
import {
  buildAICenterModelScope,
  matchesAICenterModelScope,
} from "@/core/ai/ai-center-model-scope";
import {
  describeAssistantConfigBrief,
  getAIConfigSourceLabel,
} from "@/core/ai/assistant-config";
import { resolveAIConfig } from "@/core/ai/resolved-ai-config";
import { SkillsManager } from "@/components/ai/SkillsManager";
import type { PluginContext } from "@/core/plugin-system/context";
import type { ChatViewHandle } from "@/components/ai/ChatView";
import type { SmartAgentHandle } from "@/plugins/builtin/SmartAgent/index";
import type { AICenterMode } from "@/store/app-store";

const ChatView = lazy(() =>
  import("@/components/ai/ChatView").then((m) => ({ default: m.ChatView })),
);
const SmartAgentPlugin = lazy(
  () => import("@/plugins/builtin/SmartAgent/index"),
);
const ClusterPanel = lazy(() =>
  import("@/plugins/builtin/SmartAgent/components/cluster/ClusterPanel").then(
    (m) => ({ default: m.ClusterPanel }),
  ),
);
const ActorChatPanel = lazy(() =>
  import("@/plugins/builtin/SmartAgent/components/actor/ActorChatPanel").then(
    (m) => ({ default: m.ActorChatPanel }),
  ),
);

export function AICenter({
  onBack,
  context,
}: {
  onBack: () => void;
  context: PluginContext;
}) {
  const { ai } = context;

  const mode = useAppStore((s) => s.aiCenterMode);
  const setMode = useAppStore((s) => s.setAiCenterMode);
  const aiCenterModelScopes = useAppStore((s) => s.aiCenterModelScopes);
  const setAICenterModelScope = useAppStore((s) => s.setAICenterModelScope);
  const modeMeta = AI_CENTER_MODE_META[mode];
  const compactModeMetaBar = mode === "dialog" || mode === "ask";
  const aiConfig = useAIStore((s) => s.config);
  const aiSourceLabel = getAIConfigSourceLabel(aiConfig.source);
  const assistantConfigBrief = describeAssistantConfigBrief(aiConfig);
  const ownKeys = useAIStore((s) => s.ownKeys);

  useEffect(() => {
    const oneshot = useAppStore.getState().consumeAiInitialMode();
    if (oneshot !== "ask") {
      setMode(oneshot as AICenterMode);
    }
  }, [setMode]);

  // 每次进入 AI 中心时按顺序恢复配置与自有模型，避免 active_own_key_id 被早到的 ownKeys 回退覆盖。
  useEffect(() => {
    let cancelled = false;

    useAIStore
      .getState()
      .loadConfig()
      .then(() => {
        if (!cancelled) {
          return useAIStore.getState().loadOwnKeys();
        }
        return undefined;
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const scope = aiCenterModelScopes[mode];
    const resolvedConfig = resolveAIConfig({
      baseConfig: aiConfig,
      ownKeys,
      scope,
    });
    if (scope && matchesAICenterModelScope(resolvedConfig, scope)) return;
    setAICenterModelScope(mode, buildAICenterModelScope(resolvedConfig));
  }, [
    mode,
    aiConfig,
    ownKeys,
    aiCenterModelScopes,
    setAICenterModelScope,
  ]);

  const [mounted, setMounted] = useState({ agent: mode === "agent", cluster: mode === "cluster", dialog: mode === "dialog" });
  useEffect(() => {
    setMounted((prev) => {
      if (mode === "agent" && !prev.agent) return { ...prev, agent: true };
      if (mode === "cluster" && !prev.cluster) return { ...prev, cluster: true };
      if (mode === "dialog" && !prev.dialog) return { ...prev, dialog: true };
      return prev;
    });
  }, [mode]);

  const chatRef = useRef<ChatViewHandle>(null);
  const agentRef = useRef<SmartAgentHandle>(null);
  const [showSkills, setShowSkills] = useState(false);
  const [showAskMore, setShowAskMore] = useState(false);
  const askMoreRef = useRef<HTMLDivElement>(null);

  const { onMouseDown } = useDragWindow();
  const conversationCount = useAIStore((s) => s.conversations.length);
  const agentSessionCount = useAgentStore((s) => s.sessions.length);
  const scheduledTaskCount = useAgentStore((s) => s.scheduledTasks.length);
  const clusterSessionCount = useClusterStore((s) => s.sessions.length);

  const Loading = (
    <div className="h-full flex items-center justify-center text-[var(--color-text-secondary)]">
      加载中...
    </div>
  );

  const iconBtn =
    "p-1.5 rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors";

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (askMoreRef.current && !askMoreRef.current.contains(event.target as Node)) {
        setShowAskMore(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const compactMetaCopy = mode === "ask"
    ? {
      detail: "提问 / 读图 / 轻工具",
      model: "Ask 默认",
      skill: "自动激活",
    }
    : mode === "dialog"
      ? {
        detail: "review / debug / brainstorm",
        model: modeMeta.modelScopeShort,
        skill: modeMeta.skillScopeShort,
      }
      : null;
  const modeBtn = (m: AICenterMode, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => {
        setShowAskMore(false);
        setMode(m);
      }}
      className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-all ${
        mode === m
          ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* ====== 统一顶栏 ====== */}
      <div
        className="flex items-center gap-1.5 px-3 h-11 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing shrink-0"
        onMouseDown={onMouseDown}
      >
        <button onClick={onBack} className={iconBtn} title="返回">
          <ArrowLeft className="w-4 h-4" />
        </button>

        {/* 三模式切换 */}
        <div className="flex items-center bg-[var(--color-bg-secondary)] rounded-lg p-0.5 border border-[var(--color-border)]">
          {modeBtn("ask", <MessageCircle className="w-3 h-3" />, "Ask")}
          {modeBtn("agent", <Bot className="w-3 h-3" />, "Agent")}
          {modeBtn(
            "cluster",
            <div className="relative">
              <Network className="w-3 h-3" />
              {isClusterRunning() && (
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-cyan-500 rounded-full animate-pulse" />
              )}
            </div>,
            "Cluster",
          )}
          {modeBtn("dialog", <Users className="w-3 h-3" />, "Dialog")}
        </div>

        <div className="w-px h-4 bg-[var(--color-border)] mx-0.5" />

        {/* Ask 模式操作按钮 */}
        {mode === "ask" && (
          <>
            <button
              onClick={() => chatRef.current?.toggleHistory()}
              className={`${iconBtn} relative`}
              title="对话历史"
            >
              <History className="w-4 h-4" />
              {conversationCount > 1 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-indigo-500 text-white text-[7px] rounded-full flex items-center justify-center font-medium">
                  {conversationCount > 99 ? "99+" : conversationCount}
                </span>
              )}
            </button>
            <button
              onClick={() => chatRef.current?.toggleSearch()}
              className={iconBtn}
              title="搜索对话"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => chatRef.current?.newChat()}
              className={iconBtn}
              title="新对话"
            >
              <Plus className="w-4 h-4" />
            </button>
            <div className="relative" ref={askMoreRef}>
              <button
                onClick={() => setShowAskMore((value) => !value)}
                className={`${iconBtn} ${showAskMore ? "bg-[var(--color-bg-hover)] text-[var(--color-text)]" : ""}`}
                title="更多操作"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {showAskMore && (
                <div className="absolute left-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl">
                  <button
                    onClick={() => {
                      chatRef.current?.exportChat();
                      setShowAskMore(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]"
                  >
                    <Download className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
                    导出对话
                  </button>
                  <div className="border-t border-[var(--color-border)] px-3 py-1.5 text-[10px] text-[var(--color-text-tertiary)]">
                    继续到其他模式
                  </div>
                  <button
                    onClick={() => {
                      chatRef.current?.continueInAgent();
                      setShowAskMore(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]"
                  >
                    <ArrowRightCircle className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
                    用 Agent 继续
                  </button>
                  <button
                    onClick={() => {
                      chatRef.current?.continueInCluster();
                      setShowAskMore(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]"
                  >
                    <Network className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
                    用 Cluster 继续
                  </button>
                  <button
                    onClick={() => {
                      chatRef.current?.continueInDialog();
                      setShowAskMore(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]"
                  >
                    <Users className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
                    用 Dialog 继续
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Agent 模式操作按钮 */}
        {mode === "agent" && (
          <>
            <button
              onClick={() => agentRef.current?.toggleHistory()}
              className={`${iconBtn} relative`}
              title="任务历史"
            >
              <History className="w-4 h-4" />
              {agentSessionCount > 1 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 text-white text-[7px] rounded-full flex items-center justify-center font-medium">
                  {agentSessionCount > 99 ? "99+" : agentSessionCount}
                </span>
              )}
            </button>
            <button
              onClick={() => agentRef.current?.toggleTools()}
              className={iconBtn}
              title="查看可用工具"
            >
              <Wrench className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => agentRef.current?.toggleOrchestrator()}
              className={`${iconBtn} relative`}
              title="编排任务"
            >
              <Clock3 className="w-3.5 h-3.5" />
              {scheduledTaskCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-amber-500 text-white text-[7px] rounded-full flex items-center justify-center font-medium">
                  {scheduledTaskCount > 99 ? "99+" : scheduledTaskCount}
                </span>
              )}
            </button>
            <button
              onClick={() => agentRef.current?.newSession()}
              className={iconBtn}
              title="新任务"
            >
              <Plus className="w-4 h-4" />
            </button>
          </>
        )}

        {/* Cluster 模式操作按钮 */}
        {mode === "cluster" && (
          <span className="text-[11px] text-[var(--color-text-secondary)]">
            {clusterSessionCount > 0
              ? `${clusterSessionCount} 个会话`
              : "输入任务开始"}
          </span>
        )}

        {/* Dialog 模式操作按钮 */}
        <div className="flex-1" />

        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]"
          title="打开工具页"
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          工具
        </button>

        <button
          onClick={() => setShowSkills((v) => !v)}
          className={`${iconBtn} ${showSkills ? "text-[var(--color-accent)]" : ""}`}
          title="技能管理"
        >
          <Sparkles className="w-3.5 h-3.5" />
        </button>

        <ModelSelector scopeMode={mode} />
      </div>

      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/45">
        <div
          className={`flex flex-wrap items-center gap-1.5 px-3 text-[10px] text-[var(--color-text-secondary)] ${
            compactModeMetaBar ? "py-1" : "py-1.5"
          }`}
        >
          <span className="font-medium text-[var(--color-text)]">{modeMeta.boundaryHeadline}</span>
          {!compactModeMetaBar && <span className="opacity-75">{modeMeta.boundaryDetail}</span>}
          {compactModeMetaBar && compactMetaCopy && <span className="opacity-70">{compactMetaCopy.detail}</span>}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] ${
                compactModeMetaBar ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5"
              }`}
              title={`管理中心来源：${aiSourceLabel}；${assistantConfigBrief}`}
            >
              来源：{aiSourceLabel}
            </span>
            <span
              className={`rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] ${
                compactModeMetaBar ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5"
              }`}
              title={modeMeta.modelScope}
            >
              模型：{compactModeMetaBar && compactMetaCopy ? compactMetaCopy.model : modeMeta.modelScopeShort}
            </span>
            <span
              className={`rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] ${
                compactModeMetaBar ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5"
              }`}
              title={modeMeta.skillScope}
            >
              技能：{compactModeMetaBar && compactMetaCopy ? compactMetaCopy.skill : modeMeta.skillScopeShort}
            </span>
          </div>
        </div>
      </div>

      {/* ====== 内容区 ====== */}
      <div className="flex-1 overflow-hidden relative">
        <Suspense fallback={Loading}>
          <div className={`absolute inset-0 ${mode === "ask" ? "" : "invisible pointer-events-none"}`}>
            <ChatView ref={chatRef} headless hideModelSelector active={mode === "ask"} />
          </div>
          {mounted.agent && (
            <div className={`absolute inset-0 ${mode === "agent" ? "" : "invisible pointer-events-none"}`}>
              <SmartAgentPlugin ref={agentRef} ai={ai} headless active={mode === "agent"} />
            </div>
          )}
          {mounted.cluster && (
            <div className={`absolute inset-0 ${mode === "cluster" ? "" : "invisible pointer-events-none"}`}>
              <ClusterPanel active={mode === "cluster"} />
            </div>
          )}
          {mounted.dialog && (
            <div className={`absolute inset-0 ${mode === "dialog" ? "" : "invisible pointer-events-none"}`}>
              <ActorChatPanel active={mode === "dialog"} />
            </div>
          )}
        </Suspense>

        {/* Skills 侧栏面板 */}
        {showSkills && (
          <>
            <div
              className="absolute inset-0 bg-black/10 z-10"
              onClick={() => setShowSkills(false)}
            />
            <aside className="absolute right-0 top-0 bottom-0 z-20 w-[340px] max-w-[90vw] border-l border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl flex flex-col">
              <div className="px-3 py-2 border-b border-[var(--color-border)] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-[var(--color-accent)]" />
                <span className="text-xs font-semibold flex-1">技能管理</span>
                <button
                  onClick={() => setShowSkills(false)}
                  className="p-0.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-3">
                <SkillsManager compact />
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
