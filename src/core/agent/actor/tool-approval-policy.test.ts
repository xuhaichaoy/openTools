import { describe, expect, it } from "vitest";

import {
  assessToolApproval,
  buildToolApprovalCacheKey,
  deriveToolPolicyForAccessMode,
  resolveExecutionPolicyInheritance,
} from "./tool-approval-policy";

describe("tool-approval-policy", () => {
  it("auto-allows read-only shell commands in auto review mode", () => {
    const assessment = assessToolApproval("run_shell_command", {
      command: "cd /repo && find src -type f | sort | sed -n '1,40p'",
    });

    expect(assessment.decision).toBe("allow");
    expect(assessment.risk).toBe("low");
    expect(assessment.layer).toBe("auto_review");
  });

  it("escalates destructive shell commands to human confirmation", () => {
    const assessment = assessToolApproval("run_shell_command", {
      command: "rm -rf ./dist",
    });

    expect(assessment.decision).toBe("ask");
    expect(assessment.risk).toBe("high");
    expect(assessment.layer).toBe("human");
  });

  it("auto-allows workspace file edits in auto review mode", () => {
    const assessment = assessToolApproval("write_file", {
      path: "/Users/haichao/Desktop/work/51ToolBox/src/demo.ts",
      content: "export const demo = true;",
    }, {
      workspace: "/Users/haichao/Desktop/work/51ToolBox",
    });

    expect(assessment.decision).toBe("allow");
    expect(assessment.risk).toBe("low");
  });

  it("keeps sensitive path edits behind manual confirmation", () => {
    const assessment = assessToolApproval("write_file", {
      path: "/Users/haichao/.ssh/config",
      content: "Host *",
    }, {
      workspace: "/Users/haichao/Desktop/work/51ToolBox",
    });

    expect(assessment.decision).toBe("ask");
    expect(assessment.risk).toBe("high");
  });

  it("uses identical cache keys for repeated shell approvals", () => {
    expect(buildToolApprovalCacheKey("run_shell_command", {
      command: "pwd",
      workdir: "/tmp/demo",
    })).toBe(buildToolApprovalCacheKey("run_shell_command", {
      command: "pwd",
      workdir: "/tmp/demo",
    }));
  });

  it("keeps strict mode available for medium-risk validation commands", () => {
    const assessment = assessToolApproval("run_shell_command", {
      command: "npm test -- --runInBand",
    }, {
      approvalLevel: "strict",
    });

    expect(assessment.decision).toBe("ask");
    expect(assessment.risk).toBe("medium");
  });

  it("treats approvalMode as the first-class fallback before legacy approvalLevel", () => {
    const assessment = assessToolApproval("run_shell_command", {
      command: "npm test -- --runInBand",
    }, {
      approvalMode: "strict",
    });

    expect(assessment.decision).toBe("ask");
    expect(assessment.risk).toBe("medium");
  });

  it("denies mutating tools under read-only access mode before human approval", () => {
    const assessment = assessToolApproval("write_file", {
      path: "/Users/haichao/Desktop/work/51ToolBox/src/demo.ts",
      content: "export const demo = true;",
    }, {
      executionPolicy: {
        accessMode: "read_only",
        approvalMode: "off",
      },
      workspace: "/Users/haichao/Desktop/work/51ToolBox",
    });

    expect(assessment.decision).toBe("deny");
    expect(assessment.layer).toBe("policy");
  });

  it("clamps child execution policy so it cannot widen parent permissions", () => {
    expect(resolveExecutionPolicyInheritance({
      parentPolicy: {
        accessMode: "auto",
        approvalMode: "permissive",
      },
      boundaryPolicy: {
        accessMode: "read_only",
        approvalMode: "strict",
      },
      overridePolicy: {
        accessMode: "full_access",
        approvalMode: "off",
      },
    })).toEqual({
      accessMode: "read_only",
      approvalMode: "strict",
    });
    expect(deriveToolPolicyForAccessMode("read_only")).toEqual({
      deny: expect.arrayContaining(["write_file", "run_shell_command"]),
    });
  });
});
