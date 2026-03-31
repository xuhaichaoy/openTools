import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActor } from "./agent-actor";
import {
  resolveStructuredDeliveryManifest,
  resolveStructuredDeliveryStrategy,
} from "./structured-delivery-strategy";
import { WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT } from "@/plugins/builtin/SmartAgent/core/react-agent";

vi.mock("@/core/ai/mtools-ai", () => ({
  getMToolsAI: () => ({}) as unknown,
}));

vi.mock("./middlewares", () => ({
  ClarificationInterrupt: class ClarificationInterrupt extends Error {},
  createDefaultMiddlewares: () => [],
}));

vi.mock("./actor-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./actor-middleware")>();
  return {
    ...actual,
    runMiddlewareChain: vi.fn(async (_middlewares, ctx) => {
      ctx.tools = [
        { name: "read_document", description: "", execute: vi.fn(async () => "") },
        { name: "spawn_task", description: "", execute: vi.fn(async () => "") },
        { name: "wait_for_spawned_tasks", description: "", execute: vi.fn(async () => "") },
        { name: "export_spreadsheet", description: "", execute: vi.fn(async () => "") },
        { name: "task_done", description: "", execute: vi.fn(async () => "") },
      ];
    }),
  };
});

vi.mock("@/plugins/builtin/SmartAgent/core/react-agent", () => ({
  WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT: "__WAIT_FOR_SPAWNED_TASKS_DEFERRED__",
  WaitForSpawnedTasksInterrupt: class WaitForSpawnedTasksInterrupt extends Error {},
  ReActAgent: class MockReActAgent {
    private readonly tools: Array<{ name: string }>;

    constructor(_ai: unknown, tools: Array<{ name: string }>) {
      this.tools = tools;
    }

    listVisibleToolNames(): string[] {
      return [...this.tools.map((tool) => tool.name)];
    }

    async run(): Promise<string> {
      return "done";
    }
  },
}));

