import { describe, expect, it, vi } from "vitest";
import { createActorCommunicationTools } from "./actor-tools";

describe("createActorCommunicationTools", () => {
  it("reads inherited images lazily when spawn_task executes", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-1",
      mode: "run" as const,
      label: "实现页面",
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
});
