import { useState } from 'react'
import { ArrowLeft, Copy, Check, ArrowDown, ArrowUp } from 'lucide-react'
import { useDragWindow } from '@/hooks/useDragWindow'

export function Base64Tool({ onBack }: { onBack?: () => void }) {
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [mode, setMode] = useState<'encode' | 'decode'>('encode')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const handleEncode = (text: string) => {
    try {
      // 支持 UTF-8 中文
      const encoded = btoa(unescape(encodeURIComponent(text)))
      setOutput(encoded)
      setError('')
      setMode('encode')
    } catch (e) {
      setError('编码失败')
    }
  }

  const handleDecode = (text: string) => {
    try {
      const decoded = decodeURIComponent(escape(atob(text.trim())))
      setOutput(decoded)
      setError('')
      setMode('decode')
    } catch (e) {
      setError('解码失败，请检查输入是否为合法 Base64')
    }
  }

  const handleCopy = async () => {
    if (output) {
      await navigator.clipboard.writeText(output)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const handleSwap = () => {
    setInput(output)
    setOutput(input)
    setMode(mode === 'encode' ? 'decode' : 'encode')
    setError('')
  }

  const { onMouseDown } = useDragWindow()

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] shadow-2xl overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <div className="flex items-center gap-2">
          {onBack && (
            <>
              <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <span className="text-sm font-medium text-[var(--color-text)]">Base64 编解码</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleEncode(input)}
            className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
              mode === 'encode'
                ? 'bg-indigo-500 text-white'
                : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            编码
          </button>
          <button
            onClick={() => handleDecode(input)}
            className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
              mode === 'decode'
                ? 'bg-indigo-500 text-white'
                : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            解码
          </button>
          <button onClick={handleCopy} disabled={!output} className="p-1 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40">
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 输入区 */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 relative">
          <div className="absolute left-3 top-2 text-[10px] text-[var(--color-text-secondary)]">
            {mode === 'encode' ? '原文' : 'Base64'}
          </div>
          <textarea
            className="w-full h-full bg-transparent text-xs text-[var(--color-text)] font-mono p-3 pt-6 outline-none resize-none placeholder:text-[var(--color-text-secondary)]"
            placeholder={mode === 'encode' ? '输入要编码的文本...' : '输入 Base64 字符串...'}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              if (mode === 'encode') handleEncode(e.target.value)
              else handleDecode(e.target.value)
            }}
            spellCheck={false}
          />
        </div>

        {/* 交换按钮 */}
        <div className="flex justify-center py-1 border-y border-[var(--color-border)]">
          <button onClick={handleSwap} className="p-1 rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]" title="交换输入输出">
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          {error && <span className="text-[10px] text-red-400 ml-2 self-center">{error}</span>}
        </div>

        {/* 输出区 */}
        <div className="flex-1 relative">
          <div className="absolute left-3 top-2 text-[10px] text-[var(--color-text-secondary)]">
            {mode === 'encode' ? 'Base64' : '原文'}
          </div>
          <pre className="w-full h-full text-xs text-[var(--color-text)] font-mono p-3 pt-6 overflow-auto whitespace-pre-wrap break-all">
            {output || <span className="text-[var(--color-text-secondary)]">结果...</span>}
          </pre>
        </div>
      </div>
    </div>
  )
}
