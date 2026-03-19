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
    });

    expect(prompt).toContain("至少有一个子任务失败");
    expect(prompt).toContain("接管并完成主任务");
    expect(prompt).toContain("生成网页");
  });
});
