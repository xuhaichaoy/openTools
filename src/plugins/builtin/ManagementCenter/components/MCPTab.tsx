import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  RefreshCw,
  Power,
  PowerOff,
  Server,
  Loader2,
  Wrench,
  ChevronDown,
  ChevronRight,
  Globe,
  Terminal,
  FileText,
  MessageSquare,
  X,
  CheckCircle,
  XCircle,
  Edit2,
} from "lucide-react";
import { useMcpStore, type McpServerConfig } from "@/store/mcp-store";
import {
  MCP_MARKET_TEMPLATES,
  templateToConfig,
  type McpMarketTemplate,
} from "@/core/mcp/mcp-market";

const BRAND = "#F28F36";

export function MCPTab() {
  const {
    servers,
    serverStatus,
    serverTools,
    serverResources,
    serverPrompts,
    isLoading,
    loadServers,
    addServer,
    removeServer,
    startServer,
    stopServer,
    refreshTools,
  } = useMcpStore();

  const [showAddForm, setShowAddForm] = useState(false);
  const [showMarket, setShowMarket] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const handleStart = useCallback(async (id: string) => {
    setActionLoading((p) => ({ ...p, [id]: true }));
    try {
      await startServer(id);
    } catch { /* handled by store */ }
    setActionLoading((p) => ({ ...p, [id]: false }));
  }, [startServer]);

  const handleStop = useCallback(async (id: string) => {
    setActionLoading((p) => ({ ...p, [id]: true }));
    try {
      await stopServer(id);
    } catch { /* handled by store */ }
    setActionLoading((p) => ({ ...p, [id]: false }));
  }, [stopServer]);

  const handleRefresh = useCallback(async (id: string) => {
    setActionLoading((p) => ({ ...p, [id]: true }));
    try {
      await refreshTools(id);
    } catch { /* handled by store */ }
    setActionLoading((p) => ({ ...p, [id]: false }));
  }, [refreshTools]);

  const handleRemove = useCallback(async (id: string) => {
    await removeServer(id);
    if (expandedId === id) setExpandedId(null);
  }, [removeServer, expandedId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: BRAND }} />
      </div>
    );
  }

  return (
    <div className="w-full space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">MCP 服务器</h2>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            管理 Model Context Protocol 服务器，扩展 Agent 工具能力
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowMarket((v) => !v)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-xs font-medium hover:bg-[var(--color-bg-secondary)] transition-colors"
          >
            <Globe className="w-3 h-3" />
            市场
          </button>
          <button
            onClick={() => { setShowAddForm(true); setEditingId(null); }}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-white text-xs font-medium"
            style={{ background: BRAND }}
          >
            <Plus className="w-3 h-3" />
            添加
          </button>
        </div>
      </div>

      {showMarket && (
        <MCPMarketPanel
          onInstall={async (config) => {
            await addServer(config);
            setShowMarket(false);
          }}
          onClose={() => setShowMarket(false)}
        />
      )}

      {showAddForm && (
        <MCPServerForm
          server={editingId ? servers.find((s) => s.id === editingId) : undefined}
          onSave={async (config) => {
            if (editingId) {
              await useMcpStore.getState().updateServer(editingId, config);
            } else {
              await addServer(config as McpServerConfig);
            }
            setShowAddForm(false);
            setEditingId(null);
          }}
          onCancel={() => { setShowAddForm(false); setEditingId(null); }}
        />
      )}

      {servers.length === 0 && !showAddForm && (
        <div className="text-center py-8 bg-[var(--color-bg)] rounded-xl border border-dashed border-[var(--color-border)]">
          <Server className="w-8 h-8 text-[var(--color-text-secondary)] mx-auto mb-2 opacity-20" />
          <p className="text-xs text-[var(--color-text-secondary)]">
            尚未配置 MCP 服务器
          </p>
          <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5 opacity-60">
            添加 MCP 服务器后，Agent 将自动获得新的工具能力
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        {servers.map((server) => {
          const status = serverStatus[server.id] ?? "offline";
          const tools = serverTools[server.id] ?? [];
          const resources = serverResources[server.id] ?? [];
          const prompts = serverPrompts[server.id] ?? [];
          const loading = actionLoading[server.id];
          const isExpanded = expandedId === server.id;

          return (
            <div
              key={server.id}
              className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  onClick={() => setExpandedId(isExpanded ? null : server.id)}
                  className="shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3 h-3 text-[var(--color-text-secondary)]" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)]" />
                  )}
                </button>

                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    background: status === "online" ? "#22c55e" : status === "starting" ? BRAND : "#94a3b8",
                  }}
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">
                      {server.name}
                    </span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]">
                      {server.transport.toUpperCase()}
                    </span>
                    {status === "online" && tools.length > 0 && (
                      <span className="text-[10px] text-[var(--color-text-secondary)]">
                        {tools.length} tools
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-[var(--color-text-secondary)] truncate mt-0.5">
                    {server.transport === "stdio"
                      ? `${server.command} ${(server.args ?? []).join(" ")}`
                      : server.url}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {loading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: BRAND }} />
                  ) : (
                    <>
                      {status === "online" ? (
                        <>
                          <button
                            onClick={() => handleRefresh(server.id)}
                            className="p-1 rounded hover:bg-[var(--color-bg-secondary)]"
                            title="刷新工具列表"
                          >
                            <RefreshCw className="w-3 h-3 text-[var(--color-text-secondary)]" />
                          </button>
                          <button
                            onClick={() => handleStop(server.id)}
                            className="p-1 rounded hover:bg-red-500/10"
                            title="停止"
                          >
                            <PowerOff className="w-3 h-3 text-red-500" />
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleStart(server.id)}
                          className="p-1 rounded hover:bg-emerald-500/10"
                          title="启动"
                        >
                          <Power className="w-3 h-3 text-emerald-500" />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setEditingId(server.id);
                          setShowAddForm(true);
                        }}
                        className="p-1 rounded hover:bg-[var(--color-bg-secondary)]"
                        title="编辑"
                      >
                        <Edit2 className="w-3 h-3 text-[var(--color-text-secondary)]" />
                      </button>
                      <button
                        onClick={() => handleRemove(server.id)}
                        className="p-1 rounded hover:bg-red-500/10"
                        title="删除"
                      >
                        <Trash2 className="w-3 h-3 text-red-400" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Expanded Details */}
              {isExpanded && (
                <div className="border-t border-[var(--color-border)] px-3 py-2 space-y-2">
                  {tools.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <Wrench className="w-3 h-3" style={{ color: BRAND }} />
                        <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                          Tools ({tools.length})
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {tools.map((tool) => (
                          <div
                            key={tool.name}
                            className="flex items-start gap-2 px-2 py-1 rounded bg-[var(--color-bg-secondary)]"
                          >
                            <Terminal className="w-3 h-3 mt-0.5 text-[var(--color-text-secondary)] shrink-0" />
                            <div className="min-w-0">
                              <span className="text-[10px] font-mono font-medium">
                                {tool.name}
                              </span>
                              {tool.description && (
                                <p className="text-[10px] text-[var(--color-text-secondary)] truncate">
                                  {tool.description}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {resources.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <FileText className="w-3 h-3 text-blue-500" />
                        <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                          Resources ({resources.length})
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {resources.map((r) => (
                          <div
                            key={r.uri}
                            className="px-2 py-1 rounded bg-[var(--color-bg-secondary)] text-[10px]"
                          >
                            <span className="font-mono">{r.name ?? r.uri}</span>
                            {r.description && (
                              <span className="text-[var(--color-text-secondary)] ml-1">
                                — {r.description}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {prompts.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <MessageSquare className="w-3 h-3 text-purple-500" />
                        <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                          Prompts ({prompts.length})
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {prompts.map((p) => (
                          <div
                            key={p.name}
                            className="px-2 py-1 rounded bg-[var(--color-bg-secondary)] text-[10px]"
                          >
                            <span className="font-mono">{p.name}</span>
                            {p.description && (
                              <span className="text-[var(--color-text-secondary)] ml-1">
                                — {p.description}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {tools.length === 0 && resources.length === 0 && prompts.length === 0 && (
                    <p className="text-[10px] text-[var(--color-text-secondary)] text-center py-2">
                      {status === "online"
                        ? "此服务器未暴露任何工具/资源/提示"
                        : "启动服务器后可查看可用工具"}
                    </p>
                  )}

                  {/* Env variables */}
                  {server.env && Object.keys(server.env).length > 0 && (
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <Globe className="w-3 h-3 text-cyan-500" />
                        <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                          ENV
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        {Object.entries(server.env).map(([k, v]) => (
                          <div
                            key={k}
                            className="px-2 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[10px] font-mono"
                          >
                            {k}={v.length > 20 ? `${v.slice(0, 8)}...${v.slice(-4)}` : v}
                          </div>
                        ))}
                      </div>
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
}

// ── Add/Edit Form ──

function MCPServerForm({
  server,
  onSave,
  onCancel,
}: {
  server?: McpServerConfig;
  onSave: (config: Partial<McpServerConfig>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "sse">(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "npx");
  const [args, setArgs] = useState(server?.args?.join(" ") ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [envText, setEnvText] = useState(
    server?.env
      ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n")
      : "",
  );
  const [headersText, setHeadersText] = useState(
    server?.headers
      ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
      : "",
  );
  const [autoStart, setAutoStart] = useState(server?.auto_start ?? false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);

    const env: Record<string, string> = {};
    envText.split("\n").forEach((line) => {
      const idx = line.indexOf("=");
      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    const headers: Record<string, string> = {};
    headersText.split("\n").forEach((line) => {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    await onSave({
      id: server?.id ?? `mcp-${Date.now()}`,
      name: name.trim(),
      transport,
      command: transport === "stdio" ? command.trim() : undefined,
      args: transport === "stdio" ? args.split(/\s+/).filter(Boolean) : undefined,
      url: transport === "sse" ? url.trim() : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      headers: transport === "sse" && Object.keys(headers).length > 0 ? headers : undefined,
      enabled: server?.enabled ?? true,
      auto_start: autoStart,
    });
    setSaving(false);
  };

  const inputCls =
    "w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs text-[var(--color-text)] focus:ring-2 focus:ring-[#F28F3640] transition-all outline-none" as const;

  return (
    <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold">
          {server ? "编辑 MCP 服务器" : "添加 MCP 服务器"}
        </h3>
        <button onClick={onCancel} className="p-1 rounded hover:bg-[var(--color-bg-secondary)]">
          <X className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
        </button>
      </div>

      <div>
        <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          名称
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My MCP Server"
          className={inputCls + " mt-1"}
        />
      </div>

      <div>
        <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          传输方式
        </label>
        <div className="flex gap-2 mt-1">
          {(["stdio", "sse"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTransport(t)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                transport === t
                  ? "text-white"
                  : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]"
              }`}
              style={transport === t ? { background: BRAND, borderColor: BRAND } : undefined}
            >
              {t === "stdio" ? <Terminal className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {transport === "stdio" ? (
        <>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              命令
            </label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className={inputCls + " mt-1"}
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              参数
            </label>
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              className={inputCls + " mt-1"}
            />
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              URL
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:3000/sse"
              className={inputCls + " mt-1"}
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
              Headers（每行一个，格式: Key: Value）
            </label>
            <textarea
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder="Authorization: Bearer xxx"
              rows={2}
              className={inputCls + " mt-1 resize-none"}
            />
          </div>
        </>
      )}

      <div>
        <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          环境变量（每行一个，格式: KEY=VALUE）
        </label>
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder="GITHUB_TOKEN=ghp_xxx"
          rows={2}
          className={inputCls + " mt-1 resize-none"}
        />
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={autoStart}
          onChange={(e) => setAutoStart(e.target.checked)}
          className="rounded"
        />
        <span className="text-xs text-[var(--color-text-secondary)]">启动时自动连接</span>
      </label>

      <div className="flex gap-2 pt-1">
        <button
          onClick={onCancel}
          className="flex-1 py-1.5 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] text-xs font-medium transition-all"
        >
          取消
        </button>
        <button
          onClick={handleSubmit}
          disabled={saving || !name.trim()}
          className="flex-1 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1"
          style={{ background: BRAND }}
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {server ? "保存" : "添加"}
        </button>
      </div>
    </div>
  );
}

// ── MCP Market Panel ──

const CATEGORY_LABELS: Record<string, string> = {
  filesystem: "文件系统",
  dev: "开发工具",
  data: "数据",
  communication: "通讯",
  ai: "AI",
  other: "其他",
};

function MCPMarketPanel({
  onInstall,
  onClose,
}: {
  onInstall: (config: McpServerConfig) => Promise<void>;
  onClose: () => void;
}) {
  const [envInputs, setEnvInputs] = useState<Record<string, Record<string, string>>>({});
  const [installing, setInstalling] = useState<string | null>(null);

  const handleInstall = async (template: McpMarketTemplate) => {
    setInstalling(template.id);
    const envVals = envInputs[template.id] ?? {};
    const config = templateToConfig(template, envVals);
    await onInstall(config);
    setInstalling(null);
  };

  const categories = Array.from(new Set(MCP_MARKET_TEMPLATES.map((t) => t.category)));

  return (
    <div className="bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)] p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold">MCP 服务器市场</h3>
        <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-secondary)]">
          <X className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
        </button>
      </div>

      <p className="text-[10px] text-[var(--color-text-secondary)]">
        一键安装常用 MCP 服务器模板，扩展 Agent 能力
      </p>

      {categories.map((cat) => (
        <div key={cat}>
          <div className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider mb-1">
            {CATEGORY_LABELS[cat] ?? cat}
          </div>
          <div className="space-y-1">
            {MCP_MARKET_TEMPLATES.filter((t) => t.category === cat).map((template) => (
              <div
                key={template.id}
                className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-[var(--color-bg-secondary)]"
              >
                <Server className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: BRAND }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium">{template.name}</span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--color-bg)] text-[var(--color-text-secondary)]">
                      {template.transport.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-[10px] text-[var(--color-text-secondary)] mt-0.5">
                    {template.description}
                  </p>
                  {template.envKeys && template.envKeys.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {template.envKeys.map((key) => (
                        <input
                          key={key}
                          placeholder={key}
                          value={envInputs[template.id]?.[key] ?? ""}
                          onChange={(e) =>
                            setEnvInputs((prev) => ({
                              ...prev,
                              [template.id]: {
                                ...(prev[template.id] ?? {}),
                                [key]: e.target.value,
                              },
                            }))
                          }
                          className="w-full bg-[var(--color-bg)] border-0 rounded px-2 py-1 text-[10px] font-mono text-[var(--color-text)] outline-none"
                        />
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleInstall(template)}
                  disabled={installing === template.id}
                  className="shrink-0 px-2 py-1 rounded text-[10px] font-medium text-white"
                  style={{ background: BRAND }}
                >
                  {installing === template.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    "安装"
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
