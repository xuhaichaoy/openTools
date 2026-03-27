import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Plus,
  Star,
  X,
} from "lucide-react";

import { primeTeamModelCache } from "@/core/ai/router";
import { api } from "@/core/api/client";
import {
  ACCESS_MODE_OPTIONS,
  APPROVAL_MODE_OPTIONS,
  buildMiddlewareOverridesForExecutionPolicy,
  DEFAULT_ACCESS_MODE,
  DEFAULT_APPROVAL_MODE,
  summarizeExecutionPolicy,
} from "@/core/agent/actor/execution-policy";
import { formatDurationSeconds } from "@/core/agent/actor/timeout-policy";
import type {
  AccessMode,
  AgentCapability,
  AgentCapabilities,
  ApprovalMode,
  ExecutionPolicy,
  MiddlewareOverrides,
  ThinkingLevel,
  ToolPolicy,
} from "@/core/agent/actor/types";
import { useAIStore } from "@/store/ai-store";
import { type ActorSnapshot } from "@/store/actor-system-store";
import { useTeamStore } from "@/store/team-store";

const ACTOR_COLORS = [
  { bg: "bg-blue-500/10", text: "text-blue-600", border: "border-blue-500/20", dot: "bg-blue-500" },
  { bg: "bg-purple-500/10", text: "text-purple-600", border: "border-purple-500/20", dot: "bg-purple-500" },
  { bg: "bg-emerald-500/10", text: "text-emerald-600", border: "border-emerald-500/20", dot: "bg-emerald-500" },
  { bg: "bg-amber-500/10", text: "text-amber-600", border: "border-amber-500/20", dot: "bg-amber-500" },
  { bg: "bg-rose-500/10", text: "text-rose-600", border: "border-rose-500/20", dot: "bg-rose-500" },
  { bg: "bg-cyan-500/10", text: "text-cyan-600", border: "border-cyan-500/20", dot: "bg-cyan-500" },
];

const CAPABILITY_LABELS: Record<string, { label: string; color: string }> = {
  coordinator: { label: "协调", color: "bg-blue-500/20 text-blue-600" },
  code_review: { label: "Review", color: "bg-green-500/20 text-green-600" },
  code_write: { label: "编写", color: "bg-emerald-500/20 text-emerald-600" },
  code_analysis: { label: "分析", color: "bg-teal-500/20 text-teal-600" },
  security: { label: "安全", color: "bg-red-500/20 text-red-600" },
  performance: { label: "性能", color: "bg-orange-500/20 text-orange-600" },
  architecture: { label: "架构", color: "bg-purple-500/20 text-purple-600" },
  debugging: { label: "调试", color: "bg-rose-500/20 text-rose-600" },
  research: { label: "调研", color: "bg-cyan-500/20 text-cyan-600" },
  documentation: { label: "文档", color: "bg-slate-500/20 text-slate-600" },
  testing: { label: "测试", color: "bg-indigo-500/20 text-indigo-600" },
  devops: { label: "DevOps", color: "bg-amber-500/20 text-amber-600" },
  data_analysis: { label: "数据", color: "bg-pink-500/20 text-pink-600" },
  creative: { label: "创意", color: "bg-violet-500/20 text-violet-600" },
  synthesis: { label: "整合", color: "bg-cyan-500/20 text-cyan-600" },
};

const ALL_CAPABILITIES: { value: AgentCapability; label: string }[] = [
  { value: "coordinator", label: "协调者" },
  { value: "code_review", label: "代码审查" },
  { value: "code_write", label: "代码编写" },
  { value: "code_analysis", label: "代码分析" },
  { value: "security", label: "安全评估" },
  { value: "performance", label: "性能优化" },
  { value: "architecture", label: "架构设计" },
  { value: "debugging", label: "调试排错" },
  { value: "research", label: "调研搜索" },
  { value: "documentation", label: "文档撰写" },
  { value: "testing", label: "测试编写" },
  { value: "devops", label: "DevOps" },
  { value: "data_analysis", label: "数据分析" },
  { value: "creative", label: "创意头脑风暴" },
  { value: "synthesis", label: "综合整合" },
  { value: "vision", label: "视觉识别" },
];

