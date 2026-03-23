import { describe, expect, it } from "vitest";
import { AgentActor, DIALOG_FULL_ROLE } from "./agent-actor";

describe("AgentActor askUser image replies", () => {
  it("queues image replies into the inbox so the next model turn can see them", async () => {
    const actor = new AgentActor({
      id: "lead",
      role: { ...DIALOG_FULL_ROLE, name: "Lead" },
    }, {
      actorSystem: {
        askUserInChat: async () => ({
          interactionId: "interaction-1",
          interactionType: "question",
          status: "answered" as const,
          content: "图片内容相关的",
          message: {
            id: "reply-1",
            from: "user",
            content: "图片内容相关的",
            timestamp: Date.now(),
            priority: "normal" as const,
            images: ["/tmp/reference-image.png"],
          },
        }),
      } as never,
    });
    (actor as any)._status = "waiting";

    const answers = await (actor as any).askUser([{
      id: "q1",
      question: "图片里主要是什么内容？",
      type: "text",
    }]);

    expect(answers["图片里主要是什么内容？"]).toBe("图片内容相关的");

    const inbox = actor.drainInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.images).toEqual(["/tmp/reference-image.png"]);
    expect(inbox[0]?.content).toContain("ask_user 图片补充");
  });
});

describe("AgentActor updateConfig", () => {
  it("promotes legacy middleware approval compatibility into first-class executionPolicy", () => {
    const actor = new AgentActor({
      id: "reviewer",
      role: { ...DIALOG_FULL_ROLE, name: "Reviewer" },
      middlewareOverrides: { approvalLevel: "strict" },
    });

    expect(actor.executionPolicy).toEqual({
      accessMode: "auto",
      approvalMode: "strict",
    });
    expect(actor.normalizedExecutionPolicy).toEqual({
      accessMode: "auto",
      approvalMode: "strict",
    });
  });

  it("can clear workspace and policy fields when patch explicitly provides undefined", () => {
    const actor = new AgentActor({
      id: "editor",
      role: { ...DIALOG_FULL_ROLE, name: "Editor" },
      workspace: "/tmp/demo",
      toolPolicy: { deny: ["run_shell_command"] },
      executionPolicy: { accessMode: "full_access", approvalMode: "permissive" },
      middlewareOverrides: { approvalLevel: "permissive", disable: ["Clarification"] },
      thinkingLevel: "high",
      capabilities: { tags: ["code_write"] },
    });

    actor.updateConfig({
      workspace: undefined,
      toolPolicy: undefined,
      executionPolicy: undefined,
      middlewareOverrides: undefined,
      thinkingLevel: undefined,
      capabilities: undefined,
    });

    expect(actor.workspace).toBeUndefined();
    expect(actor.toolPolicyConfig).toBeUndefined();
    expect(actor.executionPolicy).toBeUndefined();
    expect(actor.middlewareOverrides).toBeUndefined();
    expect(actor.thinkingLevel).toBeUndefined();
    expect(actor.capabilities).toBeUndefined();
  });
});
