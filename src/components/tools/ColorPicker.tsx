import { useState, useEffect, useCallback } from "react";
import { ArrowLeft } from "lucide-react";
import { handleError } from "@/core/errors";
import { useDragWindow } from "@/hooks/useDragWindow";
import { invoke } from "@tauri-apps/api/core";

const PALETTE = [
  "#FFEBEE", "#EF9A9A", "#EF5350", "#E53935", "#B71C1C", "#FF1744",
  "#FCE4EC", "#F48FB1", "#EC407A", "#D81B60", "#880E4F", "#FF4081",
  "#F3E5F5", "#CE93D8", "#AB47BC", "#8E24AA", "#4A148C", "#E040FB",
  "#EDE7F6", "#B39DDB", "#7E57C2", "#5E35B1", "#311B92", "#7C4DFF",
  "#E8EAF6", "#9FA8DA", "#5C6BC0", "#3949AB", "#1A237E", "#536DFE",
  "#E3F2FD", "#90CAF9", "#42A5F5", "#1E88E5", "#0D47A1", "#448AFF",
  "#E0F7FA", "#80DEEA", "#26C6DA", "#00ACC1", "#006064", "#18FFFF",
  "#E0F2F1", "#80CBC4", "#26A69A", "#00897B", "#004D40", "#64FFDA",
  "#E8F5E9", "#A5D6A7", "#66BB6A", "#43A047", "#1B5E20", "#69F0AE",
  "#FFFDE7", "#FFF59D", "#FFEE58", "#FDD835", "#F57F17", "#FFFF00",
  "#FFF3E0", "#FFCC80", "#FFA726", "#FB8C00", "#E65100", "#FF9100",
  "#FAFAFA", "#BDBDBD", "#757575", "#424242", "#212121", "#000000",
];

