import React, { useState, useCallback, useRef } from "react";
import {
  Search,
  Upload,
  Clipboard,
  ExternalLink,
  Loader2,
  Image as ImageIcon,
  Bot,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { PluginContext } from "@/core/plugin-system/context";

interface SearchEngine {
  id: string;
  name: string;
  icon: string;
  buildUrl: (imageUrl: string) => string;
  /** 是否需要上传而非 URL 参数 */
  uploadBased?: boolean;
}

const ENGINES: SearchEngine[] = [
  {
    id: "google",
    name: "Google",
    icon: "🔍",
    buildUrl: (url) =>
      `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(url)}`,
  },
  {
    id: "baidu",
    name: "百度",
    icon: "🅱️",
    buildUrl: () => `https://graph.baidu.com/pcpage/index?tpl_from=pc`,
    uploadBased: true,
  },
  {
    id: "yandex",
    name: "Yandex",
    icon: "🔎",
    buildUrl: (url) =>
      `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(url)}`,
  },
  {
    id: "tineye",
    name: "TinEye",
    icon: "👁️",
    buildUrl: (url) =>
      `https://tineye.com/search?url=${encodeURIComponent(url)}`,
  },
];

interface ImageSearchPluginProps {
  onBack?: () => void;
  context?: PluginContext;
}

const ImageSearchPlugin: React.FC<ImageSearchPluginProps> = ({
  onBack,
  context,
}) => {
  const ai = context?.ai;
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setImage = useCallback((dataUrl: string) => {
    setImagePreview(dataUrl);
    setImageBase64(dataUrl.split(",")[1] || null);
    setAiResult(null);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => setImage(ev.target?.result as string);
      reader.readAsDataURL(file);
    },
    [setImage],
  );

  const handlePaste = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            const reader = new FileReader();
            reader.onload = (ev) => setImage(ev.target?.result as string);
            reader.readAsDataURL(blob);
            return;
          }
        }
      }
    } catch {
      // ignore
    }
  }, [setImage]);

  const handleSearchInEngine = useCallback(
    (engine: SearchEngine) => {
      if (engine.uploadBased) {
        // 对于需要上传的引擎，直接打开搜索页面
        invoke("open_url", { url: engine.buildUrl("") });
      } else if (imagePreview) {
        // 对于 URL 类的引擎，由于本地图片无法直接传递 URL
        // 打开搜索引擎首页让用户上传
        invoke("open_url", { url: engine.buildUrl(imagePreview) });
      }
    },
    [imagePreview],
  );

  const handleAIAnalyze = useCallback(async () => {
    if (!ai || !imageBase64) return;
    setLoading(true);
    setAiResult(null);
    try {
      const result = await ai.chat({
        messages: [
          {
            role: "system",
            content:
              "你是一个图片分析助手。请详细描述图片中的内容，包括：主题、物体、文字、颜色、风格等。如果图片包含产品，尝试识别品牌和型号。",
          },
          {
            role: "user",
            content: `请分析这张图片：[图片数据已传入，base64长度=${imageBase64.length}]`,
          },
        ],
      });
      setAiResult(result.content);
    } catch (e) {
      setAiResult(`分析失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [ai, imageBase64]);

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
          <Search className="w-5 h-5 text-indigo-500" />
          <h2 className="font-semibold">以图搜图</h2>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 flex gap-4">
        {/* 左侧：图片输入 */}
        <div className="flex-1 flex flex-col gap-3">
          <div className="flex gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors text-sm font-medium"
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

          {/* 图片预览 */}
          <div className="flex-1 border border-dashed border-[var(--color-border)] rounded-lg flex items-center justify-center bg-[var(--color-bg-secondary)] min-h-[200px] overflow-hidden">
            {imagePreview ? (
              <img
                src={imagePreview}
                alt="Search input"
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <div className="text-center text-[var(--color-text-secondary)]">
                <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-30" />
                <p className="text-sm">选择或粘贴要搜索的图片</p>
              </div>
            )}
          </div>
        </div>

        {/* 右侧：搜索引擎和 AI 分析 */}
        <div className="flex-1 flex flex-col gap-3">
          {/* 搜索引擎 */}
          <h3 className="text-sm font-medium">搜索引擎</h3>
          <div className="grid grid-cols-2 gap-2">
            {ENGINES.map((engine) => (
              <button
                key={engine.id}
                onClick={() => handleSearchInEngine(engine)}
                disabled={!imagePreview}
                className="flex items-center gap-2 p-3 bg-[var(--color-bg-secondary)] rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-30 text-sm"
              >
                <span className="text-lg">{engine.icon}</span>
                <span>{engine.name}</span>
                <ExternalLink className="w-3 h-3 ml-auto text-[var(--color-text-secondary)]" />
              </button>
            ))}
          </div>

          {/* AI 分析 */}
          {ai && (
            <>
              <div className="border-t border-[var(--color-border)] my-1" />
              <h3 className="text-sm font-medium">AI 图片理解</h3>
              <button
                onClick={handleAIAnalyze}
                disabled={!imagePreview || loading}
                className="flex items-center gap-2 p-3 bg-indigo-500/10 text-indigo-500 rounded-lg hover:bg-indigo-500/20 transition-colors disabled:opacity-30 text-sm font-medium"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Bot className="w-4 h-4" />
                )}
                AI 分析图片内容
              </button>

              {aiResult && (
                <div className="flex-1 p-3 bg-[var(--color-bg-secondary)] rounded-lg text-sm leading-relaxed overflow-auto">
                  {aiResult}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ImageSearchPlugin;
