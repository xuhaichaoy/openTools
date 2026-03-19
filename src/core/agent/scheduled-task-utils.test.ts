import { describe, expect, it } from "vitest";
import type { AgentScheduledTask } from "@/core/ai/types";
import {
  buildPersistentScheduledQuery,
  inferDirectScheduledDelivery,
  isScheduledTaskActive,
  isScheduledTaskDone,
  parsePersistentScheduledQuery,
} from "./scheduled-task-utils";

function makeTask(
  overrides: Partial<AgentScheduledTask> = {},
): AgentScheduledTask {
  const now = Date.now();
  return {
    id: "task-1",
    query: "提醒用户喝水",
    status: "pending",
    retry_count: 0,
    created_at: now,
    updated_at: now,
    schedule_type: "interval",
    schedule_value: "60000",
    ...overrides,
  };
}

describe("scheduled-task-utils", () => {
  it("unwraps nested persistent task prefixes", () => {
    const parsed = parsePersistentScheduledQuery(
      "请按「邪恶小菠萝」职责执行以下长期任务：请按「Main」职责执行以下长期任务：提醒用户喝水",
    );

    expect(parsed.title).toBe("提醒用户喝水");
    expect(parsed.agentName).toBe("邪恶小菠萝");
    expect(parsed.wrappingAgents).toEqual(["邪恶小菠萝", "Main"]);
  });

  it("rebuilds persistent task query with only one wrapper", () => {
    const query = buildPersistentScheduledQuery(
      "Coordinator",
      "请按「Main」职责执行以下长期任务：提醒用户喝水",
    );

    expect(query).toBe("请按「Coordinator」职责执行以下长期任务：提醒用户喝水");
  });

  it("treats recurring success tasks as still active", () => {
    const task = makeTask({ status: "success", schedule_type: "interval" });
    expect(isScheduledTaskActive(task)).toBe(true);
    expect(isScheduledTaskDone(task)).toBe(false);
  });

  it("treats completed one-off tasks as done instead of active", () => {
    const task = makeTask({ status: "success", schedule_type: "once", schedule_value: String(Date.now()) });
    expect(isScheduledTaskActive(task)).toBe(false);
    expect(isScheduledTaskDone(task)).toBe(true);
  });

  it("infers direct reminder delivery for plain reminder tasks", () => {
    expect(inferDirectScheduledDelivery("提醒用户喝水")).toEqual({
      kind: "reminder",
      subject: "喝水",
      text: "喝水时间到了，记得补充水分。",
    });
  });

  it("does not treat inspection tasks as direct reminders", () => {
    expect(inferDirectScheduledDelivery("提醒用户检查服务器状态并汇总")).toBeNull();
  });
});
