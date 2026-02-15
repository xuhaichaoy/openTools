import { useState, useEffect } from "react";
import { Monitor, Keyboard, Info, Loader2, Sun, Moon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface AppSettings {
  hideOnBlur: boolean;
  autoStart: boolean;
  alwaysOnTop: boolean;
  developerMode: boolean;
  theme: "light" | "dark";
}

const DEFAULT_SETTINGS: AppSettings = {
  hideOnBlur: true,
  autoStart: false,
  alwaysOnTop: true,
  developerMode: false,
  theme: "light",
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
    console.error("保存设置失败:", e);
  }
}

export function GeneralSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setLoading(false);
    });
  }, []);

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

      {/* 快捷键 */}
      <div>
        <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] mb-1">
          <Keyboard className="w-3.5 h-3.5" />
          全局唤醒快捷键
        </label>
        <input
          type="text"
          className="w-full bg-[var(--color-bg-secondary)] text-[var(--color-text)] text-sm font-mono rounded-lg px-3 py-2 outline-none border border-[var(--color-border)] focus:border-[var(--color-accent)]"
          value="Command + 2"
          readOnly
          aria-label="全局唤醒快捷键"
        />
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-1 opacity-60">
          暂不支持自定义，后续版本开放
        </p>
      </div>

      {/* 开关选项 */}
      <div className="space-y-3">
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
              Command + 2
            </kbd>
          </div>
          <div className="flex justify-between">
            <span>上下文操作（选中文本后）</span>
            <kbd className="px-1.5 py-0.5 bg-[var(--color-bg-secondary)] rounded font-mono">
              Ctrl + Shift + A
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

      {/* 版本信息 */}
      <div className="pt-3 border-t border-[var(--color-border)] text-center">
        <div className="text-xs text-[var(--color-text)]">mTools</div>
        <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
          v0.1.0 · Tauri v2 + React 19
        </div>
      </div>
    </div>
  );
}
