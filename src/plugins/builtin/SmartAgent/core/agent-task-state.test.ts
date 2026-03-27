import { describe, expect, it } from "vitest";
import {
  applyIncomingAgentStep,
  buildRecoveredAgentTaskPatch,
  deriveRecoveredAgentTaskStatus,
  finalizePersistedAgentSteps,
} from "./agent-task-state";

describe("agent-task-state", () => {
  it("recovers stale running task with answer to success", () => {
    const patch = buildRecoveredAgentTaskPatch({
      status: "running",
      answer: "done",
      steps: [
        {
          type: "answer",
          content: "done",
          timestamp: 1,
          streaming: true,
        },
      ],
    }, 123);

    expect(patch).toEqual({
      status: "success",
      steps: [
        {
          type: "answer",
          content: "done",
          timestamp: 1,
          streaming: false,
        },
      ],
      last_finished_at: 123,
      last_result_status: "success",
    });
  });

  it("recovers stale running task without answer to cancelled", () => {
    expect(deriveRecoveredAgentTaskStatus({
      status: "running",
      answer: null,
      steps: [
        {
          type: "tool_streaming",
          content: "{\"query\":\"docs\"}",
          timestamp: 1,
          streaming: true,
        },
      ],
    })).toBe("cancelled");
  });

  it("finalizes persisted streaming steps", () => {
    expect(finalizePersistedAgentSteps([
      {
        type: "thinking",
        content: "",
        timestamp: 1,
        streaming: true,
      },
    ])).toEqual([
      {
        type: "thinking",
        content: "（思考流已结束）",
        timestamp: 1,
        streaming: false,
      },
    ]);
  });

  it("clears provisional streaming answers once tool execution begins", () => {
    const steps = applyIncomingAgentStep([
      {
        type: "answer",
        content: "正在先写一大段草稿",
        timestamp: 1,
        streaming: true,
      },
    ], {
      type: "action",
      content: "调用 write_file",
      toolName: "write_file",
      timestamp: 2,
    });

    expect(steps).toEqual([
      {
        type: "action",
        content: "调用 write_file",
        toolName: "write_file",
        timestamp: 2,
      },
    ]);
  });

  it("keeps provisional streaming answers while tool args are still streaming", () => {
    const steps = applyIncomingAgentStep([
      {
        type: "answer",
        content: "先整理成用户可读的结果",
        timestamp: 1,
        streaming: true,
      },
    ], {
      type: "tool_streaming",
      content: "{\"path\":\"/tmp/result.md\",\"content\":\"# draft\"}",
      timestamp: 2,
      streaming: true,
    });

    expect(steps).toEqual([
      {
        type: "answer",
        content: "先整理成用户可读的结果",
        timestamp: 1,
        streaming: true,
      },
      {
        type: "tool_streaming",
        content: "{\"path\":\"/tmp/result.md\",\"content\":\"# draft\"}",
        timestamp: 2,
        streaming: true,
      },
    ]);
  });
});
