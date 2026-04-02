import { beforeEach, describe, expect, it, vi } from "vitest";

const transcriptFs = new Map<string, string>();

const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case "create_directory":
      return undefined;
    case "write_text_file": {
      const path = String(args?.path ?? "");
      transcriptFs.set(path, String(args?.content ?? ""));
      return undefined;
    }
    case "read_text_file": {
      const path = String(args?.path ?? "");
      if (!transcriptFs.has(path)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return transcriptFs.get(path) ?? "";
    }
    case "delete_file": {
      const path = String(args?.path ?? "");
      transcriptFs.delete(path);
      return undefined;
    }
    case "list_directory": {
      const path = String(args?.path ?? "").replace(/[\\/]+$/g, "");
      const entries = [...transcriptFs.keys()]
        .filter((filePath) => filePath.startsWith(`${path}/`))
        .map((filePath) => ({
          name: filePath.slice(path.length + 1),
          is_dir: false,
          size: (transcriptFs.get(filePath) ?? "").length,
        }));
      return JSON.stringify(entries);
    }
    default:
      return undefined;
  }
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/tmp/51toolbox-tests",
  join: async (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
}));

import { createAgentTool } from "./agent-tool";
import { createSendMessageTool } from "./send-message-tool";
import { getAgentTaskManager, resetAgentTaskManager } from "@/core/task-center";
import { readAgentTaskOutputFile } from "@/core/task-center/agent-task-output-file";
import type { AgentTask } from "@/core/task-center/agent-task-types";
import type { ActorSystem } from "../actor/actor-system";
import {
  appendToolCall,
  appendToolResult,
  clearSessionCache,
  readTranscriptActorResumeMetadata,
} from "../actor/actor-transcript";
import { resetAgentResumeService } from "../actor/agent-resume-service";
import { resetBackgroundAgentRegistry } from "../actor/background-agent-registry";

