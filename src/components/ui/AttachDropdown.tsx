import React, { useState, useRef, useEffect } from "react";
import { Paperclip, ImagePlus, FolderOpen } from "lucide-react";

interface AttachDropdownProps {
  onFileClick: () => void;
  onFolderClick?: () => void;
  disabled?: boolean;
  /** 按钮 hover 高亮色，默认 emerald */
  accent?: string;
}

export function AttachDropdown({
  onFileClick,
  onFolderClick,
  disabled,
  accent = "emerald",
}: AttachDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // 如果没有 onFolderClick，点击直接触发文件选择
  const handleClick = () => {
    if (!onFolderClick) {
      onFileClick();
    } else {
      setOpen((v) => !v);
    }
  };

  const accentClasses: Record<string, { btn: string; item: string }> = {
    emerald: {
      btn: "hover:text-emerald-500 hover:bg-emerald-500/5",
      item: "hover:bg-emerald-500/5 hover:text-emerald-600",
    },
    indigo: {
      btn: "hover:text-indigo-500 hover:bg-indigo-500/5",
      item: "hover:bg-indigo-500/5 hover:text-indigo-600",
    },
    accent: {
      btn: "hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]",
      item: "hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]",
    },
  };
  const colors = accentClasses[accent] || accentClasses.emerald;

  return (
    <div ref={ref} className="relative shrink-0 self-center">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={`p-1.5 rounded-lg text-[var(--color-text-secondary)] ${colors.btn} transition-colors disabled:opacity-50`}
        title="添加附件"
      >
        <Paperclip className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-36 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden z-50">
          <button
            type="button"
            className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text)] ${colors.item} transition-colors`}
            onClick={() => { setOpen(false); onFileClick(); }}
          >
            <ImagePlus className="w-3.5 h-3.5" />
            添加图片/文件
          </button>
          {onFolderClick && (
            <button
              type="button"
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text)] ${colors.item} transition-colors`}
              onClick={() => { setOpen(false); onFolderClick(); }}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              选择文件夹
            </button>
          )}
        </div>
      )}
    </div>
  );
}
