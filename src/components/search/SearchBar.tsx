import { useRef, useEffect, useState } from "react";
import { Search, Bot, X, User } from "lucide-react";
import { handleError } from "@/core/errors";
import { useAppStore } from "@/store/app-store";
import { useAuthStore } from "@/store/auth-store";
import { invoke } from "@tauri-apps/api/core";
import { ModeIndicator, detectMode } from "./ModeIndicator";
import { useDragWindow } from "@/hooks/useDragWindow";
import { resolveAvatarUrl } from "@/utils/avatar";
import { useShallow } from "zustand/shallow";

const MODE_CONFIG = {
  search: { icon: Search, label: "搜索插件或应用...", color: "text-gray-400" },
  ai: { icon: Bot, label: "和 AI 对话...", color: "text-indigo-400" },
} as const;

export function SearchBar({
  onSubmit,
  resultCount,
}: {
  onSubmit?: (value: string, mode: string, images?: string[]) => void;
  resultCount?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const { mode, setMode, searchValue, setSearchValue, resetSearchState } = useAppStore(
    useShallow((s) => ({
      mode: s.mode,
      setMode: s.setMode,
      searchValue: s.searchValue,
      setSearchValue: s.setSearchValue,
      resetSearchState: s.resetSearchState,
    })),
  );
  const [pendingImages, setPendingImages] = useState<
    { path: string; preview: string }[]
  >([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const { selectedIndex, setSelectedIndex } = useAppStore.getState();
    if (e.key === "Escape") {
      if (searchValue) {
        resetSearchState();
      } else {
        invoke("hide_window");
      }
      e.preventDefault();
    } else if (e.key === "Backspace" && !searchValue) {
      if (pendingImages.length > 0) {
        e.preventDefault();
        const newImages = [...pendingImages];
        newImages.pop();
        setPendingImages(newImages);
        if (newImages.length === 0 && mode === "ai") {
          setMode("search");
        }
      }
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      const paths = pendingImages.map((img) => img.path);
      // 如果有图片，强制使用 AI 模式提交
      if (paths.length > 0) {
        onSubmit?.(searchValue, "ai", paths);
      } else {
        onSubmit?.(searchValue, mode);
      }
      setPendingImages([]);
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const max = (resultCount || 1) - 1;
      setSelectedIndex(Math.min(selectedIndex + 1, max));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(Math.max(selectedIndex - 1, 0));
    }
  };

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

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;

        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          const ext = blob.type.split("/")[1] || "png";
          const fileName = `search_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;

          try {
            const filePath = await invoke<string>("ai_save_chat_image", {
              imageData: base64,
              fileName,
            });
            setPendingImages((prev) => [
              ...prev,
              { path: filePath, preview: dataUrl },
            ]);
            // 粘贴图片通常意味着要用 AI 搜索
            if (mode !== "ai") setMode("ai");
          } catch (err) {
            handleError(err, { context: "搜索框保存图片" });
          }
        };
        reader.readAsDataURL(blob);
      }
    }
  };

  const removeImage = (index: number) => {
    setPendingImages((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0 && mode === "ai" && !searchValue) {
        setMode("search");
      }
      return next;
    });
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
        {!searchValue && pendingImages.length === 0 && (
          <div className="absolute inset-0 flex items-center text-[var(--color-text-secondary)] opacity-50 text-lg font-medium pointer-events-none select-none">
            {detectedMode.id !== "default"
              ? detectedMode.placeholder
              : modeConfig.label}
          </div>
        )}

        {/* 图片缩略图 */}
        {pendingImages.length > 0 && (
          <div className="flex items-center gap-1.5 mr-2 shrink-0">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group/img">
                <img
                  src={img.preview}
                  alt="预览"
                  className="w-8 h-8 object-cover rounded border border-[var(--color-border)] shadow-sm cursor-zoom-in hover:brightness-90 transition-all"
                  onClick={() => setPreviewImage(img.preview)}
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
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
          onPaste={handlePaste}
          autoFocus
          spellCheck={false}
          aria-label="搜索框"
          role="combobox"
          aria-expanded={!!searchValue}
          aria-autocomplete="list"
        />
      </div>

      <div className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] shrink-0 mr-1">
        <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded text-[10px]">
          ⌥
        </kbd>
        <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded text-[10px]">
          Space
        </kbd>
      </div>

      <div className="flex items-center shrink-0 ml-1 border-l border-[var(--color-border)] pl-3">
        <UserAvatar />
      </div>

      {/* 图片大图预览 */}
      {previewImage && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out animate-in fade-in duration-200"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            alt="预览大图"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl animate-in zoom-in-95 duration-200"
          />
          <button
            className="absolute top-6 right-6 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors shadow-lg"
            onClick={() => setPreviewImage(null)}
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
}

function UserAvatar() {
  const { user, isLoggedIn } = useAuthStore();
  const { requestNavigate } = useAppStore();

  const handleClick = () => {
    if (isLoggedIn) {
      // 打开管理中心
      requestNavigate("management-center");
    } else {
      // 打开登录弹窗 (发送事件或直接设置 store)
      window.dispatchEvent(new CustomEvent("open-login-modal"));
    }
  };

  return (
    <button
      onClick={handleClick}
      className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer border border-[var(--color-border)]"
    >
      {isLoggedIn && user?.avatar_url ? (
        <img
          src={resolveAvatarUrl(user.avatar_url)}
          alt={user.username}
          className="w-full h-full object-cover"
        />
      ) : (
        <User className="w-4 h-4 text-[var(--color-text-secondary)]" />
      )}
    </button>
  );
}
