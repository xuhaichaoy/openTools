import { describe, expect, it } from "vitest";
import {
  buildDialogSpawnedTaskHandoff,
  buildSpawnedTaskCheckpoint,
  collectSpawnedTaskTranscriptEntries,
} from "./spawned-task-checkpoint";
import type { DialogArtifactRecord, DialogMessage, SpawnedTaskRecord } from "./types";
import type { TodoItem } from "./middlewares";

const TASK: SpawnedTaskRecord = {
  runId: "run-1",
  spawnerActorId: "coordinator",
  targetActorId: "specialist",
  roleBoundary: "validator",
  task: "请排查 src/app.tsx 里的异常并补上验证步骤",
  label: "修复首页异常",
  status: "running",
  spawnedAt: 1000,
  mode: "session",
  expectsCompletionMessage: true,
  cleanup: "keep",
  sessionHistoryStartIndex: 0,
  sessionOpen: true,
  lastActiveAt: 1800,
  images: ["/repo/assets/mockup.png"],
};

const SESSION_HISTORY = [
  { role: "user" as const, content: "先定位报错根因", timestamp: 1100 },
  { role: "assistant" as const, content: "已经锁定到 src/app.tsx 的空值分支，接下来补保护并验证。", timestamp: 1500 },
];

const DIALOG_HISTORY: DialogMessage[] = [
  {
    id: "msg-1",
    from: "specialist",
    to: "coordinator",
    content: "我准备修改 /repo/src/app.tsx，并补一个回归测试。",
    timestamp: 1600,
    priority: "normal",
    relatedRunId: "run-1",
    kind: "agent_result",
  },
];

const TODOS: TodoItem[] = [
  {
    id: "todo-1",
    title: "补上首页异常的回归测试",
    status: "in_progress",
    priority: "high",
    createdAt: 1550,
    updatedAt: 1700,
  },
];

const ARTIFACTS: DialogArtifactRecord[] = [
  {
    id: "artifact-1",
    actorId: "specialist",
    path: "/repo/src/app.tsx",
    fileName: "app.tsx",
    directory: "/repo/src",
    source: "tool_edit",
    toolName: "str_replace_edit",
    summary: "补了空值保护",
    timestamp: 1750,
    relatedRunId: "run-1",
  },
];

describe("spawned-task-checkpoint", () => {
  it("collects transcript entries from task session history and dialog messages", () => {
    const transcript = collectSpawnedTaskTranscriptEntries({
      task: TASK,
      targetActor: {
        roleName: "Specialist",
        sessionHistory: SESSION_HISTORY,
      },
      actorNameById: new Map([
        ["specialist", "Specialist"],
        ["coordinator", "Coordinator"],
      ]),
      dialogHistory: DIALOG_HISTORY,
    });

    expect(transcript).toHaveLength(3);
    expect(transcript[0].label).toBe("子会话输入");
    expect(transcript[2].kindLabel).toBe("结果回传");
  });

  it("builds a checkpoint with stage, summary, next step and related files", () => {
    const checkpoint = buildSpawnedTaskCheckpoint({
      task: TASK,
      targetActor: {
        roleName: "Specialist",
        sessionHistory: SESSION_HISTORY,
      },
      actorTodos: TODOS,
      dialogHistory: DIALOG_HISTORY,
      artifacts: ARTIFACTS,
      actorNameById: new Map([
        ["specialist", "Specialist"],
        ["coordinator", "Coordinator"],
      ]),
    });

    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.stage).toBe("verification");
    expect(checkpoint?.stageLabel).toBe("验证中");
    expect(checkpoint?.summary).toContain("src/app.tsx");
    expect(checkpoint?.nextStep).toContain("回归测试");
    expect(checkpoint?.relatedArtifactPaths).toEqual(["/repo/src/app.tsx"]);
  });

  it("builds an agent handoff that preserves checkpoint and coding context", () => {
    const handoff = buildDialogSpawnedTaskHandoff({
      task: TASK,
      targetActor: {
        roleName: "Specialist",
        sessionHistory: SESSION_HISTORY,
      },
      actorTodos: TODOS,
      dialogHistory: DIALOG_HISTORY,
      artifacts: ARTIFACTS,
      actorNameById: new Map([
        ["specialist", "Specialist"],
        ["coordinator", "Coordinator"],
      ]),
      sourceSessionId: "dialog-session-1",
    });

    expect(handoff).not.toBeNull();
    expect(handoff?.intent).toBe("coding");
    expect(handoff?.title).toBe("Specialist 子任务接力");
    expect(handoff?.sourceMode).toBe("dialog");
    expect(handoff?.sourceSessionId).toBe("dialog-session-1");
    expect(handoff?.attachmentPaths).toContain("/repo/src/app.tsx");
    expect(handoff?.visualAttachmentPaths).toEqual(["/repo/assets/mockup.png"]);
    expect(handoff?.contextSections?.some((section) => section.title === "活跃待办")).toBe(true);
    expect(handoff?.contextSections?.some((section) => section.title === "视觉参考")).toBe(true);
    expect(handoff?.query).toContain("当前职责：验证回归");
    expect(handoff?.keyPoints).toContain("职责边界：验证回归");
    expect(handoff?.summary).toContain("验证中");
  });
});
