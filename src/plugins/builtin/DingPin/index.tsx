import React, { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Pin,
  Upload,
  Clipboard,
  X,
  Minus,
  Plus,
  Loader2,
} from "lucide-react";
import {
  onPluginEvent,
  PluginEventTypes,
} from "@/core/plugin-system/event-bus";
import { handleError } from "@/core/errors";

interface DingInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  passthrough: boolean;
}

const DingPinPlugin: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const [dingList, setDingList] = useState<DingInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDingList = useCallback(async () => {
    try {
      const list = await invoke<DingInfo[]>("ding_list");
      setDingList(list);
    } catch (e) {
      handleError(e, { context: "加载贴图列表" });
    }
  }, []);

  useEffect(() => {
    loadDingList();
  }, [loadDingList]);

  const createDing = useCallback(
    async (base64: string, width?: number, height?: number) => {
      setLoading(true);
      try {
        // 默认放在屏幕中央偏上
        const x = 100 + Math.random() * 200;
        const y = 100 + Math.random() * 200;
        await invoke("ding_create", {
          imageBase64: base64,
          x,
          y,
          width: width ?? 300,
          height: height ?? 300,
        });
        await loadDingList();
      } catch (e) {
        handleError(e, { context: "创建屏幕贴图" });
      } finally {
        setLoading(false);
      }
    },
    [loadDingList],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        const base64 = dataUrl.split(",")[1];
        // 获取图片实际尺寸
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(400 / img.width, 400 / img.height, 1);
          createDing(base64, img.width * scale, img.height * scale);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    },
    [createDing],
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
              const base64 = dataUrl.split(",")[1];
              createDing(base64);
            };
            reader.readAsDataURL(blob);
            return;
          }
        }
      }
    } catch (e) {
      handleError(e, { context: "从剪贴板粘贴贴图", silent: true });
    }
  }, [createDing]);

  const handleCloseDing = useCallback(
    async (id: string) => {
      try {
        await invoke("ding_close", { dingId: id });
        await loadDingList();
      } catch (e) {
        handleError(e, { context: "关闭贴图" });
      }
    },
    [loadDingList],
  );

  const handleCloseAll = useCallback(async () => {
    try {
      await invoke("ding_close_all");
      setDingList([]);
    } catch (e) {
      handleError(e, { context: "关闭全部贴图" });
    }
  }, []);

  const handleSetOpacity = useCallback(
    async (id: string, opacity: number) => {
      try {
        await invoke("ding_set_opacity", {
          dingId: id,
          opacity: Math.max(0.1, Math.min(1, opacity)),
        });
        await loadDingList();
      } catch (e) {
        handleError(e, { context: "设置贴图透明度" });
      }
    },
    [loadDingList],
  );

  // 兼容历史 screenshot 事件，允许外部图片流继续触发贴图
  useEffect(() => {
    const unsub = onPluginEvent<{ imageBase64: string }>(
      PluginEventTypes.SCREENSHOT_CAPTURED,
      (event) => {
        createDing(event.payload.imageBase64);
      },
    );
    return unsub;
  }, [createDing]);

  // 监听贴图请求
  useEffect(() => {
    const unsub = onPluginEvent<{ imageBase64: string }>(
      PluginEventTypes.DING_REQUEST,
      (event) => {
        createDing(event.payload.imageBase64);
      },
    );
    return unsub;
  }, [createDing]);

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
          <Pin className="w-5 h-5 text-red-500" />
          <h2 className="font-semibold">屏幕贴图</h2>
          <span className="text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] px-2 py-0.5 rounded-full">
            {dingList.length} 个
          </span>
        </div>
        {dingList.length > 0 && (
          <button
            onClick={handleCloseAll}
            className="text-xs text-red-500 hover:bg-red-500/10 px-2 py-1 rounded"
          >
            关闭全部
          </button>
        )}
      </div>

      {/* 操作区域 */}
      <div className="p-4">
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors text-sm font-medium disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            选择图片贴图
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

        <p className="text-xs text-[var(--color-text-secondary)] mb-4">
          贴图将固定在屏幕上方，可拖动、缩放和调节透明度。截图后也可通过事件总线直接贴图。
        </p>
      </div>

      {/* 贴图列表 */}
      <div className="flex-1 overflow-auto px-4 pb-4">
        {dingList.length === 0 ? (
          <div className="text-center text-[var(--color-text-secondary)] py-12">
            <Pin className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p className="text-sm">暂无贴图</p>
            <p className="text-xs mt-1 opacity-60">
              选择图片或从截图创建贴图
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {dingList.map((ding) => (
              <div
                key={ding.id}
                className="flex items-center gap-3 p-3 bg-[var(--color-bg-secondary)] rounded-lg"
              >
                <Pin className="w-4 h-4 text-red-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">
                    贴图 ({ding.width.toFixed(0)}x{ding.height.toFixed(0)})
                  </p>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    位置: ({ding.x.toFixed(0)}, {ding.y.toFixed(0)}) | 透明度:{" "}
                    {(ding.opacity * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() =>
                      handleSetOpacity(ding.id, ding.opacity - 0.1)
                    }
                    className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]"
                    title="降低透明度"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() =>
                      handleSetOpacity(ding.id, ding.opacity + 0.1)
                    }
                    className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]"
                    title="增加透明度"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => handleCloseDing(ding.id)}
                    className="p-1 rounded hover:bg-red-500/10 hover:text-red-500"
                    title="关闭贴图"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DingPinPlugin;
