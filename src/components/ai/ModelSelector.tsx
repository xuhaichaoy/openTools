import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown, Check, Sparkles, Cpu } from "lucide-react";
import { useAIStore } from "@/store/ai-store";
import { api } from "@/core/api/client";

interface TeamModelInfo {
  id: string;
  config_name: string;
  model_name: string;
  protocol: string;
  base_url: string;
}

export function ModelSelector() {
  const { config, saveConfig, ownKeys, loadOwnKeys, selectOwnKeyModel } =
    useAIStore();
  const [open, setOpen] = useState(false);
  const [teamModels, setTeamModels] = useState<TeamModelInfo[]>([]);
  const [openUp, setOpenUp] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 加载 ownKeys（首次）
  useEffect(() => {
    if (config.source === "own_key" && ownKeys.length === 0) {
      loadOwnKeys();
    }
  }, [config.source]);

  // 加载团队模型
  useEffect(() => {
    if (config.source === "team" && config.team_id) {
      api
        .get<{ models: TeamModelInfo[] }>(
          `/teams/${config.team_id}/ai-models`,
        )
        .then((res) => setTeamModels(res.models || []))
        .catch(() => setTeamModels([]));
    }
  }, [config.source, config.team_id]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 计算弹出方向
  const computeDirection = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    setOpenUp(spaceAbove > spaceBelow && spaceAbove >= 200);
  }, []);

  const handleToggle = () => {
    if (!open) computeDirection();
    setOpen(!open);
  };

  const currentModel = config.model || "gpt-4o";
  const source = config.source || "own_key";

  // 找到当前模型的显示名
  const getDisplayName = () => {
    if (source === "own_key") {
      const key = ownKeys.find((k) => k.id === config.active_own_key_id);
      if (key) return key.name || key.model;
    }
    if (source === "team") {
      const tm = teamModels.find((m) => m.model_name === currentModel);
      if (tm) return tm.config_name;
    }
    return currentModel;
  };

  const handleSelectOwnKey = (id: string) => {
    selectOwnKeyModel(id);
    setOpen(false);
  };

  const handleSelectTeamModel = (m: TeamModelInfo) => {
    const newConfig = {
      ...config,
      model: m.model_name,
      protocol: (m.protocol || "openai") as "openai" | "anthropic",
    };
    saveConfig(newConfig);
    setOpen(false);
  };

  const handleCustomModel = (val: string) => {
    if (!val) return;
    const newConfig = { ...config, model: val };
    saveConfig(newConfig);
    setOpen(false);
  };

  const positionClass = openUp
    ? "bottom-full mb-1"
    : "top-full mt-1";

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] rounded-lg px-2.5 py-1.5 transition-colors border border-[var(--color-border)]"
      >
        <Sparkles className="w-3 h-3 text-indigo-400" />
        <span className="max-w-[120px] truncate">{getDisplayName()}</span>
        <ChevronDown
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          className={`absolute ${positionClass} left-0 w-60 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50`}
        >
          <div className="max-h-[280px] overflow-y-auto py-1">
            {/* 自有 Key 模式 */}
            {source === "own_key" && (
              <>
                {ownKeys.length > 0 ? (
                  ownKeys.map((k) => {
                    const isActive = config.active_own_key_id === k.id;
                    return (
                      <button
                        key={k.id}
                        onClick={() => handleSelectOwnKey(k.id)}
                        className={`w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-[var(--color-bg-hover)] transition-colors ${
                          isActive
                            ? "text-[var(--color-accent)]"
                            : "text-[var(--color-text)]"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Cpu className="w-3 h-3 shrink-0" />
                          <div className="text-left">
                            <div className="font-medium">
                              {k.name || k.model}
                            </div>
                            <div className="text-[10px] text-[var(--color-text-secondary)]">
                              {k.protocol === "anthropic"
                                ? "Anthropic"
                                : "OpenAI"}{" "}
                              · {k.model}
                            </div>
                          </div>
                        </div>
                        {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                      </button>
                    );
                  })
                ) : (
                  <div className="px-3 py-3 text-[10px] text-[var(--color-text-secondary)] text-center">
                    暂无配置，请在「AI 模型」设置中添加 Key。
                  </div>
                )}
              </>
            )}

            {/* 团队共享模式 */}
            {source === "team" && (
              <>
                {teamModels.length > 0 ? (
                  teamModels.map((m) => {
                    const isActive = currentModel === m.model_name;
                    return (
                      <button
                        key={m.id}
                        onClick={() => handleSelectTeamModel(m)}
                        className={`w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-[var(--color-bg-hover)] transition-colors ${
                          isActive
                            ? "text-[var(--color-accent)]"
                            : "text-[var(--color-text)]"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Cpu className="w-3 h-3 shrink-0" />
                          <div className="text-left">
                            <div className="font-medium">{m.config_name}</div>
                            <div className="text-[10px] text-[var(--color-text-secondary)]">
                              {m.protocol === "anthropic"
                                ? "Anthropic"
                                : "OpenAI"}{" "}
                              · {m.model_name}
                            </div>
                          </div>
                        </div>
                        {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                      </button>
                    );
                  })
                ) : (
                  <div className="px-3 py-3 text-[10px] text-[var(--color-text-secondary)] text-center">
                    该团队暂无可用模型。
                  </div>
                )}
              </>
            )}

            {/* 平台模式 — 暂不处理 */}
            {source === "platform" && (
              <div className="px-3 py-3 text-[10px] text-[var(--color-text-secondary)] text-center">
                平台模型由服务器管理。
              </div>
            )}
          </div>

          {/* 自定义模型名输入（仅 own_key 模式显示） */}
          {source === "own_key" && (
            <div className="border-t border-[var(--color-border)] px-3 py-2">
              <input
                type="text"
                className="w-full text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] rounded px-2 py-1 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
                placeholder="自定义模型名称..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const val = (e.target as HTMLInputElement).value.trim();
                    handleCustomModel(val);
                  }
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
