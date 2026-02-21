import { useState } from 'react'
import {
  ArrowLeft, Monitor, Moon, Trash2, BatteryCharging,
  Wifi, Camera, MonitorSmartphone, Volume2, VolumeX,
  Loader2, Check,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useDragWindow } from '@/hooks/useDragWindow'

interface SystemAction {
  id: string
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  color: string
  /** macOS 命令 */
  macCommand?: string
  /** Windows 命令 */
  winCommand?: string
  /** 是否为原生 Tauri 操作（非 shell） */
  native?: () => Promise<void>
}

const isMac = navigator.platform.toLowerCase().includes('mac')
const isWindows = navigator.platform.toLowerCase().includes('win')

const SYSTEM_ACTIONS: SystemAction[] = [
  {
    id: 'lock_screen',
    label: '锁屏',
    description: '锁定屏幕',
    icon: Monitor,
    color: 'text-blue-400 bg-blue-400/10',
    macCommand: 'pmset displaysleepnow',
    winCommand: 'rundll32.exe user32.dll,LockWorkStation',
  },
  {
    id: 'toggle_dark_mode',
    label: '切换深色模式',
    description: '切换系统外观模式',
    icon: Moon,
    color: 'text-purple-400 bg-purple-400/10',
    macCommand: `osascript -e 'tell app "System Events" to tell appearance preferences to set dark mode to not dark mode'`,
    winCommand: 'reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize /v AppsUseLightTheme /t REG_DWORD /d 0 /f',
  },
  {
    id: 'empty_trash',
    label: '清空回收站',
    description: '清空系统回收站',
    icon: Trash2,
    color: 'text-red-400 bg-red-400/10',
    macCommand: `osascript -e 'tell app "Finder" to empty the trash'`,
    winCommand: 'PowerShell.exe -Command "Clear-RecycleBin -Force"',
  },
  {
    id: 'sleep_system',
    label: '系统休眠',
    description: '让电脑进入睡眠状态',
    icon: BatteryCharging,
    color: 'text-green-400 bg-green-400/10',
    macCommand: 'pmset sleepnow',
    winCommand: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
  },
  {
    id: 'toggle_wifi',
    label: 'Wi-Fi 开关',
    description: '切换 Wi-Fi 连接状态',
    icon: Wifi,
    color: 'text-cyan-400 bg-cyan-400/10',
    macCommand: `networksetup -getairportpower en0 | grep -q 'On' && networksetup -setairportpower en0 off || networksetup -setairportpower en0 on`,
  },
  {
    id: 'screenshot_full',
    label: '全屏截图',
    description: '截取全屏并保存到桌面',
    icon: Camera,
    color: 'text-orange-400 bg-orange-400/10',
    macCommand: 'screencapture ~/Desktop/screenshot_$(date +%Y%m%d_%H%M%S).png',
    winCommand: 'snippingtool /clip',
  },
  {
    id: 'show_desktop',
    label: '显示桌面',
    description: '最小化所有窗口',
    icon: MonitorSmartphone,
    color: 'text-teal-400 bg-teal-400/10',
    macCommand: `osascript -e 'tell app "Finder" to set visible of every process whose visible is true to false'`,
  },
  {
    id: 'mute_audio',
    label: '静音',
    description: '切换系统静音状态',
    icon: VolumeX,
    color: 'text-pink-400 bg-pink-400/10',
    macCommand: `osascript -e 'set volume output muted not (output muted of (get volume settings))'`,
  },
  {
    id: 'max_volume',
    label: '最大音量',
    description: '将音量设为最大',
    icon: Volume2,
    color: 'text-yellow-400 bg-yellow-400/10',
    macCommand: `osascript -e 'set volume output volume 100'`,
  },
]

export default function SystemActionsPlugin({ onBack }: { onBack: () => void }) {
  const [executing, setExecuting] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { onMouseDown } = useDragWindow()
  const visibleActions = SYSTEM_ACTIONS.filter((action) => {
    if (action.native) return true
    if (isMac) return Boolean(action.macCommand)
    if (isWindows) return Boolean(action.winCommand)
    return false
  })

  const handleExecute = async (action: SystemAction) => {
    setExecuting(action.id)
    setError(null)
    setDone(null)

    try {
      if (action.native) {
        await action.native()
      } else {
        const command = isMac
          ? action.macCommand
          : isWindows
            ? action.winCommand
            : undefined
        if (!command) {
          throw new Error('当前系统不支持此操作')
        }
        await invoke('run_shell_command', { command })
      }
      setDone(action.id)
      setTimeout(() => setDone(null), 2000)
    } catch (e) {
      setError(`${action.label} 失败: ${e}`)
    } finally {
      setExecuting(null)
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
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
        <span className="text-sm font-medium text-[var(--color-text)]">系统操作</span>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mx-4 mt-2 text-[10px] text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* 操作网格 */}
      <div className="flex-1 overflow-y-auto p-4">
        {visibleActions.length === 0 ? (
          <div className="text-xs text-[var(--color-text-secondary)]">
            当前系统暂无可用的系统操作能力。
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {visibleActions.map((action) => {
              const Icon = action.icon
              const isRunning = executing === action.id
              const isDone = done === action.id
              return (
                <button
                  key={action.id}
                  onClick={() => handleExecute(action)}
                  disabled={isRunning}
                  className="flex flex-col items-center gap-2 p-3 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] hover:border-orange-400/50 transition-all hover:shadow-sm disabled:opacity-50"
                >
                  <div className={`w-10 h-10 rounded-xl ${action.color} flex items-center justify-center`}>
                    {isRunning ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : isDone ? (
                      <Check className="w-5 h-5 text-green-400" />
                    ) : (
                      <Icon className="w-5 h-5" />
                    )}
                  </div>
                  <div className="text-center">
                    <div className="text-[11px] font-medium text-[var(--color-text)]">{action.label}</div>
                    <div className="text-[9px] text-[var(--color-text-secondary)] mt-0.5">{action.description}</div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
