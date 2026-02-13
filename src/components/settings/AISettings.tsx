import { useState, useEffect } from 'react'
import { Save, Eye, EyeOff, Bot, ShieldAlert, MessageSquare } from 'lucide-react'
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

        {/* 高级工具 */}
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-xs font-medium text-[var(--color-text)]">高级工具</span>
          </div>
          <label className="flex items-center justify-between cursor-pointer">
            <div className="flex-1 pr-3">
              <span className="text-xs text-[var(--color-text)]">启用高级工具</span>
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                开启后 AI 可执行 shell 命令、读写本地文件、获取系统信息等。危险操作会弹窗确认。
              </p>
            </div>
            <input
              type="checkbox"
              className="w-4 h-4 rounded accent-amber-500"
              checked={form.enable_advanced_tools}
              onChange={(e) => setForm({ ...form, enable_advanced_tools: e.target.checked })}
            />
          </label>
          {form.enable_advanced_tools && (
            <div className="mt-2 text-[10px] text-amber-600 bg-amber-500/5 rounded-lg px-3 py-2 border border-amber-500/10">
              已启用高级工具：执行命令、读写文件、列出目录、获取系统信息、打开网址、打开文件/目录、获取进程列表。其中执行命令、写入文件、打开路径为危险操作，执行前需要你确认。
            </div>
          )}
        </div>

        {/* 自定义 System Prompt */}
        <div className="pt-3 border-t border-[var(--color-border)]">
          <div className="flex items-center gap-2 mb-2">
            <MessageSquare className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-xs font-medium text-[var(--color-text)]">自定义系统提示词</span>
          </div>
          <textarea
            className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)] resize-none min-h-[80px] max-h-[160px] leading-relaxed"
            value={form.system_prompt}
            onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
            placeholder="可选。在默认系统提示词之后追加你自己的指令，例如「回答风格偏口语化」「回答末尾附上英文翻译」等..."
          />
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-1">
            留空则使用默认提示词；填写后会追加到默认提示词之后
          </p>
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
