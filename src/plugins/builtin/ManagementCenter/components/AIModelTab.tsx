import { useAIStore } from "@/store/ai-store";
import { Zap, Shield, Key, ShieldAlert, MessageSquare, BookOpen } from "lucide-react";

const BRAND = "#F28F36";

export function AIModelTab() {
  const { config, setConfig, saveConfig } = useAIStore();

  const handleSourceChange = (source: "own_key" | "team" | "platform") => {
    const newConfig = { ...config, source };
    setConfig(newConfig);
    saveConfig(newConfig);
  };

  const updateAndSave = (partial: Partial<typeof config>) => {
    const newConfig = { ...config, ...partial };
    setConfig(newConfig);
    saveConfig(newConfig);
  };

  const sources = [
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
    <div className="max-w-xl mx-auto space-y-4">
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
              onClick={() => handleSourceChange(src.id as any)}
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
        <div className="bg-[var(--color-bg)] rounded-xl p-4 border border-[var(--color-border)] space-y-3">
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              API 地址
            </label>
            <input
              type="text"
              value={config.base_url}
              onChange={(e) =>
                setConfig({ ...config, base_url: e.target.value })
              }
              onBlur={() => saveConfig(config)}
              placeholder="https://api.openai.com/v1"
              className="mt-1 w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs focus:ring-2 transition-all text-[var(--color-text)]"
              style={{ "--tw-ring-color": `${BRAND}30` } as any}
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              API Key
            </label>
            <input
              type="password"
              value={config.api_key}
              onChange={(e) =>
                setConfig({ ...config, api_key: e.target.value })
              }
              onBlur={() => saveConfig(config)}
              placeholder="sk-..."
              className="mt-1 w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs focus:ring-2 transition-all text-[var(--color-text)]"
              style={{ "--tw-ring-color": `${BRAND}30` } as any}
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              模型名称
            </label>
            <input
              type="text"
              value={config.model}
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
              onBlur={() => saveConfig(config)}
              placeholder="gpt-4o"
              className="mt-1 w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs focus:ring-2 transition-all text-[var(--color-text)]"
              style={{ "--tw-ring-color": `${BRAND}30` } as any}
            />
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
              支持任何 OpenAI 兼容 API（DeepSeek、智谱、通义千问等）
            </p>
          </div>

          {/* Temperature & Max Tokens */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                Temperature
              </label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={config.temperature}
                onChange={(e) =>
                  setConfig({ ...config, temperature: parseFloat(e.target.value) || 0.7 })
                }
                onBlur={() => saveConfig(config)}
                className="mt-1 w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs focus:ring-2 transition-all text-[var(--color-text)]"
                style={{ "--tw-ring-color": `${BRAND}30` } as any}
              />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                Max Tokens
              </label>
              <input
                type="number"
                value={config.max_tokens || ""}
                onChange={(e) =>
                  setConfig({ ...config, max_tokens: parseInt(e.target.value) || null })
                }
                onBlur={() => saveConfig(config)}
                placeholder="不限制"
                className="mt-1 w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs focus:ring-2 transition-all text-[var(--color-text)]"
                style={{ "--tw-ring-color": `${BRAND}30` } as any}
              />
            </div>
          </div>
        </div>
      )}

      {(config.source === "team" || config.source === "platform") && (
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

      {/* 高级工具 */}
      <div className="bg-[var(--color-bg)] rounded-xl p-4 border border-[var(--color-border)] space-y-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-xs font-semibold">高级工具</span>
        </div>

        <label className="flex items-center justify-between cursor-pointer">
          <div className="flex-1 pr-3">
            <span className="text-xs text-[var(--color-text)]">启用高级工具</span>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              开启后 AI 可执行 shell 命令、读写本地文件、获取系统信息等。危险操作会弹窗确认。
            </p>
          </div>
          <button
            onClick={() => updateAndSave({ enable_advanced_tools: !config.enable_advanced_tools })}
            className="relative w-8 h-[18px] rounded-full transition-colors shrink-0"
            style={{
              background: config.enable_advanced_tools ? "#f59e0b" : "var(--color-bg-secondary)",
              border: config.enable_advanced_tools ? "none" : "1px solid var(--color-border)",
            }}
          >
            <div
              className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${config.enable_advanced_tools ? "translate-x-[15px]" : "translate-x-[2px]"}`}
            />
          </button>
        </label>

        {config.enable_advanced_tools && (
          <div className="text-[10px] text-amber-600 bg-amber-500/5 rounded-lg px-3 py-2 border border-amber-500/10">
            已启用高级工具：执行命令、读写文件、列出目录、获取系统信息、打开网址、打开文件/目录、获取进程列表。其中执行命令、写入文件、打开路径为危险操作，执行前需要你确认。
          </div>
        )}

        <label className="flex items-center justify-between cursor-pointer">
          <div className="flex-1 pr-3">
            <div className="flex items-center gap-1.5">
              <BookOpen className="w-3 h-3 text-indigo-400" />
              <span className="text-xs text-[var(--color-text)]">对话时自动检索知识库</span>
            </div>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              开启后，每次对话会自动从 RAG 知识库中检索相关内容并注入上下文，提升回答准确性。
            </p>
          </div>
          <button
            onClick={() => updateAndSave({ enable_rag_auto_search: !config.enable_rag_auto_search })}
            className="relative w-8 h-[18px] rounded-full transition-colors shrink-0"
            style={{
              background: config.enable_rag_auto_search ? BRAND : "var(--color-bg-secondary)",
              border: config.enable_rag_auto_search ? "none" : "1px solid var(--color-border)",
            }}
          >
            <div
              className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${config.enable_rag_auto_search ? "translate-x-[15px]" : "translate-x-[2px]"}`}
            />
          </button>
        </label>
      </div>

      {/* 自定义系统提示词 */}
      <div className="bg-[var(--color-bg)] rounded-xl p-4 border border-[var(--color-border)] space-y-2">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-xs font-semibold">自定义系统提示词</span>
        </div>
        <textarea
          className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border-0 focus:ring-2 resize-none min-h-[80px] max-h-[160px] leading-relaxed"
          style={{ "--tw-ring-color": `${BRAND}30` } as any}
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
