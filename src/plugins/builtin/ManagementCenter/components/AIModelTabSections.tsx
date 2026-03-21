import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Radio,
  Save,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";

import { useRAGStore } from "@/store/rag-store";
import { useTeamStore } from "@/store/team-store";
import { api } from "@/core/api/client";
import { primeTeamModelCache } from "@/core/ai/router";
import { handleError } from "@/core/errors";
import { maskApiKey } from "@/utils/mask";
import type { OwnKeyModelConfig } from "@/core/ai/types";
import {
  TRUST_LEVEL_OPTIONS,
  useToolTrustStore,
  type TrustLevel,
} from "@/store/command-allowlist-store";

export const AI_MODEL_TAB_BRAND = "#F28F36";

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function Toggle({
  checked,
  onChange,
  color = AI_MODEL_TAB_BRAND,
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

export function ScopePills({ items }: { items: string[] }) {
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

interface TeamModelInfo {
  config_id: string;
  display_name: string;
  model_name: string;
  protocol: string;
  priority: number;
}

export interface ContainerRuntimeAvailability {
  available: boolean;
  runtime: "docker";
  message: string;
}

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

const TRUST_LEVEL_ICONS: Record<TrustLevel, React.ReactNode> = {
  always_ask: <ShieldCheck className="w-3.5 h-3.5 text-green-500" />,
  auto_approve_file: <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />,
  auto_approve: <ShieldOff className="w-3.5 h-3.5 text-red-500" />,
};

export function TrustLevelSelector() {
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
      ocrBaseUrl,
      ocrToken,
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

export function OwnKeySection({
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
            style={{ color: AI_MODEL_TAB_BRAND, background: `${AI_MODEL_TAB_BRAND}10` }}
          >
            <Plus className="w-3 h-3" />
            添加
          </button>
        )}
      </div>

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
                  <Cpu className="w-3.5 h-3.5" style={{ color: isActive ? AI_MODEL_TAB_BRAND : "var(--color-text-secondary)" }} />
                  <div>
                    <div className="text-xs font-medium flex items-center gap-1.5">
                      {k.name || k.model}
                      {isActive && (
                        <Check className="w-3 h-3" style={{ color: AI_MODEL_TAB_BRAND }} />
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

export function TeamSourceSection({
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

      <div className="flex items-center gap-2">
        <select
          value={teamId || ""}
          onChange={(e) => onTeamChange(e.target.value)}
          className="flex-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg py-1.5 px-2.5 text-xs outline-none focus:ring-2 focus:ring-[#F28F36]/20"
        >
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <button
          onClick={handleReload}
          className="px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          {reloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "刷新"}
        </button>
      </div>

      {!loaded && (
        <div className="text-[10px] text-[var(--color-text-secondary)]">正在加载团队列表...</div>
      )}

      {loadError && (
        <div className="text-[10px] text-red-500 bg-red-500/5 rounded-lg px-3 py-2 border border-red-500/10">
          团队列表加载失败：{loadError}
        </div>
      )}

      {teamId && (
        <div className="space-y-2">
          {loadingModels ? (
            <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              正在加载团队模型...
            </div>
          ) : models.length > 0 ? (
            <div className="space-y-1.5">
              {models.map((item) => {
                const selected = teamConfigId === item.config_id || (!teamConfigId && model === item.model_name);
                return (
                  <button
                    key={item.config_id}
                    onClick={() => onTeamModelResolved({
                      team_config_id: item.config_id,
                      model: item.model_name,
                      protocol: item.protocol === "anthropic" ? "anthropic" : "openai",
                    })}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors text-xs ${
                      selected
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5"
                        : "border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]"
                    }`}
                  >
                    <Cpu className="w-3.5 h-3.5" style={{ color: AI_MODEL_TAB_BRAND }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={selected ? "font-medium text-[var(--color-accent)]" : "text-[var(--color-text)]"}>
                          {item.display_name || item.model_name}
                        </span>
                        {selected && <Check className="w-3 h-3 text-[var(--color-accent)]" />}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-secondary)]">
                        {item.model_name}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              当前团队还没有可用模型，请先在团队后台完成配置。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
