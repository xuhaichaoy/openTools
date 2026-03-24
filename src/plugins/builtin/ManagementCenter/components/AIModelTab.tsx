import React, { useState, useEffect, lazy, Suspense, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAIStore } from "@/store/ai-store";
import { useAppStore } from "@/store/app-store";
import { buildAICenterModelScope } from "@/core/ai/ai-center-model-scope";
import { getAICenterModeMeta } from "@/core/ai/ai-center-mode-meta";
import type { HumanSelectableAIProductMode } from "@/core/ai/ai-mode-types";
import {
  deleteMemory,
  listMemoryCandidates,
  listConfirmedMemories,
  type AIMemoryItem,
} from "@/core/ai/memory-store";
import {
  DEFAULT_PLATFORM_MODEL,
  DEFAULT_PLATFORM_PROTOCOL,
} from "@/core/ai/resolved-ai-config";
import { handleError } from "@/core/errors";
import { APP_NAME } from "@/config/app-branding";
import {
  AI_MODEL_TAB_BRAND as BRAND,
  EmbeddingConfigSection,
  OwnKeySection,
  ScopePills,
  TeamSourceSection,
  Toggle,
  TrustLevelSelector,
  type ContainerRuntimeAvailability,
} from "./AIModelTabSections";
import {
  Zap,
  Shield,
  Key,
  ShieldAlert,
  MessageSquare,
  BookOpen,
  Smartphone,
  Trash2,
  Cpu,
  Loader2,
  Database,
  Radio,
} from "lucide-react";

const ChannelConfigPanel = lazy(() => import("@/plugins/builtin/SmartAgent/components/ChannelConfigPanel"));

type AIModelSource = "own_key" | "team" | "platform";
type AIConfigPanel = "source" | "assistant" | "knowledge" | "channels";
const AI_CENTER_MODES: HumanSelectableAIProductMode[] = ["explore", "build", "plan", "dialog"];

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
    options?: { syncModelScopes?: boolean },
  ) => {
    const newConfig = { ...config, ...partial };
    setConfig(newConfig);
    saveConfig(newConfig);
    if (options?.syncModelScopes) {
      syncAllModeScopes(newConfig);
    }
  };

  const handleSourceChange = (source: AIModelSource) => {
    if (source === "own_key") {
      if (ownKeys.length > 0) {
        selectOwnKeyModel(ownKeys[0].id);
        queueMicrotask(() => {
          syncAllModeScopes(useAIStore.getState().config);
        });
        return;
      }
      updateAndSave({ source }, { syncModelScopes: true });
      return;
    }

    if (source === "platform") {
      updateAndSave(
        {
          source,
          model: DEFAULT_PLATFORM_MODEL,
          protocol: DEFAULT_PLATFORM_PROTOCOL,
        },
        { syncModelScopes: true },
      );
      return;
    }

    updateAndSave({ source }, { syncModelScopes: true });
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
    <div className="w-full space-y-[var(--space-compact-3)]">
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
        管理中心负责维护模型池与全局执行基座；AI 助手顶部模型选择会按 Explore / Build / Plan / Dialog 分别记住默认模型，不会覆盖这里的能力开关。
        <ScopePills items={AI_CENTER_MODES.map((mode) => `${getAICenterModeMeta(mode).label} 默认`)} />
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
                  { syncModelScopes: true },
                )
              }
              onTeamModelResolved={(partial) =>
                updateAndSave(partial, { syncModelScopes: true })
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
                updateAndSave({
                  enable_advanced_tools: !config.enable_advanced_tools,
                })
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
                  updateAndSave({
                    enable_native_tools: !config.enable_native_tools,
                  })
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

export { EmbeddingConfigSection } from "./AIModelTabSections";