const { invokeTauriMock, downloadDirMock } = vi.hoisted(() => ({
  invokeTauriMock: vi.fn(async (command: string, params: Record<string, unknown>) => {
    if (command !== "export_spreadsheet") {
      throw new Error(`unexpected command: ${command}`);
    }
    return String(params.outputPath ?? "/Users/demo/Downloads/source.xlsx");
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
  "## 🗂️ 工作上下文 - 项目路径: `/Users/demo/Downloads/source.xlsx`",
  "以下是用户提供的文件内容（路径均为绝对路径），请根据用户指令进行处理。",
  "### 文件 /Users/demo/Downloads/source.xlsx",
  "1. AI应用开发工程化实战",
  "2. 智能体开发与知识库落地",
  "3. 大模型安全治理与测试",
  "4. AI产品需求转化与方案设计",
  "5. AI产品运营增长与商业闭环",
  "6. 银行AI解决方案咨询方法论",
  "7. 数据分析与经营洞察实战",
  "8. 全员AI办公赋能与协同提效",
  "9. AI通识与智能素养提升",
  "用户要求：根据这 9 个主题生成课程清单，需要提供的字段只有课程名称和课程介绍，最终给我一个 Excel 文件。",
].join("\n");

describe("AgentActor host workbook fast paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not auto-dispatch dynamic shards on the first turn", async () => {
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
        recordDialogFlowEvent: vi.fn(),
        defaultProductMode: "dialog",
        spawnTask,
        getAll: () => [],
        get: () => null,
        getSpawnedTasksSnapshot: vi.fn(() => []),
      } as never,
    });

    const actorAny = actor as unknown as { runWithInbox: (query: string) => Promise<string> };
    const result = await actorAny.runWithInbox(STRUCTURED_QUERY);

    expect(result).toBe("done");
    expect(spawnTask).not.toHaveBeenCalled();
  });

  it("no longer queues overflow dynamic shards until the lead agent explicitly dispatches them", async () => {
    const largeQuery = [
      "## 🗂️ 工作上下文 - 项目路径: `/Users/demo/Downloads/source.xlsx`",
      "以下是用户提供的文件内容（路径均为绝对路径），请根据用户指令进行处理。",
      "### 文件 /Users/demo/Downloads/source.xlsx",
      ...Array.from({ length: 30 }, (_, index) => `${index + 1}. 主题${index + 1}`),
      "用户要求：根据这 30 个主题生成课程清单，需要提供的字段只有课程名称和课程介绍，最终给我一个 Excel 文件。",
    ].join("\n");
    const spawnTask = vi.fn((spawnerActorId: string, targetActorId: string, task: string, opts?: Record<string, unknown>) => ({
      runId: `${targetActorId}-run`,
      spawnerActorId,
      targetActorId,
      task,
      label: opts?.label,
      status: "running",
    }));
    const enqueueDeferredSpawnTask = vi.fn(() => ({ id: "queued-1" }));
    const dispatchDeferredSpawnTasks = vi.fn(() => 1);
    const actor = new AgentActor({
      id: "lead-queue-overflow",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-queue",
        recordDialogFlowEvent: vi.fn(),
        defaultProductMode: "dialog",
        spawnTask,
        getAll: () => [],
        get: () => null,
        enqueueDeferredSpawnTask,
        dispatchDeferredSpawnTasks,
        getActiveSpawnedTasks: vi.fn(() => []),
        getDialogSpawnConcurrencyLimit: vi.fn(() => 3),
        getSpawnedTasksSnapshot: vi.fn(() => []),
      } as never,
    });

    const actorAny = actor as unknown as { runWithInbox: (query: string) => Promise<string> };
    const result = await actorAny.runWithInbox(largeQuery);

    expect(result).toBe("done");
    expect(spawnTask).not.toHaveBeenCalled();
    expect(enqueueDeferredSpawnTask).not.toHaveBeenCalled();
    expect(dispatchDeferredSpawnTasks).not.toHaveBeenCalled();
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
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);
    const plannedDelegations = (manifest.targets ?? []).map((target, index) => ({
      id: `structured-delegation-${index + 1}`,
      targetActorId: `delivery-target-${target.id}`,
      targetActorName: target.dispatchSpec?.label ?? target.label,
      task: target.promptSpec?.objective ?? target.label,
      label: target.dispatchSpec?.label ?? target.label,
      roleBoundary: target.dispatchSpec?.roleBoundary ?? "executor",
      createIfMissing: true,
      overrides: {
        executionIntent: "content_executor",
        resultContract: "inline_structured_result" as const,
        deliveryTargetId: target.id,
        deliveryTargetLabel: target.label,
        sheetName: target.label,
      },
    }));
    const actor = new AgentActor({
      id: "lead-contract-manifest",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-contract-manifest",
        recordDialogFlowEvent: vi.fn(),
        defaultProductMode: "dialog",
        spawnTask,
        getAll: () => [],
        get: () => null,
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
          plannedDelegations,
          approvedAt: 1,
          state: "active",
          structuredDeliveryManifest: {
            ...manifest,
            source: "planner",
          },
        })),
      } as never,
    });

    const actorAny = actor as unknown as { runWithInbox: (query: string) => Promise<string> };
    const result = await actorAny.runWithInbox("请按合同执行并交付最终结果");

    expect(result).toBe("done");
    expect(spawnTask).not.toHaveBeenCalled();
  });

  it("builds a single workbook export plan from structured child results", () => {
    const structuredResults = [
      {
        runId: "run-1",
        subtaskId: "run-1",
        targetActorId: "worker-1",
        targetActorName: "结果清单生成（第1组）",
        deliveryTargetLabel: "结果清单",
        label: "结果清单生成（第1组）",
        task: "处理前 8 个条目",
        mode: "run",
        roleBoundary: "executor",
        profile: "executor",
        executionIntent: "content_executor",
        status: "completed",
        terminalResult: JSON.stringify([
          { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "AI应用开发工程化实战", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
          { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "智能体开发与知识库落地", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
          { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "大模型安全治理与测试", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
          { sourceItemId: "source-item-4", topicIndex: 4, topicTitle: "AI产品需求转化与方案设计", coverageType: "direct", 课程名称: "课程D", 课程介绍: "介绍D" },
          { sourceItemId: "source-item-5", topicIndex: 5, topicTitle: "AI产品运营增长与商业闭环", coverageType: "direct", 课程名称: "课程E", 课程介绍: "介绍E" },
          { sourceItemId: "source-item-6", topicIndex: 6, topicTitle: "银行AI解决方案咨询方法论", coverageType: "direct", 课程名称: "课程F", 课程介绍: "介绍F" },
          { sourceItemId: "source-item-7", topicIndex: 7, topicTitle: "数据分析与经营洞察实战", coverageType: "direct", 课程名称: "课程G", 课程介绍: "介绍G" },
          { sourceItemId: "source-item-8", topicIndex: 8, topicTitle: "全员AI办公赋能与协同提效", coverageType: "direct", 课程名称: "课程H", 课程介绍: "介绍H" },
        ]),
        startedAt: 1,
        completedAt: 2,
        timeoutSeconds: 600,
        eventCount: 3,
        resultKind: "structured_rows",
      },
      {
        runId: "run-2",
        subtaskId: "run-2",
        targetActorId: "worker-2",
        targetActorName: "结果清单生成（第2组）",
        deliveryTargetLabel: "结果清单",
        label: "结果清单生成（第2组）",
        task: "处理后 1 个条目",
        mode: "run",
        roleBoundary: "executor",
        profile: "executor",
        executionIntent: "content_executor",
        status: "completed",
        terminalResult: JSON.stringify([
          { sourceItemId: "source-item-9", topicIndex: 9, topicTitle: "AI通识与智能素养提升", coverageType: "direct", 课程名称: "课程I", 课程介绍: "介绍I" },
        ]),
        startedAt: 1,
        completedAt: 2,
        timeoutSeconds: 600,
        eventCount: 3,
        resultKind: "structured_rows",
      },
    ];
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);
    const strategy = resolveStructuredDeliveryStrategy(STRUCTURED_QUERY);
    const exportPlan = strategy?.buildHostExportPlan?.({
      taskText: STRUCTURED_QUERY,
      manifest,
      structuredResults,
    });

    expect(exportPlan).not.toBeNull();
    expect(exportPlan && "blocker" in exportPlan).toBe(false);
    if (!exportPlan || "blocker" in exportPlan) return;
    expect(exportPlan.toolInput).toEqual(expect.objectContaining({
      file_name: "source.xlsx",
      sheets: expect.arrayContaining([
        expect.objectContaining({
          name: "结果清单",
          headers: ["课程名称", "课程介绍"],
          rows: [
            ["课程A", "介绍A"],
            ["课程B", "介绍B"],
            ["课程C", "介绍C"],
            ["课程D", "介绍D"],
            ["课程E", "介绍E"],
            ["课程F", "介绍F"],
            ["课程G", "介绍G"],
            ["课程H", "介绍H"],
            ["课程I", "介绍I"],
          ],
        }),
      ]),
    }));
  });

  it("returns a repair plan when host export is blocked by missing topic coverage", () => {
    const structuredResults = [
      {
        runId: "run-1",
        subtaskId: "run-1",
        targetActorId: "worker-1",
        targetActorName: "结果清单生成（第1组）",
        deliveryTargetLabel: "结果清单",
        label: "结果清单生成（第1组）",
        task: "处理前 8 个条目",
        mode: "run",
        roleBoundary: "executor",
        profile: "executor",
        executionIntent: "content_executor",
        status: "completed",
        terminalResult: JSON.stringify([
          { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "AI应用开发工程化实战", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
          { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "智能体开发与知识库落地", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
          { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "大模型安全治理与测试", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
          { sourceItemId: "source-item-4", topicIndex: 4, topicTitle: "AI产品需求转化与方案设计", coverageType: "direct", 课程名称: "课程D", 课程介绍: "介绍D" },
          { sourceItemId: "source-item-5", topicIndex: 5, topicTitle: "AI产品运营增长与商业闭环", coverageType: "direct", 课程名称: "课程E", 课程介绍: "介绍E" },
          { sourceItemId: "source-item-6", topicIndex: 6, topicTitle: "银行AI解决方案咨询方法论", coverageType: "direct", 课程名称: "课程F", 课程介绍: "介绍F" },
          { sourceItemId: "source-item-7", topicIndex: 7, topicTitle: "数据分析与经营洞察实战", coverageType: "direct", 课程名称: "课程G", 课程介绍: "介绍G" },
          { sourceItemId: "source-item-8", topicIndex: 8, topicTitle: "全员AI办公赋能与协同提效", coverageType: "direct", 课程名称: "课程H", 课程介绍: "介绍H" },
        ]),
        startedAt: 1,
        completedAt: 2,
        timeoutSeconds: 600,
        eventCount: 3,
        resultKind: "structured_rows",
      },
    ];
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);
    const strategy = resolveStructuredDeliveryStrategy(STRUCTURED_QUERY);
    const exportPlan = strategy?.buildHostExportPlan?.({
      taskText: STRUCTURED_QUERY,
      manifest,
      structuredResults,
    });

    expect(exportPlan && "blocker" in exportPlan).toBe(true);
    if (!exportPlan || !("blocker" in exportPlan)) return;
    expect(exportPlan.blocker).toContain("missing_topics=9.AI通识与智能素养提升");
    expect(exportPlan.repairPlan).toEqual(expect.objectContaining({
      missingSourceItemIds: ["source-item-9"],
      missingThemes: ["AI通识与智能素养提升"],
      suggestions: [
        expect.objectContaining({
          label: expect.stringContaining("补派"),
          sourceItemIds: ["source-item-9"],
          missingThemes: ["AI通识与智能素养提升"],
        }),
      ],
    }));
  });

  it("auto-dispatches targeted repair shards before retrying deterministic host export", async () => {
    const artifacts: Array<Record<string, unknown>> = [];
    let activeInitial = true;
    let activeRepair = false;
    let repairSpawnDispatched = false;
    let deliveredInitialStructuredResult = false;
    let deliveredRepairStructuredResult = false;
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);
    const spawnTask = vi.fn((spawnerActorId: string, targetActorId: string, task: string, opts?: Record<string, unknown>) => {
      repairSpawnDispatched = true;
      activeRepair = true;
      return {
        runId: "run-child-auto-repair",
        spawnerActorId,
        targetActorId,
        task,
        label: opts?.label,
        status: "running",
      };
    });

    const actor = new AgentActor({
      id: "lead-host-export-auto-repair",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-export-auto-repair",
        recordDialogFlowEvent: vi.fn(),
        spawnTask,
        recordArtifact: vi.fn((artifact: Record<string, unknown>) => {
          artifacts.push(artifact);
        }),
        getArtifactRecordsSnapshot: () => artifacts as never,
        cancelPendingInteractionsForActor: () => undefined,
        getActiveExecutionContract: () => ({
          structuredDeliveryManifest: manifest,
        }),
        getActiveSpawnedTasks: () => {
          const activeTasks: Array<{ runId: string; spawnedAt: number; lastActiveAt: number }> = [];
          if (activeInitial) {
            activeTasks.push({
              runId: "run-child-1",
              spawnedAt: 1,
              lastActiveAt: Date.now(),
            });
          }
          if (activeRepair) {
            activeTasks.push({
              runId: "run-child-auto-repair",
              spawnedAt: 2,
              lastActiveAt: Date.now(),
            });
          }
          return activeTasks;
        },
        collectStructuredSpawnedTaskResults: () => {
          if (!activeInitial && !deliveredInitialStructuredResult) {
            deliveredInitialStructuredResult = true;
            return [{
              runId: "run-child-1",
              subtaskId: "run-child-1",
              targetActorId: "worker-1",
              targetActorName: "结果清单生成（第1组）",
              deliveryTargetLabel: "结果清单",
              label: "结果清单生成（第1组）",
              task: "处理前 8 个条目",
              mode: "run",
              roleBoundary: "executor",
              profile: "executor",
              executionIntent: "content_executor",
              status: "completed",
              terminalResult: JSON.stringify([
                { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "AI应用开发工程化实战", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
                { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "智能体开发与知识库落地", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
                { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "大模型安全治理与测试", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
                { sourceItemId: "source-item-4", topicIndex: 4, topicTitle: "AI产品需求转化与方案设计", coverageType: "direct", 课程名称: "课程D", 课程介绍: "介绍D" },
                { sourceItemId: "source-item-5", topicIndex: 5, topicTitle: "AI产品运营增长与商业闭环", coverageType: "direct", 课程名称: "课程E", 课程介绍: "介绍E" },
                { sourceItemId: "source-item-6", topicIndex: 6, topicTitle: "银行AI解决方案咨询方法论", coverageType: "direct", 课程名称: "课程F", 课程介绍: "介绍F" },
                { sourceItemId: "source-item-7", topicIndex: 7, topicTitle: "数据分析与经营洞察实战", coverageType: "direct", 课程名称: "课程G", 课程介绍: "介绍G" },
                { sourceItemId: "source-item-8", topicIndex: 8, topicTitle: "全员AI办公赋能与协同提效", coverageType: "direct", 课程名称: "课程H", 课程介绍: "介绍H" },
              ]),
              startedAt: 1,
              completedAt: 2,
              timeoutSeconds: 600,
              eventCount: 3,
              resultKind: "structured_rows",
            }];
          }
          if (repairSpawnDispatched && !activeRepair && deliveredInitialStructuredResult && !deliveredRepairStructuredResult) {
            deliveredRepairStructuredResult = true;
            return [{
              runId: "run-child-auto-repair",
              subtaskId: "run-child-auto-repair",
              targetActorId: "worker-repair",
              targetActorName: "结果清单补派（第2组修复）",
              deliveryTargetLabel: "结果清单",
              label: "结果清单补派（第2组修复）",
              task: "补齐缺失主题",
              mode: "run",
              roleBoundary: "executor",
              profile: "executor",
              executionIntent: "content_executor",
              status: "completed",
              terminalResult: JSON.stringify([
                { sourceItemId: "source-item-9", topicIndex: 9, topicTitle: "AI通识与智能素养提升", coverageType: "direct", 课程名称: "课程I", 课程介绍: "介绍I" },
              ]),
              startedAt: 1,
              completedAt: 2,
              timeoutSeconds: 600,
              eventCount: 3,
              resultKind: "structured_rows",
            }];
          }
          return [];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => ({ id, role: { name: id } }),
      } as never,
    });

    const actorAny = actor as unknown as {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => ({
      result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
      finalQuery: query,
    }));
    actorAny.waitForInbox = vi.fn(async () => {
      if (activeInitial) {
        activeInitial = false;
        return;
      }
      activeRepair = false;
    });

    const result = await actor.assignTask(STRUCTURED_QUERY, undefined, {
      publishResult: false,
    });

    expect(actorAny.runWithClarifications).toHaveBeenCalledTimes(1);
    expect(actorAny.waitForInbox).toHaveBeenCalledTimes(2);
    expect(spawnTask).toHaveBeenCalledTimes(1);
    expect(spawnTask.mock.calls[0]?.[1]).toContain("补派");
    expect(spawnTask.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      label: expect.stringContaining("补派"),
      roleBoundary: "executor",
      createIfMissing: true,
      overrides: expect.objectContaining({
        deliveryTargetLabel: "结果清单",
        sourceItemIds: ["source-item-9"],
        sourceItemCount: 1,
      }),
    }));
    expect(result.status).toBe("completed");
    expect(result.result).toContain("已导出 Excel 文件：/Users/demo/Downloads/source.xlsx");
  });

  it("prefers deterministic host export after structured waits even when the adapter is only suggested", async () => {
    const artifacts: Array<Record<string, unknown>> = [];
    let active = true;
    let deliveredStructuredResult = false;
    const publishResult = vi.fn();
    const recordArtifact = vi.fn((artifact: Record<string, unknown>) => {
      artifacts.push(artifact);
    });
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);

    expect(manifest.adapterEnabled).toBe(false);
    expect(manifest.recommendedStrategyId).toBe("dynamic_spreadsheet");

    const actor = new AgentActor({
      id: "lead-deterministic-host-export",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-deterministic-host-export",
        recordDialogFlowEvent: vi.fn(),
        publishResult,
        recordArtifact,
        getArtifactRecordsSnapshot: () => artifacts as never,
        cancelPendingInteractionsForActor: () => undefined,
        getActiveExecutionContract: () => ({
          structuredDeliveryManifest: manifest,
        }),
        getActiveSpawnedTasks: () => (active
          ? [{ runId: "run-child-1", spawnedAt: 1, lastActiveAt: Date.now() }]
          : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-1",
            subtaskId: "run-child-1",
            targetActorId: "worker-1",
            targetActorName: "结果清单生成（第1组）",
            deliveryTargetLabel: "结果清单",
            label: "结果清单生成（第1组）",
            task: "处理后 2 个条目",
            mode: "run",
            roleBoundary: "executor",
            profile: "executor",
            executionIntent: "content_executor",
            status: "completed",
            terminalResult: JSON.stringify([
              { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "AI应用开发工程化实战", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
              { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "智能体开发与知识库落地", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
              { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "大模型安全治理与测试", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
              { sourceItemId: "source-item-4", topicIndex: 4, topicTitle: "AI产品需求转化与方案设计", coverageType: "direct", 课程名称: "课程D", 课程介绍: "介绍D" },
              { sourceItemId: "source-item-5", topicIndex: 5, topicTitle: "AI产品运营增长与商业闭环", coverageType: "direct", 课程名称: "课程E", 课程介绍: "介绍E" },
              { sourceItemId: "source-item-6", topicIndex: 6, topicTitle: "银行AI解决方案咨询方法论", coverageType: "direct", 课程名称: "课程F", 课程介绍: "介绍F" },
              { sourceItemId: "source-item-7", topicIndex: 7, topicTitle: "数据分析与经营洞察实战", coverageType: "direct", 课程名称: "课程G", 课程介绍: "介绍G" },
              { sourceItemId: "source-item-8", topicIndex: 8, topicTitle: "全员AI办公赋能与协同提效", coverageType: "direct", 课程名称: "课程H", 课程介绍: "介绍H" },
              { sourceItemId: "source-item-9", topicIndex: 9, topicTitle: "AI通识与智能素养提升", coverageType: "direct", 课程名称: "课程I", 课程介绍: "介绍I" },
            ]),
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
            resultKind: "structured_rows",
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => (id === "worker-1"
          ? { id, role: { name: "结果清单生成（第1组）" } }
          : { id, role: { name: "Lead" } }),
      } as never,
    });

    const actorAny = actor as unknown as {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => ({
      result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
      finalQuery: query,
    }));
    actorAny.waitForInbox = vi.fn(async () => {
      active = false;
    });

    const result = await actor.assignTask(STRUCTURED_QUERY, undefined, {
      publishResult: false,
    });

    expect(actorAny.runWithClarifications).toHaveBeenCalledTimes(1);
    expect(actorAny.waitForInbox).toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.result).toContain("/Users/demo/Downloads/source.xlsx");
    expect(recordArtifact).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "lead-deterministic-host-export",
      path: "/Users/demo/Downloads/source.xlsx",
      toolName: "export_spreadsheet",
      source: "tool_write",
    }));
    expect(publishResult).not.toHaveBeenCalled();
  });

  it("does not treat completed zero-row spreadsheet results as deterministic host-export input", async () => {
    let active = true;
    let deliveredStructuredResult = false;
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);

    const actor = new AgentActor({
      id: "lead-host-export-zero-rows",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-export-zero-rows",
        recordDialogFlowEvent: vi.fn(),
        cancelPendingInteractionsForActor: () => undefined,
        getActiveExecutionContract: () => ({
          structuredDeliveryManifest: manifest,
        }),
        getActiveSpawnedTasks: () => (active
          ? [{ runId: "run-child-zero-rows", spawnedAt: 1, lastActiveAt: Date.now() }]
          : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-zero-rows",
            subtaskId: "run-child-zero-rows",
            targetActorId: "worker-zero-rows",
            targetActorName: "结果清单生成（第1组）",
            deliveryTargetLabel: "结果清单",
            label: "结果清单生成（第1组）",
            task: "处理前 8 个条目",
            mode: "run",
            roleBoundary: "executor",
            profile: "executor",
            executionIntent: "content_executor",
            status: "completed",
            terminalResult: "已处理 8 个主题，建议后续统一导出 Excel。",
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
            resultKind: "blocker",
            rowCount: 8,
            blocker: "当前子任务声明为 inline_structured_result，但没有返回任何结构化 rows。",
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        getArtifactRecordsSnapshot: () => [],
        get: (id: string) => ({ id, role: { name: id } }),
      } as never,
    });

    const actorAny = actor as unknown as {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => {
      if (query === STRUCTURED_QUERY) {
        return {
          result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
          finalQuery: query,
        };
      }
      return {
        result: "执行计划：先补派缺失主题，再汇总后导出 Excel。",
        finalQuery: query,
      };
    });
    actorAny.waitForInbox = vi.fn(async () => {
      active = false;
    });

    const result = await actor.assignTask(STRUCTURED_QUERY, undefined, {
      publishResult: false,
    });

    expect(actorAny.runWithClarifications).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    expect(result.result).toContain("阻塞原因");
    expect(result.result).not.toContain("已导出 Excel 文件");
  });

  it("converts plan-like spreadsheet repair replies into explicit blockers", async () => {
    let active = true;
    let deliveredStructuredResult = false;
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);

    const actor = new AgentActor({
      id: "lead-host-export-plan-guard",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-export-plan-guard",
        recordDialogFlowEvent: vi.fn(),
        cancelPendingInteractionsForActor: () => undefined,
        getActiveExecutionContract: () => ({
          structuredDeliveryManifest: manifest,
        }),
        getActiveSpawnedTasks: () => (active
          ? [{ runId: "run-child-plan-guard", spawnedAt: 1, lastActiveAt: Date.now() }]
          : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-plan-guard",
            subtaskId: "run-child-plan-guard",
            targetActorId: "worker-plan-guard",
            targetActorName: "结果清单生成（第1组）",
            deliveryTargetLabel: "结果清单",
            label: "结果清单生成（第1组）",
            task: "处理前 8 个条目",
            mode: "run",
            roleBoundary: "executor",
            profile: "executor",
            executionIntent: "content_executor",
            status: "completed",
            terminalResult: JSON.stringify([
              { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "AI应用开发工程化实战", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
              { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "智能体开发与知识库落地", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
              { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "大模型安全治理与测试", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
              { sourceItemId: "source-item-4", topicIndex: 4, topicTitle: "AI产品需求转化与方案设计", coverageType: "direct", 课程名称: "课程D", 课程介绍: "介绍D" },
              { sourceItemId: "source-item-5", topicIndex: 5, topicTitle: "AI产品运营增长与商业闭环", coverageType: "direct", 课程名称: "课程E", 课程介绍: "介绍E" },
              { sourceItemId: "source-item-6", topicIndex: 6, topicTitle: "银行AI解决方案咨询方法论", coverageType: "direct", 课程名称: "课程F", 课程介绍: "介绍F" },
              { sourceItemId: "source-item-7", topicIndex: 7, topicTitle: "数据分析与经营洞察实战", coverageType: "direct", 课程名称: "课程G", 课程介绍: "介绍G" },
              { sourceItemId: "source-item-8", topicIndex: 8, topicTitle: "全员AI办公赋能与协同提效", coverageType: "direct", 课程名称: "课程H", 课程介绍: "介绍H" },
            ]),
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
            resultKind: "structured_rows",
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        getArtifactRecordsSnapshot: () => [],
        get: (id: string) => ({ id, role: { name: id } }),
      } as never,
    });

    const actorAny = actor as unknown as {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => {
      if (query === STRUCTURED_QUERY) {
        return {
          result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
          finalQuery: query,
        };
      }
      return {
        result: [
          "执行计划：",
          "1. 先补派缺失主题 repair shard",
          "2. 汇总全部结构化结果后再导出 Excel",
        ].join("\n"),
        finalQuery: query,
      };
    });
    actorAny.waitForInbox = vi.fn(async () => {
      active = false;
    });

    const result = await actor.assignTask(STRUCTURED_QUERY, undefined, {
      publishResult: false,
    });

    expect(result.status).toBe("completed");
    expect(result.result).toContain("阻塞原因");
    expect(result.result).not.toContain("执行计划");
  });

  it("injects repair guidance into final synthesis when host export is blocked", async () => {
    let active = true;
    let deliveredStructuredResult = false;
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);

    const actor = new AgentActor({
      id: "lead-host-export-repair-guidance",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-export-repair-guidance",
        recordDialogFlowEvent: vi.fn(),
        cancelPendingInteractionsForActor: () => undefined,
        getActiveExecutionContract: () => ({
          structuredDeliveryManifest: manifest,
        }),
        getActiveSpawnedTasks: () => (active
          ? [{ runId: "run-child-repair", spawnedAt: 1, lastActiveAt: Date.now() }]
          : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-repair",
            subtaskId: "run-child-repair",
            targetActorId: "worker-repair",
            targetActorName: "结果清单生成（第1组）",
            deliveryTargetLabel: "结果清单",
            label: "结果清单生成（第1组）",
            task: "处理前 8 个条目",
            mode: "run",
            roleBoundary: "executor",
            profile: "executor",
            executionIntent: "content_executor",
            status: "completed",
            terminalResult: JSON.stringify([
              { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "AI应用开发工程化实战", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
              { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "智能体开发与知识库落地", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
              { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "大模型安全治理与测试", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
              { sourceItemId: "source-item-4", topicIndex: 4, topicTitle: "AI产品需求转化与方案设计", coverageType: "direct", 课程名称: "课程D", 课程介绍: "介绍D" },
              { sourceItemId: "source-item-5", topicIndex: 5, topicTitle: "AI产品运营增长与商业闭环", coverageType: "direct", 课程名称: "课程E", 课程介绍: "介绍E" },
              { sourceItemId: "source-item-6", topicIndex: 6, topicTitle: "银行AI解决方案咨询方法论", coverageType: "direct", 课程名称: "课程F", 课程介绍: "介绍F" },
              { sourceItemId: "source-item-7", topicIndex: 7, topicTitle: "数据分析与经营洞察实战", coverageType: "direct", 课程名称: "课程G", 课程介绍: "介绍G" },
              { sourceItemId: "source-item-8", topicIndex: 8, topicTitle: "全员AI办公赋能与协同提效", coverageType: "direct", 课程名称: "课程H", 课程介绍: "介绍H" },
            ]),
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
            resultKind: "structured_rows",
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        getArtifactRecordsSnapshot: () => [],
        get: (id: string) => ({ id, role: { name: id } }),
      } as never,
    });

    const actorAny = actor as unknown as {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => {
      if (query === STRUCTURED_QUERY) {
        return {
          result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
          finalQuery: query,
        };
      }
      return {
        result: "阻塞原因：仍缺少 AI通识与智能素养提升 主题对应的结构化结果，建议补派 repair shard 后再导出。",
        finalQuery: query,
      };
    });
    actorAny.waitForInbox = vi.fn(async () => {
      active = false;
    });

    const result = await actor.assignTask(STRUCTURED_QUERY, undefined, {
      publishResult: false,
    });

    expect(actorAny.runWithClarifications).toHaveBeenCalledTimes(2);
    expect(actorAny.runWithClarifications.mock.calls[1]?.[0]).toContain("## 系统建议的修复路径");
    expect(actorAny.runWithClarifications.mock.calls[1]?.[0]).toContain("AI通识与智能素养提升");
    expect(actorAny.runWithClarifications.mock.calls[1]?.[0]).toContain("补派");
    expect(result.status).toBe("completed");
    expect(result.result).toContain("阻塞原因");
  });

  it("does not overwrite a deterministic host export with takeover synthesis when stale child runs were aborted", async () => {
    const artifacts: Array<Record<string, unknown>> = [];
    let active = true;
    let deliveredStructuredResults = false;
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);

    const actor = new AgentActor({
      id: "lead-host-export-survives-takeover",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-export-survives-takeover",
        recordDialogFlowEvent: vi.fn(),
        recordArtifact: vi.fn((artifact: Record<string, unknown>) => {
          artifacts.push(artifact);
        }),
        getArtifactRecordsSnapshot: () => artifacts as never,
        cancelPendingInteractionsForActor: () => undefined,
        getActiveExecutionContract: () => ({
          structuredDeliveryManifest: manifest,
        }),
        getActiveSpawnedTasks: () => (active
          ? [{ runId: "run-child-active", spawnedAt: 1, lastActiveAt: Date.now() }]
          : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResults) return [];
          deliveredStructuredResults = true;
          return [
            {
              runId: "run-child-aborted",
              subtaskId: "run-child-aborted",
              targetActorId: "worker-old",
              targetActorName: "结果清单生成（旧批次）",
              deliveryTargetLabel: "结果清单",
              label: "结果清单生成（旧批次）",
              task: "旧批次",
              mode: "run",
              roleBoundary: "executor",
              profile: "executor",
              executionIntent: "content_executor",
              status: "aborted",
              terminalError: "主 Agent 已退出，终止遗留子任务：API 错误",
              startedAt: 1,
              completedAt: 2,
              timeoutSeconds: 600,
              eventCount: 2,
              resultKind: "blocker",
            },
            {
              runId: "run-child-completed",
              subtaskId: "run-child-completed",
              targetActorId: "worker-new",
              targetActorName: "结果清单生成（重派）",
              deliveryTargetLabel: "结果清单",
              label: "结果清单生成（重派）",
              task: "重派批次",
              mode: "run",
              roleBoundary: "executor",
              profile: "executor",
              executionIntent: "content_executor",
              status: "completed",
              terminalResult: JSON.stringify([
                { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "AI应用开发工程化实战", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
                { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "智能体开发与知识库落地", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
                { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "大模型安全治理与测试", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
                { sourceItemId: "source-item-4", topicIndex: 4, topicTitle: "AI产品需求转化与方案设计", coverageType: "direct", 课程名称: "课程D", 课程介绍: "介绍D" },
                { sourceItemId: "source-item-5", topicIndex: 5, topicTitle: "AI产品运营增长与商业闭环", coverageType: "direct", 课程名称: "课程E", 课程介绍: "介绍E" },
                { sourceItemId: "source-item-6", topicIndex: 6, topicTitle: "银行AI解决方案咨询方法论", coverageType: "direct", 课程名称: "课程F", 课程介绍: "介绍F" },
                { sourceItemId: "source-item-7", topicIndex: 7, topicTitle: "数据分析与经营洞察实战", coverageType: "direct", 课程名称: "课程G", 课程介绍: "介绍G" },
                { sourceItemId: "source-item-8", topicIndex: 8, topicTitle: "全员AI办公赋能与协同提效", coverageType: "direct", 课程名称: "课程H", 课程介绍: "介绍H" },
                { sourceItemId: "source-item-9", topicIndex: 9, topicTitle: "AI通识与智能素养提升", coverageType: "direct", 课程名称: "课程I", 课程介绍: "介绍I" },
              ]),
              startedAt: 1,
              completedAt: 2,
              timeoutSeconds: 600,
              eventCount: 3,
              resultKind: "structured_rows",
            },
          ];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => ({ id, role: { name: id } }),
      } as never,
    });

    const actorAny = actor as unknown as {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => ({
      result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
      finalQuery: query,
    }));
    actorAny.waitForInbox = vi.fn(async () => {
      active = false;
    });

    const result = await actor.assignTask(STRUCTURED_QUERY, undefined, {
      publishResult: false,
    });

    expect(actorAny.runWithClarifications).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("completed");
    expect(result.result).toContain("已导出 Excel 文件：/Users/demo/Downloads/source.xlsx");
  });

  it("keeps the task completed when publishResult fails after deterministic host export succeeds", async () => {
    const artifacts: Array<Record<string, unknown>> = [];
    let active = true;
    let deliveredStructuredResult = false;
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);
    const publishResult = vi.fn(() => {
      throw new Error("publish channel unavailable");
    });

    const actor = new AgentActor({
      id: "lead-host-export-success-lock",
      role: { name: "Lead", systemPrompt: "You are lead." },
      capabilities: ["general_task"],
      workspace: "/Users/demo/project",
    }, {
      actorSystem: {
        sessionId: "session-host-export-success-lock",
        recordDialogFlowEvent: vi.fn(),
        publishResult,
        recordArtifact: vi.fn((artifact: Record<string, unknown>) => {
          artifacts.push(artifact);
        }),
        getArtifactRecordsSnapshot: () => artifacts as never,
        cancelPendingInteractionsForActor: () => undefined,
        getActiveExecutionContract: () => ({
          structuredDeliveryManifest: manifest,
        }),
        getActiveSpawnedTasks: () => (active
          ? [{ runId: "run-child-lock", spawnedAt: 1, lastActiveAt: Date.now() }]
          : []),
        collectStructuredSpawnedTaskResults: () => {
          if (active || deliveredStructuredResult) return [];
          deliveredStructuredResult = true;
          return [{
            runId: "run-child-lock",
            subtaskId: "run-child-lock",
            targetActorId: "worker-lock",
            targetActorName: "结果清单生成（第1组）",
            deliveryTargetLabel: "结果清单",
            label: "结果清单生成（第1组）",
            task: "处理全部条目",
            mode: "run",
            roleBoundary: "executor",
            profile: "executor",
            executionIntent: "content_executor",
            status: "completed",
            terminalResult: JSON.stringify([
              { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "AI应用开发工程化实战", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
              { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "智能体开发与知识库落地", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
              { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "大模型安全治理与测试", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
              { sourceItemId: "source-item-4", topicIndex: 4, topicTitle: "AI产品需求转化与方案设计", coverageType: "direct", 课程名称: "课程D", 课程介绍: "介绍D" },
              { sourceItemId: "source-item-5", topicIndex: 5, topicTitle: "AI产品运营增长与商业闭环", coverageType: "direct", 课程名称: "课程E", 课程介绍: "介绍E" },
              { sourceItemId: "source-item-6", topicIndex: 6, topicTitle: "银行AI解决方案咨询方法论", coverageType: "direct", 课程名称: "课程F", 课程介绍: "介绍F" },
              { sourceItemId: "source-item-7", topicIndex: 7, topicTitle: "数据分析与经营洞察实战", coverageType: "direct", 课程名称: "课程G", 课程介绍: "介绍G" },
              { sourceItemId: "source-item-8", topicIndex: 8, topicTitle: "全员AI办公赋能与协同提效", coverageType: "direct", 课程名称: "课程H", 课程介绍: "介绍H" },
              { sourceItemId: "source-item-9", topicIndex: 9, topicTitle: "AI通识与智能素养提升", coverageType: "direct", 课程名称: "课程I", 课程介绍: "介绍I" },
            ]),
            startedAt: 1,
            completedAt: 2,
            timeoutSeconds: 600,
            eventCount: 3,
            resultKind: "structured_rows",
          }];
        },
        getSpawnedTasksSnapshot: () => [],
        get: (id: string) => ({ id, role: { name: id } }),
      } as never,
    });

    const actorAny = actor as unknown as {
      runWithClarifications: ReturnType<typeof vi.fn>;
      waitForInbox: ReturnType<typeof vi.fn>;
    };
    actorAny.runWithClarifications = vi.fn(async (query: string) => ({
      result: WAIT_FOR_SPAWNED_TASKS_DEFERRED_RESULT,
      finalQuery: query,
    }));
    actorAny.waitForInbox = vi.fn(async () => {
      active = false;
    });

    const result = await actor.assignTask(STRUCTURED_QUERY);

    expect(result.status).toBe("completed");
    expect(result.successLocked).toBe(true);
    expect(result.successArtifactPath).toBe("/Users/demo/Downloads/source.xlsx");
    expect(result.result).toContain("已导出 Excel 文件：/Users/demo/Downloads/source.xlsx");
    expect(publishResult).toHaveBeenCalledTimes(1);
  });
});