const AGENT_CAPABILITY_SET = new Set<AgentCapability>(ALL_CAPABILITIES.map((cap) => cap.value));
const THINKING_LEVELS: ThinkingLevel[] = ["adaptive", "minimal", "low", "medium", "high", "xhigh", "off"];

export type ModelOption = {
  id: string;
  name: string;
  model: string;
};

export type AddActorDraft = {
  name: string;
  model: string;
  capabilities?: AgentCapabilities;
  workspace?: string;
  toolPolicy?: ToolPolicy;
  executionPolicy?: ExecutionPolicy;
  middlewareOverrides?: MiddlewareOverrides;
  thinkingLevel?: ThinkingLevel;
};

function summarizeTimeoutPolicy(actor: Pick<ActorSnapshot, "timeoutSeconds" | "idleLeaseSeconds">): string | null {
  const parts: string[] = [];
  if (actor.timeoutSeconds) {
    parts.push(`预算 ${formatDurationSeconds(actor.timeoutSeconds) ?? `${actor.timeoutSeconds}s`}`);
  }
  if (actor.idleLeaseSeconds) {
    parts.push(`租约 ${formatDurationSeconds(actor.idleLeaseSeconds) ?? `${actor.idleLeaseSeconds}s`}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function getActorColor(index: number) {
  return ACTOR_COLORS[index % ACTOR_COLORS.length];
}

function summarizeToolPolicy(policy?: ToolPolicy): string {
  if (!policy) return "全工具";
  const parts: string[] = [];
  if (policy.allow?.length) parts.push(`允许 ${policy.allow.join(", ")}`);
  if (policy.deny?.length) parts.push(`禁止 ${policy.deny.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "全工具";
}

function summarizeMiddleware(middleware?: MiddlewareOverrides): string | null {
  if (!middleware?.disable?.length) return null;
  return `关闭 ${middleware.disable.join(", ")}`;
}

function parseCommaSeparatedInput(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function formatCommaSeparatedInput(values?: string[]): string {
  return values?.join(", ") ?? "";
}

function CapabilityBadges({ tags }: { tags?: AgentCapability[] }) {
  if (!tags?.length) return null;
  return (
    <div className="flex items-center gap-0.5 ml-1">
      {tags.slice(0, 3).map((tag) => {
        const info = CAPABILITY_LABELS[tag];
        return (
          <span
            key={tag}
            className={`text-[8px] px-1 rounded-full ${info?.color ?? "bg-gray-500/20 text-gray-600"}`}
            title={tag}
          >
            {info?.label ?? tag}
          </span>
        );
      })}
      {tags.length > 3 && (
        <span className="text-[8px] text-gray-400">+{tags.length - 3}</span>
      )}
    </div>
  );
}

export function useAvailableModels(): ModelOption[] {
  const config = useAIStore((state) => state.config);
  const ownKeys = useAIStore((state) => state.ownKeys);
  const { teams, loaded: teamsLoaded, loadTeams } = useTeamStore();
  const [teamModels, setTeamModels] = useState<ModelOption[]>([]);
  const source = config.source || "own_key";

  useEffect(() => {
    if (source === "team" && !teamsLoaded) void loadTeams();
  }, [source, teamsLoaded, loadTeams]);

  useEffect(() => {
    if (source !== "team" || !config.team_id) {
      setTeamModels([]);
      return;
    }
    if (!teamsLoaded || !teams.some((team) => team.id === config.team_id)) return;

    let cancelled = false;
    api
      .get<{ models: { config_id: string; display_name: string; model_name: string }[] }>(
        `/teams/${config.team_id}/ai-models`,
      )
      .then((response) => {
        if (cancelled) return;
        primeTeamModelCache(config.team_id!, response.models || []);
        setTeamModels((response.models || []).map((item) => ({
          id: item.config_id,
          name: item.display_name,
          model: item.model_name,
        })));
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("[ActorChatPanel] Failed to load team models:", error);
        setTeamModels([]);
      });

    return () => {
      cancelled = true;
    };
  }, [source, config.team_id, teamsLoaded, teams]);

  if (source === "team") return teamModels;
  return ownKeys.map((item) => ({
    id: item.id,
    name: item.name,
    model: item.model,
  }));
}

export function ActorStatusBar({ actors, compact = false }: { actors: ActorSnapshot[]; compact?: boolean }) {
  return (
    <div
      className={compact
        ? "flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        : "flex items-center gap-1.5 flex-wrap"}
    >
      {actors.map((actor, index) => {
        const color = getActorColor(index);
        const isThinking = actor.status === "running";
        return (
          <div
            key={actor.id}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border ${compact ? "px-2 py-0.5 text-[10px]" : "px-2 py-1 text-[10px]"} ${color.bg} ${color.text} ${color.border}`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${color.dot} ${isThinking ? "animate-pulse" : ""}`} />
            <span className="font-medium">{actor.roleName}</span>
            {!compact && <CapabilityBadges tags={actor.capabilities?.tags} />}
            {!compact && actor.modelOverride && (
              <span className="opacity-60 max-w-[80px] truncate">{actor.modelOverride}</span>
            )}
            {isThinking && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
            {actor.pendingInbox > 0 && (
              <span className="bg-red-500 text-white text-[8px] w-3.5 h-3.5 rounded-full flex items-center justify-center">
                {actor.pendingInbox}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MentionPopup({
  actors,
  filter,
  onSelect,
  onClose: _onClose,
}: {
  actors: ActorSnapshot[];
  filter: string;
  onSelect: (name: string) => void;
  onClose?: () => void;
}) {
  const filtered = actors.filter((actor) =>
    actor.roleName.toLowerCase().includes(filter.toLowerCase()),
  );

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full mb-1 left-0 w-48 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50">
      <div className="py-1 max-h-[150px] overflow-y-auto">
        {filtered.map((actor, index) => {
          const color = getActorColor(index);
          return (
            <button
              key={actor.id}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors text-left"
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(actor.roleName);
              }}
            >
              <div className={`w-2 h-2 rounded-full ${color.dot}`} />
              <span>{actor.roleName}</span>
              {actor.status === "running" && <Loader2 className="w-2.5 h-2.5 animate-spin opacity-50" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LiveActorRow({
  actor,
  index,
  isCoordinator,
  isFirst,
  isLast,
  onRemove,
  onMoveUp,
  onMoveDown,
  onSetDefault,
  onUpdate,
  models,
}: {
  actor: ActorSnapshot;
  index: number;
  isCoordinator: boolean;
  isFirst: boolean;
  isLast: boolean;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSetDefault: () => void;
  onUpdate: (patch: {
    name?: string;
    modelOverride?: string;
    workspace?: string;
    thinkingLevel?: ThinkingLevel;
    toolPolicy?: ToolPolicy;
    executionPolicy?: ExecutionPolicy;
    middlewareOverrides?: MiddlewareOverrides;
    capabilities?: AgentCapabilities;
  }) => void;
  models: ModelOption[];
}) {
  const color = getActorColor(index);
  const isRunning = actor.status === "running";
  const executionPolicySummary = summarizeExecutionPolicy(actor.normalizedExecutionPolicy);
  const middlewareSummary = summarizeMiddleware(actor.middlewareOverrides);
  const timeoutSummary = summarizeTimeoutPolicy(actor);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(actor.roleName);
  const [editModel, setEditModel] = useState(actor.modelOverride || "");
  const [editWorkspace, setEditWorkspace] = useState(actor.workspace || "");
  const [editThinking, setEditThinking] = useState<ThinkingLevel>(actor.thinkingLevel || "adaptive");
  const [editCaps, setEditCaps] = useState<AgentCapability[]>(actor.capabilities?.tags ?? []);
  const [editAccessMode, setEditAccessMode] = useState<AccessMode>(
    actor.normalizedExecutionPolicy.accessMode,
  );
  const [editApprovalMode, setEditApprovalMode] = useState<ApprovalMode>(
    actor.normalizedExecutionPolicy.approvalMode,
  );
  const [editToolAllow, setEditToolAllow] = useState(formatCommaSeparatedInput(actor.toolPolicy?.allow));
  const [editToolDeny, setEditToolDeny] = useState(formatCommaSeparatedInput(actor.toolPolicy?.deny));
  const [editDisabledMiddlewares, setEditDisabledMiddlewares] = useState(
    formatCommaSeparatedInput(actor.middlewareOverrides?.disable),
  );
  const [showCapMenu, setShowCapMenu] = useState(false);

  const handleOpenEdit = () => {
    if (isRunning) return;
    setEditName(actor.roleName);
    setEditModel(actor.modelOverride || "");
    setEditWorkspace(actor.workspace || "");
    setEditThinking(actor.thinkingLevel || "adaptive");
    setEditCaps(actor.capabilities?.tags ?? []);
    setEditAccessMode(actor.normalizedExecutionPolicy.accessMode);
    setEditApprovalMode(actor.normalizedExecutionPolicy.approvalMode);
    setEditToolAllow(formatCommaSeparatedInput(actor.toolPolicy?.allow));
    setEditToolDeny(formatCommaSeparatedInput(actor.toolPolicy?.deny));
    setEditDisabledMiddlewares(formatCommaSeparatedInput(actor.middlewareOverrides?.disable));
    setEditing(true);
  };

  const handleSave = () => {
    const allow = parseCommaSeparatedInput(editToolAllow);
    const deny = parseCommaSeparatedInput(editToolDeny);
    const disabled = parseCommaSeparatedInput(editDisabledMiddlewares);
    const executionPolicy: ExecutionPolicy = {
      accessMode: editAccessMode,
      approvalMode: editApprovalMode,
    };
    onUpdate({
      name: editName.trim() || undefined,
      modelOverride: editModel,
      workspace: editWorkspace.trim() || undefined,
      thinkingLevel: editThinking !== "adaptive" ? editThinking : undefined,
      toolPolicy: allow.length > 0 || deny.length > 0
        ? {
            allow: allow.length > 0 ? allow : undefined,
            deny: deny.length > 0 ? deny : undefined,
          }
        : undefined,
      executionPolicy,
      middlewareOverrides: buildMiddlewareOverridesForExecutionPolicy(
        executionPolicy,
        disabled.length > 0 ? { disable: disabled } : undefined,
      ),
      capabilities: editCaps.length > 0 ? { tags: editCaps } : undefined,
    });
    setEditing(false);
  };

  const toggleCap = (capability: AgentCapability) => {
    setEditCaps((prev) =>
      prev.includes(capability) ? prev.filter((item) => item !== capability) : [...prev, capability],
    );
  };

  return (
    <div className={`p-1.5 rounded-xl border ${isCoordinator ? "border-amber-400/50 ring-1 ring-amber-400/20" : color.border} ${color.bg}`}>
      <div className="flex items-center gap-1.5">
        <div className="flex flex-col -space-y-0.5">
          <button
            onClick={onMoveUp}
            disabled={isFirst || isRunning}
            className="p-0 rounded hover:bg-white/20 text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] disabled:opacity-20 disabled:cursor-not-allowed"
            title="上移"
          >
            <ChevronUp className="w-3 h-3" />
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast || isRunning}
            className="p-0 rounded hover:bg-white/20 text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] disabled:opacity-20 disabled:cursor-not-allowed"
            title="下移"
          >
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>

        <div className={`w-2 h-2 rounded-full ${color.dot} ${isRunning ? "animate-pulse" : ""} shrink-0`} />
        <span className="text-[11px] font-medium min-w-[60px]">{actor.roleName}</span>
        <span className="text-[10px] text-[var(--color-text-tertiary)] truncate max-w-[100px]">
          {actor.modelOverride || "(默认模型)"}
        </span>
        {isCoordinator && (
          <span className="text-[8px] px-1 py-0.5 rounded-full bg-amber-500/20 text-amber-600 font-medium" title="默认发送 Agent">
            默认
          </span>
        )}
        <div className="flex-1" />
        {isRunning && <Loader2 className="w-3 h-3 animate-spin opacity-50" />}

        <button
          onClick={onSetDefault}
          disabled={isCoordinator || isRunning}
          className={`p-0.5 rounded hover:bg-amber-500/10 transition-colors ${isCoordinator ? "text-amber-500 opacity-50 cursor-not-allowed" : "text-[var(--color-text-tertiary)] hover:text-amber-500"} disabled:opacity-30 disabled:cursor-not-allowed`}
          title={isCoordinator ? "已是默认发送 Agent" : "设为默认发送"}
        >
          <Star className={`w-3 h-3 ${isCoordinator ? "fill-current" : ""}`} />
        </button>

        <button
          onClick={handleOpenEdit}
          disabled={isRunning}
          className="p-0.5 rounded hover:bg-blue-500/10 text-[var(--color-text-tertiary)] hover:text-blue-500 disabled:opacity-30 disabled:cursor-not-allowed"
          title={isRunning ? "运行中，无法编辑" : "编辑配置"}
        >
          <Pencil className="w-3 h-3" />
        </button>

        <button
          onClick={onRemove}
          disabled={isRunning}
          className="p-0.5 rounded hover:bg-red-500/10 text-[var(--color-text-tertiary)] hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
          title={isRunning ? "运行中，无法移除" : "移除此 Agent"}
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
          {summarizeToolPolicy(actor.toolPolicy)}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
          {executionPolicySummary}
        </span>
        {middlewareSummary && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
            {middlewareSummary}
          </span>
        )}
        {actor.workspace && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
            工作区 {actor.workspace}
          </span>
        )}
        {actor.thinkingLevel && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
            思考 {actor.thinkingLevel}
          </span>
        )}
        {timeoutSummary && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg)]/80 text-[var(--color-text-secondary)]">
            {timeoutSummary}
          </span>
        )}
      </div>

      {editing && (
        <div className="mt-2 p-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] space-y-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder="名称"
              className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] w-[96px]"
            />
            <select
              value={editModel}
              onChange={(event) => setEditModel(event.target.value)}
              className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] min-w-[108px] max-w-[160px]"
            >
              <option value="">(默认模型)</option>
              {models.map((model) => (
                <option key={model.id} value={model.model}>{model.name}</option>
              ))}
            </select>
            <input
              value={editWorkspace}
              onChange={(event) => setEditWorkspace(event.target.value)}
              placeholder="工作目录"
              className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] w-[120px]"
            />
            <select
              value={editThinking}
              onChange={(event) => setEditThinking(event.target.value as ThinkingLevel)}
              className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>思考 {level}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowCapMenu((prev) => !prev)}
                className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] flex items-center gap-1 hover:bg-[var(--color-bg-hover)]"
              >
                <span className="text-[var(--color-text-tertiary)]">能力:</span>
                {editCaps.length > 0 ? (
                  <span className="text-[var(--color-accent)]">{editCaps.length}</span>
                ) : (
                  <span className="text-[var(--color-text-tertiary)]">选择</span>
                )}
              </button>
              {showCapMenu && (
                <div className="absolute top-full mt-1 left-0 w-48 max-h-32 overflow-auto bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl z-50 p-1">
                  {ALL_CAPABILITIES.map((capability) => (
                    <label
                      key={capability.value}
                      className="flex items-center gap-1.5 px-2 py-1 text-[10px] hover:bg-[var(--color-bg-hover)] cursor-pointer rounded"
                    >
                      <input
                        type="checkbox"
                        checked={editCaps.includes(capability.value)}
                        onChange={() => toggleCap(capability.value)}
                        className="w-3 h-3 rounded"
                      />
                      <span>{capability.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <select
              value={editAccessMode}
              onChange={(event) => setEditAccessMode(event.target.value as AccessMode)}
              className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              {ACCESS_MODE_OPTIONS.map((mode) => (
                <option key={mode.value} value={mode.value}>访问 {mode.label}</option>
              ))}
            </select>
            <select
              value={editApprovalMode}
              onChange={(event) => setEditApprovalMode(event.target.value as ApprovalMode)}
              className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              {APPROVAL_MODE_OPTIONS.map((mode) => (
                <option key={mode.value} value={mode.value}>审批 {mode.label}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5 md:grid-cols-2">
            <input
              value={editToolAllow}
              onChange={(event) => setEditToolAllow(event.target.value)}
              placeholder="允许工具，逗号分隔"
              className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
            />
            <input
              value={editToolDeny}
              onChange={(event) => setEditToolDeny(event.target.value)}
              placeholder="禁止工具，逗号分隔"
              className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
            />
            <input
              value={editDisabledMiddlewares}
              onChange={(event) => setEditDisabledMiddlewares(event.target.value)}
              placeholder="关闭中间件，逗号分隔"
              className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] md:col-span-2"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex-1" />
            <button
              onClick={() => setEditing(false)}
              className="px-2 py-1 text-[10px] rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-0.5 px-2 py-1 text-[10px] rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
            >
              <Check className="w-3 h-3" /> 保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function normalizeAgentCapabilities(tags?: string[]): AgentCapability[] | undefined {
  if (!tags?.length) return undefined;
  const normalized = tags.filter((tag): tag is AgentCapability =>
    AGENT_CAPABILITY_SET.has(tag as AgentCapability),
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function AddAgentForm({
  models,
  existingNames,
  onAdd,
}: {
  models: ModelOption[];
  existingNames: string[];
  onAdd: (draft: AddActorDraft) => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [selectedCaps, setSelectedCaps] = useState<AgentCapability[]>([]);
  const [showCapMenu, setShowCapMenu] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [toolAllow, setToolAllow] = useState("");
  const [toolDeny, setToolDeny] = useState("");
  const [accessMode, setAccessMode] = useState<AccessMode>(DEFAULT_ACCESS_MODE);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(DEFAULT_APPROVAL_MODE);
  const [disabledMiddlewares, setDisabledMiddlewares] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("adaptive");

  const handleAdd = () => {
    const trimmed = name.trim();
    let agentName = trimmed;

    if (!agentName) {
      const taken = new Set(existingNames);
      let index = 1;
      while (taken.has(`Agent ${index}`)) index += 1;
      agentName = `Agent ${index}`;
    }

    const capabilities = selectedCaps.length > 0 ? { tags: selectedCaps } : undefined;
    const allow = parseCommaSeparatedInput(toolAllow);
    const deny = parseCommaSeparatedInput(toolDeny);
    const disabled = parseCommaSeparatedInput(disabledMiddlewares);
    const executionPolicy: ExecutionPolicy = {
      accessMode,
      approvalMode,
    };
    onAdd({
      name: agentName,
      model,
      capabilities,
      workspace: workspace.trim() || undefined,
      toolPolicy: allow.length > 0 || deny.length > 0
        ? {
            allow: allow.length > 0 ? allow : undefined,
            deny: deny.length > 0 ? deny : undefined,
          }
        : undefined,
      executionPolicy,
      middlewareOverrides: buildMiddlewareOverridesForExecutionPolicy(
        executionPolicy,
        disabled.length > 0 ? { disable: disabled } : undefined,
      ),
      thinkingLevel: thinkingLevel !== "adaptive" ? thinkingLevel : undefined,
    });
    setName("");
    setModel("");
    setSelectedCaps([]);
    setWorkspace("");
    setToolAllow("");
    setToolDeny("");
    setAccessMode(DEFAULT_ACCESS_MODE);
    setApprovalMode(DEFAULT_APPROVAL_MODE);
    setDisabledMiddlewares("");
    setThinkingLevel("adaptive");
  };

  const toggleCap = (capability: AgentCapability) => {
    setSelectedCaps((prev) =>
      prev.includes(capability) ? prev.filter((item) => item !== capability) : [...prev, capability],
    );
  };

  return (
    <div className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="名称 (可选)"
          className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] w-[96px]"
        />
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] min-w-[108px] max-w-[160px]"
        >
          <option value="">(默认模型)</option>
          {models.map((item) => (
            <option key={item.id} value={item.model}>{item.name}</option>
          ))}
        </select>
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowCapMenu((prev) => !prev)}
            className="text-[10px] px-1.5 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] flex items-center gap-1 hover:bg-[var(--color-bg-hover)]"
          >
            <span className="text-[var(--color-text-tertiary)]">能力:</span>
            {selectedCaps.length > 0 ? (
              <span className="text-[var(--color-accent)]">{selectedCaps.length}</span>
            ) : (
              <span className="text-[var(--color-text-tertiary)]">选择</span>
            )}
          </button>
          {showCapMenu && (
            <div className="absolute top-full mt-1 left-0 w-48 max-h-32 overflow-auto bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl z-50 p-1">
              {ALL_CAPABILITIES.map((capability) => (
                <label
                  key={capability.value}
                  className="flex items-center gap-1.5 px-2 py-1 text-[10px] hover:bg-[var(--color-bg-hover)] cursor-pointer rounded"
                >
                  <input
                    type="checkbox"
                    checked={selectedCaps.includes(capability.value)}
                    onChange={() => toggleCap(capability.value)}
                    className="w-3 h-3 rounded"
                  />
                  <span>{capability.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowAdvanced((prev) => !prev)}
          className="text-[10px] px-1.5 py-1 rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]/40"
        >
          {showAdvanced ? "收起高级" : "高级配置"}
        </button>
        <button
          onClick={handleAdd}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
        >
          <Plus className="w-3 h-3" /> 添加
        </button>
      </div>
      {showAdvanced && (
        <div className="grid gap-1.5 md:grid-cols-2">
          <input
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            placeholder="工作目录，如 /project/root"
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <select
            value={accessMode}
            onChange={(event) => setAccessMode(event.target.value as AccessMode)}
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            {ACCESS_MODE_OPTIONS.map((mode) => (
              <option key={mode.value} value={mode.value}>访问 {mode.label}</option>
            ))}
          </select>
          <select
            value={approvalMode}
            onChange={(event) => setApprovalMode(event.target.value as ApprovalMode)}
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            {APPROVAL_MODE_OPTIONS.map((mode) => (
              <option key={mode.value} value={mode.value}>审批 {mode.label}</option>
            ))}
          </select>
          <input
            value={toolAllow}
            onChange={(event) => setToolAllow(event.target.value)}
            placeholder="允许工具，逗号分隔"
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <input
            value={toolDeny}
            onChange={(event) => setToolDeny(event.target.value)}
            placeholder="禁止工具，逗号分隔"
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <input
            value={disabledMiddlewares}
            onChange={(event) => setDisabledMiddlewares(event.target.value)}
            placeholder="关闭中间件，逗号分隔"
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          />
          <select
            value={thinkingLevel}
            onChange={(event) => setThinkingLevel(event.target.value as ThinkingLevel)}
            className="text-[10px] px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>思考 {level}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

export const ROUTING_MODES = [
  { value: "coordinator" as const, icon: "👤", label: "自动协作", desc: "默认交给主代理，必要时再临时创建子代理" },
  { value: "smart" as const, icon: "⚡", label: "定向路由", desc: "自动选择最合适的现有 Agent" },
  { value: "broadcast" as const, icon: "📢", label: "并行讨论", desc: "把同一条消息发给所有 Agent" },
];

export function RoutingModeButton({
  value,
  onChange,
}: {
  value: "coordinator" | "smart" | "broadcast";
  onChange: (value: "coordinator" | "smart" | "broadcast") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = ROUTING_MODES.find((mode) => mode.value === value) ?? ROUTING_MODES[0];

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/30 hover:text-[var(--color-text)] transition-colors"
      >
        <span>{current.icon}</span>
        <span>{current.label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 w-52 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl shadow-xl overflow-hidden z-50">
          <div className="py-1">
            {ROUTING_MODES.map((mode) => (
              <button
                key={mode.value}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--color-bg-hover)] transition-colors text-left ${
                  mode.value === value ? "bg-[var(--color-accent)]/5 text-[var(--color-accent)]" : ""
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(mode.value);
                  setOpen(false);
                }}
              >
                <span className="text-sm">{mode.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{mode.label}</div>
                  <div className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5">{mode.desc}</div>
                </div>
                {mode.value === value && (
                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] shrink-0" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
