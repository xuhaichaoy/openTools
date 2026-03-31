import { afterEach, describe, expect, it, vi } from "vitest";
import type { DialogDispatchPlanBundle } from "@/core/agent/actor/dialog-dispatch-plan";
import type { CollaborationActorRosterEntry } from "./types";
import {
  buildActorRosterHash,
  buildExecutionContractDraftFromDialogBundle,
  buildInputHash,
  doesExecutionContractMatchActorRoster,
  resolveChildExecutionSettings,
  sealExecutionContract,
} from "./execution-contract";

const ACTOR_ROSTER: CollaborationActorRosterEntry[] = [
  { actorId: "coordinator", roleName: "Coordinator", capabilities: ["coordinator", "code_analysis"] },
  { actorId: "reviewer", roleName: "Reviewer", capabilities: ["code_review", "security"] },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("execution-contract", () => {
  it("builds stable roster/input hashes and seals a contract from dialog bundle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T08:00:00.000Z"));

    const bundle = {
      clusterPlan: {
        id: "cluster-plan-1",
        mode: "multi_role",
        steps: [],
        sharedContext: {},
      },
      runtimePlan: {
        id: "dialog-plan-1",
        routingMode: "coordinator",
        summary: "Coordinator 主接手编码任务，并按需委派",
        approvedAt: Date.now(),
        initialRecipientActorIds: ["coordinator"],
        participantActorIds: ["coordinator", "reviewer"],
        coordinatorActorId: "coordinator",
        allowedMessagePairs: [
          { fromActorId: "coordinator", toActorId: "reviewer" },
          { fromActorId: "reviewer", toActorId: "coordinator" },
        ],
        allowedSpawnPairs: [{ fromActorId: "coordinator", toActorId: "reviewer" }],
        plannedSpawns: [{
          id: "spawn-reviewer",
          targetActorId: "reviewer",
          targetActorName: "Reviewer",
          task: "审查实现并指出风险",
          roleBoundary: "reviewer",
        }],
        state: "armed",
      },
      insight: {
        codingProfile: {} as never,
        autoModeLabel: "Coding · 大项目",
        preferredCapabilities: ["coordinator"],
        focus: "review",
        focusLabel: "评审优先",
        reasons: [],
        taskSummary: "请 review 本次改动",
      },
    } satisfies DialogDispatchPlanBundle;

    const draft = buildExecutionContractDraftFromDialogBundle({
      surface: "local_dialog",
      bundle,
      input: {
        content: "请 review 本次改动，重点看边界条件",
        attachmentPaths: ["/repo/src/feature.ts"],
      },
      actorRoster: ACTOR_ROSTER,
    });
    const contract = sealExecutionContract(draft, { contractId: "contract-1", approvedAt: Date.now() });

    expect(buildActorRosterHash([...ACTOR_ROSTER].reverse())).toBe(buildActorRosterHash(ACTOR_ROSTER));
    expect(buildInputHash({
      content: "请 review 本次改动，重点看边界条件",
      attachmentPaths: ["/repo/src/feature.ts"],
    })).toBe(draft.inputHash);
    expect(contract).toMatchObject({
      contractId: "contract-1",
      surface: "local_dialog",
      executionStrategy: "coordinator",
      state: "sealed",
      actorRosterHash: draft.actorRosterHash,
      inputHash: draft.inputHash,
    });
    expect(contract.plannedDelegations[0]).toMatchObject({
      targetActorId: "reviewer",
      roleBoundary: "reviewer",
    });
    expect(draft.structuredDeliveryManifest).toMatchObject({
      source: "heuristic",
      deliveryContract: "general",
      parentContract: "general",
    });
    expect(contract.structuredDeliveryManifest).toEqual(draft.structuredDeliveryManifest);
    expect(doesExecutionContractMatchActorRoster(contract, ACTOR_ROSTER)).toBe(true);
    expect(doesExecutionContractMatchActorRoster(contract, [
      ...ACTOR_ROSTER,
      { actorId: "validator", roleName: "Validator", capabilities: ["testing"] },
    ])).toBe(false);
  });

  it("resolves child execution inheritance without widening approval or tool access", () => {
    const resolved = resolveChildExecutionSettings({
      roleBoundary: "reviewer",
      parentToolPolicy: { deny: ["web_search"] },
      parentWorkspace: "/repo",
      parentThinkingLevel: "high",
      parentMiddlewareOverrides: {
        disable: ["Telemetry"],
        approvalLevel: "permissive",
      },
      boundaryToolPolicy: { deny: ["write_file", "run_shell_command"] },
      boundaryExecutionPolicy: {
        accessMode: "read_only",
        approvalMode: "strict",
      },
      overrideToolPolicy: { deny: ["database_execute"] },
      overrideWorkspace: "/repo/packages/app",
      overrideThinkingLevel: "medium",
      overrideMiddlewareOverrides: {
        disable: ["PromptBuild"],
        approvalLevel: "off",
      },
    });

    expect(resolved.toolPolicy).toEqual({
      deny: [
        "write_file",
        "str_replace_edit",
        "json_edit",
        "delete_file",
        "run_shell_command",
        "persistent_shell",
        "native_*",
        "database_execute",
        "ssh_*",
        "web_search",
      ],
    });
    expect(resolved.executionPolicy).toEqual({
      accessMode: "read_only",
      approvalMode: "strict",
    });
    expect(resolved.workspace).toBe("/repo/packages/app");
    expect(resolved.thinkingLevel).toBe("medium");
    expect(resolved.approvalMode).toBe("strict");
    expect(resolved.middlewareOverrides).toEqual({
      disable: ["Telemetry", "PromptBuild"],
      approvalLevel: "strict",
    });
  });

  it("deep-clones structured delivery prompt and dispatch specs", () => {
    const draft = {
      draftId: "draft-structured-1",
      surface: "local_dialog",
      executionStrategy: "coordinator",
      summary: "structured delivery draft",
      createdAt: 1,
      input: { content: "请按结构化目标执行" },
      actorRoster: ACTOR_ROSTER,
      inputHash: "input-hash",
      actorRosterHash: "roster-hash",
      initialRecipientActorIds: ["coordinator"],
      participantActorIds: ["coordinator"],
      allowedMessagePairs: [],
      allowedSpawnPairs: [],
      plannedDelegations: [],
      structuredDeliveryManifest: {
        source: "planner",
        adapterEnabled: true,
        strategyId: "generic_structured_rows",
        deliveryContract: "structured_content",
        parentContract: "structured_content",
        requiresSpreadsheetOutput: false,
        applyInitialIsolation: true,
        targets: [
          {
            id: "target-a",
            label: "主题 A",
            promptSpec: {
              objective: "围绕主题 A 生成结构化内容",
              inputItems: ["输入 1"],
              constraints: ["不要写文件"],
              completionInstructions: ["直接 task_done"],
            },
            dispatchSpec: {
              label: "主题 A 生成",
              roleBoundary: "executor",
              createIfMissing: true,
              overrides: {
                workerProfileId: "spreadsheet_worker",
                executionIntent: "content_executor",
                resultContract: "inline_structured_result",
              },
            },
          },
        ],
      },
    } as const;

    const contract = sealExecutionContract(draft, { contractId: "contract-structured-1", approvedAt: 2 });
    draft.structuredDeliveryManifest?.targets?.[0]?.promptSpec?.inputItems?.push("输入 2");
    if (draft.structuredDeliveryManifest?.targets?.[0]?.dispatchSpec?.overrides) {
      draft.structuredDeliveryManifest.targets[0].dispatchSpec.overrides.workerProfileId = "coding_worker";
      draft.structuredDeliveryManifest.targets[0].dispatchSpec.overrides.executionIntent = "coding_executor";
    }

    expect(contract.structuredDeliveryManifest?.targets?.[0]?.promptSpec?.inputItems).toEqual(["输入 1"]);
    expect(contract.structuredDeliveryManifest?.targets?.[0]?.dispatchSpec?.overrides?.workerProfileId).toBe("spreadsheet_worker");
    expect(contract.structuredDeliveryManifest?.targets?.[0]?.dispatchSpec?.overrides?.executionIntent).toBe("content_executor");
  });
});
