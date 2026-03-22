import { describe, expect, it } from "vitest";

import { assessClusterPlanApproval } from "./plan-approval";
import type { ClusterPlan } from "./types";

const BASE_PLAN: ClusterPlan = {
  id: "plan-1",
  mode: "parallel_split",
  sharedContext: {},
  steps: [
    {
      id: "s1",
      role: "Researcher",
      task: "梳理当前方案差异与风险",
      dependencies: [],
    },
    {
      id: "s2",
      role: "Reviewer",
      task: "审查当前变更并给出建议",
      dependencies: ["s1"],
    },
  ],
};

describe("assessClusterPlanApproval", () => {
  it("auto-approves low-risk analysis plans", () => {
    const assessment = assessClusterPlanApproval(BASE_PLAN);
    expect(assessment.decision).toBe("allow");
    expect(assessment.layer).toBe("auto_review");
    expect(assessment.risk).toBe("low");
  });

  it("escalates high-impact coding plans to human review", () => {
    const assessment = assessClusterPlanApproval({
      ...BASE_PLAN,
      steps: [
        {
          id: "s1",
          role: "Coder",
          task: "实现首页重构并补齐关键逻辑",
          dependencies: [],
        },
        {
          id: "s2",
          role: "Release Engineer",
          task: "部署到 production 并执行数据库 migration",
          dependencies: ["s1"],
        },
      ],
    }, {
      codingMode: true,
      openClawMode: true,
    });

    expect(assessment.decision).toBe("ask");
    expect(assessment.layer).toBe("human");
    expect(assessment.risk).toBe("high");
  });

  it("rejects empty plans", () => {
    const assessment = assessClusterPlanApproval({
      ...BASE_PLAN,
      steps: [],
    });
    expect(assessment.decision).toBe("deny");
    expect(assessment.layer).toBe("policy");
  });

  it("respects strict manual trust mode", () => {
    const assessment = assessClusterPlanApproval(BASE_PLAN, {
      trustMode: "strict_manual",
    });
    expect(assessment.decision).toBe("ask");
    expect(assessment.layer).toBe("human");
  });
});
