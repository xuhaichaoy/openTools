import { useState, useMemo } from 'react'
import { handleError } from '@/core/errors'
import {
  Languages, Sparkles, BookOpen, MessageSquare, Copy, Check, ArrowLeft,
  Loader2, ExternalLink, Braces, Bug, FileText, FolderOpen, Clock,
  Mail, Hash, MessageCircle,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useAIStore } from '@/store/ai-store'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useDragWindow } from '@/hooks/useDragWindow'
import { getRecommendedActions, type RecommendedAction } from '@/core/context-detector'

/** lucide icon 名称映射 */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Languages, Sparkles, BookOpen, MessageSquare, Copy, ExternalLink,
  Braces, Bug, FileText, FolderOpen, Clock, Mail, Hash, MessageCircle,
}

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

  // 根据内容智能检测推荐操作
  const { detections, actions } = useMemo(
    () => getRecommendedActions(selectedText),
    [selectedText],
  )
  const primaryType = detections[0]

  /** 处理特殊操作（无需 AI） */
  const handleSpecialAction = async (action: RecommendedAction): Promise<boolean> => {
    switch (action.id) {
      case 'copy': {
        await navigator.clipboard.writeText(selectedText)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
        return true
      }
      case 'open_url': {
        await invoke('open_url', { url: selectedText.trim() })
        return true
      }
      case 'open_folder': {
        await invoke('shell_open_path', { path: selectedText.trim() })
        return true
      }
      case 'read_file': {
        try {
          const content = await invoke<string>('read_text_file', { path: selectedText.trim() })
          setResult(content.slice(0, 5000))
          setActiveAction(action.id)
        } catch (e) {
          setResult(`❌ 读取失败: ${e}`)
          setActiveAction(action.id)
        }
        return true
      }
      case 'format_json': {
        try {
          const parsed = JSON.parse(selectedText.trim())
          setResult('```json\n' + JSON.stringify(parsed, null, 2) + '\n```')
          setActiveAction(action.id)
        } catch (e) {
          handleError(e, { context: 'JSON格式校验', silent: true })
          setResult('❌ JSON 格式无效')
          setActiveAction(action.id)
        }
        return true
      }
      case 'convert_ts': {
        const ts = parseInt(selectedText.trim(), 10)
        const ms = ts > 1e12 ? ts : ts * 1000
        const date = new Date(ms)
        setResult(
          `**时间戳**: ${selectedText.trim()}\n\n` +
          `**本地时间**: ${date.toLocaleString('zh-CN', { hour12: false })}\n\n` +
          `**ISO 格式**: ${date.toISOString()}\n\n` +
          `**UTC**: ${date.toUTCString()}`
        )
        setActiveAction(action.id)
        return true
      }
      case 'ask_ai':
        // 不做特殊处理，走通用 AI prompt
        return false
      default:
        return false
    }
  }

  const handleAction = async (action: RecommendedAction) => {
    // 先尝试特殊操作
    const handled = await handleSpecialAction(action)
    if (handled) return

    // AI 操作
    if (!config.api_key) {
      setResult('❌ 请先在设置中配置 AI API Key')
      setActiveAction(action.id)
      return
    }

    setActiveAction(action.id)
    setResult('')
    setIsLoading(true)

    const prompt = action.prompt
      ? action.prompt + selectedText
      : `请分析并处理以下内容：\n\n${selectedText}`

    try {
      const response = await invoke<string>('ai_chat', {
        messages: [{ role: 'user', content: prompt }],
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
      <div
        className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-[var(--color-text)]">上下文操作</span>
        {/* 类型标签 */}
        {primaryType && (
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400">
            {primaryType.label}
          </span>
        )}
      </div>

      {/* 原文 */}
      <div className="px-4 py-2 border-b border-[var(--color-border)]">
        <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">选中文本</div>
        <div className="text-xs text-[var(--color-text)] bg-[var(--color-bg-secondary)] rounded-lg p-2 max-h-[80px] overflow-y-auto">
          {selectedText.slice(0, 500)}
          {selectedText.length > 500 && '...'}
        </div>
      </div>

      {/* 推荐操作按钮 */}
      <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-[var(--color-border)]">
        {actions.map((action) => {
          const Icon = ICON_MAP[action.icon] || MessageCircle
          return (
            <button
              key={action.id}
              onClick={() => handleAction(action)}
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
            根据内容类型推荐了操作，点击即可执行
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
