import { describe, expect, it } from "vitest";

import {
  buildInlineStructuredDispatchPlanFromManifest,
  getStructuredDeliveryStrategies,
  resolveRequestedSpreadsheetExtensions,
  resolveStructuredDeliveryManifest,
  resolveStructuredDeliveryStrategyById,
  resolveStructuredDeliveryStrategy,
  taskLooksLikeStructuredSpreadsheetDelivery,
  taskRequestsSpreadsheetOutput,
} from "./structured-delivery-strategy";

const STRUCTURED_QUERY = [
  "根据课程主题生成课程清单，最终给我一个 Excel 文件。",
  "1. AI应用开发工程化实战",
  "2. 智能体开发与知识库落地",
  "3. 大模型安全治理与测试",
  "4. AI产品需求转化与方案设计",
  "5. AI产品运营增长与商业闭环",
  "6. 银行AI解决方案咨询方法论",
  "7. 数据分析与经营洞察实战",
  "8. 全员AI办公赋能与协同提效",
  "9. AI通识与智能素养提升",
].join("\n");

describe("structured-delivery strategy registry", () => {
  it("registers the deterministic course workbook strategy as an adapter", () => {
    expect(getStructuredDeliveryStrategies().map((strategy) => strategy.id)).toContain("deterministic_course_workbook");
  });

  it("resolves a structured spreadsheet task to a strategy-owned dispatch plan", () => {
    const strategy = resolveStructuredDeliveryStrategy(STRUCTURED_QUERY);
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);

    expect(strategy?.id).toBe("deterministic_course_workbook");
    const plan = strategy?.buildInitialDispatchPlan?.({
      taskText: STRUCTURED_QUERY,
      manifest,
    });
    expect(plan).not.toBeNull();
    expect(plan?.strategyId).toBe("deterministic_course_workbook");
    expect(plan?.shards).toHaveLength(manifest.targets?.length ?? 0);
    expect(plan?.shards.every((shard) => shard.overrides?.resultContract === "inline_structured_result")).toBe(true);
    expect(plan?.shards.every((shard, index) => (
      shard.overrides?.deliveryTargetId === manifest.targets?.[index]?.id
      && shard.overrides?.deliveryTargetLabel === manifest.targets?.[index]?.label
    ))).toBe(true);
  });

  it("does not hijack unrelated coding tasks", () => {
    expect(resolveStructuredDeliveryStrategy("修复 /Users/demo/project/src/App.tsx 里的渲染 bug")).toBeNull();
  });

  it("builds a manifest so agent-actor can avoid local heuristics", () => {
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);

    expect(manifest.strategyId).toBe("deterministic_course_workbook");
    expect(resolveStructuredDeliveryStrategyById(manifest.strategyId)?.id).toBe("deterministic_course_workbook");
    expect(manifest.source).toBe("strategy");
    expect(manifest.deliveryContract).toBe("spreadsheet");
    expect(manifest.parentContract).toBe("single_workbook");
    expect(manifest.requiresSpreadsheetOutput).toBe(true);
    expect(manifest.applyInitialIsolation).toBe(true);
    expect(manifest.targets?.map((target) => target.label)).toEqual([
      "技术方向课程",
      "产品运营方向课程",
      "数据与通识方向课程",
    ]);
    expect(manifest.resultSchema?.fields.map((field) => field.label)).toEqual([
      "课程名称",
      "课程介绍",
    ]);
    expect(manifest.exportSpec).toEqual(expect.objectContaining({
      mode: "single_workbook",
      format: "spreadsheet",
    }));
  });

  it("can build inline structured shards directly from manifest targets", () => {
    const manifest = {
      source: "planner",
      strategyId: "generic_inline_rows",
      deliveryContract: "structured_content",
      parentContract: "structured_content",
      requiresSpreadsheetOutput: false,
      applyInitialIsolation: true,
      resultSchema: {
        id: "generic_rows",
        kind: "table_rows",
        fields: [
          { key: "title", label: "标题", required: true },
          { key: "summary", label: "摘要", required: true },
        ],
      },
      targets: [
        {
          id: "target-a",
          label: "主题 A",
          promptSpec: {
            objective: "围绕主题 A 生成结构化条目。",
            inputItems: ["输入 1", "输入 2"],
          },
          dispatchSpec: {
            label: "主题 A 生成",
            roleBoundary: "executor",
            createIfMissing: true,
            overrides: {
              executionIntent: "content_executor",
              resultContract: "inline_structured_result",
            },
          },
        },
      ],
    } as const;

    const plan = buildInlineStructuredDispatchPlanFromManifest({
      strategyId: "generic_inline_rows",
      manifest,
      defaultRoleBoundary: "executor",
      defaultCreateIfMissing: true,
    });

    expect(plan).not.toBeNull();
    expect(plan?.shards).toHaveLength(1);
    expect(plan?.shards[0]).toMatchObject({
      label: "主题 A 生成",
      roleBoundary: "executor",
      createIfMissing: true,
      overrides: {
        executionIntent: "content_executor",
        resultContract: "inline_structured_result",
        deliveryTargetId: "target-a",
        deliveryTargetLabel: "主题 A",
      },
    });
    expect(plan?.shards[0]?.task).toContain("围绕主题 A 生成结构化条目");
    expect(plan?.shards[0]?.task).toContain("`标题`、`摘要`");
  });

  it("keeps generic spreadsheet detection centralized", () => {
    expect(taskRequestsSpreadsheetOutput("请最终导出一个 Excel 文件")).toBe(true);
    expect(resolveRequestedSpreadsheetExtensions("请最终导出一个 Excel 文件")).toEqual(["xlsx", "xls"]);
    expect(taskLooksLikeStructuredSpreadsheetDelivery("根据附件整理条目并最终给我一个 Excel 文件")).toBe(true);
  });

  it("falls back to heuristic manifests for generic non-coding spreadsheet delivery", () => {
    const manifest = resolveStructuredDeliveryManifest("根据附件整理条目并最终给我一个 Excel 文件");

    expect(manifest.source).toBe("heuristic");
    expect(manifest.strategyId).toBeUndefined();
    expect(manifest.deliveryContract).toBe("spreadsheet");
    expect(manifest.parentContract).toBe("single_workbook");
    expect(manifest.applyInitialIsolation).toBe(true);
  });
});
