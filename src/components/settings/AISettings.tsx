import { useState, useEffect } from 'react'
import { Save, Eye, EyeOff, Bot } from 'lucide-react'
import { useAIStore } from '@/store/ai-store'

export function AISettings() {
  const { config, saveConfig, loadConfig } = useAIStore()
  const [form, setForm] = useState(config)
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    loadConfig().then(() => {
      setForm(useAIStore.getState().config)
    })
  }, [])

  const handleSave = async () => {
    await saveConfig(form)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Bot className="w-4 h-4 text-indigo-400" />
        <h3 className="text-sm font-medium text-[var(--color-text)]">AI 模型配置</h3>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">API Base URL</label>
          <input
            type="text"
            className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
            value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">API Key</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm rounded-lg px-3 py-2 pr-10 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder="sk-..."
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs text-[var(--color-text-secondary)] mb-1">模型</label>
          <input
            type="text"
            className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder="gpt-4o / deepseek-chat / ..."
          />
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
            支持任何 OpenAI 兼容 API（DeepSeek、智谱、通义千问等）
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Temperature</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
              value={form.temperature}
              onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) || 0.7 })}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Max Tokens</label>
            <input
              type="number"
              className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
              value={form.max_tokens || ''}
              onChange={(e) => setForm({ ...form, max_tokens: parseInt(e.target.value) || null })}
              placeholder="不限制"
            />
          </div>
        </div>

        <button
          onClick={handleSave}
          className="w-full flex items-center justify-center gap-2 bg-indigo-500 text-white text-sm font-medium rounded-lg px-4 py-2.5 hover:bg-indigo-600 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saved ? '已保存 ✓' : '保存配置'}
        </button>
      </div>
    </div>
  )
}

// 兼容旧导入（无 onBack prop）
export default AISettings
