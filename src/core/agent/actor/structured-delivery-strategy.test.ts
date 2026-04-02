import { describe, expect, it } from "vitest";

import {
  buildInlineStructuredDispatchPlanFromManifest,
  enableStructuredDeliveryAdapter,
  getStructuredDeliveryStrategies,
  isStructuredDeliveryAdapterEnabled,
  resolveRequestedSpreadsheetExtensions,
  resolveStructuredDeliveryManifest,
  resolveStructuredDeliveryStrategy,
  resolveStructuredDeliveryStrategyById,
  taskLooksLikeStructuredContentTask,
  taskLooksLikeStructuredSpreadsheetDelivery,
  taskRequestsSpreadsheetOutput,
} from "./structured-delivery-strategy";

const STRUCTURED_QUERY = [
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

describe("structured-delivery strategy registry", () => {
  it("registers the dynamic spreadsheet strategy", () => {
    expect(getStructuredDeliveryStrategies().map((strategy) => strategy.id)).toContain("dynamic_spreadsheet");
  });

  it("resolves spreadsheet content delivery to the dynamic strategy", () => {
    const strategy = resolveStructuredDeliveryStrategy(STRUCTURED_QUERY);
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);

    expect(strategy?.id).toBe("dynamic_spreadsheet");
    expect(manifest.strategyId).toBeUndefined();
    expect(manifest.recommendedStrategyId).toBe("dynamic_spreadsheet");
    expect(manifest.source).toBe("strategy");
    expect(manifest.deliveryContract).toBe("spreadsheet");
    expect(manifest.parentContract).toBe("single_workbook");
    expect(manifest.adapterEnabled).toBe(false);
    expect(isStructuredDeliveryAdapterEnabled(manifest)).toBe(false);
    expect(manifest.applyInitialIsolation).toBe(true);
    expect(manifest.resultSchema?.fields.map((field) => field.label)).toEqual(["课程名称", "课程介绍"]);
    expect(manifest.targets?.length).toBeGreaterThan(1);
    expect(new Set(manifest.targets?.map((target) => target.label))).toEqual(new Set(["结果清单"]));
  });

  it("builds inline structured shards from the dynamic manifest", () => {
    const strategy = resolveStructuredDeliveryStrategy(STRUCTURED_QUERY);
    const manifest = resolveStructuredDeliveryManifest(STRUCTURED_QUERY);
    const plan = strategy?.buildInitialDispatchPlan?.({
      taskText: STRUCTURED_QUERY,
      manifest,
    });

    expect(plan).not.toBeNull();
    expect(plan?.strategyId).toBe("dynamic_spreadsheet");
    expect(plan?.shards.length).toBe(manifest.targets?.length ?? 0);
    expect(plan?.shards.every((shard) => shard.overrides?.workerProfileId === "spreadsheet_worker")).toBe(true);
    expect(plan?.shards.every((shard) => shard.overrides?.resultContract === "inline_structured_result")).toBe(true);
    expect(plan?.shards.every((shard) => shard.overrides?.executionIntent === "content_executor")).toBe(true);
    expect(plan?.shards.every((shard) => (shard.overrides?.scopedSourceItems?.length ?? 0) > 0)).toBe(true);
    expect(plan?.shards[0]?.overrides?.scopedSourceItems?.[0]).toEqual(expect.objectContaining({
      id: "source-item-1",
      topicIndex: 1,
      topicTitle: "AI应用开发工程化实战",
    }));
    expect(plan?.shards[0]?.task).toContain("sourceItemId");
    expect(plan?.shards[0]?.task).toContain("coverageType");
  });

  it("keeps generic spreadsheet detection centralized", () => {
    expect(taskRequestsSpreadsheetOutput("请最终导出一个 Excel 文件")).toBe(true);
    expect(resolveRequestedSpreadsheetExtensions("请最终导出一个 Excel 文件")).toEqual(["xlsx", "xls"]);
    expect(taskLooksLikeStructuredContentTask("请根据附件整理条目并输出结构化表格")).toBe(true);
    expect(taskLooksLikeStructuredSpreadsheetDelivery("请根据附件整理条目并最终给我一个 Excel 文件")).toBe(true);
  });

  it("does not hijack unrelated coding tasks", () => {
    expect(resolveStructuredDeliveryStrategy("修复 /Users/demo/project/src/App.tsx 里的渲染 bug")).toBeNull();
  });

  it("treats planner-enabled manifests as engaged adapters", () => {
    const manifest = enableStructuredDeliveryAdapter(resolveStructuredDeliveryManifest(STRUCTURED_QUERY), "planner");

    expect(manifest.source).toBe("planner");
    expect(manifest.adapterEnabled).toBe(true);
    expect(manifest.strategyId).toBe("dynamic_spreadsheet");
    expect(manifest.recommendedStrategyId).toBe("dynamic_spreadsheet");
    expect(isStructuredDeliveryAdapterEnabled(manifest)).toBe(true);
  });

  it("can build inline structured shards directly from manifest targets", () => {
    const manifest = {
      source: "planner",
      adapterEnabled: true,
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
              workerProfileId: "spreadsheet_worker",
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

    expect(plan?.shards[0]).toMatchObject({
      label: "主题 A 生成",
      roleBoundary: "executor",
      createIfMissing: true,
      overrides: {
        workerProfileId: "spreadsheet_worker",
        executionIntent: "content_executor",
        resultContract: "inline_structured_result",
        deliveryTargetId: "target-a",
        deliveryTargetLabel: "主题 A",
      },
    });
  });
});
