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
