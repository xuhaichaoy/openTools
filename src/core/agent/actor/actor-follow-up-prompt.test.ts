import { describe, expect, it } from "vitest";

import {
  buildFinalSynthesisPrompt,
  buildFollowUpPromptFromRenderedMessages,
  summarizeFollowUpMessages,
} from "./actor-follow-up-prompt";

describe("actor-follow-up-prompt", () => {
  it("switches to failure-handling prompt when inbox contains failed spawned task messages", () => {
    const summary = summarizeFollowUpMessages([
      {
        from: "specialist",
        content: "[Task failed: 生成多 Agent 协作房间网页]\n\nError: 子任务返回内容像无关的算术结果。",
      },
    ]);

    const descriptor = buildFollowUpPromptFromRenderedMessages({
      renderedMessages: [
        "[Specialist]: [Task failed: 生成多 Agent 协作房间网页]\n\nError: 子任务返回内容像无关的算术结果。",
      ],
      summary,
    });

    expect(descriptor.mode).toBe("spawn_failure");
    expect(descriptor.summary.failedTaskLabels).toEqual(["生成多 Agent 协作房间网页"]);
    expect(descriptor.prompt).toContain("直接接管主任务");
    expect(descriptor.prompt).toContain("不要回到泛化分析循环");
    expect(descriptor.prompt).toContain("禁止只输出过程纪要");
  });

  it("uses synthesis prompt for pure completion follow-ups", () => {
    const summary = summarizeFollowUpMessages([
      {
        from: "specialist",
        content: "[Task completed: 生成网页]\n\n已创建 /Users/demo/Downloads/landing.html",
      },
    ]);

    const descriptor = buildFollowUpPromptFromRenderedMessages({
      renderedMessages: [
        "[Specialist]: [Task completed: 生成网页]\n\n已创建 /Users/demo/Downloads/landing.html",
      ],
      summary,
    });

    expect(descriptor.mode).toBe("spawn_completion");
    expect(descriptor.prompt).toContain("直接整合这些结果并给出最终成果");
    expect(descriptor.prompt).toContain("产物位置");
  });

  it("uses structured child terminal results to build a completion prompt even without announce text", () => {
    const descriptor = buildFollowUpPromptFromRenderedMessages({
      renderedMessages: [],
      summary: summarizeFollowUpMessages([]),
      structuredTasks: [
        {
          runId: "run-1",
          subtaskId: "run-1",
          targetActorId: "executor",
          targetActorName: "Executor",
          label: "实现页面",
          task: "实现页面",
          mode: "run",
          roleBoundary: "executor",
          profile: "executor",
          status: "completed",
          progressSummary: "已完成实现",
          terminalResult: "已创建 /Users/demo/Downloads/index.html",
          startedAt: 1,
          completedAt: 2,
          timeoutSeconds: 600,
          eventCount: 3,
          artifacts: [{
            path: "/Users/demo/Downloads/index.html",
            source: "tool_write",
            timestamp: 2,
            relatedRunId: "run-1",
          }],
        },
      ],
    });

    expect(descriptor.mode).toBe("spawn_completion");
    expect(descriptor.summary.structuredTaskCount).toBe(1);
    expect(descriptor.summary.completedTaskLabels).toEqual(["实现页面"]);
    expect(descriptor.prompt).toContain("结构化子任务结果");
    expect(descriptor.prompt).toContain("/Users/demo/Downloads/index.html");
  });

  it("counts image attachments in user follow-up messages", () => {
    const summary = summarizeFollowUpMessages([
      {
        from: "user",
        content: "如图所示",
        images: ["/tmp/a.png", "/tmp/b.png"],
      },
    ]);

    expect(summary.userMessageCount).toBe(1);
    expect(summary.userImageCount).toBe(2);
  });

  it("builds failure-aware final synthesis instructions", () => {
    const prompt = buildFinalSynthesisPrompt({
      hadFailedSpawnFollowUp: true,
      failedTaskLabels: ["生成网页"],
      structuredTasks: [
        {
          runId: "run-final-1",
          subtaskId: "run-final-1",
          targetActorId: "validator",
          targetActorName: "Validator",
          label: "页面验收",
          task: "验证页面",
          mode: "run",
          roleBoundary: "validator",
          profile: "validator",
          status: "completed",
          progressSummary: "已执行页面检查",
          terminalResult: "验证通过，产物：/Users/demo/Downloads/index.html",
          startedAt: 1,
          completedAt: 2,
          timeoutSeconds: 600,
          eventCount: 4,
          artifacts: [{
            path: "/Users/demo/Downloads/index.html",
            source: "tool_write",
            timestamp: 2,
            relatedRunId: "run-final-1",
          }],
        },
      ],
    });

    expect(prompt).toContain("至少有一个子任务失败");
    expect(prompt).toContain("接管并完成主任务");
    expect(prompt).toContain("生成网页");
    expect(prompt).toContain("结构化子任务摘要");
    expect(prompt).toContain("Validator");
    expect(prompt).toContain("/Users/demo/Downloads/index.html");
    expect(prompt).toContain("当前 run 关联");
    expect(prompt).toContain("禁止只输出过程纪要");
  });
});
