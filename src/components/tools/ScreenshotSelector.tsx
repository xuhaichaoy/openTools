import React, { useState, useEffect, useCallback, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// @ts-ignore
import Screenshots from "react-screenshots";
import "./react-screenshots.css";

interface ScreenshotData {
  path: string;
  base64?: string;
  width: number;
  height: number;
}

export function ScreenshotSelector() {
  const [screenshotData, setScreenshotData] = useState<ScreenshotData | null>(
    null,
  );

  // 窗口就绪信号 & 获取初始数据（处理 reload 情况）
  useEffect(() => {
    invoke("screenshot_window_ready").catch(console.error);
    invoke<ScreenshotData>("get_last_screenshot")
      .then((data) => {
        if (data) {
          console.log("Loaded last screenshot data:", data);
          setScreenshotData(data);
        }
      })
      .catch((err) => {
        console.error("Failed to load last screenshot:", err);
      });
  }, []);

  // 监听截图开始
  useEffect(() => {
    const unlisten = listen("screenshot-start", () => {
      console.log("Screenshot started");
      setScreenshotData(null);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 监听截图数据
  useEffect(() => {
    const unlisten = listen<ScreenshotData>("screenshot-data", (event) => {
      console.log("Received screenshot data:", event.payload);
      setScreenshotData(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleFinish = async (action: string, base64: string) => {
    try {
      await invoke("finish_capture", {
        x: 0,
        y: 0,
        width: screenshotData?.width || 0,
        height: screenshotData?.height || 0,
        action,
        annotated_image: base64,
        copyToClipboard: action === "copy",
      });
    } catch (err) {
      console.error("Finish capture failed:", err);
    }
  };

  const onCancel = useCallback(() => {
    invoke("cancel_capture").catch(console.error);
  }, []);

  const onOk = useCallback(
    (cancel: any, blob: Blob) => {
      // blob 转 base64
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        handleFinish("copy", base64);
      };
      reader.readAsDataURL(blob);
    },
    [handleFinish],
  );

  const onSave = useCallback(
    (cancel: any, blob: Blob) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        handleFinish("save", base64);
      };
      reader.readAsDataURL(blob);
    },
    [handleFinish],
  );

  // 图片 URL
  const imageUrl = useMemo(() => {
    if (!screenshotData) return "";
    if (screenshotData.base64) return screenshotData.base64;
    return convertFileSrc(screenshotData.path);
  }, [screenshotData]);

  if (!imageUrl || !screenshotData) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center text-white">
        <p>Waiting for screenshot data...</p>
      </div>
    );
  }

  return (
    <div className="w-screen h-screen fixed inset-0 bg-black z-50 overflow-hidden">
      <Screenshots
        url={imageUrl}
        width={window.innerWidth}
        height={window.innerHeight}
        lang={{
          operation_undo_title: "撤销",
          operation_mosaic_title: "马赛克",
          operation_text_title: "文本",
          operation_brush_title: "画笔",
          operation_arrow_title: "箭头",
          operation_ellipse_title: "椭圆",
          operation_rectangle_title: "矩形",
          operation_ok_title: "完成",
          operation_cancel_title: "取消",
          operation_save_title: "保存",
          operation_redo_title: "重做",
        }}
        onCancel={onCancel}
        onOk={onOk}
        onSave={onSave}
      />
    </div>
  );
}
