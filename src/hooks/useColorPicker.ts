import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";

type EyeDropperResult = { sRGBHex: string };
type EyeDropperLike = { open: () => Promise<EyeDropperResult> };
type EyeDropperCtor = new () => EyeDropperLike;

export type ScreenColorPickResult =
  | { status: "picked"; hex: string }
  | { status: "failed" | "cancelled" };

function getEyeDropperCtor(): EyeDropperCtor | null {
  const ctor = (window as Window & { EyeDropper?: EyeDropperCtor }).EyeDropper;
  return ctor ?? null;
}

export function useColorPicker() {
  const pickScreenColor = useCallback(async (): Promise<ScreenColorPickResult> => {
    const isWindows = navigator.platform.toLowerCase().includes("win");

    const pickWithEyeDropper = async (): Promise<ScreenColorPickResult> => {
      const ctor = getEyeDropperCtor();
      if (!ctor) return { status: "failed" };
      try {
        const result = await new ctor().open();
        if (result?.sRGBHex) {
          return { status: "picked", hex: result.sRGBHex.toUpperCase() };
        }
      } catch (e) {
        const message = String(e).toLowerCase();
        if (
          message.includes("abort") ||
          message.includes("cancel") ||
          message.includes("denied")
        ) {
          return { status: "cancelled" };
        }
        handleError(e, { context: "取色", silent: true });
      }
      return { status: "failed" };
    };

    const pickWithNative = async (): Promise<ScreenColorPickResult> => {
      try {
        const hex = await invoke<string>("plugin_start_color_picker");
        if (hex) {
          return { status: "picked", hex: hex.toUpperCase() };
        }
        return { status: "cancelled" };
      } catch (e) {
        handleError(e, { context: "取色", silent: true });
        return { status: "failed" };
      }
    };

    if (isWindows) {
      const eyeResult = await pickWithEyeDropper();
      if (eyeResult.status !== "failed") return eyeResult;
      return pickWithNative();
    }

    const nativeResult = await pickWithNative();
    if (nativeResult.status !== "failed") return nativeResult;
    return pickWithEyeDropper();
  }, []);

  const handleDirectColorPicker = useCallback(async () => {
    const result = await pickScreenColor();
    if (result.status === "picked") {
      try {
        await navigator.clipboard.writeText(result.hex);
      } catch {
        // ignore clipboard error
      }
      return;
    }
    if (result.status === "failed") {
      handleError(new Error("当前环境不支持屏幕取色"), { context: "取色" });
    }
  }, [pickScreenColor]);

  // BroadcastChannel: relay screen-pick requests from plugin windows
  useEffect(() => {
    const CH = "mtools-screen-pick";
    const bc = new BroadcastChannel(CH);
    bc.onmessage = async (e) => {
      if (e.data?.type !== "request-screen-pick") return;
      const result = await pickScreenColor();
      if (result.status === "picked") {
        bc.postMessage({ type: "screen-color-picked", color: result.hex });
      }
    };
    return () => bc.close();
  }, [pickScreenColor]);

  return { pickScreenColor, handleDirectColorPicker };
}
