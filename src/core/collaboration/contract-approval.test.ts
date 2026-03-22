import { describe, expect, it } from "vitest";

import { assessExecutionContractApproval } from "./contract-approval";
import type { ExecutionContractDraft } from "./types";

const BASE_DRAFT: ExecutionContractDraft = {
  draftId: "draft-1",
  surface: "local_dialog",
  executionStrategy: "coordinator",
  executionPolicy: {
    accessMode: "auto",
    approvalMode: "normal",
  },
  summary: "继续实现首页并根据需要拆分子任务",
  createdAt: 1,
  coordinatorActorId: "lead",
  input: {
    content: "继续实现首页",
  },
  actorRoster: [
    {
      actorId: "lead",
      roleName: "Lead",
      executionPolicy: {
        accessMode: "auto",
        approvalMode: "permissive",
      },
    },
    {
      actorId: "reviewer",
      roleName: "Reviewer",
      executionPolicy: {
        accessMode: "read_only",
        approvalMode: "strict",
      },
    },
  ],
  inputHash: "input-hash",
  actorRosterHash: "roster-hash",
  initialRecipientActorIds: ["lead"],
  participantActorIds: ["lead", "reviewer"],
  allowedMessagePairs: [{ fromActorId: "lead", toActorId: "reviewer" }],
  allowedSpawnPairs: [{ fromActorId: "lead", toActorId: "reviewer" }],
  plannedDelegations: [],
};

describe("assessExecutionContractApproval", () => {
  it("auto-approves a compact low-risk contract", () => {
    const assessment = assessExecutionContractApproval(
      {
        ...BASE_DRAFT,
        plannedDelegations: [
          {
            id: "delegation-1",
            targetActorId: "reviewer",
            task: "做实现评审",
            label: "Review",
            roleBoundary: "reviewer",
          },
        ],
      },
      [
        {
          id: "lead",
          roleName: "Lead",
          executionPolicy: {
            accessMode: "auto",
            approvalMode: "permissive",
          },
        },
        {
          id: "reviewer",
          roleName: "Reviewer",
          executionPolicy: {
            accessMode: "read_only",
            approvalMode: "strict",
          },
        },
      ],
    );

    expect(assessment.decision).toBe("allow");
    expect(assessment.layer).toBe("auto_review");
    expect(assessment.risk).toBe("low");
  });

  it("escalates broader full-access contracts to human review", () => {
    const assessment = assessExecutionContractApproval(
      {
        ...BASE_DRAFT,
        executionStrategy: "broadcast",
        participantActorIds: ["lead", "reviewer", "fixer", "validator"],
        plannedDelegations: [
          {
            id: "delegation-1",
            targetActorId: "fixer",
            task: "直接修复问题",
            label: "Fix",
            roleBoundary: "executor",
            createIfMissing: true,
          },
        ],
      },
      [
        {
          id: "lead",
          roleName: "Lead",
          executionPolicy: {
            accessMode: "auto",
            approvalMode: "normal",
          },
        },
      ],
    );

    expect(assessment.decision).toBe("ask");
    expect(assessment.layer).toBe("human");
    expect(assessment.risk).toBe("high");
    expect(assessment.reason).toContain("广播");
  });

  it("rejects structurally invalid static delegations", () => {
    const assessment = assessExecutionContractApproval(
      {
        ...BASE_DRAFT,
        plannedDelegations: [
          {
            id: "delegation-1",
            targetActorId: "missing-reviewer",
            task: "做评审",
            label: "Review",
            roleBoundary: "reviewer",
          },
        ],
      },
      [
        {
          id: "lead",
          roleName: "Lead",
          executionPolicy: {
            accessMode: "auto",
            approvalMode: "normal",
          },
        },
      ],
    );

    expect(assessment.decision).toBe("deny");
    expect(assessment.layer).toBe("policy");
    expect(assessment.risk).toBe("high");
  });

  it("respects strict manual trust mode", () => {
    const assessment = assessExecutionContractApproval(
      {
        ...BASE_DRAFT,
        plannedDelegations: [
          {
            id: "delegation-1",
            targetActorId: "reviewer",
            task: "做实现评审",
            label: "Review",
            roleBoundary: "reviewer",
          },
        ],
      },
      [
        {
          id: "lead",
          roleName: "Lead",
          executionPolicy: {
            accessMode: "auto",
            approvalMode: "normal",
          },
        },
        {
          id: "reviewer",
          roleName: "Reviewer",
          executionPolicy: {
            accessMode: "read_only",
            approvalMode: "strict",
          },
        },
      ],
      { trustMode: "strict_manual" },
    );

    expect(assessment.decision).toBe("ask");
    expect(assessment.layer).toBe("human");
    expect(assessment.risk).toBe("low");
  });
});
