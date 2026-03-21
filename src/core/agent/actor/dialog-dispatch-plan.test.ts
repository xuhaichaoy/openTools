import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildDialogDispatchPlanBundle,
  inferDialogDispatchInsight,
  type DialogPlanningActor,
} from "./dialog-dispatch-plan";

const ACTORS: DialogPlanningActor[] = [
  {
    id: "coordinator",
    roleName: "Coordinator",
    capabilities: { tags: ["coordinator", "synthesis", "code_analysis"] },
  },
  {
    id: "fixer",
    roleName: "Fixer",
    capabilities: { tags: ["code_write", "debugging", "code_analysis"] },
  },
  {
    id: "reviewer",
    roleName: "Reviewer",
    capabilities: { tags: ["code_review", "code_analysis", "security"] },
  },
  {
    id: "tester",
    roleName: "Tester",
    capabilities: { tags: ["testing", "debugging"] },
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("dialog-dispatch-plan", () => {
  it("infers coding insight and preferred capabilities from coding task context", () => {
    const insight = inferDialogDispatchInsight({
      content: "请排查整个项目里的 TypeScript 报错并修复，最后补上验证步骤",
      attachmentSummary: "已附带 src/app.ts 与 tests/app.test.ts",
      attachmentPaths: [
        "/repo/src/app.ts",
        "/repo/src/lib/util.ts",
        "/repo/tests/app.test.ts",
        "/repo/package.json",
      ],
      handoff: {
        intent: "coding",
      },
    });

    expect(insight.codingProfile.profile.codingMode).toBe(true);
    expect(insight.codingProfile.profile.largeProjectMode).toBe(true);
    expect(insight.autoModeLabel).toBe("Coding · 大项目");
    expect(insight.focus).toBe("debugging");
    expect(insight.preferredCapabilities.slice(0, 3)).toEqual(["coordinator", "debugging", "code_analysis"]);
    expect(insight.reasons).toContain("handoff 已标记为编码任务");
  });

  it("builds a coordinator-oriented coding plan with explicit implementation and validation roles", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T09:00:00.000Z"));

    const plan = buildDialogDispatchPlanBundle({
      actors: ACTORS,
      routingMode: "coordinator",
      content: "请排查整个项目里的 TypeScript 报错并修复，最后补上验证步骤",
      attachmentSummary: "已附带 src/app.ts 与 tests/app.test.ts",
      attachmentPaths: [
        "/repo/src/app.ts",
        "/repo/src/lib/util.ts",
        "/repo/tests/app.test.ts",
        "/repo/package.json",
      ],
      coordinatorActorId: "coordinator",
    });

    expect(plan).not.toBeNull();
    expect(plan?.runtimePlan.initialRecipientActorIds).toEqual(["coordinator"]);
    expect(plan?.runtimePlan.summary).toContain("Coordinator 主接手编码任务");
    expect(plan?.clusterPlan.sharedContext).toMatchObject({
      taskType: "coding",
      codingFocus: "debugging",
      codingModeLabel: "Coding · 大项目",
    });
    expect(plan?.clusterPlan.steps[0].task).toContain("作为主代理先拆解大型编码任务");
    expect(plan?.clusterPlan.steps.find((step) => step.role === "Fixer")?.task).toContain("定位异常链路");
    expect(plan?.clusterPlan.steps.find((step) => step.role === "Reviewer")?.task).toContain("独立审查者");
    expect(plan?.clusterPlan.steps.find((step) => step.role === "Tester")?.task).toContain("设计并执行验证步骤");
    expect(plan?.runtimePlan.plannedSpawns?.map((spawn) => spawn.targetActorId)).toEqual(["fixer", "tester", "reviewer"]);
    expect(plan?.runtimePlan.plannedSpawns?.map((spawn) => spawn.roleBoundary)).toEqual([
      "executor",
      "validator",
      "reviewer",
    ]);
  });

  it("uses selected smart route for coding review tasks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00.000Z"));

    const plan = buildDialogDispatchPlanBundle({
      actors: ACTORS,
      routingMode: "smart",
      content: "帮我 review 这次改动，重点看边界条件和回归风险",
      attachmentPaths: ["/repo/src/feature.ts", "/repo/src/feature.test.ts"],
      selectedRoute: {
        agentId: "reviewer",
        reason: "命中代码审查能力",
      },
      coordinatorActorId: "coordinator",
    });

    expect(plan).not.toBeNull();
    expect(plan?.insight.focus).toBe("review");
    expect(plan?.runtimePlan.initialRecipientActorIds).toEqual(["reviewer"]);
    expect(plan?.runtimePlan.summary).toContain("Reviewer 主接手编码任务");
    expect(plan?.clusterPlan.steps[0].task).toContain("路由理由：命中代码审查能力");
    expect(plan?.runtimePlan.plannedSpawns?.map((spawn) => spawn.targetActorId)).toEqual(["fixer", "tester", "coordinator"]);
    expect(plan?.runtimePlan.plannedSpawns?.map((spawn) => spawn.roleBoundary)).toEqual([
      "executor",
      "validator",
      "general",
    ]);
  });

  it("keeps simple implementation work in solo lead flow and suggests ephemeral children for larger debugging tasks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T11:00:00.000Z"));

    const soloActors: DialogPlanningActor[] = [
      {
        id: "lead",
        roleName: "Lead",
        capabilities: { tags: ["coordinator", "code_write", "code_analysis", "debugging", "testing"] },
      },
    ];

    const soloPlan = buildDialogDispatchPlanBundle({
      actors: soloActors,
      routingMode: "coordinator",
      content: "请修一下 src/button.tsx 里按钮 hover 颜色不对的问题",
      attachmentPaths: ["/repo/src/button.tsx"],
      coordinatorActorId: "lead",
    });

    expect(soloPlan).not.toBeNull();
    expect(soloPlan?.runtimePlan.summary).toContain("单主代理方式推进编码任务");
    expect(soloPlan?.runtimePlan.plannedSpawns).toBeUndefined();

    const delegatedPlan = buildDialogDispatchPlanBundle({
      actors: soloActors,
      routingMode: "coordinator",
      content: "请排查整个项目里的 TypeScript 报错并修复，最后补上验证步骤",
      attachmentSummary: "已附带 src/app.ts 与 tests/app.test.ts",
      attachmentPaths: [
        "/repo/src/app.ts",
        "/repo/src/lib/util.ts",
        "/repo/tests/app.test.ts",
        "/repo/package.json",
      ],
      coordinatorActorId: "lead",
    });

    expect(delegatedPlan).not.toBeNull();
    expect(delegatedPlan?.runtimePlan.summary).toContain("并按需委派");
    expect(delegatedPlan?.runtimePlan.plannedSpawns?.map((spawn) => spawn.targetActorName)).toEqual([
      "Debugger",
      "Implementer",
    ]);
    expect(delegatedPlan?.runtimePlan.plannedSpawns?.every((spawn) => spawn.createIfMissing)).toBe(true);
  });
});
