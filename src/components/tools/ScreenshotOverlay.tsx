import { useState, useRef, useCallback, useEffect } from "react";

interface ScreenshotOverlayProps {
  imageSrc: string;
  onConfirm: (region: { x: number; y: number; width: number; height: number }) => void;
  onCancel: () => void;
}

/**
 * 全屏截图选区覆盖层
 * 在全屏截图上绘制选区矩形，用户框选后确认裁剪区域
 */
export function ScreenshotOverlay({ imageSrc, onConfirm, onCancel }: ScreenshotOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });
  const [hasSelection, setHasSelection] = useState(false);
  const [shiftDown, setShiftDown] = useState(false);
  const bgImageRef = useRef<HTMLImageElement | null>(null);

  // 加载背景图片
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      bgImageRef.current = img;
      drawCanvas();
    };
    img.src = imageSrc;
  }, [imageSrc]);

  // 键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && hasSelection) confirmSelection();
      if (e.key === "Shift") setShiftDown(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftDown(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [hasSelection, onCancel]);

  // 获取选区矩形（归一化，确保 width/height 为正）
  const getSelectionRect = useCallback(() => {
    let x = Math.min(startPos.x, currentPos.x);
    let y = Math.min(startPos.y, currentPos.y);
    let w = Math.abs(currentPos.x - startPos.x);
    let h = Math.abs(currentPos.y - startPos.y);

    // Shift 锁定正方形
    if (shiftDown) {
      const size = Math.min(w, h);
      w = size;
      h = size;
    }

    return { x, y, width: w, height: h };
  }, [startPos, currentPos, shiftDown]);

  // 绘制 Canvas
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const bg = bgImageRef.current;
    if (!canvas || !bg) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // 绘制背景图
    ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);

    // 半透明蒙层
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 如果有选区，挖洞显示原图
    if (isDrawing || hasSelection) {
      const rect = getSelectionRect();
      if (rect.width > 2 && rect.height > 2) {
        // 保存上下文
        ctx.save();
        // 在选区位置绘制原图
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.clip();
        ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
        ctx.restore();

        // 选区边框
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

        // 尺寸标注
        const label = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillStyle = "#3b82f6";
        const labelY = rect.y > 20 ? rect.y - 6 : rect.y + rect.height + 16;
        ctx.fillText(label, rect.x + 4, labelY);
      }
    }

    // 提示文字
    if (!isDrawing && !hasSelection) {
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.textAlign = "center";
      ctx.fillText("拖拽选择截图区域 · ESC 取消 · Shift 正方形", canvas.width / 2, canvas.height / 2);
    }
  }, [isDrawing, hasSelection, getSelectionRect]);

  // 选区变化时重绘
  useEffect(() => {
    drawCanvas();
  }, [startPos, currentPos, isDrawing, hasSelection, shiftDown, drawCanvas]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setStartPos({ x: e.clientX, y: e.clientY });
    setCurrentPos({ x: e.clientX, y: e.clientY });
    setIsDrawing(true);
    setHasSelection(false);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing) return;
    setCurrentPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const rect = getSelectionRect();
    if (rect.width > 5 && rect.height > 5) {
      setHasSelection(true);
    }
  };

  const confirmSelection = () => {
    const rect = getSelectionRect();
    if (rect.width > 5 && rect.height > 5) {
      onConfirm(rect);
    }
  };

  const handleDoubleClick = () => {
    if (hasSelection) {
      confirmSelection();
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] cursor-crosshair" style={{ background: "transparent" }}>
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />
      {/* 确认/取消按钮 */}
      {hasSelection && (
        <div
          className="absolute flex gap-2"
          style={{
            left: Math.min(startPos.x, currentPos.x) + Math.abs(currentPos.x - startPos.x) - 100,
            top: Math.max(startPos.y, currentPos.y) + 8,
          }}
        >
          <button
            onClick={confirmSelection}
            className="px-3 py-1.5 rounded-md bg-blue-500 text-white text-xs shadow-lg hover:bg-blue-600"
          >
            ✓ 确认
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md bg-gray-700 text-white text-xs shadow-lg hover:bg-gray-600"
          >
            ✕ 取消
          </button>
        </div>
      )}
    </div>
  );
}
