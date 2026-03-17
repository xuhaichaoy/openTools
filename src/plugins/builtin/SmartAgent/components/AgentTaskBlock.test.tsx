import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AgentTaskBlock } from "./AgentTaskBlock";
import type { AgentTask } from "@/store/agent-store";

function createTask(answer: string): AgentTask {
  return {
    id: "task-1",
    query: "是1200px吗？",
    createdAt: Date.now(),
    steps: [],
    answer,
    status: "success",
    retry_count: 0,
  };
}

describe("AgentTaskBlock", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root && container) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
  });

  it("keeps full numeric text in rendered answer content", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const answer = [
      "是的，已经是 **1200px** 了。",
      "",
      "文件 `/Users/haichao/Downloads/1.html` 中的所有主内容区域宽度都是正确的 `max-w-[1200px]`（1200像素）。",
      "",
      "| 行号 | 区域 |",
      "| --- | --- |",
      "| 156 | Hero 主视觉区 |",
    ].join("\n");

    await act(async () => {
      root?.render(
        <AgentTaskBlock
          task={createTask(answer)}
          taskIdx={0}
          isLastTask
          isRunning={false}
          runningPhase={null}
          executionWaitingStage={null}
          processCollapsed={false}
          onToggleProcess={() => undefined}
          expandedSteps={new Set()}
          onToggleStep={() => undefined}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("1200px");
    expect(text).toContain("1200像素");
    expect(text).toContain("max-w-[1200px]");
    expect(text).not.toContain("120px");
  });
});
