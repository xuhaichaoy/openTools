import {
  Camera,
  Video,
  Monitor,
  Download,
  Loader2,
  X,
  RefreshCw,
  Square,
  Circle,
} from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";
import { RecorderFloat } from "./RecorderFloat";
import { useScreenCapture } from "@/hooks/useScreenCapture";
import type { Mode } from "@/hooks/useScreenCapture";
import { Header, WindowList, PreviewPanel, formatDuration } from "./ScreenCaptureWidgets";

interface ScreenCaptureProps {
  onBack?: () => void;
}

export function ScreenCapture({ onBack }: ScreenCaptureProps) {
  const { onMouseDown } = useDragWindow();
  const {
    mode, setMode,
    step, setStep,
    status,
    checkStatus,
    downloading,
    downloadProgress,
    monitors,
    windows,
    selectedMonitor, setSelectedMonitor,
    resultPath, setResultPath,
    error, setError,
    recordFormat, setRecordFormat,
    recordFps, setRecordFps,
    isRecording,
    recordDuration,
    handleDownload,
    handleScreenshot,
    handleRegionScreenshot,
    handleWindowCapture,
    handleScrollCapture,
    handleSave,
    handleStartRecording,
    handleStopRecording,
    loadWindows,
  } = useScreenCapture();

  // 未下载状态
  if (!status || !status.helper_installed) {
    return (
      <div className="flex flex-col h-full bg-[var(--color-bg)]">
        <Header onBack={onBack} onMouseDown={onMouseDown} />
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4">
          <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center">
            <Camera className="w-8 h-8 text-blue-400" />
          </div>
          <h3 className="text-base font-medium text-[var(--color-text)]">
            截图录屏工具
          </h3>
          <p className="text-xs text-[var(--color-text-secondary)] text-center max-w-[280px]">
            支持区域截图、滚动长截图、屏幕录制（GIF/MP4），导出 PNG/JPEG/PDF
            格式
          </p>
          <div className="flex flex-col items-center gap-2 mt-2">
            {downloading ? (
              <div className="flex items-center gap-2 text-sm text-blue-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{downloadProgress}</span>
              </div>
            ) : (
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm transition-colors"
              >
                <Download className="w-4 h-4" />
                下载组件（约 15MB）
              </button>
            )}
            {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
            <button
              type="button"
              onClick={() => checkStatus()}
              className="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] mt-1 underline"
            >
              若已本地安装或已复制到 bin，点击重新检测
            </button>
          </div>
          <div className="mt-4 text-[10px] text-[var(--color-text-secondary)] space-y-1">
            <p>• 首次使用需下载截图录屏引擎</p>
            <p>• MP4 录制需额外下载 ffmpeg（约 70MB）</p>
            <p>• GIF 录制无需额外下载</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <Header onBack={onBack} onMouseDown={onMouseDown} />

      {/* 录制浮层 */}
      {isRecording && (
        <RecorderFloat
          format={recordFormat.toUpperCase()}
          onStopped={() => {}}
        />
      )}

      {/* 模式 Tab */}
      <div className="flex border-b border-[var(--color-border)]">
        {[
          { key: "screenshot" as Mode, icon: Camera, label: "截图" },
          { key: "recording" as Mode, icon: Video, label: "录屏" },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setMode(tab.key);
              setStep("idle");
              setResultPath(null);
              setError(null);
            }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              mode === tab.key
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-3 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-center gap-2">
            <X className="w-3.5 h-3.5 flex-shrink-0" />
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-300 hover:text-red-200"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {step === "preview" && resultPath ? (
          <PreviewPanel
            path={resultPath}
            format={mode === "recording" ? recordFormat : undefined}
            onSave={handleSave}
            onBack={() => {
              setStep("idle");
              setResultPath(null);
            }}
          />
        ) : step === "capturing" ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
            <p className="text-sm text-[var(--color-text-secondary)]">
              正在截图...
            </p>
          </div>
        ) : (
          <>
            {/* 显示器选择 */}
            {monitors.length > 1 &&
              (mode === "screenshot" || mode === "recording") && (
                <div className="mb-3">
                  <label className="text-[10px] text-[var(--color-text-secondary)] mb-1.5 block">
                    显示器
                  </label>
                  <div className="flex gap-2">
                    {monitors.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setSelectedMonitor(m.id)}
                        className={`flex-1 p-2 rounded-lg border text-xs text-center transition-colors ${
                          selectedMonitor === m.id
                            ? "border-blue-500 bg-blue-500/10 text-blue-400"
                            : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]"
                        }`}
                      >
                        <Monitor className="w-4 h-4 mx-auto mb-1" />
                        <div>{m.name}</div>
                        <div className="text-[10px] opacity-60">
                          {m.width}x{m.height}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

            {/* 截图模式 */}
            {mode === "screenshot" && (
              <div className="space-y-3">
                <button
                  onClick={handleScreenshot}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] transition-colors"
                >
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                    <Monitor className="w-5 h-5 text-blue-400" />
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-[var(--color-text)]">
                      全屏截图
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      截取整个屏幕（会先隐藏本窗口）
                    </div>
                  </div>
                </button>

                <button
                  onClick={handleRegionScreenshot}
                  className="w-full flex items-center gap-3 p-3 rounded-xl bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] transition-colors"
                >
                  <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center">
                    <Camera className="w-5 h-5 text-green-400" />
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium text-[var(--color-text)]">
                      区域截图
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]">
                      在桌面上直接框选区域截图
                    </div>
                  </div>
                </button>

                {/* 窗口截图列表 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[10px] text-[var(--color-text-secondary)]">
                      窗口截图
                    </label>
                    <button
                      onClick={loadWindows}
                      className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                    >
                      <RefreshCw className="w-3 h-3" />
                      刷新
                    </button>
                  </div>
                  <p className="text-[10px] text-[var(--color-text-secondary)] mb-2">
                    选择窗口进行截图，或使用长截图自动滚动拼接
                  </p>
                  <WindowList
                    windows={windows}
                    onSelect={handleWindowCapture}
                    onScrollCapture={handleScrollCapture}
                  />
                </div>
              </div>
            )}

            {/* 录屏模式 */}
            {mode === "recording" && (
              <div className="space-y-3">
                {/* 格式选择 */}
                <div>
                  <label className="text-[10px] text-[var(--color-text-secondary)] mb-1.5 block">
                    录制格式
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setRecordFormat("gif")}
                      className={`flex-1 p-2 rounded-lg border text-xs text-center transition-colors ${
                        recordFormat === "gif"
                          ? "border-green-500 bg-green-500/10 text-green-400"
                          : "border-[var(--color-border)] text-[var(--color-text-secondary)]"
                      }`}
                    >
                      <div className="font-medium">GIF</div>
                      <div className="text-[10px] opacity-60 mt-0.5">
                        适合短录制，无需额外下载
                      </div>
                    </button>
                    <button
                      onClick={() => setRecordFormat("mp4")}
                      className={`flex-1 p-2 rounded-lg border text-xs text-center transition-colors ${
                        recordFormat === "mp4"
                          ? "border-purple-500 bg-purple-500/10 text-purple-400"
                          : "border-[var(--color-border)] text-[var(--color-text-secondary)]"
                      }`}
                    >
                      <div className="font-medium">MP4</div>
                      <div className="text-[10px] opacity-60 mt-0.5">
                        {status.ffmpeg_installed
                          ? "H.264 高质量"
                          : "需下载 ffmpeg (70MB)"}
                      </div>
                    </button>
                  </div>
                </div>

                {/* FPS */}
                <div>
                  <label className="text-[10px] text-[var(--color-text-secondary)] mb-1.5 block">
                    帧率
                  </label>
                  <div className="flex gap-2">
                    {[10, 15, 24, 30].map((fps) => (
                      <button
                        key={fps}
                        onClick={() => setRecordFps(fps)}
                        className={`flex-1 py-1.5 rounded-lg border text-xs text-center transition-colors ${
                          recordFps === fps
                            ? "border-blue-500 bg-blue-500/10 text-blue-400"
                            : "border-[var(--color-border)] text-[var(--color-text-secondary)]"
                        }`}
                      >
                        {fps} FPS
                      </button>
                    ))}
                  </div>
                </div>

                {/* 录制按钮 */}
                {isRecording ? (
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20">
                    <Circle className="w-4 h-4 text-red-400 animate-pulse" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-red-400">
                        正在录制
                      </div>
                      <div className="text-[10px] text-red-300">
                        {formatDuration(recordDuration)}
                      </div>
                    </div>
                    <button
                      onClick={handleStopRecording}
                      className="px-3 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-xs"
                    >
                      <Square className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleStartRecording}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors"
                  >
                    <Circle className="w-4 h-4" />
                    开始录制
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
