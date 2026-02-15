import React, { useEffect, useRef, useState } from "react";
import * as fabric from "fabric";
import {
  ArrowRight,
  Square,
  Type,
  X,
  Check,
  Undo,
  Redo,
  Eraser,
} from "lucide-react";

interface ImageEditorProps {
  imageUrl?: string;
  onSave?: (dataUrl: string) => void;
  onCancel?: () => void;
}

const ImageEditor: React.FC<ImageEditorProps> = ({
  imageUrl,
  onSave,
  onCancel,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fabricCanvas, setFabricCanvas] = useState<fabric.Canvas | null>(null);
  const [activeTool, setActiveTool] = useState<string>("select");
  const [color, setColor] = useState<string>("#ff0000");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (canvasRef.current && containerRef.current && !fabricCanvas) {
      const canvas = new fabric.Canvas(canvasRef.current, {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        backgroundColor: "#f0f0f0",
      });
      setFabricCanvas(canvas);

      // Handle window resize
      const handleResize = () => {
        if (containerRef.current) {
          canvas.setDimensions({
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
          });
        }
      };
      window.addEventListener("resize", handleResize);

      return () => {
        window.removeEventListener("resize", handleResize);
        canvas.dispose();
      };
    }
  }, [containerRef]);

  useEffect(() => {
    if (fabricCanvas && imageUrl) {
      fabric.FabricImage.fromURL(imageUrl).then((img) => {
        if (!img) return;
        // Scale image to fit canvas while maintaining aspect ratio
        const scale = Math.min(
          (fabricCanvas.width! * 0.9) / img.width!,
          (fabricCanvas.height! * 0.9) / img.height!,
        );

        img.scale(scale);
        img.set({
          left: (fabricCanvas.width! - img.width! * scale) / 2,
          top: (fabricCanvas.height! - img.height! * scale) / 2,
          selectable: false, // Background image shouldn't be moved easily
          evented: false,
        });

        fabricCanvas.add(img);
        fabricCanvas.sendObjectToBack(img);
        fabricCanvas.renderAll();
      });
    }
  }, [fabricCanvas, imageUrl]);

  const addRect = () => {
    if (!fabricCanvas) return;
    const rect = new fabric.Rect({
      left: 100,
      top: 100,
      fill: "transparent",
      stroke: color,
      strokeWidth: 3,
      width: 100,
      height: 100,
      cornerColor: "white",
      cornerStrokeColor: "gray",
      borderColor: "gray",
      cornerStyle: "circle",
    });
    fabricCanvas.add(rect);
    fabricCanvas.setActiveObject(rect);
  };

  const addText = () => {
    if (!fabricCanvas) return;
    const text = new fabric.IText("Double click to edit", {
      left: 100,
      top: 100,
      fontFamily: "Arial",
      fill: color,
      fontSize: 24,
    });
    fabricCanvas.add(text);
    fabricCanvas.setActiveObject(text);
  };

  const handleSave = () => {
    if (fabricCanvas && onSave) {
      const dataUrl = fabricCanvas.toDataURL({
        format: "png",
        quality: 1,
        multiplier: 1,
      });
      onSave(dataUrl);
    }
  };

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--color-bg)", color: "var(--color-text)" }}>
      {/* Toolbar */}
      <div className="flex-none p-3 border-b flex items-center gap-4 shadow-sm z-10" style={{ background: "var(--color-bg-secondary)", borderColor: "var(--color-border)" }}>
        <div className="flex p-1 rounded-lg" style={{ background: "var(--color-bg-tertiary, rgba(0,0,0,0.06))" }}>
          <button
            onClick={() => setActiveTool("select")}
            className={`p-2 rounded transition-colors ${activeTool === "select" ? "shadow text-blue-600" : "hover:opacity-80"}`}
            style={activeTool === "select" ? { background: "var(--color-bg)" } : {}}
            title="Select"
          >
            <span className="font-bold text-sm">Select</span>
          </button>
          <button
            onClick={addRect}
            className="p-2 hover:text-blue-600 rounded transition-colors hover:opacity-80"
            title="Add Rectangle"
          >
            <Square size={20} />
          </button>
          <button
            onClick={addText}
            className="p-2 hover:text-blue-600 rounded transition-colors hover:opacity-80"
            title="Add Text"
          >
            <Type size={20} />
          </button>
        </div>

        <div className="h-6 w-px mx-2" style={{ background: "var(--color-border)" }}></div>

        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-8 h-8 rounded cursor-pointer border-0 p-0"
          />
        </div>

        <div className="flex-1"></div>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg flex items-center gap-2 transition-colors hover:opacity-80"
            style={{ background: "var(--color-bg-tertiary, rgba(0,0,0,0.06))", color: "var(--color-text-secondary)" }}
          >
            <X size={18} /> Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-2 shadow-sm transition-colors"
          >
            <Check size={18} /> Save
          </button>
        </div>
      </div>

      {/* Canvas Area */}
      <div
        className="flex-1 overflow-hidden relative"
        style={{ background: "var(--color-bg-tertiary, rgba(0,0,0,0.1))" }}
        ref={containerRef}
      >
        <canvas ref={canvasRef} className="absolute top-0 left-0" />
      </div>
    </div>
  );
};

export default ImageEditor;
