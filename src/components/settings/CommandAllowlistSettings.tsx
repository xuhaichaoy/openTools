import React from "react";
import { Shield, ShieldCheck, Trash2, AlertCircle } from "lucide-react";
import { useCommandAllowlistStore } from "@/store/command-allowlist-store";

export function CommandAllowlistSettings() {
  const getAllAllowed = useCommandAllowlistStore((s) => s.getAllAllowed);
  const revoke = useCommandAllowlistStore((s) => s.revoke);
  
  const allowed = getAllAllowed();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-green-500" />
        <h3 className="text-sm font-semibold">命令放行列表</h3>
      </div>

      <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
        以下命令已被设置为自动放行，执行时不再弹出确认对话框。
      </p>

      {allowed.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <AlertCircle className="w-8 h-8 text-[var(--color-text-tertiary)] mb-2" />
          <p className="text-sm text-[var(--color-text-secondary)]">
            暂无已放行的命令
          </p>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
            在危险操作确认对话框中点击「本次允许」或「永久允许」后，命令会出现在这里
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {allowed.map(({ key, level }) => (
            <div
              key={key}
              className="flex items-center justify-between px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {level === "persist" ? (
                  <ShieldCheck className="w-3.5 h-3.5 text-green-500 shrink-0" />
                ) : (
                  <Shield className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                )}
                <code className="text-xs font-mono text-[var(--color-text)] truncate">
                  {key}
                </code>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[var(--color-text-tertiary)] shrink-0">
                  {level === "persist" ? "永久" : "本次"}
                </span>
              </div>
              <button
                onClick={() => revoke(key)}
                className="ml-2 p-1 rounded hover:bg-red-500/10 text-[var(--color-text-secondary)] hover:text-red-500 transition-colors shrink-0"
                title="撤销放行"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
          <div className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
            <p className="font-medium text-amber-500 mb-1">安全提示</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>「本次允许」的命令仅在当前运行期间有效，关闭应用后失效</li>
              <li>「永久允许」的命令会持久化保存，请谨慎使用</li>
              <li>建议定期检查并清理不再需要的放行命令</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
