import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  Camera,
  ScrollText,
  Video,
  Monitor,
  AppWindow,
  Download,
  Loader2,
  Check,
  Save,
  Copy,
  FileImage,
  FileText,
  X,
  RefreshCw,
  Square,
  Pause,
  Play,
  Circle,
} from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";
import { RecorderFloat } from "./RecorderFloat";

interface ScreenCaptureProps {
  onBack?: () => void;
}

type Mode = "screenshot" | "long-screenshot" | "recording";
type CaptureStep =
  | "idle"
  | "downloading"
  | "selecting"
  | "capturing"
  | "preview";

interface MonitorInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale_factor: number;
  is_primary: boolean;
}

interface WindowInfo {
  id: number;
  title: string;
  app_name: string;
  width: number;
  height: number;
  thumbnail: string | null;
}

interface ComponentStatus {
  helper_installed: boolean;
  helper_path: string;
  ffmpeg_installed: boolean;
  ffmpeg_path: string;
}

export function ScreenCapture({ onBack }: ScreenCaptureProps) {
  const { onMouseDown } = useDragWindow();
  const [mode, setMode] = useState<Mode>("screenshot");
  const [step, setStep] = useState<CaptureStep>("idle");
  const [status, setStatus] = useState<ComponentStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState("");

  // 截图相关
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedMonitor, setSelectedMonitor] = useState<number | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 录制相关
  const [recordFormat, setRecordFormat] = useState<"mp4" | "gif">("gif");
  const [recordFps, setRecordFps] = useState(15);
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 检查组件状态
  useEffect(() => {
    checkStatus();
  }, []);

  // 预创建隐藏的截图窗口（参考 eSearch 预创建 clip 窗口的做法）
  // 用户点击区域截图时无需再创建窗口，直接发送数据并显示
  useEffect(() => {
    invoke("init_screenshot_window").catch(() => {});
  }, []);

  // 监听 helper 事件（录屏完成等）
  useEffect(() => {
    const unlisten = listen<{
      event?: string;
      data?: { output_path?: string; duration_secs?: number };
    }>("screen-capture-event", (e) => {
      const payload = e.payload;
      if (payload?.event === "recorder_done" && payload.data?.output_path) {
        if (recordTimerRef.current) {
          clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        setIsRecording(false);
        setResultPath(payload.data.output_path);
        setStep("preview");
      }
      if (
        payload?.event === "recorder_status" &&
        payload.data?.duration_secs != null
      ) {
        setRecordDuration(Math.floor(payload.data.duration_secs));
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 监听区域截图完成事件（从截图选区窗口返回），根据 action 分发
  useEffect(() => {
    const unlisten = listen<{ path?: string; action?: string }>("capture-done", async (e) => {
      const { path: capPath, action: capAction } = e.payload || {};
      if (!capPath) return;

      switch (capAction) {
        case "ocr": {
          // 通过事件总线通知 OCR 插件处理
          const bc = new BroadcastChannel("mtools-events");
          bc.postMessage({ type: "OCR_REQUEST", payload: { imagePath: capPath } });
          bc.close();
          // 导航到 OCR 结果（emit 给 App 层切换视图）
          window.dispatchEvent(new CustomEvent("navigate-plugin", { detail: { viewId: "screen-capture", action: "ocr", path: capPath } }));
          break;
        }
        case "pin": {
          // 调用贴图 ding 命令
          try {
            await invoke("ding_create", { imagePath: capPath });
          } catch (err) {
            console.error("贴图失败:", err);
          }
          break;
        }
        case "edit": {
          // 通过事件总线通知图片编辑器
          const bc = new BroadcastChannel("mtools-events");
          bc.postMessage({ type: "EDIT_IMAGE_REQUEST", payload: { imagePath: capPath } });
          bc.close();
          break;
        }
        case "save": {
          // 弹出保存对话框
          try {
            const filePath = await save({
              defaultPath: `screenshot-${Date.now()}.png`,
              filters: [{ name: "PNG", extensions: ["png"] }],
            });
            if (filePath) {
              // 复制文件到目标位置
              const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
              const data = await readFile(capPath);
              await writeFile(filePath, data);
            }
          } catch (err) {
            console.error("保存截图失败:", err);
          }
          break;
        }
        case "copy":
        default: {
          // 默认行为：显示预览
          setResultPath(capPath);
          setStep("preview");
          break;
        }
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Debug: 监听 screenshot-data 事件
  useEffect(() => {
    const unlisten = listen("screenshot-data", (e) => {
      console.log(
        "主窗口收到 screenshot-data 事件 (虽然不应该由主窗口处理):",
        e,
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const checkStatus = async () => {
    try {
      const s = await invoke<ComponentStatus>("screen_capture_check");
      setStatus(s);
    } catch (e) {
      setError(String(e));
    }
  };

  // 下载 helper
  const handleDownload = async () => {
    setDownloading(true);
    setDownloadProgress("正在下载截图录屏组件...");
    try {
      await invoke("screen_capture_download", { component: "helper" });
      setDownloadProgress("下载完成！");
      await checkStatus();
    } catch (e) {
      setError(String(e));
      setDownloadProgress("");
    } finally {
      setDownloading(false);
    }
  };

  // 下载 ffmpeg
  const handleDownloadFfmpeg = async () => {
    setDownloading(true);
    setDownloadProgress("正在下载 ffmpeg 视频编码器...");
    try {
      await invoke("screen_capture_download", { component: "ffmpeg" });
      setDownloadProgress("ffmpeg 下载完成！");
      await checkStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
    }
  };

  // 调用 helper
  const callHelper = async (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    return await invoke<unknown>("screen_capture_call", { method, params });
  };

  // 加载显示器列表
  const loadMonitors = async () => {
    try {
      const list = (await callHelper("list_monitors")) as MonitorInfo[];
      setMonitors(list);
      const primary = list.find((m) => m.is_primary);
      if (primary) setSelectedMonitor(primary.id);
    } catch (e) {
      setError(String(e));
    }
  };

  // 加载窗口列表
  const loadWindows = async () => {
    try {
      // 优先尝试使用 Native Xcap (修复 helper 拼接 bug)
      // 如果 backend 未实现 list_windows_xcap，会抛错，catch 中回退到 helper (或者直接报错)
      // 由于我们刚刚添加了 backend 命令，这里直接使用
      const list = await invoke<WindowInfo[]>("list_windows_xcap");
      setWindows(list);
    } catch (e) {
      console.warn("Native list_windows_xcap failed, trying helper...", e);
      try {
        const list = (await callHelper("list_windows")) as WindowInfo[];
        setWindows(list);
      } catch (e2) {
        setError(String(e2));
      }
    }
  };

  // 初始化数据
  useEffect(() => {
    if (status?.helper_installed) {
      loadMonitors();
      if (mode === "long-screenshot" || mode === "recording") {
        loadWindows();
      }
    }
  }, [status?.helper_installed, mode]);

  // 全屏截图（先隐藏窗口再截，避免截到弹窗）
  const handleScreenshot = async () => {
    setStep("capturing");
    setError(null);
    try {
      await invoke("hide_window");
      await new Promise((r) => setTimeout(r, 500));
      try {
        const result = (await callHelper("capture_fullscreen", {
          monitor_id: selectedMonitor,
        })) as { path: string };
        setResultPath(result.path);
        setStep("preview");
      } finally {
        await invoke("show_window_cmd");
      }
    } catch (e) {
      setError(String(e));
      setStep("idle");
      await invoke("show_window_cmd").catch(() => {});
    }
  };

  // 区域截图：截取全屏 → 打开截图选区窗口，在静态截图上框选（微信/钉钉方案）
  const handleRegionScreenshot = async () => {
    console.log("开始区域截图流程...");
    setError(null);
    try {
      console.log("调用 backend start_capture command...");
      const res = await invoke("start_capture", { monitorId: selectedMonitor });
      console.log("start_capture 返回成功:", res);
    } catch (e) {
      console.error("start_capture 失败:", e);
      setError(String(e));
    }
  };

  // 窗口截图
  const handleWindowCapture = async (windowId: number) => {
    setStep("capturing");
    setError(null);
    try {
      // 尝试 Native Capture
      const path = await invoke<string>("capture_window_xcap_by_id", {
        windowId,
      });
      setResultPath(path);
      setStep("preview");
    } catch (e) {
      console.warn("Native capture failed, trying helper...", e);
      try {
        const result = (await callHelper("capture_window", {
          window_id: windowId,
        })) as { path: string };
        setResultPath(result.path);
        setStep("preview");
      } catch (e2) {
        setError(String(e2));
        setStep("idle");
      }
    }
  };

  // 滚动长截图
  const handleScrollCapture = async (windowId: number) => {
    setStep("capturing");
    setError(null);
    try {
      const result = (await callHelper("scroll_capture", {
        window_id: windowId,
        max_scrolls: 50,
        scroll_delay_ms: 400,
      })) as { path: string };
      setResultPath(result.path);
      setStep("preview");
    } catch (e) {
      const msg = String(e);
      if (
        /permission|模拟|输入模拟|simulate|accessibility|辅助功能/i.test(msg)
      ) {
        setError(
          "长截图需要「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能 → 添加本应用（mTools）后重试。",
        );
      } else {
        setError(msg);
      }
      setStep("idle");
    }
  };

  // 保存文件
  const handleSave = async (format: string) => {
    if (!resultPath) return;
    try {
      const ext = format === "pdf" ? "pdf" : format === "jpeg" ? "jpg" : "png";
      const filePath = await save({
        defaultPath: `screenshot.${ext}`,
        filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      });
      if (filePath) {
        await callHelper("save", {
          source_path: resultPath,
          target_path: filePath,
          format,
          quality: 90,
          pdf_mode: "single_page",
        });
      }
    } catch (e) {
      setError(String(e));
    }
  };

  // 开始录制（完成事件由 screen-capture-event 统一处理）
  const handleStartRecording = async () => {
    if (recordFormat === "mp4" && !status?.ffmpeg_installed) {
      handleDownloadFfmpeg();
      return;
    }
    setIsRecording(true);
    setRecordDuration(0);
    setError(null);
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    try {
      await callHelper("recorder_start", {
        target: { type: "fullscreen", monitor_id: selectedMonitor },
        fps: recordFps,
        format: recordFormat,
        max_width: recordFormat === "gif" ? 640 : undefined,
      });
      recordTimerRef.current = setInterval(() => {
        setRecordDuration((d) => d + 1);
      }, 1000);
    } catch (e) {
      setError(String(e));
      setIsRecording(false);
    }
  };

  // 停止录制
  const handleStopRecording = async () => {
    try {
      await callHelper("recorder_stop");
    } catch (e) {
      setError(String(e));
    }
  };

  // ===== 渲染 =====

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
          { key: "long-screenshot" as Mode, icon: ScrollText, label: "长截图" },
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
              {mode === "long-screenshot" ? "正在滚动截取..." : "正在截图..."}
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
                  <WindowList
                    windows={windows}
                    onSelect={handleWindowCapture}
                  />
                </div>
              </div>
            )}

            {/* 长截图模式 */}
            {mode === "long-screenshot" && (
              <div>
                <p className="text-xs text-[var(--color-text-secondary)] mb-3">
                  选择要滚动截取的窗口，工具将自动滚动并拼接为一张长图
                </p>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[10px] text-[var(--color-text-secondary)]">
                    选择窗口
                  </label>
                  <button
                    onClick={loadWindows}
                    className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    刷新
                  </button>
                </div>
                <WindowList
                  windows={windows}
                  onSelect={handleScrollCapture}
                  actionLabel="长截图"
                />
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

// ===== 子组件 =====

function Header({
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

function WindowList({
  windows,
  onSelect,
  actionLabel = "截图",
}: {
  windows: WindowInfo[];
  onSelect: (id: number) => void;
  actionLabel?: string;
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
        <button
          key={w.id}
          onClick={() => onSelect(w.id)}
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
          <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
            {actionLabel} →
          </span>
        </button>
      ))}
    </div>
  );
}

function PreviewPanel({
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
          <img
            src={`mtplugin://localhost${path}?t=${new Date().getTime()}`}
            className="w-full"
            alt="截图预览"
          />
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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
