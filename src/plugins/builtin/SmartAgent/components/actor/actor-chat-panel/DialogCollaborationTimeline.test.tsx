import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import {
  buildLocalCollaborationTimelineGroups,
  DialogCollaborationTimelineCard,
  mergeLocalDialogTranscriptItems,
} from "./DialogCollaborationTimeline";
import type {
  DialogMessage,
  SpawnedTaskLifecycleEvent,
  SpawnedTaskRecord,
} from "@/core/agent/actor/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createTask(
  input: Partial<SpawnedTaskRecord> & Pick<SpawnedTaskRecord, "runId" | "spawnerActorId" | "targetActorId" | "task" | "mode" | "cleanup" | "expectsCompletionMessage" | "status" | "spawnedAt">,
): SpawnedTaskRecord {
  return {
    runId: input.runId,
    spawnerActorId: input.spawnerActorId,
    targetActorId: input.targetActorId,
    contractId: input.contractId,
    plannedDelegationId: input.plannedDelegationId,
    dispatchSource: input.dispatchSource ?? "manual",
    parentRunId: input.parentRunId,
    rootRunId: input.rootRunId,
    roleBoundary: input.roleBoundary ?? "executor",
    task: input.task,
    label: input.label,
    status: input.status,
    spawnedAt: input.spawnedAt,
    completedAt: input.completedAt,
    result: input.result,
    error: input.error,
    timeoutReason: input.timeoutReason,
    budgetSeconds: input.budgetSeconds,
    idleLeaseSeconds: input.idleLeaseSeconds,
    mode: input.mode,
    expectsCompletionMessage: input.expectsCompletionMessage,
    cleanup: input.cleanup,
    sessionOpen: input.sessionOpen,
    lastActiveAt: input.lastActiveAt,
    sessionClosedAt: input.sessionClosedAt,
  };
}

function createLifecycleEvent(
  input: Partial<SpawnedTaskLifecycleEvent> & Pick<SpawnedTaskLifecycleEvent, "runId" | "spawnerActorId" | "targetActorId" | "targetName" | "spawnerName" | "task" | "status" | "eventType" | "timestamp">,
): SpawnedTaskLifecycleEvent {
  return {
    runId: input.runId,
    spawnerActorId: input.spawnerActorId,
    targetActorId: input.targetActorId,
    targetName: input.targetName,
    spawnerName: input.spawnerName,
    contractId: input.contractId,
    plannedDelegationId: input.plannedDelegationId,
    dispatchSource: input.dispatchSource,
    parentRunId: input.parentRunId,
    rootRunId: input.rootRunId,
    mode: input.mode,
    roleBoundary: input.roleBoundary,
    label: input.label,
    task: input.task,
    status: input.status,
    elapsed: input.elapsed,
    message: input.message,
    stepType: input.stepType,
    result: input.result,
    error: input.error,
    budgetSeconds: input.budgetSeconds,
    idleLeaseSeconds: input.idleLeaseSeconds,
    timeoutReason: input.timeoutReason,
    eventType: input.eventType,
    timestamp: input.timestamp,
  };
}

function createMessage(
  input: Partial<DialogMessage> & Pick<DialogMessage, "id" | "from" | "content" | "timestamp">,
): DialogMessage {
  return {
    id: input.id,
    from: input.from,
    content: input.content,
    timestamp: input.timestamp,
    priority: input.priority ?? "normal",
    kind: input.kind ?? "agent_result",
    to: input.to,
  };
}

