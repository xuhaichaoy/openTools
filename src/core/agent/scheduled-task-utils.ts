import type { AgentScheduledTask } from "@/core/ai/types";

const PERSISTENT_SCHEDULED_QUERY_PATTERN = /^请按「(.+?)」职责执行以下长期任务：([\s\S]+)$/;
const DIRECT_REMINDER_PREFIX_PATTERN = /^(?:请)?(?:提醒|通知)(?:一下)?(?:用户|我)?(?:去|要|记得)?/u;
const DIRECT_REMINDER_BLOCKLIST =
  /(检查|分析|总结|汇总|搜索|查询|获取|读取|抓取|监控|执行|运行|同步|生成|整理|review|debug|排查|修复|联网|调用)/iu;

export interface ParsedPersistentScheduledQuery {
  raw: string;
  title: string;
  agentName?: string;
  wrappingAgents: string[];
}

export interface DirectScheduledDelivery {
  kind: "reminder";
  subject: string;
  text: string;
}

export function parsePersistentScheduledQuery(query: string): ParsedPersistentScheduledQuery {
  const raw = query.trim();
  if (!raw) {
    return {
      raw,
      title: raw,
      wrappingAgents: [],
    };
  }

  let remaining = raw;
  const wrappingAgents: string[] = [];

  while (true) {
    const matched = remaining.match(PERSISTENT_SCHEDULED_QUERY_PATTERN);
    if (!matched) break;

    const agentName = matched[1]?.trim();
    const next = matched[2]?.trim();
    if (agentName) wrappingAgents.push(agentName);
    if (!next || next === remaining) break;
    remaining = next;
  }

  return {
    raw,
    title: remaining || raw,
    agentName: wrappingAgents[0],
    wrappingAgents,
  };
}

export function buildPersistentScheduledQuery(targetName: string, task: string): string {
  const normalizedTask = parsePersistentScheduledQuery(task.trim()).title;
  if (!normalizedTask) return normalizedTask;

  const normalizedTarget = targetName.trim();
  if (!normalizedTarget) return normalizedTask;

  return `请按「${normalizedTarget}」职责执行以下长期任务：${normalizedTask}`;
}

function normalizeReminderSubject(subject: string): string {
  return subject
    .replace(/^[\s:：,，、]+/u, "")
    .replace(/[。.!！]+$/u, "")
    .trim();
}

function buildReminderDeliveryText(subject: string): string {
  const normalized = normalizeReminderSubject(subject);
  if (!normalized) return "提醒时间到了。";
  if (/^(喝水|喝口水|补水)$/u.test(normalized)) {
    return "喝水时间到了，记得补充水分。";
  }
  if (/^(休息|休息一下|活动一下|起来活动|站起来活动)$/u.test(normalized)) {
    return "提醒你休息一下，起来活动活动。";
  }
  if (/^(吃药|按时吃药)$/u.test(normalized)) {
    return "该吃药了，记得按时服用。";
  }
  return `提醒：${normalized}。`;
}

export function inferDirectScheduledDelivery(task: string): DirectScheduledDelivery | null {
  const normalizedTask = parsePersistentScheduledQuery(task).title.trim();
  if (!normalizedTask) return null;
  if (DIRECT_REMINDER_BLOCKLIST.test(normalizedTask)) {
    return null;
  }
  if (!DIRECT_REMINDER_PREFIX_PATTERN.test(normalizedTask)) {
    return null;
  }

  const subject = normalizeReminderSubject(normalizedTask.replace(DIRECT_REMINDER_PREFIX_PATTERN, ""));
  if (!subject) return null;

  return {
    kind: "reminder",
    subject,
    text: buildReminderDeliveryText(subject),
  };
}

export function hasPersistentSchedule(
  task: Pick<AgentScheduledTask, "schedule_type" | "schedule_value">,
): boolean {
  return Boolean(task.schedule_type && task.schedule_value?.trim());
}

export function isScheduledTaskActive(
  task: Pick<AgentScheduledTask, "schedule_type" | "schedule_value" | "status">,
): boolean {
  if (!hasPersistentSchedule(task)) return false;

  const onceDone = task.schedule_type === "once"
    && (task.status === "success" || task.status === "cancelled");

  return task.status !== "paused" && task.status !== "cancelled" && !onceDone;
}

export function isScheduledTaskDone(
  task: Pick<AgentScheduledTask, "schedule_type" | "schedule_value" | "status">,
): boolean {
  if (!hasPersistentSchedule(task)) return false;
  if (task.status === "cancelled") return true;
  return task.schedule_type === "once" && task.status === "success";
}
