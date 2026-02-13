import { useState } from 'react'
import { ArrowLeft, Copy, Check, Minimize2, Maximize2, AlertCircle } from 'lucide-react'
import { useDragWindow } from '@/hooks/useDragWindow'

export function JsonFormatter({ onBack }: { onBack: () => void }) {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [indent, setIndent] = useState(2)
  const { onMouseDown } = useDragWindow()

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(input)
      setOutput(JSON.stringify(parsed, null, indent))
      setError('')
    } catch (e) {
      setError(String(e).replace('SyntaxError: ', ''))
      setOutput('')
    }
  }

  const handleMinify = () => {
    try {
      const parsed = JSON.parse(input)
      setOutput(JSON.stringify(parsed))
      setError('')
    } catch (e) {
      setError(String(e).replace('SyntaxError: ', ''))
      setOutput('')
    }
  }

  const handleCopy = async () => {
    if (output) {
      await navigator.clipboard.writeText(output)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] shadow-2xl overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium text-[var(--color-text)]">JSON 格式化</span>
        </div>
        <div className="flex items-center gap-1">
          <select
            className="text-xs bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)] rounded px-2 py-1 outline-none"
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
          >
            <option value={2}>缩进 2</option>
            <option value={4}>缩进 4</option>
            <option value={8}>缩进 8</option>
          </select>
          <button onClick={handleFormat} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 transition-colors">
            <Maximize2 className="w-3 h-3" />
            格式化
          </button>
          <button onClick={handleMinify} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors">
            <Minimize2 className="w-3 h-3" />
            压缩
          </button>
          <button onClick={handleCopy} disabled={!output} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors">
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* 编辑区域 */}
      <div className="flex flex-1 min-h-0">
        <textarea
          className="flex-1 bg-transparent text-xs text-[var(--color-text)] font-mono p-3 outline-none resize-none border-r border-[var(--color-border)] placeholder:text-[var(--color-text-secondary)]"
          placeholder="粘贴 JSON 文本..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
        />
        <div className="flex-1 relative">
          {error ? (
            <div className="p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span className="text-xs text-red-400 font-mono">{error}</span>
            </div>
          ) : (
            <pre className="p-3 text-xs text-[var(--color-text)] font-mono whitespace-pre overflow-auto h-full">
              {output || <span className="text-[var(--color-text-secondary)]">格式化结果...</span>}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
