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
      worker_profile: "review_worker",
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
          workerProfileId: "review_worker",
          toolPolicy: {
            allow: ["read_file", "search"],
          },
        }),
      }),
    );
  });

  it("auto-enables implicit fork for spawn_task when the named target does not exist", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-implicit-fork-1",
      mode: "run" as const,
      label: "课程整理",
      targetActorId: "spawned-course-worker",
      roleBoundary: "executor" as const,
      workerProfileId: "content_worker" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
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
      target_agent: "课程整理员",
      task: "基于当前附件整理课程清单并返回结构化结果",
      worker_profile: "content_worker",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "课程整理员",
      "基于当前附件整理课程清单并返回结构化结果",
      expect.objectContaining({
        createIfMissing: true,
        overrides: expect.objectContaining({
          workerProfileId: "content_worker",
        }),
      }),
    );
  });

  it("applies builtin specialized-agent defaults for spawn_task", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-builtin-1",
      mode: "run" as const,
      label: "独立验证",
      targetActorId: "spawned-verifier",
      roleBoundary: "validator" as const,
      workerProfileId: "validator_worker" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-verifier") return { id, role: { name: "Verifier" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    const result = await spawnTool.execute({
      task: "独立验证本轮改动是否真的修复了报错，并给出回归结论",
      label: "独立验证",
      builtin_agent: "verification_agent",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "Verifier",
      "独立验证本轮改动是否真的修复了报错，并给出回归结论",
      expect.objectContaining({
        label: "独立验证",
        createIfMissing: true,
        roleBoundary: "validator",
        createChildSpec: expect.objectContaining({
          description: expect.stringContaining("独立验证实现结果"),
          capabilities: expect.arrayContaining(["testing", "debugging"]),
        }),
        overrides: expect.objectContaining({
          workerProfileId: "validator_worker",
          maxIterations: 18,
          thinkingLevel: "medium",
          systemPromptAppend: expect.stringContaining("built-in verification agent"),
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      spawned: true,
      builtin_agent: "verification_agent",
      worker_profile: "validator_worker",
      role_boundary: "validator",
    }));
  });

  it("applies builtin spreadsheet-generation defaults for spawn_task", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-builtin-sheet-1",
      mode: "run" as const,
      label: "生成表格行",
      targetActorId: "spawned-sheet-generator",
      roleBoundary: "executor" as const,
      workerProfileId: "spreadsheet_worker" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-sheet-generator") return { id, role: { name: "Spreadsheet Generator" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    const result = await spawnTool.execute({
      task: "把候选主题整理成结构化 rows，供主线程统一汇总",
      label: "生成表格行",
      builtin_agent: "spreadsheet_generation_agent",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "Spreadsheet Generator",
      "把候选主题整理成结构化 rows，供主线程统一汇总",
      expect.objectContaining({
        label: "生成表格行",
        createIfMissing: true,
        roleBoundary: "executor",
        createChildSpec: expect.objectContaining({
          description: expect.stringContaining("结构化表格 rows"),
          capabilities: expect.arrayContaining(["data_analysis", "synthesis"]),
        }),
        overrides: expect.objectContaining({
          workerProfileId: "spreadsheet_worker",
          resultContract: "inline_structured_result",
          maxIterations: 20,
          thinkingLevel: "medium",
          systemPromptAppend: expect.stringContaining("built-in spreadsheet generation agent"),
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      spawned: true,
      builtin_agent: "spreadsheet_generation_agent",
      worker_profile: "spreadsheet_worker",
      role_boundary: "executor",
    }));
  });

  it("rejects aggregate workbook delegation under single_workbook contracts", async () => {
    const spawnTask = vi.fn();
    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
      getActiveExecutionContract: () => ({
        contractId: "contract-sheet-1",
        structuredDeliveryManifest: {
          source: "strategy" as const,
          deliveryContract: "spreadsheet" as const,
          parentContract: "single_workbook" as const,
          requiresSpreadsheetOutput: true,
          applyInitialIsolation: true,
          adapterEnabled: false,
        },
      }),
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    const result = await spawnTool.execute({
      task: "整合所有 AI 培训课程并生成 Excel 文件，收集全部子任务结果后输出最终工作簿",
      worker_profile: "spreadsheet_worker",
    });

    expect(spawnTask).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      spawned: false,
      error: expect.stringContaining("禁止再委派"),
    }));
  });

  it("derives a temporary agent target from the label when create_if_missing omits target_agent", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-derive-target-1",
      mode: "run" as const,
      label: "技术方向课程生成",
      targetActorId: "spawned-tech-worker",
      roleBoundary: "executor" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-tech-worker") return { id, role: { name: "技术方向课程生成" } };
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
      task: "基于技术方向主题生成课程名称和课程介绍",
      label: "技术方向课程生成",
      create_if_missing: true,
      role_boundary: "executor",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "技术方向课程生成",
      "基于技术方向主题生成课程名称和课程介绍",
      expect.objectContaining({
        label: "技术方向课程生成",
        createIfMissing: true,
        roleBoundary: "executor",
      }),
    );
  });

  it("returns structured task metadata for spawn_task", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-structured-1",
      mode: "run" as const,
      label: "并行验证",
      targetActorId: "validator",
      roleBoundary: "validator" as const,
      workerProfileId: "validator_worker" as const,
      runtime: {
        subtaskId: "run-structured-1",
        profile: "validator" as const,
        startedAt: 1,
        timeoutSeconds: 600,
        eventCount: 1,
      },
    }));

    const system = {
      get: (id: string) => ({ id, role: { name: id === "validator" ? "Validator" : "Coordinator" } }),
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    const result = await spawnTool.execute({
      target_agent: "validator",
      task: "执行回归验证",
      role_boundary: "validator",
    });

    expect(result).toEqual(expect.objectContaining({
      spawned: true,
      task_id: "run-structured-1",
      subtask_id: "run-structured-1",
      profile: "validator",
      worker_profile: "validator_worker",
      role_boundary: "validator",
      runId: "run-structured-1",
    }));
  });

  it("builds a higher-level delegation prompt for delegate_task", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-delegate-1",
      mode: "run" as const,
      label: "技术方向课程生成",
      targetActorId: "spawned-tech-worker",
      roleBoundary: "executor" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-tech-worker") return { id, role: { name: "技术方向课程生成" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const delegateTool = tools.find((tool) => tool.name === "delegate_task");

    expect(delegateTool).toBeTruthy();
    if (!delegateTool) return;

    const result = await delegateTool.execute({
      goal: "围绕技术方向主题生成课程名称和课程介绍",
      acceptance: "- 每个主题至少给出一门课程\n- 返回结构化结果，不写文件",
      label: "技术方向课程生成",
      create_if_missing: true,
      role_boundary: "executor",
      worker_profile: "spreadsheet_worker",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "技术方向课程生成",
      expect.stringContaining("## 任务目标"),
      expect.objectContaining({
        label: "技术方向课程生成",
        createIfMissing: true,
        roleBoundary: "executor",
        overrides: expect.objectContaining({
          workerProfileId: "spreadsheet_worker",
        }),
      }),
    );
    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "技术方向课程生成",
      expect.stringContaining("## 验收标准"),
      expect.any(Object),
    );
    expect(result).toEqual(expect.objectContaining({
      delegated: true,
      interface: "delegate_task",
      task_id: "run-delegate-1",
    }));
  });

  it("passes builtin specialized-agent defaults through delegate_task", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-delegate-plan-1",
      mode: "run" as const,
      label: "先出执行计划",
      targetActorId: "spawned-planner",
      roleBoundary: "general" as const,
      workerProfileId: "general_worker" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-planner") return { id, role: { name: "Planner" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const delegateTool = tools.find((tool) => tool.name === "delegate_task");

    expect(delegateTool).toBeTruthy();
    if (!delegateTool) return;

    const result = await delegateTool.execute({
      goal: "先把这轮改动拆成执行顺序、风险和依赖，再告诉我建议的 next step",
      label: "先出执行计划",
      builtin_agent: "plan_agent",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "Planner",
      expect.stringContaining("## 验收标准"),
      expect.objectContaining({
        roleBoundary: "general",
        createIfMissing: true,
        createChildSpec: expect.objectContaining({
          description: expect.stringContaining("拆解目标"),
        }),
        overrides: expect.objectContaining({
          workerProfileId: "general_worker",
          maxIterations: 14,
          thinkingLevel: "high",
          systemPromptAppend: expect.stringContaining("built-in plan agent"),
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      delegated: true,
      builtin_agent: "plan_agent",
      task_id: "run-delegate-plan-1",
    }));
  });

  it("infers spreadsheet-style delegation defaults when delegate_task omits worker settings", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-delegate-2",
      mode: "run" as const,
      label: "结果清单生成",
      targetActorId: "spawned-sheet-worker",
      roleBoundary: "executor" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-sheet-worker") return { id, role: { name: "结果清单生成" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const delegateTool = tools.find((tool) => tool.name === "delegate_task");

    expect(delegateTool).toBeTruthy();
    if (!delegateTool) return;

    const result = await delegateTool.execute({
      goal: "根据附件里的主题整理课程清单，最终用于 Excel 汇总",
      label: "结果清单生成",
      create_if_missing: true,
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "结果清单生成",
      expect.stringContaining("每行只绑定 1 个 `sourceItemId`"),
      expect.objectContaining({
        roleBoundary: "executor",
        overrides: expect.objectContaining({
          workerProfileId: "spreadsheet_worker",
          resultContract: "inline_structured_result",
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      delegated: true,
      inferred_role_boundary: "executor",
      inferred_worker_profile: "spreadsheet_worker",
      result_contract: "inline_structured_result",
    }));
  });

  it("inherits spreadsheet delivery context from the parent task even when the child goal omits excel wording", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-delegate-parent-sheet",
      mode: "run" as const,
      label: "技术研发方向课程生成",
      targetActorId: "spawned-tech-sheet-worker",
      roleBoundary: "executor" as const,
    }));

    const parentQuery = [
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

    const system = {
      get: (id: string) => {
        if (id === "coordinator") {
          return {
            id,
            role: { name: "Coordinator" },
            currentTask: { query: parentQuery },
          };
        }
        if (id === "spawned-tech-sheet-worker") {
          return { id, role: { name: "技术研发方向课程生成" } };
        }
        return undefined;
      },
      getAll: () => [],
      getActiveExecutionContract: () => null,
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const delegateTool = tools.find((tool) => tool.name === "delegate_task");

    expect(delegateTool).toBeTruthy();
    if (!delegateTool) return;

    const result = await delegateTool.execute({
      goal: "基于这批主题，从技术研发维度生成 10 门课程。",
      label: "技术研发方向课程生成",
      create_if_missing: true,
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "技术研发方向课程生成",
      expect.any(String),
      expect.objectContaining({
        roleBoundary: "executor",
        overrides: expect.objectContaining({
          workerProfileId: "spreadsheet_worker",
          resultContract: "inline_structured_result",
          sourceItemCount: 9,
          sourceItemIds: [
            "source-item-1",
            "source-item-2",
            "source-item-3",
            "source-item-4",
            "source-item-5",
            "source-item-6",
            "source-item-7",
            "source-item-8",
            "source-item-9",
          ],
          scopedSourceItems: expect.arrayContaining([
            expect.objectContaining({ id: "source-item-1", topicTitle: "AI应用开发工程化实战" }),
            expect.objectContaining({ id: "source-item-9", topicTitle: "AI通识与智能素养提升" }),
          ]),
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      delegated: true,
      inferred_worker_profile: "spreadsheet_worker",
      result_contract: "inline_structured_result",
    }));
  });

  it("queues spreadsheet-style delegate_task requests when child concurrency is full", async () => {
    const spawnTool = vi.fn(async (params: Record<string, unknown>) => {
      if (params.__queue_if_busy === true) {
        return {
          spawned: false,
          queued: true,
          dispatch_status: "queued",
          queue_id: "queued-delegate-1",
          pending_dispatch_count: 2,
          profile: "executor",
          worker_profile: "spreadsheet_worker",
          role_boundary: "executor",
        };
      }
      return { error: "unexpected" };
    });

    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getDialogSpawnConcurrencyLimit: () => 3,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const delegateTool = tools.find((tool) => tool.name === "delegate_task");
    const actualSpawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(delegateTool).toBeTruthy();
    expect(actualSpawnTool).toBeTruthy();
    if (!delegateTool || !actualSpawnTool) return;

    actualSpawnTool.execute = spawnTool as any;

    const result = await delegateTool.execute({
      goal: "根据附件里的主题整理课程清单，最终给我一个 Excel 文件",
      label: "结果清单生成",
      create_if_missing: true,
    });

    expect(spawnTool).toHaveBeenCalledWith(expect.objectContaining({
      worker_profile: "spreadsheet_worker",
      __queue_if_busy: true,
      __spawn_limit: 3,
      resultContract: "inline_structured_result",
    }));
    expect(result).toEqual(expect.objectContaining({
      delegated: true,
      queued: true,
      dispatch_status: "queued",
      worker_profile: "spreadsheet_worker",
      result_contract: "inline_structured_result",
    }));
  });

  it("auto-enables create_if_missing for delegate_task when no target is provided", async () => {
    const spawnTask = vi.fn(() => ({
      runId: "run-delegate-auto-create",
      mode: "run" as const,
      label: "课程主题拆分",
      targetActorId: "spawned-course-worker",
      roleBoundary: "executor" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "spawned-course-worker") return { id, role: { name: "课程主题拆分" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const delegateTool = tools.find((tool) => tool.name === "delegate_task");

    expect(delegateTool).toBeTruthy();
    if (!delegateTool) return;

    const result = await delegateTool.execute({
      goal: "按课程主题拆分并生成多组课程候选结果",
      label: "课程主题拆分",
    });

    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "课程主题拆分",
      expect.stringContaining("## 任务目标"),
      expect.objectContaining({
        label: "课程主题拆分",
        createIfMissing: true,
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      delegated: true,
      auto_create_if_missing: true,
      interface: "delegate_task",
    }));
  });

  it("auto-enables delegate_task implicit fork when target is missing", async () => {
    const spawnTask = vi.fn().mockReturnValue({
      runId: "run-delegate-retry",
      mode: "run" as const,
      label: "AI 应用开发课程组",
      targetActorId: "ai-app-course-worker",
      roleBoundary: "executor" as const,
    });

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        if (id === "ai-app-course-worker") return { id, role: { name: "AI 应用开发课程组" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const delegateTool = tools.find((tool) => tool.name === "delegate_task");

    expect(delegateTool).toBeTruthy();
    if (!delegateTool) return;

    const result = await delegateTool.execute({
      goal: "围绕 AI 应用开发主题生成课程名称与课程介绍",
      target_agent: "AI 应用开发课程组",
    });

    expect(spawnTask).toHaveBeenCalledTimes(1);
    expect(spawnTask).toHaveBeenCalledWith(
      "coordinator",
      "AI 应用开发课程组",
      expect.stringContaining("## 任务目标"),
      expect.objectContaining({
        createIfMissing: true,
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      delegated: true,
      auto_create_if_missing: true,
      interface: "delegate_task",
      task_id: "run-delegate-retry",
    }));
  });

  it("lets the lead explicitly engage a recommended delivery adapter", async () => {
    const engageStructuredDeliveryAdapter = vi.fn();
    const system = {
      get: (id: string) => {
        if (id === "coordinator") {
          return {
            id,
            role: { name: "Coordinator" },
            currentTask: {
              query: "根据附件生成课程清单，最终给我一个 Excel 文件",
            },
            getEngagedStructuredDeliveryManifest: () => null,
            engageStructuredDeliveryAdapter,
          };
        }
        return undefined;
      },
      getAll: () => [],
      getActiveExecutionContract: () => null,
      getSpawnedTasksSnapshot: () => [],
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const engageTool = tools.find((tool) => tool.name === "engage_delivery_adapter");

    expect(engageTool).toBeTruthy();
    if (!engageTool) return;

    const result = await engageTool.execute({});

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      adapter_enabled: true,
      strategy_id: "dynamic_spreadsheet",
    }));
    expect(engageStructuredDeliveryAdapter).toHaveBeenCalledWith(expect.objectContaining({
      source: "runtime",
      adapterEnabled: true,
      strategyId: "dynamic_spreadsheet",
      recommendedStrategyId: "dynamic_spreadsheet",
    }));
  });

  it("queues overflow spawn_task requests instead of dropping them", async () => {
    const spawnTask = vi.fn();
    const enqueueDeferredSpawnTask = vi.fn(() => ({
      id: "queued-1",
      profile: "executor" as const,
      roleBoundary: "executor" as const,
      mode: "run" as const,
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
      getActiveSpawnedTasks: () => ([
        { runId: "run-a" },
        { runId: "run-b" },
        { runId: "run-c" },
      ]),
      getPendingDeferredSpawnTaskCount: vi.fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      enqueueDeferredSpawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    const result = await spawnTool.execute({
      target_agent: "executor",
      task: "补齐剩余课程分组",
      role_boundary: "executor",
      __queue_if_busy: true,
      __spawn_limit: 3,
    });

    expect(enqueueDeferredSpawnTask).toHaveBeenCalledWith(
      "coordinator",
      "executor",
      "补齐剩余课程分组",
      expect.objectContaining({
        roleBoundary: "executor",
      }),
    );
    expect(spawnTask).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      spawned: false,
      queued: true,
      dispatch_status: "queued",
      queue_id: "queued-1",
      pending_dispatch_count: 1,
      profile: "executor",
      role_boundary: "executor",
    }));
  });

  it("auto-queues implicit content-worker spawn_task requests when concurrency is full", async () => {
    const spawnTask = vi.fn();
    const enqueueDeferredSpawnTask = vi.fn(() => ({
      id: "queued-content-1",
      profile: "executor" as const,
      roleBoundary: "executor" as const,
      mode: "run" as const,
      overrides: {
        workerProfileId: "content_worker" as const,
      },
    }));

    const system = {
      get: (id: string) => {
        if (id === "coordinator") return { id, role: { name: "Coordinator" } };
        return undefined;
      },
      getAll: () => [],
      spawnTask,
      getActiveSpawnedTasks: () => ([
        { runId: "run-a" },
        { runId: "run-b" },
        { runId: "run-c" },
      ]),
      getPendingDeferredSpawnTaskCount: vi.fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      getDialogSpawnConcurrencyLimit: () => 3,
      enqueueDeferredSpawnTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const spawnTool = tools.find((tool) => tool.name === "spawn_task");

    expect(spawnTool).toBeTruthy();
    if (!spawnTool) return;

    const result = await spawnTool.execute({
      target_agent: "课程整理员",
      task: "根据 source shard 产出课程 rows",
      worker_profile: "content_worker",
    });

    expect(enqueueDeferredSpawnTask).toHaveBeenCalledWith(
      "coordinator",
      "课程整理员",
      "根据 source shard 产出课程 rows",
      expect.objectContaining({
        createIfMissing: true,
        overrides: expect.objectContaining({
          workerProfileId: "content_worker",
        }),
      }),
    );
    expect(spawnTask).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      spawned: false,
      queued: true,
      dispatch_status: "queued",
      queue_id: "queued-content-1",
      pending_dispatch_count: 1,
      worker_profile: "content_worker",
      role_boundary: "executor",
    }));
  });

  it("returns structured runtime state for wait_for_spawned_tasks", async () => {
    const buildWaitForSpawnedTasksResult = vi.fn(() => ({
      wait_complete: true,
      summary: "所有已派发子任务均已完成。请基于结构化结果做最终整合。",
      pending_count: 0,
      completed_count: 1,
      failed_count: 1,
      buffered_terminal_count: 2,
      aggregation_ready: true,
      tasks: [
        {
          task_id: "run-ok",
          subtask_id: "run-ok",
          target_actor_id: "executor",
          target_actor_name: "Executor",
          task: "实现修复",
          mode: "run",
          profile: "executor",
          status: "completed",
          terminal_result: "已完成修复并补充验证。",
          started_at: 1,
          completed_at: 2,
          event_count: 3,
        },
        {
          task_id: "run-failed",
          subtask_id: "run-failed",
          target_actor_id: "validator",
          target_actor_name: "Validator",
          task: "执行回归验证",
          mode: "run",
          profile: "validator",
          status: "error",
          terminal_error: "测试未通过",
          started_at: 3,
          completed_at: 4,
          event_count: 2,
        },
      ],
    }));

    const system = {
      get: (id: string) => ({
        id,
        role: { name: id === "coordinator" ? "Coordinator" : id },
        status: "running",
        currentTask: { id: "task-wait-1" },
      }),
      getAll: () => [],
      buildWaitForSpawnedTasksResult,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const waitTool = tools.find((tool) => tool.name === "wait_for_spawned_tasks");

    expect(waitTool).toBeTruthy();
    if (!waitTool) return;

    const result = await waitTool.execute({});

    expect(buildWaitForSpawnedTasksResult).toHaveBeenCalledWith("coordinator", {
      ownerTaskId: "task-wait-1",
    });
    expect(result).toEqual(expect.objectContaining({
      wait_complete: true,
      pending_count: 0,
      completed_count: 1,
      failed_count: 1,
      buffered_terminal_count: 2,
      aggregation_ready: true,
      tasks: expect.arrayContaining([
        expect.objectContaining({
          task_id: "run-ok",
          profile: "executor",
          terminal_result: "已完成修复并补充验证。",
        }),
        expect.objectContaining({
          task_id: "run-failed",
          profile: "validator",
          terminal_error: "测试未通过",
        }),
      ]),
    }));
  });

  it("waits for runtime task updates instead of sleeping blindly", async () => {
    const buildWaitForSpawnedTasksResult = vi.fn()
      .mockReturnValueOnce({
        wait_complete: false,
        summary: "仍有 1 个子任务运行中，继续等待其结构化结果。",
        pending_count: 1,
        completed_count: 0,
        failed_count: 0,
        buffered_terminal_count: 0,
        aggregation_ready: false,
        tasks: [],
      })
      .mockReturnValueOnce({
        wait_complete: true,
        summary: "所有已派发子任务均已完成。请基于结构化结果做最终整合。",
        pending_count: 0,
        completed_count: 1,
        failed_count: 0,
        buffered_terminal_count: 1,
        aggregation_ready: true,
        tasks: [
          {
            task_id: "run-finished",
            subtask_id: "run-finished",
            target_actor_id: "executor",
            target_actor_name: "Executor",
            task: "实现修复",
            mode: "run",
            profile: "executor",
            status: "completed",
            terminal_result: "done",
            started_at: 1,
            completed_at: 2,
            event_count: 2,
          },
        ],
      });
    const waitForSpawnedTaskUpdate = vi.fn(async () => ({ reason: "task_update" as const }));

    const system = {
      get: (id: string) => ({
        id,
        role: { name: "Coordinator" },
        status: "running",
        currentTask: { id: "task-wait-2" },
      }),
      getAll: () => [],
      buildWaitForSpawnedTasksResult,
      waitForSpawnedTaskUpdate,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const waitTool = tools.find((tool) => tool.name === "wait_for_spawned_tasks");

    expect(waitTool).toBeTruthy();
    if (!waitTool) return;

    const result = await waitTool.execute({});

    expect(waitForSpawnedTaskUpdate).toHaveBeenCalledWith("coordinator", 30_000);
    expect(buildWaitForSpawnedTasksResult).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      wait_complete: true,
      completed_count: 1,
    }));
  });

  it("returns the latest pending snapshot after one runtime wake instead of blocking indefinitely", async () => {
    const buildWaitForSpawnedTasksResult = vi.fn()
      .mockReturnValueOnce({
        wait_complete: false,
        summary: "仍有 1 个子任务运行中，继续等待其结构化结果。",
        pending_count: 1,
        completed_count: 0,
        failed_count: 0,
        buffered_terminal_count: 0,
        aggregation_ready: false,
        tasks: [],
      })
      .mockReturnValueOnce({
        wait_complete: false,
        summary: "仍有 1 个子任务运行中，已收到最新进度。",
        pending_count: 1,
        completed_count: 1,
        failed_count: 0,
        buffered_terminal_count: 1,
        aggregation_ready: false,
        tasks: [
          {
            task_id: "run-still-running",
            subtask_id: "run-still-running",
            target_actor_id: "executor",
            target_actor_name: "Executor",
            task: "实现修复",
            mode: "run",
            profile: "executor",
            status: "running",
            progress_summary: "已完成主要修改，正在补验证",
            started_at: 1,
            event_count: 4,
          },
        ],
      });
    const waitForSpawnedTaskUpdate = vi.fn(async () => ({ reason: "task_update" as const }));

    const system = {
      get: (id: string) => ({ id, role: { name: "Coordinator" }, status: "running" }),
      getAll: () => [],
      buildWaitForSpawnedTasksResult,
      waitForSpawnedTaskUpdate,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const waitTool = tools.find((tool) => tool.name === "wait_for_spawned_tasks");

    expect(waitTool).toBeTruthy();
    if (!waitTool) return;

    const result = await waitTool.execute({});

    expect(waitForSpawnedTaskUpdate).toHaveBeenCalledWith("coordinator", 30_000);
    expect(buildWaitForSpawnedTasksResult).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      wait_complete: false,
      pending_count: 1,
      completed_count: 1,
      buffered_terminal_count: 1,
      aggregation_ready: false,
    }));
  });

  it("continues waiting when there are queued child tasks even if no worker is currently running", async () => {
    const buildWaitForSpawnedTasksResult = vi.fn()
      .mockReturnValueOnce({
        wait_complete: false,
        summary: "当前有 1 个子任务排队待派发，系统会在空位出现后自动补派。",
        pending_count: 0,
        completed_count: 0,
        failed_count: 0,
        buffered_terminal_count: 0,
        aggregation_ready: false,
        pending_dispatch_count: 1,
        tasks: [],
      })
      .mockReturnValueOnce({
        wait_complete: true,
        summary: "所有已派发子任务均已完成。请基于结构化结果做最终整合。",
        pending_count: 0,
        completed_count: 1,
        failed_count: 0,
        buffered_terminal_count: 1,
        aggregation_ready: true,
        pending_dispatch_count: 0,
        tasks: [
          {
            task_id: "run-queued-finished",
            subtask_id: "run-queued-finished",
            target_actor_id: "executor",
            target_actor_name: "Executor",
            task: "实现修复",
            mode: "run",
            profile: "executor",
            status: "completed",
            terminal_result: "done",
            started_at: 1,
            completed_at: 2,
            event_count: 2,
          },
        ],
      });
    const waitForSpawnedTaskUpdate = vi.fn(async () => ({ reason: "task_update" as const }));

    const system = {
      get: (id: string) => ({ id, role: { name: "Coordinator" }, status: "running" }),
      getAll: () => [],
      buildWaitForSpawnedTasksResult,
      waitForSpawnedTaskUpdate,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const waitTool = tools.find((tool) => tool.name === "wait_for_spawned_tasks");

    expect(waitTool).toBeTruthy();
    if (!waitTool) return;

    const result = await waitTool.execute({});

    expect(waitForSpawnedTaskUpdate).toHaveBeenCalledWith("coordinator", 30_000);
    expect(buildWaitForSpawnedTasksResult).toHaveBeenCalledTimes(2);
    expect(result).toEqual(expect.objectContaining({
      wait_complete: true,
      completed_count: 1,
      aggregation_ready: true,
    }));
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

  it("creates a named team through create_team", async () => {
    const createTeam = vi.fn(() => ({
      created: true,
      updated: false,
      team: {
        id: "team-delivery",
        name: "Delivery Team",
        defaultBackendId: "in_process",
        teammates: [
          { id: "mate-specialist", name: "Specialist", actorId: "specialist", backendId: "in_process" },
          { id: "mate-reviewer", name: "Reviewer", actorId: "reviewer", backendId: "in_process" },
        ],
      },
    }));

    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getCoordinatorId: () => "coordinator",
      createTeam,
      getBackendRegistry: () => ({
        list: () => [
          { id: "in_process", kind: "in_process", label: "In-Process Actor Runtime", available: true },
          { id: "worktree", kind: "worktree", label: "Worktree Backend", available: false },
        ],
      }),
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const createTeamTool = tools.find((tool) => tool.name === "create_team");

    expect(createTeamTool).toBeTruthy();
    if (!createTeamTool) return;

    const result = await createTeamTool.execute({
      team_name: "Delivery Team",
      teammates: "Specialist\nReviewer",
      backend: "in_process",
      description: "负责交付和复核",
    });

    expect(createTeam).toHaveBeenCalledWith({
      name: "Delivery Team",
      description: "负责交付和复核",
      defaultBackendId: "in_process",
      createdByActorId: "coordinator",
      teammates: ["Specialist", "Reviewer"],
    });
    expect(result).toEqual(expect.objectContaining({
      created: true,
      team_id: "team-delivery",
      teammate_count: 2,
    }));
  });

  it("routes team messages through send_team_message and broadcast_team_message", async () => {
    const sendTeamMessage = vi.fn(async () => ({
      sent: true,
      teamId: "team-delivery",
      teamName: "Delivery Team",
      backendId: "in_process",
      targetId: "specialist",
      targetName: "Specialist",
      messageId: "msg-team-1",
    }));
    const broadcastTeamMessage = vi.fn(async () => ({
      sent: true,
      teamId: "team-delivery",
      teamName: "Delivery Team",
      total: 2,
      sentCount: 2,
      failedCount: 0,
      results: [],
    }));

    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getCoordinatorId: () => "coordinator",
      sendTeamMessage,
      broadcastTeamMessage,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const sendTeamTool = tools.find((tool) => tool.name === "send_team_message");
    const broadcastTeamTool = tools.find((tool) => tool.name === "broadcast_team_message");

    expect(sendTeamTool).toBeTruthy();
    expect(broadcastTeamTool).toBeTruthy();
    if (!sendTeamTool || !broadcastTeamTool) return;

    const sendResult = await sendTeamTool.execute({
      team_name: "Delivery Team",
      teammate: "Specialist",
      content: "请先补齐交付说明",
      reply_to: "msg-prev-1",
    });
    const broadcastResult = await broadcastTeamTool.execute({
      team_name: "Delivery Team",
      content: "同步一下当前 blocker",
    });

    expect(sendTeamMessage).toHaveBeenCalledWith({
      senderActorId: "coordinator",
      team: "Delivery Team",
      teammate: "Specialist",
      content: "请先补齐交付说明",
      replyTo: "msg-prev-1",
    });
    expect(broadcastTeamMessage).toHaveBeenCalledWith({
      senderActorId: "coordinator",
      team: "Delivery Team",
      content: "同步一下当前 blocker",
      replyTo: undefined,
    });
    expect(sendResult).toEqual(expect.objectContaining({
      sent: true,
      messageId: "msg-team-1",
    }));
    expect(broadcastResult).toEqual(expect.objectContaining({
      sent: true,
      sentCount: 2,
    }));
  });

  it("dispatches team tasks with builtin teammate defaults", async () => {
    const dispatchTeamTask = vi.fn(async () => ({
      dispatched: true,
      teamId: "team-delivery",
      teamName: "Delivery Team",
      backendId: "in_process",
      runId: "run-team-1",
      taskId: "run-team-1",
    }));

    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getCoordinatorId: () => "coordinator",
      dispatchTeamTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const dispatchTeamTaskTool = tools.find((tool) => tool.name === "dispatch_team_task");

    expect(dispatchTeamTaskTool).toBeTruthy();
    if (!dispatchTeamTaskTool) return;

    const result = await dispatchTeamTaskTool.execute({
      team_name: "Delivery Team",
      teammate: "Verifier",
      task: "独立验证最新改动并给出 PASS/FAIL 结论",
      label: "回归验证",
      builtin_agent: "verification_agent",
      create_if_missing: true,
      agent_workspace: "/tmp/worktree-a",
    });

    expect(dispatchTeamTask).toHaveBeenCalledWith(expect.objectContaining({
      senderActorId: "coordinator",
      team: "Delivery Team",
      teammate: "Verifier",
      task: "独立验证最新改动并给出 PASS/FAIL 结论",
      label: "回归验证",
      createIfMissing: true,
      targetDescription: expect.stringContaining("独立验证实现结果"),
      targetCapabilities: expect.arrayContaining(["testing", "debugging"]),
      targetWorkspace: "/tmp/worktree-a",
      roleBoundary: "validator",
      overrides: expect.objectContaining({
        workerProfileId: "validator_worker",
        maxIterations: 18,
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      dispatched: true,
      runId: "run-team-1",
      builtin_agent: "verification_agent",
    }));
  });

  it("dispatches team tasks with builtin review-agent defaults", async () => {
    const dispatchTeamTask = vi.fn(async () => ({
      dispatched: true,
      teamId: "team-review",
      teamName: "Review Team",
      backendId: "in_process",
      runId: "run-team-review-1",
      taskId: "run-team-review-1",
    }));

    const system = {
      get: (id: string) => ({ id, role: { name: id === "coordinator" ? "Coordinator" : id } }),
      getAll: () => [],
      getCoordinatorId: () => "coordinator",
      dispatchTeamTask,
    } as any;

    const tools = createActorCommunicationTools("coordinator", system);
    const dispatchTeamTaskTool = tools.find((tool) => tool.name === "dispatch_team_task");

    expect(dispatchTeamTaskTool).toBeTruthy();
    if (!dispatchTeamTaskTool) return;

    const result = await dispatchTeamTaskTool.execute({
      team_name: "Review Team",
      teammate: "Reviewer",
      task: "独立审查本轮改动的设计风险与潜在回归点",
      label: "风险审查",
      builtin_agent: "review_agent",
      create_if_missing: true,
    });

    expect(dispatchTeamTask).toHaveBeenCalledWith(expect.objectContaining({
      senderActorId: "coordinator",
      team: "Review Team",
      teammate: "Reviewer",
      task: "独立审查本轮改动的设计风险与潜在回归点",
      label: "风险审查",
      createIfMissing: true,
      targetDescription: expect.stringContaining("独立审查实现"),
      targetCapabilities: expect.arrayContaining(["code_review", "code_analysis"]),
      roleBoundary: "reviewer",
      overrides: expect.objectContaining({
        workerProfileId: "review_worker",
        maxIterations: 18,
        thinkingLevel: "medium",
        systemPromptAppend: expect.stringContaining("built-in review agent"),
      }),
    }));
    expect(result).toEqual(expect.objectContaining({
      dispatched: true,
      runId: "run-team-review-1",
      builtin_agent: "review_agent",
    }));
  });
});
