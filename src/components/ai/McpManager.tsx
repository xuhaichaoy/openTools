import { useEffect, useState } from 'react';
import { useMcpStore } from '@/store/mcp-store';
import { Server, Power, RefreshCw, Settings, CheckCircle, XCircle, Loader2 } from 'lucide-react';

export function McpManager({ compact = false }: { compact?: boolean }) {
  const { servers, serverStatus, serverTools, loaded, load, toggleServer } = useMcpStore();
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const getStatusIcon = (serverId: string) => {
    const status = serverStatus[serverId];
    if (status === 'online') return <CheckCircle className="w-4 h-4 text-green-500" />;
    if (status === 'offline') return <XCircle className="w-4 h-4 text-red-500" />;
    return <Loader2 className="w-4 h-4 animate-spin text-yellow-500" />;
  };

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex items-center justify-between">
        <div>
          <span className={`font-semibold ${compact ? 'text-xs' : 'text-sm'}`}>
            MCP 服务器
          </span>
          <span className="ml-2 text-[10px] text-[var(--color-text-secondary)]">
            {servers.filter(s => s.enabled).length}/{servers.length} 已启用
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {servers.map(server => {
          const tools = serverTools[server.id] || [];
          const isExpanded = expandedServer === server.id;

          return (
            <div
              key={server.id}
              className="border border-[var(--color-border)] rounded-lg p-3 bg-[var(--color-bg-secondary)]"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1">
                  <Server className="w-4 h-4 text-[var(--color-text-secondary)]" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{server.name}</span>
                      {getStatusIcon(server.id)}
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)]">
                      {tools.length} 个工具
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setExpandedServer(isExpanded ? null : server.id)}
                    className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => toggleServer(server.id)}
                    className={`p-1.5 rounded transition-colors ${
                      server.enabled
                        ? 'bg-green-500/20 text-green-600 hover:bg-green-500/30'
                        : 'bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-active)]'
                    }`}
                  >
                    <Power className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {isExpanded && tools.length > 0 && (
                <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                  <div className="text-xs font-medium mb-2">可用工具：</div>
                  <div className="space-y-1">
                    {tools.map(tool => (
                      <div
                        key={tool.name}
                        className="text-xs p-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)]"
                      >
                        <div className="font-medium">{tool.name}</div>
                        {tool.description && (
                          <div className="text-[var(--color-text-secondary)] mt-0.5">
                            {tool.description}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {servers.length === 0 && (
          <div className="text-center py-8 text-[var(--color-text-secondary)] text-sm">
            暂无 MCP 服务器
          </div>
        )}
      </div>
    </div>
  );
}
