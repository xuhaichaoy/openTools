import { describe, expect, it } from "vitest";

import { buildDialogWorkingSetSnapshot } from "./ai-working-set";

describe("buildDialogWorkingSetSnapshot", () => {
  it("builds attachment paths and compact summaries for dialog handoff", () => {
    const snapshot = buildDialogWorkingSetSnapshot({
      artifacts: [
        {
          path: "/tmp/project/src/App.tsx",
          fileName: "App.tsx",
          actorName: "Coder",
        },
      ],
      sessionUploads: [
        {
          id: "upload-1",
          type: "document",
          name: "spec.md",
          path: "/tmp/project/docs/spec.md",
          size: 1024,
          addedAt: 1,
        },
      ],
      spawnedTasks: [
        {
          runId: "run-1",
          spawnerActorId: "coordinator",
          targetActorId: "coder",
          task: "实现首页布局并保存文件",
          label: "实现首页布局",
          status: "running",
          spawnedAt: 10,
          mode: "run",
          expectsCompletionMessage: true,
          cleanup: "keep",
          lastActiveAt: 20,
        },
        {
          runId: "run-2",
          spawnerActorId: "coordinator",
          targetActorId: "reviewer",
          task: "持续 review HTML 页面",
          status: "completed",
          spawnedAt: 11,
          completedAt: 30,
          mode: "session",
          expectsCompletionMessage: true,
          cleanup: "keep",
          sessionOpen: true,
          lastActiveAt: 30,
        },
      ],
      actorNameById: new Map([
        ["coder", "Coder"],
        ["reviewer", "Reviewer"],
      ]),
      extraAttachmentPaths: ["/tmp/project/assets/hero.png"],
    });

    expect(snapshot.attachmentPaths).toEqual([
      "/tmp/project/src/App.tsx",
      "/tmp/project/docs/spec.md",
      "/tmp/project/assets/hero.png",
    ]);
    expect(snapshot.artifactSummaryLines[0]).toContain("App.tsx");
    expect(snapshot.spawnedTaskSummaryLines[0]).toContain("开放子会话");
    expect(snapshot.uploadSummaryLine).toContain("spec.md");
    expect(snapshot.summary).toContain("Dialog 协作上下文");
    expect(snapshot.summary).toContain("附带 3 个文件/图片");
    expect(snapshot.summary).toContain("1 个产物线索");
    expect(snapshot.summary).toContain("1 个开放子会话");
  });
});