describe("DialogCollaborationTimeline", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("keeps sibling workers awaiting aggregation when the parent reply is only an interim synthesis update", () => {
    const tasks = [
      createTask({
        runId: "run-1",
        spawnerActorId: "coordinator",
        targetActorId: "worker-a",
        task: "审查类型定义",
        label: "类型审查",
        status: "completed",
        spawnedAt: 1000,
        completedAt: 3600,
        result: "类型审查完成",
        mode: "run",
        expectsCompletionMessage: true,
        cleanup: "delete",
      }),
      createTask({
        runId: "run-2",
        spawnerActorId: "coordinator",
        targetActorId: "worker-b",
        task: "验证 UI 交互",
        label: "UI 验证",
        status: "completed",
        spawnedAt: 1800,
        completedAt: 4200,
        result: "UI 验证完成",
        mode: "run",
        expectsCompletionMessage: true,
        cleanup: "delete",
      }),
    ];

    const events = [
      createLifecycleEvent({
        runId: "run-1",
        spawnerActorId: "coordinator",
        targetActorId: "worker-a",
        targetName: "Cicero",
        spawnerName: "Coordinator",
        task: "审查类型定义",
        label: "类型审查",
        status: "running",
        eventType: "spawned_task_started",
        timestamp: 1000,
      }),
      createLifecycleEvent({
        runId: "run-2",
        spawnerActorId: "coordinator",
        targetActorId: "worker-b",
        targetName: "Darwin",
        spawnerName: "Coordinator",
        task: "验证 UI 交互",
        label: "UI 验证",
        status: "running",
        eventType: "spawned_task_started",
        timestamp: 1800,
      }),
      createLifecycleEvent({
        runId: "run-1",
        spawnerActorId: "coordinator",
        targetActorId: "worker-a",
        targetName: "Cicero",
        spawnerName: "Coordinator",
        task: "审查类型定义",
        status: "completed",
        result: "类型审查完成",
        eventType: "spawned_task_completed",
        timestamp: 3600,
      }),
      createLifecycleEvent({
        runId: "run-2",
        spawnerActorId: "coordinator",
        targetActorId: "worker-b",
        targetName: "Darwin",
        spawnerName: "Coordinator",
        task: "验证 UI 交互",
        status: "completed",
        result: "UI 验证完成",
        eventType: "spawned_task_completed",
        timestamp: 4200,
      }),
    ];

    const dialogHistory = [
      createMessage({
        id: "msg-user",
        from: "user",
        content: "开始做本机协作可视化",
        timestamp: 900,
        kind: "user_input",
      }),
      createMessage({
        id: "msg-summary",
        from: "coordinator",
        content: "两组 worker 已完成，我开始汇总结论。",
        timestamp: 5000,
        kind: "agent_result",
      }),
    ];

    const groups = buildLocalCollaborationTimelineGroups({
      events,
      spawnedTasks: tasks,
      dialogHistory,
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["worker-a", "Cicero"],
        ["worker-b", "Darwin"],
      ]),
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("并行协作 · 2 个子任务");
    expect(groups[0].phase).toBe("aggregating");
    expect(groups[0].completedCount).toBe(2);
    expect(groups[0].summary).toContain("我开始汇总");
    expect(groups[0].latestParentReply).toContain("我开始汇总");
    expect(groups[0].milestones.map((item) => item.text)).toEqual([
      "Created Cicero (类型审查)",
      "Created Darwin (UI 验证)",
      "Cicero 已完成",
      "Darwin 已完成",
    ]);
  });

  it("keeps waiting for aggregation when the coordinator only messages child actors", () => {
    const groups = buildLocalCollaborationTimelineGroups({
      events: [],
      spawnedTasks: [
        createTask({
          runId: "run-1",
          spawnerActorId: "coordinator",
          targetActorId: "worker-a",
          task: "生成课程候选A",
          label: "课程候选A",
          status: "completed",
          spawnedAt: 1000,
          completedAt: 3600,
          result: "/Users/demo/Downloads/a.json",
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "delete",
        }),
        createTask({
          runId: "run-2",
          spawnerActorId: "coordinator",
          targetActorId: "worker-b",
          task: "生成课程候选B",
          label: "课程候选B",
          status: "aborted",
          spawnedAt: 1200,
          completedAt: 3800,
          error: "Idle timeout after 180s",
          timeoutReason: "idle",
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "delete",
        }),
      ],
      dialogHistory: [
        createMessage({
          id: "msg-follow-up",
          from: "coordinator",
          to: "worker-b",
          content: "立即收尾并直接返回当前已完成课程候选结果。",
          timestamp: 4200,
          kind: "agent_message",
        }),
      ],
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["worker-a", "Worker A"],
        ["worker-b", "Worker B"],
      ]),
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].phase).toBe("awaiting_aggregation");
    expect(groups[0].summary).toContain("等待 Coordinator 汇总");
  });

  it("does not mark a batch as aggregated when the parent only says it is validating the final result", () => {
    const [group] = buildLocalCollaborationTimelineGroups({
      events: [],
      spawnedTasks: [
        createTask({
          runId: "run-ui-stall",
          spawnerActorId: "coordinator",
          targetActorId: "worker-a",
          task: "生成课程结果",
          label: "课程结果",
          status: "completed",
          spawnedAt: 1000,
          completedAt: 3000,
          result: "/Users/demo/Downloads/result.xlsx",
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "keep",
        }),
      ],
      dialogHistory: [
        createMessage({
          id: "msg-interim",
          from: "coordinator",
          content: "任务产物已存在。现在验证并输出最终结果。",
          timestamp: 3600,
          kind: "agent_result",
        }),
      ],
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["worker-a", "Worker A"],
      ]),
    });

    expect(group.phase).toBe("aggregating");
    expect(group.summary).toContain("现在验证并输出最终结果");
  });

  it("shows aggregating when workers are done and the parent is still live-synthesizing", () => {
    const [group] = buildLocalCollaborationTimelineGroups({
      events: [],
      spawnedTasks: [
        createTask({
          runId: "run-live-agg",
          spawnerActorId: "coordinator",
          targetActorId: "worker-a",
          task: "生成课程结果",
          label: "课程结果",
          status: "completed",
          spawnedAt: 1000,
          completedAt: 3000,
          result: "/Users/demo/Downloads/result.xlsx",
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "keep",
        }),
      ],
      dialogHistory: [],
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["worker-a", "Worker A"],
      ]),
      parentActivityByActorId: new Map([
        ["coordinator", {
          latestOrchestrationIndex: 1,
          latestContinuationIndex: 3,
          latestContinuationTimestamp: 3600,
          latestContinuationPreview: "所有子任务已结束，正在综合最终结果。",
          isContinuingAfterOrchestration: true,
        }],
      ]),
    });

    expect(group.phase).toBe("aggregating");
    expect(group.summary).toContain("正在综合最终结果");
  });

  it("marks earlier worker batches as aggregated once a later final reply exists without duplicating that reply", () => {
    const groups = buildLocalCollaborationTimelineGroups({
      events: [],
      spawnedTasks: [
        createTask({
          runId: "run-1",
          spawnerActorId: "coordinator",
          targetActorId: "worker-a",
          task: "第一批 worker",
          label: "第一批",
          status: "completed",
          spawnedAt: 1000,
          completedAt: 2000,
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "keep",
        }),
        createTask({
          runId: "run-2",
          spawnerActorId: "coordinator",
          targetActorId: "worker-b",
          task: "第二批 worker",
          label: "第二批",
          status: "completed",
          spawnedAt: 9000,
          completedAt: 10000,
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "keep",
        }),
      ],
      dialogHistory: [
        createMessage({
          id: "msg-final",
          from: "coordinator",
          content: "我已经基于第二批结果完成最终收口。",
          timestamp: 12000,
          kind: "agent_result",
        }),
      ],
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["worker-a", "Worker A"],
        ["worker-b", "Worker B"],
      ]),
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].phase).toBe("aggregated");
    expect(groups[0].latestParentReply).toBeUndefined();
    expect(groups[0].summary).toContain("已在后续消息中完成统一汇总");
    expect(groups[1].phase).toBe("aggregated");
    expect(groups[1].latestParentReply).toContain("第二批结果完成最终收口");
  });

  it("does not reuse the same live parent preview across multiple sibling groups of the same spawner", () => {
    const groups = buildLocalCollaborationTimelineGroups({
      events: [],
      spawnedTasks: [
        createTask({
          runId: "run-a",
          spawnerActorId: "coordinator",
          targetActorId: "worker-a",
          task: "第一组 worker",
          label: "第一组",
          status: "completed",
          spawnedAt: 1000,
          completedAt: 2000,
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "keep",
        }),
        createTask({
          runId: "run-b",
          spawnerActorId: "coordinator",
          targetActorId: "worker-b",
          task: "第二组 worker",
          label: "第二组",
          status: "completed",
          spawnedAt: 9000,
          completedAt: 10000,
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "keep",
        }),
      ],
      dialogHistory: [],
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["worker-a", "Worker A"],
        ["worker-b", "Worker B"],
      ]),
      parentActivityByActorId: new Map([
        ["coordinator", {
          latestOrchestrationIndex: 1,
          latestContinuationIndex: 3,
          latestContinuationTimestamp: 10600,
          latestContinuationPreview: "正在综合最终结果并导出 Excel。",
          isContinuingAfterOrchestration: true,
        }],
      ]),
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].phase).toBe("aggregating");
    expect(groups[1].phase).toBe("aggregating");
    expect(groups[0].summary).toContain("等待 Coordinator 汇总");
    expect(groups[1].summary).toContain("正在综合最终结果并导出 Excel");
  });

  it("merges collaboration blocks into the local transcript by timestamp", () => {
    const transcriptItems = mergeLocalDialogTranscriptItems({
      messages: [
        createMessage({ id: "m1", from: "user", content: "开始", timestamp: 1000, kind: "user_input" }),
        createMessage({ id: "m2", from: "coordinator", content: "最终答复", timestamp: 9000, kind: "agent_result" }),
      ],
      groups: [{
        id: "group-1",
        spawnerActorId: "coordinator",
        spawnerName: "Coordinator",
        startedAt: 2000,
        updatedAt: 6000,
        phase: "running",
        title: "并行协作 · 2 个子任务",
        summary: "并行处理中",
        totalWorkers: 2,
        runningCount: 2,
        completedCount: 0,
        failedCount: 0,
        activeWorkerNames: ["A", "B"],
        workers: [],
        milestones: [],
      }],
    });

    expect(transcriptItems.map((item) => item.kind)).toEqual([
      "message",
      "collaboration_group",
      "message",
    ]);
  });

  it("renders the local collaboration card with worker rows", () => {
    const [group] = buildLocalCollaborationTimelineGroups({
      events: [
        createLifecycleEvent({
          runId: "run-1",
          spawnerActorId: "coordinator",
          targetActorId: "worker-a",
          targetName: "Cicero",
          spawnerName: "Coordinator",
          task: "审查类型定义",
          label: "类型审查",
          status: "running",
          eventType: "spawned_task_started",
          timestamp: 1000,
        }),
        createLifecycleEvent({
          runId: "run-1",
          spawnerActorId: "coordinator",
          targetActorId: "worker-a",
          targetName: "Cicero",
          spawnerName: "Coordinator",
          task: "审查类型定义",
          status: "running",
          message: "正在检查 DialogMessage 和 store 对齐情况",
          eventType: "spawned_task_running",
          timestamp: 2000,
        }),
      ],
      spawnedTasks: [
        createTask({
          runId: "run-1",
          spawnerActorId: "coordinator",
          targetActorId: "worker-a",
          task: "审查类型定义",
          label: "类型审查",
          status: "running",
          spawnedAt: 1000,
          lastActiveAt: 2000,
          mode: "session",
          expectsCompletionMessage: true,
          cleanup: "keep",
        }),
      ],
      dialogHistory: [],
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["worker-a", "Cicero"],
      ]),
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<DialogCollaborationTimelineCard group={group} />);
    });

    expect(container?.textContent).toContain("并行协作 · 1 个子任务");
    expect(container?.textContent).toContain("协作轨迹");
    expect(container?.textContent).toContain("Created Cicero");
    expect(container?.textContent).toContain("Cicero");
    expect(container?.textContent).toContain("正在检查 DialogMessage 和 store 对齐情况");
    expect(container?.textContent).toContain("session worker");
  });

  it("distinguishes idle timeout from budget exceeded in worker rows", () => {
    const [group] = buildLocalCollaborationTimelineGroups({
      events: [
        createLifecycleEvent({
          runId: "run-timeout",
          spawnerActorId: "coordinator",
          targetActorId: "worker-timeout",
          targetName: "Darwin",
          spawnerName: "Coordinator",
          task: "生成课程 PDF",
          status: "aborted",
          budgetSeconds: 600,
          idleLeaseSeconds: 180,
          timeoutReason: "idle",
          error: "Idle timeout after 180s",
          eventType: "spawned_task_timeout",
          timestamp: 3600,
        }),
      ],
      spawnedTasks: [
        createTask({
          runId: "run-timeout",
          spawnerActorId: "coordinator",
          targetActorId: "worker-timeout",
          task: "生成课程 PDF",
          label: "课程导出",
          status: "aborted",
          spawnedAt: 1000,
          completedAt: 3600,
          timeoutReason: "idle",
          budgetSeconds: 600,
          idleLeaseSeconds: 180,
          error: "Idle timeout after 180s",
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "keep",
        }),
      ],
      dialogHistory: [],
      actorNameById: new Map([
        ["coordinator", "Coordinator"],
        ["worker-timeout", "Darwin"],
      ]),
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<DialogCollaborationTimelineCard group={group} />);
    });

    expect(container?.textContent).toContain("空闲超时");
    expect(container?.textContent).toContain("预算 10m");
    expect(container?.textContent).toContain("租约 3m");
  });
});
