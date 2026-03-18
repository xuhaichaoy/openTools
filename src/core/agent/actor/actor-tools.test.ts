import { describe, expect, it, vi } from "vitest";
import { createActorCommunicationTools } from "./actor-tools";

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
});
