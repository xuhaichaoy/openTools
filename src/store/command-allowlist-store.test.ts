import { beforeEach, describe, expect, it } from "vitest";

import { useToolTrustStore } from "./command-allowlist-store";

describe("command-allowlist-store", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
    useToolTrustStore.getState().setTrustLevel("auto_approve_file");
    useToolTrustStore.getState().clearDecisionCache();
  });

  it("prefers executionPolicy when assessing tool confirmation", () => {
    const assessment = useToolTrustStore.getState().assess(
      "write_file",
      { path: "/tmp/demo.txt" },
      {
        executionPolicy: {
          accessMode: "read_only",
          approvalMode: "off",
        },
      },
    );

    expect(assessment.decision).toBe("deny");
    expect(assessment.layer).toBe("policy");
    expect(assessment.reason).toContain("read_only");
  });

  it("keeps legacy approvalLevel as compatibility fallback", () => {
    const shouldConfirm = useToolTrustStore.getState().shouldConfirm(
      "run_shell_command",
      { command: "git commit -m test" },
      {
        approvalLevel: "strict",
      },
    );

    expect(shouldConfirm).toBe(true);
  });

  it("reuses session shell approval for similar commands in the same directory", () => {
    useToolTrustStore.getState().rememberSessionDecision(
      "run_shell_command",
      {
        command: "find src -type f",
        cwd: "/Users/haichao/Desktop/work/51ToolBox",
      },
      "shell_command_in_cwd",
    );

    const cached = useToolTrustStore.getState().getCachedDecision(
      "run_shell_command",
      {
        command: "find docs -type f",
        cwd: "/Users/haichao/Desktop/work/51ToolBox",
      },
    );

    expect(cached).toBe(true);
  });

  it("reuses session file approval for writes in the same directory", () => {
    useToolTrustStore.getState().rememberSessionDecision(
      "write_file",
      {
        path: "/Users/haichao/Desktop/work/51ToolBox/src/demo.ts",
      },
      "dir",
    );

    const cached = useToolTrustStore.getState().getCachedDecision(
      "write_file",
      {
        path: "/Users/haichao/Desktop/work/51ToolBox/src/other.ts",
      },
    );

    expect(cached).toBe(true);
  });
});
