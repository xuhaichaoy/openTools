/**
 * ChannelConfigPanel — IM 通道配置 UI 面板
 *
 * 支持在 UI 层面配置和管理 IM 通道（钉钉/企微/飞书等）。
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  MessageSquare,
  Plus,
  Trash2,
  Power,
  PowerOff,
  Send,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  getChannelManager,
  type ChannelConfig,
  type ChannelType,
  type ChannelStatus,
} from "@/core/channels";

const CHANNEL_STORAGE_KEY = "mtools_im_channels";

const STATUS_MAP: Record<ChannelStatus, { icon: React.ReactNode; label: string; color: string }> = {
  connected: { icon: <CheckCircle2 className="w-3 h-3" />, label: "已连接", color: "text-green-500" },
  connecting: { icon: <Loader2 className="w-3 h-3 animate-spin" />, label: "连接中", color: "text-blue-500" },
  disconnected: { icon: <PowerOff className="w-3 h-3" />, label: "未连接", color: "text-gray-400" },
  error: { icon: <XCircle className="w-3 h-3" />, label: "错误", color: "text-red-500" },
};

const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  dingtalk: "钉钉",
  wecom: "企业微信",
  feishu: "飞书",
  slack: "Slack",
};

interface SavedChannel {
  config: ChannelConfig;
}

function loadSavedChannels(): SavedChannel[] {
  try {
    const raw = localStorage.getItem(CHANNEL_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedChannel[];
  } catch { return []; }
}

function saveSavedChannels(channels: SavedChannel[]): void {
  localStorage.setItem(CHANNEL_STORAGE_KEY, JSON.stringify(channels));
}

const ChannelConfigPanel: React.FC = () => {
  const [channels, setChannels] = useState<SavedChannel[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ChannelStatus>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [testMsg, setTestMsg] = useState("");
  const [testChannelId, setTestChannelId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form state for new channel
  const [formType, setFormType] = useState<ChannelType>("dingtalk");
  const [formName, setFormName] = useState("");
  const [formWebhookUrl, setFormWebhookUrl] = useState("");
  const [formSecret, setFormSecret] = useState("");
  const [formAppKey, setFormAppKey] = useState("");
  const [formAppSecret, setFormAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    setChannels(loadSavedChannels());
    refreshStatuses();
  }, []);

  const refreshStatuses = useCallback(() => {
    const mgr = getChannelManager();
    const all = mgr.getStatuses();
    const map: Record<string, ChannelStatus> = {};
    for (const s of all) map[s.id] = s.status;
    setStatuses(map);
  }, []);

  const handleAdd = useCallback(async () => {
    if (!formName.trim() || !formWebhookUrl.trim()) return;

    const id = `ch-${Date.now().toString(36)}`;
    const config: ChannelConfig = {
      id,
      type: formType,
      name: formName.trim(),
      enabled: true,
      platformConfig: {
        webhookUrl: formWebhookUrl.trim(),
        ...(formSecret ? { secret: formSecret.trim() } : {}),
        ...(formAppKey ? { appKey: formAppKey.trim(), appSecret: formAppSecret.trim() } : {}),
      },
    };

    try {
      const mgr = getChannelManager();
      await mgr.register(config);

      const saved: SavedChannel = { config };
      const updated = [...channels, saved];
      setChannels(updated);
      saveSavedChannels(updated);
      refreshStatuses();

      // Reset form
      setFormName("");
      setFormWebhookUrl("");
      setFormSecret("");
      setFormAppKey("");
      setFormAppSecret("");
      setShowAdd(false);
    } catch (err) {
      alert(`连接失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [formType, formName, formWebhookUrl, formSecret, formAppKey, formAppSecret, channels, refreshStatuses]);

  const handleRemove = useCallback(async (id: string) => {
    const mgr = getChannelManager();
    await mgr.unregister(id);
    const updated = channels.filter((c) => c.config.id !== id);
    setChannels(updated);
    saveSavedChannels(updated);
    refreshStatuses();
  }, [channels, refreshStatuses]);

  const handleToggle = useCallback(async (ch: SavedChannel) => {
    const mgr = getChannelManager();
    const current = statuses[ch.config.id];
    if (current === "connected") {
      await mgr.unregister(ch.config.id);
    } else {
      await mgr.register({ ...ch.config, enabled: true });
    }
    refreshStatuses();
  }, [statuses, refreshStatuses]);

  const handleSendTest = useCallback(async () => {
    if (!testChannelId || !testMsg.trim()) return;
    setSending(true);
    try {
      const mgr = getChannelManager();
      await mgr.send(testChannelId, { conversationId: "default", text: testMsg.trim() });
      setTestMsg("");
      setTestChannelId(null);
    } catch (err) {
      alert(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  }, [testChannelId, testMsg]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-medium">IM 通道</span>
          <span className="text-[10px] text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] px-1.5 py-0.5 rounded-full">
            {channels.length} 个
          </span>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600"
        >
          <Plus className="w-3.5 h-3.5" />
          添加通道
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] space-y-2.5">
          <div className="flex items-center gap-2">
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value as ChannelType)}
              className="text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              {Object.entries(CHANNEL_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="通道名称（如：工作群机器人）"
              className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
            />
          </div>
          <input
            value={formWebhookUrl}
            onChange={(e) => setFormWebhookUrl(e.target.value)}
            placeholder="Webhook URL"
            className="w-full text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] font-mono"
          />
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <input
                value={formSecret}
                onChange={(e) => setFormSecret(e.target.value)}
                type={showSecret ? "text" : "password"}
                placeholder="签名密钥（可选）"
                className="w-full text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] font-mono pr-7"
              />
              <button
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-[var(--color-text-tertiary)]"
              >
                {showSecret ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
          </div>
          {formType === "dingtalk" && (
            <div className="flex gap-2">
              <input
                value={formAppKey}
                onChange={(e) => setFormAppKey(e.target.value)}
                placeholder="AppKey（可选，用于 API 模式）"
                className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] font-mono"
              />
              <input
                value={formAppSecret}
                onChange={(e) => setFormAppSecret(e.target.value)}
                type="password"
                placeholder="AppSecret"
                className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] font-mono"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={!formName.trim() || !formWebhookUrl.trim()}
              className="px-3 py-1.5 text-xs rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 transition-colors"
            >
              连接
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="px-3 py-1.5 text-xs rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Channel list */}
      <div className="flex-1 overflow-auto px-4 py-2">
        {channels.length === 0 && !showAdd && (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-20" />
            <p className="text-xs">暂无 IM 通道</p>
            <p className="text-[10px] mt-1 opacity-60">
              点击"添加通道"配置钉钉等 IM 机器人
            </p>
          </div>
        )}

        {channels.map((ch) => {
          const status = statuses[ch.config.id] ?? "disconnected";
          const statusInfo = STATUS_MAP[status];
          const isExpanded = expandedId === ch.config.id;

          return (
            <div key={ch.config.id} className="border border-[var(--color-border)] rounded-lg mb-2 overflow-hidden">
              <div
                className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-[var(--color-bg-secondary)] transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : ch.config.id)}
              >
                <span className={statusInfo.color}>{statusInfo.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">{ch.config.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
                      {CHANNEL_TYPE_LABELS[ch.config.type]}
                    </span>
                  </div>
                  <span className={`text-[10px] ${statusInfo.color}`}>{statusInfo.label}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggle(ch); }}
                    className={`p-1 rounded transition-colors ${status === "connected" ? "text-green-500 hover:bg-green-500/10" : "text-gray-400 hover:bg-gray-400/10"}`}
                    title={status === "connected" ? "断开连接" : "连接"}
                  >
                    {status === "connected" ? <Power className="w-3.5 h-3.5" /> : <PowerOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemove(ch.config.id); }}
                    className="p-1 rounded text-[var(--color-text-tertiary)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="删除通道"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  {isExpanded ? <ChevronDown className="w-3 h-3 text-[var(--color-text-tertiary)]" /> : <ChevronRight className="w-3 h-3 text-[var(--color-text-tertiary)]" />}
                </div>
              </div>

              {isExpanded && (
                <div className="px-3 pb-3 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                  <div className="mt-2 space-y-1.5 text-[10px] text-[var(--color-text-secondary)]">
                    <div>Webhook: <span className="font-mono">{String((ch.config.platformConfig as any).webhookUrl || "").slice(0, 60)}…</span></div>
                    {(ch.config.platformConfig as any).secret && <div>签名: ••••••••</div>}
                    {(ch.config.platformConfig as any).appKey && <div>AppKey: {String((ch.config.platformConfig as any).appKey).slice(0, 15)}…</div>}
                  </div>

                  {/* Test send */}
                  {status === "connected" && (
                    <div className="flex items-center gap-1.5 mt-2.5">
                      <input
                        value={testChannelId === ch.config.id ? testMsg : ""}
                        onChange={(e) => { setTestChannelId(ch.config.id); setTestMsg(e.target.value); }}
                        onFocus={() => setTestChannelId(ch.config.id)}
                        placeholder="输入测试消息..."
                        className="flex-1 text-[11px] px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)]"
                      />
                      <button
                        onClick={handleSendTest}
                        disabled={sending || !testMsg.trim() || testChannelId !== ch.config.id}
                        className="p-1.5 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 transition-colors"
                      >
                        {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ChannelConfigPanel;
