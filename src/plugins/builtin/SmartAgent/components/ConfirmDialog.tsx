import React, { useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ChevronDown, ChevronRight, Shield, ShieldCheck } from "lucide-react";
import {
  extractCommandKey,
} from "@/store/command-allowlist-store";

export type ConfirmResult =
  | { confirmed: false }
  | { confirmed: true; allowLevel?: "session" | "persist" };

interface ConfirmDialogProps {
  toolName: string;
  params: Record<string, unknown>;
  onResult: (result: ConfirmResult) => void;
  /** @deprecated 兼容旧接口 */
  onConfirm?: () => void;
  /** @deprecated 兼容旧接口 */
  onCancel?: () => void;
}

/** 将工具名 + 参数转为用户友好的自然语言描述 */
function describeAction(
  toolName: string,
  params: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  if (name.includes("shell") || name.includes("run_shell") || name.includes("command")) {
    const cmd = String(params.command || params.cmd || "");
    return cmd ? `即将执行命令：\`${cmd}\`` : "即将执行一条系统命令";
  }

  if (name.includes("write_file") || name.includes("write_text")) {
    const path = String(params.path || params.filePath || "");
    const len = String(params.content || "").length;
    return path
      ? `即将写入文件：${path}（${len} 字符）`
      : `即将写入一个文件（${len} 字符）`;
  }

  if (name.includes("read_file") || name.includes("read_text")) {
    const path = String(params.path || params.filePath || "");
    return path ? `即将读取文件：${path}` : "即将读取一个文件";
  }

  if (name.includes("delete") || name.includes("remove")) {
    const path = String(params.path || params.filePath || "");
    return path ? `即将删除：${path}` : "即将执行删除操作";
  }

  return `即将调用工具 ${toolName}`;
}

/** 将 commandKey 转为用户友好的显示名 */
function formatCommandKey(key: string): string {
  if (key.startsWith("shell:")) return key.slice(6);
  if (key.startsWith("tool:")) return key.slice(5);
  return key;
}

export function ConfirmDialog({
  toolName,
  params,
  onResult,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [showDetail, setShowDetail] = useState(false);
  const description = describeAction(toolName, params);
  const commandKey = extractCommandKey(toolName, params);
  const displayKey = formatCommandKey(commandKey);

  const handleConfirmOnce = () => {
    if (onResult) onResult({ confirmed: true });
    else onConfirm?.();
  };
  const handleAllowSession = () => {
    if (onResult) onResult({ confirmed: true, allowLevel: "session" });
    else onConfirm?.();
  };
  const handleAllowPersist = () => {
    if (onResult) onResult({ confirmed: true, allowLevel: "persist" });
    else onConfirm?.();
  };
  const handleCancel = () => {
    if (onResult) onResult({ confirmed: false });
    else onCancel?.();
  };

  const dialog = (
    <div className="fixed inset-0 z-9999 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-(--color-bg) border border-(--color-border) rounded-xl shadow-2xl w-[420px] p-5">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center">
            <AlertCircle className="w-4 h-4 text-amber-500" />
          </div>
          <h3 className="text-sm font-semibold text-[var(--color-text)]">
            操作确认
          </h3>
        </div>

        {/* 自然语言描述 */}
        <p className="text-sm text-[var(--color-text)] mb-3 leading-relaxed">
          {description}
        </p>

        {/* 可折叠的参数详情 */}
        <div className="mb-4">
          <button
            onClick={() => setShowDetail((v) => !v)}
            className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors mb-1"
          >
            {showDetail ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            查看详情
          </button>
          {showDetail && (
            <div className="bg-[var(--color-bg-secondary)] rounded-lg p-3 text-xs font-mono">
              <div className="text-amber-500 font-medium mb-1">{toolName}</div>
              <pre className="text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-32 overflow-auto">
                {JSON.stringify(params, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-col gap-2">
          {/* 主要操作行 */}
          <div className="flex gap-2 justify-end">
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              拒绝
            </button>
            <button
              onClick={handleConfirmOnce}
              className="px-3 py-1.5 text-xs rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors"
            >
              允许执行
            </button>
          </div>

          {/* 放行操作行 */}
          <div className="flex gap-2 justify-end border-t border-[var(--color-border)] pt-2">
            <button
              onClick={handleAllowSession}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-green-500 transition-colors"
              title={`本次运行期间自动放行 ${displayKey}`}
            >
              <Shield className="w-3 h-3" />
              本次允许 <code className="text-[10px] bg-[var(--color-bg-secondary)] px-1 rounded">{displayKey}</code>
            </button>
            <button
              onClick={handleAllowPersist}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-green-500/30 text-green-500/80 hover:bg-green-500/10 hover:text-green-500 transition-colors"
              title={`以后一直自动放行 ${displayKey}`}
            >
              <ShieldCheck className="w-3 h-3" />
              永久允许
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
