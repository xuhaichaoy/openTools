import { describe, expect, it } from "vitest";
import type { ActorRunContext } from "../actor-middleware";
import { SessionUploadsMiddleware } from "./session-uploads-middleware";

function createContext(uploads: Array<Record<string, unknown>>): ActorRunContext {
  return {
    query: "帮我继续处理附件",
    actorId: "actor-1",
    role: {} as any,
    maxIterations: 8,
    extraTools: [],
    tools: [],
    rolePrompt: "",
    hasCodingWorkflowSkill: false,
    fcCompatibilityKey: "",
    contextMessages: [],
    actorSystem: {
      getSessionUploadsSnapshot: () => uploads,
    } as any,
  } as ActorRunContext;
}

describe("SessionUploadsMiddleware", () => {
  it("hides image paths and warns against reading images as text", async () => {
    const ctx = createContext([
      {
        id: "image-1",
        type: "image",
        name: "design.png",
        path: "/tmp/design.png",
        size: 1024,
        addedAt: Date.now(),
        originalExt: ".png",
        canReadFromPath: true,
        multimodalEligible: true,
      },
      {
        id: "file-1",
        type: "text_file",
        name: "README.md",
        path: "/tmp/README.md",
        size: 512,
        addedAt: Date.now(),
        originalExt: ".md",
        canReadFromPath: true,
      },
    ]);

    await new SessionUploadsMiddleware().apply(ctx);

    expect(ctx.contextMessages).toHaveLength(1);
    const injected = ctx.contextMessages[0]?.content ?? "";
    expect(injected).toContain("图片路径已隐藏");
    expect(injected).not.toContain("/tmp/design.png");
    expect(injected).toContain("/tmp/README.md");
    expect(injected).toContain("图片附件不要使用 read_file / read_file_range 读取本地路径");
    expect(injected).toContain("如需读取文本类附件原文，请优先使用上述路径配合 read_file / read_file_range / search_in_files 等工具。");
  });

  it("does not inject text-file read guidance when only images are attached", async () => {
    const ctx = createContext([
      {
        id: "image-1",
        type: "image",
        name: "photo.png",
        path: "/tmp/photo.png",
        size: 2048,
        addedAt: Date.now(),
        originalExt: ".png",
        canReadFromPath: true,
        multimodalEligible: true,
      },
    ]);

    await new SessionUploadsMiddleware().apply(ctx);

    const injected = ctx.contextMessages[0]?.content ?? "";
    expect(injected).toContain("图片附件不要使用 read_file / read_file_range 读取本地路径");
    expect(injected).not.toContain("如需读取文本类附件原文");
  });
});
