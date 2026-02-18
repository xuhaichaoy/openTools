/**
 * 截图处理 Hook — 全局监听截图完成事件
 * 从 App.tsx 提取的截图事件处理逻辑（OCR/贴图/复制）
 */

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";
import {
  emitPluginEvent,
  PluginEventTypes,
} from "@/core/plugin-system/event-bus";

// 去重引用（跨 StrictMode / 重复监听共享）
const lastCaptureHandledRef =
  (window as any).__LAST_CAPTURE_HANDLED_REF__ ||
  ((window as any).__LAST_CAPTURE_HANDLED_REF__ = { key: "", ts: 0 });

/**
 * 监听截图完成事件，处理 OCR / 贴图 / 复制等后续动作
 */
export function useScreenshotHandler(pushView: (v: string) => void) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    listen<{
      path?: string;
      action?: string;
      imageBase64?: string;
      imageWidth?: number;
      imageHeight?: number;
    }>("capture-done", async (e) => {
      const {
        path: capPath,
        action,
        imageBase64,
        imageWidth,
        imageHeight,
      } = e.payload || {};
      if (!capPath) return;

      // 去重
      const key = `${action || "copy"}|${capPath}`;
      const now = Date.now();
      if (
        lastCaptureHandledRef.key === key &&
        now - lastCaptureHandledRef.ts < 1200
      ) {
        return;
      }
      lastCaptureHandledRef.key = key;
      lastCaptureHandledRef.ts = now;

      if (action === "pin") {
        try {
          if (!imageBase64) {
            console.warn("pin 缺少 imageBase64，跳过");
            return;
          }
          const srcW = Math.max(1, imageWidth || 300);
          const srcH = Math.max(1, imageHeight || 300);
          const maxW = 560;
          const maxH = 420;
          const scale = Math.min(maxW / srcW, maxH / srcH, 1);
          const width = Math.round(srcW * scale);
          const height = Math.round(srcH * scale);
          await invoke("ding_create", {
            imageBase64,
            x: 100.0,
            y: 100.0,
            width,
            height,
          });
        } catch (err) {
          handleError(err, { context: "全局贴图" });
        }
        return;
      }

      if (action === "ocr") {
        try {
          if (!imageBase64) {
            console.warn("ocr 缺少 imageBase64，跳过");
            return;
          }
          (window as any).__PENDING_OCR_IMAGE__ = imageBase64;
          pushView("ocr");
          setTimeout(() => {
            emitPluginEvent(
              PluginEventTypes.SCREENSHOT_CAPTURED,
              "screen-capture",
              { imageBase64 },
            );
          }, 80);
        } catch (err) {
          handleError(err, { context: "全局OCR处理" });
        }
      }
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [pushView]);
}
