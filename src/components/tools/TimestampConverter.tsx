import { useState, useEffect } from 'react'
import { ArrowLeft, Copy, Check, RefreshCw, ArrowRightLeft } from 'lucide-react'
import { useDragWindow } from '@/hooks/useDragWindow'

export function TimestampConverter({ onBack }: { onBack: () => void }) {
  const [timestamp, setTimestamp] = useState(String(Math.floor(Date.now() / 1000)))
  const [datetime, setDatetime] = useState('')
  const [now, setNow] = useState(Date.now())
  const [copied, setCopied] = useState('')

  // 实时时钟
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 时间戳 → 日期
  useEffect(() => {
    const ts = Number(timestamp)
    if (!isNaN(ts) && ts > 0) {
      // 自动判断秒/毫秒
      const msTs = ts > 9999999999 ? ts : ts * 1000
      const date = new Date(msTs)
      if (!isNaN(date.getTime())) {
        setDatetime(formatDate(date))
        return
      }
    }
    setDatetime('')
  }, [timestamp])

  const handleDatetimeToTs = () => {
    const date = new Date(datetime)
    if (!isNaN(date.getTime())) {
      setTimestamp(String(Math.floor(date.getTime() / 1000)))
    }
  }

  const handleRefresh = () => {
    setTimestamp(String(Math.floor(Date.now() / 1000)))
  }

  const handleCopy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(''), 1500)
  }

  const currentDate = new Date(now)
  const { onMouseDown } = useDragWindow()

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] shadow-2xl overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing" onMouseDown={onMouseDown}>
        <button onClick={onBack} className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-[var(--color-text)]">时间戳转换</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 当前时间 */}
        <div className="bg-[var(--color-bg-secondary)] rounded-lg p-3">
          <div className="text-[10px] text-[var(--color-text-secondary)] mb-1">当前时间</div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-[var(--color-text)] font-mono">{formatDate(currentDate)}</div>
              <div className="text-xs text-[var(--color-text-secondary)] font-mono mt-0.5">
                秒: {Math.floor(now / 1000)} &nbsp;|&nbsp; 毫秒: {now}
              </div>
            </div>
            <button
              onClick={() => handleCopy(String(Math.floor(now / 1000)), 'now')}
              className="p-1.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
            >
              {copied === 'now' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* 时间戳输入 */}
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <label className="text-xs text-[var(--color-text-secondary)]">时间戳 (秒/毫秒)</label>
            <button onClick={handleRefresh} className="p-0.5 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]" title="获取当前">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm font-mono rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
              value={timestamp}
              onChange={(e) => setTimestamp(e.target.value)}
              placeholder="1700000000"
            />
            <button
              onClick={() => handleCopy(timestamp, 'ts')}
              className="px-2 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            >
              {copied === 'ts' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* 转换箭头 */}
        <div className="flex justify-center">
          <ArrowRightLeft className="w-4 h-4 text-[var(--color-text-secondary)] rotate-90" />
        </div>

        {/* 日期输入 */}
        <div>
          <label className="text-xs text-[var(--color-text-secondary)] mb-1.5 block">日期时间</label>
          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm font-mono rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
              value={datetime}
              onChange={(e) => setDatetime(e.target.value)}
              onBlur={handleDatetimeToTs}
              placeholder="2026-01-01 00:00:00"
            />
            <button
              onClick={() => handleCopy(datetime, 'dt')}
              className="px-2 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            >
              {copied === 'dt' ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* 快捷转换 */}
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: '今天开始', ts: () => new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000 },
            { label: '今天结束', ts: () => new Date(new Date().setHours(23, 59, 59, 999)).getTime() / 1000 },
            { label: '昨天开始', ts: () => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d.getTime() / 1000 } },
            { label: '本周一', ts: () => { const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1); d.setHours(0, 0, 0, 0); return d.getTime() / 1000 } },
          ].map(({ label, ts }) => (
            <button
              key={label}
              onClick={() => setTimestamp(String(Math.floor(ts())))}
              className="text-xs px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors text-left"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
