import { useState, lazy, Suspense } from "react";
import { ArrowLeft, Hash, Clock, Wrench } from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";

const JsonFormatter = lazy(() =>
  import("@/components/tools/JsonFormatter").then((m) => ({
    default: m.JsonFormatter,
  })),
);
const TimestampConverter = lazy(() =>
  import("@/components/tools/TimestampConverter").then((m) => ({
    default: m.TimestampConverter,
  })),
);
const Base64Tool = lazy(() =>
  import("@/components/tools/Base64Tool").then((m) => ({
    default: m.Base64Tool,
  })),
);

const tabs = [
  { id: "json", label: "JSON", icon: Hash },
  { id: "timestamp", label: "时间戳", icon: Clock },
  { id: "base64", label: "Base64", icon: Wrench },
] as const;

type TabId = (typeof tabs)[number]["id"];

export function DevToolbox({ onBack }: { onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<TabId>("json");
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
          开发工具箱
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
          {activeTab === "json" && <JsonFormatter />}
          {activeTab === "timestamp" && <TimestampConverter />}
          {activeTab === "base64" && <Base64Tool />}
        </Suspense>
      </div>
    </div>
  );
}
