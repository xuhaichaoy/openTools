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

  it("includes bootstrap budget and truncation details in the context report", () => {
    const snapshot = buildAgentPromptContextSnapshot({
      query: "继续实现设置页",
      bootstrapContextFileNames: ["AGENTS.md", "MEMORY.md"],
      bootstrapContextDiagnostics: {
        maxCharsPerFile: 4000,
        totalMaxChars: 12000,
        usedChars: 9000,
        remainingChars: 3000,
        includedFileCount: 2,
        truncatedFileCount: 1,
        omittedFileCount: 2,
        missingFileCount: 1,
        files: [
          {
            name: "AGENTS.md",
            path: "/repo/AGENTS.md",
            source: "workspace",
            status: "truncated",
            originalChars: 5200,
            includedChars: 4000,
          },
          {
            name: "MEMORY.md",
            path: "/memory/MEMORY.md",
            source: "memory",
            status: "included",
            originalChars: 1200,
            includedChars: 1200,
          },
          {
            name: "memory/2026-03-17.md",
            path: "/memory/2026-03-17.md",
            source: "memory",
            status: "omitted_budget",
            originalChars: 900,
            includedChars: 0,
          },
          {
            name: "USER.md",
            path: "/repo/USER.md",
            source: "workspace",
            status: "missing",
            originalChars: 0,
            includedChars: 0,
          },
        ],
      },
    });

    const report = buildAgentPromptContextReport(snapshot);
    const prompt = buildAgentPromptContextPrompt(snapshot);

    expect(report.some((line) => line.includes("Bootstrap 预算"))).toBe(true);
    expect(report.some((line) => line.includes("Bootstrap 已截断：AGENTS.md"))).toBe(true);
    expect(report.some((line) => line.includes("Bootstrap 超预算未注入：memory/2026-03-17.md"))).toBe(true);
    expect(report.some((line) => line.includes("Bootstrap 未找到：USER.md"))).toBe(true);
    expect(prompt).toContain("bootstrap_truncated=1");
    expect(prompt).toContain("bootstrap_omitted=2");
  });

  it("explains memory recall misses and previews when recall was attempted", () => {
    const missedSnapshot = buildAgentPromptContextSnapshot({
      query: "今天适合穿什么",
      memoryRecallAttempted: true,
      memoryRecallPreview: [],
    });
    const missedReport = buildAgentPromptContextReport(missedSnapshot);
    const missedPrompt = buildAgentPromptContextPrompt(missedSnapshot);

    expect(missedReport).toContain("已检索长期记忆：本轮未命中");
    expect(missedPrompt).toContain("memory_recall_attempted=yes");

    const hitSnapshot = buildAgentPromptContextSnapshot({
      query: "今天适合穿什么",
      userMemoryPrompt: "- [fact] 用户常驻上海\n- [preference] 习惯简洁回答",
      memoryRecallAttempted: true,
      memoryRecallPreview: ["用户常驻上海", "习惯简洁回答"],
    });
    const hitReport = buildAgentPromptContextReport(hitSnapshot);

    expect(hitSnapshot.memoryItemCount).toBe(2);
    expect(hitReport).toContain("已召回记忆：2 条");
    expect(hitReport).toContain("记忆命中预览：用户常驻上海；习惯简洁回答");
  });

  it("includes transcript fallback recall details in the context report", () => {
    const snapshot = buildAgentPromptContextSnapshot({
      query: "继续刚才那个页面",
      transcriptRecallAttempted: true,
      transcriptRecallHitCount: 2,
      transcriptRecallPreview: [
        "Agent：用户任务：继续做设置页",
        "Agent：任务结果：已完成设置页基础布局",
      ],
    });

    const report = buildAgentPromptContextReport(snapshot);
    const prompt = buildAgentPromptContextPrompt(snapshot);

    expect(report).toContain("会话轨迹回补：2 条");
    expect(report).toContain("轨迹命中预览：Agent：用户任务：继续做设置页；Agent：任务结果：已完成设置页基础布局");
    expect(prompt).toContain("transcript_recall=2");
  });
});
