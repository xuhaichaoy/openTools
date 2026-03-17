import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/ai/ai-session-runtime", () => ({
  summarizeAISessionRuntimeText: (text: string, max = 120) =>
    String(text).slice(0, max),
}));

vi.mock("@/store/agent-store", () => ({
  getVisibleAgentTasks: (session: { tasks: unknown[] }) => session.tasks,
  getAgentSessionCompactedTaskCount: () => 0,
}));

import {
  buildAgentPromptContextPrompt,
  buildAgentPromptContextReport,
  buildAgentPromptContextSnapshot,
} from "./prompt-context";

describe("prompt-context", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("injects current local time into prompt context by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T09:21:33.000Z"));

    const snapshot = buildAgentPromptContextSnapshot({
      query: "今天天气怎么样",
    });
    const report = buildAgentPromptContextReport(snapshot);
    const prompt = buildAgentPromptContextPrompt(snapshot);

    expect(snapshot.currentTimeIso).toBe("2026-03-17T09:21:33.000Z");
    expect(report.some((line) => line.includes("当前本地时间"))).toBe(true);
    expect(prompt).toContain("系统已提供当前本地时间");
    expect(prompt).toContain("ISO 时间：2026-03-17T09:21:33.000Z");
  });
});
