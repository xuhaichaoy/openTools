/**
 * 截图增强组件 — 高级标注工具条
 * 来源: eSearch 的 Fabric.js 编辑器
 *
 * 提供标注工具栏，可集成到现有 ScreenCapture 的预览阶段。
 */
import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  MousePointer2,
  Square,
  Circle,
  ArrowRight,
  Type,
  Pencil,
  Eraser,
  Undo2,
  Redo2,
  Hash,
  Grid3X3,
  Minus,
} from "lucide-react";

export type AnnotationTool =
  | "select"
  | "rect"
  | "circle"
  | "arrow"
  | "text"
  | "pencil"
  | "mosaic"
  | "blur"
  | "number";

interface AnnotationToolbarProps {
  activeTool: AnnotationTool;
  onToolChange: (tool: AnnotationTool) => void;
  color: string;
  onColorChange: (color: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (w: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const TOOLS: { id: AnnotationTool; icon: React.ReactNode; label: string }[] = [
  {
    id: "select",
    icon: <MousePointer2 className="w-4 h-4" />,
    label: "选择",
  },
  { id: "rect", icon: <Square className="w-4 h-4" />, label: "矩形" },
  { id: "circle", icon: <Circle className="w-4 h-4" />, label: "圆形" },
  { id: "arrow", icon: <ArrowRight className="w-4 h-4" />, label: "箭头" },
  { id: "text", icon: <Type className="w-4 h-4" />, label: "文字" },
  { id: "pencil", icon: <Pencil className="w-4 h-4" />, label: "画笔" },
  { id: "mosaic", icon: <Grid3X3 className="w-4 h-4" />, label: "马赛克" },
  { id: "number", icon: <Hash className="w-4 h-4" />, label: "序号" },
];

const COLORS = [
  "#ff0000",
  "#00cc00",
  "#0066ff",
  "#ff9900",
  "#9933ff",
  "#00cccc",
  "#ff3399",
  "#333333",
  "#ffffff",
];

const STROKE_WIDTHS = [1, 2, 3, 5, 8];

/**
 * 高级标注工具栏
 */
export const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  activeTool,
  onToolChange,
  color,
  onColorChange,
  strokeWidth,
  onStrokeWidthChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}) => {
  return (
    <div className="flex items-center gap-1 p-1.5 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-lg">
      {/* 工具按钮 */}
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          onClick={() => onToolChange(tool.id)}
          className={`p-1.5 rounded-lg transition-colors ${
            activeTool === tool.id
              ? "bg-blue-500 text-white"
              : "hover:bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
          }`}
          title={tool.label}
        >
          {tool.icon}
        </button>
      ))}

      <div className="w-px h-6 bg-[var(--color-border)] mx-1" />

      {/* 颜色选择 */}
      <div className="flex gap-0.5">
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => onColorChange(c)}
            className={`w-5 h-5 rounded-full border-2 transition-transform ${
              color === c
                ? "border-blue-500 scale-110"
                : "border-transparent hover:scale-105"
            }`}
            style={{ background: c }}
          />
        ))}
      </div>

      <div className="w-px h-6 bg-[var(--color-border)] mx-1" />

      {/* 线宽 */}
      <div className="flex items-center gap-0.5">
        {STROKE_WIDTHS.map((w) => (
          <button
            key={w}
            onClick={() => onStrokeWidthChange(w)}
            className={`p-1 rounded transition-colors ${
              strokeWidth === w
                ? "bg-blue-500/20 text-blue-500"
                : "hover:bg-[var(--color-bg-secondary)]"
            }`}
            title={`${w}px`}
          >
            <Minus
              className="w-4 h-4"
              style={{ strokeWidth: Math.min(w + 1, 4) }}
            />
          </button>
        ))}
      </div>

      <div className="w-px h-6 bg-[var(--color-border)] mx-1" />

      {/* 撤销/重做 */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] disabled:opacity-30 transition-colors"
        title="撤销"
      >
        <Undo2 className="w-4 h-4" />
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] disabled:opacity-30 transition-colors"
        title="重做"
      >
        <Redo2 className="w-4 h-4" />
      </button>
    </div>
  );
};

/**
 * 图片美化选项
 * 来源: eSearch 的截图美化功能
 */
export interface BeautifyOptions {
  background: string;
  padding: number;
  borderRadius: number;
  shadow: boolean;
  shadowBlur: number;
}

const BACKGROUNDS = [
  "transparent",
  "#ffffff",
  "#f0f0f0",
  "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  "linear-gradient(135deg, #f5af19 0%, #f12711 100%)",
  "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)",
  "linear-gradient(135deg, #30cfd0 0%, #330867 100%)",
  "linear-gradient(135deg, #5ee7df 0%, #b490ca 100%)",
];

interface BeautifyPanelProps {
  options: BeautifyOptions;
  onChange: (options: BeautifyOptions) => void;
}

export const BeautifyPanel: React.FC<BeautifyPanelProps> = ({
  options,
  onChange,
}) => {
  return (
    <div className="p-3 space-y-3">
      <h4 className="text-xs font-medium text-[var(--color-text-secondary)]">
        背景
      </h4>
      <div className="flex gap-1.5 flex-wrap">
        {BACKGROUNDS.map((bg, i) => (
          <button
            key={i}
            onClick={() => onChange({ ...options, background: bg })}
            className={`w-8 h-8 rounded-lg border-2 transition-transform ${
              options.background === bg
                ? "border-blue-500 scale-110"
                : "border-[var(--color-border)]"
            }`}
            style={{ background: bg }}
          />
        ))}
      </div>

      <h4 className="text-xs font-medium text-[var(--color-text-secondary)]">
        内边距
      </h4>
      <input
        type="range"
        min={0}
        max={64}
        value={options.padding}
        onChange={(e) =>
          onChange({ ...options, padding: Number(e.target.value) })
        }
        className="w-full"
      />

      <h4 className="text-xs font-medium text-[var(--color-text-secondary)]">
        圆角
      </h4>
      <input
        type="range"
        min={0}
        max={32}
        value={options.borderRadius}
        onChange={(e) =>
          onChange({ ...options, borderRadius: Number(e.target.value) })
        }
        className="w-full"
      />

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={options.shadow}
          onChange={(e) => onChange({ ...options, shadow: e.target.checked })}
          className="rounded"
        />
        <span className="text-sm">阴影</span>
      </label>
    </div>
  );
};

export const defaultBeautifyOptions: BeautifyOptions = {
  background: "transparent",
  padding: 16,
  borderRadius: 8,
  shadow: true,
  shadowBlur: 20,
};
