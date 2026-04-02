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
      transcriptFs.delete(String(args?.path ?? ""));
      return undefined;
    }
    case "list_directory": {
      const basePath = String(args?.path ?? "").replace(/[\\/]+$/g, "");
      const entries = [...transcriptFs.keys()]
        .filter((filePath) => filePath.startsWith(`${basePath}/`))
        .map((filePath) => ({
          name: filePath.slice(basePath.length + 1),
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

import {
  clearSessionCache,
  loadTranscriptSession,
  persistTranscriptActorResumeMetadata,
  readTranscriptActorResumeMetadata,
  updateTranscriptActors,
} from "./actor-transcript-fs";

describe("actor-transcript-fs resume metadata", () => {
  beforeEach(() => {
    transcriptFs.clear();
    invokeMock.mockClear();
    clearSessionCache();
  });

  it("reads persisted resume metadata by task id and agent name", async () => {
    await persistTranscriptActorResumeMetadata("session-1", "agent-1", {
      taskId: "task-1",
      sessionId: "session-1",
      agentId: "agent-1",
      agentName: "worker",
      createdAt: 100,
      originalPrompt: "initial work",
      pendingMessages: ["follow up"],
      transcriptMessages: [
        {
          role: "user",
          content: "请继续处理",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"/tmp/demo.ts\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          content: "ok",
          tool_call_id: "call-1",
          name: "read_file",
        },
      ],
      toolResultReplacementSnapshot: {
        seenToolUseIds: ["call-1"],
        replacements: [
          {
            kind: "tool-result",
            toolUseId: "call-1",
            replacement: "<persisted-output>\npreview\n</persisted-output>",
          },
        ],
      },
    });

    await expect(readTranscriptActorResumeMetadata("session-1", "task-1")).resolves.toEqual(
      expect.objectContaining({
        agentId: "agent-1",
        agentName: "worker",
        originalPrompt: "initial work",
        pendingMessages: ["follow up"],
        transcriptMessages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: expect.arrayContaining([
              expect.objectContaining({
                id: "call-1",
              }),
            ]),
          }),
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call-1",
          }),
        ]),
        toolResultReplacementSnapshot: expect.objectContaining({
          seenToolUseIds: ["call-1"],
          replacements: expect.arrayContaining([
            expect.objectContaining({
              toolUseId: "call-1",
            }),
          ]),
        }),
      }),
    );
    await expect(readTranscriptActorResumeMetadata("session-1", "worker")).resolves.toEqual(
      expect.objectContaining({
        taskId: "task-1",
      }),
    );
  });

  it("preserves resume-only actors when syncing active actor list", async () => {
    await persistTranscriptActorResumeMetadata("session-1", "agent-background", {
      taskId: "task-background",
      sessionId: "session-1",
      agentId: "agent-background",
      agentName: "background-worker",
      createdAt: 100,
    });

    await updateTranscriptActors("session-1", [
      { id: "lead", name: "leader", model: "kimi-2.5" },
    ]);

    const session = await loadTranscriptSession("session-1");
    expect(session.actorConfigs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "lead",
        name: "leader",
        model: "kimi-2.5",
      }),
      expect.objectContaining({
        id: "agent-background",
        name: "background-worker",
        resumeMetadata: expect.objectContaining({
          taskId: "task-background",
        }),
      }),
    ]));
  });
});