describe("agent tools", () => {
  beforeEach(() => {
    transcriptFs.clear();
    invokeMock.mockClear();
    clearSessionCache();
    resetAgentTaskManager();
    resetAgentResumeService();
    resetBackgroundAgentRegistry();
  });

  it("spawns an agent and records a completed resumable task", async () => {
    const execute = vi.fn(async () => "done");
    const spawnAgent = vi.fn(async () => ({
      id: "agent-test",
      actor: {},
      execute,
      continueWithMessage: execute,
      receiveMessage: vi.fn(),
      stop: vi.fn(),
    }));

    const actorSystem = {
      sessionId: "session-1",
      spawnAgent,
    } as unknown as ActorSystem;

    const tool = createAgentTool(actorSystem);
    const result = await tool.handler({
      description: "Research task",
      prompt: "Investigate runtime flow",
      subagent_type: "explore_agent",
    }, {
      actorId: "lead",
    });

    expect(result.success).toBe(true);
    expect(result.resumable).toBe(true);
    expect(result.output_file).toBeTruthy();
    expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      parentActorId: "lead",
      subagentType: "explore_agent",
      description: "Research task",
    }));

    const task = getAgentTaskManager().get(result.task_id);
    expect(task).toEqual(expect.objectContaining({
      status: "completed",
      targetName: "explore_agent",
      result: "done",
      resumable: true,
    }));
    expect(await readAgentTaskOutputFile(result.output_file!)).toContain("done");
  });

  it("queues messages for running agents and resumes missing agents from saved context", async () => {
    const send = vi.fn();
    const runningActor = {
      id: "agent-running",
      role: { name: "runner" },
      status: "running",
      assignTask: vi.fn(),
    };
    const actorLookup = new Map<string, typeof runningActor>([
      ["runner", runningActor],
    ]);
    const initialExecute = vi.fn(async () => "first pass complete");
    const resumeContinue = vi.fn(async () => "continued");
    const spawnAgent = vi.fn()
      .mockImplementationOnce(async () => ({
        id: "agent-stopped",
        actor: {},
        execute: initialExecute,
        continueWithMessage: initialExecute,
        receiveMessage: vi.fn(),
        stop: vi.fn(),
      }))
      .mockImplementationOnce(async () => ({
        id: "agent-stopped",
        actor: {},
        execute: vi.fn(async () => "unused"),
        continueWithMessage: resumeContinue,
        receiveMessage: vi.fn(),
        stop: vi.fn(),
      }));

    const actorSystem = {
      send,
      sessionId: "session-1",
      spawnAgent,
      get: vi.fn(() => undefined),
      findActorByIdOrName: (identifier: string) => actorLookup.get(identifier),
    } as unknown as ActorSystem;

    const manager = getAgentTaskManager();
    manager.upsertTask({
      taskId: "agent-task:runner",
      sessionId: "session-1",
      source: "background",
      backend: "in_process",
      status: "running",
      title: "runner task",
      description: "runner task",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      targetActorId: "agent-running",
      targetName: "runner",
      recentActivity: [],
      pendingMessageCount: 0,
    } satisfies AgentTask);

    const agentTool = createAgentTool(actorSystem);
    const created = await agentTool.handler({
      description: "Worker task",
      prompt: "initial work",
      subagent_type: "worker",
    }, {
      actorId: "lead",
    });
    expect(created.output_file).toBeTruthy();
    actorLookup.delete("worker");
    resetAgentResumeService();

    const tool = createSendMessageTool(actorSystem);

    const queued = await tool.handler({
      to: "runner",
      message: "keep going",
    }, {
      actorId: "lead",
    });
    expect(queued.success).toBe(true);
    expect(send).toHaveBeenCalledWith("lead", "agent-running", "keep going", expect.objectContaining({
      bypassPlanCheck: true,
    }));
    expect(manager.get("agent-task:runner")?.pendingMessageCount).toBe(1);

    const resumed = await tool.handler({
      to: created.agent_id,
      message: "continue with this follow-up",
    }, {
      actorId: "lead",
    });
    expect(resumed.success).toBe(true);
    expect(resumed.message).toContain("Output:");
    expect(spawnAgent).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(resumeContinue).toHaveBeenCalledTimes(1);
    });
    const resumePrompt = String(resumeContinue.mock.calls.at(0)?.[0] ?? "");
    expect(resumePrompt).toContain("原始任务：\ninitial work");
    expect(resumePrompt).toContain("新的续消息：\ncontinue with this follow-up");
    expect(resumePrompt).toContain("此前输出摘录：");

    await vi.waitFor(() => {
      expect(manager.get(created.task_id)?.status).toBe("completed");
    });
    expect(await readAgentTaskOutputFile(created.output_file!)).toContain("continue with this follow-up");
  });

  it("resumes missing agents from transcript metadata after task manager reset", async () => {
    const initialExecute = vi.fn(async () => "first pass complete");
    const resumeContinue = vi.fn(async () => "continued after restart");
    const spawnAgent = vi.fn()
      .mockImplementationOnce(async () => ({
        id: "agent-persisted",
        actor: {},
        execute: initialExecute,
        continueWithMessage: initialExecute,
        receiveMessage: vi.fn(),
        stop: vi.fn(),
      }))
      .mockImplementationOnce(async () => ({
        id: "agent-persisted",
        actor: {},
        execute: vi.fn(async () => "unused"),
        continueWithMessage: resumeContinue,
        receiveMessage: vi.fn(),
        stop: vi.fn(),
      }));

    const actorSystem = {
      sessionId: "session-1",
      spawnAgent,
      get: vi.fn(() => undefined),
      findActorByIdOrName: vi.fn(() => undefined),
    } as unknown as ActorSystem;

    const agentTool = createAgentTool(actorSystem);
    const created = await agentTool.handler({
      description: "Persistent worker",
      prompt: "initial work",
      subagent_type: "worker",
    }, {
      actorId: "lead",
    });

    resetAgentResumeService();
    resetAgentTaskManager();

    const sendMessageTool = createSendMessageTool(actorSystem);
    const resumed = await sendMessageTool.handler({
      to: created.agent_id,
      message: "follow up after restart",
    }, {
      actorId: "lead",
    });

    expect(resumed.success).toBe(true);
    expect(resumed.message).toContain("persisted context");
    await vi.waitFor(() => {
      expect(resumeContinue).toHaveBeenCalledTimes(1);
    });

    const resumePrompt = String(resumeContinue.mock.calls.at(0)?.[0] ?? "");
    expect(resumePrompt).toContain("原始任务：\ninitial work");
    expect(resumePrompt).toContain("新的续消息：\nfollow up after restart");

    await vi.waitFor(() => {
      expect(getAgentTaskManager().get(created.task_id)?.status).toBe("completed");
    });
  });

  it("replays persisted session history into a fresh agent instance", async () => {
    const persistedHistory = [
      { role: "user" as const, content: "initial work", timestamp: 1 },
      { role: "assistant" as const, content: "first pass complete", timestamp: 2 },
    ];
    const initialExecute = vi.fn(async () => "first pass complete");
    const resumeContinue = vi.fn(async () => "continued via history");
    const loadSessionHistory = vi.fn();

    const firstActor = {
      getSessionHistory: () => persistedHistory,
      getSystemPromptOverride: () => "restored system prompt",
      workspace: "/tmp/replay-workspace",
      contextTokens: 4096,
      thinkingLevel: "high" as const,
      configuredMaxIterations: 18,
      persistedToolPolicyConfig: { allow: ["read_file"], deny: ["write_file"] },
      persistedExecutionPolicy: { accessMode: "full_access" as const, approvalMode: "normal" as const },
      executionPolicy: { accessMode: "full_access" as const, approvalMode: "normal" as const },
      timeoutSeconds: 120,
      idleLeaseSeconds: 30,
    };
    const resumedActor = {
      loadSessionHistory,
      getSessionHistory: () => persistedHistory,
      getSystemPromptOverride: () => "restored system prompt",
      workspace: "/tmp/replay-workspace",
      contextTokens: 4096,
      thinkingLevel: "high" as const,
      configuredMaxIterations: 18,
      persistedToolPolicyConfig: { allow: ["read_file"], deny: ["write_file"] },
      persistedExecutionPolicy: { accessMode: "full_access" as const, approvalMode: "normal" as const },
      executionPolicy: { accessMode: "full_access" as const, approvalMode: "normal" as const },
      timeoutSeconds: 120,
      idleLeaseSeconds: 30,
    };

    const spawnAgent = vi.fn()
      .mockImplementationOnce(async () => ({
        id: "agent-replay",
        actor: firstActor,
        execute: initialExecute,
        continueWithMessage: initialExecute,
        receiveMessage: vi.fn(),
        stop: vi.fn(),
      }))
      .mockImplementationOnce(async () => ({
        id: "agent-replay",
        actor: resumedActor,
        execute: vi.fn(async () => "unused"),
        continueWithMessage: resumeContinue,
        receiveMessage: vi.fn(),
        stop: vi.fn(),
      }));

    const actorSystem = {
      sessionId: "session-1",
      spawnAgent,
      get: vi.fn(() => undefined),
      findActorByIdOrName: vi.fn(() => undefined),
    } as unknown as ActorSystem;

    const agentTool = createAgentTool(actorSystem);
    const created = await agentTool.handler({
      description: "Replay worker",
      prompt: "initial work",
      subagent_type: "worker",
    }, {
      actorId: "lead",
    });

    resetAgentResumeService();
    resetAgentTaskManager();

    const sendMessageTool = createSendMessageTool(actorSystem);
    await sendMessageTool.handler({
      to: created.agent_id,
      message: "follow up with replay",
    }, {
      actorId: "lead",
    });

    await vi.waitFor(() => {
      expect(loadSessionHistory).toHaveBeenCalledWith(persistedHistory);
      expect(resumeContinue).toHaveBeenCalledWith("follow up with replay");
    });

    expect(spawnAgent.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      systemPromptOverride: "restored system prompt",
      workspace: "/tmp/replay-workspace",
      contextTokens: 4096,
      thinkingLevel: "high",
      maxIterations: 18,
      timeoutSeconds: 120,
      idleLeaseSeconds: 30,
      toolPolicy: { allow: ["read_file"], deny: ["write_file"] },
      executionPolicy: { accessMode: "full_access", approvalMode: "normal" },
    }));
  });

  it("injects transcript tool interactions into restored session history", async () => {
    const loadSessionHistory = vi.fn();
    const initialExecute = vi.fn(async () => "first pass complete");
    const resumeContinue = vi.fn(async () => "continued with transcript replay");

    const spawnAgent = vi.fn()
      .mockImplementationOnce(async () => ({
        id: "agent-tool-replay",
        actor: {
          getSessionHistory: () => [
            { role: "user" as const, content: "initial work", timestamp: 1 },
            { role: "assistant" as const, content: "first pass complete", timestamp: 2 },
          ],
          getSystemPromptOverride: () => "restored system prompt",
        },
        execute: initialExecute,
        continueWithMessage: initialExecute,
        receiveMessage: vi.fn(),
        stop: vi.fn(),
      }))
      .mockImplementationOnce(async () => ({
        id: "agent-tool-replay",
        actor: {
          loadSessionHistory,
        },
        execute: vi.fn(async () => "unused"),
        continueWithMessage: resumeContinue,
        receiveMessage: vi.fn(),
        stop: vi.fn(),
      }));

    const actorSystem = {
      sessionId: "session-1",
      spawnAgent,
      get: vi.fn(() => undefined),
      findActorByIdOrName: vi.fn(() => undefined),
    } as unknown as ActorSystem;

    const agentTool = createAgentTool(actorSystem);
    const created = await agentTool.handler({
      description: "Transcript replay worker",
      prompt: "initial work",
      subagent_type: "worker",
    }, {
      actorId: "lead",
    });

    await appendToolCall("session-1", created.agent_id, "read_file", {
      path: "/tmp/demo.ts",
    });
    await appendToolResult("session-1", created.agent_id, "read_file", "const answer = 42;");

    resetAgentResumeService();
    resetAgentTaskManager();

    const sendMessageTool = createSendMessageTool(actorSystem);
    await sendMessageTool.handler({
      to: created.agent_id,
      message: "continue after tool replay",
    }, {
      actorId: "lead",
    });

    await vi.waitFor(() => {
      expect(loadSessionHistory).toHaveBeenCalledTimes(1);
    });

    const restoredHistory = loadSessionHistory.mock.calls[0]?.[0] as Array<{
      role: "user" | "assistant";
      content: string;
      timestamp: number;
    }>;
    expect(restoredHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("[工具调用] read_file"),
      }),
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("[工具结果] read_file"),
      }),
    ]));
    expect(resumeContinue).toHaveBeenCalledWith("continue after tool replay");
  });

  it("persists tool result replacement snapshot into transcript metadata", async () => {
    const initialExecute = vi.fn(async () => "first pass complete");
    const replacementSnapshot = {
      seenToolUseIds: ["call-big-1"],
      replacements: [
        {
          kind: "tool-result" as const,
          toolUseId: "call-big-1",
          replacement: "<persisted-output>\npreview\n</persisted-output>",
        },
      ],
    };

    const spawnAgent = vi.fn(async () => ({
      id: "agent-big-output",
      actor: {
        getSessionHistory: () => [],
        getSystemPromptOverride: () => "restored system prompt",
        getToolResultReplacementSnapshot: () => replacementSnapshot,
      },
      execute: initialExecute,
      continueWithMessage: initialExecute,
      receiveMessage: vi.fn(),
      stop: vi.fn(),
    }));

    const actorSystem = {
      sessionId: "session-1",
      spawnAgent,
    } as unknown as ActorSystem;

    const agentTool = createAgentTool(actorSystem);
    const created = await agentTool.handler({
      description: "Big output worker",
      prompt: "initial work",
      subagent_type: "worker",
    }, {
      actorId: "lead",
    });

    const metadata = await readTranscriptActorResumeMetadata("session-1", created.task_id);
    expect(metadata?.toolResultReplacementSnapshot).toEqual(replacementSnapshot);
  });
});
