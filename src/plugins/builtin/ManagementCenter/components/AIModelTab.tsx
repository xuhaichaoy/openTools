import React, { useState, useEffect, lazy, Suspense, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAIStore } from "@/store/ai-store";
import { useRAGStore } from "@/store/rag-store";
import { useAppStore, type AICenterMode } from "@/store/app-store";
import type { OwnKeyModelConfig } from "@/core/ai/types";
import { buildAICenterModelScope } from "@/core/ai/ai-center-model-scope";
import {
  saveAILocalConfigOverrides,
  type AILocalConfigOverrides,
} from "@/core/ai/local-ai-config-preferences";
import { useTeamStore } from "@/store/team-store";
import {
  deleteMemory,
  listMemoryCandidates,
  listConfirmedMemories,
  type AIMemoryItem,
} from "@/core/ai/memory-store";
import { api } from "@/core/api/client";
import { primeTeamModelCache } from "@/core/ai/router";
import { handleError } from "@/core/errors";
import { maskApiKey } from "@/utils/mask";
import { APP_NAME } from "@/config/app-branding";
import {
  Zap,
  Shield,
  Key,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  MessageSquare,
  BookOpen,
  Smartphone,
  Plus,
  Settings,
  Trash2,
  Check,
  Cpu,
  ChevronDown,
  Loader2,
  Users,
  Database,
  Eye,
  EyeOff,
  Save,
  Radio,
} from "lucide-react";

const ChannelConfigPanel = lazy(() => import("@/plugins/builtin/SmartAgent/components/ChannelConfigPanel"));
import {
  useToolTrustStore,
  TRUST_LEVEL_OPTIONS,
  type TrustLevel,
} from "@/store/command-allowlist-store";

const BRAND = "#F28F36";

// 生成简易 ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Toggle 组件 ──
function Toggle({
  checked,
  onChange,
  color = BRAND,
}: {
  checked: boolean;
  onChange: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onChange}
      className="relative w-8 h-[18px] rounded-full transition-colors shrink-0"
      style={{
        background: checked ? color : "var(--color-bg-secondary)",
        border: checked ? "none" : "1px solid var(--color-border)",
      }}
    >
      <div
        className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[15px]" : "translate-x-[2px]"}`}
      />
    </button>
  );
}

function ScopePills({ items }: { items: string[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item}
          className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-text-secondary)]"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

// ── 团队模型信息 ──
interface TeamModelInfo {
  config_id: string;
  display_name: string;
  model_name: string;
  protocol: string;
  priority: number;
}

interface ContainerRuntimeAvailability {
  available: boolean;
  runtime: "docker";
  message: string;
}

type AIModelSource = "own_key" | "team" | "platform";
type AIConfigPanel = "source" | "assistant" | "knowledge" | "channels";
const AI_CENTER_MODES: AICenterMode[] = ["ask", "agent", "cluster", "dialog"];

