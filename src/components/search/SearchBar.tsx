import { useRef, useEffect, useCallback } from "react";
import { Search, Bot } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { invoke } from "@tauri-apps/api/core";
import { ModeIndicator, detectMode } from "./ModeIndicator";
import { useDragWindow } from "@/hooks/useDragWindow";

const MODE_CONFIG = {
  search: { icon: Search, label: "搜索插件或应用...", color: "text-gray-400" },
  ai: { icon: Bot, label: "和 AI 对话...", color: "text-indigo-400" },
} as const;

export function SearchBar({
  onSubmit,
  resultCount,
}: {
  onSubmit?: (value: string, mode: string) => void;
  resultCount?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const { mode, searchValue, setSearchValue, reset } = useAppStore();
  const modeConfig = MODE_CONFIG[mode] || MODE_CONFIG.search;
  const ModeIcon = modeConfig.icon;
  const detectedMode = detectMode(searchValue);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 监听全局窗口显示事件，自动聚焦
  useEffect(() => {
    const handleFocus = () => inputRef.current?.focus();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  // 根据输入内容动态调整 input 宽度
  useEffect(() => {
    if (inputRef.current && measureRef.current) {
      const measuredWidth = measureRef.current.scrollWidth;
      inputRef.current.style.width = `${measuredWidth + 4}px`;
    }
  }, [searchValue]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const { selectedIndex, setSelectedIndex } = useAppStore.getState();
      if (e.key === "Escape") {
        if (searchValue) {
          reset();
        } else {
          invoke("hide_window");
        }
        e.preventDefault();
      } else if (e.key === "Enter") {
        onSubmit?.(searchValue, mode);
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const max = (resultCount || 1) - 1;
        setSelectedIndex(Math.min(selectedIndex + 1, max));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(Math.max(selectedIndex - 1, 0));
      }
    },
    [searchValue, mode, reset, onSubmit, resultCount],
  );

  const { onMouseDown: handleDrag } = useDragWindow();

  // 拖拽：mouseDown 在非 input 区域时调用拖拽，同时保持 focus
  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return;
    }
    inputRef.current?.focus();
    handleDrag(e);
  };

  return (
    <div
      className="flex items-center h-[50px] px-2"
      onMouseDown={handleMouseDown}
    >
      <ModeIcon
        className={`w-5 h-5 ${modeConfig.color} shrink-0 pointer-events-none`}
      />

      <ModeIndicator value={searchValue} />

      {/* 输入区域容器：占据剩余空间，但 input 只按内容宽度 */}
      <div className="flex-1 ml-3 relative flex items-center h-full cursor-grab active:cursor-grabbing overflow-hidden">
        {/* 无内容时的 placeholder */}
        {!searchValue && (
          <div className="absolute inset-0 flex items-center text-[var(--color-text-secondary)] opacity-50 text-lg font-medium pointer-events-none select-none">
            {detectedMode.id !== "default"
              ? detectedMode.placeholder
              : modeConfig.label}
          </div>
        )}

        {/* 隐藏的 span 用于测量文本宽度 */}
        <span
          ref={measureRef}
          className="invisible absolute whitespace-pre text-lg font-medium"
          aria-hidden="true"
        >
          {searchValue}
        </span>

        {/* input 宽度随内容动态变化 */}
        <input
          ref={inputRef}
          type="text"
          className="bg-transparent text-[var(--color-text)] text-lg font-medium outline-none cursor-text min-w-[4px] max-w-full"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          spellCheck={false}
          aria-label="搜索框"
          role="combobox"
          aria-expanded={!!searchValue}
          aria-autocomplete="list"
        />
      </div>

      <div className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] shrink-0 pointer-events-none">
        <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded text-[10px]">
          ⌥
        </kbd>
        <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded text-[10px]">
          Space
        </kbd>
      </div>
    </div>
  );
}
