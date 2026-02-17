import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check, Sparkles } from "lucide-react";
import { useAIStore } from "@/store/ai-store";

const PRESET_MODELS = [
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI" },
  { id: "deepseek-chat", name: "DeepSeek Chat", provider: "DeepSeek" },
  { id: "deepseek-reasoner", name: "DeepSeek Reasoner", provider: "DeepSeek" },
  { id: "glm-4-plus", name: "GLM-4 Plus", provider: "智谱" },
  { id: "qwen-max", name: "Qwen Max", provider: "通义千问" },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "Anthropic" },
];

export function ModelSelector() {
  const { config, saveConfig } = useAIStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const currentModel = config.model || "gpt-4o";
  const preset = PRESET_MODELS.find((m) => m.id === currentModel);

  const handleSelect = (modelId: string) => {
    saveConfig({ ...config, model: modelId });
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] rounded-lg px-2.5 py-1.5 transition-colors border border-[var(--color-border)]"
      >
        <Sparkles className="w-3 h-3 text-indigo-400" />
        <span className="max-w-[120px] truncate">
          {preset?.name || currentModel}
        </span>
        <ChevronDown
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-56 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50">
          <div className="max-h-[240px] overflow-y-auto py-1">
            {PRESET_MODELS.map((model) => (
              <button
                key={model.id}
                onClick={() => handleSelect(model.id)}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-[var(--color-bg-hover)] transition-colors ${
                  currentModel === model.id
                    ? "text-[var(--color-accent)]"
                    : "text-[var(--color-text)]"
                }`}
              >
                <div>
                  <div className="font-medium">{model.name}</div>
                  <div className="text-[10px] text-[var(--color-text-secondary)]">
                    {model.provider}
                  </div>
                </div>
                {currentModel === model.id && <Check className="w-3.5 h-3.5" />}
              </button>
            ))}
          </div>

          {/* 自定义模型名 */}
          <div className="border-t border-[var(--color-border)] px-3 py-2">
            <input
              type="text"
              className="w-full text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded px-2 py-1 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
              placeholder="自定义模型名称..."
              defaultValue={preset ? "" : currentModel}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) handleSelect(val);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
