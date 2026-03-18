/**
 * ChannelConfigPanel — IM 通道配置 UI 面板
 *
 * 支持在 UI 层面配置和管理 IM 通道（钉钉/企微/飞书等）。
 */

import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  feishu: "飞书",
};

interface SavedChannel {
  config: ChannelConfig;
}

interface ImCallbackServerStatus {
  running: boolean;
  starting: boolean;
  host: string;
  port: number;
  baseUrl: string;
  callbackBaseUrl: string;
  lastError?: string | null;
}

interface DingTalkStreamStatus {
  channelId: string;
  state: string;
  lastError?: string | null;
}

interface FeishuWsStatus {
  channelId: string;
  state: string;
  lastError?: string | null;
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

function canConnectChannel(params: {
  type: ChannelType;
  webhookUrl: string;
  appKey: string;
  appSecret: string;
  name: string;
}): boolean {
  if (!params.name.trim()) return false;

  const hasWebhook = params.webhookUrl.trim().length > 0;
  const hasAppId = params.appKey.trim().length > 0;
  const hasAppSecret = params.appSecret.trim().length > 0;

  if (params.type === "feishu" || params.type === "dingtalk") {
    return hasWebhook || (hasAppId && hasAppSecret);
  }

  return hasWebhook;
}

function isFeishuAppMode(config: ChannelConfig): boolean {
  const platformConfig = config.platformConfig as { appId?: string };
  return config.type === "feishu" && !!platformConfig.appId;
}

function isDingTalkStreamMode(config: ChannelConfig): boolean {
  const platformConfig = config.platformConfig as { appKey?: string };
  return config.type === "dingtalk" && !!platformConfig.appKey;
}

const ChannelConfigPanel: React.FC = () => {
  const [channels, setChannels] = useState<SavedChannel[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ChannelStatus>>({});
  const [callbackServer, setCallbackServer] = useState<ImCallbackServerStatus | null>(null);
  const [dingtalkStreams, setDingtalkStreams] = useState<Record<string, DingTalkStreamStatus | null>>({});
  const [feishuSockets, setFeishuSockets] = useState<Record<string, FeishuWsStatus | null>>({});
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
  const [formRobotCode, setFormRobotCode] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const canSubmit = canConnectChannel({
    type: formType,
    webhookUrl: formWebhookUrl,
    appKey: formAppKey,
    appSecret: formAppSecret,
    name: formName,
  });

  const refreshStatuses = useCallback(() => {
    const mgr = getChannelManager();
    const all = mgr.getStatuses();
    const map: Record<string, ChannelStatus> = {};
    for (const s of all) map[s.id] = s.status;
    setStatuses(map);
  }, []);

  const refreshCallbackServer = useCallback(async () => {
    try {
      const status = await invoke<ImCallbackServerStatus>("get_im_callback_server_status");
      setCallbackServer(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCallbackServer((prev) => (prev
        ? { ...prev, running: false, starting: false, lastError: message }
        : null));
    }
  }, []);

  const ensureCallbackServer = useCallback(async () => {
    try {
      const status = await invoke<ImCallbackServerStatus>("start_im_callback_server");
      setCallbackServer(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCallbackServer((prev) => (prev
        ? { ...prev, running: false, starting: false, lastError: message }
        : {
            running: false,
            starting: false,
            host: "127.0.0.1",
            port: 21947,
            baseUrl: "http://127.0.0.1:21947",
            callbackBaseUrl: "http://127.0.0.1:21947/callbacks/im",
            lastError: message,
          }));
    }
  }, []);

  const refreshFeishuSockets = useCallback(async () => {
    const socketChannels = loadSavedChannels()
      .map((entry) => entry.config)
      .filter(isFeishuAppMode);

    if (socketChannels.length === 0) {
      setFeishuSockets({});
      return;
    }

    const results = await Promise.all(
      socketChannels.map(async (config) => {
        try {
          const status = await invoke<FeishuWsStatus | null>("get_feishu_ws_channel_status", {
            channelId: config.id,
          });
          return [config.id, status] as const;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return [
            config.id,
            {
              channelId: config.id,
              state: "error",
              lastError: message,
            },
          ] as const;
        }
      }),
    );

    setFeishuSockets(Object.fromEntries(results));
  }, []);

  const refreshDingTalkStreams = useCallback(async () => {
    const streamChannels = loadSavedChannels()
      .map((entry) => entry.config)
      .filter(isDingTalkStreamMode);

    if (streamChannels.length === 0) {
      setDingtalkStreams({});
      return;
    }

    const results = await Promise.all(
      streamChannels.map(async (config) => {
        try {
          const status = await invoke<DingTalkStreamStatus | null>("get_dingtalk_stream_channel_status", {
            channelId: config.id,
          });
          return [config.id, status] as const;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return [
            config.id,
            {
              channelId: config.id,
              state: "error",
              lastError: message,
            },
          ] as const;
        }
      }),
    );

    setDingtalkStreams(Object.fromEntries(results));
  }, []);

  useEffect(() => {
    setChannels(loadSavedChannels());
    refreshStatuses();
    void refreshCallbackServer();
    void refreshFeishuSockets();
    void refreshDingTalkStreams();
    const timer = setInterval(() => {
      refreshStatuses();
      void refreshCallbackServer();
      void refreshFeishuSockets();
      void refreshDingTalkStreams();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshStatuses, refreshCallbackServer, refreshFeishuSockets, refreshDingTalkStreams]);

  const handleAdd = useCallback(async () => {
    if (!canConnectChannel({
      type: formType,
      webhookUrl: formWebhookUrl,
      appKey: formAppKey,
      appSecret: formAppSecret,
      name: formName,
    })) return;

    const id = `ch-${Date.now().toString(36)}`;
    const config: ChannelConfig = {
      id,
      type: formType,
      name: formName.trim(),
      enabled: true,
      platformConfig: {
        ...(formWebhookUrl.trim() ? { webhookUrl: formWebhookUrl.trim() } : {}),
        ...(formSecret ? { secret: formSecret.trim() } : {}),
        ...(formAppKey
          ? formType === "feishu"
            ? { appId: formAppKey.trim(), appSecret: formAppSecret.trim() }
            : {
                appKey: formAppKey.trim(),
                appSecret: formAppSecret.trim(),
                ...(formRobotCode.trim() ? { robotCode: formRobotCode.trim() } : {}),
              }
          : {}),
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
      void refreshFeishuSockets();
      void refreshDingTalkStreams();

      // Reset form
      setFormName("");
      setFormWebhookUrl("");
      setFormSecret("");
      setFormAppKey("");
      setFormAppSecret("");
      setFormRobotCode("");
      setShowAdd(false);
    } catch (err) {
      alert(`连接失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [formType, formName, formWebhookUrl, formSecret, formAppKey, formAppSecret, formRobotCode, channels, refreshStatuses, refreshFeishuSockets, refreshDingTalkStreams]);

  const handleRemove = useCallback(async (id: string) => {
    const mgr = getChannelManager();
    await mgr.unregister(id);
    const updated = channels.filter((c) => c.config.id !== id);
    setChannels(updated);
    saveSavedChannels(updated);
    refreshStatuses();
    void refreshFeishuSockets();
    void refreshDingTalkStreams();
  }, [channels, refreshStatuses, refreshFeishuSockets, refreshDingTalkStreams]);

  const handleToggle = useCallback(async (ch: SavedChannel) => {
    const mgr = getChannelManager();
    const current = statuses[ch.config.id];
    if (current === "connected") {
      await mgr.unregister(ch.config.id);
    } else {
      await mgr.register({ ...ch.config, enabled: true });
    }
    refreshStatuses();
    void refreshFeishuSockets();
    void refreshDingTalkStreams();
  }, [statuses, refreshStatuses, refreshFeishuSockets, refreshDingTalkStreams]);

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
            placeholder="Webhook URL（Webhook 模式可填）"
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
          {(formType === "dingtalk" || formType === "feishu") && (
            <div className="flex gap-2">
              <input
                value={formAppKey}
                onChange={(e) => setFormAppKey(e.target.value)}
                placeholder={formType === "feishu" ? "App ID（App 模式可填）" : "AppKey（API 模式可填）"}
                className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] font-mono"
              />
              <input
                value={formAppSecret}
                onChange={(e) => setFormAppSecret(e.target.value)}
                type="password"
                placeholder={formType === "feishu" ? "App Secret（与 App ID 配套）" : "AppSecret（与 AppKey 配套）"}
                className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] font-mono"
              />
            </div>
          )}
          {formType === "dingtalk" && (
            <input
              value={formRobotCode}
              onChange={(e) => setFormRobotCode(e.target.value)}
              placeholder="RobotCode（可选，主动发送推荐填写）"
              className="w-full text-xs px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] font-mono"
            />
          )}
          {formType === "feishu" && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[10px] text-[var(--color-text-secondary)]">
              <div className="flex items-center justify-between gap-2">
                <span>接收模式</span>
                <span className="text-green-500">WebSocket 长连接</span>
              </div>
              <div className="mt-1">
                配置 `App ID + App Secret` 后，桌面端会主动和飞书建立长连接，无需公网回调地址。
              </div>
            </div>
          )}
          {formType === "dingtalk" && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[10px] text-[var(--color-text-secondary)]">
              <div className="flex items-center justify-between gap-2">
                <span>接收模式</span>
                <span className="text-green-500">Stream 长连接</span>
              </div>
              <div className="mt-1">
                配置 `AppKey + AppSecret` 后，桌面端会主动和钉钉建立长连接，无需公网回调地址或内网穿透。
              </div>
              <div className="mt-1">
                回复当前会话时会优先走 `sessionWebhook`；主动发消息建议额外填写 `RobotCode`。
              </div>
            </div>
          )}
          <p className="text-[10px] text-[var(--color-text-secondary)]">
            飞书优先使用 `App + WebSocket 长连接`，钉钉优先使用 `App + Stream 长连接`；发送仍可回退到 Webhook。
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={!canSubmit}
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

      <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] text-[var(--color-text-secondary)]">HTTP 回调服务（兼容旧模式）</div>
          <button
            onClick={() => void ensureCallbackServer()}
            className="text-[10px] text-blue-500 hover:text-blue-600"
          >
            {callbackServer?.running ? "刷新状态" : "启动服务"}
          </button>
        </div>
        <div className={`mt-0.5 text-[10px] ${callbackServer?.running ? "text-green-500" : callbackServer?.starting ? "text-blue-500" : callbackServer?.lastError ? "text-red-500" : "text-[var(--color-text-secondary)]"}`}>
          {callbackServer?.running
            ? `运行中 · ${callbackServer.host}:${callbackServer.port}`
            : callbackServer?.starting
              ? "启动中"
              : callbackServer?.lastError
                ? `启动失败 · ${callbackServer.lastError}`
                : "尚未启动"}
        </div>
        {callbackServer?.callbackBaseUrl && (
          <div className="mt-1 break-all font-mono text-[10px] text-[var(--color-text-secondary)]">
            {callbackServer.callbackBaseUrl}
          </div>
        )}
        <p className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
          当前飞书和钉钉的 App 模式默认都走长连接；这里只有在需要兼容旧式 HTTP 回调时才用。
        </p>
      </div>

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
          const platformConfig = ch.config.platformConfig as {
            webhookUrl?: string;
            secret?: string;
            appKey?: string;
            appId?: string;
            robotCode?: string;
          };
          const feishuSocket = feishuSockets[ch.config.id];
          const feishuSocketLabel = feishuSocket?.state === "connected"
            ? "已连接"
            : feishuSocket?.state === "starting"
              ? "启动中"
              : feishuSocket?.state === "reconnecting"
                ? "重连中"
                : feishuSocket?.state === "error"
                  ? "异常"
                  : "未启动";
          const feishuSocketColor = feishuSocket?.state === "connected"
            ? "text-green-500"
            : feishuSocket?.state === "starting" || feishuSocket?.state === "reconnecting"
              ? "text-blue-500"
              : feishuSocket?.state === "error"
                ? "text-red-500"
                : "text-[var(--color-text-secondary)]";
          const dingtalkStream = dingtalkStreams[ch.config.id];
          const dingtalkStreamLabel = dingtalkStream?.state === "connected"
            ? "已连接"
            : dingtalkStream?.state === "starting"
              ? "启动中"
              : dingtalkStream?.state === "reconnecting"
                ? "重连中"
                : dingtalkStream?.state === "error"
                  ? "异常"
                  : "未启动";
          const dingtalkStreamColor = dingtalkStream?.state === "connected"
            ? "text-green-500"
            : dingtalkStream?.state === "starting" || dingtalkStream?.state === "reconnecting"
              ? "text-blue-500"
              : dingtalkStream?.state === "error"
                ? "text-red-500"
                : "text-[var(--color-text-secondary)]";

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
                    {isFeishuAppMode(ch.config) && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] ${feishuSocketColor}`}>
                        WebSocket {feishuSocketLabel}
                      </span>
                    )}
                    {isDingTalkStreamMode(ch.config) && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] ${dingtalkStreamColor}`}>
                        Stream {dingtalkStreamLabel}
                      </span>
                    )}
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
                    {platformConfig.webhookUrl && (
                      <div>Webhook: <span className="font-mono">{String(platformConfig.webhookUrl || "").slice(0, 60)}…</span></div>
                    )}
                    {platformConfig.secret && <div>签名: ••••••••</div>}
                    {platformConfig.appKey && <div>AppKey: {String(platformConfig.appKey).slice(0, 15)}…</div>}
                    {platformConfig.appId && <div>App ID: {String(platformConfig.appId).slice(0, 20)}…</div>}
                    {platformConfig.robotCode && <div>RobotCode: {String(platformConfig.robotCode).slice(0, 20)}…</div>}
                    {isFeishuAppMode(ch.config) && (
                      <div>
                        接收模式:
                        <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                          WebSocket 长连接（无需公网回调）
                        </div>
                        <div className={`mt-1 text-[10px] ${feishuSocketColor}`}>
                          WebSocket 状态: {feishuSocketLabel}
                        </div>
                        {feishuSocket?.lastError && (
                          <div className="mt-1 break-all text-[10px] text-red-500">
                            {feishuSocket.lastError}
                          </div>
                        )}
                      </div>
                    )}
                    {isDingTalkStreamMode(ch.config) && (
                      <div>
                        接收模式:
                        <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                          Stream 长连接（无需公网回调）
                        </div>
                        <div className={`mt-1 text-[10px] ${dingtalkStreamColor}`}>
                          Stream 状态: {dingtalkStreamLabel}
                        </div>
                        {dingtalkStream?.lastError && (
                          <div className="mt-1 break-all text-[10px] text-red-500">
                            {dingtalkStream.lastError}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Test send */}
                  {status === "connected" && (
                    <>
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
                      {ch.config.type === "dingtalk" && !platformConfig.webhookUrl && (
                        <div className="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                          钉钉 Stream-only 通道的测试发送没有默认目标会话；请在钉钉里先给机器人发消息触发回复，或额外配置 Webhook / RobotCode 用于主动发送。
                        </div>
                      )}
                    </>
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
