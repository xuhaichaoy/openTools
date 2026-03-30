import { describe, expect, it } from "vitest";

import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorRunContext } from "../actor-middleware";
import { ToolPolicyMiddleware } from "./tool-policy-middleware";

function createTool(name: string): AgentTool {
  return {
    name,
    description: name,
    execute: async () => ({ ok: true }),
  };
}

function createContext(params: {
  tools: AgentTool[];
  toolPolicy: { allow?: string[]; deny?: string[] };
}): ActorRunContext {
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
    toolPolicy: params.toolPolicy,
    tools: params.tools,
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "tool-policy-test",
    contextMessages: [],
  } as unknown as ActorRunContext;
}

describe("ToolPolicyMiddleware", () => {
  it("treats an allowlist as authoritative and does not preserve coordination tools", async () => {
    const ctx = createContext({
      tools: [createTool("session_history"), createTool("task_done"), createTool("send_message")],
      toolPolicy: { allow: ["task_done"] },
    });

    await new ToolPolicyMiddleware().apply(ctx);

    expect(ctx.tools.map((tool) => tool.name)).toEqual(["task_done"]);
  });
});
