import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Plus,
  Trash2,
  Terminal,
  FolderOpen,
  Power,
  PowerOff,
  Server,
  Loader2,
  X,
  ChevronLeft,
  File,
  Folder,
  RefreshCw,
  Edit2,
  ArrowLeft,
} from "lucide-react";
import {
  useSshStore,
  listenSshOutput,
  listenSshClosed,
  type SshConnectionConfig,
  type SftpEntry,
} from "@/store/ssh-store";
import { useDragWindow } from "@/hooks/useDragWindow";

const BRAND = "#F28F36";
const AUTO_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

function sshLogInfo(sessionId: string, message: string, extra?: unknown) {
  if (extra !== undefined) {
    console.info(`[SSH][${sessionId}] ${message}`, extra);
    return;
  }
  console.info(`[SSH][${sessionId}] ${message}`);
}

function sshLogWarn(sessionId: string, message: string, extra?: unknown) {
  if (extra !== undefined) {
    console.warn(`[SSH][${sessionId}] ${message}`, extra);
    return;
  }
  console.warn(`[SSH][${sessionId}] ${message}`);
}

export default function SSHManagerPlugin({ onBack }: { onBack?: () => void }) {
  const { onMouseDown } = useDragWindow();
  const {
    connections,
    sessions,
    activeSessionId,
    sftpCurrentPath,
    sftpFiles,
    isLoading,
    loadConnections,
    addConnection,
    removeConnection,
    connect,
    disconnect,
    openShell,
    sftpNavigate,
    sftpRemove,
    sftpMkdir,
    setActiveSession,
  } = useSshStore();

  const [showForm, setShowForm] = useState(false);
  const [activeTab, setActiveTab] = useState<"terminal" | "sftp">("terminal");
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const reconnectTimersRef = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({});
  const reconnectAttemptsRef = useRef<Record<string, number>>({});

  const clearReconnectTimer = useCallback((sessionId: string) => {
    const timer = reconnectTimersRef.current[sessionId];
    if (timer) {
      clearTimeout(timer);
    }
    delete reconnectTimersRef.current[sessionId];
  }, []);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const scheduleReconnect = useCallback((sessionId: string) => {
    if (reconnectTimersRef.current[sessionId]) return;

    const attempt = (reconnectAttemptsRef.current[sessionId] ?? 0) + 1;
    reconnectAttemptsRef.current[sessionId] = attempt;
    const delay = AUTO_RECONNECT_DELAYS_MS[Math.min(attempt - 1, AUTO_RECONNECT_DELAYS_MS.length - 1)];
    sshLogWarn(sessionId, `auto reconnect scheduled attempt=${attempt} delay=${delay}ms (plugin-level)`);

    reconnectTimersRef.current[sessionId] = setTimeout(async () => {
      clearReconnectTimer(sessionId);

      const latest = useSshStore.getState();
      const latestSession = latest.sessions[sessionId];
      const latestActive = latest.activeSessionId === sessionId;
      if (!latestSession || latestSession.connected || !latestActive) return;

      try {
        sshLogInfo(sessionId, `auto reconnect start attempt=${attempt} (plugin-level)`);
        await connect(sessionId);
        await openShell(sessionId, 80, 24);
        reconnectAttemptsRef.current[sessionId] = 0;
        sshLogInfo(sessionId, "auto reconnect success (plugin-level)");
      } catch (e) {
        sshLogWarn(sessionId, `auto reconnect failed attempt=${attempt} (plugin-level)`, e);
        scheduleReconnect(sessionId);
      }
    }, delay);
  }, [connect, openShell, clearReconnectTimer]);

  useEffect(() => {
    // Only keep reconnect timer for active session.
    for (const id of Object.keys(reconnectTimersRef.current)) {
      if (id !== activeSessionId) {
        clearReconnectTimer(id);
      }
    }

    if (!activeSessionId) return;
    const sessionId = activeSessionId;
    const session = sessions[sessionId];
    if (!session) return;

    if (session.connected) {
      reconnectAttemptsRef.current[sessionId] = 0;
      clearReconnectTimer(sessionId);
      return;
    }

    scheduleReconnect(sessionId);
  }, [activeSessionId, sessions, clearReconnectTimer, scheduleReconnect]);

  useEffect(() => {
    return () => {
      for (const id of Object.keys(reconnectTimersRef.current)) {
        clearReconnectTimer(id);
      }
    };
  }, [clearReconnectTimer]);

  const handleConnect = useCallback(async (id: string) => {
    sshLogInfo(id, "connect requested");
    setActionLoading((p) => ({ ...p, [id]: true }));
    try {
      await connect(id);
      await openShell(id, 80, 24);
      sshLogInfo(id, "connect + shell open success");
    } catch (e) {
      sshLogWarn(id, "connect failed", e);
      console.error("SSH connect failed:", e);
    }
    setActionLoading((p) => ({ ...p, [id]: false }));
  }, [connect, openShell]);

  const handleDisconnect = useCallback(async (id: string) => {
    sshLogInfo(id, "disconnect requested");
    await disconnect(id);
  }, [disconnect]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <div
        className="h-10 flex items-center px-3 border-b border-[var(--color-border)] cursor-grab active:cursor-grabbing shrink-0"
        onMouseDown={onMouseDown}
      >
        <button onClick={onBack} className="mr-2 p-1 rounded hover:bg-[var(--color-bg-secondary)]">
          <ArrowLeft className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />
        </button>
        <h1 className="text-xs font-semibold text-[var(--color-text-secondary)]">
          SSH 管理器
        </h1>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-[180px] border-r border-[var(--color-border)] flex flex-col shrink-0">
          <div className="p-2 border-b border-[var(--color-border)]">
            <button
              onClick={() => setShowForm(true)}
              className="w-full flex items-center justify-center gap-1 py-1.5 rounded-lg text-white text-xs font-medium"
              style={{ background: BRAND }}
            >
              <Plus className="w-3 h-3" />
              新建连接
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
            {connections.map((conn) => {
              const session = sessions[conn.id];
              const isActive = activeSessionId === conn.id;
              const loading = actionLoading[conn.id];

              return (
                <div
                  key={conn.id}
                  onClick={() => setActiveSession(conn.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                    isActive
                      ? "font-medium"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={isActive ? { background: `${BRAND}15`, color: BRAND } : undefined}
                >
                  <div
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: session?.connected ? "#22c55e" : "#94a3b8" }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium truncate">{conn.name}</div>
                    <div className="text-[9px] opacity-60 truncate">
                      {conn.username}@{conn.host}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {loading ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : session?.connected ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDisconnect(conn.id); }}
                        className="p-0.5 rounded hover:bg-red-500/10"
                      >
                        <PowerOff className="w-2.5 h-2.5 text-red-400" />
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleConnect(conn.id); }}
                        className="p-0.5 rounded hover:bg-emerald-500/10"
                      >
                        <Power className="w-2.5 h-2.5 text-emerald-500" />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeConnection(conn.id); }}
                      className="p-0.5 rounded hover:bg-red-500/10"
                    >
                      <Trash2 className="w-2.5 h-2.5 text-red-400" />
                    </button>
                  </div>
                </div>
              );
            })}

            {connections.length === 0 && (
              <div className="text-center py-6">
                <Server className="w-6 h-6 text-[var(--color-text-secondary)] mx-auto mb-1 opacity-20" />
                <p className="text-[10px] text-[var(--color-text-secondary)]">无连接</p>
              </div>
            )}
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {activeSessionId && sessions[activeSessionId]?.connected ? (
            <>
              {/* Tab bar */}
              <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)]">
                <button
                  onClick={() => setActiveTab("terminal")}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                    activeTab === "terminal" ? "text-white" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={activeTab === "terminal" ? { background: BRAND } : undefined}
                >
                  <Terminal className="w-3 h-3" />
                  终端
                </button>
                <button
                  onClick={() => {
                    setActiveTab("sftp");
                    if (!sftpCurrentPath[activeSessionId]) {
                      sftpNavigate(activeSessionId, "/");
                    }
                  }}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                    activeTab === "sftp" ? "text-white" : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                  }`}
                  style={activeTab === "sftp" ? { background: BRAND } : undefined}
                >
                  <FolderOpen className="w-3 h-3" />
                  文件
                </button>
              </div>

              {/* Content */}
              <div className={activeTab === "terminal" ? "flex-1 min-h-0" : "hidden"}>
                <SSHTerminalView sessionId={activeSessionId} isActive={activeTab === "terminal"} />
              </div>
              <div className={activeTab === "sftp" ? "flex-1 min-h-0" : "hidden"}>
                <SFTPBrowserView sessionId={activeSessionId} />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Terminal className="w-10 h-10 mx-auto mb-2 opacity-10 text-[var(--color-text-secondary)]" />
                <p className="text-xs text-[var(--color-text-secondary)]">
                  {activeSessionId ? "点击连接按钮启动 SSH 会话" : "选择或创建一个连接"}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add Connection Form */}
      {showForm && (
        <ConnectionFormModal
          onSave={async (config) => {
            await addConnection(config);
            setShowForm(false);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

// ── Terminal View (xterm.js) ──

function SSHTerminalView({ sessionId, isActive }: { sessionId: string; isActive: boolean }) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const {
    writeShell,
    resizeShell,
    markShellClosed,
  } = useSshStore();

  useEffect(() => {
    sshLogInfo(sessionId, "terminal view mounted");
    let disposed = false;
    let shellClosed = false;
    let warnedInputBeforeShellOpen = false;
    let warnedResizeBeforeShellOpen = false;
    let unlistenOutput: (() => void) | null = null;
    let unlistenClosed: (() => void) | null = null;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      await import("@xterm/xterm/css/xterm.css");

      if (disposed || !termRef.current) return;

      const fitAddon = new FitAddon();
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          cursor: "#f8f8f0",
          selectionBackground: "#44475a80",
          black: "#21222c",
          red: "#ff5555",
          green: "#50fa7b",
          yellow: "#f1fa8c",
          blue: "#bd93f9",
          magenta: "#ff79c6",
          cyan: "#8be9fd",
          white: "#f8f8f2",
        },
        allowProposedApi: true,
        scrollback: 5000,
      });
      xtermRef.current = term;

      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(termRef.current);

      requestAnimationFrame(() => {
        if (!disposed) {
          fitAddon.fit();
          term.focus();
          sshLogInfo(sessionId, "xterm initialized and focused");
        }
      });

      const handleShellClosed = (reason: string, error?: unknown) => {
        if (disposed || shellClosed) return;
        if (error !== undefined) {
          sshLogWarn(sessionId, `shell closed (${reason})`, error);
        } else {
          sshLogWarn(sessionId, `shell closed (${reason})`);
        }
        shellClosed = true;
        markShellClosed(sessionId);
      };

      // Keyboard input → SSH
      term.onData((data) => {
        const shellOpen = !!useSshStore.getState().sessions[sessionId]?.shellOpen;
        if (!shellOpen) {
          if (!warnedInputBeforeShellOpen) {
            sshLogInfo(sessionId, "input ignored before shell open");
            warnedInputBeforeShellOpen = true;
          }
          return;
        }
        warnedInputBeforeShellOpen = false;
        writeShell(sessionId, data).catch((e) => {
          handleShellClosed("writeShell failed", e);
        });
      });

      // Resize events → SSH
      term.onResize(({ cols, rows }) => {
        const shellOpen = !!useSshStore.getState().sessions[sessionId]?.shellOpen;
        if (!shellOpen) {
          if (!warnedResizeBeforeShellOpen) {
            sshLogInfo(sessionId, "resize ignored before shell open");
            warnedResizeBeforeShellOpen = true;
          }
          return;
        }
        warnedResizeBeforeShellOpen = false;
        resizeShell(sessionId, cols, rows).catch((e) => {
          handleShellClosed(`resizeShell failed cols=${cols} rows=${rows}`, e);
        });
      });

      // SSH output → xterm
      const unlistenOutputFn = await listenSshOutput(sessionId, (data) => {
        if (!disposed) term.write(data);
      });
      unlistenOutput = unlistenOutputFn;

      // SSH closed event → store state
      const unlistenClosedFn = await listenSshClosed(sessionId, () => {
        handleShellClosed("ssh-closed event");
      });
      unlistenClosed = unlistenClosedFn;

      // Handle window resize
      const ro = new ResizeObserver(() => {
        if (!disposed) fitAddon.fit();
      });
      if (termRef.current) ro.observe(termRef.current);

      // Store cleanup reference for ResizeObserver
      (term as any)._ro = ro;
      (term as any)._fitAddon = fitAddon;
    })();

    return () => {
      sshLogInfo(sessionId, "terminal view unmount cleanup");
      disposed = true;
      unlistenOutput?.();
      unlistenClosed?.();
      const term = xtermRef.current;
      if (term) {
        (term as any)._ro?.disconnect();
        term.dispose();
        xtermRef.current = null;
      }
    };
  }, [sessionId, writeShell, resizeShell, markShellClosed]);

  useEffect(() => {
    if (!isActive) return;
    requestAnimationFrame(() => {
      const term = xtermRef.current as any;
      term?._fitAddon?.fit();
      term?.focus();
    });
  }, [isActive, sessionId]);

  return (
    <div
      className="flex-1 overflow-hidden bg-[#1e1e1e]"
      onClick={() => xtermRef.current?.focus()}
    >
      <div ref={termRef} className="w-full h-full" />
    </div>
  );
}

// ── SFTP Browser View ──

function SFTPBrowserView({ sessionId }: { sessionId: string }) {
  const { sftpCurrentPath, sftpFiles, sftpLoading, sftpNavigate, sftpRemove, sftpMkdir } = useSshStore();
  const currentPath = sftpCurrentPath[sessionId] ?? "/";
  const files = sftpFiles[sessionId] ?? [];
  const loading = sftpLoading[sessionId] ?? false;

  const sortedFiles = useMemo(
    () =>
      [...files].sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        return a.name.localeCompare(b.name);
      }),
    [files]
  );

  const navigateUp = () => {
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    sftpNavigate(sessionId, parent);
  };

  const handleClick = (entry: SftpEntry) => {
    if (entry.is_dir) {
      sftpNavigate(sessionId, entry.path);
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Path bar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)]">
        <button
          onClick={navigateUp}
          className="p-1 rounded hover:bg-[var(--color-bg-secondary)]"
        >
          <ChevronLeft className="w-3 h-3" />
        </button>
        <span className="text-[11px] font-mono text-[var(--color-text-secondary)] flex-1 truncate">
          {currentPath}
        </span>
        <button
          onClick={() => sftpNavigate(sessionId, currentPath)}
          className="p-1 rounded hover:bg-[var(--color-bg-secondary)]"
          disabled={loading}
        >
          <RefreshCw className={`w-3 h-3 text-[var(--color-text-secondary)] ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading && files.length === 0 ? (
          <div className="text-center py-8">
            <Loader2 className="w-6 h-6 mx-auto mb-1 opacity-40 text-[var(--color-text-secondary)] animate-spin" />
            <p className="text-[10px] text-[var(--color-text-secondary)]">加载中...</p>
          </div>
        ) : files.length === 0 ? (
          <div className="text-center py-8">
            <FolderOpen className="w-6 h-6 mx-auto mb-1 opacity-20 text-[var(--color-text-secondary)]" />
            <p className="text-[10px] text-[var(--color-text-secondary)]">空目录</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {sortedFiles.map((entry) => (
                <div
                  key={entry.path}
                  onClick={() => handleClick(entry)}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-bg-secondary)] cursor-pointer transition-colors group"
                >
                  {entry.is_dir ? (
                    <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  ) : (
                    <File className="w-3.5 h-3.5 text-[var(--color-text-secondary)] shrink-0" />
                  )}
                  <span className="text-[11px] flex-1 truncate">{entry.name}</span>
                  <span className="text-[10px] text-[var(--color-text-secondary)]">
                    {!entry.is_dir && formatSize(entry.size)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      sftpRemove(sessionId, entry.path, entry.is_dir);
                    }}
                    className="p-0.5 rounded hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="w-2.5 h-2.5 text-red-400" />
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Connection Form Modal ──

function ConnectionFormModal({
  onSave,
  onCancel,
}: {
  onSave: (config: SshConnectionConfig) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [authType, setAuthType] = useState<"password" | "key" | "agent">("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim() || !host.trim()) return;
    setSaving(true);
    await onSave({
      id: `ssh-${Date.now()}`,
      name: name.trim(),
      host: host.trim(),
      port: parseInt(port) || 22,
      username: username.trim() || "root",
      auth_type: authType,
      password: authType === "password" ? password : undefined,
      private_key_path: authType === "key" ? keyPath : undefined,
    });
    setSaving(false);
  };

  const inputCls =
    "w-full bg-[var(--color-bg-secondary)] border-0 rounded-lg px-3 py-2 text-xs text-[var(--color-text)] focus:ring-2 focus:ring-[#F28F3640] transition-all outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-[var(--color-bg)] w-[400px] rounded-xl p-4 border border-[var(--color-border)] shadow-xl space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">新建 SSH 连接</h3>
          <button onClick={onCancel} className="p-1 rounded hover:bg-[var(--color-bg-secondary)]">
            <X className="w-4 h-4 text-[var(--color-text-secondary)]" />
          </button>
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Server" className={inputCls + " mt-1"} autoFocus />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">主机</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100" className={inputCls + " mt-1"} />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">端口</label>
              <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" className={inputCls + " mt-1"} />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">用户名</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" className={inputCls + " mt-1"} />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">认证方式</label>
            <div className="flex gap-2 mt-1">
              {(["password", "key", "agent"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setAuthType(t)}
                  className={`px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                    authType === t ? "text-white" : "border-[var(--color-border)] text-[var(--color-text)]"
                  }`}
                  style={authType === t ? { background: BRAND, borderColor: BRAND } : undefined}
                >
                  {t === "password" ? "密码" : t === "key" ? "密钥" : "Agent"}
                </button>
              ))}
            </div>
          </div>
          {authType === "password" && (
            <div>
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">密码</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls + " mt-1"} />
            </div>
          )}
          {authType === "key" && (
            <div>
              <label className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase">密钥文件路径</label>
              <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_rsa" className={inputCls + " mt-1"} />
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          <button onClick={onCancel} className="flex-1 py-2 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] text-xs font-medium">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !name.trim() || !host.trim()}
            className="flex-1 py-2 rounded-lg text-white text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1"
            style={{ background: BRAND }}
          >
            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
