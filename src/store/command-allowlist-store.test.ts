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
});
