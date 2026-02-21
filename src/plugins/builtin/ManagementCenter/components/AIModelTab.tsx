import { useState, useEffect, type CSSProperties } from "react";
import { useAIStore } from "@/store/ai-store";
import { useRAGStore } from "@/store/rag-store";
import type { OwnKeyModelConfig } from "@/core/ai/types";
import { useTeamStore } from "@/store/team-store";
import { api } from "@/core/api/client";
import { handleError } from "@/core/errors";
import { maskApiKey } from "@/utils/mask";
import {
  Zap,
  Shield,
  Key,
  ShieldAlert,
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
} from "lucide-react";

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

// ── 团队模型信息 ──
interface TeamModelInfo {
  config_id: string;
  display_name: string;
  model_name: string;
  protocol: string;
  priority: number;
}

type AIModelSource = "own_key" | "team" | "platform";

export function AIModelTab() {
  const { config, setConfig, saveConfig, ownKeys, loadOwnKeys, saveOwnKeys, selectOwnKeyModel } =
    useAIStore();
  const promptRingStyle: CSSProperties & Record<"--tw-ring-color", string> = {
    "--tw-ring-color": `${BRAND}30`,
  };

  useEffect(() => {
    loadOwnKeys();
  }, [loadOwnKeys]);

  const handleSourceChange = (source: AIModelSource) => {
    const newConfig = { ...config, source };
    setConfig(newConfig);
    saveConfig(newConfig);
  };

  const updateAndSave = (partial: Partial<typeof config>) => {
    const newConfig = { ...config, ...partial };
    setConfig(newConfig);
    saveConfig(newConfig);
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
      description: "使用 mTools 提供的平台模型服务，消耗能量额度。",
    },
  ];

  return (
    <div className="max-w-xl mx-auto space-y-[var(--space-compact-3)]">
      <div>
        <h2 className="text-sm font-semibold">AI 模型来源配置</h2>
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
          根据需要选择不同的 AI 模型来源，每个模型可独立配置。
        </p>
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

      {/* 自有 Key 配置区域 */}
      {config.source === "own_key" && (
        <OwnKeySection
          ownKeys={ownKeys}
          activeId={config.active_own_key_id}
          onSave={saveOwnKeys}
          onSelect={selectOwnKeyModel}
        />
      )}

      {/* 团队共享区域 */}
      {config.source === "team" && (
        <TeamSourceSection
          teamId={config.team_id}
          onTeamChange={(teamId) =>
            updateAndSave({ team_id: teamId, team_config_id: undefined })
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
            当前来源由 mTools
            服务器集中管理。您的请求将通过服务器中转以实现计费或共享 Key 使用。
          </p>
        </div>
      )}

       {/* Embedding API 配置 */}
       {config.source === "own_key" && (
        <EmbeddingConfigSection />
      )}

      {/* 高级工具 */}
      <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] space-y-[var(--space-compact-2)]">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-xs font-semibold">高级工具</span>
        </div>

        <label className="flex items-center justify-between cursor-pointer">
          <div className="flex-1 pr-3">
            <span className="text-xs text-[var(--color-text)]">
              启用高级工具
            </span>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              开启后 AI 可执行 shell
              命令、读写本地文件、获取系统信息等。危险操作会弹窗确认。
            </p>
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
            已启用高级工具：执行命令、读写文件、列出目录、获取系统信息、打开网址、打开文件/目录、获取进程列表。其中执行命令、写入文件、打开路径为危险操作，执行前需要你确认。
          </div>
        )}

        <label className="flex items-center justify-between cursor-pointer">
          <div className="flex-1 pr-3">
            <div className="flex items-center gap-1.5">
              <Smartphone className="w-3 h-3 text-emerald-400" />
              <span className="text-xs text-[var(--color-text)]">
                本机原生应用工具
              </span>
            </div>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              开启后 AI 可调用日历、提醒事项、备忘录、邮件、快捷指令、打开应用等本机能力。
            </p>
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

        <label className="flex items-center justify-between cursor-pointer">
          <div className="flex-1 pr-3">
            <div className="flex items-center gap-1.5">
              <BookOpen className="w-3 h-3 text-indigo-400" />
              <span className="text-xs text-[var(--color-text)]">
                对话时自动检索知识库
              </span>
            </div>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              开启后，每次对话会自动从 RAG
              知识库中检索相关内容并注入上下文，提升回答准确性。
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
      </div>

      {/* 自定义系统提示词 */}
      <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] space-y-2">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-xs font-semibold">自定义系统提示词</span>
        </div>
        <textarea
          className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border-0 focus:ring-2 resize-none min-h-[80px] max-h-[160px] leading-relaxed"
          style={promptRingStyle}
          value={config.system_prompt}
          onChange={(e) =>
            setConfig({ ...config, system_prompt: e.target.value })
          }
          onBlur={() => saveConfig(config)}
          placeholder="可选。在默认系统提示词之后追加你自己的指令，例如「回答风格偏口语化」「回答末尾附上英文翻译」等..."
        />
        <p className="text-[10px] text-[var(--color-text-secondary)]">
          留空则使用默认提示词；填写后会追加到默认提示词之后
        </p>
      </div>
    </div>
  );
}