const MAX_HISTORY = 24;
const HISTORY_KEY = "mtools-color-history";

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function hexToHsl(hex: string): [number, number, number] {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = ((b - r) / d + 2);
    else h = ((r - g) / d + 4);
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

function getColorName(h: number, s: number, l: number): string {
  if (l <= 5) return "黑色";
  if (l >= 95 && s <= 10) return "白色";
  if (s <= 10) return l < 30 ? "深灰" : l < 60 ? "灰色" : "浅灰";
  const names: [number, string][] = [
    [0, "红色"], [15, "橙红"], [30, "橙色"], [45, "橙黄"], [60, "黄色"], [80, "黄绿"],
    [120, "绿色"], [160, "青绿"], [180, "青色"], [200, "天蓝"], [240, "蓝色"], [260, "靛蓝"],
    [280, "紫色"], [300, "紫红"], [330, "玫红"], [360, "红色"],
  ];
  let name = "红色";
  for (const [th, n] of names) {
    if (h <= th) { name = n; break; }
  }
  if (l < 35) name = "暗" + name;
  else if (l > 75) name = "亮" + name;
  return name;
}

type EyeDropperResult = { sRGBHex: string };
type EyeDropperLike = { open: () => Promise<EyeDropperResult> };
type EyeDropperCtor = new () => EyeDropperLike;

function getEyeDropperCtor(): EyeDropperCtor | null {
  const maybeCtor = (window as Window & { EyeDropper?: EyeDropperCtor })
    .EyeDropper;
  return maybeCtor ?? null;
}

export function ColorPicker({ onBack }: { onBack: () => void }) {
  const [H, setH] = useState(260);
  const [S, setS] = useState(72);
  const [L, setL] = useState(63);
  const [A, setA] = useState(100);
  const [history, setHistory] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [hexInput, setHexInput] = useState(() => rgbToHex(...hslToRgb(260, 72, 63)));
  const [hexInputFocused, setHexInputFocused] = useState(false);
  const { onMouseDown } = useDragWindow();

  const rgb = hslToRgb(H, S, L);
  const hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
  const alpha = A / 100;

  useEffect(() => {
    if (!hexInputFocused) setHexInput(hex);
  }, [hex, hexInputFocused]);

  const loadHistory = useCallback(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setHistory(arr.slice(0, MAX_HISTORY));
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const addToHistory = useCallback((colorHex: string) => {
    const hex = colorHex.toUpperCase().startsWith("#") ? colorHex.toUpperCase() : "#" + colorHex.toUpperCase();
    const normalized = hex.length === 4 ? "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3] : hex;
    setHistory((prev) => [normalized, ...prev.filter((c) => c !== normalized)].slice(0, MAX_HISTORY));
    try {
      const next = [normalized, ...history.filter((c) => c !== normalized)].slice(0, MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch (_) {}
  }, [history]);

  const setColorFromHex = useCallback((colorHex: string) => {
    if (!colorHex || colorHex.length < 3) return;
    const h = colorHex.startsWith("#") ? colorHex : "#" + colorHex;
    const normalized = h.length === 4 ? "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3] : h;
    if (!/^#[0-9A-Fa-f]{6}$/.test(normalized)) return;
    const [hue, sat, light] = hexToHsl(normalized);
    setH(hue);
    setS(sat);
    setL(light);
    setA(100);
    setHexInput(normalized);
    addToHistory(normalized);
  }, [addToHistory]);

  const applyHexInput = useCallback(() => {
    const raw = hexInput.trim();
    if (!raw) return;
    const withHash = raw.startsWith("#") ? raw : "#" + raw;
    const normalized = withHash.length === 4 ? "#" + withHash[1] + withHash[1] + withHash[2] + withHash[2] + withHash[3] + withHash[3] : withHash;
    if (/^#[0-9A-Fa-f]{6}$/.test(normalized)) {
      setColorFromHex(normalized);
    } else {
      setHexInput(hex);
    }
    setHexInputFocused(false);
  }, [hexInput, hex, setColorFromHex]);

  const setColorFromRgb = useCallback((r: number, g: number, b: number) => {
    const [hue, sat, light] = hexToHsl(rgbToHex(r, g, b));
    setH(hue);
    setS(sat);
    setL(light);
    setHexInput(rgbToHex(r, g, b));
    addToHistory(rgbToHex(r, g, b));
  }, [addToHistory]);

  const handleScreenPick = useCallback(async () => {
    const isWindows = navigator.platform.toLowerCase().includes("win");

    const pickWithEyeDropper = async (): Promise<"picked" | "failed" | "cancelled"> => {
      const ctor = getEyeDropperCtor();
      if (!ctor) return "failed";
      try {
        const result = await new ctor().open();
        if (result?.sRGBHex) {
          setColorFromHex(result.sRGBHex.toUpperCase());
          return "picked";
        }
      } catch (e) {
        const message = String(e).toLowerCase();
        if (
          message.includes("abort") ||
          message.includes("cancel") ||
          message.includes("denied")
        ) {
          return "cancelled";
        }
        // 用户取消或浏览器拦截时仅作为降级分支，不弹阻断错误
        handleError(e, { context: "EyeDropper 取色", silent: true });
      }
      return "failed";
    };

    const pickWithNative = async () => {
      try {
        const result = await invoke<string>("plugin_start_color_picker");
        if (result) {
          setColorFromHex(result);
          return true;
        }
      } catch (e) {
        handleError(e, { context: "屏幕取色", silent: true });
      }
      return false;
    };

    setPicking(true);
    try {
      let picked = false;
      if (isWindows) {
        const eyeResult = await pickWithEyeDropper();
        if (eyeResult === "cancelled") return;
        picked = eyeResult === "picked";
        if (!picked) picked = await pickWithNative();
      } else {
        picked = await pickWithNative();
        if (!picked) {
          const eyeResult = await pickWithEyeDropper();
          if (eyeResult === "cancelled") return;
          picked = eyeResult === "picked";
        }
      }
      if (!picked) {
        handleError(new Error("当前环境不支持屏幕取色"), {
          context: "屏幕取色",
        });
      }
    } finally {
      setPicking(false);
    }
  }, [setColorFromHex]);

  const copyToClipboard = useCallback(async (text: string, kind: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    addToHistory(hex);
    setTimeout(() => setCopied(null), 800);
  }, [hex, addToHistory]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  }, []);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] rounded-xl overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-[var(--color-text)]">取色器</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 顶部：屏幕取色 + 预览 */}
        <div className="flex gap-4 items-center">
          <button
            type="button"
            onClick={handleScreenPick}
            disabled={picking}
            className="w-28 h-28 flex-shrink-0 rounded-2xl border-2 border-dashed border-[var(--color-border)] bg-gradient-to-br from-indigo-500 to-indigo-300 text-white flex flex-col items-center justify-center gap-1.5 font-semibold text-xs hover:scale-[1.02] hover:shadow-lg active:scale-[0.98] disabled:opacity-60"
          >
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="m2 22 1-1h3l9-9" />
              <path d="M3 21v-3l9-9" />
              <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3L15 6" />
            </svg>
            <span className="leading-tight">{picking ? "取色中..." : "屏幕取色"}</span>
          </button>

          <div
            className="w-28 h-28 flex-shrink-0 rounded-2xl border-2 border-[var(--color-border)] cursor-pointer overflow-hidden hover:border-indigo-500 bg-[length:16px_16px]"
            style={
              alpha < 1
                ? {
                    backgroundImage: `linear-gradient(rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha}), rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})), repeating-conic-gradient(#fff 0% 25%, #ddd 0% 50%)`,
                  }
                : { backgroundColor: hex }
            }
            onClick={() => document.getElementById("native-color-input")?.click()}
            title={hex}
          />
          <input
            id="native-color-input"
            type="color"
            className="sr-only w-0 h-0"
            value={hex}
            onChange={(e) => setColorFromHex(e.target.value)}
          />

          <div className="flex-1 flex flex-col justify-center gap-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-text-secondary)] shrink-0">HEX</span>
              <input
                type="text"
                value={hexInput}
                onChange={(e) => setHexInput(e.target.value)}
                onFocus={() => setHexInputFocused(true)}
                onBlur={applyHexInput}
                onKeyDown={(e) => e.key === "Enter" && applyHexInput()}
                placeholder="#000000"
                className="text-lg font-bold font-mono tracking-wide text-[var(--color-text)] bg-transparent border-b border-[var(--color-border)] outline-none focus:border-indigo-500 w-28 px-1 py-0.5"
              />
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-[var(--color-text-secondary)] shrink-0">RGB</span>
              {([["R", rgb[0]], ["G", rgb[1]], ["B", rgb[2]]] as const).map(([label, val]) => (
                <input
                  key={label}
                  type="number"
                  min={0}
                  max={255}
                  value={val}
                  onChange={(e) => {
                    const v = Math.min(255, Math.max(0, Number(e.target.value) || 0));
                    const next = label === "R" ? [v, rgb[1], rgb[2]] : label === "G" ? [rgb[0], v, rgb[2]] : [rgb[0], rgb[1], v];
                    setColorFromRgb(next[0], next[1], next[2]);
                  }}
                  className="w-12 text-center text-sm font-mono text-[var(--color-text)] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded px-1 py-0.5 outline-none focus:border-indigo-500"
                />
              ))}
            </div>
            <div className="text-xs text-[var(--color-text-secondary)]">{getColorName(H, S, L)}</div>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => copyToClipboard(hex, "hex")}
                className="px-2.5 py-1 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:border-indigo-500 hover:text-[var(--color-text)]"
              >
                复制 HEX
              </button>
              <button
                type="button"
                onClick={() => copyToClipboard(`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`, "rgb")}
                className="px-2.5 py-1 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:border-indigo-500 hover:text-[var(--color-text)]"
              >
                复制 RGB
              </button>
              <button
                type="button"
                onClick={() => copyToClipboard(`hsl(${H}, ${S}%, ${L}%)`, "hsl")}
                className="px-2.5 py-1 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:border-indigo-500 hover:text-[var(--color-text)]"
              >
                复制 HSL
              </button>
            </div>
          </div>
        </div>

        {/* 滑块 */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 space-y-3">
          <div className="flex justify-between text-xs text-[var(--color-text-secondary)]">
            <span>色相 H</span>
            <span className="font-mono text-[var(--color-text)]">{H}°</span>
          </div>
          <input
            type="range"
            min={0}
            max={360}
            value={H}
            onChange={(e) => setH(Number(e.target.value))}
            className="w-full h-2 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--color-border)] [&::-webkit-slider-thumb]:cursor-pointer"
            style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
          />
          <div className="flex justify-between text-xs text-[var(--color-text-secondary)]">
            <span>饱和度 S</span>
            <span className="font-mono text-[var(--color-text)]">{S}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={S}
            onChange={(e) => setS(Number(e.target.value))}
            className="w-full h-2 rounded-full appearance-none bg-[var(--color-bg)]"
            style={{ background: `linear-gradient(to right, hsl(${H},0%,${L}%), hsl(${H},100%,${L}%))` }}
          />
          <div className="flex justify-between text-xs text-[var(--color-text-secondary)]">
            <span>亮度 L</span>
            <span className="font-mono text-[var(--color-text)]">{L}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={L}
            onChange={(e) => setL(Number(e.target.value))}
            className="w-full h-2 rounded-full appearance-none"
            style={{ background: `linear-gradient(to right, hsl(${H},${S}%,0%), hsl(${H},${S}%,50%), hsl(${H},${S}%,100%))` }}
          />
          <div className="flex justify-between text-xs text-[var(--color-text-secondary)]">
            <span>透明度 A</span>
            <span className="font-mono text-[var(--color-text)]">{A}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={A}
            onChange={(e) => setA(Number(e.target.value))}
            className="w-full h-2 rounded-full appearance-none bg-[var(--color-bg)]"
          />
        </div>

        {/* 色值卡片 */}
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: "HEX", value: hex, key: "hex" },
            { label: "RGB", value: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`, key: "rgb" },
            { label: "HSL", value: `hsl(${H}, ${S}%, ${L}%)`, key: "hsl" },
            { label: "RGBA", value: `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`, key: "rgba" },
          ].map(({ label, value, key }) => (
            <button
              key={key}
              type="button"
              onClick={() => copyToClipboard(value, key)}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-left hover:border-indigo-500 hover:bg-[var(--color-bg-hover)] relative"
            >
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)] font-semibold mb-1">{label}</div>
              <div className="text-xs font-mono text-[var(--color-text)] break-all">{value}</div>
              {copied === key && (
                <span className="absolute inset-0 flex items-center justify-center text-xs bg-indigo-500/90 text-white rounded-xl">已复制</span>
              )}
            </button>
          ))}
        </div>

        {/* 调色板 */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
          <div className="text-xs text-[var(--color-text-secondary)] font-medium mb-2">常用颜色</div>
          <div className="grid grid-cols-12 gap-1.5">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                className="aspect-square rounded-md border-2 border-transparent hover:scale-110 hover:border-white hover:shadow-lg transition-transform"
                style={{ backgroundColor: c }}
                title={c}
                onClick={() => setColorFromHex(c)}
              />
            ))}
          </div>
        </div>

        {/* 历史 */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs text-[var(--color-text-secondary)] font-medium">最近使用</span>
            <button
              type="button"
              onClick={clearHistory}
              className="text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] px-2 py-1 rounded"
            >
              清空
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {history.length === 0 ? (
              <span className="text-[11px] text-[var(--color-text-secondary)]">暂无记录</span>
            ) : (
              history.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="w-6 h-6 rounded-md border-2 border-transparent hover:scale-110 hover:border-white transition-transform"
                  style={{ backgroundColor: h }}
                  title={h}
                  onClick={() => setColorFromHex(h)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
