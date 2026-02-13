import { useState, useEffect } from 'react'
import { Eye, EyeOff, Save, Check, ShieldCheck, Terminal } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'

interface CredentialItem {
  key: string
  label: string
  has_value: boolean
}

export function CredentialSettings() {
  const [credentials, setCredentials] = useState<CredentialItem[]>([])
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [showValues, setShowValues] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [pythonPath, setPythonPath] = useState('')
  const [pythonDetecting, setPythonDetecting] = useState(false)

  useEffect(() => {
    loadCredentials()
    detectPython()
  }, [])

  const loadCredentials = async () => {
    try {
      const creds = await invoke<CredentialItem[]>('dataforge_get_credentials')
      setCredentials(creds)
    } catch (e) {
      console.error('加载凭证失败:', e)
    }
  }

  const detectPython = async () => {
    setPythonDetecting(true)
    try {
      const path = await invoke<string>('get_python_path')
      setPythonPath(path)
    } catch (e) {
      setPythonPath('未检测到')
    }
    setPythonDetecting(false)
  }

  const handleSave = async (key: string) => {
    const value = editValues[key]
    if (!value) return
    try {
      await invoke('dataforge_save_credential', { key, value })
      setSaved((prev) => ({ ...prev, [key]: true }))
      setTimeout(() => setSaved((prev) => ({ ...prev, [key]: false })), 2000)
      setEditValues((prev) => ({ ...prev, [key]: '' }))
      loadCredentials()
    } catch (e) {
      console.error('保存凭证失败:', e)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck className="w-4 h-4 text-green-400" />
        <h3 className="text-sm font-medium text-[var(--color-text)]">凭证管理</h3>
      </div>
      <p className="text-[10px] text-[var(--color-text-secondary)] -mt-2">
        数据脚本运行时通过环境变量注入凭证，不会存储在脚本中
      </p>

      {credentials.map((cred) => (
        <div key={cred.key}>
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] mb-1">
            <span>{cred.label}</span>
            {cred.has_value && (
              <span className="text-[10px] text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">已配置</span>
            )}
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showValues[cred.key] ? 'text' : 'password'}
                className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-xs rounded-lg px-3 py-2 pr-8 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
                value={editValues[cred.key] || ''}
                onChange={(e) => setEditValues((prev) => ({ ...prev, [cred.key]: e.target.value }))}
                placeholder={cred.has_value ? '••••••••（已设置，输入新值覆盖）' : '输入凭证值...'}
              />
              <button
                onClick={() => setShowValues((prev) => ({ ...prev, [cred.key]: !prev[cred.key] }))}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              >
                {showValues[cred.key] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <button
              onClick={() => handleSave(cred.key)}
              disabled={!editValues[cred.key]}
              className="px-3 py-2 text-xs rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
            >
              {saved[cred.key] ? <Check className="w-3 h-3" /> : <Save className="w-3 h-3" />}
              {saved[cred.key] ? '已保存' : '保存'}
            </button>
          </div>
        </div>
      ))}

      {/* Python 路径 */}
      <div className="pt-2 border-t border-[var(--color-border)]">
        <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] mb-1">
          <Terminal className="w-3.5 h-3.5" />
          Python 路径
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1 bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text)] rounded-lg px-3 py-2 border border-[var(--color-border)] font-mono">
            {pythonDetecting ? '检测中...' : pythonPath}
          </div>
          <button
            onClick={detectPython}
            disabled={pythonDetecting}
            className="px-3 py-2 text-xs rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
          >
            检测
          </button>
        </div>
      </div>
    </div>
  )
}
