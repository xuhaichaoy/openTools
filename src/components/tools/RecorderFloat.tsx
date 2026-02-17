import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";
import { Circle, Square, Pause, Play } from "lucide-react";

interface RecorderFloatProps {
  format: string;
  onStopped: (outputPath: string) => void;
}

/**
 * 录制控制浮窗
 * 显示录制状态、时长计时器、暂停/停止按钮
 */
export function RecorderFloat({ format, onStopped }: RecorderFloatProps) {
  const [duration, setDuration] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [frameCount, setFrameCount] = useState(0);

  // 计时器
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isPaused) {
        setDuration(d => d + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isPaused]);

  const handlePause = async () => {
    try {
      const result = await invoke<unknown>("screen_capture_call", {
        method: "recorder_pause",
        params: {},
      });
      setIsPaused(!isPaused);
    } catch (e) {
      handleError(e, { context: "暂停录制" });
    }
  };

  const handleStop = async () => {
    try {
      await invoke("screen_capture_call", {
        method: "recorder_stop",
        params: {},
      });
    } catch (e) {
      handleError(e, { context: "停止录制" });
    }
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-full bg-gray-900/95 backdrop-blur border border-gray-700 shadow-2xl">
      {/* 录制指示 */}
      <div className="flex items-center gap-2">
        <Circle
          className={`w-3 h-3 ${isPaused ? "text-yellow-400" : "text-red-500 animate-pulse"}`}
          fill="currentColor"
        />
        <span className="text-sm font-mono text-white">{formatTime(duration)}</span>
        <span className="text-[10px] text-gray-400 uppercase">{format}</span>
      </div>

      {/* 分隔线 */}
      <div className="w-px h-5 bg-gray-600" />

      {/* 暂停/恢复 */}
      <button
        onClick={handlePause}
        className="p-1.5 rounded-full hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
        title={isPaused ? "继续" : "暂停"}
      >
        {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
      </button>

      {/* 停止 */}
      <button
        onClick={handleStop}
        className="p-1.5 rounded-full bg-red-500 hover:bg-red-600 text-white transition-colors"
        title="停止录制"
      >
        <Square className="w-4 h-4" />
      </button>
    </div>
  );
}
