import React, { useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import type { ToolApprovalRisk } from "@/core/agent/actor/tool-approval-policy";

export interface ConfirmResult {
  confirmed: boolean;
}

interface ConfirmDialogProps {
  toolName: string;
  params: Record<string, unknown>;
  risk?: ToolApprovalRisk;
  reason?: string;
  onResult: (result: ConfirmResult) => void;
}

function formatRiskLabel(risk?: ToolApprovalRisk): string | null {
  switch (risk) {
    case "high":
      return "高风险";
    case "medium":
      return "中风险";
    case "unknown":
      return "风险不明确";
    case "low":
      return "低风险";
    default:
      return null;
  }
}

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

  if (name.includes("str_replace_edit") || name.includes("edit_file")) {
    const path = String(params.path || params.filePath || "");
    const command = String(params.command || "");
    return path
      ? `即将修改文件：${path}${command ? `（${command}）` : ""}`
      : "即将修改一个文件";
  }

  if (name.includes("read_file") || name.includes("read_text")) {
    const path = String(params.path || params.filePath || "");
    return path ? `即将读取文件：${path}` : "即将读取一个文件";
  }

  if (name.includes("open_path")) {
    const path = String(params.path || params.filePath || "");
    return path ? `即将打开：${path}` : "即将打开文件或目录";
  }

  if (name.includes("delete") || name.includes("remove")) {
    const path = String(params.path || params.filePath || "");
    return path ? `即将删除：${path}` : "即将执行删除操作";
  }

  if (name.includes("abort_child_session")) {
    const childSession = String(params.childSession || params.runId || "");
    const actor = String(params.actor || "");
    if (childSession && actor) {
      return `即将中止子会话：${childSession}（${actor}）`;
    }
    if (childSession) {
      return `即将中止子会话：${childSession}`;
    }
    return "即将中止一个子会话，并打断它后续的协作执行";
  }

  return `即将调用工具 ${toolName}`;
}

export function ConfirmDialog({
  toolName,
  params,
  risk,
  reason,
  onResult,
}: ConfirmDialogProps) {
  const [showDetail, setShowDetail] = useState(false);
  const description = describeAction(toolName, params);
  const riskLabel = formatRiskLabel(risk);

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

        <p className="text-sm text-[var(--color-text)] mb-3 leading-relaxed">
          {description}
        </p>

        {(riskLabel || reason) && (
          <div className="mb-3 rounded-lg border border-amber-500/15 bg-amber-500/6 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              {riskLabel && (
                <span className="rounded-full bg-amber-500/12 px-2 py-0.5 font-medium text-amber-600">
                  {riskLabel}
                </span>
              )}
              <span className="text-[var(--color-text-secondary)]">
                自动审核未直接放行，已升级到人工确认。
              </span>
            </div>
            {reason && (
              <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">
                {reason}
              </div>
            )}
          </div>
        )}

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
            onClick={() => onResult({ confirmed: false })}
            className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            拒绝
          </button>
          <button
            onClick={() => onResult({ confirmed: true })}
            className="px-3 py-1.5 text-xs rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors"
          >
            允许执行
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
