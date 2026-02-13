import { Bot, Globe, Terminal, Database, Search } from 'lucide-react'

export interface SearchMode {
  id: string
  prefix: string
  label: string
  icon: React.ReactNode
  color: string
  bgColor: string
  placeholder: string
}

export const SEARCH_MODES: SearchMode[] = [
  {
    id: 'default',
    prefix: '',
    label: '搜索',
    icon: <Search className="w-3 h-3" />,
    color: 'text-gray-400',
    bgColor: 'bg-gray-500',
    placeholder: '搜索插件或应用...',
  },
  {
    id: 'ai',
    prefix: 'ai ',
    label: 'AI',
    icon: <Bot className="w-3 h-3" />,
    color: 'text-indigo-400',
    bgColor: 'bg-indigo-500',
    placeholder: '和 AI 对话...',
  },
  {
    id: 'shell',
    prefix: '/ ',
    label: 'Shell',
    icon: <Terminal className="w-3 h-3" />,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500',
    placeholder: 'AI Agent shell 命令...',
  },
  {
    id: 'baidu',
    prefix: 'bd ',
    label: '百度',
    icon: <Globe className="w-3 h-3" />,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500',
    placeholder: '百度搜索...',
  },
  {
    id: 'google',
    prefix: 'gg ',
    label: 'Google',
    icon: <Globe className="w-3 h-3" />,
    color: 'text-green-400',
    bgColor: 'bg-green-500',
    placeholder: 'Google 搜索...',
  },
  {
    id: 'data',
    prefix: 'data ',
    label: '数据',
    icon: <Database className="w-3 h-3" />,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500',
    placeholder: '描述数据需求...',
  },
]

/** 根据输入值判断当前模式 */
export function detectMode(value: string): SearchMode {
  for (const mode of SEARCH_MODES) {
    if (mode.prefix && value.startsWith(mode.prefix)) {
      return mode
    }
  }
  return SEARCH_MODES[0]
}

/** 模式指示器标签组件 */
export function ModeIndicator({ value }: { value: string }) {
  const mode = detectMode(value)

  if (mode.id === 'default') return null

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-white rounded shrink-0 ${mode.bgColor}`}
    >
      {mode.icon}
      {mode.label}
    </span>
  )
}

/** 模式提示条 — 无输入时显示在搜索框下方 */
export function ModeHints() {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-[10px] text-[var(--color-text-secondary)]">
      {SEARCH_MODES.filter((m) => m.id !== 'default').map((mode) => (
        <span key={mode.id} className="flex items-center gap-0.5">
          <span className={mode.color}>{mode.prefix.trim()}</span>
          <span>{mode.label}</span>
        </span>
      ))}
    </div>
  )
}
