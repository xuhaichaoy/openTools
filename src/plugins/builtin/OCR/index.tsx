import React, { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  ScanText,
  Upload,
  Clipboard,
  Camera,
  Copy,
  Check,
  Loader2,
  ChevronDown,
  Globe,
} from "lucide-react";
import {
  emitPluginEvent,
  onPluginEvent,
  PluginEventTypes,
} from "@/core/plugin-system/event-bus";
import { useDragWindow } from "@/hooks/useDragWindow";

interface OcrBlock {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

interface OcrResult {
  full_text: string;
  blocks: OcrBlock[];
  language: string;
  rotation_detected: boolean;
  rotation_angle: number;
}

const LANGUAGES = [
  { code: "ch", name: "中文" },
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
];

const OCRPlugin: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const { onMouseDown } = useDragWindow();
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState("ch");
  const [copied, setCopied] = useState(false);
  const [detectRotation, setDetectRotation] = useState(false);
  const [mergeParagraph, setMergeParagraph] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const doOcr = useCallback(
    async (base64: string) => {
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const res = await invoke<OcrResult>("ocr_detect_advanced", {
          imageBase64: base64,
          lang: language,
          detectRotation,
          mergeParagraph,
        });
        setResult(res);
        // 发送 OCR 结果事件
        emitPluginEvent(PluginEventTypes.OCR_RESULT, "esearch-ocr", {
          text: res.full_text,
          blocks: res.blocks,
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [language, detectRotation, mergeParagraph],
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const dataUrl = ev.target?.result as string;
        setImagePreview(dataUrl);
        const base64 = dataUrl.split(",")[1];
        await doOcr(base64);
      };
      reader.readAsDataURL(file);
    },
    [doOcr],
  );

  const handlePaste = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            const reader = new FileReader();
            reader.onload = async (ev) => {
              const dataUrl = ev.target?.result as string;
              setImagePreview(dataUrl);
              const base64 = dataUrl.split(",")[1];
              await doOcr(base64);
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
  }, [doOcr]);

  const handleCopyResult = useCallback(() => {
    if (!result) return;
    navigator.clipboard.writeText(result.full_text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [result]);

  // 监听截图事件
  React.useEffect(() => {
    const unsub = onPluginEvent<{ imageBase64: string }>(
      PluginEventTypes.SCREENSHOT_CAPTURED,
      (event) => {
        const dataUrl = `data:image/png;base64,${event.payload.imageBase64}`;
        setImagePreview(dataUrl);
        doOcr(event.payload.imageBase64);
      },
    );
    return unsub;
  }, [doOcr]);

  // 兜底：如果先切页后发事件失败，则读取全局待处理图片
  React.useEffect(() => {
    const pending = (window as any).__PENDING_OCR_IMAGE__ as string | undefined;
    if (!pending) return;
    delete (window as any).__PENDING_OCR_IMAGE__;
    const dataUrl = `data:image/png;base64,${pending}`;
    setImagePreview(dataUrl);
    doOcr(pending);
  }, [doOcr]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* 头部 */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              onMouseDown={(e) => e.stopPropagation()}
              className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
            >
              ←
            </button>
          )}
          <ScanText className="w-5 h-5 text-amber-500" />
          <h2 className="font-semibold">OCR 文字识别</h2>
        </div>

        {/* 语言选择 */}
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-[var(--color-text-secondary)]" />
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            className="text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md px-2 py-1"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 主体 */}
      <div className="flex-1 overflow-auto p-4 flex gap-4">
        {/* 左侧：图片输入 */}
        <div className="flex-1 flex flex-col gap-3">
          {/* 操作按钮 */}
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors text-sm font-medium"
            >
              <Upload className="w-4 h-4" />
              选择图片
            </button>
            <button
              onClick={handlePaste}
              className="flex items-center gap-1.5 px-3 py-2 bg-[var(--color-bg-secondary)] rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors text-sm"
            >
              <Clipboard className="w-4 h-4" />
              从剪贴板
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>

          {/* 选项 */}
          <div className="flex gap-4 text-sm text-[var(--color-text-secondary)]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={detectRotation}
                onChange={(e) => setDetectRotation(e.target.checked)}
                className="rounded"
              />
              旋转检测
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={mergeParagraph}
                onChange={(e) => setMergeParagraph(e.target.checked)}
                className="rounded"
              />
              段落合并
            </label>
          </div>

          {/* 图片预览 */}
          <div className="flex-1 border border-dashed border-[var(--color-border)] rounded-lg flex items-center justify-center bg-[var(--color-bg-secondary)] min-h-[200px] overflow-hidden">
            {imagePreview ? (
              <img
                src={imagePreview}
                alt="OCR input"
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <div className="text-center text-[var(--color-text-secondary)]">
                <ScanText className="w-12 h-12 mx-auto mb-2 opacity-30" />
                <p className="text-sm">选择图片、粘贴剪贴板或从截图获取</p>
                <p className="text-xs mt-1 opacity-60">
                  支持 PNG、JPG、BMP、WebP
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 右侧：识别结果 */}
        <div className="flex-1 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-sm">识别结果</h3>
            {result && (
              <button
                onClick={handleCopyResult}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-[var(--color-bg-secondary)] rounded hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                {copied ? (
                  <Check className="w-3 h-3 text-green-500" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                {copied ? "已复制" : "复制"}
              </button>
            )}
          </div>

          <div className="flex-1 border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-secondary)] p-3 overflow-auto min-h-[200px]">
            {loading && (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-6 h-6 animate-spin text-amber-500" />
                <span className="ml-2 text-sm text-[var(--color-text-secondary)]">
                  识别中...
                </span>
              </div>
            )}
            {error && (
              <div className="text-red-500 text-sm p-2 bg-red-500/10 rounded">
                {error}
              </div>
            )}
            {result && !loading && (
              <div className="space-y-2">
                <textarea
                  value={result.full_text}
                  readOnly
                  className="w-full h-full min-h-[180px] bg-transparent resize-none text-sm leading-relaxed focus:outline-none"
                />
                {result.blocks.length > 0 && (
                  <div className="border-t border-[var(--color-border)] pt-2 mt-2">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">
                      识别 {result.blocks.length} 个文字块 | 语言:{" "}
                      {result.language}
                      {result.rotation_detected &&
                        ` | 旋转: ${result.rotation_angle.toFixed(1)}°`}
                    </p>
                  </div>
                )}
              </div>
            )}
            {!loading && !error && !result && (
              <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)] text-sm">
                等待图片输入...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OCRPlugin;
