import { useState, useCallback, useRef } from "react";

/**
 * 共享 Hook：处理图片输入（剪贴板粘贴 / 文件选择）
 *
 * 多个插件（OCR、QRCode、ImageSearch、DingPin、ScreenTranslate）复用此逻辑，
 * 避免在每个插件中重复实现剪贴板读取和文件上传代码。
 *
 * @param onImage 收到图片后的回调，参数为 dataUrl (含 MIME 前缀) 和 base64 (纯数据)
 */
export function useImageInput(
  onImage: (dataUrl: string, base64: string) => void,
) {
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 处理文件选择 */
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setError(null);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setImagePreview(dataUrl);
        const base64 = dataUrl.split(",")[1] || "";
        onImage(dataUrl, base64);
      };
      reader.readAsDataURL(file);
      // 重置 input 以允许重复选择同一文件
      e.target.value = "";
    },
    [onImage],
  );

  /** 从剪贴板读取图片 */
  const handlePaste = useCallback(async () => {
    setError(null);
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            const reader = new FileReader();
            reader.onload = (ev) => {
              const dataUrl = ev.target?.result as string;
              setImagePreview(dataUrl);
              const base64 = dataUrl.split(",")[1] || "";
              onImage(dataUrl, base64);
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }
      setError("剪贴板中没有图片");
    } catch {
      setError("无法读取剪贴板，请确保已授予权限");
    }
  }, [onImage]);

  /** 清除当前图片和错误 */
  const clear = useCallback(() => {
    setImagePreview(null);
    setError(null);
  }, []);

  /** 触发文件选择对话框 */
  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return {
    imagePreview,
    error,
    setError,
    fileInputRef,
    handleFileSelect,
    handlePaste,
    openFilePicker,
    clear,
  };
}
