import { describe, expect, it } from "vitest";

import {
  getAccessModeLabel,
  getApprovalModeLabel,
  buildMiddlewareOverridesForExecutionPolicy,
  compactMiddlewareOverridesForPersistence,
  deriveIMConversationExecutionPolicy,
  getDefaultDialogActorPolicyProfile,
  getRoleBoundaryPolicyProfile,
  normalizeExecutionPolicy,
  resolveExecutionPolicyInheritance,
  summarizeExecutionPolicy,
  synchronizeExecutionPolicyCompat,
} from "./execution-policy";

describe("execution-policy", () => {
  it("exposes stable role-boundary policy profiles", () => {
    const reviewer = getRoleBoundaryPolicyProfile("reviewer");
    const validator = getRoleBoundaryPolicyProfile("validator");
    const executor = getRoleBoundaryPolicyProfile("executor");

    expect(reviewer.executionPolicy).toEqual({
      accessMode: "read_only",
      approvalMode: "strict",
    });
    expect(reviewer.toolPolicy?.allow).toEqual(expect.arrayContaining([
      "task_done",
      "list_*",
      "read_*",
      "search_*",
    ]));
    expect(reviewer.toolPolicy?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "delegate_subtask",
      "enter_plan_mode",
      "exit_plan_mode",
      "write_file",
      "run_shell_command",
    ]));

    expect(validator.executionPolicy).toEqual({
      accessMode: "auto",
      approvalMode: "normal",
    });
    expect(validator.toolPolicy?.allow).toEqual(expect.arrayContaining([
      "task_done",
      "run_shell_command",
      "persistent_shell",
    ]));
    expect(validator.toolPolicy?.deny).not.toContain("run_shell_command");

    expect(executor.executionPolicy).toEqual({
      accessMode: "full_access",
      approvalMode: "permissive",
    });
    expect(executor.toolPolicy?.allow).toEqual(expect.arrayContaining([
      "task_done",
      "write_file",
      "str_replace_edit",
      "json_edit",
      "run_shell_command",
    ]));
    expect(executor.toolPolicy?.deny).toEqual(expect.arrayContaining([
      "spawn_task",
      "delegate_subtask",
      "wait_for_spawned_tasks",
      "send_message",
      "agents",
      "ask_user",
      "ask_clarification",
      "enter_plan_mode",
      "exit_plan_mode",
      "delete_file",
    ]));
  });

  it("keeps inheritance restrictive and preserves normalized defaults", () => {
    expect(resolveExecutionPolicyInheritance({
      parentPolicy: {
        accessMode: "auto",
        approvalMode: "permissive",
      },
      boundaryPolicy: getRoleBoundaryPolicyProfile("reviewer").executionPolicy,
      overridePolicy: {
        accessMode: "full_access",
        approvalMode: "off",
      },
    })).toEqual({
      accessMode: "read_only",
      approvalMode: "strict",
    });

    expect(normalizeExecutionPolicy(undefined)).toEqual({
      accessMode: "auto",
      approvalMode: "normal",
    });
  });

  it("derives stable default dialog actor and IM surface policies", () => {
    expect(getDefaultDialogActorPolicyProfile("lead")).toMatchObject({
      executionPolicy: {
        accessMode: "auto",
        approvalMode: "permissive",
      },
      middlewareOverrides: {
        approvalLevel: "permissive",
      },
    });

    expect(getDefaultDialogActorPolicyProfile("external_im")).toMatchObject({
      executionPolicy: {
        accessMode: "read_only",
        approvalMode: "off",
      },
      toolPolicy: {
        deny: expect.arrayContaining(["ask_user", "ask_clarification"]),
      },
      middlewareOverrides: {
        approvalLevel: "off",
        disable: ["Clarification"],
      },
    });

    expect(deriveIMConversationExecutionPolicy({
      accessMode: "full_access",
      approvalMode: "off",
    })).toEqual({
      accessMode: "read_only",
      approvalMode: "normal",
    });

    expect(buildMiddlewareOverridesForExecutionPolicy(
      { accessMode: "auto", approvalMode: "normal" },
      { disable: ["Clarification"] },
    )).toEqual({
      approvalLevel: "normal",
      disable: ["Clarification"],
    });
  });

  it("exposes stable execution policy labels and summaries for UI surfaces", () => {
    expect(getAccessModeLabel("read_only")).toBe("只读");
    expect(getApprovalModeLabel("permissive")).toBe("宽松审核");
    expect(summarizeExecutionPolicy(
      { accessMode: "full_access", approvalMode: "strict" },
    )).toBe("访问 完全访问 · 审批 严格确认");
    expect(summarizeExecutionPolicy(undefined, {
      approvalLevel: "off",
      accessMode: "auto",
    })).toBe("访问 工程内执行 · 审批 关闭审批");
  });

  it("keeps approvalLevel as a runtime mirror and strips it for persistence", () => {
    expect(synchronizeExecutionPolicyCompat({
      middlewareOverrides: {
        approvalLevel: "strict",
        disable: ["Clarification"],
      },
    })).toEqual({
      executionPolicy: {
        accessMode: "auto",
        approvalMode: "strict",
      },
      middlewareOverrides: {
        approvalLevel: "strict",
        disable: ["Clarification"],
      },
    });

    expect(compactMiddlewareOverridesForPersistence({
      approvalLevel: "strict",
      disable: ["Clarification"],
    })).toEqual({
      disable: ["Clarification"],
    });
  });
});
