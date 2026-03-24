import { describe, expect, it, vi } from "vitest";
import { createActorCommunicationTools } from "./actor-tools";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "path_exists") return true;
    throw new Error(`unexpected invoke: ${command}`);
  }),
}));

describe("createActorCommunicationTools", () => {
  it("reads inherited images lazily when spawn_task executes", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-1",
      mode: "run" as const,
      label: "实现页面",
      targetActorId: "specialist",
    }));

    let latestImages = ["/tmp/initial-design.png"];
    const system = {
      get: (id: string) => ({ id, role: { name: id === "specialist" ? "Specialist" : "Coordinator" } }),
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system, {
      getInheritedImages: () => latestImages,
    });
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    await spawnTool.execute({
      target_agent: "specialist",
      task: "根据最新设计稿实现页面",
    });
    expect(spawnTask).toHaveBeenLastCalledWith(
      "coordinator",
      "specialist",
      "根据最新设计稿实现页面",
      expect.objectContaining({
        images: ["/tmp/initial-design.png"],
      }),
    );

    latestImages = ["/tmp/revised-design.png"];
    await spawnTool.execute({
      target_agent: "specialist",
      task: "继续按更新设计稿修正细节",
    });
    expect(spawnTask).toHaveBeenLastCalledWith(
      "coordinator",
      "specialist",
      "继续按更新设计稿修正细节",
      expect.objectContaining({
        images: ["/tmp/revised-design.png"],
      }),
    );
  });

  it("passes through temporary-agent creation options for spawn_task", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-2",
      mode: "run" as const,
      label: "独立审查",
      targetActorId: "spawned-reviewer",
      roleBoundary: "reviewer" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-reviewer") return { id, role: { name: "Independent Reviewer" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    await spawnTool.execute({
      target_agent: "Independent Reviewer",
      task: "独立审查 patch 的边界条件和回归风险",
      create_if_missing: true,
      agent_description: "只负责独立审查 patch",
      agent_capabilities: "code_review,testing,unknown_capability",
      role_boundary: "reviewer",
      override_tools_allow: "read_file,search",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "Independent Reviewer",
      "独立审查 patch 的边界条件和回归风险",
      expect.objectContaining({
        createIfMissing: true,
        createChildSpec: {
          description: "只负责独立审查 patch",
          capabilities: ["code_review", "testing"],
          workspace: undefined,
        },
        roleBoundary: "reviewer",
        overrides: expect.objectContaining({
          toolPolicy: {
            allow: ["read_file", "search"],
          },
        }),
      }),
    );
  });

  it("surfaces explicit task lineage in agents list output", async () => {
    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : "Reviewer" } }),
      getAll: () => [{ id: "reviewer", role: { name: "Reviewer" }, status: "running", currentTask: null, modelOverride: undefined }],
      getCoordinatorId: () => "coordinator",
      getDescendantTasks: () => ([
        {
          runId: "run-review",
          parentRunId: "run-root",
          rootRunId: "run-root",
          roleBoundary: "reviewer" as const,
          spawnerActorId: "coordinator",
          targetActorId: "reviewer",
          label: "独立审查",
          status: "running",
          depth: 1,
          task: "独立审查 patch 的回归风险",
          result: undefined,
          error: undefined,
          mode: "run" as const,
          cleanup: "keep" as const,
          expectsCompletionMessage: true,
        },
      ]),
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const agentsTool = tools.find((tool) => tool.name === "agents");

    expect(agentsTool).toBeTruthy();
    if (!agentsTool) return;

    const result = await agentsTool.execute({ action: "list" });

    expect(result.task_tree).toEqual([
      expect.objectContaining({
        runId: "run-review",
        parentRunId: "run-root",
        rootRunId: "run-root",
        roleBoundary: "reviewer",
      }),
    ]);
  });

  it("stages explicit local media for the next external IM reply", async () => {
    const recordArtifact = vi.fn();
    const stageResultMedia = vi.fn();
    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getCoordinatorId: () => "coordinator",
      getDialogHistory: () => ([
        {
          id: "msg-user-1",
          from: "user",
          kind: "user_input",
          externalChannelType: "dingtalk",
        },
      ]),
      getSessionUploadsSnapshot: () => ([
        { id: "upload-1", name: "poster.png", path: "/repo/assets/poster.png" },
      ]),
      recordArtifact,
      stageResultMedia,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system, {
      getInheritedImages: () => ["/tmp/current-image.png"],
    });
    const sendTool = tools.find((tool) => tool.name === "send_local_media");

    expect(sendTool).toBeTruthy();
    if (!sendTool) return;

    const result = await sendTool.execute({
      attachment_name: "poster.png",
      use_current_images: true,
    });

    expect(result).toEqual(expect.objectContaining({
      queued: true,
      count: 2,
    }));
    expect(stageResultMedia).toHaveBeenCalledWith(
      "coordinator",
      expect.objectContaining({
        images: expect.arrayContaining([
          "/repo/assets/poster.png",
          "/tmp/current-image.png",
        ]),
      }),
    );
    expect(recordArtifact).toHaveBeenCalledTimes(2);
  });

  it("treats non-visual local paths as IM attachments", async () => {
    const stageResultMedia = vi.fn();
    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getCoordinatorId: () => "coordinator",
      getDialogHistory: () => ([
        {
          id: "msg-user-file",
          from: "user",
          kind: "user_input",
          externalChannelType: "feishu",
        },
      ]),
      getSessionUploadsSnapshot: () => [],
      recordArtifact: vi.fn(),
      stageResultMedia,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const sendTool = tools.find((tool) => tool.name === "send_local_media");

    expect(sendTool).toBeTruthy();
    if (!sendTool) return;

    const result = await sendTool.execute({
      path: "/Users/haichao/Downloads/file",
    });

    expect(result).toEqual(expect.objectContaining({
      queued: true,
      count: 1,
      attachments: [{ path: "/Users/haichao/Downloads/file", fileName: "file" }],
    }));
    expect(stageResultMedia).toHaveBeenCalledWith(
      "coordinator",
      expect.objectContaining({
        attachments: [{ path: "/Users/haichao/Downloads/file", fileName: "file" }],
      }),
    );
  });
});
