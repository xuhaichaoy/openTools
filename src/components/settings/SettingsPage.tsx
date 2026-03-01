import { useState } from "react";
import { ArrowLeft, Bot, Monitor, ShieldCheck, Shield } from "lucide-react";
import { AISettings } from "./AISettings";
import { GeneralSettings } from "./GeneralSettings";
import { CredentialSettings } from "@/components/data-forge/CredentialSettings";
import { CommandAllowlistSettings } from "./CommandAllowlistSettings";
import { useDragWindow } from "@/hooks/useDragWindow";

const tabs = [
  { id: "ai", label: "AI 模型", icon: Bot },
  { id: "general", label: "通用", icon: Monitor },
  { id: "credentials", label: "凭证", icon: ShieldCheck },
  { id: "allowlist", label: "命令放行", icon: Shield },
] as const;

type TabId = (typeof tabs)[number]["id"];

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<TabId>("ai");
  const { onMouseDown } = useDragWindow();

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* 顶部 */}
      <div className="flex items-center gap-2 px-5 pt-4 pb-0 cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h2 className="text-base font-medium text-[var(--color-text)]">设置</h2>
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

      {/* Tab 内容 */}
      <div className="flex-1 overflow-y-auto p-5">
        {activeTab === "ai" && <AISettings />}
        {activeTab === "general" && <GeneralSettings />}
        {activeTab === "credentials" && <CredentialSettings />}
        {activeTab === "allowlist" && <CommandAllowlistSettings />}
      </div>
    </div>
  );
}