function toTime(value?: string | null): number {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function isTeamActive(team: { subscription_plan?: "trial" | "pro"; subscription_expires_at?: string | null }): boolean {
  const now = Date.now();
  const expiresAt = team.subscription_expires_at;
  if (team.subscription_plan === "pro") {
    return !expiresAt || toTime(expiresAt) > now;
  }
  return !!expiresAt && toTime(expiresAt) > now;
}

function pickDefaultTeamId(
  teams: Array<{
    id: string;
    created_at?: string;
    subscription_plan?: "trial" | "pro";
    subscription_expires_at?: string | null;
  }>,
): string | null {
  if (teams.length === 0) return null;

  const sorted = [...teams].sort(
    (a, b) => toTime(b.created_at) - toTime(a.created_at),
  );

  const proActive = sorted.find(
    (team) => team.subscription_plan === "pro" && isTeamActive(team),
  );
  if (proActive) return proActive.id;

  const anyActive = sorted.find((team) => isTeamActive(team));
  if (anyActive) return anyActive.id;

  return sorted[0].id;
}

export function AIModelTab() {
  const { config, setConfig, saveConfig, ownKeys, loadOwnKeys, saveOwnKeys, selectOwnKeyModel } =
    useAIStore();
  const setAICenterModelScope = useAppStore((s) => s.setAICenterModelScope);
  const [savedMemories, setSavedMemories] = useState<AIMemoryItem[]>([]);
  const [pendingMemoryCount, setPendingMemoryCount] = useState(0);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [deletingMemoryId, setDeletingMemoryId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<AIConfigPanel>("source");
  const [containerAvailability, setContainerAvailability] =
    useState<ContainerRuntimeAvailability | null>(null);
  const [checkingContainer, setCheckingContainer] = useState(false);
  const nativeToolsSupported =
    navigator.platform.toLowerCase().includes("mac");
  const promptRingStyle: CSSProperties & Record<"--tw-ring-color", string> = {
    "--tw-ring-color": `${BRAND}30`,
  };

  useEffect(() => {
    loadOwnKeys();
  }, [loadOwnKeys]);

  const loadSavedMemories = async () => {
    setLoadingMemories(true);
    try {
      const [items, candidates] = await Promise.all([
        listConfirmedMemories(),
        listMemoryCandidates(),
      ]);
      setSavedMemories(items);
      setPendingMemoryCount(candidates.length);
    } catch (e) {
      handleError(e, { context: "加载长期记忆列表", silent: true });
    } finally {
      setLoadingMemories(false);
    }
  };

  useEffect(() => {
    if (!config.enable_long_term_memory) {
      setSavedMemories([]);
      setPendingMemoryCount(0);
      return;
    }
    void loadSavedMemories();
  }, [config.enable_long_term_memory]);

  const refreshContainerAvailability = async () => {
    setCheckingContainer(true);
    try {
      const result = await invoke<ContainerRuntimeAvailability>(
        "agent_container_available",
      );
      setContainerAvailability(result);
    } catch (e) {
      setContainerAvailability({
        available: false,
        runtime: "docker",
        message: `容器状态检测失败: ${e}`,
      });
    } finally {
      setCheckingContainer(false);
    }
  };

  useEffect(() => {
    if ((config.agent_runtime_mode || "host") === "host") {
      setContainerAvailability(null);
      return;
    }
    void refreshContainerAvailability();
  }, [config.agent_runtime_mode]);

  const syncAllModeScopes = (nextConfig: typeof config) => {
    const scope = buildAICenterModelScope(nextConfig);
    for (const mode of AI_CENTER_MODES) {
      setAICenterModelScope(mode, scope);
    }
  };

  const updateAndSave = (
    partial: Partial<typeof config>,
    localOverrides?: AILocalConfigOverrides,
    options?: { syncModelScopes?: boolean },
  ) => {
    if (localOverrides) {
      saveAILocalConfigOverrides(localOverrides);
    }
    const newConfig = { ...config, ...partial };
    setConfig(newConfig);
    saveConfig(newConfig);
    if (options?.syncModelScopes) {
      syncAllModeScopes(newConfig);
    }
  };

  const handleSourceChange = (source: AIModelSource) => {
    updateAndSave({ source }, undefined, { syncModelScopes: true });
  };

  const sources: {
    id: AIModelSource;
    label: string;
    icon: typeof Key;
    description: string;
  }[] = [
    {
      id: "own_key",
      label: "自有 Key",
      icon: Key,
      description: "使用您自己的 API Key，免费直连模型方。",
    },
    {
      id: "team",
      label: "团队共享",
      icon: Shield,
      description: "使用团队管理员配置的共享 Key，不占个人额度。",
    },
    {
      id: "platform",
      label: "平台服务",
      icon: Zap,
      description: `使用 ${APP_NAME} 提供的平台模型服务，消耗能量额度。`,
    },
  ];

  const sourceLabelMap: Record<AIModelSource, string> = {
    own_key: "自有 Key",
    team: "团队共享",
    platform: "平台服务",
  };
  const currentSource = (config.source || "own_key") as AIModelSource;
  const runtimeModeLabelMap: Record<
    NonNullable<typeof config.agent_runtime_mode>,
    string
  > = {
    host: "Host",
    hybrid: "Hybrid",
    container_preferred: "Container Preferred",
  };
  const memorySubSwitchCount =
    Number(config.enable_memory_auto_recall) +
    Number(config.enable_memory_auto_save) +
    Number(config.enable_memory_sync);

  return (
    <div className="max-w-xl mx-auto space-y-[var(--space-compact-3)]">
      <div>
        <h2 className="text-sm font-semibold">AI 配置中心</h2>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 flex flex-wrap gap-2 text-[10px]">
        <span className="px-2 py-1 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
          当前来源：{sourceLabelMap[currentSource]}
        </span>
        <span className="px-2 py-1 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
          高级工具：{config.enable_advanced_tools ? "开" : "关"}
        </span>
        <span className="px-2 py-1 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
          长期记忆：{config.enable_long_term_memory ? `开 (${memorySubSwitchCount}/3)` : "关"}
        </span>
        <span className="px-2 py-1 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
          Agent 运行：{runtimeModeLabelMap[config.agent_runtime_mode || "host"]}
        </span>
      </div>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-[10px] text-[var(--color-text-secondary)]">
        管理中心负责维护模型池与全局执行基座；AI 助手顶部模型选择会按 Ask / Agent / Cluster / Dialog 分别记住默认模型，不会覆盖这里的能力开关。
        <ScopePills items={["Ask 默认", "Agent 默认", "Cluster 默认", "Dialog 默认"]} />
      </div>

      <div className="grid grid-cols-4 gap-2">
        {[
          { id: "source" as const, label: "模型池", icon: Key },
          { id: "assistant" as const, label: "助手基座", icon: ShieldAlert },
          { id: "knowledge" as const, label: "知识库", icon: BookOpen },
          { id: "channels" as const, label: "IM 通道", icon: Radio },
        ].map((panel) => (
          <button
            key={panel.id}
            onClick={() => setActivePanel(panel.id)}
            className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs border transition-colors ${
              activePanel === panel.id
                ? "bg-[#F28F36]/10 border-[#F28F36]/40 text-[#F28F36]"
                : "bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            <panel.icon className="w-3.5 h-3.5" />
            {panel.label}
          </button>
        ))}
      </div>

      {activePanel === "source" && (
        <>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-[10px] text-[var(--color-text-secondary)]">
            这里定义 AI 助手可选的模型来源与模型池。真正进入 Ask / Agent / Cluster / Dialog 后，顶部模型选择器会分别记住每个模式自己的默认模型。
            <ScopePills items={["模型池", "四模式默认模型"]} />
          </div>

          <div className="grid gap-2">
            {sources.map((src) => {
              const active = config.source === src.id;
              return (
                <button
                  key={src.id}
                  onClick={() => handleSourceChange(src.id)}
                  className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${
                    active
                      ? "border-[#F28F36] bg-[#F28F36]/5"
                      : "border-[var(--color-border)] hover:border-[#F28F36]/30 bg-[var(--color-bg)]"
                  }`}
                >
                  <div
                    className="p-2 rounded-lg shrink-0"
                    style={{
                      background: active ? BRAND : "var(--color-bg-secondary)",
                      color: active ? "white" : BRAND,
                    }}
                  >
                    <src.icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-xs">{src.label}</h3>
                      {active && (
                        <span
                          className="text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded"
                          style={{
                            color: BRAND,
                            background: `${BRAND}15`,
                          }}
                        >
                          当前
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                      {src.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {config.source === "own_key" && (
            <OwnKeySection
              ownKeys={ownKeys}
              activeId={config.active_own_key_id}
              onSave={saveOwnKeys}
              onSelect={selectOwnKeyModel}
            />
          )}

          {config.source === "team" && (
            <TeamSourceSection
              teamId={config.team_id}
              teamConfigId={config.team_config_id}
              model={config.model}
              protocol={config.protocol}
              onTeamChange={(teamId) =>
                updateAndSave(
                  { team_id: teamId, team_config_id: undefined },
                  undefined,
                  { syncModelScopes: true },
                )
              }
              onTeamModelResolved={(partial) =>
                updateAndSave(partial, undefined, { syncModelScopes: true })
              }
            />
          )}

          {config.source === "platform" && (
            <div
              className="p-4 text-center rounded-xl border border-dashed"
              style={{
                background: `${BRAND}08`,
                borderColor: `${BRAND}30`,
              }}
            >
              <Zap
                className="w-6 h-6 mx-auto mb-2 opacity-40"
                style={{ color: BRAND }}
              />
              <p className="text-[10px] text-[var(--color-text-secondary)]">
                当前来源由 {APP_NAME}
                服务器集中管理。您的请求将通过服务器中转以实现计费或共享 Key 使用。
              </p>
            </div>
          )}
        </>
      )}

      {activePanel === "assistant" && (
        <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] space-y-[var(--space-compact-2)]">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-xs font-semibold">助手执行基座</span>
          </div>
          <p className="text-[10px] text-[var(--color-text-secondary)]">
            这里配置 Ask / Agent / Cluster / Dialog 共用的执行基座，包括工具权限、长期记忆、调度重试和系统提示词。
          </p>
          <ScopePills items={["Ask", "Agent", "Cluster", "Dialog", "调度"]} />

          <label className="flex items-center justify-between cursor-pointer">
            <div className="flex-1 pr-3">
              <span className="text-xs text-[var(--color-text)]">
                启用高级工具
              </span>
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                开启后 AI 可执行 shell 命令、读写本地文件、获取系统信息等。危险操作会弹窗确认；该开关仅保存在当前设备，不再被云同步覆盖。
              </p>
              <ScopePills items={["Ask", "Agent", "Cluster", "Dialog"]} />
            </div>
            <Toggle
              checked={config.enable_advanced_tools}
              onChange={() =>
                updateAndSave(
                  {
                    enable_advanced_tools: !config.enable_advanced_tools,
                  },
                  {
                    enable_advanced_tools: !config.enable_advanced_tools,
                  },
                )
              }
              color="#f59e0b"
            />
          </label>

          {config.enable_advanced_tools && (
            <div className="text-[10px] text-amber-600 bg-amber-500/5 rounded-lg px-3 py-2 border border-amber-500/10">
              已启用高级工具：执行命令、读写文件、列出目录、获取系统信息、打开网址、打开文件/目录、获取进程列表。其中执行命令、写入文件、打开路径为危险操作。
            </div>
          )}

          {config.enable_advanced_tools && <TrustLevelSelector />}

          <div className="pt-2 border-t border-[var(--color-border)]/50 space-y-2">
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3 h-3 text-indigo-400" />
              <span className="text-xs text-[var(--color-text)]">
                Agent 编排参数
              </span>
            </div>
            <ScopePills items={["Agent", "Cluster", "调度"]} />

            <label className="block">
              <span className="text-[10px] text-[var(--color-text-secondary)]">
                运行模式
              </span>
              <select
                className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-indigo-400/20"
                value={config.agent_runtime_mode || "host"}
                onChange={(e) =>
                  updateAndSave({
                    agent_runtime_mode: e.target.value as
                      | "host"
                      | "hybrid"
                      | "container_preferred",
                  })
                }
              >
                <option value="host">Host（当前默认）</option>
                <option value="hybrid">
                  Hybrid（容器可用且允许路径时走容器，否则 Host）
                </option>
                <option value="container_preferred">
                  Container Preferred（容器优先）
                </option>
              </select>
            </label>

            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  最大并发
                </span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-indigo-400/20"
                  value={config.agent_max_concurrency ?? 2}
                  onChange={(e) =>
                    updateAndSave({
                      agent_max_concurrency: Math.max(
                        1,
                        Math.min(8, Number(e.target.value || 2)),
                      ),
                    })
                  }
                />
              </label>

              <label className="block">
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  重试次数
                </span>
                <input
                  type="number"
                  min={0}
                  max={10}
                  className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-indigo-400/20"
                  value={config.agent_retry_max ?? 3}
                  onChange={(e) =>
                    updateAndSave({
                      agent_retry_max: Math.max(
                        0,
                        Math.min(10, Number(e.target.value || 3)),
                      ),
                    })
                  }
                />
              </label>

              <label className="block">
                <span className="text-[10px] text-[var(--color-text-secondary)]">
                  退避毫秒
                </span>
                <input
                  type="number"
                  min={500}
                  max={60000}
                  step={100}
                  className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-indigo-400/20"
                  value={config.agent_retry_backoff_ms ?? 5000}
                  onChange={(e) =>
                    updateAndSave({
                      agent_retry_backoff_ms: Math.max(
                        500,
                        Math.min(60000, Number(e.target.value || 5000)),
                      ),
                    })
                  }
                />
              </label>
            </div>
            <p className="text-[10px] text-[var(--color-text-secondary)]">
              Host 为默认模式；Hybrid 会在容器可用时优先容器、否则自动回退 Host；Container Preferred 优先容器执行，按策略回退或拒绝。
            </p>
            {(config.agent_runtime_mode || "host") !== "host" && (
              <div className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-2">
                <span>
                  容器运行时:{" "}
                  {checkingContainer
                    ? "检测中..."
                    : containerAvailability
                      ? containerAvailability.available
                        ? `可用 (${containerAvailability.runtime})`
                        : `不可用 (${containerAvailability.runtime})`
                      : "未知"}
                </span>
                <button
                  onClick={() => void refreshContainerAvailability()}
                  className="px-1.5 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"
                >
                  刷新
                </button>
              </div>
            )}
            {containerAvailability?.message && (
              <p className="text-[10px] text-[var(--color-text-secondary)]">
                {containerAvailability.message}
              </p>
            )}
            <p className="text-[10px] text-[var(--color-text-secondary)]">
              可选外部策略文件：~/.config/51toolbox/agent-policy.json（allowed_roots / force_readonly / block_mode / allow_unattended_host_fallback）。容器执行需配置 allowed_roots。
            </p>
          </div>

          {nativeToolsSupported ? (
            <label className="flex items-center justify-between cursor-pointer">
              <div className="flex-1 pr-3">
                <div className="flex items-center gap-1.5">
                  <Smartphone className="w-3 h-3 text-emerald-400" />
                  <span className="text-xs text-[var(--color-text)]">
                    本机原生应用工具
                  </span>
                </div>
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  开启后 AI 可调用日历、提醒事项、备忘录、邮件、快捷指令、打开应用等本机能力。该开关仅保存在当前设备。
                </p>
                <ScopePills items={["Ask", "Agent", "Cluster", "Dialog"]} />
              </div>
              <Toggle
                checked={config.enable_native_tools}
                onChange={() =>
                  updateAndSave(
                    {
                      enable_native_tools: !config.enable_native_tools,
                    },
                    {
                      enable_native_tools: !config.enable_native_tools,
                    },
                  )
                }
              />
            </label>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-3">
                <div className="flex items-center gap-1.5">
                  <Smartphone className="w-3 h-3 text-[var(--color-text-secondary)]" />
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    本机原生应用工具（仅 macOS）
                  </span>
                </div>
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  当前平台不支持该能力，已自动关闭。
                </p>
                <ScopePills items={["Ask", "Agent", "Cluster", "Dialog"]} />
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-[var(--color-border)]/50 space-y-2">
            <div className="flex items-center gap-1.5">
              <Database className="w-3 h-3 text-cyan-400" />
              <span className="text-xs text-[var(--color-text)]">长期记忆</span>
            </div>
            <ScopePills items={["Ask", "Agent", "Cluster", "Dialog"]} />

            <label className="flex items-center justify-between cursor-pointer">
              <div className="flex-1 pr-3">
                <span className="text-xs text-[var(--color-text)]">启用长期记忆</span>
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  允许 AI 记录你确认后的稳定偏好与长期事实，用于跨会话复用。
                </p>
              </div>
              <Toggle
                checked={config.enable_long_term_memory}
                onChange={() =>
                  updateAndSave({
                    enable_long_term_memory: !config.enable_long_term_memory,
                  })
                }
              />
            </label>

            <label
              className={`flex items-center justify-between ${
                config.enable_long_term_memory ? "cursor-pointer" : "opacity-50"
              }`}
            >
              <div className="flex-1 pr-3">
                <span className="text-xs text-[var(--color-text)]">自动召回记忆</span>
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  发送消息前自动注入最相关的长期记忆。
                </p>
              </div>
              <Toggle
                checked={config.enable_memory_auto_recall}
                onChange={() => {
                  if (!config.enable_long_term_memory) return;
                  updateAndSave({
                    enable_memory_auto_recall: !config.enable_memory_auto_recall,
                  });
                }}
              />
            </label>

            <label
              className={`flex items-center justify-between ${
                config.enable_long_term_memory ? "cursor-pointer" : "opacity-50"
              }`}
            >
              <div className="flex-1 pr-3">
                <span className="text-xs text-[var(--color-text)]">自动提取候选</span>
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  明确且高置信的长期偏好会直接记住，其余候选进入后台队列，不再打断主流程。
                </p>
              </div>
              <Toggle
                checked={config.enable_memory_auto_save}
                onChange={() => {
                  if (!config.enable_long_term_memory) return;
                  updateAndSave({
                    enable_memory_auto_save: !config.enable_memory_auto_save,
                  });
                }}
              />
            </label>

            <label
              className={`flex items-center justify-between ${
                config.enable_long_term_memory ? "cursor-pointer" : "opacity-50"
              }`}
            >
              <div className="flex-1 pr-3">
                <span className="text-xs text-[var(--color-text)]">记忆参与云同步</span>
                <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                  开启后长期记忆会随个人同步策略在多设备间同步。
                </p>
              </div>
              <Toggle
                checked={config.enable_memory_sync}
                onChange={() => {
                  if (!config.enable_long_term_memory) return;
                  updateAndSave({
                    enable_memory_sync: !config.enable_memory_sync,
                  });
                }}
              />
            </label>

            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2.5 space-y-2">
              <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[10px] text-[var(--color-text-secondary)]">
                待确认候选 {pendingMemoryCount} 条。完整的候选确认、手动添加、搜索和编辑，请到左侧 `AI 记忆` 页面。
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                  已确认记忆（{savedMemories.length}）
                </span>
                <button
                  onClick={loadSavedMemories}
                  className="text-[10px] px-2 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]"
                >
                  刷新
                </button>
              </div>

              {loadingMemories ? (
                <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  读取中...
                </div>
              ) : savedMemories.length === 0 ? (
                <div className="text-[10px] text-[var(--color-text-secondary)]">
                  暂无已确认记忆
                </div>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-auto pr-1">
                  {savedMemories.slice(0, 20).map((memory) => (
                    <div
                      key={memory.id}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                    >
                      <div className="text-[11px] text-[var(--color-text)] break-words">
                        {memory.content}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-[var(--color-text-secondary)]">
                          {memory.kind} · 使用 {memory.use_count || 0} 次
                        </span>
                        <button
                          onClick={async () => {
                            setDeletingMemoryId(memory.id);
                            try {
                              await deleteMemory(memory.id);
                              await loadSavedMemories();
                            } catch (e) {
                              handleError(e, { context: "删除长期记忆" });
                            } finally {
                              setDeletingMemoryId(null);
                            }
                          }}
                          disabled={deletingMemoryId === memory.id}
                          className="text-[10px] px-2 py-0.5 rounded border border-red-500/30 text-red-500 hover:bg-red-500/10 disabled:opacity-50 flex items-center gap-1"
                        >
                          {deletingMemoryId === memory.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Trash2 className="w-3 h-3" />
                          )}
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="pt-2 border-t border-[var(--color-border)]/50 space-y-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
              <span className="text-xs font-semibold">全局补充提示词</span>
            </div>
            <p className="text-[10px] text-[var(--color-text-secondary)]">
              追加到默认系统提示词之后，会同步作用于 Ask / Agent / Cluster / Dialog。更适合放稳定规则，不适合放一次性任务。
            </p>
            <ScopePills items={["Ask", "Agent", "Cluster", "Dialog"]} />
            <textarea
              className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border-0 focus:ring-2 resize-none min-h-[140px] max-h-[220px] leading-relaxed"
              style={promptRingStyle}
              value={config.system_prompt}
              onChange={(e) =>
                setConfig({ ...config, system_prompt: e.target.value })
              }
              onBlur={() => saveConfig(config)}
              placeholder="可选。在默认系统提示词之后追加你自己的长期规则，例如“默认先给结论再解释”“代码回答优先列出验证结果”等..."
            />
          </div>
        </div>
      )}

      {activePanel === "knowledge" && (
        <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] space-y-2">
          <div className="flex items-center gap-2">
            <BookOpen className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-xs font-semibold">知识库与检索基座</span>
          </div>
          <p className="text-[10px] text-[var(--color-text-secondary)]">
            这里统一配置对话时的知识库自动检索，以及知识库索引阶段使用的 Embedding / Rerank / OCR 能力。它们独立于模型来源。
          </p>
          <ScopePills items={["Ask", "Agent", "Cluster", "Dialog"]} />

          <label className="flex items-center justify-between cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2.5">
            <div className="flex-1 pr-3">
              <div className="flex items-center gap-1.5">
                <BookOpen className="w-3 h-3 text-indigo-400" />
                <span className="text-xs text-[var(--color-text)]">
                  对话时自动检索知识库
                </span>
              </div>
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                开启后，Ask / Agent / Cluster / Dialog 在发送请求前都会自动注入相关知识库内容。
              </p>
            </div>
            <Toggle
              checked={config.enable_rag_auto_search}
              onChange={() =>
                updateAndSave({
                  enable_rag_auto_search: !config.enable_rag_auto_search,
                })
              }
            />
          </label>

          <EmbeddingConfigSection />
        </div>
      )}

      {activePanel === "channels" && (
        <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] overflow-hidden" style={{ minHeight: 300 }}>
          <Suspense fallback={<div className="p-4 text-xs text-[var(--color-text-secondary)]">加载中...</div>}>
            <ChannelConfigPanel />
          </Suspense>
        </div>
      )}
    </div>
  );
}

// ── 操作确认策略选择器 ──

const TRUST_LEVEL_ICONS: Record<TrustLevel, React.ReactNode> = {
  always_ask: <ShieldCheck className="w-3.5 h-3.5 text-green-500" />,
  auto_approve_file: <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />,
  auto_approve: <ShieldOff className="w-3.5 h-3.5 text-red-500" />,
};

function TrustLevelSelector() {
  const trustLevel = useToolTrustStore((s) => s.trustLevel);
  const setTrustLevel = useToolTrustStore((s) => s.setTrustLevel);

  return (
    <div className="pt-2 border-t border-[var(--color-border)]/50 space-y-2">
      <div className="flex items-center gap-1.5">
        {TRUST_LEVEL_ICONS[trustLevel]}
        <span className="text-xs text-[var(--color-text)]">操作确认策略</span>
      </div>
      <p className="text-[10px] text-[var(--color-text-secondary)]">
        控制 AI 执行危险操作时是否弹出确认对话框，对内置聊天和 SmartAgent 同时生效。
      </p>
      <div className="space-y-1.5">
        {TRUST_LEVEL_OPTIONS.map(({ value, label, description }) => {
          const selected = trustLevel === value;
          return (
            <button
              key={value}
              onClick={() => setTrustLevel(value)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors text-xs ${
                selected
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5"
                  : "border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]"
              }`}
            >
              {TRUST_LEVEL_ICONS[value]}
              <div className="flex-1 min-w-0">
                <span className={selected ? "font-medium text-[var(--color-accent)]" : "text-[var(--color-text)]"}>
                  {label}
                </span>
                <span className="text-[10px] text-[var(--color-text-secondary)] ml-2">
                  {description}
                </span>
              </div>
            </button>
          );
        })}
      </div>
      {trustLevel === "auto_approve" && (
        <div className="text-[10px] text-red-500/80 bg-red-500/5 rounded-lg px-3 py-2 border border-red-500/10">
          全部放行模式下，AI 的所有操作将直接执行，请确保你了解潜在风险。
        </div>
      )}
    </div>
  );
}

// ── Embedding API 配置（知识库向量化专用） ──

export function EmbeddingConfigSection() {
  type ChunkPreset = NonNullable<ReturnType<typeof useRAGStore.getState>["config"]["chunkPreset"]>;
  const { config: ragConfig, updateConfig, loadConfig } = useRAGStore();
  const [chunkPreset, setChunkPreset] = useState<ChunkPreset>(ragConfig.chunkPreset || "general");
  const [chunkSize, setChunkSize] = useState(String(ragConfig.chunkSize || 512));
  const [chunkOverlap, setChunkOverlap] = useState(String(ragConfig.chunkOverlap || 50));
  const [topK, setTopK] = useState(String(ragConfig.topK || 5));
  const [recallTopK, setRecallTopK] = useState(String(ragConfig.recallTopK || 20));
  const [embBaseUrl, setEmbBaseUrl] = useState(ragConfig.embeddingBaseUrl || "");
  const [embApiKey, setEmbApiKey] = useState(ragConfig.embeddingApiKey || "");
  const [embModel, setEmbModel] = useState(ragConfig.embeddingModel || "text-embedding-3-small");
  const [enableRerank, setEnableRerank] = useState(!!ragConfig.enableRerank);
  const [rerankBaseUrl, setRerankBaseUrl] = useState(ragConfig.rerankBaseUrl || "");
  const [rerankApiKey, setRerankApiKey] = useState(ragConfig.rerankApiKey || "");
  const [rerankModel, setRerankModel] = useState(ragConfig.rerankModel || "");
  const [ocrBaseUrl, setOcrBaseUrl] = useState(ragConfig.ocrBaseUrl || "");
  const [ocrToken, setOcrToken] = useState(ragConfig.ocrToken || "");
  const [showKey, setShowKey] = useState(false);
  const [showRerankKey, setShowRerankKey] = useState(false);
  const [showOcrToken, setShowOcrToken] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    queueMicrotask(() => {
      setChunkPreset(ragConfig.chunkPreset || "general");
      setChunkSize(String(ragConfig.chunkSize || 512));
      setChunkOverlap(String(ragConfig.chunkOverlap || 50));
      setTopK(String(ragConfig.topK || 5));
      setRecallTopK(String(ragConfig.recallTopK || 20));
      setEmbBaseUrl(ragConfig.embeddingBaseUrl || "");
      setEmbApiKey(ragConfig.embeddingApiKey || "");
      setEmbModel(ragConfig.embeddingModel || "text-embedding-3-small");
      setEnableRerank(!!ragConfig.enableRerank);
      setRerankBaseUrl(ragConfig.rerankBaseUrl || "");
      setRerankApiKey(ragConfig.rerankApiKey || "");
      setRerankModel(ragConfig.rerankModel || "");
      setOcrBaseUrl(ragConfig.ocrBaseUrl || "");
      setOcrToken(ragConfig.ocrToken || "");
    });
  }, [
    ragConfig.chunkPreset,
    ragConfig.chunkSize,
    ragConfig.chunkOverlap,
    ragConfig.topK,
    ragConfig.recallTopK,
    ragConfig.enableRerank,
    ragConfig.rerankBaseUrl,
    ragConfig.rerankApiKey,
    ragConfig.rerankModel,
    ragConfig.embeddingBaseUrl,
    ragConfig.embeddingApiKey,
    ragConfig.embeddingModel,
    ragConfig.ocrBaseUrl,
    ragConfig.ocrToken,
  ]);

  const handleSave = async () => {
    await updateConfig({
      chunkPreset: chunkPreset as typeof ragConfig.chunkPreset,
      chunkSize: Math.max(80, Number(chunkSize) || 512),
      chunkOverlap: Math.max(0, Number(chunkOverlap) || 50),
      topK: Math.max(1, Number(topK) || 5),
      recallTopK: Math.max(Number(topK) || 5, Number(recallTopK) || 20),
      enableRerank,
      rerankBaseUrl,
      rerankApiKey,
      rerankModel,
      embeddingBaseUrl: embBaseUrl,
      embeddingApiKey: embApiKey,
      embeddingModel: embModel,
      ocrBaseUrl: ocrBaseUrl,
      ocrToken: ocrToken,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] space-y-[var(--space-compact-2)]">
      <div className="flex items-center gap-2">
        <Database className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-xs font-semibold">知识库索引配置</span>
      </div>
      <p className="text-[10px] text-[var(--color-text-secondary)]">
        统一配置知识库的分块策略、Embedding 向量化与图片 OCR。留空时优先复用当前 AI / 服务器 / 登录配置。
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div>
          <label className="text-[10px] text-[var(--color-text-secondary)]">分块预设</label>
          <select
            className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
            value={chunkPreset}
            onChange={(e) => { setChunkPreset(e.target.value as ChunkPreset); setSaved(false); }}
          >
            <option value="general">通用文档</option>
            <option value="qa">问答 FAQ</option>
            <option value="book">书籍长文</option>
            <option value="laws">法规条文</option>
            <option value="code">代码文档</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-[var(--color-text-secondary)]">Chunk Size</label>
          <input
            type="number"
            min={80}
            className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
            placeholder="512"
            value={chunkSize}
            onChange={(e) => { setChunkSize(e.target.value); setSaved(false); }}
          />
        </div>
        <div>
          <label className="text-[10px] text-[var(--color-text-secondary)]">Chunk Overlap</label>
          <input
            type="number"
            min={0}
            className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
            placeholder="50"
            value={chunkOverlap}
            onChange={(e) => { setChunkOverlap(e.target.value); setSaved(false); }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-[var(--color-text-secondary)]">最终返回 Top K</label>
          <input
            type="number"
            min={1}
            className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
            placeholder="5"
            value={topK}
            onChange={(e) => { setTopK(e.target.value); setSaved(false); }}
          />
        </div>
        <div>
          <label className="text-[10px] text-[var(--color-text-secondary)]">召回候选 Recall Top K</label>
          <input
            type="number"
            min={1}
            className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
            placeholder="20"
            value={recallTopK}
            onChange={(e) => { setRecallTopK(e.target.value); setSaved(false); }}
          />
        </div>
      </div>

      <div className="text-[10px] text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] rounded-lg px-3 py-2 border border-[var(--color-border)]">
        “通用 / FAQ / 书籍 / 法规 / 代码” 预设会自动选择更合适的分块边界；选择“自定义”时将严格使用你填写的 Size / Overlap。
      </div>

      <div className="pt-2 border-t border-[var(--color-border)]/50 space-y-2">
        <label className="flex items-center justify-between cursor-pointer">
          <div className="flex-1 pr-3">
            <span className="text-xs text-[var(--color-text)]">启用 Rerank 重排序</span>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              先扩大召回候选，再用 Rerank 模型做最终排序。适合多文档、长文档和语义接近的结果混排。
            </p>
          </div>
          <Toggle
            checked={enableRerank}
            onChange={() => { setEnableRerank(!enableRerank); setSaved(false); }}
          />
        </label>

        <div className={enableRerank ? "space-y-2" : "space-y-2 opacity-50"}>
          <div>
            <label className="text-[10px] text-[var(--color-text-secondary)]">Rerank API 地址</label>
            <input
              type="text"
              disabled={!enableRerank}
              className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20 disabled:opacity-60"
              placeholder="留空时优先复用 Embedding / AI 地址"
              value={rerankBaseUrl}
              onChange={(e) => { setRerankBaseUrl(e.target.value); setSaved(false); }}
            />
          </div>

          <div>
            <label className="text-[10px] text-[var(--color-text-secondary)]">Rerank API Key</label>
            <div className="relative mt-1">
              <input
                type={showRerankKey ? "text" : "password"}
                disabled={!enableRerank}
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 pr-8 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20 disabled:opacity-60"
                placeholder="留空时优先复用 Embedding / AI Key"
                value={rerankApiKey}
                onChange={(e) => { setRerankApiKey(e.target.value); setSaved(false); }}
              />
              <button
                onClick={() => setShowRerankKey(!showRerankKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              >
                {showRerankKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-[var(--color-text-secondary)]">Rerank 模型</label>
            <input
              type="text"
              disabled={!enableRerank}
              className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20 disabled:opacity-60"
              placeholder="例如 BAAI/bge-reranker-v2-m3"
              value={rerankModel}
              onChange={(e) => { setRerankModel(e.target.value); setSaved(false); }}
            />
          </div>
        </div>
      </div>

      <div>
        <label className="text-[10px] text-[var(--color-text-secondary)]">Embedding API 地址</label>
        <input
          type="text"
          className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
          placeholder="https://api.openai.com/v1（留空复用 AI 设置）"
          value={embBaseUrl}
          onChange={(e) => { setEmbBaseUrl(e.target.value); setSaved(false); }}
        />
      </div>

      <div>
        <label className="text-[10px] text-[var(--color-text-secondary)]">Embedding API Key</label>
        <div className="relative mt-1">
          <input
            type={showKey ? "text" : "password"}
            className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 pr-8 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
            placeholder="sk-...（留空复用 AI 设置）"
            value={embApiKey}
            onChange={(e) => { setEmbApiKey(e.target.value); setSaved(false); }}
          />
          <button
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div>
        <label className="text-[10px] text-[var(--color-text-secondary)]">Embedding 模型</label>
        <input
          type="text"
          className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
          placeholder="text-embedding-3-small"
          value={embModel}
          onChange={(e) => { setEmbModel(e.target.value); setSaved(false); }}
        />
      </div>

      <div className="pt-2 border-t border-[var(--color-border)]/50 space-y-2">
        <div className="flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-sky-400" />
          <span className="text-xs font-semibold">图片 OCR 配置</span>
        </div>
        <p className="text-[10px] text-[var(--color-text-secondary)]">
          本地知识库导入图片时会优先使用这里的 OCR 配置；留空则自动复用当前服务器地址和登录 token。
        </p>

        <div>
          <label className="text-[10px] text-[var(--color-text-secondary)]">OCR 服务地址</label>
          <input
            type="text"
            className="w-full mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
            placeholder="http://localhost:3000（留空复用服务器地址）"
            value={ocrBaseUrl}
            onChange={(e) => { setOcrBaseUrl(e.target.value); setSaved(false); }}
          />
        </div>

        <div>
          <label className="text-[10px] text-[var(--color-text-secondary)]">OCR Token</label>
          <div className="relative mt-1">
            <input
              type={showOcrToken ? "text" : "password"}
              className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 pr-8 text-xs outline-none focus:ring-2 focus:ring-emerald-400/20"
              placeholder="留空复用登录态"
              value={ocrToken}
              onChange={(e) => { setOcrToken(e.target.value); setSaved(false); }}
            />
            <button
              onClick={() => setShowOcrToken(!showOcrToken)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              {showOcrToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded-lg transition-colors font-semibold"
        style={{
          background: saved ? "#10b98120" : "#10b98115",
          color: saved ? "#10b981" : "#34d399",
        }}
      >
        {saved ? <Check className="w-3 h-3" /> : <Save className="w-3 h-3" />}
        {saved ? "已保存" : "保存知识库配置"}
      </button>
    </div>
  );
}

// ── 自有 Key 配置区域 ──

function OwnKeySection({
  ownKeys,
  activeId,
  onSave,
  onSelect,
}: {
  ownKeys: OwnKeyModelConfig[];
  activeId?: string;
  onSave: (keys: OwnKeyModelConfig[]) => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const [form, setForm] = useState({
    id: undefined as string | undefined,
    name: "",
    protocol: "openai" as "openai" | "anthropic",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    model: "",
    temperature: 0.7,
    max_tokens: null as number | null,
  });
  const [showForm, setShowForm] = useState(false);

  const resetForm = () => {
    setForm({
      id: undefined,
      name: "",
      protocol: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "",
      model: "",
      temperature: 0.7,
      max_tokens: null,
    });
    setShowForm(false);
  };

  const handleSave = async () => {
    const isEditing = !!form.id;
    if (!form.model || (!isEditing && !form.api_key)) return;

    const existingKey = isEditing
      ? ownKeys.find((k) => k.id === form.id)?.api_key || ""
      : "";
    const entry: OwnKeyModelConfig = {
      id: form.id || genId(),
      name: form.name || form.model,
      protocol: form.protocol,
      base_url: form.base_url,
      api_key: form.api_key || existingKey,
      model: form.model,
      temperature: form.temperature,
      max_tokens: form.max_tokens,
    };

    let newKeys: OwnKeyModelConfig[];
    if (isEditing) {
      newKeys = ownKeys.map((k) => (k.id === form.id ? entry : k));
    } else {
      newKeys = [...ownKeys, entry];
    }
    await onSave(newKeys);
    resetForm();
    // 如果是第一个 key，自动选中
    if (newKeys.length === 1) {
      onSelect(entry.id);
    }
  };

  const handleEdit = (k: OwnKeyModelConfig) => {
    setForm({
      id: k.id,
      name: k.name,
      protocol: k.protocol,
      base_url: k.base_url,
      api_key: "",
      model: k.model,
      temperature: k.temperature,
      max_tokens: k.max_tokens,
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    const newKeys = ownKeys.filter((k) => k.id !== id);
    await onSave(newKeys);
  };

  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] space-y-[var(--space-compact-2)]">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold">自有 Key 模型配置</h3>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
            配置多个 API Key，支持 OpenAI 兼容 和 Anthropic 协议。
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
            className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg transition-colors"
            style={{ color: BRAND, background: `${BRAND}10` }}
          >
            <Plus className="w-3 h-3" />
            添加
          </button>
        )}
      </div>

      {/* 已配置列表 */}
      {ownKeys.length > 0 && (
        <div className="divide-y divide-[var(--color-border)]">
          {ownKeys.map((k) => {
            const isActive = activeId === k.id;
            return (
              <div
                key={k.id}
                className={`flex items-center justify-between py-2.5 cursor-pointer rounded-lg px-2 -mx-2 transition-colors ${
                  isActive ? "bg-[#F28F36]/5" : "hover:bg-[var(--color-bg-hover)]"
                }`}
                onClick={() => onSelect(k.id)}
              >
                <div className="flex items-center gap-2.5">
                  <Cpu className="w-3.5 h-3.5" style={{ color: isActive ? BRAND : "var(--color-text-secondary)" }} />
                  <div>
                    <div className="text-xs font-medium flex items-center gap-1.5">
                      {k.name || k.model}
                      {isActive && (
                        <Check className="w-3 h-3" style={{ color: BRAND }} />
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      <span className={`inline-block px-1 py-0.5 rounded text-[9px] font-medium mr-1 ${
                        k.protocol === "anthropic"
                          ? "bg-orange-500/10 text-orange-500"
                          : "bg-emerald-500/10 text-emerald-500"
                      }`}>
                        {k.protocol === "anthropic" ? "Anthropic" : "OpenAI"}
                      </span>
                      {k.model}
                      {k.api_key && (
                        <span className="ml-1.5 opacity-50">{maskApiKey(k.api_key)}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => handleEdit(k)}
                    title="编辑"
                    className="p-1 text-[var(--color-text-secondary)] hover:text-[#F28F36] transition-colors"
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(k.id)}
                    className="p-1 text-[var(--color-text-secondary)] hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {ownKeys.length === 0 && !showForm && (
        <div className="text-center py-6 text-[10px] text-[var(--color-text-secondary)]">
          还没有配置任何 Key，点击右上角「添加」开始配置。
        </div>
      )}

      {/* 新增/编辑表单 */}
      {showForm && (
        <div className="pt-3 border-t border-[var(--color-border)] space-y-2">
          <h4 className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
            {form.id ? "编辑配置" : "添加新配置"}
          </h4>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={form.protocol}
              onChange={(e) => {
                const protocol = e.target.value as "openai" | "anthropic";
                setForm({
                  ...form,
                  protocol,
                  base_url:
                    protocol === "anthropic"
                      ? "https://api.anthropic.com"
                      : "https://api.openai.com/v1",
                });
              }}
              className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
            <input
              type="text"
              placeholder="显示名称（可选）"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            />
          </div>
          <input
            type="text"
            placeholder="模型名称（如 gpt-4o、claude-3-5-sonnet）*"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
          />
          <input
            type="url"
            placeholder="API Base URL"
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
          />
          <input
            type="password"
            placeholder={
              form.id
                ? `留空不修改 (${maskApiKey(ownKeys.find((k) => k.id === form.id)?.api_key || "")})`
                : "API Key *"
            }
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-[var(--color-text-secondary)]">Temperature</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={form.temperature}
                onChange={(e) =>
                  setForm({ ...form, temperature: parseFloat(e.target.value) || 0.7 })
                }
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
              />
            </div>
            <div>
              <label className="text-[10px] text-[var(--color-text-secondary)]">Max Tokens</label>
              <input
                type="number"
                value={form.max_tokens || ""}
                onChange={(e) =>
                  setForm({ ...form, max_tokens: parseInt(e.target.value) || null })
                }
                placeholder="不限制"
                className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!form.model || (!form.id && !form.api_key)}
              className="flex-1 py-1.5 rounded-lg bg-[#F28F36] text-white text-xs font-semibold disabled:opacity-40 transition-all"
            >
              {form.id ? "更新配置" : "保存配置"}
            </button>
            <button
              onClick={resetForm}
              className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 团队共享来源区域 ──

function TeamSourceSection({
  teamId,
  teamConfigId,
  model,
  protocol,
  onTeamChange,
  onTeamModelResolved,
}: {
  teamId?: string;
  teamConfigId?: string;
  model?: string;
  protocol?: "openai" | "anthropic";
  onTeamChange: (teamId: string) => void;
  onTeamModelResolved: (partial: {
    team_config_id: string;
    model: string;
    protocol: "openai" | "anthropic";
  }) => void;
}) {
  const { teams, loadTeams, reloadTeams, loaded, loadError } = useTeamStore();
  const [models, setModels] = useState<TeamModelInfo[]>([]);
  const [modelsTeamId, setModelsTeamId] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!loaded) loadTeams();
  }, [loaded, loadTeams]);

  const handleReload = async () => {
    setReloading(true);
    await reloadTeams();
    setReloading(false);
  };

  useEffect(() => {
    if (!loaded || teams.length === 0) return;
    const teamIdValid = teamId && teams.some((t) => t.id === teamId);
    if (!teamIdValid) {
      const defaultTeamId = pickDefaultTeamId(teams);
      if (defaultTeamId) {
        onTeamChange(defaultTeamId);
      }
    }
  }, [loaded, teams, teamId, onTeamChange]);

  // 加载团队模型
  useEffect(() => {
    if (!teamId) {
      setModels([]);
      setModelsTeamId(null);
      setLoadingModels(false);
      return;
    }
    let cancelled = false;
    setModels([]);
    setModelsTeamId(null);
    setLoadingModels(true);

    const loadTeamModels = async () => {
      try {
        const res = await api.get<{ models: TeamModelInfo[] }>(
          `/teams/${teamId}/ai-models`,
        );
        if (!cancelled) {
          const nextModels = res.models || [];
          primeTeamModelCache(teamId, nextModels);
          setModelsTeamId(teamId);
          setModels(nextModels);
        }
      } catch (err) {
        if (!cancelled) {
          setModelsTeamId(teamId);
          handleError(err, { context: "获取团队模型" });
        }
      } finally {
        if (!cancelled) {
          setLoadingModels(false);
        }
      }
    };

    void loadTeamModels();

    return () => {
      cancelled = true;
    };
  }, [teamId]);

  useEffect(() => {
    if (!teamId || modelsTeamId !== teamId || loadingModels || models.length === 0) return;

    const selected = teamConfigId
      ? models.find((item) => item.config_id === teamConfigId)
      : models.find((item) => item.model_name === model);
    const fallback = selected || models[0];
    if (!fallback) return;

    const nextProtocol = (fallback.protocol || "openai") === "anthropic"
      ? "anthropic"
      : "openai";

    if (
      teamConfigId === fallback.config_id &&
      model === fallback.model_name &&
      (protocol || "openai") === nextProtocol
    ) {
      return;
    }

    onTeamModelResolved({
      team_config_id: fallback.config_id,
      model: fallback.model_name,
      protocol: nextProtocol,
    });
  }, [
    loadingModels,
    model,
    models,
    onTeamModelResolved,
    protocol,
    teamConfigId,
    teamId,
    modelsTeamId,
  ]);

  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] space-y-[var(--space-compact-2)]">
      <div>
        <h3 className="text-xs font-semibold">团队共享模型</h3>
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
          选择团队后，使用该团队管理员配置的共享 Key，不占个人额度。
        </p>
      </div>

      {/* 团队选择器 */}
      {teams.length > 0 ? (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              选择团队
            </label>
            <button
              onClick={handleReload}
              disabled={reloading}
              className="text-[10px] px-2 py-0.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50 flex items-center gap-1"
            >
              {reloading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : null}
              刷新
            </button>
          </div>
          <div className="relative">
            <select
              value={teamId || ""}
              onChange={(e) => onTeamChange(e.target.value)}
              className="w-full appearance-none bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-2 px-3 pr-8 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--color-text-secondary)] pointer-events-none" />
          </div>
          {teamId && (
            <div className="mt-1 text-[10px] text-[var(--color-text-secondary)] font-mono break-all">
              团队 ID: {teamId}
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-4 space-y-2">
          <Users className="w-5 h-5 mx-auto mb-1.5 text-[var(--color-text-secondary)] opacity-40" />
          <p className="text-[10px] text-[var(--color-text-secondary)]">
            {loadError
              ? "团队加载失败，请重试。"
              : "您还没有加入任何团队。请先在「团队」标签页创建或加入一个团队。"}
          </p>
          {loadError && (
            <button
              onClick={handleReload}
              disabled={reloading}
              className="text-[10px] px-3 py-1 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50 flex items-center gap-1 mx-auto"
            >
              {reloading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              重新加载
            </button>
          )}
        </div>
      )}

      {/* 团队可用模型列表 */}
      {teamId && (
        <>
          {loadingModels ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: BRAND }} />
            </div>
          ) : models.length > 0 ? (
            <div className="divide-y divide-[var(--color-border)]">
              {models.map((m) => (
                <div key={m.config_id} className="flex items-center gap-2.5 py-2.5">
                  <Cpu className="w-3.5 h-3.5" style={{ color: BRAND }} />
                  <div>
                    <div className="text-xs font-medium">{m.display_name}</div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      <span className={`inline-block px-1 py-0.5 rounded text-[9px] font-medium mr-1 ${
                        m.protocol === "anthropic"
                          ? "bg-orange-500/10 text-orange-500"
                          : "bg-emerald-500/10 text-emerald-500"
                      }`}>
                        {m.protocol === "anthropic" ? "Anthropic" : "OpenAI"}
                      </span>
                      {m.model_name} · 优先级 {m.priority}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4">
              <p className="text-[10px] text-[var(--color-text-secondary)]">
                该团队暂无可用模型，请联系团队管理员配置。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
