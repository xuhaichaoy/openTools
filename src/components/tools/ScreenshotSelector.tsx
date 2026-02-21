import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { handleError } from "@/core/errors";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Screenshots from "react-screenshots";
import "./react-screenshots.css";

interface ScreenshotData {
  path: string;
  base64?: string;
  width: number;
  height: number;
}

type ScreenshotAction = "pin" | "ocr";

declare global {
  interface Window {
    __screenshot_action__?: ScreenshotAction;
  }
}

// Pin 图标组件
function PinIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="18"
      height="18"
    >
      <path
        fill="currentColor"
        d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1.03 1 1.03-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"
      />
    </svg>
  );
}

// OCR 图标组件
function OcrIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="18"
      height="18"
    >
      <path
        fill="currentColor"
        d="M3 5v4h2V5h4V3H5a2 2 0 00-2 2zm2 10H3v4a2 2 0 002 2h4v-2H5v-4zm14 4h-4v2h4a2 2 0 002-2v-4h-2v4zm0-16h-4v2h4v4h2V5a2 2 0 00-2-2zM12 15h-2V9h-2V7h6v2h-2v6z"
      />
    </svg>
  );
}

// 工具栏扩展组件：通过 React Portal 将 Pin/OCR 按钮注入到截图工具栏
function ToolbarExtension({
  onPinClick,
  onOcrClick,
}: {
  onPinClick: () => void;
  onOcrClick: () => void;
}) {
  const portalContainerRef = useRef<HTMLDivElement | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
    null,
  );

  useEffect(() => {
    const tryInject = () => {
      // 如果已经注入且容器还在 DOM 中，跳过
      if (
        portalContainerRef.current &&
        portalContainerRef.current.parentElement
      ) {
        return;
      }

      // 容器被移出 DOM，需要重新注入
      if (
        portalContainerRef.current &&
        !portalContainerRef.current.parentElement
      ) {
        portalContainerRef.current = null;
        setPortalContainer(null);
      }

      // 全局搜索工具栏
      const toolbar = document.querySelector(".screenshots-operations-buttons");
      if (!toolbar) return;

      // 跳过已经有自定义按钮的工具栏
      if (toolbar.querySelector("[data-custom-toolbar]")) return;

      // 通过 title 属性找到保存按钮（优先），或通过 icon class 找
      let insertBefore: Element | null = toolbar.querySelector(
        '.screenshots-button[title="保存"]',
      );
      if (!insertBefore) {
        const saveIcon = toolbar.querySelector(".icon-save");
        insertBefore = saveIcon?.closest(".screenshots-button") || null;
      }
      if (!insertBefore) return;

      // 创建 portal 容器（display:contents 使其子元素直接参与 flex 布局）
      const container = document.createElement("div");
      container.style.display = "contents";
      container.setAttribute("data-custom-toolbar", "true");
      toolbar.insertBefore(container, insertBefore);
      portalContainerRef.current = container;
      setPortalContainer(container);
    };

    // 每 150ms 轮询检查
    const intervalId = window.setInterval(tryInject, 150);
    // 立即尝试一次
    tryInject();

    return () => {
      window.clearInterval(intervalId);
      if (portalContainerRef.current) {
        portalContainerRef.current.remove();
        portalContainerRef.current = null;
      }
      setPortalContainer(null);
    };
  }, []);

  if (!portalContainer) return null;

  return createPortal(
    <>
      <div className="screenshots-operations-divider" />
      <div
        className="screenshots-button custom-toolbar-btn"
        title="贴图"
        onClick={onPinClick}
      >
        <PinIcon />
      </div>
      <div
        className="screenshots-button custom-toolbar-btn"
        title="OCR"
        onClick={onOcrClick}
      >
        <OcrIcon />
      </div>
    </>,
    portalContainer,
  );
}

export function ScreenshotSelector() {
  const [screenshotData, setScreenshotData] = useState<ScreenshotData | null>(
    null,
  );

  // 窗口就绪信号 & 获取初始数据（处理 reload 情况）
  useEffect(() => {
    invoke("screenshot_window_ready").catch((e) => handleError(e, { context: "截图窗口就绪", silent: true }));
    invoke<ScreenshotData>("get_last_screenshot")
      .then((data) => {
        if (data) {
          console.log("Loaded last screenshot data:", data);
          setScreenshotData(data);
        }
      })
      .catch((err) => {
        handleError(err, { context: "加载上次截图数据", silent: true });
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

  const handleFinish = useCallback(
    async (action: string, base64: string) => {
      try {
        await invoke("finish_capture", {
          x: 0,
          y: 0,
          width: screenshotData?.width || 0,
          height: screenshotData?.height || 0,
          action,
          annotatedImage: base64,
          copyToClipboard: action === "copy",
        });
      } catch (err) {
        handleError(err, { context: "完成截图" });
      }
    },
    [screenshotData],
  );

  // 将 blob 转 base64 并调用 handleFinish
  const blobToFinish = useCallback(
    (action: string, blob: Blob) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        handleFinish(action, base64);
      };
      reader.readAsDataURL(blob);
    },
    [handleFinish],
  );

  const onCancel = useCallback(() => {
    invoke("cancel_capture").catch((e) => handleError(e, { context: "取消截图", silent: true }));
  }, []);

  const onOk = useCallback(
    (blob: Blob) => {
      blobToFinish("copy", blob);
    },
    [blobToFinish],
  );

  const onSave = useCallback(
    (blob: Blob) => {
      blobToFinish("save", blob);
    },
    [blobToFinish],
  );

  const onPin = useCallback(
    (blob: Blob) => {
      blobToFinish("pin", blob);
    },
    [blobToFinish],
  );

  const onOcr = useCallback(
    (blob: Blob) => {
      blobToFinish("ocr", blob);
    },
    [blobToFinish],
  );

  // Pin/OCR 按钮点击：piggyback on OK 按钮来 compose image
  const handleCustomButtonClick = useCallback(
    (action: ScreenshotAction) => {
      const okButton = document.querySelector<HTMLElement>(
        '.screenshots-button[title="完成"]',
      );
      if (okButton) {
        window.__screenshot_action__ = action;
        okButton.click();
      }
    },
    [],
  );

  // 图片 URL
  const imageUrl = useMemo(() => {
    if (!screenshotData) return "";
    if (screenshotData.base64) return screenshotData.base64;
    return convertFileSrc(screenshotData.path);
  }, [screenshotData]);

  // 包装 onOk，支持通过 __screenshot_action__ 触发不同操作
  const wrappedOnOk = useCallback(
    (blob: Blob) => {
      const action = window.__screenshot_action__;
      delete window.__screenshot_action__;

      if (action === "pin") {
        onPin(blob);
      } else if (action === "ocr") {
        onOcr(blob);
      } else {
        onOk(blob);
      }
    },
    [onOk, onPin, onOcr],
  );

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
        onOk={wrappedOnOk}
        onSave={onSave}
        onPin={onPin}
        onOcr={onOcr}
      />
      <ToolbarExtension
        onPinClick={() => handleCustomButtonClick("pin")}
        onOcrClick={() => handleCustomButtonClick("ocr")}
      />
    </div>
  );
}
