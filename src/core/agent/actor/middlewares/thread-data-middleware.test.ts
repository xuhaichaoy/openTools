import { describe, expect, it } from "vitest";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ActorRunContext } from "../actor-middleware";
import { ThreadDataMiddleware, buildThreadDataPaths } from "./thread-data-middleware";

function createContext(sessionId: string): ActorRunContext {
  return {
    query: "test",
    actorId: "actor-1",
    role: {
      id: "role-1",
      name: "Lead",
      systemPrompt: "",
      capabilities: [],
      maxIterations: 10,
      temperature: 0.2,
    },
    maxIterations: 10,
    extraTools: [],
    tools: [],
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "thread-data-test",
    contextMessages: [],
    actorSystem: {
      sessionId,
    } as ActorRunContext["actorSystem"],
  } as unknown as ActorRunContext;
}

describe("ThreadDataMiddleware", () => {
  it("builds stable session thread-data paths", async () => {
    const threadData = await buildThreadDataPaths("session-demo");

    expect(threadData).toEqual({
      sessionId: "session-demo",
      rootPath: join(tmpdir(), "51toolbox", "threads", "session-demo", "user-data"),
      workspacePath: join(tmpdir(), "51toolbox", "threads", "session-demo", "user-data", "workspace"),
      uploadsPath: join(tmpdir(), "51toolbox", "threads", "session-demo", "user-data", "uploads"),
      outputsPath: join(tmpdir(), "51toolbox", "threads", "session-demo", "user-data", "outputs"),
    });
  });

  it("creates thread-data directories and injects them into the context", async () => {
    const sessionId = `thread-data-${Date.now()}`;
    const ctx = createContext(sessionId);

    await new ThreadDataMiddleware().apply(ctx);

    expect(ctx.threadData?.sessionId).toBe(sessionId);
    expect(ctx.threadData?.workspacePath).toContain(`/threads/${sessionId}/user-data/workspace`);
    expect(existsSync(ctx.threadData!.workspacePath)).toBe(true);
    expect(existsSync(ctx.threadData!.uploadsPath)).toBe(true);
    expect(existsSync(ctx.threadData!.outputsPath)).toBe(true);
  });
});
