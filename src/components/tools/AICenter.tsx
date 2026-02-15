import { useState, useRef, lazy, Suspense } from "react";
import {
  ArrowLeft,
  MessageCircle,
  Bot,
  History,
  Search,
  Download,
  Plus,
  Wrench,
  Trash2,
} from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";
import { ModelSelector } from "@/components/ai/ModelSelector";
import { useAIStore } from "@/store/ai-store";
import { useAgentStore } from "@/store/agent-store";
import { useAppStore } from "@/store/app-store";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import type { ChatViewHandle } from "@/components/ai/ChatView";
import type { SmartAgentHandle } from "@/plugins/builtin/SmartAgent/index";

const ChatView = lazy(() =>
  import("@/components/ai/ChatView").then((m) => ({ default: m.ChatView })),
);
const SmartAgentPlugin = lazy(
  () => import("@/plugins/builtin/SmartAgent/index"),
);

type AIMode = "ask" | "agent";

/** 检测用户输入是否适合 Agent 模式（包含执行类关键词） */
const AGENT_KEYWORDS = /(?:执行|运行|打开|创建|删除|文件|目录|命令|shell|终端|安装|部署|下载|上传|移动|复制|重命名)/i;

export function AICenter({
  onBack,
  ai,
}: {
  onBack: () => void;
  ai?: MToolsAI;
}) {
  // 从 app-store 消费一次性的初始模式
  const [mode, setMode] = useState<AIMode>(() =>
    useAppStore.getState().consumeAiInitialMode(),
  );
  const chatRef = useRef<ChatViewHandle>(null);
  const agentRef = useRef<SmartAgentHandle>(null);
  const { onMouseDown } = useDragWindow();
  const { conversations } = useAIStore();
  const { sessions } = useAgentStore();

  const Loading = (
    <div className="h-full flex items-center justify-center text-[var(--color-text-secondary)]">
      加载中...
    </div>
  );

  const iconBtn =
    "p-1.5 rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors";

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* ====== 统一顶栏（单行）====== */}
      <div
        className="flex items-center gap-1.5 px-3 h-11 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing shrink-0"
        onMouseDown={onMouseDown}
      >
        {/* 返回 */}
        <button
          onClick={onBack}
          className={iconBtn}
          title="返回"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        {/* Ask / Agent 模式切换 */}
        <div className="flex items-center bg-[var(--color-bg-secondary)] rounded-lg p-0.5 border border-[var(--color-border)]">
          <button
            onClick={() => setMode("ask")}
            className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-all ${
              mode === "ask"
                ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            <MessageCircle className="w-3 h-3" />
            Ask
          </button>
          <button
            onClick={() => setMode("agent")}
            className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-all ${
              mode === "agent"
                ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            <Bot className="w-3 h-3" />
            Agent
          </button>
        </div>

        {/* 分隔线 */}
        <div className="w-px h-4 bg-[var(--color-border)] mx-0.5" />

        {/* Ask 模式操作按钮 */}
        {mode === "ask" && (
          <>
            {/* 历史 */}
            <button
              onClick={() => chatRef.current?.toggleHistory()}
              className={`${iconBtn} relative`}
              title="对话历史"
            >
              <History className="w-4 h-4" />
              {conversations.length > 1 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-indigo-500 text-white text-[7px] rounded-full flex items-center justify-center font-medium">
                  {conversations.length > 99 ? "99+" : conversations.length}
                </span>
              )}
            </button>
            {/* 搜索 */}
            <button
              onClick={() => chatRef.current?.toggleSearch()}
              className={iconBtn}
              title="搜索对话"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
            {/* 导出 */}
            <button
              onClick={() => chatRef.current?.exportChat()}
              className={iconBtn}
              title="导出对话"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            {/* 新对话 */}
            <button
              onClick={() => chatRef.current?.newChat()}
              className={iconBtn}
              title="新对话"
            >
              <Plus className="w-4 h-4" />
            </button>
          </>
        )}

        {/* Agent 模式操作按钮 */}
        {mode === "agent" && (
          <>
            {/* 历史 */}
            <button
              onClick={() => agentRef.current?.toggleHistory()}
              className={`${iconBtn} relative`}
              title="任务历史"
            >
              <History className="w-4 h-4" />
              {sessions.length > 1 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-500 text-white text-[7px] rounded-full flex items-center justify-center font-medium">
                  {sessions.length > 99 ? "99+" : sessions.length}
                </span>
              )}
            </button>
            {/* 工具列表 */}
            <button
              onClick={() => agentRef.current?.toggleTools()}
              className={iconBtn}
              title="查看可用工具"
            >
              <Wrench className="w-3.5 h-3.5" />
            </button>
            {/* 新任务 */}
            <button
              onClick={() => agentRef.current?.newSession()}
              className={iconBtn}
              title="新任务"
            >
              <Plus className="w-4 h-4" />
            </button>
          </>
        )}

        {/* 弹性间隔 */}
        <div className="flex-1" />

        {/* 模型选择器 */}
        <ModelSelector />
      </div>

      {/* ====== 内容区 ====== */}
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={Loading}>
          {mode === "ask" && (
            <ChatView ref={chatRef} headless hideModelSelector />
          )}
          {mode === "agent" && (
            <SmartAgentPlugin ref={agentRef} ai={ai} headless />
          )}
        </Suspense>
      </div>
    </div>
  );
}
