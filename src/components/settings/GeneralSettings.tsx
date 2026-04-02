import { useState, useEffect, useRef, useCallback } from "react";
import {
  Monitor,
  Keyboard,
  Info,
  Loader2,
  Sun,
  Moon,
  Type,
  RefreshCw,
  Download,
  CheckCircle,
  AlertCircle,
  Bug,
} from "lucide-react";
import { handleError } from "@/core/errors";
import { invoke } from "@tauri-apps/api/core";
import { APP_NAME, APP_TECH_STACK } from "@/config/app-branding";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  FONT_SCALE_OPTIONS,
  applyGlobalFontScale,
  loadLocalFontScalePreference,
  saveLocalFontScalePreference,
} from "@/core/ui/local-ui-preferences";
import {
  getDialogStepTraceMode,
  setDialogStepTraceMode,
  isDialogStepTraceEnabled,
  getDialogStepTracePath,
} from "@/core/agent/actor/dialog-step-trace";

interface AppSettings {
  hideOnBlur: boolean;
  autoStart: boolean;
  alwaysOnTop: boolean;
  developerMode: boolean;
  theme: "light" | "dark";
  shortcutToggle: string;
  shortcutContext: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  hideOnBlur: true,
  autoStart: false,
  alwaysOnTop: true,
  developerMode: false,
  theme: "light",
  shortcutToggle: "Super+Digit2",
  shortcutContext: "Control+Shift+KeyA",
};

async function loadSettings(): Promise<AppSettings> {
  try {
    const json = await invoke<string>("load_general_settings");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(json) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await invoke("save_general_settings", {
      settings: JSON.stringify(settings),
    });
  } catch (e) {
    handleError(e, { context: "保存通用设置" });
  }
}

/** 将 KeyboardEvent 转换为 Tauri 快捷键格式，如 "Super+Digit2" */
function buildShortcutString(e: React.KeyboardEvent): string | null {
  const MODIFIER_CODES = new Set([
    "ControlLeft", "ControlRight",
    "ShiftLeft", "ShiftRight",
    "AltLeft", "AltRight",
    "MetaLeft", "MetaRight",
  ]);
  if (MODIFIER_CODES.has(e.code)) return null;

  const mods: string[] = [];
  if (e.metaKey) mods.push("Super");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  if (mods.length === 0) return null;
  return [...mods, e.code].join("+");
}

/** 将内部格式 "Super+Digit2" 转换为友好展示文本 */
function displayShortcut(raw: string): string {
  if (!raw) return "";
  return raw
    .split("+")
    .map((part) => {
      if (part === "Super") return "⌘/Win";
      if (part === "Control") return "Ctrl";
      if (part === "Alt") return "Alt";
      if (part === "Shift") return "⇧";
      if (part.startsWith("Key")) return part.slice(3);
      if (part.startsWith("Digit")) return part.slice(5);
      return part;
    })
    .join(" + ");
}

interface ShortcutRecorderProps {
  value: string;
  onChange: (val: string) => void;
  label: string;
}

function ShortcutRecorder({ value, onChange, label }: ShortcutRecorderProps) {
  const [capturing, setCapturing] = useState(false);
  const inputRef = useRef<HTMLButtonElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const shortcut = buildShortcutString(e);
      if (shortcut) {
        onChange(shortcut);
        setCapturing(false);
        inputRef.current?.blur();
      }
    },
    [onChange],
  );

  return (
    <div>
      <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] mb-1">
        <Keyboard className="w-3.5 h-3.5" />
        {label}
      </label>
      <button
        ref={inputRef}
        onClick={() => inputRef.current?.focus()}
        onFocus={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={capturing ? handleKeyDown : undefined}
        className={`w-full text-left bg-[var(--color-bg-secondary)] text-sm font-mono rounded-lg px-3 py-2 outline-none border transition-colors ${
          capturing
            ? "border-[var(--color-accent)] text-[var(--color-accent)]"
            : "border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]"
        }`}
        aria-label={label}
      >
        {capturing ? (
          <span className="opacity-60 text-xs">按下快捷键组合...</span>
        ) : (
          displayShortcut(value) || <span className="opacity-40 text-xs">点击设置快捷键</span>
        )}
      </button>
      <p className="text-[10px] text-[var(--color-text-secondary)] mt-1 opacity-60">
        点击后按下快捷键组合（需包含修饰键）· 当前: {value}
      </p>
    </div>
  );
}

