import { useCallback, useState, type ChangeEvent, type ClipboardEvent } from "react";

async function saveImageToLocal(base64: string, ext: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const fileName = `agent_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  return invoke<string>("ai_save_chat_image", {
    imageData: base64,
    fileName,
  });
}

export function useAgentInputAssets() {
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [pendingImagePreviews, setPendingImagePreviews] = useState<string[]>([]);

  const appendImage = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || "");
      setPendingImagePreviews((prev) => [...prev, dataUrl]);
      try {
        const base64 = dataUrl.split(",")[1] || "";
        const ext = file.type.split("/")[1] || "png";
        const savedPath = await saveImageToLocal(base64, ext);
        setPendingImages((prev) => [...prev, savedPath]);
      } catch (err) {
        console.error("保存图片失败:", err);
        setPendingImagePreviews((prev) => prev.slice(0, -1));
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          await appendImage(blob);
        }
      }
    },
    [appendImage],
  );

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        void appendImage(file);
      }
      e.target.value = "";
    },
    [appendImage],
  );

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
    setPendingImagePreviews((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAssets = useCallback(() => {
    setPendingImages([]);
    setPendingImagePreviews([]);
  }, []);

  return {
    pendingImages,
    pendingImagePreviews,
    handlePaste,
    handleFileSelect,
    removeImage,
    clearAssets,
  };
}
