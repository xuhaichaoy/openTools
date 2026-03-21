import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown, Check, Sparkles, Cpu } from "lucide-react";
import { useAIStore } from "@/store/ai-store";
import { useAppStore, type AICenterMode } from "@/store/app-store";
import { useTeamStore } from "@/store/team-store";
import { api } from "@/core/api/client";
import { primeTeamModelCache } from "@/core/ai/router";
import { buildAICenterModelScope } from "@/core/ai/ai-center-model-scope";
import { resolveAIConfig } from "@/core/ai/resolved-ai-config";
import type { AIConfig } from "@/core/ai/types";

interface TeamModelInfo {
  config_id: string;
  display_name: string;
  model_name: string;
  protocol: string;
  priority: number;
}

interface TeamModelsState {
  teamId: string | null;
  models: TeamModelInfo[];
  status: "idle" | "loading" | "ready" | "error";
}

export function ModelSelector({ scopeMode }: { scopeMode?: AICenterMode }) {
  const { config, saveConfig, ownKeys } = useAIStore();
  const currentMode = useAppStore((s) => s.aiCenterMode);
  const aiCenterModelScopes = useAppStore((s) => s.aiCenterModelScopes);
  const setAICenterModelScope = useAppStore((s) => s.setAICenterModelScope);
  const [open, setOpen] = useState(false);
  const [teamModelsState, setTeamModelsState] = useState<TeamModelsState>({
    teamId: null,
    models: [],
    status: "idle",
  });
  const [openUp, setOpenUp] = useState(true);
  const [dropdownWidth, setDropdownWidth] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const effectiveMode = scopeMode ?? currentMode;
  const currentScope = aiCenterModelScopes[effectiveMode];
  const effectiveConfig = resolveAIConfig({
    baseConfig: config,
    ownKeys,
    scope: currentScope,
  });

  const rememberScope = useCallback(
    (nextConfig: AIConfig) => {
      setAICenterModelScope(effectiveMode, buildAICenterModelScope(nextConfig));
    },
    [effectiveMode, setAICenterModelScope],
  );

  const applyScopePatch = useCallback(
    (patch: Partial<AIConfig>) => {
      const aiState = useAIStore.getState();
      const nextConfig = {
        ...resolveAIConfig({
          baseConfig: aiState.config,
          ownKeys: aiState.ownKeys,
          scope: useAppStore.getState().aiCenterModelScopes[effectiveMode],
        }),
        ...patch,
      };
      rememberScope(nextConfig);
    },
    [effectiveMode, rememberScope],
  );

  const { teams, loaded: teamsLoaded, loadTeams } = useTeamStore();

  // 自有 Key：仅当「已有选中但不在当前列表」时回退到第一个（避免 config 未加载完就被覆盖）
  useEffect(() => {
    if (effectiveConfig.source !== "own_key" || ownKeys.length === 0) return;
    const currentId = effectiveConfig.active_own_key_id;
    if (!currentId) return;
    if (ownKeys.some((k) => k.id === currentId)) return;
    const fallback = ownKeys[0];
    applyScopePatch({
      source: "own_key",
      active_own_key_id: fallback.id,
      model: fallback.model,
      protocol: fallback.protocol,
    });
  }, [
    effectiveConfig.source,
    effectiveConfig.active_own_key_id,
    ownKeys,
    applyScopePatch,
  ]);

  // 团队模式下先确保 teams 已加载
  useEffect(() => {
    if (config.source === "team" && !teamsLoaded) {
      void loadTeams();
    }
  }, [config.source, teamsLoaded, loadTeams]);

  // 团队模式下校验 team_id，无效则自动纠正到第一个团队
  useEffect(() => {
    if (config.source !== "team" || !teamsLoaded || teams.length === 0) return;
    if (config.team_id && teams.some((t) => t.id === config.team_id)) return;
    const fallbackId = teams[0].id;
    void saveConfig({
      ...useAIStore.getState().config,
      team_id: fallbackId,
      team_config_id: undefined,
    });
  }, [config.source, config.team_id, teamsLoaded, teams, saveConfig]);

  // 加载团队模型（只在 team_id 经过验证后才请求）
  useEffect(() => {
    if (effectiveConfig.source === "team" && effectiveConfig.team_id) {
      if (!teamsLoaded || !teams.some((t) => t.id === effectiveConfig.team_id)) return;
      const teamId = effectiveConfig.team_id;
      let cancelled = false;
      setTeamModelsState({
        teamId,
        models: [],
        status: "loading",
      });
      api
        .get<{ models: TeamModelInfo[] }>(
          `/teams/${teamId}/ai-models`,
        )
        .then((res) => {
          if (!cancelled) {
            const models = res.models || [];
            primeTeamModelCache(teamId, models);
            setTeamModelsState({
              teamId,
              models,
              status: "ready",
            });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setTeamModelsState({
              teamId,
              models: [],
              status: "error",
            });
          }
        });
      return () => {
        cancelled = true;
      };
    } else {
      queueMicrotask(() => {
        setTeamModelsState((prev) =>
          prev.teamId === null &&
          prev.models.length === 0 &&
          prev.status === "idle"
            ? prev
            : { teamId: null, models: [], status: "idle" },
        );
      });
    }
  }, [effectiveConfig.source, effectiveConfig.team_id, teamsLoaded, teams]);

  // 团队模式下自动修正无效 team_config_id，并优先选中最高优先级模型
  useEffect(() => {
    if (effectiveConfig.source !== "team" || !effectiveConfig.team_id) return;
    if (teamModelsState.teamId !== effectiveConfig.team_id) return;
    if (teamModelsState.status !== "ready") return;

    const teamModels = teamModelsState.models;
    if (teamModels.length === 0) return;

    const selected = effectiveConfig.team_config_id
      ? teamModels.find((m) => m.config_id === effectiveConfig.team_config_id)
      : undefined;
    if (selected) return;

    const fallback = teamModels[0];
    const nextProtocol = (fallback.protocol || "openai") as
      | "openai"
      | "anthropic";
    if (
      effectiveConfig.team_config_id !== fallback.config_id ||
      effectiveConfig.model !== fallback.model_name ||
      effectiveConfig.protocol !== nextProtocol
    ) {
      applyScopePatch({
        team_config_id: fallback.config_id,
        model: fallback.model_name,
        protocol: nextProtocol,
      });
    }
  }, [
    effectiveConfig.source,
    effectiveConfig.team_config_id,
    effectiveConfig.team_id,
    effectiveConfig.model,
    effectiveConfig.protocol,
    teamModelsState,
    applyScopePatch,
  ]);

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

  const currentModel = effectiveConfig.model || "gpt-4o";
  const source = effectiveConfig.source || "own_key";

  // 找到当前模型的显示名
  const getDisplayName = () => {
    if (source === "own_key") {
      const key = ownKeys.find((k) => k.id === effectiveConfig.active_own_key_id);
      if (key) return key.name || key.model;
    }
    if (source === "team") {
      const teamModels = teamModelsState.teamId === effectiveConfig.team_id
        ? teamModelsState.models
        : [];
      const tm = effectiveConfig.team_config_id
        ? teamModels.find((m) => m.config_id === effectiveConfig.team_config_id)
        : teamModels.find((m) => m.model_name === currentModel);
      if (tm) return tm.display_name;
    }
    return currentModel;
  };

  const handleSelectOwnKey = (id: string) => {
    const key = ownKeys.find((item) => item.id === id);
    if (!key) return;
    rememberScope({
      ...effectiveConfig,
      source: "own_key",
      active_own_key_id: id,
      model: key.model,
      protocol: key.protocol,
    });
    setOpen(false);
  };

  const handleSelectTeamModel = (m: TeamModelInfo) => {
    applyScopePatch({
      team_config_id: m.config_id,
      model: m.model_name,
      protocol: (m.protocol || "openai") as "openai" | "anthropic",
    });
    setOpen(false);
  };

  const handleCustomModel = (val: string) => {
    if (!val) return;
    applyScopePatch({ model: val });
    setOpen(false);
  };

  const computeDropdownWidth = useCallback(() => {
    const triggerWidth = btnRef.current?.offsetWidth ?? 0;
    const viewportWidth = window.innerWidth;
    const maxWidth = Math.max(260, Math.min(440, viewportWidth - 16));
    const minWidth = Math.max(220, triggerWidth);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setDropdownWidth(Math.min(maxWidth, minWidth));
      return;
    }

    const rows = source === "own_key"
      ? ownKeys.map((k) => ({
        title: k.name || k.model,
        subtitle: `${k.protocol === "anthropic" ? "Anthropic" : "OpenAI"} · ${k.model}`,
      }))
      : source === "team"
        ? teamModelsState.models.map((m) => ({
          title: m.display_name,
          subtitle: `${m.protocol === "anthropic" ? "Anthropic" : "OpenAI"} · ${m.model_name} · P${m.priority}`,
        }))
        : [];

    let widest = 0;
    for (const row of rows) {
      ctx.font = "600 12px system-ui";
      widest = Math.max(widest, ctx.measureText(row.title).width);
      ctx.font = "400 10px system-ui";
      widest = Math.max(widest, ctx.measureText(row.subtitle).width);
    }

    const estimatedWidth = Math.ceil(widest + 92);
    setDropdownWidth(Math.min(maxWidth, Math.max(minWidth, estimatedWidth)));
  }, [ownKeys, source, teamModelsState.models]);

  const positionClass = openUp
    ? "bottom-full mb-1"
    : "top-full mt-1";

  useEffect(() => {
    if (!open) return;
    const updateLayout = () => {
      computeDirection();
      computeDropdownWidth();
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, [open, computeDirection, computeDropdownWidth]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        className="flex min-w-[180px] max-w-full items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
        style={{ maxWidth: "min(320px, 34vw)" }}
        title={getDisplayName()}
      >
        <Sparkles className="w-3 h-3 text-indigo-400" />
        <span className="min-w-0 flex-1 truncate text-left">{getDisplayName()}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          className={`absolute ${positionClass} right-0 z-50 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl`}
          style={{
            width: dropdownWidth ? `${dropdownWidth}px` : undefined,
            maxWidth: "calc(100vw - 1rem)",
          }}
        >
          <div className="max-h-[280px] overflow-y-auto py-1">
            {/* 自有 Key 模式 */}
            {source === "own_key" && (
              <>
                {ownKeys.length > 0 ? (
                  ownKeys.map((k) => {
                    const isActive = effectiveConfig.active_own_key_id === k.id;
                    return (
                      <button
                        key={k.id}
                        onClick={() => handleSelectOwnKey(k.id)}
                        className={`w-full px-3 py-2 text-xs transition-colors hover:bg-[var(--color-bg-hover)] ${
                          isActive
                            ? "text-[var(--color-accent)]"
                            : "text-[var(--color-text)]"
                        }`}
                        title={k.name || k.model}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 items-start gap-2">
                            <Cpu className="mt-0.5 h-3 w-3 shrink-0" />
                            <div className="min-w-0 flex-1 text-left">
                              <div className="font-medium leading-snug [overflow-wrap:anywhere]">
                                {k.name || k.model}
                              </div>
                              <div className="mt-0.5 text-[10px] text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
                                {k.protocol === "anthropic"
                                  ? "Anthropic"
                                  : "OpenAI"}{" "}
                                · {k.model}
                              </div>
                            </div>
                          </div>
                          {isActive && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                        </div>
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
                {teamModelsState.models.length > 0 ? (
                  teamModelsState.models.map((m) => {
                    const isActive = effectiveConfig.team_config_id === m.config_id;
                    return (
                      <button
                        key={m.config_id}
                        onClick={() => handleSelectTeamModel(m)}
                        className={`w-full px-3 py-2 text-xs transition-colors hover:bg-[var(--color-bg-hover)] ${
                          isActive
                            ? "text-[var(--color-accent)]"
                            : "text-[var(--color-text)]"
                        }`}
                        title={m.display_name}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 items-start gap-2">
                            <Cpu className="mt-0.5 h-3 w-3 shrink-0" />
                            <div className="min-w-0 flex-1 text-left">
                              <div className="font-medium leading-snug [overflow-wrap:anywhere]">{m.display_name}</div>
                              <div className="mt-0.5 text-[10px] text-[var(--color-text-secondary)] [overflow-wrap:anywhere]">
                                {m.protocol === "anthropic"
                                  ? "Anthropic"
                                  : "OpenAI"}{" "}
                                · {m.model_name} · P{m.priority}
                              </div>
                            </div>
                          </div>
                          {isActive && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                        </div>
                      </button>
                    );
                  })
                ) : teamModelsState.status === "loading" ? (
                  <div className="px-3 py-3 text-[10px] text-[var(--color-text-secondary)] text-center">
                    正在加载团队模型...
                  </div>
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
