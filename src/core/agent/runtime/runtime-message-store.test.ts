import { describe, expect, it } from "vitest";

import { RuntimeMessageStore } from "./runtime-message-store";

describe("RuntimeMessageStore", () => {
  it("merges active images and captures all drained user queries in order", () => {
    const store = new RuntimeMessageStore(["/tmp/seed.png"]);

    const drained = store.recordDrainedMessages([
      {
        id: "msg-user",
        from: "user",
        content: "请继续处理这个任务",
        images: ["/tmp/reply.png"],
      },
      {
        id: "msg-worker",
        from: "worker-1",
        content: "已收到",
      },
    ], (from) => (from === "user" ? "用户" : `Agent:${from}`));

    expect(drained).toEqual([
      {
        id: "msg-user",
        from: "用户",
        content: "请继续处理这个任务",
        images: ["/tmp/reply.png"],
      },
      {
        id: "msg-worker",
        from: "Agent:worker-1",
        content: "已收到",
      },
    ]);
    store.recordDrainedMessages([
      {
        id: "msg-user-2",
        from: "user",
        content: "另外补充一下边界条件",
      },
    ], (from) => (from === "user" ? "用户" : `Agent:${from}`));

    expect(store.getCurrentImages()).toEqual(["/tmp/seed.png", "/tmp/reply.png"]);
    expect(store.consumeCapturedInboxUserQueries()).toEqual([
      "请继续处理这个任务",
      "另外补充一下边界条件",
    ]);
    expect(store.consumeCapturedInboxUserQueries()).toBeUndefined();
  });
});
