import { useState } from 'react'
import { Languages, Sparkles, BookOpen, MessageSquare, Copy, Check, ArrowLeft, Loader2 } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useAIStore } from '@/store/ai-store'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useDragWindow } from '@/hooks/useDragWindow'

const ACTIONS = [
  { id: 'translate', label: '翻译', icon: Languages, color: 'text-blue-400', prompt: '请将以下文本翻译为中文（如果是中文则翻译为英文），只返回翻译结果：\n\n' },
  { id: 'polish', label: '润色', icon: Sparkles, color: 'text-yellow-400', prompt: '请润色以下文本，使其更加通顺、专业。只返回润色后的结果：\n\n' },
  { id: 'explain', label: '解释', icon: BookOpen, color: 'text-green-400', prompt: '请用简洁的中文解释以下内容：\n\n' },
  { id: 'summarize', label: '总结', icon: MessageSquare, color: 'text-purple-400', prompt: '请用3-5个要点总结以下内容：\n\n' },
]

interface ContextActionPanelProps {
  selectedText: string
  onBack: () => void
}

export function ContextActionPanel({ selectedText, onBack }: ContextActionPanelProps) {
  const [result, setResult] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [activeAction, setActiveAction] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { config } = useAIStore()
  const { onMouseDown } = useDragWindow()

  const handleAction = async (actionId: string) => {
    const action = ACTIONS.find((a) => a.id === actionId)
    if (!action || !config.api_key) return

    setActiveAction(actionId)
    setResult('')
    setIsLoading(true)

    try {
      const response = await invoke<string>('ai_chat', {
        messages: [
          { role: 'user', content: action.prompt + selectedText },
        ],
        config,
      })
      setResult(response)
    } catch (e) {
      setResult(`❌ ${e}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopy = async () => {
    if (result) {
      await navigator.clipboard.writeText(result)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] shadow-2xl overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-[var(--color-text)]">上下文操作</span>
      </div>

      {/* 原文 */}
      <div className="px-4 py-2 border-b border-[var(--color-border)]">
        <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">选中文本</div>
        <div className="text-xs text-[var(--color-text)] bg-[var(--color-bg-secondary)] rounded-lg p-2 max-h-[80px] overflow-y-auto">
          {selectedText.slice(0, 500)}
          {selectedText.length > 500 && '...'}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex gap-2 px-4 py-2 border-b border-[var(--color-border)]">
        {ACTIONS.map((action) => {
          const Icon = action.icon
          return (
            <button
              key={action.id}
              onClick={() => handleAction(action.id)}
              disabled={isLoading}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
                activeAction === action.id
                  ? 'bg-indigo-500 text-white'
                  : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
              } disabled:opacity-40`}
            >
              <Icon className={`w-3.5 h-3.5 ${activeAction === action.id ? 'text-white' : action.color}`} />
              {action.label}
            </button>
          )
        })}
      </div>

      {/* 结果 */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">正在处理...</span>
          </div>
        ) : result ? (
          <div className="prose prose-invert prose-sm max-w-none [&_pre]:bg-[var(--color-code-bg)] [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:text-xs [&_p]:my-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
          </div>
        ) : (
          <div className="text-xs text-[var(--color-text-secondary)] text-center mt-8">
            选择一个操作来处理选中的文本
          </div>
        )}
      </div>

      {/* 底部 */}
      {result && !isLoading && (
        <div className="px-4 py-2 border-t border-[var(--color-border)] flex justify-end">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? '已复制' : '复制结果'}
          </button>
        </div>
      )}
    </div>
  )
}
