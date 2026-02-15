import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Direction =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "move"
  | "";
type InteractionMode = "idle" | "selecting" | "resizing" | "moving";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ScreenshotData {
  path: string;
  base64?: string;
  width: number;
  height: number;
}

// 方向 → 光标样式映射
const CURSOR_MAP: Record<Direction, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  move: "move",
  "": "crosshair",
};

export function ScreenshotSelector() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // 截图数据（通过事件接收，参考 eSearch 的 clip_init IPC）
  const [screenshotData, setScreenshotData] = useState<ScreenshotData | null>(
    null,
  );
  const [imageLoaded, setImageLoaded] = useState(false);

  // 交互状态全部用 ref，避免拖拽过程频繁 re-render
  const modeRef = useRef<InteractionMode>("idle");
  const rectRef = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const hasSelectionRef = useRef(false);
  const directionRef = useRef<Direction>("");
  const startPosRef = useRef({ x: 0, y: 0 });
  const origRectRef = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const shiftDownRef = useRef(false);
  const mousePosRef = useRef({ x: 0, y: 0 });

  // 工具栏显示控制（只在选区确认/取消时更新，减少 re-render）
  const [toolbarInfo, setToolbarInfo] = useState<{
    visible: boolean;
    rect: Rect;
  }>({
    visible: false,
    rect: { x: 0, y: 0, w: 0, h: 0 },
  });

  // ============ 告知后端窗口已就绪 ============
  useEffect(() => {
    console.log(
      "ScreenshotSelector mounted, calling screenshot_window_ready...",
    );
    invoke("screenshot_window_ready").catch((err) =>
      console.error("screenshot_window_ready failed:", err),
    );
  }, []);

  // ============ 监听截图开始事件（重置状态） ============
  useEffect(() => {
    const unlisten = listen("screenshot-start", () => {
      console.log(
        "ScreenshotSelector received screenshot-start, resetting state...",
      );
      setScreenshotData(null);
      setImageLoaded(false);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ============ 监听截图数据事件（参考 eSearch 的 renderOn("clip_init", ...) ============
  useEffect(() => {
    const unlisten = listen<ScreenshotData>("screenshot-data", (event) => {
      const data = event.payload;
      // 重置所有状态
      modeRef.current = "idle";
      rectRef.current = { x: 0, y: 0, w: 0, h: 0 };
      hasSelectionRef.current = false;
      directionRef.current = "";
      setToolbarInfo({ visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } });
      setImageLoaded(false);
      // 设置新的截图数据（每次截图用唯一文件名，无需额外缓存破坏）
      setScreenshotData(data);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 缩放比计算
  const getScale = useCallback(() => {
    const winW = window.innerWidth || 1;
    const winH = window.innerHeight || 1;
    if (
      screenshotData &&
      screenshotData.width > 0 &&
      screenshotData.height > 0
    ) {
      return {
        x: screenshotData.width / winW,
        y: screenshotData.height / winH,
      };
    }
    const dpr = window.devicePixelRatio || 1;
    return { x: dpr, y: dpr };
  }, [screenshotData]);

  // ============ 碰撞检测：鼠标在选区的哪个区域 ============
  const hitTest = useCallback((mx: number, my: number): Direction => {
    const r = rectRef.current;
    if (!hasSelectionRef.current || r.w < 3 || r.h < 3) return "";

    const handleSize = 8;
    const x0 = r.x;
    const y0 = r.y;
    const x1 = r.x + r.w;
    const y1 = r.y + r.h;

    const inRangeX = mx >= x0 - handleSize && mx <= x1 + handleSize;
    const inRangeY = my >= y0 - handleSize && my <= y1 + handleSize;
    if (!inRangeX || !inRangeY) return "";

    const nearLeft = Math.abs(mx - x0) <= handleSize;
    const nearRight = Math.abs(mx - x1) <= handleSize;
    const nearTop = Math.abs(my - y0) <= handleSize;
    const nearBottom = Math.abs(my - y1) <= handleSize;

    if (nearLeft && nearTop) return "nw";
    if (nearRight && nearBottom) return "se";
    if (nearRight && nearTop) return "ne";
    if (nearLeft && nearBottom) return "sw";
    if (nearTop && mx > x0 + handleSize && mx < x1 - handleSize) return "n";
    if (nearBottom && mx > x0 + handleSize && mx < x1 - handleSize) return "s";
    if (nearLeft && my > y0 + handleSize && my < y1 - handleSize) return "w";
    if (nearRight && my > y0 + handleSize && my < y1 - handleSize) return "e";
    if (
      mx > x0 + handleSize &&
      mx < x1 - handleSize &&
      my > y0 + handleSize &&
      my < y1 - handleSize
    )
      return "move";
    return "";
  }, []);

  // ============ 核心绘制函数 ============
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cw = window.innerWidth;
    const ch = window.innerHeight;
    canvas.width = cw;
    canvas.height = ch;
    ctx.clearRect(0, 0, cw, ch);

    const r = rectRef.current;
    const hasRect = hasSelectionRef.current || modeRef.current === "selecting";
    const validRect = hasRect && r.w > 2 && r.h > 2;

    // 全屏半透明遮罩
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, cw, ch);

    if (validRect) {
      // 清除选区（露出底图）
      ctx.clearRect(r.x, r.y, r.w, r.h);

      // 选区内三等分参考线
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 0.5;
      for (let i = 1; i <= 2; i++) {
        const vx = r.x + (r.w * i) / 3;
        ctx.beginPath();
        ctx.moveTo(vx, r.y);
        ctx.lineTo(vx, r.y + r.h);
        ctx.stroke();
        const hy = r.y + (r.h * i) / 3;
        ctx.beginPath();
        ctx.moveTo(r.x, hy);
        ctx.lineTo(r.x + r.w, hy);
        ctx.stroke();
      }

      // 选区边框
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);

      // 8 个拖拽手柄
      const hs = 6;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      const pts: [number, number][] = [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x, r.y + r.h],
        [r.x + r.w, r.y + r.h],
        [r.x + r.w / 2, r.y],
        [r.x + r.w / 2, r.y + r.h],
        [r.x, r.y + r.h / 2],
        [r.x + r.w, r.y + r.h / 2],
      ];
      for (const [cx, cy] of pts) {
        ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
        ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
      }

      // 尺寸标签（物理像素）
      const scale = getScale();
      const physW = Math.round(r.w * scale.x);
      const physH = Math.round(r.h * scale.y);
      const label = `${physW} × ${physH}`;
      ctx.font = "12px system-ui, -apple-system, sans-serif";
      const labelW = ctx.measureText(label).width + 16;
      const labelH = 24;
      const labelX = r.x;
      const labelY = r.y > 34 ? r.y - labelH - 6 : r.y + r.h + 6;
      ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
      ctx.beginPath();
      ctx.roundRect(labelX, labelY, labelW, labelH, 4);
      ctx.fill();
      ctx.fillStyle = "#93c5fd";
      ctx.fillText(label, labelX + 8, labelY + 16);
    }

    // 十字准线光标参考线
    const mp = mousePosRef.current;
    const showCrosshair =
      modeRef.current === "idle" && !hasSelectionRef.current;
    const outsideRect =
      validRect &&
      (mp.x < r.x || mp.x > r.x + r.w || mp.y < r.y || mp.y > r.y + r.h);
    if (
      showCrosshair ||
      (hasSelectionRef.current && outsideRect && modeRef.current === "idle")
    ) {
      ctx.strokeStyle = "rgba(59, 130, 246, 0.5)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, mp.y);
      ctx.lineTo(mp.x - 12, mp.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mp.x + 12, mp.y);
      ctx.lineTo(cw, mp.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mp.x, 0);
      ctx.lineTo(mp.x, mp.y - 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mp.x, mp.y + 12);
      ctx.lineTo(mp.x, ch);
      ctx.stroke();
    }

    // 无选区时提示文字
    if (!hasSelectionRef.current && modeRef.current === "idle") {
      ctx.font = "14px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.textAlign = "center";
      ctx.fillText(
        "拖拽框选截图区域  ·  ESC 取消  ·  Enter / 双击确认  ·  Shift 正方形",
        cw / 2,
        ch / 2,
      );
    }
  }, [getScale]);

  // ============ 标准化 / 边界约束 ============
  const normalizeRect = (rect: Rect): Rect => {
    let { x, y, w, h } = rect;
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    return { x, y, w, h };
  };

  const clampRect = (rect: Rect): Rect => {
    const cw = window.innerWidth;
    const ch = window.innerHeight;
    let { x, y, w, h } = rect;
    if (x < 0) {
      w += x;
      x = 0;
    }
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (x + w > cw) w = cw - x;
    if (y + h > ch) h = ch - y;
    return { x, y, w, h };
  };

  // ============ 鼠标事件 ============
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 2) {
        handleCancel();
        return;
      }
      const mx = e.clientX,
        my = e.clientY;
      const dir = hitTest(mx, my);

      if (dir === "move") {
        modeRef.current = "moving";
        directionRef.current = "move";
        startPosRef.current = { x: mx, y: my };
        origRectRef.current = { ...rectRef.current };
        setToolbarInfo({ visible: false, rect: rectRef.current });
      } else if (dir !== "") {
        modeRef.current = "resizing";
        directionRef.current = dir;
        startPosRef.current = { x: mx, y: my };
        origRectRef.current = { ...rectRef.current };
        setToolbarInfo({ visible: false, rect: rectRef.current });
      } else {
        modeRef.current = "selecting";
        directionRef.current = "";
        startPosRef.current = { x: mx, y: my };
        rectRef.current = { x: mx, y: my, w: 0, h: 0 };
        hasSelectionRef.current = false;
        setToolbarInfo({ visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } });
      }
      draw();
    },
    [hitTest, draw],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const mx = e.clientX,
        my = e.clientY;
      mousePosRef.current = { x: mx, y: my };
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (modeRef.current === "selecting") {
        let w = mx - startPosRef.current.x;
        let h = my - startPosRef.current.y;
        if (shiftDownRef.current) {
          const size = Math.max(Math.abs(w), Math.abs(h));
          w = w >= 0 ? size : -size;
          h = h >= 0 ? size : -size;
        }
        rectRef.current = normalizeRect({
          x: startPosRef.current.x,
          y: startPosRef.current.y,
          w,
          h,
        });
      } else if (modeRef.current === "moving") {
        const dx = mx - startPosRef.current.x,
          dy = my - startPosRef.current.y;
        const orig = origRectRef.current;
        rectRef.current = clampRect({
          x: orig.x + dx,
          y: orig.y + dy,
          w: orig.w,
          h: orig.h,
        });
      } else if (modeRef.current === "resizing") {
        const dx = mx - startPosRef.current.x,
          dy = my - startPosRef.current.y;
        const orig = origRectRef.current;
        let nr = { ...orig };
        switch (directionRef.current) {
          case "nw":
            nr = {
              x: orig.x + dx,
              y: orig.y + dy,
              w: orig.w - dx,
              h: orig.h - dy,
            };
            break;
          case "ne":
            nr = { x: orig.x, y: orig.y + dy, w: orig.w + dx, h: orig.h - dy };
            break;
          case "sw":
            nr = { x: orig.x + dx, y: orig.y, w: orig.w - dx, h: orig.h + dy };
            break;
          case "se":
            nr = { x: orig.x, y: orig.y, w: orig.w + dx, h: orig.h + dy };
            break;
          case "n":
            nr = { x: orig.x, y: orig.y + dy, w: orig.w, h: orig.h - dy };
            break;
          case "s":
            nr = { x: orig.x, y: orig.y, w: orig.w, h: orig.h + dy };
            break;
          case "w":
            nr = { x: orig.x + dx, y: orig.y, w: orig.w - dx, h: orig.h };
            break;
          case "e":
            nr = { x: orig.x, y: orig.y, w: orig.w + dx, h: orig.h };
            break;
        }
        if (shiftDownRef.current) {
          const size = Math.max(nr.w, nr.h);
          nr.w = size;
          nr.h = size;
        }
        rectRef.current = clampRect(normalizeRect(nr));
      } else {
        canvas.style.cursor = CURSOR_MAP[hitTest(mx, my)] || "crosshair";
      }
      draw();
    },
    [hitTest, draw],
  );

  const handleMouseUp = useCallback(() => {
    if (modeRef.current !== "idle") {
      const r = normalizeRect(rectRef.current);
      rectRef.current = r;
      if (r.w > 5 && r.h > 5) {
        hasSelectionRef.current = true;
        setToolbarInfo({ visible: true, rect: { ...r } });
      } else {
        hasSelectionRef.current = false;
        setToolbarInfo({ visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } });
      }
      modeRef.current = "idle";
      directionRef.current = "";
      draw();
    }
  }, [draw]);

  const handleDoubleClick = useCallback(() => {
    if (hasSelectionRef.current) handleConfirm();
  }, []);

  // ============ 取消 / 确认 ============
  const handleCancel = async () => {
    try {
      await invoke("cancel_capture");
    } catch (e) {
      console.error("取消截图失败:", e);
    }
    // 重置本地状态，为下次截图做准备
    resetState();
  };

  const handleConfirmWithAction = async (action: string) => {
    const r = rectRef.current;
    if (r.w < 5 || r.h < 5) return;
    const scale = getScale();
    const x = Math.round(r.x * scale.x);
    const y = Math.round(r.y * scale.y);
    const w = Math.round(r.w * scale.x);
    const h = Math.round(r.h * scale.y);
    try {
      await invoke("finish_capture", {
        x,
        y,
        width: w,
        height: h,
        copyToClipboard: action === "copy",
        action,
      });
    } catch (e) {
      console.error("区域截图失败:", e);
      await invoke("cancel_capture").catch(() => {});
    }
    resetState();
  };

  // 兼容双击 / Enter 确认（默认 copy 行为）
  const handleConfirm = async () => handleConfirmWithAction("copy");

  const resetState = () => {
    modeRef.current = "idle";
    rectRef.current = { x: 0, y: 0, w: 0, h: 0 };
    hasSelectionRef.current = false;
    directionRef.current = "";
    setToolbarInfo({ visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } });
    setScreenshotData(null);
    setImageLoaded(false);
  };

  // ============ 图片加载完成 → 通知后端显示窗口 ============
  const handleImageLoad = useCallback(() => {
    setImageLoaded(true);
    // 参考 eSearch：renderer 就绪后发送 clip_show 给 main process
    invoke("show_screenshot_window").catch(console.error);
    // 绘制初始遮罩
    requestAnimationFrame(() => draw());
  }, [draw]);

  // ============ 键盘事件 ============
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancel();
      if (e.key === "Enter" && hasSelectionRef.current) handleConfirm();
      if (e.key === "Shift") shiftDownRef.current = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftDownRef.current = false;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // ============ 工具栏位置计算 ============
  const getToolbarStyle = useCallback((): React.CSSProperties => {
    if (!toolbarInfo.visible) return { display: "none" };
    const r = toolbarInfo.rect;
    const gap = 8,
      toolbarW = 420,
      toolbarH = 36;
    const winW = window.innerWidth,
      winH = window.innerHeight;
    // 居中于选区下方
    let left = r.x + (r.w - toolbarW) / 2;
    if (left < gap) left = gap;
    if (left + toolbarW > winW - gap) left = winW - toolbarW - gap;
    let top = r.y + r.h + gap;
    if (top + toolbarH > winH - gap) {
      top = r.y - toolbarH - gap;
      if (top < gap) top = r.y + r.h - toolbarH - gap;
    }
    return { position: "absolute" as const, left, top, zIndex: 50 };
  }, [toolbarInfo]);

  // 图片 URL（优先使用 base64，解决文件权限/协议问题）
  const imageUrl = useMemo(() => {
    if (!screenshotData) return "";
    if (screenshotData.base64) return screenshotData.base64;
    return `mtplugin://localhost${screenshotData.path}`;
  }, [screenshotData]);

  // ============ 工具栏按钮子组件 ============
  const ToolbarBtn = ({
    label,
    onClick,
    highlight,
    children,
  }: {
    label: string;
    onClick: () => void;
    highlight?: boolean;
    children: React.ReactNode;
  }) => (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors"
      style={
        highlight
          ? { background: "#3b82f6", color: "#fff" }
          : { color: "rgba(255,255,255,0.8)" }
      }
      onMouseEnter={(e) => {
        if (highlight) {
          e.currentTarget.style.background = "#2563eb";
        } else {
          e.currentTarget.style.background = "rgba(255,255,255,0.12)";
          e.currentTarget.style.color = "#fff";
        }
      }}
      onMouseLeave={(e) => {
        if (highlight) {
          e.currentTarget.style.background = "#3b82f6";
        } else {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "rgba(255,255,255,0.8)";
        }
      }}
    >
      {children}
      {label}
    </button>
  );

  // ============ 未收到截图数据时不渲染内容（窗口处于隐藏状态） ============
  if (!screenshotData) {
    return <div className="fixed inset-0" style={{ background: "#000" }} />;
  }

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ background: "#000" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 底层：截取的全屏图片 */}
      {/* 底层：截取的全屏图片 */}
      <img
        ref={imgRef}
        key={screenshotData?.path}
        src={imageUrl}
        onLoad={handleImageLoad}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
        }}
        draggable={false}
        alt=""
      />

      {/* Canvas 遮罩层（图片加载完成后才显示） */}
      {imageLoaded && (
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%",
            height: "100%",
            cursor: "crosshair",
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onDoubleClick={handleDoubleClick}
        />
      )}

      {/* 浮动功能工具栏 */}
      {toolbarInfo.visible && (
        <div
          className="flex items-center gap-1 rounded-lg shadow-xl"
          style={{
            ...getToolbarStyle(),
            background: "rgba(30, 30, 30, 0.92)",
            backdropFilter: "blur(12px)",
            padding: "4px 6px",
            border: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          {/* OCR 文字识别 */}
          <ToolbarBtn label="OCR" onClick={() => handleConfirmWithAction("ocr")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </ToolbarBtn>

          {/* 贴图 */}
          <ToolbarBtn label="贴图" onClick={() => handleConfirmWithAction("pin")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
          </ToolbarBtn>

          {/* 编辑标注 */}
          <ToolbarBtn label="编辑" onClick={() => handleConfirmWithAction("edit")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </ToolbarBtn>

          <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.15)", margin: "0 2px" }} />

          {/* 保存 */}
          <ToolbarBtn label="保存" onClick={() => handleConfirmWithAction("save")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </ToolbarBtn>

          {/* 复制 */}
          <ToolbarBtn label="复制" highlight onClick={() => handleConfirmWithAction("copy")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </ToolbarBtn>

          <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.15)", margin: "0 2px" }} />

          {/* 取消 */}
          <ToolbarBtn label="取消" onClick={handleCancel}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </ToolbarBtn>
        </div>
      )}
    </div>
  );
}
