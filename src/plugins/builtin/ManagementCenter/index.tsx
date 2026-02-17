import { useState, useEffect } from "react";
import {
  User,
  Database,
  Users,
  Settings,
  Cpu,
  Keyboard,
  ChevronRight,
  LogOut,
  Server,
  Loader2,
  Zap,
  Ticket,
  X,
  CreditCard,
  Smartphone,
  Receipt,
  ShieldCheck,
  Sun,
  Moon,
  Info,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { handleError } from "@/core/errors";
import { useAuthStore } from "@/store/auth-store";
import { api } from "@/core/api/client";
import type { MToolsPluginProps } from "@/core/plugin-system/plugin-interface";
import { AIModelTab } from "./components/AIModelTab";
import { TeamTab } from "./components/TeamTab";
import { MyDataTab } from "./components/MyDataTab";
import { EnergyLogsTab } from "./components/EnergyLogsTab";
import { ServerConfigTab } from "./components/ServerConfigTab";
import { CredentialSettings } from "@/components/data-forge/CredentialSettings";

const BRAND = "#F28F36";

type TabId =
  | "account"
  | "data"
  | "team"
  | "settings"
  | "ai-model"
  | "credentials"
  | "shortcuts"
  | "server"
  | "energy-logs"
  | "payment-records"
  | "devices";

export default function ManagementCenter({ onBack }: MToolsPluginProps) {
  const [activeTab, setActiveTab] = useState<TabId>("account");

  const navItems: { id: TabId; icon: any; label: string; group: string }[] = [
    { id: "account", icon: User, label: "我的账号", group: "个人中心" },
    { id: "data", icon: Database, label: "我的数据", group: "个人中心" },
    { id: "team", icon: Users, label: "团队空间", group: "个人中心" },
    { id: "settings", icon: Settings, label: "通用设置", group: "偏好设置" },
    { id: "ai-model", icon: Cpu, label: "AI 模型", group: "偏好设置" },
    { id: "credentials", icon: ShieldCheck, label: "凭证管理", group: "偏好设置" },
    { id: "server", icon: Server, label: "服务器地址", group: "偏好设置" },
    { id: "shortcuts", icon: Keyboard, label: "快捷方式", group: "偏好设置" },
  ];

  const groups = Array.from(new Set(navItems.map((item) => item.group)));

  return (
    <div className="flex h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Sidebar */}
      <div className="w-[160px] border-r border-[var(--color-border)] flex flex-col pt-3 shrink-0">
        <div className="px-3 mb-4">
          <h1 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
            管理中心
          </h1>
        </div>

        <nav className="flex-1 px-1.5 space-y-4 overflow-y-auto">
          {groups.map((group) => (
            <div key={group}>
              <div className="px-2 mb-1 text-[10px] font-semibold text-[var(--color-text-secondary)] opacity-50 uppercase tracking-widest">
                {group}
              </div>
              <div className="space-y-0.5">
                {navItems
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-medium transition-all ${
                        activeTab === item.id
                          ? "font-semibold"
                          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
                      }`}
                      style={
                        activeTab === item.id
                          ? { background: `${BRAND}15`, color: BRAND }
                          : undefined
                      }
                    >
                      <item.icon className="w-3.5 h-3.5" />
                      {item.label}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-2 border-t border-[var(--color-border)]">
          <button
            onClick={onBack}
            className="w-full flex items-center justify-center py-1.5 text-[10px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          >
            返回搜索框
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === "account" && (
            <AccountTab onNavigate={setActiveTab} />
          )}
          {activeTab === "data" && <MyDataTab />}
          {activeTab === "team" && <TeamTab />}
          {activeTab === "settings" && <GeneralSettingsTab />}
          {activeTab === "ai-model" && <AIModelTab />}
          {activeTab === "server" && <ServerConfigTab />}
          {activeTab === "credentials" && (
            <div className="max-w-xl mx-auto">
              <CredentialSettings />
            </div>
          )}
          {activeTab === "energy-logs" && <EnergyLogsTab />}
          {activeTab === "payment-records" && <PaymentRecordsTab />}
          {activeTab === "devices" && <DevicesTab />}
          {activeTab === "shortcuts" && (
            <PlaceholderTab title="全局快捷键设置" />
          )}
        </div>
      </div>
    </div>
  );
}

// ── 我的账号 ──

function AccountTab({ onNavigate }: { onNavigate: (tab: TabId) => void }) {
  const { user, logout } = useAuthStore();
  const [energy, setEnergy] = useState<number>(user?.energy || 0);
  const [loading, setLoading] = useState(true);
  const [showEditProfile, setShowEditProfile] = useState(false);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await api.get<{ balance: number }>("/ai/energy");
        setEnergy(res.balance);
      } catch (err) {
        handleError(err, { context: "获取 AI 能量" });
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, []);

  const registerDays = user?.registered_at
    ? Math.floor(
        (Date.now() - new Date(user.registered_at).getTime()) /
          (1000 * 60 * 60 * 24),
      ) + 1
    : 1;

  return (
    <div className="max-w-xl mx-auto space-y-4">
      {/* Profile Header */}
      <div className="bg-[var(--color-bg)] rounded-xl p-4 border border-[var(--color-border)] flex items-center gap-4">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center border overflow-hidden shrink-0"
          style={{ background: `${BRAND}15`, borderColor: `${BRAND}30` }}
        >
          {user?.avatar_url ? (
            <img
              src={user.avatar_url}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <User className="w-6 h-6" style={{ color: BRAND }} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold truncate">
              {user?.username || "未设置昵称"}
            </h2>
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase text-white leading-none shrink-0"
              style={{ background: BRAND }}
            >
              {user?.plan || "FREE"}
            </span>
          </div>
          <p className="text-[var(--color-text-secondary)] text-xs mt-0.5 truncate">
            {user?.phone
              ? user.phone.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2")
              : user?.email || ""}
            {(user?.phone || user?.email) && "  ·  "}
            已陪伴你 {registerDays} 天
          </p>
        </div>
        <button
          onClick={() => setShowEditProfile(true)}
          className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] transition-all text-xs font-medium shrink-0"
        >
          修改资料
        </button>
      </div>

      {/* Energy & Stats */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-[var(--color-bg)] rounded-xl p-4 border border-[var(--color-border)]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              AI 能量
            </span>
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: BRAND }} />
            ) : (
              <Zap className="w-3.5 h-3.5" style={{ color: BRAND }} />
            )}
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-bold" style={{ color: BRAND }}>
              {energy.toLocaleString()}
            </span>
            <span className="text-[10px] text-[var(--color-text-secondary)]">
              点
            </span>
          </div>
          <button
            className="w-full mt-3 py-1.5 rounded-lg text-white text-xs font-semibold opacity-50 cursor-not-allowed"
            style={{ background: BRAND }}
          >
            购买能量（即将上线）
          </button>
        </div>

        <div className="bg-[var(--color-bg)] rounded-xl p-4 border border-[var(--color-border)]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              代金券
            </span>
            <Ticket className="w-3.5 h-3.5 text-orange-400" />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-bold text-orange-400">0</span>
            <span className="text-[10px] text-[var(--color-text-secondary)]">
              张
            </span>
          </div>
          <button className="w-full mt-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] text-xs font-medium transition-all opacity-50 cursor-not-allowed">
            兑换代金券（即将上线）
          </button>
        </div>
      </div>

      {/* Account Actions */}
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        <ActionItem
          label="能量流水"
          icon={Zap}
          onClick={() => onNavigate("energy-logs")}
        />
        <ActionItem
          label="支付记录"
          icon={Receipt}
          onClick={() => onNavigate("payment-records")}
        />
        <ActionItem
          label="设备管理"
          icon={Smartphone}
          onClick={() => onNavigate("devices")}
        />
        <button
          onClick={logout}
          className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-red-500/5 transition-colors"
        >
          <LogOut className="w-3.5 h-3.5 text-red-500" />
          <span className="text-xs font-medium text-red-500">退出登录</span>
        </button>
      </div>

      {showEditProfile && (
        <EditProfileModal onClose={() => setShowEditProfile(false)} />
      )}
    </div>
  );
}

// ── 修改资料弹窗 ──

function EditProfileModal({ onClose }: { onClose: () => void }) {
  const { user, login } = useAuthStore();
  const [username, setUsername] = useState(user?.username || "");
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!username.trim()) {
      setError("昵称不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const updatedUser = await api.patch<typeof user>("/users/me", {
        username: username.trim(),
        avatar_url: avatarUrl.trim() || null,
      });
      if (updatedUser) {
        login(
          updatedUser as any,
          useAuthStore.getState().token!,
          useAuthStore.getState().refreshToken || undefined,
        );
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[var(--color-bg)] w-[360px] rounded-xl p-5 border border-[var(--color-border)] shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">修改资料</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-secondary)]"
          >
            <X className="w-4 h-4 text-[var(--color-text-secondary)]" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              昵称
            </label>
            <input
              autoFocus
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-1 w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs focus:ring-2 transition-all text-[var(--color-text)]"
              style={{ "--tw-ring-color": `${BRAND}40` } as any}
            />
          </div>

          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              头像 URL（可选）
            </label>
            <input
              type="url"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://..."
              className="mt-1 w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs focus:ring-2 transition-all text-[var(--color-text)]"
            />
          </div>

          {avatarUrl && (
            <div className="flex justify-center">
              <img
                src={avatarUrl}
                alt="预览"
                className="w-12 h-12 rounded-lg object-cover border border-[var(--color-border)]"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
          )}

          {error && (
            <p className="text-[10px] text-red-500 text-center">{error}</p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="flex-1 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] text-xs font-medium transition-all"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2 rounded-lg text-white text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1"
              style={{ background: BRAND }}
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 通用设置 ──

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

function GeneralSettingsTab() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const json = await invoke<string>("load_general_settings");
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(json) });
      } catch {
        /* use defaults */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const updateSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    invoke("save_general_settings", { settings: JSON.stringify(next) }).catch(
      (e) => handleError(e, { context: "保存通用设置" }),
    );
    if (key === "theme") {
      document.documentElement.setAttribute("data-theme", value as string);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: BRAND }} />
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <div>
        <h2 className="text-sm font-semibold">通用设置</h2>
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
          应用程序的通用偏好设置
        </p>
      </div>

      {/* 开关选项 */}
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] overflow-hidden divide-y divide-[var(--color-border)]">
        <SettingRow
          label="失焦自动隐藏窗口"
          description="窗口失去焦点时自动隐藏"
          action={
            <ToggleSwitch
              on={settings.hideOnBlur}
              onChange={(v) => updateSetting("hideOnBlur", v)}
            />
          }
        />
        <SettingRow
          label="窗口始终置顶"
          description="窗口始终在最前面显示"
          action={
            <ToggleSwitch
              on={settings.alwaysOnTop}
              onChange={(v) => updateSetting("alwaysOnTop", v)}
            />
          }
        />
        <SettingRow
          label="开机自启动"
          description="系统启动时自动运行"
          action={
            <ToggleSwitch
              on={settings.autoStart}
              onChange={(v) => updateSetting("autoStart", v)}
            />
          }
        />
        <SettingRow
          label="开发者模式"
          description="开启后可在插件页面管理开发目录"
          action={
            <ToggleSwitch
              on={settings.developerMode}
              onChange={(v) => updateSetting("developerMode", v)}
            />
          }
        />
      </div>

      {/* 主题设置 */}
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <Sun className="w-3.5 h-3.5" style={{ color: BRAND }} />
          <span className="text-xs font-medium">主题设置</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => updateSetting("theme", "light")}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-colors ${
              settings.theme === "light"
                ? "text-white"
                : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
            }`}
            style={
              settings.theme === "light"
                ? { background: BRAND, borderColor: BRAND }
                : undefined
            }
          >
            <Sun className="w-3.5 h-3.5" />
            清新浅色
          </button>
          <button
            onClick={() => updateSetting("theme", "dark")}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-colors ${
              settings.theme === "dark"
                ? "text-white"
                : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
            }`}
            style={
              settings.theme === "dark"
                ? { background: BRAND, borderColor: BRAND }
                : undefined
            }
          >
            <Moon className="w-3.5 h-3.5" />
            深色模式
          </button>
        </div>
      </div>

      {/* 快捷键说明 */}
      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <Info className="w-3.5 h-3.5" style={{ color: BRAND }} />
          <span className="text-xs font-medium">快捷键说明</span>
        </div>
        <div className="space-y-2 text-[10px] text-[var(--color-text-secondary)]">
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
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-2 opacity-60">
          自定义快捷键功能暂不支持，后续版本开放
        </p>
      </div>

      {/* 版本信息 */}
      <div className="text-center pt-2">
        <div className="text-xs text-[var(--color-text)]">mTools</div>
        <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
          v0.1.0 · Tauri v2 + React 19
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  description,
  action,
}: {
  label: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div>
        <div className="text-xs font-medium">{label}</div>
        <div className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
          {description}
        </div>
      </div>
      {action}
    </div>
  );
}

function ToggleSwitch({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="relative w-8 h-[18px] rounded-full transition-colors shrink-0"
      style={{
        background: on ? BRAND : "var(--color-bg-secondary)",
        border: on ? "none" : "1px solid var(--color-border)",
      }}
    >
      <div
        className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${on ? "translate-x-[15px]" : "translate-x-[2px]"}`}
      />
    </button>
  );
}

// ── 支付记录 ──

function PaymentRecordsTab() {
  return (
    <div className="max-w-xl mx-auto space-y-4">
      <div>
        <h2 className="text-sm font-semibold">支付记录</h2>
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
          您的订单和交易记录
        </p>
      </div>
      <div className="text-center py-12 bg-[var(--color-bg)] rounded-xl border border-dashed border-[var(--color-border)]">
        <CreditCard className="w-8 h-8 text-[var(--color-text-secondary)] mx-auto mb-2 opacity-20" />
        <p className="text-xs text-[var(--color-text-secondary)]">暂无支付记录</p>
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 opacity-60">
          支付功能即将上线
        </p>
      </div>
    </div>
  );
}

// ── 设备管理 ──

function DevicesTab() {
  return (
    <div className="max-w-xl mx-auto space-y-4">
      <div>
        <h2 className="text-sm font-semibold">设备管理</h2>
        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
          管理登录过此账号的设备
        </p>
      </div>

      <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Smartphone className="w-4 h-4 text-emerald-500" />
            </div>
            <div>
              <div className="text-xs font-medium">当前设备</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">
                {navigator.userAgent.includes("Mac") ? "macOS" : navigator.userAgent.includes("Win") ? "Windows" : "Desktop"}
              </div>
            </div>
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500">
            当前
          </span>
        </div>
      </div>

      <p className="text-[10px] text-[var(--color-text-secondary)] text-center opacity-60">
        多设备管理功能即将上线
      </p>
    </div>
  );
}

// ── 通用组件 ──

function ActionItem({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: any;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] transition-colors group last:border-0"
    >
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)] group-hover:translate-x-0.5 transition-transform" />
    </button>
  );
}

function PlaceholderTab({ title }: { title: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center">
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
        style={{ background: `${BRAND}15` }}
      >
        <Database className="w-6 h-6" style={{ color: BRAND }} />
      </div>
      <h2 className="text-sm font-semibold mb-1">{title}</h2>
      <p className="text-xs text-[var(--color-text-secondary)] max-w-xs">
        此功能正在开发中，敬请期待。
      </p>
    </div>
  );
}
