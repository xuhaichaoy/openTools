import { describe, expect, it } from "vitest";

import {
  getLocalDialogLiveContinuationState,
  mergeLocalDialogLiveContinuationStateWithTraceEvents,
  shouldHideLocalDialogLiveActor,
  shouldHideLocalDialogMessage,
  shouldRenderLocalDialogStreamingAnswer,
  shouldHideLocalDialogStreamingAnswer,
} from "./local-dialog-projection";
import type { DialogMessage } from "@/core/agent/actor/types";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";

function createMessage(
  input: Partial<DialogMessage> & Pick<DialogMessage, "from" | "content">,
): Pick<DialogMessage, "from" | "to" | "content" | "relatedRunId" | "expectReply" | "kind"> {
  return {
    from: input.from,
    to: input.to,
    content: input.content,
    relatedRunId: input.relatedRunId,
    expectReply: input.expectReply,
    kind: input.kind,
  };
}

describe("local-dialog-projection", () => {
  it("hides child-run result traffic from the main transcript", () => {
    expect(shouldHideLocalDialogMessage(createMessage({
      from: "spawned-worker",
      content: "[Task completed: 分析文档]\n\n已完成",
      relatedRunId: "run-1",
      kind: "agent_message",
    }))).toBe(true);

    expect(shouldHideLocalDialogMessage(createMessage({
      from: "coordinator",
      content: "请确认是否继续",
      expectReply: true,
      kind: "clarification_request",
    }))).toBe(false);

    expect(shouldHideLocalDialogMessage(createMessage({
      from: "user",
      content: "继续",
      relatedRunId: "run-1",
      kind: "user_input",
    }))).toBe(false);
  });

  it("hides long collaboration summaries from the local main transcript when timeline groups exist", () => {
    expect(shouldHideLocalDialogMessage(createMessage({
      from: "coordinator",
      content: `一、已确认源文件
文件：/Users/haichao/Downloads/AI培训课程需求.xlsx
二、已完成4个分段任务
三、当前缺口
主题 8-14：仅确认完成状态
四、产物位置
历史文档产物：/Users/haichao/Downloads/1.docx`,
      kind: "agent_result",
    }), {
      hasCollaborationGroups: true,
    })).toBe(true);

    expect(shouldHideLocalDialogMessage(createMessage({
      from: "coordinator",
      content: "已生成最终方案，并保存到 /Users/haichao/Downloads/final.docx",
      kind: "agent_result",
    }), {
      hasCollaborationGroups: true,
    })).toBe(false);
  });

  it("hides live blocks for worker actors and pure wait/spawn orchestration steps", () => {
    const waitSteps: AgentStep[] = [
      {
        type: "action",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        content: "",
        timestamp: 1,
      },
    ];
    const synthesisSteps: AgentStep[] = [
      ...waitSteps,
      {
        type: "observation",
        content: "所有子任务已结束，正在触发一次最终综合。",
        timestamp: 2,
      },
      {
        type: "answer",
        content: "正在汇总最终结果",
        timestamp: 3,
        streaming: true,
      },
    ];

    expect(shouldHideLocalDialogLiveActor({
      actorId: "worker-a",
      steps: [],
      workerActorIds: new Set(["worker-a"]),
      hasCollaborationGroups: true,
    })).toBe(true);

    expect(shouldHideLocalDialogLiveActor({
      actorId: "coordinator",
      steps: waitSteps,
      workerActorIds: new Set<string>(),
      hasCollaborationGroups: true,
    })).toBe(true);

    expect(shouldHideLocalDialogLiveActor({
      actorId: "coordinator",
      steps: synthesisSteps,
      workerActorIds: new Set<string>(),
      hasCollaborationGroups: true,
    })).toBe(false);

    expect(shouldHideLocalDialogLiveActor({
      actorId: "coordinator",
      steps: waitSteps,
      workerActorIds: new Set<string>(),
      hasCollaborationGroups: false,
    })).toBe(false);
  });

  it("treats agents tool as orchestration and keeps the lead hidden until real continuation appears", () => {
    const orchestrationSteps: AgentStep[] = [
      {
        type: "action",
        toolName: "agents",
        toolInput: { action: "list" },
        content: "",
        timestamp: 1,
      },
      {
        type: "observation",
        content: "{\"agents\":[],\"self\":{\"name\":\"Coordinator\"},\"task_tree\":[]}",
        timestamp: 2,
      },
    ];
    const synthesisSteps: AgentStep[] = [
      ...orchestrationSteps,
      {
        type: "answer",
        content: "我来汇总当前协作状态并给出最终结论。",
        timestamp: 3,
        streaming: true,
      },
    ];

    expect(shouldHideLocalDialogLiveActor({
      actorId: "coordinator",
      steps: orchestrationSteps,
      workerActorIds: new Set<string>(),
      hasCollaborationGroups: true,
    })).toBe(true);

    expect(shouldHideLocalDialogLiveActor({
      actorId: "coordinator",
      steps: synthesisSteps,
      workerActorIds: new Set<string>(),
      hasCollaborationGroups: true,
    })).toBe(false);
  });

  it("extracts live continuation preview after wait/spawn orchestration", () => {
    const state = getLocalDialogLiveContinuationState([
      {
        type: "action",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        content: "",
        timestamp: 1,
      },
      {
        type: "observation",
        content: "所有子任务已结束，正在触发一次最终综合。",
        timestamp: 2,
      },
      {
        type: "answer",
        content: "正在汇总最终结果",
        timestamp: 3,
        streaming: true,
      },
    ]);

    expect(state.isContinuingAfterOrchestration).toBe(true);
    expect(state.latestContinuationTimestamp).toBe(3);
    expect(state.latestContinuationPreview).toContain("正在汇总最终结果");
    expect(state.phase).toBe("aggregating");
  });

  it("ignores low-signal sequential_thinking payloads as collaboration continuation previews", () => {
    const state = getLocalDialogLiveContinuationState([
      {
        type: "action",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        content: "",
        timestamp: 1,
      },
      {
        type: "action",
        toolName: "sequential_thinking",
        toolInput: { thought: "继续整合" },
        content: "调用 sequential_thinking",
        timestamp: 2,
      },
      {
        type: "observation",
        toolName: "sequential_thinking",
        content: "{\"thought_number\":2,\"total_thoughts\":2,\"next_thought_needed\":false}",
        timestamp: 3,
      },
      {
        type: "answer",
        content: "正在综合最终结果并导出 Excel",
        timestamp: 4,
        streaming: true,
      },
    ]);

    expect(state.isContinuingAfterOrchestration).toBe(true);
    expect(state.latestContinuationTimestamp).toBe(4);
    expect(state.latestContinuationPreview).toContain("正在综合最终结果并导出 Excel");
    expect(state.phase).toBe("aggregating");
  });

  it("marks repair continuations with an explicit repairing phase", () => {
    const state = getLocalDialogLiveContinuationState([
      {
        type: "action",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        content: "",
        timestamp: 1,
      },
      {
        type: "observation",
        content: "最终答复未通过结果校验，正在触发一次纠偏。",
        timestamp: 2,
      },
    ]);

    expect(state.phase).toBe("repairing");
  });

  it("treats quality-gate repair-round progress as a repairing phase", () => {
    const state = getLocalDialogLiveContinuationState([
      {
        type: "action",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        content: "",
        timestamp: 1,
      },
      {
        type: "observation",
        content: "host export 被 quality gate 拦截，系统正在按 repair plan 补派 1 个 repair shards。",
        timestamp: 2,
      },
    ]);

    expect(state.phase).toBe("repairing");
    expect(state.latestContinuationPreview).toContain("quality gate");
  });

  it("projects structured host milestones from repair and export steps", () => {
    const state = getLocalDialogLiveContinuationState([
      {
        type: "action",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        content: "",
        timestamp: 1,
      },
      {
        type: "observation",
        content: "host export 被 quality gate 拦截，系统正在按 repair plan 补派 1 个 repair shards。",
        timestamp: 2,
      },
      {
        type: "action",
        toolName: "export_spreadsheet",
        toolInput: {
          file_name: "final-courses.xlsx",
        },
        content: "调用 export_spreadsheet",
        timestamp: 3,
      },
      {
        type: "observation",
        toolName: "export_spreadsheet",
        toolOutput: "已导出 Excel 文件: /Users/demo/Downloads/final-courses.xlsx",
        content: "已导出 Excel 文件: /Users/demo/Downloads/final-courses.xlsx",
        timestamp: 4,
      },
    ]);

    expect(state.phase).toBe("published");
    expect(state.latestContinuationPreview).toContain("重试导出成功");
    expect(state.hostMilestones.map((milestone) => milestone.summary)).toEqual([
      "进入修复轮：host export 被 quality gate 拦截，系统正在按 repair plan 补派 1 个 repair shards。",
      "开始重试导出工作簿：final-courses.xlsx",
      "重试导出成功：/Users/demo/Downloads/final-courses.xlsx",
    ]);
  });

  it("uses export actions as structured live previews instead of raw tool labels", () => {
    const state = getLocalDialogLiveContinuationState([
      {
        type: "action",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        content: "",
        timestamp: 1,
      },
      {
        type: "action",
        toolName: "export_spreadsheet",
        toolInput: {
          file_name: "result.xlsx",
        },
        content: "调用 export_spreadsheet",
        timestamp: 2,
      },
    ]);

    expect(state.phase).toBe("aggregating");
    expect(state.latestContinuationPreview).toContain("开始导出工作簿");
    expect(state.latestContinuationPreview).toContain("result.xlsx");
  });

  it("merges direct dialog flow trace events into an idle actor continuation state", () => {
    const merged = mergeLocalDialogLiveContinuationStateWithTraceEvents(
      getLocalDialogLiveContinuationState([]),
      [
        {
          event: "repair_round_started",
          actorId: "coordinator",
          timestamp: 2000,
          detail: {
            accepted_count: 1,
            preview: "结果清单补派（第2组修复）",
          },
        },
        {
          event: "tool_call_started",
          actorId: "coordinator",
          timestamp: 2300,
          detail: {
            phase: "host_export",
            tool: "export_spreadsheet",
            preview: "final-courses.xlsx (28 rows)",
          },
        },
        {
          event: "host_export_completed",
          actorId: "coordinator",
          timestamp: 2600,
          detail: {
            phase: "host_export",
            preview: "/Users/demo/Downloads/final-courses.xlsx",
          },
        },
      ],
    );

    expect(merged.phase).toBe("published");
    expect(merged.latestContinuationPreview).toContain("重试导出成功");
    expect(merged.hostMilestones?.map((milestone) => milestone.summary)).toEqual([
      "进入修复轮：结果清单补派（第2组修复）",
      "开始重试导出工作簿：final-courses.xlsx (28 rows)",
      "重试导出成功：/Users/demo/Downloads/final-courses.xlsx",
    ]);
  });

  it("prefers newer trace-backed host milestones over older step previews", () => {
    const merged = mergeLocalDialogLiveContinuationStateWithTraceEvents(
      getLocalDialogLiveContinuationState([
        {
          type: "action",
          toolName: "wait_for_spawned_tasks",
          toolInput: {},
          content: "",
          timestamp: 1,
        },
        {
          type: "answer",
          content: "正在综合最终结果",
          timestamp: 2,
          streaming: true,
        },
      ]),
      [
        {
          event: "host_export_completed",
          actorId: "coordinator",
          timestamp: 5,
          detail: {
            phase: "host_export",
            preview: "/Users/demo/Downloads/final-courses.xlsx",
          },
        },
      ],
    );

    expect(merged.phase).toBe("published");
    expect(merged.latestContinuationTimestamp).toBe(5);
    expect(merged.latestContinuationPreview).toContain("导出成功");
  });

  it("treats aggregation and export-blocked trace events as an aggregating continuation", () => {
    const merged = mergeLocalDialogLiveContinuationStateWithTraceEvents(
      getLocalDialogLiveContinuationState([]),
      [
        {
          event: "aggregation_started",
          actorId: "coordinator",
          timestamp: 10,
          detail: {
            count: 28,
          },
        },
        {
          event: "host_export_blocked",
          actorId: "coordinator",
          timestamp: 20,
          detail: {
            phase: "host_export",
            status: "blocked",
            preview: "仍缺少 4 个主题的覆盖行。",
          },
        },
      ],
    );

    expect(merged.phase).toBe("aggregating");
    expect(merged.latestContinuationTimestamp).toBe(20);
    expect(merged.latestContinuationPreview).toContain("导出被质量门禁拦截");
    expect(merged.hostMilestones?.map((milestone) => milestone.summary)).toEqual([
      "开始汇总子任务结果：当前聚合 28 个结构化结果。",
      "导出被质量门禁拦截：仍缺少 4 个主题的覆盖行。",
    ]);
  });

  it("hides internal planning outlines from the local streaming bubble", () => {
    expect(shouldHideLocalDialogStreamingAnswer(`执行计划
步骤1：读取并锁定课程要求
工具：read_document、memory_search
依赖：无

步骤2：整理结构并输出草稿
工具：write_file
依赖：步骤1的结果`)).toBe(true);

    expect(shouldHideLocalDialogStreamingAnswer(`Execution Plan
Step 1: Inspect the uploaded spreadsheet
Tools: read_document
Dependencies: none

Step 2: Draft the summary
Tools: write_file`)).toBe(true);

    expect(shouldHideLocalDialogStreamingAnswer("我先检查相关文件，然后开始修改。")).toBe(false);
  });

  it("hides inline delegate_subtask streams from the local streaming bubble", () => {
    expect(shouldHideLocalDialogStreamingAnswer(`[子任务] 我来为您生成课程草案。

执行计划
分析需求：理解主题约束
课程设计：先出第一版结构`)).toBe(true);
  });

  it("hides inline spawn payloads from the local streaming bubble", () => {
    expect(shouldHideLocalDialogStreamingAnswer(`派发 Coding 子任务 给 course-designer-1
{
  "task": "生成课程名称与课程介绍",
  "label": "智能客服场景课程生成",
  "target_agent": "course-designer-1",
  "create_if_missing": true,
  "agent_capabilities": "course_design,content_creation,json_output",
  "timeout_seconds": 300
}`)).toBe(true);
  });

  it("keeps streaming answers visible unless a blocking execution step is newer", () => {
    expect(shouldRenderLocalDialogStreamingAnswer({
      content: "正在汇总结果",
      streamingAnswerIndex: 8,
      latestBlockingLiveIndex: 6,
    })).toBe(true);

    expect(shouldRenderLocalDialogStreamingAnswer({
      content: "先读取文档再执行",
      streamingAnswerIndex: 5,
      latestBlockingLiveIndex: -1,
    })).toBe(true);

    expect(shouldRenderLocalDialogStreamingAnswer({
      content: "准备把结果润色给用户",
      streamingAnswerIndex: 5,
      latestBlockingLiveIndex: 7,
    })).toBe(false);

    expect(shouldRenderLocalDialogStreamingAnswer({
      content: "   ",
      streamingAnswerIndex: 9,
      latestBlockingLiveIndex: 3,
    })).toBe(false);
  });
});
