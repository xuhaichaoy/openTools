import { beforeEach, describe, expect, it, vi } from "vitest";
import { WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT } from "@/plugins/builtin/SmartAgent/core/react-agent";
import { AgentActor } from "./agent-actor";
import { resolveStructuredDeliveryManifest } from "./structured-delivery-strategy";

vi.mock("@/core/ai/mtools-ai", () => ({
  getMToolsAI: () => ({}) as unknown,
}));

const { invokeTauriMock, downloadDirMock } = vi.hoisted(() => ({
  invokeTauriMock: vi.fn(async (command: string, params: Record<string, unknown>) => {
    if (command !== "export_spreadsheet") {
      throw new Error(`unexpected command: ${command}`);
    }
    return String(params.outputPath ?? "/Users/demo/Downloads/AI培训课程体系.xlsx");
  }),
  downloadDirMock: vi.fn(async () => "/Users/demo/Downloads"),
}));

vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: downloadDirMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeTauriMock,
}));

const STRUCTURED_QUERY = [
  "根据课程主题生成课程清单，最终给我一个 Excel 文件。",
  "1. AI应用开发工程化实战",
  "2. 智能体开发与知识库落地",
  "3. 大模型安全治理与测试",
  "4. AI产品需求转化与方案设计",
  "5. AI产品运营增长与商业闭环",
  "6. 银行AI解决方案咨询方法论",
  "7. 数据分析与经营洞察实战",
  "8. 全员AI办公赋能与协同提效",
  "9. AI通识与智能素养提升",
].join("\n");

