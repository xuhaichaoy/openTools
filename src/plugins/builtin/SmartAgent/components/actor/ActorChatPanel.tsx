import React, { useState, useCallback, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import {
  Users,
  Square,
  Loader2,
  Plus,
  Trash2,
  Send,
  Settings2,
  Bot,
  User,
  X,
  Reply,
  ChevronDown,
  FileDown,
  FolderOpen,
  RotateCcw,
  ListChecks,
  Network,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useActorSystemStore, type ActorSnapshot } from "@/store/actor-system-store";
import { useAIStore } from "@/store/ai-store";
import { useTeamStore } from "@/store/team-store";
import { api } from "@/core/api/client";
import { DIALOG_FULL_ROLE } from "@/core/agent/actor/agent-actor";
import type { AgentCapability, AgentCapabilities, DialogMessage } from "@/core/agent/actor/types";
import { DIALOG_PRESETS, loadCustomPresets, saveCustomPreset, deleteCustomPreset, exportCustomPresets, importCustomPresets, type DialogPreset } from "@/core/agent/actor/dialog-presets";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { useInputAttachments, FILE_ACCEPT_ALL } from "@/hooks/use-input-attachments";
import { AttachDropdown } from "@/components/ui/AttachDropdown";

const TaskCenterPanel = lazy(() => import("../TaskCenterPanel"));
const KnowledgeGraphView = lazy(() => import("../KnowledgeGraphView"));

type DialogOverlay = "tasks" | "graph" | null;

function basename(path: unknown): string {
  const s = String(path ?? "");
  return s.split("/").pop() || s;
}

function describeAgentActivity(steps: AgentStep[], roleName: string, hasStreamingContent: boolean): string {
  if (hasStreamingContent) return "正在生成回复";

  const latest = steps[steps.length - 1];
  if (!latest) return `${roleName} 正在思考`;

  if (latest.type === "action" && latest.toolName) {
    const input = latest.toolInput ?? {};
    switch (latest.toolName) {
      case "read_file":
      case "read_file_range":
        return `读取 ${basename(input.path)}`;
      case "list_directory":
        return `浏览目录 ${basename(input.path)}`;
      case "search_in_files":
        return `搜索 "${String(input.query ?? "").slice(0, 30)}"`;
      case "write_file":
        return `写入 ${basename(input.path)}`;
      case "str_replace_edit":
        return `编辑 ${basename(input.path)}`;
      case "json_edit":
        return `编辑 ${basename(input.path)}`;
      case "run_shell_command":
      case "persistent_shell":
        return `执行 ${String(input.command ?? "").slice(0, 40)}`;
      case "web_search":
        return `搜索 "${String(input.query ?? "").slice(0, 30)}"`;
      case "web_fetch":
        return `访问 ${String(input.url ?? "").replace(/^https?:\/\//, "").slice(0, 35)}`;
      case "sequential_thinking":
        return `推理分析中`;
      case "ckg_search_function":
      case "ckg_search_class":
      case "ckg_search_class_method":
        return `查找 ${String(input.name ?? "")}`;
      case "run_lint":
        return `检查代码`;
      case "ask_user":
        return `等待用户回答`;
      case "task_done":
        return `任务完成`;
      default:
        return `${latest.toolName}`;
    }
  }

  if (latest.type === "observation") {
    const prevAction = [...steps].reverse().find((s) => s.type === "action");
    if (prevAction?.toolName) {
      const name = prevAction.toolName;
      if (name === "read_file" || name === "read_file_range")
        return `已读取 ${basename(prevAction.toolInput?.path)}，分析中`;
      if (name === "search_in_files")
        return `搜索完成，分析结果`;
      if (name === "run_shell_command" || name === "persistent_shell")
        return `命令执行完成，分析输出`;
      return `${name} 完成，继续处理`;
    }
    return `处理结果中`;
  }

  if (latest.type === "thought") {
    const text = latest.content.replace(/\n/g, " ").trim();
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
  }

  if (latest.type === "answer") return "生成回复中";
  if (latest.type === "error") return "遇到错误，处理中";

  return `${roleName} 正在思考`;
}

const ACTOR_COLORS = [
  { bg: "bg-blue-500/10", text: "text-blue-600", border: "border-blue-500/20", dot: "bg-blue-500" },
  { bg: "bg-purple-500/10", text: "text-purple-600", border: "border-purple-500/20", dot: "bg-purple-500" },
  { bg: "bg-emerald-500/10", text: "text-emerald-600", border: "border-emerald-500/20", dot: "bg-emerald-500" },
  { bg: "bg-amber-500/10", text: "text-amber-600", border: "border-amber-500/20", dot: "bg-amber-500" },
  { bg: "bg-rose-500/10", text: "text-rose-600", border: "border-rose-500/20", dot: "bg-rose-500" },
  { bg: "bg-cyan-500/10", text: "text-cyan-600", border: "border-cyan-500/20", dot: "bg-cyan-500" },
];

function getActorColor(index: number) {
  return ACTOR_COLORS[index % ACTOR_COLORS.length];
}

const generateId = () =>
  Math.random().toString(36).substring(2, 8);

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

const FILE_PATH_REGEX = /(?:\/[\w.\-/]+\.(?:xlsx|csv|pdf|docx|pptx|xls))/g;

function FileActionButtons({ content }: { content: string }) {
  const paths = content.match(FILE_PATH_REGEX);
  if (!paths?.length) return null;

  const unique = [...new Set(paths)];

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {unique.map((filePath) => {
        const fileName = filePath.replace(/^.*[/\\]/, "");
        return (
          <div key={filePath} className="flex items-center gap-1 text-[11px]">
            <button
              onClick={() => {
                void invoke("open_file_location", { filePath });
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
              title={filePath}
            >
              <FolderOpen className="w-3 h-3" />
              <span className="max-w-[120px] truncate">{fileName}</span>
            </button>
            <button
              onClick={async () => {
                try {
                  const { save } = await import("@tauri-apps/plugin-dialog");
                  const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
                  const dest = await save({ defaultPath: fileName });
                  if (dest) {
                    const data = await readFile(filePath);
                    await writeFile(dest, data);
                  }
                } catch (err) {
                  if (err && typeof err === "object" && "message" in err && /cancel/i.test(String((err as Error).message))) return;
                  console.warn("[ActorChatPanel] File save failed:", err);
                }
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--color-accent)]/10 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 transition-colors"
              title="另存为..."
            >
              <FileDown className="w-3 h-3" />
              下载
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Models Hook ──

interface ModelOption {
  id: string;
  name: string;
  model: string;
}

function useAvailableModels(): ModelOption[] {
  const config = useAIStore((s) => s.config);
  const ownKeys = useAIStore((s) => s.ownKeys);
  const { teams, loaded: teamsLoaded, loadTeams } = useTeamStore();
  const [teamModels, setTeamModels] = useState<ModelOption[]>([]);
  const source = config.source || "own_key";

  useEffect(() => {
    if (source === "team" && !teamsLoaded) void loadTeams();
  }, [source, teamsLoaded, loadTeams]);

  useEffect(() => {
    if (source !== "team" || !config.team_id) { setTeamModels([]); return; }
    if (!teamsLoaded || !teams.some((t) => t.id === config.team_id)) return;
    let cancelled = false;
    api
      .get<{ models: { config_id: string; display_name: string; model_name: string }[] }>(
        `/teams/${config.team_id}/ai-models`,
      )
      .then((res) => {
        if (!cancelled) setTeamModels((res.models || []).map((m) => ({ id: m.config_id, name: m.display_name, model: m.model_name })));
      })
      .catch((err) => { if (!cancelled) { console.warn("[ActorChatPanel] Failed to load team models:", err); setTeamModels([]); } });
    return () => { cancelled = true; };
  }, [source, config.team_id, teamsLoaded, teams]);

  if (source === "team") return teamModels;
  return ownKeys.map((k) => ({ id: k.id, name: k.name, model: k.model }));
}

// ── Message Bubble ──

interface MessageBubbleProps {
  message: DialogMessage;
  actorIndex: number;
  actorName: string;
  targetName?: string;
  isUser: boolean;
  isWaitingReply?: boolean;
}

function MessageBubbleBase({
  message,
  actorIndex,
  actorName,
  targetName,
  isUser,
  isWaitingReply,
}: MessageBubbleProps) {
  const [showFullContext, setShowFullContext] = useState(false);
  const color = isUser ? null : getActorColor(actorIndex);
  const hasBrief = isUser && !!message._briefContent && message._briefContent !== message.content;
  const displayText = hasBrief && !showFullContext ? message._briefContent! : message.content;
  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
        isUser
          ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          : `${color!.bg} ${color!.text}`
      }`}>
        {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
      </div>
      <div className={`max-w-[80%] min-w-0 ${isUser ? "text-right" : ""}`}>
        <div className={`text-[10px] mb-0.5 ${isUser ? "text-[var(--color-accent)]" : color!.text}`}>
          {actorName}
          {targetName && (
            <span className="text-[var(--color-text-tertiary)] ml-1">
              → {targetName}
            </span>
          )}
          <span className="text-[var(--color-text-tertiary)] ml-1">
            {new Date(message.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
        <div className={`inline-block text-[13px] leading-relaxed rounded-xl px-3 py-2 max-w-full ${
          isUser
            ? "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
            : `${color!.bg} text-[var(--color-text)]`
        }`}>
          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_code]:break-words">
            <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
              {displayText}
            </ReactMarkdown>
          </div>
          {hasBrief && (
            <button
              onClick={() => setShowFullContext((v) => !v)}
              className="mt-1 text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] flex items-center gap-0.5 ml-auto transition-colors"
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${showFullContext ? "rotate-180" : ""}`} />
              {showFullContext ? "收起上下文" : "查看完整上下文"}
            </button>
          )}
          {!isUser && <FileActionButtons content={message.content} />}
        </div>
        {isWaitingReply && (
          <div className="flex items-center gap-1 mt-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 animate-pulse">
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
            等待你的回复...
          </div>
        )}
      </div>
    </div>
  );
}

const MessageBubble = React.memo(
  MessageBubbleBase,
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message._briefContent === next.message._briefContent &&
    prev.message.timestamp === next.message.timestamp &&
    prev.actorIndex === next.actorIndex &&
    prev.actorName === next.actorName &&
    prev.targetName === next.targetName &&
    prev.isUser === next.isUser &&
    prev.isWaitingReply === next.isWaitingReply,
);

// ── Capability Badge ──

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

// ── Status Bar ──

function ActorStatusBar({ actors }: { actors: ActorSnapshot[] }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {actors.map((actor, i) => {
        const color = getActorColor(i);
        const isThinking = actor.status === "running";
        return (
          <div
            key={actor.id}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] ${color.bg} ${color.text}`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${color.dot} ${isThinking ? "animate-pulse" : ""}`} />
            <span className="font-medium">{actor.roleName}</span>
            <CapabilityBadges tags={actor.capabilities?.tags} />
            {actor.modelOverride && (
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

// ── @ Mention Popup ──

function MentionPopup({
  actors,
  filter,
  onSelect,
  onClose,
}: {
  actors: ActorSnapshot[];
  filter: string;
  onSelect: (name: string) => void;
  onClose: () => void;
}) {
  const filtered = actors.filter((a) =>
    a.roleName.toLowerCase().includes(filter.toLowerCase()),
  );

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full mb-1 left-0 w-48 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50">
      <div className="py-1 max-h-[150px] overflow-y-auto">
        {filtered.map((a, i) => {
          const color = getActorColor(i);
          return (
            <button
              key={a.id}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] transition-colors text-left"
              onMouseDown={(e) => { e.preventDefault(); onSelect(a.roleName); }}
            >
              <div className={`w-2 h-2 rounded-full ${color.dot}`} />
              <span>{a.roleName}</span>
              {a.status === "running" && <Loader2 className="w-2.5 h-2.5 animate-spin opacity-50" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Live Actor Config Row (for settings panel) ──

function LiveActorRow({
  actor,
  index,
  models,
  onRemove,
}: {
  actor: ActorSnapshot;
  index: number;
  models: ModelOption[];
  onRemove: () => void;
}) {
  const color = getActorColor(index);
  const isRunning = actor.status === "running";
  return (
    <div className={`flex items-center gap-2 p-2 rounded-lg border ${color.border} ${color.bg}`}>
      <div className={`w-2 h-2 rounded-full ${color.dot} ${isRunning ? "animate-pulse" : ""} shrink-0`} />
      <span className="text-[11px] font-medium min-w-[60px]">{actor.roleName}</span>
      <span className="text-[10px] text-[var(--color-text-tertiary)] truncate max-w-[140px]">
        {actor.modelOverride || "(默认模型)"}
      </span>
      <div className="flex-1" />
      {isRunning && <Loader2 className="w-3 h-3 animate-spin opacity-50" />}
      <button
        onClick={onRemove}
        disabled={isRunning}
        className="p-0.5 rounded hover:bg-red-500/10 text-[var(--color-text-tertiary)] hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
        title={isRunning ? "运行中，无法移除" : "移除此 Agent"}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── Add Agent Inline Form ──

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
];

const AGENT_CAPABILITY_SET = new Set<AgentCapability>(ALL_CAPABILITIES.map((c) => c.value));

function normalizeAgentCapabilities(tags?: string[]): AgentCapability[] | undefined {
  if (!tags?.length) return undefined;
  const normalized = tags.filter((tag): tag is AgentCapability =>
    AGENT_CAPABILITY_SET.has(tag as AgentCapability),
  );
  return normalized.length ? normalized : undefined;
}

function AddAgentForm({
  models,
  existingNames,
  onAdd,
}: {
  models: ModelOption[];
  existingNames: string[];
  onAdd: (name: string, model: string, systemPrompt?: string, capabilities?: AgentCapabilities) => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [selectedCaps, setSelectedCaps] = useState<AgentCapability[]>([]);
  const [showCapMenu, setShowCapMenu] = useState(false);

  const handleAdd = () => {
    const trimmed = name.trim();
    let agentName = trimmed;

    // 如果未填写名称，则根据现有 Agent 生成不重名的默认名称：Agent 1, Agent 2, ...
    if (!agentName) {
      const taken = new Set(existingNames);
      let index = 1;
      while (taken.has(`Agent ${index}`)) {
        index += 1;
      }
      agentName = `Agent ${index}`;
    }

    const capabilities = selectedCaps.length > 0 ? { tags: selectedCaps } : undefined;
    onAdd(agentName, model, undefined, capabilities);
    setName("");
    setModel("");
    setSelectedCaps([]);
  };

  const toggleCap = (cap: AgentCapability) => {
    setSelectedCaps((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]
    );
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="名称 (可选)"
        className="text-[11px] px-1.5 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] w-[80px]"
      />
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="text-[11px] px-1.5 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] min-w-[100px] max-w-[160px]"
      >
        <option value="">(默认模型)</option>
        {models.map((m) => (
          <option key={m.id} value={m.model}>{m.name}</option>
        ))}
      </select>
      {/* Capability selector */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowCapMenu(!showCapMenu)}
          className="text-[11px] px-1.5 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] flex items-center gap-1 hover:bg-[var(--color-bg-hover)]"
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
            {ALL_CAPABILITIES.map((cap) => (
              <label
                key={cap.value}
                className="flex items-center gap-1.5 px-2 py-1 text-[10px] hover:bg-[var(--color-bg-hover)] cursor-pointer rounded"
              >
                <input
                  type="checkbox"
                  checked={selectedCaps.includes(cap.value)}
                  onChange={() => toggleCap(cap.value)}
                  className="w-3 h-3 rounded"
                />
                <span>{cap.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={handleAdd}
        className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
      >
        <Plus className="w-3 h-3" /> 添加
      </button>
    </div>
  );
}

// ── Routing Mode Button ──

const ROUTING_MODES = [
  { value: "coordinator" as const, icon: "👤", label: "协调", desc: "消息发给第一个 Agent" },
  { value: "smart" as const, icon: "⚡", label: "智能", desc: "自动选择最合适的 Agent" },
  { value: "broadcast" as const, icon: "📢", label: "广播", desc: "消息发送给所有 Agent" },
];

function RoutingModeButton({
  value,
  onChange,
}: {
  value: "coordinator" | "smart" | "broadcast";
  onChange: (v: "coordinator" | "smart" | "broadcast") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = ROUTING_MODES.find((m) => m.value === value) ?? ROUTING_MODES[0];

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <span>{current.icon}</span>
        <span>{current.label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-52 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50">
          <div className="py-1">
            {ROUTING_MODES.map((mode) => (
              <button
                key={mode.value}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--color-bg-hover)] transition-colors text-left ${
                  mode.value === value ? "bg-[var(--color-accent)]/5 text-[var(--color-accent)]" : ""
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
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

// ── Main Panel ──

export function ActorChatPanel({ active = true }: { active?: boolean }) {
  const [showConfig, setShowConfig] = useState(false);
  const [overlay, setOverlay] = useState<DialogOverlay>(null);
  const [input, setInput] = useState("");
  const [showMention, setShowMention] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [customPresets, setCustomPresets] = useState<DialogPreset[]>([]);
  /** 路由模式：coordinator=只发给第一个，smart=智能路由，broadcast=发给所有 */
  const [routingMode, setRoutingMode] = useState<"coordinator" | "smart" | "broadcast">("coordinator");
  const [showAllMessages, setShowAllMessages] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initRef = useRef(false);

  const {
    active: systemActive, actors, dialogHistory, pendingUserReplies,
    init, spawnActor, killActor, destroyAll, sendMessage, broadcastMessage, broadcastAndResolve,
    abortAll, steer, resetSession, sync, routeTask, replyToMessage,
  } = useActorSystemStore();

  const models = useAvailableModels();

  const {
    attachments,
    imagePaths,
    fileContextBlock,
    attachmentSummary,
    hasAttachments,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleFileSelect: onFileSelect,
    handleFileSelectNative,
    handleFolderSelect,
    removeAttachment,
    clearAttachments,
  } = useInputAttachments();

  const runningActors = useMemo(() => actors.filter((a) => a.status === "running"), [actors]);
  const hasRunningActors = runningActors.length > 0;

  // Auto-init: mount 时自动创建 ActorSystem
  // - 如果本地有持久化的 Dialog 会话，则只恢复，不额外创建默认 Agent
  // - 如果没有持久化会话，则创建 2 个默认 Agent（便于并行子任务）
  const ensureSystem = useCallback(() => {
    const storeState = useActorSystemStore.getState();
    if (storeState.active) return;

    const system = init();

    // 如果恢复后已经有 Actor（来自持久化会话），只做一次 sync，不再追加默认 Agent
    const existingActors = system.getAll();
    if (existingActors.length > 0) {
      sync();
      return;
    }

    // 没有持久化会话时，创建两个默认 Agent
    spawnActor({
      id: `agent-${generateId()}`,
      role: { ...DIALOG_FULL_ROLE, name: "Agent 1" },
    });
    spawnActor({
      id: `agent-${generateId()}`,
      role: { ...DIALOG_FULL_ROLE, name: "Agent 2" },
    });
  }, [init, spawnActor, sync]);

  useEffect(() => {
    if (active && !initRef.current) {
      initRef.current = true;
      ensureSystem();
    }
  }, [active, ensureSystem]);

  // 加载自定义预设
  useEffect(() => {
    if (showConfig) {
      setCustomPresets(loadCustomPresets());
    }
  }, [showConfig]);

  const lastDialogLengthRef = useRef(0);
  useEffect(() => {
    if (dialogHistory.length > lastDialogLengthRef.current) {
      // Only auto-scroll when new messages arrive, not on re-renders
      requestAnimationFrame(() => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    }
    lastDialogLengthRef.current = dialogHistory.length;
  }, [dialogHistory.length]);

  useEffect(() => {
    if (active && systemActive) sync();
  }, [active, systemActive, sync]);

  const actorIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    actors.forEach((a, i) => map.set(a.id, i));
    return map;
  }, [actors]);

  const actorNameToId = useMemo(() => {
    const map = new Map<string, string>();
    actors.forEach((a) => map.set(a.roleName, a.id));
    return map;
  }, [actors]);

  const actorById = useMemo(() => {
    const map = new Map<string, ActorSnapshot>();
    actors.forEach((a) => map.set(a.id, a));
    return map;
  }, [actors]);

  const pendingUserReplySet = useMemo(() => new Set(pendingUserReplies), [pendingUserReplies]);

  /** Visible messages: limit DOM nodes for large conversations */
  const MESSAGE_WINDOW_SIZE = 100;
  const visibleMessages = useMemo(() => {
    if (showAllMessages || dialogHistory.length <= MESSAGE_WINDOW_SIZE) return dialogHistory;
    return dialogHistory.slice(-MESSAGE_WINDOW_SIZE);
  }, [dialogHistory, showAllMessages]);
  const messageById = useMemo(() => {
    const map = new Map<string, DialogMessage>();
    dialogHistory.forEach((m) => map.set(m.id, m));
    return map;
  }, [dialogHistory]);

  // 热添加 Agent
  const handleAddAgent = useCallback((name: string, model: string, systemPrompt?: string, capabilities?: AgentCapabilities) => {
    ensureSystem();
    spawnActor({
      id: `agent-${generateId()}`,
      role: { ...DIALOG_FULL_ROLE, name },
      modelOverride: model || undefined,
      systemPromptOverride: systemPrompt,
      capabilities,
    });
  }, [ensureSystem, spawnActor]);

  // 热移除 Agent
  const handleRemoveAgent = useCallback((actorId: string) => {
    killActor(actorId);
  }, [killActor]);

  // 应用预设：清除当前 agents，重新 spawn 预设参与者
  const handleApplyPreset = useCallback((presetId: string) => {
    const preset = [...DIALOG_PRESETS, ...customPresets].find((p) => p.id === presetId);
    if (!preset) return;
    destroyAll();
    initRef.current = false;
    init();
    for (const p of preset.participants) {
      const normalizedCaps = normalizeAgentCapabilities(p.suggestedCapabilities);
      spawnActor({
        id: `agent-${generateId()}`,
        role: { ...DIALOG_FULL_ROLE, name: p.customName },
        modelOverride: p.suggestedModel ?? undefined,
        systemPromptOverride: p.systemPromptOverride,
        capabilities: normalizedCaps ? { tags: normalizedCaps } : undefined,
      });
    }
    initRef.current = true;
    setShowConfig(false);
  }, [destroyAll, init, spawnActor, customPresets]);

  // 保存当前配置为新预设
  const handleSaveCurrentAsPreset = useCallback(() => {
    if (actors.length === 0) return;
    const name = prompt("请输入预设名称：");
    if (!name?.trim()) return;
    
    const newPreset: DialogPreset = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      description: `自定义预设 (${actors.length} 个 Agent)`,
      participants: actors.map((a) => ({
        customName: a.roleName,
        suggestedModel: a.modelOverride,
        suggestedCapabilities: a.capabilities?.tags,
        systemPromptOverride: a.systemPromptOverride || a.currentTask?.query,
      })),
    };
    saveCustomPreset(newPreset);
    setCustomPresets(loadCustomPresets());
  }, [actors]);

  const handleStop = useCallback(() => { abortAll(); }, [abortAll]);
  const handleNewTopic = useCallback(() => {
    resetSession();
  }, [resetSession]);
  const handleFullReset = useCallback(() => {
    destroyAll();
    initRef.current = false;
  }, [destroyAll]);

  const parseMention = useCallback((text: string): { targetId: string | null; cleanContent: string } => {
    if (!text.startsWith("@")) return { targetId: null, cleanContent: text };
    for (const [name, id] of actorNameToId) {
      if (text.startsWith(`@${name}`)) {
        const rest = text.slice(name.length + 1).trim();
        return { targetId: id, cleanContent: rest };
      }
    }
    return { targetId: null, cleanContent: text };
  }, [actorNameToId]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed && !hasAttachments) return;

    ensureSystem();

    const hasContext = fileContextBlock.trim().length > 0;
    const userText = trimmed || (hasContext ? "请分析以上文件内容。" : "");
    const content = hasContext
      ? `${fileContextBlock}\n\n${userText}`
      : userText;

    if (!content) return;

    const briefContent = hasContext
      ? (attachmentSummary ? `${attachmentSummary}\n${userText}` : userText)
      : undefined;

    // 如果有待回复的消息，优先回复（直接回复给最早的那条）
    if (pendingUserReplies.length > 0) {
      const messageId = pendingUserReplies[0];
      replyToMessage(messageId, content);
      setInput("");
      setShowMention(false);
      clearAttachments();
      inputRef.current?.focus();
      return;
    }

    const { targetId, cleanContent } = parseMention(trimmed);
    const finalContent = hasContext
      ? `${fileContextBlock}\n\n${cleanContent || userText}`
      : (cleanContent || content);
    const finalBrief = hasContext
      ? (attachmentSummary ? `${attachmentSummary}\n${cleanContent || userText}` : (cleanContent || userText))
      : undefined;

    if (targetId && finalContent.startsWith("!steer ")) {
      const directive = finalContent.slice(7).trim();
      if (directive) steer(targetId, directive);
    } else if (targetId) {
      sendMessage("user", targetId, finalContent, { _briefContent: finalBrief });
    } else {
      if (routingMode === "smart" && finalContent) {
        const routes = routeTask(finalContent);
        if (routes.length > 0) {
          const selectedAgent = routes[0].agentId;
          const reason = routes[0].reason;
          console.log(`[Smart Routing] "${finalContent.slice(0, 30)}..." → ${selectedAgent} (${reason})`);
          sendMessage("user", selectedAgent, finalContent, { _briefContent: finalBrief });
          setInput("");
          setShowMention(false);
          clearAttachments();
          inputRef.current?.focus();
          return;
        }
      }
      if (routingMode === "broadcast") {
        broadcastMessage("user", finalContent, { _briefContent: finalBrief });
      } else {
        broadcastAndResolve("user", finalContent, { _briefContent: finalBrief });
      }
    }

    setInput("");
    setShowMention(false);
    clearAttachments();
    inputRef.current?.focus();
  }, [input, hasAttachments, fileContextBlock, attachmentSummary, ensureSystem, parseMention, sendMessage, broadcastMessage, broadcastAndResolve, steer, pendingUserReplies, replyToMessage, routingMode, routeTask, clearAttachments]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    const lastAt = val.lastIndexOf("@");
    if (lastAt >= 0 && lastAt === val.length - 1) {
      setShowMention(true);
      setMentionFilter("");
    } else if (lastAt >= 0 && !val.slice(lastAt).includes(" ")) {
      setShowMention(true);
      setMentionFilter(val.slice(lastAt + 1));
    } else {
      setShowMention(false);
    }
  }, []);

  const handleMentionSelect = useCallback((name: string) => {
    const lastAt = input.lastIndexOf("@");
    const before = lastAt >= 0 ? input.slice(0, lastAt) : input;
    setInput(`${before}@${name} `);
    setShowMention(false);
    inputRef.current?.focus();
  }, [input]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape" && showMention) {
        setShowMention(false);
      }
    },
    [handleSend, showMention],
  );

  const pendingAgentNames = useMemo(() => {
    if (pendingUserReplies.length === 0) return "";
    const names = pendingUserReplies.map((id) => {
      const msg = messageById.get(id);
      if (!msg) return null;
      const actor = actorById.get(msg.from);
      return actor?.roleName ?? msg.from;
    }).filter(Boolean);
    return names.join("、");
  }, [pendingUserReplies, messageById, actorById]);

  // 图谱数据
  const graphData = useMemo(() => {
    if (overlay !== "graph") return null;
    try {
      const { KnowledgeGraph } = require("@/core/knowledge/knowledge-graph");
      const actorNodes = actors.map((a) => ({
        id: a.id, name: a.roleName, status: a.status, capabilities: a.capabilities?.tags,
      }));
      const spawnEvents = useActorSystemStore.getState().spawnedTaskEvents || [];
      const tasks = spawnEvents.map((e: any) => ({
        spawner: e.spawnerActorId, target: e.targetActorId, label: e.label || "", status: e.status,
      }));
      const dialog = dialogHistory.map((m) => ({ from: m.from, to: m.to }));
      return KnowledgeGraph.fromActorSystem(actorNodes, tasks, dialog);
    } catch { return { nodes: [], edges: [] }; }
  }, [overlay, actors, dialogHistory]);

  return (
    <div className="relative flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-sm font-medium">Agent Dialog</span>
          {actors.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">
              {actors.length} 个 Agent
            </span>
          )}
          {actors.length === 1 && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]" title="与 OpenClaw 一致：多 Agent 可同时执行子任务">
              点击 ⚙ 添加 Agent 可并行执行子任务
            </span>
          )}
          {actors.length >= 2 && (
            <span className="text-[10px] text-[var(--color-text-tertiary)]" title="用户消息只发给第一个 Agent（协调者）；协调者用 spawn_task 派活后，其他 Agent 才会参与">
              消息发给第一个 Agent，其他由协调者 spawn_task 激活
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowConfig(!showConfig)}
            className={`p-1 rounded transition-colors ${
              showConfig ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            }`}
            title="Agent 设置"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setOverlay(overlay === "tasks" ? null : "tasks")}
            className={`p-1 rounded transition-colors ${
              overlay === "tasks" ? "bg-blue-500/10 text-blue-500" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            }`}
            title="任务中心"
          >
            <ListChecks className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setOverlay(overlay === "graph" ? null : "graph")}
            className={`p-1 rounded transition-colors ${
              overlay === "graph" ? "bg-purple-500/10 text-purple-500" : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
            }`}
            title="知识图谱"
          >
            <Network className="w-3.5 h-3.5" />
          </button>
          {hasRunningActors && (
            <span className="mx-0.5 h-3 w-px bg-[var(--color-border)]" />
          )}
          {hasRunningActors && (
            <button onClick={handleStop} className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1">
              <Square className="w-3 h-3" /> 停止
            </button>
          )}
          <button onClick={handleNewTopic} className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] flex items-center gap-1"
            title="清空对话和 Agent 记忆，保留当前 Agent 阵容">
            <RotateCcw className="w-3 h-3" /> 新话题
          </button>
          <button onClick={handleFullReset} className="text-xs text-[var(--color-text-tertiary)] hover:text-red-500 flex items-center gap-1"
            title="销毁所有 Agent，回到初始状态">
            <Trash2 className="w-3 h-3" /> 重置
          </button>
        </div>
      </div>

      {/* Settings Panel (collapsible) */}
      {showConfig && (
        <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-3 bg-[var(--color-bg-secondary)]">
          {/* Presets */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-[var(--color-text-tertiary)]">预设:</span>
            {DIALOG_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className="text-[10px] px-2 py-1 rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
                onClick={() => handleApplyPreset(preset.id)}
                title={preset.description}
              >
                {preset.name}
              </button>
            ))}
            {customPresets.length > 0 && (
              <>
                <span className="text-[10px] text-[var(--color-text-tertiary)]">|</span>
                {customPresets.map((preset) => (
                  <button
                    key={preset.id}
                    className="text-[10px] px-2 py-1 rounded-md border border-purple-500/30 text-purple-600 hover:border-purple-500/60 hover:text-purple-500 transition-colors"
                    onClick={() => handleApplyPreset(preset.id)}
                    title={preset.description}
                  >
                    {preset.name}
                  </button>
                ))}
              </>
            )}
            <button
              onClick={handleSaveCurrentAsPreset}
              className="text-[10px] px-2 py-1 rounded-md border border-dashed border-[var(--color-border)] text-[var(--color-text-tertiary)] hover:border-green-500/40 hover:text-green-500 transition-colors"
              title="保存当前 Agent 配置为新预设"
            >
              + 保存当前
            </button>
          </div>
          {/* Live Agents */}
          <div className="text-[10px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-wider">
            当前 Agent ({actors.length})
          </div>
          <div className="space-y-2">
            {actors.map((actor, i) => (
              <LiveActorRow
                key={actor.id}
                actor={actor}
                index={i}
                models={models}
                onRemove={() => handleRemoveAgent(actor.id)}
              />
            ))}
            {actors.length === 0 && (
              <div className="text-[11px] text-[var(--color-text-tertiary)] py-1">暂无 Agent</div>
            )}
          </div>
          {/* Add Agent */}
          <AddAgentForm
            models={models}
            existingNames={actors.map((a) => a.roleName)}
            onAdd={handleAddAgent}
          />
        </div>
      )}

      {/* Status bar */}
      {!showConfig && actors.length > 0 && (
        <div className="px-4 py-2 border-b border-[var(--color-border)]">
          <ActorStatusBar actors={actors} />
        </div>
      )}

      {/* Chat Stream */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-3">
        {dialogHistory.length === 0 && (
          <div className="text-center text-[var(--color-text-secondary)] py-12">
            <Bot className="w-10 h-10 mx-auto mb-3 opacity-15" />
            <p className="text-xs opacity-60">直接输入消息开始对话，点击 ⚙ 可添加更多 Agent</p>
          </div>
        )}

        {/* Message windowing: show all when < 100, otherwise show load-more + recent */}
        {dialogHistory.length > 100 && !showAllMessages && (
          <button
            onClick={() => setShowAllMessages(true)}
            className="w-full text-center text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] py-2 transition-colors"
          >
            ↑ 加载更早的 {dialogHistory.length - 100} 条消息
          </button>
        )}

        {visibleMessages.map((msg) => {
          const isUser = msg.from === "user";
          const actorIdx = actorIdToIndex.get(msg.from) ?? 0;
          const actor = actorById.get(msg.from);
          const actorName = isUser ? "你" : (actor?.roleName ?? msg.from);
          const targetName = msg.to
            ? (msg.to === "user" ? "你" : (actorById.get(msg.to)?.roleName ?? msg.to))
            : undefined;
          const isWaiting = !isUser && msg.expectReply && pendingUserReplySet.has(msg.id);

          return (
            <div key={msg.id} className="max-w-full">
              <MessageBubble
                message={msg}
                actorIndex={actorIdx}
                actorName={actorName}
                targetName={targetName}
                isUser={isUser}
                isWaitingReply={isWaiting}
              />
            </div>
          );
        })}

        {/* Thinking indicators - 流式输出 */}
        {runningActors.map((a, i) => {
            const color = getActorColor(actorIdToIndex.get(a.id) ?? i);
            const steps = a.currentTask?.steps ?? [];

            // 找到最新的流式步骤（用于显示正在生成的内容）
            const latestStreamingStep = [...steps].reverse().find((s) => s.streaming);
            const latestStep = steps[steps.length - 1];

            // 如果有流式内容，显示在对话气泡中
            const streamingContent = latestStreamingStep?.content;

            return (
              <div key={`thinking-${a.id}`} className="space-y-2">
                {/* 流式生成的内容气泡 */}
                {streamingContent && (
                  <div className={`flex gap-2 ${color.text}`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${color.bg}`}>
                      <Bot className="w-3.5 h-3.5" />
                    </div>
                    <div className="max-w-[80%]">
                      <div className="text-[10px] mb-0.5">
                        {a.roleName}
                        <span className="text-[var(--color-text-tertiary)] ml-1">
                          正在输入中...
                        </span>
                      </div>
                      <div className={`inline-block text-[13px] leading-relaxed rounded-xl px-3 py-2 ${color.bg}`}>
                        <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1">
                          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                            {streamingContent}
                          </ReactMarkdown>
                          <span className="inline-block w-2 h-4 bg-current animate-pulse ml-0.5" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* 思考状态指示器 */}
                <div className={`flex items-center gap-2 ${color.text}`}>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span className="text-[11px] truncate max-w-[80%]">
                    <span className="font-medium">{a.roleName}</span>
                    <span className="opacity-70 ml-1">
                      {describeAgentActivity(steps, a.roleName, !!streamingContent)}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}

        <div ref={chatEndRef} />
      </div>

      {/* Input Bar — always visible */}
      <div className="px-4 py-3 border-t border-[var(--color-border)]" onDrop={handleDrop} onDragOver={handleDragOver}>
        {pendingUserReplies.length > 0 && pendingAgentNames && (
          <div className="flex items-center gap-2 mb-2 text-[10px] text-amber-600 bg-amber-500/10 rounded-lg px-2.5 py-1.5">
            <Reply className="w-3 h-3" />
            <span>{pendingAgentNames} 正在等待你的回复 — 直接发送消息即可回复</span>
          </div>
        )}
        {/* Attachment preview */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[11px]"
              >
                {att.type === "image" && att.preview ? (
                  <img src={att.preview} alt="" className="w-5 h-5 rounded object-cover" />
                ) : (
                  <span className="opacity-60">{att.type === "folder" ? "📂" : "📄"}</span>
                )}
                <span className="max-w-[100px] truncate">{att.name}</span>
                <button
                  onClick={() => removeAttachment(att.id)}
                  className="ml-0.5 p-0.5 rounded hover:bg-red-500/10 text-[var(--color-text-tertiary)] hover:text-red-500"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={FILE_ACCEPT_ALL}
          className="hidden"
          onChange={onFileSelect}
        />
        <div className="flex items-end gap-2" ref={inputWrapRef}>
          <div className="flex-1 relative bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl focus-within:ring-1 focus-within:ring-[var(--color-accent)] focus-within:border-[var(--color-accent)] transition-shadow">
            {showMention && (
              <MentionPopup
                actors={actors}
                filter={mentionFilter}
                onSelect={handleMentionSelect}
                onClose={() => setShowMention(false)}
              />
            )}
            <textarea
              ref={inputRef}
              className="w-full text-sm bg-transparent px-3 pt-2 pb-1 resize-none focus:outline-none min-h-[36px] max-h-[140px]"
              rows={1}
              placeholder={pendingUserReplies.length > 0
                ? `直接输入即可回复${pendingAgentNames || "Agent"}的提问...`
                : "输入消息... 输入 @ 可指定发送给某个 Agent"}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onBlur={() => setTimeout(() => setShowMention(false), 150)}
            />
            <div className="flex items-center px-2 pb-1.5">
              <AttachDropdown
                onFileClick={() => {
                  if ("__TAURI_INTERNALS__" in window) {
                    void handleFileSelectNative();
                  } else {
                    fileInputRef.current?.click();
                  }
                }}
                onFolderClick={handleFolderSelect}
                accent="accent"
              />
              <RoutingModeButton value={routingMode} onChange={setRoutingMode} />
            </div>
          </div>
          <button
            onClick={handleSend}
            disabled={!input.trim() && !hasAttachments}
            className="h-9 w-9 rounded-xl bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 shrink-0 flex items-center justify-center mb-0.5"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Overlay Panel — 浮层弹窗，不压缩聊天区 */}
      {overlay && (
        <>
          <div className="absolute inset-0 bg-black/20 z-30" onClick={() => setOverlay(null)} />
          <div className="absolute inset-x-4 top-14 bottom-4 z-40 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
              <span className="text-sm font-medium">
                {overlay === "tasks" && "任务中心"}
                {overlay === "graph" && "知识图谱"}
              </span>
              <button
                onClick={() => setOverlay(null)}
                className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <Suspense fallback={<div className="p-4 text-xs text-[var(--color-text-secondary)]">加载中...</div>}>
                {overlay === "tasks" && <TaskCenterPanel />}
                {overlay === "graph" && graphData && (
                  <KnowledgeGraphView data={graphData} className="h-full" />
                )}
              </Suspense>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
