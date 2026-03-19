import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  QrCode,
  Upload,
  Clipboard,
  Copy,
  Check,
  Download,
  SwitchCamera,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

type Mode = "decode" | "encode";

const QRCodePlugin: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const [mode, setMode] = useState<Mode>("decode");
  const [inputText, setInputText] = useState("");
  const [decodedResult, setDecodedResult] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [generatedQR, setGeneratedQR] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 解码 QR Code（使用 Canvas + 简单检测逻辑）
  const decodeQR = useCallback(async (dataUrl: string) => {
    setLoading(true);
    setError(null);
    setDecodedResult(null);
    try {
      // 使用 Canvas 获取图片像素数据
      const img = new Image();
      img.src = dataUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = reject;
      });

      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // 动态导入 jsQR
      const jsQR = (await import("jsqr")).default;
      const code = jsQR(imageData.data, imageData.width, imageData.height);

      if (code) {
        setDecodedResult(code.data);
      } else {
        setError("未检测到二维码，请确保图片中包含清晰的二维码");
      }
    } catch (e) {
      setError(`解码失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 生成 QR Code
  const generateQR = useCallback(async () => {
    if (!inputText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const QRCode = (await import("qrcode")).default;
      const dataUrl = await QRCode.toDataURL(inputText, {
        width: 300,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
        errorCorrectionLevel: "M",
      });
      setGeneratedQR(dataUrl);
    } catch (e) {
      setError(`生成失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [inputText]);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setImagePreview(dataUrl);
        decodeQR(dataUrl);
      };
      reader.readAsDataURL(file);
    },
    [decodeQR],
  );

  const handlePaste = useCallback(async () => {
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
              decodeQR(dataUrl);
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }
      setError("剪贴板中没有图片");
    } catch {
      setError("无法读取剪贴板");
    }
  }, [decodeQR]);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleDownloadQR = useCallback(() => {
    if (!generatedQR) return;
    const a = document.createElement("a");
    a.href = generatedQR;
    a.download = `qrcode-${Date.now()}.png`;
    a.click();
  }, [generatedQR]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1 hover:bg-[var(--color-bg-secondary)] rounded-md transition-colors"
            >
              ←
            </button>
          )}
          <QrCode className="w-5 h-5 text-violet-500" />
          <h2 className="font-semibold">二维码</h2>
        </div>

        {/* 模式切换 */}
        <div className="flex bg-[var(--color-bg-secondary)] rounded-lg p-0.5">
          <button
            onClick={() => setMode("decode")}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              mode === "decode"
                ? "bg-violet-500 text-white"
                : "hover:bg-[var(--color-bg-tertiary)]"
            }`}
          >
            识别
          </button>
          <button
            onClick={() => setMode("encode")}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              mode === "encode"
                ? "bg-violet-500 text-white"
                : "hover:bg-[var(--color-bg-tertiary)]"
            }`}
          >
            生成
          </button>
        </div>
      </div>

      {/* 主体 */}
      <div className="flex-1 overflow-auto p-4">
        {mode === "decode" ? (
          /* 解码模式 */
          <div className="flex flex-col gap-4 h-full">
            <div className="flex gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-2 bg-violet-500 text-white rounded-lg hover:bg-violet-600 transition-colors text-sm font-medium"
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

            <div className="flex gap-4 flex-1">
              {/* 图片预览 */}
              <div className="flex-1 border border-dashed border-[var(--color-border)] rounded-lg flex items-center justify-center bg-[var(--color-bg-secondary)] min-h-[200px] overflow-hidden">
                {imagePreview ? (
                  <img
                    src={imagePreview}
                    alt="QR input"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <div className="text-center text-[var(--color-text-secondary)]">
                    <QrCode className="w-12 h-12 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">选择包含二维码的图片</p>
                  </div>
                )}
              </div>

              {/* 结果 */}
              <div className="flex-1 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">识别结果</h3>
                  {decodedResult && (
                    <button
                      onClick={() => handleCopy(decodedResult)}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-[var(--color-bg-secondary)] rounded hover:bg-[var(--color-bg-tertiary)]"
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
                <div className="flex-1 border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-secondary)] p-3">
                  {loading && (
                    <div className="flex items-center justify-center h-full">
                      <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
                    </div>
                  )}
                  {error && (
                    <p className="text-red-500 text-sm">{error}</p>
                  )}
                  {decodedResult && (
                    <div className="space-y-2">
                      <p className="text-sm break-all whitespace-pre-wrap">
                        {decodedResult}
                      </p>
                      {decodedResult.startsWith("http") && (
                        <button
                          onClick={() =>
                            invoke("open_url", { url: decodedResult })
                          }
                          className="text-xs text-violet-500 hover:underline"
                        >
                          在浏览器中打开
                        </button>
                      )}
                    </div>
                  )}
                  {!loading && !error && !decodedResult && (
                    <p className="text-[var(--color-text-secondary)] text-sm text-center mt-8">
                      等待图片输入...
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* 编码模式 */
          <div className="flex flex-col gap-4 h-full">
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && generateQR()}
                placeholder="输入文本或 URL..."
                className="flex-1 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              />
              <button
                onClick={generateQR}
                disabled={!inputText.trim() || loading}
                className="px-4 py-2 bg-violet-500 text-white rounded-lg hover:bg-violet-600 transition-colors text-sm font-medium disabled:opacity-50"
              >
                生成
              </button>
            </div>

            <div className="flex-1 flex items-center justify-center">
              {generatedQR ? (
                <div className="text-center space-y-3">
                  <img
                    src={generatedQR}
                    alt="Generated QR"
                    className="mx-auto border border-[var(--color-border)] rounded-lg"
                  />
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={handleDownloadQR}
                      className="flex items-center gap-1 px-3 py-1.5 bg-[var(--color-bg-secondary)] rounded-lg hover:bg-[var(--color-bg-tertiary)] text-sm"
                    >
                      <Download className="w-4 h-4" />
                      下载
                    </button>
                    <button
                      onClick={() => handleCopy(inputText)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-[var(--color-bg-secondary)] rounded-lg hover:bg-[var(--color-bg-tertiary)] text-sm"
                    >
                      <Copy className="w-4 h-4" />
                      复制内容
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-center text-[var(--color-text-secondary)]">
                  <QrCode className="w-16 h-16 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">输入内容后点击生成</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default QRCodePlugin;
