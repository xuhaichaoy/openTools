import React, { useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";

interface ConfirmDialogProps {
  toolName: string;
  params: Record<string, unknown>;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 将工具名 + 参数转为用户友好的自然语言描述 */
function describeAction(
  toolName: string,
  params: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  // Shell / 命令执行
  if (name.includes("shell") || name.includes("run_shell") || name.includes("command")) {
    const cmd = String(params.command || params.cmd || "");
    return cmd ? `即将执行命令：\`${cmd}\`` : "即将执行一条系统命令";
  }

  // 写文件
  if (name.includes("write_file") || name.includes("write_text")) {
    const path = String(params.path || params.filePath || "");
    const len = String(params.content || "").length;
    return path
      ? `即将写入文件：${path}（${len} 字符）`
      : `即将写入一个文件（${len} 字符）`;
  }

  // 读文件
  if (name.includes("read_file") || name.includes("read_text")) {
    const path = String(params.path || params.filePath || "");
    return path ? `即将读取文件：${path}` : "即将读取一个文件";
  }

  // 删除文件
  if (name.includes("delete") || name.includes("remove")) {
    const path = String(params.path || params.filePath || "");
    return path ? `即将删除：${path}` : "即将执行删除操作";
  }

  // 通用描述
  return `即将调用工具 ${toolName}`;
}

export function ConfirmDialog({
  toolName,
  params,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [showDetail, setShowDetail] = useState(false);
  const description = describeAction(toolName, params);

  const dialog = (
    <div className="fixed inset-0 z-9999 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-(--color-bg) border border-(--color-border) rounded-xl shadow-2xl w-[380px] p-5">
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

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            拒绝
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors"
          >
            允许执行
          </button>
        </div>
      </div>
    </div>
  );

  // 通过 createPortal 挂到 document.body，确保 fixed 定位相对于视口，
  // 不受父容器 transform / overflow:hidden 影响
  return createPortal(dialog, document.body);
}