// ── Embedding API 配置（知识库向量化专用） ──

export function EmbeddingConfigSection() {
  const { config: ragConfig, updateConfig } = useRAGStore();
  const [embBaseUrl, setEmbBaseUrl] = useState(ragConfig.embeddingBaseUrl || "");
  const [embApiKey, setEmbApiKey] = useState(ragConfig.embeddingApiKey || "");
  const [embModel, setEmbModel] = useState(ragConfig.embeddingModel || "text-embedding-3-small");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const nextBaseUrl = ragConfig.embeddingBaseUrl || "";
    const nextApiKey = ragConfig.embeddingApiKey || "";
    const nextModel = ragConfig.embeddingModel || "text-embedding-3-small";
    queueMicrotask(() => {
      setEmbBaseUrl(nextBaseUrl);
      setEmbApiKey(nextApiKey);
      setEmbModel(nextModel);
    });
  }, [ragConfig.embeddingBaseUrl, ragConfig.embeddingApiKey, ragConfig.embeddingModel]);

  const handleSave = async () => {
    await updateConfig({
      embeddingBaseUrl: embBaseUrl,
      embeddingApiKey: embApiKey,
      embeddingModel: embModel,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="bg-[var(--color-bg)] rounded-xl p-[var(--space-compact-3)] border border-[var(--color-border)] space-y-[var(--space-compact-2)]">
      <div className="flex items-center gap-2">
        <Database className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-xs font-semibold">Embedding API 配置</span>
      </div>
      <p className="text-[10px] text-[var(--color-text-secondary)]">
        知识库导入需要调用 Embedding API 生成向量。若你的聊天 API 提供商不支持 /embeddings 端点，可在此单独配置。留空则复用上方 AI 模型的地址和密钥。
      </p>

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

      <button
        onClick={handleSave}
        className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded-lg transition-colors font-semibold"
        style={{
          background: saved ? "#10b98120" : "#10b98115",
          color: saved ? "#10b981" : "#34d399",
        }}
      >
        {saved ? <Check className="w-3 h-3" /> : <Save className="w-3 h-3" />}
        {saved ? "已保存" : "保存 Embedding 配置"}
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
  onTeamChange,
}: {
  teamId?: string;
  onTeamChange: (teamId: string) => void;
}) {
  const { teams, loadTeams, loaded } = useTeamStore();
  const [models, setModels] = useState<TeamModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    if (!loaded) loadTeams();
  }, [loaded, loadTeams]);

  // 自动选中第一个团队
  useEffect(() => {
    if (loaded && teams.length > 0 && !teamId) {
      onTeamChange(teams[0].id);
    }
  }, [loaded, teams, teamId, onTeamChange]);

  // 加载团队模型
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;

    const loadTeamModels = async () => {
      setLoadingModels(true);
      try {
        const res = await api.get<{ models: TeamModelInfo[] }>(
          `/teams/${teamId}/ai-models`,
        );
        if (!cancelled) {
          setModels(res.models || []);
        }
      } catch (err) {
        if (!cancelled) {
          handleError(err, { context: "获取团队模型" });
        }
      } finally {
        if (!cancelled) {
          setLoadingModels(false);
        }
      }
    };

    queueMicrotask(() => {
      void loadTeamModels();
    });

    return () => {
      cancelled = true;
    };
  }, [teamId]);

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
          <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
            选择团队
          </label>
          <div className="relative mt-1">
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
        </div>
      ) : (
        <div className="text-center py-4">
          <Users className="w-5 h-5 mx-auto mb-1.5 text-[var(--color-text-secondary)] opacity-40" />
          <p className="text-[10px] text-[var(--color-text-secondary)]">
            您还没有加入任何团队。请先在「团队」标签页创建或加入一个团队。
          </p>
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
