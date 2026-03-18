import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type { RuntimeSessionMode, RuntimeSessionRecord } from "./runtime-state";

export interface RuntimeIndicatorMeta {
  label: string;
  color: string;
}

const MODE_META: Record<RuntimeSessionMode, RuntimeIndicatorMeta> = {
  ask: {
    label: "Ask 对话",
    color: "#f59e0b",
  },
  agent: {
    label: "Agent 任务",
    color: "#22c55e",
  },
  cluster: {
    label: "集群任务",
    color: "var(--color-accent)",
  },
  dialog: {
    label: "Dialog 房间",
    color: "#3b82f6",
  },
};

function normalizeStatusLabel(status?: string): string {
  switch (status) {
    case "planning":
      return "规划中";
    case "dispatching":
      return "分发中";
    case "running":
      return "执行中";
    case "aggregating":
      return "汇总中";
    case "awaiting_approval":
      return "等待审批";
    case "awaiting_reply":
      return "等待回复";
    case "queued":
      return "排队中";
    case "done":
      return "已完成";
    case "success":
      return "已完成";
    case "error":
      return "失败";
    case "cancelled":
      return "已中断";
    default:
      return "";
  }
}

export function getRuntimeIndicatorMeta(mode: RuntimeSessionMode): RuntimeIndicatorMeta {
  return MODE_META[mode];
}

export function getRuntimeIndicatorStatus(record: RuntimeSessionRecord): string {
  switch (record.waitingStage) {
    case "user_confirm":
      return record.mode === "dialog" || record.mode === "cluster"
        ? "等待审批"
        : "等待确认";
    case "user_reply":
      return "等待回复";
    case "follow_up_queue":
      return "等待继续";
    case "model_first_token":
      return "等待首个响应";
    case "model_generating":
      return "生成中";
    case "planning":
      return "规划中";
    case "dispatching":
      return "分发中";
    case "running":
    case "dialog_running":
      return record.mode === "dialog" ? "协作中" : "执行中";
    case "aggregating":
      return "汇总中";
    default:
      return normalizeStatusLabel(record.status) || "执行中";
  }
}

export function buildRuntimeIndicatorDetail(
  record: RuntimeSessionRecord,
  modeCount = 1,
): string {
  const status = getRuntimeIndicatorStatus(record);
  if (record.mode === "cluster" && modeCount > 1) {
    return `${status} · ${modeCount} 个任务`;
  }
  const queryPreview = summarizeAISessionRuntimeText(record.query, 32);
  if (!queryPreview) return status;
  return `${status} · ${queryPreview}`;
}

export function shouldPulseRuntimeIndicator(record: RuntimeSessionRecord): boolean {
  return record.waitingStage === "user_confirm"
    || record.waitingStage === "user_reply"
    || record.waitingStage === "follow_up_queue"
    || record.status === "awaiting_approval"
    || record.status === "awaiting_reply"
    || record.status === "queued";
}
