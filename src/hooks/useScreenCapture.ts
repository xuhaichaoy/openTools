import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleError, ErrorLevel } from "@/core/errors";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { APP_NAME } from "@/config/app-branding";

export type Mode = "screenshot" | "recording";
export type CaptureStep =
  | "idle"
  | "downloading"
  | "selecting"
  | "capturing"
  | "preview";

export interface MonitorInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale_factor: number;
  is_primary: boolean;
}

export interface WindowInfo {
  id: number;
  title: string;
  app_name: string;
  width: number;
  height: number;
  thumbnail: string | null;
}

export interface ComponentStatus {
  helper_installed: boolean;
  helper_path: string;
  ffmpeg_installed: boolean;
  ffmpeg_path: string;
}

export function useScreenCapture() {
  const [mode, setMode] = useState<Mode>("screenshot");
  const [step, setStep] = useState<CaptureStep>("idle");
  const [status, setStatus] = useState<ComponentStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState("");

  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedMonitor, setSelectedMonitor] = useState<number | null>(null);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [recordFormat, setRecordFormat] = useState<"mp4" | "gif">("gif");
  const [recordFps, setRecordFps] = useState(15);
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 检查组件状态
  useEffect(() => {
    checkStatus();
  }, []);

  // 预创建隐藏的截图窗口
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

  // 监听区域截图完成事件
  useEffect(() => {
    const unlisten = listen<{ path?: string; action?: string }>(
      "capture-done",
      async (e) => {
        const { path: capPath, action: capAction } = e.payload || {};
        if (!capPath) return;

        switch (capAction) {
          case "ocr":
          case "pin":
            break;
          case "edit": {
            const bc = new BroadcastChannel("mtools-events");
            bc.postMessage({
              type: "EDIT_IMAGE_REQUEST",
              payload: { imagePath: capPath },
            });
            bc.close();
            break;
          }
          case "save": {
            try {
              const { save } = await import("@tauri-apps/plugin-dialog");
              const filePath = await save({
                defaultPath: `screenshot-${Date.now()}.png`,
                filters: [{ name: "PNG", extensions: ["png"] }],
              });
              if (filePath) {
                const { readFile, writeFile } =
                  await import("@tauri-apps/plugin-fs");
                const data = await readFile(capPath);
                await writeFile(filePath, data);
              }
            } catch (err) {
              handleError(err, { context: "保存截图" });
            }
            break;
          }
          case "copy":
          default: {
            setResultPath(capPath);
            setStep("preview");
            break;
          }
        }
      },
    );
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

  const callHelper = async (
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    return await invoke<unknown>("screen_capture_call", { method, params });
  };

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

  const loadWindows = async () => {
    try {
      const list = await invoke<WindowInfo[]>("list_windows_xcap");
      setWindows(list);
    } catch (e) {
      handleError(e, { context: "获取窗口列表", level: ErrorLevel.Warning, silent: true });
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
      loadWindows();
    }
  }, [status?.helper_installed]);

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

  const handleRegionScreenshot = async () => {
    console.log("开始区域截图流程...");
    setError(null);
    try {
      console.log("调用 backend start_capture command...");
      const res = await invoke("start_capture", { monitorId: selectedMonitor });
      console.log("start_capture 返回成功:", res);
    } catch (e) {
      handleError(e, { context: "区域截图" });
      setError(String(e));
    }
  };

  const handleWindowCapture = async (windowId: number) => {
    setStep("capturing");
    setError(null);
    try {
      const path = await invoke<string>("capture_window_xcap_by_id", {
        windowId,
      });
      setResultPath(path);
      setStep("preview");
    } catch (e) {
      handleError(e, { context: "窗口截图", level: ErrorLevel.Warning, silent: true });
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
          `长截图需要「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能 → 添加本应用（${APP_NAME}）后重试。`,
        );
      } else {
        setError(msg);
      }
      setStep("idle");
    }
  };

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

  const handleStopRecording = async () => {
    try {
      await callHelper("recorder_stop");
    } catch (e) {
      setError(String(e));
    }
  };

  return {
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
  };
}