describe("AgentActor host workbook fast paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns a deterministic three-shard plan before invoking the LLM", async () => {
    const spawnTask = vi.fn((spawnerActorId: string, targetActorId: string, task: string, opts?: Record<string, unknown>) => ({
      runId: `${targetActorId}-run`,
      spawnerActorId,
      targetActorId,
      task,
      label: opts?.label,
      status: "running",
    }));
    const actor = new AgentActor({
      id: "lead-fast-path",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-fast-path",
        defaultProductMode: "dialog",
        spawnTask,
        getSpawnedTasksSnapshot: vi.fn(() => []),
      } as never,
    });

    const actorAny = actor as unknown as { runWithInbox: (query: string) => Promise<string> };
    const result = await actorAny.runWithInbox(STRUCTURED_QUERY);

    expect(result).toBe(WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT);
    expect(spawnTask).toHaveBeenCalledTimes(3);
    expect(spawnTask.mock.calls.map((call) => call[3]?.label)).toEqual([
      "技术方向课程生成",
      "产品运营方向课程生成",
      "数据与通识方向课程生成",
    ]);
    expect(spawnTask.mock.calls.every((call) => call[3]?.overrides?.executionIntent === "content_executor")).toBe(true);
    expect(spawnTask.mock.calls.every((call) => call[3]?.overrides?.resultContract === "inline_structured_result")).toBe(true);
    expect(spawnTask.mock.calls.map((call) => call[3]?.overrides?.deliveryTargetLabel)).toEqual([
      "技术方向课程",
      "产品运营方向课程",
      "数据与通识方向课程",
    ]);
    expect(spawnTask.mock.calls.map((call) => call[3]?.overrides?.sheetName)).toEqual([
      "技术方向课程",
      "产品运营方向课程",
      "数据与通识方向课程",
    ]);
  });

  it("prefers the execution contract manifest over query heuristics", async () => {
    const spawnTask = vi.fn((spawnerActorId: string, targetActorId: string, task: string, opts?: Record<string, unknown>) => ({
      runId: `${targetActorId}-run`,
      spawnerActorId,
      targetActorId,
      task,
      label: opts?.label,
      status: "running",
    }));
    const actor = new AgentActor({
      id: "lead-contract-manifest",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-contract-manifest",
        defaultProductMode: "dialog",
        spawnTask,
        getSpawnedTasksSnapshot: vi.fn(() => []),
        getActiveExecutionContract: vi.fn(() => ({
          contractId: "contract-structured-1",
          surface: "local_dialog",
          executionStrategy: "coordinator",
          summary: "structured delivery by planner",
          inputHash: "input-hash",
          actorRosterHash: "roster-hash",
          initialRecipientActorIds: ["lead-contract-manifest"],
          participantActorIds: ["lead-contract-manifest"],
          allowedMessagePairs: [],
          allowedSpawnPairs: [],
          plannedDelegations: [
            {
              id: "structured-delegation-1",
              targetActorId: "delivery-target-技术方向课程",
              targetActorName: "技术方向课程生成",
              task: "围绕以下主题，为「技术方向课程」工作表生成尽可能多的高质量课程候选。",
              label: "技术方向课程生成",
              roleBoundary: "executor",
              createIfMissing: true,
              overrides: {
                executionIntent: "content_executor",
                resultContract: "inline_structured_result",
                deliveryTargetId: "技术方向课程",
                deliveryTargetLabel: "技术方向课程",
                sheetName: "技术方向课程",
              },
            },
            {
              id: "structured-delegation-2",
              targetActorId: "delivery-target-产品运营方向课程",
              targetActorName: "产品运营方向课程生成",
              task: "围绕以下主题，为「产品运营方向课程」工作表生成尽可能多的高质量课程候选。",
              label: "产品运营方向课程生成",
              roleBoundary: "executor",
              createIfMissing: true,
              overrides: {
                executionIntent: "content_executor",
                resultContract: "inline_structured_result",
                deliveryTargetId: "产品运营方向课程",
                deliveryTargetLabel: "产品运营方向课程",
                sheetName: "产品运营方向课程",
              },
            },
            {
              id: "structured-delegation-3",
              targetActorId: "delivery-target-数据与通识方向课程",
              targetActorName: "数据与通识方向课程生成",
              task: "围绕以下主题，为「数据与通识方向课程」工作表生成尽可能多的高质量课程候选。",
              label: "数据与通识方向课程生成",
              roleBoundary: "executor",
              createIfMissing: true,
              overrides: {
                executionIntent: "content_executor",
                resultContract: "inline_structured_result",
                deliveryTargetId: "数据与通识方向课程",
                deliveryTargetLabel: "数据与通识方向课程",
                sheetName: "数据与通识方向课程",
              },
            },
          ],
          approvedAt: 1,
          state: "active",
          structuredDeliveryManifest: {
            ...resolveStructuredDeliveryManifest(STRUCTURED_QUERY),
            source: "planner",
          },
        })),
      } as never,
    });

    const actorAny = actor as unknown as { runWithInbox: (query: string) => Promise<string> };
    const result = await actorAny.runWithInbox("请按合同执行并交付最终结果");

    expect(result).toBe(WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT);
    expect(spawnTask).toHaveBeenCalledTimes(3);
    expect(spawnTask.mock.calls.map((call) => call[3]?.label)).toEqual([
      "技术方向课程生成",
      "产品运营方向课程生成",
      "数据与通识方向课程生成",
    ]);
    expect(spawnTask.mock.calls.map((call) => call[3]?.plannedDelegationId)).toEqual([
      "structured-delegation-1",
      "structured-delegation-2",
      "structured-delegation-3",
    ]);
    expect(spawnTask.mock.calls.map((call) => call[1])).toEqual([
      "delivery-target-技术方向课程",
      "delivery-target-产品运营方向课程",
      "delivery-target-数据与通识方向课程",
    ]);
  });

  it("exports a single workbook from structured child results without final synthesis", async () => {
    vi.useFakeTimers();
    let active = true;
    const structuredResults = [
      {
        runId: "run-tech",
        subtaskId: "run-tech",
        targetActorId: "worker-tech",
        targetActorName: "技术方向课程生成",
        sheetName: "技术方向课程",
        label: "技术方向课程生成",
        task: "围绕需求分析、产品方案与经营数据整理课程，但这些结果属于技术方向。",
        mode: "run",
        roleBoundary: "executor",
        profile: "executor",
        executionIntent: "content_executor",
        status: "completed",
        terminalResult: JSON.stringify([
          { 课程名称: "AI应用开发工程化实战", 课程介绍: "覆盖开发、部署与落地。" },
        ]),
        startedAt: 1,
        completedAt: 2,
        timeoutSeconds: 600,
        eventCount: 3,
        resultKind: "structured_rows",
      },
      {
        runId: "run-product",
        subtaskId: "run-product",
        targetActorId: "worker-product",
        targetActorName: "产品运营方向课程生成",
        sheetName: "产品运营方向课程",
        label: "产品运营方向课程生成",
        task: "围绕需求分析、产品方案与经营数据整理课程，但这些结果属于产品运营方向。",
        mode: "run",
        roleBoundary: "executor",
        profile: "executor",
        executionIntent: "content_executor",
        status: "completed",
        terminalResult: JSON.stringify([
          { 课程名称: "AI产品运营增长闭环", 课程介绍: "覆盖运营与商业闭环。" },
        ]),
        startedAt: 1,
        completedAt: 2,
        timeoutSeconds: 600,
        eventCount: 3,
        resultKind: "structured_rows",
      },
      {
        runId: "run-data",
        subtaskId: "run-data",
        targetActorId: "worker-data",
        targetActorName: "数据与通识方向课程生成",
        sheetName: "数据与通识方向课程",
        label: "数据与通识方向课程生成",
        task: "围绕需求分析、产品方案与经营数据整理课程，但这些结果属于数据与通识方向。",
        mode: "run",
        roleBoundary: "executor",
        profile: "executor",
        executionIntent: "content_executor",
        status: "completed",
        terminalResult: JSON.stringify([
          { 课程名称: "数据分析与经营洞察实战", 课程介绍: "覆盖数据分析与经营分析。" },
        ]),
        startedAt: 1,
        completedAt: 2,
        timeoutSeconds: 600,
        eventCount: 3,
        resultKind: "structured_rows",
      },
    ];
    const actor = new AgentActor({
      id: "lead-host-export",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-export",
        defaultProductMode: "dialog",
        getActiveSpawnedTasks: vi.fn(() => (active
          ? [{ runId: "run-tech", targetActorId: "worker-tech", status: "running", spawnedAt: 1 }]
          : [])),
        getPendingDeferredSpawnTaskCount: vi.fn(() => 0),
        dispatchDeferredSpawnTasks: vi.fn(),
        collectStructuredSpawnedTaskResults: vi.fn((_actorId: string, options?: { excludeRunIds?: Set<string> }) =>
          structuredResults.filter((result) => !options?.excludeRunIds?.has(result.runId))),
        getSpawnedTasksSnapshot: vi.fn(() => []),
        getArtifactRecordsSnapshot: vi.fn(() => []),
        publishResult: vi.fn(),
        get: vi.fn((id: string) => ({ id, role: { name: id } })),
        waitForSpawnedTaskUpdate: vi.fn(() => new Promise<{ reason: "task_update" | "timeout" }>((resolve) => {
          setTimeout(() => {
            active = false;
            resolve({ reason: "task_update" });
          }, 100);
        })),
        abortActiveRunSpawnedTasks: vi.fn(() => 0),
        cancelPendingInteractionsForActor: vi.fn(),
        recordArtifact: vi.fn(),
      } as never,
    });

    const actorAny = actor as unknown as { runWithClarifications: ReturnType<typeof vi.fn> };
    let runCount = 0;
    actorAny.runWithClarifications = vi.fn(async (query: string) => {
      runCount += 1;
      if (runCount === 1) {
        return {
          result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
          finalQuery: query,
        };
      }
      throw new Error(`unexpected rerun: ${query}`);
    });

    const taskPromise = actor.assignTask(STRUCTURED_QUERY, undefined, { publishResult: false });

    await vi.advanceTimersByTimeAsync(3_200);
    const task = await taskPromise;

    expect(task.status).toBe("completed");
    expect(task.result).toContain("已导出 Excel 文件：/Users/demo/Downloads/AI培训课程体系.xlsx");
    expect(task.result).toContain("技术方向课程：1门");
    expect(task.result).toContain("产品运营方向课程：1门");
    expect(task.result).toContain("数据与通识方向课程：1门");
    expect(actorAny.runWithClarifications).toHaveBeenCalledTimes(1);
    expect(invokeTauriMock).toHaveBeenCalledWith("export_spreadsheet", expect.objectContaining({
      outputPath: "/Users/demo/Downloads/AI培训课程体系.xlsx",
    }));

    vi.useRealTimers();
  });
});
