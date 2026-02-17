import { useState, lazy, Suspense } from "react";
import { ArrowLeft, PenLine, Sparkles, FileText } from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";
import type { PluginContext } from "@/core/plugin-system/context";

const QuickCapturePlugin = lazy(
  () => import("@/plugins/builtin/QuickCapture/index"),
);
const AINotePlugin = lazy(() => import("@/plugins/builtin/AINote/index"));
const NotesView = lazy(() => import("@/plugins/builtin/Notes/index"));

const tabs = [
  { id: "capture", label: "速记", icon: PenLine },
  { id: "ai-note", label: "AI 生成", icon: Sparkles },
  { id: "editor", label: "编辑器", icon: FileText },
] as const;

type TabId = (typeof tabs)[number]["id"];

export function NoteHub({
  onBack,
  context,
}: {
  onBack: () => void;
  context: PluginContext;
}) {
  const { ai } = context;
  const [activeTab, setActiveTab] = useState<TabId>("capture");
  const { onMouseDown } = useDragWindow();

  const Loading = (
    <div className="h-full flex items-center justify-center text-[var(--color-text-secondary)]">
      加载中...
    </div>
  );

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* 顶部 */}
      <div
        className="flex items-center gap-2 px-5 pt-4 pb-0 cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h2 className="text-base font-medium text-[var(--color-text)]">
          笔记中心
        </h2>
      </div>

      {/* Tab 栏 */}
      <div className="flex gap-1 px-5 pt-3 pb-0">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-t-lg transition-colors border-b-2 ${
                activeTab === tab.id
                  ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-bg-secondary)]"
                  : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="h-px bg-[var(--color-border)]" />

      {/* Tab 内容 — 不传 onBack，壳已有返回按钮 */}
      <div className="flex-1 overflow-y-auto">
        <Suspense fallback={Loading}>
          {activeTab === "capture" && <QuickCapturePlugin />}
          {activeTab === "ai-note" && <AINotePlugin ai={ai} />}
          {activeTab === "editor" && <NotesView />}
        </Suspense>
      </div>
    </div>
  );
}
