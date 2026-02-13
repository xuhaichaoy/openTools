import { useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * 窗口拖拽 Hook
 * 返回 onMouseDown，绑定到需要拖拽的容器即可。
 * 点击 input / textarea / button / a 等交互元素时不会触发拖拽。
 */
export function useDragWindow() {
  useEffect(() => {
    const handleMouseUp = () => {
      invoke('stop_drag')
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    // 交互元素不触发拖拽
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLButtonElement ||
      target instanceof HTMLSelectElement ||
      target.closest('button') ||
      target.closest('a') ||
      target.closest('[role="button"]')
    ) {
      return
    }
    e.preventDefault()
    invoke('start_drag')
  }, [])

  return { onMouseDown }
}