type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export function GeneralSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateError, setUpdateError] = useState("");
  const [shortcutSaveMsg, setShortcutSaveMsg] = useState("");
  const [fontScale, setFontScale] = useState(loadLocalFontScalePreference);
  const [dialogTraceEnabled, setDialogTraceEnabled] = useState(false);
  const [tracePath, setTracePath] = useState("");

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setLoading(false);
    });
    getVersion().then(setAppVersion).catch(() => {});
    setDialogTraceEnabled(getDialogStepTraceMode() === "full");
    if (isDialogStepTraceEnabled()) {
      getDialogStepTracePath().then(setTracePath).catch(() => {});
    }
  }, []);

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateError("");
    setPendingUpdate(null);
    try {
      const update = await check();
      if (update?.available) {
        setPendingUpdate(update);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdateStatus("error");
    }
  };

  const handleInstallUpdate = async () => {
    if (!pendingUpdate) return;
    setUpdateStatus("downloading");
    setDownloadProgress(0);
    try {
      let downloaded = 0;
      let total = 0;
      await pendingUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            setDownloadProgress(Math.round((downloaded / total) * 100));
          }
        } else if (event.event === "Finished") {
          setUpdateStatus("installing");
        }
      });
      await relaunch();
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdateStatus("error");
    }
  };

  const updateSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    saveSettings(next);
    if (key === "theme") {
      document.documentElement.setAttribute("data-theme", value as string);
    }
  };

  const updateShortcut = async (key: "shortcutToggle" | "shortcutContext", value: string) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    await saveSettings(next);
    try {
      await invoke("reload_global_shortcuts");
      setShortcutSaveMsg("快捷键已更新");
    } catch (e) {
      setShortcutSaveMsg(`更新失败: ${e}`);
    }
    setTimeout(() => setShortcutSaveMsg(""), 2500);
  };

  const handleFontScaleChange = (value: number) => {
    const next = saveLocalFontScalePreference(value);
    setFontScale(next);
    applyGlobalFontScale(next);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 text-[var(--color-text-secondary)] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Monitor className="w-4 h-4 text-blue-400" />
        <h3 className="text-sm font-medium text-[var(--color-text)]">
          通用设置
        </h3>
      </div>

      {/* 全局快捷键设置 */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          <Keyboard className="w-3.5 h-3.5" />
          <span>全局快捷键</span>
          {shortcutSaveMsg && (
            <span className={`ml-auto text-[10px] ${shortcutSaveMsg.startsWith("更新失败") ? "text-red-400" : "text-green-500"}`}>
              {shortcutSaveMsg}
            </span>
          )}
        </div>

        <ShortcutRecorder
          label="唤醒 / 隐藏窗口"
          value={settings.shortcutToggle}
          onChange={(v) => updateShortcut("shortcutToggle", v)}
        />

        <ShortcutRecorder
          label="上下文操作（选中文本后触发）"
          value={settings.shortcutContext}
          onChange={(v) => updateShortcut("shortcutContext", v)}
        />
      </div>

      {/* 开关选项 */}
      <div className="space-y-3 pt-3 border-t border-[var(--color-border)]">
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-xs text-[var(--color-text)]">
            失焦自动隐藏窗口
          </span>
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-[var(--color-accent)]"
            checked={settings.hideOnBlur}
            onChange={(e) => updateSetting("hideOnBlur", e.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-xs text-[var(--color-text)]">窗口始终置顶</span>
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-[var(--color-accent)]"
            checked={settings.alwaysOnTop}
            onChange={(e) => updateSetting("alwaysOnTop", e.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-xs text-[var(--color-text)]">开机自动启动</span>
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-[var(--color-accent)]"
            checked={settings.autoStart}
            onChange={(e) => updateSetting("autoStart", e.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <span className="text-xs text-[var(--color-text)]">开发者模式</span>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              开启后可在插件页面管理开发目录
            </p>
          </div>
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-[var(--color-accent)]"
            checked={settings.developerMode}
            onChange={(e) => updateSetting("developerMode", e.target.checked)}
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer">
          <div>
            <div className="flex items-center gap-1.5">
              <Bug className="w-3.5 h-3.5 text-orange-500" />
              <span className="text-xs text-[var(--color-text)]">Dialog 调试追踪</span>
            </div>
            <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              记录所有 Dialog 运行步骤到文件
            </p>
            {tracePath && (
              <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 font-mono opacity-60">
                {tracePath}
              </p>
            )}
          </div>
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-[var(--color-accent)]"
            checked={dialogTraceEnabled}
            onChange={(e) => {
              const enabled = e.target.checked;
              setDialogStepTraceMode(enabled ? "full" : "off");
              setDialogTraceEnabled(enabled);
            }}
          />
        </label>
      </div>

      {/* 主题设置 */}
      <div className="pt-3 border-t border-[var(--color-border)]">
        <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] mb-2">
          <Sun className="w-3.5 h-3.5" />
          主题设置
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting("theme", "light")}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-colors ${
              settings.theme === "light"
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
            }`}
          >
            <Sun className="w-3.5 h-3.5" />
            清新浅色
          </button>
          <button
            onClick={() => updateSetting("theme", "dark")}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-colors ${
              settings.theme === "dark"
                ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
            }`}
          >
            <Moon className="w-3.5 h-3.5" />
            深色模式
          </button>
        </div>
      </div>

      <div className="pt-3 border-t border-[var(--color-border)]">
        <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] mb-2">
          <Type className="w-3.5 h-3.5" />
          显示设置
        </label>
        <div className="flex flex-wrap gap-2">
          {FONT_SCALE_OPTIONS.map((option) => {
            const active = fontScale === option;
            return (
              <button
                key={option}
                onClick={() => handleFontScaleChange(option)}
                className={`px-3 py-2 rounded-lg border text-xs transition-colors ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                    : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
                }`}
              >
                {option}x
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] text-[var(--color-text-secondary)]">
          仅当前设备生效并保存在本地。窗口右侧或右下角拖拽后，也会自动记住本机尺寸。
        </p>
      </div>

      {/* 快捷键说明 */}
      <div className="pt-3 border-t border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] mb-2">
          <Info className="w-3.5 h-3.5" />
          快捷键说明
        </div>
        <div className="space-y-1 text-[10px] text-[var(--color-text-secondary)]">
          <div className="flex justify-between">
            <span>唤醒/隐藏窗口</span>
            <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded font-mono">
              {displayShortcut(settings.shortcutToggle)}
            </kbd>
          </div>
          <div className="flex justify-between">
            <span>上下文操作（选中文本后）</span>
            <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded font-mono">
              {displayShortcut(settings.shortcutContext)}
            </kbd>
          </div>
          <div className="flex justify-between">
            <span>返回搜索框</span>
            <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded font-mono">
              Esc
            </kbd>
          </div>
        </div>
      </div>

      {/* 版本信息与更新检测 */}
      <div className="pt-3 border-t border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-xs text-[var(--color-text)] font-medium">
              {APP_NAME}
            </div>
            <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
              v{appVersion} · {APP_TECH_STACK}
            </div>
          </div>
          <button
            onClick={handleCheckUpdate}
            disabled={
              updateStatus === "checking" ||
              updateStatus === "downloading" ||
              updateStatus === "installing"
            }
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw
              className={`w-3 h-3 ${updateStatus === "checking" ? "animate-spin" : ""}`}
            />
            检查更新
          </button>
        </div>

        {updateStatus === "up-to-date" && (
          <div className="flex items-center gap-1.5 text-[10px] text-green-500">
            <CheckCircle className="w-3 h-3" />
            已是最新版本
          </div>
        )}

        {updateStatus === "error" && (
          <div className="flex items-start gap-1.5 text-[10px] text-red-400">
            <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
            <span className="break-all">{updateError || "检查更新失败"}</span>
          </div>
        )}

        {updateStatus === "available" && pendingUpdate && (
          <div className="mt-2 p-2.5 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-accent)] space-y-2">
            <div className="text-[10px] text-[var(--color-text)]">
              发现新版本{" "}
              <span className="font-bold text-[var(--color-accent)]">
                v{pendingUpdate.version}
              </span>
            </div>
            {pendingUpdate.body && (
              <div className="text-[10px] text-[var(--color-text-secondary)] leading-relaxed whitespace-pre-wrap">
                {pendingUpdate.body}
              </div>
            )}
            <button
              onClick={handleInstallUpdate}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
            >
              <Download className="w-3 h-3" />
              下载并安装
            </button>
          </div>
        )}

        {updateStatus === "downloading" && (
          <div className="mt-2 space-y-1.5">
            <div className="text-[10px] text-[var(--color-text-secondary)]">
              下载中... {downloadProgress}%
            </div>
            <div className="h-1.5 w-full bg-[var(--color-bg-secondary)] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--color-accent)] rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
          </div>
        )}

        {updateStatus === "installing" && (
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
            <Loader2 className="w-3 h-3 animate-spin" />
            安装中，即将重启...
          </div>
        )}
      </div>
    </div>
  );
}
