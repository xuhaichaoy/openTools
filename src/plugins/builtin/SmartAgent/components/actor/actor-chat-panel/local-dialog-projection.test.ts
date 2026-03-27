import { describe, expect, it } from "vitest";

import {
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

  it("hides live blocks for worker actors and wait/spawn orchestration steps", () => {
    const waitSteps: AgentStep[] = [
      {
        type: "action",
        toolName: "wait_for_spawned_tasks",
        toolInput: {},
        content: "",
        timestamp: 1,
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
      steps: waitSteps,
      workerActorIds: new Set<string>(),
      hasCollaborationGroups: false,
    })).toBe(false);
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
