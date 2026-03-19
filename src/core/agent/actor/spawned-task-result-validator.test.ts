import { describe, expect, it } from "vitest";
import {
  buildSpawnTaskExecutionHint,
  validateActorTaskResult,
  validateSpawnedTaskResult,
} from "./spawned-task-result-validator";
import type { DialogArtifactRecord, SpawnedTaskRecord } from "./types";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";

function makeTask(task: string, label?: string): SpawnedTaskRecord {
  return {
    runId: "run-1",
    spawnerActorId: "coordinator",
    targetActorId: "specialist",
    task,
    label,
    status: "running",
    spawnedAt: 1000,
    mode: "run",
    expectsCompletionMessage: true,
    cleanup: "keep",
  };
}

describe("spawned-task-result-validator", () => {
  it("adds stronger execution hints for concrete coding or page-generation tasks", () => {
    const hint = buildSpawnTaskExecutionHint("请创建一个多 Agent 协作房间网页");
    expect(hint).toContain("需要具体产物或可验证结果");
    expect(hint).toContain("文件路径");
  });

  it("rejects obviously unrelated arithmetic output for a page creation task", () => {
    const validation = validateSpawnedTaskResult({
      task: makeTask("请创建一个多 Agent 协作房间网页", "创建协作网页"),
      result: "1024+768 = 1792",
      artifacts: [],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("算术结果");
    expect(validation.requiresConcreteOutput).toBe(true);
  });

  it("accepts page-generation results when there is concrete artifact evidence", () => {
    const artifacts: DialogArtifactRecord[] = [
      {
        id: "artifact-1",
        actorId: "specialist",
        path: "/repo/src/pages/DialogRoom.tsx",
        fileName: "DialogRoom.tsx",
        directory: "/repo/src/pages",
        source: "tool_write",
        toolName: "write_file",
        summary: "创建了多 Agent 协作房间页面",
        timestamp: 1500,
        relatedRunId: "run-1",
      },
    ];
    const validation = validateSpawnedTaskResult({
      task: makeTask("请创建一个多 Agent 协作房间网页", "创建协作网页"),
      result: "已创建 /repo/src/pages/DialogRoom.tsx，并完成页面结构与基础样式。",
      artifacts,
    });

    expect(validation.accepted).toBe(true);
    expect(validation.requiresConcreteOutput).toBe(true);
  });

  it("rejects bogus top-level results for concrete artifact tasks", () => {
    const validation = validateActorTaskResult({
      taskText: "参照图片生成网页并保存到 Downloads",
      result: "1+1 = 2",
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("算术结果");
  });

  it("accepts top-level results when actor actually produced the artifact", () => {
    const validation = validateActorTaskResult({
      taskText: "参照图片生成网页并保存到 Downloads",
      result: "已生成 /Users/demo/Downloads/room.html，并完成基础布局与交互。",
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [
        {
          id: "artifact-2",
          actorId: "coordinator",
          path: "/Users/demo/Downloads/room.html",
          fileName: "room.html",
          directory: "/Users/demo/Downloads",
          source: "tool_write",
          toolName: "write_file",
          summary: "生成网页文件",
          timestamp: 1500,
        },
      ],
    });

    expect(validation.accepted).toBe(true);
    expect(validation.requiresConcreteOutput).toBe(true);
  });

  it("rejects schedule success claims without real scheduling tool calls", () => {
    const validation = validateActorTaskResult({
      taskText: "再创建一个任务 每隔两分钟提醒我喝水",
      result: "已创建新的喝水提醒任务，首次提醒 10:27，任务 ID：agt-old-id",
      steps: [],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("真实工具调用证据");
  });

  it("accepts schedule success claims when schedule_task was actually called", () => {
    const steps: AgentStep[] = [
      {
        type: "action",
        content: "调用 schedule_task",
        toolName: "schedule_task",
        toolInput: {
          target_agent: "邪恶小菠萝",
          task: "提醒用户喝水",
          type: "interval",
          delay_seconds: 120,
        },
        timestamp: 1000,
      },
    ];

    const validation = validateActorTaskResult({
      taskText: "再创建一个任务 每隔两分钟提醒我喝水",
      result: "已创建新的喝水提醒任务，首次提醒 10:27，任务 ID：agt-new-id",
      steps,
    });

    expect(validation.accepted).toBe(true);
  });
});
