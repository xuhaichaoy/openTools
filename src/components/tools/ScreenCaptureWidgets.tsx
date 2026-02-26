import { useState, useEffect } from "react";
import {
  ArrowLeft,
  AppWindow,
  Check,
  Save,
  FileImage,
  FileText,
  Loader2,
} from "lucide-react";
import { readFile } from "@tauri-apps/plugin-fs";
import type { WindowInfo } from "@/hooks/useScreenCapture";

/**
 * 将本地绝对路径转换为 mtplugin:// URL
 * 兼容 Windows（C:\...）和 macOS/Linux（/...）
 */
export function pathToMtpluginUrl(filePath: string): string {
  // Normalize: Windows backslashes → forward slashes
  const normalized = filePath.replace(/\\/g, "/");
  // Ensure leading slash
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  // Percent-encode each segment (preserve : for Windows drive letters like C:)
  const encoded = withSlash
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":"))
    .join("/");
  return `mtplugin://localhost${encoded}?t=${Date.now()}`;
}

/**
 * 截图预览组件
 * 使用 Tauri FS 读取文件后转为 blob URL，彻底绕过协议/CSP/白名单限制
 */
function ScreenshotPreview({ path }: { path: string }) {
  const [blobUrl, setBlobUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let url = "";
    setLoading(true);
    setError("");
    setBlobUrl("");

    readFile(path)
      .then((bytes) => {
        const ext = path.split(".").pop()?.toLowerCase() ?? "png";
        const mime =
          ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "gif"
              ? "image/gif"
              : "image/png";
        const blob = new Blob([bytes], { type: mime });
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch((e) => {
        console.error("[ScreenshotPreview] 读取文件失败:", path, e);
        setError(String(e));
      })
      .finally(() => setLoading(false));

    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
      </div>
    );
  }

  if (error || !blobUrl) {
    return (
      <div className="p-3 text-xs text-red-400 space-y-1">
        <div>图片加载失败</div>
        <div className="opacity-60 break-all">{path}</div>
        {error && <div className="opacity-60">{error}</div>}
      </div>
    );
  }

  return <img src={blobUrl} className="w-full" alt="截图预览" />;
}

export function Header({
  onBack,
  onMouseDown,
}: {
  onBack?: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  if (!onBack) return null;
  return (
    <div
      className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing"
      onMouseDown={onMouseDown}
    >
      <button
        onClick={onBack}
        className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>
      <h2 className="text-sm font-medium text-[var(--color-text)]">截图录屏</h2>
    </div>
  );
}

export function WindowList({
  windows,
  onSelect,
  onScrollCapture,
}: {
  windows: WindowInfo[];
  onSelect: (id: number) => void;
  onScrollCapture?: (id: number) => void;
}) {
  if (windows.length === 0) {
    return (
      <div className="text-center py-6 text-xs text-[var(--color-text-secondary)]">
        <AppWindow className="w-8 h-8 mx-auto mb-2 opacity-30" />
        未检测到窗口
      </div>
    );
  }

  return (
    <div className="space-y-1.5 max-h-[280px] overflow-y-auto">
      {windows.map((w) => (
        <div
          key={w.id}
          className="w-full flex items-center gap-2.5 p-2 rounded-lg bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] transition-colors group"
        >
          {w.thumbnail ? (
            <img
              src={`data:image/png;base64,${w.thumbnail}`}
              className="w-12 h-8 rounded object-cover border border-[var(--color-border)]"
            />
          ) : (
            <div className="w-12 h-8 rounded bg-[var(--color-bg)] border border-[var(--color-border)] flex items-center justify-center">
              <AppWindow className="w-4 h-4 text-[var(--color-text-secondary)]" />
            </div>
          )}
          <div className="flex-1 text-left min-w-0">
            <div className="text-xs font-medium text-[var(--color-text)] truncate">
              {w.title || w.app_name}
            </div>
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              {w.app_name} • {w.width}x{w.height}
            </div>
          </div>
          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => onSelect(w.id)}
              className="text-[10px] text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded hover:bg-blue-500/10 transition-colors"
            >
              截图
            </button>
            {onScrollCapture && (
              <button
                onClick={() => onScrollCapture(w.id)}
                className="text-[10px] text-green-400 hover:text-green-300 px-1.5 py-0.5 rounded hover:bg-green-500/10 transition-colors"
              >
                长截图
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PreviewPanel({
  path,
  format,
  onSave,
  onBack,
}: {
  path: string;
  format?: string;
  onSave: (format: string) => void;
  onBack: () => void;
}) {
  const isVideo = format === "mp4" || format === "gif";

  return (
    <div className="space-y-3">
      {/* 预览 */}
      <div className="rounded-xl border border-[var(--color-border)] overflow-hidden bg-[var(--color-bg-secondary)] max-h-[300px] overflow-y-auto">
        {isVideo ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--color-text-secondary)]">
            <Check className="w-5 h-5 text-green-400 mr-2" />
            录制完成：{path.split("/").pop()}
          </div>
        ) : (
          <ScreenshotPreview path={path} />
        )}
      </div>

      {/* 操作栏 */}
      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
        >
          重新截取
        </button>
        <div className="flex-1" />
        {!isVideo && (
          <>
            <button
              onClick={() => onSave("png")}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-xs"
            >
              <FileImage className="w-3.5 h-3.5" />
              PNG
            </button>
            <button
              onClick={() => onSave("jpeg")}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-green-500 hover:bg-green-600 text-white text-xs"
            >
              <FileImage className="w-3.5 h-3.5" />
              JPEG
            </button>
            <button
              onClick={() => onSave("pdf")}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-xs"
            >
              <FileText className="w-3.5 h-3.5" />
              PDF
            </button>
          </>
        )}
        {isVideo && (
          <button
            onClick={() => onSave(format!)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-xs"
          >
            <Save className="w-3.5 h-3.5" />
            保存
          </button>
        )}
      </div>
    </div>
  );
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
